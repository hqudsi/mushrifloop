import { describe, expect, it } from 'vitest';

import {
  INSTRUCTION_SIMILARITY,
  instructionSimilarity,
  isRepeatedInstruction,
  localDay,
  normalizeFileSet,
  normalizeInstruction,
  rolloverDue,
  trackTurns,
  type TurnTrace,
} from './safety';
import { environmentalReason } from './skills';
import { availableSkills, missingRequiredSkills, skillMatches, skillOutcomes } from './skills';
import { composeStdin, executorPrompt, formatDuration, shortSummary, skillPrefix } from './prompts';

describe('identical instruction (§5 net 2)', () => {
  it('compares whitespace-insensitively against the previous instruction only', () => {
    expect(isRepeatedInstruction(null, 'x')).toBe(false);
    expect(isRepeatedInstruction(normalizeInstruction('Fix  the\ntest'), ' Fix the test ')).toBe(true);
    expect(isRepeatedInstruction(normalizeInstruction('Fix the test'), 'Fix the tests')).toBe(false);
  });
});

describe('file ping-pong (§5 net 2)', () => {
  it('normalizes paths', () => {
    expect(normalizeFileSet(['./src\\A.ts', 'src/a.ts', 'b/', ' '], true)).toEqual(['b', 'src/a.ts']);
    expect(normalizeFileSet(['src/A.ts', 'src/a.ts'], false)).toEqual(['src/A.ts', 'src/a.ts']);
  });

  const t = (files: string[], instruction: string | null = 'Fix the failing parser test in src/parse.ts'): TurnTrace => ({ files, instruction });

  it('fires on the same set in 3 consecutive turns when the instructions repeat in substance', () => {
    let state = trackTurns([], t(['a']));
    expect(state.pingPong).toBe(false);
    state = trackTurns(state.history, t(['a'], 'Fix the failing parser test in src/parse.ts again'));
    expect(state.pingPong).toBe(false);
    state = trackTurns(state.history, t(['a']));
    expect(state.pingPong).toBe(true);
    expect(state.similarity).toBeGreaterThanOrEqual(INSTRUCTION_SIMILARITY);
    expect(state.history.map((h) => h.files)).toEqual([['a'], ['a'], ['a']]);
  });

  it('does not fire when the instructions differ in substance (normal iterative work on one file)', () => {
    const history = [t(['a'], 'Add a parse() function to src/parse.ts that reads CSV rows'), t(['a'], 'Handle quoted fields and escaped commas inside parse()')];
    const state = trackTurns(history, t(['a'], 'Add JSDoc comments describing the return type of parse()'));
    expect(state.pingPong).toBe(false);
    expect(state.similarity).toBeLessThan(INSTRUCTION_SIMILARITY);
    // A turn that only answered the user has no instruction: never "the same".
    expect(trackTurns([t(['a']), t(['a'])], t(['a'], null)).pingPong).toBe(false);
  });

  it('does not fire on different sets, and an empty turn resets', () => {
    expect(trackTurns([t(['a']), t(['a'])], t(['a', 'b'])).pingPong).toBe(false);
    expect(trackTurns([t(['a']), t(['a'])], t([]))).toEqual({ history: [], pingPong: false, similarity: null });
    expect(trackTurns([t(['b']), t(['a'])], t(['a'])).pingPong).toBe(false);
    expect(trackTurns([t(['x']), t(['a']), t(['a'])], t(['a'])).history.map((h) => h.files)).toEqual([['a'], ['a'], ['a']]);
  });

  it('instruction similarity ignores case, punctuation and filler words', () => {
    expect(instructionSimilarity('Run the tests.', 'run  THE tests')).toBe(1);
    expect(instructionSimilarity('Revert src/a.ts and run npm test', 'Revert src/a.ts, then run npm test')).toBe(1);
    expect(instructionSimilarity('Add README.md', 'Delete hello.py')).toBe(0);
  });
});

describe('rollover threshold (§15)', () => {
  it('is rolloverPercent × the model auto-compact point, strictly exceeded', () => {
    expect(rolloverDue(580_200, 'opus', 60)).toEqual({ due: false, threshold: 580_200 });
    expect(rolloverDue(580_201, 'opus', 60).due).toBe(true);
    expect(rolloverDue(100_201, 'claude-sonnet-4-6', 60)).toEqual({ due: true, threshold: 100_200 });
    expect(rolloverDue(null, 'haiku', 60).due).toBe(false);
    // Unknown model → the 167,000 fallback.
    expect(rolloverDue(100_201, 'mystery-model', 60)).toEqual({ due: true, threshold: 100_200 });
  });
});

describe('localDay', () => {
  it('is the local calendar date', () => {
    const d = new Date(2026, 8, 16, 23, 59);
    expect(localDay(d)).toBe('2026-09-16');
  });
});

describe('skills (§16)', () => {
  it('available = init skills + required skills found among slash commands', () => {
    expect(availableSkills({ skills: ['b', 'a'], slashCommands: ['security-review', 'clear'] }, ['security-review', 'ghost'])).toEqual({
      available: ['a', 'b', 'security-review'],
      missingRequired: ['ghost'],
    });
    // A non-required slash command is not offered as a skill.
    expect(availableSkills({ skills: [], slashCommands: ['clear'] }, []).available).toEqual([]);
  });

  it('matches plugin-namespaced and slash-prefixed names', () => {
    expect(skillMatches('security-review', 'security-review')).toBe(true);
    expect(skillMatches('/security-review', 'security-review')).toBe(true);
    expect(skillMatches('acme:security-review', 'security-review')).toBe(true);
    expect(skillMatches('security-review-2', 'security-review')).toBe(false);
  });

  it('classifies each requested skill from the Skill tool calls', () => {
    const inv = (skill: string, isError: boolean | null) => ({ skill, toolUseId: skill, isError, resultText: null });
    expect(
      skillOutcomes(['ok-skill', 'bad-skill', 'hung-skill', 'unused'], [inv('ok-skill', false), inv('bad-skill', true), inv('hung-skill', null), inv('extra', false)], true),
    ).toEqual([
      { skill: 'ok-skill', requested: true, state: 'ok' },
      { skill: 'bad-skill', requested: true, state: 'failed' },
      { skill: 'hung-skill', requested: true, state: 'no_result' },
      { skill: 'unused', requested: true, state: 'not_invoked' },
      { skill: 'extra', requested: false, state: 'ok' },
    ]);
    // A retry that succeeded counts.
    expect(skillOutcomes(['x'], [inv('x', true), inv('x', false)], true)[0]?.state).toBe('ok');
  });

  it('security-review without a remote is skipped, whatever the tool call said', () => {
    const inv = { skill: 'security-review', toolUseId: 's', isError: false, resultText: '' };
    expect(skillOutcomes(['security-review'], [inv], false)).toEqual([{ skill: 'security-review', requested: true, state: 'skipped_no_remote' }]);
    expect(skillOutcomes(['security-review'], [], false)[0]?.state).toBe('skipped_no_remote');
    expect(skillOutcomes(['security-review'], [inv], true)[0]?.state).toBe('ok');
  });

  it('environmental reasons: not offered here, or a remote-diffing skill without a remote', () => {
    const ctx = { available: ['security-review', 'lint'], isRepo: true, hasRemote: true };
    expect(environmentalReason('security-review', ctx)).toBeNull();
    expect(environmentalReason('lint', { ...ctx, hasRemote: false })).toBeNull();
    expect(environmentalReason('security-review', { ...ctx, hasRemote: false })).toMatch(/no git remote/);
    expect(environmentalReason('security-review', { ...ctx, isRepo: false, hasRemote: false })).toMatch(/not a git repository/);
    expect(environmentalReason('ghost', ctx)).toMatch(/does not offer this skill/);
    // Unknown availability is not evidence.
    expect(environmentalReason('ghost', { ...ctx, available: null })).toBeNull();
  });

  it('missing required skills', () => {
    expect(missingRequiredSkills(['a', 'b'], ['b'])).toEqual(['a']);
  });
});

describe('prompt pieces', () => {
  it('skill prefix is the exact SPEC §16 text', () => {
    expect(skillPrefix(['security-review', 'lint'])).toBe('Before doing anything else, invoke skill(s): security-review, lint.\n\n');
    expect(skillPrefix([])).toBe('');
  });

  it('executor prompt: skills, then the user message, then the instruction', () => {
    expect(executorPrompt({ instruction: 'Do X', useSkills: ['s'], userMessage: 'Careful' })).toBe(
      'Before doing anything else, invoke skill(s): s.\n\n[FROM USER]\nCareful\n\n[INSTRUCTION]\nDo X',
    );
  });

  it('stdin = seed, retry note, prompt', () => {
    expect(composeStdin({ prompt: 'P', retryNote: 'R' }, 'S')).toBe('S\n\nR\n\nP');
    expect(composeStdin({ prompt: 'P', retryNote: null }, null)).toBe('P');
  });

  it('durations and summaries', () => {
    expect(formatDuration(1_500)).toBe('2 s');
    expect(formatDuration(151_000)).toBe('2 min 31 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
    expect(shortSummary('First line that is quite long indeed, longer than sixty characters total\nsecond')).toBe(
      'First line that is quite long indeed, longer than sixty cha…',
    );
    expect(shortSummary('In the root:\n1. Add  README.md')).toBe('In the root: 1. Add README.md');
  });
});
