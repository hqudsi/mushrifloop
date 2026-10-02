/**
 * Account pinning (SPEC.md §3.6) — pure parsing and comparison.
 */

import type { AccountRecord, AuthReading, PinnedAccount } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Parse `claude auth status --json`. Tolerant of unknown fields (SPEC.md §3.2). */
export function readingFromAuthOutput(run: {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnError?: string;
  timedOut?: boolean;
}): AuthReading {
  if (run.spawnError) return { ok: false, error: `Could not run \`claude auth status\`: ${run.spawnError}` };
  if (run.timedOut) return { ok: false, error: '`claude auth status` did not answer in time.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    const raw = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n');
    return { ok: false, error: `\`claude auth status --json\` (exit ${run.code ?? 'none'}) did not return JSON: ${raw || '(no output)'}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: '`claude auth status --json` returned an unexpected value.' };
  return {
    ok: true,
    loggedIn: parsed['loggedIn'] === true,
    account: {
      email: str(parsed['email']),
      orgId: str(parsed['orgId']),
      orgName: str(parsed['orgName']),
      subscriptionType: str(parsed['subscriptionType']),
      authMethod: str(parsed['authMethod']),
      apiKeySource: str(parsed['apiKeySource']),
    },
  };
}

export class AccountPinError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'AccountPinError';
  }
}

/** Rule 1: the account a new task is pinned to. Throws when there is none to pin. */
export function pinAccount(reading: AuthReading, at: Date): PinnedAccount {
  if (!reading.ok) throw new AccountPinError(reading.error, 'Check that Claude Code works, then run `claude auth login`.');
  if (!reading.loggedIn) {
    throw new AccountPinError('Claude Code is not logged in (`loggedIn: false`).', 'Run `claude auth login`, then create the task again.');
  }
  return { ...reading.account, pinnedAt: at.toISOString() };
}

export interface AccountComparison {
  match: boolean;
  /** Why not, in words; null on a match. */
  reason: string | null;
}

const sameText = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** Rule 3: email and organization (orgId when both have one, else orgName); apiKeySource for API-key billing. */
export function compareAccount(pinned: AccountRecord, live: AuthReading): AccountComparison {
  if (!live.ok) return { match: false, reason: `The live account could not be read: ${live.error}` };
  if (!live.loggedIn) return { match: false, reason: 'Claude Code is not logged in.' };
  const now = live.account;
  if (pinned.email === null) {
    if (pinned.apiKeySource !== null && pinned.apiKeySource === now.apiKeySource && now.email === null) {
      return { match: true, reason: null };
    }
    return { match: false, reason: `Pinned to API-key billing (${pinned.apiKeySource ?? 'unknown source'}); live is ${describeAccount(now)}.` };
  }
  if (!sameText(pinned.email, now.email)) {
    return { match: false, reason: `Email differs: pinned ${pinned.email}, live ${now.email ?? '(none)'}.` };
  }
  const orgMatches =
    pinned.orgId !== null && now.orgId !== null ? pinned.orgId === now.orgId : sameText(pinned.orgName, now.orgName);
  if (!orgMatches) {
    return { match: false, reason: `Organization differs: pinned ${pinned.orgName ?? pinned.orgId ?? '(none)'}, live ${now.orgName ?? now.orgId ?? '(none)'}.` };
  }
  return { match: true, reason: null };
}

/** `email · org · plan`, for display. */
export function describeAccount(account: AccountRecord): string {
  if (account.email === null && account.apiKeySource !== null) return `API key (${account.apiKeySource})`;
  return [account.email ?? '(no email)', account.orgName ?? '-', account.subscriptionType ?? '-'].join(' · ');
}

/** How an account reading is named: the e-mail, or the API key's source. Null when there is none. */
export function accountLabel(reading: AuthReading | null): string | null {
  if (!reading?.ok || !reading.loggedIn) return null;
  if (reading.account.email) return reading.account.email;
  return reading.account.apiKeySource ? `API key (${reading.account.apiKeySource})` : null;
}

export interface SettledAuth {
  reading: AuthReading;
  /**
   * The account changed between readings and the plan could not be confirmed, so it must be shown as
   * unknown rather than as a number (SPEC.md §10).
   */
  planUncertain: boolean;
}

/**
 * The mid-switch guard (SPEC.md §10, NOTES.md §35).
 *
 * `claude auth status --json` assembles its answer from two files of its own — the e-mail and
 * organisation from one, the plan from another — and a sign-in writes them at different moments. In
 * that window the CLI reports the **new** account with the **old** plan, which is how the indicator
 * once showed a Team account as `max`. We do not read the CLI's files to find out (they are its
 * internals and would break on any update); we use the only signal that is ours: the account changed.
 *
 * So when the live label differs from `previousLabel`, read once more a few seconds later. If the two
 * readings disagree about the plan, or the second has moved on to yet another account, the plan is
 * unconfirmed. Everything else is a single reading, unchanged.
 *
 * Known limit: both files can stay out of step for minutes, so a plan that is stale in *both*
 * readings still passes. This catches the switch, not every stale window.
 */
export async function readAuthSettled(
  read: () => Promise<AuthReading>,
  previousLabel: string | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settleDelayMs = 3_000,
): Promise<SettledAuth> {
  const first = await read();
  const label = accountLabel(first);
  // Nothing to compare against (first reading of the session), no account at all, or the same one.
  if (label === null || previousLabel === null || label === previousLabel) return { reading: first, planUncertain: false };

  await wait(settleDelayMs);
  const second = await read();
  const secondLabel = accountLabel(second);
  if (secondLabel === null) return { reading: first, planUncertain: true };
  if (secondLabel !== label) return { reading: second, planUncertain: true };

  const planOf = (r: AuthReading) => (r.ok && r.loggedIn ? r.account.subscriptionType : null);
  return { reading: second, planUncertain: planOf(first) !== planOf(second) };
}

/**
 * Read the live account, trying once more when it could not be read at all. `claude auth status` was
 * seen to crash once (exit 0xC0000409, no output) in ~75 otherwise clean calls (NOTES.md §16.6); one
 * transient crash should not stop a running task. A readable answer — including "logged out" or a
 * different account — is never retried, and a second failure is still "not a match" (§3.6 rule 3).
 */
export async function readAuthWithRetry(
  read: () => Promise<AuthReading>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelayMs = 500,
): Promise<AuthReading> {
  const first = await read();
  if (first.ok) return first;
  await wait(retryDelayMs);
  const second = await read();
  if (second.ok) return second;
  return { ok: false, error: `${second.error} (the first attempt failed too: ${first.error})` };
}
