// npm test [-- --a 45 --b 120] [--no-style]
//
// The determinism test. It renders frame A, frame A again, frame B, then A once more (out of order)
// and B again, then both once more in a newly started browser, and compares SHA-256 hashes of the PNG
// bytes. A scene that keeps state between frames, reads a clock or uses Math.random() fails here.
//
// It tests two pages: the video, and the style toolkit's own test scene (style-test.html), which
// uses every part of src/style: cel shading, painted textures, windows, facades, props, outlines,
// reflections, glows, ink edges, bloom, grade and grain. So the toolkit is covered whatever the video
// itself uses. When that scene fails, each part is rendered alone to name the one that differs.
//
// Both pages are rendered in the first browser, then both again in the second: two launches in all.

import { chooseOption, openSession } from './lib/browser.mjs';
import { EXIT, intArg, parseArgs, readStoryboard, sha256 } from './lib/common.mjs';
import { buildSite, serve } from './lib/site.mjs';

const STYLE = { name: 'The style toolkit (style-test.html)', page: 'style-test.html', width: 960, height: 540, a: 14, b: 47 };
const STYLE_PARTS = ['toon', 'paint', 'windows', 'facade', 'props', 'outline', 'reflect', 'glow', 'edges', 'bloom', 'grade', 'grain'];

const args = parseArgs();
const sb = readStoryboard();
const last = sb.durationInFrames - 1;
const a = intArg(args.a, 'a', Math.min(last, Math.round(last * 0.3)));
const b = intArg(args.b, 'b', Math.min(last, Math.round(last * 0.8)));

/** Renders `frames` of each target, every target in the same newly started browser. Returns the hashes per target. */
async function round(option, targets, framesOf) {
  const out = [];
  let first = null;
  try {
    for (const target of targets) {
      const session = await openSession({ option, url: target.url, width: target.width, height: target.height, browser: first?.browser ?? null });
      first ??= session;
      const hashes = [];
      for (const n of framesOf(target)) hashes.push(sha256(await session.frame(n)));
      out.push({ hashes, renderer: session.info.renderer });
      if (session !== first) await session.close();
    }
  } finally {
    await first?.close();
  }
  return out;
}

/** The whole test for a list of targets. Returns the problems per target, in order. */
async function check(option, targets, { quiet = false } = {}) {
  const firstBrowser = await round(option, targets, (t) => [t.a, t.a, t.b, t.a, t.b]);
  // A render that is stopped and resumed continues in a new browser, so the same frame must also give
  // the same image after a fresh launch.
  const secondBrowser = await round(option, targets, (t) => [t.b, t.a]);
  return targets.map((t, i) => {
    const h = firstBrowser[i].hashes;
    const again = secondBrowser[i].hashes;
    if (!quiet) {
      console.log(`${t.name}:`);
      [t.a, t.a, t.b, t.a, t.b].forEach((n, k) => console.log(`  render ${k + 1}: frame ${n}  ${h[k]}`));
      [t.b, t.a].forEach((n, k) => console.log(`  new browser, render ${k + 1}: frame ${n}  ${again[k]}`));
      if (t.a !== t.b && h[0] === h[2]) console.log(`  note: frames ${t.a} and ${t.b} are identical images; pick frames that differ with --a and --b for a stronger test.`);
    }
    const problems = [];
    if (h[0] !== h[1]) problems.push(`frame ${t.a} rendered twice in a row gave different images`);
    if (h[0] !== h[3]) problems.push(`frame ${t.a} gave a different image after frame ${t.b} was rendered (state is kept between frames)`);
    if (h[2] !== h[4]) problems.push(`frame ${t.b} gave a different image the second time`);
    if (again[0] !== h[2]) problems.push(`frame ${t.b} gave a different image in a newly started browser`);
    if (again[1] !== h[0]) problems.push(`frame ${t.a} gave a different image in a newly started browser`);
    return { problems, renderer: firstBrowser[i].renderer };
  });
}

await buildSite();
const site = await serve();
try {
  const { option } = await chooseOption({ quiet: true });
  const withStyle = args['no-style'] !== true;
  const video = { name: 'The video', url: site.url, width: sb.width, height: sb.height, a, b };
  const style = { ...STYLE, url: `${site.url}${STYLE.page}` };
  const results = await check(option, withStyle ? [video, style] : [video]);
  const failures = [...results[0].problems];

  if (withStyle && results[1].problems.length > 0) {
    // Name the part: each one alone, the same test.
    const parts = STYLE_PARTS.map((part) => ({ ...STYLE, name: part, url: `${site.url}${STYLE.page}?only=${part}` }));
    const alone = await check(option, parts, { quiet: true });
    const guilty = STYLE_PARTS.filter((_, i) => alone[i].problems.length > 0);
    STYLE_PARTS.forEach((part, i) => console.log(`  ${part}: ${alone[i].problems.length === 0 ? 'same' : 'DIFFERENT'}`));
    for (const p of results[1].problems) failures.push(`style toolkit: ${p}${guilty.length ? ` (part: ${guilty.join(', ')})` : ' (no single part differs alone: the parts differ only together)'}`);
  }

  console.log(`Rendered with ${option.id} (${results[0].renderer ?? 'unknown renderer'}).`);
  if (failures.length > 0) {
    for (const p of failures) console.error(`FAIL: ${p}`);
    process.exitCode = EXIT.failed;
  } else {
    console.log(`PASS: the same frame gives the same image, in any order${withStyle ? ', in the video and in every part of the style toolkit' : ''}.`);
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = EXIT.failed;
} finally {
  await site.close();
}
