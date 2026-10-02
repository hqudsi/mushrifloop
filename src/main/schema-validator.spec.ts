import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../shared/app-config';
import { SCHEMA_KINDS, SchemaLoadError, SchemaRegistry, formatIssues } from './schema-validator';

const SCHEMAS = path.resolve(__dirname, '..', '..', 'schemas');

describe('SchemaRegistry with the real schemas/', () => {
  const registry = SchemaRegistry.load(SCHEMAS);

  it('compiles all three schemas in strict mode', () => {
    for (const kind of SCHEMA_KINDS) {
      expect(registry.get(kind).validate).toBeTypeOf('function');
      // What goes on the command line must be the same schema, as a single line of JSON.
      expect(JSON.parse(registry.get(kind).inline)).toEqual(registry.get(kind).schema);
      expect(registry.get(kind).inline).not.toContain('\n');
    }
  });

  it('accepts a valid planner answer', () => {
    const result = registry.validate('planner-output', {
      status: 'continue',
      reasoning_summary: 'Start by inspecting.',
      next_instruction: 'List the files and report.',
      use_skills: ['security-review'],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a valid executor answer', () => {
    const result = registry.validate('executor-output', {
      status: 'ok',
      summary: 'Created hello.js and ran it.',
      changed_files: [{ path: 'hello.js', change: 'added' }],
      tests: { ran: true, passed: 1, failed: 0 },
      problems: [],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a valid handoff summary', () => {
    const result = registry.validate('handoff-summary', {
      task_restatement: 'Add a README.',
      done_so_far: [],
      remaining: ['write README'],
      decisions: [],
      constraints: [],
      open_problems: [],
      key_files: [],
    });
    expect(result.ok).toBe(true);
  });

  it('reports the path of every problem', () => {
    const result = registry.validate('executor-output', {
      status: 'maybe',
      summary: 'x',
      changed_files: [{ path: 'a.js', change: 'renamed' }],
      tests: { ran: 'yes' },
      problems: [],
      surprise: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['/status', '/changed_files/0/change', '/tests/ran', '/surprise']));
    expect(formatIssues(result.issues)).toContain('/tests/ran: must be boolean');
  });

  it('reports a missing required property at its own path', () => {
    const result = registry.validate('planner-output', { status: 'done' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toContain('/reasoning_summary');
  });

  it.each([
    ['continue', 'next_instruction'],
    ['done', 'final_report'],
    ['blocked', 'question'],
    ['needs_user', 'question'],
    ['plan_ready', 'question'],
  ])('enforces the documented field for planner status %s', (status, field) => {
    const result = registry.validate('planner-output', { status, reasoning_summary: 'why' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ path: `/${field}`, message: expect.stringContaining(`"${status}"`) }]);
  });

  it('treats a blank conditional field as missing', () => {
    const result = registry.validate('planner-output', {
      status: 'continue',
      reasoning_summary: 'why',
      next_instruction: '   ',
    });
    expect(result.ok).toBe(false);
  });

  it('requires a question when the executor needs input', () => {
    const base = { summary: 's', changed_files: [], tests: { ran: false }, problems: [] };
    expect(registry.validate('executor-output', { ...base, status: 'needs_input' }).ok).toBe(false);
    expect(registry.validate('executor-output', { ...base, status: 'needs_input', question: 'Which DB?' }).ok).toBe(true);
  });

  it('rejects things that are not objects', () => {
    for (const value of [null, 'text', 42, []]) {
      expect(registry.validate('planner-output', value).ok).toBe(false);
    }
  });
});

describe('SchemaRegistry fails closed', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function schemaDirWith(overrides: Record<string, string>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-schemas-`));
    for (const kind of SCHEMA_KINDS) {
      const file = `${kind}.schema.json`;
      fs.writeFileSync(path.join(dir, file), overrides[file] ?? fs.readFileSync(path.join(SCHEMAS, file), 'utf8'));
    }
    return dir;
  }

  it('throws when a schema is missing', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-schemas-`));
    expect(() => SchemaRegistry.load(dir)).toThrow(SchemaLoadError);
  });

  it('throws when a schema is not JSON', () => {
    const d = schemaDirWith({ 'planner-output.schema.json': '{ nope' });
    expect(() => SchemaRegistry.load(d)).toThrow(/Cannot read schema/);
  });

  it('throws when a schema uses an unknown keyword (strict mode)', () => {
    const d = schemaDirWith({
      'executor-output.schema.json': JSON.stringify({ type: 'object', mustBeLovely: true }),
    });
    expect(() => SchemaRegistry.load(d)).toThrow(/does not compile in strict mode/);
  });

  it('throws when a schema is structurally invalid', () => {
    const d = schemaDirWith({
      'handoff-summary.schema.json': JSON.stringify({ type: 'object', required: 'not-an-array' }),
    });
    expect(() => SchemaRegistry.load(d)).toThrow(SchemaLoadError);
  });
});
