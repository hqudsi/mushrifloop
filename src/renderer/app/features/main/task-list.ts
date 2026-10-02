/**
 * Left sidebar (SPEC.md §10, design "Main screen"): the task list with status pills, cycle count,
 * elapsed time and project folder; tasks that need the user first and marked; then the Settings gear
 * and the live account block at the foot (SPEC.md §10).
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { formatElapsed } from '../../../../shared/format';
import type { TaskSummary } from '../../../../shared/ipc';
import { TasksStore } from '../../core/tasks-store';
import { AccountBlock } from '../../shared/account-block';
import { StatusPill, statusLook } from '../../shared/status';
import { TitleEditor } from './title-editor';

@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [AccountBlock, StatusPill, TitleEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="top">
      <div class="heading">
        <span class="caps">TASKS</span>
        <span class="count">{{ store.tasks().length }}</span>
      </div>
      <button type="button" class="new" title="New task (Ctrl+N)" (click)="store.newTaskOpen.set(true)">
        <span class="plus">+</span>New task<span class="kbd">Ctrl+N</span>
      </button>
    </div>

    <div class="list" role="listbox" aria-label="Tasks">
      @if (store.listError(); as error) {
        <div class="callout danger list-error">Could not read the task list: {{ error }}</div>
      }
      @for (task of store.sortedTasks(); track task.id) {
        @if (editingId() === task.id) {
          <!-- Not a button while it holds an input: Space and Enter would press the button (SPEC.md §10). -->
          <div role="option" class="item selected editing" aria-selected="true">
            <div class="row1">
              <app-title-editor class="title" [value]="task.name ?? task.title" (saved)="saveTitle(task, $event)" (cancelled)="editingId.set(null)" />
            </div>
            <div class="project mono" [title]="task.projectDir">{{ task.projectName }}</div>
          </div>
        } @else {
        <button
          type="button"
          role="option"
          class="item"
          [class.selected]="task.id === store.selectedId()"
          [class.attention]="needsYou(task)"
          [attr.aria-selected]="task.id === store.selectedId()"
          (click)="store.select(task.id)"
          (dblclick)="editingId.set(task.id)"
        >
          <div class="row1">
            <span class="title" title="Double-click to rename">{{ task.title }}</span>
            @if (needsYou(task)) {
              <span class="pulse-dot" aria-label="needs you"></span>
            } @else if (task.busy) {
              <span class="typing" aria-label="running"><i></i><i></i><i></i></span>
            }
          </div>
          <div class="project mono" [title]="task.projectDir">{{ task.projectName }}</div>
          <div class="row3">
            @if (task.unreadable) {
              <span class="pill error" [title]="task.unreadable">Unreadable</span>
            } @else {
              <app-status-pill [status]="task.status" [waiting]="task.waitingKind" />
              <span>{{ cycles(task) }}</span>
              <span class="elapsed mono">{{ elapsed(task) }}</span>
            }
          </div>
        </button>
        }
      } @empty {
        @if (store.loaded() && !store.listError()) {
          <div class="empty">No tasks yet.</div>
        }
      }
    </div>

    <button type="button" class="settings" title="Settings" (click)="store.openSettings()">
      <span class="gear" aria-hidden="true">⚙</span>Settings
    </button>
    <app-account-block />
  `,
  styles: [
    `
      :host {
        width: 260px;
        flex: none;
        background: var(--bg-chrome);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .top {
        padding: 12px 12px 8px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0 2px;
      }
      .caps {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-3);
      }
      .count {
        font-size: 11px;
        color: var(--text-muted);
      }
      .new {
        height: 30px;
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        background: var(--bg-button);
        color: var(--text);
        display: flex;
        align-items: center;
        gap: 8px;
        padding-left: 10px;
        font-weight: 500;
        font-size: 12.5px;
        cursor: pointer;
      }
      .new:disabled {
        cursor: default;
        opacity: 0.55;
      }
      .new:hover:not(:disabled) {
        background: var(--bg-button-hover);
      }
      .plus {
        font-size: 15px;
        line-height: 1;
        color: var(--text-3);
      }
      .kbd {
        margin-left: auto;
        margin-right: 10px;
        font: 11px var(--font-mono);
        color: var(--text-muted);
      }
      .list {
        flex: 1;
        overflow: auto;
        display: flex;
        flex-direction: column;
        padding: 4px 0;
      }
      .list-error {
        margin: 6px 12px;
      }
      .item {
        padding: 10px 14px 10px 12px;
        border: 0;
        border-left: 2px solid transparent;
        background: transparent;
        color: inherit;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 5px;
        cursor: pointer;
        font: inherit;
        width: 100%;
      }
      .item:hover {
        background: var(--bg-hover);
      }
      .item.selected {
        background: var(--bg-task-selected);
      }
      .item.attention {
        border-left-color: var(--waiting);
      }
      .item.editing {
        cursor: default;
      }
      .row1 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      .title {
        font-weight: 500;
        color: var(--text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item.selected .title {
        color: var(--text);
      }
      .project {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .item.selected .project {
        color: var(--text-3);
      }
      .row3 {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: var(--text-3);
      }
      .elapsed {
        margin-left: auto;
      }
      .empty {
        padding: 14px;
        color: var(--text-muted);
        font-size: 12px;
      }
      /* Above the account block, where the gear used to be in the title bar (SPEC.md §10). */
      .settings {
        margin-top: auto;
        padding: 9px 14px;
        border: 0;
        border-top: 1px solid var(--border);
        background: transparent;
        color: var(--text-3);
        display: flex;
        align-items: center;
        gap: 8px;
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .settings:hover {
        background: var(--bg-hover);
        color: var(--text);
      }
      .gear {
        font-size: 13px;
      }
    `,
  ],
})
export class TaskList {
  protected readonly store = inject(TasksStore);
  /** The task being renamed in place, if any (SPEC.md §10). */
  protected readonly editingId = signal<string | null>(null);

  /** Enter saves. An unchanged name, or an unnamed task's shown title typed back unchanged, sends nothing. */
  protected async saveTitle(task: TaskSummary, text: string): Promise<void> {
    this.editingId.set(null);
    const next = text.replace(/\s+/g, ' ').trim();
    if (next === (task.name ?? '') || (task.name === null && next === task.title)) return;
    await this.store.renameTask(task.id, next);
  }

  protected needsYou(task: TaskSummary): boolean {
    return statusLook(task.status, task.waitingKind).attention;
  }

  protected cycles(task: TaskSummary): string {
    if (task.status === 'running' || task.busy) return `cycle ${Math.max(task.cycles, 1)}`;
    if (task.status === 'failed') return `${task.cycles} / ${task.maxCycles} cycles`;
    return `${task.cycles} ${task.cycles === 1 ? 'cycle' : 'cycles'}`;
  }

  protected elapsed(task: TaskSummary): string {
    const end = task.status === 'done' || task.status === 'failed' ? Date.parse(task.statusChangedAt) : this.store.now();
    return formatElapsed(end - Date.parse(task.createdAt));
  }
}
