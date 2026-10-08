import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { APP_NAME } from '../../shared/app-config';
import { stoppingText } from '../../shared/format';
import { MIN_CLI_VERSION, isVersionBelow } from '../../shared/models';
import { pendingDefaultChanges } from '../../shared/settings';
import { api, isBridgeAvailable } from './core/api';
import { AppUpdateStore } from './core/app-update-store';
import { SettingsStore } from './core/settings-store';
import { TasksStore } from './core/tasks-store';
import { MainScreen } from './features/main/main-screen';
import { NewTaskDialog } from './features/new-task/new-task-dialog';
import { DefaultsReview } from './features/settings/defaults-review';
import { SettingsScreen } from './features/settings/settings';
import { SetupScreen } from './features/setup/setup-screen';
import { AppMark } from './shared/app-mark';
import { ToastHost } from './shared/toast-host';

type View = 'main' | 'settings';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [AppMark, DefaultsReview, MainScreen, NewTaskDialog, SettingsScreen, SetupScreen, ToastHost],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKeydown($event)' },
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
      }

      /*
       * This is the window's title bar (SPEC.md §10). Windows draws its own caption buttons into
       * the strip on the right, and tells the page how much room they take through the
       * titlebar-area-* environment variables; everything left of them is ours, and is the drag
       * region. The fallbacks keep the layout sane if the overlay is ever missing.
       */
      header {
        height: env(titlebar-area-height, 38px);
        flex: none;
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--border);
        background: var(--bg-chrome);
        padding-left: 14px;
        padding-right: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px));
        -webkit-app-region: drag;
        /* Without this, a double-click that lands on the title or the breadcrumb selects a word
           instead of maximising the window — which Windows' own title bars never do. */
        user-select: none;
      }

      /* High contrast: Windows paints the caption buttons in its own colours, so the bar they sit
         in must be the system's window colour too, not ours. */
      @media (forced-colors: active) {
        header {
          background: Canvas;
          color: CanvasText;
          border-bottom-color: CanvasText;
        }
      }

      .brand {
        margin-right: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 12.5px;
        flex: none;
      }

      .crumb {
        flex: 1;
        min-width: 0;
        display: flex;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
      }

      .crumb .path {
        font-family: var(--font-mono);
        flex: none;
      }

      .crumb .name {
        color: var(--text-3);
        overflow: hidden;
        text-overflow: ellipsis;
      }

      main {
        flex: 1;
        display: flex;
        min-height: 0;
      }

      .bridge-error {
        margin: 40px auto;
        max-width: 560px;
      }

      .settings-problem {
        margin: 0;
        border-radius: 0;
        border-width: 0 0 1px;
        flex: none;
        display: flex;
        gap: 12px;
        align-items: center;
      }

      .settings-problem .text {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      /* "Defaults after an update" (SPEC.md §11): one quiet line, not an alert. */
      .defaults-line,
      .update-line {
        flex: none;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 16px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-chrome);
        color: var(--text-2);
        font-size: 12.5px;
      }

      .defaults-line .text,
      .update-line .text {
        flex: 1;
        min-width: 0;
      }

      .update-error {
        margin-left: 8px;
        color: var(--danger);
      }

      .quit-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--bg) 70%, transparent);
      }

      .quit-box {
        min-width: 360px;
        max-width: 520px;
        padding: 20px 24px;
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        background: var(--bg-chrome);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .quit-title {
        font-size: 14px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .quit-sub {
        color: var(--text-3);
        line-height: 1.5;
      }
    `,
  ],
  template: `
    <header>
      <div class="brand">
        <app-mark [size]="18" />
        {{ appName }}
      </div>
      <div class="crumb">
        @if (setupOpen()) {
          <span class="name">Setup</span>
        } @else if (view() === 'settings') {
          <span class="name">Settings</span>
        } @else if (tasks.selected(); as task) {
          <span class="path" [title]="task.projectDir">{{ shortPath(task.projectDir) }}</span>
          <span>·</span>
          <span class="name">{{ task.title }}</span>
        }
      </div>
    </header>
    @if (store.appInfo()?.settingsProblem; as problem) {
      <div class="callout danger settings-problem" role="alert">
        <span class="text">
          <b>settings.json could not be used, so the app is running on default settings.</b>
          {{ problem.error }} The file (<span class="mono">{{ problem.file }}</span>) is left as it is. Saving
          Settings keeps a copy as <span class="mono">{{ problem.backup }}</span> first.
        </span>
        @if (view() !== 'settings') {
          <button type="button" class="btn" (click)="view.set('settings')">Open Settings</button>
        }
      </div>
    }
    @if (store.loaded() && !setupOpen() && pendingDefaults().length > 0) {
      <div class="defaults-line" role="status">
        <span class="text">
          This version changed {{ pendingDefaults().length }} default{{ pendingDefaults().length === 1 ? '' : 's' }}.
          Your settings still use the earlier {{ pendingDefaults().length === 1 ? 'one' : 'ones' }}.
        </span>
        <button type="button" class="btn mini" (click)="reviewOpen.set(true)">Review</button>
      </div>
    }
    @if (store.loaded() && !setupOpen() && updates.announce(); as update) {
      <div class="update-line" role="status">
        <span class="text">
          {{ appName }} {{ update.latest }} is available. You have {{ update.current }}.
          @if (updateError(); as error) {
            <span class="update-error">{{ error }}</span>
          }
        </span>
        <button type="button" class="btn mini" (click)="downloadUpdate()">Download</button>
        <button type="button" class="btn mini" (click)="updates.dismiss()">Dismiss</button>
      </div>
    }
    <main>
      @if (!bridgeAvailable) {
        <div class="bridge-error callout danger">
          The IPC bridge is unavailable — the preload script did not load, so nothing can be read or
          saved. Restart the app; if it persists, check the main-process log.
        </div>
      } @else if (setupOpen()) {
        <app-setup (done)="setupOpen.set(false)" />
      } @else if (view() === 'settings') {
        <app-settings (back)="view.set('main')" (rerunSetup)="setupOpen.set(true)" />
      } @else {
        <app-main-screen />
      }
    </main>
    @if (bridgeAvailable && !setupOpen()) {
      @if (tasks.newTaskOpen()) {
        <app-new-task-dialog />
      }
      @if (reviewOpen()) {
        <app-defaults-review (closed)="reviewOpen.set(false)" />
      }
      <app-toast-host />
      @if (tasks.quitting(); as quitting) {
        <div class="quit-overlay" role="alertdialog" aria-live="assertive">
          <div class="quit-box">
            <div class="quit-title">{{ stopping(quitting.stopping) }}</div>
            <div class="quit-sub">
              The app quits as soon as the turn has ended and its processes are gone — up to
              {{ seconds(quitting.budgetMs) }} s.
            </div>
          </div>
        </div>
      }
    }
  `,
})
export class AppComponent {
  protected readonly store = inject(SettingsStore);
  protected readonly tasks = inject(TasksStore);
  protected readonly updates = inject(AppUpdateStore);
  /** Download could not open the browser: said on the line itself, which is where it was pressed. */
  protected readonly updateError = signal<string | null>(null);

  readonly appName = APP_NAME;
  readonly bridgeAvailable = isBridgeAvailable();
  protected readonly view = signal<View>('main');
  /** First-run setup is on screen instead of the app (SPEC.md §10). */
  protected readonly setupOpen = signal(false);
  /** Changed defaults the saved settings have not been reconciled with (SPEC.md §11). */
  protected readonly pendingDefaults = computed(() => pendingDefaultChanges(this.store.saved()));
  protected readonly reviewOpen = signal(false);
  /** Whether setup is needed is decided once per start, never mid-session. */
  private setupDecided = false;

  private readonly systemPrefersDark = signal(true);

  constructor() {
    if (this.bridgeAvailable) {
      void this.store.load();
      this.tasks.init();
      // SPEC.md §11: the main process asks nothing while the setting is off.
      this.updates.start();
    }

    // Live: fires when Windows switches theme (while following the system) and when the main
    // process changes nativeTheme.themeSource.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemPrefersDark.set(media.matches);
    media.addEventListener('change', (event) => this.systemPrefersDark.set(event.matches));

    /**
     * SPEC.md §10: setup blocks the app when it has never been completed, and comes back on a later
     * start if the CLI or the account would stop a task anyway. Decided once, from the first live
     * account reading — a refresh that fails an hour later must not throw the user out of a task.
     */
    effect(() => {
      if (this.setupDecided || !this.bridgeAvailable || !this.store.loaded()) return;
      if (!this.store.saved().general.setupCompleted) {
        this.setupDecided = true;
        this.setupOpen.set(true);
        return;
      }
      const account = this.tasks.account();
      if (!account) return;
      const cliOk = account.cliVersion !== null && !isVersionBelow(account.cliVersion, MIN_CLI_VERSION);
      const signedIn = account.reading?.ok === true && account.reading.loggedIn;
      this.setupDecided = true;
      this.setupOpen.set(!cliOk || !signedIn);
    });

    // The store hides a toast about the task on screen, so it needs to know what is on screen.
    effect(() => this.tasks.mainVisible.set(this.view() === 'main'));
    // A notification or a link asked for a task: show the main screen.
    let lastRequest = 0;
    effect(() => {
      const request = this.tasks.showMainRequest();
      if (request !== lastRequest) {
        lastRequest = request;
        this.view.set('main');
      }
    });
    // The gear in the sidebar (SPEC.md §10) asked for Settings.
    let lastSettingsRequest = 0;
    effect(() => {
      const request = this.tasks.showSettingsRequest();
      if (request !== lastSettingsRequest) {
        lastSettingsRequest = request;
        this.view.set('settings');
      }
    });

    // Theme follows the draft, so switching it in Settings previews immediately (SPEC.md §10).
    effect(() => {
      const theme = this.store.draft().general.theme;
      const resolved = theme === 'system' ? (this.systemPrefersDark() ? 'dark' : 'light') : theme;
      document.documentElement.dataset['theme'] = resolved;
    });

    // Mirror the draft to the native layer (title bar, scrollbars, prefers-color-scheme).
    // Only once settings are loaded, so the pre-load default never overrides the saved choice.
    effect(() => {
      const theme = this.store.draft().general.theme;
      if (this.bridgeAvailable && this.store.loaded()) void api().setTheme(theme);
    });
  }

  /** `C:\…\p3-loop\noremote` — the drive and the last folders; the full path is in the tooltip. */
  protected shortPath(full: string): string {
    const parts = full.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 4) return full;
    const sep = full.includes('\\') ? '\\' : '/';
    return [parts[0], '…', ...parts.slice(-2)].join(sep);
  }

  protected stopping(tasks: readonly { title: string }[]): string {
    return stoppingText(tasks);
  }

  protected seconds(ms: number): number {
    return Math.round(ms / 1000);
  }

  protected async downloadUpdate(): Promise<void> {
    const result = await this.updates.download();
    this.updateError.set(result.ok ? null : (result.error ?? 'Could not open the release page.'));
  }

  /** Ctrl+N: New task (design). */
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.bridgeAvailable || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'n') return;
    event.preventDefault();
    this.view.set('main');
    this.tasks.newTaskOpen.set(true);
  }
}
