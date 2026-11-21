/**
 * The video. This sample is 5 seconds: rooftops at dusk drawn with the style toolkit, one Latin and
 * one Arabic word. Replace the scene; keep the shape of the file:
 *
 *   1. build everything once (`build`), after the fonts are loaded;
 *   2. `renderFrame(frame)` sets every animated value from `frame` alone and renders;
 *   3. `window.__video` is assigned at the end.
 *
 * What makes it read as drawn and not as plain 3D shapes (all from `src/style`, see README.md):
 * cel-shaded materials with a shade colour, painted textures on every large surface, real windows,
 * small props on the roofs, a painted sky, thin ink edges, and paper grain as the last step.
 */

import { DirectionalLight, Fog, Mesh, PerspectiveCamera, PlaneGeometry, Scene, Vector3, WebGLRenderer } from 'three';

import { videoCanvas } from './contract';
import { easeInOutCubic, easeOutBack, easeOutCubic, lerp, progress } from './easing';
import { loadFonts } from './fonts';
import { shot, storyboard, text } from './storyboard';
import { WindowBuilder, inkEdges, makeBuilding, makeLook, makePost, makePropKit, paintedConcreteTexture, paintedSkyTexture, setLookDir, toon } from './style';
import { directionOf, makeTextPlane, type TextPlane } from './text';

const { width, height, fps, durationInFrames } = storyboard;

const canvas = videoCanvas();
canvas.width = width;
canvas.height = height;

const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(width, height, false);

const scene = new Scene();
scene.fog = new Fog('#c9698f', 34, 120);

const camera = new PerspectiveCamera(38, width / height, 0.5, 300);
scene.add(camera);

// One low, warm key light from the left. There is no ambient light: the look's shade colour fills
// the unlit sides, so shadows are violet, never grey.
const SUN = new Vector3(-10, 6, 8).normalize();
const key = new DirectionalLight('#ffd2a6', 2.6);
key.position.copy(SUN).multiplyScalar(50);
scene.add(key);
const look = makeLook({ rim: '#ffb37a', shade: '#4a3384', shadeAlbedo: 0.55 });
const farLook = makeLook({ rim: '#ffb37a', shade: '#6a4a9c', shadeAlbedo: 0.4 });

const post = makePost(renderer, width, height);
post.setView(scene, camera);
post.setEdges({ color: '#2c1b4d', farColor: '#8a5f9e', fadeNear: 18, fadeFar: 90, farOpacity: 0.3 });
post.setGrade({ saturation: 1.06, tint: '#fff6ee', lift: '#120a26', vignette: 0.35, vignetteTint: '#8a5aa8' });
post.setGrain({ amount: 0.035 });

let hello: TextPlane | null = null;
let marhaban: TextPlane | null = null;

const shot2 = shot('shot-02');
const helloText = text('hello');
const marhabanText = text('marhaban');

function buildCity(): void {
  scene.background = paintedSkyTexture(4, { top: '#2a2f7a', mid: '#b24f92', horizon: '#ffa25e', horizonAt: 0.66, cloud: '#ffc9a8', cloudShade: '#a8508f', clouds: 6, clearMiddle: 0.5 });

  const ground = new Mesh(new PlaneGeometry(400, 400), toon('#5b4a86', { look }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const windows = new WindowBuilder();
  const farWindows = new WindowBuilder();
  const walls = ['#e39a72', '#cf7d8a', '#e6b06e', '#9a86c2', '#d98a6a', '#b97aa6'];

  // Three rows, so the slow camera move shows depth: the near roof we look across, a middle row
  // with full facades, and a far skyline that the fog pushes back.
  scene.add(makeBuilding({ x: -5, z: 3, width: 20, depth: 11, height: 3.6, color: '#d88f74', roofColor: '#b98aa0', look, seed: 11, parapet: 0.5 }));
  scene.add(makeBuilding({ x: 13.5, z: 1, width: 9, depth: 8, height: 6.4, color: '#e6b06e', look, seed: 12, windows, faces: ['front', 'left'], facade: { firstRow: 4.4, lit: 0.6 } }));
  const mid: [number, number, number, number, number][] = [
    [-27, -9, 9, 7.6, 0], [-16.5, -11, 10, 6.6, 1], [-5, -10, 11, 8.2, 2], [6.5, -12, 9, 7.2, 3], [19, -10, 8, 8.4, 4], [28.5, -11, 9, 6.8, 5],
  ];
  for (const [x, z, w, h, i] of mid) {
    scene.add(makeBuilding({ x, z, width: w, depth: 8, height: h, color: walls[i % walls.length], look, seed: 20 + i, windows, faces: ['front', 'right'], facade: { firstRow: 4.6, rowStep: 2.6, windowHeight: 1.3, lit: 0.55 } }));
  }
  for (let i = 0; i < 12; i++) {
    const x = -62 + i * 11.5;
    const h = 6.4 + ((i * 7) % 5) * 0.55;
    scene.add(makeBuilding({ x, z: -42 - (i % 3) * 5, width: 10, depth: 9, height: h, color: walls[(i + 2) % walls.length], look: farLook, seed: 40 + i, windows: farWindows, faces: ['front'], facade: { firstRow: 3.4, rowStep: 2.4, windowHeight: 1.2, lit: 0.7 }, parapet: 0.4 }));
  }
  scene.add(windows.build({ frame: '#f3e3d0', sill: '#caa48f', look }));
  scene.add(farWindows.build({ frame: '#e6cfd0', sill: '#b995a8', look: farLook, bar: 0.07 }));

  // The near roof is where the eye rests, so it carries the clutter: nothing here is a bare box.
  const top = 3.6 + 0.25;
  const props = makePropKit(look, {
    metal: '#b9a6c4', metalDark: '#5a4680', ac: '#efe2d6', pipe: '#c47a6a', tank: '#5fa8b0', pot: '#c9705a', leaf: '#6fb37a', leafDark: '#3f8a6a',
    cloth: ['#fff3e2', '#7fd0e0', '#ff9db0', '#ffd27a'], sign: ['#ff6f91', '#3fb6c9', '#ffc24a'], board: '#6a4a8a',
  });
  props.smallTank(new Vector3(-11.5, top, 1.5), 0.95, 1.5);
  props.smallTank(new Vector3(-9.3, top, 0.4), 0.6, 1.0);
  props.acUnit(new Vector3(-6.2, top, 2.6), 0.3, 1.5);
  props.acUnit(new Vector3(-4.4, top, 2.9), -0.2, 1.5);
  props.vent(new Vector3(-2.2, top, 0.6), 3);
  props.vent(new Vector3(-13.6, top, 4.2), 4);
  props.antenna(new Vector3(-7.6, top, -0.8), 3.0, 5);
  props.antenna(new Vector3(3.2, top, -1.2), 2.4, 8);
  props.pipe([new Vector3(-9.3, top + 0.2, 0.4), new Vector3(-9.3, top + 0.2, 3.6), new Vector3(-3.4, top + 0.2, 3.6), new Vector3(-3.4, top + 0.2, 2.9)], 0.07);
  props.laundry(new Vector3(-1.2, top + 1.7, 3.2), new Vector3(3.9, top + 1.7, 2.2), 6, 0.22, 1.7, 0.012);
  for (let i = 0; i < 5; i++) props.plantPot(new Vector3(0.2 + i * 0.75, top, 5.6 - (i % 2) * 0.3), 30 + i, 1.1 + (i % 3) * 0.15);
  props.sign(new Vector3(-13.4, top, 6.4), 1.9, 1.0, 9, 0.35, 1.3);
  props.duct(new Vector3(-0.4, top + 0.3, -1.6), new Vector3(1.8, top + 0.3, -1.6), 0.5);
  props.railing(new Vector3(-14.7, top + 0.5, 8.3), new Vector3(4.7, top + 0.5, 8.3), 0.75);
  // A few props on the taller roof to the right, and a pole with its wires' insulators.
  const top2 = 6.4 + 0.25;
  props.smallTank(new Vector3(15.6, top2, 0.6), 0.8, 1.2);
  props.acUnit(new Vector3(12.2, top2, 2.8), 0.1, 1.4);
  props.utilityPole(new Vector3(8.2, 0, 6.4), 8.6, true);
  scene.add(props.finish());

  // A raised slab on the near roof: a painted surface under the tanks, not a flat colour.
  const pad = new Mesh(new PlaneGeometry(6, 5), toon('#c79ab0', { look, map: paintedConcreteTexture(7) }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(-10.6, top + 0.01, 1.6);
  inkEdges(pad);
  scene.add(pad);
}

function build(): void {
  buildCity();
  hello = makeTextPlane(helloText.text, { family: 'Inter', weight: 700, sizePx: 260, color: '#ffffff', direction: directionOf(helloText.text) }, 1.9);
  marhaban = makeTextPlane(marhabanText.text, { family: 'Noto Sans Arabic', weight: 700, sizePx: 300, color: '#ffffff', direction: directionOf(marhabanText.text) }, 2.5);
  // Text is a title, not an object in the street: it rides with the camera, 8 units in front of it.
  for (const plane of [hello, marhaban]) camera.add(plane.mesh);
}

function renderFrame(frame: number): void {
  if (!hello || !marhaban) throw new Error('renderFrame was called before ready.');
  const f = Math.max(0, Math.min(durationInFrames - 1, Math.round(frame)));

  // The camera slides right and rises a little, eased over the whole video: the three rows of
  // buildings move at different speeds.
  const move = easeInOutCubic(progress(f, 0, durationInFrames - 1));
  camera.position.set(lerp(-1.6, 1.6, move), lerp(8.7, 9.1, move), 30);
  camera.lookAt(lerp(-0.6, 0.6, move), 12.2, 0);
  camera.updateMatrixWorld();
  setLookDir([look, farLook], SUN, camera.matrixWorldInverse);

  const leave = easeInOutCubic(progress(f, shot2.startFrame, shot2.startFrame + 30));

  // Hello: eases in at the centre in shot 1, then steps up and back in shot 2.
  const helloIn = easeOutCubic(progress(f, helloText.startFrame, helloText.startFrame + 22));
  hello.mesh.position.set(0, lerp(lerp(-0.3, 0.4, helloIn), 1.8, leave), -8);
  hello.mesh.scale.setScalar(lerp(lerp(0.86, 1, helloIn), 0.5, leave));
  hello.mesh.material.opacity = lerp(helloIn, 0.8, leave);
  hello.mesh.visible = f >= helloText.startFrame;

  // مرحبا: rises into the centre as one word (never letter by letter).
  const arIn = progress(f, marhabanText.startFrame, marhabanText.startFrame + 26);
  marhaban.mesh.position.set(0, lerp(-1.9, 0.3, easeOutBack(arIn, 1.1)), -8);
  marhaban.mesh.scale.setScalar(lerp(0.8, 1, easeOutCubic(arIn)));
  marhaban.mesh.material.opacity = easeOutCubic(progress(f, marhabanText.startFrame, marhabanText.startFrame + 12));
  marhaban.mesh.visible = f >= marhabanText.startFrame;

  post.render(f);
}

const ready = (async () => {
  await loadFonts();
  build();
  camera.position.set(0, 9, 30);
  camera.lookAt(0, 12.2, 0);
  renderer.compile(scene, camera);
  // The first frame also compiles the passes of the picture chain.
  renderFrame(0);
})();

window.__video = { fps, durationInFrames, ready, renderFrame };
