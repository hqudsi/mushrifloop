import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { APP_SLUG } from '../shared/app-config';

const root = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-log-`));
vi.mock('electron', () => ({ app: { getPath: () => root } }));

const { log } = await import('./logger');
const { logFile } = await import('./config');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('logger', () => {
  it('has the line on disk as soon as the call returns (nothing lost on exit)', () => {
    log.info('test.sync', { value: 42 });
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    expect(last).toMatchObject({ level: 'info', event: 'test.sync', value: 42 });
    expect(typeof last['ts']).toBe('string');
  });

  it('writes one JSON object per line', () => {
    log.debug('a');
    log.debug('b', { text: 'line one\nline two' });
    const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n');
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
});
