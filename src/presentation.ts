/**
 * How a push reads. The broker composes this from attributed message fields (sender, scope,
 * kind, timing), never from message text, and sends it with each event. The bridge renders it
 * generically, so new wording or a new message feature needs no bridge update. When an event
 * is too large to carry presentations, the bridge builds the same structure locally.
 */
import type { MessageKind } from './protocol.js';

/** One sentence of advice. `partial` replaces it when only some messages of a batch carry it. */
export interface Guidance {
  text: string;
  partial?: string;
  /** Also shown on a body-less inbox notice that covers the message. */
  in_notices?: boolean;
}
export interface Presentation {
  /** First line for a single message, after "PocoLobby ", without a final period. */
  lead: string;
  /** The message in a list of several. */
  summary: string;
  guidance: Guidance[];
  /** Additional Channel attributes; the bridge sets identity, scope and priority itself. */
  attributes?: Record<string, string>;
}
export interface ReceiptsPresentation {
  lead: string;
  guidance: Guidance[];
}
/** The fields presentation reads. Message content is deliberately not among them. */
export interface Presentable {
  from: string;
  to: string;
  /** A room message to only some of its members. */
  addressed_to?: string[];
  room_id: string | null;
  priority: 'info' | 'important';
  kind?: MessageKind | null;
  reply_expected?: boolean | null;
  deliver_at?: string;
  late?: boolean;
  schedule_id?: string;
  /** File names only; the ids and sizes travel in the payload. */
  attachments?: { filename: string }[];
}

export const IMPORTANT_GUIDANCE =
  'Important: handle it before lower-priority queued work. It did not interrupt any running tool and sets no deadline.';
export const LATE_GUIDANCE =
  'Delivered late: the broker was unavailable at its scheduled time, so check whether it still applies.';
const NO_REPLY = 'No reply expected: do not answer unless you need something from the sender.';
const SOME_NO_REPLY = 'Answer only the messages that expect a reply.';
const ROOM_REPLY = 'Reply to a room with send_room_message; send_message reaches one agent.';
const SOME_REPLY =
  'Sent to only some of the room: reply with send_room_message and to naming whom it concerns (the sender, and the others named if they need it); without to, it wakes the whole room.';
/**
 * How a bridge that can open attachments is told to use them, with how long the broker keeps
 * them: agents asked to know when evidence must be saved elsewhere.
 */
export function openAttachments(retentionDays?: number): string {
  const kept = retentionDays
    ? ` The broker keeps them ${plural(retentionDays, 'day')} after the last message that uses them.`
    : '';
  return `Open attachments with get_attachment and their id: images come back as images, documents as text.${kept} Add save_to, an absolute directory such as a folder in your Dropbox, to keep the original longer; open that saved original for pixel checks, since Claude shows large images scaled down.`;
}
/** Lifecycle guidance that belongs to the bridge, which handles acknowledgments. */
export const ACKNOWLEDGE_GUIDANCE =
  'Acknowledge each ID after reading; seen is not completed work.';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const replyNote = (message: Presentable) =>
  message.reply_expected === undefined || message.reply_expected === null
    ? ''
    : message.reply_expected
      ? ' (reply expected)'
      : ' (no reply expected)';
const named = (message: Presentable) =>
  message.addressed_to ? ` to ${shorten(message.addressed_to.join(', '), 200)} only` : '';
const where = (message: Presentable) =>
  message.room_id
    ? `room ${message.room_id}${named(message)}`
    : message.to === '*'
      ? 'lobby broadcast'
      : 'direct';

const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;
/** "with 2 attachments: before.png, after.png", bounded so the lead stays one short line. */
export function attachmentPhrase(attachments: { filename: string }[]): string {
  const names = attachments.map((attachment) => shorten(attachment.filename, 60)).join(', ');
  return shorten(`with ${plural(attachments.length, 'attachment')}: ${names}`, 320);
}

export function presentMessage(message: Presentable, retentionDays?: number): Presentation {
  const important = message.priority === 'important';
  const scope = message.room_id
    ? `room message in room ${message.room_id}${named(message)}`
    : message.to === '*'
      ? 'lobby broadcast'
      : 'direct message';
  const timing = message.deliver_at
    ? `, ${message.schedule_id ? 'recurring, ' : ''}scheduled for ${message.deliver_at}${message.late ? ', delivered late' : ''}`
    : '';
  const prefix = important ? 'IMPORTANT ' : '';
  const files = message.attachments?.length ? `, ${attachmentPhrase(message.attachments)}` : '';
  const lead = message.kind
    ? `${prefix}${message.kind} from ${message.from}${replyNote(message)}: ${scope}${timing}${files}`
    : `${prefix}${scope} from ${message.from}${timing}${files}`;
  const flags = `${message.attachments?.length ? `, ${plural(message.attachments.length, 'attachment')}` : ''}${message.late ? ', late' : ''}${important ? ' [IMPORTANT]' : ''}`;
  const summary = message.kind
    ? `${message.kind} from ${message.from}${replyNote(message)}, ${where(message)}${flags}`
    : `${where(message)} from ${message.from}${flags}`;
  const guidance: Guidance[] = [];
  if (important) guidance.push({ text: IMPORTANT_GUIDANCE, in_notices: true });
  if (message.reply_expected === false) guidance.push({ text: NO_REPLY, partial: SOME_NO_REPLY });
  if (message.late) guidance.push({ text: LATE_GUIDANCE });
  if (message.room_id) guidance.push({ text: message.addressed_to ? SOME_REPLY : ROOM_REPLY });
  if (message.attachments?.length) guidance.push({ text: openAttachments(retentionDays) });
  return { lead: shorten(lead, 500), summary: shorten(summary, 300), guidance };
}

export interface PresentableReceipt {
  message_id: string;
  seen_by: string;
  seen_at: string;
  kind?: MessageKind | null;
}
export function presentReceipts(receipts: PresentableReceipt[], remaining: number) {
  const list = receipts
    .map(
      (receipt) =>
        `${receipt.seen_by} saw your ${receipt.kind ?? 'message'} (${receipt.message_id}) at ${receipt.seen_at}`,
    )
    .join('; ');
  const guidance: Guidance[] = [];
  if (remaining) guidance.push({ text: `${remaining} more follow in a later receipts event.` });
  guidance.push({
    text: 'No action needed: a receipt is not a message, so do not acknowledge or reply to it. Seen is not completed work.',
  });
  return { lead: `read receipts: ${list}`, guidance } satisfies ReceiptsPresentation;
}

/**
 * Combine the guidance of a batch. A sentence that every message carries is shown as is; one
 * that only some carry is shown in its partial form when it has one. Sentences keep the order
 * of their earliest position in any message, so a fixed per-message order is preserved.
 */
export function mergeGuidance(lists: Guidance[][], include = (_: Guidance) => true): string[] {
  const seen = new Map<string, { entry: Guidance; count: number; rank: number; first: number }>();
  let first = 0;
  for (const list of lists)
    list.forEach((entry, rank) => {
      if (!include(entry)) return;
      const existing = seen.get(entry.text);
      if (existing) {
        existing.count++;
        existing.rank = Math.min(existing.rank, rank);
      } else seen.set(entry.text, { entry, count: 1, rank, first: first++ });
    });
  const lines = [...seen.values()]
    .sort((a, b) => a.rank - b.rank || a.first - b.first)
    .map(({ entry, count }) =>
      count === lists.length || entry.partial === undefined ? entry.text : entry.partial,
    );
  return [...new Set(lines)];
}

/** The first line of a push that carries bodies. */
export function renderPush(
  messages: { priority: 'info' | 'important'; presentation: Presentation }[],
): string {
  const important = messages.filter((message) => message.priority === 'important').length;
  const lead =
    messages.length === 1
      ? `PocoLobby ${messages[0]!.presentation.lead}.`
      : `PocoLobby: ${plural(messages.length, 'message')}${important ? `, ${important} IMPORTANT` : ''}: ${messages.map((message) => message.presentation.summary).join('; ')}.`;
  return [
    lead,
    ...mergeGuidance(messages.map((message) => message.presentation.guidance)),
    ACKNOWLEDGE_GUIDANCE,
  ].join(' ');
}

/**
 * A notice without bodies: backlog after a restart, a retry whose earlier notice was not
 * confirmed, or overflow. Its count is the broker's count of unacknowledged messages when it
 * sent the notice. Claude may show the notice later, so the time is part of the statement.
 */
export function renderHint(
  pendingCount: number,
  sentAt: string,
  covered: { id: string; priority: 'info' | 'important'; presentation: Presentation }[] | undefined,
  unlisted: number,
): string {
  const important = covered?.some((message) => message.priority === 'important') ?? false;
  const parts = [
    `PocoLobby inbox notice${important ? ' (IMPORTANT)' : ''}: as of ${sentAt}, ${plural(pendingCount, 'message')} ${pendingCount === 1 ? 'was' : 'were'} unacknowledged in your inbox.`,
  ];
  if (covered?.length) {
    const list = covered
      .map((message) => `${message.presentation.summary} (${message.id})`)
      .join('; ');
    parts.push(`This notice concerns ${list}${unlisted > 0 ? ` and ${unlisted} more` : ''}.`);
    parts.push(
      ...mergeGuidance(
        covered.map((message) => message.presentation.guidance),
        (entry) => entry.in_notices === true,
      ),
    );
  }
  parts.push(
    'Messages you have acknowledged since then need no action. Otherwise read get_messages(mode="pending") in bounded pages, then acknowledge only the IDs you read. Reconcile prior work rather than repeating uncertain effects.',
  );
  return parts.join(' ');
}

export function renderReceipts(presentation: ReceiptsPresentation): string {
  return [
    `PocoLobby ${presentation.lead}.`,
    ...presentation.guidance.map((entry) => entry.text),
  ].join(' ');
}
