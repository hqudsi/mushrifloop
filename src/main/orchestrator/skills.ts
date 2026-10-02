/**
 * Skill discovery and enforcement (SPEC.md §16) — pure.
 *
 * Discovery reads the `init` event: `skills` lists skills, but prompt-type built-ins such as
 * `security-review` appear only in `slash_commands` (verified on 2.1.273, NOTES.md §16). The list given
 * to the Planner is therefore `skills` plus any required skill found in `slash_commands`.
 *
 * Enforcement reads `Skill` tool calls, never prose.
 */

import type { SkillInvocation } from '../session-runner/types';
import type { SkillOutcome } from './types';

/** Skills that diff against `origin/HEAD` and silently do nothing without a remote. */
export const SKILLS_NEEDING_REMOTE: readonly string[] = ['security-review'];

export function availableSkills(
  init: { skills: readonly string[]; slashCommands: readonly string[] },
  required: readonly string[],
): { available: string[]; missingRequired: string[] } {
  const available = new Set(init.skills);
  for (const name of required) if (init.slashCommands.includes(name)) available.add(name);
  const missingRequired = required.filter((name) => !available.has(name));
  return { available: [...available].sort(), missingRequired };
}

/** `security-review` matches `security-review` and `<plugin>:security-review`. */
export function skillMatches(invoked: string, name: string): boolean {
  const bare = invoked.replace(/^\//, '');
  return bare === name || bare.endsWith(`:${name}`);
}

/**
 * What happened to each skill in one Executor turn: every requested skill, plus any the Executor ran
 * on its own. `hasRemote` false turns a remote-dependent skill into "skipped — no git remote" whatever
 * the tool call said: without a remote it returns an empty success (NOTES.md §4d).
 */
export function skillOutcomes(
  requested: readonly string[],
  invocations: readonly SkillInvocation[],
  hasRemote: boolean,
): SkillOutcome[] {
  const names = [...requested];
  for (const inv of invocations) {
    const bare = inv.skill.replace(/^\//, '');
    if (bare && !names.some((n) => skillMatches(bare, n))) names.push(bare);
  }
  return names.map((skill) => {
    const isRequested = requested.includes(skill);
    const calls = invocations.filter((inv) => skillMatches(inv.skill, skill));
    let state: SkillOutcome['state'];
    if (calls.length > 0 && !hasRemote && SKILLS_NEEDING_REMOTE.includes(skill)) state = 'skipped_no_remote';
    else if (calls.some((c) => c.isError === false)) state = 'ok';
    else if (calls.some((c) => c.isError === true)) state = 'failed';
    else if (calls.length > 0) state = 'no_result';
    else if (!hasRemote && SKILLS_NEEDING_REMOTE.includes(skill)) state = 'skipped_no_remote';
    else state = 'not_invoked';
    return { skill, requested: isRequested, state };
  });
}

/**
 * Why a skill cannot run in this environment, or null. Environmental only: the skill is not offered
 * here at all, or it needs a git remote that the project lacks. A failed or skipped call is not.
 */
export function environmentalReason(
  skill: string,
  context: { available: readonly string[] | null; isRepo: boolean; hasRemote: boolean },
): string | null {
  if (context.available !== null && !context.available.includes(skill)) {
    return 'Claude Code does not offer this skill in this project, so the executor cannot invoke it.';
  }
  if (SKILLS_NEEDING_REMOTE.includes(skill)) {
    if (!context.isRepo) return 'the project is not a git repository, and this skill reviews committed changes against origin/HEAD.';
    if (!context.hasRemote) return 'the repository has no git remote, and this skill diffs against origin/HEAD.';
  }
  return null;
}

/** Required skills not yet satisfied. */
export function missingRequiredSkills(required: readonly string[], satisfied: readonly string[]): string[] {
  return required.filter((name) => !satisfied.includes(name));
}

export function describeSkillState(state: SkillOutcome['state']): string {
  switch (state) {
    case 'ok':
      return 'ran successfully';
    case 'failed':
      return 'failed (the Skill tool returned an error)';
    case 'no_result':
      return 'started but returned no result';
    case 'not_invoked':
      return 'was not invoked';
    case 'skipped_no_remote':
      return 'skipped — no git remote (it cannot run in this repository)';
  }
}
