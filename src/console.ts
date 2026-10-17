import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { z, ZodError } from 'zod';
import {
  Code,
  CONSOLE_COOKIE,
  cookieToken,
  newCode,
  newSessionToken,
  sessionCookie,
  SignInKeys,
  SIGN_IN,
  tokenHash,
  WindowLimiter,
} from './auth.js';
import type { BoardService } from './board.js';
import {
  BoardIconSchema,
  BoardSourceSchema,
  BoardVisibility,
  SummarySettingsSchema,
} from './board-model.js';
import { boardCsp } from './board-page.js';
import {
  renderActivity,
  renderAgents,
  renderBoardAccess,
  renderHome,
  renderNotice,
  renderOverview,
  renderRooms,
  renderSettings,
  renderSignIn,
  renderSummaries,
  type Section,
  type Shell,
} from './console-page.js';
import { MailError, type Mailer } from './mail.js';
import { AgentId, Email, LobbyError, RoomId } from './protocol.js';
import type { LobbyStore } from './store.js';

/**
 * The lobby owner console (0.5.0) at `<origin>/console`: email-code sign-in, the lobbies an
 * account owns, and the hand-off that opens a private board on its own host. It is served
 * before the agent API's checks and shares nothing with them: it reads only its own cookie,
 * never Authorization, and its account is never the operator. Every POST must come from the
 * console's own origin as JSON of at most 4 KB with only the fields its route names.
 */
export interface ConsoleSettings {
  /** Such as https://pocolobby.com; the console answers only on this origin. */
  origin: string;
  /** Null when sign-in mail is not configured; the page then says what is missing. */
  mailer: Mailer | null;
  /** The settings missing for sign-in, named on the page. */
  missing: string[];
  /**
   * Every code request takes at least this long, so an address that gets a mail and one that
   * does not answer alike. Tests shorten it.
   */
  responseFloorMs?: number;
}
export interface ConsoleContext {
  store: LobbyStore;
  board: BoardService;
  keys: SignInKeys;
  boardDomain: string;
  clientAddress(request: IncomingMessage): string;
  overRate(key: string): boolean;
  isConnected(lobby: string, agent: string): boolean;
  /** Close the sockets of these agent principals (a deleted lobby's agents). */
  closeAgents(principals: string[]): void;
  /** Bring a lobby's board up to date now, such as after its sources changed. */
  refreshBoards(lobby: string): void;
  github: boolean;
  anthropic: boolean;
  clock: () => number;
}

const MAX_BODY = 4096;
/** An icon upload: a PNG of at most 64 KB in base64, with room to tell a larger one its size. */
const MAX_ICON_BODY = 512 * 1024;
const Board = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
/** A comma-separated field; spaces inside an item are kept, since a notes path may contain them. */
const list = (max: number) =>
  z
    .string()
    .max(2000)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).max(max));
const Schemas = {
  code: z.object({ email: Email }).strict(),
  verify: z.object({ email: Email, code: Code, board: Board.optional() }).strict(),
  empty: z.object({}).strict(),
  lobby: z.object({ lobby_id: z.string().max(64), first_room: RoomId.optional() }).strict(),
  room: z.object({ room_id: RoomId }).strict(),
  members: z
    .object({ add: AgentId.optional(), remove: AgentId.optional() })
    .strict()
    .refine((value) => value.add !== undefined || value.remove !== undefined, 'Name a member'),
  source: z
    .object({ repo: z.string().max(201), ref: z.string().max(200).optional(), notes: list(20) })
    .strict(),
  summary: SummarySettingsSchema,
  visibility: z.object({ visibility: BoardVisibility }).strict(),
  viewer: z.object({ email: Email }).strict(),
  delete: z.object({ confirm: z.string().max(64) }).strict(),
  icon: BoardIconSchema,
  displayName: z.object({ display_name: z.string().max(200).optional() }).strict(),
};

/** A JSON answer to a console POST. */
class Reply {
  constructor(
    readonly status: number,
    readonly body: object,
    readonly headers: Record<string, string> = {},
  ) {}
}
const ok = (body: object = {}, headers: Record<string, string> = {}) =>
  new Reply(200, { ok: true, ...body }, headers);
const refuse = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) => new Reply(status, { error: { code, message } }, headers);

export function createConsole(settings: ConsoleSettings, context: ConsoleContext) {
  const { store, board, keys } = context;
  const origin = new URL(settings.origin);
  const floor = settings.responseFloorMs ?? 1000;
  // Per client: code requests and code checks; the per-address limits live in the store.
  const sends = new WindowLimiter(10, 15 * 60_000);
  const checks = new WindowLimiter(30, 15 * 60_000);

  /** `https://<lobby>.<domain>/`, with the console's scheme and port. */
  const boardUrl = (lobby: string, path = '/') =>
    `${origin.protocol}//${lobby}.${context.boardDomain}${origin.port ? `:${origin.port}` : ''}${path}`;
  const address = (lobby: string) => `${lobby}.${context.boardDomain}`;
  /** Where a board host sends a viewer without a session. */
  const openUrl = (label: string) => `${origin.origin}/console/open/${encodeURIComponent(label)}`;

  function send(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    type: string,
    body: string | Buffer,
    nonce: string,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': type.startsWith('text/html')
        ? boardCsp(nonce)
        : "default-src 'none'; frame-ancestors 'none'",
      ...headers,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  /** The signed-in account, refreshing its session once a day. */
  function session(request: IncomingMessage, headers: Record<string, string>) {
    const token = cookieToken(request.headers.cookie, CONSOLE_COOKIE);
    if (!token) return null;
    const found = store.consoleSession(tokenHash(token));
    if (found?.refresh) {
      store.refreshConsoleSession(tokenHash(token));
      headers['set-cookie'] = sessionCookie(CONSOLE_COOKIE, token);
    }
    return found;
  }

  /**
   * A JSON body of at most 4 KB (or `max`) from the console's own origin, parsed by its route's schema. For
   * a signed-in action, `account` is who was signed in when the request began: the body read
   * yields, so the session is checked again once it has arrived, and a sign-out, a disable or an
   * expiry meanwhile stops the action.
   */
  async function input<T extends z.ZodType>(
    request: IncomingMessage,
    schema: T,
    account?: string,
    max = MAX_BODY,
  ): Promise<z.output<T>> {
    if (request.headers.origin !== origin.origin) {
      request.resume();
      throw new LobbyError(403, 'origin_not_allowed', 'Use the console page itself.');
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
      request.resume();
      throw new LobbyError(415, 'content_type', 'Use application/json.');
    }
    if (Number(request.headers['content-length']) > max) {
      request.resume();
      throw new LobbyError(413, 'body_too_large', 'The request is too large.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    }
    if (size > max) throw new LobbyError(413, 'body_too_large', 'The request is too large.');
    if (account !== undefined) {
      const token = cookieToken(request.headers.cookie, CONSOLE_COOKIE);
      if (!token || store.consoleSession(tokenHash(token))?.account_id !== account)
        throw new LobbyError(401, 'sign_in_required', 'Your session has ended. Sign in again.');
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new LobbyError(400, 'invalid_json', 'The request is not valid JSON.');
    }
    return schema.parse(value);
  }

  async function signInCode(request: IncomingMessage): Promise<Reply> {
    const { email } = await input(request, Schemas.code);
    // From here on, a request that is not refused takes at least the floor, mail or no mail.
    const deadline = Date.now() + floor;
    if (!settings.mailer)
      return refuse(503, 'sign_in_unavailable', 'Sign-in is not configured on this server.');
    const client = sends.take(context.clientAddress(request));
    if (client)
      return refuse(
        429,
        'too_many_requests',
        `Too many codes asked from here. Try again in ${Math.ceil(client / 60)} min.`,
        {
          'retry-after': String(client),
        },
      );
    const key = keys.emailKey(email);
    const code = newCode();
    const begun = store.beginSignIn(email, key, keys.codeMac(key, code));
    if (begun.wait)
      return refuse(
        429,
        'too_many_requests',
        `Wait ${begun.wait < 120 ? `${begun.wait} s` : `${Math.ceil(begun.wait / 60)} min`} before asking for another code.`,
        {
          'retry-after': String(begun.wait),
        },
      );
    let failure: string | null = null;
    if (begun.send)
      try {
        await settings.mailer.sendSignInCode(email, code);
      } catch (error) {
        failure = error instanceof MailError ? error.message : 'The email could not be sent';
      }
    const left = deadline - Date.now();
    if (left > 0) await sleep(left);
    if (failure)
      return refuse(
        502,
        'mail_failed',
        `We could not send the code: ${failure}. Try again in a minute.`,
      );
    return ok({
      message: `If ${email} may sign in, a code is on its way. It works for 10 minutes.`,
    });
  }

  async function signInVerify(request: IncomingMessage): Promise<Reply> {
    const { email, code, board: label } = await input(request, Schemas.verify);
    const client = checks.take(context.clientAddress(request));
    if (client)
      return refuse(
        429,
        'too_many_requests',
        `Too many tries from here. Try again in ${Math.ceil(client / 60)} min.`,
        {
          'retry-after': String(client),
        },
      );
    const key = keys.emailKey(email);
    const token = newSessionToken();
    const result = store.finishSignIn(email, key, keys.codeMac(key, code), tokenHash(token));
    if ('error' in result) {
      if (result.error === 'budget')
        return refuse(
          429,
          'too_many_wrong_codes',
          `Too many wrong codes for this address. Wait ${Math.ceil(result.wait / 60)} min, then ask for a new code.`,
          {
            'retry-after': String(result.wait),
          },
        );
      // A spent code answers like a wrong one: telling them apart would show that a code was
      // sent, and so that the address may sign in.
      return refuse(
        400,
        'code_invalid',
        'That code is not right, has expired, or had 5 wrong tries. Check the email, or ask for a new code.',
      );
    }
    return ok(
      { redirect: label ? `/console/open/${label}` : '/console' },
      { 'set-cookie': sessionCookie(CONSOLE_COOKIE, token) },
    );
  }

  /** A lobby's console actions; the store checks ownership again inside each transaction. */
  async function lobbyAction(
    request: IncomingMessage,
    accountId: string,
    lobby: string,
    rest: string,
  ): Promise<Reply> {
    const actor = { account_id: accountId };
    if (!store.ownsLobby(accountId, lobby)) {
      request.resume();
      return refuse(404, 'lobby_not_found', 'Unknown lobby');
    }
    const room = /^rooms\/([^/]+)\/(members|source|source\/remove|archive|restore)$/u.exec(rest);
    if (rest === 'rooms') {
      const { room_id } = await input(request, Schemas.room, accountId);
      store.createRoom(actor, room_id, lobby);
      return ok();
    }
    if (room) {
      const roomId = RoomId.parse(room[1]);
      if (room[2] === 'members') {
        const changes = await input(request, Schemas.members, accountId);
        store.changeRoomMembers(
          actor,
          roomId,
          {
            ...(changes.add ? { add: [changes.add] } : {}),
            ...(changes.remove ? { remove: [changes.remove] } : {}),
          },
          lobby,
        );
        return ok();
      }
      if (room[2] === 'source') {
        const source = await input(request, Schemas.source, accountId);
        store.setBoardSource(lobby, roomId, BoardSourceSchema.parse(source), actor);
        context.refreshBoards(lobby);
        return ok();
      }
      await input(request, Schemas.empty, accountId);
      if (room[2] === 'source/remove') store.removeBoardSource(lobby, roomId, actor);
      else if (room[2] === 'archive') store.archiveRoom(actor, roomId, lobby);
      else store.restoreRoom(actor, roomId, lobby);
      return ok();
    }
    if (rest === 'summaries') {
      store.setSummarySettings(actor, lobby, await input(request, Schemas.summary, accountId));
      return ok({ message: 'Saved. The next summary uses these settings.' });
    }
    if (rest === 'summaries/test') {
      await input(request, Schemas.empty, accountId);
      // runNow is no store change that checks ownership, and the body read yielded meanwhile.
      if (!store.ownsLobby(accountId, lobby))
        return refuse(404, 'lobby_not_found', 'Unknown lobby');
      const done = board.runNow(lobby);
      done.catch(() => {
        /* Its outcome is stored and shown on the page. */
      });
      return ok({ message: 'Writing a test summary now. Reload in a minute to see it.' });
    }
    if (rest === 'board/visibility') {
      const { visibility } = await input(request, Schemas.visibility, accountId);
      store.setBoardVisibility(actor, lobby, visibility);
      return ok();
    }
    if (rest === 'display-name') {
      const { display_name } = await input(request, Schemas.displayName, accountId);
      store.setDisplayName(actor, lobby, display_name ?? '');
      return ok();
    }
    if (rest === 'board/icon') {
      const { png } = await input(request, Schemas.icon, accountId, MAX_ICON_BODY);
      store.setBoardIcon(actor, lobby, Buffer.from(png, 'base64'));
      return ok();
    }
    if (rest === 'board/icon/remove') {
      await input(request, Schemas.empty, accountId);
      store.setBoardIcon(actor, lobby, null);
      return ok();
    }
    if (rest === 'board/viewers') {
      store.addBoardViewer(actor, lobby, (await input(request, Schemas.viewer, accountId)).email);
      return ok();
    }
    if (rest === 'board/viewers/remove') {
      store.removeBoardViewer(
        actor,
        lobby,
        (await input(request, Schemas.viewer, accountId)).email,
      );
      return ok();
    }
    if (rest === 'delete') {
      const { confirm } = await input(request, Schemas.delete, accountId);
      const deleted = store.deleteLobby(actor, lobby, confirm);
      context.closeAgents(deleted.agents);
      return ok({ redirect: '/console' });
    }
    request.resume();
    return refuse(404, 'not_found', 'Unknown console route.');
  }

  async function api(
    request: IncomingMessage,
    path: string,
    headers: Record<string, string>,
  ): Promise<Reply> {
    if (request.method !== 'POST') {
      request.resume();
      return refuse(405, 'method_not_allowed', 'Use POST.');
    }
    if (path === '/console/api/sign-in/code') return signInCode(request);
    if (path === '/console/api/sign-in/verify') return signInVerify(request);
    if (path === '/console/api/sign-out') {
      await input(request, Schemas.empty);
      const token = cookieToken(request.headers.cookie, CONSOLE_COOKIE);
      if (token) store.endConsoleSession(tokenHash(token));
      return ok({ redirect: '/console' }, { 'set-cookie': sessionCookie(CONSOLE_COOKIE, null) });
    }
    const account = session(request, headers);
    if (!account) {
      request.resume();
      return refuse(401, 'sign_in_required', 'Your session has ended. Sign in again.');
    }
    if (path === '/console/api/lobbies') {
      const created = store.createOwnedLobby(
        account.account_id,
        await input(request, Schemas.lobby, account.account_id),
      );
      return ok({ redirect: `/console/${created.lobby_id}` });
    }
    const match = /^\/console\/api\/l\/([^/]+)\/(.+)$/u.exec(path);
    if (match) return lobbyAction(request, account.account_id, match[1]!, match[2]!);
    request.resume();
    return refuse(404, 'not_found', 'Unknown console route.');
  }

  /** A console page for a signed-in account; a lobby it does not own looks like no lobby. */
  function pageFor(
    account: { account_id: string; email: string; may_create_lobbies: boolean },
    path: string,
    nonce: string,
  ): { status: number; html: string } | { redirect: string } {
    const shell: Shell = { nonce, email: account.email };
    if (path === '/console' || path === '/console/') {
      const lobbies = store.consoleLobbies(account.account_id);
      return {
        status: 200,
        html: renderHome(shell, {
          owned: lobbies.owned,
          viewing: lobbies.viewing.map((lobby) => ({
            lobby_id: lobby.lobby_id,
            display_name: lobby.display_name,
            url: `/console/open/${lobby.lobby_id}`,
          })),
          mayCreate: account.may_create_lobbies,
          remaining: SIGN_IN.lobbiesPerAccount - lobbies.owned.length,
          domain: context.boardDomain,
          address,
        }),
      };
    }
    const open = /^\/console\/open\/([^/]+)$/u.exec(path);
    if (open) {
      const label = open[1]!;
      const visibility = store.boardVisibility(label);
      if (visibility === 'public') return { redirect: boardUrl(label) };
      const token = newSessionToken();
      if (visibility !== null && store.createHandoff(account.account_id, label, tokenHash(token)))
        return { redirect: boardUrl(label, `/handoff?token=${token}`) };
      return {
        status: 404,
        html: renderNotice(
          shell,
          'No board to open',
          `${account.email} cannot open a board named ${label}. Ask its owner to add you as a viewer.`,
          { href: '/console', label: 'Your lobbies' },
        ),
      };
    }
    // A lobby's pages sit right under /console: a lobby may not be named like the console's own
    // pages (open, sign-in, api and l are reserved).
    const lobbyPage =
      /^\/console\/([^/]+)(?:\/(rooms|summaries|board|agents|activity|settings))?$/u.exec(path);
    if (!lobbyPage)
      return {
        status: 404,
        html: renderNotice(shell, 'Not found', 'There is no such console page.', {
          href: '/console',
          label: 'Your lobbies',
        }),
      };
    const lobby = lobbyPage[1]!;
    if (!store.ownsLobby(account.account_id, lobby))
      return {
        status: 404,
        html: renderNotice(shell, 'Not found', 'None of your lobbies has that name.', {
          href: '/console',
          label: 'Your lobbies',
        }),
      };
    const section = (lobbyPage[2] ?? 'overview') as Section;
    const lobbyShell: Shell = {
      ...shell,
      section,
      lobby: {
        id: lobby,
        name: store.displayName(lobby) ?? lobby,
        address: address(lobby),
        url: boardUrl(lobby),
      },
    };
    const config = store.boardConfig(lobby);
    const html = (() => {
      switch (section) {
        case 'overview':
          return renderOverview(lobbyShell, {
            view: board.view(lobby),
            config,
            rooms: store.rooms(lobby),
            agents: store.agents(lobby),
            viewers: store.boardViewers(lobby).length,
            sessions: store.boardSessionCount(lobby),
            last: store.boardLastAttempt(lobby),
          });
        case 'rooms':
          return renderRooms(lobbyShell, {
            rooms: store.rooms(lobby),
            archived: store.archivedRooms(lobby),
            config,
            view: board.view(lobby),
            snapshots: store.boardNotes(lobby),
            repos: store.lobbyRepos(lobby),
            agents: store.agents(lobby),
            github: context.github,
          });
        case 'summaries':
          return renderSummaries(lobbyShell, {
            config,
            keySet: context.anthropic,
            usage: store.boardUsage(lobby, context.clock() - 86_400_000),
            last: store.boardLastAttempt(lobby),
            good: store.boardSummary(lobby),
          });
        case 'board':
          return renderBoardAccess(lobbyShell, {
            config,
            icon: store.boardIcon(lobby),
            viewers: store.boardViewers(lobby),
            sessions: store.boardSessionCount(lobby),
            owner: account.email,
          });
        case 'agents':
          return renderAgents(lobbyShell, {
            agents: store.agents(lobby),
            rooms: store.rooms(lobby),
            config,
            connected: (id) => context.isConnected(lobby, id),
          });
        case 'activity':
          return renderActivity(lobbyShell, { events: store.activity(lobby) });
        case 'settings':
          return renderSettings(lobbyShell, {
            display_name: store.displayName(lobby),
            agents: store.agents(lobby).filter((agent) => agent.enabled).length,
            created:
              store.consoleLobbies(account.account_id).owned.find((item) => item.lobby_id === lobby)
                ?.created_at ?? null,
          });
      }
    })();
    return { status: 200, html };
  }

  return {
    openUrl,
    /** Whether a request on an API host is for the console. */
    handles: (path: string) => path === '/console' || path.startsWith('/console/'),
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://console.invalid');
      const nonce = randomBytes(16).toString('base64');
      const headers: Record<string, string> = {};
      const method = request.method ?? 'GET';
      // One console origin: other API hosts send its pages there, and refuse its actions.
      if ((request.headers.host ?? '').toLowerCase() !== origin.host) {
        request.resume();
        if (method === 'GET' || method === 'HEAD')
          send(request, response, 301, 'text/plain; charset=utf-8', '', nonce, {
            location: `${origin.origin}${url.pathname}${url.search}`,
          });
        else send(request, response, 404, 'text/plain; charset=utf-8', 'Not found.', nonce);
        return;
      }
      if (context.overRate(context.clientAddress(request))) {
        request.resume();
        send(
          request,
          response,
          429,
          'text/plain; charset=utf-8',
          'Too many requests; wait a minute.',
          nonce,
          { 'retry-after': '60' },
        );
        return;
      }
      if (url.pathname.startsWith('/console/api/')) {
        let reply: Reply;
        try {
          reply = await api(request, url.pathname, headers);
        } catch (error) {
          reply =
            error instanceof LobbyError
              ? refuse(error.status, error.code, error.message)
              : error instanceof ZodError
                ? refuse(
                    400,
                    'invalid_request',
                    error.issues.map((issue) => issue.message).join('; '),
                  )
                : refuse(
                    500,
                    'internal_error',
                    'The console could not do that. Nothing is implied to have changed; reload and check.',
                  );
        }
        send(
          request,
          response,
          reply.status,
          'application/json; charset=utf-8',
          JSON.stringify(reply.body),
          nonce,
          {
            ...headers,
            ...reply.headers,
          },
        );
        return;
      }
      request.resume();
      if (method !== 'GET' && method !== 'HEAD') {
        send(request, response, 405, 'text/plain; charset=utf-8', 'Use GET.', nonce);
        return;
      }
      const account = session(request, headers);
      const html = 'text/html; charset=utf-8';
      if (!account) {
        const open = /^\/console\/open\/([^/]+)$/u.exec(url.pathname);
        const label = open
          ? open[1]!
          : url.pathname === '/console/sign-in'
            ? url.searchParams.get('board')
            : null;
        if (
          url.pathname === '/console' ||
          url.pathname === '/console/' ||
          url.pathname === '/console/sign-in' ||
          open
        ) {
          send(
            request,
            response,
            200,
            html,
            renderSignIn(
              { nonce, email: null },
              {
                missing: settings.missing,
                board: label !== null && Board.safeParse(label).success ? label : null,
              },
            ),
            nonce,
            headers,
          );
          return;
        }
        send(request, response, 303, 'text/plain; charset=utf-8', '', nonce, {
          location: '/console/sign-in',
        });
        return;
      }
      // The owner's preview of the board's own icon on its Board access page.
      const preview = /^\/console\/([^/]+)\/icon\.png$/u.exec(url.pathname);
      const own =
        preview && store.ownsLobby(account.account_id, preview[1]!)
          ? store.boardIcon(preview[1]!)
          : null;
      if (own) {
        send(request, response, 200, 'image/png', own.png, nonce, {
          ...headers,
          'content-length': String(own.png.length),
          'cache-control': 'private, no-cache',
        });
        return;
      }
      // Already signed in: go where signing in would have led.
      const board = url.searchParams.get('board');
      const result =
        url.pathname === '/console/sign-in'
          ? {
              redirect:
                board && Board.safeParse(board).success ? `/console/open/${board}` : '/console',
            }
          : pageFor(account, url.pathname, nonce);
      if ('redirect' in result)
        send(request, response, 303, 'text/plain; charset=utf-8', '', nonce, {
          ...headers,
          location: result.redirect,
        });
      else send(request, response, result.status, html, result.html, nonce, headers);
    },
  };
}
export type Console = ReturnType<typeof createConsole>;
