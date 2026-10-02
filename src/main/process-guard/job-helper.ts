/**
 * Windows Job Objects without a native dependency (NOTES.md §15.1).
 *
 * Node and Electron expose no Job Object API. Windows ships PowerShell 5.1 with .NET, which can call
 * the Win32 job functions via P/Invoke, so one long-lived PowerShell process holds the job handles and
 * answers JSON-line requests. Verified: a Node-spawned process can be assigned to such a job even though
 * libuv already put it in a job of its own (nested jobs), and a grandchild it starts later stays in the
 * job after its parent exits — the orphan case — and dies when the job is terminated.
 *
 * Bonus safety: every job is created with KILL_ON_JOB_CLOSE, so if the helper itself dies (app crash),
 * Windows kills everything still in its jobs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

/** The helper script. The C# type name is generic on purpose (no product name in code). */
export const JOB_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# A malformed LIB variable breaks Add-Type's compiler on some machines (NOTES.md §15.1).
$env:LIB = $null
$env:LIBPATH = $null
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ProcessJobs {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  static readonly Dictionary<string, IntPtr> Jobs = new Dictionary<string, IntPtr>();
  static IntPtr Get(string id) {
    IntPtr job;
    if (!Jobs.TryGetValue(id, out job)) throw new InvalidOperationException("no job " + id);
    return job;
  }
  public static void Create(string id) {
    if (Jobs.ContainsKey(id)) throw new InvalidOperationException("job exists " + id);
    IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var info = new ExtendedLimit();
    info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; breakaway NOT allowed
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) {
      var err = new Win32Exception();
      CloseHandle(job);
      throw err;
    }
    Jobs[id] = job;
  }
  public static void Assign(string id, uint pid) {
    IntPtr process = OpenProcess(0x0100 | 0x0001, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (process == IntPtr.Zero) throw new Win32Exception();
    try { if (!AssignProcessToJobObject(Get(id), process)) throw new Win32Exception(); }
    finally { CloseHandle(process); }
  }
  public static uint[] Pids(string id) {
    int size = 8 + 8 * 4096;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(Get(id), 3, buffer, (uint)size, IntPtr.Zero)) throw new Win32Exception();
      int count = Marshal.ReadInt32(buffer, 4);
      var pids = new uint[count];
      for (int i = 0; i < count; i++) pids[i] = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Kill(string id) { if (!TerminateJobObject(Get(id), 1)) throw new Win32Exception(); }
  public static void Close(string id) { CloseHandle(Get(id)); Jobs.Remove(id); }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Send-Reply($id, $ok, $result, $message) {
  $reply = [ordered]@{ id = $id; ok = $ok; result = $result; error = $message }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 5))
  [Console]::Out.Flush()
}
Send-Reply 0 $true 'ready' $null
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $request = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    $job = [string]$request.job
    switch ([string]$request.op) {
      'create' { [ProcessJobs]::Create($job); Send-Reply $request.id $true $null $null }
      'assign' { [ProcessJobs]::Assign($job, [uint32]$request.pid); Send-Reply $request.id $true $null $null }
      'pids'   { Send-Reply $request.id $true ([object[]]@([ProcessJobs]::Pids($job))) $null }
      'kill'   { [ProcessJobs]::Kill($job); Send-Reply $request.id $true $null $null }
      'close'  { [ProcessJobs]::Close($job); Send-Reply $request.id $true $null $null }
      'describe' {
        $rows = @()
        $ids = @($request.pids)
        if ($ids.Count -gt 0) {
          $filter = ($ids | ForEach-Object { 'ProcessId=' + [int]$_ }) -join ' OR '
          $rows = @(Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {
            [ordered]@{
              pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine
              created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })
            }
          })
        }
        Send-Reply $request.id $true ([object[]]$rows) $null
      }
      default { Send-Reply $request.id $false $null ('unknown op ' + $request.op) }
    }
  } catch {
    $id = if ($null -ne $request) { $request.id } else { -1 }
    Send-Reply $id $false $null $_.Exception.Message
  }
}
`;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JobHelperOptions {
  /** Defaults to Windows PowerShell 5.1 under %SystemRoot%. */
  powershell?: string;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
}

export class JobHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobHelperError';
  }
}

function defaultPowerShell(): string {
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Client for the helper process. Requests are answered in order; one helper serves every turn. */
export class JobHelper {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly powershell: string;
  private readonly requestTimeoutMs: number;
  private readonly startTimeoutMs: number;

  constructor(options: JobHelperOptions = {}) {
    this.powershell = options.powershell ?? defaultPowerShell();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
  }

  /** Start the helper if it is not running. Safe to call repeatedly; call early to avoid first-turn latency. */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const encoded = Buffer.from(JOB_HELPER_SCRIPT, 'utf16le').toString('base64');
      let child: ChildProcess;
      try {
        child = spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        this.starting = null;
        reject(new JobHelperError(`Cannot start PowerShell: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.child = child;
      let stderr = '';
      let ready = false;

      const startTimer = setTimeout(() => {
        fail(`PowerShell job helper did not start within ${this.startTimeoutMs} ms. ${stderr.trim()}`);
        child.kill();
      }, this.startTimeoutMs);

      const fail = (message: string) => {
        clearTimeout(startTimer);
        if (!ready) reject(new JobHelperError(message));
        this.reset(new JobHelperError(message));
      };

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      child.on('error', (err) => fail(`PowerShell job helper failed: ${err.message}`));
      child.on('exit', (code) => fail(`PowerShell job helper exited (code ${code}). ${stderr.trim()}`));

      createInterface({ input: child.stdout! }).on('line', (line) => {
        let reply: { id?: number; ok?: boolean; result?: unknown; error?: string | null };
        try {
          reply = JSON.parse(line) as typeof reply;
        } catch {
          return; // not ours (PowerShell noise)
        }
        if (reply.id === 0 && !ready) {
          ready = true;
          clearTimeout(startTimer);
          resolve();
          return;
        }
        const waiter = reply.id === undefined ? undefined : this.pending.get(reply.id);
        if (!waiter) return;
        this.pending.delete(reply.id as number);
        clearTimeout(waiter.timer);
        if (reply.ok) waiter.resolve(reply.result);
        else waiter.reject(new JobHelperError(reply.error ?? 'unknown helper error'));
      });

      // The helper must never keep a CLI tool alive on its own.
      child.unref();
      (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
      (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
      (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    });
    return this.starting;
  }

  private reset(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.starting = null;
  }

  async request<T>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new JobHelperError('PowerShell job helper is not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JobHelperError(`PowerShell job helper did not answer "${op}" within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin!.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    });
  }

  /** Close stdin: the helper exits, its handles close, and any job still holding processes kills them. */
  dispose(): void {
    const child = this.child;
    this.reset(new JobHelperError('PowerShell job helper disposed'));
    child?.stdin?.end();
  }
}
