/**
 * The early rollover of a Video task's Executor (SPEC.md §15, §21.10), in the real state machine with a
 * scripted runner: it fires at 150,000 tokens instead of the model's own threshold, in the middle of a
 * shot, and the task carries on from the files: the same shot, the same approved storyboard, the same gates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VIDEO_EXECUTOR_ROLLOVER_TOKENS, rolloverCapFor } from '../../shared/video';
import type { TurnSpec } from '../session-runner/types';
import { imageCheckKey } from './orchestrator';
import { rolloverDue } from './safety';
import { E, HANDOFF, Harness, P, TEST_CONFIG, okOutcome } from './__tests__/harness';

let h: Harness;

const isHandoff = (s: TurnSpec) => s.schema === 'handoff-summary' || s.answerFile?.schema === 'handoff-summary';
const big = (tokens: number) => ({ usage: { contextTokens: tokens, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1, costUsd: 0, modelUsage: {}, sessionCostUsd: 0, sessionModelUsage: {} } });

const STORYBOARD = 'Write video/storyboard.md and video/storyboard.json for the two shots.';
const BUILD = 'Build shot-01 in video/src/shots/shot-01.ts, run the stills for it and report.';
const FIX = 'shot-01, frame 45: the roof on the left is one flat colour. Give it a painted texture in video/src/shots/shot-01.ts, run the stills for shot-01 and report.';
const NEXT = 'Build shot-02 in video/src/shots/shot-02.ts, run the stills for it and report.';

beforeEach(() => {
  h = new Harness();
  h.video.kit = { state: 'kit', version: '1.1.0', packagesInstalled: true, ffmpegInstalled: false, chromiumDownloaded: false };
  h.video.passes.set(imageCheckKey('2.1.322', TEST_CONFIG.planner), '2026-11-10T00:00:00.000Z');
});

afterEach(() => {
  h.cleanup();
});

/** A Video task up to the storyboard gate; the build step is held there. */
async function toStoryboardGate() {
  h.planner(P.cont(STORYBOARD, { revises_storyboard: true }));
  h.on('executor', (spec) => {
    h.video.board = { state: 'valid', problems: [], hash: 'hash-1' };
    return okOutcome(spec, E.ok(['video/storyboard.json', 'video/storyboard.md']));
  }).planner(P.cont(BUILD));
  const runner = await h.createVideo();
  await runner.start();
  expect(h.task(runner).waiting?.kind).toBe('storyboard_approval');
  return runner;
}

describe('the rule (SPEC.md §21.10)', () => {
  it('is 150,000 tokens for the Executor of a Video task, and nothing for anyone else', () => {
    expect(VIDEO_EXECUTOR_ROLLOVER_TOKENS).toBe(150_000);
    expect(rolloverCapFor('video', 'executor')).toBe(150_000);
    expect(rolloverCapFor('video', 'planner')).toBeNull();
    expect(rolloverCapFor('code', 'executor')).toBeNull();
    expect(rolloverCapFor(undefined, 'executor')).toBeNull();
  });

  it('the smaller of the cap and the model’s own threshold counts', () => {
    // sonnet: 60 % of 967,000 = 580,200, so the cap decides.
    expect(rolloverDue(150_000, 'sonnet', 60, 150_000)).toEqual({ due: false, threshold: 150_000, capped: true });
    expect(rolloverDue(150_001, 'sonnet', 60, 150_000)).toEqual({ due: true, threshold: 150_000, capped: true });
    // A 200k-context model already rolls over at 100,200: the cap changes nothing.
    expect(rolloverDue(120_000, 'claude-sonnet-4-6', 60, 150_000)).toEqual({ due: true, threshold: 100_200, capped: false });
    // A lower percentage set by the user still wins.
    expect(rolloverDue(60_000, 'sonnet', 5, 150_000)).toMatchObject({ due: true, threshold: 48_350, capped: false });
    // Without a cap nothing changed.
    expect(rolloverDue(150_001, 'sonnet', 60)).toEqual({ due: false, threshold: 580_200, capped: false });
  });
});

describe('a Video task across a rollover in the middle of a shot', () => {
  it('hands off at 150,001 tokens, and the fix for the same shot runs in a fresh session that is sent to the files', async () => {
    const runner = await toStoryboardGate();
    // The build turn leaves the Executor's session past the cap; the Planner then wants a fix on the same shot.
    h.executor(E.ok(['video/src/shots/shot-01.ts', 'video/progress.md']), big(150_001))
      .planner(P.cont(FIX))
      .executor(HANDOFF)
      .executor(E.ok(['video/src/shots/shot-01.ts', 'video/progress.md']))
      .planner(P.cont(NEXT))
      .executor(E.ok(['video/src/shots/shot-02.ts', 'video/progress.md']))
      .planner(P.ask('Both shots pass. Render now?'));
    await runner.approveStoryboard();

    const task = h.task(runner);
    const executorTurns = h.specs.filter((s) => s.agent === 'executor');
    const [, build, handoff, fix, next] = executorTurns;
    // The handoff ran in the session that built the shot, by file, with the Executor's own schema.
    expect(executorTurns.filter(isHandoff)).toEqual([handoff]);
    expect(handoff?.resumeSessionId).toBe(build?.resumeSessionId ?? build?.newSessionId);
    expect(handoff?.schema).toBe('executor-output');
    // The fix for shot-01 runs in a new session: the summary, then where the state is, then the instruction.
    expect(fix?.newSessionId).toBe(task.sessions.executor.sessionId);
    expect(fix?.resumeSessionId).toBeUndefined();
    const prompt = fix?.prompt ?? '';
    const seedAt = prompt.indexOf('[ORCHESTRATOR] You are continuing this task');
    const filesAt = prompt.indexOf('its state is in the project\'s files');
    const instructionAt = prompt.indexOf(`[INSTRUCTION]\n${FIX}`);
    expect(seedAt).toBe(0);
    expect(filesAt).toBeGreaterThan(seedAt);
    expect(instructionAt).toBeGreaterThan(filesAt);
    expect(prompt).toContain('`video/storyboard.json`');
    expect(prompt).toContain('`video/progress.md`');
    expect(prompt).toContain('the files are right');
    // The fresh session is a Video session like the first: the same section in its system prompt.
    expect(fix?.systemPrompt).toContain('VIDEO SECTION FOR EXECUTOR');
    // The next shot continues in that new session; no second handoff at 5,000 tokens.
    expect(next?.resumeSessionId).toBe(fix?.newSessionId);
    expect(next?.prompt).toContain(NEXT);

    // What the task holds afterwards.
    expect(task.sessions.executor.retired).toHaveLength(1);
    expect(task.sessions.executor.retired[0]?.reason).toContain('exceeded the rollover threshold 150,000');
    expect(task.sessions.executor.retired[0]?.reason).toContain("a Video task's Executor starts a fresh session early");
    expect(h.eventsOf(runner, 'rollover')).toMatchObject([{ agent: 'executor', summary: HANDOFF }]);
    // Nothing else moved: the storyboard stays approved, the gate did not fire again, cycles count the work only.
    expect(task.video?.storyboard).toMatchObject({ approvedHash: 'hash-1' });
    expect(h.eventsOf(runner, 'intervention').filter((e) => e.kind === 'approve_storyboard')).toHaveLength(1);
    expect(h.statuses(runner).filter((s) => s === 'waiting_user')).toHaveLength(2);
    expect(task.cycles).toBe(4);
    expect(task.waiting?.kind).toBe('question');
    h.assertScriptDone();
  });

  it('and the task still ends at the final gate, with the video the fresh session rendered', async () => {
    const runner = await toStoryboardGate();
    h.executor(E.ok(['video/src/shots/shot-01.ts']), big(200_000))
      .planner(P.cont('Run npm test, then npm run render until DONE, in video/.'))
      .executor(HANDOFF)
      .on('executor', (spec) => {
        h.video.mp4 = { size: 2_000_000, mtimeMs: 1_000 };
        return okOutcome(spec, E.ok([]));
      })
      .planner(P.done('The video is rendered.'));
    await runner.approveStoryboard();
    let task = h.task(runner);
    expect(task.waiting?.kind).toBe('video_approval');
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(1);
    await runner.approveVideo();
    task = h.task(runner);
    expect(task.status).toBe('done');
    expect(task.video?.final).toMatchObject({ size: 2_000_000 });
    h.assertScriptDone();
  });

  it('at exactly 150,000 nothing happens, and the Planner of a Video task keeps the model’s threshold', async () => {
    h.planner(P.cont(STORYBOARD, { revises_storyboard: true }), big(400_000));
    h.on('executor', (spec) => {
      h.video.board = { state: 'valid', problems: [], hash: 'hash-1' };
      return okOutcome(spec, E.ok(['video/storyboard.json']), big(150_000));
    }).planner(P.cont(BUILD));
    const runner = await h.createVideo();
    await runner.start();
    h.executor(E.ok(['video/src/video.ts'])).planner(P.ask('?'));
    await runner.approveStoryboard();
    expect(h.specs.filter(isHandoff)).toHaveLength(0);
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(0);
    h.assertScriptDone();
  });

  it('a coding task with the same Executor and the same context does not roll over', async () => {
    h.planner(P.cont('A')).executor(E.ok(), big(300_000)).planner(P.cont('B')).executor(E.ok(['b'])).planner(P.done());
    const runner = await h.create();
    await runner.start();
    expect(h.specs.filter(isHandoff)).toHaveLength(0);
    expect(h.task(runner).status).toBe('done');
    h.assertScriptDone();
  });

  it('a handoff the Executor cannot produce does not stop the video: the session is kept and the shot goes on', async () => {
    const runner = await toStoryboardGate();
    h.executor(E.ok(['video/src/shots/shot-01.ts']), big(180_000))
      .planner(P.cont(FIX))
      .on('executor', (spec) => ({ ...okOutcome(spec, null), ok: false, error: { kind: 'process_failed', message: 'the CLI died', rawText: '' } }) as never)
      .executor(E.ok(['video/src/shots/shot-01.ts']))
      .planner(P.ask('?'));
    await runner.approveStoryboard();
    const task = h.task(runner);
    expect(h.eventsOf(runner, 'rollover')).toHaveLength(0);
    expect(h.eventsOf(runner, 'rollover_skipped')).toHaveLength(1);
    expect(task.sessions.executor.retired).toHaveLength(0);
    expect(h.specs.filter((s) => s.agent === 'executor').at(-1)?.prompt).toContain(FIX);
    expect(task.waiting?.kind).toBe('question');
    h.assertScriptDone();
  });
});
