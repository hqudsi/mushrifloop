/**
 * The video Planner schema is the base Planner schema plus exactly one field, generated in code
 * (SPEC.md §21.5, owner 2026-11-10). These tests pin that, and that the base schema coding tasks use is
 * left exactly as it is on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SchemaRegistry } from '../schema-validator';
import { IMAGE_CHECK_SCHEMA, REVISES_STORYBOARD_FIELD, videoPlannerSchema } from './derived-schemas';

const SCHEMAS = path.resolve(__dirname, '..', '..', '..', 'schemas');
const baseText = fs.readFileSync(path.join(SCHEMAS, 'planner-output.schema.json'), 'utf8');
const base = JSON.parse(baseText) as Record<string, unknown> & { properties: Record<string, unknown> };

describe('the video Planner schema', () => {
  it('is the base schema plus revises_storyboard, and nothing else', () => {
    const video = videoPlannerSchema(base) as typeof base;
    const { [REVISES_STORYBOARD_FIELD]: added, ...rest } = video.properties;
    expect(added).toMatchObject({ type: 'boolean' });
    expect(rest).toEqual(base.properties);
    // Everything outside `properties` is the base's, except the title.
    expect({ ...video, properties: undefined, title: undefined }).toEqual({ ...base, properties: undefined, title: undefined });
    expect(video['title']).toBe('VideoPlannerOutput');
    expect(Object.keys(video.properties)).toHaveLength(Object.keys(base.properties).length + 1);
    // Not required: an instruction without it is the normal case.
    expect(video['required']).toEqual(base['required']);
  });

  it('describes the new field, as every non-text field must be', () => {
    const video = videoPlannerSchema(base) as typeof base;
    const field = video.properties[REVISES_STORYBOARD_FIELD] as { description?: string };
    expect(field.description).toMatch(/true or false/);
    expect(field.description).toMatch(/storyboard/);
  });

  it('does not change the object it was derived from', () => {
    const before = JSON.stringify(base);
    videoPlannerSchema(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(REVISES_STORYBOARD_FIELD in base.properties).toBe(false);
  });

  it('refuses a base that already has the field: it would no longer be "the base plus one"', () => {
    const tampered = { ...base, properties: { ...base.properties, [REVISES_STORYBOARD_FIELD]: { type: 'boolean' } } };
    expect(() => videoPlannerSchema(tampered)).toThrow(/already has/);
    expect(() => videoPlannerSchema({ type: 'object' })).toThrow(/no "properties"/);
  });
});

describe('the registry', () => {
  const registry = SchemaRegistry.load(SCHEMAS);

  it('gives coding tasks the base schema exactly as it is on disk', () => {
    expect(registry.get('planner-output').inline).toBe(JSON.stringify(JSON.parse(baseText)));
    expect(registry.get('planner-output').inline).not.toContain(REVISES_STORYBOARD_FIELD);
  });

  it('serves the generated schema to Video tasks', () => {
    expect(JSON.parse(registry.get('planner-output-video').inline)).toEqual(videoPlannerSchema(base));
  });

  it('accepts revises_storyboard only where the schema has it', () => {
    const answer = { status: 'continue', reasoning_summary: 'Fix the storyboard.', next_instruction: 'Change shot 2.', revises_storyboard: true };
    expect(registry.validate('planner-output-video', answer).ok).toBe(true);
    const coding = registry.validate('planner-output', answer);
    expect(coding.ok).toBe(false);
    expect(!coding.ok && coding.issues[0]?.path).toBe(`/${REVISES_STORYBOARD_FIELD}`);
    expect(registry.validate('planner-output-video', { ...answer, revises_storyboard: 'yes' }).ok).toBe(false);
  });

  it('keeps the base schema’s conditional rules for a Video task', () => {
    expect(registry.validate('planner-output-video', { status: 'continue', reasoning_summary: 'x' }).ok).toBe(false);
    expect(registry.validate('planner-output-video', { status: 'done', reasoning_summary: 'x' }).ok).toBe(false);
    expect(registry.validate('planner-output-video', { status: 'done', reasoning_summary: 'x', final_report: 'Rendered.' }).ok).toBe(true);
  });

  it('validates the image check’s answer', () => {
    expect(registry.validate('image-check', { seen: true, code: 'ABCD-2345' }).ok).toBe(true);
    expect(registry.validate('image-check', { seen: false, code: '', problem: 'Not an image.' }).ok).toBe(true);
    expect(registry.validate('image-check', { code: 'ABCD-2345' }).ok).toBe(false);
    expect(registry.validate('image-check', { seen: true, code: 'A', extra: 1 }).ok).toBe(false);
    expect(Object.keys(IMAGE_CHECK_SCHEMA['properties'] as object)).toEqual(['seen', 'code', 'problem']);
  });
});
