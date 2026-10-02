/**
 * Third-party license list for Settings → About (SPEC.md §11), collected from the installed packages —
 * never typed by hand. `npm run licenses` writes it to src/shared/third-party-licenses.generated.ts;
 * NOTES.md says when to refresh it.
 *
 * What ships inside the app, and therefore what is listed:
 * - `main`: the runtime `dependencies` of package.json and everything they depend on;
 * - `renderer`: the packages Angular bundled into the renderer, as its production build reports them in
 *   dist/renderer/3rdpartylicenses.txt;
 * - `runtime`: Electron itself (its own notices for Chromium and Node.js ship with it as
 *   LICENSES.chromium.html). Electron's dependencies only download it at install time and are not listed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LicenseEntry, LicenseUse } from '../../shared/licenses';

interface PackageJson {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  author?: unknown;
  homepage?: unknown;
  repository?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readJson(file: string): PackageJson {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
}

/** Node's lookup: `<dir>/node_modules/<name>`, walking up from `fromDir` to `rootDir`. */
export function findPackageDir(name: string, fromDir: string, rootDir: string): string | null {
  let dir = path.resolve(fromDir);
  const root = path.resolve(rootDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every package the main process loads at runtime: package.json `dependencies`, transitively. */
export function mainRuntimePackages(rootDir: string): string[] {
  const found = new Map<string, string>();
  const queue: Array<{ name: string; from: string }> = Object.keys(dependenciesOf(readJson(path.join(rootDir, 'package.json')))).map(
    (name) => ({ name, from: rootDir }),
  );
  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    const dir = findPackageDir(name, from, rootDir);
    if (!dir) throw new Error(`Runtime dependency ${name} is not installed (looked from ${from}). Run npm ci.`);
    if (found.has(dir)) continue;
    found.set(dir, name);
    for (const dep of Object.keys(dependenciesOf(readJson(path.join(dir, 'package.json'))))) queue.push({ name: dep, from: dir });
  }
  return [...found.keys()];
}

function dependenciesOf(pkg: PackageJson): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
}

/** Package names from Angular's `3rdpartylicenses.txt` ("Package: <name>" per section). */
export function parseBundledPackages(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^Package:\s*(\S+)\s*$/gm)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

const LICENSE_FILE = /^(licen[cs]e|copying)([-._][a-z0-9]+)?(\.(md|txt|markdown))?$/i;

function licenseFile(dir: string): string | null {
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile());
  files.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return files[0] ? path.join(dir, files[0]) : null;
}

/**
 * Copyright holders named in a license text: lines that start with "Copyright" (capitalised, as a notice
 * does), "©", or "(c)" followed by a year. License prose ("copyright license to reproduce…", Apache's
 * "(c) You must retain…") and template lines ("Copyright [yyyy] [name of copyright owner]") are left out.
 */
export function copyrightLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^(Copyright\b|COPYRIGHT\b|©|\(c\)\s*\d{4})/.test(line)) continue;
    if (/\[yyyy\]|\[name of copyright owner\]|<year>|\{yyyy\}/i.test(line)) continue;
    if (/^copyright (notice|and license|holders?\b|owner)/i.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function licenseOf(pkg: PackageJson): string {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof (pkg.license as { type?: unknown }).type === 'string') {
    return (pkg.license as { type: string }).type;
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l: unknown) => (l && typeof l === 'object' ? (l as { type?: unknown }).type : null))
      .filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

function authorOf(pkg: PackageJson): string | null {
  if (typeof pkg.author === 'string') return pkg.author.trim() || null;
  if (pkg.author && typeof pkg.author === 'object' && typeof (pkg.author as { name?: unknown }).name === 'string') {
    return (pkg.author as { name: string }).name;
  }
  return null;
}

function homepageOf(pkg: PackageJson): string | null {
  if (typeof pkg.homepage === 'string') return pkg.homepage;
  const repo = pkg.repository;
  const url = typeof repo === 'string' ? repo : repo && typeof repo === 'object' ? (repo as { url?: unknown }).url : null;
  if (typeof url !== 'string') return null;
  // npm's shorthand: "user/repo" or "github:user/repo".
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (short) return `https://github.com/${short[1]}`;
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
}

export function readEntry(dir: string, usedBy: LicenseUse[]): LicenseEntry {
  const pkg = readJson(path.join(dir, 'package.json'));
  const file = licenseFile(dir);
  const text = file ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd() : null;
  return {
    name: pkg.name ?? path.basename(dir),
    version: pkg.version ?? '0.0.0',
    license: licenseOf(pkg),
    copyright: text ? copyrightLines(text) : [],
    author: authorOf(pkg),
    homepage: homepageOf(pkg),
    text,
    usedBy,
  };
}

/** The whole list, sorted by name, so an unchanged install produces an identical file. */
export function collectLicenses(rootDir: string, bundledPackages: readonly string[]): LicenseEntry[] {
  const uses = new Map<string, Set<LicenseUse>>();
  const add = (dir: string, use: LicenseUse) => {
    const set = uses.get(dir) ?? new Set<LicenseUse>();
    set.add(use);
    uses.set(dir, set);
  };
  for (const dir of mainRuntimePackages(rootDir)) add(dir, 'main');
  for (const name of bundledPackages) {
    const dir = findPackageDir(name, rootDir, rootDir);
    if (!dir) throw new Error(`The renderer bundles ${name}, but it is not installed. Run npm ci.`);
    add(dir, 'renderer');
  }
  const electron = findPackageDir('electron', rootDir, rootDir);
  if (!electron) throw new Error('Electron is not installed. Run npm ci.');
  add(electron, 'runtime');

  const order: LicenseUse[] = ['main', 'renderer', 'runtime'];
  return [...uses.entries()]
    .map(([dir, set]) => readEntry(dir, order.filter((u) => set.has(u))))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The generated TypeScript module. */
export function renderLicenseModule(entries: readonly LicenseEntry[]): string {
  return [
    '// Generated by `npm run licenses` (src/main/cli/licenses.ts) from the installed packages. Do not edit.',
    '// Refresh it whenever a dependency that ships in the app is added, removed or updated (NOTES.md §20).',
    '',
    "import type { LicenseEntry } from './licenses';",
    '',
    `export const THIRD_PARTY_LICENSES: readonly LicenseEntry[] = ${JSON.stringify(entries, null, 2)};`,
    '',
  ].join('\n');
}
