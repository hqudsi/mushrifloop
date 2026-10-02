/**
 * Models as people should read them (SPEC.md §8, decided 2026-09-26). A choice reads as chosen: `opus`, or a
 * full id by its name (`Opus 5.5`); hovering an alias says what it runs now. A turn that has run reads as the
 * model that served it. The installed CLI decides what an alias means, so every caller passes the version it
 * knows (usually the live account check's `cliVersion`).
 */

import { modelDisplay, modelName } from '../../../shared/models';

/** "opus · xhigh" or "Opus 5.5 · xhigh", for a configured agent. */
export function agentModelText(model: string, effort: string | null, cliVersion: string | null): string {
  const text = modelDisplay(model, cliVersion).text;
  return effort ? `${text} · ${effort}` : text;
}

/** The tooltip for a configured model: what an alias means and how to pin one. Empty for a full id. */
export function agentModelNote(model: string, cliVersion: string | null): string {
  return modelDisplay(model, cliVersion).note ?? '';
}

/** A served model id from `modelUsage` as a name: `claude-opus-4-8` → "Opus 4.8". */
export function servedModelText(served: string | null): string | null {
  return served === null ? null : modelName(served);
}
