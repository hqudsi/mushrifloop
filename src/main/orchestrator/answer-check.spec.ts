/**
 * The "possibly truncated" rule (SPEC.md §4), checked against the answers of the real task that
 * prompted it (NOTES.md §20.2).
 */
import { describe, expect, it } from 'vitest';

import { TRUNCATED_BELOW_CHARS, TRUNCATED_BELOW_SHARE, checkAnswer, describeToolUses, hasLeakedMarkup, mainText, sentenceCount } from './answer-check';

const report = (summary: string, extra: Record<string, unknown> = {}) => ({ status: 'ok', summary, changed_files: [], tests: { ran: false }, problems: [], ...extra });
const refused = (count: number, largestAttemptChars: number) => ({ count, reasons: ["root: must have required property 'changed_files'"], largestAttemptChars });

describe('sentenceCount', () => {
  it.each([
    ['Test minimal call.', 1],
    ['Read-only search step completed. No files changed.', 2],
    ['Created notes.txt and README.md', 1],
    ['Done! Checked it? Yes.', 3],
    ['وجدت الملف. لا توجد تغييرات؟', 2],
    ['', 0],
    ['...', 0],
  ])('%j → %i', (text, count) => {
    expect(sentenceCount(text)).toBe(count);
  });
});

describe('checkAnswer', () => {
  it('is null when nothing was refused, however short the answer', () => {
    expect(checkAnswer(refused(0, 0), 'executor', 'instruction', report('Done.'))).toBeNull();
  });

  it.each([
    ['a placeholder', report('Test minimal call.'), 2401],
    ['two short sentences', report('No Bootstrap found in the project. Need direction before implementing the grid change.'), 2820],
    ['a probe', report(`TEST-LENGTH-PROBE-SHORT: ${'filler '.repeat(30)}end of probe.`), 4920],
    ['a cut-down report that still looks fine', report('Read-only verification completed; no build attempted. Prior changes confirmed correct via git diff and manual inspection; no fix needed.'), 2018],
  ])('flags the answers a real project got: %s', (_label, output, largest) => {
    const check = checkAnswer(refused(2, largest), 'executor', 'instruction', output);
    expect(check).toMatchObject({ count: 2, possiblyTruncated: true, acceptedChars: JSON.stringify(output).length, largestAttemptChars: largest });
  });

  it('does not flag a full answer resent after a refusal', () => {
    const summary = 'GRID: .fields is a 12-column grid (dashboard.css:359). f--3 spans 3 columns, so four fit per row. Below 900px every span is full width. No changes were needed.';
    const output = report(summary, { changed_files: [{ path: 'a.css', change: 'modified' }] });
    const check = checkAnswer(refused(1, JSON.stringify(output).length + 40), 'executor', 'instruction', output);
    expect(check).toMatchObject({ count: 1, possiblyTruncated: false });
  });

  it('flags an answer below three quarters of the largest refused attempt (the 2026-09-17 experiment)', () => {
    const summary = 'x '.repeat(200) + 'First sentence. Second sentence.';
    const output = report(summary);
    const size = JSON.stringify(output).length;
    // Experiment arm A, turn 3 kept 70% and was not flagged at ½; turn 4 kept 83%.
    expect(checkAnswer(refused(2, Math.round(size / 0.7)), 'executor', 'instruction', output)?.possiblyTruncated).toBe(true);
    expect(checkAnswer(refused(3, Math.round(size / 0.83)), 'executor', 'instruction', output)?.possiblyTruncated).toBe(false);
    expect(TRUNCATED_BELOW_SHARE).toBe(0.75);
  });

  it('judges a short main text as suspicious even when the refused attempt was small too', () => {
    const output = report('x'.repeat(TRUNCATED_BELOW_CHARS - 1) + '. More.');
    expect(checkAnswer(refused(1, 10), 'executor', 'instruction', output)?.possiblyTruncated).toBe(false);
    const short = report('Short one. Two.');
    expect(checkAnswer(refused(1, 10), 'executor', 'instruction', short)?.possiblyTruncated).toBe(true);
  });

  it('judges handoffs by their restatement, never Planner answers, and a failed turn has no accepted answer', () => {
    const handoff = { task_restatement: 'Handoff test - short version.', done_so_far: [], remaining: [], decisions: [], constraints: [], open_problems: [], key_files: [] };
    expect(checkAnswer(refused(2, 9524), 'executor', 'handoff', handoff)?.possiblyTruncated).toBe(true);
    expect(mainText('planner', 'handoff', handoff)).toBe('Handoff test - short version.');

    const planner = { status: 'continue', reasoning_summary: 'ok', next_instruction: 'x' };
    expect(checkAnswer(refused(3, 5000), 'planner', 'executor_report', planner)).toMatchObject({ count: 3, possiblyTruncated: false });

    expect(checkAnswer(refused(5, 3483), 'executor', 'instruction', null)).toMatchObject({ count: 5, acceptedChars: null, possiblyTruncated: false });
  });
});

describe('leaked tool-call markup (§3.5, decided 2026-09-17)', () => {
  // The Step B schema experiment's accepted answer (NOTES.md §23.4): the evidence typed into summary.
  const LEAKED = 'Two attributes gate the action.</summary>\n<parameter name="evidence">1\tusing System.Web;\n13\t[AdminOnly]';

  it('spots a <parameter> or </parameter> tag at any depth, not field names or other markup', () => {
    expect(hasLeakedMarkup({ summary: 'ok</summary>\n<parameter name="changed_files">[]' })).toBe(true);
    expect(hasLeakedMarkup({ summary: LEAKED })).toBe(true);
    expect(hasLeakedMarkup({ problems: ['x', 'y</parameter>'] })).toBe(true);
    expect(hasLeakedMarkup({ tests: { ran: true, notes: '<parameter name="question">' } })).toBe(true);
    expect(hasLeakedMarkup({ summary: 'The <div class="card"> wraps it.' })).toBe(false);
    expect(hasLeakedMarkup({ summary: 'A <parameters> element and <parameterList/>.' })).toBe(false);
    // Seen in the Step B schema run: C# XML doc comments pasted into the evidence field.
    expect(hasLeakedMarkup({ evidence: 'AdminController.cs lines 10-14:\n10\t    /// <summary>\n11\t    /// Users\n12\t    /// </summary>\n13\t    [AdminOnly]' })).toBe(false);
    expect(hasLeakedMarkup(null)).toBe(false);
    expect(hasLeakedMarkup(42)).toBe(false);
  });

  it('makes an Executor answer possibly truncated even when nothing was refused', () => {
    const output = report(LEAKED);
    const none = { count: 0, reasons: [], largestAttemptChars: 0 };
    expect(checkAnswer(none, 'executor', 'instruction', output)).toEqual({
      count: 0,
      reasons: [],
      largestAttemptChars: 0,
      acceptedChars: JSON.stringify(output).length,
      possiblyTruncated: true,
      leakedMarkup: true,
    });
    expect(checkAnswer(refused(2, 100), 'executor', 'instruction', output)).toMatchObject({ count: 2, possiblyTruncated: true, leakedMarkup: true });
  });

  it('flags a handoff the same way, and a Planner answer without judging it truncated', () => {
    const handoff = { task_restatement: 'Write the README.</task_restatement>\n<parameter name="done_so_far">["a"]', done_so_far: [], remaining: [], decisions: [], constraints: [], open_problems: [], key_files: [] };
    expect(checkAnswer(refused(0, 0), 'planner', 'handoff', handoff)).toMatchObject({ possiblyTruncated: true, leakedMarkup: true });
    const planner = { status: 'continue', reasoning_summary: 'ok', next_instruction: 'Read a.ts</next_instruction>\n<parameter name="use_skills">[]' };
    expect(checkAnswer(refused(0, 0), 'planner', 'executor_report', planner)).toMatchObject({ count: 0, possiblyTruncated: false, leakedMarkup: true });
  });

  it('records no markup on a clean answer that had refusals', () => {
    expect(checkAnswer(refused(1, 10), 'executor', 'instruction', report('Short one. Two.'))?.leakedMarkup).toBe(false);
  });
});

describe('the evidence field (§4, decided 2026-09-17)', () => {
  it('counts toward the main text with the summary', () => {
    const evidence = 'Views/Incidents/Details.cshtml:134  <a class="btn" href="/Incidents/Update">Update</a>\nViews/Incidents/Details.cshtml:372  <div class="card overview">';
    const output = report('I read the view. The lines follow in evidence.', { evidence });
    expect(mainText('executor', 'instruction', output)).toBe(`I read the view. The lines follow in evidence.\n${evidence}`);
    // The summary alone is under 120 characters; with its evidence the answer is not short.
    expect(checkAnswer(refused(1, 10), 'executor', 'instruction', output)?.possiblyTruncated).toBe(false);
    expect(checkAnswer(refused(1, 10), 'executor', 'instruction', report('I read the view. The lines follow in evidence.'))?.possiblyTruncated).toBe(true);
    // An empty evidence field adds nothing.
    expect(mainText('executor', 'instruction', report('Done. Checked.', { evidence: '  ' }))).toBe('Done. Checked.');
  });
});

describe('describeToolUses', () => {
  it('lists the calls, most used first', () => {
    expect(describeToolUses({ Read: 3, Grep: 2, Glob: 1, Bash: 1 })).toBe('7 tool calls: Read ×3, Grep ×2, Bash ×1, Glob ×1');
    expect(describeToolUses({ Read: 1 })).toBe('1 tool call: Read ×1');
    expect(describeToolUses({})).toBe('no tool calls');
    expect(describeToolUses(undefined)).toBe('no tool calls');
  });
});
