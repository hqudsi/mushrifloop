/**
 * First-run setup (SPEC.md §10, phase 6 in §12).
 *
 * Shown instead of the app until it passes. Every step that can be checked *is* checked, against the
 * real CLI — a tick that only means "you read this" would be worse than nothing, because the two
 * things that actually stop a task are a missing CLI and a signed-out (or unexpected) account.
 */

import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';

import { APP_NAME } from '../../../../shared/app-config';
import type { EditorCheckResult } from '../../../../shared/ipc';
import {
  MIN_CLI_VERSION,
  PICKER_MODELS,
  coerceEffort,
  effortOnModelChange,
  effortsFor,
  isVersionBelow,
  modelDisplay,
  modelVersionBlock,
  type EffortLevel,
} from '../../../../shared/models';
import { APPROVAL_MODES, type ApprovalMode } from '../../../../shared/settings';
import { api } from '../../core/api';
import { SettingsStore } from '../../core/settings-store';
import { TasksStore } from '../../core/tasks-store';
import { AppMark } from '../../shared/app-mark';

type Agent = 'planner' | 'executor';

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [AppMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sheet">
      <header class="head">
        <app-mark [size]="40" />
        <div>
          <h1>{{ step() === 1 ? 'Welcome to ' + appName : appName + ' setup' }}</h1>
          <p class="sub">Step {{ step() }} of 4 · {{ stepTitle() }}</p>
        </div>
      </header>

      <ol class="rail">
        @for (s of steps; track s.n) {
          <li [class.on]="step() === s.n" [class.past]="step() > s.n">
            <span class="n">{{ step() > s.n ? '✓' : s.n }}</span>{{ s.title }}
          </li>
        }
      </ol>

      <section class="body">
        <!-- 1 — what this is ------------------------------------------------ -->
        @if (step() === 1) {
          <p class="lead">
            {{ appName }} runs a task as a loop between two Claude Code sessions on this computer. A
            <b>Planner</b> reads your task, decides the next single step and reviews each result, without
            touching any files. An <b>Executor</b> carries out that step in your project folder and reports
            back what it changed and what it ran.
          </p>
          <p class="lead">
            The app sits in between and keeps the limits: how many cycles, how long a turn may take, when to
            commit, which account is being used — and it stops and asks you whenever a decision is yours.
          </p>
          <div class="loop">
            <span class="chip planner">Planner plans</span>
            <span class="arrow">→</span>
            <span class="chip executor">Executor does the work</span>
            <span class="arrow">→</span>
            <span class="chip planner">Planner reviews</span>
            <span class="arrow">↻</span>
            <span class="chip you">You approve, answer, or stop</span>
          </div>
        }

        <!-- 2 — the CLI ------------------------------------------------------ -->
        @if (step() === 2) {
          <p class="lead">
            {{ appName }} does not talk to the API itself: it drives the <span class="mono">claude</span>
            command on this machine. It has to be installed, and at least version
            <span class="mono">{{ minCliVersion }}</span>.
          </p>
          @if (account(); as a) {
            @if (a.cliVersion && !cliTooOld()) {
              <div class="callout ok">
                <b>Claude Code {{ a.cliVersion }} is ready.</b>
                <div class="mono path">{{ a.cliPath }}</div>
              </div>
            } @else {
              <div class="callout danger">
                @if (a.cliVersion) {
                  <b>Claude Code {{ a.cliVersion }} is too old.</b> {{ appName }} needs
                  {{ minCliVersion }} or newer.
                } @else {
                  <b>Claude Code was not found.</b> {{ a.error ?? 'Nothing answered on PATH.' }}
                }
              </div>
              <div class="field">
                <label class="label">Install or update it, then re-check</label>
                <div class="row-controls">
                  <div class="input mono">{{ installCommand }}</div>
                  <button type="button" class="btn" (click)="copyInstall()">Copy</button>
                </div>
                @if (copied(); as c) {
                  <span class="hint">{{ c }}</span>
                }
                <span class="hint">
                  Already installed somewhere else? Settings → Claude Code connection takes an explicit path.
                </span>
              </div>
            }
          } @else {
            <div class="callout">Looking for the <span class="mono">claude</span> command…</div>
          }
        }

        <!-- 3 — signed in ---------------------------------------------------- -->
        @if (step() === 3) {
          <p class="lead">
            Turns run on whoever is signed in to Claude Code on this machine — and that account is the one
            that pays for them.
          </p>
          @if (account(); as a) {
            @if (signedIn()) {
              <div class="callout ok">
                <b>Signed in as {{ accountLabel() }}</b>
                <div class="kv">
                  <span class="k">Organisation</span><span class="v">{{ organisation() ?? '—' }}</span>
                  <span class="k">Plan</span><span class="v">{{ plan() ?? '—' }}</span>
                  <span class="k">Checked</span><span class="v">{{ checkedAt(a.checkedAt) }}</span>
                </div>
              </div>
            } @else {
              <div class="callout danger">
                <b>Nobody is signed in.</b>
                {{ a.reading && !a.reading.ok ? a.reading.error : 'Run the command below in a terminal, then re-check.' }}
              </div>
              <div class="field">
                <label class="label">Sign in, then re-check</label>
                <div class="row-controls">
                  <div class="input mono">claude auth login</div>
                  <button type="button" class="btn" (click)="copySignIn()">Copy</button>
                </div>
                @if (copied(); as c) {
                  <span class="hint">{{ c }}</span>
                }
              </div>
            }

            @if (a.seenAccounts.length > 1) {
              <div class="callout warn accounts">
                <b>More than one Claude account has been used on this machine.</b>
                <p>
                  Claude Code keeps one shared credentials file, and it can switch between accounts without
                  warning. Check that the account above is the one you mean <em>before</em> starting a task:
                  each task is pinned to the account it started on, and the bill follows it.
                </p>
                <div class="seen">
                  @for (seen of a.seenAccounts; track seen.label) {
                    <div class="row" [class.live]="seen.label === accountLabel()">
                      <span class="who mono">{{ seen.label }}</span>
                      <span class="meta">
                        {{ seen.plan ?? 'plan unknown' }}{{ seen.organisation ? ' · ' + seen.organisation : '' }}
                      </span>
                      <span class="meta when">
                        {{ seen.label === accountLabel() ? 'live now' : 'last seen ' + day(seen.lastSeen) }}
                      </span>
                    </div>
                  }
                </div>
              </div>
            }
          } @else {
            <div class="callout">Reading <span class="mono">claude auth status</span>…</div>
          }
        }

        <!-- 4 — defaults ------------------------------------------------------ -->
        @if (step() === 4) {
          <p class="lead">
            Every task can override these; they are the starting point. The Planner thinks, so it gets the
            stronger model; the Executor does the work.
          </p>
          @for (agent of agents; track agent.id) {
            <div class="field">
              <label class="label" [class.planner]="agent.id === 'planner'" [class.executor]="agent.id === 'executor'">
                <span class="dot"></span>{{ agent.label }}
              </label>
              <div class="row-controls">
                <select class="select" [value]="model(agent.id)" [attr.title]="modelNote(model(agent.id))" (change)="setModel(agent.id, $any($event.target).value)">
                  @for (m of models; track m.id) {
                    <option [value]="m.id" [selected]="m.id === model(agent.id)">{{ modelText(m.id) }}</option>
                  }
                </select>
                <select class="select narrow" [value]="effort(agent.id) ?? ''" (change)="setEffort(agent.id, $any($event.target).value)">
                  <option value="">default effort</option>
                  @for (e of effortsFor(model(agent.id)); track e) {
                    <option [value]="e" [selected]="e === effort(agent.id)">{{ e }}</option>
                  }
                </select>
              </div>
              @if (versionBlock(model(agent.id)); as blocked) {
                <span class="hint bad">{{ blocked }}</span>
              }
            </div>
          }

          <div class="field">
            <label class="label">Approval mode</label>
            <div class="modes">
              @for (mode of approvalModes; track mode.id) {
                <button
                  type="button"
                  class="mode"
                  [class.on]="approvalMode() === mode.id"
                  [attr.aria-pressed]="approvalMode() === mode.id"
                  (click)="setApprovalMode(mode.id)"
                >
                  <span class="mode-name">{{ mode.label }}</span>
                  <span class="mode-hint">{{ mode.hint }}</span>
                </button>
              }
            </div>
          </div>

          <div class="field">
            <label class="label" for="setup-editor">Open files with</label>
            <div class="row-controls">
              <input
                id="setup-editor"
                class="input mono"
                [value]="editorCommand()"
                (input)="setEditor($any($event.target).value)"
              />
              <button type="button" class="btn" [disabled]="detecting()" (click)="detectEditor()">
                {{ detecting() ? 'Checking…' : 'Detect' }}
              </button>
            </div>
            <span class="hint">
              When a task changes files, clicking a file name in the right panel opens it with this program.
            </span>
            <span class="hint">
              Type <span class="mono">code</span> for VS Code, <span class="mono">notepad</span> for Notepad,
              or the full path to any program. <span class="mono">code</span> is filled in already — leave it
              as it is if that suits you, and change it any time in Settings → General.
            </span>
            @if (editorCheck(); as check) {
              @if (check.ok) {
                <span class="hint good">Found {{ check.program }} at {{ check.path }}</span>
              } @else {
                <span class="hint bad">{{ check.error }}</span>
              }
            }
          </div>
        }

        @if (store.error(); as error) {
          <div class="callout danger">{{ error }}</div>
        }
      </section>

      <footer class="foot">
        <button type="button" class="btn" [disabled]="step() === 1" (click)="back()">Back</button>
        <span class="spacer"></span>
        @if (step() === 2 || step() === 3) {
          <button type="button" class="btn" [disabled]="checking()" (click)="recheck()">
            {{ checking() ? 'Checking…' : 'Re-check' }}
          </button>
        }
        @if (step() < 4) {
          <button type="button" class="btn btn-accent" [disabled]="!canContinue()" (click)="next()">Continue</button>
        } @else {
          <button type="button" class="btn btn-accent" [disabled]="store.saving()" (click)="finish()">
            {{ store.saving() ? 'Saving…' : 'Start using ' + appName }}
          </button>
        }
      </footer>
    </div>
  `,
  styles: [
    `
      :host {
        flex: 1;
        min-height: 0;
        display: flex;
        justify-content: center;
        overflow-y: auto;
        background: var(--bg);
      }
      .sheet {
        width: 100%;
        max-width: 720px;
        padding: 36px 32px 32px;
        display: flex;
        flex-direction: column;
        gap: 22px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      h1 {
        font-size: 19px;
        font-weight: 600;
      }
      .sub {
        margin-top: 3px;
        color: var(--text-3);
        font-size: 12px;
      }
      .rail {
        display: flex;
        gap: 8px;
        list-style: none;
        flex-wrap: wrap;
      }
      .rail li {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 5px 11px 5px 6px;
        border: 1px solid var(--border);
        border-radius: 20px;
        color: var(--text-muted);
        font-size: 11.5px;
      }
      .rail li.on {
        border-color: var(--planner);
        color: var(--text);
      }
      .rail li.past {
        color: var(--text-3);
      }
      .rail .n {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--bg-button);
        font-size: 10.5px;
      }
      .rail li.on .n {
        background: var(--planner);
        color: var(--on-accent);
      }
      .body {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-height: 300px;
      }
      .lead {
        line-height: 1.65;
        color: var(--text-2);
      }
      .loop {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--bg-card);
      }
      .chip {
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 12px;
      }
      .chip.planner {
        background: var(--planner-bg);
        color: var(--planner);
      }
      .chip.executor {
        background: var(--executor-bg);
        color: var(--executor);
      }
      .chip.you {
        background: var(--waiting-bg);
        color: var(--waiting);
      }
      .arrow {
        color: var(--text-muted);
      }
      .callout.ok {
        border-color: var(--success);
        background: var(--success-bg);
        color: var(--success);
      }
      .callout .path,
      .callout .kv {
        margin-top: 6px;
        color: var(--text-2);
        font-size: 11.5px;
        overflow-wrap: anywhere;
      }
      .kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 2px 14px;
      }
      .kv .k {
        color: var(--text-muted);
      }
      .accounts p {
        margin: 6px 0 10px;
        line-height: 1.55;
        color: var(--text-2);
      }
      .seen {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .seen .row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 10px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--bg);
      }
      .seen .row.live {
        border-color: var(--success);
      }
      .seen .who {
        font-size: 12px;
        color: var(--text);
      }
      .seen .meta {
        font-size: 11px;
        color: var(--text-muted);
      }
      .seen .when {
        margin-left: auto;
      }
      .modes {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .mode {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 9px 12px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--bg-card);
        color: inherit;
        text-align: left;
        cursor: pointer;
        font: inherit;
      }
      .mode.on {
        border-color: var(--planner);
        background: var(--planner-bg);
      }
      .mode-name {
        font-weight: 500;
        font-size: 12.5px;
      }
      .mode-hint {
        color: var(--text-3);
        font-size: 11.5px;
      }
      .select.narrow {
        width: 150px;
        flex: none;
      }
      .hint.bad {
        color: var(--danger);
      }
      .hint.good {
        color: var(--success);
      }
      .foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 4px;
        border-top: 1px solid var(--border);
        padding-top: 16px;
      }
      .spacer {
        flex: 1;
      }
    `,
  ],
})
export class SetupScreen {
  protected readonly store = inject(SettingsStore);
  private readonly tasks = inject(TasksStore);

  /** Setup is finished, or its checks now pass: show the app. */
  readonly done = output<void>();

  protected readonly appName = APP_NAME;
  protected readonly minCliVersion = MIN_CLI_VERSION;
  protected readonly installCommand = INSTALL_COMMAND;
  protected readonly models = PICKER_MODELS;
  protected readonly approvalModes = APPROVAL_MODES;
  protected readonly agents: readonly { id: Agent; label: string }[] = [
    { id: 'planner', label: 'Planner — plans and reviews' },
    { id: 'executor', label: 'Executor — does the work' },
  ];
  protected readonly steps = [
    { n: 1, title: 'What this is' },
    { n: 2, title: 'Claude Code' },
    { n: 3, title: 'Signed in' },
    { n: 4, title: 'Defaults' },
  ];

  protected readonly step = signal(1);
  protected readonly checking = signal(false);
  protected readonly copied = signal<string | null>(null);

  protected readonly account = computed(() => this.tasks.account());
  protected readonly stepTitle = computed(() => this.steps.find((s) => s.n === this.step())?.title ?? '');

  protected readonly cliTooOld = computed(() => isVersionBelow(this.account()?.cliVersion ?? null, MIN_CLI_VERSION));
  protected readonly cliOk = computed(() => {
    const a = this.account();
    return !!a && a.cliVersion !== null && !this.cliTooOld();
  });

  protected readonly signedIn = computed(() => {
    const reading = this.account()?.reading;
    return reading?.ok === true && reading.loggedIn;
  });
  protected readonly accountLabel = computed(() => {
    const reading = this.account()?.reading;
    if (!reading?.ok || !reading.loggedIn) return null;
    return reading.account.email ?? (reading.account.apiKeySource ? `API key (${reading.account.apiKeySource})` : '(no email)');
  });
  protected readonly organisation = computed(() => {
    const reading = this.account()?.reading;
    return reading?.ok ? reading.account.orgName : null;
  });
  protected readonly plan = computed(() => {
    const a = this.account();
    // The mid-switch guard (SPEC.md §10): say the plan is unknown rather than name the wrong one.
    if (a?.planUncertain) return 'plan: unknown — the CLI is mid-switch';
    return a?.reading?.ok ? a.reading.account.subscriptionType : null;
  });

  /** Steps 2 and 3 are the ones that block: the app cannot run a task without them. */
  protected readonly canContinue = computed(() => {
    if (this.step() === 2) return this.cliOk();
    if (this.step() === 3) return this.signedIn();
    return true;
  });

  protected checkedAt(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  protected day(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
  }

  protected next(): void {
    this.copied.set(null);
    this.step.update((n) => Math.min(4, n + 1));
    if (this.step() === 2 || this.step() === 3) void this.recheck();
  }

  protected back(): void {
    this.copied.set(null);
    this.step.update((n) => Math.max(1, n - 1));
  }

  protected async recheck(): Promise<void> {
    this.checking.set(true);
    try {
      await this.tasks.refreshAccount();
    } finally {
      this.checking.set(false);
    }
  }

  protected async copyInstall(): Promise<void> {
    await this.copy(INSTALL_COMMAND);
  }

  protected async copySignIn(): Promise<void> {
    await this.copy('claude auth login');
  }

  private async copy(text: string): Promise<void> {
    const result = await api().copyText(text);
    this.copied.set(result.ok ? 'Copied — paste it into a terminal.' : (result.error ?? 'Could not copy.'));
  }

  // --- step 4: the defaults themselves --------------------------------------

  protected model(agent: Agent): string {
    const d = this.store.draft().taskDefaults;
    return agent === 'planner' ? d.plannerModel : d.executorModel;
  }

  protected effort(agent: Agent): EffortLevel | null {
    const d = this.store.draft().taskDefaults;
    return agent === 'planner' ? d.plannerEffort : d.executorEffort;
  }

  protected effortsFor(modelId: string): readonly EffortLevel[] {
    return effortsFor(modelId);
  }

  protected versionBlock(modelId: string): string | null {
    return modelVersionBlock(modelId, this.account()?.cliVersion ?? null);
  }

  /** A model as chosen: an alias as written, a full id by its name (SPEC.md §8). */
  protected modelText(modelId: string): string {
    return modelDisplay(modelId, this.account()?.cliVersion ?? null).text;
  }

  /** The tooltip for an alias: what it runs now and how to pin one. Null for a full id. */
  protected modelNote(modelId: string): string | null {
    return modelDisplay(modelId, this.account()?.cliVersion ?? null).note;
  }

  protected setModel(agent: Agent, modelId: string): void {
    const cli = this.account()?.cliVersion ?? null;
    this.store.update((d) => {
      if (agent === 'planner') {
        d.taskDefaults.plannerModel = modelId;
        d.taskDefaults.plannerEffort = effortOnModelChange(modelId, d.taskDefaults.plannerEffort, cli);
      } else {
        d.taskDefaults.executorModel = modelId;
        d.taskDefaults.executorEffort = effortOnModelChange(modelId, d.taskDefaults.executorEffort, cli);
      }
    });
  }

  protected setEffort(agent: Agent, value: string): void {
    const effort = (value === '' ? null : value) as EffortLevel | null;
    this.store.update((d) => {
      if (agent === 'planner') d.taskDefaults.plannerEffort = effort;
      else d.taskDefaults.executorEffort = effort;
    });
  }

  protected approvalMode(): ApprovalMode {
    return this.store.draft().taskDefaults.approvalMode;
  }

  protected setApprovalMode(mode: ApprovalMode): void {
    this.store.update((d) => {
      d.taskDefaults.approvalMode = mode;
    });
  }

  protected editorCommand(): string {
    return this.store.draft().general.editorCommand;
  }

  /**
   * "Detect" (SPEC.md §11): does this command resolve to a program that exists? The default `code`
   * is not on PATH for anyone without VS Code, and without this the failure only showed up much
   * later, when a file was clicked (reported 2026-09-20). Nothing is spawned.
   */
  protected readonly editorCheck = signal<EditorCheckResult | null>(null);
  protected readonly detecting = signal(false);

  protected async detectEditor(): Promise<void> {
    this.detecting.set(true);
    try {
      this.editorCheck.set(await api().checkEditor(this.editorCommand()));
    } catch (err) {
      this.editorCheck.set({ ok: false, program: null, path: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.detecting.set(false);
    }
  }

  protected setEditor(value: string): void {
    this.store.update((d) => {
      d.general.editorCommand = value;
      this.editorCheck.set(null);
    });
  }

  protected async finish(): Promise<void> {
    this.store.update((d) => {
      d.general.setupCompleted = true;
    });
    await this.store.save();
    if (this.store.error() === null) this.done.emit();
  }
}
