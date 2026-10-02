/**
 * Incremental parsing of `--output-format stream-json` (one JSON object per line).
 *
 * Pure: a line splitter that copes with chunks cut anywhere, a mapper from raw messages to TurnEvents,
 * and an accumulator that keeps just what classification needs.
 */

import type { AnswerRejections, RateLimitInfo, SkillInvocation, TurnEvent } from './types';

/** The tool the CLI adds for `--json-schema`: the agent answers by calling it (SPEC.md §3.1). */
export const ANSWER_TOOL = 'StructuredOutput';

/** A refusal reason as the card shows it: one line, bounded. */
function reasonText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** Splits a byte stream into complete lines; keeps the unfinished tail for the next chunk. */
export class LineSplitter {
  private tail = '';

  push(chunk: string): string[] {
    const text = this.tail + chunk;
    const parts = text.split('\n');
    this.tail = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.tail.replace(/\r$/, '');
    this.tail = '';
    return rest.length > 0 ? [rest] : [];
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toRateLimitInfo(value: unknown): RateLimitInfo {
  const info = isRecord(value) ? value : {};
  const windows: RateLimitInfo['windows'] = {};
  const unified = info['unifiedWindows'];
  if (isRecord(unified)) {
    for (const [name, w] of Object.entries(unified)) {
      if (isRecord(w)) windows[name] = { utilization: num(w['utilization']), resetsAt: num(w['resetsAt']) };
    }
  }
  return {
    windows,
    status: str(info['status']),
    resetsAt: num(info['resetsAt']),
    rateLimitType: str(info['rateLimitType']),
    overageStatus: str(info['overageStatus']),
    overageDisabledReason: str(info['overageDisabledReason']),
  };
}

/** tool_result content is a string or an array of blocks; flatten it for display. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}

/** One raw message can carry several content blocks, hence several events. */
export function toEvents(message: unknown): TurnEvent[] {
  if (!isRecord(message)) return [];
  const type = str(message['type']) ?? 'unknown';
  const subtype = str(message['subtype']);
  const parentToolUseId = str(message['parent_tool_use_id']);
  const base = { raw: message, parentToolUseId };

  if (type === 'system' && subtype === 'init') {
    return [
      {
        ...base,
        kind: 'init',
        sessionId: str(message['session_id']),
        model: str(message['model']),
        tools: strings(message['tools']),
        skills: strings(message['skills']),
        slashCommands: strings(message['slash_commands']),
        permissionMode: str(message['permissionMode']),
        cwd: str(message['cwd']),
        cliVersion: str(message['claude_code_version']),
      },
    ];
  }
  if (type === 'system' && subtype === 'api_retry') {
    return [
      {
        ...base,
        kind: 'api_retry',
        attempt: num(message['attempt']),
        maxRetries: num(message['max_retries']),
        errorStatus: num(message['error_status']),
        error: str(message['error']),
      },
    ];
  }
  if (type === 'rate_limit_event') {
    return [{ ...base, kind: 'rate_limit', info: toRateLimitInfo(message['rate_limit_info']) }];
  }
  if (type === 'result') {
    return [{ ...base, kind: 'result', subtype, isError: message['is_error'] === true }];
  }
  if (type === 'assistant' || type === 'user') {
    const inner = isRecord(message['message']) ? message['message'] : {};
    const content = inner['content'];
    if (typeof content === 'string') return type === 'user' ? [] : [{ ...base, kind: 'text', text: content }];
    const events: TurnEvent[] = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block)) continue;
      const blockType = str(block['type']);
      if (blockType === 'text' && type === 'assistant') {
        events.push({ ...base, kind: 'text', text: str(block['text']) ?? '' });
      } else if (blockType === 'thinking') {
        events.push({ ...base, kind: 'thinking' });
      } else if (blockType === 'tool_use') {
        events.push({
          ...base,
          kind: 'tool_use',
          toolUseId: str(block['id']) ?? '',
          name: str(block['name']) ?? '',
          input: block['input'],
        });
      } else if (blockType === 'tool_result') {
        events.push({
          ...base,
          kind: 'tool_result',
          toolUseId: str(block['tool_use_id']) ?? '',
          isError: block['is_error'] === true,
          content: contentText(block['content']),
        });
      }
    }
    return events;
  }
  // thinking_tokens and friends are frequent and carry nothing a supervisor needs.
  if (type === 'system' && subtype === 'thinking_tokens') return [];
  return [{ ...base, kind: 'other', type, subtype }];
}

/** What classification needs, gathered while the stream is read. */
export class TurnAccumulator {
  init: Json | null = null;
  /** Every result message, in order. One process can emit several (see `result`). */
  readonly results: Json[] = [];
  rateLimit: RateLimitInfo | null = null;
  rejectedRateLimit: RateLimitInfo | null = null;
  /** Usage of the most recent main-thread assistant message — fallback for context size. */
  lastAssistantUsage: Json | null = null;
  /** `error` on a synthetic API-error assistant message, e.g. `rate_limit`, `authentication_failed`. */
  assistantError: string | null = null;
  readonly skills = new Map<string, SkillInvocation>();
  readonly unparsed: string[] = [];
  /** Main-thread tool calls by name, the answer tool left out. */
  readonly toolUses: Record<string, number> = {};
  /** Answer-tool calls: id → size of the attempt (as JSON). */
  private readonly answerAttempts = new Map<string, number>();
  private readonly refused: Array<{ reason: string; chars: number }> = [];

  /** SPEC.md §3.5: every answer the CLI refused. The count comes from `is_error`; the text is for display. */
  get answerRejections(): AnswerRejections {
    const reasons: string[] = [];
    for (const r of this.refused) if (!reasons.includes(r.reason)) reasons.push(r.reason);
    return {
      count: this.refused.length,
      reasons,
      largestAttemptChars: this.refused.reduce((max, r) => Math.max(max, r.chars), 0),
    };
  }

  /**
   * The result that answers *our* prompt.
   *
   * A resumed session can first deliver something left pending by the previous process — observed:
   * a "background task stopped" notification — as an empty turn with its own result
   * (`num_turns: 0`, no model call, no structured output). So: the last result carrying structured
   * output; else the last one that did real work or reports an error; else the last one.
   */
  get result(): Json | null {
    const reversed = [...this.results].reverse();
    return (
      reversed.find((r) => r['structured_output'] !== undefined && r['structured_output'] !== null) ??
      reversed.find((r) => r['is_error'] === true || (typeof r['num_turns'] === 'number' && r['num_turns'] > 0)) ??
      reversed[0] ??
      null
    );
  }

  /** Feed one stdout line. Returns the events it produced. */
  addLine(line: string): TurnEvent[] {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.unparsed.push(line);
      return [{ kind: 'unparsed', line }];
    }
    if (!isRecord(message)) return [];

    const type = message['type'];
    if (type === 'system' && message['subtype'] === 'init') this.init = message;
    if (type === 'result') this.results.push(message);
    if (type === 'assistant' && !message['parent_tool_use_id'] && isRecord(message['message'])) {
      const usage = message['message']['usage'];
      if (isRecord(usage) && message['message']['model'] !== '<synthetic>') this.lastAssistantUsage = usage;
      if (typeof message['error'] === 'string') this.assistantError = message['error'];
    }

    const events = toEvents(message);
    for (const event of events) {
      if (event.kind === 'rate_limit') {
        this.rateLimit = event.info;
        if (event.info.status === 'rejected') this.rejectedRateLimit = event.info;
      } else if (event.kind === 'tool_use' && !event.parentToolUseId) {
        if (event.name === ANSWER_TOOL) {
          this.answerAttempts.set(event.toolUseId, JSON.stringify(event.input ?? null).length);
          continue;
        }
        this.toolUses[event.name] = (this.toolUses[event.name] ?? 0) + 1;
        if (event.name === 'Skill') {
          const input = isRecord(event.input) ? event.input : {};
          this.skills.set(event.toolUseId, {
            skill: str(input['skill']) ?? '',
            toolUseId: event.toolUseId,
            isError: null,
            resultText: null,
          });
        }
      } else if (event.kind === 'tool_result') {
        const skill = this.skills.get(event.toolUseId);
        if (skill) {
          skill.isError = event.isError;
          skill.resultText = event.content;
        }
        const attempt = this.answerAttempts.get(event.toolUseId);
        if (attempt !== undefined && event.isError) {
          this.refused.push({ reason: reasonText(event.content), chars: attempt });
        }
      }
    }
    return events;
  }
}
