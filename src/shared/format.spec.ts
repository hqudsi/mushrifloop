import { describe, expect, it } from 'vitest';

import { codeSegments, formatClock, formatDuration, formatElapsed, formatMoment, formatTokens, posixPath, posixPaths } from './format';

describe('posixPath (SPEC.md §4, decided 2026-09-18)', () => {
  it('turns Windows separators into forward slashes and leaves everything else alone', () => {
    expect(posixPath('src\\main\\orchestrator\\prompts.ts')).toBe('src/main/orchestrator/prompts.ts');
    expect(posixPath('C:\\Users\\user\\AppData\\Local\\Temp\\project')).toBe('C:/Users/user/AppData/Local/Temp/project');
    expect(posixPath('.venv\\Scripts\\python')).toBe('.venv/Scripts/python');
    expect(posixPath('already/posix/path.ts')).toBe('already/posix/path.ts');
    expect(posixPath('name with spaces\\file.ts')).toBe('name with spaces/file.ts');
    expect(posixPath('')).toBe('');
    expect(posixPaths(['a\\b.ts', 'c/d.ts'])).toEqual(['a/b.ts', 'c/d.ts']);
  });
});

describe('format', () => {
  it('durations as in the design', () => {
    expect(formatDuration(1800)).toBe('1.8s');
    expect(formatDuration(42_400)).toBe('42s');
    expect(formatDuration(128_000)).toBe('2m 08s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    // From a day on: days and hours (SPEC.md §10), never 131h 40m.
    expect(formatDuration(24 * 3_600_000 - 60_000)).toBe('23h 59m');
    expect(formatDuration(24 * 3_600_000)).toBe('1d 0h');
    expect(formatDuration((131 * 60 + 40) * 60_000)).toBe('5d 11h');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });

  it('elapsed, tokens, clock', () => {
    expect(formatElapsed(59_000)).toBe('<1m');
    expect(formatElapsed(23 * 60_000 + 5_000)).toBe('23m');
    expect(formatElapsed(65 * 60_000)).toBe('1h 05m');
    expect(formatElapsed(27 * 3_600_000)).toBe('1d 3h');
    expect(formatTokens(2130)).toBe('2.1k');
    expect(formatTokens(580_200)).toBe('580k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(12)).toBe('12');
    const d = new Date(2026, 8, 16, 14, 2, 11);
    expect(formatClock(d.toISOString())).toBe('14:02:11');
    expect(formatClock('nope')).toBe('');
  });

  it('a moment: the clock today, with the date on another day (SPEC.md §10)', () => {
    const now = new Date(2026, 8, 26, 9, 0).getTime();
    expect(formatMoment(new Date(2026, 8, 26, 11, 20).getTime(), now)).toBe('11:20');
    expect(formatMoment(new Date(2026, 9, 1, 21, 0).getTime(), now)).toBe('Oct 1, 21:00');
    expect(formatMoment(Number.NaN, now)).toBe('');
  });

  it('code segments', () => {
    expect(codeSegments('Read `src/a.ts` and **b**.')).toEqual([
      { code: false, bold: false, text: 'Read ' },
      { code: true, bold: false, text: 'src/a.ts' },
      { code: false, bold: false, text: ' and ' },
      { code: false, bold: true, text: 'b' },
      { code: false, bold: false, text: '.' },
    ]);
    expect(codeSegments('no code')).toEqual([{ code: false, bold: false, text: 'no code' }]);
    expect(codeSegments('a ``b * c')).toEqual([{ code: false, bold: false, text: 'a ``b * c' }]);
  });

  it('keeps PowerShell backtick escapes inside a code span (real Planner text, Phase 5)', () => {
    const text = 'for example PowerShell `(Get-Content notes.txt -Raw).Split([char[]]" `t`r`n", [x]::None).Count`. Then read it.';
    expect(codeSegments(text)).toEqual([
      { code: false, bold: false, text: 'for example PowerShell ' },
      { code: true, bold: false, text: '(Get-Content notes.txt -Raw).Split([char[]]" `t`r`n", [x]::None).Count' },
      { code: false, bold: false, text: '. Then read it.' },
    ]);
    // Adjacent spans and spans ending a sentence still work; a lone backtick stays text.
    expect(codeSegments('`a`,`b` and `c`')).toEqual([
      { code: true, bold: false, text: 'a' },
      { code: false, bold: false, text: ',' },
      { code: true, bold: false, text: 'b' },
      { code: false, bold: false, text: ' and ' },
      { code: true, bold: false, text: 'c' },
    ]);
    expect(codeSegments("it's `x\nnot code`")).toEqual([{ code: false, bold: false, text: "it's `x\nnot code`" }]);
    expect(codeSegments('**bold `x`** end')).toEqual([
      { code: false, bold: true, text: 'bold `x`' },
      { code: false, bold: false, text: ' end' },
    ]);
  });
});
