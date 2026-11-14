import * as THREE from 'three';
import { obstaclesNear, obstacleGap, floorBelow, solidClearance, getCourse, isSpace, type Obstacle } from './world';
import { ENEMY_HIT_R, PLAYER_HIT_R, ENEMY_CRASH_R } from './dogfight';

/** Your bird's crash radius against trees, rocks and pillars (main.ts subtracts it from obstacleGap). */
export const BIRD_CRASH_R = 0.5;
/** You crash when your centre gets this close to the ground. */
export const GROUND_CRASH_GAP = 0.45;

// Shapes are traced from obstacleGap itself (the function the crash check calls), never redrawn from their own
// numbers, so what you see is exactly what you hit.
const RINGS = 14, SPOKES = 16, LAT = 9;
const OBS_RANGE = 70, MAX_SHAPES = 180, BUILD_PER_FRAME = 4;

const mat = (color: number, hidden: boolean, opacity = 1) => new THREE.LineBasicMaterial({
  color, transparent: true, opacity: hidden ? opacity * 0.22 : opacity, depthTest: !hidden, depthWrite: false, fog: false,
});
const OBS = mat(0xff2d55, false), OBS_HID = mat(0xff2d55, true);
const HIT = mat(0xffe600, false), HIT_HID = mat(0xffe600, true, 2.5);
const GROUND = mat(0x2de1ff, false, 0.75), GROUND_HID = mat(0x2de1ff, true, 0.6);
const CAVE = mat(0xd05cff, false, 0.9), CAVE_HID = mat(0xd05cff, true);
const ME = mat(0xffe600, false, 0.95), ME_HID = mat(0xffe600, true, 3);
const SHOT = mat(0xff9500, false, 0.45), SHOT_HID = mat(0xff9500, true, 0.8);
const FOE = mat(0xff2d55, false, 0.95), FOE_HID = mat(0xff2d55, true, 3);

/** A pair of line sets on one geometry: the parts in plain view drawn bright, the parts behind things faint. */
function lines(geo: THREE.BufferGeometry, front: THREE.Material, back: THREE.Material, order = 20) {
  const g = new THREE.Group();
  const a = new THREE.LineSegments(geo, front), b = new THREE.LineSegments(geo, back);
  a.renderOrder = order; b.renderOrder = order + 1; a.frustumCulled = b.frustumCulled = false;
  g.add(a, b);
  return g;
}
function wireSphere(): THREE.BufferGeometry {
  // three great circles plus a few latitude rings: reads as a ball from any side without clutter
  const pts: number[] = [];
  const N = 32;
  const ring = (f: (a: number) => [number, number, number]) => {
    for (let i = 0; i < N; i++) { pts.push(...f((i / N) * Math.PI * 2), ...f(((i + 1) / N) * Math.PI * 2)); }
  };
  ring((a) => [Math.cos(a), Math.sin(a), 0]);
  ring((a) => [Math.cos(a), 0, Math.sin(a)]);
  ring((a) => [0, Math.cos(a), Math.sin(a)]);
  for (const y of [-0.6, 0.6]) { const r = Math.sqrt(1 - y * y); ring((a) => [Math.cos(a) * r, y, Math.sin(a) * r]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
const SPHERE = wireSphere();
function ballAt(front: THREE.Material, back: THREE.Material, r: number) {
  const g = lines(SPHERE, front, back, 30);
  g.scale.setScalar(r);
  return g;
}

/** Outermost point along a ray coming in from `far` toward `c` where the obstacle's gap goes to zero. */
function surfaceAlong(o: Obstacle, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, far: number): number {
  const steps = 36, st = far / steps;
  let out = far;
  for (let i = 1; i <= steps; i++) {
    const d = far - i * st;
    if (obstacleGap(o, cx + dx * d, cy + dy * d, cz + dz * d) <= 0) {
      let lo = d, hi = out; // lo inside, hi outside
      for (let k = 0; k < 7; k++) {
        const m = (lo + hi) / 2;
        if (obstacleGap(o, cx + dx * m, cy + dy * m, cz + dz * m) <= 0) lo = m; else hi = m;
      }
      return (lo + hi) / 2;
    }
    out = d;
  }
  return 0;
}

/** Trace an obstacle's hitbox into a wire cage. */
function traceObstacle(o: Obstacle): THREE.BufferGeometry {
  const pts: number[] = [];
  const centred = o.type === 'rock' || o.cy !== undefined;
  if (centred) {
    // a ball-ish shape: rays in from all round its centre
    const cx = o.x, cy = o.cy ?? o.y0, cz = o.z;
    const far = (o.cy !== undefined ? Math.max(o.hx ?? 1, o.hy ?? 1, o.hz ?? 1) * 1.3 : o.r * 1.6) + 1.5;
    const P: number[][][] = [];
    for (let i = 0; i <= LAT; i++) {
      const th = (i / LAT) * Math.PI, sy = Math.cos(th), sr = Math.sin(th);
      P.push([]);
      for (let j = 0; j < SPOKES; j++) {
        const ph = (j / SPOKES) * Math.PI * 2, dx = sr * Math.cos(ph), dz = sr * Math.sin(ph);
        const r = surfaceAlong(o, cx, cy, cz, dx, sy, dz, far);
        P[i].push([cx + dx * r, cy + sy * r, cz + dz * r]);
      }
    }
    for (let i = 0; i <= LAT; i++) for (let j = 0; j < SPOKES; j++) {
      if (i > 0 && i < LAT) pts.push(...P[i][j], ...P[i][(j + 1) % SPOKES]);
      if (i < LAT) pts.push(...P[i][j], ...P[i + 1][j]);
    }
  } else {
    // an upright shape: horizontal rays in toward its trunk, ring by ring up its height
    const far = Math.max(o.r * 1.4, o.scale * 2.2) + 1.5;
    const y0 = o.y0, y1 = o.top + (o.top - o.y0) * 0.04; // (a pine's tip pokes a little past `top`)
    const P: number[][][] = [];
    for (let i = 0; i <= RINGS; i++) {
      const y = y0 + (y1 - y0) * (i / RINGS) * 0.999 + 0.001;
      P.push([]);
      for (let j = 0; j < SPOKES; j++) {
        const ph = (j / SPOKES) * Math.PI * 2, dx = Math.cos(ph), dz = Math.sin(ph);
        const r = surfaceAlong(o, o.x, y, o.z, dx, 0, dz, far);
        P[i].push([o.x + dx * r, y, o.z + dz * r]);
      }
    }
    for (let i = 0; i <= RINGS; i++) for (let j = 0; j < SPOKES; j++) {
      pts.push(...P[i][j], ...P[i][(j + 1) % SPOKES]);
      if (i < RINGS) pts.push(...P[i][j], ...P[i + 1][j]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

export interface HitboxFrame {
  pos: THREE.Vector3; dir: THREE.Vector3;
  /** other birds: AI and online players */
  others: { pos: THREE.Vector3; alive: boolean; remote?: string | null }[];
  /** obstacles that aren't in the world grid (endless mode's gates) */
  extra: Obstacle[];
  firstPerson: boolean;
  crashed: boolean;
  camera: THREE.Camera;
}

/** Debug view of every collision shape near you: H toggles it in flight, or open the page with ?hitboxes. */
export class HitboxView {
  on = false;
  /** H only works when this says so (not while typing a name on the title menu) */
  keyOk = () => true;
  private root = new THREE.Group();
  private shapes = new Map<string, { g: THREE.Group; o: Obstacle; seen: number }>();
  private queue: Obstacle[] = [];
  private scanT = 0;
  private me = new THREE.Group();
  private foes: THREE.Group[] = [];
  private ground: THREE.Group;
  private groundGeo = new THREE.BufferGeometry();
  private groundT = 0;
  private cave: THREE.Group;
  private caveGeo = new THREE.BufferGeometry();
  private sweep: THREE.Group;
  private sweepGeo = new THREE.BufferGeometry();
  private hud = document.createElement('div');
  private hit: string | null = null;
  private crashNote = '';
  private wasCrashed = false;
  private near: Obstacle[] = [];
  private frame = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
    this.me.add(ballAt(ME, ME_HID, BIRD_CRASH_R), ballAt(SHOT, SHOT_HID, PLAYER_HIT_R));
    this.ground = lines(this.groundGeo, GROUND, GROUND_HID, 15);
    this.cave = lines(this.caveGeo, CAVE, CAVE_HID, 16);
    this.sweep = lines(this.sweepGeo, ME, ME_HID, 31);
    this.root.add(this.me, this.ground, this.cave, this.sweep);
    Object.assign(this.hud.style, {
      position: 'fixed', left: '10px', top: '38%', zIndex: '50', pointerEvents: 'none', font: '12px/1.45 ui-monospace, Menlo, monospace',
      color: '#fff', background: 'rgba(0,0,0,.55)', padding: '8px 10px', borderRadius: '8px', maxWidth: '300px', whiteSpace: 'pre-wrap',
    } as CSSStyleDeclaration);
    document.body.appendChild(this.hud);
    let saved = false;
    try { saved = localStorage.getItem('glide.hitboxes') === '1'; } catch { /* private mode */ }
    const q = new URLSearchParams(location.search);
    this.set(q.has('hitboxes') ? q.get('hitboxes') !== '0' : saved);
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyH' || e.repeat || e.metaKey || e.ctrlKey || !this.keyOk()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      this.set(!this.on);
    });
  }

  set(on: boolean) {
    this.on = on;
    this.root.visible = on;
    this.hud.style.display = on ? '' : 'none';
    try { localStorage.setItem('glide.hitboxes', on ? '1' : '0'); } catch { /* private mode */ }
  }

  /** Hide it all for now (eg on the title menu) without switching it off. */
  show(now: boolean) {
    this.root.visible = this.on && now;
    this.hud.style.display = this.on && now ? '' : 'none';
  }

  update(dt: number, f: HitboxFrame) {
    if (!this.on) return;
    this.frame++;
    const p = f.pos;

    // ---- obstacles: find what's near, trace new ones a few a frame, drop ones left behind
    if ((this.scanT -= dt) <= 0) {
      this.scanT = 0.3;
      const list = [...obstaclesNear(p.x, p.z, OBS_RANGE, []), ...f.extra];
      list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      this.queue = [];
      for (const o of list.slice(0, MAX_SHAPES)) {
        const s = this.shapes.get(o.id);
        if (s) s.seen = this.frame; else this.queue.push(o);
      }
      for (const [id, s] of this.shapes) if (this.frame - s.seen > 40) this.drop(id);
    }
    for (let n = 0; n < BUILD_PER_FRAME && this.queue.length; n++) {
      const o = this.queue.shift()!;
      if (this.shapes.has(o.id)) continue;
      const g = lines(traceObstacle(o), o.soft ? GROUND : OBS, o.soft ? GROUND_HID : OBS_HID);
      this.root.add(g);
      this.shapes.set(o.id, { g, o, seen: this.frame });
    }

    // ---- nearest gaps (what the crash check sees this frame)
    let best = Infinity, bestO: Obstacle | null = null;
    for (const o of [...obstaclesNear(p.x, p.z, 14, this.near), ...f.extra]) {
      if (o.soft) continue;
      const g = obstacleGap(o, p.x, p.y, p.z) - BIRD_CRASH_R;
      if (g < best) { best = g; bestO = o; }
    }
    const groundGap = (getCourse() ? solidClearance(p.x, p.y, p.z) : p.y - floorBelow(p.x, p.y, p.z)) - GROUND_CRASH_GAP;
    if (f.crashed && !this.wasCrashed) {
      // what you hit: whichever was closest at the moment of the crash
      if (bestO && best < 0.3 && best <= groundGap) { this.hit = bestO.id; this.crashNote = `Hit ${label(bestO)} (gap ${best.toFixed(2)} m)`; }
      else this.crashNote = groundGap < 0.3 ? `Hit the ground (gap ${groundGap.toFixed(2)} m)` : 'Shot down (no contact)';
      for (const [id, s] of this.shapes) s.g.children.forEach((c, i) => ((c as THREE.LineSegments).material = id === this.hit ? (i ? HIT_HID : HIT) : s.o.soft ? (i ? GROUND_HID : GROUND) : (i ? OBS_HID : OBS)));
    } else if (!f.crashed && this.wasCrashed) {
      this.hit = null; this.crashNote = '';
      for (const s of this.shapes.values()) s.g.children.forEach((c, i) => ((c as THREE.LineSegments).material = s.o.soft ? (i ? GROUND_HID : GROUND) : (i ? OBS_HID : OBS)));
    }
    this.wasCrashed = f.crashed;

    // ---- your bird: crash ball (0.5 m) and the ball shots have to hit (1.6 m), plus where it's headed
    this.me.position.copy(p);
    this.sweep.visible = !f.crashed;
    if (!f.crashed) this.traceSweep(p, f.dir);

    // ---- other birds
    while (this.foes.length < f.others.length) {
      const g = new THREE.Group();
      g.add(ballAt(FOE, FOE_HID, ENEMY_CRASH_R), ballAt(SHOT, SHOT_HID, ENEMY_HIT_R));
      this.root.add(g); this.foes.push(g);
    }
    this.foes.forEach((g, i) => {
      const e = f.others[i];
      g.visible = !!e && e.alive;
      if (e) g.position.copy(e.pos);
    });

    // ---- the ground you collide with (a grid laid over it) and, on a course, the cave walls around you
    if ((this.groundT -= dt) <= 0 && !isSpace()) { this.groundT = 0.12; this.traceGround(p); }
    this.ground.visible = !isSpace();
    this.cave.visible = !!getCourse() && !f.crashed;
    if (this.cave.visible) this.traceCave(p, f.dir);

    const view = f.firstPerson
      ? 'First person: your eye is 0.6 m ahead of and\n0.3 m above the hitbox centre (same hitbox)'
      : 'Chase cam: the hitbox is the bird\'s body;\nthe wings don\'t collide';
    const gap = (v: number) => (v === Infinity ? '—' : `${v.toFixed(1)} m`);
    this.hud.textContent = `HITBOXES  (H to hide)\n${view}\n`
      + `nearest ${bestO ? label(bestO) : 'obstacle'}: ${gap(best)}\nground: ${gap(groundGap)}\n`
      + `yellow = you (crash ${BIRD_CRASH_R} m), orange = shot hit ${PLAYER_HIT_R} m\nred = obstacles · cyan = ground`
      + (getCourse() ? ' · violet = cave walls' : '')
      + (this.crashNote ? `\n\n${this.crashNote}` : '');
  }

  private drop(id: string) {
    const s = this.shapes.get(id)!;
    this.root.remove(s.g);
    (s.g.children[0] as THREE.LineSegments).geometry.dispose();
    this.shapes.delete(id);
  }

  /** Rings of your crash radius along your heading: the tube your body sweeps through. */
  private traceSweep(p: THREE.Vector3, dir: THREE.Vector3) {
    const pts: number[] = [];
    const r = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) > 0.95 ? X : Y).normalize();
    const u = new THREE.Vector3().crossVectors(r, dir).normalize();
    const N = 20;
    for (const d of [4, 8, 12, 16, 20]) {
      const c = p.clone().addScaledVector(dir, d);
      for (let i = 0; i < N; i++) {
        for (const k of [i, i + 1]) {
          const a = (k / N) * Math.PI * 2;
          pts.push(c.x + (r.x * Math.cos(a) + u.x * Math.sin(a)) * BIRD_CRASH_R, c.y + (r.y * Math.cos(a) + u.y * Math.sin(a)) * BIRD_CRASH_R, c.z + (r.z * Math.cos(a) + u.z * Math.sin(a)) * BIRD_CRASH_R);
        }
      }
    }
    setPts(this.sweepGeo, pts);
  }

  private traceGround(p: THREE.Vector3) {
    const pts: number[] = [];
    const S = 2.5, N = 30, x0 = Math.round(p.x / S) * S - (N / 2) * S, z0 = Math.round(p.z / S) * S - (N / 2) * S;
    const H: number[] = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H.push(floorBelow(x0 + i * S, p.y, z0 + j * S) + 0.06);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = x0 + i * S, z = z0 + j * S, h = H[j * (N + 1) + i];
      if (i < N) pts.push(x, h, z, x + S, H[j * (N + 1) + i + 1], z);
      if (j < N) pts.push(x, h, z, x, H[(j + 1) * (N + 1) + i], z + S);
    }
    setPts(this.groundGeo, pts);
  }

  /** Cross-sections of solid rock around your flight line (caves and slot walls on a course). */
  private traceCave(p: THREE.Vector3, dir: THREE.Vector3) {
    const pts: number[] = [];
    const flat = new THREE.Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
    flat.normalize();
    const r = new THREE.Vector3().crossVectors(flat, Y).normalize();
    const N = 28, MAX = 40;
    for (const d of [0, 10, 20, 30]) {
      const c = p.clone().addScaledVector(flat, d);
      if (solidClearance(c.x, c.y, c.z) < 0) continue;
      const ring: number[][] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, ox = r.x * Math.cos(a), oy = Math.sin(a), oz = r.z * Math.cos(a);
        let hit = MAX;
        for (let s = 0.75; s <= MAX; s += 0.75) {
          if (solidClearance(c.x + ox * s, c.y + oy * s, c.z + oz * s) < 0) {
            let lo = s - 0.75, hi = s;
            for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (solidClearance(c.x + ox * m, c.y + oy * m, c.z + oz * m) < 0) hi = m; else lo = m; }
            hit = hi; break;
          }
        }
        ring.push([c.x + ox * hit, c.y + oy * hit, c.z + oz * hit, hit < MAX ? 1 : 0]);
      }
      for (let i = 0; i < N; i++) {
        const a = ring[i], b = ring[(i + 1) % N];
        if (a[3] && b[3]) pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    setPts(this.caveGeo, pts);
  }
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
function setPts(g: THREE.BufferGeometry, pts: number[]) {
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeBoundingSphere();
}
function label(o: Obstacle): string {
  if (o.type === 'tree') return o.kind === 'cactus' ? 'cactus' : 'tree';
  if (o.type === 'spire') return 'pillar';
  if (o.type === 'box') return 'hull';
  return 'rock';
}
