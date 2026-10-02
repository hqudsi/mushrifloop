/**
 * The task's current state, at the end of the timeline, when it needs the user or explains a stop.
 * A Planner question is shown on its own card instead (SPEC.md §10: the waiting state first).
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { formatDateTime } from '../../../../shared/format';
import type { AccountRecord, AuthReading, TaskRecord } from '../../../../shared/task-model';
import { TasksStore } from '../../core/tasks-store';
import { ApprovalCard } from './approval-card';

function accountLine(a: AccountRecord): string {
  if (a.email === null && a.apiKeySource) return `API key (${a.apiKeySource})`;
  return a.email ?? '(no email)';
}

@Component({
  selector: 'app-state-panel',
  standalone: true,
  imports: [ApprovalCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = task();
    @switch (t.status) {
      @case ('draft') {
        <div class="panel neutral">
          <div class="title">Not started</div>
          <p>Start runs the task setup (git branch, skill discovery) and the Planner's first turn.</p>
          <div class="actions">
            <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="act('start')">Start task</button>
          </div>
        </div>
      }
      @case ('waiting_user') {
        @switch (t.waiting?.kind) {
          @case ('paused') {
            <div class="panel wait">
              <div class="title">Paused</div>
              <p>{{ t.statusReason }}</p>
              <div class="actions">
                <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="act('resume')">Resume</button>
                <span class="hint">or send a message below — it resumes the task.</span>
              </div>
            </div>
          }
          @case ('possible_loop') {
            <div class="panel warn">
              <div class="title">Possible loop — paused for you</div>
              <p>{{ t.statusReason }}</p>
              <div class="actions">
                <button type="button" class="btn" [disabled]="!!store.pendingAction()" (click)="act('resume')">Continue anyway</button>
                <span class="hint">or tell the Planner how to proceed below.</span>
              </div>
            </div>
          }
          @case ('skill_waiver') {
            <div class="panel wait">
              <div class="title">A required skill cannot run in this environment</div>
              @for (block of waiverSkills(); track block.skill) {
                <div class="skill">
                  <div><code class="inline">{{ block.skill }}</code> — {{ block.reason }}</div>
                  <button
                    type="button"
                    class="btn btn-accent"
                    [disabled]="!!store.pendingAction()"
                    (click)="waive(block.skill)"
                  >
                    Waive {{ block.skill }} for this task
                  </button>
                </div>
              }
              <label class="note">
                <span>Note for the log (optional)</span>
                <input class="input" [value]="waiverNote()" (input)="waiverNote.set($any($event.target).value)" placeholder="Why it is fine to skip it here" />
              </label>
              <p class="hint">
                A waiver applies to this task only and is recorded in its log. It is never given automatically.
                To keep the requirement, reply to the Planner below instead.
              </p>
            </div>
          }
          @case ('instruction_approval') {
            @if (approval(); as a) {
              <app-approval-card [waiting]="a" [reopened]="task().followUpApproval" />
            }
          }
          @case ('plan_approval') {
            @if (approval(); as a) {
              <app-approval-card [waiting]="a" />
            }
          }
        }
      }
      @case ('account_mismatch') {
        <div class="panel wait">
          <div class="title">The Claude Code account changed</div>
          <p>{{ t.statusReason }}</p>
          <div class="accounts">
            <div class="acct">
              <div class="caps">PINNED TO THIS TASK</div>
              <div class="big">{{ pinnedLine() }}</div>
              <div>{{ t.pinnedAccount.orgName ?? '—' }} · {{ t.pinnedAccount.subscriptionType ?? '—' }}</div>
            </div>
            <div class="acct live">
              <div class="caps">LIVE NOW</div>
              @if (live(); as l) {
                @if (l.ok) {
                  <div class="big">{{ l.loggedIn ? liveEmail(l) : 'not logged in' }}</div>
                  <div>{{ liveOrg(l) }}</div>
                } @else {
                  <div class="big">unknown</div>
                  <div class="err">{{ l.error }}</div>
                }
              } @else {
                <div class="big">checking…</div>
              }
            </div>
          </div>
          <p>
            <b>Next step:</b> switch Claude Code back to <b>{{ pinnedLine() }}</b> (<code class="inline">claude auth login</code>),
            then press Resume. A task never moves to another account — to use a different one, start a new task.
          </p>
          <div class="actions">
            <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="act('resume')">Resume</button>
            <button type="button" class="btn" [disabled]="store.accountLoading()" (click)="store.refreshAccount()">Check the account again</button>
          </div>
        </div>
      }
      @case ('error') {
        <div class="panel danger">
          <div class="title">Stopped with an error</div>
          <p class="pre">{{ t.statusReason }}</p>
          <p class="hint">Nothing is lost: Resume retries the step that failed, in the same sessions.</p>
          <div class="actions">
            <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="act('resume')">Resume</button>
          </div>
        </div>
      }
      @case ('rate_limited') {
        <div class="panel warn">
          <div class="title">Usage limit reached</div>
          @if (t.rateLimit; as rl) {
            <p>{{ rl.message }}</p>
            @if (rl.resetsAt) {
              <p>Resets {{ date(rl.resetsAt * 1000) }}{{ rl.rateLimitType ? ' (' + rl.rateLimitType + ')' : '' }}.</p>
            }
            @if (rl.autoResumeAt) {
              <p class="hint">Auto-resume is scheduled for {{ date(rl.autoResumeAt) }}.</p>
            }
            @if (rl.autoResumeSkipped; as skipped) {
              <p>
                Auto-resume did not start this task at {{ date(skipped.at) }}:
                <button type="button" class="link" (click)="store.openTask(skipped.blockedBy.taskId)" [title]="'Open ' + skipped.blockedBy.title">{{ skipped.blockedBy.title }}</button>
                was running, and tasks run one at a time. Resume it when you are ready.
              </p>
            }
          } @else {
            <p>{{ t.statusReason }}</p>
          }
          <div class="actions">
            <button type="button" class="btn" [disabled]="!!store.pendingAction()" (click)="act('resume')">Resume now</button>
          </div>
        </div>
      }
      @case ('stopped') {
        <div class="panel neutral">
          <div class="title">Stopped</div>
          <p class="hint">Resume continues from where the task stopped.</p>
          <div class="actions">
            <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="act('resume')">Resume</button>
          </div>
        </div>
      }
      @case ('failed') {
        <div class="panel danger">
          <div class="title">Task failed</div>
          <p>{{ t.statusReason }}</p>
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      :host:empty {
        display: none;
      }
      .panel {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-tl-card);
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        line-height: 1.5;
        color: var(--text-2);
      }
      .panel.wait {
        border-color: var(--waiting);
        box-shadow: 0 0 0 3px var(--waiting-bg);
      }
      .panel.warn {
        border-color: var(--executor);
      }
      .panel.danger {
        border-color: var(--danger);
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
      .title {
        font-weight: 600;
        font-size: 13.5px;
        color: var(--text);
      }
      .wait .title {
        color: var(--waiting);
      }
      .warn .title {
        color: var(--executor);
      }
      .danger .title {
        color: var(--danger);
      }
      .pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
      }
      .hint {
        font-size: 12px;
        color: var(--text-3);
      }
      .actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .skill {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-start;
        padding: 8px 0;
        border-top: 1px solid var(--border);
      }
      .note {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-3);
      }
      .accounts {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .acct {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 12px;
        color: var(--text-3);
        overflow-wrap: anywhere;
      }
      .acct.live {
        border-color: var(--danger);
      }
      .caps {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 2px;
      }
      .big {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }
      .err {
        color: var(--danger);
      }
    `,
  ],
})
export class StatePanel {
  protected readonly store = inject(TasksStore);
  readonly task = input.required<TaskRecord>();
  protected readonly waiverNote = signal('');

  protected readonly waiverSkills = computed(() => {
    const w = this.task().waiting;
    return w?.kind === 'skill_waiver' ? w.skills : [];
  });

  protected readonly pinnedLine = computed(() => accountLine(this.task().pinnedAccount));

  protected readonly approval = computed(() => {
    const w = this.task().waiting;
    return w?.kind === 'instruction_approval' || w?.kind === 'plan_approval' ? w : null;
  });

  /** The live account: the fresh check if we have one, else what the orchestrator saw at the mismatch. */
  protected readonly live = computed<AuthReading | null>(() => this.store.account()?.reading ?? this.task().liveAccount);

  protected liveEmail(reading: AuthReading): string {
    return reading.ok ? accountLine(reading.account) : '';
  }

  protected liveOrg(reading: AuthReading): string {
    if (!reading.ok) return '';
    // Only the live reading can be mid-switch; `task().liveAccount` is what was recorded at the time.
    const live = this.store.account();
    const plan =
      live?.planUncertain && live.reading === reading ? 'plan: unknown — the CLI is mid-switch' : (reading.account.subscriptionType ?? '—');
    return `${reading.account.orgName ?? '—'} · ${plan}`;
  }

  protected date(value: string | number): string {
    return formatDateTime(value);
  }

  protected act(kind: 'start' | 'resume'): void {
    void this.store.act({ kind });
  }

  protected waive(skill: string): void {
    const note = this.waiverNote().trim();
    void this.store.act(note ? { kind: 'waive_skill', skill, note } : { kind: 'waive_skill', skill }).then((ok) => {
      if (ok) this.waiverNote.set('');
    });
  }
}
