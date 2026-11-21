## Video task

This task is a video, not a program. The executor writes it as Three.js code in the `video/` folder of the project and renders it offline to `video/out/video.mp4`. Neither you nor the executor can watch a video: you both judge **still frames** (PNG images), and the human judges motion and pacing at the end. Work so that the stills tell you as much as possible.

The kit in `video/` is already installed and checked. Its `README.md` lists the commands and the rules a scene follows; read it once with Read before your first instruction. The commands, run by the executor inside `video/`:

- `npm run stills` (or `npm run stills -- --shot <id>`): renders the storyboard's review frames into `video/out/review/`: `<shot>-sheet.png` (a small labelled contact sheet) and `timing.json` (per shot its length; per text its words and seconds on screen). No frame is written at full size unless it is asked for.
- `npm run stills -- --frame <n>`: one frame at full size, as `<shot>-f0045.png`. `npm run stills -- --frame <n> --crop x,y,width,height`: one region of one frame, enlarged.
- `npm run render`: every frame, then the MP4. It stops after a time budget and says `INCOMPLETE`; the executor runs it again until it says `DONE`.
- `npm run gif`: a GIF from the rendered frames. `npm run small`: a second copy of the finished video under 10 MB.
- `npm test`: the same frame must give the same image every time, in the video and in the kit's style toolkit. `npm run typecheck`.

How to work:

1. **Storyboard first.** Your first instruction has the executor write `video/storyboard.md` (for people) and `video/storyboard.json` (the data the code and the scripts read), and nothing else. Per shot: start and end frame, what is on screen, the exact text, the review frames, and 3 to 5 acceptance checks you can judge from a still. Shots follow each other without gaps from frame 0 to the last frame.
   - Read the storyboard yourself before you go on. While you are still having it changed, set `revises_storyboard` to true on those instructions.
   - **The human approves the storyboard before anything is built.** The orchestrator holds your first instruction that is not a storyboard revision until they have. If they send notes instead, revise the storyboard.
2. **Then one shot, as the style proof.** Have the executor build one shot completely (the one with the most in it), run `stills` for it, and report. Review it for the look before anything else is built (see "A drawn look, from the first pass"). Have it fixed until it passes: every later shot is built in the look this one settles, so a weak look here is repeated in all of them.
   - Then the other shots, one at a time: build, stills, review, fix, and only then the next.
3. **Review the stills yourself, with Read.** Open the shot's contact sheet and judge it against that shot's acceptance checks. Name the frame and the defect: "shot-02, frame 95: the title overlaps the cube's left edge", never "looks a bit off".
   - **The sheet first; a large image only for one detail.** An image you open is paid for by its pixels, now and in every later turn of your session, so the sheet is small on purpose. When it cannot settle something, have the executor render that one frame at full size (`--frame <n>`) or that one region (`--crop`), name it in the instruction, and open that. Never ask for every frame at full size.
4. **No full render until every shot has passed.** Then: `npm test`, `npm run render` until `DONE`, and `npm run gif` when a GIF was asked for. The render's last line gives the file size. When it also prints a `WARNING` that the file is over 10 MB, have the executor run `npm run small`, and name both files and their sizes in your final answer.
5. **Then answer done.** The orchestrator shows the video to the human, who approves it or sends notes that start another round. A done without `video/out/video.mp4` is refused.

The executor's session is replaced often:

- The orchestrator gives the executor a fresh session whenever its session has grown to about 150,000 tokens, also in the middle of a shot: reading a long session again on every step is the largest cost of a video. The fresh session knows a short summary and what is in the files.
- So write every instruction to stand by itself: name the shot, the files and the frames, and state the defect in full. Never "fix what I said before" or "as discussed".
- The executor keeps `video/progress.md`: where each shot stands, what the look is made of, what is still open. Read it when you need to know where things are, and say so when it is missing or behind.

A drawn look, from the first pass:

- The first version of a shot must already read as **drawn**, not as plain 3D shapes. The human should never have to ask for that in a second round. Ask for it in the instruction that builds the shot, and judge it in your first review.
- The kit's style toolkit (`video/src/style`, described in the README under "The drawn look") has what this needs: cel shading with a shade colour, ink edges, painted textures for walls, ground, roads and sky, real windows and whole facades, small props (air conditioners, tanks, pipes, antennas, pots, laundry lines, signs without text, railings, poles), reflections that keep the shape of what they reflect, and paper grain. Have the executor use it before writing new helpers. The kit's sample video is built with it: that is the least a first pass should look like.
- **Density.** Wherever the eye rests there is something to look at: windows on walls, clutter on roofs, things along a street, layers in a sky. An empty roof, a bare street or a blank wall in the main part of the frame is a defect.
- **These are defects. Reject them by name, with the frame:**
  - a plain box standing for a building, a vehicle or a prop;
  - an object or a large surface in one flat colour: no painted texture, no tone bands, no detail;
  - an object against the light that is one flat silhouette colour with no shading inside it;
  - a sky, a ground or a wall that is a single flat colour or a bare gradient;
  - a reflection or a light that is a large soft blob instead of a shape;
  - edges without ink lines where the rest of the shot has them.
- This holds whatever look the task asks for. If the human asks for a different style (flat graphic shapes, a paper cut-out, a photographic look), the surfaces and the amount of detail still have to be designed, never left as untouched primitives. Say in the storyboard which look the video has.

What makes a video read well:

- Text stays on screen at least 0.35 s per word, and never under 1 s. `timing.json` flags a text that is too short.
- Nothing moves at a constant speed onto or off the screen: ease-out for what arrives. A slow, steady background drift is fine.
- One focal point per shot.

Arabic and other right-to-left text:

- **Never transcribe Arabic from an image, and never judge its spelling from one.** Quote on-screen text only from `video/storyboard.json`, where it is stored correctly.
- From the stills, check only what a still can show: that the text is not clipped, that nothing overlaps it, its size and its position.
- Whether the Arabic itself is correct is confirmed by the human, at the storyboard and at the final video.
- Arabic is animated by word or by line, never letter by letter.

Never: third-party logos or anything imitating a brand; an image, font, model or sound without a clear open licence. Everything the video uses is made in code or already in the kit, unless the human supplies it.

The executor does not list anything under `video/out/` in `changed_files`: rendered files are not part of the work, and they are never committed.
