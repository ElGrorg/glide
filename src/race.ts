import * as THREE from 'three';
import { BirdMesh, type BirdPalette } from './bird';
import { serverBase } from './net';

// ---------- Time trial races: the clock, split gates, ghosts and the leaderboard client ----------
// The courses themselves (terrain, caves, canyons, the gates) come from the course module. This file only
// needs each course's gates: a vertical plane across the course that counts when the bird crosses it,
// downhill, inside its window.

/** A gate across the course: crossing its plane (normal nx, nz pointing downhill) inside halfW / halfH of the
 *  centre counts. Splits sit where the routes merge, so every route passes every gate in order. */
export interface Gate { x: number; y: number; z: number; nx: number; nz: number; halfW: number; halfH: number }
export interface CourseDef {
  id: string; version?: number; name: string; blurb: string;
  start: { x: number; y: number; z: number; heading: number };
  /** The clock starts as you cross this (or the moment you launch, if a course has none). */
  startGate?: Gate;
  splits: Gate[];
  finish: Gate;
  /** Names for the sections between gates (splits.length + 1 of them). */
  sections?: string[];
  /** a map from this device: its times stay on this device */
  local?: boolean;
}

/** Leaderboard key: a course's times only count against the same version of its geometry. */
export const boardKey = (c: CourseDef) => `${c.id}-v${c.version ?? 1}`;
export const sectionName = (c: CourseDef, i: number) => c.sections?.[i] ?? `Section ${i + 1}`;
export const gateCount = (c: CourseDef) => c.splits.length + 1;

const _d = new THREE.Vector3();
/** Did the move prev -> cur cross gate g going downhill, inside its window? */
export function crossed(g: Gate, prev: THREE.Vector3, cur: THREE.Vector3): boolean {
  const s0 = (prev.x - g.x) * g.nx + (prev.z - g.z) * g.nz;
  const s1 = (cur.x - g.x) * g.nx + (cur.z - g.z) * g.nz;
  if (!(s0 < 0 && s1 >= 0)) return false;
  const k = s0 / (s0 - s1);
  _d.lerpVectors(prev, cur, k);
  const lat = (_d.x - g.x) * -g.nz + (_d.z - g.z) * g.nx;
  return Math.abs(lat) <= g.halfW && Math.abs(_d.y - g.y) <= g.halfH;
}
/** Exact time the crossing happened inside a step (fraction of the step), for timing to the millisecond. */
function crossFrac(g: Gate, prev: THREE.Vector3, cur: THREE.Vector3) {
  const s0 = (prev.x - g.x) * g.nx + (prev.z - g.z) * g.nz;
  const s1 = (cur.x - g.x) * g.nx + (cur.z - g.z) * g.nz;
  return THREE.MathUtils.clamp(s0 / (s0 - s1), 0, 1);
}

export const fmtTime = (ms: number) => {
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
export const fmtDelta = (ms: number) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(2)}`;

// ---------- Ghosts: your flight sampled 10 times a second, packed small ----------
export const GHOST_HZ = 10;
/** Position (3 x float32) + orientation (4 x int16) per sample. */
const REC_BYTES = 20;

export class GhostData {
  constructor(public pos: Float32Array, public quat: Int16Array) {}
  get length() { return this.pos.length / 3; }
  get duration() { return (this.length - 1) / GHOST_HZ; }
  encode(): string {
    const n = this.length, buf = new ArrayBuffer(n * REC_BYTES), dv = new DataView(buf);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) dv.setFloat32(i * REC_BYTES + k * 4, this.pos[i * 3 + k], true);
      for (let k = 0; k < 4; k++) dv.setInt16(i * REC_BYTES + 12 + k * 2, this.quat[i * 4 + k], true);
    }
    let s = '';
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  static decode(str: string): GhostData | null {
    try {
      const raw = atob(str), n = Math.floor(raw.length / REC_BYTES);
      if (n < 2) return null;
      const b = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
      const dv = new DataView(b.buffer), pos = new Float32Array(n * 3), quat = new Int16Array(n * 4);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = dv.getFloat32(i * REC_BYTES + k * 4, true);
        for (let k = 0; k < 4; k++) quat[i * 4 + k] = dv.getInt16(i * REC_BYTES + 12 + k * 2, true);
      }
      return Number.isFinite(pos[0]) ? new GhostData(pos, quat) : null;
    } catch { return null; }
  }
  /** Where the ghost was at time t (seconds since its clock started). */
  sample(t: number, pos: THREE.Vector3, q: THREE.Quaternion) {
    const f = THREE.MathUtils.clamp(t * GHOST_HZ, 0, this.length - 1);
    const i = Math.min(Math.floor(f), this.length - 2), a = f - i;
    const P = this.pos, Q = this.quat;
    pos.set(P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * a, P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * a, P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * a);
    _qa.set(Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3]).normalize();
    _qb.set(Q[i * 4 + 4], Q[i * 4 + 5], Q[i * 4 + 6], Q[i * 4 + 7]).normalize();
    q.slerpQuaternions(_qa, _qb, a);
  }
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

class GhostRecorder {
  private pos: number[] = []; private quat: number[] = [];
  private next = 0;
  reset() { this.pos = []; this.quat = []; this.next = 0; }
  /** Call every frame while the clock runs, with the clock time. */
  add(t: number, p: THREE.Vector3, q: THREE.Quaternion) {
    while (t >= this.next) {
      this.pos.push(p.x, p.y, p.z);
      const s = q.w < 0 ? -32767 : 32767; // same rotation, kept with w >= 0
      this.quat.push(Math.round(q.x * s), Math.round(q.y * s), Math.round(q.z * s), Math.round(q.w * s));
      this.next += 1 / GHOST_HZ;
    }
  }
  data() { return new GhostData(new Float32Array(this.pos), new Int16Array(this.quat)); }
}

const GHOST_PAL: BirdPalette = { body: 0xbfe8ff, belly: 0xeaf8ff, wing: 0x9fd6ff, tip: 0x6fb6f0 };
/** A see-through bird flying someone's recorded run, and the line of its whole path. */
export class Ghost {
  mesh = new BirdMesh(GHOST_PAL);
  line: THREE.Line | null = null;
  data: GhostData | null = null;
  label = '';
  private prev = new THREE.Vector3();
  constructor(private scene: THREE.Scene) {
    this.mesh.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) { const c = m.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; (o as THREE.Mesh).material = c; }
    });
    this.mesh.visible = false;
    scene.add(this.mesh);
  }
  set(data: GhostData | null, label = '') {
    this.data = data; this.label = label;
    if (this.line) { this.scene.remove(this.line); this.line.geometry.dispose(); this.line = null; }
    this.mesh.visible = false;
    if (!data) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.pos.slice(), 3));
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.55, depthWrite: false }));
    this.line.frustumCulled = false;
    this.scene.add(this.line);
  }
  /** t < 0: parked on the start (before your clock starts). */
  update(t: number, wall: number) {
    if (!this.data) return;
    const tt = Math.max(0, t);
    this.data.sample(tt, this.mesh.position, this.mesh.quaternion);
    const v = this.prev.distanceTo(this.mesh.position) / 0.016;
    this.prev.copy(this.mesh.position);
    this.mesh.visible = t <= this.data.duration + 1.5; // it waits on the finish line a moment, then vanishes
    this.mesh.animate(wall, 0, Math.min(v, 60), 0, 0);
  }
  /** Seconds into its run when it was nearest to p (searching around a moving cursor). */
  private cursor = 0;
  resetCursor() { this.cursor = 0; }
  timeNear(p: THREE.Vector3): number | null {
    const d = this.data;
    if (!d) return null;
    const P = d.pos;
    let best = -1, bd = Infinity;
    const lo = Math.max(0, this.cursor - 30), hi = Math.min(d.length - 1, this.cursor + 80);
    for (let i = lo; i <= hi; i++) {
      const dd = (P[i * 3] - p.x) ** 2 + (P[i * 3 + 1] - p.y) ** 2 + (P[i * 3 + 2] - p.z) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best < 0 || bd > 120 * 120) return null; // off its line by a long way: no fair comparison
    this.cursor = best;
    return best / GHOST_HZ;
  }
}

// ---------- One run: the clock and the splits ----------
export type RunState = 'ready' | 'running' | 'finished';
export class RaceRun {
  state: RunState = 'ready';
  /** Seconds since the clock started. */
  time = 0;
  splits: number[] = []; // ms at each gate (the last one is the finish)
  next = 0;
  rec = new GhostRecorder();
  constructor(public course: CourseDef) {}
  get gates(): Gate[] { return [...this.course.splits, this.course.finish]; }
  get ms() { return Math.round(this.time * 1000); }
  reset() { this.state = this.course.startGate ? 'ready' : 'running'; this.time = 0; this.splits = []; this.next = 0; this.rec.reset(); }
  /** Advance by dt with the bird moving prev -> cur. Returns the index of a gate just passed (or -1). */
  step(dt: number, prev: THREE.Vector3, cur: THREE.Vector3, q: THREE.Quaternion): number {
    if (this.state === 'ready') {
      const sg = this.course.startGate!;
      if (crossed(sg, prev, cur)) { this.state = 'running'; this.time = (1 - crossFrac(sg, prev, cur)) * dt; this.rec.add(0, cur, q); }
      return -1;
    }
    if (this.state !== 'running') return -1;
    const t0 = this.time;
    this.time += dt;
    this.rec.add(this.time, cur, q);
    const g = this.gates[this.next];
    if (g && crossed(g, prev, cur)) {
      const at = t0 + crossFrac(g, prev, cur) * dt;
      this.splits.push(Math.round(at * 1000));
      this.next++;
      if (this.next >= this.gates.length) { this.state = 'finished'; this.time = at; }
      return this.next - 1;
    }
    return -1;
  }
}

// ---------- Leaderboard: global on the Cloudflare server, your own best kept on this device too ----------
export interface BoardEntry { pid: string; name: string; ms: number; splits: number[]; at: number; rank?: number }
export interface Board { entries: BoardEntry[]; total: number; me?: BoardEntry | null }
export interface LocalBest { ms: number; splits: number[]; ghost: string; at: number }

const httpBase = () => serverBase();
export const hasGlobalBoard = () => !!httpBase();

/** Your racer id: a secret kept on this device. The server only ever shows a hash of it. */
function secret(): string {
  try {
    let s = localStorage.getItem('glide.racer');
    if (!s || !/^[0-9a-f]{32}$/.test(s)) {
      s = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('glide.racer', s);
    }
    return s;
  } catch { return 'nostorage'.padEnd(32, '0'); }
}
let myPidCache = '';
export async function myPid(): Promise<string> {
  if (myPidCache) return myPidCache;
  const s = secret();
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    myPidCache = Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { myPidCache = s.slice(0, 16); } // (no subtle crypto off https: only matters for the local board)
  return myPidCache;
}

export function localBest(key: string): LocalBest | null {
  try { const v = JSON.parse(localStorage.getItem(`glide.race.${key}`) || 'null'); return v && typeof v.ms === 'number' ? v : null; } catch { return null; }
}
function saveLocalBest(key: string, b: LocalBest) {
  try { localStorage.setItem(`glide.race.${key}`, JSON.stringify(b)); } catch { /* storage full or off */ }
}

export async function fetchBoard(key: string): Promise<Board> {
  const base = httpBase();
  if (!base) throw new Error('no server');
  const pid = await myPid();
  const r = await fetch(`${base}/race/${key}/top?me=${pid}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`board ${r.status}`);
  return r.json();
}
const ghostCache = new Map<string, GhostData>();
export async function fetchGhost(key: string, pid: string): Promise<GhostData | null> {
  const ck = `${key}/${pid}`;
  if (ghostCache.has(ck)) return ghostCache.get(ck)!;
  const local = localBest(key);
  if (local && pid === (await myPid())) { const g = GhostData.decode(local.ghost); if (g) { ghostCache.set(ck, g); return g; } }
  const base = httpBase();
  if (!base) return null;
  const r = await fetch(`${base}/race/${key}/ghost/${pid}`);
  if (!r.ok) return null;
  const g = GhostData.decode(await r.text());
  if (g) ghostCache.set(ck, g);
  return g;
}

/** A finished run: keep it locally if it's your best, and send it to the global board. */
export async function submitRun(course: CourseDef, run: RaceRun, name: string): Promise<{ best: boolean; rank?: number; total?: number; error?: string }> {
  const key = boardKey(course);
  const prev = localBest(key);
  const ms = run.splits[run.splits.length - 1];
  const best = !prev || ms < prev.ms;
  const ghost = run.rec.data();
  const enc = ghost.encode();
  if (best) {
    saveLocalBest(key, { ms, splits: run.splits.slice(), ghost: enc, at: Date.now() });
    ghostCache.set(`${key}/${await myPid()}`, ghost);
  }
  const base = httpBase();
  if (!base || course.local) return { best }; // (your own maps keep their times on this device)
  try {
    const r = await fetch(`${base}/race/${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret(), name, ms, splits: run.splits, ghost: enc }),
    });
    const j = await r.json();
    if (!r.ok) return { best, error: j?.error || `error ${r.status}` };
    if (j.best) ghostCache.delete(`${key}/${await myPid()}`);
    return { best: best || !!j.best, rank: j.rank, total: j.total };
  } catch { return { best, error: 'offline' }; }
}
