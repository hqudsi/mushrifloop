/**
 * Paper grain: the last image step before the output conversion. It multiplies the picture by a few
 * percent of texture: a fine tooth, short horizontal fibres and broad soft mottling.
 *
 * The grain is computed from the pixel position and, when `every` is set, from the frame number. It
 * never reads a clock, so the same frame always gets the same grain.
 *
 * What it costs in file size is measured in README.md ("File size"): at the default strength next to
 * nothing; four times stronger, or changing every frame, 7 to 17 % more.
 *
 * `makePost` applies it in the same pass as the colour grade. `GrainShader` is the same grain as a pass
 * of its own, for a picture chain you put together yourself.
 */

import { Vector2 } from 'three';

export interface GrainSettings {
  /** Strength, e.g. 0.035 = ±3.5 % (the sample's value). */
  amount: number;
  /** Size of the fine tooth in pixels of the video (default 1). */
  size?: number;
  /**
   * 0 or absent: the grain stands still, like paper under the drawing (the default).
   * n > 0: a new grain every n frames ("boiling", like redrawn cels).
   */
  every?: number;
}

/** GLSL: `paperGrain(pixel, size, seed)` gives a factor around 0, to be scaled by the amount. */
export const GRAIN_GLSL = /* glsl */ `
  float grainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float grainNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(grainHash(i), grainHash(i + vec2(1.0, 0.0)), f.x), mix(grainHash(i + vec2(0.0, 1.0)), grainHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float paperGrain(vec2 pixel, float size, float seed) {
    // The seed moves the pattern by whole cells, so a "new grain" is the same paper somewhere else.
    vec2 p = pixel + vec2(seed * 37.0, seed * 91.0);
    float tooth = grainHash(floor(p / size)) - 0.5;
    float fibre = grainNoise(vec2(p.x * 0.08, p.y * 0.7) / size) - 0.5;
    float mottle = grainNoise(p * 0.006) - 0.5;
    return 0.45 * tooth + 0.35 * fibre + 0.6 * mottle;
  }
`;

export const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0 },
    size: { value: 1 },
    seed: { value: 0 },
    resolution: { value: new Vector2(1920, 1080) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount, size, seed;
    uniform vec2 resolution;
    varying vec2 vUv;
    ${GRAIN_GLSL}
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(c.rgb * (1.0 + amount * paperGrain(vUv * resolution, size, seed)), c.a);
    }
  `,
};

/** The value of the `seed` uniform for a frame: 0 when the grain stands still. */
export function grainSeed(settings: GrainSettings | undefined, frame: number): number {
  const every = settings?.every ?? 0;
  return every > 0 ? Math.floor(frame / every) % 1024 : 0;
}
