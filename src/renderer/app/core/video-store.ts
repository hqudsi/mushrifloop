/**
 * What the selected Video task's own video/ folder holds right now (SPEC.md §21.7): the storyboard, the
 * review images and the rendered files, as the main process reads them. Shared by the review panel and the
 * two gate cards.
 *
 * The app has no file watcher. The listing is read again when the task's events move on and every three
 * seconds while a turn runs, because stills and rendered frames appear in the middle of a turn. That poll
 * is one reading for the status rows and the strip; a reading equal to the last one changes nothing, and
 * no image is fetched by it: the panel asks for the thumbnails of the tiles it shows.
 */

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { ReviewImage, VideoReview } from '../../../shared/video';
import { api } from './api';
import { TasksStore } from './tasks-store';

const POLL_MS = 3000;
/** A thumbnail or full image is the file at one moment: a re-rendered still gets a new key. */
const keyOf = (image: Pick<ReviewImage, 'name' | 'mtimeMs' | 'size'>) => `${image.name}@${Math.round(image.mtimeMs)}:${image.size}`;
const MAX_FULL_IMAGES = 6;

@Injectable({ providedIn: 'root' })
export class VideoStore {
  private readonly tasks = inject(TasksStore);

  readonly review = signal<VideoReview | null>(null);
  readonly thumbs = signal<ReadonlyMap<string, string>>(new Map());
  readonly fulls = signal<ReadonlyMap<string, string>>(new Map());
  /** The image open in the full-size viewer, by its name; null when it is closed. */
  readonly viewing = signal<string | null>(null);
  readonly openError = signal<string | null>(null);

  /** The selected task, when it is a Video task. */
  readonly task = computed(() => {
    const t = this.tasks.detail()?.task;
    return t && t.kind === 'video' && t.video ? t : null;
  });
  readonly images = computed(() => this.review()?.images ?? []);
  private readonly taskId = computed(() => this.task()?.id ?? null);

  private loading = false;
  private lastSeq = 0;
  /** The last reading, as text, to tell a poll that found nothing new. */
  private lastReading: string | null = null;
  private readonly thumbsLoading = new Set<string>();

  constructor() {
    // Another task: start clean. It depends on the id alone: the task object is a new one on every update,
    // and clearing the panel each time made it blink (and closed the viewer) whenever a turn ended.
    effect(() => {
      const id = this.taskId();
      untracked(() => {
        this.review.set(null);
        this.thumbs.set(new Map());
        this.fulls.set(new Map());
        this.viewing.set(null);
        this.lastReading = null;
        this.thumbsLoading.clear();
        this.lastSeq = 0;
        if (id) void this.load(id);
      });
    });
    // The same task moved on: a turn ended, a cycle was recorded, the status changed.
    effect(() => {
      const detail = this.tasks.detail();
      const id = this.task()?.id;
      if (!detail || !id) return;
      const last = detail.events[detail.events.length - 1]?.seq ?? 0;
      const status = detail.task.status;
      untracked(() => {
        void status;
        if (last !== this.lastSeq) {
          this.lastSeq = last;
          void this.load(id);
        }
      });
    });
    setInterval(() => {
      const id = this.task()?.id;
      if (id && this.tasks.detail()?.busy && document.visibilityState === 'visible') void this.load(id);
    }, POLL_MS);
  }

  async load(taskId: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const next = await api().getVideoReview(taskId);
      if (this.task()?.id !== taskId || !next) return;
      // A reading that says what the last one said changes nothing on screen: the poll then costs one small
      // read in the main process and no rendering here.
      const text = JSON.stringify(next);
      if (text === this.lastReading) return;
      this.lastReading = text;
      this.review.set(next);
      // Thumbnails are not fetched here: the panel asks for the ones its strip shows (wantThumb).
      const wanted = new Set(next.images.map(keyOf));
      if ([...this.thumbs().keys()].some((k) => !wanted.has(k))) this.thumbs.set(new Map([...this.thumbs()].filter(([k]) => wanted.has(k))));
      const open = this.viewing();
      if (open !== null && !next.images.some((i) => i.name === open)) this.viewing.set(null);
    } catch {
      /* the panel keeps what it had; the next refresh tries again */
    } finally {
      this.loading = false;
    }
  }

  thumbOf(image: ReviewImage): string | null {
    return this.thumbs().get(keyOf(image)) ?? null;
  }

  fullOf(image: ReviewImage): string | null {
    return this.fulls().get(keyOf(image)) ?? null;
  }

  /**
   * Fetch the thumbnail of one image, once per version of its file. Called by the panel for the tiles that
   * are visible or about to be (SPEC.md §21.7); nothing else loads a thumbnail.
   */
  wantThumb(name: string): void {
    const taskId = this.task()?.id;
    const image = this.images().find((i) => i.name === name);
    if (!taskId || !image) return;
    const key = keyOf(image);
    if (this.thumbs().has(key) || this.thumbsLoading.has(key)) return;
    this.thumbsLoading.add(key);
    void api()
      .getVideoImage(taskId, image.name, false)
      .then((url) => {
        if (!url || this.task()?.id !== taskId) return;
        // Keep only what the current listing shows.
        const wanted = new Set(this.images().map(keyOf));
        const next = new Map([...this.thumbs()].filter(([k]) => wanted.has(k)));
        if (wanted.has(key)) next.set(key, url);
        this.thumbs.set(next);
      })
      .catch(() => undefined)
      .finally(() => this.thumbsLoading.delete(key));
  }

  /** Open the full-size viewer on an image; its whole PNG is fetched once. */
  async view(name: string): Promise<void> {
    const taskId = this.task()?.id;
    const image = this.images().find((i) => i.name === name);
    if (!taskId || !image) return;
    this.viewing.set(name);
    const key = keyOf(image);
    if (this.fulls().has(key)) return;
    const url = await api().getVideoImage(taskId, name, true);
    if (!url || this.task()?.id !== taskId) return;
    const next = new Map([...this.fulls()].slice(-(MAX_FULL_IMAGES - 1)));
    next.set(key, url);
    this.fulls.set(next);
  }

  /** The image before or after the one in the viewer, wrapping round. */
  step(delta: number): void {
    const list = this.images();
    const index = list.findIndex((i) => i.name === this.viewing());
    if (index < 0 || list.length === 0) return;
    const next = list[(index + delta + list.length) % list.length];
    if (next) void this.view(next.name);
  }

  async open(what: 'folder' | 'video' | 'gif'): Promise<void> {
    const taskId = this.task()?.id;
    if (!taskId) return;
    const result = await api().openVideoOutput(taskId, what);
    this.openError.set(result.ok ? null : (result.error ?? 'It could not be opened.'));
  }
}
