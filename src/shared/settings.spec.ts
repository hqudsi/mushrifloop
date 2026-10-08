import { describe, expect, it } from 'vitest';

import {
  DEFAULTS_REVISION,
  DEFAULT_CHANGES,
  DEFAULT_EXECUTOR_TOOLS,
  applyDefaultChanges,
  defaultSettings,
  mergeSettings,
  pendingDefaultChanges,
  restoreSectionDefaults,
} from './settings';

describe('default settings (SPEC.md §11)', () => {
  const d = defaultSettings();

  it('uses the documented agent defaults', () => {
    expect(d.taskDefaults.plannerModel).toBe('opus');
    expect(d.taskDefaults.plannerEffort).toBe('medium');
    expect(d.taskDefaults.executorModel).toBe('sonnet');
    expect(d.taskDefaults.executorEffort).toBe('medium');
  });

  it('uses the documented loop and approval defaults', () => {
    expect(d.taskDefaults.maxCycles).toBe(100);
    expect(d.taskDefaults.turnTimeoutMinutes).toBe(60);
    expect(d.taskDefaults.slowTurnWarningMinutes).toBe(30);
    expect(d.taskDefaults.maxTurnsPerSession).toBe(80);
    expect(d.taskDefaults.approvalMode).toBe('review');
    expect(d.taskDefaults.plannerContextMode).toBe('read_only');
  });

  it('defaults rollover to 60% and requires security-review before done', () => {
    expect(d.taskDefaults.rolloverPercent).toBe(60);
    expect(d.taskDefaults.requiredSkillsBeforeDone).toEqual(['security-review']);
    expect(d.taskDefaults.autoBranchAndCommit).toBe(true);
  });

  it('defaults the executor tool list to the Windows list from SPEC.md §3.1', () => {
    expect(d.claudeCode.executorTools).toEqual([
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash',
      'PowerShell',
      'Skill',
    ]);
    expect(d.claudeCode.executorTools).toEqual([...DEFAULT_EXECUTOR_TOOLS]);
  });

  it('defaults to dontAsk, no API-key billing and auto-detected binary', () => {
    expect(d.claudeCode.permissionMode).toBe('dontAsk');
    expect(d.claudeCode.allowApiKeyBilling).toBe(false);
    expect(d.claudeCode.binaryPath).toBeNull();
    expect(d.claudeCode.maxRetries).toBeNull();
  });

  it('defaults to following the system theme', () => {
    expect(d.general.theme).toBe('system');
  });
});

describe('mergeSettings', () => {
  it('returns defaults for missing, null or non-object input', () => {
    expect(mergeSettings(undefined)).toEqual(defaultSettings());
    expect(mergeSettings(null)).toEqual(defaultSettings());
    expect(mergeSettings('nonsense')).toEqual(defaultSettings());
    expect(mergeSettings([1, 2, 3])).toEqual(defaultSettings());
  });

  it('keeps stored values and fills the rest from defaults', () => {
    const merged = mergeSettings({ general: { theme: 'light' }, taskDefaults: { maxCycles: 7 } });
    expect(merged.general.theme).toBe('light');
    expect(merged.taskDefaults.maxCycles).toBe(7);
    expect(merged.general.editorCommand).toBe('code');
    expect(merged.taskDefaults.approvalMode).toBe('review');
  });

  it('merges partial nested objects without dropping siblings', () => {
    const merged = mergeSettings({ general: { notifications: { sound: true } } });
    expect(merged.general.notifications.sound).toBe(true);
    expect(merged.general.notifications.waitingForInput).toBe(true);
    expect(merged.general.notifications.everyCompletedCycle).toBe(false);
  });

  it('drops unknown keys', () => {
    const merged = mergeSettings({ nonsense: true, general: { nonsense: 1, theme: 'light' } }) as unknown as Record<
      string,
      unknown
    >;
    expect(merged['nonsense']).toBeUndefined();
    expect((merged['general'] as Record<string, unknown>)['nonsense']).toBeUndefined();
  });

  it('replaces invalid enum values with the default', () => {
    const merged = mergeSettings({
      general: { theme: 'neon' },
      taskDefaults: { approvalMode: 'whenever', plannerContextMode: 'sideways' },
      claudeCode: { permissionMode: 'yolo' },
    });
    expect(merged.general.theme).toBe('system');
    expect(merged.taskDefaults.approvalMode).toBe('review');
    expect(merged.taskDefaults.plannerContextMode).toBe('read_only');
    expect(merged.claudeCode.permissionMode).toBe('dontAsk');
  });

  it('clamps numbers into range and rounds them', () => {
    const merged = mergeSettings({
      taskDefaults: { maxCycles: 0, turnTimeoutMinutes: 10_000, rolloverPercent: 99, maxTurnsPerSession: 12.6 },
    });
    expect(merged.taskDefaults.maxCycles).toBe(1);
    expect(merged.taskDefaults.turnTimeoutMinutes).toBe(600);
    expect(merged.taskDefaults.rolloverPercent).toBe(95);
    expect(merged.taskDefaults.maxTurnsPerSession).toBe(13);
  });

  it('keeps "fresh Executor session after rejected answers" off unless set, and in range (SPEC.md §15)', () => {
    expect(defaultSettings().taskDefaults.freshExecutorAfterRejectedTurns).toBeNull();
    const pick = (value: unknown) => mergeSettings({ taskDefaults: { freshExecutorAfterRejectedTurns: value } }).taskDefaults.freshExecutorAfterRejectedTurns;
    expect(pick(2)).toBe(2);
    expect(pick(0)).toBe(1);
    expect(pick(99)).toBe(10);
    expect(pick(null)).toBeNull();
    expect(pick('2')).toBeNull();
  });

  it('clamps the slow-turn warning into range', () => {
    expect(mergeSettings({ taskDefaults: { slowTurnWarningMinutes: 0 } }).taskDefaults.slowTurnWarningMinutes).toBe(1);
    expect(mergeSettings({ taskDefaults: { slowTurnWarningMinutes: 3 } }).taskDefaults.slowTurnWarningMinutes).toBe(3);
    expect(mergeSettings({ taskDefaults: { slowTurnWarningMinutes: 'soon' } }).taskDefaults.slowTurnWarningMinutes).toBe(30);
  });

  it('ignores non-numeric values for numeric fields', () => {
    const merged = mergeSettings({ taskDefaults: { maxCycles: 'lots' }, general: { softDailyTokenCap: 'plenty' } });
    expect(merged.taskDefaults.maxCycles).toBe(100);
    expect(merged.general.softDailyTokenCap).toBeNull();
  });

  it('keeps an explicit null soft cap as "off"', () => {
    expect(mergeSettings({ general: { softDailyTokenCap: null } }).general.softDailyTokenCap).toBeNull();
    expect(mergeSettings({ general: { softDailyTokenCap: 500 } }).general.softDailyTokenCap).toBe(500);
  });

  it('falls back to the default model when the stored one no longer exists', () => {
    // e.g. a settings file written before claude-fable-5 was removed from the catalog.
    const merged = mergeSettings({
      taskDefaults: { plannerModel: 'claude-fable-5', executorModel: 'made-up' },
    });
    expect(merged.taskDefaults.plannerModel).toBe('opus');
    expect(merged.taskDefaults.executorModel).toBe('sonnet');
  });

  it('forces the effort to something the model actually supports', () => {
    const merged = mergeSettings({
      taskDefaults: { plannerModel: 'claude-opus-4-6', plannerEffort: 'xhigh', executorModel: 'claude-sonnet-4-6', executorEffort: 'xhigh' },
    });
    expect(merged.taskDefaults.plannerEffort).toBe('high');
    expect(merged.taskDefaults.executorEffort).toBe('high');
  });

  it('cleans tool and skill lists: trims, drops blanks and de-duplicates', () => {
    const merged = mergeSettings({
      claudeCode: { executorTools: ['Read', ' Read ', '', 'Bash', 42] },
      taskDefaults: { requiredSkillsBeforeDone: ['security-review', 'security-review', '  '] },
    });
    expect(merged.claudeCode.executorTools).toEqual(['Read', 'Bash']);
    expect(merged.taskDefaults.requiredSkillsBeforeDone).toEqual(['security-review']);
  });

  it('allows an empty required-skills list (explicitly turning the gate off)', () => {
    expect(mergeSettings({ taskDefaults: { requiredSkillsBeforeDone: [] } }).taskDefaults.requiredSkillsBeforeDone)
      .toEqual([]);
  });

  it('normalises a blank binary path to null (= auto-detect)', () => {
    expect(mergeSettings({ claudeCode: { binaryPath: '   ' } }).claudeCode.binaryPath).toBeNull();
    expect(mergeSettings({ claudeCode: { binaryPath: ' C:\\claude.exe ' } }).claudeCode.binaryPath).toBe(
      'C:\\claude.exe',
    );
  });

  it('clamps the retry override to the range the CLI accepts', () => {
    expect(mergeSettings({ claudeCode: { maxRetries: 99 } }).claudeCode.maxRetries).toBe(10);
    expect(mergeSettings({ claudeCode: { maxRetries: -3 } }).claudeCode.maxRetries).toBe(0);
    expect(mergeSettings({ claudeCode: { maxRetries: null } }).claudeCode.maxRetries).toBeNull();
  });

  it('is idempotent: merging its own output changes nothing', () => {
    const once = mergeSettings({ general: { theme: 'light' }, taskDefaults: { maxCycles: 3 } });
    expect(mergeSettings(once)).toEqual(once);
  });

  it('keeps each explicit theme choice', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      expect(mergeSettings({ general: { theme } }).general.theme).toBe(theme);
    }
  });

  it('always stamps the current settings version', () => {
    expect(mergeSettings({ version: 99 }).version).toBe(1);
  });
});

/** The task defaults of a file saved by v1.1.0, before any default changed. */
function savedByV11(overrides: Record<string, unknown> = {}) {
  const d = defaultSettings();
  return mergeSettings({
    ...d,
    defaultsRevision: undefined,
    taskDefaults: {
      ...d.taskDefaults,
      maxCycles: 25,
      turnTimeoutMinutes: 20,
      slowTurnWarningMinutes: 5,
      maxTurnsPerSession: 40,
      plannerContextMode: 'isolated',
      plannerEffort: 'xhigh',
      executorEffort: 'high',
      ...overrides,
    },
  });
}

/** A file reconciled with revision 2, before the efforts changed (SPEC.md §8, 2026-10-06). */
function savedAtRevision2(overrides: Record<string, unknown> = {}) {
  const d = defaultSettings();
  return mergeSettings({ ...d, defaultsRevision: 2, taskDefaults: { ...d.taskDefaults, plannerEffort: 'xhigh', executorEffort: 'high', ...overrides } });
}

describe('defaults after an update (SPEC.md §11)', () => {
  it('counts a file without a revision as revision 1, and starts a new install at the current one', () => {
    expect(DEFAULTS_REVISION).toBe(3);
    expect(savedByV11().defaultsRevision).toBe(1);
    expect(defaultSettings().defaultsRevision).toBe(DEFAULTS_REVISION);
    expect(mergeSettings(undefined).defaultsRevision).toBe(DEFAULTS_REVISION);
    expect(mergeSettings({ defaultsRevision: 99 }).defaultsRevision).toBe(DEFAULTS_REVISION);
  });

  it('lists revisions 2 and 3 for a v1.1 file, pre-selecting what still holds the old default', () => {
    const pending = pendingDefaultChanges(savedByV11({ maxCycles: 300 }));
    expect(pending.map((c) => [c.field, c.from, c.to, c.current, c.suggested])).toEqual([
      ['maxCycles', 25, 100, 300, false],
      ['turnTimeoutMinutes', 20, 60, 20, true],
      ['slowTurnWarningMinutes', 5, 30, 5, true],
      ['maxTurnsPerSession', 40, 80, 40, true],
      ['plannerContextMode', 'isolated', 'read_only', 'isolated', true],
      ['plannerEffort', 'xhigh', 'medium', 'xhigh', true],
      ['executorEffort', 'high', 'medium', 'high', true],
    ]);
  });

  it('lists only revision 3 for a file reconciled with revision 2, and leaves a chosen effort unselected', () => {
    const pending = pendingDefaultChanges(savedAtRevision2({ executorEffort: 'max' }));
    expect(pending.map((c) => [c.field, c.from, c.to, c.current, c.suggested])).toEqual([
      ['plannerEffort', 'xhigh', 'medium', 'xhigh', true],
      ['executorEffort', 'high', 'medium', 'max', false],
    ]);
  });

  it('offers no effort change when haiku was stored without one: it reads as medium already (Haiku 5.5)', () => {
    const pending = pendingDefaultChanges(savedAtRevision2({ executorModel: 'haiku', executorEffort: null }));
    expect(pending.map((c) => c.field)).toEqual(['plannerEffort']);
  });

  it('leaves out a setting that already holds the new value, and says nothing to a current file', () => {
    expect(pendingDefaultChanges(savedByV11({ turnTimeoutMinutes: 60 })).map((c) => c.field)).not.toContain('turnTimeoutMinutes');
    expect(pendingDefaultChanges(defaultSettings())).toEqual([]);
  });

  it('applies only what was chosen, and marks the file reconciled either way', () => {
    const before = savedByV11({ maxCycles: 300 });
    const applied = applyDefaultChanges(before, ['turnTimeoutMinutes', 'plannerContextMode']);
    expect(applied.taskDefaults).toMatchObject({ maxCycles: 300, turnTimeoutMinutes: 60, slowTurnWarningMinutes: 5, maxTurnsPerSession: 40, plannerContextMode: 'read_only' });
    expect(applied.defaultsRevision).toBe(DEFAULTS_REVISION);
    expect(pendingDefaultChanges(applied)).toEqual([]);

    const kept = applyDefaultChanges(before, []);
    expect(kept.taskDefaults).toEqual(before.taskDefaults);
    expect(kept.defaultsRevision).toBe(DEFAULTS_REVISION);
  });

  it('keeps every entry of the table a real Task default, moving from its old default to the current one', () => {
    const latest = new Map(DEFAULT_CHANGES.map((c) => [c.field, c.to]));
    for (const [field, to] of latest) expect(defaultSettings().taskDefaults[field]).toBe(to);
  });
});

describe('Restore defaults (SPEC.md §11)', () => {
  it('restores one section and leaves the others, the data folder and the first-run flag alone', () => {
    const s = savedByV11();
    s.general.theme = 'dark';
    s.general.dataFolder = 'D:\\MushrifLoop data';
    s.general.setupCompleted = true;
    s.general.editorCommand = 'notepad';
    s.claudeCode.executorTools = ['Read'];

    const general = restoreSectionDefaults(s, 'general');
    expect(general.general).toMatchObject({ theme: 'system', editorCommand: 'code', dataFolder: 'D:\\MushrifLoop data', setupCompleted: true });
    expect(general.taskDefaults).toEqual(s.taskDefaults);
    expect(general.claudeCode).toEqual(s.claudeCode);

    const tasks = restoreSectionDefaults(s, 'taskDefaults');
    expect(tasks.taskDefaults).toEqual(defaultSettings().taskDefaults);
    expect(tasks.general).toEqual(s.general);

    expect(restoreSectionDefaults(s, 'claudeCode').claudeCode).toEqual(defaultSettings().claudeCode);
    // Restoring is not reconciling: the review still has to happen.
    expect(tasks.defaultsRevision).toBe(1);
  });
});
