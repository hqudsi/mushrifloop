import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { buildEnv, cliVersionWarnings, parseAuthStatus, parseStreamJson, parseVersion, pickServedModel, readCliVersion, taskDefaultsVersionBlock } =
  await import('./claude-cli');
const { defaultSettings } = await import('../shared/settings');

/** SPEC.md §3.2 — the rule that keeps a stray API key from silently switching billing. */
describe('buildEnv', () => {
  const base = {
    PATH: 'C:\\bin',
    HOME: 'C:\\Users\\dev',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_EFFORT: 'xhigh',
    UNRELATED: 'keep-me',
  };

  it('strips every ANTHROPIC_* variable by default', () => {
    const env = buildEnv(defaultSettings(), base);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('strips inherited Claude Code session variables', () => {
    const env = buildEnv(defaultSettings(), base);
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(env['CLAUDE_EFFORT']).toBeUndefined();
  });

  it('keeps everything else', () => {
    const env = buildEnv(defaultSettings(), base);
    expect(env['PATH']).toBe('C:\\bin');
    expect(env['HOME']).toBe('C:\\Users\\dev');
    expect(env['UNRELATED']).toBe('keep-me');
  });

  it('keeps ANTHROPIC_* only when API-key billing is explicitly enabled', () => {
    const settings = defaultSettings();
    settings.claudeCode.allowApiKeyBilling = true;
    const env = buildEnv(settings, base);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-secret');
    // Session variables are still stripped: they are unrelated to billing.
    expect(env['CLAUDECODE']).toBeUndefined();
  });

  it('is case-insensitive about the variables it strips', () => {
    const env = buildEnv(defaultSettings(), { anthropic_api_key: 'sk-ant-secret', claudecode: '1' });
    expect(env['anthropic_api_key']).toBeUndefined();
    expect(env['claudecode']).toBeUndefined();
  });

  it('passes the retry override only when configured', () => {
    expect(buildEnv(defaultSettings(), base)['CLAUDE_CODE_MAX_RETRIES']).toBeUndefined();
    const settings = defaultSettings();
    settings.claudeCode.maxRetries = 0;
    expect(buildEnv(settings, base)['CLAUDE_CODE_MAX_RETRIES']).toBe('0');
  });
});

describe('parseVersion', () => {
  it('reads the version out of the CLI banner', () => {
    expect(parseVersion('2.1.273 (Claude Code)\n')).toBe('2.1.273');
  });

  it('returns null when there is no version to read', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('command not found')).toBeNull();
  });
});

describe('parseAuthStatus', () => {
  it('reads account, organization and plan', () => {
    const info = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'dev@example.com',
        orgName: "dev's Organization",
        subscriptionType: 'max',
        // Fields the CLI added between 2.1.220 and 2.1.273 — must not break parsing.
        analyticsDisabled: false,
        configDirectory: 'C:\\Users\\dev\\.claude',
      }),
    );
    expect(info.known).toBe(true);
    expect(info.loggedIn).toBe(true);
    expect(info.email).toBe('dev@example.com');
    expect(info.orgName).toBe("dev's Organization");
    expect(info.subscriptionType).toBe('max');
  });

  it('reports an API key taking precedence over the subscription', () => {
    const info = parseAuthStatus(
      JSON.stringify({ loggedIn: true, apiKeySource: 'ANTHROPIC_API_KEY', email: null, subscriptionType: null }),
    );
    expect(info.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(info.email).toBeNull();
  });

  it('says "Unknown — run /status" rather than guessing when output is unusable', () => {
    for (const bad of ['', 'not json', '"a string"', '[]']) {
      const info = parseAuthStatus(bad);
      expect(info.known).toBe(false);
      expect(info.unknownReason).toBe('Unknown — run `/status` in Claude Code to confirm');
    }
  });
});

describe('parseStreamJson', () => {
  const stream = [
    '{"type":"system","subtype":"init","model":"claude-opus-5[1m]","tools":[],"session_id":"s1"}',
    'not json at all',
    '{"type":"system","subtype":"thinking_tokens","estimated_tokens":5}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789566000}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"OK"}',
    '',
  ].join('\n');

  it('picks out init, result and the rate-limit event, ignoring everything else', () => {
    const parsed = parseStreamJson(stream);
    expect(parsed.init?.['model']).toBe('claude-opus-5[1m]');
    expect(parsed.result?.['result']).toBe('OK');
    expect((parsed.rateLimit?.['rate_limit_info'] as Record<string, unknown>)['status']).toBe('allowed');
  });

  it('survives unparseable output without throwing', () => {
    const parsed = parseStreamJson('garbage\n{oops\n');
    expect(parsed.init).toBeNull();
    expect(parsed.result).toBeNull();
  });

  it('keeps the last result when several are present', () => {
    const parsed = parseStreamJson(
      '{"type":"result","result":"first"}\n{"type":"result","result":"second"}',
    );
    expect(parsed.result?.['result']).toBe('second');
  });
});

describe('pickServedModel (SPEC.md §8)', () => {
  // Real shape from a probe: the background Haiku helper produced MORE output tokens than the
  // model that served the turn, so output tokens alone identify the wrong model.
  const modelUsage = {
    'claude-haiku-4-5-20251001': {
      inputTokens: 519,
      outputTokens: 11,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
    },
    'claude-opus-5[1m]': {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 20_884,
      cacheCreationInputTokens: 10_499,
      contextWindow: 1_000_000,
    },
  };

  it('reports the model that served the turn, not the background helper', () => {
    expect(pickServedModel(modelUsage)).toEqual({
      model: 'claude-opus-5[1m]',
      canonical: null,
      contextWindow: 1_000_000,
    });
  });

  it('handles a single-model turn', () => {
    expect(
      pickServedModel({
        'claude-sonnet-5': { inputTokens: 10, outputTokens: 2, contextWindow: 1_000_000, canonicalModel: 'claude-sonnet-5' },
      }),
    ).toEqual({ model: 'claude-sonnet-5', canonical: 'claude-sonnet-5', contextWindow: 1_000_000 });
  });

  it('returns null when there is nothing to report', () => {
    expect(pickServedModel({})).toBeNull();
    expect(pickServedModel(undefined)).toBeNull();
    expect(pickServedModel('nonsense')).toBeNull();
  });
});

/** SPEC.md §8 (decided 2026-09-17): Settings may not save a default the installed CLI cannot run. */
/** SPEC.md §3.3: Test connection names the app's minimum and every model the installed CLI cannot run. */
describe('cliVersionWarnings', () => {
  it('says nothing on a CLI that runs every model', () => {
    expect(cliVersionWarnings('2.1.280')).toEqual([]);
  });

  it('names each model whose own minimum is above the installed version', () => {
    expect(cliVersionWarnings('2.1.273')).toEqual([
      'On Claude Code 2.1.273 these models cannot run: Opus 5.5 (needs 2.1.280). Run `claude update` to use them.',
    ]);
    expect(cliVersionWarnings('2.1.251')).toEqual([
      'On Claude Code 2.1.251 these models cannot run: Fable 5.1 (needs 2.1.257), Opus 5.5 (needs 2.1.280). Run `claude update` to use them.',
    ]);
  });

  it("adds the app's own minimum when the CLI is below it", () => {
    const w = cliVersionWarnings('2.1.220');
    expect(w[0]).toBe('Claude Code 2.1.220 is below the minimum 2.1.251 this app needs. Run `claude update`.');
    expect(w[1]).toContain('Fable 5.1 (needs 2.1.257), Opus 5.5 (needs 2.1.280)');
  });
});

describe('taskDefaultsVersionBlock', () => {
  it('passes defaults without a minimum without reading the version', async () => {
    const settings = defaultSettings();
    settings.claudeCode.binaryPath = 'Z:\\nowhere\\claude.exe';
    expect(await taskDefaultsVersionBlock(settings)).toBeNull();
  });

  it('refuses a Fable default when the CLI version cannot be read', async () => {
    const settings = defaultSettings();
    settings.taskDefaults.executorModel = 'claude-fable-5-1';
    settings.claudeCode.binaryPath = 'Z:\\nowhere\\claude.exe';
    expect(await taskDefaultsVersionBlock(settings)).toBe(
      'Executor default: Fable 5.1 requires Claude Code 2.1.257 or newer, and the installed version could not be read (Configured path does not exist: Z:\\nowhere\\claude.exe). Choose another model, or update Claude Code and save again.',
    );
  });

  it('accepts a Fable default on a new enough binary (node reports v2x.y.z)', async () => {
    const settings = defaultSettings();
    settings.taskDefaults.plannerModel = 'claude-fable-5-1';
    settings.claudeCode.binaryPath = process.execPath;
    expect(await taskDefaultsVersionBlock(settings)).toBeNull();
    expect((await readCliVersion(process.execPath, process.env)).version).toBe(process.versions.node);
  });
});
