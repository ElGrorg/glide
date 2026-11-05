import * as THREE from 'three';
import type { InputState } from './input';

const G = 9.8;
const DRAG = 0.0016;        // equilibrium glide ~36 m/s at -12°
const BRAKE_DRAG = 0.0065;
const NEUTRAL_PITCH = -0.26; // nose settles slightly down when you let go
const STALL_SPEED = 15;
const TUCK_THRUST = 0;      // tuck removed: no free speed, you only gain it by diving
const MAX_SPEED = 115;
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function tri(pts: number[][], color: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, flatShading: true, side: THREE.DoubleSide }));
}

export interface BirdPalette { body: number; belly: number; wing: number; tip: number }
export const PLAYER_COLORS: BirdPalette = { body: 0xd9733a, belly: 0xf2d7b0, wing: 0xb85a2b, tip: 0x5b3a26 };

/** Low-poly bird mesh. Faces -Z. Roughly 1.8 m long, 5 m wingspan. */
export class BirdMesh extends THREE.Group {
  lInner = new THREE.Group(); lOuter = new THREE.Group();
  rInner = new THREE.Group(); rOuter = new THREE.Group();
  tail: THREE.Mesh;
  constructor(pal: BirdPalette = PLAYER_COLORS) {
    super();
    const bodyMat = new THREE.MeshLambertMaterial({ color: pal.body, flatShading: true });
    const bellyMat = new THREE.MeshLambertMaterial({ color: pal.belly, flatShading: true });
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

    const wingC = pal.wing, tipC = pal.tip;
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

  animate(t: number, brake: number, speed: number, tuck = 0) {
    // gentle flutter that grows with speed, wings cup up when braking, fold back when tucked
    const flutter = Math.sin(t * 9) * 0.015 * (speed / 30) * (1 - tuck);
    const dihedral = 0.08 + brake * 0.35 + flutter - tuck * 0.12;
    const tip = 0.06 + brake * 0.4 - flutter;
    this.lInner.rotation.z = -dihedral; this.rInner.rotation.z = dihedral;
    this.lOuter.rotation.z = -tip; this.rOuter.rotation.z = tip;
    const sweep = brake * 0.25 - tuck * 1.1;
    this.lInner.rotation.y = sweep; this.rInner.rotation.y = -sweep;
    this.lOuter.rotation.y = -tuck * 1.6; this.rOuter.rotation.y = tuck * 1.6;
    this.tail.rotation.x = brake * 0.5 - tuck * 0.2;
  }
}

const TAU = Math.PI * 2;
/** Wrap an angle to (-PI, PI]. */
function wrap(a: number) { return a - TAU * Math.floor((a + Math.PI) / TAU); }

/** Arcade glider: speed and height trade through pitch. Hold pull-up long enough and you loop. */
export class Glider {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  dir = new THREE.Vector3(0, 0, -1);
  speed = 32;
  pitch = NEUTRAL_PITCH; // radians, + nose up, wraps through +-PI when looping
  heading = 0;           // radians, 0 = -Z
  roll = 0;              // radians, + right wing down
  brake = 0;
  tuck = 0;
  trick: { type: 'roll' | 'half'; t: number; dur: number; dir: number; dodge: number } | null = null;
  spin = 0;              // visual barrel-roll angle
  overTop = false;       // passed inverted at the top of a loop
  pitchVel = 0;          // smoothed pitch rate (rad/s): stick moves ease in and out instead of snapping
  rollVel = 0;           // smoothed roll rate (flight layout)
  yawVel = 0;            // smoothed rudder rate
  slip = 0;              // visual yaw from the rudder
  /** Full 3D flight (flight-stick layout): orientation is a quaternion, any roll or pitch angle goes. */
  free = false;
  quat = new THREE.Quaternion();
  /** The bird's own up vector (free mode keeps it exact; classic derives it from pitch + heading). */
  up = new THREE.Vector3(0, 1, 0);
  private loopTurn = 0;  // free mode: accumulated pitch rotation, a loop is a full turn

  /** Nose pointing past vertical (upside down part of a loop). */
  /** 1 = full control; drops toward 0.25 as you slow below stall speed (the wings stop biting). */
  get authority() { return THREE.MathUtils.clamp((this.speed - STALL_SPEED + 4) / 8, 0.25, 1); }
  /** Too slow to fly: the nose drops until you've dived back up to speed. */
  get stalled() { return this.speed < STALL_SPEED; }

  get looping() { return this.free ? this.up.y < 0 : this.overTop || Math.abs(this.pitch) > Math.PI / 2; }

  /** Barrel roll. Rolling while already banking the same way turns it into a big sideways dodge.
   *  Upside down, the roll button does a half roll instead: you come out upright, flying the other way. */
  startTrick(req: 'rollL' | 'rollR', rollInput = 0): boolean {
    if (this.trick) return false;
    const dir = req === 'rollL' ? -1 : 1;
    if (this.looping && !this.free) { // free flight can roll itself upright; the button is always a barrel roll
      if (Math.abs(this.pitch) < 1.9) return false; // only once the nose is past ~110 degrees, near the top
      // same orientation, written the upright way: (p, h, r) == (PI - p, h + PI, r + PI)
      this.pitch = wrap(Math.PI - this.pitch);
      this.heading = wrap(this.heading + Math.PI);
      this.overTop = false;
      this.pitchVel = -this.pitchVel; // same motion, measured the other way round
      this.spin = -dir * Math.PI;
      this.trick = { type: 'half', t: 0, dur: 0.45, dir, dodge: 0 };
      this.updateDir();
      return true;
    }
    const dodge = 6 + 22 * Math.max(0, rollInput * dir);
    this.trick = { type: 'roll', t: 0, dur: 0.7, dir, dodge };
    return true;
  }

  reset(x: number, y: number, z: number, heading = 0) {
    this.pos.set(x, y, z);
    this.speed = 32; this.pitch = NEUTRAL_PITCH; this.heading = heading; this.roll = 0; this.brake = 0;
    this.trick = null; this.spin = 0; this.overTop = false;
    this.pitchVel = 0; this.rollVel = 0; this.yawVel = 0; this.slip = 0;
    this.free = false; this.loopTurn = 0; this.syncQuat();
    this.updateDir();
  }

  private updateDir() {
    const cp = Math.cos(this.pitch);
    this.dir.set(-Math.sin(this.heading) * cp, Math.sin(this.pitch), -Math.cos(this.heading) * cp);
  }

  /** Quaternion from the euler pitch / heading / roll. */
  private syncQuat() {
    this.quat.setFromEuler(new THREE.Euler(this.pitch, this.heading, -this.roll, 'YXZ'));
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
  }

  /** Euler pitch / heading / roll read back from the quaternion (for the HUD, camera, enemies, classic mode). */
  private syncEuler() {
    const f = _v1.set(0, 0, -1).applyQuaternion(this.quat);
    const r = _v2.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    if (Math.hypot(f.x, f.z) > 1e-3) this.heading = Math.atan2(-f.x, -f.z);
    this.roll = Math.atan2(-r.y, this.up.y);
    this.dir.copy(f);
  }

  /** Nudge the flight path toward `want` (wind tunnels), by fraction k. */
  steerToward(want: THREE.Vector3, k: number) {
    if (!this.free) { this.pitch += (Math.asin(THREE.MathUtils.clamp(want.y, -1, 1)) - this.pitch) * k; return; }
    _q.setFromUnitVectors(this.dir, _v3.copy(want).normalize());
    this.quat.premultiply(new THREE.Quaternion().slerp(_q, k)).normalize();
    this.syncEuler();
  }

  /** Advance the flight model. Returns a trick that just finished, if any. */
  step(dt: number, inp: InputState): 'roll' | 'loop' | 'half' | null {
    // switching layouts mid-flight carries the orientation across
    if (inp.rollRate && !this.free) {
      if (Math.abs(this.pitch) > Math.PI / 2) { this.pitch = wrap(Math.PI - this.pitch); this.heading = wrap(this.heading + Math.PI); this.roll += Math.PI; }
      this.syncQuat(); this.free = true; this.overTop = false; this.loopTurn = 0;
    } else if (!inp.rollRate && this.free) {
      this.free = false; this.overTop = false;
      if (this.up.y < 0) this.roll = wrap(this.roll); // classic eases the bank back to the stick
      this.roll = THREE.MathUtils.clamp(this.roll, -1.2, 1.2);
    }
    if (this.free) return this.stepFree(dt, inp);
    let finished: 'roll' | 'loop' | 'half' | null = null;
    const tr = this.trick;
    if (tr) {
      tr.t += dt;
      const f = Math.min(1, tr.t / tr.dur);
      const e = f * f * (3 - 2 * f);
      if (tr.type === 'half') {
        this.spin = -tr.dir * Math.PI * (1 - e);
        if (f >= 1) { finished = 'half'; this.trick = null; this.spin = 0; }
      } else {
      this.spin = tr.dir * e * TAU;
      // a barrel roll also jinks you sideways a little
      const side = Math.sin(f * Math.PI) * tr.dir * tr.dodge * dt;
      this.pos.x += Math.cos(this.heading) * side;
      this.pos.z -= Math.sin(this.heading) * side;
      if (f >= 1) { finished = 'roll'; this.trick = null; this.spin = 0; }
      }
    }

    const upright = Math.abs(this.pitch) <= Math.PI / 2 && !this.overTop;
    // roll, upside down too, so you can steer all the way round a loop
    if (inp.rollRate) {
      // flight sim: the stick rolls the bird and the bank holds when you let go (easing back very gently)
      this.rollVel += (inp.roll * 1.9 - this.rollVel) * Math.min(1, 6 * dt);
      this.roll += this.rollVel * dt;
      if (Math.abs(inp.roll) < 0.05) this.roll -= this.roll * 0.25 * dt;
      this.roll = THREE.MathUtils.clamp(this.roll, -1.25, 1.25);
    } else {
      // classic: the stick sets the bank, eased so it doesn't snap
      this.roll += (inp.roll * 1.2 - this.roll) * Math.min(1, 3.5 * dt);
    }

    // pitch is rate-controlled; faster birds pull round tighter
    const rate = 1.5 + Math.max(0, this.speed - 30) * 0.02;
    this.pitchVel += (inp.pitch * rate * this.authority - this.pitchVel) * Math.min(1, 5 * dt);
    this.pitch += this.pitchVel * dt;
    if (Math.abs(inp.pitch) < 0.05) {
      if (upright) this.pitch += (NEUTRAL_PITCH - this.pitch) * 0.9 * (1 - this.tuck) * dt; // settle into a glide (not while tucked)
      // let go upside down and the bird just holds its line (near the top it eases into a shallow
      // inverted glide); it never flies the rest of the loop for you
      else if (Math.abs(this.pitch) > 2.3) this.pitch += wrap(Math.PI - NEUTRAL_PITCH - this.pitch) * 0.9 * dt;
    }
    if (upright) this.pitch -= Math.abs(Math.sin(this.roll)) * 0.12 * dt; // banking costs lift
    // stall: too slow and the nose falls toward the ground along the shortest way round
    if (this.speed < STALL_SPEED) {
      const toDown = wrap(-Math.PI / 2 - this.pitch);
      this.pitch += Math.sign(toDown) * Math.min(Math.abs(toDown), (0.6 + (STALL_SPEED - this.speed) * 0.14) * dt);
    }
    // no bunting over forwards: the steepest dive is close to vertical
    if (upright && this.pitch < -1.35) this.pitch = -1.35;

    // track loops: going over the top flips the wrapped pitch from +PI to -PI
    if (this.pitch > Math.PI) { this.pitch -= TAU; this.overTop = true; }
    if (this.pitch < -Math.PI) { this.pitch += TAU; this.overTop = false; }
    if (this.overTop && this.pitch > -1.0 && this.pitch < 0.6) { this.overTop = false; finished = 'loop'; }

    this.brake += (inp.brake - this.brake) * Math.min(1, 8 * dt);
    this.tuck += (inp.tuck - this.tuck) * Math.min(1, 7 * dt);
    // tucked: the nose drops into a steep dive unless you hold it up
    if (this.tuck > 0.05 && upright && inp.pitch < 0.3) this.pitch += (-0.85 - this.pitch) * 2.4 * this.tuck * dt;

    // energy: gravity along the flight path minus drag, plus the tuck's extra punch
    this.speed = this.energy(dt, Math.sin(this.pitch));

    // coordinated turn; upside down the bird travels back along its heading, so the turn flips to stay
    // toward the lowered wing (otherwise steering feels reversed over the top of a loop)
    const inverted = Math.cos(this.pitch) < 0 ? -1 : 1;
    this.heading -= inverted * (G * Math.tan(this.roll) / Math.max(this.speed, 12)) * 1.35 * (1 - 0.5 * this.tuck) * dt;
    // rudder: a slow flat turn, no bank needed (handy for lining up a shot)
    this.yawVel += ((inp.yaw ?? 0) * 0.7 - this.yawVel) * Math.min(1, 4 * dt);
    this.heading -= inverted * this.yawVel * dt;
    this.slip += (-this.yawVel * 0.35 - this.slip) * Math.min(1, 6 * dt);

    this.updateDir();
    this.vel.copy(this.dir).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
    return finished;
  }

  /** Speed after one step: gravity along the path, drag, air-brake, and tuck thrust. */
  private energy(dt: number, climb: number) {
    const drag = (DRAG * (1 - 0.8 * this.tuck) + BRAKE_DRAG * this.brake) * this.speed * this.speed;
    const acc = -G * climb - drag + TUCK_THRUST * this.tuck;
    return THREE.MathUtils.clamp(this.speed + acc * dt, 4, MAX_SPEED);
  }

  /** Full 3D flight: left stick pitches about the wings, right stick rolls about the nose, any angle.
   *  Lift (along the bird's up) and gravity bend the flight path, so a bank turns you and a loop is just
   *  a long pull. The nose always points where you're going. */
  private stepFree(dt: number, inp: InputState): 'roll' | 'loop' | null {
    let finished: 'roll' | 'loop' | null = null;
    const tr = this.trick;
    if (tr) {
      tr.t += dt;
      const f = Math.min(1, tr.t / tr.dur);
      const e = f * f * (3 - 2 * f);
      this.spin = tr.dir * e * TAU; // visual only: the bird keeps its line while it rolls
      const side = Math.sin(f * Math.PI) * tr.dir * tr.dodge * dt;
      this.pos.addScaledVector(_v1.set(1, 0, 0).applyQuaternion(this.quat), side);
      if (f >= 1) { finished = 'roll'; this.trick = null; this.spin = 0; }
    }
    this.brake += (inp.brake - this.brake) * Math.min(1, 8 * dt);
    this.tuck += (inp.tuck - this.tuck) * Math.min(1, 7 * dt);

    // stick: smoothed rates about the bird's own axes
    const pRate = 1.6 + Math.max(0, this.speed - 30) * 0.02;
    const auth = this.authority;
    this.pitchVel += (inp.pitch * pRate * auth - this.pitchVel) * Math.min(1, 5 * dt);
    this.rollVel += (inp.roll * 2.6 * auth - this.rollVel) * Math.min(1, 6 * dt);
    this.yawVel += ((inp.yaw ?? 0) * 0.6 - this.yawVel) * Math.min(1, 4 * dt);
    const q = this.quat;
    q.multiply(_q.setFromAxisAngle(X_AXIS, this.pitchVel * dt));
    q.multiply(_q.setFromAxisAngle(Z_AXIS, -this.rollVel * dt));
    q.multiply(_q.setFromAxisAngle(Y_AXIS, -this.yawVel * dt));

    // flight path: lift along the bird's up (fades below stall speed) plus gravity, minus what lies along the nose
    const fwd = _v1.set(0, 0, -1).applyQuaternion(q);
    const up = _v2.set(0, 1, 0).applyQuaternion(q);
    // a little extra lift in a bank so turns hold their height (arcade help); none upside down
    const bankHelp = up.y > 0 ? 0.6 * (1 - up.y) : 0;
    // below stall speed the wing quits: almost no lift, so gravity pulls the nose down
    const stallCut = this.speed < STALL_SPEED ? 0.25 : 1;
    const lift = G * Math.min(1.05 + bankHelp, (this.speed / 26) ** 2) * (1 - 0.6 * this.tuck) * stallCut;
    const acc = _v3.copy(up).multiplyScalar(lift);
    acc.y -= G;
    acc.addScaledVector(fwd, -acc.dot(fwd));
    const v = Math.max(this.speed, 14);
    const turn = Math.min(acc.length() / v, 2.2) * dt;
    if (turn > 1e-6) {
      const axis = new THREE.Vector3().crossVectors(fwd, acc).normalize();
      q.premultiply(_q.setFromAxisAngle(axis, turn));
    }
    // wings level and hands off: ease into a gentle glide (same trim as classic)
    if (Math.abs(inp.pitch) < 0.05 && up.y > 0.6 && this.tuck < 0.5) {
      const err = NEUTRAL_PITCH - Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
      q.multiply(_q.setFromAxisAngle(X_AXIS, err * 0.7 * dt));
    }
    // tucked and not pulling: the nose eases down into a dive
    if (this.tuck > 0.05 && up.y > 0.3 && inp.pitch < 0.3) {
      const err = -0.85 - Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
      if (err < 0) q.multiply(_q.setFromAxisAngle(X_AXIS, err * 1.6 * this.tuck * dt));
    }
    q.normalize();

    // loop counter: rotation about the wings, a full turn either way is a loop
    const before = this.dir.clone();
    this.syncEuler();
    const right = _v3.set(1, 0, 0).applyQuaternion(q);
    this.loopTurn += Math.asin(THREE.MathUtils.clamp(_v2.crossVectors(before, this.dir).dot(right), -1, 1));
    this.loopTurn *= Math.exp(-0.08 * dt);
    if (Math.abs(this.loopTurn) > TAU - 0.5) { this.loopTurn = 0; finished = 'loop'; }
    this.overTop = this.up.y < 0;

    this.speed = this.energy(dt, this.dir.y);
    this.slip += (-this.yawVel * 0.35 - this.slip) * Math.min(1, 6 * dt);
    this.vel.copy(this.dir).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
    return finished;
  }

  applyTo(obj: THREE.Object3D) {
    obj.position.copy(this.pos);
    if (this.free) {
      obj.quaternion.copy(this.quat)
        .multiply(_q.setFromAxisAngle(Y_AXIS, this.slip))
        .multiply(_q.setFromAxisAngle(Z_AXIS, -this.spin));
    } else obj.rotation.set(this.pitch, this.heading + this.slip, -(this.roll + this.spin), 'YXZ');
  }
}
