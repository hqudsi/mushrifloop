/**
 * A stand-in for `claude -p` used by run.spec.ts. Run as: node fake-claude.mjs <cli args…>
 *
 * FAKE_CLAUDE_SCENARIO picks the behaviour; FAKE_CLAUDE_OUT is a folder where it records what it
 * received (args.json, stdin.txt) and the pid of any child it starts (child.pid).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
const out = process.env.FAKE_CLAUDE_OUT;
const args = process.argv.slice(2);
const sessionIdx = args.findIndex((a) => a === '--session-id' || a === '--resume');
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : 'no-session';

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
if (out) {
  writeFileSync(join(out, 'args.json'), JSON.stringify(args));
  writeFileSync(join(out, 'stdin.txt'), stdin);
}

const init = {
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'claude-opus-5[1m]',
  tools: ['StructuredOutput'],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  cwd: process.cwd(),
  claude_code_version: '2.1.273',
};

const plannerOutput = {
  status: 'continue',
  reasoning_summary: 'First step.',
  next_instruction: 'List the files in the repository root and report them.',
};

function result(structured) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    session_id: sessionId,
    result: JSON.stringify(structured),
    structured_output: structured,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 9000,
      output_tokens: 80,
      iterations: [{ input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 4800, output_tokens: 40 }],
    },
    modelUsage: {
      'claude-opus-5[1m]': {
        inputTokens: 10,
        outputTokens: 80,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 500,
        contextWindow: 1000000,
        canonicalModel: 'claude-opus-5',
      },
    },
    permission_denials: [],
    terminal_reason: 'completed',
  };
}

function startSleeper() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  if (out) writeFileSync(join(out, 'child.pid'), String(child.pid));
}

switch (scenario) {
  case 'success': {
    process.stderr.write('a harmless warning\n');
    emit(init);
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1789566000, rateLimitType: 'five_hour' } });
    emit({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: plannerOutput }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Structured output provided successfully' }] } });
    emit(result(plannerOutput));
    process.exit(0);
    break;
  }
  case 'chunked': {
    // The same stream, delivered in 7-byte pieces with pauses, lines split mid-JSON.
    const text = [init, result(plannerOutput)].map((o) => JSON.stringify(o) + '\r\n').join('');
    for (let i = 0; i < text.length; i += 7) {
      process.stdout.write(text.slice(i, i + 7));
      if (i % 70 === 0) await sleep(2);
    }
    process.exit(0);
    break;
  }
  case 'invalid-output': {
    emit(init);
    emit(result({ status: 'continue', reasoning_summary: 'Forgot the instruction.' }));
    process.exit(0);
    break;
  }
  case 'sleep': {
    startSleeper();
    emit(init);
    await sleep(120000);
    break;
  }
  case 'rate-limit': {
    startSleeper();
    emit(init);
    emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1789218600, rateLimitType: 'five_hour', overageStatus: 'rejected' },
    });
    // A real CLI would now spend ~3 minutes retrying.
    await sleep(120000);
    break;
  }
  case 'orphan': {
    // Like the Bash tool leaving grep behind: start a detached long-runner, then finish normally.
    // Wait first, so the runner has certainly put this process into its job.
    await sleep(1500);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    if (out) writeFileSync(join(out, 'child.pid'), String(child.pid));
    emit(init);
    emit(result(plannerOutput));
    process.exit(0);
    break;
  }
  case 'slow': {
    emit(init);
    await sleep(1200);
    emit(result(plannerOutput));
    process.exit(0);
    break;
  }
  case 'probe': {
    // `/usage` with the executor's flags: init with skills, a synthetic reply, a free result.
    emit({
      ...init,
      session_id: 'probe-session',
      skills: ['deep-research', 'plugin:tidy'],
      slash_commands: ['deep-research', 'plugin:tidy', 'security-review', 'clear'],
    });
    emit({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Current session: 5% used' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, session_id: 'probe-session', total_cost_usd: 0, modelUsage: {} });
    process.exit(0);
    break;
  }
  case 'probe-no-init': {
    process.stderr.write('Error: something is wrong with the settings\n');
    process.exit(1);
    break;
  }
  case 'plain': {
    // A plain session (SPEC.md §19.7): no structured output, the final text is the answer.
    emit(init);
    emit({ type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'All done.' }] } });
    const { structured_output: _unused, ...rest } = result(plannerOutput);
    emit({ ...rest, result: 'All done.' });
    process.exit(0);
    break;
  }
  case 'no-result': {
    emit(init);
    process.stderr.write('something went badly wrong\n');
    process.exit(3);
    break;
  }
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(9);
}
