import { z } from 'zod';
import { AgentId } from './protocol.js';

/**
 * Shared shapes of the progress board (0.4.0). The board is a projection of a lobby's notes,
 * recent reports and live agent facts; it never stores or assigns work itself.
 */

/** How the board shows one agent; set by the owner, never by an agent. */
export interface BoardAgentLook {
  emoji?: string;
  name?: string;
  /** Left off the board's rows and summaries; the agent stays in the lobby. */
  hidden?: true;
}
/** The summarizer models a lobby may choose (0.5.0); the first is the default. */
export const SUMMARY_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
export const MODEL_NAMES: Record<SummaryModel, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
};
export const SUMMARY_EFFORTS = ['low', 'medium', 'high'] as const;
export type SummaryEffort = (typeof SUMMARY_EFFORTS)[number];
export const SummarySettingsSchema = z
  .object({ model: z.enum(SUMMARY_MODELS), effort: z.enum(SUMMARY_EFFORTS) })
  .strict();
/**
 * Who opens a board (0.5.0): `private` for the lobby's owner and the viewers it lists, after
 * email sign-in; `public` for anyone with the address.
 */
export const BoardVisibility = z.enum(['private', 'public']);
export type BoardVisibility = z.infer<typeof BoardVisibility>;

/** A lobby's board settings, set by the owner. */
export interface BoardConfig {
  lobby_id: string;
  agents: Record<string, BoardAgentLook>;
  visibility: BoardVisibility;
  summary_model: SummaryModel;
  summary_effort: SummaryEffort;
  updated_at: string | null;
  /** One notes repository per room; rooms that are archived are left out. */
  sources: BoardSource[];
}
/**
 * Where one room's notes are: paths in one repository, each a directory (every `*.md` directly
 * inside it) or a file such as PLAN.md.
 */
export interface NotesSource {
  room_id: string;
  repo: string;
  ref: string;
  notes: string[];
}
/** The settings a fetch or a snapshot belongs to; a changed source starts afresh. */
export const sourceKey = (source: NotesSource): string =>
  JSON.stringify([source.repo, source.ref, source.notes]);
export interface BoardSource extends NotesSource {
  updated_at: string;
}
/** At most this many sources per lobby. */
export const MAX_BOARD_SOURCES = 10;

const Emoji = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[^\s\p{Cc}<>&"']+$/u, 'One emoji without spaces');
/** A GitHub repository as owner/name. */
export const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u, 'Use owner/repository');
export const BoardSourceSchema = z
  .object({
    repo: RepoName,
    ref: z
      .string()
      .min(1)
      .max(200)
      .regex(/^(?![-/])(?!.*\.\.)[A-Za-z0-9._/-]+$/u, 'Use a branch, tag or commit name')
      .default('main'),
    notes: z
      .array(
        z
          .string()
          .max(200)
          .transform((value) => value.replace(/^\/+|\/+$/gu, ''))
          .refine(
            (value) =>
              /^[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/u.test(value) &&
              !/(^|\/)\.\.?(\/|$)/u.test(value),
            'Use a directory such as notes/ or a file such as PLAN.md',
          ),
      )
      .min(1)
      .max(20)
      .transform((paths) => [...new Set(paths)]),
  })
  .strict();
export type BoardSourceInput = z.input<typeof BoardSourceSchema>;
/** How agents look on the board; the whole map is replaced. */
export const BoardAgentsSchema = z
  .object({
    agents: z
      .record(
        AgentId,
        z
          .object({
            emoji: Emoji.optional(),
            hidden: z.literal(true).optional(),
            name: z
              .string()
              .min(1)
              .max(40)
              .regex(/^[^\p{Cc}]+$/u)
              .optional(),
          })
          .strict(),
      )
      .refine((value) => Object.keys(value).length <= 100, 'At most 100 agents'),
  })
  .strict();
export type BoardAgentsInput = z.input<typeof BoardAgentsSchema>;
/**
 * A board's own icon: a PNG in base64. Its size and shape are checked once decoded, so an
 * oversized one is told its size rather than a string length.
 */
export const BoardIconSchema = z.object({ png: z.base64().min(1).max(700_000) }).strict();

/** One note read at the snapshot's commit. */
export interface NotesFile {
  path: string;
  /** The Git blob SHA, which lets the next fetch reuse unchanged content. */
  sha: string;
  /** The file's whole size; content holds at most the board's share of it. */
  bytes: number;
  /** True when content holds only the beginning of the file. */
  truncated: boolean;
  content: string;
}
/** Every note of one commit: a concurrent push never mixes versions. */
export interface NotesSnapshot {
  commit_sha: string;
  files: NotesFile[];
  fetched_at: string;
}

const clamp = (max: number) =>
  z.string().transform((value) => {
    const text = value.replace(/\s+/gu, ' ').trim();
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
  });
const list = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).transform((items) => items.slice(0, max));
/** Next items shown per agent; the count keeps every item the summary named. */
export const SHOWN_NEXT = 4;

/**
 * What the summarizer writes: each agent's current task and what comes next for it, validated
 * after the model answers. Structure must match, or the last good summary stays; over-long
 * strings and lists are clipped visibly instead. `next: null` means the sources do not say,
 * which is not the same as an empty queue.
 */
export const SummarySchema = z.object({
  agents: list(
    z
      .object({
        agent_id: z.string().max(64),
        now: clamp(120),
        next: z.array(clamp(80)).nullable(),
        // A coordinator's one or two sentences on what it has coordinated lately (0.8.5); a
        // summary written before has none.
        today: clamp(140).default(''),
      })
      .transform(({ next, ...agent }) => ({
        ...agent,
        next: next && next.slice(0, SHOWN_NEXT),
        next_count: next ? next.length : null,
      })),
    100,
  ),
});
export type Summary = z.output<typeof SummarySchema>;

/** Token use of one summarizer call; zero when the call failed before the model answered. */
export interface SummaryUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
/** One stored summarizer attempt with its provenance: a summary, or the error. */
export interface SummaryRecord {
  sequence: number;
  lobby_id: string;
  created_at: string;
  created_ms: number;
  /** SHA-256 of the exact request: model, prompt, schema and every source it carried. */
  input_hash: string;
  /** The notes it read: each room's repository and commit. */
  sources: { room_id: string; repo: string; commit_sha: string }[];
  model: string;
  usage: SummaryUsage;
  cost_usd: number;
  summary: Summary | null;
  error: string | null;
}
/** A report or assignment as the board's summarizer sees it. */
export interface BoardMessage {
  sequence: number;
  from: string;
  to: string;
  addressed_to?: string[];
  room_id: string | null;
  kind: 'report' | 'assignment';
  created_at: string;
  content: string;
}
