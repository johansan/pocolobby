import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { NotificationSchema } from '../src/adapters/claude.js';
import { markdownHeadings, type AttachmentMime } from '../src/attachments.js';
import {
  buildCatalog,
  defaultTools,
  toolGuide,
  type CatalogEntry,
  type ToolCatalog,
} from '../src/catalog.js';
import { encodePng } from '../src/png.js';
import { LobbyStore } from '../src/store.js';
import { startServer, wireEvent, type ServerOptions } from '../src/server.js';
import {
  LobbyError,
  MAX_PUSH_BYTES,
  MAX_EVENT_FRAME_BYTES,
  type AgentContext,
  type Message,
  type NotificationEvent,
  type RuntimeBinding,
  type SendInput,
  type StoredMessage,
} from '../src/protocol.js';
import { createLobby } from './lobby.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A small screenshot-like PNG; the seed makes distinct contents, noise makes it large. */
const png = (seed: number, width = 32, height = 24, noise = false) =>
  encodePng({
    width,
    height,
    data: noise
      ? Uint8Array.from(randomBytes(width * height * 4), (value, i) => (i % 4 === 3 ? 255 : value))
      : Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * seed) % 251),
  });
const describe = (bytes: Buffer, filename: string, mime_type = 'image/png') => ({
  sha256: sha(bytes),
  filename,
  mime_type: mime_type as AttachmentMime,
  size: bytes.length,
});
const code = (expected: string) => (error: unknown) => {
  assert(error instanceof LobbyError, String(error));
  assert.equal(error.code, expected, error.message);
  return true;
};
const temporary = (t: TestContext) => {
  const path = mkdtempSync(join(tmpdir(), 'pocolobby-attachments-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
function storeFixture(t: TestContext, options: ConstructorParameters<typeof LobbyStore>[1] = {}) {
  const directory = temporary(t);
  const store = new LobbyStore(':memory:', {
    attachmentsDir: directory,
    infoDelayMs: 0,
    ...options,
  });
  store.createLobby('my-team');
  t.after(() => store.close());
  const runtimes = new Map<string, RuntimeBinding>();
  const agent = (id: string, lobby = 'my-team') => {
    store.provision({
      agent_id: id,
      lobby_id: lobby,
      role: '',
      can_broadcast: false,
      allowed_recipients: null,
    });
    const binding = store.claimRuntime(`${lobby}/${id}`, randomUUID());
    store.ready(`${lobby}/${id}`, binding, {
      context_revision: 0,
      probe_nonce: binding.probe_nonce,
    });
    runtimes.set(`${lobby}/${id}`, binding);
    return binding;
  };
  const upload = (id: string, bytes: Buffer) =>
    store.uploadAttachment(
      id,
      runtimes.get(id.includes('/') ? id : `my-team/${id}`)!,
      sha(bytes),
      bytes,
    );
  const send = (sender: string, extra: Partial<SendInput> & { to?: string } = {}) =>
    store.send(sender, {
      client_request_id: randomUUID(),
      to: 'luke',
      content: 'See attached',
      ...extra,
    } as SendInput);
  return { store, directory, agent, upload, send, runtimes };
}

test('a screenshot upload and its send are one logical operation, deduplicated and idempotent', (t) => {
  const { store, directory, agent, upload, send } = storeFixture(t);
  agent('vader');
  agent('luke');
  agent('lando');
  const before = png(1);
  const after = png(2);
  const request = {
    client_request_id: 'review-login-screens',
    content: 'Before and after',
    attachments: [describe(before, 'before.png'), describe(after, 'after.png')],
  };
  // Nothing stored yet: the broker names exactly what it needs, and keeps nothing.
  assert.throws(
    () => send('vader', request),
    (error: unknown) => {
      code('attachment_upload_required')(error);
      assert.deepEqual((error as LobbyError).details, { missing: [sha(before), sha(after)] });
      return true;
    },
  );
  assert.equal(store.messages('vader', { mode: 'history' }).items.length, 0);
  upload('vader', before);
  upload('vader', after);
  const stored = send('vader', request);
  assert.deepEqual(
    stored.message.attachments!.map(({ filename, mime_type, size, sha256 }) => [
      filename,
      mime_type,
      size,
      sha256,
    ]),
    [
      ['before.png', 'image/png', before.length, sha(before)],
      ['after.png', 'image/png', after.length, sha(after)],
    ],
  );
  assert.deepEqual(readdirSync(directory).sort(), [sha(before), sha(after)].sort());
  assert.equal(store.attachmentUsage('my-team').pending_uploads, 0);
  // A retry needs no upload and stores no second message.
  const retried = send('vader', request);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.message.id, stored.message.id);
  assert.deepEqual(retried.message.attachments, stored.message.attachments);
  // Different files under the same request ID are a different request.
  assert.throws(
    () => send('vader', { ...request, attachments: [describe(after, 'before.png')] }),
    code('idempotency_conflict'),
  );
  // A new send of the same files reuses the attachments without an upload.
  const again = send('vader', { ...request, client_request_id: 'second-look', to: 'lando' });
  assert.deepEqual(
    again.message.attachments!.map((item) => item.id),
    stored.message.attachments!.map((item) => item.id),
  );
  // The recipient sees them in its inbox.
  const inbox = store.messages('luke');
  assert.deepEqual(
    inbox.items[0]!.attachments!.map((item) => item.filename),
    ['before.png', 'after.png'],
  );
  // Another uploader's identical content is stored once, but knowing a hash is not enough: an
  // agent must upload the bytes itself before it can attach them.
  upload('luke', before);
  assert.equal(readdirSync(directory).length, 2);
  assert.throws(
    () => send('luke', { to: 'vader', attachments: [describe(after, 'after.png')] }),
    code('attachment_upload_required'),
  );
  const forwarded = send('luke', { to: 'vader', attachments: [describe(before, 'before.png')] });
  assert.notEqual(forwarded.message.attachments![0]!.id, stored.message.attachments![0]!.id);

  // A text document, typed by its name and checked as UTF-8.
  const report = Buffer.from('# Research\n\nFindings with å and 漢字.\n');
  upload('vader', report);
  const text = send('vader', {
    attachments: [describe(report, 'research.md', 'text/markdown')],
  });
  assert.equal(text.message.attachments![0]!.mime_type, 'text/markdown');
  assert.deepEqual(
    readFileSync(store.attachmentFile('luke', text.message.attachments![0]!.id).path),
    report,
  );
  // Wrong descriptions and wrong contents are refused.
  assert.throws(() => upload('vader', Buffer.from([0xc3, 0x28])), code('attachment_type'));
  assert.throws(() => {
    const current = store.claimRuntime('vader', store.agent('vader').runtime_id!);
    store.uploadAttachment(
      'vader',
      { ...current, generation: current.generation - 1 },
      sha(after),
      after,
    );
  }, code('stale_runtime'));
  assert.throws(
    () => send('vader', { attachments: [describe(before, 'before.png', 'image/jpeg')] }),
    code('attachment_mismatch'),
  );
  assert.throws(() =>
    send('vader', { attachments: [describe(report, 'report.exe', 'text/plain')] }),
  );
  assert.throws(
    () => send('vader', { attachments: [describe(before, 'a.png'), describe(before, 'a.png')] }),
    /Attach each file once/,
  );
  // The owner cannot attach: only a bridge uploads.
  assert.throws(
    () =>
      store.send('owner', {
        client_request_id: randomUUID(),
        to: 'luke',
        content: 'x',
        attachments: [describe(before, 'before.png')],
      }),
    code('attachments_unavailable'),
  );
});

test('limits refuse cleanly before anything is stored: size, lobby quota and disk reserve', (t) => {
  let free = 10 * 1024 * 1024 * 1024;
  const a = png(3);
  const b = png(4);
  const { directory, agent, upload, send } = storeFixture(t, {
    maxImageBytes: 4000,
    maxTextBytes: 1024,
    maxLobbyAttachmentBytes: a.length + b.length - 1,
    attachmentDiskReserveBytes: 1024 * 1024,
    freeDiskBytes: () => free,
  });
  agent('vader');
  agent('luke');
  // Too large: refused at the send, before any upload, and naming the setting.
  const large = png(5, 200, 200, true);
  assert(large.length > 4000);
  assert.throws(
    () => send('vader', { attachments: [describe(large, 'large.png')] }),
    (error: unknown) =>
      code('attachment_too_large')(error) &&
      /up to 3\.9 KiB \(POCOLOBBY_ATTACHMENT_MAX_IMAGE_BYTES\)/.test((error as Error).message),
  );
  assert.throws(() => upload('vader', large), code('attachment_too_large'));
  const long = Buffer.from('x'.repeat(2000));
  assert.throws(
    () => send('vader', { attachments: [describe(long, 'long.txt', 'text/plain')] }),
    /POCOLOBBY_ATTACHMENT_MAX_TEXT_BYTES/,
  );
  // The lobby quota: the second distinct file does not fit, as upload or as a send.
  upload('vader', a);
  const full = (error: unknown) =>
    code('storage_capacity')(error) &&
    /Attachment storage for lobby my-team is full: .* \(POCOLOBBY_ATTACHMENT_LOBBY_BYTES\)/.test(
      (error as Error).message,
    );
  assert.throws(() => upload('vader', b), full);
  assert.throws(() => send('vader', { attachments: [describe(b, 'b.png')] }), full);
  // Content the lobby already holds costs nothing more.
  upload('luke', a);
  // Disk reserve: refused while free space would drop below it; nothing reaches the disk.
  free = 1024 * 1024 + 10;
  const fresh = storeFixture(t, {
    attachmentDiskReserveBytes: 1024 * 1024,
    freeDiskBytes: () => free,
  });
  fresh.agent('vader');
  assert.throws(
    () => fresh.upload('vader', b),
    (error: unknown) =>
      code('storage_capacity')(error) &&
      /disk is nearly full.*POCOLOBBY_ATTACHMENT_DISK_RESERVE_BYTES/.test((error as Error).message),
  );
  assert.deepEqual(readdirSync(fresh.directory), []);
  // Earlier work stays readable and plain messages still go through.
  const plain = send('vader', { content: 'Without attachments' });
  assert.equal(plain.status, 'stored');
  assert.equal(readdirSync(directory).length, 1);
});

test('retention, unsent uploads and stray files are collected; shared content stays while referenced', (t) => {
  let now = Date.parse('2026-10-20T10:00:00.000Z');
  const minute = 60_000;
  const { store, directory, agent, upload, send, runtimes } = storeFixture(t, {
    now: () => now,
    attachmentGraceMs: 10 * minute,
    attachmentRetentionMs: 60 * minute,
  });
  agent('vader');
  agent('luke');
  agent('lando');
  // An upload no send used is removed after the grace period, with its file.
  const orphan = png(6);
  upload('vader', orphan);
  now += 5 * minute;
  assert.deepEqual(store.collectAttachments(), { expired: 0, uploads: 0, files: 0 });
  assert(readdirSync(directory).includes(sha(orphan)));
  now += 6 * minute;
  assert.deepEqual(store.collectAttachments(), { expired: 0, uploads: 1, files: 1 });
  assert(!readdirSync(directory).includes(sha(orphan)));
  // Two uploaders share one file. Each attachment expires after its own last message; the file
  // goes only with the last of them.
  const shot = png(7);
  upload('vader', shot);
  const first = send('vader', { attachments: [describe(shot, 'shot.png')] });
  now += 20 * minute;
  upload('lando', shot);
  const second = send('lando', { attachments: [describe(shot, 'shot.png')] });
  now += 41 * minute;
  assert.equal(store.collectAttachments().expired, 1);
  assert(readdirSync(directory).includes(sha(shot)));
  const expiredId = first.message.attachments![0]!.id;
  assert.throws(() => store.attachmentFile('luke', expiredId), code('attachment_expired'));
  assert.match(store.attachment('luke', expiredId).expired_at!, /^2026-10-20T11:12/);
  assert.equal(
    store.messages('luke', { mode: 'history' }).items[0]!.attachments![0]!.expired_at !== undefined,
    true,
  );
  assert.deepEqual(
    readFileSync(store.attachmentFile('luke', second.message.attachments![0]!.id).path),
    shot,
  );
  now += 20 * minute;
  assert.deepEqual(store.collectAttachments(), { expired: 1, uploads: 0, files: 1 });
  assert(!readdirSync(directory).includes(sha(shot)));
  // A scheduled message counts from its delivery time, not from when it was sent.
  const later = png(8);
  upload('vader', later);
  const scheduled = send('vader', {
    attachments: [describe(later, 'later.png')],
    deliver_at: new Date(now + 90 * minute).toISOString(),
  });
  now += 100 * minute;
  assert.equal(store.collectAttachments().expired, 0);
  // An active schedule keeps its attachments; after cancelling, retention runs from its last
  // occurrence.
  const daily = png(9);
  upload('vader', daily);
  const vader = runtimes.get('my-team/vader')!;
  const schedule = store.createSchedule('vader', vader, {
    client_request_id: 'daily-screens',
    to: 'luke',
    content: 'Daily screenshot',
    attachments: [describe(daily, 'daily.png')],
    repeat: { time_zone: 'UTC', times: ['23:59'] },
  });
  assert.equal(schedule.schedule.attachments![0]!.filename, 'daily.png');
  now += 3 * 24 * 60 * minute;
  store.releaseDue();
  store.collectAttachments();
  const occurrences = store
    .messages('luke', { mode: 'history', limit: 100 })
    .items.filter((message) => message.schedule_id === schedule.schedule.schedule_id);
  assert(occurrences.length >= 1);
  assert.equal(occurrences.at(-1)!.attachments![0]!.expired_at, undefined);
  assert.equal(
    store.attachmentFile('luke', occurrences[0]!.attachments![0]!.id).size,
    daily.length,
  );
  store.cancelScheduled('vader', vader, schedule.schedule.schedule_id);
  now += 2 * 24 * 60 * minute;
  store.collectAttachments();
  assert.throws(
    () => store.attachmentFile('luke', occurrences[0]!.attachments![0]!.id),
    code('attachment_expired'),
  );
  assert.equal(scheduled.message.attachments!.length, 1);
  // A file no record names, such as an interrupted upload, is removed once old enough.
  const stray = join(directory, 'f'.repeat(64));
  writeFileSync(stray, 'partial');
  const young = join(directory, `${'e'.repeat(64)}.${randomUUID()}.tmp`);
  writeFileSync(young, 'in flight');
  const old = new Date(Date.now() - 2 * 60 * minute);
  utimesSync(stray, old, old);
  store.collectAttachments();
  assert.deepEqual(readdirSync(directory), [young.split('/').at(-1)]);
});

// ----- Over HTTP and WebSocket -----

async function broker(t: TestContext, options: Partial<ServerOptions> = {}) {
  const directory = temporary(t);
  const owner = randomBytes(32).toString('base64url');
  const server = await startServer({
    database: join(directory, 'lobby.db'),
    adminToken: owner,
    port: 0,
    dispatchIntervalMs: 5,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [60_000, 60_000, 60_000] },
    ...options,
  });
  await createLobby(server.url, owner);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
  });
  async function request<T = Record<string, unknown>>(
    method: string,
    path: string,
    token = owner,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  const runtimeHeaders = (runtime: RuntimeBinding) => ({
    'x-pocolobby-runtime-id': runtime.runtime_id,
    'x-pocolobby-generation': String(runtime.generation),
    'x-pocolobby-incarnation': runtime.incarnation,
  });
  async function agent(id: string, lobby = 'my-team') {
    const provision = await request<{ token: string }>('POST', '/v1/admin/agents', owner, {
      agent_id: id,
      lobby_id: lobby,
    });
    assert.equal(provision.status, 201);
    const token = provision.data.token;
    const runtime = (
      await request<RuntimeBinding>('POST', '/v1/runtime', token, { runtime_id: randomUUID() })
    ).data;
    return { id, token, runtime, headers: runtimeHeaders(runtime) };
  }
  type Agent = Awaited<ReturnType<typeof agent>>;
  async function connect(who: Agent, headers: Record<string, string>) {
    const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/v1/events`, {
      headers: { authorization: `Bearer ${who.token}`, ...who.headers, ...headers },
    });
    sockets.push(socket);
    const raw: unknown[] = [];
    const waiters = new Set<() => void>();
    socket.on('message', (data) => {
      raw.push(JSON.parse(data.toString()));
      for (const wake of waiters) wake();
    });
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    const next = (predicate: (event: NotificationEvent) => boolean) =>
      new Promise<NotificationEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for an event')), 3000);
        const check = () => {
          const found = raw.find((event) => predicate(event as NotificationEvent));
          if (found) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(found as NotificationEvent);
          }
        };
        waiters.add(check);
        check();
      });
    const bootstrap = await next((event) => event.type === 'bootstrap');
    const context = await request<AgentContext>(
      'GET',
      '/v1/context',
      who.token,
      undefined,
      headers,
    );
    assert.equal(
      (
        await request(
          'POST',
          '/v1/ready',
          who.token,
          {
            context_revision: context.data.checkpoint.revision,
            probe_nonce: bootstrap.probe_nonce,
          },
          who.headers,
        )
      ).status,
      200,
    );
    return { socket, raw, next };
  }
  const upload = (who: Agent, bytes: Buffer, headers: Record<string, string> = who.headers) =>
    fetch(`${server.url}/v1/attachments/${sha(bytes)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${who.token}`,
        'content-type': 'application/octet-stream',
        ...headers,
      },
      body: new Uint8Array(bytes),
    });
  /**
   * An upload whose body is still arriving: its headers and the first `sent` bytes are written
   * and the rest waits for finish(); abort() drops the connection. A refusal before the body,
   * such as uploads_busy, answers while the body is still being written.
   */
  function partialUpload(
    who: Agent,
    bytes: Buffer,
    sent: number,
    headers: Record<string, string> = who.headers,
  ) {
    const outgoing = httpRequest(`${server.url}/v1/attachments/${sha(bytes)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${who.token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        ...headers,
      },
    });
    const response = new Promise<{
      status: number;
      headers: IncomingHttpHeaders;
      data: { error?: { code: string; message: string } };
    }>((resolve, reject) => {
      outgoing.once('response', (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode!,
            headers: incoming.headers,
            data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      });
      outgoing.once('error', reject);
    });
    response.catch(() => {}); // An aborted upload has no response.
    outgoing.write(bytes.subarray(0, sent));
    return {
      response,
      async finish() {
        outgoing.end(bytes.subarray(sent));
        return await response;
      },
      abort: () => outgoing.destroy(),
    };
  }
  const send = (who: Agent, body: Record<string, unknown>) =>
    request<StoredMessage>(
      'POST',
      '/v1/messages',
      who.token,
      { client_request_id: randomUUID(), content: 'See attached', ...body },
      who.headers,
    );
  return { server, owner, request, agent, connect, upload, partialUpload, send };
}
const V5 = { 'x-pocolobby-event-version': '5' };

test('only the uploader and visible recipients can read an attachment; the owner sees metadata', async (t) => {
  const b = await broker(t);
  const vader = await b.agent('vader');
  const luke = await b.agent('luke');
  const lando = await b.agent('lando');
  await b.request('POST', '/v1/admin/lobbies', b.owner, { lobby_id: 'other' });
  const stranger = await b.agent('vader', 'other');
  const shot = png(10);
  // Uploads need the runtime headers and a binary body.
  assert.equal((await b.upload(vader, shot, {})).status, 409);
  const wrongType = await fetch(`${b.server.url}/v1/attachments/${sha(shot)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${vader.token}`,
      'content-type': 'application/json',
      ...vader.headers,
    },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await b.upload(vader, shot)).status, 200);
  const sent = await b.send(vader, { to: 'luke', attachments: [describe(shot, 'shot.png')] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const id = sent.data.message.attachments![0]!.id;
  const content = (token: string) =>
    fetch(`${b.server.url}/v1/attachments/${id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
  for (const who of [vader, luke]) {
    const response = await content(who.token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-pocolobby-sha256'), sha(shot));
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), shot);
    const meta = await b.request<{ filename: string; from: string }>(
      'GET',
      `/v1/attachments/${id}`,
      who.token,
    );
    assert.deepEqual([meta.data.filename, meta.data.from], ['shot.png', 'vader']);
  }
  // Not a recipient, another lobby with the same agent name, and the owner cannot read it.
  for (const who of [lando, stranger]) {
    const response = await content(who.token);
    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'attachment_not_found',
    );
  }
  assert.equal((await content(b.owner)).status, 403);
  // The owner lists metadata and usage per lobby.
  const listed = await b.request<{ items: { id: string; uploader: string; messages: string[] }[] }>(
    'GET',
    '/v1/admin/attachments?lobby=my-team',
  );
  assert.deepEqual(
    listed.data.items.map((item) => [item.id, item.uploader, item.messages]),
    [[id, 'vader', [sent.data.message.id]]],
  );
  const usage = await b.request<{ used_bytes: number; quota_bytes: number }>(
    'GET',
    '/v1/admin/attachments/usage?lobby=my-team',
  );
  assert.deepEqual([usage.data.used_bytes, usage.data.quota_bytes], [shot.length, 1024 ** 3]);
  assert.equal(
    (await b.request<{ items: unknown[] }>('GET', '/v1/admin/attachments?lobby=other')).data.items
      .length,
    0,
  );
  // A room member removed before seeing a room message loses access with the message.
  await b.request('POST', '/v1/admin/rooms?lobby=my-team', b.owner, { room_id: 'app' });
  await b.request('PUT', '/v1/admin/rooms/app/members?lobby=my-team', b.owner, {
    members: ['vader', 'luke', 'lando'],
  });
  const room = await b.send(vader, {
    to: '*',
    room: 'app',
    attachments: [describe(shot, 'shot.png')],
  });
  assert.equal(room.status, 200, JSON.stringify(room.data));
  assert.equal((await content(lando.token)).status, 200);
  await b.request('PUT', '/v1/admin/rooms/app/members?lobby=my-team', b.owner, {
    members: ['vader', 'luke'],
  });
  assert.equal((await content(lando.token)).status, 404);
  // A scheduled message's attachments become readable when it is delivered.
  const other = png(11);
  await b.upload(vader, other);
  const scheduled = await b.send(vader, {
    to: 'lando',
    attachments: [describe(other, 'later.png')],
    deliver_at: new Date(Date.now() + 1200).toISOString(),
  });
  const laterId = scheduled.data.message.attachments![0]!.id;
  const laterContent = () =>
    fetch(`${b.server.url}/v1/attachments/${laterId}/content`, {
      headers: { authorization: `Bearer ${lando.token}` },
    });
  assert.equal((await laterContent()).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await laterContent()).status, 200);
});

test('uploads arriving at once share a bounded memory budget; a full budget is retryable', async (t) => {
  const limits = { maxImageBytes: 1024 * 1024, maxTextBytes: 64 * 1024 };
  // A budget below the largest attachment would refuse it forever.
  await assert.rejects(
    startServer({
      database: join(temporary(t), 'x.db'),
      adminToken: randomBytes(32).toString('base64url'),
      port: 0,
      storeOptions: limits,
      uploadInflightBytes: limits.maxImageBytes - 1,
    }),
    /at least the largest attachment, 1048576 bytes/,
  );
  const b = await broker(t, {
    uploadInflightBytes: 2 * limits.maxImageBytes,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [60_000, 60_000, 60_000], ...limits },
  });
  const vader = await b.agent('vader');
  const largest = (seed: number) => {
    const head = png(seed);
    return Buffer.concat([head, randomBytes(limits.maxImageBytes - head.length)]);
  };
  const put = (path: string, bytes: Buffer, headers: Record<string, string> = {}) =>
    fetch(`${b.server.url}${path}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${vader.token}`,
        'content-type': 'application/octet-stream',
        ...vader.headers,
        ...headers,
      },
      body: new Uint8Array(bytes),
    });
  // A body refused after it arrived gives its share back: here, the wrong SHA-256.
  assert.equal((await put(`/v1/attachments/${sha(png(1))}`, largest(2))).status, 400);
  // An upload must declare its length; a chunked body is refused before it is read.
  const chunked = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(`${b.server.url}/v1/attachments/${sha(png(1))}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${vader.token}`,
        'content-type': 'application/octet-stream',
        ...vader.headers,
      },
    });
    outgoing.once('response', (incoming) => {
      incoming.resume();
      resolve(incoming.statusCode!);
    });
    outgoing.once('error', reject);
    outgoing.write(png(1)); // Written before end(), so Node sends it chunked.
    outgoing.end();
  });
  assert.equal(chunked, 411);
  // Three of the largest uploads overlap while their bodies are still arriving: two fill the
  // budget, and the third is refused at once, before its body, with a retryable answer.
  const three = [3, 4, 5].map((seed) => b.partialUpload(vader, largest(seed), 512 * 1024));
  const busy = await Promise.race([
    ...three.map((upload, index) => upload.response.then((response) => ({ index, ...response }))),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('No upload was refused')), 3000).unref(),
    ),
  ]);
  assert.equal(busy.status, 503);
  assert.equal(busy.data.error!.code, 'uploads_busy');
  assert.match(busy.data.error!.message, /Nothing was stored; retry in a few seconds/);
  assert.equal(busy.headers['retry-after'], '5');
  await three[busy.index]!.finish();
  const [dropped, kept] = three.filter((_, index) => index !== busy.index);
  // An aborted upload gives its share back.
  dropped!.abort();
  const next = largest(6);
  const deadline = Date.now() + 3000;
  for (;;) {
    const status = (await put(`/v1/attachments/${sha(next)}`, next)).status;
    if (status === 200) break;
    assert.equal(status, 503);
    assert(Date.now() < deadline, 'the aborted upload must release its reservation');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The upload that was admitted completes; then the whole budget is free again.
  assert.equal((await kept!.finish()).status, 200);
  const both = await Promise.all(
    [7, 8].map((seed) => {
      const bytes = largest(seed);
      return put(`/v1/attachments/${sha(bytes)}`, bytes);
    }),
  );
  assert.deepEqual(
    both.map((response) => response.status),
    [200, 200],
  );
});

test('a cancelled scheduled message never opens its attachments to the recipient', async (t) => {
  const b = await broker(t);
  const vader = await b.agent('vader');
  const lando = await b.agent('lando');
  const plan = png(41);
  assert.equal((await b.upload(vader, plan)).status, 200);
  const scheduled = await b.send(vader, {
    to: 'lando',
    attachments: [describe(plan, 'plan.png')],
    deliver_at: new Date(Date.now() + 1000).toISOString(),
  });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
  const id = scheduled.data.message.attachments![0]!.id;
  const cancelled = await b.request(
    'POST',
    '/v1/schedules/cancel',
    vader.token,
    { id: scheduled.data.message.id },
    vader.headers,
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  // Past its delivery time, the cancelled delivery stays held: no content, no metadata.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const read = (token: string, suffix = '/content') =>
    fetch(`${b.server.url}/v1/attachments/${id}${suffix}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  for (const suffix of ['/content', '']) {
    const refused = await read(lando.token, suffix);
    assert.equal(refused.status, 404);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      'attachment_not_found',
    );
  }
  assert.equal((await read(vader.token)).status, 200, 'the uploader still holds it');
  const inbox = await b.request<{ items: Message[] }>('GET', '/v1/messages', lando.token);
  assert.equal(inbox.data.items.length, 0);
});

test('an upload whose runtime changes while its body arrives is refused and stores nothing', async (t) => {
  const limits = { maxImageBytes: 1024 * 1024, maxTextBytes: 64 * 1024 };
  const b = await broker(t, {
    uploadInflightBytes: limits.maxImageBytes,
    storeOptions: { infoDelayMs: 0, retryDelaysMs: [60_000, 60_000, 60_000], ...limits },
  });
  const vader = await b.agent('vader');
  const head = png(42);
  const bytes = Buffer.concat([head, randomBytes(limits.maxImageBytes - head.length)]);
  const upload = b.partialUpload(vader, bytes, 256 * 1024);
  // Once its reservation holds the whole budget, the broker has checked the runtime and is
  // reading the body.
  const deadline = Date.now() + 3000;
  while ((await b.upload(vader, png(43))).status !== 503)
    assert(Date.now() < deadline, 'the upload must be admitted');
  // The same runtime resumes in a newer process: the arriving upload's generation is stale.
  const resumed = await b.request<RuntimeBinding>('POST', '/v1/runtime', vader.token, {
    runtime_id: vader.runtime.runtime_id,
  });
  assert.equal(resumed.data.generation, vader.runtime.generation + 1);
  const refused = await upload.finish();
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error!.code, 'stale_runtime');
  // The content was not stored for vader: a send still asks for it.
  const headers = {
    'x-pocolobby-runtime-id': resumed.data.runtime_id,
    'x-pocolobby-generation': String(resumed.data.generation),
    'x-pocolobby-incarnation': resumed.data.incarnation,
  };
  const send = await b.request<{ error: { code: string; missing: string[] } }>(
    'POST',
    '/v1/messages',
    vader.token,
    {
      client_request_id: randomUUID(),
      to: 'vader',
      content: 'x',
      attachments: [describe(bytes, 'shot.png')],
    },
    headers,
  );
  assert.equal(send.status, 409);
  assert.deepEqual(send.data.error.missing, [sha(bytes)]);
});

test('a large report arrives whole, and attachments travel as compact metadata with guidance', async (t) => {
  const b = await broker(t);
  const vader = await b.agent('vader');
  const luke = await b.agent('luke');
  const stream = await b.connect(luke, V5);
  // A 20 KiB builder report fits the default push size.
  const report = await b.send(vader, { to: 'luke', content: 'r'.repeat(20 * 1024) });
  const whole = await stream.next(
    (value) =>
      value.type === 'inbox' &&
      value.messages.some((message) => message.id === report.data.message.id),
  );
  assert.equal(whole.truncated, false);
  const before = png(12);
  const after = png(13);
  await b.upload(vader, before);
  await b.upload(vader, after);
  const sent = await b.send(vader, {
    to: 'luke',
    kind: 'report',
    content: 'Login screen before and after the fix',
    attachments: [describe(before, 'before.png'), describe(after, 'after.png')],
  });
  const event = await stream.next(
    (value) =>
      value.type === 'inbox' &&
      value.messages.some((message) => message.id === sent.data.message.id),
  );
  const pushed = event.messages[0] as Message & {
    extensions?: { attachments?: { id: string }[] };
    presentation?: { lead: string; guidance: { text: string }[] };
  };
  assert.deepEqual(pushed.extensions!.attachments, [
    {
      id: pushed.extensions!.attachments![0]!.id,
      filename: 'before.png',
      mime_type: 'image/png',
      size: before.length,
    },
    {
      id: pushed.extensions!.attachments![1]!.id,
      filename: 'after.png',
      mime_type: 'image/png',
      size: after.length,
    },
  ]);
  assert.equal(
    pushed.presentation!.lead,
    'report from vader (no reply expected): direct message, with 2 attachments: before.png, after.png',
  );
  assert.match(pushed.presentation!.guidance.map((g) => g.text).join(' '), /get_attachment/);
  assert.equal(pushed.content, 'Login screen before and after the fix');
  // Message reads show the full metadata.
  const pending = await b.request<{ items: Message[] }>(
    'GET',
    '/v1/messages?mode=pending&limit=100',
    luke.token,
  );
  assert.equal(pending.data.items.at(-1)!.attachments![0]!.sha256, sha(before));
});

test('a hint of twenty headers with full extensions fits the bridge frame without presentations', () => {
  const header = (index: number) => ({
    id: randomUUID(),
    from: `a${'x'.repeat(47)}`,
    to: `b${'y'.repeat(47)}`,
    room_id: null,
    priority: 'info' as const,
    created_at: new Date(Date.UTC(2026, 9, 15, 12, 0, index)).toISOString(),
    kind: null,
    future_detail: '"'.repeat(1900),
  });
  const event = {
    type: 'inbox',
    notification_id: randomUUID(),
    agent_id: 'lando',
    lobby_id: 'my-team',
    runtime_id: randomUUID(),
    generation: 1,
    messages: [],
    pending_count: 25,
    truncated: true,
    covered: Array.from({ length: 20 }, (_, index) => header(index)),
    covered_count: 25,
  } as unknown as NotificationEvent;
  const wire = wireEvent(event, 30) as NotificationEvent;
  assert(Buffer.byteLength(JSON.stringify(wire)) <= MAX_EVENT_FRAME_BYTES);
  assert.equal(wire.covered!.length, 20);
  assert.equal(wire.covered_count, 25);
  assert(NotificationSchema.safeParse(wire).success);
});

test('the broker chooses the push size; a smaller setting turns a large push into a hint', async (t) => {
  await assert.rejects(
    startServer({
      database: join(temporary(t), 'x.db'),
      adminToken: randomBytes(32).toString('base64url'),
      port: 0,
      pushBytes: MAX_PUSH_BYTES + 1,
    }),
    /push size must be between/,
  );
  const b = await broker(t, { pushBytes: 8 * 1024 });
  const vader = await b.agent('vader');
  const luke = await b.agent('luke');
  const stream = await b.connect(luke, V5);
  const sent = await b.send(vader, { to: 'luke', content: 'r'.repeat(12 * 1024) });
  const hint = await stream.next(
    (event) =>
      event.type === 'inbox' &&
      (event.covered ?? []).some((header) => header.id === sent.data.message.id),
  );
  assert.equal(hint.truncated, true);
});

test('the catalog, its wording and tool_guide offer attachments with their limits', async (t) => {
  const b = await broker(t);
  const vader = await b.agent('vader');
  await b.agent('lando');
  const catalog = (await b.request<ToolCatalog>('GET', '/v1/tools', vader.token)).data;
  const send = (value: ToolCatalog) =>
    value.tools.find((tool) => tool.name === 'send_message') as CatalogEntry;
  const modern = catalog;
  const paths = (send(modern).input_schema.properties as Record<string, Record<string, unknown>>)
    .attachments!;
  assert.deepEqual(
    [paths.type, (paths.items as { type: string }).type, paths.maxItems],
    ['array', 'string', 5],
  );
  assert.match(
    String(paths.description),
    /absolute local file paths.*up to 10\.0 MiB.*up to 1\.0 MiB/,
  );
  assert.match(
    String(paths.description),
    /For other files, put a logical location each machine resolves itself, such as dropbox:MDP\/reports\/run-42, in the evidence field\./,
  );
  assert.deepEqual(send(modern).local_files, ['attachments']);
  const read = (value: ToolCatalog) =>
    value.tools.find((tool) => tool.name === 'get_messages')!.description;
  assert.match(read(modern), /attachments \(open one with get_attachment and its id\)/);
  assert.match(send(modern).summary!, /; can carry attachments\.$/);
  // The guide is generated from the same catalog and revision.
  const context = await b.request<AgentContext>('GET', '/v1/context', vader.token);
  const guide = context.data.tool_guide!;
  assert.equal(guide.catalog_revision, modern.revision);
  assert.deepEqual(
    guide.operations.map((operation) => operation.name),
    modern.tools.map((tool) => tool.name),
  );
  const sendGuide = guide.operations.find((operation) => operation.name === 'send_message')!;
  assert.match(sendGuide.purpose, /attachments/);
  // The guide line states both limits (Vader found only one stated).
  assert.equal(
    sendGuide.arguments.attachments,
    'Up to 5 absolute local file paths, images up to 10.0 MiB, text up to 1.0 MiB: png, jpg, jpeg, gif, webp, md, txt, csv, json, log',
  );
  // Larger configured limits still fit the guide's line.
  const larger = toolGuide(
    buildCatalog(
      defaultTools(),
      { manage_rooms: false, can_broadcast: false },
      {
        maxImageBytes: 1000 * 1024 * 1024,
        maxTextBytes: 1000 * 1024 * 1024,
      },
    ).tools,
    null,
  ).operations.find((operation) => operation.name === 'send_message')!.arguments.attachments!;
  assert.match(larger, /images up to 1000\.0 MiB, text up to 1000\.0 MiB: png.*, log$/);
  assert.match(sendGuide.arguments.to!, /^\(required\)/);
  assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 8 * 1024, 'compact');
  // The stale-schema advice is the guide's own note, once.
  assert.match(guide.note, /call_operation/);
  assert.doesNotMatch(context.data.guidance.join(' '), /call_operation/);
  // A dispatched send asks for the upload exactly as the HTTP route does.
  const shot = png(14);
  const dispatched = await b.request<{ error: { code: string; missing: string[] } }>(
    'POST',
    '/v1/tools/send_message',
    vader.token,
    {
      arguments: {
        client_request_id: 'tool-send',
        to: 'lando',
        content: 'x',
        attachments: [describe(shot, 'shot.png')],
      },
    },
    vader.headers,
  );
  assert.equal(dispatched.status, 409);
  assert.deepEqual(dispatched.data.error.missing, [sha(shot)]);
});

test('a Markdown outline finds ATX headings outside code and front matter, with offsets', () => {
  const text = [
    '# Title #',
    'Intro',
    '~~~~',
    '## inside a tilde fence',
    '~~~',
    '## still inside: a shorter fence does not close it',
    '~~~~',
    '   ### Indented three ##',
    '    #### Indented four is code',
    '#No space is not a heading',
    '#',
    'Setext titles are not listed',
    '===',
    '## Last',
    'end',
  ].join('\r\n');
  const headings = markdownHeadings(text);
  assert.deepEqual(
    headings.map(({ level, title }) => [level, title]),
    [
      [1, 'Title'],
      [3, 'Indented three'],
      [2, 'Last'],
    ],
  );
  for (const heading of headings)
    assert.match(text.slice(heading.offset), new RegExp(`^ *#+ ${heading.title}`));
  // A section runs to the next heading of the same or a higher level.
  assert.deepEqual(
    headings.map((heading) => heading.offset + heading.length),
    [text.length, headings[2]!.offset, text.length],
  );
  // Front matter is skipped only at the very start.
  assert.deepEqual(
    markdownHeadings('---\n# comment\n---\n# Real\n').map((heading) => heading.title),
    ['Real'],
  );
  assert.deepEqual(
    markdownHeadings('Text\n---\n# Real\n').map((heading) => heading.title),
    ['Real'],
  );
});

test('only a whitespace-only matching fence closes a code block (review v031 F3)', () => {
  const text = '~~~\n# Inside code\n~~~not-a-close\n# Still inside\n~~~\n# Actual section\n';
  assert.deepEqual(
    markdownHeadings(text).map((heading) => heading.title),
    ['Actual section'],
  );
  // Opening fences keep their info string; a longer closing fence still closes.
  assert.deepEqual(
    markdownHeadings('```ts\n# code\n````  \n# After\n').map((heading) => heading.title),
    ['After'],
  );
});

test('section lengths stay right and linear for many headings (review v031 F2)', () => {
  const text = '# A\n## a1\n## a2\n### deep\n# B\n## b1\n';
  assert.deepEqual(
    markdownHeadings(text).map((heading) => [heading.title, heading.length]),
    [
      ['A', 25],
      ['a1', 6],
      ['a2', 15],
      ['deep', 9],
      ['B', 10],
      ['b1', 6],
    ],
  );
  // The reviewer's input: a 1 MiB document of 262,144 headings.
  const many = '# a\n'.repeat(262_144);
  const started = performance.now();
  const headings = markdownHeadings(many);
  assert.equal(headings.length, 262_144);
  assert.equal(headings.at(-1)!.length, 4);
  assert.ok(performance.now() - started < 2000, 'outline of a 1 MiB document takes well under 2 s');
});

test('an expired attachment’s record goes a week later, once no message names it', (t) => {
  // Messages now go after a day, so expired records named by nothing would otherwise pile up.
  let now = Date.parse('2026-10-20T10:00:00.000Z');
  const { store, agent, upload, send } = storeFixture(t, { now: () => now });
  agent('vader');
  agent('luke');
  const shot = png(11);
  upload('vader', shot);
  const id = send('vader', { attachments: [describe(shot, 'shot.png')] }).message.attachments![0]!
    .id;
  now += 25 * 60 * 60_000;
  store.pruneMessages();
  assert.equal(store.collectAttachments().expired, 1);
  now += 7 * 24 * 60 * 60_000 - 60_000;
  store.collectAttachments();
  assert.ok(store.attachment('vader', id).expired_at);
  now += 2 * 60_000;
  store.collectAttachments();
  assert.throws(() => store.attachment('vader', id), code('attachment_not_found'));
});

test('a scheduled message keeps its files however late it is released, and a cancelled one does not', (t) => {
  // A review found that a planned time stood in for the real use: a release after a long outage
  // found its files deleted, and a cancelled send held its files until its old due date.
  let now = Date.parse('2026-10-16T10:00:00.000Z');
  const day = 24 * 60 * 60_000;
  const { store, agent, upload, send, runtimes } = storeFixture(t, { now: () => now });
  agent('vader');
  agent('luke');
  const shot = png(12);
  upload('vader', shot);
  const tomorrow = send('vader', {
    attachments: [describe(shot, 'shot.png')],
    deliver_at: new Date(now + day).toISOString(),
  });
  // The broker was down over the delivery time and comes back two days later.
  now += 3 * day + 60_000;
  assert.equal(store.collectAttachments().expired, 0);
  store.releaseDue();
  const id = tomorrow.message.attachments![0]!.id;
  assert.deepEqual(readFileSync(store.attachmentFile('luke', id).path), shot);
  now += day - 60_000;
  assert.equal(store.collectAttachments().expired, 0);
  now += 2 * 60_000;
  assert.equal(store.collectAttachments().expired, 1);
  // A send a month ahead, cancelled at once, stops holding its file a day later.
  const later = png(13);
  upload('vader', later);
  const month = send('vader', {
    attachments: [describe(later, 'later.png')],
    deliver_at: new Date(now + 29 * day).toISOString(),
  });
  store.cancelScheduled('vader', runtimes.get('my-team/vader')!, month.message.id);
  now += day + 60_000;
  assert.equal(store.collectAttachments().expired, 1);
});

test('history search finds a message by its attachment name', (t) => {
  const { store, agent, upload, send } = storeFixture(t);
  agent('vader');
  agent('luke');
  const shot = png(7);
  upload('vader', shot);
  const sent = send('vader', {
    content: 'Findings attached',
    attachments: [describe(shot, 'B4-shadow-diff.png')],
  });
  send('vader', { content: 'Nothing attached' });
  const found = (query: string) =>
    store.messages('my-team/luke', { mode: 'history', query }).items.map((message) => message.id);
  assert.deepEqual(found('b4-SHADOW'), [sent.message.id]);
  assert.deepEqual(found('diff.png'), [sent.message.id]);
});
