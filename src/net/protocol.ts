import * as THREE from 'three';

/** bumped whenever peers of different builds could no longer understand each other */
export const PROTOCOL = 1;
export const MAX_HUMANS = 10;

/** soldier snapshot flags */
export const F_ALIVE = 1;
export const F_ADS = 2;
export const F_SPRINT = 4;
export const F_RELOAD = 8;
export const F_GROUND = 16;
export const F_MARKED = 32;
export const F_LOUD = 64;
/** the enemy team knows where this soldier is */
export const F_SEEN = 128;

const TAU = Math.PI * 2;

/** a growable little-endian byte writer */
export class Writer {
  buf = new ArrayBuffer(1024);
  dv = new DataView(this.buf);
  o = 0;
  private need(n: number) {
    if (this.o + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.o + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = nb;
    this.dv = new DataView(nb);
  }
  reset() {
    this.o = 0;
    return this;
  }
  u8(v: number) {
    this.need(1);
    this.dv.setUint8(this.o, v);
    this.o += 1;
  }
  u16(v: number) {
    this.need(2);
    this.dv.setUint16(this.o, v, true);
    this.o += 2;
  }
  i16(v: number) {
    this.need(2);
    this.dv.setInt16(this.o, Math.max(-32767, Math.min(32767, Math.round(v))), true);
    this.o += 2;
  }
  u32(v: number) {
    this.need(4);
    this.dv.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  f32(v: number) {
    this.need(4);
    this.dv.setFloat32(this.o, v, true);
    this.o += 4;
  }
  bytes(b: Uint8Array) {
    this.need(b.byteLength);
    new Uint8Array(this.buf, this.o, b.byteLength).set(b);
    this.o += b.byteLength;
  }
  yaw(a: number) {
    this.u16(Math.round((((a % TAU) + TAU) % TAU) / TAU * 65535));
  }
  /** a copy of what was written */
  done() {
    return new Uint8Array(this.buf.slice(0, this.o));
  }
}

export class Reader {
  dv: DataView;
  o = 0;
  constructor(public buf: ArrayBuffer) {
    this.dv = new DataView(buf);
  }
  get left() {
    return this.buf.byteLength - this.o;
  }
  u8() {
    return this.dv.getUint8(this.o++);
  }
  u16() {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  i16() {
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }
  yaw() {
    return (this.u16() / 65535) * TAU;
  }
  /** an aligned copy of the next n bytes */
  take(n: number) {
    const b = this.buf.slice(this.o, this.o + n);
    this.o += n;
    return b;
  }
}

// ------------------------------------------------------------------------------ messages
export const MSG_SNAP = 1;
export const MSG_STATE = 2;

export interface SoldierSnap {
  id: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  hp: number;
  spin: number;
  wi: number;
}

export interface BodySnap {
  nid: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export interface Snapshot {
  t: number;
  timeLeft: number;
  cores: [number, number];
  soldiers: SoldierSnap[];
  bodies: BodySnap[];
}

export function readSnapshot(buf: ArrayBuffer): Snapshot | null {
  const r = new Reader(buf);
  if (r.u8() !== MSG_SNAP) return null;
  const t = r.f32(), timeLeft = r.f32();
  const cores: [number, number] = [r.f32(), r.f32()];
  const soldiers: SoldierSnap[] = [];
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    soldiers.push({ id: r.u16(), flags: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), vx: r.i16() / 100, vy: r.i16() / 100, vz: r.i16() / 100, yaw: r.yaw(), hp: r.u8(), spin: r.u8() / 255, wi: r.u8() });
  }
  const bodies: BodySnap[] = [];
  const nb = r.u8();
  for (let i = 0; i < nb; i++) {
    const nid = r.u32();
    const pos = new THREE.Vector3(r.f32(), r.f32(), r.f32());
    const quat = new THREE.Quaternion(r.i16() / 32767, r.i16() / 32767, r.i16() / 32767, r.i16() / 32767).normalize();
    bodies.push({ nid, pos, quat });
  }
  return { t, timeLeft, cores, soldiers, bodies };
}

/** what a peer reports about its own player */
export interface PeerState {
  t: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  flags: number;
  wi: number;
  spin: number;
}

export function writeState(w: Writer, s: PeerState) {
  w.reset();
  w.u8(MSG_STATE);
  w.f32(s.t);
  w.u8(s.life & 255);
  w.f32(s.x);
  w.f32(s.y);
  w.f32(s.z);
  w.i16(s.vx * 100);
  w.i16(s.vy * 100);
  w.i16(s.vz * 100);
  w.yaw(s.yaw);
  w.u8(s.flags);
  w.u8(s.wi);
  w.u8(Math.round(s.spin * 255));
  return w.done();
}

export function readState(buf: ArrayBuffer): PeerState | null {
  const r = new Reader(buf);
  if (r.left < 29 || r.u8() !== MSG_STATE) return null;
  return { t: r.f32(), life: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), vx: r.i16() / 100, vy: r.i16() / 100, vz: r.i16() / 100, yaw: r.yaw(), flags: r.u8(), wi: r.u8(), spin: r.u8() / 255 };
}

/** voxel edits: indices (top bit = a move, not a break) then materials */
export function writeEdits(idx: ArrayLike<number>, mats: ArrayLike<number>, n: number) {
  const buf = new ArrayBuffer(4 + n * 5);
  new Uint32Array(buf, 0, 1)[0] = n;
  const I = new Uint32Array(buf, 4, n);
  const M = new Uint8Array(buf, 4 + n * 4, n);
  for (let k = 0; k < n; k++) {
    I[k] = idx[k];
    M[k] = mats[k];
  }
  return new Uint8Array(buf);
}

export function readEdits(buf: ArrayBuffer) {
  const n = new Uint32Array(buf, 0, 1)[0];
  return { idx: new Uint32Array(buf, 4, n), mats: new Uint8Array(buf, 4 + n * 4, n) };
}

export interface BodySpawn {
  nid: number;
  gen: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  colorOffset: THREE.Vector3;
  grid: Int16Array;
  mats: Uint8Array;
}

export function writeBody(w: Writer, b: BodySpawn) {
  w.reset();
  w.u32(b.nid);
  w.u8(b.gen);
  for (const v of [b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w, b.colorOffset.x, b.colorOffset.y, b.colorOffset.z]) w.f32(v);
  w.u32(b.mats.length);
  w.bytes(new Uint8Array(b.grid.buffer, b.grid.byteOffset, b.grid.byteLength));
  w.bytes(b.mats);
  return w.done();
}

export function readBody(buf: ArrayBuffer): BodySpawn {
  const r = new Reader(buf);
  const nid = r.u32(), gen = r.u8();
  const pos = new THREE.Vector3(r.f32(), r.f32(), r.f32());
  const quat = new THREE.Quaternion(r.f32(), r.f32(), r.f32(), r.f32());
  const colorOffset = new THREE.Vector3(r.f32(), r.f32(), r.f32());
  const n = r.u32();
  const grid = new Int16Array(r.take(n * 6));
  const mats = new Uint8Array(r.take(n));
  return { nid, gen, pos, quat, colorOffset, grid, mats };
}

/** short floats for JSON events */
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const v3 = (v: THREE.Vector3) => [r3(v.x), r3(v.y), r3(v.z)];
