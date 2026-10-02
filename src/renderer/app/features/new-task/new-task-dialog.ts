/**
 * New task modal (SPEC.md §10, design "New task modal"): project folder (Electron folder picker),
 * description, model + effort per agent with the §8 warnings, max cycles, planner context mode and
 * approval mode. Every other Task default (SPEC.md §11) can be overridden under "More options".
 *
 * Pre-filled from the saved Task defaults. The main process validates and creates the task; this
 * component only collects values.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';

import { storageKey } from '../../../../shared/app-config';
import type { CreateTaskRequest, ProjectInspection } from '../../../../shared/ipc';
import {
  FABLE_WARNING,
  MAX_EFFORT_WARNING,
  PICKER_MODELS,
  coerceEffort,
  effortOnModelChange,
  effortsFor,
  getModel,
  modelDisplay,
  modelVersionBlock,
  rolloverThresholdFor,
  type EffortLevel,
} from '../../../../shared/models';
import {
  FRESH_EXECUTOR_DEFAULT_TURNS,
  FRESH_EXECUTOR_MAX_TURNS,
  type ApprovalMode,
  type PlannerContextMode,
} from '../../../../shared/settings';
import type { AgentRole } from '../../../../shared/task-model';
import { formatTokens } from '../../../../shared/format';
import { api } from '../../core/api';
import { SettingsStore } from '../../core/settings-store';
import { TasksStore } from '../../core/tasks-store';

const LAST_FOLDER_KEY = storageKey('lastProjectFolder');
const INSPECT_DEBOUNCE_MS = 300;

interface AgentChoice {
  model: string;
  effort: EffortLevel | null;
}

const APPROVAL_MODES: ReadonlyArray<{ id: ApprovalMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Runs unattended; stops only on questions, limits or errors.' },
  { id: 'review', label: 'Review', hint: 'Review each Planner instruction before it is sent to the Executor.' },
  { id: 'plan_first', label: 'Plan first', hint: 'The Planner proposes a full plan; after you approve it once, the task runs in Auto.' },
];

function readLastFolder(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

@Component({
  selector: 'app-new-task-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKey($event)' },
  template: `
    <div class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="nt-title">
        <div class="top">
          <span id="nt-title" class="title">New task</span>
          <button type="button" class="close" aria-label="Close" [disabled]="submitting()" (click)="close()">✕</button>
        </div>

        <div class="body">
          <!-- Project folder -->
          <div class="field">
            <label class="label" for="nt-folder">Project folder</label>
            <div class="row">
              <input
                id="nt-folder"
                class="input mono"
                spellcheck="false"
                placeholder="C:\\src\\my-project"
                [value]="folder()"
                (input)="setFolder($any($event.target).value)"
              />
              <button type="button" class="btn" (click)="browse()">Browse…</button>
            </div>
            <span class="hint" [class.bad]="folderTone() === 'bad'" [class.warn]="folderTone() === 'warn'">{{ folderLine() }}</span>
            @if (remoteWarning()) {
              <span class="hint warn">{{ remoteWarning() }}</span>
            }
          </div>

          <!-- Description -->
          <div class="field">
            <label class="label" for="nt-desc">Task description</label>
            <textarea
              #description
              id="nt-desc"
              class="textarea desc"
              placeholder="What should the Planner and Executor achieve? The first line becomes the task's title."
              [value]="descriptionText()"
              (input)="descriptionText.set($any($event.target).value)"
            ></textarea>
          </div>

          <!-- Models -->
          <div class="grid-2">
            @for (agent of agents; track agent) {
              @let choice = agent === 'planner' ? planner() : executor();
              @let efforts = effortsOf(choice.model);
              <div class="field">
                <label class="label" [class.planner]="agent === 'planner'" [class.executor]="agent === 'executor'">
                  <span class="dot"></span>{{ agent === 'planner' ? 'Planner' : 'Executor' }} model
                </label>
                <div class="row">
                  <select class="select" [attr.aria-label]="agent + ' model'" [attr.title]="modelNote(choice.model)" (change)="setModel(agent, $any($event.target).value)">
                    @for (m of models; track m.id) {
                      <option [value]="m.id" [selected]="m.id === choice.model">{{ modelText(m.id) }}</option>
                    }
                  </select>
                  @if (efforts.length > 0) {
                    <select class="select effort" [attr.aria-label]="agent + ' effort'" (change)="setEffort(agent, $any($event.target).value)">
                      @for (level of efforts; track level) {
                        <option [value]="level" [selected]="level === choice.effort">{{ level }}</option>
                      }
                    </select>
                  } @else {
                    <span class="input disabled effort" title="This model has no effort control">no effort</span>
                  }
                </div>
                @if (fableBlock(choice.model); as block) {
                  <div class="callout danger">{{ block }}</div>
                } @else if (isFable(choice.model)) {
                  <div class="callout danger">{{ fableWarning }}</div>
                }
                @if (choice.effort === 'max') {
                  <div class="callout warn">{{ maxWarning }}</div>
                }
              </div>
            }
          </div>

          <!-- Cycles + planner context -->
          <div class="grid-2 top-align">
            <div class="field">
              <label class="label">Max cycles</label>
              <div class="stepper">
                <button type="button" aria-label="Fewer cycles" (click)="stepCycles(-1)">−</button>
                <input
                  class="step-input"
                  type="number"
                  min="1"
                  max="500"
                  aria-label="Max cycles"
                  [value]="maxCycles()"
                  (change)="setCycles($any($event.target).value)"
                />
                <button type="button" aria-label="More cycles" (click)="stepCycles(1)">+</button>
              </div>
            </div>
            <div class="field">
              <label class="label">Planner context</label>
              <div class="seg">
                @for (mode of contextModes; track mode.id) {
                  <button type="button" [attr.aria-pressed]="contextMode() === mode.id" (click)="contextMode.set(mode.id)">{{ mode.label }}</button>
                }
              </div>
              <span class="hint">{{ contextMode() === 'read_only' ? 'The Planner may read the project (Read, Glob, Grep).' : 'The Planner sees only the Executor’s reports.' }} Fixed once the task is created.</span>
            </div>
          </div>

          <!-- Approval mode -->
          <div class="approval">
            <div class="row-text">
              <span class="row-title">Approval mode</span>
              <span class="row-sub">{{ approvalHint() }}</span>
            </div>
            <div class="seg approval-seg">
              @for (mode of approvalModes; track mode.id) {
                <button type="button" [attr.aria-pressed]="approval() === mode.id" (click)="approval.set(mode.id)">{{ mode.label }}</button>
              }
            </div>
          </div>

          <!-- More options (the rest of SPEC.md §11 Task defaults) -->
          <button type="button" class="more" [attr.aria-expanded]="moreOpen()" (click)="moreOpen.set(!moreOpen())">
            <span class="chev">{{ moreOpen() ? '▾' : '▸' }}</span> More options
            <span class="more-sub">timeouts, steps, rollover, required skills, git, standing instructions</span>
          </button>
          @if (moreOpen()) {
            <div class="more-body">
              <div class="grid-4">
                <div class="field">
                  <label class="label" for="nt-timeout">Turn timeout</label>
                  <div class="suffixed">
                    <input id="nt-timeout" class="input mono" type="number" min="1" max="600" [value]="timeoutMin()" (change)="timeoutMin.set(clamp($any($event.target).value, 1, 600, timeoutMin()))" />
                    <span class="suffix">min</span>
                  </div>
                </div>
                <div class="field">
                  <label class="label" for="nt-slow">Slow-turn warning</label>
                  <div class="suffixed">
                    <input id="nt-slow" class="input mono" type="number" min="1" max="600" [value]="slowMin()" (change)="slowMin.set(clamp($any($event.target).value, 1, 600, slowMin()))" />
                    <span class="suffix">min</span>
                  </div>
                </div>
                <div class="field">
                  <label class="label" for="nt-steps">Max steps per turn</label>
                  <input id="nt-steps" class="input mono" type="number" min="1" max="1000" [value]="steps()" (change)="steps.set(clamp($any($event.target).value, 1, 1000, steps()))" />
                </div>
                <div class="field">
                  <label class="label" for="nt-rollover">Rollover at</label>
                  <div class="suffixed">
                    <input id="nt-rollover" class="input mono" type="number" min="5" max="95" [value]="rollover()" (change)="rollover.set(clamp($any($event.target).value, 5, 95, rollover()))" />
                    <span class="suffix">%</span>
                  </div>
                </div>
              </div>
              <span class="hint mono">
                rollover: Planner {{ threshold(planner().model) }} · Executor {{ threshold(executor().model) }} tokens
                @if (slowMin() >= timeoutMin()) {
                  · <strong>the slow-turn warning is not below the timeout, so it has no effect</strong>
                }
              </span>

              <div class="field">
                <label class="label">Required skills before done</label>
                <div class="skill-chips">
                  @for (skill of skills(); track skill) {
                    <span class="skill-chip">
                      {{ skill }}
                      <button type="button" [attr.aria-label]="'Remove ' + skill" (click)="removeSkill(skill)">×</button>
                    </span>
                  }
                  <input
                    class="skill-input mono"
                    placeholder="+ add"
                    aria-label="Add a required skill"
                    [value]="skillDraft()"
                    (input)="skillDraft.set($any($event.target).value)"
                    (keydown.enter)="$event.preventDefault(); addSkill()"
                    (blur)="addSkill()"
                  />
                </div>
                <span class="hint">The task cannot finish until the Executor has run these successfully (or you waive one that cannot run here).</span>
              </div>

              <div class="toggle-row">
                <div class="row-text">
                  <span class="row-title">Auto-branch and commit per cycle</span>
                  <span class="row-sub">Works on a new branch and commits after every ok cycle.</span>
                </div>
                <button type="button" class="toggle" [attr.aria-pressed]="autoCommit()" aria-label="Auto-branch and commit" (click)="autoCommit.set(!autoCommit())"><span></span></button>
              </div>

              <div class="toggle-row">
                <div class="row-text">
                  <span class="row-title">Fresh Executor session after rejected answers</span>
                  <span class="row-sub">After this many Executor turns in a row with a rejected structured answer, the next one starts in a fresh session.</span>
                </div>
                @if (freshAfter(); as turns) {
                  <div class="suffixed">
                    <input class="input mono fresh-turns" type="number" min="1" [max]="freshMax" aria-label="Turns with rejected answers" [value]="turns" (change)="freshAfter.set(clamp($any($event.target).value, 1, freshMax, turns))" />
                    <span class="suffix">turns</span>
                  </div>
                }
                <button type="button" class="toggle" [attr.aria-pressed]="freshAfter() !== null" aria-label="Fresh Executor session after rejected answers" (click)="toggleFreshAfter()"><span></span></button>
              </div>

              <div class="field">
                <label class="label">Standing instructions <span class="hint">— appended to each agent's system prompt; editable later for new sessions</span></label>
                <label class="label planner" for="nt-sp-planner"><span class="dot"></span>Planner</label>
                <textarea id="nt-sp-planner" class="textarea sp" [value]="standing().planner" (input)="setStanding('planner', $any($event.target).value)"></textarea>
                <label class="label executor" for="nt-sp-executor"><span class="dot"></span>Executor</label>
                <textarea id="nt-sp-executor" class="textarea sp" [value]="standing().executor" (input)="setStanding('executor', $any($event.target).value)"></textarea>
              </div>
            </div>
          }

          @if (running(); as other) {
            <div class="callout warn">
              A task is already running:
              <button type="button" class="link" (click)="openRunning(other.id)">{{ other.title }}</button>.
              Tasks run one at a time, so this one is saved as a draft — start it once that one is paused or finished.
            </div>
          }
          @if (error(); as err) {
            <div class="callout danger" role="alert">
              {{ err.message }}
              @if (err.nextStep) {
                <span class="next">{{ err.nextStep }}</span>
              }
            </div>
          }
        </div>

        <div class="foot">
          <span class="kbd">Ctrl+Enter</span>
          <button type="button" class="btn" [disabled]="submitting()" (click)="close()">Cancel</button>
          <button type="button" class="btn btn-accent" [disabled]="!canSubmit()" (click)="submit()">
            {{ submitting() ? 'Creating…' : running() ? 'Create draft' : 'Start task' }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 50;
        background: rgba(0, 0, 0, 0.55);
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .dialog {
        width: 640px;
        max-width: 100%;
        max-height: calc(100vh - 48px);
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border);
        flex: none;
      }
      .title {
        font-size: 14px;
        font-weight: 600;
      }
      .close {
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 13px;
      }
      .close:hover {
        color: var(--text);
      }
      .body {
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow-y: auto;
        min-height: 0;
      }
      .body > * {
        flex: none;
      }
      .row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .row .input {
        flex: 1;
        font-size: 12px;
      }
      .hint.bad {
        color: var(--danger);
      }
      .hint.warn {
        color: var(--executor);
      }
      .desc {
        min-height: 96px;
        font-size: 13px;
        color: var(--text);
      }
      .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .grid-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
      }
      .grid-4 {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      .top-align {
        align-items: start;
      }
      .effort {
        width: 104px;
        flex: none;
      }
      .input.disabled {
        display: flex;
        align-items: center;
        color: var(--text-muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .select {
        min-width: 0;
      }
      .stepper .step-input {
        flex: 1;
        width: 100%;
        min-width: 0;
        height: 100%;
        border: 0;
        background: transparent;
        text-align: center;
        font-family: var(--font-mono);
        outline: 0;
        -moz-appearance: textfield;
      }
      .step-input::-webkit-outer-spin-button,
      .step-input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .approval,
      .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-card);
      }
      .approval-seg {
        width: 260px;
        flex: none;
      }
      .more {
        display: flex;
        align-items: baseline;
        gap: 6px;
        border: 0;
        background: transparent;
        color: var(--text-2);
        font-weight: 500;
        cursor: pointer;
        padding: 0;
        text-align: left;
      }
      .chev {
        font-size: 10px;
        color: var(--text-3);
        width: 10px;
      }
      .more-sub {
        font-size: 11px;
        font-weight: 400;
        color: var(--text-muted);
      }
      .more-body {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding-left: 16px;
        border-left: 2px solid var(--border);
      }
      .suffixed {
        position: relative;
      }
      .toggle-row .suffixed {
        margin-left: auto;
        flex: none;
      }
      .fresh-turns {
        width: 104px;
        padding-right: 46px;
      }
      .suffixed .suffix {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-muted);
        font-size: 12px;
        pointer-events: none;
      }
      .skill-chips {
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        background: var(--bg-input);
        padding: 6px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font: 11.5px var(--font-mono);
      }
      .skill-chip {
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--bg-button);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .skill-chip button {
        border: 0;
        background: transparent;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        padding: 0;
      }
      .skill-input {
        flex: 1;
        min-width: 80px;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text);
        font: inherit;
      }
      .sp {
        min-height: 56px;
      }
      .link {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--planner);
        font: inherit;
        font-weight: 600;
        text-decoration: underline;
        cursor: pointer;
      }
      .callout .next {
        display: block;
        margin-top: 2px;
        color: var(--text-2);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--border);
        background: var(--bg);
        flex: none;
      }
      .kbd {
        margin-right: auto;
        font: 11px var(--font-mono);
        color: var(--text-muted);
      }
    `,
  ],
})
export class NewTaskDialog {
  private readonly settings = inject(SettingsStore);
  private readonly store = inject(TasksStore);
  private readonly descriptionBox = viewChild<ElementRef<HTMLTextAreaElement>>('description');

  protected readonly agents: readonly AgentRole[] = ['planner', 'executor'];
  protected readonly models = PICKER_MODELS;
  protected readonly approvalModes = APPROVAL_MODES;
  protected readonly contextModes: ReadonlyArray<{ id: PlannerContextMode; label: string }> = [
    { id: 'isolated', label: 'Isolated' },
    { id: 'read_only', label: 'Read-only project' },
  ];
  protected readonly fableWarning = FABLE_WARNING;
  protected readonly maxWarning = MAX_EFFORT_WARNING;

  // Pre-filled from the saved Task defaults (SPEC.md §11).
  private readonly defaults = this.settings.saved().taskDefaults;
  protected readonly folder = signal(readLastFolder());
  protected readonly descriptionText = signal('');
  protected readonly planner = signal<AgentChoice>({ model: this.defaults.plannerModel, effort: this.defaults.plannerEffort });
  protected readonly executor = signal<AgentChoice>({ model: this.defaults.executorModel, effort: this.defaults.executorEffort });
  protected readonly maxCycles = signal(this.defaults.maxCycles);
  protected readonly contextMode = signal<PlannerContextMode>(this.defaults.plannerContextMode);
  protected readonly approval = signal<ApprovalMode>(this.defaults.approvalMode);
  protected readonly moreOpen = signal(false);
  /** Opened from a task, so the folder and settings were carried over (SPEC.md §10). */
  protected readonly fromTask = signal(false);
  protected readonly timeoutMin = signal(this.defaults.turnTimeoutMinutes);
  protected readonly slowMin = signal(this.defaults.slowTurnWarningMinutes);
  /** "Max steps per turn" (SPEC.md §3.1), in the New task modal since 2026-09-26. */
  protected readonly steps = signal(this.defaults.maxTurnsPerSession);
  protected readonly rollover = signal(this.defaults.rolloverPercent);
  protected readonly skills = signal<string[]>([...this.defaults.requiredSkillsBeforeDone]);
  protected readonly skillDraft = signal('');
  protected readonly autoCommit = signal(this.defaults.autoBranchAndCommit);
  protected readonly freshAfter = signal<number | null>(this.defaults.freshExecutorAfterRejectedTurns);
  protected readonly freshMax = FRESH_EXECUTOR_MAX_TURNS;
  protected readonly standing = signal<Record<AgentRole, string>>({ ...this.defaults.standingPrompts });

  protected readonly inspection = signal<ProjectInspection | null>(null);
  protected readonly inspecting = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<{ message: string; nextStep?: string } | null>(null);

  private inspectTimer: ReturnType<typeof setTimeout> | null = null;
  private inspectSeq = 0;

  protected readonly running = computed(() => this.store.tasks().find((t) => t.busy) ?? null);

  protected readonly approvalHint = computed(() => APPROVAL_MODES.find((m) => m.id === this.approval())?.hint ?? '');

  protected readonly folderLine = computed(() => {
    const folder = this.folder().trim();
    const i = this.inspection();
    if (folder === '') return 'Choose the folder the Executor works in.';
    if (this.inspecting() || !i || i.path === '') return 'Checking…';
    if (!i.exists) return i.error ?? 'Folder not found.';
    if (i.error) {
      // Git could not run: not the same as "not a repository" (SPEC.md §18).
      return this.autoCommit()
        ? `${i.error} With Auto-branch and commit on, the task stops before its first turn until git works.`
        : i.error;
    }
    if (!i.isRepo) {
      return this.autoCommit()
        ? 'Not a git repository — the task will run without a branch or commits.'
        : 'Not a git repository.';
    }
    const parts = ['git', i.branch ?? 'detached HEAD'];
    parts.push(i.dirtyCount === 0 ? 'clean working tree' : `${i.dirtyCount} uncommitted ${i.dirtyCount === 1 ? 'file' : 'files'} — committed as a snapshot first`);
    parts.push(i.hasRemote ? 'remote set' : 'no remote');
    if (!this.autoCommit()) parts.push('auto-commit off');
    return parts.join(' · ');
  });

  protected readonly folderTone = computed<'ok' | 'bad' | 'warn'>(() => {
    const i = this.inspection();
    if (!i || this.folder().trim() === '' || this.inspecting()) return 'ok';
    if (!i.exists) return 'bad';
    if (i.error) return this.autoCommit() ? 'bad' : 'warn';
    return i.isRepo && i.dirtyCount > 0 ? 'warn' : 'ok';
  });

  /** SPEC.md §16: skills that diff against origin/HEAD cannot run without a remote. */
  protected readonly remoteWarning = computed(() => {
    const i = this.inspection();
    if (!i || !i.exists || this.inspecting() || !this.skills().includes('security-review')) return null;
    if (i.isRepo && i.hasRemote) return null;
    return `security-review is required, but it cannot run ${i.isRepo ? 'without a git remote' : 'outside a git repository'}. You will be asked whether to waive it for this task.`;
  });

  private readonly cliVersion = computed(() => this.store.account()?.cliVersion ?? null);

  protected readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      this.folder().trim() !== '' &&
      this.descriptionText().trim() !== '' &&
      this.inspection()?.exists !== false &&
      this.fableBlock(this.planner().model) === null &&
      this.fableBlock(this.executor().model) === null,
  );

  constructor() {
    // Opened with something already filled in (the empty state's example, or "New task in this
    // project" carrying a task's folder and settings, SPEC.md §10): take it once, then clear it,
    // so the next New task starts from the saved defaults again.
    const draft = this.store.newTaskDraft();
    if (draft) {
      this.store.newTaskDraft.set(null);
      if (draft.description) this.descriptionText.set(draft.description);
      if (draft.folder) this.folder.set(draft.folder);
      const c = draft.config;
      if (c) {
        this.planner.set({ ...c.planner });
        this.executor.set({ ...c.executor });
        this.maxCycles.set(c.maxCycles);
        this.contextMode.set(c.plannerContextMode);
        this.approval.set(c.approvalMode);
        this.timeoutMin.set(Math.round(c.turnTimeoutMs / 60_000));
        this.slowMin.set(Math.round(c.slowTurnMs / 60_000));
        this.steps.set(c.maxTurnsPerSession);
        this.rollover.set(c.rolloverPercent);
        this.skills.set([...c.requiredSkills]);
        this.autoCommit.set(c.autoBranchAndCommit);
        this.freshAfter.set(c.freshExecutorAfterRejectedTurns);
        this.standing.set({ ...c.standingInstructions });
        this.fromTask.set(true);
      }
    }
    effect(() => {
      const folder = this.folder();
      untracked(() => this.scheduleInspect(folder));
    });
    setTimeout(() => this.descriptionBox()?.nativeElement.focus());
  }

  protected effortsOf(model: string): readonly EffortLevel[] {
    return effortsFor(model);
  }

  protected isFable(model: string): boolean {
    return getModel(model)?.isFable === true;
  }

  /**
   * SPEC.md §8: Fable on a CLI below its minimum version is blocked, not just warned about. The main
   * process makes the same check before every turn, also when the version is not known here yet.
   */
  protected fableBlock(model: string): string | null {
    const version = this.cliVersion();
    if (version === null) return null;
    const block = modelVersionBlock(model, version);
    return block === null ? null : `${block} Pick another model or update Claude Code.`;
  }

  protected threshold(model: string): string {
    return formatTokens(rolloverThresholdFor(model, this.rollover(), this.cliVersion()));
  }

  /** A model as chosen: an alias as written, a full id by its name (SPEC.md §8). */
  protected modelText(model: string): string {
    return modelDisplay(model, this.cliVersion()).text;
  }

  protected modelNote(model: string): string | null {
    return modelDisplay(model, this.cliVersion()).note;
  }

  protected setModel(agent: AgentRole, model: string): void {
    const target = agent === 'planner' ? this.planner : this.executor;
    target.update((c) => ({ model, effort: effortOnModelChange(model, c.effort, this.cliVersion()) }));
  }

  protected setEffort(agent: AgentRole, effort: string): void {
    const target = agent === 'planner' ? this.planner : this.executor;
    target.update((c) => ({ ...c, effort: coerceEffort(c.model, effort as EffortLevel) }));
  }

  protected stepCycles(delta: number): void {
    this.maxCycles.update((n) => Math.min(500, Math.max(1, n + delta)));
  }

  protected setCycles(value: string): void {
    this.maxCycles.set(this.clamp(value, 1, 500, this.maxCycles()));
  }

  protected toggleFreshAfter(): void {
    this.freshAfter.update((v) => (v === null ? FRESH_EXECUTOR_DEFAULT_TURNS : null));
  }

  protected clamp(value: string, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  protected setFolder(value: string): void {
    this.folder.set(value);
  }

  protected setStanding(agent: AgentRole, value: string): void {
    this.standing.update((s) => ({ ...s, [agent]: value }));
  }

  protected addSkill(): void {
    const value = this.skillDraft().trim();
    if (value && !this.skills().includes(value)) this.skills.update((s) => [...s, value]);
    this.skillDraft.set('');
  }

  protected removeSkill(skill: string): void {
    this.skills.update((s) => s.filter((x) => x !== skill));
  }

  protected async browse(): Promise<void> {
    const result = await api().pickDirectory('Choose the project folder', this.folder().trim() || undefined);
    if (result.path) this.folder.set(result.path);
  }

  protected openRunning(taskId: string): void {
    this.close();
    this.store.openTask(taskId);
  }

  protected close(): void {
    if (this.submitting()) return;
    this.store.newTaskOpen.set(false);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.submitting.set(true);
    this.error.set(null);
    const folder = this.folder().trim();
    const request: CreateTaskRequest = {
      description: this.descriptionText().trim(),
      projectDir: folder,
      overrides: {
        planner: this.planner(),
        executor: this.executor(),
        maxCycles: this.maxCycles(),
        plannerContextMode: this.contextMode(),
        approvalMode: this.approval(),
        turnTimeoutMs: this.timeoutMin() * 60_000,
        slowTurnMs: this.slowMin() * 60_000,
        maxTurnsPerSession: this.steps(),
        rolloverPercent: this.rollover(),
        requiredSkills: this.skills(),
        autoBranchAndCommit: this.autoCommit(),
        freshExecutorAfterRejectedTurns: this.freshAfter(),
        standingInstructions: this.standing(),
      },
      // A running task would refuse the start; the new task is then kept as a draft (SPEC.md §6).
      start: this.running() === null,
    };
    try {
      const result = await this.store.createTask(request);
      if (!result.taskId) {
        this.error.set({ message: result.error ?? 'The task could not be created.', ...(result.nextStep ? { nextStep: result.nextStep } : {}) });
        return;
      }
      try {
        localStorage.setItem(LAST_FOLDER_KEY, folder);
      } catch {
        /* storage unavailable */
      }
      this.store.newTaskOpen.set(false);
    } finally {
      this.submitting.set(false);
    }
  }

  private scheduleInspect(folder: string): void {
    if (this.inspectTimer) clearTimeout(this.inspectTimer);
    const value = folder.trim();
    const seq = ++this.inspectSeq;
    if (value === '') {
      this.inspection.set(null);
      this.inspecting.set(false);
      return;
    }
    this.inspecting.set(true);
    this.inspectTimer = setTimeout(() => {
      void api()
        .inspectProject(value)
        .then((result) => {
          if (seq === this.inspectSeq) this.inspection.set(result);
        })
        .catch((err: unknown) => {
          if (seq === this.inspectSeq) {
            this.inspection.set({ path: value, exists: true, isRepo: false, branch: null, hasRemote: false, dirtyCount: 0, error: String(err) });
          }
        })
        .finally(() => {
          if (seq === this.inspectSeq) this.inspecting.set(false);
        });
    }, INSPECT_DEBOUNCE_MS);
  }
}
