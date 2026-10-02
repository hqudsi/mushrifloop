/**
 * Right-panel data (SPEC.md §10): the selected task's changed files and the usage figures. Fetched from
 * the main process and refreshed when the task changes; nothing is computed here.
 */

import { Injectable, effect, inject, signal, untracked } from '@angular/core';

import type { ChangedFiles, UsageReport } from '../../../shared/ipc';
import { storageKey } from '../../../shared/app-config';
import { usageRefreshDue } from '../../../shared/usage';
import { api } from './api';
import { TasksStore } from './tasks-store';

const OPEN_KEY = storageKey('rightPanel');
const FILES_DEBOUNCE_MS = 400;

/** How often the usage panel checks whether a refresh is due (SPEC.md §17). */
const USAGE_TICK_MS = 20_000;

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

@Injectable({ providedIn: 'root' })
export class PanelStore {
  private readonly tasks = inject(TasksStore);

  readonly open = signal(readOpen());
  readonly files = signal<ChangedFiles | null>(null);
  readonly filesLoading = signal(false);
  readonly usage = signal<UsageReport | null>(null);
  readonly usageLoading = signal(false);
  readonly fileError = signal<string | null>(null);

  private filesTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventSeq = 0;
  private lastStatus: string | null = null;
  /** When `/usage` was last asked for, whether or not it ran. */
  private lastUsageRefresh = 0;

  constructor() {
    // A different task: fetch its files right away.
    effect(() => {
      const id = this.tasks.selectedId();
      const open = this.open();
      untracked(() => {
        this.files.set(null);
        this.fileError.set(null);
        this.lastEventSeq = 0;
        this.lastStatus = null;
        if (id && open) void this.loadFiles(id);
        if (open) void this.loadUsage(true);
      });
    });
    // The same task moved on: refresh after cycles, commits and status changes.
    effect(() => {
      const detail = this.tasks.detail();
      if (!detail || !this.open()) return;
      const events = detail.events;
      const last = events[events.length - 1]?.seq ?? 0;
      const status = `${detail.task.status}:${detail.busy}`;
      untracked(() => {
        const fresh = events.filter((e) => e.seq > this.lastEventSeq);
        const touched = fresh.some((e) => e.type === 'cycle' || e.type === 'commit' || e.type === 'turn' || e.type === 'setup');
        const statusChanged = this.lastStatus !== null && this.lastStatus !== status;
        const first = this.lastEventSeq === 0;
        this.lastEventSeq = last;
        this.lastStatus = status;
        if (!first && (touched || statusChanged)) this.scheduleFiles(detail.task.id);
        if (fresh.some((e) => e.type === 'turn') || statusChanged) void this.loadUsage(!detail.busy && statusChanged);
      });
    });
    setInterval(() => this.autoRefreshUsage(false), USAGE_TICK_MS);
    window.addEventListener('focus', () => this.autoRefreshUsage(true));
    document.addEventListener('visibilitychange', () => this.autoRefreshUsage(true));
  }

  /**
   * SPEC.md §17: while the panel is on screen, `/usage` keeps it current between turns — every 5 minutes, on
   * coming back to the window after a minute, and right after a window's reset time passes. While a task runs
   * its turns keep the figures current, and the main process does not run `/usage`.
   */
  private autoRefreshUsage(focus: boolean): void {
    if (!this.open() || this.tasks.selectedId() === null || document.visibilityState !== 'visible') return;
    if (this.tasks.detail()?.busy) return;
    const resets = this.usage()?.windows.map((w) => w.resetsAt) ?? [];
    if (usageRefreshDue(Date.now(), this.lastUsageRefresh, focus, resets)) void this.loadUsage(true);
  }

  toggle(): void {
    const next = !this.open();
    this.open.set(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? 'open' : 'closed');
    } catch {
      /* storage unavailable */
    }
  }

  async loadFiles(taskId: string): Promise<void> {
    this.filesLoading.set(true);
    try {
      const files = await api().getChangedFiles(taskId);
      if (this.tasks.selectedId() === taskId) this.files.set(files);
    } catch (err) {
      if (this.tasks.selectedId() === taskId) this.fileError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.filesLoading.set(false);
    }
  }

  /** `refresh` also runs `/usage` in the main process, which it only does while no task runs. */
  async loadUsage(refresh: boolean): Promise<void> {
    if (this.usageLoading()) return;
    if (refresh) this.lastUsageRefresh = Date.now();
    this.usageLoading.set(true);
    try {
      this.usage.set(await api().getUsage(refresh));
    } catch {
      /* the panel degrades gracefully (SPEC.md §17) */
    } finally {
      this.usageLoading.set(false);
    }
  }

  async openFile(taskId: string, relativePath: string): Promise<void> {
    this.fileError.set(null);
    const result = await api().openTaskFile(taskId, relativePath);
    if (!result.ok) this.fileError.set(result.error ?? 'The editor could not be started.');
  }

  private scheduleFiles(taskId: string): void {
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => {
      this.filesTimer = null;
      if (this.tasks.selectedId() === taskId) void this.loadFiles(taskId);
    }, FILES_DEBOUNCE_MS);
  }
}
