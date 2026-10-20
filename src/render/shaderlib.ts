import * as THREE from 'three';
import { MAP_D, MAP_W, VOXEL, WATER_Y, WY } from '../core/config';
import { MAT_COUNT, MATS } from '../world/materials';

/** Uniforms shared by every world material. Mutated once per frame by the renderer. */
export const shared = {
  uTime: { value: 0 },
  uResolution: { value: new THREE.Vector2(1, 1) },
  // cutouts: xy = screen uv, z = view depth of the focus, w = radius (screen-height units)
  uCutA: { value: new THREE.Vector4(0.5, 0.5, 1e9, 0) },
  uCutB: { value: new THREE.Vector4(0.5, 0.5, 1e9, 0) },
  uCutH: { value: new THREE.Vector2(999, 999) },
  uPalette: { value: [] as THREE.Vector4[] },
  uMatParams: { value: [] as THREE.Vector4[] },
  uWaterY: { value: WATER_Y },
  uWind: { value: new THREE.Vector2(0.8, 0.35) },
  /** baked sky visibility volume (see world/skyLight.ts) */
  tSky: { value: null as THREE.Texture | null },
  /** 0 = sky occlusion off (lowest quality), 1 = on */
  uSkyAmt: { value: 1 },
  /** world-space direction toward the sun (the renderer's sunDir is this vector) */
  uSunDir: { value: new THREE.Vector3(-0.55, 0.68, 0.48).normalize() },
  /** sun irradiance: colour x intensity */
  uSunCol: { value: new THREE.Color(3.25, 2.97, 2.6) },
  /** sky and ground radiance, as seen in reflections */
  uSkyRad: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uGroundRad: { value: new THREE.Color(0.1, 0.12, 0.05) },
  /** sunlight bounced off the valley floor onto walls and undersides (already divided by pi) */
  uBounce: { value: new THREE.Color(0, 0, 0) },
  /** 0 = plain Lambert (lowest quality), 1 = highlights, reflections, bounce and translucency */
  uFancy: { value: 1 },
};

const KIND = { ground: 0, stone: 1, wood: 2, leaf: 3, build: 4, metal: 5, soft: 6, glow: 7 };
for (let i = 0; i < MAT_COUNT; i++) {
  const m = MATS[i];
  const c = new THREE.Color(m.color); // converts sRGB -> linear working space
  shared.uPalette.value.push(new THREE.Vector4(c.r, c.g, c.b, m.vary));
  shared.uMatParams.value.push(new THREE.Vector4(m.bevel, KIND[m.kind], 0, 0));
}

export const GLSL_COMMON = /* glsl */ `
#define VOX ${VOXEL.toFixed(3)}
#define MAP_SIZE vec2(${MAP_W.toFixed(2)}, ${MAP_D.toFixed(2)})
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.875;
}
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
`;

export const GLSL_CLOUDS = /* glsl */ `
float cloudShadow(vec2 xz, float t) {
  vec2 p = xz * 0.018 + vec2(t * 0.012, t * 0.006);
  float c = fbm2(p);
  return mix(0.5, 1.0, smoothstep(0.42, 0.62, c));
}
float caustics(vec2 p, float t) {
  vec2 q = p * 1.6;
  float c = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 r = q + vec2(sin(t * 0.9 + q.y * 1.3), cos(t * 0.8 + q.x * 1.1)) * 0.6;
    c += abs(sin(r.x * 2.1 + t) * cos(r.y * 1.9 - t * 0.7));
    q = q * 1.7 + 3.1;
  }
  c = 1.0 - c * 0.5;
  return pow(clamp(c, 0.0, 1.0), 5.0);
}
`;

export const GLSL_CUTOUT = /* glsl */ `
uniform vec4 uCutA;
uniform vec4 uCutB;
uniform vec2 uCutH;
uniform vec2 uResolution;
void applyCutout(float viewZ, float worldY) {
  vec2 sp = gl_FragCoord.xy / uResolution;
  float asp = uResolution.x / uResolution.y;
  float keep = 1.0;
  {
    vec2 d = (sp - uCutA.xy) * vec2(asp, 1.0);
    float r = length(d) / max(uCutA.w, 1e-4);
    if (viewZ < uCutA.z - 1.2 && worldY > uCutH.x) keep = min(keep, smoothstep(0.7, 1.0, r));
  }
  {
    vec2 d = (sp - uCutB.xy) * vec2(asp, 1.0);
    float r = length(d) / max(uCutB.w, 1e-4);
    if (viewZ < uCutB.z - 1.2 && worldY > uCutH.y) keep = min(keep, smoothstep(0.65, 1.0, r));
  }
  if (keep < 0.999 && keep < bayer4(gl_FragCoord.xy)) discard;
}
`;

/**
 * three's light loop, unchanged except that the sun's shadow term is also kept in sunShadow
 * so highlights and translucency can respect it. Falls back to 1 if three's chunk changes shape.
 */
export const LIGHTS_BEGIN_SHADOW = (() => {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const key = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]';
  const at = src.indexOf(key);
  if (at < 0) return 'float sunShadow = 1.0;\n#include <lights_fragment_begin>';
  const end = src.indexOf(';', at);
  const expr = src.slice(at + 'directLight.color *= '.length, end);
  return `float sunShadow = 1.0;\n${src.slice(0, at)}sunShadow = ${expr};\ndirectLight.color *= sunShadow${src.slice(end)}`;
})();

/** Sun highlights and sky reflections on top of the Lambert base. */
export const GLSL_SHADE = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyRad;
uniform vec3 uGroundRad;
uniform vec3 uBounce;
uniform float uFancy;
// normalised Blinn-Phong sun highlight with Schlick fresnel
vec3 sunSpec(vec3 N, vec3 V, vec3 F0, float shin) {
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.0);
  float vh = max(dot(V, H), 0.0);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  // stand-in for the masking term: faces seen edge-on must not flare
  float nv = smoothstep(0.0, 0.3, dot(N, V));
  return F * (pow(nh, shin) * (shin + 8.0) * 0.0398 * max(dot(N, uSunDir), 0.0) * nv) * uSunCol;
}
// sky (or ground) in the mirror direction; rough surfaces only catch it at grazing angles
vec3 envSpec(vec3 N, vec3 V, vec3 F0, float rough) {
  vec3 R = reflect(-V, N);
  float nv = max(dot(N, V), 0.0);
  vec3 F = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - nv, 5.0);
  return F * mix(uGroundRad, uSkyRad, smoothstep(-0.15, 0.3, R.y));
}
`;

/** Large-scale sky visibility from the baked volume. p in world metres, n the surface normal. */
export const GLSL_SKY = /* glsl */ `
uniform highp sampler3D tSky;
uniform float uSkyAmt;
float skyVis(vec3 p, vec3 n) {
  vec3 q = p + n * 0.45;
  vec3 uvw = vec3(q.x / ${MAP_W.toFixed(2)}, q.z / ${MAP_D.toFixed(2)}, q.y / ${(WY * VOXEL).toFixed(2)});
  float v = texture(tSky, uvw).r;
  return mix(1.0, v, uSkyAmt);
}
`;
