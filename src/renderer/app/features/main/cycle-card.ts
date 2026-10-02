/**
 * One cycle (design: "CYCLE n" group): the Planner instruction, the Executor turn — collapsed by
 * default, expandable to its tool calls, commands and files — and the Executor's report.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';

import { formatClock, formatDuration } from '../../../../shared/format';
import type { TimelineItem } from '../../../../shared/timeline';
import { TasksStore } from '../../core/tasks-store';
import { RichText } from '../../shared/rich-text';
import { ActivityList } from './activity-list';
import { AnswerCheckLine, TurnError, TurnFacts, turnMeta } from './turn-parts';

type CycleItem = Extract<TimelineItem, { kind: 'cycle' }>;

@Component({
  selector: 'app-cycle-card',
  standalone: true,
  imports: [ActivityList, AnswerCheckLine, RichText, TurnError, TurnFacts],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rule">
      <span class="label">CYCLE {{ item().cycle }}</span>
      <span>{{ clock(item().at) }}</span>
      <span class="line"></span>
      <span [class.live]="running()">{{ duration() }}</span>
    </div>

    <div class="tl-card">
      @if (item().planner; as planner) {
        <div class="head planner">
          <span class="dot"></span>
          <span class="who">Planner</span>
          <span class="what">instruction</span>
          <span class="meta mono">{{ meta(planner) }}</span>
        </div>
        <div class="body">
          @if (item().approval; as approval) {
            @if (approval.edited && approval.text !== null) {
              <app-rich-text [text]="approval.text" />
              <div class="approved">✎ Edited and approved by you — this is what the Executor received.</div>
              <details class="original">
                <summary>The Planner's original</summary>
                <app-rich-text [text]="planner.output?.next_instruction ?? ''" />
              </details>
            } @else {
              <app-rich-text [text]="planner.output?.next_instruction ?? ''" />
              <div class="approved">✓ Approved by you</div>
            }
          } @else {
            <app-rich-text [text]="planner.output?.next_instruction ?? ''" />
          }
          @if (planner.output?.use_skills; as skills) {
            @if (skills.length > 0) {
              <div class="skills">
                skills first:
                @for (s of skills; track s) {
                  <code class="inline">{{ s }}</code>
                }
              </div>
            }
          }
          @if (planner.output?.reasoning_summary; as why) {
            <div class="why">{{ why }}</div>
          }
        </div>
      }

      @if (executor().summary?.userMessage ?? userMessage(); as message) {
        <div class="user-line"><span class="you">You → Executor</span> {{ message }}</div>
      }

      @for (attempt of item().attempts; track attempt.turnId) {
        <div class="attempt">
          Earlier attempt at {{ clock(attempt.startedAt) }}:
          {{ attempt.state === 'interrupted' ? 'interrupted' : (attempt.error?.message ?? attempt.state) }}
        </div>
      }

      <button type="button" class="head executor" (click)="toggle()" [attr.aria-expanded]="open()">
        <span class="chev">{{ open() ? '▾' : '▸' }}</span>
        <span class="dot"></span>
        <span class="who">Executor</span>
        <span class="what">{{ headline() }}</span>
        @if (running()) {
          <span class="typing"><i></i><i></i><i></i></span>
        }
        <span class="meta mono">{{ meta(executor()) }}</span>
      </button>

      @if (open()) {
        <app-activity-list [activity]="activity()" [live]="running()" />
      } @else if (running()) {
        <app-activity-list [activity]="activity()" [live]="true" [tail]="4" />
      }

      @if (executor().state === 'failed' && executor().error; as error) {
        <app-turn-error [error]="error" />
      }
      @if (executor().state === 'interrupted') {
        <div class="interrupted">The app stopped during this turn. Resume retries it.</div>
      }

      @if (executor().output; as out) {
        <div class="grid">
          <div>
            <div class="caps">WHAT CHANGED</div>
            <div class="value"><app-rich-text [text]="out.summary" /></div>
            @if (out.question) {
              <div class="value question">Asks: {{ out.question }}</div>
            }
          </div>
          <div>
            <div class="caps">TESTS</div>
            @if (out.tests.ran) {
              <div class="pills">
                <span class="pill done">{{ out.tests.passed ?? '?' }} passed</span>
                @if (out.tests.failed) {
                  <span class="pill failed">{{ out.tests.failed }} failed</span>
                } @else {
                  <span class="muted">0 failed</span>
                }
              </div>
            } @else {
              <div class="muted">Not run</div>
            }
            @if (out.tests.notes) {
              <div class="muted small">{{ out.tests.notes }}</div>
            }
          </div>
          <div>
            <div class="caps">PROBLEMS</div>
            @for (p of out.problems; track $index) {
              <div class="value">{{ p }}</div>
            } @empty {
              <div class="muted">None</div>
            }
          </div>
        </div>
        @if (out.evidence) {
          <details class="evidence" open>
            <summary>EVIDENCE · {{ lineCount(out.evidence) }}</summary>
            <pre>{{ out.evidence }}</pre>
          </details>
        }
        @if (out.status !== 'ok') {
          <div class="status-line" [class.bad]="out.status === 'failed'">
            Executor reported <strong>{{ out.status }}</strong>
          </div>
        }
      }
      @if (executor().answerCheck; as check) {
        <app-answer-check [check]="check" />
      }

      <app-turn-facts [card]="executor()" [preReviewCommit]="item().preReviewCommit" />
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .rule {
        display: flex;
        align-items: center;
        gap: 10px;
        font: 11px var(--font-mono);
        color: var(--text-muted);
      }
      .rule .label {
        font-weight: 500;
        color: var(--text-3);
      }
      .rule .line {
        flex: 1;
        height: 1px;
        background: var(--border);
      }
      .rule .live {
        color: var(--running);
      }
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
        width: 100%;
        border: 0;
        font: inherit;
        color: inherit;
        text-align: left;
      }
      .head.planner {
        background: var(--planner-bg);
        border-bottom: 1px solid var(--border);
      }
      .head.executor {
        background: var(--executor-bg);
        border-top: 1px solid var(--border);
        cursor: pointer;
      }
      .head:first-child {
        border-top: 0;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: none;
      }
      .planner .dot {
        background: var(--planner);
      }
      .executor .dot {
        background: var(--executor);
      }
      .who {
        font-weight: 600;
        font-size: 12.5px;
      }
      .planner .who {
        color: var(--planner);
      }
      .executor .who {
        color: var(--executor);
      }
      .what {
        font-size: 11px;
        color: var(--text-3);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chev {
        color: var(--text-3);
        font-size: 10px;
        width: 8px;
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
      .skills,
      .why {
        margin-top: 8px;
        font-size: 11.5px;
        color: var(--text-muted);
      }
      .skills code {
        margin-left: 4px;
      }
      .approved {
        margin-top: 8px;
        font-size: 11.5px;
        color: var(--waiting);
      }
      .original {
        margin-top: 6px;
        font-size: 12px;
        color: var(--text-3);
      }
      .original summary {
        cursor: pointer;
        color: var(--text-muted);
      }
      .user-line,
      .attempt,
      .interrupted,
      .status-line {
        padding: 7px 14px;
        border-top: 1px solid var(--border);
        font-size: 12px;
        color: var(--text-3);
      }
      .you {
        font-weight: 600;
        color: var(--text-2);
      }
      .attempt,
      .interrupted {
        color: var(--executor);
      }
      .status-line.bad {
        color: var(--danger);
      }
      .grid {
        display: grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        gap: 16px;
        padding: 12px 14px;
        border-top: 1px solid var(--border);
        font-size: 12px;
        line-height: 1.5;
      }
      @container content (max-width: 560px) {
        .grid {
          grid-template-columns: 1fr;
          gap: 10px;
        }
      }
      .caps {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 4px;
      }
      .value {
        color: var(--text-2);
        overflow-wrap: anywhere;
      }
      .question {
        margin-top: 6px;
        color: var(--waiting);
      }
      .evidence {
        padding: 8px 14px 10px;
        border-top: 1px solid var(--border);
      }
      .evidence summary {
        cursor: pointer;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-muted);
      }
      .evidence pre {
        margin: 6px 0 0;
        max-height: 320px;
        overflow: auto;
        font: 11.5px/1.5 var(--font-mono);
        color: var(--text-2);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .pills {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }
      .muted {
        color: var(--text-3);
      }
      .small {
        margin-top: 4px;
        font-size: 11px;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class CycleCard implements OnInit {
  private readonly store = inject(TasksStore);

  readonly item = input.required<CycleItem>();
  readonly taskId = input.required<string>();

  private readonly expanded = signal(false);
  protected readonly open = this.expanded.asReadonly();
  protected readonly executor = computed(() => this.item().executor);
  protected readonly running = computed(() => this.executor().state === 'running');

  protected readonly activity = computed(() => {
    const turnId = this.executor().turnId;
    const live = this.store.live();
    if (live && live.turnId === turnId) return live.activity;
    return this.store.activities().get(turnId) ?? null;
  });

  protected lineCount(text: string): string {
    const n = text.replace(/\s+$/, '').split('\n').length;
    return `${n} line${n === 1 ? '' : 's'}`;
  }

  protected readonly headline = computed(() => {
    const e = this.executor();
    const a = this.activity();
    const parts = ['turn'];
    // A partly or wholly unreadable turn has no trustworthy count.
    if (a && a.error === null) parts.push(`${a.toolCalls} tool call${a.toolCalls === 1 ? '' : 's'}`);
    const changed = e.output?.changed_files.length ?? e.summary?.changedFiles.length;
    if (changed !== undefined) parts.push(`${changed} file${changed === 1 ? '' : 's'} changed`);
    if (e.state === 'running') parts.push('running');
    if (e.state === 'failed') parts.push('failed');
    if (e.answerCheck?.possiblyTruncated) parts.push('possibly truncated');
    else if (e.answerCheck) parts.push(`answer rejected ${e.answerCheck.count}×`);
    return parts.join(' · ');
  });

  protected readonly userMessage = computed(() => {
    const e = this.executor();
    if (e.purpose !== 'user_message' && !e.prompt.includes('[FROM USER]')) return null;
    const match = /\[FROM USER\]\n([\s\S]*?)(?:\n\n\[INSTRUCTION\]|$)/.exec(e.prompt);
    return match?.[1]?.trim() ?? null;
  });

  protected readonly duration = computed(() => {
    const item = this.item();
    const e = item.executor;
    if (e.state === 'running') return formatDuration(this.store.now() - Date.parse(item.at));
    const end = Date.parse(e.startedAt) + (e.durationMs ?? 0);
    return formatDuration(end - Date.parse(item.at));
  });

  ngOnInit(): void {
    // Tool-call counts for the collapsed header come from the turn's activity.
    if (this.executor().state !== 'running') void this.store.loadActivity(this.taskId(), this.executor().turnId);
  }

  protected toggle(): void {
    this.expanded.update((v) => !v);
    if (this.expanded()) void this.store.loadActivity(this.taskId(), this.executor().turnId);
  }

  protected meta(card: Parameters<typeof turnMeta>[0]): string {
    return turnMeta(card, this.store.now(), this.store.account()?.cliVersion ?? null);
  }

  protected clock(iso: string): string {
    return formatClock(iso);
  }
}
