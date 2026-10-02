/**
 * `claude -p "/usage" --output-format stream-json --verbose` (SPEC.md §17). It makes no model call, and on
 * CLI 2.1.280 its `assistant` event carries a structured `usage_report.rate_limits.limits[]` (NOTES.md §44).
 * This reads that, and never the text: `kind`, `percent`, `resets_at`, and a scoped limit's model name.
 */

export interface UsageReading {
  /** Fraction 0…1, like a turn's `unifiedWindows`. */
  utilization: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
}

export type UsageStreamResult = { ok: true; windows: Record<string, UsageReading> } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A limit's key, named like a turn's windows so the two sources update the same bar. */
function windowKey(limit: Record<string, unknown>): string | null {
  const kind = typeof limit['kind'] === 'string' ? limit['kind'] : null;
  if (kind === 'session') return 'five_hour';
  if (kind === 'weekly_all') return 'seven_day';
  const scope = isRecord(limit['scope']) ? limit['scope'] : null;
  const model = scope && isRecord(scope['model']) ? scope['model'] : null;
  const name = model && typeof model['display_name'] === 'string' ? model['display_name'].trim() : '';
  if (kind === 'weekly_scoped' && name) return `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  return kind;
}

/** `usage_report` → windows. Null when it has no list of limits. */
export function windowsFromUsageReport(report: unknown): Record<string, UsageReading> | null {
  const rateLimits = isRecord(report) && isRecord(report['rate_limits']) ? report['rate_limits'] : null;
  const limits = rateLimits?.['limits'];
  if (!Array.isArray(limits)) return null;
  const out: Record<string, UsageReading> = {};
  for (const limit of limits) {
    if (!isRecord(limit)) continue;
    const key = windowKey(limit);
    if (!key) continue;
    const percent = typeof limit['percent'] === 'number' && Number.isFinite(limit['percent']) ? limit['percent'] : null;
    const resets = typeof limit['resets_at'] === 'string' ? Date.parse(limit['resets_at']) : Number.NaN;
    out[key] = { utilization: percent === null ? null : percent / 100, resetsAt: Number.isNaN(resets) ? null : Math.round(resets / 1000) };
  }
  return out;
}

/** The whole stdout of a `/usage` run in stream-json. */
export function parseUsageStream(stdout: string): UsageStreamResult {
  let report: unknown;
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (isRecord(event['usage_report'])) report = event['usage_report'];
    if (event['type'] === 'result') result = event;
  }
  if (result?.['is_error'] === true) {
    const said = typeof result['result'] === 'string' ? result['result'].trim().slice(0, 300) : '';
    return { ok: false, error: `failed${said ? `: ${said}` : ''}` };
  }
  if (report === undefined) return { ok: false, error: result ? 'returned no usage report' : 'returned no result' };
  const windows = windowsFromUsageReport(report);
  if (!windows || Object.keys(windows).length === 0) return { ok: false, error: 'returned a usage report with no limits' };
  return { ok: true, windows };
}
