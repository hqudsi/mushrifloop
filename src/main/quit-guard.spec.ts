/**
 * Quitting while a task is mid-turn asks first, then waits for the stop to complete (SPEC.md §6, decided
 * 2026-09-16 and 2026-09-17).
 */
import { describe, expect, it } from 'vitest';

import { stoppingText } from '../shared/format';
import { QuitGuard, notStoppedQuestion, quitQuestion, type BusyTask, type QuitGuardDeps } from './quit-guard';

const TASK: BusyTask = { taskId: 't1', title: 'Add a README' };
const BUDGET = 90_000;

interface Setup {
  guard: QuitGuard;
  calls: string[];
  request(): boolean;
  answer(value: boolean): void;
  /** Resolve the pending stopAll with the tasks still not stopped. */
  stopped(pending: BusyTask[]): void;
  /** Answer the "did not stop in time" question: true = Quit anyway. */
  quitAnyway(value: boolean): void;
}

function setup(busy: BusyTask | null): Setup {
  const calls: string[] = [];
  let answer: (value: boolean) => void = () => {};
  let finishStop: (pending: BusyTask[]) => void = () => {};
  let answerForced: (value: boolean) => void = () => {};
  const deps: QuitGuardDeps = {
    busyTask: () => busy,
    confirm: (question) => {
      calls.push(`confirm:${question}`);
      return new Promise((resolve) => (answer = resolve));
    },
    showStopping: (tasks) => calls.push(`showStopping:${tasks.map((t) => t.taskId).join(',')}`),
    stopAll: (budgetMs) => {
      calls.push(`stopAll:${budgetMs}`);
      return new Promise((resolve) => (finishStop = resolve));
    },
    confirmQuitAnyway: (question) => {
      calls.push(`quitAnyway?:${question}`);
      return new Promise((resolve) => (answerForced = resolve));
    },
    quit: () => calls.push('quit'),
    log: (event) => calls.push(`log:${event}`),
  };
  const guard = new QuitGuard(deps, BUDGET);
  return {
    guard,
    calls,
    request: () => {
      let prevented = false;
      guard.onQuitRequest({ preventDefault: () => (prevented = true) });
      return prevented;
    },
    answer: (v) => answer(v),
    stopped: (pending) => finishStop(pending),
    quitAnyway: (v) => answerForced(v),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('QuitGuard', () => {
  it('lets the app quit when no task is running', () => {
    const s = setup(null);
    expect(s.request()).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it('asks with the task name; Cancel keeps the app and the task running', async () => {
    const s = setup(TASK);
    expect(s.request()).toBe(true);
    expect(s.calls).toEqual([`confirm:${quitQuestion('Add a README')}`]);
    expect(quitQuestion('Add a README')).toBe('Task Add a README is mid-turn. Quit and stop it?');
    // A second quit path (window close + before-quit) while the question is open does not ask twice.
    expect(s.request()).toBe(true);
    s.answer(false);
    await flush();
    expect(s.calls).toEqual([`confirm:${quitQuestion('Add a README')}`, 'log:app.quit_cancelled']);
    expect(s.guard.state).toBe('idle');
    // Asked again next time.
    expect(s.request()).toBe(true);
    expect(s.calls.filter((c) => c.startsWith('confirm')).length).toBe(2);
  });

  it('"Quit and stop" shows "Stopping…", waits for the stop with the real budget, then quits', async () => {
    const s = setup(TASK);
    expect(s.request()).toBe(true);
    s.answer(true);
    await flush();
    expect(s.calls.slice(1)).toEqual(['log:app.quit_stopping_tasks', 'showStopping:t1', `stopAll:${BUDGET}`]);
    expect(s.guard.state).toBe('stopping');
    // Quit requests while it waits are held, and nothing quits before the stop completes.
    expect(s.request()).toBe(true);
    expect(s.calls).not.toContain('quit');

    s.stopped([]);
    await flush();
    expect(s.calls.slice(4)).toEqual(['log:app.quit_tasks_stopped', 'showStopping:', 'quit']);
    expect(s.guard.state).toBe('ready');
    // The quit that follows (and the window close it causes) is not held again.
    expect(s.request()).toBe(false);
  });

  it('says so when the stop does not complete in time; Keep waiting waits again', async () => {
    const s = setup(TASK);
    s.request();
    s.answer(true);
    await flush();
    s.stopped([TASK]);
    await flush();
    const asked = s.calls.find((c) => c.startsWith('quitAnyway?:'));
    expect(asked).toMatch(/^quitAnyway\?:Task Add a README did not stop within \d+ s\.$/);
    expect(s.calls).not.toContain('quit');

    s.quitAnyway(false);
    await flush();
    expect(s.calls.slice(-3)).toEqual(['log:app.quit_keep_waiting', 'showStopping:t1', `stopAll:${BUDGET}`]);
    expect(s.guard.state).toBe('stopping');

    s.stopped([]);
    await flush();
    expect(s.calls.slice(-3)).toEqual(['log:app.quit_tasks_stopped', 'showStopping:', 'quit']);
  });

  it('Quit anyway quits without waiting further, and logs it', async () => {
    const s = setup(TASK);
    s.request();
    s.answer(true);
    await flush();
    s.stopped([TASK]);
    await flush();
    s.quitAnyway(true);
    await flush();
    expect(s.calls.slice(-3)).toEqual(['log:app.quit_forced', 'showStopping:', 'quit']);
    expect(s.guard.state).toBe('ready');
  });

  it('words the messages', () => {
    expect(notStoppedQuestion([TASK], 90_400)).toBe('Task Add a README did not stop within 90 s.');
    expect(notStoppedQuestion([TASK, { taskId: 't2', title: 'B' }], 180_000)).toBe('2 tasks did not stop within 180 s.');
    expect(stoppingText([TASK])).toBe('Stopping Add a README…');
    expect(stoppingText([TASK, TASK])).toBe('Stopping 2 tasks…');
    expect(stoppingText([{ title: 'A long title that was cut…' }])).toBe('Stopping A long title that was cut…');
  });
});
