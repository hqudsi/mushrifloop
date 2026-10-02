import { describe, expect, it } from 'vitest';

import { AccountPinError, compareAccount, describeAccount, pinAccount, readAuthSettled, readAuthWithRetry, readingFromAuthOutput } from './account';
import type { AccountRecord, AuthReading } from './types';

const MAX_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'owner@example.com',
  orgId: 'org-1',
  orgName: "owner@example.com's Organization",
  subscriptionType: 'max',
  analyticsDisabled: false,
  projectsDirectory: 'C:\\x',
});

const pinned: AccountRecord = {
  email: 'owner@example.com',
  orgId: 'org-1',
  orgName: "owner@example.com's Organization",
  subscriptionType: 'max',
  authMethod: 'claude.ai',
  apiKeySource: null,
};

const live = (patch: Partial<AccountRecord>, loggedIn = true): AuthReading => ({ ok: true, loggedIn, account: { ...pinned, ...patch } });

describe('readingFromAuthOutput', () => {
  it('parses `claude auth status --json`, ignoring unknown fields', () => {
    expect(readingFromAuthOutput({ stdout: MAX_JSON, stderr: '', code: 0 })).toEqual({ ok: true, loggedIn: true, account: pinned });
  });

  it('reports spawn failures, timeouts and non-JSON output as unreadable, with the raw text', () => {
    expect(readingFromAuthOutput({ stdout: '', stderr: '', code: null, spawnError: 'ENOENT' })).toEqual({ ok: false, error: expect.stringContaining('ENOENT') });
    expect(readingFromAuthOutput({ stdout: '', stderr: '', code: null, timedOut: true })).toMatchObject({ ok: false });
    const bad = readingFromAuthOutput({ stdout: 'Not logged in', stderr: 'oops', code: 1 });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('Not logged in\noops') });
    expect(readingFromAuthOutput({ stdout: '[1]', stderr: '', code: 0 })).toMatchObject({ ok: false });
  });

  it('treats a missing or false loggedIn as logged out', () => {
    const r = readingFromAuthOutput({ stdout: '{"loggedIn":false}', stderr: '', code: 0 });
    expect(r).toMatchObject({ ok: true, loggedIn: false, account: { email: null } });
  });
});

describe('pinAccount (rule 1)', () => {
  it('pins a logged-in account with a timestamp', () => {
    expect(pinAccount(live({}), new Date('2026-09-16T10:00:00Z'))).toEqual({ ...pinned, pinnedAt: '2026-09-16T10:00:00.000Z' });
  });

  it('refuses when logged out or unreadable, with a next step', () => {
    expect(() => pinAccount(live({}, false), new Date())).toThrow(AccountPinError);
    try {
      pinAccount({ ok: false, error: 'boom' }, new Date());
    } catch (err) {
      expect((err as AccountPinError).nextStep).toContain('claude auth login');
      expect((err as Error).message).toBe('boom');
    }
  });
});

describe('compareAccount (rule 3)', () => {
  it('matches on email and orgId', () => {
    expect(compareAccount(pinned, live({ subscriptionType: 'team', orgName: 'renamed' }))).toEqual({ match: true, reason: null });
    expect(compareAccount(pinned, live({ email: 'OWNER@example.com' })).match).toBe(true);
  });

  it('a different email or orgId is a mismatch', () => {
    expect(compareAccount(pinned, live({ email: 'work@example.com' }))).toEqual({ match: false, reason: expect.stringContaining('Email differs') });
    expect(compareAccount(pinned, live({ orgId: 'org-2' }))).toEqual({ match: false, reason: expect.stringContaining('Organization differs') });
  });

  it('falls back to orgName when either side lacks an orgId', () => {
    const noId = { ...pinned, orgId: null };
    expect(compareAccount(noId, live({ orgId: 'org-9' })).match).toBe(true);
    expect(compareAccount(noId, live({ orgId: 'org-9', orgName: 'Other' })).match).toBe(false);
    expect(compareAccount(pinned, live({ orgId: null })).match).toBe(true);
    expect(compareAccount({ ...pinned, orgId: null, orgName: null }, live({ orgId: null, orgName: null })).match).toBe(false);
  });

  it('unreadable or logged out is never a match', () => {
    expect(compareAccount(pinned, { ok: false, error: 'x' })).toEqual({ match: false, reason: expect.stringContaining('could not be read: x') });
    expect(compareAccount(pinned, live({}, false)).match).toBe(false);
  });

  it('API-key billing compares apiKeySource', () => {
    const keyPinned: AccountRecord = { email: null, orgId: null, orgName: null, subscriptionType: null, authMethod: null, apiKeySource: 'ANTHROPIC_API_KEY' };
    const keyLive: AuthReading = { ok: true, loggedIn: true, account: keyPinned };
    expect(compareAccount(keyPinned, keyLive).match).toBe(true);
    expect(compareAccount(keyPinned, live({})).match).toBe(false);
    expect(compareAccount(keyPinned, { ok: true, loggedIn: true, account: { ...keyPinned, apiKeySource: 'apiKeyHelper' } }).match).toBe(false);
  });
});

describe('describeAccount', () => {
  it('formats email · org · plan', () => {
    expect(describeAccount(pinned)).toBe("owner@example.com · owner@example.com's Organization · max");
    expect(describeAccount({ ...pinned, email: null, apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('API key (ANTHROPIC_API_KEY)');
  });
});

describe('readAuthWithRetry', () => {
  const noWait = async () => {};
  it('retries once when the status could not be read', async () => {
    const answers: AuthReading[] = [{ ok: false, error: 'exit 3221226505' }, live({})];
    let calls = 0;
    const r = await readAuthWithRetry(async () => answers[calls++]!, noWait);
    expect(r).toEqual(live({}));
    expect(calls).toBe(2);
  });

  it('never retries a readable answer, even logged out or another account', async () => {
    for (const answer of [live({}, false), live({ email: 'x@example.com' })]) {
      let calls = 0;
      const r = await readAuthWithRetry(async () => {
        calls += 1;
        return answer;
      }, noWait);
      expect(r).toBe(answer);
      expect(calls).toBe(1);
    }
  });

  it('reports both errors when the second attempt fails too', async () => {
    let calls = 0;
    const r = await readAuthWithRetry(async () => ({ ok: false, error: `boom ${++calls}` }), noWait);
    expect(r).toEqual({ ok: false, error: 'boom 2 (the first attempt failed too: boom 1)' });
  });
});

/**
 * The mid-switch guard (SPEC.md §10). The CLI builds its answer from two files of its own and writes
 * them at different moments, so just after a sign-in it reports the new account with the old plan.
 * The only signal the app has — and the only one it is allowed — is that the account changed.
 */
describe('readAuthSettled (the mid-switch guard)', () => {
  const noWait = async () => {};
  const reader = (answers: AuthReading[]) => {
    const calls: number[] = [];
    let i = 0;
    return {
      read: async () => {
        calls.push(++i);
        return answers[Math.min(i - 1, answers.length - 1)]!;
      },
      get calls() {
        return calls.length;
      },
    };
  };

  it('reads once and trusts the plan when the account did not change', async () => {
    const r = reader([live({})]);
    expect(await readAuthSettled(r.read, 'owner@example.com', noWait)).toEqual({ reading: live({}), planUncertain: false });
    expect(r.calls).toBe(1);
  });

  it('reads once on the first reading of a session, when there is nothing to compare against', async () => {
    const r = reader([live({ email: 'other@example.com' })]);
    const settled = await readAuthSettled(r.read, null, noWait);
    expect(settled).toMatchObject({ planUncertain: false });
    expect(r.calls).toBe(1);
  });

  it('reads again when the account changed, and trusts a plan both readings agree on', async () => {
    const team = live({ email: 'work@example.com', orgName: 'Acme', subscriptionType: 'team' });
    const r = reader([team, team]);
    const settled = await readAuthSettled(r.read, 'owner@example.com', noWait);
    expect(settled).toEqual({ reading: team, planUncertain: false });
    expect(r.calls).toBe(2);
  });

  it('will not name a plan the two readings disagree about — the incident of 2026-09-20', async () => {
    // What the CLI actually did: the new e-mail with the previous account's plan, then the real one.
    const stale = live({ email: 'work@example.com', orgName: 'Acme', subscriptionType: 'max' });
    const settledReading = live({ email: 'work@example.com', orgName: 'Acme', subscriptionType: 'team' });
    const r = reader([stale, settledReading]);
    const settled = await readAuthSettled(r.read, 'owner@example.com', noWait);
    expect(settled.planUncertain).toBe(true);
    // The second reading is the newer one, so that is the one to keep; only its plan is not shown.
    expect(settled.reading).toEqual(settledReading);
  });

  it('will not name a plan when the second reading has moved on to a third account', async () => {
    const r = reader([live({ email: 'work@example.com' }), live({ email: 'third@example.com' })]);
    const settled = await readAuthSettled(r.read, 'owner@example.com', noWait);
    expect(settled).toEqual({ reading: live({ email: 'third@example.com' }), planUncertain: true });
  });

  it('will not name a plan when the second reading cannot be read or is logged out', async () => {
    for (const second of [{ ok: false, error: 'exit 3221226505' } as AuthReading, live({ email: 'work@example.com' }, false)]) {
      const first = live({ email: 'work@example.com' });
      const r = reader([first, second]);
      const settled = await readAuthSettled(r.read, 'owner@example.com', noWait);
      expect(settled).toEqual({ reading: first, planUncertain: true });
    }
  });

  it('does not re-read a failed or signed-out reading: there is no account to have changed', async () => {
    for (const answer of [{ ok: false, error: 'boom' } as AuthReading, live({}, false)]) {
      const r = reader([answer]);
      const settled = await readAuthSettled(r.read, 'owner@example.com', noWait);
      expect(settled).toEqual({ reading: answer, planUncertain: false });
      expect(r.calls).toBe(1);
    }
  });

  it('waits between the two readings, and only then', async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    await readAuthSettled(async () => live({}), 'owner@example.com', wait, 3_000);
    expect(waits).toEqual([]);
    await readAuthSettled(async () => live({ email: 'work@example.com' }), 'owner@example.com', wait, 3_000);
    expect(waits).toEqual([3_000]);
  });

  it('treats an API key the same way: its source is the label', async () => {
    const key = live({ email: null, apiKeySource: 'ANTHROPIC_API_KEY' });
    const r = reader([key]);
    expect(await readAuthSettled(r.read, 'API key (ANTHROPIC_API_KEY)', noWait)).toEqual({ reading: key, planUncertain: false });
    expect(r.calls).toBe(1);
  });
});
