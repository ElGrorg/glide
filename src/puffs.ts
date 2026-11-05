import * as THREE from 'three';

/** Cloud particles: the burst and trail you leave punching through a cloud. */
export class CloudPuffs {
  mesh: THREE.InstancedMesh;
  private pos: THREE.Vector3[] = [];
  private vel: THREE.Vector3[] = [];
  private age: number[] = [];
  private life: number[] = [];
  private size: number[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(scene: THREE.Scene, private count = 420) {
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: 0xc8d2e0, emissiveIntensity: 0.55, flatShading: true, transparent: true, opacity: 0.92,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    for (let i = 0; i < count; i++) {
      this.pos.push(new THREE.Vector3()); this.vel.push(new THREE.Vector3());
      this.age.push(1); this.life.push(0); this.size.push(0);
      this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m);
    }
    scene.add(this.mesh);
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number) {
    const i = this.next; this.next = (this.next + 1) % this.count;
    this.pos[i].copy(p); this.vel[i].copy(v);
    this.age[i] = 0; this.life[i] = life; this.size[i] = size;
  }

  /** Spray n puffs from p: base velocity plus a random spread. */
  burst(p: THREE.Vector3, base: THREE.Vector3, spread: number, n: number, size: number) {
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(spread * (0.4 + Math.random() * 0.6)).add(base);
      o.randomDirection().multiplyScalar(Math.random() * 2);
      this.spawn(o.add(p), v, size * (0.6 + Math.random() * 0.8), 1.1 + Math.random() * 0.9);
    }
  }

  /** Ring-shaped spray perpendicular to dir: the shockwave of punching out. */
  ring(p: THREE.Vector3, dir: THREE.Vector3, base: THREE.Vector3, spread: number, n: number, size: number) {
    const r = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      r.randomDirection(); r.addScaledVector(dir, -r.dot(dir)).normalize();
      v.copy(base).addScaledVector(r, spread * (0.6 + Math.random() * 0.6));
      this.spawn(p.clone().addScaledVector(r, 1.5 + Math.random() * 2), v, size * (0.6 + Math.random() * 0.8), 0.9 + Math.random() * 0.8);
    }
  }

  update(dt: number, cam?: THREE.Vector3) {
    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const f = this.age[i] / this.life[i];
      this.vel[i].multiplyScalar(drag);
      this.vel[i].y += 0.6 * dt; // puffs drift up as they billow
      this.pos[i].addScaledVector(this.vel[i], dt);
      let sc = f >= 1 ? 0 : this.size[i] * (0.4 + 1.3 * Math.min(1, this.age[i] / 0.35)) * (1 - f * f * f);
      // fade puffs that drift right up to the camera so they never blank the screen
      if (cam) sc *= THREE.MathUtils.smoothstep(this.pos[i].distanceTo(cam) - sc, 1, 6);
      this.q.setFromAxisAngle(this.vel[i].clone().normalize(), this.age[i] * 2);
      this.m.compose(this.pos[i], this.q, this.s.set(sc, sc * 0.8, sc));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { for (let i = 0; i < this.count; i++) this.age[i] = this.life[i]; this.update(0); }
}
