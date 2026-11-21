/**
 * The real side of a Video task's setup (SPEC.md §21.3): looking at `<project>/video/`, copying the kit
 * template, and running the kit's own commands with their output captured.
 *
 * These are the only processes the app starts besides `claude`, `git` and its own helpers, and only after
 * the human agreed to the downloads. Every command line here is a fixed string: nothing a user or an agent
 * wrote is ever part of one.
 */

import { exec, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VIDEO_KIT_DIR, VIDEO_KIT_ID, VIDEO_KIT_MARKER } from '../../shared/video';
import { writeJsonAtomic } from '../atomic-write';
import { killTree } from '../claude-cli';
import type { AgentRole, KitCommand, KitInspection, KitRunResult, VideoPort } from '../orchestrator/types';
import { StoryboardValidator, videoOutputs } from './review';

/** Files the template stores under another name, because a dot file inside a shipped resource folder is easy to lose. */
const RENAMED_ON_COPY: ReadonlyArray<[string, string]> = [
  ['_gitignore', '.gitignore'],
  ['_npmrc', '.npmrc'],
];
/** Never part of the template, even if someone ran the kit inside the repository. */
const NOT_TEMPLATE = new Set(['node_modules', 'out', 'dist']);

/** How long each command may take before it is stopped (SPEC.md §21.3: a visible log, Cancel and a timeout). */
export const KIT_TIMEOUTS_MS: Record<KitCommand['kind'], number> = {
  install: 20 * 60_000,
  tools: 30 * 60_000,
  doctor: 5 * 60_000,
};

const TAIL_CHARS = 3000;
/** Letters and digits that are not mistaken for each other when read from an image. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_DIGITS = '23456789';

export function kitDir(projectDir: string): string {
  return path.join(projectDir, VIDEO_KIT_DIR);
}

export function inspectKit(projectDir: string): KitInspection {
  const dir = kitDir(projectDir);
  const none: KitInspection = { state: 'absent', version: null, packagesInstalled: false, ffmpegInstalled: false, chromiumDownloaded: false };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return none;
    // Not a folder, or not readable: not ours to use.
    return { ...none, state: 'foreign' };
  }
  if (entries.length === 0) return { ...none, state: 'empty' };

  let version: string | null = null;
  let isKit = false;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, VIDEO_KIT_MARKER), 'utf8')) as { kit?: unknown; version?: unknown };
    isKit = marker.kit === VIDEO_KIT_ID;
    version = typeof marker.version === 'string' ? marker.version : null;
  } catch {
    /* no marker, or not JSON */
  }
  if (!isKit) return { ...none, state: 'foreign' };

  const modules = path.join(dir, 'node_modules');
  const has = (...parts: string[]) => fs.existsSync(path.join(modules, ...parts));
  let chromiumDownloaded = false;
  try {
    chromiumDownloaded = fs.readdirSync(path.join(modules, 'playwright-core', '.local-browsers')).some((n) => n.startsWith('chromium-'));
  } catch {
    /* not downloaded */
  }
  return {
    state: 'kit',
    version,
    packagesInstalled: has('three', 'package.json') && has('vite', 'package.json') && has('playwright-core', 'package.json'),
    ffmpegInstalled: has('.video-tools', 'ffmpeg', 'node_modules', 'ffmpeg-static', 'package.json'),
    chromiumDownloaded,
  };
}

/**
 * Copy the template into `<project>/video/`. Refuses unless the folder is absent or empty: a kit that is
 * already there is used as it is, and anything else is not the app's to touch (SPEC.md §21.3).
 */
export function scaffoldKit(templateDir: string, projectDir: string): { kitVersion: string } {
  const state = inspectKit(projectDir).state;
  if (state !== 'absent' && state !== 'empty') {
    throw new Error(`The ${VIDEO_KIT_DIR} folder already has files in it (${state === 'kit' ? 'a video kit' : 'not a video kit'}); nothing was copied.`);
  }
  const dest = kitDir(projectDir);
  fs.mkdirSync(dest, { recursive: true });
  const copy = (from: string, to: string) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (from === templateDir && NOT_TEMPLATE.has(entry.name)) continue;
      const source = path.join(from, entry.name);
      const renamed = from === templateDir ? RENAMED_ON_COPY.find(([name]) => name === entry.name)?.[1] : undefined;
      const target = path.join(to, renamed ?? entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        copy(source, target);
      } else if (entry.isFile()) {
        // Never over an existing file, whatever led here.
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
    }
  };
  copy(templateDir, dest);
  const marker = JSON.parse(fs.readFileSync(path.join(dest, VIDEO_KIT_MARKER), 'utf8')) as { version?: unknown };
  return { kitVersion: typeof marker.version === 'string' ? marker.version : 'unknown' };
}

/** The exact command line for a kit command. Fixed text; the doctor code is checked before it is used. */
export function kitCommandLine(command: KitCommand): string {
  switch (command.kind) {
    case 'install':
      return 'npm ci --no-audit --no-fund';
    case 'tools':
      return `npm run setup --${command.downloadBrowser ? ' --download-browser' : ''}${command.ffmpeg ? ' --ffmpeg' : ''}`;
    case 'doctor':
      if (!/^[A-Z0-9-]{4,24}$/.test(command.code)) throw new Error('Invalid image-check code.');
      return `npm run doctor -- --code ${command.code}`;
  }
}

function runKitCommand(
  command: KitCommand,
  options: { projectDir: string; logDir: string; signal: AbortSignal; onOutput: (text: string) => void },
  timeoutMs = KIT_TIMEOUTS_MS[command.kind],
): Promise<KitRunResult> {
  const started = Date.now();
  const line = kitCommandLine(command);
  fs.mkdirSync(options.logDir, { recursive: true });
  const logPath = path.join(options.logDir, `video-${command.kind}-${new Date(started).toISOString().replace(/[:.]/g, '-')}.log`);
  const log = fs.createWriteStream(logPath);
  log.write(`> ${line}\n> in ${kitDir(options.projectDir)}\n\n`);

  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      log.end(() => resolve({ exitCode, timedOut, aborted, durationMs: Date.now() - started, tail: tail.trim(), logPath }));
    };
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-TAIL_CHARS);
      log.write(text);
      options.onOutput(text);
    };

    let child;
    try {
      // npm is a .cmd file on Windows, which needs the shell. The line is fixed text (see kitCommandLine).
      child = spawn(line, { cwd: kitDir(options.projectDir), shell: true, windowsHide: true, env: process.env });
    } catch (err) {
      tail = err instanceof Error ? err.message : String(err);
      finish(null);
      return;
    }
    const pid = child.pid;
    const onAbort = () => {
      aborted = true;
      killTree(pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(pid);
    }, timeoutMs);
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => {
      tail = `${tail}\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(timedOut || aborted ? null : code));
  });
}

function versionOf(commandLine: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(commandLine, { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      const text = String(stdout).trim().split(/\r?\n/)[0] ?? '';
      resolve(!err && /\d+\.\d+/.test(text) ? text.replace(/^v/, '') : null);
    });
  });
}

function ffmpegOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('ffmpeg -hide_banner -encoders', { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && /\blibx264\b/.test(String(stdout)));
    });
  });
}

/** Where Edge and Chrome install themselves on Windows. Only looked for; nothing is run. */
export function installedBrowser(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string | null {
  const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].filter((r): r is string => typeof r === 'string' && r.length > 0);
  const candidates: Array<[string, string[]]> = [
    ['Microsoft Edge', ['Microsoft', 'Edge', 'Application', 'msedge.exe']],
    ['Google Chrome', ['Google', 'Chrome', 'Application', 'chrome.exe']],
  ];
  for (const [name, parts] of candidates) {
    if (roots.some((root) => exists(path.join(root, ...parts)))) return name;
  }
  return null;
}

export function newImageCode(): string {
  const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${pick(CODE_LETTERS, 4)}-${pick(CODE_DIGITS, 4)}`;
}

/** Passes of the image check, by cache key (SPEC.md §21.3 step 5). App state: unreadable means empty. */
export class ImageCheckCache {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { passes?: unknown };
      if (typeof raw.passes !== 'object' || raw.passes === null) return {};
      return Object.fromEntries(Object.entries(raw.passes).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  passed(key: string): boolean {
    return key in this.read();
  }

  record(key: string, at: string): void {
    writeJsonAtomic(this.file, { passes: { ...this.read(), [key]: at } });
  }

  forget(key: string): void {
    const passes = this.read();
    if (!(key in passes)) return;
    delete passes[key];
    writeJsonAtomic(this.file, { passes });
  }
}

export interface VideoPortOptions {
  /** The shipped `video/` folder: `kit/` and `prompts/`. */
  videoFolder: string;
  /** Where the image-check cache is kept. */
  cacheFile: string;
  cliVersion(): Promise<string | null>;
}

export function createVideoPort(options: VideoPortOptions): VideoPort {
  const cache = new ImageCheckCache(options.cacheFile);
  const prompts: Partial<Record<AgentRole, string>> = {};
  // Compiled at start-up: a storyboard schema that does not compile must stop the app, not a task later.
  const validator = new StoryboardValidator(path.join(options.videoFolder, 'schemas', 'storyboard.schema.json'));
  return {
    prerequisites: async () => ({ node: await versionOf('node --version'), npm: await versionOf('npm --version') }),
    installedBrowser: () => installedBrowser(),
    ffmpegOnPath,
    inspectKit,
    scaffold: (projectDir) => scaffoldKit(path.join(options.videoFolder, 'kit'), projectDir),
    run: (command, runOptions) => runKitCommand(command, runOptions),
    readDoctor: (projectDir) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(kitDir(projectDir), 'out', 'doctor.json'), 'utf8')) as unknown;
      } catch {
        return null;
      }
    },
    cliVersion: options.cliVersion,
    imageCheckPassed: (key) => cache.passed(key),
    recordImageCheck: (key, at) => cache.record(key, at),
    forgetImageCheck: (key) => cache.forget(key),
    newCode: newImageCode,
    storyboard: (projectDir, settings) => {
      const { state, problems, hash } = validator.read(projectDir, settings);
      return { state, problems, hash };
    },
    outputs: videoOutputs,
    prompt: (agent) => (prompts[agent] ??= fs.readFileSync(path.join(options.videoFolder, 'prompts', `${agent}.md`), 'utf8')),
  };
}
