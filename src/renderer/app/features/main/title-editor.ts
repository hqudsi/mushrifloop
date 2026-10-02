/**
 * Renaming a task in place (SPEC.md §10): Enter saves, Escape cancels, and clicking away cancels too — a name
 * only changes when the user says so. Used by the task list and the task header.
 *
 * Key and mouse events stop here, so the list's own handlers (selecting on click, renaming on double-click)
 * never see keystrokes typed into the name.
 */

import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';

@Component({
  selector: 'app-title-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      #field
      class="title-edit"
      type="text"
      maxlength="200"
      aria-label="Task name — Enter saves, Escape cancels"
      title="Enter saves · Escape cancels · empty = show the description again"
      [value]="value()"
      (keydown)="onKey($event)"
      (blur)="onBlur()"
      (click)="$event.stopPropagation()"
      (dblclick)="$event.stopPropagation()"
      (mousedown)="$event.stopPropagation()"
    />
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        flex: 1;
      }
      .title-edit {
        width: 100%;
        font: inherit;
        font-weight: 500;
        color: var(--text);
        background: var(--bg-input);
        border: 1px solid var(--planner);
        border-radius: 4px;
        padding: 1px 6px;
        outline: none;
      }
    `,
  ],
})
export class TitleEditor implements AfterViewInit {
  readonly value = input.required<string>();
  readonly saved = output<string>();
  readonly cancelled = output<void>();

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** Enter or Escape already decided; the blur that follows removing the input must not cancel again. */
  private done = false;

  ngAfterViewInit(): void {
    const el = this.field().nativeElement;
    el.focus();
    el.select();
  }

  protected onKey(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.done = true;
      this.saved.emit(this.field().nativeElement.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.done = true;
      this.cancelled.emit();
    }
  }

  protected onBlur(): void {
    if (this.done) return;
    this.done = true;
    this.cancelled.emit();
  }
}
