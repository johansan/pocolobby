import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runStatusLine, statusText, usageReport, USAGE_RESEND_MS } from '../src/statusline.js';

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

async function fixture(t: TestContext) {
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
  assert.match(statusText(report), /^5h 62% left, resets \d\d:\d\d · week 40% left$/);
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
    /^5h 62% left, resets \d\d:\d\d · week 40% left\nDry run, not sent: PUT \/v1\/usage \{/,
  );
  assert.match(shown, /"account":"johan@example.com"/);
  assert.deepEqual(f.sent, []);
  await assert.rejects(readFile(f.statePath, 'utf8'));
  assert.match(await f.run('{}', true), /no rate_limits, so nothing would be sent/);
  // The next real reading is sent as usual.
  await f.run(input(38.4, 60));
  assert.equal(f.sent.length, 1);
});
