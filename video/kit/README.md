# Video kit

A video written as Three.js code and rendered offline, frame by frame, to MP4. The same frame number
always gives the same picture, so the video can be reviewed as still images and rendered in pieces.

## First time

```
npm ci
npm run doctor
```

`doctor` says whether this folder can render: which browser it will use and the graphics renderer that
browser reports, whether an ffmpeg with libx264 was found, and how long a frame takes. If it reports a
problem:

- **No ffmpeg, or one without libx264:** `npm run setup` installs `ffmpeg-static` into `node_modules`.
  That package is a GPL build of ffmpeg, about 80 MB.
- **No browser:** an installed Microsoft Edge is used first, then Google Chrome. When neither works, run
  `npm run setup -- --download-browser` for Playwright's own Chromium (a 207 MB download, about 450 MB
  on disk, inside `node_modules`).

An installed browser updates itself. `render` notices: when the browser or its version changed since the
last render, it renders every frame again, so one video never mixes two browser versions.

Nothing is installed outside this folder, and nothing is requested from the network while rendering.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Preview in a browser, with a scrubber and a play button |
| `npm run stills` | The storyboard's review frames into `out/review/`: one labelled contact sheet per shot, and `timing.json` |
| `npm run stills -- --shot shot-02` | One shot only (its id, or its number) |
| `npm run stills -- --frame 45` | One frame at full size (any frame of the video) |
| `npm run stills -- --frame 45 --crop 600,300,720,400` | One region of one frame, enlarged, to look at a detail |
| `npm run stills -- --full` | The sheets, and every review frame at full size beside them |
| `npm run render` | Every frame to `out/frames/`, then `out/video.mp4` (H.264, yuv420p, faststart, no audio) |
| `npm run gif` | `out/video.gif` from the rendered frames (`--from`, `--to`, `--fps`, `--width`) |
| `npm run small` | `out/video-small.mp4`: a second copy that fits under 10 MB (`--mb`, `--width`). `out/video.mp4` stays as it is |
| `npm test` | The render lock, then the determinism test: the same frame, twice, out of order and in a newly started browser, must give the same image. It runs on the video and on the style toolkit's own test scene, which uses every part of `src/style` |
| `npm run typecheck` | TypeScript, no output |

**`render` resumes.** It stops after a time budget (`--budget-seconds`, 480 by default) with exit code 3
and a line starting `INCOMPLETE:`. Run the same command again until it prints `DONE:`. Frames already on
disk are kept as long as the code, the storyboard and the browser have not changed.

**The contact sheet comes first, and it is small on purpose.** An agent that opens an image pays for it by
its pixels, in that turn and again in every later turn of its session. A sheet of four frames is about
1000×700 pixels; one frame at full size is twice that. So `stills` writes only the sheets. When a detail
cannot be judged from a sheet, ask for that one frame (`--frame`) or that one region (`--crop`), not for
all of them. A new sheet removes the full-size frames of its shot: they would show the old picture.

**One render at a time.** `render` holds `out/.render.lock` while it runs. A second `render` (or a `gif`)
started beside it exits at once with code 4 and a line starting `LOCKED:`. Wait for the first; do not
start another. A lock left behind by a run that was killed is cleared by the next run.

## Where things are

| Path | |
|---|---|
| `storyboard.md` | The storyboard, for people |
| `storyboard.json` | The same as data: size, frame rate, length, and per shot its frames, what is on screen, the exact text, the review frames and 3–5 checks. The code and the scripts read it |
| `progress.md` | The progress notes of whoever builds the video: where each shot stands and what the look is made of. Not in the kit; written as the work goes |
| `src/video.ts` | The video. Replace the sample scene here |
| `src/contract.ts` | The rules a video follows so that it renders the same every time |
| `src/easing.ts`, `src/text.ts`, `src/fonts.ts` | Easing functions, text drawn on a canvas and used as a texture, the fonts |
| `src/style/` | The style toolkit: what makes a scene read as drawn (see "The drawn look") |
| `style-test.html`, `src/style/selftest.ts` | The toolkit's own test scene, rendered by `npm test`. Not part of the video |
| `public/fonts/` | Inter and Noto Sans Arabic (SIL Open Font License; the licence texts are beside them) |
| `out/` | Everything rendered. Never committed |

## The drawn look

A scene made of plain boxes in flat colours reads as an unfinished 3D model. The toolkit in `src/style`
is what the sample video is built with; start from it, and the first pass already reads as drawn.

| File | What it gives | Use |
|---|---|---|
| `toon.ts` | Cel shading in flat tone bands. Shadows take a shade colour instead of grey, and a form that is wholly in shadow still shows two or three tones | `makeLook({ rim, shade })`, `toon(colour, { look, map })`, and `setLookDir` once per frame |
| `post.ts` | The picture chain: ink edges, bloom, colour grade, paper grain | `makePost(renderer, w, h)`, then `post.render(frame)` instead of `renderer.render` |
| `edges.ts` | Thin ink lines on outlines and creases, lighter with distance | `post.setEdges({...})`; `inkEdges(object)` puts an object on the edge layer |
| `outline.ts` | A hull outline for one object or a flat shape (a paper plane) | `addOutline(mesh, outlineMaterial(colour))` |
| `paint.ts` | Painted textures from a seed: wall, concrete, ground, road, gravel, timber, panels, roof tiles, a far facade, a sky with clouds | `toon(colour, { look, map: paintedWallTexture(seed) })` |
| `windows.ts` | Real windows, instanced: frame, sill, mullions; lit, curtained, blinded, lamp and dark panes | `new WindowBuilder()`, `add({...})`, `build(style)` |
| `facade.ts` | A whole building: painted walls, roof slab, parapet and a seeded grid of windows | `makeBuilding({...})` |
| `props.ts` | Air conditioners, tanks, pipes, ducts, antennas, vents, plant pots, laundry lines, signs without text, railings, bicycles, utility poles | `makePropKit(look, colours)`, the builders, then `finish()` |
| `reflect.ts` | Reflections on wet ground that keep the shape of what they reflect, pulled long and broken into dashes | `makeReflection(mesh, { groundY, color, ripple: rippleTexture(seed) })` |
| `glow.ts`, `grain.ts`, `random.ts` | A halo round a lamp; paper grain; seeded random numbers | |

What a first pass has to have:

- **No plain boxes and no flat single-colour objects** in the main part of the frame. A building has a
  painted wall and windows. A roof or a street carries props. The sky is painted.
- **Tones inside the shade.** An object against the light shows two or three tones, not one silhouette
  colour. `makeLook` does this unless it is given `fill: false`.
- **Shapes, not blobs.** A light's reflection is the light's own shape, mirrored and broken; a glow is a
  small halo round a lamp, not the lamp.
- **Ink and grain last.** Edges on everything solid (`makeBuilding`, the windows and the props are on the
  edge layer already; call `inkEdges` for your own objects), and grain as the last step.

Everything in the toolkit follows the scene rules below: random values come from a seed, and canvases are
drawn by the CPU, so the same frame gives the same pixels in every run. A helper you add follows the same
rules: use `rng(seed)` and `paintCanvas`. When you draw many soft shapes on a canvas, draw them sharp on a
layer and blur the layer once; blurring each stroke is a hundred times slower.

## Rules for a scene

- Everything on screen is computed from the frame number. No `Date`, no `performance.now()`, no
  `requestAnimationFrame` timing, no `Math.random()`.
- Text is drawn with `makeTextPlane` (`src/text.ts`), after the fonts are loaded. Arabic is animated by
  word or by line, never letter by letter: separate letters lose their joined forms.
- A font the scene uses is listed in `src/fonts.ts` and its file is in `public/fonts/`. Use only fonts
  and other assets with a clear open licence.
- Shots follow each other without gaps, from frame 0 to the last frame, in `storyboard.json`.
- three.js is pinned to 0.187.0. Import add-ons from `three/addons/…`. `RGBELoader` is now `HDRLoader`;
  `PCFSoftShadowMap` falls back to `PCFShadowMap`; `outputEncoding` and `useLegacyLights` no longer
  exist; with `EffectComposer`, `OutputPass` goes last.

## File size

`npm run render` prints the file's size and bitrate on its last line and writes them to
`out/render.json`. Above 10 MB, the limit for a video attached to a GitHub issue, pull request or README,
it prints a `WARNING` with the command for a smaller copy: `npm run small` writes `out/video-small.mp4`
under 10 MB and leaves `out/video.mp4` as it is. Below about 1.5 Mbit/s the small copy is also scaled to
1280 px wide, which looks better than 1920 px at the same size.

What makes a file large is **fine detail that moves**. Measured on a 60-second 1080p video with ink
edges, painted textures and grain in every shot (95.8 MB as rendered, 12.8 Mbit/s):

| What | Effect on the bitrate |
|---|---|
| Ink edges, crisp (`soften: 0`) | **+53 to +59 %** over the same shot without edges |
| Ink edges, soft (`soften: 1`) | +13 % over no edges: **26 to 29 % smaller than crisp**, for the same render time |
| Grain, still, ±3.5 % (the sample's) | none measurable |
| Grain, still, ±14 % | +1 to +7 % |
| Grain, ±14 %, new every frame | +1 to +17 % |
| A tooth of 2 px instead of 1 px | none at ±3.5 %; +3 % at ±14 % |

So: keep grain light and still, and keep the ink lines soft, which is the default (`soften: 1`); ask for
crisp lines (`post.setEdges({ ..., soften: 0 })`) only when the look needs them and the size does not matter. The encoder setting matters most of all, but it
trades size for quality and is the kit's to choose, not the scene's: `render` uses x264 at CRF 18.

## Render time

A frame costs the drawing, then encoding the PNG and handing it to Node. Measured for the sample on a
laptop with integrated graphics (Intel UHD 620), 1920×1080: the scene alone draws in 11 ms; through the
picture chain with edges, grade and grain it takes 59 ms with `samples: 4`, 53 ms with 2 and 32 ms with 0.
Encoding the PNG takes about 95 ms, more for a picture with grain (2.7 MB) than without (1.6 MB).
`makePost(renderer, w, h, { samples: 0 })` is the one large saving when a render is too slow; the ink
edges hide most of the stair-steps it leaves. `npm run doctor` measures this computer.
