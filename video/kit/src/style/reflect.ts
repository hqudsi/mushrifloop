/**
 * Reflections on wet ground that keep the shape of what they reflect.
 *
 * A soft glow disc under a sign reads as a blurry blob. A drawn wet street shows the sign itself,
 * upside down, starting on the ground under it, pulled long towards the viewer and cut into dashes by
 * the unevenness of the ground.
 * `makeReflection` does that for any mesh: it draws the mesh's own geometry mirrored in the ground
 * plane, stretched, in the mesh's colour (or its texture), and breaks it with a seeded ripple mask.
 *
 * How it stays correct in depth: each mirrored vertex is moved along the camera's line of sight to
 * the point where that line meets the ground. On screen it is exactly where the mirror image would
 * be, but it lies on the ground, so a car or a post standing in front of it hides it as it should.
 *
 *   const sign = new Mesh(new PlaneGeometry(2, 0.8), new MeshBasicMaterial({ color: '#ff3d9a' }));
 *   scene.add(sign);
 *   scene.add(makeReflection(sign, { groundY: 0, color: '#ff3d9a', ripple: rippleTexture(7) }));
 *
 * The reflection follows the source: add it to the scene after the source is placed, and if the
 * source moves, call `reflection.userData.sync()` in `renderFrame`. The camera must be above the
 * ground.
 */

import { AdditiveBlending, Box3, CanvasTexture, Color, DoubleSide, LinearFilter, Mesh, RepeatWrapping, ShaderMaterial, type Texture, Vector2 } from 'three';

import { paintCanvas } from './paint';
import { rng } from './random';

export interface ReflectionOptions {
  /** World height of the wet ground. */
  groundY: number;
  /** Colour of the reflection (the source's light colour). */
  color: string;
  /** The source's texture, when its shape is in the texture (a sign's artwork). */
  map?: Texture;
  /** A mask from `rippleTexture`; shared between reflections of one street. */
  ripple: Texture;
  /** How much longer than the object its reflection is drawn (default 3; 1 = as long as the object). */
  stretch?: number;
  /**
   * Where the reflection starts. 1 (the default): on the ground straight under the object, the way wet
   * streets are drawn; it then shows from any camera height. 0: where a true mirror puts it, which for
   * a sign high on a wall and a camera near the street is below the bottom of the frame. Use 0 for
   * still water seen from above.
   */
  drop?: number;
  /** Brightness (default 0.9). */
  strength?: number;
  /** How much the far end of the reflection (the image of the object's top) fades, 0–1 (default 0.85). */
  fade?: number;
  /** Metres of mirror image covered by one repeat of the ripple mask, across and along (default 7 and 7). */
  rippleSize?: [number, number];
  /** Sideways wobble of the dashes in metres (default 0.04). */
  wobble?: number;
}

/**
 * The mask that breaks a reflection: horizontal dashes of uneven length with gaps between them,
 * denser near the top (close under the object) and sparser further down. Red: how much shows;
 * green: a sideways offset for that dash. Tiles both ways.
 */
export function rippleTexture(seed: number): CanvasTexture {
  const w = 256;
  const h = 256;
  const [c, ctx] = paintCanvas(w, h);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(0, 128, 0)';
  ctx.fillRect(0, 0, w, h);
  const rows = 44;
  const rh = h / rows;
  for (let j = 0; j < rows; j++) {
    const offset = Math.round(128 + r.signed() * 110);
    let x = r.range(0, 40);
    // Each row: dashes with gaps. A third of the rows are mostly gap, which gives the broken look.
    const sparse = r.next() < 0.34;
    while (x < w) {
      const len = sparse ? r.range(6, 26) : r.range(28, 110);
      const gap = sparse ? r.range(22, 70) : r.range(4, 22);
      const level = Math.round(255 * r.range(0.55, 1));
      ctx.fillStyle = `rgb(${level}, ${offset}, 0)`;
      const y = Math.round(j * rh);
      const hh = Math.max(2, Math.round(rh * r.range(0.55, 0.95)));
      ctx.fillRect(Math.round(x), y, Math.round(len), hh);
      if (x + len > w) ctx.fillRect(Math.round(x - w), y, Math.round(len), hh);
      x += len + gap;
    }
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const vertex = /* glsl */ `
  uniform float groundY, stretch, drop;
  uniform vec2 span;
  varying vec2 vUv;
  varying float vBelow;
  varying float vAlong;
  varying vec3 vGround;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    // Mirror in the ground plane. With drop = 0 the image of the object's lowest point is where a true
    // mirror puts it; with drop = 1 the object is mirrored as if it stood on the ground, so the image
    // starts at the foot of the wall under it. From there the image is pulled long, towards the viewer.
    float base = max(span.x - groundY, 0.0) * (1.0 - drop);
    float below = base + max(world.y - span.x, 0.0) * stretch;
    vec3 mirrored = vec3(world.x, groundY - below, world.z);
    // Slide along the line of sight up to the ground: same place on screen, lying on the ground.
    vec3 eye = cameraPosition;
    float t = (eye.y - groundY) / max(eye.y - mirrored.y, 1e-4);
    vec3 onGround = eye + (mirrored - eye) * t;
    onGround.y = groundY + 0.004;
    vBelow = below;
    // 0 at the image of the object's lowest point, 1 at the image of its top.
    vAlong = clamp((world.y - span.x) / max(span.y - span.x, 1e-3), 0.0, 1.0);
    vGround = vec3(mirrored.x, below, mirrored.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(onGround, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength, fade, wobble, useMap;
  uniform vec2 rippleSize;
  uniform sampler2D ripple, map;
  varying vec2 vUv;
  varying float vBelow;
  varying float vAlong;
  varying vec3 vGround;
  void main() {
    // The mask is laid over the mirror image: across it, and down it.
    float across = vGround.x + vGround.z;
    vec2 q = vec2(across / rippleSize.x, vBelow / rippleSize.y);
    vec4 dash = texture2D(ripple, q);
    // Each dash is shifted sideways a little: the edges of the shape wobble.
    vec4 shifted = texture2D(ripple, q + vec2((dash.g - 0.5) * wobble / rippleSize.x, 0.0));
    float show = shifted.r;
    // Close under the object the reflection is nearly whole; further down the gaps take over.
    show = mix(max(show, 0.75), show * show, smoothstep(0.0, 0.5, vAlong));
    float falloff = 1.0 - fade * vAlong * vAlong;
    vec3 col = color;
    float a = 1.0;
    if (useMap > 0.5) { vec4 m = texture2D(map, vUv); col *= m.rgb; a = m.a; }
    gl_FragColor = vec4(col * strength * show * falloff * a, 1.0);
  }
`;

/**
 * A reflection of `source` on the ground. Returns a mesh to add to the scene (not to the source: it
 * has to follow the source's world position, not inherit a transform twice).
 */
export function makeReflection(source: Mesh, o: ReflectionOptions): Mesh {
  const material = new ShaderMaterial({
    uniforms: {
      groundY: { value: o.groundY },
      stretch: { value: o.stretch ?? 3 },
      drop: { value: Math.max(0, Math.min(1, o.drop ?? 1)) },
      color: { value: new Color(o.color) },
      strength: { value: o.strength ?? 0.9 },
      fade: { value: o.fade ?? 0.85 },
      span: { value: new Vector2(0, 1) },
      wobble: { value: o.wobble ?? 0.04 },
      rippleSize: { value: new Vector2(...(o.rippleSize ?? [7, 7])) },
      ripple: { value: o.ripple },
      map: { value: o.map ?? null },
      useMap: { value: o.map ? 1 : 0 },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: false,
  });
  const mesh = new Mesh(source.geometry, material);
  // The vertices are moved in the shader, so the geometry's own bounds say nothing about where it is drawn.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3;
  const box = new Box3();
  const sync = () => {
    source.updateWorldMatrix(true, false);
    mesh.matrix.copy(source.matrixWorld);
    mesh.matrixWorld.copy(source.matrixWorld);
    mesh.visible = source.visible;
    // The object's lowest and highest point in the world: the reflection fades from one to the other.
    box.setFromObject(source);
    (material.uniforms.span.value as Vector2).set(box.min.y, box.max.y);
  };
  mesh.userData.sync = sync;
  sync();
  return mesh;
}
