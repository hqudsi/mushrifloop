import { describe, expect, it } from 'vitest';

import { InvalidTurnError, buildTurnArgs, toolNames, type ArgsInput } from './args';

const SCHEMA = '{"type":"object"}';

function planner(overrides: Partial<ArgsInput> = {}): ArgsInput {
  return {
    agent: 'planner',
    model: 'opus',
    effort: 'xhigh',
    maxTurns: 40,
    schemaJson: SCHEMA,
    systemPromptFile: 'C:\\raw\\t1.system.md',
    session: { mode: 'new', sessionId: '11111111-1111-1111-1111-111111111111' },
    tools: [],
    ...overrides,
  };
}

function executor(overrides: Partial<ArgsInput> = {}): ArgsInput {
  return {
    ...planner(),
    agent: 'executor',
    model: 'sonnet',
    effort: 'high',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Skill'],
    ...overrides,
  };
}

/** Value following a flag, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildTurnArgs — both agents (SPEC.md §3.1)', () => {
  it('runs headless with streaming JSON', () => {
    const args = buildTurnArgs(planner());
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
  });

  it('passes model, effort, max turns and the inline schema', () => {
    const args = buildTurnArgs(planner());
    expect(flag(args, '--model')).toBe('opus');
    expect(flag(args, '--effort')).toBe('xhigh');
    expect(flag(args, '--max-turns')).toBe('40');
    expect(flag(args, '--json-schema')).toBe(SCHEMA);
  });

  it('omits --effort for a model without effort control', () => {
    expect(buildTurnArgs(planner({ model: 'claude-made-up', effort: 'high' }))).not.toContain('--effort');
    // Since Haiku 5.5 (2026-10-08) the alias takes an effort.
    expect(buildTurnArgs(planner({ model: 'haiku', effort: 'low' }))).toContain('--effort');
    expect(buildTurnArgs(planner({ effort: null }))).not.toContain('--effort');
  });

  it('uses --session-id for a new session and --resume for an existing one, never both', () => {
    const fresh = buildTurnArgs(planner());
    expect(flag(fresh, '--session-id')).toBe('11111111-1111-1111-1111-111111111111');
    expect(fresh).not.toContain('--resume');

    const resumed = buildTurnArgs(planner({ session: { mode: 'resume', sessionId: 'abc' } }));
    expect(flag(resumed, '--resume')).toBe('abc');
    expect(resumed).not.toContain('--session-id');
  });

  it('isolates both agents from user MCP servers', () => {
    expect(buildTurnArgs(planner())).toContain('--strict-mcp-config');
    expect(buildTurnArgs(executor())).toContain('--strict-mcp-config');
  });

  it('never carries a positional prompt: every value belongs to a flag', () => {
    // Variadic flags would swallow a trailing prompt (NOTES.md §1); the prompt goes on stdin.
    const booleanFlags = new Set(['-p', '--verbose', '--strict-mcp-config', '--dangerously-skip-permissions']);
    for (const args of [buildTurnArgs(planner()), buildTurnArgs(executor()), buildTurnArgs(executor({ permissionMode: 'bypassPermissions' }))]) {
      for (let i = 0; i < args.length; i++) {
        const token = args[i] as string;
        if (token.startsWith('-')) continue;
        const previous = args[i - 1] ?? '';
        expect(previous.startsWith('-') && !booleanFlags.has(previous), `"${token}" is not a flag value`).toBe(true);
      }
    }
  });
});

describe('buildTurnArgs — planner', () => {
  it('disables every tool with an empty --tools value', () => {
    const args = buildTurnArgs(planner());
    expect(flag(args, '--tools')).toBe('');
    expect(args).not.toContain('--allowedTools');
  });

  it('replaces the system prompt and loads no settings from disk', () => {
    const args = buildTurnArgs(planner());
    expect(flag(args, '--system-prompt-file')).toBe('C:\\raw\\t1.system.md');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(flag(args, '--setting-sources')).toBe('');
  });

  it('allows exactly Read/Glob/Grep in read-only mode', () => {
    const args = buildTurnArgs(planner({ tools: ['Read', 'Glob', 'Grep'] }));
    expect(flag(args, '--tools')).toBe('Read,Glob,Grep');
  });

  it('refuses to give the planner any other tool', () => {
    expect(() => buildTurnArgs(planner({ tools: ['Read', 'Bash'] }))).toThrow(InvalidTurnError);
  });

  it('has no permission flags', () => {
    const args = buildTurnArgs(planner());
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('buildTurnArgs — executor', () => {
  it('passes the tool list both as restriction and as allowlist', () => {
    const args = buildTurnArgs(executor());
    expect(flag(args, '--tools')).toBe('Read,Edit,Write,Glob,Grep,Bash,PowerShell,Skill');
    expect(flag(args, '--allowedTools')).toBe('Read,Edit,Write,Glob,Grep,Bash,PowerShell,Skill');
  });

  it('strips permission patterns from --tools but keeps them in --allowedTools', () => {
    const args = buildTurnArgs(executor({ tools: ['Read', 'Bash(git *)', 'Bash(npm test)'] }));
    expect(flag(args, '--tools')).toBe('Read,Bash');
    expect(flag(args, '--allowedTools')).toBe('Read,Bash(git *),Bash(npm test)');
  });

  it('appends (not replaces) the system prompt and keeps project settings', () => {
    const args = buildTurnArgs(executor());
    expect(flag(args, '--append-system-prompt-file')).toBe('C:\\raw\\t1.system.md');
    expect(args).not.toContain('--system-prompt-file');
    expect(args).not.toContain('--setting-sources');
  });

  it('defaults to dontAsk', () => {
    expect(flag(buildTurnArgs(executor()), '--permission-mode')).toBe('dontAsk');
  });

  it('uses the skip-permissions flag only when asked', () => {
    const args = buildTurnArgs(executor({ permissionMode: 'bypassPermissions' }));
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('adds --disallowedTools only when there are any', () => {
    expect(buildTurnArgs(executor())).not.toContain('--disallowedTools');
    const args = buildTurnArgs(executor({ disallowedTools: ['WebFetch', 'Bash(rm *)'] }));
    expect(flag(args, '--disallowedTools')).toBe('WebFetch,Bash(rm *)');
  });

  it('refuses an empty tool list', () => {
    expect(() => buildTurnArgs(executor({ tools: [] }))).toThrow(InvalidTurnError);
  });
});

describe('buildTurnArgs — plain session (the evaluation baseline, SPEC.md §19.7)', () => {
  const args = buildTurnArgs(executor({ schemaJson: null, systemPromptFile: null }));

  it('passes no schema and no system prompt file', () => {
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).not.toContain('--system-prompt-file');
  });

  it('keeps the Executor’s model, tools, permission mode and MCP isolation', () => {
    expect(flag(args, '--model')).toBe('sonnet');
    expect(flag(args, '--effort')).toBe('high');
    expect(flag(args, '--tools')).toBe('Read,Edit,Write,Glob,Grep,Bash,PowerShell,Skill');
    expect(flag(args, '--allowedTools')).toBe('Read,Edit,Write,Glob,Grep,Bash,PowerShell,Skill');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--session-id');
  });

  it('is never allowed for the planner', () => {
    expect(() => buildTurnArgs(planner({ schemaJson: null }))).toThrow(InvalidTurnError);
    expect(() => buildTurnArgs(planner({ systemPromptFile: null }))).toThrow(InvalidTurnError);
  });
});

describe('toolNames', () => {
  it('reduces entries to unique bare names', () => {
    expect(toolNames(['Bash(git *)', 'Bash', ' Read ', 'Edit(src/**)'])).toEqual(['Bash', 'Read', 'Edit']);
  });
});
