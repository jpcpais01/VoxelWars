import * as THREE from 'three';
import { MAT_COUNT } from '../world/materials';
import { GLSL_CLOUDS, GLSL_COMMON, GLSL_CUTOUT, GLSL_SKY, shared } from './shaderlib';

/**
 * Voxel surface material: Lambert lighting (sun + hemisphere + shadows) extended with
 * palette lookup, per-voxel colour jitter, bevelled edges, baked AO, cloud shadows,
 * underwater caustics, wind sway on foliage, baked sky visibility and a dithered x-ray cutout.
 *
 * Geometry is the packed 8-byte format from the mesher: positions in whole voxels (the mesh
 * transform scales them to metres) and the face index in aData.z, from which the normal is rebuilt.
 * Falling bodies pass `offset` (world metres of their local origin) so their per-voxel colour
 * hash stays put while the mesh rotates.
 */
export function createVoxelMaterial(opts: { cutout?: boolean; offset?: THREE.Vector3 } = {}) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const offset = { value: opts.offset ?? new THREE.Vector3() };
  const cut = opts.cutout !== false;
  const body = !!opts.offset;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uVoxOffset: offset });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `int faceI = int(aData.z + 0.5);
int axisI = faceI / 2;
float sgn = faceI - axisI * 2 == 0 ? 1.0 : -1.0;
vec3 objectNormal = vec3(axisI == 0 ? sgn : 0.0, axisI == 1 ? sgn : 0.0, axisI == 2 ? sgn : 0.0);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`,
      )
      .replace(
        '#include <common>',
        `#include <common>
${GLSL_COMMON}
attribute vec4 aData;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uVoxOffset;
varying vec3 vVoxPos;
varying vec3 vObjNormal;
varying vec3 vWorldP;
varying vec3 vWorldN;
varying float vAO;
flat varying float vMat;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vMat = aData.x;
vAO = aData.y / 255.0;
vObjNormal = objectNormal;
${body ? 'vVoxPos = position * VOX + uVoxOffset;' : 'vVoxPos = (modelMatrix * vec4(position, 1.0)).xyz;'}
int kind = int(aData.x + 0.5);
if (kind >= 12 && kind <= 16 || kind == 30 || kind == 44) {
  vec3 wp = vVoxPos;
  float ph = uTime * 1.6 + wp.x * 0.35 + wp.z * 0.27;
  float sway = sin(ph) * 0.5 + sin(ph * 2.3 + 1.7) * 0.25;
  // local units are voxel cells, which grow with the chunk's LOD
  float unit = length(modelMatrix[0].xyz);
  transformed.xz += uWind * sway * (0.055 / unit);
  transformed.y += sin(ph * 1.7) * (0.015 / unit);
}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 wpv = modelMatrix * vec4(transformed, 1.0);
vWorldP = wpv.xyz;
vWorldN = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${GLSL_COMMON}
${GLSL_CLOUDS}
${GLSL_SKY}
${cut ? GLSL_CUTOUT : ''}
uniform float uTime;
uniform float uWaterY;
uniform vec4 uPalette[${MAT_COUNT}];
uniform vec4 uMatParams[${MAT_COUNT}];
varying vec3 vVoxPos;
varying vec3 vObjNormal;
varying vec3 vWorldP;
varying vec3 vWorldN;
varying float vAO;
flat varying float vMat;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
${cut ? 'applyCutout(vViewPosition.z, vWorldP.y);' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `
int mi = int(vMat + 0.5);
vec4 pal = uPalette[mi];
vec4 prm = uMatParams[mi];
int kind = int(prm.y + 0.5);
vec3 on = normalize(vObjNormal);
vec3 cellf = vVoxPos / VOX - on * 0.5;
vec3 cell = floor(cellf);
float h = hash13(cell);
vec3 col = pal.rgb * (1.0 + (h - 0.5) * 2.0 * pal.w);
vec3 fr = fract(vVoxPos / VOX);
float top = step(0.5, on.y);
// broad colour fields keep big surfaces from looking flat
float broad = fbm2(vWorldP.xz * 0.045);
if (mi == 3 || mi == 37) {
  vec3 dry = vec3(0.55, 0.52, 0.16);
  vec3 lush = vec3(0.12, 0.30, 0.06);
  col = mix(col, mix(lush, dry, broad), 0.35 * top);
  if (top < 0.5 && on.y > -0.5) {
    // grass side: soil with a green fringe
    float fringe = step(0.72 - h * 0.18, fr.y);
    col = mix(uPalette[2].rgb * (0.9 + h * 0.2), col, fringe);
  }
} else if (kind == 3) {
  col *= 0.86 + broad * 0.32;
  col = mix(col, col * vec3(1.15, 1.12, 0.75), top * 0.35);
} else if (kind == 1) {
  if (top > 0.5) col = mix(col, vec3(0.16, 0.26, 0.07), smoothstep(0.35, 0.7, fbm2(vVoxPos.xz * 0.6 + cell.y)) * 0.75);
} else if (mi == 31) {
  col *= 0.9 + broad * 0.2;
}
// bevelled voxel edges
vec2 fuv = abs(on.x) > 0.5 ? fr.yz : (abs(on.y) > 0.5 ? fr.xz : fr.xy);
vec2 eg = min(fuv, 1.0 - fuv);
float ed = min(eg.x, eg.y);
float bev = smoothstep(0.0, 0.11, ed);
// fade the edge lines out once a voxel shrinks to a few pixels, before they shimmer
float bevK = 1.0 - smoothstep(0.12, 0.4, length(fwidth(vVoxPos)) / VOX);
col *= mix(1.0 - prm.x * 0.38 * bevK, 1.0, bev);
col *= 1.0 + (1.0 - smoothstep(0.0, 0.05, ed)) * top * prm.x * 0.25 * bevK;
diffuseColor.rgb = col;
`,
      )
      .replace(
        '#include <aomap_fragment>',
        `
float ao = vAO;
ao = 0.32 + 0.68 * ao;
float sky = skyVis(vWorldP, normalize(vWorldN));
reflectedLight.indirectDiffuse *= ao * sky;
reflectedLight.directDiffuse *= mix(1.0, ao, 0.3) * mix(0.82, 1.0, sky);
reflectedLight.directDiffuse *= cloudShadow(vWorldP.xz, uTime);
if (vWorldP.y < uWaterY) {
  float depth = uWaterY - vWorldP.y;
  float c = caustics(vWorldP.xz, uTime);
  float fade = exp(-depth * 0.7);
  reflectedLight.directDiffuse *= 0.55 + c * 2.2 * fade;
  reflectedLight.indirectDiffuse *= mix(vec3(0.6, 0.85, 0.85), vec3(1.0), fade);
}
if (kind == 7) totalEmissiveRadiance += diffuseColor.rgb * 3.0;
`,
      );
  };
  mat.customProgramCacheKey = () => `voxel-${cut ? 'cut' : 'solid'}-${body ? 'body' : 'chunk'}`;
  return mat;
}

/** Grass tufts: vertex coloured blades with wind, lit like the ground beneath. */
export function createGrassMaterial() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aCol;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vGCol;
varying float vGW;
varying vec3 vWorldP;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3(0.0, 1.0, 0.0);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
float w = aCol.a;
float ph = uTime * 2.2 + position.x * 0.9 + position.z * 0.7;
float g = sin(ph) * 0.6 + sin(ph * 2.7 + 0.5) * 0.3 + sin(uTime * 0.6 + position.x * 0.08) * 0.6;
transformed.xz += uWind * g * 0.09 * w;
transformed.y -= abs(g) * 0.02 * w;
// blades sink into the ground with distance so the grass edge never pops
float gFar = smoothstep(30.0, 42.0, distance(cameraPosition.xz, position.xz));
transformed.y -= gFar * 0.4 * w;
vGCol = pow(aCol.rgb, vec3(2.2));
vGW = w;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${GLSL_COMMON}
${GLSL_CLOUDS}
${GLSL_SKY}
uniform float uTime;
varying vec3 vGCol;
varying float vGW;
varying vec3 vWorldP;`,
      )
      .replace('#include <color_fragment>', `diffuseColor.rgb = vGCol;`)
      .replace(
        '#include <aomap_fragment>',
        `
float ao = mix(0.62, 1.0, vGW);
float sky = skyVis(vWorldP, vec3(0.0, 1.0, 0.0));
reflectedLight.indirectDiffuse *= ao * sky;
reflectedLight.directDiffuse *= mix(0.7, 1.0, vGW) * cloudShadow(vWorldP.xz, uTime);
totalEmissiveRadiance += vGCol * 0.12 * vGW * sky;
`,
      );
  };
  mat.customProgramCacheKey = () => 'grass';
  return mat;
}
