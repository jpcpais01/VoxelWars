import * as THREE from 'three';

const VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const CopyDepthShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
void main() {
  float d = texture2D(tDepth, vUv).x;
  float vz = -perspectiveDepthToViewZ(d, uNear, uFar);
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb, vz);
}`,
};

export const DownCocShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uFocusRange;
uniform float uDof;
uniform float uTilt;
void main() {
  vec3 c = texture2D(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float d = texture2D(tDepth, vUv).x;
  float vz = -perspectiveDepthToViewZ(d, uNear, uFar);
  float coc;
  if (uTilt > 0.5) {
    coc = clamp((abs(vz - uFocus) - uFocusRange * 0.35) / uFocusRange, 0.0, 1.0) * uDof;
    // miniature look: stronger blur toward the top and bottom of the frame
    coc = max(coc, smoothstep(0.32, 0.5, abs(vUv.y - 0.5)) * 0.55 * uDof);
  } else {
    // eye level: only the far distance softens (the sky stays sharp)
    coc = d >= 0.99999 ? 0.0 : smoothstep(75.0, 220.0, vz) * 0.5 * uDof;
  }
  gl_FragColor = vec4(min(c, vec3(60.0)), coc);
}`,
};

export const BrightShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + 0.5, 0.0, 1.0);
  soft = soft * soft * 0.5;
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}`,
};

export const DownShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb * 4.0;
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`,
};

export const UpShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tBase;
uniform vec2 uTexel;
uniform float uWeight;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture2D(tColor, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture2D(tColor, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c / 12.0 * uWeight, 1.0);
}`,
};

/**
 * Light shafts: march from each pixel toward the sun across the depth buffer and gather how much
 * open sky lies along the way, so trees, cliffs and walls cut the glow into beams.
 * Runs at quarter resolution; the composite blurs and tints the result.
 */
export const RaysShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2 uSunUv;
uniform float uAspect;
void main() {
  const int N = 26;
  vec2 toSun = uSunUv - vUv;
  vec2 stp = toSun / float(N);
  // interleaved gradient noise hides the step pattern (smoothed by the composite)
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 p = vUv + stp * jit;
  float acc = 0.0;
  for (int i = 0; i < N; i++) {
    vec2 q = (p - uSunUv) * vec2(uAspect, 1.0);
    float glow = exp(-dot(q, q) * 7.0);
    acc += step(0.99999, texture2D(tDepth, clamp(p, 0.001, 0.999)).x) * glow;
    p += stp;
  }
  float len = length(toSun * vec2(uAspect, 1.0));
  gl_FragColor = vec4(acc / float(N) * exp(-len * 1.6), 0.0, 0.0, 1.0);
}`,
};

export const CompositeShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tDown;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform vec2 uRaysTexel;
uniform float uRays;
uniform vec2 uTexel;
uniform vec2 uDownTexel;
uniform float uNear;
uniform float uFar;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uFogCol;
uniform vec3 uSunDir;
uniform vec3 uSunFog;
uniform float uBloom;
uniform float uDof;
uniform float uExposure;
uniform float uTime;
uniform float uHurt;
uniform float uFlash;
uniform float uDesat;
uniform float uFxaa;
uniform float uMist;
uniform float uMistY;
uniform vec3 uMistCol;
uniform vec3 uSkyTop;
uniform vec3 uSunDisc;
uniform float uUnder;
uniform float uViewDist;

float mhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mhash(i), mhash(i + vec2(1.0, 0.0)), u.x), mix(mhash(i + vec2(0.0, 1.0)), mhash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float cfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * mnoise(p); p = p * 2.07 + 13.7; a *= 0.5; }
  return s / 0.9375;
}

/** sky dome: horizon matches the fog, a sun disc with glow and a drifting cloud deck */
vec3 skyColor(vec3 rd, vec3 camP) {
  float h = rd.y;
  vec3 c = mix(uFogCol, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.6));
  c = mix(c, uFogCol * 0.92, smoothstep(0.0, -0.25, h));
  float sd = max(dot(rd, uSunDir), 0.0);
  c += uSunFog * (pow(sd, 6.0) * 0.28 + pow(sd, 90.0) * 0.5);
  // bright haze band along the horizon, warmest under the sun
  c += uSunFog * pow(1.0 - abs(h), 12.0) * (0.05 + 0.22 * pow(sd, 3.0));
  if (h > 0.0) {
    // cloud deck ~140 m up, same drift as the cloud shadows on the ground
    vec2 cp = camP.xz + rd.xz / max(h, 0.035) * 140.0;
    vec2 q = cp * 0.012 + vec2(uTime * 0.012, uTime * 0.006) * 0.66;
    float n = cfbm(q);
    float dens = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.12, h);
    float lit = 0.75 + 0.35 * pow(sd, 3.0);
    vec3 cc = mix(uFogCol * 1.15, vec3(1.0, 0.98, 0.95), 0.55) * lit;
    // darker cores where the deck is thick
    cc *= 1.0 - smoothstep(0.7, 0.95, n) * 0.25;
    c = mix(c, cc, dens * 0.85);
    // sun disc peeks through thin cloud
    c += uSunDisc * smoothstep(0.99955, 0.99975, sd) * (1.0 - dens * 0.9);
    // corona around the disc, which the bloom spreads into glare
    c += uSunDisc * pow(sd, 700.0) * 0.12 * (1.0 - dens * 0.75);
  }
  return c;
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float tl(vec3 c) { float l = luma(c); return l / (1.0 + l); }

vec3 fxaa(vec2 uv) {
  vec3 rgbM = texture2D(tColor, uv).rgb;
  if (uFxaa < 0.5) return rgbM;
  vec3 rgbNW = texture2D(tColor, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tColor, uv + vec2(1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tColor, uv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tColor, uv + vec2(1.0, 1.0) * uTexel).rgb;
  float lNW = tl(rgbNW), lNE = tl(rgbNE), lSW = tl(rgbSW), lSE = tl(rgbSE), lM = tl(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.02, lMax * 0.1)) return rgbM;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture2D(tColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tColor, uv + dir * -0.5).rgb + texture2D(tColor, uv + dir * 0.5).rgb);
  float lB = tl(b);
  return (lB < lMin || lB > lMax) ? a : b;
}

void main() {
  vec3 col = fxaa(vUv);

  // depth of field (tilt-shift miniature)
  if (uDof > 0.0) {
    float coc = texture2D(tDown, vUv).a;
    if (coc > 0.02) {
      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      float rad = coc * 5.0;
      for (int i = 0; i < 10; i++) {
        float fi = float(i);
        float r = sqrt((fi + 0.5) / 10.0) * rad;
        float th = fi * 2.39996;
        vec2 o = vec2(cos(th), sin(th)) * r * uDownTexel;
        vec4 s = texture2D(tDown, vUv + o);
        float w = 0.2 + s.a;
        acc += s.rgb * w;
        wsum += w;
      }
      col = mix(col, acc / wsum, smoothstep(0.02, 0.45, coc));
    }
  }

  // world reconstruction for atmospheric fog
  float d = texture2D(tDepth, vUv).x;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  vp /= vp.w;
  vec3 wp = (uCamWorld * vp).xyz;
  vec3 camP = (uCamWorld * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float dist = length(vp.xyz);
  vec3 rd = normalize(wp - camP);
  float hfog = exp(-max(wp.y - 3.5, 0.0) * 0.32) * 0.55;
  float fogAmt = 1.0 - exp(-dist * (0.002 + hfog * 0.0055));
  float sd = max(dot(rd, uSunDir), 0.0);
  float sunAmt = pow(sd, 6.0);
  vec3 fc = mix(uFogCol, uSunFog, sunAmt);
  // forward scattering: the haze glows toward the sun
  fc += uSunFog * pow(sd, 24.0) * 0.4;
  if (d >= 0.99999) col = skyColor(rd, camP);
  else {
    col = mix(col, fc, clamp(fogAmt, 0.0, 1.0));
    // the end of the render distance melts into the sky behind it
    float fade = smoothstep(uViewDist * 0.6, uViewDist, dist);
    if (fade > 0.0) col = mix(col, skyColor(rd, camP), fade);
  }

  // low valley mist: pools just above the waterline and drifts with the wind
  if (uMist > 0.0 && d < 0.99999) {
    float layer = 1.0 - smoothstep(uMistY - 0.3, uMistY + 1.3, wp.y);
    vec2 mp = wp.xz * 0.07 + vec2(uTime * 0.035, uTime * 0.015);
    float n = mnoise(mp) * 0.6 + mnoise(mp * 2.3 + 7.1) * 0.4;
    float mist = layer * smoothstep(0.38, 0.85, n) * uMist;
    float sunLit = 0.75 + 0.25 * pow(max(dot(rd, uSunDir), 0.0), 3.0);
    col = mix(col, mix(uMistCol, fc, 0.35) * sunLit, clamp(mist * 0.5, 0.0, 0.2));
  }

  // under the river: murky green-blue, light falls off fast
  if (uUnder > 0.5) {
    float uw = 1.0 - exp(-dist * 0.22);
    col = mix(col * vec3(0.55, 0.8, 0.85), vec3(0.08, 0.2, 0.22), clamp(uw, 0.25, 0.95));
  }

  // light shafts (small tent blur over the quarter-res march)
  if (uRays > 0.0) {
    vec2 o = uRaysTexel * 0.75;
    float r = texture2D(tRays, vUv).r * 0.4;
    r += (texture2D(tRays, vUv + vec2(o.x, o.y)).r + texture2D(tRays, vUv + vec2(-o.x, o.y)).r
      + texture2D(tRays, vUv + vec2(o.x, -o.y)).r + texture2D(tRays, vUv + vec2(-o.x, -o.y)).r) * 0.15;
    col += uSunFog * r * uRays;
  }

  col += texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure;
  col = aces(col);
  // grade: gentle s-curve, lift saturation for the toy look
  float l = luma(col);
  col = mix(vec3(l), col, 1.12 - uDesat * 0.9);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
  // split tone: cool, sky-lit shadows and warm, sunlit highlights
  col *= mix(vec3(0.97, 1.0, 1.04), vec3(1.06, 1.0, 0.92), smoothstep(0.05, 0.75, luma(col)));
  // vignette + hurt pulse + flash
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * 0.55;
  col *= vig;
  float edge = smoothstep(0.25, 0.75, length(q * vec2(1.3, 1.0)));
  col = mix(col, vec3(0.55, 0.02, 0.02), edge * uHurt * 0.75);
  col += uFlash;
  // linear -> sRGB + blue-noise-ish dithering against banding
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`,
};

export class FsPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh;
  constructor() {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  run(renderer: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.mesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}

export function makePass(def: { vertexShader: string; fragmentShader: string }, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: def.vertexShader,
    fragmentShader: def.fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}
