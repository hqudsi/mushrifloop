// npm run gif [-- --from 0 --to 149 --fps 15 --width 640]
//
// A GIF from a range of the PNG frames that `npm run render` wrote. It does not render: run render
// first. Writes out/video.gif.

import fs from 'node:fs';
import path from 'node:path';

import { EXIT, FRAMES, OUT, ROOT, fail, intArg, pad, parseArgs, readStoryboard } from './lib/common.mjs';
import { findFfmpeg, runFfmpeg } from './lib/ffmpeg.mjs';
import { lockHolder, lockMessage } from './lib/lock.mjs';

const args = parseArgs();
const sb = readStoryboard();
const from = intArg(args.from, 'from', 0);
const to = intArg(args.to, 'to', sb.durationInFrames - 1);
const fps = intArg(args.fps, 'fps', Math.min(15, sb.fps));
const width = intArg(args.width, 'width', Math.min(640, sb.width));
if (from < 0 || to >= sb.durationInFrames || from > to) fail(`--from and --to must lie inside 0–${sb.durationInFrames - 1}, --from not after --to.`, EXIT.invalid);
if (fps < 1 || fps > sb.fps) fail(`--fps must be between 1 and the video's ${sb.fps}.`, EXIT.invalid);
if (width < 16 || width > sb.width) fail(`--width must be between 16 and the video's ${sb.width}.`, EXIT.invalid);

// A render that is still running may be about to replace the frames this would read.
const rendering = lockHolder();
if (rendering) fail(lockMessage(rendering), EXIT.locked);

const missing = [];
for (let n = from; n <= to; n++) if (!fs.existsSync(path.join(FRAMES, `${pad(n, 6)}.png`))) missing.push(n);
if (missing.length > 0) fail(`${missing.length} frame(s) of ${from}–${to} are not rendered yet (first: ${missing[0]}). Run "npm run render" until it prints DONE, then this again.`);

const ffmpeg = await findFfmpeg();
if (!ffmpeg) fail('No ffmpeg was found. Run "npm run setup".');

const gif = path.join(OUT, 'video.gif');
const tmp = path.join(OUT, `video.tmp-${process.pid}.gif`);
const result = await runFfmpeg(ffmpeg.path, [
  '-y',
  '-framerate', String(sb.fps),
  '-start_number', String(from),
  '-i', path.join(FRAMES, '%06d.png'),
  '-frames:v', String(to - from + 1),
  '-filter_complex', `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`,
  '-loop', '0',
  '-fflags', '+bitexact',
  tmp,
]);
if (result.code !== 0) {
  fs.rmSync(tmp, { force: true });
  fail(`ffmpeg failed (exit ${result.code}): ${result.stderr}`);
}
fs.renameSync(tmp, gif);
console.log(`DONE: ${path.relative(ROOT, gif).replace(/\\/g, '/')} — frames ${from}–${to} at ${fps} fps, ${width} px wide, ${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB.`);
