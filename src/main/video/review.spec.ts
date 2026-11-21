/**
 * Reading a Video task's video/ folder (SPEC.md §21.5, §21.7): the storyboard as the gate sees it — and that
 * the app and the kit agree on what a valid storyboard is — the listing for the review panel, the files the
 * media scheme may serve, and Range answers.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG, MEDIA_PROTOCOL, videoMediaUrl } from '../../shared/app-config';
import { newVideoState, reviewImageKind, sameVideoFile, sortReviewImages, type StoryboardData, type VideoSettings } from '../../shared/video';
import { StoryboardValidator, mediaFile, rangeFor, readVideoReview, reviewImagePath, videoOutputs } from './review';

const REPO = path.resolve(__dirname, '..', '..', '..');
const validator = new StoryboardValidator(path.join(REPO, 'video', 'schemas', 'storyboard.schema.json'));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(REPO, 'video', 'kit', 'storyboard.json'), 'utf8')) as StoryboardData;
const SETTINGS: VideoSettings = { durationSec: 5, width: 1920, height: 1080, fps: 30, gif: false };

let dir: string;
const kit = (...parts: string[]) => path.join(dir, 'video', ...parts);
const write = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const board = (value: unknown) => write(kit('storyboard.json'), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const clone = (): StoryboardData => structuredClone(SAMPLE);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-review-`));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the storyboard as the gate reads it', () => {
  it('missing, then valid with the hash of the file’s bytes', () => {
    expect(validator.read(dir, SETTINGS)).toMatchObject({ state: 'missing', hash: null });
    board(SAMPLE);
    const first = validator.read(dir, SETTINGS);
    expect(first.state).toBe('valid');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(validator.read(dir, SETTINGS).hash).toBe(first.hash);
    // Any change to the file is a different storyboard.
    const changed = clone();
    changed.shots[0]!.texts[0]!.text = 'Hello!';
    board(changed);
    expect(validator.read(dir, SETTINGS).hash).not.toBe(first.hash);
  });

  it('the kit’s own sample is valid', () => {
    board(fs.readFileSync(path.join(REPO, 'video', 'kit', 'storyboard.json'), 'utf8'));
    expect(validator.read(dir, SETTINGS).state).toBe('valid');
  });

  it('is invalid, with reasons, for broken JSON, wrong shapes and broken rules', () => {
    board('{ "title": ');
    expect(validator.read(dir, SETTINGS)).toMatchObject({ state: 'invalid', hash: null });
    board({ title: 'x' });
    expect(validator.read(dir, SETTINGS).problems.join(' ')).toMatch(/shots|width/);

    const gap = clone();
    gap.shots[1]!.startFrame = 80;
    gap.shots[1]!.texts = [];
    gap.shots[1]!.reviewFrames = [100];
    board(gap);
    expect(validator.read(dir, SETTINGS).problems.join(' ')).toMatch(/without gaps/);

    const fewChecks = clone();
    fewChecks.shots[0]!.acceptance = ['only one'];
    board(fewChecks);
    expect(validator.read(dir, SETTINGS).state).toBe('invalid');
  });

  it('a storyboard for another size or length is not this task’s storyboard', () => {
    board(SAMPLE);
    expect(validator.read(dir, { ...SETTINGS, width: 1080, height: 1920 }).problems.join(' ')).toMatch(/this task's video is 1080×1920/);
    expect(validator.read(dir, { ...SETTINGS, durationSec: 6 }).problems.join(' ')).toMatch(/180 frames/);
    expect(validator.read(dir, null).state).toBe('valid');
  });

  it('agrees with the kit’s own check on every case', async () => {
    const kitCommon = (await import(pathToFileURL(path.join(REPO, 'video', 'kit', 'scripts', 'lib', 'common.mjs')).href)) as { storyboardProblems(sb: unknown): string[] };
    const cases: Array<[string, (sb: StoryboardData) => unknown]> = [
      ['the sample', (sb) => sb],
      ['no title', (sb) => ({ ...sb, title: '' })],
      ['odd width', (sb) => ({ ...sb, width: 1921 })],
      ['fps 0', (sb) => ({ ...sb, fps: 0 })],
      ['no shots', (sb) => ({ ...sb, shots: [] })],
      ['shots not a list', (sb) => ({ ...sb, shots: 'two' })],
      ['a gap between shots', (sb) => ((sb.shots[1]!.startFrame = 76), (sb.shots[1]!.texts = []), (sb.shots[1]!.reviewFrames = [100]), sb)],
      ['the last shot ends early', (sb) => ((sb.shots[1]!.endFrame = 140), (sb.shots[1]!.texts = []), (sb.shots[1]!.reviewFrames = [100]), sb)],
      ['a review frame outside its shot', (sb) => ((sb.shots[0]!.reviewFrames = [0, 90]), sb)],
      ['no review frames', (sb) => ((sb.shots[0]!.reviewFrames = []), sb)],
      ['two checks only', (sb) => ((sb.shots[0]!.acceptance = ['a', 'b']), sb)],
      ['six checks', (sb) => ((sb.shots[0]!.acceptance = ['a', 'b', 'c', 'd', 'e', 'f']), sb)],
      ['a text outside its shot', (sb) => ((sb.shots[0]!.texts[0]!.endFrame = 90), sb)],
      ['a text id used twice', (sb) => ((sb.shots[1]!.texts[1]!.id = 'hello'), sb)],
      ['a shot id used twice', (sb) => ((sb.shots[1]!.id = 'shot-01'), sb)],
      ['a shot id with a space', (sb) => ((sb.shots[0]!.id = 'shot 1'), sb)],
      ['a text without words', (sb) => ((sb.shots[0]!.texts[0]!.text = ''), sb)],
      ['start after end', (sb) => ((sb.shots[0]!.startFrame = 80), sb)],
      ['a fractional frame', (sb) => ((sb.shots[0]!.endFrame = 74.5), sb)],
      ['Arabic everywhere', (sb) => ((sb.title = 'بطاقة عنوان'), (sb.shots[0]!.name = 'المشهد الأول'), (sb.shots[0]!.onScreen = 'تظهر كلمة مرحبا في المنتصف'), sb)],
    ];
    for (const [name, change] of cases) {
      const value = change(clone());
      board(value);
      const app = validator.read(dir, null).state === 'valid';
      const theKit = kitCommon.storyboardProblems(value).length === 0;
      expect(app, `${name}: the app says ${app ? 'valid' : 'invalid'}, the kit says ${theKit ? 'valid' : 'invalid'}`).toBe(theKit);
    }
  });
});

describe('the review listing', () => {
  it('lists sheets first, then frames, then crops, and nothing that is not a PNG in out/review', () => {
    for (const name of ['shot-02-f0095.png', 'shot-01-sheet.png', 'crop-f0045-0_0_100x100.png', 'shot-01-f0020.png', 'shot-02-sheet.png']) write(kit('out', 'review', name), 'png');
    write(kit('out', 'review', 'timing.json'), JSON.stringify({ warnings: ['shot-01 / hello: 1 word(s) on screen for 0.5 s; the minimum is 1 s.', 7] }));
    write(kit('out', 'review', 'notes.txt'), 'x');
    write(kit('out', 'review', 'empty.png'), '');
    board(SAMPLE);
    write(kit('storyboard.md'), '# Sample\n\nمرحبا');
    for (let n = 0; n < 3; n++) write(kit('out', 'frames', `00000${n}.png`), 'f');
    write(kit('out', 'frames', 'manifest.json'), JSON.stringify({ durationInFrames: 150 }));

    const review = readVideoReview('t1', dir, newVideoState(SETTINGS), validator);
    expect(review.images.map((i) => i.name)).toEqual(['shot-01-sheet.png', 'shot-02-sheet.png', 'shot-01-f0020.png', 'shot-02-f0095.png', 'crop-f0045-0_0_100x100.png']);
    expect(review.images.map((i) => i.kind)).toEqual(['sheet', 'sheet', 'frame', 'frame', 'crop']);
    expect(review.timingWarnings).toEqual(['shot-01 / hello: 1 word(s) on screen for 0.5 s; the minimum is 1 s.']);
    expect(review.render).toEqual({ frames: 3, total: 150 });
    expect(review.storyboard).toMatchObject({ state: 'valid', markdown: '# Sample\n\nمرحبا', approvedHash: null, changedSinceApproval: false });
    expect(review.storyboard.data?.shots).toHaveLength(2);
    expect(review.mp4).toBeNull();
    expect(review.error).toBeNull();
  });

  it('says when the storyboard changed since it was approved', () => {
    board(SAMPLE);
    const state = newVideoState(SETTINGS);
    state.storyboard = { approvedHash: validator.read(dir, SETTINGS).hash ?? '', approvedAt: '2026-11-10T10:00:00.000Z' };
    expect(readVideoReview('t1', dir, state, validator).storyboard.changedSinceApproval).toBe(false);
    const changed = clone();
    changed.title = 'Another title';
    board(changed);
    expect(readVideoReview('t1', dir, state, validator).storyboard.changedSinceApproval).toBe(true);
  });

  it('an empty project reads as nothing yet, never as an error', () => {
    const review = readVideoReview('t1', dir, newVideoState(SETTINGS), validator);
    expect(review).toMatchObject({ images: [], render: { frames: 0, total: null }, mp4: null, gif: null, small: null, error: null });
    expect(review.storyboard.state).toBe('missing');
  });

  it('reports the smaller copy when `npm run small` has made one (§21.9)', () => {
    write(kit('out', 'video.mp4'), 'the large master file');
    expect(readVideoReview('t1', dir, newVideoState(SETTINGS), validator).small).toBeNull();
    write(kit('out', 'video-small.mp4'), 'small');
    expect(readVideoReview('t1', dir, newVideoState(SETTINGS), validator)).toMatchObject({ mp4: { size: 21 }, small: { size: 5 } });
  });

  it('kind and order helpers', () => {
    expect(reviewImageKind('shot-01-sheet.png')).toBe('sheet');
    expect(reviewImageKind('crop-f0001-1_2_3x4.png')).toBe('crop');
    expect(reviewImageKind('shot-01-f0001.png')).toBe('frame');
    expect(sortReviewImages([{ name: 'b.png', kind: 'frame', size: 1, mtimeMs: 1 }, { name: 'a-sheet.png', kind: 'sheet', size: 1, mtimeMs: 1 }]).map((i) => i.name)).toEqual(['a-sheet.png', 'b.png']);
  });
});

describe('what may be served', () => {
  beforeEach(() => {
    write(kit('out', 'review', 'shot-01-sheet.png'), 'png');
    write(kit('out', 'video.mp4'), 'mp4-bytes');
    write(path.join(dir, 'secret.png'), 'secret');
    write(kit('src', 'video.ts'), 'code');
  });

  it('a review image only by a name the listing shows', () => {
    expect(reviewImagePath(dir, 'shot-01-sheet.png')).toBe(kit('out', 'review', 'shot-01-sheet.png'));
    for (const bad of ['../../../secret.png', '..\\..\\..\\secret.png', 'nope.png', '', 42, null, 'shot-01-sheet.png/..', path.join(dir, 'secret.png')]) {
      expect(reviewImagePath(dir, bad), String(bad)).toBeNull();
    }
  });

  it('the MP4 and the GIF, by those two names only, and only when they exist', () => {
    expect(mediaFile(dir, 'video.mp4')).toEqual({ file: kit('out', 'video.mp4'), type: 'video/mp4' });
    expect(mediaFile(dir, 'video.gif')).toBeNull();
    for (const bad of ['../src/video.ts', 'video.mp4/../../src/video.ts', 'storyboard.json', '']) expect(mediaFile(dir, bad), bad).toBeNull();
    expect(videoOutputs(dir)).toMatchObject({ mp4: { size: 9 }, gif: null });
    write(kit('out', 'video.gif'), '');
    expect(videoOutputs(dir).gif).toBeNull();
  });

  it('the media scheme is the one the renderer’s policy allows', () => {
    const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');
    expect(html).toContain(`media-src ${MEDIA_PROTOCOL}:`);
    expect(html).toContain(`img-src 'self' data: ${MEDIA_PROTOCOL}:`);
    expect(videoMediaUrl('20261110-150038-91ebe0', 'video.mp4', 1794000000000.7)).toBe(`${MEDIA_PROTOCOL}://task/20261110-150038-91ebe0/video.mp4?v=1794000000001`);
  });

  it('the approved file is recognised by size and time', () => {
    expect(sameVideoFile({ size: 10, mtimeMs: 5.2 }, { size: 10, mtimeMs: 5 })).toBe(true);
    expect(sameVideoFile({ size: 11, mtimeMs: 5 }, { size: 10, mtimeMs: 5 })).toBe(false);
    expect(sameVideoFile(null, { size: 10, mtimeMs: 5 })).toBe(false);
  });
});

describe('Range requests', () => {
  it('no header: the whole file', () => {
    expect(rangeFor(null, 1000)).toMatchObject({ status: 200, start: 0, end: 999, headers: { 'accept-ranges': 'bytes', 'content-length': '1000' } });
  });

  it('a range: 206 with Content-Range, as the player needs to seek', () => {
    expect(rangeFor('bytes=0-', 1000)).toMatchObject({ status: 206, start: 0, end: 999, headers: { 'content-range': 'bytes 0-999/1000', 'content-length': '1000' } });
    expect(rangeFor('bytes=200-299', 1000)).toMatchObject({ status: 206, start: 200, end: 299, headers: { 'content-range': 'bytes 200-299/1000', 'content-length': '100' } });
    expect(rangeFor('bytes=900-5000', 1000)).toMatchObject({ status: 206, start: 900, end: 999 });
    expect(rangeFor('bytes=-100', 1000)).toMatchObject({ status: 206, start: 900, end: 999 });
  });

  it('past the end: 416', () => {
    expect(rangeFor('bytes=1000-', 1000)).toMatchObject({ status: 416, headers: { 'content-range': 'bytes */1000' } });
    expect(rangeFor('bytes=500-400', 1000).status).toBe(416);
  });

  it('anything else is treated as no range', () => {
    for (const odd of ['items=0-5', 'bytes=abc', 'bytes=-', 'bytes=0-5,10-20']) expect(rangeFor(odd, 1000).status, odd).toBe(200);
  });
});
