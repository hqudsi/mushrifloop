import { describe, expect, it } from 'vitest';

import { ATTACHMENT_LIMITS, attachmentBlock, attachmentKind, attachmentProblem, safeFileName, storedFileName, withAttachments } from './attachments';
import type { Attachment } from './task-model';

const shot: Attachment = { file: '01-screenshot.png', name: 'screenshot.png', size: 94_208, kind: 'image', at: '2026-10-17T10:00:00Z' };
const spec: Attachment = { file: '02-spec.pdf', name: 'spec.pdf', size: 2 * 1024 * 1024 + 300_000, kind: 'pdf', at: '2026-10-17T10:00:00Z' };

describe('attachments (SPEC.md §10)', () => {
  it('knows images and PDFs by their extension, whatever the case', () => {
    expect(attachmentKind('a.PNG')).toBe('image');
    expect(attachmentKind('photo.jpeg')).toBe('image');
    expect(attachmentKind('Report.Pdf')).toBe('pdf');
    expect(attachmentKind('notes.txt')).toBe('other');
    expect(attachmentKind('Makefile')).toBe('other');
  });

  it('keeps only the file name, without characters Windows refuses', () => {
    expect(safeFileName('C:\\Users\\x\\Desktop\\shot.png')).toBe('shot.png');
    expect(safeFileName('a/b/c.txt')).toBe('c.txt');
    expect(safeFileName('what?: "this" <is>.md')).toBe('what__ _this_ _is_.md');
    expect(safeFileName(' ..hidden. ')).toBe('hidden');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('صورة الشاشة.png')).toBe('صورة الشاشة.png');
  });

  it('shortens a long name but keeps its extension', () => {
    const name = safeFileName(`${'x'.repeat(200)}.png`);
    expect(name.length).toBe(80);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('numbers stored files, so two of the same name never collide', () => {
    expect(storedFileName(1, 'shot.png')).toBe('01-shot.png');
    expect(storedFileName(12, 'shot.png')).toBe('12-shot.png');
  });

  it('refuses too many files, or one that is too large', () => {
    expect(attachmentProblem([1, 2, 3])).toBeNull();
    expect(attachmentProblem(new Array(ATTACHMENT_LIMITS.maxFiles + 1).fill(1))).toMatch(/At most 10 files/);
    expect(attachmentProblem([10, ATTACHMENT_LIMITS.maxBytes + 1])).toMatch(/larger than 20\.0 MB/);
  });

  it('lists the files for the agents with full forward-slash paths, kinds and sizes', () => {
    const block = attachmentBlock([shot, spec], 'C:\\Users\\u\\AppData\\Roaming\\MushrifLoop\\tasks\\t1\\attachments\\');
    expect(block).toBe(
      [
        '[ATTACHED FILES] The user attached these files. Open each one with the Read tool when it matters:',
        '- C:/Users/u/AppData/Roaming/MushrifLoop/tasks/t1/attachments/01-screenshot.png (image, 92 KB; attached as "screenshot.png")',
        '- C:/Users/u/AppData/Roaming/MushrifLoop/tasks/t1/attachments/02-spec.pdf (pdf, 2.3 MB; attached as "spec.pdf")',
      ].join('\n'),
    );
  });

  it('puts the list after the text, or stands alone for a message of files only', () => {
    expect(withAttachments('Look at this', [], 'D:/x')).toBe('Look at this');
    expect(withAttachments('Look at this', [shot], 'D:/x')).toBe(`Look at this\n\n${attachmentBlock([shot], 'D:/x')}`);
    expect(withAttachments('', [shot], 'D:/x')).toBe(attachmentBlock([shot], 'D:/x'));
  });
});
