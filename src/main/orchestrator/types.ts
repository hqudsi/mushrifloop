/**
 * Orchestrator types: the shared data model (src/shared/task-model.ts) plus the dependencies the state
 * machine needs injected.
 */

import type { AgentRole, AuthReading, RateLimitInfo, TaskEvent, TaskRecord, TaskStatus } from '../../shared/task-model';
import type { PermissionMode } from '../../shared/settings';
import type { StoryboardReading, VideoFile, VideoSettings } from '../../shared/video';
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
  /** Where attached files are copied (SPEC.md §10). Created on first use. */
  attachmentsDir(taskId: string): string;
  /** Remove a task folder that was never written (a new task whose files could not be copied). */
  discard(taskId: string): void;
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

/** What is in `<project>/video/` right now (SPEC.md §21.3). */
export interface KitInspection {
  /**
   * `absent` or `empty`: the template may be copied. `kit`: the marker file is there, so the folder is used
   * as it is and nothing in it is overwritten. `foreign`: files without a marker; the app does not touch it.
   */
  state: 'absent' | 'empty' | 'kit' | 'foreign';
  version: string | null;
  /** `node_modules` holds the kit's packages. */
  packagesInstalled: boolean;
  /** ffmpeg-static has been installed into the kit. */
  ffmpegInstalled: boolean;
  /** Playwright's Chromium has been downloaded into the kit. */
  chromiumDownloaded: boolean;
}

/** A command the app runs in the kit folder itself, after consent (SPEC.md §21.3 step 4). */
export type KitCommand =
  | { kind: 'install' }
  | { kind: 'tools'; downloadBrowser: boolean; ffmpeg: boolean }
  | { kind: 'doctor'; code: string };

export interface KitRunResult {
  /** Null when the process could not start or was killed. */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** The end of what it printed, for the error message. */
  tail: string;
  /** Where the whole output was saved (with the task's raw files). */
  logPath: string;
}

/** Everything a Video task needs outside the state machine (SPEC.md §21). Injected, so tests use a fake. */
export interface VideoPort {
  /** Versions of Node.js and npm, or null when one is missing. */
  prerequisites(): Promise<{ node: string | null; npm: string | null }>;
  /** "Microsoft Edge" or "Google Chrome" when one is installed; null when neither. */
  installedBrowser(): string | null;
  /** Is there an ffmpeg on PATH that has libx264? */
  ffmpegOnPath(): Promise<boolean>;
  inspectKit(projectDir: string): KitInspection;
  /** Copy the template into `<project>/video/`. Only called for `absent` or `empty`. */
  scaffold(projectDir: string): { kitVersion: string };
  run(
    command: KitCommand,
    options: { projectDir: string; logDir: string; signal: AbortSignal; onOutput: (text: string) => void },
  ): Promise<KitRunResult>;
  /** The kit's out/doctor.json, or null when it is missing or unreadable. */
  readDoctor(projectDir: string): unknown;
  /** The installed Claude Code version, for the image-check cache key; null when it cannot be read. */
  cliVersion(): Promise<string | null>;
  /** The image-check cache (SPEC.md §21.3 step 5): only passes are kept. */
  imageCheckPassed(key: string): boolean;
  recordImageCheck(key: string, at: string): void;
  forgetImageCheck(key: string): void;
  /** A code to draw into the image; random in the app. */
  newCode(): string;
  /** The storyboard as it is on disk now, checked against the schema and this task's settings (SPEC.md §21.5). */
  storyboard(projectDir: string, settings: VideoSettings): StoryboardReading;
  /** The rendered MP4 and GIF in `video/out/`, when they are there and not empty. */
  outputs(projectDir: string): { mp4: VideoFile | null; gif: VideoFile | null };
  /** The `## Video task` section for an agent's system prompt (video/prompts/). */
  prompt(agent: AgentRole): string;
}

export type TaskNotice =
  | { type: 'event'; taskId: string; event: TaskEvent }
  /** Output of a setup command of a Video task, as it arrives (SPEC.md §21.3): for the visible log. */
  | { type: 'setup_output'; taskId: string; step: 'install' | 'tools' | 'doctor'; text: string }
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
  /** Video tasks (SPEC.md §21). Without it a Video task stops with a message; coding tasks never use it. */
  video?: VideoPort;
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
