/**
 * The account indicator (SPEC.md §10): `account: <email> · <plan>`, read live from
 * `claude auth status`, never cached. When the account has just changed and the CLI's own answer is
 * not yet consistent, the plan is shown as unknown instead of as a number — a wrong plan here is
 * worse than none, because this is what gets read before starting a task (decided 2026-09-20).
 *
 * It sits at the foot of the left sidebar on every screen — which account is live is exactly what
 * you need to know before starting a task, so Settings shows it too (decided 2026-09-19).
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { TasksStore } from '../core/tasks-store';

@Component({
  selector: 'app-account-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'account-block', '[title]': 'accountTitle()' },
  template: `
    <div class="line">
      <span class="clip">{{ cliLine() }}</span>
      <span class="state" [class.ok]="accountOk()" [class.bad]="!accountOk()">●</span>
    </div>
    <div class="line account clip">{{ accountLine() }}</div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 10px 14px;
        border-top: 1px solid var(--border);
        font-size: 11px;
        color: var(--text-muted);
      }
      .line {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .clip {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .account {
        color: var(--text-3);
      }
      .state.ok {
        color: var(--success);
      }
      .state.bad {
        color: var(--danger);
      }
    `,
  ],
})
export class AccountBlock {
  private readonly store = inject(TasksStore);

  protected readonly accountOk = computed(() => {
    const a = this.store.account();
    return !!a && a.error === null && a.reading?.ok === true && a.reading.loggedIn;
  });

  protected readonly cliLine = computed(() => {
    const a = this.store.account();
    if (!a) return 'Claude Code · checking…';
    if (a.error) return `Claude Code · ${a.error}`;
    return `Claude Code ${a.cliVersion ?? '?'} · ${this.accountOk() ? 'connected' : 'not connected'}`;
  });

  protected readonly accountLine = computed(() => {
    const a = this.store.account();
    const r = a?.reading;
    if (!r) return 'account: …';
    if (!r.ok) return `account: unknown — ${r.error}`;
    if (!r.loggedIn) return 'account: not logged in — run `claude auth login`';
    if (r.account.email === null && r.account.apiKeySource) return `account: API key (${r.account.apiKeySource})`;
    const plan = a?.planUncertain ? 'plan: unknown — the CLI is mid-switch' : (r.account.subscriptionType ?? '?');
    return `account: ${r.account.email ?? '(no email)'} · ${plan}`;
  });

  protected readonly accountTitle = computed(() => {
    const a = this.store.account();
    if (!a) return '';
    const org = a.reading?.ok ? a.reading.account.orgName : null;
    const midSwitch = a.planUncertain
      ? 'The account just changed and Claude Code is still reporting the old plan with the new account, so the plan is not shown. It settles on its own — this line re-checks every minute.'
      : null;
    return [a.cliPath, org ? `org: ${org}` : null, `checked ${new Date(a.checkedAt).toLocaleTimeString()}`, midSwitch].filter(Boolean).join('\n');
  });
}
