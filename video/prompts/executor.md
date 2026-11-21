## Video task

This task is a video, not a program. You write it as Three.js code in the `video/` folder of the project and render it offline. The kit there is already installed and checked: read `video/README.md` before your first change, and run every command below from inside `video/`.

- `npm run stills` (or `npm run stills -- --shot <id>`): the storyboard's review frames into `out/review/`: one small contact sheet per shot, and `timing.json`. No frame is written at full size unless you ask for it.
- `npm run stills -- --frame <n>`: one frame at full size. `npm run stills -- --frame <n> --crop x,y,width,height`: one region of one frame, enlarged.
- `npm run render`: every frame, then `out/video.mp4`. **It stops after a time budget, with exit code 3 and a line starting `INCOMPLETE`. That is not a failure: run the same command again, and again, until it prints `DONE`.** Give the command a timeout of 600000 ms, the most the Bash tool allows (its default is 120000). If the tool says the command was moved to the background, wait for it to finish; do not start a second render beside it (one that is started anyway exits with a line starting `LOCKED`: that means wait, not retry). Never start one in the background yourself: nothing you start outlives your turn.
- `npm run gif`: a GIF from the rendered frames. `npm run small`: a second copy under 10 MB (`out/video-small.mp4`), when the render's last lines include a `WARNING` about the file size or the instruction asks for it. Report the size the render prints.
- `npm test`: the determinism test, on the video and on the kit's style toolkit. `npm run typecheck`.

Rules for the code (the kit's `src/contract.ts` has them in full):

- Everything on screen is computed from the frame number. No `Date`, no `performance.now()`, no `requestAnimationFrame` timing, no `Math.random()`.
- The video's size, frame rate, length, shot boundaries and exact text come from `storyboard.json`. Do not type on-screen text into the code a second time: read it from the storyboard data.
- Text is drawn with `makeTextPlane` from `src/text.ts`, after the fonts are loaded. A font you use is listed in `src/fonts.ts` and its file is in `public/fonts/`.
- Nothing moves at a constant speed onto or off the screen: use the easing functions in `src/easing.ts`, ease-out for what arrives.
- three.js is pinned to 0.187.0; the README lists what changed in it.

A drawn look, from the first pass (the README's "The drawn look" has the details):

- The first version of a shot must already read as drawn, not as plain 3D shapes. Do not build a grey-box version first and decorate it later.
- **Use the style toolkit in `src/style` before you write a helper of your own**: `toon` and `makeLook` (cel shading, a shade colour, tones inside the shade), `makePost` (ink edges, grade, paper grain; render through it), the painted textures in `paint.ts` (walls, concrete, ground, road, roof tiles, sky), `WindowBuilder` and `makeBuilding` (real windows, whole facades), `makePropKit` (air conditioners, tanks, pipes, antennas, pots, laundry, signs without text, railings, poles), `makeReflection` (reflections that keep their shape) and `makeGlow`. The sample `src/video.ts` shows them working together. What the toolkit lacks, add as a new file in the same manner: seeded, never `Math.random()`, canvases created like `paintCanvas` does.
- Nothing in the main part of the frame is a plain box or a surface in one flat colour. Every large surface has a painted texture; every building has windows; roofs and streets carry props; the sky is painted; an object against the light still shows two or three tones. A reflection or a light has a shape, it is not a large soft blob.
- Fill the frame where the eye rests. If a roof, a street or a wall looks empty in the still, it is not finished.
- Keep the grain light and still (about ±3.5 %, as in the sample) unless the instruction says otherwise. What makes the file large is fine detail that moves; the README's "File size" has the numbers.

Your session is replaced often, so the state lives in files:

- The orchestrator replaces your session with a fresh one whenever it has grown to about 150,000 tokens, also in the middle of a shot. Reading a long session again on every step is the largest cost of a video. The fresh session gets a short summary and nothing else: what it needs must be in the project.
- **Keep `video/progress.md` up to date: change it at the end of every turn, before you report**, and list it in `changed_files`. One page, not a diary:
  - per shot, one line: not started, being built, built and waiting for review, or passed; and what is still open for it (the defect as the planner named it, what you tried);
  - "The look": the palette, the settings given to `makeLook` and `makePost`, and each helper you added with the file it is in;
  - anything a new session would otherwise have to find out again (a command that failed and why, a limit you hit).
- Keep each shot in a file of its own (for example `src/shots/shot-02.ts`) and what the shots share in another (`src/look.ts`), so that a fresh session reads one shot, not the whole video.
- When a session starts with a handoff summary, read `video/storyboard.json`, `video/progress.md` and the file of the shot in hand before you change anything. The files are right where they differ from the summary.

Before you report:

- **Open the contact sheet yourself with Read** and look at it. Do not report a shot you have not looked at. Look for the defects above (plain boxes, flat single-colour objects, empty areas, blobs) and fix them before you report, not after the planner finds them.
- **The sheet first; a large image only for one detail.** An image you open is paid for by its pixels, now and in every later step of your session. When the sheet cannot settle something, render that one frame (`--frame <n>`) or that one region (`--crop`) and open it. Do not open every frame at full size.
- In your answer, name the files the planner should open (for example `video/out/review/shot-02-sheet.png`), and any full-size frame or crop you made that shows a detail the sheet does not.
- Say what `timing.json` warns about, if anything.
- Do not list anything under `video/out/` in `changed_files`: rendered files are not part of the work and are never committed.

Arabic and other right-to-left text:

- **Never transcribe Arabic from an image, and never judge its spelling from one.** Quote on-screen text only from `storyboard.json`.
- From the stills, check only that the text is not clipped, that nothing overlaps it, its size and its position. Whether the Arabic itself is correct is confirmed by the human.
- Animate Arabic by word or by line (one text plane each), never letter by letter: separate letters lose their joined forms.

Never: third-party logos or anything imitating a brand; an image, font, model or sound without a clear open licence. Do not download assets. Do not install packages unless the instruction says so.
