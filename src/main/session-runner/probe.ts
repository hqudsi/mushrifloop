/**
 * The free `init` probe (SPEC.md §16): start the CLI with the Executor's configuration and the local
 * `/usage` command, which makes no model call (NOTES.md §4c), and read skills from its `init` event.
 */

import { runClaude } from '../claude-cli';
import { buildProbeArgs, type ProbeArgsInput } from './args';
import { LineSplitter } from './stream';
import type { RunnerContext } from './types';

export interface InitProbe {
  skills: string[];
  slashCommands: string[];
  model: string | null;
  cliVersion: string | null;
  costUsd: number | null;
}

export class InitProbeError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(message);
    this.name = 'InitProbeError';
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function probeInit(input: ProbeArgsInput & { cwd: string }, ctx: RunnerContext, timeoutMs = 60_000): Promise<InitProbe> {
  const run = await runClaude(ctx.binary, [...(ctx.binaryArgs ?? []), ...buildProbeArgs(input)], {
    env: ctx.env,
    cwd: input.cwd,
    input: '/usage',
    timeoutMs,
  });
  const raw = [run.stdout.slice(-2000), run.stderr.slice(-2000)].filter((t) => t.trim()).join('\n---\n');
  if (run.spawnError) throw new InitProbeError(`Could not start the CLI: ${run.spawnError}`, raw);
  if (run.timedOut) throw new InitProbeError(`The skill probe did not finish within ${timeoutMs / 1000} s.`, raw);

  let init: Record<string, unknown> | null = null;
  let costUsd: number | null = null;
  const splitter = new LineSplitter();
  for (const line of [...splitter.push(run.stdout), ...splitter.flush()]) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (m['type'] === 'system' && m['subtype'] === 'init') init = m;
    if (m['type'] === 'result' && typeof m['total_cost_usd'] === 'number') costUsd = m['total_cost_usd'];
  }
  if (!init) throw new InitProbeError(`The CLI (exit ${run.code ?? 'none'}) emitted no init event.`, raw);
  return {
    skills: strings(init['skills']),
    slashCommands: strings(init['slash_commands']),
    model: typeof init['model'] === 'string' ? init['model'] : null,
    cliVersion: typeof init['claude_code_version'] === 'string' ? init['claude_code_version'] : null,
    costUsd,
  };
}
