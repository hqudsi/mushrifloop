import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SchemaRegistry } = await import('../schema-validator');
const { classifyTurn, contextTokensOf } = await import('./classify');
const { TurnAccumulator } = await import('./stream');

const schemas = SchemaRegistry.load(path.resolve(__dirname, '..', '..', '..', 'schemas'));

const identity = {
  turnId: 't1',
  agent: 'planner' as const,
  sessionId: 'pre-minted',
  resumed: false,
  startedAt: '2026-09-16T10:00:00.000Z',
  durationMs: 1234,
  rawPath: 'raw/t1.ndjson',
  stderrPath: 'raw/t1.stderr',
  systemPromptPath: 'raw/t1.system.md',
  args: ['-p'],
  requestedModel: 'opus',
  schema: 'planner-output' as const,
  previousTotals: null,
};

const facts = {
  exitCode: 0,
  spawnError: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 1_200_000,
  stderrTail: '',
  stdoutTail: '',
  slow: false,
  slowTurnMs: null,
  processes: null,
};

const plannerOutput = { status: 'continue', reasoning_summary: 'r', next_instruction: 'do it' };

function result(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'pre-minted',
    num_turns: 2,
    result: JSON.stringify(plannerOutput),
    structured_output: plannerOutput,
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 34,
      cache_creation_input_tokens: 25_517,
      cache_read_input_tokens: 74_852,
      output_tokens: 1012,
      // Real numbers from NOTES.md §4a: the summed figures above overstate the context ~3×.
      iterations: [{ input_tokens: 8, cache_creation_input_tokens: 169, cache_read_input_tokens: 25_348, output_tokens: 404 }],
    },
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 519, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      'claude-opus-5[1m]': {
        inputTokens: 34,
        outputTokens: 1012,
        cacheReadInputTokens: 74_852,
        cacheCreationInputTokens: 25_517,
        contextWindow: 1_000_000,
        canonicalModel: 'claude-opus-5',
      },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    ...overrides,
  };
}

function accWith(...messages: unknown[]) {
  const acc = new TurnAccumulator();
  acc.addLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'pre-minted', model: 'claude-opus-5[1m]' }));
  for (const m of messages) acc.addLine(JSON.stringify(m));
  return acc;
}

describe('classifyTurn — success', () => {
  const outcome = classifyTurn(identity, accWith(result()), facts, schemas);

  it('returns the validated output', () => {
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.output).toEqual(plannerOutput);
  });

  it('measures context from the last API call, not the summed usage (SPEC.md §15)', () => {
    expect(outcome.usage?.contextTokens).toBe(8 + 169 + 25_348);
    expect(outcome.usage?.cacheReadTokens).toBe(74_852);
    expect(outcome.usage?.numTurns).toBe(2);
    expect(outcome.usage?.costUsd).toBe(0.02);
    expect(outcome.usage?.sessionCostUsd).toBe(0.02);
  });

  it('a resumed turn’s cost is the change in the session’s running total (SPEC.md §15)', () => {
    const previousTotals = {
      costUsd: 0.015,
      modelUsage: { 'claude-opus-5[1m]': { inputTokens: 30, outputTokens: 900, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 25_000, contextWindow: 1_000_000 } },
    };
    const resumed = classifyTurn({ ...identity, resumed: true, previousTotals }, accWith(result()), facts, schemas);
    expect(resumed.usage?.sessionCostUsd).toBe(0.02);
    expect(resumed.usage?.costUsd).toBeCloseTo(0.005);
    expect(resumed.usage?.modelUsage['claude-opus-5[1m]']).toMatchObject({ outputTokens: 112, cacheReadInputTokens: 24_852, contextWindow: 1_000_000 });
    // The helper model is new in this turn: all of it is the turn's.
    expect(resumed.usage?.modelUsage['claude-haiku-4-5-20251001']).toMatchObject({ inputTokens: 519 });
    // `usage` is the turn's own already, and is left as reported.
    expect(resumed.usage?.outputTokens).toBe(1012);
  });

  it('the served model is read from the turn’s own share: a model an earlier turn used does not count (SPEC.md §15)', () => {
    // The session ran on Opus, then continued on Sonnet: its running `modelUsage` lists both.
    const opus = { inputTokens: 34, outputTokens: 1012, cacheReadInputTokens: 74_852, cacheCreationInputTokens: 25_517, contextWindow: 1_000_000, canonicalModel: 'claude-opus-5' };
    const sonnet = { inputTokens: 5, outputTokens: 300, cacheReadInputTokens: 9_000, cacheCreationInputTokens: 100, contextWindow: 1_000_000 };
    const switched = classifyTurn(
      { ...identity, resumed: true, requestedModel: 'sonnet', previousTotals: { costUsd: 0.015, modelUsage: { 'claude-opus-5[1m]': opus } } },
      accWith(result({ modelUsage: { 'claude-opus-5[1m]': opus, 'claude-sonnet-5': sonnet } })),
      facts,
      schemas,
    );
    expect(switched.model.served).toBe('claude-sonnet-5');
    expect(switched.model.alsoServed).toEqual([]);
  });

  it('identifies the served model past the helper entry and accepts the alias (SPEC.md §8)', () => {
    expect(outcome.model).toEqual({
      requested: 'opus',
      announced: 'claude-opus-5[1m]',
      served: 'claude-opus-5[1m]',
      canonical: 'claude-opus-5',
      contextWindow: 1_000_000,
      matches: true,
      // This init names no CLI version, so `opus` may be either of its rows; Haiku's helper call is not listed.
      cliVersion: null,
      alsoServed: [],
    });
  });

  it('takes the session id from the result', () => {
    expect(outcome.sessionId).toBe('pre-minted');
  });
});

describe('a session the CLI no longer has (SPEC.md §5 net 13)', () => {
  const gone = 'No conversation found with session ID: 0f0b1e1a-1111-2222-3333-444455556666';

  it('is its own kind, not a generic process failure', () => {
    const outcome = classifyTurn(
      { ...identity, resumed: true },
      accWith(),
      { ...facts, exitCode: 1, stderrTail: gone },
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('session_gone');
    expect(outcome.error.message).toContain('no longer has session');
  });

  it('only counts when the turn was resuming one: a fresh session failing is a plain no-result', () => {
    const outcome = classifyTurn({ ...identity, resumed: false }, accWith(), { ...facts, exitCode: 1, stderrTail: gone }, schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('no_result');
  });

  it('a resumed turn that fails for another reason is still a no-result', () => {
    const outcome = classifyTurn(
      { ...identity, resumed: true },
      accWith(),
      { ...facts, exitCode: 1, stderrTail: 'EPERM: operation not permitted' },
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('no_result');
  });
});

describe('classifyTurn — model substitution', () => {
  it('flags a turn served by a different model without failing it', () => {
    const substituted = result({
      modelUsage: {
        'claude-opus-5': { inputTokens: 1, outputTokens: 4, cacheReadInputTokens: 9000, canonicalModel: 'claude-opus-5' },
      },
    });
    const outcome = classifyTurn({ ...identity, requestedModel: 'claude-fable-5-1' }, accWith(substituted), facts, schemas);
    expect(outcome.ok).toBe(true);
    expect(outcome.model.matches).toBe(false);
  });

  /** An `init` from the CLI that really ran the turn: it decides what an alias meant (SPEC.md §8). */
  function accOn(cliVersion: string, ...messages: unknown[]) {
    const acc = new TurnAccumulator();
    acc.addLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'pre-minted', model: 'claude-opus-5-5[1m]', claude_code_version: cliVersion }));
    for (const m of messages) acc.addLine(JSON.stringify(m));
    return acc;
  }

  const opus55 = {
    'claude-opus-5-5[1m]': { inputTokens: 34, outputTokens: 1012, cacheReadInputTokens: 74_852, contextWindow: 1_000_000, canonicalModel: 'claude-opus-5-5' },
  };

  it('raises no false mismatch when `opus` is served as Opus 5.5 on CLI 2.1.280', () => {
    const outcome = classifyTurn(identity, accOn('2.1.280', result({ modelUsage: opus55 })), facts, schemas);
    expect(outcome.model).toMatchObject({ requested: 'opus', matches: true, cliVersion: '2.1.280', alsoServed: [] });
  });

  it('knows `opus` served as Opus 5.5 on an older CLI would be a mismatch', () => {
    const outcome = classifyTurn(identity, accOn('2.1.273', result({ modelUsage: opus55 })), facts, schemas);
    expect(outcome.model.matches).toBe(false);
  });

  it('surfaces a safety-classifier fallback even when the fallback served less than the model it replaced', () => {
    // Opus 5.5 started, was flagged, and Opus 4.8 finished the turn: the main model still "wins" on tokens.
    const fallback = result({
      modelUsage: {
        ...opus55,
        'claude-opus-4-8': { inputTokens: 12, outputTokens: 300, cacheReadInputTokens: 0, canonicalModel: 'claude-opus-4-8' },
        'claude-haiku-4-5-20251001': { inputTokens: 519, outputTokens: 11 },
      },
    });
    const outcome = classifyTurn({ ...identity, requestedModel: 'claude-opus-5-5' }, accOn('2.1.280', fallback), facts, schemas);
    expect(outcome.model.matches).toBe(true);
    // Haiku is Claude Code's model for small internal calls, so it is not listed; Opus 4.8 is.
    expect(outcome.model.alsoServed).toEqual(['claude-opus-4-8']);
  });

  it('shows a fallback that served most of the turn as a plain mismatch', () => {
    const fallback = result({
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 2, outputTokens: 5, canonicalModel: 'claude-opus-5-5' },
        'claude-opus-4-8': { inputTokens: 34, outputTokens: 1012, cacheReadInputTokens: 74_852, canonicalModel: 'claude-opus-4-8' },
      },
    });
    const outcome = classifyTurn({ ...identity, requestedModel: 'claude-opus-5-5' }, accOn('2.1.280', fallback), facts, schemas);
    expect(outcome.model).toMatchObject({ served: 'claude-opus-4-8', matches: false });
  });
});

describe('classifyTurn — process failures', () => {
  it('reports a spawn failure', () => {
    const outcome = classifyTurn(identity, new TurnAccumulator(), { ...facts, spawnError: 'ENOENT' }, schemas);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ kind: 'spawn_failed', rawText: 'ENOENT' });
  });

  it('reports a timeout with whatever output there was', () => {
    const outcome = classifyTurn(
      identity,
      accWith(),
      { ...facts, timedOut: true, timeoutMs: 30_000, exitCode: null, stderrTail: 'still working', stdoutTail: '{"type":"system"}' },
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('timeout');
    expect(outcome.error.message).toContain('30 s');
    expect(outcome.error.rawText).toContain('still working');
  });

  it('reports a stop', () => {
    const outcome = classifyTurn(identity, accWith(), { ...facts, aborted: true, exitCode: null }, schemas);
    expect(!outcome.ok && outcome.error.kind).toBe('aborted');
  });

  it('reports a process that ended without a result, with stderr', () => {
    const outcome = classifyTurn(identity, accWith(), { ...facts, exitCode: 3, stderrTail: 'boom' }, schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('no_result');
    expect(outcome.error.message).toContain('code 3');
    expect(outcome.error.rawText).toContain('boom');
  });
});

describe('classifyTurn — what the CLI said (SPEC.md §3.5)', () => {
  it('treats the real 401 shape as an API error even though subtype says "success"', () => {
    const outcome = classifyTurn(
      identity,
      accWith(
        { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 401,
          terminal_reason: 'api_error',
          result: 'Failed to authenticate. API Error: 401 API key is invalid.',
          usage: { input_tokens: 0, iterations: [] },
          modelUsage: {},
        },
      ),
      { ...facts, exitCode: 1 },
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({
      kind: 'api_error',
      apiErrorStatus: 401,
      terminalReason: 'api_error',
      rawText: 'Failed to authenticate. API Error: 401 API key is invalid.',
    });
    expect(outcome.model.served).toBeNull();
    expect(outcome.model.matches).toBeNull();
  });

  it('classifies a 429 result as rate limited', () => {
    const outcome = classifyTurn(
      identity,
      accWith(
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1789218600 } },
        { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, terminal_reason: 'api_error', result: "You've hit your session limit · resets 4:10pm" },
      ),
      facts,
      schemas,
    );
    expect(!outcome.ok && outcome.error).toMatchObject({ kind: 'rate_limited', resetsAt: 1789218600 });
  });

  it('prefers a rejected rate-limit event over everything else and keeps its reset time', () => {
    const outcome = classifyTurn(
      identity,
      accWith({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1789218600, rateLimitType: 'five_hour' } }),
      { ...facts, exitCode: null },
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ kind: 'rate_limited', resetsAt: 1789218600 });
    expect(outcome.error.message).toContain('five_hour');
  });

  it('recognises --max-turns', () => {
    const outcome = classifyTurn(identity, accWith(result({ subtype: 'error_max_turns', is_error: true, structured_output: undefined })), facts, schemas);
    expect(!outcome.ok && outcome.error.kind).toBe('max_turns');
  });

  it('recognises structured-output exhaustion', () => {
    const outcome = classifyTurn(
      identity,
      accWith(result({ subtype: 'error_max_structured_output_retries', is_error: true, structured_output: undefined })),
      facts,
      schemas,
    );
    expect(!outcome.ok && outcome.error.kind).toBe('structured_output_failed');
    expect(!outcome.ok && outcome.error.message).toBe('The CLI could not get a schema-valid answer from the model.');
  });

  it('names the refusals when the CLI gives up, and carries them on every outcome (SPEC.md §3.5)', () => {
    const refusal = (id: string) => [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'StructuredOutput', input: { status: 'continue' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "root: must have required property 'reasoning_summary'" }] } },
    ];
    const gaveUp = classifyTurn(
      identity,
      accWith(...refusal('a'), ...refusal('b'), result({ subtype: 'error_max_structured_output_retries', is_error: true, structured_output: undefined })),
      facts,
      schemas,
    );
    expect(gaveUp.ok).toBe(false);
    if (gaveUp.ok) return;
    expect(gaveUp.error.message).toBe(
      "The CLI refused all 2 structured answers the model gave. Reason: root: must have required property 'reasoning_summary'",
    );
    expect(gaveUp.answerRejections).toMatchObject({ count: 2 });

    const recovered = classifyTurn(identity, accWith(...refusal('c'), result()), facts, schemas);
    expect(recovered.ok).toBe(true);
    expect(recovered.answerRejections).toEqual({
      count: 1,
      reasons: ["root: must have required property 'reasoning_summary'"],
      largestAttemptChars: JSON.stringify({ status: 'continue' }).length,
    });
    expect(recovered.toolUses).toEqual({});
  });

  it('falls back to process_failed for other errors, using the errors list', () => {
    const outcome = classifyTurn(
      identity,
      accWith({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['tool crashed'] }),
      facts,
      schemas,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('process_failed');
    expect(outcome.error.message).toBe('tool crashed');
  });
});

describe('classifyTurn — schema validation', () => {
  it('fails a result without structured output', () => {
    const outcome = classifyTurn(identity, accWith(result({ structured_output: undefined, result: 'plain prose' })), facts, schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('schema_invalid');
    expect(outcome.error.rawText).toBe('plain prose');
  });

  it('fails an answer that breaks the schema, with the ajv path and the raw JSON', () => {
    const bad = { status: 'continue', reasoning_summary: 'r', next_instruction: 'x', mood: 'great' };
    const outcome = classifyTurn(identity, accWith(result({ structured_output: bad })), facts, schemas);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('schema_invalid');
    expect(outcome.error.validationIssues?.map((i) => i.path)).toEqual(['/mood']);
    expect(outcome.error.message).toContain('/mood');
    expect(JSON.parse(outcome.error.rawText)).toEqual(bad);
  });

  it('fails an answer that breaks a documented conditional requirement', () => {
    const outcome = classifyTurn(
      identity,
      accWith(result({ structured_output: { status: 'continue', reasoning_summary: 'r' } })),
      facts,
      schemas,
    );
    expect(!outcome.ok && outcome.error.validationIssues).toEqual([
      { path: '/next_instruction', message: expect.any(String) },
    ]);
  });

  it('validates against the schema of the agent that ran', () => {
    const executorOutput = { status: 'ok', summary: 's', changed_files: [], tests: { ran: false }, problems: [] };
    const asExecutor = classifyTurn(
      { ...identity, agent: 'executor', schema: 'executor-output', requestedModel: 'sonnet' },
      accWith(result({ structured_output: executorOutput })),
      facts,
      schemas,
    );
    expect(asExecutor.ok).toBe(true);
  });
});

describe('classifyTurn — collected facts', () => {
  it('passes through permission denials', () => {
    const outcome = classifyTurn(
      identity,
      accWith(result({ permission_denials: [{ tool_name: 'PowerShell', tool_use_id: 'x', tool_input: { command: 'New-Item a' } }] })),
      facts,
      schemas,
    );
    expect(outcome.permissionDenials).toEqual([{ toolName: 'PowerShell', toolUseId: 'x', input: { command: 'New-Item a' } }]);
  });

  it('passes through skill invocations', () => {
    const outcome = classifyTurn(
      identity,
      accWith(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'security-review' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: security-review' }] } },
        result(),
      ),
      facts,
      schemas,
    );
    expect(outcome.skillInvocations).toEqual([
      { skill: 'security-review', toolUseId: 's1', isError: false, resultText: 'Launching skill: security-review' },
    ]);
  });
});

describe('contextTokensOf', () => {
  it('falls back to the last assistant usage when iterations are missing', () => {
    expect(contextTokensOf({ usage: { input_tokens: 99 } }, { input_tokens: 2, cache_read_input_tokens: 40, cache_creation_input_tokens: 3 })).toBe(45);
  });

  it('returns null when nothing reports it', () => {
    expect(contextTokensOf(null, null)).toBeNull();
    expect(contextTokensOf({ usage: { iterations: [] } }, null)).toBeNull();
  });
});

describe('classifyTurn — plain session (SPEC.md §19.7)', () => {
  const plain = { ...identity, agent: 'executor' as const, requestedModel: 'sonnet', schema: null };

  it('succeeds with the final text as its output, with no structured answer', () => {
    const text = 'I fixed the discount rule and the tests pass.';
    const outcome = classifyTurn(plain, accWith(result({ result: text, structured_output: undefined })), facts, schemas);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.output).toBe(text);
    expect(outcome.usage?.costUsd).toBe(0.02);
  });

  it('still fails on what the CLI reports', () => {
    const outcome = classifyTurn(plain, accWith(result({ subtype: 'error_max_turns', is_error: true })), facts, schemas);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('max_turns');
  });
});

describe('classifyTurn — refused before spawning', () => {
  it('is a cli_version failure with the reason', () => {
    const outcome = classifyTurn(identity, new TurnAccumulator(), { ...facts, exitCode: null, refused: 'Not started: too old.' }, schemas);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toEqual({ kind: 'cli_version', message: 'Not started: too old.', rawText: 'Not started: too old.' });
  });
});
