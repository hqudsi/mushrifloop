/**
 * What an agent did during one turn — tool calls, commands, files touched — as display rows.
 *
 * Pure and shared: the main process builds it from a finished turn's raw stream-json file, and the
 * renderer extends it live from streamed events. Display only; nothing here drives control flow.
 */

import type { LiveTurnEvent } from './task-model';

export interface ActivityRow {
  /** Stable key: the tool-use id, or a sequence-based id. */
  id: string;
  kind: 'tool' | 'text' | 'stderr' | 'notice';
  /** Tool name, for `tool` rows. */
  tool: string | null;
  /** One line: the command, path, pattern, skill… */
  summary: string;
  /** Trimmed tool output once the result arrived (omitted for plain file reads and writes). */
  output: string | null;
  isError: boolean;
  /** A tool call whose result has not arrived yet. */
  pending: boolean;
  /** Happened inside a subagent. */
  subagent: boolean;
}

export interface TurnActivity {
  rows: ActivityRow[];
  /** Tool calls in the main conversation (the final StructuredOutput call is not counted). */
  toolCalls: number;
  /** Files the agent wrote or edited, relative to the project where possible. */
  filesTouched: string[];
  /** Number of events applied — live updates carry their sequence number, so none is applied twice. */
  seq: number;
  /** Rows dropped from the start to stay under the limit. */
  dropped: number;
  /** The turn's activity could not be read (SPEC.md §9): why, with the path. */
  error: string | null;
}

export const ACTIVITY_ROW_LIMIT = 400;
const OUTPUT_LIMIT = 800;
const SUMMARY_LIMIT = 300;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools whose successful output is the file itself — noise in a timeline. */
const QUIET_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Skill']);

export function emptyActivity(): TurnActivity {
  return { rows: [], toolCalls: 0, filesTouched: [], seq: 0, dropped: 0, error: null };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string): string {
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? '';
  return lines.length > 1 ? `${first} …` : first;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `C:\\proj\\src\\a.ts` → `src/a.ts` when inside the project (case-insensitive, either slash). */
export function relativePath(target: string, projectDir: string | null): string {
  const norm = target.replace(/\\/g, '/');
  if (!projectDir) return norm;
  const root = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return norm.slice(root.length + 1);
  return norm;
}

export function summarizeTool(name: string, input: unknown, projectDir: string | null): string {
  const i = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const path = (key: string) => {
    const v = str(i[key]);
    return v === null ? null : relativePath(v, projectDir);
  };
  let text: string;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      text = `$ ${firstLine(str(i['command']) ?? '')}`;
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      text = path('file_path') ?? '';
      break;
    case 'NotebookEdit':
      text = path('notebook_path') ?? path('file_path') ?? '';
      break;
    case 'Glob':
      text = `${str(i['pattern']) ?? ''}${path('path') ? ` in ${path('path')}` : ''}`;
      break;
    case 'Grep':
      text = `"${str(i['pattern']) ?? ''}"${path('path') ? ` ${path('path')}` : ''}${str(i['glob']) ? ` (${str(i['glob'])})` : ''}`;
      break;
    case 'Skill':
      text = str(i['skill']) ?? '';
      break;
    case 'WebFetch':
      text = str(i['url']) ?? '';
      break;
    case 'WebSearch':
      text = str(i['query']) ?? '';
      break;
    case 'TodoWrite':
      text = Array.isArray(i['todos']) ? `${i['todos'].length} to-do item(s)` : '';
      break;
    case 'Task':
    case 'Agent':
      text = str(i['description']) ?? str(i['prompt']) ?? '';
      break;
    default:
      text = JSON.stringify(input ?? {});
  }
  return clip(text.trim(), SUMMARY_LIMIT);
}

function pushRow(activity: TurnActivity, row: ActivityRow): void {
  activity.rows.push(row);
  const excess = activity.rows.length - ACTIVITY_ROW_LIMIT;
  if (excess > 0) {
    activity.rows.splice(0, excess);
    activity.dropped += excess;
  }
}

/** Apply one event, returning a new activity (the input is not modified). */
export function applyActivityEvent(activity: TurnActivity, event: LiveTurnEvent, projectDir: string | null): TurnActivity {
  const next: TurnActivity = { ...activity, rows: [...activity.rows], filesTouched: [...activity.filesTouched] };
  applyInPlace(next, event, projectDir);
  return next;
}

function applyInPlace(next: TurnActivity, event: LiveTurnEvent, projectDir: string | null): void {
  next.seq += 1;
  const subagent = 'parentToolUseId' in event && Boolean(event.parentToolUseId);
  const id = `e${next.seq}`;
  switch (event.kind) {
    case 'tool_use': {
      if (event.name === 'StructuredOutput') break;
      if (!subagent) next.toolCalls += 1;
      pushRow(next, {
        id: event.toolUseId || id,
        kind: 'tool',
        tool: event.name,
        summary: summarizeTool(event.name, event.input, projectDir),
        output: null,
        isError: false,
        pending: true,
        subagent,
      });
      if (FILE_TOOLS.has(event.name) && !subagent) {
        const input = typeof event.input === 'object' && event.input !== null ? (event.input as Record<string, unknown>) : {};
        const target = str(input['file_path']) ?? str(input['notebook_path']);
        if (target) {
          const rel = relativePath(target, projectDir);
          if (!next.filesTouched.includes(rel)) next.filesTouched.push(rel);
        }
      }
      break;
    }
    case 'tool_result': {
      const index = next.rows.findIndex((r) => r.kind === 'tool' && r.id === event.toolUseId);
      if (index < 0) break;
      const row = next.rows[index];
      if (!row) break;
      const content = event.content.trim();
      const quiet = row.tool !== null && QUIET_TOOLS.has(row.tool) && !event.isError;
      next.rows[index] = { ...row, pending: false, isError: event.isError, output: quiet || !content ? null : clip(content, OUTPUT_LIMIT) };
      break;
    }
    case 'text': {
      const text = event.text.trim();
      if (text) pushRow(next, { id, kind: 'text', tool: null, summary: clip(text, 600), output: null, isError: false, pending: false, subagent });
      break;
    }
    case 'stderr': {
      const text = event.text.trim();
      if (text) pushRow(next, { id, kind: 'stderr', tool: null, summary: clip(text, 600), output: null, isError: false, pending: false, subagent: false });
      break;
    }
    case 'api_retry':
      pushRow(next, {
        id,
        kind: 'notice',
        tool: null,
        summary: `API retry ${event.attempt ?? '?'}/${event.maxRetries ?? '?'}${event.errorStatus ? ` (HTTP ${event.errorStatus})` : ''}${event.error ? ` — ${event.error}` : ''}`,
        output: null,
        isError: true,
        pending: false,
        subagent,
      });
      break;
    case 'rate_limit':
      if (event.info.status && event.info.status !== 'allowed') {
        pushRow(next, {
          id,
          kind: 'notice',
          tool: null,
          summary: `Usage limit ${event.info.status}${event.info.rateLimitType ? ` (${event.info.rateLimitType})` : ''}`,
          output: null,
          isError: event.info.status === 'rejected',
          pending: false,
          subagent: false,
        });
      }
      break;
    case 'slow_turn':
      pushRow(next, {
        id,
        kind: 'notice',
        tool: null,
        summary: `Slow turn: still running after ${Math.round(event.elapsedMs / 1000)} s`,
        output: null,
        isError: false,
        pending: false,
        subagent: false,
      });
      break;
    case 'result':
      // The turn is over: nothing is pending any more.
      for (let i = 0; i < next.rows.length; i++) {
        const r = next.rows[i];
        if (r?.pending) next.rows[i] = { ...r, pending: false };
      }
      break;
    default:
      break;
  }
}

/** Build the activity of a whole turn at once. */
export function activityFromEvents(events: Iterable<LiveTurnEvent>, projectDir: string | null): TurnActivity {
  const activity = emptyActivity();
  for (const event of events) applyInPlace(activity, event, projectDir);
  return activity;
}
