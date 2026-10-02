/**
 * The third-party license list (Settings → About, SPEC.md §11): how it is collected, and that the
 * generated file still matches what is installed — this test fails when a shipped dependency changes
 * without `npm run licenses`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { THIRD_PARTY_LICENSES } from '../../shared/third-party-licenses.generated';
import { collectLicenses, copyrightLines, findPackageDir, mainRuntimePackages, parseBundledPackages, readEntry } from './license-collector';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function installedVersion(name: string): string {
  const dir = findPackageDir(name, ROOT, ROOT);
  if (!dir) throw new Error(`${name} is not installed`);
  return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

describe('the generated list is current', () => {
  it('lists every main-process runtime package and Electron, at the installed versions', () => {
    const listed = new Map(THIRD_PARTY_LICENSES.map((e) => [e.name, e]));
    const runtime = mainRuntimePackages(ROOT).map((dir) => readEntry(dir, ['main']));
    expect(runtime.map((e) => e.name)).toContain('ajv');
    for (const pkg of [...runtime, readEntry(findPackageDir('electron', ROOT, ROOT)!, ['runtime'])]) {
      const entry = listed.get(pkg.name);
      expect(entry, `${pkg.name} is missing — run npm run licenses`).toBeDefined();
      expect(entry?.version, `${pkg.name} changed — run npm run licenses`).toBe(pkg.version);
      expect(entry?.usedBy).toEqual(expect.arrayContaining(pkg.usedBy));
    }
  });

  it('every listed package is installed at the listed version, with a license and its text', () => {
    expect(THIRD_PARTY_LICENSES.length).toBeGreaterThan(0);
    for (const entry of THIRD_PARTY_LICENSES) {
      expect(installedVersion(entry.name), `${entry.name} changed — run npm run licenses`).toBe(entry.version);
      expect(entry.license).not.toBe('UNKNOWN');
      expect(entry.text, `${entry.name} has no license text`).toBeTruthy();
      expect(entry.copyright.length > 0 || entry.author !== null, `${entry.name} names no copyright holder`).toBe(true);
    }
    const bundled = THIRD_PARTY_LICENSES.filter((e) => e.usedBy.includes('renderer')).map((e) => e.name);
    expect(bundled).toContain('@angular/core');
  });
});

describe('collecting', () => {
  it('reads package names from Angular’s bundle report', () => {
    const report = [
      '',
      '-'.repeat(80),
      'Package: @angular/core',
      'License: "MIT"',
      '',
      'The MIT License',
      '-'.repeat(80),
      'Package: rxjs',
      'License: "Apache-2.0"',
      'Package: rxjs',
    ].join('\n');
    expect(parseBundledPackages(report)).toEqual(['@angular/core', 'rxjs']);
  });

  it('finds copyright holders, not license prose or templates', () => {
    const text = [
      'The MIT License',
      '',
      'Copyright (c) 2015-2021 Evgeny Poberezkin',
      'Copyright (c) 2015-2021 Evgeny Poberezkin',
      '© 2020 Someone Else',
      'The above copyright notice and this permission notice shall be included',
      '    copyright license to reproduce, prepare Derivative Works of,',
      '    (c) You must retain, in the Source form of any Derivative Works',
      ' Copyright [yyyy] [name of copyright owner]',
      'THE SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS',
      '(c) 2019 Third Party',
    ].join('\n');
    expect(copyrightLines(text)).toEqual(['Copyright (c) 2015-2021 Evgeny Poberezkin', '© 2020 Someone Else', '(c) 2019 Third Party']);
  });

  it('walks nested dependencies, reads license files and falls back to the author', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'licenses-'));
    try {
      const write = (rel: string, content: unknown) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      };
      write('package.json', { name: 'app', version: '1.0.0', dependencies: { a: '^1' } });
      write('node_modules/a/package.json', { name: 'a', version: '1.2.3', license: 'MIT', dependencies: { b: '^2' }, repository: 'someone/a' });
      write('node_modules/a/LICENSE.md', 'MIT License\n\nCopyright (c) 2024 A Author\n');
      // A nested copy wins over the top-level one for `a`.
      write('node_modules/a/node_modules/b/package.json', { name: 'b', version: '2.0.0', licenses: [{ type: 'ISC' }], author: { name: 'B Person' } });
      write('node_modules/a/node_modules/b/license', 'ISC License\n\nPermission to use…\n');
      write('node_modules/b/package.json', { name: 'b', version: '9.9.9', license: 'MIT' });
      write('node_modules/ui/package.json', { name: 'ui', version: '3.0.0', license: { type: 'BSD-2-Clause' } });
      write('node_modules/electron/package.json', { name: 'electron', version: '44.0.0', license: 'MIT' });

      const entries = collectLicenses(root, ['ui']);
      expect(entries.map((e) => `${e.name}@${e.version} ${e.license} ${e.usedBy.join('+')}`)).toEqual([
        'a@1.2.3 MIT main',
        'b@2.0.0 ISC main',
        'electron@44.0.0 MIT runtime',
        'ui@3.0.0 BSD-2-Clause renderer',
      ]);
      const [a, b, electron] = entries;
      expect(a).toMatchObject({ copyright: ['Copyright (c) 2024 A Author'], homepage: 'https://github.com/someone/a' });
      expect(b).toMatchObject({ copyright: [], author: 'B Person', text: 'ISC License\n\nPermission to use…' });
      expect(electron?.text).toBeNull();

      expect(() => collectLicenses(root, ['missing-pkg'])).toThrow(/bundles missing-pkg, but it is not installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
