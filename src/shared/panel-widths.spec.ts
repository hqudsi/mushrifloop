/**
 * Resizable side panels (SPEC.md §10): limits, and the centre's minimum width.
 */
import { describe, expect, it } from 'vitest';

import { CENTER_MIN, PANEL_LIMITS, clampWidth, dragWidth, fitPanels } from './panel-widths';

describe('clampWidth', () => {
  it('keeps a width inside the panel limits, and falls back to the default for junk', () => {
    expect(clampWidth('left', 300)).toBe(300);
    expect(clampWidth('left', 50)).toBe(200);
    expect(clampWidth('left', 9000)).toBe(420);
    expect(clampWidth('right', 100)).toBe(260);
    expect(clampWidth('right', 600)).toBe(520);
    expect(clampWidth('right', 333.6)).toBe(334);
    expect(clampWidth('left', '300')).toBe(PANEL_LIMITS.left.initial);
    expect(clampWidth('right', Number.NaN)).toBe(PANEL_LIMITS.right.initial);
    expect(clampWidth('left', null)).toBe(260);
  });
});

describe('fitPanels', () => {
  it('draws the chosen widths when the window has room', () => {
    expect(fitPanels(1600, 400, 500)).toEqual({ left: 400, right: 500 });
    expect(fitPanels(1600, 400, null)).toEqual({ left: 400, right: null });
  });

  it('in a narrow window the right panel gives way first, then the list, never below their minimums', () => {
    // 1200 - 440 = 760 of room for 400 + 500.
    expect(fitPanels(1200, 400, 500)).toEqual({ left: 400, right: 360 });
    // 960 (the smallest window) - 440 = 520: right to 260, then left to 260.
    expect(fitPanels(960, 400, 500)).toEqual({ left: 260, right: 260 });
    // Narrower than the minimums allow: both at their minimum, the centre takes what is left.
    expect(fitPanels(800, 400, 500)).toEqual({ left: 200, right: 260 });
  });

  it('in the smallest window the defaults leave the centre exactly its minimum, the right panel giving 60 px', () => {
    const { left, right } = fitPanels(960, PANEL_LIMITS.left.initial, PANEL_LIMITS.right.initial);
    expect({ left, right }).toEqual({ left: 260, right: 260 });
    expect(960 - left - (right ?? 0)).toBe(CENTER_MIN);
  });
});

describe('dragWidth', () => {
  it('stops at the limits and where the centre would get too narrow', () => {
    expect(dragWidth('left', 380, 1600, 320)).toBe(380);
    expect(dragWidth('left', 999, 1600, 320)).toBe(420);
    expect(dragWidth('left', 10, 1600, 320)).toBe(200);
    // 1100 - 440 - 320 = 340.
    expect(dragWidth('left', 400, 1100, 320)).toBe(340);
    // Never below the minimum, even when there is no room at all.
    expect(dragWidth('right', 400, 900, 420)).toBe(260);
    // The other panel hidden: only the limits apply here.
    expect(dragWidth('right', 600, 1200, 0)).toBe(520);
  });
});
