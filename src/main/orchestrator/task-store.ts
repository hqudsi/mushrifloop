/**
 * Task storage (SPEC.md §9): one folder per task with an atomically rewritten task.json, an
 * append-only events.jsonl, the Planner's cwd and the raw per-turn files.
 *
 * Every write is synchronous and complete before the call returns, so "persist before the next
 * process starts" (SPEC.md §5 net 5) holds even if the app dies right after.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeJsonAtomic } from '../atomic-write';
import type { TaskEvent, TaskRecord, TaskStorePort } from './types';

export class TaskStore implements TaskStorePort {
  constructor(readonly root: string) {}

  taskDir(taskId: string): string {
    return path.join(this.root, taskId);
  }

  taskFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'task.json');
  }

  eventsFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'events.jsonl');
  }

  rawDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'raw');
  }

  plannerCwd(taskId: string): string {
    return path.join(this.taskDir(taskId), 'planner-cwd');
  }

  /** Create the folder layout for a new task. Fails if the task folder already exists. */
  createFolders(taskId: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.taskDir(taskId));
    fs.mkdirSync(this.plannerCwd(taskId));
    fs.mkdirSync(this.rawDir(taskId));
  }

  writeTask(task: TaskRecord): void {
    writeJsonAtomic(this.taskFile(task.id), task);
  }

  appendEvent(taskId: string, event: TaskEvent): void {
    // One write per line; appendFileSync opens with O_APPEND, so a line is never interleaved.
    fs.appendFileSync(this.eventsFile(taskId), JSON.stringify(event) + '\n', 'utf8');
  }

  readTask(taskId: string): TaskRecord {
    return JSON.parse(fs.readFileSync(this.taskFile(taskId), 'utf8')) as TaskRecord;
  }

  /** All events, in order. A torn last line (crash mid-write) is skipped, not fatal. */
  readEvents(taskId: string): TaskEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(this.eventsFile(taskId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const events: TaskEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TaskEvent);
      } catch {
        /* torn line */
      }
    }
    return events;
  }

  lastEventSeq(taskId: string): number {
    const events = this.readEvents(taskId);
    return events.reduce((max, e) => Math.max(max, typeof e.seq === 'number' ? e.seq : 0), 0);
  }

  /** Task folders that hold a task.json. No tasks folder yet is an empty list; any other failure throws. */
  listTaskIds(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((d) => d.isDirectory() && fs.existsSync(this.taskFile(d.name)))
      .map((d) => d.name)
      .sort();
  }

  rawHasInit(rawPath: string): boolean {
    let text: string;
    try {
      text = fs.readFileSync(rawPath, 'utf8');
    } catch {
      return false;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"init"')) continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; subtype?: unknown };
        if (parsed.type === 'system' && parsed.subtype === 'init') return true;
      } catch {
        /* torn line */
      }
    }
    return false;
  }
}
