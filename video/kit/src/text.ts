/**
 * Text in the video: drawn once on a detached 2D canvas with `fillText`, then used as a texture on a
 * plane. The browser does the shaping, so Arabic comes out joined and right to left, and the result
 * lives in the one WebGL canvas that is captured.
 *
 * Animate Arabic by word or by line (one plane each), never by letter: separate letters lose their
 * joined forms.
 *
 * Call these only after `loadFonts()` has finished.
 */

import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

export interface TextStyle {
  family: string;
  weight: number;
  /** Font size in texture pixels. Draw large (160–320) and scale the plane down: it stays sharp. */
  sizePx: number;
  color: string;
  /** 'rtl' for Arabic and other right-to-left scripts. */
  direction: 'ltr' | 'rtl';
}

export interface TextPlane {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** Width divided by height of the drawn text, padding included. */
  aspect: number;
}

/** Guess the direction from the first strongly directional letter. */
export function directionOf(text: string): 'ltr' | 'rtl' {
  return /^[^A-Za-zÀ-ɏ]*[֐-ࣿיִ-﷿ﹰ-﻿]/.test(text) ? 'rtl' : 'ltr';
}

export function drawText(text: string, style: TextStyle): HTMLCanvasElement {
  const font = `${style.weight} ${style.sizePx}px "${style.family}"`;
  const pad = Math.ceil(style.sizePx * 0.3);
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('2D canvas is not available.');
  measure.font = font;
  measure.direction = style.direction;
  // Measure exactly as the text is drawn below. With the default alignment ('start') a right-to-left
  // text is measured from its right edge, and drawing it from the left then pushes it off the canvas.
  measure.textAlign = 'left';
  measure.textBaseline = 'alphabetic';
  const m = measure.measureText(text);
  const width = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + pad * 2;
  const ascent = Math.ceil(Math.max(m.fontBoundingBoxAscent, m.actualBoundingBoxAscent));
  const descent = Math.ceil(Math.max(m.fontBoundingBoxDescent, m.actualBoundingBoxDescent));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = ascent + descent + pad * 2;
  // `willReadFrequently` keeps this canvas in main memory, drawn by the CPU. Without it the browser
  // may draw large text on the GPU in one launch and on the CPU in the next, and the two differ by a
  // few pixel values: the same frame then gives different images in different runs.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is not available.');
  ctx.font = font;
  ctx.direction = style.direction;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = style.color;
  // With textAlign 'left' the pen position is the text's left edge in both directions.
  ctx.fillText(text, pad + m.actualBoundingBoxLeft, pad + ascent);
  return canvas;
}

/** A plane `height` world units tall showing `text`. Its material is unlit and ignores tone mapping. */
export function makeTextPlane(text: string, style: TextStyle, height: number): TextPlane {
  const canvas = drawText(text, style);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  const aspect = canvas.width / canvas.height;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(height * aspect, height), material);
  mesh.renderOrder = 10;
  return { mesh, aspect };
}
