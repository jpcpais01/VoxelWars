import * as THREE from 'three';
import { GV } from '../game/gunVoxels';

/**
 * Lit material for the fine (0.5 cm) voxel guns and hands seen up close (viewmodel, loadout preview).
 * Per-vertex finish (aFin: specular, glow) lets metal, polymer, glass and lit dots share one
 * draw; each voxel gets a faint bevel and a little colour variation so the grid reads clearly.
 */
export function createGunMaterial() {
  // double sided so a near plane slicing through the gun shows a dark solid cut, not a hollow shell
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0xb8b8b8, shininess: 42, side: THREE.DoubleSide });
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
  vec3 an = abs(vGN);
  vec2 uq = an.x > 0.5 ? q.yz : an.y > 0.5 ? q.xz : q.xy;
  vec2 uv = fract(uq);
  vec2 e2 = min(uv, 1.0 - uv);
  // the bevel and per-voxel jitter fade out once a voxel shrinks to a few pixels, so the fine
  // grid reads as crisp detail up close and never turns into moire further away
  float fade = 1.0 - smoothstep(0.14, 0.34, length(fwidth(uq)));
  float edge = smoothstep(0.0, 0.16, min(e2.x, e2.y));
  float jit = 1.0 + (gHash(cell) - 0.5) * mix(0.05, 0.11, fade);
  diffuseColor.rgb *= jit * mix(1.0 - 0.17 * fade, 1.0, edge) * (vGN.y > 0.5 ? 1.08 : vGN.y < -0.5 ? 0.82 : 1.0);
}`,
      )
      .replace(
        '#include <lights_phong_fragment>',
        `#include <lights_phong_fragment>
material.specularColor *= vFin.x;
material.specularShininess = mix(10.0, 64.0, vFin.x);`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vFin.y * 4.0;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\nif (!gl_FrontFacing) gl_FragColor.rgb = vColor.rgb * 0.1;`);
  };
  mat.customProgramCacheKey = () => 'gunvox';
  return mat;
}
