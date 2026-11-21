// Find an ffmpeg that can encode H.264: one on PATH with libx264 first, then the ffmpeg-static
// package (a GPL build; installed only by `npm run setup`, and only when PATH has none).
//
// ffmpeg-static is not in package.json: it would be downloaded (about 80 MB) on every `npm ci`,
// needed or not. `npm run setup` installs it into its own folder under node_modules instead.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ROOT } from './common.mjs';

export const FFMPEG_STATIC_VERSION = '5.3.0';
/** A dot folder: npm leaves it alone when it installs or prunes packages. */
export const FFMPEG_TOOLS = path.join(ROOT, 'node_modules', '.video-tools', 'ffmpeg');

function ffmpegStaticPath() {
  if (!fs.existsSync(path.join(FFMPEG_TOOLS, 'package.json'))) return null;
  try {
    const found = createRequire(path.join(FFMPEG_TOOLS, 'package.json'))('ffmpeg-static');
    return typeof found === 'string' && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

function inspect(binary) {
  const version = spawnSync(binary, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) return null;
  const encoders = spawnSync(binary, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  return {
    path: binary,
    version: (version.stdout.split('\n')[0] ?? '').trim(),
    libx264: !encoders.error && /\blibx264\b/.test(encoders.stdout),
  };
}

/** `{ path, version, libx264, source }` for the ffmpeg to use, or null when there is none at all. */
export async function findFfmpeg() {
  const candidates = [];
  if (process.env.VIDEO_FFMPEG) candidates.push({ binary: process.env.VIDEO_FFMPEG, source: 'VIDEO_FFMPEG' });
  candidates.push({ binary: 'ffmpeg', source: 'PATH' });
  const bundled = ffmpegStaticPath();
  if (bundled) candidates.push({ binary: bundled, source: 'ffmpeg-static' });
  let fallback = null;
  for (const c of candidates) {
    const found = inspect(c.binary);
    if (!found) continue;
    if (found.libx264) return { ...found, source: c.source };
    fallback ??= { ...found, source: c.source };
  }
  return fallback;
}

/** Run ffmpeg; resolves with its exit code and the end of its stderr. */
export function runFfmpeg(binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));
    child.on('error', (err) => resolve({ code: null, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}
