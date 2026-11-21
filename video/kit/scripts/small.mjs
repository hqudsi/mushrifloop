// npm run small [-- --mb 9.5] [--width 1280]
//
// A second, smaller copy of the finished video: out/video-small.mp4, made to fit under a size limit
// (default 9.5 MB, safely under the 10 MB that GitHub accepts for a video attached to an issue, a pull
// request or a README). out/video.mp4 is not touched. It does not render: run "npm run render" first.
//
// The size is reached by giving the encoder a fixed budget (two passes) instead of a fixed quality.
// When the budget is too small for the picture size, the copy is also scaled down: below about
// 1.5 Mbit/s to 1280 px wide, below about 0.7 Mbit/s to 854 px. --width sets the width yourself.

import fs from 'node:fs';
import path from 'node:path';

import { EXIT, FRAMES, OUT, ROOT, fail, intArg, pad, parseArgs, readStoryboard, writeJson } from './lib/common.mjs';
import { findFfmpeg, runFfmpeg } from './lib/ffmpeg.mjs';
import { lockHolder, lockMessage } from './lib/lock.mjs';

const args = parseArgs();
const sb = readStoryboard();
const total = sb.durationInFrames;
const seconds = total / sb.fps;
const limitMb = Number(args.mb ?? 9.5);
if (!Number.isFinite(limitMb) || limitMb <= 0) fail(`--mb must be a number above 0, got "${args.mb}".`, EXIT.invalid);
const limitBytes = Math.floor(limitMb * 1024 * 1024);

// A render that is still running may be about to replace the frames this would read.
const rendering = lockHolder();
if (rendering) fail(lockMessage(rendering), EXIT.locked);

const missing = [];
for (let n = 0; n < total; n++) if (!fs.existsSync(path.join(FRAMES, `${pad(n, 6)}.png`))) missing.push(n);
if (missing.length > 0) fail(`${missing.length} of ${total} frames are not rendered yet (first: ${missing[0]}). Run "npm run render" until it prints DONE, then this again.`);

const ffmpeg = await findFfmpeg();
if (!ffmpeg || !ffmpeg.libx264) fail('No ffmpeg with libx264 was found. Run "npm run setup".');

// The whole file must fit: leave 3 % for the container and for the encoder missing its target.
let bitrate = Math.floor((limitBytes * 8 * 0.97) / seconds);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
let width = sb.width;
if (args.width !== undefined) width = intArg(args.width, 'width', sb.width);
else if (bitrate < 700_000) width = Math.min(sb.width, 854);
else if (bitrate < 1_500_000) width = Math.min(sb.width, 1280);
if (width < 16 || width > sb.width) fail(`--width must be between 16 and the video's ${sb.width}.`, EXIT.invalid);
width = even(width);
const height = even((width * sb.height) / sb.width);

const small = path.join(OUT, 'video-small.mp4');
const tmp = path.join(OUT, `video-small.tmp-${process.pid}.mp4`);
const passLog = path.join(OUT, `small-pass-${process.pid}`);
const cleanUp = () => {
  fs.rmSync(tmp, { force: true });
  for (const f of fs.readdirSync(OUT)) if (f.startsWith(path.basename(passLog))) fs.rmSync(path.join(OUT, f), { force: true });
};

const encode = async (rate) => {
  const common = [
    '-y',
    '-framerate', String(sb.fps),
    '-start_number', '0',
    '-i', path.join(FRAMES, '%06d.png'),
    '-frames:v', String(total),
    '-vf', `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-b:v', String(rate),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-an',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    '-passlogfile', passLog,
  ];
  const first = await runFfmpeg(ffmpeg.path, [...common, '-pass', '1', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null']);
  if (first.code !== 0) return first;
  return runFfmpeg(ffmpeg.path, [...common, '-pass', '2', '-movflags', '+faststart', tmp]);
};

let size = 0;
for (let attempt = 1; attempt <= 3; attempt++) {
  const result = await encode(bitrate);
  if (result.code !== 0) {
    cleanUp();
    fail(`ffmpeg failed (exit ${result.code}): ${result.stderr}`);
  }
  size = fs.statSync(tmp).size;
  if (size <= limitBytes) break;
  // Over the limit: the encoder overshot. Try again with the budget cut by as much as it was over.
  bitrate = Math.floor(bitrate * (limitBytes / size) * 0.97);
}
if (size > limitBytes) {
  cleanUp();
  fail(`Could not get under ${limitMb} MB (the last try was ${(size / 1024 / 1024).toFixed(2)} MB). Try a smaller picture: npm run small -- --width ${even(width * 0.66)}`);
}
fs.renameSync(tmp, small);
cleanUp();
const rel = path.relative(ROOT, small).replace(/\\/g, '/');
const mbps = (size * 8) / seconds / 1e6;
writeJson(path.join(OUT, 'small.json'), { file: rel, sizeBytes: size, width, height, fps: sb.fps, durationSec: Math.round(seconds * 1000) / 1000, bitrateMbps: Math.round(mbps * 100) / 100, limitMb });
console.log(`DONE: ${rel} — ${(size / 1024 / 1024).toFixed(2)} MB (limit ${limitMb} MB), ${width}×${height}, ${mbps.toFixed(2)} Mbit/s. out/video.mp4 is unchanged.`);
if (mbps < 1) console.log('NOTE: under 1 Mbit/s fine detail and grain are smoothed away. Watch the small copy before sharing it.');
