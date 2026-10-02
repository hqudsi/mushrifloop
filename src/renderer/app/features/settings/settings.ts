/**
 * Settings screen — SPEC.md §11, laid out after design/ ("Settings — General",
 * "Settings — Task defaults", "Settings — Claude Code connection").
 *
 * All state lives in SettingsStore; this component only edits the draft and triggers IPC calls.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';

import { APP_COPYRIGHT, APP_DEVELOPER, APP_ISSUES_URL, APP_NAME, APP_REPO_URL, APP_SLUG, APP_TAGLINE } from '../../../../shared/app-config';
import type { ClaudeCodeUpdateResult, ClaudeCodeVersionInfo, EditorCheckResult, StorageLocation, TestConnectionResult } from '../../../../shared/ipc';
import type { LicenseEntry } from '../../../../shared/licenses';
import {
  AUTO_COMPACT_MEASURED_ON,
  FABLE_WARNING,
  MAX_EFFORT_WARNING,
  MIN_CLI_VERSION,
  PICKER_MODELS,
  VERIFIED_CLI_VERSION,
  autoCompactThresholdFor,
  coerceEffort,
  effortOnModelChange,
  effortsFor,
  getModel,
  modelDisplay,
  modelVersionBlock,
  rolloverThresholdFor,
  type EffortLevel,
  type ModelSpec,
} from '../../../../shared/models';
import {
  APPROVAL_MODES,
  FRESH_EXECUTOR_DEFAULT_TURNS,
  FRESH_EXECUTOR_MAX_TURNS,
  restoreSectionDefaults,
  type ApprovalMode,
  type PermissionMode,
  type PlannerContextMode,
  type Settings,
  type SettingsSection,
  type ThemeSetting,
} from '../../../../shared/settings';
import { THIRD_PARTY_LICENSES } from '../../../../shared/third-party-licenses.generated';
import { api } from '../../core/api';
import { SettingsStore } from '../../core/settings-store';
import { TasksStore } from '../../core/tasks-store';
import { AccountBlock } from '../../shared/account-block';
import { AppMark } from '../../shared/app-mark';
import { ContentPane } from '../../shared/content-pane';

type Section = 'general' | 'taskDefaults' | 'connection' | 'about';
type Agent = 'planner' | 'executor';

const USE_LABEL: Record<LicenseEntry['usedBy'][number], string> = {
  main: 'main process',
  renderer: 'user interface',
  runtime: 'application runtime',
};

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [AccountBlock, AppMark, ContentPane],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class SettingsScreen {
  protected readonly store = inject(SettingsStore);
  private readonly tasks = inject(TasksStore);

  /** "Back to tasks" (Phase 4: the main screen exists now). */
  readonly back = output<void>();
  /** General → Re-run setup: show the first-run screen again (SPEC.md §10). */
  readonly rerunSetup = output<void>();

  protected readonly section = signal<Section>('general');
  protected readonly models = PICKER_MODELS;
  protected readonly minCliVersion = MIN_CLI_VERSION;
  protected readonly verifiedCliVersion = VERIFIED_CLI_VERSION;
  protected readonly autoCompactMeasuredOn = AUTO_COMPACT_MEASURED_ON;
  protected readonly fableWarning = FABLE_WARNING;
  protected readonly maxEffortWarning = MAX_EFFORT_WARNING;

  protected readonly testing = signal(false);
  protected readonly testResult = signal<TestConnectionResult | null>(null);

  protected readonly toolDraft = signal('');
  protected readonly denyDraft = signal('');
  protected readonly skillDraft = signal('');

  protected readonly settings = computed(() => this.store.draft());
  protected readonly appName = APP_NAME;
  protected readonly appSlug = APP_SLUG;

  /** Where this process actually writes, detected at startup (NOTES.md §13). */
  protected readonly storage = computed(() => this.store.appInfo()?.storage ?? null);

  /** The saved data folder differs from the one this process resolved at startup. */
  protected readonly restartNeeded = computed(() => {
    const storage = this.storage();
    return storage !== null && this.store.saved().general.dataFolder !== storage.configuredAtStartup;
  });

  protected readonly redirectingPackage = computed(() => {
    const storage = this.storage();
    return storage?.dataFolder.packageFamily ?? storage?.settingsFolder.packageFamily ?? 'unknown';
  });

  protected dataFolderLabel(): string {
    const configured = this.settings().general.dataFolder;
    if (configured) return configured;
    const fallback = this.store.appInfo()?.paths.defaultDataFolder;
    return fallback ? `${fallback}  (default)` : '—';
  }

  protected readonly agents: readonly { id: Agent; label: string }[] = [
    { id: 'planner', label: 'Planner' },
    { id: 'executor', label: 'Executor' },
  ];

  protected readonly sections: readonly { id: Section; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'taskDefaults', label: 'Task defaults' },
    { id: 'connection', label: 'Claude Code connection' },
    { id: 'about', label: 'About' },
  ];

  // --- About (SPEC.md §11) ---------------------------------------------------

  protected readonly tagline = APP_TAGLINE;
  protected readonly developer = APP_DEVELOPER;
  protected readonly copyright = APP_COPYRIGHT;
  protected readonly repoUrl = APP_REPO_URL;
  protected readonly issuesUrl = APP_ISSUES_URL;
  protected readonly licenses = THIRD_PARTY_LICENSES;
  /** The live CLI reading the account footer uses: `claude --version` and the resolved binary. */
  protected readonly cli = computed(() => this.tasks.account());
  protected readonly copyState = signal<{ ok: boolean; text: string } | null>(null);

  /**
   * The licenses the app must ship (MIT, Apache, BSD) are pages of text, so About holds one line and
   * the full generated list is a page of its own behind it — still inside the About section, so the
   * nav keeps About selected and the save bar stays hidden.
   */
  private readonly licensesOpen = signal(false);
  protected readonly aboutPage = computed(() => this.section() === 'about' && !this.licensesOpen());
  protected readonly licensesPage = computed(() => this.section() === 'about' && this.licensesOpen());

  /** The scroll container (see ContentPane): a page change starts at the top, as a new page would. */
  private readonly pane = viewChild('pane', { read: ElementRef });

  protected openSection(id: Section): void {
    this.section.set(id);
    this.copyState.set(null);
    this.licensesOpen.set(false);
    // "Currently detected": read it again rather than show a reading from minutes ago.
    if (id === 'about') void this.tasks.refreshAccount();
  }

  protected openLicenses(): void {
    this.licensesOpen.set(true);
    this.scrollToTop();
  }

  protected closeLicenses(): void {
    this.licensesOpen.set(false);
    this.scrollToTop();
  }

  private scrollToTop(): void {
    const el = this.pane()?.nativeElement as HTMLElement | undefined;
    el?.scrollTo({ top: 0 });
  }

  protected usedBy(entry: LicenseEntry): string {
    return entry.usedBy.map((u) => USE_LABEL[u]).join(', ');
  }

  protected async mailDeveloper(event: Event): Promise<void> {
    event.preventDefault();
    const result = await api().openExternal(`mailto:${this.developer.email}`);
    if (!result.ok) this.store.error.set(result.error ?? 'Could not open the mail program.');
  }

  /** The repository and its issues open in the system browser, never inside the app. */
  protected async openLink(event: Event, url: string): Promise<void> {
    event.preventDefault();
    const result = await api().openExternal(url);
    if (!result.ok) this.store.error.set(result.error ?? `Could not open ${url}.`);
  }

  protected async openChromiumNotices(file: string): Promise<void> {
    const result = await api().openPath(file);
    if (!result.ok) this.store.error.set(`Could not open ${file}: ${result.error ?? 'unknown error'}`);
  }

  protected async copyDiagnostics(): Promise<void> {
    const result = await api().copyText(this.diagnostics());
    this.copyState.set(result.ok ? { ok: true, text: 'Copied to the clipboard.' } : { ok: false, text: result.error ?? 'Could not copy.' });
  }

  /** Plain text for a bug report: versions, where data goes, and which CLI would run. */
  private diagnostics(): string {
    const info = this.store.appInfo();
    const cli = this.cli();
    const where = (label: string, loc: StorageLocation) => [
      `${label}: ${loc.path}`,
      `  writes land in: ${loc.physicalPath}`,
      `  redirected: ${loc.redirected ? `yes (package ${loc.packageFamily ?? 'unknown'})` : 'no'} · detection: ${loc.method}${loc.detail ? ` (${loc.detail})` : ''}`,
    ];
    const lines = [`${APP_NAME} ${info?.appVersion ?? '?'}`];
    if (info) {
      lines.push(
        `Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · Node.js ${info.nodeVersion}`,
        `OS: ${info.os} (${info.platform})`,
      );
    }
    if (cli === null) lines.push('Claude Code CLI: not checked yet');
    else if (cli.cliPath === null && cli.cliVersion === null) lines.push(`Claude Code CLI: not detected${cli.error ? ` — ${cli.error}` : ''}`);
    else lines.push(`Claude Code CLI: ${cli.cliVersion ?? 'version unknown'} at ${cli.cliPath ?? 'unknown path'} (checked ${cli.checkedAt})`);
    if (info) {
      lines.push(...where('Data folder', info.storage.dataFolder));
      lines.push(...where('Settings folder', info.storage.settingsFolder));
      lines.push(
        `Data folder setting at startup: ${info.storage.configuredAtStartup || '(default)'}${this.restartNeeded() ? ' — a different folder is saved; it applies after a restart' : ''}`,
        `Settings file: ${info.paths.settingsFile}`,
        `Log file: ${info.paths.logFile}`,
      );
      if (info.settingsProblem) lines.push(`settings.json problem: ${info.settingsProblem.error}`);
    }
    lines.push(`Copied: ${new Date().toISOString()}`);
    return lines.join('\n');
  }

  protected readonly themes: readonly { id: ThemeSetting; label: string }[] = [
    { id: 'dark', label: 'Dark' },
    { id: 'light', label: 'Light' },
    { id: 'system', label: 'System' },
  ];

  protected readonly approvalModes = APPROVAL_MODES;

  protected readonly contextModes: readonly { id: PlannerContextMode; label: string }[] = [
    { id: 'isolated', label: 'Isolated' },
    { id: 'read_only', label: 'Read-only project' },
  ];

  protected readonly permissionModes: readonly { id: PermissionMode; label: string; hint: string }[] = [
    {
      id: 'dontAsk',
      label: "Don't ask",
      hint: 'Tools outside the allowed list are denied immediately and reported. Recommended.',
    },
    {
      id: 'bypassPermissions',
      label: 'Skip all permission prompts',
      hint: '--dangerously-skip-permissions',
    },
  ];

  // --- effort / model ------------------------------------------------------

  protected effortsForModel(modelId: string): readonly EffortLevel[] {
    return effortsFor(modelId);
  }

  protected modelSpec(modelId: string): ModelSpec | undefined {
    return getModel(modelId);
  }

  /** A model as chosen: an alias as written, a full id by its name (SPEC.md §8). */
  protected modelText(modelId: string): string {
    return modelDisplay(modelId, this.tasks.account()?.cliVersion ?? null).text;
  }

  protected modelNote(modelId: string): string | null {
    return modelDisplay(modelId, this.tasks.account()?.cliVersion ?? null).note;
  }

  protected setModel(agent: Agent, modelId: string): void {
    const cli = this.tasks.account()?.cliVersion ?? null;
    this.store.update((draft) => {
      // Effort levels are per model (SPEC.md §8): keep it valid, and start Opus 5.5 at its own default.
      if (agent === 'planner') {
        draft.taskDefaults.plannerModel = modelId;
        draft.taskDefaults.plannerEffort = effortOnModelChange(modelId, draft.taskDefaults.plannerEffort, cli);
      } else {
        draft.taskDefaults.executorModel = modelId;
        draft.taskDefaults.executorEffort = effortOnModelChange(modelId, draft.taskDefaults.executorEffort, cli);
      }
    });
  }

  protected setEffort(agent: Agent, effort: string): void {
    const value = (effort === '' ? null : effort) as EffortLevel | null;
    this.store.update((draft) => {
      if (agent === 'planner') draft.taskDefaults.plannerEffort = value;
      else draft.taskDefaults.executorEffort = value;
    });
  }

  /** The Fable billing warning (SPEC.md §8). */
  protected fableWarningFor(modelId: string): string | null {
    return getModel(modelId)?.isFable ? FABLE_WARNING : null;
  }

  /**
   * SPEC.md §8: a default the installed CLI cannot run is blocked — the main process refuses the save with
   * the same check. Uses the version from Test connection, else the one the account footer read.
   */
  protected versionBlockFor(modelId: string): string | null {
    const version = this.testResult()?.version ?? this.tasks.account()?.cliVersion ?? null;
    return version === null ? null : modelVersionBlock(modelId, version);
  }

  protected readonly saveBlocked = computed(() => {
    const d = this.settings().taskDefaults;
    return this.versionBlockFor(d.plannerModel) !== null || this.versionBlockFor(d.executorModel) !== null;
  });

  protected rolloverFor(modelId: string): number {
    return rolloverThresholdFor(modelId, this.settings().taskDefaults.rolloverPercent);
  }

  protected autoCompactFor(modelId: string): number {
    return autoCompactThresholdFor(modelId);
  }

  protected formatTokens(value: number): string {
    return value.toLocaleString('en-US');
  }

  // --- generic field helpers ----------------------------------------------

  protected set<K extends keyof Settings>(section: K, mutate: (value: Settings[K]) => void): void {
    this.store.update((draft) => mutate(draft[section]));
  }

  protected setTheme(theme: ThemeSetting): void {
    this.store.update((d) => {
      d.general.theme = theme;
    });
  }

  protected toggleNotification(key: keyof Settings['general']['notifications']): void {
    this.store.update((d) => {
      d.general.notifications[key] = !d.general.notifications[key];
    });
  }

  /**
   * "Detect" (SPEC.md §11). Same check as first-run setup: look for the program on disk, run
   * nothing. The check belongs to the text that produced it, so typing clears it.
   */
  protected readonly editorCheck = signal<EditorCheckResult | null>(null);
  protected readonly detectingEditor = signal(false);

  protected async detectEditor(): Promise<void> {
    this.detectingEditor.set(true);
    try {
      this.editorCheck.set(await api().checkEditor(this.settings().general.editorCommand));
    } catch (err) {
      this.editorCheck.set({ ok: false, program: null, path: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.detectingEditor.set(false);
    }
  }

  protected setEditorCommand(value: string): void {
    this.editorCheck.set(null);
    this.store.update((d) => {
      d.general.editorCommand = value;
    });
  }

  protected setSoftCap(value: string): void {
    const parsed = Number.parseInt(value, 10);
    this.store.update((d) => {
      d.general.softDailyTokenCap = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    });
  }

  protected toggleAutoResume(): void {
    this.store.update((d) => {
      d.general.autoResumeAtReset = !d.general.autoResumeAtReset;
    });
  }

  protected stepMaxCycles(delta: number): void {
    this.store.update((d) => {
      d.taskDefaults.maxCycles = Math.min(500, Math.max(1, d.taskDefaults.maxCycles + delta));
    });
  }

  /**
   * SPEC.md §11: this section's defaults into the form. Nothing is saved until Save changes, and Revert undoes
   * it; the data folder and the first-run flag are kept.
   */
  protected restoreDefaults(section: SettingsSection): void {
    this.store.update((draft) => {
      const restored = restoreSectionDefaults(draft, section);
      draft.general = restored.general;
      draft.taskDefaults = restored.taskDefaults;
      draft.claudeCode = restored.claudeCode;
    });
  }

  protected restoreHint(section: SettingsSection): string {
    const kept = section === 'general' ? ' The data folder is kept.' : '';
    return `Fills this section with the defaults. Nothing is saved until Save changes, and Revert undoes it.${kept}`;
  }

  protected setNumber(
    field: 'turnTimeoutMinutes' | 'slowTurnWarningMinutes' | 'maxTurnsPerSession' | 'rolloverPercent' | 'maxCycles',
    value: string,
    min: number,
    max: number,
  ): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    this.store.update((d) => {
      d.taskDefaults[field] = Math.min(max, Math.max(min, parsed));
    });
  }

  protected setApprovalMode(mode: ApprovalMode): void {
    this.store.update((d) => {
      d.taskDefaults.approvalMode = mode;
    });
  }

  protected setContextMode(mode: PlannerContextMode): void {
    this.store.update((d) => {
      d.taskDefaults.plannerContextMode = mode;
    });
  }

  protected setStandingPrompt(agent: Agent, value: string): void {
    this.store.update((d) => {
      d.taskDefaults.standingPrompts[agent] = value;
    });
  }

  protected toggleAutoCommit(): void {
    this.store.update((d) => {
      d.taskDefaults.autoBranchAndCommit = !d.taskDefaults.autoBranchAndCommit;
    });
  }

  protected readonly freshExecutorMax = FRESH_EXECUTOR_MAX_TURNS;

  /** Off by default; switched on it starts at 2 turns (SPEC.md §15). */
  protected toggleFreshExecutor(): void {
    this.store.update((d) => {
      d.taskDefaults.freshExecutorAfterRejectedTurns =
        d.taskDefaults.freshExecutorAfterRejectedTurns === null ? FRESH_EXECUTOR_DEFAULT_TURNS : null;
    });
  }

  protected setFreshExecutorTurns(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    this.store.update((d) => {
      d.taskDefaults.freshExecutorAfterRejectedTurns = Math.min(FRESH_EXECUTOR_MAX_TURNS, Math.max(1, parsed));
    });
  }

  protected setPermissionMode(mode: PermissionMode): void {
    this.store.update((d) => {
      d.claudeCode.permissionMode = mode;
    });
  }

  protected toggleApiKeyBilling(): void {
    this.store.update((d) => {
      d.claudeCode.allowApiKeyBilling = !d.claudeCode.allowApiKeyBilling;
    });
  }

  protected setMaxRetries(value: string): void {
    this.store.update((d) => {
      d.claudeCode.maxRetries = value === '' ? null : Math.min(10, Math.max(0, Number.parseInt(value, 10) || 0));
    });
  }

  protected setBinaryPath(value: string): void {
    this.store.update((d) => {
      d.claudeCode.binaryPath = value.trim() === '' ? null : value.trim();
    });
  }

  // --- chip lists ----------------------------------------------------------

  protected addChip(list: 'executorTools' | 'executorDisallowedTools' | 'requiredSkillsBeforeDone'): void {
    const draftSignal =
      list === 'executorTools' ? this.toolDraft : list === 'executorDisallowedTools' ? this.denyDraft : this.skillDraft;
    const value = draftSignal().trim();
    if (!value) return;
    this.store.update((d) => {
      const target =
        list === 'requiredSkillsBeforeDone' ? d.taskDefaults.requiredSkillsBeforeDone : d.claudeCode[list];
      if (!target.includes(value)) target.push(value);
    });
    draftSignal.set('');
  }

  protected removeChip(
    list: 'executorTools' | 'executorDisallowedTools' | 'requiredSkillsBeforeDone',
    value: string,
  ): void {
    this.store.update((d) => {
      if (list === 'requiredSkillsBeforeDone') {
        d.taskDefaults.requiredSkillsBeforeDone = d.taskDefaults.requiredSkillsBeforeDone.filter((v) => v !== value);
      } else {
        d.claudeCode[list] = d.claudeCode[list].filter((v) => v !== value);
      }
    });
  }

  // --- IPC actions ---------------------------------------------------------

  protected async browseFolder(): Promise<void> {
    const result = await api().pickDirectory('Choose the data folder', this.settings().general.dataFolder);
    if (result.path) {
      this.store.update((d) => {
        d.general.dataFolder = result.path ?? '';
      });
    }
  }

  protected async browseBinary(): Promise<void> {
    const current = this.settings().claudeCode.binaryPath ?? undefined;
    const result = await api().pickFile('Locate the claude executable', current);
    if (result.path) this.setBinaryPath(result.path);
  }

  protected async autoDetect(): Promise<void> {
    const found = await api().autoDetectClaude();
    if (found.path) {
      // Auto-detect means "use PATH", which is represented as no stored path.
      this.setBinaryPath('');
      this.testResult.set(null);
    } else {
      this.testResult.set(null);
      this.store.error.set(found.error ?? '`claude` was not found on PATH.');
    }
  }

  protected resetDataFolder(): void {
    this.store.update((d) => {
      d.general.dataFolder = '';
    });
  }

  /** Opens the folder bytes actually land in, which differs from the addressed path when redirected. */
  protected async openDataFolder(): Promise<void> {
    const target = this.storage()?.dataFolder.physicalPath ?? this.store.appInfo()?.paths.dataFolder;
    if (!target) return;
    const result = await api().openPath(target);
    if (!result.ok) this.store.error.set(`Could not open ${target}: ${result.error ?? 'unknown error'}`);
  }

  // --- Claude Code version (SPEC.md §11) -----------------------------------
  protected readonly ccCheck = signal<ClaudeCodeVersionInfo | null>(null);
  protected readonly ccChecking = signal(false);
  protected readonly ccUpdate = signal<ClaudeCodeUpdateResult | null>(null);
  protected readonly ccUpdating = signal(false);
  protected readonly ccOutput = signal('');
  /** The last reading we have: a check, an update, or the live account check. */
  protected readonly ccInstalled = computed(() => this.ccUpdate()?.after ?? this.ccCheck()?.installed ?? this.cli()?.cliVersion ?? null);

  protected async checkClaudeCode(): Promise<void> {
    this.ccChecking.set(true);
    try {
      this.ccCheck.set(await api().checkClaudeCode());
    } catch (err) {
      this.store.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.ccChecking.set(false);
    }
  }

  /** Only ever from the button: nothing calls this on its own (SPEC.md §11). */
  protected async updateClaudeCode(): Promise<void> {
    this.ccUpdating.set(true);
    this.ccUpdate.set(null);
    this.ccOutput.set('');
    const stop = api().onClaudeCodeUpdateOutput((chunk) => this.ccOutput.update((text) => text + chunk));
    try {
      const result = await api().updateClaudeCode();
      this.ccUpdate.set(result);
      if (!this.ccOutput() && result.output) this.ccOutput.set(result.output);
      // The version everything else shows comes from the account check; read it again.
      if (!result.refused) void this.tasks.refreshAccount();
    } catch (err) {
      this.store.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      stop();
      this.ccUpdating.set(false);
    }
  }

  protected clockOf(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  protected async testConnection(): Promise<void> {
    this.testing.set(true);
    try {
      this.testResult.set(await api().testConnection(this.settings().claudeCode.binaryPath));
    } catch (err) {
      this.store.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.testing.set(false);
    }
  }

  protected async save(): Promise<void> {
    await this.store.save();
  }

  // --- test-result formatting ---------------------------------------------

  protected get autoDetectedLabel(): string {
    return 'Auto-detect from PATH';
  }

  protected planLabel(result: TestConnectionResult): string {
    const plan = result.auth.subscriptionType;
    if (!plan) return '—';
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }

  /** SPEC.md §3.3: state which overage case applies to this account, or say it is unknown. */
  protected overageLabel(result: TestConnectionResult): string {
    const { overage } = result;
    if (!overage.known) return 'Unknown — no rate-limit event was reported.';
    if (overage.overageStatus === 'rejected') {
      const reason = overage.overageDisabledReason ? ` (${overage.overageDisabledReason})` : '';
      return `Beyond-plan usage is refused, not billed${reason}.`;
    }
    if (overage.isUsingOverage) return 'Currently using usage credits — beyond-plan usage is billed.';
    return `Beyond-plan usage may be billed to usage credits (overage ${overage.overageStatus ?? 'unknown'}).`;
  }

  protected resetsAtLabel(result: TestConnectionResult): string | null {
    const seconds = result.overage.resetsAt;
    if (!seconds) return null;
    return new Date(seconds * 1000).toLocaleString();
  }

  protected checkedAtLabel(result: TestConnectionResult): string {
    return `checked ${new Date(result.checkedAt).toLocaleTimeString()} · ${result.durationMs} ms`;
  }
}
