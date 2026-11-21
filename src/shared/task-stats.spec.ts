import { describe, expect, it } from 'vitest';

import type { TaskEvent } from './task-model';
import { taskCost, taskTimes } from './task-stats';

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

describe('taskCost (SPEC.md §10, §15)', () => {
  const turn = (agent: 'planner' | 'executor', sessionId: string, usage: Record<string, unknown> | null) => ({ type: 'turn', agent, sessionId, usage, seq: 0, ts: '2026-11-16T10:00:00Z' }) as unknown as TaskEvent;
  const own = (costUsd: number | null, sessionCostUsd: number | null) => ({ costUsd, modelUsage: {}, sessionCostUsd, sessionModelUsage: {} });

  it('adds each turn’s own share, by agent', () => {
    const cost = taskCost([
      turn('planner', 'p1', own(0.5, 0.5)),
      turn('executor', 'e1', own(2, 2)),
      turn('planner', 'p1', own(0.25, 0.75)),
      turn('executor', 'e1', own(3, 5)),
      // A handoff and the fresh session after a rollover are the Executor's too.
      turn('executor', 'e1', own(0.1, 5.1)),
      turn('executor', 'e2', own(1, 1)),
    ]);
    expect(cost.plannerUsd).toBeCloseTo(0.75);
    expect(cost.executorUsd).toBeCloseTo(6.1);
    expect(cost.totalUsd).toBeCloseTo(6.85);
    expect(cost).toMatchObject({ turns: 6, unknownTurns: 0, otherUsd: 0 });
  });

  it('a record from before 2026-09-27 holds the running total, and is read as the difference', () => {
    const cost = taskCost([
      turn('executor', 'e1', { costUsd: 1, modelUsage: {} }),
      turn('executor', 'e1', { costUsd: 2.5, modelUsage: {} }),
      turn('executor', 'e2', { costUsd: 0.4, modelUsage: {} }),
    ]);
    expect(cost.executorUsd).toBeCloseTo(2.9);
  });

  it('counts the image check of a Video task, and says when a turn reported no cost', () => {
    const cost = taskCost([
      { type: 'video_setup', step: 'image_check', ok: true, detail: '', costUsd: 0.03, seq: 0, ts: '' } as unknown as TaskEvent,
      { type: 'video_setup', step: 'doctor', ok: true, detail: '', seq: 0, ts: '' } as unknown as TaskEvent,
      turn('planner', 'p1', own(0.2, 0.2)),
      turn('executor', 'e1', null),
      turn('executor', 'e1', own(null, null)),
    ]);
    expect(cost.totalUsd).toBeCloseTo(0.23);
    expect(cost).toMatchObject({ otherUsd: 0.03, turns: 2, unknownTurns: 2 });
  });

  it('a task with no turns costs nothing', () => {
    expect(taskCost([])).toEqual({ totalUsd: 0, plannerUsd: 0, executorUsd: 0, otherUsd: 0, turns: 0, unknownTurns: 0 });
  });
});
