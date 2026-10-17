/**
 * Agent text with `code` and **bold** spans rendered — built from text nodes, never innerHTML.
 * Line breaks are kept (white-space: pre-wrap), and each line is a paragraph with its own direction.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { codeSegments } from '../../../shared/format';

@Component({
  selector: 'app-rich-text',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (part of parts(); track $index) {@if (part.code) {<code class="inline">{{ part.text }}</code>} @else if (part.bold) {<b>{{ part.text }}</b>} @else {{{ part.text }}}}`,
  styles: [
    `
      /* Each paragraph takes the direction of its first letter (SPEC.md §10, right-to-left text). */
      :host {
        display: block;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        unicode-bidi: plaintext;
        text-align: start;
      }
    `,
  ],
})
export class RichText {
  readonly text = input<string>('');
  protected readonly parts = computed(() => codeSegments(this.text()));
}
