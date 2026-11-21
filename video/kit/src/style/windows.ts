/**
 * Real windows, instanced: a pane set back behind a protruding frame (four bars), a sill under it, and
 * optional mullions. Panes come in four kinds, each one instanced mesh with its own painted texture
 * and a per-instance warm tone: plain lit, lit with curtains, lit with a blind, and dark (a deep tint
 * with a faint diagonal reflection). Each window is placed flush on a wall face, oriented to the face
 * normal.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { EDGE_LAYER } from './edges';
import { type ToonLook, toon } from './toon';

export type PaneKind = 'lit' | 'curtain' | 'blind' | 'dark' | 'lamp';

export interface WindowSpec {
  /** Centre of the window on the wall surface. */
  position: Vector3;
  /** Outward wall normal (horizontal). */
  normal: Vector3;
  width: number;
  height: number;
  kind: PaneKind;
  /** Pane tone (lit: the light colour; dark: the glass colour). */
  tone: string;
  mullions?: boolean;
}

export interface WindowStyle {
  frame: string;
  sill: string;
  look: ToonLook;
  /** Frame bar thickness and depth (metres). */
  bar?: number;
  depth?: number;
  fog?: boolean;
  /**
   * Opt-in recessed look for walls seen at steep angles: the frame lies flush on the wall plane (no
   * sides standing out), only a thin shallow sill projects, and dark reveal strips along the top and
   * one side of the opening paint the depth of a pane set back into the wall.
   */
  flush?: { reveal: string; sillDepth?: number };
}

function paneTexture(kind: PaneKind): CanvasTexture {
  const w = 64;
  const h = 96;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  if (kind === 'dark') {
    // The tone multiplies this: a base at 75 %, darker towards the bottom, and a lighter diagonal
    // reflection band across the glass.
    ctx.fillStyle = 'rgb(192, 186, 196)';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(60,20,60,0.3)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w * 0.4, h * 0.35);
    ctx.rotate(-0.6);
    ctx.fillStyle = 'rgba(255,250,245,0.55)';
    ctx.fillRect(-60, -7, 120, 9);
    ctx.fillStyle = 'rgba(255,250,245,0.35)';
    ctx.fillRect(-60, 8, 120, 3);
    ctx.restore();
  } else {
    // Lit: brighter in the middle top, a warm falloff to the edges.
    const g = ctx.createRadialGradient(w * 0.5, h * 0.35, 4, w * 0.5, h * 0.45, h * 0.7);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#e6c8b8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (kind === 'curtain') {
      // Two drapes gathered to the sides with folds, and a tie line.
      for (const side of [0, 1]) {
        const x0 = side === 0 ? 0 : w * 0.66;
        const x1 = side === 0 ? w * 0.34 : w;
        ctx.fillStyle = 'rgba(150, 60, 90, 0.55)';
        ctx.beginPath();
        if (side === 0) {
          ctx.moveTo(x0, 0); ctx.lineTo(x1, 0); ctx.quadraticCurveTo(w * 0.16, h * 0.55, x1 * 0.75, h); ctx.lineTo(x0, h);
        } else {
          ctx.moveTo(x1, 0); ctx.lineTo(x0, 0); ctx.quadraticCurveTo(w * 0.84, h * 0.55, x0 + (w - x0) * 0.25, h); ctx.lineTo(x1, h);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(90, 30, 60, 0.45)';
        ctx.lineWidth = 1.5;
        for (let k = 1; k < 3; k++) {
          const fx = x0 + ((x1 - x0) * k) / 3;
          ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx + (side === 0 ? -4 : 4), h); ctx.stroke();
        }
      }
    } else if (kind === 'lamp') {
      // A room lamp in silhouette: a wide shade on a thin stand, on a low cabinet.
      ctx.fillStyle = 'rgba(110, 45, 60, 0.55)';
      ctx.beginPath();
      ctx.moveTo(w * 0.52, h * 0.28);
      ctx.lineTo(w * 0.78, h * 0.28);
      ctx.lineTo(w * 0.86, h * 0.46);
      ctx.lineTo(w * 0.44, h * 0.46);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(w * 0.635, h * 0.46, 3, h * 0.3);
      ctx.fillRect(w * 0.4, h * 0.76, w * 0.6, h * 0.24);
      const lg = ctx.createRadialGradient(w * 0.65, h * 0.5, 2, w * 0.65, h * 0.5, w * 0.5);
      lg.addColorStop(0, 'rgba(255,255,255,0.6)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, w, h);
    } else if (kind === 'blind') {
      // Slats over the upper two thirds.
      const bottom = h * 0.62;
      ctx.fillStyle = 'rgba(170, 90, 80, 0.32)';
      ctx.fillRect(0, 0, w, bottom);
      ctx.strokeStyle = 'rgba(110, 45, 60, 0.45)';
      ctx.lineWidth = 1.5;
      for (let y = 5; y < bottom; y += 7) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(110, 45, 60, 0.6)';
      ctx.fillRect(0, bottom - 2, w, 3);
    }
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Collects windows, then builds the instanced meshes. */
export class WindowBuilder {
  private specs: WindowSpec[] = [];

  add(spec: WindowSpec): void {
    this.specs.push(spec);
  }

  get count(): number {
    return this.specs.length;
  }

  build(style: WindowStyle): Group {
    const group = new Group();
    const bar = style.bar ?? 0.09;
    const flush = style.flush;
    const depth = flush ? 0.012 : style.depth ?? 0.12;
    const revealMats: Matrix4[] = [];
    const fog = style.fog ?? true;
    const up = new Vector3(0, 1, 0);
    const right = new Vector3();
    const basis = new Matrix4();
    const local = new Matrix4();
    const m = new Matrix4();
    const kinds: PaneKind[] = ['lit', 'curtain', 'blind', 'dark', 'lamp'];
    const paneSpecs = new Map<PaneKind, WindowSpec[]>(kinds.map((k) => [k, []]));
    const barMats: Matrix4[] = [];
    const sillMats: Matrix4[] = [];
    for (const s of this.specs) {
      paneSpecs.get(s.kind)?.push(s);
      right.crossVectors(up, s.normal).normalize();
      basis.makeBasis(right, up, s.normal).setPosition(s.position);
      const hw = s.width / 2;
      const hh = s.height / 2;
      // Frame: top, bottom, left, right bars (unit box scaled), standing out of the wall.
      const bars: [number, number, number, number][] = [
        [0, hh + bar / 2, s.width + 2 * bar, bar],
        [0, -hh - bar / 2, s.width + 2 * bar, bar],
        [-hw - bar / 2, 0, bar, s.height],
        [hw + bar / 2, 0, bar, s.height],
      ];
      if (s.mullions) {
        bars.push([0, 0, bar * 0.6, s.height]);
        bars.push([0, hh * 0.25, s.width, bar * 0.6]);
      }
      for (const [x, y, sx, sy] of bars) {
        local.makeScale(sx, sy, depth).setPosition(x, y, depth / 2);
        barMats.push(m.multiplyMatrices(basis, local).clone());
      }
      if (flush) {
        const sd = flush.sillDepth ?? 0.11;
        local.makeScale(s.width + 2.6 * bar, 0.06, sd).setPosition(0, -hh - bar - 0.03, sd / 2);
        sillMats.push(m.multiplyMatrices(basis, local).clone());
        // Reveal: the shadowed top and left inner faces of the opening.
        local.makeScale(s.width, 0.16, 1).setPosition(0, hh - 0.08, 0.006);
        revealMats.push(m.multiplyMatrices(basis, local).clone());
        local.makeScale(0.12, s.height - 0.16, 1).setPosition(-hw + 0.06, -0.08, 0.006);
        revealMats.push(m.multiplyMatrices(basis, local).clone());
      } else {
        local.makeScale(s.width + 4 * bar, bar * 1.1, depth * 2.2).setPosition(0, -hh - bar * 1.5, depth * 1.1);
        sillMats.push(m.multiplyMatrices(basis, local).clone());
      }
    }
    const unit = new BoxGeometry(1, 1, 1);
    const instanced = (mats: Matrix4[], material: ReturnType<typeof toon>) => {
      const im = new InstancedMesh(unit, material, mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true;
      im.layers.enable(EDGE_LAYER);
      im.frustumCulled = false;
      group.add(im);
      return im;
    };
    if (barMats.length) instanced(barMats, toon(style.frame, { look: style.look, fog }));
    if (sillMats.length) instanced(sillMats, toon(style.sill, { look: style.look, fog }));
    const paneGeo = new PlaneGeometry(1, 1);
    if (flush && revealMats.length) {
      const im = new InstancedMesh(paneGeo, new MeshBasicMaterial({ color: new Color(flush.reveal), fog }), revealMats.length);
      revealMats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      group.add(im);
    }
    for (const kind of kinds) {
      const list = paneSpecs.get(kind) ?? [];
      if (!list.length) continue;
      const mat = new MeshBasicMaterial({ map: paneTexture(kind), fog });
      const im = new InstancedMesh(paneGeo, mat, list.length);
      const col = new Color();
      list.forEach((s, i) => {
        right.crossVectors(up, s.normal).normalize();
        basis.makeBasis(right, up, s.normal).setPosition(s.position);
        // Recessed: the pane sits just off the wall, well behind the frame's front.
        local.makeScale(s.width, s.height, 1).setPosition(0, 0, flush ? 0.003 : 0.015);
        im.setMatrixAt(i, m.multiplyMatrices(basis, local));
        im.setColorAt(i, col.set(s.tone));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.layers.enable(EDGE_LAYER);
      im.frustumCulled = false;
      group.add(im);
    }
    return group;
  }
}
