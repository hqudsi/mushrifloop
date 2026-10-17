/**
 * Files the user attaches to a new task or to a message (SPEC.md §10, attachments). The app copies each one
 * into the task's own `attachments/` folder — never the project, so nothing reaches a commit — and tells
 * the agents where it is; Claude Code's Read tool opens images, PDFs and text (NOTES.md §66).
 *
 * Pure: shared by the main process (checks, names, the prompt line) and the renderer (limits, sizes).
 */

import type { Attachment, AttachmentKind } from './task-model';

/** Per message (or per new task). A 5.7 MB image and a PDF were read without trouble (NOTES.md §66). */
export const ATTACHMENT_LIMITS = { maxFiles: 10, maxBytes: 20 * 1024 * 1024 } as const;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function attachmentKind(name: string): AttachmentKind {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

/** The last part of a path, with the characters Windows refuses in a file name taken out. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (clean.length > 80) {
    const ext = extensionOf(clean);
    const keep = ext && ext.length <= 10 ? `.${ext}` : '';
    clean = clean.slice(0, 80 - keep.length) + keep;
  }
  return clean || 'file';
}

/** `03-screenshot.png`: numbered in the order attached, so two files of the same name never collide. */
export function storedFileName(index: number, name: string): string {
  return `${String(index).padStart(2, '0')}-${safeFileName(name)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Why a set of files cannot be attached, or null. `sizes` are in bytes, in the order given. */
export function attachmentProblem(sizes: readonly number[]): string | null {
  if (sizes.length > ATTACHMENT_LIMITS.maxFiles) return `At most ${ATTACHMENT_LIMITS.maxFiles} files can be attached at a time.`;
  const big = sizes.findIndex((s) => s > ATTACHMENT_LIMITS.maxBytes);
  if (big >= 0) return `A file is larger than ${formatBytes(ATTACHMENT_LIMITS.maxBytes)} (${formatBytes(sizes[big] ?? 0)}).`;
  return null;
}

/**
 * The lines added to what the user wrote, in the prompt only (the timeline shows the files as files).
 * Paths use forward slashes, as the agents are told to write them.
 */
export function attachmentBlock(list: readonly Attachment[], dir: string): string {
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const lines = ['[ATTACHED FILES] The user attached these files. Open each one with the Read tool when it matters:'];
  for (const a of list) lines.push(`- ${root}/${a.file} (${a.kind}, ${formatBytes(a.size)}; attached as "${a.name}")`);
  return lines.join('\n');
}

/** What the user wrote, with the attached files listed after it. */
export function withAttachments(text: string, list: readonly Attachment[], dir: string): string {
  if (list.length === 0) return text;
  const block = attachmentBlock(list, dir);
  return text ? `${text}\n\n${block}` : block;
}
