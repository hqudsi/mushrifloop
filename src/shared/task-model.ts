/**
 * The task data model, shared by the main process and the renderer (SPEC.md §4, §9): what task.json
 * holds, what events.jsonl records, and the plain data the session runner reports. Everything here is
 * JSON-serializable and free of Node types, so the renderer can use it as is.
 */

import type { EffortLevel } from './models';
import type { ApprovalMode, PermissionMode, PlannerContextMode } from './settings';
import type { RunningTotals } from './turn-cost';

// ---------------------------------------------------------------------------
// Session runner data (src/main/session-runner)
// ---------------------------------------------------------------------------

export type AgentRole = 'planner' | 'executor';

export interface RateLimitInfo {
  status: string | null;
  /** Epoch seconds. */
  resetsAt: number | null;
  rateLimitType: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /**
   * Plan utilization per window as the CLI reports it, e.g. `five_hour: { utilization: 0.2 }`
   * (a fraction). Present on CLI 2.1.273; absent on older versions (NOTES.md §14).
   */
  windows: Record<string, { utilization: number | null; resetsAt: number | null }>;
}

export interface ServedModelCheck {
  requested: string;
  /** What `init` said the session would use. */
  announced: string | null;
  /** What `modelUsage` shows actually served the turn. */
  served: string | null;
  canonical: string | null;
  contextWindow: number | null;
  /** False when a different model served the turn (SPEC.md §8) — surfaced, not treated as an error. */
  matches: boolean | null;
  /**
   * The CLI that ran the turn (`init.claude_code_version`): it decides what an alias meant (SPEC.md §8).
   * Absent in records written before 2026-09-22.
   */
  cliVersion?: string | null;
  /**
   * Other main-line models that served part of the turn, e.g. a safety-classifier fallback from Opus 5.5 to
   * Opus 4.8 (SPEC.md §8). Haiku is left out when it was not requested: Claude Code uses it for small
   * internal calls. Absent in older records.
   */
  alsoServed?: string[];
}

export interface SkillInvocation {
  skill: string;
  toolUseId: string;
  /** null while the call never got a result (e.g. the turn was killed). */
  isError: boolean | null;
  resultText: string | null;
}

export interface PermissionDenial {
  toolName: string;
  toolUseId: string | null;
  input: unknown;
}

export type TurnErrorKind =
  | 'spawn_failed' // the process could not be started
  | 'cli_version' // not started: the installed CLI is too old for the model (SPEC.md §8)
  | 'aborted' // Stop / signal
  | 'timeout' // turn timeout (SPEC.md §5.3)
  | 'rate_limited' // rate_limit_event rejected, or a 429 result (SPEC.md §17)
  | 'api_error' // terminal_reason api_error, e.g. 401
  | 'max_turns' // --max-turns reached
  | 'structured_output_failed' // the CLI gave up producing schema output
  | 'no_result' // the process ended without a result message
  | 'session_gone' // --resume found no such session: the CLI no longer has it (SPEC.md §5 net 13)
  | 'process_failed' // result says error for another reason
  | 'schema_invalid'; // a result arrived but fails our validation

export interface SurvivorInfo {
  pid: number;
  name: string | null;
  commandLine: string | null;
  /**
   * Job method only: this process was NOT in the turn's job — it started before the CLI was
   * assigned — and was found by the end-of-turn process-table check instead. Any such entry means
   * the job layer leaked.
   */
  outsideJob?: true;
}

export interface ValidationIssue {
  /** JSON pointer into the validated value, e.g. `/tests/ran`; empty string for the root. */
  path: string;
  message: string;
}

/** Base of streamed conversation events. */
interface LiveEventBase {
  /** Set when the message came from inside a subagent started by that tool call. */
  parentToolUseId?: string | null;
}

/** A compact, UI-friendly view of one stream-json message (SPEC.md §3.1), safe to send to the renderer. */
export type LiveTurnEvent =
  | (LiveEventBase & {
      kind: 'init';
      sessionId: string | null;
      model: string | null;
      tools: string[];
      skills: string[];
      slashCommands: string[];
      permissionMode: string | null;
      cwd: string | null;
      cliVersion: string | null;
    })
  | (LiveEventBase & { kind: 'text'; text: string })
  | (LiveEventBase & { kind: 'thinking' })
  | (LiveEventBase & { kind: 'tool_use'; toolUseId: string; name: string; input: unknown })
  | (LiveEventBase & { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string })
  | (LiveEventBase & { kind: 'rate_limit'; info: RateLimitInfo })
  | (LiveEventBase & {
      kind: 'api_retry';
      attempt: number | null;
      maxRetries: number | null;
      errorStatus: number | null;
      error: string | null;
    })
  | (LiveEventBase & { kind: 'result'; subtype: string | null; isError: boolean })
  | (LiveEventBase & { kind: 'other'; type: string; subtype: string | null })
  | { kind: 'slow_turn'; elapsedMs: number; thresholdMs: number }
  | { kind: 'stderr'; text: string }
  | { kind: 'unparsed'; line: string };

// ---------------------------------------------------------------------------
// Orchestrator data (src/main/orchestrator)
// ---------------------------------------------------------------------------

export interface TurnTrace {
  /** Normalized changed-file set. */
  files: string[];
  /** The Planner instruction the turn carried out; null for a turn that only answered the user. */
  instruction: string | null;
}


/** SPEC.md §4. A pause is `waiting_user` with `waiting.kind === 'paused'` (there is no separate status). */
export type TaskStatus =
  | 'draft'
  | 'running'
  | 'waiting_user'
  | 'done'
  | 'failed'
  | 'error'
  | 'rate_limited'
  | 'account_mismatch'
  | 'stopped';

/** Statuses the loop can leave only through Resume (SPEC.md §6). */
export const RESUMABLE_STATUSES: readonly TaskStatus[] = ['stopped', 'error', 'rate_limited', 'account_mismatch'];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed'];

/**
 * Statuses where a message reopens the task and starts a Planner turn straight away (SPEC.md §4).
 *
 * `rate_limited` and `account_mismatch` are deliberately not here: the task stopped for a reason a
 * message cannot fix, so the message waits for Resume — which re-checks the account — rather than
 * spending a turn that would fail the same way.
 */
export const FOLLOW_UP_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'stopped', 'error'];

/** A task that can take a message at all: everything except a draft that has not started. */
export function acceptsMessage(status: TaskStatus): boolean {
  return status !== 'draft';
}

// ---------------------------------------------------------------------------
// Structured agent output (schemas/)
// ---------------------------------------------------------------------------

export interface PlannerOutput {
  status: 'continue' | 'done' | 'blocked' | 'needs_user' | 'plan_ready';
  reasoning_summary: string;
  next_instruction?: string;
  question?: string;
  final_report?: string;
  use_skills?: string[];
  request_executor_rollover?: boolean;
}

export interface ExecutorOutput {
  status: 'ok' | 'failed' | 'needs_input';
  /** Short prose: what was done and the outcome. */
  summary: string;
  /** The exact text the instruction asked for, one item per line (SPEC.md §4, since 2026-09-17). */
  evidence?: string;
  changed_files: Array<{ path: string; change: 'added' | 'modified' | 'deleted'; note?: string }>;
  tests: { ran: boolean; passed?: number; failed?: number; notes?: string };
  problems: string[];
  question?: string;
}

export interface HandoffSummary {
  task_restatement: string;
  done_so_far: string[];
  remaining: string[];
  decisions: string[];
  constraints: string[];
  open_problems: string[];
  key_files: string[];
}

// ---------------------------------------------------------------------------
// task.json
// ---------------------------------------------------------------------------

export interface AgentConfig {
  model: string;
  effort: EffortLevel | null;
}

/**
 * How a model or effort change on a task that is under way is applied (SPEC.md §6, decided 2026-09-22).
 * - `same_session`: the agent's next turn resumes its session on the new model; the conversation is kept.
 * - `fresh_session`: the agent is rolled over first — its session writes a handoff on the old model —
 *   and the new model starts from the summary.
 */
export type ModelChangeMode = 'same_session' | 'fresh_session';

/** "Task settings" on a task that is under way (SPEC.md §6). Absent fields are left as they are. */
export interface ConfigUpdate {
  maxCycles?: number;
  requiredSkills?: string[];
  autoBranchAndCommit?: boolean;
  rolloverPercent?: number;
  /** From the next turn (SPEC.md §6, added 2026-09-26). */
  turnTimeoutMs?: number;
  slowTurnMs?: number;
  maxTurnsPerSession?: number;
  /** null = off. */
  freshExecutorAfterRejectedTurns?: number | null;
  planner?: AgentConfig;
  executor?: AgentConfig;
  /** For a model or effort change; `same_session` when absent. */
  apply?: ModelChangeMode;
}

/** One field of a `config_changed` event: what it was and what it is now. */
export type ConfigChangeEntry =
  | { field: 'maxCycles' | 'rolloverPercent' | 'turnTimeoutMs' | 'slowTurnMs' | 'maxTurnsPerSession'; from: number; to: number }
  | { field: 'freshExecutorAfterRejectedTurns'; from: number | null; to: number | null }
  | { field: 'requiredSkills'; from: string[]; to: string[] }
  | { field: 'autoBranchAndCommit'; from: boolean; to: boolean }
  | {
      field: 'model';
      agent: AgentRole;
      from: AgentConfig;
      to: AgentConfig;
      /** `first_session` when the agent had no session yet, so there was nothing to choose between. */
      apply: ModelChangeMode | 'first_session';
    };

/** Everything a task runs with, fixed at creation except where noted (SPEC.md §11). */
export interface TaskConfig {
  planner: AgentConfig;
  executor: AgentConfig;
  maxCycles: number;
  turnTimeoutMs: number;
  /** SPEC.md §5 net 8. */
  slowTurnMs: number;
  maxTurnsPerSession: number;
  approvalMode: ApprovalMode;
  /** Fixed at creation (SPEC.md §3.1). */
  plannerContextMode: PlannerContextMode;
  /** Editable; applies to new sessions only (SPEC.md §6). */
  standingInstructions: Record<AgentRole, string>;
  rolloverPercent: number;
  /** Fresh Executor session after this many consecutive turns with refused answers; null = off (SPEC.md §15). */
  freshExecutorAfterRejectedTurns: number | null;
  requiredSkills: string[];
  autoBranchAndCommit: boolean;
  executorTools: string[];
  executorDisallowedTools: string[];
  permissionMode: PermissionMode;
}

/** A `claude auth status --json` identity (SPEC.md §3.6). */
export interface AccountRecord {
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
  apiKeySource: string | null;
}

export interface PinnedAccount extends AccountRecord {
  pinnedAt: string;
}

export type AuthReading =
  | { ok: true; loggedIn: boolean; account: AccountRecord }
  | { ok: false; error: string };

export interface RetiredSession {
  sessionId: string;
  retiredAt: string;
  reason: string;
  turns: number;
}

export interface AgentSession {
  /** Minted by the app before the process exists (SPEC.md §5 net 5). */
  sessionId: string;
  /** The CLI has created this session (an `init` was seen), so the next turn uses `--resume`. */
  established: boolean;
  /**
   * The system prompt this session was started with. Kept for the session's lifetime: standing
   * instructions apply to new sessions only (SPEC.md §6), and a stable prompt keeps the cache warm.
   * Null until the session's first turn is launched.
   */
  systemPrompt: string | null;
  startedAt: string | null;
  /** Turns that completed (successfully or not) in this session. */
  turns: number;
  /** SPEC.md §15: the last turn's context size. */
  lastContextTokens: number | null;
  /** Model that served the last turn (for the rollover threshold). */
  lastModel: string | null;
  /** Set when a rollover must happen before this agent's next turn (Planner request or "Roll over now"). */
  rolloverRequested: string | null;
  /** Handoff turns already spent on the rollover being attempted (SPEC.md §15); 0 or absent when none. */
  handoffAttempts?: number;
  /**
   * The handoff failed, so this session was kept and automatic rollovers are not tried again for it
   * (SPEC.md §15). "Roll over now" clears it. Absent in older records.
   */
  rolloverBlocked?: { reason: string; at: string } | null;
  /** Handoff text prepended to the first prompt of a session that replaced a rolled-over one. */
  seed: string | null;
  /**
   * The model and effort this session's latest turn was launched with. A handoff is written by that model,
   * whatever the task is set to now (SPEC.md §6, §15). Absent in records written before 2026-09-22.
   */
  launchedWith?: AgentConfig | null;
  retired: RetiredSession[];
}

export type PlannerPurpose =
  | 'start'
  | 'executor_report'
  | 'user_message'
  | 'answer'
  | 'refusal'
  | 'plan_decision'
  | 'instruction_rejected';

interface StepBase {
  /** Exactly what goes on stdin (before a retry note or rollover seed is added). */
  prompt: string;
  /** Set after a failed or interrupted attempt; prefixed to the prompt on the next attempt. */
  retryNote: string | null;
}

export interface PlannerStep extends StepBase {
  agent: 'planner';
  purpose: PlannerPurpose;
}

export interface ExecutorStep extends StepBase {
  agent: 'executor';
  purpose: 'instruction' | 'user_message';
  /** The Planner's instruction (possibly edited by the user), or null for a bare user message. */
  instruction: string | null;
  useSkills: string[];
  /** Text the user sent the executor with this step. */
  userMessage: string | null;
  /** Review mode: the instruction still has to be approved before it may run (SPEC.md §7). */
  needsApproval: boolean;
  /** Planner text to deliver together with this turn's report (a report the Planner has not seen yet). */
  carryToPlanner: string | null;
  /** The Planner's reasoning for this instruction, for the approval card. */
  reasoning: string | null;
  /** Assigned when the step is first dispatched; a retry keeps its number. */
  cycle: number | null;
}

export type NextStep = PlannerStep | ExecutorStep;

export type WaitingState =
  | { kind: 'question'; plannerStatus: 'needs_user' | 'blocked'; question: string; since: string }
  | { kind: 'plan_approval'; plan: string; since: string }
  | { kind: 'instruction_approval'; instruction: string; useSkills: string[]; reasoning: string | null; since: string }
  | { kind: 'possible_loop'; reason: string; since: string }
  | { kind: 'paused'; cause: 'user' | 'daily_cap'; reason: string; since: string }
  | {
      /**
       * Required skills that cannot run here for an environmental reason (SPEC.md §16): the user may
       * waive each one for this task. `after` says what happens once all are waived: `finish` (the
       * Planner had answered done; `finalReport` is kept) or `continue` (deliver the pending step).
       */
      kind: 'skill_waiver';
      skills: SkillBlock[];
      after: 'finish' | 'continue';
      finalReport: string | null;
      since: string;
    };

/** A required skill that cannot run in this environment, and why. */
export interface SkillBlock {
  skill: string;
  reason: string;
}

export interface SkillWaiver extends SkillBlock {
  /** What the user wrote when waiving, if anything. */
  note: string | null;
  at: string;
}

export interface GitState {
  /** The task's "auto-branch and commit" setting. */
  enabled: boolean;
  /** False when the project is not a git repository: the setting is inert (SPEC.md §18). */
  isRepo: boolean;
  branch: string | null;
  originalBranch: string | null;
  startCommit: string | null;
  hasRemote: boolean;
  /** Paths that were already modified when the task started; they go into the snapshot commit. */
  dirtyAtStart: string[];
  /**
   * The user's pre-existing uncommitted work, committed on the task branch before cycle 1
   * ("<slug> snapshot before task", decided 2026-09-16) — the task's starting point. Null when the
   * tree was clean.
   */
  snapshot: { hash: string; files: string[]; at: string } | null;
  /** The snapshot step has run (committed or found nothing), so setup does not repeat it. */
  snapshotDone: boolean;
  /** Why git is not used, when it is not. */
  inertReason: string | null;
}

export interface SkillState {
  /** Skill names the Executor can invoke (SPEC.md §16); null until discovered. */
  available: string[] | null;
  discoveredFrom: 'init_probe' | 'executor_init' | null;
  /** Required skills that an Executor turn has run successfully. */
  satisfied: string[];
  /** The latest outcome per skill, in words (for refusal messages). */
  lastStates: Record<string, string>;
  /** Required skills the user explicitly waived for this task only (never automatic). */
  waived: SkillWaiver[];
}

export interface LoopState {
  /** Normalized last dispatched Planner instruction (SPEC.md §5 net 2). */
  lastInstruction: string | null;
  /** The most recent consecutive Executor turns (files + instruction), newest last. */
  recentTurns: TurnTrace[];
  /** Consecutive Planner turns that were refused (done without required skills, plan-first violations). */
  refusals: number;
  /** Consecutive Executor turns (in the current session) with refused structured answers (SPEC.md §15). */
  rejectedStreak: number;
  /**
   * The turn that failed with a service error and is being retried once (SPEC.md §5 net 12); cleared when
   * the retry has run, and by any Resume. Absent in older records.
   */
  serviceRetry?: ServiceRetryState | null;
  /** Changed requests already spent on the current step after a refused-answer failure (SPEC.md §5 net 11). */
  answerRetries?: number;
}

export interface ServiceRetryState {
  turnId: string;
  agent: AgentRole;
  /** When the retry is due (ISO). */
  retryAt: string;
}

export interface RateLimitState {
  /** Epoch seconds. */
  resetsAt: number | null;
  rateLimitType: string | null;
  message: string;
  autoResumeAt: string | null;
  /**
   * Auto-resume came due while another task was running, so it did not start this one (tasks run one at a
   * time, SPEC.md §6). Not retried on its own; the user resumes.
   */
  autoResumeSkipped?: { at: string; blockedBy: { taskId: string; title: string } } | null;
}

export interface TaskRecord {
  schemaVersion: 1;
  id: string;
  description: string;
  /**
   * A name the user gave the task (SPEC.md §10). Null or absent: the task is shown by the first line of
   * its description, as before. The description itself is never changed by a rename.
   */
  title?: string | null;
  projectDir: string;
  /** The Planner's cwd — fixed for the task's lifetime (SPEC.md §3.1). */
  plannerCwd: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  statusReason: string | null;
  statusChangedAt: string;
  config: TaskConfig;
  /** Written once, at creation; never changed (SPEC.md §3.6 rule 7). */
  pinnedAccount: PinnedAccount;
  /** The live account at the last mismatch, for the pinned-vs-live view. */
  liveAccount: AuthReading | null;
  sessions: Record<AgentRole, AgentSession>;
  /**
   * The running totals each session last reported, by session id (SPEC.md §15): a turn's own cost is the
   * difference. Absent in tasks made before 2026-09-27; those are read from their turn events once.
   */
  sessionTotals?: Record<string, RunningTotals>;
  /** Executor turns dispatched (SPEC.md §5 net 1). */
  cycles: number;
  plannerTurns: number;
  /** Task setup (git branch, skill discovery) has completed. */
  setupDone: boolean;
  /** What runs next when the task is running. */
  next: NextStep | null;
  waiting: WaitingState | null;
  /** A question or approval that was pending when the task was stopped; Resume brings it back. */
  parkedWaiting: WaitingState | null;
  /** A turn whose output was saved but not acted on, because the account changed during it (§3.6 rule 8). */
  deferredTurn: TurnRecord | null;
  /** The last turn whose output was acted on — lets crash recovery find a turn that was saved but not processed. */
  lastProcessedTurnId: string | null;
  /** plan_first: the user approved the plan; the task now runs as `auto` (SPEC.md §7). */
  planApproved: boolean;
  skills: SkillState;
  git: GitState;
  loop: LoopState;
  rateLimit: RateLimitState | null;
  /** Local day (YYYY-MM-DD) on which the user resumed past the soft daily token cap. */
  capOverrideDay: string | null;
  finalReport: string | null;
  /**
   * A message reopened a finished task (SPEC.md §4), so the Planner's next instruction is shown
   * for approval whatever the approval mode is. Cleared by the answer that consumes it.
   */
  followUpApproval: boolean;
  /** Messages waiting for the current turn to end. They all go to the Planner (SPEC.md §6). */
  queuedMessages: Array<{ text: string; at: string }>;
  /**
   * Orchestrator notes waiting for the Planner (an approval-mode change, SPEC.md §7). The next Planner
   * turn to spawn carries them at the top of its prompt.
   */
  plannerNotes: string[];
}

// ---------------------------------------------------------------------------
// events.jsonl
// ---------------------------------------------------------------------------

export interface TurnErrorRecord {
  kind: TurnErrorKind;
  message: string;
  rawText: string;
  validationIssues?: ValidationIssue[];
  apiErrorStatus?: number | null;
  terminalReason?: string | null;
  resetsAt?: number | null;
}

/**
 * The CLI's schema check refused the agent's structured answer (a `StructuredOutput` call answered with
 * `is_error`), and the model tried again (SPEC.md §3.5). Counted from the stream; the reasons are the
 * CLI's text, for display only.
 */
export interface AnswerRejections {
  count: number;
  /** The CLI's reasons, in order, without repeats. */
  reasons: string[];
  /** Size (as JSON) of the largest refused attempt. */
  largestAttemptChars: number;
}

/**
 * A turn with refused answers or an accepted answer with leaked tool-call markup, and what that means for
 * the answer that was accepted (SPEC.md §4).
 */
export interface AnswerCheck extends AnswerRejections {
  /** Size (as JSON) of the accepted answer; null when none was accepted. */
  acceptedChars: number | null;
  /** The accepted answer is short, much smaller than what was refused, or has leaked markup (SPEC.md §4). */
  possiblyTruncated: boolean;
  /** A text field of the accepted answer holds a `<parameter` tag (SPEC.md §3.5). Absent in older records. */
  leakedMarkup?: boolean;
}

/** A finished turn, reduced to what the timeline and the state machine need. */
export interface TurnRecord {
  turnId: string;
  agent: AgentRole;
  purpose: PlannerPurpose | ExecutorStep['purpose'] | 'handoff';
  cycle: number | null;
  sessionId: string;
  resumed: boolean;
  /** The process got as far as creating the session (an `init` or a result was seen). */
  sessionCreated: boolean;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  ok: boolean;
  output: unknown;
  error: TurnErrorRecord | null;
  slow: boolean;
  slowTurnMs: number | null;
  processes: { method: 'job' | 'tree' | 'none'; count: number; survivors: SurvivorInfo[]; errors: string[] };
  model: ServedModelCheck;
  usage: {
    contextTokens: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    numTurns: number | null;
    /** This turn's own cost (SPEC.md §15). In records made before 2026-09-27: the session's running total. */
    costUsd: number | null;
    /** This turn's own per-model usage; before 2026-09-27, the session's running totals. */
    modelUsage: Record<string, unknown>;
    /** The CLI's `total_cost_usd` as reported: the session's running total. Absent before 2026-09-27. */
    sessionCostUsd?: number | null;
    /** The CLI's `modelUsage` as reported. Absent before 2026-09-27. */
    sessionModelUsage?: Record<string, unknown>;
  } | null;
  permissionDenials: PermissionDenial[];
  skillInvocations: SkillInvocation[];
  /** Skills announced by this turn's `init` (Executor only), for discovery. */
  init: { skills: string[]; slashCommands: string[] } | null;
  rateLimit: RateLimitInfo | null;
  resultText: string | null;
  rawPath: string;
  stderrPath: string;
  systemPromptPath: string;
  /** SPEC.md §3.6 rule 8: the live account no longer matched when the turn ended. */
  accountChanged: boolean;
  /** Refused structured answers (SPEC.md §5 net 11); null when there were none. Absent in older records. */
  answerCheck?: AnswerCheck | null;
  /** Main-thread tool calls by tool name, the answer tool left out. Absent in older records. */
  toolUses?: Record<string, number>;
}

export type SkillOutcomeState = 'ok' | 'failed' | 'no_result' | 'not_invoked' | 'skipped_no_remote';

export interface SkillOutcome {
  skill: string;
  requested: boolean;
  state: SkillOutcomeState;
}

export type CommitInfo =
  | { state: 'committed'; hash: string; message: string; files: string[] }
  | { state: 'nothing_to_commit' }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; error: string };

/** Data for one cycle card (SPEC.md §10), written after the Executor turn is processed. */
export interface CycleSummary {
  cycle: number;
  turnId: string;
  instruction: string | null;
  userMessage: string | null;
  useSkills: string[];
  executorStatus: ExecutorOutput['status'] | null;
  changedFiles: string[];
  skillOutcomes: SkillOutcome[];
  commit: CommitInfo;
  slow: boolean;
  durationMs: number;
  killedProcesses: number;
  permissionDenials: PermissionDenial[];
  modelMismatch: { requested: string; served: string | null } | null;
  accountChanged: boolean;
  /** Refused answers in this cycle's Executor turn; `possiblyTruncated` means the cycle is not a clean ok. */
  answerCheck?: AnswerCheck | null;
}

export type LoopKind = 'identical_instruction' | 'file_ping_pong' | 'repeated_refusals';

/** Why the orchestrator refused a Planner answer (SPEC.md §5 net 10). */
export type RefusalReason = 'required_skills' | 'plan_not_approved' | 'malformed_answer';

export type InterventionKind =
  | 'message'
  | 'answer'
  | 'approve_instruction'
  | 'reject_instruction'
  | 'approve_plan'
  | 'reject_plan'
  | 'pause'
  | 'stop'
  | 'resume'
  | 'standing_instructions'
  | 'rollover_now'
  | 'waive_skill'
  | 'decline_waiver';

type EventBody =
  | { type: 'task_created'; description: string; projectDir: string; config: TaskConfig; pinnedAccount: PinnedAccount }
  | { type: 'status'; from: TaskStatus; to: TaskStatus; reason: string | null; waiting: WaitingState | null }
  | { type: 'setup'; git: GitState; skills: string[] | null; skillsError: string | null; missingRequiredSkills: string[] }
  | {
      type: 'turn_started';
      turnId: string;
      agent: AgentRole;
      purpose: TurnRecord['purpose'];
      cycle: number | null;
      sessionId: string;
      resumed: boolean;
      model: string;
      effort: EffortLevel | null;
      prompt: string;
    }
  | ({ type: 'turn' } & TurnRecord)
  | ({ type: 'cycle' } & CycleSummary)
  | { type: 'account_mismatch'; when: 'before_spawn' | 'after_turn' | 'resume'; pinned: PinnedAccount; live: AuthReading; turnId: string | null }
  | { type: 'refused'; reason: RefusalReason; detail: string; missing: string[] }
  | { type: 'loop_detected'; kind: LoopKind; detail: string; similarity?: number | null }
  /** The Planner stopped the loop (done, a question, a plan) while user messages were waiting: its answer was held. */
  | { type: 'decision_held'; plannerStatus: PlannerOutput['status']; queued: number }
  | { type: 'skill_waived'; skill: string; reason: string; note: string | null }
  | { type: 'skill_waiver_declined'; skills: SkillBlock[]; message: string }
  | { type: 'rollover'; agent: AgentRole; oldSessionId: string; newSessionId: string; reason: string; summary: HandoffSummary | null }
  | { type: 'rollover_requested'; agent: AgentRole; reason: string }
  /** The CLI no longer had the session, so the agent started again from a seed (SPEC.md §5 net 13). */
  | { type: 'session_restarted'; agent: AgentRole; oldSessionId: string; newSessionId: string; reason: string }
  /** The handoff failed, so the session was kept and the rollover skipped (SPEC.md §15). */
  | { type: 'rollover_skipped'; agent: AgentRole; reason: string; attempts: number }
  /** After a refused-answer failure the step was sent again with a changed request (SPEC.md §5 net 11). */
  | { type: 'answer_retry'; agent: AgentRole; purpose: TurnRecord['purpose']; turnId: string; attempt: number; variation: string; refusals: number }
  | { type: 'intervention'; kind: InterventionKind; to?: AgentRole; text?: string; edited?: boolean }
  | { type: 'rate_limit'; status: string; resetsAt: number | null; rateLimitType: string | null; turnId: string }
  | { type: 'auto_resume_scheduled'; at: string }
  | { type: 'auto_resume_skipped'; blockedBy: { taskId: string; title: string } }
  /**
   * A service error and its one retry (SPEC.md §5 net 12): `retrying` for the failed attempt (with the
   * time the retry is due), then `recovered` or `failed` for the retried turn (`retryOf` is the first one).
   */
  | {
      type: 'service_retry';
      outcome: 'retrying' | 'recovered' | 'failed';
      agent: AgentRole;
      purpose: TurnRecord['purpose'];
      turnId: string;
      retryOf: string | null;
      errorKind: TurnErrorKind | null;
      apiErrorStatus: number | null;
      message: string | null;
      retryAt: string | null;
    }
  /** The CLI refused structured answers during this turn (SPEC.md §5 net 11). */
  | ({ type: 'structured_output_rejected'; turnId: string; agent: AgentRole; purpose: TurnRecord['purpose']; cycle: number | null } & AnswerCheck)
  /** The user changed the approval mode of a running task; applies from the Planner's next instruction (SPEC.md §7). */
  | { type: 'approval_mode_changed'; from: ApprovalMode; to: ApprovalMode }
  /** "Task settings" changed on a task under way (SPEC.md §6). */
  | { type: 'config_changed'; changes: ConfigChangeEntry[] }
  /** The user renamed the task (SPEC.md §10); null = no name, shown by its description. */
  | { type: 'renamed'; from: string | null; to: string | null }
  | { type: 'commit'; cycle: number | null; purpose: 'cycle' | 'before_review' | 'snapshot'; info: CommitInfo }
  | { type: 'done'; finalReport: string }
  | { type: 'recovered'; detail: string };

export type TaskEvent = EventBody & { seq: number; ts: string };
export type NewTaskEvent = EventBody;
