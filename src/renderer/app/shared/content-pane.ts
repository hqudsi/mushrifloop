/**
 * The app's scrolling content shell — shared by every screen with a main column
 * (the settings sections now, the main-screen timeline in Phase 4).
 *
 * The host is the scroll container and fills the whole pane, so the scrollbar sits at the
 * window's right edge. Inside it, a centred column (max-width 760px, 32px side gutters) that
 * shrinks with the window. The column is a size container, so screens can adapt their inner
 * layout with `@container content (…)` queries instead of window media queries.
 *
 * Anything that must stay pinned (a save bar, the bottom control bar) belongs outside this
 * component, next to it; use the global `.content-column` class to align it with the column.
 */

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-content-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'content-pane' },
  template: `
    <div class="content-column content-pane-column">
      <ng-content />
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: 1;
        min-height: 0;
        min-width: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }

      .content-pane-column {
        display: flex;
        flex-direction: column;
        gap: var(--content-gap);
        padding-top: 28px;
        padding-bottom: 40px;
        container-name: content;
        container-type: inline-size;
      }
    `,
  ],
})
export class ContentPane {}
