/**
 * Renderer-side settings state.
 *
 * Holds a draft the UI edits freely, plus the last saved copy so "dirty" and "revert" are honest.
 * All persistence goes through the IPC bridge; the renderer never touches the file.
 */

import { Injectable, computed, signal } from '@angular/core';

import type { AppInfo } from '../../../shared/ipc';
import { applyDefaultChanges, defaultSettings, type DefaultChangeField, type Settings } from '../../../shared/settings';
import { api } from './api';

function clone(settings: Settings): Settings {
  return structuredClone(settings);
}

@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly savedState = signal<Settings>(defaultSettings());

  readonly draft = signal<Settings>(defaultSettings());
  readonly appInfo = signal<AppInfo | null>(null);
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly savedAt = signal<Date | null>(null);

  readonly saved = this.savedState.asReadonly();
  readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.savedState()));

  async load(): Promise<void> {
    try {
      const [settings, info] = await Promise.all([api().getSettings(), api().getAppInfo()]);
      this.savedState.set(settings);
      this.draft.set(clone(settings));
      this.appInfo.set(info);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loaded.set(true);
    }
  }

  /** Apply a change to the draft. */
  update(mutate: (draft: Settings) => void): void {
    const next = clone(this.draft());
    mutate(next);
    this.draft.set(next);
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      // The main process returns what it actually stored (values are coerced on the way in),
      // so adopt that rather than assuming the draft was accepted verbatim.
      const result = await api().saveSettings(this.draft());
      if (!result.ok) {
        this.error.set(result.error);
        return;
      }
      this.savedState.set(result.settings);
      this.draft.set(clone(result.settings));
      this.savedAt.set(new Date());
      // A save replaces an unreadable settings.json, so the startup warning no longer applies.
      this.appInfo.set(await api().getAppInfo());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  revert(): void {
    this.draft.set(clone(this.savedState()));
    this.error.set(null);
  }

  /**
   * "Defaults after an update" (SPEC.md §11): apply the chosen changes to the saved settings, mark them
   * reconciled with this release, and save. Unsaved edits in the Settings form stay, with the same changes
   * applied to them. Returns an error message, or null.
   */
  async reconcileDefaults(fields: readonly DefaultChangeField[]): Promise<string | null> {
    const wasDirty = this.dirty();
    try {
      const result = await api().saveSettings(applyDefaultChanges(this.savedState(), fields));
      if (!result.ok) return result.error;
      this.savedState.set(result.settings);
      this.draft.set(wasDirty ? applyDefaultChanges(this.draft(), fields) : clone(result.settings));
      this.savedAt.set(new Date());
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
