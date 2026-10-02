/**
 * A Planner turn that is not part of a cycle: its first look at the task, a question, a plan, the
 * decision that the task is done, or an instruction that was not sent (yet). The question the task is
 * waiting on is the main screen's primary state (SPEC.md §10) and is drawn to stand out.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import type { PlannerCard as PlannerCardData } from '../../../../shared/timeline';
import { TasksStore } from '../../core/tasks-store';
import { RichText } from '../../shared/rich-text';
import { AnswerCheckLine, TurnError, turnMeta } from './turn-parts';

const PURPOSE: Record<string, string> = {
  start: 'first look at the task',
  executor_report: 'review',
  answer: 'after your answer',
  user_message: 'after your message',
  refusal: 'after a refusal',
  plan_decision: 'after your plan decision',
  instruction_rejected: 'after your rejection',
};

@Component({
  selector: 'app-planner-card',
  standalone: true,
  imports: [AnswerCheckLine, RichText, TurnError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.waiting]': 'waiting()', '[class.pending]': 'pending() !== null' },
  template: `
    <div class="head">
      <span class="dot"></span>
      <span class="who">Planner</span>
      <span class="what">{{ what() }}</span>
      @if (waiting()) {
        <span class="pill waiting">Needs your answer</span>
      }
      @if (pending()) {
        <span class="pill waiting">Awaiting your approval</span>
      }
      @if (card().state === 'running') {
        <span class="typing"><i></i><i></i><i></i></span>
      }
      <span class="meta mono">{{ meta() }}</span>
    </div>

    @switch (card().state) {
      @case ('running') {
        <div class="body muted">Thinking ({{ purposeText() }})…</div>
      }
      @case ('failed') {
        @if (card().error; as error) {
          <app-turn-error [error]="error" />
        }
      }
      @case ('interrupted') {
        <div class="body warn">The app stopped during this turn. Resume retries it.</div>
      }
      @default {
        @if (pending()) {
          <div class="body muted">
            {{ pending() === 'plan' ? 'The plan is shown below for your approval.' : 'The instruction is shown below for your approval — it has not been sent to the Executor.' }}
          </div>
        } @else if (card().output; as out) {
          @switch (out.status) {
            @case ('needs_user') {
              <div class="body question"><app-rich-text [text]="out.question ?? ''" /></div>
            }
            @case ('blocked') {
              <div class="body question"><app-rich-text [text]="out.question ?? ''" /></div>
            }
            @case ('plan_ready') {
              <div class="body"><app-rich-text [text]="out.question ?? ''" /></div>
            }
            @case ('continue') {
              <div class="body"><app-rich-text [text]="out.next_instruction ?? ''" /></div>
              <div class="unsent">Not sent to the Executor.</div>
            }
            @case ('done') {
              <div class="body muted">{{ out.reasoning_summary }}</div>
            }
          }
          @if (waiting()) {
            <div class="body paused-note">The loop is paused. Your answer goes to the Planner, which will then instruct the Executor.</div>
            <div class="idle">
              <span class="dot grey"></span>
              <span class="who grey">Executor</span>
              <span class="what">idle — waiting for the Planner's next instruction</span>
              <span class="typing right"><i></i><i></i><i></i></span>
            </div>
          } @else if (out.status !== 'done') {
            <div class="why">{{ out.reasoning_summary }}</div>
          }
        }
      }
    }
    @if (card().answerCheck; as check) {
      <app-answer-check [check]="check" kind="planner" />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-tl-card);
        overflow: hidden;
      }
      :host(.pending) {
        border-color: var(--waiting);
      }
      :host(.waiting) {
        border-color: var(--waiting);
        box-shadow: 0 0 0 3px var(--waiting-bg);
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
      .dot.grey {
        background: var(--text-muted);
      }
      .who {
        font-weight: 600;
        color: var(--planner);
        font-size: 12.5px;
      }
      .who.grey {
        color: var(--text-muted);
      }
      .what {
        font-size: 11px;
        color: var(--text-3);
      }
      .meta {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .body {
        padding: 12px 14px;
        line-height: 1.55;
        color: var(--text-2);
      }
      .body.question {
        padding: 14px 14px 4px;
        font-size: 13.5px;
        line-height: 1.6;
        color: var(--text);
      }
      .paused-note {
        padding-top: 8px;
        font-size: 12px;
        color: var(--text-3);
      }
      .muted {
        color: var(--text-3);
      }
      .warn {
        color: var(--executor);
      }
      .unsent {
        padding: 0 14px 10px;
        font-size: 11.5px;
        color: var(--executor);
      }
      .why {
        padding: 0 14px 12px;
        font-size: 11.5px;
        color: var(--text-muted);
      }
      .idle {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 14px;
        background: var(--bg-button);
        border-top: 1px solid var(--border);
        color: var(--text-muted);
      }
      .right {
        margin-left: auto;
      }
    `,
  ],
})
export class PlannerCard {
  private readonly store = inject(TasksStore);

  readonly card = input.required<PlannerCardData>();
  /** This card holds the question the task is waiting on. */
  readonly waiting = input(false);
  /** This card's instruction or plan is the one waiting for approval (shown on the approval card). */
  readonly pending = input<'instruction' | 'plan' | null>(null);

  protected readonly purposeText = computed(() => PURPOSE[this.card().purpose] ?? this.card().purpose);

  protected readonly what = computed(() => {
    const c = this.card();
    if (c.state !== 'ok' || !c.output) return this.purposeText();
    switch (c.output.status) {
      case 'needs_user':
        return 'escalated a question';
      case 'blocked':
        return 'is blocked';
      case 'plan_ready':
        return 'proposed a plan';
      case 'done':
        return 'declared the task done';
      case 'continue':
        return 'instruction';
    }
  });

  protected readonly meta = computed(() => turnMeta(this.card(), this.store.now(), this.store.account()?.cliVersion ?? null));
}
