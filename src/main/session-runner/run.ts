/**
 * runTurn — one agent turn as one `claude -p` process (SPEC.md §3, §5, §9, §17).
 *
 * Streams events as they arrive, writes the raw stdout/stderr verbatim to the turn's files, kills the
 * whole process tree on timeout, Stop, or a rejected rate-limit event (without waiting out the CLI's
 * retry backoff), and returns a typed outcome. It never throws for a failed turn — only for a spec
 * that is invalid by construction (programming errors).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { modelVersionBlock } from '../../shared/models';
import { killTree } from '../claude-cli';
import { errorMessage, log } from '../logger';
import { unguarded, type PreparedGuard, type ProcessCleanupReport, type TurnProcessGuard } from '../process-guard';
import type { SchemaRegistry } from '../schema-validator';
import { takeAnswerFile } from './answer-file';
import { buildTurnArgs } from './args';
import { classifyTurn, type ProcessFacts } from './classify';
import { LineSplitter, TurnAccumulator } from './stream';
import type { RunnerContext, TurnOutcome, TurnSpec } from './types';

/** How long to wait for the process to exit after we killed it before giving up on it. */
const KILL_GRACE_MS = 15_000;
/** Upper bound for the process guard's end-of-turn sweep. */
const GUARD_FINISH_TIMEOUT_MS = 30_000;
/** The longest a killed turn takes to resolve: the kill grace, then the process-guard sweep. */
export const TURN_KILL_BUDGET_MS = KILL_GRACE_MS + GUARD_FINISH_TIMEOUT_MS;
const STDERR_TAIL_CHARS = 4000;
const STDOUT_TAIL_LINES = 20;
/** The `init` line alone is several KB; the full stream is in the raw file anyway. */
const STDOUT_TAIL_CHARS = 4000;

export function makeTurnId(agent: string, now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}_${agent}_${randomBytes(3).toString('hex')}`;
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed || stream.destroyed) {
      resolve();
      return;
    }
    stream.end(() => resolve());
  });
}

async function versionBlock(model: string, ctx: RunnerContext): Promise<string | null> {
  // Only models with a minimum pay for the version read.
  if (modelVersionBlock(model, '0.0.0') === null) return null;
  let reading;
  try {
    reading = await ctx.cliVersion();
  } catch (err) {
    reading = { version: null, error: errorMessage(err) };
  }
  return modelVersionBlock(model, reading.version, reading.error);
}

export async function runTurn<T = unknown>(
  spec: TurnSpec,
  ctx: RunnerContext,
  schemas: SchemaRegistry,
): Promise<TurnOutcome<T>> {
  const turnId = spec.turnId ?? makeTurnId(spec.agent);
  const resumed = spec.resumeSessionId !== undefined;
  const sessionId = spec.resumeSessionId ?? spec.newSessionId ?? randomUUID();

  fs.mkdirSync(spec.rawDir, { recursive: true });
  const rawPath = path.join(spec.rawDir, `${turnId}.ndjson`);
  const stderrPath = path.join(spec.rawDir, `${turnId}.stderr`);
  const systemPromptPath = path.join(spec.rawDir, `${turnId}.system.md`);
  const plain = spec.schema === null;
  // Long text goes through a file: the Windows command line stops at 32,767 chars (NOTES.md §1).
  // A plain session passes none; the empty file still records that.
  fs.writeFileSync(systemPromptPath, plain ? '' : spec.systemPrompt, 'utf8');

  const args = buildTurnArgs({
    agent: spec.agent,
    model: spec.model,
    effort: spec.effort,
    maxTurns: spec.maxTurns,
    schemaJson: spec.schema === null ? null : schemas.get(spec.schema).inline,
    systemPromptFile: plain ? null : systemPromptPath,
    session: resumed ? { mode: 'resume', sessionId } : { mode: 'new', sessionId },
    tools: spec.tools,
    ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
  });

  const startedAt = new Date();
  const identity = {
    turnId,
    agent: spec.agent,
    sessionId,
    resumed,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    rawPath,
    stderrPath,
    systemPromptPath,
    args,
    requestedModel: spec.model,
    schema: spec.schema,
    previousTotals: spec.previousTotals ?? null,
  };

  const accumulator = new TurnAccumulator();
  const facts: ProcessFacts = {
    exitCode: null,
    spawnError: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stderrTail: '',
    stdoutTail: '',
    slow: false,
    slowTurnMs: spec.slowTurnMs ?? null,
    processes: null,
  };
  const finish = (): TurnOutcome<T> => {
    identity.durationMs = Date.now() - startedAt.getTime();
    const outcome = classifyTurn(identity, accumulator, facts, schemas) as TurnOutcome<T>;
    return spec.answerFile ? takeAnswerFile(outcome, spec.answerFile, schemas) : outcome;
  };

  // A missing cwd makes spawn fail with a misleading "binary not found" — say what is really wrong.
  if (!fs.existsSync(spec.cwd) || !fs.statSync(spec.cwd).isDirectory()) {
    facts.spawnError = `Working directory does not exist: ${spec.cwd}`;
    facts.processes = { method: 'none', survivors: [], errors: ['no process was started'] };
    fs.writeFileSync(rawPath, '');
    fs.writeFileSync(stderrPath, '');
    return finish();
  }
  if (spec.signal?.aborted) {
    facts.aborted = true;
    facts.processes = { method: 'none', survivors: [], errors: ['no process was started'] };
    fs.writeFileSync(rawPath, '');
    fs.writeFileSync(stderrPath, '');
    return finish();
  }
  // SPEC.md §8: a model that needs a newer CLI never starts on an older one — checked at every spawn.
  const block = await versionBlock(spec.model, ctx);
  if (block !== null) {
    facts.refused = `Not started: ${block} Update Claude Code (\`claude update\`) or choose another model.`;
    facts.processes = { method: 'none', survivors: [], errors: ['no process was started'] };
    fs.writeFileSync(rawPath, '');
    fs.writeFileSync(stderrPath, '');
    return finish();
  }

  // Prepare the guard BEFORE spawning, so assigning the CLI afterwards is one quick step (SPEC.md §5 net 9).
  let prepared: PreparedGuard | null = null;
  let guardSetupError = 'no process guard configured';
  if (ctx.processGuard) {
    try {
      prepared = await ctx.processGuard.prepare(turnId);
    } catch (err) {
      guardSetupError = `process guard failed: ${errorMessage(err)}`;
    }
  }

  const rawOut = fs.createWriteStream(rawPath);
  const rawErr = fs.createWriteStream(stderrPath);
  const splitter = new LineSplitter();
  const recentLines: string[] = [];
  const emit = spec.onEvent ?? (() => {});

  return new Promise<TurnOutcome<T>>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let killed = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let slowTimer: NodeJS.Timeout | undefined;
    // Resolves once the guard is attached (or has given up); every path below may rely on it.
    let guard: Promise<TurnProcessGuard> = Promise.resolve(unguarded('no process was started'));

    const kill = () => {
      if (killed) return;
      killed = true;
      killTree(child?.pid);
      // The job (or the tracked tree) also holds processes whose parents already exited.
      void guard.then((g) => g.killAll()).catch(() => {});
      // If the tree never reports exit, do not hang the orchestrator.
      graceTimer = setTimeout(() => void done(null), KILL_GRACE_MS);
    };

    const handleLine = (line: string) => {
      recentLines.push(line);
      if (recentLines.length > STDOUT_TAIL_LINES) recentLines.shift();
      for (const event of accumulator.addLine(line)) emit(event);
      // SPEC.md §17: stop at once instead of sitting through ~3 minutes of retries.
      if (accumulator.rejectedRateLimit && !killed) kill();
    };

    const done = async (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (slowTimer) clearTimeout(slowTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      for (const line of splitter.flush()) handleLine(line);
      facts.exitCode = code;
      if (spawnError !== undefined) facts.spawnError = spawnError;
      const joined = recentLines.join('\n');
      facts.stdoutTail = joined.length > STDOUT_TAIL_CHARS ? `…${joined.slice(-STDOUT_TAIL_CHARS)}` : joined;
      facts.processes = await sweepProcesses(guard);
      await Promise.all([closeStream(rawOut), closeStream(rawErr)]);
      resolve(finish());
    };

    const onAbort = () => {
      facts.aborted = true;
      kill();
    };

    const timeoutTimer = setTimeout(() => {
      facts.timedOut = true;
      kill();
    }, spec.timeoutMs);

    // SPEC.md §5 net 8: a soft limit — mark and report, never kill.
    if (spec.slowTurnMs !== undefined && spec.slowTurnMs < spec.timeoutMs) {
      const threshold = spec.slowTurnMs;
      slowTimer = setTimeout(() => {
        facts.slow = true;
        emit({ kind: 'slow_turn', elapsedMs: Date.now() - startedAt.getTime(), thresholdMs: threshold });
      }, threshold);
    }

    try {
      child = spawn(ctx.binary, [...(ctx.binaryArgs ?? []), ...args], {
        cwd: spec.cwd,
        env: ctx.env,
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      void prepared?.discard();
      void done(null, err instanceof Error ? err.message : String(err));
      return;
    }

    spec.signal?.addEventListener('abort', onAbort, { once: true });

    // Put the CLI under the process guard straight away: tool processes start only after the
    // first model response, seconds from now (SPEC.md §5 net 9).
    if (child.pid !== undefined) {
      const pid = child.pid;
      guard = prepared
        ? prepared.attach(pid).catch((err: unknown) => unguarded(`process guard failed: ${errorMessage(err)}`))
        : Promise.resolve(unguarded(guardSetupError));
      if (killed) void guard.then((g) => g.killAll()).catch(() => {});
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      rawOut.write(chunk);
      for (const line of splitter.push(chunk.toString('utf8'))) handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      rawErr.write(chunk);
      const text = chunk.toString('utf8');
      facts.stderrTail = (facts.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      emit({ kind: 'stderr', text });
    });
    child.on('error', (err) => {
      if (child.pid === undefined) void prepared?.discard();
      void done(null, err.message);
    });
    child.on('close', (code) => void done(code));

    // The prompt goes on stdin (NOTES.md §1).
    child.stdin?.on('error', () => {
      /* the CLI may exit before reading everything; the outcome says why */
    });
    child.stdin?.end(spec.prompt, 'utf8');
  });

  async function sweepProcesses(pending: Promise<TurnProcessGuard>): Promise<ProcessCleanupReport> {
    let report: ProcessCleanupReport;
    try {
      const g = await pending;
      report = await Promise.race([
        g.finish(),
        new Promise<ProcessCleanupReport>((resolveTimeout) =>
          setTimeout(
            () => resolveTimeout({ method: 'none', survivors: [], errors: ['process guard did not finish in time'] }),
            GUARD_FINISH_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
    } catch (err) {
      report = { method: 'none', survivors: [], errors: [`process guard failed: ${errorMessage(err)}`] };
    }
    // Decision 2026-09-16: log every process that outlived its turn, to see whether cleanup leaks in practice.
    if (report.survivors.length > 0) {
      log.warn('turn.survivors_killed', {
        turnId,
        agent: spec.agent,
        method: report.method,
        count: report.survivors.length,
        survivors: report.survivors,
      });
    }
    if (report.errors.length > 0 && report.method !== 'none') {
      log.warn('turn.process_guard_errors', { turnId, method: report.method, errors: report.errors });
    }
    return report;
  }
}
