/**
 * Display figures for the right panel (SPEC.md §10, design: "Elapsed 23m 12s · paused 3m 41s"), folded
 * from the stored status events. Arithmetic only — nothing here decides anything.
 */

import type { TaskEvent, TaskStatus } from './task-model';

/** Statuses in which the task waits on the user. */
const WAITING_ON_USER: readonly TaskStatus[] = ['waiting_user', 'account_mismatch'];
const ENDED: readonly TaskStatus[] = ['done', 'failed'];

export interface TaskTimes {
  /** From creation to the end (or now). */
  elapsedMs: number;
  /** Of that, time spent waiting for the user. */
  waitingMs: number;
}

export function taskTimes(createdAt: string, events: readonly TaskEvent[], now: number): TaskTimes {
  const start = Date.parse(createdAt);
  let end = now;
  let waitingMs = 0;
  let waitingSince: number | null = null;
  for (const e of events) {
    if (e.type !== 'status') continue;
    const at = Date.parse(e.ts);
    if (waitingSince !== null) {
      waitingMs += Math.max(0, at - waitingSince);
      waitingSince = null;
    }
    if (WAITING_ON_USER.includes(e.to)) waitingSince = at;
    end = ENDED.includes(e.to) ? at : now;
  }
  if (waitingSince !== null) waitingMs += Math.max(0, end - waitingSince);
  return { elapsedMs: Math.max(0, end - start), waitingMs };
}
