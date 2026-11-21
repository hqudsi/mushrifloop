/**
 * Everything the orchestrator says to the agents — pure text composition.
 *
 * Tags: `[TASK]`, `[EXECUTOR REPORT]`, `[INSTRUCTION]` from the orchestrator's loop; `[FROM USER]` for the
 * human (the role prompts say those take priority); `[ORCHESTRATOR]` for refusals, retries and rollovers.
 */

import * as path from 'node:path';

import { posixPath, posixPaths } from '../../shared/format';
import { compareVersions } from '../../shared/models';
import { VIDEO_KIT_STYLE_SINCE, VIDEO_PROGRESS_FILE } from '../../shared/video';
import type { ApprovalMode } from '../../shared/settings';
import { describeToolUses } from './answer-check';
import { describeSkillState } from './skills';
import type {
  AgentRole,
  AnswerCheck,
  CommitInfo,
  ExecutorOutput,
  HandoffSummary,
  SkillBlock,
  SkillOutcome,
  TaskRecord,
  TaskStatus,
} from './types';
import type { PermissionDenial } from '../session-runner/types';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const json = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/**
 * The paths inside an answer, with forward slashes, before the app puts it back in front of an agent
 * (SPEC.md §4). Only the fields the app knows are paths are touched; prose is left as it is.
 */
export function withPosixPaths<T extends ExecutorOutput | HandoffSummary>(output: T): T {
  if ('changed_files' in output && Array.isArray(output.changed_files)) {
    return { ...output, changed_files: output.changed_files.map((f) => ({ ...f, path: posixPath(f.path) })) };
  }
  if ('key_files' in output && Array.isArray(output.key_files)) {
    return { ...output, key_files: posixPaths(output.key_files) };
  }
  return output;
}

// ---------------------------------------------------------------------------
// System prompts (fixed per session)
// ---------------------------------------------------------------------------

/**
 * The `## Video task` section of a Video task's system prompt (SPEC.md §21.4): the shipped text for that
 * agent, then the facts of this video and of this computer. Null for a coding task, whose prompt is then
 * exactly what it was before Video tasks existed.
 */
export function videoSection(sectionText: string | null, task: TaskRecord): string | null {
  const video = task.video;
  if (task.kind !== 'video' || !video || sectionText === null) return null;
  const { durationSec, width, height, fps, gif } = video.settings;
  const frames = Math.round(durationSec * fps);
  const lines = [
    sectionText.trimEnd(),
    '',
    'This video:',
    `- Length: ${durationSec} s at ${fps} fps, so ${frames} frames (0 to ${frames - 1}). Size: ${width}×${height}. These are fixed: storyboard.json must say exactly this.`,
    gif ? '- A GIF is wanted too: `out/video.gif` must exist before done.' : '- No GIF was asked for.',
    `- The kit is in \`${video.kitDir}/\` in the project root.`,
  ];
  // A kit that was already in the project is used as it is (§21.3), so it can be older than this text.
  const kitVersion = video.setup.kitVersion;
  if (kitVersion !== null && compareVersions(kitVersion, VIDEO_KIT_STYLE_SINCE) < 0) {
    lines.push(
      `- This project's kit is version ${kitVersion}, from before the style toolkit: it has no \`src/style\` folder and no \`npm run small\`, and its \`npm run stills\` always writes every review frame at full size beside a larger contact sheet (\`--frame\` works only together with \`--crop\`). The rules for a drawn look hold all the same; what the toolkit would give is written in the project's own code. Open the contact sheet, and a full-size frame only when a detail needs it. Do not replace or upgrade the kit.`,
    );
  }
  const doctor = video.setup.doctor;
  if (doctor) {
    const speed = doctor.msPerFrame !== null ? `, about ${doctor.msPerFrame} ms per frame, so a full render takes about ${Math.max(1, Math.ceil((doctor.msPerFrame * frames) / 1000))} s plus encoding` : '';
    lines.push(
      `- Rendering on this computer: ${doctor.browser ?? 'a browser'}${doctor.browserVersion ? ` ${doctor.browserVersion}` : ''}, ${doctor.hardware ? 'hardware-accelerated' : 'software rendering (slow)'}${speed}.`,
    );
  }
  return lines.join('\n');
}

export function plannerSystemPrompt(role: string, task: TaskRecord, video: string | null = null): string {
  const parts = [role.trimEnd()];
  if (video !== null) parts.push(video);
  const skills = task.skills.available;
  if (skills === null) {
    parts.push('## Available skills\n\nThe skill list could not be determined when this session started. The orchestrator will tell you if it learns it later.');
  } else if (skills.length === 0) {
    parts.push('## Available skills\n\nNone.');
  } else {
    parts.push(`## Available skills\n\nThe executor can invoke these skills (put names in use_skills):\n${skills.map((s) => `- ${s}`).join('\n')}`);
  }
  if (task.config.requiredSkills.length > 0) {
    parts.push(
      `## Required before done\n\nThe orchestrator refuses status=done until the executor has run these skills successfully in this task: ${task.config.requiredSkills.join(', ')}. Request them with use_skills once the work is complete. If one of them cannot run in this environment, set status=done anyway when the work is complete: the orchestrator asks the user whether to waive it.`,
    );
  }
  const standing = task.config.standingInstructions.planner.trim();
  if (standing) parts.push(`## Standing instructions\n\n${standing}`);
  return parts.join('\n\n') + '\n';
}

export function executorSystemPrompt(role: string, task: TaskRecord, video: string | null = null): string {
  const parts = [role.trimEnd()];
  if (video !== null) parts.push(video);
  const standing = task.config.standingInstructions.executor.trim();
  if (standing) parts.push(`## Standing instructions\n\n${standing}`);
  // SPEC.md §3.1 (2026-10-06): without it the Executor could not find the contract an instruction pointed at.
  parts.push(
    '## The task (for reference)\n\n' +
      'This is the whole task the planner is working through, so you can read names, contracts and acceptance criteria from it. ' +
      'It is not your instruction: each turn, do exactly what the [INSTRUCTION] asks and nothing more, even when you can see what comes next.\n\n' +
      task.description.trim(),
  );
  return parts.join('\n\n') + '\n';
}

/** `videoText`: the shipped video section for this agent; only used when the task is a Video task. */
export function systemPromptFor(agent: AgentRole, role: string, task: TaskRecord, videoText: string | null = null): string {
  const video = videoSection(videoText, task);
  return agent === 'planner' ? plannerSystemPrompt(role, task, video) : executorSystemPrompt(role, task, video);
}

/** The system prompt of the image check (SPEC.md §21.3 step 5): the whole of it, in place of a role prompt. */
export function imageCheckSystemPrompt(): string {
  return (
    'You are checking whether this session can read an image file. You have the Read tool. ' +
    'Open the file you are told to open, look at it, and answer by calling the structured-output tool (StructuredOutput) once. ' +
    'seen is true or false. code is plain text: exactly the characters shown in the image, nothing else. ' +
    'If the image cannot be opened or you cannot see its content, set seen to false, code to an empty string, and say what happened in problem. Never guess a code.\n'
  );
}

export function imageCheckPrompt(file: string): string {
  return `Open the image ${file} in your working directory with the Read tool. It shows one short code in large letters. Report that code.`;
}

/** One line in the Planner's first prompt of a Video task; null for a coding task. `file` paths are relative to the project root. */
export function videoStartNote(task: TaskRecord): string | null {
  if (task.kind !== 'video' || !task.video) return null;
  return 'This is a Video task: follow the "Video task" section of your instructions. The kit in `video/` is installed and has been checked on this computer. Start with the storyboard.';
}

// ---------------------------------------------------------------------------
// Planner turns
// ---------------------------------------------------------------------------

/** `attachments`: the [ATTACHED FILES] lines for files attached to the new task, or null (SPEC.md §10). */
export function plannerStartPrompt(task: TaskRecord, planFirst: boolean, attachments: string | null = null): string {
  const lines = [
    '[TASK]',
    task.description.trim(),
    ...(attachments ? ['', attachments] : []),
    '',
    `Project folder name: ${path.basename(task.projectDir)} (the executor works in its root).`,
    task.config.noCycleLimit === true
      ? 'Limit: the user set no limit on executor turns for this task. Finish when the work is done; do not stretch it.'
      : `Limit: at most ${task.config.maxCycles} executor turns for this task.`,
  ];
  if (task.git.enabled && task.git.isRepo) {
    lines.push(
      `Git: the orchestrator commits the executor's changes after every successful cycle, on branch ${task.git.branch ?? '(task branch)'}. Do not ask the executor to run git.` +
        (task.git.hasRemote ? '' : ' This repository has no git remote.'),
    );
    if (task.git.snapshot) {
      lines.push(
        `The project already had uncommitted changes (${task.git.snapshot.files.length} file(s)); they were committed first as ${task.git.snapshot.hash.slice(0, 10)} ("snapshot before task"). They are the user's work, not yours.`,
      );
    }
  }
  const videoNote = videoStartNote(task);
  if (videoNote) lines.push('', videoNote);
  if (planFirst) {
    lines.push(
      '',
      'Approval mode: plan first. Before sending any instruction, reply with status=plan_ready and the complete step-by-step plan in `question`. The user approves or edits it; then you proceed one instruction at a time.',
    );
  }
  lines.push('', 'Reply with your first decision.');
  return lines.join('\n');
}

export interface ReportFacts {
  /** Refused structured answers in the Executor's turn (SPEC.md §4, §5 net 11). */
  answerCheck: AnswerCheck | null;
  /** The Executor's tool calls in the turn, by tool. */
  toolUses: Readonly<Record<string, number>>;
  cycle: number;
  /** Null: the task has no cycle limit (SPEC.md §5 net 1). */
  maxCycles: number | null;
  durationMs: number;
  slow: boolean;
  slowTurnMs: number | null;
  skillOutcomes: SkillOutcome[];
  permissionDenials: PermissionDenial[];
  killedProcesses: string[];
  commit: CommitInfo | null;
  userMessage: string | null;
  skillsLearned: string[] | null;
}

export function executorReportPrompt(output: ExecutorOutput, facts: ReportFacts): string {
  const lines: string[] = [];
  const of = facts.maxCycles === null ? '' : ` of at most ${facts.maxCycles}`;
  lines.push(
    facts.userMessage !== null
      ? `[EXECUTOR REPORT] Cycle ${facts.cycle}${of}. This turn answered a message the user sent the executor directly: "${clip(facts.userMessage, 400)}"`
      : `[EXECUTOR REPORT] Cycle ${facts.cycle}${of}.`,
  );
  lines.push(`Turn time: ${formatDuration(facts.durationMs)}.`);
  const check = facts.answerCheck;
  if (check) {
    const times = `${check.count} time${check.count === 1 ? '' : 's'}`;
    const reason = check.reasons.map((r) => `"${clip(r, 240)}"`).join(' / ');
    if (check.leakedMarkup) {
      lines.push(
        "⚠ POSSIBLY TRUNCATED REPORT: the Executor's accepted answer contains tool-call markup (`<parameter …>`) inside a text field, so some of its fields were typed into another one and may be missing or mixed up; ask it to resend the findings.",
      );
      if (check.count > 0) lines.push(`Its structured answer was also rejected ${times} before one was accepted (the CLI's reason: ${reason}).`);
      lines.push(
        `The Executor did work in this turn (${describeToolUses(facts.toolUses)}), so do not conclude from this report that it did nothing. Ask for the findings with a concrete question, not the same instruction again.`,
      );
    } else if (check.possiblyTruncated) {
      lines.push(
        `⚠ POSSIBLY TRUNCATED REPORT: the Executor's structured answer was rejected ${times}; the accepted answer is likely truncated; ask it to resend the findings.`,
        `The CLI's reason: ${reason}. The Executor did work in this turn (${describeToolUses(facts.toolUses)}), so do not conclude from this report that it did nothing. Ask for the findings with a concrete question, not the same instruction again.`,
      );
    } else {
      lines.push(
        `Note: the Executor's structured answer was rejected ${times} by the CLI's schema check before one was accepted (reason: ${reason}). Details may be missing from the report below; ask for them if you need them.`,
      );
    }
  }
  if (facts.slow) {
    lines.push(
      `⚠ Slow turn: it took ${formatDuration(facts.durationMs)}, over the ${formatDuration(facts.slowTurnMs ?? 0)} warning. Make your next instruction narrower: name concrete paths or a concrete search scope.`,
    );
  }
  for (const s of facts.skillOutcomes) {
    lines.push(`Skill ${s.skill}${s.requested ? '' : ' (not requested)'}: ${describeSkillState(s.state)}.`);
  }
  if (facts.permissionDenials.length > 0) {
    const list = facts.permissionDenials.map((d) => `${d.toolName} ${clip(JSON.stringify(d.input ?? ''), 120)}`);
    lines.push(`Denied tool calls (not allowed for the executor): ${list.join('; ')}.`);
  }
  if (facts.killedProcesses.length > 0) {
    lines.push(
      `Processes the turn left running and the orchestrator killed: ${facts.killedProcesses.length} (${facts.killedProcesses.join(', ')}). Anything they were still doing did not finish.`,
    );
  }
  if (facts.commit) lines.push(describeCommit(facts.commit));
  if (facts.skillsLearned) {
    lines.push(`Skills the executor can invoke (learned from its session): ${facts.skillsLearned.join(', ') || 'none'}.`);
  }
  lines.push('', "The executor's structured report:", json(withPosixPaths(output)));
  if (output.status === 'needs_input') {
    lines.push('', 'The executor needs input. Answer it yourself with a new instruction if you can; escalate with status=needs_user only if the user must decide.');
  }
  return lines.join('\n');
}

export function describeCommit(commit: CommitInfo): string {
  switch (commit.state) {
    case 'committed':
      return `Committed by the orchestrator: ${commit.hash.slice(0, 10)} (${commit.files.length} file(s)).`;
    case 'nothing_to_commit':
      return 'No commit: the working tree had no changes.';
    case 'skipped':
      return `No commit: ${commit.reason}`;
    case 'failed':
      return `The orchestrator's commit failed: ${clip(commit.error, 300)}`;
  }
}

export function userMessageBlock(text: string): string {
  return `[FROM USER]\n${text.trim()}`;
}

/**
 * A message on a task that had finished (SPEC.md §4). The Planner has to know two things it cannot
 * see: that the task was closed, and that answering is a legitimate outcome — otherwise a question
 * gets an instruction and a cycle nobody asked for.
 */
export function followUpNote(status: TaskStatus, finalReport: string | null): string {
  const ended = status === 'done' ? 'had finished' : status === 'failed' ? 'had failed' : `was ${status}`;
  const report = finalReport?.trim() ? `Your final report for it was:\n${clip(finalReport.trim(), 1500)}\n\n` : '';
  return (
    `[TASK REOPENED] This task ${ended}, and the user has come back to it.\n\n${report}` +
    'Decide what their message below is. If you can answer it from what you already know, answer it: ' +
    'reply with status "done" and put your answer in final_report — no instruction, no Executor turn, ' +
    'and the task stays finished. Only send an instruction if the message really needs work done in ' +
    'the project, and keep it to that; the user sees and approves that instruction before it runs. If ' +
    'you need something from them first, ask.'
  );
}

export function answerBlock(question: string, answer: string): string {
  return `[FROM USER] Answer to your question ("${clip(question, 300)}"):\n${answer.trim()}`;
}

export function unsentInstructionNote(instruction: string): string {
  return `[ORCHESTRATOR] Your last instruction was not sent to the executor, because the user wrote first. It was:\n${instruction}\nDecide what to send now.`;
}

export function requiredSkillsRefusal(missing: Array<{ skill: string; state: string }>, blocked: readonly SkillBlock[]): string {
  const lines = [
    '[ORCHESTRATOR] status=done refused. These skills are required before done and have not run successfully in this task:',
    ...missing.map((m) => `- ${m.skill}: ${m.state}`),
    '',
    'Send an instruction with use_skills naming them.',
  ];
  if (blocked.length > 0) {
    lines.push(
      `These required skills cannot run in this environment; once the rest is done, the user will be asked whether to waive them: ${blocked.map((b) => `${b.skill} (${b.reason})`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}

/** The waiting reason shown to the user when required skills cannot run here. */
export function waiverReason(blocks: readonly SkillBlock[]): string {
  const list = blocks.map((b) => `${b.skill} — ${b.reason.replace(/\.$/, '')}`).join('; ');
  return `A required skill cannot run in this environment: ${list}. Waive it for this task, or reply to the planner.`;
}

export function skillWaivedNote(block: SkillBlock): string {
  return `[ORCHESTRATOR] The user waived the required skill ${block.skill} for this task (${block.reason}). It is no longer required before done.`;
}

export function skillWaiverDeclined(blocks: readonly SkillBlock[], message: string): string {
  const names = blocks.map((b) => b.skill).join(', ');
  return `[FROM USER] The required skill(s) ${names} cannot run in this environment and were NOT waived; they are still required before done.\n${message.trim()}`;
}

/**
 * What the Planner is told when the user changes the approval mode mid-task (SPEC.md §7), or null when the
 * change is none of its business (Auto ↔ Review is handled by the orchestrator alone).
 */
export function approvalModeNote(to: ApprovalMode, planWasPending: boolean): string | null {
  if (to === 'plan_first') {
    return '[ORCHESTRATOR] The user switched this task to plan-first approval. Before any further instruction is sent, reply with status=plan_ready and the complete plan for the remaining work in `question`. The user approves or edits it; then you continue one instruction at a time.';
  }
  if (planWasPending) {
    return `[ORCHESTRATOR] The user switched this task from plan-first to ${to === 'auto' ? 'auto' : 'review'} approval: no plan approval is needed any more. Continue with your next decision.`;
  }
  return null;
}

/** A Planner answer with leaked tool-call markup is not acted on (SPEC.md §4, §5 net 10). */
export function malformedAnswerRefusal(): string {
  return '[ORCHESTRATOR] Your answer was not acted on: a text field in it contains tool-call markup (<parameter …>), so its fields were mixed up. Send the same decision again, with every field as its own field and only plain text inside each field.';
}

export function planFirstRefusal(): string {
  return '[ORCHESTRATOR] This task runs in plan-first mode and the plan has not been approved yet. Reply with status=plan_ready and the complete plan in `question`; do not send instructions before the user approves it.';
}

export function planApproved(editedPlan: string | null): string {
  return editedPlan === null
    ? '[FROM USER] The plan is approved. Proceed with the first step.'
    : `[FROM USER] The plan is approved with the user's edits. Follow this version:\n${editedPlan.trim()}\n\nProceed with the first step.`;
}

export function planRejected(reason: string): string {
  return `[FROM USER] The plan is not approved:\n${reason.trim()}\n\nRevise it and reply with status=plan_ready and the complete revised plan.`;
}

export function instructionRejected(instruction: string, reason: string): string {
  return `[FROM USER] Your instruction was rejected and not sent to the executor.\nInstruction: ${clip(instruction, 600)}\nReason:\n${reason.trim()}\n\nDecide what to do next.`;
}

/** The Planner's stopping answer is not applied because the user wrote while it was deciding. */
export function heldDecisionNote(output: unknown): string {
  return `[ORCHESTRATOR] Your answer below was not acted on, because the user sent a message while you were deciding; it is included in this turn. Take it into account and answer again.\nYour held answer: ${JSON.stringify(output)}`;
}

export function loopPauseNote(reason: string): string {
  return `[ORCHESTRATOR] The loop was paused for the user: ${reason}`;
}

// ---------------------------------------------------------------------------
// Executor turns
// ---------------------------------------------------------------------------

/** SPEC.md §16: the exact skill prefix. */
export function skillPrefix(skills: readonly string[]): string {
  return skills.length > 0 ? `Before doing anything else, invoke skill(s): ${skills.join(', ')}.\n\n` : '';
}

export function executorPrompt(input: {
  instruction: string | null;
  useSkills: readonly string[];
  userMessage: string | null;
}): string {
  const parts: string[] = [];
  if (input.userMessage !== null) parts.push(userMessageBlock(input.userMessage));
  if (input.instruction !== null) parts.push(`[INSTRUCTION]\n${input.instruction.trim()}`);
  return skillPrefix(input.useSkills) + parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Retries and rollover
// ---------------------------------------------------------------------------

export function retryNote(reason: string, agent: AgentRole): string {
  return agent === 'executor'
    ? `[ORCHESTRATOR] A previous attempt at the message below did not finish (${reason}). It may have been partly carried out: check the current state of the files before continuing. The message follows.`
    : `[ORCHESTRATOR] A previous attempt at the message below did not finish (${reason}). The message follows again.`;
}

export function handoffRequest(shorter = false): string {
  const base =
    '[ORCHESTRATOR] This session is being replaced by a fresh one to free context. Do not use any other tools and do not continue the task. ' +
    'Produce a handoff summary for your successor: call the structured-output tool once, with each handoff field as its own field. ' +
    // NOTES.md §27.6: six of the seven fields are arrays, and prose saying "plain text in each field" made the
    // model write a paragraph where a list belongs — 14 of 16 handoffs in Step C died on exactly that.
    'task_restatement is the only plain-text field. done_so_far, remaining, decisions, constraints, open_problems and key_files are each a LIST of short strings — one point per item, never a paragraph. ' +
    'For example: "done_so_far": ["Fixed the SELECT in src/repositories/order-repository.ts", "Added a regression test in test/unit/order-service.test.ts"]. ' +
    'Write plain prose inside an item — never field names, tags or JSON. Write file paths with forward slashes, never backslashes.';
  // SPEC.md §15: the one shorter attempt after a handoff the tool would not accept.
  return shorter
    ? `${base} Your last summary was refused, so keep this one small: at most four items per list, one short sentence each, at most five key_files, no pasted code and no long quotations. A short summary that arrives beats a complete one that does not.`
    : `${base} If the tool refuses your answer, send the same content again with every list as a list; do not shorten it.`;
}

/**
 * SPEC.md §15 (2026-10-06): the Executor's handoff goes into a file, so the turn keeps the Executor's own
 * `--json-schema` and its whole context stays in the prompt cache. `file` is relative to the project root.
 */
export function handoffFileRequest(file: string, shorter = false): string {
  const base =
    '[ORCHESTRATOR] This session is being replaced by a fresh one to free context. Do not continue the task. ' +
    `Write a handoff summary for your successor as one JSON object, with the Write tool, to ${file} (create the folder if needed). Use no other tool. ` +
    'The object has exactly these fields: task_restatement (a string: the task in your own words, with its acceptance criteria, a few sentences), ' +
    'and done_so_far, remaining, decisions, constraints, open_problems and key_files — each a LIST of short strings, one point per item, never a paragraph. ' +
    'For example: "done_so_far": ["Fixed the SELECT in src/repositories/order-repository.ts", "Added a regression test in test/unit/order-service.test.ts"]. ' +
    'Limits: task_restatement at most 1,500 characters; at most 20 items per list (key_files: 10, the files a new session should read first), each at most 500 characters. ' +
    'Write file paths with forward slashes, never backslashes, and make the file valid JSON. ' +
    `Then answer as usual: status ok, summary "Handoff written to ${file}", an empty changed_files list, tests {"ran": false} and an empty problems list.`;
  return shorter
    ? `${base} Your last summary could not be used, so keep this one small: at most four items per list, one short sentence each, at most five key_files, no pasted code and no long quotations. A short summary that arrives beats a complete one that does not.`
    : base;
}

/** SPEC.md §15: the Planner learns that the Executor's session was kept after a handoff it could not produce. */
export function rolloverSkippedNote(agent: AgentRole, reason: string): string {
  return (
    `[ORCHESTRATOR] The ${agent}'s session was NOT replaced: it could not produce a handoff summary the tool would accept (${clip(reason, 200)}). ` +
    'It keeps its current session and its context, so nothing was lost, but the context is still large: keep your next instructions narrow and concrete. Claude Code compacts the session itself if it fills up.'
  );
}

/** SPEC.md §5 net 11: the two ways the orchestrator re-asks after the tool gave up on an answer. */
export type AnswerRetryVariation = 'short_answer' | 'essential_fields';

export function answerRetryNote(variation: AnswerRetryVariation, refusals: number): string {
  const refused = refusals > 0 ? `The tool refused your answer ${refusals} time${refusals === 1 ? '' : 's'} and the turn ended without one.` : 'The turn ended without an answer the tool would accept.';
  return variation === 'short_answer'
    ? `[ORCHESTRATOR] ${refused} Do the work again only if you must; otherwise answer from what you already know, and answer SHORT: summary in 2-3 sentences, any exact text in evidence, file paths with forward slashes, plain text only — no tags, no JSON, no pasted blocks inside a field. The message follows.`
    : `[ORCHESTRATOR] ${refused} Answer with the REQUIRED fields only, one short sentence each, and leave every optional field out. No code, no quotations, no paths longer than a line. The message follows.`;
}

export function rolloverSeed(summary: HandoffSummary, agent: AgentRole, task: TaskRecord, answerCheck: AnswerCheck | null = null): string {
  const lines = [
    '[ORCHESTRATOR] You are continuing this task from an earlier session of yours that was replaced to free context. Its handoff summary:',
    json(withPosixPaths(summary)),
  ];
  if (answerCheck?.possiblyTruncated) {
    const why = answerCheck.leakedMarkup
      ? 'contains tool-call markup inside a text field, so parts of it may be missing or mixed up'
      : `was rejected ${answerCheck.count} time${answerCheck.count === 1 ? '' : 's'} by the schema check before one was accepted`;
    lines.push('', `Warning: that summary ${why}, and it is likely incomplete. Check the current state of the files you need before relying on it.`);
  }
  if (agent === 'planner') lines.push('', 'The original task description:', task.description.trim());
  // SPEC.md §21.10: a Video task's Executor is replaced early and often, so its state is in files.
  if (agent === 'executor' && task.kind === 'video' && task.video) {
    const dir = task.video.kitDir;
    lines.push(
      '',
      `This is a Video task, and its state is in the project's files, not in that summary. Before anything else, read \`${dir}/storyboard.json\`, \`${dir}/${VIDEO_PROGRESS_FILE}\` (your own progress notes) and the source file of the shot the next message is about. ` +
        'Where the summary and the files disagree, the files are right. Do not rebuild what the notes say is done, and do not re-read every shot: only what the next message needs.',
    );
  }
  lines.push('', 'The next message follows.', '');
  return lines.join('\n');
}

/**
 * The seed for a session the CLI no longer has (SPEC.md §5 net 13). There is no handoff summary to
 * carry — that is the whole problem — so it says so plainly and hands over what the app itself
 * recorded. An agent that is told its memory is gone asks or re-reads; one that is not, invents.
 */
export function restartSeed(agent: AgentRole, task: TaskRecord): string {
  const lines = [
    '[ORCHESTRATOR] Your earlier session for this task no longer exists on this machine, so none of ' +
      'that conversation is available to you. Nothing below is a summary you wrote: it is what the app ' +
      'recorded. Do not assume you remember anything else, and check the files before relying on them.',
    '',
    'The task:',
    task.description.trim(),
  ];
  if (task.finalReport?.trim()) lines.push('', 'The final report from before:', clip(task.finalReport.trim(), 1500));
  if (agent === 'executor' && task.loop.lastInstruction) {
    lines.push('', 'The last instruction the planner gave:', clip(task.loop.lastInstruction, 800));
  }
  lines.push('', task.config.noCycleLimit === true ? `Cycles used so far: ${task.cycles} (no limit is set).` : `Cycles used so far: ${task.cycles} of at most ${task.config.maxCycles}.`, '', 'The next message follows.', '');
  return lines.join('\n');
}

/** What actually goes on stdin for a step. */
export function composeStdin(step: { prompt: string; retryNote: string | null }, seed: string | null): string {
  return [seed, step.retryNote, step.prompt].filter((p): p is string => p !== null && p.length > 0).join('\n\n');
}

/**
 * An instruction squeezed onto one line, for commit messages. Not just the first line: planners often
 * open with a lead-in ("In the project root (x):"), which says nothing on its own (NOTES.md §16).
 */
export function shortSummary(text: string, max = 60): string {
  return clip(text, max);
}

// ---------------------------------------------------------------------------
// Video tasks: the two gates (SPEC.md §21.5)
// ---------------------------------------------------------------------------

export function storyboardApprovedNote(): string {
  return '[FROM USER] The storyboard is approved. Build it as approved, one shot at a time. If you have to change the storyboard later, say so in your final report: the human sees that it changed.';
}

export function storyboardRejected(instruction: string, notes: string): string {
  return (
    `[FROM USER] The storyboard is not approved yet. Notes:\n${notes.trim()}\n\n` +
    `Your instruction "${clip(instruction, 300)}" was not sent to the executor. Have the executor revise the storyboard ` +
    '(set revises_storyboard to true on that instruction); the human sees it again before anything is built.'
  );
}

export function storyboardRefusal(reading: { state: 'missing' | 'invalid' | 'valid'; problems: readonly string[] }): string {
  const why =
    reading.state === 'missing'
      ? 'There is no video/storyboard.json yet.'
      : reading.state === 'invalid'
        ? `video/storyboard.json is not valid: ${reading.problems.slice(0, 6).join(' ')}`
        : 'The human has not approved the storyboard yet.';
  return `[ORCHESTRATOR] status=done refused: a Video task cannot finish before the human has approved its storyboard. ${why} Have the executor write or fix the storyboard; the orchestrator shows it to the human before the first shot is built.`;
}

export function videoMissingRefusal(missing: readonly string[]): string {
  return (
    `[ORCHESTRATOR] status=done refused: ${missing.join(' and ')} ${missing.length === 1 ? 'does' : 'do'} not exist yet. ` +
    'Have the executor run `npm run render` in video/ until it prints DONE' +
    (missing.some((m) => m.endsWith('.gif')) ? ', then `npm run gif`' : '') +
    '; the orchestrator then shows the result to the human.'
  );
}

export function videoRejected(notes: string): string {
  return (
    `[FROM USER] The human watched the video and it is not approved yet. Notes:\n${notes.trim()}\n\n` +
    'Work them in, shot by shot, with stills as before; then render again and answer done. The human watches the new video before the task finishes.'
  );
}
