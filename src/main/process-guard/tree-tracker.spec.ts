import { describe, expect, it } from 'vitest';

import { createdMs, extendTracked, liveSurvivors, type ProcRow } from './tree-tracker';

const row = (pid: number, ppid: number, created: string, name = `p${pid}`): ProcRow => ({
  pid,
  ppid,
  created,
  name,
  commandLine: null,
});

describe('createdMs', () => {
  it('compares PowerShell 7-digit and JavaScript 3-digit timestamps correctly', () => {
    // As text, "…00.408Z" sorts after "…00.4081234Z"; as time they are the same millisecond.
    expect(createdMs('2026-09-16T14:30:00.4081234Z')).toBe(createdMs('2026-09-16T14:30:00.408Z'));
    expect(createdMs('2026-09-16T14:30:01.0000000Z')).toBeGreaterThan(createdMs('2026-09-16T14:30:00.999Z'));
  });

  it('sorts unparseable values first', () => {
    expect(createdMs('')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('extendTracked', () => {
  const root = row(100, 1, '2026-09-16T10:00:00.0000000Z', 'claude.exe');

  it('adds children and grandchildren, even when they arrive in the same snapshot', () => {
    const tracked = new Map([[100, root]]);
    extendTracked(tracked, [
      row(300, 200, '2026-09-16T10:00:03.0000000Z', 'grep.exe'), // listed before its parent
      row(200, 100, '2026-09-16T10:00:02.0000000Z', 'bash.exe'),
      row(999, 1, '2026-09-16T10:00:02.0000000Z', 'unrelated.exe'),
    ]);
    expect([...tracked.keys()].sort()).toEqual([100, 200, 300]);
  });

  it('keeps a descendant tracked after its parent has exited', () => {
    const tracked = new Map([[100, root]]);
    extendTracked(tracked, [
      row(200, 100, '2026-09-16T10:00:02.0000000Z', 'bash.exe'),
      row(300, 200, '2026-09-16T10:00:03.0000000Z', 'grep.exe'),
    ]);
    // Next snapshot: bash is gone, grep is an orphan whose parent pid no longer exists.
    extendTracked(tracked, [row(300, 200, '2026-09-16T10:00:03.0000000Z', 'grep.exe')]);
    expect(tracked.has(300)).toBe(true);
  });

  it('ignores a process that only looks like a child because of pid reuse', () => {
    const tracked = new Map([[100, root]]);
    // Created before the root: its parent was an earlier process that had pid 100.
    extendTracked(tracked, [row(400, 100, '2026-09-16T09:59:00.0000000Z')]);
    expect(tracked.has(400)).toBe(false);
  });
});

describe('liveSurvivors', () => {
  const tracked = new Map<number, ProcRow>([
    [100, row(100, 1, '2026-09-16T10:00:00.0000000Z', 'claude.exe')],
    [200, row(200, 100, '2026-09-16T10:00:02.0000000Z', 'bash.exe')],
    [300, row(300, 200, '2026-09-16T10:00:03.0000000Z', 'grep.exe')],
  ]);

  it('returns tracked processes that are still running, never the root', () => {
    const now = [
      row(100, 1, '2026-09-16T10:00:00.0000000Z', 'claude.exe'),
      row(300, 200, '2026-09-16T10:00:03.0000000Z', 'grep.exe'),
    ];
    expect(liveSurvivors(tracked, now, 100).map((r) => r.pid)).toEqual([300]);
  });

  it('does not treat a new process that reused a tracked pid as a survivor', () => {
    const now = [row(300, 5, '2026-09-16T11:00:00.0000000Z', 'notepad.exe')];
    expect(liveSurvivors(tracked, now, 100)).toEqual([]);
  });
});
