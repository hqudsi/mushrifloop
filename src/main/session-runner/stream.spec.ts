import { describe, expect, it } from 'vitest';

import { LineSplitter, TurnAccumulator, toEvents } from './stream';

describe('LineSplitter', () => {
  it('returns complete lines and keeps the unfinished tail', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });

  it('handles CRLF and blank lines', () => {
    const s = new LineSplitter();
    expect(s.push('one\r\n\r\ntwo\r\n')).toEqual(['one', 'two']);
  });

  it('reassembles a stream cut into arbitrary pieces', () => {
    const text = '{"type":"system","subtype":"init"}\r\n{"type":"result","result":"é ✓"}\n';
    for (const size of [1, 2, 5, 13]) {
      const s = new LineSplitter();
      const lines: string[] = [];
      for (let i = 0; i < text.length; i += size) lines.push(...s.push(text.slice(i, i + size)));
      lines.push(...s.flush());
      expect(lines).toEqual(['{"type":"system","subtype":"init"}', '{"type":"result","result":"é ✓"}']);
    }
  });

  it('flushes a final line without a newline', () => {
    const s = new LineSplitter();
    expect(s.push('{"x":1}')).toEqual([]);
    expect(s.flush()).toEqual(['{"x":1}']);
  });
});

describe('toEvents', () => {
  it('maps init', () => {
    const [event] = toEvents({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-opus-5[1m]',
      tools: ['StructuredOutput'],
      skills: ['security-review'],
      slash_commands: ['usage'],
      permissionMode: 'dontAsk',
      cwd: 'C:\\p',
      claude_code_version: '2.1.273',
    });
    expect(event).toMatchObject({
      kind: 'init',
      sessionId: 's1',
      model: 'claude-opus-5[1m]',
      tools: ['StructuredOutput'],
      skills: ['security-review'],
      permissionMode: 'dontAsk',
      cliVersion: '2.1.273',
    });
  });

  it('splits an assistant message into one event per block', () => {
    const events = toEvents({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '…' },
          { type: 'text', text: 'Running it.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node hello.js' } },
        ],
      },
    });
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'text', 'tool_use']);
    expect(events[2]).toMatchObject({ name: 'Bash', toolUseId: 't1', input: { command: 'node hello.js' } });
  });

  it('flattens tool_result content blocks', () => {
    const [event] = toEvents({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'denied' }] },
        ],
      },
    });
    expect(event).toMatchObject({ kind: 'tool_result', toolUseId: 't1', isError: true, content: 'denied' });
  });

  it('does not echo the prompt (user text) as an event', () => {
    expect(toEvents({ type: 'user', message: { content: 'the prompt' } })).toEqual([]);
  });

  it('reads the per-window plan utilization the CLI attaches to rate-limit events', () => {
    const [event] = toEvents({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.2, resetsAt: 1789584600 },
          seven_day: { utilization: 0.47, resetsAt: 1789668000 },
        },
      },
    });
    expect(event).toMatchObject({
      kind: 'rate_limit',
      info: {
        windows: {
          five_hour: { utilization: 0.2, resetsAt: 1789584600 },
          seven_day: { utilization: 0.47, resetsAt: 1789668000 },
        },
      },
    });
    const [older] = toEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    expect(older).toMatchObject({ info: { windows: {} } });
  });

  it('maps rate-limit and api-retry events', () => {
    expect(
      toEvents({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 5, rateLimitType: 'five_hour' } })[0],
    ).toMatchObject({ kind: 'rate_limit', info: { status: 'rejected', resetsAt: 5, rateLimitType: 'five_hour' } });
    expect(
      toEvents({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 401, error: 'authentication_failed' })[0],
    ).toMatchObject({ kind: 'api_retry', attempt: 2, maxRetries: 10, errorStatus: 401, error: 'authentication_failed' });
  });

  it('drops thinking-token noise and keeps other system messages generic', () => {
    expect(toEvents({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 })).toEqual([]);
    expect(toEvents({ type: 'system', subtype: 'task_started' })[0]).toMatchObject({ kind: 'other', subtype: 'task_started' });
  });

  it('marks subagent messages', () => {
    const [event] = toEvents({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: { content: [{ type: 'text', text: 'inside' }] },
    });
    expect(event).toMatchObject({ parentToolUseId: 'agent-1' });
  });
});

describe('TurnAccumulator', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('keeps init, result and the latest rate-limit status', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'system', subtype: 'init', session_id: 's1' }));
    acc.addLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    acc.addLine(line({ type: 'result', subtype: 'success' }));
    expect(acc.init?.['session_id']).toBe('s1');
    expect(acc.result?.['subtype']).toBe('success');
    expect(acc.rateLimit?.status).toBe('allowed');
    expect(acc.rejectedRateLimit).toBeNull();
  });

  // Real shape (NOTES.md §14): a resumed session first replays a pending task notification as an empty turn.
  const emptyTurn = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', result_index: 0 };
  const realTurn = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    result_index: 1,
    structured_output: { status: 'ok' },
  };

  it('picks the answering result when an empty notification turn comes first', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'system', subtype: 'task_notification', status: 'stopped' }));
    acc.addLine(line(emptyTurn));
    acc.addLine(line(realTurn));
    expect(acc.results).toHaveLength(2);
    expect(acc.result?.['result_index']).toBe(1);
  });

  it('still picks the answering result when an empty turn comes after it', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line(realTurn));
    acc.addLine(line({ ...emptyTurn, result_index: 2 }));
    expect(acc.result?.['result_index']).toBe(1);
  });

  it('prefers an error result over an empty one when there is no structured output', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'result', is_error: true, num_turns: 1, api_error_status: 401 }));
    acc.addLine(line({ ...emptyTurn, result_index: 2 }));
    expect(acc.result?.['api_error_status']).toBe(401);
  });

  it('has no result until one arrives', () => {
    expect(new TurnAccumulator().result).toBeNull();
  });

  it('remembers a rejected rate limit even if a later event says allowed', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 9 } }));
    acc.addLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    expect(acc.rejectedRateLimit?.resetsAt).toBe(9);
  });

  it('tracks Skill tool calls and their outcome, main thread only', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'security-review' } }] } }));
    acc.addLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Skill', input: { skill: 'hello' } }] } }));
    acc.addLine(line({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', id: 'c', name: 'Skill', input: { skill: 'nested' } }] } }));
    acc.addLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'git diff origin/HEAD failed' }] } }));
    expect([...acc.skills.values()]).toEqual([
      { skill: 'security-review', toolUseId: 'a', isError: true, resultText: 'git diff origin/HEAD failed' },
      { skill: 'hello', toolUseId: 'b', isError: null, resultText: null },
    ]);
  });

  it('counts refused structured answers with their reasons and sizes (SPEC.md §3.5), and tool calls by name', () => {
    const acc = new TurnAccumulator();
    const use = (id: string, name: string, input: unknown, parent: string | null = null) =>
      acc.addLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } }));
    const answer = (id: string, isError: boolean, content: unknown, parent: string | null = null) =>
      acc.addLine(JSON.stringify({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } }));
    const missing = "Output does not match required schema: root: must have required property 'changed_files'";

    use('g1', 'Grep', { pattern: 'x' });
    answer('g1', false, 'Details.cshtml:136');
    use('r1', 'Read', { file_path: 'a' });
    use('r2', 'Read', { file_path: 'b' });
    // The real failure (NOTES.md §20.2): later fields written as text inside summary.
    const bad = { status: 'ok', summary: 'Found it.</summary>\n<parameter name="changed_files">[]', tests: { ran: false }, problems: [] };
    use('s1', 'StructuredOutput', bad);
    answer('s1', true, missing);
    use('s2', 'StructuredOutput', { __unparsedToolInput: { raw: '{"status": "ok", "summary": "x' } });
    answer('s2', true, [{ type: 'text', text: '<tool_use_error>InputValidationError: StructuredOutput was called with input that could not be parsed as JSON.\n  You sent …</tool_use_error>' }]);
    use('s3', 'StructuredOutput', bad);
    answer('s3', true, missing);
    // A subagent's calls are not ours; an accepted answer is not a refusal.
    use('sub', 'StructuredOutput', {}, 'task-1');
    answer('sub', true, 'nope', 'task-1');
    use('s4', 'StructuredOutput', { status: 'ok', summary: 'Test minimal call.', changed_files: [], tests: { ran: false }, problems: [] });
    answer('s4', false, 'Structured output provided successfully');

    expect(acc.answerRejections).toEqual({
      count: 3,
      reasons: [missing, '<tool_use_error>InputValidationError: StructuredOutput was called with input that could not be parsed as JSON. You sent …</tool_use_error>'],
      largestAttemptChars: JSON.stringify(bad).length,
    });
    expect(acc.toolUses).toEqual({ Grep: 1, Read: 2 });
  });

  it('reports no refusals for a clean turn, and clips a long reason', () => {
    const acc = new TurnAccumulator();
    expect(acc.answerRejections).toEqual({ count: 0, reasons: [], largestAttemptChars: 0 });
    acc.addLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'StructuredOutput', input: {} }] } }));
    acc.addLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's', is_error: true, content: 'y'.repeat(500) }] } }));
    expect(acc.answerRejections.reasons[0]).toHaveLength(300);
    expect(acc.answerRejections.reasons[0]?.endsWith('…')).toBe(true);
  });

  it('keeps the last real assistant usage, ignoring synthetic error messages', () => {
    const acc = new TurnAccumulator();
    acc.addLine(line({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 5 }, content: [] } }));
    acc.addLine(line({ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', usage: { input_tokens: 0 }, content: [] } }));
    expect(acc.lastAssistantUsage).toEqual({ input_tokens: 5 });
    expect(acc.assistantError).toBe('rate_limit');
  });

  it('reports unparseable lines instead of throwing', () => {
    const acc = new TurnAccumulator();
    expect(acc.addLine('not json')).toEqual([{ kind: 'unparsed', line: 'not json' }]);
    expect(acc.unparsed).toEqual(['not json']);
  });
});
