/**
 * Weekly pacing of a Claude account (Johan, 2026-10-16): agents work around the clock and should
 * use each subscription's week evenly, about 14 points a day, reaching 0% left as it resets.
 * Where an account should be needs no history: the share of its week that has passed. Ahead of
 * that line it is burning too fast; behind it, it has room for more work.
 */

const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Points ahead of or behind the line that take an account off pace. */
export const PACE_OFF = 5;

export type PaceState = 'ahead' | 'behind' | 'on';

/**
 * The weekly line now, in percent used, and how far ahead (positive) or behind (negative) the
 * account's use is; null once the window has reset.
 */
export function weeklyPace(
  used: number,
  resetsAt: number,
  now: number,
): { line: number; lead: number } | null {
  const remaining = resetsAt * 1000 - now;
  if (remaining <= 0) return null;
  const line = Math.min(100, Math.max(0, (1 - remaining / WEEK_MS) * 100));
  const tenth = (value: number) => Math.round(value * 10) / 10;
  return { line: tenth(line), lead: tenth(used - line) };
}

/**
 * Ahead or behind by more than 5 points, else on pace. The coordinator, who knows whom it rested,
 * resumes a worker only once the lead is back within 2, so it does not flap at the edge.
 */
export function paceState(lead: number): PaceState {
  return lead > PACE_OFF ? 'ahead' : lead < -PACE_OFF ? 'behind' : 'on';
}
