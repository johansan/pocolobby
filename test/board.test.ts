import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type Anthropic from '@anthropic-ai/sdk';
import { WebSocket } from 'ws';
import {
  BoardService,
  stateChip,
  STALL_MS,
  USAGE_SHOWN_MS,
  modelLabel,
  type BoardSettings,
} from '../src/board.js';
import { SummarySchema, type NotesSource } from '../src/board-model.js';
import { escape, renderBoardBody } from '../src/board-page.js';
import {
  OUTPUT_SCHEMA,
  requestHash,
  summaryCost,
  summaryRequest,
  SYSTEM_PROMPT,
  type SummaryClient,
} from '../src/board-summary.js';
import { runCli } from '../src/cli.js';
import { hostKind } from '../src/server.js';
import { LobbyStore } from '../src/store.js';
import { LobbyError, type SendInput } from '../src/protocol.js';
import { browserFixture, call, DOMAIN, LOBBY, OWNER_EMAIL } from './browser-fixture.js';

// ---------------------------------------------------------------------------------------------
// A fake GitHub: refs move between commits, each commit has its own tree, blobs by SHA.

interface FakeCommit {
  /** Path to file content; directories are implied by the paths. */
  files: Record<string, string>;
}
const blobSha = (content: string) => createHash('sha1').update(content).digest('hex');
const commitSha = (label: string) => createHash('sha1').update(`commit ${label}`).digest('hex');

async function fakeGitHub(t: TestContext) {
  const commits = new Map<string, FakeCommit>();
  const refs = new Map<string, string>();
  const requests: { path: string; ifNoneMatch?: string }[] = [];
  const failures = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://github.invalid');
    requests.push({
      path: `${url.pathname}${url.search}`,
      ...(request.headers['if-none-match']
        ? { ifNoneMatch: String(request.headers['if-none-match']) }
        : {}),
    });
    assert.equal(request.headers.authorization, 'Bearer github-test-value');
    for (const [prefix, status] of failures)
      if (url.pathname.startsWith(prefix)) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Server Error' }));
        return;
      }
    const ref = /^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(url.pathname);
    if (ref) {
      const sha = refs.get(`${ref[1]}@${decodeURIComponent(ref[2]!)}`);
      if (!sha) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'No commit found for SHA' }));
        return;
      }
      const etag = `"${sha}"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      assert.equal(request.headers.accept, 'application/vnd.github.sha');
      response.writeHead(200, { etag, 'content-type': 'text/plain' });
      response.end(sha);
      return;
    }
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
    if (contents) {
      const path = decodeURIComponent(contents[1]!);
      const commit = commits.get(url.searchParams.get('ref') ?? '');
      const entry = (file: string) => ({
        type: 'file',
        path: file,
        name: file.split('/').pop(),
        sha: blobSha(commit!.files[file]!),
        size: Buffer.byteLength(commit!.files[file]!),
      });
      if (commit && path in commit.files) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(entry(path)));
        return;
      }
      const inside = commit
        ? Object.keys(commit.files).filter((file) => file.startsWith(`${path}/`))
        : [];
      if (!inside.length) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const direct = inside.filter((file) => !file.slice(path.length + 1).includes('/'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([
          ...direct.map(entry),
          { type: 'dir', path: `${path}/archive`, name: 'archive', sha: 'x', size: 0 },
        ]),
      );
      return;
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]{40})$/.exec(url.pathname);
    if (blob) {
      for (const commit of commits.values())
        for (const content of Object.values(commit.files))
          if (blobSha(content) === blob[1]) {
            assert.equal(request.headers.accept, 'application/vnd.github.raw');
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(content);
            return;
          }
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    failures,
    /** Point a ref at a new commit with these files. */
    push(repo: string, ref: string, label: string, files: Record<string, string>) {
      const sha = commitSha(`${repo}:${label}`);
      commits.set(sha, { files });
      refs.set(`${repo}@${ref}`, sha);
      return sha;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A fake summarizer client.

const usage = {
  input_tokens: 18_000,
  output_tokens: 1_500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1_100,
  cache_creation: null,
  server_tool_use: null,
  service_tier: 'standard',
  inference_geo: null,
  output_tokens_details: null,
};
function answer(
  text: string,
  stop: Anthropic.Message['stop_reason'] = 'end_turn',
): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text, citations: null },
    ],
    stop_reason: stop,
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Message;
}
const goodSummary = (overrides: Partial<Record<string, unknown>> = {}) => ({
  agents: [
    { agent_id: 'leia', now: "Gonk's Present fixes", next: ['A', 'B', 'C'] },
    { agent_id: 'padme', now: 'Swap the site film', next: [] },
    { agent_id: 'mouse', now: 'Escape fix', next: null },
  ],
  ...overrides,
});
function fakeClient(answers: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: SummaryClient = {
    async create(request) {
      calls.push(request);
      const next = answers.shift() ?? answer(JSON.stringify(goodSummary()));
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------------------------
// Stores and servers.

function memoryStore(t: TestContext, now: () => number) {
  const store = new LobbyStore(':memory:', { now, infoDelayMs: 0 });
  store.createLobby('my-team');
  t.after(() => store.close());
  return store;
}
function populate(store: LobbyStore) {
  for (const id of ['leia', 'mouse', 'padme'])
    store.provision({ agent_id: id, role: '', can_broadcast: false, allowed_recipients: null });
  store.provision({
    agent_id: 'vader',
    role: '',
    can_broadcast: false,
    allowed_recipients: null,
    manage_rooms: true,
  });
  store.createRoom('owner', 'app', LOBBY);
  store.createRoom('owner', 'social', LOBBY);
}
const activate = (store: LobbyStore, id: string) => {
  const binding = store.claimRuntime(id, randomUUID());
  store.ready(id, binding, {
    context_revision: store.context(id).checkpoint.revision,
    probe_nonce: binding.probe_nonce,
  });
  return binding;
};
const send = (store: LobbyStore, from: string, to: string, extra: Partial<SendInput> = {}) =>
  store.send(from, {
    client_request_id: randomUUID(),
    to,
    content: 'Filmed the 3D deck',
    ...extra,
  } as SendInput);

function service(
  t: TestContext,
  store: LobbyStore,
  now: () => number,
  settings: Partial<BoardSettings>,
) {
  const board = new BoardService(store, { domain: DOMAIN, ...settings }, () => true, now);
  t.after(() => board.close());
  return board;
}

// ---------------------------------------------------------------------------------------------
// Hosts and isolation.

test('host routing: board labels, reserved labels, www and the apex', () => {
  assert.deepEqual(hostKind('my-team.pocolobby.com', 'pocolobby.com'), {
    kind: 'board',
    label: 'my-team',
  });
  assert.deepEqual(hostKind('My-Team.PocoLobby.com:443', 'pocolobby.com'), {
    kind: 'board',
    label: 'my-team',
  });
  // A lobby that does not exist is still a board host: its login page looks the same.
  assert.deepEqual(hostKind('nosuch.pocolobby.com.', 'pocolobby.com'), {
    kind: 'board',
    label: 'nosuch',
  });
  assert.deepEqual(hostKind('www.pocolobby.com', 'pocolobby.com'), { kind: 'www' });
  for (const host of [
    'pocolobby.com',
    'knock.pocolobby.com',
    'lobby.pocolobby.com',
    'api.pocolobby.com',
    'pocolobby.fly.dev',
    'my-team.pocolobby.com.evil.test',
    '127.0.0.1:8787',
    '[::1]:8787',
    undefined,
  ])
    assert.deepEqual(hostKind(host, 'pocolobby.com'), { kind: 'api' }, String(host));
  assert.deepEqual(hostKind('my-team.pocolobby.com', ''), { kind: 'api' });
});

test('reserved labels cannot become lobbies through the store, the admin API or the CLI', async (t) => {
  const store = memoryStore(t, Date.now);
  assert.throws(() => store.createLobby('lobby'));
  assert.throws(() => store.createLobby('www'));
  assert.deepEqual(store.createLobby('other-team'), { lobby_id: 'other-team' });
  // New lobby names are DNS labels too (0.5.0): no underscore, no trailing hyphen.
  assert.throws(() => store.createLobby('my_team'));
  assert.throws(() => store.createLobby('team-'));
  assert.throws(() => store.createLobby('console'));
  const f = await browserFixture(t);
  const { server } = f;
  const owner = f.admin;
  const created = await f.admin_('POST', '/v1/admin/lobbies', { lobby_id: 'status' });
  assert.equal(created.status, 400);
  assert.match(created.body, /reserved/);
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-board-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'owner.json');
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(config, JSON.stringify({ url: server.url, token: owner }));
  await chmod(config, 0o600);
  await assert.rejects(
    runCli(['lobby', 'create', 'admin', '--config', config], { stdout: () => {} }),
    /reserved/,
  );
});

test('a board host serves only board routes, and the API host never serves the board', async (t) => {
  const f = await browserFixture(t);
  const { server } = f;
  const owner = f.admin;
  const host = `${LOBBY}.${DOMAIN}`;
  const bearer = { authorization: `Bearer ${owner}` };
  // The agents' pictures load on both hosts, with no credential; other names are not files.
  for (const target of [host, DOMAIN]) {
    const picture = await call(server.url, target, '/agents/poco-bell.webp');
    assert.deepEqual(
      [picture.status, picture.headers['content-type'], picture.headers['cache-control']],
      [200, 'image/webp', 'public, max-age=86400'],
    );
  }
  assert.equal((await call(server.url, host, '/agents/nope.webp')).status, 404);
  // Every API route is 404 on a board host, with the owner credential too.
  for (const path of [
    '/v1/agents',
    '/v1/admin/agents',
    '/v1/tools',
    '/v1/messages',
    '/v1/admin/board',
  ])
    assert.equal((await call(server.url, host, path, { headers: bearer })).status, 404, path);
  assert.equal((await call(server.url, host, '/healthz')).status, 200);
  // The API host has no board routes: it answers them as API errors.
  for (const path of ['/handoff', '/board.json', '/logout']) {
    const reply = await call(server.url, '127.0.0.1', path, { headers: bearer });
    assert.ok(reply.status >= 400, path);
    assert.match(String(reply.headers['content-type']), /^application\/json/, path);
  }
  // No event stream on a board host.
  const upgrade = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/v1/events`, {
      headers: { host, ...bearer },
    });
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.on('error', () => resolve(-1));
  });
  assert.equal(upgrade, 404);
  // www redirects to the apex, keeping path and query.
  const www = await call(server.url, `www.${DOMAIN}`, '/some/page?x=1');
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, `https://${DOMAIN}/some/page?x=1`);
  // The apex and lobby.<domain> are the API, with the landing page at /.
  for (const apiHost of [DOMAIN, `lobby.${DOMAIN}`, '127.0.0.1']) {
    const landing = await call(server.url, apiHost, '/');
    assert.equal(landing.status, 200, apiHost);
    assert.match(String(landing.headers['content-type']), /^text\/html; charset=utf-8/);
    assert.match(landing.body, /A little place for agents to meet/);
    assert.equal(
      landing.body,
      await readFile(new URL('../site/index.html', import.meta.url), 'utf8'),
    );
    assert.match(
      String(landing.headers['content-security-policy']),
      /font-src https:\/\/fonts\.gstatic\.com/,
    );
    assert.match(
      String(landing.headers['content-security-policy']),
      /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/,
    );
    assert.equal(landing.headers['x-content-type-options'], 'nosniff');
    assert.equal(landing.headers['cache-control'], 'public, max-age=300');
    const agents = await call(server.url, apiHost, '/v1/admin/agents', { headers: bearer });
    assert.equal(agents.status, 200, apiHost);
  }
});

test('a private board opens through the console hand-off, and its cookie opens nothing else', async (t) => {
  const f = await browserFixture(t);
  const host = `${LOBBY}.${DOMAIN}`;
  // Without a session the board sends the browser to the console's sign-in for it.
  const first = await f.onBoard('/');
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, `http://${DOMAIN}/console/open/${LOBBY}`);
  assert.equal((await f.onBoard('/board.json')).status, 401);
  const signIn = await f.get(`/console/open/${LOBBY}`);
  assert.equal(signIn.status, 200);
  assert.match(signIn.body, /Sign in to open the my-team board/);
  assert.match(signIn.body, /name="board" value="my-team"/);
  const consoleCookie = await f.signIn(OWNER_EMAIL);
  const open = await f.get(`/console/open/${LOBBY}`, consoleCookie);
  assert.equal(open.status, 303);
  const handoff = new URL(String(open.headers.location));
  assert.equal(handoff.host, host);
  assert.equal(handoff.pathname, '/handoff');
  const redeemed = await f.onBoard(`/handoff${handoff.search}`);
  assert.equal(redeemed.status, 303);
  assert.equal(redeemed.headers.location, '/');
  assert.equal(redeemed.headers['referrer-policy'], 'same-origin');
  assert.equal(redeemed.headers['cache-control'], 'no-store');
  const cookie = String(redeemed.headers['set-cookie']?.[0]);
  assert.match(
    cookie,
    /^__Host-pocolobby_board=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
  );
  assert.doesNotMatch(cookie, /Domain=/);
  const session = cookie.split(';')[0]!;
  // The same hand-off works once.
  const again = await f.onBoard(`/handoff${handoff.search}`);
  assert.equal(again.status, 400);
  assert.equal(again.headers['set-cookie'], undefined);
  assert.match(again.body, /expired or was already used/);
  const board = await f.onBoard('/', { headers: { cookie: session } });
  assert.equal(board.status, 200);
  assert.match(board.body, /<h2 class="section-title">Agents<\/h2>/);
  assert.match(board.body, /Signed in as owner@example\.com/);
  assert.equal(board.headers['cache-control'], 'no-store');
  assert.equal(board.headers['x-content-type-options'], 'nosniff');
  // Not no-referrer: under it browsers send "Origin: null" with the sign-out form.
  assert.equal(board.headers['referrer-policy'], 'same-origin');
  assert.doesNotMatch(board.body, /no-referrer/);
  const csp = String(board.headers['content-security-policy']);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /style-src 'nonce-[^']+' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  // Every script and style carries this response's nonce; nothing inline without it.
  for (const tag of board.body.match(/<(script|style)\b[^>]*>/g) ?? [])
    assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.doesNotMatch(board.body, /\sstyle="/);
  assert.doesNotMatch(board.body, /\son[a-z]+="/);
  const json = await f.onBoard('/board.json', { headers: { cookie: session } });
  assert.equal(json.status, 200);
  assert.match((JSON.parse(json.body) as { html: string }).html, /Waiting for you/);
  // The board cookie authenticates nothing on the API or the console, on any host.
  for (const apiHost of ['127.0.0.1', DOMAIN])
    for (const path of ['/v1/agents', '/v1/admin/agents', '/v1/admin/board?lobby=my-team']) {
      const reply = await call(f.server.url, apiHost, path, { headers: { cookie: session } });
      assert.equal(reply.status, 401, `${apiHost}${path}`);
    }
  assert.equal((await f.get('/console', session)).body.includes('Your lobbies'), false);
  // A cookie for one board opens no other board.
  const other = await f.onBoard('/', { headers: { cookie: session } }, 'otherlobby');
  assert.equal(other.status, 303);
  // Sign-out needs the board's own origin, and ends the session.
  const foreign = await f.onBoard('/logout', {
    method: 'POST',
    headers: { cookie: session, origin: 'http://evil.test' },
  });
  assert.equal(foreign.status, 403);
  const out = await f.onBoard('/logout', {
    method: 'POST',
    headers: { cookie: session, origin: `http://${host}` },
  });
  assert.equal(out.status, 200);
  assert.match(String(out.headers['set-cookie']?.[0]), /Max-Age=0/);
  assert.match(out.body, /signed out of this board/);
  assert.equal((await f.onBoard('/', { headers: { cookie: session } })).status, 303);
});

test('labels reveal nothing: a private board, a lobby never made and an odd label all go to sign-in', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.createLobby('quiet');
  });
  for (const label of ['quiet', 'nosuch', LOBBY]) {
    const reply = await f.onBoard('/', {}, label);
    assert.equal(reply.status, 303, label);
    assert.equal(reply.headers.location, `http://${DOMAIN}/console/open/${label}`);
  }
  // A signed-in account that may not view a board gets the same answer for every label.
  const consoleCookie = await f.signIn(OWNER_EMAIL);
  const pages = await Promise.all(
    ['quiet', 'nosuch'].map((label) => f.get(`/console/open/${label}`, consoleCookie)),
  );
  for (const page of pages) assert.equal(page.status, 404);
  const shape = (body: string, label: string) =>
    body.replaceAll(label, 'LABEL').replace(/nonce="[^"]+"/g, 'nonce=""');
  assert.equal(shape(pages[0]!.body, 'quiet'), shape(pages[1]!.body, 'nosuch'));
  // A hand-off cannot be redeemed on another board's host, nor invented.
  const open = await f.get(`/console/open/${LOBBY}`, consoleCookie);
  const search = new URL(String(open.headers.location)).search;
  assert.equal((await f.onBoard(`/handoff${search}`, {}, 'quiet')).status, 400);
  assert.equal((await f.onBoard(`/handoff?token=${'a'.repeat(43)}`)).status, 400);
  // It was not consumed by the wrong host: its own host still redeems it.
  assert.equal((await f.onBoard(`/handoff${search}`)).status, 303);
});

test('a public board opens without signing in, and private again closes it', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.setBoardVisibility('owner', LOBBY, 'public');
  });
  const open = await f.onBoard('/');
  assert.equal(open.status, 200);
  assert.match(open.body, /Waiting for you/);
  assert.doesNotMatch(open.body, /Sign out/);
  assert.equal((await f.onBoard('/board.json')).status, 200);
  // The console's open link goes straight to a public board.
  const consoleCookie = await f.signIn(OWNER_EMAIL);
  const link = await f.get(`/console/open/${LOBBY}`, consoleCookie);
  assert.equal(link.headers.location, `http://${LOBBY}.${DOMAIN}/`);
  const made = await f.post(
    `/console/api/l/${LOBBY}/board/visibility`,
    { visibility: 'private' },
    consoleCookie,
  );
  assert.equal(made.status, 200, made.body);
  assert.equal((await f.onBoard('/')).status, 303);
  assert.equal((await f.onBoard('/board.json')).status, 401);
});

test('board sessions last 30 days from their last use; removing a viewer or revoking an account closes the board at once', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.addBoardViewer('owner', LOBBY, 'viewer@example.com');
  });
  const viewerConsole = await f.signIn('Viewer@Example.com');
  const viewer = await f.openBoard(viewerConsole);
  const ownerConsole = await f.signIn(OWNER_EMAIL);
  const owner = await f.openBoard(ownerConsole);
  const status = (cookie: string) =>
    f.onBoard('/', { headers: { cookie } }).then((reply) => reply.status);
  assert.equal(await status(viewer), 200);
  f.clock.now += 29 * 86_400_000;
  assert.equal(await status(viewer), 200);
  // The viewer's use extended its session; the owner's, unused for 31 days, ended.
  f.clock.now += 2 * 86_400_000;
  assert.equal(await status(viewer), 200);
  assert.equal(await status(owner), 303);
  f.clock.now += 31 * 86_400_000;
  assert.equal(await status(viewer), 303);
  // A fresh hand-off; then the owner removes the viewer and the next request is refused.
  const ownerAgain = await f.signIn(OWNER_EMAIL);
  const viewerAgain = await f.openBoard(await f.signIn('viewer@example.com'));
  assert.equal(await status(viewerAgain), 200);
  const removed = await f.post(
    `/console/api/l/${LOBBY}/board/viewers/remove`,
    { email: 'viewer@example.com' },
    ownerAgain,
  );
  assert.equal(removed.status, 200, removed.body);
  assert.equal(await status(viewerAgain), 303);
  assert.equal((await f.onBoard('/board.json', { headers: { cookie: viewerAgain } })).status, 401);
  // Revoking the owner's account ends its console and board sessions everywhere.
  const ownerBoard = await f.openBoard(ownerAgain);
  assert.equal(await status(ownerBoard), 200);
  const revoked = await f.admin_('POST', '/v1/admin/console/accounts', {
    email: OWNER_EMAIL,
    enabled: false,
  });
  assert.equal(revoked.status, 200, revoked.body);
  assert.equal(await status(ownerBoard), 303);
  assert.equal((await f.get('/console', ownerAgain)).body.includes('Your lobbies'), false);
  // Enabling it again revives none of the old sessions.
  await f.admin_('POST', '/v1/admin/console/accounts', { email: OWNER_EMAIL, enabled: true });
  assert.equal(await status(ownerBoard), 303);
  assert.equal((await f.get('/console', ownerAgain)).body.includes('Your lobbies'), false);
});

test('a hand-off expires after a minute, and checks access again when it is redeemed', async (t) => {
  const f = await browserFixture(t, (store) => {
    store.addBoardViewer('owner', LOBBY, 'viewer@example.com');
  });
  const viewer = await f.signIn('viewer@example.com');
  const mint = async () => {
    const open = await f.get(`/console/open/${LOBBY}`, viewer);
    assert.equal(open.status, 303);
    return new URL(String(open.headers.location)).search;
  };
  const late = await mint();
  f.clock.now += 61_000;
  assert.equal((await f.onBoard(`/handoff${late}`)).status, 400);
  const revoked = await mint();
  const owner = await f.signIn(OWNER_EMAIL);
  await f.post(
    `/console/api/l/${LOBBY}/board/viewers/remove`,
    { email: 'viewer@example.com' },
    owner,
  );
  assert.equal((await f.onBoard(`/handoff${revoked}`)).status, 400);
  // Once removed, the console no longer mints one at all.
  assert.equal((await f.get(`/console/open/${LOBBY}`, viewer)).status, 404);
});

// ---------------------------------------------------------------------------------------------
// GitHub sources.// ---------------------------------------------------------------------------------------------
// GitHub sources.

const source = (room: string, repo: string, notes: string[]): NotesSource => ({
  room_id: room,
  repo,
  ref: 'main',
  notes,
});

test('notes are read at one commit per source, with conditional requests and blob reuse', async (t) => {
  const github = await fakeGitHub(t);
  let now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const first = github.push('johansan/my-team', 'main', 'one', {
    'notes/3d.md': '# 3D\n## Now\n- Leia: Now X. Then Y.',
    'notes/format.md': '# Format',
    'notes/archive/old.md': 'nested, not read',
    'README.md': 'not a note',
  });
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes/'] }, 'owner');
  const board = service(t, store, () => now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    notesIntervalMs: 60_000,
  });
  await board.tick();
  const snapshot = store.boardNotes(LOBBY).get('app')!;
  assert.equal(snapshot.commit_sha, first);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['notes/3d.md', 'notes/format.md'],
  );
  // Everything after the ref lookup asked for that one commit.
  for (const request of github.requests.filter((item) => item.path.includes('/contents/')))
    assert.match(request.path, new RegExp(`ref=${first}$`));
  // Within the interval nothing is asked.
  github.requests.length = 0;
  await board.tick();
  assert.equal(github.requests.length, 0);
  // After it, an unchanged ref costs one conditional request answered 304.
  now += 60_000;
  await board.tick();
  assert.deepEqual(github.requests, [
    { path: '/repos/johansan/my-team/commits/main', ifNoneMatch: `"${first}"` },
  ]);
  // A new commit that changes one note downloads only that blob.
  github.requests.length = 0;
  const second = github.push('johansan/my-team', 'main', 'two', {
    'notes/3d.md': '# 3D\n## Now\n- Leia: Now Z.',
    'notes/format.md': '# Format',
  });
  now += 60_000;
  await board.tick();
  assert.equal(store.boardNotes(LOBBY).get('app')!.commit_sha, second);
  assert.deepEqual(
    github.requests.filter((item) => item.path.includes('/git/blobs/')).map((item) => item.path),
    [`/repos/johansan/my-team/git/blobs/${blobSha('# 3D\n## Now\n- Leia: Now Z.')}`],
  );
});

test('a failed fetch keeps the last snapshot, and the next poll fetches again instead of 304', async (t) => {
  const github = await fakeGitHub(t);
  let now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const first = github.push('johansan/my-team', 'main', 'one', { 'notes/a.md': 'first' });
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes'] }, 'owner');
  store.setBoardSource(
    LOBBY,
    'social',
    {
      repo: 'johansan/my-team-social',
      notes: ['PLAN.md'],
    },
    'owner',
  );
  github.push('johansan/my-team-social', 'main', 'plan', { 'PLAN.md': '# Plan' });
  const board = service(t, store, () => now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
  });
  await board.tick();
  github.push('johansan/my-team', 'main', 'two', { 'notes/a.md': 'second' });
  github.failures.set('/repos/johansan/my-team/git/blobs/', 500);
  now += 60_000;
  await board.tick();
  assert.equal(store.boardNotes(LOBBY).get('app')!.commit_sha, first);
  let view = board.view(LOBBY);
  const app = view.sources.find((row) => row.room_id === 'app')!;
  assert.match(app.error!, /GitHub answered 500 for notes\/a\.md: Server Error/);
  // The other source renders without an error.
  assert.equal(view.sources.find((row) => row.room_id === 'social')!.error, null);
  assert.match(view.problems.join(' '), /Notes for app .*Showing them as of/);
  github.failures.clear();
  now += 60_000;
  await board.tick();
  assert.equal(store.boardNotes(LOBBY).get('app')!.files[0]!.content, 'second');
  view = board.view(LOBBY);
  assert.equal(view.sources.find((row) => row.room_id === 'app')!.error, null);
});

test('files and directories, missing paths, cut files and a source that cannot be read', async (t) => {
  const github = await fakeGitHub(t);
  const now = Date.parse('2026-10-16T07:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  store.createRoom('owner', 'web', LOBBY);
  github.push('johansan/my-team-social', 'main', 'plan', {
    'PLAN.md': `# Plan\n${'é'.repeat(70_000)}`,
    'notes/x.md': 'x',
  });
  github.push('johansan/my-team-web', 'main', 'empty', { 'site/index.html': '<p>' });
  store.setBoardSource(
    LOBBY,
    'social',
    {
      repo: 'johansan/my-team-social',
      notes: ['PLAN.md', 'notes/', 'missing/'],
    },
    'owner',
  );
  store.setBoardSource(LOBBY, 'web', { repo: 'johansan/my-team-web', notes: ['notes/'] }, 'owner');
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/gone', notes: ['notes/'] }, 'owner');
  const board = service(t, store, () => now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
  });
  await board.tick();
  const social = store.boardNotes(LOBBY).get('social')!;
  assert.deepEqual(
    social.files.map((file) => [file.path, file.truncated]),
    [
      ['PLAN.md', true],
      ['notes/x.md', false],
    ],
  );
  const plan = social.files[0]!;
  assert.equal(plan.bytes, Buffer.byteLength(`# Plan\n${'é'.repeat(70_000)}`));
  assert.ok(Buffer.byteLength(plan.content) <= 128 * 1024);
  assert.ok(!plan.content.endsWith('�'));
  const view = board.view(LOBBY);
  const rows = Object.fromEntries(view.sources.map((row) => [row.room_id, row]));
  assert.deepEqual(rows.social!.cut, ['PLAN.md']);
  assert.equal(rows.web!.files, 0);
  assert.equal(rows.web!.error, null);
  assert.match(rows.app!.error!, /GitHub answered 404 for the ref main/);
  const html = renderBoardBody(view);
  assert.match(html, /<b>web<\/b> johansan\/my-team-web: no notes found/);
  assert.match(html, /only the beginning of PLAN\.md/);
  // The summarizer is told which file is cut.
  const request = summaryRequest({
    lobby: LOBBY,
    agents: [],
    notes: [{ room_id: 'social', repo: 'johansan/my-team-social', snapshot: social }],
    messages: [],
  });
  const data = JSON.parse(String(request.messages[0]!.content)) as {
    notes: { room: string; files: { path: string; truncated?: string }[] }[];
  };
  assert.equal(data.notes[0]!.room, 'social');
  assert.match(data.notes[0]!.files[0]!.truncated!, /^first \d+ of \d+ bytes$/);
  assert.equal(data.notes[0]!.files[1]!.truncated, undefined);
});

test('a reconfigured source drops its old snapshot, and an old fetch cannot store into it', (t) => {
  const store = memoryStore(t, Date.now);
  populate(store);
  const app = source('app', 'johansan/my-team', ['notes']);
  store.setBoardSource(LOBBY, 'app', { repo: app.repo, notes: app.notes }, 'owner');
  const snapshot = { commit_sha: 'a'.repeat(40), files: [], fetched_at: new Date().toISOString() };
  assert.equal(store.saveBoardNotes(LOBBY, app, snapshot), true);
  store.setBoardSource(LOBBY, 'app', { repo: app.repo, notes: ['notes', 'PLAN.md'] }, 'owner');
  assert.equal(store.boardNotes(LOBBY).size, 0);
  assert.equal(store.saveBoardNotes(LOBBY, app, snapshot), false);
  assert.throws(
    () => store.setBoardSource(LOBBY, 'nosuch', { repo: app.repo, notes: app.notes }, 'owner'),
    (error: unknown) => error instanceof LobbyError && error.code === 'room_not_found',
  );
  store.removeBoardSource(LOBBY, 'app', 'owner');
  assert.deepEqual(store.boardLobbies(), []);
});

// ---------------------------------------------------------------------------------------------
// The summarizer.

async function summarizedStore(t: TestContext) {
  const github = await fakeGitHub(t);
  const clock = { now: Date.parse('2026-10-16T07:00:00Z') };
  const store = memoryStore(t, () => clock.now);
  populate(store);
  github.push('johansan/my-team', 'main', 'one', { 'notes/3d.md': '# 3D\n- Leia: Now X.' });
  store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes'] }, 'owner');
  return { github, clock, store };
}

test('an agent the owner hides has no row and no summary, but what it waits on still shows', async (t) => {
  // Poco works on PocoLobby itself, outside the lobby's notes, so its row only ever said Away.
  const { github, clock, store } = await summarizedStore(t);
  store.setBoardAgents(LOBBY, { agents: { leia: { emoji: '👑' }, padme: { hidden: true } } });
  const padme = activate(store, 'padme');
  store.setOwnerRequests('padme', padme, { count: 1, text: 'Approve the DNS change' });
  const fake = fakeClient([]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
  });
  await board.tick();
  const sent = JSON.stringify(fake.calls[0]!.messages);
  assert.match(sent, /\\"agent_id\\":\\"leia\\"/);
  assert.doesNotMatch(sent, /\\"agent_id\\":\\"padme\\"/);
  const view = board.view(LOBBY);
  // The coordinator comes first (Johan: "show coordinator on top of agents list").
  assert.deepEqual(
    view.agents.map((agent) => agent.agent_id),
    ['vader', 'leia', 'mouse'],
  );
  assert.deepEqual(
    view.waiting.map((row) => row.agent_id),
    ['padme'],
  );
});

test('a support agent is listed last on the coordinator’s tint and told by what it did today (0.8.6)', async (t) => {
  // Johan: "I think we should show you in the chart as well as Poco", "on the bottom maybe same
  // background color as coordinator", "your description should be same as coordinator, what you
  // did today".
  const { github, clock, store } = await summarizedStore(t);
  store.setBoardAgents(LOBBY, { agents: { leia: { emoji: '🛎️', support: true } } });
  const fake = fakeClient([]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
  });
  await board.tick();
  const input = JSON.parse(String(fake.calls[0]!.messages[0]!.content)) as {
    agents: Record<string, unknown>[];
  };
  assert.deepEqual(
    input.agents.find((agent) => agent.agent_id === 'leia'),
    { agent_id: 'leia', name: 'Leia', coordinator: false, support: true },
  );
  // Others go as before, so a lobby without a support agent keeps the same input.
  assert.equal('support' in input.agents.find((agent) => agent.agent_id === 'mouse')!, false);
  const view = board.view(LOBBY);
  assert.deepEqual(
    view.agents.map((agent) => agent.agent_id),
    ['vader', 'mouse', 'padme', 'leia'],
  );
  const html = renderBoardBody({
    ...view,
    agents: [
      {
        ...view.agents.at(-1)!,
        now: 'Its own task',
        next: { count: 1, items: ['Then more'] },
        today: 'Shipped the Fable usage bars and helped Vader roll out the new version.',
      },
    ],
  });
  assert.match(html, /<div class="agent support">/);
  assert.match(
    html,
    /<div class="now">Shipped the Fable usage bars and helped Vader roll out the new version\.<\/div>/,
  );
  assert.doesNotMatch(html, /Next:|Its own task/);
});

test('messages expiring after a day do not pay for a summary with nothing new', async (t) => {
  // The input is the newest 40 reports whatever their age, so each expiry changed it: on a quiet
  // day with the board open, every 10 minutes paid for the same summary.
  const { github, clock, store } = await summarizedStore(t);
  activate(store, 'leia');
  activate(store, 'vader');
  send(store, 'leia', 'vader', { kind: 'report', content: 'Present fixes landed' });
  const fake = fakeClient([]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  await board.tick();
  clock.now += 2 * 3_600_000;
  send(store, 'vader', 'leia', { kind: 'assignment', content: 'Take the format slices' });
  await board.tick();
  assert.equal(fake.calls.length, 2);
  // A day after the first report, the sweep removes it: nothing new to summarize.
  clock.now += 23 * 3_600_000;
  assert.ok(store.pruneMessages() > 0);
  await board.tick();
  clock.now += 700_000;
  await board.tick();
  assert.equal(fake.calls.length, 2);
  // A new report still counts.
  send(store, 'leia', 'vader', { kind: 'report', content: 'Format slices done' });
  clock.now += 700_000;
  await board.tick();
  assert.equal(fake.calls.length, 3);
});

test('an answered failure is not paid for again when messages only expire', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  activate(store, 'leia');
  activate(store, 'vader');
  send(store, 'leia', 'vader', { kind: 'report', content: 'Present fixes landed' });
  const fake = fakeClient([answer(JSON.stringify(goodSummary())), answer('not the summary')]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  await board.tick();
  clock.now += 2 * 3_600_000;
  send(store, 'vader', 'leia', { kind: 'assignment', content: 'Take the format slices' });
  await board.tick();
  assert.equal(fake.calls.length, 2);
  assert.ok(store.boardLastAttempt(LOBBY)?.error);
  clock.now += 23 * 3_600_000;
  assert.ok(store.pruneMessages() > 0);
  await board.tick();
  clock.now += 700_000;
  await board.tick();
  assert.equal(fake.calls.length, 2);
});

test('the summarizer runs when its sources change, at most once per interval', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  const fake = fakeClient([]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  await board.tick();
  assert.equal(fake.calls.length, 1);
  const first = store.boardSummary(LOBBY)!;
  assert.equal(first.model, 'claude-haiku-5-5');
  assert.deepEqual(first.sources, [
    {
      room_id: 'app',
      repo: 'johansan/my-team',
      commit_sha: store.boardNotes(LOBBY).get('app')!.commit_sha,
    },
  ]);
  assert.equal(first.input_hash, requestHash(fake.calls[0]!));
  assert.ok(first.cost_usd > 0);
  // Nothing changed: no call, even after the interval.
  clock.now += 700_000;
  await board.tick();
  assert.equal(fake.calls.length, 1);
  // A new report within the interval waits for it.
  activate(store, 'leia');
  send(store, 'leia', 'vader', { kind: 'report', content: 'Present fixes' });
  clock.now += 60_000;
  await board.tick();
  assert.equal(fake.calls.length, 2);
  send(store, 'leia', 'vader', { kind: 'report', content: 'Present fixes landed' });
  clock.now += 60_000;
  await board.tick();
  assert.equal(fake.calls.length, 2);
  clock.now += 600_000;
  await board.tick();
  assert.equal(fake.calls.length, 3);
  // A notice is not a source; a report is.
  activate(store, 'vader');
  send(store, 'vader', 'leia', { kind: 'notice' });
  clock.now += 600_000;
  await board.tick();
  assert.equal(fake.calls.length, 3);
  send(store, 'vader', 'leia', { kind: 'assignment', content: 'Take the format slices' });
  // An input just found unchanged is not rebuilt for a notes interval.
  await board.tick();
  assert.equal(fake.calls.length, 3);
  clock.now += 60_000;
  await board.tick();
  assert.equal(fake.calls.length, 4);
  const data = JSON.parse(String(fake.calls[3]!.messages[0]!.content)) as {
    messages: { kind: string; excerpt: string }[];
    agents: { agent_id: string; name: string }[];
  };
  assert.deepEqual(
    data.messages.map((message) => message.kind),
    ['assignment', 'report', 'report'],
  );
  // Each agent goes with its name only; its role text stays out of the request.
  assert.deepEqual(Object.keys(data.agents[0]!).sort(), ['agent_id', 'coordinator', 'name']);
  // A commit that leaves the notes alone does not trigger a summary.
  github.push('johansan/my-team', 'main', 'app-only', {
    'notes/3d.md': '# 3D\n- Leia: Now X.',
  });
  clock.now += 600_000;
  await board.tick();
  assert.equal(fake.calls.length, 4);
});

test('the request: Haiku 5.5, low effort, a JSON schema, a stable prompt, no tools', () => {
  const request = summaryRequest({
    lobby: LOBBY,
    agents: [{ agent_id: 'leia', name: 'Leia', coordinator: false }],
    notes: [
      {
        room_id: 'app',
        repo: 'johansan/my-team',
        snapshot: {
          commit_sha: 'a'.repeat(40),
          fetched_at: '2026-10-16T07:00:00Z',
          files: [{ path: 'notes/3d.md', sha: 'b', bytes: 4, truncated: false, content: '# 3D' }],
        },
      },
    ],
    messages: Array.from({ length: 60 }, (_, index) => ({
      sequence: index,
      from: 'luke',
      to: 'vader',
      room_id: null,
      kind: 'report' as const,
      created_at: '2026-10-16T06:00:00Z',
      content: 'r'.repeat(1000),
    })),
  });
  assert.equal(request.model, 'claude-haiku-5-5');
  assert.deepEqual(request.output_config, {
    effort: 'low',
    format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
  });
  assert.deepEqual(request.system, [{ type: 'text', text: SYSTEM_PROMPT }]);
  assert.equal('tools' in request, false);
  assert.equal('temperature' in request, false);
  // Thinking is off: Haiku 5.5 takes "disabled", Sonnet 5.5 only "between_tools".
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.deepEqual(
    summaryRequest(
      { lobby: LOBBY, agents: [], notes: [], messages: [] },
      { model: 'claude-sonnet-5-5', effort: 'high' },
    ).thinking,
    { type: 'between_tools' },
  );
  assert.doesNotMatch(SYSTEM_PROMPT, /my-team|\d{4}-\d\d-\d\d/);
  const data = JSON.parse(String(request.messages[0]!.content)) as {
    messages: { excerpt: string }[];
  };
  // Messages are bounded in count, excerpt and total. No count of the left-out ones: it changes
  // as old messages leave the window, and would force a new summary when nothing happened.
  assert.ok(data.messages.length <= 40);
  assert.ok(data.messages.every((message) => message.excerpt.length <= 600));
  assert.ok(data.messages.reduce((sum, message) => sum + message.excerpt.length, 0) <= 16_000);
  assert.equal('omitted_messages' in data, false);
  // The schema has no length keywords the API would refuse; every object is closed.
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    for (const key of ['maxLength', 'minLength', 'maxItems', 'minItems', 'maximum', 'minimum'])
      assert.equal(key in node, false, key);
    if ((node as { type?: unknown }).type === 'object') {
      assert.equal((node as { additionalProperties?: unknown }).additionalProperties, false);
      assert.deepEqual(
        [...(node as { required: string[] }).required].sort(),
        Object.keys((node as { properties: object }).properties).sort(),
      );
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(OUTPUT_SCHEMA);
});

test('a board updates only when visited, and summarizes at most once per interval', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  activate(store, 'leia');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls: unknown[] = [];
  const client: SummaryClient = {
    async create(request) {
      calls.push(request);
      await gate;
      return answer(JSON.stringify(goodSummary()));
    },
  };
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: client,
    summaryIntervalMs: 600_000,
  });
  // No timer: an hour with nobody looking costs nothing.
  clock.now += 3_600_000;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 0);
  assert.equal(store.boardSummary(LOBBY), null);

  // A visit starts the update; the page says so while the model writes.
  const visit = board.request(LOBBY);
  assert.equal(board.request(LOBBY), visit, 'a second visit joins the running update');
  for (let i = 0; i < 20 && board.activity(LOBBY) !== 'summarizing'; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(board.view(LOBBY).activity, 'summarizing');
  release();
  await visit;
  assert.equal(board.view(LOBBY).activity, null);
  assert.equal(calls.length, 1);
  assert.ok(store.boardSummary(LOBBY));

  // Within the interval a changed input waits; after it, the next visit summarizes again.
  send(store, 'leia', 'vader', { kind: 'report', content: 'something new' });
  clock.now += 120_000;
  await board.request(LOBBY);
  assert.equal(calls.length, 1);
  clock.now += 600_000;
  await board.request(LOBBY);
  assert.equal(calls.length, 2);
  // Unchanged input never pays again, however long it has been.
  clock.now += 3_600_000;
  await board.request(LOBBY);
  assert.equal(calls.length, 2);
});

test('summaries are validated: bad answers keep the last good one and still count their cost', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  activate(store, 'leia');
  const fake = fakeClient([
    answer(JSON.stringify(goodSummary())),
    answer(JSON.stringify({ agents: [{ agent_id: 'leia' }] })),
    answer('not json'),
    answer(JSON.stringify(goodSummary()), 'refusal'),
    answer(JSON.stringify(goodSummary()), 'max_tokens'),
    Object.assign(new Error('boom'), {}),
  ]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  await board.tick();
  const good = store.boardSummary(LOBBY)!;
  const expected = [
    /did not match its schema at agents\.0\.now/,
    /not valid JSON/,
    /declined/,
    /cut off at the token limit/,
    /The summary request failed/,
  ];
  for (const [index, pattern] of expected.entries()) {
    send(store, 'leia', 'vader', { kind: 'report', content: `round ${index}` });
    clock.now += 600_000;
    await board.tick();
    const last = store.boardLastAttempt(LOBBY)!;
    assert.match(last.error!, pattern);
    assert.equal(last.summary, null);
    assert.equal(store.boardSummary(LOBBY)!.sequence, good.sequence);
  }
  // Answers that arrived were paid for; the thrown request was not.
  const usage24h = store.boardUsage(LOBBY, clock.now - 86_400_000);
  assert.equal(usage24h.runs, 6);
  assert.equal(usage24h.failed, 5);
  assert.ok(
    Math.abs(usage24h.cost_usd - 5 * summaryCost({ ...usage, cache_creation_input_tokens: 0 })) <
      1e-12,
  );
  const view = board.view(LOBBY);
  assert.equal(view.agents.find((agent) => agent.agent_id === 'leia')!.now, "Gonk's Present fixes");
  assert.match(view.problems.join(' '), /The summarizer failed .*Showing the summary from/);
});

test('a summary that cannot be stored still holds the interval and keeps its usage', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  activate(store, 'leia');
  const fake = fakeClient([]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  const save = store.saveBoardSummary.bind(store);
  // A full disk: neither the summary nor a failure row can be written.
  store.saveBoardSummary = () => {
    throw new Error('database or disk is full');
  };
  await board.tick();
  assert.equal(fake.calls.length, 1);
  for (let round = 1; round <= 3; round += 1) {
    send(store, 'leia', 'vader', { kind: 'report', content: `round ${round}` });
    clock.now += 15_000;
    await board.tick();
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(store.boardLastAttempt(LOBBY), null);
  // While its cost cannot be recorded, nothing more is paid for, even after the interval.
  clock.now += 600_000;
  await board.tick();
  assert.equal(fake.calls.length, 1);
  assert.match(board.view(LOBBY).problems.join(' '), /could not be recorded/);

  // Only the large summary row fails: the smaller failure row keeps the paid usage, the earlier
  // attempt's included.
  store.saveBoardSummary = (record) => {
    if (record.summary !== null) throw new Error('database or disk is full');
    return save(record);
  };
  clock.now += 600_000;
  await board.tick();
  assert.equal(fake.calls.length, 2);
  const last = store.boardLastAttempt(LOBBY)!;
  assert.equal(last.error, 'The summary could not be saved');
  assert.equal(last.summary, null);
  assert.ok(last.cost_usd > 0);
  assert.ok(last.usage.input_tokens > 0);
  assert.equal(store.boardUsage(LOBBY, clock.now - 86_400_000).runs, 2);
});

test('clipping, unknown agents, and unknown versus empty queues', () => {
  const parsed = SummarySchema.parse({
    agents: [
      {
        agent_id: 'leia',
        now: 'n'.repeat(300),
        next: Array.from({ length: 9 }, (_, i) => `item ${i}`),
      },
      { agent_id: 'padme', now: 'n'.repeat(150), next: ['x'.repeat(100)] },
      { agent_id: 'mouse', now: 'n', next: null },
    ],
  });
  // Texts over the prompt's lengths show whole (Johan: "do not cut anything on server").
  assert.deepEqual(
    [
      parsed.agents[0]!.now.length,
      parsed.agents[1]!.now.length,
      parsed.agents[1]!.next![0]!.length,
    ],
    [300, 150, 100],
  );
  assert.deepEqual(
    parsed.agents.map((agent) => [agent.next?.length ?? null, agent.next_count]),
    [
      [4, 9],
      [1, 1],
      [null, null],
    ],
  );
  assert.throws(() => SummarySchema.parse({ agents: [{ agent_id: 'x', now: 'n' }] }));
});

test('a coordinator’s row tells what it coordinated, not now and next (0.8.5)', (t) => {
  // Johan: "it does not make sense that coordinator shows No current task in the notes, Next:
  // nothing queued … a description in two lines instead".
  const summary = SummarySchema.parse({
    agents: [
      {
        agent_id: 'vader',
        now: '',
        next: [],
        today: 'Handed Mouse the export crash and had Leia check the fix on Windows.',
      },
      { agent_id: 'leia', now: 'Checks the fix', next: null },
    ],
  });
  assert.deepEqual(
    summary.agents.map((agent) => agent.today),
    ['Handed Mouse the export crash and had Leia check the fix on Windows.', ''],
  );
  assert.equal(
    SummarySchema.parse({ agents: [{ agent_id: 'v', now: '', next: [], today: 't'.repeat(300) }] })
      .agents[0]!.today.length,
    300,
  );
  const now = Date.parse('2026-10-16T12:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => now, {});
  const view = board.view(LOBBY);
  const base = view.agents[0]!;
  const coordinator = {
    ...base,
    coordinator: true,
    chip: 'coord' as const,
    now: null,
    next: { count: 0, items: [] },
  };
  const told = renderBoardBody({
    ...view,
    agents: [
      { ...coordinator, today: 'Handed Mouse the export crash and had Leia check the fix.' },
    ],
  });
  assert.match(
    told,
    /<div class="now">Handed Mouse the export crash and had Leia check the fix\.<\/div>/,
  );
  assert.doesNotMatch(told, /No current task|Next:/);
  // Its row is tinted apart from the others.
  assert.match(told, /<div class="agent coordinator">/);
  assert.match(renderBoardBody({ ...view, agents: [base] }), /<div class="agent coordinator">/);
  assert.match(renderBoardBody({ ...view, agents: [view.agents[1]!] }), /<div class="agent">/);
  // With no description yet, a coordinator shows nothing in their place.
  const quiet = renderBoardBody({ ...view, agents: [{ ...coordinator, today: null }] });
  assert.doesNotMatch(quiet, /No current task|Next:|class="now"/);
});

test('summary cost follows Haiku 5.5 prices, including the long-prompt rate and cache writes', () => {
  const base = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const close = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);
  // Up to 100K prompt tokens: $0.10 in, $0.50 out per million; reads 0.1x, 1-hour writes 2x.
  close(summaryCost({ ...base, input_tokens: 100_000 }), 0.01);
  close(summaryCost({ ...base, input_tokens: 1, output_tokens: 100_000 }), 0.05 + 0.0000001);
  close(summaryCost({ ...base, cache_read_input_tokens: 100_000 }), 0.001);
  close(summaryCost({ ...base, cache_creation_input_tokens: 100_000 }), 0.02);
  close(summaryCost({ ...base, cache_creation_input_tokens: 100_000 }, 100_000), 0.0125);
  // Above 100K prompt tokens: $0.50 in, $2.50 out per million.
  close(summaryCost({ ...base, input_tokens: 200_000, output_tokens: 10_000 }), 0.1 + 0.025);
  // A typical run: about 20K tokens in, 1.5K out, the prompt read from the cache.
  assert.ok(
    summaryCost({
      ...base,
      input_tokens: 18_900,
      cache_read_input_tokens: 1_100,
      output_tokens: 1_500,
    }) < 0.003,
  );
});

// ---------------------------------------------------------------------------------------------
// Chips and rendering.

test('state chips follow their precedence', () => {
  const now = Date.parse('2026-10-16T07:00:00Z');
  const agent = {
    manage_rooms: false,
    unseen_notified_count: 0,
    oldest_unseen_notified_at: null as string | null,
    owner_requests: null as null | { count: number; text: string; set_at: string },
    last_message_at: new Date(now - 29 * 60_000).toISOString() as string | null,
  };
  const quiet = { last_message_at: new Date(now - 30 * 60_000).toISOString() };
  const asks = { count: 1, text: 'Approve the films', set_at: '' };
  const stalled = {
    unseen_notified_count: 2,
    oldest_unseen_notified_at: new Date(now - STALL_MS).toISOString(),
  };
  const recent = {
    unseen_notified_count: 2,
    oldest_unseen_notified_at: new Date(now - STALL_MS + 1000).toISOString(),
  };
  const cases: [Parameters<typeof stateChip>[0], string][] = [
    [{ ...agent, ...stalled, manage_rooms: true, owner_requests: asks }, 'stalled'],
    [{ ...agent, ...recent, ...quiet, owner_requests: asks }, 'wait'],
    [{ ...agent, manage_rooms: true, owner_requests: asks }, 'wait'],
    // Thirty minutes without a message is away, the coordinator included; so is never.
    [{ ...agent, ...quiet, manage_rooms: true }, 'away'],
    [{ ...agent, ...quiet }, 'away'],
    [{ ...agent, last_message_at: null }, 'away'],
    [{ ...agent, manage_rooms: true }, 'coord'],
    [{ ...agent }, 'working'],
  ];
  for (const [facts, expected] of cases)
    assert.equal(stateChip(facts, now), expected, JSON.stringify(facts));
  // With its bridge offline an agent is away, though a direct message just reached its inbox.
  assert.equal(stateChip({ ...agent }, now, false), 'away');
  assert.equal(stateChip({ ...agent, manage_rooms: true }, now, false), 'away');
  assert.equal(stateChip({ ...agent, owner_requests: asks }, now, false), 'wait');
  assert.equal(stateChip({ ...agent, ...stalled }, now, false), 'stalled');
});

test('each agent row shows its plan usage, the account only on a private board', (t) => {
  // Johan: "5h usage % left and weekly usage % left … also the reset time and date", and "show
  // email on private only".
  let now = Date.parse('2026-10-16T18:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => now, {});
  const seconds = (iso: string) => Date.parse(iso) / 1000;
  board.recordUsage('my-team/leia', {
    five_hour: { used_percentage: 38.4, resets_at: seconds('2026-10-16T19:40:00Z') },
    seven_day: { used_percentage: 85, resets_at: seconds('2026-10-21T07:00:00Z') },
    account: 'johan@example.com',
    plan: 'max',
  });
  const row = () => board.view(LOBBY).agents.find((agent) => agent.agent_id === 'leia')!;
  assert.deepEqual(row().usage, {
    account: 'johan@example.com',
    plan: 'max',
    five_hour: { left: 62, resets_at: '2026-10-16T19:40:00.000Z' },
    seven_day: { left: 15, resets_at: '2026-10-21T07:00:00.000Z' },
    model: null,
    context: null,
    effort: null,
    windows: [],
    observed_at: '2026-10-16T18:00:00.000Z',
  });
  assert.equal(board.view(LOBBY).agents.find((agent) => agent.agent_id === 'mouse')!.usage, null);
  const html = renderBoardBody(board.view(LOBBY));
  assert.match(
    html,
    /<span>johan@example\.com \(max\)<\/span><span>5h <b>62% left<\/b> resets <time datetime="2026-10-16T19:40:00.000Z" data-at>Fri 16 Oct, 19:40 UTC<\/time><\/span>/,
  );
  assert.match(
    html,
    /Week <b class="low">15% left<\/b> resets <time datetime="2026-10-21T07:00:00.000Z" data-at>Wed 21 Oct, 07:00 UTC<\/time>/,
  );
  // A public board shows the usage without the address.
  store.setBoardVisibility('owner', LOBBY, 'public');
  assert.equal(row().usage!.account, null);
  assert.doesNotMatch(renderBoardBody(board.view(LOBBY)), /johan@example/);
  // A window past its reset is gone; an old reading says how old it is, and after a day goes.
  now = Date.parse('2026-10-16T20:00:00Z');
  assert.equal(row().usage!.five_hour, null);
  assert.match(renderBoardBody(board.view(LOBBY)), /as of 2 h ago/);
  now = Date.parse('2026-10-16T18:00:00Z') + USAGE_SHOWN_MS;
  assert.equal(row().usage, null);
  // Johan: "it could list Gonk (Opus 5.5 xhigh)", as pills (0.8.5): the model, the context window
  // and the effort in its level's colour, from the agent's own session; a reading with only
  // them still shows.
  board.recordUsage('my-team/leia', { model: 'claude-opus-5-5[1m]', effort: 'xhigh' });
  assert.deepEqual(
    [row().usage!.model, row().usage!.context, row().usage!.effort],
    ['Opus 5.5', '1M', 'xhigh'],
  );
  const pills = renderBoardBody(board.view(LOBBY));
  assert.match(
    pills,
    /<strong>Leia<\/strong><span class="pills"><span class="pill" title="Model">/,
  );
  assert.match(pills, /<b>Opus 5\.5<\/b><\/span><span class="pill" title="Context window">/);
  assert.match(
    pills,
    /<span class="pill effort e-xhigh" title="Reasoning effort">.*?xhigh<\/span>/,
  );
  const usage = board.agentUsage(LOBBY, 'leia')!;
  assert.deepEqual(
    [usage.model, usage.model_name, usage.context_window, usage.effort],
    ['claude-opus-5-5[1m]', 'Opus 5.5', 1_000_000, 'xhigh'],
  );
  // The status line's own context window wins over the model ID; without either there is none.
  board.recordUsage('my-team/leia', {
    model: 'claude-opus-5-5',
    effort: 'medium',
    context: 200_000,
  });
  assert.deepEqual([row().usage!.context, row().usage!.effort], ['200K', 'medium']);
  assert.match(renderBoardBody(board.view(LOBBY)), /class="pill effort e-medium"/);
  board.recordUsage('my-team/leia', { model: 'claude-sonnet-5-5' });
  assert.deepEqual(
    [row().usage!.model, row().usage!.context, row().usage!.effort],
    ['Sonnet 5.5', null, null],
  );
  assert.equal(modelLabel('claude-opus-4-6[1m]'), 'Opus 4.6');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('some-other-model'), 'some-other-model');
});

test('accounts are paced against their weekly line, for the coordinator and the board', (t) => {
  // Johan: Vader keeps the four subscriptions busy around the clock at about 14% of the week a
  // day, reaching 0% left at each reset; an account ahead of that rests a worker.
  const now = Date.parse('2026-10-16T12:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => now, {});
  const resets = (now + 3 * 24 * 60 * 60_000) / 1000;
  const report = (used: number, account: string) => ({
    seven_day: { used_percentage: used, resets_at: resets },
    account,
    plan: 'max',
  });
  board.recordUsage('my-team/leia', report(65, 'one@example.com'));
  board.recordUsage('my-team/mouse', report(65, 'one@example.com'));
  board.recordUsage('my-team/padme', report(50, 'two@example.com'));
  assert.deepEqual(
    board
      .view(LOBBY)
      .accounts.map((account) => [
        account.account,
        account.agents.length,
        account.week_used,
        account.line,
        account.lead,
        account.state,
      ]),
    [
      ['one@example.com', 2, 65, 57, 8, 'ahead'],
      ['two@example.com', 1, 50, 57, -7, 'behind'],
    ],
  );
  // A card per account: its email, its week as a bar against the even-pace mark, its numbers.
  const html = renderBoardBody(board.view(LOBBY));
  assert.match(
    html,
    /<strong title="one@example\.com">one@example\.com<\/strong><svg class="week"[^>]*aria-label="Week 65% used, 8 points ahead">.*?class="ahead" x="57" y="3" width="8"/s,
  );
  assert.match(
    html,
    /aria-label="Week 50% used, 7 points behind">.*?class="behind" x="50" y="3" width="7"/s,
  );
  // Johan: "27% (🎯50%) resets Wed 21 Oct, 10:00", on one line.
  assert.match(
    html,
    /<span class="facts line"><b>65%<\/b> \(<span role="img" aria-label="target" title="Target">🎯<\/span>57%\) resets <time/,
  );
  // list_agents carries the same, for the coordinator's checks.
  assert.deepEqual(board.agentUsage(LOBBY, 'padme')!.seven_day, {
    used_percentage: 50,
    resets_at: new Date(resets * 1000).toISOString(),
    line: 57.1,
    lead: -7.1,
    pace: 'behind',
    observed_at: new Date(now).toISOString(),
    stale: false,
  });
  // A public board does not name the accounts.
  store.setBoardVisibility('owner', LOBBY, 'public');
  assert.deepEqual(
    board.view(LOBBY).accounts.map((account) => account.account),
    ['Account 1', 'Account 2'],
  );
  // Nothing is sent to anyone: the coordinator reads it at its own checks.
  assert.deepEqual(store.messages('vader').items, []);
});

test('a model’s own weekly window, such as Fable’s, is paced apart from the week (0.8.6)', (t) => {
  // Johan: "the usage for fable is a bit different than other models. we can only use 50% of our
  // weekly usage for it."
  let now = Date.parse('2026-10-16T12:00:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => now, {});
  const resets = (now + 3 * 24 * 60 * 60_000) / 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const week = { used_percentage: 40, resets_at: resets };
  const fable = { name: 'Fable', used_percentage: 70, resets_at: resets };
  board.recordUsage('my-team/vader', {
    seven_day: week,
    account: 'one@example.com',
    model: 'claude-fable-5-1',
    model_windows: [fable],
  });
  board.recordUsage('my-team/leia', {
    seven_day: week,
    account: 'one@example.com',
    model: 'claude-opus-5-5',
  });
  // list_agents: every agent on the account gets its window, with its own line and pace.
  const paced = [
    {
      name: 'Fable',
      used_percentage: 70,
      resets_at: iso(resets * 1000),
      line: 57.1,
      lead: 12.9,
      pace: 'ahead',
      observed_at: iso(now),
      stale: false,
    },
  ];
  assert.deepEqual(board.agentUsage(LOBBY, 'leia')!.model_windows, paced);
  assert.deepEqual(board.agentUsage(LOBBY, 'vader')!.model_windows, paced);
  // The account card has a second bar; a row shows it only for an agent running Fable.
  const view = board.view(LOBBY);
  assert.deepEqual(view.accounts[0]!.windows, [
    { name: 'Fable', used: 70, resets_at: iso(resets * 1000), line: 57, lead: 13, state: 'ahead' },
  ]);
  const rows = Object.fromEntries(view.agents.map((row) => [row.agent_id, row.usage?.windows]));
  assert.deepEqual(rows.vader, [{ name: 'Fable', left: 30, resets_at: iso(resets * 1000) }]);
  assert.deepEqual(rows.leia, []);
  const html = renderBoardBody(view);
  assert.match(html, /aria-label="Fable 70% used, 13 points ahead"/);
  assert.match(html, /Fable <b>70%<\/b> \(<span[^>]*>🎯<\/span>57%\)<\/span>/);
  // Fable's window resets with the week, so the row leaves the reset to the week's.
  assert.match(html, /<span>Fable <b>30% left<\/b><\/span>/);
  assert.match(html, /own weekly limit/);
  // A fresh week does not renew an old look.
  now += 20 * 60_000;
  board.recordUsage('my-team/leia', {
    seven_day: week,
    account: 'one@example.com',
    model: 'claude-opus-5-5',
  });
  const later = board.agentUsage(LOBBY, 'leia')!;
  assert.deepEqual(
    [later.seven_day!.stale, later.model_windows![0]!.stale, later.model_windows![0]!.observed_at],
    [false, true, iso(now - 20 * 60_000)],
  );
  // The freshest look's empty list clears it; with no look at all it is unknown.
  board.recordUsage('my-team/vader', {
    seven_day: week,
    account: 'one@example.com',
    model: 'claude-fable-5-1',
    model_windows: [],
  });
  assert.deepEqual(board.agentUsage(LOBBY, 'leia')!.model_windows, []);
  assert.deepEqual(board.view(LOBBY).accounts[0]!.windows, []);
  assert.doesNotMatch(renderBoardBody(board.view(LOBBY)), /own weekly limit/);
  // A window at 0% is left out, on the board (Johan: "don't show fable usage if it's 0%") and in
  // list_agents, where it would read far behind on accounts no agent runs Fable on (Vader).
  board.recordUsage('my-team/vader', {
    seven_day: week,
    account: 'one@example.com',
    model: 'claude-fable-5-1',
    model_windows: [{ ...fable, used_percentage: 0.3 }],
  });
  assert.deepEqual(board.agentUsage(LOBBY, 'leia')!.model_windows, []);
  const unused = board.view(LOBBY);
  assert.deepEqual(unused.accounts[0]!.windows, []);
  assert.deepEqual(unused.agents.find((row) => row.agent_id === 'vader')!.usage!.windows, []);
  board.recordUsage('my-team/padme', { seven_day: week, account: 'two@example.com' });
  assert.equal(board.agentUsage(LOBBY, 'padme')!.model_windows, null);
});

test('an account card keeps the freshest reading that still has its week', (t) => {
  // Just after a weekly reset Claude Code drops the old window, so one session can report no
  // week while another on the same account already has the new one.
  const now = Date.parse('2026-10-23T12:00:30Z');
  let at = Date.parse('2026-10-23T12:00:01Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => at, {});
  const resets = Date.parse('2026-10-30T12:00:00Z') / 1000;
  board.recordUsage('my-team/leia', {
    account: 'one@example.com',
    seven_day: { used_percentage: 1, resets_at: resets },
  });
  at += 1000;
  board.recordUsage('my-team/mouse', { account: 'one@example.com' });
  at += 1000;
  board.recordUsage('my-team/padme', {
    account: 'one@example.com',
    seven_day: { used_percentage: 99, resets_at: Date.parse('2026-10-23T12:00:00Z') / 1000 },
  });
  const [account] = board.view(LOBBY).accounts;
  assert.equal(account!.week_used, 1);
  assert.equal(account!.agents.length, 3);
});

test('a summary stored before 0.7.0 is not shown', (t) => {
  // Its agents have no queue; the board showed its old text and "nothing queued".
  const store = memoryStore(t, () => Date.parse('2026-10-16T12:00:00Z'));
  populate(store);
  store.saveBoardSummary({
    lobby_id: LOBBY,
    input_hash: 'old',
    sources: [],
    model: 'claude-haiku-5-5',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    cost_usd: 0,
    summary: { agents: [{ agent_id: 'leia', now: 'Plan the release' }] } as never,
    error: null,
  });
  const board = service(t, store, () => Date.parse('2026-10-16T12:00:00Z'), {});
  const leia = board.view(LOBBY).agents.find((agent) => agent.agent_id === 'leia')!;
  assert.deepEqual([leia.now, leia.next], [null, null]);
});

test('waiting for you and the communication history are live, without any summary', (t) => {
  let now = Date.parse('2026-10-16T12:07:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const leia = activate(store, 'leia');
  activate(store, 'mouse');
  activate(store, 'vader');
  const board = service(t, store, () => now, {});
  send(store, 'vader', 'leia');
  send(store, 'leia', 'mouse');
  send(store, 'leia', 'mouse');
  // Thirty minutes without a message sent or a direct one received is away.
  now = Date.parse('2026-10-16T12:30:00Z');
  const chips = () =>
    Object.fromEntries(board.view(LOBBY).agents.map((agent) => [agent.agent_id, agent.chip]));
  assert.deepEqual(chips(), { leia: 'working', mouse: 'working', padme: 'away', vader: 'coord' });
  now = Date.parse('2026-10-16T12:40:00Z');
  assert.deepEqual(chips(), { leia: 'away', mouse: 'away', padme: 'away', vader: 'away' });
  const view = board.view(LOBBY);
  // 96 quarter hours ending with the open one, 12:30–12:45; 12:07 falls in the 12:00 one.
  assert.equal(view.traffic.since_ms, Date.parse('2026-10-15T12:45:00Z'));
  const row = (id: string) => view.agents.find((agent) => agent.agent_id === id)!;
  assert.equal(row('leia').traffic.length, 96);
  assert.deepEqual(row('leia').traffic[93], { sent: 2, received: 1 });
  assert.deepEqual(row('vader').traffic[93], { sent: 1, received: 0 });
  assert.deepEqual(row('mouse').traffic[93], { sent: 0, received: 2 });
  assert.deepEqual(
    ['leia', 'mouse', 'padme'].map((id) => row(id).active),
    ['15 min', '15 min', 'none'],
  );
  assert.deepEqual(view.waiting, []);
  assert.match(renderBoardBody(view), /Nothing waits on you\./);
  // An agent's own word puts it under Waiting for you at once, and 0 takes it away.
  store.setOwnerRequests('leia', leia, { count: 2, text: 'Approve the films; choose squash' });
  now += 5 * 60_000;
  const asked = board.view(LOBBY);
  assert.deepEqual(asked.waiting, [
    {
      agent_id: 'leia',
      name: 'Leia',
      emoji: null,
      count: 2,
      text: 'Approve the films; choose squash',
      since: '5 min',
    },
  ]);
  assert.equal(asked.agents.find((agent) => agent.agent_id === 'leia')!.chip, 'wait');
  assert.match(renderBoardBody(asked), /2 requests.*Approve the films; choose squash/s);
  store.setOwnerRequests('leia', leia, { count: 0 });
  assert.deepEqual(board.view(LOBBY).waiting, []);
  // A day later the history has moved on.
  now += 24 * 60 * 60_000;
  assert.ok(
    board
      .view(LOBBY)
      .agents.every((agent) => agent.traffic.every((slot) => slot.sent + slot.received === 0)),
  );
});

test('hostile note, status and summary text is escaped everywhere it is shown', async (t) => {
  const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)> "quoted" 'single' & more`;
  const f = await browserFixture(t, (store) => {
    store.setBoardVisibility('owner', LOBBY, 'public');
    const leia = activate(store, 'leia');
    store.setBoardAgents(LOBBY, { agents: { leia: { emoji: '👑', name: '<b>Leia</b>' } } });
    store.setBoardSource(LOBBY, 'app', { repo: 'johansan/my-team', notes: ['notes'] }, 'owner');
    store.saveBoardNotes(LOBBY, source('app', 'johansan/my-team', ['notes']), {
      commit_sha: 'c'.repeat(40),
      fetched_at: new Date().toISOString(),
      files: [{ path: 'notes/<x>.md', sha: 'd', bytes: 1, truncated: true, content: hostile }],
    });
    store.setOwnerRequests('leia', leia, { count: 2, text: hostile.slice(0, 290) });
    const summary = SummarySchema.parse({
      agents: [{ agent_id: 'leia', now: hostile, next: [hostile] }],
    });
    store.saveBoardSummary({
      lobby_id: LOBBY,
      input_hash: 'h',
      sources: [],
      model: 'claude-haiku-5-5',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      cost_usd: 0,
      summary,
      error: null,
    });
  });
  const page = await f.onBoard('/');
  const fragment = (JSON.parse((await f.onBoard('/board.json')).body) as { html: string }).html;
  for (const html of [page.body, fragment]) {
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>Leia<\/b>/);
    assert.doesNotMatch(html, /<x>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;b&gt;Leia&lt;\/b&gt;/);
    assert.match(html, /&quot;quoted&quot; &#39;single&#39;/);
  }
  // Exactly the page's own two scripts remain.
  assert.equal(page.body.match(/<script/g)?.length, 2);
  // The Host header's label is escaped on the board's notice page too.
  const odd = await call(f.server.url, `x"y.${DOMAIN}`, '/handoff');
  assert.doesNotMatch(odd.body, /x"y/);
  assert.match(odd.body, /x&quot;y/);
  assert.equal(escape(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('owner CLI: sources, agents, and a status without secrets', async (t) => {
  const f = await browserFixture(t);
  const { server } = f;
  const owner = f.admin;
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-board-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'owner.json');
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(config, JSON.stringify({ url: server.url, token: owner }));
  await chmod(config, 0o600);
  const out: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: () => {} };
  await runCli(
    [
      'board',
      'source',
      'set',
      LOBBY,
      'app',
      '--repo',
      'johansan/my-team',
      '--notes',
      'notes/',
      '--config',
      config,
    ],
    io,
  );
  await runCli(
    [
      'board',
      'source',
      'set',
      LOBBY,
      'social',
      '--repo',
      'johansan/my-team-social',
      '--notes',
      'PLAN.md',
      '--config',
      config,
    ],
    io,
  );
  await runCli(
    [
      'board',
      'agents',
      LOBBY,
      '--agent',
      'leia=👑',
      '--agent',
      'padme=🌸 Padmé',
      '--agent',
      'mouse=🛎️ Poco',
      '--support',
      'mouse',
      '--config',
      config,
    ],
    io,
  );
  // The 0.4.0 board password is gone from the CLI and the admin API.
  await assert.rejects(runCli(['board', 'password', LOBBY, '--config', config], io), /Unknown/);
  assert.equal(
    (await f.admin_('PUT', `/v1/admin/board/password?lobby=${LOBBY}`, { password: 'x'.repeat(20) }))
      .status,
    404,
  );
  out.length = 0;
  await runCli(['board', 'status', LOBBY, '--config', config], io);
  const status = JSON.parse(out.join('\n')) as {
    board_url: string;
    visibility: string;
    summary_settings: { model: string; effort: string };
    agents: Record<string, { emoji: string; name?: string }>;
    sources: { room_id: string; notes: string[]; commit_sha: null }[];
    secrets: { github_token: boolean; anthropic_api_key: boolean };
    usage: { last_24h: { runs: number; cost_usd: number } };
  };
  assert.equal(status.board_url, `https://${LOBBY}.${DOMAIN}/`);
  assert.equal(status.visibility, 'private');
  assert.deepEqual(status.summary_settings, { model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(status.agents.padme, { emoji: '🌸', name: 'Padmé' });
  assert.deepEqual(status.agents.mouse, { emoji: '🛎️', name: 'Poco', support: true });
  assert.deepEqual(
    status.sources.map((item) => [item.room_id, item.notes, item.commit_sha]),
    [
      ['app', ['notes'], null],
      ['social', ['PLAN.md'], null],
    ],
  );
  assert.deepEqual(status.secrets, { github_token: false, anthropic_api_key: false });
  assert.deepEqual(status.usage.last_24h, {
    runs: 0,
    failed: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  });
  await runCli(['board', 'source', 'remove', LOBBY, 'social', '--config', config], io);
  await assert.rejects(
    runCli(['board', 'source', 'remove', LOBBY, 'social', '--config', config], io),
    /board_source_not_found/,
  );
});

// ---------------------------------------------------------------------------------------------
// Lobby names and summarizer limits.

test('a board needs a lobby ID that is also a DNS label', async (t) => {
  // Only a lobby made before 0.5.0 can still have such a name.
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-legacy-label-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'lobby.db');
  new LobbyStore(path).close();
  const legacy = new DatabaseSync(path);
  legacy.exec("INSERT INTO lobbies(lobby_id) VALUES('my_team')");
  legacy.close();
  const store = new LobbyStore(path);
  t.after(() => store.close());
  store.createRoom('owner', 'app', 'my_team');
  assert.throws(
    () => store.setBoardSource('my_team', 'app', { repo: 'a/b', notes: ['notes'] }, 'owner'),
    (error: unknown) => error instanceof LobbyError && error.code === 'lobby_not_board_compatible',
  );
});

test('a failure the model answered waits for new input, and an idle visit says nothing', async (t) => {
  const { github, clock, store } = await summarizedStore(t);
  const fake = fakeClient([answer('not the summary'), answer('not the summary either')]);
  const board = service(t, store, () => clock.now, {
    githubToken: 'github-test-value',
    githubApi: github.url,
    summaryClient: fake.client,
    summaryIntervalMs: 600_000,
  });
  // The first visit reads the notes, and the page rendered for it says so.
  const visit = board.request(LOBBY);
  assert.equal(board.activity(LOBBY), 'checking');
  await visit;
  assert.equal(fake.calls.length, 1);
  assert.ok(store.boardLastAttempt(LOBBY)!.error);
  // A visit with nothing due does nothing, so the page stops polling fast.
  const idle = board.request(LOBBY);
  assert.equal(board.activity(LOBBY), null);
  await idle;
  // The same input is not paid for again after the interval.
  clock.now += 700_000;
  await board.request(LOBBY);
  assert.equal(fake.calls.length, 1);
  // New input is.
  activate(store, 'leia');
  send(store, 'leia', 'vader', { kind: 'report', content: 'Present fixes' });
  clock.now += 700_000;
  await board.request(LOBBY);
  assert.equal(fake.calls.length, 2);
});

test('notes beyond the summarizer’s budget are cut and marked, not refused', () => {
  const long = 'x'.repeat(150_000);
  const request = summaryRequest({
    lobby: LOBBY,
    agents: [],
    notes: ['app', 'web'].map((room) => ({
      room_id: room,
      repo: `johansan/${room}`,
      snapshot: {
        commit_sha: 'a'.repeat(40),
        fetched_at: '2026-10-16T07:00:00Z',
        files: [
          {
            path: 'notes/plan.md',
            sha: 'b'.repeat(40),
            bytes: 150_000,
            truncated: false,
            content: long,
          },
        ],
      },
    })),
    messages: [],
  });
  const data = JSON.parse(String(request.messages[0]!.content)) as {
    notes: { files: { content: string; truncated?: string }[] }[];
  };
  const files = data.notes.flatMap((notes) => notes.files);
  assert.equal(
    files.reduce((sum, file) => sum + file.content.length, 0),
    200_000,
  );
  assert.equal(files[0]!.truncated, undefined);
  assert.equal(files[1]!.truncated, 'first 50000 of 150000 bytes');
});

test("an account's week comes from its freshest report, marked stale when none came for 15 minutes", (t) => {
  // Vader, 2026-10-17 03:00: Lando's three-hour-old reading looked as fresh as the others.
  let now = Date.parse('2026-10-16T22:05:00Z');
  const store = memoryStore(t, () => now);
  populate(store);
  const board = service(t, store, () => now, {});
  const resets = Date.parse('2026-10-19T12:00:00Z') / 1000;
  const report = (used: number) => ({
    seven_day: { used_percentage: used, resets_at: resets },
    account: 'one@example.com',
    plan: 'max',
  });
  board.recordUsage('my-team/leia', report(40));
  const leiaAt = new Date(now).toISOString();
  now += 3 * 60 * 60_000;
  board.recordUsage('my-team/mouse', report(52));
  // Leia's own status line is quiet, but her account's week is Mouse's fresh one.
  const leia = board.agentUsage(LOBBY, 'leia')!;
  assert.equal(leia.observed_at, leiaAt);
  assert.deepEqual(
    [leia.seven_day!.used_percentage, leia.seven_day!.observed_at, leia.seven_day!.stale],
    [52, new Date(now).toISOString(), false],
  );
  assert.equal(board.view(LOBBY).accounts[0]!.week_used, 52);
  // No fresh report on the account for 15 minutes: stale, for every agent on it.
  now += 15 * 60_000;
  assert.equal(board.agentUsage(LOBBY, 'leia')!.seven_day!.stale, true);
  assert.equal(board.agentUsage(LOBBY, 'mouse')!.seven_day!.stale, true);
});
