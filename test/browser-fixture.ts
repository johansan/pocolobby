import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { MailError, type Mailer } from '../src/mail.js';
import { startServer, type ServerOptions } from '../src/server.js';
import { LobbyStore } from '../src/store.js';

/**
 * A broker with boards on `<lobby>.board.test` and the console on `http://board.test`, a mailer
 * that keeps every code it is asked to send, and helpers that sign in and open boards the way a
 * browser does (0.5.0). Requests go to the listener with the Host header of the host they name.
 */
export const DOMAIN = 'board.test';
export const CONSOLE = `http://${DOMAIN}`;
export const LOBBY = 'my-team';
export const OWNER_EMAIL = 'owner@example.com';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
export function call(
  base: string,
  host: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? 'GET',
        headers: {
          host,
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { 'content-length': String(Buffer.byteLength(options.body)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}
/** The name=value part of a reply's first Set-Cookie header. */
export const cookieOf = (reply: Reply) =>
  String(reply.headers['set-cookie']?.[0] ?? '').split(';')[0]!;

export interface Fixture {
  server: Awaited<ReturnType<typeof startServer>>;
  /** The operator's admin token. */
  admin: string;
  clock: { now: number };
  database: string;
  /** Every code the mailer was asked to send. */
  mail: { to: string; code: string }[];
  /** Make the mailer's next sends fail, as a Postmark refusal would. */
  failMail: { next: number };
  /** A JSON POST to the console, from its own origin unless the headers say otherwise. */
  post(
    path: string,
    body: unknown,
    cookie?: string,
    headers?: Record<string, string>,
  ): Promise<Reply>;
  /** A GET on the console host. */
  get(path: string, cookie?: string): Promise<Reply>;
  /** Ask for a code and use it; returns the console cookie. */
  signIn(email: string): Promise<string>;
  /** Follow the console's hand-off to a board host; returns that host's cookie. */
  openBoard(consoleCookie: string, lobby?: string): Promise<string>;
  /** A request on a board host. */
  onBoard(path: string, options?: Parameters<typeof call>[3], lobby?: string): Promise<Reply>;
  /** An operator request to the admin API. */
  admin_(method: string, path: string, body?: unknown): Promise<Reply>;
}

export async function browserFixture(
  t: TestContext,
  prepare?: (store: LobbyStore) => Promise<void> | void,
  options: Partial<ServerOptions> = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pocolobby-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: Date.parse('2026-10-16T07:00:00Z') };
  const database = join(directory, 'lobby.db');
  const seed = new LobbyStore(database, { now: () => clock.now });
  seed.createLobby(LOBBY);
  for (const id of ['leia', 'mouse', 'padme'])
    seed.provision({ agent_id: id, role: '', can_broadcast: false, allowed_recipients: null });
  seed.provision({
    agent_id: 'vader',
    role: '',
    can_broadcast: false,
    allowed_recipients: null,
    manage_rooms: true,
  });
  seed.createRoom('owner', 'app', LOBBY);
  seed.createRoom('owner', 'social', LOBBY);
  seed.grantLobby(OWNER_EMAIL, LOBBY);
  await prepare?.(seed);
  seed.close();
  const mail: Fixture['mail'] = [];
  const failMail = { next: 0 };
  const mailer: Mailer = {
    async sendSignInCode(to, code) {
      if (failMail.next > 0) {
        failMail.next -= 1;
        throw new MailError(
          'The email service refused the message (422, error 406): Inactive recipient',
        );
      }
      mail.push({ to, code });
    },
  };
  const admin = randomBytes(32).toString('base64url');
  const server = await startServer({
    database,
    adminToken: admin,
    port: 0,
    storeOptions: { now: () => clock.now },
    board: { domain: DOMAIN },
    console: { origin: CONSOLE, mailer, responseFloorMs: 0 },
    ...options,
  });
  t.after(() => server.close());
  const post: Fixture['post'] = (path, body, cookie, headers = {}) =>
    call(server.url, DOMAIN, path, {
      method: 'POST',
      headers: {
        origin: CONSOLE,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const get: Fixture['get'] = (path, cookie) =>
    call(server.url, DOMAIN, path, { headers: cookie ? { cookie } : {} });
  const onBoard: Fixture['onBoard'] = (path, request = {}, lobby = LOBBY) =>
    call(server.url, `${lobby}.${DOMAIN}`, path, request);
  return {
    server,
    admin,
    clock,
    database,
    mail,
    failMail,
    post,
    get,
    onBoard,
    async signIn(email) {
      const sent = await post('/console/api/sign-in/code', { email });
      assert.equal(sent.status, 200, sent.body);
      const code = mail.filter((item) => item.to === email.trim().toLowerCase()).at(-1)?.code;
      assert.ok(code, `no code was sent to ${email}`);
      const verified = await post('/console/api/sign-in/verify', { email, code });
      assert.equal(verified.status, 200, verified.body);
      return cookieOf(verified);
    },
    async openBoard(consoleCookie, lobby = LOBBY) {
      const open = await get(`/console/open/${lobby}`, consoleCookie);
      assert.equal(open.status, 303, open.body);
      const location = new URL(String(open.headers.location));
      assert.equal(location.host, `${lobby}.${DOMAIN}`);
      const handoff = await onBoard(`${location.pathname}${location.search}`, {}, lobby);
      assert.equal(handoff.status, 303, handoff.body);
      return cookieOf(handoff);
    },
    admin_: (method, path, body) =>
      call(server.url, '127.0.0.1', path, {
        method,
        headers: {
          authorization: `Bearer ${admin}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}
