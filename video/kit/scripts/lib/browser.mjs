// Which browser renders, and one frame at a time out of it.
//
// The options are tried in this order and the first that gives a hardware WebGL renderer is kept:
// an installed Microsoft Edge, an installed Google Chrome, then Playwright's own Chromium (only there
// after `npm run setup -- --download-browser`); each of those with ANGLE on Direct3D 11 and the GPU
// blocklist ignored; then a visible window. If none is hardware, the first that works is used and
// rendering is slower. `npm run doctor` writes the choice to out/doctor.json; the other scripts read
// it from there.
//
// Installed browsers update themselves. `render` puts the browser's name and version into the
// fingerprint of its frames, so frames from an older version are rendered again and one video never
// mixes two browser versions.

import fs from 'node:fs';
import path from 'node:path';

import { OUT, ROOT, readJson } from './common.mjs';

const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'];
const CHANNELS = ['msedge', 'chrome', 'chromium'];

export const OPTIONS = [
  ...CHANNELS.map((channel) => ({ id: channel, launch: { channel, headless: true } })),
  ...CHANNELS.map((channel) => ({ id: `${channel}-d3d11`, launch: { channel, headless: true, args: GPU_ARGS } })),
  ...CHANNELS.map((channel) => ({ id: `${channel}-headed`, launch: { channel, headless: false } })),
];

export function optionById(id) {
  return OPTIONS.find((o) => o.id === id) ?? null;
}

/** Playwright's Chromium, when downloaded, lives inside node_modules, not in the user's profile. */
export async function loadPlaywright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
  return await import('playwright-core');
}

export function playwrightVersion() {
  const pkg = readJson(path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'));
  return pkg?.version ? `playwright-core ${pkg.version}` : null;
}

const BROWSER_NAMES = { msedge: 'Microsoft Edge', chrome: 'Google Chrome', chromium: "Playwright's Chromium" };

/** "Microsoft Edge" for the option ids msedge, msedge-d3d11 and msedge-headed. */
export function browserName(optionId) {
  return BROWSER_NAMES[String(optionId).split('-')[0]] ?? String(optionId);
}

/** A software rasteriser, by the name WebGL reports. */
export function isSoftware(renderer) {
  return renderer === null || /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(renderer);
}

async function webglInfo(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { webgl2: false, vendor: null, renderer: null };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
}

/** Launch one option on a blank page and say what it is. Never throws. */
export async function probeOption(option) {
  const started = Date.now();
  let browser = null;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch(option.launch);
    const page = await browser.newPage();
    const info = await webglInfo(page);
    return {
      id: option.id,
      launched: true,
      browserVersion: browser.version(),
      webgl2: info.webgl2,
      vendor: info.vendor,
      renderer: info.renderer,
      hardware: info.webgl2 && !isSoftware(info.renderer),
      launchMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    const message = String(err?.message ?? err).split('\n')[0];
    return { id: option.id, launched: false, browserVersion: null, webgl2: false, vendor: null, renderer: null, hardware: false, launchMs: Date.now() - started, error: message };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * The option to render with: the one doctor chose, or the result of walking the ladder now.
 * Returns `{ option, probe }`, or throws when no browser can be launched at all.
 */
export async function chooseOption({ quiet = false } = {}) {
  const doctor = readJson(path.join(OUT, 'doctor.json'));
  const cached = doctor?.chosen ? optionById(doctor.chosen) : null;
  if (cached) {
    const probe = await probeOption(cached);
    if (probe.launched && probe.webgl2) return { option: cached, probe };
  }
  let firstWorking = null;
  for (const option of OPTIONS) {
    const probe = await probeOption(option);
    if (!quiet) console.log(`  ${option.id}: ${probe.launched ? `${probe.renderer ?? 'no WebGL 2'}${probe.hardware ? '' : ' (software)'}` : `not available (${probe.error})`}`);
    if (probe.launched && probe.webgl2) {
      if (probe.hardware) return { option, probe };
      firstWorking ??= { option, probe };
    }
  }
  if (firstWorking) return firstWorking;
  throw new Error('No browser could be launched with WebGL 2. Run `npm run doctor` for details, and `npm run setup` to install one.');
}

/**
 * Open the built page in render mode and wait until the video is ready.
 * `frame(n)` renders frame n and returns its PNG bytes: the canvas is read back in the same call that
 * renders it, so a frame can never be captured half drawn.
 */
export async function openSession({ option, url, width, height, browser: shared = null }) {
  const { chromium } = await loadPlaywright();
  // `browser`: a session's browser, to open a second page in the same launch. Closing this session
  // then closes only its own page; the browser belongs to the session that launched it.
  const browser = shared ?? (await chromium.launch(option.launch));
  const errors = [];
  let context = null;
  const close = async () => {
    if (shared) await context?.close().catch(() => {});
    else await browser.close().catch(() => {});
  };
  try {
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
    // A file the page asks for and does not get (a font, a texture) would silently change the picture.
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} for ${response.url()}`);
    });
    page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
    });
    // Render mode is a query parameter; a page address may already carry its own.
    const address = new URL(url);
    address.searchParams.set('render', '1');
    await page.goto(address.href, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() => typeof window.__video === 'object' && window.__video !== null, null, { timeout: 30_000 });
      await page.evaluate(() => window.__video.ready);
    } catch (err) {
      throw new Error(`The video page did not become ready: ${String(err?.message ?? err).split('\n')[0]}${errors.length ? `\nPage errors:\n- ${errors.join('\n- ')}` : ''}`);
    }
    const meta = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#video');
      return { fps: window.__video.fps, durationInFrames: window.__video.durationInFrames, canvasWidth: canvas?.width ?? 0, canvasHeight: canvas?.height ?? 0 };
    });
    if (meta.canvasWidth !== width || meta.canvasHeight !== height) {
      throw new Error(`The canvas is ${meta.canvasWidth}×${meta.canvasHeight}, but storyboard.json says ${width}×${height}.`);
    }
    const info = await webglInfo(page);

    const frame = async (n) => {
      const dataUrl = await page.evaluate((f) => {
        window.__video.renderFrame(f);
        return document.querySelector('canvas#video').toDataURL('image/png');
      }, n);
      if (errors.length > 0) throw new Error(`The page reported an error while rendering frame ${n}: ${errors[0]}`);
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    };

    /** A second, blank page in the same browser, for composing review images on a 2D canvas. */
    const sketchPage = async () => {
      const p = await context.newPage();
      await p.goto('about:blank');
      return p;
    };

    return { browser, page, meta, info, browserVersion: browser.version(), frame, sketchPage, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** A labelled contact sheet from PNG frames, drawn in the browser. Returns PNG bytes. */
export async function composeSheet(page, { title, cells, cellWidth, cellHeight, columns }) {
  const dataUrl = await page.evaluate(
    async ({ title, cells, cellWidth, cellHeight, columns }) => {
      const gap = 16;
      const labelH = 30;
      const headH = 54;
      const rows = Math.ceil(cells.length / columns);
      const canvas = document.createElement('canvas');
      canvas.width = gap + columns * (cellWidth + gap);
      canvas.height = headH + rows * (cellHeight + labelH + gap) + gap;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 22px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, gap, headH / 2 + 4);
      for (let i = 0; i < cells.length; i++) {
        const x = gap + (i % columns) * (cellWidth + gap);
        const y = headH + Math.floor(i / columns) * (cellHeight + labelH + gap);
        const img = new Image();
        img.src = cells[i].dataUrl;
        await img.decode();
        ctx.fillStyle = '#f2c14e';
        ctx.font = '600 17px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(cells[i].label, x, y + labelH / 2);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y + labelH, cellWidth, cellHeight);
        ctx.strokeStyle = '#55555f';
        ctx.strokeRect(x + 0.5, y + labelH + 0.5, cellWidth - 1, cellHeight - 1);
      }
      return canvas.toDataURL('image/png');
    },
    { title, cells, cellWidth, cellHeight, columns },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** A region of a frame, enlarged, for looking at a detail. Returns PNG bytes. */
export async function composeCrop(page, { dataUrl, x, y, w, h, scale }) {
  const out = await page.evaluate(
    async ({ dataUrl, x, y, w, h, scale }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = scale < 3;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    },
    { dataUrl, x, y, w, h, scale },
  );
  return Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
}

/** A PNG showing `code` in large letters: the app uses it to check that a session can read images. */
export async function composeCode(page, code) {
  const out = await page.evaluate((code) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111111';
    ctx.font = '700 120px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(code, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
  }, code);
  return Buffer.from(out.slice(out.indexOf(',') + 1), 'base64');
}

export function hasDownloadedChromium() {
  const dir = path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers');
  return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.startsWith('chromium-'));
}
