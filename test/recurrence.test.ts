import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRepeat, RepeatSchema } from '../src/protocol.js';
import { latestDueOccurrence, localLabel, localToUtc, nextOccurrence } from '../src/recurrence.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const stockholm = (times: string[], weekdays?: string[]) =>
  canonicalRepeat(
    RepeatSchema.parse({
      time_zone: 'Europe/Stockholm',
      times,
      ...(weekdays ? { weekdays } : {}),
    }),
  );
const series = (repeat: ReturnType<typeof stockholm>, from: string, count: number) => {
  const result: string[] = [];
  let at = Date.parse(from);
  for (let i = 0; i < count; i++) {
    at = nextOccurrence(repeat, at)!;
    result.push(iso(at)!);
  }
  return result;
};

test('a daily local time keeps its wall-clock time across both Stockholm DST changes', () => {
  // Summer time ends 2026-10-25 03:00 CEST; it starts again 2027-03-28 02:00 CET.
  assert.deepEqual(series(stockholm(['06:41']), '2026-10-23T12:00:00Z', 4), [
    '2026-10-24T04:41:00.000Z',
    '2026-10-25T05:41:00.000Z',
    '2026-10-26T05:41:00.000Z',
    '2026-10-27T05:41:00.000Z',
  ]);
  assert.deepEqual(series(stockholm(['06:41']), '2027-03-26T12:00:00Z', 3), [
    '2027-03-27T05:41:00.000Z',
    '2027-03-28T04:41:00.000Z',
    '2027-03-29T04:41:00.000Z',
  ]);
  assert.equal(
    localLabel(Date.parse('2026-10-25T05:41:00Z'), 'Europe/Stockholm'),
    'Sun 2026-10-25 06:41 Europe/Stockholm',
  );
});

test('a skipped clock time runs just after the gap and a repeated one runs once, first', () => {
  // 02:30 does not exist on 2027-03-28: it runs at 03:30 CEST.
  assert.equal(iso(localToUtc(2027, 3, 28, 2, 30, 'Europe/Stockholm')), '2027-03-28T01:30:00.000Z');
  // 02:30 happens twice on 2026-10-25: the first, still in CEST, is used.
  assert.equal(
    iso(localToUtc(2026, 10, 25, 2, 30, 'Europe/Stockholm')),
    '2026-10-25T00:30:00.000Z',
  );
  assert.deepEqual(series(stockholm(['02:30']), '2026-10-24T12:00:00Z', 2), [
    '2026-10-25T00:30:00.000Z',
    '2026-10-26T01:30:00.000Z',
  ]);
  assert.equal(
    iso(nextOccurrence(stockholm(['02:30']), Date.parse('2027-03-27T12:00:00Z'))),
    '2027-03-28T01:30:00.000Z',
  );
});

test('weekdays, several times a day and far-off zones', () => {
  // Lando's 06:08 film check on weekdays, and an evening report.
  assert.deepEqual(
    series(stockholm(['23:00', '06:08'], ['fri', 'mon']), '2026-10-15T12:00:00Z', 5),
    [
      '2026-10-16T04:08:00.000Z',
      '2026-10-16T21:00:00.000Z',
      '2026-10-19T04:08:00.000Z',
      '2026-10-19T21:00:00.000Z',
      '2026-10-23T04:08:00.000Z',
    ],
  );
  const repeat = stockholm(['06:41', '06:41', '01:00']);
  assert.deepEqual(repeat.times, ['01:00', '06:41']);
  assert.deepEqual(stockholm(['06:41'], ['sun', 'mon', 'sun']).weekdays, ['mon', 'sun']);
  assert.equal(
    iso(
      nextOccurrence(
        { time_zone: 'Pacific/Kiritimati', times: ['06:41'], weekdays: null },
        Date.parse('2026-10-15T12:00:00Z'),
      ),
    ),
    '2026-10-15T16:41:00.000Z',
  );
  assert.equal(
    iso(
      nextOccurrence(
        { time_zone: 'America/New_York', times: ['02:30'], weekdays: null },
        Date.parse('2027-03-13T12:00:00Z'),
      ),
    ),
    '2027-03-14T07:30:00.000Z',
  );
  assert.equal(
    canonicalRepeat(RepeatSchema.parse({ time_zone: 'utc', times: ['00:00'] })).time_zone,
    'UTC',
  );
  for (const invalid of [
    { time_zone: 'Mars/Olympus', times: ['06:41'] },
    { time_zone: 'Europe/Stockholm', times: ['6:41'] },
    { time_zone: 'Europe/Stockholm', times: ['24:00'] },
    { time_zone: 'Europe/Stockholm', times: [] },
    { time_zone: 'Europe/Stockholm', times: ['06:41'], weekdays: ['monday'] },
    { time_zone: 'Europe/Stockholm', times: ['06:41'], every: 'hour' },
  ])
    assert.equal(RepeatSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test('after an outage the latest missed slot is the one delivered', () => {
  const night = stockholm(['23:00', '00:00', '01:00', '02:00', '03:00']);
  // Due at 23:00 local; the broker comes back at 01:30 local.
  assert.equal(
    iso(
      latestDueOccurrence(
        night,
        Date.parse('2026-10-15T21:00:00Z'),
        Date.parse('2026-10-15T23:30:00Z'),
      ),
    ),
    '2026-10-15T23:00:00.000Z',
  );
  // On time, the due slot itself.
  assert.equal(
    iso(
      latestDueOccurrence(
        night,
        Date.parse('2026-10-15T21:00:00Z'),
        Date.parse('2026-10-15T21:00:00Z'),
      ),
    ),
    '2026-10-15T21:00:00.000Z',
  );
});

test('after an outage longer than any slot count, catch-up picks the latest missed slot', () => {
  const hourly = canonicalRepeat(
    RepeatSchema.parse({
      time_zone: 'UTC',
      times: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`),
    }),
  );
  // 2,400 hourly slots after the due one.
  assert.equal(
    new Date(
      latestDueOccurrence(
        hourly,
        Date.parse('2026-01-01T00:00:00Z'),
        Date.parse('2026-04-11T00:30:00Z'),
      ),
    ).toISOString(),
    '2026-04-11T00:00:00.000Z',
  );
  // Weekdays only, from a Friday evening to Monday morning in Stockholm: Monday's 06:41.
  const mornings = stockholm(['06:41'], ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(
    new Date(
      latestDueOccurrence(
        mornings,
        Date.parse('2026-10-16T04:41:00Z'),
        Date.parse('2026-10-19T05:00:00Z'),
      ),
    ).toISOString(),
    '2026-10-19T04:41:00.000Z',
  );
  // Due but nothing later yet: the due slot itself.
  assert.equal(
    latestDueOccurrence(
      mornings,
      Date.parse('2026-10-16T04:41:00Z'),
      Date.parse('2026-10-16T05:00:00Z'),
    ),
    Date.parse('2026-10-16T04:41:00Z'),
  );
});
