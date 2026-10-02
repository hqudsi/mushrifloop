/**
 * Remembering where the window was (SPEC.md §9, §10). The window is frameless now, so nothing else
 * restores its position — and a saved rectangle from a monitor that is gone must never win.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { initDataFolder } from './config';
import { parseWindowState, readWindowState, usableBounds, windowStateFile, type WindowState } from './window-state';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-'));
initDataFolder(ROOT);

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 2560, height: 1400 };

function state(patch: Partial<WindowState['bounds']> = {}, maximized = false): WindowState {
  return { bounds: { x: 100, y: 80, width: 1440, height: 900, ...patch }, maximized };
}

beforeEach(() => {
  fs.rmSync(windowStateFile(), { force: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('parseWindowState', () => {
  it('reads a rectangle and the maximised flag', () => {
    expect(parseWindowState(JSON.stringify(state({}, true)))).toEqual(state({}, true));
    expect(parseWindowState(JSON.stringify({ bounds: state().bounds }))).toEqual(state());
  });

  it('refuses anything that is not a usable rectangle', () => {
    expect(parseWindowState('not json')).toBeNull();
    expect(parseWindowState('{}')).toBeNull();
    expect(parseWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: 1440 } }))).toBeNull();
    expect(parseWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: NaN, height: 900 } }))).toBeNull();
    // Smaller than the window's own minimum: it would open unusable.
    expect(parseWindowState(JSON.stringify(state({ width: 400, height: 300 })))).toBeNull();
  });
});

describe('usableBounds', () => {
  it('keeps a window that is on a display', () => {
    expect(usableBounds(state(), [LAPTOP])).toEqual(state().bounds);
    expect(usableBounds(state({ x: 2000 }), [LAPTOP, SECOND])).toEqual(state({ x: 2000 }).bounds);
  });

  it('drops one that is off every display, so it is centred at the default size instead', () => {
    // The second monitor is gone.
    expect(usableBounds(state({ x: 2600, y: 200 }), [LAPTOP])).toBeNull();
    // Dragged almost entirely off the bottom: too little left to grab.
    expect(usableBounds(state({ x: 100, y: 1035 }), [LAPTOP])).toBeNull();
    expect(usableBounds(state(), [])).toBeNull();
    expect(usableBounds(null, [LAPTOP])).toBeNull();
  });

  it('keeps one that hangs over an edge but still shows its title bar', () => {
    expect(usableBounds(state({ x: -200, y: 0 }), [LAPTOP])).toEqual(state({ x: -200, y: 0 }).bounds);
  });
});

describe('readWindowState', () => {
  it('is null when there is no file yet', () => {
    expect(readWindowState()).toBeNull();
  });

  it('ignores a corrupt file instead of failing to start', () => {
    fs.writeFileSync(windowStateFile(), '{ half written', 'utf8');
    expect(readWindowState()).toBeNull();
  });

  it('reads back what was saved', () => {
    fs.writeFileSync(windowStateFile(), JSON.stringify(state({ x: 12 }, true)), 'utf8');
    expect(readWindowState()).toEqual(state({ x: 12 }, true));
  });
});
