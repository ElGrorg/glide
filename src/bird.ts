import * as THREE from 'three';


function tri(pts: number[][], color: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide }));
}

/** Low-poly bird mesh. Faces -Z. Roughly 1.8 m long, 5 m wingspan. */
export class BirdMesh extends THREE.Group {
  lInner = new THREE.Group(); lOuter = new THREE.Group();
  rInner = new THREE.Group(); rOuter = new THREE.Group();
  tail: THREE.Mesh;
  constructor() {
    super();
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xd9733a, flatShading: true });
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xf2d7b0, flatShading: true });
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 1), bodyMat);
    body.scale.set(0.75, 0.6, 1.9);
    const belly = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 1), bellyMat);
    belly.scale.set(0.7, 0.5, 1.6); belly.position.set(0, -0.08, -0.05);
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 1), bodyMat);
    head.position.set(0, 0.12, -0.9);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.35, 4), new THREE.MeshLambertMaterial({ color: 0xf2b630, flatShading: true }));
    beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.08, -1.25);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), eyeMat);
      eye.position.set(0.17 * s, 0.2, -1.02); this.add(eye);
    }
    this.add(body, belly, head, beak);

    const wingC = 0xb85a2b, tipC = 0x5b3a26;
    // inner wing: from body edge out to 1.2 m
    const inner = (s: number) => tri([
      [0, 0, -0.35], [1.25 * s, 0.05, -0.2], [1.25 * s, 0.05, 0.45],
      [0, 0, -0.35], [1.25 * s, 0.05, 0.45], [0, 0, 0.5],
    ], wingC);
    // outer wing with a pointed tip and feathered trailing edge
    const outer = (s: number) => tri([
      [0, 0, -0.2], [1.3 * s, 0.1, 0.05], [0, 0, 0.45],
      [1.3 * s, 0.1, 0.05], [1.05 * s, 0.05, 0.5], [0, 0, 0.45],
      [1.3 * s, 0.1, 0.05], [1.45 * s, 0.12, 0.4], [1.05 * s, 0.05, 0.5],
    ], tipC);
    this.lInner.add(inner(-1)); this.lInner.position.set(-0.3, 0.05, 0);
    this.rInner.add(inner(1)); this.rInner.position.set(0.3, 0.05, 0);
    this.lOuter.add(outer(-1)); this.lOuter.position.set(-1.25, 0.05, 0);
    this.rOuter.add(outer(1)); this.rOuter.position.set(1.25, 0.05, 0);
    this.lInner.add(this.lOuter); this.rInner.add(this.rOuter);
    this.add(this.lInner, this.rInner);

    this.tail = tri([
      [0, 0, 0.7], [-0.45, 0, 1.45], [0, 0.02, 1.3],
      [0, 0, 0.7], [0, 0.02, 1.3], [0.45, 0, 1.45],
    ], tipC);
    this.add(this.tail);
  }

  /** Wing pose: brake cups the wings, tuck folds them back, flap beats them once. */
  animate(t: number, brake: number, speed: number, tuck = 0, flap = 0) {
    const flutter = Math.sin(t * 9) * 0.015 * (speed / 30) * (1 - tuck);
    const beat = flap > 0 ? Math.sin((1 - flap) * Math.PI * 2) * 0.9 : 0;
    const dihedral = 0.08 + brake * 0.35 + flutter + beat - tuck * 0.15;
    const tip = 0.06 + brake * 0.4 - flutter + beat * 0.6;
    this.lInner.rotation.z = -dihedral; this.rInner.rotation.z = dihedral;
    this.lOuter.rotation.z = -tip; this.rOuter.rotation.z = tip;
    // braking sweeps wings forward, tucking folds them back along the body
    const sweep = brake * 0.25 - tuck * 1.1;
    this.lInner.rotation.y = sweep; this.rInner.rotation.y = -sweep;
    this.lOuter.rotation.y = -tuck * 1.6; this.rOuter.rotation.y = tuck * 1.6;
    this.tail.rotation.x = brake * 0.5 - tuck * 0.2;
  }
}

const TAU = Math.PI * 2;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3();

export interface FlightInput {
  pitch: number; roll: number; yaw: number; tuck: number; brake: number;
  flap: boolean; trick: 'rollL' | 'rollR' | null;
}
export interface FlightEvents { loop?: 1 | -1; roll?: boolean; snap?: boolean; flap?: boolean }

/**
 * Free 3D glider. The stick rotates the bird (pitch, roll, yaw) and the air does the rest:
 * velocity is pulled toward where the nose points (lift), gravity trades height for speed,
 * every turn bleeds a little speed, and the nose weathervanes into the airflow.
 * Roll over and pull to carve a hard turn; tuck to drop like a stone; flare to brake.
 */
export class Glider {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  q = new THREE.Quaternion();
  dir = new THREE.Vector3(0, 0, -1); // nose
  up = new THREE.Vector3(0, 1, 0);
  right = new THREE.Vector3(1, 0, 0);
  brake = 0;
  tuck = 0;
  flapCharge = 3;
  flapAnim = 0;
  private snap: { t: number; dir: number } | null = null;
  private snapCool = 0;
  private pitchAcc = 0; private rollAcc = 0; private idle = 0;

  get speed() { return this.vel.length(); }
  set speed(s: number) { this.vel.setLength(Math.max(1, s)); }
  get heading() { return Math.atan2(-this.dir.x, -this.dir.z); }
  get pitch() { return Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1)); }
  /** Bank angle, + right wing down. */
  get roll() { return Math.asin(THREE.MathUtils.clamp(-this.right.y, -1, 1)); }
  get inverted() { return this.up.y < 0; }
  get snapping() { return this.snap !== null; }
  /** Half wingspan right now (tucked wings are narrow). */
  get halfSpan() { return THREE.MathUtils.lerp(2.4, 0.8, this.tuck); }

  reset(x: number, y: number, z: number, heading = 0) {
    this.pos.set(x, y, z);
    this.q.setFromEuler(new THREE.Euler(-0.15, heading, 0, 'YXZ'));
    this.updateAxes();
    this.vel.copy(this.dir).multiplyScalar(32);
    this.brake = 0; this.tuck = 0; this.flapCharge = 3; this.flapAnim = 0;
    this.snap = null; this.snapCool = 0; this.pitchAcc = 0; this.rollAcc = 0; this.idle = 0;
  }

  private updateAxes() {
    this.dir.copy(Z).applyQuaternion(this.q).negate();
    this.up.copy(Y).applyQuaternion(this.q);
    this.right.copy(X).applyQuaternion(this.q);
  }

  private rotLocal(axis: THREE.Vector3, angle: number) {
    if (angle) this.q.multiply(_q.setFromAxisAngle(axis, angle));
  }

  step(dt: number, inp: FlightInput): FlightEvents {
    const ev: FlightEvents = {};
    let speed = this.vel.length();
    const ctrl = THREE.MathUtils.clamp(speed / 18, 0.35, 1.25); // less authority when slow
    this.brake += (inp.brake - this.brake) * Math.min(1, 8 * dt);
    this.tuck += (inp.tuck - this.tuck) * Math.min(1, 7 * dt);
    this.snapCool -= dt;
    this.flapCharge = Math.min(3, this.flapCharge + dt * 0.22);
    this.flapAnim = Math.max(0, this.flapAnim - dt / 0.4);

    // ---- attitude: the stick rotates the bird ----
    const pitchRate = inp.pitch * (1.7 + 0.8 * this.brake) * ctrl;
    // roll: partial stick banks to a held angle (up to ~80 deg); full stick rolls freely
    const bank0 = this.roll;
    let rollRate: number;
    if (this.inverted || Math.abs(inp.roll) > 0.95) rollRate = inp.roll * 3.2 * ctrl;
    else rollRate = THREE.MathUtils.clamp((inp.roll * 1.45 - bank0) * 4, -3.2, 3.2) * ctrl;
    const yawRate = inp.yaw * 1.1 * ctrl;
    const active = Math.abs(inp.pitch) + Math.abs(inp.roll) + Math.abs(inp.yaw) > 0.08;
    this.idle = active ? 0 : this.idle + dt;
    const bank = bank0;
    // hands off while upside down for a moment: roll back upright
    if (!this.snap && Math.abs(inp.roll) < 0.05 && this.inverted && this.idle > 0.7) rollRate += (bank >= 0 ? 1 : -1) * 2.2;
    if (inp.trick && !this.snap && this.snapCool <= 0) {
      // snap roll: a fast 360 that throws you sideways, for dodging
      const d = inp.trick === 'rollL' ? -1 : 1;
      this.snap = { t: 0, dir: d };
      _v.set(this.right.x, 0, this.right.z).normalize();
      this.vel.addScaledVector(_v, d * 11);
    }
    let snapRate = 0;
    if (this.snap) {
      this.snap.t += dt;
      const f = this.snap.t / 0.5;
      snapRate = this.snap.dir * (TAU / 0.5) * (f < 1 ? 1 : 0);
      if (f >= 1) { this.snap = null; this.snapCool = 0.35; ev.snap = true; }
    }
    // hands off the pitch: trim gently back to a steady glide down the slope
    let trim = 0;
    if (Math.abs(inp.pitch) < 0.05 && !this.inverted && Math.abs(this.pitch) < 1.2 && !this.snap) trim = (-0.27 - this.pitch) * 0.9 * Math.cos(bank0);
    this.rotLocal(X, (pitchRate + trim) * dt);
    this.rotLocal(Z, -(rollRate + snapRate) * dt);
    this.rotLocal(Y, -yawRate * dt);
    // banking turns you on its own (gentle, so steering is easy), pulling tightens it
    if (!this.inverted && !this.snap) {
      const b = THREE.MathUtils.clamp(bank, -1.2, 1.2);
      const turn = -(9.8 * Math.tan(b) / Math.max(speed, 12)) * 0.9 * (1 - this.tuck * 0.7);
      this.q.premultiply(_q.setFromAxisAngle(WORLD_UP, turn * dt));
    }
    this.q.normalize();
    this.updateAxes();

    // trick tracking: a full turn of the stick-driven pitch or roll is a loop or roll
    this.pitchAcc += pitchRate * dt;
    this.rollAcc += (Math.abs(inp.roll) > 0.95 || this.inverted ? rollRate : 0) * dt;
    if (Math.abs(inp.pitch) < 0.1) this.pitchAcc *= Math.exp(-1.2 * dt);
    if (Math.abs(inp.roll) < 0.1) this.rollAcc *= Math.exp(-1.2 * dt);
    if (Math.abs(this.pitchAcc) > TAU * 0.92) { ev.loop = this.pitchAcc > 0 ? 1 : -1; this.pitchAcc = 0; }
    if (Math.abs(this.rollAcc) > TAU * 0.92) { ev.roll = true; this.rollAcc = 0; }

    // ---- flap: a limited burst of thrust ----
    if (inp.flap && this.flapCharge >= 1) {
      this.flapCharge -= 1; this.flapAnim = 1; ev.flap = true;
      this.vel.addScaledVector(this.dir, 6).addScaledVector(this.up, 5);
    }

    // ---- air ----
    this.vel.y -= 9.8 * dt;
    speed = this.vel.length();
    const vd = _v.copy(this.vel).divideScalar(speed);
    const aoa = vd.angleTo(this.dir);
    const spread = 1 - this.tuck;
    const lift = Math.max(0.12, spread) * (1 + 0.7 * this.brake);
    const stall = aoa < 0.5 ? 1 : Math.max(0, 1 - (aoa - 0.5) * 2.2);
    const align = THREE.MathUtils.clamp(speed / 22, 0.25, 1.4) * 2.3 * lift * stall;
    const turn = Math.min(aoa, align * dt);
    if (turn > 1e-6) {
      _a.crossVectors(vd, this.dir);
      if (_a.lengthSq() > 1e-10) vd.applyAxisAngle(_a.normalize(), turn);
    }
    speed -= turn * speed * 0.1 * (1 + this.brake); // turning costs speed
    const cd = 0.0018 * spread + 0.00035 + 0.0055 * this.brake;
    speed -= cd * speed * speed * dt;
    speed = THREE.MathUtils.clamp(speed, 3, 115);
    this.vel.copy(vd).multiplyScalar(speed);

    // nose weathervanes into the airflow: strongly when tucked or stalled
    const vane = (1.0 + this.tuck * 3 + (1 - stall) * 3) * dt;
    if (aoa > 1e-4) {
      _a.crossVectors(this.dir, vd);
      if (_a.lengthSq() > 1e-10) {
        _a.normalize();
        this.q.premultiply(_q.setFromAxisAngle(_a, Math.min(aoa, aoa * vane)));
        this.q.normalize(); this.updateAxes();
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    return ev;
  }

  /** Wingtip positions (for collisions). */
  tips(out: [THREE.Vector3, THREE.Vector3]) {
    const h = this.halfSpan;
    out[0].copy(this.pos).addScaledVector(this.right, -h);
    out[1].copy(this.pos).addScaledVector(this.right, h);
    return out;
  }

  applyTo(obj: THREE.Object3D) {
    obj.position.copy(this.pos);
    obj.quaternion.copy(this.q);
  }
}
