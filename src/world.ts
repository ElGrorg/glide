import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeNoise2D, hash2 } from './noise';

// ---------- Terrain shape: an endless downhill mountainside ----------
// Forward is -Z. The ground falls away by SLOPE metres per metre travelled.
export const SLOPE = 0.27;
const SEED = 1337;
const n1 = makeNoise2D(SEED);
const n2 = makeNoise2D(SEED + 1);
const n3 = makeNoise2D(SEED + 2);

/** Meandering valley centreline, so the slope has a natural "run" to follow. */
export function valleyCenter(z: number): number {
  return 260 * Math.sin(z * 0.0011) + 110 * Math.sin(z * 0.0029 + 1.3);
}

/** Height of the downhill plane (no detail) at depth z. */
export function basePlane(z: number): number {
  return SLOPE * z; // z is negative ahead, so this drops forever
}

/** 0 on the open slope, 1 deep inside a canyon section. Canyons come and go along the run. */
export function canyonAmount(z: number): number {
  if (z > -900) return 0; // open slope for the first stretch of every run
  const n = n1(z / 1100, 77.7);
  return THREE.MathUtils.smoothstep(n, 0.05, 0.35) * THREE.MathUtils.smoothstep(-z, 900, 1400);
}

/** Half-width of the canyon slot at depth z (metres). */
export function canyonHalfWidth(z: number): number {
  return 15 + (n2(z / 260, 5.5) * 0.5 + 0.5) * 14;
}
export const CANYON_FLOOR = -40;  // relative to the downhill plane
export const CANYON_RIM = 60;

export function terrainHeight(x: number, z: number): number {
  const dx = x - valleyCenter(z);
  const valley = Math.min(dx * dx * 0.0016, 260);
  const big = n1(x / 420, z / 420) * 45;
  const mid = n2(x / 110, z / 110) * 14;
  const small = n3(x / 28, z / 28) * 2.5;
  // occasional ridges/mounds across the run to dodge over
  const ridge = Math.max(0, n2(x / 260 + 40, z / 90)) ** 2 * 40;
  const open = valley + big + mid + ridge;
  const c = canyonAmount(z);
  if (c <= 0) return basePlane(z) + open + small;
  // canyon: a narrow slot with near-vertical walls, cut into a raised plateau
  const w = canyonHalfWidth(z) + n3(x / 60, z / 60) * 4;
  const wall = THREE.MathUtils.smoothstep(Math.abs(dx), w, w + 16);
  const profile = CANYON_FLOOR + (CANYON_RIM - CANYON_FLOOR) * wall + mid * 0.5 + big * 0.3 * wall;
  return basePlane(z) + open * (1 - c) + profile * c + small;
}

// ---------- Gates: rings, wind tunnels, needles, arches along the run ----------
export const GATE_SPACING = 210;
export const GATE_START = 380;
export function gateZ(k: number) { return -GATE_START - k * GATE_SPACING; }
export function nearestGateIndex(z: number) { return Math.round((-z - GATE_START) / GATE_SPACING); }
/** Keep trees and rocks off the flight line around each gate. */
function nearGateLine(x: number, z: number): boolean {
  const k = nearestGateIndex(z);
  if (k < 0) return false;
  return Math.abs(z - gateZ(k)) < 45 + 120 * (hash2(k, 0, 51) < 0.3 ? 1 : 0) && Math.abs(x - valleyCenter(z)) < 22;
}

// ---------- Obstacles (deterministic per grid cell) ----------
export type ObstacleType = 'tree' | 'rock' | 'spire';
export interface Obstacle {
  id: string; type: ObstacleType;
  x: number; z: number; y0: number; top: number; r: number; scale: number; tint: number;
}

export const TREE_CELL = 13;
export const ROCK_CELL = 37;

export function forestDensity(x: number, z: number): number {
  return THREE.MathUtils.clamp(n1(x / 160 + 100, z / 160) * 0.9 + 0.35, 0, 0.85);
}

export function treeAt(ix: number, iz: number): Obstacle | null {
  const x = (ix + 0.15 + hash2(ix, iz, 1) * 0.7) * TREE_CELL;
  const z = (iz + 0.15 + hash2(ix, iz, 2) * 0.7) * TREE_CELL;
  if (hash2(ix, iz, 3) > forestDensity(x, z)) return null;
  if (nearGateLine(x, z)) return null;
  // avoid steep faces
  const y0 = terrainHeight(x, z);
  const gx = terrainHeight(x + 2, z) - terrainHeight(x - 2, z);
  const gz = terrainHeight(x, z + 2) - terrainHeight(x, z - 2);
  if (Math.hypot(gx, gz) / 4 > 1.0) return null;
  const scale = 0.8 + hash2(ix, iz, 4) * 1.4;
  const h = 8 * scale;
  return { id: `t${ix},${iz}`, type: 'tree', x, z, y0: y0 - 0.8, top: y0 + h - 0.8, r: 2.3 * scale, scale, tint: hash2(ix, iz, 5) };
}

export function rockAt(ix: number, iz: number): Obstacle | null {
  const roll = hash2(ix, iz, 11);
  const x = (ix + 0.2 + hash2(ix, iz, 12) * 0.6) * ROCK_CELL;
  const z = (iz + 0.2 + hash2(ix, iz, 13) * 0.6) * ROCK_CELL;
  if (roll < 0.22 && nearGateLine(x, z)) return null;
  const y0 = terrainHeight(x, z);
  if (roll < 0.07) {
    // tall spire: something to thread between
    const scale = 0.7 + hash2(ix, iz, 14) * 0.9;
    const h = 30 + hash2(ix, iz, 15) * 45;
    return { id: `s${ix},${iz}`, type: 'spire', x, z, y0: y0 - 3, top: y0 + h, r: 6 * scale, scale, tint: hash2(ix, iz, 16) };
  }
  if (roll < 0.22) {
    const scale = 2 + hash2(ix, iz, 17) * 5;
    return { id: `r${ix},${iz}`, type: 'rock', x, z, y0: y0 + scale * 0.25, top: y0 + scale * 1.2, r: scale, scale, tint: hash2(ix, iz, 18) };
  }
  return null;
}

/** All obstacles whose cells touch the circle around (x, z). */
export function obstaclesNear(x: number, z: number, radius: number, out: Obstacle[] = []): Obstacle[] {
  out.length = 0;
  const t0x = Math.floor((x - radius) / TREE_CELL), t1x = Math.floor((x + radius) / TREE_CELL);
  const t0z = Math.floor((z - radius) / TREE_CELL), t1z = Math.floor((z + radius) / TREE_CELL);
  for (let ix = t0x; ix <= t1x; ix++) for (let iz = t0z; iz <= t1z; iz++) { const o = treeAt(ix, iz); if (o) out.push(o); }
  const r0x = Math.floor((x - radius - 30) / ROCK_CELL), r1x = Math.floor((x + radius + 30) / ROCK_CELL);
  const r0z = Math.floor((z - radius - 30) / ROCK_CELL), r1z = Math.floor((z + radius + 30) / ROCK_CELL);
  for (let ix = r0x; ix <= r1x; ix++) for (let iz = r0z; iz <= r1z; iz++) { const o = rockAt(ix, iz); if (o) out.push(o); }
  return out;
}

/** Signed gap between a point and an obstacle's surface (negative = inside). */
export function obstacleGap(o: Obstacle, px: number, py: number, pz: number): number {
  const dx = px - o.x, dz = pz - o.z;
  if (o.type === 'rock') {
    const cy = o.y0;
    return Math.hypot(dx, py - cy, dz) - o.r;
  }
  const horiz = Math.hypot(dx, dz);
  if (py > o.top) return Math.hypot(Math.max(0, horiz - (o.type === 'spire' ? o.r : 0)), py - o.top);
  if (py < o.y0) return 99;
  let rEff = o.r;
  if (o.type === 'tree') {
    const h = o.top - o.y0;
    const t = (py - o.y0) / h; // 0 at base, 1 at top
    rEff = t < 0.2 ? 0.5 * o.scale : o.r * Math.min(1, (1 - t) / 0.8) * 0.85;
  }
  return horiz - rEff;
}

// ---------- Clouds ----------
export interface Cloud { id: string; puffs: { x: number; y: number; z: number; r: number }[] }
export const CLOUD_CELL = 150;
export function cloudAt(ix: number, iz: number): Cloud | null {
  if (hash2(ix, iz, 31) > 0.55) return null;
  const cx = (ix + 0.5) * CLOUD_CELL + (hash2(ix, iz, 32) - 0.5) * 80;
  const cz = (iz + 0.5) * CLOUD_CELL + (hash2(ix, iz, 33) - 0.5) * 80;
  const ground = terrainHeight(cx, cz);
  const cy = Math.max(ground + 25, basePlane(cz) + 20 + hash2(ix, iz, 34) * 90);
  const count = 5 + Math.floor(hash2(ix, iz, 35) * 7);
  const puffs = [];
  for (let i = 0; i < count; i++) {
    const r = 9 + hash2(ix * 7 + i, iz, 36) * 14;
    puffs.push({
      x: cx + (hash2(ix, iz * 5 + i, 37) - 0.5) * 70,
      y: cy + (hash2(ix + i, iz, 38) - 0.5) * 14,
      z: cz + (hash2(ix, iz + i * 3, 39) - 0.5) * 45,
      r,
    });
  }
  return { id: `c${ix},${iz}`, puffs };
}

// ---------- Shared geometry & materials ----------
function colorize(g: THREE.BufferGeometry, c: THREE.ColorRepresentation) {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function makeTreeGeometry() {
  const trunk = colorize(new THREE.CylinderGeometry(0.35, 0.5, 2.4, 5).translate(0, 1.2, 0).toNonIndexed(), 0x6b4a2f);
  const c1 = colorize(new THREE.ConeGeometry(2.3, 4.2, 6).translate(0, 3.6, 0).toNonIndexed(), 0x3f7a3a);
  const c2 = colorize(new THREE.ConeGeometry(1.7, 3.4, 6).translate(0, 5.6, 0).toNonIndexed(), 0x4c8c42);
  const c3 = colorize(new THREE.ConeGeometry(1.0, 2.4, 6).translate(0, 7.0, 0).toNonIndexed(), 0x5a9d4c);
  return mergeGeometries([trunk, c1, c2, c3])!;
}
const treeGeo = makeTreeGeometry();
const rockGeo = colorize(new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), 0x8d877c);
const spireGeo = colorize(new THREE.CylinderGeometry(0.55, 1, 1, 6, 3).translate(0, 0.5, 0).toNonIndexed(), 0x857c70);
const cloudGeo = new THREE.IcosahedronGeometry(1, 1);

const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
export const cloudMat = new THREE.MeshLambertMaterial({
  color: 0xffffff, emissive: 0xb8c4d6, emissiveIntensity: 0.45, flatShading: true, transparent: true, opacity: 0.88,
});

// ---------- Chunks ----------
export const CHUNK = 120;
const SEG = 30;

const C_GRASS = new THREE.Color(0x8fbd5a);
const C_GRASS2 = new THREE.Color(0x6e9f45);
const C_DIRT = new THREE.Color(0xb39a68);
const C_ROCK = new THREE.Color(0x8a8378);
const C_SNOW = new THREE.Color(0xf2f4f6);
const tmpC = new THREE.Color();

function faceColor(cx: number, cz: number, ny: number, h: number, out: THREE.Color) {
  const rel = h - basePlane(cz); // height above the downhill plane
  const v = n3(cx / 40, cz / 40) * 0.5 + 0.5;
  out.copy(C_GRASS).lerp(C_GRASS2, v);
  if (rel < -8) out.lerp(C_DIRT, 0.5);
  if (ny < 0.82) out.lerp(C_ROCK, THREE.MathUtils.clamp((0.82 - ny) * 5, 0, 1));
  if (rel > 140 + v * 40) out.lerp(C_SNOW, THREE.MathUtils.clamp((rel - 140 - v * 40) / 30, 0, 1));
  // tiny per-face jitter sells the low-poly look
  out.offsetHSL(0, 0, (hash2(Math.floor(cx * 3), Math.floor(cz * 3), 9) - 0.5) * 0.04);
}

export class Chunk {
  group = new THREE.Group();
  clouds: Cloud[] = [];
  constructor(public cx: number, public cz: number) {
    this.group.add(this.buildGround());
    this.buildObstacles();
    this.buildClouds();
  }

  private buildGround() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK, step = CHUNK / SEG;
    const N = SEG + 1;
    const hs = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hs[j * N + i] = terrainHeight(x0 + i * step, z0 + j * step);
    const pos = new Float32Array(SEG * SEG * 6 * 3);
    const col = new Float32Array(SEG * SEG * 6 * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    let p = 0;
    const tri = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
      a.set(x0 + i0 * step, hs[j0 * N + i0], z0 + j0 * step);
      b.set(x0 + i1 * step, hs[j1 * N + i1], z0 + j1 * step);
      c.set(x0 + i2 * step, hs[j2 * N + i2], z0 + j2 * step);
      e1.subVectors(b, a); e2.subVectors(c, a);
      const nrm = e1.cross(e2).normalize();
      faceColor((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, Math.abs(nrm.y), (a.y + b.y + c.y) / 3, tmpC);
      for (const v of [a, b, c]) {
        pos[p] = v.x; pos[p + 1] = v.y; pos[p + 2] = v.z;
        col[p] = tmpC.r; col[p + 1] = tmpC.g; col[p + 2] = tmpC.b;
        p += 3;
      }
    };
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      if ((i + j) % 2 === 0) { tri(i, j, i, j + 1, i + 1, j); tri(i + 1, j, i, j + 1, i + 1, j + 1); }
      else { tri(i, j, i, j + 1, i + 1, j + 1); tri(i, j, i + 1, j + 1, i + 1, j); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return new THREE.Mesh(g, solidMat);
  }

  private buildObstacles() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK;
    const trees: Obstacle[] = [], rocks: Obstacle[] = [], spires: Obstacle[] = [];
    for (let ix = Math.ceil(x0 / TREE_CELL); ix < Math.ceil((x0 + CHUNK) / TREE_CELL); ix++)
      for (let iz = Math.ceil(z0 / TREE_CELL); iz < Math.ceil((z0 + CHUNK) / TREE_CELL); iz++) {
        const t = treeAt(ix, iz); if (t) trees.push(t);
      }
    for (let ix = Math.ceil(x0 / ROCK_CELL); ix < Math.ceil((x0 + CHUNK) / ROCK_CELL); ix++)
      for (let iz = Math.ceil(z0 / ROCK_CELL); iz < Math.ceil((z0 + CHUNK) / ROCK_CELL); iz++) {
        const r = rockAt(ix, iz); if (r) (r.type === 'spire' ? spires : rocks).push(r);
      }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    if (trees.length) {
      const im = new THREE.InstancedMesh(treeGeo, solidMat, trees.length);
      trees.forEach((t, i) => {
        q.setFromAxisAngle(up, t.tint * 6.28);
        m.compose(pv.set(t.x, t.y0, t.z), q, s.setScalar(t.scale));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.setHSL(0.0, 0, 0.85 + t.tint * 0.3));
      });
      this.group.add(im);
    }
    if (rocks.length) {
      const im = new THREE.InstancedMesh(rockGeo, solidMat, rocks.length);
      rocks.forEach((r, i) => {
        q.setFromEuler(new THREE.Euler(r.tint * 3, r.tint * 7, r.tint * 5));
        m.compose(pv.set(r.x, r.y0, r.z), q, s.set(r.scale, r.scale * (0.7 + r.tint * 0.4), r.scale));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.setHSL(0, 0, 0.85 + r.tint * 0.3));
      });
      this.group.add(im);
    }
    if (spires.length) {
      const im = new THREE.InstancedMesh(spireGeo, solidMat, spires.length);
      spires.forEach((r, i) => {
        q.setFromAxisAngle(up, r.tint * 6.28);
        m.compose(pv.set(r.x, r.y0, r.z), q, s.set(r.r, r.top - r.y0, r.r));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.setHSL(0, 0, 0.8 + r.tint * 0.3));
      });
      this.group.add(im);
    }
  }

  private buildClouds() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK;
    const puffs: Cloud['puffs'] = [];
    for (let ix = Math.ceil(x0 / CLOUD_CELL); ix < Math.ceil((x0 + CHUNK) / CLOUD_CELL); ix++)
      for (let iz = Math.ceil(z0 / CLOUD_CELL); iz < Math.ceil((z0 + CHUNK) / CLOUD_CELL); iz++) {
        const cl = cloudAt(ix, iz); if (cl) { this.clouds.push(cl); puffs.push(...cl.puffs); }
      }
    if (!puffs.length) return;
    const im = new THREE.InstancedMesh(cloudGeo, cloudMat, puffs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3();
    puffs.forEach((p, i) => { m.compose(pv.set(p.x, p.y, p.z), q, s.set(p.r, p.r * 0.7, p.r)); im.setMatrixAt(i, m); });
    im.renderOrder = 2;
    this.group.add(im);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) o.geometry.dispose();
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
  }
}

export class World {
  chunks = new Map<string, Chunk>();
  constructor(private scene: THREE.Scene, public radius = 4) {}

  /** Stream chunks around a focus point (biased ahead of the bird). Builds at most `budget` per call. */
  update(fx: number, fz: number, budget = 2) {
    const ccx = Math.floor(fx / CHUNK), ccz = Math.floor(fz / CHUNK);
    const R = this.radius;
    const want: [number, number, number][] = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const d = dx * dx + dz * dz;
      if (d > R * R + 1) continue;
      want.push([ccx + dx, ccz + dz, d]);
    }
    want.sort((a, b) => a[2] - b[2]);
    const keep = new Set<string>();
    let built = 0;
    for (const [x, z] of want) {
      const k = `${x},${z}`;
      keep.add(k);
      if (!this.chunks.has(k) && built < budget) {
        const c = new Chunk(x, z);
        this.chunks.set(k, c);
        this.scene.add(c.group);
        built++;
      }
    }
    for (const [k, c] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      if (!keep.has(k) && (Math.abs(x - ccx) > R + 1 || Math.abs(z - ccz) > R + 1)) {
        this.scene.remove(c.group); c.dispose(); this.chunks.delete(k);
      }
    }
    return built;
  }

  /** Is the point inside any cloud puff? Returns 0..1 depth and the cloud id. */
  cloudDepth(x: number, y: number, z: number): { depth: number; id: string | null } {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let best = 0, id: string | null = null;
    // clouds can spill into neighbouring chunks, so check the 3x3 around
    const [cx, cz] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.chunks.get(`${cx + dx},${cz + dz}`);
      if (!c) continue;
      for (const cl of c.clouds) for (const p of cl.puffs) {
        const d = Math.hypot((x - p.x) / p.r, (y - p.y) / (p.r * 0.7), (z - p.z) / p.r);
        const depth = 1 - d;
        if (depth > best) { best = depth; id = cl.id; }
      }
    }
    return { depth: best, id };
  }
}
