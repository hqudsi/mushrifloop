/**
 * The main process's task hub (SPEC.md §12 phases 4–5): owns the TaskRunners, answers the renderer's task
 * IPC, and pushes every change to the renderer. All decisions stay in the orchestrator; this layer only
 * validates requests, enforces "one running task at a time" (SPEC.md §6, §13), shapes data for display,
 * and turns status changes into notifications (SPEC.md §10).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AccountStatus,
  ActionResult,
  BlockingTask,
  ChangedFile,
  ChangedFiles,
  CreateTaskRequest,
  ProjectInspection,
  TaskAction,
  TaskDetail,
  TaskLoadFailure,
  TaskNoticeMessage,
  TaskSummary,
  TaskToast,
  UsageReport,
  UsageWindow,
} from '../shared/ipc';
import { EFFORT_LEVELS, coerceEffort, getModel, type EffortLevel } from '../shared/models';
import { FRESH_EXECUTOR_MAX_TURNS, type Settings } from '../shared/settings';
import type { AgentConfig, AgentRole, ConfigUpdate, ExecutorOutput, LiveTurnEvent, TaskConfig, TaskEvent, TaskRecord } from '../shared/task-model';
import { accountLabel, readSeenAccounts, recordAccount } from './seen-accounts';
import { activityFromEvents, applyActivityEvent, emptyActivity, type TurnActivity } from '../shared/turn-activity';
import { buildEnv, modelChangeVersionBlock, parseVersion, resolveClaudeBinary, runClaude } from './claude-cli';
import { dataFolder, tasksFolder, usageFile } from './config';
import { parseUsageStream } from './usage-report';
import { launchEditor, type EditorLaunchResult } from './editor';
import { errorMessage, log } from './logger';
import { autoResumeSkippedToast, cycleToast, statusToast, taskTitle, toastAllowed } from './notifications';
import {
  GitUnavailableError,
  TaskCreationError,
  TaskRunner,
  TaskStateError,
  TaskStore,
  UsageLedger,
  changesSince,
  createGitOps,
  createRealDeps,
  readAuthSettled,
  readAuthWithRetry,
  readingFromAuthOutput,
  refExists,
  taskConfigFromSettings,
  type OrchestratorDeps,
  type RealDepsOptions,
  type TaskNotice,
} from './orchestrator';
import { localDay } from './orchestrator/safety';
import { LineSplitter, toEvents, type TurnEvent } from './session-runner';

const TASK_NOTICE_DEBOUNCE_MS = 40;
const FINISHED_ACTIVITY_CACHE = 30;
/** How long a starting action may take to fail before it is reported as started. */
const EARLY_FAILURE_WINDOW_MS = 250;
/** `/usage` is free but not instant; a newer check than this is reused. */
const USAGE_FRESH_MS = 60_000;
const USAGE_TIMEOUT_MS = 60_000;
/** Untracked files larger than this are listed without a line count. */
const LINE_COUNT_LIMIT = 2 * 1024 * 1024;

export interface TaskServiceOptions {
  getSettings: () => Settings;
  send: (message: TaskNoticeMessage) => void;
  /** Defaults to <data folder>/tasks. */
  tasksRoot?: string;
  /** Defaults to <data folder>/usage.json. */
  usageFile?: string;
  /** Show a task notification (already filtered by the Settings toggles). */
  notify?: (toast: TaskToast, options: { sound: boolean }) => void;
  /** Tests: replaces the real CLI-backed dependencies. */
  createDeps?: (settings: Settings, options: RealDepsOptions) => { deps: OrchestratorDeps };
  /** Tests: replaces launching the editor. */
  launchEditor?: (command: string, file: string, cwd: string) => Promise<EditorLaunchResult>;
}

interface LiveTurn {
  taskId: string;
  turnId: string;
  agent: AgentRole;
  projectDir: string;
  activity: TurnActivity;
}

function strip(event: TurnEvent): LiveTurnEvent {
  const { raw: _raw, ...rest } = event as TurnEvent & { raw?: unknown };
  return rest as LiveTurnEvent;
}

export function summarize(task: TaskRecord, busy: boolean): TaskSummary {
  const agent = (a: TaskRecord['config']['planner']) => (a.effort ? `${a.model} · ${a.effort}` : a.model);
  return {
    id: task.id,
    title: taskTitle(task, 90),
    name: task.title ?? null,
    projectDir: task.projectDir,
    projectName: path.basename(task.projectDir),
    status: task.status,
    statusReason: task.statusReason,
    waitingKind: task.waiting?.kind ?? null,
    cycles: task.cycles,
    maxCycles: task.config.maxCycles,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    statusChangedAt: task.statusChangedAt,
    busy,
    pinned: { email: task.pinnedAccount.email, orgName: task.pinnedAccount.orgName, subscriptionType: task.pinnedAccount.subscriptionType },
    planner: agent(task.config.planner),
    executor: agent(task.config.executor),
    unreadable: null,
  };
}

/** A list row for a task whose files cannot be read (SPEC.md §9): listed, never left out. */
export function unreadableSummary(taskId: string, folder: string, error: string): TaskSummary {
  let changed = new Date(0).toISOString();
  try {
    changed = fs.statSync(folder).mtime.toISOString();
  } catch {
    /* the folder itself may be the problem; the error says so */
  }
  return {
    id: taskId,
    title: `Unreadable task ${taskId}`,
    name: null,
    projectDir: folder,
    projectName: path.basename(folder),
    status: 'error',
    statusReason: error,
    waitingKind: null,
    cycles: 0,
    maxCycles: 0,
    createdAt: changed,
    updatedAt: changed,
    statusChangedAt: changed,
    busy: false,
    pinned: { email: null, orgName: null, subscriptionType: null },
    planner: '',
    executor: '',
    unreadable: error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const agentRole = (v: unknown): AgentRole | null => (v === 'planner' || v === 'executor' ? v : null);

/** Only known per-task overrides, coerced into range (the renderer is trusted, but not its values). */
export function sanitizeOverrides(raw: unknown): Partial<TaskConfig> {
  if (!isRecord(raw)) return {};
  const out: Partial<TaskConfig> = {};
  for (const agent of ['planner', 'executor'] as const) {
    const value = raw[agent];
    if (isRecord(value) && typeof value['model'] === 'string' && getModel(value['model'])) {
      const model = value['model'];
      const effort = typeof value['effort'] === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value['effort'])
        ? (value['effort'] as EffortLevel)
        : null;
      out[agent] = { model, effort: coerceEffort(model, effort) };
    }
  }
  const int = (key: string, min: number, max: number) => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
  };
  const maxCycles = int('maxCycles', 1, 500);
  if (maxCycles !== undefined) out.maxCycles = maxCycles;
  const rollover = int('rolloverPercent', 5, 95);
  if (rollover !== undefined) out.rolloverPercent = rollover;
  if (raw['freshExecutorAfterRejectedTurns'] === null) out.freshExecutorAfterRejectedTurns = null;
  const fresh = int('freshExecutorAfterRejectedTurns', 1, FRESH_EXECUTOR_MAX_TURNS);
  if (fresh !== undefined) out.freshExecutorAfterRejectedTurns = fresh;
  // Same ranges as Settings → Task defaults (minutes there, milliseconds in the task).
  const timeout = int('turnTimeoutMs', 60_000, 600 * 60_000);
  if (timeout !== undefined) out.turnTimeoutMs = timeout;
  const slow = int('slowTurnMs', 60_000, 600 * 60_000);
  if (slow !== undefined) out.slowTurnMs = slow;
  const steps = int('maxTurnsPerSession', 1, 1000);
  if (steps !== undefined) out.maxTurnsPerSession = steps;
  const approval = raw['approvalMode'];
  if (approval === 'auto' || approval === 'review' || approval === 'plan_first') out.approvalMode = approval;
  const context = raw['plannerContextMode'];
  if (context === 'isolated' || context === 'read_only') out.plannerContextMode = context;
  if (typeof raw['autoBranchAndCommit'] === 'boolean') out.autoBranchAndCommit = raw['autoBranchAndCommit'];
  if (Array.isArray(raw['requiredSkills'])) {
    out.requiredSkills = [
      ...new Set(raw['requiredSkills'].filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())),
    ];
  }
  const standing = raw['standingInstructions'];
  if (isRecord(standing) && typeof standing['planner'] === 'string' && typeof standing['executor'] === 'string') {
    out.standingInstructions = { planner: standing['planner'], executor: standing['executor'] };
  }
  return out;
}

/** A TaskAction from the renderer, checked field by field. */
export function parseAction(raw: unknown): TaskAction | null {
  if (!isRecord(raw)) return null;
  switch (raw['kind']) {
    case 'start':
    case 'pause':
    case 'stop':
    case 'resume':
      return { kind: raw['kind'] };
    case 'answer':
    case 'decline_waiver': {
      const t = text(raw['text']);
      return t === null ? null : { kind: raw['kind'], text: t };
    }
    case 'send': {
      const t = text(raw['text']);
      return t === null ? null : { kind: 'send', text: t };
    }
    case 'waive_skill': {
      const skill = text(raw['skill']);
      const note = text(raw['note']);
      if (skill === null) return null;
      return note === null ? { kind: 'waive_skill', skill } : { kind: 'waive_skill', skill, note };
    }
    case 'approve_instruction':
    case 'approve_plan': {
      if (raw['edited'] === undefined) return { kind: raw['kind'] };
      const edited = text(raw['edited']);
      return edited === null ? null : { kind: raw['kind'], edited };
    }
    case 'reject_instruction':
    case 'reject_plan': {
      const reason = text(raw['reason']);
      return reason === null ? null : { kind: raw['kind'], reason };
    }
    case 'set_standing_instructions': {
      const agent = agentRole(raw['agent']);
      const t = text(raw['text']);
      return agent === null || t === null ? null : { kind: 'set_standing_instructions', agent, text: t };
    }
    case 'rollover_now': {
      const agent = agentRole(raw['agent']);
      return agent === null ? null : { kind: 'rollover_now', agent };
    }
    case 'set_approval_mode': {
      const mode = raw['mode'];
      return mode === 'auto' || mode === 'review' || mode === 'plan_first' ? { kind: 'set_approval_mode', mode } : null;
    }
    case 'update_config': {
      const update = parseConfigUpdate(raw['update']);
      return update === null ? null : { kind: 'update_config', update };
    }
    case 'rename': {
      const title = text(raw['title']);
      return title === null ? null : { kind: 'rename', title };
    }
    default:
      return null;
  }
}

/**
 * "Task settings" from the renderer, field by field (SPEC.md §6). Shapes only: ranges, the cycles already
 * run, model names and efforts are the orchestrator's to judge, so its refusal carries the reason.
 */
export function parseConfigUpdate(raw: unknown): ConfigUpdate | null {
  if (!isRecord(raw)) return null;
  const out: ConfigUpdate = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const agent = (v: unknown): AgentConfig | null | undefined => {
    if (v === undefined) return undefined;
    if (!isRecord(v) || typeof v['model'] !== 'string') return null;
    const effort = v['effort'];
    if (effort !== null && !(typeof effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(effort))) return null;
    return { model: v['model'], effort: effort as EffortLevel | null };
  };
  if (raw['maxCycles'] !== undefined) {
    const n = num(raw['maxCycles']);
    if (n === undefined) return null;
    out.maxCycles = n;
  }
  if (raw['rolloverPercent'] !== undefined) {
    const n = num(raw['rolloverPercent']);
    if (n === undefined) return null;
    out.rolloverPercent = n;
  }
  if (raw['requiredSkills'] !== undefined) {
    const list = raw['requiredSkills'];
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return null;
    out.requiredSkills = list as string[];
  }
  if (raw['autoBranchAndCommit'] !== undefined) {
    if (typeof raw['autoBranchAndCommit'] !== 'boolean') return null;
    out.autoBranchAndCommit = raw['autoBranchAndCommit'];
  }
  for (const key of ['turnTimeoutMs', 'slowTurnMs', 'maxTurnsPerSession'] as const) {
    if (raw[key] === undefined) continue;
    const n = num(raw[key]);
    if (n === undefined) return null;
    out[key] = n;
  }
  if (raw['freshExecutorAfterRejectedTurns'] !== undefined) {
    const v = raw['freshExecutorAfterRejectedTurns'];
    const n = v === null ? null : num(v);
    if (n === undefined) return null;
    out.freshExecutorAfterRejectedTurns = n;
  }
  for (const role of ['planner', 'executor'] as const) {
    const a = agent(raw[role]);
    if (a === null) return null;
    if (a !== undefined) out[role] = a;
  }
  if (raw['apply'] !== undefined) {
    if (raw['apply'] !== 'same_session' && raw['apply'] !== 'fresh_session') return null;
    out.apply = raw['apply'];
  }
  return out;
}

/** `a/b/c.ts` → name `c.ts`, dir `a/b`. */
function fileRow(rel: string, status: ChangedFile['status'], additions: number | null, deletions: number | null): ChangedFile {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const cut = clean.lastIndexOf('/');
  return { path: clean, name: cut >= 0 ? clean.slice(cut + 1) : clean, dir: cut >= 0 ? clean.slice(0, cut) : '', status, additions, deletions };
}

/** Line count of a new text file, or null (too big, binary, unreadable). */
function countLines(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LINE_COUNT_LIMIT) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let lines = 0;
    for (const byte of buf) if (byte === 10) lines += 1;
    return buf[buf.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return null;
  }
}

/** Files the Executor reported changing, in order (used when git is not in use). */
export function filesFromReports(events: readonly TaskEvent[], projectDir: string): ChangedFile[] {
  const seen = new Map<string, { first: string; last: string }>();
  for (const e of events) {
    if (e.type !== 'turn' || e.agent !== 'executor' || !e.ok || !e.output) continue;
    const out = e.output as ExecutorOutput;
    for (const f of out.changed_files ?? []) {
      let rel = f.path.trim();
      if (rel === '') continue;
      if (path.isAbsolute(rel)) {
        const r = path.relative(projectDir, rel);
        if (!r.startsWith('..') && !path.isAbsolute(r)) rel = r;
      }
      rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
      const entry = seen.get(rel);
      if (entry) entry.last = f.change;
      else seen.set(rel, { first: f.change, last: f.change });
    }
  }
  return [...seen.entries()]
    .map(([rel, c]) => fileRow(rel, c.last === 'deleted' ? 'D' : c.first === 'added' ? 'A' : 'M', null, null))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Session (5-hour)',
  seven_day: 'Week (all models)',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
  overage: 'Extra usage',
};

const capitalise = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

function windowLabel(key: string): string {
  if (WINDOW_LABELS[key]) return WINDOW_LABELS[key];
  // A per-model week from /usage: seven_day_fable → "Week (Fable)".
  if (key.startsWith('seven_day_')) return `Week (${capitalise(key.slice('seven_day_'.length).replace(/_/g, ' '))})`;
  return capitalise(key.replace(/_/g, ' '));
}

/** The session first, then the weeks (all models, then per model), then anything else. */
function windowRank(key: string): number {
  if (key === 'five_hour') return 0;
  if (key === 'seven_day') return 1;
  if (key.startsWith('seven_day_')) return 2;
  return key === 'overage' ? 4 : 3;
}

export class TaskService {
  private deps: OrchestratorDeps | null = null;
  private setupError: string | null = null;
  private store: TaskStore;
  private readonly ledger: UsageLedger;
  private readonly runners = new Map<string, TaskRunner>();
  private readonly liveTurns = new Map<string, LiveTurn>();
  private readonly finished = new Map<string, TurnActivity>();
  private readonly pendingTask = new Map<string, { task: TaskRecord; timer: NodeJS.Timeout }>();
  /** Tasks that could not be loaded at startup, with the reason (listed, never hidden — SPEC.md §9). */
  private readonly loadErrors = new Map<string, string>();
  /**
   * Commands that may run a task's loop, from the moment they are accepted until they settle. Holding the
   * slot this early closes the gap before the loop starts (the account check), so two starts cannot both
   * pass the one-at-a-time check (SPEC.md §6).
   */
  private readonly claims = new Map<string, Set<Promise<unknown>>>();
  /** Stops started by quitting, so waiting again waits on the same stops. */
  private readonly stops = new Map<string, Promise<void>>();
  private stale = false;
  private usageCheck: { error: string | null; at: string } | null = null;
  private usageRun: Promise<void> | null = null;

  constructor(private readonly options: TaskServiceOptions) {
    this.store = new TaskStore(options.tasksRoot ?? tasksFolder());
    this.ledger = new UsageLedger(options.usageFile ?? usageFile());
  }

  /** Load every stored task. A task stored as running was interrupted and becomes resumable (§5.5). */
  init(): void {
    for (const runner of this.runners.values()) runner.dispose();
    this.runners.clear();
    try {
      const hooks: RealDepsOptions = {
        tasksRoot: this.store.root,
        onNotice: (notice) => this.onNotice(notice),
        notify: (n) => this.onStatusNotification(n.taskId),
        autoResume: (taskId) => void this.autoResume(taskId),
      };
      const settings = this.options.getSettings();
      this.deps = (this.options.createDeps ?? createRealDeps)(settings, hooks).deps;
      this.setupError = null;
    } catch (err) {
      this.deps = null;
      this.setupError = errorMessage(err);
      log.error('tasks.setup_failed', { error: this.setupError });
    }
    this.stale = false;
    this.loadErrors.clear();
    if (!this.deps) return;
    let ids: string[];
    try {
      ids = this.store.listTaskIds();
    } catch (err) {
      // list() reports this to the renderer; nothing can be loaded.
      log.error('tasks.list_failed', { folder: this.store.root, error: errorMessage(err) });
      return;
    }
    for (const id of ids) {
      try {
        this.runners.set(id, TaskRunner.load(this.store.readTask(id), this.store.readEvents(id), this.deps));
      } catch (err) {
        this.loadErrors.set(id, `Could not load this task from ${this.store.taskDir(id)}: ${errorMessage(err)}`);
        log.error('task.load_failed', { taskId: id, error: errorMessage(err) });
      }
    }
    log.info('tasks.loaded', { count: this.runners.size, folder: this.store.root });
  }

  /** Settings changed: new tasks and resumed loops should use them (applied when nothing is running). */
  settingsChanged(): void {
    this.stale = true;
    this.refreshIfIdle();
  }

  anyBusy(): boolean {
    return this.busyTasks().length > 0;
  }

  /** The task whose loop is running or about to, if any (tasks run one at a time). */
  busyTask(): BlockingTask | null {
    return this.busyTasks()[0] ?? null;
  }

  private busyTasks(): BlockingTask[] {
    const out: BlockingTask[] = [];
    for (const [id, runner] of this.runners) {
      if (runner.busy || this.claims.has(id)) out.push({ taskId: id, title: summarize(runner.snapshot, true).title });
    }
    return out;
  }

  /**
   * Quit and stop (SPEC.md §6): stop every running task and wait up to `budgetMs` for the stops to
   * complete — the turn's processes gone and `stopped` saved. Returns the tasks that have not stopped yet;
   * calling again keeps waiting on the same stops.
   */
  async stopAll(budgetMs: number): Promise<BlockingTask[]> {
    for (const { taskId } of this.busyTasks()) {
      const runner = this.runners.get(taskId);
      if (!runner || this.stops.has(taskId)) continue;
      const stop = runner
        .stop()
        .catch((err: unknown) => log.error('task.stop_failed', { taskId, error: errorMessage(err) }))
        // A resume that was still checking the account settles too, before the task counts as stopped.
        .then(() => this.settled(taskId))
        .finally(() => this.flushTask(taskId, runner.snapshot));
      this.stops.set(taskId, stop);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.stops.values()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    return this.busyTasks();
  }

  /** Resolves when no accepted command of this task is still running. */
  private async settled(taskId: string): Promise<void> {
    let pending = this.claims.get(taskId);
    while (pending && pending.size > 0) {
      await Promise.allSettled([...pending]);
      pending = this.claims.get(taskId);
    }
  }

  dispose(): void {
    for (const runner of this.runners.values()) runner.dispose();
    for (const pending of this.pendingTask.values()) clearTimeout(pending.timer);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Every task folder. A task that cannot be read is listed as unreadable (SPEC.md §9). Throws when the
   * tasks folder itself cannot be listed.
   */
  list(): TaskSummary[] {
    const out: TaskSummary[] = [];
    for (const id of this.store.listTaskIds()) {
      const loadError = this.loadErrors.get(id);
      if (loadError !== undefined) {
        out.push(unreadableSummary(id, this.store.taskDir(id), loadError));
        continue;
      }
      try {
        out.push(summarize(this.store.readTask(id), this.runners.get(id)?.busy ?? false));
      } catch (err) {
        log.warn('task.read_failed', { taskId: id, error: errorMessage(err) });
        out.push(unreadableSummary(id, this.store.taskDir(id), `Could not read ${this.store.taskFile(id)}: ${errorMessage(err)}`));
      }
    }
    return out;
  }

  get(taskId: string): TaskDetail | TaskLoadFailure | null {
    if (!this.isKnownId(taskId)) return null;
    const folder = this.store.taskDir(taskId);
    const loadError = this.loadErrors.get(taskId);
    if (loadError !== undefined) return { unreadable: true, taskId, folder, error: loadError };
    try {
      return { task: this.store.readTask(taskId), events: this.store.readEvents(taskId), busy: this.runners.get(taskId)?.busy ?? false };
    } catch (err) {
      log.warn('task.read_failed', { taskId, error: errorMessage(err) });
      return { unreadable: true, taskId, folder, error: `Could not read this task from ${folder}: ${errorMessage(err)}` };
    }
  }

  /** What a turn did: live for the running turn, parsed from the raw file otherwise. A failure says why. */
  activity(taskId: string, turnId: string): TurnActivity {
    const failed = (error: string): TurnActivity => ({ ...emptyActivity(), error });
    if (!this.isKnownId(taskId) || !/^[\w.:-]+$/.test(turnId)) return failed(`Unknown turn ${turnId} of task ${taskId}.`);
    const live = this.liveTurns.get(taskId);
    if (live && live.turnId === turnId) return live.activity;
    const cached = this.finished.get(turnId);
    if (cached) return cached;
    let projectDir: string | null = null;
    try {
      projectDir = this.store.readTask(taskId).projectDir;
    } catch {
      /* show absolute paths */
    }
    const file = path.join(this.store.rawDir(taskId), `${turnId}.ndjson`);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      log.warn('turn.raw_read_failed', { taskId, turnId, file, error: errorMessage(err) });
      return failed(`Could not read this turn's raw output (${file}): ${errorMessage(err)}`);
    }
    const splitter = new LineSplitter();
    const events: LiveTurnEvent[] = [];
    for (const line of [...splitter.push(content), ...splitter.flush()]) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of toEvents(message)) events.push(strip(event));
    }
    const activity = activityFromEvents(events, projectDir);
    this.remember(turnId, activity);
    return activity;
  }

  async accountStatus(): Promise<AccountStatus> {
    const checkedAt = new Date().toISOString();
    const settings = this.options.getSettings();
    const binary = resolveClaudeBinary(settings);
    if (!binary.path) {
      return {
        checkedAt,
        cliVersion: null,
        cliPath: null,
        reading: null,
        error: binary.error ?? 'The claude CLI was not found.',
        planUncertain: false,
        seenAccounts: readSeenAccounts(),
      };
    }
    const env = buildEnv(settings);
    const exe = binary.path;
    const readAuth = async () => readAuthWithRetry(async () => readingFromAuthOutput(await runClaude(exe, ['auth', 'status', '--json'], { env, timeoutMs: 20_000 })));
    // Every live reading passes through here, so this is the one place that can notice the shared
    // credentials file switching accounts on us (SPEC.md §10, NOTES.md §6, §35). The account last
    // recorded is what "changed" is measured against, so the guard survives a restart.
    const previousLabel = readSeenAccounts()[0]?.label ?? null;
    const [version, settled] = await Promise.all([
      runClaude(exe, ['--version'], { env, timeoutMs: 20_000 }),
      readAuthSettled(readAuth, previousLabel),
    ]);
    const { reading, planUncertain } = settled;
    const seenAccounts = recordAccount(reading, checkedAt, planUncertain);
    if (planUncertain) {
      log.warn('account.plan_unconfirmed', { label: accountLabel(reading), previously: previousLabel });
    }
    return {
      checkedAt,
      cliVersion: parseVersion(version.stdout),
      cliPath: exe,
      reading,
      error: version.spawnError ?? null,
      planUncertain,
      seenAccounts,
    };
  }

  /**
   * Files the task changed (right panel). With git in use: the task's starting point (the snapshot commit,
   * else the start commit) against the working tree, or against the task branch when another branch is
   * checked out. Otherwise the Executor's own reports.
   */
  async changedFiles(taskId: string): Promise<ChangedFiles> {
    const failed = (error: string, basis = 'the task could not be read'): ChangedFiles => ({
      taskId,
      source: 'reports',
      basis,
      files: [],
      additions: 0,
      deletions: 0,
      error,
    });
    if (!this.isKnownId(taskId)) return failed(`Unknown task ${taskId}.`);
    let task: TaskRecord;
    try {
      task = this.store.readTask(taskId);
    } catch (err) {
      return failed(`Could not read ${this.store.taskFile(taskId)}: ${errorMessage(err)}`);
    }
    const g = task.git;
    const fromReports = (basis: string, error: string | null = null): ChangedFiles => {
      let events: TaskEvent[];
      try {
        events = this.store.readEvents(taskId);
      } catch (err) {
        return failed(`Could not read ${this.store.eventsFile(taskId)}: ${errorMessage(err)}`, basis);
      }
      return { taskId, source: 'reports', basis, files: filesFromReports(events, task.projectDir), additions: 0, deletions: 0, error };
    };
    if (!g.isRepo || !g.enabled || g.branch === null) {
      const why = !task.setupDone ? 'not started yet' : (g.inertReason ?? 'git is not in use');
      return fromReports(`from the Executor's reports — ${why}`);
    }
    const dir = task.projectDir;
    const base = g.snapshot?.hash ?? g.startCommit;
    try {
      const current = await createGitOps().currentBranch(dir);
      const onBranch = current === g.branch;
      if (!onBranch && !(await refExists(dir, g.branch))) {
        return fromReports(`from the Executor's reports — branch ${g.branch} no longer exists`);
      }
      const { changes, untracked } = await changesSince(dir, base, onBranch ? null : g.branch);
      const files = changes.map((c) => fileRow(c.path, c.status, c.additions, c.deletions));
      for (const rel of untracked) files.push(fileRow(rel, 'A', countLines(path.join(dir, rel)), 0));
      files.sort((a, b) => a.path.localeCompare(b.path));
      const from = g.snapshot ? `snapshot ${g.snapshot.hash.slice(0, 7)}` : base ? `start ${base.slice(0, 7)}` : 'an empty repository';
      return {
        taskId,
        source: 'git',
        basis: onBranch ? `since ${from}, including uncommitted changes` : `${g.branch} since ${from} (branch not checked out)`,
        files,
        additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
        deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
        error: null,
      };
    } catch (err) {
      const why = err instanceof GitUnavailableError ? 'git could not be run' : 'git failed';
      return fromReports(`from the Executor's reports — ${why}`, errorMessage(err));
    }
  }

  /** Open one of the task's files with the configured editor command. */
  async openFile(taskId: string, relativePath: unknown): Promise<{ ok: boolean; error?: string }> {
    if (!this.isKnownId(taskId) || typeof relativePath !== 'string' || relativePath.trim() === '') {
      return { ok: false, error: 'Invalid file.' };
    }
    let projectDir: string;
    try {
      projectDir = this.store.readTask(taskId).projectDir;
    } catch (err) {
      return { ok: false, error: `Could not read ${this.store.taskFile(taskId)}: ${errorMessage(err)}` };
    }
    const target = path.resolve(projectDir, relativePath);
    const rel = path.relative(projectDir, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: `Not inside the project folder: ${relativePath}` };
    if (!fs.existsSync(target)) return { ok: false, error: `The file does not exist (any more): ${target}` };
    const command = this.options.getSettings().general.editorCommand;
    const result = await (this.options.launchEditor ?? launchEditor)(command, target, projectDir);
    if (result.ok) log.info('editor.opened', { taskId, file: target });
    else log.warn('editor.failed', { taskId, file: target, error: result.error });
    return result;
  }

  /** Git state of a folder for the New task dialog. */
  async inspectProject(dir: unknown): Promise<ProjectInspection> {
    const raw = typeof dir === 'string' ? dir.trim() : '';
    const resolved = raw === '' ? '' : path.resolve(raw);
    const empty: ProjectInspection = { path: resolved, exists: false, isRepo: false, branch: null, hasRemote: false, dirtyCount: 0, error: null };
    if (resolved === '') return empty;
    try {
      if (!fs.statSync(resolved).isDirectory()) return { ...empty, error: 'Not a folder.' };
    } catch {
      return empty;
    }
    try {
      const g = await createGitOps().inspect(resolved);
      return { ...empty, exists: true, isRepo: g.isRepo, branch: g.branch, hasRemote: g.hasRemote, dirtyCount: g.dirty.length };
    } catch (err) {
      return { ...empty, exists: true, error: errorMessage(err) };
    }
  }

  /**
   * Usage for the right panel (SPEC.md §17): plan utilization as Claude Code last reported it, by a turn or
   * by `/usage`, and the local estimate. `refresh` runs `/usage` first, between turns only.
   */
  async usage(refresh: boolean): Promise<UsageReport> {
    const busy = this.anyBusy();
    if (refresh && !busy) {
      const fresh = this.usageCheck !== null && Date.now() - Date.parse(this.usageCheck.at) < USAGE_FRESH_MS;
      if (!fresh) await (this.usageRun ??= this.runUsage().finally(() => (this.usageRun = null)));
    }
    const data = this.ledger.read();
    const now = new Date();
    const windows: UsageWindow[] = Object.entries(data.latest?.windows ?? {})
      .sort(([a], [b]) => windowRank(a) - windowRank(b))
      .map(([key, w]) => ({
        key,
        label: windowLabel(key),
        utilization: w.utilization,
        resetsAt: w.resetsAt,
        reportedAt: w.at ?? data.latest?.at ?? null,
      }));
    return {
      reportedAt: data.latest?.at ?? null,
      windows,
      estimate: { today: this.ledger.tokensOn(localDay(now)), last7Days: this.ledger.tokensLast7Days(now) },
      checkedAt: this.usageCheck?.at ?? null,
      checkError: this.usageCheck?.error ?? null,
      refreshSkipped: refresh && busy,
      ledgerError: this.ledger.problem,
    };
  }

  /**
   * `claude -p "/usage"` in stream-json: no model call, no session file (NOTES.md §4c, §18). Its structured
   * `usage_report` updates the windows (NOTES.md §44); the text is not read.
   */
  private async runUsage(): Promise<void> {
    const settings = this.options.getSettings();
    const binary = resolveClaudeBinary(settings);
    const at = () => new Date().toISOString();
    if (!binary.path) {
      this.usageCheck = { error: binary.error ?? 'The claude CLI was not found.', at: at() };
      return;
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--tools', ''];
    const run = await runClaude(binary.path, args, { env: buildEnv(settings), cwd: dataFolder(), input: '/usage', timeoutMs: USAGE_TIMEOUT_MS });
    if (run.spawnError || run.timedOut) {
      this.usageCheck = { error: run.spawnError ?? `/usage did not finish within ${USAGE_TIMEOUT_MS / 1000} s.`, at: at() };
      return;
    }
    const parsed = parseUsageStream(run.stdout);
    if (parsed.ok) {
      this.ledger.recordUsageReport(new Date(), parsed.windows);
      this.usageCheck = { error: null, at: at() };
    } else {
      const raw = parsed.error === 'returned no result' ? `: ${`${run.stdout}\n${run.stderr}`.trim().slice(0, 300)}` : '';
      this.usageCheck = { error: `/usage ${parsed.error} (exit ${run.code ?? 'none'})${raw}`, at: at() };
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async create(request: unknown): Promise<ActionResult> {
    if (!isRecord(request)) return { ok: false, error: 'Invalid request.' };
    const description = text(request['description']);
    const projectDir = text(request['projectDir']);
    if (description === null || projectDir === null) return { ok: false, error: 'A description and a project folder are required.' };
    const ready = this.readyDeps();
    if (!ready.ok) return ready.result;
    let runner: TaskRunner;
    try {
      const config = taskConfigFromSettings(this.options.getSettings(), sanitizeOverrides(request['overrides']));
      runner = await TaskRunner.create({ description, projectDir, config }, ready.deps);
    } catch (err) {
      if (err instanceof TaskCreationError) return { ok: false, error: err.message, nextStep: err.nextStep };
      log.error('task.create_failed', { error: errorMessage(err) });
      return { ok: false, error: errorMessage(err) };
    }
    this.runners.set(runner.id, runner);
    this.flushTask(runner.id, runner.snapshot);
    log.info('task.created', { taskId: runner.id, approvalMode: runner.snapshot.config.approvalMode });
    const typed = request as Partial<CreateTaskRequest>;
    if (typed.start === true) {
      const started = await this.action(runner.id, { kind: 'start' });
      return { ...started, taskId: runner.id };
    }
    return { ok: true, taskId: runner.id };
  }

  async action(taskId: string, raw: unknown): Promise<ActionResult> {
    const action = parseAction(raw);
    if (!action) return { ok: false, error: 'Invalid action.' };
    const ready = this.readyDeps();
    if (!ready.ok) return ready.result;
    const runner = this.runners.get(taskId);
    if (!runner) return { ok: false, error: `Unknown task ${taskId}.` };

    // Commands that never start the loop.
    switch (action.kind) {
      case 'pause':
        runner.pause();
        return { ok: true };
      case 'stop':
        try {
          await runner.stop();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        } finally {
          this.flushTask(taskId, runner.snapshot);
        }
      case 'update_config': {
        // A model the installed CLI cannot run is refused here, as for a new task (SPEC.md §6, §8).
        const models = (['planner', 'executor'] as const).flatMap((role) => {
          const next = action.update[role];
          return next ? [{ role: role === 'planner' ? 'Planner' : 'Executor', model: next.model }] : [];
        });
        const block = await modelChangeVersionBlock(this.options.getSettings(), models);
        if (block) return { ok: false, error: block };
        try {
          runner.updateConfig(action.update);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        } finally {
          this.flushTask(taskId, runner.snapshot);
        }
      }
      case 'set_standing_instructions':
      case 'rollover_now':
      case 'set_approval_mode':
      case 'rename':
        try {
          if (action.kind === 'rollover_now') runner.requestRollover(action.agent);
          else if (action.kind === 'set_approval_mode') runner.setApprovalMode(action.mode);
          else if (action.kind === 'rename') runner.rename(action.title);
          else runner.setStandingInstructions(action.agent, action.text);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        } finally {
          this.flushTask(taskId, runner.snapshot);
        }
      default:
        break;
    }

    // Everything else may start the loop: only one task runs at a time (SPEC.md §6, §13) — refused on
    // purpose, with the running task named so the UI can link to it.
    const blocking = this.busyTask();
    if (blocking && blocking.taskId !== taskId) {
      return {
        ok: false,
        error: `A task is already running: ${blocking.title}`,
        nextStep: 'Tasks run one at a time — pause or stop that task first, or wait for it to finish.',
        blockedBy: blocking,
      };
    }
    switch (action.kind) {
      case 'start':
        return this.launch(taskId, () => runner.start());
      case 'resume':
        return this.launch(taskId, () => runner.resume());
      case 'answer':
        return this.launch(taskId, () => runner.answer(action.text));
      case 'send':
        // While a turn runs, the message is delivered when the turn ends.
        return this.launch(taskId, () => runner.sendMessage(action.text));
      case 'waive_skill':
        return this.launch(taskId, () => runner.waiveSkill(action.skill, action.note));
      case 'decline_waiver':
        return this.launch(taskId, () => runner.declineWaiver(action.text));
      case 'approve_instruction':
        return this.launch(taskId, () => runner.approveInstruction(action.edited));
      case 'reject_instruction':
        return this.launch(taskId, () => runner.rejectInstruction(action.reason));
      case 'approve_plan':
        return this.launch(taskId, () => runner.approvePlan(action.edited));
      case 'reject_plan':
        return this.launch(taskId, () => runner.rejectPlan(action.reason));
    }
  }

  /**
   * Auto-resume at reset (SPEC.md §17) is a start like any other, so the one-at-a-time check applies (§6).
   * Refused because another task runs: the task stays rate_limited, records why, and the user is told.
   */
  private async autoResume(taskId: string): Promise<void> {
    const result = await this.action(taskId, { kind: 'resume' });
    log.info('task.auto_resume', { taskId, ok: result.ok, error: result.error ?? null, blockedBy: result.blockedBy?.taskId ?? null });
    if (result.ok || !result.blockedBy) return;
    const runner = this.runners.get(taskId);
    if (!runner) return;
    runner.autoResumeBlocked(result.blockedBy);
    const task = runner.snapshot;
    this.flushTask(taskId, task);
    this.deliver(autoResumeSkippedToast(task, result.blockedBy, new Date().toISOString()));
  }

  /**
   * Run a command that may keep the loop going. Refusals (TaskStateError) surface at once; after a short
   * window the command counts as started and the renderer follows it through notices.
   */
  private launch(taskId: string, start: () => Promise<void>): Promise<ActionResult> {
    let work: Promise<void>;
    try {
      work = start();
    } catch (err) {
      work = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    // The slot is held from here until the command settles (see `claims`).
    const claim = this.claims.get(taskId) ?? new Set<Promise<unknown>>();
    this.claims.set(taskId, claim);
    claim.add(work);
    const release = () => {
      claim.delete(work);
      if (claim.size === 0 && this.claims.get(taskId) === claim) this.claims.delete(taskId);
    };
    return new Promise((resolve) => {
      let answered = false;
      const answer = (result: ActionResult) => {
        if (answered) return;
        answered = true;
        resolve(result);
      };
      const timer = setTimeout(() => answer({ ok: true }), EARLY_FAILURE_WINDOW_MS);
      work
        .then(() => answer({ ok: true }))
        .catch((err: unknown) => {
          if (!(err instanceof TaskStateError)) log.error('task.action_failed', { taskId, error: errorMessage(err) });
          answer({ ok: false, error: errorMessage(err) });
        })
        .finally(() => {
          clearTimeout(timer);
          release();
          // The loop has halted: `busy` changed after the last save, so tell the renderer.
          const runner = this.runners.get(taskId);
          if (runner) this.flushTask(taskId, runner.snapshot);
          this.refreshIfIdle();
        });
    });
  }

  private readyDeps(): { ok: true; deps: OrchestratorDeps } | { ok: false; result: ActionResult } {
    this.refreshIfIdle();
    if (!this.deps) {
      return {
        ok: false,
        result: { ok: false, error: this.setupError ?? 'The orchestrator is not ready.', nextStep: 'Check Settings → Claude Code connection.' },
      };
    }
    return { ok: true, deps: this.deps };
  }

  private refreshIfIdle(): void {
    if (this.stale && !this.anyBusy()) this.init();
  }

  private isKnownId(taskId: string): boolean {
    return /^[\w-]+$/.test(taskId) && fs.existsSync(this.store.taskFile(taskId));
  }

  // -------------------------------------------------------------------------
  // Notices → renderer, notifications
  // -------------------------------------------------------------------------

  private onNotice(notice: TaskNotice): void {
    switch (notice.type) {
      case 'event':
        this.options.send({ type: 'event', taskId: notice.taskId, event: notice.event });
        this.onEvent(notice.taskId, notice.event);
        break;
      case 'turn_event': {
        const event = strip(notice.event);
        let live = this.liveTurns.get(notice.taskId);
        if (!live || live.turnId !== notice.turnId) {
          const task = this.runners.get(notice.taskId)?.snapshot;
          live = { taskId: notice.taskId, turnId: notice.turnId, agent: notice.agent, projectDir: task?.projectDir ?? '', activity: emptyActivity() };
          this.liveTurns.set(notice.taskId, live);
        }
        live.activity = applyActivityEvent(live.activity, event, live.projectDir || null);
        this.options.send({ type: 'turn_event', taskId: notice.taskId, turnId: notice.turnId, agent: notice.agent, seq: live.activity.seq, event });
        break;
      }
      case 'task':
        this.scheduleTask(notice.task);
        break;
    }
  }

  private onEvent(taskId: string, event: TaskEvent): void {
    // SPEC.md §15 and §5 net 11: a skipped rollover and a changed request are in app.log too.
    if (event.type === 'rollover_skipped') log.warn('task.rollover_skipped', { taskId, agent: event.agent, attempts: event.attempts, reason: event.reason });
    if (event.type === 'answer_retry') {
      log.warn('task.answer_retry', { taskId, agent: event.agent, purpose: event.purpose, turnId: event.turnId, attempt: event.attempt, variation: event.variation, refusals: event.refusals });
    }
    // SPEC.md §5 net 12: both attempts of a service-error retry are in app.log.
    if (event.type === 'service_retry') {
      const { type: _t, seq: _s, ts: _ts, ...detail } = event;
      if (event.outcome === 'recovered') log.info('task.service_retry', { taskId, ...detail });
      else log.warn('task.service_retry', { taskId, ...detail });
    }
    // A finished turn keeps its live activity, so expanding it later needs no file read.
    if (event.type === 'turn') {
      const live = this.liveTurns.get(taskId);
      if (live && live.turnId === event.turnId) {
        this.remember(live.turnId, live.activity);
        this.liveTurns.delete(taskId);
      }
    }
    if (event.type === 'cycle') {
      const task = this.taskRecord(taskId);
      if (task) {
        const { type: _t, seq: _s, ts, ...summary } = event;
        this.deliver(cycleToast(task, summary, ts));
      }
    }
  }

  /** The orchestrator announced a status change (after it was saved). */
  private onStatusNotification(taskId: string): void {
    const task = this.taskRecord(taskId);
    if (!task) return;
    const toast = statusToast(task, new Date().toISOString());
    if (toast) this.deliver(toast);
  }

  private taskRecord(taskId: string): TaskRecord | null {
    const runner = this.runners.get(taskId);
    if (runner) return runner.snapshot;
    try {
      // During load, before the runner is registered.
      return this.store.readTask(taskId);
    } catch {
      return null;
    }
  }

  private deliver(toast: TaskToast): void {
    const settings = this.options.getSettings().general.notifications;
    const allowed = toastAllowed(toast, settings);
    log.info('task.notify', { taskId: toast.taskId, category: toast.category, title: toast.title, shown: allowed });
    if (allowed) this.options.notify?.(toast, { sound: settings.sound });
  }

  private scheduleTask(task: TaskRecord): void {
    const pending = this.pendingTask.get(task.id);
    if (pending) {
      pending.task = task;
      return;
    }
    const timer = setTimeout(() => {
      const latest = this.pendingTask.get(task.id);
      this.pendingTask.delete(task.id);
      if (latest) this.sendTask(latest.task);
    }, TASK_NOTICE_DEBOUNCE_MS);
    this.pendingTask.set(task.id, { task, timer });
  }

  private flushTask(taskId: string, task: TaskRecord): void {
    const pending = this.pendingTask.get(taskId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingTask.delete(taskId);
    }
    this.sendTask(task);
  }

  private sendTask(task: TaskRecord): void {
    const busy = this.runners.get(task.id)?.busy ?? false;
    this.options.send({ type: 'task', summary: summarize(task, busy), task, busy });
  }

  private remember(turnId: string, activity: TurnActivity): void {
    this.finished.delete(turnId);
    this.finished.set(turnId, activity);
    while (this.finished.size > FINISHED_ACTIVITY_CACHE) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }
  }
}
