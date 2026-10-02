/**
 * An agent turn's tool calls, commands and files touched (design: the expanded Executor section).
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { TurnActivity } from '../../../../shared/turn-activity';

@Component({
  selector: 'app-activity-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (activity(); as a) {
      @if (a.error) {
        <div class="notice bad">{{ a.error }}</div>
      }
      @if (a.dropped > 0) {
        <div class="muted">… {{ a.dropped }} earlier line(s) not shown — the full stream is in the raw file.</div>
      }
      @for (row of rows(); track row.id) {
        @switch (row.kind) {
          @case ('tool') {
            <div class="row" [class.sub]="row.subagent">
              <span class="tool">{{ row.tool }}</span>
              <span class="summary" [class.cmd]="row.tool === 'Bash' || row.tool === 'PowerShell'">{{ row.summary }}</span>
              @if (row.pending && live()) {
                <span class="typing" aria-label="running"><i></i><i></i><i></i></span>
              }
              @if (row.subagent) {
                <span class="muted">(subagent)</span>
              }
            </div>
            @if (row.output) {
              <div class="output" [class.bad]="row.isError">{{ row.output }}</div>
            }
          }
          @case ('text') {
            <div class="text" [class.sub]="row.subagent">“{{ row.summary }}”</div>
          }
          @case ('stderr') {
            <div class="output">stderr: {{ row.summary }}</div>
          }
          @case ('notice') {
            <div class="notice" [class.bad]="row.isError">{{ row.summary }}</div>
          }
        }
      } @empty {
        @if (!a.error) {
          <div class="muted">{{ live() ? 'Waiting for the first tool call…' : 'No tool calls in this turn.' }}</div>
        }
      }
      @if (a.filesTouched.length > 0) {
        <div class="files">
          @for (file of a.filesTouched; track file) {
            <span class="file" [title]="file">{{ file }}</span>
          }
        </div>
      }
    } @else {
      <div class="muted">Loading…</div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 10px 14px;
        background: var(--bg-input);
        border-top: 1px solid var(--border);
        font: 12px/1.7 var(--font-mono);
        color: var(--text-3);
        max-height: 460px;
        overflow: auto;
      }
      /* In a height-capped flex column the rows would shrink instead of scrolling. */
      :host > * {
        flex: none;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: baseline;
        min-width: 0;
      }
      .tool {
        color: var(--text-muted);
        flex: none;
      }
      .summary {
        overflow-wrap: anywhere;
        min-width: 0;
      }
      .summary.cmd {
        color: var(--text);
      }
      .sub {
        padding-left: 16px;
        opacity: 0.8;
      }
      .output {
        padding-left: 44px;
        color: var(--text-muted);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 11.9em;
        overflow: hidden;
      }
      .output.bad,
      .notice.bad {
        color: var(--danger);
      }
      .text {
        color: var(--text-muted);
        font-family: var(--font-sans);
        font-style: italic;
        white-space: pre-wrap;
      }
      .notice {
        color: var(--executor);
      }
      .muted {
        color: var(--text-muted);
      }
      .files {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        flex-wrap: wrap;
        font-size: 11px;
      }
      .file {
        padding: 2px 7px;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text-2);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class ActivityList {
  readonly activity = input<TurnActivity | null>(null);
  /** The turn is still running (pending calls show a typing indicator). */
  readonly live = input(false);
  /** Show only the last N rows (the collapsed live tail). */
  readonly tail = input<number | null>(null);

  protected readonly rows = computed(() => {
    const rows = this.activity()?.rows ?? [];
    const tail = this.tail();
    return tail === null ? rows : rows.slice(-tail);
  });
}
