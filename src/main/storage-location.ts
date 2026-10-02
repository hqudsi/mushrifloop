/**
 * Where does the app *actually* write? (SPEC.md §9, NOTES.md §13)
 *
 * When the app is started from inside an MSIX-packaged app's container — e.g. from a terminal or
 * Code tab inside the Claude desktop app — Windows silently redirects writes under %APPDATA% and
 * %LOCALAPPDATA% to  %LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\{Roaming|Local}\…
 * while reads see a merged view. Other programs (Explorer, a normal terminal) never see those files.
 *
 * The usual signals do not detect this case: `process.windowsStore` and the Win32
 * GetCurrentPackageFamilyName call both reported "no package" for a process whose writes were
 * redirected (verified 2026-09-16). So this module detects it empirically: write a uniquely named
 * marker through the path the app uses, then look for that marker inside every package's
 * LocalCache. If it shows up there, writes are redirected, and we know to which package.
 *
 * The filesystem is injected so both outcomes can be unit-tested without a real container.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { StorageLocation } from '../shared/ipc';

export type { StorageLocation };

export interface ProbeIo {
  mkdirp(dir: string): void;
  writeFile(file: string, data: string): void;
  exists(file: string): boolean;
  listDirs(dir: string): string[];
  remove(file: string): void;
}

export const nodeProbeIo: ProbeIo = {
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
  writeFile: (file, data) => fs.writeFileSync(file, data, 'utf8'),
  exists: (file) => fs.existsSync(file),
  listDirs: (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  },
  remove: (file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  },
};

export interface ProbeEnv {
  platform: string;
  appData: string | undefined;
  localAppData: string | undefined;
  pid: number;
}

/** Case-insensitive "is `child` inside `parent`" for Windows paths; returns the relative part. */
function relativeInside(parent: string | undefined, child: string): string | null {
  if (!parent) return null;
  const rel = path.win32.relative(path.win32.resolve(parent), path.win32.resolve(child));
  if (rel.startsWith('..') || path.win32.isAbsolute(rel)) return null;
  return rel;
}

export function detectStorageLocation(target: string, env: ProbeEnv, io: ProbeIo = nodeProbeIo): StorageLocation {
  const notApplicable = (detail: string): StorageLocation => ({
    path: target,
    physicalPath: target,
    redirected: false,
    packageFamily: null,
    method: 'not-applicable',
    detail,
  });

  if (env.platform !== 'win32') return notApplicable('File-system virtualization only exists on Windows.');
  if (!env.localAppData) return notApplicable('LOCALAPPDATA is not set.');

  // Virtualization covers the two AppData roots, each mapped to its own LocalCache subfolder.
  const underRoaming = relativeInside(env.appData, target);
  const underLocal = underRoaming === null ? relativeInside(env.localAppData, target) : null;
  const packagesRoot = path.win32.join(env.localAppData, 'Packages');
  // Anything already inside a package folder is the physical location by definition.
  if (relativeInside(packagesRoot, target) !== null) return notApplicable('Path is already inside a package folder.');
  if (underRoaming === null && underLocal === null) {
    return notApplicable('Path is outside %APPDATA% and %LOCALAPPDATA%; Windows does not redirect it.');
  }
  const cacheKind = underRoaming !== null ? 'Roaming' : 'Local';
  const relative = (underRoaming ?? underLocal) as string;

  const marker = `.location-probe-${env.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const markerPath = path.win32.join(target, marker);
  try {
    io.mkdirp(target);
    io.writeFile(markerPath, 'probe');
  } catch (err) {
    return {
      path: target,
      physicalPath: target,
      redirected: false,
      packageFamily: null,
      method: 'probe-failed',
      detail: `Could not write a probe file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    for (const family of io.listDirs(packagesRoot)) {
      const packageDir = path.win32.join(packagesRoot, family, 'LocalCache', cacheKind, relative);
      if (io.exists(path.win32.join(packageDir, marker))) {
        return {
          path: target,
          physicalPath: packageDir,
          redirected: true,
          packageFamily: family,
          method: 'probe',
          detail: `Running inside the "${family}" package container; writes to ${target} land in ${packageDir}.`,
        };
      }
    }
    return {
      path: target,
      physicalPath: target,
      redirected: false,
      packageFamily: null,
      method: 'probe',
      detail: 'Probe file was written to the real location.',
    };
  } finally {
    io.remove(markerPath);
  }
}
