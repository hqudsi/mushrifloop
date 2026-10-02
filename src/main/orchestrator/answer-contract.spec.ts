/**
 * The schemas and the prose that describes them must agree (NOTES.md §27.6).
 *
 * The handoff failed in 14 of 16 Step C turns because `handoff-summary` declares six fields as arrays
 * while `handoffRequest()` said "Write plain text in each field". The Executor obeyed the prose, wrote a
 * paragraph where a list belongs, and the answer was invalid JSON at that exact field — every time,
 * whatever the project, the model or the length.
 *
 * These tests guard the whole class, not just that one sentence: every non-text field in every schema
 * must say what shape it is, and the prompts that ask for an answer must not contradict it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { SchemaRegistry, SCHEMA_KINDS } = await import('../schema-validator');
const { handoffRequest } = await import('./prompts');

import type { SchemaKind } from '../schema-validator';

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_DIR = path.join(REPO, 'schemas');
const schemas = SchemaRegistry.load(SCHEMA_DIR);
const agentPrompt = (name: string) => fs.readFileSync(path.join(REPO, 'agents', `${name}.md`), 'utf8');

interface Property {
  type?: string;
  description?: string;
}

function properties(kind: SchemaKind): Array<[string, Property]> {
  const schema = schemas.get(kind).schema as { properties?: Record<string, Property> };
  return Object.entries(schema.properties ?? {});
}

/** Fields that are not plain text: the model has to get their shape right, so the shape must be written down. */
function shapedFields(kind: SchemaKind): Array<[string, Property]> {
  return properties(kind).filter(([, p]) => p.type === 'array' || p.type === 'object');
}

describe('every non-text field says what shape it is', () => {
  for (const kind of SCHEMA_KINDS) {
    it(`${kind}`, () => {
      const missing = shapedFields(kind)
        .filter(([, p]) => !p.description || !/\b(LIST|OBJECT)\b/.test(p.description))
        .map(([name]) => name);
      // A new array or object field must describe itself, or the model will guess and write prose.
      expect(missing, `fields in ${kind} whose description does not say LIST or OBJECT`).toEqual([]);
    });
  }
});

describe('the handoff request agrees with the handoff schema', () => {
  const lists = shapedFields('handoff-summary').map(([name]) => name);

  it('there really are list fields to describe', () => {
    expect(lists).toEqual(['done_so_far', 'remaining', 'decisions', 'constraints', 'open_problems', 'key_files']);
  });

  for (const shorter of [false, true]) {
    it(`names every list field and calls it a list (${shorter ? 'shorter retry' : 'first attempt'})`, () => {
      const text = handoffRequest(shorter);
      for (const field of lists) expect(text, `handoffRequest(${shorter}) does not mention ${field}`).toContain(field);
      expect(text).toMatch(/\bLIST\b/);
      // The exact sentence that caused the failure. It must never come back.
      expect(text).not.toMatch(/plain text in each field/i);
    });
  }

  it('shows the expected form once, as an example', () => {
    expect(handoffRequest(false)).toMatch(/"done_so_far":\s*\[/);
  });
});

describe('the agent prompts agree with their schemas', () => {
  it('the executor is told which of its own fields are lists', () => {
    const text = agentPrompt('executor');
    for (const [name] of shapedFields('executor-output')) expect(text, `executor.md does not mention ${name}`).toContain(name);
    expect(text).toMatch(/list of short strings/i);
    expect(text).toMatch(/list of objects/i);
  });

  it('both agents describe the handoff fields as lists, because either can be asked for one', () => {
    for (const agent of ['executor', 'planner']) {
      const text = agentPrompt(agent);
      expect(text, `${agent}.md does not show the handoff list form`).toMatch(/"done_so_far":\s*\[/);
      expect(text, `${agent}.md still calls every handoff field plain text`).not.toMatch(/plain text in each field/i);
    }
  });

  it('the planner is told that use_skills is a list', () => {
    expect(agentPrompt('planner')).toMatch(/use_skills is a \*\*list of skill names\*\*/);
  });
});

describe('answers are capped, with the detail in a file (SPEC.md §4, NOTES.md §27.5)', () => {
  const answer = (over: Record<string, unknown>) => ({ status: 'ok', summary: 'Did it.', changed_files: [], tests: { ran: false }, problems: [], ...over });

  it('the executor is told the limit and where the rest goes', () => {
    const text = agentPrompt('executor');
    expect(text).toContain('summary at most 600 characters, evidence at most 900, and never more than 1,500 together');
    expect(text).toContain('.mushrifloop/evidence/<n>.md');
    expect(text).toContain('do not list it in changed_files');
  });

  it('the planner is told that an evidence path is not a lost report', () => {
    const text = agentPrompt('planner');
    expect(text).toContain('.mushrifloop/evidence/');
    expect(text).toMatch(/not a truncated report/i);
  });

  it('the schema ceiling leaves room above the limit the prompt asks for', () => {
    // The probe (NOTES.md §27.5) showed the Executor overshoots a 600/900 target by up to ~2x even when
    // told, so the ceiling is a guard against runaways, not a second copy of the target.
    const fields = (schemas.get('executor-output').schema as { properties: Record<string, Property & { maxLength?: number }> }).properties;
    expect(fields.summary?.maxLength).toBe(2000);
    expect(fields.evidence?.maxLength).toBe(4000);
    expect(schemas.validate('executor-output', answer({ summary: 'x'.repeat(1900), evidence: 'y'.repeat(3900) })).ok).toBe(true);
  });

  it('rejects a runaway answer of the kind Step C produced', () => {
    // Step C's worst answers: 19,970 characters of summary and 27,649 of evidence.
    const tooLong = schemas.validate('executor-output', answer({ summary: 'x'.repeat(19_970) }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.issues.some((i) => i.path === '/summary')).toBe(true);
    expect(schemas.validate('executor-output', answer({ evidence: 'y'.repeat(27_649) })).ok).toBe(false);
  });

  it('bounds the handoff lists too, so a rollover cannot produce a 12 KB answer', () => {
    const base = {
      task_restatement: 'Keep historical order prices.',
      done_so_far: ['one'],
      remaining: [],
      decisions: [],
      constraints: [],
      open_problems: [],
      key_files: [],
    };
    expect(schemas.validate('handoff-summary', base).ok).toBe(true);
    expect(schemas.validate('handoff-summary', { ...base, done_so_far: ['x'.repeat(501)] }).ok).toBe(false);
    expect(schemas.validate('handoff-summary', { ...base, done_so_far: Array.from({ length: 21 }, () => 'x') }).ok).toBe(false);
    expect(schemas.validate('handoff-summary', { ...base, task_restatement: 'x'.repeat(1501) }).ok).toBe(false);
  });
});

describe('what the schema accepts, in the two shapes the model actually produces', () => {
  const asLists = {
    task_restatement: 'Keep historical order prices. Acceptance: old orders show what the customer paid.',
    done_so_far: ['Fixed the SELECT in src/repositories/order-repository.ts', 'Added a regression test in test/unit/order-service.test.ts'],
    remaining: ['Run the full suite'],
    decisions: ['Read the stored unit_price_cents rather than joining the products table'],
    constraints: ['Do not change the insert path'],
    open_problems: [],
    key_files: ['src/repositories/order-repository.ts'],
  };

  it('accepts the list form the prompt now asks for', () => {
    expect(schemas.validate('handoff-summary', asLists).ok).toBe(true);
  });

  it('rejects the paragraph form the old prompt asked for', () => {
    // This is what the Executor sent in Step C, once its unquoted prose was made parseable at all.
    const asProse = { ...asLists, done_so_far: 'Completed the read-only investigation and then fixed the bug.' };
    const result = schemas.validate('handoff-summary', asProse);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path === '/done_so_far')).toBe(true);
  });
});
