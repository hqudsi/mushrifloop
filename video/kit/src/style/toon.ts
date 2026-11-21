/**
 * Cel shading: MeshToonMaterial with a 3-step gradient map (flat tone bands), plus a shared "look":
 * - a shadow colour that replaces the ambient term, so shaded sides take the shot's accent hue
 *   (tinted by the object's own colour) instead of going grey;
 * - a banded rim light on the edges that face the key light (a warm edge on back-lit silhouettes).
 */

import { Color, DataTexture, FrontSide, type IUniform, type Matrix4, MeshToonMaterial, NearestFilter, RGBAFormat, type Side, type Texture, Vector3 } from 'three';

let gradient: DataTexture | null = null;

/** Three flat bands: shadow, mid, lit. */
export function toonGradient(): DataTexture {
  if (gradient) return gradient;
  // The lowest band has no direct light at all: it shows the shot's shade colour only.
  const steps = [0, 165, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradient = new DataTexture(data, steps.length, 1, RGBAFormat);
  gradient.minFilter = NearestFilter;
  gradient.magFilter = NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

/**
 * Uniforms shared by the toon materials of one shot. Set `rimDir` (view-space direction towards the
 * key light) once per frame with `setLookDir` and all materials follow.
 */
export interface ToonLook {
  rimColor: IUniform<Color>;
  rimDir: IUniform<Vector3>;
  rimStrength: IUniform<number>;
  shadeColor: IUniform<Color>;
  /** 0: shadows are exactly shadeColor; 1: shadeColor × the object's colour. */
  shadeAlbedo: IUniform<number>;
  /** Upper limit of the shaded colour (keeps e.g. the white plane from blooming). */
  maxLight: IUniform<number>;
  /** How much of the shade colour remains on lit bands (1 = all of it). */
  shadeInLight: IUniform<number>;
  /**
   * Fill inside the shade band: faces turned up get `skyFill`, faces turned towards the side
   * direction get the weaker `sideFill`, so a form that is wholly in shadow (a back-lit pole, a
   * railing against the sky) still reads in two or three tones instead of one flat silhouette.
   * On unless `makeLook` is given `fill: false`.
   */
  skyFill?: IUniform<Color>;
  sideFill?: IUniform<Color>;
  upView?: IUniform<Vector3>;
  sideView?: IUniform<Vector3>;
}

/** World direction of each look's side fill. */
const sideWorld = new WeakMap<ToonLook, Vector3>();

export function makeLook(o: {
  rim: string;
  rimStrength?: number;
  shade: string;
  shadeAlbedo?: number;
  maxLight?: number;
  shadeInLight?: number;
  /**
   * Fill in shade: colour of the up-facing fill, of the side fill, and the side fill's world direction.
   * Left out, it is derived from the shade colour (a lighter and a middle step of the same hue), so a
   * back-lit object never comes out as one flat colour. `false` switches it off.
   */
  fill?: { sky: string; side: string; sideDir?: Vector3 } | false;
}): ToonLook {
  const look: ToonLook = {
    rimColor: { value: new Color(o.rim) },
    rimDir: { value: new Vector3(0, 0, -1) },
    rimStrength: { value: o.rimStrength ?? 1 },
    shadeColor: { value: new Color(o.shade) },
    shadeAlbedo: { value: o.shadeAlbedo ?? 0.6 },
    maxLight: { value: o.maxLight ?? 100 },
    shadeInLight: { value: o.shadeInLight ?? 0.35 },
  };
  if (o.fill !== false) {
    const shade = new Color(o.shade);
    look.skyFill = { value: o.fill ? new Color(o.fill.sky) : shade.clone().multiplyScalar(0.7) };
    look.sideFill = { value: o.fill ? new Color(o.fill.side) : shade.clone().multiplyScalar(0.38) };
    look.upView = { value: new Vector3(0, 1, 0) };
    look.sideView = { value: new Vector3(0, 0, 1) };
    sideWorld.set(look, (o.fill && o.fill.sideDir ? o.fill.sideDir.clone() : new Vector3(1, 0, 0.35)).normalize());
  }
  return look;
}

/**
 * Call once per frame, after the camera is placed (`camera.updateMatrixWorld()` first): points the rim
 * of every look at `worldDir` (the direction towards the key light) and turns the shade fill with the
 * camera. `viewInverse` is `camera.matrixWorldInverse`.
 */
export function setLookDir(looks: ToonLook[], worldDir: Vector3, viewInverse: Matrix4): void {
  for (const l of looks) {
    l.rimDir.value.copy(worldDir).transformDirection(viewInverse);
    const side = sideWorld.get(l);
    if (l.upView && l.sideView && side) {
      l.upView.value.set(0, 1, 0).transformDirection(viewInverse);
      l.sideView.value.copy(side).transformDirection(viewInverse);
    }
  }
}

export interface ToonOptions {
  look?: ToonLook;
  side?: Side;
  emissive?: string;
  emissiveIntensity?: number;
  fog?: boolean;
  /** A painted texture from `paint.ts` (a near-white multiplier): the colour stays the material's own. */
  map?: Texture;
  /**
   * 0–1: how strongly the map also shows in the shade band (default 0.6 when a map is given, else 0).
   * Give it only for a material that has a map, here or set on it before the first frame.
   */
  mapInShade?: number;
}

export function toon(color: string, opts: ToonOptions = {}): MeshToonMaterial {
  const mat = new MeshToonMaterial({
    color: new Color(color),
    gradientMap: toonGradient(),
    side: opts.side ?? FrontSide,
    fog: opts.fog ?? true,
  });
  if (opts.emissive) {
    mat.emissive = new Color(opts.emissive);
    mat.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  if (opts.map) mat.map = opts.map;
  const look = opts.look;
  if (look) {
    const fill = !!look.skyFill;
    const mapShade = opts.mapInShade ?? (opts.map ? 0.6 : 0);
    // The extras only enter the shader when used, so plain looks compile to the same program as before.
    const shadeExpr = mapShade > 0
      ? `shadeWeight * shadeColor * mix(vec3(1.0), diffuseColor.rgb, shadeAlbedo) * mix(vec3(1.0), sampledDiffuseColor.rgb, ${mapShade.toFixed(3)})`
      : 'shadeWeight * shadeColor * mix(vec3(1.0), diffuseColor.rgb, shadeAlbedo)';
    const fillCode = fill
      ? `
          {
            // Sky fill in the shade band: up-facing faces lighter and cooler, side faces a step between.
            float inShade = 1.0 - step(0.02, directLum);
            float upF = step(0.55, dot(normal, normalize(upView)));
            float sideF = step(0.6, dot(normal, normalize(sideView))) * (1.0 - upF);
            outgoingLight += inShade * (skyFill * upF + sideFill * sideF) * mix(vec3(1.0), diffuseColor.rgb, 0.5);
            // And the faces turned the other way a step darker: three tones round a pole, not one.
            float awayF = step(0.6, dot(normal, -normalize(sideView))) * (1.0 - upF);
            outgoingLight *= 1.0 - inShade * awayF * 0.2;
          }`
      : '';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, look);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform vec3 rimColor;\nuniform vec3 rimDir;\nuniform float rimStrength;\nuniform vec3 shadeColor;\nuniform float shadeAlbedo;\nuniform float maxLight;\nuniform float shadeInLight;\n' +
            (fill ? 'uniform vec3 skyFill;\nuniform vec3 sideFill;\nuniform vec3 upView;\nuniform vec3 sideView;\n' : '') +
            'void main() {',
        )
        .replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          `// The shade colour fills the unlit band fully; in lit bands only a trace of it remains, so lit
          // surfaces keep the light's own warm hue instead of mixing towards grey.
          float directLum = dot(reflectedLight.directDiffuse, vec3(0.3, 0.59, 0.11));
          float shadeWeight = directLum > 0.02 ? shadeInLight : 1.0;
          vec3 outgoingLight = reflectedLight.directDiffuse + ${shadeExpr} + totalEmissiveRadiance;${fillCode}
          {
            vec3 vd = normalize(vViewPosition);
            // Only grazing edges whose normal clearly faces the light: large flat surfaces (a floor
            // lit at a low angle) never get a rim, so no arcs appear across them.
            float fres = 1.0 - abs(dot(normal, vd));
            float toward = dot(normal, normalize(rimDir));
            float rimMask = step(0.72, fres) * step(0.45, toward);
            outgoingLight += rimColor * rimMask * rimStrength * diffuseColor.rgb;
            outgoingLight = min(outgoingLight, vec3(maxLight));
          }`,
        );
    };
    const key = fill || mapShade > 0 ? `toon-look|${fill ? 'fill' : ''}|${mapShade}` : 'toon-look';
    mat.customProgramCacheKey = () => key;
  }
  return mat;
}
