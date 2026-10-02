import { describe, expect, it } from 'vitest';

import type { TaskEvent } from './task-model';
import { taskTimes } from './task-stats';

const status = (ts: string, to: string) => ({ type: 'status', ts, to, from: 'running', reason: null, waiting: null, seq: 0 }) as unknown as TaskEvent;

describe('taskTimes', () => {
  const created = '2026-09-16T10:00:00Z';

  it('counts time waiting for the user, and stops the clock when the task ends', () => {
    const events = [
      status('2026-09-16T10:00:00Z', 'running'),
      status('2026-09-16T10:01:00Z', 'waiting_user'),
      status('2026-09-16T10:04:00Z', 'running'),
      status('2026-09-16T10:05:00Z', 'account_mismatch'),
      status('2026-09-16T10:06:00Z', 'running'),
      status('2026-09-16T10:10:00Z', 'done'),
    ];
    expect(taskTimes(created, events, Date.parse('2026-09-16T12:00:00Z'))).toEqual({ elapsedMs: 10 * 60_000, waitingMs: 4 * 60_000 });
  });

  it('keeps counting a wait that is still open', () => {
    const events = [status('2026-09-16T10:00:00Z', 'running'), status('2026-09-16T10:02:00Z', 'waiting_user')];
    expect(taskTimes(created, events, Date.parse('2026-09-16T10:05:00Z'))).toEqual({ elapsedMs: 5 * 60_000, waitingMs: 3 * 60_000 });
  });
});
