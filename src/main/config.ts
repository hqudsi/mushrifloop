/**
 * Filesystem layout for the app (SPEC.md §9).
 *
 * All paths derive from APP_NAME; nothing else hard-codes the product name.
 *
 * Two folders:
 *   - the *default* folder, %APPDATA%/<APP_NAME>, which always holds settings.json — the app must
 *     be able to find its settings before it knows anything else;
 *   - the *data* folder (tasks/, usage.json, app.log), which is the default unless
 *     Settings → General → Data folder says otherwise. It is resolved once per process by
 *     initDataFolder(); changing the setting takes effect on the next start.
 *
 * Works under plain Node as well as Electron, so CLI tools (npm run try-turn) share the layout.
 */

import * as electron from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';

import { APP_NAME } from '../shared/app-config';
import type { StorageInfo } from '../shared/ipc';

export { APP_NAME };

/** Under plain Node, `require('electron')` is just the path to the binary, so `app` is absent. */
function electronApp(): Electron.App | undefined {
  const candidate = (electron as unknown as { app?: Electron.App }).app;
  return candidate && typeof candidate.getPath === 'function' ? candidate : undefined;
}

function appDataRoot(): string {
  const app = electronApp();
  if (app) return app.getPath('appData');
  if (process.env['APPDATA']) return process.env['APPDATA'];
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'));
}

/** `%APPDATA%/<APP_NAME>` — where settings.json lives, and the data folder unless configured. */
export function defaultDataFolder(): string {
  return path.join(appDataRoot(), APP_NAME);
}

let activeDataFolder: string | null = null;
let storageInfo: StorageInfo | null = null;

/** Resolve the data folder from the `general.dataFolder` setting. Call once, at startup. */
export function initDataFolder(configured: string): string {
  activeDataFolder = configured.trim() ? path.resolve(configured.trim()) : defaultDataFolder();
  return activeDataFolder;
}

/** The data folder this process writes to (the default until initDataFolder runs). */
export function dataFolder(): string {
  return activeDataFolder ?? defaultDataFolder();
}

export function setStorageInfo(info: StorageInfo): void {
  storageInfo = info;
}

/** Where this process actually writes, as detected at startup (null before detection). */
export function getStorageInfo(): StorageInfo | null {
  return storageInfo;
}

export function settingsFile(): string {
  return path.join(defaultDataFolder(), 'settings.json');
}

export function logFile(): string {
  return path.join(dataFolder(), 'app.log');
}

export function usageFile(): string {
  return path.join(dataFolder(), 'usage.json');
}

export function tasksFolder(): string {
  return path.join(dataFolder(), 'tasks');
}

/**
 * Folder holding the shipped resources `schemas/`, `agents/` and `assets/`.
 *
 * Unpackaged, that is the project root, reached from both `dist/main` (built) and `src/main`
 * (tests), which sit at the same depth. Packaged, they ship next to the asar as `extraResources`
 * (electron-builder.config.js) — `process.resourcesPath` — because a path inside an asar is not a
 * file Windows or the `claude` CLI could open.
 */
export function resourceRoot(): string {
  const app = electronApp();
  if (app?.isPackaged) return process.resourcesPath;
  return path.resolve(__dirname, '..', '..');
}

export function schemasFolder(): string {
  return path.join(resourceRoot(), 'schemas');
}

/** Shipped images (SPEC.md §10): the SVG sources and the generated `icon.ico` / `icon-256.png`. */
export function assetsFolder(): string {
  return path.join(resourceRoot(), 'assets');
}

/** The multi-size Windows icon: window, taskbar, Alt-Tab, and the installer's shortcut. */
export function appIconFile(): string {
  return path.join(assetsFolder(), 'icon.ico');
}

/** Windows notifications take a bitmap, not an .ico. */
export function notificationIconFile(): string {
  return path.join(assetsFolder(), 'icon-256.png');
}

export function agentPromptFile(agent: 'planner' | 'executor'): string {
  return path.join(resourceRoot(), 'agents', `${agent}.md`);
}

/** Scratch area for `npm run try-turn` (not task data). */
export function tryTurnFolder(): string {
  return path.join(dataFolder(), 'try-turn');
}

/** Per-task folders (SPEC.md §9). Used from Phase 3 on; defined here so the layout lives in one place. */
export function taskFolder(taskId: string): string {
  return path.join(tasksFolder(), taskId);
}

/** The Planner's isolated cwd. Created at task start and kept for the task's lifetime (SPEC.md §3.1). */
export function plannerCwd(taskId: string): string {
  return path.join(taskFolder(taskId), 'planner-cwd');
}
