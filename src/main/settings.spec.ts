import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts imports electron for app.getPath; these tests pass explicit paths instead.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { loadSettings, resetSettingsCache, saveSettings, settingsProblem, writeJsonAtomic } = await import('./settings');
const { APP_SLUG } = await import('../shared/app-config');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-settings-`));
  file = path.join(dir, 'settings.json');
  resetSettingsCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('settings persistence', () => {
  it('returns defaults when the file does not exist, without creating it', () => {
    const settings = loadSettings(file);
    expect(settings.taskDefaults.plannerModel).toBe('opus');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('round-trips a saved change', () => {
    const saved = saveSettings(
      { general: { theme: 'light' }, taskDefaults: { maxCycles: 9 } },
      file,
    );
    expect(saved.general.theme).toBe('light');

    resetSettingsCache();
    const reloaded = loadSettings(file);
    expect(reloaded.general.theme).toBe('light');
    expect(reloaded.taskDefaults.maxCycles).toBe(9);
  });

  it('returns the coerced values, not the input', () => {
    const saved = saveSettings({ taskDefaults: { maxCycles: 9999, plannerModel: 'nope' } }, file);
    expect(saved.taskDefaults.maxCycles).toBe(500);
    expect(saved.taskDefaults.plannerModel).toBe('opus');
  });

  it('falls back to defaults when the file is corrupt, and can be overwritten afterwards', () => {
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    expect(loadSettings(file).taskDefaults.approvalMode).toBe('review');

    saveSettings({ taskDefaults: { approvalMode: 'auto' } }, file);
    resetSettingsCache();
    expect(loadSettings(file).taskDefaults.approvalMode).toBe('auto');
  });

  it('writes readable, newline-terminated JSON', () => {
    saveSettings({}, file);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });

  it('leaves no temp files behind', () => {
    saveSettings({}, file);
    saveSettings({ general: { theme: 'light' } }, file);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('writeJsonAtomic creates missing directories', () => {
    const nested = path.join(dir, 'a', 'b', 'task.json');
    writeJsonAtomic(nested, { hello: 'world' });
    expect(JSON.parse(fs.readFileSync(nested, 'utf8')) as unknown).toEqual({ hello: 'world' });
  });

  it('writeJsonAtomic replaces an existing file rather than appending', () => {
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { b: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown).toEqual({ b: 2 });
  });
});

/** SPEC.md §9 (decided 2026-09-17): an unusable settings.json is reported and kept, never silently replaced. */
describe('an unusable settings.json', () => {
  const at = new Date('2026-09-17T08:09:10.123Z');
  const backup = () => `${file}.corrupt-2026-09-17T08-09-10-123Z`;

  it('a missing file is no problem', () => {
    loadSettings(file, at);
    expect(settingsProblem()).toBeNull();
  });

  it('runs on defaults, reports the parse error, and leaves the file alone until a save', () => {
    fs.writeFileSync(file, '{"general": {"theme": "light",');
    const settings = loadSettings(file, at);
    expect(settings.general.theme).toBe('system');
    expect(settingsProblem()).toEqual({ file, error: expect.stringContaining('It is not valid JSON'), backup: backup() });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"general": {"theme": "light",');
    expect(fs.existsSync(backup())).toBe(false);

    saveSettings({ general: { theme: 'dark' } }, file);
    expect(fs.readFileSync(backup(), 'utf8')).toBe('{"general": {"theme": "light",');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).general.theme).toBe('dark');
    expect(settingsProblem()).toBeNull();
  });

  it('treats JSON that is not an object as unusable', () => {
    fs.writeFileSync(file, '"just a string"');
    loadSettings(file, at);
    expect(settingsProblem()?.error).toBe('It does not hold a settings object.');
  });

  it('does not save over a file it could not keep a copy of', () => {
    fs.writeFileSync(file, 'garbage');
    loadSettings(file, at);
    fs.writeFileSync(backup(), 'something already there');
    expect(() => saveSettings({ general: { theme: 'dark' } }, file)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('garbage');
    expect(settingsProblem()).not.toBeNull();
  });
});
