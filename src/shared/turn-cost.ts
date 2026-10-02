/**
 * A turn's own cost and model usage (SPEC.md §15, "A turn's cost is the change in its session's running
 * total"). In a session continued with `--resume`, the CLI's `total_cost_usd` and `modelUsage` are the
 * session's running totals; a turn's own share is the difference from the same session's previous turn.
 * Pure, so the session runner, the orchestrator, the timeline and the evaluation read turns the same way.
 */

export interface RunningTotals {
  costUsd: number | null;
  modelUsage: Record<string, unknown>;
}

/** The `modelUsage` fields that add up turn by turn; the others (context window, output limit) do not. */
const ADDITIVE = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD', 'webSearchRequests'] as const;

/** Floating-point slack when a running total is compared with the one before it. */
const EPSILON = 1e-9;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** now − prev, or `now` itself when the total went down (a counter that started again): never less than was spent. */
function difference(now: number, prev: number): number {
  if (now + EPSILON < prev) return now;
  return Math.max(0, now - prev);
}

/** One model's share of a turn; null when it did nothing in this turn. */
function modelShare(now: Record<string, unknown>, prev: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!prev) return now;
  // A counter that went down means the totals started again: the whole entry is this turn's.
  if (ADDITIVE.some((k) => num(now[k]) + EPSILON < num(prev[k]))) return now;
  const out: Record<string, unknown> = { ...now };
  let any = false;
  for (const k of ADDITIVE) {
    if (!(k in now)) continue;
    const d = Math.max(0, num(now[k]) - num(prev[k]));
    out[k] = d;
    if (d > EPSILON) any = true;
  }
  return any ? out : null;
}

/** The turn's own share, given the session's running totals before it (null for a new session). */
export function ownShare(prev: RunningTotals | null, now: RunningTotals): RunningTotals {
  const costUsd = now.costUsd === null ? null : prev === null || prev.costUsd === null ? now.costUsd : difference(now.costUsd, prev.costUsd);
  const modelUsage: Record<string, unknown> = {};
  for (const [model, entry] of Object.entries(now.modelUsage)) {
    if (!isRecord(entry)) continue;
    const before = prev && isRecord(prev.modelUsage[model]) ? (prev.modelUsage[model] as Record<string, unknown>) : null;
    const share = modelShare(entry, before);
    if (share) modelUsage[model] = share;
  }
  return { costUsd, modelUsage };
}

/** What a turn record holds (task events, bench results): new records carry both, older ones the totals only. */
export interface TurnUsageLike {
  sessionId: string;
  usage: {
    costUsd: number | null;
    modelUsage: Record<string, unknown>;
    /** The running totals as reported; absent in records made before 2026-09-27. */
    sessionCostUsd?: number | null;
    sessionModelUsage?: Record<string, unknown>;
  } | null;
}

/**
 * Reads turn records in order and gives each one's own share. A record made before the rule holds the running
 * totals under the own-share names; it is read as the difference from its session's previous turn.
 */
export function turnShareReader(): { own(record: TurnUsageLike): RunningTotals | null; totals(): Map<string, RunningTotals> } {
  const last = new Map<string, RunningTotals>();
  return {
    own(record) {
      const u = record.usage;
      if (!u) return null;
      if (u.sessionCostUsd !== undefined) {
        if (u.sessionCostUsd !== null) last.set(record.sessionId, { costUsd: u.sessionCostUsd, modelUsage: u.sessionModelUsage ?? {} });
        return { costUsd: u.costUsd, modelUsage: u.modelUsage };
      }
      if (u.costUsd === null) return { costUsd: null, modelUsage: {} };
      const now = { costUsd: u.costUsd, modelUsage: u.modelUsage };
      const share = ownShare(last.get(record.sessionId) ?? null, now);
      last.set(record.sessionId, now);
      return share;
    },
    totals: () => last,
  };
}
