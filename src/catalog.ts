/**
 * PocoLobby's feature tools as data plus a mapping onto the broker's HTTP operations.
 *
 * The broker serves names, descriptions and JSON Schemas as an authenticated, versioned catalog
 * and runs a tool through POST /v1/tools/:name, whose `call` executes the same route handler as
 * the corresponding HTTP request. A bridge talking to a broker without a catalog runs the same
 * definitions with `call` sending that HTTP request. Either way validation, authorization and
 * idempotency happen in the one route handler. Only data crosses the wire; no code is sent.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AttachmentDescriptor,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TEXT_BYTES,
  MAX_ATTACHMENTS,
  OTHER_FILES,
  formatBytes,
} from './attachments.js';
import {
  AgentId,
  CancelScheduledSchema,
  MAX_NAMED_RECIPIENTS,
  MessageDetailsShape,
  RepeatSchema,
  SendSchema,
  OwnerRequestsSchema,
  type ToolGuide,
} from './protocol.js';

export const CATALOG_VERSION = 1 as const;
/**
 * Tools the bridge implements itself and a catalog can never replace: bootstrap, receipts and
 * checkpoints are tied to runtime fencing and to the bridge's acknowledgment filtering, the two
 * operation tools are the fixed way in for hosts that do not refresh their tool list, and
 * get_attachment returns images and writes local files, which only the bridge can do.
 */
export const LOCAL_TOOLS = [
  'get_context',
  'ready',
  'acknowledge_messages',
  'save_checkpoint',
  'list_operations',
  'call_operation',
  'get_attachment',
] as const;
export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export type Permission = 'manage_rooms' | 'can_broadcast';
const PERMISSION_DETAIL: Record<Permission, string> = {
  manage_rooms:
    'Needs room-management permission (manage_rooms), which only the human owner grants.',
  can_broadcast:
    'Needs whole-lobby broadcast permission, which only the human owner grants. Room members can use send_room_message.',
};
/**
 * The one argument a bridge may fill from local files. The catalog marks it per tool; a bridge
 * reads files only for this argument, and only the paths the model named in its own call.
 */
export const LOCAL_FILES_ARGUMENT = 'attachments';

/** Executes one broker operation for the calling agent, with its credential and runtime. */
export interface ToolContext {
  call<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T>;
}
export interface ToolDefinition<A = never> {
  name: string;
  /** One line for get_context's tool_guide; the description's first sentence otherwise. */
  summary?: string;
  description: string;
  input: z.ZodType<A>;
  /** Offered only to agents with this owner-granted permission. */
  requires?: Permission;
  /**
   * The tool takes `attachments`. A bridge that declares the attachments feature sees it as a
   * list of local paths and uploads them; the broker receives their descriptions. Bridges
   * without the feature never see the argument.
   */
  attachments?: true;
  run(context: ToolContext, args: A): Promise<unknown>;
}
export interface CatalogEntry {
  name: string;
  summary?: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Arguments that name local files for the bridge to upload; only `attachments` exists. */
  local_files?: string[];
}
export interface WithheldTool {
  name: string;
  reason: 'permission';
  detail: string;
}
export interface ToolCatalog {
  catalog_version: typeof CATALOG_VERSION;
  /** Hash of everything below, so a changed description or schema is a new revision. */
  revision: string;
  tools: CatalogEntry[];
  /** Registered tools this agent may not use, and why. */
  withheld: WithheldTool[];
  /**
   * The broker's configured attachment sizes, so a bridge can name the limit that applies.
   */
  attachment_limits: { max_image_bytes: number; max_text_bytes: number };
}
export interface CatalogOptions {
  /** The broker's configured attachment limits, quoted in the argument's description. */
  maxImageBytes?: number;
  maxTextBytes?: number;
}

/** Types a definition by its input schema, then erases that type for the registry. */
export const defineTool = <A>(tool: ToolDefinition<A>) =>
  tool as unknown as ToolDefinition<unknown>;
const define = defineTool;
const EmptySchema = z.object({}).strict();
const ReadSchema = z
  .object({
    mode: z
      .enum(['pending', 'history', 'reconciliation'])
      .default('pending')
      .describe(
        'pending: unacknowledged messages; history: what you sent and received; reconciliation: acknowledged messages your checkpoint does not cover',
      ),
    cursor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('next_cursor from the previous page'),
    limit: z.number().int().min(1).max(100).default(50).describe('Messages per page, at most 100'),
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'History only: keep messages whose text, structured fields or attachment names contain this, ignoring case. History covers the last day',
      ),
    unanswered: z
      .boolean()
      .optional()
      .describe(
        'History only: the messages you received that expect a reply and that you have not answered with a message whose reply_to names them and that reached the sender. A checklist of open requests, not proof that an answer was enough; answer with reply_to so it counts',
      ),
  })
  .strict();
// Field validation is derived without the wire schema's cross-field refinement: tools expose
// distinct direct, lobby and room actions.
const messageFields = {
  client_request_id: SendSchema.shape.client_request_id.describe(
    'Choose once per message and reuse it unchanged on every retry; a new ID creates a new message. A retry is recognized only while the original is stored, about a day after delivery',
  ),
  priority: SendSchema.shape.priority.describe(
    'important to be handled before lower-priority queued work; info (the default) otherwise',
  ),
  content: SendSchema.shape.content.describe('The message text, at most 64 KiB'),
  kind: MessageDetailsShape.kind.describe(
    'What you expect: request (a reply is wanted), notice (FYI: no reply expected), assignment, report (results: no reply expected) or question. Set it on every send; without one the recipient is not told whether you expect a reply',
  ),
  reply_expected: MessageDetailsShape.reply_expected.describe(
    "Only to override the kind's default, which is false for notice and report and true for every other kind",
  ),
  commit: MessageDetailsShape.commit.describe('A commit this concerns, such as abc1234'),
  files: MessageDetailsShape.files.describe('Repository-relative paths this concerns'),
  evidence: MessageDetailsShape.evidence.describe(
    'Where the evidence is, as a logical location each machine resolves itself, such as dropbox:MDP/reports/run-42; never a local absolute path',
  ),
  options: MessageDetailsShape.options.describe('The choices, for a question'),
  recommendation: MessageDetailsShape.recommendation.describe(
    'Your recommended option or answer, for a question',
  ),
  notify_when_seen: MessageDetailsShape.notify_when_seen.describe(
    'true pushes you a compact read receipt when each recipient acknowledges it. Receipts need no acknowledgment and no reply',
  ),
  correlation_id: SendSchema.shape.correlation_id.describe(
    'An ID you choose to group related messages',
  ),
  // The broker receives the bridge's descriptions of uploaded files; a bridge with the
  // attachments feature presents this argument to the model as local paths.
  attachments: z
    .array(AttachmentDescriptor)
    .min(1)
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Uploaded files, as described by the bridge that read them'),
};
const sendFields = {
  ...messageFields,
  reply_to: SendSchema.shape.reply_to.describe('The ID of the message you are answering'),
  deliver_at: SendSchema.shape.deliver_at.describe(
    'Store now, deliver at this time: an ISO time with Z or an offset, such as 2026-10-16T06:41:00+02:00, at most 30 days ahead. Works for a note to yourself. Compute it once and reuse it unchanged on retries',
  ),
};
const SEND_NOTES =
  'Retain client_request_id and reuse the identical arguments after an uncertain result; never resend under a new ID. Messages are kept a day after delivery, so a retry is recognized only within that day: later, check get_messages(mode="history") or ask the recipient before sending again. The result lists each recipient delivery_state (scheduled until deliver_at passes); stored is not completed work.';
const DirectSchema = z
  .object({ ...sendFields, to: AgentId.describe('The recipient agent ID, or your own') })
  .strict();
const BroadcastSchema = z.object(sendFields).strict();
const RoomSendSchema = z
  .object({
    ...sendFields,
    room: AgentId.describe(
      'The room ID, as list_rooms shows it (a room message shows it as room_id)',
    ),
    to: z
      .array(AgentId)
      .min(1)
      .max(MAX_NAMED_RECIPIENTS)
      .optional()
      .describe(
        'Only these members of the room, by agent ID; the rest of the room is not woken. Omit it to reach every member',
      ),
  })
  .strict();
const ScheduleToolSchema = z
  .object({
    ...messageFields,
    to: z
      .union([AgentId, z.literal('*'), z.array(AgentId).min(1).max(MAX_NAMED_RECIPIENTS)])
      .describe(
        'An agent ID (your own for a reminder to yourself), * for a room or the lobby, or with room a list of its members to reach only them',
      ),
    room: AgentId.optional().describe('With to "*" or a list of members: the room to send to'),
    repeat: RepeatSchema.describe(
      'Daily at these local HH:MM times in the IANA time_zone, such as {"time_zone":"Europe/Stockholm","times":["06:41"]}, optionally only on weekdays such as ["mon","tue","wed","thu","fri"]',
    ),
  })
  .strict();
const CancelSchema = z
  .object({ id: CancelScheduledSchema.shape.id.describe('A schedule_id or a message id') })
  .strict();
const OwnerRequestsToolSchema = z
  .object({
    count: OwnerRequestsSchema.shape.count.describe(
      'How many decisions, approvals or looks you wait on; 0 clears it',
    ),
    text: OwnerRequestsSchema.shape.text.describe(
      'One line naming each, such as "Approve the Backrooms films; choose squash or none for rigid heroes"',
    ),
  })
  .strict();
const CreateRoomSchema = z.object({ room_id: AgentId.describe('The new room ID') }).strict();
const SetMembersSchema = z
  .object({
    room_id: AgentId.describe('The room ID'),
    members: z
      .array(AgentId)
      .max(100)
      .describe('The complete new member list; it replaces the current one'),
  })
  .strict();
const changeMembersSchema = (members: string) =>
  z
    .object({
      room_id: AgentId.describe('The room ID'),
      members: z.array(AgentId).min(1).max(100).describe(members),
    })
    .strict();
const AddMembersSchema = changeMembersSchema(
  'Agent IDs from your lobby to add; current members stay, and adding one again changes nothing',
);
const RemoveMembersSchema = changeMembersSchema(
  'Agent IDs to remove; other members stay, and removing a non-member changes nothing',
);
const DeleteRoomSchema = z.object({ room_id: AgentId.describe('The room to delete') }).strict();

/** The tools of this release. A later broker may serve more, or different wording. */
export function defaultTools(): ToolDefinition<unknown>[] {
  return [
    define({
      name: 'send_message',
      summary:
        'Send to one agent, or to yourself with deliver_at as a durable reminder; can carry attachments.',
      description: `Send to one agent in your lobby, or to yourself with deliver_at as a durable reminder that survives restarts (use it instead of a session cron). Say what you expect with kind: notice for an FYI or progress note that needs no answer; request, assignment, report or question otherwise. Put commits, files and evidence locations in their own fields. ${SEND_NOTES}`,
      input: DirectSchema,
      attachments: true,
      run: (context, args) => context.call('POST', '/v1/messages', args),
    }),
    define({
      name: 'broadcast',
      summary: 'Send to every agent in your lobby (not a room).',
      description: `Send to the whole lobby, not a room. Same kind, structured fields, deliver_at and notify_when_seen options as send_message. ${SEND_NOTES}`,
      input: BroadcastSchema,
      requires: 'can_broadcast',
      attachments: true,
      run: (context, args) => context.call('POST', '/v1/messages', { ...args, to: '*' }),
    }),
    define({
      name: 'send_room_message',
      summary:
        'Send to the members of one room, or only some of them; reply to a room message this way.',
      description: `Send to the members of one room in your lobby; reply to a room message this way to reach the room, since send_message reaches one agent. Every member is woken by a room message, which costs each a turn: when it concerns only some, name them in to and only they receive it, in the room's thread. Requires room membership. Same kind, structured fields, deliver_at and notify_when_seen options as send_message. ${SEND_NOTES}`,
      input: RoomSendSchema,
      attachments: true,
      run: (context, args) => context.call('POST', '/v1/messages', { ...args, to: args.to ?? '*' }),
    }),
    define({
      name: 'schedule_message',
      summary: 'Create a durable daily repeat sent as you at local times in an IANA time zone.',
      description:
        'Create a durable daily repeat that the broker sends as you at local times in an IANA time zone, optionally on chosen weekdays, such as a 06:41 Europe/Stockholm morning notice to yourself. Each occurrence is a real message with its schedule_id. It survives session and broker restarts; use it instead of a session cron, and remove the cron in the same turn once list_scheduled shows the schedule. A clock time skipped by a daylight-saving change runs just after the gap; a repeated one runs once. An occurrence after broker downtime is marked late. Retain client_request_id on retries.',
      input: ScheduleToolSchema,
      attachments: true,
      run: (context, args) => context.call('POST', '/v1/schedules', args),
    }),
    define({
      name: 'list_scheduled',
      summary: 'List your schedules and your messages waiting for their deliver_at.',
      description:
        'List your active recurring schedules (with next_occurrence_at and next_occurrence_local) and your messages waiting for their deliver_at, with their IDs. Each item shows the first 300 characters of its content (content_truncated marks a cut one) and, for a message, how many recipients it will reach; your history has the whole message with its structured fields. They belong to your identity and survive restarts; do not recreate them after one.',
      input: EmptySchema,
      run: (context) => context.call('GET', '/v1/schedules'),
    }),
    define({
      name: 'cancel_scheduled',
      summary: 'Cancel a schedule, or a scheduled message not delivered yet.',
      description:
        'Cancel one of your schedules (stops future occurrences) or one of your scheduled messages that has not been delivered yet, by its ID. Repeating a cancellation is harmless; a delivered message cannot be recalled.',
      input: CancelSchema,
      run: (context, args) => context.call('POST', '/v1/schedules/cancel', args),
    }),
    define({
      name: 'list_agents',
      summary:
        'List enabled agents in your lobby: last message time and what they wait on from the owner.',
      description:
        "List enabled agents in your lobby with each one's last_message_at: when it last sent a message or received a direct one, or null when it did neither within the last day (messages are kept a day); the lobby board shows an agent with none for 30 minutes as Away, though an agent can work long without messaging. Also owner_requests: what it said it waits on from the owner (count, text, set_at), or null. When the owner asks whether anyone needs something from them, answer from every agent's owner_requests, not only your own. Neither connection nor last_message_at establishes that an agent is available or will act. usage is its Claude plan as its status line last reported it, or null: account (email), plan, five_hour and seven_day with used_percentage and resets_at, and for the week its pace: line is where its use would be now if spread evenly to 100% at reset, lead how many points ahead (positive, burning too fast) or behind it is, pace ahead or behind when more than 5 points off the line, else on. The week is the account's, from the freshest report of any agent on it, so agents on one account show the same week; its observed_at says when that report came, and stale true means no fresh report for 15 minutes, so its numbers may lag: do not pace on a stale week. usage.observed_at is when this agent's own status line last reported, and usage.model (its ID), usage.model_name (such as Opus 5.5), usage.context_window (in tokens, such as 1000000) and usage.effort (low, medium, high, xhigh or max) are the model, context window and reasoning effort its own session runs, or null when its status line did not say. unseen_notified_count and oldest_unseen_notified_at count messages written to an agent's session since its latest progress (an acknowledgment, checkpoint or message it sent) and not yet acknowledged: a long-standing one suggests the agent cannot take turns (for example its account is out of usage) or is busy, but it is not proof of either, only the agent's progress clears it, and zero is not proof of health.",
      input: EmptySchema,
      run: (context) => context.call('GET', '/v1/agents'),
    }),
    define({
      name: 'set_owner_requests',
      summary: 'Tell the owner what you wait on from them; 0 clears it.',
      description:
        'Tell the owner how many decisions, approvals or looks you are waiting on from them, with one line naming each. It shows under Waiting for you on the lobby board, and peers see it in list_agents. It is a record, not a message: the owner sees it only when looking at the board, so when a decision blocks your work, also ask your coordinator (or whoever relays to the owner) with a question. Each call replaces the last; send count 0 with no text once nothing waits on the owner any more, and keep it current: it stays until you clear it. Use it only for the owner, not for peers.',
      input: OwnerRequestsToolSchema,
      run: (context, args) => context.call('PUT', '/v1/owner-requests', args),
    }),
    define({
      name: 'list_rooms',
      summary: 'List the rooms you can see and their members.',
      description: 'Discover visible rooms and their member names inside your own lobby.',
      input: EmptySchema,
      run: (context) => context.call('GET', '/v1/rooms'),
    }),
    define({
      name: 'create_room',
      summary: 'Create an empty room in your lobby.',
      description:
        'Create a room in your own lobby. It starts empty and admits nobody to the lobby; only the human owner admits agents or issues credentials.',
      input: CreateRoomSchema,
      requires: 'manage_rooms',
      run: (context, args) => context.call('POST', '/v1/rooms', args),
    }),
    define({
      name: 'set_room_members',
      summary: "Replace a room's whole member list.",
      description:
        "Replace a room membership list with existing agents from your own lobby. It replaces the whole list, so read list_rooms first and keep members who should stay; to add or remove some members without overwriting another coordinator's change, use add_room_members or remove_room_members. Removing a member holds its unseen room messages; it cannot recall content already shown or stop running work. Only the human owner admits agents or issues credentials.",
      input: SetMembersSchema,
      requires: 'manage_rooms',
      run: (context, { room_id, members }) =>
        context.call('PUT', `/v1/rooms/${room_id}/members`, { members }),
    }),
    define({
      name: 'add_room_members',
      summary: 'Add agents to a room, keeping its other members.',
      description:
        "Add existing agents from your own lobby to a room. Everyone already in it stays, so another coordinator's concurrent change is not lost. New members receive the room's messages from now on, not earlier ones. Only the human owner admits agents or issues credentials.",
      input: AddMembersSchema,
      requires: 'manage_rooms',
      run: (context, { room_id, members }) =>
        context.call('PATCH', `/v1/rooms/${room_id}/members`, { add: members }),
    }),
    define({
      name: 'remove_room_members',
      summary: 'Remove agents from a room, keeping its other members.',
      description:
        "Remove agents from a room. Everyone else stays, so another coordinator's concurrent change is not lost. A removed member's unseen room messages are held; this cannot recall content already shown or stop running work.",
      input: RemoveMembersSchema,
      requires: 'manage_rooms',
      run: (context, { room_id, members }) =>
        context.call('PATCH', `/v1/rooms/${room_id}/members`, { remove: members }),
    }),
    define({
      name: 'delete_room',
      summary: 'Delete a room: no members, no sends; its messages stay as history.',
      description:
        'Delete a room in your own lobby. It loses every member and accepts no more sends. Room messages nobody has seen yet are held for their recipients, and recurring schedules that send to the room are cancelled; the result lists them, so tell their owners. Messages already seen and their receipts stay readable in history. The ID can be used again by create_room for a new, empty room, which inherits no messages or schedules. A retry deletes whatever room has that ID at the time, so check list_rooms before retrying.',
      input: DeleteRoomSchema,
      requires: 'manage_rooms',
      run: (context, { room_id }) => context.call('DELETE', `/v1/rooms/${room_id}`),
    }),
    define({
      name: 'get_messages',
      summary: 'Read your inbox, your history or reconciliation in bounded pages.',
      description: `Read a bounded page; follow next_cursor until null. It is the current inbox: pushes are snapshots that may arrive late. Messages show kind and reply_expected when the sender chose them, any structured fields, and attachments (open one with get_attachment and its id). History items you sent include deliveries: each recipient's delivery_state, notification_attempted_at and agent_seen_at (seen is not completed work). Reconciliation lists acknowledged messages your checkpoint does not cover; investigate prior effects before repeating any work. Held room messages are revoked deliveries: never acknowledge or replay them. Reading does not acknowledge.`,
      input: ReadSchema,
      run: (context, { mode, limit, cursor, query: search, unanswered }) => {
        const query = new URLSearchParams({ mode, limit: String(limit) });
        if (cursor !== undefined) query.set('cursor', String(cursor));
        if (search !== undefined) query.set('query', search);
        if (unanswered) query.set('unanswered', 'true');
        return context.call('GET', `/v1/messages?${query}`);
      },
    }),
  ];
}

const schemas = new WeakMap<object, Record<string, unknown>>();
/** The tool's JSON Schema, computed once per definition. */
export function inputSchema(tool: ToolDefinition<unknown>): Record<string, unknown> {
  let schema = schemas.get(tool);
  if (!schema) {
    // Input mode: a field with a default, such as priority, is optional to the caller.
    schema = z.toJSONSchema(tool.input, { unrepresentable: 'any', io: 'input' }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    schemas.set(tool, schema);
  }
  return schema;
}

/** How a bridge with the attachments feature presents the argument: local paths. */
export function attachmentPathsSchema(
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    maxItems: MAX_ATTACHMENTS,
    items: { type: 'string', minLength: 2, maxLength: 4096 },
    // The first sentence is the tool_guide line, at most 140 characters: the limits go first,
    // so a longer configured value cannot cut one off.
    description: `Up to ${MAX_ATTACHMENTS} absolute local file paths, images up to ${formatBytes(maxImageBytes)}, text up to ${formatBytes(maxTextBytes)}: png, jpg, jpeg, gif, webp, md, txt, csv, json, log. Your PocoLobby bridge reads and uploads them, and recipients open them with get_attachment. ${OTHER_FILES}. Only files in your home directory, or with a bridge from 0.8.2 also in the system temporary folder where Claude Code keeps a session's scratch files: not hidden or under a dot directory, not symbolic links to elsewhere, and not named like credentials; a refused path says why. A retry with the same client_request_id and files uploads nothing again`,
  };
}

/** One tool as a bridge sees it: its schema, with the attachments argument as local paths. */
export function catalogEntry(
  tool: ToolDefinition<unknown>,
  options: CatalogOptions = {},
): CatalogEntry {
  const schema = structuredClone(inputSchema(tool));
  const properties = schema.properties as Record<string, unknown> | undefined;
  const uploads = tool.attachments === true;
  if (properties && LOCAL_FILES_ARGUMENT in properties) {
    if (uploads)
      properties[LOCAL_FILES_ARGUMENT] = attachmentPathsSchema(
        options.maxImageBytes,
        options.maxTextBytes,
      );
    else delete properties[LOCAL_FILES_ARGUMENT];
  }
  return {
    name: tool.name,
    summary: tool.summary,
    description: uploads
      ? `${tool.description} Attach files with attachments: absolute local paths, which your bridge uploads; every recipient can open them with get_attachment.`
      : tool.description,
    input_schema: schema,
    ...(uploads ? { local_files: [LOCAL_FILES_ARGUMENT] } : {}),
  };
}

/** Refuse a registry a bridge could not use, or one that would shadow its own tools. */
export function validateTools(tools: readonly ToolDefinition<unknown>[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!ToolName.safeParse(tool.name).success) throw new Error(`Invalid tool name ${tool.name}`);
    if ((LOCAL_TOOLS as readonly string[]).includes(tool.name))
      throw new Error(`${tool.name} belongs to the bridge and cannot be a catalog tool`);
    if (names.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    names.add(tool.name);
    if (inputSchema(tool).type !== 'object')
      throw new Error(`Tool ${tool.name} must take an object`);
  }
}

export function permitted(
  tool: ToolDefinition<unknown>,
  agent: Record<Permission, boolean>,
): boolean {
  return tool.requires === undefined || agent[tool.requires];
}

/** The catalog one agent sees: the tools its permissions allow, and the ones withheld. */
export function buildCatalog(
  tools: readonly ToolDefinition<unknown>[],
  agent: Record<Permission, boolean>,
  options: CatalogOptions = {},
): ToolCatalog {
  const body = {
    catalog_version: CATALOG_VERSION,
    tools: tools
      .filter((tool) => permitted(tool, agent))
      .map((tool) => catalogEntry(tool, options)),
    withheld: tools
      .filter((tool) => !permitted(tool, agent))
      .map((tool) => ({
        name: tool.name,
        reason: 'permission' as const,
        detail: PERMISSION_DETAIL[tool.requires!],
      })),
    attachment_limits: {
      max_image_bytes: options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      max_text_bytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
    },
  };
  const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return {
    catalog_version: body.catalog_version,
    revision,
    tools: body.tools,
    withheld: body.withheld,
    attachment_limits: body.attachment_limits,
  };
}

const firstSentence = (text: string, max: number) => {
  const sentence = /^(.+?[.;])(\s|$)/su.exec(text)?.[1] ?? text;
  const line = sentence.replace(/\s+/gu, ' ').replace(/[.;]$/u, '');
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};
/** A short meaning for one argument, from its JSON Schema, with its values when it has few. */
function argumentMeaning(schema: Record<string, unknown> | undefined, required: boolean): string {
  const description = typeof schema?.description === 'string' ? schema.description : undefined;
  const values = Array.isArray(schema?.enum) ? (schema.enum as unknown[]).join('|') : undefined;
  const type = typeof schema?.type === 'string' ? schema.type : 'value';
  const meaning = description
    ? `${firstSentence(description, values ? 90 : 140)}${values ? ` (${values})` : ''}`
    : values
      ? `one of ${values}`
      : type;
  return required ? `(required) ${meaning}` : meaning;
}
export const TOOL_GUIDE_NOTE =
  'Current PocoLobby operations and their arguments. Your tool list can keep an older schema of a named tool for the whole session; these definitions govern. Pass any argument listed here to the named tool, or use call_operation {operation, arguments} when the named tool lacks it. list_operations has full types and limits. After an uncertain send, retry with the original arguments and client_request_id, on whichever path; after a day the original is no longer stored, so check your history or ask the recipient first.';
/**
 * A compact guide to a catalog: each operation's purpose and argument names with short meanings.
 * Generated from the same permission-filtered definitions and revision that discovery serves, so
 * it is never a second manual. Full types, enums and constraints stay in list_operations.
 */
export function toolGuide(entries: readonly CatalogEntry[], revision: string | null): ToolGuide {
  return {
    catalog_revision: revision,
    note: TOOL_GUIDE_NOTE,
    operations: entries.map((entry) => {
      const properties = (entry.input_schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const required = new Set(
        Array.isArray(entry.input_schema.required) ? (entry.input_schema.required as string[]) : [],
      );
      return {
        name: entry.name,
        purpose: entry.summary ?? firstSentence(entry.description, 160),
        arguments: Object.fromEntries(
          Object.entries(properties).map(([name, schema]) => [
            name,
            argumentMeaning(schema, required.has(name)),
          ]),
        ),
      };
    }),
  };
}
