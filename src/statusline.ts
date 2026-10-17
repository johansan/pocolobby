/**
 * `pocolobby statusline`: an agent's Claude Code status line. Claude Code passes it the session's
 * data on stdin, its plan usage included (`rate_limits`); it prints a short line and sends that
 * usage, with the account the session is signed in to, to the broker for the board. It never
 * breaks the status line: a broker or a `claude` command that does not answer costs a few
 * seconds at most, silently.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LobbyClient, LobbyClientError, type LobbyClientConfig } from './client.js';
import {
  Effort,
  ModelId,
  ModelWindowSchema,
  UsageReportSchema,
  windowCovers,
  type ModelWindow,
  type UsageReport,
} from './protocol.js';

/** An unchanged reading is sent again this often, so a restarted broker has it back soon. */
export const USAGE_RESEND_MS = 5 * 60_000;
/**
 * The signed-in account is looked up again this often (about a tenth of a second each time), so
 * a session switched to another account reports it within minutes, not under the old address.
 */
const ACCOUNT_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;
/**
 * Claude Code is asked for the per-model weekly windows (Fable's) this often, failures included,
 * so a Claude Code that cannot answer is not started again on every refresh. Each look starts a
 * headless Claude Code for about a second, with no prompt and no model call.
 */
const WINDOWS_MS = 5 * 60_000;
const WINDOWS_TIMEOUT_MS = 10_000;
/** A look older than this is not sent: three in a row failed, so it no longer says where Fable is. */
const WINDOWS_FRESH_MS = 15 * 60_000;

interface Account {
  email?: string;
  plan?: string;
}
interface State {
  sent?: string;
  sent_at?: number;
  account?: Account;
  account_at?: number;
  windows?: ModelWindow[];
  /** When Claude Code last answered with the windows, and when it was last asked. */
  windows_at?: number;
  windows_tried_at?: number;
}
export interface StatusLineOptions {
  now?: () => number;
  /** Where the last report is remembered; one file per credential. */
  statePath?: string;
  /** The signed-in account, from `claude auth status --json` by default. */
  account?: () => Promise<Account | null>;
  /** The per-model weekly windows, from Claude Code's usage by default; null when it cannot tell. */
  windows?: () => Promise<ModelWindow[] | null>;
  client?: Pick<LobbyClient, 'request'>;
  /** Show what would be sent and send nothing, so a test by hand never reaches the board. */
  dryRun?: boolean;
}

/**
 * The plan usage, model and effort in Claude Code's status line input, as the broker accepts them.
 * A model or effort the broker would refuse is left out on its own, never the usage with it.
 */
export function usageReport(
  input: unknown,
  account: Account | null,
  windows?: ModelWindow[],
): UsageReport | null {
  const data = (input ?? {}) as {
    rate_limits?: Record<string, unknown>;
    model?: { id?: unknown };
    effort?: { level?: unknown };
    context_window?: { context_window_size?: unknown };
  };
  const limits = data.rate_limits;
  const model = ModelId.safeParse(data.model?.id);
  const effort = Effort.safeParse(data.effort?.level);
  const context = data.context_window?.context_window_size;
  const window = (value: unknown) => {
    const { used_percentage, resets_at } = (value ?? {}) as Record<string, unknown>;
    return typeof used_percentage === 'number' && typeof resets_at === 'number'
      ? {
          used_percentage: Math.min(100, Math.max(0, used_percentage)),
          resets_at: Math.round(resets_at),
        }
      : undefined;
  };
  const parsed = UsageReportSchema.safeParse({
    five_hour: window(limits?.five_hour),
    seven_day: window(limits?.seven_day),
    account: account?.email,
    plan: account?.plan,
    model: model.success ? model.data : undefined,
    effort: effort.success ? effort.data : undefined,
    context:
      typeof context === 'number' && Number.isInteger(context) && context > 0 ? context : undefined,
    model_windows: windows,
  });
  if (!parsed.success) return null;
  // Only the fields the input had, so a reading compares by what it says.
  const report = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as UsageReport;
  return report.five_hour || report.seven_day || report.model ? report : null;
}

/** What the status line shows: "5h 62% left, resets 18:40, week 40% left". */
export function statusText(report: UsageReport | null): string {
  if (!report) return '';
  const left = (used: number) => `${Math.max(0, Math.round(100 - used))}% left`;
  const parts: string[] = [];
  if (report.five_hour) {
    const at = new Date(report.five_hour.resets_at * 1000);
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    parts.push(`5h ${left(report.five_hour.used_percentage)}, resets ${time}`);
  }
  if (report.seven_day) parts.push(`week ${left(report.seven_day.used_percentage)}`);
  // The window of the model this session runs, such as Fable's for claude-fable-5-1.
  for (const window of report.model_windows ?? [])
    if (report.model && windowCovers(report.model, window.name))
      parts.push(`${window.name.toLowerCase()} ${left(window.used_percentage)}`);
  return parts.join(', ');
}

/** The account this session runs on, as `claude auth status --json` reports it. */
function claudeAccount(): Promise<Account | null> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      // On Windows `claude` is usually a .cmd shim, which Node starts only through a shell; the
      // arguments are fixed, so the shell adds nothing else.
      { timeout: TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const status = JSON.parse(stdout) as { email?: unknown; subscriptionType?: unknown };
          resolve({
            email: typeof status.email === 'string' ? status.email : undefined,
            plan: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * The per-model weekly windows in Claude Code's answer to its usage request: Fable's, with its
 * own percentage and reset. Null when the answer says nothing about them (a failure, or an answer
 * from cached data); an empty list when Claude Code says the account has none.
 */
export function modelWindows(response: unknown): ModelWindow[] | null {
  const answer = (response ?? {}) as {
    subtype?: unknown;
    response?: { rate_limits?: { model_scoped?: unknown } | null };
  };
  const scoped = answer.response?.rate_limits?.model_scoped;
  if (answer.subtype !== 'success' || !Array.isArray(scoped)) return null;
  return scoped
    .flatMap((entry: unknown) => {
      const { display_name, utilization, resets_at } = (entry ?? {}) as Record<string, unknown>;
      const at = typeof resets_at === 'string' ? Date.parse(resets_at) : NaN;
      const window = ModelWindowSchema.safeParse({
        name: typeof display_name === 'string' ? display_name.trim() : undefined,
        used_percentage:
          typeof utilization === 'number' ? Math.min(100, Math.max(0, utilization)) : undefined,
        resets_at: Number.isFinite(at) ? Math.round(at / 1000) : undefined,
      });
      return window.success ? [window.data] : [];
    })
    .slice(0, 8);
}

/**
 * Asks a headless Claude Code for the account's plan usage, which, unlike the status line input,
 * has the per-model weekly windows. Safe mode starts no MCP server (so no second PocoLobby
 * bridge), hook or plugin; nothing is kept as a session; the usage request needs no prompt and no
 * model call (`get_usage`, an experimental request of Claude Code's SDK protocol). It inherits
 * the status line's environment, so it reads the same account. If this process is stopped
 * midway, the child sees its input close and exits.
 */
function claudeModelWindows(): Promise<ModelWindow[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--safe-mode',
        '--no-session-persistence',
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      // As for `claude auth status`: on Windows the .cmd shim starts only through a shell.
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: process.platform === 'win32' },
    );
    let finished = false;
    let buffer = '';
    const finish = (windows: ModelWindow[] | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(windows);
    };
    const timer = setTimeout(() => finish(null), WINDOWS_TIMEOUT_MS);
    const send = (request_id: string, request: object) =>
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id, request })}\n`);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { type?: unknown; response?: { request_id?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.type !== 'control_response') continue;
        if (message.response?.request_id === 'initialize')
          send('usage', { subtype: 'get_usage', skip_behaviors: true });
        else if (message.response?.request_id === 'usage') finish(modelWindows(message.response));
      }
    });
    send('initialize', { subtype: 'initialize' });
  });
}

/**
 * Print the status line and, when the reading changed or a few minutes passed, send it. Returns
 * the line; reporting failures are swallowed so Claude Code's status line never shows an error.
 */
export async function runStatusLine(
  config: LobbyClientConfig,
  configPath: string,
  stdin: string,
  options: StatusLineOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const statePath =
    options.statePath ??
    join(
      tmpdir(),
      `pocolobby-usage-${createHash('sha256').update(configPath).digest('hex').slice(0, 16)}.json`,
    );
  let input: unknown = null;
  try {
    input = JSON.parse(stdin);
  } catch {
    return '';
  }
  let state: State = {};
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as State;
  } catch {
    /* First run, or a state file another version wrote. */
  }
  if (usageReport(input, null) === null)
    return options.dryRun
      ? 'Dry run: this input has no rate_limits and no model, so nothing would be sent.'
      : '';
  const save = async () => {
    try {
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    } catch {
      /* Only the throttle is lost. */
    }
  };
  const lookAccount = !state.account_at || now() - state.account_at >= ACCOUNT_MS;
  const lookWindows = !state.windows_tried_at || now() - state.windows_tried_at >= WINDOWS_MS;
  if (lookWindows && !options.dryRun) {
    // Remembered before asking, so a run Claude Code cancels midway still counts as a try.
    state = { ...state, windows_tried_at: now() };
    await save();
  }
  const [account, windows] = await Promise.all([
    lookAccount ? (options.account ?? claudeAccount)() : null,
    lookWindows ? (options.windows ?? claudeModelWindows)() : null,
  ]);
  if (account) state = { ...state, account, account_at: now() };
  // A failed look keeps the last answer and its time, so an old one ages out instead of renewing.
  if (windows) state = { ...state, windows, windows_at: now() };
  const freshWindows =
    state.windows && state.windows_at && now() - state.windows_at < WINDOWS_FRESH_MS
      ? state.windows
      : undefined;
  const report = usageReport(input, state.account ?? null, freshWindows);
  const line = statusText(report);
  const body = JSON.stringify(report);
  // Nothing sent and nothing remembered: the next real reading is sent as usual.
  if (options.dryRun) return `${line}\nDry run, not sent: PUT /v1/usage ${body}`;
  if (report && (body !== state.sent || now() - (state.sent_at ?? 0) >= USAGE_RESEND_MS)) {
    const client = options.client ?? new LobbyClient({ ...config, timeoutMs: TIMEOUT_MS });
    try {
      await client.request('PUT', '/v1/usage', report);
      state = { ...state, sent: body, sent_at: now() };
    } catch (error) {
      // An older broker refuses the session fields (model and effort before 0.8.4, the context
      // window before 0.8.5, the model windows before 0.8.6); send it the usage alone, so pacing
      // keeps working, and try the whole report again at the next resend.
      const { five_hour, seven_day, account, plan } = report;
      const usage = { five_hour, seven_day, account, plan };
      if (
        error instanceof LobbyClientError &&
        error.status === 400 &&
        (report.model || report.effort || report.context || report.model_windows) &&
        (five_hour || seven_day)
      ) {
        try {
          await client.request('PUT', '/v1/usage', usage);
          state = { ...state, sent: body, sent_at: now() };
        } catch {
          /* The next run tries again. */
        }
      }
    }
  }
  await save();
  return line;
}
