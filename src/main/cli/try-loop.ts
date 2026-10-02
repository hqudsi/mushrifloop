/**
 * npm run try-loop -- --project <path> --task "<text>" [options]
 *
 * Runs a whole supervised loop (SPEC.md §4) from the terminal against a real project and the real CLI,
 * printing each cycle. When the task waits for you (a question, an approval, a pause) it asks here.
 *
 *   --project <dir>               the executor's project folder (required unless --resume)
 *   --task "<text>"               the task description (or --task-file <path>)
 *   --resume <task-id>            continue a stored task (stopped / error / rate_limited / waiting)
 *   --approval auto|review|plan_first      default: settings
 *   --planner-model <id> --planner-effort <lvl>
 *   --executor-model <id> --executor-effort <lvl>
 *   --max-cycles <n>  --timeout-sec <n>  --slow-sec <n>
 *   --required-skills "a,b"       "" = none; default: settings
 *   --rollover-percent <n>        default: settings (SPEC.md §15)
 *   --no-commit                   turn off auto-branch and commit for this task
 *   --non-interactive             exit instead of asking when the task waits
 *   --quiet                       no live tool/text lines, only the cycle summaries
 *
 * Ctrl+C stops the current turn (status `stopped`); `--resume <task-id>` continues it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { EFFORT_LEVELS, coerceEffort, getModel, type EffortLevel } from '../../shared/models';
import type { ApprovalMode } from '../../shared/settings';
import { initDataFolder, tasksFolder } from '../config';
import {
  TaskRunner,
  createRealDeps,
  describeAccount,
  formatDuration,
  taskConfigFromSettings,
  type ExecutorOutput,
  type PlannerOutput,
  type TaskConfig,
  type TaskEvent,
  type TaskNotice,
  type TaskRecord,
} from '../orchestrator';
import { disposeProcessGuard, warmUpProcessGuard, type TurnEvent } from '../session-runner';
import { loadSettings, settingsProblem } from '../settings';
import { detectStorageLocation } from '../storage-location';
import { undoCmdEscapes } from './cmd-escapes';

function fail(message: string, code = 2): never {
  console.error(`try-loop: ${message}`);
  process.exit(code);
}

const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const indent = (text: string, pad = '      ') =>
  text
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join('\n');

const short = (id: string) => id.slice(0, 8);

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

let quiet = false;
let totalCost = 0;

function describeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  const pick = i['command'] ?? i['file_path'] ?? i['pattern'] ?? i['skill'] ?? i['path'];
  return typeof pick === 'string' ? oneLine(pick, 140) : '';
}

function printTurnEvent(agent: string, event: TurnEvent): void {
  if (quiet) return;
  const tag = agent === 'planner' ? 'P' : 'E';
  const inSubagent = (event.kind === 'text' || event.kind === 'tool_use' || event.kind === 'tool_result') && Boolean(event.parentToolUseId);
  const sub = inSubagent ? ' [subagent]' : '';
  switch (event.kind) {
    case 'tool_use':
      if (event.name !== 'StructuredOutput') console.log(`   ${tag}${sub} ▸ ${event.name} ${describeInput(event.input)}`);
      break;
    case 'tool_result':
      if (event.isError) console.log(`   ${tag}${sub}   ✗ ${oneLine(event.content, 140)}`);
      break;
    case 'text':
      if (event.text.trim()) console.log(`   ${tag}${sub} “${oneLine(event.text, 160)}”`);
      break;
    case 'api_retry':
      console.log(`   ${tag} api retry ${event.attempt}/${event.maxRetries} (status ${event.errorStatus}) ${event.error ?? ''}`);
      break;
    case 'rate_limit':
      if (event.info.status !== 'allowed') console.log(`   ${tag} rate limit: ${event.info.status} (${event.info.rateLimitType})`);
      break;
    case 'slow_turn':
      console.log(`   ${tag} ⚠ slow turn: still running after ${formatDuration(event.elapsedMs)}`);
      break;
    default:
      break;
  }
}

function printEvent(event: TaskEvent): void {
  switch (event.type) {
    case 'setup': {
      const g = event.git;
      console.log(
        `setup:     git ${g.isRepo ? (g.branch ? `branch ${g.branch} (from ${g.originalBranch ?? 'unborn'} @ ${g.startCommit?.slice(0, 8) ?? 'no commit'})` : (g.inertReason ?? 'off')) : (g.inertReason ?? 'not a repo')}` +
          `${g.isRepo ? ` · remote: ${g.hasRemote ? 'yes' : 'none'}` : ''}${g.dirtyAtStart.length ? ` · ⚠ ${g.dirtyAtStart.length} uncommitted file(s) at start` : ''}`,
      );
      console.log(
        `skills:    ${event.skills === null ? `unknown (${event.skillsError})` : `${event.skills.length} available`}` +
          (event.missingRequiredSkills.length ? ` · ⚠ required but not available: ${event.missingRequiredSkills.join(', ')}` : ''),
      );
      break;
    }
    case 'turn_started': {
      const label =
        event.purpose === 'handoff'
          ? `${event.agent} · handoff`
          : event.agent === 'executor'
            ? `cycle ${event.cycle} · executor${event.purpose === 'user_message' ? ' (user message)' : ''}`
            : `planner · ${event.purpose}`;
      console.log(`\n── ${label} · ${event.model}${event.effort ? `/${event.effort}` : ''} · session ${short(event.sessionId)} ${event.resumed ? '(resumed)' : '(new)'} ──`);
      if (event.purpose === 'handoff') console.log('   (rollover: asking for a handoff summary)');
      break;
    }
    case 'turn': {
      const cost = event.usage?.costUsd ?? 0;
      totalCost += cost;
      const bits = [
        formatDuration(event.durationMs),
        event.usage ? `ctx ${event.usage.contextTokens?.toLocaleString('en-US') ?? '?'}` : null,
        event.usage ? `$${cost.toFixed(3)}` : null,
        event.model.served ? `served ${event.model.served}${event.model.matches === false ? ' ⚠ MISMATCH' : ''}` : null,
        event.slow ? '⚠ SLOW' : null,
        `processes killed: ${event.processes.count}${event.processes.method !== 'job' ? ` (${event.processes.method})` : ''}`,
        event.accountChanged ? '⚠ ACCOUNT CHANGED DURING TURN' : null,
      ].filter(Boolean);
      console.log(`   ${event.ok ? '✓' : '✗'} ${bits.join(' · ')}`);
      for (const s of event.processes.survivors) console.log(`     killed pid ${s.pid} ${s.name ?? ''}${s.outsideJob ? ' (outside job!)' : ''} ${oneLine(s.commandLine ?? '', 100)}`);
      for (const d of event.permissionDenials) console.log(`     denied: ${d.toolName} ${oneLine(JSON.stringify(d.input), 100)}`);
      if (event.answerCheck) {
        const c = event.answerCheck;
        console.log(`   ⚠ answer refused ${c.count}×${c.possiblyTruncated ? ' · POSSIBLY TRUNCATED' : ''} — ${oneLine(c.reasons.join(' / '), 200)}`);
      }
      if (!event.ok && event.error) {
        console.log(`   error (${event.error.kind}): ${event.error.message}`);
        if (event.error.rawText) console.log(indent(event.error.rawText.slice(0, 1500)));
        break;
      }
      if (event.purpose === 'handoff') break;
      if (event.agent === 'planner') {
        const out = event.output as PlannerOutput;
        console.log(`   → ${out.status.toUpperCase()}: ${oneLine(out.reasoning_summary, 300)}`);
        if (out.next_instruction) console.log(indent(out.next_instruction));
        if (out.use_skills?.length) console.log(`      skills: ${out.use_skills.join(', ')}`);
        if (out.request_executor_rollover) console.log('      (requests an executor rollover)');
      } else {
        const out = event.output as ExecutorOutput;
        console.log(`   → ${out.status.toUpperCase()}: ${oneLine(out.summary, 400)}`);
        if (out.changed_files.length) console.log(`      files: ${out.changed_files.map((f) => `${f.path} (${f.change})`).join(', ')}`);
        console.log(`      tests: ${out.tests.ran ? `ran · passed ${out.tests.passed ?? '?'} · failed ${out.tests.failed ?? '?'}` : 'not run'}${out.tests.notes ? ` · ${oneLine(out.tests.notes, 120)}` : ''}`);
        for (const p of out.problems) console.log(`      problem: ${oneLine(p, 200)}`);
        if (out.question) console.log(`      question: ${out.question}`);
      }
      break;
    }
    case 'cycle': {
      const c = event.commit;
      const commit =
        c.state === 'committed' ? `${c.hash.slice(0, 10)} "${c.message}"` : c.state === 'failed' ? `FAILED: ${c.error}` : c.state === 'skipped' ? `none (${c.reason})` : 'none (nothing to commit)';
      console.log(`   commit: ${commit}`);
      for (const s of event.skillOutcomes) console.log(`   skill ${s.skill}: ${s.state}`);
      break;
    }
    case 'commit':
      if (event.purpose === 'before_review') console.log(`   pre-review commit: ${event.info.state === 'committed' ? event.info.hash.slice(0, 10) : event.info.state}`);
      if (event.purpose === 'snapshot' && event.info.state === 'committed') {
        console.log(`snapshot:  your uncommitted work → ${event.info.hash.slice(0, 10)} "${event.info.message}" (${event.info.files.length} file(s))`);
      }
      break;
    case 'skill_waived':
      console.log(`   ✓ ${event.skill} waived for this task (${event.reason})${event.note ? ` — "${event.note}"` : ''}`);
      break;
    case 'skill_waiver_declined':
      console.log(`   ✗ waiver declined for ${event.skills.map((s) => s.skill).join(', ')}`);
      break;
    case 'refused':
      console.log(`   ⛔ orchestrator refused the planner's answer (${event.reason}${event.missing.length ? `: ${event.missing.join(', ')}` : ''})`);
      break;
    case 'loop_detected':
      console.log(`   ⚠ loop detected (${event.kind}): ${oneLine(event.detail, 200)}`);
      break;
    case 'rollover':
      console.log(`   ↻ ${event.agent} rolled over: ${short(event.oldSessionId)} → ${short(event.newSessionId)} (${event.reason})`);
      break;
    case 'rate_limit':
      console.log(`   rate limit ${event.status} (${event.rateLimitType ?? '?'}), resets ${event.resetsAt ? new Date(event.resetsAt * 1000).toLocaleString() : '?'}`);
      break;
    case 'account_mismatch':
      console.log(`   ⚠ account mismatch (${event.when}): pinned ${describeAccount(event.pinned)} · live ${event.live.ok ? describeAccount(event.live.account) : event.live.error}`);
      break;
    case 'status':
      if (event.to !== 'running') console.log(`\n■ status: ${event.to}${event.reason ? ` — ${event.reason}` : ''}`);
      break;
    case 'recovered':
      console.log(`recovered: ${event.detail}`);
      break;
    default:
      break;
  }
}

function onNotice(notice: TaskNotice): void {
  if (notice.type === 'event') printEvent(notice.event);
  else if (notice.type === 'turn_event') printTurnEvent(notice.agent, notice.event);
}

// ---------------------------------------------------------------------------
// Waiting for the user
// ---------------------------------------------------------------------------

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

/** Returns false when the user wants to leave the task where it is. */
async function handleWaiting(runner: TaskRunner, task: TaskRecord, rl: readline.Interface): Promise<boolean> {
  const w = task.waiting;
  if (!w) return false;
  console.log('');
  switch (w.kind) {
    case 'question': {
      console.log(`The planner ${w.plannerStatus === 'blocked' ? 'is blocked' : 'asks'}:\n${indent(w.question, '  ')}`);
      const answer = await ask(rl, 'answer (empty = leave it) > ');
      if (!answer) return false;
      await runner.answer(answer);
      return true;
    }
    case 'instruction_approval': {
      console.log(`Approve this instruction?\n${indent(w.instruction, '  ')}`);
      if (w.useSkills.length) console.log(`  skills: ${w.useSkills.join(', ')}`);
      if (w.reasoning) console.log(`  (planner: ${oneLine(w.reasoning, 300)})`);
      const choice = (await ask(rl, '[a]pprove  [e]dit  [r]eject  [q]uit > ')).toLowerCase();
      if (choice === 'a') await runner.approveInstruction();
      else if (choice === 'e') await runner.approveInstruction(await ask(rl, 'new instruction (one line) > '));
      else if (choice === 'r') await runner.rejectInstruction((await ask(rl, 'reason > ')) || 'Rejected by the user.');
      else return false;
      return true;
    }
    case 'plan_approval': {
      console.log(`Approve this plan?\n${indent(w.plan, '  ')}`);
      const choice = (await ask(rl, '[a]pprove  [e]dit  [r]eject  [q]uit > ')).toLowerCase();
      if (choice === 'a') await runner.approvePlan();
      else if (choice === 'e') await runner.approvePlan(await ask(rl, 'edited plan (one line) > '));
      else if (choice === 'r') await runner.rejectPlan((await ask(rl, 'reason > ')) || 'Revise the plan.');
      else return false;
      return true;
    }
    case 'skill_waiver': {
      console.log('A required skill cannot run in this environment:');
      for (const b of w.skills) console.log(`  ${b.skill}: ${b.reason}`);
      const first = w.skills[0];
      if (!first) return false;
      const choice = (await ask(rl, `[w]aive ${first.skill} for this task  [r]eply to the planner  [q]uit > `)).toLowerCase();
      if (choice === 'w') await runner.waiveSkill(first.skill, (await ask(rl, 'note (optional) > ')) || undefined);
      else if (choice === 'r') {
        const text = await ask(rl, 'message > ');
        if (!text) return false;
        await runner.declineWaiver(text);
      } else return false;
      return true;
    }
    case 'possible_loop':
    case 'paused': {
      console.log(w.reason);
      const choice = (await ask(rl, '[c]ontinue  [m]essage the planner  [q]uit > ')).toLowerCase();
      if (choice === 'c') await runner.resume();
      else if (choice === 'm') {
        const text = await ask(rl, 'message > ');
        if (!text) return false;
        await runner.answer(text);
      } else return false;
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function effortArg(value: string | undefined, name: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) fail(`--${name} must be one of ${EFFORT_LEVELS.join(', ')}`);
  return value as EffortLevel;
}

function modelArg(value: string | undefined, name: string): string | undefined {
  if (value !== undefined && !getModel(value)) fail(`--${name}: unknown model "${value}" (SPEC.md §8)`);
  return value;
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      resume: { type: 'string' },
      approval: { type: 'string' },
      'planner-model': { type: 'string' },
      'planner-effort': { type: 'string' },
      'executor-model': { type: 'string' },
      'executor-effort': { type: 'string' },
      'max-cycles': { type: 'string' },
      'timeout-sec': { type: 'string' },
      'slow-sec': { type: 'string' },
      'required-skills': { type: 'string' },
      'rollover-percent': { type: 'string' },
      'no-commit': { type: 'boolean', default: false },
      'non-interactive': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
    strict: true,
  });
  quiet = values.quiet;

  const settings = loadSettings();
  const problem = settingsProblem();
  if (problem) console.log(`⚠ ${problem.file} could not be used, so defaults apply: ${problem.error}`);
  initDataFolder(settings.general.dataFolder);

  let real;
  try {
    real = createRealDeps(settings, {
      onNotice,
      notify: (n) => console.log(`\n🔔 ${n.title}${n.body ? `: ${oneLine(n.body, 200)}` : ''}`),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { deps, store } = real;

  const location = detectStorageLocation(tasksFolder(), {
    platform: process.platform,
    appData: process.env['APPDATA'],
    localAppData: process.env['LOCALAPPDATA'],
    pid: process.pid,
  });
  const physical = (p: string) =>
    location.redirected && p.toLowerCase().startsWith(location.path.toLowerCase())
      ? path.join(location.physicalPath, p.slice(location.path.length))
      : p;

  console.log(`binary:    ${real.binary}`);
  const live = await deps.authStatus();
  console.log(`account:   ${live.ok ? `${describeAccount(live.account)}${live.loggedIn ? '' : ' (NOT logged in)'}` : live.error}`);
  await warmUpProcessGuard();

  let runner: TaskRunner;
  if (values.resume) {
    try {
      runner = TaskRunner.load(store.readTask(values.resume), store.readEvents(values.resume), deps);
    } catch (err) {
      fail(`cannot load task ${values.resume}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    if (!values.project) fail('--project <folder> is required');
    let description = values.task ?? (values['task-file'] ? fs.readFileSync(values['task-file'], 'utf8') : undefined);
    if (!description) fail('--task "<text>" (or --task-file <path>) is required');
    if (values.task !== undefined) {
      const undone = undoCmdEscapes(description);
      if (undone.changed) {
        console.log('note:      removed cmd.exe caret escapes from --task (npm on Windows); --task-file avoids this');
        description = undone.text;
      }
    }
    const approval = values.approval;
    if (approval !== undefined && !['auto', 'review', 'plan_first'].includes(approval)) fail('--approval must be auto, review or plan_first');
    const d = taskConfigFromSettings(settings);
    const plannerModel = modelArg(values['planner-model'], 'planner-model') ?? d.planner.model;
    const executorModel = modelArg(values['executor-model'], 'executor-model') ?? d.executor.model;
    const overrides: Partial<TaskConfig> = {
      planner: { model: plannerModel, effort: coerceEffort(plannerModel, effortArg(values['planner-effort'], 'planner-effort') ?? d.planner.effort) },
      executor: { model: executorModel, effort: coerceEffort(executorModel, effortArg(values['executor-effort'], 'executor-effort') ?? d.executor.effort) },
    };
    if (approval) overrides.approvalMode = approval as ApprovalMode;
    const maxCycles = positive(values['max-cycles'], 'max-cycles');
    if (maxCycles) overrides.maxCycles = Math.round(maxCycles);
    const timeout = positive(values['timeout-sec'], 'timeout-sec');
    if (timeout) overrides.turnTimeoutMs = timeout * 1000;
    const slow = positive(values['slow-sec'], 'slow-sec');
    if (slow) overrides.slowTurnMs = slow * 1000;
    if (values['required-skills'] !== undefined) {
      overrides.requiredSkills = values['required-skills'].split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (values['no-commit']) overrides.autoBranchAndCommit = false;
    const rollover = positive(values['rollover-percent'], 'rollover-percent');
    if (rollover) {
      if (rollover < 5 || rollover > 95) fail('--rollover-percent must be between 5 and 95');
      overrides.rolloverPercent = Math.round(rollover);
    }
    try {
      runner = await TaskRunner.create({ description, projectDir: values.project, config: taskConfigFromSettings(settings, overrides) }, deps);
    } catch (err) {
      const e = err as Error & { nextStep?: string };
      fail(`${e.message}${e.nextStep ? `\nNext step: ${e.nextStep}` : ''}`);
    }
  }

  const task = runner.snapshot;
  const c = task.config;
  console.log(`task:      ${task.id}  (${task.status})`);
  console.log(`folder:    ${physical(store.taskDir(task.id))}${location.redirected ? `  ⚠ REDIRECTED by the ${location.packageFamily} package container` : ''}`);
  console.log(`project:   ${task.projectDir}`);
  console.log(`pinned:    ${describeAccount(task.pinnedAccount)}`);
  console.log(
    `config:    planner ${c.planner.model}/${c.planner.effort ?? '-'} · executor ${c.executor.model}/${c.executor.effort ?? '-'} · ${c.approvalMode} · ` +
      `max ${c.maxCycles} cycles · timeout ${formatDuration(c.turnTimeoutMs)} · slow ${formatDuration(c.slowTurnMs)} · ` +
      `rollover at ${c.rolloverPercent}% · required skills: ${c.requiredSkills.join(', ') || 'none'} · auto-commit ${c.autoBranchAndCommit ? 'on' : 'off'}`,
  );
  console.log(`task text: ${oneLine(task.description, 300)}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\n[stopping the current turn… Ctrl+C again to exit at once]');
    void runner.stop();
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));

  const started = Date.now();
  if (task.status === 'draft') await runner.start();
  else if (task.status !== 'waiting_user') await runner.resume().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

  const interactive = !values['non-interactive'] && process.stdin.isTTY === true;
  while (!stopping) {
    await runner.whenIdle();
    const now = runner.snapshot;
    if (now.status !== 'waiting_user' || !interactive) break;
    if (!(await handleWaiting(runner, now, rl))) break;
  }
  await runner.whenIdle();
  rl.close();
  runner.dispose();

  const end = runner.snapshot;
  const events = store.readEvents(end.id);
  const commits = events.filter((e) => e.type === 'commit' && e.info.state === 'committed');
  console.log('\n════════ summary ════════');
  console.log(`status:    ${end.status}${end.statusReason ? ` — ${end.statusReason}` : ''}`);
  console.log(`cycles:    ${end.cycles} executor · ${end.plannerTurns} planner turns · ${formatDuration(Date.now() - started)} this run`);
  console.log(`cost:      $${totalCost.toFixed(3)} this run (CLI estimate)`);
  console.log(`sessions:  planner ${end.sessions.planner.sessionId} · executor ${end.sessions.executor.sessionId}` +
    (end.sessions.planner.retired.length + end.sessions.executor.retired.length ? ` · retired ${end.sessions.planner.retired.length + end.sessions.executor.retired.length}` : ''));
  if (end.git.branch) console.log(`branch:    ${end.git.branch} · ${commits.length} commit(s)`);
  if (end.finalReport) console.log(`report:\n${indent(end.finalReport, '  ')}`);
  console.log(`events:    ${physical(store.eventsFile(end.id))}`);
  if (end.status !== 'done' && end.status !== 'failed') console.log(`continue:  npm run try-loop -- --resume ${end.id}`);
  disposeProcessGuard();
  process.exit(end.status === 'done' ? 0 : 1);
}

main().catch((err: unknown) => {
  if ((err as { code?: string }).code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    fail(
      `${(err as Error).message}\n\nOn Windows, npm passes arguments through cmd.exe, which breaks text that contains ` +
        'double quotes or special characters. Put the task in a file and use --task-file <path>.',
    );
  }
  console.error(err);
  process.exit(2);
});
