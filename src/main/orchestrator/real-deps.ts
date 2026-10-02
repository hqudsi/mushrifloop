/**
 * Wiring the orchestrator to the real world: the session runner, `claude auth status`, git, the task
 * folders and usage.json. The state machine itself (orchestrator.ts) never imports this file.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import type { Settings } from '../../shared/settings';
import { runClaude } from '../claude-cli';
import { agentPromptFile, schemasFolder, tasksFolder, usageFile } from '../config';
import { SchemaRegistry } from '../schema-validator';
import { TURN_KILL_BUDGET_MS, createRunnerContext, makeTurnId, probeInit, runTurn, type RunnerContext } from '../session-runner';
import { readAuthWithRetry, readingFromAuthOutput } from './account';
import { createGitOps } from './git';
import { TaskStore } from './task-store';
import type { AgentRole, OrchestratorDeps, TaskConfig, TaskNotice, TaskNotification } from './types';
import { UsageLedger } from './usage-ledger';

const AUTH_TIMEOUT_MS = 20_000;

/**
 * How long a Stop can take to complete (SPEC.md §6): the killed turn resolving (kill grace, then the
 * process-guard sweep), then the after-turn account check, which may read `claude auth status` twice.
 * 45 s + 40 s + 5 s margin = 90 s.
 */
export const STOP_BUDGET_MS = TURN_KILL_BUDGET_MS + 2 * AUTH_TIMEOUT_MS + 5_000;

/** A task's configuration from the Task defaults and connection settings (SPEC.md §11). */
export function taskConfigFromSettings(settings: Settings, overrides: Partial<TaskConfig> = {}): TaskConfig {
  const d = settings.taskDefaults;
  const c = settings.claudeCode;
  return {
    planner: { model: d.plannerModel, effort: d.plannerEffort },
    executor: { model: d.executorModel, effort: d.executorEffort },
    maxCycles: d.maxCycles,
    turnTimeoutMs: d.turnTimeoutMinutes * 60_000,
    slowTurnMs: d.slowTurnWarningMinutes * 60_000,
    maxTurnsPerSession: d.maxTurnsPerSession,
    approvalMode: d.approvalMode,
    plannerContextMode: d.plannerContextMode,
    standingInstructions: { planner: d.standingPrompts.planner, executor: d.standingPrompts.executor },
    rolloverPercent: d.rolloverPercent,
    freshExecutorAfterRejectedTurns: d.freshExecutorAfterRejectedTurns,
    requiredSkills: [...d.requiredSkillsBeforeDone],
    autoBranchAndCommit: d.autoBranchAndCommit,
    executorTools: [...c.executorTools],
    executorDisallowedTools: [...c.executorDisallowedTools],
    permissionMode: c.permissionMode,
    ...overrides,
  };
}

export interface RealDepsOptions {
  onNotice?: (notice: TaskNotice) => void;
  notify?: (notification: TaskNotification) => void;
  autoResume?: (taskId: string) => void;
  /** Defaults to <data folder>/tasks. */
  tasksRoot?: string;
  /** Defaults to <data folder>/usage.json. */
  usageFile?: string;
  /** Defaults to the CLI resolved from settings (the evaluation harness passes its fake CLI here). */
  runnerContext?: RunnerContext;
}

export interface RealDeps {
  deps: OrchestratorDeps;
  store: TaskStore;
  usage: UsageLedger;
  binary: string;
}

/**
 * Throws `RunnerSetupError` when the CLI cannot be found and `SchemaLoadError` when a schema does not
 * compile — both are startup failures, not something to run around.
 */
export function createRealDeps(settings: Settings, options: RealDepsOptions = {}): RealDeps {
  const schemas = SchemaRegistry.load(schemasFolder());
  const ctx = options.runnerContext ?? createRunnerContext(settings);
  const store = new TaskStore(options.tasksRoot ?? tasksFolder());
  const usage = new UsageLedger(options.usageFile ?? usageFile());
  const roles: Partial<Record<AgentRole, string>> = {};

  const deps: OrchestratorDeps = {
    runTurn: (spec) => runTurn(spec, ctx, schemas),
    probeInit: (input) => probeInit(input, ctx),
    authStatus: () =>
      readAuthWithRetry(async () =>
        readingFromAuthOutput(
          await runClaude(ctx.binary, [...(ctx.binaryArgs ?? []), 'auth', 'status', '--json'], { env: ctx.env, timeoutMs: AUTH_TIMEOUT_MS }),
        ),
      ),
    git: createGitOps(),
    store,
    usage,
    // Read once per process: a session's system prompt is fixed when it starts anyway.
    rolePrompt: (agent) => (roles[agent] ??= fs.readFileSync(agentPromptFile(agent), 'utf8')),
    now: () => new Date(),
    newSessionId: () => randomUUID(),
    newTurnId: (agent) => makeTurnId(agent),
    schedule: (at, fn) => {
      // setTimeout cannot wait longer than ~24.8 days; re-arm in steps.
      let timer: NodeJS.Timeout;
      const arm = () => {
        const wait = Math.min(Math.max(0, at - Date.now()), 2_000_000_000);
        timer = setTimeout(() => (Date.now() >= at ? fn() : arm()), wait);
      };
      arm();
      return () => clearTimeout(timer);
    },
    general: {
      autoResumeAtReset: settings.general.autoResumeAtReset,
      softDailyTokenCap: settings.general.softDailyTokenCap,
    },
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.autoResume ? { autoResume: options.autoResume } : {}),
  };
  return { deps, store, usage, binary: ctx.binary };
}
