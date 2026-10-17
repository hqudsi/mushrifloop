import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ATTACHMENT_LIMITS } from '../shared/attachments';
import { checkAttachments, parseAttachmentInputs, saveAttachments } from './attachments';
import { parseAction } from './task-service';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('copying attached files (SPEC.md §10)', () => {
  it('accepts paths and pasted bytes, and refuses anything else', () => {
    expect(parseAttachmentInputs(undefined)).toEqual([]);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(parseAttachmentInputs([{ path: 'C:\\a.png' }, { name: 'p.png', data: bytes }])).toEqual([{ path: 'C:\\a.png' }, { name: 'p.png', data: bytes }]);
    expect(() => parseAttachmentInputs('x')).toThrow();
    expect(() => parseAttachmentInputs([{ path: '' }])).toThrow();
    expect(() => parseAttachmentInputs([{ name: 'p.png', data: [1, 2] }])).toThrow();
  });

  it('checks every file before anything is copied', () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    expect(checkAttachments([{ path: file }]).map((c) => [c.name, c.size])).toEqual([['notes.txt', 5]]);
    expect(() => checkAttachments([{ path: path.join(dir, 'gone.txt') }])).toThrow(/not there any more/);
    expect(() => checkAttachments([{ path: dir }])).toThrow(/not folders/);
    expect(() => checkAttachments([{ name: 'big.png', data: new Uint8Array(ATTACHMENT_LIMITS.maxBytes + 1) }])).toThrow(/larger than/);
    expect(() => checkAttachments(new Array(ATTACHMENT_LIMITS.maxFiles + 1).fill({ path: file }))).toThrow(/At most/);
  });

  it('copies files and writes pasted bytes, numbered after what the task already has', () => {
    const src = path.join(dir, 'spec.pdf');
    fs.writeFileSync(src, 'PDF');
    const to = path.join(dir, 'task', 'attachments');
    const now = new Date('2026-10-17T10:00:00Z');
    const saved = saveAttachments(to, checkAttachments([{ path: src }, { name: 'pasted.png', data: new Uint8Array([9, 9]) }]), 2, now);
    expect(saved).toEqual([
      { file: '03-spec.pdf', name: 'spec.pdf', size: 3, kind: 'pdf', at: now.toISOString() },
      { file: '04-pasted.png', name: 'pasted.png', size: 2, kind: 'image', at: now.toISOString() },
    ]);
    expect(fs.readFileSync(path.join(to, '03-spec.pdf'), 'utf8')).toBe('PDF');
    expect([...fs.readFileSync(path.join(to, '04-pasted.png'))]).toEqual([9, 9]);
    expect(fs.existsSync(src)).toBe(true);
  });
});

describe('answer and send carry attachments over IPC', () => {
  it('keeps valid files, allows empty text with them, and refuses malformed ones', () => {
    expect(parseAction({ kind: 'send', text: 'look', attachments: [{ path: 'C:/files/a.png' }] })).toEqual({ kind: 'send', text: 'look', attachments: [{ path: 'C:/files/a.png' }] });
    expect(parseAction({ kind: 'answer', text: '', attachments: [{ path: 'C:/files/a.png' }] })).toEqual({ kind: 'answer', text: '', attachments: [{ path: 'C:/files/a.png' }] });
    expect(parseAction({ kind: 'send', text: 'plain' })).toEqual({ kind: 'send', text: 'plain' });
    expect(parseAction({ kind: 'send', text: 'x', attachments: [{ path: 3 }] })).toBeNull();
  });
});
