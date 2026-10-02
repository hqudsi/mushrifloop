/**
 * The single definition of the application name.
 *
 * The name (SPEC.md header). Everything user-visible or path-related derives from here: window
 * title, %APPDATA% folder, log file, notifications, branch and commit prefixes, the Executor's scratch
 * folder, localStorage keys, environment variables and the preload bridge. The only other place the literal appears is
 * `package.json` ("name"), which npm requires; the app name Electron uses is set from here at startup.
 */
export const APP_NAME = 'MushrifLoop';

/** One line under the name in Settings → About (SPEC.md §11). */
export const APP_TAGLINE = 'A supervised Planner–Executor orchestrator for Claude Code.';

/** Settings → About (SPEC.md §11). */
export const APP_DEVELOPER = { name: 'Hani Qudsi', email: 'hani.a.qudsi@gmail.com' } as const;
/** The public repository, and where a problem is reported (SPEC.md §11). */
export const APP_REPO_URL = 'https://github.com/hqudsi/mushrifloop';
export const APP_ISSUES_URL = `${APP_REPO_URL}/issues`;
export const APP_LICENSE = 'Apache License 2.0';
export const APP_COPYRIGHT = `© 2026 ${APP_DEVELOPER.name}. Licensed under the ${APP_LICENSE}.`;

/** Lowercase, filesystem/protocol-safe form of {@link APP_NAME}. */
export const APP_SLUG = APP_NAME.toLowerCase();

/** Custom protocol used to serve the built renderer in production (see src/main/main.ts). */
export const APP_PROTOCOL = APP_SLUG;

/** The `window` property the preload script exposes the IPC bridge under. */
export const APP_BRIDGE = APP_SLUG;

/**
 * How main tells the sandboxed preload script the bridge name: a sandboxed preload cannot import this
 * module, so the name travels as a command-line switch (`webPreferences.additionalArguments`).
 */
export const BRIDGE_ARG = '--app-bridge=';

/** Prefix of the app's environment variables. */
export const APP_ENV_PREFIX = APP_SLUG.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** Development: the Angular dev server URL that `npm run dev` hands to Electron. */
export const DEV_SERVER_ENV = `${APP_ENV_PREFIX}_DEV_SERVER`;

/**
 * Unpackaged builds only: replaces the quit-and-stop wait (milliseconds), so the "did not stop in time"
 * dialog can be exercised without a process that refuses to die. Ignored in a packaged app.
 */
export const QUIT_STOP_BUDGET_ENV = `${APP_ENV_PREFIX}_QUIT_STOP_BUDGET_MS`;

/** A key in the renderer's localStorage. */
export function storageKey(name: string): string {
  return `${APP_SLUG}.${name}`;
}
