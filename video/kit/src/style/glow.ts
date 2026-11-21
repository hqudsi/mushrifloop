/**
 * A soft additive glow disc that always faces the camera: halos around lamps, the moon, headlights.
 * Call `faceCamera` once per frame after the camera is placed.
 */

import { AdditiveBlending, Color, type Camera, type IUniform, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

export interface Glow {
  mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  uniforms: { color: IUniform<Color>; intensity: IUniform<number> };
  faceCamera(camera: Camera): void;
}

export function makeGlow(color: string, size: number, intensity = 1): Glow {
  const uniforms = { color: { value: new Color(color) }, intensity: { value: intensity } };
  const material = new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float intensity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = exp(-r * r * 6.0) * 0.8 + exp(-r * r * 40.0) * 0.6;
        a *= 1.0 - smoothstep(0.8, 1.0, r);
        gl_FragColor = vec4(color * a * intensity, 1.0);
      }
    `,
  });
  const mesh = new Mesh(new PlaneGeometry(size, size), material);
  mesh.renderOrder = 7;
  return {
    mesh,
    uniforms,
    faceCamera(camera) {
      mesh.quaternion.copy(camera.quaternion);
    },
  };
}
