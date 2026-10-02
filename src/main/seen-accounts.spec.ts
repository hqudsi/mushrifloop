/**
 * Remembering which Claude accounts have been live on this machine (SPEC.md §10, first run).
 * The shared credentials file switches accounts between runs (NOTES.md §6), and setup has to be
 * able to say so.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import type { AuthReading } from '../shared/task-model';
import { initDataFolder } from './config';
import { accountLabel, mergeSeen, parseSeenAccounts, readSeenAccounts, recordAccount, seenAccountsFile } from './seen-accounts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-accounts-'));
initDataFolder(ROOT);

function reading(patch: Partial<{ email: string | null; orgName: string | null; plan: string | null; apiKeySource: string | null }> = {}): AuthReading {
  return {
    ok: true,
    loggedIn: true,
    account: {
      email: patch.email === undefined ? 'personal@example.com' : patch.email,
      orgId: null,
      orgName: patch.orgName ?? null,
      subscriptionType: patch.plan ?? 'max',
      authMethod: 'oauth',
      apiKeySource: patch.apiKeySource ?? null,
    },
  };
}

beforeEach(() => {
  fs.rmSync(seenAccountsFile(), { force: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('accountLabel', () => {
  it('is the e-mail, the API key source, or nothing at all', () => {
    expect(accountLabel(reading())).toBe('personal@example.com');
    expect(accountLabel(reading({ email: null, apiKeySource: 'ANTHROPIC_API_KEY' }))).toBe('API key (ANTHROPIC_API_KEY)');
    expect(accountLabel(reading({ email: null }))).toBeNull();
    expect(accountLabel({ ok: false, error: 'the CLI failed' })).toBeNull();
    expect(accountLabel(null)).toBeNull();
  });
});

describe('recordAccount', () => {
  it('records the first account, and keeps both when a second one appears', () => {
    const first = recordAccount(reading(), '2026-09-19T10:00:00.000Z');
    expect(first).toEqual([
      { label: 'personal@example.com', organisation: null, plan: 'max', firstSeen: '2026-09-19T10:00:00.000Z', lastSeen: '2026-09-19T10:00:00.000Z' },
    ]);

    const both = recordAccount(reading({ email: 'work@example.com', orgName: 'Acme' }), '2026-09-19T11:00:00.000Z');
    expect(both.map((a) => a.label)).toEqual(['work@example.com', 'personal@example.com']);
    expect(both[0]?.organisation).toBe('Acme');
    // Written, so the next start still knows.
    expect(readSeenAccounts().map((a) => a.label)).toEqual(['work@example.com', 'personal@example.com']);
  });

  it('keeps the first sighting when the same account comes back', () => {
    recordAccount(reading(), '2026-09-19T10:00:00.000Z');
    const again = recordAccount(reading({ plan: 'pro' }), '2026-09-20T09:00:00.000Z');
    expect(again).toEqual([
      { label: 'personal@example.com', organisation: null, plan: 'pro', firstSeen: '2026-09-19T10:00:00.000Z', lastSeen: '2026-09-20T09:00:00.000Z' },
    ]);
  });

  it('changes nothing when the reading failed or nobody is signed in', () => {
    recordAccount(reading(), '2026-09-19T10:00:00.000Z');
    expect(recordAccount({ ok: false, error: 'not found' }, '2026-09-19T12:00:00.000Z').map((a) => a.label)).toEqual(['personal@example.com']);
    const signedOut: AuthReading = { ok: true, loggedIn: false, account: { email: null, orgId: null, orgName: null, subscriptionType: null, authMethod: null, apiKeySource: null } };
    expect(recordAccount(signedOut, '2026-09-19T12:00:00.000Z').map((a) => a.label)).toEqual(['personal@example.com']);
  });

  it('records the account but not a plan it does not trust (SPEC.md §10, the mid-switch guard)', () => {
    recordAccount(reading(), '2026-09-19T10:00:00.000Z');
    const midSwitch = recordAccount(reading({ email: 'work@example.com', orgName: 'Acme', plan: 'max' }), '2026-09-20T09:00:00.000Z', true);
    expect(midSwitch[0]).toEqual({
      label: 'work@example.com',
      organisation: 'Acme',
      plan: null,
      firstSeen: '2026-09-20T09:00:00.000Z',
      lastSeen: '2026-09-20T09:00:00.000Z',
    });
    // And the real plan lands as soon as a settled reading arrives.
    const settled = recordAccount(reading({ email: 'work@example.com', orgName: 'Acme', plan: 'team' }), '2026-09-20T09:01:00.000Z');
    expect(settled[0]).toMatchObject({ label: 'work@example.com', plan: 'team', firstSeen: '2026-09-20T09:00:00.000Z' });
  });

  it('survives a corrupt file instead of failing the account check', () => {
    fs.writeFileSync(seenAccountsFile(), '{ not an array', 'utf8');
    expect(readSeenAccounts()).toEqual([]);
    expect(recordAccount(reading(), '2026-09-19T10:00:00.000Z').map((a) => a.label)).toEqual(['personal@example.com']);
  });
});

describe('parsing and merging', () => {
  it('drops entries that are not accounts', () => {
    const text = JSON.stringify([
      { label: 'a@example.com', organisation: null, plan: 'max', firstSeen: 'x', lastSeen: 'y' },
      { label: 42 },
      'nonsense',
    ]);
    expect(parseSeenAccounts(text).map((a) => a.label)).toEqual(['a@example.com']);
    expect(parseSeenAccounts('nope')).toEqual([]);
  });

  it('sorts by when each was last seen', () => {
    const older = { label: 'a', organisation: null, plan: null, firstSeen: '2026-01-01', lastSeen: '2026-01-01' };
    const newer = { label: 'b', organisation: null, plan: null, firstSeen: '2026-02-01', lastSeen: '2026-02-01' };
    expect(mergeSeen([older], newer).map((a) => a.label)).toEqual(['b', 'a']);
    expect(mergeSeen([newer], older).map((a) => a.label)).toEqual(['b', 'a']);
  });
});
