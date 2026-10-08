/**
 * Resizable side panels (SPEC.md §10, decided 2026-10-08): the task list on the left and the side panel on the
 * right each have a default, a minimum and a maximum width, and the timeline between them never gets narrower
 * than CENTER_MIN. Pure, so the rules are tested without a window.
 */

export type PanelSide = 'left' | 'right';

export const PANEL_LIMITS: Record<PanelSide, { initial: number; min: number; max: number }> = {
  left: { initial: 260, min: 200, max: 420 },
  right: { initial: 320, min: 260, max: 520 },
};

/** The timeline in the middle never gets narrower than this because of a panel. */
export const CENTER_MIN = 440;

/** A stored or dragged width inside the panel's own limits. Anything that is not a number is the default. */
export function clampWidth(side: PanelSide, width: unknown): number {
  const { initial, min, max } = PANEL_LIMITS[side];
  if (typeof width !== 'number' || !Number.isFinite(width)) return initial;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The widths to draw in a window this wide: the chosen ones, made smaller when the window cannot fit them and
 * still give the centre CENTER_MIN — the right panel gives way first, then the list, neither below its minimum.
 * `right` is null while the side panel is hidden.
 */
export function fitPanels(windowWidth: number, left: number, right: number | null): { left: number; right: number | null } {
  let l = clampWidth('left', left);
  let r = right === null ? null : clampWidth('right', right);
  const room = windowWidth - CENTER_MIN;
  let over = l + (r ?? 0) - room;
  if (over > 0 && r !== null) {
    const next = Math.max(PANEL_LIMITS.right.min, r - over);
    over -= r - next;
    r = next;
  }
  if (over > 0) l = Math.max(PANEL_LIMITS.left.min, l - over);
  return { left: l, right: r };
}

/**
 * A width the user is dragging or stepping to: inside the panel's limits, and no wider than leaves the centre
 * CENTER_MIN next to the other panel as it is drawn (`other` is 0 when that panel is hidden).
 */
export function dragWidth(side: PanelSide, wanted: number, windowWidth: number, other: number): number {
  const { min } = PANEL_LIMITS[side];
  const roomy = Math.max(min, windowWidth - CENTER_MIN - other);
  return Math.min(clampWidth(side, wanted), roomy);
}
