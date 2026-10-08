/**
 * The timeline folds real event sequences — produced by running the orchestrator against the scripted
 * fake runner — into cards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from './app-config';
import { E, HANDOFF, Harness, P, failOutcome, okOutcome, waitFor } from '../main/orchestrator/__tests__/harness';
import { ROLLOVER_HINT, buildTimeline, describeConfigChange, runningTurn, type TimelineItem } from './timeline';
import { activityFromEvents, applyActivityEvent, emptyActivity, relativePath, summarizeTool } from './turn-activity';
import type { LiveTurnEvent } from './task-model';

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.cleanup();
});

const kinds = (items: TimelineItem[]) => items.map((i) => (i.kind === 'cycle' ? `cycle${i.cycle}` : i.kind));

describe('renaming in the timeline (SPEC.md §10)', () => {
  it('notes each rename, and says the description was not touched', async () => {
    const runner = await h.create();
    runner.rename('Layout fixes');
    runner.rename('');
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    expect(notes.map((n) => (n.kind === 'note' ? n.title : ''))).toEqual(['Renamed to “Layout fixes”', 'Name removed']);
    const last = notes.at(-1);
    expect(last?.kind === 'note' ? last.text : null).toContain('description again, which was never changed');
  });
});

describe('archiving in the timeline (SPEC.md §10)', () => {
  it('notes archive and unarchive, and nothing for a pin', async () => {
    const runner = await h.create();
    runner.setPinned(true);
    runner.setArchived(true);
    runner.setArchived(false);
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    expect(notes.map((n) => (n.kind === 'note' ? n.title : ''))).toEqual(['Archived', 'Unarchived']);
    const first = notes[0];
    expect(first?.kind === 'note' ? first.text : null).toContain('Nothing was deleted');
  });
});

describe('describeConfigChange (SPEC.md §6)', () => {
  it('says what changed and, for a model, which way it was applied', () => {
    const same = describeConfigChange([
      { field: 'maxCycles', from: 25, to: 30 },
      { field: 'model', agent: 'executor', from: { model: 'sonnet', effort: 'high' }, to: { model: 'claude-opus-5-5', effort: 'medium' }, apply: 'same_session' },
    ]);
    expect(same.title).toBe('Task settings changed: max cycles 25 → 30; Executor sonnet high → claude-opus-5-5 medium');
    expect(same.detail).toContain('same conversation');
    expect(same.detail).toContain('without the cache');
    expect(same.detail).toContain('The other changes apply from the next cycle.');

    const fresh = describeConfigChange([
      { field: 'model', agent: 'planner', from: { model: 'opus', effort: 'xhigh' }, to: { model: 'claude-opus-5', effort: 'high' }, apply: 'fresh_session' },
    ]);
    expect(fresh.detail).toContain('fresh session');
    expect(fresh.detail).toContain('handoff on the old model');

    const first = describeConfigChange([
      { field: 'model', agent: 'planner', from: { model: 'opus', effort: 'xhigh' }, to: { model: 'haiku', effort: null }, apply: 'first_session' },
    ]);
    expect(first.detail).toContain('no session yet');
  });

  it('names the turn limits in minutes and says a running turn keeps its own', () => {
    const d = describeConfigChange([
      { field: 'turnTimeoutMs', from: 20 * 60_000, to: 60 * 60_000 },
      { field: 'slowTurnMs', from: 5 * 60_000, to: 30 * 60_000 },
      { field: 'maxTurnsPerSession', from: 40, to: 80 },
      { field: 'freshExecutorAfterRejectedTurns', from: null, to: 2 },
    ]);
    expect(d.title).toBe(
      'Task settings changed: turn timeout 20 → 60 min; slow-turn warning 5 → 30 min; max steps per turn 40 → 80; fresh Executor session after rejected answers off → after 2',
    );
    expect(d.detail).toBe('Applies from the next cycle. A turn already running keeps the limits it started with.');
  });

  it('keeps settings-only changes short', () => {
    expect(describeConfigChange([{ field: 'autoBranchAndCommit', from: true, to: false }])).toEqual({
      title: 'Task settings changed: auto-commit off',
      detail: 'Applies from the next cycle.',
    });
    expect(describeConfigChange([{ field: 'requiredSkills', from: [], to: ['security-review'] }]).title).toBe(
      'Task settings changed: required skills none → security-review',
    );
  });
});

describe('buildTimeline', () => {
  it('a card carries the effort it ran at and any second model that served part of it (SPEC.md §8)', async () => {
    h.planner(P.cont('Review the change'))
      .executor(E.ok([]), {
        model: {
          requested: 'claude-opus-5-5',
          announced: 'claude-opus-5-5',
          served: 'claude-opus-5-5',
          canonical: 'claude-opus-5-5',
          contextWindow: 1_000_000,
          matches: true,
          cliVersion: '2.1.280',
          alsoServed: ['claude-opus-4-8'],
        },
      })
      .planner(P.done('Reviewed.'));
    const runner = await h.create({ executor: { model: 'claude-opus-5-5', effort: 'medium' } });
    await runner.start();
    const cycle = buildTimeline(h.events(runner), false).find((i) => i.kind === 'cycle');
    if (cycle?.kind !== 'cycle') throw new Error('no cycle');
    expect(cycle.executor).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', servedModel: 'claude-opus-5-5', modelMismatch: false, alsoServed: ['claude-opus-4-8'] });
  });

  it('start → cycles (planner instruction + executor turn) → final report', async () => {
    h.git.dirty = ['wip.txt'];
    h.git.pending = ['wip.txt'];
    h.planner(P.cont('Create README.md'))
      .executor(E.ok(['README.md']), { durationMs: 20_000 })
      .planner(P.cont('Run it'))
      .executor(E.ok([]))
      .planner(P.done('Finished.'));
    const runner = await h.create();
    await runner.start();
    const items = buildTimeline(h.events(runner), false);
    expect(kinds(items)).toEqual(['start', 'cycle1', 'cycle2', 'planner', 'final']);

    const start = items[0];
    if (start?.kind !== 'start') throw new Error('no start');
    expect(start.description).toBe('Add a README with the project name.');
    expect(start.setup).toMatchObject({ branch: `${APP_SLUG}/${runner.id}`, originalBranch: 'main', skills: 1, hasRemote: false });
    expect(start.snapshot).toMatchObject({ message: `[${APP_SLUG}] snapshot before task`, files: ['wip.txt'] });

    const cycle1 = items[1];
    if (cycle1?.kind !== 'cycle') throw new Error('no cycle');
    expect(cycle1.planner?.output?.next_instruction).toBe('Create README.md');
    expect(cycle1.planner?.state).toBe('ok');
    expect(cycle1.executor).toMatchObject({ state: 'ok', durationMs: 20_000, output: { status: 'ok' } });
    expect(cycle1.executor.summary).toMatchObject({ cycle: 1, changedFiles: [expect.stringMatching(/^readme.md$/i)], commit: { state: 'nothing_to_commit' } });
    expect(cycle1.at).toBe(cycle1.planner?.startedAt);

    // The last planner turn (done) stays a standalone card before the final report.
    const last = items[3];
    expect(last?.kind === 'planner' && last.card.output?.status).toBe('done');
    expect(items[4]).toMatchObject({ kind: 'final', report: 'Finished.' });
    expect(runningTurn(items)).toBeNull();
  });

  it('a question is a planner card; the answer is a user card; loop and waiver notes appear in order', async () => {
    h.planner(P.ask('Which port?'));
    const runner = await h.create({ requiredSkills: ['security-review'] });
    await runner.start();
    h.planner(P.done('ok'));
    await runner.answer('8080');
    await runner.waiveSkill('security-review', 'no remote');
    const items = buildTimeline(h.events(runner), false);
    expect(kinds(items)).toEqual(['start', 'planner', 'user', 'planner', 'note', 'note', 'final']);
    expect(items[1]).toMatchObject({ kind: 'planner', card: { output: { status: 'needs_user', question: 'Which port?' } } });
    expect(items[2]).toMatchObject({ kind: 'user', title: 'You → Planner · answer', text: '8080' });
    expect(items[4]).toMatchObject({ kind: 'note', tone: 'wait', title: 'A required skill cannot run here' });
    expect(items[5]).toMatchObject({ kind: 'note', tone: 'success', title: 'You waived security-review for this task' });
  });

  it('messages, retries, rollovers and errors', async () => {
    let runner: Awaited<ReturnType<Harness['create']>> | undefined;
    h.planner(P.cont('Build'), { usage: { contextTokens: 900_000, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1, costUsd: 0, modelUsage: {}, sessionCostUsd: 0, sessionModelUsage: {} } })
      .on('executor', (spec) => failOutcome(spec, 'timeout', { message: 'too slow' }));
    runner = await h.create();
    await runner.start();
    // SPEC.md §4/§6: a message on an errored task goes to the Planner and reopens the task itself.
    h.planner(HANDOFF).planner(P.cont('Build again')).on('executor', (spec) => okOutcome(spec, E.ok([]))).planner(P.done());
    await runner.sendMessage('Try the fast path.');
    // Reopening a task always shows its first instruction for approval (SPEC.md §7).
    await runner.approveInstruction();
    const items = buildTimeline(h.events(runner), false);
    expect(kinds(items)).toEqual(['start', 'cycle1', 'note', 'user', 'handoff', 'cycle2', 'planner', 'final']);
    const failedCycle = items[1];
    if (failedCycle?.kind !== 'cycle') throw new Error('no first cycle');
    expect(failedCycle.executor).toMatchObject({ state: 'failed', error: { kind: 'timeout' } });
    const retryCycle = items[5];
    if (retryCycle?.kind !== 'cycle') throw new Error('no second cycle');
    expect(retryCycle.executor.state).toBe('ok');
    // The message went to the Planner, which turned it into the next instruction (SPEC.md §6).
    expect(items[3]).toMatchObject({ kind: 'user', text: 'Try the fast path.' });
    expect(items[4]).toMatchObject({ kind: 'handoff', agent: 'planner', card: { state: 'ok' }, rollover: { summary: HANDOFF } });
    expect(items[2]).toMatchObject({ kind: 'note', tone: 'danger', title: 'Stopped with an error' });
  });

  it('a turn without a result is running while the task is busy, interrupted otherwise', async () => {
    h.planner(P.cont('A'));
    const runner = await h.create();
    await runner.start();
    h.rewind(runner.id, 0);
    const events = h.store.readEvents(runner.id);
    expect(runningTurn(buildTimeline(events, true))).toMatchObject({ agent: 'planner' });
    const idle = buildTimeline(events, false);
    expect(runningTurn(idle)).toBeNull();
    expect(idle[1]).toMatchObject({ kind: 'planner', card: { state: 'interrupted' } });
  });
});

describe('turn activity', () => {
  const dir = 'C:\\proj';
  const events: LiveTurnEvent[] = [
    { kind: 'init', sessionId: 's', model: 'm', tools: [], skills: [], slashCommands: [], permissionMode: null, cwd: dir, cliVersion: '2.1.273' },
    { kind: 'text', text: 'Looking around.' },
    { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls -la\necho more' } },
    { kind: 'tool_result', toolUseId: 't1', isError: false, content: 'a.txt\nb.txt' },
    { kind: 'tool_use', toolUseId: 't2', name: 'Write', input: { file_path: 'C:\\Proj\\src\\a.ts', content: 'x' } },
    { kind: 'tool_result', toolUseId: 't2', isError: false, content: 'File created' },
    { kind: 'tool_use', toolUseId: 't3', name: 'Grep', input: { pattern: 'TODO', path: 'C:\\proj\\src' }, parentToolUseId: 'x' },
    { kind: 'tool_use', toolUseId: 't4', name: 'Edit', input: { file_path: 'D:\\other\\b.ts' } },
    { kind: 'tool_result', toolUseId: 't4', isError: true, content: 'String not found' },
    { kind: 'tool_use', toolUseId: 't5', name: 'StructuredOutput', input: {} },
    { kind: 'slow_turn', elapsedMs: 301_000, thresholdMs: 300_000 },
    { kind: 'result', subtype: 'success', isError: false },
  ];

  it('rows, tool calls and files touched', () => {
    const a = activityFromEvents(events, dir);
    expect(a.toolCalls).toBe(3);
    expect(a.filesTouched).toEqual(['src/a.ts', 'D:/other/b.ts']);
    expect(a.seq).toBe(events.length);
    expect(a.rows.map((r) => [r.kind, r.tool, r.summary, r.output, r.isError, r.pending, r.subagent])).toEqual([
      ['text', null, 'Looking around.', null, false, false, false],
      ['tool', 'Bash', '$ ls -la …', 'a.txt\nb.txt', false, false, false],
      ['tool', 'Write', 'src/a.ts', null, false, false, false],
      ['tool', 'Grep', '"TODO" src', null, false, false, true],
      ['tool', 'Edit', 'D:/other/b.ts', 'String not found', true, false, false],
      ['notice', null, 'Slow turn: still running after 301 s', null, false, false, false],
    ]);
  });

  it('applying one event at a time gives the same result and never mutates the input', () => {
    let a = emptyActivity();
    for (const e of events) {
      const before = JSON.stringify(a);
      const next = applyActivityEvent(a, e, dir);
      expect(JSON.stringify(a)).toBe(before);
      a = next;
    }
    expect(a).toEqual(activityFromEvents(events, dir));
  });

  it('keeps at most 400 rows', () => {
    const many: LiveTurnEvent[] = Array.from({ length: 450 }, (_, i) => ({ kind: 'text', text: `line ${i}` }));
    const a = activityFromEvents(many, null);
    expect(a.rows).toHaveLength(400);
    expect(a.dropped).toBe(50);
    expect(a.rows[0]?.summary).toBe('line 50');
  });

  it('summaries and paths', () => {
    expect(relativePath('C:\\proj\\x\\y.ts', 'C:\\proj\\')).toBe('x/y.ts');
    expect(relativePath('C:\\projects\\y.ts', 'C:\\proj')).toBe('C:/projects/y.ts');
    expect(summarizeTool('Glob', { pattern: '**/*.ts', path: 'C:\\proj\\src' }, 'C:\\proj')).toBe('**/*.ts in src');
    expect(summarizeTool('Skill', { skill: 'security-review' }, null)).toBe('security-review');
    expect(summarizeTool('PowerShell', { command: 'Get-ChildItem' }, null)).toBe('$ Get-ChildItem');
    expect(summarizeTool('Mystery', { a: 1 }, null)).toBe('{"a":1}');
  });
});

describe('buildTimeline — approval modes', () => {
  it('review: a rejected instruction stays a Planner card; an edited approval shows on the cycle it became', async () => {
    h.planner(P.cont('Delete everything'))
      .planner(P.cont('Create README.md'))
      .executor(E.ok(['README.md']))
      .planner(P.done());
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    await runner.rejectInstruction('Too broad.');
    await runner.approveInstruction('Create README.md with a title.');
    const items = buildTimeline(h.events(runner), false);
    expect(kinds(items)).toEqual(['start', 'planner', 'user', 'cycle1', 'planner', 'final']);
    expect(items[1]).toMatchObject({ kind: 'planner', card: { output: { status: 'continue', next_instruction: 'Delete everything' } } });
    expect(items[2]).toMatchObject({ kind: 'user', title: 'You rejected the instruction', text: 'Too broad.' });
    const cycle = items[3];
    if (cycle?.kind !== 'cycle') throw new Error('no cycle');
    expect(cycle.planner?.output?.next_instruction).toBe('Create README.md');
    expect(cycle.approval).toMatchObject({ edited: true, text: 'Create README.md with a title.' });
    // No "waiting for approval" notes: the Planner card and the approval card carry that state.
    expect(items.some((i) => i.kind === 'note')).toBe(false);
  });

  it('plan_first: the plan is a Planner card, the decision a user card; cycles carry no approval', async () => {
    h.planner(P.plan('1. Write it.'))
      .planner(P.cont('Write it'))
      .executor(E.ok(['a.txt']))
      .planner(P.done());
    const runner = await h.create({ approvalMode: 'plan_first' });
    await runner.start();
    await runner.approvePlan('1. Write it carefully.');
    const items = buildTimeline(h.events(runner), false);
    expect(kinds(items)).toEqual(['start', 'planner', 'user', 'cycle1', 'planner', 'final']);
    expect(items[2]).toMatchObject({ kind: 'user', title: 'You approved an edited plan', text: '1. Write it carefully.' });
    const cycle = items[3];
    expect(cycle?.kind === 'cycle' && cycle.approval).toBeNull();
  });
});

describe('buildTimeline — usage warnings', () => {
  it('notes an approaching limit once per window, not after every turn', async () => {
    const warning = { status: 'allowed_warning', resetsAt: null, rateLimitType: 'five_hour', overageStatus: null, overageDisabledReason: null, windows: {} };
    h.planner(P.cont('A'), { rateLimit: warning })
      .executor(E.ok(['a']), { rateLimit: warning })
      .planner(P.done(), { rateLimit: { ...warning, rateLimitType: 'seven_day' } });
    const runner = await h.create();
    await runner.start();
    expect(h.eventsOf(runner, 'rate_limit')).toHaveLength(3);
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    expect(notes.map((n) => n.kind === 'note' && n.text?.split('.')[0])).toEqual(['Window: five_hour', 'Window: seven_day']);
  });
});

describe('buildTimeline — rollover requests', () => {
  it('"Roll over now" is one note; a Planner request gets its own', async () => {
    h.planner(P.ask('Go on?'));
    const runner = await h.create();
    await runner.start();
    runner.requestRollover('planner');
    h.planner(HANDOFF).planner(P.cont('A', { request_executor_rollover: true })).executor(E.ok(['a'])).planner(P.done());
    await runner.answer('yes');
    const titles = buildTimeline(h.events(runner), false)
      .filter((i) => i.kind === 'note')
      .map((i) => (i.kind === 'note' ? i.title : ''));
    expect(titles.filter((t) => t.includes('rollover'))).toEqual(['You asked for a planner rollover', 'Executor rollover requested']);
  });

  it('rollover notes explain what a rollover is (SPEC.md §15); other notes carry no hint', async () => {
    h.planner(P.ask('Go on?'));
    const runner = await h.create();
    await runner.start();
    runner.requestRollover('planner');
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    const rollover = notes.find((n) => n.kind === 'note' && n.title.includes('rollover'));
    expect(rollover).toMatchObject({ hint: ROLLOVER_HINT });
    expect(ROLLOVER_HINT).toBe(
      "Starts a fresh session for this agent, carrying a structured summary of the task so far. Separate from Claude Code's own in-session auto-compaction.",
    );
    expect(notes.filter((n) => n.kind === 'note' && n.hint !== undefined)).toHaveLength(1);
  });
});

describe('buildTimeline — refused structured answers (§5 net 11)', () => {
  it('puts the check on the turn cards; older turn records without it read as none', async () => {
    const answerRejections = { count: 2, reasons: ['must have required property'], largestAttemptChars: 3000 };
    h.planner(P.cont('A'), { answerRejections: { ...answerRejections, count: 1 } })
      .executor(E.ok([], { summary: 'Test minimal call.' }), { answerRejections })
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const events = h.events(runner);
    const items = buildTimeline(events, false);
    const cycle = items.find((i) => i.kind === 'cycle');
    expect(cycle?.kind === 'cycle' && cycle.executor.answerCheck).toMatchObject({ count: 2, possiblyTruncated: true });
    expect(cycle?.kind === 'cycle' && cycle.planner?.answerCheck).toMatchObject({ count: 1, possiblyTruncated: false });
    expect(cycle?.kind === 'cycle' && cycle.executor.summary?.answerCheck?.possiblyTruncated).toBe(true);
    // The event itself is for the log; the cards show it, so no extra timeline item.
    expect(kinds(items)).toEqual(['start', 'cycle1', 'planner', 'final']);

    const legacy = events.map((e) => {
      if (e.type !== 'turn') return e;
      const { answerCheck: _a, toolUses: _t, ...rest } = e;
      return rest as typeof e;
    });
    const old = buildTimeline(legacy, false).find((i) => i.kind === 'cycle');
    expect(old?.kind === 'cycle' && old.executor.answerCheck).toBeNull();
  });
});

describe('buildTimeline — service-error retries and malformed answers (§5 nets 10 and 12)', () => {
  it('notes the failed attempt with its raw message, then how the retry went', async () => {
    h.planner(P.cont('A'))
      .on('executor', (spec) => failOutcome(spec, 'api_error', { message: 'Internal server error', apiErrorStatus: 500 }))
      .executor(E.ok())
      .planner(P.done());
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    h.scheduled[0]?.fn();
    await finished;
    const items = buildTimeline(h.events(runner), false);
    const notes = items.filter((i) => i.kind === 'note');
    expect(notes).toMatchObject([
      {
        tone: 'warn',
        title: 'Executor turn hit a service error — retrying once',
        text: `HTTP 500: Internal server error It runs again at ${new Date('2026-09-16T10:01:00.000Z').toLocaleTimeString()}.`,
        hint: expect.stringContaining('retried once after a minute'),
      },
      { tone: 'success', title: 'The Executor retry after the service error worked' },
    ]);
    // Both attempts stay on the one cycle card.
    const cycle = items.find((i) => i.kind === 'cycle');
    expect(cycle?.kind === 'cycle' && cycle.attempts.map((a) => a.state)).toEqual(['failed']);
    expect(cycle?.kind === 'cycle' && cycle.executor.state).toBe('ok');
  });

  it('a retry that fails too is a danger note before the error', async () => {
    h.on('planner', (spec) => failOutcome(spec, 'api_error', { message: 'first' })).on('planner', (spec) => failOutcome(spec, 'api_error', { message: 'second' }));
    const runner = await h.create();
    const finished = runner.start();
    await waitFor(() => h.scheduled.length === 1);
    h.scheduled[0]?.fn();
    await finished;
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    expect(notes.map((n) => n.kind === 'note' && [n.tone, n.title])).toEqual([
      ['warn', 'Planner turn hit a service error — retrying once'],
      ['danger', 'The Planner retry after the service error failed too'],
      ['danger', 'Stopped with an error'],
    ]);
  });

  it('a refused malformed Planner answer is a note, and its card shows the markup', async () => {
    h.planner(P.cont('A</next_instruction>\n<parameter name="use_skills">[]')).planner(P.done());
    const runner = await h.create();
    await runner.start();
    const items = buildTimeline(h.events(runner), false);
    expect(items.find((i) => i.kind === 'note')).toMatchObject({ tone: 'warn', title: "Refused: the Planner's answer was malformed" });
    const card = items.find((i) => i.kind === 'planner');
    expect(card?.kind === 'planner' && card.card.answerCheck).toMatchObject({ count: 0, leakedMarkup: true, possiblyTruncated: false });
  });
});

describe('buildTimeline — a skipped rollover and a changed request (§15, §5 net 11)', () => {
  const gaveUp = (spec: Parameters<typeof failOutcome>[0]) =>
    failOutcome(spec, 'structured_output_failed', {
      message: 'The CLI refused all 5 structured answers the model gave.',
      answerRejections: { count: 5, reasons: ['could not be parsed as JSON'], largestAttemptChars: 9000 },
    });

  it('notes the skipped rollover, and says the session was kept', async () => {
    h.planner(P.cont('A'))
      .executor(E.ok())
      .planner(P.cont('B', { request_executor_rollover: true }))
      .on('executor', gaveUp)
      .on('executor', gaveUp)
      .executor(E.ok(['b']))
      .planner(P.done());
    const runner = await h.create();
    await runner.start();
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note');
    expect(notes.at(-1)).toMatchObject({
      tone: 'warn',
      title: 'Executor rollover skipped — its session was kept',
      text: expect.stringContaining('The session and its context are intact'),
      hint: ROLLOVER_HINT,
    });
  });

  it('notes each changed request with its variation', async () => {
    h.planner(P.cont('A')).on('executor', gaveUp).executor(E.ok(['a'])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    const note = buildTimeline(h.events(runner), false).find((i) => i.kind === 'note' && i.title.startsWith('Asked again'));
    expect(note).toMatchObject({
      tone: 'info',
      title: 'Asked again, differently (shorter answer)',
      text: expect.stringContaining('refused 5×'),
    });
  });
});

describe('buildTimeline — approval mode changes (§7)', () => {
  it('each change is a note saying when it applies', async () => {
    h.planner(P.ask('Go on?'));
    const runner = await h.create({ approvalMode: 'review' });
    await runner.start();
    runner.setApprovalMode('auto');
    runner.setApprovalMode('plan_first');
    const notes = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note' && i.title.startsWith('Approval mode'));
    expect(notes).toMatchObject([
      { tone: 'info', title: 'Approval mode: Review → Auto', text: "Applies from the Planner's next instruction." },
      { tone: 'info', title: 'Approval mode: Auto → Plan first', text: expect.stringContaining('asked for a plan of the remaining work first') },
    ]);
  });
});

describe('buildTimeline — auto-resume skipped (§6, §17)', () => {
  it('notes which task was running', async () => {
    h.general.autoResumeAtReset = true;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt: Date.parse('2026-09-16T15:00:00Z') / 1000 }));
    const runner = await h.create();
    await runner.start();
    runner.autoResumeBlocked({ taskId: 'other', title: 'Refactor auth' });
    const note = buildTimeline(h.events(runner), false).filter((i) => i.kind === 'note').at(-1);
    expect(note).toMatchObject({
      tone: 'warn',
      title: 'Auto-resume skipped',
      text: 'Task "Refactor auth" was running, and tasks run one at a time. Resume this task when you are ready.',
    });
  });
});
