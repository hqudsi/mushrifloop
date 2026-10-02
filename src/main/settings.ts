/**
 * Settings file I/O — SPEC.md §11, stored per SPEC.md §9.
 *
 * Atomic writes: temp file in the same directory → fsync → rename. A half-written settings
 * file would be worse than none, and the same pattern is required for task.json in Phase 3.
 */

import * as fs from 'node:fs';

import type { SettingsProblem } from '../shared/ipc';
import { mergeSettings, type Settings } from '../shared/settings';
import { settingsFile } from './config';
import { writeJsonAtomic } from './atomic-write';
import { errorMessage, log } from './logger';
import { fileStamp } from './orchestrator/usage-ledger';

export { writeJsonAtomic };

let cached: Settings | null = null;
let problem: SettingsProblem | null = null;

/**
 * Read settings from disk, merged over defaults. A missing file means defaults. A file that exists but
 * cannot be used also means defaults, but never silently: it is reported (`settingsProblem`) and left
 * untouched until the next save, which copies it aside first (SPEC.md §9).
 */
export function loadSettings(file = settingsFile(), now = new Date()): Settings {
  problem = null;
  const fail = (error: string): Settings => {
    problem = { file, error, backup: `${file}.corrupt-${fileStamp(now)}` };
    log.error('settings.load_failed', { file, error });
    cached = mergeSettings(undefined);
    return cached;
  };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = mergeSettings(undefined);
      return cached;
    }
    return fail(`It could not be read: ${errorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`It is not valid JSON: ${errorMessage(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('It does not hold a settings object.');
  }
  cached = mergeSettings(parsed);
  return cached;
}

/** The settings file that could not be used at startup, if any. */
export function settingsProblem(): SettingsProblem | null {
  return problem;
}

/** Last loaded/saved settings, loading from disk on first use. */
export function getSettings(): Settings {
  return cached ?? loadSettings();
}

/**
 * Validate (via merge) and persist. Returns what was actually stored, so the renderer
 * always renders the coerced values rather than what it hopefully sent.
 */
export function saveSettings(input: unknown, file = settingsFile()): Settings {
  const settings = mergeSettings(input);
  if (problem && problem.file === file && fs.existsSync(file)) {
    // Keep what could not be read before replacing it; if that fails, do not replace it.
    fs.copyFileSync(file, problem.backup, fs.constants.COPYFILE_EXCL);
    log.warn('settings.unreadable_kept', { file, backup: problem.backup });
  }
  writeJsonAtomic(file, settings);
  problem = null;
  cached = settings;
  log.info('settings.saved', { file });
  return settings;
}

/** Test seam: forget the cached copy. */
export function resetSettingsCache(): void {
  cached = null;
  problem = null;
}
