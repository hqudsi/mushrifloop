/**
 * Copying attached files into a task (SPEC.md §10, attachments). A file arrives either as a path on disk
 * (the 📎 picker, drag and drop) or as bytes (an image pasted from the clipboard). Everything is checked
 * before anything is written, so a refused set leaves the task as it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { attachmentKind, attachmentProblem, storedFileName } from '../shared/attachments';
import type { AttachmentInput } from '../shared/ipc';
import type { Attachment } from '../shared/task-model';

/** The inputs of an IPC request, checked for shape; null when there are none. Throws on a malformed one. */
export function parseAttachmentInputs(raw: unknown): AttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('Invalid attachments.');
  return raw.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid attachment.');
    const r = item as Record<string, unknown>;
    if (typeof r['path'] === 'string' && r['path'].trim() !== '') return { path: r['path'] };
    if (typeof r['name'] === 'string' && r['data'] instanceof Uint8Array) return { name: r['name'], data: r['data'] };
    throw new Error('Invalid attachment.');
  });
}

interface Checked {
  input: AttachmentInput;
  name: string;
  size: number;
}

/** Each input's name and size; throws with the reason when a file is missing, not a file, or over a limit. */
export function checkAttachments(inputs: readonly AttachmentInput[]): Checked[] {
  const checked = inputs.map((input): Checked => {
    if ('data' in input) return { input, name: input.name, size: input.data.byteLength };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.path);
    } catch {
      throw new Error(`The file is not there any more: ${input.path}`);
    }
    if (!stat.isFile()) throw new Error(`Only files can be attached, not folders: ${input.path}`);
    return { input, name: path.basename(input.path), size: stat.size };
  });
  const problem = attachmentProblem(checked.map((c) => c.size));
  if (problem) throw new Error(problem);
  return checked;
}

/**
 * Copies checked files into `dir`, numbered after the `already` files the task has. Returns what was
 * stored, in order.
 */
export function saveAttachments(dir: string, checked: readonly Checked[], already: number, now: Date): Attachment[] {
  if (checked.length === 0) return [];
  fs.mkdirSync(dir, { recursive: true });
  const at = now.toISOString();
  return checked.map((c, i) => {
    const file = storedFileName(already + i + 1, c.name);
    const to = path.join(dir, file);
    if ('data' in c.input) fs.writeFileSync(to, c.input.data);
    else fs.copyFileSync(c.input.path, to);
    return { file, name: c.name, size: c.size, kind: attachmentKind(c.name), at };
  });
}
