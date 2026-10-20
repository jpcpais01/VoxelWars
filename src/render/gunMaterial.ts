import * as THREE from 'three';
import { GV } from '../game/gunVoxels';

/**
 * Lit material for the fine voxel guns and hands seen up close (viewmodel, loadout preview).
 * Per-vertex finish (aFin: specular, glow) lets metal, polymer, glass and lit dots share one
 * draw; each voxel gets a faint bevel and a little colour variation so the grid reads clearly.
 */
export function createGunMaterial() {
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0xb8b8b8, shininess: 42 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aFin;\nvarying vec2 vFin;\nvarying vec3 vGP;\nvarying vec3 vGN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFin = aFin;\nvGP = position;\nvGN = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vFin;
varying vec3 vGP;
varying vec3 vGN;
float gHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 q = vGP / ${GV.toFixed(4)} + 0.5;
  vec3 cell = floor(q - vGN * 0.5);
  vec3 f = fract(q);
  vec3 an = abs(vGN);
  vec2 uv = an.x > 0.5 ? f.yz : an.y > 0.5 ? f.xz : f.xy;
  vec2 e2 = min(uv, 1.0 - uv);
  float edge = smoothstep(0.0, 0.16, min(e2.x, e2.y));
  float jit = 0.94 + 0.12 * gHash(cell);
  diffuseColor.rgb *= jit * mix(0.8, 1.0, edge) * (vGN.y > 0.5 ? 1.08 : vGN.y < -0.5 ? 0.82 : 1.0);
}`,
      )
      .replace(
        '#include <lights_phong_fragment>',
        `#include <lights_phong_fragment>
material.specularColor *= vFin.x;
material.specularShininess = mix(10.0, 64.0, vFin.x);`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vFin.y * 4.0;`);
  };
  mat.customProgramCacheKey = () => 'gunvox';
  return mat;
}
