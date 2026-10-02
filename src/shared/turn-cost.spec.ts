/** A turn's own cost and model usage (SPEC.md §15): the change in its session's running totals. */
import { describe, expect, it } from 'vitest';

import { ownShare, turnShareReader, type TurnUsageLike } from './turn-cost';

const mu = (costUSD: number, outputTokens: number, extra: Record<string, unknown> = {}) => ({
  inputTokens: 10,
  outputTokens,
  cacheReadInputTokens: 1000,
  cacheCreationInputTokens: 0,
  costUSD,
  contextWindow: 200_000,
  ...extra,
});

describe('ownShare', () => {
  it('a new session: the whole total is the turn’s', () => {
    const now = { costUsd: 4.511, modelUsage: { 'claude-sonnet-5': mu(4.511, 80_310) } };
    expect(ownShare(null, now)).toEqual(now);
  });

  it('a resumed session: the difference from its previous turn (the pilot’s Executor, NOTES.md §51.8)', () => {
    const turn1 = { costUsd: 4.511, modelUsage: { 'claude-sonnet-5': mu(4.511, 80_310) } };
    const turn2 = { costUsd: 8.01, modelUsage: { 'claude-sonnet-5': { ...mu(8.01, 113_164), inputTokens: 20, cacheReadInputTokens: 2000 } } };
    const own = ownShare(turn1, turn2);
    expect(own.costUsd).toBeCloseTo(3.499);
    expect(own.modelUsage['claude-sonnet-5']).toMatchObject({ outputTokens: 32_854, inputTokens: 10, cacheReadInputTokens: 1000, contextWindow: 200_000 });
    expect((own.modelUsage['claude-sonnet-5'] as { costUSD: number }).costUSD).toBeCloseTo(3.499);
  });

  it('leaves out a model that did nothing in this turn, and keeps one that is new in it', () => {
    const before = { costUsd: 1, modelUsage: { 'claude-opus-5-5': mu(1, 100) } };
    const now = { costUsd: 1.2, modelUsage: { 'claude-opus-5-5': mu(1, 100), 'claude-haiku-4-5': mu(0.2, 30) } };
    expect(Object.keys(ownShare(before, now).modelUsage)).toEqual(['claude-haiku-4-5']);
  });

  it('a total that went down started again: the turn gets all of it, never less than was spent', () => {
    const own = ownShare({ costUsd: 5, modelUsage: { m: mu(5, 500) } }, { costUsd: 0.4, modelUsage: { m: mu(0.4, 40) } });
    expect(own.costUsd).toBe(0.4);
    expect(own.modelUsage['m']).toMatchObject({ costUSD: 0.4, outputTokens: 40 });
  });

  it('an unknown cost stays unknown, and an unknown previous one counts as zero', () => {
    expect(ownShare({ costUsd: 1, modelUsage: {} }, { costUsd: null, modelUsage: {} }).costUsd).toBeNull();
    expect(ownShare({ costUsd: null, modelUsage: {} }, { costUsd: 0.7, modelUsage: {} }).costUsd).toBe(0.7);
  });
});

describe('turnShareReader', () => {
  const rec = (sessionId: string, costUsd: number | null, session?: number | null): TurnUsageLike => ({
    sessionId,
    usage: { costUsd, modelUsage: {}, ...(session === undefined ? {} : { sessionCostUsd: session, sessionModelUsage: {} }) },
  });

  it('reads older records (running totals) and newer ones (own share) alike, session by session', () => {
    const r = turnShareReader();
    expect(r.own(rec('p', 0.337))?.costUsd).toBeCloseTo(0.337); // older: the running total
    expect(r.own(rec('e', 4.511))?.costUsd).toBeCloseTo(4.511);
    expect(r.own(rec('p', 0.488))?.costUsd).toBeCloseTo(0.151);
    expect(r.own(rec('e', 3.499, 8.01))?.costUsd).toBeCloseTo(3.499); // newer: already its own
    expect(r.own(rec('e', 8.343))?.costUsd).toBeCloseTo(0.333); // an older one after it still subtracts
    expect(r.own({ sessionId: 'x', usage: null })).toBeNull();
    expect(Object.fromEntries([...r.totals()].map(([k, v]) => [k, v.costUsd]))).toEqual({ p: 0.488, e: 8.343 });
  });
});
