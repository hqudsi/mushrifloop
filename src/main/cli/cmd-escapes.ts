/**
 * `npm run` on Windows can hand an argument over with cmd.exe's caret escapes still in it
 * (`^Add^ a^ README…` — seen in the first real try-loop run, NOTES.md §16). When every space is
 * escaped that way, the carets are escapes, not text: remove them. Anything else is left alone.
 */
export function undoCmdEscapes(text: string): { text: string; changed: boolean } {
  const spaces = (text.match(/ /g) ?? []).length;
  const escaped = (text.match(/\^ /g) ?? []).length;
  if (spaces === 0 || escaped !== spaces) return { text, changed: false };
  return { text: text.replace(/\^(.)/g, '$1').replace(/\^$/, ''), changed: true };
}
