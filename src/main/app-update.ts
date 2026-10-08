/**
 * "New MushrifLoop versions" (SPEC.md §11, decided 2026-10-08): is a newer release of the app published?
 *
 * This is about the app itself, never about Claude Code (that is claude-update.ts). It only asks; nothing is
 * downloaded or installed, and the user installs a new version from the release page.
 *
 * - The newest version is the public repository's latest release on GitHub, which skips drafts and
 *   pre-releases. Its tag (`v1.6.0`) is compared with the app's own version.
 * - The page the app may open is the release's own page, and only when it is one of the repository's
 *   release pages; anything else falls back to `releases/latest`.
 */

import { APP_NAME, APP_REPO_URL } from '../shared/app-config';
import type { AppUpdateInfo } from '../shared/ipc';
import { compareVersions } from '../shared/models';

/** `https://github.com/<owner>/<repo>` → the API's latest-release address for that repository. */
export const LATEST_RELEASE_API = APP_REPO_URL.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest';
/** Where Download goes when the release's own page cannot be used. */
export const RELEASES_LATEST_URL = `${APP_REPO_URL}/releases/latest`;

const RELEASE_TIMEOUT_MS = 20_000;
const VERSION = /^v?(\d+\.\d+\.\d+)$/;

export interface AppUpdateDeps {
  /** The running app's version (`app.getVersion()`). */
  current: string;
  fetchLatestRelease: () => Promise<unknown>;
  now: () => Date;
}

/** What the release answer says, or why it cannot be used. Pure; nothing here throws. */
export function readRelease(body: unknown): { version: string; url: string; publishedAt: string | null } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'GitHub answered with something that is not a release.' };
  const release = body as Record<string, unknown>;
  const tag = typeof release['tag_name'] === 'string' ? release['tag_name'].trim() : '';
  const match = VERSION.exec(tag);
  if (!match?.[1]) return { error: `The latest release's tag (${tag || 'none'}) is not a version number.` };
  const page = release['html_url'];
  const url = typeof page === 'string' && page.startsWith(`${APP_REPO_URL}/releases/`) && !/\s/.test(page) ? page : RELEASES_LATEST_URL;
  const published = release['published_at'];
  return { version: match[1], url, publishedAt: typeof published === 'string' ? published : null };
}

export async function checkAppUpdate(deps: AppUpdateDeps): Promise<AppUpdateInfo> {
  const checkedAt = deps.now().toISOString();
  const base = { checkedAt, current: deps.current, latest: null, newer: null, url: RELEASES_LATEST_URL, publishedAt: null };
  let body: unknown;
  try {
    body = await deps.fetchLatestRelease();
  } catch (err) {
    return { ...base, error: `Could not ask GitHub for the latest release: ${err instanceof Error ? err.message : String(err)}` };
  }
  const release = readRelease(body);
  if ('error' in release) return { ...base, error: release.error };
  return {
    checkedAt,
    current: deps.current,
    latest: release.version,
    newer: compareVersions(release.version, deps.current) > 0,
    url: release.url,
    publishedAt: release.publishedAt,
    error: null,
  };
}

/** GET the latest release with a timeout. Uses the runtime's own `fetch`: no dependency. */
export async function fetchLatestRelease(current: string, url = LATEST_RELEASE_API): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    headers: { accept: 'application/vnd.github+json', 'user-agent': `${APP_NAME}/${current}` },
  });
  if (response.status === 404) throw new Error('the repository has no published release');
  if (response.status === 403 || response.status === 429) throw new Error(`GitHub is limiting requests (HTTP ${response.status}); try again later`);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}
