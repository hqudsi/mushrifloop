/**
 * Where the window was last time (SPEC.md §9, §10).
 *
 * The app draws its own title bar, so "maximised" is no longer something Windows remembers for us:
 * a frameless window opens exactly where we put it. This keeps the last position, size and
 * maximised state in `window.json` next to the other data files.
 *
 * A saved rectangle is only used if it still lands on a display that exists — unplugging the second
 * monitor must not open the window off-screen. The file is app state, not the user's data: if it
 * cannot be read it is logged and ignored, and the next save replaces it.
 */

import type { BrowserWindow, Rectangle } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeJsonAtomic } from './atomic-write';
import { dataFolder } from './config';
import { errorMessage, log } from './logger';

export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

/** First run: the size the app opened at before any of this existed. */
export const DEFAULT_SIZE = { width: 1440, height: 900 } as const;
export const MIN_SIZE = { width: 960, height: 640 } as const;

export function windowStateFile(): string {
  return path.join(dataFolder(), 'window.json');
}

function isRectangle(value: unknown): value is Rectangle {
  const r = value as Rectangle | undefined;
  return (
    !!r &&
    [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    r.width >= MIN_SIZE.width &&
    r.height >= MIN_SIZE.height
  );
}

/** Parse what was saved; anything unexpected reads as "no saved state". */
export function parseWindowState(text: string): WindowState | null {
  try {
    const raw = JSON.parse(text) as { bounds?: unknown; maximized?: unknown };
    if (!isRectangle(raw.bounds)) return null;
    const { x, y, width, height } = raw.bounds;
    return { bounds: { x, y, width, height }, maximized: raw.maximized === true };
  } catch {
    return null;
  }
}

/** How much of `bounds` lies inside `area`, in pixels. */
function overlap(bounds: Rectangle, area: Rectangle): number {
  const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const h = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The bounds to open at: the saved ones when enough of the window still falls on a display, and
 * nothing (centre it at the default size) when it does not. "Enough" is the title bar plus a
 * grabbable width — a window whose only visible corner is off the edge cannot be moved back.
 */
export function usableBounds(state: WindowState | null, workAreas: readonly Rectangle[]): Rectangle | null {
  if (!state || workAreas.length === 0) return null;
  const needed = Math.min(state.bounds.width, 200) * 48;
  return workAreas.some((area) => overlap(state.bounds, area) >= needed) ? state.bounds : null;
}

export function readWindowState(): WindowState | null {
  const file = windowStateFile();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('window_state.unreadable', { file, error: errorMessage(err) });
    }
    return null;
  }
  const state = parseWindowState(text);
  if (!state) log.warn('window_state.ignored', { file, reason: 'not a usable window rectangle' });
  return state;
}

/**
 * Save the position the window would have when restored — `getBounds()` while maximised is the
 * maximised rectangle, which would lose the size the user actually chose.
 */
export function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const state: WindowState = {
    bounds: window.isMaximized() || window.isMinimized() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized(),
  };
  try {
    writeJsonAtomic(windowStateFile(), state);
  } catch (err) {
    log.warn('window_state.save_failed', { file: windowStateFile(), error: errorMessage(err) });
  }
}

/** Save at most once per `delayMs` while the user drags or resizes, and once more at the end. */
export function trackWindowState(window: BrowserWindow, delayMs = 500): () => void {
  let timer: NodeJS.Timeout | null = null;
  const later = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      saveWindowState(window);
    }, delayMs);
    timer.unref?.();
  };
  // Listed one by one: each event name is its own overload on BrowserWindow.on.
  window.on('resize', later);
  window.on('move', later);
  window.on('maximize', later);
  window.on('unmaximize', later);
  window.on('restore', later);
  const onClose = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    saveWindowState(window);
  };
  window.on('close', onClose);
  return () => {
    if (timer) clearTimeout(timer);
    window.off('resize', later);
    window.off('move', later);
    window.off('maximize', later);
    window.off('unmaximize', later);
    window.off('restore', later);
    window.off('close', onClose);
  };
}
