// npm run doctor [-- --all] [--headed] [--choose <option id>] [--code <text>]
//
// Checks what a render needs and writes out/doctor.json: Node, Playwright and three versions; ffmpeg
// and whether it has libx264; which browser options launch and the WebGL renderer each one reports;
// and the time for 12 frames of the video with the option that was chosen.
//
//   --all      measure every option that launches, not only the first hardware one
//   --headed   include the options that open a visible window (skipped otherwise unless needed)
//   --choose   use this option from now on, whatever the ladder would pick
//   --code     also write out/doctor/code.png showing this text

import fs from 'node:fs';
import path from 'node:path';

import { OPTIONS, browserName, composeCode, hasDownloadedChromium, loadPlaywright, openSession, optionById, playwrightVersion, probeOption } from './lib/browser.mjs';
import { EXIT, OUT, ROOT, fail, parseArgs, readJson, readStoryboard, writeFileAtomic, writeJson } from './lib/common.mjs';
import { findFfmpeg } from './lib/ffmpeg.mjs';
import { buildSite, serve } from './lib/site.mjs';

// Enough for an estimate. The sample is drawn with the style toolkit, so its time per frame is close to
// what a real scene costs on this computer (most of it is drawing detail and encoding the PNG).
const TIMED_FRAMES = 12;
const args = parseArgs();
const all = args.all === true;
const forced = typeof args.choose === 'string' ? optionById(args.choose) : null;
if (typeof args.choose === 'string' && !forced) fail(`Unknown option "${args.choose}". Options: ${OPTIONS.map((o) => o.id).join(', ')}.`, EXIT.invalid);

const sb = readStoryboard();
const problems = [];
const warnings = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) problems.push(`Node.js ${process.versions.node} is too old; version 20 or newer is needed.`);

const ffmpeg = await findFfmpeg();
if (!ffmpeg) problems.push('No ffmpeg was found on PATH. Run "npm run setup" to install one into this folder.');
else if (!ffmpeg.libx264) problems.push(`The ffmpeg found (${ffmpeg.path}) has no libx264 encoder. Run "npm run setup" to install one that has.`);

console.log('Browsers:');
const probes = [];
let chosen = null;
const headless = OPTIONS.filter((o) => o.launch.headless);
const headed = OPTIONS.filter((o) => !o.launch.headless);
for (const option of headless) {
  if (!all && chosen?.probe.hardware) break;
  const probe = await probeOption(option);
  probes.push(probe);
  console.log(`  ${option.id}: ${probe.launched ? `${probe.renderer ?? 'no WebGL 2'}${probe.hardware ? '' : ' (software)'}` : `not available (${probe.error})`}`);
  if (probe.launched && probe.webgl2 && (!chosen || (probe.hardware && !chosen.probe.hardware))) chosen = { option, probe };
}
// A visible window is the last resort: only when nothing headless has a hardware renderer, or on request.
if (args.headed === true || !chosen?.probe.hardware) {
  for (const option of headed) {
    if (args.headed !== true && chosen?.probe.hardware) break;
    const probe = await probeOption(option);
    probes.push(probe);
    console.log(`  ${option.id}: ${probe.launched ? `${probe.renderer ?? 'no WebGL 2'}${probe.hardware ? '' : ' (software)'}` : `not available (${probe.error})`}`);
    if (probe.launched && probe.webgl2 && (!chosen || (probe.hardware && !chosen.probe.hardware))) chosen = { option, probe };
  }
}
if (forced) {
  const probe = probes.find((p) => p.id === forced.id) ?? (await probeOption(forced));
  if (!probes.includes(probe)) probes.push(probe);
  if (probe.launched && probe.webgl2) chosen = { option: forced, probe };
  else problems.push(`The option asked for with --choose (${forced.id}) does not work here: ${probe.error ?? 'no WebGL 2'}.`);
}
if (!chosen) problems.push('No browser could be launched with WebGL 2. Run "npm run setup -- --download-browser", or install Microsoft Edge or Google Chrome.');
else if (!chosen.probe.hardware) warnings.push(`No hardware WebGL renderer was found; rendering uses software (${chosen.probe.renderer}) and is slower.`);

// Time the frames through the real pipeline: render, read the canvas back, bring the PNG to Node.
const timings = [];
if (chosen) {
  let site = null;
  try {
    await buildSite();
    site = await serve();
    const toTime = all ? probes.filter((p) => p.launched && p.webgl2).map((p) => optionById(p.id)) : [chosen.option];
    for (const option of toTime) {
      let session = null;
      try {
        session = await openSession({ option, url: site.url, width: sb.width, height: sb.height });
        await session.frame(0);
        const started = Date.now();
        let bytes = 0;
        // Spread over the video, so one unusually cheap or dear stretch does not decide the estimate.
        const step = Math.max(1, Math.floor(sb.durationInFrames / TIMED_FRAMES));
        for (let i = 0; i < TIMED_FRAMES; i++) bytes += (await session.frame((i * step) % sb.durationInFrames)).length;
        const ms = Date.now() - started;
        const timing = { id: option.id, frames: TIMED_FRAMES, totalMs: ms, msPerFrame: Math.round((ms / TIMED_FRAMES) * 10) / 10, averagePngBytes: Math.round(bytes / TIMED_FRAMES) };
        timings.push(timing);
        console.log(`  ${option.id}: ${TIMED_FRAMES} frames at ${sb.width}×${sb.height} in ${(ms / 1000).toFixed(1)} s (${timing.msPerFrame} ms per frame)`);
        if (option.id === chosen.option.id && typeof args.code === 'string') {
          const page = await session.sketchPage();
          writeFileAtomic(path.join(OUT, 'doctor', 'code.png'), await composeCode(page, args.code));
        }
      } catch (err) {
        timings.push({ id: option.id, frames: 0, totalMs: null, msPerFrame: null, averagePngBytes: null, error: err.message.split('\n')[0] });
        if (option.id === chosen.option.id) problems.push(`The sample frames could not be rendered with ${option.id}: ${err.message}`);
      } finally {
        await session?.close();
      }
    }
  } catch (err) {
    problems.push(`The page could not be built: ${err.message}`);
  } finally {
    await site?.close();
  }
}

await loadPlaywright().catch(() => problems.push('Playwright is not installed. Run "npm ci" in this folder.'));

const chosenTiming = chosen ? timings.find((t) => t.id === chosen.option.id) : null;
const report = {
  ok: problems.length === 0,
  problems,
  warnings,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  playwright: playwrightVersion(),
  three: readJson(path.join(ROOT, 'node_modules', 'three', 'package.json'))?.version ?? null,
  ffmpeg: ffmpeg ? { source: ffmpeg.source, path: ffmpeg.path, version: ffmpeg.version, libx264: ffmpeg.libx264 } : null,
  downloadedChromium: hasDownloadedChromium(),
  chosen: chosen?.option.id ?? null,
  browser: chosen ? browserName(chosen.option.id) : null,
  browserInstalledOrDownloaded: chosen ? (chosen.option.launch.channel === 'chromium' ? 'downloaded' : 'installed') : null,
  chosenForced: forced !== null && chosen?.option.id === forced.id,
  renderer: chosen?.probe.renderer ?? null,
  hardware: chosen?.probe.hardware ?? false,
  browserVersion: chosen?.probe.browserVersion ?? null,
  video: { width: sb.width, height: sb.height, fps: sb.fps, durationInFrames: sb.durationInFrames },
  msPerFrame: chosenTiming?.msPerFrame ?? null,
  estimatedRenderSeconds: chosenTiming?.msPerFrame ? Math.ceil((chosenTiming.msPerFrame * sb.durationInFrames) / 1000) : null,
  options: probes,
  timings,
  codeImage: typeof args.code === 'string' && fs.existsSync(path.join(OUT, 'doctor', 'code.png')) ? 'out/doctor/code.png' : null,
};
writeJson(path.join(OUT, 'doctor.json'), report);

console.log('');
console.log(`Node ${report.node} · ${report.playwright ?? 'Playwright missing'} · three ${report.three ?? 'missing'}`);
console.log(`ffmpeg: ${ffmpeg ? `${ffmpeg.version} [${ffmpeg.source}]${ffmpeg.libx264 ? ', libx264' : ', NO libx264'}` : 'not found'}`);
console.log(`Chosen: ${report.chosen ? `${report.browser} ${report.browserVersion} (${report.chosen})` : 'none'}${report.renderer ? ` — ${report.renderer}` : ''}${report.msPerFrame ? ` — ${report.msPerFrame} ms per frame, about ${report.estimatedRenderSeconds} s for this video` : ''}`);
for (const w of warnings) console.log(`WARNING: ${w}`);
for (const p of problems) console.error(`PROBLEM: ${p}`);
console.log(report.ok ? 'OK: this folder can render. Written to out/doctor.json.' : 'NOT READY. Written to out/doctor.json.');
process.exit(report.ok ? EXIT.ok : EXIT.failed);
