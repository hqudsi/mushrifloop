// Shared by every script: paths, arguments, the storyboard data file, small file helpers.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'out');
export const FRAMES = path.join(OUT, 'frames');
export const REVIEW = path.join(OUT, 'review');
export const DIST = path.join(ROOT, 'dist');

/** Exit codes the scripts share. 3: not finished yet, run the same command again. 4: a render is already running here. */
export const EXIT = { ok: 0, failed: 1, invalid: 2, incomplete: 3, locked: 4 };

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** `--key value`, `--key=value` and bare `--flag` (true). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = true;
  }
  return out;
}

export function intArg(value, name, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`--${name} must be a whole number, got "${value}".`, EXIT.invalid);
  return n;
}

export function fail(message, code = EXIT.failed) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

/** Write to a temporary name and rename, so nobody ever reads half a file. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const isInt = (v) => Number.isInteger(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/** Every problem in a storyboard object, as sentences. An empty list means it is usable. */
export function storyboardProblems(sb) {
  const problems = [];
  if (sb === null || typeof sb !== 'object' || Array.isArray(sb)) return ['storyboard.json must be an object.'];
  if (!isText(sb.title)) problems.push('title must be text.');
  for (const key of ['width', 'height']) {
    if (!isInt(sb[key]) || sb[key] < 16 || sb[key] > 7680 || sb[key] % 2 !== 0) problems.push(`${key} must be an even whole number between 16 and 7680 (H.264 needs even sizes).`);
  }
  if (!isInt(sb.fps) || sb.fps < 1 || sb.fps > 120) problems.push('fps must be a whole number between 1 and 120.');
  if (!isInt(sb.durationInFrames) || sb.durationInFrames < 1) problems.push('durationInFrames must be a whole number, at least 1.');
  if (!Array.isArray(sb.shots) || sb.shots.length === 0) {
    problems.push('shots must be a list with at least one shot.');
    return problems;
  }
  if (problems.length > 0) return problems;

  const shotIds = new Set();
  const textIds = new Set();
  let expectedStart = 0;
  sb.shots.forEach((shot, index) => {
    const where = `shots[${index}]${isText(shot?.id) ? ` (${shot.id})` : ''}`;
    if (shot === null || typeof shot !== 'object') return problems.push(`${where} must be an object.`);
    if (!isText(shot.id)) problems.push(`${where}: id must be text.`);
    else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(shot.id)) problems.push(`${where}: id may hold letters, digits, "-" and "_" only (it becomes part of file names).`);
    else if (shotIds.has(shot.id)) problems.push(`${where}: the id is used twice.`);
    else shotIds.add(shot.id);
    if (!isText(shot.name)) problems.push(`${where}: name must be text.`);
    if (!isText(shot.onScreen)) problems.push(`${where}: onScreen must say what is on screen.`);
    if (!isInt(shot.startFrame) || !isInt(shot.endFrame) || shot.startFrame > shot.endFrame) {
      problems.push(`${where}: startFrame and endFrame must be whole numbers, startFrame not after endFrame (both inclusive).`);
      return;
    }
    if (shot.startFrame !== expectedStart) problems.push(`${where}: startFrame is ${shot.startFrame}, but the shot before it ends at ${expectedStart - 1}; shots must follow each other without gaps or overlaps, starting at frame 0.`);
    expectedStart = shot.endFrame + 1;
    if (!Array.isArray(shot.reviewFrames) || shot.reviewFrames.length === 0) problems.push(`${where}: reviewFrames must list at least one frame.`);
    else if (shot.reviewFrames.some((f) => !isInt(f) || f < shot.startFrame || f > shot.endFrame)) problems.push(`${where}: every review frame must be a whole number inside the shot (${shot.startFrame}–${shot.endFrame}).`);
    if (!Array.isArray(shot.acceptance) || shot.acceptance.length < 3 || shot.acceptance.length > 5 || !shot.acceptance.every(isText)) problems.push(`${where}: acceptance must be a list of 3 to 5 checks.`);
    if (!Array.isArray(shot.texts)) problems.push(`${where}: texts must be a list (empty when the shot has no text).`);
    else {
      shot.texts.forEach((t, ti) => {
        const tw = `${where} texts[${ti}]`;
        if (t === null || typeof t !== 'object') return problems.push(`${tw} must be an object.`);
        if (!isText(t.id)) problems.push(`${tw}: id must be text.`);
        else if (textIds.has(t.id)) problems.push(`${tw}: the id "${t.id}" is used twice.`);
        else textIds.add(t.id);
        if (!isText(t.text)) problems.push(`${tw}: text must be the exact words on screen.`);
        if (!isText(t.lang)) problems.push(`${tw}: lang must be a language tag such as "en" or "ar".`);
        if (!isInt(t.startFrame) || !isInt(t.endFrame) || t.startFrame > t.endFrame || t.startFrame < shot.startFrame || t.endFrame > shot.endFrame) {
          problems.push(`${tw}: startFrame and endFrame must be whole numbers inside the shot (${shot.startFrame}–${shot.endFrame}).`);
        }
      });
    }
  });
  if (expectedStart !== sb.durationInFrames) problems.push(`The last shot ends at frame ${expectedStart - 1}, but durationInFrames is ${sb.durationInFrames}: the last frame must be ${sb.durationInFrames - 1}.`);
  return problems;
}

/** Read and check storyboard.json. Exits with the list of problems when it is not usable. */
export function readStoryboard() {
  const file = path.join(ROOT, 'storyboard.json');
  let sb;
  try {
    sb = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`storyboard.json could not be read: ${err.message}`, EXIT.invalid);
  }
  const problems = storyboardProblems(sb);
  if (problems.length > 0) {
    console.error('storyboard.json is not valid:');
    for (const p of problems) console.error(`- ${p}`);
    process.exit(EXIT.invalid);
  }
  return sb;
}

/** Text stays on screen at least 0.35 s per word and never under 1 s. */
export function minimumSeconds(words) {
  return Math.max(1, Math.round(words * 0.35 * 100) / 100);
}

export function timingReport(sb) {
  const round = (n) => Math.round(n * 100) / 100;
  const warnings = [];
  const shots = sb.shots.map((shot) => ({
    id: shot.id,
    name: shot.name,
    startFrame: shot.startFrame,
    endFrame: shot.endFrame,
    durationSec: round((shot.endFrame - shot.startFrame + 1) / sb.fps),
    texts: shot.texts.map((t) => {
      const words = t.text.trim().split(/\s+/).length;
      const secondsOnScreen = round((t.endFrame - t.startFrame + 1) / sb.fps);
      const minimum = minimumSeconds(words);
      const ok = secondsOnScreen >= minimum;
      if (!ok) warnings.push(`${shot.id} / ${t.id}: ${words} word(s) on screen for ${secondsOnScreen} s; the minimum is ${minimum} s.`);
      return { id: t.id, text: t.text, lang: t.lang, words, startFrame: t.startFrame, endFrame: t.endFrame, secondsOnScreen, minimumSeconds: minimum, ok };
    }),
  }));
  return { fps: sb.fps, durationInFrames: sb.durationInFrames, durationSec: round(sb.durationInFrames / sb.fps), shots, warnings };
}
