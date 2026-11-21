// Part of `npm test`: the render lock. No browser needed.
//   a live holder refuses a second run; a stale lock (its process is gone) is cleared and taken over;
//   releasing removes only one's own lock; a second `render` beside a running one exits with code 4.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXIT, ROOT } from './lib/common.mjs';
import { LOCK_FILE, acquireLock, isAlive, lockHolder, lockMessage } from './lib/lock.mjs';

const problems = [];
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) problems.push(name);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-lock-'));
const file = path.join(dir, 'out', '.render.lock');
try {
  const first = acquireLock('render', { file });
  check('the first run takes the lock', first.ok === true && fs.existsSync(file));
  const second = acquireLock('render', { file, pid: process.pid + 1, alive: (pid) => pid === process.pid });
  check('a second run is refused while the first is alive', second.ok === false && second.holder?.pid === process.pid);
  check('the refusal is one line naming the process', !second.ok && /^LOCKED: a render is already running .*process \d+/.test(lockMessage(second.holder)) && !lockMessage(second.holder).includes('\n'));
  first.release();
  check('releasing removes the lock', !fs.existsSync(file));

  // A dead process: a pid that certainly is not running.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: dead, command: 'render', startedAt: '2026-01-01T00:00:00.000Z' }));
  check('a finished process is not alive', isAlive(dead) === false);
  check('a stale lock has no holder', lockHolder(file) === null);
  const taken = acquireLock('render', { file });
  check('a stale lock is cleared and taken over', taken.ok === true && taken.tookOverStale === true && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid);

  // Someone else took the lock over meanwhile: our release must leave theirs alone.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 7, command: 'render' }));
  taken.release();
  check('release never removes another run\'s lock', fs.existsSync(file));
  fs.rmSync(file);

  fs.writeFileSync(file, 'not json');
  const garbled = acquireLock('render', { file });
  check('an unreadable lock file is treated as stale', garbled.ok === true);
  garbled.release();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The real thing: while a live process holds this folder's lock, `render` refuses at once.
if (lockHolder() !== null) {
  check('this folder has no render running (finish it before running the tests)', false);
} else {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: holder.pid, command: 'render', startedAt: new Date().toISOString() }));
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'render.mjs')], { encoding: 'utf8', cwd: ROOT });
  check('render exits with the "locked" code beside a running render', run.status === EXIT.locked);
  check('…with the one-line message, without building or launching a browser', /^LOCKED: /.test(run.stderr.trim()) && run.stderr.trim().split('\n').length === 1 && Date.now() - started < 5000);
  check('…and leaves the running render\'s lock alone', JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === holder.pid);
  holder.kill();
  await new Promise((resolve) => holder.on('close', resolve));
  check('once that process is gone the lock is stale', lockHolder() === null);
  fs.rmSync(LOCK_FILE, { force: true });
}

if (problems.length > 0) {
  console.error(`FAIL: the render lock (${problems.length} check(s)).`);
  process.exit(EXIT.failed);
}
console.log('PASS: only one render runs at a time, and a stale lock is cleared.');
