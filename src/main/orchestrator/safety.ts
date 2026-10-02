/**
 * Pure checks behind the safety nets of SPEC.md §5 and the rollover trigger of §15.
 */

import { rolloverThresholdFor } from '../../shared/models';
import type { TurnTrace } from '../../shared/task-model';

export type { TurnTrace };

/** How many consecutive Executor turns with the same changed-file set count as ping-pong (§5 net 2). */
export const PING_PONG_TURNS = 3;
/** Consecutive refused Planner answers before the loop pauses for the user. */
export const MAX_CONSECUTIVE_REFUSALS = 3;

/** Whitespace-insensitive form used to compare instructions. */
export function normalizeInstruction(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** §5 net 2, first half: the same instruction twice in a row. */
export function isRepeatedInstruction(previous: string | null, next: string): boolean {
  return previous !== null && previous === normalizeInstruction(next);
}

/** Paths compared as the same file regardless of slash direction, `./` prefix or (on Windows) case. */
export function normalizeFileSet(paths: readonly string[], caseInsensitive: boolean): string[] {
  const cleaned = paths
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0)
    .map((p) => (caseInsensitive ? p.toLowerCase() : p));
  return Array.from(new Set(cleaned)).sort();
}

/**
 * Two instructions "repeat in substance" when their word sets overlap at least this much (Jaccard).
 * A heuristic on the schema-validated `next_instruction` field, decided 2026-09-16 to cut false alarms
 * of the file ping-pong net; tune it from real `loop_detected` events (they record the similarity).
 */
export const INSTRUCTION_SIMILARITY = 0.5;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'then', 'than', 'from', 'into', 'onto', 'only', 'each',
  'all', 'any', 'are', 'was', 'were', 'not', 'but', 'you', 'your', 'its', 'has', 'have', 'had', 'will',
  'should', 'must', 'can', 'use', 'using', 'make', 'sure', 'report', 'back', 'run', 'file', 'files',
]);

function wordSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_.\/-]+/gu) ?? [];
  return new Set(words.map((w) => w.replace(/^[.\/-]+|[.\/-]+$/g, '')).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of the two instructions' significant words, 0…1. */
export function instructionSimilarity(a: string, b: string): number {
  if (normalizeInstruction(a) === normalizeInstruction(b)) return 1;
  const x = wordSet(a);
  const y = wordSet(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Record one Executor turn and report file ping-pong (§5 net 2, second half): the same non-empty set of
 * files changed in {@link PING_PONG_TURNS} consecutive Executor turns **and** the instructions of those
 * turns repeat in substance (each within {@link INSTRUCTION_SIMILARITY} of the next). A turn that
 * changed nothing breaks the streak. Returns the new history (newest last, bounded), whether the net
 * fires, and the lowest pairwise similarity in the window (for the event).
 */
export function trackTurns(
  history: readonly TurnTrace[],
  turn: TurnTrace,
): { history: TurnTrace[]; pingPong: boolean; similarity: number | null } {
  if (turn.files.length === 0) return { history: [], pingPong: false, similarity: null };
  const next = [...history, { files: [...turn.files], instruction: turn.instruction }].slice(-PING_PONG_TURNS);
  if (next.length < PING_PONG_TURNS) return { history: next, pingPong: false, similarity: null };
  const key = JSON.stringify(turn.files);
  if (!next.every((t) => JSON.stringify(t.files) === key)) return { history: next, pingPong: false, similarity: null };
  let lowest = 1;
  for (let i = 1; i < next.length; i++) {
    const a = next[i - 1]?.instruction ?? null;
    const b = next[i]?.instruction ?? null;
    lowest = Math.min(lowest, a === null || b === null ? 0 : instructionSimilarity(a, b));
  }
  return { history: next, pingPong: lowest >= INSTRUCTION_SIMILARITY, similarity: lowest };
}

/** §15: roll over when the last turn's context exceeds rolloverPercent × the model's auto-compact threshold. */
export function rolloverDue(contextTokens: number | null, model: string, rolloverPercent: number): { due: boolean; threshold: number } {
  const threshold = rolloverThresholdFor(model, rolloverPercent);
  return { due: contextTokens !== null && contextTokens > threshold, threshold };
}

/** Local calendar day, `YYYY-MM-DD`, for the usage estimate. */
export function localDay(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
