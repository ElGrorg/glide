import * as THREE from 'three';
import { makeNoise2D, hash2 } from './noise';
import type { Biome } from './route';
import type { TerrainSource } from './terrain';

// ---------- Time trial courses: fixed, hand-laid mountains (the same for everyone) ----------
// A course is a set of paths laid down a mountain. Each path is a spline of control points
// [x, z, floorY, halfWidth, height?]. Three kinds:
//   valley: a wide, open U-shaped run with gentle walls (sightlines, line choice, trees on the slopes)
//   canyon: a narrow slot with near-vertical walls cut into a raised rim
//   cave:   a tube bored through the rock (an overhang the heightfield can't hold, so it's its own mesh and
//           its own collision). Caves can branch and rejoin: free space is the union of every tube.
// The terrain is a big mountain (always well above every path), with the open paths carved out of it and the
// caves bored through it. Routes are chains of paths from the start to the finish; every route passes every
// split gate in order, so splits sit where the routes come back together.

const { smoothstep, clamp, lerp } = THREE.MathUtils;

export type PathKind = 'valley' | 'canyon' | 'cave';
/** [x, z, floorY, halfWidth, height]: height is a cave's floor-to-roof height or a canyon's wall depth. */
export type CtrlPt = [number, number, number, number, number?];
/** `dens`: how thick the trees, boulders and pillars grow on this path's floor (1 = as thick as the hillsides;
 *  default 0.45; valleys only: canyons and caves get only their set pieces). */
export interface PathDef { id: string; kind: PathKind; pts: CtrlPt[]; dens?: number }
/** A set-piece obstacle placed against a path: `at` is the fraction along it, `lat` metres right of centre.
 *  A column in a cave runs floor to roof; in the open it stands `h` metres tall. A rock sits on the floor. */
export interface PieceDef { path: string; at: number; lat: number; type: 'column' | 'rock' | 'spire'; r: number; h?: number }
/** A timing line: crossing the vertical plane through (x, y, z) with normal (nx, nz) (pointing downhill),
 *  within halfW sideways and halfH up or down of its centre. */
export interface Gate { x: number; y: number; z: number; nx: number; nz: number; halfW: number; halfH: number; /** drawn as a hoop to fly through (imported course rings) */ ring?: boolean }
export interface Vec3Like { x: number; y: number; z: number }
export interface CourseLook {
  /** cave rock colour, and the colour of the glow crystals on the walls */
  caveRock: number; crystal: number;
  /** tree / boulder / cloud densities (1 = normal) */
  trees: number; rocks: number; clouds: number; lowClouds: boolean;
  /** chance of a tall rock pillar per rock cell (out on the open ground), and a size factor for the trees */
  spires: number; tall: number;
}
export interface CourseDef {
  id: string;
  /** bump when the geometry changes enough to invalidate the leaderboard times */
  version: number;
  name: string; blurb: string; biome: Biome;
  /** world seed while this course is loaded (trees, rocks, noise): same for every player */
  seed: number;
  paths: PathDef[];
  /** each route is a chain of path ids from start to finish; routes[0] is the main line */
  routes: { name: string; paths: string[] }[];
  pieces: PieceDef[];
  look: CourseLook;
  /** where the bird appears: a short way uphill of the start gate, already gliding */
  start: { x: number; y: number; z: number; heading: number; speed: number };
  startGate: Gate; splits: Gate[]; finish: Gate;
  /** names for the sections between gates (splits.length + 1 of them) */
  sections: string[];
  /** an imported map's own ground (a heightmap or a model) in place of the mountain the paths make */
  terrain?: TerrainSource;
  /** trees, boulders and pillars placed by hand (an imported map); `y` picks the floor under it (in a tunnel) */
  objects?: ObjectDef[];
  /** a map from this device (imported): its times stay on this device */
  local?: boolean;
}
export interface ObjectDef { type: 'tree' | 'rock' | 'spire'; x: number; z: number; y?: number; r?: number; h?: number;
  /** a model's own tree or rock: no shape of ours drawn or hit (the model has both), but you still get close calls off it */
  soft?: { y0: number; top: number } }

/** Did the bird cross gate `g` (in its downhill direction) between `prev` and `cur`? */
export function gateCrossed(g: Gate, prev: Vec3Like, cur: Vec3Like): boolean {
  const s0 = (prev.x - g.x) * g.nx + (prev.z - g.z) * g.nz;
  const s1 = (cur.x - g.x) * g.nx + (cur.z - g.z) * g.nz;
  if (!(s0 < 0 && s1 >= 0)) return false;
  const f = s0 / (s0 - s1);
  const x = prev.x + (cur.x - prev.x) * f, y = prev.y + (cur.y - prev.y) * f, z = prev.z + (cur.z - prev.z) * f;
  const lat = (x - g.x) * -g.nz + (z - g.z) * g.nx;
  return Math.abs(lat) <= g.halfW && Math.abs(y - g.y) <= g.halfH;
}

// ---------- Splines ----------
const STEP = 4; // metres between path samples
interface Samples { x: Float32Array; y: Float32Array; z: Float32Array; w: Float32Array; h: Float32Array; s: Float32Array; n: number; len: number }

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
/** Resample a control polygon (Catmull-Rom through every point) at even STEP spacing. */
export function samplePath(pts: CtrlPt[], extend = 0): Samples {
  const P = pts.map((p) => [p[0], p[1], p[2], p[3], p[4] ?? 0]);
  const at = (i: number) => P[clamp(i, 0, P.length - 1)];
  const dense: number[][] = [];
  const SUB = 24;
  // centripetal Catmull-Rom (no overshoot or loops where control points are unevenly spaced)
  const knot = (a: number[], b: number[]) => Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  for (let i = 0; i < P.length - 1; i++) {
    const p1 = at(i), p2 = at(i + 1);
    const p0 = i === 0 ? p1.map((v, k) => 2 * v - p2[k]) : at(i - 1);
    const p3 = i + 2 > P.length - 1 ? p2.map((v, k) => 2 * v - p1[k]) : at(i + 2);
    const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let j = 0; j < SUB; j++) {
      const u = j / SUB, t = t1 + (t2 - t1) * u;
      const q = [0, 1, 2].map((k) => {
        const a1 = (t1 - t) / t1 * p0[k] + t / t1 * p1[k];
        const a2 = (t2 - t) / (t2 - t1) * p1[k] + (t - t1) / (t2 - t1) * p2[k];
        const a3 = (t3 - t) / (t3 - t2) * p2[k] + (t - t2) / (t3 - t2) * p3[k];
        const b1 = (t2 - t) / t2 * a1 + t / t2 * a2;
        const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
        return (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;
      });
      const e = u * u * (3 - 2 * u);
      dense.push([q[0], q[1], q[2], lerp(p1[3], p2[3], e), lerp(p1[4], p2[4], e)]);
    }
  }
  dense.push(P[P.length - 1].slice());
  // straight extensions off both ends (caves overlap the trenches they open into)
  if (extend > 0 && dense.length > 3) {
    const ext = (a: number[], b: number[]) => {
      const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
      return [a[0] + d[0] / l * extend, a[1] + d[1] / l * extend, a[2] + d[2] / l * extend, a[3], a[4]];
    };
    const head = ext(dense[0], dense[2]), tail = ext(dense[dense.length - 1], dense[dense.length - 3]);
    dense.unshift(head); dense.push(tail);
  }
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]));
  const len = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(len / STEP) + 1);
  const out: Samples = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), w: new Float32Array(n), h: new Float32Array(n), s: new Float32Array(n), n, len };
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (len * i) / (n - 1);
    while (j < dense.length - 2 && cum[j + 1] < s) j++;
    const f = clamp((s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]), 0, 1);
    const a = dense[j], b = dense[j + 1];
    out.x[i] = lerp(a[0], b[0], f); out.z[i] = lerp(a[1], b[1], f); out.y[i] = lerp(a[2], b[2], f);
    out.w[i] = lerp(a[3], b[3], f); out.h[i] = lerp(a[4], b[4], f); out.s[i] = s;
  }
  return out;
}

// ---------- The built course ----------
interface Path {
  def: PathDef; kind: PathKind; idx: number;
  sm: Samples;
  /** unit 3D tangent per sample */
  tx: Float32Array; ty: Float32Array; tz: Float32Array;
}
export interface Piece {
  id: string; type: 'spire' | 'rock'; x: number; z: number; y0: number; top: number; r: number; scale: number; tint: number; dark: boolean; biome: Biome;
}

const CELL = 40;
const WALL_REACH = 170;        // the corridor walls rise between 60 and this many metres beyond a path's edge
const WALL_H = 170;            // how high they rise (keeps every route inside the course)
const CAVE_P = 3;              // superellipse exponent of a cave's cross-section (3 = boxy with round corners)
const CANYON_WALL = 7;         // slot canyon wall steepness (metres up per metre out)
const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

export class Course {
  paths: Path[] = [];
  byId = new Map<string, Path>();
  private grid = new Map<number, Int32Array>();
  private eZ0 = 0; private eStep = 10; private env = new Float32Array(0);
  private caves: Path[] = [];
  private caveBox = { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0 };
  pieces: Piece[] = [];
  private pieceGrid = new Map<number, Piece[]>();
  private n1 = makeNoise2D(9101, true); private n2 = makeNoise2D(9102, true); private n3 = makeNoise2D(9103, true);
  /** the main line, for progress along the course */
  private main: { x: number[]; z: number[]; s: number[]; len: number } = { x: [], z: [], s: [], len: 1 };
  // scratch for nearest-segment queries
  private bd: Float32Array; private bk: Int32Array; private bt: Float32Array; private bo: Float32Array; private touched: number[] = [];

  constructor(public def: CourseDef) {
    def.paths.forEach((pd, idx) => {
      const sm = samplePath(pd.pts, pd.kind === 'cave' ? 10 : 0);
      const n = sm.n;
      const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const dx = sm.x[b] - sm.x[a], dy = sm.y[b] - sm.y[a], dz = sm.z[b] - sm.z[a];
        const l = Math.hypot(dx, dy, dz) || 1;
        tx[i] = dx / l; ty[i] = dy / l; tz[i] = dz / l;
      }
      const p: Path = { def: pd, kind: pd.kind, idx, sm, tx, ty, tz };
      this.paths.push(p); this.byId.set(pd.id, p);
      if (pd.kind === 'cave') this.caves.push(p);
    });
    this.bd = new Float32Array(this.paths.length); this.bk = new Int32Array(this.paths.length); this.bt = new Float32Array(this.paths.length); this.bo = new Float32Array(this.paths.length);
    this.buildGrid();
    this.buildEnvelope();
    this.buildMain();
    this.buildPieces();
    this.buildClearSpots();
  }

  private buildGrid() {
    const tmp = new Map<number, number[]>();
    for (const p of this.paths) {
      const sm = p.sm;
      for (let k = 0; k < sm.n - 1; k++) {
        const reach = Math.max(sm.w[k], sm.w[k + 1]) + WALL_REACH + 10;
        const x0 = Math.min(sm.x[k], sm.x[k + 1]) - reach, x1 = Math.max(sm.x[k], sm.x[k + 1]) + reach;
        const z0 = Math.min(sm.z[k], sm.z[k + 1]) - reach, z1 = Math.max(sm.z[k], sm.z[k + 1]) + reach;
        for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++)
          for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
            const kk = key(ix, iz);
            let a = tmp.get(kk); if (!a) tmp.set(kk, a = []);
            a.push((p.idx << 16) | k);
          }
      }
    }
    for (const [k, a] of tmp) this.grid.set(k, Int32Array.from(a));
    // cave bounds (to skip the cave tests fast almost everywhere)
    const b = this.caveBox; b.x0 = b.z0 = b.y0 = Infinity; b.x1 = b.z1 = b.y1 = -Infinity;
    for (const c of this.caves) for (let i = 0; i < c.sm.n; i++) {
      const w = c.sm.w[i] + 4;
      b.x0 = Math.min(b.x0, c.sm.x[i] - w); b.x1 = Math.max(b.x1, c.sm.x[i] + w);
      b.z0 = Math.min(b.z0, c.sm.z[i] - w); b.z1 = Math.max(b.z1, c.sm.z[i] + w);
      b.y0 = Math.min(b.y0, c.sm.y[i] - 4); b.y1 = Math.max(b.y1, c.sm.y[i] + c.sm.h[i] + 4);
    }
  }

  /** The mountain's reference height along z: comfortably above the highest path there. */
  private buildEnvelope() {
    let z0 = Infinity, z1 = -Infinity;
    for (const p of this.paths) for (let i = 0; i < p.sm.n; i++) { z0 = Math.min(z0, p.sm.z[i]); z1 = Math.max(z1, p.sm.z[i]); }
    z0 -= 600; z1 += 600;
    const n = Math.ceil((z1 - z0) / this.eStep) + 1;
    const top = new Float32Array(n).fill(-Infinity);
    for (const p of this.paths) for (let i = 0; i < p.sm.n; i++) {
      const y = p.sm.y[i] + (p.kind === 'cave' ? p.sm.h[i] : 0);
      const b = Math.round((p.sm.z[i] - z0) / this.eStep);
      for (let d = -8; d <= 8; d++) if (b + d >= 0 && b + d < n) top[b + d] = Math.max(top[b + d], y);
    }
    // fill the ends, then smooth
    let first = top.findIndex((v) => v > -Infinity), last = n - 1;
    while (last > 0 && top[last] === -Infinity) last--;
    for (let i = 0; i < first; i++) top[i] = top[first];
    for (let i = last + 1; i < n; i++) top[i] = top[last];
    for (let i = 0; i < n; i++) if (top[i] === -Infinity) top[i] = top[i - 1];
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let d = -6; d <= 6; d++) { const j = clamp(i + d, 0, n - 1); s += Math.max(top[j], top[i] - 30); c++; }
      sm[i] = s / c;
    }
    this.env = sm; this.eZ0 = z0;
  }

  /** Mountain reference height at depth z (above every path near this depth). */
  envelope(z: number) {
    const f = clamp((z - this.eZ0) / this.eStep, 0, this.env.length - 1.001);
    const i = Math.floor(f);
    return lerp(this.env[i], this.env[i + 1], f - i);
  }

  private buildMain() {
    const xs: number[] = [], zs: number[] = [], ss: number[] = [];
    let s = 0;
    for (const id of this.def.routes[0].paths) {
      const p = this.byId.get(id)!;
      for (let i = 0; i < p.sm.n; i++) {
        if (xs.length) s += Math.hypot(p.sm.x[i] - xs[xs.length - 1], p.sm.z[i] - zs[zs.length - 1]);
        xs.push(p.sm.x[i]); zs.push(p.sm.z[i]); ss.push(s);
      }
    }
    this.main = { x: xs, z: zs, s: ss, len: Math.max(1, s) };
  }

  /** 0..1 along the main line (nearest point in plan view). */
  progress(x: number, z: number) {
    const m = this.main;
    let best = Infinity, bi = 0;
    for (let i = 0; i < m.x.length; i += 2) {
      const d = (m.x[i] - x) ** 2 + (m.z[i] - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return clamp(m.s[bi] / m.len, 0, 1);
  }

  /** Point on a path at fraction `at` (0..1) with its tangent. */
  pointOn(id: string, at: number) {
    const p = this.byId.get(id);
    if (!p) throw new Error(`course ${this.def.id}: no path ${id}`);
    const sm = p.sm;
    // caves were extended 10 m at each end: `at` is measured on the authored part
    const ext = p.kind === 'cave' ? 10 : 0;
    const s = ext + (sm.len - 2 * ext) * clamp(at, 0, 1);
    const i = clamp(Math.round(s / STEP), 0, sm.n - 1);
    return { x: sm.x[i], y: sm.y[i], z: sm.z[i], w: sm.w[i], h: sm.h[i], tx: p.tx[i], ty: p.ty[i], tz: p.tz[i], kind: p.kind };
  }

  // ---------- nearest-segment scan ----------
  /** Fills bd/bk/bt for every path with a segment in this cell (plan-view distance). Returns the touched list. */
  private scan(x: number, z: number): number[] {
    const t = this.touched; t.length = 0;
    const cell = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!cell) return t;
    const bd = this.bd;
    for (let i = 0; i < cell.length; i++) {
      const e = cell[i], pi = e >> 16, k = e & 0xffff;
      const sm = this.paths[pi].sm;
      const ax = sm.x[k], az = sm.z[k], dx = sm.x[k + 1] - ax, dz = sm.z[k + 1] - az;
      const l2 = dx * dx + dz * dz || 1e-6;
      const raw = ((x - ax) * dx + (z - az) * dz) / l2, f = clamp(raw, 0, 1);
      const ex = ax + dx * f - x, ez = az + dz * f - z;
      const d = ex * ex + ez * ez;
      if (t.indexOf(pi) < 0) { t.push(pi); bd[pi] = Infinity; }
      if (d < bd[pi]) {
        bd[pi] = d; this.bk[pi] = k; this.bt[pi] = f;
        // metres past the path's open end (before the start: negative), for carrying its grade on over a junction
        this.bo[pi] = k === 0 && raw < 0 ? raw * Math.sqrt(l2) : k === sm.n - 2 && raw > 1 ? (raw - 1) * Math.sqrt(l2) : 0;
      }
    }
    for (const pi of t) bd[pi] = Math.sqrt(bd[pi]);
    return t;
  }
  /** Floor height of an open path at the scanned point; past its ends the floor carries on at the end grade
   *  (so where paths meet, neither one's end leaves a dish or a step in the other's floor). */
  private floorY(p: Path, pi: number) {
    const fy = this.lerpS(p, p.sm.y, pi), o = this.bo[pi];
    if (o === 0) return fy;
    const sm = p.sm, k = this.bk[pi];
    const g = (sm.y[k + 1] - sm.y[k]) / (Math.hypot(sm.x[k + 1] - sm.x[k], sm.z[k + 1] - sm.z[k]) || 1);
    return fy + clamp(g, -0.45, 0.2) * clamp(o, -40, 40);
  }
  private lerpS(p: Path, arr: Float32Array, pi: number) { const k = this.bk[pi]; return lerp(arr[k], arr[k + 1], this.bt[pi]); }

  /** Ground height (the open surface: the mountain over a cave, not the cave floor). */
  height(x: number, z: number): number {
    if (this.def.terrain) return this.def.terrain.height(x, z);
    const n1 = this.n1, n2 = this.n2, n3 = this.n3;
    const ridged = 1 - Math.abs(n1(x / 230, z / 230));
    const rough = ridged * ridged * 95 + n2(x / 140, z / 140) * 22;
    const detail = n3(x / 34, z / 34) * 2.2 + n2(x / 85 + 7, z / 85) * 4;
    let h = this.envelope(z) + 30 + rough;
    const touched = this.scan(x, z);
    let edge = Infinity; // distance beyond the nearest path's edge
    for (const pi of touched) {
      const p = this.paths[pi];
      edge = Math.min(edge, this.bd[pi] - this.lerpS(p, p.sm.w, pi));
    }
    h += WALL_H * smoothstep(edge, 60, WALL_REACH);
    // raise: rock over the caves, rims round the canyons
    for (const pi of touched) {
      const p = this.paths[pi], d = this.bd[pi];
      const w = this.lerpS(p, p.sm.w, pi), fy = this.lerpS(p, p.sm.y, pi), hh = this.lerpS(p, p.sm.h, pi);
      if (p.kind === 'cave') h = Math.max(h, fy + hh + 16 - Math.max(0, d - w - 10) * 0.9);
      else if (p.kind === 'canyon') h = Math.max(h, fy + (hh || 55) - Math.max(0, d - w - 30) * 0.6);
    }
    h += detail;
    // carve the open paths
    for (const pi of touched) {
      const p = this.paths[pi];
      if (p.kind === 'cave') continue;
      const d = this.bd[pi];
      const w = this.lerpS(p, p.sm.w, pi), fy = this.floorY(p, pi);
      let v: number;
      if (p.kind === 'valley') {
        const core = w * 0.42;
        const u = Math.max(0, d - core) / (w - core);
        v = fy + u * u * 38 + Math.max(0, d - w) * 1.3 + detail * 0.55;
      } else {
        v = fy + 1.5 * (d / w) ** 4 + Math.max(0, d - w) * CANYON_WALL + n3(x / 9, z / 9) * 0.6 * smoothstep(d, w - 2, w + 4);
        if (d < w) v = Math.min(v, fy + 1.5);
      }
      h = Math.min(h, v);
    }
    return h;
  }

  /** How thick obstacles may grow at (x, z), as a factor of the hillside density: 0 keeps it bare (the timing
   *  lines, the spawn run, canyon slots, cave mouths), a path's own `dens` on its floor, 1 out on the slopes. */
  floorDensity(x: number, z: number, rocks = false): number {
    for (const c of this.clearSpots) if ((x - c[0]) ** 2 + (z - c[1]) ** 2 < c[2] * c[2]) return 0;
    let f = 1, caveTop = -Infinity;
    for (const pi of this.scan(x, z)) {
      const p = this.paths[pi], d = this.bd[pi], w = this.lerpS(p, p.sm.w, pi);
      if (p.kind === 'valley' && d < w) f = Math.min(f, (p.def.dens ?? 0.45) * (rocks ? smoothstep(d, w * 0.15, w * 0.4) * 0.6 + 0.4 : 1));
      else if (p.kind === 'canyon' && d < w + 10) return 0; // slots: only their set pieces
      else if (p.kind === 'cave' && d < w + 12) caveTop = Math.max(caveTop, this.lerpS(p, p.sm.y, pi) + this.lerpS(p, p.sm.h, pi));
    }
    // near a cave's mouth the slope above the portal stays bare too
    if (caveTop > -Infinity && this.height(x, z) < caveTop + 22) return 0;
    return f;
  }
  /** Bare circles [x, z, radius]: round each timing line, and along the run in from the spawn point. */
  private clearSpots: [number, number, number][] = [];
  private buildClearSpots() {
    const d = this.def;
    for (const g of [d.startGate, ...d.splits, d.finish]) if (g) {
      this.clearSpots.push([g.x, g.z, g.halfW + 14]);
      this.clearSpots.push([g.x - g.nx * 30, g.z - g.nz * 30, g.halfW + 8], [g.x + g.nx * 30, g.z + g.nz * 30, g.halfW + 8]);
    }
    if (d.start && d.startGate) for (let f = 0; f <= 1; f += 0.25)
      this.clearSpots.push([lerp(d.start.x, d.startGate.x, f), lerp(d.start.z, d.startGate.z, f), 34]);
  }

  // ---------- caves ----------
  private inCaveBox(x: number, y: number, z: number) {
    const b = this.caveBox;
    return x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.y1;
  }
  /** Signed clearance inside one cave tube at the scanned segment: + inside (metres to the wall), - in rock.
   *  Also returns the floor height under the point. */
  private tube(p: Path, pi: number, x: number, y: number, z: number, out: { gap: number; floor: number }) {
    const k = this.bk[pi], f = this.bt[pi], sm = p.sm;
    const cx = lerp(sm.x[k], sm.x[k + 1], f), cz = lerp(sm.z[k], sm.z[k + 1], f);
    const w = lerp(sm.w[k], sm.w[k + 1], f), hh = lerp(sm.h[k], sm.h[k + 1], f) / 2;
    const cy = lerp(sm.y[k], sm.y[k + 1], f) + hh;
    const tx = p.tx[k], ty = p.ty[k], tz = p.tz[k];
    let vx = x - cx, vy = y - cy, vz = z - cz;
    const along = vx * tx + vy * ty + vz * tz;
    // past the open ends of the tube: no cave there
    const s = lerp(sm.s[k], sm.s[k + 1], f);
    if ((s <= 0.01 && along < 0) || (s >= sm.len - 0.01 && along > 0)) { out.gap = -99; out.floor = -1e9; return; }
    vx -= along * tx; vy -= along * ty; vz -= along * tz;
    const rl = Math.hypot(tz, tx) || 1;
    const rx = -tz / rl, rz = tx / rl;                  // right (level)
    const ux = -rz * ty, uy = rz * tx - rx * tz, uz = rx * ty; // up = right x tangent
    const lx = vx * rx + vz * rz, ly = vx * ux + vy * uy + vz * uz;
    const ax = Math.abs(lx) / w, ay = Math.abs(ly) / hh;
    const q = Math.cbrt(ax * ax * ax + ay * ay * ay);
    out.gap = (1 - q) * Math.min(w, hh);
    const fx = Math.min(1, ax);
    out.floor = cy - hh * Math.cbrt(Math.max(0, 1 - fx * fx * fx));
  }
  private tg = { gap: 0, floor: 0 };
  /** Best clearance over all the cave tubes at (x, y, z) (-99 when nowhere near one), and the floor under it. */
  caveAt(x: number, y: number, z: number): { gap: number; floor: number } {
    const r = { gap: -99, floor: -1e9 };
    if (!this.caves.length || !this.inCaveBox(x, y, z)) return r;
    for (const pi of this.scan(x, z)) {
      const p = this.paths[pi];
      if (p.kind !== 'cave') continue;
      this.tube(p, pi, x, y, z, this.tg);
      if (this.tg.gap > r.gap) { r.gap = this.tg.gap; r.floor = this.tg.floor; }
    }
    return r;
  }
  /** Clearance to any one cave other than `skip` (for culling the walls where two tubes meet). */
  private caveGapExcept(skip: number, x: number, y: number, z: number) {
    let g = -99;
    for (const pi of this.scan(x, z)) {
      if (pi === skip || this.paths[pi].kind !== 'cave') continue;
      this.tube(this.paths[pi], pi, x, y, z, this.tg);
      g = Math.max(g, this.tg.gap);
    }
    return g;
  }

  /** Metres of free air around (x, y, z): negative inside rock. Free air is open sky above the ground or the inside of any cave. */
  solidClearance(x: number, y: number, z: number): number {
    const t = this.def.terrain;
    if (t?.clearance) return t.clearance(x, y, z);
    const open = y - this.height(x, z);
    if (open > 30) return open;
    const c = this.caveAt(x, y, z);
    return Math.max(open, c.gap);
  }
  /** Height of the ground under the bird: a cave's floor when you're in one, otherwise the open surface. */
  floorBelow(x: number, y: number, z: number): number {
    const t = this.def.terrain;
    if (t?.floor) return t.floor(x, y, z);
    const h = this.height(x, z);
    if (y > h - 0.5) return h;
    const c = this.caveAt(x, y, z);
    return c.gap > -2 ? c.floor : h;
  }
  /** 0..1: how deep in a cave (for darkening the fog). */
  caveShade(x: number, y: number, z: number): number {
    const t = this.def.terrain;
    if (t?.shade) return t.shade(x, y, z);
    const h = this.height(x, z);
    if (y > h) return 0;
    const c = this.caveAt(x, y, z);
    if (c.gap < -1) return 0;
    return smoothstep(h - y, 6, 40);
  }

  // ---------- set pieces ----------
  private buildPieces() {
    this.def.pieces.forEach((pd, i) => {
      const pt = this.pointOn(pd.path, pd.at);
      const rl = Math.hypot(pt.tx, pt.tz) || 1;
      const x = pt.x - (pt.tz / rl) * pd.lat, z = pt.z + (pt.tx / rl) * pd.lat;
      const tint = hash2(i, 77, 3);
      let pc: Piece;
      if (pd.type === 'column') {
        const c = this.caveAt(x, pt.y + 2, z);
        const floor = pt.kind === 'cave' && c.gap > -5 ? c.floor : this.height(x, z);
        const top = pt.kind === 'cave' ? pt.y + pt.h + 8 : floor + (pd.h ?? 40);
        pc = { id: `cp${i}`, type: 'spire', x, z, y0: floor - 4, top, r: pd.r, scale: 1, tint, dark: pt.kind === 'cave', biome: this.def.biome };
      } else if (pd.type === 'spire') {
        const floor = this.height(x, z);
        pc = { id: `cp${i}`, type: 'spire', x, z, y0: floor - 3, top: floor + (pd.h ?? 50), r: pd.r, scale: 1, tint, dark: false, biome: this.def.biome };
      } else {
        const floor = pt.kind === 'cave' ? this.caveAt(x, pt.y + 2, z).floor : this.height(x, z);
        pc = { id: `cp${i}`, type: 'rock', x, z, y0: floor + pd.r * 0.2, top: floor + pd.r * 1.2, r: pd.r, scale: pd.r, tint, dark: pt.kind === 'cave', biome: this.def.biome };
      }
      this.pieces.push(pc);
      const r = pc.r + 2;
      for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++)
        for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
          const k = key(ix, iz); let a = this.pieceGrid.get(k); if (!a) this.pieceGrid.set(k, a = []); a.push(pc);
        }
    });
  }
  piecesNear(x: number, z: number, radius: number, out: Piece[]) {
    const seen = new Set<Piece>();
    for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++)
      for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++)
        for (const p of this.pieceGrid.get(key(ix, iz)) ?? []) if (!seen.has(p)) { seen.add(p); out.push(p); }
    return out;
  }

  /** Should this ground triangle be left out (it lies across a cave mouth or inside a tube)? */
  cullGround(x: number, y: number, z: number): boolean {
    if (!this.caves.length || !this.inCaveBox(x, y, z)) return false;
    return this.caveAt(x, y, z).gap > 0.2;
  }

  /** The line a route follows: samples from start to finish (for the autopilot and the minimap). */
  routeLine(ri: number): { x: number; y: number; z: number; w: number; h: number; kind: PathKind }[] {
    const out: { x: number; y: number; z: number; w: number; h: number; kind: PathKind }[] = [];
    for (const id of this.def.routes[ri].paths) {
      const p = this.byId.get(id)!;
      const ext = p.kind === 'cave' ? Math.round(10 / STEP) : 0;
      for (let i = ext; i < p.sm.n - ext; i++) out.push({ x: p.sm.x[i], y: p.sm.y[i], z: p.sm.z[i], w: p.sm.w[i], h: p.sm.h[i], kind: p.kind });
    }
    return out;
  }

  // ---------- meshes: the cave tubes, the gates ----------
  buildScene(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'course';
    const own = this.def.terrain?.scene?.();
    if (own) group.add(own);
    const look = this.def.look;
    const rock = new THREE.Color(look.caveRock), tmp = new THREE.Color();
    const L = new THREE.Vector3(0.35, 1, 0.25).normalize();
    const N = 18;
    const crystals: THREE.Matrix4[] = [];
    for (const p of this.caves) {
      const sm = p.sm;
      // how far each sample is from daylight (for darkening the deep parts)
      const under = new Float32Array(sm.n);
      for (let i = 0; i < sm.n; i++) under[i] = this.height(sm.x[i], sm.z[i]) - (sm.y[i] + sm.h[i]);
      const fromDay = new Float32Array(sm.n).fill(1e9);
      for (let i = 0; i < sm.n; i++) if (under[i] < 2) fromDay[i] = 0;
      for (let i = 1; i < sm.n; i++) fromDay[i] = Math.min(fromDay[i], fromDay[i - 1] + STEP);
      for (let i = sm.n - 2; i >= 0; i--) fromDay[i] = Math.min(fromDay[i], fromDay[i + 1] + STEP);
      // rings of vertices
      const ring: THREE.Vector3[][] = [];
      for (let i = 0; i < sm.n; i++) {
        const tx = p.tx[i], ty = p.ty[i], tz = p.tz[i];
        const rl = Math.hypot(tz, tx) || 1;
        const rx = -tz / rl, rz = tx / rl;
        const ux = -rz * ty, uy = rz * tx - rx * tz, uz = rx * ty;
        const w = sm.w[i], hh = sm.h[i] / 2, cy = sm.y[i] + hh;
        const r: THREE.Vector3[] = [];
        for (let j = 0; j < N; j++) {
          const a = (j / N) * Math.PI * 2;
          const c = Math.cos(a), s = Math.sin(a);
          // superellipse |x|^3 + |y|^3 = 1, nudged out a little for rough rock (never in: the walls you see are never closer than the walls you hit)
          const ex = Math.sign(c) * Math.cbrt(c * c), ey = Math.sign(s) * Math.cbrt(s * s);
          const bump = 1.02 + hash2(i + p.idx * 9999, j, 41) * 0.09 * (s < -0.6 ? 0.3 : 1);
          const lx = ex * w * bump, ly = ey * hh * bump;
          r.push(new THREE.Vector3(sm.x[i] + rx * lx + ux * ly, cy + uy * ly, sm.z[i] + rz * lx + uz * ly));
        }
        ring.push(r);
        // glow crystals along the walls, every so often
        if (i % 3 === 0 && hash2(i, p.idx, 43) < 0.55) {
          const j = Math.floor(hash2(i, p.idx, 44) * N);
          const a = (j / N) * Math.PI * 2;
          if (Math.sin(a) > -0.5) {
            const v = r[j].clone().lerp(new THREE.Vector3(sm.x[i], cy, sm.z[i]), 0.02);
            if (v.y < this.height(v.x, v.z) - 3 && this.caveGapExcept(p.idx, v.x, v.y, v.z) < -1) crystals.push(new THREE.Matrix4().compose(v, new THREE.Quaternion().setFromEuler(new THREE.Euler(hash2(i, j, 45) * 3, hash2(i, j, 46) * 3, 0)),
              new THREE.Vector3(1, 2.4, 1).multiplyScalar(0.6 + hash2(i, j, 47) * 0.9)));
          }
        }
      }
      // triangles, in pieces of ~120 m so the far parts get frustum-culled
      const PIECE = 30;
      for (let i0 = 0; i0 < sm.n - 1; i0 += PIECE) {
        const pos: number[] = [], col: number[] = [];
        const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3(), cen = new THREE.Vector3();
        const face = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, i: number, j: number) => {
          cen.copy(a).add(b).add(c).divideScalar(3);
          // out in the open (past a portal), or inside another tube where two caves meet: leave it out
          if (cen.y > this.height(cen.x, cen.z) - 0.3) return;
          if (this.caveGapExcept(p.idx, cen.x, cen.y, cen.z) > 0.5) return;
          e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2).normalize();
          const lit = 0.42 + 0.5 * Math.max(0, nrm.dot(L)) + 0.12 * Math.max(0, nrm.y);
          const deep = lerp(1, 0.55, smoothstep(fromDay[i], 0, 70));
          tmp.copy(rock).multiplyScalar(lit * deep * (0.9 + hash2(i * 31 + p.idx, j, 42) * 0.2));
          for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); col.push(tmp.r, tmp.g, tmp.b); }
        };
        for (let i = i0; i < Math.min(sm.n - 1, i0 + PIECE); i++) for (let j = 0; j < N; j++) {
          const a = ring[i][j], b = ring[i][(j + 1) % N], c = ring[i + 1][j], d = ring[i + 1][(j + 1) % N];
          // faces point into the tube
          face(a, b, c, i, j); face(b, d, c, i, j);
        }
        if (!pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.computeBoundingSphere();
        group.add(new THREE.Mesh(g, caveMat));
      }
    }
    if (crystals.length) {
      const im = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: look.crystal }), crystals.length);
      crystals.forEach((m, i) => im.setMatrixAt(i, m));
      group.add(im);
    }
    // gates: the start and finish banners, and a pair of beacons at each split
    const d = this.def;
    group.add(d.startGate.ring ? this.hoop(d.startGate, 0x3a7bd5) : this.banner(d.startGate, 0x3a7bd5), d.finish.ring ? this.hoop(d.finish, 0xffffff) : this.banner(d.finish, 0xffffff, true));
    d.splits.forEach((g) => group.add(g.ring ? this.hoop(g, 0xffd23f) : this.beacons(g)));
    return group;
  }

  /** An arch over a timing line: two posts and a chequered (finish) or coloured (start) band. */
  private banner(g: Gate, color: number, chequer = false) {
    const grp = new THREE.Group();
    const post = new THREE.MeshLambertMaterial({ color: 0x5a4a3a, flatShading: true });
    const w = g.halfW, top = g.halfH * 0.9;
    const rx = -g.nz, rz = g.nx;
    for (const s of [-1, 1]) {
      const x = g.x + rx * w * s, z = g.z + rz * w * s;
      const y0 = this.height(x, z) - 4, y1 = g.y + top;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, Math.max(4, y1 - y0), 6), post);
      m.position.set(x, (y0 + y1) / 2, z);
      grp.add(m);
    }
    let mat: THREE.Material;
    if (chequer) {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8;
      const c = cv.getContext('2d')!;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#fff'; c.fillRect(i * 4, j * 4, 4, 4); }
      const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    } else mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const band = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, 3.2), mat);
    band.position.set(g.x, g.y + top, g.z);
    band.rotation.y = Math.atan2(-g.nx, -g.nz);
    grp.add(band);
    return grp;
  }
  /** A ring to fly through (imported courses): a glowing hoop the size of the timing window. */
  private hoop(g: Gate, color: number) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(Math.min(g.halfW, g.halfH), 0.6, 6, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    m.position.set(g.x, g.y, g.z);
    m.rotation.y = Math.atan2(g.nx, g.nz);
    return m;
  }
  /** A split: a glowing beacon post either side of the line. */
  private beacons(g: Gate) {
    const grp = new THREE.Group();
    const rx = -g.nz, rz = g.nx;
    const post = new THREE.MeshLambertMaterial({ color: 0x4a4038, flatShading: true });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    for (const s of [-1, 1]) {
      const x = g.x + rx * g.halfW * s, z = g.z + rz * g.halfW * s;
      const y0 = this.height(x, z) - 3, y1 = Math.max(y0 + 10, g.y + 8);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, y1 - y0, 6), post);
      m.position.set(x, (y0 + y1) / 2, z);
      const b = new THREE.Mesh(new THREE.OctahedronGeometry(1.6, 0), glow);
      b.position.set(x, y1 + 1.6, z);
      grp.add(m, b);
    }
    return grp;
  }
}

export const caveMat = new THREE.MeshBasicMaterial({ vertexColors: true });

// ---------- Building a course definition ----------
type RawCourse = Omit<CourseDef, 'start' | 'startGate' | 'splits' | 'finish'> & {
  /** [path id, fraction] for each timing line; the start gate, the splits in order, the finish */
  startAt: [string, number]; splitsAt: [string, number][]; finishAt: [string, number];
};

/** Turn a hand-written course into a CourseDef: timing lines and the start position come from the paths. */
export function defineCourse(raw: RawCourse): CourseDef {
  const { startAt, splitsAt, finishAt, ...rest } = raw;
  const tmpDef: CourseDef = { ...rest, start: { x: 0, y: 0, z: 0, heading: 0, speed: 0 }, startGate: null!, splits: [], finish: null!, sections: rest.sections };
  // geometry-only probe (no noise needed for the path splines)
  const probe = { byId: new Map<string, { sm: Samples; kind: PathKind }>() };
  for (const p of tmpDef.paths) probe.byId.set(p.id, { sm: samplePath(p.pts, p.kind === 'cave' ? 10 : 0), kind: p.kind });
  const at = (id: string, f: number) => {
    const p = probe.byId.get(id);
    if (!p) throw new Error(`course ${raw.id}: no path ${id}`);
    const ext = p.kind === 'cave' ? 10 : 0;
    const s = ext + (p.sm.len - 2 * ext) * clamp(f, 0, 1);
    const i = clamp(Math.round(s / STEP), 1, p.sm.n - 2);
    const sm = p.sm;
    const dx = sm.x[i + 1] - sm.x[i - 1], dz = sm.z[i + 1] - sm.z[i - 1], l = Math.hypot(dx, dz) || 1;
    return { x: sm.x[i], y: sm.y[i], z: sm.z[i], w: sm.w[i], h: sm.h[i], nx: dx / l, nz: dz / l, kind: p.kind };
  };
  const gate = ([id, f]: [string, number]): Gate => {
    const p = at(id, f);
    const halfH = p.kind === 'cave' ? p.h : p.kind === 'canyon' ? Math.max(40, p.h) : 70;
    return { x: p.x, y: p.y + (p.kind === 'cave' ? p.h / 2 : halfH * 0.5), z: p.z, nx: p.nx, nz: p.nz, halfW: p.w + (p.kind === 'valley' ? 0 : 2), halfH };
  };
  tmpDef.startGate = gate(startAt);
  tmpDef.splits = splitsAt.map(gate);
  tmpDef.finish = gate(finishAt);
  const s0 = at(startAt[0], 0);
  const g = tmpDef.startGate;
  // spawn ~70 m uphill of the start line, 14 m off the floor, heading down the line
  const back = at(startAt[0], Math.max(0, startAt[1] - 70 / probe.byId.get(startAt[0])!.sm.len));
  void s0;
  tmpDef.start = { x: back.x, y: back.y + 14, z: back.z, heading: Math.atan2(-g.nx, -g.nz), speed: 34 };
  if (tmpDef.sections.length !== tmpDef.splits.length + 1) throw new Error(`course ${raw.id}: need ${tmpDef.splits.length + 1} section names`);
  return tmpDef;
}
