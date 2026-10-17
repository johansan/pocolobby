import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createClaudeServer } from '../src/adapters/claude.js';
import { defaultTools, defineTool, type ToolDefinition } from '../src/catalog.js';
import { LobbyClient } from '../src/client.js';
import { loadConfig, writeConfigExclusive, type ConfigIdentity } from '../src/config.js';
import { decodePng, encodePng } from '../src/png.js';
import { startServer, type RunningServer, type ServerOptions } from '../src/server.js';
import type { AgentContext, Message, RuntimeBinding, StoredMessage } from '../src/protocol.js';
import { createLobby } from './lobby.js';

type Event = { content: string; meta: Record<string, string> };
type Content = { type: string; text?: string; data?: string; mimeType?: string };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const screenshot = (seed: number, width = 40, height = 30) =>
  encodePng({
    width,
    height,
    data: Uint8Array.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 ? 255 : (i * seed + (i >> 7)) % 256,
    ),
  });

/** Broker tools as 0.2.0 served them: send operations without attachments. */
const withoutAttachments = (): ToolDefinition<unknown>[] =>
  defaultTools().map((tool) =>
    tool.attachments
      ? defineTool({
          ...tool,
          attachments: undefined,
          input: (tool.input as unknown as z.ZodObject).omit({ attachments: true }),
        })
      : tool,
  );

/** Every HTTP request the in-process bridges make, as "METHOD /path". */
const requests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  return await realFetch(input, init);
};
const uploads = () => requests.filter((request) => request.startsWith('PUT /v1/attachments/'));

async function lobby(t: TestContext, options: Partial<ServerOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pocolobby-attach-bridge-')));
  const adminToken = randomBytes(32).toString('base64url');
  const settings: ServerOptions = {
    database: join(directory, 'lobby.db'),
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [60_000, 60_000, 60_000] },
    ...options,
  };
  let broker: RunningServer = await startServer(settings);
  await createLobby(broker.url, adminToken);
  const port = Number(new URL(broker.url).port);
  const url = broker.url;
  const owner = new LobbyClient({ url, token: adminToken });
  const sessions: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const session of sessions) await session.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  });
  /** `config` places the agent's credential file inside its home, as `adapter --config` reads it. */
  async function agent(
    id: string,
    { config, ...extra }: { config?: string; manage_rooms?: boolean } = {},
  ) {
    const { token } = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
      agent_id: id,
      ...extra,
    });
    const home = join(directory, `home-${id}`);
    await mkdir(join(home, 'Pictures'), { recursive: true });
    let credentialFile: ConfigIdentity | undefined;
    if (config) {
      await mkdir(dirname(join(home, config)), { recursive: true });
      await writeConfigExclusive(join(home, config), { url, token });
      credentialFile = (await loadConfig(join(home, config))).identity;
    }
    const adapter = createClaudeServer(
      { url, token, credentialFile },
      { log: () => {}, homeDir: home, reconnectBaseMs: 20, catalogRetryBaseMs: 20 },
    );
    const host = new Client({ name: `host-${id}`, version: '1.0.0' });
    const events: Event[] = [];
    const waiters = new Set<() => void>();
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      ({ params }) => {
        events.push(params);
        for (const wake of waiters) wake();
      },
    );
    const next = (accepts: (event: Event) => boolean, label = 'event') =>
      new Promise<Event>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Missing ${label} for ${id}`));
        }, 4000);
        function check() {
          const event = events.find(accepts);
          if (event) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(event);
          }
        }
        waiters.add(check);
        check();
      });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await host.callTool({ name, arguments: args })) as { isError?: boolean; content: Content[] };
    const tool = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await call(name, args);
      assert.notEqual(result.isError, true, `${name}: ${result.content[0]?.text}`);
      return JSON.parse(result.content[0]!.text!) as T;
    };
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    const session = {
      id,
      home,
      events,
      next,
      call,
      tool,
      host,
      adapter,
      async bootstrap() {
        const event = await next((value) => value.meta.event_type === 'bootstrap', 'bootstrap');
        const nonce = /probe_nonce ([a-f0-9-]+)/.exec(event.content)![1]!;
        const context = await tool<AgentContext>('get_context');
        await tool('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
        return { event, context };
      },
      async close() {
        await adapter.close();
        await host.close();
      },
    };
    sessions.push(session);
    return session;
  }
  return {
    url,
    owner,
    agent,
    get broker() {
      return broker;
    },
    async restart(next: Partial<ServerOptions> = {}) {
      await broker.close();
      broker = await startServer({ ...settings, ...next, port });
    },
  };
}

test('a builder sends before and after screenshots; the coordinator sees the images and keeps the originals', async (t) => {
  const l = await lobby(t);
  const builder = await l.agent('luke');
  const coordinator = await l.agent('vader');
  const { event: bootstrap, context } = await builder.bootstrap();
  await coordinator.bootstrap();
  // The bootstrap and get_context teach the arguments a stale tool list may lack.
  assert.match(bootstrap.content, /tool_guide, including attachments/);
  assert.match(bootstrap.content, /get_attachment's max_chars, headings and save_only/);
  assert.match(
    context.tool_guide!.operations.find((operation) => operation.name === 'send_message')!.arguments
      .attachments!,
    /absolute local file paths, images up to 10\.0 MiB, text up to 1\.0 MiB/,
  );
  assert(context.tool_guide!.bridge_tools!.some((entry) => entry.name === 'get_attachment'));
  const before = screenshot(3);
  const after = screenshot(5);
  const report = '# Login fix\n\n| case | result |\n| --- | --- |\n| empty password | refused |\n';
  await writeFile(join(builder.home, 'Pictures', 'before.png'), before);
  await writeFile(join(builder.home, 'Pictures', 'after.png'), after);
  await writeFile(join(builder.home, 'Pictures', 'report.md'), report);
  const send = {
    client_request_id: 'login-fix-screens',
    to: 'vader',
    kind: 'report',
    content: 'Login screen before and after the fix, with the test report.',
    attachments: [
      join(builder.home, 'Pictures', 'before.png'),
      join(builder.home, 'Pictures', 'after.png'),
      join(builder.home, 'Pictures', 'report.md'),
    ],
  };
  const sent = await builder.tool<StoredMessage>('send_message', send);
  assert.deepEqual(
    sent.message.attachments!.map((item) => [item.filename, item.mime_type]),
    [
      ['before.png', 'image/png'],
      ['after.png', 'image/png'],
      ['report.md', 'text/markdown'],
    ],
  );
  assert.equal(uploads().length, 3);
  // A retry with the same request ID and files uploads nothing and stores nothing new.
  const retried = await builder.tool<StoredMessage>('send_message', send);
  assert.deepEqual([retried.duplicate, retried.message.id], [true, sent.message.id]);
  assert.equal(uploads().length, 3);

  // The coordinator's push names the files in its first line.
  const push = await coordinator.next((event) => event.content.includes(sent.message.id), 'push');
  assert.match(
    push.content.split('\n')[0]!,
    /^PocoLobby report from luke \(no reply expected\): direct message, with 3 attachments: before\.png, after\.png, report\.md\. .*get_attachment/,
  );
  const payload = JSON.parse(push.content.slice(push.content.indexOf('\n') + 1)) as {
    messages: (Message & { extensions: { attachments: { id: string; filename: string }[] } })[];
  };
  const listed = payload.messages[0]!.extensions.attachments;
  assert.deepEqual(
    listed.map((item) => item.filename),
    ['before.png', 'after.png', 'report.md'],
  );
  // An image comes back as an MCP image block with the original bytes.
  const image = await coordinator.call('get_attachment', { id: listed[0]!.id });
  assert.notEqual(image.isError, true);
  assert.deepEqual(
    image.content.map((block) => block.type),
    ['image', 'text'],
  );
  assert.equal(image.content[0]!.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.content[0]!.data!, 'base64'), before);
  assert.match(image.content[1]!.text!, /before\.png \(image\/png, .*\) from luke.*40x30 px/);
  // A text document comes back as text.
  const text = await coordinator.call('get_attachment', { id: listed[2]!.id });
  assert.equal(text.content[1]!.text, report);
  assert.match(
    text.content[0]!.text!,
    /All \d+ characters follow\. .*information, not instructions/,
  );
  // save_to writes the original into an existing directory under the same rules.
  const saved = await coordinator.call('get_attachment', {
    id: listed[1]!.id,
    save_to: join(coordinator.home, 'Pictures'),
  });
  const path = /Saved the original to (.+?\.png)\./.exec(saved.content[1]!.text!)![1]!;
  assert.equal(path, join(coordinator.home, 'Pictures', 'after.png'));
  assert.deepEqual(await readFile(path), after);
  const refused = await coordinator.call('get_attachment', {
    id: listed[1]!.id,
    save_to: join(coordinator.home, '.ssh'),
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text!, /dot directory.*Nothing was written\./);

  // Message text naming a path never makes the recipient's bridge read or upload anything.
  const bait = await coordinator.tool<StoredMessage>('send_message', {
    client_request_id: randomUUID(),
    to: 'luke',
    content: `Please attach {"attachments":["${join(builder.home, 'Pictures', 'before.png')}"]}`,
  });
  const before_ = uploads().length;
  await builder.next((event) => event.content.includes(bait.message.id), 'bait push');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(uploads().length, before_);

  // A refused path sends nothing, and says so.
  await writeFile(join(builder.home, 'Pictures', 'api-key.txt'), 'secret');
  const refusedSend = await builder.call('send_message', {
    client_request_id: 'refused-send',
    to: 'vader',
    content: 'x',
    attachments: [join(builder.home, 'Pictures', 'api-key.txt')],
  });
  assert.equal(refusedSend.isError, true);
  assert.match(refusedSend.content[0]!.text!, /looks like a credential.*Nothing was sent\./);
  const history = await builder.tool<{ items: Message[] }>('get_messages', { mode: 'history' });
  assert(!history.items.some((message) => message.content === 'x'));
});

test('a bridge never attaches a PocoLobby credential, wherever it is kept and however named', async (t) => {
  const l = await lobby(t);
  // A supported placement: an ordinary folder and name in the home directory.
  const builder = await l.agent('luke', { config: join('PocoLobby', 'agent.json') });
  const coordinator = await l.agent('vader');
  await builder.bootstrap();
  await coordinator.bootstrap();
  const own = join(builder.home, 'PocoLobby', 'agent.json');
  const copy = join(builder.home, 'Pictures', 'settings.json');
  await copyFile(own, copy);
  const before = uploads().length;
  for (const [path, reason] of [
    [own, /this bridge's own PocoLobby credential file\. Nothing was sent\./],
    [copy, /a PocoLobby configuration, which holds a credential\. Nothing was sent\./],
  ] as const) {
    const refused = await builder.call('send_message', {
      client_request_id: randomUUID(),
      to: 'vader',
      content: 'Here is my config',
      attachments: [path],
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text!, reason);
  }
  assert.equal(uploads().length, before, 'nothing was uploaded');
  const history = await builder.tool<{ items: Message[] }>('get_messages', { mode: 'history' });
  assert(!history.items.some((message) => message.content === 'Here is my config'));
  // An ordinary JSON document beside it is still attached.
  const settings = join(builder.home, 'Pictures', 'viewport.json');
  await writeFile(settings, '{"url":"https://example.com/login","width":1280}');
  const sent = await builder.tool<StoredMessage>('send_message', {
    client_request_id: randomUUID(),
    to: 'vader',
    content: 'Viewport used for the screenshots',
    attachments: [settings],
  });
  assert.equal(sent.message.attachments![0]!.mime_type, 'application/json');
  assert.equal(uploads().length, before + 1);
});

test('a broker busy with other uploads gives the model a retryable refusal', async (t) => {
  const limits = { maxImageBytes: 1024 * 1024, maxTextBytes: 64 * 1024 };
  const l = await lobby(t, {
    uploadInflightBytes: limits.maxImageBytes,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [60_000, 60_000, 60_000], ...limits },
  });
  const builder = await l.agent('luke');
  await l.agent('vader').then((vader) => vader.bootstrap());
  await builder.bootstrap();
  // Another agent's large upload is still arriving and holds the whole budget.
  const { token } = await l.owner.request<{ token: string }>('POST', '/v1/admin/agents', {
    agent_id: 'lando',
  });
  const runtime = await new LobbyClient({ url: l.url, token }).request<RuntimeBinding>(
    'POST',
    '/v1/runtime',
    { runtime_id: randomUUID() },
  );
  const filler = httpRequest(`${l.url}/v1/attachments/${'0'.repeat(64)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(limits.maxImageBytes),
      'x-pocolobby-runtime-id': runtime.runtime_id,
      'x-pocolobby-generation': String(runtime.generation),
      'x-pocolobby-incarnation': runtime.incarnation,
    },
  });
  filler.on('error', () => {});
  filler.write(Buffer.alloc(64 * 1024));
  // The filler's headers reach the broker first in practice; until they do, a send succeeds,
  // so each attempt carries new content that must be uploaded.
  const path = join(builder.home, 'Pictures', 'shot.png');
  const deadline = Date.now() + 3000;
  let shot: Buffer;
  let send: Record<string, unknown>;
  let busy: Awaited<ReturnType<typeof builder.call>>;
  for (let seed = 11; ; seed++) {
    shot = screenshot(seed);
    await writeFile(path, shot);
    send = {
      client_request_id: randomUUID(),
      to: 'vader',
      content: 'Screenshot while the broker is busy',
      attachments: [path],
    };
    busy = await builder.call('send_message', send);
    if (busy.isError === true) break;
    assert(Date.now() < deadline, 'the filler must hold the budget');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(
    busy.content[0]!.text!,
    /^PocoLobby: uploading shot\.png failed: PocoLobby request failed \(503: uploads_busy\)\. .*Nothing was stored; retry in a few seconds\. The message was not sent; retry with the same client_request_id and attachments\.$/,
  );
  // Once the other upload ends, the model's retry with the same request ID goes through.
  filler.destroy();
  for (;;) {
    const result = await builder.call('send_message', send);
    if (result.isError !== true) {
      const stored = JSON.parse(result.content[0]!.text!) as StoredMessage;
      assert.notEqual(stored.duplicate, true, 'the refused send stored nothing');
      assert.equal(stored.message.attachments![0]!.sha256, sha(shot));
      break;
    }
    assert.match(result.content[0]!.text!, /uploads_busy/);
    assert(Date.now() < deadline + 3000, 'the aborted upload must release the budget');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test('large screenshots are reduced to fit a tool result; other formats are explained', async (t) => {
  const l = await lobby(t);
  const builder = await l.agent('luke');
  const coordinator = await l.agent('vader');
  await builder.bootstrap();
  await coordinator.bootstrap();
  // About 4.2 MB of incompressible pixels: over the inline limit, under the 10 MiB upload limit.
  const width = 1400;
  const height = 1000;
  const noisy = encodePng({
    width,
    height,
    data: Uint8Array.from(randomBytes(width * height * 4), (value, i) =>
      i % 4 === 3 ? 255 : value,
    ),
  });
  await writeFile(join(builder.home, 'Pictures', 'full-screen.png'), noisy);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x10, 0x00, 0x20, 0x00]),
    randomBytes(4 * 1024 * 1024),
  ]);
  await writeFile(join(builder.home, 'Pictures', 'still.jpg'), jpeg);
  const sent = await builder.tool<StoredMessage>('send_message', {
    client_request_id: 'large-images',
    to: 'vader',
    content: 'Large images',
    attachments: [
      join(builder.home, 'Pictures', 'full-screen.png'),
      join(builder.home, 'Pictures', 'still.jpg'),
    ],
  });
  const [png, still] = sent.message.attachments!;
  const reduced = await coordinator.call('get_attachment', { id: png!.id });
  assert.equal(reduced.content[0]!.type, 'image');
  const shown = decodePng(Buffer.from(reduced.content[0]!.data!, 'base64'))!;
  assert(shown.width < width && shown.height < height);
  assert.match(
    reduced.content[1]!.text!,
    /1400x1000 px\. Shown reduced to \d+x\d+ px .*use save_to/,
  );
  const described = await coordinator.call('get_attachment', { id: still!.id });
  assert.deepEqual(
    described.content.map((block) => block.type),
    ['text'],
  );
  assert.match(described.content[0]!.text!, /too large to show inline.*save_to/);
});

test('attachments reach the broker when the host cached an older schema, and through call_operation', async (t) => {
  // The broker starts with a send_message that takes no attachments.
  const l = await lobby(t, { tools: withoutAttachments() });
  const builder = await l.agent('luke');
  await l.agent('vader').then((vader) => vader.bootstrap());
  await builder.bootstrap();
  const cached = (await builder.host.listTools()).tools.find(
    (tool) => tool.name === 'send_message',
  )!;
  assert.equal('attachments' in (cached.inputSchema.properties ?? {}), false);
  const shot = screenshot(7);
  await writeFile(join(builder.home, 'Pictures', 'shot.png'), shot);
  const path = join(builder.home, 'Pictures', 'shot.png');
  // Against that broker, attachments are refused clearly, before any file is read.
  const early = await builder.call('send_message', {
    client_request_id: 'too-early',
    to: 'vader',
    content: 'x',
    attachments: [path],
  });
  assert.match(early.content[0]!.text!, /does not take attachments.*Nothing was sent/);
  // The broker is upgraded; the host keeps its cached schema and never lists tools again.
  l.broker.setTools(defaultTools());
  const deadline = Date.now() + 4000;
  for (;;) {
    const report = await builder.tool<{ operations: { name: string; local_files?: string[] }[] }>(
      'list_operations',
    );
    if (report.operations.find((tool) => tool.name === 'send_message')?.local_files) break;
    assert(Date.now() < deadline, 'the bridge must load the new catalog');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const named = await builder.tool<StoredMessage>('send_message', {
    client_request_id: 'named-with-stale-schema',
    to: 'vader',
    content: 'Through the named tool',
    attachments: [path],
  });
  assert.equal(named.message.attachments![0]!.sha256, sha(shot));
  // call_operation carries arguments the named schema lacks, through the same dispatch.
  const viaOperation = await builder.tool<StoredMessage>('call_operation', {
    operation: 'send_message',
    arguments: {
      client_request_id: 'through-call-operation',
      to: 'vader',
      kind: 'notice',
      content: 'Through call_operation',
      attachments: [path],
    },
  });
  assert.deepEqual(
    [viaOperation.message.kind, viaOperation.message.attachments![0]!.id],
    ['notice', named.message.attachments![0]!.id],
  );
  // Switching paths after an uncertain send: the same request ID and arguments are one message.
  const repeated = await builder.tool<StoredMessage>('send_message', {
    client_request_id: 'through-call-operation',
    to: 'vader',
    kind: 'notice',
    content: 'Through call_operation',
    attachments: [path],
  });
  assert.deepEqual([repeated.duplicate, repeated.message.id], [true, viaOperation.message.id]);
});

test('a catalog change rides on the next push, against what the model was told; it never wakes a session alone', async (t) => {
  const l = await lobby(t);
  const agent = await l.agent('luke');
  const peer = await l.agent('vader');
  const { context } = await agent.bootstrap();
  await peer.bootstrap();
  const original = context.tool_guide!.catalog_revision!;
  const quiet = async () => await new Promise((resolve) => setTimeout(resolve, 250));
  const catalogFetches = () => requests.filter((request) => request === 'GET /v1/tools').length;
  // Waits until the bridge has loaded the broker's catalog again.
  const refreshed = async (before: number) => {
    const deadline = Date.now() + 4000;
    while (catalogFetches() <= before) {
      assert(Date.now() < deadline, 'catalog refresh');
      await quiet();
    }
    await quiet();
  };
  let sends = 0;
  // A message from Vader, and the push that brings it.
  const push = async () => {
    const sent = await peer.tool<StoredMessage>('send_message', {
      client_request_id: `catalog-push-${++sends}`,
      to: 'luke',
      kind: 'notice',
      content: `Push ${sends}`,
    });
    return await agent.next((event) => event.content.includes(sent.message.id), `push ${sends}`);
  };
  // A broker-only release adds an operation and an argument.
  const later = [
    ...defaultTools().map((tool) =>
      tool.name === 'list_agents'
        ? defineTool({
            ...tool,
            input: z.object({ state: z.enum(['working', 'idle']).optional() }).strict(),
          })
        : tool,
    ),
    defineTool({
      name: 'count_pending',
      summary: 'Count your unacknowledged messages.',
      description: 'Count your unacknowledged messages without reading them.',
      input: z.object({}).strict(),
      run: async () => ({ pending: 0 }),
    }),
  ];
  let before = catalogFetches();
  l.broker.setTools(later);
  await refreshed(before);
  // Nothing reaches an idle session on its own.
  assert.equal(agent.events.filter((event) => event.meta.event_type === 'catalog').length, 0);
  const first = await push();
  assert.match(
    first.content,
    /\nPocoLobby tool catalog changed \(revision [0-9a-f]{12}\)\. New operations: count_pending\. New arguments: list_agents \(state\)\. .*list_operations.*call_operation/,
  );
  const revision = first.meta.catalog_revision!;
  assert.notEqual(revision, original);
  // Told once: the next push carries nothing, nor does the same catalog after a restart.
  assert.doesNotMatch((await push()).content, /catalog changed/);
  l.broker.setTools(later);
  await l.restart({ tools: later });
  await quiet();
  const reconnected = Date.now() + 4000;
  while (!requests.slice(-20).some((request) => request === 'GET /v1/tools')) {
    assert(Date.now() < reconnected);
    await quiet();
  }
  await quiet();
  assert.doesNotMatch((await push()).content, /catalog changed/);
  // Back to the original: what the model was told is gone again, so the next push says so.
  before = catalogFetches();
  l.broker.setTools(defaultTools());
  await refreshed(before);
  const back = await push();
  assert.match(back.content, /No longer offered: count_pending\./);
  assert.doesNotMatch(back.content, /New operations/);
  // A change undone before the next push says nothing.
  before = catalogFetches();
  l.broker.setTools(later);
  await refreshed(before);
  before = catalogFetches();
  l.broker.setTools(defaultTools());
  await refreshed(before);
  assert.doesNotMatch((await push()).content, /catalog changed/);
  // A change the model read in get_context is not told again.
  before = catalogFetches();
  l.broker.setTools(later.filter((tool) => tool.name !== 'count_pending'));
  await refreshed(before);
  await agent.tool('get_context');
  assert.doesNotMatch((await push()).content, /catalog changed/);
  // The next one is told once, with the next push.
  before = catalogFetches();
  l.broker.setTools(later);
  await refreshed(before);
  const third = await push();
  assert.match(third.content, /New operations: count_pending\./);
  assert.doesNotMatch(third.content, /New arguments/);
  assert.equal(third.meta.catalog_revision, revision);
  assert.doesNotMatch((await push()).content, /catalog changed/);
  assert.equal(agent.events.filter((event) => event.meta.event_type === 'catalog').length, 0);
});

test('a long document: parts of max_chars, a heading outline, and save_only into a new folder', async (t) => {
  const l = await lobby(t);
  const builder = await l.agent('lando');
  const coordinator = await l.agent('vader');
  await builder.bootstrap();
  const { context } = await coordinator.bootstrap();
  // The bridge's own guide teaches the new arguments of get_attachment.
  const guide = context.tool_guide!.bridge_tools!.find((entry) => entry.name === 'get_attachment')!;
  assert.deepEqual(Object.keys(guide.arguments).sort(), [
    'headings',
    'id',
    'max_chars',
    'offset',
    'save_only',
    'save_to',
  ]);
  // About 72 KB, like Lando's design document: front matter, sections, and a fenced block whose
  // '#' lines are not headings.
  const section = (title: string, level = 2) =>
    `${'#'.repeat(level)} ${title}\n\n${`${title} details. `.repeat(600)}\n\n`;
  const document = [
    '---\ntitle: Design\n# a YAML comment, not a heading\n---\n',
    section('Design', 1),
    section('Background'),
    section('Constraints', 3),
    '```sh\n# a shell comment, not a heading\n```\n\n',
    section('Plan'),
    section('Open questions'),
    section('Decision'),
    section('Appendix', 3),
  ].join('');
  assert(document.length > 60_000 && document.length < 100_000, String(document.length));
  await writeFile(join(builder.home, 'Pictures', 'design.md'), document);
  await writeFile(join(builder.home, 'Pictures', 'notes.txt'), 'plain notes\n');
  await writeFile(join(builder.home, 'Pictures', 'shot.png'), screenshot(9));
  const sent = await builder.tool<StoredMessage>('send_message', {
    client_request_id: 'design-doc',
    to: 'vader',
    kind: 'report',
    content: 'The design document, a note and a screenshot.',
    attachments: ['design.md', 'notes.txt', 'shot.png'].map((name) =>
      join(builder.home, 'Pictures', name),
    ),
  });
  const [doc, notes, shot] = sent.message.attachments!.map((item) => item.id);
  const texts = (result: { content: Content[] }) => result.content.map((block) => block.text!);

  // The first part: 12,000 characters by default, and a footer on how to avoid reading it all.
  // Every part, the outline and the end come from one download.
  const client = coordinator.adapter.client;
  const download = client.download.bind(client);
  let downloads = 0;
  client.download = (path) => {
    downloads++;
    return download(path);
  };
  const first = texts(await coordinator.call('get_attachment', { id: doc }));
  assert.equal(first.length, 3);
  assert.match(first[0]!, new RegExp(`Characters 0-12000 of ${document.length} follow\\.`));
  assert.equal(first[1], document.slice(0, 12_000));
  assert.match(first[2]!, /more characters: continue with get_attachment\(id, offset=12000\)\./);
  assert.match(first[2]!, /headings=true/);
  assert.match(first[2]!, /save_to=<directory>, save_only=true\) and search the saved file/);
  // A later part says only how to continue; max_chars sets its size.
  const later = texts(
    await coordinator.call('get_attachment', { id: doc, offset: 12_000, max_chars: 500 }),
  );
  assert.equal(later[1], document.slice(12_000, 12_500));
  assert.doesNotMatch(later[2]!, /headings|save_to/);
  const tooMany = await coordinator.call('get_attachment', { id: doc, max_chars: 40_001 });
  assert.equal(tooMany.isError, true);
  // The end of the document, from where the outline says it starts.
  const end = texts(
    await coordinator.call('get_attachment', { id: doc, offset: document.length - 1000 }),
  );
  assert.equal(end.length, 2);
  assert.equal(end[1], document.slice(-1000));

  // The outline: each heading with an offset that starts it, counted from the start of the file.
  const outline = texts(await coordinator.call('get_attachment', { id: doc, headings: true }));
  assert.equal(downloads, 1);
  assert.match(outline[0]!, /Outline: 7 of 7 headings, in \d+ characters\./);
  assert.match(outline[0]!, new RegExp(`start at offset ${document.length - 12_000}\\.`));
  const lines = outline[1]!.split('\n');
  assert.deepEqual(
    lines.map((line) => line.replace(/^offset \d+ \(\d+ chars\): /, '')),
    [
      '# Design',
      '## Background',
      '### Constraints',
      '## Plan',
      '## Open questions',
      '## Decision',
      '### Appendix',
    ],
  );
  for (const line of lines) {
    const [, offset, length, heading] = /^offset (\d+) \((\d+) chars\): (.+)$/.exec(line)!;
    assert(document.slice(Number(offset)).startsWith(heading!), line);
    const part = await coordinator.call('get_attachment', {
      id: doc,
      offset: Number(offset),
      max_chars: Math.min(Number(length), 40_000),
    });
    assert(part.content[1]!.text!.startsWith(heading!), line);
  }
  // A small max_chars pages the outline; following it lists every heading once.
  const paged: string[] = [];
  let next: number | undefined = 0;
  while (next !== undefined) {
    const page = texts(
      await coordinator.call('get_attachment', {
        id: doc,
        headings: true,
        offset: next,
        max_chars: 1,
      }),
    );
    paged.push(...page[1]!.split('\n'));
    const more = /headings=true, offset=(\d+)\)/.exec(page[2] ?? '');
    next = more ? Number(more[1]) : undefined;
  }
  assert.deepEqual(paged, lines);
  // Headings belong to Markdown; other files say what to do instead.
  const plain = await coordinator.call('get_attachment', { id: notes, headings: true });
  assert.equal(plain.isError, true);
  assert.match(plain.content[0]!.text!, /Read it in parts with offset and max_chars/);
  const picture = await coordinator.call('get_attachment', { id: shot, headings: true });
  assert.match(picture.content[0]!.text!, /Open it without headings/);

  // save_only files the original into a folder that does not exist yet, and returns no content.
  const folder = join(coordinator.home, 'Dropbox', 'MDP', 'reviews', 'design');
  const filed = await coordinator.call('get_attachment', {
    id: doc,
    save_to: folder,
    save_only: true,
    headings: true,
  });
  assert.deepEqual(
    filed.content.map((block) => block.type),
    ['text'],
  );
  assert.match(
    filed.content[0]!.text!,
    /Created the directory and saved the original to .*design\.md\. Its contents were not returned \(save_only\)\./,
  );
  assert.equal(await readFile(join(folder, 'design.md'), 'utf8'), document);
  const image = await coordinator.call('get_attachment', {
    id: shot,
    save_to: folder,
    save_only: true,
  });
  assert.deepEqual(
    image.content.map((block) => block.type),
    ['text'],
  );
  assert.match(
    image.content[0]!.text!,
    /^PocoLobby attachment shot\.png .* Saved the original .* 40x30 px\./,
  );
  // Once saved, the first part points at the saved file instead.
  const afterSave = texts(await coordinator.call('get_attachment', { id: doc, save_to: folder }));
  assert.match(
    afterSave[2]!,
    /The whole file is at .*design \(2\)\.md: search it with your local tools/,
  );
  // save_only needs save_to; a refused folder is never created.
  const alone = await coordinator.call('get_attachment', { id: doc, save_only: true });
  assert.match(alone.content[0]!.text!, /save_only needs save_to/);
  const hidden = await coordinator.call('get_attachment', {
    id: doc,
    save_to: join(coordinator.home, 'Dropbox', '.cache', 'x'),
    save_only: true,
  });
  assert.match(hidden.content[0]!.text!, /dot directory.*Nothing was written\./);
  await assert.rejects(readFile(join(coordinator.home, 'Dropbox', '.cache')), /ENOENT/);
});

test('a send names the size limit that applies and where other files go', async (t) => {
  const l = await lobby(t);
  const builder = await l.agent('lando');
  await l.agent('vader').then((vader) => vader.bootstrap());
  await builder.bootstrap();
  const send = (path: string) =>
    builder.call('send_message', {
      client_request_id: randomUUID(),
      to: 'vader',
      content: 'x',
      attachments: [path],
    });
  // Above what the bridge reads: the broker's configured limit, from its catalog, is named.
  const huge = join(builder.home, 'Pictures', 'huge.md');
  await writeFile(huge, Buffer.alloc(20 * 1024 * 1024, 'a'));
  const refusal = await send(huge);
  assert.equal(refusal.isError, true);
  assert.match(
    refusal.content[0]!.text!,
    /it is 20\.0 MiB; this broker accepts text attachments up to 1\.0 MiB\. Nothing was sent\./,
  );
  // Below it, the broker refuses with the same limit before anything is uploaded.
  const before = uploads().length;
  const large = join(builder.home, 'Pictures', 'large.md');
  await writeFile(large, Buffer.alloc(2 * 1024 * 1024, 'a'));
  const brokerRefusal = await send(large);
  assert.match(brokerRefusal.content[0]!.text!, /accepts text attachments up to 1\.0 MiB/);
  assert.equal(uploads().length, before);
  // Another type: the refusal says to share a location in the evidence field.
  const model = join(builder.home, 'Pictures', 'scene.glb');
  await writeFile(model, 'glTF');
  assert.match(
    (await send(model)).content[0]!.text!,
    /For other files, put a logical location each machine resolves itself, such as dropbox:MDP\/reports\/run-42, in the evidence field\. Nothing was sent\./,
  );
});

test('a coordinator whose tool list predates them changes and deletes rooms through call_operation', async (t) => {
  // The broker starts as 0.3.0 served it: without the room changes and deletion.
  const added = ['add_room_members', 'remove_room_members', 'delete_room'];
  const l = await lobby(t, {
    tools: defaultTools().filter((tool) => !added.includes(tool.name)),
  });
  const coordinator = await l.agent('vader', { manage_rooms: true });
  for (const id of ['luke', 'leia']) await l.agent(id);
  await coordinator.bootstrap();
  const cached = (await coordinator.host.listTools()).tools.map((tool) => tool.name);
  for (const name of added) assert(!cached.includes(name), name);
  await coordinator.tool('create_room', { room_id: 'app' });
  // The broker is upgraded; the host keeps its tool list.
  l.broker.setTools(defaultTools());
  const deadline = Date.now() + 4000;
  for (;;) {
    const report = await coordinator.tool<{ operations: { name: string }[] }>('list_operations');
    if (report.operations.some((tool) => tool.name === 'delete_room')) break;
    assert(Date.now() < deadline, 'the bridge must load the new catalog');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const operate = <T>(operation: string, args: Record<string, unknown>) =>
    coordinator.tool<T>('call_operation', { operation, arguments: args });
  const added_ = await operate<{ members: string[] }>('add_room_members', {
    room_id: 'app',
    members: ['luke', 'leia', 'vader'],
  });
  assert.deepEqual(added_.members, ['leia', 'luke', 'vader']);
  const removed = await operate<{ members: string[] }>('remove_room_members', {
    room_id: 'app',
    members: ['luke'],
  });
  assert.deepEqual(removed.members, ['leia', 'vader']);
  const deleted = await operate<{ deleted: boolean; former_members: string[] }>('delete_room', {
    room_id: 'app',
  });
  assert.deepEqual([deleted.deleted, deleted.former_members], [true, ['leia', 'vader']]);
  const again = await coordinator.call('call_operation', {
    operation: 'delete_room',
    arguments: { room_id: 'app' },
  });
  assert.equal(again.isError, true);
  assert.match(again.content[0]!.text!, /404: room_not_found/);
  // The guide in get_context lists them for the next bootstrap.
  const context = await coordinator.tool<AgentContext>('get_context');
  for (const name of added)
    assert(
      context.tool_guide!.operations.some((operation) => operation.name === name),
      name,
    );
});
