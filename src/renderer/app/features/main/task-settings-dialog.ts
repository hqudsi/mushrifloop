/**
 * "Task settings" on a task that is under way (SPEC.md §6, decided 2026-09-22).
 *
 * Max cycles, required skills, auto-commit and rollover percent apply at once; the turn limits (timeout, slow-turn
 * warning, max steps) and the fresh-Executor rule from the next turn (added 2026-09-26). Model and effort apply from
 * the agent's next turn, one of two ways, and the dialog says what each costs before anything is saved:
 * the same conversation (kept, but the first turn on a different model reads it without the cache), or a
 * fresh session (a handoff turn on the current model, then the new model from the summary; fine detail is
 * lost). The orchestrator checks everything again and refuses the whole update if any part is wrong.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';

import { formatTokens } from '../../../../shared/format';
import {
  FABLE_WARNING,
  MAX_EFFORT_WARNING,
  PICKER_MODELS,
  effortOnModelChange,
  effortsFor,
  getModel,
  modelDisplay,
  modelVersionBlock,
  rolloverThresholdFor,
  type EffortLevel,
} from '../../../../shared/models';
import { FRESH_EXECUTOR_DEFAULT_TURNS, FRESH_EXECUTOR_MAX_TURNS } from '../../../../shared/settings';
import type { AgentConfig, AgentRole, ConfigUpdate, ModelChangeMode, TaskRecord } from '../../../../shared/task-model';
import { TasksStore } from '../../core/tasks-store';

const AGENTS: readonly AgentRole[] = ['planner', 'executor'];
const AGENT_LABEL: Record<AgentRole, string> = { planner: 'Planner', executor: 'Executor' };

@Component({
  selector: 'app-task-settings-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close()' },
  template: `
    <div class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="ts-title">
        <div class="top">
          <span id="ts-title" class="title">Task settings</span>
          <button type="button" class="close" aria-label="Close" [disabled]="saving()" (click)="close()">✕</button>
        </div>

        <div class="body">
          <p class="lead">These apply to this task only, while it runs. Settings → Task defaults is where new tasks get theirs.</p>

          <!-- Models -->
          <div class="grid-2">
            @for (agent of agents; track agent) {
              @let choice = agentChoice(agent);
              @let efforts = effortsOf(choice.model);
              <div class="field">
                <label class="label" [class.planner]="agent === 'planner'" [class.executor]="agent === 'executor'">
                  <span class="dot"></span>{{ label(agent) }} model
                </label>
                <div class="row">
                  <select class="select" [attr.aria-label]="label(agent) + ' model'" [attr.title]="modelNote(choice.model)" (change)="setModel(agent, $any($event.target).value)">
                    @for (m of models; track m.id) {
                      <option [value]="m.id" [selected]="m.id === choice.model">{{ modelText(m.id) }}</option>
                    }
                  </select>
                  @if (efforts.length > 0) {
                    <select class="select effort" [attr.aria-label]="label(agent) + ' effort'" (change)="setEffort(agent, $any($event.target).value)">
                      @for (level of efforts; track level) {
                        <option [value]="level" [selected]="level === choice.effort">{{ level }}</option>
                      }
                    </select>
                  } @else {
                    <span class="input disabled effort" title="This model has no effort control">no effort</span>
                  }
                </div>
                @if (versionBlock(choice.model); as block) {
                  <div class="callout danger">{{ block }}</div>
                } @else if (isFable(choice.model)) {
                  <div class="callout danger">{{ fableWarning }}</div>
                }
                @if (choice.effort === 'max') {
                  <div class="callout warn">{{ maxWarning }}</div>
                }
                <span class="hint mono">{{ sessionLine(agent) }}</span>
              </div>
            }
          </div>

          @if (modeMatters()) {
            <div class="field">
              <label class="label">How to apply the model change</label>
              <div class="radio-list">
                <button type="button" [attr.aria-pressed]="mode() === 'same_session'" (click)="mode.set('same_session')">
                  <span class="radio-mark"></span>
                  <span class="radio-body">
                    <span class="row-title">Same conversation <span class="muted">— default</span></span>
                    <span class="row-sub">
                      From {{ changedWho() }} next turn, in the session it has now, so it keeps everything it has seen.
                      No extra turn — but the first turn on a different model cannot use the cache the old one built, so
                      it reads the whole conversation again. The longer the session, the more that one turn costs.
                    </span>
                  </span>
                </button>
                <button type="button" [attr.aria-pressed]="mode() === 'fresh_session'" (click)="mode.set('fresh_session')">
                  <span class="radio-mark"></span>
                  <span class="radio-body">
                    <span class="row-title">Fresh session</span>
                    <span class="row-sub">
                      Before {{ changedWho() }} next turn, its current session writes a handoff summary — one extra
                      turn, on the model it runs now — and the new model starts from that summary. Cheaper to carry
                      forward on a long session, but fine detail that is not in the summary is lost.
                    </span>
                  </span>
                </button>
              </div>
              <span class="hint">Neither interrupts a turn that is already running: it finishes on the model it started with.</span>
            </div>
          }

          <div class="grid-2">
            <div class="field">
              <label class="label" for="ts-cycles">Max cycles</label>
              <input
                id="ts-cycles"
                class="input mono"
                type="number"
                [min]="minCycles()"
                max="500"
                [value]="maxCycles()"
                (change)="maxCycles.set(clamp($any($event.target).value, minCycles(), 500, maxCycles()))"
              />
              @if (maxCycles() === task().cycles) {
                <span class="hint warn">
                  This task has run {{ task().cycles }} cycles, so it will stop at this limit before its next one.
                </span>
              } @else {
                <span class="hint">At least {{ minCycles() }}: this task has run {{ task().cycles }}.</span>
              }
            </div>
            <div class="field">
              <label class="label" for="ts-rollover">Rollover at</label>
              <div class="suffixed">
                <input
                  id="ts-rollover"
                  class="input mono"
                  type="number"
                  min="5"
                  max="95"
                  [value]="rollover()"
                  (change)="rollover.set(clamp($any($event.target).value, 5, 95, rollover()))"
                />
                <span class="suffix">%</span>
              </div>
              <span class="hint mono">
                Planner {{ threshold(agentChoice('planner').model) }} · Executor {{ threshold(agentChoice('executor').model) }} tokens
              </span>
            </div>
          </div>

          <!-- Turn limits (SPEC.md §6): read when a turn starts. -->
          <div class="field">
            <div class="grid-3">
              <div class="field">
                <label class="label" for="ts-timeout">Turn timeout</label>
                <div class="suffixed">
                  <input
                    id="ts-timeout"
                    class="input mono"
                    type="number"
                    min="1"
                    max="600"
                    [value]="timeoutMin()"
                    (change)="timeoutMin.set(clamp($any($event.target).value, 1, 600, timeoutMin()))"
                  />
                  <span class="suffix">min</span>
                </div>
              </div>
              <div class="field">
                <label class="label" for="ts-slow">Slow-turn warning</label>
                <div class="suffixed">
                  <input
                    id="ts-slow"
                    class="input mono"
                    type="number"
                    min="1"
                    max="600"
                    [value]="slowMin()"
                    (change)="slowMin.set(clamp($any($event.target).value, 1, 600, slowMin()))"
                  />
                  <span class="suffix">min</span>
                </div>
              </div>
              <div class="field">
                <label class="label" for="ts-steps">Max steps per turn</label>
                <input
                  id="ts-steps"
                  class="input mono"
                  type="number"
                  min="1"
                  max="1000"
                  [value]="steps()"
                  (change)="steps.set(clamp($any($event.target).value, 1, 1000, steps()))"
                />
              </div>
            </div>
            <span class="hint">
              From the next turn; a turn already running keeps the limits it started with.
              @if (slowMin() >= timeoutMin()) {
                <strong>The slow-turn warning is not below the timeout, so it has no effect.</strong>
              }
            </span>
          </div>

          <div class="toggle-row">
            <div class="row-text">
              <span class="row-title">Fresh Executor session after rejected answers</span>
              <span class="row-sub">
                After this many Executor turns in a row with a rejected structured answer, the next one starts in a fresh
                session. Checked after every Executor turn, from the next one.
              </span>
            </div>
            @if (freshAfter(); as turns) {
              <div class="suffixed">
                <input
                  class="input mono fresh-turns"
                  type="number"
                  min="1"
                  [max]="freshMax"
                  aria-label="Turns with rejected answers"
                  [value]="turns"
                  (change)="freshAfter.set(clamp($any($event.target).value, 1, freshMax, turns))"
                />
                <span class="suffix">turns</span>
              </div>
            }
            <button
              type="button"
              class="toggle"
              [attr.aria-pressed]="freshAfter() !== null"
              aria-label="Fresh Executor session after rejected answers"
              (click)="toggleFreshAfter()"
            >
              <span></span>
            </button>
          </div>

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
            <span class="hint">Checked from now on: the task cannot finish until the Executor has run these (or you waive one that cannot run here).</span>
          </div>

          <div class="toggle-row">
            <div class="row-text">
              <span class="row-title">Auto-commit per cycle</span>
              <span class="row-sub">
                @if (canTurnCommitOn()) {
                  Commits on this task's branch after every ok cycle, from the next one.
                } @else {
                  This task started without its own branch, so turning it on would commit to whatever branch is checked out. It can only be turned on for a task that started with it.
                }
              </span>
            </div>
            <button
              type="button"
              class="toggle"
              [attr.aria-pressed]="autoCommit()"
              aria-label="Auto-commit per cycle"
              [disabled]="!autoCommit() && !canTurnCommitOn()"
              (click)="autoCommit.set(!autoCommit())"
            >
              <span></span>
            </button>
          </div>

          <span class="hint">
            Fixed for this task: the Executor's tools and permissions, and the Planner's context mode — what the task
            was approved to do and to read.
          </span>

          @if (error(); as err) {
            <div class="callout danger" role="alert">{{ err }}</div>
          }
        </div>

        <div class="foot">
          <button type="button" class="btn" [disabled]="saving()" (click)="close()">Cancel</button>
          <button type="button" class="btn btn-accent" [disabled]="saving() || blocked() || !dirty()" (click)="save()">
            {{ saving() ? 'Saving…' : 'Save changes' }}
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
        width: 680px;
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
      .lead {
        color: var(--text-2);
      }
      .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .select {
        min-width: 0;
        flex: 1;
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
      .hint.warn {
        color: var(--executor);
      }
      .muted {
        color: var(--text-muted);
        font-weight: 400;
      }
      .radio-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .suffixed {
        position: relative;
      }
      .grid-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
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
      .toggle:disabled {
        opacity: 0.45;
        cursor: not-allowed;
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
    `,
  ],
})
export class TaskSettingsDialog implements OnInit {
  readonly task = input.required<TaskRecord>();
  readonly closed = output<void>();

  private readonly store = inject(TasksStore);

  protected readonly agents = AGENTS;
  protected readonly models = PICKER_MODELS;
  protected readonly fableWarning = FABLE_WARNING;
  protected readonly maxWarning = MAX_EFFORT_WARNING;

  protected readonly planner = signal<AgentConfig>({ model: 'opus', effort: null });
  protected readonly executor = signal<AgentConfig>({ model: 'sonnet', effort: null });
  protected readonly maxCycles = signal(25);
  protected readonly rollover = signal(60);
  protected readonly skills = signal<string[]>([]);
  protected readonly skillDraft = signal('');
  protected readonly autoCommit = signal(true);
  protected readonly timeoutMin = signal(60);
  protected readonly slowMin = signal(30);
  protected readonly steps = signal(80);
  protected readonly freshAfter = signal<number | null>(null);
  protected readonly freshMax = FRESH_EXECUTOR_MAX_TURNS;
  protected readonly mode = signal<ModelChangeMode>('same_session');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly cliVersion = computed(() => this.store.account()?.cliVersion ?? null);

  ngOnInit(): void {
    const c = this.task().config;
    this.planner.set({ ...c.planner });
    this.executor.set({ ...c.executor });
    this.maxCycles.set(c.maxCycles);
    this.rollover.set(c.rolloverPercent);
    this.skills.set([...c.requiredSkills]);
    this.autoCommit.set(c.autoBranchAndCommit);
    this.timeoutMin.set(Math.round(c.turnTimeoutMs / 60_000));
    this.slowMin.set(Math.round(c.slowTurnMs / 60_000));
    this.steps.set(c.maxTurnsPerSession);
    this.freshAfter.set(c.freshExecutorAfterRejectedTurns);
  }

  protected toggleFreshAfter(): void {
    this.freshAfter.update((v) => (v === null ? FRESH_EXECUTOR_DEFAULT_TURNS : null));
  }

  protected label(agent: AgentRole): string {
    return AGENT_LABEL[agent];
  }

  protected agentChoice(agent: AgentRole): AgentConfig {
    return agent === 'planner' ? this.planner() : this.executor();
  }

  private changed(agent: AgentRole): boolean {
    const now = this.task().config[agent];
    const next = this.agentChoice(agent);
    return now.model !== next.model || now.effort !== next.effort;
  }

  /** Agents whose model or effort changes and which have a session to keep or hand off. */
  private readonly changedWithSession = computed(() =>
    AGENTS.filter((a) => this.changed(a) && this.task().sessions[a].established),
  );

  /** The choice only exists when an agent with a session changes model or effort (SPEC.md §6). */
  protected readonly modeMatters = computed(() => this.changedWithSession().length > 0);

  protected readonly changedWho = computed(() => {
    const list = this.changedWithSession().map((a) => `the ${AGENT_LABEL[a]}'s`);
    return list.length === 2 ? "each agent's" : (list[0] ?? "the agent's");
  });

  protected readonly minCycles = computed(() => Math.max(1, this.task().cycles));

  protected readonly canTurnCommitOn = computed(() => {
    const t = this.task();
    return t.config.autoBranchAndCommit || (t.git.isRepo && t.git.branch !== null);
  });

  protected readonly blocked = computed(() => AGENTS.some((a) => this.versionBlock(this.agentChoice(a).model) !== null));

  private readonly update = computed<ConfigUpdate>(() => {
    const c = this.task().config;
    const out: ConfigUpdate = {};
    if (this.maxCycles() !== c.maxCycles) out.maxCycles = this.maxCycles();
    if (this.rollover() !== c.rolloverPercent) out.rolloverPercent = this.rollover();
    const skills = this.skills();
    if (skills.length !== c.requiredSkills.length || skills.some((s, i) => s !== c.requiredSkills[i])) out.requiredSkills = [...skills];
    if (this.autoCommit() !== c.autoBranchAndCommit) out.autoBranchAndCommit = this.autoCommit();
    if (this.timeoutMin() * 60_000 !== c.turnTimeoutMs) out.turnTimeoutMs = this.timeoutMin() * 60_000;
    if (this.slowMin() * 60_000 !== c.slowTurnMs) out.slowTurnMs = this.slowMin() * 60_000;
    if (this.steps() !== c.maxTurnsPerSession) out.maxTurnsPerSession = this.steps();
    if (this.freshAfter() !== c.freshExecutorAfterRejectedTurns) out.freshExecutorAfterRejectedTurns = this.freshAfter();
    for (const a of AGENTS) if (this.changed(a)) out[a] = { ...this.agentChoice(a) };
    if (this.modeMatters()) out.apply = this.mode();
    return out;
  });

  protected readonly dirty = computed(() => Object.keys(this.update()).some((k) => k !== 'apply'));

  protected modelText(model: string): string {
    return modelDisplay(model, this.cliVersion()).text;
  }

  protected modelNote(model: string): string | null {
    return modelDisplay(model, this.cliVersion()).note;
  }

  protected effortsOf(model: string): readonly EffortLevel[] {
    return effortsFor(model);
  }

  protected isFable(model: string): boolean {
    return getModel(model)?.isFable === true;
  }

  protected versionBlock(model: string): string | null {
    // Unknown version: the main process checks again before saving, and before every turn.
    const version = this.cliVersion();
    return version === null ? null : modelVersionBlock(model, version);
  }

  protected threshold(model: string): string {
    return formatTokens(rolloverThresholdFor(model, this.rollover(), this.cliVersion()));
  }

  /** How big the agent's session is: what "same conversation" would re-read, and what a handoff would summarise. */
  protected sessionLine(agent: AgentRole): string {
    const s = this.task().sessions[agent];
    if (!s.established) return 'no session yet — a change simply starts it on the new model';
    const size = s.lastContextTokens === null ? 'size unknown' : `${formatTokens(s.lastContextTokens)} tokens`;
    return `session now: ${size} · ${s.turns} turn${s.turns === 1 ? '' : 's'}`;
  }

  protected setModel(agent: AgentRole, model: string): void {
    const target = agent === 'planner' ? this.planner : this.executor;
    target.update((c) => ({ model, effort: effortOnModelChange(model, c.effort, this.cliVersion()) }));
  }

  protected setEffort(agent: AgentRole, effort: string): void {
    const target = agent === 'planner' ? this.planner : this.executor;
    target.update((c) => ({ ...c, effort: effort as EffortLevel }));
  }

  protected addSkill(): void {
    const name = this.skillDraft().trim();
    if (name && !this.skills().includes(name)) this.skills.update((list) => [...list, name]);
    this.skillDraft.set('');
  }

  protected removeSkill(skill: string): void {
    this.skills.update((list) => list.filter((s) => s !== skill));
  }

  protected clamp(raw: string, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit();
  }

  protected async save(): Promise<void> {
    if (!this.dirty()) {
      this.closed.emit();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const ok = await this.store.act({ kind: 'update_config', update: this.update() });
      if (ok) {
        this.closed.emit();
        return;
      }
      this.error.set(this.store.actionError()?.message ?? 'The settings could not be changed.');
    } finally {
      this.saving.set(false);
    }
  }
}
