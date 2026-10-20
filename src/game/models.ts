import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Build, WeaponDef } from './weapons';
import { gunModel } from './gunVoxels';
import { createGunMaterial } from '../render/gunMaterial';
import { GLSL_CLOUDS, GLSL_COMMON, GLSL_SKY, shared } from '../render/shaderlib';

type Part = [w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx?: number];

const tmpColor = new THREE.Color();

/** Merge coloured boxes into one geometry with a `color` attribute. */
export function boxes(parts: Part[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const [w, h, d, x, y, z, color, rx] of parts) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    tmpColor.setHex(color);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // subtle top-light baked into vertex colour for extra toy-like definition
      const ny = g.getAttribute('normal').getY(i);
      const k = ny > 0.5 ? 1.08 : ny < -0.5 ? 0.7 : 0.92;
      c[i * 3] = tmpColor.r * k;
      c[i * 3 + 1] = tmpColor.g * k;
      c[i * 3 + 2] = tmpColor.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  return merged;
}

/**
 * Vertex-coloured Lambert for soldiers, guns and props in the world: picks up the baked sky
 * visibility (darker under canopies and roofs) and a soft rim light so figures read clearly
 * against the ground from the high camera.
 */
export const toyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
toyMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, shared);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vToyP;\nvarying vec3 vToyN;`)
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vToyP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vToyN = normalize(mat3(modelMatrix) * objectNormal);`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
${GLSL_COMMON}
${GLSL_CLOUDS}
${GLSL_SKY}
uniform float uTime;
varying vec3 vToyP;
varying vec3 vToyN;`,
    )
    .replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
float sky = skyVis(vToyP, vToyN);
reflectedLight.indirectDiffuse *= sky;
reflectedLight.directDiffuse *= cloudShadow(vToyP.xz, uTime);
float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
totalEmissiveRadiance += (diffuseColor.rgb * 0.5 + vec3(0.1, 0.12, 0.14)) * rim * (0.35 + 0.4 * sky);`,
    );
};
toyMaterial.customProgramCacheKey = () => 'toy';

/** Lit voxel-gun material for UI previews that live outside the world (no sky volume there). */
export const previewMaterial = createGunMaterial();

/** Gun mesh in metres, barrel along +Z, origin at the grip (a copy the caller may transform). */
export function buildGunGeometry(def: WeaponDef, build: Build): THREE.BufferGeometry {
  return gunModel(def, build).merged.clone();
}

export function gunMuzzleZ(def: WeaponDef, build: Build) {
  return gunModel(def, build).muzzle.z;
}

export interface SoldierRig {
  root: THREE.Group;
  body: THREE.Group; // yaw
  upper: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  gunMount: THREE.Group;
  gun: THREE.Mesh | null;
  ring: THREE.Mesh;
  laser: THREE.Mesh;
}

const legGeoCache = new Map<number, THREE.BufferGeometry>();
const upperGeoCache = new Map<string, THREE.BufferGeometry>();
const ringGeo = new THREE.RingGeometry(0.42, 0.55, 28).rotateX(-Math.PI / 2);

export function buildSoldier(team: 0 | 1, isPlayer: boolean): SoldierRig {
  const teamCol = team === 0 ? 0x3d7fe6 : 0xe0483a;
  const uniform = team === 0 ? 0x4a5a46 : 0x7a6a4a;
  const vest = team === 0 ? 0x2f3a33 : 0x4e4433;
  const skin = team === 0 ? 0xe2b48c : 0xc8946a;
  const helmet = team === 0 ? 0x3f4d3f : 0x5f5640;
  const boot = 0x2a2422;

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  let legGeo = legGeoCache.get(uniform);
  if (!legGeo) {
    legGeo = boxes([
      [0.17, 0.62, 0.2, 0, -0.33, 0, uniform],
      [0.19, 0.14, 0.27, 0, -0.68, 0.03, boot],
    ]);
    legGeoCache.set(uniform, legGeo);
  }
  const legL = new THREE.Mesh(legGeo, toyMaterial);
  const legR = new THREE.Mesh(legGeo, toyMaterial);
  legL.position.set(-0.12, 0.76, 0);
  legR.position.set(0.12, 0.76, 0);
  body.add(legL, legR);

  const key = `${team}`;
  let upGeo = upperGeoCache.get(key);
  if (!upGeo) {
    upGeo = boxes([
      // hips + torso
      [0.42, 0.16, 0.24, 0, 0.82, 0, uniform],
      [0.46, 0.5, 0.27, 0, 1.12, 0, uniform],
      [0.5, 0.36, 0.31, 0, 1.15, 0.0, vest],
      [0.14, 0.1, 0.06, -0.12, 1.08, 0.17, 0x5a5a3a],
      [0.14, 0.1, 0.06, 0.12, 1.08, 0.17, 0x5a5a3a],
      // shoulders (team colour)
      [0.14, 0.1, 0.22, -0.31, 1.33, 0, teamCol],
      [0.14, 0.1, 0.22, 0.31, 1.33, 0, teamCol],
      // backpack
      [0.36, 0.38, 0.17, 0, 1.17, -0.23, vest],
      [0.3, 0.08, 0.19, 0, 1.38, -0.23, 0x5c4a32],
      // head + helmet
      [0.25, 0.25, 0.25, 0, 1.53, 0.01, skin],
      [0.2, 0.05, 0.02, 0, 1.56, 0.135, 0x1a1a1a],
      [0.33, 0.13, 0.33, 0, 1.69, 0.0, helmet],
      [0.35, 0.04, 0.35, 0, 1.63, 0.0, helmet],
      [0.12, 0.04, 0.34, 0, 1.765, 0.0, teamCol],
      // arms reaching forward to the gun
      [0.12, 0.12, 0.42, -0.24, 1.26, 0.2, uniform, 0.35],
      [0.12, 0.12, 0.42, 0.24, 1.26, 0.2, uniform, 0.35],
      [0.12, 0.12, 0.1, -0.16, 1.18, 0.44, skin],
      [0.12, 0.12, 0.1, 0.16, 1.18, 0.38, skin],
    ]);
    upperGeoCache.set(key, upGeo);
  }
  const upper = new THREE.Mesh(upGeo, toyMaterial);
  body.add(upper);

  const gunMount = new THREE.Group();
  gunMount.position.set(0.06, 1.2, 0.33);
  body.add(gunMount);

  const ringMat = new THREE.MeshBasicMaterial({ color: isPlayer ? 0xfff2a8 : teamCol, transparent: true, opacity: 0.75, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 0.04;
  ring.renderOrder = 5;
  root.add(ring);

  const laserMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
  const laser = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.015, 1).translate(0, 0, 0.5), laserMat);
  laser.visible = false;
  gunMount.add(laser);

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o !== ring && o !== laser) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { root, body, upper, legL, legR, gunMount, gun: null, ring, laser };
}

export function setRigGun(rig: SoldierRig, def: WeaponDef, build: Build) {
  // gun geometry is shared through the model cache, so it is never disposed here
  if (rig.gun) rig.gunMount.remove(rig.gun);
  const model = gunModel(def, build);
  const g = new THREE.Mesh(model.merged, toyMaterial);
  g.castShadow = true;
  g.receiveShadow = true;
  g.layers.mask = rig.root.children[0]?.layers.mask ?? 1;
  rig.gunMount.add(g);
  rig.gun = g;
  rig.laser.position.set(0, model.muzzle.y - 0.04, model.muzzle.z);
}
