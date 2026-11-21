/** The pure rules of Video tasks (SPEC.md §21): settings from the dialog, consent, sizes, doctor's report. */
import { describe, expect, it } from 'vitest';

import {
  REVIEW_STRIP_MAX,
  VIDEO_FORMATS,
  consentCovers,
  newVideoState,
  parseDoctor,
  planNeedsDownload,
  planSizes,
  reviewImageKind,
  reviewStrip,
  videoSettingsFromRequest,
} from './video';

const none = { packages: false, ffmpeg: false, chromium: false };

describe('videoSettingsFromRequest', () => {
  it('takes a listed format, a length in range and the GIF choice', () => {
    expect(videoSettingsFromRequest({ format: '1080p30', durationSec: 6, gif: true })).toEqual({ ok: true, settings: { durationSec: 6, width: 1920, height: 1080, fps: 30, gif: true } });
    expect(videoSettingsFromRequest({ format: 'vertical30', durationSec: 12.34 })).toEqual({ ok: true, settings: { durationSec: 12.3, width: 1080, height: 1920, fps: 30, gif: false } });
  });

  it('refuses free sizes, unknown formats and lengths out of range', () => {
    expect(videoSettingsFromRequest(undefined).ok).toBe(false);
    expect(videoSettingsFromRequest({ format: '8k', durationSec: 6 }).ok).toBe(false);
    expect(videoSettingsFromRequest({ format: '1080p30', width: 99999, durationSec: 0 }).ok).toBe(false);
    expect(videoSettingsFromRequest({ format: '1080p30', durationSec: 601 }).ok).toBe(false);
    expect(videoSettingsFromRequest({ format: '1080p30', durationSec: '6' }).ok).toBe(false);
  });

  it('the default format is 1920×1080 at 30 fps, and every format has even sizes', () => {
    expect(VIDEO_FORMATS[0]).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    for (const f of VIDEO_FORMATS) expect(f.width % 2 === 0 && f.height % 2 === 0, f.id).toBe(true);
  });
});

describe('consent', () => {
  it('nothing to download needs no consent', () => {
    expect(planNeedsDownload(none)).toBe(false);
    expect(consentCovers(null, none)).toBe(true);
  });

  it('covers only what was agreed to', () => {
    const packages = { ...none, packages: true };
    expect(consentCovers(null, packages)).toBe(false);
    expect(consentCovers(packages, packages)).toBe(true);
    expect(consentCovers(packages, { ...packages, ffmpeg: true })).toBe(false);
    expect(consentCovers(packages, { ...none, chromium: true })).toBe(false);
    expect(consentCovers({ packages: true, ffmpeg: true, chromium: true }, { ...none, chromium: true })).toBe(true);
  });
});

describe('planSizes', () => {
  it('states the download for the path actually taken', () => {
    expect(planSizes(none)).toEqual({ diskMb: 0, lines: [] });
    const installedBrowser = planSizes({ packages: true, ffmpeg: false, chromium: false });
    expect(installedBrowser.diskMb).toBe(116);
    expect(installedBrowser.lines).toHaveLength(1);
    expect(installedBrowser.lines.join(' ')).not.toMatch(/Chromium|GPL/);

    const everything = planSizes({ packages: true, ffmpeg: true, chromium: true });
    expect(everything.diskMb).toBe(116 + 80 + 454);
    expect(everything.lines.join('\n')).toMatch(/GPL-licensed build of ffmpeg/);
    expect(everything.lines.join('\n')).toMatch(/207 MB download, about 454 MB on disk/);
  });
});

describe('parseDoctor', () => {
  it('reads the kit’s report and ignores what it does not know', () => {
    const d = parseDoctor(
      { ok: true, problems: [], warnings: ['slow'], browser: 'Microsoft Edge', browserVersion: '157.0.4341.42', chosen: 'msedge', renderer: 'ANGLE', hardware: true, msPerFrame: 45.4, ffmpeg: { source: 'PATH', version: 'ffmpeg 9', libx264: true }, node: '26.12.0', somethingNew: 1 },
      '2026-11-10T10:00:00.000Z',
    );
    expect(d).toEqual({ ok: true, problems: [], warnings: ['slow'], browser: 'Microsoft Edge', browserVersion: '157.0.4341.42', chosen: 'msedge', renderer: 'ANGLE', hardware: true, msPerFrame: 45.4, ffmpeg: { source: 'PATH', version: 'ffmpeg 9', libx264: true }, node: '26.12.0', at: '2026-11-10T10:00:00.000Z' });
  });

  it('a missing or misshapen report is null, never a pass', () => {
    expect(parseDoctor(null, 'now')).toBeNull();
    expect(parseDoctor('ok', 'now')).toBeNull();
    expect(parseDoctor({ problems: [] }, 'now')).toBeNull();
    expect(parseDoctor({ ok: false, problems: ['no ffmpeg', 3] }, 'now')).toMatchObject({ ok: false, problems: ['no ffmpeg'], chosen: null, hardware: false, ffmpeg: null });
  });
});

describe('newVideoState', () => {
  it('starts with nothing consented, set up or approved', () => {
    expect(newVideoState({ durationSec: 6, width: 1920, height: 1080, fps: 30, gif: false })).toEqual({
      settings: { durationSec: 6, width: 1920, height: 1080, fps: 30, gif: false },
      kitDir: 'video',
      install: { consent: null, needsChromium: false },
      setup: { done: false, scaffold: null, kitVersion: null, doctor: null, imageCheck: null, forceImageCheck: false },
      storyboard: null,
      final: null,
    });
  });
});

describe('the review strip of the right panel (SPEC.md §21.7)', () => {
  const image = (name: string, mtimeMs: number) => ({ name, kind: reviewImageKind(name), size: 10, mtimeMs });

  it('is newest first, whatever kind an image is', () => {
    const strip = reviewStrip([image('shot-01-sheet.png', 100), image('shot-02-f0045.png', 300), image('crop-f0001-1_2_3x4.png', 200)]);
    expect(strip.tiles.map((i) => i.name)).toEqual(['shot-02-f0045.png', 'crop-f0001-1_2_3x4.png', 'shot-01-sheet.png']);
    expect(strip).toMatchObject({ more: 0, firstHidden: null });
  });

  it('shows at most twelve, and says how many more there are and where the viewer opens for them', () => {
    expect(REVIEW_STRIP_MAX).toBe(12);
    const images = Array.from({ length: 71 }, (_, i) => image(`shot-${String(i).padStart(2, '0')}-sheet.png`, 1000 + i));
    const strip = reviewStrip(images);
    expect(strip.tiles).toHaveLength(12);
    expect(strip.tiles[0]?.name).toBe('shot-70-sheet.png');
    expect(strip.more).toBe(59);
    expect(strip.firstHidden).toBe('shot-58-sheet.png');
    expect(reviewStrip(images.slice(0, 12))).toMatchObject({ more: 0, firstHidden: null });
    expect(reviewStrip(images.slice(0, 13))).toMatchObject({ more: 1, firstHidden: 'shot-00-sheet.png' });
  });

  it('images written in the same instant keep one order, by name', () => {
    expect(reviewStrip([image('b.png', 5), image('a.png', 5)]).tiles.map((i) => i.name)).toEqual(['a.png', 'b.png']);
    expect(reviewStrip([])).toEqual({ tiles: [], more: 0, firstHidden: null });
  });
});
