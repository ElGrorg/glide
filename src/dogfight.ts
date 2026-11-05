import * as THREE from 'three';
import { BirdMesh, type BirdPalette, type Glider } from './bird';
import { terrainHeight, nearestBranch } from './world';
import type { CloudPuffs } from './puffs';

// Dogfights: enemy birds that either hunt you (spawn behind) or flee from you (spawn ahead).
// Everyone has a pea shooter. Enemies jink, break, barrel-roll and use the terrain to shake you.

export type Role = 'hunter' | 'prey';
const G = 9.8;
const UP = new THREE.Vector3(0, 1, 0);
const PEA_SPEED = 150;      // player pea muzzle speed (m/s, on top of your own speed)
const ENEMY_PEA_SPEED = 120;
const PEA_LIFE = 1.0;
const ENEMY_HIT_R = 1.6;    // generous: these are small birds moving fast
const PLAYER_HIT_R = 0.85;
const LOCK_CONE = 0.26;     // ~15° either side of your nose
const LOCK_KEEP = 0.6;      // once locked, hold it out to ~35°
const LOCK_RANGE = 170;
const LOCK_TIME = 0.35;

const HUNTER_COLORS: BirdPalette = { body: 0x3a3f4a, belly: 0x9aa0aa, wing: 0x2b2f38, tip: 0x121418 };
const PREY_COLORS: BirdPalette = { body: 0x4f93c4, belly: 0xe8eef2, wing: 0x3a6c98, tip: 0x1d3350 };

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Rotate unit vector `dir` toward unit vector `want` by at most `max` radians. */
function turnToward(dir: THREE.Vector3, want: THREE.Vector3, max: number) {
  const ang = dir.angleTo(want);
  if (ang < 1e-4) return;
  const axis = tmpC.crossVectors(dir, want);
  if (axis.lengthSq() < 1e-8) axis.copy(UP); else axis.normalize();
  dir.applyAxisAngle(axis, Math.min(ang, max)).normalize();
}

let nextId = 1;
export class Enemy {
  id = nextId++;
  mesh: BirdMesh;
  pos = new THREE.Vector3();
  dir = new THREE.Vector3(0, 0, -1);
  speed = 34;
  roll = 0;
  spin = 0;
  hp = 3;
  alive = true;
  dying = 0;
  state: 'cruise' | 'attack' | 'evade' = 'cruise';
  jinkT = 0;
  jink = new THREE.Vector3();
  rollT = 0; rollDir = 1;
  fireCd = 1.5; burst = 0;
  flash = 0;
  /** Seconds of heightened awareness after being shot at or targeted. */
  alert = 0;
  /** Seconds left of a committed overshoot (you braked and it flew past). */
  overT = 0;
  /** 0..1: how squarely this enemy has you in its sights (hunters only). */
  aimAtPlayer = 0;
  heading = 0;
  constructor(public role: Role, scene: THREE.Scene) {
    this.mesh = new BirdMesh(role === 'hunter' ? HUNTER_COLORS : PREY_COLORS);
    this.hp = role === 'hunter' ? 4 : 3;
    scene.add(this.mesh);
  }
  get vel() { return tmpB.copy(this.dir).multiplyScalar(this.speed); }

  /** Steer, keep clear of the ground, move. */
  fly(dt: number, want: THREE.Vector3, wantSpeed: number, rate: number, minClear: number) {
    // terrain: look ahead and climb before the ground gets close
    const la = tmpA.copy(this.pos).addScaledVector(this.dir, this.speed * 1.3);
    const h = Math.max(terrainHeight(this.pos.x, this.pos.z), terrainHeight(la.x, la.z));
    const short = h + minClear - this.pos.y;
    if (short > 0) { want.y = Math.max(want.y, Math.min(0.7, short * 0.06)); want.normalize(); }
    want.y = THREE.MathUtils.clamp(want.y, -0.75, 0.7); want.normalize();

    const before = Math.atan2(-this.dir.x, -this.dir.z);
    turnToward(this.dir, want, rate * dt);
    const after = Math.atan2(-this.dir.x, -this.dir.z);
    let dh = after - before; if (dh > Math.PI) dh -= Math.PI * 2; if (dh < -Math.PI) dh += Math.PI * 2;
    this.heading = after;
    // bank into the turn like a real bird would
    const yawRate = dh / Math.max(dt, 1e-3);
    const bank = THREE.MathUtils.clamp(Math.atan(-yawRate * this.speed / G), -1.35, 1.35);
    this.roll += (bank - this.roll) * Math.min(1, 6 * dt);

    // speed: quick to accelerate, a bit slower to bleed off (so they can overshoot you)
    const dv = wantSpeed - this.speed;
    this.speed += THREE.MathUtils.clamp(dv, -(this.role === 'hunter' ? 4.5 : 10) * dt, 18 * dt); // hunters carry their speed: brake and they overshoot
    this.speed += -G * this.dir.y * 0.4 * dt; // a little gravity feel
    this.speed = THREE.MathUtils.clamp(this.speed, 18, 95);

    // barrel roll: a quick sideways juke
    if (this.rollT > 0) {
      this.rollT -= dt;
      const f = 1 - Math.max(0, this.rollT) / 0.6;
      this.spin = this.rollDir * f * Math.PI * 2;
      const side = tmpA.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
      this.pos.addScaledVector(side, Math.sin(f * Math.PI) * this.rollDir * 22 * dt);
      if (this.rollT <= 0) this.spin = 0;
    }

    this.pos.addScaledVector(this.dir, this.speed * dt);
    const floor = terrainHeight(this.pos.x, this.pos.z) + 2.5;
    if (this.pos.y < floor) this.pos.y = floor;
  }

  render(t: number) {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1)), this.heading, -(this.roll + this.spin), 'YXZ');
    this.mesh.animate(t + this.id, this.state === 'evade' ? 0 : 0.1, this.speed, this.alive ? 0 : 0.6);
    this.mesh.scale.setScalar(this.flash > 0 ? 1.25 : 1);
  }

  dispose(scene: THREE.Scene) { scene.remove(this.mesh); }
}

interface Pea { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; life: number; enemy: boolean; target: Enemy | null; near: number }

export type DogfightEvent =
  | { type: 'spawn'; role: Role }
  | { type: 'turned' }
  | { type: 'overshoot' }
  | { type: 'hitEnemy'; enemy: Enemy }
  | { type: 'kill'; role: Role; locked: boolean; ground: boolean }
  | { type: 'hitPlayer' }
  | { type: 'dodged' }
  | { type: 'escaped' };

export class Dogfight {
  enemies: Enemy[] = [];
  private peas: Pea[] = [];
  private fireCd = 0;
  private hurtT = 0; // brief grace after a hit so one burst can't take every feather
  private spawnT = 9;
  private lastRole: Role = 'prey';
  kills = 0;
  /** Enemy in front that your peas will home in on. */
  locked: Enemy | null = null;
  /** Enemy you're currently locking (before the lock completes). */
  locking: Enemy | null = null;
  lockT = 0;
  /** 0..1: strongest "someone is on your tail" signal this frame. */
  tailThreat = 0;
  shotThisFrame = false;
  enemyShotThisFrame = false;

  constructor(private scene: THREE.Scene, private puffs: CloudPuffs) {
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 1.8, 5);
    geo.rotateX(Math.PI / 2);
    const mine = new THREE.MeshBasicMaterial({ color: 0xfff27a, fog: false });
    const theirs = new THREE.MeshBasicMaterial({ color: 0xff4a3a, fog: false });
    for (let i = 0; i < 120; i++) {
      const enemy = i >= 60;
      const mesh = new THREE.Mesh(geo, enemy ? theirs : mine);
      mesh.visible = false; scene.add(mesh);
      this.peas.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, enemy, target: null, near: 99 });
    }
  }

  reset() {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies = [];
    for (const p of this.peas) { p.life = 0; p.mesh.visible = false; }
    this.spawnT = 9; this.kills = 0; this.locked = null; this.locking = null; this.lockT = 0; this.tailThreat = 0;
  }

  private shoot(enemy: boolean, from: THREE.Vector3, vel: THREE.Vector3, target: Enemy | null) {
    const p = this.peas.find((q) => q.enemy === enemy && q.life <= 0);
    if (!p) return;
    p.pos.copy(from); p.vel.copy(vel); p.life = PEA_LIFE; p.target = target; p.near = 99;
    p.mesh.visible = true;
  }

  private spawn(g: Glider, role: Role) {
    const e = new Enemy(role, this.scene);
    const fwd = tmpA.set(-Math.sin(g.heading), 0, -Math.cos(g.heading));
    const side = tmpB.set(-fwd.z, 0, fwd.x);
    if (role === 'hunter') {
      e.pos.copy(g.pos).addScaledVector(fwd, -170).addScaledVector(side, rand(-40, 40));
      e.pos.y = Math.max(g.pos.y + rand(5, 25), terrainHeight(e.pos.x, e.pos.z) + 25);
      e.dir.copy(g.pos).sub(e.pos).normalize();
      e.speed = g.speed + 12;
      e.state = 'attack';
    } else {
      e.pos.copy(g.pos).addScaledVector(fwd, 190).addScaledVector(side, rand(-50, 50));
      e.pos.y = Math.max(g.pos.y - rand(0, 15), terrainHeight(e.pos.x, e.pos.z) + 28);
      e.dir.copy(fwd);
      e.speed = g.speed;
    }
    this.enemies.push(e);
  }

  /** Advance everything. `active` is false on the crash screen: enemies keep flying but hold fire. */
  update(dt: number, t: number, g: Glider, fire: boolean, active: boolean): DogfightEvent[] {
    const out: DogfightEvent[] = [];
    this.shotThisFrame = false;
    this.enemyShotThisFrame = false;

    // ---- spawning: one at a time to start, two once you've got a couple of kills
    const max = this.kills >= 2 ? 2 : 1;
    if (active && this.enemies.filter((e) => e.alive).length < max) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        const role: Role = Math.random() < 0.6 ? (this.lastRole === 'hunter' ? 'prey' : 'hunter') : this.lastRole;
        this.lastRole = role;
        this.spawn(g, role);
        out.push({ type: 'spawn', role });
        this.spawnT = rand(7, 13);
      }
    }

    // ---- enemy brains
    this.tailThreat = 0;
    for (const e of this.enemies) {
      e.flash = Math.max(0, e.flash - dt);
      if (!e.alive) {
        // falling, spinning, shedding feathers
        e.dying += dt;
        e.dir.y = Math.max(-0.95, e.dir.y - 0.9 * dt); e.dir.normalize();
        e.spin += 9 * dt;
        e.pos.addScaledVector(e.dir, e.speed * dt);
        if (Math.random() < 30 * dt) this.puffs.burst(e.pos, tmpA.set(0, 2, 0), 2, 1, 0.7);
        continue;
      }
      const toPlayer = tmpA.copy(g.pos).sub(e.pos);
      const dist = toPlayer.length();
      const fromPlayer = tmpB.copy(toPlayer).multiplyScalar(-1 / Math.max(dist, 1e-3));
      const playerAimErr = g.dir.angleTo(fromPlayer);     // how close you are to having it in your sights
      e.alert = Math.max(0, e.alert - dt);
      if (dist < 170 && playerAimErr < 0.3) e.alert = 2.5;   // it sees you lining up
      const threatened = (dist < 140 && playerAimErr < 0.5) || (e.alert > 0 && dist < 200);
      const behindYou = g.dir.dot(fromPlayer) < -0.3;

      // a bandit that ends up on your tail turns and fights
      if (e.role === 'prey' && behindYou && dist < 90 && !threatened) { e.role = 'hunter'; out.push({ type: 'turned' }); }

      const want = new THREE.Vector3();
      let wantSpeed = g.speed;
      let rate = 1.25;
      // slam the brakes with a hunter close behind and it overshoots
      e.overT = Math.max(0, e.overT - dt);
      if (e.role === 'hunter' && e.overT <= 0 && g.brake > 0.6 && behindYou && dist < 45) {
        e.overT = 1.6; e.speed = Math.max(e.speed, g.speed + 12); out.push({ type: 'overshoot' });
      }
      const evade = threatened && (e.role === 'prey' || dist < 100);
      e.state = evade ? 'evade' : e.role === 'hunter' ? 'attack' : 'cruise';

      if (e.overT > 0) {
        // committed: it keeps going straight past you and only starts jinking once it's out in front
        want.copy(e.dir).add(tmpC.set(0, 0.12, 0)).normalize(); wantSpeed = e.speed; rate = 0.4; // passes just over your head
      } else if (e.state === 'evade') {
        // jink: break hard across your line of fire, change direction unpredictably
        e.jinkT -= dt;
        if (e.jinkT <= 0) {
          e.jinkT = rand(0.45, 1.2);
          const perp = tmpC.copy(fromPlayer).addScaledVector(g.dir, -fromPlayer.dot(g.dir));
          if (perp.lengthSq() < 0.01) perp.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          perp.normalize();
          if (Math.random() < 0.35) perp.multiplyScalar(-1); // fake the other way
          e.jink.copy(g.dir).setY(0).normalize().multiplyScalar(0.55).addScaledVector(perp, 0.9);
          e.jink.y += rand(-0.5, 0.25);
          e.jink.normalize();
          // dodge roll when you're right on it
          if (playerAimErr < 0.18 && dist < 90 && e.rollT <= 0 && Math.random() < 0.4) {
            e.rollT = 0.6;
            const side = Math.cos(e.heading) * perp.x - Math.sin(e.heading) * perp.z;
            e.rollDir = side >= 0 ? 1 : -1;
          }
        }
        want.copy(e.jink);
        rate = 1.7;
        wantSpeed = Math.max(28, g.speed * (e.role === 'prey' ? 0.9 : 1.0)); // jinking bleeds speed
      } else if (e.state === 'attack') {
        // lag pursuit from range, lead pursuit when close enough to shoot
        if (dist > 75) want.copy(g.pos).addScaledVector(g.dir, -22).addScaledVector(g.vel, 0.6).sub(e.pos).normalize();
        else want.copy(g.pos).addScaledVector(g.vel, dist / (ENEMY_PEA_SPEED + e.speed)).sub(e.pos).normalize();
        wantSpeed = g.speed + THREE.MathUtils.clamp((dist - 26) * 0.5, -14, 30);
        rate = 1.08; // a hair tighter than your best turn: break + brake to get inside it
        const aimErr = e.dir.angleTo(want);
        e.aimAtPlayer = dist < 120 ? THREE.MathUtils.clamp(1 - aimErr / 0.4, 0, 1) : 0;
        if (behindYou && dist < 150) this.tailThreat = Math.max(this.tailThreat, Math.max(0.35, e.aimAtPlayer));
        // short bursts
        e.fireCd -= dt;
        if (active && e.fireCd <= 0 && dist < 110 && aimErr < 0.12) {
          const spread = tmpC.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.06);
          const v = e.dir.clone().add(spread).normalize().multiplyScalar(ENEMY_PEA_SPEED).addScaledVector(e.dir, e.speed);
          this.shoot(true, e.pos.clone().addScaledVector(e.dir, 1.5), v, null);
          this.enemyShotThisFrame = true;
          e.burst++;
          e.fireCd = e.burst >= 4 ? rand(1.1, 2.0) : 0.15;
          if (e.burst >= 4) e.burst = 0;
        }
      } else {
        // cruising bandit: fly the valley downhill, not too far ahead of you
        const ahead = e.pos.z - 140;
        const c = nearestBranch(e.pos.x, ahead).c;
        want.set(c, terrainHeight(c, ahead) + 30, ahead).sub(e.pos).normalize();
        wantSpeed = dist > 240 ? g.speed * 0.8 : g.speed * 0.95;
        rate = 0.9;
      }
      // never stray too far off: come back toward the action
      if (dist > 320) want.lerp(toPlayer.clone().normalize(), 0.5).normalize();
      e.fly(dt, want, wantSpeed, rate, e.state === 'evade' ? 9 : 16);

      if (dist > 520) { e.alive = false; e.dying = 99; out.push({ type: 'escaped' }); }
    }

    // ---- lock-on: hold your nose on an enemy for a moment
    let best: Enemy | null = null, bestErr = LOCK_CONE;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = tmpA.copy(e.pos).sub(g.pos); const dist = d.length();
      if (dist > LOCK_RANGE * 1.25) continue;
      const err = g.dir.angleTo(d);
      if (e === this.locked && err < LOCK_KEEP) { best = e; break; }
      if (dist < LOCK_RANGE && err < bestErr) { best = e; bestErr = err; }
    }
    if (best && best === this.locked) { /* keep */ }
    else if (best && best === this.locking) { this.lockT += dt; if (this.lockT >= LOCK_TIME) this.locked = best; }
    else { this.locking = best; this.lockT = 0; this.locked = null; }
    if (this.locked && !this.locked.alive) this.locked = null;

    // ---- your pea shooter
    this.fireCd -= dt;
    this.hurtT -= dt;
    if (active && fire && this.fireCd <= 0) {
      this.fireCd = 0.1;
      const muzzle = g.pos.clone().addScaledVector(g.dir, 1.6);
      // locked: the shooter leads the target for you (but can't follow its jinks)
      const aim = g.dir.clone();
      if (this.locked) {
        const T = this.locked.pos.distanceTo(muzzle) / (PEA_SPEED + g.speed);
        const lead = this.locked.pos.clone().addScaledVector(this.locked.vel, T).sub(muzzle).normalize();
        turnToward(aim, lead, 0.3);
      }
      const spread = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.012);
      const v = aim.add(spread).normalize().multiplyScalar(PEA_SPEED).add(g.vel);
      this.shoot(false, muzzle, v, this.locked);
      this.shotThisFrame = true;
    }

    // ---- peas
    const prev = new THREE.Vector3();
    for (const p of this.peas) {
      if (p.life <= 0) continue;
      p.life -= dt;
      // locked peas curve onto the target
      if (p.target && p.target.alive) {
        const sp = p.vel.length();
        const want = tmpA.copy(p.target.pos).addScaledVector(p.target.vel, 0.05).sub(p.pos).normalize();
        const d = tmpB.copy(p.vel).normalize();
        turnToward(d, want, 0.35 * dt);
        p.vel.copy(d).multiplyScalar(sp);
      }
      prev.copy(p.pos);
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < terrainHeight(p.pos.x, p.pos.z)) { p.life = 0; }
      if (!p.enemy) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          if (segDist(prev, p.pos, e.pos) < ENEMY_HIT_R) {
            p.life = 0; e.hp--; e.flash = 0.12; e.alert = 3; e.jinkT = 0;
            this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.2), 4, 6, 0.6);
            out.push({ type: 'hitEnemy', enemy: e });
            if (e.hp <= 0) this.kill(e, out, !!p.target);
            break;
          }
        }
      } else if (active) {
        const d = segDist(prev, p.pos, g.pos);
        p.near = Math.min(p.near, d);
        if (g.trick && d < 3.5) { out.push({ type: 'dodged' }); p.life = 0; }   // a barrel roll shrugs off the burst
        else if (d < PLAYER_HIT_R) { if (this.hurtT <= 0) { out.push({ type: 'hitPlayer' }); this.hurtT = 0.8; } p.life = 0; }
      }
      if (p.life <= 0) p.mesh.visible = false;
      else { p.mesh.position.copy(p.pos); p.mesh.lookAt(tmpA.copy(p.pos).add(p.vel)); }
    }

    // ---- crashes, clean-up, drawing
    for (const e of this.enemies) {
      if (e.alive && e.pos.y <= terrainHeight(e.pos.x, e.pos.z) + 2.6 && e.state === 'evade' && e.dir.y < -0.3) {
        // chased into the ground
        this.kill(e, out, false, true);
      }
      if (!e.alive && e.dying < 90 && e.pos.y < terrainHeight(e.pos.x, e.pos.z) + 0.5) {
        this.puffs.burst(e.pos, tmpA.set(0, 6, 0), 6, 14, 1.0);
        e.dying = 99;
      }
      e.render(t);
    }
    this.enemies = this.enemies.filter((e) => {
      const gone = e.dying >= 99 || e.dying > 6;
      if (gone) e.dispose(this.scene);
      return !gone;
    });
    return out;
  }

  private kill(e: Enemy, out: DogfightEvent[], locked: boolean, ground = false) {
    e.alive = false; e.dying = 0.001; e.rollT = 0;
    this.kills++;
    if (this.locked === e) this.locked = null;
    this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.3), 8, 22, 0.9);
    out.push({ type: 'kill', role: e.role, locked, ground });
    this.spawnT = Math.min(this.spawnT, rand(5, 9));
  }
}

/** Distance from point c to segment ab. */
function segDist(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const ab = tmpB.copy(b).sub(a);
  const t = THREE.MathUtils.clamp(tmpC.copy(c).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
  return tmpC.copy(a).addScaledVector(ab, t).distanceTo(c);
}
