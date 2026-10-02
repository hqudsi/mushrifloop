/**
 * CLI arguments for one turn — the SPEC.md §3.1 rules in one pure function.
 *
 * The prompt is never an argument (variadic flags would swallow it; it goes on stdin), long text goes
 * through files, and the JSON schema is inline because the CLI rejects a path. Every flag here is
 * listed in NOTES.md as verified.
 */

import { supportsEffort } from '../../shared/models';
import type { AgentRole } from './types';

export interface ArgsInput {
  agent: AgentRole;
  model: string;
  effort: string | null;
  maxTurns: number;
  /**
   * Inline JSON schema. Null only for a plain Executor session (the evaluation harness's baseline,
   * SPEC.md §19.7), which also has no system prompt file.
   */
  schemaJson: string | null;
  systemPromptFile: string | null;
  session: { mode: 'new'; sessionId: string } | { mode: 'resume'; sessionId: string };
  tools: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: 'dontAsk' | 'bypassPermissions';
}

/** Tools the planner may be given: none, or the read-only set (SPEC.md §3.1). */
export const PLANNER_READ_ONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

export class InvalidTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTurnError';
  }
}

/**
 * `--tools` takes bare tool names. A permission pattern there is silently dropped *together with the
 * tool* (`--tools "Read,Bash(git *)"` left only Read — NOTES.md §14), so strip patterns to names.
 */
export function toolNames(entries: readonly string[]): string[] {
  const names = entries.map((e) => e.replace(/\(.*\)\s*$/, '').trim()).filter((n) => n.length > 0);
  return Array.from(new Set(names));
}

export function buildTurnArgs(input: ArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  args.push('--model', input.model);
  if (input.effort !== null && supportsEffort(input.model)) args.push('--effort', input.effort);
  args.push('--max-turns', String(input.maxTurns));
  if (input.schemaJson !== null) args.push('--json-schema', input.schemaJson);

  if (input.session.mode === 'new') args.push('--session-id', input.session.sessionId);
  else args.push('--resume', input.session.sessionId);

  // Neither agent uses MCP servers; without this the user's plugin servers load into both.
  args.push('--strict-mcp-config');

  if (input.agent === 'planner') {
    if (input.schemaJson === null || input.systemPromptFile === null) {
      throw new InvalidTurnError('A planner turn needs its schema and its system prompt file.');
    }
    const extra = input.tools.filter((t) => !PLANNER_READ_ONLY_TOOLS.includes(t));
    if (extra.length > 0) {
      throw new InvalidTurnError(`The planner may only use ${PLANNER_READ_ONLY_TOOLS.join(', ')}; got ${extra.join(', ')}`);
    }
    // "" disables every built-in tool; `--allowedTools` would not.
    args.push('--tools', input.tools.join(','));
    // Nothing from disk: no user settings, plugins or CLAUDE.md in the planner (NOTES.md §7.5).
    args.push('--setting-sources', '');
    args.push('--system-prompt-file', input.systemPromptFile);
    return args;
  }

  const names = toolNames(input.tools);
  if (names.length === 0) throw new InvalidTurnError('The executor needs at least one tool.');
  // --tools restricts; --allowedTools (with any patterns) auto-approves. Both are required (SPEC.md §3.1).
  args.push('--tools', names.join(','));
  args.push('--allowedTools', input.tools.join(','));
  if (input.disallowedTools && input.disallowedTools.length > 0) {
    args.push('--disallowedTools', input.disallowedTools.join(','));
  }
  if (input.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'dontAsk');
  if (input.systemPromptFile !== null) args.push('--append-system-prompt-file', input.systemPromptFile);
  return args;
}

export interface ProbeArgsInput {
  model: string;
  tools: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: 'dontAsk' | 'bypassPermissions';
}

/**
 * Arguments for the free `init` probe (SPEC.md §16): the Executor's tool, permission and settings
 * configuration, so `init` lists exactly the skills an Executor turn would see, with no schema, no
 * session file (`--no-session-persistence`, NOTES.md §16) and no model call (the prompt is `/usage`).
 */
export function buildProbeArgs(input: ProbeArgsInput): string[] {
  const names = toolNames(input.tools);
  if (names.length === 0) throw new InvalidTurnError('The executor needs at least one tool.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  args.push('--model', input.model, '--strict-mcp-config');
  args.push('--tools', names.join(','), '--allowedTools', input.tools.join(','));
  if (input.disallowedTools && input.disallowedTools.length > 0) {
    args.push('--disallowedTools', input.disallowedTools.join(','));
  }
  if (input.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'dontAsk');
  return args;
}
