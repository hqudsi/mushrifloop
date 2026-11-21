// One render at a time.
//
// A command that runs past the Bash tool's time limit is moved to the background and keeps running, so
// a second `npm run render` could be started beside it, and both would write out/frames. `render`
// therefore takes out/.render.lock, holding its process id. A second render refuses to start while that
// process is alive; a lock whose process is gone (a run that was killed) is cleared and taken over.

import fs from 'node:fs';
import path from 'node:path';

import { OUT } from './common.mjs';

export const LOCK_FILE = path.join(OUT, '.render.lock');

/** Is a process with this id running? Signal 0 only asks; it sends nothing. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours to signal. Anything else: it is gone.
    return err?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof lock === 'object' && lock !== null ? lock : null;
  } catch {
    return null;
  }
}

/** The live process holding the lock, or null when nobody does (a stale lock counts as nobody). */
export function lockHolder(file = LOCK_FILE, alive = isAlive) {
  const lock = readLock(file);
  return lock && alive(lock.pid) ? lock : null;
}

/** One line for the person or agent who tried to start a second run. */
export function lockMessage(holder) {
  return `LOCKED: a ${holder.command ?? 'render'} is already running in this folder (process ${holder.pid}, started ${holder.startedAt ?? 'earlier'}). Wait for it to finish; do not start another.`;
}

/**
 * Take the lock. `{ ok: true, release, tookOverStale }`, or `{ ok: false, holder }` when a live process
 * has it. Creating the file fails if it exists, so two starts at the same moment cannot both win.
 */
export function acquireLock(command, { file = LOCK_FILE, pid = process.pid, alive = isAlive } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let tookOverStale = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, command, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // Only our own lock: never remove one that another run has taken over since.
        if (readLock(file)?.pid === pid) fs.rmSync(file, { force: true });
      };
      return { ok: true, release, tookOverStale };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const lock = readLock(file);
      if (lock && alive(lock.pid)) return { ok: false, holder: lock };
      // Stale (its process is gone) or unreadable: clear it and try again.
      fs.rmSync(file, { force: true });
      tookOverStale = true;
    }
  }
  throw new Error(`Could not take ${file}.`);
}

/** Take the lock for this process, or print the one-line reason and exit with the "locked" code. */
export function lockOrExit(command, exitCode) {
  const lock = acquireLock(command);
  if (!lock.ok) {
    console.error(lockMessage(lock.holder));
    process.exit(exitCode);
  }
  if (lock.tookOverStale) console.log('A lock from a run that is no longer running was cleared.');
  process.on('exit', lock.release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => {
      lock.release();
      process.exit(1);
    });
  }
  return lock;
}
