/**
 * What a task notification says (SPEC.md §10, design "System notification toast"). Pure: the main
 * process decides where it is shown — in the app while the window has focus, by Windows otherwise.
 *
 * Only states the user did not cause are announced: a pause the user asked for, a Stop or a Resume
 * is not news to them.
 */

import { formatMoment, isSameLocalDay } from '../shared/format';
import type { TaskToast } from '../shared/ipc';
import type { NotificationSettings } from '../shared/settings';
import type { CycleSummary, TaskRecord } from '../shared/task-model';

const TITLE_MAX = 60;

/** The task's name in a notification: the first non-empty line of its description. */
/** The name a task is shown by (SPEC.md §10): the user's title if it has one, else its description's first line. */
export function taskTitle(task: { title?: string | null; description: string }, max = TITLE_MAX): string {
  const own = task.title?.trim();
  if (own) return own.length > max ? `${own.slice(0, max - 1)}…` : own;
  return taskName(task.description, max);
}

export function taskName(description: string, max = TITLE_MAX): string {
  const line = (description.split(/\r?\n/).find((l) => l.trim() !== '') ?? description).trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function firstLine(text: string | null | undefined, max = 160): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The notification for the status a task just entered, or null when there is nothing to announce. */
export function statusToast(task: TaskRecord, at: string): TaskToast | null {
  const name = `'${taskTitle(task)}'`;
  const make = (category: TaskToast['category'], title: string, body: string): TaskToast => ({
    taskId: task.id,
    category,
    tone: category === 'waiting' ? 'wait' : task.status === 'done' ? 'done' : 'bad',
    title,
    body,
    at,
  });
  const reason = firstLine(task.statusReason);
  switch (task.status) {
    case 'waiting_user': {
      const w = task.waiting;
      switch (w?.kind) {
        case 'question':
          return w.plannerStatus === 'blocked'
            ? make('waiting', 'Waiting for your input', `Task ${name} is blocked — the Planner needs your help.`)
            : make('waiting', 'Waiting for your input', `Task ${name} is waiting for your input — the Planner asked a question.`);
        case 'instruction_approval':
          return make('waiting', 'Approval needed', `Task ${name} — the Planner's next instruction is waiting for your approval.`);
        case 'plan_approval':
          return make('waiting', 'Plan ready for review', `Task ${name} — the Planner proposes a plan. Approve it to start.`);
        case 'skill_waiver':
          return make('waiting', 'Decision needed', `Task ${name} — a required skill cannot run here: ${w.skills.map((s) => s.skill).join(', ')}.`);
        case 'possible_loop':
          return make('waiting', 'Paused: possible loop', `Task ${name} — ${sentence(reason || 'the loop may be repeating itself')}`);
        case 'paused':
          return w.cause === 'daily_cap' ? make('waiting', 'Paused: daily token cap', `Task ${name} — ${sentence(reason)}`) : null;
        default:
          return null;
      }
    }
    case 'account_mismatch': {
      const pinned = task.pinnedAccount.email ?? task.pinnedAccount.apiKeySource ?? 'the pinned account';
      return make('waiting', 'Claude Code account changed', `Task ${name} is paused — switch Claude Code back to ${pinned}, then Resume.`);
    }
    case 'done':
      return make('finished', 'Task done', `Task ${name} finished after ${task.cycles} ${task.cycles === 1 ? 'cycle' : 'cycles'}.`);
    case 'failed':
      return make('finished', 'Task failed', `Task ${name} — ${sentence(reason || 'it failed')}`);
    case 'error':
      return make('finished', 'Task stopped with an error', `Task ${name} — ${sentence(reason || 'the last step failed')} Resume retries it.`);
    case 'rate_limited': {
      // A weekly limit resets days away: its date, not just a clock time (SPEC.md §10).
      const resetMs = task.rateLimit?.resetsAt ? task.rateLimit.resetsAt * 1000 : null;
      const resets = resetMs === null ? '' : ` It resets ${isSameLocalDay(resetMs, Date.now()) ? 'at ' : ''}${formatMoment(resetMs)}.`;
      return make('finished', 'Usage limit reached', `Task ${name} is paused by the usage limit.${resets}`);
    }
    default:
      return null;
  }
}

/** Auto-resume at reset found another task running (SPEC.md §6, §17); the task waits for the user. */
export function autoResumeSkippedToast(task: TaskRecord, blockedBy: { title: string }, at: string): TaskToast {
  return {
    taskId: task.id,
    category: 'waiting',
    tone: 'wait',
    title: 'Auto-resume skipped',
    body: `Task '${taskTitle(task)}' was not resumed at the reset: task '${taskName(blockedBy.title)}' is running. Resume it when that one is done.`,
    at,
  };
}

/** "Every completed cycle" (Settings → General). */
export function cycleToast(task: TaskRecord, cycle: CycleSummary, at: string): TaskToast {
  const files = cycle.changedFiles.length;
  // SPEC.md §4: a possibly truncated report is never announced as a clean ok.
  const truncated = cycle.answerCheck?.possiblyTruncated === true;
  const status = truncated ? `${cycle.executorStatus ?? 'a report'}, but its report is possibly truncated` : (cycle.executorStatus ?? 'no report');
  return {
    taskId: task.id,
    category: 'cycle',
    tone: truncated ? 'bad' : 'info',
    title: `Cycle ${cycle.cycle} of ${task.config.maxCycles} finished`,
    body: `Task '${taskTitle(task)}' — the Executor reported ${status}; ${files} ${files === 1 ? 'file' : 'files'} changed.`,
    at,
  };
}

/** Whether Settings → General → Notifications allows this notification. */
export function toastAllowed(toast: TaskToast, settings: NotificationSettings): boolean {
  switch (toast.category) {
    case 'waiting':
      return settings.waitingForInput;
    case 'finished':
      return settings.finishedOrFailed;
    case 'cycle':
      return settings.everyCompletedCycle;
  }
}
