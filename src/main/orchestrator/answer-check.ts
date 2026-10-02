/**
 * Refused structured answers, leaked tool-call markup and the "possibly truncated" rule (SPEC.md §3.5, §4,
 * §5 net 11).
 *
 * Pure. The size rule looks only at the size and sentence count of the validated answer's main text, and at
 * how much smaller the accepted answer is than what the CLI refused; the markup rule looks only for the
 * tag — never at what the text says. The evaluation harness uses the same functions (SPEC.md §19.8).
 */

import type { AgentRole, AnswerCheck, AnswerRejections, TurnRecord } from './types';

/** Main text shorter than this is suspicious after a refusal. */
export const TRUNCATED_BELOW_CHARS = 120;
/** …and so is main text with fewer sentences than this. */
export const TRUNCATED_BELOW_SENTENCES = 2;
/** …and an accepted answer below this fraction of the largest refused attempt (raised from ½ on 2026-09-17). */
export const TRUNCATED_BELOW_SHARE = 0.75;

/** Sentences, roughly: text between sentence-ending marks that are followed by a space or the end. */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?؟。]+(?=\s|$)/u)
    .filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
}

// The tool-call markup that leaks when a later field is typed into a text field (NOTES.md §20.2, §23.4):
// `…</summary><parameter name="changed_files">…`. Field names alone are not enough: pasted C# has
// `/// <summary>` doc comments (a false positive in the Step B schema run, NOTES.md §23.5).
const LEAKED_MARKUP = /<\/?parameter\b/;

/** Whether any text in an answer, at any depth, holds leaked tool-call markup (SPEC.md §3.5). */
export function hasLeakedMarkup(value: unknown): boolean {
  if (typeof value === 'string') return LEAKED_MARKUP.test(value);
  if (Array.isArray(value)) return value.some(hasLeakedMarkup);
  if (value && typeof value === 'object') return Object.values(value).some(hasLeakedMarkup);
  return false;
}

/**
 * The text that carries an answer's substance: an Executor report's summary and evidence together, a
 * handoff's restatement. Null for Planner answers.
 */
export function mainText(agent: AgentRole, purpose: TurnRecord['purpose'], output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  if (purpose === 'handoff') return typeof record['task_restatement'] === 'string' ? record['task_restatement'] : null;
  if (agent !== 'executor' || typeof record['summary'] !== 'string') return null;
  const evidence = record['evidence'];
  return typeof evidence === 'string' && evidence.trim() !== '' ? `${record['summary']}\n${evidence}` : record['summary'];
}

/**
 * Null when nothing was refused and the accepted answer has no leaked markup. Otherwise the refusals plus
 * whether the accepted answer is possibly truncated (SPEC.md §4). An Executor answer or a handoff with leaked
 * markup always is. Planner answers are counted but never judged truncated: leaked markup there is only
 * flagged, and the orchestrator refuses the answer.
 */
export function checkAnswer(
  refused: AnswerRejections,
  agent: AgentRole,
  purpose: TurnRecord['purpose'],
  output: unknown,
): AnswerCheck | null {
  const hasOutput = output !== null && output !== undefined;
  const leakedMarkup = hasOutput && hasLeakedMarkup(output);
  if (refused.count === 0 && !leakedMarkup) return null;
  const accepted = hasOutput ? JSON.stringify(output).length : null;
  const text = mainText(agent, purpose, output);
  const small =
    refused.count > 0 &&
    text !== null &&
    accepted !== null &&
    (text.trim().length < TRUNCATED_BELOW_CHARS ||
      sentenceCount(text) < TRUNCATED_BELOW_SENTENCES ||
      accepted < refused.largestAttemptChars * TRUNCATED_BELOW_SHARE);
  const possiblyTruncated = small || (leakedMarkup && (agent === 'executor' || purpose === 'handoff'));
  return { ...refused, reasons: [...refused.reasons], acceptedChars: accepted, possiblyTruncated, leakedMarkup };
}

/** "Read ×3, Grep ×2" — what the agent did, for the Planner, when its report may not say. */
export function describeToolUses(toolUses: Readonly<Record<string, number>> | undefined): string {
  const entries = Object.entries(toolUses ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return 'no tool calls';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return `${total} tool call${total === 1 ? '' : 's'}: ${entries.map(([name, n]) => `${name} ×${n}`).join(', ')}`;
}
