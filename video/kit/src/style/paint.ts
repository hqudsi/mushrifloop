/**
 * Painted surface textures, generated on a canvas from a seed (deterministic). They are near-white
 * multipliers: a toon material keeps its own colour and its 2–3 tone bands, and the texture adds the
 * hand-painted life on top: a clear vertical gradient (darker at the base), soft rain streaks under
 * windowsills and the roof edge, patched and discoloured panels, seam lines and uneven brushwork.
 * Everything is drawn soft (blurred shapes), never as noise. Darkening uses a warm plum, never grey.
 *
 * Wall textures repeat horizontally and run once vertically over a band of the wall (see `wallUVs`).
 * With `windows`, the streaks start under the window grid the shot places on the wall.
 */

import { type BufferGeometry, CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace } from 'three';
import { rng } from './random';

export interface WallPaintOptions {
  /** Metres covered by one horizontal repeat and by the vertical band. */
  tile?: number;
  band?: number;
  /** Panels across one horizontal repeat, and down the band. */
  panelsX?: number;
  panelsY?: number;
  stains?: number;
  /** How much darker the base is (0–1). */
  baseShade?: number;
  /** Window grid, in metres: first column centre from the tile's left edge and spacing; first row
   *  centre below the band's top and spacing; window height. Streaks run down from each sill. */
  windows?: { col0: number; colStep: number; row0: number; rowStep: number; height: number };
}

const DARK = '92, 34, 72';
const LIGHT = '255, 246, 232';

export function paintCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // Drawn by the CPU, like the text canvases: the same seed then gives the same pixels in every launch.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is not available.');
  return [c, ctx];
}

/**
 * Soft shapes: `draw` paints sharp shapes on a separate layer, and the layer is laid over the canvas
 * through one blur. Blurring every stroke by itself looks the same and takes a hundred times longer
 * on a canvas drawn by the CPU.
 */
function soft(ctx: CanvasRenderingContext2D, px: number, draw: (layer: CanvasRenderingContext2D) => void): void {
  const [layer, lctx] = paintCanvas(ctx.canvas.width, ctx.canvas.height);
  draw(lctx);
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(layer, 0, 0);
  ctx.filter = 'none';
}

/** Draw at x and, when it crosses an edge, at x ± w so the texture tiles horizontally. */
function wrapped(w: number, x: number, r: number, draw: (x: number) => void): void {
  draw(x);
  if (x - r < 0) draw(x + w);
  if (x + r > w) draw(x - w);
}

function brushwork(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, count: number, strength: number): void {
  const r = rng(seed);
  soft(ctx, 3, (ctx) => {
  for (let i = 0; i < count; i++) {
    const x = r.range(0, w);
    const y = r.range(0, h);
    const rx = r.range(18, 80);
    const ry = r.range(5, 18);
    const light = r.next() < 0.5;
    const a = r.range(0.4, 1) * strength;
    ctx.fillStyle = light ? `rgba(${LIGHT}, ${a})` : `rgba(${DARK}, ${a * 0.8})`;
    wrapped(w, x, rx, (xx) => {
      ctx.beginPath();
      ctx.ellipse(xx, y, rx, ry, r.range(-0.12, 0.12), 0, Math.PI * 2);
      ctx.fill();
    });
  }
  });
}

function stain(ctx: CanvasRenderingContext2D, w: number, x: number, y: number, rad: number, a: number, squash = 0.75): void {
  wrapped(w, x, rad, (xx) => {
    const g = ctx.createRadialGradient(xx, y, 0, xx, y, rad);
    g.addColorStop(0, `rgba(${DARK}, ${a})`);
    g.addColorStop(0.55, `rgba(${DARK}, ${a * 0.6})`);
    g.addColorStop(1, `rgba(${DARK}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(xx, y, rad, rad * squash, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** A rain streak: a wide faint wash with a few narrower runs inside, fading downwards. Draw it inside `soft`. */
function streak(ctx: CanvasRenderingContext2D, w: number, r: ReturnType<typeof rng>, x: number, y: number, width: number, len: number, a: number): void {
  wrapped(w, x, width, (xx) => {
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, `rgba(${DARK}, ${a * 0.7})`);
    g.addColorStop(1, `rgba(${DARK}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(xx - width / 2, y);
    ctx.lineTo(xx + width / 2, y);
    ctx.lineTo(xx + width * 0.3, y + len);
    ctx.lineTo(xx - width * 0.3, y + len);
    ctx.closePath();
    ctx.fill();
    const runs = 2 + Math.floor(r.next() * 3);
    for (let k = 0; k < runs; k++) {
      const rx = xx + r.range(-0.4, 0.4) * width;
      const rl = len * r.range(0.6, 1.3);
      const rw = r.range(1.5, 3.5);
      const g2 = ctx.createLinearGradient(0, y, 0, y + rl);
      g2.addColorStop(0, `rgba(${DARK}, ${a})`);
      g2.addColorStop(1, `rgba(${DARK}, 0)`);
      ctx.fillStyle = g2;
      ctx.fillRect(rx - rw / 2, y, rw, rl);
    }
  });
}

/** A painted wall: repeat it horizontally; v runs 0 (base) to 1 (top) over the painted band. */
export function paintedWallTexture(seed: number, o: WallPaintOptions = {}): CanvasTexture {
  const w = 512;
  const h = 1024;
  const tile = o.tile ?? 12;
  const band = o.band ?? 26;
  const pxm = w / tile; // pixels per metre, horizontally
  const pym = h / band; // vertically
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);
  // A clear vertical gradient: lighter at the top, darker towards the base.
  const base = o.baseShade ?? 0.42;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${LIGHT}, 0.35)`);
  grad.addColorStop(0.3, `rgba(${DARK}, 0)`);
  grad.addColorStop(1, `rgba(${DARK}, ${base})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  brushwork(ctx, w, h, seed + 1, 340, 0.09);
  // Patched and discoloured panels, aligned to the panel grid, with soft edges.
  const px = o.panelsX ?? 4;
  const py = o.panelsY ?? 8;
  const pw = w / px;
  const ph = h / py;
  soft(ctx, 4, (ctx) => {
  for (let i = 0; i < 5; i++) {
    const cx = r.int(0, px - 1);
    const cy = r.int(0, py - 1);
    const light = r.next() < 0.45;
    ctx.fillStyle = light ? `rgba(${LIGHT}, ${r.range(0.18, 0.28)})` : `rgba(${DARK}, ${r.range(0.1, 0.17)})`;
    ctx.fillRect(cx * pw + 4, cy * ph + 4, pw * r.range(0.5, 1) - 8, ph * r.range(0.5, 1) - 8);
  }
  });
  // Stains.
  for (let i = 0; i < (o.stains ?? 6); i++) stain(ctx, w, r.range(0, w), r.range(h * 0.2, h), r.range(30, 90), r.range(0.12, 0.2));
  // Seam lines: a dark seam with a light lip under it.
  for (let j = 1; j < py; j++) {
    const y = Math.round(j * ph) + 0.5;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(${DARK}, 0.24)`;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${LIGHT}, 0.2)`;
    ctx.beginPath(); ctx.moveTo(0, y + 3); ctx.lineTo(w, y + 3); ctx.stroke();
  }
  ctx.lineWidth = 2;
  for (let i = 0; i < px; i++) {
    const x = Math.round(i * pw) + 0.5;
    ctx.strokeStyle = `rgba(${DARK}, 0.17)`;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  // Rain streaks under the windowsills.
  const win = o.windows;
  soft(ctx, 2, (ctx) => {
  if (win) {
    for (let cx = win.col0; cx < tile; cx += win.colStep) {
      for (let ry = win.row0; ry < band; ry += win.rowStep) {
        if (r.next() < 0.3) continue;
        const sillY = (ry + win.height / 2 + 0.12) * pym;
        streak(ctx, w, r, cx * pxm + r.range(-0.15, 0.15) * pxm, sillY, r.range(0.7, 1.1) * pxm, r.range(1.0, 2.4) * pym, r.range(0.16, 0.28));
      }
    }
  }
  // Streaks down from the roof edge, and a dirty band under it.
  for (let i = 0; i < 9; i++) streak(ctx, w, r, r.range(0, w), 0, r.range(0.4, 1.4) * pxm, r.range(1.5, 4.5) * pym, r.range(0.16, 0.3));
  });
  const top = ctx.createLinearGradient(0, 0, 0, 1.2 * pym);
  top.addColorStop(0, `rgba(${DARK}, 0.25)`);
  top.addColorStop(1, `rgba(${DARK}, 0)`);
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, 1.2 * pym);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Painted roof concrete: tiles both ways; tile seams, water stains, patches, cracks, brushwork. */
export function paintedConcreteTexture(seed: number, size = 512): CanvasTexture {
  const [c, ctx] = paintCanvas(size, size);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, size, size);
  brushwork(ctx, size, size, seed + 3, 380, 0.1);
  // Repair patches: lighter or darker slabs with soft edges.
  const n = 4;
  const cell = size / n;
  soft(ctx, 3, (ctx) => {
  for (let i = 0; i < 6; i++) {
    const cx = r.int(0, n - 1);
    const cy = r.int(0, n - 1);
    ctx.fillStyle = r.next() < 0.5 ? `rgba(${LIGHT}, ${r.range(0.28, 0.4)})` : `rgba(${DARK}, ${r.range(0.16, 0.24)})`;
    ctx.fillRect(cx * cell + 4, cy * cell + 4, cell - 8, cell * r.range(0.5, 1) - 8);
  }
  });
  // Water stains: large soft darker pools with a darker rim (dried edge).
  for (let i = 0; i < 6; i++) {
    const x = r.range(0, size);
    const y = r.range(0, size);
    const rad = r.range(40, 110);
    stain(ctx, size, x, y, rad, r.range(0.24, 0.36), r.range(0.5, 0.8));
    soft(ctx, 2, (ctx) => {
    ctx.strokeStyle = `rgba(${DARK}, 0.14)`;
    ctx.lineWidth = 3;
    wrapped(size, x, rad, (xx) => {
      ctx.beginPath();
      ctx.ellipse(xx, y, rad * 0.8, rad * 0.55, r.range(-0.3, 0.3), 0, Math.PI * 2);
      ctx.stroke();
    });
    });
  }
  // Tile seams with a light lip.
  for (let i = 0; i < n; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${DARK}, 0.3)`;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${LIGHT}, 0.22)`;
    ctx.beginPath(); ctx.moveTo(p + 3, 0); ctx.lineTo(p + 3, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p + 3); ctx.lineTo(size, p + 3); ctx.stroke();
  }
  // Hairline cracks.
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    let x = r.range(0, size);
    let y = r.range(0, size);
    ctx.strokeStyle = `rgba(${DARK}, 0.22)`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += r.range(-18, 18);
      y += r.range(4, 22);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** A soft dark edge for decals: transparent in the middle (v = 1), darker at v = 0. */
export function edgeGrimeTexture(): CanvasTexture {
  const [c, ctx] = paintCanvas(8, 128);
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 128);
  const tex = new CanvasTexture(c);
  return tex;
}

/**
 * World-scaled UVs for an axis-aligned box mesh placed at `origin` (its world position): side faces
 * get u along the face (one repeat per `tile` metres, starting at `uOrigin` on faces along x) and v
 * from `bottom` (0) to `bottom + band` (1) in world height; top and bottom faces get u, v from world
 * x, z per `topTile`.
 */
export function wallUVs(geometry: BufferGeometry, origin: { x: number; y: number; z: number }, o: { tile: number; bottom: number; band: number; topTile?: number; uOrigin?: number; topOrigin?: { x: number; z: number }; sideOrigin?: number }): void {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const topTile = o.topTile ?? o.tile;
  const u0 = o.uOrigin ?? 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + origin.x;
    const y = pos.getY(i) + origin.y;
    const z = pos.getZ(i) + origin.z;
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    if (Math.abs(ny) > 0.5) uv.setXY(i, (x - (o.topOrigin?.x ?? 0)) / topTile, (z - (o.topOrigin?.z ?? 0)) / topTile);
    else if (Math.abs(nx) > 0.5) uv.setXY(i, (nx > 0 ? -(z - (o.sideOrigin ?? 0)) : z - (o.sideOrigin ?? 0)) / o.tile, (y - o.bottom) / o.band);
    else uv.setXY(i, (nrm.getZ(i) > 0 ? x - u0 : -x) / o.tile, (y - o.bottom) / o.band);
  }
  uv.needsUpdate = true;
}

function finish(c: HTMLCanvasElement, repeat = true): CanvasTexture {
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Vertical stave lines round a tank (u runs round the cylinder): continuous painted ink lines. */
export function staveTexture(count: number, ink = '62, 22, 58'): CanvasTexture {
  const w = 1024;
  const h = 64;
  const [c, ctx] = paintCanvas(w, h);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const x = ((i + 0.5) / count) * w;
    ctx.fillStyle = `rgba(${LIGHT}, 0.35)`;
    ctx.fillRect(x + 2, 0, 3, h);
    ctx.fillStyle = `rgba(${ink}, 0.8)`;
    ctx.fillRect(x - 2, 0, 4, h);
  }
  return finish(c);
}

/** Generic painted ground: soft mottling, stains and wear, tiling both ways. */
export function paintedGroundTexture(seed: number, strength = 1): CanvasTexture {
  const size = 512;
  const [c, ctx] = paintCanvas(size, size);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, size, size);
  brushwork(ctx, size, size, seed + 5, 420, 0.12 * strength);
  for (let i = 0; i < 8; i++) stain(ctx, size, r.range(0, size), r.range(0, size), r.range(40, 120), r.range(0.12, 0.22) * strength, r.range(0.4, 0.8));
  return finish(c);
}

/**
 * Painted road asphalt across its width (u: 0–1 = one edge to the other), repeating along it: darker
 * edge grime, a worn lighter strip in each wheel track, oil stains and patched repairs.
 */
export function paintedRoadTexture(seed: number): CanvasTexture {
  const w = 256;
  const h = 512;
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);
  brushwork(ctx, w, h, seed + 7, 260, 0.1);
  // Wheel tracks: lighter worn bands.
  soft(ctx, 6, (ctx) => {
  for (const t of [0.25, 0.4, 0.6, 0.75]) {
    ctx.fillStyle = `rgba(${LIGHT}, 0.16)`;
    ctx.fillRect(t * w - 8, 0, 16, h);
  }
  });
  // Oil stains along the lane centres, repair patches.
  for (let i = 0; i < 7; i++) stain(ctx, w, r.pick([0.3, 0.7]) * w + r.range(-10, 10), r.range(0, h), r.range(10, 30), r.range(0.2, 0.32), 1.6);
  soft(ctx, 2, (ctx) => {
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `rgba(${DARK}, ${r.range(0.12, 0.2)})`;
    ctx.fillRect(r.range(20, w - 80), r.range(0, h - 80), r.range(40, 70), r.range(40, 90));
  }
  });
  // Edge grime.
  for (const side of [0, 1]) {
    const g = ctx.createLinearGradient(side ? w : 0, 0, side ? w - 40 : 40, 0);
    g.addColorStop(0, `rgba(${DARK}, 0.4)`);
    g.addColorStop(1, `rgba(${DARK}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(side ? w - 40 : 0, 0, 40, h);
  }
  return finish(c);
}

/** Painted gravel: many small soft dabs, light and dark, with a few darker oily patches. */
export function paintedGravelTexture(seed: number): CanvasTexture {
  const size = 512;
  const [c, ctx] = paintCanvas(size, size);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(236, 232, 240)';
  ctx.fillRect(0, 0, size, size);
  soft(ctx, 0.8, (ctx) => {
  for (let i = 0; i < 2600; i++) {
    const x = r.range(0, size);
    const y = r.range(0, size);
    const s = r.range(2, 6);
    const light = r.next() < 0.5;
    ctx.fillStyle = light ? `rgba(${LIGHT}, ${r.range(0.3, 0.6)})` : `rgba(${DARK}, ${r.range(0.18, 0.35)})`;
    wrapped(size, x, s, (xx) => {
      ctx.beginPath();
      ctx.ellipse(xx, y, s, s * r.range(0.6, 0.9), r.range(0, 3), 0, Math.PI * 2);
      ctx.fill();
    });
  }
  });
  for (let i = 0; i < 5; i++) stain(ctx, size, r.range(0, size), r.range(0, size), r.range(40, 100), r.range(0.15, 0.25), 0.6);
  return finish(c);
}

/** Painted timber: lengthwise grain strokes, end grime, a crack or two (u along the plank). */
export function paintedPlankTexture(seed: number): CanvasTexture {
  const w = 256;
  const h = 64;
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 18; i++) {
    const y = r.range(2, h - 2);
    ctx.strokeStyle = `rgba(${DARK}, ${r.range(0.12, 0.28)})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 32) ctx.lineTo(x, y + r.range(-1.5, 1.5));
    ctx.stroke();
  }
  for (const side of [0, 1]) {
    const g = ctx.createLinearGradient(side ? w : 0, 0, side ? w - 50 : 50, 0);
    g.addColorStop(0, `rgba(${DARK}, 0.35)`);
    g.addColorStop(1, `rgba(${DARK}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(side ? w - 50 : 0, 0, 50, h);
  }
  stain(ctx, w, r.range(60, 200), r.range(10, 50), r.range(20, 40), 0.2, 0.5);
  return finish(c);
}

/**
 * Painted body panels for a vehicle side (u along the body, v up): vertical panel seams every
 * `panels`, a horizontal seam, darker grime towards the bottom and soft streaks.
 */
export function paintedPanelTexture(seed: number, panels = 8): CanvasTexture {
  const w = 1024;
  const h = 256;
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgba(${LIGHT}, 0.2)`);
  g.addColorStop(0.5, `rgba(${DARK}, 0)`);
  g.addColorStop(1, `rgba(${DARK}, 0.35)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i <= panels; i++) {
    const x = Math.round((i / panels) * w);
    ctx.fillStyle = `rgba(${DARK}, 0.4)`;
    ctx.fillRect(x - 2, 0, 4, h);
  }
  ctx.fillStyle = `rgba(${DARK}, 0.3)`;
  ctx.fillRect(0, Math.round(h * 0.78) - 2, w, 4);
  soft(ctx, 2, (ctx) => {
    for (let i = 0; i < 4; i++) streak(ctx, w, r, r.range(0, w), h * r.range(0.55, 0.7), r.range(14, 30), r.range(30, 60), r.range(0.06, 0.1));
  });
  return finish(c);
}

/**
 * Painted roof tiles for a cone or plane roof: rows of tiles parallel to the eave (rows along v),
 * each row a dark shadow line with a light lip, with staggered joints along u.
 */
export function roofTileTexture(seed: number, rows = 14, cols = 24): CanvasTexture {
  const size = 512;
  const [c, ctx] = paintCanvas(size, size);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, size, size);
  brushwork(ctx, size, size, seed + 11, 160, 0.07);
  const rh = size / rows;
  const cw = size / cols;
  for (let j = 0; j < rows; j++) {
    const y = Math.round(j * rh) + 0.5;
    const sh = ctx.createLinearGradient(0, y, 0, y + rh * 0.5);
    sh.addColorStop(0, `rgba(${DARK}, 0.35)`);
    sh.addColorStop(1, `rgba(${DARK}, 0)`);
    ctx.fillStyle = sh;
    ctx.fillRect(0, y, size, rh * 0.5);
    ctx.fillStyle = `rgba(${LIGHT}, 0.3)`;
    ctx.fillRect(0, y - 2, size, 2);
    ctx.strokeStyle = `rgba(${DARK}, 0.25)`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < cols; i++) {
      const x = (i + (j % 2) * 0.5) * cw + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + rh); ctx.stroke();
    }
  }
  for (let i = 0; i < 4; i++) stain(ctx, size, r.range(0, size), r.range(0, size), r.range(30, 70), r.range(0.1, 0.18), 0.7);
  return finish(c);
}

/**
 * A far building facade: a faint grid of dark window openings over a painted wall, tiling both ways
 * (one repeat = `cols` × `rows` windows). The lit windows are separate emissive pieces.
 */
export function skylineTexture(seed: number, cols = 4, rows = 4): CanvasTexture {
  const size = 256;
  const [c, ctx] = paintCanvas(size, size);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, size, size);
  brushwork(ctx, size, size, seed + 13, 90, 0.08);
  const cw = size / cols;
  const rh = size / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      ctx.fillStyle = `rgba(${DARK}, ${r.range(0.16, 0.26)})`;
      ctx.fillRect(i * cw + cw * 0.25, j * rh + rh * 0.28, cw * 0.5, rh * 0.42);
    }
    ctx.fillStyle = `rgba(${DARK}, 0.1)`;
    ctx.fillRect(0, j * rh + rh * 0.82, size, 3);
  }
  soft(ctx, 2, (ctx) => {
    for (let i = 0; i < 3; i++) streak(ctx, size, r, r.range(0, size), r.range(0, size * 0.6), r.range(8, 20), r.range(40, 100), 0.1);
  });
  return finish(c);
}

export interface SkyPaintOptions {
  /** Colours from the top of the sky down to the horizon. */
  top: string;
  mid: string;
  horizon: string;
  /** Where the horizon colour is reached, as a share of the height from the top (default 0.7). */
  horizonAt?: number;
  /** Cloud colours: the lit side and the shaded underside. */
  cloud: string;
  cloudShade: string;
  /** Number of cloud banks (default 5; 0 for a clear sky). */
  clouds?: number;
  /**
   * Share of the width, round the middle, that no cloud bank is centred in (default 0). Use it when a
   * title sits in the middle of the sky: text over a pale cloud is hard to read.
   */
  clearMiddle?: number;
}

/**
 * A painted sky: a gradient in three colours and banks of layered cumulus, each a pile of soft discs
 * with a shaded underside. Use it as `scene.background`, or on a large far plane.
 * A sky in one flat colour is the largest plain surface a frame can have.
 */
export function paintedSkyTexture(seed: number, o: SkyPaintOptions): CanvasTexture {
  // Large enough that a 1080p frame does not show it enlarged: cloud edges stay drawn, not smeared.
  const w = 1600;
  const h = 900;
  const k = w / 1024;
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  const at = o.horizonAt ?? 0.7;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, o.top);
  g.addColorStop(at * 0.62, o.mid);
  g.addColorStop(at, o.horizon);
  g.addColorStop(1, o.horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const banks = o.clouds ?? 5;
  for (let i = 0; i < banks; i++) {
    // Banks sit lower and get smaller towards the horizon.
    const depth = (i + 0.5) / banks;
    // Left or right of the part kept clear, alternating so both sides get clouds.
    const clear = Math.max(0, Math.min(0.9, o.clearMiddle ?? 0));
    const side = r.range(0, (w * (1 - clear)) / 2);
    const cx = clear > 0 ? (i % 2 === 0 ? side : w - side) : r.range(0, w);
    const cy = h * at * (0.2 + 0.7 * depth) + r.range(-18, 18) * k;
    const size = (1.25 - depth * 0.75) * r.range(60, 100) * k;
    const puffs = r.int(7, 11);
    const blobs: [number, number, number][] = [];
    for (let k = 0; k < puffs; k++) {
      const t = k / (puffs - 1) - 0.5;
      blobs.push([cx + t * size * (clear > 0 ? 2.6 : 4.2) + r.range(-10, 10) * k, cy - (1 - 4 * t * t) * size * r.range(0.25, 0.6), size * r.range(0.45, 0.8) * (1 - Math.abs(t) * 0.7)]);
    }
    // Underside first (shifted down), then the lit tops over it; both soft.
    soft(ctx, 4, (ctx) => {
    ctx.fillStyle = o.cloudShade;
    for (const [x, y, rad] of blobs) {
      ctx.beginPath();
      ctx.ellipse(x, y + rad * 0.45, rad * 1.15, rad * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    });
    soft(ctx, 1.5, (ctx) => {
    ctx.fillStyle = o.cloud;
    for (const [x, y, rad] of blobs) {
      ctx.beginPath();
      ctx.ellipse(x, y, rad, rad * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    });
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
