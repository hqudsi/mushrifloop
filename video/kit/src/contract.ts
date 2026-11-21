/**
 * The determinism contract. The render scripts know nothing about the scene: they wait for `ready`,
 * call `renderFrame(n)` and read the canvas with id "video" back in the same call.
 *
 * Rules for everything behind `renderFrame`:
 * - the whole scene state is computed from the frame number, every time, from scratch;
 * - no clocks (`Date`, `performance.now`), no `requestAnimationFrame` timing, no `Math.random()`;
 * - nothing is loaded after `ready` resolves.
 *
 * `npm test` renders the same frame twice and once out of order and compares the hashes, so a scene
 * that keeps state between frames fails there.
 */
export interface VideoApi {
  fps: number;
  durationInFrames: number;
  /** Fonts, textures and shader compilation are done. */
  ready: Promise<void>;
  /** Set the whole scene from `frame` (0-based), then render it. */
  renderFrame(frame: number): void;
}

declare global {
  interface Window {
    __video: VideoApi;
  }
}

/** The one canvas that is captured. Text is drawn on other, detached canvases and used as textures. */
export function videoCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#video');
  if (!canvas) throw new Error('index.html must contain <canvas id="video">.');
  return canvas;
}
