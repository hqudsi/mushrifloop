// npm run render [-- --budget-seconds 480] [--no-encode]
//
// Renders every frame to out/frames/000000.png …, then encodes out/video.mp4 (H.264, yuv420p,
// faststart, no audio stream).
//
// It resumes. Frames already on disk are kept as long as the built page (scene code, storyboard data,
// fonts) and the browser are the same; when either changed, they are thrown away. A run stops after
// its time budget with exit code 3 and the line "INCOMPLETE: …": run the same command again until it
// prints "DONE". Nothing is lost when a run is stopped from outside: each frame is written whole.
//
// The last line reports the file size and bitrate; they are also in out/render.json. A file over 10 MB
// (the limit for a video attached on GitHub) gets a WARNING line with the command for a smaller copy.
//
// Only one render runs at a time: a second one started beside it exits at once with code 4 and a line
// starting "LOCKED". A lock left by a run that was killed is cleared by the next run.

import fs from 'node:fs';
import path from 'node:path';

import { browserName, chooseOption, openSession } from './lib/browser.mjs';
import { EXIT, FRAMES, OUT, ROOT, intArg, pad, parseArgs, readJson, readStoryboard, sha256, writeFileAtomic, writeJson } from './lib/common.mjs';
import { findFfmpeg, runFfmpeg } from './lib/ffmpeg.mjs';
import { lockOrExit } from './lib/lock.mjs';
import { buildSite, serve } from './lib/site.mjs';

const startedAt = Date.now();
const args = parseArgs();
// One render at a time in this folder: a second one exits here, before it builds or opens a browser.
lockOrExit('render', EXIT.locked);
const budgetMs = intArg(args['budget-seconds'], 'budget-seconds', 480) * 1000;
const sb = readStoryboard();
const total = sb.durationInFrames;
/** GitHub accepts a video attached to an issue, a pull request or a README up to this size. */
const ATTACH_LIMIT_BYTES = 10 * 1024 * 1024;
const frameFile = (n) => path.join(FRAMES, `${pad(n, 6)}.png`);
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

const { fingerprint: build } = await buildSite();
const site = await serve();
let session;
let complete = false;
try {
  const { option } = await chooseOption({ quiet: true });
  session = await openSession({ option, url: site.url, width: sb.width, height: sb.height });
  // Pixels depend on the browser and the GPU too, so they are part of what the frames are valid for.
  // An installed browser updates itself: when its version changes, every frame is rendered again, so
  // one video never mixes frames from two browser versions.
  const fingerprint = sha256([build, browserName(option.id), session.browserVersion, option.id, session.info.renderer ?? ''].join('\n'));

  const manifestFile = path.join(FRAMES, 'manifest.json');
  const manifest = readJson(manifestFile);
  if (manifest?.fingerprint !== fingerprint) {
    if (fs.existsSync(FRAMES)) {
      const stale = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')).length;
      const browserChanged = manifest && (manifest.browser !== option.id || manifest.browserVersion !== session.browserVersion);
      if (stale > 0) {
        console.log(
          browserChanged
            ? `The browser changed since the last render (${manifest.browserName ?? manifest.browser} ${manifest.browserVersion} → ${browserName(option.id)} ${session.browserVersion}): discarding ${stale} old frame(s).`
            : `The video changed since the last render: discarding ${stale} old frame(s).`,
        );
      }
      fs.rmSync(FRAMES, { recursive: true, force: true });
    }
    fs.mkdirSync(FRAMES, { recursive: true });
    writeJson(manifestFile, { fingerprint, build, browser: option.id, browserName: browserName(option.id), browserVersion: session.browserVersion, renderer: session.info.renderer, width: sb.width, height: sb.height, fps: sb.fps, durationInFrames: total });
    // A finished video from the old frames is no longer the video.
    for (const old of ['video.mp4', 'render.json']) fs.rmSync(path.join(OUT, old), { force: true });
  }
  // Half-written files from a run that was killed.
  for (const f of fs.readdirSync(FRAMES)) if (f.includes('.tmp-')) fs.rmSync(path.join(FRAMES, f), { force: true });

  const missing = [];
  for (let n = 0; n < total; n++) if (!fs.existsSync(frameFile(n))) missing.push(n);
  if (missing.length < total) console.log(`Resuming: ${total - missing.length} of ${total} frames are already on disk.`);

  let done = total - missing.length;
  let renderedNow = 0;
  const framesStartedAt = Date.now();
  for (const n of missing) {
    // At least one frame per run, so a budget shorter than the start-up time still makes progress.
    if (renderedNow > 0 && Date.now() - startedAt > budgetMs) break;
    writeFileAtomic(frameFile(n), await session.frame(n));
    done += 1;
    renderedNow += 1;
    if (renderedNow % 30 === 0 || done === total) console.log(`frames ${done}/${total}`);
  }
  if (done < total) {
    // Measured over the frames alone: start-up (the build, the browser) is paid once per run, not per frame.
    const perFrame = renderedNow > 1 ? (Date.now() - framesStartedAt) / renderedNow : 0;
    console.log(`INCOMPLETE: ${done} of ${total} frames done, ${total - done} left${perFrame ? ` (about ${Math.ceil(((total - done) * perFrame) / 1000)} s more)` : ''}. Run "npm run render" again to continue.`);
    process.exitCode = EXIT.incomplete;
  } else {
    complete = true;
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = EXIT.failed;
} finally {
  await session?.close();
  await site.close();
}

if (complete && args['no-encode'] !== true) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || !ffmpeg.libx264) {
    console.error(`ERROR: all ${total} frames are rendered, but ${ffmpeg ? `the ffmpeg found (${ffmpeg.path}) has no libx264` : 'no ffmpeg was found'}. Run "npm run setup", then "npm run render" again (the frames are kept).`);
    process.exit(EXIT.failed);
  }
  const mp4 = path.join(OUT, 'video.mp4');
  const tmp = path.join(OUT, `video.tmp-${process.pid}.mp4`);
  const result = await runFfmpeg(ffmpeg.path, [
    '-y',
    '-framerate', String(sb.fps),
    '-start_number', '0',
    '-i', path.join(FRAMES, '%06d.png'),
    '-frames:v', String(total),
    // sRGB frames to BT.709 video, limited range: what players assume for H.264 in MP4.
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart',
    '-an',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    tmp,
  ]);
  if (result.code !== 0) {
    fs.rmSync(tmp, { force: true });
    console.error(`ERROR: ffmpeg failed (exit ${result.code}): ${result.stderr}`);
    process.exit(EXIT.failed);
  }
  fs.renameSync(tmp, mp4);
  const bytes = fs.readFileSync(mp4);
  const report = {
    file: rel(mp4),
    frames: total,
    fps: sb.fps,
    width: sb.width,
    height: sb.height,
    durationSec: Math.round((total / sb.fps) * 1000) / 1000,
    sizeBytes: bytes.length,
    sizeMB: Math.round((bytes.length / 1024 / 1024) * 100) / 100,
    bitrateMbps: Math.round(((bytes.length * 8) / (total / sb.fps) / 1e6) * 100) / 100,
    overAttachLimit: bytes.length > ATTACH_LIMIT_BYTES,
    sha256: sha256(bytes),
    ffmpeg: { source: ffmpeg.source, version: ffmpeg.version },
  };
  writeJson(path.join(OUT, 'render.json'), report);
  console.log(`DONE: ${report.file} — ${report.durationSec} s, ${sb.width}×${sb.height} at ${sb.fps} fps, ${report.sizeMB.toFixed(2)} MB, ${report.bitrateMbps.toFixed(2)} Mbit/s.`);
  if (report.overAttachLimit) {
    console.log(`WARNING: ${report.sizeMB.toFixed(1)} MB is over 10 MB, the limit for a video attached on GitHub, and too large for most mail and chat. For a copy under 10 MB (out/video-small.mp4; this file stays as it is) run: npm run small`);
  }
} else if (complete) {
  console.log(`DONE: all ${total} frames are in ${rel(FRAMES)} (not encoded: --no-encode).`);
}
