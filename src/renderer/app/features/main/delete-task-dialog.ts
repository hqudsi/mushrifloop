/**
 * Delete a task (SPEC.md §10, managing tasks): says exactly what goes — the task's folder in the app's data
 * folder, to the Recycle Bin — and what stays: the project and its code, the task's git branch, and Claude
 * Code's own session files. Nothing happens until "Move to Recycle Bin"; a refusal keeps the dialog open with
 * the raw error.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { TasksStore } from '../../core/tasks-store';

@Component({
  selector: 'app-delete-task-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    @if (task(); as t) {
      <div class="backdrop" (mousedown)="$event.target === $event.currentTarget && close()">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-body">
          <div class="top">
            <span id="del-title" class="title">Delete “{{ t.title }}”?</span>
            <button type="button" class="close" aria-label="Close" [disabled]="busy()" (click)="close()">✕</button>
          </div>
          <div class="body" id="del-body">
            <div class="block">
              <div class="k">Goes to the Recycle Bin</div>
              @if (t.unreadable !== null) {
                <div>This task's folder, whose files cannot be read: <span class="mono">{{ t.projectDir }}</span>. It can be restored from the Recycle Bin.</div>
              } @else {
                <div>The task's own folder: its history, the raw Claude Code output of every turn, and the Planner's folder. It can be restored from the Recycle Bin.</div>
              }
            </div>
            <div class="block">
              <div class="k">Stays as it is</div>
              <ul>
                @if (t.unreadable === null) {
                  <li>The project folder and its code: <span class="mono">{{ t.projectDir }}</span></li>
                } @else {
                  <li>The project folder and its code, wherever it is (this task's files cannot be read, so its project is not known here).</li>
                }
                @if (t.gitBranch) {
                  <li>The task's git branch <span class="mono">{{ t.gitBranch }}</span>. Delete it with git if you no longer want it.</li>
                }
                <li>Claude Code's own session files (under <span class="mono">~/.claude</span>).</li>
              </ul>
            </div>
            @if (error(); as e) {
              <div class="callout danger">
                {{ e.message }}
                @if (e.nextStep) {
                  <div class="next">{{ e.nextStep }}</div>
                }
              </div>
            }
          </div>
          <div class="foot">
            <button type="button" class="btn" [disabled]="busy()" (click)="close()">Cancel</button>
            <button type="button" class="btn btn-danger" [disabled]="busy()" (click)="confirm(t.id)">
              {{ busy() ? 'Moving…' : 'Move to Recycle Bin' }}
            </button>
          </div>
        </div>
      </div>
    }
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
        width: 520px;
        max-width: 100%;
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border);
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .close {
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 13px;
      }
      .body {
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        color: var(--text-2);
      }
      .k {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-3);
        margin-bottom: 4px;
      }
      ul {
        margin: 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: 11.5px;
        word-break: break-all;
      }
      .next {
        margin-top: 4px;
        color: var(--text-2);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--border);
      }
      .btn-danger {
        background: var(--danger);
        border-color: var(--danger);
        color: #fff;
        font-weight: 600;
      }
    `,
  ],
})
export class DeleteTaskDialog {
  private readonly store = inject(TasksStore);
  protected readonly busy = signal(false);
  protected readonly error = signal<{ message: string; nextStep?: string } | null>(null);

  protected readonly task = computed(() => {
    const id = this.store.deleteAsk();
    return id ? (this.store.tasks().find((t) => t.id === id) ?? null) : null;
  });

  protected close(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.store.deleteAsk.set(null);
  }

  protected async confirm(taskId: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const result = await this.store.deleteTask(taskId);
    this.busy.set(false);
    if (result.ok) {
      this.store.deleteAsk.set(null);
      return;
    }
    this.error.set({ message: result.error ?? 'The task could not be deleted.', ...(result.nextStep ? { nextStep: result.nextStep } : {}) });
  }
}
