/**
 * Turn the accumulated stream + process facts into a TurnOutcome (SPEC.md §3.5, §5, §8, §15–§17).
 *
 * Pure. The order of checks matters: what the process *did* (spawn failure, stop, timeout, rate-limit
 * kill) comes first; then what the CLI *said* (`is_error`, `terminal_reason`, `api_error_status`,
 * error subtypes — never `subtype` alone); then whether the answer satisfies our schema.
 */

import { baseModelId, servedModelMatches } from '../../shared/models';
import { ownShare, type RunningTotals } from '../../shared/turn-cost';
import { pickServedModel } from '../claude-cli';
import type { ProcessCleanupReport } from '../process-guard';
import { formatIssues, type SchemaKind, type SchemaRegistry } from '../schema-validator';
import type { TurnAccumulator } from './stream';
import type {
  AgentRole,
  PermissionDenial,
  ServedModelCheck,
  TurnError,
  TurnOutcome,
  TurnUsage,
} from './types';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface ProcessFacts {
  exitCode: number | null;
  spawnError: string | null;
  /** The turn was not started because a check before spawning refused it (SPEC.md §8). */
  refused?: string;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  /** Last part of stderr, for error messages (the full text is in the .stderr file). */
  stderrTail: string;
  /** Last few stdout lines, for when no result arrived. */
  stdoutTail: string;
  slow: boolean;
  slowTurnMs: number | null;
  /** Null until the process guard has reported. */
  processes: ProcessCleanupReport | null;
}

/**
 * The CLI's message when `--resume` finds nothing (NOTES.md §5.3). It is the same sentence whether the
 * session was cleaned up, deleted, or belongs to another working directory.
 */
const SESSION_GONE = /No conversation found with session ID/i;

export function isSessionGone(text: string): boolean {
  return SESSION_GONE.test(text);
}

export interface TurnIdentity {
  turnId: string;
  agent: AgentRole;
  sessionId: string;
  resumed: boolean;
  startedAt: string;
  durationMs: number;
  rawPath: string;
  stderrPath: string;
  systemPromptPath: string;
  args: string[];
  requestedModel: string;
  /** Null for a plain session (SPEC.md §19.7): its output is the final text. */
  schema: SchemaKind | null;
  /** The session's running totals before this turn (SPEC.md §15); null for a new session. */
  previousTotals: RunningTotals | null;
}

function inputTokens(usage: Json): number {
  return num(usage['input_tokens']) + num(usage['cache_creation_input_tokens']) + num(usage['cache_read_input_tokens']);
}

/**
 * SPEC.md §15: context size = the last API call's input + cache_creation + cache_read.
 * The top-level usage sums every call in the turn, so it is never used for this.
 */
export function contextTokensOf(result: Json | null, lastAssistantUsage: Json | null): number | null {
  const usage = result && isRecord(result['usage']) ? result['usage'] : null;
  const iterations = usage && Array.isArray(usage['iterations']) ? usage['iterations'] : [];
  const last: unknown = iterations[iterations.length - 1];
  if (isRecord(last)) return inputTokens(last);
  if (lastAssistantUsage) return inputTokens(lastAssistantUsage);
  return null;
}

function usageOf(acc: TurnAccumulator, previousTotals: RunningTotals | null): TurnUsage | null {
  const result = acc.result;
  if (!result) return null;
  const usage = isRecord(result['usage']) ? result['usage'] : {};
  // `total_cost_usd` and `modelUsage` are the session's running totals; `usage` is this turn's (SPEC.md §15).
  const session: RunningTotals = { costUsd: numOrNull(result['total_cost_usd']), modelUsage: isRecord(result['modelUsage']) ? result['modelUsage'] : {} };
  const own = ownShare(previousTotals, session);
  return {
    contextTokens: contextTokensOf(result, acc.lastAssistantUsage),
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens']),
    cacheCreationTokens: num(usage['cache_creation_input_tokens']),
    numTurns: numOrNull(result['num_turns']),
    costUsd: own.costUsd,
    modelUsage: own.modelUsage,
    sessionCostUsd: session.costUsd,
    sessionModelUsage: session.modelUsage,
  };
}

/** `modelUsage`: this turn's own share (SPEC.md §15), so a model an earlier turn of the session used does not count. */
function modelCheck(acc: TurnAccumulator, requested: string, modelUsage: unknown): ServedModelCheck {
  const served = pickServedModel(modelUsage);
  const announced = strOrNull(acc.init?.['model']);
  const cliVersion = strOrNull(acc.init?.['claude_code_version']);
  return {
    requested,
    announced,
    served: served?.model ?? null,
    canonical: served?.canonical ?? null,
    contextWindow: served?.contextWindow ?? null,
    matches: served ? servedModelMatches(requested, served.canonical ?? served.model, cliVersion) : null,
    cliVersion,
    alsoServed: otherServedModels(modelUsage, requested, served?.model ?? null, cliVersion),
  };
}

/**
 * Models other than the main one that served part of the turn (SPEC.md §8). A safety-classifier fallback shows
 * up here even when the fallback served less than the model it replaced, which `pickServedModel` would miss.
 * Haiku is Claude Code's model for small internal calls, so it only counts when it was the one requested.
 */
export function otherServedModels(modelUsage: unknown, requested: string, main: string | null, cliVersion: string | null): string[] {
  if (!isRecord(modelUsage)) return [];
  const haikuRequested = baseModelId(requested).includes('haiku');
  const out: string[] = [];
  for (const model of Object.keys(modelUsage)) {
    if (main !== null && model === main) continue;
    if (servedModelMatches(requested, model, cliVersion)) continue;
    if (!haikuRequested && baseModelId(model).includes('haiku')) continue;
    out.push(model);
  }
  return out;
}

function denialsOf(result: Json | null): PermissionDenial[] {
  const list = result && Array.isArray(result['permission_denials']) ? result['permission_denials'] : [];
  return list.filter(isRecord).map((d) => ({
    toolName: strOrNull(d['tool_name']) ?? '',
    toolUseId: strOrNull(d['tool_use_id']),
    input: d['tool_input'],
  }));
}

function tail(text: string, max = 2000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * A failure of the service rather than of the agent (SPEC.md §3.5): an API error with no HTTP status (e.g.
 * "Failed to refresh OAuth token: another Claude Code process is refreshing it"), 401, 408 or 5xx. Request
 * errors (400, 403, 404, 413, …) are not. The orchestrator retries these once (§5 net 12); the evaluation
 * harness uses the same rule (§19.4).
 */
export function isServiceError(error: { kind: string; apiErrorStatus?: number | null } | null | undefined): boolean {
  if (!error || error.kind !== 'api_error') return false;
  const s = error.apiErrorStatus ?? null;
  return s === null || s === 401 || s === 408 || s >= 500;
}

export function classifyTurn(
  id: TurnIdentity,
  acc: TurnAccumulator,
  proc: ProcessFacts,
  schemas: SchemaRegistry,
): TurnOutcome {
  const result = acc.result;
  const resultText = strOrNull(result?.['result']);
  const usage = usageOf(acc, id.previousTotals);
  const common = {
    turnId: id.turnId,
    agent: id.agent,
    sessionId: strOrNull(result?.['session_id']) ?? strOrNull(acc.init?.['session_id']) ?? id.sessionId,
    resumed: id.resumed,
    startedAt: id.startedAt,
    durationMs: id.durationMs,
    exitCode: proc.exitCode,
    rawPath: id.rawPath,
    stderrPath: id.stderrPath,
    systemPromptPath: id.systemPromptPath,
    args: id.args,
    init: acc.init
      ? {
          sessionId: strOrNull(acc.init['session_id']),
          model: strOrNull(acc.init['model']),
          skills: strings(acc.init['skills']),
          slashCommands: strings(acc.init['slash_commands']),
        }
      : null,
    usage,
    model: modelCheck(acc, id.requestedModel, usage ? usage.modelUsage : acc.result?.['modelUsage']),
    permissionDenials: denialsOf(result),
    skillInvocations: [...acc.skills.values()],
    answerRejections: acc.answerRejections,
    toolUses: { ...acc.toolUses },
    rateLimit: acc.rateLimit,
    slow: proc.slow,
    slowTurnMs: proc.slowTurnMs,
    processes: proc.processes ?? { method: 'none' as const, survivors: [], errors: ['process guard did not report'] },
    resultText,
  };
  const fail = (error: TurnError): TurnOutcome => ({ ...common, ok: false, error });
  const noResultText = () =>
    [proc.stderrTail.trim(), proc.stdoutTail.trim()].filter((t) => t.length > 0).join('\n---\n');

  // 1. What happened to the process.
  if (proc.refused !== undefined) {
    return fail({ kind: 'cli_version', message: proc.refused, rawText: proc.refused });
  }
  if (proc.spawnError !== null) {
    return fail({ kind: 'spawn_failed', message: `Could not start the CLI: ${proc.spawnError}`, rawText: proc.spawnError });
  }
  if (acc.rejectedRateLimit) {
    const r = acc.rejectedRateLimit;
    return fail({
      kind: 'rate_limited',
      message: `Usage limit reached (${r.rateLimitType ?? 'unknown window'}); the turn was stopped.`,
      rawText: resultText ?? JSON.stringify(r),
      resetsAt: r.resetsAt,
    });
  }
  if (proc.aborted) {
    return fail({ kind: 'aborted', message: 'The turn was stopped.', rawText: noResultText() });
  }
  if (proc.timedOut) {
    return fail({
      kind: 'timeout',
      message: `The turn exceeded ${Math.round(proc.timeoutMs / 1000)} s and was killed.`,
      rawText: noResultText(),
    });
  }

  // 2. What the CLI said.
  if (!result) {
    // SPEC.md §5 net 13: `--resume` on a session the CLI no longer has exits 1 with this on stderr
    // and no result. It is not a generic process failure: the session is gone and must be replaced.
    if (id.resumed && isSessionGone(`${proc.stderrTail}\n${proc.stdoutTail}`)) {
      return fail({
        kind: 'session_gone',
        message: `Claude Code no longer has session ${id.sessionId}, so this turn could not continue it.`,
        rawText: noResultText(),
      });
    }
    return fail({
      kind: 'no_result',
      message: `The CLI exited (code ${proc.exitCode ?? 'none'}) without a result.`,
      rawText: noResultText(),
    });
  }
  const subtype = strOrNull(result['subtype']);
  const terminalReason = strOrNull(result['terminal_reason']);
  const apiErrorStatus = numOrNull(result['api_error_status']);
  const errorDetail = {
    rawText: resultText ?? tail(JSON.stringify(result)),
    apiErrorStatus,
    terminalReason,
    subtype,
  };
  if (subtype === 'error_max_turns') {
    return fail({ kind: 'max_turns', message: 'The session hit its --max-turns limit.', ...errorDetail });
  }
  if (subtype === 'error_max_structured_output_retries') {
    const refused = common.answerRejections;
    return fail({
      kind: 'structured_output_failed',
      message:
        refused.count > 0
          ? `The CLI refused all ${refused.count} structured answers the model gave. Reason: ${refused.reasons.join(' / ')}`
          : 'The CLI could not get a schema-valid answer from the model.',
      ...errorDetail,
    });
  }
  if (apiErrorStatus === 429 || acc.assistantError === 'rate_limit') {
    return fail({ kind: 'rate_limited', message: resultText ?? 'Usage limit reached.', ...errorDetail, resetsAt: acc.rateLimit?.resetsAt ?? null });
  }
  if (result['is_error'] === true || (subtype !== null && subtype.startsWith('error'))) {
    const kind = terminalReason === 'api_error' || apiErrorStatus !== null ? 'api_error' : 'process_failed';
    const errors = Array.isArray(result['errors']) ? result['errors'].filter((e) => typeof e === 'string') : [];
    return fail({
      kind,
      message: resultText ?? (errors.join('; ') || `The CLI reported an error (${subtype ?? 'no subtype'}).`),
      ...errorDetail,
    });
  }

  // 3. Whether the answer is one we can act on. A plain session has no structured answer to check.
  if (id.schema === null) return { ...common, ok: true, output: resultText ?? '' };
  const structured = result['structured_output'];
  if (structured === undefined || structured === null) {
    return fail({
      kind: 'schema_invalid',
      message: 'The result carries no structured output.',
      rawText: resultText ?? '',
      validationIssues: [{ path: '', message: 'structured_output is missing' }],
    });
  }
  const checked = schemas.validate(id.schema, structured);
  if (!checked.ok) {
    return fail({
      kind: 'schema_invalid',
      message: `The answer does not match ${id.schema}: ${formatIssues(checked.issues)}`,
      rawText: JSON.stringify(structured, null, 2),
      validationIssues: checked.issues,
    });
  }
  return { ...common, ok: true, output: checked.value };
}
