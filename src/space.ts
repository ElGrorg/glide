import * as THREE from 'three';
import { hash2, makeNoise2D } from './noise';
import type { Obstacle } from './world';

// ---------- Space mode: a capital-ship battle in low orbit over a wild planet ----------
// No air up here, so no gliding and no stall: every fighter cruises at the same speed, can boost (on a
// fuel gauge that refills) to change pace, or brake to slow right down and turn much tighter.
// Your fighter and the enemy fighters all use exactly these numbers.

export const SPACE_CRUISE = 55;      // m/s: hands-off speed
export const SPACE_BOOST = 95;       // full boost
export const SPACE_BRAKE = 22;       // full brake
const SPACE_ACCEL = 28;              // m/s^2 speeding up
const SPACE_DECEL = 42;              // m/s^2 slowing down
export const SPACE_PITCH_RATE = 1.45; // rad/s at cruise
export const SPACE_ROLL_RATE = 2.8;
export const SPACE_YAW_RATE = 0.8;
const BRAKE_TURN_BONUS = 0.85;       // full brake turns up to 85% faster...
const BOOST_TURN_CUT = 0.3;          // ...full boost 30% slower
export const BOOST_TIME = 3.5;       // seconds of boost on a full tank
const BOOST_RECHARGE = 7;            // seconds to refill an empty tank
/** Lasers: much faster than peas (they're light, after all), so the range is longer too. */
export const LASER_SPEED = 260;
export const LASER_LIFE = 0.8;
/** Missiles (the space darts) have to outrun a boosting fighter. */
export const MISSILE_SPEED = 140;

const { clamp, smoothstep, lerp } = THREE.MathUtils;

/** Speed the throttle is heading for. `boost` and `brake` are 0..1 (brake wins). */
export function spaceTargetSpeed(boost: number, brake: number) {
  if (brake > 0.05) boost = 0;
  return SPACE_CRUISE + (SPACE_BOOST - SPACE_CRUISE) * boost - (SPACE_CRUISE - SPACE_BRAKE) * brake;
}
/** One step of the throttle: speed eases toward the target at the shared accel / decel rates. */
export function stepThrottle(speed: number, boost: number, brake: number, dt: number) {
  const d = spaceTargetSpeed(boost, brake) - speed;
  return speed + clamp(d, -SPACE_DECEL * dt, SPACE_ACCEL * dt);
}
/** How much faster (or slower) than normal you can turn: braking tightens it, boosting widens it. */
export function spaceTurnMul(boost: number, brake: number) {
  return 1 + BRAKE_TURN_BONUS * brake - BOOST_TURN_CUT * (brake > 0.05 ? 0 : boost);
}
/** Boost fuel 0..1 after a step. Returns the boost you actually get (0 once the tank runs dry). */
export function stepFuel(f: { boostFuel: number }, want: number, dt: number) {
  const b = f.boostFuel > 0.01 ? want : 0;
  f.boostFuel = clamp(f.boostFuel + (b > 0.05 ? -b * dt / BOOST_TIME : dt / BOOST_RECHARGE), 0, 1);
  return b;
}

// ---------- Field layout ----------
/** Flyable radius (m from the middle) and the barrier a little beyond it. */
export const SPACE_R = 700;
export const SPACE_LID_R = SPACE_R + 140;
/** The asteroid belt spans these heights; above SPACE_CEIL there's an invisible barrier. */
const FIELD_LO = -70, FIELD_HI = 520;
export const SPACE_CEIL = 660;
export const SPACE_SPAWN_Y = 230;
/** The planet: a huge sphere whose top sits at PLANET_TOP. Skim it if you dare. */
export const PLANET_R = 9000;
export const PLANET_TOP = -330;
export function planetHeight(x: number, z: number) {
  const d2 = Math.min(x * x + z * z, PLANET_R * PLANET_R * 0.99);
  return PLANET_TOP - PLANET_R + Math.sqrt(PLANET_R * PLANET_R - d2);
}
/** Keep `pos` inside the field's walls (radius and ceiling). Returns how far it had to push (m). */
export function spaceBarrier(pos: { x: number; y: number; z: number }) {
  let pushed = 0;
  const r = Math.hypot(pos.x, pos.z);
  if (r > SPACE_LID_R) { const k = SPACE_LID_R / r; pos.x *= k; pos.z *= k; pushed += r - SPACE_LID_R; }
  if (pos.y > SPACE_CEIL) { pushed += pos.y - SPACE_CEIL; pos.y = SPACE_CEIL; }
  return pushed;
}
/** 0..1: how close you are to the edge of the field (for the TURN BACK warning). */
export function spaceEdge(p: { x: number; y: number; z: number }) {
  return Math.max(clamp((Math.hypot(p.x, p.z) - (SPACE_LID_R - 100)) / 100, 0, 1), clamp((p.y - (SPACE_CEIL - 80)) / 80, 0, 1));
}

// ---------- The battle: two fleets of capital ships trading fire over the planet ----------
// Every ship is built from boxes (so its hit shape is exact): long hulls with a tunnel or a hangar bay
// you can fly straight through, a trench along the top between two ridges, side sponsons on pylons
// with a slot between them and the hull, towers to swing round. The two fleets lie broadside to each
// other with open space between, where the dogfight happens.

/** A box in a ship's own frame: u along the ship (+ = bow), v up, w across (+ = starboard). */
type Part = [u0: number, u1: number, v0: number, v1: number, w0: number, w1: number];
/** An opening you can fly through: its centre (ship frame), which axis you fly along, and its half size. */
interface Opening { u: number; v: number; w: number; along: 'u' | 'w'; hv: number; hs: number; kind: 'hangar' | 'hull' }
export interface Ship {
  kind: 'carrier' | 'cruiser' | 'frigate';
  x: number; cy: number; z: number; fx: number; fz: number; yaw: number; len: number; side: 0 | 1;
  radius: number; boxes: Obstacle[]; openings: Opening[];
  parts: Part[]; trim: Part[]; lights: Part[]; engines: Part[]; guns: [number, number, number][];
}
let ships: Ship[] = [];
export const fleet = () => ships;

/** Signed gap between a point and one of a ship's boxes (negative = inside). */
export function spaceGap(o: Obstacle, px: number, py: number, pz: number): number {
  const dx = px - o.x, dy = py - o.cy!, dz = pz - o.z;
  const u = dx * o.ax! + dz * o.az!, w = -dx * o.az! + dz * o.ax!;
  const qx = Math.abs(u) - o.hx!, qy = Math.abs(dy) - o.hy!, qz = Math.abs(w) - o.hz!;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

/** Every ship box that could be near the column around (x, z). */
export function shipPartsNear(x: number, z: number, radius: number, out: Obstacle[]) {
  for (const s of ships) {
    if (Math.hypot(s.x - x, s.z - z) > radius + s.radius) continue;
    for (const b of s.boxes) if (Math.abs(b.x - x) < radius + b.scale && Math.abs(b.z - z) < radius + b.scale) out.push(b);
  }
  return out;
}

const toLocal = (s: Ship, p: THREE.Vector3, out: THREE.Vector3) => {
  const dx = p.x - s.x, dz = p.z - s.z;
  return out.set(dx * s.fx + dz * s.fz, p.y - s.cy, -dx * s.fz + dz * s.fx); // (u, v, w)
};
const la = new THREE.Vector3(), lb = new THREE.Vector3();
/** Did the step prev -> cur fly through one of the ships' openings (a hangar bay end to end, or a tunnel across the hull)? */
export function holeThreaded(prev: THREE.Vector3, cur: THREE.Vector3): Opening | null {
  for (const s of ships) {
    if (Math.hypot(s.x - cur.x, s.z - cur.z) > s.radius + 20) continue;
    toLocal(s, prev, la); toLocal(s, cur, lb);
    for (const o of s.openings) {
      const a0 = o.along === 'u' ? la.x - o.u : la.z - o.w, a1 = o.along === 'u' ? lb.x - o.u : lb.z - o.w;
      if (a0 === a1 || Math.sign(a0) === Math.sign(a1)) continue;
      const f = a0 / (a0 - a1);
      const v = lerp(la.y, lb.y, f) - o.v;
      const side = o.along === 'u' ? lerp(la.z, lb.z, f) - o.w : lerp(la.x, lb.x, f) - o.u;
      if (Math.abs(v) < o.hv && Math.abs(side) < o.hs) return o;
    }
  }
  return null;
}

/** Pick a height near `y` where a fighter at (x, z) flying along `dir` has a clear run (no hull right ahead). */
export function clearSpawnY(x: number, z: number, dir: THREE.Vector3, y = SPACE_SPAWN_Y) {
  const near: Obstacle[] = [];
  const ok = (yy: number) => {
    for (let d = -20; d <= 170; d += 10) {
      const px = x + dir.x * d, pz = z + dir.z * d, py = yy + dir.y * d;
      near.length = 0;
      for (const o of shipPartsNear(px, pz, 6, near)) if (spaceGap(o, px, py, pz) < 18) return false;
    }
    return true;
  };
  for (let i = 0; i < 30; i++) {
    const yy = y + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 18;
    if (ok(yy)) return yy;
  }
  return y;
}

type Hull = Omit<Ship, 'kind' | 'x' | 'cy' | 'z' | 'fx' | 'fz' | 'yaw' | 'side' | 'radius' | 'boxes'>;
/** A cruiser: a long hull with a tunnel straight across it, a trench along its back, sponsons on pylons. */
function cruiser(L: number, h: (k: number) => number): Hull {
  const H = L * 0.13, W = L * 0.2;
  const t0 = L * (0.02 + h(1) * 0.12), a = 16, b = 13; // the tunnel across the hull: 32 m long, 26 m tall
  const gap = 17, sw = W * 0.2;                         // slot between hull and sponsons
  const parts: Part[] = [
    [-L / 2, t0 - a, -H / 2, H / 2, -W / 2, W / 2],
    [t0 + a, L * 0.3, -H / 2, H / 2, -W / 2, W / 2],
    [t0 - a, t0 + a, b, H / 2, -W / 2, W / 2],          // tunnel roof
    [t0 - a, t0 + a, -H / 2, -b, -W / 2, W / 2],        // tunnel floor
    [L * 0.3, L * 0.46, -H * 0.38, H * 0.3, -W * 0.33, W * 0.33], // bow
    [L * 0.46, L * 0.52, -H * 0.22, H * 0.12, -W * 0.16, W * 0.16],
    // trench ridges along the back
    [-L * 0.42, L * 0.24, H / 2, H / 2 + H * 0.38, -W * 0.46, -W * 0.18],
    [-L * 0.42, L * 0.24, H / 2, H / 2 + H * 0.38, W * 0.18, W * 0.46],
    // command tower and its bridge
    [-L * 0.4, -L * 0.3, H / 2 + H * 0.38, H / 2 + H * 1.25, -W * 0.13, W * 0.13],
    [-L * 0.39, -L * 0.31, H / 2 + H * 1.25, H / 2 + H * 1.45, -W * 0.34, W * 0.34],
    // keel fin
    [-L * 0.25, L * 0.12, -H / 2 - H * 0.45, -H / 2, -2.5, 2.5],
  ];
  // sponsons stop short of the tunnel, so its mouths open onto clear space
  const sEnd = t0 - a - 12;
  for (const s of [-1, 1]) {
    const w0 = s * (W / 2 + gap), w1 = s * (W / 2 + gap + sw);
    parts.push([-L * 0.42, sEnd, -H * 0.32, H * 0.12, Math.min(w0, w1), Math.max(w0, w1)]); // sponson
    for (const u of [-L * 0.39, sEnd - L * 0.07]) parts.push([u, u + L * 0.05, -H * 0.16, H * 0.02, Math.min(s * W / 2, w0), Math.max(s * W / 2, w0)]); // pylons
  }
  const engines: Part[] = [];
  for (const w of [-W * 0.3, 0, W * 0.3]) engines.push([-L / 2 - L * 0.05, -L / 2, -H * 0.3, H * 0.3, w - W * 0.12, w + W * 0.12]);
  return { len: L, parts, trim: [], lights: [], engines, guns: [], openings: [{ u: t0, v: 0, w: 0, along: 'w', hv: b, hs: a, kind: 'hull' }] };
}
/** A carrier: the hangar bay runs the whole length of the hull, open at both ends. Fly in the front, out the back. */
function carrier(L: number, h: (k: number) => number): Hull {
  const H = L * 0.14, W = L * 0.25, hv = 17, hs = 20;
  const parts: Part[] = [
    [-L / 2, L * 0.36, hv, H / 2, -W / 2, W / 2],       // flight deck over the bay
    [-L / 2, L * 0.36, -H / 2, -hv, -W / 2, W / 2],     // bay floor
    [-L / 2, L * 0.36, -hv, hv, -W / 2, -hs],           // bay walls
    [-L / 2, L * 0.36, -hv, hv, hs, W / 2],
    // forked bow either side of the bay mouth
    [L * 0.36, L / 2, -H * 0.42, H * 0.36, -W * 0.48, -hs - 2],
    [L * 0.36, L / 2, -H * 0.42, H * 0.36, hs + 2, W * 0.48],
    // island tower off to one side
    [-L * 0.22, -L * 0.06, H / 2, H / 2 + H * 0.95, W * 0.22, W * 0.44],
    [-L * 0.2, -L * 0.1, H / 2 + H * 0.95, H / 2 + H * 1.15, W * 0.12, W * 0.48],
    // ventral pods
    [-L * 0.3, L * 0.1, -H / 2 - H * 0.35, -H / 2, -W * 0.35, -W * 0.12],
    [-L * 0.3, L * 0.1, -H / 2 - H * 0.35, -H / 2, W * 0.12, W * 0.35],
  ];
  const engines: Part[] = [];
  for (const [v0, v1] of [[hv + 2, H / 2 - 1], [-H / 2 + 1, -hv - 2]]) for (const w of [-W * 0.3, 0, W * 0.3])
    engines.push([-L / 2 - L * 0.04, -L / 2, v0, v1, w - W * 0.12, w + W * 0.12]);
  void h;
  return { len: L, parts, trim: [], lights: [], engines, guns: [], openings: [{ u: 0, v: 0, w: 0, along: 'u', hv, hs, kind: 'hangar' }] };
}
/** A frigate: small, plain, quick to build a fleet out of. */
function frigate(L: number): Hull {
  const H = L * 0.16, W = L * 0.2;
  const parts: Part[] = [
    [-L / 2, L * 0.3, -H / 2, H / 2, -W / 2, W / 2],
    [L * 0.3, L / 2, -H * 0.3, H * 0.25, -W * 0.28, W * 0.28],
    [-L * 0.35, -L * 0.15, H / 2, H / 2 + H * 0.8, -W * 0.15, W * 0.15],
    [-L * 0.2, L * 0.2, -H * 0.2, H * 0.1, -W * 0.85, -W / 2],
    [-L * 0.2, L * 0.2, -H * 0.2, H * 0.1, W / 2, W * 0.85],
  ];
  const engines: Part[] = [[-L / 2 - L * 0.06, -L / 2, -H * 0.3, H * 0.3, -W * 0.35, W * 0.35]];
  return { len: L, parts, trim: [], lights: [], engines, guns: [], openings: [] };
}

/** Lay the battle out for this run's world seed (online: everyone's seed is the same, so is the battle). */
export function buildField() {
  ships = [];
  let n = 0;
  const h = (k: number) => hash2(n, k, 300 + ships.length);
  for (const side of [0, 1] as const) {
    const kinds = ['carrier', 'cruiser', 'cruiser', 'cruiser', 'frigate', 'frigate'] as const;
    for (const kind of kinds) {
      n++;
      const L = kind === 'carrier' ? 400 + h(2) * 120 : kind === 'cruiser' ? 280 + h(2) * 160 : 140 + h(2) * 70;
      const hull = kind === 'carrier' ? carrier(L, h) : kind === 'cruiser' ? cruiser(L, h) : frigate(L);
      // broadside to the other fleet: side 0 to the north heading east, side 1 to the south heading west
      for (let tryN = 0; tryN < 60; tryN++) {
        const k = (j: number) => hash2(n * 13 + tryN, j, 400 + side);
        const yaw = (side ? Math.PI : 0) + (k(1) - 0.5) * 0.5;
        const x = (k(2) - 0.5) * 2 * (SPACE_R - L * 0.45 - 40);
        const z = (side ? 1 : -1) * (150 + k(3) * 300);
        const cy = lerp(FIELD_LO + 60, FIELD_HI - 40, k(4));
        if (Math.hypot(x, z) > SPACE_R - 60) continue;
        const fx = Math.cos(yaw), fz = Math.sin(yaw);
        const rr = L * 0.27 + 25;
        // keep clear of the ships already placed (compare points along each keel)
        // and leave a lane down the middle between the fleets
        let clash = false;
        for (let i = -2; i <= 2; i++) if ((side ? 1 : -1) * (z + fz * L * 0.25 * i) < L * 0.16 + 45) clash = true;
        for (const o of ships) {
          const ro = o.len * 0.27 + 25;
          for (let i = -2; i <= 2 && !clash; i++) for (let j = -2; j <= 2 && !clash; j++) {
            const ax = x + fx * L * 0.25 * i, az = z + fz * L * 0.25 * i;
            const bx = o.x + o.fx * o.len * 0.25 * j, bz = o.z + o.fz * o.len * 0.25 * j;
            if (Math.hypot(ax - bx, cy - o.cy, az - bz) < rr + ro + 30) clash = true;
          }
          if (clash) break;
        }
        if (clash) continue;
        const ship: Ship = { ...hull, kind, x, cy, z, fx, fz, yaw, side, radius: L * 0.62 + 40, boxes: [] };
        for (const [i, p] of [...hull.parts, ...hull.engines].entries()) {
          const uc = (p[0] + p[1]) / 2, vc = (p[2] + p[3]) / 2, wc = (p[4] + p[5]) / 2;
          const hx = (p[1] - p[0]) / 2, hy = (p[3] - p[2]) / 2, hz = (p[5] - p[4]) / 2;
          const bx = x + fx * uc - fz * wc, bz = z + fz * uc + fx * wc, by = cy + vc;
          ship.boxes.push({ id: `S${ships.length}.${i}`, type: 'box', x: bx, z: bz, cy: by, ax: fx, az: fz, hx, hy, hz,
            y0: by - hy, top: by + hy, r: Math.max(hx, hz), scale: Math.hypot(hx, hz) + 2, tint: hash2(i, n, 500) });
        }
        // guns along the top, for the broadside barrage (looks only)
        for (let g = 0; g < 6; g++) ship.guns.push([(hash2(g, n, 510) - 0.5) * L * 0.7, (kind === 'frigate' ? L * 0.08 : L * 0.07) + 2, (hash2(g, n, 511) - 0.5) * L * 0.18]);
        ships.push(ship);
        break;
      }
    }
  }
}
export function fieldStats() { return { ships: ships.length, boxes: ships.reduce((a, s) => a + s.boxes.length, 0) }; }

// ---------- Look: planet, sky, ships ----------

/** A lumpy low-poly rock (the moons). */
function rockGeometry(detail: number, seed: number, stretch = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = makeNoise2D(seed);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 - 0.16 * (n(v.x * 1.7 + v.y, v.z * 1.7 - v.y) * 0.5 + 0.5) + 0.04 * n(v.y * 4, v.x * 4);
    v.multiplyScalar(k); v.z *= stretch;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // (the icosahedron is unindexed, but each corner moves by its own position, so copies stay together)
  g.computeVertexNormals();
  return g;
}

const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();

export class SpaceScene {
  group = new THREE.Group();
  /** Follows the camera: stars, nebula, moons, the sun. */
  backdrop = new THREE.Group();
  private field = new THREE.Group();
  private fx = new BattleFx();
  readonly sunDir = SUN_DIR.clone();

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.backdrop.visible = false;
    scene.add(this.group, this.backdrop);
    this.group.add(this.buildPlanet(), this.field, this.fx.group);
    this.buildBackdrop();
  }

  set visible(on: boolean) { this.group.visible = on; this.backdrop.visible = on; }
  get visible() { return this.group.visible; }

  private buildPlanet() {
    // the planet's surface as seen from orbit: a grid draped over the sphere out past the horizon
    // (a grid, not a sphere, so there's no pinched pole right underneath you)
    const N = 150, EXT = 6000, step = (2 * EXT) / N;
    const hAt = (x: number, z: number) => planetHeight(x, z);
    const nA = makeNoise2D(77), nB = makeNoise2D(78), nC = makeNoise2D(79), nD = makeNoise2D(80);
    const ocean = new THREE.Color(0x3b1670), deep = new THREE.Color(0x1d0b45), teal = new THREE.Color(0x19b3a0), jungle = new THREE.Color(0x2f8f4f);
    const dune = new THREE.Color(0xe8742c), rust = new THREE.Color(0xb03a2e), ice = new THREE.Color(0xe9f2ff), lava = new THREE.Color(0xffc23d), pink = new THREE.Color(0xe0569a);
    const c = new THREE.Color();
    const colorAt = (x: number, z: number) => {
      const warp = nC(x / 3000, z / 3000) * 0.6;
      const land = nA(x / 2600 + warp, z / 2600) * 0.65 + nB(x / 900, z / 900 + warp) * 0.28 + nC(x / 260, z / 260) * 0.07;
      const band = Math.sin((x * 0.6 + z) / 220 + warp * 5) * 0.5 + 0.5; // swirling stripes across the continents
      if (land < -0.04) c.copy(deep).lerp(ocean, smoothstep(land, -0.45, -0.04));
      else if (land < 0.03) c.copy(teal);                    // glowing shallows
      else {
        const k = smoothstep(land, 0.03, 0.45);
        c.copy(jungle).lerp(dune, smoothstep(nD(x / 1500, z / 1500), -0.25, 0.25));
        c.lerp(nD(x / 700 + 5, z / 700) > 0.35 ? pink : rust, band * 0.5 * k);
        if (land > 0.4) c.lerp(ice, smoothstep(land, 0.4, 0.55));
        // lava cracks where a noise ridge crosses zero
        if (Math.abs(nB(x / 420 + 9, z / 420)) < 0.035 && land > 0.1 && land < 0.4) c.copy(lava);
      }
      return c;
    };
    const pos = new Float32Array(N * N * 18), col = new Float32Array(N * N * 18);
    let k = 0;
    const tri = (x0: number, z0: number, x1: number, z1: number, x2: number, z2: number) => {
      const cc = colorAt((x0 + x1 + x2) / 3, (z0 + z1 + z2) / 3);
      cc.offsetHSL(0, 0, (hash2(Math.floor(x0), Math.floor(z0), 5) - 0.5) * 0.05);
      for (const [x, z] of [[x0, z0], [x1, z1], [x2, z2]]) {
        pos[k] = x; pos[k + 1] = hAt(x, z); pos[k + 2] = z;
        col[k] = cc.r; col[k + 1] = cc.g; col[k + 2] = cc.b; k += 3;
      }
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x0 = -EXT + i * step, z0 = -EXT + j * step, x1 = x0 + step, z1 = z0 + step;
      if ((i + j) % 2) { tri(x0, z0, x0, z1, x1, z0); tri(x1, z0, x0, z1, x1, z1); }
      else { tri(x0, z0, x0, z1, x1, z1); tri(x0, z0, x1, z1, x1, z0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const planet = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false, emissive: 0x1a0830, emissiveIntensity: 0.5 }));
    const holder = new THREE.Group();
    holder.add(planet);
    // atmosphere: a glowing rim that brightens toward the horizon
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_R * 1.012, 160, 40, 0, Math.PI * 2, 0, 0.7),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        uniforms: { glow: { value: new THREE.Color(0x58d8ff) }, glow2: { value: new THREE.Color(0xff5ad8) } },
        vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: 'uniform vec3 glow; uniform vec3 glow2; varying vec3 vN; varying vec3 vV; void main(){ float f = 1. - abs(dot(vN, vV)); float a = pow(f, 4.); gl_FragColor = vec4(mix(glow, glow2, pow(f, 9.)) * a * 1.3, a); }',
      }),
    );
    atmo.renderOrder = 1;
    atmo.position.set(0, PLANET_TOP - PLANET_R, 0);
    holder.add(atmo);
    return holder;
  }

  private buildBackdrop() {
    const R = 20000;
    // nebula: a dark dome with soft coloured clouds
    const neb = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.2, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
        fragmentShader: `varying vec3 vP;
          float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
          float n(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
            return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                       mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
          void main(){
            vec3 p = vP * 3.;
            float a = n(p) * .5 + n(p * 2.1) * .3 + n(p * 4.3) * .2;
            float b = n(p * 1.3 + 7.) * .6 + n(p * 3.7) * .4;
            vec3 c = vec3(.012, .01, .035);
            c += vec3(.35, .08, .45) * pow(smoothstep(.45, .85, a), 2.) * .55;
            c += vec3(.05, .3, .45) * pow(smoothstep(.5, .9, b), 2.) * .5;
            c *= smoothstep(-.35, .25, vP.y) * .8 + .2; // dimmer down by the planet's limb
            gl_FragColor = vec4(c, 1.);
          }`,
      }),
    );
    neb.renderOrder = -2;
    this.backdrop.add(neb);
    // stars
    const N = 2600;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const v = new THREE.Vector3(), c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (v.lengthSq() > 1 || v.lengthSq() < 0.01) { i--; continue; }
      v.normalize().multiplyScalar(R);
      pos.set([v.x, v.y, v.z], i * 3);
      c.setHSL(Math.random() < 0.3 ? 0.6 : Math.random() < 0.5 ? 0.08 : 0, 0.5, 0.65 + Math.random() * 0.35);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    stars.renderOrder = -1;
    this.backdrop.add(stars);
    // the sun, with a soft glow
    const sun = new THREE.Mesh(new THREE.CircleGeometry(520, 32), new THREE.MeshBasicMaterial({ color: 0xfff6dc, fog: false, depthWrite: false }));
    const glow = new THREE.Mesh(new THREE.CircleGeometry(2600, 32), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = position.xy / 2600.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'varying vec2 vU; void main(){ float d = length(vU); float a = pow(max(0., 1. - d), 3.); gl_FragColor = vec4(vec3(1., .85, .6) * a * .9, a); }',
    }));
    for (const m of [glow, sun]) { m.position.copy(SUN_DIR).multiplyScalar(R * 0.9); m.lookAt(0, 0, 0); m.renderOrder = -1; this.backdrop.add(m); }
    // two moons
    const moon = (dir: THREE.Vector3, r: number, color: number, seed: number) => {
      const m = new THREE.Mesh(rockGeometry(2, seed), new THREE.MeshLambertMaterial({ color, flatShading: true, fog: false }));
      m.scale.setScalar(r); m.position.copy(dir.normalize()).multiplyScalar(R * 0.7);
      this.backdrop.add(m);
    };
    moon(new THREE.Vector3(0.7, 0.35, 0.4), 900, 0xc9b8a6, 501);
    moon(new THREE.Vector3(-0.3, 0.22, 0.9), 380, 0x9fb8d8, 502);
  }

  /** Rebuild the ship meshes from the current battle. */
  rebuild() {
    for (const ch of [...this.field.children]) {
      this.field.remove(ch);
      ch.traverse((m) => { if (m instanceof THREE.Mesh) m.geometry.dispose(); });
    }
    for (const s of ships) this.field.add(shipMesh(s));
    this.fx.reset();
  }

  /** The backdrop follows the camera; the two fleets keep trading broadsides. */
  update(dt: number, camPos: THREE.Vector3) {
    this.backdrop.position.copy(camPos);
    if (!this.group.visible) return;
    this.fx.update(dt);
  }
}

// ---------- Ship meshes ----------
const SIDE_LOOK = [
  { hull: 0xc4c8d0, dark: 0x8a909b, trim: 0x3a6ea8, light: 0xa6dcff, engine: 0x7fd0ff, bolt: 0x5fd0ff },
  { hull: 0x62656e, dark: 0x41434a, trim: 0xb8452e, light: 0xffb36a, engine: 0xff9a4a, bolt: 0xff4a2a },
];
const BOLT_COLOR = SIDE_LOOK.map((l) => new THREE.Color(l.bolt));
const shipMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const glowMats = new Map<number, THREE.MeshBasicMaterial>();
const glowMat = (c: number, additive = false) => {
  const k = c + (additive ? 0x1000000 : 0);
  let m = glowMats.get(k);
  if (!m) {
    m = additive ? new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      : new THREE.MeshBasicMaterial({ color: c });
    glowMats.set(k, m);
  }
  return m;
};

/** Collects boxes (in the ship's frame) into one vertex-coloured geometry. */
class BoxBatch {
  pos: number[] = []; col: number[] = [];
  private c = new THREE.Color();
  add(p: Part, color: number | THREE.Color, shade = 0) {
    const [u0, u1, v0, v1, w0, w1] = p;
    const c = this.c.set(color as THREE.ColorRepresentation);
    if (shade) c.offsetHSL(0, 0, shade);
    const q = [[u0, v0, w0], [u1, v0, w0], [u1, v1, w0], [u0, v1, w0], [u0, v0, w1], [u1, v0, w1], [u1, v1, w1], [u0, v1, w1]];
    // six faces, wound to face outward
    for (const f of [[1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0], [5, 4, 7, 6], [0, 1, 2, 3]]) {
      for (const k of [f[0], f[1], f[2], f[0], f[2], f[3]]) { this.pos.push(...q[k]); this.col.push(c.r, c.g, c.b); }
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** One ship: its collision boxes, plus surface detail (plating, turrets, antenna, lit windows, engine glow)
 *  that sits within a couple of metres of the hull. */
function shipMesh(s: Ship) {
  const look = SIDE_LOOK[s.side];
  const hull = new BoxBatch(), lit = new BoxBatch(), glow = new BoxBatch();
  const r = (k: number) => hash2(k, s.len | 0, 700 + s.side);
  let rk = 0;
  const top = (p: Part) => p[3], len = (p: Part) => p[1] - p[0], wid = (p: Part) => p[5] - p[4];
  s.parts.forEach((p, i) => {
    hull.add(p, i % 3 === 2 ? look.dark : look.hull, (r(i) - 0.5) * 0.06);
    // plating on the top: a scatter of low slabs and turret blocks
    // (not on the floor of a hangar bay or tunnel: you fly over that)
    const floor = s.openings.some((o) => Math.abs(p[3] - (o.v - o.hv)) < 0.01);
    const n = floor ? 0 : Math.floor(len(p) * wid(p) / 900);
    for (let j = 0; j < n; j++) {
      const u = lerp(p[0] + 4, p[1] - 4, r(++rk)), w = lerp(p[4] + 3, p[5] - 3, r(++rk));
      const big = r(++rk);
      const su = 3 + big * 12, sw = 2 + r(++rk) * 7, sh = 0.6 + (big > 0.85 ? 2 : 0.6) * r(++rk);
      const pu0 = clamp(u - su / 2, p[0], p[1]), pu1 = clamp(u + su / 2, p[0], p[1]);
      const pw0 = clamp(w - sw / 2, p[4], p[5]), pw1 = clamp(w + sw / 2, p[4], p[5]);
      hull.add([pu0, pu1, top(p), top(p) + sh, pw0, pw1], big > 0.92 ? look.trim : big > 0.5 ? look.dark : look.hull, (r(++rk) - 0.5) * 0.08);
    }
    // a band of trim colour round the bigger blocks
    if (len(p) > 60 && p[3] - p[2] > 14) {
      const v = lerp(p[2], p[3], 0.35);
      hull.add([p[0] + 2, p[1] - 2, v, v + 2.5, p[4] - 0.3, p[4]], look.trim);
      hull.add([p[0] + 2, p[1] - 2, v, v + 2.5, p[5], p[5] + 0.3], look.trim);
    }
    // rows of lit windows down both sides
    if (len(p) > 40 && p[3] - p[2] > 10) {
      for (let row = 0; row < 3; row++) {
        const v = lerp(p[2], p[3], 0.55 + row * 0.13);
        for (let u = p[0] + 4; u < p[1] - 6; u += 7 + r(++rk) * 10) {
          if (r(++rk) < 0.35) continue;
          const l = 2 + r(++rk) * 6;
          lit.add([u, Math.min(u + l, p[1] - 2), v, v + 0.9, p[4] - 0.15, p[4]], 0);
          lit.add([u, Math.min(u + l, p[1] - 2), v, v + 0.9, p[5], p[5] + 0.15], 0);
        }
      }
    }
  });
  // antenna masts on the towers
  const tallest = s.parts.reduce((a, p) => (p[3] > a[3] ? p : a), s.parts[0]);
  for (let k = 0; k < 3; k++) {
    const u = lerp(tallest[0] + 2, tallest[1] - 2, r(++rk)), w = lerp(tallest[4] + 2, tallest[5] - 2, r(++rk));
    hull.add([u - 0.4, u + 0.4, tallest[3], tallest[3] + 8 + r(++rk) * 14, w - 0.4, w + 0.4], look.dark);
  }
  // engine housings and their glowing nozzles
  for (const e of s.engines) {
    hull.add(e, look.dark);
    glow.add([e[0] - 0.4, e[0], e[2] + 2, e[3] - 2, e[4] + 2, e[5] - 2], 0);
  }
  // the carrier's bay is lit inside; the cruiser's tunnel too
  for (const o of s.openings) {
    if (o.along === 'u') {
      for (let u = -s.len * 0.45; u < s.len * 0.34; u += 22) for (const w of [-o.hs, o.hs])
        lit.add([u, u + 10, -o.hv + 1, -o.hv + 2.2, w - 0.3, w + 0.3], 0);
    } else {
      for (const u of [o.u - o.hs, o.u + o.hs]) for (const v of [-o.hv + 1.5, o.hv - 2.5])
        for (let w = -s.len * 0.1; w < s.len * 0.1 - 4; w += 9) lit.add([u - 0.3, u + 0.3, v, v + 1, w, w + 5], 0);
    }
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(hull.geometry(), shipMat));
  g.add(new THREE.Mesh(lit.geometry(), glowMat(look.light)));
  const gm = new THREE.Mesh(glow.geometry(), glowMat(look.engine, true));
  gm.renderOrder = 2;
  g.add(gm);
  // a soft halo behind each engine
  for (const e of s.engines) {
    const h = Math.min(e[3] - e[2], e[5] - e[4]);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(e[5] - e[4] + h * 0.6, e[3] - e[2] + h * 0.6), haloMat(look.engine));
    halo.position.set(e[0] - 1, (e[2] + e[3]) / 2, (e[4] + e[5]) / 2);
    halo.rotation.y = -Math.PI / 2;
    halo.renderOrder = 2;
    g.add(halo);
  }
  g.position.set(s.x, s.cy, s.z);
  g.rotation.y = -s.yaw; // ship +u (local x) -> its heading, +w (local z) -> its starboard
  return g;
}
const halos = new Map<number, THREE.ShaderMaterial>();
function haloMat(c: number) {
  let m = halos.get(c);
  if (!m) {
    m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { c: { value: new THREE.Color(c) } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv * 2. - 1.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'uniform vec3 c; varying vec2 vU; void main(){ float d = max(abs(vU.x), abs(vU.y)); float a = pow(max(0., 1. - d), 1.6) * .8; gl_FragColor = vec4(c * a, a); }',
    });
    halos.set(c, m);
  }
  return m;
}

// ---------- Battle FX: the fleets' broadsides (looks only: they never hit the fighters) ----------
const BOLT_SPEED = 320, BOLT_MAX = 220, FLASH_MAX = 90;
interface Bolt { p: THREE.Vector3; v: THREE.Vector3; life: number; side: 0 | 1; len: number }
interface Flash { p: THREE.Vector3; t: number; dur: number; size: number; side: 0 | 1 }
const shipPoint = (s: Ship, u: number, v: number, w: number, out: THREE.Vector3) =>
  out.set(s.x + s.fx * u - s.fz * w, s.cy + v, s.z + s.fz * u + s.fx * w);

class BattleFx {
  group = new THREE.Group();
  private bolts: Bolt[] = [];
  private flashes: Flash[] = [];
  private boltMesh: THREE.InstancedMesh;
  private sprites: THREE.Sprite[] = [];
  private timers: number[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private sc = new THREE.Vector3();
  private c = new THREE.Color(); private v = new THREE.Vector3(); private z = new THREE.Vector3(0, 0, 1);
  constructor() {
    const boltGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5); // stretches back from its head
    this.boltMesh = new THREE.InstancedMesh(boltGeo, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), BOLT_MAX);
    const im = this.boltMesh;
    im.count = 0; im.frustumCulled = false; im.renderOrder = 3;
    im.setColorAt(0, this.c.set(0)); // makes the colour buffer
    this.group.add(im);
    // flashes: soft glowing blobs that swell and fade
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const cx = cv.getContext('2d');
    if (cx) {
      const gr = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
    }
    const tex = new THREE.CanvasTexture(cv);
    for (let i = 0; i < FLASH_MAX; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      sp.visible = false; sp.renderOrder = 3;
      this.sprites.push(sp); this.group.add(sp);
    }
  }
  reset() { this.bolts = []; this.flashes = []; for (const sp of this.sprites) sp.visible = false; this.timers = ships.map((_, i) => (i % 5) * 0.2); }

  private fire(s: Ship) {
    const foes = ships.filter((o) => o.side !== s.side);
    if (!foes.length || this.bolts.length >= BOLT_MAX) return;
    const gun = s.guns[Math.floor(Math.random() * s.guns.length)];
    const p = shipPoint(s, gun[0], gun[1], gun[2], new THREE.Vector3());
    // aim at a random spot on the nearest few enemy ships; some miss and fly on past
    foes.sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z));
    const t = foes[Math.floor(Math.random() * Math.min(3, foes.length))];
    const miss = Math.random() < 0.3;
    const aim = shipPoint(t, (Math.random() - 0.5) * t.len * 0.7, (Math.random() - 0.3) * t.len * 0.08 + (miss ? (Math.random() - 0.5) * 120 : 0),
      (Math.random() - 0.5) * t.len * 0.15, this.v);
    const d = aim.distanceTo(p);
    const big = Math.random() < 0.2;
    this.bolts.push({ p, v: aim.sub(p).normalize().multiplyScalar(BOLT_SPEED * (big ? 0.7 : 1)).clone(), life: miss ? 2.5 : d / (BOLT_SPEED * (big ? 0.7 : 1)), side: s.side, len: big ? 40 : 22 });
  }

  update(dt: number) {
    ships.forEach((s, i) => {
      this.timers[i] = (this.timers[i] ?? 0) - dt;
      if (this.timers[i] <= 0) {
        // a quick volley of two or three, then a pause
        const n = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k++) this.fire(s);
        this.timers[i] = (s.kind === 'frigate' ? 0.7 : 0.45) + Math.random() * 0.9;
      }
    });
    // flak bursts in the open water between the fleets now and then
    if (Math.random() < dt * 1.2 && this.flashes.length < FLASH_MAX) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * SPACE_R * 0.9;
      this.flashes.push({ p: new THREE.Vector3(Math.cos(a) * rr, lerp(FIELD_LO + 60, FIELD_HI, Math.random()), Math.sin(a) * rr), t: 0, dur: 0.7, size: 7, side: Math.random() < 0.5 ? 0 : 1 });
    }
    let n = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.p.addScaledVector(b.v, dt); b.life -= dt;
      if (b.life <= 0) {
        if (this.flashes.length < FLASH_MAX) this.flashes.push({ p: b.p, t: 0, dur: 0.45, size: b.len * 0.45, side: b.side });
        this.bolts.splice(i, 1);
      }
    }
    for (const b of this.bolts) {
      this.q.setFromUnitVectors(this.z, this.v.copy(b.v).normalize());
      this.m.compose(b.p, this.q, this.sc.set(b.len * 0.07, b.len * 0.07, b.len));
      this.boltMesh.setMatrixAt(n, this.m);
      this.boltMesh.setColorAt(n, BOLT_COLOR[b.side]);
      n++;
    }
    this.boltMesh.count = n;
    this.boltMesh.instanceMatrix.needsUpdate = true;
    if (this.boltMesh.instanceColor) this.boltMesh.instanceColor.needsUpdate = true;
    n = 0;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t >= f.dur) { this.flashes.splice(i, 1); continue; }
      const k = f.t / f.dur, sp = this.sprites[n++];
      sp.visible = true; sp.position.copy(f.p); sp.scale.setScalar(f.size * (1 + k * 2));
      sp.material.color.set(0xffe2a8).lerp(BOLT_COLOR[f.side], k * 0.7);
      sp.material.opacity = (1 - k) ** 1.5;
    }
    for (let i = n; i < FLASH_MAX; i++) this.sprites[i].visible = false;
  }
}
