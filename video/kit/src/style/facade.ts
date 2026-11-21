/**
 * Buildings that read as drawn from the first pass: a painted wall, a roof slab with a parapet, and a
 * grid of real windows (frames, sills, lit, curtained, blinded and dark panes) chosen from a seed.
 *
 *   const windows = new WindowBuilder();
 *   scene.add(makeBuilding({ x: 0, z: -12, width: 9, depth: 7, height: 16, color: '#d98f6a', look, seed: 3, windows }));
 *   scene.add(windows.build({ frame: '#f1e2cf', sill: '#c9a98f', look }));   // once, after every building
 *
 * A plain box in one flat colour is not a building. Use this, or build the same parts yourself.
 */

import { BoxGeometry, type CanvasTexture, Group, Mesh, Vector3 } from 'three';

import { inkEdges } from './edges';
import { type WallPaintOptions, paintedConcreteTexture, paintedWallTexture, wallUVs } from './paint';
import { rng } from './random';
import { type ToonLook, toon } from './toon';
import { type PaneKind, type WindowBuilder } from './windows';

export interface FacadeOptions {
  /** Centre of the wall's base line, on the wall surface. */
  origin: Vector3;
  /** Outward wall normal (horizontal, along x or z). */
  normal: Vector3;
  width: number;
  height: number;
  seed: number;
  /** Window size in metres (defaults 1.1 × 1.5). */
  windowWidth?: number;
  windowHeight?: number;
  /** Distance between window centres (defaults 2.4 across, 3.1 up). */
  colStep?: number;
  rowStep?: number;
  /** Height of the first row's centre above the base (default 2.2). */
  firstRow?: number;
  /** Share of windows that are lit, 0–1 (default 0.45). At night use more, by day fewer. */
  lit?: number;
  /** Light colours of lit panes; one is picked per window. */
  litTones?: string[];
  /** Glass colour of dark panes. */
  darkTone?: string;
}

/** Adds a seeded grid of windows for one wall to `builder`. Returns how many it added. */
export function addFacadeWindows(builder: WindowBuilder, o: FacadeOptions): number {
  const r = rng(o.seed);
  const ww = o.windowWidth ?? 1.1;
  const wh = o.windowHeight ?? 1.5;
  const colStep = o.colStep ?? 2.4;
  const rowStep = o.rowStep ?? 3.1;
  const firstRow = o.firstRow ?? 2.2;
  const cols = Math.max(1, Math.floor((o.width - 1.2) / colStep) + 1);
  const rows = Math.max(0, Math.floor((o.height - firstRow - wh / 2 - 0.9) / rowStep) + 1);
  const litTones = o.litTones ?? ['#ffd98a', '#ffc46b', '#ffe7b0', '#ffb08a'];
  const darkTone = o.darkTone ?? '#3b4f7a';
  const litShare = o.lit ?? 0.45;
  const normal = o.normal.clone().normalize();
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), normal).normalize();
  const litKinds: PaneKind[] = ['lit', 'curtain', 'curtain', 'blind', 'lamp'];
  let added = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lit = r.next() < litShare;
      const kind = lit ? r.pick(litKinds) : 'dark';
      const tone = lit ? r.pick(litTones) : darkTone;
      const mullions = r.next() < 0.5;
      const across = (col - (cols - 1) / 2) * colStep;
      builder.add({
        position: o.origin.clone().addScaledVector(right, across).add(new Vector3(0, firstRow + row * rowStep, 0)),
        normal,
        width: ww,
        height: wh,
        kind,
        tone,
        mullions,
      });
      added += 1;
    }
  }
  return added;
}

// Painting a texture takes a few tens of milliseconds, and a street has dozens of buildings. Buildings
// share paintings: six wall paintings per wall layout and four roofs are enough that no two neighbours
// look alike, and the page is ready in a fraction of the time.
const WALL_VARIANTS = 6;
const ROOF_VARIANTS = 4;
const wallCache = new Map<string, CanvasTexture>();
const roofCache = new Map<number, CanvasTexture>();

function cachedWall(seed: number, options: WallPaintOptions): CanvasTexture {
  const variant = ((seed % WALL_VARIANTS) + WALL_VARIANTS) % WALL_VARIANTS;
  const key = `${variant}|${JSON.stringify(options)}`;
  let texture = wallCache.get(key);
  if (!texture) {
    texture = paintedWallTexture(1000 + variant, options);
    wallCache.set(key, texture);
  }
  return texture;
}

function cachedRoof(seed: number): CanvasTexture {
  const variant = ((seed % ROOF_VARIANTS) + ROOF_VARIANTS) % ROOF_VARIANTS;
  let texture = roofCache.get(variant);
  if (!texture) {
    texture = paintedConcreteTexture(2000 + variant);
    roofCache.set(variant, texture);
  }
  return texture;
}

export type BuildingFace = 'front' | 'back' | 'left' | 'right';

export interface BuildingOptions {
  /** Centre of the footprint, and the ground height (default 0). */
  x: number;
  z: number;
  baseY?: number;
  width: number;
  depth: number;
  height: number;
  /** Wall colour. The painted texture multiplies it: stains, streaks, seams, a darker base. */
  color: string;
  /** Roof slab and parapet colour (default: the wall colour). */
  roofColor?: string;
  look: ToonLook;
  seed: number;
  /** Windows are added to this builder; build it once after all buildings. Leave out for a far block. */
  windows?: WindowBuilder;
  /** The faces that get windows (default: front and right; front faces +z, right faces +x). */
  faces?: BuildingFace[];
  /** Passed on to the window grid. */
  facade?: Partial<Omit<FacadeOptions, 'origin' | 'normal' | 'width' | 'height' | 'seed'>>;
  /** Parapet height in metres (default 0.6; 0 for none). */
  parapet?: number;
  fog?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** A painted block with a roof slab, a parapet and windows. Everything is on the ink edge layer. */
export function makeBuilding(o: BuildingOptions): Group {
  const group = new Group();
  const baseY = o.baseY ?? 0;
  const fog = o.fog ?? true;
  const rowStep = o.facade?.rowStep ?? 3.1;
  const colStep = o.facade?.colStep ?? 2.4;
  const firstRow = o.facade?.firstRow ?? 2.2;
  const wh = o.facade?.windowHeight ?? 1.5;

  // Walls: the painted band runs once from the base to the top; the texture repeats along the wall.
  // The streaks in the texture run down from the sills of the window grid. The texture always has its
  // first column half a step from its left edge, and the wall's UVs are shifted so that column falls
  // under the wall's first window: buildings of the same height can then share one painting.
  const band = Math.round(o.height * 2) / 2;
  const rows = Math.max(0, Math.floor((o.height - firstRow - wh / 2 - 0.9) / rowStep) + 1);
  const wallMap = cachedWall(o.seed, {
    tile: colStep * 5,
    band,
    panelsX: 5,
    panelsY: Math.max(2, Math.round(o.height / rowStep)),
    windows: o.windows && rows > 0 ? { col0: colStep / 2, colStep, row0: band - firstRow - (rows - 1) * rowStep, rowStep, height: wh } : undefined,
  });
  const firstColumn = (wallWidth: number) => -((Math.max(1, Math.floor((wallWidth - 1.2) / colStep) + 1) - 1) / 2) * colStep;
  const body = new BoxGeometry(o.width, o.height, o.depth);
  const centre = { x: o.x, y: baseY + o.height / 2, z: o.z };
  wallUVs(body, centre, { tile: colStep * 5, bottom: baseY, band: o.height, uOrigin: o.x + firstColumn(o.width) - colStep / 2, sideOrigin: o.z + firstColumn(o.depth) - colStep / 2 });
  const walls = new Mesh(body, toon(o.color, { look: o.look, map: wallMap, fog }));
  walls.position.set(centre.x, centre.y, centre.z);
  group.add(walls);

  // Roof: a slab that overhangs a little, and a parapet round it.
  const roofColor = o.roofColor ?? o.color;
  const roofMat = toon(roofColor, { look: o.look, map: cachedRoof(o.seed), fog });
  const slabGeo = new BoxGeometry(o.width + 0.3, 0.25, o.depth + 0.3);
  const slabCentre = { x: o.x, y: baseY + o.height + 0.125, z: o.z };
  wallUVs(slabGeo, slabCentre, { tile: 6, bottom: slabCentre.y - 0.125, band: 0.25, topTile: 6 });
  const slab = new Mesh(slabGeo, roofMat);
  slab.position.set(slabCentre.x, slabCentre.y, slabCentre.z);
  group.add(slab);
  const parapet = o.parapet ?? 0.6;
  if (parapet > 0) {
    const t = 0.22;
    const y = baseY + o.height + 0.25 + parapet / 2;
    const plain = toon(roofColor, { look: o.look, fog });
    const sides: [number, number, number, number][] = [
      [o.x, o.z + o.depth / 2 - t / 2 + 0.15, o.width + 0.3, t],
      [o.x, o.z - o.depth / 2 + t / 2 - 0.15, o.width + 0.3, t],
      [o.x + o.width / 2 - t / 2 + 0.15, o.z, t, o.depth + 0.3 - 2 * t],
      [o.x - o.width / 2 + t / 2 - 0.15, o.z, t, o.depth + 0.3 - 2 * t],
    ];
    for (const [px, pz, sx, sz] of sides) {
      const m = new Mesh(new BoxGeometry(sx, parapet, sz), plain);
      m.position.set(px, y, pz);
      group.add(m);
    }
  }

  if (o.windows) {
    const faces = o.faces ?? ['front', 'right'];
    const eps = 0.001;
    const defs: Record<BuildingFace, { origin: Vector3; normal: Vector3; width: number }> = {
      front: { origin: new Vector3(o.x, baseY, o.z + o.depth / 2 + eps), normal: new Vector3(0, 0, 1), width: o.width },
      back: { origin: new Vector3(o.x, baseY, o.z - o.depth / 2 - eps), normal: new Vector3(0, 0, -1), width: o.width },
      right: { origin: new Vector3(o.x + o.width / 2 + eps, baseY, o.z), normal: new Vector3(1, 0, 0), width: o.depth },
      left: { origin: new Vector3(o.x - o.width / 2 - eps, baseY, o.z), normal: new Vector3(-1, 0, 0), width: o.depth },
    };
    faces.forEach((face, i) => {
      addFacadeWindows(o.windows as WindowBuilder, { ...o.facade, ...defs[face], height: o.height, seed: o.seed * 31 + i * 7 + 1 });
    });
  }

  group.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = !!o.castShadow;
    mesh.receiveShadow = !!o.receiveShadow;
  });
  inkEdges(group);
  return group;
}
