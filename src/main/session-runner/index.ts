/**
 * Session runner (SPEC.md §12 phase 2).
 *
 *   const schemas = SchemaRegistry.load(schemasFolder());   // throws → do not start
 *   const ctx = createRunnerContext(settings);              // throws → show the message
 *   const outcome = await runTurn(spec, ctx, schemas);      // never throws for a failed turn
 */

import type { Settings } from '../../shared/settings';
import { buildEnv, readCliVersion, resolveClaudeBinary } from '../claude-cli';
import { sharedProcessGuardFactory } from '../process-guard';
import type { RunnerContext } from './types';

export { buildProbeArgs, buildTurnArgs, InvalidTurnError, PLANNER_READ_ONLY_TOOLS, toolNames } from './args';
export { InitProbeError, probeInit, type InitProbe } from './probe';
export { classifyTurn, contextTokensOf, isServiceError } from './classify';
export { TURN_KILL_BUDGET_MS, makeTurnId, runTurn } from './run';
export { LineSplitter, TurnAccumulator, toEvents } from './stream';
export type * from './types';

export class RunnerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSetupError';
  }
}

/**
 * Resolve the CLI binary and spawn environment from settings (SPEC.md §3.2), with the shared
 * process guard (SPEC.md §5 net 9). Call `warmUpProcessGuard()` early to avoid first-turn latency.
 */
export function createRunnerContext(
  settings: Settings,
  /** A stand-in CLI instead of the resolved one (the evaluation harness's dry run, SPEC.md §19.6). */
  fake?: { binary: string; binaryArgs: readonly string[] },
): RunnerContext {
  const env = buildEnv(settings);
  if (fake) {
    const { binary: exe, binaryArgs } = fake;
    return { binary: exe, binaryArgs, env, cliVersion: () => readCliVersion(exe, env, binaryArgs), processGuard: sharedProcessGuardFactory() };
  }
  const binary = resolveClaudeBinary(settings);
  if (!binary.path) {
    throw new RunnerSetupError(
      `${binary.error ?? 'The claude CLI was not found.'} Set the path in Settings → Claude Code connection.`,
    );
  }
  const exe = binary.path;
  return { binary: exe, env, cliVersion: () => readCliVersion(exe, env), processGuard: sharedProcessGuardFactory() };
}

/** Start the PowerShell job helper ahead of the first turn (no-op off Windows or if it cannot start). */
export async function warmUpProcessGuard(): Promise<void> {
  await sharedProcessGuardFactory().warmUp?.();
}

/** Stop the helper; any process still in one of its jobs is killed by Windows. */
export function disposeProcessGuard(): void {
  sharedProcessGuardFactory().dispose?.();
}
