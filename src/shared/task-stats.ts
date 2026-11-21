/**
 * Display figures for the right panel (SPEC.md §10, design: "Elapsed 23m 12s · paused 3m 41s"), folded
 * from the stored status events. Arithmetic only — nothing here decides anything.
 */

import type { TaskEvent, TaskStatus } from './task-model';
import { turnShareReader } from './turn-cost';

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

/**
 * What a task's turns cost so far, at API prices, as Claude Code reported it (SPEC.md §10, §15). On a
 * subscription this is not money charged; it is the figure that says how heavy a task is.
 */
export interface TaskCost {
  /** Every turn of the task, and the image check of a Video task when it spent a turn. */
  totalUsd: number;
  plannerUsd: number;
  executorUsd: number;
  /** Turns spent outside the two agents' work: a Video task's image check. */
  otherUsd: number;
  /** Turns that reported a cost. */
  turns: number;
  /** Turns that ended without a cost (a killed process): the total is then a lower bound. */
  unknownTurns: number;
}

/**
 * Adds up each turn's own share. A resumed session reports running totals, so the events are read in
 * order and each turn counts the difference from its session's turn before (SPEC.md §15).
 */
export function taskCost(events: readonly TaskEvent[]): TaskCost {
  const shares = turnShareReader();
  const cost: TaskCost = { totalUsd: 0, plannerUsd: 0, executorUsd: 0, otherUsd: 0, turns: 0, unknownTurns: 0 };
  for (const e of events) {
    if (e.type === 'turn') {
      const own = shares.own(e)?.costUsd ?? null;
      if (own === null) {
        cost.unknownTurns += 1;
        continue;
      }
      cost.turns += 1;
      if (e.agent === 'planner') cost.plannerUsd += own;
      else cost.executorUsd += own;
    } else if (e.type === 'video_setup' && typeof e.costUsd === 'number') {
      cost.turns += 1;
      cost.otherUsd += e.costUsd;
    }
  }
  cost.totalUsd = cost.plannerUsd + cost.executorUsd + cost.otherUsd;
  return cost;
}
