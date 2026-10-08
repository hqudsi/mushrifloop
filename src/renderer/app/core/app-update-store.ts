/**
 * New MushrifLoop versions (SPEC.md §11): the last answer from GitHub, and the quiet line under the title bar.
 *
 * The main process does the asking and holds the setting: an automatic check answers null while
 * "Check for new MushrifLoop versions" is off. Nothing here downloads anything; Download opens the release
 * page in the browser.
 */

import { Injectable, computed, signal } from '@angular/core';

import type { AppUpdateInfo } from '../../../shared/ipc';
import { storageKey } from '../../../shared/app-config';
import { api } from './api';

const DISMISSED_KEY = storageKey('dismissedAppVersion');
/** Once at start, then once a day while the app is open. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AppUpdateStore {
  readonly info = signal<AppUpdateInfo | null>(null);
  readonly checking = signal(false);
  private readonly dismissed = signal<string | null>(readDismissed());
  private started = false;

  /** The line shows for a newer version the user has not dismissed. */
  readonly announce = computed(() => {
    const info = this.info();
    return info?.newer === true && info.latest !== null && info.latest !== this.dismissed() ? info : null;
  });

  /** The start check and the daily one. Called once; later calls do nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.check(true);
    setInterval(() => void this.check(true), CHECK_EVERY_MS);
  }

  /** Check now: asks whatever the setting says. */
  checkNow(): Promise<void> {
    return this.check(false);
  }

  async download(): Promise<{ ok: boolean; error?: string }> {
    const info = this.info();
    if (!info) return { ok: false, error: 'No release has been read yet.' };
    return api().openExternal(info.url);
  }

  /** Hides the line for this version only; a later one shows it again. */
  dismiss(): void {
    const version = this.info()?.latest;
    if (!version) return;
    this.dismissed.set(version);
    try {
      localStorage.setItem(DISMISSED_KEY, version);
    } catch {
      /* storage unavailable: dismissed for this run only */
    }
  }

  private async check(automatic: boolean): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      const result = await api().checkAppUpdate(automatic);
      // An automatic check that failed keeps the last good answer; only Check now shows the reason.
      if (result && (!automatic || result.error === null || this.info() === null)) this.info.set(result);
    } catch (err) {
      if (!automatic) {
        const message = err instanceof Error ? err.message : String(err);
        this.info.set({ checkedAt: new Date().toISOString(), current: this.info()?.current ?? '', latest: null, newer: null, url: '', publishedAt: null, error: message });
      }
    } finally {
      this.checking.set(false);
    }
  }
}
