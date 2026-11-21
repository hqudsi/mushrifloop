/**
 * The picture chain: render → ink edges → bloom → colour grade, vignette and paper grain → output.
 * One chain serves every shot: `setView` points it at the active shot's scene and camera, and each
 * shot sets its own edges, bloom, grade and grain.
 *
 * Every step is off until it is given settings, and a step that is off costs nothing.
 *
 * Use it instead of `renderer.render`:
 *
 *   const post = makePost(renderer, width, height);
 *   post.setView(scene, camera);
 *   post.setEdges({ color: '#3a1f4a', farColor: '#8a6a9a', fadeNear: 10, fadeFar: 80, farOpacity: 0.35 });
 *   post.setGrain({ amount: 0.035 });
 *   // in renderFrame(frame):
 *   post.render(frame);
 *
 * What the steps cost per frame is in README.md ("Render time"). The dearest is antialiasing: the
 * canvas's own does not apply to a render target, so the chain has its own (`samples`).
 */

import { type Camera, Color, HalfFloatType, type PerspectiveCamera, type Scene, Vector2, type WebGLRenderer, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { EdgePass, type EdgeSettings } from './edges';
import { GRAIN_GLSL, type GrainSettings, grainSeed } from './grain';

export interface GradeSettings {
  /** 1 = unchanged. */
  saturation: number;
  /** Multiplied into the image. */
  tint: string;
  /** Added to the dark areas. */
  lift: string;
  vignette: number;
  /** The colour the corners are pulled towards (kept saturated, never black). */
  vignetteTint: string;
}

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export interface PostOptions {
  /**
   * Antialiasing samples of the chain's render target: 4 (the default) for smooth geometry edges,
   * 2 for a faster render, 0 for none (ink edges then hide most of the stair-steps).
   */
  samples?: number;
}

export interface Post {
  composer: EffectComposer;
  setView(scene: Scene, camera: Camera): void;
  /** `undefined` switches the step off. */
  setEdges(e: EdgeSettings | undefined): void;
  setBloom(b: BloomSettings | undefined): void;
  setGrade(g: GradeSettings | undefined): void;
  setGrain(g: GrainSettings | undefined): void;
  /** Renders the frame. The frame number only chooses the grain when the grain is set to change. */
  render(frame?: number): void;
}

/** Grade and grain in one pass: each full-screen pass costs time, so the two share one. */
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    grade: { value: 0 },
    saturation: { value: 1 },
    tint: { value: new Color(1, 1, 1) },
    lift: { value: new Color(0, 0, 0) },
    vignette: { value: 0 },
    vignetteTint: { value: new Color(0, 0, 0) },
    grainAmount: { value: 0 },
    grainSize: { value: 1 },
    grainSeed: { value: 0 },
    resolution: { value: new Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float grade, saturation, vignette, grainAmount, grainSize, grainSeed;
    uniform vec3 tint, lift, vignetteTint;
    uniform vec2 resolution;
    varying vec2 vUv;
    ${GRAIN_GLSL}
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      if (grade > 0.5) {
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, saturation) * tint;
        col += lift * (1.0 - smoothstep(0.0, 0.5, l));
        vec2 q = vUv - 0.5;
        q.x *= 1.35;
        col = mix(col, col * vignetteTint, vignette * smoothstep(0.25, 0.85, length(q)));
      }
      if (grainAmount > 0.0) col *= 1.0 + grainAmount * paperGrain(vUv * resolution, grainSize, grainSeed);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }
  `,
};

export function makePost(renderer: WebGLRenderer, width: number, height: number, options: PostOptions = {}): Post {
  // Half-float, so bright colours survive until the output conversion.
  const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: options.samples ?? 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(1);
  composer.setSize(width, height);
  const renderPass = new RenderPass(undefined as unknown as Scene, undefined as unknown as Camera);
  const edges = new EdgePass(width, height);
  const bloom = new UnrealBloomPass(new Vector2(width, height), 0.6, 0.5, 0.9);
  bloom.enabled = false;
  const finish = new ShaderPass(FinishShader);
  finish.uniforms.resolution.value.set(width, height);
  finish.enabled = false;
  let grainSettings: GrainSettings | undefined;
  let gradeOn = false;
  composer.addPass(renderPass);
  composer.addPass(edges);
  composer.addPass(bloom);
  composer.addPass(finish);
  // The output conversion (tone mapping, sRGB) is always the last pass.
  composer.addPass(new OutputPass());
  const u = finish.uniforms;
  return {
    composer,
    setView(scene, camera) {
      renderPass.scene = scene;
      renderPass.camera = camera;
      edges.scene = scene;
      edges.camera = camera as PerspectiveCamera;
    },
    setEdges(e) {
      edges.setSettings(e);
    },
    setBloom(b) {
      bloom.enabled = !!b && b.strength > 0;
      if (!b) return;
      bloom.strength = b.strength;
      bloom.radius = b.radius;
      bloom.threshold = b.threshold;
    },
    setGrade(g) {
      gradeOn = !!g;
      u.grade.value = g ? 1 : 0;
      finish.enabled = gradeOn || !!grainSettings;
      if (!g) return;
      u.saturation.value = g.saturation;
      (u.tint.value as Color).set(g.tint);
      (u.lift.value as Color).set(g.lift);
      u.vignette.value = g.vignette;
      (u.vignetteTint.value as Color).set(g.vignetteTint);
    },
    setGrain(g) {
      grainSettings = g && g.amount > 0 ? g : undefined;
      u.grainAmount.value = grainSettings?.amount ?? 0;
      u.grainSize.value = Math.max(1, grainSettings?.size ?? 1);
      finish.enabled = gradeOn || !!grainSettings;
    },
    render(frame = 0) {
      u.grainSeed.value = grainSeed(grainSettings, frame);
      // A fixed delta: the composer never reads a clock that matters to the picture.
      composer.render(0);
    },
  };
}
