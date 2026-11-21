/**
 * The kit on disk (SPEC.md §21.3): what counts as a kit, copying the template without ever overwriting,
 * the fixed command lines, the image-check cache, and the shipped template itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../shared/app-config';
import { compareVersions } from '../../shared/models';
import {
  VIDEO_ATTACH_LIMIT_BYTES,
  VIDEO_EXECUTOR_ROLLOVER_TOKENS,
  VIDEO_KIT_ID,
  VIDEO_KIT_STYLE_SINCE,
  VIDEO_PROGRESS_FILE,
  VIDEO_SMALL_COMMAND,
  VIDEO_THIRD_PARTY,
} from '../../shared/video';
import { ImageCheckCache, inspectKit, installedBrowser, kitCommandLine, kitDir, newImageCode, scaffoldKit } from './kit-ops';

const TEMPLATE = path.resolve(__dirname, '..', '..', '..', 'video', 'kit');
const PROMPTS = path.resolve(__dirname, '..', '..', '..', 'video', 'prompts');

let dir: string;
let project: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_SLUG}-kit-`));
  project = path.join(dir, 'project');
  fs.mkdirSync(project);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('inspectKit', () => {
  it('tells an absent folder, an empty one, a kit and anything else apart', () => {
    expect(inspectKit(project).state).toBe('absent');
    fs.mkdirSync(kitDir(project));
    expect(inspectKit(project).state).toBe('empty');
    write(path.join(kitDir(project), 'notes.txt'), 'mine');
    expect(inspectKit(project).state).toBe('foreign');
    write(path.join(kitDir(project), 'kit.json'), JSON.stringify({ kit: 'something-else', version: '9' }));
    expect(inspectKit(project).state).toBe('foreign');
    write(path.join(kitDir(project), 'kit.json'), JSON.stringify({ kit: VIDEO_KIT_ID, version: '1.2.3' }));
    expect(inspectKit(project)).toMatchObject({ state: 'kit', version: '1.2.3', packagesInstalled: false, ffmpegInstalled: false, chromiumDownloaded: false });
  });

  it('a file named video is not a kit', () => {
    fs.writeFileSync(kitDir(project), 'not a folder');
    expect(inspectKit(project).state).toBe('foreign');
  });

  it('sees installed packages, ffmpeg-static and a downloaded browser', () => {
    const kit = kitDir(project);
    write(path.join(kit, 'kit.json'), JSON.stringify({ kit: VIDEO_KIT_ID, version: '1.0.0' }));
    for (const name of ['three', 'vite', 'playwright-core']) write(path.join(kit, 'node_modules', name, 'package.json'), '{}');
    expect(inspectKit(project)).toMatchObject({ packagesInstalled: true, ffmpegInstalled: false, chromiumDownloaded: false });
    write(path.join(kit, 'node_modules', '.video-tools', 'ffmpeg', 'node_modules', 'ffmpeg-static', 'package.json'), '{}');
    fs.mkdirSync(path.join(kit, 'node_modules', 'playwright-core', '.local-browsers', 'chromium-1254'), { recursive: true });
    expect(inspectKit(project)).toMatchObject({ ffmpegInstalled: true, chromiumDownloaded: true });
  });
});

describe('scaffoldKit', () => {
  it('copies the shipped template, with its dot files under their real names', () => {
    const { kitVersion } = scaffoldKit(TEMPLATE, project);
    const kit = kitDir(project);
    expect(kitVersion).toMatch(/^\d+\.\d+\.\d+$/);
    for (const file of ['package.json', 'package-lock.json', 'kit.json', '.gitignore', '.npmrc', 'storyboard.json', 'storyboard.md', 'README.md', 'src/video.ts', 'scripts/render.mjs', 'scripts/lib/browser.mjs', 'public/fonts/LICENSE-Inter.txt']) {
      expect(fs.existsSync(path.join(kit, file)), file).toBe(true);
    }
    expect(fs.existsSync(path.join(kit, '_gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(kit, '_npmrc'))).toBe(false);
    expect(fs.existsSync(path.join(kit, 'node_modules'))).toBe(false);
    const ignored = fs.readFileSync(path.join(kit, '.gitignore'), 'utf8');
    expect(ignored).toMatch(/^node_modules\/$/m);
    expect(ignored).toMatch(/^out\/$/m);
    expect(inspectKit(project).state).toBe('kit');
  });

  it('copies into an empty video folder too', () => {
    fs.mkdirSync(kitDir(project));
    scaffoldKit(TEMPLATE, project);
    expect(inspectKit(project).state).toBe('kit');
  });

  it('never overwrites a kit that is there: an edited file stays as the user left it', () => {
    scaffoldKit(TEMPLATE, project);
    const scene = path.join(kitDir(project), 'src', 'video.ts');
    fs.writeFileSync(scene, '// my own video\n');
    fs.rmSync(path.join(kitDir(project), 'README.md'));
    expect(() => scaffoldKit(TEMPLATE, project)).toThrow(/already has files/);
    expect(fs.readFileSync(scene, 'utf8')).toBe('// my own video\n');
    // Nothing was "repaired" either.
    expect(fs.existsSync(path.join(kitDir(project), 'README.md'))).toBe(false);
  });

  it('refuses a video folder that is not a kit, and leaves it alone', () => {
    write(path.join(kitDir(project), 'holiday.mp4'), 'x');
    expect(() => scaffoldKit(TEMPLATE, project)).toThrow(/not a video kit/);
    expect(fs.readdirSync(kitDir(project))).toEqual(['holiday.mp4']);
  });
});

describe('command lines', () => {
  it('are fixed text', () => {
    expect(kitCommandLine({ kind: 'install' })).toBe('npm ci --no-audit --no-fund');
    expect(kitCommandLine({ kind: 'tools', downloadBrowser: true, ffmpeg: false })).toBe('npm run setup -- --download-browser');
    expect(kitCommandLine({ kind: 'tools', downloadBrowser: true, ffmpeg: true })).toBe('npm run setup -- --download-browser --ffmpeg');
    expect(kitCommandLine({ kind: 'doctor', code: 'ABCD-2345' })).toBe('npm run doctor -- --code ABCD-2345');
  });

  it('refuse a code that is not a code', () => {
    for (const bad of ['A', 'abcd-2345', 'ABCD 2345', 'ABCD&calc', 'ABCD;rm', '$(x)']) {
      expect(() => kitCommandLine({ kind: 'doctor', code: bad }), bad).toThrow(/Invalid/);
    }
  });

  it('generated codes pass that check and avoid look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = newImageCode();
      expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[2-9]{4}$/);
      expect(() => kitCommandLine({ kind: 'doctor', code })).not.toThrow();
    }
  });
});

describe('the image-check cache', () => {
  it('keeps passes by key, forgets one, and reads an unreadable file as empty', () => {
    const file = path.join(dir, 'cache.json');
    const cache = new ImageCheckCache(file);
    expect(cache.passed('k1')).toBe(false);
    cache.record('k1', '2026-11-10T10:00:00.000Z');
    cache.record('k2', '2026-11-10T11:00:00.000Z');
    expect(new ImageCheckCache(file).passed('k1')).toBe(true);
    cache.forget('k1');
    expect(cache.passed('k1')).toBe(false);
    expect(cache.passed('k2')).toBe(true);
    fs.writeFileSync(file, '{ not json');
    expect(cache.passed('k2')).toBe(false);
    cache.record('k3', 'now');
    expect(cache.passed('k3')).toBe(true);
  });
});

describe('installedBrowser', () => {
  it('prefers Edge, then Chrome, and says null when neither is installed', () => {
    const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Local' };
    const edge = path.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const chrome = path.join('C:\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect(installedBrowser(env, (f) => f === edge || f === chrome)).toBe('Microsoft Edge');
    expect(installedBrowser(env, (f) => f === chrome)).toBe('Google Chrome');
    expect(installedBrowser(env, () => false)).toBeNull();
    expect(installedBrowser({}, () => true)).toBeNull();
  });
});

describe('what ships in video/', () => {
  it('the kit pins its packages exactly and does not list ffmpeg-static', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')) as { devDependencies: Record<string, string>; dependencies?: unknown; optionalDependencies?: unknown };
    expect(pkg.devDependencies['three']).toBe('0.187.0');
    for (const [name, version] of Object.entries(pkg.devDependencies)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(pkg.devDependencies)).not.toContain('ffmpeg-static');
    expect(pkg.optionalDependencies).toBeUndefined();
    const marker = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'kit.json'), 'utf8')) as { kit: string };
    expect(marker.kit).toBe(VIDEO_KIT_ID);
  });

  it('the kit carries the style toolkit, its own test scene and the small-copy command (§21.9)', () => {
    const marker = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'kit.json'), 'utf8')) as { version: string };
    expect(compareVersions(marker.version, VIDEO_KIT_STYLE_SINCE)).toBeGreaterThanOrEqual(0);
    for (const file of ['edges', 'facade', 'glow', 'grain', 'index', 'outline', 'paint', 'post', 'props', 'random', 'reflect', 'selftest', 'toon', 'windows']) {
      expect(fs.existsSync(path.join(TEMPLATE, 'src', 'style', `${file}.ts`)), file).toBe(true);
    }
    expect(fs.existsSync(path.join(TEMPLATE, 'style-test.html'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['small']).toBe('node scripts/small.mjs');
    // The sample is built with the toolkit: agents copy what the kit shows.
    const sample = fs.readFileSync(path.join(TEMPLATE, 'src', 'video.ts'), 'utf8');
    for (const used of ['makeBuilding', 'makePropKit', 'makePost', 'paintedSkyTexture', 'WindowBuilder']) expect(sample, used).toContain(used);
    // The determinism test covers every part of it, by name.
    const test = fs.readFileSync(path.join(TEMPLATE, 'scripts', 'test.mjs'), 'utf8');
    const selftest = fs.readFileSync(path.join(TEMPLATE, 'src', 'style', 'selftest.ts'), 'utf8');
    const parts = /STYLE_PARTS = \[([^\]]+)\]/.exec(test)?.[1]?.match(/'[a-z]+'/g) ?? [];
    expect(parts.length).toBeGreaterThanOrEqual(12);
    for (const part of parts) expect(selftest, part).toContain(`has(${part})`);
    // Nothing in the toolkit reads a clock or the unseeded generator.
    for (const file of fs.readdirSync(path.join(TEMPLATE, 'src', 'style'))) {
      const code = fs.readFileSync(path.join(TEMPLATE, 'src', 'style', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|new Date\(/);
    }
  });

  it('the render reports its size and warns above the attachment limit, with the one command to run', () => {
    const render = fs.readFileSync(path.join(TEMPLATE, 'scripts', 'render.mjs'), 'utf8');
    expect(render).toContain('ATTACH_LIMIT_BYTES = 10 * 1024 * 1024');
    expect(render).toMatch(/WARNING: .*over 10 MB.*run: npm run small/);
    for (const field of ['sizeBytes', 'sizeMB', 'bitrateMbps', 'overAttachLimit']) expect(render, field).toContain(field);
  });

  it('both prompt sections ask for a drawn look from the first pass, name the defects and the style proof', () => {
    const planner = fs.readFileSync(path.join(PROMPTS, 'planner.md'), 'utf8');
    const executor = fs.readFileSync(path.join(PROMPTS, 'executor.md'), 'utf8');
    for (const [agent, text] of [['planner', planner], ['executor', executor]] as const) {
      expect(text.replace(/\*\*/g, ''), agent).toMatch(/read as drawn, not as plain 3D shapes/);
      expect(text, agent).toMatch(/plain box/);
      expect(text, agent).toMatch(/one flat colour/);
      expect(text, agent).toMatch(/src\/style/);
      expect(text, agent).toMatch(/npm run small/);
    }
    expect(planner).toMatch(/as the style proof/);
    expect(planner).toMatch(/These are defects\. Reject them by name/);
    expect(executor).toMatch(/before you write a helper of your own/);
  });

  it('stills write the small sheet only, and a full-size frame only when one is asked for (§21.10)', () => {
    const stills = fs.readFileSync(path.join(TEMPLATE, 'scripts', 'stills.mjs'), 'utf8');
    // Half the pixels of the first kit's sheet (640 and 360 wide cells).
    expect(stills).toContain('SHEET_CELL = { wide: 480, upright: 270 }');
    // The full-size frame of a review frame is written under --full only; --frame alone writes one frame.
    expect(stills).toMatch(/if \(full\) \{\s+const file = path\.join\(REVIEW, `\$\{shot\.id\}-f\$\{pad\(f, 4\)\}\.png`\)/);
    expect(stills).toMatch(/else if \(oneFrame !== null\)/);
    expect(stills).toContain('No frame was written at full size. For one frame: npm run stills -- --frame <n>.');
    const readme = fs.readFileSync(path.join(TEMPLATE, 'README.md'), 'utf8');
    expect(readme).toContain('| `npm run stills -- --frame 45` | One frame at full size');
    expect(readme).toContain('The contact sheet comes first, and it is small on purpose.');
  });

  it('both prompt sections say the sheet comes first, that the Executor’s session is replaced early, and where the state lives (§21.10)', () => {
    const planner = fs.readFileSync(path.join(PROMPTS, 'planner.md'), 'utf8');
    const executor = fs.readFileSync(path.join(PROMPTS, 'executor.md'), 'utf8');
    for (const [agent, text] of [['planner', planner], ['executor', executor]] as const) {
      const plain = text.replace(/\*\*/g, '');
      expect(plain, agent).toContain('The sheet first; a large image only for one detail.');
      expect(plain, agent).toContain('npm run stills -- --frame <n>`: one frame at full size');
      expect(plain, agent).toContain(`about ${VIDEO_EXECUTOR_ROLLOVER_TOKENS.toLocaleString('en-US')} tokens, also in the middle of a shot`);
      expect(plain, agent).toContain(`video/${VIDEO_PROGRESS_FILE}`);
      // The old default is gone from the text: no review frame is promised at full size.
      expect(plain, agent).not.toMatch(/each review frame at full size/);
    }
    expect(executor.replace(/\*\*/g, '')).toContain('change it at the end of every turn, before you report');
    expect(executor).toContain('read `video/storyboard.json`, `video/progress.md` and the file of the shot in hand');
    expect(planner).toContain('write every instruction to stand by itself');
  });

  it('the app and the kit agree on the size limit and on the command for a smaller copy', () => {
    const render = fs.readFileSync(path.join(TEMPLATE, 'scripts', 'render.mjs'), 'utf8');
    expect(VIDEO_ATTACH_LIMIT_BYTES).toBe(10 * 1024 * 1024);
    expect(render).toContain(`run: ${VIDEO_SMALL_COMMAND}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts[VIDEO_SMALL_COMMAND.replace('npm run ', '')]).toBe('node scripts/small.mjs');
    expect(fs.readFileSync(path.join(TEMPLATE, 'scripts', 'small.mjs'), 'utf8')).toContain('video-small.mp4');
  });

  it('the licences page names every package the kit pins, at the pinned version, and the GPL ffmpeg build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    const listed = new Map(VIDEO_THIRD_PARTY.filter((p) => !p.shipped).map((p) => [p.name, p]));
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (name.startsWith('@types/')) continue;
      expect(listed.get(name)?.version, name).toBe(version);
    }
    const ffmpeg = listed.get('ffmpeg-static');
    expect(ffmpeg?.license).toBe('GPL-3.0-or-later');
    expect(fs.readFileSync(path.join(TEMPLATE, 'scripts', 'lib', 'ffmpeg.mjs'), 'utf8')).toContain(`FFMPEG_STATIC_VERSION = '${ffmpeg?.version}'`);
    expect(VIDEO_THIRD_PARTY.filter((p) => p.shipped).map((p) => p.license)).toEqual(['OFL-1.1', 'OFL-1.1']);
  });

  it('the fonts come with their licence texts', () => {
    const fonts = fs.readdirSync(path.join(TEMPLATE, 'public', 'fonts'));
    expect(fonts.filter((f) => f.endsWith('.woff2')).length).toBeGreaterThanOrEqual(4);
    for (const licence of ['LICENSE-Inter.txt', 'LICENSE-NotoSansArabic.txt']) {
      expect(fs.readFileSync(path.join(TEMPLATE, 'public', 'fonts', licence), 'utf8')).toMatch(/SIL Open Font License/);
    }
  });

  it('both prompt sections carry the rules the owner set for Arabic text', () => {
    for (const agent of ['planner', 'executor']) {
      const text = fs.readFileSync(path.join(PROMPTS, `${agent}.md`), 'utf8');
      expect(text.startsWith('## Video task'), agent).toBe(true);
      expect(text, agent).toMatch(/Never transcribe Arabic from an image/);
      expect(text, agent).toMatch(/storyboard\.json/);
      expect(text, agent).toMatch(/not clipped/);
      expect(text, agent).toMatch(/confirmed by the human/);
      expect(text, agent).toMatch(/third-party logos/);
      expect(text, agent).toMatch(/clear open licence/);
    }
  });
});
