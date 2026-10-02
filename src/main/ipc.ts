/**
 * IPC handlers — the main-process half of the contract in src/shared/ipc.ts.
 *
 * Every handler is defensive: the renderer is trusted code, but a thrown error here would
 * surface as an opaque rejection, so failures are turned into values the UI can show
 * (CLAUDE.md: errors surface with the raw message and a next step).
 */

import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IPC,
  type AppInfo,
  type ClaudeBinaryInfo,
  type PickPathResult,
  type SaveSettingsResult,
  type TestConnectionResult,
} from '../shared/ipc';
import { mergeSettings, type Settings, type ThemeSetting } from '../shared/settings';
import { buildEnv, testConnection as runTestConnection, resolveClaudeBinary, taskDefaultsVersionBlock } from './claude-cli';
import { APP_NAME, dataFolder, defaultDataFolder, getStorageInfo, logFile, settingsFile, tasksFolder } from './config';
import { checkClaudeCode, fetchDistTags, updateClaudeCode } from './claude-update';
import { checkEditorCommand } from './editor';
import { detectStorageLocation } from './storage-location';
import { errorMessage, log } from './logger';
import { getSettings, saveSettings, settingsProblem } from './settings';
import type { TaskService } from './task-service';
import { applyTheme } from './theme';

function appInfo(): AppInfo {
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    paths: {
      dataFolder: dataFolder(),
      defaultDataFolder: defaultDataFolder(),
      settingsFile: settingsFile(),
      logFile: logFile(),
      tasksFolder: tasksFolder(),
      chromiumLicenses: chromiumLicensesFile(),
    },
    storage: getStorageInfo() ?? fallbackStorageInfo(),
    settingsProblem: settingsProblem(),
  };
}

/** Electron ships Chromium's and Node.js's notices next to its executable (SPEC.md §11, About). */
function chromiumLicensesFile(): string | null {
  const file = path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
  return fs.existsSync(file) ? file : null;
}

/** Only reached if appInfo is requested before startup detection ran. */
function fallbackStorageInfo(): AppInfo['storage'] {
  const env = {
    platform: process.platform,
    appData: process.env['APPDATA'],
    localAppData: process.env['LOCALAPPDATA'],
    pid: process.pid,
  };
  const location = detectStorageLocation(dataFolder(), env);
  return { dataFolder: location, settingsFolder: location, configuredAtStartup: '' };
}

async function pickPath(
  properties: ('openDirectory' | 'openFile')[],
  title: string,
  defaultPath?: string,
): Promise<PickPathResult> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = { title, properties, ...(defaultPath ? { defaultPath } : {}) };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return { canceled: result.canceled, path: result.filePaths[0] ?? null };
}

export function registerIpcHandlers(tasks: TaskService): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => appInfo());

  ipcMain.handle(IPC.settingsGet, (): Settings => getSettings());

  ipcMain.handle(IPC.settingsSave, async (_event, incoming: unknown): Promise<SaveSettingsResult> => {
    try {
      const candidate = mergeSettings(incoming);
      // The same minimum-version check a turn makes before it spawns (SPEC.md §8).
      const blocked = await taskDefaultsVersionBlock(candidate);
      if (blocked) {
        log.warn('settings.save_refused', { reason: blocked });
        return { ok: false, error: blocked };
      }
      const saved = saveSettings(candidate);
      applyTheme(saved.general.theme);
      tasks.settingsChanged();
      return { ok: true, settings: saved };
    } catch (err) {
      log.error('settings.save_failed', { error: errorMessage(err) });
      return { ok: false, error: `Settings were not saved: ${errorMessage(err)}` };
    }
  });

  ipcMain.handle(IPC.appSetTheme, (_event, theme: ThemeSetting): void => {
    // Validate: this value goes straight to nativeTheme.themeSource.
    if (theme === 'system' || theme === 'light' || theme === 'dark') applyTheme(theme);
  });

  ipcMain.handle(IPC.claudeAutoDetect, (): ClaudeBinaryInfo => {
    const settings = getSettings();
    // Auto-detect deliberately ignores the configured path: it answers "what is on PATH?".
    return resolveClaudeBinary({ ...settings, claudeCode: { ...settings.claudeCode, binaryPath: null } });
  });

  ipcMain.handle(
    IPC.claudeTestConnection,
    async (_event, binaryPathOverride: string | null): Promise<TestConnectionResult> => {
      try {
        return await runTestConnection(getSettings(), binaryPathOverride);
      } catch (err) {
        const message = errorMessage(err);
        log.error('claude.test_connection_failed', { error: message });
        return {
          ok: false,
          checkedAt: new Date().toISOString(),
          durationMs: 0,
          binary: { path: null, source: 'not-found', error: message },
          version: null,
          versionWarnings: [],
          auth: { known: false, unknownReason: 'Unknown — run `/status` in Claude Code to confirm' },
          probe: {
            ran: false,
            succeeded: false,
            requestedModel: null,
            servedModel: null,
            servedContextWindow: null,
            modelMismatch: false,
            resultText: null,
            isError: true,
            apiErrorStatus: null,
            terminalReason: null,
            durationMs: 0,
            totalCostUsd: null,
          },
          overage: { known: false },
          error: message,
        };
      }
    },
  );

  ipcMain.handle(IPC.dialogPickDirectory, (_event, title: string, defaultPath?: string) =>
    pickPath(['openDirectory'], title, defaultPath),
  );

  ipcMain.handle(IPC.dialogPickFile, (_event, title: string, defaultPath?: string) =>
    pickPath(['openFile'], title, defaultPath),
  );

  ipcMain.handle(IPC.shellOpenPath, async (_event, target: string) => {
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  // Only a mail link or a web page: never a file, a custom protocol or a command.
  ipcMain.handle(IPC.shellOpenExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^(mailto:[^\s]+|https:\/\/[^\s]+)$/i.test(url)) {
      return { ok: false, error: 'Only mailto: and https:// links can be opened.' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      log.warn('shell.open_external_failed', { url, error: errorMessage(err) });
      return { ok: false, error: `Could not open ${url}: ${errorMessage(err)}` };
    }
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 100_000) return { ok: false, error: 'Nothing to copy.' };
    clipboard.writeText(text);
    return { ok: true };
  });

  // --- tasks (SPEC.md §12 phase 4) ---
  ipcMain.handle(IPC.tasksList, () => tasks.list());
  ipcMain.handle(IPC.tasksGet, (_event, taskId: unknown) => (typeof taskId === 'string' ? tasks.get(taskId) : null));
  ipcMain.handle(IPC.tasksActivity, (_event, taskId: unknown, turnId: unknown) =>
    typeof taskId === 'string' && typeof turnId === 'string' ? tasks.activity(taskId, turnId) : null,
  );
  ipcMain.handle(IPC.tasksCreate, async (_event, request: unknown) => {
    try {
      return await tasks.create(request);
    } catch (err) {
      log.error('task.create_failed', { error: errorMessage(err) });
      return { ok: false, error: errorMessage(err) };
    }
  });
  ipcMain.handle(IPC.tasksAction, async (_event, taskId: unknown, action: unknown) => {
    if (typeof taskId !== 'string') return { ok: false, error: 'Invalid task id.' };
    try {
      return await tasks.action(taskId, action);
    } catch (err) {
      log.error('task.action_failed', { taskId, error: errorMessage(err) });
      return { ok: false, error: errorMessage(err) };
    }
  });
  ipcMain.handle(IPC.tasksChangedFiles, async (_event, taskId: unknown) => {
    const id = typeof taskId === 'string' ? taskId : '';
    try {
      return await tasks.changedFiles(id);
    } catch (err) {
      log.error('task.changed_files_failed', { taskId: id, error: errorMessage(err) });
      return { taskId: id, source: 'reports', basis: 'the changed files could not be listed', files: [], additions: 0, deletions: 0, error: errorMessage(err) };
    }
  });
  ipcMain.handle(IPC.tasksOpenFile, async (_event, taskId: unknown, relativePath: unknown) => {
    if (typeof taskId !== 'string') return { ok: false, error: 'Invalid task id.' };
    try {
      return await tasks.openFile(taskId, relativePath);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });
  ipcMain.handle(IPC.projectInspect, (_event, dir: unknown) => tasks.inspectProject(dir));
  ipcMain.handle(IPC.editorCheck, (_event, command: unknown) => checkEditorCommand(typeof command === 'string' ? command : ''));

  // Claude Code version card (SPEC.md §11). Only ever on request; nothing here runs on a timer.
  ipcMain.handle(IPC.claudeCodeCheck, async () => {
    const settings = getSettings();
    const binary = resolveClaudeBinary(settings);
    if (!binary.path) {
      return {
        checkedAt: new Date().toISOString(),
        installed: null,
        installMethod: null,
        channel: 'latest',
        channelAssumed: true,
        available: null,
        newer: null,
        error: binary.error ?? 'Claude Code was not found.',
      };
    }
    return checkClaudeCode({ binary: binary.path, env: buildEnv(settings), fetchDistTags: () => fetchDistTags(), now: () => new Date() });
  });
  ipcMain.handle(IPC.claudeCodeUpdate, async (event) => {
    const settings = getSettings();
    const binary = resolveClaudeBinary(settings);
    const startedAt = new Date().toISOString();
    if (!binary.path) {
      return { ok: false, refused: binary.error ?? 'Claude Code was not found.', blockedBy: null, startedAt, exitCode: null, output: '', before: null, after: null };
    }
    log.info('claude_code.update_requested', { binary: binary.path });
    const result = await updateClaudeCode({
      binary: binary.path,
      env: buildEnv(settings),
      busyTask: () => tasks.busyTask(),
      now: () => new Date(),
      onOutput: (chunk) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.claudeCodeUpdateOutput, chunk);
      },
    });
    log.info('claude_code.update_finished', { ok: result.ok, refused: result.refused, exitCode: result.exitCode, before: result.before, after: result.after });
    return result;
  });
  ipcMain.handle(IPC.usageGet, (_event, refresh: unknown) => tasks.usage(refresh === true));
  ipcMain.handle(IPC.accountStatus, async () => {
    try {
      return await tasks.accountStatus();
    } catch (err) {
      return { checkedAt: new Date().toISOString(), cliVersion: null, cliPath: null, reading: null, error: errorMessage(err) };
    }
  });
}
