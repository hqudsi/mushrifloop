/**
 * The right panel's changed-file list (SPEC.md §10) against a real git repository.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { EXECUTOR_SCRATCH_DIR, GitError, GitUnavailableError, changesSince, createGitOps, isExecutorScratch, isWorkTree, parseNameStatus, parseNumstat, refExists } from './git';

describe('git output parsing', () => {
  it('reads -z name-status and numstat, renames under the new path', () => {
    const names = parseNameStatus('M\0src/a.ts\0A\0b.txt\0D\0old.md\0R087\0x/from.ts\0x/to.ts\0');
    expect([...names.entries()]).toEqual([
      ['src/a.ts', 'M'],
      ['b.txt', 'A'],
      ['old.md', 'D'],
      ['x/to.ts', 'R'],
    ]);
    const counts = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '2\t0\t\0x/from.ts\0x/to.ts\0');
    expect(counts.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(counts.get('img.png')).toEqual({ additions: null, deletions: null });
    expect(counts.get('x/to.ts')).toEqual({ additions: 2, deletions: 0 });
  });
});

describe('changesSince (real git)', { timeout: 60_000 }, () => {
  let dir: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-git-`));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'T');
    run('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'start');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists committed and uncommitted changes since the base, with line counts, and untracked files', async () => {
    const base = run('rev-parse', 'HEAD').trim();
    run('switch', '-q', '-c', `${APP_SLUG}/t1`);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'one\ntwo\nthree\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const a = 1;\n');
    run('add', '-A');
    run('commit', '-q', '-m', `[${APP_SLUG}] cycle 1`);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'one\n2\nthree\n');
    fs.writeFileSync(path.join(dir, 'untracked.md'), '# hi\n');

    const worktree = await changesSince(dir, base, null);
    expect(worktree.changes).toEqual(
      expect.arrayContaining([
        { path: 'keep.txt', status: 'M', additions: 2, deletions: 1 },
        { path: 'gone.txt', status: 'D', additions: 0, deletions: 1 },
        { path: 'src/new.ts', status: 'A', additions: 1, deletions: 0 },
      ]),
    );
    expect(worktree.changes).toHaveLength(3);
    expect(worktree.untracked).toEqual(['untracked.md']);

    // The branch without the working tree: only what was committed.
    run('stash', '-q', '--include-untracked');
    run('switch', '-q', 'main');
    const branch = await changesSince(dir, base, `${APP_SLUG}/t1`);
    expect(branch.changes.find((c) => c.path === 'keep.txt')).toEqual({ path: 'keep.txt', status: 'M', additions: 1, deletions: 0 });
    expect(branch.untracked).toEqual([]);
    expect(await refExists(dir, `${APP_SLUG}/t1`)).toBe(true);
    expect(await refExists(dir, `${APP_SLUG}/nope`)).toBe(false);
    expect(await createGitOps().currentBranch(dir)).toBe('main');
  });

  it('treats a null base as the empty tree', async () => {
    const all = await changesSince(dir, null, null);
    expect(all.changes.map((c) => [c.path, c.status])).toEqual([
      ['gone.txt', 'A'],
      ['keep.txt', 'A'],
    ]);
  });
});

/** SPEC.md §18 (decided 2026-09-17): only git itself saying so means "not a repository". */
describe('git failures are not "not a repository" (real git)', { timeout: 60_000 }, () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-gitfail-`));
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a plain folder is not a repository', async () => {
    expect(await isWorkTree(dir)).toBe(false);
    expect(await createGitOps().inspect(dir)).toEqual({ isRepo: false, branch: null, head: null, hasRemote: false, dirty: [] });
  });

  it('git that cannot be started throws GitUnavailableError, naming the command', async () => {
    setEnv('PATH', path.join(dir, 'no-git-here'));
    const err = await createGitOps().inspect(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitUnavailableError);
    expect((err as Error).message).toMatch(/^Git could not be run \(git rev-parse --is-inside-work-tree\): .+\. Is git installed and on PATH\?$/);
    await expect(refExists(dir, 'HEAD')).rejects.toBeInstanceOf(GitUnavailableError);
    await expect(changesSince(dir, null, null)).rejects.toBeInstanceOf(GitUnavailableError);
  });

  it('git that runs but fails (a broken config) throws GitError with git\'s message', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const config = path.join(dir, 'broken.gitconfig');
    fs.writeFileSync(config, '[core\n\tthis is not a config\n');
    setEnv('GIT_CONFIG_GLOBAL', config);
    const err = await createGitOps().inspect(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toMatch(/^git rev-parse --is-inside-work-tree failed \(exit \d+\): .*config/);
  });
});

describe('the executor scratch folder never reaches the user\'s history (real git)', { timeout: 60_000 }, () => {
  let dir: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-scratch-`));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'T');
    run('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'start');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Evidence too long for an answer goes to `.mushrifloop/evidence/<n>.md` (SPEC.md §4). */
  const writeEvidence = () => {
    fs.mkdirSync(path.join(dir, EXECUTOR_SCRATCH_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, EXECUTOR_SCRATCH_DIR, 'evidence', '1.md'), 'forty lines of orders.ts\n');
  };

  it('commits the real work and leaves the scratch folder untracked', async () => {
    writeEvidence();
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 2;\n');
    const result = await createGitOps().commitAll(dir, 'cycle 1');
    expect(result.committed).toBe(true);
    expect(result.files).toEqual(['app.ts']);
    expect(run('ls-files').split('\n').filter(Boolean)).toEqual(['app.ts']);
    expect(run('status', '--porcelain')).toContain(`?? ${EXECUTOR_SCRATCH_DIR}/`);
  });

  it('reports nothing to commit when only evidence was written', async () => {
    writeEvidence();
    const before = run('rev-parse', 'HEAD').trim();
    expect(await createGitOps().commitAll(dir, 'cycle 1')).toEqual({ committed: false, hash: null, files: [] });
    expect(run('rev-parse', 'HEAD').trim()).toBe(before);
  });
});

describe('the scratch folder is not the user\'s work', () => {
  it('recognises it under either separator, and nothing else', () => {
    for (const p of ['.mushrifloop', '.mushrifloop/evidence/1.md', '.mushrifloop\\evidence\\1.md', './.mushrifloop/evidence/timeline-trace.md']) {
      expect(isExecutorScratch(p), p).toBe(true);
    }
    for (const p of ['src/app.ts', 'mushrifloop/app.ts', '.mushriflooprc', 'docs/.mushrifloop-notes.md']) {
      expect(isExecutorScratch(p), p).toBe(false);
    }
  });
});

describe('the scratch folder is invisible to change reporting (real git)', { timeout: 60_000 }, () => {
  let dir: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-scratchvis-`));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 'T');
    run('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'start');
    fs.mkdirSync(path.join(dir, EXECUTOR_SCRATCH_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, EXECUTOR_SCRATCH_DIR, 'evidence', 'timeline-trace.md'), 'forty lines\n');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A read-only task wrote evidence and the harness called it a changed file (NOTES.md §29). */
  it('is left out of the untracked list', async () => {
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const b = 2;\n');
    const { changes, untracked } = await changesSince(dir, run('rev-parse', 'HEAD').trim(), null);
    expect(untracked).toEqual(['new.ts']);
    expect(changes).toEqual([]);
  });

  it('is left out of the dirty list, so it is never snapshotted as the user\'s work', async () => {
    const inspection = await createGitOps().inspect(dir);
    expect(inspection.dirty).toEqual([]);
  });

  it('leaves a read-only turn looking read-only', async () => {
    const { changes, untracked } = await changesSince(dir, run('rev-parse', 'HEAD').trim(), null);
    expect([...changes.map((c) => c.path), ...untracked]).toEqual([]);
  });
});
