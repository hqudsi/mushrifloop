/**
 * The typed IPC contract — the only way the renderer reaches the outside world.
 *
 * SPEC.md §2: the renderer never spawns processes and never touches the filesystem.
 * Every capability it has is a method on this interface, exposed on `window` under APP_BRIDGE
 * by src/preload/preload.ts.
 */

import type { ApprovalMode, Settings, ThemeSetting } from './settings';
import type {
  AgentRole,
  AuthReading,
  ConfigUpdate,
  LiveTurnEvent,
  PinnedAccount,
  TaskConfig,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  WaitingState,
} from './task-model';
import type { TurnActivity } from './turn-activity';

export const IPC = {
  appInfo: 'app:info',
  appSetTheme: 'app:set-theme',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  claudeAutoDetect: 'claude:auto-detect',
  claudeTestConnection: 'claude:test-connection',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickFile: 'dialog:pick-file',
  shellOpenPath: 'shell:open-path',
  shellOpenExternal: 'shell:open-external',
  clipboardWrite: 'clipboard:write',
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksActivity: 'tasks:activity',
  tasksCreate: 'tasks:create',
  tasksAction: 'tasks:action',
  accountStatus: 'account:status',
  tasksChangedFiles: 'tasks:changed-files',
  tasksOpenFile: 'tasks:open-file',
  projectInspect: 'project:inspect',
  editorCheck: 'editor:check',
  claudeCodeCheck: 'claude-code:check',
  claudeCodeUpdate: 'claude-code:update',
  /** main → renderer push channel: `claude update` output as it arrives. */
  claudeCodeUpdateOutput: 'claude-code:update-output',
  appUpdateCheck: 'app-update:check',
  usageGet: 'usage:get',
  /** main → renderer push channel for task updates (see `onTaskNotice`). */
  tasksNotice: 'tasks:notice',
} as const;

/**
 * Where the app actually writes (src/main/storage-location.ts). Inside an MSIX container,
 * Windows redirects %APPDATA% writes to the package's LocalCache — see NOTES.md §13.
 */
export interface StorageLocation {
  /** The path the app addresses. */
  path: string;
  /** Where the bytes physically land. Equal to `path` unless redirected. */
  physicalPath: string;
  redirected: boolean;
  /** The package whose container redirected the write, e.g. `Claude_pzs8sxrjxfjjc`. */
  packageFamily: string | null;
  /** probe = authoritative; not-applicable = cannot be redirected; probe-failed = unknown. */
  method: 'probe' | 'not-applicable' | 'probe-failed';
  detail?: string;
}

export interface StorageInfo {
  /** Folder for tasks, usage and the log — resolved once at startup. */
  dataFolder: StorageLocation;
  /** Folder holding settings.json — always the default location, so the app can find it. */
  settingsFolder: StorageLocation;
  /** `general.dataFolder` as it was when this process started; a different saved value needs a restart. */
  configuredAtStartup: string;
}

export interface AppInfo {
  appName: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  /** e.g. "Windows_NT 10.0.26200 x64", for diagnostics. */
  os: string;
  paths: {
    dataFolder: string;
    defaultDataFolder: string;
    settingsFile: string;
    logFile: string;
    tasksFolder: string;
    /** Chromium's and Node.js's license notices, shipped next to the Electron executable; null if absent. */
    chromiumLicenses: string | null;
  };
  storage: StorageInfo;
  /**
   * settings.json exists but could not be read, so the app runs on defaults (SPEC.md §9). The file is left
   * as it is; the first save keeps a copy at `backup` first.
   */
  settingsProblem: SettingsProblem | null;
}

export interface SettingsProblem {
  file: string;
  error: string;
  /** Where the unreadable file is copied before the first save overwrites it. */
  backup: string;
}

export type SaveSettingsResult = { ok: true; settings: Settings } | { ok: false; error: string };

/** Where the `claude` binary came from (SPEC.md §3.2). */
export type ClaudeBinarySource = 'setting' | 'path' | 'not-found';

export interface ClaudeBinaryInfo {
  /** Absolute path to the real executable, with npm `.cmd` shims already resolved. */
  path: string | null;
  source: ClaudeBinarySource;
  /** Present when the shim was resolved to a different file, for display. */
  resolvedFrom?: string;
  error?: string;
}

/** Parsed `claude auth status --json` (SPEC.md §3.3). Extra CLI fields are ignored. */
export interface ClaudeAuthInfo {
  known: boolean;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  apiKeySource?: string;
  email?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
  /** Shown verbatim when auth mode cannot be determined (SPEC.md §3.3). */
  unknownReason?: string;
}

/** Overage behaviour for this account, from the probe's `rate_limit_event` (SPEC.md §3.3/§17). */
export interface ClaudeOverageInfo {
  known: boolean;
  status?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  rateLimitType?: string;
  /** Epoch seconds. */
  resetsAt?: number;
  isUsingOverage?: boolean;
}

export interface ClaudeProbeInfo {
  ran: boolean;
  succeeded: boolean;
  /** null when the probe used the account's default model. */
  requestedModel: string | null;
  /** Model that actually served the request, from `modelUsage` (SPEC.md §8). */
  servedModel: string | null;
  servedContextWindow: number | null;
  /** True when the CLI served a different model than the one requested. */
  modelMismatch: boolean;
  resultText: string | null;
  isError: boolean;
  apiErrorStatus: number | null;
  terminalReason: string | null;
  errorText?: string;
  durationMs: number;
  totalCostUsd: number | null;
}

export interface TestConnectionResult {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  binary: ClaudeBinaryInfo;
  version: string | null;
  /** Below MIN_CLI_VERSION, or otherwise notable (SPEC.md §3.2). */
  versionWarnings: string[];
  auth: ClaudeAuthInfo;
  probe: ClaudeProbeInfo;
  overage: ClaudeOverageInfo;
  /** Populated when the test could not complete at all. */
  error?: string;
}

export interface PickPathResult {
  canceled: boolean;
  path: string | null;
}

// ---------------------------------------------------------------------------
// Tasks (Phase 4)
// ---------------------------------------------------------------------------

/** One row of the task list (SPEC.md §10). */
export interface TaskSummary {
  id: string;
  /** What the task is shown by: its name, else the first line of the description (SPEC.md §10). */
  title: string;
  /** The name the user gave it, if any. */
  name: string | null;
  projectDir: string;
  projectName: string;
  status: TaskStatus;
  statusReason: string | null;
  waitingKind: WaitingState['kind'] | null;
  cycles: number;
  maxCycles: number;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  /** A turn (or setup) of this task is running right now. */
  busy: boolean;
  pinned: Pick<PinnedAccount, 'email' | 'orgName' | 'subscriptionType'>;
  planner: string;
  executor: string;
  /** The task's files could not be read (SPEC.md §9): the error. The other fields are placeholders. */
  unreadable: string | null;
}

export interface TaskDetail {
  task: TaskRecord;
  events: TaskEvent[];
  busy: boolean;
}

/** `getTask` for a task whose files cannot be read (SPEC.md §9). */
export interface TaskLoadFailure {
  unreadable: true;
  taskId: string;
  folder: string;
  error: string;
}

/** Everything the user can do to a task from the main screen. Validated in the main process. */
export type TaskAction =
  | { kind: 'start' }
  | { kind: 'pause' }
  | { kind: 'stop' }
  | { kind: 'resume' }
  | { kind: 'answer'; text: string }
  /** SPEC.md §6: every message goes to the Planner; there is no recipient to choose. */
  | { kind: 'send'; text: string }
  | { kind: 'waive_skill'; skill: string; note?: string }
  | { kind: 'decline_waiver'; text: string }
  /** Review mode (SPEC.md §7): send the pending instruction, optionally edited. */
  | { kind: 'approve_instruction'; edited?: string }
  | { kind: 'reject_instruction'; reason: string }
  /** plan_first (SPEC.md §7): approve the plan, optionally edited; the task then runs as auto. */
  | { kind: 'approve_plan'; edited?: string }
  | { kind: 'reject_plan'; reason: string }
  /** Applies to new sessions only (SPEC.md §6). */
  | { kind: 'set_standing_instructions'; agent: AgentRole; text: string }
  /** "Roll over now" (SPEC.md §15): before that agent's next turn. */
  | { kind: 'rollover_now'; agent: AgentRole }
  /** Applies from the Planner's next instruction (SPEC.md §7). */
  | { kind: 'set_approval_mode'; mode: ApprovalMode }
  /** "Task settings" on a task under way (SPEC.md §6). */
  | { kind: 'update_config'; update: ConfigUpdate }
  /** Give the task a name, or remove it with an empty title (SPEC.md §10). Any status. */
  | { kind: 'rename'; title: string };

/** The task that made a command wait: tasks run one at a time (SPEC.md §6, §13). */
export interface BlockingTask {
  taskId: string;
  title: string;
}

export interface ActionResult {
  ok: boolean;
  /** The raw message, when not ok. */
  error?: string;
  /** What to do about it, when known. */
  nextStep?: string;
  taskId?: string;
  /** Set when the command was refused because another task is running (named and linked in the UI). */
  blockedBy?: BlockingTask;
}

export interface CreateTaskRequest {
  description: string;
  projectDir: string;
  /** Per-task overrides of the Task defaults (SPEC.md §11). */
  overrides?: Partial<TaskConfig>;
  /** Start the loop right away. */
  start?: boolean;
}

/** One Claude account seen on this machine (SPEC.md §10, first run; NOTES.md §6). */
export interface SeenAccount {
  /** The e-mail, or "API key (…)" when that is all the CLI reports. */
  label: string;
  organisation: string | null;
  plan: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** The live Claude Code account and CLI, read afresh on every call (SPEC.md §3.3, §10). */
/** Settings → Claude Code connection → "Claude Code version" (SPEC.md §11): Claude Code, never the app. */
export interface ClaudeCodeVersionInfo {
  checkedAt: string;
  /** `claude --version`. */
  installed: string | null;
  /** As Claude Code reports it in `claude doctor`, e.g. "npm-global". Null when doctor could not be read. */
  installMethod: string | null;
  /** The release channel whose newest version is compared: "latest" or "stable". */
  channel: string;
  /** True when doctor did not say, so `latest` was assumed. */
  channelAssumed: boolean;
  /** The newest published version on that channel (npm dist-tags). */
  available: string | null;
  /** Null when either version could not be read. */
  newer: boolean | null;
  error: string | null;
}

/** Settings → General → "New MushrifLoop versions" (SPEC.md §11): the app itself, never Claude Code. */
export interface AppUpdateInfo {
  checkedAt: string;
  /** The running app's version. */
  current: string;
  /** The latest published release's version. Null when it could not be read. */
  latest: string | null;
  /** Null when the latest version could not be read. */
  newer: boolean | null;
  /** The release page Download opens: always a page of the app's repository. */
  url: string;
  publishedAt: string | null;
  error: string | null;
}

/** The outcome of pressing "Update Claude Code" (SPEC.md §11). */
export interface ClaudeCodeUpdateResult {
  ok: boolean;
  /** Set when the update was not run at all, and why. */
  refused: string | null;
  blockedBy: { taskId: string; title: string } | null;
  startedAt: string;
  exitCode: number | null;
  /** Everything `claude update` printed, stdout and stderr together. */
  output: string;
  /** The installed version before and after. */
  before: string | null;
  after: string | null;
  error?: string;
}

/** The answer behind Settings → General → "Detect" and the same button in first-run setup. */
export interface EditorCheckResult {
  ok: boolean;
  /** The first word of the command line, as typed. */
  program: string | null;
  /** Where it was found, when it was. */
  path: string | null;
  /** Why it was not, in words the user can act on. */
  error: string | null;
}

export interface AccountStatus {
  checkedAt: string;
  cliVersion: string | null;
  cliPath: string | null;
  reading: AuthReading | null;
  /** The CLI could not be found or started. */
  error: string | null;
  /**
   * The account changed between readings and the CLI's own answer was not yet consistent, so the plan
   * must be shown as unknown rather than as a number (SPEC.md §10, the mid-switch guard).
   */
  planUncertain: boolean;
  /**
   * Every account seen on this machine, most recently seen first. More than one means the shared
   * credentials file has switched accounts here, which first-run setup says out loud (SPEC.md §10).
   */
  seenAccounts: SeenAccount[];
}

/** A notification about a task (SPEC.md §10): shown in the app while the window has focus, by Windows otherwise. */
export interface TaskToast {
  taskId: string;
  /** Which Settings → General → Notifications toggle governs it. */
  category: 'waiting' | 'finished' | 'cycle';
  /** How it looks: needs the user, finished well, stopped badly, or plain news. */
  tone: 'wait' | 'done' | 'bad' | 'info';
  title: string;
  body: string;
  at: string;
}

/** Pushed from the main process whenever something about a task changes. */
export type TaskNoticeMessage =
  | { type: 'event'; taskId: string; event: TaskEvent }
  | { type: 'turn_event'; taskId: string; turnId: string; agent: AgentRole; seq: number; event: LiveTurnEvent }
  | { type: 'task'; summary: TaskSummary; task: TaskRecord; busy: boolean }
  | { type: 'toast'; toast: TaskToast }
  /** A Windows notification was clicked: show this task. */
  | { type: 'open_task'; taskId: string }
  /**
   * Quit and stop (SPEC.md §6): the app waits for these tasks to stop before it exits. An empty list
   * hides the notice.
   */
  | { type: 'quitting'; stopping: BlockingTask[]; budgetMs: number };

/** One file the task changed (right panel, SPEC.md §10). */
export interface ChangedFile {
  /** Relative to the project folder, forward slashes. */
  path: string;
  name: string;
  /** Folder part of `path`, '' at the root. */
  dir: string;
  status: 'A' | 'M' | 'D' | 'R';
  /** null when unknown (binary file, or taken from the Executor's reports). */
  additions: number | null;
  deletions: number | null;
}

export interface ChangedFiles {
  taskId: string;
  /** `git`: diffed against the task's starting point; `reports`: the Executor's own lists (no git). */
  source: 'git' | 'reports';
  /** What was compared, in words. */
  basis: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  error: string | null;
}

/** What the New task dialog shows under the folder (design: "git · main · clean working tree"). */
export interface ProjectInspection {
  path: string;
  exists: boolean;
  isRepo: boolean;
  branch: string | null;
  hasRemote: boolean;
  /** Uncommitted paths (they would go into the snapshot commit, SPEC.md §18). */
  dirtyCount: number;
  error: string | null;
}

/** One plan window as Claude Code reports it (`rate_limit_event.unifiedWindows`, SPEC.md §17). */
export interface UsageWindow {
  key: string;
  label: string;
  /** Fraction 0…1, as reported. */
  utilization: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
  /** When this window was last reported, by a turn or by `/usage`. */
  reportedAt: string | null;
}

export interface UsageReport {
  /** The newest reading of any window, from a turn or from `/usage`; null if never. */
  reportedAt: string | null;
  windows: UsageWindow[];
  /** Local token estimate from usage.json — an estimate, never the official quota. */
  estimate: { today: number; last7Days: number };
  /** When `/usage` last ran, and what went wrong if it failed (SPEC.md §17: a failed refresh is never silent). */
  checkedAt: string | null;
  checkError: string | null;
  /** A task is running, so `/usage` was not run (SPEC.md §17: only between turns). */
  refreshSkipped: boolean;
  /** usage.json could not be read: what happened to it (SPEC.md §9). */
  ledgerError: string | null;
}

export type { TurnActivity };

export interface AppApi {
  getAppInfo(): Promise<AppInfo>;
  /**
   * Apply a theme to the native layer (title bar, scrollbars, `prefers-color-scheme`) without
   * saving it — used to preview the draft. Startup and save apply the stored value themselves.
   */
  setTheme(theme: ThemeSetting): Promise<void>;
  getSettings(): Promise<Settings>;
  /** Stores what it accepted (values are coerced), or refuses with the reason. */
  saveSettings(settings: Settings): Promise<SaveSettingsResult>;
  autoDetectClaude(): Promise<ClaudeBinaryInfo>;
  /** Runs the real CLI (SPEC.md §3.3). `binaryPathOverride` tests an unsaved path field. */
  testConnection(binaryPathOverride?: string | null): Promise<TestConnectionResult>;
  pickDirectory(title: string, defaultPath?: string): Promise<PickPathResult>;
  pickFile(title: string, defaultPath?: string): Promise<PickPathResult>;
  openPath(target: string): Promise<{ ok: boolean; error?: string }>;
  /** A `mailto:` or `https://` link, handed to the system (mail program, browser). Anything else is refused. */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  /** Put text on the system clipboard (Settings → About → Copy diagnostics). */
  copyText(text: string): Promise<{ ok: boolean; error?: string }>;

  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail | TaskLoadFailure | null>;
  /**
   * What a turn did (tool calls, commands, files): live for the running turn, from its raw file
   * otherwise. `seq` tells which live events are already included; `error` says why it could not be read.
   */
  getTurnActivity(taskId: string, turnId: string): Promise<TurnActivity>;
  createTask(request: CreateTaskRequest): Promise<ActionResult>;
  taskAction(taskId: string, action: TaskAction): Promise<ActionResult>;
  getAccountStatus(): Promise<AccountStatus>;
  /** Files the task changed, with line counts when git is in use. */
  getChangedFiles(taskId: string): Promise<ChangedFiles>;
  /** Open a project file with Settings → General → Editor command. */
  openTaskFile(taskId: string, relativePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Git state of a folder, for the New task dialog. */
  inspectProject(dir: string): Promise<ProjectInspection>;
  /**
   * Does the "Open files with" command resolve to a real program? Nothing is run — the program is
   * only looked for on disk (SPEC.md §11).
   */
  checkEditor(command: string): Promise<EditorCheckResult>;
  /** Is a newer Claude Code published on its channel? Reads only; spends no quota (SPEC.md §11). */
  checkClaudeCode(): Promise<ClaudeCodeVersionInfo>;
  /** Run `claude update`. Only ever from the button; refused while a task is running (SPEC.md §11). */
  updateClaudeCode(): Promise<ClaudeCodeUpdateResult>;
  /**
   * Is a newer MushrifLoop published? Reads only; never downloads (SPEC.md §11). `automatic` is the start and
   * daily check: it answers null, asking nothing, while the setting is off. Check now passes false.
   */
  checkAppUpdate(automatic: boolean): Promise<AppUpdateInfo | null>;
  /** `claude update` output as it arrives. Returns the unsubscribe function. */
  onClaudeCodeUpdateOutput(listener: (chunk: string) => void): () => void;
  /** Plan utilization and the local estimate; `refresh` runs `/usage` when no task is running. */
  getUsage(refresh: boolean): Promise<UsageReport>;
  /** Subscribe to task updates. Returns the unsubscribe function. */
  onTaskNotice(listener: (notice: TaskNoticeMessage) => void): () => void;
}
