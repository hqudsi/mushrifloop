/**
 * Quitting while a task is mid-turn (SPEC.md §6, decided 2026-09-16 and 2026-09-17): never silent.
 *
 * The app asks "Task <name> is mid-turn. Quit and stop it?". Cancel keeps everything running. "Quit and
 * stop" stops the task and waits until the stop has completed — the turn's processes gone and `stopped`
 * saved — for up to the stop budget, showing "Stopping <task>…" meanwhile. If the stop has not completed
 * by then, the app says so and asks: Keep waiting / Quit anyway. It never exits silently.
 *
 * Pure state machine; main.ts connects it to the window's `close` and the app's `before-quit` events.
 */

export interface BusyTask {
  taskId: string;
  title: string;
}

export interface QuitGuardDeps {
  /** The task whose turn is running, if any. */
  busyTask(): BusyTask | null;
  /** Show the confirmation; resolves true for "Quit and stop". */
  confirm(question: string): Promise<boolean>;
  /** Show "Stopping <task>…" for these tasks; an empty list hides it. */
  showStopping(tasks: readonly BusyTask[]): void;
  /** Stop every running task and wait up to `budgetMs`; resolves with the tasks not stopped yet. */
  stopAll(budgetMs: number): Promise<readonly BusyTask[]>;
  /** The stop did not complete in time: resolves true for "Quit anyway", false for "Keep waiting". */
  confirmQuitAnyway(question: string, pending: readonly BusyTask[]): Promise<boolean>;
  quit(): void;
  log(event: string, data?: Record<string, unknown>): void;
}

export type QuitGuardState = 'idle' | 'asking' | 'stopping' | 'ready';

export function quitQuestion(title: string): string {
  return `Task ${title} is mid-turn. Quit and stop it?`;
}

export function notStoppedQuestion(pending: readonly BusyTask[], budgetMs: number): string {
  const seconds = Math.round(budgetMs / 1000);
  return pending.length === 1
    ? `Task ${pending[0]?.title} did not stop within ${seconds} s.`
    : `${pending.length} tasks did not stop within ${seconds} s.`;
}

export class QuitGuard {
  private current: QuitGuardState = 'idle';

  constructor(
    private readonly deps: QuitGuardDeps,
    private readonly budgetMs: number,
  ) {}

  get state(): QuitGuardState {
    return this.current;
  }

  /**
   * Call from every quit path with its event. Lets the quit through when nothing runs (or once the task
   * is stopped); otherwise holds it and asks.
   */
  onQuitRequest(event: { preventDefault(): void }): void {
    if (this.current === 'ready') return;
    const busy = this.deps.busyTask();
    if (this.current === 'idle' && !busy) return;
    event.preventDefault();
    if (this.current !== 'idle' || !busy) return;
    void this.ask(busy);
  }

  private async ask(busy: BusyTask): Promise<void> {
    this.current = 'asking';
    let confirmed = false;
    try {
      confirmed = await this.deps.confirm(quitQuestion(busy.title));
    } catch (err) {
      this.deps.log('app.quit_confirm_failed', { error: message(err) });
    }
    if (!confirmed) {
      this.current = 'idle';
      this.deps.log('app.quit_cancelled', { taskId: busy.taskId });
      return;
    }
    // The turn may have ended while the question was open; stopping is still right (it parks the task).
    this.current = 'stopping';
    this.deps.log('app.quit_stopping_tasks', { taskId: busy.taskId, budgetMs: this.budgetMs });
    try {
      await this.stopUntilDone(busy);
    } finally {
      this.deps.showStopping([]);
      this.current = 'ready';
      this.deps.quit();
    }
  }

  /** Waits for the stop, round by round, until it completes or the user chooses to quit anyway. */
  private async stopUntilDone(busy: BusyTask): Promise<void> {
    const started = Date.now();
    let showing: readonly BusyTask[] = [busy];
    for (;;) {
      this.deps.showStopping(showing);
      let pending: readonly BusyTask[];
      try {
        pending = await this.deps.stopAll(this.budgetMs);
      } catch (err) {
        this.deps.log('app.quit_stop_failed', { error: message(err) });
        pending = showing;
      }
      if (pending.length === 0) {
        this.deps.log('app.quit_tasks_stopped', { waitedMs: Date.now() - started });
        return;
      }
      let quitAnyway = true;
      try {
        quitAnyway = await this.deps.confirmQuitAnyway(notStoppedQuestion(pending, Date.now() - started), pending);
      } catch (err) {
        this.deps.log('app.quit_confirm_failed', { error: message(err) });
      }
      if (quitAnyway) {
        this.deps.log('app.quit_forced', { pending: pending.map((t) => t.taskId), waitedMs: Date.now() - started });
        return;
      }
      this.deps.log('app.quit_keep_waiting', { pending: pending.map((t) => t.taskId) });
      showing = pending;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
