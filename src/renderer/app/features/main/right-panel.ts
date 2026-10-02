/**
 * Right panel (SPEC.md §10, design "Main screen", collapsible): changed files (click → editor), task
 * stats, a context bar per agent with "Roll over now" (§15), the usage figures as Claude Code reports
 * them (§17), and the standing-instructions editor ("applies to new sessions", §6).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import { formatDateTime, formatDuration, formatTokens } from '../../../../shared/format';
import type { ChangedFile, TaskDetail, UsageWindow } from '../../../../shared/ipc';
import { modelDisplay, rolloverThresholdFor } from '../../../../shared/models';
import type { AgentRole, TaskRecord } from '../../../../shared/task-model';
import { taskTimes } from '../../../../shared/task-stats';
import { isPastReset, usageLevel, type UsageLevel } from '../../../../shared/usage';
import { ROLLOVER_HINT } from '../../../../shared/timeline';
import { PanelStore } from '../../core/panel-store';
import { TasksStore } from '../../core/tasks-store';

const AGENTS: readonly AgentRole[] = ['planner', 'executor'];
const LABEL: Record<AgentRole, string> = { planner: 'Planner', executor: 'Executor' };

function modelLabel(id: string, cliVersion: string | null): string {
  return modelDisplay(id, cliVersion).text;
}

@Component({
  selector: 'app-right-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = detail().task;
    @let f = panel.files();

    <!-- CHANGED FILES -->
    <div class="sec-head first">
      <span class="caps">CHANGED FILES</span>
      <span class="mono count">
        @if (f) {
          {{ f.files.length }}
          @if (f.source === 'git') {
            · <span class="add">+{{ f.additions }}</span> <span class="del">−{{ f.deletions }}</span>
          }
        } @else if (panel.filesLoading()) {
          …
        }
        <button type="button" class="icon" title="Refresh" (click)="panel.loadFiles(t.id)">↻</button>
      </span>
    </div>
    @if (panel.fileError(); as err) {
      <div class="callout danger box">{{ err }}</div>
    }
    @if (f) {
      @if (f.error) {
        <div class="callout warn box">{{ f.error }}</div>
      }
      <div class="files">
        @for (file of f.files; track file.path) {
          <button
            type="button"
            class="file"
            [disabled]="file.status === 'D'"
            [title]="file.status === 'D' ? file.path + ' (deleted)' : 'Open ' + file.path + ' in the editor'"
            (click)="open(file)"
          >
            <span class="st" [class]="'st ' + file.status">{{ file.status }}</span>
            <span class="fname">{{ file.name }} <span class="fdir">{{ file.dir }}</span></span>
            @if (file.additions !== null) {
              <span [class.add]="file.additions > 0" [class.zero]="file.additions === 0">+{{ file.additions }}</span>
              <span [class.del]="(file.deletions ?? 0) > 0" [class.zero]="!file.deletions">−{{ file.deletions ?? 0 }}</span>
            }
          </button>
        } @empty {
          <div class="empty">No changes yet.</div>
        }
      </div>
      <div class="basis">{{ f.basis }}</div>
    }

    <!-- TASK -->
    <div class="sec-head"><span class="caps">TASK</span></div>
    <div class="grid">
      <span class="k">Cycles</span>
      <span class="bar-row">
        <span class="mono">{{ t.cycles }} / {{ t.config.maxCycles }}</span>
        <span class="bar"><span [style.width.%]="cyclePct()"></span></span>
      </span>
      <span class="k">Elapsed</span>
      <span class="mono">
        {{ elapsed() }}
        @if (waiting(); as w) {
          <span class="muted">· waiting on you {{ w }}</span>
        }
      </span>
      @for (agent of agents; track agent) {
        <span class="k">{{ label[agent] }}</span>
        <span class="agent" [attr.title]="modelNote(agent)">
          <span class="dot" [class]="'dot ' + agent"></span>
          {{ model(agent) }}
          <span class="muted small">· {{ agentNote(agent) }}</span>
        </span>
      }
      <span class="k">Approval</span>
      <span>{{ approvalLabel() }}</span>
    </div>

    <!-- CONTEXT (SPEC.md §15) -->
    <div class="sec-head"><span class="caps">CONTEXT</span><span class="note">rollover at {{ t.config.rolloverPercent }}% of auto-compact</span></div>
    <div class="ctx">
      @for (agent of agents; track agent) {
        @let c = context()[agent];
        <div class="ctx-row">
          <div class="ctx-top">
            <span class="agent"><span class="dot" [class]="'dot ' + agent"></span>{{ label[agent] }}</span>
            <span class="mono small">{{ c.used }} / {{ c.threshold }}</span>
          </div>
          <span class="bar"><span [class.hot]="c.pct >= 80" [style.width.%]="c.pct"></span></span>
          <div class="ctx-bottom">
            <span class="muted small">{{ c.detail }}</span>
            <button
              type="button"
              class="btn mini"
              [disabled]="!c.canRoll || !!store.pendingAction()"
              [title]="c.rollTitle"
              (click)="rollover(agent)"
            >
              Roll over now
            </button>
          </div>
          @if (c.requested) {
            <div class="requested">Rollover requested ({{ c.requested }}) — it happens before the next {{ label[agent] }} turn.</div>
          }
        </div>
      }
    </div>

    <!-- USAGE (SPEC.md §17) -->
    @let u = panel.usage();
    <div class="sec-head">
      <span class="caps">USAGE</span>
      <span class="note">as reported by Claude Code</span>
    </div>
    <div class="grid">
      @if (u && u.windows.length > 0) {
        @for (w of u.windows; track w.key) {
          <!-- Past its reset with no reading since: the old figure no longer holds (SPEC.md §17). -->
          @let reset = pastReset(w);
          <span class="k">{{ w.label }}</span>
          <span class="bar-row">
            <span class="mono">{{ reset ? '—' : pct(w) }}</span>
            <span class="bar"><span [class]="'quota ' + level(w)" [style.width.%]="reset ? 0 : pctValue(w)"></span></span>
          </span>
          @if (w.resetsAt) {
            <span></span>
            <span class="muted small up">
              @if (reset) {
                reset {{ resets(w.resetsAt) }} · waiting for a new reading
              } @else {
                resets {{ resets(w.resetsAt) }}
              }
            </span>
          }
        }
        <span></span><span class="muted small">{{ planLine(t) }} · updated {{ when(u.reportedAt) }}</span>
      } @else {
        <span class="k">Plan</span>
        <span class="muted">{{ planLine(t) }} · {{ u ? 'no reading yet' : '…' }}</span>
      }
      <span class="k">Estimate</span>
      <span>
        @if (u?.ledgerError; as err) {
          <span class="callout warn block">{{ err }}</span>
        }
        @if (u) {
          today {{ tokens(u.estimate.today) }} · 7 days {{ tokens(u.estimate.last7Days) }} tokens
          <span class="muted small block">local estimate from this machine's turns — not the official quota</span>
        } @else {
          <span class="muted">…</span>
        }
      </span>
    </div>
    <div class="usage-text">
      <div class="usage-actions">
        <button
          type="button"
          class="btn mini"
          [disabled]="panel.usageLoading() || detail().busy"
          [title]="
            detail().busy
              ? 'While a task runs, each turn refreshes these figures'
              : 'Asks Claude Code for the current figures (free: no model call). It also refreshes on its own.'
          "
          (click)="panel.loadUsage(true)"
        >
          {{ panel.usageLoading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
      @if (u?.checkError; as err) {
        <div class="callout warn">{{ err }}</div>
      }
    </div>

    <!-- STANDING INSTRUCTIONS (SPEC.md §6) -->
    <div class="sec-head">
      <span class="caps">STANDING INSTRUCTIONS</span>
      <span class="note">applies to new sessions</span>
    </div>
    <div class="standing">
      @for (agent of agents; track agent) {
        <label class="sp-label" [class]="'sp-label ' + agent">
          <span class="dot" [class]="'dot ' + agent"></span>{{ label[agent] }} system prompt
        </label>
        <textarea
          class="sp"
          [class]="'sp ' + agent"
          rows="3"
          [value]="drafts()[agent]"
          [disabled]="ended()"
          [attr.aria-label]="label[agent] + ' standing instructions'"
          (input)="edit(agent, $any($event.target).value)"
          (keydown)="onKey($event, agent)"
        ></textarea>
        @if (dirty(agent)) {
          <div class="sp-actions">
            <button type="button" class="btn mini accent" [disabled]="!!store.pendingAction()" (click)="save(agent)">Save</button>
            <button type="button" class="btn mini" (click)="revert(agent)">Revert</button>
            <span class="muted small">{{ appliesWhen(agent) }}</span>
          </div>
        } @else if (savedNote() === agent) {
          <div class="sp-actions"><span class="muted small">Saved. {{ appliesWhen(agent) }}</span></div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        width: 320px;
        flex: none;
        background: var(--bg-chrome);
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
        padding-bottom: 16px;
      }
      :host > * {
        flex: none;
      }
      .sec-head {
        margin: 14px 16px 0;
        padding-top: 14px;
        border-top: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }
      .sec-head.first {
        border-top: 0;
        padding-top: 0;
        margin-bottom: 6px;
      }
      .caps {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-3);
      }
      .note {
        font-size: 11px;
        color: var(--text-muted);
        text-align: right;
      }
      .count {
        font-size: 11px;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .icon {
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 0 2px;
      }
      .icon:hover {
        color: var(--text);
      }
      .add {
        color: var(--success);
      }
      .del {
        color: var(--danger);
      }
      .zero {
        color: var(--text-muted);
      }
      .box {
        margin: 4px 16px;
      }
      .files {
        display: flex;
        flex-direction: column;
        padding: 0 8px;
        max-height: 320px;
        overflow-y: auto;
      }
      .file {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--text);
        font: 12px var(--font-mono);
        text-align: left;
        cursor: pointer;
        flex: none;
      }
      .file:hover:not(:disabled) {
        background: var(--bg-button);
      }
      .file:disabled {
        cursor: default;
      }
      .file:disabled .fname {
        text-decoration: line-through;
        color: var(--text-3);
      }
      .st {
        font-size: 10px;
        width: 8px;
        flex: none;
      }
      .st.A {
        color: var(--success);
      }
      .st.M,
      .st.R {
        color: var(--executor);
      }
      .st.D {
        color: var(--danger);
      }
      .fname {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fdir {
        color: var(--text-muted);
      }
      .empty {
        padding: 5px 8px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .basis {
        margin: 4px 16px 0;
        font-size: 11px;
        color: var(--text-muted);
      }
      .grid {
        padding: 8px 16px 0;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 7px 16px;
        font-size: 12px;
        align-items: center;
      }
      .k {
        color: var(--text-muted);
        white-space: nowrap;
      }
      .bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .bar {
        flex: 1;
        height: 4px;
        border-radius: 2px;
        background: var(--border);
        overflow: hidden;
        display: block;
      }
      .bar > span {
        display: block;
        height: 100%;
        background: var(--text-3);
      }
      .bar > span.hot {
        background: var(--executor);
      }
      /* Usage by level (SPEC.md §17): the accent, then the warning amber from 75 %, red from 90 %. */
      .bar > span.quota.ok {
        background: var(--planner);
      }
      .bar > span.quota.warn {
        background: var(--executor);
      }
      .bar > span.quota.over {
        background: var(--danger);
      }
      .muted {
        color: var(--text-muted);
      }
      .small {
        font-size: 11px;
      }
      .block {
        display: block;
      }
      .up {
        margin-top: -4px;
      }
      .agent {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex: none;
      }
      .dot.planner {
        background: var(--planner);
      }
      .dot.executor {
        background: var(--executor);
      }
      .ctx {
        padding: 8px 16px 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-size: 12px;
      }
      .ctx-row {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .ctx-top,
      .ctx-bottom {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      .requested {
        font-size: 11px;
        color: var(--executor);
      }
      .btn.mini {
        height: 24px;
        padding: 0 8px;
        font-size: 11.5px;
      }
      .btn.mini.accent {
        background: var(--planner);
        border-color: var(--planner);
        color: var(--on-accent);
      }
      .usage-text {
        padding: 10px 16px 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .usage-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .standing {
        padding: 10px 16px 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .sp-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        font-weight: 500;
        margin-top: 6px;
      }
      .sp-label.planner {
        color: var(--planner);
      }
      .sp-label.executor {
        color: var(--executor);
      }
      .sp {
        min-height: 72px;
        resize: vertical;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg-input);
        color: var(--text-2);
        font-size: 12px;
        line-height: 1.5;
        padding: 8px;
        outline: 0;
      }
      .sp.planner:focus {
        border-color: var(--planner);
      }
      .sp.executor:focus {
        border-color: var(--executor);
      }
      .sp-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
    `,
  ],
})
export class RightPanel {
  protected readonly store = inject(TasksStore);
  protected readonly panel = inject(PanelStore);

  readonly detail = input.required<TaskDetail>();

  protected readonly agents = AGENTS;
  protected readonly label = LABEL;

  /** Unsaved edits of the standing instructions, per agent. */
  protected readonly drafts = signal<Record<AgentRole, string>>({ planner: '', executor: '' });
  protected readonly savedNote = signal<AgentRole | null>(null);
  private draftTask: string | null = null;

  constructor() {
    // Load the task's instructions when a task opens; keep unsaved edits while it runs on.
    effect(() => {
      const task = this.detail().task;
      untracked(() => {
        if (task.id !== this.draftTask) {
          this.draftTask = task.id;
          this.drafts.set({ ...task.config.standingInstructions });
          this.savedNote.set(null);
        }
      });
    });
  }

  protected readonly ended = computed(() => ['done', 'failed'].includes(this.detail().task.status));

  protected readonly cyclePct = computed(() => {
    const t = this.detail().task;
    return Math.min(100, Math.round((t.cycles / Math.max(1, t.config.maxCycles)) * 100));
  });

  private readonly times = computed(() => {
    const d = this.detail();
    return taskTimes(d.task.createdAt, d.events, this.store.now());
  });

  protected readonly elapsed = computed(() => formatDuration(this.times().elapsedMs));
  protected readonly waiting = computed(() => (this.times().waitingMs >= 1000 ? formatDuration(this.times().waitingMs) : null));

  protected readonly approvalLabel = computed(() => {
    const t = this.detail().task;
    switch (t.config.approvalMode) {
      case 'auto':
        return 'Auto';
      case 'review':
        return 'Review each instruction';
      case 'plan_first':
        return t.planApproved ? 'Plan first · plan approved, now auto' : 'Plan first · plan not approved yet';
    }
  });

  protected readonly context = computed(() => {
    const t = this.detail().task;
    const out = {} as Record<
      AgentRole,
      { used: string; threshold: string; pct: number; detail: string; canRoll: boolean; rollTitle: string; requested: string | null }
    >;
    for (const agent of AGENTS) {
      const s = t.sessions[agent];
      // The same threshold the orchestrator uses (SPEC.md §15): the task's model and rollover percent.
      const threshold = rolloverThresholdFor(t.config[agent].model, t.config.rolloverPercent);
      const used = s.lastContextTokens;
      const retired = s.retired.length;
      const canRoll = s.established && !['done', 'failed'].includes(t.status) && s.rolloverRequested === null;
      out[agent] = {
        used: used === null ? '—' : formatTokens(used),
        threshold: formatTokens(threshold),
        pct: used === null ? 0 : Math.min(100, Math.round((used / threshold) * 100)),
        detail: `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'} in this session${retired ? ` · ${retired} earlier` : ''}`,
        canRoll,
        rollTitle: !s.established
          ? `${ROLLOVER_HINT}\n\nNo session yet — nothing to hand off.`
          : s.rolloverRequested !== null
            ? `${ROLLOVER_HINT}\n\nAlready requested.`
            : ROLLOVER_HINT,
        requested: s.rolloverRequested,
      };
    }
    return out;
  });

  protected model(agent: AgentRole): string {
    const a = this.detail().task.config[agent];
    const cli = this.store.account()?.cliVersion ?? null;
    return a.effort ? `${modelLabel(a.model, cli)} · ${a.effort}` : modelLabel(a.model, cli);
  }

  /** What an alias runs now, as a tooltip; null for a full id (SPEC.md §8). */
  protected modelNote(agent: AgentRole): string | null {
    return modelDisplay(this.detail().task.config[agent].model, this.store.account()?.cliVersion ?? null).note;
  }

  protected agentNote(agent: AgentRole): string {
    const c = this.detail().task.config;
    if (agent === 'planner') return c.plannerContextMode === 'read_only' ? 'read-only project' : 'isolated';
    return c.permissionMode === 'bypassPermissions' ? 'skips permissions' : "don't ask";
  }

  protected planLine(t: TaskRecord): string {
    const plan = t.pinnedAccount.subscriptionType;
    return plan ? `Plan: ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : 'Plan unknown';
  }

  protected pctValue(w: UsageWindow): number {
    return w.utilization === null ? 0 : Math.min(100, Math.round(w.utilization * 100));
  }

  protected pct(w: UsageWindow): string {
    return w.utilization === null ? '—' : `${this.pctValue(w)}%`;
  }

  protected level(w: UsageWindow): UsageLevel {
    return usageLevel(this.pctValue(w));
  }

  protected pastReset(w: UsageWindow): boolean {
    return isPastReset(w.resetsAt, this.store.now());
  }

  protected resets(epochSeconds: number): string {
    const ms = epochSeconds * 1000 - this.store.now();
    return ms > 0 ? `in ${formatDuration(ms)}` : formatDateTime(epochSeconds * 1000);
  }

  protected when(iso: string | null): string {
    if (!iso) return '—';
    const ms = this.store.now() - Date.parse(iso);
    return ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`;
  }

  protected tokens(n: number): string {
    return formatTokens(n);
  }

  protected open(file: ChangedFile): void {
    void this.panel.openFile(this.detail().task.id, file.path);
  }

  protected rollover(agent: AgentRole): void {
    void this.store.act({ kind: 'rollover_now', agent });
  }

  protected edit(agent: AgentRole, value: string): void {
    this.drafts.update((d) => ({ ...d, [agent]: value }));
    this.savedNote.set(null);
  }

  protected dirty(agent: AgentRole): boolean {
    return this.drafts()[agent] !== this.detail().task.config.standingInstructions[agent];
  }

  /** SPEC.md §6: new sessions only — say which session that is. */
  protected appliesWhen(agent: AgentRole): string {
    const session = this.detail().task.sessions[agent];
    if (session.systemPrompt === null) return `Used from the ${LABEL[agent]}'s first turn.`;
    return `The current ${LABEL[agent]} session keeps the prompt it started with; this applies from the next new session (after a rollover).`;
  }

  protected save(agent: AgentRole): void {
    const text = this.drafts()[agent];
    void this.store.act({ kind: 'set_standing_instructions', agent, text }).then((ok) => {
      if (ok) this.savedNote.set(agent);
    });
  }

  protected revert(agent: AgentRole): void {
    this.drafts.update((d) => ({ ...d, [agent]: this.detail().task.config.standingInstructions[agent] }));
  }

  protected onKey(event: KeyboardEvent, agent: AgentRole): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && this.dirty(agent)) {
      event.preventDefault();
      this.save(agent);
    }
  }
}
