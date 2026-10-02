/**
 * Storage (SPEC.md §9), the usage ledger (§17) and git operations (§18) against the real filesystem
 * and the real `git`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { createGitOps } from './git';
import { TaskStore } from './task-store';
import type { TaskEvent, TaskRecord } from './types';
import { UsageLedger, totalTokens } from './usage-ledger';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-storage-`));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('creates the §9 layout and refuses to reuse a task folder', () => {
    const store = new TaskStore(path.join(dir, 'tasks'));
    store.createFolders('t1');
    expect(fs.statSync(store.plannerCwd('t1')).isDirectory()).toBe(true);
    expect(fs.statSync(store.rawDir('t1')).isDirectory()).toBe(true);
    expect(() => store.createFolders('t1')).toThrow();
  });

  it('writes task.json atomically (no temp files left) and lists tasks', () => {
    const store = new TaskStore(path.join(dir, 'tasks'));
    store.createFolders('t1');
    store.createFolders('t0');
    store.writeTask({ id: 't1', status: 'draft' } as TaskRecord);
    store.writeTask({ id: 't1', status: 'running' } as TaskRecord);
    expect(store.readTask('t1').status).toBe('running');
    expect(fs.readdirSync(store.taskDir('t1')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // t0 has no task.json yet.
    expect(store.listTaskIds()).toEqual(['t1']);
  });

  it('appends events and skips a torn last line', () => {
    const store = new TaskStore(path.join(dir, 'tasks'));
    store.createFolders('t1');
    expect(store.readEvents('t1')).toEqual([]);
    const e = (seq: number) => ({ type: 'recovered', detail: 'x', seq, ts: 'now' }) as TaskEvent;
    store.appendEvent('t1', e(1));
    store.appendEvent('t1', e(2));
    fs.appendFileSync(store.eventsFile('t1'), '{"type":"sta');
    expect(store.readEvents('t1').map((x) => x.seq)).toEqual([1, 2]);
    expect(store.lastEventSeq('t1')).toBe(2);
  });

  it('finds the init line in a raw file', () => {
    const store = new TaskStore(dir);
    const raw = path.join(dir, 'a.ndjson');
    expect(store.rawHasInit(raw)).toBe(false);
    fs.writeFileSync(raw, '{"type":"rate_limit_event"}\n{"type":"system","subtype":"init","x":1}\n{"type":"res');
    expect(store.rawHasInit(raw)).toBe(true);
    fs.writeFileSync(raw, '{"type":"system","subtype":"api_retry","note":"init"}\n');
    expect(store.rawHasInit(raw)).toBe(false);
  });
});

describe('UsageLedger (§17)', () => {
  it('sums modelUsage per local day and model, and keeps the latest windows', () => {
    const ledger = new UsageLedger(path.join(dir, 'usage.json'));
    const at = new Date(2026, 8, 16, 12);
    const mu = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 300, costUSD: 0.5 };
    ledger.record(at, { 'claude-opus-5[1m]': mu, 'claude-haiku-4-5': { inputTokens: 5 } });
    ledger.record(at, { 'claude-opus-5[1m]': mu });
    ledger.record(at, {});
    const data = ledger.read();
    expect(data.days['2026-09-16']?.['claude-opus-5[1m]']).toEqual({
      inputTokens: 20,
      outputTokens: 40,
      cacheReadTokens: 2000,
      cacheCreationTokens: 600,
      costUsd: 1,
    });
    expect(ledger.tokensOn('2026-09-16')).toBe(2660 + 5);
    expect(ledger.tokensOn('2026-09-15')).toBe(0);
    expect(totalTokens(data.days['2026-09-16']!['claude-haiku-4-5']!)).toBe(5);

    ledger.record(new Date(2026, 8, 14, 12), { m: { inputTokens: 1 } });
    expect(ledger.tokensLast7Days(at)).toBe(2666);

    ledger.recordWindows(at, { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour', overageStatus: null, overageDisabledReason: null, windows: {} });
    expect(ledger.read().latest).toBeNull();
    const windows = { five_hour: { utilization: 0.2, resetsAt: 5 } };
    ledger.recordWindows(at, { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour', overageStatus: null, overageDisabledReason: null, windows });
    expect(ledger.read().latest).toMatchObject({ status: 'allowed', windows });
  });

  it('keeps each window’s own reading: a turn does not wipe what /usage reported (SPEC.md §17)', () => {
    const ledger = new UsageLedger(path.join(dir, 'usage.json'));
    const t1 = new Date('2026-09-26T06:00:00.000Z');
    const t2 = new Date('2026-09-26T06:05:00.000Z');
    ledger.recordUsageReport(t1, {
      five_hour: { utilization: 0.2, resetsAt: 100 },
      seven_day: { utilization: 0.05, resetsAt: 200 },
      seven_day_fable: { utilization: 0, resetsAt: 200 },
    });
    expect(ledger.read().latest).toMatchObject({ at: t1.toISOString(), status: null });

    // A turn reports two windows: they are replaced, the Fable week stays with its own time.
    ledger.recordWindows(t2, {
      status: 'allowed',
      resetsAt: 100,
      rateLimitType: 'five_hour',
      overageStatus: null,
      overageDisabledReason: null,
      windows: { five_hour: { utilization: 0.25, resetsAt: 100 }, seven_day: { utilization: 0.06, resetsAt: 200 } },
    });
    expect(ledger.read().latest).toEqual({
      at: t2.toISOString(),
      status: 'allowed',
      rateLimitType: 'five_hour',
      windows: {
        five_hour: { utilization: 0.25, resetsAt: 100, at: t2.toISOString() },
        seven_day: { utilization: 0.06, resetsAt: 200, at: t2.toISOString() },
        seven_day_fable: { utilization: 0, resetsAt: 200, at: t1.toISOString() },
      },
    });

    // /usage keeps the last turn's status.
    ledger.recordUsageReport(new Date('2026-09-26T06:10:00.000Z'), { five_hour: { utilization: 0.3, resetsAt: 100 } });
    expect(ledger.read().latest).toMatchObject({ status: 'allowed', rateLimitType: 'five_hour' });
  });

  it('gives windows from an older file the time of the reading they came with', () => {
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, days: {}, latest: { at: '2026-09-17T07:56:00.000Z', status: 'allowed', rateLimitType: 'five_hour', windows: { five_hour: { utilization: 0.08, resetsAt: 1 } } } }));
    const ledger = new UsageLedger(file);
    ledger.recordUsageReport(new Date('2026-09-26T06:00:00.000Z'), { seven_day_fable: { utilization: 0, resetsAt: 2 } });
    expect(ledger.read().latest?.windows['five_hour']).toEqual({ utilization: 0.08, resetsAt: 1, at: '2026-09-17T07:56:00.000Z' });
  });

  it('drops days older than five weeks', () => {
    const file = path.join(dir, 'usage.json');
    const ledger = new UsageLedger(file);
    ledger.record(new Date(2026, 6, 1), { m: { inputTokens: 1 } });
    ledger.record(new Date(2026, 8, 16), { m: { inputTokens: 1 } });
    expect(Object.keys(ledger.read().days)).toEqual(['2026-09-16']);
    expect(ledger.problem).toBeNull();
  });

  it('never overwrites a corrupt file: it is kept aside and reported (SPEC.md §9)', () => {
    const file = path.join(dir, 'usage.json');
    const ledger = new UsageLedger(file, () => new Date('2026-09-17T08:09:10.123Z'));
    fs.writeFileSync(file, '{not json');
    expect(ledger.read()).toEqual({ version: 1, days: {}, latest: null });
    const backup = `${file}.corrupt-2026-09-17T08-09-10-123Z`;
    expect(fs.readFileSync(backup, 'utf8')).toBe('{not json');
    expect(fs.existsSync(file)).toBe(false);
    expect(ledger.problem).toContain(`It was kept as ${backup}`);
    // The estimate starts again, and the note stays for the session.
    ledger.record(new Date(2026, 8, 17), { m: { inputTokens: 3 } });
    expect(ledger.tokensOn('2026-09-17')).toBe(3);
    expect(ledger.problem).toContain('was unreadable');

    // Valid JSON that is not a ledger counts as corrupt too.
    const other = new UsageLedger(path.join(dir, 'other.json'));
    fs.writeFileSync(other.file, '[1, 2]');
    expect(other.read().days).toEqual({});
    expect(fs.existsSync(other.file)).toBe(false);
  });

  it('writes nothing while the file cannot be read', () => {
    // A folder where the file should be: reading fails, and nothing may be written over it.
    const file = path.join(dir, 'usage.json');
    fs.mkdirSync(file);
    const ledger = new UsageLedger(file);
    ledger.record(new Date(2026, 8, 17), { m: { inputTokens: 3 } });
    ledger.recordWindows(new Date(2026, 8, 17), { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour', overageStatus: null, overageDisabledReason: null, windows: { five_hour: { utilization: 0.1, resetsAt: 5 } } });
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(ledger.problem).toContain('could not be read');
    expect(ledger.read()).toEqual({ version: 1, days: {}, latest: null });
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(gitAvailable())('git operations (§18, real git)', { timeout: 60_000 }, () => {
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const init = (repo: string) => {
    fs.mkdirSync(repo, { recursive: true });
    run(repo, 'init', '-q', '-b', 'main');
    run(repo, 'config', 'user.name', 'Test');
    run(repo, 'config', 'user.email', 'test@example.com');
    run(repo, 'config', 'commit.gpgsign', 'false');
  };

  it('reports a folder that is not a repository', async () => {
    const git = createGitOps();
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    // The temp folder must not itself sit inside a repository for this check.
    const outer = await git.inspect(plain);
    if (outer.isRepo) return;
    expect(outer).toEqual({ isRepo: false, branch: null, head: null, hasRemote: false, dirty: [] });
  });

  it('inspects, branches, commits, and reports nothing to commit', async () => {
    const git = createGitOps();
    const repo = path.join(dir, 'repo');
    init(repo);

    // An unborn branch: no HEAD commit yet.
    let info = await git.inspect(repo);
    expect(info).toMatchObject({ isRepo: true, branch: 'main', head: null, hasRemote: false });

    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'n');
    info = await git.inspect(repo);
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info.dirty.sort()).toEqual(['a.txt', 'new file.txt']);

    await git.switchToBranch(repo, `${APP_SLUG}/20260916-000000-abcdef`);
    expect(await git.currentBranch(repo)).toBe(`${APP_SLUG}/20260916-000000-abcdef`);
    // Switching to an existing branch works too.
    await git.switchToBranch(repo, 'main');
    await git.switchToBranch(repo, `${APP_SLUG}/20260916-000000-abcdef`);

    const commit = await git.commitAll(repo, `[${APP_SLUG}] cycle 1: change a`);
    expect(commit.committed).toBe(true);
    expect(commit.hash).toBe(run(repo, 'rev-parse', 'HEAD'));
    expect(commit.files.sort()).toEqual(['a.txt', 'new file.txt']);
    expect(run(repo, 'log', '-1', '--format=%s')).toBe(`[${APP_SLUG}] cycle 1: change a`);
    // The original branch is untouched.
    expect(run(repo, 'log', 'main', '-1', '--format=%s')).toBe('init');

    expect(await git.commitAll(repo, 'nothing')).toEqual({ committed: false, hash: null, files: [] });

    run(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
    expect(await git.hasRemote(repo)).toBe(true);
  });

  it('a detached HEAD has no current branch, and a failing commit throws with git’s message', async () => {
    const git = createGitOps();
    const repo = path.join(dir, 'repo2');
    init(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    run(repo, 'add', '.');
    run(repo, 'commit', '-q', '-m', 'init');
    run(repo, 'checkout', '-q', '--detach');
    expect(await git.currentBranch(repo)).toBeNull();

    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    await expect(git.commitAll(repo, 'x')).rejects.toThrow(/hook says no/);
  });
});
