/**
 * Fallback layer (SPEC.md §5 net 9): track a turn's descendants by polling the process table.
 *
 * Used only when a Job Object cannot be used. It catches any process that lives longer than one
 * polling interval — which is the dangerous case — because once recorded, a descendant stays tracked
 * even after its parent exits.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Creation time as an ISO string — with the pid, identifies a process despite pid reuse. */
  created: string;
  name: string | null;
  commandLine: string | null;
}

/**
 * Milliseconds since the epoch. PowerShell writes 7 fractional digits and JavaScript 3, so ISO strings
 * are not safely comparable as text; unparseable values sort first.
 */
export function createdMs(iso: string): number {
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Add every row whose parent is already tracked, repeating until nothing changes (a child and its
 * own child can first appear in the same snapshot). A row created before its supposed parent is a
 * reused pid, not a child.
 */
export function extendTracked(tracked: Map<number, ProcRow>, rows: readonly ProcRow[]): void {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (tracked.has(row.pid)) continue;
      const parent = tracked.get(row.ppid);
      if (!parent || createdMs(row.created) < createdMs(parent.created)) continue;
      // The tracked parent exited and its pid now belongs to a different, newer process:
      // children created since then are that process's, not ours.
      const holder = byPid.get(row.ppid);
      if (holder && holder.created !== parent.created && createdMs(row.created) >= createdMs(holder.created)) continue;
      tracked.set(row.pid, row);
      changed = true;
    }
  }
}

/** Tracked processes (other than the root) that are still the same live process in `rows`. */
export function liveSurvivors(tracked: Map<number, ProcRow>, rows: readonly ProcRow[], rootPid: number): ProcRow[] {
  const now = new Map(rows.map((r) => [r.pid, r]));
  const out: ProcRow[] = [];
  for (const [pid, row] of tracked) {
    if (pid === rootPid) continue;
    const current = now.get(pid);
    if (current && current.created === row.created) out.push(current);
  }
  return out;
}

const SNAPSHOT_COMMAND =
  '$ErrorActionPreference = "Stop"; ' +
  '$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [ordered]@{ ' +
  'pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ' +
  'created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { "" }); ' +
  'name = $_.Name; commandLine = $_.CommandLine } }); ' +
  '[Console]::Out.Write((ConvertTo-Json -InputObject ([object[]]$rows) -Compress -Depth 3))';

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** One process-table snapshot via a short-lived PowerShell (independent of the job helper). */
export function takeSnapshot(timeoutMs = 20_000): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_COMMAND], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process snapshot timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`process snapshot failed (code ${code}): ${err.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as ProcRow[];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (e) {
        reject(new Error(`process snapshot was not JSON: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

/** Kill one process tree by pid (best effort). */
export function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
