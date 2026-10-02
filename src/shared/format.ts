/**
 * Display formatting used by the main screen (design/: "2m 08s", "1.8s", "2.1k tok", "23m").
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** "Stopping <task>…" while Quit and stop waits (SPEC.md §6). */
/**
 * A file path with forward slashes (SPEC.md §4, decided 2026-09-18). A lone backslash inside a JSON string
 * is an invalid escape, which is the visible cause of most answers the CLI refused in Step C, so the app
 * never hands an agent a Windows-style path to copy. Only separators change: a drive letter, spaces and the
 * rest of the text are left alone.
 */
export function posixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** The same, for a list of paths. */
export function posixPaths(values: readonly string[]): string[] {
  return values.map(posixPath);
}

export function stoppingText(tasks: readonly { title: string }[]): string {
  // A shortened title already ends in an ellipsis.
  return tasks.length === 1 ? `Stopping ${tasks[0]?.title.replace(/…$/, '')}…` : `Stopping ${tasks.length} tasks…`;
}

/**
 * A length of time in its two largest units (SPEC.md §10): `1.8s`, `42s`, `2m 08s`, `1h 05m`, and from a day
 * on `5d 11h` rather than `131h 40m`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`;
}

/** A coarser length of time, for ages (the task list, "Finished … ago"): `<1m`, `23m`, `1h 05m`, `2d 3h`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `2.1k`, `967k`, `1.2M`. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Local wall-clock time, `14:02:11`. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local date and time for longer spans, `Sep 16, 14:02`. */
export function formatDateTime(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A moment, as a clock time when it falls today and with its date otherwise (SPEC.md §10): `21:00`, or
 * `Oct 1, 21:00` for a weekly reset, which a clock time alone would make read as today.
 */
export function formatMoment(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return isSameLocalDay(ms, nowMs) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : formatDateTime(ms);
}

/** Whether two moments fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** `$0.169`. */
export function formatCost(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? '' : `$${usd.toFixed(3)}`;
}

export interface TextSegment {
  code: boolean;
  bold: boolean;
  text: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Where the code span opened by the backtick at `open` ends, or -1. A backtick only closes a span when
 * no letter or digit follows it, so PowerShell escapes inside a span (`` `t`r`n ``) stay in it instead of
 * cutting the span into pieces (found in Phase 5: the Planner writes such commands). Spans stay on one line.
 */
function codeSpanEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') return -1;
    if (c !== '`' || i === open + 1) continue;
    const next = text[i + 1];
    if (next === undefined || !WORD_CHAR.test(next)) return i;
  }
  return -1;
}

/**
 * Split agent text into plain, `code` and **bold** segments, for rendering without HTML. Only these two
 * markers are understood; everything else stays literal text.
 */
export function codeSegments(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ code: false, bold: false, text: plain });
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    const prev = i > 0 ? (text[i - 1] ?? '') : '';
    if (c === '`' && !WORD_CHAR.test(prev)) {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        flush();
        out.push({ code: true, bold: false, text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      const inner = end > i + 2 ? text.slice(i + 2, end) : '';
      if (inner && !inner.includes('\n') && !inner.includes('*')) {
        flush();
        out.push({ code: false, bold: true, text: inner });
        i = end + 2;
        continue;
      }
    }
    plain += c;
    i += 1;
  }
  flush();
  return out;
}
