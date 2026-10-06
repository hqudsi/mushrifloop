/**
 * The Executor's handoff by file (SPEC.md §15, 2026-10-06): the file is held to `handoff-summary` exactly as a
 * structured answer is, and anything wrong with it fails the turn as `schema_invalid`, so the orchestrator's
 * shorter attempt and degraded path take over.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SchemaRegistry } = await import('../schema-validator');
const { takeAnswerFile } = await import('./answer-file');

import type { TurnOutcome } from './types';

const schemas = SchemaRegistry.load(path.resolve(__dirname, '..', '..', '..', 'schemas'));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SUMMARY = {
  task_restatement: 'Add the returns feature.',
  done_so_far: ['Added src/services/return-service.ts'],
  remaining: ['Wire the route'],
  decisions: [],
  constraints: [],
  open_problems: [],
  key_files: ['src/services/return-service.ts'],
};

const answered = { status: 'ok', summary: 'Handoff written', changed_files: [], tests: { ran: false }, problems: [] };

function okTurn(): TurnOutcome {
  return { ok: true, output: answered, turnId: 'executor-1', agent: 'executor', sessionId: 's', resumed: true } as unknown as TurnOutcome;
}

function fileWith(text: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-file-'));
  dirs.push(dir);
  const file = path.join(dir, 'handoff', 'executor-1.json');
  if (text !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return file;
}

const take = (file: string, outcome = okTurn()) => takeAnswerFile(outcome, { path: file, schema: 'handoff-summary' }, schemas);

describe('a turn whose answer is a file', () => {
  it('a valid summary becomes the turn’s output', () => {
    const result = take(fileWith(JSON.stringify(SUMMARY, null, 2)));
    expect(result).toMatchObject({ ok: true, output: SUMMARY, turnId: 'executor-1' });
  });

  it('reads a file saved with a byte-order mark', () => {
    expect(take(fileWith(`\uFEFF${JSON.stringify(SUMMARY)}`)).ok).toBe(true);
  });

  it('no file is a refused answer, not a crash', () => {
    const result = take(fileWith(null));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
      expect(result.error.message).toContain('was not written');
      expect('output' in result).toBe(false);
    }
  });

  it('a file that is not JSON is refused with the parser’s words and the text kept', () => {
    const result = take(fileWith('{"task_restatement": "C:\\Users"'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
      expect(result.error.message).toContain('not valid JSON');
      expect(result.error.rawText).toContain('task_restatement');
    }
  });

  it('a summary the schema refuses is refused, with every issue', () => {
    const result = take(fileWith(JSON.stringify({ ...SUMMARY, done_so_far: 'One paragraph instead of a list.' })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
      expect(result.error.validationIssues?.some((i) => i.path === '/done_so_far')).toBe(true);
    }
  });

  it('a turn that already failed is left as it is, file or not', () => {
    const failed = { ok: false, error: { kind: 'process_failed', message: 'died', rawText: '' } } as unknown as TurnOutcome;
    expect(take(fileWith(JSON.stringify(SUMMARY)), failed)).toBe(failed);
  });
});
