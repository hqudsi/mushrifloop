/**
 * `npm run dev` — compile main + preload, start the Angular dev server, then launch Electron
 * pointed at it. Kept dependency-free on purpose (no concurrently / wait-on).
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import process from 'node:process';

const DEV_URL = 'http://127.0.0.1:4200';
const isWindows = process.platform === 'win32';
/** npm/ng ship as .cmd on Windows, which needs a shell to spawn. */
const npx = isWindows ? 'npx.cmd' : 'npx';

const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', shell: isWindows, ...options });
  children.add(child);
  child.on('close', () => children.delete(child));
  return child;
}

function shutdown(code) {
  for (const child of children) {
    try {
      if (isWindows && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch {
      /* best effort */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

console.log('[dev] building main + preload…');
const tsc = run(npx, ['tsc', '-p', 'tsconfig.main.json']);
const [tscCode] = await once(tsc, 'close');
if (tscCode !== 0) {
  console.error('[dev] main build failed');
  shutdown(tscCode ?? 1);
}

// The variable's name derives from APP_NAME; read it from the build that just finished.
const { DEV_SERVER_ENV } = createRequire(import.meta.url)('../dist/shared/app-config.js');

console.log('[dev] starting Angular dev server…');
run(npx, ['ng', 'serve']);

if (!(await waitForServer(DEV_URL))) {
  console.error(`[dev] dev server did not respond at ${DEV_URL}`);
  shutdown(1);
}

console.log('[dev] starting Electron…');
const electron = run(npx, ['electron', '.'], { env: { ...process.env, [DEV_SERVER_ENV]: DEV_URL } });
const [electronCode] = await once(electron, 'close');
shutdown(electronCode ?? 0);
