/**
 * Electron entry point.
 *
 * contextIsolation on, nodeIntegration off, sandboxed renderer: the renderer reaches the outside
 * world only through the preload bridge (SPEC.md §2).
 *
 * In development the renderer is served by the Angular dev server; in production it is served from
 * disk through a custom protocol, because Chromium refuses ES module scripts over `file://`.
 */

import { BrowserWindow, Notification, app, dialog, protocol, screen, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APP_BRIDGE, APP_PROTOCOL, APP_SLUG, BRIDGE_ARG, DEV_SERVER_ENV, QUIT_STOP_BUDGET_ENV } from '../shared/app-config';
import { APP_NAME, appIconFile, dataFolder, defaultDataFolder, initDataFolder, notificationIconFile, setStorageInfo } from './config';
import { IPC, type TaskNoticeMessage, type TaskToast } from '../shared/ipc';
import { registerIpcHandlers } from './ipc';
import { errorMessage, log } from './logger';
import { STOP_BUDGET_MS } from './orchestrator';
import { disposeProcessGuard } from './session-runner';
import { QuitGuard } from './quit-guard';
import { getSettings, loadSettings } from './settings';
import { detectStorageLocation, type ProbeEnv } from './storage-location';
import { TaskService } from './task-service';
import { applyTheme, titleBarOverlay, watchSystemTheme, windowBackground } from './theme';
import { DEFAULT_SIZE, MIN_SIZE, readWindowState, trackWindowState, usableBounds } from './window-state';

const DEV_SERVER = process.env[DEV_SERVER_ENV] ?? null;
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer', 'browser');

/** How long Quit and stop waits for a stop to complete (SPEC.md §6). Overridable in unpackaged builds only. */
function quitStopBudget(): number {
  const override = app.isPackaged ? Number.NaN : Number(process.env[QUIT_STOP_BUDGET_ENV]);
  return Number.isFinite(override) && override > 0 ? override : STOP_BUDGET_MS;
}

app.setName(APP_NAME);
// Windows shows notifications under this id; an unpackaged build has no Start-menu entry of its own.
app.setAppUserModelId(app.isPackaged ? `com.${APP_SLUG}.app` : process.execPath);

// Keep %APPDATA%/<APP_NAME> to the SPEC.md §9 layout: Chromium's caches, local storage and GPU
// data go to the non-roaming local folder instead of sitting next to settings.json and tasks/.
if (process.env['LOCALAPPDATA']) {
  app.setPath('sessionData', path.join(process.env['LOCALAPPDATA'], APP_NAME, 'session'));
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Serve the built renderer from RENDERER_ROOT, falling back to index.html. */
function registerAppProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let target = path.join(RENDERER_ROOT, relative || 'index.html');

    // Keep the response inside the renderer folder, and fall back for client-side routes.
    if (!target.startsWith(RENDERER_ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      target = path.join(RENDERER_ROOT, 'index.html');
    }
    try {
      const body = await fs.promises.readFile(target);
      const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(body), { headers: { 'content-type': type } });
    } catch (err) {
      log.error('protocol.read_failed', { target, error: errorMessage(err) });
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Resolve the data folder and find out where writes physically land (NOTES.md §13).
 * Logged on every start so the log always says which folder this run used.
 */
function resolveStorage(configured: string): void {
  const folder = initDataFolder(configured);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    log.error('data_folder.create_failed', { folder, error: errorMessage(err) });
  }
  const env: ProbeEnv = {
    platform: process.platform,
    appData: process.env['APPDATA'],
    localAppData: process.env['LOCALAPPDATA'],
    pid: process.pid,
  };
  const dataLocation = detectStorageLocation(folder, env);
  const settingsLocation =
    folder === defaultDataFolder() ? dataLocation : detectStorageLocation(defaultDataFolder(), env);
  setStorageInfo({ dataFolder: dataLocation, settingsFolder: settingsLocation, configuredAtStartup: configured });

  log.info('storage.location', {
    dataFolder: dataLocation.path,
    physicalDataFolder: dataLocation.physicalPath,
    redirected: dataLocation.redirected,
    packageFamily: dataLocation.packageFamily,
    method: dataLocation.method,
    settingsFolder: settingsLocation.path,
    physicalSettingsFolder: settingsLocation.physicalPath,
    sessionData: app.getPath('sessionData'),
    // Recorded for comparison only: this does NOT detect the redirected case (NOTES.md §13).
    windowsStore: process.windowsStore ?? false,
  });
  if (dataLocation.redirected || settingsLocation.redirected) {
    log.warn('storage.redirected', { detail: dataLocation.detail ?? settingsLocation.detail });
  }
}

function broadcast(message: TaskNoticeMessage): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.tasksNotice, message);
  }
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

/** Notifications must stay referenced until they are dismissed, or a click is lost. */
const liveNotifications = new Set<Notification>();

/**
 * SPEC.md §10: while the window has focus the app shows its own toast; otherwise Windows does, and a
 * click brings the window forward with that task open.
 */
function showTaskToast(toast: TaskToast, sound: boolean): void {
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) {
    broadcast({ type: 'toast', toast });
    return;
  }
  const notification = new Notification({ title: toast.title, body: toast.body, silent: !sound, icon: notificationIconFile() });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('show', () => log.info('notify.shown', { taskId: toast.taskId, title: toast.title }));
  notification.on('failed', (_event, error) => {
    release();
    log.warn('notify.failed', { taskId: toast.taskId, error });
    broadcast({ type: 'toast', toast });
  });
  notification.on('click', () => {
    release();
    const window = mainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    log.info('notify.clicked', { taskId: toast.taskId });
    broadcast({ type: 'open_task', taskId: toast.taskId });
  });
  notification.on('close', release);
  notification.show();
}

function createWindow(guard: QuitGuard): void {
  const saved = readWindowState();
  const bounds = usableBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
  const window = new BrowserWindow({
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: APP_NAME,
    icon: appIconFile(),
    // Matches the resolved theme so there is no dark flash before a light page paints.
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    // SPEC.md §10: our header *is* the title bar. 'hidden' + an overlay keeps Windows' own caption
    // buttons — and with them snap layouts, the hover states and high contrast — while everything
    // left of them is ours to draw. NOTES.md §31 has the comparison with a fully frameless window.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`${BRIDGE_ARG}${APP_BRIDGE}`],
    },
  });

  if (saved?.maximized) window.maximize();
  trackWindowState(window);

  /**
   * NOTES.md §31: with `titleBarStyle: 'hidden'` the first frame of a window that is still hidden
   * does not always reach the compositor, and `ready-to-show` then never fires — the app starts
   * with a window nobody can see. The page finishing its load is the backstop; `backgroundColor`
   * is already the theme's, so showing a moment early costs a frame of empty chrome, not a flash.
   */
  const reveal = (why: string) => {
    if (window.isDestroyed() || window.isVisible()) return;
    window.show();
    log.info('window.shown', { why });
  };
  window.once('ready-to-show', () => reveal('ready-to-show'));
  window.webContents.once('did-finish-load', () => setTimeout(() => reveal('did-finish-load'), 150));
  // Closing the window quits the app: ask first while a task is mid-turn (SPEC.md §6).
  window.on('close', (event) => guard.onQuitRequest(event));

  // Never let the app navigate itself somewhere else; open real links in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER);
  } else {
    void window.loadURL(`${APP_PROTOCOL}://app/index.html`);
  }

  log.info('window.created', { dev: DEV_SERVER !== null });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  void app.whenReady().then(() => {
    try {
      fs.mkdirSync(defaultDataFolder(), { recursive: true });
    } catch (err) {
      log.error('data_folder.create_failed', { folder: defaultDataFolder(), error: errorMessage(err) });
    }
    const settings = loadSettings();
    resolveStorage(settings.general.dataFolder);
    // Theme must be applied before the window exists, so the first paint is already correct.
    applyTheme(settings.general.theme);
    watchSystemTheme();
    registerAppProtocol();
    const tasks = new TaskService({
      getSettings,
      send: broadcast,
      notify: (toast, { sound }) => showTaskToast(toast, sound),
      // Delete moves a task's folder to the Recycle Bin, never erases it (SPEC.md §10).
      trash: (folder) => shell.trashItem(folder),
    });
    tasks.init();
    registerIpcHandlers(tasks);

    // Quitting while a turn runs asks first; "Quit and stop" waits until the task is saved as `stopped`
    // (SPEC.md §6).
    const budgetMs = quitStopBudget();
    const guard = new QuitGuard({
      busyTask: () => tasks.busyTask(),
      confirm: async (question) => {
        const window = mainWindow();
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          title: APP_NAME,
          message: question,
          detail: 'Quit and stop ends the current turn, waits until it has stopped, and keeps the task as stopped. Resume continues it the next time you open the app.',
          buttons: ['Cancel', 'Quit and stop'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        return response === 1;
      },
      showStopping: (stopping) => {
        const window = mainWindow();
        if (window && stopping.length > 0) {
          if (window.isMinimized()) window.restore();
          window.show();
        }
        broadcast({ type: 'quitting', stopping: [...stopping], budgetMs });
      },
      stopAll: (budget) => tasks.stopAll(budget),
      confirmQuitAnyway: async (question) => {
        const window = mainWindow();
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          title: APP_NAME,
          message: question,
          detail:
            'Its turn has been told to stop, but has not finished stopping yet. Quit anyway ends whatever is still running for it when the app exits; the task opens as stopped next time, and Resume continues from its last saved step.',
          buttons: ['Keep waiting', 'Quit anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        return response === 1;
      },
      quit: () => {
        tasks.dispose();
        app.quit();
      },
      log: (event, data) => log.info(event, data ?? {}),
    }, budgetMs);
    app.on('before-quit', (event) => guard.onQuitRequest(event));
    createWindow(guard);
    log.info('app.ready', { version: app.getVersion(), dataFolder: dataFolder() });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(guard);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Closing the job helper makes Windows kill anything still inside a turn's job (SPEC.md §5 net 9).
  app.on('will-quit', () => disposeProcessGuard());
}
