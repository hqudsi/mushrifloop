/**
 * What a Video task shows while it is being set up (SPEC.md §21.3):
 *
 * - `app-video-consent`: the task is waiting because it has to download its tools. A dialog says what, how
 *   large and into which folder, for the path actually taken. Nothing is downloaded until the human agrees.
 * - `app-video-setup-log`: the app is running the kit's own commands (npm ci, doctor). Their output is shown
 *   as it arrives, with a Cancel button.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';

import { APP_NAME } from '../../../../shared/app-config';
import type { TaskRecord } from '../../../../shared/task-model';
import { planSizes } from '../../../../shared/video';
import { TasksStore } from '../../core/tasks-store';

@Component({
  selector: 'app-video-consent',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    @if (waiting(); as w) {
      <div class="panel wait">
        <div class="title">Download the video tools?</div>
        <p>This Video task needs tools that are not in the project yet, about {{ sizes().diskMb }} MB. Nothing is downloaded until you agree.</p>
        <div class="actions">
          <button type="button" class="btn btn-accent" (click)="open.set(true)">Review and download…</button>
          <button type="button" class="btn" [disabled]="!!store.pendingAction()" (click)="cancel()">Cancel the task</button>
        </div>
      </div>

      @if (open()) {
        <div class="backdrop" (mousedown)="$event.target === $event.currentTarget && open.set(false)">
          <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="vc-title" aria-describedby="vc-body">
            <div class="top">
              <span id="vc-title" class="dialog-title">Download the video tools?</span>
              <button type="button" class="close" aria-label="Close" (click)="open.set(false)">✕</button>
            </div>
            <div class="body" id="vc-body">
              <div class="block">
                <div class="k">What is downloaded</div>
                <ul>
                  @for (line of sizes().lines; track line) {
                    <li>{{ line }}</li>
                  }
                </ul>
              </div>
              <div class="block">
                <div class="k">How large</div>
                <div>About {{ sizes().diskMb }} MB on disk in all.</div>
              </div>
              <div class="block">
                <div class="k">Into which folder</div>
                <div class="mono">{{ w.folder }}</div>
                <div class="small">Everything stays inside this folder's <span class="mono">node_modules</span>. Delete that folder to remove it all.</div>
              </div>
              @if (w.plan.ffmpeg) {
                <div class="small">
                  ffmpeg-static is a build of ffmpeg under the GNU General Public License, version 3. npm downloads it into the folder above;
                  it is not part of {{ appName }}.
                </div>
              }
              <div class="small">{{ appName }} itself requests nothing from the network here: npm, and the tools' own installers, make these downloads.</div>
            </div>
            <div class="foot">
              <button type="button" class="btn" [disabled]="!!store.pendingAction()" (click)="cancel()">Cancel</button>
              <button type="button" class="btn btn-accent" [disabled]="!!store.pendingAction()" (click)="agree()">Download and continue</button>
            </div>
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
      .panel {
        border: 1px solid var(--waiting);
        box-shadow: 0 0 0 3px var(--waiting-bg);
        border-radius: 6px;
        background: var(--bg-tl-card);
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        line-height: 1.5;
        color: var(--text-2);
      }
      .title {
        font-weight: 600;
        font-size: 13.5px;
        color: var(--waiting);
      }
      p {
        margin: 0;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 50;
        background: rgba(0, 0, 0, 0.55);
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .dialog {
        width: 560px;
        max-width: 100%;
        background: var(--bg-chrome);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border);
      }
      .dialog-title {
        font-size: 14px;
        font-weight: 600;
      }
      .close {
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 13px;
      }
      .body {
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        color: var(--text-2);
        line-height: 1.5;
      }
      .k {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-3);
        margin-bottom: 4px;
      }
      ul {
        margin: 0;
        padding-inline-start: 18px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .mono {
        font-family: var(--font-mono);
        font-size: 11.5px;
        word-break: break-all;
      }
      .small {
        font-size: 12px;
        color: var(--text-3);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--border);
      }
    `,
  ],
})
export class VideoConsent {
  protected readonly store = inject(TasksStore);
  protected readonly appName = APP_NAME;
  readonly task = input.required<TaskRecord>();
  /** The dialog opens by itself; closing it leaves the card, from where it opens again. */
  protected readonly open = signal(true);

  protected readonly waiting = computed(() => {
    const w = this.task().waiting;
    return w?.kind === 'install_consent' ? w : null;
  });
  protected readonly sizes = computed(() => planSizes(this.waiting()?.plan ?? { packages: false, ffmpeg: false, chromium: false }));

  protected agree(): void {
    void this.store.act({ kind: 'consent_install' });
  }

  /** Cancel leaves the task stopped; Resume asks again (SPEC.md §21.3). */
  protected cancel(): void {
    this.open.set(false);
    void this.store.act({ kind: 'stop' });
  }
}

const STEP_LABEL = { install: 'Installing packages (npm ci)', tools: 'Installing the video tools', doctor: 'Checking that this computer can render' } as const;

@Component({
  selector: 'app-video-setup-log',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (running()) {
      <div class="panel">
        <div class="head">
          <span class="title">Setting up the video tools</span>
          <span class="step">{{ stepLabel() }}</span>
        </div>
        <pre #log class="log" tabindex="0" aria-label="Setup output">{{ text() }}</pre>
        <div class="actions">
          <button type="button" class="btn" [disabled]="!!store.pendingAction()" (click)="cancel()">Cancel</button>
          <span class="hint">Cancel stops the task; Resume continues the setup. The whole output is kept with the task.</span>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .panel {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-tl-card);
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: var(--text-2);
      }
      .head {
        display: flex;
        gap: 10px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .title {
        font-weight: 600;
        font-size: 13.5px;
        color: var(--text);
      }
      .step {
        font-size: 12px;
        color: var(--text-3);
      }
      .log {
        margin: 0;
        max-height: 220px;
        min-height: 60px;
        overflow: auto;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        font-family: var(--font-mono);
        font-size: 11.5px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        direction: ltr;
        text-align: left;
      }
      .actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .hint {
        font-size: 12px;
        color: var(--text-3);
      }
    `,
  ],
})
export class VideoSetupLog {
  protected readonly store = inject(TasksStore);
  readonly task = input.required<TaskRecord>();
  private readonly logBox = viewChild<ElementRef<HTMLElement>>('log');

  /** The app is running the task's video setup right now. */
  protected readonly running = computed(() => {
    const t = this.task();
    return t.kind === 'video' && t.status === 'running' && t.video !== undefined && !t.video.setup.done;
  });
  private readonly entry = computed(() => {
    const log = this.store.setupLog();
    return log && log.taskId === this.task().id ? log : null;
  });
  protected readonly text = computed(() => this.entry()?.text ?? 'Starting…');
  protected readonly stepLabel = computed(() => {
    const step = this.entry()?.step;
    return step ? STEP_LABEL[step] : '';
  });

  constructor() {
    // Follow the output as it arrives.
    effect(() => {
      this.text();
      const box = this.logBox()?.nativeElement;
      if (box) queueMicrotask(() => (box.scrollTop = box.scrollHeight));
    });
  }

  protected cancel(): void {
    void this.store.act({ kind: 'stop' });
  }
}
