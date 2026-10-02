/**
 * Orchestrator types: the shared data model (src/shared/task-model.ts) plus the dependencies the state
 * machine needs injected.
 */

import type { AgentRole, AuthReading, RateLimitInfo, TaskEvent, TaskRecord, TaskStatus } from '../../shared/task-model';
import type { PermissionMode } from '../../shared/settings';
import type { TurnEvent, TurnOutcome, TurnSpec } from '../session-runner/types';

export * from '../../shared/task-model';

// ---------------------------------------------------------------------------
// Dependencies (injected, so the state machine runs without Electron or the CLI)
// ---------------------------------------------------------------------------

export interface GitInspection {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  hasRemote: boolean;
  dirty: string[];
}

export interface GitOps {
  inspect(dir: string): Promise<GitInspection>;
  /** Create `name` from HEAD and switch to it; if it already exists, switch to it. */
  switchToBranch(dir: string, name: string): Promise<void>;
  currentBranch(dir: string): Promise<string | null>;
  hasRemote(dir: string): Promise<boolean>;
  /** Stage everything and commit. `committed: false` when there was nothing to commit. */
  commitAll(dir: string, message: string): Promise<{ committed: boolean; hash: string | null; files: string[] }>;
}

export interface InitProbeResult {
  skills: string[];
  slashCommands: string[];
}

export interface TaskStorePort {
  createFolders(taskId: string): void;
  plannerCwd(taskId: string): string;
  rawDir(taskId: string): string;
  writeTask(task: TaskRecord): void;
  appendEvent(taskId: string, event: TaskEvent): void;
  /** All events, in order (a task made before `sessionTotals` existed is read once, SPEC.md §15). */
  readEvents(taskId: string): TaskEvent[];
  /** Whether a turn's raw stdout contains the `init` line (crash recovery). */
  rawHasInit(rawPath: string): boolean;
}

export interface UsageLedgerPort {
  record(at: Date, modelUsage: Record<string, unknown>): void;
  recordWindows(at: Date, info: RateLimitInfo): void;
  tokensOn(day: string): number;
}

export type TaskNotice =
  | { type: 'event'; taskId: string; event: TaskEvent }
  | { type: 'turn_event'; taskId: string; agent: AgentRole; turnId: string; event: TurnEvent }
  | { type: 'task'; task: TaskRecord };

export interface TaskNotification {
  taskId: string;
  status: TaskStatus;
  title: string;
  body: string;
}

export interface OrchestratorDeps {
  runTurn(spec: TurnSpec): Promise<TurnOutcome>;
  /** Free `init` probe with the Executor's configuration (SPEC.md §16). Throws on failure. */
  probeInit(input: { cwd: string; tools: readonly string[]; disallowedTools: readonly string[]; permissionMode: PermissionMode; model: string }): Promise<InitProbeResult>;
  /** `claude auth status --json`, never cached (SPEC.md §3.6). Never throws. */
  authStatus(): Promise<AuthReading>;
  git: GitOps;
  store: TaskStorePort;
  usage: UsageLedgerPort | null;
  rolePrompt(agent: AgentRole): string;
  now(): Date;
  newSessionId(): string;
  newTurnId(agent: AgentRole): string;
  /** Run `fn` at epoch-ms `at`; returns a cancel function. */
  schedule(at: number, fn: () => void): () => void;
  notify?(notification: TaskNotification): void;
  /**
   * Auto-resume at reset is due. The host runs it through the same one-task-at-a-time check as any other
   * start (SPEC.md §6, §17) and calls `autoResumeBlocked` when it may not start. Without a host (the CLI
   * tools run one task) the runner resumes itself.
   */
  autoResume?(taskId: string): void;
  onNotice?(notice: TaskNotice): void;
  general: { autoResumeAtReset: boolean; softDailyTokenCap: number | null };
  /** The wait before retrying a turn that failed with a service error (SPEC.md §5 net 12); default 60 s. */
  serviceRetryDelayMs?: number;
}
