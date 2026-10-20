import * as THREE from 'three';
import { MAP_D, MAP_W, WATER_Y } from '../core/config';
import { BrightShader, CompositeShader, CopyDepthShader, DownCocShader, DownShader, FsPass, UpShader, makePass } from './post';
import { shared } from './shaderlib';
import { Water } from './water';
import type { Viewmodel } from './Viewmodel';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

interface QualityDef {
  scale: number;
  maxDpr: number;
  shadow: number;
  bloom: boolean;
  dof: boolean;
  ssr: boolean;
  grass: boolean;
  /** world detail distance multiplier */
  lod: number;
  fxaa: boolean;
  /** re-render the sun's shadow map every N frames (the light matrix stays paired with its map) */
  shadowEvery: number;
}

export type LightingId = 'morning' | 'golden' | 'overcast';
interface LightingDef {
  label: string;
  sunDir: [number, number, number];
  sun: number;
  sunI: number;
  sky: number;
  ground: number;
  hemiI: number;
  fog: number;
  sunFog: number;
  mist: number;
  mistCol: number;
  skyTop: number;
  skyHor: number;
  exposure: number;
  shadowRadius: number;
}
export const LIGHTING: Record<LightingId, LightingDef> = {
  morning: {
    label: 'Morning',
    sunDir: [-0.55, 0.68, 0.48], sun: 0xffe9c9, sunI: 3.25, sky: 0xbcd8ff, ground: 0x627040, hemiI: 1.4,
    fog: 0x9fbcc4, sunFog: 0xf3d7a6, mist: 1, mistCol: 0xd9e6e4, skyTop: 0x5d9ad6, skyHor: 0xcfe3ea, exposure: 1, shadowRadius: 2.5,
  },
  golden: {
    label: 'Golden hour',
    sunDir: [-0.78, 0.4, 0.48], sun: 0xffbe7d, sunI: 3.4, sky: 0x9db6e8, ground: 0x6e5a36, hemiI: 1.15,
    fog: 0xc9a98a, sunFog: 0xffb36b, mist: 1.35, mistCol: 0xf0d2b0, skyTop: 0x6f93cf, skyHor: 0xf6c99a, exposure: 1.06, shadowRadius: 3,
  },
  overcast: {
    label: 'Overcast',
    sunDir: [-0.3, 0.88, 0.36], sun: 0xe8eef2, sunI: 1.25, sky: 0xc9d6e2, ground: 0x5d6650, hemiI: 2.25,
    fog: 0x9aa7ad, sunFog: 0xb9c2c4, mist: 1.6, mistCol: 0xc8d2d4, skyTop: 0x8a9aa8, skyHor: 0xc2ccd1, exposure: 1.08, shadowRadius: 6,
  },
};

export const QUALITY: Record<Quality, QualityDef> = {
  low: { scale: 0.75, maxDpr: 1, shadow: 1024, bloom: false, dof: false, ssr: false, grass: false, lod: 0.6, fxaa: true, shadowEvery: 2 },
  medium: { scale: 1, maxDpr: 1.25, shadow: 1536, bloom: true, dof: false, ssr: false, grass: true, lod: 0.8, fxaa: true, shadowEvery: 2 },
  high: { scale: 1, maxDpr: 1.5, shadow: 2048, bloom: true, dof: true, ssr: true, grass: true, lod: 1, fxaa: true, shadowEvery: 1 },
  ultra: { scale: 1, maxDpr: 2, shadow: 4096, bloom: true, dof: true, ssr: true, grass: true, lod: 1.4, fxaa: true, shadowEvery: 1 },
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly fxScene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.08, 420);
  readonly sun = new THREE.DirectionalLight(0xffe9c9, 3.25);
  /** Twin of the sun living in the effects scene; shares the shadow map so water receives shadows. */
  private fxSun = new THREE.DirectionalLight(0xffe9c9, 3.25);
  readonly hemi = new THREE.HemisphereLight(0xbcd8ff, 0x627040, 1.4);
  readonly flashes: THREE.PointLight[] = [];
  private flashLife: number[] = [];
  readonly sunDir = new THREE.Vector3(-0.55, 0.68, 0.48).normalize();
  water!: Water;
  /** first-person weapon, drawn into the main buffer after the world */
  viewmodel: Viewmodel | null = null;
  /** miniature tilt-shift depth of field (menu flyover); off in first person */
  tiltShift = true;

  private rtMain!: THREE.WebGLRenderTarget;
  private rtHalf!: THREE.WebGLRenderTarget;
  private rtDown!: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget[] = [];
  private rtU: THREE.WebGLRenderTarget[] = [];
  private fs = new FsPass();
  private copyMat;
  private downMat;
  private brightMat;
  private dsMat;
  private upMat;
  private compMat;
  private w = 1;
  private h = 1;
  quality: Quality = 'high';
  q: QualityDef = QUALITY.high;
  dynScale = 1;
  private frameTimes: number[] = [];
  focusTarget = new THREE.Vector3();
  shake = 0;
  hurt = 0;
  flash = 0;
  desat = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false });
    this.gl.setPixelRatio(1);
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.shadowMap.autoUpdate = false;
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;

    const fog = new THREE.Color(0xa9c4c9);
    this.scene.background = fog;

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.5;
    const sc = this.sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 1;
    sc.far = 160;
    // the player's own body lives on layer 1: invisible to the eye, but it still casts a shadow
    sc.layers.enable(1);
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.fxSun.castShadow = true;
    this.fxSun.shadow = this.sun.shadow;
    this.fxScene.add(this.fxSun, this.fxSun.target);
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffa860, 0, 16, 1.6);
      this.flashes.push(l);
      this.flashLife.push(0);
      this.scene.add(l);
    }

    this.copyMat = makePass(CopyDepthShader, { tColor: { value: null }, tDepth: { value: null }, uNear: { value: 0.5 }, uFar: { value: 420 } });
    this.downMat = makePass(DownCocShader, {
      tColor: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.5 },
      uFar: { value: 420 },
      uFocus: { value: 30 },
      uFocusRange: { value: 18 },
      uDof: { value: 1 },
      uTilt: { value: 1 },
    });
    this.brightMat = makePass(BrightShader, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.25 } });
    this.dsMat = makePass(DownShader, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = makePass(UpShader, { tColor: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
    this.compMat = makePass(CompositeShader, {
      tColor: { value: null },
      tDepth: { value: null },
      tDown: { value: null },
      tBloom: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDownTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.5 },
      uFar: { value: 420 },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uFogCol: { value: new THREE.Color(0x9fbcc4) },
      uSunDir: { value: this.sunDir },
      uSunFog: { value: new THREE.Color(0xf3d7a6) },
      uBloom: { value: 0.6 },
      uDof: { value: 1 },
      uExposure: { value: 1.0 },
      uTime: { value: 0 },
      uHurt: { value: 0 },
      uFlash: { value: 0 },
      uDesat: { value: 0 },
      uFxaa: { value: 1 },
      uMist: { value: 1 },
      uMistY: { value: WATER_Y + 0.25 },
      uMistCol: { value: new THREE.Color(0xd9e6e4) },
      uSkyTop: { value: new THREE.Color(0x5d9ad6) },
      uSunDisc: { value: new THREE.Color(0xffe9c9) },
      uUnder: { value: 0 },
    });
    this.addSkirt();
  }

  private frameNo = 0;
  /** set when the shadow frustum jumps (menu -> match) so the next frame refreshes the map */
  shadowForce = true;
  lighting: LightingId = 'morning';

  setLighting(id: LightingId) {
    const L = LIGHTING[id];
    this.lighting = id;
    this.sunDir.set(...L.sunDir).normalize();
    for (const s of [this.sun, this.fxSun]) {
      s.color.setHex(L.sun);
      s.intensity = L.sunI;
    }
    this.sun.shadow.radius = L.shadowRadius;
    this.hemi.color.setHex(L.sky);
    this.hemi.groundColor.setHex(L.ground);
    this.hemi.intensity = L.hemiI;
    (this.scene.background as THREE.Color).setHex(L.fog);
    const c = this.compMat.uniforms;
    c.uFogCol.value.setHex(L.fog);
    c.uSunFog.value.setHex(L.sunFog);
    c.uMist.value = L.mist;
    c.uMistCol.value.setHex(L.mistCol);
    c.uExposure.value = L.exposure;
    c.uSkyTop.value.setHex(L.skyTop);
    c.uSunDisc.value.setHex(L.sun).multiplyScalar(id === 'overcast' ? 0.6 : 14);
    if (this.water) {
      this.water.uniforms.uSkyTop.value.setHex(L.skyTop);
      this.water.uniforms.uSkyHor.value.setHex(L.skyHor);
    }
    this.shadowForce = true;
  }

  setWater(w: Water) {
    this.water = w;
    this.fxScene.add(w.mesh);
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.q = QUALITY[q];
    const s = this.q.shadow;
    if (this.sun.shadow.mapSize.x !== s) {
      this.sun.shadow.mapSize.set(s, s);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.dynScale = 1;
    this.resize();
  }

  /** Distant forest around the playable square so the horizon never shows a hard edge. */
  private addSkirt() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x3f5d2f });
    const g = new THREE.Group();
    const S = 260;
    const y = 9.5;
    const pieces: [number, number, number, number][] = [
      [-S, -S, MAP_W + 2 * S, S],
      [-S, MAP_D, MAP_W + 2 * S, S],
      [-S, 0, S, MAP_D],
      [MAP_W, 0, S, MAP_D],
    ];
    for (const [x, z, w, d] of pieces) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x + w / 2, y, z + d / 2);
      p.receiveShadow = true;
      g.add(p);
    }
    // instanced low-poly distant trees
    const cone = new THREE.ConeGeometry(2.6, 9, 6, 1);
    cone.translate(0, 4.5 + 2, 0);
    const trunk = new THREE.CylinderGeometry(0.35, 0.45, 2.2, 5);
    trunk.translate(0, 1.1, 0);
    const treeMat = new THREE.MeshLambertMaterial({ color: 0x2c5a32, flatShading: true });
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3a28 });
    const N = 900;
    const cones = new THREE.InstancedMesh(cone, treeMat, N);
    const trunks = new THREE.InstancedMesh(trunk, trunkMat, N);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    let seed = 99;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    while (n < N) {
      const x = -60 + r() * (MAP_W + 120);
      const z = -60 + r() * (MAP_D + 120);
      const inside = x > -2 && z > -2 && x < MAP_W + 2 && z < MAP_D + 2;
      if (inside) continue;
      const s = 0.8 + r() * 0.9;
      p.set(x, y, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
      sc.set(s, s * (0.8 + r() * 0.6), s);
      m.compose(p, q, sc);
      cones.setMatrixAt(n, m);
      trunks.setMatrixAt(n, m);
      col.setHSL(0.27 + r() * 0.08, 0.45, 0.22 + r() * 0.1);
      cones.setColorAt(n, col);
      n++;
    }
    cones.castShadow = true;
    cones.receiveShadow = true;
    g.add(cones, trunks);
    this.scene.add(g);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.maxDpr);
    const cw = this.canvas.clientWidth || window.innerWidth;
    const ch = this.canvas.clientHeight || window.innerHeight;
    const s = dpr * this.q.scale * this.dynScale;
    const w = Math.max(64, Math.round(cw * s));
    const h = Math.max(64, Math.round(ch * s));
    this.gl.setSize(w, h, false);
    this.camera.aspect = cw / ch;
    this.camera.updateProjectionMatrix();
    if (w === this.w && h === this.h && this.rtMain) return;
    this.w = w;
    this.h = h;
    this.rtMain?.dispose();
    this.rtHalf?.dispose();
    this.rtDown?.dispose();
    this.rtB.forEach((r) => r.dispose());
    this.rtU.forEach((r) => r.dispose());
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    this.rtMain = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, depthTexture: depth, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    const hw = Math.max(32, w >> 1), hh = Math.max(32, h >> 1);
    this.rtHalf = new THREE.WebGLRenderTarget(hw, hh, opt);
    this.rtDown = new THREE.WebGLRenderTarget(hw, hh, opt);
    this.rtB = [];
    this.rtU = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < 4; i++) {
      bw = Math.max(8, bw >> 1);
      bh = Math.max(8, bh >> 1);
      this.rtB.push(new THREE.WebGLRenderTarget(bw, bh, opt));
      this.rtU.push(new THREE.WebGLRenderTarget(bw, bh, opt));
    }
    shared.uResolution.value.set(w, h);
    this.water?.uniforms.uHalfRes.value.set(hw, hh);
  }

  flashAt(x: number, y: number, z: number, intensity: number, color = 0xffa860, life = 0.18) {
    let best = 0;
    for (let i = 1; i < this.flashes.length; i++) if (this.flashLife[i] < this.flashLife[best]) best = i;
    const l = this.flashes[best];
    l.position.set(x, y, z);
    l.color.setHex(color);
    l.intensity = intensity;
    l.userData.base = intensity;
    l.userData.max = life;
    this.flashLife[best] = life;
  }

  /** Track frame time and nudge internal resolution to hold ~60 fps. */
  adapt(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 45) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    this.frameTimes.length = 0;
    let next = this.dynScale;
    if (med > 1 / 50) next = Math.max(0.55, this.dynScale - 0.08);
    else if (med < 1 / 58 && this.dynScale < 1) next = Math.min(1, this.dynScale + 0.05);
    if (Math.abs(next - this.dynScale) > 0.01) {
      this.dynScale = next;
      this.resize();
    }
  }

  /** half-res colour + linear depth of the opaque pass (soft particles sample it) */
  get halfTex() {
    return this.rtHalf.texture;
  }

  /** half-width of the sun's shadow frustum in metres (the menu flyover wants a wider one) */
  shadowExtent = 34;

  updateShadowCamera(target: THREE.Vector3) {
    // keep the shadow frustum centred on what we look at, snapped to texels to avoid shimmer
    const sc = this.sun.shadow.camera;
    if (sc.right !== this.shadowExtent) {
      sc.left = sc.bottom = -this.shadowExtent;
      sc.right = sc.top = this.shadowExtent;
      sc.updateProjectionMatrix();
    }
    const size = this.shadowExtent * 2;
    const texel = size / this.sun.shadow.mapSize.x;
    const lightRot = new THREE.Matrix4().lookAt(this.sunDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const ls = target.clone().applyMatrix4(inv);
    ls.x = Math.round(ls.x / texel) * texel;
    ls.y = Math.round(ls.y / texel) * texel;
    const snapped = ls.applyMatrix4(lightRot);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDir, 80);
    this.sun.target.updateMatrixWorld();
    this.fxSun.position.copy(this.sun.position);
    this.fxSun.target.position.copy(this.sun.target.position);
    this.fxSun.target.updateMatrixWorld();
  }

  render(dt: number, time: number) {
    const gl = this.gl;
    shared.uTime.value = time;
    for (let i = 0; i < this.flashes.length; i++) {
      if (this.flashLife[i] > 0) {
        this.flashLife[i] -= dt;
        const l = this.flashes[i];
        const k = Math.max(0, this.flashLife[i] / (l.userData.max || 0.2));
        l.intensity = (l.userData.base || 0) * k * k;
      } else this.flashes[i].intensity = 0;
    }
    gl.info.reset();
    const cam = this.camera;
    cam.updateMatrixWorld();

    // 1. opaque scene
    gl.setRenderTarget(this.rtMain);
    gl.setClearColor(this.scene.background as THREE.Color, 1);
    gl.clear(true, true, false);
    // under load, refresh shadows on alternate frames (dynamic resolution already fell back)
    const every = this.dynScale < 0.8 ? Math.max(2, this.q.shadowEvery) : this.q.shadowEvery;
    this.frameNo++;
    gl.shadowMap.needsUpdate = this.frameNo % every === 0 || this.shadowForce;
    this.shadowForce = false;
    gl.render(this.scene, cam);

    // 2. refraction source (half res colour + linear depth)
    this.copyMat.uniforms.tColor.value = this.rtMain.texture;
    this.copyMat.uniforms.tDepth.value = this.rtMain.depthTexture;
    this.copyMat.uniforms.uNear.value = cam.near;
    this.copyMat.uniforms.uFar.value = cam.far;
    this.fs.run(gl, this.copyMat, this.rtHalf);

    // 3. water + transparent effects on top, sharing the main depth buffer
    if (this.water) {
      const u = this.water.uniforms;
      u.tRefract.value = this.rtHalf.texture;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uSunDir.value.copy(this.sunDir);
      u.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
      u.uSSR.value = this.q.ssr ? 1 : 0;
    }
    gl.setRenderTarget(this.rtMain);
    gl.render(this.fxScene, cam);

    // 3b. first-person weapon on top (its depth is squeezed in front of everything)
    const vm = this.viewmodel;
    if (vm && vm.visible) {
      vm.resize(cam.aspect);
      gl.render(vm.scene, vm.camera);
    }

    // 4. post
    const doDof = this.q.dof;
    const doBloom = this.q.bloom;
    if (doDof || doBloom) {
      const dm = this.downMat.uniforms;
      dm.tColor.value = this.rtMain.texture;
      dm.tDepth.value = this.rtMain.depthTexture;
      dm.uTexel.value.set(1 / this.w, 1 / this.h);
      dm.uNear.value = cam.near;
      dm.uFar.value = cam.far;
      dm.uFocus.value = cam.position.distanceTo(this.focusTarget);
      dm.uFocusRange.value = 16;
      dm.uDof.value = doDof ? 1 : 0;
      dm.uTilt.value = this.tiltShift ? 1 : 0;
      this.fs.run(gl, this.downMat, this.rtDown);
    }
    if (doBloom) {
      const b = this.rtB;
      this.brightMat.uniforms.tColor.value = this.rtDown.texture;
      this.brightMat.uniforms.uTexel.value.set(1 / this.rtDown.width, 1 / this.rtDown.height);
      this.fs.run(gl, this.brightMat, b[0]);
      for (let i = 1; i < b.length; i++) {
        this.dsMat.uniforms.tColor.value = b[i - 1].texture;
        this.dsMat.uniforms.uTexel.value.set(1 / b[i - 1].width, 1 / b[i - 1].height);
        this.fs.run(gl, this.dsMat, b[i]);
      }
      // upsample chain: u[i] = b[i] + up(u[i+1])
      let src = b[b.length - 1];
      for (let i = b.length - 2; i >= 0; i--) {
        this.upMat.uniforms.tColor.value = src.texture;
        this.upMat.uniforms.tBase.value = b[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.upMat.uniforms.uWeight.value = 1;
        this.fs.run(gl, this.upMat, this.rtU[i]);
        src = this.rtU[i];
      }
    }
    const c = this.compMat.uniforms;
    c.tColor.value = this.rtMain.texture;
    c.tDepth.value = this.rtMain.depthTexture;
    c.tDown.value = this.rtDown.texture;
    c.tBloom.value = this.rtU[0].texture;
    c.uTexel.value.set(1 / this.w, 1 / this.h);
    c.uDownTexel.value.set(1 / this.rtDown.width, 1 / this.rtDown.height);
    c.uNear.value = cam.near;
    c.uFar.value = cam.far;
    c.uInvProj.value.copy(cam.projectionMatrixInverse);
    c.uCamWorld.value.copy(cam.matrixWorld);
    c.uBloom.value = doBloom ? 0.55 : 0;
    c.uDof.value = doDof ? 1 : 0;
    c.uTime.value = time % 100;
    c.uHurt.value = this.hurt;
    c.uFlash.value = this.flash;
    c.uDesat.value = this.desat;
    c.uFxaa.value = this.q.fxaa ? 1 : 0;
    c.uUnder.value = cam.position.y < WATER_Y - 0.03 ? 1 : 0;
    this.fs.run(gl, this.compMat, null);
    this.flash = Math.max(0, this.flash - dt * 3);
  }
}
