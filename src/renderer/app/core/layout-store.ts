/**
 * Widths of the two side panels (SPEC.md §10, resizable panels): what the user chose, remembered on this
 * computer in browser storage, and what is drawn in the current window (src/shared/panel-widths.ts).
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { storageKey } from '../../../shared/app-config';
import { PANEL_LIMITS, clampWidth, dragWidth, fitPanels, type PanelSide } from '../../../shared/panel-widths';
import { PanelStore } from './panel-store';

const KEYS: Record<PanelSide, string> = { left: storageKey('leftPanelWidth'), right: storageKey('rightPanelWidth') };

function readWidth(side: PanelSide): number {
  try {
    const raw = localStorage.getItem(KEYS[side]);
    return clampWidth(side, raw === null ? null : Number(raw));
  } catch {
    return PANEL_LIMITS[side].initial;
  }
}

@Injectable({ providedIn: 'root' })
export class LayoutStore {
  private readonly panel = inject(PanelStore);

  /** The widths the user chose. */
  readonly chosen = { left: signal(readWidth('left')), right: signal(readWidth('right')) };
  readonly windowWidth = signal(window.innerWidth);

  /** What is drawn: the chosen widths, fitted to the window so the centre keeps its minimum. */
  readonly drawn = computed(() => fitPanels(this.windowWidth(), this.chosen.left(), this.panel.open() ? this.chosen.right() : null));
  readonly left = computed(() => this.drawn().left);
  readonly right = computed(() => this.drawn().right ?? this.chosen.right());

  constructor() {
    window.addEventListener('resize', () => this.windowWidth.set(window.innerWidth));
  }

  /** While dragging or stepping: inside the limits and the room the window leaves. Not saved until `save`. */
  set(side: PanelSide, wanted: number): void {
    const other = side === 'left' ? (this.panel.open() ? this.right() : 0) : this.left();
    this.chosen[side].set(dragWidth(side, wanted, this.windowWidth(), other));
  }

  save(side: PanelSide): void {
    try {
      localStorage.setItem(KEYS[side], String(this.chosen[side]()));
    } catch {
      /* storage unavailable: the width holds until the app restarts */
    }
  }

  /** Double-click on the handle: back to the default width. */
  reset(side: PanelSide): void {
    this.chosen[side].set(PANEL_LIMITS[side].initial);
    try {
      localStorage.removeItem(KEYS[side]);
    } catch {
      /* nothing to forget */
    }
  }
}
