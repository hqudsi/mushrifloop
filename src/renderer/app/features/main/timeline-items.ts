/**
 * The smaller timeline items: the task's starting point, rollovers, notes, user messages and the
 * final report.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { formatClock } from '../../../../shared/format';
import { ROLLOVER_HINT, type TimelineItem } from '../../../../shared/timeline';
import { TasksStore } from '../../core/tasks-store';
import { agentModelNote, agentModelText } from '../../shared/model-text';
import { RichText } from '../../shared/rich-text';
import { AnswerCheckLine, TurnError, turnMeta } from './turn-parts';

type StartItem = Extract<TimelineItem, { kind: 'start' }>;
type HandoffItem = Extract<TimelineItem, { kind: 'handoff' }>;
type NoteData = Extract<TimelineItem, { kind: 'note' }>;
type UserData = Extract<TimelineItem, { kind: 'user' }>;
type FinalItem = Extract<TimelineItem, { kind: 'final' }>;

const cardStyles = `
  .tl-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-tl-card);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-button);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-2);
    flex: none;
  }
  .who {
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .what {
    font-size: 11px;
    color: var(--text-3);
  }
  .meta {
    margin-left: auto;
    font: 11px var(--font-mono);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .body {
    padding: 10px 14px;
    line-height: 1.55;
    color: var(--text-2);
  }
`;

@Component({
  selector: 'app-start-card',
  standalone: true,
  imports: [RichText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tl-card">
      <div class="head">
        <span class="dot"></span>
        <span class="who">Task</span>
        <span class="what">starting point</span>
        <span class="meta">{{ clock() }}</span>
      </div>
      <div class="body"><app-rich-text [text]="item().description" /></div>
      <dl>
        <dt>Project</dt>
        <dd class="mono">{{ item().projectDir }}</dd>
        @if (item().setup; as s) {
          <dt>Git</dt>
          <dd>
            @if (s.branch) {
              branch <span class="mono">{{ s.branch }}</span> from
              <span class="mono">{{ s.originalBranch ?? 'an unborn branch' }}</span>
              @if (s.startCommit) {
                at <span class="mono">{{ s.startCommit.slice(0, 7) }}</span>
              }
              · {{ s.hasRemote ? 'has a remote' : 'no remote' }}
            } @else {
              {{ s.inertReason ?? 'not used' }}
            }
          </dd>
          @if (item().snapshot; as snap) {
            <dt>Your work</dt>
            <dd>
              uncommitted changes committed first as
              <span class="mono">{{ snap.hash.slice(0, 7) }}</span> “{{ snap.message }}” —
              {{ snap.files.length }} file{{ snap.files.length === 1 ? '' : 's' }}
              <span class="files mono">{{ snap.files.join(', ') }}</span>
            </dd>
          }
          <dt>Skills</dt>
          <dd>
            {{ s.skills === null ? 'unknown (' + (s.skillsError ?? 'not discovered') + ')' : s.skills + ' available' }}
            @if (s.missingRequiredSkills.length) {
              · <span class="warn">required but not offered here: {{ s.missingRequiredSkills.join(', ') }}</span>
            }
          </dd>
        } @else {
          <dt>Setup</dt>
          <dd class="muted">not done yet</dd>
        }
        <dt>Agents</dt>
        <dd>
          Planner <span [title]="agentNote('planner')">{{ agent('planner') }}</span> · Executor
          <span [title]="agentNote('executor')">{{ agent('executor') }}</span>
        </dd>
        <dt>Rules</dt>
        <dd>
          {{ item().config.approvalMode }} · max {{ item().config.maxCycles }} cycles · required skills:
          {{ item().config.requiredSkills.join(', ') || 'none' }}
        </dd>
        <dt>Account</dt>
        <dd>
          {{ item().pinned.email ?? 'API key' }} · {{ item().pinned.orgName ?? '—' }} · {{ item().pinned.subscriptionType ?? '—' }}
        </dd>
      </dl>
    </div>
  `,
  styles: [
    cardStyles,
    `
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 14px;
        padding: 0 14px 12px;
        font-size: 12px;
        color: var(--text-3);
      }
      dt {
        color: var(--text-muted);
      }
      dd {
        overflow-wrap: anywhere;
      }
      .files {
        display: block;
        font-size: 11px;
        color: var(--text-muted);
      }
      .warn {
        color: var(--executor);
      }
      .muted {
        color: var(--text-muted);
      }
    `,
  ],
})
export class StartCard {
  readonly item = input.required<StartItem>();
  private readonly tasks = inject(TasksStore);
  protected readonly clock = computed(() => formatClock(this.item().at));
  /** What the configured model runs as on the installed CLI; each turn card shows what actually ran (SPEC.md §8). */
  protected agent(which: 'planner' | 'executor'): string {
    const a = this.item().config[which];
    return agentModelText(a.model, a.effort, this.tasks.account()?.cliVersion ?? null);
  }
  protected agentNote(which: 'planner' | 'executor'): string {
    return agentModelNote(this.item().config[which].model, this.tasks.account()?.cliVersion ?? null);
  }
}

@Component({
  selector: 'app-handoff-card',
  standalone: true,
  imports: [AnswerCheckLine, TurnError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tl-card">
      <div class="head">
        <span class="dot" [class]="'dot ' + item().agent"></span>
        <span class="who" [title]="hint">{{ label() }} rollover</span>
        <span class="what">{{ item().card.state === 'running' ? 'writing a handoff summary…' : 'handoff to a new session' }}</span>
        <span class="meta">{{ meta() }}</span>
      </div>
      @if (item().rollover; as r) {
        <div class="body">
          {{ r.reason }} — session <span class="mono">{{ r.oldSessionId.slice(0, 8) }}</span> →
          <span class="mono">{{ r.newSessionId.slice(0, 8) }}</span>
          @if (r.summary; as s) {
            <details>
              <summary>Handoff summary</summary>
              <p>{{ s.task_restatement }}</p>
              @if (s.done_so_far.length) {
                <b>Done</b>
                <ul>
                  @for (x of s.done_so_far; track $index) {
                    <li>{{ x }}</li>
                  }
                </ul>
              }
              @if (s.remaining.length) {
                <b>Remaining</b>
                <ul>
                  @for (x of s.remaining; track $index) {
                    <li>{{ x }}</li>
                  }
                </ul>
              }
            </details>
          }
        </div>
      }
      @if (item().card.answerCheck; as check) {
        <app-answer-check [check]="check" kind="handoff" />
      }
      @if (item().card.state === 'failed' && item().card.error; as error) {
        <app-turn-error [error]="error" />
      }
    </div>
  `,
  styles: [
    cardStyles,
    `
      .dot.planner {
        background: var(--planner);
      }
      .dot.executor {
        background: var(--executor);
      }
      .body {
        font-size: 12px;
      }
      details {
        margin-top: 6px;
      }
      summary {
        cursor: pointer;
      }
      p,
      ul {
        margin: 4px 0 4px 16px;
      }
    `,
  ],
})
export class HandoffCard {
  private readonly store = inject(TasksStore);
  readonly item = input.required<HandoffItem>();
  protected readonly hint = ROLLOVER_HINT;
  protected readonly label = computed(() => (this.item().agent === 'planner' ? 'Planner' : 'Executor'));
  protected readonly meta = computed(() => turnMeta(this.item().card, this.store.now(), this.store.account()?.cliVersion ?? null));
}

@Component({
  selector: 'app-note-item',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="time mono">{{ clock() }}</span>
    <div class="text">
      <span class="title" [attr.title]="item().hint ?? null">{{ item().title }}</span>
      @if (item().text) {
        <span class="detail">{{ item().text }}</span>
      }
    </div>
  `,
  host: { '[class]': "'tone-' + item().tone" },
  styles: [
    `
      :host {
        display: flex;
        gap: 10px;
        align-items: baseline;
        padding: 6px 12px;
        border-left: 2px solid var(--border-strong);
        font-size: 12px;
        color: var(--text-3);
      }
      .time {
        font-size: 11px;
        color: var(--text-muted);
        flex: none;
      }
      .text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .title {
        font-weight: 500;
        color: var(--text-2);
      }
      .detail {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 8.5em;
        overflow: auto;
      }
      :host(.tone-warn) {
        border-left-color: var(--executor);
      }
      :host(.tone-warn) .title {
        color: var(--executor);
      }
      :host(.tone-danger) {
        border-left-color: var(--danger);
      }
      :host(.tone-danger) .title {
        color: var(--danger);
      }
      :host(.tone-success) {
        border-left-color: var(--success);
      }
      :host(.tone-success) .title {
        color: var(--success);
      }
      :host(.tone-wait) {
        border-left-color: var(--waiting);
      }
      :host(.tone-wait) .title {
        color: var(--waiting);
      }
    `,
  ],
})
export class NoteItem {
  readonly item = input.required<NoteData>();
  protected readonly clock = computed(() => formatClock(this.item().at));
}

@Component({
  selector: 'app-user-item',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tl-card user">
      <div class="head">
        <span class="dot"></span>
        <span class="who">{{ item().title }}</span>
        <span class="meta">{{ clock() }}</span>
      </div>
      @if (item().text) {
        <div class="body">{{ item().text }}</div>
      }
    </div>
  `,
  styles: [
    cardStyles,
    `
      :host {
        display: flex;
        justify-content: flex-end;
      }
      .tl-card.user {
        width: 72%;
        border-color: var(--border-strong);
        background: var(--bg-user-card);
      }
      .tl-card.user .head {
        background: transparent;
        border-bottom-color: var(--border-strong);
      }
      .body {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class UserItem {
  readonly item = input.required<UserData>();
  protected readonly clock = computed(() => formatClock(this.item().at));
}

@Component({
  selector: 'app-final-card',
  standalone: true,
  imports: [RichText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tl-card final">
      <div class="head">
        <span class="dot"></span>
        <span class="who">Done</span>
        <span class="what">final report</span>
        <span class="meta">{{ clock() }}</span>
      </div>
      <div class="body"><app-rich-text [text]="item().report" /></div>
    </div>
  `,
  styles: [
    cardStyles,
    `
      .tl-card.final {
        border-color: color-mix(in srgb, var(--success) 50%, var(--border));
      }
      .final .head {
        background: var(--success-bg);
      }
      .final .dot {
        background: var(--success);
      }
      .final .who {
        color: var(--success);
      }
    `,
  ],
})
export class FinalCard {
  readonly item = input.required<FinalItem>();
  protected readonly clock = computed(() => formatClock(this.item().at));
}
