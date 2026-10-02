/**
 * Validation of agent output against schemas/*.schema.json (SPEC.md §4, CLAUDE.md).
 *
 * ajv in strict mode, failing closed: if a schema does not compile, loadSchemas() throws and the app
 * must not start — a schema we cannot enforce is worse than no app. Validation failures return the
 * ajv instance path of every problem, so callers can report exactly what was wrong (SPEC.md §3.5).
 *
 * On top of the JSON schemas, a few *conditional* requirements that the schema files state only in
 * their descriptions ("Required when status=continue") are enforced here, because the orchestrator's
 * control flow depends on them and nothing else may drive it.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ValidationIssue } from '../shared/task-model';

export type { ValidationIssue };

export type SchemaKind = 'planner-output' | 'executor-output' | 'handoff-summary';

export const SCHEMA_KINDS: readonly SchemaKind[] = ['planner-output', 'executor-output', 'handoff-summary'];

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface LoadedSchema {
  kind: SchemaKind;
  file: string;
  /** The schema as parsed from disk — this exact object is also what `--json-schema` receives. */
  schema: Record<string, unknown>;
  /** Minified JSON for `--json-schema` (inline only; the CLI rejects file paths). */
  inline: string;
  validate: ValidateFunction;
}

export class SchemaLoadError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'SchemaLoadError';
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => {
    // Point at the offending property itself where ajv reports it on the parent.
    let pointer = e.instancePath;
    if (e.keyword === 'additionalProperties') pointer += `/${String(e.params['additionalProperty'])}`;
    if (e.keyword === 'required') pointer += `/${String(e.params['missingProperty'])}`;
    return { path: pointer, message: e.message ?? e.keyword };
  });
}

/** Documented-but-conditional requirements from the schema descriptions. */
function conditionalIssues(kind: SchemaKind, value: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const requireNonEmpty = (field: string, reason: string) => {
    const v = value[field];
    if (typeof v !== 'string' || v.trim() === '') {
      issues.push({ path: `/${field}`, message: `must be a non-empty string ${reason}` });
    }
  };
  const status = value['status'];
  if (kind === 'planner-output') {
    if (status === 'continue') requireNonEmpty('next_instruction', 'when status is "continue"');
    if (status === 'done') requireNonEmpty('final_report', 'when status is "done"');
    if (status === 'blocked' || status === 'needs_user' || status === 'plan_ready') {
      requireNonEmpty('question', `when status is "${String(status)}"`);
    }
  }
  if (kind === 'executor-output' && status === 'needs_input') {
    requireNonEmpty('question', 'when status is "needs_input"');
  }
  return issues;
}

export class SchemaRegistry {
  private constructor(private readonly schemas: ReadonlyMap<SchemaKind, LoadedSchema>) {}

  /**
   * Load and compile every schema. Throws SchemaLoadError on any problem — callers treat that as a
   * startup failure, never as a warning.
   */
  static load(schemaDir: string): SchemaRegistry {
    const ajv = new Ajv({ strict: true, allErrors: true });
    const loaded = new Map<SchemaKind, LoadedSchema>();
    for (const kind of SCHEMA_KINDS) {
      const file = path.join(schemaDir, `${kind}.schema.json`);
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        throw new SchemaLoadError(
          `Cannot read schema ${file}: ${err instanceof Error ? err.message : String(err)}`,
          file,
        );
      }
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(schema);
      } catch (err) {
        throw new SchemaLoadError(
          `Schema ${file} does not compile in strict mode: ${err instanceof Error ? err.message : String(err)}`,
          file,
        );
      }
      loaded.set(kind, { kind, file, schema, inline: JSON.stringify(schema), validate });
    }
    return new SchemaRegistry(loaded);
  }

  get(kind: SchemaKind): LoadedSchema {
    const schema = this.schemas.get(kind);
    if (!schema) throw new SchemaLoadError(`Schema "${kind}" was not loaded`, kind);
    return schema;
  }

  validate<T = unknown>(kind: SchemaKind, value: unknown): ValidationResult<T> {
    const schema = this.get(kind);
    if (!schema.validate(value)) return { ok: false, issues: formatAjvErrors(schema.validate.errors) };
    const extra = conditionalIssues(kind, value as Record<string, unknown>);
    if (extra.length > 0) return { ok: false, issues: extra };
    return { ok: true, value: value as T };
  }
}

/** One-line rendering for logs and error messages: `/tests/ran: must be boolean; /extra: …`. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
}
