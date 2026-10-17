import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LobbyClientError } from '../src/client.js';
import { windowCovers, type ModelWindow } from '../src/protocol.js';
import {
  modelWindows,
  runStatusLine,
  statusText,
  usageReport,
  USAGE_RESEND_MS,
} from '../src/statusline.js';

// What Claude Code passes a status line for a Pro or Max account, abridged.
const input = (fiveHour: number, week: number) =>
  JSON.stringify({
    session_id: 'abc',
    model: { display_name: 'Opus' },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: 1_792_000_000 },
      seven_day: { used_percentage: week, resets_at: 1_792_400_000 },
    },
  });

async function fixture(
  t: TestContext,
  windows: () => Promise<ModelWindow[] | null> = async () => null,
) {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-statusline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-16T18:00:00Z');
  const sent: unknown[] = [];
  let reachable = true;
  let lookups = 0;
  const options = {
    now: () => now,
    statePath: join(directory, 'state.json'),
    account: async () => {
      lookups++;
      return { email: 'Johan@Example.com', plan: 'max' };
    },
    // Never a real Claude Code in tests.
    windows,
    client: {
      request: async (_method: string, _path: string, body?: unknown) => {
        if (!reachable) throw new Error('offline');
        sent.push(body);
        return { recorded: true };
      },
    } as never,
  };
  const run = (stdin: string, dryRun = false) =>
    runStatusLine({ url: 'https://lobby.test', token: 'x' }, '/agent.json', stdin, {
      ...options,
      dryRun,
    });
  return {
    run,
    statePath: options.statePath,
    sent,
    lookups: () => lookups,
    advance: (ms: number) => (now += ms),
    offline: (value: boolean) => (reachable = !value),
  };
}

test('the status line reads Claude Code’s plan usage and the signed-in account', () => {
  const report = usageReport(JSON.parse(input(38.4, 60)), {
    email: 'Johan@Example.com',
    plan: 'max',
  });
  assert.deepEqual(report, {
    five_hour: { used_percentage: 38.4, resets_at: 1_792_000_000 },
    seven_day: { used_percentage: 60, resets_at: 1_792_400_000 },
    account: 'johan@example.com',
    plan: 'max',
  });
  assert.match(statusText(report), /^5h 62% left, resets \d\d:\d\d, week 40% left$/);
  // An API-key session, or one before its first answer, has no rate_limits: nothing to show.
  assert.equal(usageReport({ model: {} }, null), null);
  assert.equal(statusText(null), '');
});

test('the status line sends changed readings, repeats an unchanged one every few minutes, and never fails', async (t) => {
  const f = await fixture(t);
  assert.match(await f.run(input(10, 20)), /^5h 90% left/);
  assert.equal(f.sent.length, 1);
  // The same reading again is not sent until a few minutes have passed.
  f.advance(60_000);
  await f.run(input(10, 20));
  assert.equal(f.sent.length, 1);
  f.advance(USAGE_RESEND_MS);
  await f.run(input(10, 20));
  assert.equal(f.sent.length, 2);
  // A change is sent at once.
  await f.run(input(11, 20));
  assert.equal(f.sent.length, 3);
  // The account is looked up every 5 minutes, not on every run: twice in these six minutes.
  assert.equal(f.lookups(), 2);
  // An unreachable broker leaves the line as it is, and the reading is tried again next time.
  f.offline(true);
  assert.match(await f.run(input(12, 20)), /^5h 88% left/);
  f.offline(false);
  await f.run(input(12, 20));
  assert.equal(f.sent.length, 4);
  // Input that is not Claude Code's shows nothing and sends nothing.
  assert.equal(await f.run('not json'), '');
  assert.equal(await f.run('{}'), '');
  assert.equal(f.sent.length, 4);
});

test('a dry run shows what would be sent, sends nothing and remembers nothing', async (t) => {
  const f = await fixture(t);
  const shown = await f.run(input(38.4, 60), true);
  assert.match(
    shown,
    /^5h 62% left, resets \d\d:\d\d, week 40% left\nDry run, not sent: PUT \/v1\/usage \{/,
  );
  assert.match(shown, /"account":"johan@example.com"/);
  assert.deepEqual(f.sent, []);
  await assert.rejects(readFile(f.statePath, 'utf8'));
  assert.match(await f.run('{}', true), /no rate_limits and no model, so nothing would be sent/);
  // The next real reading is sent as usual.
  await f.run(input(38.4, 60));
  assert.equal(f.sent.length, 1);
});

test('the status line reports the session’s model and effort, and leaves out a value the broker would refuse', () => {
  const session = (model: unknown, effort: unknown) => ({
    ...JSON.parse(input(38.4, 60)),
    model,
    effort,
  });
  assert.deepEqual(
    usageReport(session({ id: 'claude-opus-5-5', display_name: 'Opus' }, { level: 'xhigh' }), null),
    {
      five_hour: { used_percentage: 38.4, resets_at: 1_792_000_000 },
      seven_day: { used_percentage: 60, resets_at: 1_792_400_000 },
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    },
  );
  // An effort it does not know, or a model ID with a space, is dropped; the usage stays.
  const odd = usageReport(session({ id: 'claude opus' }, { level: 'turbo' }), null)!;
  assert.deepEqual(
    [odd.model, odd.effort, odd.seven_day?.used_percentage],
    [undefined, undefined, 60],
  );
  // The context window comes along (0.8.5).
  assert.equal(
    usageReport(
      {
        ...session({ id: 'claude-opus-5-5' }, { level: 'high' }),
        context_window: { context_window_size: 1_000_000 },
      },
      null,
    )!.context,
    1_000_000,
  );
  // A session without plan windows, such as one on an API key, still reports its model.
  assert.deepEqual(usageReport({ model: { id: 'claude-sonnet-5-5' } }, null), {
    model: 'claude-sonnet-5-5',
  });
});

test('a broker before 0.8.4 gets the usage alone, and the whole report again at the next resend', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-statusline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-16T18:00:00Z');
  const sent: Record<string, unknown>[] = [];
  let tries = 0;
  const options = {
    now: () => now,
    statePath: join(directory, 'state.json'),
    account: async () => null,
    windows: async () => null,
    client: {
      request: async (_method: string, _path: string, body?: unknown) => {
        tries++;
        // A 0.8.3 broker's schema refuses the keys it does not know.
        if (body && typeof body === 'object' && 'model' in body)
          throw new LobbyClientError(400, 'invalid_request');
        sent.push(body as Record<string, unknown>);
        return { recorded: true };
      },
    } as never,
  };
  const stdin = JSON.stringify({
    ...JSON.parse(input(10, 20)),
    model: { id: 'claude-opus-5-5' },
    effort: { level: 'high' },
  });
  const run = () =>
    runStatusLine({ url: 'https://lobby.test', token: 'x' }, '/agent.json', stdin, options);
  await run();
  assert.deepEqual(
    [tries, sent.length, 'model' in sent[0]!, Boolean(sent[0]!.seven_day)],
    [2, 1, false, true],
  );
  // The same reading is not sent again before the resend interval.
  await run();
  assert.equal(tries, 2);
  now += USAGE_RESEND_MS;
  await run();
  assert.deepEqual([tries, sent.length], [4, 2]);
});

test('the status line reports a model’s own weekly window, such as Fable’s, from Claude Code’s usage (0.8.6)', async (t) => {
  // Johan: "the usage for fable is a bit different than other models. we can only use 50% of our
  // weekly usage for it." The status line input lacks that window; Claude Code's usage has it.
  const fable = { name: 'Fable', used_percentage: 15, resets_at: 1_792_400_000 };
  let answer: ModelWindow[] | null = [fable];
  let looks = 0;
  let triedBeforeAnswer = false;
  const f = await fixture(t, async () => {
    looks++;
    // The try is remembered before Claude Code answers, so a cancelled run still counts.
    triedBeforeAnswer = 'windows_tried_at' in JSON.parse(await readFile(f.statePath, 'utf8'));
    return answer;
  });
  const stdin = JSON.stringify({ ...JSON.parse(input(10, 8)), model: { id: 'claude-fable-5-1' } });
  assert.match(
    await f.run(stdin),
    /^5h 90% left, resets \d\d:\d\d, week 92% left, fable 85% left$/,
  );
  assert.equal(triedBeforeAnswer, true);
  const last = () => f.sent.at(-1) as Record<string, unknown>;
  assert.deepEqual(last().model_windows, [fable]);
  // Claude Code is asked every 5 minutes at most, a failure included.
  f.advance(60_000);
  await f.run(stdin);
  assert.equal(looks, 1);
  answer = null;
  f.advance(5 * 60_000);
  await f.run(stdin);
  f.advance(5 * 60_000);
  await f.run(stdin);
  assert.equal(looks, 3);
  // Failed looks keep the last answer while it is fresh, then leave it out.
  assert.deepEqual(last().model_windows, [fable]);
  f.advance(5 * 60_000);
  await f.run(stdin);
  assert.equal('model_windows' in last(), false);
  // An empty answer says the account has none.
  answer = [];
  f.advance(5 * 60_000);
  await f.run(stdin);
  assert.deepEqual(last().model_windows, []);
  // A session on another model shows no window in its line, but still reports it.
  answer = [fable];
  f.advance(5 * 60_000);
  const opus = JSON.stringify({ ...JSON.parse(input(10, 8)), model: { id: 'claude-opus-5-5' } });
  assert.doesNotMatch(await f.run(opus), /fable/);
  assert.deepEqual(last().model_windows, [fable]);
});

test('Claude Code’s usage answer gives the per-model windows, or null when it says nothing of them', () => {
  const answer = (model_scoped: unknown, subtype = 'success') => ({
    subtype,
    request_id: 'usage',
    response: { rate_limits_available: true, rate_limits: { seven_day: {}, model_scoped } },
  });
  assert.deepEqual(
    modelWindows(
      answer([
        { display_name: 'Fable', utilization: 40, resets_at: '2026-10-22T14:59:59.819479+00:00' },
        { display_name: 'Unknown', utilization: null, resets_at: null },
      ]),
    ),
    [
      {
        name: 'Fable',
        used_percentage: 40,
        resets_at: Math.round(Date.parse('2026-10-22T14:59:59.819Z') / 1000),
      },
    ],
  );
  assert.deepEqual(modelWindows(answer([])), []);
  assert.equal(modelWindows(answer(undefined)), null);
  assert.equal(modelWindows(answer([], 'error')), null);
  assert.equal(modelWindows(null), null);
});

test('a model window covers the models of its family', () => {
  assert.equal(windowCovers('claude-fable-5-1', 'Fable'), true);
  assert.equal(windowCovers('claude-fable-5-1[1m]', 'Fable'), true);
  assert.equal(windowCovers('claude-opus-5-5', 'Fable'), false);
  assert.equal(windowCovers('claude-opus-4-6', 'Opus 4'), true);
  assert.equal(windowCovers('claude-fablemore-1', 'Fable'), false);
});

test('a broker before 0.8.6 gets the usage alone when it refuses the model windows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-statusline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent: Record<string, unknown>[] = [];
  await runStatusLine({ url: 'https://lobby.test', token: 'x' }, '/agent.json', input(10, 20), {
    now: () => Date.parse('2026-10-16T18:00:00Z'),
    statePath: join(directory, 'state.json'),
    account: async () => null,
    windows: async () => [{ name: 'Fable', used_percentage: 15, resets_at: 1_792_400_000 }],
    client: {
      request: async (_method: string, _path: string, body?: unknown) => {
        if (body && typeof body === 'object' && 'model_windows' in body)
          throw new LobbyClientError(400, 'invalid_request');
        sent.push(body as Record<string, unknown>);
        return { recorded: true };
      },
    } as never,
  });
  assert.deepEqual(
    // As sent on the wire, where a key without a value is left out.
    sent.map((body) => Object.keys(JSON.parse(JSON.stringify(body))).sort()),
    [['five_hour', 'seven_day']],
  );
});
