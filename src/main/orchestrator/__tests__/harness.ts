/**
 * Test harness for the orchestrator: a scripted fake session runner, fake git and auth, and the real
 * TaskStore in a temp folder — so persistence is checked on disk, exactly as the app would write it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'vitest';

import { APP_SLUG } from '../../../shared/app-config';
import type { TurnOutcome, TurnSpec, TurnErrorKind } from '../../session-runner/types';
import { TaskRunner } from '../orchestrator';
import { TaskStore } from '../task-store';
import type {
  AccountRecord,
  AgentRole,
  AuthReading,
  ExecutorOutput,
  GitInspection,
  GitOps,
  HandoffSummary,
  InitProbeResult,
  OrchestratorDeps,
  PlannerOutput,
  TaskConfig,
  TaskEvent,
  TaskNotification,
  TaskRecord,
  UsageLedgerPort,
} from '../types';

export const PINNED_ACCOUNT: AccountRecord = {
  email: 'owner@example.com',
  orgId: 'org-1',
  orgName: "owner@example.com's Organization",
  subscriptionType: 'max',
  authMethod: 'claude.ai',
  apiKeySource: null,
};

export const PINNED: AuthReading = { ok: true, loggedIn: true, account: PINNED_ACCOUNT };

export const OTHER: AuthReading = {
  ok: true,
  loggedIn: true,
  account: { ...PINNED_ACCOUNT, email: 'work@example.com', orgId: 'org-2', orgName: 'Work', subscriptionType: 'team' },
};

export const P = {
  cont: (instruction: string, extra: Partial<PlannerOutput> = {}): PlannerOutput => ({
    status: 'continue',
    reasoning_summary: 'next step',
    next_instruction: instruction,
    ...extra,
  }),
  done: (report = 'All finished and verified.'): PlannerOutput => ({ status: 'done', reasoning_summary: 'complete', final_report: report }),
  ask: (question: string): PlannerOutput => ({ status: 'needs_user', reasoning_summary: 'need input', question }),
  blocked: (question: string): PlannerOutput => ({ status: 'blocked', reasoning_summary: 'stuck', question }),
  plan: (plan: string): PlannerOutput => ({ status: 'plan_ready', reasoning_summary: 'plan', question: plan }),
};

export const E = {
  ok: (files: string[] = ['README.md'], extra: Partial<ExecutorOutput> = {}): ExecutorOutput => ({
    status: 'ok',
    summary: 'Did it.',
    changed_files: files.map((p) => ({ path: p, change: 'modified' as const })),
    tests: { ran: true, passed: 1, failed: 0 },
    problems: [],
    ...extra,
  }),
  failed: (problem: string): ExecutorOutput => ({
    status: 'failed',
    summary: 'Could not do it.',
    changed_files: [],
    tests: { ran: false },
    problems: [problem],
  }),
  needsInput: (question: string): ExecutorOutput => ({
    status: 'needs_input',
    summary: 'Need a decision.',
    changed_files: [],
    tests: { ran: false },
    problems: [],
    question,
  }),
};

export const HANDOFF: HandoffSummary = {
  task_restatement: 'Write the README.',
  done_so_far: ['created README.md'],
  remaining: ['verify'],
  decisions: ['plain markdown'],
  constraints: [],
  open_problems: [],
  key_files: ['README.md'],
};

type OutcomeExtra = Partial<Omit<TurnOutcome, 'ok'>>;

function base(spec: TurnSpec, extra: OutcomeExtra) {
  const sessionId = spec.resumeSessionId ?? spec.newSessionId ?? 'missing';
  return {
    turnId: spec.turnId ?? 'turn',
    agent: spec.agent,
    sessionId,
    resumed: spec.resumeSessionId !== undefined,
    startedAt: new Date().toISOString(),
    durationMs: 1500,
    exitCode: 0,
    rawPath: path.join(spec.rawDir, `${spec.turnId}.ndjson`),
    stderrPath: path.join(spec.rawDir, `${spec.turnId}.stderr`),
    systemPromptPath: path.join(spec.rawDir, `${spec.turnId}.system.md`),
    args: [],
    init: { sessionId, model: 'claude-opus-5', skills: [], slashCommands: [] },
    usage: {
      contextTokens: 5_000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 2,
      costUsd: 0.01,
      modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      sessionCostUsd: 0.01,
      sessionModelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
    },
    model: { requested: spec.model, announced: 'claude-opus-5', served: 'claude-opus-5', canonical: 'claude-opus-5', contextWindow: 1_000_000, matches: true },
    permissionDenials: [],
    skillInvocations: [],
    answerRejections: { count: 0, reasons: [], largestAttemptChars: 0 },
    toolUses: {},
    rateLimit: null,
    slow: false,
    slowTurnMs: spec.slowTurnMs ?? null,
    processes: { method: 'job' as const, survivors: [], errors: [] },
    resultText: null,
    ...extra,
  };
}

export function okOutcome(spec: TurnSpec, output: unknown, extra: OutcomeExtra = {}): TurnOutcome {
  return { ...base(spec, extra), ok: true, output };
}

export function failOutcome(
  spec: TurnSpec,
  kind: TurnErrorKind,
  extra: OutcomeExtra & { message?: string; rawText?: string; resetsAt?: number; apiErrorStatus?: number | null } = {},
): TurnOutcome {
  const { message, rawText, resetsAt, apiErrorStatus, ...rest } = extra;
  return {
    ...base(spec, { usage: null, ...rest }),
    ok: false,
    error: {
      kind,
      message: message ?? `failure: ${kind}`,
      rawText: rawText ?? `raw ${kind} output`,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(apiErrorStatus !== undefined ? { apiErrorStatus } : {}),
    },
  };
}

export class FakeGit implements GitOps {
  isRepo = true;
  branch: string | null = 'main';
  head: string | null = 'start000';
  remote = false;
  dirty: string[] = [];
  /** Files the next commitAll stages; empty = nothing to commit. */
  pending: string[] = [];
  failCommit: string | null = null;
  /** Git cannot run at all (not installed, timed out, refused). */
  unavailable: string | null = null;
  commits: Array<{ message: string; files: string[]; branch: string | null }> = [];
  switches: string[] = [];

  async inspect(): Promise<GitInspection> {
    if (this.unavailable) throw new Error(this.unavailable);
    return { isRepo: this.isRepo, branch: this.branch, head: this.head, hasRemote: this.remote, dirty: [...this.dirty] };
  }
  async switchToBranch(_dir: string, name: string): Promise<void> {
    this.switches.push(name);
    this.branch = name;
  }
  async currentBranch(): Promise<string | null> {
    if (this.unavailable) throw new Error(this.unavailable);
    return this.branch;
  }
  async hasRemote(): Promise<boolean> {
    return this.remote;
  }
  async commitAll(_dir: string, message: string) {
    if (this.failCommit) throw new Error(this.failCommit);
    if (this.pending.length === 0) return { committed: false, hash: null, files: [] };
    const files = this.pending;
    this.pending = [];
    this.commits.push({ message, files, branch: this.branch });
    return { committed: true, hash: `hash${this.commits.length}`.padEnd(40, '0'), files };
  }
}

type Handler = (spec: TurnSpec) => TurnOutcome | Promise<TurnOutcome>;

export const TEST_CONFIG: TaskConfig = {
  planner: { model: 'opus', effort: 'low' },
  executor: { model: 'sonnet', effort: 'low' },
  maxCycles: 25,
  turnTimeoutMs: 60_000,
  slowTurnMs: 30_000,
  maxTurnsPerSession: 40,
  approvalMode: 'auto',
  plannerContextMode: 'isolated',
  standingInstructions: { planner: '', executor: '' },
  rolloverPercent: 60,
  freshExecutorAfterRejectedTurns: null,
  requiredSkills: [],
  autoBranchAndCommit: true,
  executorTools: ['Read', 'Edit', 'Write', 'Bash', 'Skill'],
  executorDisallowedTools: [],
  permissionMode: 'dontAsk',
};

export class Harness {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-orch-`));
  readonly projectDir = path.join(this.dir, 'project');
  readonly store = new TaskStore(path.join(this.dir, 'tasks'));
  readonly git = new FakeGit();
  auth: AuthReading = PINNED;
  authCalls = 0;
  probe: () => Promise<InitProbeResult> = async () => ({ skills: ['deep-research'], slashCommands: ['security-review', 'clear'] });
  probeCalls = 0;
  readonly queue: Array<{ agent: AgentRole; fn: Handler }> = [];
  readonly specs: TurnSpec[] = [];
  /** task.json and events.jsonl as they were on disk when each turn was spawned. */
  readonly diskAtSpawn: Array<{ task: TaskRecord; events: TaskEvent[] }> = [];
  readonly notifications: TaskNotification[] = [];
  readonly scheduled: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  clock = new Date('2026-09-16T10:00:00Z');
  general = { autoResumeAtReset: false, softDailyTokenCap: null as number | null };
  usageTokens = 0;
  private sessionCounter = 0;
  private turnCounter = 0;
  unexpected: string[] = [];

  constructor() {
    fs.mkdirSync(this.projectDir);
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  remote(value: boolean): this {
    this.git.remote = value;
    return this;
  }

  /** Put task.json and events.jsonl back to how they were when turn `index` was spawned (simulated crash). */
  rewind(taskId: string, index: number, events?: TaskEvent[]): void {
    const disk = this.diskAtSpawn[index];
    if (!disk) throw new Error(`no spawn #${index}`);
    this.store.writeTask(disk.task);
    const list = events ?? disk.events;
    fs.writeFileSync(this.store.eventsFile(taskId), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  /** Script the next turn. */
  on(agent: AgentRole, fn: Handler): this {
    this.queue.push({ agent, fn });
    return this;
  }

  planner(output: PlannerOutput | HandoffSummary, extra: OutcomeExtra = {}): this {
    return this.on('planner', (spec) => okOutcome(spec, output, extra));
  }

  executor(output: ExecutorOutput | HandoffSummary, extra: OutcomeExtra = {}): this {
    return this.on('executor', (spec) => okOutcome(spec, output, extra));
  }

  get usage(): UsageLedgerPort {
    return {
      record: (_at, modelUsage) => {
        for (const u of Object.values(modelUsage)) {
          const r = u as Record<string, number>;
          this.usageTokens += (r['inputTokens'] ?? 0) + (r['outputTokens'] ?? 0);
        }
      },
      recordWindows: () => {},
      tokensOn: () => this.usageTokens,
    };
  }

  deps(): OrchestratorDeps {
    return {
      runTurn: async (spec) => {
        this.specs.push(spec);
        const taskId = path.basename(path.dirname(spec.rawDir));
        this.diskAtSpawn.push({ task: this.store.readTask(taskId), events: this.store.readEvents(taskId) });
        const next = this.queue.shift();
        if (!next) {
          this.unexpected.push(`${spec.agent}: ${spec.prompt.slice(0, 300)}`);
          return failOutcome(spec, 'process_failed', { message: 'UNEXPECTED TURN (test script exhausted)' });
        }
        expect(spec.agent, `turn ${this.specs.length} agent`).toBe(next.agent);
        return next.fn(spec);
      },
      probeInit: async () => {
        this.probeCalls += 1;
        return this.probe();
      },
      authStatus: async () => {
        this.authCalls += 1;
        return this.auth;
      },
      git: this.git,
      store: this.store,
      usage: this.usage,
      rolePrompt: (agent) => `ROLE PROMPT FOR ${agent.toUpperCase()}`,
      now: () => this.clock,
      newSessionId: () => `session-${++this.sessionCounter}`,
      newTurnId: (agent) => `turn-${++this.turnCounter}-${agent}`,
      schedule: (at, fn) => {
        const entry = { at, fn, cancelled: false };
        this.scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
      notify: (n) => this.notifications.push(n),
      general: this.general,
    };
  }

  async create(config: Partial<TaskConfig> = {}, description = 'Add a README with the project name.'): Promise<TaskRunner> {
    return TaskRunner.create({ description, projectDir: this.projectDir, config: { ...TEST_CONFIG, ...config } }, this.deps());
  }

  task(runner: TaskRunner): TaskRecord {
    return this.store.readTask(runner.id);
  }

  events(runner: TaskRunner): TaskEvent[] {
    return this.store.readEvents(runner.id);
  }

  eventsOf<T extends TaskEvent['type']>(runner: TaskRunner, type: T): Array<Extract<TaskEvent, { type: T }>> {
    return this.events(runner).filter((e): e is Extract<TaskEvent, { type: T }> => e.type === type);
  }

  statuses(runner: TaskRunner): string[] {
    return this.eventsOf(runner, 'status').map((e) => e.to);
  }

  /** The script was fully consumed and nothing unexpected ran. */
  assertScriptDone(): void {
    expect(this.unexpected, 'unexpected turns').toEqual([]);
    expect(this.queue.length, 'unconsumed scripted turns').toBe(0);
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
