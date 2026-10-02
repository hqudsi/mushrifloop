/**
 * Bottom control bar (SPEC.md §10, design): Pause, Stop, Resume, and the composer.
 *
 * Every message goes to the Planner — there is no recipient to pick (§6) — and the composer is never
 * closed: on a task that has finished it says, before anything is sent, that the message may be
 * answered from what the Planner knows or may start work again (§4).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';

import type { TaskAction } from '../../../../shared/ipc';
import { coldSessionNote } from '../../../../shared/session-age';
import type { TaskRecord } from '../../../../shared/task-model';
import { TasksStore } from '../../core/tasks-store';

type Mode = 'none' | 'reopen' | 'answer' | 'waiver' | 'paused' | 'approval' | 'running' | 'queued' | 'draft';

interface ModeInfo {
  label: string;
  sub: string;
  placeholder: string;
  /** Composer usable at all. */
  enabled: boolean;
  urgent: boolean;
}

const MODES: Record<Mode, ModeInfo> = {
  none: { label: '', sub: '', placeholder: 'Select a task to intervene', enabled: false, urgent: false },
  /** SPEC.md §4: done, failed, stopped and error all take a message, and it may do either thing. */
  reopen: {
    label: 'This task has finished',
    sub: '— your message may be answered, or start work again; you approve the first instruction',
    placeholder: 'Ask about it, or ask for more…',
    enabled: true,
    urgent: false,
  },
  answer: {
    label: "Reply to Planner's question",
    sub: '— task resumes after you send',
    placeholder: 'Answer the Planner…',
    enabled: true,
    urgent: true,
  },
  waiver: {
    label: 'Keep the requirement and reply to the Planner',
    sub: '— or waive the skill above',
    placeholder: 'Tell the Planner how to proceed…',
    enabled: true,
    urgent: true,
  },
  paused: {
    label: 'Paused',
    sub: '— Resume, or send a message (the task resumes)',
    placeholder: 'Tell the Planner how to proceed…',
    enabled: true,
    urgent: true,
  },
  approval: {
    label: 'Waiting for your approval',
    sub: '— approve, edit or reject it above',
    placeholder: 'Messages are closed until the approval is decided',
    enabled: false,
    urgent: true,
  },
  running: {
    label: 'Message the Planner',
    sub: '— delivered when the current turn ends',
    placeholder: 'Message the Planner…',
    enabled: true,
    urgent: false,
  },
  queued: {
    label: 'Message the Planner',
    sub: '— delivered when you Resume',
    placeholder: 'Message the Planner…',
    enabled: true,
    urgent: false,
  },
  draft: {
    label: 'Message the Planner',
    sub: '— delivered when the task starts',
    placeholder: 'Message the Planner…',
    enabled: true,
    urgent: false,
  },
};

@Component({
  selector: 'app-control-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="content-column bar">
      @if (store.actionError(); as error) {
        <div class="callout danger" role="alert">
          @if (error.blockedBy; as other) {
            A task is already running:
            <button type="button" class="link" (click)="store.openTask(other.taskId)" [title]="'Open ' + other.title">{{ other.title }}</button>
          } @else {
            {{ error.message }}
          }
          @if (error.nextStep) {
            <span class="next">{{ error.nextStep }}</span>
          }
        </div>
      }
      @if (info().label) {
        <div class="label-row">
          <span class="ldot" [class.urgent]="info().urgent"></span>
          <span class="mode-label" [class.urgent]="info().urgent">{{ info().label }}</span>
          <span class="sub">{{ info().sub }}</span>
          @if (info().enabled) {
            <span class="kbd">Ctrl+Enter to send</span>
          }
        </div>
        @if (coldNote(); as note) {
          <div class="cold">{{ note }}</div>
        }
      }
      <div class="controls">
        <div class="buttons">
          @if (canResume()) {
            <button type="button" class="btn ctl accent" [disabled]="busyAction()" (click)="act(resumeKind())">
              <span class="glyph">▶</span>{{ resumeKind() === 'start' ? 'Start' : 'Resume' }}
            </button>
          } @else {
            <button
              type="button"
              class="btn ctl"
              [disabled]="!canPause() || busyAction()"
              (click)="act('pause')"
              title="Finish the current turn, then hold"
            >
              <span class="glyph">❙❙</span>Pause
            </button>
          }
          <button type="button" class="btn ctl stop" [disabled]="!canStop() || busyAction()" (click)="act('stop')" title="Kill the current process">
            <span class="glyph">■</span>Stop
          </button>
        </div>
        <div class="composer" [class.urgent]="info().urgent && info().enabled" [class.disabled]="!info().enabled">
          @if (mode() !== 'none') {
            <span class="to" title="Every message goes to the Planner (SPEC §6)">
              <span class="rdot"></span>To Planner
            </span>
          }
          <textarea
            class="input-box"
            rows="1"
            [placeholder]="info().placeholder"
            [disabled]="!info().enabled"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
            (keydown)="onKey($event)"
            aria-label="Message"
          ></textarea>
          @if (mode() !== 'none') {
            <button type="button" class="send" [disabled]="!canSend()" (click)="send()">Send</button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: none;
        border-top: 1px solid var(--border);
        background: var(--bg-chrome);
        padding: 10px 0 14px;
      }
      .bar {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .callout .next {
        display: block;
        margin-top: 2px;
        color: var(--text-2);
      }
      .link {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--planner);
        font: inherit;
        font-weight: 600;
        text-decoration: underline;
        cursor: pointer;
      }
      .label-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        min-width: 0;
      }
      .ldot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-muted);
        flex: none;
      }
      .ldot.urgent {
        background: var(--waiting);
      }
      .mode-label {
        font-weight: 600;
        color: var(--text-2);
        white-space: nowrap;
      }
      /* Says what a follow-up on an old task costs. Quiet on purpose: it informs, it does not warn
         (SPEC.md §10) — nothing about it blocks or needs dismissing. */
      .cold {
        margin: 2px 0 0 14px;
        color: var(--text-muted);
        font-size: 11px;
        line-height: 1.4;
      }
      .mode-label.urgent {
        color: var(--waiting);
      }
      .sub {
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .kbd {
        margin-left: auto;
        font: 11px var(--font-mono);
        color: var(--text-muted);
        white-space: nowrap;
      }
      /* The buttons keep their height and sit at the bottom however tall the composer grows. */
      .controls {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      .buttons {
        display: flex;
        gap: 6px;
        flex: none;
      }
      .ctl {
        height: 34px;
      }
      .ctl:hover:not(:disabled) {
        background: var(--bg-button-hover);
      }
      .ctl.stop {
        color: var(--danger);
      }
      .ctl.accent {
        color: var(--planner);
      }
      .glyph {
        font-size: 10px;
      }
      .composer {
        flex: 1;
        min-width: 0;
        display: flex;
        border: 1px solid var(--border-strong);
        border-radius: 6px;
        background: var(--bg-input);
        overflow: hidden;
        align-items: flex-end;
      }
      .composer.urgent {
        border-color: var(--waiting);
      }
      .composer.disabled {
        border-color: var(--border);
      }
      /* Where the message goes. Not a choice any more (SPEC.md §6), so it is a label, not a toggle:
         the strip spans the composer's height and the text sits on the bottom row. */
      .to {
        align-self: stretch;
        display: flex;
        align-items: flex-end;
        gap: 6px;
        padding: 10px 10px 11px;
        border-right: 1px solid var(--border);
        background: var(--bg-tl-card);
        color: var(--planner);
        font-size: 12px;
        font-weight: 500;
        flex: none;
        white-space: nowrap;
      }
      .rdot {
        width: 6px;
        height: 6px;
        margin-bottom: 5px;
        border-radius: 50%;
        background: var(--planner);
      }
      .input-box {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text);
        font-size: 13px;
        /* One line plus this padding and the border is the 34px of the buttons beside it. */
        padding: 7px 12px;
        resize: none;
        line-height: 1.4;
        min-height: 32px;
        /* Grows with the text up to 4 lines, then scrolls (SPEC.md §10). */
        max-height: calc(4lh + 14px);
        overflow-y: auto;
        field-sizing: content;
      }
      .input-box:disabled {
        color: var(--text-muted);
      }
      .send {
        flex: none;
        height: 24px;
        margin: 4px;
        padding: 0 14px;
        border: 0;
        border-radius: 4px;
        background: var(--planner);
        color: var(--on-accent);
        font-weight: 600;
        font-size: 12.5px;
        cursor: pointer;
      }
      .send:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .send:disabled {
        opacity: 0.45;
        cursor: default;
      }
    `,
  ],
})
export class ControlBar {
  protected readonly store = inject(TasksStore);

  readonly task = input<TaskRecord | null>(null);
  readonly busy = input(false);

  protected readonly text = signal('');

  protected readonly mode = computed<Mode>(() => {
    const t = this.task();
    if (!t) return 'none';
    switch (t.status) {
      case 'done':
      case 'failed':
      case 'stopped':
      case 'error':
        return 'reopen';
      case 'draft':
        return 'draft';
      case 'running':
        return 'running';
      case 'waiting_user':
        switch (t.waiting?.kind) {
          case 'question':
            return 'answer';
          case 'skill_waiver':
            return 'waiver';
          case 'instruction_approval':
          case 'plan_approval':
            return 'approval';
          default:
            return 'paused';
        }
      default:
        // rate_limited and account_mismatch: the message waits for Resume (SPEC.md §4).
        return 'queued';
    }
  });

  /** The "finished" label is only true of a task that finished; the rest stopped (SPEC.md §4). */
  protected readonly info = computed<ModeInfo>(() => {
    const info = MODES[this.mode()];
    if (this.mode() !== 'reopen') return info;
    const status = this.task()?.status;
    const label =
      status === 'done'
        ? 'This task has finished'
        : status === 'failed'
          ? 'This task ended without finishing'
          : status === 'stopped'
            ? 'This task is stopped'
            : 'This task stopped with an error';
    return { ...info, label };
  });
  /**
   * A finished task whose sessions have gone cold: resuming re-creates their context, which is most
   * of what a late follow-up costs (SPEC.md §10, measured in NOTES.md §36). Said once, quietly,
   * before the message is sent; it blocks nothing.
   */
  protected readonly coldNote = computed(() => {
    if (this.mode() !== 'reopen') return null;
    return coldSessionNote(this.task()?.statusChangedAt, this.store.now());
  });

  protected readonly busyAction = computed(() => this.store.pendingAction() !== null);
  protected readonly canPause = computed(() => this.task()?.status === 'running');
  protected readonly canStop = computed(() => {
    const s = this.task()?.status;
    return s !== undefined && s !== 'done' && s !== 'failed' && s !== 'stopped';
  });
  protected readonly canResume = computed(() => {
    const t = this.task();
    if (!t) return false;
    if (['draft', 'stopped', 'error', 'rate_limited', 'account_mismatch'].includes(t.status)) return true;
    return t.status === 'waiting_user' && (t.waiting?.kind === 'paused' || t.waiting?.kind === 'possible_loop');
  });
  protected readonly resumeKind = computed<'start' | 'resume'>(() => (this.task()?.status === 'draft' ? 'start' : 'resume'));
  protected readonly canSend = computed(() => this.info().enabled && this.text().trim() !== '' && !this.busyAction());

  constructor() {
    // A different task starts with an empty composer.
    let lastId: string | null = null;
    effect(() => {
      const id = this.task()?.id ?? null;
      if (id !== lastId) {
        lastId = id;
        this.text.set('');
      }
    });
  }

  protected act(kind: 'pause' | 'stop' | 'resume' | 'start'): void {
    void this.store.act({ kind });
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.send();
    }
  }

  protected send(): void {
    if (!this.canSend()) return;
    const text = this.text().trim();
    let action: TaskAction;
    switch (this.mode()) {
      case 'answer':
      case 'paused':
        action = { kind: 'answer', text };
        break;
      case 'waiver':
        action = { kind: 'decline_waiver', text };
        break;
      default:
        action = { kind: 'send', text };
    }
    void this.store.act(action).then((ok) => {
      if (ok) this.text.set('');
    });
  }
}
