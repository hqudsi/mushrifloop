/**
 * The free init probe (SPEC.md §16) against the fake CLI, and its arguments.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { buildProbeArgs, InvalidTurnError } = await import('./args');
const { InitProbeError, probeInit } = await import('./probe');
const { APP_SLUG } = await import('../../shared/app-config');
import type { RunnerContext } from './types';

const FAKE = path.join(__dirname, '__fixtures__', 'fake-claude.mjs');
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-probe-`));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(scenario: string): RunnerContext {
  return {
    binary: process.execPath,
    binaryArgs: [FAKE],
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_OUT: dir },
    cliVersion: async () => ({ version: '2.1.273', error: null }),
  };
}

describe('buildProbeArgs', () => {
  it('uses the executor configuration, no schema, no session file, no session id', () => {
    const args = buildProbeArgs({ model: 'sonnet', tools: ['Read', 'Bash(git *)', 'Skill'], disallowedTools: ['WebFetch'] });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--model',
      'sonnet',
      '--strict-mcp-config',
      '--tools',
      'Read,Bash,Skill',
      '--allowedTools',
      'Read,Bash(git *),Skill',
      '--disallowedTools',
      'WebFetch',
      '--permission-mode',
      'dontAsk',
    ]);
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--session-id');
  });

  it('mirrors skip-permissions and refuses an empty tool list', () => {
    expect(buildProbeArgs({ model: 'haiku', tools: ['Read'], permissionMode: 'bypassPermissions' })).toContain('--dangerously-skip-permissions');
    expect(() => buildProbeArgs({ model: 'haiku', tools: [] })).toThrow(InvalidTurnError);
  });
});

describe('probeInit', () => {
  it('reads skills and slash commands from init, sending /usage on stdin', async () => {
    const probe = await probeInit({ cwd: dir, model: 'sonnet', tools: ['Read', 'Skill'] }, ctx('probe'));
    expect(probe).toEqual({
      skills: ['deep-research', 'plugin:tidy'],
      slashCommands: ['deep-research', 'plugin:tidy', 'security-review', 'clear'],
      model: 'claude-opus-5[1m]',
      cliVersion: '2.1.273',
      costUsd: 0,
    });
    expect(fs.readFileSync(path.join(dir, 'stdin.txt'), 'utf8')).toBe('/usage');
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')) as string[];
    expect(args).toContain('--no-session-persistence');
  });

  it('throws with the raw output when no init arrives', async () => {
    const err = await probeInit({ cwd: dir, model: 'sonnet', tools: ['Read'] }, ctx('probe-no-init')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitProbeError);
    expect((err as InstanceType<typeof InitProbeError>).message).toMatch(/exit 1\) emitted no init/);
    expect((err as InstanceType<typeof InitProbeError>).rawText).toContain('something is wrong with the settings');
  });

  it('throws when the CLI cannot start', async () => {
    const bad: RunnerContext = { binary: path.join(dir, 'missing.exe'), env: process.env, cliVersion: async () => ({ version: null, error: 'not found' }) };
    await expect(probeInit({ cwd: dir, model: 'sonnet', tools: ['Read'] }, bad)).rejects.toThrow(/Could not start the CLI/);
  });
});
