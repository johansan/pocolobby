import { GitHubNotes, NotesError } from './board-github.js';
import {
  MODEL_NAMES,
  sourceKey,
  type BoardConfig,
  type BoardSource,
  type SummaryRecord,
} from './board-model.js';
import {
  anthropicClient,
  requestHash,
  summarize,
  MESSAGE_EXCERPT,
  MESSAGE_LIMIT,
  SummaryFailure,
  summaryRequest,
  type SummaryClient,
} from './board-summary.js';
import { paceState, weeklyPace, type PaceState } from './pace.js';
import {
  LobbyError,
  qualifyAgent,
  windowCovers,
  type Agent,
  type ModelWindow,
  type UsageReport,
} from './protocol.js';
import type { LobbyStore } from './store.js';

/**
 * The progress board service (0.4.0), inside the broker process. When someone opens a board
 * (0.5.1) it reads the board's notes sources from GitHub and, when the input it would summarize
 * changed and the interval has passed, asks the summarizer for a new summary. Everything it
 * stores is a projection; live facts come from the store at render time.
 */
export interface BoardSettings {
  /** Boards live at `<lobby>.<domain>`; empty disables board hosts. */
  domain: string;
  githubToken?: string;
  /** Tests point this at a fake GitHub. */
  githubApi?: string;
  anthropicApiKey?: string;
  /** Replaces the Anthropic client; tests pass a fake. */
  summaryClient?: SummaryClient;
  fetch?: typeof fetch;
  notesIntervalMs?: number;
  summaryIntervalMs?: number;
  /**
   * A request header that carries the client's address, such as `fly-client-ip`, trusted only
   * when every request arrives through that proxy. Unset, the socket address is used.
   */
  clientIpHeader?: string;
}

/** A test summary from the console waits this long after any attempt. */
export const TEST_SUMMARY_MS = 5 * 60_000;
/**
 * What one lobby's summaries may cost in any 24 hours, on the operator's key. Haiku with an open
 * board and changing input stays near $1.60; a lobby on Sonnet could otherwise spend $30 or more.
 */
export const DAILY_SUMMARY_USD = 5;
const DAY_MS = 24 * 60 * 60_000;
/** A notified message unacknowledged for this long marks an agent Not responding. */
export const STALL_MS = 15 * 60_000;
/** An agent that sent no message and received no direct message for this long shows Away. */
export const IDLE_MS = 30 * 60_000;
/** The communication history: the last 24 hours in 15-minute slots, the last one still open. */
export const TRAFFIC_SLOT_MS = 15 * 60_000;
export const TRAFFIC_SLOTS = 96;

export type Chip = 'stalled' | 'wait' | 'coord' | 'away' | 'working';
export const CHIP_LABELS: Record<Chip, string> = {
  stalled: 'Not responding',
  wait: 'Waiting on you',
  coord: 'Coordinator',
  away: 'Away',
  working: 'Working',
};

/**
 * An agent's chip, by precedence: an unacknowledged notified message older than 15 minutes; it
 * says it waits on the owner; away, with its bridge offline or no message sent or direct one
 * received for 30 minutes; the coordinator role; otherwise working. Agents report no status of
 * their own (Johan's choice). A direct message to an offline agent counts as received, so without
 * the bridge check it would show Working for half an hour after its session ended.
 */
export function stateChip(
  agent: Pick<
    Agent,
    | 'manage_rooms'
    | 'unseen_notified_count'
    | 'oldest_unseen_notified_at'
    | 'owner_requests'
    | 'last_message_at'
  >,
  now: number,
  connected = true,
): Chip {
  if (
    agent.unseen_notified_count > 0 &&
    agent.oldest_unseen_notified_at !== null &&
    now - Date.parse(agent.oldest_unseen_notified_at) >= STALL_MS
  )
    return 'stalled';
  if (agent.owner_requests) return 'wait';
  if (
    !connected ||
    agent.last_message_at === null ||
    now - Date.parse(agent.last_message_at) >= IDLE_MS
  )
    return 'away';
  if (agent.manage_rooms) return 'coord';
  return 'working';
}

/** "6 min", "1 h 10 min", "3 d". */
export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 && hours < 6 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
const displayName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const modelName = (model: string) => MODEL_NAMES[model as keyof typeof MODEL_NAMES] ?? model;

export interface AgentRow {
  agent_id: string;
  name: string;
  /** The owner's emoji for this agent, or null for its initial. */
  emoji: string | null;
  chip: Chip;
  /** What it is doing, from the summary. */
  now: string | null;
  /** For a coordinator: what it has coordinated lately, one or two sentences from the summary (0.8.5). */
  today: string | null;
  /** Whether it coordinates (it may manage rooms). */
  coordinator: boolean;
  /** For Not responding: what has not been acknowledged, and since when. */
  stall: string | null;
  /** What comes after the current task; null when unknown. */
  next: { count: number; items: string[] } | null;
  connected: boolean;
  /** Messages it sent and direct messages it received, per slot, oldest first. */
  traffic: { sent: number; received: number }[];
  /** Minutes in slots with any message in or out, such as "3 h 45 min". */
  active: string;
  /** Its Claude plan usage from its status line, or null with no recent reading. */
  usage: UsageView | null;
}
/** A plan window: how much is left and when it resets. */
export interface UsageWindowView {
  left: number;
  resets_at: string;
}
/** A model family's own weekly window on an agent's row, such as Fable's (0.8.6). */
export interface ModelWindowView extends UsageWindowView {
  name: string;
}
export interface UsageView {
  /** The signed-in account, on a private board only (Johan: "show email on private only"). */
  account: string | null;
  plan: string | null;
  five_hour: UsageWindowView | null;
  seven_day: UsageWindowView | null;
  /** The session's model, context window and reasoning effort: "Opus 5.5", "1M", "xhigh" (0.8.5). */
  model: string | null;
  context: string | null;
  effort: string | null;
  /** The weekly windows of the model family this agent's session runs, such as Fable's (0.8.6). */
  windows: ModelWindowView[];
  observed_at: string;
}
/**
 * How a Claude model ID reads: claude-opus-5-5 and claude-opus-5-5[1m] are Opus 5.5 (the context
 * window shows apart); an ID in another form stays as it is.
 */
export function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\w+\])?$/u.exec(id);
  if (!match) return id;
  const [, family = '', major = '', minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}
/**
 * A session's context window in tokens: as its status line reports it (0.8.5), else 1M for a
 * model ID that names it, as claude-opus-5-5[1m] does; null when neither says.
 */
export function contextWindow(report: UsageReport): number | null {
  return report.context ?? (report.model && /\[1m\]$/iu.test(report.model) ? 1_000_000 : null);
}
/** A session's context window as it reads, or null. */
const contextLabelOf = (report: UsageReport): string | null => {
  const tokens = contextWindow(report);
  return tokens === null ? null : contextLabel(tokens);
};
/** A context window as it reads: 1M, 200K. */
export function contextLabel(tokens: number): string {
  return tokens >= 1_000_000 && tokens % 1_000_000 === 0
    ? `${tokens / 1_000_000}M`
    : `${Math.round(tokens / 1000)}K`;
}
/** Model windows that have not reset yet, each with where an evenly spent week would be now. */
function paced(
  windows: ModelWindow[],
  now: number,
): { window: ModelWindow; pace: { line: number; lead: number } }[] {
  return windows.flatMap((window) => {
    const pace = weeklyPace(window.used_percentage, window.resets_at, now);
    return pace ? [{ window, pace }] : [];
  });
}
/** A reading older than this no longer shows: the agent's session has not run for a day. */
export const USAGE_SHOWN_MS = 24 * 60 * 60_000;
/**
 * No fresh report for this long marks a week stale: a running status line resends every five
 * minutes, so three in a row were missed (the session idle or closed, or reporting failed).
 */
export const USAGE_STALE_MS = 15 * 60_000;

/**
 * What the board shows of a reading: windows that have not reset yet, as a whole percentage left,
 * and the account only on a private board.
 */
export function usageView(
  reading: { report: UsageReport; at: number },
  now: number,
  privateBoard: boolean,
): UsageView | null {
  if (now - reading.at >= USAGE_SHOWN_MS) return null;
  const window = (value: UsageReport['five_hour']): UsageWindowView | null =>
    value && value.resets_at * 1000 > now
      ? {
          left: Math.max(0, Math.round(100 - value.used_percentage)),
          resets_at: new Date(value.resets_at * 1000).toISOString(),
        }
      : null;
  const view = {
    account: privateBoard ? (reading.report.account ?? null) : null,
    plan: reading.report.plan ?? null,
    five_hour: window(reading.report.five_hour),
    seven_day: window(reading.report.seven_day),
    model: reading.report.model ? modelLabel(reading.report.model) : null,
    context: contextLabelOf(reading.report),
    effort: reading.report.effort ?? null,
    windows: (reading.report.model_windows ?? []).flatMap((value) => {
      const shown = window(value);
      const model = reading.report.model;
      return shown && model && windowCovers(model, value.name)
        ? [{ name: value.name, ...shown }]
        : [];
    }),
    observed_at: new Date(reading.at).toISOString(),
  };
  return view.five_hour || view.seven_day || view.account || view.model ? view : null;
}
/** One agent's own word that it waits on the owner, as it last set it. */
export interface WaitingRow {
  agent_id: string;
  name: string;
  emoji: string | null;
  count: number;
  text: string;
  /** How long ago it set this, such as "52 min". */
  since: string;
}
export interface SourceRow {
  room_id: string;
  repo: string;
  /** Null until the first snapshot. */
  commit: string | null;
  files: number;
  /** Files of which the board read only the beginning. */
  cut: string[];
  fetched: string | null;
  error: string | null;
}
export interface BoardView {
  lobby_id: string;
  /** How the lobby is shown, such as My Team; null or absent shows lobby_id (0.8.2). */
  display_name?: string | null;
  generated_at: string;
  /** What the board is doing right now: checking the notes or writing a new summary. */
  activity: 'summarizing' | 'checking' | null;
  /** Live: what agents said they wait on from the owner, longest waiting first. */
  waiting: WaitingRow[];
  agents: AgentRow[];
  /** Where the communication history starts, in epoch milliseconds, and its slot length. */
  traffic: { since_ms: number; slot_ms: number };
  sources: SourceRow[];
  summary: { written: string; model: string } | null;
  interval_minutes: number;
  /** Failures and missing settings, in plain words. */
  problems: string[];
  /** Each Claude account its agents report, with its weekly pace. */
  accounts: AccountView[];
}
/** A Claude account as its agents report it, and where its week stands against the line. */
export interface AccountView {
  /** The email on a private board, "Account 1" and so on on a public one. */
  account: string;
  plan: string | null;
  /** The shown agents on it. */
  agents: string[];
  week_used: number;
  week_resets_at: string;
  /** Where its use would be now if spread evenly over the week, and how far ahead it is. */
  line: number;
  lead: number;
  state: PaceState;
  /** Its model families' own weekly windows, such as Fable's, each against its line (0.8.6). */
  windows: {
    name: string;
    used: number;
    resets_at: string;
    line: number;
    lead: number;
    state: PaceState;
  }[];
  observed_at: string;
}
interface Reading {
  report: UsageReport;
  at: number;
}
/** What list_agents tells agents of one agent's plan: both windows, and the week's pace. */
export interface AgentUsage {
  account: string | null;
  plan: string | null;
  five_hour: { used_percentage: number; resets_at: string } | null;
  /** The account's week, from its freshest report, which may come from another agent on it. */
  seven_day: {
    used_percentage: number;
    resets_at: string;
    line: number;
    lead: number;
    pace: PaceState;
    observed_at: string;
    stale: boolean;
  } | null;
  /** The model ID this agent's session runs, such as claude-opus-5-5, as its status line reports it. */
  model: string | null;
  /** How the model reads, such as "Opus 5.5". */
  model_name: string | null;
  /** The session's context window in tokens, such as 1000000 (0.8.5). */
  context_window: number | null;
  /** The session's reasoning effort: low, medium, high, xhigh or max. */
  effort: string | null;
  /**
   * The account's model families with a weekly limit of their own, such as Fable's, each with its
   * line and pace like the week, from the account's freshest look; null when none is known (0.8.6).
   */
  model_windows:
    | {
        name: string;
        used_percentage: number;
        resets_at: string;
        line: number;
        lead: number;
        pace: PaceState;
        observed_at: string;
        stale: boolean;
      }[]
    | null;
  /** When this agent's own status line last reported. */
  observed_at: string;
}

interface SourceState {
  /** The source settings this state belongs to; a changed source starts afresh. */
  key: string;
  etag: string | null;
  checkedAt: number | null;
  error: { message: string; at: number } | null;
}

export class BoardService {
  private readonly github: GitHubNotes | null;
  private readonly client: SummaryClient | null;
  private readonly notesInterval: number;
  readonly summaryInterval: number;
  private readonly sources = new Map<string, SourceState>();
  private readonly running = new Map<string, Promise<void>>();
  /** When each lobby's last paid attempt started, so the interval holds even if storing it fails. */
  private readonly attempts = new Map<string, number>();
  /** When each lobby's summary input was last found unchanged. */
  private readonly unchanged = new Map<string, number>();
  /**
   * What each lobby's last stored summary read: the hash of its input without the messages, and
   * the messages' sequences. Messages leave the input only by expiring after a day, which says
   * nothing new, so an input that only lost some is not summarized again.
   */
  private readonly summarized = new Map<string, { base: string; sequences: Set<number> }>();
  /**
   * A paid attempt whose record could not be stored, not even as a failure (such as on a full
   * disk). Its cost would escape the daily ceiling, so nothing more is paid for until it is.
   */
  private readonly unsaved = new Map<string, Parameters<LobbyStore['saveBoardSummary']>[0]>();
  /**
   * Each agent's latest plan usage, by principal, with when it arrived. In memory only: the
   * status line reports again within minutes of a restart.
   */
  private readonly usage = new Map<string, Reading>();
  /** Lobbies whose summary request is with the model right now. */
  private readonly summarizing = new Set<string>();
  /** Lobbies whose notes are being read from GitHub right now. */
  private readonly checking = new Set<string>();
  private readonly controller = new AbortController();

  constructor(
    private readonly store: LobbyStore,
    readonly settings: BoardSettings,
    private readonly isConnected: (lobbyId: string, agentId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.github = settings.githubToken
      ? new GitHubNotes({
          token: settings.githubToken,
          apiBase: settings.githubApi,
          fetch: settings.fetch,
          now,
        })
      : null;
    this.client =
      settings.summaryClient ??
      (settings.anthropicApiKey ? anthropicClient(settings.anthropicApiKey) : null);
    this.notesInterval = settings.notesIntervalMs ?? 60_000;
    this.summaryInterval = settings.summaryIntervalMs ?? 600_000;
  }

  /** Stops outstanding requests and waits for them before the store closes. */
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.running.values());
  }

  /**
   * Someone is looking at this lobby's board: bring it up to date in the background. Nothing runs
   * on a timer, so a board nobody opens costs nothing. Notes are checked at most once per notes
   * interval and a new summary is written at most once per summary interval, and only when its
   * input changed; meanwhile the page shows the last summary and says it is updating.
   */
  request(lobby: string): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    const busy = this.running.get(lobby);
    if (busy) return busy;
    const work = this.refresh(lobby)
      .catch(() => {
        /* Each step records its own failure; the next visit tries again. */
      })
      .finally(() => this.running.delete(lobby));
    this.running.set(lobby, work);
    return work;
  }

  /**
   * Brings every board with sources up to date, as if each were opened, and returns when done.
   * Nothing in the broker calls it; tests drive the service through it.
   */
  tick(): Promise<void> {
    let lobbies: string[];
    try {
      lobbies = this.store.boardLobbies();
    } catch {
      return Promise.resolve();
    }
    return Promise.allSettled(lobbies.map((lobby) => this.request(lobby))).then(() => undefined);
  }

  /**
   * What the board is doing for this lobby right now, if anything: reading notes from GitHub or
   * writing a summary. A visit that finds nothing due does neither, so the page stops polling fast.
   */
  activity(lobby: string): 'summarizing' | 'checking' | null {
    if (this.summarizing.has(lobby)) return 'summarizing';
    return this.checking.has(lobby) ? 'checking' : null;
  }

  private async refresh(lobby: string): Promise<void> {
    // Only a fetch yields. Without one the summarizer starts at once, so the page rendered for
    // this visit already says it is writing.
    const due = this.dueSources(lobby);
    if (due.length) await this.refreshNotes(lobby, due);
    if (!this.controller.signal.aborted) await this.maybeSummarize(lobby);
  }

  private sourceState(lobby: string, source: BoardSource): SourceState {
    const id = `${lobby}/${source.room_id}`;
    const key = sourceKey(source);
    let state = this.sources.get(id);
    if (state?.key !== key) {
      state = { key, etag: null, checkedAt: null, error: null };
      this.sources.set(id, state);
    }
    return state;
  }

  /** The sources whose notes interval has passed; none without a GitHub token. */
  private dueSources(lobby: string): BoardSource[] {
    if (!this.github) return [];
    const now = this.now();
    return this.store.boardSources(lobby).filter((source) => {
      const state = this.sourceState(lobby, source);
      return state.checkedAt === null || now - state.checkedAt >= this.notesInterval;
    });
  }

  /** Fetch each due source at its own commit; a failing source keeps its last snapshot. */
  private async refreshNotes(lobby: string, due = this.dueSources(lobby)): Promise<void> {
    if (!this.github || !due.length) return;
    // Set before the first await, so the page rendered for this visit already says so.
    this.checking.add(lobby);
    try {
      await this.fetchSources(this.github, lobby, due);
    } finally {
      this.checking.delete(lobby);
    }
  }

  private async fetchSources(
    github: GitHubNotes,
    lobby: string,
    due: BoardSource[],
  ): Promise<void> {
    const snapshots = this.store.boardNotes(lobby);
    for (const source of due) {
      const state = this.sourceState(lobby, source);
      state.checkedAt = this.now();
      const previous = snapshots.get(source.room_id) ?? null;
      try {
        const result = await github.fetch(
          source,
          previous,
          previous ? state.etag : null,
          this.controller.signal,
        );
        // The ETag advances only with the snapshot it describes, so a failed download after a
        // new commit is fetched again instead of answered 304 forever.
        if (!result.changed || this.store.saveBoardNotes(lobby, source, result.snapshot))
          state.etag = result.etag;
        state.error = null;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        state.error = {
          message: error instanceof NotesError ? error.message : 'The notes could not be read',
          at: this.now(),
        };
      }
    }
  }

  private enabledAgents(lobby: string): Agent[] {
    return this.store.agents(lobby).filter((agent) => agent.enabled);
  }

  /** The agents with a row and a summary: enabled, and not hidden by the owner. */
  private shownAgents(lobby: string, config: BoardConfig): Agent[] {
    return this.enabledAgents(lobby).filter((agent) => !config.agents[agent.agent_id]?.hidden);
  }

  /**
   * Summarize when the sources it would send changed and the interval since the last attempt
   * passed; a forced run (the console's test) skips both checks.
   */
  private async maybeSummarize(lobby: string, force = false): Promise<void> {
    if (!this.client) return;
    const now = this.now();
    // The cheap checks first: within the interval nothing is built, hashed or sent, and an input
    // found unchanged is not rebuilt for a notes interval, however often the page polls.
    if (!force && now - this.lastAttempt(lobby) < this.summaryInterval) return;
    if (!force && now - (this.unchanged.get(lobby) ?? -Infinity) < this.notesInterval) return;
    const unsaved = this.unsaved.get(lobby);
    if (unsaved) {
      try {
        this.store.saveBoardSummary(unsaved);
        this.unsaved.delete(lobby);
      } catch {
        return;
      }
    }
    if (this.overBudget(lobby, now)) return;
    const snapshots = this.store.boardNotes(lobby);
    const notes = this.store
      .boardSources(lobby)
      .filter((source) => snapshots.has(source.room_id))
      .map((source) => ({
        room_id: source.room_id,
        repo: source.repo,
        snapshot: snapshots.get(source.room_id)!,
      }));
    // Without any notes there is nothing authoritative to summarize.
    if (!notes.length) return;
    const config = this.store.boardConfig(lobby);
    const agents = this.shownAgents(lobby, config);
    const sources = notes.map((item) => ({
      room_id: item.room_id,
      repo: item.repo,
      commit_sha: item.snapshot.commit_sha,
    }));
    const input = {
      lobby,
      agents: agents.map((agent) => ({
        agent_id: agent.agent_id,
        name: config.agents[agent.agent_id]?.name ?? displayName(agent.agent_id),
        coordinator: agent.manage_rooms,
      })),
      notes,
      // The newest messages, whatever their age: an older one leaving a time window would change
      // the input, and pay for a summary, with nothing new.
      messages: this.store.boardMessages(lobby, 0, MESSAGE_LIMIT, MESSAGE_EXCERPT + 1),
    };
    const settings = { model: config.summary_model, effort: config.summary_effort };
    const request = summaryRequest(input, settings);
    const hash = requestHash(request);
    const base = requestHash(summaryRequest({ ...input, messages: [] }, settings));
    const sequences = input.messages.map((message) => message.sequence);
    const read = this.summarized.get(lobby);
    const expiredOnly =
      read?.base === base && sequences.every((sequence) => read.sequences.has(sequence));
    // A failure the model answered (too long, off-format, refused) repeats on the same input, so
    // it waits for the input to change; one that never reached it is retried each interval.
    const last = this.store.boardLastAttempt(lobby);
    if (
      !force &&
      (this.store.boardSummary(lobby)?.input_hash === hash ||
        expiredOnly ||
        (last?.error && last.input_hash === hash && last.usage.output_tokens > 0))
    ) {
      this.unchanged.set(lobby, now);
      return;
    }
    this.attempts.set(lobby, now);
    this.summarizing.add(lobby);
    const record = { lobby_id: lobby, input_hash: hash, sources, model: config.summary_model };
    let outcome: Pick<SummaryRecord, 'usage' | 'cost_usd' | 'summary' | 'error'>;
    try {
      const result = await summarize(
        this.client,
        request,
        agents.map((agent) => agent.agent_id),
        this.controller.signal,
      );
      outcome = {
        usage: result.usage,
        cost_usd: result.cost_usd,
        summary: result.summary,
        error: null,
      };
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const failed =
        error instanceof SummaryFailure ? error : new SummaryFailure('The summary failed');
      outcome = {
        usage: failed.usage ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        cost_usd: failed.cost,
        summary: null,
        error: failed.message,
      };
    } finally {
      this.summarizing.delete(lobby);
    }
    try {
      this.store.saveBoardSummary({ ...record, ...outcome });
      // An answer counts, failed or not: it would repeat on the same input, or on that input
      // minus expired messages.
      if (outcome.summary || outcome.usage.output_tokens > 0)
        this.summarized.set(lobby, { base, sequences: new Set(sequences) });
    } catch (error) {
      // A paid summary that cannot be stored (such as on a full disk) keeps its usage in a smaller
      // failure row; if even that fails, it waits in memory and stops further paid attempts.
      const failure = {
        ...record,
        ...outcome,
        summary: null,
        error: outcome.error ?? 'The summary could not be saved',
      };
      try {
        if (outcome.summary === null) throw error;
        this.store.saveBoardSummary(failure);
      } catch (again) {
        this.unsaved.set(lobby, failure);
        throw again;
      }
    }
  }

  /** Whether this lobby's summaries in the last 24 hours reached the daily ceiling. */
  private overBudget(lobby: string, now: number): boolean {
    return this.store.boardUsage(lobby, now - DAY_MS).cost_usd >= DAILY_SUMMARY_USD;
  }

  /** An agent's plan usage, as its status line just reported it. */
  recordUsage(principal: string, report: UsageReport): void {
    this.usage.set(principal, { report, at: this.now() });
  }

  /** One agent's plan for list_agents: both windows, and where its week stands. */
  agentUsage(lobby: string, agentId: string): AgentUsage | null {
    const now = this.now();
    const reading = this.usage.get(qualifyAgent(lobby, agentId));
    if (!reading || now - reading.at >= USAGE_SHOWN_MS) return null;
    const { report } = reading;
    const window = (value: UsageReport['five_hour']) =>
      value && value.resets_at * 1000 > now
        ? {
            used_percentage: value.used_percentage,
            resets_at: new Date(value.resets_at * 1000).toISOString(),
          }
        : null;
    // Pacing is per account: its week comes from the freshest report of any agent on it.
    const shared = report.account
      ? this.accountWeeks(
          lobby,
          this.enabledAgents(lobby).map((agent) => agent.agent_id),
          now,
        ).get(report.account)
      : undefined;
    const source = shared ?? reading;
    // The model windows have a freshness of their own: a fresh week must not renew an old look.
    const looked =
      (report.account
        ? this.accountLooks(
            lobby,
            this.enabledAgents(lobby).map((agent) => agent.agent_id),
            now,
          ).get(report.account)
        : undefined) ?? (report.model_windows ? reading : undefined);
    const seven = source.report.seven_day;
    const week = window(seven);
    const pace = seven ? weeklyPace(seven.used_percentage, seven.resets_at, now) : null;
    return {
      account: report.account ?? null,
      plan: report.plan ?? null,
      five_hour: window(report.five_hour),
      seven_day:
        week && pace
          ? {
              ...week,
              ...pace,
              pace: paceState(pace.lead),
              observed_at: new Date(source.at).toISOString(),
              stale: now - source.at >= USAGE_STALE_MS,
            }
          : null,
      // The agent's own session, never the account's freshest report.
      model: report.model ?? null,
      model_name: report.model ? modelLabel(report.model) : null,
      context_window: contextWindow(report),
      effort: report.effort ?? null,
      model_windows: looked
        ? paced(looked.report.model_windows ?? [], now).map(({ window, pace }) => ({
            name: window.name,
            used_percentage: window.used_percentage,
            resets_at: new Date(window.resets_at * 1000).toISOString(),
            ...pace,
            pace: paceState(pace.lead),
            observed_at: new Date(looked.at).toISOString(),
            stale: now - looked.at >= USAGE_STALE_MS,
          }))
        : null,
      observed_at: new Date(reading.at).toISOString(),
    };
  }

  /**
   * Each account's freshest reading among these agents that carries the model windows: the
   * status line sends them only while its last look at Claude Code's usage is fresh, and an empty
   * list from the freshest look clears the ones before it.
   */
  private accountLooks(lobby: string, agentIds: string[], now: number): Map<string, Reading> {
    const looks = new Map<string, Reading>();
    for (const id of agentIds) {
      const reading = this.usage.get(qualifyAgent(lobby, id));
      const account = reading?.report.account;
      if (!reading || !account || !reading.report.model_windows) continue;
      if (now - reading.at >= USAGE_SHOWN_MS) continue;
      if (reading.at > (looks.get(account)?.at ?? -Infinity)) looks.set(account, reading);
    }
    return looks;
  }

  /**
   * Each account's freshest reading among these agents that still has its week: just after a
   * reset Claude Code drops the old window, so one session's report can lack it while another
   * session on the same account already has the new one. The board's cards and list_agents both
   * read an account's week from here.
   */
  private accountWeeks(lobby: string, agentIds: string[], now: number): Map<string, Reading> {
    const weeks = new Map<string, Reading>();
    for (const id of agentIds) {
      const reading = this.usage.get(qualifyAgent(lobby, id));
      const account = reading?.report.account;
      const week = reading?.report.seven_day;
      if (!reading || !account || !week || now - reading.at >= USAGE_SHOWN_MS) continue;
      if (week.resets_at * 1000 <= now) continue;
      if (reading.at > (weeks.get(account)?.at ?? -Infinity)) weeks.set(account, reading);
    }
    return weeks;
  }

  /**
   * The accounts the lobby's agents report, each with its freshest reading and its weekly pace.
   * A public board names them "Account 1" and so on instead of by email.
   */
  private accountViews(
    lobby: string,
    agents: Agent[],
    name: (id: string) => string,
    privateBoard: boolean,
    now: number,
  ): AccountView[] {
    const weeks = this.accountWeeks(
      lobby,
      agents.map((agent) => agent.agent_id),
      now,
    );
    const looks = this.accountLooks(
      lobby,
      agents.map((agent) => agent.agent_id),
      now,
    );
    const accounts = new Map<string, string[]>();
    for (const agent of agents) {
      const reading = this.usage.get(qualifyAgent(lobby, agent.agent_id));
      const account = reading?.report.account;
      if (!reading || !account || now - reading.at >= USAGE_SHOWN_MS) continue;
      accounts.set(account, [...(accounts.get(account) ?? []), name(agent.agent_id)]);
    }
    return [...accounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([account, names], index) => {
        const fresh = weeks.get(account);
        const week = fresh?.report.seven_day;
        const pace = week ? weeklyPace(week.used_percentage, week.resets_at, now) : null;
        if (!fresh || !week || !pace) return [];
        return [
          {
            account: privateBoard ? account : `Account ${index + 1}`,
            plan: fresh.report.plan ?? null,
            agents: names,
            week_used: Math.round(week.used_percentage),
            week_resets_at: new Date(week.resets_at * 1000).toISOString(),
            line: Math.round(pace.line),
            lead: Math.round(pace.lead),
            state: paceState(pace.lead),
            windows: paced(looks.get(account)?.report.model_windows ?? [], now).map(
              ({ window, pace: windowPace }) => ({
                name: window.name,
                used: Math.round(window.used_percentage),
                resets_at: new Date(window.resets_at * 1000).toISOString(),
                line: Math.round(windowPace.line),
                lead: Math.round(windowPace.lead),
                state: paceState(windowPace.lead),
              }),
            ),
            observed_at: new Date(fresh.at).toISOString(),
          },
        ];
      });
  }

  /** When this lobby's last summarizer attempt started, stored or not. */
  private lastAttempt(lobby: string): number {
    return Math.max(
      this.store.boardLastAttempt(lobby)?.created_ms ?? -Infinity,
      this.attempts.get(lobby) ?? -Infinity,
    );
  }

  /**
   * The console's "Run a test summary" (0.5.0): read the notes and summarize now with the lobby's
   * settings, whether or not anything changed. Never while a run for the lobby is under way, and
   * at most once per TEST_SUMMARY_MS after any attempt; it is stored and counted like any other.
   * Its checks throw at once; the promise resolves to the attempt it stored, or null when there
   * was nothing to summarize.
   */
  runNow(lobby: string): Promise<SummaryRecord | null> {
    if (!this.client)
      throw new LobbyError(503, 'summary_unavailable', 'The broker has no ANTHROPIC_API_KEY');
    if (this.running.has(lobby))
      throw new LobbyError(409, 'summary_running', 'A summary is being written now');
    const wait = this.lastAttempt(lobby) + TEST_SUMMARY_MS - this.now();
    if (wait > 0)
      throw new LobbyError(
        429,
        'summary_test_wait',
        `A summary ran less than ${TEST_SUMMARY_MS / 60_000} minutes ago; try again in ${Math.ceil(wait / 60_000)} min`,
      );
    if (this.overBudget(lobby, this.now()))
      throw new LobbyError(
        429,
        'summary_budget',
        `This lobby's summaries cost $${DAILY_SUMMARY_USD} in the last 24 hours, the daily ceiling; try again later`,
      );
    const before = this.store.boardLastAttempt(lobby)?.sequence ?? 0;
    const work = this.refreshNotes(lobby).then(() => this.maybeSummarize(lobby, true));
    const settled = work
      .catch(() => {
        /* Reported to the caller below. */
      })
      .finally(() => this.running.delete(lobby));
    this.running.set(lobby, settled);
    return work.then(() => {
      const after = this.store.boardLastAttempt(lobby);
      return after && after.sequence > before ? after : null;
    });
  }

  /** Everything the page shows: live facts now, the last good snapshot and summary, failures. */
  view(lobby: string): BoardView {
    const now = this.now();
    const config = this.store.boardConfig(lobby);
    const agents = this.enabledAgents(lobby);
    const good = this.store.boardSummary(lobby);
    const last = this.store.boardLastAttempt(lobby);
    // A summary stored before 0.7.0 has no queue; it is not shown, as if none had been written yet.
    const summary =
      good?.summary && good.summary.agents.every((agent) => 'next_count' in agent)
        ? good.summary
        : null;
    const snapshots = this.store.boardNoteFacts(lobby);
    const name = (id: string) => config.agents[id]?.name ?? displayName(id);
    const problems: string[] = [];
    const sources: SourceRow[] = config.sources.map((source) => {
      const snapshot = snapshots.get(source.room_id);
      const state = this.sources.get(`${lobby}/${source.room_id}`);
      const error =
        state?.error && state.key === sourceKey(source)
          ? `${state.error.message} (${age(now - state.error.at)} ago)`
          : null;
      if (error)
        problems.push(
          `Notes for ${source.room_id} (${source.repo}): ${error}. ${snapshot ? `Showing them as of ${snapshot.commit_sha.slice(0, 7)}.` : 'No notes from it yet.'}`,
        );
      return {
        room_id: source.room_id,
        repo: source.repo,
        commit: snapshot?.commit_sha.slice(0, 7) ?? null,
        files: snapshot?.files ?? 0,
        cut: snapshot?.cut ?? [],
        fetched: snapshot ? age(now - Date.parse(snapshot.fetched_at)) : null,
        error,
      };
    });
    if (!config.sources.length)
      problems.push(
        'No notes sources are set. The lobby owner picks a repository per room in the console.',
      );
    if (!this.github) problems.push('Notes are not being read: the broker has no GITHUB_TOKEN.');
    if (!this.client) problems.push('No new summaries: the broker has no ANTHROPIC_API_KEY.');
    else if (this.unsaved.has(lobby))
      problems.push(
        'New summaries are paused: the cost of the last one could not be recorded, which usually means the broker’s disk is full.',
      );
    else if (this.overBudget(lobby, now))
      problems.push(
        `New summaries are paused: this lobby's summaries cost $${DAILY_SUMMARY_USD} in the last 24 hours, the daily ceiling. They resume as older runs leave the window.`,
      );
    if (last?.error && (!good || last.sequence > good.sequence))
      problems.push(
        `The summarizer failed ${age(now - last.created_ms)} ago: ${last.error}.${good ? ` Showing the summary from ${age(now - good.created_ms)} ago.` : ''}`,
      );
    const end = Math.ceil((now + 1) / TRAFFIC_SLOT_MS) * TRAFFIC_SLOT_MS;
    const since = end - TRAFFIC_SLOTS * TRAFFIC_SLOT_MS;
    const traffic = new Map<string, { sent: number; received: number }[]>();
    for (const row of this.store.boardTraffic(lobby, since, TRAFFIC_SLOT_MS)) {
      if (row.slot < 0 || row.slot >= TRAFFIC_SLOTS) continue;
      let slots = traffic.get(row.agent_id);
      if (!slots) {
        slots = Array.from({ length: TRAFFIC_SLOTS }, () => ({ sent: 0, received: 0 }));
        traffic.set(row.agent_id, slots);
      }
      slots[row.slot] = { sent: row.sent, received: row.received };
    }
    const quiet = Array.from({ length: TRAFFIC_SLOTS }, () => ({ sent: 0, received: 0 }));
    // A hidden agent keeps only its owner requests on the board, so nothing waiting is missed.
    const rows: AgentRow[] = agents
      .filter((agent) => !config.agents[agent.agent_id]?.hidden)
      .sort(
        (left, right) =>
          Number(right.manage_rooms) - Number(left.manage_rooms) ||
          left.agent_id.localeCompare(right.agent_id),
      )
      .map((agent) => {
        const entry = summary?.agents.find((item) => item.agent_id === agent.agent_id);
        const connected = this.isConnected(lobby, agent.agent_id);
        const reading = this.usage.get(qualifyAgent(lobby, agent.agent_id));
        const chip = stateChip(agent, now, connected);
        const slots = traffic.get(agent.agent_id) ?? quiet;
        const active = slots.filter((slot) => slot.sent + slot.received > 0).length;
        return {
          agent_id: agent.agent_id,
          name: name(agent.agent_id),
          emoji: config.agents[agent.agent_id]?.emoji ?? null,
          chip,
          now: entry?.now || null,
          today: entry?.today || null,
          coordinator: agent.manage_rooms,
          stall:
            chip === 'stalled'
              ? `${agent.unseen_notified_count} message${agent.unseen_notified_count === 1 ? '' : 's'} not acknowledged, the oldest written to its session ${age(now - Date.parse(agent.oldest_unseen_notified_at!))} ago`
              : null,
          next:
            !entry || entry.next === null
              ? null
              : { count: entry.next_count ?? 0, items: entry.next },
          connected,
          traffic: slots,
          active: active ? age(active * TRAFFIC_SLOT_MS) : 'none',
          usage: reading ? usageView(reading, now, config.visibility === 'private') : null,
        };
      });
    const waiting: WaitingRow[] = agents
      .filter((agent) => agent.owner_requests)
      .sort((left, right) =>
        left.owner_requests!.set_at.localeCompare(right.owner_requests!.set_at),
      )
      .map((agent) => ({
        agent_id: agent.agent_id,
        name: name(agent.agent_id),
        emoji: config.agents[agent.agent_id]?.emoji ?? null,
        count: agent.owner_requests!.count,
        text: agent.owner_requests!.text,
        since: age(now - Date.parse(agent.owner_requests!.set_at)),
      }));
    return {
      lobby_id: lobby,
      display_name: this.store.displayName(lobby),
      generated_at: new Date(now).toISOString(),
      activity: this.activity(lobby),
      waiting,
      agents: rows,
      traffic: { since_ms: since, slot_ms: TRAFFIC_SLOT_MS },
      sources,
      summary: good ? { written: age(now - good.created_ms), model: modelName(good.model) } : null,
      interval_minutes: Math.round(this.summaryInterval / 60_000),
      problems,
      accounts: this.accountViews(
        lobby,
        agents.filter((agent) => !config.agents[agent.agent_id]?.hidden),
        name,
        config.visibility === 'private',
        now,
      ),
    };
  }

  /** The owner's status: settings, sources, the last summary and attempt, usage and cost. */
  status(lobby: string): object {
    const now = this.now();
    const config = this.store.boardConfig(lobby);
    const snapshots = this.store.boardNotes(lobby);
    const shown = (record: SummaryRecord | null) =>
      record && {
        created_at: record.created_at,
        model: record.model,
        input_hash: record.input_hash,
        sources: record.sources,
        usage: record.usage,
        cost_usd: record.cost_usd,
        error: record.error,
      };
    return {
      lobby_id: lobby,
      display_name: this.store.displayName(lobby),
      board_url: this.settings.domain ? `https://${lobby}.${this.settings.domain}/` : null,
      visibility: config.visibility,
      viewers: this.store.boardViewers(lobby).length,
      viewer_sessions: this.store.boardSessionCount(lobby),
      summary_settings: { model: config.summary_model, effort: config.summary_effort },
      agents: config.agents,
      secrets: { github_token: Boolean(this.github), anthropic_api_key: Boolean(this.client) },
      intervals_seconds: { notes: this.notesInterval / 1000, summary: this.summaryInterval / 1000 },
      sources: config.sources.map((source) => {
        const snapshot = snapshots.get(source.room_id);
        const state = this.sources.get(`${lobby}/${source.room_id}`);
        const current = state?.key === sourceKey(source);
        return {
          ...source,
          commit_sha: snapshot?.commit_sha ?? null,
          fetched_at: snapshot?.fetched_at ?? null,
          files:
            snapshot?.files.map((file) => ({
              path: file.path,
              bytes: file.bytes,
              read_bytes: Buffer.byteLength(file.content),
              truncated: file.truncated,
            })) ?? [],
          last_checked_at:
            current && state.checkedAt !== null ? new Date(state.checkedAt).toISOString() : null,
          error:
            current && state.error
              ? { message: state.error.message, at: new Date(state.error.at).toISOString() }
              : null,
        };
      }),
      summary: {
        last_good: shown(this.store.boardSummary(lobby)),
        last_attempt: shown(this.store.boardLastAttempt(lobby)),
      },
      usage: {
        last_24h: this.store.boardUsage(lobby, now - 24 * 60 * 60_000),
        last_30d: this.store.boardUsage(lobby, now - 30 * 24 * 60 * 60_000),
      },
    };
  }
}
