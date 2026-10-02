/**
 * "Open file" (SPEC.md §2, §10): run Settings → General → "Open files with" and append the file path.
 *
 * The command is a user-typed command line (`code`, `code -g`, `"C:\Tools\Notepad++\notepad++.exe"`), and
 * `code` is an npm-style `.cmd` shim, which Node only starts through a shell. So the line runs through
 * cmd.exe with the path in double quotes. Paths that cmd.exe would still reinterpret inside quotes (`%`)
 * or that could break the quoting (`"`, line breaks) are refused rather than escaped.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** How long to wait for an early failure ("'x' is not recognized …") before assuming the editor started. */
const EARLY_EXIT_MS = 1500;

export type EditorLaunchResult = { ok: true } | { ok: false; error: string };

/** The command line to run, or the reason it cannot be built. */
export function editorCommandLine(command: string, file: string): { line: string } | { error: string } {
  const cmd = command.trim();
  if (cmd === '') return { error: 'No program is set for opening files. Set one in Settings → General → "Open files with".' };
  if (/["%\r\n]/.test(file)) return { error: `This path cannot be passed to the editor command safely: ${file}` };
  return { line: `${cmd} "${file}"` };
}

export function launchEditor(command: string, file: string, cwd: string): Promise<EditorLaunchResult> {
  const built = editorCommandLine(command, file);
  if ('error' in built) return Promise.resolve({ ok: false, error: built.error });
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (result: EditorLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(built.line, { shell: true, cwd, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      done({ ok: false, error: `Could not run \`${built.line}\`: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => done({ ok: false, error: `Could not run \`${built.line}\`: ${err.message}` }));
    child.on('exit', (code) => {
      if (code === 0) done({ ok: true });
      else done({ ok: false, error: `\`${built.line}\` exited with code ${code ?? 'none'}${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
    });
    // Still running: an editor that stays attached (e.g. notepad). Let it be.
    setTimeout(() => {
      if (settled) return;
      child.stderr?.destroy();
      child.unref();
      done({ ok: true });
    }, EARLY_EXIT_MS);
  });
}

// ---------------------------------------------------------------------------
// Does this command exist? (SPEC.md §11 — the "Detect" button)
// ---------------------------------------------------------------------------

export interface EditorCheck {
  /** The program was found and can be run. */
  ok: boolean;
  /** The first word of the command line, as typed. Null when nothing was typed. */
  program: string | null;
  /** Where it resolved to, when it did. */
  path: string | null;
  /** Why it did not, in words the user can act on. */
  error: string | null;
}

export interface EditorLookup {
  pathVar: string;
  pathExt: string;
  exists: (file: string) => boolean;
  windows: boolean;
}

function defaultLookup(): EditorLookup {
  return {
    pathVar: process.env['PATH'] ?? process.env['Path'] ?? '',
    pathExt: process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
    exists: fileExists,
    windows: process.platform === 'win32',
  };
}

/**
 * The program part of a command line. `code -g` is `code`; a quoted path keeps its spaces.
 * Everything after the first token is the user's own arguments and is not our business.
 */
export function editorProgram(command: string): string | null {
  const cmd = command.trim();
  if (cmd === '') return null;
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    return end > 1 ? cmd.slice(1, end) : cmd.slice(1);
  }
  const space = cmd.search(/\s/);
  return space === -1 ? cmd : cmd.slice(0, space);
}

/**
 * Whether the editor command would actually start something. The default is `code`, which is not on
 * PATH for anyone without VS Code — and until this existed, that failed silently at the moment the
 * user clicked a file, long after they could connect it to a setting (reported 2026-09-20).
 *
 * Nothing is spawned: this only looks for the program on disk.
 */
export function checkEditorCommand(command: string, lookup: EditorLookup = defaultLookup()): EditorCheck {
  const program = editorProgram(command);
  if (program === null) {
    return { ok: false, program: null, path: null, error: 'Nothing is set, so clicking a file will not open anything.' };
  }

  const rules = lookup.windows ? path.win32 : path.posix;
  // PATHEXT arrives upper case (.EXE, .CMD). Windows does not care which case we look for, but this
  // path is shown to the user, so use the conventional lower-case form rather than 'code.CMD'.
  //
  // The extensions come **first** on Windows, and the bare name last. VS Code installs both `code`
  // (a shell script, which cmd.exe cannot run) and `code.cmd` (which it can) in the same folder, so
  // taking the bare name first would report a file that would not actually open anything — and the
  // whole point of this check is to stop exactly that kind of silent failure.
  const extensions = lookup.windows
    ? [...lookup.pathExt.split(';').filter((e) => e.startsWith('.')).map((e) => e.toLowerCase()), '']
    : [''];
  const tryFile = (base: string): string | null => {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (lookup.exists(candidate)) return candidate;
    }
    return null;
  };

  // A path (absolute, or with a separator) is checked where it points; a bare name is looked up on PATH.
  if (rules.isAbsolute(program) || (lookup.windows ? /[\\/]/ : /\//).test(program)) {
    const found = tryFile(program);
    return found
      ? { ok: true, program, path: found, error: null }
      : { ok: false, program, path: null, error: `There is no program at ${program}.` };
  }

  for (const dir of lookup.pathVar.split(rules.delimiter).filter((d) => d.length > 0)) {
    const found = tryFile(rules.join(dir, program));
    if (found) return { ok: true, program, path: found, error: null };
  }
  return {
    ok: false,
    program,
    path: null,
    error: `\`${program}\` was not found on this computer. Type the full path to the program you want to use, or try another name.`,
  };
}
