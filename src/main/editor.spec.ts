/**
 * "Open file" builds a cmd.exe line from Settings → Editor command with the path appended (SPEC.md §2).
 */
import { describe, expect, it } from 'vitest';

import { checkEditorCommand, editorCommandLine, editorProgram, launchEditor, type EditorLookup } from './editor';

describe('editorCommandLine', () => {
  it('appends the quoted path to the command', () => {
    expect(editorCommandLine('code', 'C:\\src\\my app\\a.ts')).toEqual({ line: 'code "C:\\src\\my app\\a.ts"' });
    expect(editorCommandLine('  code -g ', 'C:\\x & y\\b.ts')).toEqual({ line: 'code -g "C:\\x & y\\b.ts"' });
  });

  it('refuses what cmd.exe would reinterpret inside quotes, and an empty command', () => {
    expect(editorCommandLine('code', 'C:\\100%\\a.ts')).toHaveProperty('error');
    expect(editorCommandLine('code', 'C:\\a"b.ts')).toHaveProperty('error');
    expect(editorCommandLine('   ', 'C:\\a.ts')).toEqual({ error: expect.stringContaining('Settings → General → "Open files with"') });
  });
});

describe.runIf(process.platform === 'win32')('launchEditor (Windows)', () => {
  it('reports a command that does not exist, with its message', async () => {
    const result = await launchEditor('no-such-editor-4711-xyz', 'C:\\Windows\\win.ini', process.cwd());
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('no-such-editor-4711-xyz');
  });

  it('treats a command that exits 0 as opened', async () => {
    // `rem` is a cmd.exe no-op that accepts any arguments.
    expect(await launchEditor('rem', 'C:\\Windows\\win.ini', process.cwd())).toEqual({ ok: true });
  });
});

/**
 * "Detect" (SPEC.md §11). The default is `code`, which is not on PATH for anyone without VS Code, and
 * until this existed that failed silently at the moment a file was clicked (reported 2026-09-20).
 */
describe('editorProgram', () => {
  it('takes the program and leaves the user their arguments', () => {
    expect(editorProgram('code')).toBe('code');
    expect(editorProgram('  code -g -r ')).toBe('code');
    expect(editorProgram('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst')).toBe('C:\\Program Files\\Notepad++\\notepad++.exe');
    expect(editorProgram('"C:\\unclosed\\np.exe')).toBe('C:\\unclosed\\np.exe');
  });

  it('is null when nothing was typed', () => {
    expect(editorProgram('')).toBeNull();
    expect(editorProgram('   ')).toBeNull();
  });
});

describe('checkEditorCommand', () => {
  const lookup = (files: string[], pathVar = 'C:\\bin;C:\\tools'): EditorLookup => ({
    pathVar,
    pathExt: '.COM;.EXE;.BAT;.CMD',
    // Windows file names are case-insensitive, and PATHEXT arrives upper case.
    exists: (f) => files.some((known) => known.toLowerCase() === f.toLowerCase()),
    windows: true,
  });

  it('finds a bare name on PATH, trying the PATHEXT extensions', () => {
    expect(checkEditorCommand('code', lookup(['C:\\tools\\code.cmd']))).toEqual({
      ok: true,
      program: 'code',
      path: 'C:\\tools\\code.cmd',
      error: null,
    });
    expect(checkEditorCommand('notepad -x', lookup(['C:\\bin\\notepad.exe']))).toMatchObject({ ok: true, path: 'C:\\bin\\notepad.exe' });
  });

  it('prefers the runnable file over an extensionless sibling (VS Code ships both)', () => {
    // `code` is a shell script cmd.exe cannot run; `code.cmd` is the one that opens the editor.
    const both = lookup(['C:\\tools\\code', 'C:\\tools\\code.cmd']);
    expect(checkEditorCommand('code', both)).toMatchObject({ ok: true, path: 'C:\\tools\\code.cmd' });
  });

  it('still accepts a name that already carries its extension', () => {
    expect(checkEditorCommand('C:\\Windows\\System32\\notepad.exe', lookup(['C:\\Windows\\System32\\notepad.exe']))).toMatchObject({
      ok: true,
      path: 'C:\\Windows\\System32\\notepad.exe',
    });
  });

  it('says so, actionably, when the command is not on this computer', () => {
    const check = checkEditorCommand('code', lookup([]));
    expect(check).toMatchObject({ ok: false, program: 'code', path: null });
    expect(check.error).toContain('was not found on this computer');
    expect(check.error).toContain('full path');
  });

  it('checks a full path where it points, not on PATH', () => {
    const files = ['C:\\Program Files\\Notepad++\\notepad++.exe'];
    expect(checkEditorCommand('"C:\\Program Files\\Notepad++\\notepad++.exe"', lookup(files))).toMatchObject({ ok: true });
    const missing = checkEditorCommand('C:\\nope\\editor.exe', lookup(files));
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toBe('There is no program at C:\\nope\\editor.exe.');
  });

  it('does not fall back to PATH for something that looks like a path', () => {
    expect(checkEditorCommand('tools/code', lookup(['C:\\tools\\code.cmd']))).toMatchObject({ ok: false });
  });

  it('explains an empty setting rather than calling it missing', () => {
    expect(checkEditorCommand('   ', lookup([]))).toEqual({
      ok: false,
      program: null,
      path: null,
      error: 'Nothing is set, so clicking a file will not open anything.',
    });
  });

  it('needs no extension guessing off Windows', () => {
    const unix: EditorLookup = { pathVar: '/usr/bin:/usr/local/bin', pathExt: '', exists: (f) => f === '/usr/bin/vim', windows: false };
    expect(checkEditorCommand('vim', unix)).toMatchObject({ ok: true, path: '/usr/bin/vim' });
  });
});
