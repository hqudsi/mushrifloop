/**
 * Settings shape, defaults and merge — SPEC.md §11.
 *
 * Pure: no Node, no Electron. The main process owns reading/writing the file (src/main/settings.ts);
 * this module owns what a valid settings object *is*, so it can be unit-tested without Electron.
 */

import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_PLANNER_EFFORT,
  DEFAULT_PLANNER_MODEL,
  coerceEffort,
  getModel,
  type EffortLevel,
} from './models';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type ApprovalMode = 'auto' | 'review' | 'plan_first';
export type PlannerContextMode = 'isolated' | 'read_only';
/** SPEC.md §3.1: `dontAsk` is the default; `bypassPermissions` is the warned escape hatch. */
export type PermissionMode = 'dontAsk' | 'bypassPermissions';

export interface NotificationSettings {
  waitingForInput: boolean;
  finishedOrFailed: boolean;
  everyCompletedCycle: boolean;
  sound: boolean;
}

export interface GeneralSettings {
  theme: ThemeSetting;
  /** Empty = the default %APPDATA%/<APP_NAME> folder. */
  dataFolder: string;
  notifications: NotificationSettings;
  /** Command used by "open file" (SPEC.md §2). */
  editorCommand: string;
  /** Optional soft cap (SPEC.md §17). null = off. */
  softDailyTokenCap: number | null;
  autoResumeAtReset: boolean;
  /**
   * SPEC.md §10: first-run setup has been completed. False on a fresh install — and in a settings
   * file written before setup existed, which is the right answer for it too.
   */
  setupCompleted: boolean;
}

export interface StandingPrompts {
  planner: string;
  executor: string;
}

export interface TaskDefaultSettings {
  plannerModel: string;
  plannerEffort: EffortLevel | null;
  executorModel: string;
  executorEffort: EffortLevel | null;
  maxCycles: number;
  turnTimeoutMinutes: number;
  /** Soft limit: a longer turn is marked "slow turn" and the planner is told (SPEC.md §5 net 8). */
  slowTurnWarningMinutes: number;
  /**
   * "Max steps per turn": passed as `--max-turns` on every launch, so it caps one turn, not the session
   * (SPEC.md §3.1). The key keeps its old name so existing settings and task files still load.
   */
  maxTurnsPerSession: number;
  approvalMode: ApprovalMode;
  /** Fixed at task creation; cannot change mid-task (SPEC.md §3.1). */
  plannerContextMode: PlannerContextMode;
  standingPrompts: StandingPrompts;
  /** SPEC.md §15: rollover at this percentage of the model's auto-compact threshold. */
  rolloverPercent: number;
  /**
   * SPEC.md §15: start a fresh Executor session after this many consecutive Executor turns with refused
   * answers (§3.5). null = off (the default); 2 when switched on.
   */
  freshExecutorAfterRejectedTurns: number | null;
  /** SPEC.md §16. */
  requiredSkillsBeforeDone: string[];
  /** SPEC.md §18. */
  autoBranchAndCommit: boolean;
}

export interface ClaudeCodeSettings {
  /** null = auto-detect from PATH (SPEC.md §3.2). */
  binaryPath: string | null;
  /** Executor tool list: both the `--tools` restriction and the `--allowedTools` allowlist (SPEC.md §3.1). */
  executorTools: string[];
  executorDisallowedTools: string[];
  permissionMode: PermissionMode;
  /** SPEC.md §3.2: when false, all ANTHROPIC_* vars are stripped from the spawned environment. */
  allowApiKeyBilling: boolean;
  /** Advanced: CLAUDE_CODE_MAX_RETRIES. null = leave unset (SPEC.md §3.2). */
  maxRetries: number | null;
}

export interface Settings {
  version: 1;
  /**
   * The defaults revision this file has been reconciled with (SPEC.md §11, "Defaults after an update"). A file
   * written before revisions existed counts as 1; a new install starts at `DEFAULTS_REVISION`.
   */
  defaultsRevision: number;
  general: GeneralSettings;
  taskDefaults: TaskDefaultSettings;
  claudeCode: ClaudeCodeSettings;
}

/** SPEC.md §3.1 — the Windows default executor tool list. */
export const DEFAULT_EXECUTOR_TOOLS: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'Skill',
];

/** The three approval modes, with the one line each that Settings and first-run setup both show. */
export const APPROVAL_MODES: readonly { id: ApprovalMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Runs unattended; stops only on questions, limits or errors.' },
  { id: 'review', label: 'Review', hint: 'Every Planner instruction is shown before it reaches the Executor.' },
  { id: 'plan_first', label: 'Plan first', hint: 'Approve a full plan once, then the task runs in Auto.' },
];

export const SETTINGS_VERSION = 1 as const;

/** The current defaults revision: one more whenever a release changes a default (SPEC.md §11). */
export const DEFAULTS_REVISION = 2;

/** A setting a defaults change can touch. Only Task defaults have changed so far. */
export type DefaultChangeField = 'maxCycles' | 'turnTimeoutMinutes' | 'slowTurnWarningMinutes' | 'maxTurnsPerSession' | 'plannerContextMode';
export type DefaultValue = number | string;

export interface DefaultChange {
  /** The revision that made the change. */
  revision: number;
  field: DefaultChangeField;
  label: string;
  from: DefaultValue;
  to: DefaultValue;
}

/**
 * Every change to a default, oldest first (SPEC.md §11). A file behind the current revision is offered the
 * changes after its own, and nothing is applied without the user.
 */
export const DEFAULT_CHANGES: readonly DefaultChange[] = [
  { revision: 2, field: 'maxCycles', label: 'Max cycles', from: 25, to: 100 },
  { revision: 2, field: 'turnTimeoutMinutes', label: 'Turn timeout', from: 20, to: 60 },
  { revision: 2, field: 'slowTurnWarningMinutes', label: 'Slow-turn warning', from: 5, to: 30 },
  { revision: 2, field: 'maxTurnsPerSession', label: 'Max steps per turn', from: 40, to: 80 },
  { revision: 2, field: 'plannerContextMode', label: 'Planner context mode', from: 'isolated', to: 'read_only' },
];

/** "Fresh Executor session after N turns with rejected answers" (SPEC.md §15): N when switched on, and its range. */
export const FRESH_EXECUTOR_DEFAULT_TURNS = 2;
export const FRESH_EXECUTOR_MAX_TURNS = 10;

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    defaultsRevision: DEFAULTS_REVISION,
    general: {
      // Follows the Windows app theme live; Light/Dark are explicit overrides (SPEC.md §10).
      theme: 'system',
      dataFolder: '',
      notifications: {
        waitingForInput: true,
        finishedOrFailed: true,
        everyCompletedCycle: false,
        sound: false,
      },
      editorCommand: 'code',
      softDailyTokenCap: null,
      autoResumeAtReset: false,
      setupCompleted: false,
    },
    taskDefaults: {
      plannerModel: DEFAULT_PLANNER_MODEL,
      plannerEffort: DEFAULT_PLANNER_EFFORT,
      executorModel: DEFAULT_EXECUTOR_MODEL,
      executorEffort: DEFAULT_EXECUTOR_EFFORT,
      maxCycles: 100,
      turnTimeoutMinutes: 60,
      slowTurnWarningMinutes: 30,
      maxTurnsPerSession: 80,
      approvalMode: 'review',
      // Read-only since 2026-09-26: the Planner reads the project itself (SPEC.md §3.1, §11).
      plannerContextMode: 'read_only',
      standingPrompts: { planner: '', executor: '' },
      rolloverPercent: 60,
      freshExecutorAfterRejectedTurns: null,
      requiredSkillsBeforeDone: ['security-review'],
      autoBranchAndCommit: true,
    },
    claudeCode: {
      binaryPath: null,
      executorTools: [...DEFAULT_EXECUTOR_TOOLS],
      executorDisallowedTools: [],
      permissionMode: 'dontAsk',
      allowApiKeyBilling: false,
      maxRetries: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Coercion helpers: a settings file edited by hand (or written by an older build)
// must never crash the app or produce an invalid CLI invocation.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickNullableInt(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
  return Array.from(new Set(cleaned));
}

/** A known model id, or the default when the stored one is unknown (e.g. a removed model). */
function pickModel(value: unknown, fallback: string): string {
  return typeof value === 'string' && getModel(value) ? value : fallback;
}

/**
 * Merge stored settings over the defaults.
 *
 * Unknown keys are dropped, missing keys fall back to defaults, and every value is coerced
 * into range — including model/effort pairs, which are forced to a combination SPEC.md §8 allows.
 */
export function mergeSettings(stored: unknown): Settings {
  const d = defaultSettings();
  if (!isRecord(stored)) return d;

  const general = isRecord(stored['general']) ? stored['general'] : {};
  const notifications = isRecord(general['notifications']) ? general['notifications'] : {};
  const taskDefaults = isRecord(stored['taskDefaults']) ? stored['taskDefaults'] : {};
  const standingPrompts = isRecord(taskDefaults['standingPrompts']) ? taskDefaults['standingPrompts'] : {};
  const claudeCode = isRecord(stored['claudeCode']) ? stored['claudeCode'] : {};

  const plannerModel = pickModel(taskDefaults['plannerModel'], d.taskDefaults.plannerModel);
  const executorModel = pickModel(taskDefaults['executorModel'], d.taskDefaults.executorModel);

  const rawPlannerEffort = pickEnum(
    taskDefaults['plannerEffort'],
    ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    d.taskDefaults.plannerEffort ?? 'high',
  );
  const rawExecutorEffort = pickEnum(
    taskDefaults['executorEffort'],
    ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    d.taskDefaults.executorEffort ?? 'high',
  );

  const binaryPathRaw = claudeCode['binaryPath'];
  const binaryPath =
    typeof binaryPathRaw === 'string' && binaryPathRaw.trim().length > 0 ? binaryPathRaw.trim() : null;

  return {
    version: SETTINGS_VERSION,
    // No revision means a file written by v1.0–v1.1 (SPEC.md §11).
    defaultsRevision: pickInt(stored['defaultsRevision'], 1, 1, DEFAULTS_REVISION),
    general: {
      theme: pickEnum(general['theme'], ['dark', 'light', 'system'] as const, d.general.theme),
      dataFolder: pickString(general['dataFolder'], d.general.dataFolder),
      notifications: {
        waitingForInput: pickBoolean(notifications['waitingForInput'], d.general.notifications.waitingForInput),
        finishedOrFailed: pickBoolean(notifications['finishedOrFailed'], d.general.notifications.finishedOrFailed),
        everyCompletedCycle: pickBoolean(
          notifications['everyCompletedCycle'],
          d.general.notifications.everyCompletedCycle,
        ),
        sound: pickBoolean(notifications['sound'], d.general.notifications.sound),
      },
      editorCommand: pickString(general['editorCommand'], d.general.editorCommand),
      softDailyTokenCap: pickNullableInt(general['softDailyTokenCap'], d.general.softDailyTokenCap, 1, 1_000_000_000),
      autoResumeAtReset: pickBoolean(general['autoResumeAtReset'], d.general.autoResumeAtReset),
      setupCompleted: pickBoolean(general['setupCompleted'], d.general.setupCompleted),
    },
    taskDefaults: {
      plannerModel,
      plannerEffort: coerceEffort(plannerModel, rawPlannerEffort),
      executorModel,
      executorEffort: coerceEffort(executorModel, rawExecutorEffort),
      maxCycles: pickInt(taskDefaults['maxCycles'], d.taskDefaults.maxCycles, 1, 500),
      turnTimeoutMinutes: pickInt(taskDefaults['turnTimeoutMinutes'], d.taskDefaults.turnTimeoutMinutes, 1, 600),
      slowTurnWarningMinutes: pickInt(
        taskDefaults['slowTurnWarningMinutes'],
        d.taskDefaults.slowTurnWarningMinutes,
        1,
        600,
      ),
      maxTurnsPerSession: pickInt(taskDefaults['maxTurnsPerSession'], d.taskDefaults.maxTurnsPerSession, 1, 1000),
      approvalMode: pickEnum(
        taskDefaults['approvalMode'],
        ['auto', 'review', 'plan_first'] as const,
        d.taskDefaults.approvalMode,
      ),
      plannerContextMode: pickEnum(
        taskDefaults['plannerContextMode'],
        ['isolated', 'read_only'] as const,
        d.taskDefaults.plannerContextMode,
      ),
      standingPrompts: {
        planner: pickString(standingPrompts['planner'], d.taskDefaults.standingPrompts.planner),
        executor: pickString(standingPrompts['executor'], d.taskDefaults.standingPrompts.executor),
      },
      rolloverPercent: pickInt(taskDefaults['rolloverPercent'], d.taskDefaults.rolloverPercent, 5, 95),
      freshExecutorAfterRejectedTurns: pickNullableInt(
        taskDefaults['freshExecutorAfterRejectedTurns'],
        d.taskDefaults.freshExecutorAfterRejectedTurns,
        1,
        FRESH_EXECUTOR_MAX_TURNS,
      ),
      requiredSkillsBeforeDone: pickStringArray(
        taskDefaults['requiredSkillsBeforeDone'],
        d.taskDefaults.requiredSkillsBeforeDone,
      ),
      autoBranchAndCommit: pickBoolean(taskDefaults['autoBranchAndCommit'], d.taskDefaults.autoBranchAndCommit),
    },
    claudeCode: {
      binaryPath,
      executorTools: pickStringArray(claudeCode['executorTools'], d.claudeCode.executorTools),
      executorDisallowedTools: pickStringArray(claudeCode['executorDisallowedTools'], []),
      permissionMode: pickEnum(
        claudeCode['permissionMode'],
        ['dontAsk', 'bypassPermissions'] as const,
        d.claudeCode.permissionMode,
      ),
      allowApiKeyBilling: pickBoolean(claudeCode['allowApiKeyBilling'], d.claudeCode.allowApiKeyBilling),
      maxRetries: pickNullableInt(claudeCode['maxRetries'], d.claudeCode.maxRetries, 0, 10),
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults after an update, and Restore defaults (SPEC.md §11)
// ---------------------------------------------------------------------------

export interface PendingDefaultChange {
  field: DefaultChangeField;
  label: string;
  /** The oldest default still pending, and the newest. */
  from: DefaultValue;
  to: DefaultValue;
  current: DefaultValue;
  /** Still the old default, so most likely never chosen: pre-selected in the review. */
  suggested: boolean;
}

/**
 * The changed defaults this file has not been reconciled with, one per setting. A setting that already holds
 * the new value is left out.
 */
export function pendingDefaultChanges(settings: Settings): PendingDefaultChange[] {
  const byField = new Map<DefaultChangeField, PendingDefaultChange>();
  const oldValues = new Map<DefaultChangeField, DefaultValue[]>();
  for (const change of DEFAULT_CHANGES) {
    if (change.revision <= settings.defaultsRevision) continue;
    const current = settings.taskDefaults[change.field];
    const seen = byField.get(change.field);
    oldValues.set(change.field, [...(oldValues.get(change.field) ?? []), change.from]);
    byField.set(change.field, { field: change.field, label: change.label, from: seen?.from ?? change.from, to: change.to, current, suggested: false });
  }
  return [...byField.values()]
    .map((c) => ({ ...c, suggested: (oldValues.get(c.field) ?? []).includes(c.current) }))
    .filter((c) => c.current !== c.to);
}

/**
 * The settings with the chosen changes applied and the file marked as reconciled with this release, whatever
 * was chosen — "Keep my settings" is `fields` empty.
 */
export function applyDefaultChanges(settings: Settings, fields: readonly DefaultChangeField[]): Settings {
  const next = mergeSettings(JSON.parse(JSON.stringify(settings)) as unknown);
  const taskDefaults = next.taskDefaults as unknown as Record<DefaultChangeField, DefaultValue>;
  for (const change of pendingDefaultChanges(settings)) {
    if (fields.includes(change.field)) taskDefaults[change.field] = change.to;
  }
  return mergeSettings({ ...next, defaultsRevision: DEFAULTS_REVISION });
}

export type SettingsSection = 'general' | 'taskDefaults' | 'claudeCode';

/**
 * One section of Settings back to its defaults (SPEC.md §11), for the form: the caller saves it or not. The
 * data folder and the first-run flag are kept — the one decides where tasks are read from, the other is not a
 * preference.
 */
export function restoreSectionDefaults(settings: Settings, section: SettingsSection): Settings {
  const d = defaultSettings();
  const next = mergeSettings(JSON.parse(JSON.stringify(settings)) as unknown);
  if (section === 'general') {
    next.general = { ...d.general, dataFolder: settings.general.dataFolder, setupCompleted: settings.general.setupCompleted };
  } else if (section === 'taskDefaults') {
    next.taskDefaults = d.taskDefaults;
  } else {
    next.claudeCode = d.claudeCode;
  }
  return next;
}
