import * as THREE from 'three';
import { CORE_HP, Team } from '../core/config';
import { boxes, toyMaterial } from './models';

/** The objective: a floating energy core on a pedestal inside each HQ bunker. */
export class Core {
  readonly group = new THREE.Group();
  readonly pos: THREE.Vector3;
  hp = CORE_HP;
  alive = true;
  lastHit = -99;
  lastHitFrom: { x: number; z: number } | null = null;
  hitFlash = 0;
  private crystal: THREE.Mesh;
  private rings: THREE.Mesh[] = [];
  private crystalMat: THREE.MeshLambertMaterial;
  private glow: THREE.Mesh;
  private color: THREE.Color;
  readonly radius = 1.1;
  readonly height = 3.2;

  constructor(public team: Team, x: number, y: number, z: number) {
    this.pos = new THREE.Vector3(x, y, z);
    this.group.position.copy(this.pos);
    const tc = team === 0 ? 0x3d8bff : 0xff4d3d;
    this.color = new THREE.Color(tc);
    const ped = new THREE.Mesh(
      boxes([
        [1.6, 0.3, 1.6, 0, 0.15, 0, 0x3c4249],
        [1.2, 0.5, 1.2, 0, 0.55, 0, 0x2a2f35],
        [1.5, 0.12, 0.2, 0, 0.82, 0.62, tc],
        [1.5, 0.12, 0.2, 0, 0.82, -0.62, tc],
        [0.2, 0.12, 1.5, 0.62, 0.82, 0, tc],
        [0.2, 0.12, 1.5, -0.62, 0.82, 0, tc],
        [0.25, 2.4, 0.25, 0.75, 1.2, 0.75, 0x3c4249],
        [0.25, 2.4, 0.25, -0.75, 1.2, 0.75, 0x3c4249],
        [0.25, 2.4, 0.25, 0.75, 1.2, -0.75, 0x3c4249],
        [0.25, 2.4, 0.25, -0.75, 1.2, -0.75, 0x3c4249],
        [1.75, 0.18, 1.75, 0, 2.45, 0, 0x2a2f35],
      ]),
      toyMaterial,
    );
    ped.castShadow = true;
    ped.receiveShadow = true;
    this.group.add(ped);

    this.crystalMat = new THREE.MeshLambertMaterial({ color: tc, emissive: tc, emissiveIntensity: 2.6, flatShading: true });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), this.crystalMat);
    this.crystal.scale.set(1, 1.6, 1);
    this.crystal.position.y = 1.65;
    this.crystal.castShadow = true;
    this.group.add(this.crystal);
    const ringMat = new THREE.MeshLambertMaterial({ color: 0xdfe6ee, emissive: tc, emissiveIntensity: 1.4 });
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.85 + i * 0.18, 0.04, 6, 32), ringMat);
      r.position.y = 1.65;
      this.rings.push(r);
      this.group.add(r);
    }
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: tc, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.glow.position.y = 0.32;
    this.group.add(this.glow);
  }

  update(dt: number, t: number) {
    if (!this.alive) return;
    this.crystal.rotation.y += dt * 0.9;
    this.crystal.position.y = 1.65 + Math.sin(t * 1.6) * 0.08;
    this.rings[0].rotation.set(Math.sin(t * 0.7) * 0.6 + 1.2, t * 1.1, 0);
    this.rings[1].rotation.set(Math.cos(t * 0.5) * 0.7 + 0.4, -t * 0.8, 0.3);
    const hpK = this.hp / CORE_HP;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    const pulse = 0.5 + 0.5 * Math.sin(t * (hpK < 0.3 ? 9 : 2.5));
    this.crystalMat.emissiveIntensity = 1.8 + pulse * 1.2 + this.hitFlash * 6;
    this.crystalMat.emissive.copy(this.color).lerp(new THREE.Color(1, 1, 1), this.hitFlash * 0.6);
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.25 + pulse * 0.2;
  }

  hit(dmg: number, t: number, fromX: number, fromZ: number) {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - dmg);
    this.lastHit = t;
    this.lastHitFrom = { x: fromX, z: fromZ };
    this.hitFlash = Math.min(1, this.hitFlash + dmg / 60);
    if (this.hp <= 0) {
      this.alive = false;
      this.crystal.visible = false;
      this.rings.forEach((r) => (r.visible = false));
      this.glow.visible = false;
      return true;
    }
    return false;
  }

  /** ray (horizontal-ish) vs vertical cylinder; returns distance or -1 */
  intersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    if (!this.alive) return -1;
    const px = ox - this.pos.x, pz = oz - this.pos.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-6) return -1;
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - this.radius * this.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > maxT) return -1;
    const y = oy + dy * t;
    if (y < this.pos.y || y > this.pos.y + this.height) return -1;
    return t;
  }
}
