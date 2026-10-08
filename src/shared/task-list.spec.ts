/**
 * The task list's order, grouping and search (SPEC.md §10, managing tasks).
 */
import { describe, expect, it } from 'vitest';

import type { TaskSummary } from './ipc';
import { atRest, groupByProject, notAtRestReason, searchTasks, sortTasks } from './task-list';

let seq = 0;
function task(over: Partial<TaskSummary> = {}): TaskSummary {
  seq++;
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    name: null,
    description: `Task ${seq}`,
    projectDir: 'D:\\Work\\App',
    projectName: 'App',
    projectKey: 'd:\\work\\app',
    archived: false,
    pinnedToTop: false,
    gitBranch: null,
    status: 'done',
    statusReason: null,
    waitingKind: null,
    cycles: 1,
    maxCycles: 100,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    statusChangedAt: '2026-10-01T00:00:00.000Z',
    busy: false,
    pinned: { email: null, orgName: null, subscriptionType: null },
    planner: 'opus',
    executor: 'sonnet',
    unreadable: null,
    ...over,
  };
}

describe('sortTasks', () => {
  it('needs-you first, then running, then pinned, then the newest change', () => {
    const old = task({ title: 'old', updatedAt: '2026-10-01T00:00:00.000Z' });
    const recent = task({ title: 'recent', updatedAt: '2026-10-05T00:00:00.000Z' });
    const pinned = task({ title: 'pinned', pinnedToTop: true, updatedAt: '2026-09-01T00:00:00.000Z' });
    const running = task({ title: 'running', status: 'running', busy: true, updatedAt: '2026-09-02T00:00:00.000Z' });
    const waiting = task({ title: 'waiting', status: 'waiting_user', updatedAt: '2026-09-03T00:00:00.000Z' });
    const waitingPinned = task({ title: 'waiting pinned', status: 'waiting_user', pinnedToTop: true, updatedAt: '2026-09-04T00:00:00.000Z' });
    expect(sortTasks([old, pinned, recent, running, waiting, waitingPinned]).map((t) => t.title)).toEqual([
      'waiting pinned',
      'waiting',
      'running',
      'pinned',
      'recent',
      'old',
    ]);
  });
});

describe('groupByProject', () => {
  it('groups by the project key, in the order of each group first task, and flags a group that needs you', () => {
    const a1 = task({ projectKey: 'd:\\a', projectDir: 'D:\\A', projectName: 'A', status: 'waiting_user' });
    const b1 = task({ projectKey: 'd:\\b', projectDir: 'D:\\B', projectName: 'B' });
    const a2 = task({ projectKey: 'd:\\a', projectDir: 'd:\\a\\', projectName: 'a' });
    const groups = groupByProject([a1, b1, a2]);
    expect(groups.map((g) => [g.name, g.tasks.length, g.needsYou])).toEqual([
      ['A', 2, true],
      ['B', 1, false],
    ]);
    expect(groups[0]!.dir).toBe('D:\\A');
  });

  it('two folders with the same name stay two groups', () => {
    const x = task({ projectKey: 'd:\\one\\app', projectDir: 'D:\\one\\app', projectName: 'app' });
    const y = task({ projectKey: 'd:\\two\\app', projectDir: 'D:\\two\\app', projectName: 'app' });
    expect(groupByProject([x, y]).map((g) => g.dir)).toEqual(['D:\\one\\app', 'D:\\two\\app']);
  });
});

describe('searchTasks', () => {
  const named = task({ name: 'Login page', title: 'Login page', description: 'Fix the form\nand the CSS' });
  const other = task({ title: 'Refactor', description: 'Move storage behind an interface', projectDir: 'D:\\Shop\\api', projectName: 'api' });
  const archived = task({ title: 'Old login work', description: 'login', archived: true });

  it('is off for an empty query', () => {
    expect(searchTasks([named, other], '   ')).toBeNull();
  });

  it('matches the name, the description and the project folder, ignoring case', () => {
    expect(searchTasks([named, other], 'LOGIN')?.map((t) => t.id)).toEqual([named.id]);
    expect(searchTasks([named, other], 'the css')?.map((t) => t.id)).toEqual([named.id]);
    expect(searchTasks([named, other], 'shop\\API')?.map((t) => t.id)).toEqual([other.id]);
    expect(searchTasks([named, other], 'nothing like this')).toEqual([]);
  });

  it('includes archived tasks, after the others', () => {
    expect(searchTasks([archived, named, other], 'login')?.map((t) => t.id)).toEqual([named.id, archived.id]);
  });
});

describe('atRest', () => {
  it('allows draft, done, failed, stopped and error with nothing running', () => {
    for (const status of ['draft', 'done', 'failed', 'stopped', 'error'] as const) {
      expect(atRest(task({ status })), status).toBe(true);
    }
    expect(notAtRestReason(task({ status: 'done' }))).toBeNull();
  });

  it('refuses running, waiting, rate-limited, account mismatch, and any busy task, saying why', () => {
    for (const status of ['running', 'waiting_user', 'rate_limited', 'account_mismatch'] as const) {
      expect(atRest(task({ status })), status).toBe(false);
    }
    expect(notAtRestReason(task({ status: 'rate_limited' }))).toBe(
      'This task is waiting for the usage limit to reset, so it cannot be archived or deleted. Stop it first.',
    );
    expect(notAtRestReason(task({ status: 'waiting_user' }))).toBe('This task is waiting for you, so it cannot be archived or deleted. Stop it first.');
    expect(notAtRestReason(task({ status: 'stopped', busy: true }))).toBe('This task has a turn running, so it cannot be archived or deleted. Stop it first.');
  });

  it('an unreadable task can always be deleted', () => {
    expect(atRest(task({ status: 'error', unreadable: 'bad json', busy: false }))).toBe(true);
  });
});

describe('groupByProject: unreadable tasks', () => {
  it('puts tasks that cannot be read in one group of their own', () => {
    const ok = task();
    const bad1 = task({ unreadable: 'bad json', projectKey: 'c:\data\tasks\a', projectName: 'a' });
    const bad2 = task({ unreadable: 'bad json', projectKey: 'c:\data\tasks\b', projectName: 'b' });
    expect(groupByProject([ok, bad1, bad2]).map((g) => [g.name, g.tasks.length])).toEqual([
      ['App', 1],
      ['Cannot be read', 2],
    ]);
  });
});
