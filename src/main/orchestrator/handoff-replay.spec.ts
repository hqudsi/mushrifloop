/**
 * The Step C failure, replayed from the real raw file (NOTES.md §25–§26).
 *
 * `__fixtures__/handoff-refused-windows-paths.ndjson` is the stream of a real bench turn (long-py-M-cheap-1,
 * 2026-09-17T23:14): the Executor was asked for a handoff summary, the CLI refused five answers as invalid
 * JSON, and the turn ended with `structured_output_retry_exhausted`. Before the fix that cost the whole task;
 * here the same stream must leave the task running.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SchemaRegistry } = await import('../schema-validator');
const { classifyTurn } = await import('../session-runner/classify');
const { TurnAccumulator } = await import('../session-runner/stream');
const { E, Harness, P } = await import('./__tests__/harness');
const { posixPath } = await import('../../shared/format');

import type { TurnOutcome, TurnSpec } from '../session-runner/types';

const REPO = path.resolve(__dirname, '..', '..', '..');
const schemas = SchemaRegistry.load(path.join(REPO, 'schemas'));
const fixture = (name: string) => fs.readFileSync(path.join(REPO, 'src', 'main', 'session-runner', '__fixtures__', name), 'utf8');
const RAW = fixture('handoff-refused-windows-paths.ndjson');
/**
 * A real Executor instruction turn that died the same way (2026-09-17). The project's own names and text
 * are replaced with made-up ones; the events, the refusals and the field shapes are as recorded.
 */
const RAW_INSTRUCTION = fixture('instruction-refused-paste.ndjson');
/**
 * The same handoff failure on a clean node project with no Windows paths at all, captured on 2026-09-18
 * *after* the path fix of §26 (NOTES.md §27.6, probe arm S). It is the control that rules paths and length
 * out and leaves the field shape as the cause.
 */
const RAW_LIST_FIELDS = fixture('handoff-refused-list-fields.ndjson');

/** Every answer the model tried that the tool could not parse, as the CLI recorded it. */
function refusedAttempts(raw: string): Array<{ text: string; length: number }> {
  const out: Array<{ text: string; length: number }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      const input = block.input as { __unparsedToolInput?: { raw?: string; len?: number } } | undefined;
      const unparsed = input?.__unparsedToolInput;
      if (unparsed?.raw) out.push({ text: unparsed.raw, length: unparsed.len ?? unparsed.raw.length });
    }
  }
  return out;
}

/** `"done_so_far": ` followed by anything that is not `[` or `"` — a paragraph where a list belongs. */
const PROSE_IN_A_LIST_FIELD = /"done_so_far"\s*:\s*(?!\[|")/;

/** The real stream, classified exactly as a live turn would be. */
function replayOutcome(spec: TurnSpec, raw = RAW): TurnOutcome {
  const acc = new TurnAccumulator();
  for (const line of raw.split('\n')) if (line.trim()) acc.addLine(line);
  return classifyTurn(
    {
      turnId: spec.turnId ?? 'replayed',
      agent: spec.agent,
      sessionId: spec.resumeSessionId ?? spec.newSessionId ?? 'replayed',
      resumed: spec.resumeSessionId !== undefined,
      startedAt: '2026-09-17T23:14:28.657Z',
      durationMs: 60_000,
      rawPath: 'raw/replayed.ndjson',
      stderrPath: 'raw/replayed.stderr',
      systemPromptPath: 'raw/replayed.system.md',
      args: ['-p'],
      requestedModel: 'haiku',
      previousTotals: spec.previousTotals ?? null,
      schema: spec.schema,
    },
    acc,
    { exitCode: 1, spawnError: null, timedOut: false, aborted: false, timeoutMs: 1_200_000, stderrTail: '', stdoutTail: '', slow: false, slowTurnMs: null, processes: null },
    schemas,
  );
}

let h: InstanceType<typeof Harness>;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.cleanup();
});

/**
 * The recording is a handoff asked for the old way, with `--json-schema` set to `handoff-summary`. Since
 * 2026-10-06 an Executor with Write writes its handoff to a file instead (SPEC.md §15); the old way is still
 * what an Executor without Write gets, so the replay runs on that configuration.
 */
const OLD_WAY = { executorTools: ['Read', 'Edit', 'Bash', 'Skill'] };

describe('the real refused handoff (Step C, long-py-M-cheap-1)', () => {
  it('is read as a turn that ended without an answer, with the CLI’s five refusals', () => {
    const outcome = replayOutcome({ agent: 'executor', schema: 'handoff-summary', turnId: 't' } as TurnSpec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('structured_output_failed');
    expect(outcome.answerRejections.count).toBe(5);
    expect(outcome.answerRejections.reasons.join(' ')).toContain('could not be parsed as JSON');
    // The last attempt gave up on the fields themselves, which is why repeating the request was useless.
    expect(outcome.answerRejections.reasons.join(' ')).toContain("must have required property 'task_restatement'");
    // The CLI names the cause the fix addresses; the stored reasons are clipped, so read it in the raw stream.
    expect(RAW).toMatch(/unescaped backslashes in file paths \(use \/ or/i);
    // The answers were far too big as well: 3.5–5.2 KB per attempt (SPEC.md §4).
    expect(RAW).toMatch(/first 200 of 5216 bytes/);
  });

  it('no longer kills the task: one shorter request, then the session is kept and the work goes on', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => replayOutcome(spec)) // the handoff, refused as it really was
      .on('executor', (spec) => replayOutcome(spec)) // the shorter request, refused too
      .executor(E.ok(['b'])) // instruction B runs in the session that was kept
      .planner(P.done());
    const runner = await h.create(OLD_WAY);
    const sessionBefore = h.task(runner).sessions.executor.sessionId;
    await runner.start();

    const task = h.task(runner);
    expect(task.status).toBe('done');
    expect(h.statuses(runner)).toEqual(['running', 'done']);

    // Two handoff turns: the request, then the shorter one.
    const handoffs = h.specs.filter((s) => s.schema === 'handoff-summary');
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]?.prompt).toContain('If the tool refuses your answer, send the same content again');
    expect(handoffs[1]?.prompt).toContain('keep this one small: at most four items per list, one short sentence each, at most five key_files');

    // The session survived, with its history, and nothing was retired.
    expect(task.sessions.executor.sessionId).toBe(sessionBefore);
    expect(task.sessions.executor.retired).toEqual([]);
    expect(task.sessions.executor.rolloverRequested).toBeNull();
    expect(task.sessions.executor.rolloverBlocked).toMatchObject({ reason: expect.stringContaining('structured_output_failed') });

    // It is recorded, and the Planner is told before it plans again.
    expect(h.eventsOf(runner, 'rollover_skipped')).toMatchObject([{ agent: 'executor', attempts: 2 }]);
    const plannerAfter = h.specs.filter((s) => s.agent === 'planner').at(-1);
    expect(plannerAfter?.prompt).toContain("The executor's session was NOT replaced");
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(0);
    h.assertScriptDone();
  });

  it('does not try the rollover again for that session', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', (spec) => replayOutcome(spec))
      .on('executor', (spec) => replayOutcome(spec))
      .executor(E.ok(['b']))
      .planner(P.cont('C'))
      .executor(E.ok(['c'])) // no third handoff before this one
      .planner(P.done());
    const runner = await h.create(OLD_WAY);
    await runner.start();
    expect(h.specs.filter((s) => s.schema === 'handoff-summary')).toHaveLength(2);
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });
});

describe('the real refused instruction turn (a read-only task that asked for markup)', () => {
  it('is asked again differently instead of ending the task', async () => {
    h.planner(P.cont('Paste the markup of the overview card'))
      .on('executor', (spec) => replayOutcome(spec, RAW_INSTRUCTION))
      .executor(E.ok([], { summary: 'Read the view. The lines are in evidence.', evidence: 'Views/Shipments/Details.cshtml:372  <div class="card overview">' }))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();

    const outcome = replayOutcome({ agent: 'executor', schema: 'executor-output', turnId: 't' } as TurnSpec);
    expect(outcome.ok).toBe(false);
    // Five refusals: the first for invalid JSON, then four for missing fields — the same answer each time.
    expect(RAW_INSTRUCTION).toContain('could not be parsed as JSON');
    expect(RAW_INSTRUCTION).toMatch(/must have required property 'changed_files'/);

    const retried = h.specs.filter((s) => s.agent === 'executor')[1]?.prompt ?? '';
    expect(retried).toContain('answer SHORT: summary in 2-3 sentences, any exact text in evidence');
    expect(retried).toContain('[INSTRUCTION]\nPaste the markup of the overview card');
    expect(h.eventsOf(runner, 'answer_retry')).toMatchObject([{ attempt: 1, variation: 'short_answer', refusals: 5 }]);
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });
});

describe('why the handoffs were refused: a paragraph where a list belongs (NOTES.md §27.6)', () => {
  it('every refused attempt in both real streams breaks at the first list field', () => {
    for (const [name, raw] of [
      ['Step C, long-py-M-cheap-1', RAW],
      ['the 2026-09-18 probe, node-app', RAW_LIST_FIELDS],
    ] as const) {
      const attempts = refusedAttempts(raw);
      expect(attempts.length, `${name}: no refused attempts in the fixture`).toBeGreaterThan(0);
      for (const attempt of attempts) {
        expect(attempt.text, `${name}: an attempt did not break at done_so_far`).toMatch(PROSE_IN_A_LIST_FIELD);
        // task_restatement, the one real text field, is written correctly in the same answer.
        expect(attempt.text).toMatch(/"task_restatement"\s*:\s*"/);
      }
    }
  });

  it('is not about Windows paths: the control stream has none and fails the same way', () => {
    expect(RAW_LIST_FIELDS).not.toMatch(/[A-Za-z]:\\\\/);
    expect(RAW_LIST_FIELDS).not.toMatch(/\.venv\\\\/);
    expect(refusedAttempts(RAW_LIST_FIELDS)).toHaveLength(5);
  });

  it('is not about length: the attempts that break this way range from small to very large', () => {
    const lengths = [...refusedAttempts(RAW), ...refusedAttempts(RAW_LIST_FIELDS)].map((a) => a.length);
    expect(Math.min(...lengths)).toBeLessThan(5_000);
    expect(Math.max(...lengths)).toBeGreaterThan(8_000);
  });

  it('the shape the prompt now asks for is the shape that was accepted in the two handoffs that worked', () => {
    // Step C, long-py-M-default-1: the only two handoffs the tool accepted both sent lists.
    expect(schemas.validate('handoff-summary', {
      task_restatement: 'Round currency to cents in the ledger CLI.',
      done_so_far: ['Read ledger/commands/expenses.py and confirmed --amount used type=float'],
      remaining: ['Run the full suite'],
      decisions: ['Store cents as integers'],
      constraints: ['Do not change the CSV format'],
      open_problems: [],
      key_files: ['ledger/commands/expenses.py'],
    }).ok).toBe(true);
  });
});

describe('the paths that broke those answers', () => {
  it('are normalised wherever the app hands one back to an agent', () => {
    // The paths the Step C agents wrote into their handoffs, verbatim.
    expect(posixPath('C:\\Users\\user\\AppData\\Local\\Temp\\work\\run-1\\project')).toBe(
      'C:/Users/user/AppData/Local/Temp/work/run-1/project',
    );
    expect(posixPath('.venv\\Scripts\\python')).toBe('.venv/Scripts/python');
    expect(posixPath('ledger/commands/expenses.py')).toBe('ledger/commands/expenses.py');
  });
});
