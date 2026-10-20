import * as THREE from 'three';
import { MAP_D, MAP_W, VOXEL, WATER_Y, WX, WY, WZ } from '../core/config';
import { World } from '../world/World';
import { GLSL_COMMON, shared } from './shaderlib';

/** Tileable normal/height texture made from integer-frequency waves. */
function makeWaveTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const waves: { kx: number; ky: number; a: number; p: number }[] = [];
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    let kx = Math.round((r() * 2 - 1) * 9);
    let ky = Math.round((r() * 2 - 1) * 9);
    if (kx === 0 && ky === 0) kx = 1;
    const k = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: 1 / Math.pow(k, 1.3), p: r() * Math.PI * 2 });
    void ky;
  }
  const h = new Float32Array(size * size);
  let min = 1e9, max = -1e9;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.a * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.p);
      h[y * size + x] = v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const hx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const hy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      const n = new THREE.Vector3(-hx * 2.2, 1, -hy * 2.2).normalize();
      data[i * 4] = (n.x * 0.5 + 0.5) * 255;
      data[i * 4 + 1] = (n.z * 0.5 + 0.5) * 255;
      data[i * 4 + 2] = ((h[i] - min) / (max - min)) * 255;
      data[i * 4 + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class Water {
  readonly mesh: THREE.Mesh;
  readonly bedTex: THREE.DataTexture;
  private bed: Uint8Array;
  readonly ripples: THREE.Vector4[] = [];
  private rippleIdx = 0;
  readonly material: THREE.MeshLambertMaterial;
  readonly uniforms = {
    tRefract: { value: null as THREE.Texture | null },
    tWaves: { value: makeWaveTexture() },
    tBed: { value: null as THREE.Texture | null },
    uProj: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSkyTop: { value: new THREE.Color(0x5d9ad6) },
    uSkyHor: { value: new THREE.Color(0xcfe3ea) },
    uRipples: { value: [] as THREE.Vector4[] },
    uSSR: { value: 1 },
    uHalfRes: { value: new THREE.Vector2(1, 1) },
  };

  constructor(private world: World) {
    for (let i = 0; i < 16; i++) this.ripples.push(new THREE.Vector4(0, 0, -100, 0));
    this.uniforms.uRipples.value = this.ripples;
    this.bed = new Uint8Array(WX * WZ);
    this.bedTex = new THREE.DataTexture(this.bed, WZ, WX, THREE.RedFormat, THREE.UnsignedByteType);
    this.bedTex.magFilter = THREE.LinearFilter;
    this.bedTex.minFilter = THREE.LinearFilter;
    this.bedTex.needsUpdate = true;
    this.uniforms.tBed.value = this.bedTex;
    this.refreshAll();

    const geo = new THREE.PlaneGeometry(MAP_W, MAP_D, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(MAP_W / 2, WATER_Y, MAP_D / 2);
    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  private bedAt(x: number, z: number) {
    const lim = Math.floor(WATER_Y / VOXEL);
    const base = (x * WZ + z) * WY;
    for (let y = lim; y >= 0; y--) if (this.world.vox[base + y] !== 0) return y + 1;
    return 0;
  }

  refreshAll() {
    for (let x = 0; x < WX; x++) for (let z = 0; z < WZ; z++) this.bed[x * WZ + z] = this.bedAt(x, z) * 16;
    this.bedTex.needsUpdate = true;
  }

  refreshColumns(cols: number[]) {
    let changed = false;
    for (const c of cols) {
      const x = (c / WZ) | 0, z = c % WZ;
      const v = this.bedAt(x, z) * 16;
      if (this.bed[c] !== v) {
        this.bed[c] = v;
        changed = true;
      }
    }
    if (changed) this.bedTex.needsUpdate = true;
  }

  addRipple(x: number, z: number, strength = 1) {
    const r = this.ripples[this.rippleIdx];
    this.rippleIdx = (this.rippleIdx + 1) % this.ripples.length;
    r.set(x, z, shared.uTime.value, strength);
  }

  private createMaterial() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x000000 });
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorldP;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
${GLSL_COMMON}
varying vec3 vWorldP;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uHalfRes;
uniform sampler2D tRefract;
uniform sampler2D tWaves;
uniform sampler2D tBed;
uniform mat4 uProj;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyTop;
uniform vec3 uSkyHor;
uniform vec4 uRipples[16];
uniform float uSSR;`,
        )
        .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>')
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
{
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 V = normalize(cameraPosition - vWorldP);
  float surfDepth = vViewPosition.z;
  vec2 mapUV = vWorldP.zx / MAP_SIZE.yx;
  float bedY = texture2D(tBed, vec2(mapUV.x, mapUV.y)).r * 255.0 / 16.0 * VOX;
  float vdepth = max(${WATER_Y.toFixed(3)} - bedY, 0.0);

  // flowing normals: two scrolling layers + a slow broad swell
  vec2 flow = vec2(0.55, 0.08);
  vec2 p = vWorldP.xz;
  vec3 n1 = texture2D(tWaves, p * 0.045 + flow * uTime * 0.05).xyz;
  vec3 n2 = texture2D(tWaves, p * 0.09 * mat2(0.8, -0.6, 0.6, 0.8) - flow.yx * uTime * 0.07).xyz;
  vec3 n3 = texture2D(tWaves, p * 0.012 + vec2(uTime * 0.006, -uTime * 0.004)).xyz;
  vec2 d = (n1.xy - 0.5) * 1.0 + (n2.xy - 0.5) * 0.7 + (n3.xy - 0.5) * 0.6;
  float hgt = n1.z * 0.5 + n2.z * 0.35 + n3.z * 0.15;
  // ripples (impacts, wading)
  for (int i = 0; i < 16; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 2.5) continue;
    vec2 dv = p - r.xy;
    float dist = length(dv);
    float front = age * 2.6;
    float ring = exp(-pow((dist - front) * 3.2, 2.0)) * (1.0 - age / 2.5) * r.w;
    d += normalize(dv + 1e-4) * ring * sin((dist - front) * 18.0) * 0.9;
    hgt += ring * 0.4;
  }
  float calm = smoothstep(0.0, 0.5, vdepth);
  vec3 N = normalize(vec3(d.x * 0.32 * calm, 1.0, d.y * 0.32 * calm));

  // refraction
  vec4 base = texture2D(tRefract, uv);
  float thick = max(base.a - surfDepth, 0.0);
  vec2 ruv = uv + N.xz * 0.035 * clamp(thick * 0.7, 0.0, 1.0);
  vec4 refr = texture2D(tRefract, ruv);
  if (refr.a < surfDepth) refr = base;
  float th = max(refr.a - surfDepth, 0.0);
  float path = min(th, vdepth * 2.5 + 0.02);

  // volumetric absorption and in-scatter (Beer-Lambert per channel)
  vec3 sigma = vec3(0.62, 0.20, 0.17);
  vec3 trans = exp(-sigma * path * 1.25);
  float shadow = getShadowMask();
  vec3 scatterCol = vec3(0.018, 0.105, 0.095) * (0.55 + 0.45 * shadow) * (0.9 + 0.3 * hgt);
  vec3 col = refr.rgb * trans + scatterCol * (1.0 - trans);

  // reflections: sky + screen-space ray march
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHor, uSkyTop, smoothstep(0.0, 0.7, R.y));
  vec3 refl = sky;
  if (uSSR > 0.5) {
    vec3 rp = vWorldP + R * 0.4;
    for (int i = 0; i < 14; i++) {
      rp += R * (0.55 + float(i) * 0.22);
      vec4 cp = uProj * viewMatrix * vec4(rp, 1.0);
      vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      vec4 s = texture2D(tRefract, suv);
      float rayDepth = cp.w;
      if (rayDepth > s.a + 0.05 && rayDepth < s.a + 2.5) {
        vec2 fade = smoothstep(0.0, 0.12, suv) * smoothstep(0.0, 0.12, 1.0 - suv);
        refl = mix(sky, s.rgb, fade.x * fade.y);
        break;
      }
    }
  }
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  col = mix(col, refl, clamp(F * 1.3, 0.0, 0.85));

  // sun glints
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 420.0) * 6.0 + pow(max(dot(N, H), 0.0), 60.0) * 0.18;
  col += uSunCol * spec * shadow;

  // shoreline foam and churn
  float edgeD = min(thick, vdepth);
  float foamN = texture2D(tWaves, p * 0.32 + vec2(uTime * 0.03, 0.0)).z;
  float foam = (1.0 - smoothstep(0.0, 0.32, edgeD)) * smoothstep(0.35, 0.65, foamN + 0.25 * (1.0 - edgeD * 3.0));
  float foamLine = (1.0 - smoothstep(0.02, 0.08, abs(edgeD - 0.14 - 0.04 * sin(uTime * 1.3 + p.x * 0.7 + p.y * 0.5)))) * 0.5;
  col = mix(col, vec3(0.92, 0.96, 0.95) * (0.6 + 0.4 * shadow), clamp(foam * 0.75 + foamLine * smoothstep(0.0, 0.5, vdepth) * 0.5, 0.0, 0.85));

  gl_FragColor = vec4(col, 1.0);
}
`,
        )
        .replace('#include <tonemapping_fragment>', '')
        .replace('#include <colorspace_fragment>', '')
        .replace('#include <fog_fragment>', '');
    };
    mat.customProgramCacheKey = () => 'water';
    return mat;
  }
}
