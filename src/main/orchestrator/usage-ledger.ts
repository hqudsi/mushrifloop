/**
 * usage.json (SPEC.md §17): the local token estimate, plus the latest plan utilization Claude Code
 * reported. The estimate is `modelUsage` summed per local day across all tasks; it is labelled an
 * estimate and never presented as the official quota.
 */

import * as fs from 'node:fs';

import { writeJsonAtomic } from '../atomic-write';
import type { RateLimitInfo } from '../session-runner/types';
import { localDay } from './safety';
import type { UsageLedgerPort } from './types';

export interface ModelDayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** One window's last reading. `at` is when it was reported; files written before 2026-09-26 lack it. */
export interface StoredWindow {
  utilization: number | null;
  resetsAt: number | null;
  at?: string;
}

export interface UsageFile {
  version: 1;
  /** Local day → model → totals. */
  days: Record<string, Record<string, ModelDayUsage>>;
  /**
   * The latest plan utilization, as reported by Claude Code (never computed here). `at` is the newest
   * reading; each window keeps its own (SPEC.md §17). `status` and `rateLimitType` come from the last turn.
   */
  latest: {
    at: string;
    status: string | null;
    rateLimitType: string | null;
    windows: Record<string, StoredWindow>;
  } | null;
}

const KEEP_DAYS = 35;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function empty(): UsageFile {
  return { version: 1, days: {}, latest: null };
}

/** Tokens counted towards the estimate: every token the models processed or produced. */
export function totalTokens(u: ModelDayUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `2026-09-17T10-11-12-345Z` — a timestamp that is valid in a file name. */
export function fileStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

export class UsageLedger implements UsageLedgerPort {
  /**
   * What went wrong with usage.json, for the usage panel (SPEC.md §9). A corrupt file stays reported for
   * the rest of the session; a failed read clears once a read succeeds.
   */
  problem: string | null = null;
  private corruptNote: string | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The ledger, or empty when it cannot be read (the reason is in `problem`). */
  read(): UsageFile {
    return this.load() ?? empty();
  }

  /** null = the file exists but cannot be used, so nothing may be written over it. */
  private load(): UsageFile | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.problem = this.corruptNote;
        return empty();
      }
      this.problem = `${this.file} could not be read (${message(err)}); the estimate is not updated until it can be.`;
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      if (!isObject(parsed) || (parsed['days'] !== undefined && !isObject(parsed['days']))) throw new Error('not a usage ledger');
    } catch (err) {
      // Never overwrite it: keep it next to the new one and say so.
      const backup = `${this.file}.corrupt-${fileStamp(this.now())}`;
      try {
        fs.renameSync(this.file, backup);
      } catch (moveErr) {
        this.problem = `${this.file} is unreadable (${message(err)}) and could not be moved aside (${message(moveErr)}); it is left as it is and the estimate is not updated.`;
        return null;
      }
      this.corruptNote = `${this.file} was unreadable (${message(err)}). It was kept as ${backup}, and the local estimate started again.`;
      this.problem = this.corruptNote;
      return empty();
    }
    this.problem = this.corruptNote;
    const data = parsed as Partial<UsageFile>;
    return { version: 1, days: data.days ?? {}, latest: data.latest ?? null };
  }

  record(at: Date, modelUsage: Record<string, unknown>): void {
    const entries = Object.entries(modelUsage);
    if (entries.length === 0) return;
    const data = this.load();
    if (!data) return;
    const day = localDay(at);
    const bucket = (data.days[day] ??= {});
    for (const [model, raw] of entries) {
      const u = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const cur = (bucket[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
      cur.inputTokens += num(u['inputTokens']);
      cur.outputTokens += num(u['outputTokens']);
      cur.cacheReadTokens += num(u['cacheReadInputTokens']);
      cur.cacheCreationTokens += num(u['cacheCreationInputTokens']);
      cur.costUsd += num(u['costUSD']);
    }
    const cutoff = localDay(new Date(at.getTime() - KEEP_DAYS * 86_400_000));
    for (const key of Object.keys(data.days)) if (key < cutoff) delete data.days[key];
    writeJsonAtomic(this.file, data);
  }

  /** A turn's `rate_limit_event` windows. */
  recordWindows(at: Date, info: RateLimitInfo): void {
    this.mergeWindows(at, info.windows, { status: info.status, rateLimitType: info.rateLimitType });
  }

  /** `/usage`'s structured report (SPEC.md §17). */
  recordUsageReport(at: Date, windows: Record<string, { utilization: number | null; resetsAt: number | null }>): void {
    this.mergeWindows(at, windows, null);
  }

  /**
   * A reading replaces the windows it carries and keeps the others, each with the time it was reported: a
   * turn reports two windows and `/usage` three, so a turn must not wipe the per-model week (SPEC.md §17).
   */
  private mergeWindows(
    at: Date,
    windows: Record<string, { utilization: number | null; resetsAt: number | null }>,
    turn: { status: string | null; rateLimitType: string | null } | null,
  ): void {
    if (Object.keys(windows).length === 0) return;
    const data = this.load();
    if (!data) return;
    const stamp = at.toISOString();
    const prev = data.latest;
    const merged: Record<string, StoredWindow> = {};
    if (prev) for (const [key, w] of Object.entries(prev.windows)) merged[key] = { utilization: w.utilization, resetsAt: w.resetsAt, at: w.at ?? prev.at };
    for (const [key, w] of Object.entries(windows)) merged[key] = { utilization: w.utilization, resetsAt: w.resetsAt, at: stamp };
    data.latest = {
      at: stamp,
      status: turn ? turn.status : (prev?.status ?? null),
      rateLimitType: turn ? turn.rateLimitType : (prev?.rateLimitType ?? null),
      windows: merged,
    };
    writeJsonAtomic(this.file, data);
  }

  tokensOn(day: string): number {
    const bucket = this.read().days[day] ?? {};
    return Object.values(bucket).reduce((sum, u) => sum + totalTokens(u), 0);
  }

  /** Rolling 7 local days ending on `day`. */
  tokensLast7Days(at: Date): number {
    const data = this.read();
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const bucket = data.days[localDay(new Date(at.getTime() - i * 86_400_000))] ?? {};
      sum += Object.values(bucket).reduce((s, u) => s + totalTokens(u), 0);
    }
    return sum;
  }
}
