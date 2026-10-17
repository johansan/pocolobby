import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type Anthropic from '@anthropic-ai/sdk';
import { WebSocket } from 'ws';
import { clientKey, SignInKeys, tokenHash, WindowLimiter } from '../src/auth.js';
import { BoardService } from '../src/board.js';
import { summaryCost, type SummaryClient } from '../src/board-summary.js';
import { runCli } from '../src/cli.js';
import { MailError, postmarkMailer } from '../src/mail.js';
import { LobbyError, type RuntimeBinding } from '../src/protocol.js';
import { LobbyStore } from '../src/store.js';
import { MAX_BOARD_SOURCES } from '../src/board-model.js';
import { encodePng } from '../src/png.js';
import { NewLobbyId } from '../src/protocol.js';
import { browserFixture, call, CONSOLE, DOMAIN, LOBBY, OWNER_EMAIL } from './browser-fixture.js';

const rejectsCode = (code: string) => (error: unknown) =>
  error instanceof LobbyError && error.code === code;
const errorCode = (reply: { body: string }) =>
  (JSON.parse(reply.body) as { error?: { code: string } }).error?.code;

// ---------------------------------------------------------------------------------------------
// Sign-in.

test('a code signs in once; the session cookie is host-only and the console opens', async (t) => {
  const f = await browserFixture(t);
  const sent = await f.post('/console/api/sign-in/code', { email: '  Owner@Example.com ' });
  assert.equal(sent.status, 200);
  assert.equal(f.mail.length, 1);
  assert.equal(f.mail[0]!.to, OWNER_EMAIL);
  assert.match(f.mail[0]!.code, /^\d{6}$/);
  const verified = await f.post('/console/api/sign-in/verify', {
    email: 'OWNER@example.com',
    code: f.mail[0]!.code,
  });
  assert.equal(verified.status, 200, verified.body);
  assert.deepEqual(JSON.parse(verified.body), { ok: true, redirect: '/console' });
  const cookie = String(verified.headers['set-cookie']?.[0]);
  assert.match(
    cookie,
    /^__Host-pocolobby_console=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
  );
  const session = cookie.split(';')[0]!;
  const home = await f.get('/console', session);
  assert.equal(home.status, 200);
  assert.match(home.body, /Your lobbies/);
  assert.match(home.body, /my-team\.board\.test/);
  assert.match(home.body, /Signed in as owner@example\.com/);
  // Signed in already, the sign-in page goes on to where it would have led.
  const onward = await f.get(`/console/sign-in?board=${LOBBY}`, session);
  assert.equal(onward.status, 303);
  assert.equal(onward.headers.location, `/console/open/${LOBBY}`);
  // The code is consumed: a replay fails, and only one account exists for the address.
  const replay = await f.post('/console/api/sign-in/verify', {
    email: OWNER_EMAIL,
    code: f.mail[0]!.code,
  });
  assert.equal(replay.status, 400);
  assert.equal(errorCode(replay), 'code_invalid');
  const accounts = JSON.parse((await f.admin_('GET', '/v1/admin/console/accounts')).body) as {
    accounts: { email: string; owns: string[] }[];
  };
  assert.deepEqual(
    accounts.accounts.map((account) => [account.email, account.owns]),
    [[OWNER_EMAIL, [LOBBY]]],
  );
  // Sign-out ends the session.
  const out = await f.post('/console/api/sign-out', {}, session);
  assert.equal(out.status, 200);
  assert.match(String(out.headers['set-cookie']?.[0]), /Max-Age=0/);
  assert.doesNotMatch((await f.get('/console', session)).body, /Your lobbies/);
});

test('an unknown, disabled or unrelated address gets the same answer and no mail', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.setAccount(
      { email: 'disabled@example.com', enabled: false, may_create_lobbies: true },
      'no code',
    );
    // An account that owns nothing, views nothing and may not create lobbies.
    store.addBoardViewer('owner', LOBBY, 'former@example.com');
    store.removeBoardViewer('owner', LOBBY, 'former@example.com');
  });
  const answer = async (email: string) => {
    const reply = await f.post('/console/api/sign-in/code', { email });
    return { status: reply.status, body: reply.body.replaceAll(email, 'EMAIL') };
  };
  const known = await answer(OWNER_EMAIL);
  for (const email of ['nobody@example.com', 'disabled@example.com', 'former@example.com'])
    assert.deepEqual(await answer(email), known, email);
  assert.deepEqual(
    f.mail.map((item) => item.to),
    [OWNER_EMAIL],
  );
  // The per-address throttle answers both kinds alike too.
  const again = [await answer(OWNER_EMAIL), await answer('nobody@example.com')];
  assert.equal(again[0]!.status, 429);
  assert.deepEqual(again[1], again[0]);
  // No verification succeeds for an address that got no code.
  const guess = await f.post('/console/api/sign-in/verify', {
    email: 'nobody@example.com',
    code: '123456',
  });
  assert.equal(errorCode(guess), 'code_invalid');
});

test('codes expire, five wrong tries spend a code, and a resend keeps the wrong-code budget', async (t) => {
  const f = await browserFixture(t);
  const send = () => f.post('/console/api/sign-in/code', { email: OWNER_EMAIL });
  const verify = (code: string) =>
    f.post('/console/api/sign-in/verify', { email: OWNER_EMAIL, code });
  const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
  // Expiry after 10 minutes.
  assert.equal((await send()).status, 200);
  const expired = f.mail.at(-1)!.code;
  f.clock.now += 10 * 60_000;
  assert.equal(errorCode(await verify(expired)), 'code_invalid');
  // A resend within a minute is refused; after it, the new code replaces the old one.
  assert.equal((await send()).status, 200);
  const replaced = f.mail.at(-1)!.code;
  assert.equal((await send()).status, 429);
  f.clock.now += 60_000;
  assert.equal((await send()).status, 200);
  const current = f.mail.at(-1)!.code;
  // The replaced code is now just a wrong code: it counts against the current one.
  const stale = replaced === current ? wrong(current) : replaced;
  assert.equal(errorCode(await verify(stale)), 'code_invalid');
  // Five wrong tries spend the code: then even the right code fails.
  for (let attempt = 2; attempt <= 4; attempt += 1)
    assert.equal(errorCode(await verify(wrong(current))), 'code_invalid');
  assert.equal(errorCode(await verify(wrong(current))), 'code_invalid');
  // A spent code answers like a wrong one, as it would for an address that got no code.
  assert.equal(errorCode(await verify(current)), 'code_invalid');
  // So far 7 of the address's 10 wrong codes this hour: the expired one, five wrong tries and
  // the spent one. A resend does not reset that.
  f.clock.now += 60_000;
  assert.equal((await send()).status, 200);
  const fresh = f.mail.at(-1)!.code;
  for (let attempt = 8; attempt <= 10; attempt += 1)
    assert.equal(errorCode(await verify(wrong(fresh))), 'code_invalid');
  const blocked = await verify(fresh);
  assert.equal(blocked.status, 429);
  assert.equal(errorCode(blocked), 'too_many_wrong_codes');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  // After the hour a new code works.
  f.clock.now += 60 * 60_000;
  assert.equal((await send()).status, 200);
  assert.equal((await verify(f.mail.at(-1)!.code)).status, 200);
});

test('the hourly mail ceiling counts only real mails and answers every address alike', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-ceiling-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'lobby.db');
  const now = Date.parse('2026-10-16T07:00:00Z');
  let store = new LobbyStore(path, { now: () => now });
  store.createLobby(LOBBY);
  store.grantLobby(OWNER_EMAIL, LOBBY);
  const keys = new SignInKeys('k'.repeat(43));
  const begin = (email: string) =>
    store.beginSignIn(email, keys.emailKey(email), keys.codeMac(keys.emailKey(email), '123456'));
  // Unknown addresses use none of it.
  for (let index = 0; index < 5; index += 1) begin(`stranger${index}@example.com`);
  assert.deepEqual(begin(OWNER_EMAIL), { wait: 0, send: true });
  store.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT count FROM sign_in_limits WHERE key='send:all'").get()?.count, 1);
  db.prepare("UPDATE sign_in_limits SET count=300 WHERE key='send:all'").run();
  db.close();
  store = new LobbyStore(path, { now: () => now + 60_000 });
  t.after(() => store.close());
  const known = begin(OWNER_EMAIL);
  assert.equal(known.send, false);
  assert.ok(known.wait > 0);
  assert.deepEqual(begin('stranger9@example.com'), known);
});

test('revoking an account voids its outstanding code, so enabling it again revives nothing', async (t) => {
  const f = await browserFixture(t);
  assert.equal((await f.post('/console/api/sign-in/code', { email: OWNER_EMAIL })).status, 200);
  const code = f.mail.at(-1)!.code;
  const off = await f.admin_('POST', '/v1/admin/console/accounts', {
    email: OWNER_EMAIL,
    enabled: false,
  });
  assert.equal(off.status, 200, off.body);
  await f.admin_('POST', '/v1/admin/console/accounts', { email: OWNER_EMAIL, enabled: true });
  const late = await f.post('/console/api/sign-in/verify', { email: OWNER_EMAIL, code });
  assert.equal(errorCode(late), 'code_invalid');
});

test('a failed Postmark send is reported plainly, and the code sends again after a minute', async (t) => {
  const f = await browserFixture(t);
  f.failMail.next = 1;
  const failed = await f.post('/console/api/sign-in/code', { email: OWNER_EMAIL });
  assert.equal(failed.status, 502);
  assert.equal(errorCode(failed), 'mail_failed');
  assert.match(failed.body, /Inactive recipient/);
  assert.match(failed.body, /Try again in a minute/);
  f.clock.now += 60_000;
  assert.equal((await f.post('/console/api/sign-in/code', { email: OWNER_EMAIL })).status, 200);
  assert.equal(f.mail.length, 1);
});

test('every console POST needs its own origin, JSON, a small body and only its fields', async (t) => {
  const f = await browserFixture(t);
  const path = '/console/api/sign-in/code';
  const body = JSON.stringify({ email: OWNER_EMAIL });
  const raw = (headers: Record<string, string>, payload = body) =>
    call(f.server.url, DOMAIN, path, { method: 'POST', headers, body: payload });
  const json = { 'content-type': 'application/json' };
  assert.equal((await raw(json)).status, 403);
  assert.equal((await raw({ ...json, origin: 'null' })).status, 403);
  assert.equal((await raw({ ...json, origin: 'http://evil.test' })).status, 403);
  // A board host is same-site but not the console's origin.
  assert.equal((await raw({ ...json, origin: `http://${LOBBY}.${DOMAIN}` })).status, 403);
  assert.equal(
    (await raw({ origin: CONSOLE, 'content-type': 'application/x-www-form-urlencoded' })).status,
    415,
  );
  assert.equal(
    (await raw({ ...json, origin: CONSOLE }, JSON.stringify({ email: 'a'.repeat(5000) }))).status,
    413,
  );
  const extra = await f.post(path, { email: OWNER_EMAIL, admin: true });
  assert.equal(extra.status, 400);
  assert.equal(f.mail.length, 0);
  // GET is not a way in either.
  assert.equal((await f.get(path)).status, 405);
});

test('console cookies open no API route, and bearer tokens open no console route', async (t) => {
  const f = await browserFixture(t);
  const session = await f.signIn(OWNER_EMAIL);
  for (const path of [
    '/v1/agents',
    '/v1/admin/agents',
    '/v1/admin/console/accounts',
    '/v1/tools',
  ]) {
    // Without an Origin the API wants a bearer token; with one it refuses browsers outright.
    const plain = await call(f.server.url, DOMAIN, path, { headers: { cookie: session } });
    assert.equal(plain.status, 401, path);
    const browser = await call(f.server.url, DOMAIN, path, {
      headers: { cookie: session, origin: CONSOLE },
    });
    assert.equal(browser.status, 403, path);
    assert.equal(errorCode(browser), 'origin_not_allowed');
  }
  // The operator's token is nobody in the console.
  const bearer = { authorization: `Bearer ${f.admin}` };
  const page = await call(f.server.url, DOMAIN, `/console/${LOBBY}`, { headers: bearer });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/console/sign-in');
  const create = await call(f.server.url, DOMAIN, '/console/api/lobbies', {
    method: 'POST',
    headers: { ...bearer, origin: CONSOLE, 'content-type': 'application/json' },
    body: JSON.stringify({ lobby_id: 'sneaky' }),
  });
  assert.equal(create.status, 401);
  assert.equal(errorCode(create), 'sign_in_required');
});

test('the console answers on its own origin only, and without mail it says sign-in is off', async (t) => {
  const f = await browserFixture(t);
  const elsewhere = await call(f.server.url, `lobby.${DOMAIN}`, '/console/my-team?x=1');
  assert.equal(elsewhere.status, 301);
  assert.equal(elsewhere.headers.location, `${CONSOLE}/console/my-team?x=1`);
  const posted = await call(f.server.url, '127.0.0.1', '/console/api/sign-in/code', {
    method: 'POST',
    headers: { origin: CONSOLE, 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL }),
  });
  assert.equal(posted.status, 404);
  // A broker without a mailer starts, serves agents and names what sign-in lacks.
  const bare = await browserFixture(t, undefined, {
    console: { origin: CONSOLE, missing: ['POSTMARK_TOKEN'] },
  });
  const page = await bare.get('/console/sign-in');
  assert.equal(page.status, 200);
  assert.match(
    page.body,
    /Sign-in is not configured on this server yet: POSTMARK_TOKEN is not set/,
  );
  const refused = await bare.post('/console/api/sign-in/code', { email: OWNER_EMAIL });
  assert.equal(refused.status, 503);
  assert.equal((await bare.admin_('GET', '/v1/admin/agents?lobby=my-team')).status, 200);
  assert.equal((await call(bare.server.url, '127.0.0.1', '/healthz')).status, 200);
});

test('console sessions are extended daily while used and end 30 days after last use', async (t) => {
  const f = await browserFixture(t);
  const session = await f.signIn(OWNER_EMAIL);
  const home = () => f.get('/console', session);
  f.clock.now += 2 * 86_400_000;
  const refreshed = await home();
  assert.match(refreshed.body, /Your lobbies/);
  assert.match(String(refreshed.headers['set-cookie']?.[0]), /^__Host-pocolobby_console=/);
  // Within the day no new cookie is needed.
  assert.equal((await home()).headers['set-cookie'], undefined);
  f.clock.now += 29 * 86_400_000;
  assert.match((await home()).body, /Your lobbies/);
  f.clock.now += 31 * 86_400_000;
  assert.doesNotMatch((await home()).body, /Your lobbies/);
});

test('per-client ceilings bound code requests and checks from one address', () => {
  let now = 0;
  const limiter = new WindowLimiter(2, 60_000, () => now);
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 60);
  assert.equal(limiter.take('b'), 0);
  now = 60_000;
  assert.equal(limiter.take('a'), 0);
});

test('codes and email keys are MACs under a key derived from the admin token', () => {
  const one = new SignInKeys('a'.repeat(43));
  const other = new SignInKeys('b'.repeat(43));
  const key = one.emailKey(OWNER_EMAIL);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, other.emailKey(OWNER_EMAIL));
  assert.notEqual(key, createHash('sha256').update(OWNER_EMAIL).digest('hex'));
  assert.notEqual(one.codeMac(key, '123456'), one.codeMac(one.emailKey('x@y.z'), '123456'));
  assert.equal(one.codeMac(key, '123456'), new SignInKeys('a'.repeat(43)).codeMac(key, '123456'));
});

test('the Postmark mailer sends the code in the subject, without tracking, and reports refusals', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let answer: Response = new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' }), {
    status: 200,
  });
  const mailer = postmarkMailer({
    token: 'postmark-test-value',
    from: 'PocoLobby <signin@pocolobby.com>',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return answer;
    },
  });
  await mailer.sendSignInCode(OWNER_EMAIL, '042517');
  const [sent] = requests;
  assert.equal(sent!.url, 'https://api.postmarkapp.com/email');
  const headers = sent!.init.headers as Record<string, string>;
  assert.equal(headers['x-postmark-server-token'], 'postmark-test-value');
  assert.equal(headers.accept, 'application/json');
  const body = JSON.parse(String(sent!.init.body)) as Record<string, unknown>;
  assert.equal(body.From, 'PocoLobby <signin@pocolobby.com>');
  assert.equal(body.To, OWNER_EMAIL);
  assert.equal(body.Subject, '042517 is your PocoLobby sign-in code');
  assert.equal(body.MessageStream, 'outbound');
  assert.equal(body.TrackOpens, false);
  assert.equal(body.TrackLinks, 'None');
  assert.match(String(body.TextBody), /042517/);
  assert.match(String(body.HtmlBody), /042517/);
  answer = new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), {
    status: 422,
  });
  await assert.rejects(
    mailer.sendSignInCode(OWNER_EMAIL, '042517'),
    (error: unknown) =>
      error instanceof MailError && /422, error 406\): Inactive recipient/.test(error.message),
  );
  // Postmark's ErrorCode decides, even with status 200.
  answer = new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), {
    status: 200,
  });
  await assert.rejects(mailer.sendSignInCode(OWNER_EMAIL, '1'), MailError);
  const unreachable = postmarkMailer({
    token: 't',
    from: 'f',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(unreachable.sendSignInCode(OWNER_EMAIL, '1'), /could not be reached/);
});

// ---------------------------------------------------------------------------------------------
// Lobbies and owner isolation.

async function twoOwners(t: TestContext) {
  const f = await browserFixture(t, (store) => {
    store.setAccount(
      { email: 'bea@example.com', enabled: true, may_create_lobbies: true },
      'no code',
    );
    store.createLobby('tokentek');
    store.grantLobby('bea@example.com', 'tokentek');
    store.createRoom('owner', 'design', 'tokentek');
    store.provision({
      agent_id: 'rey',
      lobby_id: 'tokentek',
      role: '',
      can_broadcast: false,
      allowed_recipients: null,
    });
    store.approveRepo('tokentek', 'bea/notes');
    store.approveRepo(LOBBY, 'johansan/my-team');
  });
  return { f, johan: await f.signIn(OWNER_EMAIL), bea: await f.signIn('bea@example.com') };
}

test('owner A can neither read nor change lobby B through any console route or field', async (t) => {
  const { f, johan, bea } = await twoOwners(t);
  for (const section of [
    '',
    '/rooms',
    '/summaries',
    '/board',
    '/agents',
    '/activity',
    '/settings',
  ]) {
    const page = await f.get(`/console/tokentek${section}`, johan);
    assert.equal(page.status, 404, section);
    // The page's random nonce could spell one of these names; its content cannot.
    const content = page.body.replace(/nonce="[^"]*"/gu, '');
    assert.doesNotMatch(content, /design|rey|bea@example\.com/, section);
    assert.equal((await f.get(`/console/tokentek${section}`, bea)).status, 200, section);
  }
  const actions: [string, unknown][] = [
    ['rooms', { room_id: 'stolen' }],
    ['rooms/design/members', { add: 'rey' }],
    ['rooms/design/source', { repo: 'bea/notes', notes: 'notes/' }],
    ['rooms/design/source/remove', {}],
    ['rooms/design/archive', {}],
    ['rooms/design/restore', {}],
    ['summaries', { model: 'claude-sonnet-5-5', effort: 'high' }],
    ['summaries/test', {}],
    ['board/visibility', { visibility: 'public' }],
    ['board/viewers', { email: 'spy@example.com' }],
    ['board/viewers/remove', { email: 'bea@example.com' }],
    ['delete', { confirm: 'tokentek' }],
  ];
  for (const [action, body] of actions) {
    const reply = await f.post(`/console/api/l/tokentek/${action}`, body, johan);
    assert.equal(reply.status, 404, action);
    assert.equal(errorCode(reply), 'lobby_not_found', action);
  }
  // Edited fields cannot reach B from A's own lobby either.
  const field = await f.post(
    `/console/api/l/${LOBBY}/rooms`,
    { room_id: 'x', lobby_id: 'tokentek' },
    johan,
  );
  assert.equal(field.status, 400);
  const foreignAgent = await f.post(
    `/console/api/l/${LOBBY}/rooms/app/members`,
    { add: 'rey' },
    johan,
  );
  assert.equal(errorCode(foreignAgent), 'agent_not_found');
  const foreignRepo = await f.post(
    `/console/api/l/${LOBBY}/rooms/app/source`,
    { repo: 'bea/notes', notes: 'notes/' },
    johan,
  );
  assert.equal(errorCode(foreignRepo), 'repo_not_approved');
  // B is untouched.
  const status = JSON.parse((await f.admin_('GET', '/v1/admin/board?lobby=tokentek')).body) as {
    visibility: string;
    viewers: number;
    summary_settings: { model: string };
  };
  assert.deepEqual(
    [status.visibility, status.viewers, status.summary_settings.model],
    ['private', 0, 'claude-haiku-5-5'],
  );
  const rooms = JSON.parse((await f.admin_('GET', '/v1/admin/rooms?lobby=tokentek')).body) as {
    rooms: { room_id: string; members: string[] }[];
  };
  assert.deepEqual(rooms.rooms, [{ lobby_id: 'tokentek', room_id: 'design', members: [] }]);
  // The store refuses too, whatever a route forgot: ownership is checked inside each change.
  const store = new LobbyStore(':memory:');
  t.after(() => store.close());
  store.setAccount({ email: 'a@example.com', may_create_lobbies: true }, 'no code');
  const account = store.accounts()[0]!.account_id;
  assert.throws(
    () => store.createRoom({ account_id: account }, 'x', LOBBY),
    rejectsCode('lobby_not_found'),
  );
  assert.throws(
    () => store.setBoardVisibility({ account_id: account }, LOBBY, 'public'),
    rejectsCode('lobby_not_found'),
  );
  assert.throws(
    () => store.deleteLobby({ account_id: account }, LOBBY, LOBBY),
    rejectsCode('lobby_not_found'),
  );
});

test('a signed-in account that is not a viewer cannot open a private board', async (t) => {
  const { f, bea, johan } = await twoOwners(t);
  const open = await f.get(`/console/open/${LOBBY}`, bea);
  assert.equal(open.status, 404);
  assert.match(open.body, /cannot open a board named my-team/);
  // Once added as a viewer, Bea opens it, and only it.
  await f.post(`/console/api/l/${LOBBY}/board/viewers`, { email: 'Bea@Example.com' }, johan);
  const board = await f.openBoard(bea);
  assert.equal((await f.onBoard('/', { headers: { cookie: board } })).status, 200);
  assert.equal((await f.onBoard('/', { headers: { cookie: board } }, 'tokentek')).status, 303);
  const home = await f.get('/console', bea);
  assert.match(home.body, /Boards shared with you/);
});

test('creating lobbies: DNS-label names, reserved and used names, and the allowance of three', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.setAccount({ email: 'new@example.com', may_create_lobbies: true }, 'no code');
    store.addBoardViewer('owner', LOBBY, 'viewer@example.com');
  });
  const owner = await f.signIn('new@example.com');
  const create = (lobby_id: string, first_room?: string) =>
    f.post('/console/api/lobbies', { lobby_id, ...(first_room ? { first_room } : {}) }, owner);
  for (const name of ['console', 'www', 'lobby', 'my_team', 'Team', 'team-', '9lives'])
    assert.equal((await create(name)).status, 400, name);
  assert.equal(errorCode(await create(LOBBY)), 'lobby_exists');
  const made = await create('tokentek', 'general');
  assert.equal(made.status, 200, made.body);
  assert.deepEqual(JSON.parse(made.body), { ok: true, redirect: '/console/tokentek' });
  const rooms = JSON.parse((await f.admin_('GET', '/v1/admin/rooms?lobby=tokentek')).body) as {
    rooms: { room_id: string }[];
  };
  assert.deepEqual(
    rooms.rooms.map((room) => room.room_id),
    ['general'],
  );
  assert.equal((await create('second')).status, 200);
  assert.equal((await create('third')).status, 200);
  assert.equal(errorCode(await create('fourth')), 'lobby_allowance');
  // A deleted lobby's name is never used again, by anyone.
  const deleted = await f.post('/console/api/l/third/delete', { confirm: 'third' }, owner);
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(errorCode(await create('third')), 'lobby_exists');
  assert.equal(
    errorCode(await f.admin_('POST', '/v1/admin/lobbies', { lobby_id: 'third' })),
    'lobby_exists',
  );
  // A viewer may not create lobbies.
  const viewer = await f.signIn('viewer@example.com');
  const refused = await f.post('/console/api/lobbies', { lobby_id: 'mine' }, viewer);
  assert.equal(errorCode(refused), 'lobby_creation_forbidden');
  // A new lobby says how agents get in.
  const overview = await f.get('/console/tokentek', owner);
  assert.match(overview.body, /The server operator admits each agent with/);
});

test('a notes path with spaces is kept whole, and saving a source unchanged keeps its notes', async (t) => {
  const notes = ['notes/Release plan.md', 'PLAN.md'];
  const f = await browserFixture(t, (store) => {
    store.approveRepo(LOBBY, 'johansan/my-team');
    store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes }, 'owner');
    store.saveBoardNotes(LOBBY, store.boardSources(LOBBY)[0]!, {
      commit_sha: 'a'.repeat(40),
      fetched_at: '2026-10-16T07:00:00.000Z',
      files: [
        { path: 'PLAN.md', sha: 'b'.repeat(40), bytes: 4, truncated: false, content: 'plan' },
      ],
    });
  });
  const session = await f.signIn(OWNER_EMAIL);
  const saved = await f.post(
    `/console/api/l/${LOBBY}/rooms/app/source`,
    { repo: 'johansan/my-team', notes: 'notes/Release plan.md, PLAN.md' },
    session,
  );
  assert.equal(saved.status, 200, saved.body);
  const status = JSON.parse((await f.admin_('GET', `/v1/admin/board?lobby=${LOBBY}`)).body) as {
    sources: { room_id: string; notes: string[]; commit_sha?: string | null }[];
  };
  assert.deepEqual(status.sources[0]!.notes, notes);
  assert.equal(
    status.sources[0]!.commit_sha,
    'a'.repeat(40),
    'an unchanged source keeps its notes',
  );
});

test('console pages render every section with their nonce and escape what they show', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.approveRepo(LOBBY, 'johansan/my-team');
    store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes/'] }, 'owner');
    store.addBoardViewer('owner', LOBBY, "o'brien+board@example.com");
  });
  const session = await f.signIn(OWNER_EMAIL);
  const expected: Record<string, RegExp> = {
    '': /Repositories/,
    '/rooms': /Rooms and repos[\s\S]*#<\/span>app/,
    '/summaries': /Claude Sonnet 5\.5[\s\S]*Run a test summary/,
    '/board': /my-team\.board\.test[\s\S]*o&#39;brien\+board@example\.com/,
    '/agents': /vader[\s\S]*coordinator/,
    '/activity': /The operator/,
    '/settings': /Type the lobby name to confirm/,
  };
  for (const [section, pattern] of Object.entries(expected)) {
    const page = await f.get(`/console/${LOBBY}${section}`, session);
    assert.equal(page.status, 200, section);
    assert.match(page.body, pattern, section);
    const csp = String(page.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, section);
    for (const tag of page.body.match(/<(script|style)\b[^>]*>/g) ?? [])
      assert.ok(tag.includes(`nonce="${nonce}"`), `${section}: ${tag}`);
    assert.doesNotMatch(page.body, /\sstyle="|\son[a-z]+="/, section);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.doesNotMatch(page.body, /ANTHROPIC_API_KEY=|token_hash|pl_[A-Za-z0-9_-]{20}/, section);
  }
});

// ---------------------------------------------------------------------------------------------
// Rooms: archive and restore, activity.

function memoryStore(t: TestContext, now: () => number = Date.now) {
  const store = new LobbyStore(':memory:', { now, infoDelayMs: 0 });
  store.createLobby('my-team');
  t.after(() => store.close());
  return store;
}
const activate = (store: LobbyStore, id: string): RuntimeBinding => {
  const binding = store.claimRuntime(id, randomUUID());
  store.ready(id, binding, {
    context_revision: store.context(id).checkpoint.revision,
    probe_nonce: binding.probe_nonce,
  });
  return binding;
};

test('archiving a room delivers what it accepted, scheduled messages included, and reserves its name', (t) => {
  let now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  for (const id of ['leia', 'mouse'])
    store.provision({ agent_id: id, role: '', can_broadcast: false, allowed_recipients: null });
  store.provision({
    agent_id: 'vader',
    role: '',
    can_broadcast: false,
    allowed_recipients: null,
    manage_rooms: true,
  });
  store.createRoom('owner', 'app', LOBBY);
  store.setRoomMembers('owner', 'app', ['leia', 'mouse', 'vader'], LOBBY);
  const vader = activate(store, 'vader');
  store.send('vader', { client_request_id: 'now', to: '*', room: 'app', content: 'Main is green' });
  store.send('vader', {
    client_request_id: 'later',
    to: '*',
    room: 'app',
    content: 'Standup in an hour',
    deliver_at: new Date(now + 3_600_000).toISOString(),
  });
  // Leia was removed before the archive: her unseen room messages are held, and stay held.
  store.send('vader', { client_request_id: 'held', to: '*', room: 'app', content: 'For members' });
  store.changeRoomMembers('owner', 'app', { remove: ['leia'] }, LOBBY);
  const schedule = store.createSchedule('vader', vader, {
    client_request_id: 'daily',
    to: '*',
    room: 'app',
    content: 'Daily check',
    repeat: { time_zone: 'Europe/Stockholm', times: ['09:00'] },
  });
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes'] }, 'owner');
  const archived = store.archiveRoom('owner', 'app', LOBBY);
  assert.deepEqual(archived.former_members, ['mouse', 'vader']);
  assert.deepEqual(
    archived.cancelled_schedules.map((item) => item.schedule_id),
    [schedule.schedule.schedule_id],
  );
  // Accepted messages are still delivered: pending now, scheduled when due.
  const pending = (id: string) => store.messages(id).items.map((message) => message.content);
  assert.deepEqual(pending('mouse'), ['Main is green', 'For members']);
  assert.deepEqual(pending('leia'), []);
  now += 3_600_000;
  store.releaseDue();
  assert.deepEqual(pending('mouse'), ['Main is green', 'Standup in an hour', 'For members']);
  assert.deepEqual(pending('leia'), []);
  // No more sends, no new room by that name, no members, no schedule.
  assert.throws(
    () => store.send('vader', { client_request_id: 'after', to: '*', room: 'app', content: 'x' }),
    rejectsCode('room_archived'),
  );
  assert.throws(() => store.createRoom('owner', 'app', LOBBY), rejectsCode('room_archived'));
  assert.equal(store.scheduled('vader').schedules.length, 0);
  // Its notes source is kept but no longer read: a fetch finishing now stores nothing.
  assert.deepEqual(store.boardSources(LOBBY), []);
  assert.deepEqual(store.boardLobbies(), []);
  assert.equal(
    store.saveBoardNotes(
      LOBBY,
      { room_id: 'app', repo: 'johansan/my-team', ref: 'main', notes: ['notes'] },
      { commit_sha: 'a'.repeat(40), files: [], fetched_at: new Date(now).toISOString() },
    ),
    false,
  );
  // Restore brings it back empty, with its source; the schedule stays cancelled.
  const restored = store.restoreRoom('owner', 'app', LOBBY);
  assert.deepEqual(restored.members, []);
  assert.equal(store.boardSources(LOBBY).length, 1);
  assert.equal(store.scheduled('vader').schedules.length, 0);
  assert.throws(() => store.restoreRoom('owner', 'app', LOBBY), rejectsCode('room_not_found'));
});

test('kept sources of archived rooms count toward the source limit, so a restore cannot exceed it', (t) => {
  const store = memoryStore(t);
  for (let index = 0; index < MAX_BOARD_SOURCES; index += 1) {
    store.createRoom('owner', `room-${index}`, LOBBY);
    store.setBoardSource(
      LOBBY,
      `room-${index}`,
      {
        repo: 'johansan/my-team',
        notes: ['PLAN.md'],
      },
      'owner',
    );
  }
  store.archiveRoom('owner', 'room-0', LOBBY);
  assert.equal(store.boardSources(LOBBY).length, MAX_BOARD_SOURCES - 1);
  store.createRoom('owner', 'extra', LOBBY);
  assert.throws(
    () =>
      store.setBoardSource(
        LOBBY,
        'extra',
        { repo: 'johansan/my-team', notes: ['PLAN.md'] },
        'owner',
      ),
    rejectsCode('board_source_capacity'),
  );
  store.restoreRoom('owner', 'room-0', LOBBY);
  assert.equal(store.boardSources(LOBBY).length, MAX_BOARD_SOURCES);
  // Removing the archived room's source frees its place.
  store.archiveRoom('owner', 'room-0', LOBBY);
  store.removeBoardSource(LOBBY, 'room-0', 'owner');
  store.setBoardSource(LOBBY, 'extra', { repo: 'johansan/my-team', notes: ['PLAN.md'] }, 'owner');
  assert.equal(store.boardSources(LOBBY).length, MAX_BOARD_SOURCES);
});

test('activity records who changed a room: the owner in the console, an agent through the API', async (t) => {
  const f = await browserFixture(t);
  const session = await f.signIn(OWNER_EMAIL);
  await f.post(`/console/api/l/${LOBBY}/rooms`, { room_id: 'night-test' }, session);
  await f.post(`/console/api/l/${LOBBY}/rooms/night-test/members`, { add: 'leia' }, session);
  await f.post(`/console/api/l/${LOBBY}/rooms/night-test/archive`, {}, session);
  await f.post(`/console/api/l/${LOBBY}/rooms/night-test/restore`, {}, session);
  await f.post(
    `/console/api/l/${LOBBY}/summaries`,
    { model: 'claude-sonnet-5-5', effort: 'medium' },
    session,
  );
  await f.post(`/console/api/l/${LOBBY}/board/visibility`, { visibility: 'public' }, session);
  const page = await f.get(`/console/${LOBBY}/activity`, session);
  for (const sentence of [
    /owner@example\.com<\/strong> made the board public/,
    /set summaries to Claude Sonnet 5\.5, medium reasoning/,
    /restored room #night-test/,
    /archived room #night-test/,
    /added leia to #night-test/,
    /created room #night-test/,
    /The operator<\/strong> created room #app/,
  ])
    assert.match(page.body, sentence);
  assert.match(page.body, /Console<\/span>/);
  assert.match(page.body, /CLI<\/span>/);
  // A coordinator's change through the API shows as the agent.
  const store = new LobbyStore(':memory:');
  t.after(() => store.close());
  store.createLobby('my-team');
  store.provision({
    agent_id: 'vader',
    role: '',
    can_broadcast: false,
    allowed_recipients: null,
    manage_rooms: true,
  });
  store.createRoom('vader', 'app');
  const [event] = store.activity(LOBBY);
  assert.deepEqual(
    [event!.actor_kind, event!.actor, event!.action, event!.target],
    ['agent', 'vader', 'create_room', 'app'],
  );
});

// ---------------------------------------------------------------------------------------------
// Deleting a lobby.

const png = (tag: number) =>
  Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806', 'hex'),
    Buffer.from([tag]),
  ]);

test('deleting a lobby removes everything in it, keeps content another lobby shares, and disconnects its agents', async (t) => {
  const shared = png(1);
  const own = png(2);
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  let tokentekToken = '';
  let finnToken = '';
  const f = await browserFixture(t, (store) => {
    store.setAccount({ email: 'bea@example.com', may_create_lobbies: true }, 'no code');
    store.createOwnedLobby(
      store.accounts().find((a) => a.email === 'bea@example.com')!.account_id,
      {
        lobby_id: 'tokentek',
        first_room: 'design',
      },
    );
    tokentekToken = store.provision({
      agent_id: 'rey',
      lobby_id: 'tokentek',
      role: '',
      can_broadcast: false,
      allowed_recipients: null,
    }).token;
    finnToken = store.provision({
      agent_id: 'finn',
      lobby_id: 'tokentek',
      role: '',
      can_broadcast: false,
      allowed_recipients: null,
    }).token;
    const rey = activate(store, 'tokentek/rey');
    const leia = activate(store, 'my-team/leia');
    const describe = (bytes: Buffer, filename: string) => ({
      sha256: sha(bytes),
      filename,
      mime_type: 'image/png' as const,
      size: bytes.length,
    });
    for (const bytes of [shared, own])
      store.uploadAttachment('tokentek/rey', rey, sha(bytes), bytes);
    store.send('tokentek/rey', {
      client_request_id: 'both',
      to: 'finn',
      content: 'Two screenshots',
      attachments: [describe(shared, 'a.png'), describe(own, 'b.png')],
    });
    store.uploadAttachment('my-team/leia', leia, sha(shared), shared);
    store.send('my-team/leia', {
      client_request_id: 'same',
      to: 'mouse',
      content: 'The same screenshot',
      attachments: [describe(shared, 'same.png')],
    });
    store.approveRepo('tokentek', 'bea/notes');
    store.setBoardSource('tokentek', 'design', { repo: 'bea/notes', notes: ['notes'] }, 'owner');
    store.addBoardViewer('owner', 'tokentek', 'viewer@example.com');
  });
  const attachments = join(dirname(f.database), 'attachments');
  assert.ok(existsSync(join(attachments, sha(shared))));
  assert.ok(existsSync(join(attachments, sha(own))));
  // Finn is connected when the lobby goes.
  const claim = await call(f.server.url, '127.0.0.1', '/v1/runtime', {
    method: 'POST',
    headers: { authorization: `Bearer ${finnToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runtime_id: randomUUID() }),
  });
  const binding = JSON.parse(claim.body) as RuntimeBinding;
  const socket = new WebSocket(`${f.server.url.replace('http:', 'ws:')}/v1/events`, {
    headers: {
      authorization: `Bearer ${finnToken}`,
      'x-pocolobby-runtime-id': binding.runtime_id,
      'x-pocolobby-generation': String(binding.generation),
      'x-pocolobby-incarnation': binding.incarnation,
      'x-pocolobby-event-version': '5',
    },
  });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('open', resolve));
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  const bea = await f.signIn('bea@example.com');
  const mismatch = await f.post('/console/api/l/tokentek/delete', { confirm: 'TokenTek' }, bea);
  assert.equal(errorCode(mismatch), 'confirmation_mismatch');
  const deleted = await f.post('/console/api/l/tokentek/delete', { confirm: 'tokentek' }, bea);
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(await closed, 4401);
  // Its credential is gone; content only it held is gone; shared content stays for the other.
  const after = await call(f.server.url, '127.0.0.1', '/v1/agents', {
    headers: { authorization: `Bearer ${tokentekToken}` },
  });
  assert.equal(after.status, 401);
  assert.ok(existsSync(join(attachments, sha(shared))));
  assert.ok(!existsSync(join(attachments, sha(own))));
  await f.server.close();
  const db = new DatabaseSync(f.database);
  const count = (sql: string) => Number(db.prepare(sql).get()?.n);
  for (const table of [
    'agents',
    'messages',
    'rooms',
    'attachments',
    'board_sources',
    'board_viewers',
    'lobby_repos',
  ])
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table} WHERE lobby_id='tokentek'`), 0, table);
  assert.equal(count("SELECT COUNT(*) AS n FROM lobbies WHERE lobby_id='tokentek'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM deleted_lobbies WHERE lobby_id='tokentek'"), 1);
  assert.equal(
    count(
      "SELECT COUNT(*) AS n FROM admin_events WHERE lobby_id='tokentek' AND action='delete_lobby' AND actor_kind='account'",
    ),
    1,
  );
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256='${sha(shared)}'`),
    1,
  );
  assert.equal(count(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256='${sha(own)}'`), 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // The other lobby's recipient still opens the shared screenshot.
  db.close();
  const store = new LobbyStore(f.database, { attachmentsDir: attachments });
  t.after(() => store.close());
  const [message] = store.messages('mouse').items;
  const content = store.attachmentFile('mouse', message!.attachments![0]!.id);
  assert.deepEqual(readFileSync(content.path), shared);
});

test('a lobby deleted while its notes and summary requests are under way stores nothing and breaks nothing', async (t) => {
  const now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  store.createLobby('tokentek');
  for (const lobby of ['tokentek', LOBBY]) {
    store.createRoom('owner', 'app', lobby);
    store.setBoardSource(lobby, 'app', { repo: `owner/${lobby}`, notes: ['PLAN.md'] }, 'owner');
    store.saveBoardNotes(
      lobby,
      { room_id: 'app', repo: `owner/${lobby}`, ref: 'main', notes: ['PLAN.md'] },
      {
        commit_sha: 'a'.repeat(40),
        fetched_at: new Date(now).toISOString(),
        files: [{ path: 'PLAN.md', sha: 'b', bytes: 4, truncated: false, content: '# Plan' }],
      },
    );
  }
  // GitHub answers the tokentek fetch only when released; the model likewise.
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => (releaseFetch = resolve));
  const fetched: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('tokentek')) await fetchGate;
    return new Response('', { status: 304, headers: { etag: '"x"' } });
  };
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
  const calls: string[] = [];
  const client: SummaryClient = {
    async create(request) {
      const lobby = JSON.parse(String(request.messages[0]!.content)).lobby as string;
      calls.push(lobby);
      if (lobby === 'tokentek') await modelGate;
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: request.model,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agents: [] }),
            citations: null,
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      } as unknown as Anthropic.Message;
    },
  };
  const board = new BoardService(
    store,
    {
      domain: DOMAIN,
      githubToken: 'github-test-value',
      githubApi: 'http://github.invalid',
      fetch: fakeFetch,
      summaryClient: client,
    },
    () => true,
    () => now,
  );
  t.after(() => board.close());
  // First the notes fetch is in flight.
  const first = board.tick();
  while (!fetched.some((url) => url.includes('tokentek')))
    await new Promise((resolve) => setImmediate(resolve));
  store.deleteLobby('owner', 'tokentek', 'tokentek');
  releaseFetch();
  await first;
  // The other lobby summarized; the deleted one stored nothing.
  assert.deepEqual(calls, [LOBBY]);
  assert.equal(store.boardNotes('tokentek').size, 0);
  // Then a summary is in flight when its lobby goes.
  store.createLobby('second');
  store.createRoom('owner', 'app', 'second');
  store.setBoardSource('second', 'app', { repo: 'owner/second', notes: ['PLAN.md'] }, 'owner');
  store.saveBoardNotes(
    'second',
    { room_id: 'app', repo: 'owner/second', ref: 'main', notes: ['PLAN.md'] },
    {
      commit_sha: 'c'.repeat(40),
      fetched_at: new Date(now).toISOString(),
      files: [{ path: 'PLAN.md', sha: 'd', bytes: 4, truncated: false, content: '# Two' }],
    },
  );
  const original = client.create.bind(client);
  client.create = async (request, options) => {
    const lobby = JSON.parse(String(request.messages[0]!.content)).lobby as string;
    if (lobby === 'second') {
      calls.push(lobby);
      await modelGate;
    }
    return original(request, options);
  };
  const second = board.tick();
  while (!calls.includes('second')) await new Promise((resolve) => setImmediate(resolve));
  store.deleteLobby('owner', 'second', 'second');
  releaseModel();
  await second;
  assert.equal(store.boardLastAttempt('second'), null);
  assert.deepEqual(store.boardLobbies(), [LOBBY]);
});

// ---------------------------------------------------------------------------------------------
// Summaries: model, effort, cost and the test run.

test("the lobby's model and effort reach the summarizer, and Sonnet is priced as Sonnet", async (t) => {
  const now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  store.createRoom('owner', 'app', LOBBY);
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['PLAN.md'] }, 'owner');
  store.saveBoardNotes(
    LOBBY,
    { room_id: 'app', repo: 'johansan/my-team', ref: 'main', notes: ['PLAN.md'] },
    {
      commit_sha: 'a'.repeat(40),
      fetched_at: new Date(now).toISOString(),
      files: [{ path: 'PLAN.md', sha: 'b', bytes: 6, truncated: false, content: '# Plan' }],
    },
  );
  store.setSummarySettings('owner', LOBBY, { model: 'claude-sonnet-5-5', effort: 'medium' });
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const usage = {
    input_tokens: 20_000,
    output_tokens: 2_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const client: SummaryClient = {
    async create(request) {
      requests.push(request);
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: request.model,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ agents: [] }),
            citations: null,
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      } as unknown as Anthropic.Message;
    },
  };
  const board = new BoardService(
    store,
    { domain: DOMAIN, summaryClient: client },
    () => true,
    () => now,
  );
  t.after(() => board.close());
  await board.tick();
  assert.equal(requests[0]!.model, 'claude-sonnet-5-5');
  assert.equal(requests[0]!.output_config?.effort, 'medium');
  const record = store.boardSummary(LOBBY)!;
  assert.equal(record.model, 'claude-sonnet-5-5');
  // $2 / $10 per million: 20K in and 2K out cost $0.06.
  assert.ok(Math.abs(record.cost_usd - 0.06) < 1e-9, String(record.cost_usd));
  assert.ok(Math.abs(summaryCost(usage, 0, 'claude-haiku-5-5') - 0.003) < 1e-9);
  // A test run forces a summary, at most once per five minutes and never alongside another.
  assert.throws(() => board.runNow(LOBBY), rejectsCode('summary_test_wait'));
  const later = new BoardService(
    store,
    { domain: DOMAIN, summaryClient: client },
    () => true,
    () => now + 5 * 60_000,
  );
  t.after(() => later.close());
  const run = later.runNow(LOBBY);
  assert.throws(() => later.runNow(LOBBY), rejectsCode('summary_running'));
  const stored = await run;
  assert.equal(stored?.model, 'claude-sonnet-5-5');
  assert.equal(requests.length, 2);
  const keyless = new BoardService(
    store,
    { domain: DOMAIN },
    () => true,
    () => now,
  );
  t.after(() => keyless.close());
  assert.throws(() => keyless.runNow(LOBBY), rejectsCode('summary_unavailable'));
  // Once a lobby's summaries cost $5 in 24 hours, they pause, test runs included.
  store.saveBoardSummary({
    lobby_id: LOBBY,
    input_hash: 'spent',
    sources: [],
    model: 'claude-sonnet-5-5',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    cost_usd: 5,
    summary: null,
    error: 'Spent',
  });
  const spent = new BoardService(
    store,
    { domain: DOMAIN, summaryClient: client },
    () => true,
    () => now + 20 * 60_000,
  );
  t.after(() => spent.close());
  assert.throws(() => spent.runNow(LOBBY), rejectsCode('summary_budget'));
  await spent.tick();
  assert.equal(requests.length, 2);
  assert.match(spent.view(LOBBY).problems.join(' '), /New summaries are paused/);
});

// ---------------------------------------------------------------------------------------------
// The operator CLI.

test('operator CLI: allow, grant, revoke, enable, accounts and approved repositories', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.createLobby('tokentek');
  });
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-console-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'owner.json');
  await writeFile(config, JSON.stringify({ url: f.server.url, token: f.admin }));
  await chmod(config, 0o600);
  const out: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0;
    await runCli([...args, '--config', config], {
      stdout: (line) => out.push(line),
      stderr: () => {},
    });
    return JSON.parse(out.join('\n')) as Record<string, unknown>;
  };
  const allowed = await cli('console', 'allow', 'Bea@Example.com');
  assert.deepEqual(
    [allowed.email, allowed.may_create_lobbies, allowed.disabled_at],
    ['bea@example.com', true, null],
  );
  await assert.rejects(
    runCli(['console', 'grant', 'bea@example.com', LOBBY, '--config', config], {
      stdout: () => {},
    }),
    /lobby_owned|Another account owns/,
  );
  const granted = await cli('console', 'grant', 'bea@example.com', 'tokentek');
  assert.deepEqual(granted.owns, ['tokentek']);
  assert.deepEqual((await cli('console', 'repos', 'tokentek', 'add', 'Bea/Notes')).repos, [
    'bea/notes',
  ]);
  assert.deepEqual((await cli('console', 'repos', 'tokentek', 'list')).repos, ['bea/notes']);
  assert.equal(
    (await f.admin_('POST', '/v1/admin/rooms?lobby=tokentek', { room_id: 'general' })).status,
    201,
  );
  await cli(
    'board',
    'source',
    'set',
    'tokentek',
    'general',
    '--repo',
    'bea/notes',
    '--notes',
    'notes/',
  );
  await assert.rejects(
    runCli(['console', 'repos', 'tokentek', 'remove', 'bea/notes', '--config', config], {
      stdout: () => {},
    }),
    /repo_in_use|still read/,
  );
  // The operator's own source approves its repository.
  await cli(
    'board',
    'source',
    'set',
    'tokentek',
    'general',
    '--repo',
    'bea/other',
    '--notes',
    'notes/',
  );
  assert.deepEqual((await cli('console', 'repos', 'tokentek')).repos, ['bea/notes', 'bea/other']);
  assert.deepEqual((await cli('console', 'repos', 'tokentek', 'remove', 'bea/notes')).repos, [
    'bea/other',
  ]);
  // Bea signs in; revoking her ownership of one lobby leaves her account; revoking the account ends it.
  const session = await f.signIn('bea@example.com');
  assert.equal((await f.get('/console/tokentek', session)).status, 200);
  const ungranted = await cli('console', 'revoke', 'bea@example.com', 'tokentek');
  assert.deepEqual(ungranted.owns, []);
  assert.equal((await f.get('/console/tokentek', session)).status, 404);
  assert.match((await f.get('/console', session)).body, /Your lobbies/);
  const revoked = await cli('console', 'revoke', 'bea@example.com');
  assert.notEqual(revoked.disabled_at, null);
  assert.doesNotMatch((await f.get('/console', session)).body, /Your lobbies/);
  const enabled = await cli('console', 'enable', 'bea@example.com');
  assert.deepEqual([enabled.disabled_at, enabled.may_create_lobbies], [null, true]);
  const listing = (await cli('console', 'accounts')).accounts as { email: string }[];
  assert.deepEqual(
    listing.map((account) => account.email),
    ['bea@example.com', OWNER_EMAIL],
  );
  assert.doesNotMatch(out.join('\n'), /token_hash|code_mac/);
});

test('recovery mode ends every browser session and waits for the operator to enable accounts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-console-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LobbyStore(join(directory, 'lobby.db'));
  store.createLobby(LOBBY);
  t.after(() => store.close());
  store.grantLobby(OWNER_EMAIL, LOBBY);
  const account = store.accounts()[0]!.account_id;
  const keys = new SignInKeys(randomBytes(32).toString('base64url'));
  const key = keys.emailKey(OWNER_EMAIL);
  assert.equal(store.beginSignIn(OWNER_EMAIL, key, keys.codeMac(key, '111111')).send, true);
  const session = tokenHash('s'.repeat(43));
  assert.deepEqual(store.finishSignIn(OWNER_EMAIL, key, keys.codeMac(key, '111111'), session), {
    account_id: account,
  });
  assert.ok(store.createHandoff(account, LOBBY, tokenHash('h'.repeat(43))));
  store.enterRecovery();
  assert.equal(store.consoleSession(session), null);
  assert.equal(
    store.consumeHandoff(LOBBY, tokenHash('h'.repeat(43)), tokenHash('b'.repeat(43))),
    false,
  );
  assert.notEqual(store.accounts()[0]!.disabled_at, null);
  assert.equal(store.beginSignIn(OWNER_EMAIL, key, keys.codeMac(key, '222222')).send, false);
  store.setAccount({ email: OWNER_EMAIL, enabled: true }, key);
  assert.deepEqual(store.accounts()[0]!.owns, [LOBBY]);
});

test('expired codes, sessions, hand-offs and rate rows are pruned', async (t) => {
  let now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  store.grantLobby(OWNER_EMAIL, LOBBY);
  const account = store.accounts()[0]!.account_id;
  const keys = new SignInKeys('k'.repeat(43));
  const key = keys.emailKey(OWNER_EMAIL);
  store.beginSignIn(OWNER_EMAIL, key, keys.codeMac(key, '111111'));
  store.finishSignIn(OWNER_EMAIL, key, keys.codeMac(key, '222222'), tokenHash('x'.repeat(43)));
  store.beginSignIn('nobody@example.com', keys.emailKey('nobody@example.com'), 'ab');
  store.createHandoff(account, LOBBY, tokenHash('h'.repeat(43)));
  now += 31 * 86_400_000;
  store.pruneSignIn();
  const keysLeft = new SignInKeys('k'.repeat(43));
  // Nothing expired remains to be found: a new sign-in starts from a clean budget.
  const again = keysLeft.emailKey(OWNER_EMAIL);
  assert.equal(store.beginSignIn(OWNER_EMAIL, again, keysLeft.codeMac(again, '333333')).wait, 0);
  assert.equal(
    store.consumeHandoff(LOBBY, tokenHash('h'.repeat(43)), tokenHash('y'.repeat(43))),
    false,
  );
});

test('a console action whose body arrives after sign-out changes nothing', async (t) => {
  const { request: httpRequest } = await import('node:http');
  const f = await browserFixture(t);
  const session = await f.signIn(OWNER_EMAIL);
  // The board is private: a visitor without a session is sent to sign in.
  assert.equal((await f.onBoard('/')).status, 303);
  const body = JSON.stringify({ visibility: 'public' });
  const status = await new Promise<number>((resolve, reject) => {
    const call = httpRequest(`${f.server.url}/console/api/l/${LOBBY}/board/visibility`, {
      method: 'POST',
      headers: {
        host: DOMAIN,
        origin: CONSOLE,
        cookie: session,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    });
    call.on('response', (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    call.on('error', reject);
    // Half the body now; the owner signs out before the rest arrives.
    call.write(body.slice(0, 5));
    setTimeout(async () => {
      assert.equal((await f.post('/console/api/sign-out', {}, session)).status, 200);
      call.end(body.slice(5));
    }, 50);
  });
  assert.equal(status, 401);
  assert.equal((await f.onBoard('/')).status, 303);
});

test('a hand-off ends the browser’s earlier session on that board, so devices are not overcounted', (t) => {
  const now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  store.grantLobby(OWNER_EMAIL, LOBBY);
  store.setBoardVisibility('owner', LOBBY, 'private');
  const account = store.accounts()[0]!.account_id;
  const first = tokenHash('a'.repeat(43));
  const second = tokenHash('b'.repeat(43));
  store.createHandoff(account, LOBBY, tokenHash('h'.repeat(43)));
  assert.ok(store.consumeHandoff(LOBBY, tokenHash('h'.repeat(43)), first));
  store.createHandoff(account, LOBBY, tokenHash('i'.repeat(43)));
  assert.ok(store.consumeHandoff(LOBBY, tokenHash('i'.repeat(43)), second, first));
  assert.equal(store.boardViewer(LOBBY, first), null);
  assert.notEqual(store.boardViewer(LOBBY, second), null);
});

test('one address gets at most five sign-in codes an hour, however the requests are spread', (t) => {
  // Anyone who knows an address could otherwise have a code mailed to it every minute.
  let now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  store.grantLobby(OWNER_EMAIL, LOBBY);
  const keys = new SignInKeys('k'.repeat(43));
  const key = keys.emailKey(OWNER_EMAIL);
  const sent = () => store.beginSignIn(OWNER_EMAIL, key, keys.codeMac(key, '111111'));
  for (let index = 0; index < 5; index++) {
    assert.equal(sent().send, true);
    now += 61_000;
  }
  assert.ok(sent().wait > 0);
  now = Date.parse('2026-10-16T08:00:01Z');
  assert.equal(sent().send, true);
});

test('IPv6 clients share their /64 for every per-client limit', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
});

test('a board kept open is extended once a day, so a dashboard does not sign out after 30 days', (t) => {
  let now = Date.parse('2026-10-16T07:00:00Z');
  const day = 86_400_000;
  const store = memoryStore(t, () => now);
  store.grantLobby(OWNER_EMAIL, LOBBY);
  store.setBoardVisibility('owner', LOBBY, 'private');
  const account = store.accounts()[0]!.account_id;
  const session = tokenHash('a'.repeat(43));
  store.createHandoff(account, LOBBY, tokenHash('h'.repeat(43)));
  assert.ok(store.consumeHandoff(LOBBY, tokenHash('h'.repeat(43)), session));
  assert.equal(store.boardSession(LOBBY, session)?.refresh, false);
  for (let index = 0; index < 40; index++) {
    now += day;
    const found = store.boardSession(LOBBY, session);
    assert.ok(found, `day ${index + 1}`);
    if (found.refresh) store.refreshBoardSession(session);
    assert.equal(store.boardSession(LOBBY, session)?.refresh, false);
  }
  // Unused for 30 days, it ends.
  now += 30 * day;
  assert.equal(store.boardSession(LOBBY, session), null);
});

// ---------------------------------------------------------------------------------------------
// Icons and the console's addresses (0.8.2).

const iconPng = (width: number, height = width) =>
  encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(200) });

test('every host serves PocoLobby’s icon and every page links it', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.setBoardVisibility('owner', LOBBY, 'public');
  });
  for (const [host, path, type] of [
    [DOMAIN, '/favicon.svg', 'image/svg+xml'],
    [DOMAIN, '/favicon.ico', 'image/x-icon'],
    [`knock.${DOMAIN}`, '/favicon-32.png', 'image/png'],
    [`${LOBBY}.${DOMAIN}`, '/apple-touch-icon.png', 'image/png'],
    [`nolobby.${DOMAIN}`, '/favicon.svg', 'image/svg+xml'],
  ] as const) {
    const reply = await call(f.server.url, host, path);
    assert.equal(reply.status, 200, `${host}${path}`);
    assert.equal(reply.headers['content-type'], type);
    assert.equal(reply.headers['cache-control'], 'public, max-age=86400');
  }
  const links =
    /<link rel="icon" href="\/favicon\.svg"[\s\S]*<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/;
  assert.match(
    (await call(f.server.url, DOMAIN, '/')).body,
    /<link rel="icon" href="\/favicon\.svg"/,
  );
  assert.match((await f.get('/console/sign-in')).body, links);
  assert.match((await f.get(`/console/${LOBBY}`, await f.signIn(OWNER_EMAIL))).body, links);
  assert.match((await f.onBoard('/')).body, links);
  // Without its own icon, a board has none at /icon.png.
  assert.equal((await f.onBoard('/icon.png')).status, 404);
});

test('a lobby owner gives the board its own icon; only those who may open the board get it', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.grantLobby('bea@example.com', store.createLobby('tokentek').lobby_id);
  });
  const owner = await f.signIn(OWNER_EMAIL);
  const bea = await f.signIn('bea@example.com');
  const upload = (png: Buffer, cookie = owner) =>
    f.post(`/console/api/l/${LOBBY}/board/icon`, { png: png.toString('base64') }, cookie);
  // Only a square PNG from 32 to 1024 pixels, at most 64 KB.
  const refused = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 400, 'icon_not_png'],
    [iconPng(64, 48), 400, 'icon_size'],
    [iconPng(16), 400, 'icon_size'],
    [Buffer.concat([iconPng(64), randomBytes(70_000)]), 413, 'icon_too_large'],
  ] as const;
  for (const [png, status, code] of refused) {
    const reply = await upload(png);
    assert.equal(reply.status, status, code);
    assert.equal(errorCode(reply), code);
  }
  // Another account's session cannot set it.
  assert.equal(errorCode(await upload(iconPng(64), bea)), 'lobby_not_found');
  const png = iconPng(64);
  const version = createHash('sha256').update(png).digest('hex').slice(0, 16);
  assert.equal((await upload(png)).status, 200);
  // The Board access page previews it from the console's own origin.
  const access = await f.get(`/console/${LOBBY}/board`, owner);
  assert.match(access.body, new RegExp(`src="/console/${LOBBY}/icon\\.png\\?v=${version}"`));
  assert.match(access.body, /This board’s own icon, 1 KB\./);
  const preview = await f.get(`/console/${LOBBY}/icon.png?v=${version}`, owner);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['content-type'], 'image/png');
  assert.equal(Number(preview.headers['content-length']), png.length);
  assert.equal((await f.get(`/console/${LOBBY}/icon.png`)).status, 303);
  assert.equal((await f.get(`/console/${LOBBY}/icon.png`, bea)).status, 404);
  // The private board shows it to its viewers only.
  assert.equal((await f.onBoard('/icon.png')).status, 404);
  assert.doesNotMatch((await f.onBoard('/handoff?token=x')).body, /href="\/icon\.png/);
  const viewer = await f.openBoard(owner);
  const page = await f.onBoard('/', { headers: { cookie: viewer } });
  assert.match(
    page.body,
    new RegExp(`<link rel="icon" href="/icon\\.png\\?v=${version}" type="image/png">`),
  );
  assert.match(
    page.body,
    new RegExp(`<link rel="apple-touch-icon" href="/icon\\.png\\?v=${version}">`),
  );
  assert.doesNotMatch(page.body, /favicon\.svg/);
  const icon = await f.onBoard(`/icon.png?v=${version}`, { headers: { cookie: viewer } });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/png');
  assert.equal(icon.headers['cache-control'], 'private, max-age=31536000, immutable');
  const unversioned = await f.onBoard('/icon.png', { headers: { cookie: viewer } });
  assert.equal(unversioned.headers['cache-control'], 'private, no-cache');
  // Public, anyone gets it, and caches may keep it.
  assert.equal(
    (await f.post(`/console/api/l/${LOBBY}/board/visibility`, { visibility: 'public' }, owner))
      .status,
    200,
  );
  assert.equal(
    (await f.onBoard(`/icon.png?v=${version}`)).headers['cache-control'],
    'public, max-age=31536000, immutable',
  );
  // Back to PocoLobby's icon; the activity records both.
  assert.equal((await f.post(`/console/api/l/${LOBBY}/board/icon/remove`, {}, owner)).status, 200);
  assert.equal((await f.onBoard('/icon.png')).status, 404);
  assert.match((await f.onBoard('/')).body, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(
    (await f.get(`/console/${LOBBY}/board`, owner)).body,
    /PocoLobby’s icon, until you upload your own\./,
  );
  const activity = (await f.get(`/console/${LOBBY}/activity`, owner)).body;
  assert.match(activity, /gave the board PocoLobby’s icon again[\s\S]*gave the board its own icon/);
});

test('the operator sets a board’s icon too, and a deleted lobby’s icon goes with it', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.createLobby('tokentek');
  });
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-icon-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'owner.json');
  await writeFile(config, JSON.stringify({ url: f.server.url, token: f.admin }));
  await chmod(config, 0o600);
  const file = join(directory, 'icon.png');
  const png = iconPng(256);
  await writeFile(file, png);
  const out: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0;
    await runCli([...args, '--config', config], {
      stdout: (line) => out.push(line),
      stderr: () => {},
    });
    return JSON.parse(out.join('\n')) as { icon: { sha256: string; bytes: number } | null };
  };
  const set = await cli('board', 'icon', 'set', 'tokentek', file);
  assert.deepEqual(set.icon, {
    sha256: createHash('sha256').update(png).digest('hex'),
    bytes: png.length,
  });
  assert.equal((await f.onBoard('/icon.png', {}, 'tokentek')).status, 404, 'private, no session');
  assert.deepEqual(await cli('board', 'icon', 'remove', 'tokentek'), { icon: null });
  await cli('board', 'icon', 'set', 'tokentek', file);
  const store = new LobbyStore(join(directory, 'copy.db'));
  t.after(() => store.close());
  store.createLobby('gone');
  store.setBoardIcon('owner', 'gone', png);
  assert.equal(store.boardIcon('gone')?.png.length, png.length);
  store.deleteLobby('owner', 'gone', 'gone');
  assert.equal(store.boardIcon('gone'), null);
});

test('a lobby’s console pages sit right under /console', async (t) => {
  const f = await browserFixture(t);
  const session = await f.signIn(OWNER_EMAIL);
  const home = await f.get('/console', session);
  assert.match(home.body, new RegExp(`href="/console/${LOBBY}">Open</a>`));
  const page = await f.get(`/console/${LOBBY}/rooms`, session);
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`<a href="/console/${LOBBY}/board">`));
  // No other address leads to a lobby's pages.
  assert.equal((await f.get(`/console/l/${LOBBY}`, session)).status, 404);
  // The console's own words cannot name a lobby.
  for (const name of ['open', 'sign-in', 'api', 'console'])
    assert.equal(NewLobbyId.safeParse(name).success, false, name);
  assert.equal((await f.get('/console/open', session)).status, 404);
});

test('a lobby has a display name for the board and the console; its name stays the address', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.grantLobby('bea@example.com', store.createLobby('tokentek').lobby_id);
  });
  const owner = await f.signIn(OWNER_EMAIL);
  const bea = await f.signIn('bea@example.com');
  const name = (display_name?: string, cookie = owner) =>
    f.post(
      `/console/api/l/${LOBBY}/display-name`,
      display_name === undefined ? {} : { display_name },
      cookie,
    );
  assert.equal(errorCode(await name('x'.repeat(41))), 'invalid_request');
  assert.equal(errorCode(await name('Markdown\u0007Point')), 'invalid_request');
  assert.equal(errorCode(await name('Mine', bea)), 'lobby_not_found');
  assert.equal((await name('  My Team ')).status, 200);
  const settings = await f.get(`/console/${LOBBY}/settings`, owner);
  assert.match(settings.body, /<title>Lobby settings for My Team<\/title>/);
  assert.match(settings.body, /<span class="lobby">My Team<\/span>/);
  assert.match(
    settings.body,
    /name="display_name" maxlength="40" autocomplete="off" value="My Team"/,
  );
  assert.match(
    (await f.get('/console', owner)).body,
    /<h2>My Team<\/h2>[\s\S]*my-team\.board\.test/,
  );
  // The board shows it to those who may open it; the sign-in page for others shows only the address's name.
  assert.doesNotMatch((await f.onBoard('/handoff?token=x')).body, /My Team/);
  const viewer = await f.openBoard(owner);
  const page = await f.onBoard('/', { headers: { cookie: viewer } });
  assert.match(page.body, /<title>My Team on PocoLobby<\/title>/);
  assert.match(page.body, /<h1>My Team <small>pocolobby<\/small><\/h1>/);
  const fragment = await f.onBoard('/board.json', { headers: { cookie: viewer } });
  assert.match((JSON.parse(fragment.body) as { html: string }).html, /<h1>My Team /);
  // Empty shows the name again; the activity records both.
  assert.equal((await name()).status, 200);
  assert.match((await f.onBoard('/', { headers: { cookie: viewer } })).body, /<h1>my-team </);
  assert.match(
    (await f.get(`/console/${LOBBY}/activity`, owner)).body,
    /went back to showing the lobby’s name[\s\S]*named the lobby “My Team”/,
  );
});

test('the operator sets a display name too, and a deleted lobby’s goes with it', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.createLobby('tokentek');
  });
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-display-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'owner.json');
  await writeFile(config, JSON.stringify({ url: f.server.url, token: f.admin }));
  await chmod(config, 0o600);
  const out: string[] = [];
  const cli = async (...args: string[]) => {
    out.length = 0;
    await runCli([...args, '--config', config], {
      stdout: (line) => out.push(line),
      stderr: () => {},
    });
    return JSON.parse(out.join('\n')) as Record<string, unknown>;
  };
  assert.deepEqual(await cli('lobby', 'display-name', 'tokentek', 'Token Tek'), {
    lobby_id: 'tokentek',
    display_name: 'Token Tek',
  });
  const listed = (await cli('lobbies')).lobbies as {
    lobby_id: string;
    display_name: string | null;
  }[];
  assert.deepEqual(
    listed.map((lobby) => [lobby.lobby_id, lobby.display_name]),
    [
      [LOBBY, null],
      ['tokentek', 'Token Tek'],
    ],
  );
  assert.deepEqual(await cli('lobby', 'display-name', 'tokentek'), {
    lobby_id: 'tokentek',
    display_name: null,
  });
  const store = new LobbyStore(join(directory, 'copy.db'));
  t.after(() => store.close());
  store.createLobby('gone');
  store.setDisplayName('owner', 'gone', 'Gone Soon');
  assert.equal(store.displayName('gone'), 'Gone Soon');
  store.deleteLobby('owner', 'gone', 'gone');
  assert.equal(store.displayName('gone'), null);
});
