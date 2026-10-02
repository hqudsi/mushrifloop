/**
 * runTurn against a fake CLI (a real child process), so spawning, stdin, raw files, timeouts,
 * Stop and the rate-limit kill are exercised end to end without spending tokens.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SchemaRegistry } = await import('../schema-validator');
const { APP_SLUG } = await import('../../shared/app-config');
const { runTurn } = await import('./run');
const { JobHelper, WindowsProcessGuardFactory } = await import('../process-guard');
import type { RunnerContext, TurnEvent, TurnSpec } from './types';

const schemas = SchemaRegistry.load(path.resolve(__dirname, '..', '..', '..', 'schemas'));
const FAKE = path.join(__dirname, '__fixtures__', 'fake-claude.mjs');

let dir: string;
let recordDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-run-`));
  recordDir = path.join(dir, 'record');
  fs.mkdirSync(recordDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(scenario: string): RunnerContext {
  return {
    binary: process.execPath,
    binaryArgs: [FAKE],
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_OUT: recordDir },
    cliVersion: async () => ({ version: '2.1.273', error: null }),
  };
}

function spec(overrides: Partial<TurnSpec> = {}): TurnSpec {
  return {
    agent: 'planner',
    prompt: 'TASK: say hello — ünïcödé ✓',
    model: 'opus',
    effort: 'xhigh',
    cwd: dir,
    tools: [],
    systemPrompt: 'You are the PLANNER.',
    schema: 'planner-output',
    maxTurns: 40,
    timeoutMs: 30_000,
    rawDir: path.join(dir, 'raw'),
    turnId: 'turn-1',
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

describe('runTurn with a fake CLI', () => {
  it('reports that no process guard was configured', async () => {
    const outcome = await runTurn(spec(), ctx('success'), schemas);
    expect(outcome.processes).toEqual({ method: 'none', survivors: [], errors: ['no process guard configured'] });
    expect(outcome.slow).toBe(false);
  });

  it('runs a plain session: no schema, no system prompt, the final text as the output (SPEC.md §19.7)', async () => {
    const outcome = await runTurn(
      spec({ agent: 'executor', model: 'sonnet', effort: 'high', tools: ['Read', 'Bash'], schema: null, systemPrompt: 'must not be used' }),
      ctx('plain'),
      schemas,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.output).toBe('All done.');
    const args = JSON.parse(fs.readFileSync(path.join(recordDir, 'args.json'), 'utf8')) as string[];
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).toContain('--allowedTools');
    expect(fs.readFileSync(outcome.systemPromptPath, 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(recordDir, 'stdin.txt'), 'utf8')).toBe('TASK: say hello — ünïcödé ✓');
  });

  it('marks a slow turn without stopping it (SPEC.md §5 net 8)', async () => {
    const events: TurnEvent[] = [];
    const outcome = await runTurn(spec({ slowTurnMs: 300, onEvent: (e) => events.push(e) }), ctx('slow'), schemas);
    expect(outcome.ok).toBe(true);
    expect(outcome.slow).toBe(true);
    expect(outcome.slowTurnMs).toBe(300);
    const slow = events.filter((e) => e.kind === 'slow_turn');
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ thresholdMs: 300 });
  });

  it('does not mark a turn that finished in time', async () => {
    const outcome = await runTurn(spec({ slowTurnMs: 20_000 }), ctx('success'), schemas);
    expect(outcome.slow).toBe(false);
  });

  it('ignores a slow-turn threshold at or above the hard timeout', async () => {
    const events: TurnEvent[] = [];
    await runTurn(spec({ slowTurnMs: 30_000, timeoutMs: 30_000, onEvent: (e) => events.push(e) }), ctx('success'), schemas);
    expect(events.some((e) => e.kind === 'slow_turn')).toBe(false);
  });

  it('runs a successful turn end to end', async () => {
    const events: TurnEvent[] = [];
    const outcome = await runTurn(spec({ onEvent: (e) => events.push(e) }), ctx('success'), schemas);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.output).toMatchObject({ status: 'continue' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.usage?.contextTokens).toBe(5 + 100 + 4800);
    expect(outcome.model.matches).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['stderr', 'init', 'rate_limit', 'tool_use', 'tool_result', 'result']);
  });

  it('sends the prompt on stdin, not as an argument', async () => {
    await runTurn(spec(), ctx('success'), schemas);
    expect(fs.readFileSync(path.join(recordDir, 'stdin.txt'), 'utf8')).toBe('TASK: say hello — ünïcödé ✓');
    const args = JSON.parse(fs.readFileSync(path.join(recordDir, 'args.json'), 'utf8')) as string[];
    expect(args.join(' ')).not.toContain('say hello');
  });

  it('writes the system prompt to a file and passes that file', async () => {
    const outcome = await runTurn(spec(), ctx('success'), schemas);
    expect(fs.readFileSync(outcome.systemPromptPath, 'utf8')).toBe('You are the PLANNER.');
    const args = JSON.parse(fs.readFileSync(path.join(recordDir, 'args.json'), 'utf8')) as string[];
    expect(args[args.indexOf('--system-prompt-file') + 1]).toBe(outcome.systemPromptPath);
  });

  it('saves stdout and stderr verbatim', async () => {
    const outcome = await runTurn(spec(), ctx('success'), schemas);
    const raw = fs.readFileSync(outcome.rawPath, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(5);
    expect(JSON.parse(raw[0] as string)).toMatchObject({ type: 'system', subtype: 'init' });
    expect(fs.readFileSync(outcome.stderrPath, 'utf8')).toBe('a harmless warning\n');
    expect(path.dirname(outcome.rawPath)).toBe(path.join(dir, 'raw'));
  });

  it('mints a session id for a new session and passes it to the CLI', async () => {
    const outcome = await runTurn(spec({ newSessionId: '22222222-2222-2222-2222-222222222222' }), ctx('success'), schemas);
    expect(outcome.sessionId).toBe('22222222-2222-2222-2222-222222222222');
    expect(outcome.resumed).toBe(false);
  });

  it('resumes an existing session', async () => {
    const outcome = await runTurn(spec({ resumeSessionId: 'existing-1' }), ctx('success'), schemas);
    const args = JSON.parse(fs.readFileSync(path.join(recordDir, 'args.json'), 'utf8')) as string[];
    expect(args[args.indexOf('--resume') + 1]).toBe('existing-1');
    expect(args).not.toContain('--session-id');
    expect(outcome.resumed).toBe(true);
    expect(outcome.sessionId).toBe('existing-1');
  });

  it('parses a stream delivered in small, split chunks', async () => {
    const outcome = await runTurn(spec(), ctx('chunked'), schemas);
    expect(outcome.ok).toBe(true);
  });

  it('returns schema_invalid with the offending JSON', async () => {
    const outcome = await runTurn(spec(), ctx('invalid-output'), schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('schema_invalid');
    expect(outcome.error.validationIssues?.[0]?.path).toBe('/next_instruction');
    expect(outcome.error.rawText).toContain('Forgot the instruction.');
  });

  it('reports a process that dies without a result', async () => {
    const outcome = await runTurn(spec(), ctx('no-result'), schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('no_result');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.error.rawText).toContain('something went badly wrong');
  });

  it('kills the whole process tree on timeout', async () => {
    const started = Date.now();
    const outcome = await runTurn(spec({ timeoutMs: 1500 }), ctx('sleep'), schemas);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(15_000);
    const childPid = Number(fs.readFileSync(path.join(recordDir, 'child.pid'), 'utf8'));
    expect(await waitUntilDead(childPid)).toBe(true);
  }, 30_000);

  it('kills the tree immediately on a rejected rate limit (SPEC.md §17)', async () => {
    const started = Date.now();
    const outcome = await runTurn(spec({ timeoutMs: 60_000 }), ctx('rate-limit'), schemas);
    // Far below both the fake's 120 s "retries" and the 60 s timeout.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ kind: 'rate_limited', resetsAt: 1789218600 });
    const childPid = Number(fs.readFileSync(path.join(recordDir, 'child.pid'), 'utf8'));
    expect(await waitUntilDead(childPid)).toBe(true);
  }, 30_000);

  it('stops on abort and kills the tree', async () => {
    const controller = new AbortController();
    const pending = runTurn(spec({ signal: controller.signal }), ctx('sleep'), schemas);
    // Give the fake time to start its child.
    const childFile = path.join(recordDir, 'child.pid');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(childFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const outcome = await pending;
    expect(!outcome.ok && outcome.error.kind).toBe('aborted');
    expect(await waitUntilDead(Number(fs.readFileSync(childFile, 'utf8')))).toBe(true);
  }, 30_000);

  it('does not start a Fable turn on a CLI below the minimum (SPEC.md §8)', async () => {
    const old = { ...ctx('success'), cliVersion: async () => ({ version: '2.1.220', error: null }) };
    const outcome = await runTurn(spec({ model: 'claude-fable-5-1' }), old, schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('cli_version');
    expect(outcome.error.message).toBe(
      'Not started: Fable 5.1 requires Claude Code 2.1.257 or newer; this machine has 2.1.220. Update Claude Code (`claude update`) or choose another model.',
    );
    expect(outcome.processes.errors).toEqual(['no process was started']);
    expect(fs.existsSync(path.join(recordDir, 'args.json'))).toBe(false);
    expect(fs.readFileSync(outcome.rawPath, 'utf8')).toBe('');
  });

  it('does not start a Fable turn when the CLI version cannot be read', async () => {
    const unknown = { ...ctx('success'), cliVersion: async () => ({ version: null, error: 'spawn ENOENT' }) };
    const outcome = await runTurn(spec({ model: 'claude-fable-5-1' }), unknown, schemas);
    expect(!outcome.ok && outcome.error.kind).toBe('cli_version');
    expect(!outcome.ok && outcome.error.message).toContain('could not be read (spawn ENOENT)');
    expect(fs.existsSync(path.join(recordDir, 'args.json'))).toBe(false);
  });

  it('checks the version only for models that have a minimum, and runs Fable on a new enough CLI', async () => {
    let reads = 0;
    const counting = { ...ctx('success'), cliVersion: async () => ((reads += 1), { version: '2.1.273', error: null }) };
    expect((await runTurn(spec(), counting, schemas)).ok).toBe(true);
    expect(reads).toBe(0);
    const fable = await runTurn(spec({ model: 'claude-fable-5-1', turnId: 'turn-2' }), counting, schemas);
    expect(reads).toBe(1);
    expect(!fable.ok && fable.error.kind).not.toBe('cli_version');
  });

  it('does not start when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runTurn(spec({ signal: controller.signal }), ctx('success'), schemas);
    expect(!outcome.ok && outcome.error.kind).toBe('aborted');
    expect(fs.existsSync(path.join(recordDir, 'args.json'))).toBe(false);
  });

  it('reports a missing working directory clearly', async () => {
    const outcome = await runTurn(spec({ cwd: path.join(dir, 'does-not-exist') }), ctx('success'), schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('spawn_failed');
    expect(outcome.error.message).toContain('Working directory does not exist');
  });

  it('reports a binary that cannot be started', async () => {
    const outcome = await runTurn(
      spec(),
      { binary: path.join(dir, 'no-such-claude.exe'), env: process.env, cliVersion: async () => ({ version: null, error: 'not found' }) },
      schemas,
    );
    expect(!outcome.ok && outcome.error.kind).toBe('spawn_failed');
  });
});

/** SPEC.md §5 net 9 — the orphan case, end to end through runTurn, with the real guard. */
describe.skipIf(process.platform !== 'win32')('runTurn with the process guard (Windows)', () => {
  let helper: InstanceType<typeof JobHelper>;

  beforeAll(async () => {
    helper = new JobHelper();
    await helper.start();
  }, 60_000);

  afterAll(() => helper?.dispose());

  it('kills and reports a process the turn left running (job object)', async () => {
    const guarded: RunnerContext = { ...ctx('orphan'), processGuard: new WindowsProcessGuardFactory({ helper }) };
    const outcome = await runTurn(spec(), guarded, schemas);
    expect(outcome.ok).toBe(true);
    const orphan = Number(fs.readFileSync(path.join(recordDir, 'child.pid'), 'utf8'));
    expect(outcome.processes.method).toBe('job');
    expect(outcome.processes.survivors.map((s) => s.pid)).toContain(orphan);
    expect(await waitUntilDead(orphan)).toBe(true);
  }, 60_000);

  it('does the same through the fallback when no job can be made', async () => {
    const broken = new WindowsProcessGuardFactory({
      helper: new JobHelper({ powershell: path.join(dir, 'missing-powershell.exe'), startTimeoutMs: 5000 }),
      pollMs: 400,
    });
    const outcome = await runTurn(spec(), { ...ctx('orphan'), processGuard: broken }, schemas);
    const orphan = Number(fs.readFileSync(path.join(recordDir, 'child.pid'), 'utf8'));
    expect(outcome.processes.method).toBe('tree');
    expect(outcome.processes.survivors.map((s) => s.pid)).toContain(orphan);
    expect(await waitUntilDead(orphan)).toBe(true);
  }, 60_000);

  it('reports nothing when a turn leaves nothing behind', async () => {
    const guarded: RunnerContext = { ...ctx('success'), processGuard: new WindowsProcessGuardFactory({ helper }) };
    const outcome = await runTurn(spec(), guarded, schemas);
    expect(outcome.processes).toEqual({ method: 'job', survivors: [], errors: [] });
  }, 60_000);

  it('kills the tree through the job on timeout', async () => {
    const guarded: RunnerContext = { ...ctx('sleep'), processGuard: new WindowsProcessGuardFactory({ helper }) };
    const outcome = await runTurn(spec({ timeoutMs: 3000 }), guarded, schemas);
    expect(!outcome.ok && outcome.error.kind).toBe('timeout');
    const child = Number(fs.readFileSync(path.join(recordDir, 'child.pid'), 'utf8'));
    expect(await waitUntilDead(child)).toBe(true);
  }, 60_000);
});
