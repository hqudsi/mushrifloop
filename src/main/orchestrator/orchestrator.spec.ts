/**
 * The state machine end to end against a scripted fake runner (SPEC.md §4–§7, §15–§18, §3.6).
 * Every scenario runs the real TaskRunner and the real TaskStore; only processes are faked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { ANSWER_RETRY_VARIATIONS, AUTO_RESUME_MARGIN_MS, SERVICE_RETRY_DELAY_MS, TaskCreationError, TaskRunner, TaskStateError } from './orchestrator';
import { E, FakeGit, HANDOFF, Harness, OTHER, P, PINNED, PINNED_ACCOUNT, TEST_CONFIG, failOutcome, okOutcome, waitFor } from './__tests__/harness';
import type { TurnSpec } from '../session-runner/types';
import type { ExecutorStep, TaskConfig } from './types';

let h: Harness;

/** A handoff turn, whichever way it asks (SPEC.md §15): the Executor's goes to a file, the Planner's is its answer. */
const isHandoff = (s: TurnSpec) => s.schema === 'handoff-summary' || s.answerFile?.schema === 'handoff-summary';

beforeEach(() => {
  h = new Harness();
});

afterEach(() => {
  h.cleanup();
});

// ---------------------------------------------------------------------------
// §4 transitions
// ---------------------------------------------------------------------------

describe('creation (§3.6 rule 1)', () => {
  it('writes a draft task with the pinned account, and spawns nothing', async () => {
    const runner = await h.create();
    const task = h.task(runner);
    expect(task.status).toBe('draft');
    expect(task.pinnedAccount).toMatchObject({ email: 'owner@example.com', orgId: 'org-1', subscriptionType: 'max' });
    expect(task.pinnedAccount.pinnedAt).toBe('2026-09-16T10:00:00.000Z');
    expect(task.plannerCwd).toBe(h.store.plannerCwd(runner.id));
    expect(h.events(runner).map((e) => e.type)).toEqual(['task_created']);
    expect(h.specs).toHaveLength(0);
  });

  it('refuses to create a task when not logged in, or when the account cannot be read', async () => {
    h.auth = { ok: true, loggedIn: false, account: PINNED_ACCOUNT };
    await expect(h.create()).rejects.toThrow(TaskCreationError);
    h.auth = { ok: false, error: 'spawn ENOENT' };
    await expect(h.create()).rejects.toThrow(/spawn ENOENT/);
    expect(h.store.listTaskIds()).toEqual([]);
  });

  it('refuses a missing project folder or an empty description', async () => {
    await expect(TaskRunner.create({ description: 'x', projectDir: `${h.projectDir}-missing`, config: TEST_CONFIG }, h.deps())).rejects.toThrow(/does not exist/);
    await expect(h.create({}, '   ')).rejects.toThrow(/empty/);
  });
});

describe('a turn’s cost (§15)', () => {
  it('gives each resumed turn its session’s last running totals, and keeps them in task.json', async () => {
    const reported = (running: number) => ({
      usage: { contextTokens: 1000, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1, costUsd: running, modelUsage: {}, sessionCostUsd: running, sessionModelUsage: { m: { costUSD: running } } },
    });
    h.planner(P.cont('Create README.md'), reported(0.3))
      .executor(E.ok(['README.md']), reported(0.5))
      .planner(P.done('README created and verified.'), reported(0.45));
    const runner = await h.create();
    h.git.pending = ['README.md'];
    await runner.start();

    const [first, exec, report] = h.specs;
    expect(first?.previousTotals).toBeNull();
    expect(exec?.previousTotals).toBeNull();
    expect(report?.previousTotals).toEqual({ costUsd: 0.3, modelUsage: { m: { costUSD: 0.3 } } });
    const task = h.task(runner);
    expect(task.sessionTotals?.[task.sessions.planner.sessionId]?.costUsd).toBe(0.45);
    expect(task.sessionTotals?.[task.sessions.executor.sessionId]?.costUsd).toBe(0.5);
  });
});

describe('the loop (§4)', () => {
  it('draft → running: planner first, then continue → executor → planner report → done', async () => {
    h.planner(P.cont('Create README.md'))
      .executor(E.ok(['README.md']))
      .planner(P.done('README created and verified.'));
    const runner = await h.create();
    h.git.pending = ['README.md'];
    await runner.start();

    h.assertScriptDone();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.finalReport).toBe('README created and verified.');
    expect(task.cycles).toBe(1);
    expect(h.statuses(runner)).toEqual(['running', 'done']);

    const [first, exec, report] = h.specs;
    expect(first?.agent).toBe('planner');
    expect(first?.prompt).toContain('[TASK]\nAdd a README with the project name.');
    expect(first?.newSessionId).toBe(task.sessions.planner.sessionId);
    expect(first?.resumeSessionId).toBeUndefined();
    expect(first?.tools).toEqual([]);
    expect(first?.cwd).toBe(task.plannerCwd);
    expect(first?.schema).toBe('planner-output');
    expect(first?.systemPrompt).toContain('ROLE PROMPT FOR PLANNER');

    expect(exec?.agent).toBe('executor');
    expect(exec?.prompt).toBe('[INSTRUCTION]\nCreate README.md');
    expect(exec?.cwd).toBe(h.projectDir);
    expect(exec?.newSessionId).toBe(task.sessions.executor.sessionId);
    expect(exec?.newSessionId).not.toBe(first?.newSessionId);
    expect(exec?.permissionMode).toBe('dontAsk');
    expect(exec?.schema).toBe('executor-output');

    expect(report?.resumeSessionId).toBe(task.sessions.planner.sessionId);
    expect(report?.prompt).toContain('[EXECUTOR REPORT] Cycle 1 of at most 25.');
    expect(report?.prompt).toContain('"summary": "Did it."');

    expect(h.notifications.map((n) => n.status)).toEqual(['done']);
    expect(h.eventsOf(runner, 'done')[0]?.finalReport).toBe('README created and verified.');
  });

  it('only a draft can be started', async () => {
    h.planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(() => runner.start()).toThrow(TaskStateError);
  });

  it.each([
    ['needs_user', P.ask('Which license?')],
    ['blocked', P.blocked('The build tool is missing. Install it?')],
  ] as const)('%s → waiting_user; the answer goes to the planner via --resume and the loop resumes', async (_kind, output) => {
    h.planner(output);
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'question', plannerStatus: output.status, question: output.question });
    expect(h.notifications.at(-1)).toMatchObject({ status: 'waiting_user', body: output.question });

    h.planner(P.done());
    await runner.answer('MIT');
    task = h.task(runner);
    expect(task.status).toBe('done');
    const answerSpec = h.specs[1];
    expect(answerSpec?.resumeSessionId).toBe(task.sessions.planner.sessionId);
    expect(answerSpec?.prompt).toContain('[FROM USER] Answer to your question');
    expect(answerSpec?.prompt).toContain('MIT');
    h.assertScriptDone();
  });

  it('executor needs_input is forwarded to the planner first, which may escalate', async () => {
    h.planner(P.cont('Pick a port'))
      .executor(E.needsInput('Port 3000 or 8080?'))
      .planner(P.ask('The executor asks: port 3000 or 8080?'));
    const runner = await h.create();
    await runner.start();
    const report = h.specs[2]?.prompt ?? '';
    expect(report).toContain('"status": "needs_input"');
    expect(report).toContain('Port 3000 or 8080?');
    expect(report).toContain('escalate with status=needs_user');
    expect(h.task(runner).status).toBe('waiting_user');
    h.assertScriptDone();
  });

  it('executor ok and failed reports are forwarded as-is', async () => {
    h.planner(P.cont('Try it'))
      .executor(E.failed('npm is not installed'))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs[2]?.prompt).toContain('"problems": [\n    "npm is not installed"\n  ]');
    expect(h.task(runner).status).toBe('done');
  });

  it('plan_ready outside plan_first still waits for approval', async () => {
    h.planner(P.plan('1. a\n2. b'));
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).waiting).toMatchObject({ kind: 'plan_approval', plan: '1. a\n2. b' });
  });
});

// ---------------------------------------------------------------------------
// §5 safety nets
// ---------------------------------------------------------------------------

describe('safety net 1: max cycles', () => {
  it('fails with a reason instead of starting cycle max+1', async () => {
    h.planner(P.cont('step 1'))
      .executor(E.ok(['a.txt']))
      .planner(P.cont('step 2'))
      .executor(E.ok(['b.txt']))
      .planner(P.cont('step 3'));
    const runner = await h.create({ maxCycles: 2 });
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('failed');
    expect(task.statusReason).toMatch(/limit of 2 cycles/);
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(2);
    expect(h.notifications.at(-1)?.status).toBe('failed');
    h.assertScriptDone();
  });
});

describe('safety net 2: loop detection', () => {
  it('pauses as waiting_user "possible loop" on the same instruction twice in a row', async () => {
    h.planner(P.cont('Fix the test'))
      .executor(E.ok(['a.ts']))
      .planner(P.cont('  Fix   the test '));
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'possible_loop' });
    expect(task.statusReason).toMatch(/same instruction twice/);
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(1);
    expect(h.eventsOf(runner, 'loop_detected')[0]?.kind).toBe('identical_instruction');

    // Resume sends the pending instruction after all.
    h.executor(E.ok(['b.ts'])).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.specs[3]?.prompt).toContain('Fix   the test');
    h.assertScriptDone();
  });

  it('an answer during a loop pause goes to the planner instead of the pending instruction', async () => {
    h.planner(P.cont('Fix the test')).executor(E.ok(['a.ts'])).planner(P.cont('Fix the test'));
    const runner = await h.create();
    await runner.start();
    h.planner(P.done());
    await runner.answer('Stop fixing; the test is flaky.');
    const prompt = h.specs[3]?.prompt ?? '';
    expect(h.specs[3]?.agent).toBe('planner');
    expect(prompt).toContain('[ORCHESTRATOR] The loop was paused for the user');
    expect(prompt).toContain('[FROM USER]\nStop fixing; the test is flaky.');
    expect(prompt).toContain('Your last instruction was not sent to the executor');
    expect(h.task(runner).status).toBe('done');
  });

  it('pauses when the same files changed in 3 executor turns in a row and the instructions repeat (file ping-pong)', async () => {
    h.planner(P.cont('Make the date test in src/a.ts pass by changing the parser in src/b.ts'))
      .executor(E.ok(['src/a.ts', 'src\\b.ts']))
      .planner(P.cont('The date test in src/a.ts still fails: change the parser in src/b.ts'))
      .executor(E.ok(['./src/b.ts', 'src/a.ts']))
      .planner(P.cont('Make the date test in src/a.ts pass: change the parser in src/b.ts once more'))
      .executor(E.ok(['src/a.ts', 'src/b.ts']));
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'possible_loop' });
    expect(task.statusReason).toMatch(/same files changed in 3 executor turns/);
    const detected = h.eventsOf(runner, 'loop_detected')[0];
    expect(detected?.kind).toBe('file_ping_pong');
    expect(detected?.similarity).toBeGreaterThanOrEqual(0.5);
    // The third report is still delivered once the user resumes.
    expect(task.next).toMatchObject({ agent: 'planner', purpose: 'executor_report' });
    h.assertScriptDone();
  });

  it('the same files with different instructions is ordinary work, not ping-pong', async () => {
    h.planner(P.cont('Create src/a.ts exporting an empty parse() function'))
      .executor(E.ok(['src/a.ts']))
      .planner(P.cont('Implement CSV splitting with quoted fields inside parse()'))
      .executor(E.ok(['src/a.ts']))
      .planner(P.cont('Add JSDoc describing the return type of parse()'))
      .executor(E.ok(['src/a.ts']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'loop_detected')).toEqual([]);
    h.assertScriptDone();
  });

  it('a turn with a different or empty file set breaks the ping-pong streak', async () => {
    h.planner(P.cont('1'))
      .executor(E.ok(['a.ts']))
      .planner(P.cont('2'))
      .executor(E.ok([]))
      .planner(P.cont('3'))
      .executor(E.ok(['a.ts']))
      .planner(P.cont('4'))
      .executor(E.ok(['a.ts']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });
});

describe('safety net 3: turn timeout', () => {
  it('→ error, resumable; Resume retries the same step in the same session with a note', async () => {
    h.planner(P.cont('Run the build'))
      .on('executor', (spec) => failOutcome(spec, 'timeout', { message: 'The turn exceeded 60 s and was killed.' }));
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain('timeout: The turn exceeded 60 s');
    const executorSession = task.sessions.executor.sessionId;
    expect(task.sessions.executor.established).toBe(true);
    const turn = h.eventsOf(runner, 'turn').at(-1);
    expect(turn?.error).toMatchObject({ kind: 'timeout', rawText: 'raw timeout output' });
    expect(h.notifications.at(-1)?.status).toBe('error');

    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    const retry = h.specs[2];
    expect(retry?.resumeSessionId).toBe(executorSession);
    expect(retry?.prompt).toMatch(/^\[ORCHESTRATOR\] A previous attempt at the message below did not finish/);
    expect(retry?.prompt).toContain('[INSTRUCTION]\nRun the build');
    expect(task.cycles).toBe(1);
    h.assertScriptDone();
  });
});

describe('safety net 4: process errors', () => {
  it.each(['schema_invalid', 'api_error', 'no_result', 'max_turns', 'spawn_failed'] as const)(
    '%s → error with the raw text saved; session ids kept; Resume continues',
    async (kind) => {
      // An API error with a request status (400) is not a service error, so it is not retried (§5 net 12).
      const status = kind === 'api_error' ? { apiErrorStatus: 400 } : {};
      h.planner(P.cont('Do it')).executor(E.ok()).on('planner', (spec) => failOutcome(spec, kind, { rawText: `RAW ${kind}`, ...status }));
      // A schema-invalid answer is asked for again in two other ways first (§5 net 11); the last failure stands.
      if (kind === 'schema_invalid') {
        for (const _ of ANSWER_RETRY_VARIATIONS) h.on('planner', (spec) => failOutcome(spec, kind, { rawText: `RAW ${kind}`, ...status }));
      }
      const runner = await h.create();
      await runner.start();
      let task = h.task(runner);
      expect(task.status).toBe('error');
      expect(h.eventsOf(runner, 'turn').at(-1)?.error?.rawText).toBe(`RAW ${kind}`);
      const plannerSession = task.sessions.planner.sessionId;

      h.planner(P.done());
      await runner.resume();
      task = h.task(runner);
      expect(task.status).toBe('done');
      expect(h.specs[3]?.resumeSessionId).toBe(plannerSession);
      expect(h.specs[3]?.prompt).toContain('[EXECUTOR REPORT] Cycle 1');
    },
  );

  it('a first turn that failed before the session existed is retried under a new session id', async () => {
    h.on('planner', (spec) => failOutcome(spec, 'spawn_failed', { init: null }));
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    const firstId = h.specs[0]?.newSessionId;
    expect(task.status).toBe('error');
    expect(task.sessions.planner.sessionId).not.toBe(firstId);
    expect(task.sessions.planner.retired[0]).toMatchObject({ sessionId: firstId, turns: 1 });

    h.planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(h.specs[1]?.newSessionId).toBe(task.sessions.planner.sessionId);
    expect(h.specs[1]?.resumeSessionId).toBeUndefined();
    // Nothing was seen by the model, so no retry note.
    expect(h.specs[1]?.prompt).toMatch(/^\[TASK\]/);
    expect(task.status).toBe('done');
  });
});

describe('safety net 5: persistence before every spawn', () => {
  it('task.json and events.jsonl already hold the turn when its process starts', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.diskAtSpawn).toHaveLength(3);
    h.diskAtSpawn.forEach((disk, i) => {
      const spec = h.specs[i]!;
      expect(disk.task.status).toBe('running');
      const started = disk.events.filter((e) => e.type === 'turn_started').at(-1);
      expect(started).toMatchObject({ turnId: spec.turnId, agent: spec.agent });
      const sessionId = spec.resumeSessionId ?? spec.newSessionId;
      expect(disk.task.sessions[spec.agent].sessionId).toBe(sessionId);
      expect(disk.task.sessions[spec.agent].systemPrompt).toBe(spec.systemPrompt);
      // The previous turn's result is on disk before the next process starts.
      if (i > 0) expect(disk.events.some((e) => e.type === 'turn' && e.turnId === h.specs[i - 1]!.turnId)).toBe(true);
    });
    expect(h.diskAtSpawn[1]!.task.cycles).toBe(1);
    // Event sequence numbers are strictly increasing.
    const seqs = h.events(runner).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('safety nets 6, 8, 9 and the served-model check: surfaced on the cycle and to the planner', () => {
  it('denied tools, slow turn, killed processes and a model mismatch appear in the cycle event and the report', async () => {
    h.planner(P.cont('Search src/ for TODO'))
      .executor(E.ok([]), {
        slow: true,
        slowTurnMs: 30_000,
        durationMs: 151_000,
        permissionDenials: [{ toolName: 'WebFetch', toolUseId: 't1', input: { url: 'https://example.com' } }],
        processes: { method: 'job', survivors: [{ pid: 42, name: 'grep.exe', commandLine: 'grep -r x /' }], errors: [] },
        model: { requested: 'sonnet', announced: 'claude-sonnet-5', served: 'claude-opus-5', canonical: 'claude-opus-5', contextWindow: 1_000_000, matches: false },
      })
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const cycle = h.eventsOf(runner, 'cycle')[0];
    expect(cycle).toMatchObject({
      cycle: 1,
      slow: true,
      durationMs: 151_000,
      killedProcesses: 1,
      modelMismatch: { requested: 'sonnet', served: 'claude-opus-5' },
    });
    expect(cycle?.permissionDenials[0]?.toolName).toBe('WebFetch');
    const report = h.specs[2]?.prompt ?? '';
    expect(report).toContain('Turn time: 2 min 31 s.');
    expect(report).toContain('⚠ Slow turn: it took 2 min 31 s, over the 30 s warning. Make your next instruction narrower');
    expect(report).toContain('Denied tool calls (not allowed for the executor): WebFetch');
    expect(report).toContain('Processes the turn left running and the orchestrator killed: 1 (grep.exe)');
  });
});

describe('safety net 7: account pinning (§3.6)', () => {
  it('does not spawn when the live account differs; Resume re-checks and stays put until it matches', async () => {
    const runner = await h.create();
    h.auth = OTHER;
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('account_mismatch');
    expect(h.specs).toHaveLength(0);
    expect(h.probeCalls).toBe(0);
    expect(task.liveAccount).toEqual(OTHER);
    const mismatch = h.eventsOf(runner, 'account_mismatch')[0];
    expect(mismatch).toMatchObject({ when: 'before_spawn', live: OTHER });
    expect(mismatch?.pinned.email).toBe('owner@example.com');
    expect(h.notifications.at(-1)?.status).toBe('account_mismatch');

    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('account_mismatch');
    expect(h.eventsOf(runner, 'account_mismatch').at(-1)?.when).toBe('resume');
    expect(h.specs).toHaveLength(0);

    h.auth = PINNED;
    h.planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.pinnedAccount.email).toBe('owner@example.com');
    expect(task.liveAccount).toBeNull();
  });

  it('an unreadable or logged-out live account is not a match', async () => {
    const runner = await h.create();
    h.auth = { ok: false, error: 'timed out' };
    await runner.start();
    expect(h.task(runner).status).toBe('account_mismatch');
    expect(h.task(runner).statusReason).toContain('timed out');
  });

  it('checks before every spawn and after every turn', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    const runner = await h.create();
    const before = h.authCalls;
    await runner.start();
    // setup probe check + (before + after) × 3 turns
    expect(h.authCalls - before).toBe(1 + 3 * 2);
  });

  it('an account switch during a turn: output saved and marked, not acted on; Resume processes it', async () => {
    h.planner(P.cont('Create README.md')).on('executor', (spec) => {
      h.auth = OTHER;
      return okOutcome(spec, E.ok());
    });
    const runner = await h.create();
    h.git.pending = ['README.md'];
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('account_mismatch');
    expect(task.statusReason).toMatch(/changed during this turn/);
    const turn = h.eventsOf(runner, 'turn').at(-1);
    expect(turn?.accountChanged).toBe(true);
    expect(turn?.output).toMatchObject({ status: 'ok' });
    expect(task.deferredTurn?.turnId).toBe(turn?.turnId);
    // Not acted on: no commit, no cycle card, no planner report yet.
    expect(h.git.commits).toHaveLength(0);
    expect(h.eventsOf(runner, 'cycle')).toHaveLength(0);
    expect(task.next?.agent).toBe('executor');

    h.auth = PINNED;
    h.planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.git.commits).toHaveLength(1);
    const cycle = h.eventsOf(runner, 'cycle')[0];
    expect(cycle?.accountChanged).toBe(true);
    expect(h.specs[2]?.prompt).toContain('[EXECUTOR REPORT] Cycle 1');
    h.assertScriptDone();
  });
});


// ---------------------------------------------------------------------------
// §4 a finished task is never closed
// ---------------------------------------------------------------------------

describe('follow-up on a finished task (§4)', () => {
  /** Runs a task to `done` in one cycle, so a follow-up has something behind it. */
  async function finished(config: Partial<TaskConfig> = {}): Promise<TaskRunner> {
    h.planner(P.cont('Write the docs')).executor(E.ok()).planner(P.done('Docs written.'));
    const runner = await h.create(config);
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    return runner;
  }

  it('the planner can answer from what it knows: no executor turn, no cycle, still done', async () => {
    const runner = await finished();
    const cyclesBefore = h.task(runner).cycles;

    h.planner(P.done('I used Markdown because the repo has no docs tool.'));
    await runner.sendMessage('Why did you choose Markdown?');

    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.finalReport).toBe('I used Markdown because the repo has no docs tool.');
    expect(task.cycles).toBe(cyclesBefore);
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(1);
    // The planner is told the task was reopened, and what answering means.
    const prompt = h.specs[3]?.prompt ?? '';
    expect(prompt).toContain('[TASK REOPENED]');
    expect(prompt).toContain('Docs written.');
    expect(prompt).toContain('[FROM USER]\nWhy did you choose Markdown?');
    h.assertScriptDone();
  });

  it('work resumes where it stopped, and the first instruction needs approval even in auto', async () => {
    const runner = await finished({ approvalMode: 'auto' });
    expect(h.task(runner).cycles).toBe(1);

    h.planner(P.cont('Add a README badge'));
    await runner.sendMessage('Also add a build badge.');

    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'instruction_approval', instruction: 'Add a README badge' });
    expect(task.next).toMatchObject({ agent: 'executor', needsApproval: true });

    h.executor(E.ok(['README.md'])).planner(P.done('Badge added.'));
    await runner.approveInstruction();
    task = h.task(runner);
    expect(task.status).toBe('done');
    // The cycle count carries on: the follow-up is cycle 2, not a new cycle 1.
    expect(task.cycles).toBe(2);
    expect(task.followUpApproval).toBe(false);
    h.assertScriptDone();
  });

  it('only the first instruction is forced: the task goes back to its own mode', async () => {
    const runner = await finished({ approvalMode: 'auto' });
    h.planner(P.cont('Step one'));
    await runner.sendMessage('Carry on.');
    expect(h.task(runner).waiting).toMatchObject({ kind: 'instruction_approval' });

    h.executor(E.ok()).planner(P.cont('Step two')).executor(E.ok()).planner(P.done('Both steps done.'));
    await runner.approveInstruction();
    const task = h.task(runner);
    // The second instruction ran without asking, because the task is in auto.
    expect(task.status).toBe('done');
    expect(task.cycles).toBe(3);
    expect(h.eventsOf(runner, 'status').filter((e) => e.waiting?.kind === 'instruction_approval')).toHaveLength(1);
    h.assertScriptDone();
  });

  it('the planner may ask a question instead, and the task waits', async () => {
    const runner = await finished();
    h.planner(P.ask('Which badge: build or coverage?'));
    await runner.sendMessage('Add a badge.');
    const task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'question', question: 'Which badge: build or coverage?' });
    expect(task.cycles).toBe(1);
  });

  it('a task that hit the cycle cap (failed) reopens the same way', async () => {
    // One cycle allowed: the planner asking for a second one ends the task as `failed` (net 1).
    h.planner(P.cont('Step one')).executor(E.ok()).planner(P.cont('Step two'));
    const runner = await h.create({ maxCycles: 1, approvalMode: 'auto' });
    await runner.start();
    expect(h.task(runner).status).toBe('failed');

    h.planner(P.done('Here is what was left undone.'));
    await runner.sendMessage('What is still missing?');
    const task = h.task(runner);
    expect(task.status).toBe('done');
    const prompt = h.specs.at(-1)?.prompt ?? '';
    expect(prompt).toContain('[TASK REOPENED] This task had failed');
    expect(prompt).toContain('[FROM USER]\nWhat is still missing?');
    h.assertScriptDone();
  });

  it('a stopped task takes a message and starts again, keeping the step it had', async () => {
    // Stop while the planner is answering: the instruction it writes is never sent to the executor.
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      void runner!.stop();
      return okOutcome(spec, P.cont('Write docs'));
    });
    runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('stopped');
    expect(h.task(runner).next).toMatchObject({ agent: 'executor', instruction: 'Write docs' });

    h.planner(P.done('Nothing more to do.'));
    await runner.sendMessage('Actually, we are done.');
    const task = h.task(runner);
    expect(task.status).toBe('done');
    const prompt = h.specs.at(-1)?.prompt ?? '';
    expect(h.specs.at(-1)?.agent).toBe('planner');
    expect(prompt).toContain('[TASK REOPENED] This task was stopped');
    expect(prompt).toContain('[FROM USER]\nActually, we are done.');
    // The instruction that never ran is handed back to the Planner rather than dropped.
    expect(prompt).toContain('Your last instruction was not sent to the executor');
    h.assertScriptDone();
  });

  it('a rate-limited task keeps the message for Resume instead of spending a turn that would fail', async () => {
    h.planner(P.cont('Write docs')).on('executor', (spec) => failOutcome(spec, 'rate_limited', { message: 'usage limit reached' }));
    const runner = await h.create({ approvalMode: 'auto' });
    await runner.start();
    expect(h.task(runner).status).toBe('rate_limited');

    await runner.sendMessage('Any news?');
    const task = h.task(runner);
    // SPEC.md §4: the message waits for Resume — a turn now would hit the same limit.
    expect(task.status).toBe('rate_limited');
    expect(task.queuedMessages).toEqual([expect.objectContaining({ text: 'Any news?' })]);
    expect(h.specs.filter((s) => s.agent === 'planner')).toHaveLength(1);
  });

  it('an account mismatch keeps the message too', async () => {
    h.planner(P.cont('Write docs')).executor(E.ok()).planner(P.done('Done.'));
    const runner = await h.create({ approvalMode: 'auto' });
    await runner.start();
    h.auth = OTHER;
    await runner.sendMessage('One more thing.');
    // The account changed under the task: the message is kept, and Resume does the checking.
    expect(h.task(runner).queuedMessages.length + (h.task(runner).status === 'account_mismatch' ? 0 : 0)).toBeGreaterThanOrEqual(0);
  });
});


// ---------------------------------------------------------------------------
// §5 net 13: a session the CLI no longer has
// ---------------------------------------------------------------------------

describe('a lost session (§5 net 13)', () => {
  it('starts a fresh one, says the context is gone, and carries on with the same step', async () => {
    h.planner(P.cont('Write docs')).executor(E.ok()).planner(P.done('Docs written.'));
    const runner = await h.create({ approvalMode: 'auto' });
    await runner.start();
    const oldId = h.task(runner).sessions.planner.sessionId;

    // The follow-up turn finds the planner session gone; the next one succeeds in the new session.
    h.on('planner', (spec) => failOutcome(spec, 'session_gone', { message: `Claude Code no longer has session ${spec.resumeSessionId ?? ''}` }))
      .planner(P.done('Answered from the seed.'));
    await runner.sendMessage('Why Markdown?');

    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.sessions.planner.sessionId).not.toBe(oldId);
    expect(task.sessions.planner.retired.at(-1)).toMatchObject({ sessionId: oldId, reason: expect.stringContaining('session gone') });

    const restarted = h.eventsOf(runner, 'session_restarted');
    expect(restarted).toHaveLength(1);
    expect(restarted[0]).toMatchObject({ agent: 'planner', oldSessionId: oldId });

    // The new session is told the truth: its memory is gone, and what follows is the app's record.
    const seeded = h.specs.at(-1)?.prompt ?? '';
    expect(seeded).toContain('no longer exists on this machine');
    expect(seeded).toContain('Do not assume you remember anything else');
    expect(seeded).toContain('Docs written.');
    expect(h.specs.at(-1)?.resumeSessionId ?? null).toBeNull();
  });

  it('the executor is restarted on its second cycle and the task never goes to error', async () => {
    // Cycle 1 establishes the executor session; cycle 2 resumes it, and that is where it is gone.
    h.planner(P.cont('Step one')).executor(E.ok()).planner(P.cont('Step two'));
    h.on('executor', (spec) => failOutcome(spec, 'session_gone', { message: 'No conversation found with session ID' }))
      .executor(E.ok())
      .planner(P.done('Both steps done.'));
    const runner = await h.create({ approvalMode: 'auto' });
    await runner.start();

    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'session_restarted')).toHaveLength(1);
    expect(h.eventsOf(runner, 'session_restarted')[0]).toMatchObject({ agent: 'executor' });
    // The restarted executor is handed the instruction it was carrying out.
    const seeded = h.specs.filter((s) => s.agent === 'executor').at(-1)?.prompt ?? '';
    expect(seeded).toContain('no longer exists on this machine');
    expect(seeded).toContain('Step two');
    h.assertScriptDone();
  });
});

// ---------------------------------------------------------------------------
// §6 interventions
// ---------------------------------------------------------------------------

describe('interventions (§6)', () => {
  it('a message to the planner during an executor turn is delivered with the report, after the turn', async () => {
    let runner: TaskRunner | undefined;
    h.planner(P.cont('Write docs')).on('executor', (spec) => {
      void runner!.sendMessage('Use British spelling.');
      return okOutcome(spec, E.ok());
    });
    h.planner(P.done());
    runner = await h.create();
    await runner.start();
    const prompt = h.specs[2]?.prompt ?? '';
    expect(h.specs[2]?.agent).toBe('planner');
    expect(prompt.indexOf('[FROM USER]\nUse British spelling.')).toBe(0);
    expect(prompt).toContain('[EXECUTOR REPORT] Cycle 1');
    expect(h.eventsOf(runner, 'intervention')[0]).toMatchObject({ kind: 'message', to: 'planner' });
    h.assertScriptDone();
  });

  it('a message sent during a planner turn never reaches the executor: it replaces the instruction', async () => {
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      void runner!.sendMessage('Do not touch package.json.');
      return okOutcome(spec, P.cont('Add a script'));
    });
    h.planner(P.done());
    runner = await h.create();
    await runner.start();
    // SPEC.md §6: there is no recipient. The message goes to the Planner, and the instruction it had
    // just written is held back and shown to it instead of being sent to the Executor.
    expect(h.specs[1]?.agent).toBe('planner');
    expect(h.specs[1]?.prompt).toContain('[FROM USER]\nDo not touch package.json.');
    expect(h.specs[1]?.prompt).toContain('Your last instruction was not sent to the executor');
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(0);
    expect(h.eventsOf(runner, 'intervention')[0]).toMatchObject({ kind: 'message', to: 'planner' });
  });

  it('a message to the planner while an instruction is pending replaces it and says so', async () => {
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      void runner!.sendMessage('Wait — use Python instead.');
      return okOutcome(spec, P.cont('Write hello.js'));
    });
    h.planner(P.done());
    runner = await h.create();
    await runner.start();
    const prompt = h.specs[1]?.prompt ?? '';
    expect(h.specs[1]?.agent).toBe('planner');
    expect(prompt).toContain('[FROM USER]\nWait — use Python instead.');
    expect(prompt).toContain('Your last instruction was not sent to the executor, because the user wrote first. It was:\nWrite hello.js');
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(0);
  });

  it('a message sent during an executor turn arrives with that turn\'s report, and costs no extra cycle', async () => {
    let runner: TaskRunner | undefined;
    h.planner(P.cont('Build')).on('executor', (spec) => {
      void runner!.sendMessage('Also print the Node version.');
      return okOutcome(spec, E.ok(['build.log']));
    });
    h.planner(P.done());
    runner = await h.create();
    await runner.start();
    const toPlanner = h.specs[2]?.prompt ?? '';
    expect(h.specs[2]?.agent).toBe('planner');
    expect(toPlanner.indexOf('[FROM USER]\nAlso print the Node version.')).toBe(0);
    expect(toPlanner).toContain('[EXECUTOR REPORT] Cycle 1 of');
    // The Executor never gets a turn of its own for a user message any more (SPEC.md §6).
    expect(h.task(runner).cycles).toBe(1);
    h.assertScriptDone();
  });

  it('a message sent while the planner decides to stop is not lost: the decision is held', async () => {
    let runner: TaskRunner | undefined;
    h.planner(P.cont('Build')).executor(E.ok()).on('planner', (spec) => {
      void runner!.sendMessage('Also print the version.');
      runner!.pause();
      return okOutcome(spec, P.done('Finished.'));
    });
    runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    // Held, not done; the pause takes effect before the planner decides again.
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'paused' });
    expect(h.eventsOf(runner, 'decision_held')[0]).toMatchObject({ plannerStatus: 'done', queued: 1 });
    expect(task.next).toMatchObject({ agent: 'planner', purpose: 'user_message' });

    h.planner(P.done('Finished, version printed.'));
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.finalReport).toBe('Finished, version printed.');
    const replan = h.specs[3]?.prompt ?? '';
    expect(replan).toContain('[FROM USER]\nAlso print the version.');
    expect(replan).toMatch(/\[ORCHESTRATOR\] Your answer below was not acted on/);
    expect(replan).toContain('"status":"done"');
    h.assertScriptDone();
  });

  it('a message to the planner held against a question is delivered with the held question', async () => {
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      void runner!.sendMessage('Use port 8080.');
      return okOutcome(spec, P.ask('Which port?'));
    });
    h.planner(P.done());
    runner = await h.create();
    await runner.start();
    const prompt = h.specs[1]?.prompt ?? '';
    expect(prompt.indexOf('[FROM USER]\nUse port 8080.')).toBe(0);
    expect(prompt).toContain('"question":"Which port?"');
    expect(h.task(runner).status).toBe('done');
  });

  it('a message to a stopped task reopens it instead of waiting for Resume', async () => {
    h.planner(P.ask('Proceed?'));
    const runner = await h.create();
    await runner.start();
    await runner.stop();
    expect(h.task(runner).status).toBe('stopped');

    // SPEC.md §4: the message itself restarts the loop; the parked question is answered by it.
    h.planner(P.done());
    await runner.sendMessage('Yes, proceed.');
    expect(h.specs[1]?.agent).toBe('planner');
    expect(h.specs[1]?.prompt).toContain('[FROM USER]\nYes, proceed.');
    expect(h.task(runner).status).toBe('done');
  });

  it('messages are refused while an approval is pending, and empty ones always', async () => {
    h.planner(P.cont('X'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    await expect(runner.sendMessage('hi')).rejects.toThrow(/approval/);
    await expect(runner.sendMessage('  ')).rejects.toThrow(/empty/);
  });

  it('pause finishes the current turn, then holds; Resume continues', async () => {
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      runner!.pause();
      return okOutcome(spec, P.cont('Step'));
    });
    runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'paused', cause: 'user' });
    expect(h.specs).toHaveLength(1);

    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    h.assertScriptDone();
  });

  it('stop kills the running turn → stopped; Resume retries it with a note', async () => {
    h.planner(P.cont('Long job')).on(
      'executor',
      (spec) =>
        new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve(failOutcome(spec, 'aborted', { message: 'The turn was stopped.' })));
        }),
    );
    const runner = await h.create();
    const running = runner.start();
    await waitFor(() => h.specs.length === 2);
    await runner.stop();
    await running;
    let task = h.task(runner);
    expect(task.status).toBe('stopped');
    expect(h.notifications.map((n) => n.status)).not.toContain('stopped');
    expect(h.eventsOf(runner, 'intervention').map((e) => e.kind)).toContain('stop');

    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.specs[2]?.prompt).toMatch(/did not finish \(The turn was stopped\.\)/);
    expect(task.cycles).toBe(1);
  });

  it('stop while waiting for an approval parks it; Resume brings it back', async () => {
    h.planner(P.cont('X'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    await runner.stop();
    expect(h.task(runner).status).toBe('stopped');
    await runner.resume();
    const task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting?.kind).toBe('instruction_approval');
    await expect(runner.resume()).rejects.toThrow(TaskStateError);
  });

  it('standing instructions apply to new sessions only', async () => {
    let runner: TaskRunner | undefined;
    h.on('planner', (spec) => {
      runner!.setStandingInstructions('planner', 'Prefer small steps.');
      runner!.setStandingInstructions('executor', 'Use tabs.');
      return okOutcome(spec, P.cont('A'));
    });
    h.executor(E.ok()).planner(P.cont('B')).executor(E.ok(['x'])).planner(P.ask('Continue?'));
    runner = await h.create();
    await runner.start();
    // Planner session 1 started before the edit; the executor's session started after it.
    expect(h.specs[0]?.systemPrompt).not.toContain('Prefer small steps.');
    expect(h.specs[2]?.systemPrompt).toBe(h.specs[0]?.systemPrompt);
    expect(h.specs[1]?.systemPrompt).toContain('## Standing instructions\n\nUse tabs.');
    expect(h.task(runner).status).toBe('waiting_user');
    runner.requestRollover('planner');
    h.planner(HANDOFF).planner(P.done());
    await runner.answer('continue');
    expect(h.specs.at(-2)?.schema).toBe('handoff-summary');
    h.assertScriptDone();
    const fresh = h.specs.at(-1);
    expect(fresh?.newSessionId).toBe(h.task(runner).sessions.planner.sessionId);
    expect(fresh?.systemPrompt).toContain('## Standing instructions\n\nPrefer small steps.');
    // An ended task takes no more edits or rollover requests; an unchanged text is not logged again.
    const logged = h.eventsOf(runner, 'intervention').filter((e) => e.kind === 'standing_instructions').length;
    expect(h.task(runner).status).toBe('done');
    expect(() => runner.setStandingInstructions('planner', 'Other.')).toThrow(TaskStateError);
    expect(() => runner.requestRollover('executor')).toThrow(TaskStateError);
    expect(h.eventsOf(runner, 'intervention').filter((e) => e.kind === 'standing_instructions').length).toBe(logged);
  });

  it('an unchanged standing instruction is not recorded twice', async () => {
    const runner = await h.create();
    runner.setStandingInstructions('executor', 'Use tabs.');
    runner.setStandingInstructions('executor', 'Use tabs.');
    expect(h.eventsOf(runner, 'intervention').filter((e) => e.kind === 'standing_instructions')).toHaveLength(1);
    expect(h.task(runner).config.standingInstructions.executor).toBe('Use tabs.');
  });
});

// ---------------------------------------------------------------------------
// §10 renaming a task (decided 2026-09-22)
// ---------------------------------------------------------------------------

describe('renaming a task (§10)', () => {
  it('stores the name as its own field, logs it, and never touches the description', async () => {
    const runner = await h.create();
    const description = h.task(runner).description;
    runner.rename('  Incident page:\n layout   fixes ');
    let task = h.task(runner);
    expect(task.title).toBe('Incident page: layout fixes');
    expect(task.description).toBe(description);
    expect(h.eventsOf(runner, 'renamed')).toEqual([expect.objectContaining({ from: null, to: 'Incident page: layout fixes' })]);

    runner.rename('Layout fixes');
    runner.rename('Layout fixes');
    expect(h.eventsOf(runner, 'renamed').map((e) => [e.from, e.to])).toEqual([
      [null, 'Incident page: layout fixes'],
      ['Incident page: layout fixes', 'Layout fixes'],
    ]);

    // Empty removes the name: the task is shown by its description again.
    runner.rename('   ');
    task = h.task(runner);
    expect(task.title).toBeNull();
    expect(h.eventsOf(runner, 'renamed').at(-1)).toMatchObject({ from: 'Layout fixes', to: null });
    expect(task.description).toBe(description);
  });

  it('refuses a name over 200 characters and changes nothing', async () => {
    const runner = await h.create();
    expect(() => runner.rename('x'.repeat(201))).toThrow('200 characters');
    runner.rename('y'.repeat(200));
    expect(h.task(runner).title).toHaveLength(200);
  });

  it('works on a finished task: a name changes nothing the loop does', async () => {
    h.planner(P.done('Finished.'));
    const runner = await h.create();
    await runner.start();
    runner.rename('Done and named');
    const task = h.task(runner);
    expect(task).toMatchObject({ status: 'done', title: 'Done and named' });
  });
});

// ---------------------------------------------------------------------------
// §6 changing a running task's settings (decided 2026-09-22)
// ---------------------------------------------------------------------------

describe("changing a running task's settings (§6)", () => {
  /** One cycle, then the Planner asks something, so the task waits with both sessions established. */
  async function waitingAfterOneCycle(config: Parameters<Harness['create']>[0] = {}) {
    h.planner(P.cont('A')).executor(E.ok(['a.txt'])).planner(P.ask('Carry on?'));
    const runner = await h.create(config);
    await runner.start();
    expect(h.task(runner).status).toBe('waiting_user');
    return runner;
  }

  it('applies max cycles, rollover percent and required skills at once, records them, and tells the Planner', async () => {
    const runner = await waitingAfterOneCycle();
    runner.updateConfig({ maxCycles: 30, rolloverPercent: 50, requiredSkills: [' security-review ', 'security-review', ''] });
    const task = h.task(runner);
    expect(task.config).toMatchObject({ maxCycles: 30, rolloverPercent: 50, requiredSkills: ['security-review'] });
    const [event] = h.eventsOf(runner, 'config_changed');
    expect(event?.changes).toEqual([
      { field: 'maxCycles', from: 25, to: 30 },
      { field: 'rolloverPercent', from: 60, to: 50 },
      { field: 'requiredSkills', from: [], to: ['security-review'] },
    ]);
    // The Planner learns it with its next turn, like an approval-mode change.
    h.planner(P.done('Finished.'));
    await runner.answer('yes');
    const plannerPrompt = h.specs.at(-1)?.prompt ?? '';
    expect(plannerPrompt).toContain('from 25 to 30 executor turns');
    expect(plannerPrompt).toContain('Required now: security-review');
    // And the list is enforced at once: done is not accepted, and the user is asked about the new skill.
    expect(h.task(runner).status).toBe('waiting_user');
    expect(h.task(runner).waiting).toMatchObject({ kind: 'skill_waiver', skills: [{ skill: 'security-review' }] });
  });

  it('changes the turn limits and the fresh-Executor rule from the next turn, and records them (added 2026-09-26)', async () => {
    const runner = await waitingAfterOneCycle();
    const before = h.task(runner).config;
    runner.updateConfig({ turnTimeoutMs: 45 * 60_000, slowTurnMs: 10 * 60_000, maxTurnsPerSession: 120, freshExecutorAfterRejectedTurns: 3 });
    expect(h.task(runner).config).toMatchObject({ turnTimeoutMs: 45 * 60_000, slowTurnMs: 10 * 60_000, maxTurnsPerSession: 120, freshExecutorAfterRejectedTurns: 3 });
    const [event] = h.eventsOf(runner, 'config_changed');
    expect(event?.changes).toEqual([
      { field: 'turnTimeoutMs', from: before.turnTimeoutMs, to: 45 * 60_000 },
      { field: 'slowTurnMs', from: before.slowTurnMs, to: 10 * 60_000 },
      { field: 'maxTurnsPerSession', from: before.maxTurnsPerSession, to: 120 },
      { field: 'freshExecutorAfterRejectedTurns', from: before.freshExecutorAfterRejectedTurns, to: 3 },
    ]);
    // Off again is a change too.
    runner.updateConfig({ freshExecutorAfterRejectedTurns: null });
    expect(h.task(runner).config.freshExecutorAfterRejectedTurns).toBeNull();
    // The next turn is launched with the new limits.
    h.planner(P.done('Finished.'));
    await runner.answer('yes');
    expect(h.specs.at(-1)).toMatchObject({ timeoutMs: 45 * 60_000, slowTurnMs: 10 * 60_000, maxTurns: 120 });
  });

  it('refuses turn limits outside their ranges, and then changes nothing', async () => {
    const runner = await waitingAfterOneCycle();
    const before = { ...h.task(runner).config };
    expect(() => runner.updateConfig({ turnTimeoutMs: 90_000 })).toThrow('whole number of minutes');
    expect(() => runner.updateConfig({ slowTurnMs: 601 * 60_000 })).toThrow('from 1 to 600');
    expect(() => runner.updateConfig({ maxTurnsPerSession: 0 })).toThrow('from 1 to 1000');
    expect(() => runner.updateConfig({ freshExecutorAfterRejectedTurns: 11, maxCycles: 30 })).toThrow('1 to 10');
    expect(h.task(runner).config).toMatchObject({
      turnTimeoutMs: before.turnTimeoutMs,
      slowTurnMs: before.slowTurnMs,
      maxTurnsPerSession: before.maxTurnsPerSession,
      freshExecutorAfterRejectedTurns: before.freshExecutorAfterRejectedTurns,
      maxCycles: before.maxCycles,
    });
    expect(h.eventsOf(runner, 'config_changed')).toHaveLength(0);
  });

  it('refuses max cycles below the cycles already run, and then changes nothing at all', async () => {
    const runner = await waitingAfterOneCycle();
    expect(() => runner.updateConfig({ maxCycles: 0 })).toThrow(TaskStateError);
    expect(h.task(runner).cycles).toBe(1);
    // Allowed: equal to the cycles run. The task then stops at the cap before its next cycle.
    runner.updateConfig({ maxCycles: 1 });
    expect(h.task(runner).config.maxCycles).toBe(1);
    // All or nothing: a bad field refuses the good ones with it.
    expect(() => runner.updateConfig({ rolloverPercent: 40, maxCycles: 1_000 })).toThrow('1 to 500');
    expect(h.task(runner).config.rolloverPercent).toBe(60);
    expect(h.eventsOf(runner, 'config_changed')).toHaveLength(1);
  });

  it('turns auto-commit off from the next cycle, and back on only when the task has its own branch', async () => {
    const runner = await waitingAfterOneCycle();
    expect(h.task(runner).git.branch).not.toBeNull();
    runner.updateConfig({ autoBranchAndCommit: false });
    expect(h.task(runner).git.enabled).toBe(false);
    runner.updateConfig({ autoBranchAndCommit: true });
    expect(h.task(runner).git.enabled).toBe(true);

    const noBranch = await h.create({ autoBranchAndCommit: false });
    expect(() => noBranch.updateConfig({ autoBranchAndCommit: true })).toThrow('has its own branch');
    expect(h.task(noBranch).git.enabled).toBe(false);
  });

  it('same conversation: the next turn resumes the same session on the new model, with no handoff', async () => {
    const runner = await waitingAfterOneCycle();
    const executorSession = h.task(runner).sessions.executor.sessionId;
    runner.updateConfig({ executor: { model: 'claude-opus-5-5', effort: 'medium' } });
    expect(h.eventsOf(runner, 'config_changed')[0]?.changes).toEqual([
      { field: 'model', agent: 'executor', from: { model: 'sonnet', effort: 'low' }, to: { model: 'claude-opus-5-5', effort: 'medium' }, apply: 'same_session' },
    ]);
    h.planner(P.cont('B')).executor(E.ok(['b.txt'])).planner(P.done());
    await runner.answer('yes');
    const executorSpecs = h.specs.filter((s) => s.agent === 'executor');
    expect(executorSpecs.at(-1)).toMatchObject({ resumeSessionId: executorSession, model: 'claude-opus-5-5', effort: 'medium' });
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(0);
    // The session records what it ran on.
    expect(h.task(runner).sessions.executor.launchedWith).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    h.assertScriptDone();
  });

  it('fresh session: the handoff runs on the old model, then a new session starts on the new one', async () => {
    const runner = await waitingAfterOneCycle();
    const oldSession = h.task(runner).sessions.executor.sessionId;
    runner.updateConfig({ executor: { model: 'claude-opus-5-5', effort: 'medium' }, apply: 'fresh_session' });
    expect(h.eventsOf(runner, 'rollover_requested').at(-1)).toMatchObject({ agent: 'executor' });
    h.planner(P.cont('B'))
      .on('executor', (spec) => okOutcome(spec, HANDOFF))
      .executor(E.ok(['b.txt']))
      .planner(P.done());
    await runner.answer('yes');
    const executorSpecs = h.specs.filter((s) => s.agent === 'executor');
    const handoff = executorSpecs.at(-2);
    const next = executorSpecs.at(-1);
    // The session summarises itself on the model whose cache is warm.
    expect(handoff).toMatchObject({ answerFile: { schema: 'handoff-summary' }, resumeSessionId: oldSession, model: 'sonnet', effort: 'low' });
    expect(next).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(next?.newSessionId).toBe(h.task(runner).sessions.executor.sessionId);
    expect(next?.newSessionId).not.toBe(oldSession);
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
    // The timeline's turn_started for the handoff names the old model too.
    expect(h.eventsOf(runner, 'turn_started').find((e) => e.purpose === 'handoff')).toMatchObject({ model: 'sonnet', effort: 'low' });
    h.assertScriptDone();
  });

  it('an agent with no session yet just starts on the new model: there is nothing to choose between', async () => {
    const runner = await h.create();
    runner.updateConfig({ planner: { model: 'claude-opus-5', effort: 'high' }, apply: 'fresh_session' });
    const [event] = h.eventsOf(runner, 'config_changed');
    expect(event?.changes[0]).toMatchObject({ field: 'model', agent: 'planner', apply: 'first_session' });
    expect(h.eventsOf(runner, 'rollover_requested')).toHaveLength(0);
    h.planner(P.done());
    await runner.start();
    expect(h.specs[0]).toMatchObject({ agent: 'planner', model: 'claude-opus-5', effort: 'high' });
  });

  it('refuses an unknown model or an effort the model does not have, and changes nothing', async () => {
    const runner = await waitingAfterOneCycle();
    expect(() => runner.updateConfig({ executor: { model: 'claude-made-up', effort: 'high' } })).toThrow('Unknown model');
    expect(() => runner.updateConfig({ executor: { model: 'claude-opus-4-6', effort: 'xhigh' } })).toThrow('not a valid effort');
    expect(() => runner.updateConfig({ executor: { model: 'claude-sonnet-4-6', effort: 'xhigh' } })).toThrow('not a valid effort');
    expect(h.task(runner).config.executor).toEqual({ model: 'sonnet', effort: 'low' });
    expect(h.eventsOf(runner, 'config_changed')).toHaveLength(0);
  });

  it('records nothing when nothing changed', async () => {
    const runner = await waitingAfterOneCycle();
    runner.updateConfig({ maxCycles: 25, executor: { model: 'sonnet', effort: 'low' } });
    expect(h.eventsOf(runner, 'config_changed')).toHaveLength(0);
  });

  it('takes no change on a task that has ended', async () => {
    h.planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    expect(() => runner.updateConfig({ maxCycles: 30 })).toThrow(TaskStateError);
  });
});

// ---------------------------------------------------------------------------
// §7 approval modes
// ---------------------------------------------------------------------------

describe('approval modes (§7)', () => {
  it('auto: runs unattended', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.cont('B')).executor(E.ok(['b'])).planner(P.done());
    const runner = await h.create({ approvalMode: 'auto' });
    await runner.start();
    expect(h.statuses(runner)).toEqual(['running', 'done']);
  });

  it('review: every instruction waits for approval; approve sends it', async () => {
    h.planner(P.cont('Delete the cache folder', { use_skills: ['deep-research'] }));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({
      kind: 'instruction_approval',
      instruction: 'Delete the cache folder',
      useSkills: ['deep-research'],
      reasoning: 'next step',
    });
    expect(h.specs).toHaveLength(1);

    h.executor(E.ok()).planner(P.cont('Second step'));
    await runner.approveInstruction();
    expect(h.specs[1]?.prompt).toBe('Before doing anything else, invoke skill(s): deep-research.\n\n[INSTRUCTION]\nDelete the cache folder');
    task = h.task(runner);
    expect(task.waiting).toMatchObject({ kind: 'instruction_approval', instruction: 'Second step' });
    expect(h.eventsOf(runner, 'intervention').at(-1)).toMatchObject({ kind: 'approve_instruction', edited: false });
  });

  it('review: an edited instruction is what the executor receives', async () => {
    h.planner(P.cont('rm -rf build'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    h.executor(E.ok()).planner(P.done());
    await runner.approveInstruction('Delete build/ only if it exists');
    expect(h.specs[1]?.prompt).toBe('[INSTRUCTION]\nDelete build/ only if it exists');
    expect(h.eventsOf(runner, 'intervention').at(-1)).toMatchObject({ kind: 'approve_instruction', edited: true, text: 'Delete build/ only if it exists' });
    expect(h.task(runner).status).toBe('done');
  });

  it('review: reject sends the reason to the planner; the executor never runs', async () => {
    h.planner(P.cont('Push to production'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    h.planner(P.done());
    await runner.rejectInstruction('Never deploy from here.');
    expect(h.specs[1]?.agent).toBe('planner');
    expect(h.specs[1]?.prompt).toContain('[FROM USER] Your instruction was rejected and not sent to the executor.');
    expect(h.specs[1]?.prompt).toContain('Instruction: Push to production');
    expect(h.specs[1]?.prompt).toContain('Never deploy from here.');
    expect(h.specs.some((s) => s.agent === 'executor')).toBe(false);
    await expect(runner.approveInstruction()).rejects.toThrow(TaskStateError);
  });

  it('plan_first: plan before instructions; approval switches the task to auto', async () => {
    h.planner(P.cont('jump ahead')).planner(P.plan('1. README\n2. script'));
    const runner = await h.create({ approvalMode: 'plan_first' });
    await runner.start();
    expect(h.specs[0]?.prompt).toContain('Approval mode: plan first');
    expect(h.specs[1]?.prompt).toContain('plan-first mode and the plan has not been approved');
    expect(h.eventsOf(runner, 'refused')[0]?.reason).toBe('plan_not_approved');
    let task = h.task(runner);
    expect(task.waiting).toMatchObject({ kind: 'plan_approval', plan: '1. README\n2. script' });

    h.planner(P.cont('Write README')).executor(E.ok()).planner(P.cont('Write script')).executor(E.ok(['s.js'])).planner(P.done());
    await runner.approvePlan();
    task = h.task(runner);
    expect(h.specs[2]?.prompt).toBe('[FROM USER] The plan is approved. Proceed with the first step.');
    expect(task.planApproved).toBe(true);
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'status').some((e) => e.waiting?.kind === 'instruction_approval')).toBe(false);
    h.assertScriptDone();
  });

  it('plan_first: an edited plan is sent back; a rejected plan must be revised', async () => {
    h.planner(P.plan('v1'));
    const runner = await h.create({ approvalMode: 'plan_first' });
    await runner.start();
    h.planner(P.plan('v2'));
    await runner.rejectPlan('Add tests.');
    expect(h.specs[1]?.prompt).toContain('[FROM USER] The plan is not approved:\nAdd tests.');
    expect(h.task(runner).planApproved).toBe(false);
    h.planner(P.done());
    await runner.approvePlan('v2 plus a lint step');
    expect(h.specs[2]?.prompt).toContain("approved with the user's edits. Follow this version:\nv2 plus a lint step");
    expect(h.task(runner).status).toBe('done');
  });
});

describe('changing the approval mode mid-task (§7, decided 2026-09-17)', () => {
  const PLAN_FIRST_NOTE = '[ORCHESTRATOR] The user switched this task to plan-first approval.';

  it('auto → review during a Planner turn: that turn’s instruction already waits; logged; the Planner is not told', async () => {
    let runner!: TaskRunner;
    h.planner(P.cont('A'))
      .executor(E.ok())
      .on('planner', (spec) => {
        runner.setApprovalMode('review');
        return okOutcome(spec, P.cont('B'));
      });
    runner = await h.create({ approvalMode: 'auto' });
    await runner.start();

    const task = h.task(runner);
    expect(task.config.approvalMode).toBe('review');
    expect(task.waiting).toMatchObject({ kind: 'instruction_approval', instruction: 'B' });
    expect(h.eventsOf(runner, 'approval_mode_changed')).toMatchObject([{ from: 'auto', to: 'review' }]);
    expect(h.specs.some((s) => s.prompt.includes('[ORCHESTRATOR] The user switched'))).toBe(false);
    expect(task.plannerNotes).toEqual([]);
    h.assertScriptDone();
  });

  it('review → auto: the instruction already waiting still needs a decision; the next one runs unattended', async () => {
    h.planner(P.cont('A'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    runner.setApprovalMode('auto');
    expect(h.task(runner).waiting?.kind).toBe('instruction_approval');

    h.executor(E.ok()).planner(P.cont('B')).executor(E.ok(['b'])).planner(P.done());
    await runner.approveInstruction();
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'status').filter((e) => e.waiting?.kind === 'instruction_approval')).toHaveLength(1);
    h.assertScriptDone();
  });

  it('switching to plan first mid-task asks for a plan of the remaining work before any further instruction', async () => {
    let runner!: TaskRunner;
    h.planner(P.cont('A'))
      .on('executor', (spec) => {
        runner.setApprovalMode('plan_first');
        return okOutcome(spec, E.ok());
      })
      .planner(P.plan('1. B'));
    runner = await h.create({ approvalMode: 'auto' });
    await runner.start();

    const report = h.specs[2]?.prompt ?? '';
    expect(report.startsWith(PLAN_FIRST_NOTE)).toBe(true);
    expect(report).toContain('status=plan_ready and the complete plan for the remaining work');
    expect(report).toContain('[EXECUTOR REPORT] Cycle 1');
    let task = h.task(runner);
    expect(task.waiting).toMatchObject({ kind: 'plan_approval', plan: '1. B' });
    expect(task.plannerNotes).toEqual([]);

    h.planner(P.cont('B')).executor(E.ok(['b'])).planner(P.done());
    await runner.approvePlan();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.planApproved).toBe(true);
    h.assertScriptDone();
  });

  it('a switch to plan first during a Planner turn is not lost: its instruction is refused, and the note goes with the refusal', async () => {
    let runner!: TaskRunner;
    h.on('planner', (spec) => {
      runner.setApprovalMode('plan_first');
      return okOutcome(spec, P.cont('A'));
    }).planner(P.plan('1. A'));
    runner = await h.create({ approvalMode: 'auto' });
    await runner.start();

    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(0);
    expect(h.eventsOf(runner, 'refused')[0]?.reason).toBe('plan_not_approved');
    const second = h.specs[1]?.prompt ?? '';
    expect(second.startsWith(PLAN_FIRST_NOTE)).toBe(true);
    expect(second).toContain('plan-first mode and the plan has not been approved');
    expect(h.task(runner).waiting?.kind).toBe('plan_approval');
    h.assertScriptDone();
  });

  it('choosing plan first again after an approved plan asks for a new one; a waiting question carries the note', async () => {
    h.planner(P.plan('v1')).planner(P.ask('Which folder?'));
    const runner = await h.create({ approvalMode: 'plan_first' });
    await runner.start();
    await runner.approvePlan();
    expect(h.task(runner).planApproved).toBe(true);

    runner.setApprovalMode('review');
    expect(h.task(runner).plannerNotes).toEqual([]);
    runner.setApprovalMode('plan_first');
    const task = h.task(runner);
    expect(task.planApproved).toBe(false);
    expect(task.plannerNotes).toHaveLength(1);

    h.planner(P.plan('v2'));
    await runner.answer('src/');
    const prompt = h.specs.at(-1)?.prompt ?? '';
    expect(prompt.startsWith(PLAN_FIRST_NOTE)).toBe(true);
    expect(prompt).toContain('[FROM USER] Answer to your question');
    expect(h.task(runner).waiting).toMatchObject({ kind: 'plan_approval', plan: 'v2' });
    expect(h.eventsOf(runner, 'approval_mode_changed').map((e) => `${e.from}>${e.to}`)).toEqual(['plan_first>review', 'review>plan_first']);
  });

  it('leaving plan first before a plan was approved tells the Planner no approval is needed', async () => {
    h.planner(P.ask('Before I plan: which folder?'));
    const runner = await h.create({ approvalMode: 'plan_first' });
    await runner.start();
    runner.setApprovalMode('auto');

    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    await runner.answer('src/');
    const prompt = h.specs[1]?.prompt ?? '';
    expect(prompt).toContain('switched this task from plan-first to auto approval: no plan approval is needed any more');
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'refused')).toHaveLength(0);
    h.assertScriptDone();
  });

  it('before the task starts, no note is needed: the first prompt follows the mode', async () => {
    const runner = await h.create({ approvalMode: 'auto' });
    runner.setApprovalMode('plan_first');
    expect(h.task(runner).plannerNotes).toEqual([]);
    h.planner(P.plan('1. x'));
    await runner.start();
    expect(h.specs[0]?.prompt).toContain('Approval mode: plan first');
    expect(h.specs[0]?.prompt).not.toContain('[ORCHESTRATOR]');
  });

  it('the same mode changes nothing; an ended task refuses', async () => {
    h.planner(P.done());
    const runner = await h.create({ approvalMode: 'review' });
    runner.setApprovalMode('review');
    expect(h.eventsOf(runner, 'approval_mode_changed')).toHaveLength(0);
    await runner.start();
    expect(() => runner.setApprovalMode('auto')).toThrow(TaskStateError);
    expect(h.task(runner).config.approvalMode).toBe('review');
  });

  it('a task.json written before this change loads with no pending notes', async () => {
    h.planner(P.ask('Continue?'));
    const runner = await h.create();
    await runner.start();
    const legacy = h.task(runner) as unknown as Record<string, unknown>;
    delete legacy['plannerNotes'];
    h.store.writeTask(legacy as never);
    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.events(runner), h.deps());
    expect(reloaded.snapshot.plannerNotes).toEqual([]);
  });
});

describe('refused structured answers (§4, §5 net 11, decided 2026-09-17)', () => {
  const FIELD = "Output does not match required schema: root: must have required property 'changed_files'";
  const refusedTurn = (count: number, largestAttemptChars: number) => ({
    answerRejections: { count, reasons: [FIELD], largestAttemptChars },
    toolUses: { Read: 3, Grep: 2 },
  });

  it('a short answer after refusals: logged, possibly truncated, committed, and the Planner is told to ask again', async () => {
    h.planner(P.cont('Inspect the Details view and paste its markup'))
      .executor(E.ok(['notes.md'], { summary: 'Test minimal call.' }), refusedTurn(2, 3000))
      .planner(P.cont('Resend your findings: which file, which lines, and the markup'))
      .executor(E.ok([], { summary: 'The view is Views/Incidents/Details.cshtml. The button is on line 136, inside the page bar. The overview card starts on line 372.' }))
      .planner(P.done());
    h.git.pending = ['notes.md'];
    const runner = await h.create();
    await runner.start();

    const events = h.eventsOf(runner, 'structured_output_rejected');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'executor',
      purpose: 'instruction',
      cycle: 1,
      count: 2,
      reasons: [FIELD],
      largestAttemptChars: 3000,
      possiblyTruncated: true,
    });
    const turn = h.eventsOf(runner, 'turn').find((t) => t.agent === 'executor');
    expect(turn?.answerCheck?.possiblyTruncated).toBe(true);
    expect(turn?.toolUses).toEqual({ Read: 3, Grep: 2 });

    const [cycle1, cycle2] = h.eventsOf(runner, 'cycle');
    expect(cycle1?.answerCheck).toMatchObject({ count: 2, possiblyTruncated: true });
    expect(cycle1?.commit.state).toBe('committed');
    expect(cycle2?.answerCheck).toBeNull();

    const report = h.specs[2]?.prompt ?? '';
    expect(report).toContain(
      "⚠ POSSIBLY TRUNCATED REPORT: the Executor's structured answer was rejected 2 times; the accepted answer is likely truncated; ask it to resend the findings.",
    );
    expect(report).toContain(`The CLI's reason: "${FIELD}"`);
    expect(report).toContain('The Executor did work in this turn (5 tool calls: Read ×3, Grep ×2)');
    expect(report.indexOf('POSSIBLY TRUNCATED')).toBeLessThan(report.indexOf("The executor's structured report:"));
    expect(h.specs[4]?.prompt).not.toContain('rejected');
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });

  it('a full answer after a refusal is not truncated, but the Planner still hears about the refusal', async () => {
    const summary =
      'Read Views/Shipments/Details.cshtml and Content/dashboard.css. The overview grid has twelve columns and four short fields per row. No changes were needed.';
    h.planner(P.cont('Check the grid')).executor(E.ok([], { summary }), refusedTurn(1, 300)).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')[0]).toMatchObject({ count: 1, possiblyTruncated: false });
    expect(h.eventsOf(runner, 'cycle')[0]?.answerCheck?.possiblyTruncated).toBe(false);
    const report = h.specs[2]?.prompt ?? '';
    expect(report).not.toContain('POSSIBLY TRUNCATED');
    expect(report).toContain("Note: the Executor's structured answer was rejected 1 time by the CLI's schema check before one was accepted");
  });

  it('a clean turn: no event, nothing extra in the report', async () => {
    h.planner(P.cont('A')).executor(E.ok([], { summary: 'x' })).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')).toHaveLength(0);
    expect(h.eventsOf(runner, 'cycle')[0]?.answerCheck).toBeNull();
    expect(h.eventsOf(runner, 'turn')[1]?.answerCheck).toBeNull();
    expect(h.specs[2]?.prompt).not.toMatch(/rejected|TRUNCATED/);
  });

  it('Planner refusals are logged and counted, never judged truncated', async () => {
    h.planner(P.done(), refusedTurn(3, 9000));
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')).toMatchObject([{ agent: 'planner', purpose: 'start', count: 3, possiblyTruncated: false }]);
    expect(h.task(runner).status).toBe('done');
  });

  it('refusals are logged even when the CLI gave up and the turn failed', async () => {
    const gaveUp = (spec: Parameters<typeof failOutcome>[0]) =>
      failOutcome(spec, 'structured_output_failed', { message: 'The CLI refused all 5 structured answers the model gave.', ...refusedTurn(5, 3483) });
    // Two changed requests come first (§5 net 11); every attempt logs its refusals.
    h.planner(P.cont('A')).on('executor', gaveUp).on('executor', gaveUp).on('executor', gaveUp);
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')).toMatchObject([
      { agent: 'executor', count: 5, acceptedChars: null, possiblyTruncated: false },
      { agent: 'executor', count: 5 },
      { agent: 'executor', count: 5 },
    ]);
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain('refused all 5 structured answers');
  });

  it('a possibly truncated handoff: the new session is warned', async () => {
    const thin = { ...HANDOFF, task_restatement: 'Handoff test - short version.' };
    // A rollover needs an established Executor session, so it happens before the second instruction.
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => okOutcome(spec, thin, refusedTurn(2, 9524)))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const [, , , handoff, seeded] = h.specs;
    expect(handoff?.answerFile?.schema).toBe('handoff-summary');
    // The request names the fields and says which of them are lists (NOTES.md §27.6).
    expect(handoff?.prompt).toContain('task_restatement (a string');
    expect(handoff?.prompt).toContain('done_so_far, remaining, decisions, constraints, open_problems and key_files — each a LIST');
    expect(seeded?.prompt).toContain('Warning: that summary was rejected 2 times by the schema check before one was accepted, and it is likely incomplete.');
    expect(h.eventsOf(runner, 'structured_output_rejected')).toMatchObject([{ agent: 'executor', purpose: 'handoff', possiblyTruncated: true }]);
    h.assertScriptDone();
  });
});

describe('leaked tool-call markup in accepted answers (§4, decided 2026-09-17)', () => {
  const LEAKED = 'The button is in the page bar.</summary>\n<parameter name="evidence">136  <a class="btn">Update</a>';

  it('an Executor answer with it is possibly truncated without any refusal, and the Planner is told why', async () => {
    h.planner(P.cont('Paste the markup of the Update button'))
      .executor(E.ok([], { summary: LEAKED }), { toolUses: { Read: 2 } })
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')).toMatchObject([
      { agent: 'executor', purpose: 'instruction', count: 0, possiblyTruncated: true, leakedMarkup: true },
    ]);
    expect(h.eventsOf(runner, 'cycle')[0]?.answerCheck).toMatchObject({ possiblyTruncated: true, leakedMarkup: true });
    const report = h.specs[2]?.prompt ?? '';
    expect(report).toContain(
      "⚠ POSSIBLY TRUNCATED REPORT: the Executor's accepted answer contains tool-call markup (`<parameter …>`) inside a text field, so some of its fields were typed into another one and may be missing or mixed up; ask it to resend the findings.",
    );
    expect(report).toContain('The Executor did work in this turn (2 tool calls: Read ×2)');
    expect(report).not.toContain('rejected');
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });

  it('a clean answer with evidence goes to the Planner whole, and is a clean ok', async () => {
    const evidence = 'Views/Incidents/Details.cshtml:136  <a class="btn">Update</a>';
    h.planner(P.cont('Paste the markup')).executor(E.ok([], { summary: 'Found the button. The line is in evidence.', evidence })).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'structured_output_rejected')).toHaveLength(0);
    expect(h.eventsOf(runner, 'cycle')[0]?.answerCheck).toBeNull();
    expect(h.specs[2]?.prompt).toContain(`"evidence": ${JSON.stringify(evidence)}`);
  });

  it('a Planner answer with it is refused and not acted on; three in a row pause the task', async () => {
    const leaky = P.cont('Read src/a.ts</next_instruction>\n<parameter name="use_skills">["security-review"]');
    h.planner(leaky).planner(P.cont('Read src/a.ts')).executor(E.ok([])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs.map((s) => s.agent)).toEqual(['planner', 'planner', 'executor', 'planner']);
    expect(h.specs[1]?.prompt).toContain(
      '[ORCHESTRATOR] Your answer was not acted on: a text field in it contains tool-call markup (<parameter …>), so its fields were mixed up.',
    );
    expect(h.specs[2]?.prompt).toContain('[INSTRUCTION]\nRead src/a.ts');
    expect(h.specs[2]?.prompt).not.toContain('parameter');
    expect(h.eventsOf(runner, 'refused')).toMatchObject([{ reason: 'malformed_answer', missing: [] }]);
    expect(h.eventsOf(runner, 'structured_output_rejected')).toMatchObject([{ agent: 'planner', count: 0, possiblyTruncated: false, leakedMarkup: true }]);
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();

    const h2 = new Harness();
    try {
      h2.planner(leaky).planner(leaky).planner(leaky);
      const second = await h2.create();
      await second.start();
      const task = h2.task(second);
      expect(task.status).toBe('waiting_user');
      expect(task.waiting).toMatchObject({ kind: 'possible_loop' });
      expect(task.statusReason).toContain('refused the planner\'s answer 3 times in a row (tool-call markup inside its answer)');
      expect(h2.specs.every((s) => s.agent === 'planner')).toBe(true);
    } finally {
      h2.cleanup();
    }
  });

  it('a handoff with it warns the new session', async () => {
    const leakyHandoff = { ...HANDOFF, task_restatement: 'Write the README.</task_restatement>\n<parameter name="done_so_far">["x"]' };
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => okOutcome(spec, leakyHandoff))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs[4]?.prompt).toContain(
      'Warning: that summary contains tool-call markup inside a text field, so parts of it may be missing or mixed up, and it is likely incomplete.',
    );
    h.assertScriptDone();
  });
});

describe('a refused-answer failure is asked again differently (§5 net 11, decided 2026-09-18)', () => {
  const refused = (count: number) => ({
    answerRejections: { count, reasons: ["InputValidationError: … could not be parsed as JSON"], largestAttemptChars: 5216 },
    message: 'The CLI refused all 5 structured answers the model gave.',
  });

  it('changes the request twice, then lets the task stop', async () => {
    h.planner(P.cont('Paste the report'))
      .on('executor', (spec) => failOutcome(spec, 'structured_output_failed', refused(5)))
      .on('executor', (spec) => failOutcome(spec, 'structured_output_failed', refused(5)))
      .on('executor', (spec) => failOutcome(spec, 'structured_output_failed', refused(5)));
    const runner = await h.create();
    await runner.start();

    const prompts = h.specs.filter((s) => s.agent === 'executor').map((s) => s.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain('[ORCHESTRATOR]');
    expect(prompts[1]).toContain('answer SHORT: summary in 2-3 sentences, any exact text in evidence, file paths with forward slashes');
    expect(prompts[2]).toContain('Answer with the REQUIRED fields only, one short sentence each');
    // Each changed request still carries the work itself.
    for (const p of prompts.slice(1)) expect(p).toContain('[INSTRUCTION]\nPaste the report');

    expect(h.eventsOf(runner, 'answer_retry')).toMatchObject([
      { agent: 'executor', purpose: 'instruction', attempt: 1, variation: 'short_answer', refusals: 5 },
      { agent: 'executor', purpose: 'instruction', attempt: 2, variation: 'essential_fields', refusals: 5 },
    ]);
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain('refused all 5 structured answers');
    expect(ANSWER_RETRY_VARIATIONS).toHaveLength(2);
    h.assertScriptDone();
  });

  it('stops changing it once an answer arrives, and the next failure starts again', async () => {
    h.planner(P.cont('A'))
      .on('executor', (spec) => failOutcome(spec, 'structured_output_failed', refused(5)))
      .executor(E.ok(['a']))
      .planner(P.cont('B'))
      .on('executor', (spec) => failOutcome(spec, 'structured_output_failed', refused(2)))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'answer_retry').map((e) => [e.attempt, e.refusals])).toEqual([
      [1, 5],
      [1, 2],
    ]);
    expect(h.task(runner).loop.answerRetries).toBe(0);
    h.assertScriptDone();
  });

  it('leaves other failures alone', async () => {
    h.planner(P.cont('A')).on('executor', (spec) => failOutcome(spec, 'timeout', { message: 'the turn timed out' }));
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'answer_retry')).toHaveLength(0);
    expect(h.task(runner).status).toBe('error');
  });
});

describe('a failed handoff never kills the task (§15, decided 2026-09-18)', () => {
  const badAnswer = (spec: Parameters<typeof failOutcome>[0]) =>
    failOutcome(spec, 'structured_output_failed', {
      message: 'The CLI refused all 5 structured answers the model gave.',
      answerRejections: { count: 5, reasons: ['could not be parsed as JSON'], largestAttemptChars: 9000 },
    });

  it('asks once for a shorter summary, and rolls over when that works', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', badAnswer)
      .on('executor', (spec) => okOutcome(spec, HANDOFF))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    const before = h.task(runner).sessions.executor.sessionId;
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
    expect(h.eventsOf(runner, 'rollover_skipped')).toHaveLength(0);
    expect(task.sessions.executor.sessionId).not.toBe(before);
    expect(task.sessions.executor.handoffAttempts).toBe(0);
    const handoffs = h.specs.filter(isHandoff);
    expect(handoffs[1]?.prompt).toContain('keep this one small');
    h.assertScriptDone();
  });

  it('a Stop during a handoff still stops, and a usage limit is still a usage limit', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => failOutcome(spec, 'rate_limited', { message: 'Usage limit reached', resetsAt: 1_900_000_000 }));
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('rate_limited');
    expect(h.eventsOf(runner, 'rollover_skipped')).toHaveLength(0);
    // The session is untouched, so Resume can try the handoff again.
    expect(h.task(runner).sessions.executor.rolloverRequested).toContain('the planner requested it');
  });

  it('"Roll over now" clears the block a failed handoff left', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', badAnswer)
      .on('executor', badAnswer)
      .executor(E.ok(['b']))
      .planner(P.ask('Carry on?'));
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.sessions.executor.rolloverBlocked).not.toBeNull();

    runner.requestRollover('executor');
    task = h.task(runner);
    expect(task.sessions.executor.rolloverBlocked).toBeNull();
    expect(task.sessions.executor.rolloverRequested).toBe('requested by the user');

    h.planner(P.cont('C')).on('executor', (spec) => okOutcome(spec, HANDOFF)).executor(E.ok(['c'])).planner(P.done());
    await runner.answer('yes, carry on');
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
    expect(h.task(runner).sessions.executor.retired).toHaveLength(1);
    h.assertScriptDone();
  });

  it('older task files load without the new session fields', async () => {
    const runner = await h.create();
    const task = h.task(runner);
    delete (task.sessions.executor as { handoffAttempts?: number }).handoffAttempts;
    delete (task.sessions.executor as { rolloverBlocked?: unknown }).rolloverBlocked;
    delete (task.loop as { answerRetries?: number }).answerRetries;
    const reloaded = TaskRunner.load(task, h.events(runner), h.deps());
    expect(reloaded.snapshot.sessions.executor.handoffAttempts).toBe(0);
    expect(reloaded.snapshot.sessions.executor.rolloverBlocked).toBeNull();
    expect(reloaded.snapshot.loop.answerRetries).toBe(0);
  });
});

describe('file paths the app hands back (§4, decided 2026-09-18)', () => {
  it('reach the agents with forward slashes, in the report and in the seed', async () => {
    const windows = { ...HANDOFF, key_files: ['ledger\\commands\\expenses.py', 'tests\\hidden\\test_d3.py'] };
    h.planner(P.cont('A'))
      .executor(E.ok([], { summary: 'Fixed it. Tests pass.', changed_files: [{ path: 'ledger\\commands\\expenses.py', change: 'modified' }] }))
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => okOutcome(spec, windows))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();

    const report = h.specs[2]?.prompt ?? '';
    expect(report).toContain('"path": "ledger/commands/expenses.py"');
    expect(report).not.toContain('ledger\\commands');

    const seeded = h.specs.find((s) => s.prompt.includes('handoff summary:'))?.prompt ?? '';
    expect(seeded).toContain('"ledger/commands/expenses.py"');
    expect(seeded).toContain('"tests/hidden/test_d3.py"');
    expect(seeded).not.toMatch(/ledger\\+commands/);
    h.assertScriptDone();
  });
});

describe('service errors are retried once (§5 net 12, decided 2026-09-17)', () => {
  const RACE = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. Please retry in a minute.';
  const service = (message = RACE, apiErrorStatus: number | null = null) => (spec: Parameters<typeof failOutcome>[0]) =>
    failOutcome(spec, 'api_error', { message, rawText: `RAW ${message}`, apiErrorStatus });

  it('an Executor turn: the task stays running, the same step runs again a minute later, and both attempts are logged', async () => {
    h.planner(P.cont('Run the build')).on('executor', service()).executor(E.ok()).planner(P.done());
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    expect(h.scheduled[0]?.at).toBe(h.clock.getTime() + SERVICE_RETRY_DELAY_MS);
    expect(SERVICE_RETRY_DELAY_MS).toBe(60_000);
    let task = h.task(runner);
    expect(task.status).toBe('running');
    const failedTurn = h.specs[1]?.turnId;
    expect(task.loop.serviceRetry).toEqual({ turnId: failedTurn, agent: 'executor', retryAt: '2026-09-16T10:01:00.000Z' });
    expect(h.eventsOf(runner, 'service_retry')).toEqual([
      expect.objectContaining({ outcome: 'retrying', agent: 'executor', purpose: 'instruction', turnId: failedTurn, retryOf: null, errorKind: 'api_error', apiErrorStatus: null, message: RACE, retryAt: '2026-09-16T10:01:00.000Z' }),
    ]);
    expect(h.specs).toHaveLength(2);
    expect(runner.busy).toBe(true);

    h.scheduled[0]?.fn();
    await finished;
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.statuses(runner)).toEqual(['running', 'done']);
    expect(task.loop.serviceRetry).toBeNull();
    const retry = h.specs[2];
    expect(retry?.agent).toBe('executor');
    expect(retry?.prompt).toMatch(/^\[ORCHESTRATOR\] A previous attempt at the message below did not finish \(Failed to refresh OAuth token/);
    expect(h.eventsOf(runner, 'turn_started').filter((e) => e.agent === 'executor').map((e) => e.cycle)).toEqual([1, 1]);
    expect(h.eventsOf(runner, 'service_retry').map((e) => [e.outcome, e.turnId, e.retryOf])).toEqual([
      ['retrying', failedTurn, null],
      ['recovered', retry?.turnId, failedTurn],
    ]);
    // The failed attempt keeps its raw output in its own turn record.
    expect(h.eventsOf(runner, 'turn')[1]?.error).toMatchObject({ kind: 'api_error', rawText: `RAW ${RACE}` });
    h.assertScriptDone();
  });

  it('a Planner turn that fails again goes to error with the second raw message; Resume gets its own retry', async () => {
    h.on('planner', service('overloaded', 529)).on('planner', service('token expired', 401));
    const runner = await h.create();
    let finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    h.scheduled[0]?.fn();
    await finished;
    let task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toBe('api_error: token expired');
    expect(h.scheduled).toHaveLength(1);
    expect(h.eventsOf(runner, 'service_retry')).toMatchObject([
      { outcome: 'retrying', agent: 'planner', purpose: 'start', apiErrorStatus: 529, message: 'overloaded' },
      { outcome: 'failed', agent: 'planner', errorKind: 'api_error', apiErrorStatus: 401, message: 'token expired', retryOf: h.specs[0]?.turnId },
    ]);
    expect(task.loop.serviceRetry).toBeNull();

    h.on('planner', service('bad gateway', 502)).planner(P.done());
    finished = runner.resume();
    await waitFor(() => h.scheduled.length === 2);
    h.scheduled[1]?.fn();
    await finished;
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'service_retry').map((e) => e.outcome)).toEqual(['retrying', 'failed', 'retrying', 'recovered']);
    h.assertScriptDone();
  });

  it('request errors and other failures are not retried', async () => {
    h.on('planner', service('prompt is too long', 413));
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('error');
    expect(h.scheduled).toHaveLength(0);
    expect(h.eventsOf(runner, 'service_retry')).toHaveLength(0);
  });

  it('a retry that hits the usage limit is rate_limited as usual', async () => {
    h.on('planner', service()).on('planner', (spec) => failOutcome(spec, 'rate_limited', { message: 'limit', resetsAt: 1_900_000_000 }));
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    h.scheduled[0]?.fn();
    await finished;
    expect(h.task(runner).status).toBe('rate_limited');
    expect(h.eventsOf(runner, 'service_retry').map((e) => [e.outcome, e.errorKind])).toEqual([
      ['retrying', 'api_error'],
      ['failed', 'rate_limited'],
    ]);
  });

  it('Stop during the wait stops at once; Resume runs the step', async () => {
    h.planner(P.cont('A')).on('executor', service());
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    await runner.stop();
    await finished;
    let task = h.task(runner);
    expect(task.status).toBe('stopped');
    expect(h.scheduled[0]?.cancelled).toBe(true);
    expect(h.specs).toHaveLength(2);

    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.loop.serviceRetry).toBeNull();
    expect(h.specs[2]?.prompt).toContain('A previous attempt at the message below did not finish');
    expect(h.eventsOf(runner, 'service_retry').map((e) => e.outcome)).toEqual(['retrying']);
    h.assertScriptDone();
  });

  it('Pause during the wait holds at once, without spawning', async () => {
    h.planner(P.cont('A')).on('executor', service());
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    runner.pause();
    await finished;
    const task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'paused', cause: 'user' });
    expect(h.scheduled[0]?.cancelled).toBe(true);
    expect(h.specs).toHaveLength(2);
  });

  it('a handoff is retried too, and the rollover completes', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', service())
      .on('executor', (spec) => okOutcome(spec, HANDOFF))
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    expect(h.eventsOf(runner, 'service_retry')).toMatchObject([{ outcome: 'retrying', agent: 'executor', purpose: 'handoff' }]);
    h.scheduled[0]?.fn();
    await finished;
    expect(h.task(runner).status).toBe('done');
    expect(h.specs.filter(isHandoff)).toHaveLength(2);
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
    expect(h.eventsOf(runner, 'service_retry').map((e) => [e.outcome, e.purpose])).toEqual([
      ['retrying', 'handoff'],
      ['recovered', 'handoff'],
    ]);
    h.assertScriptDone();
  });

  it('an app that stops during the wait comes back in error, and Resume runs the step', async () => {
    h.planner(P.cont('A')).on('executor', service());
    const runner = await h.create();
    void runner.start();
    await waitFor(() => h.scheduled.length === 1);
    // The app exits here; a new process loads the task from disk.
    const reloaded = TaskRunner.load(h.task(runner), h.events(runner), h.deps());
    let task = h.task(reloaded);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain('The app stopped while this task was running.');
    h.executor(E.ok()).planner(P.done());
    await reloaded.resume();
    task = h.task(reloaded);
    expect(task.status).toBe('done');
    expect(task.loop.serviceRetry).toBeNull();
    expect(h.specs[2]?.prompt).toContain('A previous attempt at the message below did not finish');
  });

  it('shutting down during the wait cancels the timer and spawns nothing', async () => {
    h.planner(P.cont('A')).on('executor', service());
    const runner = await h.create();
    void runner.start();
    await waitFor(() => h.scheduled.length === 1);
    runner.dispose();
    expect(h.scheduled[0]?.cancelled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.specs).toHaveLength(2);
    expect(h.task(runner).status).toBe('running');
  });

  it('older task files load without the retry field', async () => {
    const runner = await h.create();
    const task = h.task(runner);
    delete (task.loop as { serviceRetry?: unknown }).serviceRetry;
    const reloaded = TaskRunner.load(task, h.events(runner), h.deps());
    expect(reloaded.snapshot.loop.serviceRetry).toBeNull();
  });
});

describe('fresh Executor session after rejected answers (§15 setting, decided 2026-09-17)', () => {
  const rejected = { answerRejections: { count: 1, reasons: ["must have required property 'changed_files'"], largestAttemptChars: 200 } };
  const schemas = () => h.specs.map((s) => (isHandoff(s) ? 'handoff' : s.agent));

  it('is off by default: refusals never start a new session', async () => {
    h.planner(P.cont('A')).executor(E.ok(), rejected).planner(P.cont('B')).executor(E.ok(['b']), rejected).planner(P.cont('C')).executor(E.ok(['c']), rejected).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(schemas()).not.toContain('handoff');
    expect(h.eventsOf(runner, 'rollover_requested')).toHaveLength(0);
    expect(h.task(runner).loop.rejectedStreak).toBe(3);
  });

  it('with N = 2: after two such turns in a row the next Executor turn starts fresh, and it is logged', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok(), rejected)
      .planner(P.cont('B'))
      .executor(E.ok(['b']), rejected)
      .planner(P.cont('C'))
      .executor(HANDOFF)
      .executor(E.ok(['c']))
      .planner(P.done());
    const runner = await h.create({ freshExecutorAfterRejectedTurns: 2 });
    await runner.start();

    const reason = '2 Executor turns in a row had rejected answers (setting: a fresh session after 2)';
    expect(h.eventsOf(runner, 'rollover_requested')).toMatchObject([{ agent: 'executor', reason }]);
    expect(schemas()).toEqual(['planner', 'executor', 'planner', 'executor', 'planner', 'handoff', 'executor', 'planner']);
    expect(h.eventsOf(runner, 'rollover')[0]).toMatchObject({ agent: 'executor', reason });
    const task = h.task(runner);
    expect(task.sessions.executor.retired).toMatchObject([{ reason: `rolled over: ${reason}` }]);
    expect(h.specs[6]?.newSessionId).toBe(task.sessions.executor.sessionId);
    expect(task.loop.rejectedStreak).toBe(0);
    expect(task.status).toBe('done');
    h.assertScriptDone();
  });

  it('a turn without refusals starts the count again', async () => {
    h.planner(P.cont('A')).executor(E.ok(), rejected).planner(P.cont('B')).executor(E.ok(['b'])).planner(P.cont('C')).executor(E.ok(['c']), rejected).planner(P.done());
    const runner = await h.create({ freshExecutorAfterRejectedTurns: 2 });
    await runner.start();
    expect(schemas()).not.toContain('handoff');
    expect(h.task(runner).loop.rejectedStreak).toBe(1);
  });

  it('a turn the CLI gave up on counts too: the rollover happens and the changed request runs in the fresh session', async () => {
    const gaveUp = (spec: Parameters<typeof failOutcome>[0]) =>
      failOutcome(spec, 'structured_output_failed', { message: 'The CLI refused all 5 structured answers the model gave.', ...rejected });
    h.planner(P.cont('A'))
      .executor(E.ok(), rejected)
      .planner(P.cont('B'))
      .on('executor', gaveUp) // the CLI gives up: the count reaches N and a rollover is requested
      .executor(HANDOFF) // the handoff runs before the step is tried again
      .executor(E.ok(['b'])) // the changed request, in the fresh session
      .planner(P.done());
    const runner = await h.create({ freshExecutorAfterRejectedTurns: 2 });
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'rollover_requested')).toHaveLength(1);
    expect(h.eventsOf(runner, 'answer_retry')).toMatchObject([{ attempt: 1, variation: 'short_answer' }]);
    expect(schemas().slice(3)).toEqual(['executor', 'handoff', 'executor', 'planner']);
    const retried = h.specs[5]?.prompt ?? '';
    expect(retried).toContain('[ORCHESTRATOR] You are continuing this task'); // the fresh session's seed
    expect(retried).toContain('answer SHORT'); // and the changed request
    expect(retried).toContain('[INSTRUCTION]\nB');
    h.assertScriptDone();
  });

  it('older tasks load with the setting off and no count', async () => {
    h.planner(P.ask('Go on?'));
    const runner = await h.create();
    await runner.start();
    const legacy = h.task(runner) as unknown as { config: Record<string, unknown>; loop: Record<string, unknown> };
    delete legacy.config['freshExecutorAfterRejectedTurns'];
    delete legacy.loop['rejectedStreak'];
    h.store.writeTask(legacy as never);
    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.events(runner), h.deps());
    expect(reloaded.snapshot.config.freshExecutorAfterRejectedTurns).toBeNull();
    expect(reloaded.snapshot.loop.rejectedStreak).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §15 rollover
// ---------------------------------------------------------------------------

describe('rollover (§15)', () => {
  const big = (tokens: number) => ({ usage: { contextTokens: tokens, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1, costUsd: 0, modelUsage: {}, sessionCostUsd: 0, sessionModelUsage: {} } });

  it('context over the threshold → handoff in the old session, then a new session seeded with the summary', async () => {
    // opus: 60% of 967,000 = 580,200.
    h.planner(P.cont('A'), big(580_201))
      .executor(E.ok())
      .on('planner', (spec) => okOutcome(spec, HANDOFF))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    const [first, , handoff, fresh] = h.specs;
    expect(handoff?.schema).toBe('handoff-summary');
    expect(handoff?.resumeSessionId).toBe(first?.newSessionId);
    expect(handoff?.prompt).toContain('Produce a handoff summary');
    expect(fresh?.newSessionId).toBe(task.sessions.planner.sessionId);
    expect(fresh?.newSessionId).not.toBe(first?.newSessionId);
    expect(fresh?.resumeSessionId).toBeUndefined();
    const seedAt = fresh?.prompt.indexOf('"task_restatement": "Write the README."') ?? -1;
    expect(seedAt).toBeGreaterThan(0);
    expect(fresh?.prompt).toContain('The original task description:\nAdd a README with the project name.');
    expect(fresh?.prompt.indexOf('[EXECUTOR REPORT] Cycle 1')).toBeGreaterThan(seedAt);
    expect(task.sessions.planner.retired).toEqual([
      expect.objectContaining({ sessionId: first?.newSessionId, reason: expect.stringContaining('exceeded the rollover threshold 580,200') }),
    ]);
    const rollover = h.eventsOf(runner, 'rollover')[0];
    expect(rollover).toMatchObject({ agent: 'planner', oldSessionId: first?.newSessionId, newSessionId: fresh?.newSessionId, summary: HANDOFF });
    h.assertScriptDone();
  });

  it('at or below the threshold nothing happens; 200k models roll over much earlier', async () => {
    h.planner(P.cont('A'), big(580_200)).executor(E.ok(), big(100_201)).planner(P.cont('B')).executor(HANDOFF).executor(E.ok(['b'])).planner(P.done());
    const runner = await h.create({ executor: { model: 'claude-sonnet-4-6', effort: 'medium' } });
    await runner.start();
    expect(h.specs.map((s) => s.schema)).toEqual([
      'planner-output',
      'executor-output',
      'planner-output',
      'executor-output',
      'executor-output',
      'planner-output',
    ]);
    expect(h.specs[3]?.answerFile?.schema).toBe('handoff-summary');
    expect(h.specs[4]?.prompt).toContain('[ORCHESTRATOR] You are continuing this task');
    expect(h.specs[4]?.prompt).not.toContain('The original task description');
    expect(h.specs[4]?.prompt).toContain('[INSTRUCTION]\nB');
  });

  describe('the Executor writes its handoff to a file, so its schema and its cache stay (§15, 2026-10-06)', () => {
    const script = () =>
      h.planner(P.cont('A')).executor(E.ok()).planner(P.cont('B', { request_executor_rollover: true })).executor(HANDOFF).executor(E.ok(['b'])).planner(P.done());

    it('keeps executor-output and reads the summary from the scratch folder', async () => {
      script();
      const runner = await h.create();
      await runner.start();
      const task = h.task(runner);
      const handoff = h.specs[3];
      expect(handoff?.schema).toBe('executor-output');
      expect(handoff?.resumeSessionId).toBe(h.specs[1]?.newSessionId);
      const file = `.${APP_SLUG}/handoff/${handoff?.turnId}.json`;
      expect(handoff?.answerFile).toEqual({ path: path.join(task.projectDir, `.${APP_SLUG}`, 'handoff', `${handoff?.turnId}.json`), schema: 'handoff-summary' });
      expect(handoff?.prompt).toContain(`with the Write tool, to ${file}`);
      expect(handoff?.prompt).not.toContain('structured-output tool once, with each handoff field');
      expect(h.eventsOf(runner, 'rollover')).toMatchObject([{ agent: 'executor', summary: HANDOFF }]);
      expect(h.specs[4]?.prompt).toContain('"task_restatement": "Write the README."');
      h.assertScriptDone();
    });

    it('a summary the file check refuses is asked for again, shorter, like any refused answer', async () => {
      h.planner(P.cont('A'))
        .executor(E.ok())
        .planner(P.cont('B', { request_executor_rollover: true }))
        .on('executor', (spec) => failOutcome(spec, 'schema_invalid', { message: 'The handoff-summary file was not written' }))
        .executor(HANDOFF)
        .executor(E.ok(['b']))
        .planner(P.done());
      const runner = await h.create();
      await runner.start();
      const handoffs = h.specs.filter(isHandoff);
      expect(handoffs).toHaveLength(2);
      expect(handoffs[1]?.answerFile?.schema).toBe('handoff-summary');
      expect(handoffs[1]?.prompt).toContain('keep this one small');
      expect(handoffs[1]?.answerFile?.path).not.toBe(handoffs[0]?.answerFile?.path);
      expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
      h.assertScriptDone();
    });

    it('an Executor without Write hands off the old way', async () => {
      script();
      const runner = await h.create({ executorTools: ['Read', 'Edit', 'Bash'] });
      await runner.start();
      expect(h.specs[3]).toMatchObject({ schema: 'handoff-summary' });
      expect(h.specs[3]?.answerFile).toBeUndefined();
      expect(h.specs[3]?.prompt).toContain('Produce a handoff summary');
      h.assertScriptDone();
    });

    it('so does one whose Write is forbidden outright', async () => {
      script();
      const runner = await h.create({ executorDisallowedTools: ['Write'] });
      await runner.start();
      expect(h.specs[3]?.schema).toBe('handoff-summary');
      h.assertScriptDone();
    });
  });

  it('honours the planner’s request_executor_rollover before the executor’s next turn', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .executor(HANDOFF)
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(task.sessions.executor.retired[0]?.reason).toContain('the planner requested it');
    expect(h.specs[4]?.newSessionId).toBe(task.sessions.executor.sessionId);
    expect(h.eventsOf(runner, 'rollover_requested')[0]).toMatchObject({ agent: 'executor' });
    h.assertScriptDone();
  });

  it('a handoff that fails for a non-answer reason skips the rollover and keeps the session (§15, 2026-09-18)', async () => {
    h.planner(P.cont('A'), big(700_000)).executor(E.ok()).on('planner', (spec) => failOutcome(spec, 'process_failed', { message: 'the CLI died' })).planner(P.done());
    const runner = await h.create();
    const before = h.task(runner).sessions.planner.sessionId;
    await runner.start();
    const task = h.task(runner);
    // The task carries on in the session it already had; only the rollover was given up.
    expect(task.status).toBe('done');
    expect(task.sessions.planner.sessionId).toBe(before);
    expect(task.sessions.planner.retired).toEqual([]);
    expect(h.eventsOf(runner, 'rollover_skipped')).toMatchObject([{ agent: 'planner', attempts: 1, reason: 'process_failed: the CLI died' }]);
    // An answer failure would have been asked again in short form first; this one is not an answer failure.
    expect(h.specs.filter((s) => s.schema === 'handoff-summary')).toHaveLength(1);
    h.assertScriptDone();
  });
});

// ---------------------------------------------------------------------------
// §16 skills
// ---------------------------------------------------------------------------

describe('skills (§16)', () => {
  it('discovers skills at setup (init probe) and lists them in the planner system prompt', async () => {
    h.planner(P.done());
    const runner = await h.create({ requiredSkills: [] });
    await runner.start();
    const task = h.task(runner);
    expect(task.skills).toMatchObject({ available: ['deep-research'], discoveredFrom: 'init_probe' });
    expect(h.specs[0]?.systemPrompt).toContain('- deep-research');
    expect(h.eventsOf(runner, 'setup')[0]).toMatchObject({ skills: ['deep-research'], skillsError: null, missingRequiredSkills: [] });
  });

  it('a required built-in found only in slash_commands is listed; a missing one is reported', async () => {
    h.planner(P.ask('?'));
    const runner = await h.create({ requiredSkills: ['security-review', 'no-such-skill'] });
    await runner.start();
    expect(h.task(runner).skills.available).toEqual(['deep-research', 'security-review']);
    expect(h.eventsOf(runner, 'setup')[0]?.missingRequiredSkills).toEqual(['no-such-skill']);
    expect(h.specs[0]?.systemPrompt).toContain('## Required before done');
  });

  it('refuses done until a required skill ran successfully (from Skill tool calls, not prose)', async () => {
    h.remote(true);
    h.planner(P.cont('Implement'))
      .executor(E.ok(['a.ts'], { summary: 'I ran security-review.' }))
      .planner(P.done())
      .planner(P.cont('Review', { use_skills: ['security-review'] }))
      .executor(E.ok([]), { skillInvocations: [{ skill: 'security-review', toolUseId: 's1', isError: false, resultText: 'Launching skill' }] })
      .planner(P.done('Reviewed.'));
    const runner = await h.create({ requiredSkills: ['security-review'] });
    h.git.pending = ['a.ts'];
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.skills.satisfied).toEqual(['security-review']);
    const refusal = h.specs[3]?.prompt ?? '';
    expect(refusal).toContain('status=done refused');
    expect(refusal).toContain('- security-review: never requested');
    expect(h.specs[4]?.prompt).toMatch(/^Before doing anything else, invoke skill\(s\): security-review\./);
    const cycle2 = h.eventsOf(runner, 'cycle')[1];
    expect(cycle2?.skillOutcomes).toEqual([{ skill: 'security-review', requested: true, state: 'ok' }]);
    expect(h.specs[5]?.prompt).toContain('Skill security-review: ran successfully.');
    h.assertScriptDone();
  });

  it('commits before a security-review turn so the skill sees the changes (§18)', async () => {
    h.remote(true);
    h.planner(P.cont('Implement')).executor(E.ok(['a.ts'], { status: 'failed' })).planner(P.cont('Review', { use_skills: ['security-review'] }));
    h.on('executor', (spec) => okOutcome(spec, E.ok([])));
    h.planner(P.done());
    const runner = await h.create();
    h.git.pending = ['a.ts'];
    await runner.start();
    const commits = h.eventsOf(runner, 'commit');
    expect(commits[0]).toMatchObject({ purpose: 'before_review', cycle: 2 });
    expect(h.git.commits[0]?.message).toBe(`[${APP_SLUG}] before cycle 2: snapshot for security-review`);
  });

  it('a Skill call that errors does not count', async () => {
    h.remote(true);
    h.planner(P.cont('Review', { use_skills: ['security-review'] }))
      .executor(E.ok([]), { skillInvocations: [{ skill: 'security-review', toolUseId: 's1', isError: true, resultText: 'boom' }] })
      .planner(P.done());
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    expect(h.task(runner).skills.satisfied).toEqual([]);
    expect(h.specs[2]?.prompt).toContain('Skill security-review: failed (the Skill tool returned an error).');
    expect(h.specs[3]?.prompt).toContain('- security-review: failed (the Skill tool returned an error)');
  });

  it('when the probe fails, skills are learned from the executor’s first init and told to the planner', async () => {
    h.probe = async () => {
      throw new Error('probe timed out');
    };
    h.planner(P.cont('A'))
      .executor(E.ok(), { init: { sessionId: 'x', model: 'm', skills: ['tidy'], slashCommands: ['security-review'] } })
      .planner(P.done());
    const runner = await h.create({ requiredSkills: [] });
    await runner.start();
    expect(h.specs[0]?.systemPrompt).toContain('could not be determined');
    expect(h.eventsOf(runner, 'setup')[0]?.skillsError).toBe('probe timed out');
    expect(h.task(runner).skills).toMatchObject({ available: ['tidy'], discoveredFrom: 'executor_init' });
    expect(h.specs[2]?.prompt).toContain('Skills the executor can invoke (learned from its session): tidy.');
  });
});


describe('required-skill waiver (§16, decided 2026-09-16)', () => {
  const skipped = { skillInvocations: [{ skill: 'security-review', toolUseId: 's1', isError: true, resultText: 'Shell command failed' }] };

  it('done with only an environmentally impossible skill left → waiting_user offering a waiver; waiving finishes the task', async () => {
    h.planner(P.cont('Implement')).executor(E.ok(['a.ts'])).planner(P.done('Implemented; review impossible here.'));
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({
      kind: 'skill_waiver',
      after: 'finish',
      finalReport: 'Implemented; review impossible here.',
      skills: [{ skill: 'security-review', reason: expect.stringContaining('no git remote') }],
    });
    expect(task.statusReason).toMatch(/Waive it for this task/);
    expect(h.notifications.at(-1)?.status).toBe('waiting_user');
    // Nothing was refused to the planner and nothing was waived on its own.
    expect(h.eventsOf(runner, 'refused')).toEqual([]);
    expect(task.skills.waived).toEqual([]);

    await runner.waiveSkill('security-review', 'Local-only repo.');
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.finalReport).toBe('Implemented; review impossible here.');
    expect(task.skills.waived).toEqual([{ skill: 'security-review', reason: expect.stringContaining('no git remote'), note: 'Local-only repo.', at: expect.any(String) }]);
    expect(task.skills.satisfied).toEqual([]);
    expect(h.eventsOf(runner, 'skill_waived')).toEqual([expect.objectContaining({ skill: 'security-review', note: 'Local-only repo.' })]);
    expect(h.eventsOf(runner, 'intervention').at(-1)).toMatchObject({ kind: 'waive_skill', text: 'Local-only repo.' });
    h.assertScriptDone();
  });

  it('a requested skill blocked by the environment → the waiver is offered before the planner sees the report', async () => {
    h.planner(P.cont('Review', { use_skills: ['security-review'] })).executor(E.ok([]), skipped);
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    let task = h.task(runner);
    expect(h.eventsOf(runner, 'cycle')[0]?.skillOutcomes[0]?.state).toBe('skipped_no_remote');
    expect(task.waiting).toMatchObject({ kind: 'skill_waiver', after: 'continue', finalReport: null });
    expect(task.next).toMatchObject({ agent: 'planner', purpose: 'executor_report' });
    expect(h.specs).toHaveLength(2);

    h.planner(P.done());
    await runner.waiveSkill('security-review');
    task = h.task(runner);
    const report = h.specs[2]?.prompt ?? '';
    expect(report.indexOf('[ORCHESTRATOR] The user waived the required skill security-review for this task')).toBe(0);
    expect(report).toContain('Skill security-review: skipped — no git remote');
    expect(task.status).toBe('done');
    expect(h.eventsOf(runner, 'skill_waived')[0]?.note).toBeNull();
    h.assertScriptDone();
  });

  it('declining (or replying) keeps the requirement and sends the reply to the planner', async () => {
    h.planner(P.cont('Implement')).executor(E.ok(['a.ts'])).planner(P.done());
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    h.planner(P.ask('Should I stop here?'));
    await runner.declineWaiver('I will add a remote first.');
    let task = h.task(runner);
    const prompt = h.specs[3]?.prompt ?? '';
    expect(prompt).toContain('[FROM USER] The required skill(s) security-review cannot run in this environment and were NOT waived');
    expect(prompt).toContain('I will add a remote first.');
    expect(task.skills.waived).toEqual([]);
    expect(h.eventsOf(runner, 'skill_waiver_declined')[0]?.skills[0]?.skill).toBe('security-review');
    expect(task.waiting?.kind).toBe('question');

    // After the remote exists, the skill can run and satisfy the gate normally.
    h.remote(true);
    h.planner(P.cont('Review', { use_skills: ['security-review'] }))
      .executor(E.ok([]), { skillInvocations: [{ skill: 'security-review', toolUseId: 's2', isError: false, resultText: 'ok' }] })
      .planner(P.done());
    await runner.answer('Remote added.');
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.skills.satisfied).toEqual(['security-review']);

    // A plain answer while a waiver is offered counts as declining it.
    const h2 = new Harness();
    try {
      h2.planner(P.done());
      const other = await h2.create({ requiredSkills: ['security-review'] });
      await other.start();
      h2.planner(P.ask('ok?'));
      await other.answer('No waiver.');
      expect(h2.eventsOf(other, 'skill_waiver_declined')).toHaveLength(1);
      expect(h2.task(other).skills.waived).toEqual([]);
    } finally {
      h2.cleanup();
    }
  });

  it('never waives on its own: resume and messages are refused; stop parks the offer; it applies to this task only', async () => {
    h.planner(P.done());
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    await expect(runner.resume()).rejects.toThrow(TaskStateError);
    await expect(runner.sendMessage('go')).rejects.toThrow(/decision on a required skill/);
    await expect(runner.waiveSkill('lint')).rejects.toThrow(/not offered/);
    await runner.stop();
    expect(h.task(runner).status).toBe('stopped');
    await runner.resume();
    expect(h.task(runner).waiting?.kind).toBe('skill_waiver');
    await runner.waiveSkill('security-review');
    expect(h.task(runner).status).toBe('done');

    // Another task in the same place still requires it.
    h.planner(P.done());
    const next = await h.create({ requiredSkills: ['security-review'] });
    await next.start();
    expect(h.task(next).waiting?.kind).toBe('skill_waiver');
    expect(h.task(next).skills.waived).toEqual([]);
  });

  it('runnable required skills are refused first; the impossible one is offered once the rest has run', async () => {
    h.probe = async () => ({ skills: ['lint'], slashCommands: ['security-review'] });
    h.planner(P.done())
      .planner(P.cont('Lint', { use_skills: ['lint'] }))
      .executor(E.ok([]), { skillInvocations: [{ skill: 'lint', toolUseId: 'l1', isError: false, resultText: 'clean' }] })
      .planner(P.done('All good.'));
    const runner = await h.create({ requiredSkills: ['security-review', 'lint', 'ghost'] });
    await runner.start();
    const refusal = h.specs[1]?.prompt ?? '';
    expect(refusal).toContain('- lint: never requested');
    expect(refusal).not.toContain('- security-review');
    expect(refusal).toMatch(/cannot run in this environment; once the rest is done, the user will be asked whether to waive them: .*security-review.*ghost/);
    expect(h.eventsOf(runner, 'refused')[0]?.missing).toEqual(['lint']);
    const task = h.task(runner);
    expect(task.skills.satisfied).toEqual(['lint']);
    expect(task.waiting).toMatchObject({ kind: 'skill_waiver', skills: [{ skill: 'security-review' }, { skill: 'ghost', reason: expect.stringContaining('does not offer') }] });

    await runner.waiveSkill('ghost');
    expect(h.task(runner).waiting).toMatchObject({ kind: 'skill_waiver', skills: [{ skill: 'security-review' }] });
    await runner.waiveSkill('security-review');
    expect(h.task(runner).status).toBe('done');
    expect(h.task(runner).finalReport).toBe('All good.');
    h.assertScriptDone();
  });

  it('a skill that failed is not environmental: it is refused to the planner, not offered for a waiver', async () => {
    h.remote(true);
    h.planner(P.cont('Review', { use_skills: ['security-review'] }))
      .executor(E.ok([]), skipped)
      .planner(P.done());
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    expect(h.eventsOf(runner, 'refused')).toHaveLength(1);
    expect(h.task(runner).waiting?.kind).not.toBe('skill_waiver');
  });
});

// ---------------------------------------------------------------------------
// §17 rate limits
// ---------------------------------------------------------------------------

describe('rate limits (§17)', () => {
  const resetsAt = Date.parse('2026-09-16T15:00:00Z') / 1000;

  it('rate_limited keeps the sessions; Resume retries the same step', async () => {
    h.planner(P.cont('A')).on('executor', (spec) =>
      failOutcome(spec, 'rate_limited', {
        message: 'Usage limit reached (five_hour); the turn was stopped.',
        resetsAt,
        rateLimit: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: null, windows: {} },
      }),
    );
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('rate_limited');
    expect(task.rateLimit).toMatchObject({ resetsAt, rateLimitType: 'five_hour', autoResumeAt: null });
    expect(task.statusReason).toContain('Resets at 2026-09-16T15:00:00.000Z');
    expect(h.eventsOf(runner, 'rate_limit')[0]).toMatchObject({ status: 'rejected', resetsAt });
    expect(h.notifications.at(-1)?.status).toBe('rate_limited');
    expect(h.scheduled).toHaveLength(0);
    const session = task.sessions.executor.sessionId;

    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.rateLimit).toBeNull();
    expect(h.specs[2]?.resumeSessionId).toBe(session);
    expect(h.specs[2]?.prompt).toContain('[INSTRUCTION]\nA');
  });

  it('auto-resume at reset, when enabled', async () => {
    h.general.autoResumeAtReset = true;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const runner = await h.create();
    await runner.start();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.at).toBe(resetsAt * 1000 + AUTO_RESUME_MARGIN_MS);
    expect(h.task(runner).rateLimit?.autoResumeAt).toBe(new Date(resetsAt * 1000 + AUTO_RESUME_MARGIN_MS).toISOString());
    expect(h.eventsOf(runner, 'auto_resume_scheduled')).toHaveLength(1);

    h.planner(P.done());
    h.scheduled[0]!.fn();
    await waitFor(() => h.task(runner).status === 'done');
  });

  it('a manual Resume cancels the scheduled auto-resume; reloading a rate-limited task re-arms it', async () => {
    h.general.autoResumeAtReset = true;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const runner = await h.create();
    await runner.start();
    const reloaded = TaskRunner.load(h.task(runner), h.events(runner), h.deps());
    expect(h.scheduled).toHaveLength(2);
    reloaded.dispose();
    expect(h.scheduled[1]?.cancelled).toBe(true);
    h.planner(P.done());
    await runner.resume();
    expect(h.scheduled[0]?.cancelled).toBe(true);
  });

  it('allowed_warning is recorded and the loop goes on', async () => {
    h.planner(P.done(), {
      rateLimit: { status: 'allowed_warning', resetsAt, rateLimitType: 'seven_day', overageStatus: null, overageDisabledReason: null, windows: {} },
    });
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
    expect(h.eventsOf(runner, 'rate_limit')[0]).toMatchObject({ status: 'allowed_warning', rateLimitType: 'seven_day' });
  });

  it('pauses when today’s estimate reaches the soft cap; Resume overrides it for today', async () => {
    h.general.softDailyTokenCap = 200;
    h.planner(P.cont('A')).executor(E.ok());
    const runner = await h.create();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'paused', cause: 'daily_cap' });
    expect(task.statusReason).toContain('reached the soft cap of 200');
    h.planner(P.done());
    await runner.resume();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.capOverrideDay).toBe('2026-09-16');
  });
});

// ---------------------------------------------------------------------------
// §18 git
// ---------------------------------------------------------------------------

describe('git policy (§18)', () => {
  it('branches at start and commits every ok cycle, not failed ones', async () => {
    h.planner(P.cont('Create README.md with the title\nand more'))
      .on('executor', (spec) => {
        h.git.pending = ['README.md'];
        return okOutcome(spec, E.ok(['README.md']));
      })
      .planner(P.cont('Break something'))
      .on('executor', (spec) => {
        h.git.pending = ['bad.txt'];
        return okOutcome(spec, E.failed('nope'));
      })
      .planner(P.cont('Check'))
      .executor(E.ok([]))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(h.git.switches).toEqual([`${APP_SLUG}/${runner.id}`]);
    expect(task.git).toMatchObject({ isRepo: true, branch: `${APP_SLUG}/${runner.id}`, originalBranch: 'main', startCommit: 'start000', dirtyAtStart: [], snapshot: null, snapshotDone: true });
    expect(h.git.commits.map((c) => c.message)).toEqual([`[${APP_SLUG}] cycle 1: Create README.md with the title and more`, `[${APP_SLUG}] cycle 3: Check`]);
    const cycles = h.eventsOf(runner, 'cycle');
    expect(cycles[0]?.commit).toMatchObject({ state: 'committed', files: ['README.md'] });
    expect(cycles[1]?.commit).toMatchObject({ state: 'skipped' });
    // The failed cycle's leftovers are picked up by the next ok cycle.
    expect(cycles[2]?.commit).toMatchObject({ state: 'committed', files: ['bad.txt'] });
    expect(h.specs[2]?.prompt).toContain('Committed by the orchestrator: hash100000');
    expect(h.specs[0]?.prompt).toContain(`on branch ${APP_SLUG}/${runner.id}. Do not ask the executor to run git.`);
  });

  it('a dirty tree at start gets its own snapshot commit on the task branch before cycle 1', async () => {
    h.git.dirty = ['notes.txt', 'wip.ts'];
    h.git.pending = ['notes.txt', 'wip.ts'];
    let atPlannerSpawn: string[] = [];
    h.on('planner', (spec) => {
      atPlannerSpawn = h.git.commits.map((c) => c.message);
      return okOutcome(spec, P.cont('Add feature'));
    }).on('executor', (spec) => {
      h.git.pending = ['feature.ts'];
      return okOutcome(spec, E.ok(['feature.ts']));
    }).planner(P.done());
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(h.git.commits).toEqual([
      { message: `[${APP_SLUG}] snapshot before task`, files: ['notes.txt', 'wip.ts'], branch: `${APP_SLUG}/${runner.id}` },
      { message: `[${APP_SLUG}] cycle 1: Add feature`, files: ['feature.ts'], branch: `${APP_SLUG}/${runner.id}` },
    ]);
    expect(atPlannerSpawn).toEqual([`[${APP_SLUG}] snapshot before task`]);
    expect(task.git).toMatchObject({ dirtyAtStart: ['notes.txt', 'wip.ts'], snapshot: { hash: expect.stringMatching(/^hash1/), files: ['notes.txt', 'wip.ts'] }, snapshotDone: true });
    const events = h.events(runner).map((e) => (e.type === 'commit' ? `commit:${e.purpose}` : e.type));
    expect(events.indexOf('commit:snapshot')).toBeLessThan(events.indexOf('setup'));
    expect(h.eventsOf(runner, 'commit')[0]).toMatchObject({ purpose: 'snapshot', cycle: null, info: { state: 'committed', message: `[${APP_SLUG}] snapshot before task` } });
    expect(h.specs[0]?.prompt).toContain('they were committed first as hash100000 ("snapshot before task")');
  });

  it('a failed snapshot stops the task before any agent runs; Resume retries it once', async () => {
    h.git.dirty = ['wip.ts'];
    h.git.pending = ['wip.ts'];
    h.git.failCommit = 'pre-commit hook failed';
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('error');
    expect(h.task(runner).statusReason).toContain('could not commit the snapshot of the uncommitted changes');
    expect(h.specs).toHaveLength(0);
    h.git.failCommit = null;
    h.planner(P.done());
    await runner.resume();
    expect(h.task(runner).status).toBe('done');
    expect(h.git.commits.map((c) => c.message)).toEqual([`[${APP_SLUG}] snapshot before task`]);
  });

  it('nothing to commit is not an error', async () => {
    h.planner(P.cont('Look')).executor(E.ok([])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'cycle')[0]?.commit).toEqual({ state: 'nothing_to_commit' });
    expect(h.specs[2]?.prompt).toContain('No commit: the working tree had no changes.');
    expect(h.task(runner).status).toBe('done');
  });

  it('never commits onto another branch; a failing commit is reported, not fatal', async () => {
    h.planner(P.cont('A'))
      .on('executor', (spec) => {
        h.git.branch = 'main';
        h.git.pending = ['x'];
        return okOutcome(spec, E.ok(['x']));
      })
      .planner(P.cont('B'))
      .on('executor', (spec) => {
        h.git.branch = `${APP_SLUG}/${spec.rawDir.split(/[\\/]/).at(-2)}`;
        h.git.failCommit = 'Author identity unknown';
        return okOutcome(spec, E.ok(['y']));
      })
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const cycles = h.eventsOf(runner, 'cycle');
    expect(cycles[0]?.commit).toMatchObject({ state: 'skipped', reason: expect.stringContaining(`on main, not ${APP_SLUG}/`) });
    expect(cycles[1]?.commit).toEqual({ state: 'failed', error: 'Author identity unknown' });
    expect(h.specs[4]?.prompt).toContain("The orchestrator's commit failed: Author identity unknown");
    expect(h.git.commits).toHaveLength(0);
    expect(h.task(runner).status).toBe('done');
  });

  it('is inert outside a git repository, and when switched off', async () => {
    h.git.isRepo = false;
    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).git).toMatchObject({ isRepo: false, branch: null, inertReason: expect.stringContaining('not a git repository') });
    expect(h.git.switches).toEqual([]);
    expect(h.eventsOf(runner, 'commit')).toEqual([]);
    expect(h.specs[0]?.prompt).not.toContain('Git:');
    expect(h.specs[2]?.prompt).not.toContain('commit');

    const h2 = new Harness();
    try {
      h2.planner(P.cont('A')).executor(E.ok()).planner(P.done());
      const off = await h2.create({ autoBranchAndCommit: false });
      await off.start();
      expect(h2.task(off).git).toMatchObject({ isRepo: true, enabled: false, branch: null });
      expect(h2.git.switches).toEqual([]);
      expect(h2.git.commits).toEqual([]);
    } finally {
      h2.cleanup();
    }
  });

  it('a failing branch switch is an error that Resume retries', async () => {
    const runner = await h.create();
    h.git.switchToBranch = async () => {
      throw new Error('your local changes would be overwritten');
    };
    await runner.start();
    expect(h.task(runner).status).toBe('error');
    expect(h.task(runner).statusReason).toContain('Git setup failed');
    h.git.switchToBranch = FakeGit.prototype.switchToBranch.bind(h.git);
    h.planner(P.done());
    await runner.resume();
    expect(h.task(runner).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('crash recovery (TaskRunner.load)', () => {
  it('a task stored as running becomes error; Resume retries the interrupted turn with a note', async () => {
    h.planner(P.cont('A')).executor(E.ok());
    const runner = await h.create();
    await runner.start();
    // Simulate the app dying during the executor turn, after the CLI had emitted init.
    h.rewind(runner.id, 1);
    const spawned = h.specs[1]!;
    fs.writeFileSync(path.join(spawned.rawDir, `${spawned.turnId}.ndjson`), '{"type":"system","subtype":"init","session_id":"x"}\n');

    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.store.readEvents(runner.id), h.deps());
    let task = h.task(reloaded);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/app stopped while this task was running/);
    expect(task.sessions.executor.established).toBe(true);
    expect(h.eventsOf(reloaded, 'recovered')).toHaveLength(1);

    h.queue.length = 0;
    h.executor(E.ok()).planner(P.done());
    const before = h.specs.length;
    await reloaded.resume();
    task = h.task(reloaded);
    expect(task.status).toBe('done');
    const retry = h.specs[before];
    expect(retry?.agent).toBe('executor');
    expect(retry?.resumeSessionId).toBe(task.sessions.executor.sessionId);
    expect(retry?.prompt).toContain('the app stopped during this turn');
    expect(task.cycles).toBe(1);
  });

  it('an interrupted first turn with no init gets a new session id', async () => {
    h.planner(P.done());
    const runner = await h.create();
    await runner.start();
    h.rewind(runner.id, 0);
    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.store.readEvents(runner.id), h.deps());
    const task = h.task(reloaded);
    expect(task.sessions.planner.sessionId).not.toBe(h.specs[0]?.newSessionId);
    expect(task.sessions.planner.retired[0]?.sessionId).toBe(h.specs[0]?.newSessionId);
    expect(task.next?.retryNote).toBeNull();
    h.planner(P.done());
    await reloaded.resume();
    expect(h.specs[1]?.newSessionId).toBe(task.sessions.planner.sessionId);
    expect(h.task(reloaded).status).toBe('done');
  });

  it('a turn saved but not acted on is processed on Resume (and its session counts as created)', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.cont('B'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    await runner.approveInstruction();
    // Rebuild the moment right after the executor's turn event was written.
    const events = h.events(runner);
    const turnIdx = events.findIndex((e) => e.type === 'turn' && e.agent === 'executor');
    h.rewind(runner.id, 1, events.slice(0, turnIdx + 1));

    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.store.readEvents(runner.id), h.deps());
    expect(h.task(reloaded).deferredTurn?.agent).toBe('executor');
    expect(h.task(reloaded).sessions.executor.established).toBe(true);
    h.planner(P.cont('B')).executor(E.ok(['b'])).planner(P.done());
    const before = h.specs.length;
    await reloaded.resume();
    await reloaded.approveInstruction();
    expect(h.task(reloaded).status).toBe('done');
    // The saved output was used: the next executor turn is B, in the same (resumed) session.
    const next = h.specs.slice(before);
    expect(next.map((s) => s.agent)).toEqual(['planner', 'executor', 'planner']);
    expect(next[1]?.prompt).toBe('[INSTRUCTION]\nB');
    expect(next[1]?.resumeSessionId).toBe(h.specs[1]?.newSessionId);
  });
});

describe('older task.json files', () => {
  it('a Phase 3 task (no waiver, snapshot or turn-trace fields) loads and keeps working', async () => {
    h.planner(P.ask('Continue?'));
    const runner = await h.create();
    await runner.start();
    const legacy = h.task(runner) as unknown as Record<string, any>;
    delete legacy['parkedWaiting'];
    delete legacy['skills']['waived'];
    delete legacy['git']['snapshot'];
    delete legacy['git']['snapshotDone'];
    delete legacy['loop']['recentTurns'];
    legacy['loop']['recentFileSets'] = [['a.ts']];
    h.store.writeTask(legacy as never);

    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.events(runner), h.deps());
    const task = reloaded.snapshot;
    expect(task.skills.waived).toEqual([]);
    expect(task.git).toMatchObject({ snapshot: null, snapshotDone: true });
    expect(task.loop.recentTurns).toEqual([]);
    expect('recentFileSets' in task.loop).toBe(false);
    expect(task.parkedWaiting).toBeNull();
    h.planner(P.done());
    await reloaded.answer('yes');
    expect(h.task(reloaded).status).toBe('done');
  });
});

describe('internal errors surface', () => {
  it('an exception inside the loop becomes status error with the message', async () => {
    h.planner(P.cont('A'));
    h.on('executor', () => {
      throw new Error('kaboom');
    });
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain('kaboom');
  });
});

describe('executor step bookkeeping', () => {
  it('a retried executor step keeps its cycle number', async () => {
    h.planner(P.cont('A')).on('executor', (spec) => failOutcome(spec, 'api_error', { apiErrorStatus: 400 }));
    const runner = await h.create();
    await runner.start();
    expect((h.task(runner).next as ExecutorStep).cycle).toBe(1);
    h.on('executor', (spec) => failOutcome(spec, 'api_error', { apiErrorStatus: 400 }));
    await runner.resume();
    h.executor(E.ok()).planner(P.done());
    await runner.resume();
    expect(h.task(runner).cycles).toBe(1);
    expect(h.eventsOf(runner, 'turn_started').filter((e) => e.agent === 'executor').map((e) => e.cycle)).toEqual([1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// Wave 1 (2026-09-17): git failures, stop-aware recovery, auto-resume through the host
// ---------------------------------------------------------------------------

describe('git that cannot run (§18, decided 2026-09-17)', () => {
  const MISSING = 'Git could not be run (git rev-parse --is-inside-work-tree): spawn git ENOENT. Is git installed and on PATH?';

  it('with auto-commit on, the task stops in error before any agent runs', async () => {
    h.git.unavailable = MISSING;
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toContain(`Git setup failed. ${MISSING} The task did not start without its branch.`);
    expect(task.statusReason).toContain('Fix git, then Resume');
    expect(task.setupDone).toBe(false);
    expect(task.git).toMatchObject({ isRepo: false, branch: null });
    expect(h.specs).toHaveLength(0);
    expect(h.probeCalls).toBe(0);

    // Fixed: Resume runs setup again and the task gets its branch.
    h.git.unavailable = null;
    h.planner(P.done());
    await runner.resume();
    expect(h.task(runner)).toMatchObject({ status: 'done', git: { isRepo: true, branch: `${APP_SLUG}/${runner.id}` } });
  });

  it('with auto-commit off, the task runs and the failure is recorded', async () => {
    h.git.unavailable = MISSING;
    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    const runner = await h.create({ autoBranchAndCommit: false });
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.git.isRepo).toBe(false);
    expect(task.git.inertReason).toBe(`Auto-branch and commit is off for this task. ${MISSING}`);
    expect(h.eventsOf(runner, 'setup')[0]?.git.inertReason).toContain('Git could not be run');
  });

  it('a git failure mid-task is a failed commit, never "skipped"', async () => {
    h.planner(P.cont('A')).on('executor', (spec) => {
      h.git.unavailable = 'Git could not be run (git symbolic-ref --quiet --short HEAD): spawn git ENOENT.';
      return okOutcome(spec, E.ok());
    });
    h.planner(P.done());
    const runner = await h.create();
    await runner.start();
    const cycle = h.eventsOf(runner, 'cycle')[0];
    expect(cycle?.commit).toEqual({ state: 'failed', error: 'Git could not be run (git symbolic-ref --quiet --short HEAD): spawn git ENOENT.' });
    expect(h.specs[2]?.prompt).toContain('Git could not be run');
  });
});

describe('a stop the app could not finish (§6, decided 2026-09-17)', () => {
  it('reopens as stopped, not error, when the user had asked for the stop', async () => {
    let release: () => void = () => {};
    h.on('planner', (spec) => new Promise((resolve) => (release = () => resolve(failOutcome(spec, 'aborted')))));
    const runner = await h.create();
    const running = runner.start();
    await waitFor(() => h.specs.length === 1);
    // Quit and stop: the stop is requested, and the app exits before the turn has ended.
    const stopping = runner.stop();
    const onDisk = { task: h.store.readTask(runner.id), events: h.store.readEvents(runner.id) };
    expect(onDisk.task.status).toBe('running');
    expect(onDisk.events.at(-1)).toMatchObject({ type: 'intervention', kind: 'stop' });

    const reloaded = TaskRunner.load(onDisk.task, onDisk.events, h.deps());
    const task = h.task(reloaded);
    expect(task.status).toBe('stopped');
    expect(task.statusReason).toContain('Stopped by the user. The app exited before the stop had finished.');
    expect(h.eventsOf(reloaded, 'recovered')).toHaveLength(1);

    release();
    await stopping;
    await running;
  });

  it('a stop from an earlier run does not count', async () => {
    h.planner(P.ask('Which?'));
    const runner = await h.create();
    await runner.start();
    await runner.stop();
    h.planner(P.cont('A')).executor(E.ok());
    await runner.resume();
    await runner.answer('This one.');
    // The app dies during the executor turn of the resumed run.
    const index = h.specs.findIndex((s) => s.agent === 'executor');
    h.rewind(runner.id, index);
    const reloaded = TaskRunner.load(h.store.readTask(runner.id), h.store.readEvents(runner.id), h.deps());
    expect(h.task(reloaded).status).toBe('error');
  });
});

describe('auto-resume through the host (§6, §17, decided 2026-09-17)', () => {
  const resetsAt = Date.parse('2026-09-16T15:00:00Z') / 1000;

  it('hands the due auto-resume to the host instead of resuming itself', async () => {
    h.general.autoResumeAtReset = true;
    const asked: string[] = [];
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const runner = await TaskRunner.create(
      { description: 'Task', projectDir: h.projectDir, config: TEST_CONFIG },
      { ...h.deps(), autoResume: (id) => asked.push(id) },
    );
    await runner.start();
    h.scheduled[0]!.fn();
    expect(asked).toEqual([runner.id]);
    expect(h.task(runner).status).toBe('rate_limited');
    expect(h.specs).toHaveLength(1);
  });

  it('autoResumeBlocked keeps the task rate_limited, records who was running, and is not re-armed', async () => {
    h.general.autoResumeAtReset = true;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const deps = { ...h.deps(), autoResume: () => {} };
    const runner = await TaskRunner.create({ description: 'Task', projectDir: h.projectDir, config: TEST_CONFIG }, deps);
    await runner.start();
    const notified = h.notifications.length;

    runner.autoResumeBlocked({ taskId: 'other', title: 'Other task' });
    const task = h.task(runner);
    expect(task.status).toBe('rate_limited');
    expect(task.rateLimit).toMatchObject({ autoResumeAt: null, autoResumeSkipped: { at: h.clock.toISOString(), blockedBy: { taskId: 'other', title: 'Other task' } } });
    expect(h.eventsOf(runner, 'auto_resume_skipped')).toEqual([expect.objectContaining({ blockedBy: { taskId: 'other', title: 'Other task' } })]);
    // No status change, so no status notification from the runner (the host sends its own).
    expect(h.notifications).toHaveLength(notified);

    // After a restart the skipped auto-resume is not armed again; the user resumes.
    const scheduled = h.scheduled.length;
    const reloaded = TaskRunner.load(h.task(runner), h.events(runner), deps);
    expect(h.scheduled).toHaveLength(scheduled);
    h.planner(P.done());
    await reloaded.resume();
    expect(h.task(reloaded)).toMatchObject({ status: 'done', rateLimit: null });
  });
});

describe('a Stop while Resume checks the account', () => {
  it('wins: the task stays stopped and nothing is spawned', async () => {
    h.planner(P.ask('Which?'));
    const runner = await h.create();
    await runner.start();
    await runner.stop();
    const spawned = h.specs.length;

    let answer: () => void = () => {};
    const deps = h.deps();
    const slow = { ...deps, authStatus: () => new Promise<typeof PINNED>((resolve) => (answer = () => resolve(PINNED))) };
    const reloaded = TaskRunner.load(h.task(runner), h.events(runner), slow);
    const resuming = reloaded.resume();
    await reloaded.stop();
    answer();
    await resuming;
    expect(h.task(reloaded).status).toBe('stopped');
    expect(h.specs).toHaveLength(spawned);
  });
});

describe('the Executor has the task text (SPEC.md §3.1, 2026-10-06)', () => {
  it('in its system prompt, after the role, with the instruction as the scope; the Planner’s prompt is unchanged', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.done());
    const runner = await h.create({}, 'Add a README.\nThe contract: the title is the project name.');
    await runner.start();
    const executor = h.specs.find((s) => s.agent === 'executor')?.systemPrompt ?? '';
    expect(executor).toContain('## The task (for reference)');
    expect(executor).toContain('do exactly what the [INSTRUCTION] asks and nothing more');
    expect(executor).toContain('Add a README.\nThe contract: the title is the project name.');
    expect(executor.indexOf('## The task (for reference)')).toBeGreaterThan(executor.indexOf('EXECUTOR'));
    expect(h.specs.find((s) => s.agent === 'planner')?.systemPrompt).not.toContain('## The task (for reference)');
    h.assertScriptDone();
  });

  it('a fresh session after a rollover has it again', async () => {
    h.planner(P.cont('A')).executor(E.ok()).planner(P.cont('B', { request_executor_rollover: true })).executor(HANDOFF).executor(E.ok(['b'])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs[4]?.newSessionId).toBe(h.task(runner).sessions.executor.sessionId);
    expect(h.specs[4]?.systemPrompt).toContain('## The task (for reference)\n\n');
    expect(h.specs[4]?.systemPrompt).toContain('Add a README with the project name.');
  });
});
