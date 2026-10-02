/**
 * Notification texts and the Settings toggles that govern them (SPEC.md §10, §11).
 */
import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '../shared/task-model';
import { autoResumeSkippedToast, cycleToast, statusToast, taskName, taskTitle, toastAllowed } from './notifications';

function task(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1',
    description: 'Refactor auth\nwith details',
    status: 'running',
    statusReason: null,
    waiting: null,
    cycles: 3,
    config: { maxCycles: 8 },
    pinnedAccount: { email: 'owner@example.com', apiKeySource: null },
    rateLimit: null,
    ...patch,
  } as unknown as TaskRecord;
}

const AT = '2026-09-16T10:00:00.000Z';

describe('statusToast', () => {
  it('says what the design says for a Planner question', () => {
    const t = task({ status: 'waiting_user', waiting: { kind: 'question', plannerStatus: 'needs_user', question: 'Which DB?', since: AT } });
    expect(statusToast(t, AT)).toEqual({
      taskId: 't1',
      category: 'waiting',
      tone: 'wait',
      title: 'Waiting for your input',
      body: "Task 'Refactor auth' is waiting for your input — the Planner asked a question.",
      at: AT,
    });
  });

  it('covers approvals, the waiver, loops, the account and the ends', () => {
    const w = (waiting: TaskRecord['waiting']) => statusToast(task({ status: 'waiting_user', waiting }), AT);
    expect(w({ kind: 'instruction_approval', instruction: 'x', useSkills: [], reasoning: null, since: AT })?.title).toBe('Approval needed');
    expect(w({ kind: 'plan_approval', plan: 'x', since: AT })?.title).toBe('Plan ready for review');
    expect(w({ kind: 'skill_waiver', skills: [{ skill: 'security-review', reason: 'no remote' }], after: 'finish', finalReport: null, since: AT })?.body).toContain('security-review');
    expect(w({ kind: 'possible_loop', reason: 'same files', since: AT })?.category).toBe('waiting');
    expect(statusToast(task({ status: 'account_mismatch' }), AT)?.body).toContain('owner@example.com');
    expect(statusToast(task({ status: 'done' }), AT)).toMatchObject({ category: 'finished', tone: 'done', title: 'Task done', body: "Task 'Refactor auth' finished after 3 cycles." });
    expect(statusToast(task({ status: 'failed', statusReason: 'Reached the limit of 8 cycles' }), AT)?.body).toContain('Reached the limit of 8 cycles.');
    expect(statusToast(task({ status: 'error', statusReason: 'timeout: turn took too long\nraw…' }), AT)).toMatchObject({
      category: 'finished',
      tone: 'bad',
      body: "Task 'Refactor auth' — timeout: turn took too long. Resume retries it.",
    });
    expect(statusToast(task({ status: 'rate_limited' }), AT)?.title).toBe('Usage limit reached');
  });

  it('stays quiet about what the user did themselves', () => {
    expect(statusToast(task({ status: 'waiting_user', waiting: { kind: 'paused', cause: 'user', reason: 'Paused by the user.', since: AT } }), AT)).toBeNull();
    expect(statusToast(task({ status: 'waiting_user', waiting: { kind: 'paused', cause: 'daily_cap', reason: 'Cap reached.', since: AT } }), AT)?.title).toBe('Paused: daily token cap');
    expect(statusToast(task({ status: 'stopped' }), AT)).toBeNull();
    expect(statusToast(task({ status: 'running' }), AT)).toBeNull();
  });
});

describe('cycleToast and toastAllowed', () => {
  const settings = { waitingForInput: true, finishedOrFailed: false, everyCompletedCycle: false, sound: false };

  it('maps each category to its Settings toggle', () => {
    const cycle = cycleToast(task({}), { cycle: 2, executorStatus: 'ok', changedFiles: ['a.ts'] } as never, AT);
    expect(cycle).toMatchObject({ category: 'cycle', title: 'Cycle 2 of 8 finished' });
    expect(cycle.body).toContain('1 file changed');
    expect(toastAllowed(cycle, settings)).toBe(false);
    expect(toastAllowed({ ...cycle, category: 'waiting' }, settings)).toBe(true);
    expect(toastAllowed({ ...cycle, category: 'finished' }, settings)).toBe(false);
    expect(toastAllowed(cycle, { ...settings, everyCompletedCycle: true })).toBe(true);
    expect(cycle).toMatchObject({ tone: 'info', body: "Task 'Refactor auth' — the Executor reported ok; 1 file changed." });
  });

  it('never announces a possibly truncated report as a clean ok (SPEC.md §4)', () => {
    const answerCheck = { count: 2, reasons: ['x'], largestAttemptChars: 3000, acceptedChars: 100, possiblyTruncated: true };
    const cycle = cycleToast(task({}), { cycle: 2, executorStatus: 'ok', changedFiles: [], answerCheck } as never, AT);
    expect(cycle).toMatchObject({
      tone: 'bad',
      body: "Task 'Refactor auth' — the Executor reported ok, but its report is possibly truncated; 0 files changed.",
    });
  });

  it('names a task by its first line, shortened', () => {
    expect(taskName('\n  Add a README  \nmore')).toBe('Add a README');
    expect(taskName('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('autoResumeSkippedToast', () => {
  it('names both tasks and asks the user to resume', () => {
    expect(autoResumeSkippedToast(task({ status: 'rate_limited' }), { title: 'Other task\nmore' }, AT)).toEqual({
      taskId: 't1',
      category: 'waiting',
      tone: 'wait',
      title: 'Auto-resume skipped',
      body: "Task 'Refactor auth' was not resumed at the reset: task 'Other task' is running. Resume it when that one is done.",
      at: AT,
    });
  });
});

describe('taskTitle (SPEC.md §10)', () => {
  it("uses the task's name when it has one, and its description's first line otherwise", () => {
    expect(taskTitle({ title: 'Layout fixes', description: 'Long description\nsecond line' })).toBe('Layout fixes');
    expect(taskTitle({ title: null, description: '\n  Long description\nsecond line' })).toBe('Long description');
    expect(taskTitle({ description: 'Old record without the field' })).toBe('Old record without the field');
    expect(taskTitle({ title: '   ', description: 'Blank name falls back' })).toBe('Blank name falls back');
  });

  it('shortens a long name like a long description', () => {
    expect(taskTitle({ title: 'x'.repeat(100), description: 'd' }, 10)).toBe('xxxxxxxxx…');
  });
});
