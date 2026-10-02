import { describe, expect, it } from 'vitest';

import { CACHE_WINDOW_MS, coldSessionNote } from './session-age';

const NOW = Date.parse('2026-09-20T06:43:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('coldSessionNote (SPEC.md §10, the cold-session line)', () => {
  it('says nothing while the cache can still be warm', () => {
    expect(coldSessionNote(ago(0), NOW)).toBeNull();
    expect(coldSessionNote(ago(5 * 60_000), NOW)).toBeNull();
    expect(coldSessionNote(ago(CACHE_WINDOW_MS - 1), NOW)).toBeNull();
  });

  it('warns once the context is certainly re-created, and says how long it has been', () => {
    const note = coldSessionNote(ago(CACHE_WINDOW_MS), NOW);
    expect(note).toBe('Finished 1h 00m ago — resuming re-creates this task\'s context, so a follow-up now costs more than one sent right after it ended.');
  });

  it('reads naturally for the case that was measured: three days', () => {
    // NOTES.md §36: finished 2026-09-17T06:12:42Z, follow-up 2026-09-20T06:43Z, $0.194, no cache read.
    expect(coldSessionNote('2026-09-17T06:12:42.467Z', NOW)).toContain('Finished 3d 0h ago');
  });

  it('never blocks on a missing or unreadable timestamp', () => {
    expect(coldSessionNote(null, NOW)).toBeNull();
    expect(coldSessionNote(undefined, NOW)).toBeNull();
    expect(coldSessionNote('not a date', NOW)).toBeNull();
  });

  it('says nothing when the clock puts the task in the future', () => {
    expect(coldSessionNote(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
  });
});
