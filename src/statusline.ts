/**
 * `pocolobby statusline`: an agent's Claude Code status line. Claude Code passes it the session's
 * data on stdin, its plan usage included (`rate_limits`); it prints a short line and sends that
 * usage, with the account the session is signed in to, to the broker for the board. It never
 * breaks the status line: a broker or a `claude` command that does not answer costs a few
 * seconds at most, silently.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LobbyClient, LobbyClientError, type LobbyClientConfig } from './client.js';
import { Effort, ModelId, UsageReportSchema, type UsageReport } from './protocol.js';

/** An unchanged reading is sent again this often, so a restarted broker has it back soon. */
export const USAGE_RESEND_MS = 5 * 60_000;
/**
 * The signed-in account is looked up again this often (about a tenth of a second each time), so
 * a session switched to another account reports it within minutes, not under the old address.
 */
const ACCOUNT_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

interface Account {
  email?: string;
  plan?: string;
}
interface State {
  sent?: string;
  sent_at?: number;
  account?: Account;
  account_at?: number;
}
export interface StatusLineOptions {
  now?: () => number;
  /** Where the last report is remembered; one file per credential. */
  statePath?: string;
  /** The signed-in account, from `claude auth status --json` by default. */
  account?: () => Promise<Account | null>;
  client?: Pick<LobbyClient, 'request'>;
  /** Show what would be sent and send nothing, so a test by hand never reaches the board. */
  dryRun?: boolean;
}

/**
 * The plan usage, model and effort in Claude Code's status line input, as the broker accepts them.
 * A model or effort the broker would refuse is left out on its own, never the usage with it.
 */
export function usageReport(input: unknown, account: Account | null): UsageReport | null {
  const data = (input ?? {}) as {
    rate_limits?: Record<string, unknown>;
    model?: { id?: unknown };
    effort?: { level?: unknown };
  };
  const limits = data.rate_limits;
  const model = ModelId.safeParse(data.model?.id);
  const effort = Effort.safeParse(data.effort?.level);
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
  if (!state.account_at || now() - state.account_at >= ACCOUNT_MS) {
    const account = await (options.account ?? claudeAccount)();
    if (account) state = { ...state, account, account_at: now() };
  }
  const report = usageReport(input, state.account ?? null);
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
      // A broker older than 0.8.4 refuses model and effort; send it the usage alone, so pacing
      // keeps working, and try the whole report again at the next resend.
      const { model, effort, ...usage } = report;
      if (
        error instanceof LobbyClientError &&
        error.status === 400 &&
        (model || effort) &&
        (usage.five_hour || usage.seven_day)
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
  try {
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* Only the throttle is lost. */
  }
  return line;
}
