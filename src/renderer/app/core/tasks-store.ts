/**
 * Renderer-side task state for the main screen (SPEC.md §10).
 *
 * Holds what is displayed — the task list, the selected task's record and events, the live activity of
 * its running turn, and the live account — and forwards every user action to the main process. No
 * decisions are made here: the timeline is a pure fold of the stored events (src/shared/timeline.ts).
 */

import { Injectable, computed, signal } from '@angular/core';

import type {
  AccountStatus,
  ActionResult,
  BlockingTask,
  CreateTaskRequest,
  TaskAction,
  TaskDetail,
  TaskLoadFailure,
  TaskNoticeMessage,
  TaskSummary,
  TaskToast,
} from '../../../shared/ipc';
import type { LiveTurnEvent, TaskConfig, TaskEvent } from '../../../shared/task-model';
import { buildTimeline, runningTurn, type TimelineItem } from '../../../shared/timeline';
import { applyActivityEvent, emptyActivity, type TurnActivity } from '../../../shared/turn-activity';
import { storageKey } from '../../../shared/app-config';
import { api } from './api';

const ACCOUNT_REFRESH_MS = 60_000;
const SELECTED_KEY = storageKey('selectedTask');
/** Toasts that do not need the user leave on their own after this long. */
const TOAST_MS = 10_000;
const MAX_TOASTS = 3;

interface LiveState {
  taskId: string;
  turnId: string;
  activity: TurnActivity;
}

export interface ActionError {
  taskId: string;
  message: string;
  nextStep?: string;
  /** The running task that made the command wait (tasks run one at a time). */
  blockedBy?: BlockingTask;
}

/** What a New task dialog should open with (SPEC.md §10). */
export interface NewTaskDraft {
  description?: string;
  folder?: string;
  config?: TaskConfig;
}

export interface ShownToast extends TaskToast {
  id: number;
}

/** Most urgent first: tasks needing the user, then running ones, then by last change. */
function rank(t: TaskSummary): number {
  if (t.status === 'waiting_user' || t.status === 'account_mismatch') return 0;
  if (t.status === 'running' || t.busy) return 1;
  return 2;
}

@Injectable({ providedIn: 'root' })
export class TasksStore {
  readonly tasks = signal<TaskSummary[]>([]);
  readonly loaded = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<TaskDetail | null>(null);
  readonly detailLoading = signal(false);
  /** The selected task could not be read (SPEC.md §9). */
  readonly detailFailure = signal<TaskLoadFailure | null>(null);
  /** Quit and stop is waiting for these tasks to stop (SPEC.md §6). */
  readonly quitting = signal<{ stopping: BlockingTask[]; budgetMs: number } | null>(null);
  readonly live = signal<LiveState | null>(null);
  readonly account = signal<AccountStatus | null>(null);
  readonly accountLoading = signal(false);
  readonly actionError = signal<ActionError | null>(null);
  readonly pendingAction = signal<string | null>(null);
  readonly listError = signal<string | null>(null);
  /** Ticks every second, for elapsed times. */
  readonly now = signal(Date.now());
  /** Activity of finished turns, fetched when a card is expanded. */
  readonly activities = signal<ReadonlyMap<string, TurnActivity>>(new Map());
  /** In-app notifications (SPEC.md §10), newest last. */
  readonly toasts = signal<ShownToast[]>([]);
  /** The New task dialog is open. */
  readonly newTaskOpen = signal(false);
  /**
    * What the New task dialog opens with, when something offered it: the empty state's example
    * (SPEC.md §10), or "New task in this project" carrying a task's folder and settings.
    */
  readonly newTaskDraft = signal<NewTaskDraft | null>(null);

  /** Open the dialog on the same project and settings as an existing task (SPEC.md §10). */
  openNewTaskInProject(task: TaskDetail['task']): void {
    this.newTaskDraft.set({ folder: task.projectDir, config: task.config });
    this.newTaskOpen.set(true);
  }
  /** The main screen is on show (not Settings); set by the app shell. */
  readonly mainVisible = signal(true);
  /** Bumped when something asks for the main screen (a notification was clicked). */
  readonly showMainRequest = signal(0);
  /** Bumped when the gear in the sidebar asks for Settings (SPEC.md §10). */
  readonly showSettingsRequest = signal(0);

  readonly sortedTasks = computed(() =>
    [...this.tasks()].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)),
  );
  readonly selected = computed(() => this.tasks().find((t) => t.id === this.selectedId()) ?? null);
  readonly timeline = computed<TimelineItem[]>(() => {
    const d = this.detail();
    return d ? buildTimeline(d.events, d.busy) : [];
  });
  readonly running = computed(() => runningTurn(this.timeline()));
  readonly waitingCount = computed(() => this.tasks().filter((t) => rank(t) === 0).length);

  private started = false;
  private toastSeq = 0;
  private liveBuffer: Array<Extract<TaskNoticeMessage, { type: 'turn_event' }>> = [];
  private fetchingLive: string | null = null;

  init(): void {
    if (this.started) return;
    this.started = true;
    api().onTaskNotice((notice) => this.onNotice(notice));
    void this.loadList();
    void this.refreshAccount();
    setInterval(() => this.now.set(Date.now()), 1000);
    setInterval(() => void this.refreshAccount(), ACCOUNT_REFRESH_MS);
    window.addEventListener('focus', () => void this.refreshAccount());
  }

  async loadList(): Promise<void> {
    try {
      this.tasks.set(await api().listTasks());
      this.listError.set(null);
      if (this.selectedId() === null) {
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(SELECTED_KEY);
        } catch {
          /* storage unavailable */
        }
        const first = this.sortedTasks()[0];
        const pick = this.tasks().some((t) => t.id === remembered) ? remembered : (first?.id ?? null);
        if (pick) void this.select(pick);
      }
    } catch (err) {
      this.listError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loaded.set(true);
    }
  }

  async select(taskId: string | null): Promise<void> {
    this.selectedId.set(taskId);
    this.actionError.set(null);
    this.detailFailure.set(null);
    this.live.set(null);
    this.liveBuffer = [];
    try {
      if (taskId) localStorage.setItem(SELECTED_KEY, taskId);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* storage unavailable */
    }
    if (!taskId) {
      this.detail.set(null);
      return;
    }
    this.detailLoading.set(true);
    const fail = (folder: string, error: string) => {
      this.detail.set(null);
      this.detailFailure.set({ unreadable: true, taskId, folder, error });
    };
    try {
      const detail = await api().getTask(taskId);
      if (this.selectedId() !== taskId) return;
      if (detail === null) {
        fail('', `Task ${taskId} was not found.`);
        return;
      }
      if ('unreadable' in detail) {
        fail(detail.folder, detail.error);
        return;
      }
      this.detail.set(detail);
      const running = this.running();
      if (detail.busy && running) void this.fetchLive(taskId, running.turnId);
    } catch (err) {
      if (this.selectedId() === taskId) fail('', `The task could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.selectedId() === taskId) this.detailLoading.set(false);
    }
  }

  async refreshAccount(): Promise<void> {
    if (this.accountLoading()) return;
    this.accountLoading.set(true);
    try {
      this.account.set(await api().getAccountStatus());
    } catch (err) {
      this.account.set({
        checkedAt: new Date().toISOString(),
        cliVersion: null,
        cliPath: null,
        reading: null,
        error: err instanceof Error ? err.message : String(err),
        planUncertain: false,
        seenAccounts: [],
      });
    } finally {
      this.accountLoading.set(false);
    }
  }

  /** The activity of a finished turn (fetched once; a failed read is tried again next time). */
  async loadActivity(taskId: string, turnId: string): Promise<void> {
    const known = this.activities().get(turnId);
    if (known && known.error === null) return;
    let activity: TurnActivity;
    try {
      activity = await api().getTurnActivity(taskId, turnId);
    } catch (err) {
      activity = { ...emptyActivity(), error: `This turn's activity could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
    }
    const next = new Map(this.activities());
    next.set(turnId, activity);
    this.activities.set(next);
  }

  /** Create a task from the New task dialog; the new task is selected. */
  async createTask(request: CreateTaskRequest): Promise<ActionResult> {
    let result: ActionResult;
    try {
      result = await api().createTask(request);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.taskId) {
      await this.loadList();
      await this.select(result.taskId);
      // A refused start leaves a draft: show why on its control bar, with the running task linked.
      if (!result.ok) {
        this.actionError.set({
          taskId: result.taskId,
          message: result.error ?? 'The task could not start.',
          ...(result.nextStep ? { nextStep: result.nextStep } : {}),
          ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
        });
      }
    }
    return result;
  }

  /** Open Settings (the gear at the foot of the sidebar). */
  openSettings(): void {
    this.showSettingsRequest.update((n) => n + 1);
  }

  /** Show a task on the main screen (from a notification or a link). */
  openTask(taskId: string): void {
    this.showMainRequest.update((n) => n + 1);
    if (this.selectedId() !== taskId) void this.select(taskId);
  }

  dismissToast(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  /**
   * Rename any task, selected or not (SPEC.md §10). An empty title removes the name. The list and the
   * header follow from the task update the main process sends back.
   */
  async renameTask(taskId: string, title: string): Promise<boolean> {
    this.actionError.set(null);
    try {
      const result = await api().taskAction(taskId, { kind: 'rename', title });
      if (!result.ok) this.actionError.set({ taskId, message: result.error ?? 'The task could not be renamed.' });
      return result.ok;
    } catch (err) {
      this.actionError.set({ taskId, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  async act(action: TaskAction): Promise<boolean> {
    const taskId = this.selectedId();
    if (!taskId) return false;
    this.pendingAction.set(action.kind);
    this.actionError.set(null);
    try {
      const result = await api().taskAction(taskId, action);
      if (!result.ok) {
        this.actionError.set({
          taskId,
          message: result.error ?? 'The action failed.',
          ...(result.nextStep ? { nextStep: result.nextStep } : {}),
          ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
        });
      }
      return result.ok;
    } catch (err) {
      this.actionError.set({ taskId, message: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      this.pendingAction.set(null);
    }
  }

  // -------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------

  private onNotice(notice: TaskNoticeMessage): void {
    switch (notice.type) {
      case 'task': {
        const list = this.tasks();
        const index = list.findIndex((t) => t.id === notice.summary.id);
        this.tasks.set(index >= 0 ? list.map((t, i) => (i === index ? notice.summary : t)) : [notice.summary, ...list]);
        const d = this.detail();
        if (d && d.task.id === notice.task.id) this.detail.set({ ...d, task: notice.task, busy: notice.busy });
        if (!notice.busy && this.live()?.taskId === notice.task.id) this.live.set(null);
        break;
      }
      case 'event':
        this.onEvent(notice.taskId, notice.event);
        break;
      case 'turn_event':
        this.onTurnEvent(notice);
        break;
      case 'toast':
        this.onToast(notice.toast);
        break;
      case 'open_task':
        this.openTask(notice.taskId);
        break;
      case 'quitting':
        this.quitting.set(notice.stopping.length > 0 ? { stopping: notice.stopping, budgetMs: notice.budgetMs } : null);
        break;
    }
  }

  private onToast(toast: TaskToast): void {
    // The task on screen already shows its state.
    if (toast.taskId === this.selectedId() && this.mainVisible()) return;
    const shown: ShownToast = { ...toast, id: ++this.toastSeq };
    this.toasts.update((list) => [...list.filter((t) => t.taskId !== toast.taskId || t.category === 'cycle'), shown].slice(-MAX_TOASTS));
    if (toast.category !== 'waiting') setTimeout(() => this.dismissToast(shown.id), TOAST_MS);
  }

  private onEvent(taskId: string, event: TaskEvent): void {
    const d = this.detail();
    if (d && d.task.id === taskId) {
      const last = d.events[d.events.length - 1]?.seq ?? 0;
      if (event.seq > last) this.detail.set({ ...d, events: [...d.events, event] });
    }
    if (event.type === 'turn') {
      const live = this.live();
      if (live && live.turnId === event.turnId) {
        const next = new Map(this.activities());
        next.set(live.turnId, live.activity);
        this.activities.set(next);
      }
    }
    if (event.type === 'status' || event.type === 'account_mismatch') void this.refreshAccount();
  }

  private onTurnEvent(notice: Extract<TaskNoticeMessage, { type: 'turn_event' }>): void {
    if (notice.taskId !== this.selectedId()) return;
    if (this.fetchingLive === notice.turnId) {
      this.liveBuffer.push(notice);
      return;
    }
    const live = this.live();
    if (!live || live.turnId !== notice.turnId) {
      if (notice.seq === 1) {
        this.live.set({ taskId: notice.taskId, turnId: notice.turnId, activity: this.apply(emptyActivity(), notice.event) });
      } else {
        // We joined mid-turn: take the main process's copy, then continue from it.
        this.liveBuffer.push(notice);
        void this.fetchLive(notice.taskId, notice.turnId);
      }
      return;
    }
    if (notice.seq <= live.activity.seq) return;
    this.live.set({ ...live, activity: this.apply(live.activity, notice.event) });
  }

  private async fetchLive(taskId: string, turnId: string): Promise<void> {
    if (this.fetchingLive === turnId) return;
    this.fetchingLive = turnId;
    try {
      let snapshot: TurnActivity;
      try {
        snapshot = await api().getTurnActivity(taskId, turnId);
      } catch (err) {
        snapshot = { ...emptyActivity(), error: err instanceof Error ? err.message : String(err) };
      }
      if (snapshot.error !== null) {
        // New events still arrive; say that the earlier part of the turn is missing.
        snapshot = { ...emptyActivity(), error: `The earlier part of this turn could not be loaded (${snapshot.error}); new activity appears as it happens.` };
      }
      if (this.selectedId() !== taskId) return;
      let activity = snapshot;
      for (const n of this.liveBuffer) {
        if (n.turnId === turnId && n.seq > activity.seq) activity = this.apply(activity, n.event);
      }
      this.live.set({ taskId, turnId, activity });
    } finally {
      this.liveBuffer = [];
      this.fetchingLive = null;
    }
  }

  private apply(activity: TurnActivity, event: LiveTurnEvent): TurnActivity {
    return applyActivityEvent(activity, event, this.detail()?.task.projectDir ?? null);
  }
}
