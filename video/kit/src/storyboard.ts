/**
 * The storyboard data file, typed. The scene reads its size, length, shot boundaries and exact text
 * from here, so the storyboard the human approved and the video cannot drift apart.
 */

import data from '../storyboard.json';

export interface StoryboardText {
  id: string;
  text: string;
  /** A language tag: "en", "ar", … */
  lang: string;
  /** First and last frame the text is on screen (inclusive). */
  startFrame: number;
  endFrame: number;
}

export interface StoryboardShot {
  id: string;
  name: string;
  /** Inclusive. */
  startFrame: number;
  endFrame: number;
  onScreen: string;
  texts: StoryboardText[];
  /** The frames rendered by `npm run stills` for review. */
  reviewFrames: number[];
  /** 3–5 things that must be true of this shot. */
  acceptance: string[];
}

export interface Storyboard {
  title: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  shots: StoryboardShot[];
}

export const storyboard = data as Storyboard;

export function shot(id: string): StoryboardShot {
  const found = storyboard.shots.find((s) => s.id === id);
  if (!found) throw new Error(`storyboard.json has no shot "${id}".`);
  return found;
}

/** A text by its id, from any shot. */
export function text(id: string): StoryboardText {
  for (const s of storyboard.shots) {
    const found = s.texts.find((t) => t.id === id);
    if (found) return found;
  }
  throw new Error(`storyboard.json has no text "${id}".`);
}
