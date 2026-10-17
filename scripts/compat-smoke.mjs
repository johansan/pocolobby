// This checkout's broker (its dist; run npm run build first) with bridges installed from an older
// package, as a fleet runs between a broker deploy and the agents' upgrade.
// Usage: node scripts/compat-smoke.mjs path/to/pocolobby-0.8.1.tgz
// It checks room messages to named members through the older bridges; extend it with each release.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const repo = fileURLToPath(new URL('..', import.meta.url));
const sdk = `${repo}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${sdk}/client/index.js`);
const { StdioClientTransport, getDefaultEnvironment } = await import(`${sdk}/client/stdio.js`);
const { z } = await import(`${repo}/node_modules/zod/index.js`);
const exec = promisify(execFile);
const tgz = process.argv[2];
if (!tgz) throw new Error('Usage: node scripts/compat-smoke.mjs path/to/older-pocolobby.tgz');
const dir = await mkdtemp(join(tmpdir(), 'pocolobby-compat-'));
const hosts = [];
let server;
try {
  await exec('npm', [
    'install',
    '--prefix',
    dir,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tgz,
  ]);
  const oldCli = join(dir, 'node_modules', 'pocolobby', 'dist', 'cli.js');
  const oldVersion = JSON.parse(
    await readFile(join(dir, 'node_modules', 'pocolobby', 'package.json'), 'utf8'),
  ).version;
  const newVersion = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version;
  const newBin = join(repo, 'dist', 'bin.js');
  const cli = (...args) => exec(process.execPath, [newBin, ...args], { cwd: dir });
  const owner = join(dir, 'owner.json');
  await cli('init', '--config', owner);
  server = spawn(
    process.execPath,
    [newBin, 'server', '--config', owner, '--db', join(dir, 'state.db'), '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_TOKEN: '', ANTHROPIC_API_KEY: '', POSTMARK_TOKEN: '' },
    },
  );
  server.stderr.resume();
  const url = await new Promise((res, rej) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      const m = /listening at (http:\/\/[^\s]+)\./.exec(out);
      if (m) res(m[1]);
    });
    setTimeout(() => rej(new Error('broker start')), 10_000);
  });
  await writeFile(owner, JSON.stringify({ ...JSON.parse(await readFile(owner, 'utf8')), url }), {
    mode: 0o600,
  });
  // A new broker has no lobby until its owner creates one.
  await cli('lobby', 'create', 'my-team', '--config', owner);
  for (const id of ['vader', 'leia', 'luke', 'mouse'])
    await cli(
      'agent',
      'add',
      id,
      '--config',
      owner,
      '--out',
      join(dir, `${id}.json`),
      ...(id === 'vader' ? ['--coordinator'] : []),
    );

  async function start(id, conversation = randomUUID()) {
    const host = new Client({ name: `compat-${id}`, version: '1.0.0' });
    hosts.push(host);
    const queue = [];
    const listeners = new Set();
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      ({ params }) => {
        queue.push(params);
        for (const l of listeners) l();
      },
    );
    const next = (accepts, label, ms = 10_000) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => {
          listeners.delete(check);
          rej(new Error(`${id}: no ${label}`));
        }, ms);
        function check() {
          const i = queue.findIndex(accepts);
          if (i >= 0) {
            clearTimeout(t);
            listeners.delete(check);
            res(queue.splice(i, 1)[0]);
          }
        }
        listeners.add(check);
        check();
      });
    const tool = async (name, args = {}) => {
      const r = await host.callTool({ name, arguments: args });
      if (r.isError) throw new Error(`${id} ${name}: ${r.content[0].text}`);
      return JSON.parse(r.content[0].text);
    };
    const configPath = join(dir, `${id}.json`);
    const generated = JSON.parse(
      (await exec(process.execPath, [oldCli, 'mcp-config', '--config', configPath])).stdout,
    );
    const home = join(dir, `home-${id}`);
    await mkdir(home, { recursive: true });
    const transport = new StdioClientTransport({
      ...generated.mcpServers.pocolobby,
      env: {
        ...getDefaultEnvironment(),
        CLAUDE_CODE_SESSION_ID: conversation,
        HOME: home,
        USERPROFILE: home,
      },
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    await host.connect(transport);
    assert.equal(host.getServerVersion().version, oldVersion);
    const boot = await next((e) => e.meta.event_type === 'bootstrap', 'bootstrap');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(boot.content)[1];
    const context = await tool('get_context');
    await tool('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
    return { host, tool, next, queue, context, ready: true };
  }
  const vader = await start('vader');
  const leia = await start('leia');
  const lukeConversation = randomUUID();
  const luke = await start('luke', lukeConversation);
  const mouse = await start('mouse');
  // get_context through a 0.8.1 bridge shows which broker answered.
  assert.equal(leia.context.broker.version, newVersion);
  assert.match(leia.context.broker.host, /^127\.0\.0\.1:\d+$/);
  await vader.tool('create_room', { room_id: 'builders' });
  await vader.tool('set_room_members', {
    room_id: 'builders',
    members: ['vader', 'leia', 'luke', 'mouse'],
  });
  // Sent through a 0.8.1 bridge: its send_room_message comes from the broker's catalog.
  const sent = await vader.tool('send_room_message', {
    client_request_id: 'compat-subset',
    room: 'builders',
    to: ['luke', 'leia'],
    kind: 'request',
    content: 'Leia and Luke: check 77bb9f0',
    notify_when_seen: true,
  });
  assert.deepEqual(sent.message.addressed_to, ['leia', 'luke']);
  assert.deepEqual(
    sent.deliveries.map((d) => d.agent_id),
    ['leia', 'luke'],
  );
  for (const agent of [leia, luke]) {
    const push = await agent.next((e) => e.content.includes(sent.message.id), 'subset push');
    const [lead] = push.content.split('\n');
    assert.match(
      lead,
      /request from vader \(reply expected\): room message in room builders to leia, luke only/,
    );
    assert.match(push.content, /only some of the room/);
    const payload = JSON.parse(push.content.slice(push.content.indexOf('\n{')));
    assert.equal(payload.messages[0].to, '*');
    assert.deepEqual(payload.messages[0].extensions.addressed_to, ['leia', 'luke']);
    assert.equal(push.meta.room_id, 'builders');
  }
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(
    mouse.queue.filter((e) => e.content.includes(sent.message.id)).length,
    0,
    'mouse not woken',
  );
  // Acknowledge with a stray ID: the broker names it.
  const stray = randomUUID();
  const ack = await leia.tool('acknowledge_messages', { message_ids: [sent.message.id, stray] });
  assert.deepEqual(ack.unknown_message_ids, [stray]);
  // The receipt reaches the 0.8.1 sender, whose schema wants to as an ID or *.
  const receipt = await vader.next((e) => e.meta.event_type === 'receipts', 'receipt');
  assert.match(receipt.content, /leia/);
  // History search through a 0.8.1 bridge (catalog tool).
  const found = await leia.tool('get_messages', { mode: 'history', query: '77BB9F0' });
  assert.deepEqual(
    found.items.map((m) => m.id),
    [sent.message.id],
  );
  assert.deepEqual(found.items[0].addressed_to, ['leia', 'luke']);
  // A subset message waiting in pending pages and reconciliation for a bridge that restarts.
  await luke.host.close();
  const later = await vader.tool('send_room_message', {
    client_request_id: 'compat-subset-2',
    room: 'builders',
    to: ['luke'],
    kind: 'notice',
    content: 'Only Luke, while away',
  });
  const luke2 = await start('luke', lukeConversation);
  assert(
    luke2.context.pending.items.some(
      (m) => m.id === later.message.id && m.addressed_to?.[0] === 'luke',
    ),
  );
  const pushed = await luke2.next(
    (e) => e.content.includes(later.message.id),
    'push after restart',
  );
  assert.match(pushed.content, /to luke only/);
  // The whole room still works as before.
  const whole = await vader.tool('send_room_message', {
    client_request_id: 'compat-whole',
    room: 'builders',
    kind: 'notice',
    content: 'Everyone',
  });
  await mouse.next((e) => e.content.includes(whole.message.id), 'whole-room push');
  console.log(
    `PASS: the ${newVersion} broker with installed ${oldVersion} bridges: named room members sent through an old bridge, pushes to only them with the names under extensions and in the lead, nobody else woken, receipts, unknown acknowledgment IDs, history search, broker in get_context, pending and push after a bridge restart, whole-room sends unchanged. Simulated MCP host; no model calls.`,
  );
} finally {
  for (const h of hosts) await h.close().catch(() => {});
  server?.kill();
  await rm(dir, { recursive: true, force: true });
}
