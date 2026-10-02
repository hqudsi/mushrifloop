/**
 * The two colours Windows paints its caption buttons with (SPEC.md §10). They are the only part of
 * the title bar the app does not draw itself, so they have to track the theme — and get out of the
 * way when the user has chosen a high-contrast scheme.
 */
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { shouldUseDarkColors: true, shouldUseHighContrastColors: false, themeSource: 'system', on: () => undefined },
}));

import { TITLE_BAR_HEIGHT, titleBarColors } from './theme';

describe('titleBarColors', () => {
  it('matches the header the buttons sit in', () => {
    // --bg-chrome / --text in src/renderer/styles.css.
    expect(titleBarColors('dark', false)).toEqual({ color: '#1b1e24', symbolColor: '#e6e8ec' });
    expect(titleBarColors('light', false)).toEqual({ color: '#ffffff', symbolColor: '#1a1d23' });
  });

  it('gives high contrast plain black and white, not our palette', () => {
    expect(titleBarColors('dark', true)).toEqual({ color: '#000000', symbolColor: '#ffffff' });
    expect(titleBarColors('light', true)).toEqual({ color: '#ffffff', symbolColor: '#000000' });
  });

  it('reserves exactly the header height the renderer draws', () => {
    expect(TITLE_BAR_HEIGHT).toBe(38);
  });
});
