/**
 * How cold a finished task's sessions are, for the one quiet line the composer shows before a
 * follow-up (SPEC.md §10, §15; measured in NOTES.md §36).
 *
 * Resuming a session does not re-send its conversation, but the prompt cache behind it has a
 * lifetime. Inside that window a follow-up reads the cached context and costs very little; outside
 * it, the whole context is written to the cache again, which is most of the price of the turn. A
 * real follow-up on a task that had been finished for three days cost $0.194 with **zero** cache-read
 * and 17,628 cache-creation tokens — the work was one short answer; the rest was the cache.
 *
 * This is a warning, never a block: the user is told and decides.
 */

import { formatElapsed } from './format';

/**
 * The longest prompt-cache lifetime we can count on. Past it the context is certainly re-created;
 * inside it, it may or may not still be warm, so nothing is said. Deliberately the longer figure:
 * a line that cries wolf on a follow-up sent twenty minutes later would teach people to ignore it.
 */
export const CACHE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The line to show under the composer of a finished task, or null when there is nothing to say.
 * `finishedAt` is the task's `statusChangedAt` — when it last stopped running, which is also when
 * its sessions last spoke.
 */
export function coldSessionNote(finishedAt: string | null | undefined, now: number): string | null {
  if (!finishedAt) return null;
  const at = Date.parse(finishedAt);
  if (Number.isNaN(at)) return null;
  const idle = now - at;
  if (idle < CACHE_WINDOW_MS) return null;
  return `Finished ${formatElapsed(idle)} ago — resuming re-creates this task's context, so a follow-up now costs more than one sent right after it ended.`;
}
