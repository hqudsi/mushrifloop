/**
 * Process guard factory: a Job Object per turn, falling back to process-tree tracking.
 * See types.ts for the why, NOTES.md §15.1 for the evidence.
 */

import { JobHelper } from './job-helper';
import { extendTracked, liveSurvivors, takeSnapshot, taskkill, type ProcRow } from './tree-tracker';
import type {
  PreparedGuard,
  ProcessCleanupReport,
  ProcessGuardFactory,
  SurvivorInfo,
  TurnProcessGuard,
} from './types';

export type {
  PreparedGuard,
  ProcessCleanupReport,
  ProcessGuardFactory,
  SurvivorInfo,
  TurnProcessGuard,
} from './types';
export { JobHelper, JobHelperError, JOB_HELPER_SCRIPT } from './job-helper';
export { createdMs, extendTracked, liveSurvivors, type ProcRow } from './tree-tracker';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A guard that watches nothing, and says so. */
export function unguarded(reason: string): TurnProcessGuard {
  return {
    killAll: async () => {},
    finish: async () => ({ method: 'none', survivors: [], errors: [reason] }),
  };
}

/** Anchor for tree tracking when the root's real creation time is not known yet. */
function syntheticRoot(pid: number, startedAt: number): ProcRow {
  return { pid, ppid: -1, created: new Date(startedAt - 2000).toISOString(), name: null, commandLine: null };
}

export interface GuardIo {
  snapshot: () => Promise<ProcRow[]>;
  kill: (pid: number) => Promise<void>;
}

const realIo: GuardIo = { snapshot: () => takeSnapshot(), kill: taskkill };

class JobTurnGuard implements TurnProcessGuard {
  private finished = false;

  constructor(
    private readonly helper: JobHelper,
    private readonly job: string,
    private readonly root: ProcRow,
    private readonly io: GuardIo,
  ) {}

  async killAll(): Promise<void> {
    if (this.finished) return;
    await this.helper.request('kill', { job: this.job }).catch(() => {});
  }

  async finish(): Promise<ProcessCleanupReport> {
    const report: ProcessCleanupReport = { method: 'job', survivors: [], errors: [] };
    if (this.finished) return report;
    this.finished = true;
    const rootPid = this.root.pid;
    let inJob: number[] = [];
    try {
      inJob = ((await this.helper.request<number[] | null>('pids', { job: this.job })) ?? []).filter((p) => p !== rootPid);
      if (inJob.length > 0) {
        const described = await this.helper.request<SurvivorInfo[] | null>('describe', { pids: inJob }).catch((err: unknown) => {
          report.errors.push(`describe failed: ${message(err)}`);
          return null;
        });
        report.survivors = inJob.map((pid) => {
          const d = described?.find((x) => x.pid === pid);
          return { pid, name: d?.name ?? null, commandLine: d?.commandLine ?? null };
        });
      }
      // Always terminate: nothing the turn started may outlive it.
      await this.helper.request('kill', { job: this.job });
    } catch (err) {
      report.errors.push(message(err));
    } finally {
      await this.helper.request('close', { job: this.job }).catch(() => {});
    }

    // Leak check: anything descended from the CLI that is not in the job started before the CLI was
    // assigned. Kill it and report it as outsideJob, so a leaking job layer is visible.
    try {
      const rows = await this.io.snapshot();
      const tracked = new Map([[rootPid, this.root]]);
      extendTracked(tracked, rows);
      const escaped = liveSurvivors(tracked, rows, rootPid).filter((r) => !inJob.includes(r.pid));
      await Promise.all(escaped.map((r) => this.io.kill(r.pid)));
      for (const r of escaped) {
        report.survivors.push({ pid: r.pid, name: r.name, commandLine: r.commandLine, outsideJob: true });
      }
    } catch (err) {
      report.errors.push(`leak check failed: ${message(err)}`);
    }
    return report;
  }
}

export interface TreeGuardOptions {
  pollMs: number;
  io?: GuardIo;
  startedAt?: number;
}

/** Fallback: poll the process table and remember every descendant of the root. */
export class TreeTurnGuard implements TurnProcessGuard {
  private readonly tracked = new Map<number, ProcRow>();
  private readonly errors: string[];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private finished = false;
  private readonly io: GuardIo;

  constructor(
    private readonly rootPid: number,
    reason: string,
    private readonly options: TreeGuardOptions,
  ) {
    this.errors = [reason];
    this.io = options.io ?? realIo;
    // Until a snapshot shows the real root, anchor it at the turn's start: any child is newer.
    this.tracked.set(rootPid, syntheticRoot(rootPid, options.startedAt ?? Date.now()));
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.options.pollMs);
    this.timer.unref();
  }

  private poll(): void {
    this.inFlight = this.inFlight.then(async () => {
      try {
        const rows = await this.io.snapshot();
        // Replace the synthetic anchor with the real root row as soon as a snapshot shows it.
        const root = rows.find((r) => r.pid === this.rootPid);
        if (root && this.tracked.get(this.rootPid)?.ppid === -1) this.tracked.set(this.rootPid, root);
        extendTracked(this.tracked, rows);
      } catch (err) {
        const text = `snapshot failed: ${message(err)}`;
        if (!this.errors.includes(text)) this.errors.push(text);
      }
    });
  }

  private async sweep(): Promise<SurvivorInfo[]> {
    this.poll();
    await this.inFlight;
    let rows: ProcRow[] = [];
    try {
      rows = await this.io.snapshot();
    } catch (err) {
      this.errors.push(`final snapshot failed: ${message(err)}`);
      return [];
    }
    extendTracked(this.tracked, rows);
    const survivors = liveSurvivors(this.tracked, rows, this.rootPid);
    await Promise.all(survivors.map((s) => this.io.kill(s.pid)));
    return survivors.map((s) => ({ pid: s.pid, name: s.name, commandLine: s.commandLine }));
  }

  async killAll(): Promise<void> {
    if (this.finished) return;
    await this.sweep();
  }

  async finish(): Promise<ProcessCleanupReport> {
    if (this.finished) return { method: 'tree', survivors: [], errors: [...this.errors] };
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    const survivors = await this.sweep();
    return { method: 'tree', survivors, errors: [...this.errors] };
  }
}

export interface WindowsGuardOptions {
  helper?: JobHelper;
  pollMs?: number;
  io?: GuardIo;
}

export class WindowsProcessGuardFactory implements ProcessGuardFactory {
  private readonly helper: JobHelper;
  private readonly pollMs: number;
  private readonly io: GuardIo;

  constructor(options: WindowsGuardOptions = {}) {
    this.helper = options.helper ?? new JobHelper();
    this.pollMs = options.pollMs ?? 3000;
    this.io = options.io ?? realIo;
  }

  /** Start the helper ahead of the first turn. */
  warmUp(): Promise<void> {
    return this.helper.start().catch(() => {});
  }

  async prepare(turnId: string): Promise<PreparedGuard> {
    const job = `turn-${turnId}`;
    const startedAt = Date.now();
    let jobError: string | null = null;
    try {
      await this.helper.request('create', { job });
    } catch (err) {
      jobError = message(err);
    }
    const fallback = (rootPid: number, reason: string): TurnProcessGuard => {
      const guard = new TreeTurnGuard(rootPid, `Job object unavailable (${reason}); tracked the process tree instead.`, {
        pollMs: this.pollMs,
        io: this.io,
        startedAt,
      });
      guard.start();
      return guard;
    };
    return {
      attach: async (rootPid: number) => {
        if (jobError !== null) return fallback(rootPid, jobError);
        try {
          // Send the assignment first; describing the root can wait.
          await this.helper.request('assign', { job, pid: rootPid });
        } catch (err) {
          await this.helper.request('close', { job }).catch(() => {});
          return fallback(rootPid, message(err));
        }
        const described = await this.helper
          .request<(ProcRow & { created: string })[] | null>('describe', { pids: [rootPid] })
          .catch(() => null);
        const root = described?.find((d) => d.pid === rootPid) ?? syntheticRoot(rootPid, startedAt);
        return new JobTurnGuard(this.helper, job, root, this.io);
      },
      discard: async () => {
        if (jobError === null) await this.helper.request('close', { job }).catch(() => {});
      },
    };
  }

  dispose(): void {
    this.helper.dispose();
  }
}

class UnsupportedPlatformFactory implements ProcessGuardFactory {
  async prepare(): Promise<PreparedGuard> {
    return {
      attach: async () => unguarded(`Process guarding is only implemented on Windows (platform: ${process.platform}).`),
      discard: async () => {},
    };
  }
}

type SharedFactory = ProcessGuardFactory & { warmUp?: () => Promise<void>; dispose?: () => void };
let shared: SharedFactory | null = null;

/** One factory (and one PowerShell helper) per process. */
export function sharedProcessGuardFactory(): SharedFactory {
  if (!shared) shared = process.platform === 'win32' ? new WindowsProcessGuardFactory() : new UnsupportedPlatformFactory();
  return shared;
}
