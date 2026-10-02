/**
 * The "Claude Code version" card (SPEC.md §11, decided 2026-09-22): is a newer Claude Code published, and
 * update it — only when the user presses the button.
 *
 * This is about Claude Code, the CLI the app drives, never about the app itself.
 *
 * - The installed version is `claude --version`. How it was installed and which release channel it follows
 *   come from Claude Code's own report, `claude doctor` ("Running: npm-global (2.1.280)",
 *   "Auto-update channel: latest"), read best-effort: if the lines are not there, the channel is assumed
 *   `latest` and the card says so.
 * - The newest published version of that channel comes from the npm registry's dist-tags, which is where
 *   Claude Code releases are published. The check spends no quota and installs nothing.
 * - The update is Claude Code's own `claude update`, run only on request, never while a task is running.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';

import { compareVersions } from '../shared/models';
import type { ClaudeCodeUpdateResult, ClaudeCodeVersionInfo } from '../shared/ipc';
import { killTree, parseVersion, runClaude } from './claude-cli';

/** Where Claude Code releases are published; `dist-tags` maps each channel to its newest version. */
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';

const DOCTOR_TIMEOUT_MS = 45_000;
const REGISTRY_TIMEOUT_MS = 20_000;
/** `claude update` downloads and installs; give it room, but not forever. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;

export interface DoctorFacts {
  /** "npm-global", "native", …: as Claude Code names it. */
  installMethod: string | null;
  version: string | null;
  /** "latest" or "stable". */
  channel: string | null;
}

/** Pull the three facts out of `claude doctor`'s text. Anything missing is null; nothing here throws. */
export function parseDoctor(text: string): DoctorFacts {
  // doctor draws with ANSI colour codes; strip them before matching.
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const running = /^\s*Running:\s*(\S+)\s*\(([^)]+)\)/m.exec(plain);
  const channel = /^\s*Auto-update channel:\s*(\S+)/m.exec(plain);
  return {
    installMethod: running?.[1] ?? null,
    version: running?.[2]?.trim() ?? null,
    channel: channel?.[1]?.toLowerCase() ?? null,
  };
}

/** The newest version on `channel`, falling back to `latest` when the channel is not in the tags. */
export function versionForChannel(distTags: unknown, channel: string): string | null {
  if (typeof distTags !== 'object' || distTags === null) return null;
  const tags = distTags as Record<string, unknown>;
  const pick = tags[channel] ?? tags['latest'];
  return typeof pick === 'string' && pick.length > 0 ? pick : null;
}

/** Newer, same, or unknown: null when either side could not be read. */
export function isNewer(available: string | null, installed: string | null): boolean | null {
  if (available === null || installed === null) return null;
  return compareVersions(available, installed) > 0;
}

export interface CheckDeps {
  binary: string;
  env: NodeJS.ProcessEnv;
  fetchDistTags: () => Promise<unknown>;
  now: () => Date;
  /** Injected in tests; the real CLI otherwise. */
  run?: typeof runClaude;
}

/** Read the installed version, its channel, and the newest on that channel. Never throws. */
export async function checkClaudeCode(deps: CheckDeps): Promise<ClaudeCodeVersionInfo> {
  const checkedAt = deps.now().toISOString();
  const run = deps.run ?? runClaude;
  const [versionRun, doctorRun] = await Promise.all([
    run(deps.binary, ['--version'], { env: deps.env, timeoutMs: 20_000 }),
    // doctor reads settings in its working directory without a trust prompt, so keep it out of any project.
    run(deps.binary, ['doctor'], { env: deps.env, timeoutMs: DOCTOR_TIMEOUT_MS, cwd: os.tmpdir() }),
  ]);
  const installed = parseVersion(versionRun.stdout);
  const doctor = parseDoctor(`${doctorRun.stdout}\n${doctorRun.stderr}`);
  const channel = doctor.channel ?? 'latest';

  let available: string | null = null;
  let error: string | null = null;
  try {
    available = versionForChannel(await deps.fetchDistTags(), channel);
    if (available === null) error = `The npm registry did not list a "${channel}" version of Claude Code.`;
  } catch (err) {
    error = `Could not reach the npm registry to check for a newer Claude Code: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (installed === null) {
    error = error ?? `Could not read the installed Claude Code version${versionRun.spawnError ? `: ${versionRun.spawnError}` : ''}.`;
  }

  return {
    checkedAt,
    installed,
    installMethod: doctor.installMethod,
    channel,
    channelAssumed: doctor.channel === null,
    available,
    newer: isNewer(available, installed),
    error,
  };
}

/** GET the dist-tags with a timeout. Uses the runtime's own `fetch`: no dependency. */
export async function fetchDistTags(url = DIST_TAGS_URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

export interface UpdateDeps {
  binary: string;
  env: NodeJS.ProcessEnv;
  /** The task that would have its binary replaced under it, if any (SPEC.md §11). */
  busyTask: () => { taskId: string; title: string } | null;
  now: () => Date;
  onOutput: (chunk: string) => void;
  spawnUpdate?: typeof spawnClaudeUpdate;
  readVersion?: () => Promise<string | null>;
}

/**
 * Run `claude update` — only ever because the user pressed the button. Refused while a task is running.
 * Output is passed on as it arrives; afterwards the version is read again, so the card can say what changed.
 */
export async function updateClaudeCode(deps: UpdateDeps): Promise<ClaudeCodeUpdateResult> {
  const startedAt = deps.now().toISOString();
  const readVersion =
    deps.readVersion ?? (async () => parseVersion((await runClaude(deps.binary, ['--version'], { env: deps.env, timeoutMs: 20_000 })).stdout));
  const busy = deps.busyTask();
  if (busy) {
    return {
      ok: false,
      refused: `"${busy.title}" is running, and updating would replace the Claude Code it is using mid-turn. Wait for it to finish, or pause or stop it, then update.`,
      blockedBy: busy,
      startedAt,
      exitCode: null,
      output: '',
      before: null,
      after: null,
    };
  }
  const before = await readVersion();
  const run = await (deps.spawnUpdate ?? spawnClaudeUpdate)(deps.binary, deps.env, deps.onOutput);
  const after = await readVersion();
  return {
    ok: run.exitCode === 0 && run.error === null,
    refused: null,
    blockedBy: null,
    startedAt,
    exitCode: run.exitCode,
    output: run.output,
    before,
    after,
    ...(run.error ? { error: run.error } : {}),
  };
}

/** Spawn `claude update`, streaming stdout and stderr together. */
export function spawnClaudeUpdate(
  binary: string,
  env: NodeJS.ProcessEnv,
  onOutput: (chunk: string) => void,
): Promise<{ exitCode: number | null; output: string; error: string | null }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (exitCode: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output, error });
    };
    let child;
    try {
      child = spawn(binary, ['update'], { env, cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(null, `Could not start \`claude update\`: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      onOutput(text);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => finish(null, `Could not run \`claude update\`: ${err.message}`));
    child.on('close', (code) => finish(code, null));
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(null, `\`claude update\` did not finish within ${UPDATE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
    }, UPDATE_TIMEOUT_MS);
  });
}
