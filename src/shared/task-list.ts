/**
 * How the task list is ordered, grouped and searched (SPEC.md §10, managing tasks). Pure functions shared by
 * the renderer and the tests; display only — the main process decides what may be archived or deleted.
 */

import type { TaskSummary } from './ipc';
import { AT_REST_STATUSES, type TaskStatus } from './task-model';

/** The task needs the user: a question, an approval, or an account to switch back to. */
export function needsUser(t: TaskSummary): boolean {
  return t.status === 'waiting_user' || t.status === 'account_mismatch';
}

/** Needing the user first, then running, then pinned, then the rest. Needing the user beats a pin. */
export function listRank(t: TaskSummary): number {
  if (needsUser(t)) return 0;
  if (t.status === 'running' || t.busy) return 1;
  if (t.pinnedToTop) return 2;
  return 3;
}

/** The list order: by rank, then the latest change first. */
export function sortTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => listRank(a) - listRank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

export interface ProjectGroup {
  key: string;
  name: string;
  dir: string;
  tasks: TaskSummary[];
  /** One of its tasks needs the user: shown on the group even when it is folded. */
  needsYou: boolean;
}

/** The group of tasks whose files cannot be read (no project to go under). A project key is an absolute path, never this. */
export const UNREADABLE_GROUP = '#unreadable';

/**
 * Groups by project folder, in the order of each group's first task (so the most urgent group comes first).
 * Tasks that cannot be read share one group of their own.
 */
export function groupByProject(sorted: readonly TaskSummary[]): ProjectGroup[] {
  const out = new Map<string, ProjectGroup>();
  for (const t of sorted) {
    const key = t.unreadable !== null ? UNREADABLE_GROUP : t.projectKey;
    let g = out.get(key);
    if (!g) {
      g =
        key === UNREADABLE_GROUP
          ? { key, name: 'Cannot be read', dir: 'Tasks whose files cannot be read', tasks: [], needsYou: false }
          : { key, name: t.projectName || t.projectDir, dir: t.projectDir, tasks: [], needsYou: false };
      out.set(key, g);
    }
    g.tasks.push(t);
    if (needsUser(t)) g.needsYou = true;
  }
  return [...out.values()];
}

/**
 * Search (SPEC.md §10): the name, the description and the project folder, ignoring case. Null for an empty
 * query (no search). Archived matches come last.
 */
export function searchTasks(sorted: readonly TaskSummary[], query: string): TaskSummary[] | null {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  const hit = (t: TaskSummary) => [t.title, t.name ?? '', t.description, t.projectDir].some((s) => s.toLowerCase().includes(q));
  return [...sorted.filter((t) => !t.archived && hit(t)), ...sorted.filter((t) => t.archived && hit(t))];
}

/** The task may be archived or deleted: mirrors the main process's check, which decides. */
export function atRest(t: TaskSummary): boolean {
  return t.unreadable !== null || (!t.busy && AT_REST_STATUSES.includes(t.status));
}

const NOT_AT_REST: Partial<Record<TaskStatus, string>> = {
  running: 'is running',
  waiting_user: 'is waiting for you',
  rate_limited: 'is waiting for the usage limit to reset',
  account_mismatch: 'is waiting for its Claude account',
};

/**
 * Why a task may not be archived or deleted (SPEC.md §10), or null when it may. One wording for the menu's
 * tooltip and the main process's refusal.
 */
export function restRefusal(status: TaskStatus, busy: boolean, what: 'archived' | 'deleted' | 'archived or deleted' = 'archived or deleted'): string | null {
  if (!busy && AT_REST_STATUSES.includes(status)) return null;
  const state = busy ? 'has a turn running' : (NOT_AT_REST[status] ?? `is ${status.replace(/_/g, ' ')}`);
  return `This task ${state}, so it cannot be ${what}. Stop it first.`;
}

/** Why Archive and Delete are unavailable, for the menu's tooltip; null when they are available. */
export function notAtRestReason(t: TaskSummary): string | null {
  return t.unreadable !== null ? null : restRefusal(t.status, t.busy);
}
