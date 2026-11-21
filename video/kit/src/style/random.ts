/**
 * Seeded randomness. Never Math.random(): the same seed always gives the same sequence, so a scene
 * built from it is the same in every run.
 */

/** mulberry32: a small, fast 32-bit PRNG. Returns a function giving numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A helper bundle around one generator. */
export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** -1..1 */
  signed(): number;
}

export function rng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    signed: () => next() * 2 - 1,
  };
}

/** A stateless hash of an integer and a seed, in [0, 1). */
export function hash01(i: number, seed = 0): number {
  return mulberry32((Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0)();
}
