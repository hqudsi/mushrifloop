/**
 * "Defaults after an update" (SPEC.md §11, decided 2026-09-26). A release that changes a default never changes
 * a saved setting by itself: this dialog lists each change with the user's value, pre-selects the settings that
 * still hold the old default, and applies only what is ticked. Either button marks the file as reconciled with
 * this release; closing the dialog decides nothing.
 */

import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';

import { pendingDefaultChanges, type DefaultChangeField, type DefaultValue, type PendingDefaultChange } from '../../../../shared/settings';
import { SettingsStore } from '../../core/settings-store';

const MINUTES: readonly DefaultChangeField[] = ['turnTimeoutMinutes', 'slowTurnWarningMinutes'];
const CONTEXT_MODE: Record<string, string> = { isolated: 'Isolated', read_only: 'Read-only project' };

@Component({
  selector: 'app-defaults-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close()' },
  template: `
    <div class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dr-title">
        <div class="top">
          <span id="dr-title" class="title">Updated defaults</span>
          <button type="button" class="close" aria-label="Close" [disabled]="saving()" (click)="close()">✕</button>
        </div>

        <div class="body">
          <p class="lead">
            This version changed the defaults below. Your settings keep their values until you choose. Ticked
            settings still hold the old default, so you most likely never set them; the others you changed yourself.
            Tasks that already exist keep the settings they were created with.
          </p>

          <div class="table" role="table">
            <div class="row head" role="row">
              <span></span>
              <span role="columnheader">Setting</span>
              <span role="columnheader">Old default → new</span>
              <span role="columnheader">Yours now</span>
            </div>
            @for (c of changes(); track c.field) {
              <label class="row" role="row">
                <input type="checkbox" [checked]="isChosen(c.field)" [disabled]="saving()" (change)="toggle(c.field)" />
                <span class="name">{{ c.label }}</span>
                <span class="mono">{{ show(c, c.from) }} → <b>{{ show(c, c.to) }}</b></span>
                <span class="mono" [class.muted]="c.suggested">
                  {{ show(c, c.current) }}{{ c.suggested ? '' : ' (yours)' }}
                </span>
              </label>
            }
          </div>

          @if (error(); as err) {
            <div class="callout danger">{{ err }}</div>
          }
        </div>

        <div class="foot">
          <button type="button" class="btn" [disabled]="saving()" (click)="decide([])">Keep my settings</button>
          <button type="button" class="btn accent" [disabled]="saving() || chosen().size === 0" (click)="decide(chosenList())">
            Apply selected ({{ chosen().size }})
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 50;
        background: rgba(0, 0, 0, 0.55);
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .dialog {
        width: 640px;
        max-width: 100%;
        max-height: calc(100vh - 48px);
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border);
        flex: none;
      }
      .title {
        font-size: 14px;
        font-weight: 600;
      }
      .close {
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 13px;
      }
      .close:hover {
        color: var(--text);
      }
      .body {
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
        min-height: 0;
      }
      .lead {
        color: var(--text-2);
        line-height: 1.5;
      }
      .table {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
      }
      .row {
        display: grid;
        grid-template-columns: 24px 1.2fr 1.4fr 1fr;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        border-top: 1px solid var(--border);
        cursor: pointer;
      }
      .row.head {
        border-top: 0;
        cursor: default;
        font-size: 11.5px;
        color: var(--text-3);
        background: var(--bg);
      }
      .name {
        font-weight: 500;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: 12px;
      }
      .muted {
        color: var(--text-muted);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--border);
        background: var(--bg);
        flex: none;
      }
      .btn.accent {
        background: var(--planner);
        border-color: var(--planner);
        color: var(--on-accent);
      }
    `,
  ],
})
export class DefaultsReview implements OnInit {
  private readonly store = inject(SettingsStore);

  readonly closed = output<void>();

  /** Taken once when the dialog opens, so the list does not move under the user. */
  protected readonly changes = signal<PendingDefaultChange[]>([]);
  protected readonly chosen = signal<ReadonlySet<DefaultChangeField>>(new Set());
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const pending = pendingDefaultChanges(this.store.saved());
    this.changes.set(pending);
    this.chosen.set(new Set(pending.filter((c) => c.suggested).map((c) => c.field)));
  }

  protected isChosen(field: DefaultChangeField): boolean {
    return this.chosen().has(field);
  }

  protected chosenList(): DefaultChangeField[] {
    return [...this.chosen()];
  }

  protected toggle(field: DefaultChangeField): void {
    const next = new Set(this.chosen());
    if (next.has(field)) next.delete(field);
    else next.add(field);
    this.chosen.set(next);
  }

  protected show(change: PendingDefaultChange, value: DefaultValue): string {
    if (change.field === 'plannerContextMode') return CONTEXT_MODE[String(value)] ?? String(value);
    if (MINUTES.includes(change.field)) return `${value} min`;
    return String(value);
  }

  protected async decide(fields: DefaultChangeField[]): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    const error = await this.store.reconcileDefaults(fields);
    this.saving.set(false);
    if (error) this.error.set(error);
    else this.closed.emit();
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit();
  }
}
