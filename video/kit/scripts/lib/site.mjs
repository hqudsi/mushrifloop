// Build the page with Vite and serve the result from 127.0.0.1 for the render scripts.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DIST, ROOT, sha256 } from './common.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).replace(/\\/g, '/')];
  });
}

/**
 * `vite build` into dist/. Returns a fingerprint of everything in it: the scene code, the storyboard
 * data (it is bundled) and the fonts. Frames rendered under one fingerprint are valid only for it.
 */
export async function buildSite() {
  const { build } = await import('vite');
  await build({ root: ROOT, logLevel: 'warn' });
  const files = listFiles(DIST).sort();
  const parts = files.map((f) => `${f}:${sha256(fs.readFileSync(path.join(DIST, f)))}`);
  return { dist: DIST, fingerprint: sha256(parts.join('\n')) };
}

/** A static server for dist/ on a free local port. Nothing outside dist/ is served. */
export function serve(dist = DIST) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    const file = path.resolve(dist, rel);
    if (!file.startsWith(path.resolve(dist) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
