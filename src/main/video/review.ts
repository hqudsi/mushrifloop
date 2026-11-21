/**
 * Reading a Video task's own `video/` folder (SPEC.md §21.5, §21.7): the storyboard and its hash for the
 * storyboard gate, the rendered files for the final gate, and the listing the review panel shows.
 *
 * Nothing here writes, and nothing outside `<project>/video/` is ever read: every name that comes from the
 * renderer is checked against a listing made here before a path is built from it.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  VIDEO_KIT_DIR,
  VIDEO_OUT,
  reviewImageKind,
  sortReviewImages,
  storyboardRuleProblems,
  type ReviewImage,
  type StoryboardData,
  type StoryboardReading,
  type VideoFile,
  type VideoReview,
  type VideoSettings,
  type VideoState,
} from '../../shared/video';

const MAX_STORYBOARD_BYTES = 2 * 1024 * 1024;
const MAX_MARKDOWN_CHARS = 60_000;
const MAX_REVIEW_IMAGES = 200;

function kitPath(projectDir: string, ...parts: string[]): string {
  return path.join(projectDir, VIDEO_KIT_DIR, ...parts);
}

function statFile(file: string): VideoFile | null {
  try {
    const s = fs.statSync(file);
    return s.isFile() && s.size > 0 ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Compiles the storyboard schema once. Strict, failing closed: a schema that does not compile is a startup error. */
export class StoryboardValidator {
  private readonly validate: ValidateFunction;

  constructor(schemaFile: string) {
    const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')) as Record<string, unknown>;
    this.validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  }

  /**
   * The storyboard as the app sees it: missing, invalid with the reasons, or valid with the hash of its
   * bytes. `settings` are the task's: a storyboard for another size or length is not this task's storyboard.
   */
  read(projectDir: string, settings: VideoSettings | null): StoryboardReading & { data: StoryboardData | null } {
    const file = kitPath(projectDir, 'storyboard.json');
    let bytes: Buffer;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_STORYBOARD_BYTES) return { state: 'invalid', problems: ['storyboard.json is larger than 2 MB.'], hash: null, data: null };
      bytes = fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', problems: [], hash: null, data: null };
      return { state: 'invalid', problems: [`storyboard.json could not be read: ${(err as Error).message}`], hash: null, data: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      return { state: 'invalid', problems: [`storyboard.json is not valid JSON: ${(err as Error).message}`], hash: null, data: null };
    }
    if (!this.validate(parsed)) {
      const problems = (this.validate.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '(root)'}: ${e.message ?? e.keyword}`);
      return { state: 'invalid', problems, hash: null, data: null };
    }
    const data = parsed as StoryboardData;
    const problems = storyboardRuleProblems(data, settings);
    if (problems.length > 0) return { state: 'invalid', problems, hash: null, data: null };
    return { state: 'valid', problems: [], hash: createHash('sha256').update(bytes).digest('hex'), data };
  }
}

/** The rendered MP4 and GIF, when they are there and not empty. */
export function videoOutputs(projectDir: string): { mp4: VideoFile | null; gif: VideoFile | null } {
  return { mp4: statFile(kitPath(projectDir, VIDEO_OUT.mp4)), gif: statFile(kitPath(projectDir, VIDEO_OUT.gif)) };
}

function listReviewImages(projectDir: string): ReviewImage[] {
  let names: string[];
  try {
    names = fs.readdirSync(kitPath(projectDir, VIDEO_OUT.review));
  } catch {
    return [];
  }
  const images: ReviewImage[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/.test(name)) continue;
    const stat = statFile(kitPath(projectDir, VIDEO_OUT.review, name));
    if (stat) images.push({ name, kind: reviewImageKind(name), ...stat });
  }
  return sortReviewImages(images).slice(0, MAX_REVIEW_IMAGES);
}

function readText(file: string, max: number): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  } catch {
    return null;
  }
}

function timingWarnings(projectDir: string): string[] {
  try {
    const timing = JSON.parse(fs.readFileSync(kitPath(projectDir, VIDEO_OUT.review, 'timing.json'), 'utf8')) as { warnings?: unknown };
    return Array.isArray(timing.warnings) ? timing.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

function renderProgress(projectDir: string): { frames: number; total: number | null } {
  let frames = 0;
  let total: number | null = null;
  try {
    frames = fs.readdirSync(kitPath(projectDir, VIDEO_OUT.frames)).filter((n) => /^\d{6}\.png$/.test(n)).length;
    const manifest = JSON.parse(fs.readFileSync(kitPath(projectDir, VIDEO_OUT.frames, 'manifest.json'), 'utf8')) as { durationInFrames?: unknown };
    if (typeof manifest.durationInFrames === 'number') total = manifest.durationInFrames;
  } catch {
    /* nothing rendered yet */
  }
  return { frames, total };
}

/** Everything the review panel and the two cards show. Never throws: a failure is in `error`. */
export function readVideoReview(taskId: string, projectDir: string, video: VideoState, validator: StoryboardValidator): VideoReview {
  const empty: VideoReview = {
    taskId,
    storyboard: { state: 'missing', problems: [], hash: null, markdown: null, data: null, approvedHash: video.storyboard?.approvedHash ?? null, changedSinceApproval: false },
    images: [],
    timingWarnings: [],
    render: { frames: 0, total: null },
    mp4: null,
    gif: null,
    small: null,
    approved: video.final ? { approvedAt: video.final.approvedAt, size: video.final.size, mtimeMs: video.final.mtimeMs } : null,
    error: null,
  };
  try {
    const reading = validator.read(projectDir, video.settings);
    const approvedHash = video.storyboard?.approvedHash ?? null;
    const outputs = videoOutputs(projectDir);
    return {
      ...empty,
      storyboard: {
        state: reading.state,
        problems: reading.problems,
        hash: reading.hash,
        data: reading.data,
        markdown: readText(kitPath(projectDir, 'storyboard.md'), MAX_MARKDOWN_CHARS),
        approvedHash,
        changedSinceApproval: approvedHash !== null && reading.hash !== approvedHash,
      },
      images: listReviewImages(projectDir),
      timingWarnings: timingWarnings(projectDir),
      render: renderProgress(projectDir),
      mp4: outputs.mp4,
      gif: outputs.gif,
      small: statFile(kitPath(projectDir, VIDEO_OUT.small)),
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The full path of a review image, only if it is one of the files a listing would show; otherwise null. */
export function reviewImagePath(projectDir: string, name: unknown): string | null {
  if (typeof name !== 'string') return null;
  return listReviewImages(projectDir).some((image) => image.name === name) ? kitPath(projectDir, VIDEO_OUT.review, name) : null;
}

/** The MP4 or the GIF of a task, when it exists. `which` comes from a URL, so anything else is null. */
export function mediaFile(projectDir: string, which: string): { file: string; type: string } | null {
  if (which === 'video.mp4') return statFile(kitPath(projectDir, VIDEO_OUT.mp4)) ? { file: kitPath(projectDir, VIDEO_OUT.mp4), type: 'video/mp4' } : null;
  if (which === 'video.gif') return statFile(kitPath(projectDir, VIDEO_OUT.gif)) ? { file: kitPath(projectDir, VIDEO_OUT.gif), type: 'image/gif' } : null;
  return null;
}

/** The task's output folder, for "Open output folder"; created by the kit, so it may not exist yet. */
export function outputFolder(projectDir: string): string {
  return kitPath(projectDir, 'out');
}

/**
 * One Range request against a file (SPEC.md §21.7): the `<video>` element seeks with them, and a handler that
 * ignores them cannot seek (NOTES.md §68.1). Returns what to answer; the caller streams `start`–`end`.
 */
export function rangeFor(header: string | null, size: number): { status: 200 | 206 | 416; start: number; end: number; headers: Record<string, string> } {
  const whole = { status: 200 as const, start: 0, end: size - 1, headers: { 'accept-ranges': 'bytes', 'content-length': String(size) } };
  if (header === null) return whole;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return whole;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return { status: 416, start: 0, end: -1, headers: { 'content-range': `bytes */${size}` } };
  return {
    status: 206,
    start,
    end,
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
  };
}
