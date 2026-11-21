/**
 * The two human gates of a Video task (SPEC.md §21.5), in the real state machine with a scripted runner:
 * the storyboard gate before anything is built, and the final gate when the Planner says done. Both must
 * hold in every approval mode, `auto` included.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApprovalMode } from '../../shared/settings';
import { TaskRunner, TaskStateError, imageCheckKey } from './orchestrator';
import { E, Harness, P, TEST_CONFIG, okOutcome } from './__tests__/harness';

let h: Harness;

const VALID = (hash: string) => ({ state: 'valid' as const, problems: [], hash });
const STORYBOARD = 'Write video/storyboard.md and video/storyboard.json for the title card.';
const BUILD = 'Build shot-01 in video/src/video.ts, run the stills for it and report.';

beforeEach(() => {
  h = new Harness();
  // The kit is installed and the image check has passed before: setup spends nothing here.
  h.video.kit = { state: 'kit', version: '1.0.0', packagesInstalled: true, ffmpegInstalled: false, chromiumDownloaded: false };
  h.video.passes.set(imageCheckKey('2.1.322', TEST_CONFIG.planner), '2026-11-10T00:00:00.000Z');
});

afterEach(() => {
  h.cleanup();
});

/** The Executor "writes" the storyboard during its turn. */
function writesStoryboard(hash: string) {
  return h.on('executor', (spec) => {
    h.video.board = VALID(hash);
    return okOutcome(spec, E.ok(['video/storyboard.json', 'video/storyboard.md']));
  });
}

describe('the storyboard gate', () => {
  for (const mode of ['review', 'plan_first'] as ApprovalMode[]) {
    it(`holds the first build step for the human in ${mode} mode`, async () => {
      if (mode === 'plan_first') h.planner(P.plan('1. storyboard 2. shots 3. render'));
      h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
      const runner = await h.createVideo({ approvalMode: mode });
      await runner.start();
      if (mode === 'plan_first') {
        expect(h.task(runner).waiting?.kind).toBe('plan_approval');
        writesStoryboard('hash-1').planner(P.cont(BUILD));
        await runner.approvePlan();
      } else {
        // Review mode asks about the storyboard instruction itself first: no storyboard exists yet.
        expect(h.task(runner).waiting?.kind).toBe('instruction_approval');
        writesStoryboard('hash-1').planner(P.cont(BUILD));
        await runner.approveInstruction();
      }
      const task = h.task(runner);
      expect(task.status).toBe('waiting_user');
      expect(task.waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-1', instruction: BUILD });
      expect(task.cycles).toBe(1);
      expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(1);
      h.assertScriptDone();
    });
  }

  it('holds in auto mode, with nobody watching: the build step is never spawned', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo({ approvalMode: 'auto' });
    await runner.start();
    const task = h.task(runner);
    expect(task.config.approvalMode).toBe('auto');
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-1', instruction: BUILD });
    expect(task.video?.storyboard).toBeNull();
    // One Executor turn ran (the storyboard itself); the build step did not.
    expect(h.specs.filter((s) => s.agent === 'executor').map((s) => s.prompt)).toEqual([expect.stringContaining(STORYBOARD)]);
    expect(h.notifications.at(-1)).toMatchObject({ status: 'waiting_user' });
    h.assertScriptDone();
  });

  it('holds even when the Planner never marks anything: the first step after a valid storyboard exists', async () => {
    h.planner(P.cont(STORYBOARD));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    expect(h.task(runner).waiting).toMatchObject({ kind: 'storyboard_approval', instruction: BUILD });
  });

  it('lets the Executor work while there is no valid storyboard yet', async () => {
    h.video.board = { state: 'invalid', problems: ['shots must be a list'], hash: null };
    h.planner(P.cont('Fix video/storyboard.json: shots must be a list.')).executor(E.ok(['video/storyboard.json'])).planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    expect(h.task(runner).waiting?.kind).toBe('question');
    expect(h.task(runner).cycles).toBe(1);
  });

  it('approve: the hash is stored, the held step runs, and the Planner is told', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();

    h.executor(E.ok(['video/src/video.ts'])).planner(P.ask('Shot 1 is built. Go on?'));
    await runner.approveStoryboard();
    const task = h.task(runner);
    expect(task.video?.storyboard).toMatchObject({ approvedHash: 'hash-1' });
    expect(task.cycles).toBe(2);
    expect(h.specs.at(-2)?.prompt).toContain(BUILD);
    expect(h.specs.at(-1)?.prompt).toContain('[FROM USER] The storyboard is approved.');
    expect(h.eventsOf(runner, 'intervention').map((e) => e.kind)).toContain('approve_storyboard');
    h.assertScriptDone();
  });

  it('after approval the gate does not fire again, even when the storyboard changes', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    h.executor(E.ok(['video/src/video.ts'])).planner(P.cont('Shorten shot 2 by ten frames in video/storyboard.json and video/src/video.ts.'));
    writesStoryboard('hash-2').planner(P.cont('Build shot-02.')).executor(E.ok(['video/src/video.ts'])).planner(P.ask('?'));
    await runner.approveStoryboard();
    const task = h.task(runner);
    expect(task.waiting?.kind).toBe('question');
    expect(task.cycles).toBe(4);
    expect(task.video?.storyboard?.approvedHash).toBe('hash-1');
  });

  it('notes: the held step is dropped and the notes reach the Planner', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();

    h.planner(P.cont('Change the Arabic line in video/storyboard.json as the human asked.', { revises_storyboard: true }));
    writesStoryboard('hash-2').planner(P.cont(BUILD));
    await runner.rejectStoryboard('The second line should arrive later, after Hello has settled.');
    const task = h.task(runner);
    const toPlanner = h.specs.find((s) => s.agent === 'planner' && s.prompt.includes('not approved yet'));
    expect(toPlanner?.prompt).toContain('The second line should arrive later');
    expect(toPlanner?.prompt).toContain('was not sent to the executor');
    // The build step never ran; the revised storyboard is shown again.
    expect(h.specs.filter((s) => s.agent === 'executor').every((s) => !s.prompt.includes('Build shot-01'))).toBe(true);
    expect(task.waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-2' });
    expect(task.video?.storyboard).toBeNull();
    await expect(runner.rejectStoryboard('   ')).rejects.toThrow(TaskStateError);
  });

  it('a revision that changes nothing does not buy another free step', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont('Polish the storyboard wording.', { revises_storyboard: true }));
    // This "revision" leaves the file as it was.
    h.executor(E.ok(['video/src/video.ts'])).planner(P.cont('Polish it once more.', { revises_storyboard: true }));
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(h.eventsOf(runner, 'storyboard_unchanged')).toHaveLength(1);
    expect(task.video?.revisionStalled).toBe(true);
    expect(task.waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-1', instruction: 'Polish it once more.' });
    expect(task.cycles).toBe(2);
  });

  it('a storyboard that changed while the human was looking is shown again, not approved', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    h.video.board = VALID('hash-edited-by-hand');
    await expect(runner.approveStoryboard()).rejects.toThrow(/changed while you were looking/);
    let task = h.task(runner);
    expect(task.video?.storyboard).toBeNull();
    expect(task.waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-edited-by-hand' });

    h.video.board = { state: 'invalid', problems: ['title must be text.'], hash: null };
    await expect(runner.approveStoryboard()).rejects.toThrow(/can no longer be approved: title must be text/);
    task = h.task(runner);
    expect(task.video?.storyboard).toBeNull();
  });

  it('Stop parks the gate and Resume brings it back; messages are closed while it waits', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    await expect(runner.sendMessage('just build it')).rejects.toThrow(/look at the storyboard/);
    await runner.stop();
    expect(h.task(runner).status).toBe('stopped');
    await runner.resume();
    expect(h.task(runner).waiting).toMatchObject({ kind: 'storyboard_approval', hash: 'hash-1' });
    expect(h.specs.filter((s) => s.agent === 'executor')).toHaveLength(1);
  });

  it('survives a restart of the app: a reloaded task still waits at the gate', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    const reloaded = TaskRunner.load(h.task(runner), h.events(runner), h.deps());
    h.executor(E.ok(['video/src/video.ts'])).planner(P.ask('?'));
    await reloaded.approveStoryboard();
    expect(h.task(reloaded).video?.storyboard?.approvedHash).toBe('hash-1');
  });

  it('a done before the storyboard is approved is refused', async () => {
    h.planner(P.done('Nothing to do.')).planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    const refused = h.eventsOf(runner, 'refused')[0];
    expect(refused).toMatchObject({ reason: 'storyboard_not_approved' });
    expect(refused?.detail).toMatch(/There is no video\/storyboard\.json yet/);
    expect(h.task(runner).status).toBe('waiting_user');
    expect(h.task(runner).finalReport).toBeNull();
  });

  it('a coding task is never asked about a storyboard', async () => {
    h.video.board = VALID('some-file-in-the-project');
    h.planner(P.cont('Create README.md')).executor(E.ok(['README.md'])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.task(runner).status).toBe('done');
  });
});

describe('the final gate', () => {
  /** A Video task whose storyboard is approved and whose first shot is built. */
  async function approved(video: { gif?: boolean } = {}, mode: ApprovalMode = 'auto') {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
    writesStoryboard('hash-1').planner(P.cont(BUILD));
    const runner = await h.createVideo({ approvalMode: mode === 'review' ? 'auto' : mode }, video);
    await runner.start();
    return runner;
  }

  it('a done with no rendered video is refused, and says what to run', async () => {
    const runner = await approved();
    h.executor(E.ok(['video/src/video.ts'])).planner(P.done('The video is finished.')).planner(P.ask('?'));
    await runner.approveStoryboard();
    const refused = h.eventsOf(runner, 'refused').at(-1);
    expect(refused).toMatchObject({ reason: 'video_missing', missing: ['video/out/video.mp4'] });
    expect(refused?.detail).toMatch(/npm run render/);
    expect(h.task(runner).status).not.toBe('done');
  });

  it('with the video rendered it waits for the human in auto mode, keeping the report', async () => {
    const runner = await approved();
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1_681_610, mtimeMs: 1_794_000_000_000 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Rendered: 6 s, two shots, both texts as in the storyboard.'));
    await runner.approveStoryboard();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'video_approval', finalReport: 'Rendered: 6 s, two shots, both texts as in the storyboard.' });
    expect(task.finalReport).toBeNull();
    expect(h.eventsOf(runner, 'done')).toHaveLength(0);

    await runner.approveVideo();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.finalReport).toBe('Rendered: 6 s, two shots, both texts as in the storyboard.');
    expect(task.video?.final).toMatchObject({ file: 'video/out/video.mp4', size: 1_681_610, mtimeMs: 1_794_000_000_000 });
    expect(h.eventsOf(runner, 'intervention').map((e) => e.kind)).toContain('approve_video');
  });

  it('when a GIF was asked for, the GIF is required too', async () => {
    const runner = await approved({ gif: true });
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1000, mtimeMs: 1 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    })
      .planner(P.done('Rendered.'))
      .planner(P.cont('Run npm run gif in video/.'));
    h.on('executor', (spec) => {
      h.video.gif = { size: 500, mtimeMs: 2 };
      return okOutcome(spec, E.ok([]));
    }).planner(P.done('Rendered, with the GIF.'));
    await runner.approveStoryboard();
    const refused = h.eventsOf(runner, 'refused').at(-1);
    expect(refused).toMatchObject({ reason: 'video_missing', missing: ['video/out/video.gif'] });
    expect(refused?.detail).toMatch(/npm run gif/);
    expect(h.task(runner).waiting).toMatchObject({ kind: 'video_approval', finalReport: 'Rendered, with the GIF.' });

    // The GIF vanished before the human decided: nothing is approved.
    h.video.gif = null;
    await expect(runner.approveVideo()).rejects.toThrow(/GIF is no longer there/);
    h.video.gif = { size: 500, mtimeMs: 2 };
    await runner.approveVideo();
    expect(h.task(runner).status).toBe('done');
  });

  it('notes start another round, and the next done comes back to the gate', async () => {
    const runner = await approved();
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1000, mtimeMs: 1 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Rendered.'));
    await runner.approveStoryboard();

    h.planner(P.cont('Slow the fly-in of shot 2 and render again.'));
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1100, mtimeMs: 5 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Rendered again, slower.'));
    await runner.rejectVideo('The Arabic word arrives too fast.');
    const task = h.task(runner);
    expect(h.specs.find((s) => s.prompt.includes('The Arabic word arrives too fast.'))?.agent).toBe('planner');
    expect(task.waiting).toMatchObject({ kind: 'video_approval', finalReport: 'Rendered again, slower.' });
    expect(task.video?.final).toBeNull();
    await expect(runner.sendMessage('fine')).rejects.toThrow(/watch the video/);
    await expect(runner.rejectVideo('')).rejects.toThrow(TaskStateError);
  });

  it('a question answered on a finished Video task does not ask the human to watch the same file again', async () => {
    const runner = await approved();
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1000, mtimeMs: 1 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Rendered.'));
    await runner.approveStoryboard();
    await runner.approveVideo();

    h.planner(P.done('It is 6 seconds long.'));
    await runner.sendMessage('How long is it?');
    expect(h.task(runner).status).toBe('done');
    expect(h.task(runner).finalReport).toBe('It is 6 seconds long.');

    // New work that renders a new file comes back to the gate.
    h.planner(P.cont('Make the title blue and render again.'));
    await runner.sendMessage('Make the title blue.');
    expect(h.task(runner).waiting?.kind).toBe('instruction_approval');
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1200, mtimeMs: 9 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Blue now.'));
    await runner.approveInstruction();
    expect(h.task(runner).waiting).toMatchObject({ kind: 'video_approval', finalReport: 'Blue now.' });
  });

  it('required skills still come first, and the gate still holds after a waiver', async () => {
    const runner = await (async () => {
      h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
      writesStoryboard('hash-1').planner(P.cont(BUILD));
      const r = await h.createVideo({ requiredSkills: ['security-review'] });
      await r.start();
      return r;
    })();
    h.on('executor', (spec) => {
      h.video.mp4 = { size: 1000, mtimeMs: 1 };
      return okOutcome(spec, E.ok(['video/src/video.ts']));
    }).planner(P.done('Rendered.'));
    await runner.approveStoryboard();
    // No remote: security-review cannot run here, so the waiver is offered first.
    expect(h.task(runner).waiting?.kind).toBe('skill_waiver');
    await runner.waiveSkill('security-review');
    expect(h.task(runner).waiting).toMatchObject({ kind: 'video_approval', finalReport: 'Rendered.' });
    expect(h.task(runner).status).not.toBe('done');
  });
});
