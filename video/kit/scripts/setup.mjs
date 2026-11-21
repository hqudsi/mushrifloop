// npm run setup [-- --download-browser] [--ffmpeg]
//
// Installs what `npm ci` leaves out, and only what is needed. Everything goes inside this folder's
// node_modules, nothing into the user profile:
//
//   --download-browser   Playwright's own Chromium (not needed when Microsoft Edge or Google Chrome
//                        is installed and gives a hardware renderer; `npm run doctor` says)
//   --ffmpeg             the ffmpeg-static package, a GPL build of ffmpeg with libx264
//
// Without flags it installs ffmpeg-static only when no ffmpeg with libx264 is on PATH, and downloads
// nothing else.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, fail, parseArgs } from './lib/common.mjs';
import { FFMPEG_STATIC_VERSION, FFMPEG_TOOLS, findFfmpeg } from './lib/ffmpeg.mjs';

const args = parseArgs();

function folderSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

if (args['download-browser'] === true) {
  const cli = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');
  if (!fs.existsSync(cli)) fail('Playwright is not installed. Run "npm ci" first.');
  console.log('Downloading Playwright\'s Chromium into node_modules/playwright-core/.local-browsers …');
  const run = spawnSync(process.execPath, [cli, 'install', '--no-shell', 'chromium'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  });
  if (run.status !== 0) fail(`The browser download failed (exit ${run.status}).`);
  console.log(`Chromium on disk: ${mb(folderSize(path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers')))}.`);
}

const ffmpeg = await findFfmpeg();
if (args.ffmpeg === true || !ffmpeg?.libx264) {
  if (ffmpeg?.source === 'ffmpeg-static' && ffmpeg.libx264) {
    console.log('ffmpeg-static is already installed.');
  } else {
    console.log(`Installing ffmpeg-static ${FFMPEG_STATIC_VERSION} (a GPL build of ffmpeg, with libx264) into node_modules/.video-tools/ffmpeg …`);
    fs.mkdirSync(FFMPEG_TOOLS, { recursive: true });
    fs.writeFileSync(path.join(FFMPEG_TOOLS, 'package.json'), JSON.stringify({ name: 'video-tools-ffmpeg', private: true, dependencies: { 'ffmpeg-static': FFMPEG_STATIC_VERSION } }, null, 2) + '\n');
    // Its install script downloads the binary; newer npm versions run such scripts only when allowed.
    // One fixed command line (npm is a .cmd on Windows, so it needs the shell); nothing in it is input.
    const run = spawnSync('npm install --no-audit --no-fund --foreground-scripts', { cwd: FFMPEG_TOOLS, stdio: 'inherit', shell: true });
    if (run.status !== 0) fail(`Installing ffmpeg-static failed (exit ${run.status}).`);
    const after = await findFfmpeg();
    if (after?.source !== 'ffmpeg-static' || !after.libx264) {
      fail('ffmpeg-static was installed, but its ffmpeg binary is missing or has no libx264: npm may not have run its install script. Install ffmpeg yourself (for example `winget install Gyan.FFmpeg`) and open a new terminal.');
    }
    console.log(`ffmpeg-static on disk: ${mb(folderSize(FFMPEG_TOOLS))}. Using ${after.version}.`);
  }
} else {
  console.log(`ffmpeg: using ${ffmpeg.path} from ${ffmpeg.source} (${ffmpeg.version}); nothing to install.`);
}

console.log(`node_modules on disk: ${mb(folderSize(path.join(ROOT, 'node_modules')))}.`);
console.log('Now run "npm run doctor".');
