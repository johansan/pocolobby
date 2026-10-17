import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createClaudeServer } from '../src/adapters/claude.js';
import { LobbyClient, LobbyClientError } from '../src/client.js';
import { startServer } from '../src/server.js';
import type {
  AgentContext,
  CancelResult,
  Checkpoint,
  Message,
  Page,
  Room,
  ScheduledItems,
  StoredMessage,
  StoredSchedule,
} from '../src/protocol.js';
import { createLobby } from './lobby.js';

type ChannelEvent = { content: string; meta: Record<string, string> };
/** A push is a headline, then the JSON payload; message text stays inside the JSON. */
function push(content: string): { headline: string; payload: { messages: Message[] } } {
  const newline = content.indexOf('\n');
  assert(newline > 0, `Expected a push with a payload: ${content}`);
  return {
    headline: content.slice(0, newline),
    payload: JSON.parse(content.slice(newline + 1)) as { messages: Message[] },
  };
}

test('real broker and Claude adapter bootstrap, push and explicitly acknowledge without model calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-adapter-integration-'));
  const adminToken = randomBytes(32).toString('base64url');
  const broker = await startServer({
    database: join(directory, 'lobby.db'),
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { retryDelaysMs: [500, 1000, 2000] },
  });
  await createLobby(broker.url, adminToken);
  const owner = new LobbyClient({ url: broker.url, token: adminToken });
  const provision = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
    agent_id: 'backend',
    role: 'Maintain the backend. Preserve unfinished work in checkpoints.',
  });
  const adapter = createClaudeServer(
    { url: broker.url, token: provision.token },
    { log: () => {} },
  );
  const host = new Client({ name: 'integration-host', version: '1.0.0' });
  const notifications: { content: string; meta: Record<string, string> }[] = [];
  const listeners = new Set<() => void>();
  host.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
    }),
    (event) => {
      notifications.push(event.params);
      for (const listener of listeners) listener();
    },
  );
  async function next(type: string) {
    return await new Promise<{ content: string; meta: Record<string, string> }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Missing ${type} notification`));
        }, 3000);
        function check() {
          const event = notifications.find((value) => value.meta.event_type === type);
          if (event) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(event);
          }
        }
        listeners.add(check);
        check();
      },
    );
  }
  async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await host.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `Tool ${name} rejected its arguments`);
    const content = result.content as { type: string; text?: string }[];
    assert.equal(content[0]?.type, 'text');
    return JSON.parse(content[0]!.text!) as T;
  }
  try {
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    const bootstrap = await next('bootstrap');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(bootstrap.content)?.[1];
    assert(nonce, 'Bootstrap channel must carry a nonce the host can echo');
    const initial = await tool<AgentContext>('get_context');
    assert.equal(initial.agent_id, 'backend');
    assert.equal(initial.lobby_id, 'my-team');
    assert.match(initial.role, /backend/);
    assert.equal(initial.checkpoint.revision, 0);
    assert.deepEqual(
      await tool('ready', { context_revision: initial.checkpoint.revision, probe_nonce: nonce }),
      { ready: true },
    );

    const sent = await owner.request<StoredMessage>('POST', '/v1/messages', {
      client_request_id: randomUUID(),
      to: 'backend',
      priority: 'important',
      content: 'Review commit abc123; retain the result.',
    });
    const inbox = await next('inbox');
    const { headline, payload } = push(inbox.content);
    assert.equal(payload.messages[0]?.id, sent.message.id);
    assert.equal(payload.messages[0]?.from, 'owner');
    // Sent without a kind, so the push claims no reply expectation.
    assert.match(headline, /^PocoLobby IMPORTANT direct message from owner\. /);
    assert.deepEqual(
      [inbox.meta.priority, inbox.meta.scope, inbox.meta.from, inbox.meta.room_id],
      ['important', 'direct', 'owner', undefined],
    );

    const pendingBeforeAck = await owner.request<Page<Message>>(
      'GET',
      '/v1/admin/agents/backend/messages?mode=pending',
    );
    assert.equal(
      pendingBeforeAck.items[0]?.id,
      sent.message.id,
      'Transport receipts must not mark the message seen',
    );
    await tool('acknowledge_messages', { message_ids: [sent.message.id] });
    const context = await tool<AgentContext>('get_context');
    assert.equal(context.pending.items.length, 0);
    assert.equal(context.reconciliation.items[0]?.id, sent.message.id);
    assert.equal(context.receipt_snapshot, 1);
    const checkpoint = await tool<Checkpoint>('save_checkpoint', {
      expected_revision: 0,
      content: `Review still unfinished: ${sent.message.id}`,
      covered_receipt_seq: context.receipt_snapshot,
    });
    assert.equal(checkpoint.revision, 1);
    const history = await tool<Page<Message>>('get_messages', { mode: 'history' });
    assert.equal(history.items[0]?.id, sent.message.id);
    assert(history.items[0]?.agent_seen_at);
  } finally {
    await adapter.close();
    await host.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('coordinator room tools are lobby-scoped while admissions remain owner-only', async () => {
  const adminToken = randomBytes(32).toString('base64url');
  const broker = await startServer({
    database: ':memory:',
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
  });
  await createLobby(broker.url, adminToken);
  const owner = new LobbyClient({ url: broker.url, token: adminToken });
  const sessions: { adapter: ReturnType<typeof createClaudeServer>; host: Client }[] = [];
  const credentials = new Map<string, string>();
  async function session(token: string) {
    const adapter = createClaudeServer({ url: broker.url, token }, { log: () => {} });
    const host = new Client({ name: 'room-test-host', version: '1.0.0' });
    sessions.push({ adapter, host });
    const events: { content: string; meta: Record<string, string> }[] = [];
    const listeners = new Set<() => void>();
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      (notification) => {
        events.push(notification.params);
        for (const listener of listeners) listener();
      },
    );
    async function next(predicate: (event: (typeof events)[number]) => boolean) {
      return await new Promise<(typeof events)[number]>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error('Room test notification timed out'));
        }, 3000);
        function check() {
          const event = events.find(predicate);
          if (event) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(event);
          }
        }
        listeners.add(check);
        check();
      });
    }
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await host.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text) as T;
    }
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    const bootstrap = await next((event) => event.meta.event_type === 'bootstrap');
    const context = await call<AgentContext>('get_context');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(bootstrap.content)?.[1];
    assert(nonce);
    await call('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
    return { host, call, next };
  }
  try {
    await owner.request('POST', '/v1/admin/lobbies', { lobby_id: 'other' });
    for (const id of ['coordinator', 'backend', 'frontend', 'qa', 'marketer']) {
      const provision = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
        agent_id: id,
        lobby_id: 'my-team',
        manage_rooms: id === 'coordinator',
        can_broadcast: id === 'coordinator',
      });
      credentials.set(id, provision.token);
    }
    const outsider = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
      agent_id: 'outsider',
      lobby_id: 'other',
    });
    // A retired placeholder stays in the owner's listing but not in agent discovery.
    await owner.request('POST', '/v1/admin/agents', { agent_id: 'retired', lobby_id: 'my-team' });
    await owner.request('PATCH', '/v1/admin/agents/retired?lobby=my-team', { enabled: false });
    const coordinator = await session(credentials.get('coordinator')!);
    const backend = await session(credentials.get('backend')!);
    const scopedClient = new LobbyClient({
      url: broker.url,
      token: credentials.get('coordinator')!,
    });
    const outsidersClient = new LobbyClient({ url: broker.url, token: outsider.token });
    for (const room of ['app', 'social', 'web']) {
      const created = await coordinator.call<Room>('create_room', { room_id: room });
      assert.equal(created.lobby_id, 'my-team');
      assert.equal(created.room_id, room);
    }
    const members = ['coordinator', 'backend', 'frontend', 'qa'];
    const app = await coordinator.call<Room>('set_room_members', { room_id: 'app', members });
    assert.deepEqual([...app.members].sort(), [...members].sort());
    await coordinator.call('set_room_members', {
      room_id: 'social',
      members: ['coordinator', 'marketer'],
    });
    const managerRooms = await coordinator.call<{ rooms: Room[] }>('list_rooms');
    assert.deepEqual(
      managerRooms.rooms.map((room) => room.room_id),
      ['app', 'social', 'web'],
    );
    const workerRooms = await backend.call<{ rooms: Room[] }>('list_rooms');
    assert.deepEqual(
      workerRooms.rooms.map((room) => room.room_id),
      ['app'],
    );
    await backend.call('set_owner_requests', { count: 1, text: 'Approve the app review' });
    const agents = await coordinator.call<{
      agents: {
        agent_id: string;
        lobby_id: string;
        owner_requests: { count: number; text: string } | null;
        last_message_at: string | null;
      }[];
    }>('list_agents');
    assert.equal(agents.agents.length, 5);
    assert(agents.agents.every((agent) => agent.lobby_id === 'my-team'));
    assert(!agents.agents.some((agent) => ['outsider', 'retired'].includes(agent.agent_id)));
    const backend_ = agents.agents.find((agent) => agent.agent_id === 'backend')!;
    assert.deepEqual(
      [backend_.owner_requests?.count, backend_.owner_requests?.text],
      [1, 'Approve the app review'],
    );
    const qa = agents.agents.find((agent) => agent.agent_id === 'qa')!;
    assert.deepEqual([qa.owner_requests, qa.last_message_at], [null, null]);
    const adminAgents = await owner.request<{ agents: { agent_id: string }[] }>(
      'GET',
      '/v1/admin/agents?lobby=my-team',
    );
    assert(adminAgents.agents.some((agent) => agent.agent_id === 'retired'));
    assert.equal(
      (await backend.host.callTool({ name: 'create_room', arguments: { room_id: 'unauthorized' } }))
        .isError,
      true,
    );
    assert.equal(
      (
        await coordinator.host.callTool({
          name: 'set_room_members',
          arguments: { room_id: 'app', members: ['coordinator', 'outsider'] },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await coordinator.host.callTool({
          name: 'send_message',
          arguments: {
            to: 'outsider',
            content: 'Cross lobby attempt',
            client_request_id: randomUUID(),
          },
        })
      ).isError,
      true,
    );
    await assert.rejects(
      scopedClient.request('POST', '/v1/admin/agents', { agent_id: 'uninvited' }),
      (error: unknown) => error instanceof LobbyClientError && error.status === 403,
    );
    await assert.rejects(
      scopedClient.request('GET', '/v1/rooms?lobby=other'),
      (error: unknown) => error instanceof LobbyClientError && error.status === 403,
    );
    assert.deepEqual(
      (await outsidersClient.request<{ rooms: Room[] }>('GET', '/v1/rooms')).rooms,
      [],
    );

    const roomSend = await coordinator.call<StoredMessage>('send_room_message', {
      room: 'app',
      client_request_id: randomUUID(),
      priority: 'important',
      content: 'App review only.',
    });
    assert.deepEqual([...roomSend.recipients].sort(), ['backend', 'frontend', 'qa']);
    assert.equal(roomSend.message.lobby_id, 'my-team');
    assert.equal(roomSend.message.room_id, 'app');
    const delivered = await backend.next(
      (event) => event.meta.event_type === 'inbox' && event.content.includes(roomSend.message.id),
    );
    assert.equal(delivered.meta.lobby_id, 'my-team');
    assert.deepEqual(
      [delivered.meta.room_id, delivered.meta.scope, delivered.meta.priority, delivered.meta.from],
      ['app', 'room', 'important', 'coordinator'],
    );
    const roomPush = push(delivered.content);
    assert.match(
      roomPush.headline,
      /^PocoLobby IMPORTANT room message in room app from coordinator\./,
    );
    assert.equal(roomPush.payload.messages[0]?.room_id, 'app');
    // The coordinator sees each room recipient's state for the message it sent. Only
    // backend runs an adapter, so only its notice reached a host.
    const roomFacts = async () =>
      (await coordinator.call<Page<Message>>('get_messages', { mode: 'history' })).items.find(
        (item) => item.id === roomSend.message.id,
      )?.deliveries ?? [];
    const limit = Date.now() + 3000;
    while (!(await roomFacts())[0]?.notification_attempted_at) {
      assert(Date.now() < limit, 'The host write receipt should reach the broker');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      (await roomFacts()).map((delivery) => [
        delivery.agent_id,
        delivery.delivery_state,
        delivery.notification_attempted_at !== null,
      ]),
      [
        ['backend', 'pending', true],
        ['frontend', 'pending', false],
        ['qa', 'pending', false],
      ],
    );
    // Backend sees its own receipt for the room message, not the other members'.
    const backendView = await backend.call<Page<Message>>('get_messages', { mode: 'history' });
    assert.equal(backendView.items[0]?.deliveries, undefined);
    const otherInbox = await outsidersClient.request<Page<Message>>('GET', '/v1/messages');
    assert.equal(otherInbox.items.length, 0);

    // Revocation cannot recall an already emitted channel event, but future
    // inbox reads/receipts must respect the held delivery and not replay it.
    await coordinator.call('set_room_members', {
      room_id: 'app',
      members: ['coordinator', 'frontend', 'qa'],
    });
    const heldHistory = await backend.call<Page<Message>>('get_messages', { mode: 'history' });
    assert.equal(heldHistory.items[0]?.delivery_state, 'held');
    assert.equal(heldHistory.items[0]?.content, '[Held: room membership revoked]');
    assert.equal((await roomFacts())[0]?.delivery_state, 'held');
    // Acknowledging it records nothing and refuses nothing, so the rest of a batch still counts.
    assert.notEqual(
      (
        await backend.host.callTool({
          name: 'acknowledge_messages',
          arguments: { message_ids: [roomSend.message.id] },
        })
      ).isError,
      true,
    );
    assert.equal((await roomFacts())[0]?.delivery_state, 'held');
    await coordinator.call('set_room_members', { room_id: 'app', members });
    assert.equal(
      (await backend.call<Page<Message>>('get_messages', { mode: 'pending' })).items.length,
      0,
    );
    const wholeLobby = await coordinator.call<StoredMessage>('broadcast', {
      client_request_id: randomUUID(),
      content: 'Lobby-wide information',
    });
    assert.equal(wholeLobby.message.room_id, null);
    assert.deepEqual([...wholeLobby.recipients].sort(), ['backend', 'frontend', 'marketer', 'qa']);
  } finally {
    for (const { adapter, host } of sessions) {
      await adapter.close();
      await host.close();
    }
    await broker.close();
  }
});

test('a resumed conversation reclaims its runtime after an adapter restart; another conversation still needs the owner', async () => {
  const adminToken = randomBytes(32).toString('base64url');
  const broker = await startServer({
    database: ':memory:',
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
  });
  await createLobby(broker.url, adminToken);
  const owner = new LobbyClient({ url: broker.url, token: adminToken });
  const sessions: { adapter: ReturnType<typeof createClaudeServer>; host: Client }[] = [];
  type Context = AgentContext & { runtime_scope: string };
  // Each launch is a new adapter process started by the host for one conversation.
  async function launch(token: string, hostSessionId: string) {
    const adapter = createClaudeServer(
      { url: broker.url, token, hostSessionId },
      { log: () => {}, reconnectBaseMs: 10 },
    );
    const host = new Client({ name: 'restart-test-host', version: '1.0.0' });
    sessions.push({ adapter, host });
    const nonces: string[] = [];
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      (notification) => {
        const nonce = /probe_nonce ([a-f0-9-]+)/.exec(notification.params.content)?.[1];
        if (notification.params.meta.event_type === 'bootstrap' && nonce) nonces.push(nonce);
      },
    );
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await host.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text) as T;
    }
    async function ready(): Promise<Context> {
      const limit = Date.now() + 3000;
      while (!nonces.length) {
        if (Date.now() > limit) throw new Error('Restart test bootstrap timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const context = await call<Context>('get_context');
      await call('ready', {
        context_revision: context.checkpoint.revision,
        probe_nonce: nonces[0],
      });
      return context;
    }
    async function rejected(pattern: RegExp): Promise<void> {
      const limit = Date.now() + 3000;
      for (;;) {
        const result = await host.callTool({ name: 'list_agents', arguments: {} });
        const text = (result.content as { text: string }[])[0]!.text;
        if (result.isError && pattern.test(text)) return;
        if (Date.now() > limit) throw new Error(`Expected ${pattern} but received ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    return {
      call,
      ready,
      rejected,
      async stop() {
        await adapter.close();
        await host.close();
      },
    };
  }
  try {
    const { token } = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
      agent_id: 'backend',
    });
    await owner.request('POST', '/v1/admin/agents', { agent_id: 'coordinator' });
    const conversation = randomUUID();
    const first = await launch(token, conversation);
    const before = await first.ready();
    assert.equal(before.runtime_scope, 'conversation');
    const hello = {
      client_request_id: `hello:backend:${before.runtime_id}`,
      to: 'coordinator',
      content: 'Hello from backend.',
    };
    const greeted = await first.call<StoredMessage>('send_message', hello);
    await first.stop();

    // Restarting the adapter for the same conversation needs no owner action and keeps
    // the Hello retry key, so the greeting is deduplicated rather than repeated.
    const resumed = await launch(token, conversation);
    const after = await resumed.ready();
    assert.equal(after.runtime_id, before.runtime_id);
    const again = await resumed.call<StoredMessage>('send_message', hello);
    assert.equal(again.duplicate, true);
    assert.equal(again.message.id, greeted.message.id);

    // A second process for the same conversation fences the earlier one.
    const duplicate = await launch(token, conversation);
    await duplicate.ready();
    await resumed.rejected(/resumed by a newer process of this conversation \(4409\)/);

    const other = await launch(token, randomUUID());
    await other.rejected(/another conversation holds this agent identity/);
    await duplicate.stop();
    await owner.request('POST', '/v1/admin/agents/backend/reset-runtime', {});
    const retired = await launch(token, conversation);
    await retired.rejected(/retired by the owner/);
    const replacement = await launch(token, randomUUID());
    const fresh = await replacement.ready();
    assert.notEqual(fresh.runtime_id, before.runtime_id);
  } finally {
    for (const { adapter, host } of sessions) {
      await adapter.close();
      await host.close();
    }
    await broker.close();
  }
});

test('notices queued during a busy tool flush as pushes without a stale count or a duplicate notice', async () => {
  // Reproduces two live reports. Lando: a tool ran while two messages arrived, and Claude then
  // showed push 1, a generic "1 pending" retry for that message, and push 2 saying 2 pending.
  // Poco: after acknowledging 5 messages, pushes for 3 new ones said 6, 7 and 8 pending.
  // The simulated host records events the way Claude shows them after the tool returns.
  const adminToken = randomBytes(32).toString('base64url');
  const broker = await startServer({
    database: ':memory:',
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [300, 600, 900] },
  });
  await createLobby(broker.url, adminToken);
  const owner = new LobbyClient({ url: broker.url, token: adminToken });
  const sessions: { adapter: ReturnType<typeof createClaudeServer>; host: Client }[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function session(agentId: string) {
    const { token } = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
      agent_id: agentId,
    });
    const adapter = createClaudeServer({ url: broker.url, token }, { log: () => {} });
    const host = new Client({ name: `busy-${agentId}`, version: '1.0.0' });
    sessions.push({ adapter, host });
    const events: ChannelEvent[] = [];
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      (notification) => {
        events.push(notification.params);
      },
    );
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await host.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
    }
    async function until(predicate: () => boolean, what: string) {
      const limit = Date.now() + 3000;
      while (!predicate()) {
        assert(Date.now() < limit, `Timed out waiting for ${what}`);
        await sleep(5);
      }
    }
    const pushed = (id: string) => events.some((event) => event.content.includes(id));
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    await until(() => events.some((event) => event.meta.event_type === 'bootstrap'), 'bootstrap');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(events[0]!.content)?.[1];
    const context = await call<AgentContext>('get_context');
    await call('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
    const inbox = () => events.filter((event) => event.meta.event_type === 'inbox');
    return { call, until, pushed, inbox };
  }
  const send = (to: string, content: string) =>
    owner.request<StoredMessage>('POST', '/v1/messages', {
      client_request_id: randomUUID(),
      to,
      content,
    });
  try {
    const lando = await session('lando');
    const first = await send('lando', 'First, while a tool runs');
    await lando.until(() => lando.pushed(first.message.id), 'the first push');
    await sleep(450); // Past the first retry delay, as during a long tool call.
    const second = await send('lando', 'Second, while the same tool runs');
    await lando.until(() => lando.pushed(second.message.id), 'the second push');
    await sleep(350);
    const flushed = lando.inbox();
    assert.deepEqual(
      flushed.map((event) => push(event.content).payload.messages.map((message) => message.id)),
      [[first.message.id], [second.message.id]],
      'Only the two pushes, with no payload-less notice between them',
    );
    for (const event of flushed) {
      assert.match(event.content, /^PocoLobby direct message from owner\. /);
      assert(!event.content.includes('pending_count'));
    }

    const vader = await session('vader');
    const poco = await session('poco');
    const vaderSend = (content: string) =>
      vader.call<StoredMessage>('send_message', {
        to: 'poco',
        content,
        client_request_id: randomUUID(),
      });
    const earlier: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) earlier.push((await vaderSend(`earlier ${n}`)).message.id);
    await poco.until(() => earlier.every(poco.pushed), 'the earlier pushes');
    const read = await poco.call<Page<Message>>('get_messages', { mode: 'pending' });
    assert.equal(read.items.length, 5);
    const receipt = await poco.call<{ receipt_snapshot: number }>('acknowledge_messages', {
      message_ids: earlier,
    });
    assert.equal(receipt.receipt_snapshot, 5);
    const later: string[] = [];
    for (const n of [1, 2, 3]) {
      const sent = await vaderSend(`new ${n}`);
      assert.deepEqual(
        sent.deliveries.map((delivery) => [delivery.agent_id, delivery.delivery_state]),
        [['poco', 'pending']],
      );
      later.push(sent.message.id);
      await poco.until(() => poco.pushed(sent.message.id), `new push ${n}`);
    }
    const newPushes = poco
      .inbox()
      .filter((event) => later.some((id) => event.content.includes(id)));
    assert.equal(newPushes.length, 3);
    for (const event of newPushes) assert(!/pending_count|[678] pending/.test(event.content));
    const status = await owner.request<{ agents: { agent_id: string; pending_count: number }[] }>(
      'GET',
      '/v1/admin/agents',
    );
    assert.equal(status.agents.find((agent) => agent.agent_id === 'poco')?.pending_count, 3);

    // "Did poco see the assignment?" Vader's own history answers per message.
    const limit = Date.now() + 3000;
    let facts: [string, string, boolean][] = [];
    for (;;) {
      const history = await vader.call<Page<Message>>('get_messages', { mode: 'history' });
      facts = history.items.map((item) => [
        item.content,
        item.deliveries![0]!.delivery_state,
        item.deliveries![0]!.notification_attempted_at !== null,
      ]);
      if (facts.every(([, , notified]) => notified) || Date.now() > limit) break;
      await sleep(5);
    }
    assert.deepEqual(facts, [
      ['earlier 1', 'seen', true],
      ['earlier 2', 'seen', true],
      ['earlier 3', 'seen', true],
      ['earlier 4', 'seen', true],
      ['earlier 5', 'seen', true],
      ['new 1', 'pending', true],
      ['new 2', 'pending', true],
      ['new 3', 'pending', true],
    ]);
  } finally {
    for (const { adapter, host } of sessions) {
      await adapter.close();
      await host.close();
    }
    await broker.close();
  }
});

test('kinds, scheduled delivery, schedules and read receipts work through real adapters', async () => {
  const adminToken = randomBytes(32).toString('base64url');
  const broker = await startServer({
    database: ':memory:',
    adminToken,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { infoDelayMs: 0, receiptDelayMs: 30, receiptIntervalMs: 100 },
  });
  await createLobby(broker.url, adminToken);
  const owner = new LobbyClient({ url: broker.url, token: adminToken });
  const sessions: { adapter: ReturnType<typeof createClaudeServer>; host: Client }[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function session(agentId: string) {
    const { token } = await owner.request<{ token: string }>('POST', '/v1/admin/agents', {
      agent_id: agentId,
    });
    const adapter = createClaudeServer({ url: broker.url, token }, { log: () => {} });
    const host = new Client({ name: `features-${agentId}`, version: '1.0.0' });
    sessions.push({ adapter, host });
    const events: ChannelEvent[] = [];
    host.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      (notification) => {
        events.push(notification.params);
      },
    );
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await host.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
    }
    async function next(predicate: (event: ChannelEvent) => boolean, what: string) {
      const limit = Date.now() + 3000;
      for (;;) {
        const event = events.find(predicate);
        if (event) return event;
        assert(Date.now() < limit, `Timed out waiting for ${what}`);
        await sleep(5);
      }
    }
    const [hostTransport, adapterTransport] = InMemoryTransport.createLinkedPair();
    await adapter.server.connect(adapterTransport);
    await host.connect(hostTransport);
    await adapter.start();
    const bootstrap = await next((event) => event.meta.event_type === 'bootstrap', 'bootstrap');
    const nonce = /probe_nonce ([a-f0-9-]+)/.exec(bootstrap.content)?.[1];
    const context = await call<AgentContext>('get_context');
    await call('ready', { context_revision: context.checkpoint.revision, probe_nonce: nonce });
    return { call, next, events };
  }
  try {
    const vader = await session('vader');
    const luke = await session('luke');

    // An assignment that asks for a read receipt, and an FYI notice in return.
    const assignment = await vader.call<StoredMessage>('send_message', {
      to: 'luke',
      client_request_id: randomUUID(),
      kind: 'assignment',
      content: 'Fix the login bug',
      commit: 'abc1234',
      files: ['src/login.ts'],
      notify_when_seen: true,
    });
    const delivered = await luke.next(
      (event) => event.content.includes(assignment.message.id),
      'the assignment',
    );
    assert.match(
      push(delivered.content).headline,
      /^PocoLobby assignment from vader \(reply expected\): direct message\. /,
    );
    assert.deepEqual([delivered.meta.kind, delivered.meta.reply_expected], ['assignment', 'true']);
    assert.deepEqual(push(delivered.content).payload.messages[0]!.files, ['src/login.ts']);
    await luke.call('acknowledge_messages', { message_ids: [assignment.message.id] });
    const receipt = await vader.next(
      (event) => event.meta.event_type === 'receipts',
      'the read receipt',
    );
    assert.match(
      receipt.content,
      new RegExp(
        `^PocoLobby read receipts: luke saw your assignment \\(${assignment.message.id}\\) at `,
      ),
    );
    const notice = await luke.call<StoredMessage>('send_message', {
      to: 'vader',
      client_request_id: randomUUID(),
      kind: 'notice',
      content: 'Started on the login bug',
      reply_to: assignment.message.id,
    });
    const fyi = await vader.next(
      (event) => event.content.includes(notice.message.id),
      'the notice',
    );
    assert.match(
      push(fyi.content).headline,
      /^PocoLobby notice from luke \(no reply expected\): direct message\. No reply expected: /,
    );
    // Receipts are not inbox work: Vader's pending inbox holds only the notice.
    const pending = await vader.call<Page<Message>>('get_messages', { mode: 'pending' });
    assert.deepEqual(
      pending.items.map((item) => item.id),
      [notice.message.id],
    );

    // A note to self for later, delivered by the broker at its time.
    const reminder = await vader.call<StoredMessage>('send_message', {
      to: 'vader',
      client_request_id: randomUUID(),
      kind: 'notice',
      content: 'Check whether Luke reported',
      deliver_at: new Date(Date.now() + 300).toISOString(),
    });
    assert.equal(reminder.deliveries[0]?.delivery_state, 'scheduled');
    const listed = await vader.call<ScheduledItems>('list_scheduled');
    assert.deepEqual(
      listed.messages.map((item) => item.id),
      [reminder.message.id],
    );
    const due = await vader.next(
      (event) => event.content.includes(reminder.message.id),
      'the scheduled reminder',
    );
    assert.match(push(due.content).headline, /, scheduled for \S+Z\. /);

    // A daily schedule, listed and cancelled.
    const created = await vader.call<StoredSchedule>('schedule_message', {
      client_request_id: 'morning-notice',
      to: 'vader',
      kind: 'notice',
      content: 'Morning notice',
      repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'] },
    });
    assert.match(created.schedule.next_occurrence_local!, / 06:41 Europe\/Stockholm$/);
    const scheduled = await vader.call<ScheduledItems>('list_scheduled');
    assert.deepEqual(
      scheduled.schedules.map((item) => item.schedule_id),
      [created.schedule.schedule_id],
    );
    const cancelled = await vader.call<CancelResult>('cancel_scheduled', {
      id: created.schedule.schedule_id,
    });
    assert.equal(cancelled.cancelled, 'schedule');
    assert.deepEqual(await vader.call<ScheduledItems>('list_scheduled'), {
      schedules: [],
      messages: [],
    });
  } finally {
    for (const { adapter, host } of sessions) {
      await adapter.close();
      await host.close();
    }
    await broker.close();
  }
});
