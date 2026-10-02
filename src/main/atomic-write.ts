/**
 * Atomic JSON writes: same-directory temp file, fsync, then rename over the target.
 * A half-written settings.json or task.json would be worse than none (SPEC.md §9).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const json = JSON.stringify(value, null, 2) + '\n';

  let handle: number | undefined;
  try {
    handle = fs.openSync(tmp, 'w');
    fs.writeFileSync(handle, json, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
