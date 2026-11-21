/**
 * The style toolkit: what makes a 3D scene read as drawn instead of as plain 3D shapes.
 * `README.md` ("The drawn look") says what each part is for; each file's header says how to use it.
 *
 *   toon      cel shading in flat tone bands, a shade colour instead of grey, tones inside the shade
 *   edges     thin ink lines on depth jumps and creases, fading with distance
 *   outline   a hull outline for single objects and flat shapes (a paper plane, a leaf)
 *   paint     painted wall, concrete, ground, road, gravel, timber, panel and roof-tile textures
 *   windows   real windows: frame, sill, mullions, lit, curtained, blinded and dark panes
 *   facade    a painted building with a roof, a parapet and a seeded grid of windows
 *   props     air conditioners, tanks, pipes, ducts, antennas, pots, laundry, signs, railings, poles
 *   reflect   reflections on wet ground that keep the shape of what they reflect
 *   glow      a soft halo round a lamp
 *   grain     paper grain
 *   post      the picture chain that runs edges, bloom, grade and grain
 *   random    seeded random numbers (never Math.random)
 */

export * from './edges';
export * from './facade';
export * from './glow';
export * from './grain';
export * from './outline';
export * from './paint';
export * from './post';
export * from './props';
export * from './random';
export * from './reflect';
export * from './toon';
export * from './windows';
