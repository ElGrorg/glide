import * as THREE from 'three';
import { hash2 } from './noise';
import { terrainHeight, nearestBranch, gateZ, nearestGateIndex, type Obstacle } from './world';
import { route, type LiveBranch } from './route';

export type GateType = 'ring' | 'tunnel' | 'needle' | 'arch';

interface GatePoint {
  pos: THREE.Vector3;
  n: THREE.Vector3;      // forward through the gate
  right: THREE.Vector3;
  r: number;             // ring radius, or half-gap for needle/arch
  yMin: number; yMax: number; // vertical window for needle/arch
  done: boolean;
}

export interface Gate {
  k: number; type: GateType;
  points: GatePoint[];
  obstacles: Obstacle[];
  group: THREE.Group;
  rings: THREE.Mesh[];
  hits: number;
}

export interface GateEvent { type: GateType; hit: boolean; index: number; total: number; k: number }

const UP = new THREE.Vector3(0, 1, 0);
/** Centre and direction of the valley nearest nearX at depth z. */
function pathFrame(z: number, nearX: number) {
  const x = nearestBranch(nearX, z).c;
  const x2 = nearestBranch(x, z - 1).c;
  const n = new THREE.Vector3(x2 - x, 0, -1).normalize();
  const right = new THREE.Vector3().crossVectors(n, UP).normalize();
  return { x, n, right };
}

function gateType(k: number, b: LiveBranch, salt: number): GateType {
  const h = hash2(k, salt, 51);
  if (k < 1) return 'ring';
  if (b.canyon > 0.5) return h < 0.35 ? 'tunnel' : h < 0.75 ? 'ring' : 'arch';
  if (b.biome === 'desert' && b.t > 0.5) return h < 0.45 ? 'needle' : h < 0.75 ? 'arch' : 'ring';
  if (b.biome === 'misty' && b.t > 0.5) return h < 0.45 ? 'tunnel' : 'ring';
  if (h < 0.3) return 'tunnel';
  if (h < 0.55) return 'ring';
  if (h < 0.78) return 'needle';
  return 'arch';
}

const ringGeo = new THREE.TorusGeometry(1, 0.07, 6, 28);
const ringMat = new THREE.MeshBasicMaterial({ color: 0x8ff3ff });
const ringDoneMat = new THREE.MeshBasicMaterial({ color: 0xffd45a });
const tunnelMat = new THREE.MeshBasicMaterial({ color: 0xbff6ff, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false });
const rockMat = new THREE.MeshLambertMaterial({ color: 0x8a8174, flatShading: true });
const capMat = new THREE.MeshLambertMaterial({ color: 0xffc94a, flatShading: true, emissive: 0x6a4a00 });
const pillarGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6, 2).translate(0, 0.5, 0);
const lumpGeo = new THREE.IcosahedronGeometry(1, 0);

function makeGate(k: number, b: LiveBranch): Gate {
  const z0 = gateZ(k);
  const salt = (route.forkAt(z0)?.index ?? 0) * 7 + b.index;
  const type = gateType(k, b, salt);
  const group = new THREE.Group();
  const points: GatePoint[] = [];
  const obstacles: Obstacle[] = [];
  const rings: THREE.Mesh[] = [];
  const lift = 10 + hash2(k, salt + 1, 52) * 14;
  let followX = b.c;

  if (type === 'ring' || type === 'tunnel') {
    const count = type === 'tunnel' ? 7 : 1;
    const spacing = 24;
    const R = type === 'tunnel' ? 8 : 6.5;
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i < count; i++) {
      const z = z0 - i * spacing;
      const { x, n, right } = pathFrame(z, followX);
      followX = x;
      const offset = type === 'ring' ? (hash2(k, salt + 2, 53) - 0.5) * 16 : Math.sin(i * 0.9 + k) * 5;
      const px = x + right.x * offset, pz = z + right.z * offset;
      const pos = new THREE.Vector3(px, terrainHeight(px, pz) + lift + (type === 'tunnel' ? Math.sin(i * 0.7) * 3 : 0), pz);
      points.push({ pos, n, right, r: R, yMin: -1e9, yMax: 1e9, done: false });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.scale.setScalar(R);
      ring.position.copy(pos);
      ring.lookAt(pos.clone().add(n));
      group.add(ring); rings.push(ring);
      if (prev) {
        // translucent tube between rings: the "wind tunnel"
        const len = prev.distanceTo(pos);
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(R, R, len, 16, 1, true), tunnelMat);
        tube.position.copy(prev).add(pos).multiplyScalar(0.5);
        tube.quaternion.setFromUnitVectors(UP, pos.clone().sub(prev).normalize());
        group.add(tube);
      }
      prev = pos;
    }
  } else {
    const { x, n, right } = pathFrame(z0, b.c);
    const ground = terrainHeight(x, z0);
    const gapHalf = type === 'needle' ? 4.5 + hash2(k, 3, 54) * 2 : 7 + hash2(k, 3, 54) * 3;
    const clearTop = type === 'arch' ? ground + 9 + hash2(k, 4, 55) * 8 : ground + 34;
    const pos = new THREE.Vector3(x, ground + 5, z0);
    points.push({ pos, n, right, r: gapHalf, yMin: ground, yMax: clearTop, done: false });
    const legR = type === 'needle' ? 3.2 : 3.4;
    for (const side of [-1, 1]) {
      const lx = x + right.x * side * (gapHalf + legR), lz = z0 + right.z * side * (gapHalf + legR);
      const ly = terrainHeight(lx, lz) - 3;
      const top = type === 'arch' ? clearTop + 7 : ly + 40 + hash2(k, side + 5, 56) * 10;
      const leg = new THREE.Mesh(pillarGeo, rockMat);
      leg.position.set(lx, ly, lz); leg.scale.set(legR, top - ly, legR);
      group.add(leg);
      if (type === 'needle') {
        const cap = new THREE.Mesh(lumpGeo, capMat);
        cap.position.set(lx, top, lz); cap.scale.setScalar(legR * 0.9);
        group.add(cap);
      }
      obstacles.push({ id: `g${k}${side}`, type: 'spire', x: lx, z: lz, y0: ly, top, r: legR, scale: 1, tint: 0 });
    }
    if (type === 'arch') {
      // lintel: a row of boulders across the top
      const lumps = 6;
      for (let i = 0; i < lumps; i++) {
        const t = i / (lumps - 1) * 2 - 1;
        const off = t * (gapHalf + legR);
        const lx = x + right.x * off, lz = z0 + right.z * off;
        const r = 3.6;
        const ly = clearTop + r * 0.9 + Math.abs(t) * 1.5;
        const lump = new THREE.Mesh(lumpGeo, rockMat);
        lump.position.set(lx, ly, lz); lump.scale.set(r * 1.2, r, r);
        lump.rotation.set(i, i * 2, i * 3);
        group.add(lump);
        obstacles.push({ id: `g${k}l${i}`, type: 'rock', x: lx, z: lz, y0: ly, top: ly + r, r: r * 0.95, scale: r, tint: 0 });
      }
      // mark the opening with a soft golden ring
      const glow = new THREE.Mesh(ringGeo, ringDoneMat);
      glow.scale.set(gapHalf, (clearTop - ground) / 2, 1);
      glow.position.set(x, (clearTop + ground) / 2, z0);
      glow.lookAt(glow.position.clone().add(n));
      group.add(glow); rings.push(glow);
    }
  }
  return { k, type, points, obstacles, group, rings, hits: 0 };
}

export class Gates {
  active = new Map<string, Gate>();
  constructor(private scene: THREE.Scene) {}

  reset() {
    for (const g of this.active.values()) this.scene.remove(g.group);
    this.active.clear();
  }

  update(z: number, t: number) {
    const k0 = Math.max(0, nearestGateIndex(z) - 1);
    const k1 = Math.max(0, nearestGateIndex(z - 700));
    for (let k = k0; k <= k1; k++) {
      for (const b of route.live(gateZ(k))) {
        const key = `${k}:${route.forkAt(gateZ(k))?.index ?? -1}:${b.index}`;
        if (b.open < 0.95 || this.active.has(key)) continue;
        const g = makeGate(k, b); this.active.set(key, g); this.scene.add(g.group);
      }
    }
    for (const [key, g] of this.active) if (g.k < k0 - 1 || g.k > k1 + 1) { this.scene.remove(g.group); this.active.delete(key); }
    for (const g of this.active.values()) for (const r of g.rings) if (g.type !== 'arch') r.rotateZ(0.02);
    void t;
  }

  obstacles(out: Obstacle[]) {
    for (const g of this.active.values()) out.push(...g.obstacles);
  }

  /** Check gate crossings between two bird positions. */
  check(prev: THREE.Vector3, cur: THREE.Vector3, onEvent: (e: GateEvent) => void) {
    const off = new THREE.Vector3();
    for (const g of this.active.values()) {
      g.points.forEach((p, i) => {
        if (p.done) return;
        const s0 = off.subVectors(prev, p.pos).dot(p.n);
        const s1 = off.subVectors(cur, p.pos).dot(p.n);
        if (!(s0 < 0 && s1 >= 0)) return;
        const lat = off.dot(p.right);
        let hit: boolean;
        if (g.type === 'ring' || g.type === 'tunnel') {
          const vert = cur.y - p.pos.y;
          hit = Math.hypot(lat, vert) < p.r;
        } else {
          hit = Math.abs(lat) < p.r && cur.y > p.yMin && cur.y < p.yMax;
        }
        p.done = true;
        if (hit) {
          g.hits++;
          if (g.rings[i] && g.type !== 'arch') g.rings[i].material = ringDoneMat;
        }
        onEvent({ type: g.type, hit, index: i, total: g.points.length, k: g.k });
      });
    }
  }

  /** Inside a wind tunnel? Returns the push direction and the axis point to drift toward. */
  windAt(pos: THREE.Vector3): { dir: THREE.Vector3; axis: THREE.Vector3 } | null {
    for (const g of this.active.values()) {
      if (g.type !== 'tunnel') continue;
      for (let i = 0; i < g.points.length - 1; i++) {
        const a = g.points[i].pos, b = g.points[i + 1].pos;
        const ab = b.clone().sub(a); const len = ab.length(); ab.divideScalar(len);
        const t = pos.clone().sub(a).dot(ab);
        if (t < 0 || t > len) continue;
        const axis = a.clone().addScaledVector(ab, t);
        if (axis.distanceTo(pos) < g.points[i].r) return { dir: ab, axis };
      }
    }
    return null;
  }
}
