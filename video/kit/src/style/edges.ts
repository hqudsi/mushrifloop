/**
 * Screen-space ink edges. A second render of the scene, limited to the objects on EDGE_LAYER, writes
 * view-space normals and depth; a full-screen pass then finds depth jumps and normal creases and draws
 * a thin line (about 1–1.5 px at 1080p) in a per-shot tint. Lines fade with distance (lighter and more
 * transparent on far geometry), which keeps the depth of the picture.
 *
 * Only what a shot puts on EDGE_LAYER takes part: opaque geometry (buildings, props, the plane). Sky,
 * clouds, glows, shafts and particles stay on layer 0 only and never produce edges.
 *
 * The pass is opt-in: it is disabled unless the active shot provides `edges` settings.
 */

import {
  Color,
  DepthTexture,
  DoubleSide,
  MeshNormalMaterial,
  NearestFilter,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

/** The layer that feeds the edge pass. */
export const EDGE_LAYER = 1;
/**
 * Occluders: soft or transparent things drawn in front of inked geometry (steam, smoke) that must hide
 * the lines behind them. They render with their own materials into a mask, depth-tested against the
 * edge geometry; lines are removed where the mask covers them. Opt-in per shot (`occluders: true`).
 */
export const OCCLUDE_LAYER = 2;

export interface EdgeSettings {
  /** Near line colour (a deep tint, never pure black). */
  color: string;
  /** Colour the lines take with distance. */
  farColor: string;
  /** View distance where fading starts and where it is complete. */
  fadeNear: number;
  fadeFar: number;
  /** Line opacity left at fadeFar (0–1). */
  farOpacity: number;
  /** Line opacity up close (0–1). */
  opacity?: number;
  /** Relative depth jump that makes a line (fraction of the distance). */
  depthThreshold?: number;
  /** Normal difference (1 - cos) that makes a crease line. */
  normalThreshold?: number;
  /**
   * 1 (the default): each line has a faint shoulder, like a soft pencil, and no stair-steps. 0: crisp
   * one-pixel lines. Soft lines also make a video file a quarter smaller (README.md, "File size").
   */
  soften?: number;
  /** Hide lines behind objects on OCCLUDE_LAYER. */
  occluders?: boolean;
}

/** Puts `obj` and all its meshes (not outline hulls) on the edge layer, keeping layer 0. */
export function inkEdges(obj: Object3D): void {
  obj.traverse((o) => {
    if ((o as { userData: { hull?: boolean } }).userData.hull) return;
    o.layers.enable(EDGE_LAYER);
  });
}

const EdgeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new Vector2(1920, 1080) },
    near: { value: 0.1 },
    far: { value: 1000 },
    color: { value: new Color() },
    farColor: { value: new Color() },
    fadeNear: { value: 20 },
    fadeFar: { value: 200 },
    farOpacity: { value: 0.3 },
    opacity: { value: 1 },
    depthThreshold: { value: 0.035 },
    normalThreshold: { value: 0.25 },
    soften: { value: 1 },
    tMask: { value: null },
    useMask: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse, tNormal, tDepth, tMask;
    uniform float useMask;
    uniform vec2 resolution;
    uniform float near, far, fadeNear, fadeFar, farOpacity, opacity, depthThreshold, normalThreshold, soften;
    uniform vec3 color, farColor;
    varying vec2 vUv;
    float viewZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return d >= 1.0 ? far : -perspectiveDepthToViewZ(d, near, far);
    }
    vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    // How much of a line this pixel is: 0 or 1 with a short ramp at the thresholds.
    float edgeAt(vec2 uv) {
      vec2 px = 1.0 / resolution;
      float z0 = viewZ(uv);
      if (z0 >= far * 0.999) return 0.0;
      vec3 n0 = nrm(uv);
      float edge = 0.0;
      // Depth: a line on the nearer side of a jump only (one pixel wide), on the four neighbours.
      // Normals: forward differences only (right and up), also one pixel wide.
      vec2 offs[4];
      offs[0] = vec2(px.x, 0.0); offs[1] = vec2(-px.x, 0.0); offs[2] = vec2(0.0, px.y); offs[3] = vec2(0.0, -px.y);
      for (int i = 0; i < 4; i++) {
        float z = viewZ(uv + offs[i]);
        float jump = (z - z0) / max(z0, 1e-3);
        edge = max(edge, smoothstep(depthThreshold, depthThreshold * 1.8, jump));
        // Creases only between two surfaces: never against the empty sky.
        if ((i == 0 || i == 2) && z < far * 0.999) {
          float crease = 1.0 - dot(n0, nrm(uv + offs[i]));
          edge = max(edge, smoothstep(normalThreshold, normalThreshold * 1.6, crease));
        }
      }
      return edge;
    }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 px = 1.0 / resolution;
      float z0 = viewZ(vUv);
      float edge = edgeAt(vUv);
      if (soften > 0.0) {
        // A softer line: part of each neighbour's line is laid over this pixel, so a line has a faint
        // one-pixel shoulder on each side instead of a hard stair-step edge.
        float around = edgeAt(vUv + vec2(px.x, 0.0)) + edgeAt(vUv - vec2(px.x, 0.0)) + edgeAt(vUv + vec2(0.0, px.y)) + edgeAt(vUv - vec2(0.0, px.y));
        edge = min(1.0, edge + around * 0.3 * soften) * (1.0 - 0.25 * soften);
      }
      if (useMask > 0.5) edge *= 1.0 - clamp(texture2D(tMask, vUv).a, 0.0, 1.0);
      float fade = smoothstep(fadeNear, fadeFar, z0);
      float a = edge * opacity * mix(1.0, farOpacity, fade);
      vec3 ink = mix(color, farColor, fade);
      gl_FragColor = vec4(mix(base.rgb, ink, a), base.a);
    }
  `,
};

export class EdgePass extends Pass {
  scene: Scene | null = null;
  camera: PerspectiveCamera | null = null;
  private target: WebGLRenderTarget;
  private maskTarget: WebGLRenderTarget;
  private occluders = false;
  private normalMaterial = new MeshNormalMaterial({ side: DoubleSide });
  private material: ShaderMaterial;
  private quad: FullScreenQuad;
  private clearNormal = new Color(0.5, 0.5, 1.0);
  private saved = new Color();

  constructor(width: number, height: number) {
    super();
    // Normals in 8 bits per channel are enough for the crease test, and much cheaper than floats.
    this.target = new WebGLRenderTarget(width, height, { minFilter: NearestFilter, magFilter: NearestFilter });
    this.target.depthTexture = new DepthTexture(width, height, UnsignedIntType);
    // The mask shares the edge depth, so occluders behind inked geometry do not hide its lines.
    this.maskTarget = new WebGLRenderTarget(width, height, { minFilter: NearestFilter, magFilter: NearestFilter });
    this.maskTarget.depthTexture = this.target.depthTexture;
    this.material = new ShaderMaterial({
      uniforms: EdgeShader.uniforms,
      vertexShader: EdgeShader.vertexShader,
      fragmentShader: EdgeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.material.uniforms.resolution.value.set(width, height);
    this.quad = new FullScreenQuad(this.material);
    this.enabled = false;
  }

  setSettings(s: EdgeSettings | undefined): void {
    this.enabled = !!s;
    if (!s) return;
    const u = this.material.uniforms;
    (u.color.value as Color).set(s.color);
    (u.farColor.value as Color).set(s.farColor);
    u.fadeNear.value = s.fadeNear;
    u.fadeFar.value = s.fadeFar;
    u.farOpacity.value = s.farOpacity;
    u.opacity.value = s.opacity ?? 1;
    u.depthThreshold.value = s.depthThreshold ?? 0.035;
    u.normalThreshold.value = s.normalThreshold ?? 0.25;
    u.soften.value = Math.max(0, Math.min(1, s.soften ?? 1));
    this.occluders = !!s.occluders;
    u.useMask.value = this.occluders ? 1 : 0;
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const scene = this.scene;
    const camera = this.camera;
    if (!scene || !camera) return;
    // Normals and depth of the edge layer only.
    const mask = camera.layers.mask;
    const background = scene.background;
    const fog = scene.fog;
    const override = scene.overrideMaterial;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this.saved);
    const savedAlpha = renderer.getClearAlpha();
    camera.layers.set(EDGE_LAYER);
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = this.normalMaterial;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(this.clearNormal, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    if (this.occluders) {
      // Occluders with their own materials, depth-tested against the edge geometry (no depth writes
      // matter: the shared depth is read after this only for the lines, and occluders do not write it).
      scene.overrideMaterial = null;
      camera.layers.set(OCCLUDE_LAYER);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.maskTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    }
    camera.layers.mask = mask;
    scene.background = background;
    scene.fog = fog;
    scene.overrideMaterial = override;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setClearColor(this.saved, savedAlpha);

    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tNormal.value = this.target.texture;
    u.tDepth.value = this.target.depthTexture;
    u.tMask.value = this.maskTarget.texture;
    u.near.value = camera.near;
    u.far.value = camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.maskTarget.setSize(width, height);
    this.material.uniforms.resolution.value.set(width, height);
  }

  dispose(): void {
    this.target.dispose();
    this.maskTarget.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
