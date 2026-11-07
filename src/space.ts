import * as THREE from 'three';
import { hash2, makeNoise2D } from './noise';
import type { Obstacle } from './world';
import { carrier, cruiser, frigate, buildShipMesh, animatePlumes, FLEET_LOOK, type Hull, type Opening } from './capital';
import { sfx } from './spacefx';

// ---------- Space mode: a capital-ship battle high above a planet ----------
// No air up here, so no gliding and no stall. Every fighter cruises at the same speed and turns wide.
// Boost (on a fuel tank you can only refill from the boost pickups dotted round the battle) changes pace.
// Brake is a drift: the engines cut, your momentum carries on along the old line, and the nose swings round
// much faster, so you can slide sideways and aim off-axis. Let go and the engines haul you onto the new line.
// Your fighter and the enemy fighters all use exactly these numbers.

export const SPACE_CRUISE = 55;      // m/s: hands-off speed
export const SPACE_BOOST = 95;       // full boost
export const SPACE_BRAKE = 22;       // the slowest a long drift bleeds down to
/** Engine thrust, m/s^2: how hard the engines can bend or change your velocity. With the nose turning at
 *  SPACE_PITCH_RATE this gives a turn radius of about 65 m at cruise (a boosted turn is far wider). */
export const SPACE_THRUST = 45;
const DRIFT_THRUST = 5;              // drifting: the engines are cut, only the trim jets nudge your path
const DRIFT_BLEED = 4;               // m/s^2 of speed lost per second while drifting
export const SPACE_PITCH_RATE = 0.85; // rad/s the nose turns at cruise
export const SPACE_ROLL_RATE = 2.6;
export const SPACE_YAW_RATE = 0.5;
const DRIFT_TURN_BONUS = 1.2;        // drifting, the nose swings up to 2.2x as fast...
const BOOST_TURN_CUT = 0.3;          // ...boosting, 30% slower
export const BOOST_TIME = 4;         // seconds of boost on a full tank
/** One boost pickup refills this much of the tank. */
export const PICKUP_FUEL = 0.4;
/** Lasers: much faster than peas (they're light, after all), so the range is longer too. */
export const LASER_SPEED = 260;
export const LASER_LIFE = 0.8;
/** Missiles (the space darts) have to outrun a boosting fighter. */
export const MISSILE_SPEED = 140;

const { clamp, smoothstep, lerp } = THREE.MathUtils;

/** Speed the engines are pushing for. `boost` 0..1. */
export function spaceTargetSpeed(boost: number) {
  return SPACE_CRUISE + (SPACE_BOOST - SPACE_CRUISE) * boost;
}
/** How much faster (or slower) than normal the nose can turn: drifting frees it, boosting stiffens it. */
export function spaceTurnMul(boost: number, drift: number) {
  return 1 + DRIFT_TURN_BONUS * drift - BOOST_TURN_CUT * (drift > 0.05 ? 0 : boost);
}
const _push = new THREE.Vector3();
/** One step of a fighter's motion: the engines push its velocity toward (nose x target speed), at most
 *  SPACE_THRUST hard; drifting (0..1) cuts them, so the velocity coasts on wherever the nose points.
 *  Updates `vel` in place and returns the new speed. */
export function stepSpaceVel(vel: THREE.Vector3, nose: THREE.Vector3, boost: number, drift: number, dt: number) {
  const sp = vel.length();
  const target = lerp(spaceTargetSpeed(boost), sp, drift);
  _push.copy(nose).multiplyScalar(target).sub(vel);
  const max = lerp(SPACE_THRUST, DRIFT_THRUST, drift) * dt, l = _push.length();
  if (l > max) _push.multiplyScalar(max / l);
  vel.add(_push);
  // (a drift still bleeds speed, even with the nose swung round off the line)
  if (drift > 0.05) { const v = vel.length(); if (v > SPACE_BRAKE) vel.multiplyScalar(Math.max(SPACE_BRAKE, v - DRIFT_BLEED * drift * dt) / v); }
  return vel.length();
}
/** Boost fuel 0..1 after a step. It doesn't refill by itself (only pickups do). Returns the boost you
 *  actually get (0 once the tank runs dry). */
export function stepFuel(f: { boostFuel: number }, want: number, dt: number) {
  const b = f.boostFuel > 0.01 ? want : 0;
  if (b > 0.05) f.boostFuel = clamp(f.boostFuel - b * dt / BOOST_TIME, 0, 1);
  return b;
}

// ---------- Field layout ----------
/** Flyable radius (m from the middle) and the barrier a little beyond it. */
export const SPACE_R = 700;
export const SPACE_LID_R = SPACE_R + 140;
/** The capital ships sit between these heights; beyond SPACE_FLOOR / SPACE_CEIL there's an invisible barrier. */
const FIELD_LO = -70, FIELD_HI = 520;
export const SPACE_CEIL = 660;
export const SPACE_FLOOR = -230;
export const SPACE_SPAWN_Y = 230;
/** There's no ground in space: the planet is scenery, far below the battle. */
export const SPACE_VOID = -1e5;
/** Keep `pos` inside the field's walls (radius, ceiling and floor). Returns how far it had to push (m). */
export function spaceBarrier(pos: { x: number; y: number; z: number }) {
  let pushed = 0;
  const r = Math.hypot(pos.x, pos.z);
  if (r > SPACE_LID_R) { const k = SPACE_LID_R / r; pos.x *= k; pos.z *= k; pushed += r - SPACE_LID_R; }
  if (pos.y > SPACE_CEIL) { pushed += pos.y - SPACE_CEIL; pos.y = SPACE_CEIL; }
  if (pos.y < SPACE_FLOOR) { pushed += SPACE_FLOOR - pos.y; pos.y = SPACE_FLOOR; }
  return pushed;
}
/** 0..1: how close you are to the edge of the field (for the TURN BACK warning). */
export function spaceEdge(p: { x: number; y: number; z: number }) {
  return Math.max(clamp((Math.hypot(p.x, p.z) - (SPACE_LID_R - 100)) / 100, 0, 1), clamp((p.y - (SPACE_CEIL - 80)) / 80, 0, 1),
    clamp((SPACE_FLOOR + 80 - p.y) / 80, 0, 1));
}

// ---------- The battle: two fleets of capital ships, broadside to each other across an open lane ----------
export interface Ship {
  kind: 'carrier' | 'cruiser' | 'frigate';
  x: number; cy: number; z: number; fx: number; fz: number; yaw: number; len: number; side: 0 | 1;
  radius: number; boxes: Obstacle[]; openings: Opening[]; hull: Hull;
}
let ships: Ship[] = [];
export const fleet = () => ships;

/** Signed gap between a point and one block of a ship's hull (negative = inside). The block can taper
 *  toward either end and has its long edges rounded off (the chamfers you see). */
export function spaceGap(o: Obstacle, px: number, py: number, pz: number): number {
  const dx = px - o.x, dz = pz - o.z;
  const u = dx * o.ax! + dz * o.az!, w = -dx * o.az! + dz * o.ax!;
  let dy = py - o.cy!, hy = o.hy!, hz = o.hz!;
  if (o.ta) {
    const t = clamp((u / o.hx! + 1) / 2, 0, 1), a = o.ta, b = o.tb!;
    hy *= lerp(a[0], b[0], t); hz *= lerp(a[1], b[1], t); dy -= lerp(a[2], b[2], t);
  }
  const qx = Math.abs(u) - o.hx!;
  let r = 0;
  if (o.rr) r = Math.min(dy > 0 ? (w < 0 ? o.rr[0] : o.rr[1]) : (w > 0 ? o.rr[2] : o.rr[3]), hy, hz);
  const qy = Math.abs(dy) - hy + r, qz = Math.abs(w) - hz + r;
  const sd = Math.hypot(Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qy, qz), 0) - r;
  return Math.hypot(Math.max(qx, 0), Math.max(sd, 0)) + Math.min(Math.max(qx, sd), 0);
}

/** Every ship block that could be near the column around (x, z). */
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

/** A ship's blocks as hit shapes, placed in the world. */
function hitShapes(s: Ship, id: number) {
  const { x, z, cy, fx, fz } = s;
  s.hull.parts.forEach((p, i) => {
    if (p.solid === false) return;
    const uc = (p.u0 + p.u1) / 2, vc = (p.v0 + p.v1) / 2, wc = (p.w0 + p.w1) / 2;
    const hx = (p.u1 - p.u0) / 2, hy = (p.v1 - p.v0) / 2, hz = (p.w1 - p.w0) / 2;
    const bx = x + fx * uc - fz * wc, bz = z + fz * uc + fx * wc, by = cy + vc;
    const ta = p.ta ?? [1, 1, 0], tb = p.tb ?? [1, 1, 0];
    const tapered = !!(p.ta || p.tb);
    const rr = p.c ? p.c.map((c) => Math.min(c * 1.8, hy * 0.95, hz * 0.95)) : undefined;
    const lo = Math.min(-hy * ta[0] + ta[2], -hy * tb[0] + tb[2]), hi = Math.max(hy * ta[0] + ta[2], hy * tb[0] + tb[2]);
    s.boxes.push({ id: `S${id}.${i}`, type: 'box', x: bx, z: bz, cy: by, ax: fx, az: fz, hx, hy, hz,
      ta: tapered ? ta : undefined, tb: tapered ? tb : undefined, rr,
      y0: by + lo, top: by + hi, r: Math.max(hx, hz), scale: Math.hypot(hx, hz) + 2, tint: hash2(i, id, 500) });
  });
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
      const L = kind === 'carrier' ? 420 + h(2) * 110 : kind === 'cruiser' ? 300 + h(2) * 140 : 150 + h(2) * 60;
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
        const ship: Ship = { kind, x, cy, z, fx, fz, yaw, side, len: L, radius: L * 0.62 + 40, boxes: [], openings: hull.openings, hull };
        hitShapes(ship, ships.length);
        ships.push(ship);
        break;
      }
    }
  }
  placePickups();
}

/** The world position of a point in a ship's frame. */
const shipPoint = (s: { x: number; cy: number; z: number; fx: number; fz: number }, u: number, v: number, w: number, out: THREE.Vector3) =>
  out.set(s.x + s.fx * u - s.fz * w, s.cy + v, s.z + s.fz * u + s.fx * w);
// ---------- Boost pickups: the only way to refill your boost (and the enemies' too) ----------
export interface Pickup { x: number; y: number; z: number; /** seconds until it's back (0 = there now) */ wait: number }
export const PICKUP_RESPAWN = 12;
const PICKUP_R = 8; // fly within this of one to grab it
let pickups: Pickup[] = [];
export const boostPickups = () => pickups;
/** Scatter the pickups through open space (none tucked against a hull), more of them out in the lane. */
function placePickups() {
  pickups = [];
  const near: Obstacle[] = [];
  for (let i = 0; i < 400 && pickups.length < 18; i++) {
    const a = hash2(i, 3, 620) * Math.PI * 2, r = Math.sqrt(hash2(i, 4, 620)) * (SPACE_R - 90);
    const x = Math.cos(a) * r, z = pickups.length % 3 ? Math.sin(a) * r : (hash2(i, 5, 620) - 0.5) * 140; // every third in the lane
    const y = lerp(FIELD_LO + 50, FIELD_HI - 20, hash2(i, 6, 620));
    if (pickups.some((p) => Math.hypot(p.x - x, p.y - y, p.z - z) < 120)) continue;
    near.length = 0;
    if (shipPartsNear(x, z, 30, near).some((o) => spaceGap(o, x, y, z) < 30)) continue;
    pickups.push({ x, y, z, wait: 0 });
  }
}
/** The closest pickup that's there now, within `maxD`. */
export function nearestPickup(p: THREE.Vector3, maxD: number): Pickup | null {
  let best: Pickup | null = null, bd = maxD;
  for (const k of pickups) {
    if (k.wait > 0) continue;
    const d = Math.hypot(k.x - p.x, k.y - p.y, k.z - p.z);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
/** Grab a pickup if `p` is on one. Returns true if it was taken (it's then gone for PICKUP_RESPAWN s). */
export function grabPickup(p: THREE.Vector3): boolean {
  for (const k of pickups) {
    if (k.wait <= 0 && Math.abs(k.x - p.x) < PICKUP_R && Math.abs(k.z - p.z) < PICKUP_R && Math.hypot(k.x - p.x, k.y - p.y, k.z - p.z) < PICKUP_R) {
      k.wait = PICKUP_RESPAWN;
      return true;
    }
  }
  return false;
}
export function stepPickups(dt: number) { for (const k of pickups) k.wait = Math.max(0, k.wait - dt); }

export function fieldStats() { return { ships: ships.length, boxes: ships.reduce((a, s) => a + s.boxes.length, 0) }; }

// ---------- Look: the backdrop (planet, nebula, stars, sun), the ships, the battle ----------

export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
/** Where the planet hangs in the sky (it's scenery, thousands of km off: it follows the camera). */
const PLANET_DIR = new THREE.Vector3(-0.62, -0.62, 0.3).normalize();
const SKY_R = 20000;

/** GLSL: 3D value noise and a few octaves of it. */
const NOISE_GLSL = `
  float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
  float n3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
    return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }
  float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a * n3(p); p = p * 2.03 + 1.7; a *= .5; } return s; }`;

export class SpaceScene {
  group = new THREE.Group();
  /** Follows the camera: nebula, stars, the sun, the planet and its moon. */
  backdrop = new THREE.Group();
  private field = new THREE.Group();
  private distant = new THREE.Group();
  private battle = new Battle();
  private pickupMeshes: THREE.Group[] = [];
  private beaconPts: THREE.Points[] = [];
  private t = 0;
  readonly sunDir = SUN_DIR.clone();

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.backdrop.visible = false;
    scene.add(this.group, this.backdrop);
    this.group.add(this.field, this.distant, this.battle.group, sfx.group);
    this.buildBackdrop();
  }

  set visible(on: boolean) { this.group.visible = on; this.backdrop.visible = on; }
  get visible() { return this.group.visible; }

  private buildBackdrop() {
    const R = SKY_R;
    const back = (o: THREE.Object3D, order: number) => { o.renderOrder = order; o.frustumCulled = false; this.backdrop.add(o); };
    // nebula: deep blue-black with soft teal and violet clouds, a faint galactic band across it
    back(new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.2, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
        fragmentShader: `varying vec3 vP; ${NOISE_GLSL}
          void main(){
            vec3 p = vP * 2.6;
            float a = fbm(p + 3.1), b = fbm(p * 1.7 + 9.);
            float band = exp(-pow(dot(vP, normalize(vec3(.35, 1., .25))) * 3.2, 2.));
            vec3 c = vec3(.006, .008, .02);
            c += vec3(.05, .16, .22) * pow(smoothstep(.42, .82, a), 2.2) * (.4 + band);
            c += vec3(.22, .07, .26) * pow(smoothstep(.5, .9, b), 2.5) * .8;
            c += vec3(.09, .08, .1) * band * smoothstep(.3, .8, fbm(p * 4. + 2.)) * .8;
            // a warm haze round the sun
            float s = max(0., dot(vP, ${vec(SUN_DIR)}));
            c += vec3(.5, .35, .2) * pow(s, 24.) * .35 + vec3(.25, .16, .1) * pow(s, 4.) * .08;
            gl_FragColor = vec4(c, 1.);
          }`,
      }),
    ), -10);
    // stars: lots of faint ones and a few bright, coloured ones
    for (const [N, size, bright] of [[3200, 1.4, 0.75], [260, 2.6, 2.2]] as const) {
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const v = new THREE.Vector3(), c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        v.randomDirection().multiplyScalar(R);
        pos.set([v.x, v.y, v.z], i * 3);
        c.setHSL(Math.random() < 0.3 ? 0.6 : Math.random() < 0.5 ? 0.1 : 0, 0.55, 0.7 + Math.random() * 0.3).multiplyScalar(bright * (0.4 + Math.random() * 0.6));
        col.set([c.r, c.g, c.b], i * 3);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      back(new THREE.Points(sg, new THREE.PointsMaterial({ size: size * 1.6, map: dotTexture(), transparent: true, blending: THREE.AdditiveBlending, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, depthTest: false, toneMapped: false })), -9);
    }
    // the sun: a white-hot disc (bright enough to bloom) inside a wide warm glow
    const sunPos = SUN_DIR.clone().multiplyScalar(R * 0.9);
    const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(300, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff6e8).multiplyScalar(6), fog: false, depthWrite: false, depthTest: false, toneMapped: false }));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv * 2. - 1.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `varying vec2 vU; void main(){ float d = length(vU);
        float a = pow(max(0., 1. - d), 6.) * 2. + pow(max(0., 1. - d), 2.) * .12;
        float rays = pow(max(0., 1. - abs(vU.y) * 40.), 2.) * pow(max(0., 1. - abs(vU.x)), 3.) * .5;
        gl_FragColor = vec4(vec3(1., .82, .6) * (a + rays), 1.); }`,
    }));
    for (const m of [glow, sunDisc]) { m.position.copy(sunPos); m.lookAt(0, 0, 0); }
    back(glow, -8); back(sunDisc, -7);
    // a small grey moon, far off, behind the planet's limb
    const moonDir = PLANET_DIR.clone().lerp(new THREE.Vector3(0.2, 0.15, 0.95), 0.62).normalize();
    const moon = new THREE.Mesh(rockGeometry(3, 502), new THREE.MeshStandardMaterial({ color: 0xa9a49c, flatShading: true, roughness: 1, metalness: 0, fog: false, depthWrite: false, depthTest: false }));
    moon.scale.setScalar(520); moon.position.copy(moonDir).multiplyScalar(R * 0.85);
    back(moon, -6);
    // the planet
    const PD = R * 0.8, PR = PD * Math.sin(THREE.MathUtils.degToRad(30));
    const planet = new THREE.Mesh(new THREE.SphereGeometry(PR, 128, 64), new THREE.ShaderMaterial({
      depthWrite: false, depthTest: false, fog: false,
      uniforms: { sun: { value: SUN_DIR }, t: { value: 0 } },
      vertexShader: 'varying vec3 vO; varying vec3 vN; varying vec3 vV; void main(){ vO = normalize(position); vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform vec3 sun; uniform float t; varying vec3 vO; varying vec3 vN; varying vec3 vV; ${NOISE_GLSL}
        void main(){
          vec3 p = vO;
          float warp = fbm(p * 2.2 + 4.);
          float land = fbm(p * 2.6 + warp * .8);
          float lat = abs(p.y);
          vec3 deep = vec3(.015, .06, .16), shallow = vec3(.04, .25, .38);
          vec3 green = vec3(.12, .26, .1), dry = vec3(.46, .34, .2), rock = vec3(.32, .28, .26), ice = vec3(.86, .9, .95);
          float isLand = smoothstep(.505, .52, land);
          vec3 c = mix(deep, shallow, smoothstep(.36, .505, land));
          vec3 lc = mix(green, dry, smoothstep(.35, .65, fbm(p * 5. + 11.)));
          lc = mix(lc, rock, smoothstep(.58, .7, land));
          c = mix(c, lc, isLand);
          c = mix(c, ice, smoothstep(.72, .82, lat + fbm(p * 6.) * .15));
          // cloud bands, swirling
          float cl = fbm(vec3(p.x * 3., p.y * 7., p.z * 3.) + vec3(warp * 1.6, 0., t * .002));
          float clouds = smoothstep(.56, .78, cl) * .8;
          vec3 n = normalize(vN);
          float ndl = dot(n, sun);
          float day = smoothstep(-.08, .3, ndl);
          vec3 col = mix(c, vec3(.8, .83, .88), clouds) * (day * .95 + .015);
          // ocean glint
          vec3 hv = normalize(sun + vV);
          col += vec3(1., .85, .6) * pow(max(dot(n, hv), 0.), 60.) * (1. - isLand) * (1. - clouds) * day * .9;
          // city lights on the night side
          float city = smoothstep(.72, .86, n3(p * 90.)) * smoothstep(.6, .75, fbm(p * 14.)) * isLand * (1. - clouds);
          col += vec3(1., .62, .25) * city * (1. - smoothstep(-.25, .05, ndl)) * 1.4;
          // atmosphere: blue haze toward the limb, a warm band along the terminator
          float f = 1. - max(dot(n, vV), 0.);
          col = mix(col, vec3(.3, .55, 1.) * (day + .05), pow(f, 2.6) * .85);
          col += vec3(1., .45, .2) * exp(-pow(ndl * 7., 2.)) * pow(f, 1.5) * .35;
          gl_FragColor = vec4(col, 1.);
        }`,
    }));
    planet.position.copy(PLANET_DIR).multiplyScalar(PD);
    planet.rotation.set(0.3, 0.8, 0.2);
    back(planet, -5);
    // the atmosphere's glow just outside the limb
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(PR * 1.045, 96, 48), new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { sun: { value: SUN_DIR } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform vec3 sun; varying vec3 vN; varying vec3 vV; void main(){
        float d = -dot(vN, vV);
        float a = smoothstep(0., .3, d) * (1. - smoothstep(.3, .55, d));
        float lit = smoothstep(-.4, .5, dot(-vN, sun)) + .08;
        gl_FragColor = vec4(vec3(.35, .62, 1.) * a * lit * 1.3, 1.); }`,
    }));
    atmo.position.copy(planet.position);
    back(atmo, -4);
    this.planetMat = planet.material as THREE.ShaderMaterial;
  }
  private planetMat: THREE.ShaderMaterial | null = null;

  /** Rebuild the ship meshes from the current battle. */
  rebuild() {
    for (const grp of [this.field, this.distant]) for (const ch of [...grp.children]) {
      grp.remove(ch);
      ch.traverse((m) => { if (m instanceof THREE.Mesh || m instanceof THREE.Points) m.geometry.dispose(); });
    }
    const beacons: [THREE.Vector3, number][] = [];
    const place = (grp: THREE.Group, hull: Hull, s: { x: number; cy: number; z: number; yaw: number; fx: number; fz: number }, side: 0 | 1, tag: number) => {
      const vis = buildShipMesh(hull, FLEET_LOOK[side], tag);
      vis.group.position.set(s.x, s.cy, s.z);
      vis.group.rotation.y = -s.yaw; // ship +u (local x) -> its heading, +w (local z) -> its starboard
      grp.add(vis.group);
      for (const b of vis.beacons) beacons.push([shipPoint(s, b.x, b.y, b.z, new THREE.Vector3()), FLEET_LOOK[side].beacon]);
    };
    ships.forEach((s, i) => place(this.field, s.hull, s, s.side, i));
    // the rest of each fleet, holding station well outside the fight: two huge flagships and their escorts
    const far: FarShip[] = [];
    for (const side of [0, 1] as const) {
      const sgn = side ? 1 : -1;
      const flagL = 1500 + hash2(side, 1, 900) * 300;
      far.push({ hull: carrier(flagL, (k) => hash2(side, k, 901)), x: -sgn * 600, cy: 260 + sgn * 120, z: sgn * 2300, yaw: side ? Math.PI : 0, side });
      for (let i = 0; i < 5; i++) {
        const h = (k: number) => hash2(side * 10 + i, k, 902);
        const L = 380 + h(1) * 300;
        far.push({ hull: i % 2 ? cruiser(L, h) : frigate(L * 0.6), x: (h(2) - 0.5) * 4200, cy: (h(3) - 0.4) * 900, z: sgn * (1500 + h(4) * 1600), yaw: (side ? Math.PI : 0) + (h(5) - 0.5) * 0.4, side });
      }
    }
    for (const [i, f] of far.entries()) place(this.distant, f.hull, { ...f, fx: Math.cos(f.yaw), fz: Math.sin(f.yaw) }, f.side, 100 + i);
    // blinking beacons: two sets, out of phase
    for (let k = 0; k < 2; k++) {
      const set = beacons.filter((_, i) => i % 2 === k);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(set.flatMap(([p]) => [p.x, p.y, p.z]), 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(set.flatMap(([, c]) => { const cc = new THREE.Color(c).multiplyScalar(3); return [cc.r, cc.g, cc.b]; }), 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 7, map: dotTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
      pts.renderOrder = 4;
      this.field.add(pts);
      this.beaconPts[k] = pts;
    }
    this.battle.reset(far);
    sfx.clear();
    // boost pickups: a spinning gold crystal in a ring, with a glow you can spot from across the battle
    this.pickupMeshes = boostPickups().map((k) => {
      const g = new THREE.Group(), pm = pickupMatsOf();
      g.add(new THREE.Mesh(pickupGeo.gem, pm.gem), new THREE.Mesh(pickupGeo.ring, pm.ring));
      const halo = new THREE.Sprite(pm.halo); halo.scale.setScalar(22); g.add(halo);
      g.position.set(k.x, k.y, k.z);
      this.field.add(g);
      return g;
    });
  }

  /** The backdrop follows the camera; the battle ticks over around you. */
  update(dt: number, camPos: THREE.Vector3) {
    this.backdrop.position.copy(camPos);
    if (!this.group.visible) return;
    this.t += dt;
    if (this.planetMat) this.planetMat.uniforms.t.value = this.t;
    this.battle.update(dt, camPos);
    sfx.update(dt, camPos);
    animatePlumes(this.t);
    stepPickups(dt);
    // beacons: a quick double strobe every couple of seconds
    for (let k = 0; k < 2; k++) {
      const p = this.beaconPts[k];
      if (!p) continue;
      const ph = (this.t * 0.55 + k * 0.5) % 1;
      (p.material as THREE.PointsMaterial).opacity = ph < 0.05 || (ph > 0.12 && ph < 0.17) ? 1 : 0.06;
    }
    boostPickups().forEach((k, i) => {
      const g = this.pickupMeshes[i];
      if (!g) return;
      g.visible = k.wait <= 0;
      g.position.y = k.y + Math.sin(this.t * 1.6 + i) * 0.8;
      g.children[0].rotation.y = this.t * 2.2;
      g.children[1].rotation.set(Math.PI / 2 + Math.sin(this.t + i) * 0.4, this.t * 0.9, 0);
    });
  }
}
interface FarShip { hull: Hull; x: number; cy: number; z: number; yaw: number; side: 0 | 1 }

const vec = (v: THREE.Vector3) => `vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

/** A lumpy low-poly rock (the moon). */
function rockGeometry(detail: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = makeNoise2D(seed);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 - 0.1 * (n(v.x * 1.7 + v.y, v.z * 1.7 - v.y) * 0.5 + 0.5) + 0.03 * n(v.y * 5, v.x * 5);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// ---------- Pickup looks ----------
const pickupGeo = {
  gem: new THREE.OctahedronGeometry(2.2, 0).scale(1, 1.5, 1),
  ring: new THREE.TorusGeometry(4, 0.22, 6, 32),
};
let pickupLook: { gem: THREE.Material; ring: THREE.Material; halo: THREE.SpriteMaterial } | null = null;
const pickupMatsOf = () => (pickupLook ??= {
  gem: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23f).multiplyScalar(1.6), toneMapped: false }),
  ring: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1a8).multiplyScalar(1.4), toneMapped: false }),
  halo: new THREE.SpriteMaterial({ map: dotTexture(), color: 0xffb020, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
});
let dotTex: THREE.Texture | null = null;
/** A soft white blob (for glows and beacons). */
function dotTexture() {
  if (dotTex) return dotTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const cx = cv.getContext('2d');
  if (cx) {
    const gr = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
  }
  return (dotTex = new THREE.CanvasTexture(cv));
}

// ---------- The capital ships' own fight: occasional and in the background, never a light show ----------
// Now and then a turret puts a short burst of heavy bolts into an enemy ship (they splash on its hull),
// a damaged hull vents a secondary explosion, and far off past the fleets the odd flash shows the battle
// going on beyond. All looks: none of it can hit a fighter.
const BOLT_SPEED = 300, BOLT_MAX = 48;
interface Bolt { p: THREE.Vector3; v: THREE.Vector3; life: number; side: 0 | 1; hit: boolean }
interface Shot { delay: number; from: THREE.Vector3; to: THREE.Vector3; side: 0 | 1; hit: boolean }
type Anchor = { x: number; cy: number; z: number; fx: number; fz: number; len: number; side: 0 | 1; hull: Hull };

class Battle {
  group = new THREE.Group();
  private bolts: Bolt[] = [];
  private queue: Shot[] = [];
  private mesh: THREE.InstancedMesh;
  private timers: number[] = [];
  private blastT = 6; private farT = 2;
  private far: Anchor[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private sc = new THREE.Vector3(); private v = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);
  private colors = FLEET_LOOK.map((l) => new THREE.Color(l.bolt).multiplyScalar(2.2));
  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }), BOLT_MAX);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 4;
    this.mesh.setColorAt(0, new THREE.Color(0));
    this.group.add(this.mesh);
  }
  reset(far: FarShip[]) {
    this.bolts = []; this.queue = [];
    this.timers = ships.map(() => rnd(3, 16));
    this.far = far.map((f) => ({ x: f.x, cy: f.cy, z: f.z, fx: Math.cos(f.yaw), fz: Math.sin(f.yaw), len: f.hull.len, side: f.side, hull: f.hull }));
    this.blastT = rnd(4, 9); this.farT = rnd(1, 3);
  }
  private volley(s: Anchor) {
    const foes: Anchor[] = [...ships.filter((o) => o.side !== s.side), ...this.far.filter((o) => o.side !== s.side)];
    if (!foes.length || !s.hull.turrets.length) return;
    const tur = s.hull.turrets[Math.floor(Math.random() * s.hull.turrets.length)];
    const from = shipPoint(s, tur[0], tur[1] + tur[3], tur[2], new THREE.Vector3());
    const t = foes[Math.floor(Math.random() * foes.length)];
    const hit = Math.random() < 0.7;
    const to = shipPoint(t, (Math.random() - 0.5) * t.len * 0.6, (Math.random() - 0.3) * t.len * 0.06 + (hit ? 0 : (Math.random() - 0.5) * 160), (Math.random() - 0.5) * t.len * 0.1, new THREE.Vector3());
    const n = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < n; k++) this.queue.push({ delay: k * 0.16, from: from.clone(), to: to.clone().add(this.v.randomDirection().multiplyScalar(4)), side: s.side, hit });
  }
  update(dt: number, cam: THREE.Vector3) {
    ships.forEach((s, i) => {
      if ((this.timers[i] -= dt) <= 0) { this.volley(s); this.timers[i] = rnd(12, 26); }
    });
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if ((q.delay -= dt) > 0) continue;
      this.queue.splice(i, 1);
      if (this.bolts.length >= BOLT_MAX) continue;
      const d = q.to.distanceTo(q.from);
      this.bolts.push({ p: q.from, v: q.to.clone().sub(q.from).normalize().multiplyScalar(BOLT_SPEED), life: q.hit ? d / BOLT_SPEED : 3, side: q.side, hit: q.hit });
      sfx.muzzle(q.from, ZERO3, this.colors[q.side]);
    }
    // a secondary detonation on a hull: big and close if it's near you, a far-off flash if not
    if ((this.blastT -= dt) <= 0 && ships.length) {
      this.blastT = rnd(7, 15);
      const s = ships[Math.floor(Math.random() * ships.length)];
      const parts = s.hull.parts.filter((p) => p.solid !== false && p.u1 - p.u0 > 30);
      const p = parts[Math.floor(Math.random() * parts.length)];
      if (p) {
        const up = Math.random() < 0.6, side = Math.random() < 0.5 ? -1 : 1;
        const u = lerp(p.u0 + 5, p.u1 - 5, Math.random() * 0.6), v = up ? p.v1 : lerp(p.v0, p.v1, 0.5), w = up ? lerp(p.w0, p.w1, Math.random()) : side > 0 ? p.w1 : p.w0;
        const at = shipPoint(s, u, v, w, new THREE.Vector3());
        const n = up ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(-s.fz * side, 0, s.fx * side);
        if (at.distanceTo(cam) < 1400) sfx.hullBlast(at, n, 0.8 + Math.random() * 0.5);
        else sfx.distantFlash(at, 90);
      }
    }
    // far beyond the fleets: the battle goes on
    if ((this.farT -= dt) <= 0) {
      this.farT = rnd(1.2, 3.5);
      const a = Math.random() * Math.PI * 2, r = rnd(2600, 5200);
      sfx.distantFlash(new THREE.Vector3(Math.cos(a) * r, rnd(-500, 900), Math.sin(a) * r), rnd(60, 180), Math.random() < 0.5 ? 0xbfe0ff : 0xffc890);
    }
    let n = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.p.addScaledVector(b.v, dt); b.life -= dt;
      if (b.life <= 0) {
        if (b.hit && b.p.distanceTo(cam) < 1600) sfx.impact(b.p, this.colors[b.side], true);
        this.bolts.splice(i, 1);
      }
    }
    for (const b of this.bolts) {
      this.q.setFromUnitVectors(this.z, this.v.copy(b.v).normalize());
      this.m.compose(b.p, this.q, this.sc.set(0.9, 0.9, 26));
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.colors[b.side]);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
const ZERO3 = new THREE.Vector3();
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
