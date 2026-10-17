// Acceptance tests for upgrades without agent restarts. Each runs a real adapter subprocess,
// started the way Claude starts it, under a simulated MCP host; no model is involved. Only the
// broker changes: its catalog, its permissions, its process. The bridge process and its files
// stay as they are.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createClaudeServer } from '../src/adapters/claude.js';
import { defaultTools, defineTool, type ToolDefinition } from '../src/catalog.js';
import { LobbyClient } from '../src/client.js';
import { startServer, type RunningServer } from '../src/server.js';
import type {
  AgentContext,
  Message,
  Page,
  RuntimeBinding,
  StoredMessage,
} from '../src/protocol.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLobby } from './lobby.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
type ChannelEvent = { content: string; meta: Record<string, string> };

/** A real broker on a fixed port, so it can stop and start again under the same URL. */
async function brokerFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-upgrade-'));
  const adminToken = randomBytes(32).toString('base64url');
  const options = {
    database: join(directory, 'lobby.db'),
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { infoDelayMs: 0 },
  };
  let broker: RunningServer | undefined = await startServer(options);
  await createLobby(broker.url, adminToken);
  // The first start picks a free port; restarts take the same one, so the URL stays.
  const port = Number(new URL(broker.url).port);
  options.port = port;
  const url = `http://127.0.0.1:${port}`;
  const owner = new LobbyClient({ url, token: adminToken });
  return {
    url,
    port,
    directory,
    owner,
    get broker() {
      return broker!;
    },
    async stop() {
      await broker?.close();
      broker = undefined;
    },
    async start(tools?: ToolDefinition<unknown>[]) {
      broker = await startServer({ ...options, tools });
    },
    async provision(agent_id: string, extra: Record<string, unknown> = {}) {
      const { token } = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
        agent_id,
        ...extra,
      });
      const path = join(directory, `${agent_id}.json`);
      await writeFile(path, JSON.stringify({ url, token }), { mode: 0o600 });
      return { token, path };
    },
    async close() {
      await broker?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A peer that talks plain HTTP, like the CLI or an older adapter. */
async function httpPeer(url: string, token: string) {
  const client = new LobbyClient({ url, token });
  const binding = await client.request<RuntimeBinding>('POST', '/v1/runtime', {
    runtime_id: randomUUID(),
  });
  return {
    send: (to: string, content: string, extra: Record<string, unknown> = {}) =>
      client.request<StoredMessage>(
        'POST',
        '/v1/messages',
        { client_request_id: randomUUID(), to, content, ...extra },
        binding,
      ),
    pending: () => client.request<Page<Message>>('GET', '/v1/messages?mode=pending'),
  };
}

/** Starts `pocolobby adapter` as a subprocess, exactly as a generated MCP config does. */
async function bridgeProcess(configPath: string) {
  const host = new Client({ name: 'upgrade-test-host', version: '1.0.0' });
  const events: ChannelEvent[] = [];
  const listChanges: number[] = [];
  host.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
    }),
    ({ params }) => {
      events.push(params);
    },
  );
  host.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanges.push(Date.now());
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(root, 'src/bin.ts'), 'adapter', '--config', configPath],
    cwd: root,
    env: { ...getDefaultEnvironment(), CLAUDE_CODE_SESSION_ID: randomUUID() },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (data: Buffer) => stderr.push(data.toString()));
  await host.connect(transport);
  async function until<T>(find: () => T | undefined, what: string, ms = 10_000): Promise<T> {
    const limit = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found !== undefined && found !== false) return found;
      assert(Date.now() < limit, `Timed out waiting for ${what}; bridge log: ${stderr.join('')}`);
      await sleep(10);
    }
  }
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    host.callTool({ name, arguments: args });
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await raw(name, args);
    const text = (result.content as { text: string }[])[0]!.text;
    assert.notEqual(result.isError, true, `${name}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function refused(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await raw(name, args);
    const text = (result.content as { text: string }[])[0]!.text;
    assert.equal(result.isError, true, `${name} should fail: ${text}`);
    return text;
  }
  const tools = async () => (await host.listTools()).tools;
  const names = async () => (await tools()).map((tool) => tool.name);
  return {
    host,
    pid: transport.pid,
    events,
    listChanges,
    stderr,
    until,
    call,
    refused,
    tools,
    names,
    async bootstrap() {
      const event = await until(
        () => events.find((value) => value.meta.event_type === 'bootstrap'),
        'bootstrap',
      );
      const nonce = /probe_nonce ([a-f0-9-]+)/.exec(event.content)![1];
      const context = await call<AgentContext & { runtime_scope: string }>('get_context');
      await call('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
      return context;
    },
    pushed: (id: string) =>
      until(
        () =>
          events.find((value) => value.meta.event_type === 'inbox' && value.content.includes(id)),
        `the push of ${id}`,
      ),
    close: () => host.close(),
  };
}

/** Release 0.2.x of the broker, simulated: a new tool and a new optional argument. */
function laterRelease(): ToolDefinition<unknown>[] {
  const tools = defaultTools().map((tool) =>
    tool.name === 'list_agents'
      ? defineTool({
          ...tool,
          description: `${tool.description} With waiting, only agents that wait on the owner.`,
          input: z.object({ waiting: z.boolean().optional() }).strict(),
          run: async (context, { waiting }) => {
            const listed = await context.call<{ agents: { owner_requests: object | null }[] }>(
              'GET',
              '/v1/agents',
            );
            return waiting
              ? { agents: listed.agents.filter((agent) => agent.owner_requests !== null) }
              : listed;
          },
        })
      : tool,
  );
  tools.push(
    defineTool({
      name: 'count_pending',
      description: 'Count your unacknowledged messages without reading them.',
      input: z.object({}).strict(),
      run: async (context) => ({
        pending: (await context.call<Page<Message>>('GET', '/v1/messages?mode=pending&limit=100'))
          .items.length,
      }),
    }),
  );
  return tools;
}

test('a broker-only catalog change reaches a running, unchanged bridge subprocess', async () => {
  const lobby = await brokerFixture();
  let bridge: Awaited<ReturnType<typeof bridgeProcess>> | undefined;
  try {
    const alpha = await lobby.provision('alpha');
    const peerCredential = await lobby.provision('beta');
    bridge = await bridgeProcess(alpha.path);
    const pid = bridge.pid;
    assert(pid);

    // Tool discovery needs only the credential: the catalog is listed before bootstrap,
    // filtered by permission (alpha may neither broadcast nor manage rooms).
    const before = await bridge.names();
    assert.deepEqual(before, [
      'send_message',
      'send_room_message',
      'schedule_message',
      'list_scheduled',
      'cancel_scheduled',
      'list_agents',
      'set_owner_requests',
      'list_rooms',
      'get_messages',
      'get_context',
      'ready',
      'acknowledge_messages',
      'save_checkpoint',
      'list_operations',
      'call_operation',
      'get_attachment',
    ]);
    await bridge.until(
      () => bridge!.events.find((value) => value.meta.event_type === 'bootstrap'),
      'bootstrap',
    );
    // A catalog tool works before ready.
    const early = await bridge.call<{ agents: { agent_id: string }[] }>('list_agents');
    assert.deepEqual(
      early.agents.map((agent) => agent.agent_id),
      ['alpha', 'beta'],
    );
    const context = await bridge.bootstrap();
    assert.equal(context.runtime_scope, 'conversation');
    const peer = await httpPeer(lobby.url, peerCredential.token);

    // Messaging and Channel delivery work.
    const first = await peer.send('alpha', 'Before the broker update', { kind: 'notice' });
    const push = await bridge.pushed(first.message.id);
    assert.match(
      push.content,
      /^PocoLobby notice from beta \(no reply expected\): direct message\. /,
    );
    await bridge.call('acknowledge_messages', { message_ids: [first.message.id] });
    const reply = await bridge.call<StoredMessage>('send_message', {
      client_request_id: 'alpha-reply-1',
      to: 'beta',
      kind: 'report',
      content: 'Seen before the update',
    });
    assert.deepEqual(
      (await peer.pending()).items.map((message) => message.id),
      [reply.message.id],
    );

    // Only the broker changes: a new tool, and an optional argument on an existing one.
    lobby.broker.setTools(laterRelease());
    await bridge.until(() => bridge!.listChanges.length === 1 || undefined, 'tools/list_changed');
    const after = await bridge.tools();
    assert.deepEqual(
      after.map((tool) => tool.name),
      [...before.slice(0, 9), 'count_pending', ...before.slice(9)],
    );
    const listAgents = after.find((tool) => tool.name === 'list_agents')!;
    assert.deepEqual(Object.keys(listAgents.inputSchema.properties ?? {}), ['waiting']);
    await bridge.call('set_owner_requests', { count: 1, text: 'Look at the upgrade test' });
    const filtered = await bridge.call<{ agents: { agent_id: string }[] }>('list_agents', {
      waiting: true,
    });
    assert.deepEqual(
      filtered.agents.map((agent) => agent.agent_id),
      ['alpha'],
    );
    const second = await peer.send('alpha', 'After the broker update');
    await bridge.pushed(second.message.id);
    assert.deepEqual(await bridge.call('count_pending'), { pending: 1 });
    await bridge.call('acknowledge_messages', { message_ids: [second.message.id] });
    assert.deepEqual(await bridge.call('count_pending'), { pending: 0 });

    // A host that never re-reads its tool list still reaches a newer operation.
    const withWhoami = [
      ...laterRelease(),
      defineTool({
        name: 'whoami',
        description: 'Your agent and lobby.',
        input: z.object({}).strict(),
        run: async (context) => {
          const own = await context.call<AgentContext>('GET', '/v1/context');
          return { agent_id: own.agent_id, lobby_id: own.lobby_id };
        },
      }),
    ];
    lobby.broker.setTools(withWhoami);
    await bridge.until(() => bridge!.listChanges.length === 2 || undefined, 'a second change');
    const operations = await bridge.call<{ operations: { name: string }[]; revision: string }>(
      'list_operations',
    );
    assert(operations.operations.some((operation) => operation.name === 'whoami'));
    assert.deepEqual(await bridge.call('call_operation', { operation: 'whoami' }), {
      agent_id: 'alpha',
      lobby_id: 'my-team',
    });

    // A broker restart (a deploy of the same release) keeps the bridge, its runtime and its
    // catalog, and tells the host nothing new.
    await lobby.stop();
    const down = await bridge.refused('list_agents');
    assert.match(down, /network: connection_failed_or_timed_out/);
    await lobby.start(withWhoami);
    const third = await peer.send('alpha', 'After the broker restart');
    await bridge.pushed(third.message.id);
    const resumed = await bridge.call<AgentContext>('get_context');
    assert.equal(resumed.runtime_id, context.runtime_id);
    assert.equal(bridge.listChanges.length, 2, 'an unchanged catalog sends no notice');
    assert.equal(
      bridge.events.filter((value) => value.meta.event_type === 'bootstrap').length,
      1,
      'a network reconnect needs no new bootstrap',
    );

    // Deploying a release without those tools removes them, and says so.
    await lobby.stop();
    await lobby.start();
    await bridge.until(() => bridge!.listChanges.length === 3 || undefined, 'the removal');
    assert.deepEqual(await bridge.names(), before);
    assert.match(
      await bridge.refused('count_pending'),
      /^PocoLobby: count_pending is no longer offered: the broker removed count_pending from its tool catalog/,
    );

    // A permission change by the owner adds and withdraws tools while the bridge runs.
    await lobby.owner.request('PATCH', '/v1/admin/agents/alpha', { manage_rooms: true });
    await bridge.until(() => bridge!.listChanges.length === 4 || undefined, 'the promotion');
    assert(await bridge.names().then((list) => list.includes('create_room')));
    await bridge.call('create_room', { room_id: 'app' });
    await lobby.owner.request('PATCH', '/v1/admin/agents/alpha', { manage_rooms: false });
    await bridge.until(() => bridge!.listChanges.length === 5 || undefined, 'the demotion');
    assert.match(
      await bridge.refused('create_room', { room_id: 'web' }),
      /^PocoLobby: create_room is not available to this agent\. Needs room-management permission \(manage_rooms\)/,
    );

    // Through all of it: one process, one runtime, retry identity intact.
    assert.equal(bridge.pid, pid);
    const retried = await bridge.call<StoredMessage>('send_message', {
      client_request_id: 'alpha-reply-1',
      to: 'beta',
      kind: 'report',
      content: 'Seen before the update',
    });
    assert.deepEqual([retried.duplicate, retried.message.id], [true, reply.message.id]);
  } finally {
    await bridge?.close();
    await lobby.close();
  }
});

test('a bridge started while the broker is down lists its own tools, then adopts the catalog', async () => {
  const lobby = await brokerFixture();
  let bridge: Awaited<ReturnType<typeof bridgeProcess>> | undefined;
  try {
    const alpha = await lobby.provision('alpha');
    await lobby.stop();
    bridge = await bridgeProcess(alpha.path);
    const offline = await bridge.names();
    assert.equal(offline.length, 7, 'the bridge tools');
    assert.match(
      await bridge.refused('list_agents'),
      /not available right now: the broker did not answer the catalog request.*Nothing was sent/,
    );
    const report = await bridge.call<{ status: string }>('list_operations');
    assert.equal(report.status, 'refresh_failing');
    await lobby.start();
    // The non-coordinator's catalog withholds six room and broadcast tools, so the host hears
    // of the change.
    await bridge.until(() => bridge!.listChanges.length === 1 || undefined, 'the catalog');
    assert.equal((await bridge.names()).length, 9 + 7);
    const context = await bridge.bootstrap();
    assert.equal(context.agent_id, 'alpha');
    const loaded = await bridge.call<{ status: string }>('list_operations');
    assert.equal(loaded.status, 'current');
  } finally {
    await bridge?.close();
    await lobby.close();
  }
});

/** Forwards to the broker; can drop the response to one request after the broker handled it. */
async function droppingProxy(targetPort: number) {
  const seen: string[] = [];
  let dropNext: string | undefined;
  const proxy = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`);
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: targetPort,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (answer) => {
          const body: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => body.push(chunk));
          answer.on('end', () => {
            if (dropNext === `${request.method} ${request.url}`) {
              // The broker committed; the caller never learns the outcome.
              dropNext = undefined;
              response.socket?.destroy();
              return;
            }
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            response.end(Buffer.concat(body));
          });
        },
      );
      upstream.on('error', () => response.socket?.destroy());
      upstream.end(Buffer.concat(chunks));
    });
  });
  proxy.on('upgrade', (request: IncomingMessage, socket, head) => {
    const upstream = netConnect(targetPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let n = 0; n < request.rawHeaders.length; n += 2)
        lines.push(`${request.rawHeaders[n]}: ${request.rawHeaders[n + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolveListen) => proxy.listen(0, '127.0.0.1', resolveListen));
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    drop(request: string) {
      dropNext = request;
    },
    close: async () => {
      proxy.closeAllConnections();
      await new Promise((resolveClose) => proxy.close(resolveClose));
    },
  };
}

test('an uncertain send across a broker restart is never replayed; its retry ID resolves it', async () => {
  const lobby = await brokerFixture();
  const proxy = await droppingProxy(lobby.port);
  const adapter = createClaudeServer(
    { url: proxy.url, token: (await lobby.provision('alpha')).token, hostSessionId: randomUUID() },
    { log: () => {}, reconnectBaseMs: 20 },
  );
  const host = new Client({ name: 'uncertain-host', version: '1.0.0' });
  const events: ChannelEvent[] = [];
  host.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
    }),
    ({ params }) => {
      events.push(params);
    },
  );
  try {
    await lobby.provision('beta');
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    const limit = Date.now() + 5000;
    while (!events.some((event) => event.meta.event_type === 'bootstrap')) {
      assert(Date.now() < limit, 'bootstrap');
      await sleep(10);
    }
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(events[0]!.content)![1];
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await host.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        text: (result.content as { text: string }[])[0]!.text,
      };
    };
    const context = JSON.parse((await call('get_context')).text) as AgentContext;
    await call('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });

    const send = {
      client_request_id: 'assignment-42',
      to: 'beta',
      kind: 'assignment',
      content: 'Deploy the fix',
    };
    proxy.drop('POST /v1/tools/send_message');
    const lost = await call('send_message', send);
    assert.equal(lost.isError, true);
    assert.match(
      lost.text,
      /\(network: connection_failed_or_timed_out\)\. The outcome is unknown and nothing was retried; retry a send only with the same client_request_id and arguments, and within a day:/,
    );
    // The broker restarts before anyone retries, as in a deploy.
    await lobby.stop();
    await lobby.start();
    await sleep(100);
    const sendsSoFar = proxy.seen.filter((line) => line === 'POST /v1/tools/send_message');
    assert.equal(sendsSoFar.length, 1, 'the bridge never resends on its own');
    const stored = await lobby.owner.request<Page<Message>>(
      'GET',
      '/v1/admin/agents/beta/messages?mode=pending',
    );
    assert.equal(stored.items.length, 1, 'the lost answer hid an accepted message');
    let retried: { isError: boolean; text: string } | undefined;
    const deadline = Date.now() + 5000;
    for (;;) {
      retried = await call('send_message', send);
      if (!retried.isError) break;
      assert(Date.now() < deadline, retried.text);
      await sleep(50);
    }
    const result = JSON.parse(retried.text) as StoredMessage;
    assert.deepEqual([result.duplicate, result.message.id], [true, stored.items[0]!.id]);
    const after = await lobby.owner.request<Page<Message>>(
      'GET',
      '/v1/admin/agents/beta/messages?mode=pending',
    );
    assert.equal(after.items.length, 1);
  } finally {
    await adapter.close();
    await host.close();
    await proxy.close();
    await lobby.close();
  }
});
