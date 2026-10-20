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
void main() {
  vec3 c = texture2D(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float d = texture2D(tDepth, vUv).x;
  float vz = -perspectiveDepthToViewZ(d, uNear, uFar);
  float coc = clamp((abs(vz - uFocus) - uFocusRange * 0.35) / uFocusRange, 0.0, 1.0) * uDof;
  // miniature look: stronger blur toward the top and bottom of the frame
  coc = max(coc, smoothstep(0.32, 0.5, abs(vUv.y - 0.5)) * 0.55 * uDof);
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

export const CompositeShader = {
  vertexShader: VS,
  fragmentShader: /* glsl */ `
#include <packing>
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tDown;
uniform sampler2D tBloom;
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
  float fogAmt = 1.0 - exp(-dist * (0.0035 + hfog * 0.012));
  if (d >= 0.99999) fogAmt = 1.0;
  float sunAmt = pow(max(dot(rd, uSunDir), 0.0), 6.0);
  vec3 fc = mix(uFogCol, uSunFog, sunAmt);
  col = mix(col, fc, clamp(fogAmt, 0.0, 1.0));

  col += texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure;
  col = aces(col);
  // grade: gentle s-curve, lift saturation for the toy look
  float l = luma(col);
  col = mix(vec3(l), col, 1.12 - uDesat * 0.9);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
  col *= vec3(1.02, 1.0, 0.97);
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
