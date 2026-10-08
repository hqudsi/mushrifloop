/**
 * Left sidebar (SPEC.md §10, design "Main screen"): the task list with status pills, cycle count,
 * elapsed time and project folder; tasks that need the user first and marked; then the Settings gear
 * and the live account block at the foot (SPEC.md §10).
 *
 * Managing tasks (SPEC.md §10): grouped by project (or one flat list), pinned tasks under the ones that need
 * the user, archived tasks in a folded section at the foot, a search box, and a right-click ⋯ menu per row.
 * How the list is shown (grouping, folded groups) is remembered in browser storage, per computer.
 */

import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';

import { storageKey } from '../../../../shared/app-config';
import { formatElapsed } from '../../../../shared/format';
import type { TaskSummary } from '../../../../shared/ipc';
import { groupByProject, searchTasks, type ProjectGroup } from '../../../../shared/task-list';
import { TasksStore } from '../../core/tasks-store';
import { AccountBlock } from '../../shared/account-block';
import { StatusPill, statusLook } from '../../shared/status';
import { TitleEditor } from './title-editor';

const GROUPED_KEY = storageKey('taskListGrouped');
const FOLDED_KEY = storageKey('taskListFolded');
const ARCHIVED_OPEN_KEY = storageKey('taskListArchivedOpen');

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function storedKeys(key: string): string[] {
  const v = readStored<unknown>(key, []);
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the list still works, it is just not remembered */
  }
}

@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [AccountBlock, NgTemplateOutlet, StatusPill, TitleEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="top">
      <div class="heading">
        <span class="caps">TASKS</span>
        <span class="count">{{ active().length }}</span>
        <button
          type="button"
          class="view-toggle"
          [class.on]="grouped()"
          [attr.aria-pressed]="grouped()"
          [title]="grouped() ? 'Grouped by project. Click for one list.' : 'One list. Click to group by project.'"
          (click)="toggleGrouped()"
        >
          {{ grouped() ? 'By project' : 'All' }}
        </button>
      </div>
      <button type="button" class="new" title="New task (Ctrl+N)" (click)="store.newTaskOpen.set(true)">
        <span class="plus">+</span>New task<span class="kbd">Ctrl+N</span>
      </button>
      <input
        class="search"
        type="search"
        placeholder="Search tasks"
        aria-label="Search tasks by name, description or project folder"
        title="Matches the name, the description and the project folder. Escape clears."
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        (keydown.escape)="query.set('')"
      />
    </div>

    <div class="list" role="listbox" aria-label="Tasks">
      @if (store.listError(); as error) {
        <div class="callout danger list-error">Could not read the task list: {{ error }}</div>
      }
      @if (matches(); as found) {
        @for (task of found; track task.id) {
          <ng-container *ngTemplateOutlet="row; context: { $implicit: task }" />
        } @empty {
          <div class="empty">No task matches “{{ query().trim() }}”.</div>
        }
      } @else {
        @if (grouped()) {
          @for (g of groups(); track g.key) {
            <button
              type="button"
              class="group"
              [attr.aria-expanded]="!folded().has(g.key)"
              [title]="g.dir"
              (click)="toggleFold(g.key)"
            >
              <span class="chev" [class.open]="!folded().has(g.key)" aria-hidden="true">›</span>
              <span class="gname">{{ g.name }}</span>
              @if (folded().has(g.key) && g.needsYou) {
                <span class="pulse-dot" aria-label="a task here needs you"></span>
              }
              <span class="gcount">{{ g.tasks.length }}</span>
            </button>
            @if (!folded().has(g.key)) {
              @for (task of g.tasks; track task.id) {
                <ng-container *ngTemplateOutlet="row; context: { $implicit: task }" />
              }
            }
          }
        } @else {
          @for (task of active(); track task.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: task }" />
          }
        }
        @if (archived().length > 0) {
          <button type="button" class="group archived-head" [attr.aria-expanded]="archivedOpen()" (click)="toggleArchived()">
            <span class="chev" [class.open]="archivedOpen()" aria-hidden="true">›</span>
            <span class="gname">Archived</span>
            <span class="gcount">{{ archived().length }}</span>
          </button>
          @if (archivedOpen()) {
            @for (task of archived(); track task.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: task }" />
            }
          }
        }
        @if (store.loaded() && !store.listError() && store.tasks().length === 0) {
          <div class="empty">No tasks yet.</div>
        }
      }
    </div>

    <ng-template #row let-task>
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
          [class.archived]="task.archived"
          (click)="store.select(task.id)"
          (dblclick)="editingId.set(task.id)"
          (contextmenu)="openMenu($event, task)"
        >
          <div class="row1">
            <span class="title" title="Double-click to rename · ⋯ or right-click for Rename, Pin, Archive, Delete">{{ task.title }}</span>
            @if (task.pinnedToTop) {
              <span class="pin" title="Pinned to top" aria-label="pinned">⇡</span>
            }
            @if (task.archived && matches()) {
              <span class="tag">archived</span>
            }
            @if (needsYou(task)) {
              <span class="pulse-dot" aria-label="needs you"></span>
            } @else if (task.busy) {
              <span class="typing" aria-label="running"><i></i><i></i><i></i></span>
            }
            <!-- Not a button: the row is one. The same menu opens on right-click and with Shift+F10 (SPEC.md §10). -->
            <span class="row-more" title="Rename, Pin, Archive, Delete…" aria-hidden="true" (click)="openMenuAt($event, task)" (dblclick)="$event.stopPropagation()">⋯</span>
          </div>
          @if (!grouped() || matches() || task.archived) {
            <div class="project mono" [title]="task.projectDir">{{ task.projectName }}</div>
          }
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
    </ng-template>

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
        align-items: center;
        gap: 6px;
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
        flex: 1;
        min-width: 0;
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
      .view-toggle {
        margin-left: auto;
        margin-right: 6px;
        height: 20px;
        padding: 0 7px;
        border: 1px solid var(--border-strong);
        border-radius: 4px;
        background: transparent;
        color: var(--text-3);
        font: inherit;
        font-size: 10.5px;
        cursor: pointer;
      }
      .view-toggle:hover {
        color: var(--text);
        background: var(--bg-hover);
      }
      .search {
        height: 28px;
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        background: var(--bg-input);
        color: var(--text);
        padding: 0 9px;
        font: inherit;
        font-size: 12px;
        outline: 0;
      }
      .search:focus {
        border-color: var(--planner);
      }
      .group {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px 4px 10px;
        border: 0;
        background: transparent;
        color: var(--text-3);
        font: inherit;
        font-size: 11px;
        font-weight: 600;
        text-align: left;
        cursor: pointer;
        width: 100%;
      }
      .group:hover {
        color: var(--text);
      }
      .archived-head {
        margin-top: 8px;
        border-top: 1px solid var(--border);
        padding-top: 10px;
      }
      .chev {
        display: inline-block;
        width: 10px;
        transition: transform 0.12s;
      }
      .chev.open {
        transform: rotate(90deg);
      }
      .gname {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .gcount {
        font-weight: 400;
        color: var(--text-muted);
      }
      .row-more {
        flex: none;
        visibility: hidden;
        width: 20px;
        height: 18px;
        margin: -2px -6px -2px 0;
        border-radius: 4px;
        display: grid;
        place-items: center;
        color: var(--text-3);
        font-size: 13px;
        line-height: 1;
      }
      .item:hover .row-more,
      .item.selected .row-more {
        visibility: visible;
      }
      .row-more:hover {
        background: var(--bg-button-hover);
        color: var(--text);
      }
      .pin {
        flex: none;
        font-size: 11px;
        color: var(--text-3);
      }
      .tag {
        flex: none;
        font-size: 10px;
        padding: 0 5px;
        border-radius: 3px;
        background: var(--bg-card);
        color: var(--text-muted);
      }
      .item.archived .title {
        color: var(--text-3);
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
  protected readonly query = signal('');

  constructor() {
    // Rename… from the menu of a row: that row edits its name in place, as a double-click does (SPEC.md §10).
    effect(() => {
      const request = this.store.renameRequest();
      if (!request || request.origin !== 'list') return;
      untracked(() => {
        this.store.renameRequest.set(null);
        this.editingId.set(request.taskId);
      });
    });
  }
  protected readonly grouped = signal(readStored<boolean>(GROUPED_KEY, true) !== false);
  protected readonly folded = signal(new Set<string>(storedKeys(FOLDED_KEY)));
  protected readonly archivedOpen = signal(readStored<boolean>(ARCHIVED_OPEN_KEY, false) === true);

  protected readonly active = computed(() => this.store.sortedTasks().filter((t) => !t.archived));
  protected readonly archived = computed(() => this.store.sortedTasks().filter((t) => t.archived));

  /** Groups in the order of their first task, so the group of a task that needs the user comes first. */
  protected readonly groups = computed<ProjectGroup[]>(() => groupByProject(this.active()));

  /** While the search box has text: every match, archived ones last and marked. Null otherwise. */
  protected readonly matches = computed(() => searchTasks(this.store.sortedTasks(), this.query()));

  protected toggleGrouped(): void {
    this.grouped.update((v) => !v);
    store(GROUPED_KEY, this.grouped());
  }

  protected toggleFold(key: string): void {
    const next = new Set(this.folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.folded.set(next);
    store(FOLDED_KEY, [...next]);
  }

  protected toggleArchived(): void {
    this.archivedOpen.update((v) => !v);
    store(ARCHIVED_OPEN_KEY, this.archivedOpen());
  }

  /** The row's ⋯: the menu opens under it, its right edge on the ⋯. */
  protected openMenuAt(event: MouseEvent, task: TaskSummary): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.store.menu.set({ taskId: task.id, x: box.right - 200, y: box.bottom + 4, origin: 'list' });
  }

  protected openMenu(event: MouseEvent, task: TaskSummary): void {
    event.preventDefault();
    this.store.menu.set({ taskId: task.id, x: event.clientX, y: event.clientY, origin: 'list' });
  }

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
