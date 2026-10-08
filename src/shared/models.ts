/**
 * Model catalog — SPEC.md §8, and the auto-compact table from SPEC.md §15.
 *
 * Hard-coded on purpose: it is updated with app releases, never discovered at runtime.
 * Do not add or rename models without checking the "Model configuration" docs page (SPEC.md §8).
 *
 * Pure data + pure functions: no Node, no Angular, so both processes use it and Vitest can test it.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Effort sets referenced by the table below (SPEC.md §8). */
const ALL_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];

export interface ModelSpec {
  /** Value passed to `--model`. */
  readonly id: string;
  /** Label shown in the picker. */
  readonly label: string;
  /** Effort levels the UI may offer. Empty = the model has no effort control. */
  readonly efforts: readonly EffortLevel[];
  readonly contextWindow: number;
  /**
   * Measured auto-compact threshold (SPEC.md §15). Claude Code compacts at this point,
   * so our rollover must stay below it.
   */
  readonly autoCompactThreshold: number;
  /**
   * The concrete model this id is served as. For an alias this is its resolution on the newest CLI in
   * {@link ALIAS_RESOLUTION}; use {@link resolvedModelId} with the installed version instead of reading it
   * directly (SPEC.md §8).
   */
  readonly servedAs: string;
  /** `opus`, `sonnet`, `haiku`: what runs depends on the installed CLI (SPEC.md §8). */
  readonly isAlias?: true;
  /** The model's own default effort when it differs from `high` (Opus 5.5: `medium`, SPEC.md §8). */
  readonly defaultEffort?: EffortLevel;
  /** Fable models carry the billing warning and a minimum CLI version (SPEC.md §8). */
  readonly isFable?: true;
  readonly minCliVersion?: string;
}

/**
 * When the auto-compact numbers below were measured, and against which CLI.
 * SPEC.md §15 requires this to travel with the table: the values move between CLI releases
 * (`sonnet` went 967,000 → 1,000,000 between 2.1.220 and 2.1.273).
 */
export const AUTO_COMPACT_MEASURED_ON = '2026-09-22';
export const AUTO_COMPACT_MEASURED_CLI = '2.1.280';

/** Used when a model is not in the table at all (SPEC.md §15). */
export const FALLBACK_AUTO_COMPACT_THRESHOLD = 167_000;

/**
 * The oldest Claude Code the app accepts (first-run setup, Test connection), and the version this build was
 * verified against. Some models need a newer one: see their `minCliVersion` (SPEC.md §3.2, §8).
 */
export const MIN_CLI_VERSION = '2.1.251';
export const VERIFIED_CLI_VERSION = '2.1.293';

/**
 * Fable 5.1 needs this CLI (SPEC.md §3.2, decided 2026-09-26). The "Model configuration" docs give 2.1.257; the
 * API's own 400 on 2026-09-16 had named 2.1.251. Where the two disagree, the higher one is kept.
 */
export const FABLE_5_1_MIN_CLI_VERSION = '2.1.257';

/** Opus 5.5 needs this CLI, and from it `opus` resolves to Opus 5.5 (SPEC.md §8, "Model configuration" docs). */
export const OPUS_5_5_MIN_CLI_VERSION = '2.1.280';

/**
 * Sonnet 5.5 needs this CLI, and from it `sonnet` resolves to Sonnet 5.5 (SPEC.md §8, added 2026-10-06; the
 * "Model configuration" docs and a real call on 2.1.291, NOTES.md §58.8).
 */
export const SONNET_5_5_MIN_CLI_VERSION = '2.1.284';

/**
 * Haiku 5.5 needs this CLI, and from it `haiku` resolves to Haiku 5.5 on the Anthropic API (SPEC.md §8, added
 * 2026-10-08; the CLI's changelog for 2.1.293 and the "Model configuration" docs).
 */
export const HAIKU_5_5_MIN_CLI_VERSION = '2.1.293';

/**
 * What an alias resolves to, by installed CLI version (SPEC.md §8). Each entry applies from `fromCli` until the
 * next one. Verified on 2.1.280 (2026-09-22) with the CLI's own model list and a real call; `opus` meant Opus 5
 * from 2.1.219 until then.
 */
export const ALIAS_RESOLUTION: Readonly<Record<string, readonly { fromCli: string; model: string }[]>> = {
  opus: [
    { fromCli: '0', model: 'claude-opus-5' },
    { fromCli: OPUS_5_5_MIN_CLI_VERSION, model: 'claude-opus-5-5' },
  ],
  sonnet: [
    { fromCli: '0', model: 'claude-sonnet-5' },
    { fromCli: SONNET_5_5_MIN_CLI_VERSION, model: 'claude-sonnet-5-5' },
  ],
  haiku: [
    { fromCli: '0', model: 'claude-haiku-4-5' },
    { fromCli: HAIKU_5_5_MIN_CLI_VERSION, model: 'claude-haiku-5-5' },
  ],
};

/**
 * Auto-compact thresholds of models an alias can still resolve to on an older CLI but that are not offered by
 * their full id (SPEC.md §15): without these an old CLI's `haiku` would take Haiku 5.5's 1M figure.
 */
const RESOLVED_ONLY_AUTO_COMPACT: Readonly<Record<string, number>> = {
  'claude-sonnet-5': 967_000,
  'claude-haiku-4-5': 167_000,
};

/**
 * Display names of concrete models, including ones the CLI may serve that are not offered in the picker
 * (a classifier fallback to Opus 4.8, the old `claude-fable-5`). SPEC.md §8: a turn shows the model that served it.
 */
const MODEL_NAMES: Readonly<Record<string, string>> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-haiku-4-5': 'Haiku 4.5',
};

function model(
  id: string,
  label: string,
  efforts: readonly EffortLevel[],
  contextWindow: number,
  autoCompactThreshold: number,
  servedAs: string = id,
): ModelSpec {
  return { id, label, efforts, contextWindow, autoCompactThreshold, servedAs };
}

/**
 * SPEC.md §8. `claude-fable-5` was removed on 2026-09-16: it is silently served by
 * `claude-opus-5` (verified on CLI 2.1.220 and 2.1.273), so offering it would misrepresent
 * what actually runs. It may return if a future re-check shows it served by itself.
 */
export const MODELS: readonly ModelSpec[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    efforts: ALL_EFFORTS,
    contextWindow: 1_000_000,
    autoCompactThreshold: 967_000,
    servedAs: 'claude-fable-5-1',
    isFable: true,
    minCliVersion: FABLE_5_1_MIN_CLI_VERSION,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    efforts: ALL_EFFORTS,
    contextWindow: 1_000_000,
    autoCompactThreshold: 967_000,
    servedAs: 'claude-opus-5-5',
    defaultEffort: 'medium',
    minCliVersion: OPUS_5_5_MIN_CLI_VERSION,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5',
    efforts: ALL_EFFORTS,
    contextWindow: 1_000_000,
    autoCompactThreshold: 967_000,
    servedAs: 'claude-sonnet-5-5',
    defaultEffort: 'medium',
    minCliVersion: SONNET_5_5_MIN_CLI_VERSION,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Haiku 5.5',
    efforts: ALL_EFFORTS,
    contextWindow: 1_000_000,
    autoCompactThreshold: 967_000,
    servedAs: 'claude-haiku-5-5',
    defaultEffort: 'medium',
    minCliVersion: HAIKU_5_5_MIN_CLI_VERSION,
  },
  { ...model('opus', 'Opus', ALL_EFFORTS, 1_000_000, 967_000, 'claude-opus-5-5'), isAlias: true },
  model('claude-opus-5', 'Opus 5', ALL_EFFORTS, 1_000_000, 967_000),
  { ...model('sonnet', 'Sonnet', ALL_EFFORTS, 1_000_000, 967_000, 'claude-sonnet-5-5'), isAlias: true },
  model('claude-opus-4-8', 'Opus 4.8', ALL_EFFORTS, 1_000_000, 967_000),
  model('claude-opus-4-7', 'Opus 4.7', ALL_EFFORTS, 1_000_000, 967_000),
  model('claude-opus-4-6', 'Opus 4.6', NO_XHIGH, 200_000, 167_000),
  model('claude-sonnet-4-6', 'Sonnet 4.6', NO_XHIGH, 200_000, 167_000),
  // `medium` as its own default: a `haiku` stored without an effort, from before Haiku 5.5, keeps behaving as it did.
  { ...model('haiku', 'Haiku', ALL_EFFORTS, 1_000_000, 967_000, 'claude-haiku-5-5'), isAlias: true, defaultEffort: 'medium' },
];

/**
 * The pickers' order (SPEC.md §8, decided 2026-09-26): the aliases first, as Claude Code names them, then every
 * full id in the catalogue's order.
 */
export const PICKER_MODELS: readonly ModelSpec[] = [...MODELS.filter((m) => m.isAlias), ...MODELS.filter((m) => !m.isAlias)];

export const DEFAULT_PLANNER_MODEL = 'opus';
// SPEC.md §8: medium for both since 2026-10-06 (settings files are offered it as defaults revision 3).
export const DEFAULT_PLANNER_EFFORT: EffortLevel = 'medium';
export const DEFAULT_EXECUTOR_MODEL = 'sonnet';
export const DEFAULT_EXECUTOR_EFFORT: EffortLevel = 'medium';

export function getModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Effort levels valid for a model. Unknown model or a model without effort control → empty. */
export function effortsFor(modelId: string): readonly EffortLevel[] {
  return getModel(modelId)?.efforts ?? [];
}

export function supportsEffort(modelId: string): boolean {
  return effortsFor(modelId).length > 0;
}

export function isEffortValid(modelId: string, effort: EffortLevel | null): boolean {
  const efforts = effortsFor(modelId);
  if (efforts.length === 0) return effort === null;
  return effort !== null && efforts.includes(effort);
}

/**
 * Coerce an effort to something valid for the model: keeps it when valid, drops it to `null`
 * for models with no effort control, otherwise falls back to the model's highest common level.
 */
export function coerceEffort(modelId: string, effort: EffortLevel | null): EffortLevel | null {
  const efforts = effortsFor(modelId);
  if (efforts.length === 0) return null;
  if (effort !== null && efforts.includes(effort)) return effort;
  const own = getModel(modelId)?.defaultEffort;
  if (own && efforts.includes(own)) return own;
  return efforts.includes('high') ? 'high' : (efforts[efforts.length - 1] ?? null);
}

/**
 * The effort to show when the user switches to `modelId` (SPEC.md §8). A model whose own default is not
 * `high` — Opus 5.5, and `opus` where it resolves to Opus 5.5 — starts at that default rather than
 * silently carrying `high` over; every other model keeps the current effort when it is valid.
 */
export function effortOnModelChange(modelId: string, current: EffortLevel | null, cliVersion: string | null = null): EffortLevel | null {
  const own = defaultEffortFor(modelId, cliVersion);
  if (own !== null && own !== 'high') return own;
  return coerceEffort(modelId, current);
}

/** The model's own default effort, resolving an alias on the installed CLI. Null for no effort control. */
export function defaultEffortFor(modelId: string, cliVersion: string | null = null): EffortLevel | null {
  const spec = getModel(resolvedModelId(modelId, cliVersion)) ?? getModel(modelId);
  if (!spec || spec.efforts.length === 0) return null;
  return spec.defaultEffort ?? 'high';
}

// ---------------------------------------------------------------------------
// Aliases and versions (SPEC.md §8)
// ---------------------------------------------------------------------------

export function isAlias(modelId: string): boolean {
  return getModel(modelId)?.isAlias === true || modelId in ALIAS_RESOLUTION;
}

/** Strip `[1m]` and a date suffix: `claude-haiku-4-5-20251001[1m]` → `claude-haiku-4-5`. */
export function baseModelId(served: string): string {
  return served.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * The concrete model an id runs as on `cliVersion`. A full id is itself; an alias follows
 * {@link ALIAS_RESOLUTION}. An unknown version resolves an alias as the newest CLI would.
 */
export function resolvedModelId(modelId: string, cliVersion: string | null = null): string {
  const rows = ALIAS_RESOLUTION[modelId];
  if (!rows || rows.length === 0) return modelId;
  if (cliVersion === null) return rows[rows.length - 1]!.model;
  let current = rows[0]!.model;
  for (const row of rows) if (!isVersionBelow(cliVersion, row.fromCli)) current = row.model;
  return current;
}

/**
 * Every concrete model that would count as "the one requested" (SPEC.md §8). With the version known that is
 * one model; with it unknown, an alias accepts any of its rows rather than raise a mismatch it cannot justify.
 */
export function acceptableServedModels(modelId: string, cliVersion: string | null): string[] {
  const rows = ALIAS_RESOLUTION[modelId];
  if (!rows) return [getModel(modelId)?.servedAs ?? modelId];
  if (cliVersion !== null) return [resolvedModelId(modelId, cliVersion)];
  return [...new Set(rows.map((r) => r.model))];
}

/**
 * Did the CLI serve the model we asked for? `served` is a `modelUsage` key or `canonicalModel`
 * (e.g. `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001`). `cliVersion` is the CLI that ran the turn
 * (the `init` event's `claude_code_version`); it decides what an alias meant.
 *
 * Only a `[…]` marker and an 8-digit date suffix are ignored. A bare prefix is **not** a match: requesting
 * `claude-opus-5` and being served `claude-opus-5-5` is a different model, and must say so.
 */
export function servedModelMatches(requestedId: string, served: string, cliVersion: string | null = null): boolean {
  const base = baseModelId(served);
  return acceptableServedModels(requestedId, cliVersion).some((expected) => baseModelId(expected) === base);
}

/** A concrete model's name: `claude-opus-5-5[1m]` → `Opus 5.5`. Unknown ids are returned as they are. */
export function modelName(modelId: string): string {
  const base = baseModelId(modelId);
  return MODEL_NAMES[base] ?? getModel(base)?.label ?? modelId;
}

export interface ModelDisplay {
  /** The version that runs: `Opus 5.5`. */
  name: string;
  /** Set when the choice is an alias: `opus`. */
  alias: string | null;
  /** What a picker or header shows: an alias as written (`opus`), a full id by its name (`Opus 5.5`). */
  text: string;
  /** For a tooltip: what an alias means and how to pin one. Null for a full id. */
  note: string | null;
}

/**
 * How a chosen model is shown (SPEC.md §8, decided 2026-09-26): an alias as Claude Code writes it, a full id
 * by its name. `name` is still the version the alias runs on the installed CLI, for the tooltip and for a
 * turn that reported no served model.
 */
export function modelDisplay(modelId: string, cliVersion: string | null): ModelDisplay {
  if (!isAlias(modelId)) {
    const name = modelName(modelId);
    return { name, alias: null, text: name, note: null };
  }
  const name = modelName(resolvedModelId(modelId, cliVersion));
  const where = cliVersion === null ? 'on the newest Claude Code' : `on Claude Code ${cliVersion}`;
  return {
    name,
    alias: modelId,
    text: modelId,
    note:
      `"${modelId}" is an alias: it runs ${name} ${where}, and follows Claude Code's releases, so the model can ` +
      `change after a Claude Code update. Choose a full model name to pin one.`,
  };
}

export function autoCompactThresholdFor(modelId: string, cliVersion: string | null = null): number {
  const id = resolvedModelId(modelId, cliVersion);
  return (
    getModel(id)?.autoCompactThreshold ??
    RESOLVED_ONLY_AUTO_COMPACT[id] ??
    getModel(modelId)?.autoCompactThreshold ??
    FALLBACK_AUTO_COMPACT_THRESHOLD
  );
}

/**
 * SPEC.md §15: rollover threshold = rolloverPercent × autoCompactThreshold(model).
 * `rolloverPercent` is a whole-number percentage (default 60).
 */
export function rolloverThresholdFor(modelId: string, rolloverPercent: number, cliVersion: string | null = null): number {
  return Math.floor(autoCompactThresholdFor(modelId, cliVersion) * (rolloverPercent / 100));
}

export const FABLE_WARNING =
  "In headless mode, Fable requests beyond the plan's included usage are either billed to usage credits " +
  'without asking or rejected, depending on the plan. Test connection reports which applies to this account.';

export const MAX_EFFORT_WARNING =
  'Highest token spend; prone to overthinking. Recommended only for the Planner on hard problems.';

export function fableVersionWarning(model: ModelSpec): string {
  return `Requires Claude Code ${model.minCliVersion ?? MIN_CLI_VERSION} or newer.`;
}

/**
 * SPEC.md §8: a model with a minimum CLI version is blocked below it — the one check behind the New task
 * dialog, Settings and every turn spawn. `cliVersion` null means the version could not be read, which
 * counts as too old (`versionError` says why). Returns null when the model may run.
 */
export function modelVersionBlock(modelId: string, cliVersion: string | null, versionError: string | null = null): string | null {
  const spec = getModel(modelId);
  const minimum = spec?.minCliVersion;
  if (!spec || !minimum) return null;
  if (cliVersion === null) {
    return `${spec.label} requires Claude Code ${minimum} or newer, and the installed version could not be read${versionError ? ` (${versionError})` : ''}.`;
  }
  if (!isVersionBelow(cliVersion, minimum)) return null;
  return `${spec.label} requires Claude Code ${minimum} or newer; this machine has ${cliVersion}.`;
}

/** The models the given CLI version is too old for, with the version each needs (SPEC.md §3.3). */
export function modelsTooNewFor(cliVersion: string): Array<{ label: string; minimum: string }> {
  return MODELS.filter((m) => m.minCliVersion !== undefined && isVersionBelow(cliVersion, m.minCliVersion)).map((m) => ({
    label: m.label,
    minimum: m.minCliVersion as string,
  }));
}

/** Numeric comparison of dotted versions. Returns <0, 0 or >0. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `version` is below `minimum`. Unparseable versions are not treated as too old. */
export function isVersionBelow(version: string | null, minimum: string): boolean {
  if (!version) return false;
  return compareVersions(version, minimum) < 0;
}
