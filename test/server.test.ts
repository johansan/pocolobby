import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { startServer, wireEvent } from '../src/server.js';
import { PACKAGE_VERSION } from '../src/protocol.js';
import type {
  AgentContext,
  CancelResult,
  NotificationEvent,
  Page,
  Message,
  RuntimeBinding,
  ScheduledItems,
  StoredMessage,
  StoredSchedule,
} from '../src/protocol.js';
import { createLobby } from './lobby.js';

type HttpResult<T> = { status: number; data: T };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-http-'));
  const owner = randomBytes(32).toString('base64url');
  const options = {
    database: join(directory, 'lobby.db'),
    adminToken: owner,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: {
      infoDelayMs: 30,
      retryDelaysMs: [50, 100, 150],
      lateAfterMs: 100,
      receiptDelayMs: 20,
      receiptIntervalMs: 60,
    },
  };
  let server = await startServer(options);
  await createLobby(server.url, owner);
  let running = true;
  const connections: WebSocket[] = [];
  async function request<T = Record<string, unknown>>(
    method: string,
    path: string,
    token = owner,
    data?: unknown,
    runtime?: RuntimeBinding,
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (runtime)
      Object.assign(headers, {
        'x-pocolobby-runtime-id': runtime.runtime_id,
        'x-pocolobby-generation': String(runtime.generation),
        'x-pocolobby-incarnation': runtime.incarnation,
      });
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  async function agent(
    id: string,
    canBroadcast = false,
    scope: { lobby?: string; coordinator?: boolean } = {},
  ) {
    const provision = await request<{ token: string }>('POST', '/v1/admin/agents', owner, {
      agent_id: id,
      can_broadcast: canBroadcast,
      lobby_id: scope.lobby ?? 'my-team',
      manage_rooms: scope.coordinator ?? false,
    });
    assert.equal(provision.status, 201);
    const token = provision.data.token;
    const claim = await request<RuntimeBinding>('POST', '/v1/runtime', token, {
      runtime_id: randomUUID(),
    });
    assert.equal(claim.status, 200);
    return { id, token, runtime: claim.data };
  }
  async function connect(
    agent: { token: string; runtime: RuntimeBinding },
    extraHeaders: Record<string, string> = {},
  ) {
    const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/v1/events`, {
      headers: {
        authorization: `Bearer ${agent.token}`,
        'x-pocolobby-runtime-id': agent.runtime.runtime_id,
        'x-pocolobby-generation': String(agent.runtime.generation),
        'x-pocolobby-incarnation': agent.runtime.incarnation,
        'x-pocolobby-event-version': '5',
        ...extraHeaders,
      },
    });
    connections.push(socket);
    const received: NotificationEvent[] = [];
    /** Every event as sent, for checks against an adapter's schema. */
    const raw: unknown[] = [];
    let upgradeVersion: string | undefined;
    const waiters = new Set<() => void>();
    socket.on('upgrade', (response) => {
      upgradeVersion = response.headers['x-pocolobby-event-version'] as string | undefined;
    });
    socket.on('message', (data) => {
      raw.push(JSON.parse(data.toString()));
      received.push(JSON.parse(data.toString()) as NotificationEvent);
      for (const wake of waiters) wake();
    });
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    async function next(predicate: (event: NotificationEvent) => boolean) {
      return await new Promise<NotificationEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `Timed out waiting for notification; received types: ${received.map((x) => x.type).join(',')}`,
            ),
          );
        }, 2500);
        function check() {
          const index = received.findIndex(predicate);
          if (index >= 0) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(received.splice(index, 1)[0]!);
          }
        }
        waiters.add(check);
        check();
      });
    }
    return {
      socket,
      next,
      received,
      raw,
      get upgradeVersion() {
        return upgradeVersion;
      },
    };
  }
  async function ready(
    agent: { token: string; runtime: RuntimeBinding },
    stream: Awaited<ReturnType<typeof connect>>,
  ) {
    const event = await stream.next((value) => value.type === 'bootstrap');
    const context = await request<AgentContext>('GET', '/v1/context', agent.token);
    const result = await request(
      'POST',
      '/v1/ready',
      agent.token,
      { context_revision: context.data.checkpoint.revision, probe_nonce: event.probe_nonce },
      agent.runtime,
    );
    assert.equal(result.status, 200);
  }
  return {
    owner,
    request,
    agent,
    connect,
    ready,
    get url() {
      return server.url;
    },
    async restart() {
      await server.close();
      server = await startServer(options);
    },
    async stop() {
      running = false;
      await server.close();
    },
    async start() {
      server = await startServer(options);
      running = true;
    },
    async close() {
      for (const socket of connections) socket.terminate();
      if (running) await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('HTTP authentication and validation reject spoofed identities and private reads', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
    // HSTS only for a request that came over HTTPS through a proxy (Cloudflare's report, 2026-10-17).
    assert.equal((await fetch(`${f.url}/healthz`)).headers.get('strict-transport-security'), null);
    assert.equal(
      (await fetch(`${f.url}/healthz`, { headers: { 'x-forwarded-proto': 'https' } })).headers.get(
        'strict-transport-security',
      ),
      'max-age=31536000',
    );
    assert.equal((await fetch(`${f.url}/v1/agents`)).status, 401);
    assert.equal(
      (
        await fetch(`${f.url}/v1/agents`, {
          headers: { authorization: `Bearer ${f.owner}`, origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    const a = await f.agent('alpha');
    await f.agent('beta');
    assert.equal((await f.request('GET', '/v1/admin/agents', a.token)).status, 403);
    const message = { client_request_id: randomUUID(), to: 'beta', content: 'test' };
    assert.equal((await f.request('POST', '/v1/messages', a.token, message)).status, 409);
    assert.equal(
      (await f.request('POST', '/v1/messages', a.token, { ...message, from: 'owner' }, a.runtime))
        .status,
      400,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/messages',
          a.token,
          { ...message, content: 'x'.repeat(64 * 1024 + 1) },
          a.runtime,
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.request('POST', '/v1/messages', a.token, { ...message, to: '*' }, a.runtime)).status,
      403,
    );
    assert.equal((await f.request('GET', '/v1/messages?limit=-1', a.token)).status, 400);
    const agents = await f.request<{ agents: Record<string, unknown>[] }>(
      'GET',
      '/v1/agents',
      a.token,
    );
    assert.ok(agents.data.agents.every((value) => !('role' in value) && !('token' in value)));
  } finally {
    await f.close();
  }
});

test('an agent’s status line reports its plan usage without a runtime; the owner cannot', async () => {
  const f = await fixture();
  try {
    const a = await f.agent('alpha');
    const reading = {
      five_hour: { used_percentage: 38.4, resets_at: Math.floor(Date.now() / 1000) + 3_600 },
      account: 'johan@example.com',
      plan: 'max',
    };
    // The status line holds the credential but no runtime binding.
    const stored = await f.request('PUT', '/v1/usage', a.token, reading);
    assert.deepEqual([stored.status, stored.data], [200, { recorded: true }]);
    // The coordinator sees it in list_agents, for pacing the account.
    const listed = await f.request<{
      agents: { agent_id: string; usage: Record<string, unknown> }[];
    }>('GET', '/v1/agents', a.token);
    const usage = listed.data.agents.find((agent) => agent.agent_id === 'alpha')!.usage;
    assert.equal(usage.account, 'johan@example.com');
    assert.equal((usage.five_hour as { used_percentage: number }).used_percentage, 38.4);
    assert.equal((await f.request('PUT', '/v1/usage', f.owner, reading)).status, 403);
    assert.equal(
      (
        await f.request('PUT', '/v1/usage', a.token, {
          five_hour: { used_percentage: 150, resets_at: 1 },
        })
      ).status,
      400,
    );
    assert.equal((await f.request('PUT', '/v1/usage', a.token, { token: 'x' })).status, 400);
  } finally {
    await f.close();
  }
});

test('two agents use push, distinguish adapter receipt from seen, and recover seen work', async () => {
  const f = await fixture();
  try {
    const a = await f.agent('alpha');
    const b = await f.agent('beta');
    const stream = await f.connect(b);
    await f.ready(b, stream);
    const send = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      a.token,
      {
        client_request_id: randomUUID(),
        to: 'beta',
        content: 'Review commit abc123',
        priority: 'important',
      },
      a.runtime,
    );
    assert.equal(send.status, 200);
    const event = await stream.next((value) => value.type === 'inbox');
    assert.ok(event.messages.some((value) => value.id === send.data.message.id));
    stream.socket.send(
      JSON.stringify({ type: 'adapter_received', notification_id: event.notification_id }),
    );
    stream.socket.send(
      JSON.stringify({ type: 'notification_attempted', notification_id: event.notification_id }),
    );
    const pending = await f.request<Page<Message>>('GET', '/v1/messages', b.token);
    assert.equal(pending.data.items.length, 1);
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/acknowledgments',
          a.token,
          { message_ids: [send.data.message.id] },
          a.runtime,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/acknowledgments',
          b.token,
          { message_ids: [send.data.message.id] },
          b.runtime,
        )
      ).status,
      200,
    );
    const context = await f.request<AgentContext>('GET', '/v1/context', b.token);
    assert.equal(context.data.pending.items.length, 0);
    // Which broker answered, by the host the agent reached it at.
    assert.equal(context.data.broker?.version, PACKAGE_VERSION);
    assert.match(context.data.broker?.host ?? '', /^127\.0\.0\.1:\d+$/);
    assert.equal(context.data.reconciliation.items[0]?.id, send.data.message.id);
    assert.equal(
      (
        await f.request(
          'PUT',
          '/v1/checkpoint',
          b.token,
          {
            expected_revision: 0,
            content: 'Review unfinished: commit abc123',
            covered_receipt_seq: context.data.receipt_snapshot,
          },
          b.runtime,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          'PUT',
          '/v1/checkpoint',
          b.token,
          { expected_revision: 0, content: 'stale', covered_receipt_seq: 0 },
          b.runtime,
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test('broadcast acceptance survives broker restart with immutable membership and retry identity', async () => {
  const f = await fixture();
  try {
    const a = await f.agent('alpha', true);
    const b = await f.agent('beta');
    const input = {
      client_request_id: randomUUID(),
      to: '*',
      content: 'Release candidate ready',
      priority: 'important',
    };
    const first = await f.request<StoredMessage>('POST', '/v1/messages', a.token, input, a.runtime);
    assert.equal(first.status, 200);
    await f.agent('gamma');
    await f.restart();
    const retry = await f.request<StoredMessage>('POST', '/v1/messages', a.token, input, a.runtime);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.message.id, first.data.message.id);
    assert.deepEqual(retry.data.recipients, ['beta']);
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/messages',
          a.token,
          { ...input, content: 'Different intent' },
          a.runtime,
        )
      ).status,
      409,
    );
    const stream = await f.connect(b);
    await f.ready(b, stream);
    const event = await stream.next((value) => value.type === 'inbox');
    assert.equal(event.messages[0]?.id, first.data.message.id);
  } finally {
    await f.close();
  }
});

test('credential revocation closes active socket and runtime reset fences old writers', async () => {
  const f = await fixture();
  try {
    const a = await f.agent('alpha');
    await f.agent('beta');
    const stream = await f.connect(a);
    await f.ready(a, stream);
    const closed = new Promise<number>((resolve) =>
      stream.socket.once('close', (code) => resolve(code)),
    );
    const rotate = await f.request<{ token: string }>(
      'POST',
      '/v1/admin/agents/alpha/rotate',
      f.owner,
      {},
    );
    assert.equal(rotate.status, 200);
    assert.equal(await closed, 4401);
    assert.equal((await f.request('GET', '/v1/context', a.token)).status, 401);
    const send = { client_request_id: randomUUID(), to: 'beta', content: 'stale runtime' };
    assert.equal(
      (await f.request('POST', '/v1/messages', rotate.data.token, send, a.runtime)).status,
      409,
    );
    const claim = await f.request<RuntimeBinding>('POST', '/v1/runtime', rotate.data.token, {
      runtime_id: randomUUID(),
    });
    assert.equal(claim.status, 200);
    assert.equal(
      (await f.request('POST', '/v1/admin/agents/alpha/reset-runtime', f.owner, {})).status,
      200,
    );
    assert.equal(
      (await f.request('POST', '/v1/messages', rotate.data.token, send, claim.data)).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test('resuming a runtime closes the earlier socket and fences its writes and reconnects', async () => {
  const f = await fixture();
  try {
    const a = await f.agent('alpha');
    await f.agent('beta');
    const stream = await f.connect(a);
    await f.ready(a, stream);
    const closed = new Promise<number>((resolve) =>
      stream.socket.once('close', (code) => resolve(code)),
    );
    const resumed = await f.request<RuntimeBinding>('POST', '/v1/runtime', a.token, {
      runtime_id: a.runtime.runtime_id,
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.runtime_id, a.runtime.runtime_id);
    assert.equal(resumed.data.generation, a.runtime.generation + 1);
    assert.equal(resumed.data.ready, false);
    assert.equal(await closed, 4409);
    const send = { client_request_id: randomUUID(), to: 'beta', content: 'earlier process' };
    assert.equal((await f.request('POST', '/v1/messages', a.token, send, a.runtime)).status, 409);
    const reconnect = await f.request<{ error: { code: string } }>('POST', '/v1/runtime', a.token, {
      runtime_id: a.runtime.runtime_id,
      generation: a.runtime.generation,
    });
    assert.deepEqual([reconnect.status, reconnect.data.error.code], [409, 'stale_runtime']);
    const current = { ...a, runtime: resumed.data };
    await f.ready(current, await f.connect(current));
    assert.equal(
      (await f.request('POST', '/v1/messages', a.token, send, resumed.data)).status,
      200,
    );
    const other = await f.request<{ error: { code: string } }>('POST', '/v1/runtime', a.token, {
      runtime_id: randomUUID(),
    });
    assert.deepEqual([other.status, other.data.error.code], [409, 'runtime_conflict']);
  } finally {
    await f.close();
  }
});

test('a notification retry budget survives restarts and leaves pending work visible', async () => {
  const f = await fixture();
  try {
    const b = await f.agent('beta');
    let stream = await f.connect(b);
    await f.ready(b, stream);
    await f.request('POST', '/v1/messages', f.owner, {
      client_request_id: randomUUID(),
      to: 'beta',
      content: 'No model acknowledgment',
      priority: 'important',
    });
    await stream.next((value) => value.type === 'inbox');
    await f.restart();
    stream = await f.connect(b);
    await stream.next((value) => value.type === 'inbox');
    await stream.next((value) => value.type === 'inbox');
    const deadline = Date.now() + 2000;
    let attention = false;
    while (Date.now() < deadline) {
      const result = await f.request<{
        agents: { agent_id: string; notification_attention_required: boolean }[];
      }>('GET', '/v1/admin/agents');
      attention =
        result.data.agents.find((value) => value.agent_id === 'beta')
          ?.notification_attention_required ?? false;
      if (attention) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(attention, true);
    const pending = await f.request<Page<Message>>('GET', '/v1/messages', b.token);
    assert.equal(pending.data.items.length, 1);
    assert.equal((await f.request('POST', '/v1/admin/agents/beta/retry', f.owner, {})).status, 200);
    await stream.next((value) => value.type === 'inbox');
  } finally {
    await f.close();
  }
});

test('private lobbies isolate discovery, inboxes, runtime bindings and same-name agents', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request('POST', '/v1/admin/lobbies', f.owner, { lobby_id: 'another-project' }))
        .status,
      201,
    );
    const own = await f.agent('backend');
    const other = await f.agent('backend', false, { lobby: 'another-project' });
    const peer = await f.agent('coordinator', true);
    const listed = await f.request<{ agents: { agent_id: string; lobby_id: string }[] }>(
      'GET',
      '/v1/agents',
      own.token,
    );
    assert.deepEqual(
      listed.data.agents.map((a) => [a.lobby_id, a.agent_id]),
      [
        ['my-team', 'backend'],
        ['my-team', 'coordinator'],
      ],
    );
    assert.equal(
      (await f.request('GET', '/v1/agents?lobby=another-project', own.token)).status,
      403,
    );
    assert.equal((await f.request('GET', '/v1/admin/lobbies', own.token)).status, 403);
    assert.equal(
      (await f.request('POST', '/v1/runtime', own.token, { runtime_id: other.runtime.runtime_id }))
        .status,
      409,
    );
    const requestId = randomUUID();
    const foreign = await f.request<StoredMessage>(
      'POST',
      '/v1/messages?lobby=another-project',
      f.owner,
      { client_request_id: requestId, to: 'backend', content: 'Other private lobby' },
    );
    // With two lobbies, an owner request names one (0.8.3).
    const unnamed = await f.request<{ error: { code: string } }>('POST', '/v1/messages', f.owner, {
      client_request_id: requestId,
      to: 'backend',
      content: 'Own private lobby',
    });
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.data.error.code, 'lobby_required');
    const local = await f.request<StoredMessage>('POST', '/v1/messages?lobby=my-team', f.owner, {
      client_request_id: requestId,
      to: 'backend',
      content: 'Own private lobby',
    });
    assert.equal(foreign.status, 200);
    assert.equal(local.status, 200);
    assert.notEqual(foreign.data.message.id, local.data.message.id);
    const inbox = await f.request<Page<Message>>('GET', '/v1/messages', own.token);
    assert.deepEqual(
      inbox.data.items.map((m) => m.id),
      [local.data.message.id],
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/acknowledgments',
          own.token,
          { message_ids: [foreign.data.message.id] },
          own.runtime,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/messages',
          own.token,
          {
            client_request_id: randomUUID(),
            to: 'another-project/backend',
            content: 'Scope escape',
          },
          own.runtime,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/messages',
          own.token,
          {
            client_request_id: randomUUID(),
            to: 'coordinator',
            content: 'Leaked reply',
            reply_to: foreign.data.message.id,
          },
          own.runtime,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/messages',
          own.token,
          { client_request_id: randomUUID(), to: 'coordinator', content: 'Wrong binding' },
          other.runtime,
        )
      ).status,
      409,
    );
    const broadcast = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      peer.token,
      { client_request_id: randomUUID(), to: '*', content: 'Own team only' },
      peer.runtime,
    );
    assert.deepEqual(broadcast.data.recipients, ['backend']);
    const foreignInbox = await f.request<Page<Message>>('GET', '/v1/messages', other.token);
    assert.deepEqual(
      foreignInbox.data.items.map((m) => m.id),
      [foreign.data.message.id],
    );
  } finally {
    await f.close();
  }
});

test('coordinator manages shared rooms but cannot admit agents or cross the lobby boundary', async () => {
  const f = await fixture();
  try {
    const coordinator = await f.agent('coordinator', true, { coordinator: true });
    const app = await f.agent('app');
    const social = await f.agent('social');
    assert.equal(
      (await f.request('POST', '/v1/admin/lobbies', f.owner, { lobby_id: 'another-project' }))
        .status,
      201,
    );
    await f.agent('outsider', false, { lobby: 'another-project' });
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/rooms',
          coordinator.token,
          { room_id: 'app' },
          coordinator.runtime,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await f.request(
          'PUT',
          '/v1/rooms/app/members',
          coordinator.token,
          { members: ['coordinator', 'app'] },
          coordinator.runtime,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          'PUT',
          '/v1/rooms/app/members',
          coordinator.token,
          { members: ['outsider'] },
          coordinator.runtime,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          'PUT',
          '/v1/rooms/app/members?lobby=another-project',
          coordinator.token,
          { members: ['outsider'] },
          coordinator.runtime,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/v1/admin/agents',
          coordinator.token,
          { agent_id: 'uninvited' },
          coordinator.runtime,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          'PATCH',
          '/v1/admin/agents/app',
          coordinator.token,
          { manage_rooms: true },
          coordinator.runtime,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request('POST', '/v1/rooms', app.token, { room_id: 'self-authorized' }, app.runtime))
        .status,
      403,
    );
    const roomList = await f.request<{ rooms: { room_id: string; members: string[] }[] }>(
      'GET',
      '/v1/rooms',
      app.token,
    );
    assert.deepEqual(roomList.data.rooms[0]?.members, ['app', 'coordinator']);
    const socialList = await f.request<{ rooms: unknown[] }>('GET', '/v1/rooms', social.token);
    assert.deepEqual(socialList.data.rooms, []);
    const sent = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      app.token,
      { client_request_id: randomUUID(), to: '*', room: 'app', content: 'Shared app discussion' },
      app.runtime,
    );
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.data.recipients, ['coordinator']);
    assert.equal(sent.data.message.room_id, 'app');
    const socialSend = await f.request(
      'POST',
      '/v1/messages',
      social.token,
      { client_request_id: randomUUID(), to: '*', room: 'app', content: 'Uninvited room message' },
      social.runtime,
    );
    assert.equal(socialSend.status, 403);
    const history = await f.request<Page<Message>>(
      'GET',
      '/v1/messages?mode=history',
      social.token,
    );
    assert.deepEqual(history.data.items, []);
  } finally {
    await f.close();
  }
});

test('discovery hides disabled identities and shows when each agent last messaged', async () => {
  const f = await fixture();
  try {
    const luke = await f.agent('luke');
    const vader = await f.agent('vader');
    await f.agent('placeholder');
    assert.equal(
      (await f.request('PATCH', '/v1/admin/agents/placeholder', f.owner, { enabled: false }))
        .status,
      200,
    );
    // The removed status route is gone, and a message sets last_message_at for both ends.
    assert.equal(
      (await f.request('PUT', '/v1/status', luke.token, { state: 'working' }, luke.runtime)).status,
      404,
    );
    await f.request(
      'POST',
      '/v1/messages',
      luke.token,
      { client_request_id: randomUUID(), to: 'vader', content: 'Assignment 42 is done' },
      luke.runtime,
    );
    type Listed = { agent_id: string; enabled: boolean; last_message_at: string | null };
    const listed = await f.request<{ agents: Listed[] }>('GET', '/v1/agents', vader.token);
    assert.deepEqual(
      listed.data.agents.map((agent) => [agent.agent_id, typeof agent.last_message_at]),
      [
        ['luke', 'string'],
        ['vader', 'string'],
      ],
    );
    assert.ok(listed.data.agents.every((agent) => agent.enabled));
    const owner = await f.request<{ agents: Listed[] }>('GET', '/v1/agents', f.owner);
    assert.equal(owner.data.agents.length, 2);
    const admin = await f.request<{ agents: Listed[] }>('GET', '/v1/admin/agents', f.owner);
    assert.deepEqual(
      admin.data.agents.map((agent) => [
        agent.agent_id,
        agent.enabled,
        agent.last_message_at === null,
      ]),
      [
        ['luke', true, false],
        ['placeholder', false, true],
        ['vader', true, false],
      ],
    );
  } finally {
    await f.close();
  }
});

test('a bridge that declares an older event version, or none, is refused before it binds', async () => {
  const f = await fixture();
  try {
    const luke = await f.agent('luke');
    const upgrade = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${f.url.replace('http:', 'ws:')}/v1/events`, {
          headers: {
            authorization: `Bearer ${luke.token}`,
            'x-pocolobby-runtime-id': luke.runtime.runtime_id,
            'x-pocolobby-generation': String(luke.runtime.generation),
            'x-pocolobby-incarnation': luke.runtime.incarnation,
            ...headers,
          },
        });
        socket.on('unexpected-response', (_request, response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            assert.equal(
              JSON.parse(Buffer.concat(chunks).toString()).error.code,
              'bridge_outdated',
            );
            resolve(response.statusCode!);
            socket.terminate();
          });
        });
        socket.on('open', () => reject(new Error('An outdated bridge was admitted')));
        socket.on('error', () => {});
      });
    assert.equal(await upgrade({}), 426);
    assert.equal(await upgrade({ 'x-pocolobby-event-version': '4' }), 426);
    const future = await f.connect(luke, { 'x-pocolobby-event-version': '9' });
    assert.equal(future.upgradeVersion, '5');
  } finally {
    await f.close();
  }
});

test('pushes after five acknowledgments count 1, 2 and 3 pending, and senders see delivery', async () => {
  const f = await fixture();
  try {
    const vader = await f.agent('vader');
    const poco = await f.agent('poco');
    const stream = await f.connect(poco);
    await f.ready(poco, stream);
    const send = (content: string) =>
      f.request<StoredMessage>(
        'POST',
        '/v1/messages',
        vader.token,
        { client_request_id: randomUUID(), to: 'poco', content },
        vader.runtime,
      );
    for (const n of [1, 2, 3, 4, 5]) await send(`earlier ${n}`);
    const pending = await f.request<Page<Message>>('GET', '/v1/messages', poco.token);
    assert.equal(pending.data.items.length, 5);
    const ack = await f.request<{ receipt_snapshot: number }>(
      'POST',
      '/v1/acknowledgments',
      poco.token,
      { message_ids: pending.data.items.map((message) => message.id) },
      poco.runtime,
    );
    assert.equal(ack.data.receipt_snapshot, 5);
    const counts: number[] = [];
    let last: StoredMessage | undefined;
    for (const n of [1, 2, 3]) {
      last = (await send(`new ${n}`)).data;
      const id = last.message.id;
      const event = await stream.next(
        (value) => value.type === 'inbox' && value.messages.some((message) => message.id === id),
      );
      counts.push(event.pending_count);
    }
    assert.deepEqual(counts, [1, 2, 3]);
    assert.deepEqual(
      last!.deliveries.map((delivery) => [delivery.agent_id, delivery.delivery_state]),
      [['poco', 'pending']],
    );
    const history = await f.request<Page<Message>>('GET', '/v1/messages?mode=history', vader.token);
    assert.deepEqual(
      history.data.items.map((message) => message.deliveries?.[0]?.delivery_state),
      ['seen', 'seen', 'seen', 'seen', 'seen', 'pending', 'pending', 'pending'],
    );
    assert.ok(history.data.items.every((message) => message.deliveries?.[0]?.agent_id === 'poco'));
    const recipientView = await f.request<Page<Message>>(
      'GET',
      '/v1/messages?mode=history',
      poco.token,
    );
    assert.ok(recipientView.data.items.every((message) => message.deliveries === undefined));
  } finally {
    await f.close();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a scheduled note to self survives a broker restart and arrives marked late', async () => {
  const f = await fixture();
  try {
    const vader = await f.agent('vader');
    await f.ready(vader, await f.connect(vader));
    const deliverAt = new Date(Date.now() + 250).toISOString();
    const body = {
      client_request_id: 'morning-notice-0641',
      to: 'vader',
      kind: 'notice',
      content: 'Morning notice: read the overnight reports',
      deliver_at: deliverAt,
    };
    const sent = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      vader.token,
      body,
      vader.runtime,
    );
    assert.equal(sent.status, 200);
    assert.equal(sent.data.deliveries[0]?.delivery_state, 'scheduled');
    // The broker is down, as during a single-Machine deploy, when the message falls due.
    await f.stop();
    await sleep(500);
    await f.start();
    const stream = await f.connect(vader);
    const event = await stream.next(
      (value) =>
        value.type === 'inbox' &&
        value.messages.some((message) => message.id === sent.data.message.id),
    );
    assert.equal(event.truncated, false);
    const message = event.messages[0]!;
    assert.deepEqual(
      [message.deliver_at, message.late, message.kind, message.reply_expected],
      [deliverAt, true, 'notice', false],
    );
    const retry = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      vader.token,
      body,
      vader.runtime,
    );
    assert.deepEqual([retry.status, retry.data.duplicate], [200, true]);
  } finally {
    await f.close();
  }
});

test('schedule routes create, list and cancel under runtime fencing, with owner oversight', async () => {
  const f = await fixture();
  try {
    const vader = await f.agent('vader');
    const luke = await f.agent('luke');
    const body = {
      client_request_id: 'morning',
      to: 'vader',
      kind: 'notice',
      content: 'Morning notice',
      repeat: {
        time_zone: 'Europe/Stockholm',
        times: ['06:41'],
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      },
    };
    assert.equal((await f.request('POST', '/v1/schedules', vader.token, body)).status, 409);
    assert.equal((await f.request('POST', '/v1/schedules', f.owner, body)).status, 403);
    const created = await f.request<StoredSchedule>(
      'POST',
      '/v1/schedules',
      vader.token,
      body,
      vader.runtime,
    );
    assert.equal(created.status, 200);
    assert.match(
      created.data.schedule.next_occurrence_local!,
      /^(Mon|Tue|Wed|Thu|Fri) \d{4}-\d\d-\d\d 06:41 Europe\/Stockholm$/,
    );
    const retry = await f.request<StoredSchedule>(
      'POST',
      '/v1/schedules',
      vader.token,
      body,
      vader.runtime,
    );
    assert.deepEqual(
      [retry.data.duplicate, retry.data.schedule.schedule_id],
      [true, created.data.schedule.schedule_id],
    );
    const badZone = await f.request(
      'POST',
      '/v1/schedules',
      vader.token,
      { ...body, client_request_id: 'bad', repeat: { time_zone: 'Stockholm', times: ['06:41'] } },
      vader.runtime,
    );
    assert.equal(badZone.status, 400);
    const later = await f.request<StoredMessage>(
      'POST',
      '/v1/messages',
      vader.token,
      {
        client_request_id: randomUUID(),
        to: 'luke',
        content: 'Report after 06:40',
        deliver_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      vader.runtime,
    );
    const counts = (items: ScheduledItems) => [items.schedules.length, items.messages.length];
    const own = await f.request<ScheduledItems>('GET', '/v1/schedules', vader.token);
    assert.deepEqual(counts(own.data), [1, 1]);
    assert.equal(own.data.messages[0]?.recipients, 1);
    assert.deepEqual(
      counts((await f.request<ScheduledItems>('GET', '/v1/schedules', luke.token)).data),
      [0, 0],
    );
    const oversight = await f.request<ScheduledItems>(
      'GET',
      '/v1/admin/agents/vader/schedules',
      f.owner,
    );
    assert.deepEqual(counts(oversight.data), [1, 1]);
    assert.equal(
      (await f.request('GET', '/v1/admin/agents/vader/schedules', vader.token)).status,
      403,
    );
    const context = await f.request<AgentContext>('GET', '/v1/context', vader.token);
    assert.deepEqual(context.data.scheduled, { schedules: 1, messages: 1 });
    const id = created.data.schedule.schedule_id;
    assert.equal(
      (await f.request('POST', '/v1/schedules/cancel', luke.token, { id }, luke.runtime)).status,
      404,
    );
    const cancelled = await f.request<CancelResult>(
      'POST',
      '/v1/schedules/cancel',
      vader.token,
      { id },
      vader.runtime,
    );
    assert.deepEqual([cancelled.status, cancelled.data.cancelled], [200, 'schedule']);
    const ownerCancel = await f.request<CancelResult>(
      'POST',
      '/v1/admin/agents/vader/schedules/cancel',
      f.owner,
      { id: later.data.message.id },
    );
    assert.deepEqual([ownerCancel.status, ownerCancel.data.cancelled], [200, 'message']);
    assert.deepEqual(
      counts((await f.request<ScheduledItems>('GET', '/v1/schedules', vader.token)).data),
      [0, 0],
    );
  } finally {
    await f.close();
  }
});

test('a client that resets a rejected stream upgrade cannot crash the broker', async () => {
  const { connect } = await import('node:net');
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-upgrade-reset-'));
  const server = await startServer({
    database: join(directory, 'lobby.db'),
    adminToken: randomBytes(32).toString('base64url'),
    port: 0,
  });
  try {
    const port = Number(new URL(server.url).port);
    // Each upgrade is refused (unknown token) while the client resets the connection.
    for (let i = 0; i < 150; i++)
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            'GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
              `Authorization: Bearer ${'x'.repeat(40)}\r\n\r\n`,
          );
          setImmediate(() => {
            socket.resetAndDestroy();
            resolve();
          });
        });
        socket.on('error', () => resolve());
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the request budget belongs to each client behind a trusted proxy header', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-rate-'));
  const server = await startServer({
    database: join(directory, 'lobby.db'),
    adminToken: randomBytes(32).toString('base64url'),
    port: 0,
    board: { clientIpHeader: 'fly-client-ip' },
  });
  try {
    const hit = (client: string) =>
      fetch(`${server.url}/v1/agents`, { headers: { 'fly-client-ip': client } }).then(
        (r) => r.status,
      );
    // One client spends its whole minute; another behind the same proxy is unaffected.
    const statuses: number[] = [];
    for (let batch = 0; batch < 25; batch++)
      statuses.push(...(await Promise.all(Array.from({ length: 50 }, () => hit('203.0.113.7')))));
    assert.ok(statuses.includes(429));
    assert.equal(await hit('203.0.113.8'), 401);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a malformed escape in a path is the caller’s mistake, not a broker failure', async () => {
  const f = await fixture();
  try {
    for (const path of ['/v1/admin/agents/%E0%A4%A/context', '/v1/admin/rooms/%E0%A4%A'])
      for (const method of ['GET', 'DELETE']) {
        const response = await f.request(method, path);
        assert.notEqual(response.status, 500, `${method} ${path}`);
      }
  } finally {
    await f.close();
  }
});

test('a tool call whose body straddles a rotation or a disable is refused', async () => {
  const { request: httpRequest } = await import('node:http');
  const f = await fixture();
  try {
    for (const revoke of ['rotate', 'disable'] as const) {
      const alpha = await f.agent(`alpha-${revoke}`);
      const body = JSON.stringify({ arguments: { mode: 'pending' } });
      const response = new Promise<number>((resolve, reject) => {
        const call = httpRequest(`${f.url}/v1/tools/get_messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${alpha.token}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
        });
        call.on('response', (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        call.on('error', reject);
        // Half the body now; the credential is revoked before the rest arrives.
        call.write(body.slice(0, 10));
        setTimeout(async () => {
          const changed =
            revoke === 'rotate'
              ? await f.request('POST', `/v1/admin/agents/${alpha.id}/rotate`, f.owner, {})
              : await f.request('PATCH', `/v1/admin/agents/${alpha.id}`, f.owner, {
                  enabled: false,
                });
          assert.equal(changed.status, 200);
          call.end(body.slice(10));
        }, 50);
      });
      assert.equal(await response, 401, revoke);
    }
  } finally {
    await f.close();
  }
});

test('a room message to some members reaches old bridges as a room message with the names beside it', () => {
  const message = {
    id: randomUUID(),
    lobby_id: 'my-team',
    room_id: 'builders',
    sequence: 7,
    from: 'vader',
    to: '*',
    addressed_to: ['leia', 'luke'],
    priority: 'info' as const,
    content: 'Leia and Luke: check 77bb9f0',
    correlation_id: null,
    reply_to: null,
    created_at: new Date().toISOString(),
    kind: 'request' as const,
    reply_expected: true,
  };
  const event = wireEvent({
    type: 'inbox',
    notification_id: randomUUID(),
    agent_id: 'leia',
    lobby_id: 'my-team',
    runtime_id: randomUUID(),
    generation: 1,
    messages: [message],
    pending_count: 1,
    truncated: false,
  }) as { messages: Record<string, unknown>[] };
  const wire = event.messages[0]!;
  // 0.8.1 bridges validate to strictly and keep unknown fields only under extensions.
  assert.equal(wire.to, '*');
  assert.equal(Object.hasOwn(wire, 'addressed_to'), false);
  assert.deepEqual((wire.extensions as Record<string, unknown>).addressed_to, ['leia', 'luke']);
  const presentation = wire.presentation as { lead: string; guidance: { text: string }[] };
  assert.match(presentation.lead, /room message in room builders to leia, luke only/);
  assert.ok(presentation.guidance.some((line) => /only some of the room/.test(line.text)));
});

test('a new broker has no lobby, and an owner request that names none takes its only one', async () => {
  const adminToken = randomBytes(32).toString('base64url');
  const server = await startServer({ database: ':memory:', adminToken, port: 0 });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: { code: string } } & Record<string, unknown>;
    return { status: response.status, code: data.error?.code, data };
  };
  try {
    // With none, listing and creating lobbies work, and anything in a lobby asks for one.
    assert.deepEqual((await call('GET', '/v1/admin/lobbies')).data, { lobbies: [] });
    const agent = { agent_id: 'leia' };
    assert.deepEqual(
      [
        (await call('POST', '/v1/admin/agents', agent)).code,
        (await call('GET', '/v1/admin/agents')).code,
      ],
      ['lobby_required', 'lobby_required'],
    );
    // With one, a request without a lobby acts in it.
    assert.equal((await call('POST', '/v1/admin/lobbies', { lobby_id: 'my-team' })).status, 201);
    assert.equal((await call('POST', '/v1/admin/agents', agent)).status, 201);
    assert.deepEqual(
      ((await call('GET', '/v1/admin/agents')).data.agents as { lobby_id: string }[]).map(
        (row) => row.lobby_id,
      ),
      ['my-team'],
    );
    // With two, it names one: a named lobby, in the query or the body, still works.
    assert.equal((await call('POST', '/v1/admin/lobbies', { lobby_id: 'tokentek' })).status, 201);
    assert.equal((await call('GET', '/v1/admin/agents')).code, 'lobby_required');
    assert.equal(
      (await call('POST', '/v1/admin/agents', { agent_id: 'luke' })).code,
      'lobby_required',
    );
    assert.equal(
      (await call('POST', '/v1/admin/agents', { agent_id: 'luke', lobby_id: 'tokentek' })).status,
      201,
    );
    assert.equal(
      (
        await call('POST', '/v1/admin/agents?lobby=my-team', {
          agent_id: 'han',
          lobby_id: 'tokentek',
        })
      ).code,
      'lobby_mismatch',
    );
    assert.equal((await call('GET', '/v1/admin/agents?lobby=tokentek')).status, 200);
    assert.equal((await call('GET', '/v1/admin/lobbies')).status, 200);
  } finally {
    await server.close();
  }
});
