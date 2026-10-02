/**
 * The app's mark: the icon from `assets/icon.svg` (title bar, toasts, Settings → About).
 *
 * The transparent SVG is the source — the same drawing the Windows icon is generated from
 * (`npm run icon`, NOTES.md §31) — so the app and its taskbar entry can never drift apart.
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-mark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
  },
  template: `<img src="assets/icon.svg" alt="" draggable="false" [width]="size()" [height]="size()" />`,
  styles: [
    `
      :host {
        display: block;
        flex: none;
        line-height: 0;
      }

      img {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ],
})
export class AppMark {
  /** Drawn size in px. */
  readonly size = input(16);
}
