import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paceState, weeklyPace } from '../src/pace.js';

const DAY = 24 * 60 * 60_000;
const now = Date.parse('2026-10-16T12:00:00Z');
const resetIn = (days: number) => (now + days * DAY) / 1000;

test('the weekly line is the share of the week that has passed', () => {
  // Johan: 14% a day, reaching 0% left as the week resets.
  assert.deepEqual(weeklyPace(0, resetIn(7), now), { line: 0, lead: 0 });
  assert.deepEqual(weeklyPace(65, resetIn(3), now), { line: 57.1, lead: 7.9 });
  assert.deepEqual(weeklyPace(50, resetIn(3), now), { line: 57.1, lead: -7.1 });
  assert.deepEqual(weeklyPace(99, resetIn(0.01), now), { line: 99.9, lead: -0.9 });
  // Once the window has reset, the reading says nothing about the new week.
  assert.equal(weeklyPace(80, resetIn(-0.1), now), null);
});

test('an account is off pace more than 5 points from its line', () => {
  assert.equal(paceState(4.9), 'on');
  assert.equal(paceState(5.1), 'ahead');
  assert.equal(paceState(-4.9), 'on');
  assert.equal(paceState(-6), 'behind');
});
