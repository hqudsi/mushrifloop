/**
 * The orchestrator state machine (SPEC.md §4) with its safety nets (§5), interventions (§6), approval
 * modes (§7), rollover (§15), skill enforcement (§16), rate limits (§17), account pinning (§3.6) and git
 * policy (§18).
 *
 * Pure with respect to Electron and the CLI: every process, clock and id comes through
 * `OrchestratorDeps`, so the whole loop runs in unit tests against a scripted fake runner.
 *
 * Control flow is driven only by schema-validated agent output and the runner's typed outcome.
 * Every status change is appended to events.jsonl and written to task.json before the next process
 * starts (§5 net 5).
 *
 * One TaskRunner drives one task. `task.next` is the loop's program counter: the step that runs when the
 * task is running. A failed turn leaves it in place, so Resume retries exactly that step.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APP_SLUG } from '../../shared/app-config';
import { getModel, isEffortValid } from '../../shared/models';
import { FRESH_EXECUTOR_MAX_TURNS, type ApprovalMode } from '../../shared/settings';
import { turnShareReader, type RunningTotals } from '../../shared/turn-cost';
import { PLANNER_READ_ONLY_TOOLS } from '../session-runner/args';
import type { TurnOutcome, TurnSpec } from '../session-runner/types';
import type { SchemaKind } from '../schema-validator';
import { compareAccount, describeAccount, pinAccount } from './account';
import { checkAnswer } from './answer-check';
import { isServiceError } from '../session-runner/classify';
import {
  answerBlock,
  approvalModeNote,
  composeStdin,
  executorPrompt,
  executorReportPrompt,
  followUpNote,
  handoffRequest,
  heldDecisionNote,
  instructionRejected,
  answerRetryNote,
  loopPauseNote,
  malformedAnswerRefusal,
  planApproved,
  planFirstRefusal,
  planRejected,
  plannerStartPrompt,
  requiredSkillsRefusal,
  retryNote,
  rolloverSkippedNote,
  type AnswerRetryVariation,
  skillWaivedNote,
  skillWaiverDeclined,
  waiverReason,
  restartSeed,
  rolloverSeed,
  shortSummary,
  systemPromptFor,
  unsentInstructionNote,
  userMessageBlock,
} from './prompts';
import {
  MAX_CONSECUTIVE_REFUSALS,
  isRepeatedInstruction,
  localDay,
  normalizeFileSet,
  normalizeInstruction,
  rolloverDue,
  trackTurns,
} from './safety';
import {
  SKILLS_NEEDING_REMOTE,
  availableSkills,
  describeSkillState,
  environmentalReason,
  missingRequiredSkills,
  skillOutcomes,
} from './skills';
import {
  FOLLOW_UP_STATUSES,
  RESUMABLE_STATUSES,
  TERMINAL_STATUSES,
  type AgentConfig,
  type AgentRole,
  type AgentSession,
  type AnswerCheck,
  type CommitInfo,
  type ConfigChangeEntry,
  type ConfigUpdate,
  type ExecutorOutput,
  type ExecutorStep,
  type GitInspection,
  type HandoffSummary,
  type ModelChangeMode,
  type NewTaskEvent,
  type NextStep,
  type OrchestratorDeps,
  type PlannerOutput,
  type PlannerStep,
  type RefusalReason,
  type SkillBlock,
  type TaskConfig,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
  type TurnRecord,
  type WaitingState,
} from './types';

/** The longest name a task may be given (SPEC.md §10). */
export const MAX_TITLE_CHARS = 200;

/** One line, single spaces; empty means "no name". */
export function normalizeTitle(title: string): string | null {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : flat;
}

/** Margin after a reported reset before auto-resume tries again. */
export const AUTO_RESUME_MARGIN_MS = 60_000;
/** The wait before the one retry of a turn that failed with a service error (SPEC.md §5 net 12). */
export const SERVICE_RETRY_DELAY_MS = 60_000;
/**
 * SPEC.md §5 net 11: after the CLI gives up on a structured answer, the step is sent again with a changed
 * request — first short, then bare — and only then does the task stop. Repeating the identical request, as
 * the app did before 2026-09-18, produced five near-identical refusals and a lost run (NOTES.md §25).
 */
export const ANSWER_RETRY_VARIATIONS: readonly AnswerRetryVariation[] = ['short_answer', 'essential_fields'];
/** Handoff turns one rollover may spend: the request, then a shorter one (SPEC.md §15). */
export const HANDOFF_ATTEMPTS = 2;

/** A turn that ended without an answer the tool would accept — the kind worth asking for differently. */
function isAnswerFailure(error: TurnRecord['error']): boolean {
  return error?.kind === 'structured_output_failed' || error?.kind === 'schema_invalid';
}
/** Longest raw text kept inside an event; the complete output is in the raw files. */
const EVENT_TEXT_LIMIT = 20_000;

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

export class TaskCreationError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'TaskCreationError';
  }
}

export interface CreateTaskInput {
  description: string;
  projectDir: string;
  config: TaskConfig;
  /** Normally generated. */
  taskId?: string;
}

/** `20260916-181530-a1b2c3` — sortable, and valid inside a git branch name. */
export function makeTaskId(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomBytes(3).toString('hex')}`;
}

function clipText(text: string | null, max = EVENT_TEXT_LIMIT): string {
  if (text === null) return '';
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters in the raw file)` : text;
}

function freshSession(sessionId: string, seed: string | null = null): AgentSession {
  return {
    sessionId,
    established: false,
    systemPrompt: null,
    startedAt: null,
    turns: 0,
    lastContextTokens: null,
    lastModel: null,
    rolloverRequested: null,
    handoffAttempts: 0,
    rolloverBlocked: null,
    seed,
    retired: [],
  };
}

/** Reduce a runner outcome to the serializable record the timeline and the state machine use. */
export function toTurnRecord(outcome: TurnOutcome, purpose: TurnRecord['purpose'], cycle: number | null): TurnRecord {
  return {
    turnId: outcome.turnId,
    agent: outcome.agent,
    purpose,
    cycle,
    sessionId: outcome.sessionId,
    resumed: outcome.resumed,
    sessionCreated: outcome.init !== null,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    ok: outcome.ok,
    output: outcome.ok ? outcome.output : null,
    error: outcome.ok
      ? null
      : {
          kind: outcome.error.kind,
          message: outcome.error.message,
          rawText: clipText(outcome.error.rawText),
          ...(outcome.error.validationIssues ? { validationIssues: outcome.error.validationIssues } : {}),
          ...(outcome.error.apiErrorStatus !== undefined ? { apiErrorStatus: outcome.error.apiErrorStatus } : {}),
          ...(outcome.error.terminalReason !== undefined ? { terminalReason: outcome.error.terminalReason } : {}),
          ...(outcome.error.resetsAt !== undefined ? { resetsAt: outcome.error.resetsAt } : {}),
        },
    slow: outcome.slow,
    slowTurnMs: outcome.slowTurnMs,
    processes: {
      method: outcome.processes.method,
      count: outcome.processes.survivors.length,
      survivors: outcome.processes.survivors,
      errors: outcome.processes.errors,
    },
    model: outcome.model,
    usage: outcome.usage,
    permissionDenials: outcome.permissionDenials,
    skillInvocations: outcome.skillInvocations,
    init:
      outcome.agent === 'executor' && outcome.init
        ? { skills: outcome.init.skills, slashCommands: outcome.init.slashCommands }
        : null,
    rateLimit: outcome.rateLimit,
    resultText: outcome.resultText === null ? null : clipText(outcome.resultText),
    rawPath: outcome.rawPath,
    stderrPath: outcome.stderrPath,
    systemPromptPath: outcome.systemPromptPath,
    accountChanged: false,
    answerCheck: checkAnswer(outcome.answerRejections, outcome.agent, purpose, outcome.ok ? outcome.output : null),
    toolUses: outcome.toolUses,
  };
}

/** Fill in fields added after a task.json was written, so older tasks load. */
function upgradeTask(task: TaskRecord): void {
  const legacyLoop = task.loop as TaskRecord['loop'] & { recentFileSets?: unknown };
  delete legacyLoop.recentFileSets;
  task.loop.recentTurns ??= [];
  task.parkedWaiting ??= null;
  task.lastProcessedTurnId ??= null;
  task.skills.lastStates ??= {};
  task.skills.waived ??= [];
  task.git.snapshot ??= null;
  // A task whose setup already ran predates the snapshot step; do not add one mid-task.
  task.git.snapshotDone ??= task.setupDone;
  if (task.rateLimit) task.rateLimit.autoResumeSkipped ??= null;
  task.plannerNotes ??= [];
  task.loop.rejectedStreak ??= 0;
  task.loop.serviceRetry ??= null;
  task.loop.answerRetries ??= 0;
  for (const agent of ['planner', 'executor'] as const) {
    task.sessions[agent].handoffAttempts ??= 0;
    task.sessions[agent].rolloverBlocked ??= null;
  }
  task.config.freshExecutorAfterRejectedTurns ??= null;
}

const NOTIFY_TITLES: Partial<Record<TaskStatus, string>> = {
  waiting_user: 'Waiting for you',
  done: 'Task done',
  failed: 'Task failed',
  error: 'Task stopped with an error',
  rate_limited: 'Usage limit reached',
  account_mismatch: 'Claude Code account changed',
};

export class TaskRunner {
  private seq: number;
  private driving: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private pauseRequested = false;
  private stopRequested = false;
  /** Bumped by every Stop, so a Resume still checking the account knows it was stopped meanwhile. */
  private stops = 0;
  /** Resumes still checking the account (the task has not left its resumable status yet). */
  private resuming = 0;
  private cancelAutoResume: (() => void) | null = null;
  /**
   * Ends the wait before a service-error retry: early, for Stop and Pause; without waking the loop, at
   * shutdown (`wake` false), so nothing is spawned while the app closes.
   */
  private cancelServiceWait: ((wake?: boolean) => void) | null = null;

  private constructor(
    private task: TaskRecord,
    lastSeq: number,
    private readonly deps: OrchestratorDeps,
  ) {
    this.seq = lastSeq;
  }

  // -------------------------------------------------------------------------
  // Creation and loading
  // -------------------------------------------------------------------------

  /** Pin the account and write the task as a draft (SPEC.md §3.6 rule 1). Nothing is spawned. */
  static async create(input: CreateTaskInput, deps: OrchestratorDeps): Promise<TaskRunner> {
    const description = input.description.trim();
    if (!description) throw new TaskCreationError('The task description is empty.', 'Describe the task.');
    const projectDir = path.resolve(input.projectDir);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw new TaskCreationError(`The project folder does not exist: ${projectDir}`, 'Pick an existing folder.');
    }
    const now = deps.now();
    let pinned;
    try {
      pinned = pinAccount(await deps.authStatus(), now);
    } catch (err) {
      const e = err as Error & { nextStep?: string };
      throw new TaskCreationError(e.message, e.nextStep ?? 'Run `claude auth login`.');
    }
    const id = input.taskId ?? makeTaskId(now);
    deps.store.createFolders(id);
    const stamp = now.toISOString();
    const config = structuredClone(input.config);
    const task: TaskRecord = {
      schemaVersion: 1,
      id,
      description,
      projectDir,
      plannerCwd: config.plannerContextMode === 'read_only' ? projectDir : deps.store.plannerCwd(id),
      createdAt: stamp,
      updatedAt: stamp,
      status: 'draft',
      statusReason: null,
      statusChangedAt: stamp,
      config,
      pinnedAccount: pinned,
      liveAccount: null,
      sessions: { planner: freshSession(deps.newSessionId()), executor: freshSession(deps.newSessionId()) },
      cycles: 0,
      plannerTurns: 0,
      setupDone: false,
      next: null,
      waiting: null,
      parkedWaiting: null,
      deferredTurn: null,
      lastProcessedTurnId: null,
      planApproved: false,
      skills: { available: null, discoveredFrom: null, satisfied: [], lastStates: {}, waived: [] },
      git: {
        enabled: config.autoBranchAndCommit,
        isRepo: false,
        branch: null,
        originalBranch: null,
        startCommit: null,
        hasRemote: false,
        dirtyAtStart: [],
        snapshot: null,
        snapshotDone: false,
        inertReason: null,
      },
      loop: { lastInstruction: null, recentTurns: [], refusals: 0, rejectedStreak: 0 },
      rateLimit: null,
      capOverrideDay: null,
      finalReport: null,
      followUpApproval: false,
      queuedMessages: [],
      plannerNotes: [],
    };
    const runner = new TaskRunner(task, 0, deps);
    runner.emit({ type: 'task_created', description, projectDir, config, pinnedAccount: pinned });
    runner.save();
    return runner;
  }

  /**
   * Reopen a stored task. A task stored as `running` was interrupted (the app stopped mid-turn): it
   * becomes `error`, resumable, and a turn that was saved but never acted on is queued for processing.
   */
  static load(task: TaskRecord, events: readonly TaskEvent[], deps: OrchestratorDeps): TaskRunner {
    upgradeTask(task);
    const lastSeq = events.reduce((max, e) => Math.max(max, e.seq), 0);
    const runner = new TaskRunner(task, lastSeq, deps);
    if (task.status === 'running') runner.recoverInterrupted(events);
    else if (task.status === 'rate_limited') runner.scheduleAutoResume();
    return runner;
  }

  private recoverInterrupted(events: readonly TaskEvent[]): void {
    const task = this.task;
    const started = [...events].reverse().find((e) => e.type === 'turn_started');
    const finished =
      started?.type === 'turn_started'
        ? [...events].reverse().find((e) => e.type === 'turn' && e.turnId === started.turnId)
        : undefined;
    let detail: string;
    if (finished?.type === 'turn' && finished.turnId !== task.lastProcessedTurnId) {
      const { type: _type, seq: _seq, ts: _ts, ...record } = finished;
      this.applySessionBookkeeping(record);
      if (record.ok) {
        task.deferredTurn = record;
        detail = `Turn ${record.turnId} finished but was not acted on; it will be processed on Resume.`;
      } else {
        this.prepareRetry(record, 'the app stopped before this turn was handled');
        detail = `Turn ${record.turnId} failed and the app stopped before handling it; Resume retries it.`;
      }
    } else if (started?.type === 'turn_started' && !finished) {
      const session = task.sessions[started.agent];
      if (!session.established && session.sessionId === started.sessionId) {
        const rawPath = path.join(this.deps.store.rawDir(task.id), `${started.turnId}.ndjson`);
        if (this.deps.store.rawHasInit(rawPath)) {
          session.established = true;
          session.seed = null;
        } else {
          this.retireSession(started.agent, 'its first turn was interrupted before the session was created');
        }
      }
      const sawIt = task.sessions[started.agent].established || started.agent === 'executor';
      if (started.purpose !== 'handoff' && task.next) {
        task.next.retryNote = sawIt ? retryNote('the app stopped during this turn', started.agent) : null;
      }
      detail = `Turn ${started.turnId} (${started.agent}) was interrupted.`;
    } else {
      detail = 'No turn was in progress.';
    }
    this.emit({ type: 'recovered', detail });
    // The user asked for a stop (e.g. Quit and stop) and the app exited before it finished: that is still a
    // stop, never an error (SPEC.md §6, decided 2026-09-17).
    let lastRunning = -1;
    events.forEach((e, i) => {
      if (e.type === 'status' && e.to === 'running') lastRunning = i;
    });
    const stopAsked = events.slice(lastRunning + 1).some((e) => e.type === 'intervention' && e.kind === 'stop');
    if (stopAsked) {
      this.setStatus('stopped', `Stopped by the user. The app exited before the stop had finished. ${detail} Resume continues from there.`);
      return;
    }
    this.setStatus('error', `The app stopped while this task was running. ${detail} Resume continues from there.`);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get id(): string {
    return this.task.id;
  }

  /** A copy of the current task record. */
  get snapshot(): TaskRecord {
    return structuredClone(this.task);
  }

  get busy(): boolean {
    return this.driving !== null;
  }

  /** Resolves when the loop is not driving. */
  async whenIdle(): Promise<void> {
    while (this.driving) await this.driving;
  }

  /** draft → running (SPEC.md §4). Resolves when the loop halts. */
  start(): Promise<void> {
    if (this.task.status !== 'draft') throw new TaskStateError(`Only a draft task can be started (status: ${this.task.status}).`);
    this.setStatus('running', null);
    return this.kick();
  }

  /** Finish the current turn, then hold (SPEC.md §6). */
  pause(): void {
    if (this.task.status !== 'running') return;
    this.pauseRequested = true;
    this.emit({ type: 'intervention', kind: 'pause' });
    // No turn is running during a service-error wait: hold now.
    this.cancelServiceWait?.();
  }

  /** Kill the current process; status `stopped` (SPEC.md §6). Resolves once the loop has halted. */
  async stop(): Promise<void> {
    if (TERMINAL_STATUSES.includes(this.task.status)) return;
    // Already stopped, unless a Resume is on its way out of `stopped`: that one must be called off.
    if (this.task.status === 'stopped' && this.resuming === 0) return;
    this.emit({ type: 'intervention', kind: 'stop' });
    this.stops += 1;
    this.clearAutoResume();
    if (this.driving) {
      this.stopRequested = true;
      this.controller?.abort();
      this.cancelServiceWait?.();
      await this.whenIdle();
    }
    // The loop may have changed the status while we waited.
    const status = this.task.status as TaskStatus;
    if (status !== 'stopped' && !TERMINAL_STATUSES.includes(status)) {
      const waiting = this.task.waiting;
      if (waiting && waiting.kind !== 'paused' && waiting.kind !== 'possible_loop') this.task.parkedWaiting = waiting;
      this.setStatus('stopped', 'Stopped by the user.');
    }
    this.stopRequested = false;
  }

  /**
   * Resume from stopped, error, rate_limited, account_mismatch, a pause or a loop pause. The account
   * check runs first in every case (SPEC.md §6, §3.6 rule 6).
   */
  async resume(): Promise<void> {
    const { status, waiting } = this.task;
    if (status === 'draft') return this.start();
    const resumable =
      RESUMABLE_STATUSES.includes(status) ||
      (status === 'waiting_user' && (waiting?.kind === 'paused' || waiting?.kind === 'possible_loop'));
    if (!resumable) throw new TaskStateError(`Resume is not available in status ${status}${waiting ? ` (${waiting.kind})` : ''}.`);
    if (this.driving) throw new TaskStateError('The task is still running.');
    this.emit({ type: 'intervention', kind: 'resume' });
    this.clearAutoResume();
    const stops = this.stops;
    // Stopped while the account was being checked: the stop wins, whatever the account says.
    const stillWanted = () => this.stops === stops;
    this.resuming += 1;
    let ok: boolean;
    try {
      ok = await this.checkAccount('resume', null, stillWanted);
    } finally {
      this.resuming -= 1;
    }
    if (!ok || !stillWanted()) return;
    this.task.rateLimit = null;
    const parked = this.task.parkedWaiting;
    if (parked) {
      this.task.parkedWaiting = null;
      this.wait(parked, 'Resumed: still waiting for you.');
      return;
    }
    return this.continueRunning();
  }

  /** Answer the Planner's question, or tell it how to go on after a pause (SPEC.md §4 waiting_user). */
  async answer(text: string): Promise<void> {
    const waiting = this.requireWaiting(['question', 'possible_loop', 'paused', 'skill_waiver']);
    const body = this.requireText(text);
    // Replying instead of waiving is declining the waiver; the reply goes to the Planner.
    if (waiting.kind === 'skill_waiver') return this.declineWaiver(body);
    this.emit({ type: 'intervention', kind: 'answer', to: 'planner', text: body });
    if (waiting.kind === 'question') {
      this.task.next = this.plannerStep('answer', answerBlock(waiting.question, body));
    } else {
      const note = waiting.kind === 'possible_loop' ? `${loopPauseNote(waiting.reason)}\n\n` : '';
      this.applyMessage('planner', body, note);
    }
    return this.continueRunning();
  }

  /**
   * A message to the Planner (SPEC.md §6 — there is no other recipient). While a turn runs it waits
   * for the turn to end; in a state that needs Resume it is delivered then; on a task that had
   * finished it reopens the task (§4).
   */
  async sendMessage(text: string): Promise<void> {
    const body = this.requireText(text);
    const { status, waiting } = this.task;
    if (waiting?.kind === 'plan_approval' || waiting?.kind === 'instruction_approval') {
      throw new TaskStateError('The task is waiting for an approval: approve, edit or reject it first.');
    }
    if (waiting?.kind === 'skill_waiver') {
      throw new TaskStateError('The task is waiting for a decision on a required skill: waive it, or reply to the planner.');
    }
    this.emit({ type: 'intervention', kind: 'message', to: 'planner', text: body });
    if (FOLLOW_UP_STATUSES.includes(status)) return this.followUp(body);
    this.task.queuedMessages.push({ text: body, at: this.deps.now().toISOString() });
    this.save();
    if (status === 'waiting_user') return this.continueRunning();
    return this.driving ?? Promise.resolve();
  }

  /**
   * A message to a task that had finished (SPEC.md §4). The Planner decides what it is: it answers
   * from what it knows and the task stays finished, or it asks for work and the loop picks up where
   * it left off — with that first instruction always coming back to the user (§7).
   */
  private async followUp(body: string): Promise<void> {
    const { task } = this;
    task.followUpApproval = true;
    // applyMessage keeps whatever step was pending — a stopped or failed task may still have one —
    // and makes a fresh Planner step when there is none, which is the `done` case.
    this.applyMessage('planner', body, `${followUpNote(task.status, task.finalReport)}\n\n`);
    this.save();
    return this.continueRunning();
  }

  /** Review mode: send the pending instruction, optionally edited (SPEC.md §7). */
  async approveInstruction(edited?: string): Promise<void> {
    this.requireWaiting(['instruction_approval']);
    const step = this.task.next;
    if (step?.agent !== 'executor') throw new TaskStateError('No instruction is pending.');
    const changed = edited !== undefined && edited.trim() !== '' && edited.trim() !== step.instruction?.trim();
    if (changed) {
      step.instruction = edited.trim();
      step.prompt = executorPrompt(step);
    }
    step.needsApproval = false;
    // One approval, then the task carries on under its own mode (SPEC.md §7). A rejected
    // instruction leaves the flag set: its replacement is still this follow-up's first.
    this.task.followUpApproval = false;
    this.emit({ type: 'intervention', kind: 'approve_instruction', edited: changed, ...(changed ? { text: step.instruction ?? '' } : {}) });
    return this.continueRunning();
  }

  /** Review mode: do not send it; the reason goes back to the Planner (SPEC.md §7). */
  async rejectInstruction(reason: string): Promise<void> {
    this.requireWaiting(['instruction_approval']);
    const body = this.requireText(reason);
    const step = this.task.next;
    const instruction = step?.agent === 'executor' ? (step.instruction ?? '') : '';
    this.emit({ type: 'intervention', kind: 'reject_instruction', to: 'planner', text: body });
    const carry = step?.agent === 'executor' && step.carryToPlanner ? `\n\n${step.carryToPlanner}` : '';
    this.task.next = this.plannerStep('instruction_rejected', instructionRejected(instruction, body) + carry);
    return this.continueRunning();
  }

  /** plan_first: approve (optionally edited); the task then runs as `auto` (SPEC.md §7). */
  async approvePlan(edited?: string): Promise<void> {
    const waiting = this.requireWaiting(['plan_approval']);
    const changed = edited !== undefined && edited.trim() !== '' && edited.trim() !== waiting.plan.trim();
    this.task.planApproved = true;
    this.emit({ type: 'intervention', kind: 'approve_plan', to: 'planner', edited: changed, ...(changed ? { text: edited.trim() } : {}) });
    this.task.next = this.plannerStep('plan_decision', planApproved(changed ? edited.trim() : null));
    return this.continueRunning();
  }

  async rejectPlan(reason: string): Promise<void> {
    this.requireWaiting(['plan_approval']);
    const body = this.requireText(reason);
    this.emit({ type: 'intervention', kind: 'reject_plan', to: 'planner', text: body });
    this.task.next = this.plannerStep('plan_decision', planRejected(body));
    return this.continueRunning();
  }

  /**
   * Waive one required skill that cannot run in this environment — for this task only, explicitly,
   * and logged with its reason (SPEC.md §16). Only possible while the task offers it.
   */
  async waiveSkill(skill: string, note?: string): Promise<void> {
    const waiting = this.requireWaiting(['skill_waiver']);
    const block = waiting.skills.find((b) => b.skill === skill);
    if (!block) throw new TaskStateError(`${skill} is not offered for a waiver.`);
    const text = note !== undefined && note.trim() !== '' ? note.trim() : null;
    this.emit({ type: 'intervention', kind: 'waive_skill', ...(text !== null ? { text } : {}) });
    this.emit({ type: 'skill_waived', skill, reason: block.reason, note: text });
    this.task.skills.waived.push({ skill, reason: block.reason, note: text, at: this.since() });

    const remaining = waiting.skills.filter((b) => b.skill !== skill);
    if (waiting.after === 'continue') {
      const notice = skillWaivedNote(block);
      const next = this.task.next;
      if (next?.agent === 'planner') next.prompt = `${notice}\n\n${next.prompt}`;
      else this.task.next = this.plannerStep('user_message', notice);
    }
    if (remaining.length > 0) {
      this.wait({ ...waiting, skills: remaining }, waiverReason(remaining));
      return;
    }
    if (waiting.after === 'finish') {
      if (this.missingRequired().length === 0) {
        this.finish(waiting.finalReport ?? '');
        return;
      }
      // Never finish with a requirement still open.
      const details = this.missingRequired().map((s) => ({ skill: s, state: this.lastSkillState(s) }));
      this.task.next = this.plannerStep('refusal', requiredSkillsRefusal(details, []));
    }
    return this.continueRunning();
  }

  /** Keep the requirement: the user's reply goes to the Planner and the loop continues. */
  async declineWaiver(message: string): Promise<void> {
    const waiting = this.requireWaiting(['skill_waiver']);
    const body = this.requireText(message);
    this.emit({ type: 'intervention', kind: 'decline_waiver', to: 'planner', text: body });
    this.emit({ type: 'skill_waiver_declined', skills: waiting.skills, message: body });
    const block = skillWaiverDeclined(waiting.skills, body);
    const next = this.task.next;
    if (next?.agent === 'planner') next.prompt = `${block}\n\n${next.prompt}`;
    else this.task.next = this.plannerStep('user_message', block);
    return this.continueRunning();
  }

  /** Applies to sessions started from now on (SPEC.md §6). */
  setStandingInstructions(agent: AgentRole, text: string): void {
    if (TERMINAL_STATUSES.includes(this.task.status)) throw new TaskStateError(`The task is ${this.task.status}.`);
    if (this.task.config.standingInstructions[agent] === text) return;
    this.task.config.standingInstructions[agent] = text;
    this.emit({ type: 'intervention', kind: 'standing_instructions', to: agent, text });
    this.save();
  }

  /**
   * Change the approval mode of a task that has not ended (SPEC.md §7). It applies from the Planner's next
   * instruction: a step already accepted keeps its mode, and one waiting for approval still waits. Plan
   * first asks for a new plan of the remaining work; the Planner is told whenever plan-first starts or
   * stops mattering to it.
   */
  setApprovalMode(mode: ApprovalMode): void {
    const { task } = this;
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskStateError(`The task is ${task.status}.`);
    const from = task.config.approvalMode;
    if (from === mode) return;
    const planWasPending = from === 'plan_first' && !task.planApproved;
    task.config.approvalMode = mode;
    if (mode === 'plan_first') task.planApproved = false;
    this.emit({ type: 'approval_mode_changed', from, to: mode });
    // Before setup the Planner's first prompt is written from the current mode, so it needs no note.
    // Otherwise the note goes with the next Planner turn that spawns (not into task.next, which may be a
    // turn already running).
    const note = task.setupDone ? approvalModeNote(mode, planWasPending) : null;
    if (note !== null) task.plannerNotes.push(note);
    this.save();
  }

  /**
   * "Task settings" on a task that is under way (SPEC.md §6, decided 2026-09-22). Everything is checked
   * before anything changes, so a refused update changes nothing. One `config_changed` event records every
   * field that did change, and for a model or effort change the way it was applied.
   *
   * Max cycles, required skills, auto-commit and rollover percent are read every cycle, so they apply at
   * once. Model and effort apply from the agent's next turn: in the same conversation, or — `fresh_session`
   * — after a rollover whose handoff runs on the old model. Neither interrupts a running turn.
   */
  updateConfig(update: ConfigUpdate): void {
    const { task } = this;
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskStateError(`The task is ${task.status}.`);
    const c = task.config;

    // --- check everything first ---------------------------------------------------------
    if (update.maxCycles !== undefined) {
      const n = update.maxCycles;
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new TaskStateError('Max cycles must be a whole number from 1 to 500.');
      if (n < task.cycles) throw new TaskStateError(`Max cycles cannot be below the ${task.cycles} cycles this task has already run.`);
    }
    if (update.rolloverPercent !== undefined) {
      const n = update.rolloverPercent;
      if (!Number.isInteger(n) || n < 5 || n > 95) throw new TaskStateError('Rollover must be a whole percentage from 5 to 95.');
    }
    // Turn limits: the same ranges as Settings → Task defaults (SPEC.md §6, §11).
    for (const [key, label] of [['turnTimeoutMs', 'The turn timeout'], ['slowTurnMs', 'The slow-turn warning']] as const) {
      const ms = update[key];
      if (ms !== undefined && (!Number.isInteger(ms) || ms % 60_000 !== 0 || ms < 60_000 || ms > 600 * 60_000)) {
        throw new TaskStateError(`${label} must be a whole number of minutes from 1 to 600.`);
      }
    }
    if (update.maxTurnsPerSession !== undefined) {
      const n = update.maxTurnsPerSession;
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new TaskStateError('Max steps per turn must be a whole number from 1 to 1000.');
    }
    if (update.freshExecutorAfterRejectedTurns !== undefined && update.freshExecutorAfterRejectedTurns !== null) {
      const n = update.freshExecutorAfterRejectedTurns;
      if (!Number.isInteger(n) || n < 1 || n > FRESH_EXECUTOR_MAX_TURNS) {
        throw new TaskStateError(`A fresh Executor session after rejected answers takes 1 to ${FRESH_EXECUTOR_MAX_TURNS} turns, or off.`);
      }
    }
    const skills =
      update.requiredSkills === undefined ? undefined : [...new Set(update.requiredSkills.map((s) => s.trim()).filter((s) => s.length > 0))];
    if (update.autoBranchAndCommit === true && !c.autoBranchAndCommit && (!task.git.isRepo || task.git.branch === null)) {
      throw new TaskStateError(
        'Auto-commit can only be turned back on for a task that has its own branch. This one started without it, so commits would land on whatever branch is checked out.',
      );
    }
    for (const agent of ['planner', 'executor'] as const) {
      const next = update[agent];
      if (!next) continue;
      if (!getModel(next.model)) throw new TaskStateError(`Unknown model "${next.model}" (SPEC.md §8).`);
      if (!isEffortValid(next.model, next.effort)) {
        throw new TaskStateError(`${next.effort ?? 'No effort'} is not a valid effort for ${next.model} (SPEC.md §8).`);
      }
    }
    const apply: ModelChangeMode = update.apply ?? 'same_session';

    // --- then change it -------------------------------------------------------------------
    const changes: ConfigChangeEntry[] = [];
    if (update.maxCycles !== undefined && update.maxCycles !== c.maxCycles) {
      changes.push({ field: 'maxCycles', from: c.maxCycles, to: update.maxCycles });
      task.plannerNotes.push(`[ORCHESTRATOR] The user changed this task's limit from ${c.maxCycles} to ${update.maxCycles} executor turns.`);
      c.maxCycles = update.maxCycles;
    }
    if (update.rolloverPercent !== undefined && update.rolloverPercent !== c.rolloverPercent) {
      changes.push({ field: 'rolloverPercent', from: c.rolloverPercent, to: update.rolloverPercent });
      c.rolloverPercent = update.rolloverPercent;
    }
    // Read when a turn starts: a turn already running keeps the limits it started with.
    for (const key of ['turnTimeoutMs', 'slowTurnMs', 'maxTurnsPerSession'] as const) {
      const next = update[key];
      if (next === undefined || next === c[key]) continue;
      changes.push({ field: key, from: c[key], to: next });
      c[key] = next;
    }
    if (update.freshExecutorAfterRejectedTurns !== undefined && update.freshExecutorAfterRejectedTurns !== c.freshExecutorAfterRejectedTurns) {
      changes.push({ field: 'freshExecutorAfterRejectedTurns', from: c.freshExecutorAfterRejectedTurns, to: update.freshExecutorAfterRejectedTurns });
      c.freshExecutorAfterRejectedTurns = update.freshExecutorAfterRejectedTurns;
    }
    if (skills !== undefined && (skills.length !== c.requiredSkills.length || skills.some((s, i) => s !== c.requiredSkills[i]))) {
      changes.push({ field: 'requiredSkills', from: [...c.requiredSkills], to: skills });
      task.plannerNotes.push(
        skills.length > 0
          ? `[ORCHESTRATOR] The user changed the skills this task requires before done. Required now: ${skills.join(', ')}.`
          : '[ORCHESTRATOR] The user removed every required skill: none is required before done any more.',
      );
      c.requiredSkills = skills;
    }
    if (update.autoBranchAndCommit !== undefined && update.autoBranchAndCommit !== c.autoBranchAndCommit) {
      changes.push({ field: 'autoBranchAndCommit', from: c.autoBranchAndCommit, to: update.autoBranchAndCommit });
      c.autoBranchAndCommit = update.autoBranchAndCommit;
      task.git.enabled = update.autoBranchAndCommit;
    }
    for (const agent of ['planner', 'executor'] as const) {
      const next = update[agent];
      if (!next || (next.model === c[agent].model && next.effort === c[agent].effort)) continue;
      const session = task.sessions[agent];
      const mode = session.established ? apply : 'first_session';
      changes.push({ field: 'model', agent, from: { ...c[agent] }, to: { model: next.model, effort: next.effort }, apply: mode });
      c[agent] = { model: next.model, effort: next.effort };
      if (mode === 'fresh_session') {
        // The user asked for it, so a block left by an earlier failed handoff does not stand in the way.
        session.rolloverBlocked = null;
        session.handoffAttempts = 0;
        const reason = `the user changed the ${agent === 'planner' ? 'Planner' : 'Executor'}'s model or effort and asked for a fresh session`;
        session.rolloverRequested = reason;
        this.emit({ type: 'rollover_requested', agent, reason });
      }
    }
    if (changes.length === 0) return;
    this.emit({ type: 'config_changed', changes });
    this.save();
  }

  /**
   * Rename the task (SPEC.md §10). Only the `title` field changes: the description the agents work from is
   * never touched. An empty title removes the name. Allowed in every status — a name changes nothing the
   * loop does — and recorded as a `renamed` event unless nothing changed.
   */
  rename(title: string): void {
    const next = normalizeTitle(title);
    if (next !== null && next.length > MAX_TITLE_CHARS) {
      throw new TaskStateError(`A task's name can be at most ${MAX_TITLE_CHARS} characters.`);
    }
    const from = this.task.title ?? null;
    if (next === from) return;
    this.task.title = next;
    this.emit({ type: 'renamed', from, to: next });
    this.save();
  }

  /** "Roll over now" (SPEC.md §15): before that agent's next turn. */
  requestRollover(agent: AgentRole): void {
    if (TERMINAL_STATUSES.includes(this.task.status)) throw new TaskStateError(`The task is ${this.task.status}.`);
    // The user asking for it clears a block left by a handoff that failed (SPEC.md §15).
    this.task.sessions[agent].rolloverBlocked = null;
    this.task.sessions[agent].handoffAttempts = 0;
    this.task.sessions[agent].rolloverRequested = 'requested by the user';
    this.emit({ type: 'intervention', kind: 'rollover_now', to: agent });
    this.emit({ type: 'rollover_requested', agent, reason: 'requested by the user' });
    this.save();
  }

  /**
   * Auto-resume came due, but another task is running (SPEC.md §6, §17): the task stays rate_limited, and
   * the timeline and the panel say which task was in the way. Not retried on its own.
   */
  autoResumeBlocked(blockedBy: { taskId: string; title: string }): void {
    const limit = this.task.rateLimit;
    if (this.task.status !== 'rate_limited' || !limit) return;
    this.clearAutoResume();
    limit.autoResumeAt = null;
    limit.autoResumeSkipped = { at: this.since(), blockedBy };
    this.emit({ type: 'auto_resume_skipped', blockedBy });
    this.save();
  }

  /** Stop background timers (app shutdown). Does not change the task. */
  dispose(): void {
    this.clearAutoResume();
    this.cancelServiceWait?.(false);
  }

  // -------------------------------------------------------------------------
  // Persistence and notification
  // -------------------------------------------------------------------------

  private emit(body: NewTaskEvent): void {
    const event = { ...body, seq: ++this.seq, ts: this.deps.now().toISOString() } as TaskEvent;
    this.deps.store.appendEvent(this.task.id, event);
    this.deps.onNotice?.({ type: 'event', taskId: this.task.id, event });
  }

  private save(): void {
    this.task.updatedAt = this.deps.now().toISOString();
    this.deps.store.writeTask(this.task);
    this.deps.onNotice?.({ type: 'task', task: this.snapshot });
  }

  /** Every status change: event appended, task.json written — both before anything else happens. */
  private setStatus(to: TaskStatus, reason: string | null, waiting: WaitingState | null = null): void {
    const from = this.task.status;
    this.task.status = to;
    this.task.statusReason = reason;
    this.task.waiting = waiting;
    this.task.statusChangedAt = this.deps.now().toISOString();
    this.emit({ type: 'status', from, to, reason, waiting });
    this.save();
    const title = NOTIFY_TITLES[to];
    if (title && this.deps.notify) {
      const body = waiting?.kind === 'question' ? waiting.question : (reason ?? '');
      this.deps.notify({ taskId: this.task.id, status: to, title, body: body.slice(0, 300) });
    }
  }

  private wait(waiting: WaitingState, reason: string): void {
    this.setStatus('waiting_user', reason, waiting);
  }

  private since(): string {
    return this.deps.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private continueRunning(): Promise<void> {
    const waiting = this.task.waiting;
    if (waiting?.kind === 'possible_loop') {
      this.task.loop.recentTurns = [];
      this.task.loop.refusals = 0;
    }
    if (waiting?.kind === 'paused' && waiting.cause === 'daily_cap') this.task.capOverrideDay = localDay(this.deps.now());
    this.task.parkedWaiting = null;
    // A user action restarts the loop: a later service error gets its own retry (SPEC.md §5 net 12).
    this.task.loop.serviceRetry = null;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.setStatus('running', null);
    return this.kick();
  }

  private kick(): Promise<void> {
    if (!this.driving) {
      this.driving = this.drive()
        .catch((err: unknown) => this.internalError(err))
        .finally(() => {
          this.driving = null;
        });
    }
    return this.driving;
  }

  private internalError(err: unknown): void {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try {
      this.setStatus('error', `Internal error in the orchestrator: ${message}`);
    } catch {
      /* the store itself failed; the caller's logger has the error */
    }
    this.deps.onNotice?.({ type: 'task', task: this.snapshot });
  }

  private async drive(): Promise<void> {
    while (this.task.status === 'running') {
      if (this.stopRequested) {
        this.setStatus('stopped', 'Stopped by the user.');
        return;
      }
      if (!this.task.setupDone) {
        await this.setup();
        continue;
      }
      if (this.task.deferredTurn) {
        const record = this.task.deferredTurn;
        this.task.deferredTurn = null;
        await this.processTurn(record);
        this.save();
        continue;
      }
      this.applyQueuedMessages();
      if (this.pauseRequested) {
        this.pauseRequested = false;
        this.wait({ kind: 'paused', cause: 'user', reason: 'Paused by the user.', since: this.since() }, 'Paused by the user.');
        return;
      }
      const step = this.task.next;
      if (!step) {
        this.setStatus('error', 'Internal error: the task is running but has no next step.');
        return;
      }
      if (!(await this.preflight(step))) continue;
      await this.runStep(step);
    }
  }

  /** Task start: git branch (§18) and skill discovery (§16). Idempotent, so Resume can repeat it. */
  private async setup(): Promise<void> {
    const { task, deps } = this;
    const git = task.git;
    let inspection: GitInspection | null = null;
    let gitFailure: string | null = null;
    try {
      inspection = await deps.git.inspect(task.projectDir);
    } catch (err) {
      // Git could not answer. That is never "not a repository" (SPEC.md §18, decided 2026-09-17).
      gitFailure = err instanceof Error ? err.message : String(err);
    }
    try {
      if (inspection === null) {
        if (git.enabled) {
          this.setStatus(
            'error',
            `Git setup failed. ${gitFailure} The task did not start without its branch. Fix git, then Resume — or create the task again with Auto-branch and commit off.`,
          );
          return;
        }
        git.isRepo = false;
        git.hasRemote = false;
        git.inertReason = `Auto-branch and commit is off for this task. ${gitFailure}`;
      } else if (!inspection.isRepo) {
        git.isRepo = false;
        git.hasRemote = false;
        git.inertReason = 'The project folder is not a git repository: no branch, no commits.';
      } else {
        git.isRepo = true;
        git.hasRemote = inspection.hasRemote;
        if (!git.enabled) {
          git.inertReason = 'Auto-branch and commit is off for this task.';
        } else {
          const branch = `${APP_SLUG}/${task.id}`;
          if (git.branch === null) {
            git.originalBranch = inspection.branch;
            git.startCommit = inspection.head;
            git.dirtyAtStart = inspection.dirty;
          }
          if (inspection.branch !== branch) await deps.git.switchToBranch(task.projectDir, branch);
          git.branch = branch;
          git.inertReason = null;
          if (!git.snapshotDone) {
            // The user's uncommitted work gets its own commit, so cycle 1 contains only the task's changes.
            if (inspection.dirty.length > 0) await this.snapshotCommit();
            git.snapshotDone = true;
          }
        }
      }
    } catch (err) {
      this.setStatus('error', `Git setup failed. ${err instanceof Error ? err.message : String(err)} Fix git, then Resume.`);
      return;
    }

    if (!(await this.checkAccount('before_spawn', null))) return;
    let skillsError: string | null = null;
    let missingRequired: string[] = [];
    try {
      const init = await deps.probeInit({
        cwd: task.projectDir,
        tools: task.config.executorTools,
        disallowedTools: task.config.executorDisallowedTools,
        permissionMode: task.config.permissionMode,
        model: task.config.executor.model,
      });
      const found = availableSkills(init, task.config.requiredSkills);
      task.skills.available = found.available;
      task.skills.discoveredFrom = 'init_probe';
      missingRequired = found.missingRequired;
    } catch (err) {
      skillsError = err instanceof Error ? err.message : String(err);
    }
    this.emit({ type: 'setup', git: structuredClone(git), skills: task.skills.available, skillsError, missingRequiredSkills: missingRequired });
    task.setupDone = true;
    const planFirst = task.config.approvalMode === 'plan_first' && !task.planApproved;
    task.next = this.plannerStep('start', plannerStartPrompt(task, planFirst));
    this.save();
  }

  /** Everything that must hold before a step may spawn. False = do not spawn now. */
  private async preflight(step: NextStep): Promise<boolean> {
    const { task, deps } = this;
    const cap = deps.general.softDailyTokenCap;
    if (cap !== null && deps.usage) {
      const day = localDay(deps.now());
      const used = deps.usage.tokensOn(day);
      if (task.capOverrideDay !== day && used >= cap) {
        const reason = `Today's local token estimate (${used.toLocaleString('en-US')}) reached the soft cap of ${cap.toLocaleString('en-US')}. Resume to continue anyway.`;
        this.wait({ kind: 'paused', cause: 'daily_cap', reason, since: this.since() }, reason);
        return false;
      }
    }
    if (step.agent === 'executor') {
      if (step.cycle === null && task.cycles >= task.config.maxCycles) {
        this.setStatus('failed', `Reached the limit of ${task.config.maxCycles} cycles (SPEC safety net 1).`);
        return false;
      }
      if (step.needsApproval) {
        this.wait(
          { kind: 'instruction_approval', instruction: step.instruction ?? '', useSkills: step.useSkills, reasoning: step.reasoning, since: this.since() },
          'The planner’s instruction needs your approval.',
        );
        return false;
      }
    }
    if (!(await this.rolloverIfDue(step.agent))) return false;
    if (this.stopRequested || this.pauseRequested) return false;
    return this.checkAccount('before_spawn', null);
  }

  private async runStep(step: NextStep): Promise<void> {
    const { task, deps } = this;
    const agent = step.agent;
    if (agent === 'executor') await this.commitBeforeReview(step);
    if (this.stopRequested || this.pauseRequested) return;

    let cycle: number | null = null;
    if (step.agent === 'executor') {
      if (step.cycle === null) {
        task.cycles += 1;
        step.cycle = task.cycles;
      }
      cycle = step.cycle;
    } else {
      task.plannerTurns += 1;
      // Notes that waited for the Planner go at the top of this turn's prompt, and are saved with it.
      if (task.plannerNotes.length > 0) {
        step.prompt = [...task.plannerNotes, step.prompt].join('\n\n');
        task.plannerNotes = [];
      }
    }
    const session = this.prepareSession(agent);
    const stdin = composeStdin(step, session.established ? null : session.seed);
    const turnId = deps.newTurnId(agent);
    const launch = this.launchConfig(agent, step.purpose);
    this.emit({
      type: 'turn_started',
      turnId,
      agent,
      purpose: step.purpose,
      cycle,
      sessionId: session.sessionId,
      resumed: session.established,
      model: launch.model,
      effort: launch.effort,
      prompt: stdin,
    });
    this.save();

    const record = await this.runAgentTurn(agent, stdin, agent === 'planner' ? 'planner-output' : 'executor-output', turnId, step.purpose, cycle);
    if (!(await this.afterTurn(record))) return;
    await this.processTurn(record);
    this.save();
  }

  /** Spawn one turn through the injected runner and do the bookkeeping every turn needs. */
  private async runAgentTurn(
    agent: AgentRole,
    stdin: string,
    schema: SchemaKind,
    turnId: string,
    purpose: TurnRecord['purpose'],
    cycle: number | null,
  ): Promise<TurnRecord> {
    const { task, deps } = this;
    const session = task.sessions[agent];
    const controller = new AbortController();
    this.controller = controller;
    const launch = this.launchConfig(agent, purpose);
    session.launchedWith = { ...launch };
    let outcome: TurnOutcome;
    try {
      outcome = await deps.runTurn(this.turnSpec(agent, session, stdin, schema, turnId, controller.signal, launch));
    } finally {
      this.controller = null;
    }
    const record = toTurnRecord(outcome, purpose, cycle);
    if (record.usage?.sessionCostUsd != null) {
      this.sessionTotals()[record.sessionId] = { costUsd: record.usage.sessionCostUsd, modelUsage: record.usage.sessionModelUsage ?? {} };
    }
    this.applySessionBookkeeping(record);
    if (record.usage) deps.usage?.record(deps.now(), record.usage.modelUsage);
    if (record.rateLimit) {
      deps.usage?.recordWindows(deps.now(), record.rateLimit);
      if (record.rateLimit.status === 'allowed_warning') {
        this.emit({ type: 'rate_limit', status: 'allowed_warning', resetsAt: record.rateLimit.resetsAt, rateLimitType: record.rateLimit.rateLimitType, turnId });
      }
    }
    return record;
  }

  /**
   * The running totals each session last reported (SPEC.md §15). A task made before they were kept is read
   * from its turn events once, the same way an old record is read.
   */
  private sessionTotals(): Record<string, RunningTotals> {
    if (!this.task.sessionTotals) {
      const reader = turnShareReader();
      for (const e of this.deps.store.readEvents(this.task.id)) if (e.type === 'turn') reader.own(e);
      this.task.sessionTotals = Object.fromEntries(reader.totals());
    }
    return this.task.sessionTotals;
  }

  /** What a finished turn tells us about its session. */
  private applySessionBookkeeping(record: TurnRecord): void {
    const session = this.task.sessions[record.agent];
    if (session.sessionId !== record.sessionId) return;
    session.turns += 1;
    if (record.sessionCreated) {
      session.established = true;
      session.seed = null;
    }
    if (record.usage) {
      session.lastContextTokens = record.usage.contextTokens;
      session.lastModel = record.model.canonical ?? record.model.served;
    }
  }

  /**
   * The model and effort a turn is launched with (SPEC.md §6). Always the task's current setting, except a
   * handoff: that is the session summarising itself, so it runs on the model the session was running — the
   * one whose prompt cache is warm — even after the user has chosen a new model for a fresh session.
   */
  private launchConfig(agent: AgentRole, purpose: TurnRecord['purpose']): AgentConfig {
    const session = this.task.sessions[agent];
    if (purpose === 'handoff' && session.launchedWith) return session.launchedWith;
    return this.task.config[agent];
  }

  private turnSpec(
    agent: AgentRole,
    session: AgentSession,
    prompt: string,
    schema: SchemaKind,
    turnId: string,
    signal: AbortSignal,
    launch: AgentConfig,
  ): TurnSpec {
    const { task, deps } = this;
    const c = task.config;
    const readOnly = c.plannerContextMode === 'read_only';
    const isPlanner = agent === 'planner';
    return {
      agent,
      prompt,
      ...(session.established ? { resumeSessionId: session.sessionId } : { newSessionId: session.sessionId }),
      model: launch.model,
      effort: launch.effort,
      cwd: isPlanner ? task.plannerCwd : task.projectDir,
      tools: isPlanner ? (readOnly ? PLANNER_READ_ONLY_TOOLS : []) : c.executorTools,
      ...(isPlanner ? {} : { disallowedTools: c.executorDisallowedTools, permissionMode: c.permissionMode }),
      systemPrompt: session.systemPrompt ?? '',
      schema,
      previousTotals: session.established ? (this.sessionTotals()[session.sessionId] ?? null) : null,
      maxTurns: c.maxTurnsPerSession,
      timeoutMs: c.turnTimeoutMs,
      slowTurnMs: c.slowTurnMs,
      rawDir: deps.store.rawDir(task.id),
      turnId,
      onEvent: (event) => deps.onNotice?.({ type: 'turn_event', taskId: task.id, agent, turnId, event }),
      signal,
    };
  }

  /** The session the next turn runs in; its system prompt is fixed on first use. */
  private prepareSession(agent: AgentRole): AgentSession {
    const session = this.task.sessions[agent];
    if (session.systemPrompt === null) {
      session.systemPrompt = systemPromptFor(agent, this.deps.rolePrompt(agent), this.task);
      session.startedAt = this.deps.now().toISOString();
    }
    return session;
  }

  /**
   * After every turn: the account check (§3.6 rule 8), then the turn is recorded. On a mismatch the
   * output is kept for Resume and nothing is acted on. Returns whether to go on processing.
   */
  private async afterTurn(record: TurnRecord): Promise<boolean> {
    const live = await this.deps.authStatus();
    const comparison = compareAccount(this.task.pinnedAccount, live);
    record.accountChanged = !comparison.match;
    this.emit({ type: 'turn', ...record });
    // SPEC.md §5 net 11: refused answers are logged whatever happens next.
    if (record.answerCheck) {
      this.emit({
        type: 'structured_output_rejected',
        turnId: record.turnId,
        agent: record.agent,
        purpose: record.purpose,
        cycle: record.cycle,
        ...record.answerCheck,
      });
    }
    if (comparison.match) return true;
    if (record.ok) this.task.deferredTurn = record;
    else this.prepareRetry(record, record.error?.message ?? 'the turn failed');
    this.task.lastProcessedTurnId = record.turnId;
    this.task.liveAccount = live;
    this.emit({ type: 'account_mismatch', when: 'after_turn', pinned: this.task.pinnedAccount, live, turnId: record.turnId });
    if (record.error?.kind === 'aborted') this.setStatus('stopped', 'Stopped by the user.');
    else this.setStatus('account_mismatch', `The account changed during this turn. ${comparison.reason ?? ''}`.trim());
    return false;
  }

  /** `stillWanted` false after the read: change nothing and answer false. */
  private async checkAccount(when: 'before_spawn' | 'resume', turnId: string | null, stillWanted: () => boolean = () => true): Promise<boolean> {
    const live = await this.deps.authStatus();
    if (!stillWanted()) return false;
    const comparison = compareAccount(this.task.pinnedAccount, live);
    if (comparison.match) {
      this.task.liveAccount = null;
      return true;
    }
    this.task.liveAccount = live;
    this.emit({ type: 'account_mismatch', when, pinned: this.task.pinnedAccount, live, turnId });
    this.setStatus(
      'account_mismatch',
      `${comparison.reason ?? 'The live account does not match.'} Pinned: ${describeAccount(this.task.pinnedAccount)}. Switch Claude Code back to that account, then Resume.`,
    );
    return false;
  }

  // -------------------------------------------------------------------------
  // Acting on a finished turn
  // -------------------------------------------------------------------------

  private async processTurn(record: TurnRecord): Promise<void> {
    this.task.lastProcessedTurnId = record.turnId;
    const wasRetry = this.settleServiceRetry(record);
    if (record.purpose === 'handoff') {
      if (record.ok) {
        this.task.loop.answerRetries = 0;
        this.completeRollover(record.agent, record.output as HandoffSummary, record.answerCheck ?? null);
      } else if (!(await this.retryAfterServiceError(record, wasRetry))) {
        this.handoffFailed(record);
      }
      return;
    }
    if (record.agent === 'executor') this.trackRejectedAnswers(record);
    if (!record.ok) {
      if (await this.retryAfterServiceError(record, wasRetry)) return;
      if (this.retryWithChangedRequest(record)) return;
      this.failTurn(record);
      return;
    }
    this.task.loop.answerRetries = 0;
    if (record.agent === 'planner') await this.onPlannerOutput(record.output as PlannerOutput, record);
    else await this.onExecutorOutput(record.output as ExecutorOutput, record);
  }

  /**
   * SPEC.md §5 net 11: the CLI gave up on the answer, so the same step is sent again with a different
   * request instead of the identical one. Bounded by ANSWER_RETRY_VARIATIONS and logged. Returns whether
   * the step was set up to run again.
   */
  private retryWithChangedRequest(record: TurnRecord): boolean {
    const { task } = this;
    const step = task.next;
    if (!isAnswerFailure(record.error) || !step || step.agent !== record.agent) return false;
    const used = task.loop.answerRetries ?? 0;
    const variation = ANSWER_RETRY_VARIATIONS[used];
    if (variation === undefined) return false;
    task.loop.answerRetries = used + 1;
    this.prepareRetry(record, record.error?.message ?? 'the answer was refused');
    // The changed request replaces the plain "did not finish" note: repeating that is what failed.
    step.retryNote = answerRetryNote(variation, record.answerCheck?.count ?? 0);
    this.emit({
      type: 'answer_retry',
      agent: record.agent,
      purpose: record.purpose,
      turnId: record.turnId,
      attempt: used + 1,
      variation,
      refusals: record.answerCheck?.count ?? 0,
    });
    this.save();
    return true;
  }

  /**
   * SPEC.md §15: a handoff the tool would not accept must never cost the task. One shorter attempt, then the
   * session is kept, the rollover is skipped and the Planner is told. Real stops (Stop, usage limit, account
   * mismatch) still stop the task.
   */
  private handoffFailed(record: TurnRecord): void {
    const { task } = this;
    const session = task.sessions[record.agent];
    const error = record.error;
    if (error?.kind === 'aborted' || error?.kind === 'rate_limited') {
      this.failTurn(record);
      return;
    }
    const attempts = (session.handoffAttempts ?? 0) + 1;
    session.handoffAttempts = attempts;
    if (isAnswerFailure(error) && attempts < HANDOFF_ATTEMPTS) {
      // The next pass through rolloverIfDue asks the same session for a shorter summary.
      this.save();
      return;
    }
    const reason = error ? `${error.kind}: ${error.message}` : 'the handoff turn failed';
    session.rolloverRequested = null;
    session.handoffAttempts = 0;
    session.rolloverBlocked = { reason, at: this.since() };
    this.emit({ type: 'rollover_skipped', agent: record.agent, reason, attempts });
    task.plannerNotes.push(rolloverSkippedNote(record.agent, reason));
    this.save();
  }

  /** The turn after a service-error wait: log how the retry went (SPEC.md §5 net 12). Returns whether it was one. */
  private settleServiceRetry(record: TurnRecord): boolean {
    const pending = this.task.loop.serviceRetry ?? null;
    if (pending === null) return false;
    this.task.loop.serviceRetry = null;
    this.emit({
      type: 'service_retry',
      outcome: record.ok ? 'recovered' : 'failed',
      agent: record.agent,
      purpose: record.purpose,
      turnId: record.turnId,
      retryOf: pending.turnId,
      errorKind: record.error?.kind ?? null,
      apiErrorStatus: record.error?.apiErrorStatus ?? null,
      message: record.error?.message ?? null,
      retryAt: null,
    });
    return true;
  }

  /**
   * SPEC.md §5 net 12: a turn that failed with a service error runs once more after a wait, while the task
   * stays running. Returns false when the failure takes its usual course instead (not a service error, or
   * already the retry). Returns true after the wait, or once Stop or Pause ended it early.
   */
  private async retryAfterServiceError(record: TurnRecord, wasRetry: boolean): Promise<boolean> {
    const { task, deps } = this;
    if (wasRetry || !isServiceError(record.error)) return false;
    const error = record.error;
    if (error === null) return false;
    const due = deps.now().getTime() + (deps.serviceRetryDelayMs ?? SERVICE_RETRY_DELAY_MS);
    const retryAt = new Date(due).toISOString();
    this.prepareRetry(record, error.message);
    task.loop.serviceRetry = { turnId: record.turnId, agent: record.agent, retryAt };
    this.emit({
      type: 'service_retry',
      outcome: 'retrying',
      agent: record.agent,
      purpose: record.purpose,
      turnId: record.turnId,
      retryOf: null,
      errorKind: error.kind,
      apiErrorStatus: error.apiErrorStatus ?? null,
      message: error.message,
      retryAt,
    });
    this.save();
    if (!this.stopRequested && !this.pauseRequested) {
      await new Promise<void>((resolve) => {
        const cancelTimer = deps.schedule(due, () => {
          this.cancelServiceWait = null;
          resolve();
        });
        this.cancelServiceWait = (wake = true) => {
          cancelTimer();
          this.cancelServiceWait = null;
          if (wake) resolve();
        };
      });
    }
    return true;
  }

  /**
   * SPEC.md §15 (setting, off by default): after N consecutive Executor turns with refused answers, the next
   * Executor turn starts in a fresh session — refusals tend to repeat within a session (NOTES.md §21.5).
   * A failed turn counts too; a turn without refusals, or a new session, starts the count again.
   */
  private trackRejectedAnswers(record: TurnRecord): void {
    const { task } = this;
    const session = task.sessions.executor;
    const streak = record.answerCheck ? task.loop.rejectedStreak + 1 : 0;
    task.loop.rejectedStreak = streak;
    const limit = task.config.freshExecutorAfterRejectedTurns;
    if (limit === null || streak < limit || session.rolloverRequested !== null) return;
    const reason = `${streak} Executor turns in a row had rejected answers (setting: a fresh session after ${limit})`;
    session.rolloverRequested = reason;
    this.emit({ type: 'rollover_requested', agent: 'executor', reason });
  }

  /** Session bookkeeping for a failed turn, so the same step can be retried. */
  private prepareRetry(record: TurnRecord, reason: string): void {
    const session = this.task.sessions[record.agent];
    if (record.error?.kind === 'session_gone' && session.sessionId === record.sessionId) {
      // SPEC.md §5 net 13: the CLI no longer has it. Start a fresh one, seeded with what the app
      // itself holds, and say so — the live context is gone and nothing may pretend otherwise.
      const oldId = session.sessionId;
      const why = `Claude Code no longer had session ${oldId}`;
      const fresh = this.retireSession(record.agent, `session gone: ${why}`);
      fresh.seed = restartSeed(record.agent, this.task);
      this.emit({ type: 'session_restarted', agent: record.agent, oldSessionId: oldId, newSessionId: fresh.sessionId, reason: why });
      const next = this.task.next;
      if (next && next.agent === record.agent) next.retryNote = null;
      return;
    }
    if (!session.established && session.sessionId === record.sessionId) {
      // The CLI never created it: reusing the id could fail ("already in use"), resuming it would ("No
      // conversation found"). A new id always works (NOTES.md §16).
      this.retireSession(record.agent, 'its first turn failed before the session was created');
    }
    const next = this.task.next;
    if (record.purpose !== 'handoff' && next && next.agent === record.agent) {
      const sawIt = this.task.sessions[record.agent].established || record.agent === 'executor';
      next.retryNote = sawIt ? retryNote(reason, record.agent) : null;
    }
  }

  private failTurn(record: TurnRecord): void {
    const error = record.error;
    const message = error ? `${error.kind}: ${error.message}` : 'the turn failed';
    this.prepareRetry(record, error?.message ?? 'it failed');
    const prefix = record.purpose === 'handoff' ? `Rollover of the ${record.agent} failed — ` : '';

    if (error?.kind === 'aborted') {
      this.setStatus('stopped', 'Stopped by the user.');
      return;
    }
    // The session was replaced in prepareRetry; the same step runs again in the new one, so this is
    // not an error the user has to resume from (SPEC.md §5 net 13).
    if (error?.kind === 'session_gone' && record.purpose !== 'handoff' && this.task.next?.agent === record.agent) return;
    if (error?.kind === 'rate_limited') {
      const resetsAt = error.resetsAt ?? record.rateLimit?.resetsAt ?? null;
      this.task.rateLimit = {
        resetsAt,
        rateLimitType: record.rateLimit?.rateLimitType ?? null,
        message: error.message,
        autoResumeAt: null,
      };
      this.emit({ type: 'rate_limit', status: 'rejected', resetsAt, rateLimitType: this.task.rateLimit.rateLimitType, turnId: record.turnId });
      const when = resetsAt ? ` Resets at ${new Date(resetsAt * 1000).toISOString()}.` : '';
      this.setStatus('rate_limited', `${prefix}${error.message}${when}`);
      this.scheduleAutoResume();
      return;
    }
    // SPEC.md §5 nets 3 and 4: timeout and process errors → error, resumable.
    this.setStatus('error', `${prefix}${message}`);
  }

  private async onPlannerOutput(out: PlannerOutput, record: TurnRecord): Promise<void> {
    const { task } = this;
    // SPEC.md §4: leaked tool-call markup means the fields were mixed up; nothing in the answer is acted on.
    if (record.answerCheck?.leakedMarkup) {
      this.refuse('malformed_answer', malformedAnswerRefusal(), []);
      return;
    }
    const planFirstPending = task.config.approvalMode === 'plan_first' && !task.planApproved;
    if (out.request_executor_rollover) {
      task.sessions.executor.rolloverRequested = 'the planner requested it';
      this.emit({ type: 'rollover_requested', agent: 'executor', reason: 'the planner requested it' });
    }

    // The user wrote while the Planner was deciding: never let a stopping answer swallow the message.
    // The messages are delivered at the top of the loop (to the Planner with this note, or to the
    // Executor first) and the Planner decides again. A `continue` is routed by applyMessage as usual.
    if (out.status !== 'continue' && task.queuedMessages.length > 0) {
      this.emit({ type: 'decision_held', plannerStatus: out.status, queued: task.queuedMessages.length });
      task.next = this.plannerStep('user_message', heldDecisionNote(out));
      return;
    }

    switch (out.status) {
      case 'plan_ready':
        task.next = null;
        task.loop.refusals = 0;
        this.wait({ kind: 'plan_approval', plan: out.question ?? '', since: this.since() }, 'The planner proposes a plan.');
        return;
      case 'needs_user':
      case 'blocked':
        task.next = null;
        task.loop.refusals = 0;
        this.wait(
          { kind: 'question', plannerStatus: out.status, question: out.question ?? '', since: this.since() },
          out.status === 'blocked' ? 'The planner is blocked.' : 'The planner has a question.',
        );
        return;
      case 'done': {
        if (planFirstPending) {
          this.refuse('plan_not_approved', planFirstRefusal(), []);
          return;
        }
        const missing = this.missingRequired();
        if (missing.length > 0) {
          const blocks = await this.environmentalBlocks(missing);
          const blocked = new Set(blocks.map((b) => b.skill));
          const runnable = missing.filter((skill) => !blocked.has(skill));
          if (runnable.length > 0) {
            const details = runnable.map((skill) => ({ skill, state: this.lastSkillState(skill) }));
            this.refuse('required_skills', requiredSkillsRefusal(details, blocks), runnable);
            return;
          }
          // Only environmentally impossible skills are left: the user decides (SPEC.md §16).
          task.next = null;
          task.loop.refusals = 0;
          this.wait({ kind: 'skill_waiver', skills: blocks, after: 'finish', finalReport: out.final_report ?? '', since: this.since() }, waiverReason(blocks));
          return;
        }
        this.finish(out.final_report ?? '');
        return;
      }
      case 'continue': {
        if (planFirstPending) {
          this.refuse('plan_not_approved', planFirstRefusal(), []);
          return;
        }
        task.loop.refusals = 0;
        const instruction = out.next_instruction ?? '';
        const useSkills = out.use_skills ?? [];
        const repeated = isRepeatedInstruction(task.loop.lastInstruction, instruction);
        task.loop.lastInstruction = normalizeInstruction(instruction);
        task.next = {
          agent: 'executor',
          purpose: 'instruction',
          instruction,
          useSkills,
          userMessage: null,
          needsApproval: this.effectiveApprovalMode() === 'review' || task.followUpApproval,
          carryToPlanner: null,
          reasoning: out.reasoning_summary,
          cycle: null,
          prompt: executorPrompt({ instruction, useSkills, userMessage: null }),
          retryNote: null,
        };
        if (repeated) {
          const reason = 'Possible loop: the planner sent the same instruction twice in a row.';
          this.emit({ type: 'loop_detected', kind: 'identical_instruction', detail: instruction });
          this.wait({ kind: 'possible_loop', reason, since: this.since() }, reason);
        }
        return;
      }
    }
  }

  private effectiveApprovalMode(): 'auto' | 'review' | 'plan_first' {
    const mode = this.task.config.approvalMode;
    return mode === 'plan_first' && this.task.planApproved ? 'auto' : mode;
  }

  private refuse(reason: RefusalReason, text: string, missing: string[]): void {
    const { task } = this;
    task.loop.refusals += 1;
    this.emit({ type: 'refused', reason, detail: text, missing });
    task.next = this.plannerStep('refusal', text);
    if (task.loop.refusals >= MAX_CONSECUTIVE_REFUSALS) {
      const detail =
        reason === 'required_skills'
          ? `required skills not run: ${missing.join(', ')}`
          : reason === 'plan_not_approved'
            ? 'plan not approved yet'
            : 'tool-call markup inside its answer';
      const why = `Possible loop: the orchestrator refused the planner's answer ${task.loop.refusals} times in a row (${detail}).`;
      task.loop.refusals = 0;
      this.emit({ type: 'loop_detected', kind: 'repeated_refusals', detail: why });
      this.wait({ kind: 'possible_loop', reason: why, since: this.since() }, why);
    }
  }

  /** The most recent outcome recorded for a skill, in words, for refusal messages. */
  private lastSkillState(skill: string): string {
    return this.task.skills.lastStates[skill] ?? 'never requested';
  }

  /** Required skills neither run successfully nor waived. */
  private missingRequired(): string[] {
    const done = [...this.task.skills.satisfied, ...this.task.skills.waived.map((w) => w.skill)];
    return missingRequiredSkills(this.task.config.requiredSkills, done);
  }

  /** Which of these skills cannot run here for an environmental reason (never a failure or a refusal). */
  private async environmentalBlocks(skills: readonly string[]): Promise<SkillBlock[]> {
    const { task, deps } = this;
    if (task.git.isRepo) task.git.hasRemote = await deps.git.hasRemote(task.projectDir).catch(() => task.git.hasRemote);
    const context = { available: task.skills.available, isRepo: task.git.isRepo, hasRemote: task.git.hasRemote };
    return skills.flatMap((skill) => {
      const reason = environmentalReason(skill, context);
      return reason === null ? [] : [{ skill, reason }];
    });
  }

  private finish(finalReport: string): void {
    this.task.finalReport = finalReport;
    this.task.next = null;
    this.task.followUpApproval = false;
    this.emit({ type: 'done', finalReport });
    this.setStatus('done', null);
  }

  private async onExecutorOutput(out: ExecutorOutput, record: TurnRecord): Promise<void> {
    const { task, deps } = this;
    const step = task.next;
    if (step?.agent !== 'executor') throw new Error('An executor turn finished, but the pending step is not an executor step.');
    const cycle = record.cycle ?? step.cycle ?? task.cycles;

    if (task.git.isRepo) task.git.hasRemote = await deps.git.hasRemote(task.projectDir).catch(() => task.git.hasRemote);
    const outcomes = skillOutcomes(step.useSkills, record.skillInvocations, task.git.hasRemote);
    for (const o of outcomes) {
      task.skills.lastStates[o.skill] = describeSkillState(o.state);
      if (o.state === 'ok' && task.config.requiredSkills.includes(o.skill) && !task.skills.satisfied.includes(o.skill)) {
        task.skills.satisfied.push(o.skill);
      }
    }

    let learned: string[] | null = null;
    if (task.skills.available === null && record.init) {
      task.skills.available = availableSkills(record.init, task.config.requiredSkills).available;
      task.skills.discoveredFrom = 'executor_init';
      learned = task.skills.available;
    }

    const commit: CommitInfo =
      out.status === 'ok'
        ? await this.commit(cycle, step, 'cycle')
        : { state: 'skipped', reason: `the executor reported status "${out.status}", so nothing was committed.` };

    const changed = normalizeFileSet(
      out.changed_files.map((f) => f.path),
      process.platform === 'win32',
    );
    const tracked = trackTurns(task.loop.recentTurns, { files: changed, instruction: step.instruction });
    task.loop.recentTurns = tracked.history;

    const killed = record.processes.survivors.map((s) => s.name ?? `pid ${s.pid}`);
    this.emit({
      type: 'cycle',
      cycle,
      turnId: record.turnId,
      instruction: step.instruction,
      userMessage: step.userMessage,
      useSkills: step.useSkills,
      executorStatus: out.status,
      changedFiles: changed,
      skillOutcomes: outcomes,
      commit,
      slow: record.slow,
      durationMs: record.durationMs,
      killedProcesses: record.processes.count,
      permissionDenials: record.permissionDenials,
      modelMismatch: record.model.matches === false ? { requested: record.model.requested, served: record.model.served } : null,
      accountChanged: record.accountChanged,
      answerCheck: record.answerCheck ?? null,
    });

    const gitActive = task.git.enabled && task.git.isRepo;
    const report = executorReportPrompt(out, {
      answerCheck: record.answerCheck ?? null,
      toolUses: record.toolUses ?? {},
      cycle,
      maxCycles: task.config.maxCycles,
      durationMs: record.durationMs,
      slow: record.slow,
      slowTurnMs: record.slowTurnMs,
      skillOutcomes: outcomes,
      permissionDenials: record.permissionDenials,
      killedProcesses: killed,
      commit: gitActive ? commit : null,
      userMessage: step.userMessage,
      skillsLearned: learned,
    });
    task.next = this.plannerStep('executor_report', step.carryToPlanner ? `${step.carryToPlanner}\n\n${report}` : report);

    // A required skill the environment blocked: ask now, before the Planner builds on it (SPEC.md §16).
    const missing = this.missingRequired();
    const blockedNow = outcomes.filter((o) => o.requested && o.state === 'skipped_no_remote' && missing.includes(o.skill));
    if (blockedNow.length > 0) {
      const blocks = await this.environmentalBlocks(blockedNow.map((o) => o.skill));
      if (blocks.length > 0) {
        this.wait({ kind: 'skill_waiver', skills: blocks, after: 'continue', finalReport: null, since: this.since() }, waiverReason(blocks));
        return;
      }
    }

    if (tracked.pingPong) {
      const similarity = Math.round((tracked.similarity ?? 0) * 100) / 100;
      const reason = `Possible loop: the same files changed in ${tracked.history.length} executor turns in a row (${changed.join(', ')}), and the planner's instructions repeated in substance.`;
      task.loop.recentTurns = [];
      this.emit({ type: 'loop_detected', kind: 'file_ping_pong', detail: reason, similarity });
      this.wait({ kind: 'possible_loop', reason, since: this.since() }, reason);
    }
  }

  // -------------------------------------------------------------------------
  // Git (§18)
  // -------------------------------------------------------------------------

  private async commit(cycle: number | null, step: ExecutorStep, purpose: 'cycle' | 'before_review'): Promise<CommitInfo> {
    const { task, deps } = this;
    const git = task.git;
    let info: CommitInfo;
    if (!git.enabled) info = { state: 'skipped', reason: 'auto-commit is off for this task.' };
    else if (!git.isRepo) info = { state: 'skipped', reason: 'the project is not a git repository.' };
    else {
      let current: string | null = null;
      let branchError: string | null = null;
      try {
        current = await deps.git.currentBranch(task.projectDir);
      } catch (err) {
        branchError = err instanceof Error ? err.message : String(err);
      }
      if (branchError !== null) {
        info = { state: 'failed', error: branchError };
      } else if (current !== git.branch) {
        info = { state: 'skipped', reason: `the project is on ${current ?? 'a detached HEAD'}, not ${git.branch ?? 'the task branch'}; nothing was committed.` };
      } else {
        const label = step.instruction ?? (step.userMessage !== null ? `user message: ${step.userMessage}` : 'changes');
        const message =
          purpose === 'cycle'
            ? `[${APP_SLUG}] cycle ${cycle ?? '?'}: ${shortSummary(label)}`
            : `[${APP_SLUG}] before cycle ${cycle ?? '?'}: snapshot for ${step.useSkills.join(', ')}`;
        try {
          const result = await deps.git.commitAll(task.projectDir, message);
          info = result.committed && result.hash
            ? { state: 'committed', hash: result.hash, message, files: result.files }
            : { state: 'nothing_to_commit' };
        } catch (err) {
          info = { state: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    if (git.enabled && git.isRepo) this.emit({ type: 'commit', cycle, purpose, info });
    return info;
  }

  /** Task start with a dirty tree: commit the user's work on the task branch first (decided 2026-09-16). */
  private async snapshotCommit(): Promise<void> {
    const { task, deps } = this;
    const message = `[${APP_SLUG}] snapshot before task`;
    let result;
    try {
      result = await deps.git.commitAll(task.projectDir, message);
    } catch (err) {
      throw new Error(
        `could not commit the snapshot of the uncommitted changes that were already in the project: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!result.committed || result.hash === null) return;
    task.git.snapshot = { hash: result.hash, files: result.files, at: this.since() };
    this.emit({ type: 'commit', cycle: null, purpose: 'snapshot', info: { state: 'committed', hash: result.hash, message, files: result.files } });
  }

  /** §18: a remote-diffing skill reviews committed changes, so commit first. */
  private async commitBeforeReview(step: ExecutorStep): Promise<void> {
    if (!step.useSkills.some((s) => SKILLS_NEEDING_REMOTE.includes(s))) return;
    if (!this.task.git.enabled || !this.task.git.isRepo) return;
    await this.commit(step.cycle ?? this.task.cycles + 1, step, 'before_review');
  }

  // -------------------------------------------------------------------------
  // Rollover (§15)
  // -------------------------------------------------------------------------

  private async rolloverIfDue(agent: AgentRole): Promise<boolean> {
    const { task } = this;
    const session = task.sessions[agent];
    const model = task.config[agent].model;
    const due = rolloverDue(session.lastContextTokens, model, task.config.rolloverPercent);
    // A handoff this session could not produce blocks further automatic tries (SPEC.md §15).
    if (session.rolloverBlocked && session.rolloverRequested === null) return true;
    const reason =
      session.rolloverRequested ??
      (due.due
        ? `context ${session.lastContextTokens?.toLocaleString('en-US')} tokens exceeded the rollover threshold ${due.threshold.toLocaleString('en-US')} (${task.config.rolloverPercent}% of ${model}'s auto-compact point)`
        : null);
    if (reason === null) return true;

    if (!session.established) {
      // Nothing to hand off yet.
      session.rolloverRequested = null;
      this.save();
      return true;
    }
    session.rolloverRequested = reason;
    if (!(await this.checkAccount('before_spawn', null))) return false;
    if (this.stopRequested || this.pauseRequested) return false;

    const turnId = this.deps.newTurnId(agent);
    const prompt = handoffRequest((session.handoffAttempts ?? 0) > 0);
    this.prepareSession(agent);
    const launch = this.launchConfig(agent, 'handoff');
    this.emit({
      type: 'turn_started',
      turnId,
      agent,
      purpose: 'handoff',
      cycle: null,
      sessionId: session.sessionId,
      resumed: true,
      model: launch.model,
      effort: launch.effort,
      prompt,
    });
    this.save();
    const record = await this.runAgentTurn(agent, prompt, 'handoff-summary', turnId, 'handoff', null);
    if (!(await this.afterTurn(record))) return false;
    await this.processTurn(record);
    this.save();
    // Either the rollover happened, or it was skipped and the step goes ahead in the session we kept.
    return record.ok || (this.task.status === 'running' && session.rolloverRequested === null);
  }

  private completeRollover(agent: AgentRole, summary: HandoffSummary, answerCheck: AnswerCheck | null): void {
    const session = this.task.sessions[agent];
    const reason = session.rolloverRequested ?? 'rollover';
    const oldId = session.sessionId;
    const fresh = this.retireSession(agent, `rolled over: ${reason}`);
    fresh.seed = rolloverSeed(summary, agent, this.task, answerCheck);
    this.emit({ type: 'rollover', agent, oldSessionId: oldId, newSessionId: fresh.sessionId, reason, summary });
  }

  /** Replace an agent's session with a new one; the old id is kept for audit. */
  private retireSession(agent: AgentRole, reason: string): AgentSession {
    const old = this.task.sessions[agent];
    const fresh = freshSession(this.deps.newSessionId());
    fresh.retired = [...old.retired, { sessionId: old.sessionId, retiredAt: this.deps.now().toISOString(), reason, turns: old.turns }];
    this.task.sessions[agent] = fresh;
    // The rejected-answer count is per session (SPEC.md §15).
    if (agent === 'executor') this.task.loop.rejectedStreak = 0;
    this.task.loop.answerRetries = 0;
    return fresh;
  }

  // -------------------------------------------------------------------------
  // Interventions (§6)
  // -------------------------------------------------------------------------

  private applyQueuedMessages(): void {
    const queue = this.task.queuedMessages;
    if (queue.length === 0) return;
    this.task.queuedMessages = [];
    // Several messages arrive together, in the order they were sent. They all go to the Planner
    // (SPEC.md §6); a task.json written before that rule may hold messages addressed to the
    // Executor, and they go to the Planner too.
    this.applyMessage('planner', queue.map((m) => m.text).join('\n\n'), '');
    this.save();
  }

  /** Route a user message into the pending step (see NOTES.md §16 for the rules). */
  private applyMessage(to: AgentRole, text: string, preface: string): void {
    const { task } = this;
    const next = task.next;
    const block = preface + userMessageBlock(text);
    if (to === 'planner') {
      if (next?.agent === 'planner') {
        next.prompt = `${block}\n\n${next.prompt}`;
      } else if (next?.agent === 'executor' && next.instruction !== null) {
        const carry = next.carryToPlanner ? `\n\n${next.carryToPlanner}` : '';
        task.next = this.plannerStep('user_message', `${block}\n\n${unsentInstructionNote(next.instruction)}${carry}`);
      } else if (next?.agent === 'executor') {
        next.carryToPlanner = next.carryToPlanner ? `${block}\n\n${next.carryToPlanner}` : block;
      } else {
        task.next = this.plannerStep('user_message', block);
      }
      return;
    }
    if (next?.agent === 'executor') {
      next.userMessage = next.userMessage !== null ? `${next.userMessage}\n\n${text}` : text;
      next.prompt = executorPrompt(next);
      return;
    }
    task.next = {
      agent: 'executor',
      purpose: 'user_message',
      instruction: null,
      useSkills: [],
      userMessage: text,
      needsApproval: false,
      carryToPlanner: next?.agent === 'planner' ? composeStdin(next, null) : null,
      reasoning: null,
      cycle: null,
      prompt: executorPrompt({ instruction: null, useSkills: [], userMessage: text }),
      retryNote: null,
    };
  }

  private plannerStep(purpose: PlannerStep['purpose'], prompt: string): PlannerStep {
    return { agent: 'planner', purpose, prompt, retryNote: null };
  }

  private requireWaiting<K extends WaitingState['kind']>(kinds: readonly K[]): Extract<WaitingState, { kind: K }> {
    const waiting = this.task.waiting;
    if (this.task.status !== 'waiting_user' || !waiting || !(kinds as readonly string[]).includes(waiting.kind)) {
      throw new TaskStateError(`The task is not waiting for that (status ${this.task.status}${waiting ? `, ${waiting.kind}` : ''}).`);
    }
    return waiting as Extract<WaitingState, { kind: K }>;
  }

  private requireText(text: string): string {
    const body = text.trim();
    if (!body) throw new TaskStateError('The message is empty.');
    return body;
  }

  // -------------------------------------------------------------------------
  // Rate limits (§17)
  // -------------------------------------------------------------------------

  private scheduleAutoResume(): void {
    const { task, deps } = this;
    const resetsAt = task.rateLimit?.resetsAt ?? null;
    if (!deps.general.autoResumeAtReset || resetsAt === null || task.status !== 'rate_limited') return;
    // Skipped once because another task ran: from here on the user decides.
    if (task.rateLimit?.autoResumeSkipped) return;
    this.clearAutoResume();
    const at = resetsAt * 1000 + AUTO_RESUME_MARGIN_MS;
    const iso = new Date(at).toISOString();
    if (task.rateLimit && task.rateLimit.autoResumeAt !== iso) {
      task.rateLimit.autoResumeAt = iso;
      this.emit({ type: 'auto_resume_scheduled', at: iso });
      this.save();
    }
    this.cancelAutoResume = deps.schedule(at, () => {
      this.cancelAutoResume = null;
      if (this.task.status !== 'rate_limited') return;
      if (deps.autoResume) deps.autoResume(this.task.id);
      else void this.resume().catch((err: unknown) => this.internalError(err));
    });
  }

  private clearAutoResume(): void {
    this.cancelAutoResume?.();
    this.cancelAutoResume = null;
  }
}

