/**
 * Types for the session runner (SPEC.md §12 phase 2): one agent turn = one `claude -p` process.
 */

import type { EffortLevel } from '../../shared/models';
import type { RunningTotals } from '../../shared/turn-cost';
import type { PermissionMode } from '../../shared/settings';
import type { ProcessCleanupReport, ProcessGuardFactory } from '../process-guard';
import type { SchemaKind, ValidationIssue } from '../schema-validator';
import type {
  AgentRole,
  AnswerRejections,
  LiveTurnEvent,
  PermissionDenial,
  RateLimitInfo,
  ServedModelCheck,
  SkillInvocation,
  TurnErrorKind,
} from '../../shared/task-model';

export type { AgentRole, AnswerRejections, PermissionDenial, RateLimitInfo, ServedModelCheck, SkillInvocation, TurnErrorKind };

/** Everything that defines one turn. The runner applies the SPEC.md §3.1 flag rules on top. */
export interface TurnSpec {
  agent: AgentRole;
  /** Sent on stdin, never as an argument (NOTES.md §1). */
  prompt: string;
  /** Continue this session. Omit for a new session. */
  resumeSessionId?: string;
  /** Id for a *new* session, minted by the caller so it can be persisted first (SPEC.md §5.5). Generated if omitted. */
  newSessionId?: string;
  model: string;
  /** Ignored (not passed) for models without effort control. */
  effort: EffortLevel | null;
  cwd: string;
  /**
   * Built-in tools the agent may use (`--tools`). Planner: `[]`, or Read/Glob/Grep in read-only mode.
   * Executor: the settings list; entries may carry permission patterns such as `Bash(git *)`.
   */
  tools: readonly string[];
  /** Executor only: `--disallowedTools`. */
  disallowedTools?: readonly string[];
  /** Executor only. Defaults to `dontAsk` (SPEC.md §3.1). */
  permissionMode?: PermissionMode;
  /**
   * The complete system-prompt text for this turn. The planner's replaces Claude Code's default
   * (`--system-prompt-file`); the executor's is appended (`--append-system-prompt-file`).
   * Composition (role prompt + standing instructions + skills list) is the caller's job.
   */
  systemPrompt: string;
  /**
   * Which schema the final answer must satisfy. `null` starts a plain Executor session — no
   * `--json-schema`, no system prompt (`systemPrompt` is ignored), the final text is the output. Only the
   * evaluation harness's baseline uses it (SPEC.md §19.7); the app never does.
   */
  schema: SchemaKind | null;
  maxTurns: number;
  /** Hard limit: the process tree is killed (SPEC.md §5.3). */
  timeoutMs: number;
  /**
   * Soft limit (SPEC.md §5, safety net 8): past this the turn keeps running but is marked slow,
   * and a `slow_turn` event is emitted once. Omit to disable.
   */
  slowTurnMs?: number;
  /**
   * The session's running totals after its last turn that reported them (SPEC.md §15): the turn's own cost
   * is the difference. Null or omitted for a new session.
   */
  previousTotals?: RunningTotals | null;
  /** Folder for this turn's raw files (SPEC.md §9: tasks/<id>/raw). */
  rawDir: string;
  /** Names the raw files; generated if omitted. */
  turnId?: string;
  onEvent?: (event: TurnEvent) => void;
  /** Aborting kills the process tree (SPEC.md §6 Stop). */
  signal?: AbortSignal;
}

/** How to reach the CLI. Built once from settings (claude-cli.ts). */
export interface CliVersionReading {
  version: string | null;
  error: string | null;
}

export interface RunnerContext {
  binary: string;
  /** Arguments placed before the CLI flags — lets tests run a fake CLI through `node`. */
  binaryArgs?: readonly string[];
  env: NodeJS.ProcessEnv;
  /**
   * The installed CLI's version, read before a turn for a model with a minimum version spawns
   * (SPEC.md §8). Cached per binary until the binary file changes.
   */
  cliVersion(): Promise<CliVersionReading>;
  /**
   * Keeps anything a turn starts from outliving it (SPEC.md §5, safety net 9).
   * Without one, the outcome reports `processes.method: 'none'`.
   */
  processGuard?: ProcessGuardFactory;
}

// ---------------------------------------------------------------------------
// Streamed events (a compact, UI-friendly view of stream-json)
// ---------------------------------------------------------------------------

/**
 * A streamed event: the renderer-safe shape (`LiveTurnEvent`, src/shared/task-model.ts) plus the original
 * stream-json message in `raw` (absent for events the runner makes itself).
 */
export type TurnEvent = LiveTurnEvent extends infer E
  ? E extends { kind: 'slow_turn' | 'stderr' | 'unparsed' }
    ? E & { raw?: undefined }
    : E & { raw: unknown }
  : never;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TurnUsage {
  /**
   * Tokens occupying the context at the end of the turn: the LAST API call's
   * input + cache_creation + cache_read (SPEC.md §15). Null if the CLI did not report it.
   */
  contextTokens: number | null;
  /** Summed over every API call in the turn — work done, not context size. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number | null;
  /** This turn's own cost: the session's running total minus the one before this turn (SPEC.md §15). */
  costUsd: number | null;
  /** This turn's own per-model usage, the same way (use for the usage estimate, SPEC.md §17). */
  modelUsage: Record<string, unknown>;
  /** The CLI's `total_cost_usd` as reported: the session's running total. */
  sessionCostUsd: number | null;
  /** The CLI's `modelUsage` as reported: the session's running totals. */
  sessionModelUsage: Record<string, unknown>;
}

export interface TurnError {
  kind: TurnErrorKind;
  message: string;
  /** The raw text behind the failure: the result text, the offending JSON, or stderr (SPEC.md §3.5). */
  rawText: string;
  validationIssues?: ValidationIssue[];
  apiErrorStatus?: number | null;
  terminalReason?: string | null;
  subtype?: string | null;
  /** Epoch seconds, for rate limits. */
  resetsAt?: number | null;
}

interface TurnOutcomeBase {
  turnId: string;
  agent: AgentRole;
  /** The session this turn ran in (new or resumed). */
  sessionId: string;
  resumed: boolean;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  /** Raw stdout (stream-json), exactly as received (SPEC.md §9). */
  rawPath: string;
  stderrPath: string;
  systemPromptPath: string;
  /** The CLI arguments used (the prompt is not among them; it went on stdin). */
  args: string[];
  /**
   * What the `init` event announced; null when the process never got that far — then the CLI has not
   * created the session either (NOTES.md §16: a session exists once `init` was emitted).
   */
  init: { sessionId: string | null; model: string | null; skills: string[]; slashCommands: string[] } | null;
  usage: TurnUsage | null;
  model: ServedModelCheck;
  permissionDenials: PermissionDenial[];
  skillInvocations: SkillInvocation[];
  /** Structured answers the CLI refused before one was accepted (SPEC.md §3.5). */
  answerRejections: AnswerRejections;
  /** Main-thread tool calls by tool name, not counting the answer tool. */
  toolUses: Record<string, number>;
  /** The most recent rate-limit status seen during the turn. */
  rateLimit: RateLimitInfo | null;
  /** The turn ran past its slow-turn threshold (SPEC.md §5 net 8). The turn itself is unaffected. */
  slow: boolean;
  slowTurnMs: number | null;
  /** What the process guard found and killed when the turn ended (SPEC.md §5 net 9). */
  processes: ProcessCleanupReport;
  resultText: string | null;
}

export interface TurnSuccess<T = unknown> extends TurnOutcomeBase {
  ok: true;
  output: T;
}

export interface TurnFailure extends TurnOutcomeBase {
  ok: false;
  error: TurnError;
}

export type TurnOutcome<T = unknown> = TurnSuccess<T> | TurnFailure;
