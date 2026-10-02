/**
 * Everything that touches the `claude` CLI — SPEC.md §3.2 (environment, binary) and §3.3 (test connection).
 *
 * The rules encoded here were verified against the real CLI; see NOTES.md §1, §5.5, §7, §8.
 * In particular: the prompt goes on stdin (variadic flags eat positional prompts), the npm `.cmd`
 * shim is resolved to the real `.exe` so we can spawn without a shell, and errors are classified
 * from stdout JSON (`is_error`/`terminal_reason`/`api_error_status`), never from `subtype` or stderr.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ClaudeAuthInfo,
  ClaudeBinaryInfo,
  ClaudeOverageInfo,
  ClaudeProbeInfo,
  TestConnectionResult,
} from '../shared/ipc';
import { MIN_CLI_VERSION, isVersionBelow, modelVersionBlock, modelsTooNewFor } from '../shared/models';
import type { Settings } from '../shared/settings';
import { errorMessage, log } from './logger';

const VERSION_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Environment (SPEC.md §3.2)
// ---------------------------------------------------------------------------

/**
 * Build the environment for a spawned CLI process.
 *
 * Removes every `ANTHROPIC_*` variable unless API-key billing is explicitly enabled (a stray key
 * silently switches billing away from the subscription), plus `CLAUDECODE`/`CLAUDE_CODE_*`/
 * `CLAUDE_EFFORT`, which leak in when this app is itself launched from a Claude Code session.
 */
export function buildEnv(settings: Settings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('ANTHROPIC_')) {
      if (!settings.claudeCode.allowApiKeyBilling) continue;
    } else if (upper === 'CLAUDECODE' || upper.startsWith('CLAUDE_CODE_') || upper === 'CLAUDE_EFFORT') {
      continue;
    }
    env[key] = value;
  }
  if (settings.claudeCode.maxRetries !== null) {
    env['CLAUDE_CODE_MAX_RETRIES'] = String(settings.claudeCode.maxRetries);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Binary resolution (SPEC.md §3.2)
// ---------------------------------------------------------------------------

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * npm installs `claude` as a `.cmd`/`.ps1` shim, which cannot be spawned without `shell: true`.
 * The shim wraps a real executable — find it so we can spawn directly.
 */
export function resolveShim(candidate: string): string | null {
  const ext = path.extname(candidate).toLowerCase();
  if (ext !== '.cmd' && ext !== '.ps1' && ext !== '') return null;

  const dir = path.dirname(candidate);
  const packaged = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (fileExists(packaged)) return packaged;

  // Fall back to reading the shim: npm shims name the target explicitly.
  try {
    const text = fs.readFileSync(candidate, 'utf8');
    const match = text.match(/[\w$%~\\/.:-]*claude\.exe/i);
    if (match) {
      const raw = match[0].replace(/%~dp0\\?/gi, dir + path.sep).replace(/\$basedir\/?/gi, dir + path.sep);
      const normalized = path.normalize(raw);
      if (fileExists(normalized)) return normalized;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function searchPath(): string[] {
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? '';
  const dirs = pathVar.split(path.delimiter).filter((d) => d.length > 0);
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Resolve the binary to use: the configured path if set, otherwise the first one on PATH. */
export function resolveClaudeBinary(settings: Settings): ClaudeBinaryInfo {
  const configured = settings.claudeCode.binaryPath;
  if (configured) {
    if (!fileExists(configured)) {
      return { path: null, source: 'setting', error: `Configured path does not exist: ${configured}` };
    }
    const resolved = resolveShim(configured);
    return resolved
      ? { path: resolved, source: 'setting', resolvedFrom: configured }
      : { path: configured, source: 'setting' };
  }

  for (const candidate of searchPath()) {
    const resolved = resolveShim(candidate);
    if (resolved) return { path: resolved, source: 'path', resolvedFrom: candidate };
    if (path.extname(candidate).toLowerCase() === '.exe' || process.platform !== 'win32') {
      return { path: candidate, source: 'path' };
    }
  }
  return { path: null, source: 'not-found', error: '`claude` was not found on PATH. Set the path in settings.' };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

/** Kill a process and its children. On Windows a plain kill() leaves the tree running. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* best effort */
  }
}

export function runClaude(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs: number },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(binary, [...args], {
        env: options.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        code: null,
        timedOut: false,
        durationMs: Date.now() - started,
        spawnError: errorMessage(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        durationMs: Date.now() - started,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    child.on('error', (err) => finish(null, errorMessage(err)));
    child.on('close', (code) => finish(code));

    // The prompt always goes on stdin (NOTES.md §1: variadic flags swallow positional prompts).
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* ignore EPIPE when the CLI exits early */
      });
      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const versionCache = new Map<string, { stamp: string; version: string }>();

/**
 * The installed CLI's version for the SPEC.md §8 minimum-version check. Cached per binary and re-read
 * when the binary file changes (an update replaces it). A failed read is not cached.
 */
export async function readCliVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  /** Arguments before `--version` — a fake CLI run through `node` (RunnerContext.binaryArgs). */
  prefixArgs: readonly string[] = [],
): Promise<{ version: string | null; error: string | null }> {
  let stamp: string;
  try {
    const stat = fs.statSync(binary);
    stamp = `${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    return { version: null, error: `${binary}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const key = [binary, ...prefixArgs].join(' ');
  const hit = versionCache.get(key);
  if (hit && hit.stamp === stamp) return { version: hit.version, error: null };
  const run = await runClaude(binary, [...prefixArgs, '--version'], { env, timeoutMs: VERSION_TIMEOUT_MS });
  if (run.spawnError) return { version: null, error: `could not run ${binary}: ${run.spawnError}` };
  const version = parseVersion(run.stdout);
  if (!version) return { version: null, error: `no version in the output of \`${binary} --version\`: ${run.stdout.trim() || '(nothing)'}` };
  versionCache.set(key, { stamp, version });
  return { version, error: null };
}

/**
 * Settings → Task defaults may not name a model the installed CLI cannot run (SPEC.md §8) — the same check
 * a turn makes before it spawns. Returns the refusal, or null.
 */
/**
 * "Task settings" on a running task may not switch an agent to a model the installed CLI cannot run
 * (SPEC.md §6, §8) — the same check as a new task and as every turn spawn. Returns the refusal, or null.
 */
export async function modelChangeVersionBlock(settings: Settings, models: readonly { role: string; model: string }[]): Promise<string | null> {
  if (models.every((m) => modelVersionBlock(m.model, '0.0.0') === null)) return null;
  const binary = resolveClaudeBinary(settings);
  const reading = binary.path
    ? await readCliVersion(binary.path, buildEnv(settings))
    : { version: null, error: binary.error ?? 'the claude CLI was not found' };
  for (const m of models) {
    const block = modelVersionBlock(m.model, reading.version, reading.error);
    if (block) return `${m.role}: ${block} Choose another model, or update Claude Code first.`;
  }
  return null;
}

export async function taskDefaultsVersionBlock(settings: Settings): Promise<string | null> {
  const defaults = [
    { role: 'Planner', model: settings.taskDefaults.plannerModel },
    { role: 'Executor', model: settings.taskDefaults.executorModel },
  ];
  if (defaults.every((d) => modelVersionBlock(d.model, '0.0.0') === null)) return null;
  const binary = resolveClaudeBinary(settings);
  const reading = binary.path
    ? await readCliVersion(binary.path, buildEnv(settings))
    : { version: null, error: binary.error ?? 'the claude CLI was not found' };
  for (const d of defaults) {
    const block = modelVersionBlock(d.model, reading.version, reading.error);
    if (block) return `${d.role} default: ${block} Choose another model, or update Claude Code and save again.`;
  }
  return null;
}

/**
 * Test connection's version warnings (SPEC.md §3.3): below the app's own minimum, and every model whose own
 * minimum is above the installed version, named with what it needs.
 */
export function cliVersionWarnings(version: string): string[] {
  const out: string[] = [];
  if (isVersionBelow(version, MIN_CLI_VERSION)) {
    out.push(`Claude Code ${version} is below the minimum ${MIN_CLI_VERSION} this app needs. Run \`claude update\`.`);
  }
  const blocked = modelsTooNewFor(version);
  if (blocked.length > 0) {
    const list = blocked.map((m) => `${m.label} (needs ${m.minimum})`).join(', ');
    out.push(`On Claude Code ${version} these models cannot run: ${list}. Run \`claude update\` to use them.`);
  }
  return out;
}

/** `claude --version` prints e.g. "2.1.273 (Claude Code)". */
export function parseVersion(stdout: string): string | null {
  const match = stdout.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNKNOWN_AUTH = 'Unknown — run `/status` in Claude Code to confirm';

/**
 * Parse `claude auth status --json`. Tolerant of unknown fields: the CLI added three between
 * 2.1.220 and 2.1.273 (NOTES.md §8.4). When it cannot be determined we say so verbatim
 * rather than guessing (SPEC.md §3.3).
 */
export function parseAuthStatus(stdout: string): ClaudeAuthInfo {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isRecord(parsed)) return { known: false, unknownReason: UNKNOWN_AUTH };
    const pick = (key: string): string | null =>
      typeof parsed[key] === 'string' ? (parsed[key] as string) : null;
    const info: ClaudeAuthInfo = { known: true };
    if (typeof parsed['loggedIn'] === 'boolean') info.loggedIn = parsed['loggedIn'];
    const authMethod = pick('authMethod');
    if (authMethod) info.authMethod = authMethod;
    const apiProvider = pick('apiProvider');
    if (apiProvider) info.apiProvider = apiProvider;
    const apiKeySource = pick('apiKeySource');
    if (apiKeySource) info.apiKeySource = apiKeySource;
    info.email = pick('email');
    info.orgName = pick('orgName');
    info.subscriptionType = pick('subscriptionType');
    return info;
  } catch {
    return { known: false, unknownReason: UNKNOWN_AUTH };
  }
}

export interface StreamJsonSummary {
  init: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  rateLimit: Record<string, unknown> | null;
}

/** Pull the messages we care about out of a `--output-format stream-json` stdout. */
export function parseStreamJson(stdout: string): StreamJsonSummary {
  const summary: StreamJsonSummary = { init: null, result: null, rateLimit: null };
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(message)) continue;
    if (message['type'] === 'system' && message['subtype'] === 'init') summary.init = message;
    else if (message['type'] === 'result') summary.result = message;
    else if (message['type'] === 'rate_limit_event') summary.rateLimit = message;
  }
  return summary;
}

/**
 * The model that actually served the turn (SPEC.md §8).
 *
 * `modelUsage` routinely carries a background `claude-haiku-*` helper entry alongside the real
 * model. Output tokens do NOT separate them — on a "Reply with OK" turn the helper produced more
 * output (11) than the main model (4). Total tokens do: the main model carries the whole prompt
 * cache (tens of thousands), the helper a few hundred.
 */
export interface ServedModel {
  /** The `modelUsage` key, e.g. `claude-opus-5[1m]`. */
  model: string;
  /** `canonicalModel` when the CLI reports it, e.g. `claude-opus-5`. */
  canonical: string | null;
  contextWindow: number | null;
}

export function pickServedModel(modelUsage: unknown): ServedModel | null {
  if (!isRecord(modelUsage)) return null;
  const num = (raw: Record<string, unknown>, key: string): number =>
    typeof raw[key] === 'number' ? (raw[key] as number) : 0;

  let best: (ServedModel & { total: number }) | null = null;
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isRecord(raw)) continue;
    const total =
      num(raw, 'inputTokens') + num(raw, 'cacheReadInputTokens') + num(raw, 'cacheCreationInputTokens') + num(raw, 'outputTokens');
    const contextWindow = typeof raw['contextWindow'] === 'number' ? (raw['contextWindow'] as number) : null;
    const canonical = typeof raw['canonicalModel'] === 'string' ? (raw['canonicalModel'] as string) : null;
    if (best === null || total > best.total) best = { model, canonical, contextWindow, total };
  }
  if (best === null) return null;
  return { model: best.model, canonical: best.canonical, contextWindow: best.contextWindow };
}

/** Strip a `[1m]`-style suffix so `claude-opus-5[1m]` compares equal to `claude-opus-5`. */
function baseModelName(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function parseOverage(rateLimit: Record<string, unknown> | null): ClaudeOverageInfo {
  const info = rateLimit?.['rate_limit_info'];
  if (!isRecord(info)) return { known: false };
  const out: ClaudeOverageInfo = { known: true };
  if (typeof info['status'] === 'string') out.status = info['status'];
  if (typeof info['overageStatus'] === 'string') out.overageStatus = info['overageStatus'];
  if (typeof info['overageDisabledReason'] === 'string') out.overageDisabledReason = info['overageDisabledReason'];
  if (typeof info['rateLimitType'] === 'string') out.rateLimitType = info['rateLimitType'];
  if (typeof info['resetsAt'] === 'number') out.resetsAt = info['resetsAt'];
  if (typeof info['isUsingOverage'] === 'boolean') out.isUsingOverage = info['isUsingOverage'];
  return out;
}

// ---------------------------------------------------------------------------
// Test connection (SPEC.md §3.3)
// ---------------------------------------------------------------------------

/**
 * Three steps, all against the real CLI:
 *   1. `--version`            → version + minimum-version warnings
 *   2. `auth status --json`   → account email / organization / plan
 *   3. a minimal `-p` probe   → success, the model actually served, and overage behaviour
 */
export async function testConnection(
  settings: Settings,
  binaryPathOverride?: string | null,
): Promise<TestConnectionResult> {
  const started = Date.now();
  const effective: Settings = binaryPathOverride
    ? { ...settings, claudeCode: { ...settings.claudeCode, binaryPath: binaryPathOverride } }
    : settings;

  const binary = resolveClaudeBinary(effective);
  const base: TestConnectionResult = {
    ok: false,
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    binary,
    version: null,
    versionWarnings: [],
    auth: { known: false, unknownReason: UNKNOWN_AUTH },
    probe: {
      ran: false,
      succeeded: false,
      requestedModel: null,
      servedModel: null,
      servedContextWindow: null,
      modelMismatch: false,
      resultText: null,
      isError: false,
      apiErrorStatus: null,
      terminalReason: null,
      durationMs: 0,
      totalCostUsd: null,
    },
    overage: { known: false },
  };

  if (!binary.path) {
    log.warn('claude.binary_not_found', { source: binary.source, error: binary.error });
    return { ...base, durationMs: Date.now() - started, error: binary.error ?? '`claude` binary not found.' };
  }

  const env = buildEnv(effective);

  // 1. version
  const versionRun = await runClaude(binary.path, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS });
  if (versionRun.spawnError) {
    return {
      ...base,
      durationMs: Date.now() - started,
      error: `Could not run ${binary.path}: ${versionRun.spawnError}`,
    };
  }
  const version = parseVersion(versionRun.stdout);
  const versionWarnings = version
    ? cliVersionWarnings(version)
    : [`Could not read a version from: ${versionRun.stdout.trim() || '(no output)'}`];

  // 2. auth status
  const authRun = await runClaude(binary.path, ['auth', 'status', '--json'], { env, timeoutMs: AUTH_TIMEOUT_MS });
  const auth = authRun.stdout.trim() ? parseAuthStatus(authRun.stdout) : { known: false, unknownReason: UNKNOWN_AUTH };

  // 3. minimal probe. Prompt on stdin; no --model, so it reports the account's default.
  // --tools ""/--strict-mcp-config/--setting-sources "" keep it cheap and independent of user config.
  const probeArgs = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ];
  const probeRun = await runClaude(binary.path, probeArgs, {
    env,
    input: 'Reply with OK',
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const stream = parseStreamJson(probeRun.stdout);
  const result = stream.result;
  const served = pickServedModel(result?.['modelUsage']);
  const initModel = typeof stream.init?.['model'] === 'string' ? (stream.init['model'] as string) : null;

  const isError = result?.['is_error'] === true;
  const probe: ClaudeProbeInfo = {
    ran: true,
    succeeded: result !== null && !isError && !probeRun.timedOut,
    requestedModel: null,
    servedModel: served?.model ?? initModel,
    servedContextWindow: served?.contextWindow ?? null,
    // No --model was requested, so a mismatch can only be reported against what init announced.
    modelMismatch:
      served !== null && initModel !== null && baseModelName(served.model) !== baseModelName(initModel),
    resultText: typeof result?.['result'] === 'string' ? (result['result'] as string) : null,
    isError,
    apiErrorStatus: typeof result?.['api_error_status'] === 'number' ? (result['api_error_status'] as number) : null,
    terminalReason: typeof result?.['terminal_reason'] === 'string' ? (result['terminal_reason'] as string) : null,
    durationMs: probeRun.durationMs,
    totalCostUsd: typeof result?.['total_cost_usd'] === 'number' ? (result['total_cost_usd'] as number) : null,
  };

  if (probeRun.timedOut) {
    probe.errorText = `The probe did not finish within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s and was stopped.`;
  } else if (isError && typeof result?.['result'] === 'string') {
    probe.errorText = result['result'] as string;
  } else if (result === null) {
    probe.errorText =
      probeRun.stderr.trim() ||
      probeRun.spawnError ||
      `The CLI exited with code ${probeRun.code} without producing a result.`;
  }

  const outcome: TestConnectionResult = {
    ok: probe.succeeded,
    checkedAt: base.checkedAt,
    durationMs: Date.now() - started,
    binary,
    version,
    versionWarnings,
    auth,
    probe,
    overage: parseOverage(stream.rateLimit),
  };

  log.info('claude.test_connection', {
    ok: outcome.ok,
    version,
    plan: auth.subscriptionType ?? null,
    servedModel: probe.servedModel,
    durationMs: outcome.durationMs,
  });
  return outcome;
}
