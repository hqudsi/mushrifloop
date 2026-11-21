/**
 * A kit of small city props, cel-shaded, for the ink edge pass (every part is put on EDGE_LAYER):
 * air conditioners, pipes and ducts, TV antennas, small water tanks, signs and boards with abstract
 * shapes only (never text), laundry lines with cloth, plant pots, vents and railings.
 *
 * Usage: `const kit = makePropKit(look, colours)`, call the builders (each adds to `kit.group` and
 * returns the part's group), then `kit.finish()` merges all static parts per material into a few
 * meshes, so a dense clutter costs only a handful of draw calls.
 */

import {
  type BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  type MeshToonMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EDGE_LAYER } from './edges';
import { rng } from './random';
import { type ToonLook, toon } from './toon';

export interface PropColours {
  metal: string;
  metalDark: string;
  ac: string;
  pipe: string;
  tank: string;
  pot: string;
  leaf: string;
  leafDark: string;
  cloth: string[];
  sign: string[];
  board: string;
  /** Utility pole wood (defaults to metal). */
  pole?: string;
}

export interface PropKit {
  group: Group;
  acUnit(p: Vector3, rotY?: number, scale?: number): Group;
  pipe(points: Vector3[], radius?: number, colour?: string): Group;
  duct(from: Vector3, to: Vector3, size?: number): Group;
  antenna(p: Vector3, height?: number, seed?: number): Group;
  smallTank(p: Vector3, radius?: number, height?: number): Group;
  sign(p: Vector3, w: number, h: number, seed: number, rotY?: number, pole?: number): Group;
  laundry(a: Vector3, b: Vector3, seed: number, sag?: number, postHeight?: number, lineRadius?: number): Group;
  plantPot(p: Vector3, seed: number, scale?: number): Group;
  vent(p: Vector3, seed: number): Group;
  railing(from: Vector3, to: Vector3, height?: number): Group;
  /** A bicycle standing on the ground at `p`, its length along `rotY`. */
  bicycle(p: Vector3, rotY: number, seed: number): Group;
  /**
   * A wooden utility pole with two crossarms (along z) and insulators, optionally a transformer drum;
   * returns the insulator tops, for wires.
   */
  utilityPole(p: Vector3, height: number, transformer: boolean): Vector3[];
  /** Merge everything added so far per material (static from here on). */
  finish(opts?: { castShadow?: boolean; receiveShadow?: boolean }): Group;
}

/** Abstract sign artwork: circles, bars and triangles on a coloured board, never letters. */
function signTexture(seed: number, colours: string[]): CanvasTexture {
  const r = rng(seed);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.fillStyle = r.pick(colours);
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,248,236,0.85)';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 112, 112);
  const n = r.int(2, 4);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i === 0 ? 'rgba(255,248,236,0.92)' : r.pick(colours);
    const kind = r.int(0, 2);
    const x = r.range(30, 98);
    const y = r.range(30, 98);
    const s = r.range(14, 30);
    ctx.beginPath();
    if (kind === 0) ctx.arc(x, y, s, 0, Math.PI * 2);
    else if (kind === 1) ctx.rect(x - s * 1.4, y - s * 0.35, s * 2.8, s * 0.7);
    else { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.8); ctx.lineTo(x - s, y + s * 0.8); ctx.closePath(); }
    ctx.fill();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export function makePropKit(look: ToonLook, colours: PropColours): PropKit {
  const group = new Group();
  const mats = new Map<string, MeshToonMaterial>();
  const mat = (colour: string, double = false): MeshToonMaterial => {
    const key = colour + (double ? '|d' : '');
    let m = mats.get(key);
    if (!m) {
      m = toon(colour, { look, side: double ? DoubleSide : undefined });
      mats.set(key, m);
    }
    return m;
  };
  const part = (g: Group, geo: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh => {
    const m = new Mesh(geo, material);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const root = (p: Vector3, rotY = 0, scale = 1): Group => {
    const g = new Group();
    g.position.copy(p);
    g.rotation.y = rotY;
    g.scale.setScalar(scale);
    group.add(g);
    return g;
  };
  /** A cylinder between two points. */
  const rod = (g: Group, a: Vector3, b: Vector3, radius: number, material: Material, sides = 8): Mesh => {
    const d = b.clone().sub(a);
    const m = new Mesh(new CylinderGeometry(radius, radius, d.length(), sides), material);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.normalize());
    g.add(m);
    return m;
  };

  const kit: PropKit = {
    group,
    acUnit(p, rotY = 0, scale = 1) {
      const g = root(p, rotY, scale);
      part(g, new BoxGeometry(0.85, 0.58, 0.32), mat(colours.ac), 0, 0.29, 0);
      // Fan grille (a dark disc with a hub) on the front, and a top lid line.
      const fan = part(g, new CylinderGeometry(0.2, 0.2, 0.03, 20), mat(colours.metalDark), 0.12, 0.3, 0.165);
      fan.rotation.x = Math.PI / 2;
      const hub = part(g, new CylinderGeometry(0.05, 0.05, 0.04, 10), mat(colours.ac), 0.12, 0.3, 0.18);
      hub.rotation.x = Math.PI / 2;
      for (let i = 0; i < 4; i++) part(g, new BoxGeometry(0.18, 0.02, 0.02), mat(colours.metalDark), -0.25, 0.14 + i * 0.1, 0.165);
      part(g, new BoxGeometry(0.06, 0.06, 0.4), mat(colours.metal), -0.36, 0.03, 0);
      part(g, new BoxGeometry(0.06, 0.06, 0.4), mat(colours.metal), 0.36, 0.03, 0);
      return g;
    },
    pipe(points, radius = 0.06, colour = colours.pipe) {
      const g = root(new Vector3());
      const m = mat(colour);
      for (let i = 0; i < points.length - 1; i++) rod(g, points[i], points[i + 1], radius, m);
      // Joints and clamps.
      for (const p of points) part(g, new SphereGeometry(radius * 1.25, 10, 8), m, p.x, p.y, p.z);
      return g;
    },
    duct(from, to, size = 0.35) {
      const g = root(new Vector3());
      const d = to.clone().sub(from);
      const len = d.length();
      const box = new Mesh(new BoxGeometry(size, size, len), mat(colours.metal));
      box.position.copy(from).add(to).multiplyScalar(0.5);
      box.lookAt(to.clone().add(box.position).sub(from));
      g.add(box);
      // Seam bands along it.
      for (let t = 0.2; t < 1; t += 0.3) {
        const band = new Mesh(new BoxGeometry(size * 1.12, size * 1.12, 0.05), mat(colours.metalDark));
        band.position.copy(from).lerp(to, t);
        band.quaternion.copy(box.quaternion);
        g.add(band);
      }
      return g;
    },
    antenna(p, height = 2.2, seed = 1) {
      const r = rng(seed);
      const g = root(p);
      const m = mat(colours.metalDark);
      part(g, new CylinderGeometry(0.025, 0.035, height, 6), m, 0, height / 2, 0);
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) {
        const len = 0.9 - i * 0.18;
        const bar = part(g, new BoxGeometry(len, 0.025, 0.025), m, 0, height * (0.62 + 0.12 * i), 0);
        bar.rotation.y = r.range(-0.3, 0.3);
        for (const s of [-1, 1]) {
          const el = part(g, new BoxGeometry(0.02, 0.02, 0.3), m, (s * len) / 2.4, height * (0.62 + 0.12 * i), 0);
          el.rotation.y = bar.rotation.y;
        }
      }
      if (r.next() < 0.5) {
        const dish = part(g, new SphereGeometry(0.22, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), mat(colours.ac, true), 0.15, height * 0.4, 0);
        dish.rotation.z = -1.2;
      }
      // Guy foot.
      part(g, new BoxGeometry(0.3, 0.06, 0.3), m, 0, 0.03, 0);
      return g;
    },
    smallTank(p, radius = 0.45, height = 0.8) {
      const g = root(p);
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) part(g, new BoxGeometry(0.06, 0.4, 0.06), mat(colours.metal), dx * radius * 0.6, 0.2, dz * radius * 0.6);
      part(g, new CylinderGeometry(radius, radius, height, 18), mat(colours.tank), 0, 0.4 + height / 2, 0);
      part(g, new CylinderGeometry(radius * 0.25, radius * 1.02, radius * 0.35, 18), mat(colours.metal), 0, 0.4 + height + radius * 0.17, 0);
      part(g, new CylinderGeometry(radius * 1.03, radius * 1.03, 0.05, 18), mat(colours.metal), 0, 0.4 + height * 0.5, 0);
      return g;
    },
    sign(p, w, h, seed, rotY = 0, pole = 0) {
      const g = root(p, rotY);
      const face = toon('#ffffff', { look });
      face.map = signTexture(seed, colours.sign);
      const boardMat = mat(colours.board);
      // Board: a frame box with the artwork on both large faces.
      const board = new Mesh(new BoxGeometry(w, h, 0.08), [boardMat, boardMat, boardMat, boardMat, face, face]);
      board.position.set(0, pole + h / 2, 0);
      g.add(board);
      if (pole > 0) for (const s of [-1, 1]) part(g, new BoxGeometry(0.06, pole, 0.06), mat(colours.metalDark), (s * w) / 3, pole / 2, 0);
      return g;
    },
    laundry(a, b, seed, sag = 0.18, postHeight = 1.5, lineRadius = 0.008) {
      const r = rng(seed);
      const g = root(new Vector3());
      const m = mat(colours.metalDark);
      // Two posts standing `postHeight` below the line ends, and a sagging line.
      for (const q of [a, b]) {
        part(g, new BoxGeometry(0.05, postHeight + 0.1, 0.05), mat(colours.metal), q.x, q.y - postHeight / 2 + 0.05, q.z);
      }
      const at = (t: number) => a.clone().lerp(b, t).add(new Vector3(0, -sag * 4 * t * (1 - t), 0));
      for (let i = 0; i < 8; i++) rod(g, at(i / 8), at((i + 1) / 8), lineRadius, m, 4);
      // Cloths: towels and shirts as thin boards, hanging still with a slight wind lean.
      const n = r.int(3, 6);
      const dir = b.clone().sub(a).normalize();
      for (let i = 0; i < n; i++) {
        const t = (i + 0.6) / (n + 0.2);
        const top = at(t);
        const cw = r.range(0.3, 0.55);
        const ch = r.range(0.35, 0.7);
        const cloth = new Mesh(new BoxGeometry(cw, ch, 0.015), mat(r.pick(colours.cloth), true));
        cloth.position.copy(top).add(new Vector3(0, -ch / 2, 0));
        cloth.rotation.y = Math.atan2(-dir.z, dir.x);
        cloth.rotateX(r.range(0.05, 0.2));
        g.add(cloth);
      }
      return g;
    },
    plantPot(p, seed, scale = 1) {
      const r = rng(seed);
      const g = root(p, 0, scale);
      part(g, new CylinderGeometry(0.2, 0.15, 0.3, 12), mat(colours.pot), 0, 0.15, 0);
      part(g, new CylinderGeometry(0.22, 0.22, 0.05, 12), mat(colours.pot), 0, 0.3, 0);
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) {
        const leaf = part(g, new SphereGeometry(0.16, 10, 8), mat(i % 2 ? colours.leaf : colours.leafDark), r.range(-0.12, 0.12), 0.4 + r.range(0, 0.25), r.range(-0.12, 0.12));
        leaf.scale.set(r.range(0.8, 1.2), r.range(0.9, 1.5), r.range(0.8, 1.2));
      }
      return g;
    },
    vent(p, seed) {
      const r = rng(seed);
      const g = root(p);
      if (r.next() < 0.5) {
        // Mushroom vent.
        part(g, new CylinderGeometry(0.12, 0.12, 0.5, 12), mat(colours.metal), 0, 0.25, 0);
        part(g, new CylinderGeometry(0.06, 0.24, 0.12, 12), mat(colours.metalDark), 0, 0.56, 0);
      } else {
        // Louvred box.
        part(g, new BoxGeometry(0.6, 0.45, 0.45), mat(colours.metal), 0, 0.225, 0);
        for (let i = 0; i < 4; i++) part(g, new BoxGeometry(0.5, 0.03, 0.02), mat(colours.metalDark), 0, 0.1 + i * 0.09, 0.235);
      }
      return g;
    },
    bicycle(p, rotY, seed) {
      const r = rng(seed);
      const g = root(p, rotY);
      const frame = mat(r.pick(colours.cloth));
      const dark = mat(colours.metalDark);
      for (const x of [-0.52, 0.52]) {
        const wheel = part(g, new TorusGeometry(0.33, 0.025, 6, 20), dark, x, 0.34, 0);
        wheel.rotation.y = 0;
      }
      const hub = (x: number) => new Vector3(x, 0.34, 0);
      const seat = new Vector3(-0.15, 0.85, 0);
      const head = new Vector3(0.38, 0.92, 0);
      const crank = new Vector3(0, 0.34, 0);
      rod(g, hub(-0.52), seat, 0.02, frame, 6);
      rod(g, hub(-0.52), crank, 0.02, frame, 6);
      rod(g, crank, seat, 0.022, frame, 6);
      rod(g, crank, head, 0.022, frame, 6);
      rod(g, seat.clone().add(new Vector3(0.02, -0.08, 0)), head.clone().add(new Vector3(0, -0.06, 0)), 0.02, frame, 6);
      rod(g, head, hub(0.52), 0.02, frame, 6);
      part(g, new BoxGeometry(0.22, 0.05, 0.1), dark, -0.17, 0.9, 0);
      rod(g, head.clone().add(new Vector3(0, 0.06, -0.25)), head.clone().add(new Vector3(0, 0.06, 0.25)), 0.018, dark, 6);
      return g;
    },
    utilityPole(p, height, transformer) {
      const g = root(p);
      const wood = mat(colours.pole ?? colours.metal);
      const dark = mat(colours.metalDark);
      part(g, new CylinderGeometry(0.11, 0.16, height, 10), wood, 0, height / 2, 0);
      const tops: Vector3[] = [];
      for (const [dy, len] of [[-0.35, 2.2], [-1.1, 1.6]] as const) {
        part(g, new BoxGeometry(0.12, 0.12, len), wood, 0, height + dy, 0);
        for (const s of [-0.42, 0, 0.42]) {
          const z = s * len;
          part(g, new CylinderGeometry(0.045, 0.045, 0.16, 6), mat(colours.ac), 0, height + dy + 0.13, z);
          tops.push(new Vector3(p.x, p.y + height + dy + 0.22, p.z + z));
        }
        // Braces.
        rod(g, new Vector3(0, height + dy - 0.5, 0), new Vector3(0, height + dy, len * 0.35), 0.02, dark, 4);
      }
      if (transformer) {
        part(g, new CylinderGeometry(0.28, 0.28, 0.75, 14), mat(colours.tank), 0, height - 2.4, 0.38);
        part(g, new CylinderGeometry(0.3, 0.3, 0.06, 14), dark, 0, height - 2.0, 0.38);
        part(g, new BoxGeometry(0.06, 0.4, 0.5), dark, 0, height - 2.4, 0.12);
      }
      // Step bolts.
      for (let y = 2.2; y < height - 1.5; y += 0.45) part(g, new BoxGeometry(0.22, 0.03, 0.03), dark, 0, y, 0);
      return tops;
    },
    railing(from, to, height = 1.0) {
      const g = root(new Vector3());
      const m = mat(colours.metal);
      const d = to.clone().sub(from);
      const n = Math.max(1, Math.round(d.length() / 1.1));
      for (let i = 0; i <= n; i++) {
        const q = from.clone().lerp(to, i / n);
        part(g, new BoxGeometry(0.04, height, 0.04), m, q.x, q.y + height / 2, q.z);
      }
      const up = new Vector3(0, height, 0);
      rod(g, from.clone().add(up), to.clone().add(up), 0.03, m, 6);
      rod(g, from.clone().add(up.clone().multiplyScalar(0.5)), to.clone().add(up.clone().multiplyScalar(0.5)), 0.02, m, 6);
      return g;
    },
    finish(opts = {}) {
      group.updateMatrixWorld(true);
      const buckets = new Map<Material, BufferGeometry[]>();
      const multi: Mesh[] = [];
      group.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        if (Array.isArray(mesh.material)) {
          multi.push(mesh);
          return;
        }
        const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        geo.applyMatrix4(mesh.matrixWorld);
        for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
        const list = buckets.get(mesh.material) ?? [];
        list.push(geo);
        buckets.set(mesh.material, list);
      });
      const out = new Group();
      for (const [material, geos] of buckets) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        const m = new Mesh(merged, material);
        m.castShadow = !!opts.castShadow;
        m.receiveShadow = !!opts.receiveShadow;
        m.layers.enable(EDGE_LAYER);
        out.add(m);
      }
      // Multi-material parts (signs) stay as they are, re-parented with their world transform.
      for (const mesh of multi) {
        const copy = new Mesh(mesh.geometry, mesh.material);
        mesh.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
        copy.castShadow = !!opts.castShadow;
        copy.receiveShadow = !!opts.receiveShadow;
        copy.layers.enable(EDGE_LAYER);
        out.add(copy);
      }
      group.clear();
      return out;
    },
  };
  return kit;
}
