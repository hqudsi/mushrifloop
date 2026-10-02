/**
 * npm run try-turn -- --agent planner|executor --prompt "…" [options]
 *
 * Runs ONE real agent turn through the session runner, printing events as they stream and the
 * parsed outcome at the end. Uses your saved settings for models, tools and permissions.
 *
 *   --agent planner|executor     required
 *   --prompt "<text>"            required (or --prompt-file <path>)
 *   --resume <session-id>        continue a session printed by an earlier run
 *   --cwd <dir>                  executor: required (the project to work in)
 *                                planner: only with --read-only; otherwise a fixed scratch folder
 *   --read-only                  planner may Read/Glob/Grep in --cwd (SPEC.md §3.1)
 *   --model <id> --effort <lvl>  override the task defaults
 *   --timeout-sec <n>            default: settings turn timeout
 *   --slow-sec <n>               slow-turn warning; default: settings (SPEC.md §5 net 8)
 *   --max-turns <n>              default: settings
 *   --standing "<text>"          extra standing instructions for this run
 *   --quiet                      print only the outcome
 *
 * Raw files go to <data folder>/try-turn/raw; the planner's scratch cwd is <data folder>/try-turn/planner-cwd
 * (kept, because --resume only works from the same cwd).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { EFFORT_LEVELS, type EffortLevel } from '../../shared/models';
import { parseAuthStatus, runClaude } from '../claude-cli';
import { agentPromptFile, initDataFolder, schemasFolder, tryTurnFolder } from '../config';
import { SchemaRegistry, formatIssues } from '../schema-validator';
import {
  PLANNER_READ_ONLY_TOOLS,
  RunnerSetupError,
  createRunnerContext,
  disposeProcessGuard,
  runTurn,
  warmUpProcessGuard,
  type TurnEvent,
  type TurnOutcome,
  type TurnSpec,
} from '../session-runner';
import { loadSettings, settingsProblem } from '../settings';
import { detectStorageLocation } from '../storage-location';

function fail(message: string, code = 2): never {
  console.error(`try-turn: ${message}`);
  process.exit(code);
}

function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  const pick = i['command'] ?? i['file_path'] ?? i['pattern'] ?? i['skill'] ?? i['path'];
  if (typeof pick === 'string') return oneLine(pick, 160);
  return name === 'StructuredOutput' ? '(final answer)' : oneLine(JSON.stringify(input), 160);
}

function printEvent(event: TurnEvent): void {
  // Only conversation events carry a subagent's parent id; progress heartbeats reuse the field.
  const inSubagent =
    (event.kind === 'text' || event.kind === 'tool_use' || event.kind === 'tool_result') &&
    Boolean(event.parentToolUseId);
  const sub = inSubagent ? '  [subagent]' : '';
  switch (event.kind) {
    case 'init':
      console.log(
        `[init] session=${event.sessionId} model=${event.model} cli=${event.cliVersion} ` +
          `permission=${event.permissionMode} tools=[${event.tools.join(', ')}]`,
      );
      break;
    case 'text':
      if (event.text.trim()) console.log(`[text]${sub} ${oneLine(event.text)}`);
      break;
    case 'tool_use':
      console.log(`[tool]${sub} ${event.name} ${describeInput(event.name, event.input)}`);
      break;
    case 'tool_result':
      console.log(`[tool-result]${sub} ${event.isError ? 'ERROR' : 'ok'} ${oneLine(event.content, 160)}`);
      break;
    case 'rate_limit':
      console.log(
        `[rate-limit] ${event.info.status} (${event.info.rateLimitType ?? '?'}) resets ` +
          (event.info.resetsAt ? new Date(event.info.resetsAt * 1000).toLocaleString() : '?') +
          ` · overage ${event.info.overageStatus ?? '?'}`,
      );
      break;
    case 'api_retry':
      console.log(`[api-retry] attempt ${event.attempt}/${event.maxRetries} status=${event.errorStatus} ${event.error}`);
      break;
    case 'result':
      console.log(`[result] subtype=${event.subtype} is_error=${event.isError}`);
      break;
    case 'stderr':
      console.log(`[stderr] ${oneLine(event.text)}`);
      break;
    case 'unparsed':
      console.log(`[unparsed] ${oneLine(event.line)}`);
      break;
    case 'slow_turn':
      console.log(`[slow-turn] still running after ${(event.elapsedMs / 1000).toFixed(0)} s (threshold ${event.thresholdMs / 1000} s)`);
      break;
    case 'thinking':
      break;
    case 'other':
      console.log(`[${event.type}${event.subtype ? `/${event.subtype}` : ''}]${sub}`);
      break;
  }
}

function printOutcome(outcome: TurnOutcome, agent: string, physical: (p: string) => string): void {
  console.log('\n──────── outcome ────────');
  console.log(`${outcome.ok ? 'OK' : `FAILED (${outcome.error.kind})`}  ${agent} turn ${outcome.turnId}`);
  console.log(`session:   ${outcome.sessionId}${outcome.resumed ? '  (resumed)' : '  (new)'}`);
  console.log(
    `duration:  ${(outcome.durationMs / 1000).toFixed(1)} s   exit code ${outcome.exitCode}` +
      (outcome.slow ? `   ⚠ SLOW TURN (over ${(outcome.slowTurnMs ?? 0) / 1000} s)` : ''),
  );
  const p = outcome.processes;
  console.log(
    `processes: ${p.method} guard · ${p.survivors.length} left running and killed` +
      (p.errors.length ? ` · notes: ${p.errors.join('; ')}` : ''),
  );
  for (const s of p.survivors) {
    console.log(`  killed:  pid ${s.pid} ${s.name ?? '?'} ${oneLine(s.commandLine ?? '', 140)}`);
  }
  const m = outcome.model;
  console.log(
    `model:     requested ${m.requested} · announced ${m.announced ?? '?'} · served ${m.served ?? '?'}` +
      (m.contextWindow ? ` (${m.contextWindow.toLocaleString('en-US')} ctx)` : '') +
      (m.matches === false ? '   ⚠ MISMATCH' : m.matches ? '   ✓' : ''),
  );
  if (outcome.usage) {
    const u = outcome.usage;
    console.log(
      `context:   ${u.contextTokens?.toLocaleString('en-US') ?? '?'} tokens at end of turn` +
        `   (summed over ${u.numTurns ?? '?'} steps: in ${u.inputTokens} · cache read ${u.cacheReadTokens.toLocaleString('en-US')}` +
        ` · cache write ${u.cacheCreationTokens.toLocaleString('en-US')} · out ${u.outputTokens})`,
    );
    console.log(`cost:      $${u.costUsd?.toFixed(4) ?? '?'} (CLI estimate)`);
  }
  if (outcome.skillInvocations.length > 0) {
    for (const s of outcome.skillInvocations) {
      console.log(`skill:     ${s.skill} → ${s.isError === null ? 'no result' : s.isError ? 'ERROR' : 'ok'}`);
    }
  }
  if (outcome.answerRejections.count > 0) {
    const r = outcome.answerRejections;
    console.log(`refused:   ${r.count} structured answer(s), largest ${r.largestAttemptChars} chars — ${r.reasons.join(' / ')}`);
  }
  for (const d of outcome.permissionDenials) {
    console.log(`denied:    ${d.toolName} ${oneLine(JSON.stringify(d.input), 160)}`);
  }
  if (outcome.ok) {
    console.log('output:');
    console.log(JSON.stringify(outcome.output, null, 2));
  } else {
    console.log(`error:     ${outcome.error.message}`);
    if (outcome.error.validationIssues) console.log(`issues:    ${formatIssues(outcome.error.validationIssues)}`);
    if (outcome.error.resetsAt) console.log(`resets at: ${new Date(outcome.error.resetsAt * 1000).toLocaleString()}`);
    if (outcome.error.rawText) console.log(`raw text:\n${outcome.error.rawText}`);
  }
  // Physical locations: inside an MSIX container these differ from the paths the runner addressed.
  console.log(`raw:       ${physical(outcome.rawPath)}`);
  console.log(`stderr:    ${physical(outcome.stderrPath)}`);
  console.log(`prompt:    ${physical(outcome.systemPromptPath)}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
      resume: { type: 'string' },
      cwd: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
      model: { type: 'string' },
      effort: { type: 'string' },
      'timeout-sec': { type: 'string' },
      'slow-sec': { type: 'string' },
      'max-turns': { type: 'string' },
      standing: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const agent = values.agent;
  if (agent !== 'planner' && agent !== 'executor') fail('--agent must be "planner" or "executor"');
  const prompt =
    values.prompt ?? (values['prompt-file'] ? fs.readFileSync(values['prompt-file'], 'utf8') : undefined);
  if (!prompt) fail('--prompt (or --prompt-file) is required');

  const settings = loadSettings();
  const problem = settingsProblem();
  if (problem) console.log(`⚠ ${problem.file} could not be used, so defaults apply: ${problem.error}`);
  initDataFolder(settings.general.dataFolder);
  const defaults = settings.taskDefaults;

  let schemas: SchemaRegistry;
  try {
    schemas = SchemaRegistry.load(schemasFolder());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  let ctx;
  try {
    ctx = createRunnerContext(settings);
  } catch (err) {
    fail(err instanceof RunnerSetupError ? err.message : String(err));
  }

  const effortArg = values.effort;
  if (effortArg !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effortArg)) {
    fail(`--effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  }
  const model = values.model ?? (agent === 'planner' ? defaults.plannerModel : defaults.executorModel);
  const effort = (effortArg as EffortLevel | undefined) ??
    (agent === 'planner' ? defaults.plannerEffort : defaults.executorEffort);

  // Working directory.
  let cwd: string;
  let tools: readonly string[];
  if (agent === 'executor') {
    if (!values.cwd) fail('the executor needs --cwd <project folder> (it edits files there)');
    cwd = path.resolve(values.cwd);
    tools = settings.claudeCode.executorTools;
  } else if (values['read-only']) {
    if (!values.cwd) fail('--read-only needs --cwd <project folder>');
    cwd = path.resolve(values.cwd);
    tools = PLANNER_READ_ONLY_TOOLS;
  } else {
    cwd = path.join(tryTurnFolder(), 'planner-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    tools = [];
  }

  // System prompt: role prompt + standing instructions (composition is the orchestrator's job later).
  const standing = [defaults.standingPrompts[agent], values.standing ?? ''].filter((s) => s.trim()).join('\n\n');
  const role = fs.readFileSync(agentPromptFile(agent), 'utf8');
  const systemPrompt = standing ? `${role.trimEnd()}\n\n## Standing instructions\n\n${standing}\n` : role;

  const rawDir = path.join(tryTurnFolder(), 'raw');
  const location = detectStorageLocation(tryTurnFolder(), {
    platform: process.platform,
    appData: process.env['APPDATA'],
    localAppData: process.env['LOCALAPPDATA'],
    pid: process.pid,
  });

  // Live account, for the record (the pinning check itself is the orchestrator's, SPEC.md §3.6).
  const authRun = await runClaude(ctx.binary, ['auth', 'status', '--json'], { env: ctx.env, timeoutMs: 20_000 });
  const auth = parseAuthStatus(authRun.stdout);

  const timeoutMs = values['timeout-sec'] ? Number(values['timeout-sec']) * 1000 : defaults.turnTimeoutMinutes * 60_000;
  const maxTurns = values['max-turns'] ? Number(values['max-turns']) : defaults.maxTurnsPerSession;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('--timeout-sec must be a positive number');
  const slowTurnMs = values['slow-sec'] ? Number(values['slow-sec']) * 1000 : defaults.slowTurnWarningMinutes * 60_000;
  if (!Number.isFinite(slowTurnMs) || slowTurnMs <= 0) fail('--slow-sec must be a positive number');
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) fail('--max-turns must be a positive integer');

  console.log(`binary:    ${ctx.binary}`);
  console.log(
    `account:   ${auth.known ? `${auth.email ?? '(no email)'} · ${auth.orgName ?? '-'} · ${auth.subscriptionType ?? '-'}` : auth.unknownReason}`,
  );
  const guardStarted = Date.now();
  await warmUpProcessGuard();
  console.log(`agent:     ${agent}  model=${model} effort=${effort ?? '(none)'}  max-turns=${maxTurns}  timeout=${timeoutMs / 1000}s  slow=${slowTurnMs / 1000}s`);
  console.log(`guard:     process guard ready in ${Date.now() - guardStarted} ms`);
  console.log(`cwd:       ${cwd}`);
  console.log(`tools:     ${tools.length ? tools.join(', ') : '(none)'}`);
  console.log(
    `raw files: ${location.physicalPath}${location.redirected ? `  ⚠ REDIRECTED by the ${location.packageFamily} package container (addressed as ${location.path})` : ''}`,
  );
  console.log('');

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\n[stopping…]');
    controller.abort();
  });

  const spec: TurnSpec = {
    agent,
    prompt,
    ...(values.resume ? { resumeSessionId: values.resume } : {}),
    model,
    effort,
    cwd,
    tools,
    ...(agent === 'executor'
      ? {
          disallowedTools: settings.claudeCode.executorDisallowedTools,
          permissionMode: settings.claudeCode.permissionMode,
        }
      : {}),
    systemPrompt,
    schema: agent === 'planner' ? 'planner-output' : 'executor-output',
    maxTurns,
    timeoutMs,
    slowTurnMs,
    rawDir,
    ...(values.quiet ? {} : { onEvent: printEvent }),
    signal: controller.signal,
  };

  const outcome = await runTurn(spec, ctx, schemas);
  const physical = (p: string) =>
    location.redirected && p.toLowerCase().startsWith(location.path.toLowerCase())
      ? path.join(location.physicalPath, p.slice(location.path.length))
      : p;
  printOutcome(outcome, agent, physical);
  if (outcome.sessionId) {
    const cwdHint = agent === 'executor' || values['read-only'] ? ` --cwd "${cwd}"` : '';
    console.log(
      `\nnext:      npm run try-turn -- --agent ${agent} --resume ${outcome.sessionId}${cwdHint}${values['read-only'] ? ' --read-only' : ''} --prompt "…"`,
    );
  }
  disposeProcessGuard();
  process.exit(outcome.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  if ((err as { code?: string }).code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    // npm on Windows runs scripts through cmd.exe, which re-splits quoted arguments.
    fail(
      `${(err as Error).message}\n\nOn Windows, npm passes arguments through cmd.exe, which breaks prompts that ` +
        'contain double quotes or special characters. Put the prompt in a file and use --prompt-file <path>.',
    );
  }
  console.error(err);
  process.exit(2);
});
