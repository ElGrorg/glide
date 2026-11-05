import * as THREE from 'three';
import type { InputState } from './input';

const G = 9.8;
const DRAG = 0.0016;        // equilibrium glide ~36 m/s at -12°
const BRAKE_DRAG = 0.0065;
const NEUTRAL_PITCH = -0.26; // nose settles slightly down when you let go
const STALL_SPEED = 15;

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
  trick: { type: 'roll'; t: number; dur: number; dir: number; dodge: number } | null = null;
  spin = 0;              // visual barrel-roll angle
  overTop = false;       // passed inverted at the top of a loop

  /** Nose pointing past vertical (upside down part of a loop). */
  get looping() { return this.overTop || Math.abs(this.pitch) > Math.PI / 2; }

  /** Barrel roll. Rolling while already banking the same way turns it into a big sideways dodge. */
  startTrick(req: 'rollL' | 'rollR', rollInput = 0): boolean {
    if (this.trick || this.looping) return false;
    const dir = req === 'rollL' ? -1 : 1;
    const dodge = 6 + 22 * Math.max(0, rollInput * dir);
    this.trick = { type: 'roll', t: 0, dur: 0.7, dir, dodge };
    return true;
  }

  reset(x: number, y: number, z: number, heading = 0) {
    this.pos.set(x, y, z);
    this.speed = 32; this.pitch = NEUTRAL_PITCH; this.heading = heading; this.roll = 0; this.brake = 0;
    this.trick = null; this.spin = 0; this.overTop = false;
    this.updateDir();
  }

  private updateDir() {
    const cp = Math.cos(this.pitch);
    this.dir.set(-Math.sin(this.heading) * cp, Math.sin(this.pitch), -Math.cos(this.heading) * cp);
  }

  /** Advance the flight model. Returns a trick that just finished, if any. */
  step(dt: number, inp: InputState): 'roll' | 'loop' | null {
    let finished: 'roll' | 'loop' | null = null;
    const tr = this.trick;
    if (tr) {
      tr.t += dt;
      const f = Math.min(1, tr.t / tr.dur);
      const e = f * f * (3 - 2 * f);
      this.spin = tr.dir * e * TAU;
      // a barrel roll also jinks you sideways a little
      const side = Math.sin(f * Math.PI) * tr.dir * tr.dodge * dt;
      this.pos.x += Math.cos(this.heading) * side;
      this.pos.z -= Math.sin(this.heading) * side;
      if (f >= 1) { finished = 'roll'; this.trick = null; this.spin = 0; }
    }

    const upright = Math.abs(this.pitch) <= Math.PI / 2 && !this.overTop;
    // roll eases toward the stick (wings level themselves while upside down)
    const targetRoll = upright ? inp.roll * 1.2 : inp.roll * 0.3;
    this.roll += (targetRoll - this.roll) * Math.min(1, 5 * dt);

    // pitch is rate-controlled; faster birds pull round tighter
    const rate = 1.5 + Math.max(0, this.speed - 30) * 0.02;
    this.pitch += inp.pitch * rate * dt;
    if (Math.abs(inp.pitch) < 0.05) {
      if (upright) this.pitch += (NEUTRAL_PITCH - this.pitch) * 0.9 * (1 - this.tuck) * dt; // settle into a glide (not while tucked)
      else this.pitch += 1.1 * dt; // let go mid-loop and the bird finishes it
    }
    if (upright) this.pitch -= Math.abs(Math.sin(this.roll)) * 0.12 * dt; // banking costs lift
    // stall: too slow and the nose falls toward the ground along the shortest way round
    if (this.speed < STALL_SPEED) {
      const toDown = wrap(-Math.PI / 2 - this.pitch);
      this.pitch += Math.sign(toDown) * Math.min(Math.abs(toDown), (STALL_SPEED - this.speed) * 0.14 * dt);
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

    // energy: gravity along the flight path minus drag
    const acc = -G * Math.sin(this.pitch) - (DRAG * (1 - 0.7 * this.tuck) + BRAKE_DRAG * this.brake) * this.speed * this.speed;
    this.speed = Math.max(4, this.speed + acc * dt);

    // coordinated turn
    this.heading -= (G * Math.tan(this.roll) / Math.max(this.speed, 12)) * 1.35 * (1 - 0.5 * this.tuck) * dt;

    this.updateDir();
    this.vel.copy(this.dir).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
    return finished;
  }

  applyTo(obj: THREE.Object3D) {
    obj.position.copy(this.pos);
    obj.rotation.set(this.pitch, this.heading, -(this.roll + this.spin), 'YXZ');
  }
}
