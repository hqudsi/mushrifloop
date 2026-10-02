/**
 * How task statuses look (design/: "Waiting for you", "Running", "Done", "Failed", "Error").
 * Statuses the design predates reuse its colours: anything needing the user gets the waiting style.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { TaskStatus, WaitingState } from '../../../shared/task-model';

export interface StatusLook {
  label: string;
  tone: 'waiting' | 'running' | 'done' | 'failed' | 'error' | 'warn' | 'neutral';
  /** Needs the user: pulse dot and top of the list. */
  attention: boolean;
}

export function statusLook(status: TaskStatus, waiting: WaitingState['kind'] | null): StatusLook {
  switch (status) {
    case 'waiting_user':
      if (waiting === 'paused') return { label: 'Paused', tone: 'waiting', attention: true };
      if (waiting === 'instruction_approval' || waiting === 'plan_approval') return { label: 'Needs approval', tone: 'waiting', attention: true };
      if (waiting === 'possible_loop') return { label: 'Possible loop', tone: 'waiting', attention: true };
      return { label: 'Waiting for you', tone: 'waiting', attention: true };
    case 'account_mismatch':
      return { label: 'Account changed', tone: 'waiting', attention: true };
    case 'running':
      return { label: 'Running', tone: 'running', attention: false };
    case 'done':
      return { label: 'Done', tone: 'done', attention: false };
    case 'failed':
      return { label: 'Failed', tone: 'failed', attention: false };
    case 'error':
      return { label: 'Error', tone: 'error', attention: false };
    case 'rate_limited':
      return { label: 'Usage limit', tone: 'warn', attention: false };
    case 'stopped':
      return { label: 'Stopped', tone: 'neutral', attention: false };
    case 'draft':
      return { label: 'Not started', tone: 'neutral', attention: false };
  }
}

@Component({
  selector: 'app-status-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="pill" [class]="'pill ' + look().tone">{{ look().label }}</span>`,
})
export class StatusPill {
  readonly status = input.required<TaskStatus>();
  readonly waiting = input<WaitingState['kind'] | null>(null);
  protected readonly look = computed(() => statusLook(this.status(), this.waiting()));
}
