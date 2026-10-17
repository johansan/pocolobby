import type { Repeat, Weekday } from './protocol.js';

const HOUR = 60 * 60 * 1000;
const DAY_NAMES: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The zone's UTC offset in milliseconds at an instant. */
function offsetAt(ms: number, timeZone: string): number {
  const local = localParts(ms, timeZone);
  const wall = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant at which the zone's wall clock shows the given local date and time.
 * A time repeated when clocks go back resolves to its first occurrence. A time skipped
 * when clocks go forward resolves to the same distance past the gap, so 02:30 on a
 * spring-forward night at 02:00 runs at 03:30.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - 14 * HOUR, timeZone);
  const candidates = [before, offsetAt(wall, timeZone), offsetAt(wall + 14 * HOUR, timeZone)]
    .map((offset) => wall - offset)
    .filter((instant) => {
      const local = localParts(instant, timeZone);
      return (
        local.year === year &&
        local.month === month &&
        local.day === day &&
        local.hour === hour &&
        local.minute === minute
      );
    });
  return candidates.length ? Math.min(...candidates) : wall - before;
}

/** The first occurrence strictly after `afterMs`, or null if none falls within eight days. */
export function nextOccurrence(repeat: Repeat, afterMs: number): number | null {
  const times = repeat.times.map((time) => time.split(':').map(Number) as [number, number]);
  const start = localParts(afterMs, repeat.time_zone);
  let best: number | null = null;
  let bestDay = 0;
  for (let offset = -1; offset <= 8; offset++) {
    if (best !== null && offset > bestDay + 1) break;
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (repeat.weekdays && !repeat.weekdays.includes(DAY_NAMES[date.getUTCDay()]!)) continue;
    for (const [hour, minute] of times) {
      const instant = localToUtc(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        minute,
        repeat.time_zone,
      );
      if (instant > afterMs && (best === null || instant < best)) {
        best = instant;
        bestDay = offset;
      }
    }
  }
  return best;
}

/**
 * The latest occurrence at or before `nowMs`, never earlier than the due occurrence `dueMs`.
 * Every schedule recurs at least weekly, so it lies within eight local days of `nowMs`; the
 * search walks back from there instead of through every slot an outage missed.
 */
export function latestDueOccurrence(repeat: Repeat, dueMs: number, nowMs: number): number {
  const times = repeat.times.map((time) => time.split(':').map(Number) as [number, number]);
  const end = localParts(nowMs, repeat.time_zone);
  let latest = dueMs;
  for (let offset = 1; offset >= -8; offset--) {
    const date = new Date(Date.UTC(end.year, end.month - 1, end.day + offset));
    if (repeat.weekdays && !repeat.weekdays.includes(DAY_NAMES[date.getUTCDay()]!)) continue;
    for (const [hour, minute] of times) {
      const instant = localToUtc(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        minute,
        repeat.time_zone,
      );
      if (instant <= nowMs && instant > latest) latest = instant;
    }
  }
  return latest;
}

/** A readable local label, for example "Fri 2026-10-16 06:41 Europe/Stockholm". */
export function localLabel(ms: number, timeZone: string): string {
  const local = localParts(ms, timeZone);
  const weekday =
    DAY_NAMES[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()]!;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${weekday[0]!.toUpperCase()}${weekday.slice(1)} ${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)} ${timeZone}`;
}
