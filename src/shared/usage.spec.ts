import { describe, expect, it } from 'vitest';

import { USAGE_OVER_PERCENT, USAGE_WARN_PERCENT, isPastReset, usageLevel, usageRefreshDue } from './usage';

describe('usage bar level (SPEC.md §17)', () => {
  it('is the accent below 75 %, amber from 75 % and red from 90 %', () => {
    expect([USAGE_WARN_PERCENT, USAGE_OVER_PERCENT]).toEqual([75, 90]);
    expect(usageLevel(0)).toBe('ok');
    expect(usageLevel(74)).toBe('ok');
    expect(usageLevel(75)).toBe('warn');
    expect(usageLevel(89)).toBe('warn');
    expect(usageLevel(90)).toBe('over');
    expect(usageLevel(100)).toBe('over');
  });
});

describe('when the panel refreshes itself (SPEC.md §17)', () => {
  const t0 = Date.parse('2026-09-26T06:00:00.000Z');
  const min = 60_000;

  it('every 5 minutes', () => {
    expect(usageRefreshDue(t0 + 5 * min - 1, t0, false, [])).toBe(false);
    expect(usageRefreshDue(t0 + 5 * min, t0, false, [])).toBe(true);
  });

  it('on coming back to the window, but not within a minute of the last one', () => {
    expect(usageRefreshDue(t0 + 30_000, t0, true, [])).toBe(false);
    expect(usageRefreshDue(t0 + min, t0, true, [])).toBe(true);
  });

  it('once, just after a window resets', () => {
    const reset = (t0 + 2 * min) / 1000;
    expect(usageRefreshDue(t0 + 2 * min, t0, false, [reset])).toBe(false); // not in the reset's first seconds
    expect(usageRefreshDue(t0 + 2 * min + 5_000, t0, false, [reset])).toBe(true);
    // Asked after the reset already: not again until the next rule.
    expect(usageRefreshDue(t0 + 3 * min, t0 + 2 * min + 6_000, false, [reset])).toBe(false);
    expect(usageRefreshDue(t0 + 3 * min, t0, false, [null])).toBe(false);
  });
});

describe('a window past its reset (SPEC.md §17)', () => {
  it('is past once its reset time has come, and never without one', () => {
    const resetsAt = 1_790_410_800;
    expect(isPastReset(resetsAt, resetsAt * 1000 - 1)).toBe(false);
    expect(isPastReset(resetsAt, resetsAt * 1000)).toBe(true);
    expect(isPastReset(null, Date.now())).toBe(false);
  });
});
