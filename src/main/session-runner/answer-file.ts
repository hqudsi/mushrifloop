/**
 * A turn whose answer is a file the agent wrote (SPEC.md §15): the Executor's handoff summary. The file is
 * held to its schema exactly as a structured answer is — strict, failing closed — and a missing, unreadable
 * or refused file fails the turn as `schema_invalid`, so the caller's refused-answer path takes over.
 */

import * as fs from 'node:fs';

import { formatIssues, type SchemaKind, type SchemaRegistry } from '../schema-validator';
import type { TurnOutcome } from './types';

export function takeAnswerFile<T>(
  outcome: TurnOutcome<T>,
  file: { path: string; schema: SchemaKind },
  schemas: Pick<SchemaRegistry, 'validate'>,
): TurnOutcome<T> {
  if (!outcome.ok) return outcome;
  const fail = (message: string, rawText: string, issues = [{ path: '', message }]): TurnOutcome<T> => {
    const { output: _ignored, ...rest } = outcome;
    return { ...rest, ok: false, error: { kind: 'schema_invalid', message, rawText, validationIssues: issues } };
  };
  let text: string;
  try {
    text = fs.readFileSync(file.path, 'utf8').replace(/^﻿/, '');
  } catch {
    return fail(`The ${file.schema} file was not written: ${file.path}`, JSON.stringify(outcome.output, null, 2));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return fail(`The ${file.schema} file is not valid JSON (${err instanceof Error ? err.message : String(err)}): ${file.path}`, text);
  }
  const checked = schemas.validate<T>(file.schema, value);
  if (!checked.ok) {
    return fail(`The ${file.schema} file does not match ${file.schema}: ${formatIssues(checked.issues)}`, text, checked.issues);
  }
  return { ...outcome, output: checked.value };
}
