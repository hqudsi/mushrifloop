/**
 * Every Claude account seen on this machine (SPEC.md §10, first run).
 *
 * The CLI's credentials file is shared and can switch accounts between runs (NOTES.md §6) — a task
 * started on the wrong one bills the wrong plan. The app already pins an account per task (§3.6);
 * this is the other half: remembering that more than one has been live here, so first-run setup can
 * say so instead of leaving it to be discovered later.
 *
 * `accounts.json` is app state, not the user's data: unreadable means the list starts again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SeenAccount } from '../shared/ipc';
import type { AuthReading } from '../shared/task-model';
import { writeJsonAtomic } from './atomic-write';
import { dataFolder } from './config';
import { errorMessage, log } from './logger';
import { accountLabel } from './orchestrator/account';

export { accountLabel };

export function seenAccountsFile(): string {
  return path.join(dataFolder(), 'accounts.json');
}

export function parseSeenAccounts(text: string): SeenAccount[] {
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      const e = entry as Partial<SeenAccount>;
      if (typeof e.label !== 'string' || typeof e.firstSeen !== 'string' || typeof e.lastSeen !== 'string') return [];
      return [{
        label: e.label,
        organisation: typeof e.organisation === 'string' ? e.organisation : null,
        plan: typeof e.plan === 'string' ? e.plan : null,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      }];
    });
  } catch {
    return [];
  }
}

/** Pure: fold one reading into the list, newest last seen first. */
export function mergeSeen(list: readonly SeenAccount[], entry: SeenAccount): SeenAccount[] {
  const existing = list.find((a) => a.label === entry.label);
  const merged: SeenAccount = existing
    ? { ...entry, firstSeen: existing.firstSeen < entry.firstSeen ? existing.firstSeen : entry.firstSeen }
    : entry;
  return [merged, ...list.filter((a) => a.label !== entry.label)].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function readSeenAccounts(): SeenAccount[] {
  try {
    return parseSeenAccounts(fs.readFileSync(seenAccountsFile(), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('seen_accounts.unreadable', { file: seenAccountsFile(), error: errorMessage(err) });
    }
    return [];
  }
}

/**
 * Record the account a live reading found. Returns the whole list, so the caller can hand it to the
 * UI in the same message. A failed or signed-out reading changes nothing.
 *
 * `planUncertain` is the mid-switch guard of SPEC.md §10: the account is recorded, the plan is not.
 * This file never asserts a plan the app does not trust.
 */
export function recordAccount(reading: AuthReading | null, at: string, planUncertain = false): SeenAccount[] {
  const label = accountLabel(reading);
  const list = readSeenAccounts();
  if (label === null || !reading?.ok || !reading.loggedIn) return list;

  const entry: SeenAccount = {
    label,
    organisation: reading.account.orgName ?? null,
    plan: planUncertain ? null : (reading.account.subscriptionType ?? null),
    firstSeen: at,
    lastSeen: at,
  };
  const next = mergeSeen(list, entry);
  const unchanged =
    list.length === next.length &&
    list.every((a, i) => {
      const b = next[i];
      return !!b && a.label === b.label && a.organisation === b.organisation && a.plan === b.plan;
    });
  // Only the timestamp moved, and that is not worth a write on every refresh.
  if (unchanged && list[0]?.label === label && sameMinute(list[0].lastSeen, at)) return list;

  try {
    writeJsonAtomic(seenAccountsFile(), next);
    if (list.length > 0 && !list.some((a) => a.label === label)) {
      log.warn('seen_accounts.another_account', { label, previously: list.map((a) => a.label) });
    }
  } catch (err) {
    log.warn('seen_accounts.save_failed', { file: seenAccountsFile(), error: errorMessage(err) });
  }
  return next;
}

function sameMinute(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16);
}
