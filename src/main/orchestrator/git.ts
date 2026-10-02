/**
 * Git operations for the orchestrator's branch-and-commit policy (SPEC.md §18), via the `git` CLI.
 *
 * All git work belongs to the orchestrator; the Executor never runs git unless told to.
 */

import { spawn } from 'node:child_process';

import { APP_SLUG } from '../../shared/app-config';
import type { GitInspection, GitOps } from './types';

/**
 * The Executor's scratch folder inside the project: evidence too long for an answer goes here
 * (SPEC.md §4). Never committed, never counted as a change to the user's work.
 */
export const EXECUTOR_SCRATCH_DIR = `.${APP_SLUG}`;

/**
 * Is this path the Executor's scratch space rather than the user's work? It is never committed, never
 * shown as a change, and never picked up as "the project already had uncommitted changes" (SPEC.md §4).
 * Found by the live rollover check on 2026-09-18: a read-only task reported its evidence file there as a
 * changed file (NOTES.md §29).
 */
export function isExecutorScratch(file: string): boolean {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return p === EXECUTOR_SCRATCH_DIR || p.startsWith(`${EXECUTOR_SCRATCH_DIR}/`);
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Git itself could not run: not installed, not startable, or killed at the timeout. Never to be read as
 * "not a repository" (SPEC.md §18, decided 2026-09-17).
 */
export class GitUnavailableError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 60_000;

function runGit(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  const unavailable = (detail: string) =>
    new GitUnavailableError(`Git could not be run (git ${args.join(' ')}): ${detail}. Is git installed and on PATH?`, args);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        // Never wait on a credential or editor prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
      });
    } catch (err) {
      reject(unavailable(err instanceof Error ? err.message : String(err)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(unavailable(err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GitUnavailableError(`Git did not finish (git ${args.join(' ')}) within ${timeoutMs / 1000} s and was stopped.`, args));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function failure(args: readonly string[], run: GitRun): GitError {
  return new GitError(`git ${args.join(' ')} failed (exit ${run.code ?? 'none'}): ${run.stderr.trim() || run.stdout.trim()}`, args, run.stderr);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const run = await runGit(cwd, args);
  if (run.code !== 0) throw failure(args, run);
  return run.stdout;
}

/**
 * Run a git command whose exit code 1 is an answer ("no", "not found") rather than a failure — the
 * `--quiet` forms of `rev-parse --verify` and `symbolic-ref`. Anything above 1 is a failure.
 */
async function gitAnswer(cwd: string, args: readonly string[]): Promise<{ yes: boolean; stdout: string }> {
  const run = await runGit(cwd, args);
  if (run.code === 0) return { yes: true, stdout: run.stdout };
  if (run.code === 1) return { yes: false, stdout: '' };
  throw failure(args, run);
}

/** What git prints when a folder is not inside any repository. */
const NOT_A_REPO = /not a git repository/i;

/** `git status --porcelain=v1 -z` → paths. */
function porcelainPaths(out: string): string[] {
  const entries = out.split('\0').filter((e) => e.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename/copy is followed by its source path.
    if (status.includes('R') || status.includes('C')) i++;
  }
  return paths;
}

/** Git's well-known empty tree: the base for a repository whose history started with this task. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  /** null for binary files. */
  additions: number | null;
  deletions: number | null;
}

/** `git diff --name-status -z` → status per path (a rename is reported under its new path). */
export function parseNameStatus(out: string): Map<string, GitFileChange['status']> {
  const parts = out.split('\0');
  const map = new Map<string, GitFileChange['status']>();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? '';
    if (code === '') continue;
    const letter = code.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const to = parts[i + 2] ?? '';
      map.set(to, letter === 'R' ? 'R' : 'A');
      i += 2;
    } else {
      const file = parts[i + 1] ?? '';
      map.set(file, letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M');
      i += 1;
    }
  }
  return map;
}

/** `git diff --numstat -z` → line counts per path (renames under the new path; `-` = binary). */
export function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const parts = out.split('\0');
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  const count = (v: string | undefined) => (v === undefined || v === '-' ? null : Number.parseInt(v, 10));
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    if (entry === '') continue;
    const [adds, dels, file] = entry.split('\t');
    if (file === '' || file === undefined) {
      // Rename: "adds\tdels\t" then the old path, then the new path.
      map.set(parts[i + 2] ?? '', { additions: count(adds), deletions: count(dels) });
      i += 2;
    } else {
      map.set(file, { additions: count(adds), deletions: count(dels) });
    }
  }
  return map;
}

/**
 * Everything that differs between `base` (null = the empty tree) and `target` — a commit or branch, or
 * null for the working tree including untracked files. Untracked files get no line counts here.
 */
export async function changesSince(dir: string, base: string | null, target: string | null): Promise<{ changes: GitFileChange[]; untracked: string[] }> {
  const range = [base ?? EMPTY_TREE, ...(target ? [target] : [])];
  const [names, counts] = await Promise.all([
    git(dir, ['diff', '--name-status', '-z', '-M', ...range, '--']),
    git(dir, ['diff', '--numstat', '-z', '-M', ...range, '--']),
  ]);
  const status = parseNameStatus(names);
  const lines = parseNumstat(counts);
  const changes: GitFileChange[] = [...status.entries()]
    .filter(([file]) => !isExecutorScratch(file))
    .map(([file, s]) => ({
      path: file,
      status: s,
      additions: lines.get(file)?.additions ?? null,
      deletions: lines.get(file)?.deletions ?? null,
    }));
  let untracked: string[] = [];
  if (target === null) {
    untracked = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter((f) => f.length > 0 && !isExecutorScratch(f));
  }
  return { changes, untracked };
}

/** Does `ref` name a commit in this repository? Throws when git cannot answer. */
export async function refExists(dir: string, ref: string): Promise<boolean> {
  return (await gitAnswer(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).yes;
}

/**
 * Is `dir` inside a git work tree? False only when git ran and said so; every other failure (git missing,
 * a timeout, "dubious ownership", …) throws, so it is never mistaken for "not a repository".
 */
export async function isWorkTree(dir: string): Promise<boolean> {
  const args = ['rev-parse', '--is-inside-work-tree'];
  const run = await runGit(dir, args);
  if (run.code === 0) return run.stdout.trim() === 'true';
  if (NOT_A_REPO.test(run.stderr)) return false;
  throw failure(args, run);
}

export function createGitOps(): GitOps {
  return {
    async inspect(dir: string): Promise<GitInspection> {
      if (!(await isWorkTree(dir))) {
        return { isRepo: false, branch: null, head: null, hasRemote: false, dirty: [] };
      }
      const branch = await gitAnswer(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const head = await gitAnswer(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      const status = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      return {
        isRepo: true,
        branch: branch.yes ? branch.stdout.trim() : null,
        head: head.yes ? head.stdout.trim() : null,
        hasRemote: await this.hasRemote(dir),
        dirty: porcelainPaths(status).filter((f) => !isExecutorScratch(f)),
      };
    },

    async switchToBranch(dir: string, name: string): Promise<void> {
      const exists = await gitAnswer(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      if (exists.yes) await git(dir, ['switch', name]);
      else await git(dir, ['switch', '-c', name]);
    },

    async currentBranch(dir: string): Promise<string | null> {
      const run = await gitAnswer(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      return run.yes ? run.stdout.trim() : null;
    },

    async hasRemote(dir: string): Promise<boolean> {
      return (await git(dir, ['remote'])).trim().length > 0;
    },

    async commitAll(dir: string, message: string) {
      // That folder is the Executor's own scratch space for evidence too long to put in an answer
      // (SPEC.md §4). It is working state, not the deliverable, so it never enters the user's history.
      await git(dir, ['add', '--all', '--', '.', `:(exclude)${EXECUTOR_SCRATCH_DIR}`]);
      const staged = await git(dir, ['diff', '--cached', '--name-only', '-z']);
      const files = staged.split('\0').filter((f) => f.length > 0);
      if (files.length === 0) return { committed: false, hash: null, files: [] };
      await git(dir, ['commit', '--quiet', '-m', message]);
      const hash = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      return { committed: true, hash, files };
    },
  };
}
