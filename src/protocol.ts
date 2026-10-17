import { z } from 'zod';
import { AttachmentDescriptor, MAX_ATTACHMENTS } from './attachments.js';

export const PROTOCOL_VERSION = 1;
/** Builder reports with tables reach 16,000 characters; 64 KiB leaves room. */
export const MAX_CONTENT_BYTES = 64 * 1024;
/**
 * Bytes per get_messages page as serialized, fields and recipients' facts included. Claude Code
 * caps MCP tool output at 25,000 tokens by default (MAX_MCP_OUTPUT_TOKENS), about 100 KB of
 * text, so a page must stay below that.
 */
export const MAX_PAGE_BYTES = 80 * 1024;
/** The smallest push the broker can be configured to send, and the bound of a receipts event. */
export const MIN_PUSH_BYTES = 8 * 1024;
/**
 * The bridge accepts rendered pushes up to this ceiling, and the broker chooses the effective
 * push size between MIN_PUSH_BYTES and MAX_PUSH_BYTES (default DEFAULT_PUSH_BYTES), so the size
 * can be tuned on the server without a bridge update. A larger push becomes a header-only hint.
 * Claude Code documents no size limit for Channel events; see docs/API.md#push-size.
 */
export const BRIDGE_MAX_PUSH_BYTES = 72 * 1024;
export const DEFAULT_PUSH_BYTES = 32 * 1024;
export const MAX_PUSH_BYTES = 64 * 1024;
export const AgentId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const LobbyId = AgentId;
export const RoomId = AgentId;
/**
 * Subdomain labels of the board domain that are never boards, so never lobby IDs (0.4.0):
 * `knock.pocolobby.com` (0.5.2) is the API's address and `lobby.pocolobby.com` an alias of it,
 * and the others are kept for the service (`console` from 0.5.0). A lobby's console pages sit at
 * /console/<lobby> (0.8.2), so the console's own pages are reserved too: `open`, `sign-in` (and
 * `api`).
 */
export const RESERVED_LOBBY_IDS = [
  'admin',
  'api',
  'app',
  'assets',
  'board',
  'console',
  'knock',
  'lobby',
  'mail',
  'open',
  'pocolobby',
  'sign-in',
  'static',
  'status',
  'www',
] as const;
/**
 * A lobby ID that a new lobby may take (0.5.0): also a DNS label, since its board lives at
 * `<lobby>.<domain>` (letters, digits and inner hyphens), and not reserved. Existing lobbies keep
 * the older identity grammar; the store also refuses the names of deleted lobbies.
 */
export const NewLobbyId = LobbyId.regex(
  /^[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?$/u,
  'Use lowercase letters, digits and inner hyphens, starting with a letter',
).refine(
  (value) => !(RESERVED_LOBBY_IDS as readonly string[]).includes(value),
  'This name is reserved for the service and cannot name a lobby',
);
/**
 * How the console and the board show a lobby, such as My Team for my-team (0.8.2):
 * up to 40 characters with no control characters; empty shows the lobby's ID.
 */
export const DisplayName = z
  .string()
  .trim()
  .max(40, 'Use at most 40 characters')
  .regex(/^[^\p{Cc}]*$/u, 'A display name cannot hold control characters');
export function qualifyAgent(lobbyId: string, agentId: string): string {
  return `${LobbyId.parse(lobbyId)}/${AgentId.parse(agentId)}`;
}
export function parsePrincipal(value: string): { lobby_id: string; agent_id: string } {
  const parts = value.split('/');
  if (parts.length !== 2) throw new LobbyError(400, 'invalid_principal', 'Invalid agent identity');
  return { lobby_id: LobbyId.parse(parts[0]), agent_id: AgentId.parse(parts[1]) };
}
export const LobbySchema = z.object({ lobby_id: NewLobbyId }).strict();
/**
 * An email address as the broker keys it (0.5.0): trimmed and lowercased, the same way before a
 * code is sent and before it is checked, so a capital letter never makes a second account.
 */
export const Email = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .refine(
    (value) =>
      /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(
        value,
      ),
    'Use an email address such as name@example.com',
  );
/** The operator's account settings: enable or disable, and whether it may create lobbies. */
export const AccountSettingsSchema = z
  .object({
    email: Email,
    enabled: z.boolean().optional(),
    may_create_lobbies: z.boolean().optional(),
  })
  .strict();
export type AccountSettingsInput = z.input<typeof AccountSettingsSchema>;
/** The operator grants or ends an account's ownership of the selected lobby. */
export const OwnerSchema = z.object({ email: Email }).strict();
export const RoomSchema = z.object({ room_id: RoomId }).strict();
export const RoomMembersSchema = z.object({ members: z.array(AgentId).max(100) }).strict();
/**
 * Members to add and to remove (0.3.1), keeping everyone else: two coordinators changing
 * different members do not overwrite each other.
 */
export const RoomMemberChangesSchema = z
  .object({
    add: z.array(AgentId).max(100).optional(),
    remove: z.array(AgentId).max(100).optional(),
  })
  .strict()
  .refine((value) => value.add?.length || value.remove?.length, 'Name members to add or remove')
  .refine(
    (value) => !value.add?.some((id) => value.remove?.includes(id)),
    'An agent cannot be both added and removed',
  );
export const RequestId = z.string().min(1).max(128);
/** Request IDs with this prefix are the broker's own, such as recurring-schedule occurrences. */
export const RESERVED_REQUEST_PREFIX = 'pocolobby:';
export const Content = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= MAX_CONTENT_BYTES, 'Content exceeds 64 KiB');

/** What a sender expects of the recipient. `request` is the default when omitted. */
export const MESSAGE_KINDS = ['request', 'notice', 'assignment', 'report', 'question'] as const;
export const MessageKind = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKind>;
/** reply_expected defaults to false for a notice or report and true for every other kind. */
export const defaultReplyExpected = (kind: MessageKind): boolean =>
  kind !== 'notice' && kind !== 'report';
/**
 * The default retry fingerprints were computed against before reports stopped expecting a
 * reply. Frozen, so a send's request ID matches across that change.
 */
const fingerprintReplyDefault = (kind: MessageKind): boolean => kind !== 'notice';
export const MAX_DETAILS_BYTES = 8 * 1024;
const OneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'One line without control characters');
/**
 * Optional structured fields of a message, bounded individually and together. Evidence is
 * a logical location such as `dropbox:MDP/...` that each machine resolves for itself.
 */
export const MessageDetailsShape = {
  kind: MessageKind.optional(),
  reply_expected: z.boolean().optional(),
  commit: OneLine(100).optional(),
  files: z.array(OneLine(300)).min(1).max(50).optional(),
  evidence: OneLine(500)
    .regex(/^[a-z][a-z0-9+.-]+:\S/u, 'Use a logical location such as dropbox:MDP/...')
    .optional(),
  options: z.array(OneLine(500)).min(1).max(10).optional(),
  recommendation: z.string().min(1).max(2000).optional(),
  notify_when_seen: z.boolean().optional(),
};
export const DETAIL_FIELDS = ['commit', 'files', 'evidence', 'options', 'recommendation'] as const;
export type MessageDetails = {
  commit?: string;
  files?: string[];
  evidence?: string;
  options?: string[];
  recommendation?: string;
};
export function messageDetails(input: MessageDetails): MessageDetails | null {
  const details: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) if (input[field] !== undefined) details[field] = input[field];
  return Object.keys(details).length ? (details as MessageDetails) : null;
}
const detailsFit = (input: MessageDetails) =>
  Buffer.byteLength(JSON.stringify(messageDetails(input) ?? {})) <= MAX_DETAILS_BYTES;
/** An ISO 8601 instant with an explicit zone, for example 2026-10-16T06:41:00+02:00. */
export const Instant = z
  .string()
  .max(40)
  .regex(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/u,
    'Use an ISO 8601 time with Z or an offset, such as 2026-10-16T06:41:00+02:00',
  )
  .refine((value) => Number.isFinite(Date.parse(value)), 'Not a valid time');
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
export const SCHEDULE_PAST_TOLERANCE_MS = 5 * 60 * 1000;

/** Most members one room message can name; a larger audience is the room itself. */
export const MAX_NAMED_RECIPIENTS = 20;
const roomAddress = {
  path: ['to'],
  message: 'A room message uses to: * for every member, or a list of members; a list needs a room',
};
const roomAddressed = (input: { to: string | string[]; room?: string }) =>
  input.room === undefined ? !Array.isArray(input.to) : input.to === '*' || Array.isArray(input.to);
const distinctRecipients = { path: ['to'], message: 'Name each member once' };
const recipientsDistinct = (input: { to: string | string[] }) =>
  !Array.isArray(input.to) || new Set(input.to).size === input.to.length;
const detailsLimit = {
  path: ['files'],
  message: `Structured fields exceed ${MAX_DETAILS_BYTES} bytes together`,
};
const sendShape = {
  client_request_id: RequestId,
  // A list names some members of a room; only they receive it.
  to: z.union([AgentId, z.literal('*'), z.array(AgentId).min(1).max(MAX_NAMED_RECIPIENTS)]),
  priority: z.enum(['info', 'important']).default('info'),
  content: Content,
  correlation_id: RequestId.optional(),
  reply_to: RequestId.optional(),
  room: RoomId.optional(),
  // Later fields stay optional and in this order: stored retry fingerprints hash them so.
  ...MessageDetailsShape,
  deliver_at: Instant.optional(),
  // Uploaded files, described by the bridge that read them.
  attachments: z.array(AttachmentDescriptor).min(1).max(MAX_ATTACHMENTS).optional(),
};
const distinctAttachments = {
  path: ['attachments'],
  message: 'Attach each file once',
};
const attachmentsDistinct = (input: { attachments?: { sha256: string; filename: string }[] }) =>
  !input.attachments ||
  new Set(input.attachments.map((item) => `${item.sha256}/${item.filename}`)).size ===
    input.attachments.length;
export const SendSchema = z
  .object(sendShape)
  .strict()
  .refine(roomAddressed, roomAddress)
  .refine(recipientsDistinct, distinctRecipients)
  .refine(detailsFit, detailsLimit)
  .refine(attachmentsDistinct, distinctAttachments);
export type SendInput = z.input<typeof SendSchema>;
export type ParsedSend = z.infer<typeof SendSchema>;

/**
 * The value a retry fingerprint hashes. Defaults are dropped and times normalized, so
 * `kind: "request"` and an omitted kind are the same request. Keep it byte-stable: a retry
 * after a deploy must hash as the stored request did.
 */
export function canonicalSend(input: ParsedSend): Record<string, unknown> {
  const { kind, reply_expected, notify_when_seen, deliver_at, ...rest } = input;
  const canonical: Record<string, unknown> = { ...rest };
  // The members a room message names, in any order, are one audience.
  if (Array.isArray(rest.to)) canonical.to = [...rest.to].sort();
  const effectiveKind = kind ?? 'request';
  if (effectiveKind !== 'request') canonical.kind = effectiveKind;
  if (reply_expected !== undefined && reply_expected !== fingerprintReplyDefault(effectiveKind))
    canonical.reply_expected = reply_expected;
  if (notify_when_seen) canonical.notify_when_seen = true;
  if (deliver_at !== undefined) canonical.deliver_at = new Date(deliver_at).toISOString();
  return canonical;
}

/**
 * A room message to some of its members is stored as a room message (target *) whose structured
 * fields hold the sorted names: a broker from before 0.8.2 still delivers it, to exactly them.
 */
export function namedMembers(to: string | string[]): string[] | null {
  return Array.isArray(to) ? [...to].sort() : null;
}
/** The named members in a stored message's structured fields, as a field to spread. */
export function addressedOf(details: unknown): { addressed_to?: string[] } {
  if (typeof details !== 'string') return {};
  const names = (JSON.parse(details) as { addressed_to?: string[] }).addressed_to;
  return names ? { addressed_to: names } : {};
}

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;
export function canonicalTimeZone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
/** A daily repeat at local wall-clock times in an IANA time zone, optionally on some weekdays. */
export const RepeatSchema = z
  .object({
    time_zone: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => canonicalTimeZone(value) !== null, 'Unknown IANA time zone'),
    times: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Use HH:MM, 24-hour local time'))
      .min(1)
      .max(24),
    weekdays: z.array(Weekday).min(1).max(7).optional(),
  })
  .strict();
export type Repeat = { time_zone: string; times: string[]; weekdays: Weekday[] | null };
export function canonicalRepeat(input: z.infer<typeof RepeatSchema>): Repeat {
  return {
    time_zone: canonicalTimeZone(input.time_zone)!,
    times: [...new Set(input.times)].sort(),
    weekdays: input.weekdays ? WEEKDAYS.filter((day) => input.weekdays!.includes(day)) : null,
  };
}
const { reply_to: _replyTo, deliver_at: _deliverAt, ...scheduleSendShape } = sendShape;
export const ScheduleSchema = z
  .object({ ...scheduleSendShape, repeat: RepeatSchema })
  .strict()
  .refine(roomAddressed, roomAddress)
  .refine(recipientsDistinct, distinctRecipients)
  .refine(detailsFit, detailsLimit)
  .refine(attachmentsDistinct, distinctAttachments);
export type ScheduleInput = z.input<typeof ScheduleSchema>;
export const CancelScheduledSchema = z.object({ id: z.uuid() }).strict();
export const ProvisionSchema = z
  .object({
    agent_id: AgentId,
    // Without it, the owner's lobby: the broker's only one (0.8.3).
    lobby_id: LobbyId.optional(),
    manage_rooms: z.boolean().default(false),
    role: z.string().max(16000).default(''),
    can_broadcast: z.boolean().default(false),
    allowed_recipients: z.array(AgentId).max(100).nullable().default(null),
  })
  .strict();
export type ProvisionInput = Omit<z.infer<typeof ProvisionSchema>, 'lobby_id' | 'manage_rooms'> & {
  lobby_id?: string;
  manage_rooms?: boolean;
};
export const UpdateAgentSchema = z
  .object({
    role: z.string().max(16000).optional(),
    can_broadcast: z.boolean().optional(),
    manage_rooms: z.boolean().optional(),
    allowed_recipients: z.array(AgentId).max(100).nullable().optional(),
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
  })
  .strict();
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;
/** Omit generation when a process starts; a reconnect repeats the generation it holds. */
export const RuntimeSchema = z
  .object({ runtime_id: z.uuid(), generation: z.number().int().nonnegative().optional() })
  .strict();
export const AckSchema = z.object({ message_ids: z.array(z.uuid()).min(1).max(100) }).strict();
export const CheckpointSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    content: z.string().max(32000),
    covered_receipt_seq: z.number().int().nonnegative(),
    acknowledge_message_ids: z.array(z.uuid()).max(100).default([]),
  })
  .strict();
export type CheckpointInput = z.infer<typeof CheckpointSchema>;
export const ReadySchema = z
  .object({
    context_revision: z.number().int().nonnegative(),
    probe_nonce: z.string().min(1).max(128),
  })
  .strict();
/** Decisions, approvals or looks an agent waits on from the owner; the board shows them live. */
export const MAX_OWNER_REQUESTS = 20;
export const OwnerRequestsSchema = z
  .object({
    count: z.number().int().min(0).max(MAX_OWNER_REQUESTS),
    text: z
      .string()
      .max(300)
      .regex(/^[^\p{Cc}]*$/u, 'One line without control characters')
      .default(''),
  })
  .strict()
  .refine((input) => input.count === 0 || input.text.trim() !== '', {
    path: ['text'],
    message: 'Say what you need from the owner',
  });
export type OwnerRequestsInput = z.input<typeof OwnerRequestsSchema>;
/** One Claude plan window as Claude Code's status line reports it. */
const UsageWindow = z
  .object({
    used_percentage: z.number().min(0).max(100),
    /** Unix epoch seconds when the window resets. */
    resets_at: z.number().int().positive(),
  })
  .strict();
/**
 * An agent's Claude plan usage, sent by `pocolobby statusline` from its Claude Code status line:
 * the five-hour and weekly windows, and the account it is signed in to. The broker keeps only the
 * latest, in memory, for the board.
 */
/** A Claude model ID, such as claude-opus-5-5 or claude-opus-4-6[1m]. */
export const ModelId = z
  .string()
  .max(80)
  .regex(/^[\w.[\]-]+$/u);
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
/**
 * The weekly window of a model family with a limit of its own, such as Fable's, as Claude Code's
 * /usage shows it ("Fable this week"). Its percentage is of that allowance, not of the whole week.
 */
export const ModelWindowSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[\w .-]+$/u),
    used_percentage: z.number().min(0).max(100),
    /** Unix epoch seconds when the window resets. */
    resets_at: z.number().int().positive(),
  })
  .strict();
export type ModelWindow = z.infer<typeof ModelWindowSchema>;
/** Whether a model family's window covers this model ID: Fable's covers claude-fable-5-1. */
export function windowCovers(modelId: string, windowName: string): boolean {
  const slug = windowName.trim().toLowerCase().replace(/[ .]+/gu, '-');
  return slug !== '' && `-${modelId.toLowerCase().replace(/\[.*$/u, '')}-`.includes(`-${slug}-`);
}
export const UsageReportSchema = z
  .object({
    five_hour: UsageWindow.optional(),
    seven_day: UsageWindow.optional(),
    account: Email.optional(),
    plan: z
      .string()
      .max(40)
      .regex(/^[\w .-]*$/u)
      .optional(),
    // The session's model and reasoning effort, as Claude Code gives them to the status line (0.8.4).
    model: ModelId.optional(),
    effort: Effort.optional(),
    // The session's context window in tokens, such as 200000 or 1000000 (0.8.5).
    context: z.number().int().positive().max(100_000_000).optional(),
    // The account's per-model weekly windows, such as Fable's, from Claude Code's usage (0.8.6).
    // Present only while the status line's last look is fresh; an empty list says there are none.
    model_windows: z.array(ModelWindowSchema).max(8).optional(),
  })
  .strict();
export type UsageReport = z.infer<typeof UsageReportSchema>;
/**
 * Event format negotiated on the WebSocket upgrade; the broker refuses a bridge that declares an
 * older one. Message, header and receipt fields outside the lists below travel under a bounded
 * `extensions` object, and the broker adds a `presentation` to messages, covered headers and
 * receipts events, so new fields and wording need no bridge update.
 */
export const EVENT_VERSION = 5;
export const EVENT_VERSION_HEADER = 'x-pocolobby-event-version';
/** The package release; the adapter reports it as its MCP server version. */
export const PACKAGE_VERSION = '0.8.6';
/** Extension data: keys in this form, at most this many, and this much JSON per object. */
export const ExtensionKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const MAX_EXTENSION_KEYS = 32;
export const MAX_EXTENSION_BYTES = 4 * 1024;
/** The bridge's frame limit, with room for a full push plus presentations. */
export const MAX_EVENT_FRAME_BYTES = 192 * 1024;
/** Message fields an event carries at top level. */
export const MESSAGE_KEYS = [
  'id',
  'lobby_id',
  'room_id',
  'sequence',
  'from',
  'to',
  'priority',
  'content',
  'correlation_id',
  'reply_to',
  'created_at',
  'agent_seen_at',
  'receipt_seq',
  'delivery_state',
  'held_reason',
  'kind',
  'reply_expected',
  'commit',
  'files',
  'evidence',
  'options',
  'recommendation',
  'notify_when_seen',
  'deliver_at',
  'delivered_at',
  'late',
  'schedule_id',
  'cancelled_at',
] as const;
export const HEADER_KEYS = [
  'id',
  'from',
  'to',
  'room_id',
  'priority',
  'created_at',
  'kind',
] as const;
export const RECEIPT_KEYS = [
  'message_id',
  'seen_by',
  'seen_at',
  'kind',
  'to',
  'room_id',
  'excerpt',
] as const;
/** The broker's tool catalog for this agent has this revision. */
export interface CatalogEvent {
  type: 'catalog';
  revision: string;
}
export const TransportReceiptSchema = z
  .object({
    type: z.enum(['adapter_received', 'notification_attempted']),
    notification_id: z.uuid(),
  })
  .strict();
export type TransportReceipt = z.infer<typeof TransportReceiptSchema>;
export interface RuntimeBinding {
  runtime_id: string;
  generation: number;
  incarnation: string;
  probe_nonce: string;
  ready: boolean;
}
export interface RuntimeAuth {
  runtime_id: string;
  generation: number;
  incarnation: string;
}
export interface Agent {
  agent_id: string;
  lobby_id: string;
  manage_rooms: boolean;
  role: string;
  enabled: boolean;
  paused: boolean;
  can_broadcast: boolean;
  allowed_recipients: string[] | null;
  runtime_id: string | null;
  generation: number;
  ready: boolean;
  last_seen_at: string | null;
  last_agent_seen_at: string | null;
  pending_count: number;
  notification_attention_required: boolean;
  /** Unseen deliveries written to the agent's host but not yet acknowledged. */
  unseen_notified_count: number;
  /** The latest host write of the oldest such delivery, or null; not proof of a stall. */
  oldest_unseen_notified_at: string | null;
  /**
   * When it last sent a message (its schedules' occurrences aside) or received a direct one,
   * delivered; null when never. Facts, not a claim: an agent working long without messaging
   * shows an old time.
   */
  last_message_at: string | null;
  /** What it waits on from the owner, or null when nothing; set by the agent, kept until cleared. */
  owner_requests: OwnerRequests | null;
}
export interface OwnerRequests {
  count: number;
  text: string;
  set_at: string;
}
/**
 * `scheduled`: stored, waiting for its deliver_at; the recipient cannot see it yet.
 * `cancelled`: the sender cancelled it before delivery; the recipient never sees it.
 */
export type DeliveryState = 'pending' | 'seen' | 'held' | 'scheduled' | 'cancelled';
/** One recipient's delivery facts, shown only to the message's sender (and the owner). */
export interface RecipientDelivery {
  agent_id: string;
  delivery_state: DeliveryState;
  /** Most recent time the recipient's adapter reported writing a notice for it to its host. */
  notification_attempted_at: string | null;
  agent_seen_at: string | null;
  held_reason: string | null;
}
export type MessageHeader = Pick<
  Message,
  'id' | 'from' | 'to' | 'addressed_to' | 'room_id' | 'priority' | 'created_at'
> & {
  /** Null (omitted in events) when the sender chose no kind. */
  kind?: MessageKind | null;
  /** Travels under `extensions` in events. */
  attachments?: EventAttachment[];
};
/**
 * A file attached to a message. Message reads show all of it; events carry the compact form
 * under `extensions.attachments`. Only the uploader and the message's recipients can download it.
 */
export interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  sha256: string;
  /** Present once retention removed its content; the metadata stays. */
  expired_at?: string;
}
export type EventAttachment = Pick<AttachmentInfo, 'id' | 'filename' | 'mime_type' | 'size'>;
export interface Message extends MessageDetails {
  id: string;
  lobby_id: string;
  room_id: string | null;
  sequence: number;
  from: string;
  to: string;
  /** A room message sent to only some members: their IDs. Its `to` stays * */
  addressed_to?: string[];
  priority: 'info' | 'important';
  content: string;
  correlation_id: string | null;
  reply_to: string | null;
  created_at: string;
  /**
   * What the sender expects, or null when it chose no kind.
   */
  kind: MessageKind | null;
  /** The sender's explicit choice, else its kind's default; null without either. */
  reply_expected: boolean | null;
  /** Present, and true, when the sender asked for a read receipt. */
  notify_when_seen?: boolean;
  /** Scheduled messages only: when it was due, when it became pending, and whether late. */
  deliver_at?: string;
  delivered_at?: string | null;
  late?: boolean;
  /** Occurrences of a recurring schedule. */
  schedule_id?: string;
  cancelled_at?: string;
  agent_seen_at?: string | null;
  receipt_seq?: number | null;
  delivery_state?: DeliveryState;
  held_reason?: string | null;
  /** Per-recipient facts on history items the caller sent. */
  deliveries?: RecipientDelivery[];
  /** Present when the sender attached files. */
  attachments?: AttachmentInfo[];
}
export interface Schedule extends MessageDetails {
  schedule_id: string;
  lobby_id: string;
  from: string;
  client_request_id: string;
  to: string;
  addressed_to?: string[];
  room_id: string | null;
  priority: 'info' | 'important';
  content: string;
  correlation_id: string | null;
  kind: MessageKind | null;
  reply_expected: boolean | null;
  notify_when_seen?: boolean;
  attachments?: AttachmentInfo[];
  repeat: Repeat;
  created_at: string;
  next_occurrence_at: string | null;
  /** The next occurrence in the schedule's own time zone, for example "Fri 2026-10-16 06:41". */
  next_occurrence_local: string | null;
  occurrence_count: number;
  last_occurrence_at: string | null;
  last_message_id: string | null;
  /** Why the latest occurrence was skipped, such as recipient_disabled; null after a success. */
  last_error: string | null;
  cancelled_at: string | null;
}
/**
 * A listing entry, enough to find and cancel: without structured fields, its content cut to its
 * beginning. The sender's history holds the whole message.
 */
export type ListedSchedule = Omit<Schedule, keyof MessageDetails> & { content_truncated?: true };
export type ListedMessage = Omit<Message, keyof MessageDetails | 'deliveries'> & {
  /** How many recipients it will reach. */
  recipients: number;
  content_truncated?: true;
};
export interface ScheduledItems {
  /** Active recurring schedules. */
  schedules: ListedSchedule[];
  /** One-off messages waiting for their deliver_at. */
  messages: ListedMessage[];
}
export interface StoredSchedule {
  status: 'scheduled';
  schedule: Schedule;
  duplicate: boolean;
}
export type CancelResult =
  | { cancelled: 'schedule'; schedule: Schedule; already_cancelled: boolean }
  | { cancelled: 'message'; message: Message; already_cancelled: boolean };
export interface Room {
  lobby_id: string;
  room_id: string;
  members: string[];
}
/** What deleting a room did: its members left, unseen deliveries held, schedules cancelled. */
export interface DeletedRoom {
  lobby_id: string;
  room_id: string;
  deleted: true;
  former_members: string[];
  /** Unseen deliveries of the room's messages now held with reason room_deleted. */
  held_deliveries: number;
  /** Recurring schedules that sent to the room, now cancelled; tell their owners. */
  cancelled_schedules: { schedule_id: string; from: string }[];
}
export interface Page<T> {
  items: T[];
  next_cursor: number | null;
}
export interface Checkpoint {
  revision: number;
  content: string;
  covered_receipt_seq: number;
  updated_at: string | null;
  runtime_id: string | null;
}
/** A reconciliation item shown without its body; read it in full through a message page. */
export interface ReconciliationHeader {
  id: string;
  from: string;
  to: string;
  addressed_to?: string[];
  room_id: string | null;
  priority: 'info' | 'important';
  kind: MessageKind | null;
  created_at: string;
  agent_seen_at: string | null;
  receipt_seq: number;
}
export interface AgentContext {
  agent_id: string;
  lobby_id: string;
  runtime_id: string | null;
  role: string;
  checkpoint: Checkpoint;
  receipt_snapshot: number;
  pending: Page<Message>;
  /**
   * Acknowledged messages the checkpoint does not cover: the first few with bodies (items, with
   * next_cursor continuing after them), headers of some more, and how many there are in total.
   */
  reconciliation: Page<Message> & { total: number; headers: ReconciliationHeader[] };
  /** Your own active schedules and undelivered scheduled messages; list them with GET /v1/schedules. */
  scheduled: { schedules: number; messages: number };
  /** Broker guidance for this bootstrap, such as saving a first checkpoint. */
  guidance: string[];
  /**
   * Every current operation with its purpose and argument names, from the same catalog discovery serves. A host can keep an older copy of a
   * named tool's schema for the whole session, so this is where the current arguments are read.
   */
  tool_guide: ToolGuide;
  /** The broker that answered: the host the bridge reached it by, and its version. */
  broker?: { host: string | null; version: string };
}
export interface ToolGuide {
  catalog_revision: string | null;
  /** How to use the guide when a named tool's schema looks older. */
  note: string;
  operations: ToolGuideEntry[];
  /** Added by the bridge: its own tools, such as get_attachment. */
  bridge_tools?: ToolGuideEntry[];
}
export interface ToolGuideEntry {
  name: string;
  purpose: string;
  /** Argument name to a short meaning; required ones are marked. */
  arguments: Record<string, string>;
}
export interface StoredMessage {
  status: 'stored';
  message: Message;
  recipients: string[];
  /** Current per-recipient facts; a duplicate retry reports them as they are now. */
  deliveries: RecipientDelivery[];
  duplicate: boolean;
}
export interface NotificationEvent {
  type: 'inbox' | 'bootstrap';
  notification_id: string;
  agent_id: string;
  lobby_id: string;
  runtime_id: string;
  generation: number;
  probe_nonce?: string;
  messages: Message[];
  /** Unseen, unheld deliveries in this inbox when the notice was reserved and sent. */
  pending_count: number;
  truncated: boolean;
  /** Hints only: headers of up to 20 messages this notice covers. */
  covered?: MessageHeader[];
  /** Hints only: how many deliveries this notice covers in total. */
  covered_count?: number;
}
/** A recipient acknowledged a message whose sender asked for notify_when_seen. */
export interface SeenReceipt {
  message_id: string;
  seen_by: string;
  seen_at: string;
  /** Null when the sender chose no kind. */
  kind: MessageKind | null;
  to: string;
  addressed_to?: string[];
  room_id: string | null;
  /** The start of the sender's own message, so it can tell which one this was. */
  excerpt: string;
}
/**
 * Coalesces several read receipts. It is not a message: it has no
 * inbox entry, needs no acknowledgment, and is never itself the subject of a receipt.
 */
export interface ReceiptEvent {
  type: 'receipts';
  notification_id: string;
  agent_id: string;
  lobby_id: string;
  runtime_id: string;
  generation: number;
  receipts: SeenReceipt[];
  /** Receipts still waiting; a later receipts event carries them. */
  remaining: number;
}
export type LobbyEvent = NotificationEvent | ReceiptEvent;
export class LobbyError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Machine-readable fields added to the error body, such as the uploads a send still needs. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LobbyError';
  }
}
