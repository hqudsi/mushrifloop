/**
 * A task's ⋯ menu (SPEC.md §10, managing tasks): Pin to top, Archive and Delete. Opened from the task header's
 * ⋯ button and by right-clicking a row of the task list; one menu at a time, placed where it was asked for and
 * kept inside the window. Escape, a click elsewhere or the window losing size closes it.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { notAtRestReason } from '../../../../shared/task-list';
import { TasksStore } from '../../core/tasks-store';

const MENU_WIDTH = 200;
const MENU_HEIGHT = 144;

@Component({
  selector: 'app-task-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()', '(window:resize)': 'close()' },
  template: `
    @if (state(); as s) {
      <div class="catcher" (mousedown)="close()" (contextmenu)="$event.preventDefault(); close()"></div>
      <div class="menu" role="menu" [style.left.px]="s.x" [style.top.px]="s.y" [attr.aria-label]="'Task ' + s.task.title">
        <button
          type="button"
          role="menuitem"
          [disabled]="s.task.unreadable !== null"
          [title]="s.task.unreadable !== null ? 'This task cannot be read, so it cannot be renamed. It can be deleted.' : 'Edit the name in place: Enter saves, Escape cancels. The description the agents work from is not changed.'"
          (click)="rename(s.task.id, s.origin)"
        >
          <span class="ico" aria-hidden="true">✎</span>Rename…
        </button>
        <button
          type="button"
          role="menuitem"
          [disabled]="s.task.archived || s.task.unreadable !== null"
          [title]="s.task.unreadable !== null ? 'This task cannot be read, so it cannot be pinned. It can be deleted.' : s.task.archived ? 'An archived task cannot be pinned. Unarchive it first.' : 'Keeps this task at the top of the list, under the tasks that need you.'"
          (click)="pin(s.task.id, !s.task.pinnedToTop)"
        >
          <span class="ico" aria-hidden="true">⇡</span>{{ s.task.pinnedToTop ? 'Unpin' : 'Pin to top' }}
        </button>
        @if (s.task.archived) {
          <button type="button" role="menuitem" title="Back in the task list." (click)="archive(s.task.id, false)">
            <span class="ico" aria-hidden="true">▣</span>Unarchive
          </button>
        } @else {
          <button
            type="button"
            role="menuitem"
            [disabled]="s.blocked !== null || s.task.unreadable !== null"
            [title]="s.task.unreadable !== null ? 'This task cannot be read, so it cannot be archived. It can be deleted.' : (s.blocked ?? 'Moves it to the Archived section at the foot of the list. Nothing is deleted.')"
            (click)="archive(s.task.id, true)"
          >
            <span class="ico" aria-hidden="true">▣</span>Archive
          </button>
        }
        <div class="sep"></div>
        <button
          type="button"
          role="menuitem"
          class="danger"
          [disabled]="s.blocked !== null"
          [title]="s.blocked ?? 'Moves the task\\'s folder to the Recycle Bin. Asks first.'"
          (click)="askDelete(s.task.id)"
        >
          <span class="ico" aria-hidden="true">✕</span>Delete…
        </button>
      </div>
    }
  `,
  styles: [
    `
      .catcher {
        position: fixed;
        inset: 0;
        z-index: 60;
      }
      .menu {
        position: fixed;
        z-index: 61;
        width: ${MENU_WIDTH}px;
        padding: 4px;
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
      }
      button {
        border: 0;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 12.5px;
        text-align: left;
        padding: 6px 8px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: var(--bg-hover);
      }
      button:disabled {
        color: var(--text-muted);
        cursor: default;
      }
      .danger:not(:disabled) {
        color: var(--danger);
      }
      .ico {
        width: 14px;
        text-align: center;
        color: var(--text-3);
      }
      .danger:not(:disabled) .ico {
        color: inherit;
      }
      .sep {
        height: 1px;
        margin: 4px 2px;
        background: var(--border);
      }
    `,
  ],
})
export class TaskMenu {
  protected readonly store = inject(TasksStore);

  protected readonly state = computed(() => {
    const m = this.store.menu();
    if (!m) return null;
    const task = this.store.tasks().find((t) => t.id === m.taskId);
    if (!task) return null;
    const x = Math.max(4, Math.min(m.x, window.innerWidth - MENU_WIDTH - 4));
    const y = Math.max(4, Math.min(m.y, window.innerHeight - MENU_HEIGHT - 4));
    return { task, x, y, origin: m.origin, blocked: notAtRestReason(task) };
  });

  protected close(): void {
    this.store.menu.set(null);
  }

  protected rename(taskId: string, origin: 'list' | 'header'): void {
    this.close();
    this.store.renameRequest.set({ taskId, origin });
  }

  protected pin(taskId: string, pinned: boolean): void {
    this.close();
    void this.store.manage(taskId, { kind: 'pin', pinned });
  }

  protected archive(taskId: string, archived: boolean): void {
    this.close();
    void this.store.manage(taskId, { kind: 'archive', archived });
  }

  protected askDelete(taskId: string): void {
    this.close();
    this.store.deleteAsk.set(taskId);
  }
}
