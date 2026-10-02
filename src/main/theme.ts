/**
 * Theme plumbing on the main side (SPEC.md §10: dark and light variants; default follows the OS).
 *
 * `nativeTheme.themeSource` is the single switch:
 *   - 'system' → Chromium's `prefers-color-scheme` tracks the Windows app theme live, no restart;
 *   - 'light' / 'dark' → an explicit override that also recolours the scrollbars and the native
 *     dialogs, which the renderer's CSS cannot reach.
 * The renderer picks its tokens from the same setting (see app.ts), so both stay in step.
 *
 * The window has no native title bar any more (SPEC.md §10): the caption buttons are drawn by
 * Windows into the overlay region at the right of our own header, and their two colours are ours
 * to set — which is what keeps them from sitting on the wrong background after a theme change.
 */

import { BrowserWindow, nativeTheme } from 'electron';

import type { ThemeSetting } from '../shared/settings';
import { log } from './logger';

/** Window background per resolved theme — the `--bg` tokens in src/renderer/styles.css. */
const WINDOW_BACKGROUND = { dark: '#16181d', light: '#f4f5f7' } as const;

/** The header the caption buttons sit in — `--bg-chrome` and `--text` in src/renderer/styles.css. */
const CHROME = {
  dark: { color: '#1b1e24', symbolColor: '#e6e8ec' },
  light: { color: '#ffffff', symbolColor: '#1a1d23' },
} as const;

/**
 * A high-contrast theme replaces the palette with the user's own, and a colour we chose would
 * defeat the point. Windows' high-contrast schemes paint window chrome in plain black or white,
 * so that is what the buttons get; the page follows through `forced-colors` in the CSS.
 */
const HIGH_CONTRAST = {
  dark: { color: '#000000', symbolColor: '#ffffff' },
  light: { color: '#ffffff', symbolColor: '#000000' },
} as const;

/** Must match the header's height in src/renderer/app/app.ts. */
export const TITLE_BAR_HEIGHT = 38;

export function resolvedTheme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function windowBackground(): string {
  return WINDOW_BACKGROUND[resolvedTheme()];
}

/** Pure, so the pairing can be tested without a window. */
export function titleBarColors(theme: 'dark' | 'light', highContrast: boolean): { color: string; symbolColor: string } {
  return highContrast ? HIGH_CONTRAST[theme] : CHROME[theme];
}

export function titleBarOverlay(): Electron.TitleBarOverlay {
  return { ...titleBarColors(resolvedTheme(), nativeTheme.shouldUseHighContrastColors), height: TITLE_BAR_HEIGHT };
}

/** The native layer of a theme change: window background and the caption buttons. */
function repaintWindows(): void {
  const background = windowBackground();
  const overlay = titleBarOverlay();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setBackgroundColor(background);
    try {
      window.setTitleBarOverlay(overlay);
    } catch (err) {
      // Only throws on a window that has no overlay (not one of ours, or not Windows).
      log.warn('theme.overlay_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Apply a theme setting to the native layer and every open window. */
export function applyTheme(theme: ThemeSetting): void {
  if (nativeTheme.themeSource !== theme) {
    nativeTheme.themeSource = theme;
    log.info('theme.applied', { setting: theme, resolved: resolvedTheme() });
  }
  repaintWindows();
}

/** Keep window backgrounds and caption buttons right when Windows switches theme or contrast. */
export function watchSystemTheme(): void {
  nativeTheme.on('updated', () => {
    repaintWindows();
    log.info('theme.system_updated', {
      source: nativeTheme.themeSource,
      resolved: resolvedTheme(),
      highContrast: nativeTheme.shouldUseHighContrastColors,
    });
  });
}
