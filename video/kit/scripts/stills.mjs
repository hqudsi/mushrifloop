// npm run stills                      a contact sheet of every shot's review frames
// npm run stills -- --shot shot-02    one shot (its id, or its number: 2)
// npm run stills -- --frame 45        one frame at full size (any frame, not only a review frame)
// npm run stills -- --frame 45 --crop 600,300,720,400 [--scale 2]    one region of one frame, enlarged
// npm run stills -- --full            the sheets, and every review frame at full size beside them
//
// Writes into out/review/: <shot>-sheet.png (a labelled contact sheet) and timing.json (per shot its
// length; per text its words and seconds on screen). A frame at full size (<shot>-f0045.png) is written
// only when it is asked for: an image costs the agent that opens it by its pixels, in that turn and in
// every later one of the session, so the small sheet comes first and a large frame is for one detail.

import fs from 'node:fs';
import path from 'node:path';

import { chooseOption, composeCrop, composeSheet, openSession } from './lib/browser.mjs';
import { EXIT, REVIEW, ROOT, fail, intArg, pad, parseArgs, readStoryboard, timingReport, writeFileAtomic, writeJson } from './lib/common.mjs';
import { buildSite, serve } from './lib/site.mjs';

/** The width of one frame on a contact sheet, for a wide or square video and for an upright one. */
const SHEET_CELL = { wide: 480, upright: 270 };

const args = parseArgs();
const sb = readStoryboard();
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const full = args.full === true;

fs.mkdirSync(REVIEW, { recursive: true });
const timing = timingReport(sb);
writeJson(path.join(REVIEW, 'timing.json'), timing);

let shots = sb.shots;
if (args.shot !== undefined && args.shot !== true) {
  const wanted = String(args.shot);
  const byNumber = /^\d+$/.test(wanted) ? sb.shots[Number(wanted) - 1] : undefined;
  const found = sb.shots.find((s) => s.id === wanted) ?? byNumber;
  if (!found) fail(`No shot "${wanted}". Shots: ${sb.shots.map((s) => s.id).join(', ')}.`, EXIT.invalid);
  shots = [found];
}

let crop = null;
let oneFrame = null;
if (args.crop !== undefined) {
  const parts = String(args.crop).split(',').map(Number);
  const frame = intArg(args.frame, 'frame', NaN);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0) || !Number.isInteger(frame)) {
    fail('A crop needs --frame <n> and --crop x,y,width,height in whole pixels of the video.', EXIT.invalid);
  }
  const [x, y, w, h] = parts;
  if (frame < 0 || frame >= sb.durationInFrames || w < 8 || h < 8 || x + w > sb.width || y + h > sb.height) {
    fail(`The crop must lie inside the ${sb.width}×${sb.height} frame, and the frame inside 0–${sb.durationInFrames - 1}.`, EXIT.invalid);
  }
  const scale = Math.max(1, Math.min(8, Number(args.scale ?? Math.max(1, Math.floor(1280 / w)))));
  crop = { frame, x, y, w, h, scale };
} else if (args.frame !== undefined) {
  const frame = intArg(args.frame, 'frame', NaN);
  if (!Number.isInteger(frame) || frame < 0 || frame >= sb.durationInFrames) {
    fail(`--frame needs one whole frame number inside 0–${sb.durationInFrames - 1}.`, EXIT.invalid);
  }
  oneFrame = frame;
}

const { fingerprint } = await buildSite();
const site = await serve();
let session;
try {
  const { option } = await chooseOption({ quiet: true });
  session = await openSession({ option, url: site.url, width: sb.width, height: sb.height });
  const sketch = await session.sketchPage();
  const toDataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;
  const written = [];

  if (crop) {
    const png = await session.frame(crop.frame);
    const out = await composeCrop(sketch, { dataUrl: toDataUrl(png), ...crop });
    const file = path.join(REVIEW, `crop-f${pad(crop.frame, 4)}-${crop.x}_${crop.y}_${crop.w}x${crop.h}.png`);
    writeFileAtomic(file, out);
    written.push(file);
  } else if (oneFrame !== null) {
    const shot = sb.shots.find((s) => oneFrame >= s.startFrame && oneFrame <= s.endFrame);
    const file = path.join(REVIEW, `${shot ? shot.id : 'frame'}-f${pad(oneFrame, 4)}.png`);
    writeFileAtomic(file, await session.frame(oneFrame));
    written.push(file);
  } else {
    for (const shot of shots) {
      // A new sheet replaces everything of this shot: a full-size frame from before the change would be stale.
      for (const old of fs.readdirSync(REVIEW)) {
        if (old.startsWith(`${shot.id}-`) && old.endsWith('.png')) fs.rmSync(path.join(REVIEW, old));
      }
      const frames = [...new Set(shot.reviewFrames)].sort((a, b) => a - b);
      const cells = [];
      for (const f of frames) {
        const png = await session.frame(f);
        if (full) {
          const file = path.join(REVIEW, `${shot.id}-f${pad(f, 4)}.png`);
          writeFileAtomic(file, png);
          written.push(file);
        }
        cells.push({ label: `${shot.id} · frame ${f} · ${(f / sb.fps).toFixed(2)} s`, dataUrl: toDataUrl(png) });
      }
      const aspect = sb.width / sb.height;
      const columns = frames.length === 1 ? 1 : aspect < 1 ? Math.min(frames.length, 4) : 2;
      const cellWidth = aspect < 1 ? SHEET_CELL.upright : SHEET_CELL.wide;
      const sheet = await composeSheet(sketch, {
        title: `${shot.id} — ${shot.name} — frames ${shot.startFrame}–${shot.endFrame} (${((shot.endFrame - shot.startFrame + 1) / sb.fps).toFixed(2)} s)`,
        cells,
        cellWidth,
        cellHeight: Math.round(cellWidth / aspect),
        columns,
      });
      const sheetFile = path.join(REVIEW, `${shot.id}-sheet.png`);
      writeFileAtomic(sheetFile, sheet);
      written.unshift(sheetFile);
    }
  }

  console.log(`Rendered with ${option.id} (${session.info.renderer ?? 'unknown renderer'}); build ${fingerprint.slice(0, 12)}.`);
  console.log('Review images:');
  for (const file of written) console.log(`  ${rel(file)}`);
  console.log(`  ${rel(path.join(REVIEW, 'timing.json'))}`);
  if (!crop && oneFrame === null && !full) {
    console.log('No frame was written at full size. For one frame: npm run stills -- --frame <n>. For one detail, add --crop x,y,width,height.');
  }
  for (const warning of timing.warnings) console.log(`TIMING: ${warning}`);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = EXIT.failed;
} finally {
  await session?.close();
  await site.close();
}
