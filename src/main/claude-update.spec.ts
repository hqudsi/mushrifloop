/**
 * The "Claude Code version" card (SPEC.md §11): check reads, update runs only on request and never while a
 * task is running. Nothing here spawns the real CLI or reaches the network.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => require('node:os').tmpdir() } }));

const { checkClaudeCode, isNewer, parseDoctor, updateClaudeCode, versionForChannel } = await import('./claude-update');

/** `claude doctor` on this machine, 2026-09-22 (CLI 2.1.280), with its colour codes. */
const DOCTOR = [
  '\u001b[1mClaude Code doctor\u001b[22m',
  '',
  ' Running: npm-global (2.1.280)',
  ' Commit: 80abbfe7d723',
  ' Platform: win32-x64',
  ' Path: C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  ' Config install method: global',
  ' Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)',
  ' \u001b[2mAuto-update channel:\u001b[22m latest',
  ' Last update attempt: success \u2192 2.1.280 (2026-09-22)',
  '',
  'No installation issues found.',
].join('\n');

/** The registry's dist-tags on the same day. */
const TAGS = { stable: '2.1.267', latest: '2.1.280', next: '2.1.280' };

describe('parseDoctor', () => {
  it("reads the install method, version and channel from Claude Code's own report", () => {
    expect(parseDoctor(DOCTOR)).toEqual({ installMethod: 'npm-global', version: '2.1.280', channel: 'latest' });
  });

  it('returns nulls, not an error, when the lines are not there', () => {
    expect(parseDoctor('something else entirely')).toEqual({ installMethod: null, version: null, channel: null });
  });

  it('reads a stable-channel install', () => {
    expect(parseDoctor(' Running: native (2.1.267)\n Auto-update channel: stable')).toEqual({ installMethod: 'native', version: '2.1.267', channel: 'stable' });
  });
});

describe('versionForChannel and isNewer', () => {
  it("picks the channel Claude Code follows, so a stable user is not offered a latest-only release", () => {
    expect(versionForChannel(TAGS, 'latest')).toBe('2.1.280');
    expect(versionForChannel(TAGS, 'stable')).toBe('2.1.267');
    expect(versionForChannel(TAGS, 'nightly')).toBe('2.1.280');
    expect(versionForChannel('not json', 'latest')).toBeNull();
  });

  it('compares numerically, and says unknown rather than guess', () => {
    expect(isNewer('2.1.281', '2.1.280')).toBe(true);
    expect(isNewer('2.1.280', '2.1.280')).toBe(false);
    expect(isNewer('2.1.100', '2.1.99')).toBe(true);
    expect(isNewer(null, '2.1.280')).toBeNull();
  });
});

type Run = NonNullable<Parameters<typeof checkClaudeCode>[0]['run']>;
const fakeRun = (doctor: string, version = '2.1.280 (Claude Code)'): Run =>
  (async (_binary, args) => ({
    stdout: args[0] === 'doctor' ? doctor : version,
    stderr: '',
    code: 0,
    timedOut: false,
    durationMs: 5,
  })) as Run;
const now = () => new Date('2026-09-22T18:00:00.000Z');

describe('checkClaudeCode', () => {
  it('reports up to date when the channel has nothing newer', async () => {
    const info = await checkClaudeCode({ binary: 'claude', env: {}, fetchDistTags: async () => TAGS, now, run: fakeRun(DOCTOR) });
    expect(info).toEqual({
      checkedAt: '2026-09-22T18:00:00.000Z',
      installed: '2.1.280',
      installMethod: 'npm-global',
      channel: 'latest',
      channelAssumed: false,
      available: '2.1.280',
      newer: false,
      error: null,
    });
  });

  it('reports a newer version on the channel', async () => {
    const info = await checkClaudeCode({ binary: 'claude', env: {}, fetchDistTags: async () => ({ ...TAGS, latest: '2.1.281' }), now, run: fakeRun(DOCTOR) });
    expect(info).toMatchObject({ available: '2.1.281', newer: true });
  });

  it('assumes latest, and says so, when doctor cannot be read', async () => {
    const info = await checkClaudeCode({ binary: 'claude', env: {}, fetchDistTags: async () => TAGS, now, run: fakeRun('') });
    expect(info).toMatchObject({ channel: 'latest', channelAssumed: true, installMethod: null, available: '2.1.280' });
  });

  it('keeps the installed version and explains when the registry cannot be reached', async () => {
    const info = await checkClaudeCode({
      binary: 'claude',
      env: {},
      fetchDistTags: async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      },
      now,
      run: fakeRun(DOCTOR),
    });
    expect(info).toMatchObject({ installed: '2.1.280', available: null, newer: null });
    expect(info.error).toContain('ENOTFOUND');
  });
});

describe('updateClaudeCode', () => {
  it('refuses while a task is running, and never starts the updater', async () => {
    const spawnUpdate = vi.fn();
    const result = await updateClaudeCode({
      binary: 'claude',
      env: {},
      busyTask: () => ({ taskId: 't1', title: 'Fix the search route' }),
      now,
      onOutput: () => {},
      spawnUpdate,
      readVersion: async () => '2.1.280',
    });
    expect(spawnUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, blockedBy: { taskId: 't1' }, exitCode: null });
    expect(result.refused).toContain('"Fix the search route" is running');
  });

  it('runs the update, passes its output on as it arrives, and reads the version again', async () => {
    const chunks: string[] = [];
    let version = '2.1.280';
    const result = await updateClaudeCode({
      binary: 'claude',
      env: {},
      busyTask: () => null,
      now,
      onOutput: (c) => chunks.push(c),
      spawnUpdate: async (_b, _e, onOutput) => {
        onOutput('Checking for updates...\n');
        onOutput('Successfully updated from 2.1.280 to version 2.1.281\n');
        version = '2.1.281';
        return { exitCode: 0, output: 'Checking for updates...\nSuccessfully updated from 2.1.280 to version 2.1.281\n', error: null };
      },
      readVersion: async () => version,
    });
    expect(chunks).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, refused: null, exitCode: 0, before: '2.1.280', after: '2.1.281' });
  });

  it('reports a failed update with its exit code and output', async () => {
    const result = await updateClaudeCode({
      binary: 'claude',
      env: {},
      busyTask: () => null,
      now,
      onOutput: () => {},
      spawnUpdate: async () => ({ exitCode: 1, output: 'npm ERR! code EPERM', error: null }),
      readVersion: async () => '2.1.280',
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1, output: 'npm ERR! code EPERM', before: '2.1.280', after: '2.1.280' });
  });
});
