import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { pipeline, type Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { ZodError, z } from 'zod';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_UPLOAD_INFLIGHT_BYTES,
  formatBytes,
} from './attachments.js';
import {
  buildCatalog,
  defaultTools,
  permitted,
  toolGuide,
  ToolName,
  validateTools,
  type ToolContext,
  type ToolDefinition,
} from './catalog.js';
import {
  BOARD_COOKIE,
  clientKey,
  cookieToken,
  newSessionToken,
  sessionCookie,
  SignInKeys,
  tokenHash,
} from './auth.js';
import { BoardService, type BoardSettings } from './board.js';
import {
  BoardAgentsSchema,
  BoardIconSchema,
  RepoName,
  type BoardSourceInput,
} from './board-model.js';
import { boardCsp, renderBoardBody, renderBoardNotice, renderBoardPage } from './board-page.js';
import { MASCOT_HEADERS, mascotFile } from './mascots.js';
import { iconFile, iconVersion } from './icons.js';
import { createConsole } from './console.js';
import type { Mailer } from './mail.js';
import { acquireDatabaseLock } from './lock.js';
import { presentMessage, presentReceipts } from './presentation.js';
import { LobbyStore } from './store.js';
import {
  AccountSettingsSchema,
  AckSchema,
  AgentId,
  DEFAULT_PUSH_BYTES,
  MIN_PUSH_BYTES,
  MAX_PUSH_BYTES,
  CancelScheduledSchema,
  CheckpointSchema,
  EVENT_VERSION,
  EVENT_VERSION_HEADER,
  ExtensionKey,
  LobbyId,
  LobbySchema,
  LobbyError,
  HEADER_KEYS,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_KEYS,
  MESSAGE_KEYS,
  OwnerSchema,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  ProvisionSchema,
  ReadySchema,
  RESERVED_LOBBY_IDS,
  RoomId,
  RoomSchema,
  RoomMembersSchema,
  RoomMemberChangesSchema,
  RuntimeSchema,
  ScheduleSchema,
  SendSchema,
  OwnerRequestsSchema,
  UsageReportSchema,
  TransportReceiptSchema,
  UpdateAgentSchema,
  qualifyAgent,
  parsePrincipal,
  RECEIPT_KEYS,
  type AgentContext,
  type CatalogEvent,
  type EventAttachment,
  type LobbyEvent,
  type RuntimeAuth,
} from './protocol.js';

// Room for a 64 KiB message after JSON escaping, plus its fields.
const MAX_BODY = 256 * 1024;
/** Above this an event drops its presentations; the bridge then renders them locally. */
const MAX_PRESENTED_EVENT_BYTES = 128 * 1024;
const MAX_FRAMES_PER_MINUTE = 3_000;
const PageQuery = z
  .object({
    mode: z.enum(['pending', 'history', 'reconciliation']).default('pending'),
    cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    query: z.string().min(1).max(200).optional(),
    unanswered: z.stringbool().optional(),
  })
  .strict();
const ToolCallSchema = z
  .object({ arguments: z.record(z.string(), z.unknown()).default({}) })
  .strict();
/**
 * The agent routes a catalog tool may reach. Owner administration, runtime claims, bootstrap
 * readiness, acknowledgments and checkpoints are deliberately absent: the first are not agent
 * operations, and the bridge keeps the others local for fencing and acknowledgment filtering.
 */
const DISPATCHABLE: readonly [string, RegExp][] = [
  ['GET', /^\/v1\/agents$/],
  ['GET', /^\/v1\/rooms$/],
  ['POST', /^\/v1\/rooms$/],
  ['PUT', /^\/v1\/rooms\/[a-z][a-z0-9_-]{0,47}\/members$/],
  ['PATCH', /^\/v1\/rooms\/[a-z][a-z0-9_-]{0,47}\/members$/],
  ['DELETE', /^\/v1\/rooms\/[a-z][a-z0-9_-]{0,47}$/],
  ['GET', /^\/v1\/messages$/],
  ['POST', /^\/v1\/messages$/],
  ['PUT', /^\/v1\/owner-requests$/],
  ['GET', /^\/v1\/schedules$/],
  ['POST', /^\/v1\/schedules$/],
  ['POST', /^\/v1\/schedules\/cancel$/],
  ['GET', /^\/v1\/context$/],
];
const AttachmentPageQuery = z
  .object({
    cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface ServerOptions {
  database: string;
  adminToken: string;
  host?: string;
  port?: number;
  /** Explicit acknowledgment that a non-loopback listener is behind a TLS terminator. */
  allowRemote?: boolean;
  dispatchIntervalMs?: number;
  storeOptions?: ConstructorParameters<typeof LobbyStore>[1];
  /** The registered tool operations; defaults to this release's catalog. */
  tools?: ToolDefinition<unknown>[];
  /**
   * The push size, from MIN_PUSH_BYTES to MAX_PUSH_BYTES; larger pushes become header-only
   * hints.
   */
  pushBytes?: number;
  /**
   * Upload bytes received at once, across all uploads; at least the largest attachment. Each
   * upload reserves its declared Content-Length before its body is read, and one that does not
   * fit is refused with the retryable `503 uploads_busy`, so concurrent bodies cannot exhaust
   * the broker's memory before any quota check.
   */
  uploadInflightBytes?: number;
  /** How often retention and upload cleanup run. */
  attachmentSweepIntervalMs?: number;
  /**
   * Progress boards (0.4.0) at `<lobby>.<domain>`, and the console, only when a domain is set.
   * Without a GitHub token or an Anthropic key the board still shows live facts and says what is
   * missing.
   */
  board?: Partial<BoardSettings>;
  /**
   * The lobby owner console (0.5.0) at `<origin>/console`. The origin defaults to
   * `https://<board domain>`; without either there is no console. Without a mailer the sign-in
   * page names the missing settings, and everything else works as before.
   */
  console?: {
    origin?: string;
    mailer?: Mailer | null;
    /** The unset settings that sign-in needs, named on its page. */
    missing?: string[];
    responseFloorMs?: number;
  };
}

/** The landing page on the API's own hosts, shipped with the package. */
const LANDING_PAGE = new URL('../site/index.html', import.meta.url);
const LANDING_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export type HostKind = { kind: 'api' } | { kind: 'www' } | { kind: 'board'; label: string };
/** JSON.parse that answers undefined for malformed text instead of throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Which service a Host header names. Every `<label>.<domain>` is a board host for lobby
 * `<label>`, existing or not, except the reserved labels: `www` redirects to the apex and the
 * others (such as `lobby`, an alias of the API) stay on the API. The apex and every host outside
 * the domain are the API.
 */
export function hostKind(host: string | undefined, domain: string): HostKind {
  if (!domain || !host || host.startsWith('[')) return { kind: 'api' };
  const name = host.toLowerCase().replace(/:\d+$/u, '').replace(/\.$/u, '');
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return { kind: 'api' };
  const label = name.slice(0, -suffix.length);
  if (label === 'www') return { kind: 'www' };
  if ((RESERVED_LOBBY_IDS as readonly string[]).includes(label)) return { kind: 'api' };
  return { kind: 'board', label };
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
  /** Replace the registered tools and announce changed catalog revisions to bridges. */
  setTools(tools: ToolDefinition<unknown>[]): void;
}

interface Peer {
  agentId: string;
  auth: RuntimeAuth;
  socket: WebSocket;
  /** The catalog revision last announced on this socket. */
  catalogRevision?: string;
  alive: boolean;
  frames: number;
  frameWindow: number;
}

interface Actor {
  owner: boolean;
  agentId: string;
  token: string;
}
/** One API operation, from HTTP or from a dispatched tool; both run the same handler. */
interface RouteRequest {
  method: string;
  url: URL;
  auth: Actor;
  /**
   * The lobby the request acts in: an agent's own, or the one the owner names with ?lobby=,
   * else the broker's only lobby (0.8.3). Resolved only by routes that act in one lobby, so
   * listing and creating lobbies work with none or several.
   */
  lobby(): string;
  /** The Host the caller reached this broker by. */
  host: string | null;
  body(): Promise<unknown>;
  /** A binary upload body of at most `limit` bytes, within the in-flight upload budget. */
  rawBody(limit: number): Promise<Buffer>;
  /** The caller's current runtime binding; throws unless it is current. */
  runtime(): RuntimeAuth;
}
interface RouteResult {
  status: number;
  value: unknown;
  /** Run the dispatch loop soon: deliveries or readiness changed. */
  dispatch?: boolean;
  /** A stored file to stream as the response body. */
  raw?: { path: string; size: number; headers: Record<string, string> };
}

/** Whether a bridge's upgrade asks for the event version this broker sends. */
function currentBridge(request: IncomingMessage): boolean {
  const value = request.headers[EVENT_VERSION_HEADER];
  return typeof value === 'string' && /^\d{1,3}$/.test(value) && Number(value) >= EVENT_VERSION;
}

const compactAttachments = <T extends { attachments?: EventAttachment[] }>(value: T): T =>
  value.attachments
    ? {
        ...value,
        attachments: value.attachments.map(({ id, filename, mime_type, size }) => ({
          id,
          filename,
          mime_type,
          size,
        })),
      }
    : value;
const NULLABLE_KEYS = ['kind', 'reply_expected'];
const pick = (value: object, keys: readonly string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(
      // Events omit an unset kind or reply expectation: adapters accept them only as absent.
      ([key, field]) => keys.includes(key) && !(field === null && NULLABLE_KEYS.includes(key)),
    ),
  );
/** Fields outside the top-level lists, bounded; the rest stays readable through message reads. */
function extensionsOf(value: object, known: readonly string[]): Record<string, unknown> | null {
  const extensions: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (known.includes(key) || key === 'deliveries' || field === undefined) continue;
    if (!ExtensionKey.safeParse(key).success) continue;
    if (Object.keys(extensions).length >= MAX_EXTENSION_KEYS) break;
    if (Buffer.byteLength(JSON.stringify({ ...extensions, [key]: field })) > MAX_EXTENSION_BYTES)
      continue;
    extensions[key] = field;
  }
  return Object.keys(extensions).length ? extensions : null;
}
function envelope(value: object, known: readonly string[], presentation?: object): object {
  const extensions = extensionsOf(
    compactAttachments(value as { attachments?: EventAttachment[] }),
    known,
  );
  return {
    ...pick(value, known),
    ...(extensions ? { extensions } : {}),
    ...(presentation ? { presentation } : {}),
  };
}

/**
 * Shape an event for its bridge: the message fields the bridge knows, newer
 * fields under `extensions`, and a presentation composed from attributed fields. It stays within
 * the bridge's frame ceiling.
 */
export function wireEvent(event: LobbyEvent, retentionDays?: number): object {
  if (event.type === 'receipts')
    return {
      ...event,
      receipts: event.receipts.map((receipt) => envelope(receipt, RECEIPT_KEYS)),
      presentation: presentReceipts(event.receipts, event.remaining),
    };
  const { covered, covered_count, ...rest } = event;
  const shape = (withPresentation: boolean) => ({
    ...rest,
    messages: event.messages.map((message) =>
      envelope(
        message,
        MESSAGE_KEYS,
        withPresentation ? presentMessage(message, retentionDays) : undefined,
      ),
    ),
    ...(covered === undefined
      ? {}
      : {
          covered: covered.map((header) =>
            envelope(
              header,
              HEADER_KEYS,
              withPresentation ? presentMessage(header, retentionDays) : undefined,
            ),
          ),
          covered_count,
        }),
  });
  const full = shape(true);
  // Presentations can take a large event past the bridge's frame; it then renders them itself.
  // Without them every event fits: a push is bounded by the push size, a hint by its twenty
  // headers with bounded extensions.
  return Buffer.byteLength(JSON.stringify(full)) <= MAX_PRESENTED_EVENT_BYTES ? full : shape(false);
}

function runtimeHeaders(request: IncomingMessage): RuntimeAuth {
  const runtime_id = request.headers['x-pocolobby-runtime-id'];
  const generation = request.headers['x-pocolobby-generation'];
  const incarnation = request.headers['x-pocolobby-incarnation'];
  if (
    typeof runtime_id !== 'string' ||
    typeof generation !== 'string' ||
    typeof incarnation !== 'string' ||
    !/^\d+$/.test(generation) ||
    !Number.isSafeInteger(Number(generation))
  ) {
    throw new LobbyError(
      409,
      'runtime_required',
      'Claim a runtime and supply its current binding headers.',
    );
  }
  return { runtime_id, generation: Number(generation), incarnation };
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value || !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(value)) {
    throw new LobbyError(401, 'unauthorized', 'A valid Bearer credential is required.');
  }
  return value.slice(7);
}

function equalToken(left: string, right: Buffer): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), right);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function errorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof LobbyError)
    return {
      status: error.status,
      body: { error: { ...error.details, code: error.code, message: error.message } },
    };
  // A malformed percent-escape in a path segment is the client's mistake, not ours.
  if (error instanceof URIError)
    return {
      status: 400,
      body: { error: { code: 'invalid_request', message: 'The path has a malformed escape.' } },
    };
  if (error instanceof ZodError)
    return {
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: error.issues
            .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
            .join('; '),
        },
      },
    };
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'The request failed. No success is implied; retry sends with the same request ID.',
      },
    },
  };
}

/** Read a request body of at most `limit` bytes; a longer one is refused and not kept. */
function readBody(
  request: IncomingMessage,
  limit: number,
  tooLarge: () => LobbyError,
  interrupted: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (error?: LobbyError) => {
      if (settled) return;
      settled = true;
      // The request keeps its listener, and so this array, until the response ends: empty it,
      // or every admitted body is held twice while it is stored.
      const body = error ? null : Buffer.concat(chunks, size);
      chunks.length = 0;
      if (body) resolve(body);
      else reject(error);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) settle(tooLarge());
      else chunks.push(chunk);
    });
    request.on('end', () => settle());
    const abort = () => settle(new LobbyError(400, 'request_aborted', interrupted));
    request.on('error', abort);
    request.on('aborted', abort);
  });
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    request.resume();
    throw new LobbyError(415, 'content_type', 'Use application/json.');
  }
  const tooLarge = () => new LobbyError(413, 'body_too_large', 'Request exceeds 256 KiB.');
  if (Number(request.headers['content-length']) > MAX_BODY) {
    request.resume();
    throw tooLarge();
  }
  const bytes = await readBody(request, MAX_BODY, tooLarge, 'Request body was interrupted.');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LobbyError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

/**
 * A binary body for an upload, refused beyond `limit` bytes. `admit` reserves its declared
 * length before any of it is read, or throws; a refused body is drained, not kept.
 */
async function rawBody(
  request: IncomingMessage,
  limit: number,
  admit: (bytes: number) => void,
): Promise<Buffer> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/octet-stream') {
    request.resume();
    throw new LobbyError(415, 'content_type', 'Upload with application/octet-stream.');
  }
  const tooLarge = () =>
    new LobbyError(
      413,
      'attachment_too_large',
      `The upload exceeds ${formatBytes(limit)}, the largest attachment this broker accepts. Nothing was stored.`,
    );
  // Node has already checked the header's form; chunked bodies have none.
  const declared = request.headers['content-length'];
  if (declared === undefined) {
    request.resume();
    throw new LobbyError(411, 'length_required', 'Upload with a Content-Length header.');
  }
  if (Number(declared) > limit) {
    request.resume();
    throw tooLarge();
  }
  try {
    admit(Number(declared));
  } catch (error) {
    request.resume();
    throw error;
  }
  return await readBody(request, limit, tooLarge, 'Upload was interrupted.');
}

/** Single-process broker. All durable mutations are owned by LobbyStore transactions. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(options.adminToken))
    throw new Error(
      'Admin token must be 32–512 URL-safe characters. Generate a random token with pocolobby init.',
    );
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !options.allowRemote)
    throw new Error('Remote listeners require --allow-remote and a TLS reverse proxy.');
  let tools = options.tools ?? defaultTools();
  validateTools(tools);
  const pushBytes = options.pushBytes ?? DEFAULT_PUSH_BYTES;
  if (!Number.isSafeInteger(pushBytes) || pushBytes < MIN_PUSH_BYTES || pushBytes > MAX_PUSH_BYTES)
    throw new Error(`The push size must be between ${MIN_PUSH_BYTES} and ${MAX_PUSH_BYTES} bytes.`);
  const uploadBudget = options.uploadInflightBytes ?? DEFAULT_UPLOAD_INFLIGHT_BYTES;
  const largestUpload = Math.max(
    options.storeOptions?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    options.storeOptions?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
  );
  // A smaller budget would refuse the largest legal upload forever, as if it were retryable.
  if (!Number.isSafeInteger(uploadBudget) || uploadBudget < largestUpload)
    throw new Error(
      `The in-flight upload budget must be at least the largest attachment, ${largestUpload} bytes.`,
    );
  const landing = readFileSync(fileURLToPath(LANDING_PAGE));
  const unlock = acquireDatabaseLock(options.database);
  let store: LobbyStore;
  try {
    store = new LobbyStore(options.database, options.storeOptions);
  } catch (error) {
    unlock();
    throw error;
  }
  const adminHash = createHash('sha256').update(options.adminToken).digest();
  const peers = new Map<string, Peer>();
  const sockets = new Set<Socket>();
  const requestRates = new Map<string, { start: number; count: number }>();
  let closed = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  // Tell the bridge which event version it gets.
  wss.on('headers', (headers) => headers.push(`X-PocoLobby-Event-Version: ${EVENT_VERSION}`));

  const clock = options.storeOptions?.now ?? Date.now;
  // Boards and the console exist only where the operator names a domain for them.
  const boardDomain = (options.board?.domain ?? '').toLowerCase();
  const board = new BoardService(
    store,
    { ...options.board, domain: boardDomain },
    (lobby, agent) => peers.has(qualifyAgent(lobby, agent)),
    clock,
  );
  const signInKeys = new SignInKeys(options.adminToken);
  const consoleOrigin =
    options.console?.origin ?? (boardDomain ? `https://${boardDomain}` : undefined);
  const consoleUi = consoleOrigin
    ? createConsole(
        {
          origin: consoleOrigin,
          mailer: options.console?.mailer ?? null,
          missing: options.console?.mailer
            ? []
            : (options.console?.missing ?? ['POSTMARK_TOKEN', 'POCOLOBBY_MAIL_FROM']),
          responseFloorMs: options.console?.responseFloorMs,
        },
        {
          store,
          board,
          keys: signInKeys,
          boardDomain,
          clientAddress: (request) => clientAddress(request),
          overRate: (key) => overRate(key),
          isConnected: (lobby, agent) => peers.has(qualifyAgent(lobby, agent)),
          closeAgents: (principals) => {
            for (const id of principals) closePeer(id, 4401, 'Lobby deleted');
          },
          refreshBoards: (lobby) => setImmediate(() => void board.request(lobby)),
          github: Boolean(options.board?.githubToken),
          anthropic: Boolean(options.board?.summaryClient ?? options.board?.anthropicApiKey),
          clock,
        },
      )
    : null;

  /** Whether this client is over the request rate; one budget for API and board requests. */
  function overRate(key: string): boolean {
    const now = Date.now();
    const existing = requestRates.get(key);
    if (!existing || now - existing.start > 60_000) {
      if (!existing && requestRates.size >= 1024)
        requestRates.delete(requestRates.keys().next().value!);
      requestRates.set(key, { start: now, count: 1 });
      return false;
    }
    return ++existing.count > 1200;
  }

  function checkRequest(request: IncomingMessage): URL {
    if (request.headers.origin)
      throw new LobbyError(
        403,
        'origin_not_allowed',
        'Browser origins are not enabled on this API.',
      );
    const url = new URL(request.url ?? '/', 'http://lobby.invalid');
    if (url.searchParams.has('token') || url.searchParams.has('access_token'))
      throw new LobbyError(
        400,
        'credential_location',
        'Credentials belong in the Authorization header.',
      );
    // Behind a proxy every client shares the socket address; the trusted header tells them apart.
    if (overRate(clientAddress(request)))
      throw new LobbyError(429, 'request_rate_limit', 'Too many requests; wait before retrying.');
    return url;
  }

  /**
   * The client's address, the key of every per-client limit: the configured proxy header when
   * set, else the socket's. An IPv6 client is keyed by its /64, which one household or server
   * holds whole, so it cannot walk through the limits address by address.
   */
  function clientAddress(request: IncomingMessage): string {
    const header = options.board?.clientIpHeader;
    const value = header ? request.headers[header.toLowerCase()] : undefined;
    const address =
      typeof value === 'string' && value.trim()
        ? value.split(',')[0]!.trim()
        : (request.socket.remoteAddress ?? 'unknown');
    return clientKey(address);
  }

  /**
   * Requests on a board host: only the board's own routes. Everything else, including every API
   * route, is 404 here; Authorization is never read and the viewer cookie opens nothing else.
   */
  async function boardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    label: string,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://board.invalid').pathname;
    const nonce = randomBytes(16).toString('base64');
    const send = (
      status: number,
      type: string,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on the login form.
        'referrer-policy': 'same-origin',
        'content-security-policy': type.startsWith('text/html')
          ? boardCsp(nonce)
          : "default-src 'none'; frame-ancestors 'none'",
        ...headers,
      });
      response.end(method === 'HEAD' ? undefined : body);
    };
    const html = 'text/html; charset=utf-8';
    const redirect = (location: string, headers: Record<string, string> = {}) =>
      send(303, 'text/plain; charset=utf-8', '', { location, ...headers });
    if (overRate(clientAddress(request))) {
      send(429, 'text/plain; charset=utf-8', 'Too many requests; wait a minute.', {
        'retry-after': '60',
      });
      return;
    }
    const picture = mascotFile(path);
    if ((method === 'GET' || method === 'HEAD') && picture) {
      response.writeHead(200, { ...MASCOT_HEADERS, 'content-length': String(picture.length) });
      response.end(method === 'HEAD' ? undefined : picture);
      return;
    }
    const icon = iconFile(path);
    if ((method === 'GET' || method === 'HEAD') && icon) {
      response.writeHead(200, icon.headers);
      response.end(method === 'HEAD' ? undefined : icon.body);
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && path === '/healthz') {
      store.healthy();
      send(
        200,
        'application/json; charset=utf-8',
        JSON.stringify({ status: 'ok', protocol_version: PROTOCOL_VERSION }),
      );
      return;
    }
    // A label that cannot be a lobby, a lobby that does not exist and a private board without a
    // session all go to the console's sign-in, so labels reveal nothing.
    const lobby = LobbyId.safeParse(label).success ? label : null;
    const visibility = lobby === null ? null : store.boardVisibility(lobby);
    const token = cookieToken(request.headers.cookie, BOARD_COOKIE);
    const session =
      visibility === 'private' && token !== null
        ? store.boardSession(lobby!, tokenHash(token))
        : null;
    const viewer = session?.email ?? null;
    // A session in use is extended once a day, with its cookie.
    const extended: Record<string, string> = {};
    if (session?.refresh) {
      store.refreshBoardSession(tokenHash(token!));
      extended['set-cookie'] = sessionCookie(BOARD_COOKIE, token!);
    }
    const open = visibility === 'public' || viewer !== null;
    const signIn = consoleUi?.openUrl(label) ?? null;
    const notice = (status: number, text: string, headers: Record<string, string> = {}) =>
      signIn
        ? send(status, html, renderBoardNotice(label, nonce, text, signIn), headers)
        : send(404, 'text/plain; charset=utf-8', 'Not found.');
    // Forms must come from this board's own page: the full origin, not just SameSite.
    const scheme =
      request.headers['x-forwarded-proto'] === 'https' || options.allowRemote ? 'https' : 'http';
    const sameOrigin = request.headers.origin === `${scheme}://${request.headers.host}`;
    const own = open ? store.boardIcon(lobby!) : null;
    if ((method === 'GET' || method === 'HEAD') && path === '/') {
      // A visit is what brings a board up to date; nothing refreshes boards nobody opens.
      if (open) void board.request(lobby!);
      if (open)
        send(
          200,
          html,
          renderBoardPage(board.view(lobby!), nonce, viewer, own && iconVersion(own.sha256)),
          extended,
        );
      else if (signIn) redirect(signIn);
      else send(404, 'text/plain; charset=utf-8', 'Not found.');
      return;
    }
    // The lobby's own icon, for those who may open its board. Its page links it by content
    // version, so that address never changes meaning and can be kept a year.
    if ((method === 'GET' || method === 'HEAD') && path === '/icon.png') {
      if (!own) {
        send(404, 'text/plain; charset=utf-8', 'Not found.');
        return;
      }
      const versioned =
        new URL(request.url ?? '/', 'http://board.invalid').searchParams.get('v') ===
        iconVersion(own.sha256);
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(own.png.length),
        'cache-control': versioned
          ? `${visibility === 'public' ? 'public' : 'private'}, max-age=31536000, immutable`
          : 'private, no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        ...extended,
      });
      response.end(method === 'HEAD' ? undefined : own.png);
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && path === '/board.json') {
      if (!open)
        send(
          401,
          'application/json; charset=utf-8',
          JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in to the board.' } }),
        );
      else {
        void board.request(lobby!);
        const view = board.view(lobby!);
        send(
          200,
          'application/json; charset=utf-8',
          JSON.stringify({
            generated_at: view.generated_at,
            activity: view.activity,
            html: renderBoardBody(view, viewer),
          }),
          extended,
        );
      }
      return;
    }
    if (method === 'GET' && path === '/handoff') {
      // The console's single-use hand-off becomes this host's own session cookie.
      const handoff = new URL(request.url ?? '/', 'http://board.invalid').searchParams.get('token');
      const issued = newSessionToken();
      if (
        lobby !== null &&
        handoff !== null &&
        /^[A-Za-z0-9_-]{43}$/u.test(handoff) &&
        store.consumeHandoff(
          lobby,
          tokenHash(handoff),
          tokenHash(issued),
          token === null ? null : tokenHash(token),
        )
      )
        redirect('/', { 'set-cookie': sessionCookie(BOARD_COOKIE, issued) });
      else notice(400, 'That sign-in link has expired or was already used.');
      return;
    }
    if (method === 'POST' && path === '/logout') {
      request.resume();
      if (!sameOrigin) {
        send(403, 'text/plain; charset=utf-8', 'Sign out from the board page.');
        return;
      }
      if (token) store.endBoardSession(tokenHash(token));
      notice(200, 'You are signed out of this board.', {
        'set-cookie': sessionCookie(BOARD_COOKIE, null),
      });
      return;
    }
    request.resume();
    send(404, 'text/plain; charset=utf-8', 'Not found.');
  }

  function actor(request: IncomingMessage): Actor {
    const token = bearer(request);
    if (equalToken(token, adminHash)) return { owner: true, agentId: 'owner', token };
    return { owner: false, agentId: store.authenticate(token), token };
  }

  function currentRuntime(request: IncomingMessage, auth: Actor): RuntimeAuth {
    // Body reads yield: a credential may be revoked while an upload is still arriving.
    if (store.authenticate(auth.token) !== auth.agentId)
      throw new LobbyError(401, 'unauthorized', 'Credential revoked.');
    const runtime = runtimeHeaders(request);
    store.assertRuntime(auth.agentId, runtime);
    return runtime;
  }

  /** Declared bytes of the uploads being received now; bounded by uploadBudget. */
  let uploading = 0;
  function admitUpload(response: ServerResponse, bytes: number): void {
    if (uploading + bytes > uploadBudget)
      throw new LobbyError(
        503,
        'uploads_busy',
        'The broker is receiving as many uploads as it holds at once (POCOLOBBY_UPLOAD_INFLIGHT_BYTES). Nothing was stored; retry in a few seconds.',
      );
    uploading += bytes;
    // Completion, a refusal after the body, an error and an aborted connection all close it.
    response.once('close', () => {
      uploading -= bytes;
    });
  }

  function closePeer(agentId: string, code = 4409, reason = 'Runtime binding changed'): void {
    const peer = peers.get(agentId);
    if (peer) {
      peers.delete(agentId);
      peer.socket.close(code, reason);
    }
  }

  // One line per failure on stderr, never with bodies or headers. A repeat within a minute is
  // skipped, so a failing 250 ms tick cannot flood the log.
  const logged = new Map<string, number>();
  function logFailure(where: string, error: unknown): void {
    const { name, code, message } = (error ?? {}) as {
      name?: string;
      code?: string;
      message?: string;
    };
    const line = `pocolobby: ${where} failed: ${name ?? 'Error'}${code ? ` ${code}` : ''}: ${message ?? String(error)}`;
    const now = Date.now();
    if ((logged.get(line) ?? 0) > now - 60_000) return;
    if (logged.size > 100) logged.clear();
    logged.set(line, now);
    process.stderr.write(`${line}\n`);
  }

  /**
   * Close a peer after a failure. Credential and runtime problems are final for the bridge
   * (4401, 4403, 4409) and a malformed frame is refused (1008); anything else, such as a full
   * disk or too many frames, closes with 1011 so the bridge reconnects once it can. It closes
   * this peer only: a stale socket's late frame must not close the stream that replaced it.
   */
  function failPeer(peer: Peer, error: unknown): void {
    const status = error instanceof LobbyError ? error.status : 500;
    if (status === 500) logFailure('stream', error);
    if (peers.get(peer.agentId) === peer) peers.delete(peer.agentId);
    peer.socket.close(
      status === 401
        ? 4401
        : status === 403
          ? 4403
          : status === 409
            ? 4409
            : status === 400
              ? 1008
              : 1011,
      status === 500
        ? 'Broker operation failed; reconnect'
        : status === 400
          ? 'Invalid transport frame'
          : 'Credential or runtime no longer valid',
    );
  }

  const catalogOf = (agentId: string) =>
    buildCatalog(tools, store.permissions(agentId), {
      maxImageBytes: store.maxImageBytes,
      maxTextBytes: store.maxTextBytes,
    });

  /** Tell a bridge when its catalog changed: tools, wording or permissions. */
  function announceCatalog(peer: Peer): void {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    try {
      const { revision } = catalogOf(peer.agentId);
      if (revision === peer.catalogRevision) return;
      peer.catalogRevision = revision;
      const event: CatalogEvent = { type: 'catalog', revision };
      peer.socket.send(JSON.stringify(event));
    } catch {
      /* The bridge also refreshes on its next reconnect. */
    }
  }

  function dispatch(): void {
    if (closed) return;
    try {
      // Scheduled deliveries and schedule occurrences fall due whether or not anyone is
      // connected. A failure leaves them due, so the next tick retries.
      store.releaseDue();
    } catch (error) {
      // Durable state is unchanged; retried on the next tick.
      logFailure('scheduled delivery', error);
    }
    for (const peer of peers.values()) {
      if (peer.socket.readyState !== WebSocket.OPEN) continue;
      // Each store call checks the runtime; revoking or rotating a credential retires it.
      try {
        if (peer.socket.bufferedAmount > 256 * 1024) {
          peer.socket.terminate();
          continue;
        }
        const event: LobbyEvent | null =
          store.nextNotification(peer.agentId, peer.auth, pushBytes) ??
          store.nextReceipts(peer.agentId, peer.auth);
        if (event)
          peer.socket.send(JSON.stringify(wireEvent(event, store.attachmentRetentionDays)));
      } catch (error) {
        failPeer(peer, error);
      }
    }
  }

  /**
   * Room routes, the same for the owner (under /v1/admin, in the lobby it names) and for an agent
   * (its own lobby, which the store takes from its identity). An agent's changes are fenced by
   * its runtime, read after the body; its list shows the rooms it may see.
   */
  async function roomRoute(
    req: RouteRequest,
    base: string,
    actor: string,
  ): Promise<RouteResult | undefined> {
    const { method, url } = req;
    const path = url.pathname;
    const owner = actor === 'owner';
    const fence = () => {
      if (!owner) req.runtime();
    };
    if (path === base) {
      if (method === 'GET')
        return {
          status: 200,
          value: { rooms: store.rooms(req.lobby(), owner ? undefined : actor) },
        };
      if (method === 'POST') {
        const input = RoomSchema.parse(await req.body());
        fence();
        return { status: 201, value: store.createRoom(actor, input.room_id, req.lobby()) };
      }
      return undefined;
    }
    if (!path.startsWith(`${base}/`)) return undefined;
    const [roomSegment, members, ...extra] = path.slice(base.length + 1).split('/');
    if (!roomSegment || extra.length || (members !== undefined && members !== 'members'))
      return undefined;
    const roomId = RoomId.parse(decodeURIComponent(roomSegment));
    if (members && method === 'PUT') {
      const input = RoomMembersSchema.parse(await req.body());
      fence();
      return {
        status: 200,
        value: store.setRoomMembers(actor, roomId, input.members, req.lobby()),
        dispatch: true,
      };
    }
    if (members && method === 'PATCH') {
      const input = RoomMemberChangesSchema.parse(await req.body());
      fence();
      return {
        status: 200,
        value: store.changeRoomMembers(actor, roomId, input, req.lobby()),
        dispatch: true,
      };
    }
    if (!members && method === 'DELETE') {
      fence();
      return { status: 200, value: store.deleteRoom(actor, roomId, req.lobby()), dispatch: true };
    }
    return undefined;
  }

  async function route(req: RouteRequest): Promise<RouteResult> {
    const { method, auth } = req;
    const path = req.url.pathname;
    if (path.startsWith('/v1/admin/')) {
      if (!auth.owner)
        throw new LobbyError(403, 'owner_required', 'Owner credentials are required.');
      if (path === '/v1/admin/lobbies') {
        if (method === 'GET') return { status: 200, value: { lobbies: store.lobbies() } };
        if (method === 'POST') {
          const input = LobbySchema.parse(await req.body());
          return { status: 201, value: store.createLobby(input.lobby_id) };
        }
      }
      // A lobby's display name (0.8.2): { display_name }, empty to show its ID again.
      const named = /^\/v1\/admin\/lobbies\/([^/]+)$/.exec(path);
      if (named && method === 'PATCH') {
        const input = z
          .object({ display_name: z.string().max(200).nullable() })
          .strict()
          .parse(await req.body());
        return {
          status: 200,
          value: store.setDisplayName(
            'owner',
            LobbyId.parse(decodeURIComponent(named[1]!)),
            input.display_name ?? '',
          ),
        };
      }
      // The owner sees attachment metadata and usage; content stays with uploader and recipients.
      if (path === '/v1/admin/attachments' && method === 'GET')
        return {
          status: 200,
          value: store.attachments(
            req.lobby(),
            AttachmentPageQuery.parse(
              Object.fromEntries([...req.url.searchParams].filter(([key]) => key !== 'lobby')),
            ),
          ),
        };
      if (path === '/v1/admin/attachments/usage' && method === 'GET')
        return { status: 200, value: store.attachmentUsage(req.lobby()) };
      if (path.startsWith('/v1/admin/board')) {
        if (!store.hasLobby(req.lobby()))
          throw new LobbyError(404, 'lobby_not_found', 'Unknown lobby');
        if (path === '/v1/admin/board' && method === 'GET')
          return { status: 200, value: board.status(req.lobby()) };
        const source = /^\/v1\/admin\/board\/sources\/([^/]+)$/.exec(path);
        if (source && method === 'PUT') {
          const config = store.setBoardSource(
            req.lobby(),
            RoomId.parse(decodeURIComponent(source[1]!)),
            (await req.body()) as BoardSourceInput,
            'owner',
          );
          setImmediate(() => void board.request(req.lobby()));
          return { status: 200, value: config };
        }
        if (source && method === 'DELETE')
          return {
            status: 200,
            value: store.removeBoardSource(
              req.lobby(),
              RoomId.parse(decodeURIComponent(source[1]!)),
              'owner',
            ),
          };
        if (path === '/v1/admin/board/agents' && method === 'PUT')
          return {
            status: 200,
            value: store.setBoardAgents(req.lobby(), BoardAgentsSchema.parse(await req.body())),
          };
        if (path === '/v1/admin/board/icon' && method === 'PUT') {
          const { png } = BoardIconSchema.parse(await req.body());
          return {
            status: 200,
            value: store.setBoardIcon('owner', req.lobby(), Buffer.from(png, 'base64')),
          };
        }
        if (path === '/v1/admin/board/icon' && method === 'DELETE')
          return { status: 200, value: store.setBoardIcon('owner', req.lobby(), null) };
      }
      // The console's accounts, owners and approved repositories (0.5.0).
      if (path === '/v1/admin/console/accounts') {
        if (method === 'GET') return { status: 200, value: { accounts: store.accounts() } };
        if (method === 'POST') {
          const input = AccountSettingsSchema.parse(await req.body());
          return { status: 200, value: store.setAccount(input, signInKeys.emailKey(input.email)) };
        }
      }
      if (path === '/v1/admin/console/owner') {
        if (method === 'PUT')
          return {
            status: 200,
            value: store.grantLobby(OwnerSchema.parse(await req.body()).email, req.lobby()),
          };
      }
      if (path === '/v1/admin/console/owner/revoke' && method === 'POST')
        return {
          status: 200,
          value: store.ungrantLobby(OwnerSchema.parse(await req.body()).email, req.lobby()),
        };
      if (path === '/v1/admin/console/repos') {
        if (method === 'GET')
          return {
            status: 200,
            value: { lobby_id: req.lobby(), repos: store.lobbyRepos(req.lobby()) },
          };
        if (method === 'POST') {
          const { repo } = z
            .object({ repo: RepoName })
            .strict()
            .parse(await req.body());
          return {
            status: 200,
            value: { lobby_id: req.lobby(), repos: store.approveRepo(req.lobby(), repo) },
          };
        }
      }
      const repo = /^\/v1\/admin\/console\/repos\/([^/]+)\/([^/]+)$/.exec(path);
      if (repo && method === 'DELETE')
        return {
          status: 200,
          value: {
            lobby_id: req.lobby(),
            repos: store.removeRepo(
              req.lobby(),
              `${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`,
            ),
          },
        };
      const ownerRooms = await roomRoute(req, '/v1/admin/rooms', 'owner');
      if (ownerRooms) return ownerRooms;
      if (path === '/v1/admin/agents') {
        if (method === 'GET')
          return {
            status: 200,
            value: {
              agents: store.agents(req.lobby()).map((agent) => ({
                ...agent,
                connected: peers.has(qualifyAgent(agent.lobby_id, agent.agent_id)),
              })),
            },
          };
        if (method === 'POST') {
          const input = ProvisionSchema.parse(await req.body());
          if (
            input.lobby_id !== undefined &&
            req.url.searchParams.has('lobby') &&
            input.lobby_id !== req.lobby()
          )
            throw new LobbyError(
              400,
              'lobby_mismatch',
              'Provisioning lobby must match the administrative selector.',
            );
          return {
            status: 201,
            value: store.provision({ ...input, lobby_id: input.lobby_id ?? req.lobby() }),
          };
        }
      }
      const match =
        /^\/v1\/admin\/agents\/([^/]+)(?:\/(rotate|reset-runtime|retry|messages|context|schedules|schedules\/cancel))?$/.exec(
          path,
        );
      if (match) {
        const id = qualifyAgent(req.lobby(), AgentId.parse(decodeURIComponent(match[1]!)));
        const action = match[2];
        if (!action && method === 'PATCH') {
          const input = UpdateAgentSchema.parse(await req.body());
          const result = store.updateAgent(id, input);
          if (input.enabled === false) closePeer(id, 4403, 'Agent disabled');
          // A permission change can change which tools the agent's catalog offers.
          const peer = peers.get(id);
          if (peer) announceCatalog(peer);
          return { status: 200, value: result, dispatch: true };
        }
        if (action === 'messages' && method === 'GET')
          return {
            status: 200,
            value: store.messages(id, {
              ...PageQuery.parse(
                Object.fromEntries([...req.url.searchParams].filter(([key]) => key !== 'lobby')),
              ),
              includeHeldContent: true,
            }),
          };
        if (action === 'context' && method === 'GET')
          return { status: 200, value: store.context(id) };
        // The owner can review any agent's schedules, or its own (agent ID "owner"), and
        // cancel them, for example a runaway schedule of a retired agent.
        if (action === 'schedules' && method === 'GET')
          return { status: 200, value: store.scheduled(id) };
        if (action === 'schedules/cancel' && method === 'POST') {
          const input = CancelScheduledSchema.parse(await req.body());
          return { status: 200, value: store.cancelScheduled(id, null, input.id) };
        }
        if (method === 'POST' && ['rotate', 'reset-runtime', 'retry'].includes(action ?? '')) {
          z.object({})
            .strict()
            .parse(await req.body());
          if (action === 'rotate') {
            const result = store.rotateToken(id);
            closePeer(id, 4401, 'Credential rotated');
            return { status: 200, value: result };
          }
          if (action === 'reset-runtime') {
            store.resetRuntime(id);
            closePeer(id);
          }
          if (action === 'retry') store.retryNotifications(id);
          return { status: 200, value: { ok: true }, dispatch: true };
        }
      }
    } else if (path === '/v1/agents' && method === 'GET') {
      // Discovery lists only enabled identities; the owner's admin listing shows all.
      return {
        status: 200,
        value: {
          agents: store
            .agents(req.lobby())
            .filter((agent) => agent.enabled)
            .map((agent) => ({
              agent_id: agent.agent_id,
              lobby_id: agent.lobby_id,
              connected: peers.has(qualifyAgent(agent.lobby_id, agent.agent_id)),
              enabled: agent.enabled,
              paused: agent.paused,
              ready: agent.ready,
              last_seen_at: agent.last_seen_at,
              last_agent_seen_at: agent.last_agent_seen_at,
              notification_attention_required: agent.notification_attention_required,
              // Aggregates only: no message IDs, senders or rooms.
              unseen_notified_count: agent.unseen_notified_count,
              oldest_unseen_notified_at: agent.oldest_unseen_notified_at,
              last_message_at: agent.last_message_at,
              // What it waits on from the owner, so a coordinator asked "anything for me?" can answer
              // for the whole lobby.
              owner_requests: agent.owner_requests,
              // Its Claude plan from its status line, and its week's pace, for the coordinator's pacing.
              usage: board.agentUsage(agent.lobby_id, agent.agent_id),
            })),
        },
      };
    } else if (path === '/v1/messages' && method === 'POST') {
      const input = SendSchema.parse(await req.body());
      if (!auth.owner) req.runtime();
      return { status: 200, value: store.send(auth.agentId, input, req.lobby()), dispatch: true };
    } else {
      if (auth.owner)
        throw new LobbyError(
          403,
          'agent_required',
          'Use an agent credential or the owner administrative route.',
        );
      const agentRooms = await roomRoute(req, '/v1/rooms', auth.agentId);
      if (agentRooms) return agentRooms;
      if (path === '/v1/runtime' && method === 'POST') {
        const input = RuntimeSchema.parse(await req.body());
        store.authenticate(auth.token);
        const binding = store.claimRuntime(auth.agentId, input.runtime_id, input.generation);
        const peer = peers.get(auth.agentId);
        if (peer && peer.auth.generation !== binding.generation)
          closePeer(auth.agentId, 4409, 'Runtime resumed by a newer process');
        return { status: 200, value: binding };
      }
      if (path === '/v1/context' && method === 'GET') {
        // The current operations, where the model reads them fresh.
        const catalog = catalogOf(auth.agentId);
        const context: AgentContext = {
          ...store.context(auth.agentId),
          tool_guide: toolGuide(catalog.tools, catalog.revision),
          // Which broker answered, as this bridge reached it.
          broker: { host: req.host, version: PACKAGE_VERSION },
        };
        return { status: 200, value: context };
      }
      const upload = /^\/v1\/attachments\/([0-9a-f]{64})$/.exec(path);
      if (upload && method === 'PUT') {
        const runtime = req.runtime();
        const bytes = await req.rawBody(Math.max(store.maxImageBytes, store.maxTextBytes));
        return {
          status: 200,
          value: store.uploadAttachment(auth.agentId, runtime, upload[1]!, bytes),
        };
      }
      const attachment =
        /^\/v1\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/content)?$/.exec(
          path,
        );
      if (attachment && method === 'GET' && !req.url.search) {
        if (!attachment[2])
          return { status: 200, value: store.attachment(auth.agentId, attachment[1]!) };
        const { info, path: file, size } = store.attachmentFile(auth.agentId, attachment[1]!);
        return {
          status: 200,
          value: null,
          raw: {
            path: file,
            size,
            headers: {
              'content-type': 'application/octet-stream',
              'content-disposition': 'attachment',
              'x-pocolobby-sha256': info.sha256,
              'x-pocolobby-mime-type': info.mime_type,
              'x-pocolobby-filename': encodeURIComponent(info.filename),
            },
          },
        };
      }
      if (path === '/v1/messages' && method === 'GET')
        return {
          status: 200,
          value: store.messages(
            auth.agentId,
            PageQuery.parse(Object.fromEntries(req.url.searchParams)),
          ),
        };
      if (path === '/v1/acknowledgments' && method === 'POST') {
        const input = AckSchema.parse(await req.body());
        return {
          status: 200,
          value: store.acknowledge(auth.agentId, req.runtime(), input.message_ids),
        };
      }
      if (path === '/v1/schedules') {
        if (method === 'GET') return { status: 200, value: store.scheduled(auth.agentId) };
        if (method === 'POST') {
          const input = ScheduleSchema.parse(await req.body());
          return {
            status: 200,
            value: store.createSchedule(auth.agentId, req.runtime(), input),
          };
        }
      }
      if (path === '/v1/schedules/cancel' && method === 'POST') {
        const input = CancelScheduledSchema.parse(await req.body());
        return {
          status: 200,
          value: store.cancelScheduled(auth.agentId, req.runtime(), input.id),
        };
      }
      if (path === '/v1/checkpoint' && method === 'PUT') {
        const input = CheckpointSchema.parse(await req.body());
        return { status: 200, value: store.checkpoint(auth.agentId, req.runtime(), input) };
      }
      if (path === '/v1/usage' && method === 'PUT') {
        // From the agent's Claude Code status line, which holds its credential but no runtime: a
        // reading of the account it runs on, not an action in the lobby.
        const input = UsageReportSchema.parse(await req.body());
        store.authenticate(auth.token);
        board.recordUsage(auth.agentId, input);
        return { status: 200, value: { recorded: true } };
      }
      if (path === '/v1/owner-requests' && method === 'PUT') {
        const input = OwnerRequestsSchema.parse(await req.body());
        const requests = store.setOwnerRequests(auth.agentId, req.runtime(), input);
        return { status: 200, value: { owner_requests: requests } };
      }
      if (path === '/v1/ready' && method === 'POST') {
        const input = ReadySchema.parse(await req.body());
        store.ready(auth.agentId, req.runtime(), input);
        return { status: 200, value: { ready: true }, dispatch: true };
      }
    }
    throw new LobbyError(404, 'not_found', 'Unknown API route.');
  }

  /**
   * The operations a dispatched tool reaches: the same route handlers as HTTP, restricted to
   * the agent routes above, with the calling bridge's credential and runtime headers. No other
   * origin, path or principal is reachable, and no owner operation.
   */
  function toolContext(outer: RouteRequest): ToolContext {
    return {
      async call<T>(method: string, path: string, value?: unknown): Promise<T> {
        const url = new URL(path, 'http://operation.invalid');
        if (
          url.origin !== 'http://operation.invalid' ||
          !path.startsWith('/v1/') ||
          path.includes('..') ||
          path.includes('\\') ||
          url.hash ||
          (url.search && !(method === 'GET' && url.pathname === '/v1/messages')) ||
          !DISPATCHABLE.some(
            ([allowed, pattern]) => allowed === method && pattern.test(url.pathname),
          )
        )
          throw new LobbyError(
            403,
            'operation_not_dispatchable',
            'A tool may only run registered agent operations.',
          );
        // A JSON round trip gives the handler exactly what an HTTP body would.
        const copy = value === undefined ? {} : (JSON.parse(JSON.stringify(value)) as unknown);
        const result = await route({
          ...outer,
          method,
          url,
          body: async () => copy,
          rawBody: async () => {
            throw new LobbyError(403, 'operation_not_dispatchable', 'Uploads are not tools.');
          },
        });
        if (result.dispatch) setImmediate(dispatch);
        return result.value as T;
      },
    };
  }

  /** GET /v1/tools and POST /v1/tools/:name; agents only. */
  async function toolRoute(req: RouteRequest): Promise<RouteResult> {
    if (req.auth.owner)
      throw new LobbyError(
        403,
        'agent_required',
        'Tools belong to agents; the owner uses the CLI.',
      );
    const path = req.url.pathname;
    if (path === '/v1/tools' && req.method === 'GET' && !req.url.search)
      return { status: 200, value: catalogOf(req.auth.agentId) };
    const match = /^\/v1\/tools\/([^/]+)$/.exec(path);
    if (match && req.method === 'POST' && !req.url.search) {
      const input = ToolCallSchema.parse(await req.body());
      // The body read yields: the credential can have been rotated or disabled meanwhile, so check
      // it again before anything runs with it.
      if (store.authenticate(req.auth.token) !== req.auth.agentId)
        throw new LobbyError(401, 'unauthorized', 'Credential revoked.');
      const name = ToolName.safeParse(decodeURIComponent(match[1]!));
      const tool = name.success ? tools.find((entry) => entry.name === name.data) : undefined;
      if (!tool)
        throw new LobbyError(404, 'unknown_tool', 'This broker offers no tool by that name.');
      if (!permitted(tool, store.permissions(req.auth.agentId)))
        throw new LobbyError(
          403,
          'tool_forbidden',
          `${tool.name} needs a permission this agent does not have.`,
        );
      const args = tool.input.parse(input.arguments);
      return { status: 200, value: { result: await tool.run(toolContext(req), args) } };
    }
    throw new LobbyError(404, 'not_found', 'Unknown API route.');
  }

  const server = createServer(async (request, response) => {
    try {
      // Reached over HTTPS through a proxy such as Fly's edge: browsers keep to HTTPS for a year.
      // Browsers ignore the header over plain HTTP, so a local broker is unaffected.
      if (request.headers['x-forwarded-proto'] === 'https')
        response.setHeader('strict-transport-security', 'max-age=31536000');
      const host = hostKind(request.headers.host, boardDomain);
      if (host.kind === 'www') {
        request.resume();
        response.writeHead(301, {
          location: `https://${boardDomain}${request.url ?? '/'}`,
          'cache-control': 'public, max-age=3600',
        });
        response.end();
        return;
      }
      if (host.kind === 'board') {
        await boardRequest(request, response, host.label);
        return;
      }
      // The console comes before the API's checks, which refuse every browser origin.
      if (
        consoleUi?.handles(new URL(request.url ?? '/', 'http://lobby.invalid').pathname) === true
      ) {
        await consoleUi.handle(request, response);
        return;
      }
      const url = checkRequest(request);
      const method = request.method ?? 'GET';
      const path = url.pathname;
      if (method === 'GET' && path === '/healthz') {
        store.healthy();
        json(response, 200, { status: 'ok', protocol_version: PROTOCOL_VERSION });
        return;
      }
      if ((method === 'GET' || method === 'HEAD') && path === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(landing.length),
          'cache-control': 'public, max-age=300',
          'content-security-policy': LANDING_CSP,
          'x-content-type-options': 'nosniff',
        });
        response.end(method === 'HEAD' ? undefined : landing);
        return;
      }
      const picture = mascotFile(path);
      if ((method === 'GET' || method === 'HEAD') && picture) {
        response.writeHead(200, { ...MASCOT_HEADERS, 'content-length': String(picture.length) });
        response.end(method === 'HEAD' ? undefined : picture);
        return;
      }
      const icon = iconFile(path);
      if ((method === 'GET' || method === 'HEAD') && icon) {
        response.writeHead(200, icon.headers);
        response.end(method === 'HEAD' ? undefined : icon.body);
        return;
      }
      const auth = actor(request);
      if (!auth.owner && (url.searchParams.has('lobby') || url.searchParams.has('lobby_id')))
        throw new LobbyError(
          403,
          'scope_selection_forbidden',
          'Your credential selects your private lobby; it cannot be changed by a request.',
        );
      const named = url.searchParams.get('lobby');
      let lobbyId: string | undefined;
      const req: RouteRequest = {
        method,
        url,
        auth,
        lobby: () =>
          (lobbyId ??= auth.owner
            ? named === null
              ? store.soleLobby()
              : LobbyId.parse(named)
            : parsePrincipal(auth.agentId).lobby_id),
        host: request.headers.host ?? null,
        body: () => body(request),
        rawBody: (limit) => rawBody(request, limit, (bytes) => admitUpload(response, bytes)),
        runtime: () => currentRuntime(request, auth),
      };
      const result =
        path === '/v1/tools' || path.startsWith('/v1/tools/')
          ? await toolRoute(req)
          : await route(req);
      if (result.raw) {
        response.writeHead(result.status, {
          ...result.raw.headers,
          'content-length': String(result.raw.size),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        // Streamed, so a download holds no copy in memory. The bridge checks size and SHA-256,
        // and a file collected meanwhile ends the response short, which it retries.
        // pipeline closes the file when the client goes away; .pipe would leak its descriptor.
        pipeline(createReadStream(result.raw.path), response, () => {});
      } else json(response, result.status, result.value);
      if (result.dispatch) setImmediate(dispatch);
    } catch (error) {
      const result = errorResponse(error);
      if (result.status === 500)
        logFailure(`${request.method} ${request.url?.split('?', 1)[0]}`, error);
      if (!response.headersSent && !response.destroyed) {
        if (result.status === 413) response.setHeader('connection', 'close');
        if (result.status === 429) response.setHeader('retry-after', '60');
        if (result.status === 503) response.setHeader('retry-after', '5');
        json(response, result.status, result.body);
      }
    }
  });
  // Long enough for a 10 MiB upload over a slow uplink; headers still have 10 seconds.
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, socket: Duplex, head) => {
    // Node removes its own error listener before 'upgrade' and ws adds one only in handleUpgrade,
    // so a client that resets the connection while we reject it must not crash the process.
    const dropSocket = () => socket.destroy();
    socket.on('error', dropSocket);
    try {
      if (hostKind(request.headers.host, boardDomain).kind !== 'api')
        throw new LobbyError(404, 'not_found', 'Unknown stream route.');
      const url = checkRequest(request);
      if (url.pathname !== '/v1/events' || url.search)
        throw new LobbyError(404, 'not_found', 'Unknown stream route.');
      if (!currentBridge(request))
        throw new LobbyError(
          426,
          'bridge_outdated',
          'This PocoLobby bridge is older than the broker: install the current package.',
        );
      const auth = actor(request);
      if (auth.owner)
        throw new LobbyError(403, 'agent_required', 'Only an agent can consume an inbox.');
      const runtime = runtimeHeaders(request);
      store.assertRuntime(auth.agentId, runtime);
      socket.off('error', dropSocket);
      wss.handleUpgrade(request, socket, head, (ws) => {
        closePeer(auth.agentId, 4409, 'Connection replaced by the same runtime');
        const peer: Peer = {
          agentId: auth.agentId,
          auth: runtime,
          socket: ws,
          alive: true,
          frames: 0,
          frameWindow: Date.now(),
        };
        peers.set(auth.agentId, peer);
        ws.on('error', () => {}); // Socket errors are followed by close; durable state remains in SQLite.
        ws.on('close', () => {
          if (peers.get(auth.agentId) === peer) peers.delete(auth.agentId);
        });
        ws.on('pong', () => {
          peer.alive = true;
          try {
            store.heartbeat(peer.agentId, peer.auth);
          } catch (error) {
            failPeer(peer, error);
          }
        });
        ws.on('message', (data, isBinary) => {
          try {
            if (Date.now() - peer.frameWindow > 60_000) {
              peer.frames = 0;
              peer.frameWindow = Date.now();
            }
            // Two receipts per event: a busy minute can need hundreds. Past the ceiling the
            // stream closes with 1011 and the bridge reconnects; only a malformed frame is final.
            if (++peer.frames > MAX_FRAMES_PER_MINUTE)
              throw new Error('Too many transport frames in a minute');
            const receipt = isBinary
              ? undefined
              : TransportReceiptSchema.safeParse(parseJson(data.toString())).data;
            if (!receipt) throw new LobbyError(400, 'invalid_frame', 'Invalid transport frame.');
            store.recordTransport(peer.agentId, peer.auth, receipt);
          } catch (error) {
            failPeer(peer, error);
          }
        });
        try {
          store.heartbeat(peer.agentId, peer.auth);
        } catch (error) {
          failPeer(peer, error);
          return;
        }
        announceCatalog(peer);
        setImmediate(dispatch);
      });
    } catch (error) {
      const { status, body } = errorResponse(error);
      const text = JSON.stringify(body);
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
      );
    }
  });

  const dispatchTimer = setInterval(dispatch, options.dispatchIntervalMs ?? 250);
  dispatchTimer.unref();
  const sweep = () => {
    if (closed) return;
    try {
      // Messages first, so attachments they referenced can expire in the same pass.
      store.pruneMessages();
    } catch (error) {
      // Kept a little longer; the next pass removes them.
      logFailure('message sweep', error);
    }
    try {
      store.collectAttachments();
    } catch (error) {
      // Retried on the next pass; nothing is deleted unless its records are gone.
      logFailure('attachment sweep', error);
    }
    try {
      store.pruneSignIn();
    } catch (error) {
      // Expired rows open nothing; the next pass removes them.
      logFailure('sign-in sweep', error);
    }
    try {
      store.pruneAdminEvents();
    } catch (error) {
      // The audit log only takes space; the next pass trims it.
      logFailure('audit sweep', error);
    }
    try {
      store.pruneNotificationAttempts();
    } catch (error) {
      // Old attempts only take space; the next pass removes them.
      logFailure('notification sweep', error);
    }
  };
  const sweepTimer = setInterval(sweep, options.attachmentSweepIntervalMs ?? 60_000);
  sweepTimer.unref();
  setImmediate(sweep);
  const heartbeatTimer = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }, 15_000);
  heartbeatTimer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 8787, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(dispatchTimer);
    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
    wss.close();
    store.close();
    unlock();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not determine listening address.');
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${address.port}`,
    setTools(next) {
      validateTools(next);
      tools = next;
      for (const peer of peers.values()) announceCatalog(peer);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(dispatchTimer);
      clearInterval(heartbeatTimer);
      clearInterval(sweepTimer);
      for (const peer of peers.values()) peer.socket.close(1001, 'Broker restarting');
      const force = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 250);
      force.unref();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const peer of peers.values()) peer.socket.terminate();
      wss.close();
      clearTimeout(force);
      await board.close();
      store.close();
      unlock();
    },
  };
}
