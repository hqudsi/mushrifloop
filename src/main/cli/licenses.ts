/**
 * npm run licenses [-- --check]
 *
 * Regenerates src/shared/third-party-licenses.generated.ts — the "Third-party licenses" list in
 * Settings → About (SPEC.md §11) — from the installed packages. The npm script runs the production
 * renderer build first, because the list of packages bundled into the renderer comes from Angular's
 * dist/renderer/3rdpartylicenses.txt.
 *
 *   --check   do not write; exit 1 if the file on disk differs from what would be generated
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { collectLicenses, parseBundledPackages, renderLicenseModule } from './license-collector';

// dist/main/cli → the project root.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BUNDLE_REPORT = path.join(ROOT, 'dist', 'renderer', '3rdpartylicenses.txt');
const OUTPUT = path.join(ROOT, 'src', 'shared', 'third-party-licenses.generated.ts');

function main(): number {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
  if (!fs.existsSync(BUNDLE_REPORT)) {
    console.error(`${BUNDLE_REPORT} is missing. It comes from the production renderer build: run \`npm run licenses\` (it builds first).`);
    return 1;
  }
  const bundled = parseBundledPackages(fs.readFileSync(BUNDLE_REPORT, 'utf8'));
  const entries = collectLicenses(ROOT, bundled);
  const source = renderLicenseModule(entries);
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;

  for (const e of entries) {
    const holders = e.copyright.length > 0 ? e.copyright.length : e.author ? 'author only' : 'none';
    console.log(`${e.name}@${e.version}  ${e.license}  [${e.usedBy.join(', ')}]  copyright lines: ${holders}${e.text ? '' : '  (NO LICENSE FILE)'}`);
  }

  if (values.check) {
    if (current === source) {
      console.log(`\n${path.relative(ROOT, OUTPUT)} is up to date (${entries.length} packages).`);
      return 0;
    }
    console.error(`\n${path.relative(ROOT, OUTPUT)} is out of date. Run \`npm run licenses\`.`);
    return 1;
  }
  if (current === source) {
    console.log(`\nUnchanged: ${path.relative(ROOT, OUTPUT)} (${entries.length} packages).`);
  } else {
    fs.writeFileSync(OUTPUT, source, 'utf8');
    console.log(`\nWrote ${path.relative(ROOT, OUTPUT)} (${entries.length} packages).`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
