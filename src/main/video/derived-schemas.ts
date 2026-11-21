/**
 * Schemas a Video task uses that are not files in `schemas/` (SPEC.md §21.3, §21.5).
 *
 * The video Planner schema is **generated from the base Planner schema plus one field**, never kept as a
 * hand-written copy (owner, 2026-11-10): a copy would drift the first time the base changes. Coding tasks
 * keep passing the base schema to `--json-schema`, byte for byte. `derived-schemas.spec.ts` pins both.
 */

export const REVISES_STORYBOARD_FIELD = 'revises_storyboard';

export const REVISES_STORYBOARD_DESCRIPTION =
  'true or false. Set true only when this instruction changes the storyboard (storyboard.md and storyboard.json) and nothing else is built yet: ' +
  'the human is then not asked to approve the storyboard before it runs. Leave it out for every other instruction; ' +
  'the first instruction without it is held until the human has approved the storyboard.';

type Schema = Record<string, unknown>;

/** The base Planner schema with `revises_storyboard` added. The input is not changed. */
export function videoPlannerSchema(base: Schema): Schema {
  const properties = base['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('The Planner schema has no "properties" object, so the video Planner schema cannot be derived from it.');
  }
  if (REVISES_STORYBOARD_FIELD in properties) {
    throw new Error(`The Planner schema already has a "${REVISES_STORYBOARD_FIELD}" field; the video Planner schema would no longer be "the base plus one field".`);
  }
  const derived = structuredClone(base);
  derived['title'] = 'VideoPlannerOutput';
  (derived['properties'] as Schema)[REVISES_STORYBOARD_FIELD] = { type: 'boolean', description: REVISES_STORYBOARD_DESCRIPTION };
  return derived;
}

/**
 * The answer of the image check: the code a session read from a PNG. Compared with the code the app wrote,
 * as a validated field (SPEC.md §21.3 step 5).
 */
export const IMAGE_CHECK_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ImageCheck',
  type: 'object',
  additionalProperties: false,
  required: ['seen', 'code'],
  properties: {
    seen: { type: 'boolean', description: 'true when the image opened and you could see its content; false otherwise.' },
    code: { type: 'string', description: 'Plain text: exactly the code shown in the image, nothing else. An empty string when seen is false.' },
    problem: { type: 'string', description: 'Plain text: when seen is false, what happened when you tried to open the image.' },
  },
};
