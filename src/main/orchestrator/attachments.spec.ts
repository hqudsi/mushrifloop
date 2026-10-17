/**
 * Attached files in the loop (SPEC.md §10, NOTES.md §66): what the Planner is told, what it may read, and
 * what is recorded. The real TaskRunner and TaskStore; only processes are faked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskCreationError, TaskRunner, TaskStateError } from './orchestrator';
import { E, Harness, P, TEST_CONFIG } from './__tests__/harness';
import type { Attachment } from '../../shared/task-model';

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.cleanup();
});

const at = '2026-09-16T10:00:00.000Z';
function file(dir: string, name: string, kind: Attachment['kind'] = 'image'): Attachment {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'x');
  return { file: name, name: name.slice(3), size: 1, kind, at };
}

async function createWith(files: string[], config = {}): Promise<TaskRunner> {
  return TaskRunner.create(
    {
      description: 'Make the header match the screenshot.',
      projectDir: h.projectDir,
      config: { ...TEST_CONFIG, ...config },
      attach: (dir) => files.map((f) => file(dir, f)),
    },
    h.deps(),
  );
}

describe('attachments on a new task', () => {
  it('records them, lists them for the Planner, and lets an isolated Planner read only that folder', async () => {
    h.planner(P.done());
    const runner = await createWith(['01-header.png']);
    const dir = h.store.attachmentsDir(runner.id);
    expect(h.task(runner).attachments?.map((a) => a.file)).toEqual(['01-header.png']);
    expect(h.eventsOf(runner, 'task_created')[0]?.attachments?.map((a) => a.file)).toEqual(['01-header.png']);

    await runner.start();
    const first = h.specs[0];
    expect(first?.prompt).toContain('[ATTACHED FILES]');
    expect(first?.prompt).toContain(`${dir.replace(/\\/g, '/')}/01-header.png (image, 1 B; attached as "header.png")`);
    expect(first?.tools).toEqual(['Read']);
    expect(first?.cwd).toBe(h.task(runner).plannerCwd);
    expect(first?.addDirs).toEqual([dir]);
  });

  it('gives a read-only Planner and the Executor the folder too', async () => {
    h.planner(P.cont('Change the header colour as in the screenshot')).executor(E.ok(['src/header.css'])).planner(P.done());
    const runner = await createWith(['01-header.png'], { plannerContextMode: 'read_only' });
    h.git.pending = ['src/header.css'];
    await runner.start();
    const dir = h.store.attachmentsDir(runner.id);
    expect(h.specs[0]?.tools).toEqual(['Read', 'Glob', 'Grep']);
    for (const spec of h.specs) expect(spec.addDirs).toEqual([dir]);
  });

  it('changes nothing for a task without attachments', async () => {
    h.planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs[0]?.tools).toEqual([]);
    expect(h.specs[0]?.addDirs).toBeUndefined();
    expect(h.specs[0]?.prompt).not.toContain('[ATTACHED FILES]');
    expect(h.task(runner).attachments).toBeUndefined();
  });

  it('creates nothing when the files cannot be copied', async () => {
    const create = TaskRunner.create(
      {
        description: 'x',
        projectDir: h.projectDir,
        config: TEST_CONFIG,
        attach: () => {
          throw new Error('disk full');
        },
      },
      h.deps(),
    );
    await expect(create).rejects.toThrow(TaskCreationError);
    await expect(create).rejects.toThrow(/could not be copied: disk full/);
    expect(h.store.listTaskIds()).toEqual([]);
  });
});

describe('attachments on a message or an answer', () => {
  it('an answer carries its files: recorded on the task and the event, listed in the Planner’s prompt', async () => {
    h.planner(P.ask('Which colour?')).planner(P.done());
    const runner = await h.create();
    await runner.start();
    const dir = h.store.attachmentsDir(runner.id);
    const swatch = file(dir, '01-swatch.png');
    await runner.answer('This one', [swatch]);

    const answerTurn = h.specs[1];
    expect(answerTurn?.prompt).toContain('This one');
    expect(answerTurn?.prompt).toContain(`${dir.replace(/\\/g, '/')}/01-swatch.png`);
    expect(answerTurn?.tools).toEqual(['Read']);
    expect(answerTurn?.addDirs).toEqual([dir]);
    const intervention = h.eventsOf(runner, 'intervention').find((e) => e.kind === 'answer');
    expect(intervention?.text).toBe('This one');
    expect(intervention?.attachments?.map((a) => a.file)).toEqual(['01-swatch.png']);
    expect(h.task(runner).attachments?.map((a) => a.file)).toEqual(['01-swatch.png']);
  });

  it('a message may be files only; an empty one without files is still refused', async () => {
    h.planner(P.done('Finished.')).planner(P.done('Looked at it.'));
    const runner = await h.create();
    await runner.start();
    await expect(runner.sendMessage('   ')).rejects.toThrow(TaskStateError);
    const dir = h.store.attachmentsDir(runner.id);
    await runner.sendMessage('', [file(dir, '01-log.txt', 'other')]);
    const followUp = h.specs[1];
    expect(followUp?.prompt).toContain('[ATTACHED FILES]');
    expect(followUp?.prompt).toContain('01-log.txt (other, 1 B; attached as "log.txt")');
  });

  it('a later file is added after the earlier ones', async () => {
    h.planner(P.ask('Which colour?')).planner(P.ask('And the font?')).planner(P.done());
    const runner = await createWith(['01-header.png']);
    await runner.start();
    const dir = h.store.attachmentsDir(runner.id);
    await runner.answer('Blue', [file(dir, '02-blue.png')]);
    await runner.answer('Same as before');
    expect(h.task(runner).attachments?.map((a) => a.file)).toEqual(['01-header.png', '02-blue.png']);
    // Only the files of that message are listed with it; the Planner can still read the others.
    expect(h.specs[2]?.prompt).not.toContain('[ATTACHED FILES]');
    expect(h.specs[2]?.addDirs).toEqual([dir]);
  });
});
