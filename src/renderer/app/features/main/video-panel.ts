/**
 * The Video section of the right panel (SPEC.md §21.7): the video's format, where the storyboard, the render
 * and the GIF stand, and one strip of the latest review images from `video/out/review/`, newest first. A
 * click opens an image at full size; the arrow keys move through them and Escape closes.
 *
 * The section looks like the panel's other sections (heading, rows) and keeps one height: the strip is a
 * single row that scrolls sideways, so new stills never push the rest of the panel down.
 */

import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterRenderEffect, computed, inject, signal, viewChild, viewChildren } from '@angular/core';

import { formatBytes } from '../../../../shared/attachments';
import { reviewStrip, type ReviewImage } from '../../../../shared/video';
import { VideoStore } from '../../core/video-store';

/** A drag shorter than this is a click. */
const DRAG_PX = 5;

@Component({
  selector: 'app-video-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close()',
    '(document:keydown.arrowright)': 'arrow(1, $event)',
    '(document:keydown.arrowleft)': 'arrow(-1, $event)',
  },
  template: `
    @if (video.task(); as t) {
      <div class="sec-head"><span class="caps">VIDEO</span></div>
      <div class="grid">
        <span class="k">Format</span>
        <span>{{ t.video?.settings?.width }}×{{ t.video?.settings?.height }} · {{ t.video?.settings?.fps }} fps · {{ t.video?.settings?.durationSec }} s</span>
        <span class="k">Storyboard</span>
        <span [class.wait]="storyboardTone() === 'wait'" [class.ok]="storyboardTone() === 'ok'" [class.bad]="storyboardTone() === 'bad'">{{ storyboardLine() }}</span>
        <span class="k">Render</span>
        <span [class.ok]="renderDone()">{{ renderLine() }}</span>
        @if (t.video?.settings?.gif) {
          <span class="k">GIF</span>
          <span [class.ok]="!!video.review()?.gif">{{ gifLine() }}</span>
        }
      </div>

      <!-- One row of fixed height, newest first (SPEC.md §21.7). -->
      <div class="strip-box">
        @if (strip().tiles.length === 0) {
          <div class="empty">No review images yet.</div>
        } @else {
          <div
            #rail
            class="strip"
            [class.dragging]="dragging()"
            (wheel)="onWheel($event)"
            (scroll)="measure()"
            (pointerdown)="dragStart($event)"
            (pointermove)="dragMove($event)"
            (pointerup)="dragEnd($event)"
            (pointercancel)="dragEnd($event)"
          >
            @for (image of strip().tiles; track image.name) {
              <button #tile type="button" class="tile" [attr.data-name]="image.name" [title]="image.name + ' · ' + size(image.size)" (click)="openImage(image.name)">
                @if (video.thumbOf(image); as src) {
                  <img [src]="src" [alt]="image.name" draggable="false" />
                }
              </button>
            }
            @if (strip().more > 0) {
              <button type="button" class="tile more" [title]="'Open the viewer on all ' + video.images().length + ' images'" (click)="openImage(strip().firstHidden)">+{{ strip().more }} more</button>
            }
          </div>
          @if (canLeft()) {
            <button type="button" class="nav left" aria-label="Scroll to newer images" (click)="page(-1)">‹</button>
          }
          @if (canRight()) {
            <button type="button" class="nav right" aria-label="Scroll to older images" (click)="page(1)">›</button>
          }
        }
      </div>

      <div class="actions">
        <button type="button" class="btn mini" (click)="video.open('folder')">Open output folder</button>
        @if (video.openError(); as err) {
          <span class="err">{{ err }}</span>
        }
      </div>

      @if (viewed(); as image) {
        <div class="viewer" role="dialog" aria-modal="true" [attr.aria-label]="image.name" (mousedown)="$event.target === $event.currentTarget && close()">
          <div class="bar">
            <span class="mono title">{{ image.name }}</span>
            <span class="count">{{ position() }}</span>
            <button type="button" class="btn small" [disabled]="video.images().length < 2" (click)="video.step(-1)" aria-label="Previous image">←</button>
            <button type="button" class="btn small" [disabled]="video.images().length < 2" (click)="video.step(1)" aria-label="Next image">→</button>
            <button type="button" class="btn small" (click)="close()">Close</button>
          </div>
          <div class="stage" (mousedown)="$event.target === $event.currentTarget && close()">
            @if (video.fullOf(image) ?? video.thumbOf(image); as src) {
              <img [src]="src" [alt]="image.name" [class.loading]="!video.fullOf(image)" />
            } @else {
              <span class="ph">Loading…</span>
            }
          </div>
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      /* The heading and the rows are the right panel's own (right-panel.ts): the first section has no separator. */
      .sec-head {
        margin: 14px 16px 0;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }
      .caps {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--text-3);
      }
      .grid {
        padding: 8px 16px 0;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 7px 16px;
        font-size: 12px;
        align-items: center;
      }
      .k {
        color: var(--text-muted);
        white-space: nowrap;
      }
      .ok {
        color: var(--success);
      }
      .wait {
        color: var(--waiting);
        font-weight: 600;
      }
      .bad {
        color: var(--executor);
      }
      .err {
        font-size: 11.5px;
        color: var(--danger);
      }
      .strip-box {
        position: relative;
        margin: 10px 16px 0;
        height: 62px;
      }
      .empty {
        height: 100%;
        display: grid;
        place-items: center;
        border: 1px dashed var(--border);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .strip {
        height: 100%;
        display: flex;
        gap: 6px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
        cursor: grab;
        touch-action: pan-y;
      }
      .strip::-webkit-scrollbar {
        display: none;
      }
      .strip.dragging {
        cursor: grabbing;
      }
      .tile {
        flex: none;
        width: 104px;
        height: 100%;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg-tl-card);
        overflow: hidden;
        cursor: zoom-in;
        color: var(--text-muted);
        font: inherit;
        font-size: 11.5px;
      }
      .strip.dragging .tile {
        cursor: grabbing;
      }
      .tile:hover,
      .tile:focus-visible {
        border-color: var(--planner);
        outline: none;
      }
      .tile img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
        user-select: none;
      }
      .tile.more {
        cursor: pointer;
        color: var(--text-2);
      }
      .nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 18px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg-chrome);
        color: var(--text-2);
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
      }
      .nav:hover {
        color: var(--text);
        border-color: var(--border-strong);
      }
      .nav.left {
        left: 2px;
      }
      .nav.right {
        right: 2px;
      }
      .ph {
        display: grid;
        place-items: center;
        min-height: 60px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .actions {
        margin: 10px 16px 0;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .btn.mini {
        height: 24px;
        padding: 0 8px;
        font-size: 11.5px;
      }
      .btn.small {
        padding: 3px 10px;
        font-size: 12px;
      }
      .viewer {
        position: fixed;
        inset: 0;
        z-index: 60;
        background: rgba(0, 0, 0, 0.88);
        display: flex;
        flex-direction: column;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 10px;
        /* Clear of the window's own caption buttons at the right. */
        padding: 44px 24px 10px;
        color: #e8e8ea;
      }
      .title {
        font-size: 12.5px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .count {
        font-size: 12px;
        color: #a0a3ab;
      }
      .stage {
        flex: 1;
        min-height: 0;
        display: grid;
        place-items: center;
        padding: 0 24px 24px;
        overflow: auto;
      }
      .stage img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7);
      }
      .stage img.loading {
        width: 100%;
        filter: blur(1px);
        opacity: 0.85;
      }
    `,
  ],
})
export class VideoPanel implements OnDestroy {
  protected readonly video = inject(VideoStore);

  private readonly stripEl = viewChild<ElementRef<HTMLElement>>('rail');
  private readonly tileEls = viewChildren<ElementRef<HTMLElement>>('tile');

  /** At most twelve tiles, newest first, and how many images are not shown. */
  protected readonly strip = computed(() => reviewStrip(this.video.images()));

  protected readonly canLeft = signal(false);
  protected readonly canRight = signal(false);
  protected readonly dragging = signal(false);
  private drag: { x: number; left: number; id: number; moved: boolean } | null = null;
  /** A click that ends a drag is not a click on the tile under it. */
  private swallowClick = false;

  /** Tiles that are on screen or about to be: only they get a thumbnail. */
  private readonly near = new Set<string>();
  private observer: IntersectionObserver | null = null;
  private observedRoot: HTMLElement | null = null;

  constructor() {
    afterRenderEffect(() => {
      const root = this.stripEl()?.nativeElement ?? null;
      const tiles = this.tileEls();
      // The listing changed: a still that was rendered again has a new thumbnail to fetch.
      const shown = this.strip().tiles;
      if (root !== this.observedRoot) {
        this.observer?.disconnect();
        this.observer = null;
        this.observedRoot = root;
        this.near.clear();
        if (root) {
          this.observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const name = (entry.target as HTMLElement).dataset['name'];
                if (!name) continue;
                if (entry.isIntersecting) {
                  this.near.add(name);
                  this.video.wantThumb(name);
                } else {
                  this.near.delete(name);
                }
              }
            },
            // "About to be": one tile's width beyond each end of the strip.
            { root, rootMargin: '0px 120px', threshold: 0 },
          );
        }
      }
      if (this.observer) for (const tile of tiles) this.observer.observe(tile.nativeElement);
      for (const image of shown) if (this.near.has(image.name)) this.video.wantThumb(image.name);
      this.measure();
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected readonly viewed = computed<ReviewImage | null>(() => this.video.images().find((i) => i.name === this.video.viewing()) ?? null);
  protected readonly position = computed(() => {
    const list = this.video.images();
    const index = list.findIndex((i) => i.name === this.video.viewing());
    return index < 0 ? '' : `${index + 1} of ${list.length}`;
  });

  protected readonly storyboardTone = computed<'ok' | 'wait' | 'bad' | 'plain'>(() => {
    const t = this.video.task();
    if (this.video.review()?.error) return 'bad';
    if (t?.waiting?.kind === 'storyboard_approval') return 'wait';
    return t?.video?.storyboard ? 'ok' : 'plain';
  });
  protected readonly storyboardLine = computed(() => {
    const t = this.video.task();
    const review = this.video.review();
    const r = review?.storyboard;
    // The folder could not be read: said here, in a row, so it is never lost.
    if (review?.error) return `could not be read: ${review.error}`;
    if (t?.waiting?.kind === 'storyboard_approval') return 'waiting for you';
    if (t?.video?.storyboard) return r?.changedSinceApproval ? 'approved — changed since you approved it' : 'approved';
    if (!r || r.state === 'missing') return 'not written yet';
    if (r.state === 'invalid') return `not usable yet (${r.problems.length} problem${r.problems.length === 1 ? '' : 's'})`;
    return 'written, not approved yet';
  });
  protected readonly renderDone = computed(() => !!this.video.review()?.mp4);
  protected readonly renderLine = computed(() => {
    const r = this.video.review();
    if (!r) return '…';
    if (r.mp4) return `done · ${formatBytes(r.mp4.size)}`;
    if (r.render.frames === 0) return 'none yet';
    return r.render.total ? `${r.render.frames} of ${r.render.total} frames` : `${r.render.frames} frames`;
  });
  protected readonly gifLine = computed(() => {
    const gif = this.video.review()?.gif;
    return gif ? `done · ${formatBytes(gif.size)}` : 'not made yet';
  });

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }

  /** Opens the existing viewer at an image, unless the click only ended a drag. */
  protected openImage(name: string | null): void {
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    if (name) void this.video.view(name);
  }

  /** Which arrows have somewhere to go. */
  protected measure(): void {
    const el = this.stripEl()?.nativeElement;
    this.canLeft.set(!!el && el.scrollLeft > 1);
    this.canRight.set(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  /** The mouse wheel moves the strip sideways; at either end it scrolls the panel as usual. */
  protected onWheel(event: WheelEvent): void {
    const el = this.stripEl()?.nativeElement;
    if (!el || event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const atEnd = delta < 0 ? el.scrollLeft <= 0 : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    if (delta === 0 || atEnd) return;
    event.preventDefault();
    el.scrollLeft += delta;
  }

  protected page(direction: 1 | -1): void {
    const el = this.stripEl()?.nativeElement;
    el?.scrollBy({ left: direction * Math.max(110, el.clientWidth - 110), behavior: 'smooth' });
  }

  protected dragStart(event: PointerEvent): void {
    const el = this.stripEl()?.nativeElement;
    if (!el || event.button !== 0) return;
    this.swallowClick = false;
    this.drag = { x: event.clientX, left: el.scrollLeft, id: event.pointerId, moved: false };
  }

  protected dragMove(event: PointerEvent): void {
    const el = this.stripEl()?.nativeElement;
    const drag = this.drag;
    if (!el || !drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < DRAG_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      this.dragging.set(true);
      el.setPointerCapture(drag.id);
    }
    el.scrollLeft = drag.left - dx;
  }

  protected dragEnd(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    this.drag = null;
    if (drag.moved) {
      this.swallowClick = true;
      this.dragging.set(false);
      // The click that follows a release arrives in this same task; one that never comes must not eat the next.
      setTimeout(() => (this.swallowClick = false), 0);
    }
  }

  protected close(): void {
    if (this.video.viewing() !== null) this.video.viewing.set(null);
  }

  protected arrow(delta: number, event: Event): void {
    if (this.video.viewing() === null) return;
    event.preventDefault();
    this.video.step(delta);
  }
}
