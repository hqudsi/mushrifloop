/**
 * Approval modes (SPEC.md §7). `review`: the Planner's instruction waits here before it reaches the
 * Executor — approve it, edit it, or reject it with a reason for the Planner. `plan_first`: the plan
 * waits here once; approving it lets the task run in auto. Every decision goes to the orchestrator.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import type { TaskAction } from '../../../../shared/ipc';
import type { WaitingState } from '../../../../shared/task-model';
import { TasksStore } from '../../core/tasks-store';

type Approval = Extract<WaitingState, { kind: 'instruction_approval' | 'plan_approval' }>;
type Mode = 'view' | 'edit' | 'reject';

@Component({
  selector: 'app-approval-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'waiting-anchor' },
  template: `
    @let w = waiting();
    @if (reopened()) {
      <div class="reopened">
        This task had finished. Approving starts work again on it; the cycle count carries on. If you
        only meant to ask something, reject with your question instead — nothing runs.
      </div>
    }
    <div class="head">
      <span class="dot"></span>
      <span class="who">Planner</span>
      <span class="what">{{ isPlan() ? 'proposes a plan' : 'next instruction' }}</span>
      <span class="pill waiting">Needs your approval</span>
    </div>

    @if (mode() === 'edit') {
      <div class="body">
        <label class="caps" for="approval-edit">{{ isPlan() ? 'EDIT THE PLAN' : 'EDIT THE INSTRUCTION' }}</label>
        <textarea
          id="approval-edit"
          class="area"
          [rows]="isPlan() ? 12 : 6"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown)="onKey($event)"
        ></textarea>
        <div class="hint">
          {{ isPlan() ? 'The Planner is told you edited its plan and works from your version.' : 'Your version is what the Executor receives; the edit is recorded in the log.' }}
        </div>
      </div>
    } @else {
      <!-- Verbatim: what you approve is exactly what is sent (no formatting that could hide characters). -->
      <div class="body text">{{ text() }}</div>
    }

    @if (w.kind === 'instruction_approval') {
      @if (w.useSkills.length > 0) {
        <div class="line">
          Skills to run first:
          @for (s of w.useSkills; track s) {
            <code class="inline">{{ s }}</code>
          }
        </div>
      }
      @if (w.reasoning) {
        <div class="line muted">Why: {{ w.reasoning }}</div>
      }
    }

    @if (mode() === 'reject') {
      <div class="body reject">
        <label class="caps" for="approval-reason">WHY? — SENT TO THE PLANNER</label>
        <textarea
          id="approval-reason"
          class="area"
          rows="3"
          [placeholder]="isPlan() ? 'What should change in the plan…' : 'What is wrong with this instruction…'"
          [value]="reason()"
          (input)="reason.set($any($event.target).value)"
          (keydown)="onKey($event)"
        ></textarea>
      </div>
    }

    <div class="actions">
      @switch (mode()) {
        @case ('view') {
          <button type="button" class="btn btn-accent" [disabled]="busy()" (click)="approve(false)">
            {{ isPlan() ? 'Approve plan' : 'Approve and send' }}
          </button>
          <button type="button" class="btn" [disabled]="busy()" (click)="startEdit()">Edit…</button>
          <button type="button" class="btn danger" [disabled]="busy()" (click)="startReject()">Reject…</button>
          <span class="hint">
            {{ isPlan() ? 'Once approved, the task runs in auto mode: instructions go to the Executor without asking.' : 'The Executor stays idle until you decide.' }}
          </span>
        }
        @case ('edit') {
          <button type="button" class="btn btn-accent" [disabled]="busy() || draft().trim() === ''" (click)="approve(true)">
            {{ isPlan() ? 'Approve edited plan' : 'Approve and send edited' }}
          </button>
          <button type="button" class="btn" [disabled]="busy()" (click)="mode.set('view')">Cancel</button>
          <span class="kbd">Ctrl+Enter</span>
        }
        @case ('reject') {
          <button type="button" class="btn danger solid" [disabled]="busy() || reason().trim() === ''" (click)="reject()">
            Reject and tell the Planner
          </button>
          <button type="button" class="btn" [disabled]="busy()" (click)="mode.set('view')">Cancel</button>
          <span class="kbd">Ctrl+Enter</span>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        border: 1px solid var(--waiting);
        box-shadow: 0 0 0 3px var(--waiting-bg);
        border-radius: 6px;
        background: var(--bg-tl-card);
        overflow: hidden;
      }
      /* SPEC.md §7: why this approval is being asked for at all. */
      .reopened {
        margin-bottom: 10px;
        padding: 8px 10px;
        border-radius: var(--radius);
        background: var(--waiting-bg);
        color: var(--waiting);
        font-size: 12px;
        line-height: 1.5;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 14px;
        background: var(--planner-bg);
        border-bottom: 1px solid var(--border);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--planner);
        flex: none;
      }
      .who {
        font-weight: 600;
        color: var(--planner);
        font-size: 12.5px;
      }
      .what {
        font-size: 11px;
        color: var(--text-3);
      }
      .pill {
        margin-left: auto;
      }
      .body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .body.text {
        display: block;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 13.5px;
        line-height: 1.6;
        color: var(--text);
        max-height: 480px;
        overflow-y: auto;
      }
      .body.reject {
        border-top: 1px solid var(--border);
      }
      .caps {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-muted);
      }
      .area {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        background: var(--bg-input);
        color: var(--text);
        font-size: 13px;
        line-height: 1.5;
        padding: 8px 10px;
        outline: 0;
      }
      .area:focus {
        border-color: var(--planner);
      }
      .line {
        padding: 0 14px 8px;
        font-size: 12px;
        color: var(--text-2);
      }
      .line code {
        margin-left: 4px;
      }
      .muted {
        color: var(--text-muted);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 10px 14px;
        border-top: 1px solid var(--border);
        background: var(--bg-card);
      }
      .hint {
        font-size: 11.5px;
        color: var(--text-muted);
      }
      .kbd {
        margin-left: auto;
        font: 11px var(--font-mono);
        color: var(--text-muted);
      }
      .btn.danger {
        color: var(--danger);
      }
      .btn.danger.solid {
        background: var(--danger-bg);
        border-color: var(--danger);
      }
    `,
  ],
})
export class ApprovalCard {
  private readonly store = inject(TasksStore);

  readonly waiting = input.required<Approval>();
  /** The task had finished and a message reopened it, so this approval is forced (SPEC.md §7). */
  readonly reopened = input(false);

  protected readonly mode = signal<Mode>('view');
  protected readonly draft = signal('');
  protected readonly reason = signal('');

  protected readonly isPlan = computed(() => this.waiting().kind === 'plan_approval');
  protected readonly text = computed(() => {
    const w = this.waiting();
    return w.kind === 'plan_approval' ? w.plan : w.instruction;
  });
  protected readonly busy = computed(() => this.store.pendingAction() !== null);

  constructor() {
    // A new approval (after a rejection the Planner proposes again) starts clean.
    effect(() => {
      void this.waiting().since;
      untracked(() => {
        this.mode.set('view');
        this.draft.set('');
        this.reason.set('');
      });
    });
  }

  protected startEdit(): void {
    this.draft.set(this.text());
    this.mode.set('edit');
    setTimeout(() => (document.getElementById('approval-edit') as HTMLTextAreaElement | null)?.focus());
  }

  protected startReject(): void {
    this.mode.set('reject');
    setTimeout(() => (document.getElementById('approval-reason') as HTMLTextAreaElement | null)?.focus());
  }

  protected approve(edited: boolean): void {
    const plan = this.isPlan();
    const text = this.draft().trim();
    let action: TaskAction;
    if (edited && text !== '') action = plan ? { kind: 'approve_plan', edited: text } : { kind: 'approve_instruction', edited: text };
    else action = plan ? { kind: 'approve_plan' } : { kind: 'approve_instruction' };
    void this.store.act(action);
  }

  protected reject(): void {
    const reason = this.reason().trim();
    if (!reason) return;
    void this.store.act(this.isPlan() ? { kind: 'reject_plan', reason } : { kind: 'reject_instruction', reason });
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (this.mode() === 'edit' && this.draft().trim() !== '') this.approve(true);
    if (this.mode() === 'reject') this.reject();
  }
}
