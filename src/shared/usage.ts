/**
 * Plan usage as the panel shows it (SPEC.md §17): the bar's colour by level, and whether a window has reset
 * since it was last read. Display only — nothing that decides what runs reads these.
 */

export type UsageLevel = 'ok' | 'warn' | 'over';

/** From here the bar is amber, the app's warning colour. */
export const USAGE_WARN_PERCENT = 75;
/** From here the bar is red. */
export const USAGE_OVER_PERCENT = 90;

export function usageLevel(percent: number): UsageLevel {
  if (percent >= USAGE_OVER_PERCENT) return 'over';
  if (percent >= USAGE_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** Between turns the panel runs `/usage` this often… */
export const USAGE_REFRESH_EVERY_MS = 5 * 60_000;
/** …when the window comes back to the front after at least this long… */
export const USAGE_REFRESH_ON_FOCUS_MS = 60_000;
/** …and this soon after a window's reset time, so the reset shows at once (SPEC.md §17). */
export const USAGE_REFRESH_AFTER_RESET_MS = 5_000;

/**
 * Whether the panel should run `/usage` now (SPEC.md §17). `lastRefreshMs` is the last time it asked, whether
 * or not the run succeeded, so a failing `/usage` is retried at the same pace rather than in a loop.
 * `resetsAt` are the windows' reset times in epoch seconds.
 */
export function usageRefreshDue(nowMs: number, lastRefreshMs: number, focus: boolean, resetsAt: readonly (number | null)[]): boolean {
  const since = nowMs - lastRefreshMs;
  if (since >= USAGE_REFRESH_EVERY_MS) return true;
  if (focus && since >= USAGE_REFRESH_ON_FOCUS_MS) return true;
  return resetsAt.some((r) => {
    if (r === null) return false;
    const due = r * 1000 + USAGE_REFRESH_AFTER_RESET_MS;
    return due <= nowMs && due > lastRefreshMs;
  });
}

/**
 * A window whose reset time has passed. Its last reading was taken before the reset, so it no longer holds
 * until a new one arrives. `resetsAt` is in epoch seconds.
 */
export function isPastReset(resetsAt: number | null, nowMs: number): boolean {
  return resetsAt !== null && resetsAt * 1000 <= nowMs;
}
