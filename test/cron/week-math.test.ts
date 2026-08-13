/**
 * week-math tests — boundary cases across Sunday / Monday / Wednesday,
 * plus year-boundary wrap (design r1-1 §4.1 token rule).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeekShiftTokens, isoWeekOf } from '../../src/cron/week-math.js';

function d(y: number, m: number, day: number, h = 0): Date {
  return new Date(y, m - 1, day, h);
}

describe('isoWeekOf', () => {
  it('2026-08-17 is in ISO week 34', () => {
    assert.equal(isoWeekOf(d(2026, 8, 17)), 34);
  });

  it('Monday and Sunday of the same week share the week number', () => {
    assert.equal(isoWeekOf(d(2026, 8, 17)), isoWeekOf(d(2026, 8, 23)));
  });

  it('2026-12-28 is in week 53 (2026 has 53 ISO weeks)', () => {
    assert.equal(isoWeekOf(d(2026, 12, 28)), 53);
  });
});

describe('computeWeekShiftTokens — design window cases', () => {
  it('Sunday 2026-08-16 run → to=W34, from=W33, startDate=2026-08-17', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2026, 8, 16, 23)), {
      fromWeek: 'W33',
      toWeek: 'W34',
      startDate: '2026-08-17',
    });
  });

  it('Monday 2026-08-17 catchup run → still to=W34', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2026, 8, 17, 9)), {
      fromWeek: 'W33',
      toWeek: 'W34',
      startDate: '2026-08-17',
    });
  });

  it('Wednesday 2026-08-19 catchup run → still to=W34', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2026, 8, 19, 9)), {
      fromWeek: 'W33',
      toWeek: 'W34',
      startDate: '2026-08-17',
    });
  });

  it('next Sunday 2026-08-23 run → to=W35, startDate=2026-08-24', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2026, 8, 23, 23)), {
      fromWeek: 'W34',
      toWeek: 'W35',
      startDate: '2026-08-24',
    });
  });
});

describe('computeWeekShiftTokens — year boundaries', () => {
  it('Sunday 2026-12-27 run → to=W53 (final week of 2026)', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2026, 12, 27, 23)), {
      fromWeek: 'W52',
      toWeek: 'W53',
      startDate: '2026-12-28',
    });
  });

  it('Sunday 2027-01-03 run → to=W01, from wraps to W53 of 2026', () => {
    assert.deepEqual(computeWeekShiftTokens(d(2027, 1, 3, 23)), {
      fromWeek: 'W53',
      toWeek: 'W01',
      startDate: '2027-01-04',
    });
  });

  it('week numbers are zero-padded (W05, not W5)', () => {
    // Sunday 2027-01-31 → tomorrow 2027-02-01 is the Monday of W05.
    assert.deepEqual(computeWeekShiftTokens(d(2027, 1, 31, 23)), {
      fromWeek: 'W04',
      toWeek: 'W05',
      startDate: '2027-02-01',
    });
  });
});
