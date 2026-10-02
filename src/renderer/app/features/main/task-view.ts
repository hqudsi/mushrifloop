/**
 * The centre of the main screen (SPEC.md §10): task header, the timeline in the shared content pane,
 * the current state, and the control bar pinned below.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { TaskDetail, TaskSummary } from '../../../../shared/ipc';
import type { ApprovalMode } from '../../../../shared/settings';
import { TERMINAL_STATUSES } from '../../../../shared/task-model';
import type { TimelineItem } from '../../../../shared/timeline';
import { PanelStore } from '../../core/panel-store';
import { TasksStore } from '../../core/tasks-store';
import { ContentPane } from '../../shared/content-pane';
import { agentModelNote, agentModelText } from '../../shared/model-text';
import { StatusPill } from '../../shared/status';
import { ControlBar } from './control-bar';
import { CycleCard } from './cycle-card';
import { PlannerCard } from './planner-card';
import { StatePanel } from './state-panel';
import { TaskSettingsDialog } from './task-settings-dialog';
import { TitleEditor } from './title-editor';
import { FinalCard, HandoffCard, NoteItem, StartCard, UserItem } from './timeline-items';

/** This close to the bottom counts as "at the bottom" (rounding of fractional scroll positions). */
const BOTTOM_PX = 4;

const APPROVAL_MODES: readonly { id: ApprovalMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'review', label: 'Review' },
  { id: 'plan_first', label: 'Plan first' },
];

@Component({
  selector: 'app-task-view',
  standalone: true,
  imports: [ContentPane, ControlBar, CycleCard, FinalCard, HandoffCard, NoteItem, PlannerCard, StartCard, StatePanel, StatusPill, TaskSettingsDialog, TitleEditor, UserItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = detail().task;
    <div class="header">
      @if (editingTitle()) {
        <app-title-editor class="title" [value]="t.title ?? firstLine(t.description)" (saved)="saveTitle($event)" (cancelled)="editingTitle.set(false)" />
      } @else {
        <span class="title" [title]="t.description + '\n\nDouble-click to rename.'" (dblclick)="editingTitle.set(true)">{{ title() }}</span>
      }
      <app-status-pill [status]="t.status" [waiting]="t.waiting?.kind ?? null" />
      <span class="cycle mono">cycle {{ t.cycles }} / {{ t.config.maxCycles }}</span>
      <label class="approval" [title]="approvalTitle()">
        <span class="approval-k">Approval</span>
        <!-- "selected" on the options (see Settings): the select's own value would be applied too early. -->
        <select
          class="approval-select"
          [disabled]="ended() || !!store.pendingAction()"
          (change)="setApproval($event)"
          aria-label="Approval mode"
        >
          @for (m of approvalModes; track m.id) {
            <option [value]="m.id" [selected]="m.id === t.config.approvalMode">{{ m.label }}</option>
          }
        </select>
      </label>
      <button
        type="button"
        class="new-here"
        [disabled]="ended() || !!store.pendingAction()"
        (click)="settingsOpen.set(true)"
        title="Change this task's models, effort, cycle limit, turn limits, required skills, auto-commit or rollover while it runs."
      >
        Task settings
      </button>
      <button
        type="button"
        class="new-here"
        (click)="store.openNewTaskInProject(t)"
        title="Opens the New task modal with this project folder and these settings. A fresh task is cheaper and cleaner when the work is unrelated to what this task did."
      >
        + New task in this project
      </button>
      <div class="agents">
        <span class="agent" [title]="'Planner session ' + t.sessions.planner.sessionId">
          <span class="cdot planner"></span><span [title]="agentNote('planner')">Planner · {{ agent('planner') }}</span>
        </span>
        <span class="agent" [title]="'Executor session ' + t.sessions.executor.sessionId">
          <span class="cdot executor"></span><span [title]="agentNote('executor')">Executor · {{ agent('executor') }}</span>
        </span>
        <button
          type="button"
          class="panel-toggle"
          [class.on]="panel.open()"
          [attr.aria-pressed]="panel.open()"
          [title]="panel.open() ? 'Hide the side panel' : 'Show the side panel (changed files, context, usage)'"
          (click)="panel.toggle()"
        >
          ▥
        </button>
      </div>
    </div>

    @if (settingsOpen()) {
      <app-task-settings-dialog [task]="t" (closed)="settingsOpen.set(false)" />
    }

    <div class="timeline">
    <app-content-pane #pane (scroll)="onScroll()" (wheel)="onWheel($event)">
      @for (item of store.timeline(); track item.key) {
        @switch (item.kind) {
          @case ('start') {
            <app-start-card [item]="item" />
          }
          @case ('cycle') {
            <app-cycle-card [item]="item" [taskId]="t.id" />
          }
          @case ('planner') {
            <app-planner-card
              [card]="item.card"
              [waiting]="item.key === waitingKey()"
              [pending]="item.key === pendingKey()?.key ? (pendingKey()?.kind ?? null) : null"
              [class.waiting-anchor]="item.key === waitingKey()"
            />
          }
          @case ('handoff') {
            <app-handoff-card [item]="item" />
          }
          @case ('user') {
            <app-user-item [item]="item" />
          }
          @case ('note') {
            <app-note-item [item]="item" />
          }
          @case ('final') {
            <app-final-card [item]="item" />
          }
        }
      }
      <app-state-panel class="waiting-anchor-alt" [task]="t" />
    </app-content-pane>
    @if (!following()) {
      <button type="button" class="jump" title="Jump to latest" aria-label="Jump to latest" (click)="jumpToLatest()">↓</button>
    }
    </div>

    <app-control-bar [task]="t" [busy]="detail().busy" />
  `,
  styles: [
    `
      :host {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--bg);
      }
      .header {
        min-height: 48px;
        flex: none;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 24px;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        min-width: 0;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 0 1 auto;
      }
      .cycle {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .agents {
        margin-left: auto;
        display: flex;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        color: var(--text-3);
      }
      .agent {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        white-space: nowrap;
      }
      .cdot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .cdot.planner {
        background: var(--planner);
      }
      .cdot.executor {
        background: var(--executor);
      }
      .panel-toggle {
        width: 28px;
        height: 26px;
        margin-left: 4px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: transparent;
        color: var(--text-3);
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
      }
      .panel-toggle:hover,
      .panel-toggle.on {
        background: var(--bg-button);
        color: var(--text);
      }
      /* SPEC.md §10: starting a fresh task on the same project, from inside a task. */
      .new-here {
        height: 24px;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: 5px;
        background: var(--bg-button);
        color: var(--text-3);
        font: inherit;
        font-size: 11.5px;
        white-space: nowrap;
        cursor: pointer;
      }
      .new-here:hover {
        background: var(--bg-button-hover);
        color: var(--text);
      }
      .approval {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .approval-select {
        height: 24px;
        padding: 0 4px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg-input);
        color: var(--text-2);
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
      }
      .approval-select:disabled {
        cursor: default;
        opacity: 0.7;
      }
      /* The scrolling timeline plus its floating "jump to latest" button. */
      .timeline {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      app-content-pane {
        --content-gap: 16px;
      }
      .jump {
        position: absolute;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        width: 34px;
        height: 34px;
        border: 1px solid var(--border-strong);
        border-radius: 50%;
        background: var(--bg-chrome);
        color: var(--text-2);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
      }
      .jump:hover {
        background: var(--bg-button-hover);
        color: var(--text);
      }
    `,
  ],
})
export class TaskView {
  protected readonly store = inject(TasksStore);
  protected readonly panel = inject(PanelStore);
  /** "Task settings" (SPEC.md §6): open over the task it belongs to. */
  protected readonly settingsOpen = signal(false);
  /** Renaming in place (SPEC.md §10). */
  protected readonly editingTitle = signal(false);

  protected firstLine(text: string): string {
    return (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  }

  /** Enter saves (SPEC.md §10). Unchanged, or the fallback typed back unchanged, sends nothing. */
  protected async saveTitle(text: string): Promise<void> {
    this.editingTitle.set(false);
    const t = this.detail().task;
    const next = text.replace(/\s+/g, ' ').trim();
    const current = t.title ?? null;
    if (next === (current ?? '') || (current === null && next === this.firstLine(t.description))) return;
    await this.store.renameTask(t.id, next);
  }

  readonly detail = input.required<TaskDetail>();
  readonly summary = input<TaskSummary | null>(null);

  private readonly pane = viewChild('pane', { read: ElementRef });
  private lastTaskId: string | null = null;
  private lastScrollTop = 0;

  /**
   * SPEC.md §10: the timeline follows new content while the user is at the bottom, and stops as soon as
   * they scroll up; "jump to latest" (or scrolling back down to the end) turns it on again.
   */
  protected readonly following = signal(true);

  protected readonly approvalModes = APPROVAL_MODES;
  protected readonly ended = computed(() => TERMINAL_STATUSES.includes(this.detail().task.status));

  protected readonly approvalTitle = computed(() => {
    const t = this.detail().task;
    if (this.ended()) return `This task has ended; it ran in ${label(t.config.approvalMode)} mode.`;
    const parts = ["Changes apply from the Planner's next instruction."];
    if (t.config.approvalMode === 'plan_first') {
      parts.push(t.planApproved ? 'The plan is approved, so the task runs as Auto.' : 'No plan approved yet.');
    }
    if (t.waiting?.kind === 'instruction_approval') parts.push('The instruction waiting for approval still needs your decision.');
    return parts.join(' ');
  });

  protected readonly title = computed(() => this.summary()?.title ?? this.detail().task.description.split('\n')[0] ?? '');

  /** The Planner card holding the question the task waits on. */
  protected readonly waitingKey = computed(() => {
    if (this.detail().task.waiting?.kind !== 'question') return null;
    const items = this.store.timeline();
    for (let i = items.length - 1; i >= 0; i--) {
      const it: TimelineItem | undefined = items[i];
      if (it?.kind === 'planner' && (it.card.output?.status === 'needs_user' || it.card.output?.status === 'blocked')) return it.key;
    }
    return null;
  });

  /** The standalone Planner card whose instruction or plan waits for approval. */
  protected readonly pendingKey = computed<{ key: string; kind: 'instruction' | 'plan' } | null>(() => {
    const kind = this.detail().task.waiting?.kind;
    if (kind !== 'instruction_approval' && kind !== 'plan_approval') return null;
    const want = kind === 'plan_approval' ? 'plan_ready' : 'continue';
    const items = this.store.timeline();
    for (let i = items.length - 1; i >= 0; i--) {
      const it: TimelineItem | undefined = items[i];
      if (it?.kind === 'planner' && it.card.output?.status === want) return { key: it.key, kind: kind === 'plan_approval' ? 'plan' : 'instruction' };
    }
    return null;
  });

  constructor() {
    // New items while following; the waiting state when a task opens.
    effect(() => {
      // Tracked: anything that changes the content's height.
      this.store.timeline();
      this.store.live();
      const task = this.detail().task;
      untracked(() => {
        const opened = task.id !== this.lastTaskId;
        if (opened) {
          this.lastTaskId = task.id;
          this.following.set(true);
        }
        requestAnimationFrame(() => this.scroll(opened));
      });
    });

    // Content also grows without a new event: a card expanding, activity loading, streamed text wrapping.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.paneElement();
      const column = el?.firstElementChild;
      if (!el || !column) return;
      const observer = new ResizeObserver(() => {
        if (this.following()) this.toEnd(el);
      });
      observer.observe(column);
      observer.observe(el);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** The version that will run, not the alias (SPEC.md §8). */
  protected agent(which: 'planner' | 'executor'): string {
    const a = this.detail().task.config[which];
    return agentModelText(a.model, a.effort, this.store.account()?.cliVersion ?? null);
  }

  protected agentNote(which: 'planner' | 'executor'): string {
    return agentModelNote(this.detail().task.config[which].model, this.store.account()?.cliVersion ?? null);
  }

  protected setApproval(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const mode = select.value as ApprovalMode;
    const current = this.detail().task.config.approvalMode;
    if (mode === current) return;
    void this.store.act({ kind: 'set_approval_mode', mode }).then((ok) => {
      // Refused: show the mode the task really has (the store shows the error).
      if (!ok) select.value = this.detail().task.config.approvalMode;
    });
  }

  protected onScroll(): void {
    const el = this.paneElement();
    if (!el) return;
    const top = el.scrollTop;
    if (el.scrollHeight - top - el.clientHeight <= BOTTOM_PX) this.following.set(true);
    else if (top < this.lastScrollTop) this.following.set(false);
    this.lastScrollTop = top;
  }

  /** Stop following on the first wheel movement upwards, before the scroll position has even changed. */
  protected onWheel(event: WheelEvent): void {
    const el = this.paneElement();
    if (event.deltaY < 0 && el && el.scrollTop > 0 && !innerScrollsUp(event.target, el)) this.following.set(false);
  }

  protected jumpToLatest(): void {
    const el = this.paneElement();
    this.following.set(true);
    if (el) this.toEnd(el);
  }

  private paneElement(): HTMLElement | undefined {
    return this.pane()?.nativeElement as HTMLElement | undefined;
  }

  private toEnd(el: HTMLElement): void {
    el.scrollTop = el.scrollHeight;
    this.lastScrollTop = el.scrollTop;
  }

  private scroll(opened: boolean): void {
    const el = this.paneElement();
    if (!el) return;
    if (opened) {
      const anchor = el.querySelector('.waiting-anchor') as HTMLElement | null;
      if (anchor) {
        // A tall card (a long plan) is shown from its top.
        anchor.scrollIntoView({ block: anchor.offsetHeight > el.clientHeight * 0.8 ? 'start' : 'center' });
        this.lastScrollTop = el.scrollTop;
        this.following.set(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PX);
        return;
      }
    }
    if (this.following()) this.toEnd(el);
  }
}

/** A box inside the timeline (raw output, a long list) that takes this upward wheel movement itself. */
function innerScrollsUp(target: EventTarget | null, pane: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== pane; node = node.parentElement) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true;
  }
  return false;
}

function label(mode: ApprovalMode): string {
  return APPROVAL_MODES.find((m) => m.id === mode)?.label ?? mode;
}
