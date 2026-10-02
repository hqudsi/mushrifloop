/**
 * The first screen of an app with no tasks yet (SPEC.md §10).
 *
 * "No tasks" would be true and useless. Someone here has just installed the app and has to decide
 * what to hand a pair of agents, so this says what makes a good task, shows the loop they are about
 * to watch, and carries one editable example straight into the New task modal.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { APP_NAME } from '../../../../shared/app-config';
import { TasksStore } from '../../core/tasks-store';

const EXAMPLE = `The login page lets you submit the form twice if you double-click "Sign in", which creates two sessions.

Find where the submit handler is wired up, disable the button while the request is in flight, and add a test that double-clicking only sends one request.

Don't change the visual design, and don't touch the sign-up page.`;

@Component({
  selector: 'app-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <h1>Start your first task</h1>
      <p class="lead">
        {{ appName }} works on one task at a time, in one project folder, as a loop between a Planner and an
        Executor. You stay in charge of it.
      </p>

      <div class="cards">
        <div class="card step">
          <span class="n">1</span>
          <span class="t">Pick a project</span>
          <span class="d">A folder on this computer. If it is a git repository, each cycle is committed on its own branch, so you can undo anything.</span>
        </div>
        <div class="card step">
          <span class="n">2</span>
          <span class="t">Write a clear task</span>
          <span class="d">Say what is wrong or wanted, where to look, and what "done" means. Name anything that must not change.</span>
        </div>
        <div class="card step">
          <span class="n">3</span>
          <span class="t">Watch and approve</span>
          <span class="d">Every instruction and every result is shown as it happens. The task stops and asks you whenever a decision is yours.</span>
        </div>
      </div>

      <div class="field">
        <label class="label" for="example">An example — edit it, or write your own</label>
        <textarea id="example" rows="7" [value]="example()" (input)="example.set($any($event.target).value)"></textarea>
        <span class="hint">
          It is specific about the symptom, where to start, what to add, and what to leave alone.
        </span>
      </div>

      <button type="button" class="btn btn-accent start" (click)="start()">
        Create your first task <span class="kbd">Ctrl+N</span>
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        justify-content: center;
      }
      .wrap {
        width: 100%;
        max-width: 720px;
        padding: 40px 32px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      h1 {
        font-size: 19px;
        font-weight: 600;
      }
      .lead {
        color: var(--text-2);
        line-height: 1.6;
        max-width: 620px;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      @container content (max-width: 620px) {
        .cards {
          grid-template-columns: 1fr;
        }
      }
      .step {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .step .n {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--bg-button);
        color: var(--text-3);
        font-size: 11px;
      }
      .step .t {
        font-weight: 600;
        font-size: 13px;
      }
      .step .d {
        color: var(--text-3);
        font-size: 12px;
        line-height: 1.5;
      }
      textarea {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--bg-input);
        color: var(--text);
        font: inherit;
        line-height: 1.55;
        resize: vertical;
      }
      textarea:focus {
        outline: none;
        border-color: var(--planner);
      }
      .start {
        align-self: flex-start;
        gap: 10px;
      }
      .kbd {
        font: 11px var(--font-mono);
        opacity: 0.7;
      }
    `,
  ],
})
export class EmptyState {
  private readonly store = inject(TasksStore);

  protected readonly appName = APP_NAME;
  protected readonly example = signal(EXAMPLE);

  protected start(): void {
    this.store.newTaskDraft.set({ description: this.example().trim() });
    this.store.newTaskOpen.set(true);
  }
}
