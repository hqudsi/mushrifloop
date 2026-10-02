/**
 * Orchestrator core (SPEC.md §12 phase 3).
 *
 *   const { deps, store } = createRealDeps(settings, { onNotice });
 *   const runner = await TaskRunner.create({ description, projectDir, config: taskConfigFromSettings(settings) }, deps);
 *   await runner.start();              // resolves when the loop halts (waiting, done, error, …)
 *   await runner.answer('…');          // and so on
 *
 *   // after a restart
 *   const runner = TaskRunner.load(store.readTask(id), store.readEvents(id), deps);
 */

export { AccountPinError, accountLabel, compareAccount, describeAccount, pinAccount, readAuthSettled, readAuthWithRetry, readingFromAuthOutput } from './account';
export type { SettledAuth } from './account';
export { EMPTY_TREE, GitError, GitUnavailableError, changesSince, createGitOps, isWorkTree, refExists, type GitFileChange } from './git';
export {
  AUTO_RESUME_MARGIN_MS,
  SERVICE_RETRY_DELAY_MS,
  TaskCreationError,
  TaskRunner,
  TaskStateError,
  makeTaskId,
  toTurnRecord,
  type CreateTaskInput,
} from './orchestrator';
export { formatDuration } from './prompts';
export { STOP_BUDGET_MS, createRealDeps, taskConfigFromSettings, type RealDeps, type RealDepsOptions } from './real-deps';
export { TaskStore } from './task-store';
export { UsageLedger, totalTokens, type UsageFile } from './usage-ledger';
export type * from './types';
export { RESUMABLE_STATUSES, TERMINAL_STATUSES } from './types';
