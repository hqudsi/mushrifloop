import { describe, expect, it } from 'vitest';

import { APP_REPO_URL } from '../shared/app-config';
import { LATEST_RELEASE_API, RELEASES_LATEST_URL, checkAppUpdate, readRelease } from './app-update';

const now = () => new Date('2026-10-08T10:00:00Z');
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.6.0',
  html_url: `${APP_REPO_URL}/releases/tag/v1.6.0`,
  published_at: '2026-10-09T08:00:00Z',
  ...over,
});

describe('app update check (SPEC.md §11)', () => {
  it('asks the public repository for its latest release', () => {
    expect(LATEST_RELEASE_API).toBe('https://api.github.com/repos/hqudsi/mushrifloop/releases/latest');
    expect(RELEASES_LATEST_URL).toBe(`${APP_REPO_URL}/releases/latest`);
  });

  it('says a newer release is available, with its own page', async () => {
    const info = await checkAppUpdate({ current: '1.5.0', fetchLatestRelease: async () => release(), now });
    expect(info).toEqual({
      checkedAt: '2026-10-08T10:00:00.000Z',
      current: '1.5.0',
      latest: '1.6.0',
      newer: true,
      url: `${APP_REPO_URL}/releases/tag/v1.6.0`,
      publishedAt: '2026-10-09T08:00:00Z',
      error: null,
    });
  });

  it('says nothing is newer for the same or an older release', async () => {
    for (const tag of ['v1.5.0', '1.5.0', 'v1.4.9']) {
      const info = await checkAppUpdate({ current: '1.5.0', fetchLatestRelease: async () => release({ tag_name: tag }), now });
      expect(info.newer).toBe(false);
      expect(info.error).toBeNull();
    }
  });

  it('compares numerically, not as text', async () => {
    const info = await checkAppUpdate({ current: '1.9.0', fetchLatestRelease: async () => release({ tag_name: 'v1.10.0' }), now });
    expect(info.newer).toBe(true);
  });

  it('opens only a release page of the app repository', () => {
    for (const html_url of ['https://evil.example/releases/tag/v1.6.0', `${APP_REPO_URL}-fork/releases/tag/v1.6.0`, `${APP_REPO_URL}/releases/x y`, 42, null]) {
      const read = readRelease(release({ html_url }));
      expect(read).toMatchObject({ version: '1.6.0', url: RELEASES_LATEST_URL });
    }
  });

  it('refuses a tag that is not a version number', () => {
    for (const tag_name of ['nightly', 'v1.6', 'v1.6.0-beta.1', '', undefined]) {
      expect(readRelease(release({ tag_name }))).toHaveProperty('error');
    }
    expect(readRelease(null)).toHaveProperty('error');
    expect(readRelease('v1.6.0')).toHaveProperty('error');
  });

  it('turns a failed request into an answer with the reason, never a throw', async () => {
    const info = await checkAppUpdate({
      current: '1.5.0',
      fetchLatestRelease: async () => {
        throw new Error('GitHub is limiting requests (HTTP 403); try again later');
      },
      now,
    });
    expect(info.latest).toBeNull();
    expect(info.newer).toBeNull();
    expect(info.url).toBe(RELEASES_LATEST_URL);
    expect(info.error).toMatch(/Could not ask GitHub for the latest release: GitHub is limiting requests/);
  });

  it('reports an unusable answer without claiming anything is newer', async () => {
    const info = await checkAppUpdate({ current: '1.5.0', fetchLatestRelease: async () => ({ message: 'Not Found' }), now });
    expect(info.newer).toBeNull();
    expect(info.error).toMatch(/not a version number/);
  });
});
