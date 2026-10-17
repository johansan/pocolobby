import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ZodError } from 'zod';
import { backupDatabase, LobbyStore, SCHEMA_VERSION } from '../src/store.js';
import { tokenHash } from '../src/auth.js';
import {
  LobbyError,
  MAX_PAGE_BYTES,
  MIN_PUSH_BYTES,
  parsePrincipal,
  qualifyAgent,
  type SendInput,
} from '../src/protocol.js';
import { temporaryFolder } from './temp.js';

const LOBBY = 'my-team';
/** An agent's principal in LOBBY, for tests where a second lobby makes bare names ambiguous. */
const inLobby = (name: string) => qualifyAgent(LOBBY, name);
const rejectsCode = (code: string) => (error: unknown) =>
  error instanceof LobbyError && error.code === code;
const provision = (store: LobbyStore, id: string, extra = {}) =>
  store.provision({
    agent_id: id,
    lobby_id: LOBBY,
    role: `${id} role`,
    can_broadcast: false,
    allowed_recipients: null,
    ...extra,
  });
const command = (to: string, content = 'hello', extra: Partial<SendInput> = {}): SendInput => ({
  to,
  content,
  client_request_id: randomUUID(),
  priority: 'info',
  ...extra,
});
const activate = (store: LobbyStore, id: string) => {
  const binding = store.claimRuntime(id, randomUUID());
  store.ready(id, binding, {
    context_revision: store.context(id).checkpoint.revision,
    probe_nonce: binding.probe_nonce,
  });
  return binding;
};
const memory = (t: TestContext, options: ConstructorParameters<typeof LobbyStore>[1] = {}) => {
  const store = new LobbyStore(':memory:', options);
  store.createLobby(LOBBY);
  t.after(() => store.close());
  return store;
};
const directory = (t: TestContext) => {
  return temporaryFolder('pocolobby-store-');
};
test('committed messages survive SIGKILL before notification dispatch', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  const script = `import { LobbyStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
    const s = new LobbyStore(${JSON.stringify(path)});
    s.createLobby('my-team');
    s.provision({agent_id:'backend',role:'',can_broadcast:false,allowed_recipients:null});
    s.send('owner',{to:'backend',content:'committed before crash',client_request_id:'crash-boundary',priority:'important'});
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 },
  );
  // Windows ends a killed process with a failing status and no signal.
  assert.ok(
    child.signal === 'SIGKILL' || (process.platform === 'win32' && child.status !== 0),
    child.stderr,
  );
  const reopened = new LobbyStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.messages('backend').items[0]?.content, 'committed before crash');
  assert.equal(reopened.agent('backend').pending_count, 1);
});

test('idempotency freezes a broadcast recipient snapshot and precedes capacity checks', (t) => {
  const store = memory(t, { maxStoredBytes: 5, maxPendingBytes: 5 });
  provision(store, 'coordinator', { can_broadcast: true });
  provision(store, 'backend');
  const request = command('*');
  const first = store.send('coordinator', request);
  assert.deepEqual(first.recipients, ['backend']);
  provision(store, 'frontend');
  const retry = store.send('coordinator', request);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.id, first.message.id);
  assert.deepEqual(retry.recipients, ['backend']);
  assert.equal(store.agent('frontend').pending_count, 0);
  assert.throws(
    () => store.send('coordinator', { ...request, content: 'other' }),
    rejectsCode('idempotency_conflict'),
  );
  assert.throws(
    () => store.send('coordinator', command('frontend', 'x')),
    rejectsCode('storage_capacity'),
  );
  // The capacity is per lobby: a full one does not stop another lobby's sends.
  store.createLobby('otherproject');
  provision(store, 'builder', { lobby_id: 'otherproject' });
  provision(store, 'tester', { lobby_id: 'otherproject' });
  assert.equal(store.send('otherproject/builder', command('tester', 'hello')).status, 'stored');
});

test('broadcast capacity failure rolls back every recipient and permits same-key retry', (t) => {
  const store = memory(t, { maxPendingBytes: 5 });
  provision(store, 'coordinator', { can_broadcast: true });
  provision(store, 'backend');
  provision(store, 'frontend');
  const occupied = store.send('coordinator', command('backend', '1234'));
  const broadcast = command('*', '12');
  assert.throws(() => store.send('coordinator', broadcast), rejectsCode('inbox_capacity'));
  assert.equal(store.agent('frontend').pending_count, 0);
  assert.equal(store.messages('coordinator', { mode: 'history' }).items.length, 1);
  store.acknowledge('backend', activate(store, 'backend'), [occupied.message.id]);
  assert.deepEqual(store.send('coordinator', broadcast).recipients, ['backend', 'frontend']);
});

test('peer allowlists, broadcast capability, reserved identities, and disabled recipients', (t) => {
  const store = memory(t);
  provision(store, 'coordinator', { allowed_recipients: ['backend'] });
  provision(store, 'backend');
  provision(store, 'frontend');
  assert.throws(() => provision(store, 'owner'), rejectsCode('reserved_identity'));
  assert.throws(
    () => store.send('coordinator', command('frontend')),
    rejectsCode('recipient_forbidden'),
  );
  assert.throws(() => store.send('coordinator', command('*')), rejectsCode('broadcast_forbidden'));
  store.updateAgent('coordinator', { can_broadcast: true });
  assert.deepEqual(store.send('coordinator', command('*')).recipients, ['backend']);
  store.updateAgent('backend', { enabled: false });
  assert.throws(
    () => store.send('coordinator', command('backend')),
    rejectsCode('recipient_disabled'),
  );
  assert.deepEqual(store.send('coordinator', command('*')).recipients, []);
});

test('new-message rate limits leave idempotent retries available', (t) => {
  const store = memory(t, { now: () => 1_000_000 });
  provision(store, 'backend');
  const first = command('backend', 'x');
  store.send('owner', first);
  for (let i = 1; i < 60; i++) store.send('owner', command('backend', 'x'));
  assert.throws(() => store.send('owner', command('backend', 'x')), rejectsCode('send_rate_limit'));
  assert.equal(store.send('owner', first).duplicate, true);
});

test('runtime ownership survives reopening; reset fences and tombstones the former runtime', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let store = new LobbyStore(path);
  store.createLobby(LOBBY);
  const { token } = provision(store, 'backend');
  const binding = activate(store, 'backend');
  const incarnation = store.incarnation;
  store.close();
  store = new LobbyStore(path);
  t.after(() => store.close());
  assert.equal(store.authenticate(token), 'my-team/backend');
  assert.equal(store.incarnation, incarnation);
  assert.deepEqual(store.claimRuntime('backend', binding.runtime_id, binding.generation), {
    ...binding,
    ready: true,
  });
  assert.throws(() => store.claimRuntime('backend', randomUUID()), rejectsCode('runtime_conflict'));
  store.resetRuntime('backend');
  assert.throws(() => store.heartbeat('backend', binding), rejectsCode('stale_runtime'));
  assert.throws(
    () => store.claimRuntime('backend', binding.runtime_id),
    rejectsCode('stale_runtime'),
  );
  const replacement = store.claimRuntime('backend', randomUUID());
  assert.ok(replacement.generation > binding.generation);
  assert.equal(replacement.ready, false);
  assert.throws(
    () =>
      store.ready('backend', replacement, {
        context_revision: 0,
        probe_nonce: binding.probe_nonce,
      }),
    rejectsCode('bootstrap_conflict'),
  );
});

test('a resumed runtime fences its earlier process and bootstraps again without owner action', (t) => {
  let now = 1_000;
  const store = memory(t, { now: () => now, infoDelayMs: 0, retryDelaysMs: [10] });
  provision(store, 'backend');
  const first = activate(store, 'backend');
  const message = store.send('owner', command('backend', 'before restart'));
  assert.equal(store.nextNotification('backend', first)?.messages[0]?.id, message.message.id);
  now += 10;
  assert.equal(store.agent('backend').notification_attention_required, true);

  const resumed = store.claimRuntime('backend', first.runtime_id);
  assert.equal(resumed.runtime_id, first.runtime_id);
  assert.equal(resumed.generation, first.generation + 1);
  assert.equal(resumed.ready, false);
  assert.notEqual(resumed.probe_nonce, first.probe_nonce);
  assert.equal(store.agent('backend').notification_attention_required, false);
  assert.throws(() => store.heartbeat('backend', first), rejectsCode('stale_runtime'));
  assert.throws(
    () => store.acknowledge('backend', first, [message.message.id]),
    rejectsCode('stale_runtime'),
  );
  assert.throws(
    () => store.claimRuntime('backend', first.runtime_id, first.generation),
    rejectsCode('stale_runtime'),
  );
  assert.deepEqual(store.claimRuntime('backend', resumed.runtime_id, resumed.generation), resumed);

  const probe = store.nextNotification('backend', resumed)!;
  assert.equal(probe.type, 'bootstrap');
  store.ready('backend', resumed, { context_revision: 0, probe_nonce: probe.probe_nonce! });
  const backlog = store.nextNotification('backend', resumed)!;
  assert.equal(backlog.truncated, true);
  assert.equal(backlog.pending_count, 1);
  assert.equal(store.context('backend').runtime_id, first.runtime_id);

  assert.throws(() => store.claimRuntime('backend', randomUUID()), rejectsCode('runtime_conflict'));
  store.resetRuntime('backend');
  assert.throws(
    () => store.claimRuntime('backend', first.runtime_id),
    rejectsCode('stale_runtime'),
  );
  assert.throws(
    () => store.claimRuntime('backend', first.runtime_id, resumed.generation),
    rejectsCode('stale_runtime'),
  );
  store.claimRuntime('backend', randomUUID());
  assert.throws(
    () => store.claimRuntime('backend', first.runtime_id),
    rejectsCode('stale_runtime'),
  );
});

test('own context exposes a stable runtime ID for idempotent startup greetings', (t) => {
  const store = memory(t);
  provision(store, 'backend');
  assert.equal(store.context('backend').runtime_id, null);
  const first = activate(store, 'backend');
  assert.equal(store.context('backend').runtime_id, first.runtime_id);
  const reconnect = store.claimRuntime('backend', first.runtime_id, first.generation);
  assert.equal(store.context('backend').runtime_id, reconnect.runtime_id);
  assert.equal(reconnect.runtime_id, first.runtime_id);
  store.resetRuntime('backend');
  assert.equal(store.context('backend').runtime_id, null);
  const replacement = activate(store, 'backend');
  assert.equal(store.context('backend').runtime_id, replacement.runtime_id);
  assert.notEqual(replacement.runtime_id, first.runtime_id);
});

test('receipt batches are scoped, atomic, idempotent, and never acknowledge lower message IDs', (t) => {
  const store = memory(t);
  provision(store, 'backend');
  provision(store, 'frontend');
  const binding = activate(store, 'backend');
  const first = store.send('owner', command('backend', 'old'));
  const urgent = store.send('owner', command('backend', 'urgent', { priority: 'important' }));
  const other = store.send('owner', command('frontend'));
  assert.throws(
    () => store.acknowledge('backend', binding, [urgent.message.id, other.message.id]),
    rejectsCode('receipt_forbidden'),
  );
  assert.equal(store.agent('backend').pending_count, 2);
  assert.deepEqual(store.acknowledge('backend', binding, [urgent.message.id]), {
    receipt_snapshot: 1,
  });
  assert.deepEqual(store.acknowledge('backend', binding, [urgent.message.id]), {
    receipt_snapshot: 1,
  });
  assert.deepEqual(
    store.messages('backend').items.map((message) => message.id),
    [first.message.id],
  );
  assert.equal(store.messages('backend', { mode: 'history' }).items.length, 2);
});

test('a sender sees each recipient delivery state and seen time for its own messages only', (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const at = () => new Date(now).toISOString();
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'coordinator', { manage_rooms: true, can_broadcast: true });
  provision(store, 'backend');
  provision(store, 'frontend');
  const coordinator = activate(store, 'coordinator');
  const backend = activate(store, 'backend');
  const pending = {
    delivery_state: 'pending',
    notification_attempted_at: null,
    agent_seen_at: null,
    held_reason: null,
  };
  const request = command('backend', 'review this');
  const sent = store.send('coordinator', request);
  assert.deepEqual(sent.deliveries, [{ agent_id: 'backend', ...pending }]);
  const history = (agent: string, id: string) =>
    store.messages(agent, { mode: 'history' }).items.find((message) => message.id === id)!;
  const facts = (id: string) => history('coordinator', id).deliveries;
  // The sender's own receipt fields stay absent; recipient facts are separate.
  for (const key of ['agent_seen_at', 'receipt_seq', 'delivery_state', 'held_reason'])
    assert.equal(Object.hasOwn(history('coordinator', sent.message.id), key), false);
  assert.deepEqual(facts(sent.message.id), [{ agent_id: 'backend', ...pending }]);

  // Stored, then notification attempted (the adapter wrote it to its host), then seen.
  const event = store.nextNotification('backend', backend)!;
  store.recordTransport('backend', backend, {
    type: 'adapter_received',
    notification_id: event.notification_id,
  });
  assert.equal(facts(sent.message.id)![0]!.notification_attempted_at, null);
  now += 1_000;
  const notifiedAt = at();
  store.recordTransport('backend', backend, {
    type: 'notification_attempted',
    notification_id: event.notification_id,
  });
  assert.deepEqual(facts(sent.message.id), [
    { agent_id: 'backend', ...pending, notification_attempted_at: notifiedAt },
  ]);
  now += 1_000;
  store.acknowledge('backend', backend, [sent.message.id]);
  const seen = {
    agent_id: 'backend',
    delivery_state: 'seen',
    notification_attempted_at: notifiedAt,
    agent_seen_at: at(),
    held_reason: null,
  };
  assert.deepEqual(facts(sent.message.id), [seen]);
  // A same-key retry reports the current facts, not the ones at acceptance.
  const retry = store.send('coordinator', request);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.deliveries, [seen]);
  // The recipient sees its own receipt, never the sender's view.
  const received = history('backend', sent.message.id);
  assert.equal(received.delivery_state, 'seen');
  assert.equal(received.receipt_seq, 1);
  assert.equal(Object.hasOwn(received, 'deliveries'), false);

  // Room messages show each recipient; a fellow recipient sees none of the others.
  store.createRoom('coordinator', 'app');
  store.setRoomMembers('coordinator', 'app', ['coordinator', 'backend', 'frontend']);
  const room = store.send('coordinator', command('*', 'room plan', { room: 'app' }));
  store.acknowledge('backend', backend, [room.message.id]);
  assert.deepEqual(
    facts(room.message.id)!.map((delivery) => [delivery.agent_id, delivery.delivery_state]),
    [
      ['backend', 'seen'],
      ['frontend', 'pending'],
    ],
  );
  assert.equal(Object.hasOwn(history('backend', room.message.id), 'deliveries'), false);
  store.setRoomMembers('coordinator', 'app', ['coordinator', 'backend']);
  assert.deepEqual(facts(room.message.id)![1], {
    agent_id: 'frontend',
    delivery_state: 'held',
    notification_attempted_at: null,
    agent_seen_at: null,
    held_reason: 'room_membership_revoked',
  });

  // A note to self carries both views; a fanout with no recipients has an empty list.
  const self = store.send('coordinator', command('coordinator', 'note to self'));
  assert.equal(history('coordinator', self.message.id).delivery_state, 'pending');
  store.acknowledge('coordinator', coordinator, [self.message.id]);
  assert.equal(history('coordinator', self.message.id).delivery_state, 'seen');
  assert.equal(history('coordinator', self.message.id).deliveries![0]!.delivery_state, 'seen');
  store.updateAgent('backend', { enabled: false });
  store.updateAgent('frontend', { enabled: false });
  const empty = store.send('coordinator', command('*', 'nobody else is enabled'));
  assert.deepEqual(empty.deliveries, []);
  assert.deepEqual(history('coordinator', empty.message.id).deliveries, []);
  // Owner lobby history is administrative and shows the facts for every message.
  const owner = store.messages(qualifyAgent(LOBBY, 'owner'), { mode: 'history' });
  assert.ok(owner.items.every((message) => Array.isArray(message.deliveries)));
  // Pending and reconciliation pages stay unchanged.
  assert.ok(
    store
      .messages('coordinator', { mode: 'reconciliation' })
      .items.every((message) => !Object.hasOwn(message, 'deliveries')),
  );
});

test('inbox notices count unseen deliveries when sent, never acknowledged ones', (t) => {
  // The live sequence: poco acknowledged its 5 pending messages, then 3 new ones arrived.
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'poco');
  const binding = activate(store, 'poco');
  const earlier = [1, 2, 3, 4, 5].map(
    (n) => store.send('owner', command('poco', `earlier ${n}`)).message.id,
  );
  assert.equal(store.nextNotification('poco', binding)?.pending_count, 5);
  assert.deepEqual(store.acknowledge('poco', binding, earlier), {
    receipt_snapshot: 5,
  });
  const counts: number[] = [];
  for (const n of [1, 2, 3]) {
    const sent = store.send('owner', command('poco', `new ${n}`));
    const event = store.nextNotification('poco', binding)!;
    assert.deepEqual(
      event.messages.map((message) => message.id),
      [sent.message.id],
    );
    counts.push(event.pending_count);
  }
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(store.agent('poco').pending_count, 3);

  // When the same notices are sent before the acknowledgment commits, as when Claude holds
  // them during a running tool and shows them afterwards, 6, 7 and 8 were true at send time.
  // The adapter therefore puts no inbox-wide count in a push; see the adapter tests.
  const late = memory(t, { infoDelayMs: 0 });
  provision(late, 'poco');
  const lateBinding = activate(late, 'poco');
  const unacknowledged = [1, 2, 3, 4, 5].map(
    (n) => late.send('owner', command('poco', `earlier ${n}`)).message.id,
  );
  late.nextNotification('poco', lateBinding);
  const sentBeforeReceipt = [1, 2, 3].map((n) => {
    late.send('owner', command('poco', `new ${n}`));
    return late.nextNotification('poco', lateBinding)!.pending_count;
  });
  assert.deepEqual(sentBeforeReceipt, [6, 7, 8]);
  late.acknowledge('poco', lateBinding, unacknowledged);
  assert.equal(late.agent('poco').pending_count, 3);
});

test('no payload-less retry follows a notice the same adapter process wrote to its host', (t) => {
  // The live sequence on Lando: a tool ran while two messages arrived. Claude showed the
  // first push, then a generic "1 pending" retry for that same message, then the second push.
  let now = 0;
  const store = memory(t, { now: () => now, infoDelayMs: 0, retryDelaysMs: [30, 120, 300] });
  provision(store, 'lando');
  const binding = activate(store, 'lando');
  const confirm = (notificationId: string, written = true) => {
    store.recordTransport('lando', binding, {
      type: 'adapter_received',
      notification_id: notificationId,
    });
    if (written)
      store.recordTransport('lando', binding, {
        type: 'notification_attempted',
        notification_id: notificationId,
      });
  };
  const first = store.send('owner', command('lando', 'first'));
  const push = store.nextNotification('lando', binding)!;
  assert.deepEqual(
    push.messages.map((message) => message.id),
    [first.message.id],
  );
  confirm(push.notification_id);
  now = 30;
  assert.equal(store.nextNotification('lando', binding), null);
  const second = store.send('owner', command('lando', 'second'));
  const next = store.nextNotification('lando', binding)!;
  assert.equal(next.truncated, false);
  assert.deepEqual(
    next.messages.map((message) => message.id),
    [second.message.id],
  );
  assert.equal(next.pending_count, 2);
  // This host write is not confirmed, so its retry still goes out, naming what it covers.
  confirm(next.notification_id, false);
  now = 60;
  const retry = store.nextNotification('lando', binding)!;
  assert.equal(retry.truncated, true);
  assert.deepEqual(retry.messages, []);
  assert.deepEqual(retry.covered, [
    {
      id: second.message.id,
      from: 'owner',
      to: 'lando',
      room_id: null,
      priority: 'info',
      created_at: second.message.created_at,
      kind: null,
    },
  ]);
  assert.equal(retry.covered_count, 1);
  confirm(retry.notification_id);
  // Suppressed retries still consume the budget, so unacknowledged work becomes visible.
  assert.equal(store.agent('lando').notification_attention_required, false);
  now = 150;
  assert.equal(store.nextNotification('lando', binding), null);
  now = 450;
  assert.equal(store.nextNotification('lando', binding), null);
  assert.equal(store.agent('lando').notification_attention_required, true);
  assert.equal(store.agent('lando').pending_count, 2);
  // An explicit owner retry notifies again with the bodies.
  store.retryNotifications('lando');
  assert.deepEqual(
    store.nextNotification('lando', binding)?.messages.map((message) => message.id),
    [first.message.id, second.message.id],
  );
  // A resumed process is a different host session: its backlog notice covers both.
  const resumed = store.claimRuntime('lando', binding.runtime_id);
  const probe = store.nextNotification('lando', resumed)!;
  store.ready('lando', resumed, { context_revision: 0, probe_nonce: probe.probe_nonce! });
  const backlog = store.nextNotification('lando', resumed)!;
  assert.equal(backlog.truncated, true);
  assert.deepEqual(
    backlog.covered?.map((message) => message.id),
    [first.message.id, second.message.id],
  );
});

test('hint headers list important messages first and stay within the envelope', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'backend');
  for (let i = 0; i < 24; i++) store.send('owner', command('backend', `item ${i}`));
  const urgent = store.send('owner', command('backend', 'urgent', { priority: 'important' }));
  const binding = activate(store, 'backend');
  const event = store.nextNotification('backend', binding)!;
  assert.equal(event.truncated, true);
  assert.equal(event.covered?.length, 20);
  assert.equal(event.covered_count, 25);
  assert.equal(event.covered?.[0]?.id, urgent.message.id);
  assert.equal(event.pending_count, 25);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= MIN_PUSH_BYTES);
});

test('last_message_at is the latest message an agent sent or direct message it received', (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'luke');
  provision(store, 'vader');
  activate(store, 'luke');
  assert.equal(store.agent('luke').last_message_at, null);
  store.send('vader', command('luke', 'Take the export dialog'));
  assert.deepEqual(
    [store.agent('vader').last_message_at, store.agent('luke').last_message_at],
    ['2026-10-15T12:00:00.000Z', '2026-10-15T12:00:00.000Z'],
  );
  // A scheduled direct message counts for its sender when sent, for its recipient when delivered.
  now += 60_000;
  store.send('vader', {
    ...command('luke', 'Ship it'),
    deliver_at: new Date(now + 3_600_000).toISOString(),
  });
  assert.deepEqual(
    [store.agent('vader').last_message_at, store.agent('luke').last_message_at],
    ['2026-10-15T12:01:00.000Z', '2026-10-15T12:00:00.000Z'],
  );
  now += 3_600_000;
  store.releaseDue();
  assert.equal(store.agent('luke').last_message_at, '2026-10-15T13:01:00.000Z');
});

test('what an agent waits on from the owner is its own word, fenced, replaced and cleared', (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const store = memory(t, { now: () => now });
  provision(store, 'luke');
  const binding = activate(store, 'luke');
  assert.equal(store.agent('luke').owner_requests, null);
  const asks = { count: 2, text: ' Approve the films; choose squash ' };
  assert.deepEqual(store.setOwnerRequests('luke', binding, asks), {
    count: 2,
    text: 'Approve the films; choose squash',
    set_at: '2026-10-15T12:00:00.000Z',
  });
  // The same again keeps the time it was first set; a change sets a new one.
  now += 60_000;
  assert.equal(store.setOwnerRequests('luke', binding, asks)!.set_at, '2026-10-15T12:00:00.000Z');
  assert.equal(
    store.setOwnerRequests('luke', binding, { count: 1, text: 'Approve the films' })!.set_at,
    '2026-10-15T12:01:00.000Z',
  );
  // A new count for the same text is a correction, not a new wait.
  now += 60_000;
  assert.deepEqual(
    store.setOwnerRequests('luke', binding, { count: 3, text: 'Approve the films' }),
    {
      count: 3,
      text: 'Approve the films',
      set_at: '2026-10-15T12:01:00.000Z',
    },
  );
  store.setOwnerRequests('luke', binding, { count: 1, text: 'Approve the films' });
  for (const invalid of [
    { count: 1 },
    { count: 1, text: '  ' },
    { count: 21, text: 'too many' },
    { count: -1, text: 'x' },
    { count: 1.5, text: 'x' },
    { count: 1, text: 'two\nlines' },
    { count: 1, text: 'x'.repeat(301) },
    { count: 1, text: 'x', extra: true },
  ])
    assert.throws(() => store.setOwnerRequests('luke', binding, invalid as never));
  assert.equal(store.agent('luke').owner_requests?.count, 1);
  // A resumed conversation keeps it; the earlier process can no longer change it.
  const resumed = store.claimRuntime('luke', binding.runtime_id);
  assert.throws(
    () => store.setOwnerRequests('luke', binding, { count: 0 }),
    rejectsCode('stale_runtime'),
  );
  assert.equal(store.setOwnerRequests('luke', resumed, { count: 0, text: 'ignored' }), null);
  assert.equal(store.agent('luke').owner_requests, null);
  // A reset runtime starts a conversation that never said it, so it is cleared.
  store.setOwnerRequests('luke', resumed, { count: 3, text: 'Three looks' });
  store.resetRuntime('luke');
  assert.equal(store.agent('luke').owner_requests, null);
});

test('the board history counts a scheduled direct message when it is delivered, however late', (t) => {
  let now = Date.parse('2026-10-01T09:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'luke');
  provision(store, 'vader');
  activate(store, 'luke');
  store.send('vader', {
    ...command('luke', 'Ship the release'),
    deliver_at: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
  });
  // The broker was down when it fell due, and delivers it four days late.
  now += 34 * 24 * 60 * 60_000;
  store.releaseDue();
  const slot = 15 * 60_000;
  const since = Math.ceil((now + 1) / slot) * slot - 96 * slot;
  assert.deepEqual(store.boardTraffic(LOBBY, since, slot), [
    { agent_id: 'luke', slot: Math.floor((now - since) / slot), sent: 0, received: 1 },
  ]);
});

test('messages are kept a day after they reached their recipients, then go with their traces', (t) => {
  let now = Date.parse('2026-10-16T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'luke');
  provision(store, 'vader');
  const luke = activate(store, 'luke');
  const old = store.send(
    'vader',
    command('luke', 'Yesterday', { notify_when_seen: true, client_request_id: 'yesterday' }),
  );
  store.acknowledge('luke', luke, [old.message.id]);
  const later = store.send('vader', {
    ...command('luke', 'Due in two days'),
    deliver_at: new Date(now + 2 * 24 * 60 * 60_000).toISOString(),
  });
  // Just under a day: nothing goes.
  now += 24 * 60 * 60_000 - 1;
  assert.equal(store.pruneMessages(), 0);
  now += 2;
  assert.equal(store.pruneMessages(), 1);
  assert.deepEqual(
    store.messages('vader', { mode: 'history' }).items.map((message) => message.id),
    [later.message.id],
  );
  // The scheduled one waits for its time, is delivered, and goes a day after that.
  now += 24 * 60 * 60_000;
  store.releaseDue();
  assert.equal(store.pruneMessages(), 0);
  now += 24 * 60 * 60_000 + 1;
  assert.equal(store.pruneMessages(), 1);
  assert.deepEqual(store.messages('luke', { mode: 'history' }).items, []);
  // A retry of a send that has gone is a new message.
  assert.equal(
    store.send(
      'vader',
      command('luke', 'Yesterday', { notify_when_seen: true, client_request_id: 'yesterday' }),
    ).duplicate,
    false,
  );
});

test('a message gone after its day can still be acknowledged, checkpointed and answered', (t) => {
  // A review found that retention turned these into refusals: an acknowledgment batch naming an
  // expired assignment was refused whole, so the fresh message in it stayed pending.
  let now = Date.parse('2026-10-16T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'luke');
  provision(store, 'vader');
  provision(store, 'leia');
  const luke = activate(store, 'luke');
  const assignment = store.send('vader', command('luke', 'Port the exporter'));
  now += 25 * 60 * 60_000;
  assert.equal(store.pruneMessages(), 1);
  const fresh = store.send('vader', command('luke', 'And the importer'));
  const seen = store.acknowledge('luke', luke, [assignment.message.id, fresh.message.id]);
  assert.equal(store.messages('luke').items.length, 0);
  store.checkpoint('luke', luke, {
    expected_revision: 0,
    content: 'Exporter done',
    covered_receipt_seq: seen.receipt_snapshot,
    acknowledge_message_ids: [assignment.message.id],
  });
  const reply = store.send(
    'luke',
    command('vader', 'Exporter ported', { reply_to: assignment.message.id }),
  );
  assert.equal(reply.message.reply_to, assignment.message.id);
  // A stored message in someone else's inbox is still refused, for receipts and replies.
  const other = store.send('vader', command('leia', 'Still for Leia'));
  assert.throws(
    () => store.acknowledge('luke', luke, [other.message.id]),
    rejectsCode('receipt_forbidden'),
  );
  assert.throws(
    () => store.send('luke', command('vader', 'Me too', { reply_to: other.message.id })),
    rejectsCode('reply_not_found'),
  );
});

test('a scheduled message cannot be acknowledged before it arrives, and then arrives', (t) => {
  // An agent acknowledged its own reminder before it was due: skipped by the broker, it was
  // taken as read by the bridge, which then hid the reminder when it arrived.
  let now = Date.parse('2026-10-16T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  provision(store, 'luke');
  const vader = activate(store, 'vader');
  const ordinary = store.send('luke', command('vader', 'Review this'));
  const reminder = store.send('vader', {
    ...command('vader', 'Check Luke'),
    deliver_at: new Date(now + 60 * 60_000).toISOString(),
  });
  const snapshot = store.context('vader').receipt_snapshot;
  assert.throws(
    () => store.acknowledge('vader', vader, [ordinary.message.id, reminder.message.id]),
    rejectsCode('not_yet_delivered'),
  );
  assert.throws(
    () =>
      store.checkpoint('vader', vader, {
        expected_revision: 0,
        content: 'Waiting for the reminder',
        covered_receipt_seq: snapshot,
        acknowledge_message_ids: [ordinary.message.id, reminder.message.id],
      }),
    rejectsCode('not_yet_delivered'),
  );
  // Nothing of either batch was recorded.
  assert.equal(store.context('vader').receipt_snapshot, snapshot);
  assert.equal(store.context('vader').checkpoint.revision, 0);
  assert.deepEqual(
    store.messages('vader').items.map((message) => message.id),
    [ordinary.message.id],
  );
  now += 61 * 60_000;
  store.releaseDue();
  assert.deepEqual(
    store.messages('vader').items.map((message) => message.id),
    [ordinary.message.id, reminder.message.id],
  );
  store.acknowledge('vader', vader, [reminder.message.id]);
});

test('a cancelled scheduled message is kept a day after its cancellation', (t) => {
  let now = Date.parse('2026-10-16T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  provision(store, 'luke');
  const vader = activate(store, 'vader');
  const later = store.send('vader', {
    ...command('luke', 'Next week'),
    deliver_at: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
  });
  now += 2 * 24 * 60 * 60_000;
  store.cancelScheduled('vader', vader, later.message.id);
  assert.equal(store.pruneMessages(), 0);
  const again = store.cancelScheduled('vader', vader, later.message.id);
  assert.equal(again.already_cancelled, true);
  now += 24 * 60 * 60_000 + 1;
  assert.equal(store.pruneMessages(), 1);
});

test('seen-before-checkpoint crash remains visible in reconciliation after reopening', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let store = new LobbyStore(path);
  store.createLobby(LOBBY);
  provision(store, 'backend');
  const binding = activate(store, 'backend');
  const assignment = store.send('owner', command('backend', 'unfinished work'));
  store.acknowledge('backend', binding, [assignment.message.id]);
  store.close();
  store = new LobbyStore(path);
  t.after(() => store.close());
  const context = store.context('backend');
  assert.equal(context.pending.items.length, 0);
  assert.equal(context.checkpoint.revision, 0);
  assert.equal(context.receipt_snapshot, 1);
  assert.equal(context.reconciliation.items[0]?.id, assignment.message.id);
});

test('reconciliation uses receipt order, with independent pagination and checkpoint coverage', (t) => {
  const store = memory(t);
  provision(store, 'backend');
  const binding = activate(store, 'backend');
  const older = store.send('owner', command('backend', 'old'));
  const newer = store.send('owner', command('backend', 'new'));
  store.acknowledge('backend', binding, [newer.message.id]);
  store.acknowledge('backend', binding, [older.message.id]);
  const firstPage = store.messages('backend', { mode: 'reconciliation', limit: 1 });
  assert.equal(firstPage.items[0]?.id, newer.message.id);
  assert.equal(firstPage.next_cursor, 1);
  assert.equal(
    store.messages('backend', { mode: 'reconciliation', cursor: firstPage.next_cursor! }).items[0]
      ?.id,
    older.message.id,
  );
  store.checkpoint('backend', binding, {
    expected_revision: 0,
    content: 'new work done',
    covered_receipt_seq: 1,
    acknowledge_message_ids: [],
  });
  assert.deepEqual(
    store.context('backend').reconciliation.items.map((message) => message.id),
    [older.message.id],
  );
});

test('bootstrap context bounds reconciliation bodies and asks for a first checkpoint', (t) => {
  // Field report: an agent that never saved a checkpoint got every message it had ever
  // acknowledged, in full, on each bootstrap.
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'lando');
  const binding = activate(store, 'lando');
  assert.deepEqual(store.context('lando').guidance, []);
  const ids: string[] = [];
  for (let n = 0; n < 30; n++)
    ids.push(store.send('owner', command('lando', `notice ${n} `.repeat(40))).message.id);
  store.acknowledge('lando', binding, ids);
  const context = store.context('lando');
  assert.equal(context.checkpoint.revision, 0);
  assert.equal(context.reconciliation.total, 30);
  assert.deepEqual(
    context.reconciliation.items.map((message) => message.id),
    ids.slice(0, 5),
  );
  assert.equal(context.reconciliation.next_cursor, 5);
  assert.deepEqual(
    context.reconciliation.headers.map((header) => [header.id, header.receipt_seq]),
    ids.slice(5, 25).map((id, index) => [id, index + 6]),
  );
  assert.ok(context.reconciliation.headers.every((header) => !('content' in header)));
  assert.match(context.guidance[0]!, /never saved a checkpoint/);
  assert.match(context.guidance[0]!, /covered_receipt_seq 30/);
  assert.match(context.guidance[1]!, /get_messages\(mode="reconciliation", cursor=5\)/);
  // The cursor continues with bodies where the context stopped.
  assert.equal(store.messages('lando', { mode: 'reconciliation', cursor: 5 }).items[0]?.id, ids[5]);
  store.checkpoint('lando', binding, {
    expected_revision: 0,
    content: 'All notices reconciled; nothing unfinished.',
    covered_receipt_seq: 30,
    acknowledge_message_ids: [],
  });
  const after = store.context('lando');
  assert.deepEqual(
    [after.reconciliation.total, after.reconciliation.items, after.reconciliation.headers],
    [0, [], []],
  );
  assert.deepEqual(after.guidance, []);
  const later = store.send('owner', command('lando', 'later'));
  store.acknowledge('lando', binding, [later.message.id]);
  assert.match(
    store.context('lando').guidance[0]!,
    /^1 acknowledged message is not covered by checkpoint revision 1/,
  );
});

test('checkpoint CAS and combined receipts cannot silently cover an unreconciled interval', (t) => {
  const store = memory(t);
  provision(store, 'backend');
  provision(store, 'frontend');
  const binding = activate(store, 'backend');
  const first = store.send('owner', command('backend', 'one'));
  const second = store.send('owner', command('backend', 'two'));
  const unrelated = store.send('owner', command('frontend'));
  store.acknowledge('backend', binding, [first.message.id]);
  const input = {
    expected_revision: 0,
    content: 'work in progress',
    covered_receipt_seq: 0,
    acknowledge_message_ids: [second.message.id],
  };
  assert.throws(
    () => store.checkpoint('backend', binding, input),
    rejectsCode('receipt_snapshot_conflict'),
  );
  assert.equal(store.context('backend').receipt_snapshot, 1);
  assert.throws(
    () =>
      store.checkpoint('backend', binding, {
        ...input,
        covered_receipt_seq: 1,
        acknowledge_message_ids: [second.message.id, unrelated.message.id],
      }),
    rejectsCode('receipt_forbidden'),
  );
  assert.equal(store.context('backend').checkpoint.revision, 0);
  const saved = store.checkpoint('backend', binding, { ...input, covered_receipt_seq: 1 });
  assert.equal(saved.revision, 1);
  assert.equal(saved.covered_receipt_seq, 2);
  assert.equal(store.context('backend').pending.items.length, 0);
  assert.equal(store.context('backend').reconciliation.items.length, 0);
  assert.throws(
    () => store.checkpoint('backend', binding, { ...input, covered_receipt_seq: 2 }),
    rejectsCode('checkpoint_conflict'),
  );
  assert.throws(
    () =>
      store.checkpoint('backend', binding, {
        ...input,
        expected_revision: 1,
        covered_receipt_seq: 99,
      }),
    rejectsCode('receipt_snapshot_conflict'),
  );
});

test('bootstrap is paused when requested and bounded retries survive a broker restart', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let now = 0;
  const options = { now: () => now, retryDelaysMs: [10, 20, 30] };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  provision(store, 'backend');
  const binding = store.claimRuntime('backend', randomUUID());
  store.updateAgent('backend', { paused: true });
  assert.equal(store.nextNotification('backend', binding), null);
  store.updateAgent('backend', { paused: false });
  assert.equal(store.nextNotification('backend', binding)?.type, 'bootstrap');
  assert.equal(store.nextNotification('backend', binding), null);
  store.close();
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  store.claimRuntime('backend', binding.runtime_id, binding.generation);
  assert.equal(store.nextNotification('backend', binding), null);
  // A bootstrap is retried at the schedule's longest delay, not at a delivery's first.
  now = 10;
  assert.equal(store.nextNotification('backend', binding), null);
  now = 30;
  assert.equal(store.nextNotification('backend', binding)?.type, 'bootstrap');
  now = 60;
  assert.equal(store.nextNotification('backend', binding)?.type, 'bootstrap');
  now = 89;
  assert.equal(store.nextNotification('backend', binding), null);
  assert.equal(store.agent('backend').notification_attention_required, false);
  now = 90;
  assert.equal(store.nextNotification('backend', binding), null);
  assert.equal(store.agent('backend').notification_attention_required, true);
  store.retryNotifications('backend');
  assert.equal(store.agent('backend').notification_attention_required, false);
  assert.equal(store.nextNotification('backend', binding)?.type, 'bootstrap');
});

test('important notifications bypass info delay; transport receipts never imply seen', (t) => {
  let now = 0;
  const store = memory(t, { now: () => now, infoDelayMs: 100, retryDelaysMs: [10, 20, 30] });
  provision(store, 'backend');
  const binding = activate(store, 'backend');
  const info = store.send('owner', command('backend', 'information'));
  const important = store.send('owner', command('backend', 'stop', { priority: 'important' }));
  const event = store.nextNotification('backend', binding)!;
  assert.deepEqual(
    event.messages.map((message) => message.id),
    [important.message.id],
  );
  store.recordTransport('backend', binding, {
    type: 'adapter_received',
    notification_id: event.notification_id,
  });
  store.recordTransport('backend', binding, {
    type: 'notification_attempted',
    notification_id: event.notification_id,
  });
  assert.equal(store.agent('backend').pending_count, 2);
  store.acknowledge('backend', binding, [important.message.id]);
  now = 99;
  assert.equal(store.nextNotification('backend', binding), null);
  now = 100;
  assert.equal(store.nextNotification('backend', binding)?.messages[0]?.id, info.message.id);
});

test('inbox retries coalesce, exhaust durably, and new messages remain deliverable', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let now = 0;
  const options = { now: () => now, infoDelayMs: 0, retryDelaysMs: [10, 20, 30] };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  provision(store, 'backend');
  const binding = activate(store, 'backend');
  const first = store.send('owner', command('backend'));
  assert.equal(store.nextNotification('backend', binding)?.messages[0]?.id, first.message.id);
  now = 10;
  assert.equal(store.nextNotification('backend', binding)?.truncated, true);
  now = 30;
  assert.equal(store.nextNotification('backend', binding)?.truncated, true);
  store.close();
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  now = 60;
  assert.equal(store.nextNotification('backend', binding), null);
  assert.equal(store.agent('backend').notification_attention_required, true);
  assert.equal(store.agent('backend').pending_count, 1);
  const fresh = store.send('owner', command('backend', 'new'));
  assert.equal(store.nextNotification('backend', binding)?.messages[0]?.id, fresh.message.id);
  assert.equal(store.agent('backend').pending_count, 2);
});

test('backlog and oversized content use a bounded hint with recoverable inbox bodies', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'backend');
  store.send('owner', command('backend', 'before bootstrap'));
  const binding = activate(store, 'backend');
  const backlog = store.nextNotification('backend', binding)!;
  assert.deepEqual(backlog.messages, []);
  assert.equal(backlog.truncated, true);
  const large = store.send('owner', command('backend', 'x'.repeat(9000)));
  const event = store.nextNotification('backend', binding)!;
  assert.deepEqual(event.messages, []);
  assert.equal(event.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= MIN_PUSH_BYTES);
  assert.equal(
    store.messages('backend').items.find((message) => message.id === large.message.id)?.content
      .length,
    9000,
  );
});

test('role updates invalidate an earlier readiness probe and receipts cannot cross runtimes', (t) => {
  const store = memory(t);
  provision(store, 'backend');
  provision(store, 'frontend');
  const binding = store.claimRuntime('backend', randomUUID());
  const other = store.claimRuntime('frontend', randomUUID());
  const event = store.nextNotification('backend', binding)!;
  assert.throws(
    () =>
      store.recordTransport('frontend', other, {
        type: 'adapter_received',
        notification_id: event.notification_id,
      }),
    rejectsCode('notification_not_found'),
  );
  store.updateAgent('backend', { role: 'new instructions' });
  assert.throws(
    () =>
      store.ready('backend', binding, { context_revision: 0, probe_nonce: binding.probe_nonce }),
    rejectsCode('bootstrap_conflict'),
  );
  const replacementProbe = store.nextNotification('backend', binding)!;
  assert.notEqual(replacementProbe.probe_nonce, binding.probe_nonce);
  store.ready('backend', binding, {
    context_revision: 0,
    probe_nonce: replacementProbe.probe_nonce!,
  });
  assert.equal(store.agent('backend').ready, true);
});

test('token rotation and disabling reject stale credentials and runtime authority', (t) => {
  const store = memory(t);
  const original = provision(store, 'backend');
  const binding = activate(store, 'backend');
  assert.equal(store.authenticate(original.token), 'my-team/backend');
  assert.throws(() => store.authenticate('unknown'), rejectsCode('unauthorized'));
  const replacement = store.rotateToken('backend');
  assert.throws(() => store.authenticate(original.token), rejectsCode('unauthorized'));
  assert.equal(store.authenticate(replacement.token), 'my-team/backend');
  assert.throws(() => store.assertRuntime('backend', binding), rejectsCode('stale_runtime'));
  const current = activate(store, 'backend');
  store.updateAgent('backend', { enabled: false });
  assert.throws(() => store.authenticate(replacement.token), rejectsCode('unauthorized'));
  assert.throws(() => store.assertRuntime('backend', current), rejectsCode('stale_runtime'));
  store.updateAgent('backend', { enabled: true });
  assert.equal(store.authenticate(replacement.token), 'my-team/backend');
  assert.throws(
    () => store.claimRuntime('backend', current.runtime_id),
    rejectsCode('stale_runtime'),
  );
});

test('native backup accepts a reserved empty file; recovery invalidates restored access and pauses dispatch', async (t) => {
  const dir = directory(t);
  const source = new LobbyStore(join(dir, 'live.sqlite'));
  source.createLobby(LOBBY);
  const original = provision(source, 'backend');
  const binding = activate(source, 'backend');
  const message = source.send('owner', command('backend'));
  const backup = join(dir, 'backup.sqlite');
  closeSync(openSync(backup, 'wx', 0o600));
  const oldIncarnation = source.incarnation;
  // A backup copies a stopped broker's database.
  source.close();
  await backupDatabase(join(dir, 'live.sqlite'), backup);
  const restored = new LobbyStore(backup);
  t.after(() => restored.close());
  assert.equal(restored.authenticate(original.token), 'my-team/backend');
  restored.enterRecovery();
  assert.notEqual(restored.incarnation, oldIncarnation);
  assert.throws(() => restored.authenticate(original.token), rejectsCode('unauthorized'));
  assert.throws(() => restored.assertRuntime('backend', binding), rejectsCode('stale_runtime'));
  assert.equal(restored.agent('backend').paused, true);
  assert.equal(restored.messages('backend').items[0]?.id, message.message.id);
  const fresh = restored.rotateToken('backend');
  assert.equal(restored.authenticate(fresh.token), 'my-team/backend');
  const next = restored.claimRuntime('backend', randomUUID());
  assert.equal(restored.nextNotification('backend', next), null);
  restored.updateAgent('backend', { paused: false });
  assert.equal(restored.nextNotification('backend', next)?.type, 'bootstrap');
});

test('database connection lifetime enforces one SQLite writer', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  const store = new LobbyStore(path);
  t.after(() => store.close());
  assert.throws(() => new LobbyStore(path), /locked/);
});

test('notification rate cap persists through reconnect, replacement and reopening without consuming delivery attempts', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let now = 1_000_000;
  const options = {
    now: () => now,
    infoDelayMs: 0,
    retryDelaysMs: [1_000_000],
    notificationRatePerMinute: 2,
  };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  provision(store, 'backend');
  const binding = activate(store, 'backend');
  store.send('owner', command('backend', 'first'));
  assert.ok(store.nextNotification('backend', binding));
  now++;
  store.send('owner', command('backend', 'second'));
  assert.ok(store.nextNotification('backend', binding));
  now++;
  const pending = store.send('owner', command('backend', 'rate limited'));
  assert.equal(store.nextNotification('backend', binding), null);
  store.claimRuntime('backend', binding.runtime_id, binding.generation);
  assert.equal(store.nextNotification('backend', binding), null);
  store.close();
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  assert.equal(store.nextNotification('backend', binding), null);
  now = 1_060_000;
  const released = store.nextNotification('backend', binding)!;
  assert.equal(released.messages[0]?.id, pending.message.id);
  assert.equal(released.pending_count, 3);
  store.resetRuntime('backend');
  const replacement = store.claimRuntime('backend', randomUUID());
  assert.equal(store.nextNotification('backend', replacement), null);
  now++;
  const probe = store.nextNotification('backend', replacement)!;
  assert.equal(probe.type, 'bootstrap');
  store.ready('backend', replacement, { context_revision: 0, probe_nonce: probe.probe_nonce! });
  assert.equal(store.nextNotification('backend', replacement), null);
  assert.ok(store.messages('backend').items.some((message) => message.id === pending.message.id));
  assert.equal(store.agent('backend').notification_attention_required, false);
});

test('SQLite page budget returns 507 after automatic rollback and preserves all accepted messages', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  const options = { maxDatabaseBytes: 512 * 1024 };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  // Inbox pages hold at most 80 KiB of content, so read every page.
  const inbox = () => {
    const ids: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = store.messages('backend', { limit: 100, cursor });
      ids.push(...page.items.map((message) => message.id));
      cursor = page.next_cursor;
    }
    return ids;
  };
  provision(store, 'backend');
  const accepted: string[] = [];
  const first = command('backend', 'x'.repeat(16_000));
  accepted.push(store.send('owner', first).message.id);
  let rejected: SendInput | undefined;
  for (let i = 0; i < 40; i++) {
    const request = command('backend', 'y'.repeat(16_000));
    try {
      accepted.push(store.send('owner', request).message.id);
    } catch (error) {
      assert.ok(error instanceof LobbyError);
      assert.equal(error.status, 507);
      assert.equal(error.code, 'storage_capacity');
      rejected = request;
      break;
    }
  }
  assert.ok(rejected, 'The configured physical page budget should be reached');
  assert.deepEqual(inbox(), accepted);
  assert.equal(store.agent('backend').pending_count, accepted.length);
  assert.equal(store.send('owner', first).duplicate, true);
  assert.throws(() => store.send('owner', rejected!), rejectsCode('storage_capacity'));
  store.close();
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  assert.deepEqual(inbox(), accepted);
  assert.equal(store.send('owner', first).duplicate, true);
});

test('a schema 10 database written by the deployed brokers is upgraded to 11 and keeps its state', (t) => {
  // The fixture is a dump of a database that the real migrations upgraded from the one 0.1.2
  // wrote, through 0.1.3, 0.2.0, 0.3.1 and 0.4.0, and that 0.5.3 then wrote to; see
  // fixtures/generate-schema-10.mjs.
  const root = directory(t);
  const path = join(root, 'lobby.sqlite');
  const attachmentsDir = join(root, 'attachments');
  const fixture = new DatabaseSync(path);
  fixture.exec(readFileSync(new URL('./fixtures/schema-10-0.5.3.sql', import.meta.url), 'utf8'));
  assert.equal(fixture.prepare('PRAGMA user_version').get()?.user_version, 10);
  const incarnation = String(
    fixture.prepare("SELECT value FROM metadata WHERE key='incarnation'").get()?.value,
  );
  const original = (request: string) =>
    String(fixture.prepare('SELECT id FROM messages WHERE request_id=?').get(request)?.id);
  const originals = {
    assignment: original('fixture-assignment'),
    plan: original('fixture-053-assignment'),
  };
  const counts = (db: DatabaseSync) =>
    Object.fromEntries(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map(({ name }) => [
        name,
        Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n),
      ]),
    );
  const before = counts(fixture);
  fixture.close();
  // Attachment content lives in files beside the database, not in the dump.
  const plan = Buffer.from('# Release plan\n- Tag 0.6.0\n');
  const sha = createHash('sha256').update(plan).digest('hex');
  mkdirSync(attachmentsDir);
  writeFileSync(join(attachmentsDir, sha), plan);
  // An hour after the fixture was written: its sessions and read receipts are still live.
  const store = new LobbyStore(path, {
    infoDelayMs: 0,
    attachmentsDir,
    now: () => Date.parse('2026-10-16T09:00:00.000Z'),
  });
  let open = true;
  t.after(() => {
    if (open) store.close();
  });

  // Credentials authenticate, and runtimes keep their binding.
  const token = (id: string) => `fixture-token-${id}`.padEnd(40, '0');
  for (const id of ['vader', 'luke', 'lando', 'padme'])
    assert.equal(store.authenticate(token(id)), `my-team/${id}`);
  const vader = { runtime_id: '00000000-0000-4000-8000-000000000005', generation: 1, incarnation };
  const padme = { runtime_id: '00000000-0000-4000-8000-000000000006', generation: 1, incarnation };
  store.assertRuntime('vader', vader);
  store.assertRuntime('padme', padme);
  assert.throws(
    () => store.assertRuntime('padme', { ...padme, runtime_id: randomUUID() }),
    rejectsCode('stale_runtime'),
  );

  // An identical retry returns the original message, sent by 0.1.2 or by 0.5.3; a changed one
  // conflicts.
  const assignment = {
    client_request_id: 'fixture-assignment',
    to: 'luke',
    priority: 'important',
    content: 'Review the login fix',
    correlation_id: 'login-42',
  } as const;
  const planned = {
    client_request_id: 'fixture-053-assignment',
    to: 'padme',
    kind: 'assignment',
    content: 'Plan the 0.6.0 release',
    notify_when_seen: true,
  } as const;
  for (const [request, id] of [
    [assignment, originals.assignment],
    [planned, originals.plan],
  ] as const) {
    const retry = store.send('vader', request);
    assert.deepEqual([retry.duplicate, retry.message.id], [true, id]);
    assert.throws(
      () => store.send('vader', { ...request, content: 'Changed' }),
      rejectsCode('idempotency_conflict'),
    );
  }

  // Pending deliveries, delivery facts and read receipts are intact.
  assert.deepEqual(
    store.messages('padme').items.map((message) => [message.content, message.kind]),
    [
      ['Padmé joins the app room', 'notice'],
      ['Which day is the release?', 'question'],
    ],
  );
  assert.deepEqual(
    store.messages('lando').items.map((message) => message.content),
    ['Welcome', 'Lobby news'],
  );
  const history = store.messages('vader', { mode: 'history', limit: 100 }).items;
  const sent = (content: string) => history.find((message) => message.content === content)!;
  assert.deepEqual(
    sent('Plan the 0.6.0 release').deliveries!.map((delivery) => [
      delivery.agent_id,
      delivery.delivery_state,
    ]),
    [['padme', 'seen']],
  );
  assert.deepEqual(
    sent('Padmé joins the app room').deliveries!.map((delivery) => [
      delivery.agent_id,
      delivery.delivery_state,
      delivery.notification_attempted_at !== null,
    ]),
    [
      ['luke', 'pending', false],
      ['padme', 'pending', true],
    ],
  );
  const context = store.context('padme');
  assert.deepEqual(
    [context.checkpoint.content, context.receipt_snapshot],
    ['Release plan started.', 1],
  );
  assert.deepEqual(
    store.nextReceipts('vader', vader)?.receipts.map((receipt) => [receipt.seen_by, receipt.kind]),
    [
      ['luke', 'assignment'],
      ['luke', 'notice'],
      ['padme', 'assignment'],
    ],
  );

  // Schedules, scheduled messages and attachments are intact.
  const scheduled = store.scheduled('vader');
  assert.deepEqual(
    scheduled.schedules.map((schedule) => [
      schedule.client_request_id,
      schedule.attachments?.map((attachment) => attachment.filename) ?? null,
    ]),
    [
      ['fixture-013-morning', null],
      ['fixture-013-standup', null],
      ['fixture-020-evening', null],
      ['fixture-053-daily', ['daily.png']],
    ],
  );
  assert.deepEqual(scheduled.schedules[3]?.repeat.weekdays, ['mon', 'wed', 'fri']);
  assert.deepEqual(
    scheduled.messages.map((message) => [message.content, message.deliver_at]),
    [
      ['Release day', '2026-10-18T08:00:00.000Z'],
      ['Check the overnight reports', '2026-11-01T05:41:00.000Z'],
      ['Review the screenshots', '2026-11-02T05:41:00.000Z'],
    ],
  );
  assert.equal(sent('Before frame attached').attachments![0]!.filename, 'before.png');
  const attached = sent('Release plan attached').attachments![0]!;
  assert.deepEqual(
    [attached.filename, attached.mime_type, attached.sha256],
    ['plan.md', 'text/markdown', sha],
  );
  assert.deepEqual(readFileSync(store.attachmentFile('vader', attached.id).path), plan);

  // Boards and the console carry over.
  assert.equal(store.consoleSession(tokenHash('c'.repeat(43)))?.email, 'owner@example.com');
  assert.equal(store.boardViewer(LOBBY, tokenHash('b'.repeat(43))), 'viewer@example.com');
  const board = store.boardConfig(LOBBY);
  assert.deepEqual(
    [board.visibility, board.summary_model, board.summary_effort, board.sources.length],
    ['private', 'claude-sonnet-5-5', 'medium', 2],
  );
  assert.equal(store.boardSummary(LOBBY)?.input_hash, 'fixture-053');
  assert.ok(store.lobbyRepos(LOBBY).includes('johansan/pocolobby'));
  assert.deepEqual(
    store.archivedRooms(LOBBY).map((room) => room.room_id),
    ['night-shift'],
  );
  assert.throws(() => store.createLobby('scratch'), rejectsCode('lobby_exists'));
  store.close();
  open = false;

  // Nothing was lost; the upgrade added only what schema 11 has, as a new database has it.
  const reopened = new DatabaseSync(path, { readOnly: true });
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 11);
  const freshPath = join(root, 'fresh.sqlite');
  new LobbyStore(freshPath).close();
  const fresh = new DatabaseSync(freshPath, { readOnly: true });
  t.after(() => fresh.close());
  const structure = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "SELECT type,name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name",
        )
        .all() as {
        type: string;
        name: string;
      }[]
    ).map(({ type, name }) => [
      type,
      name,
      (
        db
          .prepare(
            type === 'table' ? `PRAGMA table_xinfo("${name}")` : `PRAGMA index_xinfo("${name}")`,
          )
          .all() as Record<string, unknown>[]
      ).map((column) =>
        // A new database's agents and messages name no default lobby (0.8.3); an upgraded one
        // keeps the default its tables were created with, which no insert uses.
        type === 'table' && ['agents', 'messages'].includes(name) && column.name === 'lobby_id'
          ? { ...column, dflt_value: null }
          : column,
      ),
    ]);
  assert.deepEqual(structure(reopened), structure(fresh));
  assert.equal(
    reopened.prepare('SELECT COUNT(*) AS n FROM agents WHERE owner_requests<>0').get()?.n,
    0,
  );
  assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  // Pushing the receipts recorded one notification attempt.
  assert.deepEqual(counts(reopened), {
    ...before,
    notification_attempts: before.notification_attempts! + 1,
  });
});

test('a database of another schema is refused and left as it is', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  new LobbyStore(path).close();
  for (const [version, message] of [
    [
      SCHEMA_VERSION - 2,
      `This database is schema ${SCHEMA_VERSION - 2}; this broker opens schema ${SCHEMA_VERSION}, and upgrades only schema ${SCHEMA_VERSION - 1}. Restore a newer backup or start a new database.`,
    ],
    [
      SCHEMA_VERSION + 1,
      `This database is schema ${SCHEMA_VERSION + 1}, which is newer than this broker (schema ${SCHEMA_VERSION}).`,
    ],
  ] as const) {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    assert.throws(
      () => new LobbyStore(path),
      (error) =>
        error instanceof LobbyError &&
        error.code === 'unsupported_schema' &&
        error.message === message,
    );
    const after = new DatabaseSync(path, { readOnly: true });
    assert.equal(after.prepare('PRAGMA user_version').get()?.user_version, version);
    after.close();
  }
});

test('lobby credentials isolate repeated names, owner retry keys, messages and checkpoints', (t) => {
  const store = memory(t);
  store.createLobby('otherproject');
  const local = provision(store, 'backend');
  const remote = provision(store, 'backend', { lobby_id: 'otherproject' });
  const localId = store.authenticate(local.token);
  const remoteId = store.authenticate(remote.token);
  assert.equal(localId, 'my-team/backend');
  assert.equal(remoteId, 'otherproject/backend');
  // A bare name names no lobby (0.8.3).
  assert.throws(() => parsePrincipal('backend'), rejectsCode('invalid_principal'));
  assert.equal(qualifyAgent('otherproject', 'backend'), remoteId);
  assert.throws(() => qualifyAgent('otherproject', 'elsewhere/backend'));
  assert.throws(() => parsePrincipal('one/two/three'));
  assert.deepEqual(store.lobbies(), [
    { lobby_id: 'my-team', display_name: null, agent_count: 1 },
    { lobby_id: 'otherproject', display_name: null, agent_count: 1 },
  ]);
  assert.equal(store.agents().length, 2);
  assert.deepEqual(
    store.agents('my-team').map((agent) => agent.lobby_id),
    ['my-team'],
  );
  assert.deepEqual(
    store.agents('otherproject').map((agent) => agent.lobby_id),
    ['otherproject'],
  );
  assert.throws(
    () => provision(store, 'unknown', { lobby_id: 'uncreated' }),
    rejectsCode('lobby_not_found'),
  );

  const request = command('backend', 'private project plan');
  const a = store.send('owner', request, LOBBY);
  const b = store.send('owner', request, 'otherproject');
  assert.notEqual(a.message.id, b.message.id);
  assert.equal(a.message.lobby_id, 'my-team');
  assert.equal(b.message.lobby_id, 'otherproject');
  assert.equal(b.message.from, 'owner');
  assert.equal(b.message.room_id, null);
  assert.equal(store.send('owner', request, LOBBY).message.id, a.message.id);
  assert.equal(store.send('owner', request, 'otherproject').message.id, b.message.id);
  assert.deepEqual(
    store.messages(localId, { mode: 'history' }).items.map((message) => message.id),
    [a.message.id],
  );
  assert.deepEqual(
    store.messages(remoteId, { mode: 'history' }).items.map((message) => message.id),
    [b.message.id],
  );
  assert.throws(() => store.send(localId, command('otherproject/backend')));
  assert.throws(
    () => store.send(localId, command('backend', 'reply', { reply_to: b.message.id })),
    rejectsCode('reply_not_found'),
  );
  assert.throws(
    () => store.send('owner', command('backend', 'reply', { reply_to: b.message.id }), LOBBY),
    rejectsCode('reply_not_found'),
  );
  const localRuntime = activate(store, localId);
  const remoteRuntime = activate(store, remoteId);
  assert.throws(
    () => store.acknowledge(localId, localRuntime, [b.message.id]),
    rejectsCode('receipt_forbidden'),
  );
  assert.throws(
    () =>
      store.checkpoint(remoteId, localRuntime, {
        expected_revision: 0,
        content: 'cross-lobby attempt',
        covered_receipt_seq: 0,
        acknowledge_message_ids: [],
      }),
    rejectsCode('stale_runtime'),
  );
  store.checkpoint(localId, localRuntime, {
    expected_revision: 0,
    content: 'local secret',
    covered_receipt_seq: 0,
    acknowledge_message_ids: [a.message.id],
  });
  store.checkpoint(remoteId, remoteRuntime, {
    expected_revision: 0,
    content: 'remote secret',
    covered_receipt_seq: 0,
    acknowledge_message_ids: [b.message.id],
  });
  assert.equal(store.context(localId).checkpoint.content, 'local secret');
  assert.equal(store.context(remoteId).checkpoint.content, 'remote secret');
  assert.equal(store.context(remoteId).lobby_id, 'otherproject');
});

test('room managers can assign only existing same-lobby agents, while members see only joined rooms', (t) => {
  const store = memory(t);
  store.createLobby('otherproject');
  provision(store, 'coordinator', { manage_rooms: true });
  provision(store, 'backend');
  provision(store, 'social');
  provision(store, 'outsider', { lobby_id: 'otherproject' });
  assert.throws(
    () => store.createRoom(inLobby('backend'), 'app'),
    rejectsCode('room_management_forbidden'),
  );
  assert.deepEqual(store.createRoom(inLobby('coordinator'), 'app'), {
    lobby_id: LOBBY,
    room_id: 'app',
    members: [],
  });
  store.createRoom(inLobby('coordinator'), 'social');
  store.setRoomMembers(inLobby('coordinator'), 'app', ['coordinator', 'backend']);
  store.setRoomMembers(inLobby('coordinator'), 'social', ['coordinator', 'social']);
  assert.deepEqual(
    store.rooms(LOBBY, inLobby('backend')).map((room) => room.room_id),
    ['app'],
  );
  assert.deepEqual(
    store.rooms(LOBBY, inLobby('coordinator')).map((room) => room.room_id),
    ['app', 'social'],
  );
  assert.throws(
    () => store.rooms('otherproject', inLobby('coordinator')),
    rejectsCode('lobby_forbidden'),
  );
  assert.throws(
    () => store.setRoomMembers(inLobby('coordinator'), 'app', ['backend', 'outsider']),
    rejectsCode('agent_not_found'),
  );
  assert.throws(() =>
    store.setRoomMembers(inLobby('coordinator'), 'app', ['otherproject/outsider']),
  );
  assert.deepEqual(store.rooms(LOBBY, inLobby('backend'))[0]?.members, ['backend', 'coordinator']);
  assert.throws(
    () => store.setRoomMembers(inLobby('backend'), 'app', ['backend']),
    rejectsCode('room_management_forbidden'),
  );
  // The optional owner lobby parameter cannot grant a coordinator cross-lobby authority.
  assert.equal(store.createRoom(inLobby('coordinator'), 'web', 'otherproject').lobby_id, LOBBY);
  assert.deepEqual(store.rooms('otherproject'), []);
  assert.equal(store.agents('otherproject').length, 1);
});

test('room fanout requires membership, needs no lobby-broadcast privilege, and freezes its recipients', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  store.createLobby('otherproject');
  provision(store, 'coordinator', { manage_rooms: true });
  provision(store, 'backend');
  provision(store, 'frontend');
  provision(store, 'social');
  provision(store, 'backend', { lobby_id: 'otherproject' });
  store.createRoom(inLobby('coordinator'), 'app');
  store.setRoomMembers(inLobby('coordinator'), 'app', ['coordinator', 'backend']);
  const backendRuntime = activate(store, inLobby('backend'));
  const request = command('*', 'app plan', { room: 'app' });
  const first = store.send(inLobby('coordinator'), request);
  assert.deepEqual(first.recipients, ['backend']);
  assert.equal(first.message.room_id, 'app');
  assert.throws(
    () => store.send(inLobby('social'), request),
    rejectsCode('room_membership_required'),
  );
  assert.throws(
    () => store.send(inLobby('coordinator'), command('*')),
    rejectsCode('broadcast_forbidden'),
  );
  assert.throws(() =>
    store.send(inLobby('coordinator'), command('backend', 'invalid room direct', { room: 'app' })),
  );
  assert.throws(() =>
    store.send(
      inLobby('coordinator'),
      command('*', 'invalid room scope', { room: 'otherproject/app' }),
    ),
  );
  store.setRoomMembers(inLobby('coordinator'), 'app', ['coordinator', 'backend', 'frontend']);
  assert.deepEqual(store.send(inLobby('coordinator'), request).recipients, ['backend']);
  assert.deepEqual(store.messages(inLobby('frontend'), { mode: 'history' }).items, []);
  assert.deepEqual(store.messages(inLobby('social')).items, []);
  assert.deepEqual(store.messages('otherproject/backend').items, []);
  const event = store.nextNotification(inLobby('backend'), backendRuntime)!;
  assert.equal(event.agent_id, 'backend');
  assert.equal(event.lobby_id, LOBBY);
  assert.equal(event.messages[0]?.room_id, 'app');
  assert.deepEqual(
    store.send(inLobby('coordinator'), command('*', 'next plan', { room: 'app' })).recipients,
    ['backend', 'frontend'],
  );
  store.updateAgent(inLobby('coordinator'), { can_broadcast: true });
  assert.deepEqual(
    store.send(inLobby('coordinator'), command('*', 'lobby announcement')).recipients,
    ['backend', 'frontend', 'social'],
  );
  assert.equal(store.agent('otherproject/backend').pending_count, 0);
});

test('membership removal visibly holds unseen room work without erasing seen history or private direct messages', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'coordinator', { manage_rooms: true });
  provision(store, 'backend');
  store.createRoom('coordinator', 'app');
  store.setRoomMembers('coordinator', 'app', ['coordinator', 'backend']);
  const binding = activate(store, 'backend');
  const seen = store.send('coordinator', command('*', 'already seen content', { room: 'app' }));
  store.acknowledge('backend', binding, [seen.message.id]);
  const unseen = store.send(
    'coordinator',
    command('*', 'private outstanding instruction', { room: 'app' }),
  );
  const direct = store.send('coordinator', command('backend', 'direct message remains'));
  store.setRoomMembers('coordinator', 'app', ['coordinator']);
  assert.deepEqual(
    store.messages('backend').items.map((message) => message.id),
    [direct.message.id],
  );
  assert.equal(store.agent('backend').pending_count, 1);
  const history = store.messages('backend', { mode: 'history' }).items;
  assert.equal(
    history.find((message) => message.id === seen.message.id)?.content,
    'already seen content',
  );
  assert.equal(
    history.find((message) => message.id === unseen.message.id)?.content,
    '[Held: room membership revoked]',
  );
  assert.equal(history.find((message) => message.id === unseen.message.id)?.delivery_state, 'held');
  assert.equal(
    history.find((message) => message.id === unseen.message.id)?.held_reason,
    'room_membership_revoked',
  );
  assert.equal(
    store
      .messages('backend', { mode: 'history', includeHeldContent: true })
      .items.find((message) => message.id === unseen.message.id)?.content,
    'private outstanding instruction',
  );
  assert.equal(
    store
      .messages('coordinator', { mode: 'history' })
      .items.find((message) => message.id === unseen.message.id)?.content,
    'private outstanding instruction',
  );
  // A held message is skipped, not seen: the rest of a batch, and a checkpoint, still count.
  store.acknowledge('backend', binding, [unseen.message.id]);
  assert.equal(
    store.checkpoint('backend', binding, {
      expected_revision: 0,
      content: 'commits without the held message',
      covered_receipt_seq: 0,
      acknowledge_message_ids: [unseen.message.id],
    }).revision,
    1,
  );
  assert.deepEqual(
    store.nextNotification('backend', binding)?.messages.map((message) => message.id),
    [direct.message.id],
  );
  store.setRoomMembers('coordinator', 'app', ['coordinator', 'backend']);
  store.retryNotifications('backend');
  assert.deepEqual(
    store.messages('backend').items.map((message) => message.id),
    [direct.message.id],
  );
  assert.throws(
    () =>
      store.send(
        'backend',
        command('coordinator', 'reply to held content', { reply_to: unseen.message.id }),
      ),
    rejectsCode('reply_not_found'),
  );
  const fresh = store.send('coordinator', command('*', 'new room work', { room: 'app' }));
  assert.ok(store.messages('backend').items.some((message) => message.id === fresh.message.id));
});

test('adding and removing members keeps everyone else, so two coordinators do not overwrite each other', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  store.createLobby('otherproject');
  provision(store, 'vader', { manage_rooms: true });
  provision(store, 'lando', { manage_rooms: true });
  for (const id of ['luke', 'leia', 'han', 'chewie']) provision(store, id);
  provision(store, 'outsider', { lobby_id: 'otherproject' });
  store.createRoom(inLobby('vader'), 'app');
  store.setRoomMembers(inLobby('vader'), 'app', ['vader', 'lando', 'luke', 'leia']);
  const luke = activate(store, inLobby('luke'));
  const unseen = store.send(inLobby('vader'), command('*', 'unseen room work', { room: 'app' }));
  // Both read [vader, lando, luke, leia]; one adds han while the other removes luke. With
  // whole-list replacement the second write would drop han or restore luke.
  store.changeRoomMembers(inLobby('vader'), 'app', { add: ['han'] });
  const after = store.changeRoomMembers(inLobby('lando'), 'app', { remove: ['luke'] });
  assert.deepEqual(after.members, ['han', 'lando', 'leia', 'vader']);
  // A removed member's unseen room messages are held, exactly as with set_room_members.
  const held = store
    .messages(inLobby('luke'), { mode: 'history' })
    .items.find((message) => message.id === unseen.message.id)!;
  assert.deepEqual(
    [held.delivery_state, held.held_reason, held.content],
    ['held', 'room_membership_revoked', '[Held: room membership revoked]'],
  );
  assert.equal(store.nextNotification(inLobby('luke'), luke), null);
  // Repeating either change, or adding and removing in one call, is applied to the current list.
  assert.deepEqual(
    store.changeRoomMembers(inLobby('vader'), 'app', { add: ['han'] }).members,
    after.members,
  );
  assert.deepEqual(
    store.changeRoomMembers(inLobby('lando'), 'app', { remove: ['luke'] }).members,
    after.members,
  );
  assert.deepEqual(
    store.changeRoomMembers(inLobby('vader'), 'app', { add: ['chewie'], remove: ['leia'] }).members,
    ['chewie', 'han', 'lando', 'vader'],
  );
  // The same validation as a replacement, and nothing changes on a refusal.
  const unchanged = (fn: () => unknown, code: string) => {
    assert.throws(fn, rejectsCode(code));
    assert.deepEqual(store.rooms(LOBBY)[0]!.members, ['chewie', 'han', 'lando', 'vader']);
  };
  unchanged(
    () => store.changeRoomMembers(inLobby('vader'), 'app', { add: ['luke', 'outsider'] }),
    'agent_not_found',
  );
  unchanged(
    () => store.changeRoomMembers(inLobby('luke'), 'app', { add: ['luke'] }),
    'room_management_forbidden',
  );
  unchanged(
    () => store.changeRoomMembers(inLobby('vader'), 'web', { add: ['luke'] }),
    'room_not_found',
  );
  assert.throws(
    () => store.changeRoomMembers(inLobby('vader'), 'app', {}),
    /Name members to add or remove/,
  );
  assert.throws(
    () => store.changeRoomMembers(inLobby('vader'), 'app', { add: ['luke'], remove: ['luke'] }),
    /both added and removed/,
  );
  assert.throws(() =>
    store.changeRoomMembers(inLobby('vader'), 'app', { add: ['otherproject/outsider'] }),
  );
  // The owner can change a room in any lobby it selects.
  store.createRoom('owner', 'ops', 'otherproject');
  assert.deepEqual(
    store.changeRoomMembers('owner', 'ops', { add: ['outsider'] }, 'otherproject').members,
    ['outsider'],
  );
});

test('a member limit applies to the resulting room', (t) => {
  const store = memory(t, { maxAgents: 200 });
  provision(store, 'vader', { manage_rooms: true });
  const names = Array.from({ length: 101 }, (_, index) => `agent-${index}`);
  for (const id of names) provision(store, id);
  store.createRoom('vader', 'big');
  store.setRoomMembers('vader', 'big', names.slice(0, 100));
  assert.throws(
    () => store.changeRoomMembers('vader', 'big', { add: [names[100]!] }),
    rejectsCode('member_limit'),
  );
  assert.equal(
    store.changeRoomMembers('vader', 'big', { add: [names[100]!], remove: [names[0]!] }).members
      .length,
    100,
  );
});

test('deleting a room holds its unseen messages, cancels its schedules and keeps history', (t) => {
  let now = Date.parse('2026-10-15T20:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader', { manage_rooms: true });
  provision(store, 'luke');
  provision(store, 'leia');
  store.createRoom('vader', 'app');
  store.setRoomMembers('vader', 'app', ['vader', 'luke', 'leia']);
  const vader = activate(store, 'vader');
  const luke = activate(store, 'luke');
  const room = (content: string, extra: Partial<SendInput> = {}) =>
    store.send('vader', command('*', content, { room: 'app', ...extra }));
  const seen = room('seen plan', { notify_when_seen: true });
  store.acknowledge('luke', luke, [seen.message.id]);
  const unseen = room('unseen plan');
  // Structured fields carry substance as well; a held delivery must not show them (review v031 F1).
  const later = room('tomorrow plan', {
    deliver_at: '2026-10-16T06:41:00+02:00',
    kind: 'question',
    options: ['Ship', 'Hold'],
    recommendation: 'Ship after the review',
    evidence: 'dropbox:MDP/plans/tomorrow',
  });
  const direct = store.send('vader', command('luke', 'direct note'));
  const daily = store.createSchedule('vader', vader, {
    client_request_id: 'daily-app',
    to: '*',
    room: 'app',
    content: 'Daily app standup',
    repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'] },
  });
  const own = store.createSchedule('vader', vader, {
    client_request_id: 'daily-self',
    to: 'vader',
    content: 'Daily note to self',
    repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'] },
  });
  assert.throws(() => store.deleteRoom('luke', 'app'), rejectsCode('room_management_forbidden'));
  // Its board notes source goes with it, or its notes would be summarized as current work.
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes'] }, 'owner');

  const deleted = store.deleteRoom('vader', 'app');
  assert.deepEqual(store.boardSources(LOBBY), []);
  assert.deepEqual(deleted, {
    lobby_id: LOBBY,
    room_id: 'app',
    deleted: true,
    former_members: ['leia', 'luke', 'vader'],
    // unseen for luke and leia, seen plan for leia, and the scheduled plan for both.
    held_deliveries: 5,
    cancelled_schedules: [{ schedule_id: daily.schedule.schedule_id, from: 'vader' }],
  });
  // No members, no sends, not listed; a retry finds no room.
  assert.deepEqual(store.rooms(LOBBY), []);
  assert.throws(() => room('after deletion'), rejectsCode('room_not_found'));
  assert.throws(() => store.deleteRoom('vader', 'app'), rejectsCode('room_not_found'));
  // History stays: seen content readable, unseen content held, the sender sees every fact.
  const lukeHistory = store.messages('luke', { mode: 'history' }).items;
  const of = (id: string) => lukeHistory.find((message) => message.id === id)!;
  assert.equal(of(seen.message.id).content, 'seen plan');
  assert.equal(of(seen.message.id).delivery_state, 'seen');
  assert.deepEqual(
    [of(unseen.message.id).content, of(unseen.message.id).held_reason],
    ['[Held: room deleted]', 'room_deleted'],
  );
  assert.deepEqual(
    store.messages('luke').items.map((message) => message.id),
    [direct.message.id],
  );
  const sent = store
    .messages('vader', { mode: 'history' })
    .items.find((message) => message.id === unseen.message.id)!;
  assert.equal(sent.content, 'unseen plan');
  assert.deepEqual(
    sent.deliveries!.map((delivery) => [delivery.agent_id, delivery.delivery_state]),
    [
      ['leia', 'held'],
      ['luke', 'held'],
    ],
  );
  assert.equal(
    store
      .messages('vader', { mode: 'history' })
      .items.find((message) => message.id === seen.message.id)!
      .deliveries!.find((delivery) => delivery.agent_id === 'luke')!.delivery_state,
    'seen',
  );
  // The room's recurring schedule is cancelled, visibly; others continue.
  assert.deepEqual(
    store.scheduled('vader').schedules.map((schedule) => schedule.schedule_id),
    [own.schedule.schedule_id],
  );
  const cancelled = store.cancelScheduled('vader', vader, daily.schedule.schedule_id);
  assert.equal(cancelled.cancelled === 'schedule' && cancelled.schedule.last_error, 'room_deleted');
  assert.equal(cancelled.already_cancelled, true);

  // A room recreated under the same ID starts empty and inherits nothing.
  store.createRoom('vader', 'app');
  store.setRoomMembers('vader', 'app', ['vader', 'luke']);
  now = Date.parse('2026-10-16T04:41:00Z');
  assert.deepEqual(store.releaseDue(), { released: 1, occurrences: 1 });
  assert.deepEqual(
    store.messages('luke').items.map((message) => message.id),
    [direct.message.id],
  );
  // The scheduled plan was released into nothing: held, as a removed member's would be.
  const laterForLuke = store
    .messages('luke', { mode: 'history' })
    .items.find((message) => message.id === later.message.id)!;
  assert.deepEqual(
    [laterForLuke.delivery_state, laterForLuke.content],
    ['held', '[Held: room deleted]'],
  );
  for (const field of ['options', 'recommendation', 'evidence'])
    assert.equal(Object.hasOwn(laterForLuke, field), false, field);
  // The sender still sees what it sent.
  const laterForVader = store
    .messages('vader', { mode: 'history' })
    .items.find((message) => message.id === later.message.id)!;
  assert.equal(laterForVader.recommendation, 'Ship after the review');
  assert.equal(store.agent('luke').pending_count, 1);
  // The owner deletes rooms in the lobby it selects.
  assert.equal(store.deleteRoom('owner', 'app', LOBBY).former_members.length, 2);
});

test('lobby and per-lobby room caps reject growth without affecting existing membership', (t) => {
  const store = memory(t, { maxLobbies: 2, maxRoomsPerLobby: 2 });
  store.createLobby('otherproject');
  assert.throws(() => store.createLobby('thirdproject'), rejectsCode('lobby_capacity'));
  assert.equal(store.lobbies().length, 2);
  provision(store, 'coordinator', { manage_rooms: true });
  provision(store, 'backend');
  store.createRoom(inLobby('coordinator'), 'app');
  store.setRoomMembers(inLobby('coordinator'), 'app', ['coordinator', 'backend']);
  store.createRoom(inLobby('coordinator'), 'social');
  assert.throws(
    () => store.createRoom(inLobby('coordinator'), 'web'),
    rejectsCode('room_capacity'),
  );
  assert.deepEqual(
    store.rooms(LOBBY).map((room) => room.room_id),
    ['app', 'social'],
  );
  assert.deepEqual(store.rooms(LOBBY, inLobby('backend'))[0]?.members, ['backend', 'coordinator']);
  assert.equal(store.createRoom('owner', 'web', 'otherproject').room_id, 'web');
});

test('a scheduled send is stored at once, hidden from its recipient until due, then pushed', (t) => {
  let now = Date.parse('2026-10-15T20:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  provision(store, 'luke');
  const vader = activate(store, 'vader');
  // Vader's 06:41 morning check, written in local time.
  const sent = store.send(
    'vader',
    command('luke', 'Morning check', { deliver_at: '2026-10-16T06:41:00+02:00' }),
  );
  assert.equal(sent.status, 'stored');
  assert.equal(sent.message.deliver_at, '2026-10-16T04:41:00.000Z');
  assert.equal(sent.message.delivered_at, null);
  assert.equal(sent.message.late, false);
  assert.deepEqual(
    sent.deliveries.map((delivery) => delivery.delivery_state),
    ['scheduled'],
  );
  // Luke binds after acceptance and before delivery: the message is live traffic when it
  // falls due, not backlog, so it is pushed with its body.
  const luke = activate(store, 'luke');
  assert.deepEqual(store.messages('luke').items, []);
  assert.deepEqual(store.messages('luke', { mode: 'history' }).items, []);
  assert.equal(store.agent('luke').pending_count, 0);
  assert.equal(store.nextNotification('luke', luke), null);
  // Acknowledging it before its time is refused; it stays unseen until delivered.
  assert.throws(
    () => store.acknowledge('luke', luke, [sent.message.id]),
    rejectsCode('not_yet_delivered'),
  );
  assert.throws(
    () => store.send('luke', command('vader', 'early reply', { reply_to: sent.message.id })),
    rejectsCode('reply_not_found'),
  );
  assert.deepEqual(
    store.scheduled('vader').messages.map((message) => message.id),
    [sent.message.id],
  );
  assert.deepEqual(store.context('vader').scheduled, { schedules: 0, messages: 1 });

  now = Date.parse('2026-10-16T04:40:59.999Z');
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 0 });
  now = Date.parse('2026-10-16T04:41:00Z');
  assert.deepEqual(store.releaseDue(), { released: 1, occurrences: 0 });
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 0 });
  const push = store.nextNotification('luke', luke)!;
  assert.equal(push.truncated, false);
  assert.deepEqual(
    push.messages.map((message) => [
      message.id,
      message.deliver_at,
      message.delivered_at,
      message.late,
    ]),
    [[sent.message.id, '2026-10-16T04:41:00.000Z', '2026-10-16T04:41:00.000Z', false]],
  );
  assert.equal(store.messages('luke', { mode: 'history' }).items.length, 1);
  assert.deepEqual(
    store
      .messages('vader', { mode: 'history' })
      .items[0]!.deliveries!.map((delivery) => delivery.delivery_state),
    ['pending'],
  );
  assert.deepEqual(store.scheduled('vader').messages, []);

  // A reminder to yourself, Lando's "check the films at 06:08" case.
  const reminder = store.send(
    'vader',
    command('vader', 'Check the films', { deliver_at: '2026-10-17T06:08:00+02:00' }),
  );
  assert.equal(store.nextNotification('vader', vader), null);
  now = Date.parse('2026-10-17T04:08:00Z');
  store.releaseDue();
  assert.equal(store.nextNotification('vader', vader)?.messages[0]?.id, reminder.message.id);

  // Bounds: about 30 days ahead, and a little in the past is delivered at once.
  for (const deliverAt of [now + 30 * 86_400_000 + 1, now - 5 * 60_000 - 1])
    assert.throws(
      () => store.send('vader', command('luke', 'x', { deliver_at: iso(deliverAt) })),
      rejectsCode('deliver_at_out_of_range'),
    );
  const overdue = store.send(
    'vader',
    command('luke', 'clock skew', { deliver_at: iso(now - 60_000) }),
  );
  assert.equal(overdue.message.delivered_at, iso(now));
  assert.equal(overdue.message.late, false);
  assert.equal(overdue.deliveries[0]!.delivery_state, 'pending');
  for (const deliverAt of ['2026-10-17T06:08:00', '2026-10-17', 'tomorrow'])
    assert.throws(() => store.send('vader', command('luke', 'x', { deliver_at: deliverAt })));
});

test('scheduled delivery survives a restart, and a message due during the downtime arrives late', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let now = Date.parse('2026-10-15T22:00:00Z');
  const options = { now: () => now, infoDelayMs: 0 };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  provision(store, 'vader');
  provision(store, 'luke');
  const morning = store.send(
    'vader',
    command('vader', 'Morning notice', { deliver_at: '2026-10-16T04:41:00Z', kind: 'notice' }),
  );
  const night = store.send(
    'vader',
    command('luke', 'Night check', { deliver_at: '2026-10-16T01:00:00Z', priority: 'important' }),
  );
  const vader = activate(store, 'vader');
  store.close();

  // The broker is down from 22:00 to 01:30 UTC; the night check falls due meanwhile.
  now = Date.parse('2026-10-16T01:30:00Z');
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  assert.deepEqual(store.releaseDue(), { released: 1, occurrences: 0 });
  const late = store.messages('luke').items[0]!;
  assert.deepEqual(
    [late.id, late.deliver_at, late.delivered_at, late.late],
    [night.message.id, '2026-10-16T01:00:00.000Z', '2026-10-16T01:30:00.000Z', true],
  );
  // Luke binds only after that delivery, so for Luke it is backlog: a hint naming it.
  const luke = activate(store, 'luke');
  const hint = store.nextNotification('luke', luke)!;
  assert.equal(hint.truncated, true);
  assert.deepEqual(
    hint.covered?.map((header) => header.id),
    [night.message.id],
  );
  // Vader's runtime survived the restart; its morning notice arrives on time as a push.
  store.claimRuntime('vader', vader.runtime_id, vader.generation);
  now = Date.parse('2026-10-16T04:41:00.500Z');
  assert.deepEqual(store.releaseDue(), { released: 1, occurrences: 0 });
  const push = store.nextNotification('vader', vader)!;
  assert.equal(push.messages[0]?.id, morning.message.id);
  assert.equal(push.messages[0]?.late, false);
  assert.equal(push.messages[0]?.kind, 'notice');
});

test('scheduled sends keep retry IDs idempotent and can be cancelled until delivered', (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  provision(store, 'luke');
  provision(store, 'leia');
  const vader = activate(store, 'vader');
  const leia = activate(store, 'leia');
  const request = command('luke', 'Report after 06:40', {
    deliver_at: '2026-10-16T06:40:00+02:00',
  });
  const first = store.send('vader', request);
  // The same instant written another way is the same request; another instant is not.
  assert.equal(
    store.send('vader', { ...request, deliver_at: '2026-10-16T04:40:00.000Z' }).duplicate,
    true,
  );
  assert.throws(
    () => store.send('vader', { ...request, deliver_at: '2026-10-16T06:41:00+02:00' }),
    rejectsCode('idempotency_conflict'),
  );
  assert.throws(
    () => store.send('vader', { ...request, deliver_at: undefined }),
    rejectsCode('idempotency_conflict'),
  );
  assert.throws(
    () => store.cancelScheduled('leia', leia, first.message.id),
    rejectsCode('not_found'),
  );
  assert.throws(
    () => store.cancelScheduled('vader', { ...vader, generation: 99 }, first.message.id),
    rejectsCode('stale_runtime'),
  );
  const cancelled = store.cancelScheduled('vader', vader, first.message.id);
  assert.equal(cancelled.cancelled, 'message');
  assert.equal(cancelled.already_cancelled, false);
  assert.ok(cancelled.cancelled === 'message' && cancelled.message.cancelled_at);
  assert.deepEqual(
    cancelled.cancelled === 'message' &&
      cancelled.message.deliveries!.map((delivery) => delivery.delivery_state),
    ['cancelled'],
  );
  assert.equal(store.cancelScheduled('vader', vader, first.message.id).already_cancelled, true);
  now = Date.parse('2026-10-16T05:00:00Z');
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 0 });
  assert.deepEqual(store.messages('luke', { mode: 'history' }).items, []);
  // A retry after the time has passed returns the original, cancelled message.
  const retry = store.send('vader', request);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.id, first.message.id);
  assert.deepEqual(
    retry.deliveries.map((delivery) => delivery.delivery_state),
    ['cancelled'],
  );
  // A delivered message cannot be recalled; nor can an ordinary one be cancelled.
  const soon = store.send(
    'vader',
    command('luke', 'soon', { deliver_at: new Date(now + 1000).toISOString() }),
  );
  now += 1000;
  store.releaseDue();
  assert.throws(
    () => store.cancelScheduled('vader', vader, soon.message.id),
    rejectsCode('already_delivered'),
  );
  const plain = store.send('vader', command('luke', 'plain'));
  assert.throws(
    () => store.cancelScheduled('vader', vader, plain.message.id),
    rejectsCode('not_found'),
  );
  assert.throws(
    () => store.send('vader', command('luke', 'x', { client_request_id: 'pocolobby:mine' })),
    rejectsCode('reserved_request_id'),
  );
  // A sender disabled before its message falls due does not deliver it.
  const pending = store.send(
    'leia',
    command('luke', 'from leia', { deliver_at: new Date(now + 1000).toISOString() }),
  );
  store.updateAgent('leia', { enabled: false });
  now += 1000;
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 0 });
  assert.ok(store.scheduled('leia').messages.length === 0);
  assert.equal(
    store.messages('leia', { mode: 'history' }).items.find((m) => m.id === pending.message.id)
      ?.deliveries?.[0]?.delivery_state,
    'cancelled',
  );

  const bounded = memory(t, { now: () => now, maxScheduledPerSender: 1 });
  provision(bounded, 'vader');
  provision(bounded, 'luke');
  const later = new Date(now + 3_600_000).toISOString();
  bounded.send('vader', command('luke', 'one', { deliver_at: later }));
  assert.throws(
    () => bounded.send('vader', command('luke', 'two', { deliver_at: later })),
    rejectsCode('schedule_capacity'),
  );
  bounded.send('vader', command('luke', 'immediate sends are unaffected'));
});

test('a daily schedule sends real messages at 06:41 Stockholm time across the DST change', (t) => {
  let now = Date.parse('2026-10-23T12:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  const vader = activate(store, 'vader');
  const input = {
    client_request_id: 'morning-notice',
    to: 'vader',
    content: 'Morning notice: read the overnight reports',
    kind: 'notice' as const,
    repeat: { time_zone: 'europe/stockholm', times: ['06:41'] },
  };
  const created = store.createSchedule('vader', vader, input);
  assert.equal(created.duplicate, false);
  const schedule = created.schedule;
  assert.deepEqual(schedule.repeat, {
    time_zone: 'Europe/Stockholm',
    times: ['06:41'],
    weekdays: null,
  });
  assert.equal(schedule.next_occurrence_at, '2026-10-24T04:41:00.000Z');
  assert.equal(schedule.next_occurrence_local, 'Sat 2026-10-24 06:41 Europe/Stockholm');
  assert.deepEqual(
    [schedule.kind, schedule.reply_expected, schedule.to],
    ['notice', false, 'vader'],
  );
  assert.deepEqual(store.context('vader').scheduled, { schedules: 1, messages: 0 });
  assert.equal(store.createSchedule('vader', vader, input).duplicate, true);
  assert.throws(
    () =>
      store.createSchedule('vader', vader, {
        ...input,
        repeat: { time_zone: 'Europe/Stockholm', times: ['06:42'] },
      }),
    rejectsCode('idempotency_conflict'),
  );
  // Summer time ends on 2026-10-25; the local time stays 06:41.
  for (const due of [
    '2026-10-24T04:41:00.000Z',
    '2026-10-25T05:41:00.000Z',
    '2026-10-26T05:41:00.000Z',
  ]) {
    now = Date.parse(due) - 1;
    assert.equal(store.releaseDue().occurrences, 0);
    now = Date.parse(due);
    assert.equal(store.releaseDue().occurrences, 1);
    assert.equal(store.releaseDue().occurrences, 0);
    const push = store.nextNotification('vader', vader)!;
    const message = push.messages[0]!;
    assert.deepEqual(
      [message.schedule_id, message.deliver_at, message.late, message.kind, message.from],
      [schedule.schedule_id, due, false, 'notice', 'vader'],
    );
    store.acknowledge('vader', vader, [message.id]);
  }
  const listed = store.scheduled('vader').schedules[0]!;
  assert.equal(listed.occurrence_count, 3);
  assert.equal(listed.next_occurrence_at, '2026-10-27T05:41:00.000Z');
  assert.equal(listed.last_error, null);
  const history = store.messages('vader', { mode: 'history' }).items;
  assert.equal(history.filter((m) => m.schedule_id === schedule.schedule_id).length, 3);
  assert.equal(listed.last_message_id, history.at(-1)!.id);
});

test('a schedule missed during downtime sends one late occurrence; skips and cancels are visible', (t) => {
  const path = join(directory(t), 'lobby.sqlite');
  let now = Date.parse('2026-10-15T20:00:00Z');
  const options = { now: () => now, infoDelayMs: 0 };
  let store = new LobbyStore(path, options);
  store.createLobby(LOBBY);
  provision(store, 'vader');
  provision(store, 'luke');
  const vader = activate(store, 'vader');
  // Vader's hourly night check, 23:00 to 03:00 Stockholm time.
  const night = store.createSchedule('vader', vader, {
    client_request_id: 'night-check',
    to: 'vader',
    content: 'Hourly night check',
    repeat: {
      time_zone: 'Europe/Stockholm',
      times: ['23:00', '00:00', '01:00', '02:00', '03:00'],
    },
  }).schedule;
  assert.equal(night.next_occurrence_at, '2026-10-15T21:00:00.000Z');
  const toLuke = store.createSchedule('vader', vader, {
    client_request_id: 'luke-check',
    to: 'luke',
    content: 'Status?',
    kind: 'question',
    options: ['fine', 'blocked'],
    repeat: { time_zone: 'Europe/Stockholm', times: ['02:00'] },
  }).schedule;
  store.close();

  // Down from 22:00 to 01:30 local time: 23:00, 00:00 and 01:00 were missed.
  now = Date.parse('2026-10-15T23:30:00Z');
  store = new LobbyStore(path, options);
  t.after(() => store.close());
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 1 });
  const occurrences = () =>
    store
      .messages('vader', { mode: 'history' })
      .items.filter((message) => message.schedule_id === night.schedule_id);
  assert.deepEqual(
    occurrences().map((message) => [message.deliver_at, message.delivered_at, message.late]),
    [['2026-10-15T23:00:00.000Z', '2026-10-15T23:30:00.000Z', true]],
  );
  assert.equal(
    store.scheduled('vader').schedules.find((s) => s.schedule_id === night.schedule_id)
      ?.next_occurrence_at,
    '2026-10-16T00:00:00.000Z',
  );
  // An occurrence that may no longer be sent is skipped with its reason; the schedule goes on.
  store.updateAgent('luke', { enabled: false });
  now = Date.parse('2026-10-16T00:00:00Z');
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 1 });
  const skipped = store
    .scheduled('vader')
    .schedules.find((s) => s.schedule_id === toLuke.schedule_id)!;
  assert.deepEqual(
    [skipped.last_error, skipped.occurrence_count, skipped.next_occurrence_at],
    ['recipient_disabled', 0, '2026-10-17T00:00:00.000Z'],
  );
  store.updateAgent('luke', { enabled: true });
  // Cancelling stops future occurrences.
  const cancelled = store.cancelScheduled('vader', vader, night.schedule_id);
  assert.equal(cancelled.cancelled, 'schedule');
  assert.equal(store.cancelScheduled('vader', vader, night.schedule_id).already_cancelled, true);
  now = Date.parse('2026-10-16T01:00:00Z');
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 0 });
  assert.equal(occurrences().length, 2);
  assert.deepEqual(
    store.scheduled('vader').schedules.map((s) => s.schedule_id),
    [toLuke.schedule_id],
  );
  now = Date.parse('2026-10-17T00:00:00Z');
  assert.deepEqual(store.releaseDue(), { released: 0, occurrences: 1 });
  const question = store.messages('luke').items[0]!;
  assert.deepEqual(
    [question.kind, question.options, question.schedule_id],
    ['question', ['fine', 'blocked'], toLuke.schedule_id],
  );
  // Creation checks authorization and bounds now; occurrences check them again later.
  assert.throws(
    () =>
      store.createSchedule('vader', vader, {
        client_request_id: 'everyone',
        to: '*',
        content: 'Lobby news',
        repeat: { time_zone: 'Europe/Stockholm', times: ['09:00'] },
      }),
    rejectsCode('broadcast_forbidden'),
  );
  assert.throws(() =>
    store.createSchedule('vader', vader, {
      client_request_id: 'bad-zone',
      to: 'vader',
      content: 'x',
      repeat: { time_zone: 'Stockholm', times: ['09:00'] },
    }),
  );
  const limited = memory(t, { maxSchedulesPerSender: 1 });
  provision(limited, 'vader');
  const binding = activate(limited, 'vader');
  const repeat = { time_zone: 'UTC', times: ['09:00'] };
  limited.createSchedule('vader', binding, {
    client_request_id: 'a',
    to: 'vader',
    content: 'a',
    repeat,
  });
  assert.throws(
    () =>
      limited.createSchedule('vader', binding, {
        client_request_id: 'b',
        to: 'vader',
        content: 'b',
        repeat,
      }),
    rejectsCode('schedule_capacity'),
  );
});

test('message kinds and structured fields are validated, bounded, kept and pushed', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'luke');
  provision(store, 'lando');
  const lando = activate(store, 'lando');
  const notice = store.send(
    'luke',
    command('lando', 'Film list updated', {
      kind: 'notice',
      commit: 'abc1234',
      files: ['films/list.md'],
      evidence: 'dropbox:MDP/films/2026-10-15',
    }),
  );
  assert.deepEqual(
    [
      notice.message.kind,
      notice.message.reply_expected,
      notice.message.commit,
      notice.message.files,
      notice.message.evidence,
    ],
    ['notice', false, 'abc1234', ['films/list.md'], 'dropbox:MDP/films/2026-10-15'],
  );
  const question = store.send(
    'luke',
    command('lando', 'Which cut?', {
      kind: 'question',
      options: ['Short cut', 'Long cut'],
      recommendation: 'Short cut: it fits the slot.',
    }),
  );
  assert.equal(question.message.reply_expected, true);
  const quiet = store.send(
    'luke',
    command('lando', 'Do it when you can', { kind: 'assignment', reply_expected: false }),
  );
  assert.equal(quiet.message.reply_expected, false);
  // Without a kind the sender chose none, so no reply expectation is claimed either.
  const plain = store.send('luke', command('lando', 'Plain'));
  assert.deepEqual([plain.message.kind, plain.message.reply_expected], [null, null]);
  const unkindQuiet = store.send('luke', command('lando', 'FYI', { reply_expected: false }));
  assert.deepEqual([unkindQuiet.message.kind, unkindQuiet.message.reply_expected], [null, false]);
  const explicit = store.send('luke', command('lando', 'Please', { kind: 'request' }));
  assert.deepEqual([explicit.message.kind, explicit.message.reply_expected], ['request', true]);
  for (const field of ['commit', 'files', 'evidence', 'options', 'recommendation', 'deliver_at'])
    assert.equal(Object.hasOwn(plain.message, field), false);
  // A report carries results: like a notice, it expects no reply unless the sender says so.
  const report = store.send('luke', command('lando', 'Done: abc1234', { kind: 'report' }));
  assert.equal(report.message.reply_expected, false);
  // Retry fingerprints keep the earlier default, so a report sent with an explicit
  // reply_expected: true before the change still matches its retry.
  const asked = command('lando', 'Done, please confirm', { kind: 'report', reply_expected: true });
  const first = store.send('luke', asked);
  assert.equal(first.message.reply_expected, true);
  assert.equal(store.send('luke', asked).message.id, first.message.id);

  const push = store.nextNotification('lando', lando)!;
  assert.deepEqual(
    push.messages.map((message) => [message.kind, message.reply_expected]),
    [
      ['notice', false],
      ['question', true],
      ['assignment', false],
      [null, null],
      [null, false],
      ['request', true],
      ['report', false],
      ['report', true],
    ],
  );
  assert.deepEqual(push.messages[1]!.options, ['Short cut', 'Long cut']);
  const history = store.messages('lando', { mode: 'history' }).items;
  assert.equal(history[0]!.evidence, 'dropbox:MDP/films/2026-10-15');
  assert.equal(history[1]!.recommendation, 'Short cut: it fits the slot.');

  for (const invalid of [
    { kind: 'fyi' },
    { evidence: '/Users/johan/Dropbox/MDP/films' },
    { evidence: 'C:\\films' },
    { files: [] },
    { commit: 'two\nlines' },
    { options: Array.from({ length: 11 }, (_, i) => `option ${i}`) },
    { files: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(300, 'x')) },
    { recommendation: 'x'.repeat(2001) },
    { reply_expected: 'no' },
  ])
    assert.throws(
      () => store.send('luke', command('lando', 'x', invalid as Partial<SendInput>)),
      JSON.stringify(invalid).slice(0, 60),
    );
  // A default written out is the same request; a different kind is not.
  const request = command('lando', 'Same request');
  const original = store.send('luke', request);
  assert.equal(
    store.send('luke', { ...request, kind: 'request', reply_expected: true }).message.id,
    original.message.id,
  );
  assert.throws(
    () => store.send('luke', { ...request, kind: 'notice' }),
    rejectsCode('idempotency_conflict'),
  );
});

test('read receipts reach the sender once, coalesced and spaced, never for self or receipts', (t) => {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const store = memory(t, {
    now: () => now,
    infoDelayMs: 0,
    receiptDelayMs: 1_000,
    receiptIntervalMs: 10_000,
  });
  provision(store, 'vader', { manage_rooms: true });
  provision(store, 'luke');
  provision(store, 'leia');
  store.createRoom('vader', 'app');
  store.setRoomMembers('vader', 'app', ['vader', 'luke', 'leia']);
  let vader = activate(store, 'vader');
  const luke = activate(store, 'luke');
  const leia = activate(store, 'leia');
  const assignment = store.send(
    'vader',
    command('*', 'Review the release notes', {
      room: 'app',
      kind: 'assignment',
      notify_when_seen: true,
    }),
  );
  assert.equal(assignment.message.notify_when_seen, true);
  const plain = store.send('vader', command('luke', 'No receipt wanted'));
  const self = store.send('vader', command('vader', 'Note to self', { notify_when_seen: true }));
  assert.equal(store.nextReceipts('vader', vader), null);
  store.acknowledge('luke', luke, [assignment.message.id, plain.message.id]);
  store.acknowledge('vader', vader, [self.message.id]);
  // Receipts wait briefly so that close ones share an event.
  assert.equal(store.nextReceipts('vader', vader), null);
  now += 500;
  store.acknowledge('leia', leia, [assignment.message.id]);
  now += 1_000;
  const event = store.nextReceipts('vader', vader)!;
  assert.equal(event.type, 'receipts');
  assert.deepEqual(
    event.receipts.map((receipt) => [
      receipt.message_id,
      receipt.seen_by,
      receipt.kind,
      receipt.room_id,
    ]),
    [
      [assignment.message.id, 'luke', 'assignment', 'app'],
      [assignment.message.id, 'leia', 'assignment', 'app'],
    ],
  );
  assert.equal(event.receipts[0]!.excerpt, 'Review the release notes');
  assert.equal(event.remaining, 0);
  // Each receipt is pushed once. A receipt is no message: it enters no inbox, so acknowledging
  // it records nothing, like a message no longer stored, and it is never the subject of another.
  assert.equal(store.nextReceipts('vader', vader), null);
  assert.equal(store.agent('vader').pending_count, 0);
  const snapshot = store.context('vader').receipt_snapshot;
  store.acknowledge('vader', vader, [event.notification_id]);
  assert.equal(store.context('vader').receipt_snapshot, snapshot);

  // Receipt events to one agent are spaced; a long burst is split across events.
  const burst = Array.from(
    { length: 25 },
    (_, n) =>
      store.send('vader', command('luke', `Item ${n}`, { notify_when_seen: true })).message.id,
  );
  store.acknowledge('luke', luke, burst);
  now += 2_000;
  assert.equal(store.nextReceipts('vader', vader), null);
  now += 10_000;
  const first = store.nextReceipts('vader', vader)!;
  assert.deepEqual([first.receipts.length, first.remaining], [20, 5]);
  now += 10_001;
  const rest = store.nextReceipts('vader', vader)!;
  assert.deepEqual([rest.receipts.length, rest.remaining], [5, 0]);
  assert.deepEqual(
    [...first.receipts, ...rest.receipts].map((receipt) => receipt.message_id),
    burst,
  );

  // An unready runtime gets none; receipts older than a day are dropped, but history keeps
  // the seen fact. The owner cannot ask for receipts.
  vader = store.claimRuntime('vader', vader.runtime_id);
  const late = store.send('vader', command('luke', 'Old news', { notify_when_seen: true }));
  store.acknowledge('luke', luke, [late.message.id]);
  now += 20_000;
  assert.equal(store.nextReceipts('vader', vader), null);
  now += 25 * 60 * 60 * 1000;
  store.ready('vader', vader, { context_revision: 0, probe_nonce: vader.probe_nonce });
  assert.equal(store.nextReceipts('vader', vader), null);
  assert.equal(
    store
      .messages('vader', { mode: 'history', limit: 100 })
      .items.find((m) => m.id === late.message.id)?.deliveries?.[0]?.delivery_state,
    'seen',
  );
  assert.throws(
    () => store.send('owner', command('luke', 'x', { notify_when_seen: true })),
    rejectsCode('receipts_unavailable'),
  );
});

test('64 KiB messages are accepted, and history pages stay within their byte budget', (t) => {
  const store = memory(t, { infoDelayMs: 0 });
  provision(store, 'vader');
  provision(store, 'luke');
  activate(store, 'luke');
  // A builder report with tables, at the new limit; one byte more is refused.
  const report = 'r'.repeat(64 * 1024);
  const big = store.send('vader', command('luke', report)).message.id;
  assert.throws(() => store.send('vader', command('luke', report + 'r')), /64 KiB/);
  // 20 KiB messages: with their fields, three fit the 80 KiB page budget; the cursor continues.
  const ids: string[] = [];
  for (let i = 0; i < 8; i++)
    ids.push(store.send('vader', command('luke', 'p'.repeat(20 * 1024))).message.id);
  const pages: string[][] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = store.messages('luke', { mode: 'pending', limit: 100, cursor });
    pages.push(page.items.map((item) => item.id));
    cursor = page.next_cursor;
  }
  // The 64 KiB report fits alone; the next 20 KiB message would exceed the budget.
  assert.deepEqual(pages, [[big], ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 8)]);
});

test('agents show unseen messages already written to their host, as aggregates only', (t) => {
  // Overnight an account out of usage left Vader unable to take turns while its scheduled
  // checks were written to its session on time; nobody could see that from outside.
  let now = Date.parse('2026-10-16T00:17:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'vader');
  const vader = activate(store, 'vader');
  const write = () => {
    const push = store.nextNotification('vader', vader)!;
    for (const type of ['adapter_received', 'notification_attempted'] as const)
      store.recordTransport('vader', vader, { type, notification_id: push.notification_id });
  };
  const facts = () => {
    const agent = store.agent('vader');
    return [agent.unseen_notified_count, agent.oldest_unseen_notified_at];
  };
  assert.deepEqual(facts(), [0, null]);
  const first = store.send('owner', command('vader', 'night check 00:17'));
  // Stored but not yet written to the host: not counted.
  assert.deepEqual(facts(), [0, null]);
  write();
  assert.deepEqual(facts(), [1, '2026-10-16T00:17:00.000Z']);
  now = Date.parse('2026-10-16T01:17:00Z');
  const second = store.send('owner', command('vader', 'night check 01:17'));
  write();
  assert.deepEqual(facts(), [2, '2026-10-16T00:17:00.000Z']);
  // A scheduled message is held until its time, so it is not counted.
  store.send('owner', command('vader', 'later', { deliver_at: '2026-10-16T05:00:00Z' }));
  assert.deepEqual(facts(), [2, '2026-10-16T00:17:00.000Z']);
  // Only acknowledgment clears it; acknowledging the oldest moves the time forward.
  store.acknowledge('vader', vader, [first.message.id]);
  assert.deepEqual(facts(), [1, '2026-10-16T01:17:00.000Z']);
  store.acknowledge('vader', vader, [second.message.id]);
  assert.deepEqual(facts(), [0, null]);
});

test('a message an agent left unacknowledged while it kept working no longer counts as unseen', (t) => {
  // Gonk acknowledged later messages and sent its own, but never acknowledged one room FYI, and
  // the board showed it Not responding. Only messages written since its latest progress count.
  let now = Date.parse('2026-10-16T15:52:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0 });
  provision(store, 'gonk');
  provision(store, 'vader');
  const gonk = activate(store, 'gonk');
  const write = () => {
    const push = store.nextNotification('gonk', gonk)!;
    for (const type of ['adapter_received', 'notification_attempted'] as const)
      store.recordTransport('gonk', gonk, { type, notification_id: push.notification_id });
  };
  const facts = () => {
    const agent = store.agent('gonk');
    return [agent.unseen_notified_count, agent.oldest_unseen_notified_at, agent.pending_count];
  };
  // Written in the same millisecond as its ready claim: counted.
  store.send('vader', command('gonk', 'FYI', { kind: 'notice' }));
  write();
  assert.deepEqual(facts(), [1, '2026-10-16T15:52:00.000Z', 1]);
  now = Date.parse('2026-10-16T16:10:00Z');
  const request = store.send('vader', command('gonk', 'Can you look?'));
  write();
  now = Date.parse('2026-10-16T16:16:00Z');
  store.acknowledge('gonk', gonk, [request.message.id]);
  // The notice is still pending, but Gonk has acknowledged since it was written.
  assert.deepEqual(facts(), [0, null, 1]);
  // A newer message after that progress counts again, whatever came before it.
  now = Date.parse('2026-10-16T16:18:00Z');
  store.send('vader', command('gonk', 'And this?'));
  write();
  assert.deepEqual(facts(), [1, '2026-10-16T16:18:00.000Z', 2]);
  // Sending a message is progress too.
  now = Date.parse('2026-10-16T16:21:00Z');
  store.send('gonk', command('vader', 'On it'));
  assert.deepEqual(facts(), [0, null, 2]);
});

test(
  'a new database and its write-ahead log are private from the first write',
  { skip: process.platform === 'win32' && 'POSIX modes' },
  (t) => {
    const path = join(directory(t), 'fresh.sqlite');
    const store = new LobbyStore(path);
    store.createLobby(LOBBY);
    t.after(() => store.close());
    provision(store, 'vader');
    for (const file of [path, `${path}-wal`])
      assert.equal(statSync(file).mode & 0o777, 0o600, file);
  },
);

test('a held scheduled room message stays hidden from its recipient, also once cancelled', (t) => {
  const now = Date.parse('2026-10-16T08:00:00Z');
  const store = memory(t, { now: () => now });
  provision(store, 'vader', { manage_rooms: true });
  provision(store, 'luke');
  store.createRoom('vader', 'app');
  store.setRoomMembers('vader', 'app', ['vader', 'luke']);
  const scheduled = store.send(
    'vader',
    command('*', 'Tomorrow: the export dialog', {
      room: 'app',
      kind: 'question',
      deliver_at: '2026-10-17T08:00:00Z',
    }),
  );
  const visible = () => store.messages('luke', { mode: 'history' }).items.map((item) => item.id);
  assert.deepEqual(visible(), []);
  // Removing luke holds the delivery; it must not reveal the message before its time.
  store.setRoomMembers('vader', 'app', ['vader']);
  assert.deepEqual(visible(), []);
  store.cancelScheduled('vader', null, scheduled.message.id);
  assert.deepEqual(visible(), []);
  // The sender still sees it.
  assert.deepEqual(
    store.messages('vader', { mode: 'history' }).items.map((item) => item.id),
    [scheduled.message.id],
  );
});

test('notification attempts older than a day go unless a delivery still names them', (t) => {
  let now = Date.parse('2026-10-16T08:00:00Z');
  const store = memory(t, { now: () => now, infoDelayMs: 0, retryDelaysMs: [1_000, 1_000] });
  provision(store, 'vader');
  provision(store, 'luke');
  const luke = activate(store, 'luke');
  store.send('vader', command('luke', 'first'));
  assert.ok(store.nextNotification('luke', luke));
  // Unseen, the message is notified again; its delivery now names only the second attempt.
  now += 2_000;
  assert.ok(store.nextNotification('luke', luke));
  now += 2 * 86_400_000;
  assert.equal(store.pruneNotificationAttempts(now), 1);
  assert.equal(store.pruneNotificationAttempts(now), 0);
});

test('content is bounded as it serializes, so one message always fits a page', (t) => {
  // A review sent 64 KiB of newlines and quotes: accepted, it serialized to 128 KiB and broke
  // the page bound of 80 KiB, because the first message of a page is always returned.
  const store = memory(t);
  provision(store, 'vader');
  provision(store, 'luke');
  const vader = activate(store, 'vader');
  assert.throws(
    () => store.send('vader', command('luke', '\n"'.repeat(32 * 1024))),
    rejectsCode('content_too_large'),
  );
  assert.throws(
    () =>
      store.createSchedule('vader', vader, {
        client_request_id: 'too-large',
        to: 'luke',
        content: '\n"'.repeat(32 * 1024),
        repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'] },
      }),
    rejectsCode('content_too_large'),
  );
  // Exactly 64 KiB once escaped is accepted and reads within one page.
  store.send('vader', command('luke', '\n"'.repeat(16 * 1024), { files: ['a'.repeat(300)] }));
  const page = store.messages('luke');
  assert.equal(page.items.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_PAGE_BYTES);
});

test('a full queue of scheduled broadcasts still lists within one response', (t) => {
  // A review found a legal queue the bundled client could not read: every item carried its
  // structured fields and all 99 recipients' delivery facts, over 2 MiB in all.
  let now = Date.parse('2026-10-16T08:00:00Z');
  const store = memory(t, { now: () => now });
  provision(store, 'vader', { can_broadcast: true });
  for (let index = 0; index < 99; index++)
    provision(store, `recipient-${String(index).padStart(38, '0')}`);
  const files = Array.from({ length: 50 }, (_, index) => `src/${index}/${'f'.repeat(100)}`);
  for (let index = 0; index < 100; index++) {
    if (index === 60) now += 60_000;
    store.send(
      'vader',
      command('*', `${index} ${'x'.repeat(1_000)}`, {
        deliver_at: '2026-10-16T10:00:00Z',
        files,
        recommendation: 'r'.repeat(2_000),
      }),
    );
  }
  const listing = store.scheduled('vader');
  assert.equal(listing.messages.length, 100);
  // The bundled client reads at most 2 MiB; the listing is a small fraction of that.
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 128 * 1024);
  const first = listing.messages[0]!;
  assert.equal(first.recipients, 99);
  assert.equal(first.content.length, 300);
  assert.equal(first.content_truncated, true);
  assert.equal('files' in first || 'recommendation' in first || 'deliveries' in first, false);
  // The sender's history keeps the whole message.
  const history = store.messages('vader', { mode: 'history', limit: 1 }).items[0]!;
  assert.equal(history.content.length, 1_002);
  assert.deepEqual(history.files, files);
});

test('a history page is bounded by what it serializes to, recipients included', (t) => {
  let now = Date.parse('2026-10-16T08:00:00Z');
  const store = memory(t, { now: () => now });
  provision(store, 'vader', { can_broadcast: true });
  for (let index = 0; index < 60; index++)
    provision(store, `agent-${String(index).padStart(2, '0')}-${'x'.repeat(39)}`);
  for (let index = 0; index < 30; index++) {
    now += 2_000;
    store.send('vader', command('*', `plan ${index}`));
  }
  const page = store.messages('vader', { mode: 'history', limit: 100 });
  // Each item carries 60 recipients' facts; the page stops near the budget and continues.
  assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 80 * 1024 + 4 * 1024);
  assert.ok(page.items.length < 30);
  assert.notEqual(page.next_cursor, null);
  const rest = store.messages('vader', { mode: 'history', limit: 100, cursor: page.next_cursor! });
  assert.equal(rest.items[0]!.content, `plan ${page.items.length}`);
});

test('the audit log keeps each lobby’s newest 10,000 events', (t) => {
  // A credential resuming its runtime in a loop writes one event per request; nothing pruned them.
  const store = memory(t);
  for (let index = 0; index < 5_003; index++) {
    store.createRoom('owner', 'scratch', LOBBY);
    store.deleteRoom('owner', 'scratch', LOBBY);
  }
  const before = store.activity(LOBBY, 20_000);
  // The lobby's creation and 10,006 room events.
  assert.equal(before.length, 10_007);
  assert.equal(store.pruneAdminEvents(), 7);
  const after = store.activity(LOBBY, 20_000);
  assert.equal(after.length, 10_000);
  assert.deepEqual(after[0], before[0]);
  assert.equal(store.pruneAdminEvents(), 0);
});

test('a room message can name some members: only they receive it, still in the room', (t) => {
  const store = memory(t, { infoDelayMs: 0, receiptDelayMs: 0 });
  for (const id of ['vader', 'leia', 'luke', 'mouse', 'gonk', 'outsider']) provision(store, id);
  store.updateAgent('vader', { manage_rooms: true });
  store.createRoom('vader', 'builders');
  store.setRoomMembers('vader', 'builders', ['vader', 'leia', 'luke', 'mouse', 'gonk']);
  const vader = activate(store, 'vader');
  const leia = activate(store, 'leia');
  activate(store, 'mouse');

  const request = command(['luke', 'leia'] as never, 'Leia and Luke: check 77bb9f0', {
    room: 'builders',
  });
  const sent = store.send('vader', request);
  assert.deepEqual(
    sent.deliveries.map((delivery) => delivery.agent_id),
    ['leia', 'luke'],
  );
  // On the wire it stays a room message; the names travel beside it.
  assert.equal(sent.message.to, '*');
  assert.equal(sent.message.room_id, 'builders');
  assert.deepEqual(sent.message.addressed_to, ['leia', 'luke']);
  // The same names in another order are the same request.
  const retry = store.send('vader', { ...request, to: ['leia', 'luke'] as never });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.id, sent.message.id);

  const inbox = (id: string) => store.messages(id, { mode: 'pending' }).items;
  assert.deepEqual(
    inbox('leia').map((message) => message.addressed_to),
    [['leia', 'luke']],
  );
  assert.deepEqual(inbox('mouse'), []);
  assert.deepEqual(inbox('gonk'), []);
  const event = store.nextNotification('leia', leia)!;
  assert.deepEqual(event.messages[0]!.addressed_to, ['leia', 'luke']);
  assert.equal(event.messages[0]!.to, '*');
  const history = store.messages('vader', { mode: 'history' }).items[0]!;
  assert.deepEqual(history.addressed_to, ['leia', 'luke']);
  assert.deepEqual(
    history.deliveries!.map((delivery) => delivery.agent_id),
    ['leia', 'luke'],
  );
  // Stored as a room message whose structured fields hold the names, so a broker image from before
  // 0.8.2, after a rollback, still delivers it as a room message, to exactly these deliveries.
  const row = (store as unknown as { db: DatabaseSync }).db
    .prepare('SELECT target,details FROM messages WHERE id=?')
    .get(sent.message.id) as { target: string; details: string };
  assert.deepEqual(
    [row.target, JSON.parse(row.details)],
    ['*', { addressed_to: ['leia', 'luke'] }],
  );
  // A whole-room message still names nobody.
  const whole = store.send('vader', command('*', 'everyone', { room: 'builders' }));
  assert.equal(Object.hasOwn(whole.message, 'addressed_to'), false);
  assert.equal(whole.deliveries.length, 4);

  // One name that cannot receive it refuses the whole send.
  const named = (to: string[], extra: Partial<SendInput> = {}) =>
    store.send('vader', command(to as never, 'some', { room: 'builders', ...extra }));
  assert.throws(() => named(['leia', 'outsider']), rejectsCode('not_room_member'));
  assert.throws(() => named(['leia', 'vader']), rejectsCode('recipient_is_sender'));
  assert.throws(
    () => named(['leia', 'leia']),
    (error: unknown) => error instanceof ZodError,
  );
  assert.throws(
    () => store.send('vader', command(['leia'] as never, 'no room')),
    (error: unknown) => error instanceof ZodError,
  );
  store.updateAgent('gonk', { enabled: false });
  assert.throws(() => named(['leia', 'gonk']), rejectsCode('recipient_disabled'));
  store.updateAgent('leia', { allowed_recipients: ['vader'] });
  assert.throws(
    () => store.send('leia', command(['luke'] as never, 'x', { room: 'builders' })),
    rejectsCode('recipient_forbidden'),
  );
  assert.equal(inbox('luke').length, 2);

  // Receipts to the sender keep to "*" and carry the names.
  const asked = named(['leia'], { notify_when_seen: true });
  store.acknowledge('leia', leia, [asked.message.id]);
  const receipts = store.nextReceipts('vader', vader)!;
  assert.equal(receipts.receipts[0]!.to, '*');
  assert.deepEqual(receipts.receipts[0]!.addressed_to, ['leia']);

  // A schedule may name members too; each occurrence checks them again.
  const daily = store.createSchedule('vader', vader, {
    client_request_id: 'daily-pair',
    to: ['luke', 'leia'] as never,
    room: 'builders',
    content: 'Pair check-in',
    repeat: { time_zone: 'Europe/Stockholm', times: ['06:41'] },
  });
  assert.equal(daily.schedule.to, '*');
  assert.deepEqual(daily.schedule.addressed_to, ['leia', 'luke']);
});

test('history search matches text, fields and file names literally, and only what the reader may see', (t) => {
  const store = memory(t);
  for (const id of ['vader', 'leia', 'luke']) provision(store, id);
  store.updateAgent('vader', { manage_rooms: true });
  store.createRoom('vader', 'app');
  store.setRoomMembers('vader', 'app', ['vader', 'leia', 'luke']);
  store.send('vader', command('leia', 'Finding B4: the PDF drops shadows'));
  store.send('vader', command('leia', 'Unrelated', { evidence: 'dropbox:MDP/findings/b4' }));
  store.send('vader', command('leia', '100% done_now'));
  store.send('vader', command('leia', '100 percent'));
  const secret = store.send('vader', command('*', 'Room secret B4', { room: 'app' }));
  const search = (id: string, query: string) =>
    store.messages(id, { mode: 'history', query }).items.map((message) => message.content);
  assert.deepEqual(search('leia', 'b4'), [
    'Finding B4: the PDF drops shadows',
    'Unrelated',
    'Room secret B4',
  ]);
  // % and _ are themselves, not wildcards.
  assert.deepEqual(search('leia', '100%'), ['100% done_now']);
  assert.deepEqual(search('leia', 'e_n'), ['100% done_now']);
  // Leia leaves the room: the held message no longer matches, though its sender's does.
  store.setRoomMembers('vader', 'app', ['vader', 'luke']);
  assert.deepEqual(search('leia', 'secret'), []);
  assert.deepEqual(search('vader', 'secret'), ['Room secret B4']);
  assert.equal(secret.message.room_id, 'app');
  assert.throws(
    () => store.messages('leia', { mode: 'pending', query: 'b4' }),
    rejectsCode('query_needs_history'),
  );
});

test('acknowledgments name the IDs that matched nothing in the inbox', (t) => {
  const store = memory(t);
  provision(store, 'vader');
  provision(store, 'leia');
  const leia = activate(store, 'leia');
  const sent = store.send('vader', command('leia', 'hello'));
  const stray = randomUUID();
  assert.deepEqual(store.acknowledge('leia', leia, [sent.message.id, stray]), {
    receipt_snapshot: 1,
    unknown_message_ids: [stray],
  });
  assert.deepEqual(store.acknowledge('leia', leia, [sent.message.id]), { receipt_snapshot: 1 });
  // A checkpoint's acknowledgments name them too, and its other changes still count.
  const saved = store.checkpoint('leia', leia, {
    expected_revision: 0,
    content: 'Read the hello',
    covered_receipt_seq: 1,
    acknowledge_message_ids: [stray],
  });
  assert.deepEqual([saved.revision, saved.unknown_message_ids], [1, [stray]]);
});

test('unanswered lists requests that have no reply of yours that reached the asker', (t) => {
  // Vader, 2026-10-17 03:00: about 15 questions a night from five agents, kept in memory.
  const now = Date.parse('2026-10-17T01:00:00Z');
  const store = memory(t, { now: () => now });
  for (const id of ['vader', 'leia', 'luke', 'mouse']) provision(store, id);
  const q1 = store.send('leia', command('vader', 'Which branch?', { kind: 'question' }));
  const q2 = store.send('luke', command('vader', 'Review 77bb9f0', { kind: 'request' }));
  store.send('mouse', command('vader', 'FYI: tests pass', { kind: 'notice' }));
  store.send('vader', command('leia', 'main', { kind: 'report', reply_to: q1.message.id }));
  // A reply still scheduled, or one that went to someone else, does not answer it.
  store.send(
    'vader',
    command('luke', 'Tomorrow', {
      reply_to: q2.message.id,
      deliver_at: new Date(now + 60 * 60_000).toISOString(),
    }),
  );
  store.send('vader', command('mouse', 'About Luke’s review', { reply_to: q2.message.id }));
  const open = () =>
    store
      .messages('vader', { mode: 'history', unanswered: true })
      .items.map((message) => message.id);
  assert.deepEqual(open(), [q2.message.id]);
  store.send('vader', command('luke', 'Looks good', { reply_to: q2.message.id }));
  assert.deepEqual(open(), []);
  assert.throws(
    () => store.messages('vader', { mode: 'pending', unanswered: true }),
    rejectsCode('unanswered_needs_history'),
  );
});
