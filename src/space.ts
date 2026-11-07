import * as THREE from 'three';
import { hash2, makeNoise2D } from './noise';
import type { Obstacle } from './world';

// ---------- Space mode: an asteroid field in low orbit over a wild planet ----------
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

const CELL = 40;            // small asteroids are bucketed by 40 m columns
const SMALL_MAX_R = 24;
const BIG_CELL = 230;
let grid = new Map<number, Obstacle[]>();
let small: Obstacle[] = [];
let bigs: Obstacle[] = [];
const key = (ix: number, iz: number) => (ix + 2000) * 4096 + (iz + 2000);
const clumpN = makeNoise2D(9101), clumpN2 = makeNoise2D(9102);

/** Signed gap between a point and one of the space obstacles (negative = inside). */
export function spaceGap(o: Obstacle, px: number, py: number, pz: number): number {
  const dx = px - o.x, dy = py - o.cy!, dz = pz - o.z;
  if (o.type === 'asteroid') return Math.hypot(dx, dy, dz) - o.r;
  const h = dx * o.ax! + dy * o.ay! + dz * o.az!;
  const rad = Math.hypot(dx - h * o.ax!, dy - h * o.ay!, dz - h * o.az!);
  if (o.type === 'ring') return Math.hypot(rad - o.R!, h) - o.r; // torus: R = ring radius, r = tube radius
  // bore: a fat rock with a straight tunnel through it. In the (radial, axial) plane it's a box from
  // the tunnel wall (ri) out to the rock's outside (R), and L either side of the middle.
  const cx = (o.ri! + o.R!) / 2, hw = (o.R! - o.ri!) / 2;
  const qx = Math.abs(rad - cx) - hw, qy = Math.abs(h) - o.L!;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/** Everything in the field within reach of the column around (x, z). */
export function asteroidsNear(x: number, z: number, radius: number, out: Obstacle[]) {
  for (const b of bigs) if (Math.hypot(b.x - x, b.z - z) < radius + b.scale) out.push(b);
  const m = radius + SMALL_MAX_R;
  const x0 = Math.floor((x - m) / CELL), x1 = Math.floor((x + m) / CELL);
  const z0 = Math.floor((z - m) / CELL), z1 = Math.floor((z + m) / CELL);
  for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
    const list = grid.get(key(ix, iz));
    if (list) for (const o of list) out.push(o);
  }
  return out;
}

/** Did the step prev -> cur thread the hole of a ring or a tunnel rock? */
export function holeThreaded(prev: THREE.Vector3, cur: THREE.Vector3): Obstacle | null {
  for (const o of bigs) {
    if (o.type === 'asteroid') continue;
    if (Math.abs(cur.x - o.x) > o.scale || Math.abs(cur.z - o.z) > o.scale) continue;
    const h0 = (prev.x - o.x) * o.ax! + (prev.y - o.cy!) * o.ay! + (prev.z - o.z) * o.az!;
    const h1 = (cur.x - o.x) * o.ax! + (cur.y - o.cy!) * o.ay! + (cur.z - o.z) * o.az!;
    if (h0 === h1 || Math.sign(h0) === Math.sign(h1)) continue;
    const f = h0 / (h0 - h1);
    const px = lerp(prev.x, cur.x, f) - o.x, py = lerp(prev.y, cur.y, f) - o.cy!, pz = lerp(prev.z, cur.z, f) - o.z;
    const hole = o.type === 'ring' ? o.R! - o.r : o.ri!;
    if (Math.hypot(px, py, pz) < hole) return o;
  }
  return null;
}

/** Pick a height near `y` where a fighter at (x, z) flying along `dir` has a clear run (no rock right ahead). */
export function clearSpawnY(x: number, z: number, dir: THREE.Vector3, y = SPACE_SPAWN_Y) {
  const near: Obstacle[] = [];
  const ok = (yy: number) => {
    for (let d = -20; d <= 160; d += 12) {
      const px = x + dir.x * d, pz = z + dir.z * d, py = yy + dir.y * d;
      near.length = 0;
      for (const o of asteroidsNear(px, pz, 6, near)) if (spaceGap(o, px, py, pz) < 14) return false;
    }
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const yy = y + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 18;
    if (ok(yy)) return yy;
  }
  return y;
}

/** Rebuild the field for this run's world seed (online: everyone's seed is the same, so is the field). */
export function buildField() {
  grid = new Map(); small = []; bigs = [];
  // big ones first: rings, tunnel rocks and giants. Mostly lying on their side so you can fly through.
  const nb = Math.ceil((SPACE_R + 60) / BIG_CELL);
  for (let ix = -nb; ix < nb; ix++) for (let iz = -nb; iz < nb; iz++) {
    if (hash2(ix, iz, 201) > 0.72) continue;
    const x = (ix + 0.2 + hash2(ix, iz, 202) * 0.6) * BIG_CELL, z = (iz + 0.2 + hash2(ix, iz, 203) * 0.6) * BIG_CELL;
    if (Math.hypot(x, z) > SPACE_R - 50) continue;
    const cy = lerp(FIELD_LO + 80, FIELD_HI - 60, hash2(ix, iz, 204));
    const roll = hash2(ix, iz, 205), s = hash2(ix, iz, 206);
    const yaw = hash2(ix, iz, 207) * Math.PI * 2, tilt = (hash2(ix, iz, 208) - 0.5) * 0.8;
    const ax = Math.cos(yaw) * Math.cos(tilt), ay = Math.sin(tilt), az = Math.sin(yaw) * Math.cos(tilt);
    const base = { id: `B${ix},${iz}`, x, z, cy, ax, ay, az, tint: hash2(ix, iz, 209) };
    if (roll < 0.4) {
      const R = 24 + s * 22, r = 6 + hash2(ix, iz, 210) * 6;
      bigs.push({ ...base, type: 'ring', R, r, y0: cy - R - r, top: cy + R + r, scale: R + r });
    } else if (roll < 0.78) {
      const R = 34 + s * 24, ri = 10 + hash2(ix, iz, 210) * 6, L = 20 + hash2(ix, iz, 211) * 26;
      bigs.push({ ...base, type: 'bore', R, ri, L, r: R, y0: cy - Math.hypot(R, L), top: cy + Math.hypot(R, L), scale: Math.hypot(R, L) });
    } else {
      const r = 38 + s * 34;
      bigs.push({ ...base, type: 'asteroid', r, y0: cy - r, top: cy + r, scale: r });
    }
  }
  // small and medium rocks, in clumps with clearings between
  const nc = Math.ceil((SPACE_R + 40) / CELL);
  let i = 0;
  for (let ix = -nc; ix < nc; ix++) for (let iz = -nc; iz < nc; iz++) {
    const cx = (ix + 0.5) * CELL, cz = (iz + 0.5) * CELL;
    if (Math.hypot(cx, cz) > SPACE_R + 40) continue;
    const clump = smoothstep(clumpN(cx / 280, cz / 280) * 0.8 + clumpN2(cx / 90, cz / 90) * 0.35, -0.45, 0.55);
    const n = Math.floor(clump * 4.6 + hash2(ix, iz, 220) * 0.9);
    for (let k = 0; k < n; k++) {
      const hy = hash2(ix * 31 + k, iz, 221);
      const y = lerp(FIELD_LO, FIELD_HI, hy);
      // the belt is thickest in the middle and thins toward its top and bottom
      const band = 1 - Math.abs(hy - 0.48) * 1.5;
      if (hash2(ix, iz * 17 + k, 222) > band) continue;
      const x = (ix + hash2(ix, iz + k * 7, 223)) * CELL, z = (iz + hash2(ix + k * 5, iz, 224)) * CELL;
      const sr = hash2(ix + k, iz * 3, 225);
      const r = sr < 0.7 ? 1.6 + hash2(ix, iz, 226 + k) * 3.6 : sr < 0.95 ? 5 + hash2(ix, iz, 240 + k) * 7 : 12 + hash2(ix, iz, 250 + k) * (SMALL_MAX_R - 12);
      // don't bury the rings and tunnels
      let clear = true;
      for (const b of bigs) if (Math.hypot(b.x - x, b.cy! - y, b.z - z) < b.scale + r + 10) { clear = false; break; }
      if (!clear) continue;
      const o: Obstacle = { id: `A${i++}`, type: 'asteroid', x, z, cy: y, y0: y - r, top: y + r, r, scale: r, tint: hash2(ix, iz, 260 + k) };
      small.push(o);
      const kk = key(Math.floor(x / CELL), Math.floor(z / CELL));
      let list = grid.get(kk); if (!list) grid.set(kk, list = []);
      list.push(o);
    }
  }
}
export function fieldStats() { return { small: small.length, big: bigs.length }; }

// ---------- Look: planet, sky, asteroids ----------
const ROCK_COLORS = [0x8a8178, 0x6f675f, 0x9c7a5c, 0x7d8794, 0xa08f7a, 0x5d5550, 0x8e6b5a, 0x6b7380].map((c) => new THREE.Color(c));

/** A lumpy low-poly rock: a sphere with its corners pushed in and out a little (mostly in, so the
 *  collision sphere hugs it). */
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

function jitter(g: THREE.BufferGeometry, amount: number, seed: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
    let d = seen.get(k);
    if (!d) { d = [(hash2(i, seed, 1) - 0.5) * amount, (hash2(i, seed, 2) - 0.5) * amount, (hash2(i, seed, 3) - 0.5) * amount]; seen.set(k, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  const flat = g.index ? g.toNonIndexed() : g;
  flat.computeVertexNormals();
  return flat;
}

const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();

export class SpaceScene {
  group = new THREE.Group();
  /** Follows the camera: stars, nebula, moons, the sun. */
  backdrop = new THREE.Group();
  private field = new THREE.Group();
  private rocks: THREE.InstancedMesh[] = [];
  private rockSpin: { o: Obstacle; mesh: number; idx: number; axis: THREE.Vector3; rate: number; q: THREE.Quaternion }[] = [];
  private rockMat = new THREE.MeshLambertMaterial({ flatShading: true });
  readonly sunDir = SUN_DIR.clone();

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.backdrop.visible = false;
    scene.add(this.group, this.backdrop);
    this.group.add(this.buildPlanet(), this.field);
    this.buildBackdrop();
  }

  set visible(on: boolean) { this.group.visible = on; this.backdrop.visible = on; }
  get visible() { return this.group.visible; }

  private buildPlanet() {
    // the planet's surface as seen from the belt: a grid draped over the sphere out past the horizon
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

  /** Rebuild the asteroid meshes from the current field. */
  rebuild() {
    for (const m of this.rocks) { this.field.remove(m); m.dispose(); }
    this.rocks = []; this.rockSpin = [];
    for (const ch of [...this.field.children]) {
      this.field.remove(ch);
      if (ch instanceof THREE.Mesh) ch.geometry.dispose();
    }
    // small and medium rocks: a few rock shapes, instanced
    const shapes = [rockGeometry(0, 11), rockGeometry(1, 12), rockGeometry(1, 13, 1.25), rockGeometry(1, 14, 0.85)];
    const buckets: Obstacle[][] = shapes.map(() => []);
    for (const o of small) buckets[o.r < 3 ? 0 : 1 + Math.floor(o.tint * 3) % 3].push(o);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3(), c = new THREE.Color();
    buckets.forEach((list, bi) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(shapes[bi], this.rockMat, list.length);
      list.forEach((o, i) => {
        q.setFromEuler(new THREE.Euler(o.tint * 9, o.tint * 23, o.tint * 41));
        m.compose(pv.set(o.x, o.cy!, o.z), q, s.setScalar(o.r));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.copy(ROCK_COLORS[Math.floor(o.tint * 97) % ROCK_COLORS.length]).multiplyScalar(0.8 + (o.tint * 7 % 1) * 0.4));
        // the little ones tumble
        if (o.r < 9) this.rockSpin.push({ o, mesh: this.rocks.length, idx: i, axis: new THREE.Vector3(o.tint - 0.5, (o.tint * 13) % 1 - 0.5, 0.3).normalize(), rate: (0.15 + (o.tint * 31) % 1 * 0.5) * (o.tint > 0.5 ? 1 : -1), q: q.clone() });
      });
      im.computeBoundingSphere();
      this.rocks.push(im);
      this.field.add(im);
    });
    // the big ones, each its own mesh
    const up = new THREE.Vector3(0, 1, 0);
    bigs.forEach((o, i) => {
      let g: THREE.BufferGeometry;
      if (o.type === 'ring') g = jitter(new THREE.TorusGeometry(o.R!, o.r * 0.95, 7, 20).rotateX(Math.PI / 2), o.r * 0.22, i);
      else if (o.type === 'bore') {
        // a rock with a tunnel: lathe a rounded box profile (outside, ends, tunnel wall) round the axis
        const R = o.R!, ri = o.ri!, L = o.L!;
        const pts = [
          new THREE.Vector2(ri, -L - 1), new THREE.Vector2(ri + (R - ri) * 0.5, -L - 4), new THREE.Vector2(R * 0.92, -L * 0.6),
          new THREE.Vector2(R * 0.98, 0), new THREE.Vector2(R * 0.92, L * 0.6), new THREE.Vector2(ri + (R - ri) * 0.5, L + 4),
          new THREE.Vector2(ri, L + 1), new THREE.Vector2(ri * 0.98, 0), new THREE.Vector2(ri, -L - 1),
        ].map((p) => new THREE.Vector2(p.x, Math.max(-L, Math.min(L, p.y))));
        g = jitter(new THREE.LatheGeometry(pts, 14), ri * 0.18, i);
      } else g = rockGeometry(2, 300 + i);
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ flatShading: true, color: ROCK_COLORS[Math.floor(o.tint * 97) % ROCK_COLORS.length].clone().multiplyScalar(0.85 + o.tint * 0.3) }));
      mesh.position.set(o.x, o.cy!, o.z);
      if (o.type === 'asteroid') { mesh.scale.setScalar(o.r); mesh.rotation.set(o.tint * 5, o.tint * 9, o.tint * 2); }
      else mesh.quaternion.setFromUnitVectors(up, new THREE.Vector3(o.ax, o.ay, o.az));
      this.field.add(mesh);
    });
  }

  /** Spin the little rocks (looks only: they're round enough that their hit sphere doesn't change). */
  update(dt: number, camPos: THREE.Vector3) {
    this.backdrop.position.copy(camPos);
    if (!this.group.visible) return;
    const m = new THREE.Matrix4(), dq = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3();
    for (const r of this.rockSpin) {
      r.q.premultiply(dq.setFromAxisAngle(r.axis, r.rate * dt));
      m.compose(pv.set(r.o.x, r.o.cy!, r.o.z), r.q, s.setScalar(r.o.r));
      this.rocks[r.mesh].setMatrixAt(r.idx, m);
    }
    for (const im of this.rocks) im.instanceMatrix.needsUpdate = true;
  }
}
