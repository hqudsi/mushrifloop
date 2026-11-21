/**
 * The page. With `?render=1` it is the bare canvas for the render scripts. Without it, it is the
 * preview: a scrubber and a play button. Preview playback is the only place a clock is used, and it
 * only chooses which frame to ask for; the scene itself never sees time.
 */

import './video';
import { videoCanvas } from './contract';

const renderMode = new URLSearchParams(location.search).has('render');
document.body.classList.add(renderMode ? 'render' : 'preview');

if (!renderMode) void preview();

async function preview(): Promise<void> {
  const video = window.__video;
  const canvas = videoCanvas();
  document.body.style.setProperty('--aspect', String(canvas.width / canvas.height));

  const ui = document.createElement('div');
  ui.id = 'ui';
  const play = document.createElement('button');
  play.textContent = 'Play';
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = String(video.durationInFrames - 1);
  scrub.value = '0';
  const label = document.createElement('output');
  ui.append(play, scrub, label);
  document.body.append(ui);

  await video.ready;

  const show = (frame: number) => {
    video.renderFrame(frame);
    scrub.value = String(frame);
    label.textContent = `frame ${frame} / ${video.durationInFrames - 1} · ${(frame / video.fps).toFixed(2)} s`;
  };
  show(0);

  scrub.addEventListener('input', () => {
    stop();
    show(Number(scrub.value));
  });

  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    play.textContent = 'Play';
  };
  play.addEventListener('click', () => {
    if (raf) return stop();
    play.textContent = 'Pause';
    const startFrame = Number(scrub.value) >= video.durationInFrames - 1 ? 0 : Number(scrub.value);
    const startedAt = performance.now();
    const tick = () => {
      const frame = startFrame + Math.floor(((performance.now() - startedAt) / 1000) * video.fps);
      if (frame >= video.durationInFrames) {
        show(video.durationInFrames - 1);
        return stop();
      }
      show(frame);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
