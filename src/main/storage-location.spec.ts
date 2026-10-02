import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_NAME } from '../shared/app-config';
import { detectStorageLocation, type ProbeEnv, type ProbeIo } from './storage-location';

const APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
const LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';
const PACKAGES = path.win32.join(LOCALAPPDATA, 'Packages');

const env: ProbeEnv = { platform: 'win32', appData: APPDATA, localAppData: LOCALAPPDATA, pid: 42 };

/**
 * An in-memory filesystem. When `redirectTo` is set it behaves like an MSIX container:
 * writes under %APPDATA% / %LOCALAPPDATA% physically land in that package's LocalCache.
 */
function fakeIo(options: { redirectTo?: string; packages?: string[]; failWrite?: boolean } = {}) {
  const files = new Set<string>();
  const removed: string[] = [];
  const physical = (file: string): string => {
    if (!options.redirectTo) return file;
    for (const [root, kind] of [
      [APPDATA, 'Roaming'],
      [LOCALAPPDATA, 'Local'],
    ] as const) {
      const rel = path.win32.relative(root, file);
      if (!rel.startsWith('..') && !rel.startsWith('Packages')) {
        return path.win32.join(PACKAGES, options.redirectTo, 'LocalCache', kind, rel);
      }
    }
    return file;
  };
  const io: ProbeIo = {
    mkdirp: () => {},
    writeFile: (file) => {
      if (options.failWrite) throw new Error('EACCES: permission denied');
      files.add(physical(file).toLowerCase());
    },
    exists: (file) => files.has(file.toLowerCase()),
    listDirs: (dir) => (dir === PACKAGES ? (options.packages ?? []) : []),
    remove: (file) => {
      removed.push(file);
      files.delete(physical(file).toLowerCase());
    },
  };
  return { io, files, removed };
}

describe('detectStorageLocation', () => {
  const target = path.win32.join(APPDATA, APP_NAME);

  it('reports the real path when writes are not redirected', () => {
    const { io } = fakeIo({ packages: ['Claude_pzs8sxrjxfjjc', 'Other_123'] });
    const location = detectStorageLocation(target, env, io);
    expect(location).toMatchObject({
      path: target,
      physicalPath: target,
      redirected: false,
      packageFamily: null,
      method: 'probe',
    });
  });

  it('detects redirection into a package container and reports the physical path', () => {
    const { io } = fakeIo({ redirectTo: 'Claude_pzs8sxrjxfjjc', packages: ['Other_123', 'Claude_pzs8sxrjxfjjc'] });
    const location = detectStorageLocation(target, env, io);
    expect(location.redirected).toBe(true);
    expect(location.packageFamily).toBe('Claude_pzs8sxrjxfjjc');
    expect(location.physicalPath).toBe(
      `C:\\Users\\dev\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\${APP_NAME}`,
    );
    expect(location.method).toBe('probe');
  });

  it('maps %LOCALAPPDATA% paths to the LocalCache\\Local subfolder', () => {
    const { io } = fakeIo({ redirectTo: 'Claude_pzs8sxrjxfjjc', packages: ['Claude_pzs8sxrjxfjjc'] });
    const location = detectStorageLocation(path.win32.join(LOCALAPPDATA, APP_NAME, 'session'), env, io);
    expect(location.redirected).toBe(true);
    expect(location.physicalPath).toBe(
      `C:\\Users\\dev\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\${APP_NAME}\\session`,
    );
  });

  it('always removes its probe file', () => {
    for (const redirectTo of [undefined, 'Claude_pzs8sxrjxfjjc']) {
      const { io, files, removed } = fakeIo({
        ...(redirectTo ? { redirectTo } : {}),
        packages: ['Claude_pzs8sxrjxfjjc'],
      });
      detectStorageLocation(target, env, io);
      expect(removed).toHaveLength(1);
      expect(files.size).toBe(0);
    }
  });

  it('does not probe paths Windows never redirects', () => {
    const { io, removed } = fakeIo({ redirectTo: 'Claude_pzs8sxrjxfjjc', packages: ['Claude_pzs8sxrjxfjjc'] });
    const location = detectStorageLocation('D:\\TaskData', env, io);
    expect(location).toMatchObject({ physicalPath: 'D:\\TaskData', redirected: false, method: 'not-applicable' });
    expect(removed).toHaveLength(0);
  });

  it('treats a path already inside a package folder as physical', () => {
    const inside = path.win32.join(PACKAGES, 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', APP_NAME);
    expect(detectStorageLocation(inside, env, fakeIo().io).method).toBe('not-applicable');
  });

  it('matches the AppData root case-insensitively', () => {
    const { io } = fakeIo({ redirectTo: 'Claude_pzs8sxrjxfjjc', packages: ['Claude_pzs8sxrjxfjjc'] });
    const location = detectStorageLocation(`c:\\users\\DEV\\appdata\\roaming\\${APP_NAME}`, env, io);
    expect(location.redirected).toBe(true);
  });

  it('is not applicable off Windows', () => {
    const location = detectStorageLocation(`/home/dev/.config/${APP_NAME}`, { ...env, platform: 'linux' }, fakeIo().io);
    expect(location.method).toBe('not-applicable');
    expect(location.redirected).toBe(false);
  });

  it('says it does not know when the probe cannot be written, rather than claiming "not redirected"', () => {
    const location = detectStorageLocation(target, env, fakeIo({ failWrite: true }).io);
    expect(location.method).toBe('probe-failed');
    expect(location.detail).toContain('EACCES');
  });
});
