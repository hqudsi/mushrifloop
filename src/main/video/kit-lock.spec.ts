/**
 * The kit's render lock (SPEC.md §21.1), tested from the app's suite as well as by the kit's own `npm test`:
 * a command past the Bash tool's limit is moved to the background and keeps running, so the prompt alone
 * must not be what prevents two renders in one folder.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';

interface Lock {
  pid: number;
  command?: string;
  startedAt?: string;
}
type Acquired = { ok: true; release(): void; tookOverStale: boolean } | { ok: false; holder: Lock };
interface LockModule {
  acquireLock(command: string, options: { file: string; pid?: number; alive?: (pid: number) => boolean }): Acquired;
  lockHolder(file: string, alive?: (pid: number) => boolean): Lock | null;
  lockMessage(holder: Lock): string;
  isAlive(pid: number): boolean;
}

const KIT = path.resolve(__dirname, '..', '..', '..', 'video', 'kit');
const load = async () => (await import(pathToFileURL(path.join(KIT, 'scripts', 'lib', 'lock.mjs')).href)) as LockModule;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-lock-`));
  file = path.join(dir, 'out', '.render.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the render lock', () => {
  it('a second render is refused while the first is alive, with one line saying so', async () => {
    const lock = await load();
    const alive = (pid: number) => pid === 111;
    const first = lock.acquireLock('render', { file, pid: 111, alive });
    expect(first.ok).toBe(true);
    const second = lock.acquireLock('render', { file, pid: 222, alive });
    expect(second).toMatchObject({ ok: false, holder: { pid: 111, command: 'render' } });
    const message = lock.lockMessage((second as { holder: Lock }).holder);
    expect(message).toMatch(/^LOCKED: a render is already running in this folder \(process 111, /);
    expect(message).toMatch(/do not start another/);
    expect(message.includes('\n')).toBe(false);
    // The refused run did not disturb the lock.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(111);
  });

  it('a lock whose process is gone is cleared and taken over', async () => {
    const lock = await load();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 111, command: 'render', startedAt: '2026-11-10T10:00:00.000Z' }));
    const gone = () => false;
    expect(lock.lockHolder(file, gone)).toBeNull();
    const taken = lock.acquireLock('render', { file, pid: 222, alive: gone });
    expect(taken).toMatchObject({ ok: true, tookOverStale: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(222);
  });

  it('releasing removes one’s own lock and never another run’s', async () => {
    const lock = await load();
    const mine = lock.acquireLock('render', { file, pid: 111, alive: () => true });
    if (!mine.ok) throw new Error('not acquired');
    mine.release();
    expect(fs.existsSync(file)).toBe(false);

    const again = lock.acquireLock('render', { file, pid: 111, alive: () => true });
    if (!again.ok) throw new Error('not acquired');
    fs.writeFileSync(file, JSON.stringify({ pid: 333, command: 'render' }));
    again.release();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(333);
  });

  it('an unreadable lock file counts as stale, and this process counts as alive', async () => {
    const lock = await load();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ half a file');
    expect(lock.acquireLock('render', { file, pid: 111, alive: () => true })).toMatchObject({ ok: true, tookOverStale: true });
    expect(lock.isAlive(process.pid)).toBe(true);
    expect(lock.isAlive(-1)).toBe(false);
    expect(lock.isAlive(Number.NaN)).toBe(false);
  });

  it('render and gif use it, and the kit’s own test covers it', () => {
    const read = (name: string) => fs.readFileSync(path.join(KIT, name), 'utf8');
    expect(read('scripts/render.mjs')).toMatch(/lockOrExit\('render', EXIT\.locked\)/);
    expect(read('scripts/gif.mjs')).toMatch(/lockHolder\(\)/);
    expect(read('scripts/lib/common.mjs')).toMatch(/locked: 4/);
    expect(JSON.parse(read('package.json')).scripts.test).toBe('node scripts/lock-test.mjs && node scripts/test.mjs');
    expect(read('_gitignore')).toMatch(/^out\/$/m);
  });
});
