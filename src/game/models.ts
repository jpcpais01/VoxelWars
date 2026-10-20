import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Build, WeaponDef } from './weapons';

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

export const toyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

/** Gun mesh in metres, barrel along +Z, origin at the grip. Attachments are visible. */
export function buildGunGeometry(def: WeaponDef, build: Build): THREE.BufferGeometry {
  const m = def.model;
  const P: Part[] = [];
  const C = m.color, A = m.accent;
  const dark = 0x1e2125;
  const L = m.length, B = m.barrel, R = m.bore;
  const rh = m.bulky ? 0.11 : 0.085; // receiver height
  const rw = m.bulky ? 0.085 : 0.06;
  if (m.tube) {
    // rocket launcher: long tube over the shoulder
    P.push([0.13, 0.13, L + B, 0, 0.09, (L + B) / 2 - 0.25, C]);
    P.push([0.15, 0.15, 0.08, 0, 0.09, L + B - 0.25, A]);
    P.push([0.15, 0.15, 0.06, 0, 0.09, -0.27, dark]);
    P.push([0.04, 0.12, 0.05, 0, -0.03, 0.02, dark]);
    P.push([0.04, 0.12, 0.05, 0, -0.03, 0.22, dark]);
    P.push([0.03, 0.05, 0.12, 0.08, 0.14, 0.12, A]);
  } else {
    // receiver
    P.push([rw, rh, L, 0, 0.04, L / 2 - 0.08, C]);
    P.push([rw * 0.8, 0.02, L * 0.9, 0, 0.04 + rh / 2 + 0.01, L / 2 - 0.08, dark]);
    // grip
    P.push([rw * 0.8, 0.12, 0.05, 0, -0.06, 0.0, dark, -0.25]);
    // handguard / barrel
    if (m.rotary) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        P.push([0.025, 0.025, B, Math.cos(a) * 0.04, 0.04 + Math.sin(a) * 0.04, L - 0.08 + B / 2, dark]);
      }
      P.push([0.11, 0.11, 0.03, 0, 0.04, L - 0.08 + B * 0.8, A]);
    } else {
      P.push([R * 1.4, R * 1.4, B * 0.6, 0, 0.045, L - 0.08 + B * 0.3, A]);
      P.push([R * 0.7, R * 0.7, B, 0, 0.05, L - 0.08 + B / 2, dark]);
    }
    // stock
    if (m.stock > 0 && build.stock !== 'nostock') {
      const heavy = build.stock === 'heavystock';
      const sl = build.stock === 'lightstock' ? m.stock * 0.8 : m.stock;
      P.push([rw * 0.9, heavy ? 0.1 : 0.07, sl, 0, 0.02, -0.08 - sl / 2, heavy ? A : C]);
      P.push([rw, 0.11, 0.03, 0, 0.0, -0.08 - sl, dark]);
    }
    // magazine
    const mag = build.magazine ?? 'stdmag';
    const big = mag === 'extmag' ? 1.45 : mag === 'drum' ? 1 : 1;
    switch (m.mag) {
      case 'curved':
      case 'box':
        if (mag === 'drum') P.push([0.07, 0.12, 0.12, 0, -0.08, 0.12, dark]);
        else P.push([0.04, 0.13 * big, 0.06, 0, -0.04 - 0.065 * big, 0.13, dark, m.mag === 'curved' ? 0.25 : 0]);
        break;
      case 'drum':
        P.push([0.09, 0.12, 0.12, 0, -0.06, 0.14, A]);
        break;
      case 'tube':
        P.push([0.04, 0.04, B * 0.8 * (mag === 'extmag' ? 1.2 : 1), 0, 0.0, L - 0.08 + B * 0.4, dark]);
        P.push([0.06, 0.05, 0.1, 0, 0.0, L * 0.7, A]);
        break;
      case 'cylinder':
        P.push([0.07, 0.07, 0.08, 0, 0.04, 0.08, A]);
        break;
      case 'belt':
        P.push([0.1, 0.12, 0.14, -0.04, -0.06, 0.14, A]);
        P.push([0.03, 0.03, 0.1, 0.03, 0.04, 0.16, 0xc8a23c]);
        break;
    }
  }
  // optic
  const opt = build.optic;
  const top = (m.tube ? 0.17 : 0.04 + rh / 2) + 0.02;
  if (opt === 'reddot') P.push([0.04, 0.04, 0.06, 0, top + 0.02, 0.12, dark], [0.03, 0.03, 0.005, 0, top + 0.025, 0.152, 0xff3030]);
  if (opt === 'holo') P.push([0.05, 0.05, 0.07, 0, top + 0.025, 0.12, dark], [0.04, 0.035, 0.004, 0, top + 0.03, 0.157, 0x55ddff]);
  if (opt === 'acog') P.push([0.045, 0.045, 0.14, 0, top + 0.03, 0.12, dark], [0.05, 0.05, 0.02, 0, top + 0.03, 0.2, A]);
  if (opt === 'scope8') P.push([0.05, 0.05, 0.26, 0, top + 0.04, 0.12, dark], [0.065, 0.065, 0.04, 0, top + 0.04, 0.26, dark], [0.06, 0.06, 0.03, 0, top + 0.04, -0.01, dark]);
  if (opt === 'thermal') P.push([0.06, 0.055, 0.15, 0, top + 0.03, 0.12, 0x3a4a3a], [0.05, 0.05, 0.01, 0, top + 0.03, 0.2, 0xff8a30]);
  // muzzle
  const mz = build.muzzle;
  const tip = m.tube ? L + B - 0.21 : L - 0.08 + B;
  if (mz === 'suppressor') P.push([R * 1.6, R * 1.6, 0.16, 0, 0.05, tip + 0.08, dark]);
  if (mz === 'compensator' || mz === 'brake' || mz === 'flashhider' || mz === 'choke') P.push([R * 1.5, R * 1.5, 0.06, 0, 0.05, tip + 0.03, mz === 'brake' ? A : dark]);
  // barrel variants
  if (build.barrel === 'long' && !m.tube) P.push([R * 0.7, R * 0.7, 0.12, 0, 0.05, tip + 0.05, dark]);
  // underbarrel
  const ub = build.underbarrel;
  if (ub === 'vgrip') P.push([0.03, 0.09, 0.03, 0, -0.03, L * 0.75, dark]);
  if (ub === 'agrip') P.push([0.03, 0.05, 0.07, 0, -0.01, L * 0.75, dark, 0.5]);
  if (ub === 'laser') P.push([0.03, 0.03, 0.06, 0, 0.0, L * 0.8, 0x2a2d30], [0.012, 0.012, 0.004, 0, 0.0, L * 0.8 + 0.032, 0xff2020]);
  if (ub === 'bipod') P.push([0.015, 0.14, 0.015, -0.03, -0.05, L * 0.9, dark, 0.4], [0.015, 0.14, 0.015, 0.03, -0.05, L * 0.9, dark, 0.4]);
  return boxes(P);
}

export function gunMuzzleZ(def: WeaponDef, build: Build) {
  const m = def.model;
  let tip = m.tube ? m.length + m.barrel - 0.21 : m.length - 0.08 + m.barrel;
  if (build.muzzle === 'suppressor') tip += 0.16;
  return tip;
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
  if (rig.gun) {
    rig.gunMount.remove(rig.gun);
    rig.gun.geometry.dispose();
  }
  const g = new THREE.Mesh(buildGunGeometry(def, build), toyMaterial);
  g.castShadow = true;
  rig.gunMount.add(g);
  rig.gun = g;
  rig.laser.position.set(0, 0.02, gunMuzzleZ(def, build));
}
