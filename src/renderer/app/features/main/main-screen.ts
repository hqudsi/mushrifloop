/**
 * The main screen (SPEC.md §10, design "Main screen"): task list on the left, the selected task in the
 * centre, and the collapsible right panel (changed files, stats, context, usage, standing instructions).
 */

import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { api } from '../../core/api';
import { LayoutStore } from '../../core/layout-store';
import { PanelStore } from '../../core/panel-store';
import { ResizeHandle } from '../../shared/resize-handle';
import { TasksStore } from '../../core/tasks-store';
import { ControlBar } from './control-bar';
import { DeleteTaskDialog } from './delete-task-dialog';
import { EmptyState } from './empty-state';
import { RightPanel } from './right-panel';
import { TaskMenu } from './task-menu';
import { TaskList } from './task-list';
import { TaskView } from './task-view';

@Component({
  selector: 'app-main-screen',
  standalone: true,
  imports: [ControlBar, DeleteTaskDialog, EmptyState, ResizeHandle, RightPanel, TaskList, TaskMenu, TaskView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-task-list [style.width.px]="layout.left()" />
    <app-resize-handle side="left" />
    <section class="center">
      @if (store.detail(); as detail) {
        <app-task-view [detail]="detail" [summary]="store.selected()" />
      } @else if (store.detailFailure(); as failure) {
        <div class="header">Task {{ failure.taskId }}</div>
        <div class="empty">
          <div class="box wide">
            <div class="big">This task could not be read</div>
            <div class="callout danger failure">{{ failure.error }}</div>
            @if (failure.folder) {
              <div class="mono folder">{{ failure.folder }}</div>
              <button type="button" class="btn" (click)="openFolder(failure.folder)">Open the task folder</button>
              <button type="button" class="btn" title="Moves the task's folder to the Recycle Bin. Asks first." (click)="store.deleteAsk.set(failure.taskId)">Delete…</button>
            }
            @if (openError(); as err) {
              <div class="callout danger failure">{{ err }}</div>
            }
            <div class="text">Nothing was changed or deleted. Once the files are readable again, restart the app to load the task.</div>
          </div>
        </div>
        <app-control-bar class="dim" />
      } @else if (store.loaded() && store.tasks().length === 0) {
        <app-empty-state />
      } @else {
        <div class="header">{{ store.selectedId() && store.detailLoading() ? 'Loading…' : 'No task selected' }}</div>
        <div class="empty">
          @if (!store.selectedId() || !store.detailLoading()) {
            <div class="box">
              <div class="icon">▤</div>
              <div class="big">No task selected</div>
              <div class="text">
                Pick a task on the left to follow its loop, or start a new one. Tasks waiting for you are marked in the
                list.
              </div>
              <button type="button" class="btn btn-accent" (click)="store.newTaskOpen.set(true)">
                + New task <span class="kbd">Ctrl+N</span>
              </button>
            </div>
          }
        </div>
        <app-control-bar class="dim" />
      }
    </section>
    @if (store.detail(); as detail) {
      @if (panel.open()) {
        <app-resize-handle side="right" />
        <app-right-panel [detail]="detail" [style.width.px]="layout.right()" />
      }
    }
    <app-task-menu />
    <app-delete-task-dialog />
  `,
  styles: [
    `
      :host {
        flex: 1;
        display: flex;
        min-height: 0;
        min-width: 0;
      }
      .center {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        background: var(--bg);
      }
      .header {
        height: 48px;
        flex: none;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        padding: 0 24px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .empty {
        flex: 1;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .box {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        text-align: center;
        max-width: 320px;
      }
      .icon {
        width: 56px;
        height: 56px;
        border: 1px dashed var(--border-strong);
        border-radius: 8px;
        display: grid;
        place-items: center;
        color: var(--text-muted);
        font-size: 20px;
      }
      .big {
        font-size: 15px;
        font-weight: 600;
      }
      .text {
        color: var(--text-3);
        line-height: 1.55;
      }
      .kbd {
        font: 11px var(--font-mono);
        opacity: 0.7;
      }
      .box.wide {
        max-width: 560px;
      }
      .failure {
        text-align: left;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        align-self: stretch;
      }
      .folder {
        font-size: 11.5px;
        color: var(--text-3);
        overflow-wrap: anywhere;
      }
      .dim {
        opacity: 0.45;
      }
    `,
  ],
})
export class MainScreen {
  protected readonly store = inject(TasksStore);
  protected readonly panel = inject(PanelStore);
  protected readonly layout = inject(LayoutStore);
  protected readonly openError = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.store.detailFailure();
      this.openError.set(null);
    });
  }

  protected async openFolder(folder: string): Promise<void> {
    this.openError.set(null);
    try {
      const result = await api().openPath(folder);
      if (!result.ok) this.openError.set(`Could not open ${folder}: ${result.error ?? 'unknown error'}`);
    } catch (err) {
      this.openError.set(`Could not open ${folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
