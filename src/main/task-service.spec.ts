/**
 * The task hub's request validation, list shaping and raw-file activity (no CLI needed).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { TaskService, filesFromReports, parseAction, parseConfigUpdate, sanitizeOverrides, summarize } = await import('./task-service');
const { defaultSettings } = await import('../shared/settings');
const { TEST_CONFIG, Harness, P, E, failOutcome, okOutcome, waitFor } = await import('./orchestrator/__tests__/harness');

describe('parseConfigUpdate (SPEC.md §6)', () => {
  it('takes the fields it knows, in their shapes, and leaves the rest', () => {
    expect(
      parseConfigUpdate({
        maxCycles: 30,
        rolloverPercent: 50,
        requiredSkills: ['security-review'],
        autoBranchAndCommit: false,
        executor: { model: 'claude-opus-5-5', effort: 'medium' },
        planner: { model: 'haiku', effort: null },
        apply: 'fresh_session',
        extra: 'ignored',
      }),
    ).toEqual({
      maxCycles: 30,
      rolloverPercent: 50,
      requiredSkills: ['security-review'],
      autoBranchAndCommit: false,
      executor: { model: 'claude-opus-5-5', effort: 'medium' },
      planner: { model: 'haiku', effort: null },
      apply: 'fresh_session',
    });
    expect(parseConfigUpdate({})).toEqual({});
    // The turn limits and the fresh-Executor rule (added 2026-09-26); null switches the rule off.
    expect(parseConfigUpdate({ turnTimeoutMs: 2_700_000, slowTurnMs: 600_000, maxTurnsPerSession: 120, freshExecutorAfterRejectedTurns: null })).toEqual({
      turnTimeoutMs: 2_700_000,
      slowTurnMs: 600_000,
      maxTurnsPerSession: 120,
      freshExecutorAfterRejectedTurns: null,
    });
    expect(parseConfigUpdate({ maxTurnsPerSession: '80' })).toBeNull();
    expect(parseConfigUpdate({ freshExecutorAfterRejectedTurns: 'off' })).toBeNull();
  });

  it('parses a rename, empty included (it removes the name)', () => {
    expect(parseAction({ kind: 'rename', title: 'Layout fixes' })).toEqual({ kind: 'rename', title: 'Layout fixes' });
    expect(parseAction({ kind: 'rename', title: '' })).toEqual({ kind: 'rename', title: '' });
    expect(parseAction({ kind: 'rename', title: 3 })).toBeNull();
  });

  it('refuses a wrong shape rather than guess', () => {
    expect(parseConfigUpdate({ maxCycles: '30' })).toBeNull();
    expect(parseConfigUpdate({ executor: { model: 'sonnet', effort: 'turbo' } })).toBeNull();
    expect(parseConfigUpdate({ executor: { effort: 'high' } })).toBeNull();
    expect(parseConfigUpdate({ apply: 'now' })).toBeNull();
    expect(parseConfigUpdate({ requiredSkills: [1] })).toBeNull();
    expect(parseAction({ kind: 'update_config', update: { maxCycles: 30 } })).toEqual({ kind: 'update_config', update: { maxCycles: 30 } });
    expect(parseAction({ kind: 'update_config', update: 'x' })).toBeNull();
  });
});

describe('parseAction', () => {
  it('accepts well-formed actions only', () => {
    expect(parseAction({ kind: 'pause' })).toEqual({ kind: 'pause' });
    expect(parseAction({ kind: 'answer', text: 'yes', extra: 1 })).toEqual({ kind: 'answer', text: 'yes' });
    // SPEC.md §6: there is no recipient any more, and one sent by an older renderer is ignored.
    expect(parseAction({ kind: 'send', text: 'x' })).toEqual({ kind: 'send', text: 'x' });
    expect(parseAction({ kind: 'send', to: 'executor', text: 'x' })).toEqual({ kind: 'send', text: 'x' });
    expect(parseAction({ kind: 'waive_skill', skill: 'security-review' })).toEqual({ kind: 'waive_skill', skill: 'security-review' });
    expect(parseAction({ kind: 'waive_skill', skill: 's', note: 'n' })).toEqual({ kind: 'waive_skill', skill: 's', note: 'n' });
    expect(parseAction({ kind: 'send' })).toBeNull();
    expect(parseAction({ kind: 'answer' })).toBeNull();
    expect(parseAction({ kind: 'rm -rf' })).toBeNull();
    expect(parseAction('pause')).toBeNull();
  });
});

describe('sanitizeOverrides', () => {
  it('keeps known keys, coerced into range', () => {
    expect(
      sanitizeOverrides({
        planner: { model: 'opus', effort: 'low' },
        executor: { model: 'haiku', effort: 'max' },
        maxCycles: 9999,
        rolloverPercent: 1,
        approvalMode: 'auto',
        plannerContextMode: 'read_only',
        autoBranchAndCommit: false,
        requiredSkills: ['security-review', ' ', 3],
        executorTools: ['WebFetch'],
        permissionMode: 'bypassPermissions',
      }),
    ).toEqual({
      planner: { model: 'opus', effort: 'low' },
      executor: { model: 'haiku', effort: null },
      maxCycles: 500,
      rolloverPercent: 5,
      approvalMode: 'auto',
      plannerContextMode: 'read_only',
      autoBranchAndCommit: false,
      requiredSkills: ['security-review'],
    });
    expect(sanitizeOverrides({ planner: { model: 'gpt-9' }, approvalMode: 'yolo' })).toEqual({});
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides({ freshExecutorAfterRejectedTurns: 30 })).toEqual({ freshExecutorAfterRejectedTurns: 10 });
    // Max steps per turn, from the New task modal since 2026-09-26.
    expect(sanitizeOverrides({ maxTurnsPerSession: 120 })).toEqual({ maxTurnsPerSession: 120 });
    expect(sanitizeOverrides({ maxTurnsPerSession: 5000 })).toEqual({ maxTurnsPerSession: 1000 });
    expect(sanitizeOverrides({ freshExecutorAfterRejectedTurns: null })).toEqual({ freshExecutorAfterRejectedTurns: null });
    expect(sanitizeOverrides({ freshExecutorAfterRejectedTurns: 'x' })).toEqual({});
  });
});

describe('TaskService queries', () => {
  let h: InstanceType<typeof Harness>;
  beforeEach(() => {
    h = new Harness();
  });
  afterEach(() => {
    h.cleanup();
  });

  it('lists stored tasks and reads a finished turn from its raw file', async () => {
    h.planner(P.ask('Proceed?'));
    const runner = await h.create({ ...TEST_CONFIG }, 'Line one of the task\nmore detail');
    await runner.start();
    const task = h.task(runner);
    const turnId = h.specs[0]!.turnId!;
    fs.writeFileSync(
      path.join(h.store.rawDir(runner.id), `${turnId}.ndjson`),
      [
        { type: 'system', subtype: 'init', session_id: 's', tools: [], skills: [], slash_commands: [] },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok 3 tests' }] } },
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n{"torn',
    );

    const sent: unknown[] = [];
    const service = new TaskService({ getSettings: () => defaultSettings(), send: (m) => sent.push(m), tasksRoot: h.store.root });
    const list = service.list();
    expect(list).toEqual([
      expect.objectContaining({
        id: runner.id,
        title: 'Line one of the task',
        status: 'waiting_user',
        waitingKind: 'question',
        busy: false,
        projectName: 'project',
        planner: 'opus · low',
      }),
    ]);
    const detail = service.get(runner.id);
    expect(detail && 'events' in detail ? detail.events.length : 0).toBeGreaterThan(3);
    expect(service.get('../etc')).toBeNull();

    const activity = service.activity(runner.id, turnId);
    expect(activity?.toolCalls).toBe(1);
    expect(activity?.rows[0]).toMatchObject({ tool: 'Bash', summary: '$ npm test', output: 'ok 3 tests' });
    // A turn that cannot be read says why and where; it is never left blank (SPEC.md §9).
    const missing = service.activity(runner.id, 'missing-turn');
    expect(missing.rows).toEqual([]);
    expect(missing.error).toContain(path.join(h.store.rawDir(runner.id), 'missing-turn.ndjson'));
    expect(missing.error).toContain('ENOENT');
    expect(service.activity(runner.id, '../../x').error).toBe(`Unknown turn ../../x of task ${runner.id}.`);
    expect(activity.error).toBeNull();
    expect(summarize(task, true).busy).toBe(true);
  });
});

describe('parseAction (Phase 5)', () => {
  it('accepts approvals, standing instructions and rollover requests', () => {
    expect(parseAction({ kind: 'approve_instruction' })).toEqual({ kind: 'approve_instruction' });
    expect(parseAction({ kind: 'approve_plan', edited: 'Plan B' })).toEqual({ kind: 'approve_plan', edited: 'Plan B' });
    expect(parseAction({ kind: 'approve_plan', edited: 7 })).toBeNull();
    expect(parseAction({ kind: 'reject_instruction', reason: 'too broad' })).toEqual({ kind: 'reject_instruction', reason: 'too broad' });
    expect(parseAction({ kind: 'reject_plan' })).toBeNull();
    expect(parseAction({ kind: 'set_standing_instructions', agent: 'executor', text: '' })).toEqual({
      kind: 'set_standing_instructions',
      agent: 'executor',
      text: '',
    });
    expect(parseAction({ kind: 'set_standing_instructions', agent: 'boss', text: 'x' })).toBeNull();
    expect(parseAction({ kind: 'rollover_now', agent: 'planner' })).toEqual({ kind: 'rollover_now', agent: 'planner' });
    expect(parseAction({ kind: 'set_approval_mode', mode: 'plan_first', extra: 1 })).toEqual({ kind: 'set_approval_mode', mode: 'plan_first' });
    expect(parseAction({ kind: 'set_approval_mode', mode: 'yolo' })).toBeNull();
    expect(parseAction({ kind: 'set_approval_mode' })).toBeNull();
  });

  it('keeps the New task dialog overrides', () => {
    expect(
      sanitizeOverrides({
        turnTimeoutMs: 5,
        slowTurnMs: 300_000,
        requiredSkills: ['a', 'a', 'b'],
        standingInstructions: { planner: 'Be brief.', executor: '' },
      }),
    ).toEqual({ turnTimeoutMs: 60_000, slowTurnMs: 300_000, requiredSkills: ['a', 'b'], standingInstructions: { planner: 'Be brief.', executor: '' } });
    expect(sanitizeOverrides({ standingInstructions: { planner: 'x' } })).toEqual({});
  });
});

describe('filesFromReports', () => {
  it('lists what the Executor reported, relative to the project, latest change winning', () => {
    const turn = (files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>, ok = true) =>
      ({ type: 'turn', agent: 'executor', ok, output: { changed_files: files } }) as never;
    const project = path.join(os.tmpdir(), 'proj');
    const files = filesFromReports(
      [
        turn([{ path: 'src/a.ts', change: 'added' }, { path: path.join(project, 'b.md'), change: 'modified' }]),
        turn([{ path: './src/a.ts', change: 'modified' }, { path: 'c.txt', change: 'added' }]),
        turn([{ path: 'c.txt', change: 'deleted' }]),
        turn([{ path: 'ignored.ts', change: 'added' }], false),
      ],
      project,
    );
    expect(files.map((f) => [f.path, f.status, f.name, f.dir])).toEqual([
      ['b.md', 'M', 'b.md', ''],
      ['c.txt', 'D', 'c.txt', ''],
      ['src/a.ts', 'A', 'a.ts', 'src'],
    ]);
  });
});

describe('TaskService commands (Phase 5)', () => {
  let h: InstanceType<typeof Harness>;
  let settings: ReturnType<typeof defaultSettings>;
  let toasts: Array<{ category: string; title: string; body: string }>;
  let opened: Array<{ command: string; file: string }>;

  const service = () => {
    const s = new TaskService({
      getSettings: () => settings,
      send: () => {},
      tasksRoot: h.store.root,
      usageFile: path.join(h.dir, 'usage.json'),
      notify: (toast) => toasts.push(toast),
      createDeps: (_settings, hooks) => ({
        deps: {
          ...h.deps(),
          ...(hooks.onNotice ? { onNotice: hooks.onNotice } : {}),
          ...(hooks.notify ? { notify: hooks.notify } : {}),
          ...(hooks.autoResume ? { autoResume: hooks.autoResume } : {}),
        },
      }),
      launchEditor: async (command, file) => {
        opened.push({ command, file });
        return { ok: true };
      },
    });
    s.init();
    return s;
  };

  const create = async (s: InstanceType<typeof TaskService>, description: string, overrides: Record<string, unknown> = {}) => {
    const result = await s.create({ description, projectDir: h.projectDir, overrides: { requiredSkills: [], approvalMode: 'auto', ...overrides } });
    expect(result.ok, result.error).toBe(true);
    return result.taskId!;
  };

  beforeEach(() => {
    h = new Harness();
    settings = defaultSettings();
    toasts = [];
    opened = [];
  });
  afterEach(() => {
    h.cleanup();
  });

  it('refuses a second task while one runs, naming and linking the running one', async () => {
    const s = service();
    let release: () => void = () => {};
    h.on('planner', (spec) => new Promise((resolve) => (release = () => resolve(okOutcome(spec, P.ask('Which name?'))))));
    const first = await create(s, 'First task\nwith detail');
    const second = await create(s, 'Second task');
    expect(await s.action(first, { kind: 'start' })).toEqual({ ok: true });
    await waitFor(() => h.specs.length === 1);
    expect(s.busyTask()).toEqual({ taskId: first, title: 'First task' });

    const refused = await s.action(second, { kind: 'start' });
    expect(refused).toMatchObject({
      ok: false,
      error: 'A task is already running: First task',
      blockedBy: { taskId: first, title: 'First task' },
    });
    expect(refused.nextStep).toContain('one at a time');
    // Commands that never start a loop still work on the other task.
    expect(await s.action(second, { kind: 'set_standing_instructions', agent: 'planner', text: 'Be brief.' })).toEqual({ ok: true });
    expect(h.store.readTask(second).config.standingInstructions.planner).toBe('Be brief.');
    // So is the approval mode — of either task, the running one included (SPEC.md §7).
    expect(await s.action(first, { kind: 'set_approval_mode', mode: 'plan_first' })).toEqual({ ok: true });
    expect(h.store.readTask(first).config.approvalMode).toBe('plan_first');
    expect(await s.action(second, { kind: 'set_approval_mode', mode: 'auto' })).toEqual({ ok: true });
    expect(h.store.readTask(second).config.approvalMode).toBe('auto');

    release();
    await waitFor(() => !s.anyBusy());
    expect(s.busyTask()).toBeNull();
    expect(toasts.map((t) => t.title)).toEqual(['Waiting for your input']);
    h.planner(P.done());
    expect((await s.action(second, { kind: 'start' })).ok).toBe(true);
    await waitFor(() => h.store.readTask(second).status === 'done');
  });

  it('routes review-mode approvals and plan approvals to the orchestrator', async () => {
    const s = service();
    h.planner(P.cont('Create README.md'));
    const review = await create(s, 'Review task', { approvalMode: 'review' });
    await s.action(review, { kind: 'start' });
    await waitFor(() => h.store.readTask(review).waiting?.kind === 'instruction_approval');
    expect(toasts.at(-1)?.title).toBe('Approval needed');

    h.planner(P.cont('Create README.md with a title'));
    expect(await s.action(review, { kind: 'reject_instruction', reason: 'Add a title too.' })).toEqual({ ok: true });
    await waitFor(() => h.specs.length === 2 && h.store.readTask(review).waiting?.kind === 'instruction_approval');
    expect(h.specs[1]!.prompt).toContain('Add a title too.');

    h.executor(E.ok(['README.md']));
    h.planner(P.done());
    expect(await s.action(review, { kind: 'approve_instruction', edited: 'Create README.md with the title "Demo".' })).toEqual({ ok: true });
    await waitFor(() => h.store.readTask(review).status === 'done');
    expect(h.specs[2]!.prompt).toContain('Create README.md with the title "Demo".');
    expect(toasts.at(-1)).toMatchObject({ category: 'finished', title: 'Task done' });

    h.planner(P.plan('1. Write it. 2. Check it.'));
    const planned = await create(s, 'Plan task', { approvalMode: 'plan_first' });
    await s.action(planned, { kind: 'start' });
    await waitFor(() => h.store.readTask(planned).waiting?.kind === 'plan_approval');
    h.planner(P.done());
    expect(await s.action(planned, { kind: 'approve_plan' })).toEqual({ ok: true });
    await waitFor(() => h.store.readTask(planned).status === 'done');
    expect(h.store.readTask(planned).planApproved).toBe(true);
    h.assertScriptDone();
  });

  it('respects the notification toggles and requests rollovers', async () => {
    settings.general.notifications.waitingForInput = false;
    const s = service();
    h.planner(P.ask('Proceed?'));
    const id = await create(s, 'Quiet task');
    await s.action(id, { kind: 'start' });
    await waitFor(() => h.store.readTask(id).status === 'waiting_user');
    expect(toasts).toEqual([]);

    expect(await s.action(id, { kind: 'rollover_now', agent: 'planner' })).toEqual({ ok: true });
    expect(h.store.readTask(id).sessions.planner.rolloverRequested).toBe('requested by the user');
    expect(await s.action(id, { kind: 'rollover_now', agent: 'wizard' })).toEqual({ ok: false, error: 'Invalid action.' });
  });

  it('lists changed files from reports without git and opens files inside the project only', async () => {
    h.git.isRepo = false;
    const s = service();
    h.planner(P.cont('Write a.txt'));
    h.executor(E.ok(['a.txt']));
    h.planner(P.done());
    const id = await create(s, 'Files task');
    await s.action(id, { kind: 'start' });
    await waitFor(() => h.store.readTask(id).status === 'done');

    const files = await s.changedFiles(id);
    expect(files).toMatchObject({ source: 'reports', files: [{ path: 'a.txt', status: 'M' }] });
    expect(files?.basis).toContain('not a git repository');
    expect(await s.changedFiles('../nope')).toMatchObject({ files: [], error: 'Unknown task ../nope.' });

    fs.writeFileSync(path.join(h.projectDir, 'a.txt'), 'hi');
    expect(await s.openFile(id, 'a.txt')).toEqual({ ok: true });
    expect(opened).toEqual([{ command: 'code', file: path.join(h.projectDir, 'a.txt') }]);
    expect(await s.openFile(id, '../outside.txt')).toMatchObject({ ok: false, error: expect.stringContaining('Not inside the project') });
    expect(await s.openFile(id, 'missing.txt')).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
    expect(opened).toHaveLength(1);

    expect(await s.inspectProject(h.projectDir)).toMatchObject({ exists: true });
    expect((await s.inspectProject(path.join(h.dir, 'missing'))).exists).toBe(false);

    const usage = await s.usage(false);
    expect(usage).toMatchObject({ windows: [], reportedAt: null, checkedAt: null, checkError: null, refreshSkipped: false });
  });

  // -------------------------------------------------------------------------
  // Wave 1 (2026-09-17)
  // -------------------------------------------------------------------------

  it('holds the slot from the moment a start is accepted, so two quick starts cannot both run', async () => {
    const s0 = service();
    const first = await create(s0, 'First task');
    const second = await create(s0, 'Second task');
    await s0.action(first, { kind: 'stop' });
    // The next account check hangs: Resume has been accepted, but nothing drives the loop yet.
    let answer: () => void = () => {};
    let hang = true;
    const orig = h.deps.bind(h);
    h.deps = () => ({
      ...orig(),
      authStatus: () => (hang ? new Promise((resolve) => (answer = () => resolve(h.auth))) : Promise.resolve(h.auth)),
    });
    const s = service();
    h.planner(P.ask('Which?'));
    expect(await s.action(first, { kind: 'resume' })).toEqual({ ok: true });
    expect(s.busyTask()).toEqual({ taskId: first, title: 'First task' });
    expect(await s.action(second, { kind: 'start' })).toMatchObject({ ok: false, blockedBy: { taskId: first, title: 'First task' } });
    hang = false;
    answer();
    await waitFor(() => !s.anyBusy());
    expect(h.store.readTask(first).status).toBe('waiting_user');
    expect(h.store.readTask(second).status).toBe('draft');
  });

  it('auto-resume obeys one-at-a-time: blocked, it stays rate_limited, records who ran, and notifies', async () => {
    settings.general.autoResumeAtReset = true;
    h.general.autoResumeAtReset = true;
    const s = service();
    const resetsAt = Date.parse('2026-09-16T15:00:00Z') / 1000;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const limited = await create(s, 'Limited task');
    await s.action(limited, { kind: 'start' });
    await waitFor(() => h.store.readTask(limited).status === 'rate_limited' && !s.anyBusy());
    expect(h.scheduled).toHaveLength(1);

    let release: () => void = () => {};
    h.on('planner', (spec) => new Promise((resolve) => (release = () => resolve(okOutcome(spec, P.ask('Which?'))))));
    const other = await create(s, 'Other task');
    await s.action(other, { kind: 'start' });
    await waitFor(() => s.busyTask()?.taskId === other);

    toasts.length = 0;
    h.scheduled[0]!.fn();
    await waitFor(() => h.store.readTask(limited).rateLimit?.autoResumeSkipped !== null && h.store.readTask(limited).rateLimit?.autoResumeSkipped !== undefined);
    const task = h.store.readTask(limited);
    expect(task.status).toBe('rate_limited');
    expect(task.rateLimit?.autoResumeSkipped?.blockedBy).toEqual({ taskId: other, title: 'Other task' });
    expect(h.store.readEvents(limited).some((e) => e.type === 'auto_resume_skipped')).toBe(true);
    expect(toasts).toEqual([
      expect.objectContaining({
        category: 'waiting',
        title: 'Auto-resume skipped',
        body: "Task 'Limited task' was not resumed at the reset: task 'Other task' is running. Resume it when that one is done.",
      }),
    ]);

    release();
    await waitFor(() => !s.anyBusy());
    // The user resumes it; auto-resume does not come back on its own.
    h.planner(P.done());
    expect((await s.action(limited, { kind: 'resume' })).ok).toBe(true);
    await waitFor(() => h.store.readTask(limited).status === 'done');
  });

  it('auto-resume with nothing else running resumes the task', async () => {
    settings.general.autoResumeAtReset = true;
    h.general.autoResumeAtReset = true;
    const s = service();
    const resetsAt = Date.parse('2026-09-16T15:00:00Z') / 1000;
    h.on('planner', (spec) => failOutcome(spec, 'rate_limited', { resetsAt }));
    const id = await create(s, 'Limited task');
    await s.action(id, { kind: 'start' });
    await waitFor(() => h.store.readTask(id).status === 'rate_limited' && !s.anyBusy());
    h.planner(P.done());
    h.scheduled[0]!.fn();
    await waitFor(() => h.store.readTask(id).status === 'done');
  });

  it('Quit and stop waits for the stop to complete, and reports what has not stopped in time', async () => {
    const s = service();
    let release: () => void = () => {};
    h.on('planner', (spec) => new Promise((resolve) => (release = () => resolve(failOutcome(spec, 'aborted')))));
    const id = await create(s, 'Slow task');
    await s.action(id, { kind: 'start' });
    await waitFor(() => h.specs.length === 1);

    // The turn does not end within the budget.
    expect(await s.stopAll(30)).toEqual([{ taskId: id, title: 'Slow task' }]);
    expect(h.store.readTask(id).status).toBe('running');
    // Waiting again waits on the same stop, which completes once the turn ends.
    const again = s.stopAll(5_000);
    release();
    expect(await again).toEqual([]);
    expect(h.store.readTask(id).status).toBe('stopped');
    expect(h.store.readEvents(id).filter((e) => e.type === 'intervention' && e.kind === 'stop')).toHaveLength(1);
  });

  it('Quit and stop calls off a Resume that is still checking the account', async () => {
    const s0 = service();
    h.planner(P.ask('Which?'));
    const id = await create(s0, 'Paused task');
    await s0.action(id, { kind: 'start' });
    await waitFor(() => h.store.readTask(id).status === 'waiting_user' && !s0.anyBusy());
    await s0.action(id, { kind: 'stop' });

    let answer: () => void = () => {};
    const orig = h.deps.bind(h);
    h.deps = () => ({ ...orig(), authStatus: () => new Promise((resolve) => (answer = () => resolve(h.auth))) });
    const s = service();
    expect(await s.action(id, { kind: 'resume' })).toEqual({ ok: true });
    const stopping = s.stopAll(5_000);
    answer();
    expect(await stopping).toEqual([]);
    expect(h.store.readTask(id).status).toBe('stopped');
  });

  it('lists a task whose files cannot be read, and says why', async () => {
    const s = service();
    const good = await create(s, 'Good task');
    const bad = '20260916-120000-badbad';
    fs.mkdirSync(h.store.taskDir(bad), { recursive: true });
    fs.writeFileSync(h.store.taskFile(bad), '{ this is not json');
    const broken = '20260916-120001-brkbrk';
    fs.mkdirSync(h.store.taskDir(broken), { recursive: true });
    fs.writeFileSync(h.store.taskFile(broken), '{}');

    const reloaded = service();
    const list = reloaded.list();
    expect(list.map((t) => t.id).sort()).toEqual([good, bad, broken].sort());
    const row = list.find((t) => t.id === bad)!;
    expect(row).toMatchObject({ title: `Unreadable task ${bad}`, status: 'error', busy: false, projectDir: h.store.taskDir(bad) });
    expect(row.unreadable).toContain('Could not load this task from');
    expect(list.find((t) => t.id === broken)?.unreadable).toContain('Could not load this task from');
    expect(list.find((t) => t.id === good)?.unreadable).toBeNull();

    expect(reloaded.get(bad)).toMatchObject({ unreadable: true, taskId: bad, folder: h.store.taskDir(bad) });
    expect(await reloaded.changedFiles(bad)).toMatchObject({ files: [], error: expect.stringContaining('task.json') });
    expect(await reloaded.action(bad, { kind: 'resume' })).toMatchObject({ ok: false, error: `Unknown task ${bad}.` });

    // A task.json that goes bad while the app runs is listed the same way.
    fs.writeFileSync(h.store.taskFile(good), 'garbage');
    expect(reloaded.list().find((t) => t.id === good)?.unreadable).toContain('task.json');
    expect(reloaded.get(good)).toMatchObject({ unreadable: true, error: expect.stringContaining('Could not read this task') });
  });

  it('tells "git could not be run" apart from "not a repository"', async () => {
    const s = service();
    const plain = path.join(h.dir, 'plain');
    fs.mkdirSync(plain);
    expect(await s.inspectProject(plain)).toMatchObject({ exists: true, isRepo: false, error: null });

    const saved = process.env['PATH'];
    process.env['PATH'] = path.join(h.dir, 'no-git-here');
    try {
      const inspection = await s.inspectProject(plain);
      expect(inspection).toMatchObject({ exists: true, isRepo: false });
      expect(inspection.error).toMatch(/^Git could not be run \(git rev-parse --is-inside-work-tree\): .*Is git installed and on PATH\?$/);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('lists the windows session first, labels a per-model week, and gives each its own time (SPEC.md §17)', async () => {
    const file = path.join(h.dir, 'usage.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        days: {},
        latest: {
          at: '2026-09-26T06:05:00.000Z',
          status: 'allowed',
          rateLimitType: 'five_hour',
          windows: {
            seven_day_fable: { utilization: 0, resetsAt: 300, at: '2026-09-26T06:00:00.000Z' },
            seven_day: { utilization: 0.06, resetsAt: 200, at: '2026-09-26T06:05:00.000Z' },
            five_hour: { utilization: 0.25, resetsAt: 100 },
          },
        },
      }),
    );
    const usage = await service().usage(false);
    expect(usage.reportedAt).toBe('2026-09-26T06:05:00.000Z');
    expect(usage.windows.map((w) => [w.key, w.label, w.reportedAt])).toEqual([
      ['five_hour', 'Session (5-hour)', '2026-09-26T06:05:00.000Z'],
      ['seven_day', 'Week (all models)', '2026-09-26T06:05:00.000Z'],
      ['seven_day_fable', 'Week (Fable)', '2026-09-26T06:00:00.000Z'],
    ]);
  });

  it('reports an unreadable usage.json in the usage panel and keeps the file', async () => {
    const file = path.join(h.dir, 'usage.json');
    fs.writeFileSync(file, '{"days": ');
    const s = service();
    const usage = await s.usage(false);
    expect(usage.ledgerError).toContain('was unreadable');
    const kept = fs.readdirSync(h.dir).filter((f) => f.startsWith('usage.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.dir, kept[0]!), 'utf8')).toBe('{"days": ');
    expect(usage.ledgerError).toContain(kept[0]!);
  });
});
