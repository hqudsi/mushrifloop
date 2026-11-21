/**
 * Plain easing functions. Every animated value in a scene is `lerp(from, to, ease(progress(frame, a, b)))`.
 * Motion is never linear: ease-out is the default for anything that arrives.
 */

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 0 before `start`, 1 from `end` on, linear in between. Feed it to an easing function. */
export function progress(frame: number, start: number, end: number): number {
  if (end <= start) return frame >= end ? 1 : 0;
  return clamp01((frame - start) / (end - start));
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeOutQuint(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u * u * u;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Arrives a little past the target and settles back. Use sparingly, for one focal element. */
export function easeOutBack(t: number, overshoot = 1.4): number {
  const x = clamp01(t) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

/** A value that is 0 → 1 over [inStart, inEnd] and 1 → 0 over [outStart, outEnd], eased both ways. */
export function inOut(frame: number, inStart: number, inEnd: number, outStart: number, outEnd: number): number {
  return easeOutCubic(progress(frame, inStart, inEnd)) * (1 - easeInOutCubic(progress(frame, outStart, outEnd)));
}
