/**
 * Ink outlines by the inverted-hull method: a copy of the mesh, drawn back faces only, pushed out in
 * screen space by a fixed number of pixels, in a dark tinted colour (never pure black).
 *
 * Solids use smoothed normals (so hard-edged boxes do not split at the corners). Flat shapes such as
 * the paper plane use `mode: 'flat'`: every triangle is grown outward from its own centre on screen and
 * drawn just behind the original, so only the silhouette shows.
 */

import { BackSide, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector2 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const RESOLUTION = new Vector2(1920, 1080);

export function setOutlineResolution(width: number, height: number): void {
  RESOLUTION.set(width, height);
}

const vertexSolid = /* glsl */ `
  uniform float thickness;
  uniform vec2 resolution;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vec4 cn = projectionMatrix * vec4(n, 0.0);
    vec2 d = cn.xy;
    float len = length(d);
    d = len > 1e-5 ? d / len : vec2(0.0);
    clip.xy += d * thickness * 2.0 / resolution * clip.w;
    gl_Position = clip;
  }
`;

const vertexFlat = /* glsl */ `
  uniform float thickness;
  uniform vec2 resolution;
  attribute vec3 triA;
  attribute vec3 triB;
  vec2 screen(vec3 p) {
    vec4 c = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    return c.xy / c.w * resolution * 0.5;
  }
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec2 sv = clip.xy / clip.w * resolution * 0.5;
    vec2 ea = sv - screen(triA);
    vec2 eb = sv - screen(triB);
    float la = length(ea);
    float lb = length(eb);
    vec2 d = vec2(0.0);
    if (la > 1e-4 && lb > 1e-4) {
      ea /= la;
      eb /= lb;
      // Miter: push the corner out along the bisector so both edges move out by "thickness" pixels.
      vec2 m = ea + eb;
      float ml = length(m);
      if (ml > 1e-4) {
        m /= ml;
        float s = abs(ea.x * m.y - ea.y * m.x);
        d = m / max(s, 0.4);
      }
    }
    clip.xy += d * thickness * 2.0 / resolution * clip.w;
    gl_Position = clip;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 color;
  void main() { gl_FragColor = vec4(color, 1.0); }
`;

export interface OutlineOptions {
  /** Line width in pixels at 1080p. */
  px?: number;
  mode?: 'solid' | 'flat';
}

export function outlineMaterial(color: string, opts: OutlineOptions = {}): ShaderMaterial {
  const flat = opts.mode === 'flat';
  return new ShaderMaterial({
    uniforms: {
      color: { value: new Color(color) },
      thickness: { value: opts.px ?? 1.6 },
      resolution: { value: RESOLUTION },
    },
    vertexShader: flat ? vertexFlat : vertexSolid,
    fragmentShader: fragment,
    side: flat ? DoubleSide : BackSide,
    polygonOffset: flat,
    polygonOffsetFactor: flat ? 2 : 0,
    polygonOffsetUnits: flat ? 4 : 0,
  });
}

const solidCache = new WeakMap<BufferGeometry, BufferGeometry>();

/** A geometry with merged vertices and smooth normals, for the hull. */
function hullGeometry(geometry: BufferGeometry): BufferGeometry {
  const cached = solidCache.get(geometry);
  if (cached) return cached;
  const g = geometry.clone();
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const merged = mergeVertices(g, 1e-4);
  merged.computeVertexNormals();
  solidCache.set(geometry, merged);
  return merged;
}

/**
 * For the flat mode: each vertex also carries the other two corners of its triangle, so the shader
 * can grow the triangle by a constant number of pixels on every edge (geometry becomes non-indexed).
 */
export function withTriangleCorners(geometry: BufferGeometry): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = g.getAttribute('position');
  const a = new Float32Array(pos.count * 3);
  const b = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      const ia = i + ((k + 1) % 3);
      const ib = i + ((k + 2) % 3);
      a.set([pos.getX(ia), pos.getY(ia), pos.getZ(ia)], (i + k) * 3);
      b.set([pos.getX(ib), pos.getY(ib), pos.getZ(ib)], (i + k) * 3);
    }
  }
  g.setAttribute('triA', new BufferAttribute(a, 3));
  g.setAttribute('triB', new BufferAttribute(b, 3));
  return g;
}

/** Adds an outline child to `mesh` and returns it. */
export function addOutline(mesh: Mesh, material: ShaderMaterial): Mesh {
  const flat = material.side === DoubleSide;
  const geometry = flat ? withTriangleCorners(mesh.geometry) : hullGeometry(mesh.geometry);
  const hull = new Mesh(geometry, material);
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.renderOrder = mesh.renderOrder;
  hull.userData.hull = true;
  mesh.add(hull);
  return hull;
}
