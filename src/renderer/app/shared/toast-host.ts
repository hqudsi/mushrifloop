/**
 * In-app notification toasts (design "System notification toast"), bottom right. Shown while the window
 * has focus; Windows shows the same notification otherwise (SPEC.md §10). "Open task" selects the task.
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { APP_NAME } from '../../../shared/app-config';
import { formatElapsed } from '../../../shared/format';
import { TasksStore, type ShownToast } from '../core/tasks-store';
import { AppMark } from './app-mark';

@Component({
  selector: 'app-toast-host',
  standalone: true,
  imports: [AppMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (toast of store.toasts(); track toast.id) {
      <div class="toast" [class]="'toast ' + toast.tone" role="status">
        <app-mark [size]="26" />
        <div class="main">
          <div class="top">
            <span class="title">{{ toast.title }}</span>
            <span class="meta">{{ appName }} · {{ when(toast) }}</span>
          </div>
          <div class="body">{{ toast.body }}</div>
          <div class="actions">
            <button type="button" class="open" (click)="open(toast)">Open task</button>
            <button type="button" class="dismiss" (click)="store.dismissToast(toast.id)">Dismiss</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 40;
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 360px;
        max-width: calc(100vw - 40px);
        pointer-events: none;
      }
      .toast {
        pointer-events: auto;
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 12px 14px;
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-left: 3px solid var(--waiting);
        border-radius: 6px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
        color: var(--text);
        font-size: 13px;
      }
      .toast.done {
        border-left-color: var(--success);
      }
      .toast.bad {
        border-left-color: var(--danger);
      }
      .toast.info {
        border-left-color: var(--planner);
      }
      .main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }
      .title {
        font-weight: 600;
      }
      .meta {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .body {
        color: var(--text-2);
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 6px;
      }
      .actions button {
        border: 0;
        padding: 0;
        background: transparent;
        font: 500 12px var(--font-sans);
        cursor: pointer;
      }
      .open {
        color: var(--planner);
      }
      .dismiss {
        color: var(--text-3);
      }
    `,
  ],
})
export class ToastHost {
  protected readonly store = inject(TasksStore);
  protected readonly appName = APP_NAME;

  protected when(toast: ShownToast): string {
    const ms = this.store.now() - Date.parse(toast.at);
    return ms < 60_000 ? 'now' : `${formatElapsed(ms)} ago`;
  }

  protected open(toast: ShownToast): void {
    this.store.dismissToast(toast.id);
    this.store.openTask(toast.taskId);
  }
}
