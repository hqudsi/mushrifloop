/**
 * The two human gates of a Video task (SPEC.md §21.5), shown where an approval is shown:
 *
 * - `app-storyboard-card`: the storyboard as written (storyboard.md) and as data (the shots), and the
 *   instruction that is being held. Approve it, or send notes to the Planner.
 * - `app-final-video-card`: the rendered video in a player, its length and size, the GIF when one was asked
 *   for. Approve it, or send notes that start another round.
 *
 * What the human typed and what the agents wrote keeps its own direction, paragraph by paragraph (§10); the
 * labels are English like the rest of the interface.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { videoMediaUrl } from '../../../../shared/app-config';
import { formatBytes } from '../../../../shared/attachments';
import type { TaskRecord } from '../../../../shared/task-model';
import { VIDEO_ATTACH_LIMIT_BYTES, VIDEO_SMALL_COMMAND, type StoryboardShot } from '../../../../shared/video';
import { TasksStore } from '../../core/tasks-store';
import { VideoStore } from '../../core/video-store';
import { RichText } from '../../shared/rich-text';

interface MdLine {
  level: 0 | 1 | 2 | 3;
  bullet: boolean;
  text: string;
}

/** storyboard.md, line by line: headings and bullets are recognised, everything else is a paragraph. */
export function markdownLines(markdown: string): MdLine[] {
  const lines: MdLine[] = [];
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      lines.push({ level: (heading[1] ?? '#').length as 1 | 2 | 3, bullet: false, text: heading[2] ?? '' });
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    lines.push(bullet ? { level: 0, bullet: true, text: bullet[1] ?? '' } : { level: 0, bullet: false, text: line.trim() });
  }
  return lines;
}

const GATE_STYLES = `
  :host {
    display: block;
  }
  .panel {
    border: 1px solid var(--waiting);
    box-shadow: 0 0 0 3px var(--waiting-bg);
    border-radius: 6px;
    background: var(--bg-tl-card);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .title {
    font-weight: 600;
    font-size: 13.5px;
    color: var(--waiting);
  }
  .sub {
    font-size: 12.5px;
    color: var(--text-3);
  }
  .k {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .notes textarea {
    min-height: 64px;
    resize: vertical;
  }
  .warn {
    font-size: 12px;
    color: var(--executor);
  }
  .err {
    font-size: 12px;
    color: var(--danger);
  }
  .hint {
    font-size: 12px;
    color: var(--text-3);
  }
`;

@Component({
  selector: 'app-storyboard-card',
  standalone: true,
  imports: [RichText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (waiting(); as w) {
      <div class="panel">
        <div>
          <div class="title">Storyboard — waiting for you</div>
          <div class="sub">Nothing is built until you approve it. Check the text on screen here: the agents do not judge spelling from images.</div>
        </div>

        @if (changedOnDisk()) {
          <div class="warn">The storyboard file changed after this card opened. Approve shows you the one on disk now.</div>
        }

        @if (lines().length > 0) {
          <div class="doc">
            @for (line of lines(); track $index) {
              @if (line.level > 0) {
                <div class="h" [class.h1]="line.level === 1" [class.h2]="line.level === 2" dir="auto">{{ line.text }}</div>
              } @else {
                <div class="p" [class.bullet]="line.bullet" dir="auto"><app-rich-text [text]="line.text" /></div>
              }
            }
          </div>
        } @else {
          <div class="hint">There is no storyboard.md to show; the shots below are the storyboard data.</div>
        }

        @if (shots().length > 0) {
          <div>
            <div class="k">Shots, as the code will read them</div>
            <div class="shots">
              @for (shot of shots(); track shot.id) {
                <div class="shot">
                  <div class="shot-head">
                    <span class="mono">{{ shot.id }}</span>
                    <span class="shot-name" dir="auto">{{ shot.name }}</span>
                    <span class="mono dim">frames {{ shot.startFrame }}–{{ shot.endFrame }} · {{ seconds(shot) }} s</span>
                  </div>
                  <div class="on" dir="auto">{{ shot.onScreen }}</div>
                  @for (t of shot.texts; track t.id) {
                    <div class="text">
                      <span class="mono dim">text</span>
                      <bdi class="quoted" [attr.lang]="t.lang">{{ t.text }}</bdi>
                      <span class="mono dim">{{ t.lang }} · frames {{ t.startFrame }}–{{ t.endFrame }}</span>
                    </div>
                  }
                  <div class="mono dim">review frames: {{ shot.reviewFrames.join(', ') }} · {{ shot.acceptance.length }} checks</div>
                </div>
              }
            </div>
          </div>
        }

        <details class="held">
          <summary>The Planner's next step, held until you decide</summary>
          <div class="p" dir="auto"><app-rich-text [text]="w.instruction" /></div>
        </details>

        <div class="actions">
          <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="approve()">Approve storyboard</button>
          <span class="hint">or tell the Planner what to change:</span>
        </div>
        <div class="notes">
          <textarea class="textarea" placeholder="Notes for the Planner…" [value]="notes()" (input)="notes.set($any($event.target).value)" (keydown.control.enter)="send()"></textarea>
          <div class="actions">
            <button type="button" class="btn" [disabled]="!!store.pendingAction() || notes().trim() === ''" (click)="send()">Send notes</button>
            @if (store.actionError(); as e) {
              <span class="err">{{ e.message }}</span>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    GATE_STYLES,
    `
      .doc {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 10px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 420px;
        overflow: auto;
      }
      .h {
        font-weight: 600;
        color: var(--text);
        margin-top: 6px;
        unicode-bidi: plaintext;
        text-align: start;
      }
      .h1 {
        font-size: 15px;
        margin-top: 0;
      }
      .h2 {
        font-size: 13.5px;
      }
      .p.bullet {
        padding-inline-start: 16px;
        position: relative;
      }
      .p.bullet::before {
        content: '•';
        position: absolute;
        inset-inline-start: 4px;
        color: var(--text-3);
      }
      .shots {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .shot {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .shot-head {
        display: flex;
        gap: 10px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .shot-name {
        font-weight: 600;
        color: var(--text);
        flex: 1;
        min-width: 0;
        unicode-bidi: plaintext;
      }
      .dim {
        color: var(--text-3);
      }
      .on {
        unicode-bidi: plaintext;
        text-align: start;
      }
      .text {
        display: flex;
        gap: 10px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .quoted {
        font-size: 15px;
        color: var(--text);
        padding: 1px 8px;
        border-radius: 4px;
        background: var(--waiting-bg);
      }
      .held summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--text-3);
      }
      .held .p {
        margin-top: 6px;
        font-size: 12.5px;
      }
    `,
  ],
})
export class StoryboardCard {
  protected readonly store = inject(TasksStore);
  private readonly video = inject(VideoStore);
  readonly task = input.required<TaskRecord>();
  protected readonly notes = signal('');

  protected readonly waiting = computed(() => {
    const w = this.task().waiting;
    return w?.kind === 'storyboard_approval' ? w : null;
  });
  protected readonly lines = computed(() => markdownLines(this.video.review()?.storyboard.markdown ?? ''));
  protected readonly shots = computed<StoryboardShot[]>(() => this.video.review()?.storyboard.data?.shots ?? []);
  protected readonly changedOnDisk = computed(() => {
    const hash = this.video.review()?.storyboard.hash;
    const w = this.waiting();
    return !!w && hash !== undefined && hash !== null && hash !== w.hash;
  });

  protected seconds(shot: StoryboardShot): string {
    const fps = this.video.review()?.storyboard.data?.fps ?? this.task().video?.settings.fps ?? 30;
    return ((shot.endFrame - shot.startFrame + 1) / fps).toFixed(2);
  }

  protected async approve(): Promise<void> {
    const ok = await this.store.act({ kind: 'approve_storyboard' });
    // Refused because the file changed: show the one on disk now.
    if (!ok) void this.video.load(this.task().id);
  }

  protected async send(): Promise<void> {
    const notes = this.notes().trim();
    if (notes === '') return;
    if (await this.store.act({ kind: 'reject_storyboard', notes })) this.notes.set('');
  }
}

@Component({
  selector: 'app-final-video-card',
  standalone: true,
  imports: [RichText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (waiting(); as w) {
      <div class="panel">
        <div>
          <div class="title">The video is rendered — watch it</div>
          <div class="sub">Only you can judge motion and pacing, and whether the text on screen is right. Approve it to finish the task, or send notes for another round.</div>
        </div>

        @if (videoUrl(); as src) {
          <video class="player" controls preload="metadata" [src]="src" (loadedmetadata)="onMeta($event)" (error)="playError.set(true)"></video>
          <div class="meta mono">
            {{ metaLine() }}
          </div>
          @if (playError()) {
            <div class="err">The player could not play this file. Open it in your default player instead.</div>
          }
          <!-- SPEC.md §21.9: the render's size warning, where the human sees it. -->
          @if (sizeNote(); as note) {
            <div class="size-note">
              <div class="warn">{{ note.warning }}</div>
              @if (note.small) {
                <div class="hint">A smaller copy is in the output folder: <span class="mono">video/out/video-small.mp4</span>, {{ note.small }}{{ note.stale ? ' (made before this render: run the command again)' : '' }}.</div>
              }
              @if (!note.small || note.stale) {
                <div class="hint">
                  For a copy under 10 MB, run this in the project's <span class="mono">video</span> folder. It leaves this file as it is.
                </div>
                <div class="cmd"><code class="mono">{{ smallCommand }}</code></div>
              }
            </div>
          }
        } @else {
          <div class="err">The video file is not there any more (video/out/video.mp4). Send a note to the Planner to render it again.</div>
        }

        @if (gifUrl(); as gif) {
          <div>
            <div class="k">GIF · {{ gifSize() }}</div>
            <img class="gif" [src]="gif" alt="The GIF made from the video" />
          </div>
        } @else if (task().video?.settings?.gif) {
          <div class="err">A GIF was asked for, and video/out/video.gif is not there.</div>
        }

        @if (video.review()?.storyboard?.changedSinceApproval) {
          <div class="warn">The storyboard changed since you approved it: this video was built from the newer one.</div>
        }

        <details class="report">
          <summary>The Planner's report</summary>
          <div dir="auto"><app-rich-text [text]="w.finalReport" /></div>
        </details>

        <div class="actions">
          <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction() || !videoUrl()" (click)="approve()">Approve video</button>
          <button type="button" class="btn" (click)="video.open('video')">Open in default player</button>
          <button type="button" class="btn" (click)="video.open('folder')">Open output folder</button>
          @if (video.openError(); as err) {
            <span class="err">{{ err }}</span>
          }
        </div>
        <div class="notes">
          <textarea class="textarea" placeholder="Notes for another round…" [value]="notes()" (input)="notes.set($any($event.target).value)" (keydown.control.enter)="send()"></textarea>
          <div class="actions">
            <button type="button" class="btn" [disabled]="!!store.pendingAction() || notes().trim() === ''" (click)="send()">Send notes</button>
            @if (store.actionError(); as e) {
              <span class="err">{{ e.message }}</span>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    GATE_STYLES,
    `
      .player {
        width: 100%;
        max-height: 60vh;
        background: #000;
        border-radius: 6px;
        display: block;
      }
      .meta {
        color: var(--text-3);
      }
      .size-note {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cmd {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cmd code {
        padding: 3px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg-input);
        color: var(--text);
        user-select: all;
      }
      .gif {
        max-width: min(100%, 480px);
        height: auto;
        display: block;
        border-radius: 6px;
        border: 1px solid var(--border);
      }
      .report summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--text-3);
      }
      .report div {
        margin-top: 6px;
        font-size: 12.5px;
      }
    `,
  ],
})
export class FinalVideoCard {
  protected readonly store = inject(TasksStore);
  protected readonly video = inject(VideoStore);
  readonly task = input.required<TaskRecord>();
  protected readonly notes = signal('');
  protected readonly playError = signal(false);
  /** Read from the file itself by the player. */
  private readonly meta = signal<{ duration: number; width: number; height: number } | null>(null);

  protected readonly waiting = computed(() => {
    const w = this.task().waiting;
    return w?.kind === 'video_approval' ? w : null;
  });
  protected readonly videoUrl = computed(() => {
    const mp4 = this.video.review()?.mp4;
    return mp4 ? videoMediaUrl(this.task().id, 'video.mp4', mp4.mtimeMs) : null;
  });
  protected readonly gifUrl = computed(() => {
    const gif = this.video.review()?.gif;
    return gif ? videoMediaUrl(this.task().id, 'video.gif', gif.mtimeMs) : null;
  });
  protected readonly gifSize = computed(() => formatBytes(this.video.review()?.gif?.size ?? 0));
  protected readonly metaLine = computed(() => {
    const mp4 = this.video.review()?.mp4;
    const m = this.meta();
    const parts: string[] = [];
    if (m) parts.push(`${m.duration.toFixed(1)} s`, `${m.width}×${m.height}`);
    if (mp4) parts.push(formatBytes(mp4.size));
    return parts.join(' · ');
  });

  protected readonly smallCommand = VIDEO_SMALL_COMMAND;
  /** Above 10 MB: the warning the render printed, and the smaller copy when one was made (SPEC.md §21.9). */
  protected readonly sizeNote = computed(() => {
    const review = this.video.review();
    const mp4 = review?.mp4;
    if (!mp4 || mp4.size <= VIDEO_ATTACH_LIMIT_BYTES) return null;
    const small = review?.small ?? null;
    return {
      warning: `This file is ${formatBytes(mp4.size)}: over ${Math.round(VIDEO_ATTACH_LIMIT_BYTES / 1024 / 1024)} MB, the limit for a video attached on GitHub.`,
      small: small ? formatBytes(small.size) : null,
      // A copy older than the video it was made from is a copy of an earlier render.
      stale: small !== null && small.mtimeMs < mp4.mtimeMs,
    };
  });

  protected onMeta(event: Event): void {
    const el = event.target as HTMLVideoElement;
    this.playError.set(false);
    this.meta.set({ duration: el.duration, width: el.videoWidth, height: el.videoHeight });
  }

  protected approve(): void {
    void this.store.act({ kind: 'approve_video' });
  }

  protected async send(): Promise<void> {
    const notes = this.notes().trim();
    if (notes === '') return;
    if (await this.store.act({ kind: 'reject_video', notes })) this.notes.set('');
  }
}
