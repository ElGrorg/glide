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

  animate(t: number, brake: number, speed: number) {
    // gentle flutter that grows with speed, wings cup up when braking
    const flutter = Math.sin(t * 9) * 0.015 * (speed / 30);
    const dihedral = 0.08 + brake * 0.35 + flutter;
    const tip = 0.06 + brake * 0.4 - flutter;
    this.lInner.rotation.z = -dihedral; this.rInner.rotation.z = dihedral;
    this.lOuter.rotation.z = -tip; this.rOuter.rotation.z = tip;
    // braking also sweeps wings forward a touch
    this.lInner.rotation.y = brake * 0.25; this.rInner.rotation.y = -brake * 0.25;
    this.tail.rotation.x = brake * 0.5;
  }
}

/** Arcade glider: speed and height trade through pitch. */
export class Glider {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  dir = new THREE.Vector3(0, 0, -1);
  speed = 32;
  pitch = NEUTRAL_PITCH; // radians, + nose up
  heading = 0;           // radians, 0 = -Z
  roll = 0;              // radians, + right wing down
  brake = 0;

  reset(x: number, y: number, z: number, heading = 0) {
    this.pos.set(x, y, z);
    this.speed = 32; this.pitch = NEUTRAL_PITCH; this.heading = heading; this.roll = 0; this.brake = 0;
    this.updateDir();
  }

  private updateDir() {
    const cp = Math.cos(this.pitch);
    this.dir.set(-Math.sin(this.heading) * cp, Math.sin(this.pitch), -Math.cos(this.heading) * cp);
  }

  step(dt: number, inp: InputState) {
    // roll eases toward the stick
    const targetRoll = inp.roll * 1.05;
    this.roll += (targetRoll - this.roll) * Math.min(1, 5 * dt);
    // pitch is rate-controlled, and drifts back to a gentle glide when you let go
    this.pitch += inp.pitch * 1.5 * dt;
    if (Math.abs(inp.pitch) < 0.05) this.pitch += (NEUTRAL_PITCH - this.pitch) * 0.9 * dt;
    // banking costs a little lift
    this.pitch -= Math.abs(Math.sin(this.roll)) * 0.12 * dt;
    // stall: too slow and the nose drops
    if (this.speed < STALL_SPEED) this.pitch -= (STALL_SPEED - this.speed) * 0.14 * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.3, 0.85);

    this.brake += (inp.brake - this.brake) * Math.min(1, 8 * dt);

    // energy: gravity along the flight path minus drag
    const acc = -G * Math.sin(this.pitch) - (DRAG + BRAKE_DRAG * this.brake) * this.speed * this.speed;
    this.speed = Math.max(4, this.speed + acc * dt);

    // coordinated turn
    this.heading -= (G * Math.tan(this.roll) / Math.max(this.speed, 12)) * 1.35 * dt;

    this.updateDir();
    this.vel.copy(this.dir).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
  }

  applyTo(obj: THREE.Object3D) {
    obj.position.copy(this.pos);
    obj.rotation.set(this.pitch, this.heading, -this.roll, 'YXZ');
  }
}
