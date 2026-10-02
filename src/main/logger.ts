/**
 * Structured logging to <data folder>/app.log (CLAUDE.md conventions).
 *
 * One JSON object per line, appended synchronously: a line is on disk before the call returns, so an
 * exit or crash right afterwards cannot lose it (an async stream lost `turn.survivors_killed` lines
 * when `npm run try-turn` exited — NOTES.md §15). Log volume is low, so the cost is negligible.
 * A logging failure never takes down the app.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEV_SERVER_ENV } from '../shared/app-config';
import { logFile } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let preparedDir: string | null = null;

function append(line: string): void {
  try {
    const target = logFile();
    const dir = path.dirname(target);
    if (preparedDir !== dir) {
      fs.mkdirSync(dir, { recursive: true });
      preparedDir = dir;
    }
    fs.appendFileSync(target, line + '\n', 'utf8');
  } catch {
    /* logging must never throw */
  }
}

function write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  append(line);
  if (level === 'error' || level === 'warn') {
    console[level](line);
  } else if (process.env[DEV_SERVER_ENV]) {
    console.log(line);
  }
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => write('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => write('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => write('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => write('error', event, data),
};

/** Turn an unknown throwable into something loggable/displayable without losing the message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
