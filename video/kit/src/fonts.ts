/**
 * Fonts are files inside the kit (public/fonts, with their licences): nothing is fetched from the
 * network at render time. Every face a scene draws with is loaded here before `ready` resolves;
 * a face that is not loaded yet would be drawn with a fallback font, differently on every machine.
 */

export interface FontFaceSpec {
  family: string;
  weight: number;
  /** File name under public/fonts. */
  file: string;
  /** A few characters of the script the face is for, so the browser confirms it can draw them. */
  sample: string;
}

export const FONTS: readonly FontFaceSpec[] = [
  { family: 'Inter', weight: 400, file: 'inter-latin-400-normal.woff2', sample: 'Hello' },
  { family: 'Inter', weight: 700, file: 'inter-latin-700-normal.woff2', sample: 'Hello' },
  { family: 'Noto Sans Arabic', weight: 400, file: 'noto-sans-arabic-arabic-400-normal.woff2', sample: 'مرحبا' },
  { family: 'Noto Sans Arabic', weight: 700, file: 'noto-sans-arabic-arabic-700-normal.woff2', sample: 'مرحبا' },
];

export async function loadFonts(faces: readonly FontFaceSpec[] = FONTS): Promise<void> {
  for (const spec of faces) {
    const url = new URL(`fonts/${spec.file}`, document.baseURI).href;
    const face = new FontFace(spec.family, `url("${url}") format("woff2")`, { weight: String(spec.weight), style: 'normal' });
    document.fonts.add(await face.load());
    const loaded = await document.fonts.load(`${spec.weight} 64px "${spec.family}"`, spec.sample);
    if (loaded.length === 0) throw new Error(`Font not usable: ${spec.family} ${spec.weight} (${spec.file}).`);
  }
}
