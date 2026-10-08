/**
 * The task timeline (SPEC.md §10), folded from events.jsonl.
 *
 * Pure and shared: the renderer rebuilds it from the stored events on load and again whenever a live
 * event arrives. It only arranges what the orchestrator recorded — no decisions are made here.
 *
 * A cycle card is the Planner turn that produced an instruction plus the Executor turn that carried it
 * out. Everything else — questions, refusals, rollovers, user messages, status changes — becomes its
 * own item, in order.
 */

import type { ApprovalMode } from './settings';
import { turnShareReader } from './turn-cost';
import type {
  AgentRole,
  AnswerCheck,
  CommitInfo,
  ConfigChangeEntry,
  CycleSummary,
  ExecutorOutput,
  HandoffSummary,
  PermissionDenial,
  PinnedAccount,
  PlannerOutput,
  SurvivorInfo,
  TaskConfig,
  TaskEvent,
  TurnErrorRecord,
  TurnRecord,
} from './task-model';

/** `interrupted`: the turn started but never reported, and nothing is running now (the app stopped). */
export type TurnState = 'running' | 'ok' | 'failed' | 'interrupted';

export interface TurnCardBase {
  turnId: string;
  startedAt: string;
  state: TurnState;
  /** What was sent on stdin. */
  prompt: string;
  sessionId: string;
  resumed: boolean;
  model: string;
  /** As launched (`--effort`); null when the model has no effort control. */
  effort: string | null;
  servedModel: string | null;
  modelMismatch: boolean;
  /** Another main-line model served part of the turn, e.g. a classifier fallback (SPEC.md §8). */
  alsoServed: string[];
  durationMs: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  slow: boolean;
  slowTurnMs: number | null;
  error: TurnErrorRecord | null;
  accountChanged: boolean;
  rawPath: string | null;
  /** Structured answers the CLI refused in this turn (SPEC.md §5 net 11); null when none. */
  answerCheck: AnswerCheck | null;
}

export interface PlannerCard extends TurnCardBase {
  agent: 'planner';
  purpose: string;
  output: PlannerOutput | null;
}

export interface ExecutorCard extends TurnCardBase {
  agent: 'executor';
  purpose: string;
  output: ExecutorOutput | null;
  killed: SurvivorInfo[];
  processMethod: 'job' | 'tree' | 'none' | null;
  denials: PermissionDenial[];
  summary: CycleSummary | null;
}

export interface SetupInfo {
  branch: string | null;
  originalBranch: string | null;
  startCommit: string | null;
  isRepo: boolean;
  hasRemote: boolean;
  inertReason: string | null;
  skills: number | null;
  skillsError: string | null;
  missingRequiredSkills: string[];
}

export type TimelineItem =
  | {
      kind: 'start';
      key: string;
      at: string;
      description: string;
      projectDir: string;
      config: TaskConfig;
      pinned: PinnedAccount;
      setup: SetupInfo | null;
      /** The user's pre-existing uncommitted work, committed before cycle 1. */
      snapshot: Extract<CommitInfo, { state: 'committed' }> | null;
    }
  | {
      kind: 'cycle';
      key: string;
      cycle: number;
      at: string;
      /** The Planner turn whose instruction this cycle carried out; null for a turn answering the user. */
      planner: PlannerCard | null;
      executor: ExecutorCard;
      /** Earlier attempts at the same cycle that failed or were stopped. */
      attempts: ExecutorCard[];
      preReviewCommit: CommitInfo | null;
      /** Review mode: the user approved the instruction before it ran — `text` is what was sent when edited. */
      approval: ApprovalInfo | null;
    }
  | { kind: 'planner'; key: string; card: PlannerCard }
  | {
      kind: 'handoff';
      key: string;
      agent: AgentRole;
      card: TurnCardBase;
      rollover: { oldSessionId: string; newSessionId: string; reason: string; summary: HandoffSummary | null } | null;
    }
  | { kind: 'user'; key: string; at: string; to: AgentRole | null; title: string; text: string }
  | { kind: 'note'; key: string; at: string; tone: NoteTone; title: string; text: string | null; hint?: string }
  | { kind: 'final'; key: string; at: string; report: string };

export type NoteTone = 'info' | 'warn' | 'danger' | 'success' | 'wait';

/** What a rollover is, as a tooltip: "Roll over now" and the rollover items in the timeline (SPEC.md §15). */
export const ROLLOVER_HINT =
  "Starts a fresh session for this agent, carrying a structured summary of the task so far. Separate from Claude Code's own in-session auto-compaction.";

/** SPEC.md §5 net 12, as a tooltip on the retry notes. */
const SERVICE_RETRY_HINT =
  'A service error (no HTTP status, 401, 408 or 5xx, such as a sign-in refresh race) is retried once after a minute. If the retry fails too, the task stops with an error and Resume tries again. Stop and Pause work as usual meanwhile.';

const APPROVAL_LABEL: Record<ApprovalMode, string> = { auto: 'Auto', review: 'Review', plan_first: 'Plan first' };

export interface ApprovalInfo {
  at: string;
  edited: boolean;
  /** The instruction as sent, when the user edited it. */
  text: string | null;
}

const AGENT_LABEL: Record<AgentRole, string> = { planner: 'Planner', executor: 'Executor' };

function baseCard(e: Extract<TaskEvent, { type: 'turn_started' }>): TurnCardBase {
  return {
    turnId: e.turnId,
    startedAt: e.ts,
    state: 'running',
    prompt: e.prompt,
    sessionId: e.sessionId,
    resumed: e.resumed,
    model: e.model,
    effort: e.effort ?? null,
    servedModel: null,
    modelMismatch: false,
    alsoServed: [],
    durationMs: null,
    contextTokens: null,
    outputTokens: null,
    costUsd: null,
    slow: false,
    slowTurnMs: null,
    error: null,
    accountChanged: false,
    rawPath: null,
    answerCheck: null,
  };
}

/** `costUsd`: the turn's own cost (SPEC.md §15), read in order so an older record's running total is turned into it. */
function finishCard(card: TurnCardBase, r: TurnRecord, costUsd: number | null): void {
  card.state = r.ok ? 'ok' : 'failed';
  card.sessionId = r.sessionId;
  card.servedModel = r.model.served;
  card.modelMismatch = r.model.matches === false;
  card.alsoServed = r.model.alsoServed ?? [];
  card.durationMs = r.durationMs;
  card.contextTokens = r.usage?.contextTokens ?? null;
  card.outputTokens = r.usage?.outputTokens ?? null;
  card.costUsd = costUsd;
  card.slow = r.slow;
  card.slowTurnMs = r.slowTurnMs;
  card.error = r.error;
  card.accountChanged = r.accountChanged;
  card.rawPath = r.rawPath;
  card.answerCheck = r.answerCheck ?? null;
}

type CycleItem = Extract<TimelineItem, { kind: 'cycle' }>;
type StartItem = Extract<TimelineItem, { kind: 'start' }>;
type HandoffItem = Extract<TimelineItem, { kind: 'handoff' }>;

const STATUS_NOTES: Partial<Record<string, { tone: NoteTone; title: string }>> = {
  stopped: { tone: 'info', title: 'Stopped' },
  error: { tone: 'danger', title: 'Stopped with an error' },
  failed: { tone: 'danger', title: 'Task failed' },
  rate_limited: { tone: 'warn', title: 'Usage limit reached' },
  account_mismatch: { tone: 'danger', title: 'Claude Code account changed' },
};

/**
 * @param busy whether a turn of this task is running right now; when not, a turn that started but never
 *   reported is shown as interrupted rather than running.
 */
export function buildTimeline(events: readonly TaskEvent[], busy = true): TimelineItem[] {
  const items: TimelineItem[] = [];
  const planners = new Map<string, PlannerCard>();
  const executors = new Map<string, ExecutorCard>();
  const handoffs = new Map<string, HandoffItem>();
  const cycles = new Map<number, CycleItem>();
  let start: StartItem | null = null;
  let pendingPreReview: CommitInfo | null = null;
  let pendingApproval: ApprovalInfo | null = null;
  /** Usage windows already warned about: the warning comes with every turn, the note once. */
  const warnedWindows = new Set<string>();
  /** Each turn's own cost: a resumed session reports running totals (SPEC.md §15). */
  const shares = turnShareReader();

  const note = (e: TaskEvent, tone: NoteTone, title: string, text: string | null = null, hint?: string) =>
    items.push({ kind: 'note', key: `n${e.seq}`, at: e.ts, tone, title, text, ...(hint ? { hint } : {}) });

  for (const e of events) {
    switch (e.type) {
      case 'task_created':
        start = {
          kind: 'start',
          key: `s${e.seq}`,
          at: e.ts,
          description: e.description,
          projectDir: e.projectDir,
          config: e.config,
          pinned: e.pinnedAccount,
          setup: null,
          snapshot: null,
        };
        items.push(start);
        break;

      case 'setup':
        if (start) {
          start.setup = {
            branch: e.git.branch,
            originalBranch: e.git.originalBranch,
            startCommit: e.git.startCommit,
            isRepo: e.git.isRepo,
            hasRemote: e.git.hasRemote,
            inertReason: e.git.inertReason,
            skills: e.skills?.length ?? null,
            skillsError: e.skillsError,
            missingRequiredSkills: e.missingRequiredSkills,
          };
        }
        break;

      case 'commit':
        if (e.purpose === 'snapshot' && start && e.info.state === 'committed') start.snapshot = e.info;
        else if (e.purpose === 'before_review') pendingPreReview = e.info;
        break;

      case 'turn_started': {
        if (e.purpose === 'handoff') {
          const item: HandoffItem = { kind: 'handoff', key: `h${e.seq}`, agent: e.agent, card: baseCard(e), rollover: null };
          handoffs.set(e.turnId, item);
          items.push(item);
          break;
        }
        if (e.agent === 'planner') {
          const card: PlannerCard = { ...baseCard(e), agent: 'planner', purpose: e.purpose, output: null };
          planners.set(e.turnId, card);
          items.push({ kind: 'planner', key: `p${e.seq}`, card });
          break;
        }
        const card: ExecutorCard = {
          ...baseCard(e),
          agent: 'executor',
          purpose: e.purpose,
          output: null,
          killed: [],
          processMethod: null,
          denials: [],
          summary: null,
        };
        executors.set(e.turnId, card);
        const cycle = e.cycle ?? 0;
        const existing = cycles.get(cycle);
        if (existing) {
          // A retry of the same cycle: keep the earlier attempt on record, show the new one.
          existing.attempts.push(existing.executor);
          existing.executor = card;
          const at = items.indexOf(existing);
          if (at >= 0) items.splice(at, 1);
          items.push(existing);
          break;
        }
        // The instruction this turn carries out is the latest Planner "continue" not yet in a cycle.
        let planner: PlannerCard | null = null;
        if (e.purpose === 'instruction') {
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (it?.kind === 'planner' && it.card.output?.status === 'continue') {
              planner = it.card;
              items.splice(i, 1);
              break;
            }
          }
        }
        const item: CycleItem = {
          kind: 'cycle',
          key: `c${cycle}`,
          cycle,
          at: planner?.startedAt ?? e.ts,
          planner,
          executor: card,
          attempts: [],
          preReviewCommit: pendingPreReview,
          approval: e.purpose === 'instruction' ? pendingApproval : null,
        };
        pendingPreReview = null;
        if (e.purpose === 'instruction') pendingApproval = null;
        cycles.set(cycle, item);
        items.push(item);
        break;
      }

      case 'turn': {
        const cost = shares.own(e)?.costUsd ?? null;
        const handoff = handoffs.get(e.turnId);
        if (handoff) {
          finishCard(handoff.card, e, cost);
          break;
        }
        const planner = planners.get(e.turnId);
        if (planner) {
          finishCard(planner, e, cost);
          planner.output = e.ok ? (e.output as PlannerOutput) : null;
          break;
        }
        const executor = executors.get(e.turnId);
        if (executor) {
          finishCard(executor, e, cost);
          executor.output = e.ok ? (e.output as ExecutorOutput) : null;
          executor.killed = e.processes.survivors;
          executor.processMethod = e.processes.method;
          executor.denials = e.permissionDenials;
        }
        break;
      }

      case 'cycle': {
        const executor = executors.get(e.turnId);
        if (executor) {
          const { type: _t, seq: _s, ts: _ts, ...summary } = e;
          executor.summary = summary;
        }
        break;
      }

      case 'rollover': {
        const target = [...handoffs.values()].reverse().find((h) => h.agent === e.agent && h.rollover === null);
        const info = { oldSessionId: e.oldSessionId, newSessionId: e.newSessionId, reason: e.reason, summary: e.summary };
        if (target) target.rollover = info;
        else note(e, 'info', `${AGENT_LABEL[e.agent]} started a new session`, e.reason, ROLLOVER_HINT);
        break;
      }

      case 'intervention':
        switch (e.kind) {
          case 'message':
            items.push({ kind: 'user', key: `u${e.seq}`, at: e.ts, to: e.to ?? null, title: `You → ${AGENT_LABEL[e.to ?? 'planner']}`, text: e.text ?? '' });
            break;
          case 'answer':
            items.push({ kind: 'user', key: `u${e.seq}`, at: e.ts, to: 'planner', title: 'You → Planner · answer', text: e.text ?? '' });
            break;
          case 'approve_instruction':
            // Shown on the cycle card the instruction becomes.
            pendingApproval = { at: e.ts, edited: e.edited === true, text: e.edited ? (e.text ?? null) : null };
            break;
          case 'reject_instruction':
            items.push({ kind: 'user', key: `u${e.seq}`, at: e.ts, to: 'planner', title: 'You rejected the instruction', text: e.text ?? '' });
            break;
          case 'approve_plan':
            items.push({ kind: 'user', key: `u${e.seq}`, at: e.ts, to: 'planner', title: e.edited ? 'You approved an edited plan' : 'You approved the plan', text: e.text ?? '' });
            break;
          case 'reject_plan':
            items.push({ kind: 'user', key: `u${e.seq}`, at: e.ts, to: 'planner', title: 'You rejected the plan', text: e.text ?? '' });
            break;
          case 'pause':
            note(e, 'info', 'You paused the task', 'It holds after the current turn.');
            break;
          case 'stop':
            note(e, 'info', 'You stopped the task');
            break;
          case 'resume':
            note(e, 'info', 'You resumed the task');
            break;
          case 'standing_instructions':
            note(e, 'info', `Standing instructions for the ${e.to ?? 'agent'} changed`, 'They apply to new sessions.');
            break;
          case 'rollover_now':
            note(e, 'info', `You asked for a ${e.to ?? 'session'} rollover`, null, ROLLOVER_HINT);
            break;
          default:
            break;
        }
        break;

      case 'status': {
        if (e.to === 'waiting_user' && e.waiting) {
          const w = e.waiting;
          if (w.kind === 'paused') note(e, 'wait', w.cause === 'daily_cap' ? 'Paused: daily token cap' : 'Paused', w.reason);
          else if (w.kind === 'possible_loop') note(e, 'warn', 'Possible loop — paused for you', w.reason);
          else if (w.kind === 'skill_waiver') note(e, 'wait', 'A required skill cannot run here', e.reason);
          // A question, an instruction or a plan waiting for the user is shown on its Planner card and the
          // approval card; the user's decision appears as its own item (or on the cycle card).
          break;
        }
        const spec = STATUS_NOTES[e.to];
        if (spec) note(e, spec.tone, spec.title, e.reason);
        break;
      }

      case 'refused':
        note(
          e,
          'warn',
          e.reason === 'required_skills'
            ? 'Done refused: required skills have not run'
            : e.reason === 'plan_not_approved'
              ? 'Refused: the plan is not approved yet'
              : "Refused: the Planner's answer was malformed",
          e.detail,
        );
        break;
      case 'loop_detected':
        note(e, 'warn', 'Possible loop detected', e.detail);
        break;
      case 'decision_held':
        note(e, 'info', `Planner's "${e.plannerStatus}" held`, 'You wrote while it was deciding; your message goes first and the Planner decides again.');
        break;
      case 'skill_waived':
        note(e, 'success', `You waived ${e.skill} for this task`, [e.reason, e.note ? `Note: ${e.note}` : null].filter(Boolean).join(' '));
        break;
      case 'skill_waiver_declined':
        items.push({
          kind: 'user',
          key: `u${e.seq}`,
          at: e.ts,
          to: 'planner',
          title: `You kept ${e.skills.map((s) => s.skill).join(', ')} required`,
          text: e.message,
        });
        break;
      case 'rate_limit':
        if (e.status === 'allowed_warning' && !warnedWindows.has(e.rateLimitType ?? '')) {
          warnedWindows.add(e.rateLimitType ?? '');
          note(e, 'warn', 'Approaching the usage limit', `${e.rateLimitType ? `Window: ${e.rateLimitType}. ` : ''}Claude Code reports this with every turn; it is shown once. The side panel has the figures.`);
        }
        break;
      case 'account_mismatch':
        // The status note carries the reason; the pinned-vs-live view is the task's current state.
        break;
      case 'rollover_skipped':
        note(
          e,
          'warn',
          `${AGENT_LABEL[e.agent]} rollover skipped — its session was kept`,
          `${e.reason} The session and its context are intact; Claude Code compacts it itself if it fills up. "Roll over now" tries again.`,
          ROLLOVER_HINT,
        );
        break;
      case 'answer_retry':
        note(
          e,
          'info',
          `Asked again, differently (${e.variation === 'short_answer' ? 'shorter answer' : 'required fields only'})`,
          `The ${AGENT_LABEL[e.agent]}'s last turn ended without an answer the tool would accept${e.refusals > 0 ? ` (refused ${e.refusals}×)` : ''}, so the orchestrator changed the request instead of repeating it. Attempt ${e.attempt} of 2.`,
        );
        break;
      case 'rollover_requested':
        // "Roll over now" already has its own note (the intervention); only other requests need one.
        if (e.reason !== 'requested by the user') note(e, 'info', `${AGENT_LABEL[e.agent]} rollover requested`, e.reason, ROLLOVER_HINT);
        break;
      case 'session_restarted':
        // SPEC.md §5 net 13: never let a restarted session look like one that remembers.
        note(
          e,
          'warn',
          `${AGENT_LABEL[e.agent]} session was lost`,
          `${e.reason}, so it started a new one. The live context is gone: it carries the task description and what the app recorded, not the earlier conversation.`,
        );
        break;
      case 'config_changed': {
        const { title, detail } = describeConfigChange(e.changes);
        note(e, 'info', title, detail);
        break;
      }
      case 'renamed':
        note(
          e,
          'info',
          e.to === null ? 'Name removed' : `Renamed to “${e.to}”`,
          e.to === null
            ? `Was “${e.from ?? ''}”. The task is shown by its description again, which was never changed.`
            : e.from === null
              ? 'Only the name changed: the description the agents work from is untouched.'
              : `Was “${e.from}”. Only the name changed: the description the agents work from is untouched.`,
        );
        break;
      case 'archived':
        note(
          e,
          'info',
          e.archived ? 'Archived' : 'Unarchived',
          e.archived
            ? 'Moved to the Archived section of the task list. Nothing was deleted; Unarchive brings it back.'
            : 'Back in the task list.',
        );
        break;
      case 'approval_mode_changed':
        note(
          e,
          'info',
          `Approval mode: ${APPROVAL_LABEL[e.from]} → ${APPROVAL_LABEL[e.to]}`,
          e.to === 'plan_first'
            ? "Applies from the Planner's next instruction: the Planner is asked for a plan of the remaining work first, and nothing more is sent until you approve it."
            : "Applies from the Planner's next instruction.",
        );
        break;
      case 'auto_resume_scheduled':
        note(e, 'info', 'Auto-resume scheduled', new Date(e.at).toLocaleString());
        break;
      case 'service_retry': {
        const who = `${AGENT_LABEL[e.agent]}${e.purpose === 'handoff' ? ' handoff' : ''}`;
        if (e.outcome === 'retrying') {
          const status = e.apiErrorStatus !== null ? `HTTP ${e.apiErrorStatus}: ` : '';
          const at = e.retryAt ? ` It runs again at ${new Date(e.retryAt).toLocaleTimeString()}.` : '';
          note(e, 'warn', `${who} turn hit a service error — retrying once`, `${status}${e.message ?? ''}${at}`, SERVICE_RETRY_HINT);
        } else if (e.outcome === 'recovered') {
          note(e, 'success', `The ${who} retry after the service error worked`);
        } else {
          note(e, 'danger', `The ${who} retry after the service error failed too`, null, SERVICE_RETRY_HINT);
        }
        break;
      }
      case 'auto_resume_skipped':
        note(e, 'warn', 'Auto-resume skipped', `Task "${e.blockedBy.title}" was running, and tasks run one at a time. Resume this task when you are ready.`);
        break;
      case 'done':
        items.push({ kind: 'final', key: `f${e.seq}`, at: e.ts, report: e.finalReport });
        break;
      case 'recovered':
        note(e, 'warn', 'The app stopped during this task', e.detail);
        break;
      default:
        break;
    }
  }
  if (!busy) {
    const all: TurnCardBase[] = [
      ...planners.values(),
      ...executors.values(),
      ...[...handoffs.values()].map((h) => h.card),
    ];
    for (const card of all) if (card.state === 'running') card.state = 'interrupted';
  }
  return items;
}

/** The turn currently running, if any (its card is still `running`). */
export function runningTurn(items: readonly TimelineItem[]): { turnId: string; agent: AgentRole } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === 'cycle' && it.executor.state === 'running') return { turnId: it.executor.turnId, agent: 'executor' };
    if (it.kind === 'planner' && it.card.state === 'running') return { turnId: it.card.turnId, agent: 'planner' };
    if (it.kind === 'handoff' && it.card.state === 'running') return { turnId: it.card.turnId, agent: it.agent };
  }
  return null;
}

/**
 * A `config_changed` event in words (SPEC.md §6): what changed, from what to what, and for a model change
 * how it was applied — the one thing a later reader cannot reconstruct from the turns alone.
 * Models are named as recorded (`opus`, `claude-opus-5-5`): the cards of the turns that follow show which
 * version actually served them.
 */
export function describeConfigChange(changes: readonly ConfigChangeEntry[]): { title: string; detail: string } {
  const parts: string[] = [];
  const how: string[] = [];
  const agentText = (a: { model: string; effort: string | null }) => (a.effort ? `${a.model} ${a.effort}` : a.model);
  for (const c of changes) {
    switch (c.field) {
      case 'maxCycles':
        parts.push(`max cycles ${c.from} → ${c.to}`);
        break;
      case 'rolloverPercent':
        parts.push(`rollover ${c.from}% → ${c.to}%`);
        break;
      case 'requiredSkills':
        parts.push(`required skills ${c.from.join(', ') || 'none'} → ${c.to.join(', ') || 'none'}`);
        break;
      case 'autoBranchAndCommit':
        parts.push(`auto-commit ${c.to ? 'on' : 'off'}`);
        break;
      case 'turnTimeoutMs':
        parts.push(`turn timeout ${c.from / 60_000} → ${c.to / 60_000} min`);
        break;
      case 'slowTurnMs':
        parts.push(`slow-turn warning ${c.from / 60_000} → ${c.to / 60_000} min`);
        break;
      case 'maxTurnsPerSession':
        parts.push(`max steps per turn ${c.from} → ${c.to}`);
        break;
      case 'freshExecutorAfterRejectedTurns': {
        const text = (n: number | null) => (n === null ? 'off' : `after ${n}`);
        parts.push(`fresh Executor session after rejected answers ${text(c.from)} → ${text(c.to)}`);
        break;
      }
      case 'model': {
        const who = AGENT_LABEL[c.agent];
        parts.push(`${who} ${agentText(c.from)} → ${agentText(c.to)}`);
        how.push(
          c.apply === 'fresh_session'
            ? `${who}: fresh session — its current session writes a handoff on the old model before the ${who}'s next turn, and the new model starts from that summary.`
            : c.apply === 'same_session'
              ? `${who}: same conversation — the ${who}'s next turn resumes its session on the new model; the first turn after a model change reads the conversation without the cache.`
              : `${who}: it had no session yet, so it simply starts on the new model.`,
        );
        break;
      }
    }
  }
  const limits = changes.some((c) => c.field === 'turnTimeoutMs' || c.field === 'slowTurnMs' || c.field === 'maxTurnsPerSession');
  const others = changes.some((c) => c.field !== 'model');
  const when = [
    ...how,
    ...(others ? [how.length === 0 ? 'Applies from the next cycle.' : 'The other changes apply from the next cycle.'] : []),
    ...(limits ? ['A turn already running keeps the limits it started with.'] : []),
  ];
  return { title: `Task settings changed: ${parts.join('; ')}`, detail: when.join(' ') };
}
