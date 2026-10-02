import { describe, expect, it } from 'vitest';

import { parseUsageStream, windowsFromUsageReport } from './usage-report';

/** The `usage_report` of `claude -p "/usage" --output-format stream-json --verbose` on CLI 2.1.280 (NOTES.md §44). */
const REPORT_2_1_280 = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 2768, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  rate_limits: {
    limits: [
      { kind: 'session', group: 'session', percent: 20, resets_at: '2026-09-26T08:19:59.962765+00:00', scope: null, severity: 'normal', is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 5, resets_at: '2026-10-01T17:59:59.962786+00:00', scope: null, severity: 'normal', is_active: false },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 0,
        resets_at: '2026-10-01T18:00:00+00:00',
        scope: { model: { display_name: 'Fable' }, surface: null },
        severity: 'normal',
        is_active: false,
      },
    ],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
  },
};

const line = (value: unknown) => JSON.stringify(value);

function stream(report: unknown, result: Record<string, unknown> = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0 }): string {
  return [
    line({ type: 'system', subtype: 'init', claude_code_version: '2.1.280' }),
    line({ type: 'assistant', message: { content: [] }, local_command_run: { command: 'usage', args: '' }, usage_report: report }),
    line(result),
  ].join('\n');
}

describe('/usage structured report (SPEC.md §17)', () => {
  it('reads the limits as windows keyed like a turn’s, with fractions and epoch seconds', () => {
    expect(windowsFromUsageReport(REPORT_2_1_280)).toEqual({
      five_hour: { utilization: 0.2, resetsAt: Math.round(Date.parse('2026-09-26T08:19:59.962765+00:00') / 1000) },
      seven_day: { utilization: 0.05, resetsAt: Math.round(Date.parse('2026-10-01T17:59:59.962786+00:00') / 1000) },
      seven_day_fable: { utilization: 0, resetsAt: Date.parse('2026-10-01T18:00:00+00:00') / 1000 },
    });
  });

  it('parses a whole stream-json run, CRLF included', () => {
    const parsed = parseUsageStream(stream(REPORT_2_1_280).replace(/\n/g, '\r\n'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.windows)).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
  });

  it('keeps unknown kinds and tolerates missing fields (forward-compatible)', () => {
    const windows = windowsFromUsageReport({
      rate_limits: {
        limits: [
          { kind: 'monthly_something', percent: 12.5 },
          { kind: 'weekly_scoped', percent: 3, resets_at: 'not a date', scope: { model: { display_name: 'Opus 5.5' } } },
          { percent: 50 },
          'junk',
        ],
      },
    });
    expect(windows).toEqual({
      monthly_something: { utilization: 0.125, resetsAt: null },
      seven_day_opus_5_5: { utilization: 0.03, resetsAt: null },
    });
  });

  it('reports what went wrong instead of inventing figures', () => {
    expect(parseUsageStream('')).toEqual({ ok: false, error: 'returned no result' });
    expect(parseUsageStream(line({ type: 'result', is_error: false }))).toEqual({ ok: false, error: 'returned no usage report' });
    expect(parseUsageStream(stream({ rate_limits: { limits: [] } }))).toEqual({ ok: false, error: 'returned a usage report with no limits' });
    expect(parseUsageStream(stream(REPORT_2_1_280, { type: 'result', is_error: true, result: 'Not logged in · Please run /login' }))).toEqual({
      ok: false,
      error: 'failed: Not logged in · Please run /login',
    });
  });
});
