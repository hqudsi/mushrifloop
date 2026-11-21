/**
 * Video tasks (SPEC.md §21): the data a Video task carries in task.json, the format presets, and the pure
 * rules shared by the main process and the renderer. JSON-serializable, no Node types.
 */

/** A task without a kind is a coding task: every task made before Video tasks existed. */
export type TaskKind = 'code' | 'video';

export interface VideoFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

/** SPEC.md §21.2. The first one is the default. */
export const VIDEO_FORMATS: readonly VideoFormat[] = [
  { id: '1080p30', label: '1920×1080 · 30 fps', width: 1920, height: 1080, fps: 30 },
  { id: 'vertical30', label: '1080×1920 · 30 fps', width: 1080, height: 1920, fps: 30 },
  { id: 'square30', label: '1080×1080 · 30 fps', width: 1080, height: 1080, fps: 30 },
  { id: '720p30', label: '1280×720 · 30 fps', width: 1280, height: 720, fps: 30 },
];

export const VIDEO_DURATION_LIMITS = { min: 1, max: 600, default: 10 } as const;

/** What the user chose in the New task dialog. Fixed at creation (SPEC.md §21.8). */
export interface VideoSettings {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  gif: boolean;
}

/** What `CreateTaskRequest.video` carries: a preset id, never free sizes. */
export interface VideoRequest {
  durationSec: number;
  format: string;
  gif: boolean;
}

/** The kit's folder inside the project, relative, forward slashes (SPEC.md §21.1). */
export const VIDEO_KIT_DIR = 'video';
/** The file that marks a folder as a kit the app may use; nothing in such a folder is ever overwritten. */
export const VIDEO_KIT_MARKER = 'kit.json';
export const VIDEO_KIT_ID = 'mushrifloop-video-kit';
/**
 * The first kit version with the style toolkit (`src/style`) and `npm run small` (SPEC.md §21.9). A kit
 * already in a project is never upgraded, so an older one lacks both, and the agents are told so.
 */
export const VIDEO_KIT_STYLE_SINCE = '1.1.0';

/**
 * What a Video task downloads, measured on 2026-11-10 (NOTES.md §68): shown in the consent dialog, so they
 * are stated sizes, not live readings. `diskMb` is what stays on disk.
 */
export const VIDEO_DOWNLOADS = {
  packages: { diskMb: 116, what: 'npm packages: three, Vite, TypeScript, Playwright (without a browser)' },
  ffmpeg: { diskMb: 80, what: 'ffmpeg-static: a GPL-licensed build of ffmpeg, with libx264' },
  chromium: { downloadMb: 207, diskMb: 454, what: "Playwright's Chromium browser" },
} as const;

/** Which downloads this folder needs, for the path that will actually be taken (SPEC.md §21.3). */
export interface InstallPlan {
  /** `npm ci`: the kit's node_modules is missing. */
  packages: boolean;
  /** No ffmpeg with libx264 on PATH, so ffmpeg-static is installed. */
  ffmpeg: boolean;
  /** Neither Edge nor Chrome can be used, so Playwright's Chromium is downloaded. */
  chromium: boolean;
}

export function planNeedsDownload(plan: InstallPlan): boolean {
  return plan.packages || plan.ffmpeg || plan.chromium;
}

/** Has the human already agreed to everything `plan` would download? */
export function consentCovers(consented: InstallPlan | null, plan: InstallPlan): boolean {
  if (!planNeedsDownload(plan)) return true;
  if (!consented) return false;
  return (!plan.packages || consented.packages) && (!plan.ffmpeg || consented.ffmpeg) && (!plan.chromium || consented.chromium);
}

/** The total that will be on disk afterwards, and what crosses the network where that differs. */
export function planSizes(plan: InstallPlan): { diskMb: number; lines: string[] } {
  const lines: string[] = [];
  let diskMb = 0;
  if (plan.packages) {
    diskMb += VIDEO_DOWNLOADS.packages.diskMb;
    lines.push(`${VIDEO_DOWNLOADS.packages.what} — about ${VIDEO_DOWNLOADS.packages.diskMb} MB`);
  }
  if (plan.ffmpeg) {
    diskMb += VIDEO_DOWNLOADS.ffmpeg.diskMb;
    lines.push(`${VIDEO_DOWNLOADS.ffmpeg.what} — about ${VIDEO_DOWNLOADS.ffmpeg.diskMb} MB (no ffmpeg with libx264 was found on this computer)`);
  }
  if (plan.chromium) {
    diskMb += VIDEO_DOWNLOADS.chromium.diskMb;
    lines.push(
      `${VIDEO_DOWNLOADS.chromium.what} — a ${VIDEO_DOWNLOADS.chromium.downloadMb} MB download, about ${VIDEO_DOWNLOADS.chromium.diskMb} MB on disk (neither Microsoft Edge nor Google Chrome can be used on this computer)`,
    );
  }
  return { diskMb, lines };
}

/** What the app keeps of the kit's out/doctor.json (SPEC.md §21.3). */
export interface DoctorSummary {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** "Microsoft Edge", "Google Chrome" or "Playwright's Chromium". */
  browser: string | null;
  browserVersion: string | null;
  /** The kit's option id: msedge, chrome, chromium, with -d3d11 or -headed. */
  chosen: string | null;
  renderer: string | null;
  hardware: boolean;
  msPerFrame: number | null;
  ffmpeg: { source: string; version: string; libx264: boolean } | null;
  node: string | null;
  at: string;
}

/** Tolerant reading of out/doctor.json: unknown fields are ignored, a wrong shape is null. */
export function parseDoctor(raw: unknown, at: string): DoctorSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ok'] !== 'boolean') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const f = r['ffmpeg'];
  const ffmpeg =
    typeof f === 'object' && f !== null
      ? {
          source: text((f as Record<string, unknown>)['source']) ?? 'unknown',
          version: text((f as Record<string, unknown>)['version']) ?? '',
          libx264: (f as Record<string, unknown>)['libx264'] === true,
        }
      : null;
  return {
    ok: r['ok'],
    problems: list(r['problems']),
    warnings: list(r['warnings']),
    browser: text(r['browser']),
    browserVersion: text(r['browserVersion']),
    chosen: text(r['chosen']),
    renderer: text(r['renderer']),
    hardware: r['hardware'] === true,
    msPerFrame: typeof r['msPerFrame'] === 'number' ? r['msPerFrame'] : null,
    ffmpeg,
    node: text(r['node']),
    at,
  };
}

export type VideoSetupStep = 'prerequisites' | 'consent' | 'scaffold' | 'install' | 'tools' | 'doctor' | 'image_check';

/** The image check's result for this task (SPEC.md §21.3 step 5). */
export interface ImageCheckResult {
  ok: boolean;
  /** True when a cached pass for the same CLI version, launch flags and model was used: no turn was spent. */
  cached: boolean;
  /** The cache key the result belongs to. */
  key: string;
  at: string;
}

/** `video` in task.json. */
export interface VideoState {
  settings: VideoSettings;
  /** Relative to the project folder, forward slashes. */
  kitDir: string;
  install: {
    /** What the human agreed to download, and when; null until they have. */
    consent: { at: string; plan: InstallPlan } | null;
    /** Doctor found no usable installed browser, so the next plan includes Playwright's Chromium. */
    needsChromium: boolean;
  };
  setup: {
    /** Every step has passed; the Planner may start. */
    done: boolean;
    scaffold: 'copied' | 'existing' | null;
    kitVersion: string | null;
    doctor: DoctorSummary | null;
    imageCheck: ImageCheckResult | null;
    /** Set by "Re-check image reading": the next setup ignores the cache once. */
    forceImageCheck: boolean;
  };
  /** The storyboard the human approved (SPEC.md §21.5); null until they have. */
  storyboard: { approvedHash: string; approvedAt: string } | null;
  /** The video the human approved at the final gate; null until they have. */
  final: { approvedAt: string; file: string; size: number; mtimeMs: number } | null;
  /**
   * The storyboard's hash when a step marked `revises_storyboard` was let through, to see afterwards whether
   * it changed anything. Absent when no such step is under way.
   */
  revisionFrom?: string | null;
  /** A revision-marked step left the storyboard unchanged: the next step is held whatever it is marked as. */
  revisionStalled?: boolean;
}

export function newVideoState(settings: VideoSettings): VideoState {
  return {
    settings,
    kitDir: VIDEO_KIT_DIR,
    install: { consent: null, needsChromium: false },
    setup: { done: false, scaffold: null, kitVersion: null, doctor: null, imageCheck: null, forceImageCheck: false },
    storyboard: null,
    final: null,
  };
}

/** Validate what the New task dialog sent. Returns the settings, or a sentence saying what is wrong. */
export function videoSettingsFromRequest(raw: unknown): { ok: true; settings: VideoSettings } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'A Video task needs its length and format.' };
  const r = raw as Record<string, unknown>;
  const format = VIDEO_FORMATS.find((f) => f.id === r['format']);
  if (!format) return { ok: false, error: 'Choose one of the listed video formats.' };
  const duration = r['durationSec'];
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < VIDEO_DURATION_LIMITS.min || duration > VIDEO_DURATION_LIMITS.max) {
    return { ok: false, error: `The length must be between ${VIDEO_DURATION_LIMITS.min} and ${VIDEO_DURATION_LIMITS.max} seconds.` };
  }
  return { ok: true, settings: { durationSec: Math.round(duration * 10) / 10, width: format.width, height: format.height, fps: format.fps, gif: r['gif'] === true } };
}

/** File ping-pong window (SPEC.md §5 net 2, §21.6): three fix rounds on one shot's file are ordinary video work. */
export const VIDEO_PING_PONG_TURNS = 5;

/**
 * The Executor of a Video task starts a fresh session once its context passes this many tokens (SPEC.md
 * §15, §21.10), far below the model's own threshold. Re-reading a long session was 48 % of the first real
 * Video task's cost (NOTES.md §75.1), and a video's state is in files: the storyboard, the code and
 * `progress.md`.
 */
export const VIDEO_EXECUTOR_ROLLOVER_TOKENS = 150_000;

/** The rollover cap for this agent of this kind of task, in tokens; null when only the model's threshold applies. */
export function rolloverCapFor(kind: TaskKind | undefined, agent: 'planner' | 'executor'): number | null {
  return kind === 'video' && agent === 'executor' ? VIDEO_EXECUTOR_ROLLOVER_TOKENS : null;
}

/** The progress notes the Executor of a Video task keeps, relative to the kit folder (SPEC.md §21.10). */
export const VIDEO_PROGRESS_FILE = 'progress.md';

/** Above this size the final card says how to make a smaller copy (SPEC.md §21.9): GitHub's limit for an attached video. */
export const VIDEO_ATTACH_LIMIT_BYTES = 10 * 1024 * 1024;
/** The one command that makes the smaller copy, run in the kit folder: what the render's warning prints. */
export const VIDEO_SMALL_COMMAND = 'npm run small';

/**
 * Third-party material of Video tasks, for the licences page (SPEC.md §11, §21.1). The fonts ship inside the
 * kit; the rest is downloaded by npm into the user's project after consent and is never part of the app.
 * Versions are the ones the kit pins (video/kit/package.json); a test keeps the two in step.
 */
export const VIDEO_THIRD_PARTY: ReadonlyArray<{ name: string; version: string; license: string; shipped: boolean; note: string }> = [
  { name: 'Inter', version: 'latin, 400 and 700', license: 'OFL-1.1', shipped: true, note: 'Copyright 2016 The Inter Project Authors. SIL Open Font License 1.1.' },
  { name: 'Noto Sans Arabic', version: 'arabic, 400 and 700', license: 'OFL-1.1', shipped: true, note: 'Copyright 2022 The Noto Project Authors. SIL Open Font License 1.1.' },
  { name: 'three', version: '0.187.0', license: 'MIT', shipped: false, note: 'three.js: the 3D library the video is written with.' },
  { name: 'vite', version: '8.3.7', license: 'MIT', shipped: false, note: 'Builds and previews the video page.' },
  { name: 'typescript', version: '7.0.2', license: 'Apache-2.0', shipped: false, note: 'Type checking of the video code.' },
  { name: 'playwright-core', version: '1.65.0', license: 'Apache-2.0', shipped: false, note: 'Drives the browser that renders each frame: an installed Microsoft Edge or Google Chrome, or its own Chromium when neither can be used.' },
  {
    name: 'ffmpeg-static',
    version: '5.3.0',
    license: 'GPL-3.0-or-later',
    shipped: false,
    note: 'A build of ffmpeg, with libx264, under the GNU General Public License version 3. Downloaded only when no ffmpeg with libx264 is on this computer. It encodes the MP4; your videos are not covered by its licence.',
  },
];

// ---------------------------------------------------------------------------
// The storyboard and the two gates (SPEC.md §21.5), and what the review panel shows (§21.7)
// ---------------------------------------------------------------------------

export interface StoryboardText {
  id: string;
  text: string;
  lang: string;
  startFrame: number;
  endFrame: number;
}

export interface StoryboardShot {
  id: string;
  name: string;
  startFrame: number;
  endFrame: number;
  onScreen: string;
  texts: StoryboardText[];
  reviewFrames: number[];
  acceptance: string[];
}

/** `video/storyboard.json`: the data the kit's code and scripts read, and what the human approves. */
export interface StoryboardData {
  title: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  shots: StoryboardShot[];
}

/**
 * The rules a JSON schema cannot state, for a storyboard that already has the right shapes
 * (video/schemas/storyboard.schema.json): the same rules as `storyboardProblems` in the kit's
 * scripts/lib/common.mjs — a test feeds both the same cases — plus one the kit cannot know: the size,
 * frame rate and length must be the ones this task was created with.
 */
export function storyboardRuleProblems(sb: StoryboardData, settings: VideoSettings | null): string[] {
  const problems: string[] = [];
  const shotIds = new Set<string>();
  const textIds = new Set<string>();
  let expectedStart = 0;
  sb.shots.forEach((shot, index) => {
    const where = `shots[${index}] (${shot.id})`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(shot.id)) problems.push(`${where}: id may hold letters, digits, "-" and "_" only.`);
    else if (shotIds.has(shot.id)) problems.push(`${where}: the id is used twice.`);
    shotIds.add(shot.id);
    if (shot.startFrame > shot.endFrame) {
      problems.push(`${where}: startFrame is after endFrame.`);
      return;
    }
    if (shot.startFrame !== expectedStart) problems.push(`${where}: startFrame is ${shot.startFrame}, but the shot before it ends at ${expectedStart - 1}; shots follow each other without gaps or overlaps, starting at frame 0.`);
    expectedStart = shot.endFrame + 1;
    if (shot.reviewFrames.some((f) => f < shot.startFrame || f > shot.endFrame)) problems.push(`${where}: every review frame must lie inside the shot (${shot.startFrame}–${shot.endFrame}).`);
    shot.texts.forEach((t, ti) => {
      const tw = `${where} texts[${ti}]`;
      if (textIds.has(t.id)) problems.push(`${tw}: the id "${t.id}" is used twice.`);
      textIds.add(t.id);
      if (t.startFrame > t.endFrame || t.startFrame < shot.startFrame || t.endFrame > shot.endFrame) problems.push(`${tw}: its frames must lie inside the shot (${shot.startFrame}–${shot.endFrame}).`);
    });
  });
  if (expectedStart !== sb.durationInFrames) problems.push(`The last shot ends at frame ${expectedStart - 1}, but durationInFrames is ${sb.durationInFrames}.`);
  if (sb.width % 2 !== 0 || sb.height % 2 !== 0) problems.push('width and height must be even numbers.');
  if (settings) {
    const frames = Math.round(settings.durationSec * settings.fps);
    if (sb.width !== settings.width || sb.height !== settings.height) problems.push(`The size is ${sb.width}×${sb.height}, but this task's video is ${settings.width}×${settings.height}.`);
    if (sb.fps !== settings.fps) problems.push(`fps is ${sb.fps}, but this task's video is ${settings.fps} fps.`);
    if (sb.durationInFrames !== frames) problems.push(`durationInFrames is ${sb.durationInFrames}, but this task's video is ${settings.durationSec} s at ${settings.fps} fps: ${frames} frames.`);
  }
  return problems;
}

/** What the app found when it looked at the storyboard files (SPEC.md §21.5). */
export interface StoryboardReading {
  /** `missing`: no storyboard.json. `invalid`: there is one, with `problems`. `valid`: usable, with its `hash`. */
  state: 'missing' | 'invalid' | 'valid';
  problems: string[];
  /** SHA-256 of storyboard.json's bytes; null unless valid. */
  hash: string | null;
}

/** A rendered file in the task's video/out/ folder. */
export interface VideoFile {
  size: number;
  mtimeMs: number;
}

export interface ReviewImage {
  /** File name inside out/review/, e.g. `shot-02-sheet.png`. */
  name: string;
  kind: 'sheet' | 'frame' | 'crop';
  size: number;
  mtimeMs: number;
}

/** Everything the review panel and the two cards show, read from the task's own video/ folder (SPEC.md §21.7). */
export interface VideoReview {
  taskId: string;
  storyboard: StoryboardReading & {
    /** storyboard.md, for the human; null when there is none. */
    markdown: string | null;
    data: StoryboardData | null;
    approvedHash: string | null;
    /** Approved, and the file on disk is no longer the one that was approved. */
    changedSinceApproval: boolean;
  };
  images: ReviewImage[];
  /** From out/review/timing.json: texts that are on screen too briefly. */
  timingWarnings: string[];
  /** Frames on disk in out/frames, and how many the video has. */
  render: { frames: number; total: number | null };
  mp4: VideoFile | null;
  gif: VideoFile | null;
  /** The smaller copy made by `npm run small` (out/video-small.mp4), when there is one. */
  small: VideoFile | null;
  /** The MP4 as the final gate approved it, if it did. */
  approved: { approvedAt: string; size: number; mtimeMs: number } | null;
  error: string | null;
}

export const VIDEO_OUT = { mp4: 'out/video.mp4', gif: 'out/video.gif', small: 'out/video-small.mp4', review: 'out/review', frames: 'out/frames' } as const;

/** Contact sheets first, then frames, then crops; by name within each. */
export function sortReviewImages(images: readonly ReviewImage[]): ReviewImage[] {
  const rank = { sheet: 0, frame: 1, crop: 2 } as const;
  return [...images].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

/** How many thumbnails the right panel's strip shows (SPEC.md §21.7); the rest are behind "+N more". */
export const REVIEW_STRIP_MAX = 12;

/**
 * The strip of the right panel: the newest images first, at most twelve, and how many are not shown.
 * `firstHidden` is where "+N more" opens the viewer, which holds the full set.
 */
export function reviewStrip(images: readonly ReviewImage[], max: number = REVIEW_STRIP_MAX): { tiles: ReviewImage[]; more: number; firstHidden: string | null } {
  const newest = [...images].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { tiles: newest.slice(0, max), more: Math.max(0, newest.length - max), firstHidden: newest[max]?.name ?? null };
}

export function reviewImageKind(name: string): ReviewImage['kind'] {
  if (/-sheet\.png$/i.test(name)) return 'sheet';
  return /^crop-/i.test(name) ? 'crop' : 'frame';
}

/** Has the rendered video changed since the human approved it? */
export function sameVideoFile(a: VideoFile | null, b: { size: number; mtimeMs: number } | null): boolean {
  return a !== null && b !== null && a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}
