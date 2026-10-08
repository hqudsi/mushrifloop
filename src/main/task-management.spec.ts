/**
 * Managing tasks (SPEC.md §10, NOTES.md §61): archive, pin and delete, through the task hub as the renderer
 * uses them. No CLI needed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const { TaskService, parseAction, projectKey } = await import('./task-service');
const { defaultSettings } = await import('../shared/settings');
const { Harness, P, okOutcome, waitFor } = await import('./orchestrator/__tests__/harness');

describe('parseAction: archive and pin', () => {
  it('takes a boolean and nothing else', () => {
    expect(parseAction({ kind: 'archive', archived: true })).toEqual({ kind: 'archive', archived: true });
    expect(parseAction({ kind: 'archive', archived: false })).toEqual({ kind: 'archive', archived: false });
    expect(parseAction({ kind: 'pin', pinned: true, extra: 1 })).toEqual({ kind: 'pin', pinned: true });
    expect(parseAction({ kind: 'archive' })).toBeNull();
    expect(parseAction({ kind: 'archive', archived: 'yes' })).toBeNull();
    expect(parseAction({ kind: 'pin', pinned: 1 })).toBeNull();
  });
});

describe('projectKey (grouping by project)', () => {
  it('treats case and a trailing separator as the same folder on Windows', () => {
    expect(projectKey('D:\\Work\\App', 'win32')).toBe('d:\\work\\app');
    expect(projectKey('d:\\work\\app\\', 'win32')).toBe('d:\\work\\app');
    expect(projectKey('D:/Work/App/', 'win32')).toBe('d:\\work\\app');
    expect(projectKey('D:\\', 'win32')).toBe('d:\\');
    expect(projectKey('D:\\Work\\App2', 'win32')).not.toBe(projectKey('D:\\Work\\App', 'win32'));
  });

  it('keeps case elsewhere', () => {
    expect(projectKey('/home/a/App/', 'linux')).toBe('/home/a/App');
    expect(projectKey('/home/a/app', 'linux')).not.toBe(projectKey('/home/a/App', 'linux'));
  });
});

describe('TaskService: archive, pin, delete (SPEC.md §10)', () => {
  let h: InstanceType<typeof Harness>;
  let sent: Array<{ type: string; taskId?: string }>;
  let trashed: string[];
  let trashError: Error | null;

  const service = (options: { trash?: boolean } = {}) => {
    const s = new TaskService({
      getSettings: () => defaultSettings(),
      send: (m) => sent.push(m as { type: string; taskId?: string }),
      tasksRoot: h.store.root,
      usageFile: path.join(h.dir, 'usage.json'),
      createDeps: (_settings, hooks) => ({
        deps: {
          ...h.deps(),
          ...(hooks.onNotice ? { onNotice: hooks.onNotice } : {}),
          ...(hooks.notify ? { notify: hooks.notify } : {}),
          ...(hooks.autoResume ? { autoResume: hooks.autoResume } : {}),
        },
      }),
      ...(options.trash === false
        ? {}
        : {
            trash: async (folder: string) => {
              if (trashError) throw trashError;
              const bin = path.join(h.dir, 'recycle-bin');
              fs.mkdirSync(bin, { recursive: true });
              fs.renameSync(folder, path.join(bin, path.basename(folder)));
              trashed.push(folder);
            },
          }),
    });
    s.init();
    return s;
  };

  const create = async (s: InstanceType<typeof TaskService>, description: string) => {
    const result = await s.create({ description, projectDir: h.projectDir, overrides: { requiredSkills: [], approvalMode: 'auto' } });
    expect(result.ok, result.error).toBe(true);
    return result.taskId!;
  };

  const row = (s: InstanceType<typeof TaskService>, id: string) => s.list().find((t) => t.id === id);

  beforeEach(() => {
    h = new Harness();
    sent = [];
    trashed = [];
    trashError = null;
  });
  afterEach(() => {
    h.cleanup();
  });

  it('lists the new fields; an older record without them is neither archived nor pinned', async () => {
    const s = service();
    const id = await create(s, 'Plain task\nwith detail');
    const r = row(s, id)!;
    expect(r).toMatchObject({ archived: false, pinnedToTop: false, description: 'Plain task\nwith detail', projectKey: projectKey(h.projectDir) });
    const stored = JSON.parse(fs.readFileSync(h.store.taskFile(id), 'utf8')) as Record<string, unknown>;
    expect('archivedAt' in stored).toBe(false);
  });

  it('archives a task at rest, records it in the timeline, unpins it, and unarchives it', async () => {
    const s = service();
    const id = await create(s, 'Finished work');
    expect(await s.action(id, { kind: 'pin', pinned: true })).toEqual({ ok: true });
    expect(row(s, id)?.pinnedToTop).toBe(true);

    expect(await s.action(id, { kind: 'archive', archived: true })).toEqual({ ok: true });
    const task = h.store.readTask(id);
    expect(task.archivedAt).toEqual(expect.any(String));
    expect(task.pinnedAt).toBeNull();
    expect(row(s, id)).toMatchObject({ archived: true, pinnedToTop: false });
    // The files stay where they are.
    expect(fs.existsSync(h.store.taskFile(id))).toBe(true);
    // An archived task cannot be pinned.
    expect(await s.action(id, { kind: 'pin', pinned: true })).toMatchObject({ ok: false, error: expect.stringContaining('Unarchive it first') });

    expect(await s.action(id, { kind: 'archive', archived: false })).toEqual({ ok: true });
    expect(row(s, id)?.archived).toBe(false);
    const archivedEvents = h.store.readEvents(id).filter((e) => e.type === 'archived');
    expect(archivedEvents.map((e) => (e as { archived: boolean }).archived)).toEqual([true, false]);
    // Archiving twice records nothing new.
    await s.action(id, { kind: 'archive', archived: false });
    expect(h.store.readEvents(id).filter((e) => e.type === 'archived')).toHaveLength(2);
    // Pin is a list preference: no event.
    expect(h.store.readEvents(id).some((e) => (e.type as string) === 'pinned')).toBe(false);
  });

  it('refuses to archive or delete a task waiting for the user, and allows both once it is stopped', async () => {
    const s = service();
    h.planner(P.ask('Which name?'));
    const id = await create(s, 'Asks a question');
    expect((await s.action(id, { kind: 'start' })).ok).toBe(true);
    await waitFor(() => h.store.readTask(id).status === 'waiting_user');
    await waitFor(() => !s.anyBusy());

    expect(await s.action(id, { kind: 'archive', archived: true })).toMatchObject({ ok: false, error: 'This task is waiting for you, so it cannot be archived. Stop it first.' });
    expect(await s.delete(id)).toMatchObject({ ok: false, error: expect.stringContaining('Stop it first') });
    expect(trashed).toEqual([]);
    // Pin works in every status.
    expect(await s.action(id, { kind: 'pin', pinned: true })).toEqual({ ok: true });

    expect((await s.action(id, { kind: 'stop' })).ok).toBe(true);
    expect(h.store.readTask(id).status).toBe('stopped');
    expect(await s.action(id, { kind: 'archive', archived: true })).toEqual({ ok: true });
  });

  it('a message to an archived task brings it back into the list before the loop runs', async () => {
    const s = service();
    h.planner(P.done());
    const id = await create(s, 'Finished, then archived');
    expect((await s.action(id, { kind: 'start' })).ok).toBe(true);
    await waitFor(() => h.store.readTask(id).status === 'done');
    await waitFor(() => !s.anyBusy());
    expect(await s.action(id, { kind: 'archive', archived: true })).toEqual({ ok: true });

    h.planner(P.done());
    expect((await s.action(id, { kind: 'send', text: 'One more thing.' })).ok).toBe(true);
    expect(h.store.readTask(id).archivedAt).toBeNull();
    expect(h.store.readEvents(id).filter((e) => e.type === 'archived').map((e) => (e as { archived: boolean }).archived)).toEqual([true, false]);
    await waitFor(() => !s.anyBusy());
  });

  it('refuses while a turn is running', async () => {
    const s = service();
    let release: () => void = () => {};
    h.on('planner', (spec) => new Promise((resolve) => (release = () => resolve(okOutcome(spec, P.ask('Which name?'))))));
    const id = await create(s, 'Busy task');
    expect((await s.action(id, { kind: 'start' })).ok).toBe(true);
    await waitFor(() => h.specs.length === 1);

    expect(await s.action(id, { kind: 'archive', archived: true })).toMatchObject({ ok: false, error: expect.stringContaining('Stop it first') });
    expect(await s.delete(id)).toMatchObject({ ok: false, error: expect.stringContaining('Stop it first') });
    expect(fs.existsSync(h.store.taskFile(id))).toBe(true);

    release();
    await waitFor(() => !s.anyBusy());
  });

  it('deletes by moving the task folder to the Recycle Bin, and nothing else', async () => {
    const s = service();
    const keep = await create(s, 'Stays');
    const id = await create(s, 'Goes');
    const folder = h.store.taskDir(id);
    const projectFile = path.join(h.projectDir, 'kept.txt');
    fs.writeFileSync(projectFile, 'project code');

    expect(await s.delete(id)).toEqual({ ok: true, taskId: id });
    expect(trashed).toEqual([folder]);
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(path.join(h.dir, 'recycle-bin', path.basename(folder), 'task.json'))).toBe(true);
    expect(fs.readFileSync(projectFile, 'utf8')).toBe('project code');
    expect(sent).toContainEqual({ type: 'task_removed', taskId: id });
    expect(s.list().map((t) => t.id)).toEqual([keep]);
    expect(await s.action(id, { kind: 'start' })).toMatchObject({ ok: false, error: `Unknown task ${id}.` });
    expect(await s.delete(id)).toMatchObject({ ok: false, error: `Unknown task ${id}.` });
    // The other task is untouched and still works.
    expect(await s.action(keep, { kind: 'rename', title: 'Still here' })).toEqual({ ok: true });
  });

  it('when the Recycle Bin refuses, nothing is deleted and the raw error is returned', async () => {
    const s = service();
    const id = await create(s, 'Locked files');
    trashError = new Error('The process cannot access the file because it is being used by another process.');
    const result = await s.delete(id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Recycle Bin');
    expect(result.error).toContain('being used by another process');
    expect(result.nextStep).toContain('Nothing was deleted');
    expect(fs.existsSync(h.store.taskFile(id))).toBe(true);
    expect(row(s, id)).toBeDefined();
    expect(sent.some((m) => m.type === 'task_removed')).toBe(false);
  });

  it('can delete a task whose files cannot be read', async () => {
    const s0 = service();
    await create(s0, 'Good task');
    const bad = '20260916-120000-badbad';
    fs.mkdirSync(h.store.taskDir(bad), { recursive: true });
    fs.writeFileSync(h.store.taskFile(bad), '{ this is not json');
    const s = service();
    expect(row(s, bad)?.unreadable).toContain('Could not load');
    expect(await s.action(bad, { kind: 'archive', archived: true })).toMatchObject({ ok: false });
    expect(await s.delete(bad)).toEqual({ ok: true, taskId: bad });
    expect(row(s, bad)).toBeUndefined();
  });

  it('refuses ids that are not task ids, and refuses when there is no Recycle Bin to use', async () => {
    const s = service({ trash: false });
    const id = await create(s, 'No bin here');
    expect(await s.delete('..\\..\\Windows')).toMatchObject({ ok: false, error: expect.stringContaining('Unknown task') });
    expect(await s.delete(id)).toMatchObject({ ok: false, error: 'Deleting tasks is not available here.' });
    expect(fs.existsSync(h.store.taskFile(id))).toBe(true);
  });
});
