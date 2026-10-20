import * as THREE from 'three';
import { MAT_COUNT } from '../world/materials';
import { GLSL_CLOUDS, GLSL_COMMON, GLSL_CUTOUT, GLSL_SHADE, GLSL_SKY, LIGHTS_BEGIN_SHADOW, shared } from './shaderlib';

/**
 * Voxel surface material: Lambert lighting (sun + hemisphere + shadows) extended with
 * palette lookup, per-voxel colour jitter, bevelled edges, baked AO, cloud shadows,
 * underwater caustics, wind sway on foliage, baked sky visibility and a dithered x-ray cutout.
 * On top of that: sun highlights and sky reflections per material kind, wet shorelines, warm
 * sunlight bounced up from the valley floor and light glowing through leaves.
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
${GLSL_SHADE}
${cut ? GLSL_CUTOUT : ''}
uniform float uTime;
uniform float uWaterY;
// per kind: x = highlight strength, y = shininess, z = roughness for sky reflections, w = metalness
const vec4 KSPEC[8] = vec4[8](
  vec4(0.22, 10.0, 0.92, 0.0), // ground
  vec4(0.55, 24.0, 0.75, 0.0), // stone
  vec4(0.3, 14.0, 0.85, 0.0), // wood
  vec4(0.6, 28.0, 0.86, 0.0), // leaf: waxy glints
  vec4(0.7, 40.0, 0.6, 0.0), // build: paint, tiles, concrete
  vec4(1.0, 80.0, 0.38, 0.8), // metal
  vec4(0.12, 8.0, 0.95, 0.0), // soft
  vec4(0.0, 8.0, 1.0, 0.0) // glow
);
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
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN_SHADOW)
      .replace(
        '#include <aomap_fragment>',
        `
float ao = vAO;
ao = 0.32 + 0.68 * ao;
vec3 wN = normalize(vWorldN);
float sky = skyVis(vWorldP, wN);
float cloud = cloudShadow(vWorldP.xz, uTime);
vec3 alb = diffuseColor.rgb;
if (uFancy > 0.0) {
  // warm sunlight bounced off the valley floor fills walls, overhangs and undersides
  reflectedLight.indirectDiffuse += alb * uBounce * (0.5 - 0.5 * wN.y) * cloud * mix(0.25, 1.0, sky);
}
reflectedLight.indirectDiffuse *= ao * sky;
reflectedLight.directDiffuse *= mix(1.0, ao, 0.3) * mix(0.82, 1.0, sky);
reflectedLight.directDiffuse *= cloud;
if (uFancy > 0.0 && vWorldP.y >= uWaterY) {
  vec3 V = normalize(cameraPosition - vWorldP);
  vec4 ks = KSPEC[kind];
  float shin = ks.y, rough = ks.z, str = ks.x;
  // the shoreline is wet: darker, and glossy enough to mirror the sky
  float wet = (kind <= 1) ? 1.0 - smoothstep(0.05, 0.6, vWorldP.y - uWaterY) : 0.0;
  reflectedLight.directDiffuse *= 1.0 - wet * 0.4;
  reflectedLight.indirectDiffuse *= 1.0 - wet * 0.4;
  shin = mix(shin, 60.0, wet);
  rough = mix(rough, 0.25, wet);
  str = mix(str, 1.0, wet);
  // metals keep little diffuse light and tint what they reflect
  reflectedLight.directDiffuse *= 1.0 - ks.w * 0.45;
  reflectedLight.indirectDiffuse *= 1.0 - ks.w * 0.3;
  vec3 F0 = mix(vec3(0.04), alb, ks.w);
  // per-voxel variation so flat faces glint unevenly
  str *= 0.6 + 0.8 * h;
  totalEmissiveRadiance += sunSpec(wN, V, F0, shin) * (str * sunShadow * cloud * mix(0.5, 1.0, sky));
  totalEmissiveRadiance += envSpec(wN, V, F0, rough) * (ao * sky * (0.4 + 0.6 * str));
  if (kind == 3) {
    // sunlight glowing through the leaves, strongest when looking toward the sun
    float back = pow(max(dot(-V, uSunDir), 0.0), 4.0);
    float thru = 0.2 + 0.8 * max(-dot(wN, uSunDir), 0.0);
    float tr = (0.03 + back * 0.8) * thru * sky * sky * cloud * ao;
    totalEmissiveRadiance += alb * vec3(1.05, 1.2, 0.55) * uSunCol * (tr * 0.2);
  }
}
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
${GLSL_SHADE}
uniform float uTime;
varying vec3 vGCol;
varying float vGW;
varying vec3 vWorldP;`,
      )
      .replace('#include <color_fragment>', `diffuseColor.rgb = vGCol;`)
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN_SHADOW)
      .replace(
        '#include <aomap_fragment>',
        `
float ao = mix(0.62, 1.0, vGW);
float sky = skyVis(vWorldP, vec3(0.0, 1.0, 0.0));
float cloud = cloudShadow(vWorldP.xz, uTime);
reflectedLight.indirectDiffuse *= ao * sky;
reflectedLight.directDiffuse *= mix(0.7, 1.0, vGW) * cloud;
totalEmissiveRadiance += vGCol * 0.12 * vGW * sky;
if (uFancy > 0.0) {
  // backlit blade tips glow when the sun is in front of you
  vec3 V = normalize(cameraPosition - vWorldP);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  totalEmissiveRadiance += vGCol * vec3(1.05, 1.15, 0.5) * uSunCol * ((0.04 + back * 0.4) * vGW * sky * cloud * sunShadow * 0.3);
}
`,
      );
  };
  mat.customProgramCacheKey = () => 'grass';
  return mat;
}
