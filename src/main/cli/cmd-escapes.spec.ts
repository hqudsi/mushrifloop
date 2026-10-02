import { describe, expect, it } from 'vitest';

import { undoCmdEscapes } from './cmd-escapes';

describe('undoCmdEscapes', () => {
  it('removes cmd.exe caret escapes when every space carries one (as npm delivered it)', () => {
    expect(undoCmdEscapes('^Add^ a^ README^ with^ the^ project^ name;^ verify^ it^ runs.^')).toEqual({
      text: 'Add a README with the project name; verify it runs.',
      changed: true,
    });
    expect(undoCmdEscapes('^x^^2^ is^ ^"big^"')).toEqual({ text: 'x^2 is "big"', changed: true });
  });

  it('leaves ordinary text alone, including real carets', () => {
    expect(undoCmdEscapes('Add a README')).toEqual({ text: 'Add a README', changed: false });
    expect(undoCmdEscapes('compute x^2 + y^ 2')).toEqual({ text: 'compute x^2 + y^ 2', changed: false });
    expect(undoCmdEscapes('single^word')).toEqual({ text: 'single^word', changed: false });
  });
});
