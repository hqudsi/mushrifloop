/**
 * The handle on a side panel's inner edge (SPEC.md §10, resizable panels): a thin strip that shows a ↔ cursor
 * and a blue line on hover, and resizes the panel when dragged. Double-click restores the default width. It
 * can be reached with Tab; the arrow keys step 16 px (48 px with Shift), Home and End go to the limits.
 *
 * It takes no room in the layout: a zero-width box whose hit area overlaps the border.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { PANEL_LIMITS, type PanelSide } from '../../../shared/panel-widths';
import { LayoutStore } from '../core/layout-store';

@Component({
  selector: 'app-resize-handle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="hit"
      [class.dragging]="dragging()"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      [attr.aria-label]="label()"
      [attr.aria-valuenow]="width()"
      [attr.aria-valuemin]="limits().min"
      [attr.aria-valuemax]="limits().max"
      [title]="label() + ' — drag to resize, double-click for the default width'"
      (pointerdown)="down($event)"
      (pointermove)="move($event)"
      (pointerup)="up($event)"
      (pointercancel)="up($event)"
      (dblclick)="layout.reset(side())"
      (keydown)="key($event)"
    ></div>
  `,
  styles: [
    `
      :host {
        position: relative;
        width: 0;
        flex: none;
        z-index: 5;
      }
      .hit {
        position: absolute;
        top: 0;
        bottom: 0;
        left: -3px;
        width: 6px;
        cursor: col-resize;
        touch-action: none;
        outline: none;
      }
      .hit::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 2px;
        width: 2px;
        background: transparent;
        transition: background 0.12s;
      }
      .hit:hover::after,
      .hit:focus-visible::after,
      .hit.dragging::after {
        background: var(--planner);
      }
    `,
  ],
})
export class ResizeHandle {
  readonly side = input.required<PanelSide>();
  protected readonly layout = inject(LayoutStore);
  protected readonly dragging = signal(false);
  protected readonly limits = computed(() => PANEL_LIMITS[this.side()]);
  protected readonly width = computed(() => (this.side() === 'left' ? this.layout.left() : this.layout.right()));
  protected readonly label = computed(() => (this.side() === 'left' ? 'Task list width' : 'Side panel width'));

  private startX = 0;
  private startWidth = 0;

  protected down(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.startX = event.clientX;
    this.startWidth = this.width();
    this.dragging.set(true);
    document.body.classList.add('resizing-panel');
  }

  protected move(event: PointerEvent): void {
    if (!this.dragging()) return;
    const dx = event.clientX - this.startX;
    // The list grows to the right; the side panel grows to the left.
    this.layout.set(this.side(), this.startWidth + (this.side() === 'left' ? dx : -dx));
  }

  protected up(event: PointerEvent): void {
    if (!this.dragging()) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.dragging.set(false);
    document.body.classList.remove('resizing-panel');
    this.layout.save(this.side());
  }

  protected key(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    const grow = this.side() === 'left' ? 1 : -1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = this.width() + step * grow;
    else if (event.key === 'ArrowLeft') next = this.width() - step * grow;
    else if (event.key === 'Home') next = this.limits().min;
    else if (event.key === 'End') next = this.limits().max;
    if (next === null) return;
    event.preventDefault();
    this.layout.set(this.side(), next);
    this.layout.save(this.side());
  }
}
