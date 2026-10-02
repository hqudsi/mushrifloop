/**
 * Pieces shared by the timeline cards: turn headers, error boxes, and the facts row of a cycle.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { formatDuration, formatTokens } from '../../../../shared/format';
import { modelDisplay, modelName } from '../../../../shared/models';
import type { AnswerCheck, CommitInfo, SkillOutcome, TurnErrorRecord } from '../../../../shared/task-model';
import type { ExecutorCard, TurnCardBase } from '../../../../shared/timeline';

/**
 * The model a turn ran on, as a version (SPEC.md §8): what actually served it once it has run, otherwise
 * what was requested, resolved on the installed CLI.
 */
export function turnModelText(card: TurnCardBase, cliVersion: string | null): string {
  const name = card.servedModel !== null ? modelName(card.servedModel) : modelDisplay(card.model, cliVersion).name;
  return card.effort ? `${name} ${card.effort}` : name;
}

/** "1.8s · 2.1k tok · Opus 5.5 medium", or the running time. */
export function turnMeta(card: TurnCardBase, now: number, cliVersion: string | null = null): string {
  const model = turnModelText(card, cliVersion);
  if (card.state === 'running') return `${formatDuration(now - Date.parse(card.startedAt))} · running · ${model}`;
  const parts = [formatDuration(card.durationMs)];
  if (card.contextTokens !== null) parts.push(`${formatTokens(card.contextTokens)} tok`);
  parts.push(model);
  return parts.join(' · ');
}

@Component({
  selector: 'app-turn-error',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="kind">{{ label() }}</span>
      <span class="msg">{{ error().message }}</span>
    </div>
    @if (error().rawText) {
      <details>
        <summary>Raw output</summary>
        <pre>{{ error().rawText }}</pre>
      </details>
    }
    @if (error().validationIssues?.length) {
      <ul>
        @for (issue of error().validationIssues; track $index) {
          <li><code class="inline">{{ issue.path || '/' }}</code> {{ issue.message }}</li>
        }
      </ul>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 10px 14px;
        border-top: 1px solid var(--border);
        background: var(--danger-bg);
        color: var(--danger);
        font-size: 12px;
        line-height: 1.5;
      }
      .head {
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      .kind {
        font: 600 11px var(--font-mono);
        flex: none;
      }
      .msg {
        overflow-wrap: anywhere;
      }
      details {
        margin-top: 6px;
      }
      summary {
        cursor: pointer;
        font-size: 11px;
      }
      pre {
        margin-top: 4px;
        max-height: 240px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 11px/1.5 var(--font-mono);
        color: var(--text-2);
        background: var(--bg-input);
        padding: 8px;
        border-radius: 4px;
      }
      ul {
        margin: 6px 0 0 18px;
      }
    `,
  ],
})
export class TurnError {
  readonly error = input.required<TurnErrorRecord>();
  readonly interrupted = input(false);
  protected readonly label = computed(() => {
    const kind = this.error().kind;
    const labels: Partial<Record<string, string>> = {
      timeout: 'TIMEOUT',
      aborted: 'STOPPED',
      rate_limited: 'USAGE LIMIT',
      schema_invalid: 'INVALID ANSWER',
      api_error: 'API ERROR',
      spawn_failed: 'NOT STARTED',
      cli_version: 'CLI TOO OLD',
      no_result: 'NO RESULT',
      max_turns: 'MAX TURNS',
      structured_output_failed: 'NO STRUCTURED ANSWER',
      process_failed: 'FAILED',
    };
    return labels[kind] ?? kind.toUpperCase();
  });
}

/**
 * SPEC.md §5 net 11: the CLI refused structured answers in this turn, or the accepted answer has leaked
 * tool-call markup (§3.5). Shown with the CLI's reason, and — when the accepted answer is possibly truncated
 * or was refused (§4) — what that means for this kind of turn.
 */
@Component({
  selector: 'app-answer-check',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.truncated]': 'check().possiblyTruncated || check().leakedMarkup === true' },
  template: `
    <div class="head">
      <span class="kind">{{ label() }}</span>
      <span class="msg">
        @if (check().count > 0) {
          Answer rejected {{ check().count }}× by the CLI's schema check before one was accepted.
        }
        @if (check().leakedMarkup) {
          {{ markupNote() }}
        }
        @if (check().possiblyTruncated) {
          {{ consequence() }}
        }
      </span>
    </div>
    @for (reason of check().reasons; track $index) {
      <div class="reason">{{ reason }}</div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: 8px 14px;
        border-top: 1px solid var(--border);
        background: var(--executor-bg);
        color: var(--executor);
        font-size: 12px;
        line-height: 1.5;
      }
      :host(.truncated) {
        background: var(--danger-bg);
        color: var(--danger);
      }
      .head {
        display: flex;
        gap: 8px;
        align-items: baseline;
      }
      .kind {
        font: 600 11px var(--font-mono);
        flex: none;
      }
      .msg {
        overflow-wrap: anywhere;
      }
      .reason {
        margin-top: 4px;
        font: 11px/1.5 var(--font-mono);
        color: var(--text-2);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class AnswerCheckLine {
  readonly check = input.required<AnswerCheck>();
  /** What kind of answer it was: an Executor report, a handoff summary or a Planner decision. */
  readonly kind = input<'report' | 'handoff' | 'planner'>('report');

  protected readonly label = computed(() => {
    const c = this.check();
    if (c.possiblyTruncated) return 'POSSIBLY TRUNCATED';
    return c.leakedMarkup ? 'MALFORMED ANSWER' : 'ANSWER REJECTED';
  });

  protected readonly markupNote = computed(() =>
    this.kind() === 'planner'
      ? 'The accepted answer has tool-call markup (<parameter …>) inside a text field, so the orchestrator did not act on it and asked the Planner to answer again.'
      : 'The accepted answer has tool-call markup (<parameter …>) inside a text field, so some fields were typed into another one.',
  );

  protected readonly consequence = computed(() => {
    const shares = this.check().acceptedChars !== null && this.check().largestAttemptChars > 0
      ? ` (${this.check().acceptedChars} characters accepted; the largest refused attempt had ${this.check().largestAttemptChars})`
      : '';
    return this.kind() === 'handoff'
      ? `The accepted summary is likely incomplete${shares}; the new session was told so.`
      : `The accepted report is likely incomplete${shares}. This cycle is not a clean ok: the Planner was told to ask for the findings again.`;
  });
}

interface Fact {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'info';
  title?: string;
}

function skillFact(o: SkillOutcome): Fact {
  const name = `skill ${o.skill}`;
  switch (o.state) {
    case 'ok':
      return { text: `${name} · ran`, tone: 'ok' };
    case 'failed':
      return { text: `${name} · failed`, tone: 'bad' };
    case 'no_result':
      return { text: `${name} · no result`, tone: 'warn' };
    case 'not_invoked':
      return { text: `${name} · not invoked`, tone: 'warn' };
    case 'skipped_no_remote':
      return { text: `${name} · skipped — no git remote`, tone: 'warn' };
  }
}

function commitFact(c: CommitInfo, prefix = 'commit'): Fact | null {
  switch (c.state) {
    case 'committed':
      return { text: `${prefix} ${c.hash.slice(0, 7)}`, tone: 'info', title: `${c.message}\n${c.files.join('\n')}` };
    case 'nothing_to_commit':
      return { text: `no ${prefix} — nothing changed`, tone: 'info' };
    case 'failed':
      return { text: `${prefix} failed`, tone: 'bad', title: c.error };
    case 'skipped':
      return c.reason.includes('not a git repository') || c.reason.includes('auto-commit is off') ? null : { text: `no ${prefix}`, tone: 'info', title: c.reason };
  }
}

/** SPEC.md §10: skills, commit, denied tools, model mismatch, slow turn, killed processes. */
@Component({
  selector: 'app-turn-facts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.none]': 'facts().length === 0 && card().killed.length === 0' },
  template: `
    @for (fact of facts(); track $index) {
      <span class="fact" [class]="'fact ' + fact.tone" [title]="fact.title ?? ''">{{ fact.text }}</span>
    }
    @if (card().killed.length > 0) {
      <details class="killed">
        <summary>{{ card().killed.length }} process{{ card().killed.length === 1 ? '' : 'es' }} killed after the turn</summary>
        @for (p of card().killed; track p.pid) {
          <div class="proc">pid {{ p.pid }} {{ p.name }}{{ p.outsideJob ? ' (outside the job!)' : '' }} — {{ p.commandLine }}</div>
        }
      </details>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 14px 10px;
        border-top: 1px solid var(--border);
        font-size: 11px;
      }
      :host(.none) {
        display: none;
      }
      .fact {
        padding: 1px 7px;
        border-radius: 4px;
        border: 1px solid var(--border);
        color: var(--text-3);
        white-space: nowrap;
      }
      .fact.ok {
        color: var(--success);
        border-color: color-mix(in srgb, var(--success) 40%, transparent);
      }
      .fact.warn {
        color: var(--executor);
        border-color: color-mix(in srgb, var(--executor) 40%, transparent);
      }
      .fact.bad {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      }
      .killed {
        flex-basis: 100%;
        color: var(--executor);
      }
      .killed summary {
        cursor: pointer;
      }
      .proc {
        font: 11px/1.6 var(--font-mono);
        color: var(--text-3);
        overflow-wrap: anywhere;
        padding-left: 12px;
      }
    `,
  ],
})
export class TurnFacts {
  readonly card = input.required<ExecutorCard>();
  readonly preReviewCommit = input<CommitInfo | null>(null);

  readonly facts = computed<Fact[]>(() => {
    const card = this.card();
    const s = card.summary;
    const out: Fact[] = [];
    if (card.accountChanged) out.push({ text: 'account changed during this turn', tone: 'bad' });
    for (const o of s?.skillOutcomes ?? []) out.push(skillFact(o));
    const pre = this.preReviewCommit();
    if (pre) {
      const f = commitFact(pre, 'pre-review commit');
      if (f) out.push(f);
    }
    if (s) {
      const f = commitFact(s.commit);
      if (f) out.push(f);
    }
    if (card.denials.length > 0) {
      out.push({
        text: `${card.denials.length} denied tool call${card.denials.length === 1 ? '' : 's'}`,
        tone: 'warn',
        title: card.denials.map((d) => `${d.toolName} ${JSON.stringify(d.input ?? '')}`).join('\n'),
      });
    }
    if (card.modelMismatch) {
      const asked = modelDisplay(card.model, null);
      out.push({
        text: `served by ${card.servedModel === null ? '?' : modelName(card.servedModel)}, not ${asked.alias ? `"${asked.alias}"` : asked.name}`,
        tone: 'warn',
        title: `Requested ${card.model}; the CLI served ${card.servedModel ?? 'an unknown model'} (SPEC.md §8).`,
      });
    }
    for (const other of card.alsoServed) {
      out.push({
        text: `part of this turn ran on ${modelName(other)}`,
        tone: 'warn',
        title: `Claude Code switched models during the turn, as its safety-classifier fallback does (SPEC.md §8). Served: ${other}.`,
      });
    }
    if (card.slow) out.push({ text: `slow turn · ${formatDuration(card.durationMs)}`, tone: 'warn', title: `Over the ${formatDuration(card.slowTurnMs)} warning` });
    if (card.processMethod !== null && card.processMethod !== 'job' && card.state !== 'running') {
      out.push({ text: `process guard: ${card.processMethod}`, tone: 'info' });
    }
    return out;
  });
}
