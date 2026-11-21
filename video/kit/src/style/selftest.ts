/**
 * The style toolkit's own test scene, used by `npm test` (style-test.html). It is not part of the
 * video. It puts every part of the toolkit in one small picture so the determinism test covers them
 * whatever the video itself uses: the same frame must give the same pixels twice, out of order, and
 * in a newly started browser.
 *
 * `?only=<part>` builds one part alone, so a failing test can name the part that differs.
 */

import { BoxGeometry, DirectionalLight, Fog, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, SphereGeometry, Vector3, WebGLRenderer } from 'three';

import { videoCanvas } from '../contract';
import {
  OCCLUDE_LAYER,
  WindowBuilder,
  addOutline,
  edgeGrimeTexture,
  inkEdges,
  makeBuilding,
  makeGlow,
  makeLook,
  makePost,
  makePropKit,
  makeReflection,
  outlineMaterial,
  paintedConcreteTexture,
  paintedGravelTexture,
  paintedGroundTexture,
  paintedPanelTexture,
  paintedPlankTexture,
  paintedRoadTexture,
  paintedSkyTexture,
  paintedWallTexture,
  rippleTexture,
  roofTileTexture,
  setLookDir,
  setOutlineResolution,
  skylineTexture,
  staveTexture,
  toon,
  type PaneKind,
} from './index';

export const STYLE_PARTS = ['toon', 'paint', 'windows', 'facade', 'props', 'outline', 'reflect', 'glow', 'edges', 'bloom', 'grade', 'grain'] as const;
type Part = (typeof STYLE_PARTS)[number];

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 30;
const FRAMES = 60;

const only = new URLSearchParams(location.search).get('only') as Part | null;
const has = (part: Part) => only === null || only === part;

const canvas = videoCanvas();
canvas.width = WIDTH;
canvas.height = HEIGHT;
const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
setOutlineResolution(WIDTH, HEIGHT);

const scene = new Scene();
scene.fog = new Fog('#b86a94', 30, 120);
const camera = new PerspectiveCamera(42, WIDTH / HEIGHT, 0.5, 300);
const SUN = new Vector3(-6, 7, 9).normalize();
const key = new DirectionalLight('#ffe0c0', 2.5);
key.position.copy(SUN).multiplyScalar(40);
scene.add(key);
const look = makeLook({ rim: '#ffb37a', shade: '#4a3384' });
const flatLook = makeLook({ rim: '#ffb37a', shade: '#27506a', fill: false });
const post = makePost(renderer, WIDTH, HEIGHT);
post.setView(scene, camera);

const glows: ReturnType<typeof makeGlow>[] = [];

function build(): void {
  scene.background = paintedSkyTexture(2, { top: '#2a2f7a', mid: '#b24f92', horizon: '#ffa25e', cloud: '#ffc9a8', cloudShade: '#a8508f' });
  const ground = new Mesh(new PlaneGeometry(200, 200), toon('#4b4470', { look, map: has('paint') ? paintedRoadTexture(3) : undefined }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  if (has('toon')) {
    // One shape per look: with the shade fill (the default) and without.
    const a = new Mesh(new SphereGeometry(1.2, 24, 16), toon('#e9785a', { look }));
    a.position.set(-13, 1.2, 4);
    const b = new Mesh(new BoxGeometry(1.6, 2.4, 1.6), toon('#3aa6a0', { look: flatLook }));
    b.position.set(-10, 1.2, 4);
    scene.add(a, b);
    inkEdges(a);
    inkEdges(b);
  }

  if (has('paint')) {
    const maps = [
      paintedWallTexture(1, { windows: { col0: 1.2, colStep: 2.4, row0: 2, rowStep: 3.1, height: 1.5 } }),
      paintedConcreteTexture(2),
      paintedGroundTexture(3),
      paintedGravelTexture(4),
      paintedPlankTexture(5),
      paintedPanelTexture(6),
      roofTileTexture(7),
      skylineTexture(8),
      staveTexture(12),
      edgeGrimeTexture(),
    ];
    maps.forEach((map, i) => {
      const m = new Mesh(new PlaneGeometry(2.6, 2.6), toon(['#e39a72', '#b98aa0', '#7c9a6a', '#9a90b0', '#c08a5a', '#5aa0c0', '#c9605a', '#8a7ab8', '#5fa8b0', '#d0b090'][i], { look, map }));
      m.position.set(-13.2 + i * 2.9, 9.4, -6);
      scene.add(m);
    });
  }

  if (has('windows')) {
    const builder = new WindowBuilder();
    const kinds: PaneKind[] = ['lit', 'curtain', 'blind', 'dark', 'lamp'];
    kinds.forEach((kind, i) => {
      builder.add({ position: new Vector3(-6 + i * 1.9, 5.6, -5.9), normal: new Vector3(0, 0, 1), width: 1.2, height: 1.6, kind, tone: kind === 'dark' ? '#3b4f7a' : '#ffd98a', mullions: i % 2 === 0 });
    });
    scene.add(builder.build({ frame: '#f3e3d0', sill: '#caa48f', look }));
    const flush = new WindowBuilder();
    kinds.forEach((kind, i) => {
      flush.add({ position: new Vector3(5 + i * 1.9, 5.6, -5.9), normal: new Vector3(0, 0, 1), width: 1.2, height: 1.6, kind, tone: kind === 'dark' ? '#2e3f6a' : '#ffc46b' });
    });
    scene.add(flush.build({ frame: '#e6cfd0', sill: '#b995a8', look, flush: { reveal: '#3a2a5a' } }));
    const back = new Mesh(new PlaneGeometry(24, 3), toon('#d98f6a', { look }));
    back.position.set(3.5, 5.6, -6);
    scene.add(back);
  }

  if (has('facade')) {
    const windows = new WindowBuilder();
    scene.add(makeBuilding({ x: 9, z: -1, width: 8, depth: 6, height: 9, color: '#e6b06e', look, seed: 5, windows, faces: ['front', 'left', 'right', 'back'] }));
    scene.add(makeBuilding({ x: -22, z: -30, width: 12, depth: 8, height: 14, color: '#9a86c2', look, seed: 6, parapet: 0 }));
    scene.add(windows.build({ frame: '#f3e3d0', sill: '#caa48f', look }));
  }

  if (has('props')) {
    const props = makePropKit(look, {
      metal: '#b9a6c4', metalDark: '#5a4680', ac: '#efe2d6', pipe: '#c47a6a', tank: '#5fa8b0', pot: '#c9705a', leaf: '#6fb37a', leafDark: '#3f8a6a',
      cloth: ['#fff3e2', '#7fd0e0', '#ff9db0'], sign: ['#ff6f91', '#3fb6c9', '#ffc24a'], board: '#6a4a8a', pole: '#a8615c',
    });
    props.acUnit(new Vector3(-7, 0, 3), 0.3, 1.4);
    props.pipe([new Vector3(-6, 0.2, 2), new Vector3(-6, 0.2, 5), new Vector3(-3, 0.2, 5)]);
    props.duct(new Vector3(-5, 0.3, 1), new Vector3(-2.5, 0.3, 1));
    props.antenna(new Vector3(-4.5, 0, 3), 2.6, 3);
    props.smallTank(new Vector3(-2.6, 0, 3.2));
    props.sign(new Vector3(-0.8, 0, 3), 1.6, 1, 4, 0.3, 1.2);
    props.laundry(new Vector3(0.6, 1.8, 4.2), new Vector3(3.6, 1.8, 3.4), 5);
    props.plantPot(new Vector3(1.2, 0, 5.4), 6);
    props.vent(new Vector3(2.4, 0, 5.2), 7);
    props.vent(new Vector3(3.3, 0, 5.2), 8);
    props.railing(new Vector3(-8, 0, 6.2), new Vector3(4, 0, 6.2));
    props.bicycle(new Vector3(4.6, 0, 5), 0.4, 9);
    props.utilityPole(new Vector3(5.6, 0, 3), 6, true);
    scene.add(props.finish());
  }

  if (has('outline')) {
    const solid = new Mesh(new BoxGeometry(1.4, 1.4, 1.4), toon('#ffd27a', { look }));
    solid.position.set(-12, 0.7, 7.5);
    addOutline(solid, outlineMaterial('#2c1b4d', { px: 2 }));
    const flat = new Mesh(new PlaneGeometry(1.6, 1.0), toon('#ffffff', { look }));
    flat.position.set(-9.6, 1.4, 7.5);
    flat.rotation.set(-0.5, 0.4, 0.1);
    addOutline(flat, outlineMaterial('#2c1b4d', { px: 2, mode: 'flat' }));
    scene.add(solid, flat);
  }

  if (has('reflect')) {
    const ripple = rippleTexture(7);
    const colours = ['#ff3d9a', '#3de0ff', '#ffd23d'];
    colours.forEach((color, i) => {
      const sign = new Mesh(new PlaneGeometry(1.8, 0.8), new MeshBasicMaterial({ color }));
      sign.position.set(-3 + i * 3.2, 2.6 + i * 0.5, 0.5);
      scene.add(sign);
      // One as a true mirror, the others as wet streets are drawn (starting under the object).
      scene.add(makeReflection(sign, { groundY: 0, color, ripple, drop: i === 0 ? 0 : 1, stretch: i === 0 ? 2.2 : 3 }));
    });
  }

  if (has('glow')) {
    const g = makeGlow('#ffd9a0', 3, 1.2);
    g.mesh.position.set(11, 4.5, 4);
    g.mesh.layers.enable(OCCLUDE_LAYER);
    scene.add(g.mesh);
    glows.push(g);
  }

  if (has('edges')) post.setEdges({ color: '#2c1b4d', farColor: '#8a5f9e', fadeNear: 12, fadeFar: 70, farOpacity: 0.3, occluders: true });
  if (has('bloom')) post.setBloom({ strength: 0.5, radius: 0.5, threshold: 0.85 });
  if (has('grade')) post.setGrade({ saturation: 1.08, tint: '#fff6ee', lift: '#120a26', vignette: 0.4, vignetteTint: '#8a5aa8' });
  // The grain changes every second frame here, so the test also covers the frame-dependent path.
  if (has('grain')) post.setGrain({ amount: 0.05, size: 1, every: 2 });
}

function renderFrame(frame: number): void {
  const f = Math.max(0, Math.min(FRAMES - 1, Math.round(frame)));
  const t = f / (FRAMES - 1);
  camera.position.set(-6 + 12 * t, 5.5 + t, 24 - 3 * t);
  camera.lookAt(0, 4.2, 0);
  camera.updateMatrixWorld();
  setLookDir([look, flatLook], SUN, camera.matrixWorldInverse);
  for (const g of glows) g.faceCamera(camera);
  post.render(f);
}

const ready = (async () => {
  build();
  renderer.compile(scene, camera);
  renderFrame(0);
})();

window.__video = { fps: FPS, durationInFrames: FRAMES, ready, renderFrame };
