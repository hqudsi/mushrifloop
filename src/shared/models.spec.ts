import { describe, expect, it } from 'vitest';

import {
  AUTO_COMPACT_MEASURED_CLI,
  AUTO_COMPACT_MEASURED_ON,
  FALLBACK_AUTO_COMPACT_THRESHOLD,
  FABLE_5_1_MIN_CLI_VERSION,
  MIN_CLI_VERSION,
  MODELS,
  PICKER_MODELS,
  OPUS_5_5_MIN_CLI_VERSION,
  SONNET_5_5_MIN_CLI_VERSION,
  autoCompactThresholdFor,
  coerceEffort,
  compareVersions,
  defaultEffortFor,
  effortOnModelChange,
  effortsFor,
  getModel,
  isAlias,
  isEffortValid,
  isVersionBelow,
  modelsTooNewFor,
  modelDisplay,
  modelName,
  modelVersionBlock,
  resolvedModelId,
  rolloverThresholdFor,
  servedModelMatches,
  supportsEffort,
} from './models';

/** SPEC.md §8 — the table the UI must not deviate from. */
describe('model → effort validity table (SPEC.md §8)', () => {
  const expected: Record<string, string[]> = {
    'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    opus: ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    sonnet: ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
    'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
    haiku: ['low', 'medium', 'high', 'xhigh', 'max'],
  };

  it('lists exactly the models in the spec, in order', () => {
    expect(MODELS.map((m) => m.id)).toEqual(Object.keys(expected));
  });

  it('does not offer claude-fable-5 (removed: silently served by claude-opus-5)', () => {
    expect(getModel('claude-fable-5')).toBeUndefined();
  });

  it.each(Object.entries(expected))('offers the documented effort levels for %s', (id, efforts) => {
    expect([...effortsFor(id)]).toEqual(efforts);
  });

  it('rejects xhigh on the 4.6 models but allows it on the current ones', () => {
    expect(isEffortValid('claude-opus-4-6', 'xhigh')).toBe(false);
    expect(isEffortValid('claude-sonnet-4-6', 'xhigh')).toBe(false);
    expect(isEffortValid('opus', 'xhigh')).toBe(true);
    expect(isEffortValid('sonnet', 'xhigh')).toBe(true);
  });

  it('gives Haiku effort control since Haiku 5.5 (2026-10-08)', () => {
    expect(supportsEffort('haiku')).toBe(true);
    expect(isEffortValid('haiku', null)).toBe(false);
    expect(isEffortValid('haiku', 'xhigh')).toBe(true);
  });

  it('reports unknown models as having no valid effort', () => {
    expect(effortsFor('not-a-model')).toEqual([]);
    expect(isEffortValid('not-a-model', 'high')).toBe(false);
  });

  it('only marks Fable models as Fable, and requires a minimum CLI version for them', () => {
    const fable = MODELS.filter((m) => m.isFable);
    expect(fable.map((m) => m.id)).toEqual(['claude-fable-5-1']);
    expect(fable[0]?.minCliVersion).toBe(FABLE_5_1_MIN_CLI_VERSION);
  });
});

describe('coerceEffort', () => {
  it('keeps a valid effort', () => {
    expect(coerceEffort('opus', 'xhigh')).toBe('xhigh');
  });

  it('drops an unsupported effort to the model default rather than an illegal pair', () => {
    expect(coerceEffort('claude-opus-4-6', 'xhigh')).toBe('high');
  });

  it('gives haiku stored without an effort its own default, medium', () => {
    expect(coerceEffort('haiku', null)).toBe('medium');
    expect(coerceEffort('claude-haiku-5-5', null)).toBe('medium');
  });

  it('returns null for unknown models', () => {
    expect(coerceEffort('not-a-model', 'high')).toBeNull();
  });

  it('supplies an effort when none was set', () => {
    expect(coerceEffort('sonnet', null)).toBe('high');
  });
});

/** SPEC.md §15 — measured 2026-09-16 on CLI 2.1.273. */
describe('auto-compact thresholds and rollover (SPEC.md §15)', () => {
  it('uses 967,000 for the 1M-context models', () => {
    for (const id of ['claude-fable-5-1', 'opus', 'sonnet', 'haiku', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      expect(autoCompactThresholdFor(id)).toBe(967_000);
      expect(getModel(id)?.contextWindow).toBe(1_000_000);
    }
  });

  it('uses 167,000 for the 200k-context models', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(autoCompactThresholdFor(id)).toBe(167_000);
      expect(getModel(id)?.contextWindow).toBe(200_000);
    }
  });

  it('falls back to 167,000 for a model missing from the table', () => {
    expect(autoCompactThresholdFor('some-future-model')).toBe(FALLBACK_AUTO_COMPACT_THRESHOLD);
  });

  it('computes rollover as a percentage of the auto-compact threshold', () => {
    expect(rolloverThresholdFor('opus', 60)).toBe(580_200);
    expect(rolloverThresholdFor('claude-sonnet-4-6', 60)).toBe(100_200);
  });

  it('always stays below the auto-compact point, which is the entire purpose', () => {
    for (const model of MODELS) {
      for (const percent of [5, 50, 60, 95]) {
        expect(rolloverThresholdFor(model.id, percent)).toBeLessThan(model.autoCompactThreshold);
      }
    }
  });

  it('records which CLI the numbers were measured against, and when', () => {
    // Re-measured 2026-09-22 on 2.1.280 (NOTES.md §39): Opus 5.5 is 1,000,000 / 967,000; nothing else moved.
    expect(AUTO_COMPACT_MEASURED_CLI).toBe('2.1.280');
    expect(AUTO_COMPACT_MEASURED_ON).toBe('2026-09-22');
    expect(autoCompactThresholdFor('claude-opus-5-5')).toBe(967_000);
  });
});

describe('servedModelMatches (SPEC.md §8)', () => {
  it('accepts what each alias resolved to on CLI 2.1.273', () => {
    expect(servedModelMatches('opus', 'claude-opus-5')).toBe(true);
    expect(servedModelMatches('opus', 'claude-opus-5[1m]')).toBe(true);
    expect(servedModelMatches('sonnet', 'claude-sonnet-5')).toBe(true);
    expect(servedModelMatches('haiku', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(servedModelMatches('haiku', 'claude-haiku-4-5')).toBe(true);
  });

  it('accepts full ids served as themselves', () => {
    expect(servedModelMatches('claude-fable-5-1', 'claude-fable-5-1')).toBe(true);
    expect(servedModelMatches('claude-opus-4-8', 'claude-opus-4-8')).toBe(true);
  });

  it('flags a substitution', () => {
    expect(servedModelMatches('claude-fable-5-1', 'claude-opus-5')).toBe(false);
    expect(servedModelMatches('sonnet', 'claude-opus-5')).toBe(false);
    // A prefix is not enough on its own: 4-6 must not match 4-65 or similar.
    expect(servedModelMatches('claude-opus-4-6', 'claude-opus-4-65')).toBe(false);
  });

  it('compares unknown ids exactly', () => {
    expect(servedModelMatches('claude-fable-5', 'claude-opus-5')).toBe(false);
    expect(servedModelMatches('some-model', 'some-model')).toBe(true);
  });
});

describe('version comparison', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('2.1.273', '2.1.251')).toBeGreaterThan(0);
    expect(compareVersions('2.1.251', '2.1.251')).toBe(0);
  });

  it("flags versions below the app's own minimum", () => {
    expect(isVersionBelow('2.1.220', MIN_CLI_VERSION)).toBe(true);
    expect(isVersionBelow('2.1.251', MIN_CLI_VERSION)).toBe(false);
    expect(isVersionBelow('2.1.273', MIN_CLI_VERSION)).toBe(false);
  });

  it('does not call an unknown version too old', () => {
    expect(isVersionBelow(null, MIN_CLI_VERSION)).toBe(false);
  });
});

/** SPEC.md §8 (decided 2026-09-17): the check behind the dialog, Settings and every turn spawn. */
describe('modelVersionBlock', () => {
  it('blocks Fable below its minimum and names both versions', () => {
    expect(FABLE_5_1_MIN_CLI_VERSION).toBe('2.1.257');
    expect(modelVersionBlock('claude-fable-5-1', '2.1.220')).toBe('Fable 5.1 requires Claude Code 2.1.257 or newer; this machine has 2.1.220.');
    // Between the API's old figure and the docs' one: blocked since 2026-09-26 (SPEC.md §3.2).
    expect(modelVersionBlock('claude-fable-5-1', '2.1.251')).toBe('Fable 5.1 requires Claude Code 2.1.257 or newer; this machine has 2.1.251.');
    expect(modelVersionBlock('claude-fable-5-1', '2.1.257')).toBeNull();
    expect(modelVersionBlock('claude-fable-5-1', '2.1.273')).toBeNull();
  });

  it('lists every model an installed version is too old for (SPEC.md §3.3)', () => {
    expect(modelsTooNewFor('2.1.251')).toEqual([
      { label: 'Fable 5.1', minimum: '2.1.257' },
      { label: 'Opus 5.5', minimum: '2.1.280' },
      { label: 'Sonnet 5.5', minimum: '2.1.284' },
      { label: 'Haiku 5.5', minimum: '2.1.293' },
    ]);
    expect(modelsTooNewFor('2.1.273')).toEqual([
      { label: 'Opus 5.5', minimum: '2.1.280' },
      { label: 'Sonnet 5.5', minimum: '2.1.284' },
      { label: 'Haiku 5.5', minimum: '2.1.293' },
    ]);
    expect(modelsTooNewFor('2.1.280')).toEqual([
      { label: 'Sonnet 5.5', minimum: '2.1.284' },
      { label: 'Haiku 5.5', minimum: '2.1.293' },
    ]);
    expect(modelsTooNewFor('2.1.291')).toEqual([{ label: 'Haiku 5.5', minimum: '2.1.293' }]);
    expect(modelsTooNewFor('2.1.293')).toEqual([]);
  });

  it('treats an unreadable version as too old for a model with a minimum', () => {
    expect(modelVersionBlock('claude-fable-5-1', null, 'spawn ENOENT')).toBe(
      'Fable 5.1 requires Claude Code 2.1.257 or newer, and the installed version could not be read (spawn ENOENT).',
    );
    expect(modelVersionBlock('claude-fable-5-1', null)).toContain('could not be read.');
  });

  it('never blocks models without a minimum, or unknown ids', () => {
    for (const model of MODELS.filter((m) => !m.minCliVersion)) {
      expect(modelVersionBlock(model.id, '1.0.0')).toBeNull();
      expect(modelVersionBlock(model.id, null)).toBeNull();
    }
    expect(modelVersionBlock('not-a-model', null)).toBeNull();
  });
});


/**
 * Opus 5.5 and the alias table (SPEC.md §8, 2026-09-22). From CLI 2.1.280 `opus` means Opus 5.5; before it,
 * Opus 5. Verified on 2.1.280 with the CLI's own model list (`opus[1m]` -> `claude-opus-5-5[1m]`).
 */
describe('Opus 5.5 (SPEC.md §8)', () => {
  it('is offered by its full id, with every effort level and its own default of medium', () => {
    const spec = getModel('claude-opus-5-5');
    expect(spec?.label).toBe('Opus 5.5');
    expect([...effortsFor('claude-opus-5-5')]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(defaultEffortFor('claude-opus-5-5')).toBe('medium');
    expect(defaultEffortFor('claude-opus-4-8')).toBe('high');
    expect(defaultEffortFor('claude-made-up')).toBeNull();
  });

  it('needs Claude Code 2.1.280, enforced by the same check as Fable', () => {
    expect(getModel('claude-opus-5-5')?.minCliVersion).toBe(OPUS_5_5_MIN_CLI_VERSION);
    expect(OPUS_5_5_MIN_CLI_VERSION).toBe('2.1.280');
    expect(modelVersionBlock('claude-opus-5-5', '2.1.273')).toBe('Opus 5.5 requires Claude Code 2.1.280 or newer; this machine has 2.1.273.');
    expect(modelVersionBlock('claude-opus-5-5', '2.1.280')).toBeNull();
    expect(modelVersionBlock('claude-opus-5-5', null)).toContain('could not be read');
  });

  it('does not put a minimum on the `opus` alias: below 2.1.280 it simply means Opus 5', () => {
    expect(modelVersionBlock('opus', '2.1.251')).toBeNull();
  });

  it('keeps Opus 5 selectable by its full id', () => {
    expect(getModel('claude-opus-5')?.label).toBe('Opus 5');
    expect(getModel('claude-opus-5')?.isAlias).toBeUndefined();
  });

  it('starts the effort picker at medium when the user switches to it, instead of carrying high over', () => {
    expect(effortOnModelChange('claude-opus-5-5', 'high')).toBe('medium');
    expect(effortOnModelChange('claude-opus-5-5', 'xhigh')).toBe('medium');
    // `opus` follows what it resolves to.
    expect(effortOnModelChange('opus', 'high', '2.1.280')).toBe('medium');
    expect(effortOnModelChange('opus', 'high', '2.1.273')).toBe('high');
    // Every other model keeps a valid effort, as before.
    expect(effortOnModelChange('claude-opus-4-8', 'xhigh')).toBe('xhigh');
    expect(effortOnModelChange('claude-opus-4-6', 'xhigh')).toBe('high');
    expect(effortOnModelChange('claude-made-up', 'high')).toBeNull();
  });

  it('coerces a missing effort to its own default', () => {
    expect(coerceEffort('claude-opus-5-5', null)).toBe('medium');
    expect(coerceEffort('claude-opus-5-5', 'high')).toBe('high');
  });
});

describe('alias resolution by CLI version (SPEC.md §8)', () => {
  it('resolves opus to Opus 5 before 2.1.280 and to Opus 5.5 from it', () => {
    expect(resolvedModelId('opus', '2.1.251')).toBe('claude-opus-5');
    expect(resolvedModelId('opus', '2.1.279')).toBe('claude-opus-5');
    expect(resolvedModelId('opus', '2.1.280')).toBe('claude-opus-5-5');
    expect(resolvedModelId('opus', '2.2.0')).toBe('claude-opus-5-5');
  });

  it('resolves an unknown version as the newest CLI would', () => {
    expect(resolvedModelId('opus', null)).toBe('claude-opus-5-5');
  });

  it('leaves full ids alone, and resolves sonnet and haiku', () => {
    expect(resolvedModelId('claude-opus-5', '2.1.280')).toBe('claude-opus-5');
    expect(resolvedModelId('sonnet', '2.1.280')).toBe('claude-sonnet-5');
    expect(resolvedModelId('haiku', '2.1.280')).toBe('claude-haiku-4-5');
    expect(isAlias('opus') && isAlias('sonnet') && isAlias('haiku')).toBe(true);
    expect(isAlias('claude-opus-5-5')).toBe(false);
  });

  it('sonnet means Sonnet 5.5 from 2.1.284, as a real call on 2.1.291 showed (NOTES.md §58.8)', () => {
    expect(SONNET_5_5_MIN_CLI_VERSION).toBe('2.1.284');
    expect(resolvedModelId('sonnet', '2.1.283')).toBe('claude-sonnet-5');
    expect(resolvedModelId('sonnet', '2.1.284')).toBe('claude-sonnet-5-5');
    expect(resolvedModelId('sonnet', '2.1.291')).toBe('claude-sonnet-5-5');
    expect(resolvedModelId('sonnet', null)).toBe('claude-sonnet-5-5');
    expect(servedModelMatches('sonnet', 'claude-sonnet-5-5', '2.1.291')).toBe(true);
    expect(servedModelMatches('sonnet', 'claude-sonnet-5', '2.1.291')).toBe(false);
    expect(modelVersionBlock('claude-sonnet-5-5', '2.1.280')).toBe('Sonnet 5.5 requires Claude Code 2.1.284 or newer; this machine has 2.1.280.');
    expect(modelVersionBlock('claude-sonnet-5-5', '2.1.291')).toBeNull();
  });

  it('Sonnet 5.5 starts at medium, its own default, and sonnet does where it resolves to it', () => {
    expect(defaultEffortFor('claude-sonnet-5-5')).toBe('medium');
    expect(defaultEffortFor('sonnet', '2.1.291')).toBe('medium');
    expect(defaultEffortFor('sonnet', '2.1.280')).toBe('high');
    expect(effortOnModelChange('claude-sonnet-5-5', 'high')).toBe('medium');
  });

  it('gives an alias the auto-compact threshold of what it resolves to', () => {
    expect(autoCompactThresholdFor('opus', '2.1.280')).toBe(autoCompactThresholdFor('claude-opus-5-5'));
    expect(autoCompactThresholdFor('haiku', '2.1.280')).toBe(167_000);
  });
});

describe('servedModelMatches with the CLI that ran the turn (SPEC.md §8)', () => {
  it('raises no false mismatch for opus served as Opus 5.5 on 2.1.280', () => {
    expect(servedModelMatches('opus', 'claude-opus-5-5', '2.1.280')).toBe(true);
    expect(servedModelMatches('opus', 'claude-opus-5-5[1m]', '2.1.280')).toBe(true);
  });

  it('knows opus meant Opus 5 on older CLIs', () => {
    expect(servedModelMatches('opus', 'claude-opus-5', '2.1.273')).toBe(true);
    expect(servedModelMatches('opus', 'claude-opus-5-5', '2.1.273')).toBe(false);
    expect(servedModelMatches('opus', 'claude-opus-5', '2.1.280')).toBe(false);
  });

  it('accepts either row of an alias when the version is unknown, rather than guess', () => {
    expect(servedModelMatches('opus', 'claude-opus-5', null)).toBe(true);
    expect(servedModelMatches('opus', 'claude-opus-5-5', null)).toBe(true);
    expect(servedModelMatches('opus', 'claude-opus-4-8', null)).toBe(false);
  });

  it('never treats Opus 5.5 as Opus 5, or the reverse -- a prefix is not a match', () => {
    // The check before 2026-09-22 accepted any `${expected}-` prefix, which made this a silent match.
    expect(servedModelMatches('claude-opus-5', 'claude-opus-5-5')).toBe(false);
    expect(servedModelMatches('claude-opus-5-5', 'claude-opus-5')).toBe(false);
  });

  it('surfaces a safety-classifier fallback as a mismatch', () => {
    // Opus 5.5 re-runs cybersecurity-flagged requests on Opus 4.8, and biology-flagged ones on Opus 5.
    expect(servedModelMatches('claude-opus-5-5', 'claude-opus-4-8', '2.1.280')).toBe(false);
    expect(servedModelMatches('claude-opus-5-5', 'claude-opus-5', '2.1.280')).toBe(false);
    expect(servedModelMatches('opus', 'claude-opus-4-8', '2.1.280')).toBe(false);
  });

  it('still ignores a date suffix', () => {
    expect(servedModelMatches('haiku', 'claude-haiku-4-5-20251001', '2.1.280')).toBe(true);
  });
});

describe('model names: a choice as chosen, a turn as it ran (SPEC.md §8)', () => {
  it('lists the aliases first in the pickers, then every full id in catalogue order', () => {
    expect(PICKER_MODELS.map((m) => m.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      ...MODELS.filter((m) => !m.isAlias).map((m) => m.id),
    ]);
    expect(new Set(PICKER_MODELS)).toEqual(new Set(MODELS));
  });
  it('names concrete models, including served ids with markers and dates', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelName('claude-fable-5')).toBe('Fable 5');
    expect(modelName('something-new')).toBe('something-new');
  });

  it('shows an alias as Claude Code writes it, with what it runs now in the note', () => {
    const d = modelDisplay('opus', '2.1.280');
    expect(d).toMatchObject({ name: 'Opus 5.5', alias: 'opus', text: 'opus' });
    expect(d.note).toContain('runs Opus 5.5 on Claude Code 2.1.280');
    expect(d.note).toContain('full model name');
    expect(modelDisplay('opus', '2.1.273')).toMatchObject({ name: 'Opus 5', text: 'opus' });
    expect(modelDisplay('opus', '2.1.273').note).toContain('runs Opus 5 on Claude Code 2.1.273');
    expect(modelDisplay('haiku', '2.1.280')).toMatchObject({ name: 'Haiku 4.5', text: 'haiku' });
    expect(modelDisplay('sonnet', '2.1.280')).toMatchObject({ name: 'Sonnet 5', text: 'sonnet' });
  });

  it('shows a full id as itself, with no alias note', () => {
    expect(modelDisplay('claude-opus-5', '2.1.280')).toEqual({ name: 'Opus 5', alias: null, text: 'Opus 5', note: null });
  });
});
