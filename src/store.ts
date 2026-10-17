import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  backup as sqliteBackup,
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from 'node:sqlite';
import {
  DEFAULT_ATTACHMENT_DISK_RESERVE_BYTES,
  DEFAULT_ATTACHMENT_GRACE_MS,
  DEFAULT_ATTACHMENT_RETENTION_MS,
  DEFAULT_LOBBY_ATTACHMENT_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TEXT_BYTES,
  formatBytes,
  kindOf,
  kindOfBytes,
  sniffImage,
  type AttachmentDescriptor,
  type AttachmentKind,
} from './attachments.js';
import {
  addressedOf,
  namedMembers,
  AccountSettingsSchema,
  CheckpointSchema,
  AgentId,
  Email,
  LobbyId,
  NewLobbyId,
  RoomId,
  RoomMemberChangesSchema,
  parsePrincipal,
  qualifyAgent,
  LobbyError,
  MIN_PUSH_BYTES,
  MAX_CONTENT_BYTES,
  MAX_PAGE_BYTES,
  MAX_SCHEDULE_AHEAD_MS,
  ProvisionSchema,
  RESERVED_REQUEST_PREFIX,
  SCHEDULE_PAST_TOLERANCE_MS,
  ScheduleSchema,
  SendSchema,
  OwnerRequestsSchema,
  UpdateAgentSchema,
  canonicalRepeat,
  canonicalSend,
  defaultReplyExpected,
  messageDetails,
  type AccountSettingsInput,
  type Agent,
  type AgentContext,
  DETAIL_FIELDS,
  type AttachmentInfo,
  type EventAttachment,
  type OwnerRequests,
  type CancelResult,
  type Checkpoint,
  type CheckpointInput,
  type DeliveryState,
  type Message,
  type MessageDetails,
  type MessageHeader,
  type MessageKind,
  type NotificationEvent,
  type Page,
  type ParsedSend,
  type ReconciliationHeader,
  type ProvisionInput,
  type ReceiptEvent,
  type RecipientDelivery,
  type Repeat,
  type DeletedRoom,
  type Room,
  type RuntimeAuth,
  type RuntimeBinding,
  type Schedule,
  type ScheduledItems,
  type ScheduleInput,
  type SendInput,
  type OwnerRequestsInput,
  type StoredMessage,
  type StoredSchedule,
  type TransportReceipt,
  type UpdateAgentInput,
  DisplayName,
} from './protocol.js';
import {
  BoardAgentsSchema,
  BoardSourceSchema,
  MAX_BOARD_SOURCES,
  RepoName,
  SUMMARY_MODELS,
  SummarySettingsSchema,
  sourceKey,
  type BoardAgentsInput,
  type BoardConfig,
  type BoardMessage,
  type BoardSource,
  type BoardSourceInput,
  type BoardVisibility,
  type NotesFile,
  type NotesSnapshot,
  type NotesSource,
  type Summary,
  type SummaryRecord,
} from './board-model.js';
import { latestDueOccurrence, localLabel, nextOccurrence } from './recurrence.js';
import { SIGN_IN } from './auth.js';
import { checkLobbyIcon } from './icons.js';

type Row = Record<string, string | number | null>;
/**
 * Who changes a lobby: `owner` is the operator (the admin token), another string an agent
 * principal, and `{ account_id }` a lobby owner signed in to the console (0.5.0), who may act
 * only on lobbies that account owns.
 */
export type Actor = string | { account_id: string };
interface StoreOptions {
  now?: () => number;
  infoDelayMs?: number;
  /** One entry per allowed attempt; each value is the delay after that attempt. */
  retryDelaysMs?: number[];
  maxPendingBytes?: number;
  maxAgents?: number;
  maxLobbies?: number;
  maxRoomsPerLobby?: number;
  /** Message content one lobby may hold, its day of history included. */
  maxStoredBytes?: number;
  notificationRatePerMinute?: number;
  /** SQLite page budget; WAL, SHM, backups, and temporary files need additional disk headroom. */
  maxDatabaseBytes?: number;
  /** A scheduled message or occurrence delivered more than this after its time is marked late. */
  lateAfterMs?: number;
  /** A read receipt waits this long so that receipts close together share one event. */
  receiptDelayMs?: number;
  /** Minimum spacing between receipt events to one agent. */
  receiptIntervalMs?: number;
  /** Active recurring schedules per sender. */
  maxSchedulesPerSender?: number;
  /** Undelivered one-off scheduled messages per sender. */
  maxScheduledPerSender?: number;
  /** Where attachment content lives, one file per SHA-256; defaults beside the database. */
  attachmentsDir?: string;
  maxImageBytes?: number;
  maxTextBytes?: number;
  /** Distinct attachment content per lobby, live attachments and recent uploads together. */
  maxLobbyAttachmentBytes?: number;
  /** Content is removed this long after the last message that references it. */
  attachmentRetentionMs?: number;
  /** An upload no send referenced within this time is removed. */
  attachmentGraceMs?: number;
  /** Uploads are refused when they would leave less free disk than this. */
  attachmentDiskReserveBytes?: number;
  /** Free bytes on the attachments disk; tests replace it. */
  freeDiskBytes?: (directory: string) => number;
}

/** Usage and limits of one lobby's attachment storage, for the owner. */
export interface AttachmentUsage {
  lobby_id: string;
  used_bytes: number;
  quota_bytes: number;
  files: number;
  attachments: number;
  expired: number;
  pending_uploads: number;
  limits: {
    max_image_bytes: number;
    max_text_bytes: number;
    retention_days: number;
    upload_grace_seconds: number;
  };
  disk: { free_bytes: number; reserve_bytes: number } | null;
}
/** One attachment in the owner's listing. */
export interface AttachmentRecord extends AttachmentInfo {
  lobby_id: string;
  uploader: string;
  created_at: string;
  last_referenced_at: string | null;
  messages: string[];
  schedules: string[];
}
/** A console account, with the lobbies it owns and the boards it views (0.5.0). */
export interface AccountListing {
  account_id: string;
  email: string;
  may_create_lobbies: boolean;
  created_at: string;
  disabled_at: string | null;
  owns: string[];
  views: string[];
}
/** A lobby as its owner's console lists it. */
export interface OwnedLobby {
  lobby_id: string;
  /** How the console and the board show it; null shows lobby_id (0.8.2). */
  display_name: string | null;
  created_at: string | null;
  visibility: BoardVisibility;
  /** Enabled agents. */
  agents: number;
  rooms: number;
}
export interface BoardViewer {
  email: string;
  added_at: string;
  /** The operator disabled this account; it opens nothing. */
  disabled: boolean;
  /** Its open sessions on this board. */
  sessions: number;
}
export interface ArchivedRoom {
  lobby_id: string;
  room_id: string;
  archived: true;
  former_members: string[];
  /** Recurring schedules that sent to the room, now cancelled. */
  cancelled_schedules: { schedule_id: string; from: string }[];
}
/** One audit event as the console's Activity shows it. */
export interface ActivityEvent {
  at: string;
  actor_kind: 'operator' | 'agent' | 'account';
  /** The agent's name or the account's email; null for the operator. */
  actor: string | null;
  action: string;
  target: string | null;
  detail: unknown;
}
const ENVIRONMENT_NAMES = {
  image: 'POCOLOBBY_ATTACHMENT_MAX_IMAGE_BYTES',
  text: 'POCOLOBBY_ATTACHMENT_MAX_TEXT_BYTES',
  lobby: 'POCOLOBBY_ATTACHMENT_LOBBY_BYTES',
  reserve: 'POCOLOBBY_ATTACHMENT_DISK_RESERVE_BYTES',
} as const;

/** The storage schema this broker creates and opens; it refuses a database of any other. */
export const SCHEMA_VERSION = 11;
/** Audit events kept per lobby (and as many without one); the console shows the newest 100. */
const ADMIN_EVENTS_KEPT = 10_000;
/** An expired attachment's record is kept this long after expiry. */
const EXPIRED_ATTACHMENT_RECORD_MS = 7 * 24 * 60 * 60 * 1000;
/** Characters of each item's content that list_scheduled shows. */
const SCHEDULED_EXCERPT = 300;
/**
 * A new message's content is bounded as it serializes, the unit of pages and pushes: escaped
 * quotes, backslashes, newlines and control characters take two to six bytes each. One message
 * then always fits a page. Checked after the retry lookup, so an accepted send still repeats.
 */
function admitContent(content: string): void {
  if (Buffer.byteLength(JSON.stringify(content)) - 2 > MAX_CONTENT_BYTES)
    fail(
      400,
      'content_too_large',
      'Content exceeds 64 KiB once escaped as JSON, where quotes, backslashes, newlines and control characters count two to six bytes; send less or attach it as a file',
    );
}
/**
 * Bootstrap context shows this many reconciliation messages with their bodies, then headers
 * of a few more. An agent that never saved a checkpoint would otherwise receive every message
 * it ever acknowledged, in full, on each bootstrap.
 */
const RECONCILIATION_BODIES = 5;
const RECONCILIATION_HEADERS = 20;
/** Held reasons that are not holds in the API: not yet due, or cancelled before delivery. */
const SCHEDULED = 'scheduled';
const CANCELLED = 'cancelled';
/** Receipts not pushed within this time are dropped; history still shows the seen fact. */
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long a message is kept after it reached its recipients (Johan's word). */
export const MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS_PER_EVENT = 20;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const token = () => `pl_${randomBytes(32).toString('base64url')}`;
const fail = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never => {
  throw new LobbyError(status, code, message, details);
};

/**
 * Copy a stopped broker's database to `destination`, private. It is opened read-only, so the
 * copy is the database as it was, whatever its schema.
 */
export async function backupDatabase(database: string, destination: string): Promise<void> {
  if (resolve(destination) === resolve(database))
    fail(400, 'invalid_backup_path', 'Backup destination must differ from the live database');
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await sqliteBackup(source, destination);
  } finally {
    source.close();
  }
  chmodSync(destination, 0o600);
}

/** One process owns this connection. Every accepted message is committed before returning. */
export class LobbyStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly infoDelay: number;
  private readonly retries: number[];
  private readonly bootstrapRetry: number;
  private readonly maxPending: number;
  private readonly maxAgents: number;
  private readonly maxLobbies: number;
  private readonly maxRooms: number;
  private readonly maxStored: number;
  private readonly notificationRate: number;
  private readonly lateAfter: number;
  private readonly receiptDelay: number;
  private readonly receiptInterval: number;
  private readonly maxSchedules: number;
  private readonly maxScheduled: number;
  readonly maxImageBytes: number;
  readonly maxTextBytes: number;
  private readonly maxLobbyAttachments: number;
  private readonly attachmentRetention: number;
  /** Days an attachment is kept after the last message that uses it. */
  get attachmentRetentionDays(): number {
    return this.attachmentRetention / (24 * 60 * 60 * 1000);
  }
  private readonly attachmentGrace: number;
  private readonly diskReserve: number;
  private readonly freeDisk: (directory: string) => number;
  private attachmentsDirectory?: string;

  constructor(path: string, options: StoreOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.infoDelay = options.infoDelayMs ?? 1_000;
    this.retries = [...(options.retryDelaysMs ?? [30_000, 120_000, 300_000])];
    this.bootstrapRetry = Math.max(...this.retries);
    this.maxPending = options.maxPendingBytes ?? 4 * 1024 * 1024;
    this.maxAgents = options.maxAgents ?? 100;
    this.maxLobbies = options.maxLobbies ?? 100;
    this.maxRooms = options.maxRoomsPerLobby ?? 100;
    this.maxStored = options.maxStoredBytes ?? 256 * 1024 * 1024;
    this.notificationRate = options.notificationRatePerMinute ?? 30;
    this.lateAfter = options.lateAfterMs ?? 60_000;
    this.receiptDelay = options.receiptDelayMs ?? 2_000;
    this.receiptInterval = options.receiptIntervalMs ?? 30_000;
    this.maxSchedules = options.maxSchedulesPerSender ?? 20;
    this.maxScheduled = options.maxScheduledPerSender ?? 100;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.maxLobbyAttachments = options.maxLobbyAttachmentBytes ?? DEFAULT_LOBBY_ATTACHMENT_BYTES;
    this.attachmentRetention = options.attachmentRetentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS;
    this.attachmentGrace = options.attachmentGraceMs ?? DEFAULT_ATTACHMENT_GRACE_MS;
    this.diskReserve = options.attachmentDiskReserveBytes ?? DEFAULT_ATTACHMENT_DISK_RESERVE_BYTES;
    this.freeDisk =
      options.freeDiskBytes ??
      ((directory) => {
        const stats = statfsSync(directory);
        return Number(stats.bavail) * Number(stats.bsize);
      });
    this.attachmentsDirectory =
      options.attachmentsDir ??
      (path === ':memory:' ? undefined : join(dirname(resolve(path)), 'attachments'));
    const maxDatabaseBytes = options.maxDatabaseBytes ?? 1024 * 1024 * 1024;
    if (
      !this.retries.length ||
      this.retries.some((n) => !Number.isFinite(n) || n < 0) ||
      [
        this.infoDelay,
        this.maxPending,
        this.maxStored,
        this.maxAgents,
        this.lateAfter,
        this.receiptDelay,
        this.receiptInterval,
        this.maxSchedules,
        this.maxScheduled,
        this.maxImageBytes,
        this.maxTextBytes,
        this.maxLobbyAttachments,
        this.attachmentRetention,
        this.attachmentGrace,
        this.diskReserve,
      ].some((n) => !Number.isFinite(n) || n < 0)
    ) {
      throw new RangeError(
        'Store limits and retry delays must be finite and nonnegative; at least one attempt is required',
      );
    }
    if (!Number.isSafeInteger(this.notificationRate) || this.notificationRate < 1) {
      throw new RangeError('Notification rate must be a positive integer');
    }
    if (
      [this.maxLobbies, this.maxRooms].some((limit) => !Number.isSafeInteger(limit) || limit < 1)
    ) {
      throw new RangeError('Lobby and room limits must be positive integers');
    }
    if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 512 * 1024) {
      throw new RangeError('Database page budget must be at least 512 KiB');
    }
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
      // Private before SQLite opens it: its WAL and shared-memory files copy this file's mode.
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;',
      );
      const pageSize = Number(this.one('PRAGMA page_size')!.page_size);
      const pageLimit = Math.floor(maxDatabaseBytes / pageSize);
      const actualLimit = Number(this.one(`PRAGMA max_page_count=${pageLimit}`)!.max_page_count);
      if (actualLimit > pageLimit)
        fail(507, 'storage_capacity', 'Existing database exceeds its configured page budget');
      const version = Number(this.one('PRAGMA user_version')!.user_version);
      if (version === 0) this.transaction(() => this.createSchema());
      else if (version === SCHEMA_VERSION - 1) this.transaction(() => this.upgradeSchema());
      else if (version !== SCHEMA_VERSION)
        fail(
          500,
          'unsupported_schema',
          version > SCHEMA_VERSION
            ? `This database is schema ${version}, which is newer than this broker (schema ${SCHEMA_VERSION}).`
            : `This database is schema ${version}; this broker opens schema ${SCHEMA_VERSION}, and upgrades only schema ${SCHEMA_VERSION - 1}. Restore a newer backup or start a new database.`,
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Schema 10 to 11, the one upgrade this broker makes: what each agent waits on from the owner,
   * and an index for the board's communication history. The columns go last, as in a new
   * database.
   */
  private upgradeSchema(): void {
    this.db.exec(`
      ALTER TABLE agents ADD COLUMN owner_requests INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN owner_requests_text TEXT;
      ALTER TABLE agents ADD COLUMN owner_requests_at TEXT;
      CREATE INDEX messages_lobby_time ON messages(lobby_id,created_ms);
      CREATE INDEX messages_lobby_released ON messages(lobby_id,released_ms)
        WHERE released_ms IS NOT NULL;
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  /**
   * A new database: the current schema, the default lobby and a new incarnation. An agent is
   * keyed by its principal, `lobby/agent`. A message's kind and reply_expected are NULL where its
   * sender chose none. A scheduled delivery is a delivery row held with reason `scheduled` until
   * its time, so every inbox query that already excludes holds keeps it from the recipient.
   * Attachment content lives in files named by SHA-256 beside the database, one per distinct
   * content (attachment_blobs); an attachment is one uploader's file under one name, which
   * messages and schedules reference, and an upload no send has referenced yet waits in
   * attachment_uploads until the grace period removes it. A board is a projection of the lobby's
   * notes and live facts, never a task database: board_notes keeps each source's last good
   * snapshot, and board_summaries every summarizer attempt with its sources, usage and either its
   * summary or its error, so paid failures count in the cost. Accounts are people keyed by
   * normalized email; codes, sessions, board hand-offs and per-email rate rows hold only MACs or
   * hashes. The storage cap sums every message's size on each send; messages_bytes keeps that off
   * the large rows.
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        may_create_lobbies INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, disabled_at TEXT
      );
      CREATE TABLE lobbies (
        lobby_id TEXT PRIMARY KEY, owner_account TEXT REFERENCES accounts(account_id), created_at TEXT
      );
      CREATE INDEX lobbies_owner ON lobbies(owner_account);
      CREATE TABLE deleted_lobbies (lobby_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, role TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
        can_broadcast INTEGER NOT NULL, allowed_recipients TEXT,
        runtime_id TEXT, generation INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0,
        probe_nonce TEXT NOT NULL, bootstrap_attempts INTEGER NOT NULL DEFAULT 0,
        bootstrap_next_at INTEGER NOT NULL DEFAULT 0, backlog_sequence INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT, last_agent_seen_at TEXT, receipt_seq INTEGER NOT NULL DEFAULT 0,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        manage_rooms INTEGER NOT NULL DEFAULT 0,
        -- Unused since set_status was removed (0.7.0); kept so existing databases need no rebuild.
        status_state TEXT
          CHECK (status_state IS NULL OR status_state IN ('working','idle','blocked','away')),
        status_text TEXT, status_set_at TEXT, backlog_at INTEGER NOT NULL DEFAULT 0,
        owner_requests INTEGER NOT NULL DEFAULT 0, owner_requests_text TEXT, owner_requests_at TEXT
      );
      CREATE UNIQUE INDEX agents_principal_lobby ON agents(agent_id,lobby_id);
      CREATE TABLE runtime_history (
        agent_id TEXT NOT NULL REFERENCES agents(agent_id), runtime_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, runtime_id)
      );
      CREATE TABLE checkpoints (
        agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id), revision INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '', covered_receipt_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT, runtime_id TEXT
      );
      CREATE TABLE rooms (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        PRIMARY KEY(lobby_id,room_id)
      );
      CREATE TABLE room_members (
        lobby_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        PRIMARY KEY(lobby_id,room_id,agent_id),
        FOREIGN KEY(lobby_id,room_id) REFERENCES rooms(lobby_id,room_id),
        FOREIGN KEY(agent_id,lobby_id) REFERENCES agents(agent_id,lobby_id)
      );
      CREATE TABLE archived_rooms (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        archived_at TEXT NOT NULL, PRIMARY KEY (lobby_id, room_id)
      );
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        target TEXT NOT NULL, priority TEXT NOT NULL, content TEXT NOT NULL,
        correlation_id TEXT, reply_to TEXT, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        room_id TEXT, details TEXT, notify_when_seen INTEGER NOT NULL DEFAULT 0,
        deliver_at_ms INTEGER, released_ms INTEGER, late INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT, schedule_id TEXT,
        kind TEXT
          CHECK (kind IS NULL OR kind IN ('request','notice','assignment','report','question')),
        reply_expected INTEGER CHECK (reply_expected IS NULL OR reply_expected IN (0,1)),
        UNIQUE (sender, request_id)
      );
      CREATE INDEX messages_sender_time ON messages(sender, created_ms);
      CREATE INDEX messages_lobby_sequence ON messages(lobby_id,sequence);
      CREATE INDEX messages_due ON messages(deliver_at_ms)
        WHERE deliver_at_ms IS NOT NULL AND released_ms IS NULL AND cancelled_at IS NULL;
      CREATE UNIQUE INDEX messages_occurrence ON messages(schedule_id, deliver_at_ms)
        WHERE schedule_id IS NOT NULL;
      CREATE INDEX messages_bytes ON messages(byte_size);
      CREATE INDEX messages_lobby_time ON messages(lobby_id,created_ms);
      CREATE INDEX messages_lobby_released ON messages(lobby_id,released_ms)
        WHERE released_ms IS NOT NULL;
      CREATE TABLE deliveries (
        message_id TEXT NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        seen_at TEXT, receipt_seq INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_notification_id TEXT, held_reason TEXT,
        notification_attempted_at TEXT,
        PRIMARY KEY (message_id, agent_id), UNIQUE (agent_id, receipt_seq)
      );
      CREATE INDEX deliveries_pending ON deliveries(agent_id, seen_at, next_attempt_at);
      CREATE INDEX deliveries_notification ON deliveries(last_notification_id);
      CREATE TABLE notification_attempts (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), runtime_id TEXT NOT NULL,
        generation INTEGER NOT NULL, incarnation TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        adapter_received_at TEXT, notification_attempted_at TEXT
      );
      CREATE INDEX notification_attempts_agent_time ON notification_attempts(agent_id,created_at);
      CREATE TABLE seen_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL REFERENCES agents(agent_id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        seen_at TEXT NOT NULL, seen_ms INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due','sent','expired')),
        notification_id TEXT, UNIQUE (message_id, agent_id)
      );
      CREATE INDEX seen_receipts_due ON seen_receipts(sender, sequence) WHERE state='due';
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES agents(agent_id),
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, template TEXT NOT NULL, time_zone TEXT NOT NULL,
        times TEXT NOT NULL, weekdays TEXT, created_at TEXT NOT NULL, next_run_ms INTEGER,
        cancelled_at TEXT, occurrence_count INTEGER NOT NULL DEFAULT 0, last_occurrence_at TEXT,
        last_message_id TEXT, last_error TEXT, UNIQUE (sender, request_id)
      );
      CREATE INDEX schedules_due ON schedules(next_run_ms) WHERE cancelled_at IS NULL;
      CREATE TABLE attachment_blobs (
        sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image','text')), mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        uploader TEXT NOT NULL REFERENCES agents(agent_id),
        filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        last_referenced_ms INTEGER, expired_at TEXT
      );
      CREATE UNIQUE INDEX attachments_identity ON attachments(uploader,sha256,filename)
        WHERE expired_at IS NULL;
      CREATE INDEX attachments_lobby ON attachments(lobby_id,sequence);
      CREATE INDEX attachments_content ON attachments(sha256) WHERE expired_at IS NULL;
      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id), position INTEGER NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        PRIMARY KEY (message_id, position)
      );
      CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
      CREATE TABLE schedule_attachments (
        schedule_id TEXT NOT NULL REFERENCES schedules(id), position INTEGER NOT NULL,
        attachment_id TEXT NOT NULL REFERENCES attachments(id),
        PRIMARY KEY (schedule_id, position)
      );
      CREATE INDEX schedule_attachments_attachment ON schedule_attachments(attachment_id);
      CREATE TABLE attachment_uploads (
        uploader TEXT NOT NULL REFERENCES agents(agent_id), sha256 TEXT NOT NULL,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), created_ms INTEGER NOT NULL,
        PRIMARY KEY (uploader, sha256)
      );
      CREATE INDEX attachment_uploads_content ON attachment_uploads(sha256);
      CREATE TABLE admin_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, action TEXT NOT NULL,
        created_at TEXT NOT NULL, actor_kind TEXT, account_id TEXT, lobby_id TEXT, target TEXT,
        detail TEXT
      );
      CREATE INDEX admin_events_lobby ON admin_events(lobby_id, sequence);
      CREATE TABLE board_configs (
        lobby_id TEXT PRIMARY KEY REFERENCES lobbies(lobby_id),
        agents TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
        summary_model TEXT NOT NULL DEFAULT '${SUMMARY_MODELS[0]}',
        summary_effort TEXT NOT NULL DEFAULT 'low' CHECK (summary_effort IN ('low','medium','high'))
      );
      CREATE TABLE board_sources (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), room_id TEXT NOT NULL,
        repo TEXT NOT NULL, ref TEXT NOT NULL, notes TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (lobby_id, room_id)
      );
      CREATE TABLE board_notes (
        lobby_id TEXT NOT NULL, room_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL, files TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (lobby_id, room_id),
        FOREIGN KEY (lobby_id, room_id) REFERENCES board_sources(lobby_id, room_id) ON DELETE CASCADE
      );
      CREATE TABLE board_summaries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        created_at TEXT NOT NULL, created_ms INTEGER NOT NULL,
        input_hash TEXT NOT NULL, sources TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, summary TEXT, error TEXT,
        CHECK ((summary IS NULL) <> (error IS NULL))
      );
      CREATE INDEX board_summaries_lobby ON board_summaries(lobby_id, sequence);
      CREATE TABLE lobby_repos (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id), repo TEXT NOT NULL,
        added_at TEXT NOT NULL, PRIMARY KEY (lobby_id, repo)
      );
      CREATE TABLE board_viewers (
        lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        added_at TEXT NOT NULL, PRIMARY KEY (lobby_id, account_id)
      );
      CREATE INDEX board_viewers_account ON board_viewers(account_id);
      CREATE TABLE board_sessions (
        token_hash TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
      );
      CREATE INDEX board_sessions_lobby ON board_sessions(lobby_id);
      CREATE INDEX board_sessions_account ON board_sessions(account_id);
      CREATE TABLE board_handoffs (
        token_hash TEXT PRIMARY KEY, lobby_id TEXT NOT NULL REFERENCES lobbies(lobby_id),
        account_id TEXT NOT NULL REFERENCES accounts(account_id), expires_ms INTEGER NOT NULL
      );
      CREATE TABLE console_sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id),
        created_ms INTEGER NOT NULL, refreshed_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL
      );
      CREATE INDEX console_sessions_account ON console_sessions(account_id);
      CREATE TABLE sign_in_codes (
        email_key TEXT PRIMARY KEY, code_mac TEXT NOT NULL, created_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sign_in_limits (
        key TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, count INTEGER NOT NULL
      );
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
    this.run('INSERT INTO metadata(key,value) VALUES(?,?)', 'incarnation', randomUUID());
  }

  private key(value: string): string {
    // A bare agent name means the broker's only lobby, as for an owner request that names none.
    const identity = value.includes('/')
      ? parsePrincipal(value)
      : { lobby_id: this.soleLobby(), agent_id: AgentId.parse(value) };
    return qualifyAgent(identity.lobby_id, identity.agent_id);
  }
  /** An agent principal as an audit lobby and target. */
  private agentScope(id: string): [string, string] {
    const identity = parsePrincipal(id);
    return [identity.lobby_id, identity.agent_id];
  }
  private requireLobby(lobbyId: string): string {
    const id = LobbyId.parse(lobbyId);
    if (!this.one('SELECT 1 FROM lobbies WHERE lobby_id=?', id))
      fail(404, 'lobby_not_found', 'Unknown lobby');
    return id;
  }
  createLobby(lobbyId: string): { lobby_id: string } {
    const id = NewLobbyId.parse(lobbyId);
    return this.transaction(() => {
      this.insertLobby(id, null);
      this.audit(null, 'create_lobby', id);
      return { lobby_id: id };
    });
  }
  /** A new lobby, inside the caller's transaction: a free name that was never used before. */
  private insertLobby(id: string, owner: string | null): void {
    if (
      this.one(
        'SELECT 1 FROM lobbies WHERE lobby_id=? UNION ALL SELECT 1 FROM deleted_lobbies WHERE lobby_id=?',
        id,
        id,
      )
    )
      fail(409, 'lobby_exists', 'That lobby name is taken, or was used by a deleted lobby');
    if (Number(this.one('SELECT COUNT(*) AS n FROM lobbies')!.n) >= this.maxLobbies)
      fail(409, 'lobby_capacity', 'Lobby capacity reached');
    this.run(
      'INSERT INTO lobbies(lobby_id,owner_account,created_at) VALUES(?,?,?)',
      id,
      owner,
      this.iso(),
    );
  }
  /**
   * The lobby an owner request means when it names none: the broker's only lobby (0.8.3). A
   * broker with none or several has no such lobby, and the request must name one.
   */
  soleLobby(): string {
    const rows = this.all('SELECT lobby_id FROM lobbies ORDER BY lobby_id LIMIT 2');
    if (rows.length === 1) return String(rows[0]!.lobby_id);
    return fail(
      400,
      'lobby_required',
      rows.length
        ? "This broker has several lobbies: name one with ?lobby= (the CLI's --lobby)."
        : 'This broker has no lobby yet: create one with POST /v1/admin/lobbies (pocolobby lobby create NAME).',
    );
  }
  hasLobby(lobbyId: string): boolean {
    return Boolean(this.one('SELECT 1 FROM lobbies WHERE lobby_id=?', lobbyId));
  }
  lobbies(): { lobby_id: string; display_name: string | null; agent_count: number }[] {
    return this.all(
      "SELECT l.lobby_id,(SELECT value FROM metadata WHERE key='display_name:'||l.lobby_id) AS display_name,COUNT(a.agent_id) AS agent_count FROM lobbies l LEFT JOIN agents a ON a.lobby_id=l.lobby_id GROUP BY l.lobby_id ORDER BY l.lobby_id",
    ).map((row) => ({
      lobby_id: String(row.lobby_id),
      display_name: (row.display_name as string | null) ?? null,
      agent_count: Number(row.agent_count),
    }));
  }
  private room(lobbyId: string, roomId: string): Room {
    RoomId.parse(roomId);
    if (!this.one('SELECT 1 FROM rooms WHERE lobby_id=? AND room_id=?', lobbyId, roomId)) {
      if (this.one('SELECT 1 FROM archived_rooms WHERE lobby_id=? AND room_id=?', lobbyId, roomId))
        fail(409, 'room_archived', 'This room is archived; the lobby owner can restore it');
      fail(404, 'room_not_found', 'Unknown room');
    }
    return {
      lobby_id: lobbyId,
      room_id: roomId,
      members: this.all(
        'SELECT agent_id FROM room_members WHERE lobby_id=? AND room_id=? ORDER BY agent_id',
        lobbyId,
        roomId,
      ).map((row) => parsePrincipal(String(row.agent_id)).agent_id),
    };
  }
  private roomManager(actor: Actor, ownerLobbyId?: string): string {
    if (typeof actor === 'object')
      return this.ownedLobby(actor.account_id, ownerLobbyId ?? this.soleLobby());
    if (actor === 'owner') return this.requireLobby(ownerLobbyId ?? this.soleLobby());
    const principal = this.agent(actor);
    if (!principal.enabled || !principal.manage_rooms)
      fail(403, 'room_management_forbidden', 'Room-management permission is required');
    return principal.lobby_id;
  }
  rooms(lobbyId: string, viewerAgentId?: string): Room[] {
    this.requireLobby(lobbyId);
    let viewer: Agent | undefined;
    if (viewerAgentId !== undefined) {
      viewer = this.agent(viewerAgentId);
      if (!viewer.enabled || viewer.lobby_id !== lobbyId)
        fail(403, 'lobby_forbidden', 'Room discovery is limited to your lobby');
    }
    const rows =
      !viewer || viewer.manage_rooms
        ? this.all('SELECT room_id FROM rooms WHERE lobby_id=? ORDER BY room_id', lobbyId)
        : this.all(
            'SELECT room_id FROM room_members WHERE lobby_id=? AND agent_id=? ORDER BY room_id',
            lobbyId,
            this.key(viewerAgentId!),
          );
    return rows.map((row) => this.room(lobbyId, String(row.room_id)));
  }
  createRoom(actor: Actor, roomId: string, ownerLobbyId?: string): Room {
    RoomId.parse(roomId);
    return this.transaction(() => {
      const lobby = this.roomManager(actor, ownerLobbyId);
      if (this.one('SELECT 1 FROM rooms WHERE lobby_id=? AND room_id=?', lobby, roomId))
        fail(409, 'room_exists', 'Room already exists');
      if (this.one('SELECT 1 FROM archived_rooms WHERE lobby_id=? AND room_id=?', lobby, roomId))
        fail(
          409,
          'room_archived',
          'An archived room has this name; the lobby owner can restore it',
        );
      if (
        Number(this.one('SELECT COUNT(*) AS n FROM rooms WHERE lobby_id=?', lobby)!.n) >=
        this.maxRooms
      )
        fail(409, 'room_capacity', 'Room capacity reached for this lobby');
      this.run('INSERT INTO rooms(lobby_id,room_id) VALUES(?,?)', lobby, roomId);
      this.audit(actor, 'create_room', lobby, roomId);
      return this.room(lobby, roomId);
    });
  }
  setRoomMembers(actor: Actor, roomId: string, members: string[], ownerLobbyId?: string): Room {
    RoomId.parse(roomId);
    if (members.length > 100) fail(400, 'member_limit', 'A room supports at most 100 members');
    const names = [...new Set(members.map((id) => AgentId.parse(id)))];
    return this.transaction(() => {
      const lobby = this.roomManager(actor, ownerLobbyId);
      const previous = this.room(lobby, roomId);
      for (const id of names) this.row(qualifyAgent(lobby, id));
      this.applyMembers(previous, names);
      this.audit(actor, 'set_room_members', lobby, roomId, { members: names });
      return this.room(lobby, roomId);
    });
  }
  /**
   * Add and remove the named members, keeping everyone else (0.3.1). Adding a member or
   * removing a non-member changes nothing; every named agent must exist in the lobby.
   */
  changeRoomMembers(
    actor: Actor,
    roomId: string,
    changes: { add?: string[]; remove?: string[] },
    ownerLobbyId?: string,
  ): Room {
    RoomId.parse(roomId);
    const { add = [], remove = [] } = RoomMemberChangesSchema.parse(changes);
    return this.transaction(() => {
      const lobby = this.roomManager(actor, ownerLobbyId);
      const previous = this.room(lobby, roomId);
      for (const id of [...add, ...remove]) this.row(qualifyAgent(lobby, id));
      const next = new Set([...previous.members, ...add]);
      for (const id of remove) next.delete(id);
      if (next.size > 100) fail(400, 'member_limit', 'A room supports at most 100 members');
      this.applyMembers(previous, [...next]);
      this.audit(actor, 'change_room_members', lobby, roomId, { add, remove });
      return this.room(lobby, roomId);
    });
  }
  /**
   * Delete a room (0.3.1). Every unseen delivery of its messages is held, including scheduled
   * ones, and recurring schedules into it are cancelled, so a later room with the same ID
   * starts empty. Its messages and receipts stay as history. Its board notes source goes too:
   * unlike an archived room it cannot come back, and its notes would keep being read and
   * summarized as current work.
   */
  deleteRoom(actor: Actor, roomId: string, ownerLobbyId?: string): DeletedRoom {
    RoomId.parse(roomId);
    return this.transaction(() => {
      const lobby = this.roomManager(actor, ownerLobbyId);
      if (!this.one('SELECT 1 FROM rooms WHERE lobby_id=? AND room_id=?', lobby, roomId))
        fail(404, 'room_not_found', 'Unknown room; it may already have been deleted');
      const room = this.room(lobby, roomId);
      const held = this.holdRoomDeliveries(lobby, roomId, 'room_deleted');
      const schedules = this.cancelRoomSchedules(lobby, roomId, 'room_deleted');
      this.run('DELETE FROM room_members WHERE lobby_id=? AND room_id=?', lobby, roomId);
      this.run('DELETE FROM rooms WHERE lobby_id=? AND room_id=?', lobby, roomId);
      this.run('DELETE FROM board_sources WHERE lobby_id=? AND room_id=?', lobby, roomId);
      this.audit(actor, 'delete_room', lobby, roomId);
      return {
        lobby_id: lobby,
        room_id: roomId,
        deleted: true,
        former_members: room.members,
        held_deliveries: held,
        cancelled_schedules: schedules.map((schedule) => ({
          schedule_id: String(schedule.id),
          from: parsePrincipal(String(schedule.sender)).agent_id,
        })),
      };
    });
  }
  /** Make a room's members `next`: a removed member's unseen room deliveries are held. */
  private applyMembers(room: Room, next: string[]): void {
    for (const removed of room.members.filter((id) => !next.includes(id))) {
      const key = qualifyAgent(room.lobby_id, removed);
      this.holdRoomDeliveries(room.lobby_id, room.room_id, 'room_membership_revoked', key);
      this.run(
        'DELETE FROM room_members WHERE lobby_id=? AND room_id=? AND agent_id=?',
        room.lobby_id,
        room.room_id,
        key,
      );
    }
    for (const added of next.filter((id) => !room.members.includes(id)))
      this.run(
        'INSERT INTO room_members(lobby_id,room_id,agent_id) VALUES(?,?,?)',
        room.lobby_id,
        room.room_id,
        qualifyAgent(room.lobby_id, added),
      );
  }
  /**
   * Hold the unseen deliveries of a room's messages, for one recipient or all. Scheduled ones
   * are held too, due or not: release clears only the scheduled hold. Returns how many.
   */
  private holdRoomDeliveries(
    lobby: string,
    roomId: string,
    reason: 'room_membership_revoked' | 'room_deleted',
    agentKey?: string,
  ): number {
    return this.run(
      `UPDATE deliveries SET held_reason=? WHERE ${agentKey === undefined ? '' : 'agent_id=? AND '}seen_at IS NULL AND (held_reason IS NULL OR held_reason='scheduled') AND message_id IN (SELECT id FROM messages WHERE lobby_id=? AND room_id=?)`,
      reason,
      ...(agentKey === undefined ? [] : [agentKey]),
      lobby,
      roomId,
    );
  }

  /** Compiled statements by their SQL: the store runs a few hundred distinct ones. */
  private readonly statements = new Map<string, StatementSync>();
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= 1000) this.statements.clear();
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...params) as Row[];
  }
  /** Run a statement; returns how many rows it changed. */
  private run(sql: string, ...params: SQLInputValue[]): number {
    try {
      return Number(this.statement(sql).run(...params).changes);
    } catch (error) {
      this.rethrowDatabaseError(error);
    }
  }
  private rethrowDatabaseError(error: unknown): never {
    if (
      typeof error === 'object' &&
      error !== null &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      (error.errcode & 0xff) === 13
    ) {
      fail(507, 'storage_capacity', 'SQLite storage is full; no new operation was accepted');
    }
    throw error;
  }
  private transaction<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction. Never mask it with
      // a second ROLLBACK failure, and never retain a partially completed batch.
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* Preserve the original failure. */
        }
      }
      this.rethrowDatabaseError(error);
    }
  }
  private iso(): string {
    return new Date(this.clock()).toISOString();
  }
  private row(id: string): Row {
    id = this.key(id);
    return (
      this.one('SELECT * FROM agents WHERE agent_id=?', id) ??
      fail(404, 'agent_not_found', 'Unknown agent')
    );
  }
  /**
   * Record who changed what. `actor` is null or `owner` for the operator, an agent principal or
   * a console account. `agent` names the agent an operator action concerns (provisioning,
   * rotation); for an agent's own action the column holds that agent.
   */
  private audit(
    actor: Actor | null,
    action: string,
    lobby: string | null,
    target: string | null = null,
    detail: unknown = null,
    agent: string | null = null,
  ): void {
    const account = typeof actor === 'object' && actor !== null ? actor.account_id : null;
    const acting = typeof actor === 'string' && actor !== 'owner' ? this.key(actor) : null;
    this.run(
      'INSERT INTO admin_events(agent_id,action,created_at,actor_kind,account_id,lobby_id,target,detail) VALUES(?,?,?,?,?,?,?,?)',
      acting ?? agent,
      action,
      this.iso(),
      account ? 'account' : acting ? 'agent' : 'operator',
      account,
      lobby,
      target,
      detail === null ? null : JSON.stringify(detail),
    );
  }
  get incarnation(): string {
    return String(this.one("SELECT value FROM metadata WHERE key='incarnation'")!.value);
  }
  close(): void {
    this.db.close();
  }

  provision(raw: ProvisionInput): { agent: Agent; token: string } {
    const input = {
      ...ProvisionSchema.parse(raw),
      lobby_id: LobbyId.parse(raw.lobby_id ?? this.soleLobby()),
    };
    const id = qualifyAgent(input.lobby_id, input.agent_id);
    const secret = token();
    this.transaction(() => {
      if (input.agent_id === 'owner')
        fail(400, 'reserved_identity', 'owner is reserved for administration');
      this.requireLobby(input.lobby_id);
      if (this.one('SELECT 1 FROM agents WHERE agent_id=?', id))
        fail(409, 'agent_exists', 'Agent already exists');
      if (Number(this.one('SELECT COUNT(*) AS n FROM agents')!.n) >= this.maxAgents)
        fail(409, 'agent_capacity', 'Agent capacity reached');
      this.run(
        'INSERT INTO agents(agent_id,token_hash,role,can_broadcast,allowed_recipients,probe_nonce,lobby_id,manage_rooms) VALUES(?,?,?,?,?,?,?,?)',
        id,
        hash(secret),
        input.role,
        Number(input.can_broadcast),
        input.allowed_recipients === null ? null : JSON.stringify(input.allowed_recipients),
        randomUUID(),
        input.lobby_id,
        Number(input.manage_rooms),
      );
      this.run('INSERT INTO checkpoints(agent_id) VALUES(?)', id);
      this.audit(null, 'provision', input.lobby_id, input.agent_id, null, id);
    });
    return { agent: this.agent(id), token: secret };
  }

  authenticate(secret: string): string {
    const candidate = hash(secret);
    const row = this.one(
      'SELECT agent_id,token_hash,enabled FROM agents WHERE token_hash=?',
      candidate,
    );
    const comparison = row?.token_hash ? String(row.token_hash) : '0'.repeat(64);
    if (
      !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(comparison, 'hex')) ||
      !row ||
      !row.enabled
    ) {
      fail(401, 'unauthorized', 'Invalid or revoked credential');
    }
    return String(row!.agent_id);
  }

  agent(id: string): Agent {
    id = this.key(id);
    const row = this.row(id);
    // The agent's latest progress: a ready claim, acknowledgment or checkpoint, or a message it
    // sent (its schedules' occurrences are the broker's). A message written to its host before
    // that was handled or left on purpose, so it no longer suggests the agent cannot take turns.
    const sent = this.one(
      'SELECT MAX(created_ms) AS t FROM messages WHERE sender=? AND schedule_id IS NULL',
      id,
    )?.t;
    const progress = [
      (row.last_agent_seen_at as string | null) ?? '',
      sent === null || sent === undefined ? '' : new Date(Number(sent)).toISOString(),
    ].reduce((latest, time) => (time > latest ? time : latest));
    const pending = this.one(
      'SELECT COUNT(*) AS n, MAX(CASE WHEN attempts>=? AND next_attempt_at<=? THEN 1 ELSE 0 END) AS attention, COUNT(CASE WHEN notification_attempted_at>=? THEN 1 END) AS notified, MIN(CASE WHEN notification_attempted_at>=? THEN notification_attempted_at END) AS oldest_notified FROM deliveries WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL',
      this.retries.length,
      this.clock(),
      progress,
      progress,
      id,
    )!;
    return {
      agent_id: parsePrincipal(id).agent_id,
      lobby_id: String(row.lobby_id),
      manage_rooms: Boolean(row.manage_rooms),
      role: String(row.role),
      enabled: Boolean(row.enabled),
      paused: Boolean(row.paused),
      can_broadcast: Boolean(row.can_broadcast),
      allowed_recipients:
        row.allowed_recipients === null
          ? null
          : (JSON.parse(String(row.allowed_recipients)) as string[]),
      runtime_id: row.runtime_id as string | null,
      generation: Number(row.generation),
      ready: Boolean(row.ready),
      last_seen_at: row.last_seen_at as string | null,
      last_agent_seen_at: row.last_agent_seen_at as string | null,
      pending_count: Number(pending.n),
      // Written to its host since its latest progress and not yet acknowledged. The time is the
      // latest host write of the oldest such delivery (a reconnect rewrites it), so it
      // understates how long it waited.
      unseen_notified_count: Number(pending.notified),
      oldest_unseen_notified_at: (pending.oldest_notified as string | null) ?? null,
      notification_attention_required:
        Boolean(pending.attention) ||
        Boolean(
          row.runtime_id &&
          !row.ready &&
          Number(row.bootstrap_attempts) >= this.retries.length &&
          Number(row.bootstrap_next_at) <= this.clock(),
        ),
      last_message_at: this.lastMessageAt(id),
      owner_requests:
        Number(row.owner_requests) > 0
          ? {
              count: Number(row.owner_requests),
              text: String(row.owner_requests_text ?? ''),
              set_at: String(row.owner_requests_at),
            }
          : null,
    };
  }
  /**
   * The latest message an agent sent, not counting its schedules' occurrences, or direct message
   * it received, a scheduled one at its delivery. Each part walks an index from its newest end
   * and stops at the first match.
   */
  private lastMessageAt(id: string): string | null {
    const { lobby_id: lobby, agent_id: agent } = parsePrincipal(id);
    const row = this.one(
      `SELECT MAX(t) AS t FROM (
        SELECT MAX(created_ms) AS t FROM messages WHERE sender=? AND schedule_id IS NULL
        UNION ALL
        SELECT * FROM (SELECT created_ms FROM messages WHERE lobby_id=? AND target=?
          AND room_id IS NULL AND deliver_at_ms IS NULL ORDER BY created_ms DESC LIMIT 1)
        UNION ALL
        SELECT * FROM (SELECT released_ms FROM messages WHERE lobby_id=? AND released_ms IS NOT NULL
          AND target=? AND room_id IS NULL AND cancelled_at IS NULL ORDER BY released_ms DESC LIMIT 1)
      )`,
      id,
      lobby,
      agent,
      lobby,
      agent,
    );
    return row?.t === null || row?.t === undefined ? null : new Date(Number(row.t)).toISOString();
  }
  /** What an agent may do beyond messaging: enough for its tool catalog, without its activity. */
  permissions(id: string): { manage_rooms: boolean; can_broadcast: boolean } {
    const row = this.row(id);
    return { manage_rooms: Boolean(row.manage_rooms), can_broadcast: Boolean(row.can_broadcast) };
  }
  /**
   * Replaces what this agent waits on from the owner; a count of 0 clears it. Fenced by the
   * current runtime. The same text again, with any count, keeps the time it was set.
   */
  setOwnerRequests(id: string, auth: RuntimeAuth, raw: OwnerRequestsInput): OwnerRequests | null {
    id = this.key(id);
    const input = OwnerRequestsSchema.parse(raw);
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const clear = input.count === 0;
      const text = clear ? null : input.text.trim();
      const before = this.row(id);
      // The wait began when this text was first set; a new count for it is a correction.
      const same = Number(before.owner_requests) > 0 && before.owner_requests_text === text;
      this.run(
        'UPDATE agents SET owner_requests=?,owner_requests_text=?,owner_requests_at=? WHERE agent_id=?',
        input.count,
        text,
        clear ? null : same ? String(before.owner_requests_at) : this.iso(),
        id,
      );
      return this.agent(id).owner_requests;
    });
  }
  agents(lobbyId?: string): Agent[] {
    const rows =
      lobbyId === undefined
        ? this.all('SELECT agent_id FROM agents ORDER BY agent_id')
        : this.all(
            'SELECT agent_id FROM agents WHERE lobby_id=? ORDER BY agent_id',
            this.requireLobby(lobbyId),
          );
    return rows.map((row) => this.agent(String(row.agent_id)));
  }

  updateAgent(id: string, raw: UpdateAgentInput): Agent {
    id = this.key(id);
    const input = UpdateAgentSchema.parse(raw);
    this.transaction(() => {
      const previous = this.row(id);
      for (const name of [
        'role',
        'can_broadcast',
        'manage_rooms',
        'allowed_recipients',
        'enabled',
        'paused',
      ] as const) {
        if (input[name] === undefined) continue;
        const value = input[name];
        this.run(
          `UPDATE agents SET ${name}=? WHERE agent_id=?`,
          name === 'allowed_recipients'
            ? value === null
              ? null
              : JSON.stringify(value)
            : typeof value === 'boolean'
              ? Number(value)
              : String(value),
          id,
        );
      }
      if (input.enabled === false && previous.enabled) this.resetBinding(id);
      if (input.role !== undefined && input.role !== previous.role) {
        this.run(
          'UPDATE agents SET ready=0,probe_nonce=?,bootstrap_attempts=0,bootstrap_next_at=? WHERE agent_id=?',
          randomUUID(),
          this.clock(),
          id,
        );
      }
      this.audit(null, 'update_agent', ...this.agentScope(id), Object.keys(input), id);
    });
    return this.agent(id);
  }

  private resetBinding(id: string): void {
    id = this.key(id);
    this.row(id);
    this.run(
      'UPDATE agents SET runtime_id=NULL,generation=generation+1,ready=0,probe_nonce=?,bootstrap_attempts=0,bootstrap_next_at=?,owner_requests=0,owner_requests_text=NULL,owner_requests_at=NULL WHERE agent_id=?',
      randomUUID(),
      this.clock(),
      id,
    );
    this.resetDeliveryAttempts(id);
  }
  private resetDeliveryAttempts(id: string): void {
    this.run(
      'UPDATE deliveries SET attempts=0,next_attempt_at=? WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL',
      this.clock(),
      id,
    );
  }
  /**
   * A newly started process must prove its Channel again; earlier messages arrive as a
   * backlog summary. A scheduled message keeps its acceptance sequence, so the binding time
   * also separates one delivered before this binding from one that falls due after it.
   */
  private bindRuntime(id: string, runtimeId: string, generation: number): void {
    const backlog = Number(this.one('SELECT COALESCE(MAX(sequence),0) AS n FROM messages')!.n);
    this.run(
      'UPDATE agents SET runtime_id=?,generation=?,ready=0,probe_nonce=?,bootstrap_attempts=0,bootstrap_next_at=?,backlog_sequence=?,backlog_at=? WHERE agent_id=?',
      runtimeId,
      generation,
      randomUUID(),
      this.clock(),
      backlog,
      this.clock(),
      id,
    );
  }
  rotateToken(id: string): { token: string } {
    id = this.key(id);
    const secret = token();
    this.transaction(() => {
      this.resetBinding(id);
      this.run('UPDATE agents SET token_hash=? WHERE agent_id=?', hash(secret), id);
      this.audit(null, 'rotate_token', ...this.agentScope(id), null, id);
    });
    return { token: secret };
  }
  resetRuntime(id: string): void {
    id = this.key(id);
    this.transaction(() => {
      this.resetBinding(id);
      this.audit(null, 'reset_runtime', ...this.agentScope(id), null, id);
    });
  }
  retryNotifications(id: string): void {
    id = this.key(id);
    this.transaction(() => {
      this.row(id);
      this.resetDeliveryAttempts(id);
      this.run(
        'UPDATE agents SET bootstrap_attempts=0,bootstrap_next_at=? WHERE agent_id=?',
        this.clock(),
        id,
      );
      this.audit(null, 'retry_notifications', ...this.agentScope(id), null, id);
    });
  }

  /**
   * Without a generation, a newly started process claims the identity. When its runtime
   * already owns the binding (a resumed conversation), it gets a new generation that
   * fences any earlier process of that runtime. A reconnect of a running process supplies
   * its generation and succeeds only while that exact binding is current.
   */
  claimRuntime(id: string, runtimeId: string, generation?: number): RuntimeBinding {
    id = this.key(id);
    return this.transaction(() => {
      let row = this.row(id);
      if (!row.enabled) fail(403, 'agent_disabled', 'Agent is disabled');
      if (generation !== undefined) {
        if (row.runtime_id !== runtimeId || Number(row.generation) !== generation)
          fail(409, 'stale_runtime', 'Runtime no longer owns this agent');
      } else if (row.runtime_id === runtimeId) {
        this.bindRuntime(id, runtimeId, Number(row.generation) + 1);
        this.resetDeliveryAttempts(id);
        this.audit(id, 'resume_runtime', ...this.agentScope(id));
        row = this.row(id);
      } else if (
        this.one('SELECT 1 FROM runtime_history WHERE agent_id=? AND runtime_id=?', id, runtimeId)
      ) {
        fail(409, 'stale_runtime', 'A retired runtime cannot reclaim this identity');
      } else if (row.runtime_id) {
        fail(
          409,
          'runtime_conflict',
          'Another runtime owns this agent; owner replacement is required',
        );
      } else {
        this.bindRuntime(id, runtimeId, Math.max(Number(row.generation), 1));
        this.run('INSERT INTO runtime_history(agent_id,runtime_id) VALUES(?,?)', id, runtimeId);
        row = this.row(id);
      }
      return {
        runtime_id: runtimeId,
        generation: Number(row.generation),
        incarnation: this.incarnation,
        probe_nonce: String(row.probe_nonce),
        ready: Boolean(row.ready),
      };
    });
  }
  assertRuntime(id: string, auth: RuntimeAuth): void {
    id = this.key(id);
    const row = this.row(id);
    if (
      !row.enabled ||
      row.runtime_id !== auth.runtime_id ||
      row.generation !== auth.generation ||
      auth.incarnation !== this.incarnation
    ) {
      fail(409, 'stale_runtime', 'Runtime no longer owns this agent');
    }
  }
  ready(
    id: string,
    auth: RuntimeAuth,
    input: { context_revision: number; probe_nonce: string },
  ): void {
    id = this.key(id);
    this.transaction(() => {
      this.assertRuntime(id, auth);
      if (
        this.row(id).probe_nonce !== input.probe_nonce ||
        this.readCheckpoint(id).revision !== input.context_revision
      )
        fail(409, 'bootstrap_conflict', 'Bootstrap context or channel probe is stale');
      this.run('UPDATE agents SET ready=1,last_agent_seen_at=? WHERE agent_id=?', this.iso(), id);
    });
  }
  heartbeat(id: string, auth: RuntimeAuth): void {
    id = this.key(id);
    this.assertRuntime(id, auth);
    this.run('UPDATE agents SET last_seen_at=? WHERE agent_id=?', this.iso(), id);
  }

  /** Delivery state and API hold reason; scheduled and cancelled are states, not holds. */
  private deliveryFacts(row: Row): { state: DeliveryState; held_reason: string | null } {
    const held = row.held_reason as string | null;
    if (held === SCHEDULED || held === CANCELLED) return { state: held, held_reason: null };
    if (held) return { state: 'held', held_reason: held };
    return { state: row.seen_at ? 'seen' : 'pending', held_reason: null };
  }
  private message(row: Row, includeHeldContent = false): Message {
    const result: Message = {
      id: String(row.id),
      lobby_id: String(row.lobby_id),
      room_id: row.room_id as string | null,
      sequence: Number(row.sequence),
      from: parsePrincipal(String(row.sender)).agent_id,
      to: String(row.target),
      priority: row.priority as 'info' | 'important',
      content: String(row.content),
      correlation_id: row.correlation_id as string | null,
      reply_to: row.reply_to as string | null,
      created_at: String(row.created_at),
      kind: (row.kind as MessageKind | null) ?? null,
      reply_expected: row.reply_expected === null ? null : Boolean(row.reply_expected),
      ...(row.details === null ? {} : JSON.parse(String(row.details))),
    };
    if (row.notify_when_seen) result.notify_when_seen = true;
    if (row.deliver_at_ms !== null) {
      result.deliver_at = new Date(Number(row.deliver_at_ms)).toISOString();
      result.delivered_at =
        row.released_ms === null ? null : new Date(Number(row.released_ms)).toISOString();
      result.late = Boolean(row.late);
    }
    if (row.schedule_id !== null) result.schedule_id = String(row.schedule_id);
    if (row.cancelled_at !== null) result.cancelled_at = String(row.cancelled_at);
    const attachments = this.messageAttachments(String(row.id));
    if (attachments.length) result.attachments = attachments;
    if (
      'seen_at' in row &&
      (!('delivery_recipient_id' in row) || row.delivery_recipient_id !== null)
    ) {
      const facts = this.deliveryFacts(row);
      result.agent_seen_at = row.seen_at as string | null;
      result.receipt_seq = row.receipt_seq === null ? null : Number(row.receipt_seq);
      result.delivery_state = facts.state;
      result.held_reason = facts.held_reason;
      if (facts.held_reason && !includeHeldContent) {
        result.content = `[Held: ${facts.held_reason.replaceAll('_', ' ')}]`;
        delete result.attachments;
        // Structured fields carry substance too (a recommendation, an evidence location).
        for (const field of DETAIL_FIELDS) delete result[field];
      }
    }
    return result;
  }
  private attachmentInfo(row: Row): AttachmentInfo {
    return {
      id: String(row.id),
      filename: String(row.filename),
      mime_type: String(row.mime_type),
      size: Number(row.size),
      sha256: String(row.sha256),
      ...(row.expired_at === null ? {} : { expired_at: String(row.expired_at) }),
    };
  }
  private messageAttachments(messageId: string): AttachmentInfo[] {
    return this.all(
      'SELECT a.* FROM message_attachments m JOIN attachments a ON a.id=m.attachment_id WHERE m.message_id=? ORDER BY m.position',
      messageId,
    ).map((row) => this.attachmentInfo(row));
  }
  private compactAttachments(messageId: string): EventAttachment[] {
    return this.messageAttachments(messageId).map(({ id, filename, mime_type, size }) => ({
      id,
      filename,
      mime_type,
      size,
    }));
  }
  private header(row: Row): MessageHeader {
    return {
      id: String(row.id),
      from: parsePrincipal(String(row.sender)).agent_id,
      to: String(row.target),
      ...addressedOf(row.details),
      room_id: row.room_id as string | null,
      priority: row.priority as 'info' | 'important',
      created_at: String(row.created_at),
      kind: (row.kind as MessageKind | null) ?? null,
      ...(() => {
        const attachments = this.compactAttachments(String(row.id));
        return attachments.length ? { attachments } : {};
      })(),
    };
  }
  /** Recipient facts for the given messages, keyed by message ID. Callers scope the IDs. */
  private recipientDeliveries(messageIds: string[]): Map<string, RecipientDelivery[]> {
    const result = new Map<string, RecipientDelivery[]>();
    if (!messageIds.length) return result;
    for (const row of this.all(
      'SELECT message_id,agent_id,seen_at,held_reason,notification_attempted_at FROM deliveries WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY agent_id',
      JSON.stringify(messageIds),
    )) {
      const list = result.get(String(row.message_id)) ?? [];
      const facts = this.deliveryFacts(row);
      list.push({
        agent_id: parsePrincipal(String(row.agent_id)).agent_id,
        delivery_state: facts.state,
        notification_attempted_at: row.notification_attempted_at as string | null,
        agent_seen_at: row.seen_at as string | null,
        held_reason: facts.held_reason,
      });
      result.set(String(row.message_id), list);
    }
    return result;
  }
  private stored(row: Row, duplicate: boolean): StoredMessage {
    const deliveries = this.recipientDeliveries([String(row.id)]).get(String(row.id)) ?? [];
    return {
      status: 'stored',
      message: this.message(row),
      recipients: deliveries.map((delivery) => delivery.agent_id),
      deliveries,
      duplicate,
    };
  }

  send(sender: string, raw: SendInput, ownerLobbyId?: string): StoredMessage {
    const input = SendSchema.parse(raw);
    const isOwner = sender === 'owner';
    sender = isOwner
      ? qualifyAgent(this.requireLobby(ownerLobbyId ?? this.soleLobby()), 'owner')
      : this.key(sender);
    const lobby = parsePrincipal(sender).lobby_id;
    return this.transaction(() => {
      const principal = isOwner ? null : this.agent(sender);
      if (principal && !principal.enabled) fail(403, 'agent_disabled', 'Sender is disabled');
      const fingerprint = hash(JSON.stringify(canonicalSend(input)));
      const existing = this.one(
        'SELECT * FROM messages WHERE sender=? AND request_id=?',
        sender,
        input.client_request_id,
      );
      // A retry returns the original before any time-dependent check, so retrying a
      // scheduled send after its deliver_at has passed still finds the stored message.
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          fail(409, 'idempotency_conflict', 'Retry key was already used for a different request');
        return this.stored(existing, true);
      }
      if (input.client_request_id.startsWith(RESERVED_REQUEST_PREFIX))
        fail(
          400,
          'reserved_request_id',
          `Request IDs starting with ${RESERVED_REQUEST_PREFIX} are reserved`,
        );
      admitContent(input.content);
      if (isOwner && input.notify_when_seen)
        fail(
          400,
          'receipts_unavailable',
          'The owner has no event stream for read receipts; read history instead',
        );
      if (isOwner && input.attachments)
        fail(
          400,
          'attachments_unavailable',
          'Only agents attach files: their bridge uploads them before the send',
        );
      const now = this.clock();
      let deliverAt: number | null = null;
      if (input.deliver_at !== undefined) {
        deliverAt = Date.parse(input.deliver_at);
        if (deliverAt < now - SCHEDULE_PAST_TOLERANCE_MS || deliverAt > now + MAX_SCHEDULE_AHEAD_MS)
          fail(
            400,
            'deliver_at_out_of_range',
            'deliver_at must be at most 30 days ahead and at most 5 minutes in the past',
          );
        if (deliverAt > now && this.undeliveredCount(sender) >= this.maxScheduled)
          fail(
            409,
            'schedule_capacity',
            `At most ${this.maxScheduled} undelivered scheduled messages per sender`,
          );
      }
      return this.accept(sender, lobby, principal, input, { fingerprint, now, deliverAt });
    });
  }

  private undeliveredCount(sender: string): number {
    return Number(
      this.one(
        'SELECT COUNT(*) AS n FROM messages INDEXED BY messages_due WHERE sender=? AND deliver_at_ms IS NOT NULL AND released_ms IS NULL AND cancelled_at IS NULL',
        sender,
      )!.n,
    );
  }

  /** The frozen recipient set of a send; throws when the sender may not address it. */
  private recipients(
    sender: string,
    lobby: string,
    principal: Agent | null,
    input: Pick<ParsedSend, 'to' | 'room'>,
  ): string[] {
    const isOwner = principal === null;
    const allowed = (id: string) =>
      principal?.allowed_recipients == null || principal.allowed_recipients.includes(id);
    if (input.room !== undefined) {
      this.room(lobby, input.room);
      if (
        !isOwner &&
        !this.one(
          'SELECT 1 FROM room_members WHERE lobby_id=? AND room_id=? AND agent_id=?',
          lobby,
          input.room,
          sender,
        )
      )
        fail(403, 'room_membership_required', 'Room messaging requires membership');
      if (Array.isArray(input.to))
        return this.namedMembers(sender, lobby, input.room, input.to, allowed);
      return this.all(
        'SELECT a.agent_id FROM room_members r JOIN agents a ON a.agent_id=r.agent_id WHERE r.lobby_id=? AND r.room_id=? AND a.enabled=1 AND a.agent_id<>? ORDER BY a.agent_id',
        lobby,
        input.room,
        sender,
      )
        .map((row) => String(row.agent_id))
        .filter((key) => allowed(parsePrincipal(key).agent_id));
    }
    if (input.to === '*') {
      if (principal && !principal.can_broadcast)
        fail(403, 'broadcast_forbidden', 'Broadcast permission is required');
      return this.all(
        'SELECT agent_id FROM agents WHERE lobby_id=? AND enabled=1 AND agent_id<>? ORDER BY agent_id',
        lobby,
        sender,
      )
        .map((row) => String(row.agent_id))
        .filter((key) => allowed(parsePrincipal(key).agent_id));
    }
    // A list of names needs a room, which the schema enforces.
    const to = input.to as string;
    if (!allowed(to)) fail(403, 'recipient_forbidden', 'Recipient is outside the allowed peer set');
    const recipientKey = qualifyAgent(lobby, to);
    const recipient = this.row(recipientKey);
    if (!recipient.enabled) fail(409, 'recipient_disabled', 'Recipient is disabled');
    return [recipientKey];
  }

  /**
   * The members a room message names. Each must be another enabled member the sender may
   * address; one that is not refuses the whole send, so it never reaches only part of its list.
   */
  private namedMembers(
    sender: string,
    lobby: string,
    room: string,
    names: string[],
    allowed: (id: string) => boolean,
  ): string[] {
    return names.map((name) => {
      const key = qualifyAgent(lobby, name);
      if (key === sender)
        fail(
          400,
          'recipient_is_sender',
          'A room message never reaches its sender; leave yourself out of to',
        );
      const member = this.one(
        'SELECT a.enabled FROM room_members r JOIN agents a ON a.agent_id=r.agent_id WHERE r.lobby_id=? AND r.room_id=? AND r.agent_id=?',
        lobby,
        room,
        key,
      );
      if (!member) fail(409, 'not_room_member', `${name} is not a member of room ${room}`);
      if (!member!.enabled) fail(409, 'recipient_disabled', `${name} is disabled`);
      if (!allowed(name))
        fail(403, 'recipient_forbidden', `${name} is outside the allowed peer set`);
      return key;
    });
  }

  /**
   * Authorize, bound and store one new message with its deliveries, inside the caller's
   * transaction. A future deliverAt holds every delivery as scheduled until releaseDue.
   * A schedule occurrence is released at once and carries its slot as deliver_at.
   */
  private accept(
    sender: string,
    lobby: string,
    principal: Agent | null,
    input: ParsedSend,
    options: { fingerprint: string; now: number; deliverAt: number | null; scheduleId?: string },
  ): StoredMessage {
    const { now, deliverAt } = options;
    const occurrence = options.scheduleId !== undefined;
    const recipients = this.recipients(sender, lobby, principal, input);
    // A reply may name a message that expired after its day: multi-day work answers old
    // assignments. Only a stored message the sender cannot see is refused.
    if (
      input.reply_to &&
      this.one('SELECT 1 FROM messages WHERE id=?', input.reply_to) &&
      !this.one(
        'SELECT 1 FROM messages m WHERE m.id=? AND m.lobby_id=? AND (?=1 OR m.sender=? OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.agent_id=? AND d.held_reason IS NULL))',
        input.reply_to,
        lobby,
        Number(principal === null),
        sender,
        sender,
      )
    )
      fail(404, 'reply_not_found', 'Reply target is not accessible');
    // Occurrences are paced by their schedule; they neither use nor count against this limit.
    if (
      !occurrence &&
      Number(
        this.one(
          'SELECT COUNT(*) AS n FROM messages WHERE sender=? AND created_ms>? AND schedule_id IS NULL',
          sender,
          now - 60_000,
        )!.n,
      ) >= 60
    )
      fail(429, 'send_rate_limit', 'At most 60 new messages per sender per minute');
    const named = namedMembers(input.to);
    const details = named
      ? { ...messageDetails(input), addressed_to: named }
      : messageDetails(input);
    const bytes =
      Buffer.byteLength(input.content) + (details ? Buffer.byteLength(JSON.stringify(details)) : 0);
    // Per lobby, so one lobby filling its share cannot stop every other lobby's sends. The total
    // over all lobbies reads only the messages_bytes index; a lobby's own sum reads its rows, large
    // ones page by page, so it runs only once that total could reach the cap.
    const over = (sql: string, ...params: SQLInputValue[]) =>
      Number(this.one(sql, ...params)!.n) + bytes > this.maxStored;
    if (
      over('SELECT COALESCE(SUM(byte_size),0) AS n FROM messages') &&
      over('SELECT COALESCE(SUM(byte_size),0) AS n FROM messages WHERE lobby_id=?', lobby)
    )
      fail(507, 'storage_capacity', "This lobby's stored message content capacity is reached");
    for (const recipient of recipients) {
      // Scheduled deliveries count too: they arrive later without another capacity check.
      const queued = Number(
        this.one(
          "SELECT COALESCE(SUM(m.byte_size),0) AS n FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.agent_id=? AND d.seen_at IS NULL AND (d.held_reason IS NULL OR d.held_reason='scheduled')",
          recipient,
        )!.n,
      );
      if (queued + bytes > this.maxPending)
        fail(409, 'inbox_capacity', `Recipient ${recipient} has insufficient inbox capacity`);
    }
    // Last, so a send that is refused anyway never asks its bridge to upload.
    const attachments = this.resolveAttachments(sender, lobby, input.attachments, now);
    const held = !occurrence && deliverAt !== null && deliverAt > now;
    const released = deliverAt === null || held ? null : now;
    // Only a schedule's occurrence can be late here; a one-off deliver_at a little in the past
    // is clock skew, measured from its creation as release() does.
    const late = occurrence && now - deliverAt! > this.lateAfter;
    // No kind unless the sender chose one; reply_expected then follows that kind's default.
    const kind = input.kind ?? null;
    const replyExpected = input.reply_expected ?? (kind ? defaultReplyExpected(kind) : null);
    const id = randomUUID();
    this.run(
      'INSERT INTO messages(id,sender,request_id,fingerprint,target,priority,content,correlation_id,reply_to,created_at,created_ms,byte_size,lobby_id,room_id,kind,reply_expected,details,notify_when_seen,deliver_at_ms,released_ms,late,schedule_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      sender,
      input.client_request_id,
      options.fingerprint,
      Array.isArray(input.to) ? '*' : input.to,
      input.priority,
      input.content,
      input.correlation_id ?? null,
      input.reply_to ?? null,
      new Date(now).toISOString(),
      now,
      bytes,
      lobby,
      input.room ?? null,
      kind,
      replyExpected === null ? null : Number(replyExpected),
      details ? JSON.stringify(details) : null,
      Number(input.notify_when_seen ?? false),
      deliverAt,
      released,
      Number(late),
      options.scheduleId ?? null,
    );
    for (const recipient of recipients)
      this.run(
        'INSERT INTO deliveries(message_id,agent_id,next_attempt_at,held_reason) VALUES(?,?,?,?)',
        id,
        recipient,
        held ? deliverAt! : now + (input.priority === 'info' ? this.infoDelay : 0),
        held ? SCHEDULED : null,
      );
    // Retention counts from when recipients get the message. A scheduled one keeps its files
    // while it waits, however late it is released, and its release counts as their use; once
    // cancelled, its planned time no longer holds them.
    this.linkAttachments(sender, attachments, 'message', id, now);
    return this.stored(this.one('SELECT * FROM messages WHERE id=?', id)!, false);
  }

  // ----- Attachments -----

  /** Distinct content a lobby holds: its live attachments and pending uploads. */
  private lobbyAttachmentBytes(lobby: string): number {
    return Number(
      this.one(
        'SELECT COALESCE(SUM(size),0) AS n FROM attachment_blobs WHERE sha256 IN (SELECT sha256 FROM attachments WHERE lobby_id=?1 AND expired_at IS NULL UNION SELECT sha256 FROM attachment_uploads WHERE lobby_id=?1)',
        lobby,
      )!.n,
    );
  }
  private lobbyHolds(lobby: string, sha256: string): boolean {
    return Boolean(
      this.one(
        'SELECT 1 FROM attachments WHERE lobby_id=?1 AND sha256=?2 AND expired_at IS NULL UNION ALL SELECT 1 FROM attachment_uploads WHERE lobby_id=?1 AND sha256=?2 LIMIT 1',
        lobby,
        sha256,
      ),
    );
  }
  private kindLimit(kind: AttachmentKind): number {
    return kind === 'image' ? this.maxImageBytes : this.maxTextBytes;
  }
  private tooLarge(name: string, size: number, kind: AttachmentKind): never {
    return fail(
      413,
      'attachment_too_large',
      `${name} is ${formatBytes(size)}; this broker accepts ${kind} attachments up to ${formatBytes(this.kindLimit(kind))} (${ENVIRONMENT_NAMES[kind]}). Nothing was stored.`,
    );
  }
  private quotaFull(lobby: string, needed: number): never {
    return fail(
      507,
      'storage_capacity',
      `Attachment storage for lobby ${lobby} is full: ${formatBytes(this.lobbyAttachmentBytes(lobby))} of ${formatBytes(this.maxLobbyAttachments)} used and ${formatBytes(needed)} more needed (${ENVIRONMENT_NAMES.lobby}). Nothing was stored; ask the owner, or wait for retention to free space.`,
    );
  }

  /**
   * The sender's attachments for a send, inside its transaction. Each must be content this
   * sender uploaded earlier, either under the same name (reused) or as a pending upload (a new
   * attachment). Anything missing fails with attachment_upload_required and the missing hashes,
   * before anything is stored; the bridge uploads them and repeats the identical request.
   */
  private resolveAttachments(
    sender: string,
    lobby: string,
    descriptors: AttachmentDescriptor[] | undefined,
    now: number,
  ): string[] {
    if (!descriptors?.length) return [];
    for (const item of descriptors)
      if (item.size > this.kindLimit(kindOf(item.mime_type)))
        this.tooLarge(item.filename, item.size, kindOf(item.mime_type));
    const resolved: (string | AttachmentDescriptor)[] = [];
    const missing = new Map<string, number>();
    for (const item of descriptors) {
      const existing = this.one(
        'SELECT * FROM attachments WHERE uploader=? AND sha256=? AND filename=? AND expired_at IS NULL',
        sender,
        item.sha256,
        item.filename,
      );
      const blob = this.one('SELECT * FROM attachment_blobs WHERE sha256=?', item.sha256);
      // Possession is proven only by this sender's own upload, never by knowing a hash.
      const proven =
        existing ??
        this.one(
          'SELECT 1 FROM attachment_uploads WHERE uploader=? AND sha256=?',
          sender,
          item.sha256,
        ) ??
        this.one(
          'SELECT 1 FROM attachments WHERE uploader=? AND sha256=? AND expired_at IS NULL',
          sender,
          item.sha256,
        );
      if (!proven || !blob) {
        missing.set(item.sha256, item.size);
        continue;
      }
      if (
        Number(blob.size) !== item.size ||
        blob.kind !== kindOf(item.mime_type) ||
        (blob.kind === 'image' && blob.mime_type !== item.mime_type) ||
        (existing && existing.mime_type !== item.mime_type)
      )
        fail(
          400,
          'attachment_mismatch',
          `${item.filename} does not match the uploaded content with that SHA-256 (size or type differs). Nothing was stored.`,
        );
      resolved.push(existing ? String(existing.id) : item);
    }
    if (missing.size) {
      const needed = [...missing]
        .filter(([sha256]) => !this.lobbyHolds(lobby, sha256))
        .reduce((total, [, size]) => total + size, 0);
      if (this.lobbyAttachmentBytes(lobby) + needed > this.maxLobbyAttachments)
        this.quotaFull(lobby, needed);
      fail(
        409,
        'attachment_upload_required',
        `Upload ${missing.size} attached file${missing.size === 1 ? '' : 's'} first, then repeat this request unchanged. Nothing was stored.`,
        { missing: [...missing.keys()] },
      );
    }
    return resolved.map((item) => {
      if (typeof item === 'string') return item;
      const id = randomUUID();
      this.run(
        'INSERT INTO attachments(id,lobby_id,uploader,filename,mime_type,size,sha256,created_at,created_ms) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        lobby,
        sender,
        item.filename,
        item.mime_type,
        item.size,
        item.sha256,
        new Date(now).toISOString(),
        now,
      );
      return id;
    });
  }
  /** Reference attachments from a message or schedule; their pending uploads are now used. */
  private linkAttachments(
    sender: string,
    ids: string[],
    owner: 'message' | 'schedule',
    ownerId: string,
    referencedAt: number,
  ): void {
    ids.forEach((attachmentId, position) => {
      this.run(
        owner === 'message'
          ? 'INSERT INTO message_attachments(message_id,position,attachment_id) VALUES(?,?,?)'
          : 'INSERT INTO schedule_attachments(schedule_id,position,attachment_id) VALUES(?,?,?)',
        ownerId,
        position,
        attachmentId,
      );
      this.run(
        'UPDATE attachments SET last_referenced_ms=MAX(COALESCE(last_referenced_ms,0),?) WHERE id=?',
        referencedAt,
        attachmentId,
      );
      this.run(
        'DELETE FROM attachment_uploads WHERE uploader=? AND sha256=(SELECT sha256 FROM attachments WHERE id=?)',
        sender,
        attachmentId,
      );
    });
  }

  private attachmentsPath(): string {
    if (!this.attachmentsDirectory)
      this.attachmentsDirectory = mkdtempSync(join(tmpdir(), 'pocolobby-attachments-'));
    mkdirSync(this.attachmentsDirectory, { recursive: true, mode: 0o700 });
    return this.attachmentsDirectory;
  }
  private blobPath(sha256: string): string {
    return join(this.attachmentsPath(), sha256);
  }

  /**
   * Store uploaded content for the uploading agent, fenced by its runtime. The content is
   * checked against its SHA-256 and recognized by its bytes. Identical content is stored once;
   * an upload of content already on disk only records that this agent holds it. The upload is
   * pending until a send references it, and is removed after the grace period otherwise.
   */
  uploadAttachment(
    id: string,
    auth: RuntimeAuth,
    sha256: string,
    bytes: Buffer,
  ): { sha256: string; size: number; kind: AttachmentKind; mime_type: string } {
    id = this.key(id);
    if (!/^[0-9a-f]{64}$/u.test(sha256))
      fail(400, 'invalid_request', 'Name the upload by its lowercase hex SHA-256');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      fail(400, 'attachment_hash_mismatch', 'The uploaded bytes do not have that SHA-256');
    const detected = kindOfBytes(bytes);
    if (!detected)
      return fail(
        415,
        'attachment_type',
        'Attach PNG, JPEG, GIF or WebP images, or UTF-8 text documents',
      );
    const kind: AttachmentKind = detected;
    if (bytes.length > this.kindLimit(kind)) this.tooLarge('The upload', bytes.length, kind);
    const mime = kind === 'image' ? sniffImage(bytes)! : 'text/plain';
    const now = this.clock();
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const lobby = String(this.row(id).lobby_id);
      if (
        !this.lobbyHolds(lobby, sha256) &&
        this.lobbyAttachmentBytes(lobby) + bytes.length > this.maxLobbyAttachments
      )
        this.quotaFull(lobby, bytes.length);
      const path = this.blobPath(sha256);
      const present = statSync(path, { throwIfNoEntry: false })?.size === bytes.length;
      if (!present) {
        if (this.freeDisk(this.attachmentsPath()) - bytes.length < this.diskReserve)
          fail(
            507,
            'storage_capacity',
            `The broker's disk is nearly full: storing ${formatBytes(bytes.length)} would leave less than the ${formatBytes(this.diskReserve)} reserved for the database (${ENVIRONMENT_NAMES.reserve}). Nothing was stored; the owner must free or extend the volume.`,
          );
        this.writeBlob(path, bytes);
      }
      this.run(
        'INSERT OR IGNORE INTO attachment_blobs(sha256,size,kind,mime_type,created_at) VALUES(?,?,?,?,?)',
        sha256,
        bytes.length,
        kind,
        mime,
        new Date(now).toISOString(),
      );
      this.run(
        'INSERT INTO attachment_uploads(uploader,sha256,lobby_id,created_ms) VALUES(?,?,?,?) ON CONFLICT(uploader,sha256) DO UPDATE SET created_ms=excluded.created_ms',
        id,
        sha256,
        lobby,
        now,
      );
      return { sha256, size: bytes.length, kind, mime_type: mime };
    });
  }
  /** Write through a temporary file, so a crash never leaves partial content under its hash. */
  private writeBlob(path: string, bytes: Buffer): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = openSync(temporary, 'wx', 0o600);
      try {
        let written = 0;
        while (written < bytes.length)
          written += writeSync(handle, bytes, written, bytes.length - written);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Never created, or already renamed. */
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
        fail(507, 'storage_capacity', "The broker's disk is full; nothing was stored");
      throw error;
    }
  }

  /**
   * An attachment the viewer may read: its uploader, or a recipient of a message referencing
   * it whose delivery is visible (not scheduled, cancelled or held). Anything else, including
   * another lobby's attachment, is reported as not found.
   */
  private accessibleAttachment(viewer: string, attachmentId: string): Row {
    viewer = this.key(viewer);
    const lobby = parsePrincipal(viewer).lobby_id;
    return (
      this.one(
        'SELECT a.* FROM attachments a WHERE a.id=?1 AND a.lobby_id=?2 AND (a.uploader=?3 OR EXISTS (SELECT 1 FROM message_attachments m JOIN deliveries d ON d.message_id=m.message_id WHERE m.attachment_id=a.id AND d.agent_id=?3 AND d.held_reason IS NULL))',
        attachmentId,
        lobby,
        viewer,
      ) ?? fail(404, 'attachment_not_found', 'No attachment with that ID is available to you')
    );
  }
  /** Metadata of an attachment the viewer may read. */
  attachment(
    viewer: string,
    attachmentId: string,
  ): AttachmentInfo & { from: string; created_at: string } {
    const row = this.accessibleAttachment(viewer, attachmentId);
    return {
      ...this.attachmentInfo(row),
      from: parsePrincipal(String(row.uploader)).agent_id,
      created_at: String(row.created_at),
    };
  }
  /** Where a viewer may read an attachment's content, after checking access and retention. */
  attachmentFile(
    viewer: string,
    attachmentId: string,
  ): { info: AttachmentInfo; path: string; size: number } {
    const row = this.accessibleAttachment(viewer, attachmentId);
    const info = this.attachmentInfo(row);
    const gone = (): never =>
      fail(
        410,
        'attachment_expired',
        `${info.filename} is no longer stored: content is kept for a limited time after its last message. Ask the sender to attach it again.`,
      );
    if (info.expired_at) gone();
    const path = this.blobPath(info.sha256);
    const size = statSync(path, { throwIfNoEntry: false })?.size;
    return size === undefined ? gone() : { info, path, size };
  }

  /** The owner's view of a lobby's attachments, oldest first, with what references them. */
  attachments(
    lobbyId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Page<AttachmentRecord> {
    const lobby = this.requireLobby(lobbyId);
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 50;
    const rows = this.all(
      'SELECT * FROM attachments WHERE lobby_id=? AND sequence>? ORDER BY sequence LIMIT ?',
      lobby,
      cursor,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        ...this.attachmentInfo(row),
        lobby_id: lobby,
        uploader: parsePrincipal(String(row.uploader)).agent_id,
        created_at: String(row.created_at),
        last_referenced_at:
          row.last_referenced_ms === null
            ? null
            : new Date(Number(row.last_referenced_ms)).toISOString(),
        messages: this.all(
          'SELECT message_id FROM message_attachments WHERE attachment_id=? ORDER BY rowid',
          String(row.id),
        ).map((entry) => String(entry.message_id)),
        schedules: this.all(
          'SELECT schedule_id FROM schedule_attachments WHERE attachment_id=? ORDER BY rowid',
          String(row.id),
        ).map((entry) => String(entry.schedule_id)),
      })),
      next_cursor: rows.length > limit ? Number(page.at(-1)!.sequence) : null,
    };
  }
  attachmentUsage(lobbyId: string): AttachmentUsage {
    const lobby = this.requireLobby(lobbyId);
    const count = (sql: string) => Number(this.one(sql, lobby)!.n);
    let disk: AttachmentUsage['disk'] = null;
    try {
      disk = { free_bytes: this.freeDisk(this.attachmentsPath()), reserve_bytes: this.diskReserve };
    } catch {
      /* Unknown on this platform. */
    }
    return {
      lobby_id: lobby,
      used_bytes: this.lobbyAttachmentBytes(lobby),
      quota_bytes: this.maxLobbyAttachments,
      files: count(
        'SELECT COUNT(*) AS n FROM (SELECT sha256 FROM attachments WHERE lobby_id=?1 AND expired_at IS NULL UNION SELECT sha256 FROM attachment_uploads WHERE lobby_id=?1)',
      ),
      attachments: count(
        'SELECT COUNT(*) AS n FROM attachments WHERE lobby_id=? AND expired_at IS NULL',
      ),
      expired: count(
        'SELECT COUNT(*) AS n FROM attachments WHERE lobby_id=? AND expired_at IS NOT NULL',
      ),
      pending_uploads: count('SELECT COUNT(*) AS n FROM attachment_uploads WHERE lobby_id=?'),
      limits: {
        max_image_bytes: this.maxImageBytes,
        max_text_bytes: this.maxTextBytes,
        retention_days: this.attachmentRetention / (24 * 60 * 60 * 1000),
        upload_grace_seconds: this.attachmentGrace / 1000,
      },
      disk,
    };
  }

  /** Throws unless the database answers; health checks use it without reading any data. */
  healthy(): void {
    this.one('SELECT 1');
  }

  /**
   * Remove notification attempts older than a day that no unseen delivery still names. They serve
   * only the rate and receipt windows (minutes) and an unseen delivery's last attempt, so they
   * never grow into the page budget.
   */
  pruneNotificationAttempts(now = this.clock()): number {
    return this.run(
      'DELETE FROM notification_attempts WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.last_notification_id=notification_attempts.id AND d.seen_at IS NULL)',
      new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    );
  }

  /**
   * Messages are kept at most a day (Johan's word): each goes 24 hours after it reached its
   * recipients, a scheduled one after its delivery, with its deliveries, receipts and attachment
   * references. A scheduled message still waiting for its time stays. Schedules cancelled more
   * than a day ago go too. A retry of a send whose message has gone is a new message.
   */
  pruneMessages(): number {
    const edge = this.clock() - MESSAGE_RETENTION_MS;
    const cancelledEdge = new Date(edge).toISOString();
    // Delivered or sent a day ago; a cancelled scheduled message a day after its cancellation,
    // so repeating the cancellation still finds it.
    const expired =
      'SELECT id FROM messages WHERE (cancelled_at IS NULL AND COALESCE(released_ms,created_ms)<?1 AND (deliver_at_ms IS NULL OR released_ms IS NOT NULL)) OR cancelled_at<?2';
    // Read first, so an idle broker opens no write transaction.
    if (
      !this.one(`${expired} LIMIT 1`, edge, cancelledEdge) &&
      !this.one('SELECT 1 FROM schedules WHERE cancelled_at<? LIMIT 1', cancelledEdge)
    )
      return 0;
    return this.transaction(() => {
      for (const table of ['seen_receipts', 'message_attachments', 'deliveries'])
        this.run(`DELETE FROM ${table} WHERE message_id IN (${expired})`, edge, cancelledEdge);
      const removed = this.run(
        `DELETE FROM messages WHERE id IN (${expired})`,
        edge,
        cancelledEdge,
      );
      this.run(
        'DELETE FROM schedule_attachments WHERE schedule_id IN (SELECT id FROM schedules WHERE cancelled_at<?)',
        cancelledEdge,
      );
      this.run('DELETE FROM schedules WHERE cancelled_at<?', cancelledEdge);
      return removed;
    });
  }

  /**
   * Trim the audit log to each lobby's newest events. At a few rows a day it would take years to
   * matter, but an agent credential resuming its runtime in a loop writes one per request.
   */
  pruneAdminEvents(): number {
    let removed = 0;
    for (const row of this.all('SELECT DISTINCT lobby_id FROM admin_events')) {
      const lobby = row.lobby_id as string | null;
      const cut = this.one(
        'SELECT sequence FROM admin_events WHERE lobby_id IS ? ORDER BY sequence DESC LIMIT 1 OFFSET ?',
        lobby,
        ADMIN_EVENTS_KEPT,
      );
      if (cut)
        removed += this.transaction(() =>
          this.run(
            'DELETE FROM admin_events WHERE lobby_id IS ? AND sequence<=?',
            lobby,
            Number(cut.sequence),
          ),
        );
    }
    return removed;
  }

  /**
   * Retention and cleanup, run by the broker's sweep. Attachments expire once the retention
   * period has passed since their last referencing message reached its recipients, unless an
   * active schedule or a scheduled message still waiting for its time will send them; pending uploads no send used expire after the grace period. Content is deleted
   * only when no live attachment and no pending upload references it, and files on disk that no
   * record names (an interrupted upload) are removed after the grace period. The record of an
   * expired attachment, which tells its uploader 410 rather than 404, goes a week after expiry
   * once no message or schedule names it, so the table does not grow forever.
   */
  collectAttachments(): { expired: number; uploads: number; files: number } {
    const now = this.clock();
    const retentionEdge = now - this.attachmentRetention;
    const graceEdge = now - this.attachmentGrace;
    const recordEdge = new Date(now - EXPIRED_ATTACHMENT_RECORD_MS).toISOString();
    const unnamed =
      'expired_at<? AND NOT EXISTS (SELECT 1 FROM message_attachments m WHERE m.attachment_id=attachments.id) AND NOT EXISTS (SELECT 1 FROM schedule_attachments s WHERE s.attachment_id=attachments.id)';
    // Past retention, and neither an active schedule nor a scheduled message still waiting for
    // its time will send it.
    const stale =
      'expired_at IS NULL AND COALESCE(last_referenced_ms,created_ms)<? AND NOT EXISTS (SELECT 1 FROM schedule_attachments sa JOIN schedules s ON s.id=sa.schedule_id WHERE sa.attachment_id=attachments.id AND s.cancelled_at IS NULL) AND NOT EXISTS (SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.message_id WHERE ma.attachment_id=attachments.id AND m.deliver_at_ms IS NOT NULL AND m.released_ms IS NULL AND m.cancelled_at IS NULL)';
    // Read first, so an idle broker opens no write transaction.
    const due =
      this.one(`SELECT 1 FROM attachments WHERE ${stale} LIMIT 1`, retentionEdge) ??
      this.one('SELECT 1 FROM attachment_uploads WHERE created_ms<? LIMIT 1', graceEdge) ??
      this.one(`SELECT 1 FROM attachments WHERE ${unnamed} LIMIT 1`, recordEdge);
    const result = !due
      ? { expired: 0, uploads: 0, unreferenced: [] as string[] }
      : this.transaction(() => {
          const expired = this.all(`SELECT id FROM attachments WHERE ${stale}`, retentionEdge);
          for (const row of expired)
            this.run('UPDATE attachments SET expired_at=? WHERE id=?', this.iso(), String(row.id));
          this.run(`DELETE FROM attachments WHERE ${unnamed}`, recordEdge);
          const uploads = Number(
            this.one('SELECT COUNT(*) AS n FROM attachment_uploads WHERE created_ms<?', graceEdge)!
              .n,
          );
          this.run('DELETE FROM attachment_uploads WHERE created_ms<?', graceEdge);
          const unreferenced = this.all(
            'SELECT sha256 FROM attachment_blobs b WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256=b.sha256 AND a.expired_at IS NULL) AND NOT EXISTS (SELECT 1 FROM attachment_uploads u WHERE u.sha256=b.sha256)',
          ).map((row) => String(row.sha256));
          for (const sha256 of unreferenced)
            this.run('DELETE FROM attachment_blobs WHERE sha256=?', sha256);
          return { expired: expired.length, uploads, unreferenced };
        });
    let files = 0;
    if (!this.attachmentsDirectory)
      return { expired: result.expired, uploads: result.uploads, files };
    const directory = this.attachmentsPath();
    const known = (name: string) =>
      /^[0-9a-f]{64}$/u.test(name) &&
      Boolean(this.one('SELECT 1 FROM attachment_blobs WHERE sha256=?', name));
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      try {
        const stats = statSync(path);
        const orphan =
          result.unreferenced.includes(name) ||
          (!known(name) && Date.now() - stats.mtimeMs > this.attachmentGrace);
        if (stats.isFile() && orphan) {
          unlinkSync(path);
          files++;
        }
      } catch {
        /* Removed meanwhile; the next pass sees the current state. */
      }
    }
    return { expired: result.expired, uploads: result.uploads, files };
  }

  messages(
    id: string,
    options: {
      mode?: 'pending' | 'history' | 'reconciliation';
      cursor?: number;
      limit?: number;
      includeHeldContent?: boolean;
      /** History only: a case-insensitive substring of the text, structured fields or file names. */
      query?: string;
      /** History only: received messages that expect a reply this agent has not sent. */
      unanswered?: boolean;
    } = {},
  ): Page<Message> {
    id = this.key(id);
    const identity = parsePrincipal(id);
    if (identity.agent_id !== 'owner') this.row(id);
    else this.requireLobby(identity.lobby_id);
    const mode = options.mode ?? 'pending';
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 25;
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail(400, 'invalid_pagination', 'Use a nonnegative cursor and a limit between 1 and 100');
    if (options.query !== undefined && mode !== 'history')
      fail(400, 'query_needs_history', 'Search works in history mode only');
    if (options.unanswered && (mode !== 'history' || identity.agent_id === 'owner'))
      fail(400, 'unanswered_needs_history', "unanswered lists an agent's own history only");
    // A request counts as answered by a reply of this agent's that names it in reply_to and
    // reached the asker: released, not cancelled, its delivery to the asker not held. It is a
    // checklist, not proof that the answer was enough. Owner messages cannot be answered.
    const unanswered = options.unanswered
      ? " AND m.sender<>?2 AND m.sender<>(?4 || '/owner') AND d.agent_id=?2 AND d.held_reason IS NULL AND m.reply_expected=1 AND NOT EXISTS(SELECT 1 FROM messages r JOIN deliveries rd ON rd.message_id=r.id WHERE r.sender=?2 AND r.reply_to=m.id AND r.cancelled_at IS NULL AND (r.deliver_at_ms IS NULL OR r.released_ms IS NOT NULL) AND rd.agent_id=m.sender AND rd.held_reason IS NULL)"
      : '';
    // Matched in SQL before the page is cut, with % and _ taken literally.
    const pattern =
      options.query === undefined ? null : `%${options.query.replace(/[\\%_]/g, '\\$&')}%`;
    const matches =
      "(m.content LIKE ?1 ESCAPE '\\' OR m.details LIKE ?1 ESCAPE '\\' OR EXISTS(SELECT 1 FROM message_attachments x JOIN attachments a ON a.id=x.attachment_id WHERE x.message_id=m.id AND a.filename LIKE ?1 ESCAPE '\\'))";
    let rows: Row[];
    if (mode === 'history') {
      rows =
        identity.agent_id === 'owner'
          ? this.all(
              `SELECT * FROM messages m WHERE m.lobby_id=?2 AND m.sequence>?3${pattern === null ? '' : ` AND ${matches}`} ORDER BY m.sequence LIMIT ?4`,
              pattern,
              identity.lobby_id,
              cursor,
              limit + 1,
            )
          : // A recipient sees a scheduled message only once it is delivered, never if
            // cancelled first, even when a room change has held it. Its sender always sees it,
            // with the recipients' states. Only this agent's own messages are read.
            // A search matches only what this agent may read: a held message shows no content.
            this.all(
              `SELECT m.*,d.seen_at,d.receipt_seq,d.held_reason,d.agent_id AS delivery_recipient_id FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND d.agent_id=?2 WHERE m.sequence>?3 AND m.lobby_id=?4 AND (m.sender=?2 OR (d.agent_id=?2 AND COALESCE(d.held_reason,'') NOT IN ('scheduled','cancelled') AND (m.deliver_at_ms IS NULL OR m.released_ms IS NOT NULL)))${pattern === null ? '' : ` AND (m.sender=?2 OR d.held_reason IS NULL) AND ${matches}`}${unanswered} ORDER BY m.sequence LIMIT ?5`,
              pattern,
              id,
              cursor,
              parsePrincipal(id).lobby_id,
              limit + 1,
            );
    } else if (mode === 'reconciliation') {
      const after = Math.max(cursor, this.readCheckpoint(id).covered_receipt_seq);
      rows = this.all(
        'SELECT m.*,d.seen_at,d.receipt_seq,d.held_reason FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.agent_id=? AND d.receipt_seq>? ORDER BY d.receipt_seq LIMIT ?',
        id,
        after,
        limit + 1,
      );
    } else {
      rows = this.all(
        'SELECT m.*,d.seen_at,d.receipt_seq,d.held_reason FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.agent_id=? AND d.seen_at IS NULL AND d.held_reason IS NULL AND m.sequence>? ORDER BY m.sequence LIMIT ?',
        id,
        cursor,
        limit + 1,
      );
    }
    // Shape the candidates first: their structured fields, attachments and recipients' facts can
    // outweigh their text, and the page is bounded by what it serializes to.
    const candidates = rows.slice(0, limit);
    const items = candidates.map((row) => this.message(row, options.includeHeldContent));
    if (mode === 'history') {
      // A sender sees each recipient's facts only for its own messages. The owner's
      // lobby-wide history is administrative and shows them for every message.
      const sent = new Set(
        candidates
          .filter((row) => identity.agent_id === 'owner' || row.sender === id)
          .map((row) => String(row.id)),
      );
      const deliveries = this.recipientDeliveries([...sent]);
      for (const item of items)
        if (sent.has(item.id)) item.deliveries = deliveries.get(item.id) ?? [];
    }
    // Bounded by bytes as well as count, so a page fits in one Claude tool result (about
    // 25,000 tokens by default). The first message is always taken: bounded content keeps it
    // under the budget, except a sender's own history of a large message to many recipients,
    // whose recipients' facts come with it.
    let budget = MAX_PAGE_BYTES;
    let taken = 0;
    for (const item of items) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (taken > 0 && size > budget) break;
      taken++;
      budget -= size;
    }
    const more = rows.length > taken;
    return {
      items: items.slice(0, taken),
      next_cursor: more
        ? Number(candidates[taken - 1]![mode === 'reconciliation' ? 'receipt_seq' : 'sequence'])
        : null,
    };
  }

  /**
   * Record receipts; returns the new snapshot and the IDs that named nothing in this inbox: no
   * message by that ID (such as a notification_id), or one no longer stored after its day.
   */
  private acknowledgeInner(id: string, ids: string[]): { snapshot: number; unknown: string[] } {
    id = this.key(id);
    if (ids.length > 100) fail(400, 'ack_limit', 'At most 100 receipts per operation');
    const unique = [...new Set(ids)];
    const unknown: string[] = [];
    for (const messageId of unique) {
      const delivery = this.one(
        'SELECT held_reason FROM deliveries WHERE agent_id=? AND message_id=?',
        id,
        messageId,
      );
      // A message no longer stored expired after its day, possibly in this agent's inbox: it
      // records nothing, like an already seen one. Only someone else's message is refused.
      if (!delivery && this.one('SELECT 1 FROM messages WHERE id=?', messageId))
        fail(403, 'receipt_forbidden', 'A receipt can only name messages in your own inbox');
      if (!delivery) unknown.push(messageId);
      // A scheduled message has not arrived: a receipt for it means nothing, and a bridge that
      // took it as read would hide the message when it does arrive.
      if (delivery?.held_reason === SCHEDULED)
        fail(
          409,
          'not_yet_delivered',
          `Message ${messageId} is scheduled and not yet delivered; acknowledge it once it arrives`,
        );
    }
    let snapshot = Number(this.row(id).receipt_seq);
    for (const messageId of unique) {
      const existing = this.one(
        'SELECT d.seen_at,d.held_reason,m.sender,m.notify_when_seen FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.agent_id=? AND d.message_id=?',
        id,
        messageId,
      );
      // Expired, already seen, or held for good (its room left or deleted, or cancelled): nothing
      // to record, and the rest of the batch still counts.
      if (!existing || existing.seen_at !== null || existing.held_reason !== null) continue;
      const seenAt = this.iso();
      this.run(
        'UPDATE deliveries SET seen_at=?,receipt_seq=? WHERE agent_id=? AND message_id=?',
        seenAt,
        ++snapshot,
        id,
        messageId,
      );
      // Only messages can ask for receipts, and a receipt is not a message, so a receipt can
      // never cause another. Notes to self and owner messages produce none.
      const sender = String(existing.sender);
      if (existing.notify_when_seen && sender !== id && parsePrincipal(sender).agent_id !== 'owner')
        this.run(
          'INSERT OR IGNORE INTO seen_receipts(sender,message_id,agent_id,seen_at,seen_ms) VALUES(?,?,?,?,?)',
          sender,
          messageId,
          id,
          seenAt,
          this.clock(),
        );
    }
    this.run(
      'UPDATE agents SET receipt_seq=?,last_agent_seen_at=? WHERE agent_id=?',
      snapshot,
      this.iso(),
      id,
    );
    return { snapshot, unknown };
  }
  acknowledge(
    id: string,
    auth: RuntimeAuth,
    ids: string[],
  ): { receipt_snapshot: number; unknown_message_ids?: string[] } {
    id = this.key(id);
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const { snapshot, unknown } = this.acknowledgeInner(id, ids);
      return {
        receipt_snapshot: snapshot,
        ...(unknown.length ? { unknown_message_ids: unknown } : {}),
      };
    });
  }
  private readCheckpoint(id: string): Checkpoint {
    id = this.key(id);
    const row =
      this.one('SELECT * FROM checkpoints WHERE agent_id=?', id) ??
      fail(404, 'agent_not_found', 'Unknown agent');
    return {
      revision: Number(row.revision),
      content: String(row.content),
      covered_receipt_seq: Number(row.covered_receipt_seq),
      updated_at: row.updated_at as string | null,
      runtime_id: row.runtime_id as string | null,
    };
  }
  context(id: string): Omit<AgentContext, 'tool_guide'> {
    id = this.key(id);
    const agent = this.row(id);
    const checkpoint = this.readCheckpoint(id);
    const receiptSnapshot = Number(agent.receipt_seq);
    const pending = this.messages(id);
    const shown = this.messages(id, { mode: 'reconciliation', limit: RECONCILIATION_BODIES });
    const total = Number(
      this.one(
        'SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND receipt_seq>?',
        id,
        checkpoint.covered_receipt_seq,
      )!.n,
    );
    const headers =
      shown.next_cursor === null
        ? []
        : this.all(
            'SELECT m.id,m.sender,m.target,m.details,m.room_id,m.priority,m.kind,m.created_at,d.seen_at,d.receipt_seq FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.agent_id=? AND d.receipt_seq>? ORDER BY d.receipt_seq LIMIT ?',
            id,
            shown.next_cursor,
            RECONCILIATION_HEADERS,
          ).map((row): ReconciliationHeader => ({
            id: String(row.id),
            from: parsePrincipal(String(row.sender)).agent_id,
            to: String(row.target),
            ...addressedOf(row.details),
            room_id: row.room_id as string | null,
            priority: row.priority as 'info' | 'important',
            kind: (row.kind as MessageKind | null) ?? null,
            created_at: String(row.created_at),
            agent_seen_at: row.seen_at as string | null,
            receipt_seq: Number(row.receipt_seq),
          }));
    const guidance: string[] = [];
    const counted = (n: number) => `${n} acknowledged message${n === 1 ? '' : 's'}`;
    if (total > 0 && checkpoint.revision === 0)
      guidance.push(
        `You have ${counted(total)} but have never saved a checkpoint, so every bootstrap lists ${total === 1 ? 'it' : 'them'} again for reconciliation. After reconciling and calling ready (a checkpoint saved before ready makes ready stale), call save_checkpoint with expected_revision 0 and covered_receipt_seq ${receiptSnapshot}, keeping unfinished work and uncertain effects in its content.`,
      );
    else if (total > 0)
      guidance.push(
        `${counted(total)} ${total === 1 ? 'is' : 'are'} not covered by checkpoint revision ${checkpoint.revision}. After reconciling and calling ready, save a checkpoint with covered_receipt_seq ${receiptSnapshot} so later bootstraps skip ${total === 1 ? 'it' : 'them'}.`,
      );
    if (shown.next_cursor !== null)
      guidance.push(
        `Reconciliation shows the first ${shown.items.length} with bodies${headers.length ? ` and headers of ${headers.length} more` : ''}. Read the rest with get_messages(mode="reconciliation", cursor=${shown.next_cursor}) only where you need them.`,
      );
    if (pending.next_cursor !== null)
      guidance.push(
        `More pending messages follow; read get_messages(mode="pending", cursor=${pending.next_cursor}).`,
      );
    return {
      agent_id: parsePrincipal(id).agent_id,
      lobby_id: String(agent.lobby_id),
      runtime_id: agent.runtime_id as string | null,
      role: String(agent.role),
      checkpoint,
      receipt_snapshot: receiptSnapshot,
      pending,
      reconciliation: { ...shown, total, headers },
      scheduled: {
        schedules: Number(
          this.one(
            'SELECT COUNT(*) AS n FROM schedules WHERE sender=? AND cancelled_at IS NULL',
            id,
          )!.n,
        ),
        messages: this.undeliveredCount(id),
      },
      guidance,
    };
  }
  checkpoint(
    id: string,
    auth: RuntimeAuth,
    raw: CheckpointInput,
  ): Checkpoint & { unknown_message_ids?: string[] } {
    id = this.key(id);
    const input = CheckpointSchema.parse(raw);
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const previous = this.readCheckpoint(id);
      if (previous.revision !== input.expected_revision)
        fail(409, 'checkpoint_conflict', 'Checkpoint revision changed');
      const snapshot = Number(this.row(id).receipt_seq);
      if (
        input.covered_receipt_seq < previous.covered_receipt_seq ||
        input.covered_receipt_seq > snapshot
      )
        fail(
          409,
          'receipt_snapshot_conflict',
          'Covered receipts must be an existing, nondecreasing snapshot',
        );
      const hasNewReceipts = input.acknowledge_message_ids.some((messageId) =>
        this.one(
          'SELECT 1 FROM deliveries WHERE agent_id=? AND message_id=? AND seen_at IS NULL AND held_reason IS NULL',
          id,
          messageId,
        ),
      );
      if (hasNewReceipts && input.covered_receipt_seq !== snapshot)
        fail(
          409,
          'receipt_snapshot_conflict',
          'Reconcile existing receipts before covering newly acknowledged messages',
        );
      const { snapshot: nextSnapshot, unknown } = this.acknowledgeInner(
        id,
        input.acknowledge_message_ids,
      );
      const covered = hasNewReceipts ? nextSnapshot : input.covered_receipt_seq;
      this.run(
        'UPDATE checkpoints SET revision=revision+1,content=?,covered_receipt_seq=?,updated_at=?,runtime_id=? WHERE agent_id=?',
        input.content,
        covered,
        this.iso(),
        auth.runtime_id,
        id,
      );
      return {
        ...this.readCheckpoint(id),
        ...(unknown.length ? { unknown_message_ids: unknown } : {}),
      };
    });
  }

  /**
   * Reserve the next notice for this runtime. `maxBytes` is the broker's configured push size.
   * A push larger than that becomes a header-only hint.
   */
  nextNotification(
    id: string,
    auth: RuntimeAuth,
    maxBytes = MIN_PUSH_BYTES,
  ): NotificationEvent | null {
    id = this.key(id);
    // Most dispatch ticks find nothing due: answer that from indexed reads, without a write
    // transaction. Anything due goes on to the transaction, which checks the runtime first.
    const now = this.clock();
    const state = this.one(
      'SELECT paused,ready,bootstrap_attempts,bootstrap_next_at FROM agents WHERE agent_id=?',
      id,
    );
    if (
      state &&
      (Number(state.paused) ||
        (Number(state.ready)
          ? !this.one(
              'SELECT 1 FROM deliveries WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL AND attempts<? AND next_attempt_at<=? LIMIT 1',
              id,
              this.retries.length,
              now,
            )
          : Number(state.bootstrap_attempts) >= this.retries.length ||
            Number(state.bootstrap_next_at) > now))
    )
      return null;
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const agent = this.row(id);
      if (agent.paused) return null;
      const now = this.clock();
      const recent = Number(
        this.one(
          'SELECT COUNT(*) AS n FROM notification_attempts WHERE agent_id=? AND created_at>?',
          id,
          new Date(now - 60_000).toISOString(),
        )!.n,
      );
      if (recent >= this.notificationRate) return null;
      const pending = Number(
        this.one(
          'SELECT COUNT(*) AS n FROM deliveries WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL',
          id,
        )!.n,
      );
      const event: NotificationEvent = {
        type: agent.ready ? 'inbox' : 'bootstrap',
        notification_id: randomUUID(),
        agent_id: parsePrincipal(id).agent_id,
        lobby_id: String(agent.lobby_id),
        runtime_id: auth.runtime_id,
        generation: auth.generation,
        messages: [],
        pending_count: pending,
        truncated: false,
      };
      if (!agent.ready) {
        const attempt = Number(agent.bootstrap_attempts);
        if (attempt >= this.retries.length || Number(agent.bootstrap_next_at) > now) return null;
        event.probe_nonce = String(agent.probe_nonce);
        // A model's bootstrap, with its reconciliation, takes longer than a delivery's first
        // retry delay, and a retry behind it reached the session as a second bootstrap with
        // the same nonce after ready, costing a turn. So a bootstrap is retried at the
        // schedule's longest delay instead.
        this.run(
          'UPDATE agents SET bootstrap_attempts=bootstrap_attempts+1,bootstrap_next_at=? WHERE agent_id=?',
          now + this.bootstrapRetry,
          id,
        );
      } else {
        // Claude holds Channel events while a tool runs and shows them later. A retry for a
        // delivery whose latest notice this same adapter process confirmed writing to its host
        // would only queue a duplicate, payload-less notice behind the original. Consume that
        // attempt without a notice, so the attention schedule still applies. Retries still go
        // out when no host write was confirmed, or after a restart or owner retry.
        for (let attempt = this.retries.length - 1; attempt >= 1; attempt--) {
          this.run(
            'UPDATE deliveries SET attempts=attempts+1,next_attempt_at=? WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL AND attempts=? AND next_attempt_at<=? AND EXISTS (SELECT 1 FROM notification_attempts n WHERE n.id=deliveries.last_notification_id AND n.agent_id=deliveries.agent_id AND n.runtime_id=? AND n.generation=? AND n.incarnation=? AND n.notification_attempted_at IS NOT NULL)',
            now + this.retries[attempt]!,
            id,
            attempt,
            now,
            auth.runtime_id,
            auth.generation,
            auth.incarnation,
          );
        }
        const due =
          'd.agent_id=? AND d.seen_at IS NULL AND d.held_reason IS NULL AND d.attempts<? AND d.next_attempt_at<=?';
        const rows = this.all(
          `SELECT m.*,d.seen_at,d.receipt_seq,d.held_reason,d.attempts FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE ${due} ORDER BY (m.priority='important') DESC,m.sequence LIMIT 21`,
          id,
          this.retries.length,
          now,
        );
        if (!rows.length) return null;
        // Backlog: accepted before this runtime was bound, unless it is a scheduled message
        // that fell due after binding, which is live traffic and is pushed with its body.
        const backlog = (row: Row) =>
          Number(row.sequence) <= Number(agent.backlog_sequence) &&
          (row.released_ms === null || Number(row.released_ms) <= Number(agent.backlog_at));
        const hint =
          rows.length > 20 || rows.some((row) => Number(row.attempts) > 0 || backlog(row));
        event.messages = hint ? [] : rows.map((row) => this.message(row));
        event.truncated = hint;
        if (Buffer.byteLength(JSON.stringify(event)) > maxBytes) {
          event.messages = [];
          event.truncated = true;
        }
        if (event.truncated) {
          event.covered = rows.slice(0, 20).map((row) => this.header(row));
          event.covered_count = Number(
            this.one(
              `SELECT COUNT(*) AS n FROM deliveries d WHERE ${due}`,
              id,
              this.retries.length,
              now,
            )!.n,
          );
        }
        // Descending updates prevent a delivery from consuming several attempts in this reservation.
        for (let attempt = this.retries.length - 1; attempt >= 0; attempt--) {
          this.run(
            'UPDATE deliveries SET attempts=attempts+1,next_attempt_at=?,last_notification_id=? WHERE agent_id=? AND seen_at IS NULL AND held_reason IS NULL AND attempts=? AND next_attempt_at<=?',
            now + this.retries[attempt]!,
            event.notification_id,
            id,
            attempt,
            now,
          );
        }
      }
      this.run(
        'INSERT INTO notification_attempts(id,agent_id,runtime_id,generation,incarnation,kind,created_at) VALUES(?,?,?,?,?,?,?)',
        event.notification_id,
        id,
        auth.runtime_id,
        auth.generation,
        auth.incarnation,
        event.type,
        this.iso(),
      );
      return event;
    });
  }
  recordTransport(id: string, auth: RuntimeAuth, receipt: TransportReceipt): void {
    id = this.key(id);
    this.transaction(() => {
      this.assertRuntime(id, auth);
      const row = this.one(
        'SELECT * FROM notification_attempts WHERE id=? AND agent_id=? AND runtime_id=? AND generation=? AND incarnation=?',
        receipt.notification_id,
        id,
        auth.runtime_id,
        auth.generation,
        auth.incarnation,
      );
      if (!row) fail(404, 'notification_not_found', 'Notification is not owned by this runtime');
      const field =
        receipt.type === 'adapter_received' ? 'adapter_received_at' : 'notification_attempted_at';
      if (row![field] !== null) return;
      const at = this.iso();
      this.run(
        `UPDATE notification_attempts SET ${field}=? WHERE id=?`,
        at,
        receipt.notification_id,
      );
      // Senders see the latest host write for each delivery this notice covered.
      if (field === 'notification_attempted_at')
        this.run(
          'UPDATE deliveries SET notification_attempted_at=? WHERE agent_id=? AND last_notification_id=?',
          at,
          id,
          receipt.notification_id,
        );
    });
  }

  /**
   * Run by the broker's dispatch loop: deliver scheduled messages whose time has come and
   * create due occurrences of recurring schedules. Work that fell due while the broker was
   * stopped is done on the first pass after it starts, marked late.
   */
  releaseDue(): { released: number; occurrences: number } {
    const now = this.clock();
    let released = 0;
    let occurrences = 0;
    // Read-only checks first, so an idle broker opens no write transaction.
    const due = this.all(
      'SELECT id FROM messages WHERE deliver_at_ms IS NOT NULL AND released_ms IS NULL AND cancelled_at IS NULL AND deliver_at_ms<=? ORDER BY deliver_at_ms,sequence LIMIT 100',
      now,
    ).map((row) => String(row.id));
    if (due.length)
      this.transaction(() => {
        for (const id of due) if (this.release(id, now)) released++;
      });
    const schedules = this.all(
      'SELECT id FROM schedules WHERE cancelled_at IS NULL AND next_run_ms IS NOT NULL AND next_run_ms<=? ORDER BY next_run_ms LIMIT 50',
      now,
    ).map((row) => String(row.id));
    for (const id of schedules) if (this.runSchedule(id, now)) occurrences++;
    return { released, occurrences };
  }

  private release(id: string, now: number): boolean {
    const row = this.one(
      'SELECT * FROM messages WHERE id=? AND released_ms IS NULL AND cancelled_at IS NULL',
      id,
    );
    if (!row) return false;
    const sender = this.one('SELECT enabled FROM agents WHERE agent_id=?', String(row.sender));
    if (sender && !sender.enabled) {
      // The owner disabled the sender before its message fell due: do not deliver it.
      this.cancelMessage(id);
      return false;
    }
    const late = now - Math.max(Number(row.deliver_at_ms), Number(row.created_ms)) > this.lateAfter;
    this.run('UPDATE messages SET released_ms=?,late=? WHERE id=?', now, Number(late), id);
    this.run(
      'UPDATE attachments SET last_referenced_ms=MAX(COALESCE(last_referenced_ms,0),?) WHERE id IN (SELECT attachment_id FROM message_attachments WHERE message_id=?)',
      now,
      id,
    );
    this.run(
      'UPDATE deliveries SET held_reason=NULL,attempts=0,next_attempt_at=? WHERE message_id=? AND held_reason=?',
      now + (row.priority === 'info' ? this.infoDelay : 0),
      id,
      SCHEDULED,
    );
    return true;
  }

  private cancelMessage(id: string): void {
    this.run('UPDATE messages SET cancelled_at=? WHERE id=?', this.iso(), id);
    this.run(
      'UPDATE deliveries SET held_reason=? WHERE message_id=? AND held_reason=?',
      CANCELLED,
      id,
      SCHEDULED,
    );
  }

  /**
   * Create one occurrence for a due schedule, then move it to its next slot. After an
   * outage that skipped several slots, only the latest missed slot is delivered, late.
   */
  private runSchedule(id: string, now: number): boolean {
    const row = this.one('SELECT * FROM schedules WHERE id=? AND cancelled_at IS NULL', id);
    if (!row || row.next_run_ms === null || Number(row.next_run_ms) > now) return false;
    const repeat = this.repeatOf(row);
    const slot = latestDueOccurrence(repeat, Number(row.next_run_ms), now);
    const next = nextOccurrence(repeat, now);
    const at = new Date(slot).toISOString();
    try {
      return this.transaction(() => {
        const sender = String(row.sender);
        const principal = this.agent(sender);
        if (!principal.enabled) fail(403, 'agent_disabled', 'Sender is disabled');
        const input = SendSchema.parse({
          client_request_id: `${RESERVED_REQUEST_PREFIX}schedule:${id}:${slot}`,
          ...JSON.parse(String(row.template)),
        });
        const stored = this.accept(sender, String(row.lobby_id), principal, input, {
          fingerprint: hash(JSON.stringify(canonicalSend(input))),
          now,
          deliverAt: slot,
          scheduleId: id,
        });
        this.run(
          'UPDATE schedules SET next_run_ms=?,occurrence_count=occurrence_count+1,last_occurrence_at=?,last_message_id=?,last_error=NULL WHERE id=?',
          next,
          at,
          stored.message.id,
          id,
        );
        return true;
      });
    } catch (error) {
      // The occurrence is skipped, visibly; the schedule continues at its next slot.
      const code = error instanceof LobbyError ? error.code : 'internal_error';
      this.transaction(() =>
        this.run(
          'UPDATE schedules SET next_run_ms=?,last_occurrence_at=?,last_error=? WHERE id=? AND cancelled_at IS NULL',
          next,
          at,
          code,
          id,
        ),
      );
      return false;
    }
  }

  private repeatOf(row: Row): Repeat {
    return {
      time_zone: String(row.time_zone),
      times: JSON.parse(String(row.times)) as string[],
      weekdays:
        row.weekdays === null ? null : (JSON.parse(String(row.weekdays)) as Repeat['weekdays']),
    };
  }

  private schedule(row: Row): Schedule {
    const template = JSON.parse(String(row.template)) as ParsedSend;
    const repeat = this.repeatOf(row);
    const kind = template.kind ?? null;
    const next = row.next_run_ms === null ? null : Number(row.next_run_ms);
    return {
      schedule_id: String(row.id),
      lobby_id: String(row.lobby_id),
      from: parsePrincipal(String(row.sender)).agent_id,
      client_request_id: String(row.request_id),
      to: Array.isArray(template.to) ? '*' : template.to,
      ...(Array.isArray(template.to) ? { addressed_to: namedMembers(template.to)! } : {}),
      room_id: template.room ?? null,
      priority: template.priority,
      content: template.content,
      correlation_id: template.correlation_id ?? null,
      kind,
      reply_expected: template.reply_expected ?? (kind ? defaultReplyExpected(kind) : null),
      ...messageDetails(template),
      ...(template.notify_when_seen ? { notify_when_seen: true } : {}),
      ...(() => {
        const attachments = this.all(
          'SELECT a.* FROM schedule_attachments s JOIN attachments a ON a.id=s.attachment_id WHERE s.schedule_id=? ORDER BY s.position',
          String(row.id),
        ).map((entry) => this.attachmentInfo(entry));
        return attachments.length ? { attachments } : {};
      })(),
      repeat,
      created_at: String(row.created_at),
      next_occurrence_at: next === null ? null : new Date(next).toISOString(),
      next_occurrence_local: next === null ? null : localLabel(next, repeat.time_zone),
      occurrence_count: Number(row.occurrence_count),
      last_occurrence_at: row.last_occurrence_at as string | null,
      last_message_id: row.last_message_id as string | null,
      last_error: row.last_error as string | null,
      cancelled_at: row.cancelled_at as string | null,
    };
  }

  /**
   * A durable daily repeat owned by the agent identity, not by a session, so it survives
   * restarts. Authorization is checked now and again at every occurrence.
   */
  createSchedule(id: string, auth: RuntimeAuth, raw: ScheduleInput): StoredSchedule {
    id = this.key(id);
    const input = ScheduleSchema.parse(raw);
    const { repeat: rawRepeat, client_request_id, ...template } = input;
    const repeat = canonicalRepeat(rawRepeat);
    const fingerprint = hash(
      JSON.stringify({ ...canonicalSend({ client_request_id, ...template }), repeat }),
    );
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const principal = this.agent(id);
      const existing = this.one(
        'SELECT * FROM schedules WHERE sender=? AND request_id=?',
        id,
        client_request_id,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          fail(409, 'idempotency_conflict', 'Retry key was already used for a different request');
        return { status: 'scheduled', schedule: this.schedule(existing), duplicate: true };
      }
      if (client_request_id.startsWith(RESERVED_REQUEST_PREFIX))
        fail(
          400,
          'reserved_request_id',
          `Request IDs starting with ${RESERVED_REQUEST_PREFIX} are reserved`,
        );
      admitContent(input.content);
      if (
        Number(
          this.one(
            'SELECT COUNT(*) AS n FROM schedules WHERE sender=? AND cancelled_at IS NULL',
            id,
          )!.n,
        ) >= this.maxSchedules
      )
        fail(409, 'schedule_capacity', `At most ${this.maxSchedules} active schedules per agent`);
      this.recipients(id, principal.lobby_id, principal, template);
      const now = this.clock();
      // Each occurrence sends the same attachments; the schedule keeps them from expiring.
      const attachments = this.resolveAttachments(
        id,
        principal.lobby_id,
        template.attachments,
        now,
      );
      const scheduleId = randomUUID();
      this.run(
        'INSERT INTO schedules(id,sender,lobby_id,request_id,fingerprint,template,time_zone,times,weekdays,created_at,next_run_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        scheduleId,
        id,
        principal.lobby_id,
        client_request_id,
        fingerprint,
        JSON.stringify(template),
        repeat.time_zone,
        JSON.stringify(repeat.times),
        repeat.weekdays === null ? null : JSON.stringify(repeat.weekdays),
        new Date(now).toISOString(),
        nextOccurrence(repeat, now),
      );
      this.linkAttachments(id, attachments, 'schedule', scheduleId, now);
      return {
        status: 'scheduled',
        schedule: this.schedule(this.one('SELECT * FROM schedules WHERE id=?', scheduleId)!),
        duplicate: false,
      };
    });
  }

  /** The caller's active schedules and undelivered scheduled messages, soonest first. */
  scheduled(id: string): ScheduledItems {
    id = this.key(id);
    const identity = parsePrincipal(id);
    if (identity.agent_id !== 'owner') this.row(id);
    else this.requireLobby(identity.lobby_id);
    // A listing for finding and cancelling: a full queue of long broadcasts with structured
    // fields and every recipient's facts would not fit one response. Each item keeps the
    // beginning of its content and a recipient count; the sender's history holds the rest.
    const listed = <T extends Schedule | Message>(item: T) => {
      const entry: Record<string, unknown> = { ...item };
      for (const field of DETAIL_FIELDS) delete entry[field];
      if (item.content.length > SCHEDULED_EXCERPT) {
        entry.content = `${item.content.slice(0, SCHEDULED_EXCERPT - 1)}…`;
        entry.content_truncated = true;
      }
      return entry as Omit<T, keyof MessageDetails> & { content_truncated?: true };
    };
    return {
      schedules: this.all(
        'SELECT * FROM schedules WHERE sender=? AND cancelled_at IS NULL ORDER BY next_run_ms,created_at',
        id,
      ).map((row) => listed(this.schedule(row))),
      messages: this.all(
        'SELECT m.*,(SELECT COUNT(*) FROM deliveries d WHERE d.message_id=m.id) AS recipient_count FROM messages m INDEXED BY messages_due WHERE m.sender=? AND m.deliver_at_ms IS NOT NULL AND m.released_ms IS NULL AND m.cancelled_at IS NULL ORDER BY m.deliver_at_ms,m.sequence',
        id,
      ).map((row) => ({ ...listed(this.message(row)), recipients: Number(row.recipient_count) })),
    };
  }

  /**
   * Cancel one of the caller's schedules or undelivered scheduled messages. Repeating a
   * cancellation is harmless. A delivered message cannot be recalled. `auth` is null for
   * the owner acting through administration.
   */
  cancelScheduled(id: string, auth: RuntimeAuth | null, targetId: string): CancelResult {
    id = this.key(id);
    return this.transaction(() => {
      if (auth) this.assertRuntime(id, auth);
      const schedule = this.one('SELECT * FROM schedules WHERE id=? AND sender=?', targetId, id);
      if (schedule) {
        const already = schedule.cancelled_at !== null;
        if (!already)
          this.run(
            'UPDATE schedules SET cancelled_at=?,next_run_ms=NULL WHERE id=?',
            this.iso(),
            targetId,
          );
        return {
          cancelled: 'schedule',
          schedule: this.schedule(this.one('SELECT * FROM schedules WHERE id=?', targetId)!),
          already_cancelled: already,
        };
      }
      const message = this.one(
        'SELECT * FROM messages WHERE id=? AND sender=? AND deliver_at_ms IS NOT NULL AND schedule_id IS NULL',
        targetId,
        id,
      );
      if (!message)
        fail(404, 'not_found', 'You have no schedule or scheduled message with that ID');
      const already = message!.cancelled_at !== null;
      if (!already && message!.released_ms !== null)
        fail(409, 'already_delivered', 'The message was already delivered; it cannot be recalled');
      if (!already) this.cancelMessage(targetId);
      const row = this.one('SELECT * FROM messages WHERE id=?', targetId)!;
      return {
        cancelled: 'message',
        message: {
          ...this.message(row),
          deliveries: this.recipientDeliveries([targetId]).get(targetId) ?? [],
        },
        already_cancelled: already,
      };
    });
  }

  /**
   * One event that coalesces the read receipts due to this sender.
   * Receipts wait receiptDelayMs so that close ones share an event, and events to one agent
   * are at least receiptIntervalMs apart. Each receipt is sent once; history keeps the fact.
   */
  nextReceipts(id: string, auth: RuntimeAuth): ReceiptEvent | null {
    id = this.key(id);
    const now = this.clock();
    const oldest = this.one(
      "SELECT MIN(seen_ms) AS t FROM seen_receipts WHERE sender=? AND state='due'",
      id,
    );
    if (!oldest || oldest.t === null || Number(oldest.t) > now - this.receiptDelay) return null;
    return this.transaction(() => {
      this.assertRuntime(id, auth);
      const agent = this.row(id);
      if (!agent.ready || agent.paused) return null;
      // Receipt events share the per-agent notification rate cap with inbox notices.
      const recent = Number(
        this.one(
          'SELECT COUNT(*) AS n FROM notification_attempts WHERE agent_id=? AND created_at>?',
          id,
          new Date(now - 60_000).toISOString(),
        )!.n,
      );
      if (recent >= this.notificationRate) return null;
      if (
        this.one(
          "SELECT 1 FROM notification_attempts WHERE agent_id=? AND kind='receipts' AND created_at>?",
          id,
          new Date(now - this.receiptInterval).toISOString(),
        )
      )
        return null;
      this.run(
        "UPDATE seen_receipts SET state='expired' WHERE sender=? AND state='due' AND seen_ms<?",
        id,
        now - RECEIPT_MAX_AGE_MS,
      );
      const rows = this.all(
        "SELECT r.sequence,r.message_id,r.agent_id,r.seen_at,m.kind,m.target,m.details,m.room_id,m.content FROM seen_receipts r JOIN messages m ON m.id=r.message_id WHERE r.sender=? AND r.state='due' ORDER BY r.sequence LIMIT ?",
        id,
        MAX_RECEIPTS_PER_EVENT,
      );
      if (!rows.length) return null;
      const total = Number(
        this.one("SELECT COUNT(*) AS n FROM seen_receipts WHERE sender=? AND state='due'", id)!.n,
      );
      const event: ReceiptEvent = {
        type: 'receipts',
        notification_id: randomUUID(),
        agent_id: parsePrincipal(id).agent_id,
        lobby_id: String(agent.lobby_id),
        runtime_id: auth.runtime_id,
        generation: auth.generation,
        receipts: rows.map((row) => ({
          message_id: String(row.message_id),
          seen_by: parsePrincipal(String(row.agent_id)).agent_id,
          seen_at: String(row.seen_at),
          kind: (row.kind as MessageKind | null) ?? null,
          to: String(row.target),
          ...addressedOf(row.details),
          room_id: row.room_id as string | null,
          excerpt: [...String(row.content)].slice(0, 80).join(''),
        })),
        remaining: 0,
      };
      while (event.receipts.length > 1 && Buffer.byteLength(JSON.stringify(event)) > MIN_PUSH_BYTES)
        event.receipts.pop();
      event.remaining = total - event.receipts.length;
      for (const receipt of event.receipts)
        this.run(
          "UPDATE seen_receipts SET state='sent',notification_id=? WHERE message_id=? AND agent_id=?",
          event.notification_id,
          receipt.message_id,
          qualifyAgent(String(agent.lobby_id), receipt.seen_by),
        );
      this.run(
        'INSERT INTO notification_attempts(id,agent_id,runtime_id,generation,incarnation,kind,created_at) VALUES(?,?,?,?,?,?,?)',
        event.notification_id,
        id,
        auth.runtime_id,
        auth.generation,
        auth.incarnation,
        event.type,
        this.iso(),
      );
      return event;
    });
  }

  // Progress boards (0.4.0): settings, notes sources per room, viewer sessions, the notes
  // snapshots and summaries. A board only projects notes, messages and live facts; nothing here
  // assigns or stores work.

  /**
   * A lobby whose board the actor may change, inside its transaction. A board lives at
   * `<lobby>.<domain>`, so its lobby ID must also be a DNS label.
   */
  private boardLobby(actor: Actor, lobbyId: string): string {
    const id = this.actorLobby(actor, lobbyId);
    if (!/^[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(id))
      fail(
        400,
        'lobby_not_board_compatible',
        'A board lives at <lobby>.<domain>, so its lobby ID may hold only letters, digits and inner hyphens',
      );
    return id;
  }
  /** Lobbies with at least one notes source in a room that is not archived. */
  boardLobbies(): string[] {
    return this.all(
      'SELECT DISTINCT s.lobby_id FROM board_sources s WHERE NOT EXISTS (SELECT 1 FROM archived_rooms a WHERE a.lobby_id=s.lobby_id AND a.room_id=s.room_id) ORDER BY s.lobby_id',
    ).map((row) => String(row.lobby_id));
  }
  /**
   * A lobby's notes sources. An archived room's source is kept for a restore but is left out
   * here, so nothing reads it, stores its notes or summarizes it.
   */
  boardSources(lobbyId: string): BoardSource[] {
    return this.all(
      'SELECT room_id,repo,ref,notes,updated_at FROM board_sources s WHERE lobby_id=? AND NOT EXISTS (SELECT 1 FROM archived_rooms a WHERE a.lobby_id=s.lobby_id AND a.room_id=s.room_id) ORDER BY room_id',
      lobbyId,
    ).map((row) => ({
      room_id: String(row.room_id),
      repo: String(row.repo),
      ref: String(row.ref),
      notes: JSON.parse(String(row.notes)) as string[],
      updated_at: String(row.updated_at),
    }));
  }
  /** A lobby's board settings and sources; the defaults when nothing is set yet. */
  boardConfig(lobbyId: string): BoardConfig {
    const row = this.one('SELECT * FROM board_configs WHERE lobby_id=?', lobbyId);
    return {
      lobby_id: lobbyId,
      agents: row ? (JSON.parse(String(row.agents)) as BoardConfig['agents']) : {},
      visibility: (row?.visibility as BoardVisibility | undefined) ?? 'private',
      summary_model:
        (row?.summary_model as BoardConfig['summary_model'] | undefined) ?? SUMMARY_MODELS[0],
      summary_effort: (row?.summary_effort as BoardConfig['summary_effort'] | undefined) ?? 'low',
      updated_at: (row?.updated_at as string | null | undefined) ?? null,
      sources: this.boardSources(lobbyId),
    };
  }
  /**
   * Set where one room's notes are. The room must exist now; deleting it later keeps the source
   * until the owner removes it. A changed source drops its old snapshot. A console owner may name
   * only a repository the operator approved for the lobby; the operator's own setting approves
   * its repository.
   */
  setBoardSource(
    lobbyId: string,
    roomId: string,
    raw: BoardSourceInput,
    actor: Actor,
  ): BoardConfig {
    const input = BoardSourceSchema.parse(raw);
    const repo = input.repo.toLowerCase();
    this.transaction(() => {
      const id = this.boardLobby(actor, lobbyId);
      this.room(id, RoomId.parse(roomId));
      if (typeof actor === 'object') {
        if (!this.one('SELECT 1 FROM lobby_repos WHERE lobby_id=? AND repo=?', id, repo))
          fail(
            403,
            'repo_not_approved',
            'The operator has not approved that repository for this lobby',
          );
      } else
        this.run(
          'INSERT INTO lobby_repos(lobby_id,repo,added_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          id,
          repo,
          this.iso(),
        );
      const previous = this.boardSources(id).find((source) => source.room_id === roomId);
      // Capacity counts archived rooms' kept sources too, so a restore can never exceed it.
      const kept = Number(
        this.one('SELECT COUNT(*) AS n FROM board_sources WHERE lobby_id=?', id)!.n,
      );
      const exists = !!this.one(
        'SELECT 1 FROM board_sources WHERE lobby_id=? AND room_id=?',
        id,
        roomId,
      );
      if (!exists && kept >= MAX_BOARD_SOURCES)
        fail(409, 'board_source_capacity', `A board reads at most ${MAX_BOARD_SOURCES} sources`);
      if (previous && sourceKey(previous) !== sourceKey({ room_id: roomId, ...input }))
        this.run('DELETE FROM board_notes WHERE lobby_id=? AND room_id=?', id, roomId);
      this.run(
        'INSERT INTO board_sources(lobby_id,room_id,repo,ref,notes,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(lobby_id,room_id) DO UPDATE SET repo=excluded.repo,ref=excluded.ref,notes=excluded.notes,updated_at=excluded.updated_at',
        id,
        roomId,
        input.repo,
        input.ref,
        JSON.stringify(input.notes),
        this.iso(),
      );
      this.audit(actor, 'board_source_set', id, roomId, {
        repo: input.repo,
        ref: input.ref,
        notes: input.notes,
      });
    });
    return this.boardConfig(lobbyId);
  }
  /** Stop reading one room's notes; its snapshot goes with it. */
  removeBoardSource(lobbyId: string, roomId: string, actor: Actor): BoardConfig {
    this.transaction(() => {
      const id = this.actorLobby(actor, lobbyId);
      if (!this.run('DELETE FROM board_sources WHERE lobby_id=? AND room_id=?', id, roomId))
        fail(404, 'board_source_not_found', 'This board reads no notes for that room');
      this.audit(actor, 'board_source_remove', id, roomId);
    });
    return this.boardConfig(lobbyId);
  }
  /** Change board settings, creating the row with defaults first. */
  private updateBoardConfig(lobbyId: string, values: Record<string, string>): void {
    this.run(
      'INSERT INTO board_configs(lobby_id,updated_at) VALUES(?,?) ON CONFLICT(lobby_id) DO NOTHING',
      lobbyId,
      this.iso(),
    );
    for (const [column, value] of Object.entries(values))
      this.run(
        `UPDATE board_configs SET ${column}=?,updated_at=? WHERE lobby_id=?`,
        value,
        this.iso(),
        lobbyId,
      );
  }
  /** Replace how agents look on the board: their emoji and optional display names. */
  setBoardAgents(lobbyId: string, raw: BoardAgentsInput): BoardConfig {
    const input = BoardAgentsSchema.parse(raw);
    this.transaction(() => {
      const id = this.boardLobby('owner', lobbyId);
      this.updateBoardConfig(id, { agents: JSON.stringify(input.agents) });
      this.audit(null, 'board_agents', id);
    });
    return this.boardConfig(lobbyId);
  }
  /** Which model and effort write the lobby's summaries (0.5.0). */
  setSummarySettings(actor: Actor, lobbyId: string, raw: unknown): BoardConfig {
    const input = SummarySettingsSchema.parse(raw);
    this.transaction(() => {
      const id = this.boardLobby(actor, lobbyId);
      this.updateBoardConfig(id, { summary_model: input.model, summary_effort: input.effort });
      this.audit(actor, 'summary_settings', id, null, input);
    });
    return this.boardConfig(lobbyId);
  }
  /**
   * Make a board private or public (0.5.0). Access is decided on every request, so a change
   * applies to the next page view: private again closes it to everyone but the owner and the
   * listed viewers.
   */
  setBoardVisibility(actor: Actor, lobbyId: string, visibility: BoardVisibility): BoardConfig {
    this.transaction(() => {
      const id = this.boardLobby(actor, lobbyId);
      this.updateBoardConfig(id, { visibility });
      this.audit(actor, 'board_visibility', id, visibility);
    });
    return this.boardConfig(lobbyId);
  }

  /**
   * A lobby's own board icon, or null for PocoLobby's (0.8.2). It is kept in metadata under
   * `board_icon:<lobby>`, so it needed no schema change and an older broker simply ignores it.
   */
  boardIcon(lobbyId: string): { png: Buffer; sha256: string; set_at: string } | null {
    const row = this.one('SELECT value FROM metadata WHERE key=?', `board_icon:${lobbyId}`);
    if (!row) return null;
    const icon = JSON.parse(String(row.value)) as { png: string; sha256: string; set_at: string };
    return { png: Buffer.from(icon.png, 'base64'), sha256: icon.sha256, set_at: icon.set_at };
  }
  /**
   * A lobby's display name, such as My Team for my-team, or null to show its name
   * (0.8.2). Kept in metadata under `display_name:<lobby>`, like its board icon.
   */
  displayName(lobbyId: string): string | null {
    const row = this.one('SELECT value FROM metadata WHERE key=?', `display_name:${lobbyId}`);
    return row ? String(row.value) : null;
  }
  /** Set a lobby's display name; an empty one shows its name again. */
  setDisplayName(
    actor: Actor,
    lobbyId: string,
    raw: unknown,
  ): { lobby_id: string; display_name: string | null } {
    const name = DisplayName.parse(raw) || null;
    return this.transaction(() => {
      const id = this.actorLobby(actor, lobbyId);
      const key = `display_name:${id}`;
      if (name === this.displayName(id)) return { lobby_id: id, display_name: name };
      if (name)
        this.run(
          'INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2',
          key,
          name,
        );
      else this.run('DELETE FROM metadata WHERE key=?', key);
      this.audit(actor, 'display_name', id, name);
      return { lobby_id: id, display_name: name };
    });
  }
  /** Give a board its own icon, a checked PNG, or null to go back to PocoLobby's. */
  setBoardIcon(
    actor: Actor,
    lobbyId: string,
    png: Buffer | null,
  ): { icon: { sha256: string; bytes: number } | null } {
    if (png) checkLobbyIcon(png);
    return this.transaction(() => {
      const id = this.boardLobby(actor, lobbyId);
      const key = `board_icon:${id}`;
      if (!png) {
        if (this.run('DELETE FROM metadata WHERE key=?', key))
          this.audit(actor, 'board_icon_remove', id);
        return { icon: null };
      }
      const sha256 = createHash('sha256').update(png).digest('hex');
      this.run(
        'INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2',
        key,
        JSON.stringify({ png: png.toString('base64'), sha256, set_at: this.iso() }),
      );
      this.audit(actor, 'board_icon', id, null, { sha256, bytes: png.length });
      return { icon: { sha256, bytes: png.length } };
    });
  }

  /** Each room's last good notes snapshot. */
  /** What the board page shows of each room's notes, without reading their contents. */
  boardNoteFacts(
    lobbyId: string,
  ): Map<string, { commit_sha: string; fetched_at: string; files: number; cut: string[] }> {
    return new Map(
      this.all(
        "SELECT room_id,commit_sha,fetched_at,(SELECT COUNT(*) FROM json_each(files)) AS files,(SELECT json_group_array(json_extract(value,'$.path')) FROM json_each(files) WHERE json_extract(value,'$.truncated')) AS cut FROM board_notes WHERE lobby_id=?",
        lobbyId,
      ).map((row) => [
        String(row.room_id),
        {
          commit_sha: String(row.commit_sha),
          fetched_at: String(row.fetched_at),
          files: Number(row.files),
          cut: JSON.parse(String(row.cut)) as string[],
        },
      ]),
    );
  }
  boardNotes(lobbyId: string): Map<string, NotesSnapshot> {
    return new Map(
      this.all('SELECT * FROM board_notes WHERE lobby_id=?', lobbyId).map((row) => [
        String(row.room_id),
        {
          commit_sha: String(row.commit_sha),
          files: JSON.parse(String(row.files)) as NotesFile[],
          fetched_at: String(row.fetched_at),
        },
      ]),
    );
  }
  /**
   * Replace one room's notes snapshot, fetched beforehand outside any transaction. A fetch for a
   * source the board no longer reads stores nothing; returns whether it was stored.
   */
  saveBoardNotes(lobbyId: string, source: NotesSource, snapshot: NotesSnapshot): boolean {
    return this.transaction(() => {
      const current = this.boardSources(lobbyId).find((item) => item.room_id === source.room_id);
      if (!current || sourceKey(current) !== sourceKey(source)) return false;
      this.run(
        'INSERT INTO board_notes(lobby_id,room_id,commit_sha,files,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(lobby_id,room_id) DO UPDATE SET commit_sha=excluded.commit_sha,files=excluded.files,fetched_at=excluded.fetched_at',
        lobbyId,
        source.room_id,
        snapshot.commit_sha,
        JSON.stringify(snapshot.files),
        snapshot.fetched_at,
      );
      return true;
    });
  }
  /** Recent reports and assignments, newest first, each read only up to `characters`. */
  boardMessages(
    lobbyId: string,
    sinceMs: number,
    limit: number,
    characters: number,
  ): BoardMessage[] {
    return this.all(
      "SELECT sequence,sender,target,details,room_id,kind,created_at,substr(content,1,?) AS content FROM messages WHERE lobby_id=? AND kind IN ('report','assignment') AND created_ms>? AND cancelled_at IS NULL AND (deliver_at_ms IS NULL OR released_ms IS NOT NULL) ORDER BY sequence DESC LIMIT ?",
      characters,
      lobbyId,
      sinceMs,
      limit,
    ).map((row) => ({
      sequence: Number(row.sequence),
      from: parsePrincipal(String(row.sender)).agent_id,
      to: String(row.target),
      ...addressedOf(row.details),
      room_id: row.room_id as string | null,
      kind: row.kind as BoardMessage['kind'],
      created_at: String(row.created_at),
      content: String(row.content),
    }));
  }
  /**
   * The board's communication history, per agent and slot of `slotMs` from `sinceMs`: the
   * messages it sent, and the direct messages it received. A send counts when the agent made it,
   * so its schedules' occurrences do not; a scheduled direct message counts as received when it
   * was delivered. Room messages count only for their sender.
   */
  boardTraffic(
    lobbyId: string,
    sinceMs: number,
    slotMs: number,
  ): { agent_id: string; slot: number; sent: number; received: number }[] {
    const lobby = this.requireLobby(lobbyId);
    // Each arm takes the window's start, the slot length, the lobby and the start again. Bound
    // numbers are reals to SQLite, so slots are cast back to whole numbers.
    const window = [sinceMs, slotMs, lobby, sinceMs];
    return this.all(
      `SELECT agent, slot, SUM(sent) AS sent, SUM(received) AS received FROM (
        SELECT sender AS agent, CAST((created_ms - ?) / ? AS INTEGER) AS slot, 1 AS sent, 0 AS received
          FROM messages WHERE lobby_id=? AND created_ms>=? AND schedule_id IS NULL
        UNION ALL
        SELECT d.agent_id, CAST((m.created_ms - ?) / ? AS INTEGER), 0, 1
          FROM messages m JOIN deliveries d ON d.message_id=m.id
          WHERE m.lobby_id=? AND m.created_ms>=? AND m.deliver_at_ms IS NULL
            AND m.room_id IS NULL AND m.target<>'*'
        UNION ALL
        SELECT d.agent_id, CAST((m.released_ms - ?) / ? AS INTEGER), 0, 1
          FROM messages m JOIN deliveries d ON d.message_id=m.id
          WHERE m.lobby_id=? AND m.released_ms IS NOT NULL AND m.released_ms>=?
            AND m.room_id IS NULL AND m.target<>'*' AND m.cancelled_at IS NULL
      ) GROUP BY agent, slot`,
      ...window,
      ...window,
      ...window,
    ).map((row) => ({
      agent_id: parsePrincipal(String(row.agent)).agent_id,
      slot: Number(row.slot),
      sent: Number(row.sent),
      received: Number(row.received),
    }));
  }
  private summaryRecord(row: Row): SummaryRecord {
    return {
      sequence: Number(row.sequence),
      lobby_id: String(row.lobby_id),
      created_at: String(row.created_at),
      created_ms: Number(row.created_ms),
      input_hash: String(row.input_hash),
      sources: JSON.parse(String(row.sources)) as SummaryRecord['sources'],
      model: String(row.model),
      usage: {
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
        cache_creation_input_tokens: Number(row.cache_creation_input_tokens),
        cache_read_input_tokens: Number(row.cache_read_input_tokens),
      },
      cost_usd: Number(row.cost_usd),
      summary: row.summary === null ? null : (JSON.parse(String(row.summary)) as Summary),
      error: row.error as string | null,
    };
  }
  /** The newest summary that succeeded. */
  boardSummary(lobbyId: string): SummaryRecord | null {
    const row = this.one(
      'SELECT * FROM board_summaries WHERE lobby_id=? AND summary IS NOT NULL ORDER BY sequence DESC LIMIT 1',
      lobbyId,
    );
    return row ? this.summaryRecord(row) : null;
  }
  /** The newest summarizer attempt, successful or not. */
  boardLastAttempt(lobbyId: string): SummaryRecord | null {
    const row = this.one(
      'SELECT * FROM board_summaries WHERE lobby_id=? ORDER BY sequence DESC LIMIT 1',
      lobbyId,
    );
    return row ? this.summaryRecord(row) : null;
  }
  /**
   * Store a summarizer attempt: its summary or its error, with what it cost. Attempts older than
   * 30 days go, except the newest good summary, so a quiet month still shows the last board.
   */
  saveBoardSummary(
    record: Omit<SummaryRecord, 'sequence' | 'created_at' | 'created_ms'>,
  ): SummaryRecord {
    return this.transaction(() => {
      this.requireLobby(record.lobby_id);
      const now = this.clock();
      this.run(
        'INSERT INTO board_summaries(lobby_id,created_at,created_ms,input_hash,sources,model,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,cost_usd,summary,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        record.lobby_id,
        new Date(now).toISOString(),
        now,
        record.input_hash,
        JSON.stringify(record.sources),
        record.model,
        record.usage.input_tokens,
        record.usage.output_tokens,
        record.usage.cache_creation_input_tokens,
        record.usage.cache_read_input_tokens,
        record.cost_usd,
        record.summary === null ? null : JSON.stringify(record.summary),
        record.error,
      );
      this.run(
        'DELETE FROM board_summaries WHERE lobby_id=? AND created_ms<? AND sequence IS NOT (SELECT MAX(sequence) FROM board_summaries WHERE lobby_id=? AND summary IS NOT NULL)',
        record.lobby_id,
        now - 30 * 24 * 60 * 60 * 1000,
        record.lobby_id,
      );
      return this.boardLastAttempt(record.lobby_id)!;
    });
  }
  /** Summarizer attempts and their cost since a time, failures included. */
  boardUsage(
    lobbyId: string,
    sinceMs: number,
  ): {
    runs: number;
    failed: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  } {
    const row = this.one(
      'SELECT COUNT(*) AS runs, COUNT(error) AS failed, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens+cache_read_input_tokens+cache_creation_input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM board_summaries WHERE lobby_id=? AND created_ms>=?',
      lobbyId,
      sinceMs,
    )!;
    return {
      runs: Number(row.runs),
      failed: Number(row.failed),
      cost_usd: Number(row.cost),
      input_tokens: Number(row.input),
      output_tokens: Number(row.output),
    };
  }

  // ----- Console and browser sign-in (0.5.0) -----
  // An account is a person, keyed by normalized email: it owns lobbies, views private boards or
  // may create lobbies. Access is decided on every request by joins over these rows, so a revoked
  // account, a removed viewer or a changed visibility applies to the next request.

  /** A lobby the account owns, inside the caller's transaction; any other looks like no lobby. */
  private ownedLobby(accountId: string, lobbyId: string): string {
    const id = LobbyId.safeParse(lobbyId).data;
    if (
      id === undefined ||
      !this.one(
        'SELECT 1 FROM lobbies l JOIN accounts a ON a.account_id=l.owner_account WHERE l.lobby_id=? AND a.account_id=? AND a.disabled_at IS NULL',
        id,
        accountId,
      )
    )
      return fail(404, 'lobby_not_found', 'Unknown lobby');
    return id;
  }
  /** The lobby an actor may change: any for the operator, owned ones for an account. */
  private actorLobby(actor: Actor, lobbyId: string): string {
    return typeof actor === 'object'
      ? this.ownedLobby(actor.account_id, lobbyId)
      : this.requireLobby(lobbyId);
  }
  /** Whether a console account owns this lobby now. */
  ownsLobby(accountId: string, lobbyId: string): boolean {
    try {
      this.ownedLobby(accountId, lobbyId);
      return true;
    } catch {
      return false;
    }
  }
  private ensureAccount(email: string): string {
    const existing = this.one('SELECT account_id FROM accounts WHERE email=?', email);
    if (existing) return String(existing.account_id);
    const id = randomUUID();
    this.run(
      'INSERT INTO accounts(account_id,email,created_at) VALUES(?,?,?)',
      id,
      email,
      this.iso(),
    );
    return id;
  }
  private accountListing(row: Row): AccountListing {
    const id = String(row.account_id);
    return {
      account_id: id,
      email: String(row.email),
      may_create_lobbies: Boolean(row.may_create_lobbies),
      created_at: String(row.created_at),
      disabled_at: row.disabled_at as string | null,
      owns: this.all(
        'SELECT lobby_id FROM lobbies WHERE owner_account=? ORDER BY lobby_id',
        id,
      ).map((item) => String(item.lobby_id)),
      views: this.all(
        'SELECT lobby_id FROM board_viewers WHERE account_id=? ORDER BY lobby_id',
        id,
      ).map((item) => String(item.lobby_id)),
    };
  }
  /** Every account with what it owns and views, for the operator. */
  accounts(): AccountListing[] {
    return this.all('SELECT * FROM accounts ORDER BY email').map((row) => this.accountListing(row));
  }
  /**
   * The operator enables or disables an account, or lets it create lobbies. Disabling ends every
   * console and board session and hand-off of the account at once, and its outstanding code
   * (stored under `codeKey`, the MAC of its address), so enabling it later revives none of them.
   */
  setAccount(raw: AccountSettingsInput, codeKey: string): AccountListing {
    const input = AccountSettingsSchema.parse(raw);
    return this.transaction(() => {
      const id = this.ensureAccount(input.email);
      if (input.may_create_lobbies !== undefined)
        this.run(
          'UPDATE accounts SET may_create_lobbies=? WHERE account_id=?',
          Number(input.may_create_lobbies),
          id,
        );
      if (input.enabled === true)
        this.run('UPDATE accounts SET disabled_at=NULL WHERE account_id=?', id);
      if (input.enabled === false) {
        this.run(
          'UPDATE accounts SET disabled_at=COALESCE(disabled_at,?) WHERE account_id=?',
          this.iso(),
          id,
        );
        for (const table of ['console_sessions', 'board_sessions', 'board_handoffs'])
          this.run(`DELETE FROM ${table} WHERE account_id=?`, id);
        this.run('DELETE FROM sign_in_codes WHERE email_key=?', codeKey);
      }
      this.audit(null, 'account', null, input.email, {
        enabled: input.enabled,
        may_create_lobbies: input.may_create_lobbies,
      });
      return this.accountListing(this.one('SELECT * FROM accounts WHERE account_id=?', id)!);
    });
  }
  /** The operator makes an account (created if new) the owner of a lobby without another owner. */
  grantLobby(email: string, lobbyId: string): AccountListing {
    const address = Email.parse(email);
    return this.transaction(() => {
      const lobby = this.requireLobby(lobbyId);
      const id = this.ensureAccount(address);
      const owner = this.one('SELECT owner_account FROM lobbies WHERE lobby_id=?', lobby)!
        .owner_account as string | null;
      if (owner !== null && owner !== id)
        fail(409, 'lobby_owned', 'Another account owns this lobby; end that ownership first');
      this.run('UPDATE lobbies SET owner_account=? WHERE lobby_id=?', id, lobby);
      this.audit(null, 'grant_lobby', lobby, address);
      return this.accountListing(this.one('SELECT * FROM accounts WHERE account_id=?', id)!);
    });
  }
  /** The operator ends an account's ownership of one lobby; the lobby is left without an owner. */
  ungrantLobby(email: string, lobbyId: string): AccountListing {
    const address = Email.parse(email);
    return this.transaction(() => {
      const lobby = this.requireLobby(lobbyId);
      const row = this.one(
        'SELECT a.* FROM accounts a JOIN lobbies l ON l.owner_account=a.account_id WHERE a.email=? AND l.lobby_id=?',
        address,
        lobby,
      );
      if (!row) fail(404, 'owner_not_found', 'That account does not own this lobby');
      this.run('UPDATE lobbies SET owner_account=NULL WHERE lobby_id=?', lobby);
      this.audit(null, 'ungrant_lobby', lobby, address);
      return this.accountListing(row!);
    });
  }

  /**
   * An address that may receive a sign-in code: an enabled account that may create lobbies,
   * owns one or views a board.
   */
  private eligibleAccount(email: string): string | null {
    const row = this.one(
      'SELECT account_id FROM accounts a WHERE email=? AND disabled_at IS NULL AND (may_create_lobbies=1 OR EXISTS (SELECT 1 FROM lobbies l WHERE l.owner_account=a.account_id) OR EXISTS (SELECT 1 FROM board_viewers v WHERE v.account_id=a.account_id))',
      email,
    );
    return row ? String(row.account_id) : null;
  }
  /** Seconds until a windowed limit admits another attempt, or 0. */
  private limitWait(key: string, limit: number, windowMs: number): number {
    const row = this.one('SELECT window_ms,count FROM sign_in_limits WHERE key=?', key);
    const now = this.clock();
    if (!row || now - Number(row.window_ms) >= windowMs || Number(row.count) < limit) return 0;
    return Math.max(1, Math.ceil((Number(row.window_ms) + windowMs - now) / 1000));
  }
  private limitCount(key: string, windowMs: number): void {
    const now = this.clock();
    this.run(
      'INSERT INTO sign_in_limits(key,window_ms,count) VALUES(?1,?2,1) ON CONFLICT(key) DO UPDATE SET window_ms=CASE WHEN ?2-window_ms>=?3 THEN ?2 ELSE window_ms END, count=CASE WHEN ?2-window_ms>=?3 THEN 1 ELSE count+1 END',
      key,
      now,
      windowMs,
    );
  }
  /**
   * Start a sign-in, in one transaction. Every request counts against its address's limits (one a
   * minute, five an hour) whether or not the address may sign in, so a refusal never tells addresses apart.
   * Only an address that may sign in gets a code, which replaces any earlier one (the per-address
   * wrong-code budget is kept), and only those mails count against the service's hourly ceiling,
   * which therefore bounds what Postmark sends without letting unknown addresses use it up.
   */
  beginSignIn(email: string, emailKey: string, codeMac: string): { wait: number; send: boolean } {
    return this.transaction(() => {
      const wait =
        this.limitWait(`send:${emailKey}`, 1, SIGN_IN.sendWindowMs) ||
        this.limitWait(`send-hour:${emailKey}`, SIGN_IN.sendsPerAddressPerHour, 3_600_000) ||
        this.limitWait('send:all', SIGN_IN.sendsPerHour, 3_600_000);
      if (wait) return { wait, send: false };
      this.limitCount(`send:${emailKey}`, SIGN_IN.sendWindowMs);
      this.limitCount(`send-hour:${emailKey}`, 3_600_000);
      if (!this.eligibleAccount(email)) return { wait: 0, send: false };
      this.limitCount('send:all', 3_600_000);
      const now = this.clock();
      this.run(
        'INSERT INTO sign_in_codes(email_key,code_mac,created_ms,expires_ms,attempts) VALUES(?,?,?,?,0) ON CONFLICT(email_key) DO UPDATE SET code_mac=excluded.code_mac,created_ms=excluded.created_ms,expires_ms=excluded.expires_ms,attempts=0',
        emailKey,
        codeMac,
        now,
        now + SIGN_IN.codeMs,
      );
      return { wait: 0, send: true };
    });
  }
  /**
   * Check a code and, when it is right, consume it and start a console session in the same
   * transaction. A wrong code counts against that code (5 tries) and against the address across
   * resends (10 an hour); those counts are committed although the attempt fails.
   */
  finishSignIn(
    email: string,
    emailKey: string,
    codeMac: string,
    sessionHash: string,
  ): { account_id: string } | { error: 'budget' | 'invalid' | 'attempts'; wait: number } {
    return this.transaction(() => {
      const budget = `wrong:${emailKey}`;
      const wait = this.limitWait(budget, SIGN_IN.wrongPerHour, 3_600_000);
      if (wait) return { error: 'budget' as const, wait };
      const now = this.clock();
      const row = this.one('SELECT * FROM sign_in_codes WHERE email_key=?', emailKey);
      const wrong = (error: 'invalid' | 'attempts') => {
        this.limitCount(budget, 3_600_000);
        return { error, wait: 0 };
      };
      if (!row || Number(row.expires_ms) <= now) return wrong('invalid');
      if (Number(row.attempts) >= SIGN_IN.attempts) return wrong('attempts');
      if (!timingSafeEqual(Buffer.from(String(row.code_mac), 'hex'), Buffer.from(codeMac, 'hex'))) {
        this.run('UPDATE sign_in_codes SET attempts=attempts+1 WHERE email_key=?', emailKey);
        return wrong(Number(row.attempts) + 1 >= SIGN_IN.attempts ? 'attempts' : 'invalid');
      }
      this.run('DELETE FROM sign_in_codes WHERE email_key=?', emailKey);
      const account = this.eligibleAccount(email);
      if (!account) return { error: 'invalid' as const, wait: 0 };
      this.run(
        'INSERT INTO console_sessions(token_hash,account_id,created_ms,refreshed_ms,expires_ms) VALUES(?,?,?,?,?)',
        sessionHash,
        account,
        now,
        now,
        now + SIGN_IN.sessionMs,
      );
      return { account_id: account };
    });
  }
  /** The account of a live console session; a disabled account has none. */
  consoleSession(
    tokenHash: string,
  ): { account_id: string; email: string; may_create_lobbies: boolean; refresh: boolean } | null {
    const row = this.one(
      'SELECT a.account_id,a.email,a.may_create_lobbies,s.refreshed_ms FROM console_sessions s JOIN accounts a ON a.account_id=s.account_id WHERE s.token_hash=? AND s.expires_ms>? AND a.disabled_at IS NULL',
      tokenHash,
      this.clock(),
    );
    return row
      ? {
          account_id: String(row.account_id),
          email: String(row.email),
          may_create_lobbies: Boolean(row.may_create_lobbies),
          refresh: this.clock() - Number(row.refreshed_ms) >= 86_400_000,
        }
      : null;
  }
  /** A session in use is extended to 30 days from now, at most once a day. */
  refreshConsoleSession(tokenHash: string): void {
    const now = this.clock();
    this.run(
      'UPDATE console_sessions SET refreshed_ms=?,expires_ms=? WHERE token_hash=?',
      now,
      now + SIGN_IN.sessionMs,
      tokenHash,
    );
  }
  endConsoleSession(tokenHash: string): void {
    this.run('DELETE FROM console_sessions WHERE token_hash=?', tokenHash);
  }

  /** The lobbies an account owns, and the private boards it may view. */
  consoleLobbies(accountId: string): {
    owned: OwnedLobby[];
    viewing: { lobby_id: string; display_name: string | null; visibility: BoardVisibility }[];
  } {
    const owned = this.all(
      "SELECT l.lobby_id,(SELECT value FROM metadata WHERE key='display_name:'||l.lobby_id) AS display_name,l.created_at,COALESCE(c.visibility,'private') AS visibility,(SELECT COUNT(*) FROM agents a WHERE a.lobby_id=l.lobby_id AND a.enabled=1) AS agents,(SELECT COUNT(*) FROM rooms r WHERE r.lobby_id=l.lobby_id) AS rooms FROM lobbies l JOIN accounts o ON o.account_id=l.owner_account LEFT JOIN board_configs c ON c.lobby_id=l.lobby_id WHERE l.owner_account=? AND o.disabled_at IS NULL ORDER BY l.lobby_id",
      accountId,
    ).map((row) => ({
      lobby_id: String(row.lobby_id),
      display_name: (row.display_name as string | null) ?? null,
      created_at: row.created_at as string | null,
      visibility: row.visibility as BoardVisibility,
      agents: Number(row.agents),
      rooms: Number(row.rooms),
    }));
    const viewing = this.all(
      "SELECT v.lobby_id,(SELECT value FROM metadata WHERE key='display_name:'||v.lobby_id) AS display_name,COALESCE(c.visibility,'private') AS visibility FROM board_viewers v JOIN accounts a ON a.account_id=v.account_id JOIN lobbies l ON l.lobby_id=v.lobby_id LEFT JOIN board_configs c ON c.lobby_id=v.lobby_id WHERE v.account_id=? AND a.disabled_at IS NULL AND (l.owner_account IS NULL OR l.owner_account<>v.account_id) ORDER BY v.lobby_id",
      accountId,
    ).map((row) => ({
      lobby_id: String(row.lobby_id),
      display_name: (row.display_name as string | null) ?? null,
      visibility: row.visibility as BoardVisibility,
    }));
    return { owned, viewing };
  }
  /**
   * A console account creates a lobby it owns, with an optional first room, in one transaction:
   * it must be allowed to create lobbies and own fewer than the allowance.
   */
  createOwnedLobby(accountId: string, raw: { lobby_id: string; first_room?: string }): OwnedLobby {
    const id = NewLobbyId.parse(raw.lobby_id);
    const room = raw.first_room === undefined ? undefined : RoomId.parse(raw.first_room);
    this.transaction(() => {
      if (
        !this.one(
          'SELECT 1 FROM accounts WHERE account_id=? AND disabled_at IS NULL AND may_create_lobbies=1',
          accountId,
        )
      )
        fail(403, 'lobby_creation_forbidden', 'This account may not create lobbies');
      const owned = Number(
        this.one('SELECT COUNT(*) AS n FROM lobbies WHERE owner_account=?', accountId)!.n,
      );
      if (owned >= SIGN_IN.lobbiesPerAccount)
        fail(
          409,
          'lobby_allowance',
          `An account may own at most ${SIGN_IN.lobbiesPerAccount} lobbies`,
        );
      this.insertLobby(id, accountId);
      this.audit({ account_id: accountId }, 'create_lobby', id);
      if (room !== undefined) {
        this.run('INSERT INTO rooms(lobby_id,room_id) VALUES(?,?)', id, room);
        this.audit({ account_id: accountId }, 'create_room', id, room);
      }
    });
    return this.consoleLobbies(accountId).owned.find((lobby) => lobby.lobby_id === id)!;
  }

  /** A board's visibility, or null when there is no such lobby. */
  boardVisibility(lobbyId: string): BoardVisibility | null {
    if (!LobbyId.safeParse(lobbyId).success) return null;
    const row = this.one(
      "SELECT COALESCE(c.visibility,'private') AS visibility FROM lobbies l LEFT JOIN board_configs c ON c.lobby_id=l.lobby_id WHERE l.lobby_id=?",
      lobbyId,
    );
    return row ? (row.visibility as BoardVisibility) : null;
  }
  /** Whether an account may open a lobby's private board: enabled, and its owner or a viewer. */
  mayViewBoard(accountId: string, lobbyId: string): boolean {
    return Boolean(
      this.one(
        'SELECT 1 FROM accounts a JOIN lobbies l ON l.lobby_id=? WHERE a.account_id=? AND a.disabled_at IS NULL AND (l.owner_account=a.account_id OR EXISTS (SELECT 1 FROM board_viewers v WHERE v.lobby_id=l.lobby_id AND v.account_id=a.account_id))',
        lobbyId,
        accountId,
      ),
    );
  }
  /** A single-use hand-off to the board host, for an account that may view the board. */
  createHandoff(accountId: string, lobbyId: string, tokenHash: string): boolean {
    return this.transaction(() => {
      if (!this.mayViewBoard(accountId, lobbyId)) return false;
      this.run(
        'INSERT INTO board_handoffs(token_hash,lobby_id,account_id,expires_ms) VALUES(?,?,?,?)',
        tokenHash,
        lobbyId,
        accountId,
        this.clock() + SIGN_IN.handoffMs,
      );
      return true;
    });
  }
  /**
   * Redeem a hand-off on its own board host: it is consumed, checked and turned into a board
   * session in one transaction, so it works once, before it expires, and only while the account
   * may still view the board.
   */
  /**
   * Turn a hand-off into a board session. The browser's current session on this board, if any,
   * ends in the same step, so opening the board again from the console does not count as
   * another device.
   */
  consumeHandoff(
    lobbyId: string,
    tokenHash: string,
    sessionHash: string,
    replacedHash: string | null = null,
  ): boolean {
    return this.transaction(() => {
      const row = this.one(
        'SELECT * FROM board_handoffs WHERE token_hash=? AND lobby_id=?',
        tokenHash,
        lobbyId,
      );
      if (!row) return false;
      this.run('DELETE FROM board_handoffs WHERE token_hash=?', tokenHash);
      const now = this.clock();
      const account = String(row.account_id);
      if (Number(row.expires_ms) <= now || !this.mayViewBoard(account, lobbyId)) return false;
      if (replacedHash)
        this.run(
          'DELETE FROM board_sessions WHERE token_hash=? AND lobby_id=?',
          replacedHash,
          lobbyId,
        );
      this.run(
        'INSERT INTO board_sessions(token_hash,lobby_id,account_id,created_ms,expires_ms) VALUES(?,?,?,?,?)',
        sessionHash,
        lobbyId,
        account,
        now,
        now + SIGN_IN.sessionMs,
      );
      return true;
    });
  }
  /** The address of a board session that still opens this private board, or null. */
  boardViewer(lobbyId: string, tokenHash: string): string | null {
    return this.boardSession(lobbyId, tokenHash)?.email ?? null;
  }
  /**
   * A board session that still opens this private board, and whether it is due for its daily
   * extension: a board kept open as a dashboard never visits the console, whose session would
   * otherwise be the only one extended.
   */
  boardSession(lobbyId: string, tokenHash: string): { email: string; refresh: boolean } | null {
    const now = this.clock();
    const row = this.one(
      'SELECT s.account_id,s.expires_ms,a.email FROM board_sessions s JOIN accounts a ON a.account_id=s.account_id WHERE s.token_hash=? AND s.lobby_id=? AND s.expires_ms>?',
      tokenHash,
      lobbyId,
      now,
    );
    if (!row || !this.mayViewBoard(String(row.account_id), lobbyId)) return null;
    return {
      email: String(row.email),
      refresh: now + SIGN_IN.sessionMs - Number(row.expires_ms) >= 86_400_000,
    };
  }
  /** A board session in use is extended to 30 days from now, at most once a day. */
  refreshBoardSession(tokenHash: string): void {
    this.run(
      'UPDATE board_sessions SET expires_ms=? WHERE token_hash=?',
      this.clock() + SIGN_IN.sessionMs,
      tokenHash,
    );
  }
  endBoardSession(tokenHash: string): void {
    this.run('DELETE FROM board_sessions WHERE token_hash=?', tokenHash);
  }
  /** Board sessions of this lobby that still open it. */
  boardSessionCount(lobbyId: string): number {
    return Number(
      this.one(
        'SELECT COUNT(*) AS n FROM board_sessions s JOIN accounts a ON a.account_id=s.account_id JOIN lobbies l ON l.lobby_id=s.lobby_id WHERE s.lobby_id=? AND s.expires_ms>? AND a.disabled_at IS NULL AND (l.owner_account=s.account_id OR EXISTS (SELECT 1 FROM board_viewers v WHERE v.lobby_id=s.lobby_id AND v.account_id=s.account_id))',
        lobbyId,
        this.clock(),
      )!.n,
    );
  }
  /** The viewers a lobby lists, with their open board sessions. */
  boardViewers(lobbyId: string): BoardViewer[] {
    return this.all(
      'SELECT a.email,v.added_at,a.disabled_at,(SELECT COUNT(*) FROM board_sessions s WHERE s.lobby_id=v.lobby_id AND s.account_id=v.account_id AND s.expires_ms>?) AS sessions FROM board_viewers v JOIN accounts a ON a.account_id=v.account_id WHERE v.lobby_id=? ORDER BY a.email',
      this.clock(),
      lobbyId,
    ).map((row) => ({
      email: String(row.email),
      added_at: String(row.added_at),
      disabled: row.disabled_at !== null,
      sessions: row.disabled_at === null ? Number(row.sessions) : 0,
    }));
  }
  /** Add a viewer of the private board; an existing account keeps its state and permissions. */
  addBoardViewer(actor: Actor, lobbyId: string, email: string): BoardViewer[] {
    const address = Email.parse(email);
    this.transaction(() => {
      const lobby = this.actorLobby(actor, lobbyId);
      if (
        Number(this.one('SELECT COUNT(*) AS n FROM board_viewers WHERE lobby_id=?', lobby)!.n) >=
        SIGN_IN.viewersPerLobby
      )
        fail(409, 'viewer_capacity', `A board lists at most ${SIGN_IN.viewersPerLobby} viewers`);
      this.run(
        'INSERT INTO board_viewers(lobby_id,account_id,added_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        lobby,
        this.ensureAccount(address),
        this.iso(),
      );
      this.audit(actor, 'viewer_add', lobby, address);
    });
    return this.boardViewers(lobbyId);
  }
  /** Remove a viewer; its board sessions of this lobby end with it. */
  removeBoardViewer(actor: Actor, lobbyId: string, email: string): BoardViewer[] {
    const address = Email.parse(email);
    this.transaction(() => {
      const lobby = this.actorLobby(actor, lobbyId);
      const account = this.one('SELECT account_id FROM accounts WHERE email=?', address);
      if (
        !account ||
        !this.run(
          'DELETE FROM board_viewers WHERE lobby_id=? AND account_id=?',
          lobby,
          String(account.account_id),
        )
      )
        fail(404, 'viewer_not_found', 'That address is not a viewer of this board');
      this.run(
        'DELETE FROM board_sessions WHERE lobby_id=? AND account_id=? AND account_id NOT IN (SELECT owner_account FROM lobbies WHERE lobby_id=? AND owner_account IS NOT NULL)',
        lobby,
        String(account!.account_id),
        lobby,
      );
      this.audit(actor, 'viewer_remove', lobby, address);
    });
    return this.boardViewers(lobbyId);
  }

  /** The repositories the operator approved for a lobby's notes sources. */
  lobbyRepos(lobbyId: string): string[] {
    return this.all(
      'SELECT repo FROM lobby_repos WHERE lobby_id=? ORDER BY repo',
      this.requireLobby(lobbyId),
    ).map((row) => String(row.repo));
  }
  /** The operator approves a repository for a lobby: its owner may then read notes from it. */
  approveRepo(lobbyId: string, repo: string): string[] {
    const name = RepoName.parse(repo).toLowerCase();
    this.transaction(() => {
      const lobby = this.requireLobby(lobbyId);
      this.run(
        'INSERT INTO lobby_repos(lobby_id,repo,added_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        lobby,
        name,
        this.iso(),
      );
      this.audit(null, 'repo_approve', lobby, name);
    });
    return this.lobbyRepos(lobbyId);
  }
  /** Withdraw an approval, unless a room's source still reads the repository. */
  removeRepo(lobbyId: string, repo: string): string[] {
    const name = RepoName.parse(repo).toLowerCase();
    this.transaction(() => {
      const lobby = this.requireLobby(lobbyId);
      const rooms = this.all(
        'SELECT room_id FROM board_sources WHERE lobby_id=? AND lower(repo)=? ORDER BY room_id',
        lobby,
        name,
      ).map((row) => String(row.room_id));
      if (rooms.length)
        fail(
          409,
          'repo_in_use',
          `Rooms still read notes from ${name} (${rooms.join(', ')}); remove their sources first`,
          { rooms },
        );
      if (!this.run('DELETE FROM lobby_repos WHERE lobby_id=? AND repo=?', lobby, name))
        fail(404, 'repo_not_found', 'That repository is not approved for this lobby');
      this.audit(null, 'repo_remove', lobby, name);
    });
    return this.lobbyRepos(lobbyId);
  }

  /** A lobby's archived rooms, newest first. */
  archivedRooms(lobbyId: string): { room_id: string; archived_at: string }[] {
    return this.all(
      'SELECT room_id,archived_at FROM archived_rooms WHERE lobby_id=? ORDER BY archived_at DESC,room_id',
      lobbyId,
    ).map((row) => ({ room_id: String(row.room_id), archived_at: String(row.archived_at) }));
  }
  /** Cancel a room's recurring schedules, recording why, and return them (id and sender). */
  private cancelRoomSchedules(
    lobby: string,
    roomId: string,
    reason: 'room_deleted' | 'room_archived',
  ): Row[] {
    const schedules = this.all(
      "SELECT id,sender FROM schedules WHERE lobby_id=? AND cancelled_at IS NULL AND json_extract(template,'$.room')=? ORDER BY created_at",
      lobby,
      roomId,
    );
    for (const schedule of schedules)
      this.run(
        'UPDATE schedules SET cancelled_at=?,next_run_ms=NULL,last_error=? WHERE id=?',
        this.iso(),
        reason,
        String(schedule.id),
      );
    return schedules;
  }

  /**
   * Archive a room (0.5.0): no more sends and no members, but unlike delete_room every message
   * already accepted is still delivered, scheduled ones included, and existing holds stay. The
   * room's recurring schedules are cancelled. The name stays reserved, its notes source is kept
   * but no longer read, and a restore brings the room back empty.
   */
  archiveRoom(actor: Actor, roomId: string, lobbyId: string): ArchivedRoom {
    RoomId.parse(roomId);
    return this.transaction(() => {
      const lobby = this.roomManager(actor, lobbyId);
      const room = this.room(lobby, roomId);
      const schedules = this.cancelRoomSchedules(lobby, roomId, 'room_archived');
      // Members go without holding their deliveries: accepted messages are still delivered.
      this.run('DELETE FROM room_members WHERE lobby_id=? AND room_id=?', lobby, roomId);
      this.run('DELETE FROM rooms WHERE lobby_id=? AND room_id=?', lobby, roomId);
      this.run(
        'INSERT INTO archived_rooms(lobby_id,room_id,archived_at) VALUES(?,?,?)',
        lobby,
        roomId,
        this.iso(),
      );
      this.audit(actor, 'archive_room', lobby, roomId, { former_members: room.members });
      return {
        lobby_id: lobby,
        room_id: roomId,
        archived: true as const,
        former_members: room.members,
        cancelled_schedules: schedules.map((schedule) => ({
          schedule_id: String(schedule.id),
          from: parsePrincipal(String(schedule.sender)).agent_id,
        })),
      };
    });
  }
  /** Restore an archived room, empty: no members, and its cancelled schedules stay cancelled. */
  restoreRoom(actor: Actor, roomId: string, lobbyId: string): Room {
    RoomId.parse(roomId);
    return this.transaction(() => {
      const lobby = this.roomManager(actor, lobbyId);
      if (!this.run('DELETE FROM archived_rooms WHERE lobby_id=? AND room_id=?', lobby, roomId))
        fail(404, 'room_not_found', 'No archived room has that name');
      if (
        Number(this.one('SELECT COUNT(*) AS n FROM rooms WHERE lobby_id=?', lobby)!.n) >=
        this.maxRooms
      )
        fail(409, 'room_capacity', 'Room capacity reached for this lobby');
      this.run('INSERT INTO rooms(lobby_id,room_id) VALUES(?,?)', lobby, roomId);
      this.audit(actor, 'restore_room', lobby, roomId);
      return this.room(lobby, roomId);
    });
  }

  /**
   * Delete a lobby and everything in it, in one transaction: agents and their credentials,
   * rooms, messages, deliveries, schedules, attachments, board settings, notes, summaries,
   * viewers and sessions. The name stays reserved and the deletion stays in the audit log.
   * Attachment content goes only when no other lobby still references the same SHA-256; those
   * files are removed after the commit. Returns the deleted agents, whose sockets the broker
   * closes.
   */
  deleteLobby(
    actor: Actor,
    lobbyId: string,
    confirm: string,
  ): { lobby_id: string; agents: string[] } {
    let orphans: string[] = [];
    const result = this.transaction(() => {
      const lobby = this.actorLobby(actor, lobbyId);
      if (confirm !== lobby)
        fail(400, 'confirmation_mismatch', 'Type the lobby name exactly to delete it');
      const agents = this.all('SELECT agent_id FROM agents WHERE lobby_id=?', lobby).map((row) =>
        String(row.agent_id),
      );
      const candidates = this.all(
        'SELECT sha256 FROM attachments WHERE lobby_id=?1 UNION SELECT sha256 FROM attachment_uploads WHERE lobby_id=?1',
        lobby,
      ).map((row) => String(row.sha256));
      const inLobby = 'SELECT agent_id FROM agents WHERE lobby_id=?1';
      const messages = 'SELECT id FROM messages WHERE lobby_id=?1';
      for (const statement of [
        `DELETE FROM seen_receipts WHERE message_id IN (${messages}) OR sender IN (${inLobby}) OR agent_id IN (${inLobby})`,
        `DELETE FROM notification_attempts WHERE agent_id IN (${inLobby})`,
        `DELETE FROM deliveries WHERE message_id IN (${messages}) OR agent_id IN (${inLobby})`,
        `DELETE FROM message_attachments WHERE message_id IN (${messages}) OR attachment_id IN (SELECT id FROM attachments WHERE lobby_id=?1)`,
        `DELETE FROM schedule_attachments WHERE schedule_id IN (SELECT id FROM schedules WHERE lobby_id=?1 OR sender IN (${inLobby})) OR attachment_id IN (SELECT id FROM attachments WHERE lobby_id=?1)`,
        `DELETE FROM schedules WHERE lobby_id=?1 OR sender IN (${inLobby})`,
        'DELETE FROM messages WHERE lobby_id=?1',
        `DELETE FROM attachment_uploads WHERE lobby_id=?1 OR uploader IN (${inLobby})`,
        'DELETE FROM attachments WHERE lobby_id=?1',
        `DELETE FROM checkpoints WHERE agent_id IN (${inLobby})`,
        `DELETE FROM runtime_history WHERE agent_id IN (${inLobby})`,
        'DELETE FROM room_members WHERE lobby_id=?1',
        'DELETE FROM rooms WHERE lobby_id=?1',
        'DELETE FROM archived_rooms WHERE lobby_id=?1',
        'DELETE FROM board_notes WHERE lobby_id=?1',
        'DELETE FROM board_sources WHERE lobby_id=?1',
        'DELETE FROM board_configs WHERE lobby_id=?1',
        'DELETE FROM board_summaries WHERE lobby_id=?1',
        'DELETE FROM board_sessions WHERE lobby_id=?1',
        'DELETE FROM board_handoffs WHERE lobby_id=?1',
        'DELETE FROM board_viewers WHERE lobby_id=?1',
        "DELETE FROM metadata WHERE key IN ('board_icon:'||?1,'display_name:'||?1)",
        'DELETE FROM lobby_repos WHERE lobby_id=?1',
        'DELETE FROM agents WHERE lobby_id=?1',
        'DELETE FROM lobbies WHERE lobby_id=?1',
      ])
        this.run(statement, lobby);
      // The global reference check: content another lobby holds stays.
      orphans = candidates.filter(
        (sha256) =>
          !this.one(
            'SELECT 1 FROM attachments WHERE sha256=?1 AND expired_at IS NULL UNION ALL SELECT 1 FROM attachment_uploads WHERE sha256=?1 LIMIT 1',
            sha256,
          ),
      );
      for (const sha256 of orphans) this.run('DELETE FROM attachment_blobs WHERE sha256=?', sha256);
      this.run('INSERT INTO deleted_lobbies(lobby_id,deleted_at) VALUES(?,?)', lobby, this.iso());
      this.audit(actor, 'delete_lobby', lobby, null, { agents: agents.length });
      return { lobby_id: lobby, agents };
    });
    if (this.attachmentsDirectory)
      for (const sha256 of orphans)
        try {
          unlinkSync(this.blobPath(sha256));
        } catch {
          /* Already gone, or removed by the next collection pass. */
        }
    return result;
  }

  /** A lobby's audit events, newest first, as the console's Activity shows them. */
  activity(lobbyId: string, limit = 100): ActivityEvent[] {
    return this.all(
      'SELECT e.*,a.email FROM admin_events e LEFT JOIN accounts a ON a.account_id=e.account_id WHERE e.lobby_id=? ORDER BY e.sequence DESC LIMIT ?',
      lobbyId,
      limit,
    ).map((row) => ({
      at: String(row.created_at),
      actor_kind: (row.actor_kind as ActivityEvent['actor_kind'] | null) ?? 'operator',
      actor:
        row.actor_kind === 'agent' && row.agent_id !== null
          ? parsePrincipal(String(row.agent_id)).agent_id
          : row.actor_kind === 'account'
            ? ((row.email as string | null) ?? 'a removed account')
            : null,
      action: String(row.action),
      target: row.target as string | null,
      detail: row.detail === null ? null : (JSON.parse(String(row.detail)) as unknown),
    }));
  }

  /** Expired codes, sessions, hand-offs and rate rows go; an idle broker opens no transaction. */
  pruneSignIn(): void {
    const now = this.clock();
    const edge = now - 3_600_000;
    const due = this.one(
      'SELECT 1 FROM sign_in_codes WHERE expires_ms<=?1 UNION ALL SELECT 1 FROM console_sessions WHERE expires_ms<=?1 UNION ALL SELECT 1 FROM board_sessions WHERE expires_ms<=?1 UNION ALL SELECT 1 FROM board_handoffs WHERE expires_ms<=?1 UNION ALL SELECT 1 FROM sign_in_limits WHERE window_ms<=?2 LIMIT 1',
      now,
      edge,
    );
    if (!due) return;
    this.transaction(() => {
      for (const table of ['sign_in_codes', 'console_sessions', 'board_sessions', 'board_handoffs'])
        this.run(`DELETE FROM ${table} WHERE expires_ms<=?`, now);
      this.run('DELETE FROM sign_in_limits WHERE window_ms<=?', edge);
    });
  }

  enterRecovery(): void {
    this.transaction(() => {
      this.run("UPDATE metadata SET value=? WHERE key='incarnation'", randomUUID());
      this.run(
        'UPDATE agents SET token_hash=NULL,runtime_id=NULL,generation=generation+1,ready=0,paused=1,probe_nonce=lower(hex(randomblob(16))),bootstrap_attempts=0,bootstrap_next_at=?,owner_requests=0,owner_requests_text=NULL,owner_requests_at=NULL',
        this.clock(),
      );
      this.run(
        'UPDATE deliveries SET attempts=0,next_attempt_at=? WHERE seen_at IS NULL',
        this.clock(),
      );
      // A stale backup can roll back a revoked account or a removed viewer too: every browser
      // session ends, and every account waits for the operator to enable it again.
      this.run('DELETE FROM console_sessions');
      this.run('DELETE FROM board_sessions');
      this.run('DELETE FROM board_handoffs');
      this.run('DELETE FROM sign_in_codes');
      this.run('UPDATE accounts SET disabled_at=? WHERE disabled_at IS NULL', this.iso());
      this.audit(null, 'enter_recovery', null);
    });
  }
}
