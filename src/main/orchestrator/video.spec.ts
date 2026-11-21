/**
 * Video tasks in the state machine (SPEC.md §21): creation, the setup before the Planner's first turn
 * (prerequisites, consent, the kit, install, doctor, the cached image check), the per-kind prompt, schema
 * and loop window — and that a coding task is exactly what it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { TaskCreationError, TaskRunner, TaskStateError, imageCheckKey } from './orchestrator';
import { systemPromptFor } from './prompts';
import { PING_PONG_TURNS, trackTurns } from './safety';
import { E, Harness, P, TEST_CONFIG, failOutcome, waitFor } from './__tests__/harness';
import { VIDEO_PING_PONG_TURNS } from '../../shared/video';
import type { TaskRecord } from './types';

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(() => {
  h.cleanup();
});

/** Everything already in place: nothing to download, so no consent is needed. */
function installed(): void {
  h.video.kit = { state: 'kit', version: '1.0.0', packagesInstalled: true, ffmpegInstalled: false, chromiumDownloaded: false };
}

describe('a coding task is unchanged (SPEC.md §21)', () => {
  it('carries no kind and no video field, in task.json and in its first event', async () => {
    const runner = await h.create();
    const task = h.task(runner);
    expect('kind' in task).toBe(false);
    expect('video' in task).toBe(false);
    const created = h.eventsOf(runner, 'task_created')[0];
    expect(created && 'kind' in created).toBe(false);
  });

  it('gets the same system prompts, schema and tools as before, and never touches the video port', async () => {
    h.planner(P.cont('Create README.md')).executor(E.ok(['README.md'])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    const task = h.task(runner);
    const [planner, executor] = h.specs;
    // Exactly what the prompt module gives a task with no video section: nothing was added.
    expect(planner?.systemPrompt).toBe(systemPromptFor('planner', 'ROLE PROMPT FOR PLANNER', task));
    expect(executor?.systemPrompt).toBe(systemPromptFor('executor', 'ROLE PROMPT FOR EXECUTOR', task));
    expect(planner?.systemPrompt).not.toContain('Video task');
    expect(planner?.schema).toBe('planner-output');
    expect(planner?.tools).toEqual([]);
    expect(h.video.runs).toEqual([]);
    expect(h.video.scaffolds).toBe(0);
    expect(h.eventsOf(runner, 'video_setup')).toEqual([]);
    expect(task.status).toBe('done');
  });

  it('an old task.json, written before kinds existed, loads and runs as a coding task', async () => {
    h.planner(P.cont('Create README.md')).executor(E.ok(['README.md'])).planner(P.done());
    const runner = await h.create();
    const old = h.task(runner) as TaskRecord & { kind?: unknown; video?: unknown };
    expect(old.kind).toBeUndefined();
    expect(old.video).toBeUndefined();
    const reloaded = TaskRunner.load(old, h.events(runner), h.deps());
    await reloaded.start();
    expect(h.task(reloaded).status).toBe('done');
    expect(h.specs.every((s) => s.schema !== 'planner-output-video')).toBe(true);
    expect(h.video.runs).toEqual([]);
  });

  it('keeps the file ping-pong window at three turns', () => {
    const turn = { files: ['a.ts'], instruction: 'fix the same thing in a.ts again please' };
    let history: ReturnType<typeof trackTurns>['history'] = [];
    let fired = false;
    for (let i = 0; i < PING_PONG_TURNS; i++) {
      const r = trackTurns(history, turn);
      history = r.history;
      fired = r.pingPong;
    }
    expect(PING_PONG_TURNS).toBe(3);
    expect(fired).toBe(true);
  });
});

describe('creating a Video task (§21.2)', () => {
  it('stores the kind and the settings, with nothing set up yet', async () => {
    const runner = await h.createVideo({}, { durationSec: 12, gif: true });
    const task = h.task(runner);
    expect(task.kind).toBe('video');
    expect(task.video?.settings).toEqual({ durationSec: 12, width: 1920, height: 1080, fps: 30, gif: true });
    expect(task.video?.kitDir).toBe('video');
    expect(task.video?.install.consent).toBeNull();
    expect(task.video?.setup).toEqual({ done: false, scaffold: null, kitVersion: null, doctor: null, imageCheck: null, forceImageCheck: false });
    expect(task.video?.storyboard).toBeNull();
    expect(task.video?.final).toBeNull();
    expect(task.plannerCwd).toBe(h.projectDir);
    expect(h.eventsOf(runner, 'task_created')[0]).toMatchObject({ kind: 'video', video: { durationSec: 12, gif: true } });
    expect(h.video.runs).toEqual([]);
  });

  it('refuses an isolated Planner, an Executor that cannot run commands, and missing settings', async () => {
    await expect(h.createVideo({ plannerContextMode: 'isolated' })).rejects.toThrow(/read-only Planner/);
    await expect(h.createVideo({ executorTools: ['Read', 'Edit', 'Write'] })).rejects.toThrow(/neither Bash nor PowerShell/);
    await expect(h.createVideo({ executorTools: ['Read', 'PowerShell'] })).resolves.toBeInstanceOf(TaskRunner);
    await expect(
      TaskRunner.create({ description: 'x', projectDir: h.projectDir, config: { ...TEST_CONFIG, plannerContextMode: 'read_only' }, kind: 'video' }, h.deps()),
    ).rejects.toThrow(TaskCreationError);
  });
});

describe('consent before anything is downloaded (§21.3)', () => {
  it('waits for the human, with the plan for this computer, and installs nothing until they agree', async () => {
    const runner = await h.createVideo();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('waiting_user');
    expect(task.waiting).toMatchObject({ kind: 'install_consent', plan: { packages: true, ffmpeg: false, chromium: false } });
    expect(task.waiting?.kind === 'install_consent' && task.waiting.folder.endsWith('/project/video')).toBe(true);
    expect(h.video.runs).toEqual([]);
    expect(h.video.scaffolds).toBe(0);
    expect(h.specs).toHaveLength(0);

    h.imageCheck('ABCD-2345').planner(P.ask('What should the title say?'));
    await runner.consentInstall();
    task = h.task(runner);
    expect(task.video?.install.consent?.plan).toEqual({ packages: true, ffmpeg: false, chromium: false });
    expect(h.video.scaffolds).toBe(1);
    expect(h.video.runs.map((r) => r.kind)).toEqual(['install', 'doctor']);
    expect(task.video?.setup.done).toBe(true);
    expect(h.eventsOf(runner, 'intervention').map((e) => e.kind)).toContain('consent_install');
    h.assertScriptDone();
  });

  it('names the ffmpeg build and the browser only when this computer needs them', async () => {
    h.video.ffmpeg = false;
    h.video.browser = null;
    const runner = await h.createVideo();
    await runner.start();
    expect(h.task(runner).waiting).toMatchObject({ kind: 'install_consent', plan: { packages: true, ffmpeg: true, chromium: true } });
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.consentInstall();
    expect(h.video.runs).toEqual([{ kind: 'install' }, { kind: 'tools', downloadBrowser: true, ffmpeg: true }, { kind: 'doctor', code: 'ABCD-2345' }]);
  });

  it('a consent given in the New task dialog is used, and one that does not cover the plan is not', async () => {
    const consented = await TaskRunner.create(
      { description: 'A title card.', projectDir: h.projectDir, config: { ...TEST_CONFIG, plannerContextMode: 'read_only' }, kind: 'video', video: { durationSec: 6, width: 1920, height: 1080, fps: 30, gif: false }, videoConsent: { packages: true, ffmpeg: false, chromium: false } },
      h.deps(),
    );
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await consented.start();
    expect(h.task(consented).waiting?.kind).toBe('question');
    expect(h.video.runs.map((r) => r.kind)).toEqual(['install', 'doctor']);

    // Another folder state: ffmpeg is missing too, which that consent never mentioned.
    const h2 = new Harness();
    try {
      h2.video.ffmpeg = false;
      const partial = await TaskRunner.create(
        { description: 'A title card.', projectDir: h2.projectDir, config: { ...TEST_CONFIG, plannerContextMode: 'read_only' }, kind: 'video', video: { durationSec: 6, width: 1920, height: 1080, fps: 30, gif: false }, videoConsent: { packages: true, ffmpeg: false, chromium: false } },
        h2.deps(),
      );
      await partial.start();
      expect(h2.task(partial).waiting).toMatchObject({ kind: 'install_consent', plan: { packages: true, ffmpeg: true } });
      expect(h2.video.runs).toEqual([]);
    } finally {
      h2.cleanup();
    }
  });

  it('asks nothing when everything is already installed, and Resume never asks twice', async () => {
    installed();
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    expect(h.eventsOf(runner, 'status').filter((e) => e.waiting?.kind === 'install_consent')).toHaveLength(0);
    expect(h.video.runs.map((r) => r.kind)).toEqual(['doctor']);
    expect(h.task(runner).video?.setup.scaffold).toBe('existing');
  });

  it('Cancel (Stop) while waiting leaves the task stopped, and Resume asks again', async () => {
    const runner = await h.createVideo();
    await runner.start();
    await runner.stop();
    expect(h.task(runner).status).toBe('stopped');
    await runner.resume();
    expect(h.task(runner).waiting?.kind).toBe('install_consent');
    expect(h.video.runs).toEqual([]);
  });
});

describe('the kit (§21.3 step 3)', () => {
  it('copies the template into an absent folder and commits it on its own', async () => {
    h.video.onRun = () => {
      h.git.pending = ['video/src/video.ts'];
      return {};
    };
    const runner = await h.createVideo();
    await runner.start();
    h.git.pending = ['video/package.json', 'video/kit.json'];
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.consentInstall();
    expect(h.video.scaffolds).toBe(1);
    expect(h.task(runner).video?.setup).toMatchObject({ scaffold: 'copied', kitVersion: '1.0.0' });
    expect(h.git.commits[0]).toMatchObject({ message: `[${APP_SLUG}] video kit added`, files: ['video/package.json', 'video/kit.json'] });
    expect(h.eventsOf(runner, 'commit')[0]).toMatchObject({ purpose: 'video_kit', info: { state: 'committed' } });
  });

  it('uses a kit that is already there and never copies over it', async () => {
    h.video.kit = { state: 'kit', version: '0.9.0', packagesInstalled: false, ffmpegInstalled: false, chromiumDownloaded: false };
    const runner = await h.createVideo();
    await runner.start();
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.consentInstall();
    expect(h.video.scaffolds).toBe(0);
    expect(h.task(runner).video?.setup).toMatchObject({ scaffold: 'existing', kitVersion: '0.9.0' });
    expect(h.git.commits).toEqual([]);
  });

  it('stops at a video folder that is not a kit, without touching it', async () => {
    h.video.kit = { state: 'foreign', version: null, packagesInstalled: false, ffmpegInstalled: false, chromiumDownloaded: false };
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/not a video kit/);
    expect(h.video.scaffolds).toBe(0);
    expect(h.video.runs).toEqual([]);
  });
});

describe('prerequisites, install and doctor (§21.3)', () => {
  it('stops with what to install when Node.js or npm is missing', async () => {
    h.video.node = null;
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/needs Node\.js and npm, and Node\.js was not found/);
    expect(h.video.runs).toEqual([]);
  });

  it('a failed install stops the task with the output, and Resume runs it again', async () => {
    let attempts = 0;
    h.video.onRun = (command) => (command.kind === 'install' && ++attempts === 1 ? { exitCode: 1, tail: 'npm ERR! network timeout' } : {});
    const runner = await h.createVideo();
    await runner.start();
    await runner.consentInstall();
    let task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/failed \(exit code 1\)[\s\S]*network timeout/);
    expect(h.eventsOf(runner, 'video_setup').find((e) => e.step === 'install')).toMatchObject({ ok: false });

    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.resume();
    task = h.task(runner);
    expect(task.waiting?.kind).toBe('question');
    expect(h.video.runs.map((r) => r.kind)).toEqual(['install', 'install', 'doctor']);
    // The kit was copied once, not again on Resume.
    expect(h.video.scaffolds).toBe(1);
  });

  it('a command that times out stops the task and says so', async () => {
    installed();
    h.video.onRun = () => ({ exitCode: null, timedOut: true });
    const runner = await h.createVideo();
    await runner.start();
    expect(h.task(runner).status).toBe('error');
    expect(h.task(runner).statusReason).toMatch(/did not finish in time/);
  });

  it('Cancel during a command stops the task; Resume continues the setup', async () => {
    installed();
    let release: (() => void) | null = null;
    h.video.onRun = (_command, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ exitCode: null, aborted: true }));
        release = () => resolve({});
      });
    const runner = await h.createVideo();
    const running = runner.start();
    await waitFor(() => h.video.runs.length === 1);
    await runner.stop();
    await running;
    expect(h.task(runner).status).toBe('stopped');
    expect(release).not.toBeNull();

    h.video.onRun = null;
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.resume();
    expect(h.task(runner).waiting?.kind).toBe('question');
  });

  it('stops when doctor says the folder cannot render, with doctor’s own reasons', async () => {
    installed();
    h.video.doctor = { ok: false, problems: ['The ffmpeg found (ffmpeg) has no libx264 encoder.'], warnings: [], chosen: 'msedge', hardware: true };
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/cannot render the video yet\. The ffmpeg found/);
    expect(task.video?.setup.doctor?.ok).toBe(false);
    expect(h.specs).toHaveLength(0);
  });

  it('when no installed browser works, asks again before downloading one', async () => {
    installed();
    h.video.doctor = { ok: false, problems: ['No browser could be launched with WebGL 2.'], warnings: [], chosen: null, hardware: false };
    const runner = await h.createVideo();
    await runner.start();
    let task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.video?.install.needsChromium).toBe(true);
    expect(task.statusReason).toMatch(/asked before a browser is downloaded/);

    await runner.resume();
    task = h.task(runner);
    expect(task.waiting).toMatchObject({ kind: 'install_consent', plan: { packages: false, ffmpeg: false, chromium: true } });
    expect(h.video.runs.map((r) => r.kind)).toEqual(['doctor']);
  });

  it('records what doctor found, and tells both agents', async () => {
    installed();
    h.imageCheck('ABCD-2345').planner(P.cont('Write the storyboard.', { revises_storyboard: true })).executor(E.ok(['video/storyboard.json'])).planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(task.video?.setup.doctor).toMatchObject({ ok: true, browser: 'Microsoft Edge', browserVersion: '157.0.4341.42', hardware: true, msPerFrame: 45 });
    const planner = h.specs[1];
    const executor = h.specs[2];
    for (const spec of [planner, executor]) {
      expect(spec?.systemPrompt).toContain('## Video task');
      expect(spec?.systemPrompt).toContain('Length: 6 s at 30 fps, so 180 frames (0 to 179). Size: 1920×1080.');
      expect(spec?.systemPrompt).toContain('Microsoft Edge 157.0.4341.42, hardware-accelerated, about 45 ms per frame');
    }
    expect(planner?.systemPrompt).toContain('VIDEO SECTION FOR PLANNER');
    expect(executor?.systemPrompt).toContain('VIDEO SECTION FOR EXECUTOR');
    expect(planner?.schema).toBe('planner-output-video');
    expect(executor?.schema).toBe('executor-output');
    expect(planner?.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(planner?.cwd).toBe(h.projectDir);
    expect(planner?.prompt).toContain('This is a Video task');
  });

  it('tells both agents when the project has a kit from before the style toolkit, and only then (§21.9)', async () => {
    const promptsFor = async (version: string) => {
      h.cleanup();
      h = new Harness();
      h.video.kit = { state: 'kit', version, packagesInstalled: true, ffmpegInstalled: false, chromiumDownloaded: false };
      h.imageCheck('ABCD-2345').planner(P.cont('Write the storyboard.', { revises_storyboard: true })).executor(E.ok(['video/storyboard.json'])).planner(P.ask('?'));
      const runner = await h.createVideo();
      await runner.start();
      expect(h.task(runner).video?.setup.kitVersion).toBe(version);
      return [h.specs[1]?.systemPrompt ?? '', h.specs[2]?.systemPrompt ?? ''];
    };
    for (const prompt of await promptsFor('1.0.0')) {
      expect(prompt).toContain("This project's kit is version 1.0.0, from before the style toolkit");
      expect(prompt).toContain('Do not replace or upgrade the kit.');
      // Its stills still write every frame at full size (§21.10): the agents are told to open the sheet.
      expect(prompt).toContain('always writes every review frame at full size');
      expect(prompt).toContain('Open the contact sheet, and a full-size frame only when a detail needs it.');
    }
    for (const version of ['1.1.0', '1.2.0']) {
      for (const prompt of await promptsFor(version)) expect(prompt).not.toContain('from before the style toolkit');
    }
  });
});

describe('the image check (§21.3 step 5)', () => {
  it('runs one session launched like the Planner, compares the code, and caches the pass', async () => {
    installed();
    h.imageCheck('abcd-2345 ').planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    const check = h.specs[0];
    expect(check).toMatchObject({ agent: 'planner', schema: 'image-check', cwd: h.projectDir, model: 'opus', effort: 'low' });
    expect(check?.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(check?.prompt).toContain('video/out/doctor/code.png');
    const task = h.task(runner);
    expect(task.video?.setup.imageCheck).toMatchObject({ ok: true, cached: false });
    const key = imageCheckKey('2.1.322', TEST_CONFIG.planner);
    expect(task.video?.setup.imageCheck?.key).toBe(key);
    expect(h.video.passes.has(key)).toBe(true);
    // The check is not a Planner turn of the task: the Planner's session and counters are untouched by it.
    expect(task.plannerTurns).toBe(1);
    expect(h.eventsOf(runner, 'video_setup').find((e) => e.step === 'image_check')).toMatchObject({ ok: true, costUsd: 0.01 });
  });

  it('a second task with the same CLI version, flags and model spends no turn', async () => {
    installed();
    h.video.passes.set(imageCheckKey('2.1.322', TEST_CONFIG.planner), '2026-11-10T00:00:00.000Z');
    h.planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]?.schema).toBe('planner-output-video');
    expect(h.task(runner).video?.setup.imageCheck).toMatchObject({ ok: true, cached: true });
    h.assertScriptDone();
  });

  it('runs again when the CLI version, the model or the effort changes', () => {
    const base = imageCheckKey('2.1.322', { model: 'opus', effort: 'medium' });
    expect(imageCheckKey('2.1.322', { model: 'opus', effort: 'medium' })).toBe(base);
    expect(imageCheckKey('2.1.323', { model: 'opus', effort: 'medium' })).not.toBe(base);
    expect(imageCheckKey('2.1.322', { model: 'sonnet', effort: 'medium' })).not.toBe(base);
    expect(imageCheckKey('2.1.322', { model: 'opus', effort: 'high' })).not.toBe(base);
    expect(imageCheckKey(null, { model: 'opus', effort: 'medium' })).not.toBe(base);
  });

  it('a forced re-check ignores the cache once, and is refused while the task runs', async () => {
    installed();
    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    const runner = await h.createVideo();
    await runner.start();
    expect(h.specs).toHaveLength(2);

    await runner.stop();
    runner.recheckImage();
    let task = h.task(runner);
    expect(task.video?.setup).toMatchObject({ done: false, imageCheck: null, forceImageCheck: true });
    expect(h.video.passes.size).toBe(0);

    h.imageCheck('ABCD-2345');
    await runner.resume();
    task = h.task(runner);
    expect(h.specs[2]?.schema).toBe('image-check');
    expect(task.video?.setup).toMatchObject({ done: true, forceImageCheck: false });
    expect(task.video?.setup.imageCheck).toMatchObject({ ok: true, cached: false });
    // The question that was pending when the task was stopped comes back, as for any task.
    expect(task.waiting?.kind).toBe('question');

    const coding = await new Harness().create();
    expect(() => coding.recheckImage()).toThrow(TaskStateError);
  });

  it('stops the task, with the reason, when the session cannot see the image; a failure is never cached', async () => {
    installed();
    h.imageCheck(null);
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(task.status).toBe('error');
    expect(task.statusReason).toMatch(/Video tasks cannot run here: the Planner could not read an image/);
    expect(task.statusReason).toMatch(/not an image I can open/);
    expect(task.video?.setup.imageCheck).toMatchObject({ ok: false, cached: false });
    expect(h.video.passes.size).toBe(0);
    expect(task.video?.setup.done).toBe(false);
  });

  it('a wrong code and a failed turn both stop the task, and Resume checks again', async () => {
    installed();
    h.imageCheck('WXYZ-9999');
    const runner = await h.createVideo();
    await runner.start();
    expect(h.task(runner).statusReason).toMatch(/read a different code/);

    h.on('planner', (spec) => failOutcome(spec, 'process_failed', { message: 'the CLI crashed' }));
    await runner.resume();
    expect(h.task(runner).statusReason).toMatch(/The check turn failed: the CLI crashed/);

    h.imageCheck('ABCD-2345').planner(P.ask('?'));
    await runner.resume();
    expect(h.task(runner).waiting?.kind).toBe('question');
    expect(h.video.passes.size).toBe(1);
  });
});

describe('limits for a Video task (§21.6)', () => {
  it('pauses for a possible loop after five turns on the same files, not three', async () => {
    installed();
    h.imageCheck('ABCD-2345');
    const fix = (n: number) => `In video/src/video.ts fix the title position in shot two, attempt ${n}, then run the stills for shot two and report`;
    for (let i = 1; i <= VIDEO_PING_PONG_TURNS; i++) h.planner(P.cont(fix(i))).executor(E.ok(['video/src/video.ts']));
    const runner = await h.createVideo();
    await runner.start();
    const task = h.task(runner);
    expect(VIDEO_PING_PONG_TURNS).toBe(5);
    expect(task.cycles).toBe(5);
    expect(task.waiting).toMatchObject({ kind: 'possible_loop' });
    expect(h.eventsOf(runner, 'loop_detected')[0]).toMatchObject({ kind: 'file_ping_pong' });
    h.assertScriptDone();
  });
});
