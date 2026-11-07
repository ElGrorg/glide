import * as THREE from 'three';

/**
 * Down cam: a rolling recording of the last few seconds of everything that moves (birds, peas, darts,
 * cloud puffs), played back from the killer's chase camera when you get shot down.
 *
 * It only records what is drawn (mesh transforms), never game state, so the live game keeps running
 * underneath while the replay is shown: before each render the recorded pose is put on the meshes,
 * and straight after the render the live pose is put back.
 */

const SHOW = 4.0;        // seconds shown before the hit
const AFTER = 3.0;       // ...and after it (it keeps recording while the replay plays, so you see yourself fall)
const KEEP = SHOW + 0.4; // seconds of history kept
const SLOW_BEFORE = 0.5; // the moment of the hit plays in slow motion...
const SLOW_AFTER = 0.35;
const SLOW_RATE = 0.35;  // ...at this speed
const HOLD = 0.4;        // then the final frame holds for a beat
const MIN_STEP = 1 / 40; // record at most 40 times a second (keeps memory down on fast screens)
const FLOATS = 10;       // per node: position xyz, quaternion xyzw, scale xyz

interface Frame {
  t: number;
  roots: THREE.Object3D[];
  offsets: Map<THREE.Object3D, number>;
  data: Float32Array;
  puffs: Float32Array | null;
}

/** Every node under a root whose transform can change (a bird's wings and tail flap, a dart spins). */
const nodeCache = new WeakMap<THREE.Object3D, THREE.Object3D[]>();
function nodesOf(root: THREE.Object3D) {
  let n = nodeCache.get(root);
  if (!n) { n = []; root.traverse((o) => n!.push(o)); nodeCache.set(root, n); }
  return n;
}

function writeNodes(root: THREE.Object3D, out: Float32Array, at: number) {
  for (const o of nodesOf(root)) {
    out[at++] = o.position.x; out[at++] = o.position.y; out[at++] = o.position.z;
    out[at++] = o.quaternion.x; out[at++] = o.quaternion.y; out[at++] = o.quaternion.z; out[at++] = o.quaternion.w;
    out[at++] = o.scale.x; out[at++] = o.scale.y; out[at++] = o.scale.z;
  }
  return at;
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
function readNodes(root: THREE.Object3D, a: Float32Array, ia: number, b: Float32Array | null, ib: number, k: number) {
  for (const o of nodesOf(root)) {
    if (b) {
      o.position.set(a[ia] + (b[ib] - a[ia]) * k, a[ia + 1] + (b[ib + 1] - a[ia + 1]) * k, a[ia + 2] + (b[ib + 2] - a[ia + 2]) * k);
      qa.set(a[ia + 3], a[ia + 4], a[ia + 5], a[ia + 6]); qb.set(b[ib + 3], b[ib + 4], b[ib + 5], b[ib + 6]);
      o.quaternion.slerpQuaternions(qa, qb, k);
      o.scale.set(a[ia + 7] + (b[ib + 7] - a[ia + 7]) * k, a[ia + 8] + (b[ib + 8] - a[ia + 8]) * k, a[ia + 9] + (b[ib + 9] - a[ia + 9]) * k);
      ib += FLOATS;
    } else {
      o.position.set(a[ia], a[ia + 1], a[ia + 2]);
      o.quaternion.set(a[ia + 3], a[ia + 4], a[ia + 5], a[ia + 6]);
      o.scale.set(a[ia + 7], a[ia + 8], a[ia + 9]);
    }
    ia += FLOATS;
  }
}

export interface Tracked {
  /** Your bird plus every other bird (AI and other players). */
  birds: THREE.Object3D[];
  /** Peas and darts in flight (yours and theirs). */
  shots: THREE.Object3D[];
  /** Anything else worth replaying (your shadow). */
  extra: THREE.Object3D[];
  /** The cloud-puff particles (smoke trails, bursts). */
  puffs: THREE.InstancedMesh | null;
}

export class DownCam {
  private frames: Frame[] = [];
  private spare: Float32Array[] = []; // recycled puff buffers
  /** Who fired each shot: the bird nearest to where it first appeared. */
  private shooter = new WeakMap<THREE.Object3D, THREE.Object3D | null>();
  private lastShots = new Set<THREE.Object3D>();

  playing = false;
  /** Seconds of real time since the replay started. */
  elapsed = 0;
  duration = 0;
  /** The bird whose view we watch from (null = your own bird, for a plain crash). */
  viewer: THREE.Object3D | null = null;
  me: THREE.Object3D | null = null;
  private t0 = 0;
  private tHit = 0;
  private t1 = 0;

  // live state saved around each replayed render
  private saved: { o: THREE.Object3D; data: Float32Array; visible: boolean; detached: boolean }[] = [];
  private savedPuffs: Float32Array | null = null;

  // replay camera (smoothed)
  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3(0, 1, 0);
  private camInit = false;

  clear() { this.frames.length = 0; this.lastShots.clear(); this.playing = false; }

  /** Record one frame (call once per frame, after the meshes have been placed). */
  record(t: number, tr: Tracked) {
    // while the replay plays, keep recording up to a second after the hit (and keep what it's showing)
    if (this.playing && t > this.t1 + MIN_STEP) return;
    if (this.frames.length && t - this.frames[this.frames.length - 1].t < MIN_STEP) return;
    // drop old frames, keeping their puff buffers for reuse
    const before = this.playing ? this.t0 : t - KEEP;
    while (this.frames.length > 2 && this.frames[1].t < before) {
      const old = this.frames.shift()!;
      if (old.puffs) this.spare.push(old.puffs);
    }
    const roots: THREE.Object3D[] = [];
    const add = (o: THREE.Object3D) => { if (o.visible && o.parent) roots.push(o); };
    for (const o of tr.birds) add(o);
    const nowShots = new Set<THREE.Object3D>();
    for (const o of tr.shots) {
      if (!o.visible || !o.parent) continue;
      roots.push(o); nowShots.add(o);
      if (!this.lastShots.has(o)) this.shooter.set(o, nearest(o.position, tr.birds, 25));
    }
    this.lastShots = nowShots;
    for (const o of tr.extra) add(o);

    let size = 0;
    for (const r of roots) size += nodesOf(r).length * FLOATS;
    const data = new Float32Array(size);
    const offsets = new Map<THREE.Object3D, number>();
    let at = 0;
    for (const r of roots) { offsets.set(r, at); at = writeNodes(r, data, at); }

    let puffs: Float32Array | null = null;
    if (tr.puffs) {
      const src = tr.puffs.instanceMatrix.array as Float32Array;
      puffs = this.spare.pop() ?? new Float32Array(src.length);
      if (puffs.length !== src.length) puffs = new Float32Array(src.length);
      puffs.set(src);
    }
    this.frames.push({ t, roots, offsets, data, puffs });
  }

  /** Has enough been recorded to be worth a replay? */
  get ready() { return this.frames.length > 10; }

  /**
   * Who shot you: the owner of the shot that was closest to you in the last few frames. Returns null
   * if nothing was near (a crash), or if it was your own shot.
   */
  findShooter(me: THREE.Object3D): THREE.Object3D | null {
    let best: THREE.Object3D | null = null, bestD = 18;
    for (let i = this.frames.length - 1; i >= Math.max(0, this.frames.length - 5); i--) {
      const f = this.frames[i];
      const mo = f.offsets.get(me);
      if (mo === undefined) continue;
      const mp = new THREE.Vector3(f.data[mo], f.data[mo + 1], f.data[mo + 2]);
      for (const r of f.roots) {
        const by = this.shooter.get(r);
        if (by === undefined || by === me) continue;
        const o = f.offsets.get(r)!;
        const d = mp.distanceTo(new THREE.Vector3(f.data[o], f.data[o + 1], f.data[o + 2]));
        if (d < bestD && by) { bestD = d; best = by; }
      }
    }
    return best;
  }

  /** Start playing back the last few seconds, watched from `viewer` (or from behind `me` if null). */
  start(me: THREE.Object3D, viewer: THREE.Object3D | null, show = SHOW) {
    if (!this.ready) return false;
    this.me = me; this.viewer = viewer;
    this.tHit = this.frames[this.frames.length - 1].t;
    this.t0 = Math.max(this.frames[0].t, this.tHit - show);
    this.t1 = this.tHit + AFTER;
    const [fast1, slow, fast2] = this.spans();
    this.duration = fast1 + slow / SLOW_RATE + fast2 + HOLD;
    this.elapsed = 0; this.playing = true; this.camInit = false;
    return true;
  }

  stop() { this.playing = false; }

  /** 0..1 progress through the replay. */
  get progress() { return this.duration ? Math.min(1, this.elapsed / this.duration) : 1; }

    /** Recorded seconds before the slow motion, in it, and after it. */
  private spans(): [number, number, number] {
    const fast1 = Math.max(0, this.tHit - SLOW_BEFORE - this.t0);
    const slow = Math.min(SLOW_BEFORE, this.tHit - this.t0) + SLOW_AFTER;
    return [fast1, slow, this.t1 - this.tHit - SLOW_AFTER];
  }

  /** Recorded time for the current replay position: real speed, slow motion around the hit, real speed, then a hold. */
  private replayTime() {
    const [fast1, slow, fast2] = this.spans();
    let e = this.elapsed, tt: number;
    if (e < fast1) tt = this.t0 + e;
    else if ((e -= fast1) < slow / SLOW_RATE) tt = this.t0 + fast1 + e * SLOW_RATE;
    else tt = this.t0 + fast1 + slow + Math.min(fast2, e - slow / SLOW_RATE);
    // never ahead of what has been recorded so far
    return Math.min(tt, this.frames[this.frames.length - 1].t);
  }

  /** Advance the replay clock (real seconds). Returns false once it has finished. */
  advance(dt: number) {
    if (!this.playing) return false;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) { this.playing = false; return false; }
    return true;
  }

  /**
   * Put the recorded pose on every mesh and aim the camera from the viewer's chase position.
   * `live` = everything currently in play (hidden for the replay). Call `restore()` after rendering.
   */
  apply(scene: THREE.Scene, camera: THREE.PerspectiveCamera, tr: Tracked, dt: number, groundAt: (x: number, z: number) => number) {
    if (!this.playing || !this.frames.length) return;
    const tt = this.replayTime();
    let i = 0;
    while (i < this.frames.length - 2 && this.frames[i + 1].t <= tt) i++;
    const A = this.frames[i], B = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const k = B.t > A.t ? THREE.MathUtils.clamp((tt - A.t) / (B.t - A.t), 0, 1) : 0;

    const save = (o: THREE.Object3D) => {
      const n = nodesOf(o).length * FLOATS;
      const data = new Float32Array(n);
      writeNodes(o, data, 0);
      this.saved.push({ o, data, visible: o.visible, detached: !o.parent });
    };
    const touched = new Set<THREE.Object3D>();
    // everything live goes out of sight unless it was there at this moment of the replay
    for (const list of [tr.birds, tr.shots, tr.extra]) for (const o of list) {
      if (!o.visible || touched.has(o)) continue; // (hidden ones stay hidden and untouched)
      touched.add(o); save(o); o.visible = false;
    }
    for (const r of A.roots) {
      if (!touched.has(r)) { touched.add(r); save(r); }
      if (!r.parent) scene.add(r); // a dart that has since hit, or a bird that has since gone
      const ib = B.offsets.get(r);
      readNodes(r, A.data, A.offsets.get(r)!, ib === undefined ? null : B.data, ib ?? 0, k);
      r.visible = true;
      r.updateMatrixWorld(true);
    }
    if (tr.puffs && A.puffs) {
      const arr = tr.puffs.instanceMatrix.array as Float32Array;
      if (!this.savedPuffs || this.savedPuffs.length !== arr.length) this.savedPuffs = new Float32Array(arr.length);
      this.savedPuffs.set(arr);
      arr.set(A.puffs);
      tr.puffs.instanceMatrix.needsUpdate = true;
    }

    // ---- camera: the viewer's own chase camera (yours from a little off to the side, for a crash)
    const subject = this.viewer && A.offsets.has(this.viewer) ? this.viewer : this.me;
    if (!subject || !A.offsets.has(subject)) return;
    const pos = subject.position, q = subject.quaternion;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const own = subject === this.me;
    // the killer's view leans a little toward you, so you can see yourself in its sights
    const mo = this.me && this.me !== subject ? A.offsets.get(this.me) : undefined;
    if (mo !== undefined) {
      const toMe = new THREE.Vector3(A.data[mo], A.data[mo + 1], A.data[mo + 2]).sub(pos);
      const d = toMe.length();
      if (d > 1 && toMe.dot(fwd) > -0.2 * d) fwd.addScaledVector(toMe.divideScalar(d), 0.55).normalize();
    }
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).multiplyScalar(0.6).add(new THREE.Vector3(0, 0.4, 0));
    if (up.lengthSq() < 1e-4) up.set(0, 1, 0);
    up.normalize();
    const sdt = this.elapsed > this.duration - HOLD ? dt * 0.3 : dt;
    if (!this.camInit) { this.camFwd.copy(fwd); this.camUp.copy(up); }
    else { this.camFwd.lerp(fwd, 1 - Math.exp(-5 * sdt)).normalize(); this.camUp.lerp(up, 1 - Math.exp(-5 * sdt)).normalize(); }
    const side = new THREE.Vector3().crossVectors(this.camFwd, this.camUp).normalize();
    const want = pos.clone().addScaledVector(this.camFwd, own ? -11 : -9).addScaledVector(this.camUp, own ? 3.5 : 2.6);
    if (own) want.addScaledVector(side, 4);
    const ground = groundAt(want.x, want.z) + 1.8;
    if (want.y < ground) want.y = ground;
    if (!this.camInit) this.camPos.copy(want);
    else this.camPos.lerp(want, 1 - Math.exp(-10 * sdt));
    this.camInit = true;
    camera.position.copy(this.camPos);
    camera.up.copy(this.camUp);
    // the killer's view looks where it's flying; your own replay keeps your bird in the middle
    camera.lookAt(own ? pos : pos.clone().addScaledVector(fwd, 12));
    camera.fov += (68 - camera.fov) * Math.min(1, 4 * dt);
    camera.updateProjectionMatrix();
  }

  /** Put the live game back exactly as it was before `apply()`. */
  restore(tr: Tracked) {
    for (let j = this.saved.length - 1; j >= 0; j--) {
      const s = this.saved[j];
      readNodes(s.o, s.data, 0, null, 0, 0);
      s.o.visible = s.visible;
      if (s.detached && s.o.parent) s.o.parent.remove(s.o);
      s.o.updateMatrixWorld(true);
    }
    this.saved.length = 0;
    if (tr.puffs && this.savedPuffs) {
      (tr.puffs.instanceMatrix.array as Float32Array).set(this.savedPuffs);
      tr.puffs.instanceMatrix.needsUpdate = true;
    }
  }
}

function nearest(p: THREE.Vector3, list: THREE.Object3D[], max: number) {
  let best: THREE.Object3D | null = null, bestD = max;
  for (const o of list) {
    if (!o.visible || !o.parent) continue;
    const d = o.position.distanceTo(p);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
