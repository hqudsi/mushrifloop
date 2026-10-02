/**
 * Process guard (SPEC.md §5, safety net 9): nothing a turn starts may outlive the turn.
 *
 * On Windows, killing a shell does not kill its children, and once `claude.exe` has exited its
 * process tree can no longer be walked — an orphaned `grep` kept crawling the disk after a turn
 * ended (NOTES.md §14.5). Two layers:
 *   1. job     — the CLI process is placed in a Windows Job Object; everything it starts afterwards
 *                is in the job too, even after its parent exits, and the job is terminated when the
 *                turn ends (NOTES.md §15.1).
 *   2. tree    — fallback when a job cannot be used: poll the process table during the turn,
 *                remember every descendant, and kill the ones still alive at the end.
 */

import type { SurvivorInfo } from '../../shared/task-model';

export type { SurvivorInfo };

export interface ProcessCleanupReport {
  /** Which layer watched this turn. `none` = nothing could (e.g. not Windows) — see `errors`. */
  method: 'job' | 'tree' | 'none';
  /**
   * Processes the turn started that were still running when the turn ended, and were killed.
   * The CLI process itself is never listed.
   */
  survivors: SurvivorInfo[];
  /** Problems while guarding; the turn itself is unaffected. */
  errors: string[];
}

/** Watches one turn's process tree. */
export interface TurnProcessGuard {
  /** Kill every process the turn started, now (timeout, Stop, rate limit). Idempotent. */
  killAll(): Promise<void>;
  /** The turn is over: find and kill anything left, and report it. Call exactly once. */
  finish(): Promise<ProcessCleanupReport>;
}

/** A guard made ready before the CLI is spawned, so attaching it afterwards is a single fast step. */
export interface PreparedGuard {
  attach(rootPid: number): Promise<TurnProcessGuard>;
  /** The spawn failed, so there is nothing to attach: release what `prepare` reserved. */
  discard(): Promise<void>;
}

export interface ProcessGuardFactory {
  /**
   * Call BEFORE spawning. Assignment must follow the spawn within milliseconds: a process that starts
   * children before it is assigned lets them escape the job (NOTES.md §15.1).
   */
  prepare(turnId: string): Promise<PreparedGuard>;
}
