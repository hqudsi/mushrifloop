import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { JobHelper, TreeTurnGuard, WindowsProcessGuardFactory, unguarded, type ProcRow } from './index';

const isWindows = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitDead(pid: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(150);
  }
  return !alive(pid);
}
async function waitForPidFile(file: string, why: () => string = () => ''): Promise<number> {
  const end = Date.now() + 15_000;
  while (!fs.existsSync(file) && Date.now() < end) await sleep(50);
  if (!fs.existsSync(file)) throw new Error(`The test process never wrote ${file}. ${why()}`.trim());
  return Number(fs.readFileSync(file, 'utf8'));
}

describe('unguarded', () => {
  it('reports method none with the reason', async () => {
    const guard = unguarded('not on Windows');
    await guard.killAll();
    expect(await guard.finish()).toEqual({ method: 'none', survivors: [], errors: ['not on Windows'] });
  });
});

describe('TreeTurnGuard (fallback) with injected snapshots', () => {
  const t = (s: number) => new Date(Date.now() + s * 1000).toISOString();

  it('kills a grandchild that was orphaned between snapshots', async () => {
    const rootPid = 100;
    const bash = { pid: 200, ppid: rootPid, created: t(1), name: 'bash.exe', commandLine: 'bash -c grep' };
    const grep = { pid: 300, ppid: 200, created: t(2), name: 'grep.exe', commandLine: 'grep -rl x /' };
    const snapshots: ProcRow[][] = [
      [{ pid: rootPid, ppid: 1, created: t(0), name: 'claude.exe', commandLine: null }, bash, grep],
      [grep], // root and bash exited; grep keeps running
    ];
    const killed: number[] = [];
    let call = 0;
    const guard = new TreeTurnGuard(rootPid, 'job unavailable (test)', {
      pollMs: 60_000,
      io: {
        snapshot: async () => snapshots[Math.min(call++, snapshots.length - 1)] as ProcRow[],
        kill: async (pid) => {
          killed.push(pid);
        },
      },
    });
    guard.start();
    const report = await guard.finish();
    expect(report.method).toBe('tree');
    expect(report.survivors.map((s) => s.pid)).toEqual([300]);
    expect(report.survivors[0]?.commandLine).toBe('grep -rl x /');
    expect(killed).toEqual([300]);
    expect(report.errors[0]).toContain('job unavailable');
  });

  it('reports snapshot failures instead of throwing', async () => {
    const guard = new TreeTurnGuard(100, 'reason', {
      pollMs: 60_000,
      io: {
        snapshot: async () => {
          throw new Error('access denied');
        },
        kill: async () => {},
      },
    });
    guard.start();
    const report = await guard.finish();
    expect(report.survivors).toEqual([]);
    expect(report.errors.join(' ')).toContain('access denied');
  });

  it('finishes only once', async () => {
    let kills = 0;
    // One fixed row: a process's creation time must not change between snapshots.
    const child: ProcRow = { pid: 200, ppid: 100, created: t(1), name: 'x', commandLine: null };
    const guard = new TreeTurnGuard(100, 'r', {
      pollMs: 60_000,
      io: {
        snapshot: async () => [child],
        kill: async () => {
          kills++;
        },
      },
    });
    guard.start();
    expect((await guard.finish()).survivors).toHaveLength(1);
    expect((await guard.finish()).survivors).toHaveLength(0);
    expect(kills).toBe(1);
  });
});

/**
 * The real thing, on Windows. MSYS bash (Git's usr\bin\bash.exe, which the Bash tool runs) starts a
 * long-running child in the background and exits — the shape of the orphaned grep (NOTES.md §14.5).
 * Git's bin\bash.exe launcher is avoided on purpose: it starts the real bash within milliseconds,
 * before any assignment could arrive (NOTES.md §15.1).
 */
describe.skipIf(!isWindows)('Job Object guard (Windows)', () => {
  const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
  const hasBash = isWindows && fs.existsSync(bash);
  // The script names every program by absolute path, so it does not depend on the PATH the tests were
  // started with: bash maps /usr/bin to Git's own usr\bin, and node is this process's executable.
  const sleepExe = path.join(path.dirname(bash), 'sleep.exe');
  let helper: JobHelper;
  let dir: string;

  beforeAll(async () => {
    helper = new JobHelper();
    await helper.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-guard-`));
  }, 60_000);

  afterAll(() => {
    helper?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function orphaningBash(pidFile: string) {
    // Fail fast, naming the missing program, rather than run a script that exits at once.
    if (!fs.existsSync(sleepExe)) throw new Error(`${sleepExe} is missing; this test needs Git for Windows' usr\\bin tools.`);
    const node = process.execPath.replace(/\\/g, '/');
    const script =
      `/usr/bin/sleep 1; '${node}' -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(()=>{}, 120000)" ` +
      `'${pidFile.replace(/\\/g, '/')}' </dev/null >/dev/null 2>&1 & /usr/bin/sleep 1; exit 0`;
    // bash's stderr is kept for the failure message; the background child must not hold that pipe open.
    const child = spawn(bash, ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    // Listen before anything is awaited, so an early exit is never missed.
    const closed = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return { child, closed, why: () => (stderr.trim() ? `bash said: ${stderr.trim()}` : '') };
  }

  it.skipIf(!hasBash)('reports and kills a grandchild orphaned after its parent exited', async () => {
    const factory = new WindowsProcessGuardFactory({ helper });
    const pidFile = path.join(dir, 'orphan.pid');
    const prepared = await factory.prepare('orphan-test');
    const parent = orphaningBash(pidFile);
    const guard = await prepared.attach(parent.child.pid as number);
    await parent.closed;
    const orphan = await waitForPidFile(pidFile, parent.why);
    await sleep(300);
    expect(alive(orphan)).toBe(true); // the dangerous state

    const report = await guard.finish();
    // Failed once in ~11 full-suite runs (NOTES.md §16.8): keep the whole report in the message.
    const why = JSON.stringify(report);
    expect(report.method, why).toBe('job');
    expect(report.errors, why).toEqual([]);
    const survivor = report.survivors.find((s) => s.pid === orphan);
    expect(survivor?.name, why).toBe('node.exe');
    expect(survivor?.commandLine, why).toContain('setTimeout');
    expect(survivor?.outsideJob, why).toBeUndefined(); // caught by the job itself
    expect(await waitDead(orphan)).toBe(true);
  }, 60_000);

  it.skipIf(!hasBash)('killAll stops everything at once', async () => {
    const factory = new WindowsProcessGuardFactory({ helper });
    const pidFile = path.join(dir, 'killall.pid');
    const prepared = await factory.prepare('killall-test');
    const parent = orphaningBash(pidFile);
    const guard = await prepared.attach(parent.child.pid as number);
    const child = await waitForPidFile(pidFile, parent.why);
    await guard.killAll();
    expect(await waitDead(child)).toBe(true);
    expect(await waitDead(parent.child.pid as number)).toBe(true);
    await guard.finish();
  }, 60_000);

  it('still finds and kills a child that started before the assignment, and flags the leak', async () => {
    const factory = new WindowsProcessGuardFactory({ helper });
    const pidFile = path.join(dir, 'early.pid');
    // The parent starts its child immediately, then lives on for a while.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { detached: true, stdio: 'ignore' });
         c.unref(); require('fs').writeFileSync(process.argv[1], String(c.pid)); setTimeout(() => {}, 2500);`,
        pidFile,
      ],
      { stdio: 'ignore' },
    );
    const early = await waitForPidFile(pidFile); // started before the job existed
    const prepared = await factory.prepare('early-test');
    const guard = await prepared.attach(parent.pid as number);
    await new Promise((r) => parent.on('close', r));

    const report = await guard.finish();
    const leaked = report.survivors.find((s) => s.pid === early);
    expect(leaked?.outsideJob).toBe(true);
    expect(await waitDead(early)).toBe(true);
  }, 60_000);

  it('falls back to tree tracking when the job helper cannot run', async () => {
    const broken = new WindowsProcessGuardFactory({
      helper: new JobHelper({ powershell: path.join(dir, 'no-such-powershell.exe'), startTimeoutMs: 5000 }),
      pollMs: 500,
    });
    const prepared = await broken.prepare('fallback-test');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const guard = await prepared.attach(child.pid as number);
    const report = await guard.finish();
    expect(report.method).toBe('tree');
    expect(report.errors[0]).toContain('Job object unavailable');
    child.kill();
  }, 60_000);

  it('falls back when the process to assign no longer exists', async () => {
    const factory = new WindowsProcessGuardFactory({ helper, pollMs: 60_000 });
    const prepared = await factory.prepare('gone-test');
    const guard = await prepared.attach(999_999);
    expect((await guard.finish()).method).toBe('tree');
  }, 60_000);

  it('releases a prepared job when nothing was spawned', async () => {
    const factory = new WindowsProcessGuardFactory({ helper });
    const prepared = await factory.prepare('discard-test');
    await prepared.discard();
    await expect(helper.request('pids', { job: 'turn-discard-test' })).rejects.toThrow(/no job/);
  });

  it('reports a clear error for an unknown job', async () => {
    await expect(helper.request('pids', { job: 'does-not-exist' })).rejects.toThrow(/no job/);
  });
});
