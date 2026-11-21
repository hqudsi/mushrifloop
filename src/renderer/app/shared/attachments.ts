/**
 * Attachments in the renderer (SPEC.md §10): the files waiting to be sent with a message or a new task, the
 * chips that show them, and the attached files shown with a message in the timeline.
 *
 * A file reaches the draft three ways: the attach button's picker (paths from the main process), drag and drop (the
 * dropped file's path, through the preload bridge), or a paste (an image with no path: its bytes). The main
 * process copies them; the renderer never touches the disk.
 */

import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';

import { attachmentKind, attachmentProblem, formatBytes } from '../../../shared/attachments';
import type { AttachmentInput, PickedFile } from '../../../shared/ipc';
import type { Attachment, AttachmentKind } from '../../../shared/task-model';
import { api } from '../core/api';

/**
 * The attach button's icon: a paperclip with a small plus at its lower right (owner's choice, 2026-10-18;
 * SPEC.md §10). Drawn in the text's colour, so it follows the button's hover and disabled states and both themes.
 */
@Component({
  selector: 'app-attach-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()">
      <path
        transform="translate(-1 3) scale(.82)"
        d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5"
      />
      <path d="M19 15v6M16 18h6" />
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-block;
        flex: none;
        line-height: 0;
      }
      svg {
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `,
  ],
})
export class AttachIcon {
  /** Drawn size in px. */
  readonly size = input(16);
}

export interface PendingAttachment {
  key: number;
  name: string;
  size: number;
  kind: AttachmentKind;
  input: AttachmentInput;
}

let nextKey = 1;

/** A pasted image has no file name worth keeping ("image.png"); it gets one with the time in it. */
function pastedName(file: File): string {
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `pasted-${stamp}.${ext}`;
}

/** The files of a message or a new task, before they are sent. */
export class AttachmentDraft {
  readonly items = signal<PendingAttachment[]>([]);
  /** Why the last files could not be added; cleared by the next change. */
  readonly problem = signal<string | null>(null);

  /** Files dropped on the box or pasted into it. */
  async addFiles(files: readonly File[]): Promise<void> {
    const added: PendingAttachment[] = [];
    for (const file of files) {
      const path = api().pathForFile(file);
      if (path) {
        added.push({ key: nextKey++, name: file.name, size: file.size, kind: attachmentKind(file.name), input: { path } });
      } else {
        // No path: an image from the clipboard. Its bytes go to the main process.
        const name = file.name && file.name !== 'image.png' ? file.name : pastedName(file);
        const data = new Uint8Array(await file.arrayBuffer());
        added.push({ key: nextKey++, name, size: file.size, kind: attachmentKind(name), input: { name, data } });
      }
    }
    this.add(added);
  }

  /** The attach button's picker. */
  async pick(): Promise<void> {
    const picked: PickedFile[] = await api().pickAttachments();
    this.add(picked.map((p) => ({ key: nextKey++, name: p.name, size: p.size, kind: attachmentKind(p.name), input: { path: p.path } })));
  }

  remove(key: number): void {
    this.items.update((list) => list.filter((a) => a.key !== key));
    this.problem.set(null);
  }

  clear(): void {
    this.items.set([]);
    this.problem.set(null);
  }

  inputs(): AttachmentInput[] {
    return this.items().map((a) => a.input);
  }

  private add(added: PendingAttachment[]): void {
    if (added.length === 0) return;
    const next = [...this.items(), ...added];
    const problem = attachmentProblem(next.map((a) => a.size));
    this.problem.set(problem);
    if (!problem) this.items.set(next);
  }
}

export function kindGlyph(kind: AttachmentKind): string {
  return kind === 'image' ? '🖼' : kind === 'pdf' ? '📕' : '📄';
}

/** The files waiting in a message box or the New task dialog: one chip each, with ✕ to take it out. */
@Component({
  selector: 'app-attachment-tray',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (a of items(); track a.key) {
      <span class="chip" [title]="a.name + ' · ' + size(a.size)">
        <span class="glyph" aria-hidden="true">{{ glyph(a.kind) }}</span>
        <span class="name" dir="auto">{{ a.name }}</span>
        <span class="size">{{ size(a.size) }}</span>
        <button type="button" class="x" [attr.aria-label]="'Remove ' + a.name" (click)="removed.emit(a.key)">✕</button>
      </span>
    }
    @if (problem(); as p) {
      <span class="problem">{{ p }}</span>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      :host(:empty) {
        display: none;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 260px;
        padding: 3px 4px 3px 8px;
        border: 1px solid var(--border-strong);
        border-radius: 5px;
        background: var(--bg-tl-card);
        font-size: 12px;
        color: var(--text);
      }
      .glyph {
        flex: none;
        font-size: 12px;
      }
      .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .size {
        flex: none;
        color: var(--text-3);
        font-size: 11px;
      }
      .x {
        flex: none;
        border: 0;
        background: transparent;
        color: var(--text-3);
        cursor: pointer;
        font-size: 11px;
        padding: 1px 4px;
        border-radius: 3px;
      }
      .x:hover {
        background: var(--bg-hover);
        color: var(--text);
      }
      .problem {
        color: var(--danger);
        font-size: 12px;
        align-self: center;
      }
    `,
  ],
})
export class AttachmentTray {
  readonly items = input<PendingAttachment[]>([]);
  readonly problem = input<string | null>(null);
  readonly removed = output<number>();
  protected readonly glyph = kindGlyph;
  protected readonly size = formatBytes;
}

/** Files attached to a message or a task, in the timeline: a preview for an image; a click opens the file. */
@Component({
  selector: 'app-attachment-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (a of items(); track a.file) {
      <button type="button" class="att" [class.image]="previews()[a.file]" [title]="'Open ' + a.name + ' · ' + size(a.size)" (click)="open(a)">
        @if (previews()[a.file]; as src) {
          <img [src]="src" [alt]="a.name" />
        } @else {
          <span class="glyph" aria-hidden="true">{{ glyph(a.kind) }}</span>
        }
        <span class="name" dir="auto">{{ a.name }}</span>
      </button>
    }
    @if (error(); as e) {
      <span class="problem">{{ e }}</span>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 8px;
        margin-top: 8px;
      }
      .att {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 240px;
        padding: 4px 8px;
        border: 1px solid var(--border-strong);
        border-radius: 5px;
        background: var(--bg-tl-card);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        text-align: start;
      }
      .att:hover {
        border-color: var(--planner);
      }
      .att.image {
        flex-direction: column;
        align-items: stretch;
        padding: 4px;
      }
      img {
        display: block;
        max-width: 220px;
        max-height: 140px;
        object-fit: contain;
        border-radius: 3px;
        background: var(--bg-input);
      }
      .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .att.image .name {
        color: var(--text-3);
        font-size: 11px;
        padding: 0 2px;
      }
      .problem {
        color: var(--danger);
        font-size: 12px;
      }
    `,
  ],
})
export class AttachmentList {
  readonly taskId = input.required<string>();
  readonly items = input<readonly Attachment[]>([]);
  protected readonly previews = signal<Record<string, string>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly glyph = kindGlyph;
  protected readonly size = formatBytes;

  constructor() {
    effect(() => {
      const taskId = this.taskId();
      for (const a of this.items()) {
        if (a.kind !== 'image' || this.previews()[a.file]) continue;
        void api()
          .attachmentPreview(taskId, a.file)
          .then((src) => {
            if (src) this.previews.update((p) => ({ ...p, [a.file]: src }));
          });
      }
    });
  }

  protected async open(a: Attachment): Promise<void> {
    this.error.set(null);
    const result = await api().openAttachment(this.taskId(), a.file);
    if (!result.ok) this.error.set(`Could not open ${a.name}: ${result.error ?? 'unknown error'}`);
  }
}
