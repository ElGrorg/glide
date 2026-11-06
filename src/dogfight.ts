import * as THREE from 'three';
import { BirdMesh, type BirdPalette, type Glider } from './bird';
import { terrainHeight, nearestBranch, cruiseThrust, getArena, obstaclesNear, obstacleGap, ARENA_R, CRUISE_SPEED, type Obstacle } from './world';
import type { CloudPuffs } from './puffs';

// Dogfights: enemy birds that either hunt you (spawn behind) or flee from you (spawn ahead).
// Everyone has a pea shooter. Enemies jink, break, barrel-roll and use the terrain to shake you.

export type Role = 'hunter' | 'prey';
const G = 9.8;
const UP = new THREE.Vector3(0, 1, 0);
// Enemy birds fly on the same energy rules as you: gravity along the path, drag, air-brake,
// a turn limited by how much lift their speed gives them, and a stall when they get too slow.
const DRAG = 0.0016, BRAKE_DRAG = 0.0065, MAX_SPEED = 115;
const STALL_SPEED = 15;
const MAX_LIFT_G = 1.65;   // same as your hardest banked pull
const PEA_SPEED = 150;
const ASSIST_CONE = 0.14;   // pea aim assist kicks in within ~8° of your nose
const ASSIST_BEND = 0.055;  // and bends the shot at most ~3°
const ASSIST_RANGE = 150;      // player pea muzzle speed (m/s, on top of your own speed)
const ENEMY_PEA_SPEED = PEA_SPEED; // same pea shooter as yours
const PEA_LIFE = 1.0;
const ENEMY_HIT_R = 1.6;    // generous: these are small birds moving fast
const PLAYER_HIT_R = 0.85;
// Hunter darts: a hunter that holds you in its sights locks on, then launches a homing dart.
const DART_LOCK_TIME = 1.6;  // seconds it must keep you in its cone
const DART_CONE = 0.45;      // ~25° either side of its nose
const DART_RANGE_MIN = 45, DART_RANGE_MAX = 210;
const DART_RELOAD = 11;
const DART_SPEED = 95;       // faster than anything but a long steep dive
const DART_TURN = 2.4;       // rad/s: tracks anything but a well-timed hard break
const DART_LIFE = 7;
const DART_HIT_R = 2.0;      // proximity fuse
// Your homing darts: hold your nose on a bird to lock, then fire. Limited ammo that recharges.
const LOCK_CONE = 0.26;     // ~15° either side of your nose
const LOCK_KEEP = 0.6;      // once locked, hold it out to ~35°
const LOCK_RANGE = 170;
const LOCK_TIME = 1;        // hold your nose on a bird this long to lock
export const MAX_DARTS = 2;
const MY_DART_RECHARGE = 10; // seconds to earn one dart back
const MY_DART_SPEED = 70;    // on top of your own speed
const MY_DART_TURN = 2.6;    // rad/s: homes hard, but a bird that breaks across its path can outturn it
const MY_DART_LIFE = 4.5;
const MY_DART_HIT_R = 2.4;

const HUNTER_COLORS: BirdPalette = { body: 0x3a3f4a, belly: 0x9aa0aa, wing: 0x2b2f38, tip: 0x121418 };
const PREY_COLORS: BirdPalette = { body: 0x4f93c4, belly: 0xe8eef2, wing: 0x3a6c98, tip: 0x1d3350 };

const nearObs: Obstacle[] = [];
/** Arena flapping (0..1) for the wing animation: harder when slow, none when braking or on the mountain. */
export function flapAmount(speed: number, brake = 0) {
  return getArena() ? THREE.MathUtils.clamp(0.25 + (CRUISE_SPEED - speed) / 12, 0, 1) * (1 - brake) : 0;
}
/** True if the point is inside a tree, rock or spire. */
export function hitsObstacle(p: THREE.Vector3, pad = 0.3) {
  for (const o of obstaclesNear(p.x, p.z, 5, nearObs)) if (obstacleGap(o, p.x, p.y, p.z) < pad) return true;
  return false;
}

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
  /** Seconds left of a hard break to dodge an incoming dart of yours, and the heading it breaks toward. */
  breakT = 0; breakDir = new THREE.Vector3();
  fireCd = 1.5; burst = 0;
  flash = 0;
  /** Seconds of heightened awareness after being shot at or targeted. */
  alert = 0;
  /** Seconds left of a committed overshoot (you braked and it flew past). */
  overT = 0;
  /** Seconds left of having lost sight of you (you broke hard or dodged). */
  lostT = 0;
  /** Where it *thinks* you are: it reacts to your moves with a lag, so sharp jinks open a gap. */
  seenPos = new THREE.Vector3();
  seenVel = new THREE.Vector3();
  seenInit = false;
  /** 0..1: how squarely this enemy has you in its sights (hunters only). */
  aimAtPlayer = 0;
  /** Dart lock progress, seconds (hunters only), and reload timer. */
  dartLock = 0;
  dartCd = rand(3, 6);
  heading = 0;
  /** Online play: 'ai' = a host-run bird mirrored on this machine, 'human' = another player. Puppets
   *  skip the brain here; their position comes over the network and their own machine decides hits. */
  remote: 'ai' | 'human' | null = null;
  netId = '';
  /** Online allies: no lock-on, no aim assist, peas pass through. */
  friendly = false;
  /** Network orientation for puppets (rendered as-is while alive). */
  quat = new THREE.Quaternion();
  /** Online: who last hit this bird (for kill credit), and which target its brain is chasing. */
  lastHitBy = '';
  targetId = '';
  constructor(public role: Role, scene: THREE.Scene, palette?: BirdPalette) {
    this.mesh = new BirdMesh(palette ?? (role === 'hunter' ? HUNTER_COLORS : PREY_COLORS));
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
    // trees, rocks, pillars and arches: look ahead and go over or round them (they can still misjudge it)
    let avoiding = false;
    for (const ahead of [0.6, 1.4]) {
      const look = tmpA.copy(this.pos).addScaledVector(this.dir, Math.max(12, this.speed * ahead));
      for (const o of obstaclesNear(look.x, look.z, 10, nearObs)) {
        if (o.top < look.y - 4 || o.y0 > look.y + 6) continue;
        if (obstacleGap(o, look.x, look.y, look.z) > 8) continue;
        avoiding = true;
        if (o.top - this.pos.y < 12) { want.y = Math.max(want.y, 0.5); continue; } // hop over
        // swerve round it, to whichever side the bird is already on
        const ax = look.x - o.x, az = look.z - o.z, l = Math.hypot(ax, az) || 1;
        const k = ahead < 1 ? 2.5 : 1.2;
        want.x += (ax / l) * k; want.z += (az / l) * k;
      }
    }
    want.normalize();
    // arena: never leave the basin
    if (getArena()) {
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > ARENA_R - 90) {
        const k = THREE.MathUtils.clamp((r - ARENA_R + 90) / 80, 0, 1.5);
        want.x -= (this.pos.x / r) * k; want.z -= (this.pos.z / r) * k; want.normalize();
      }
    }
    want.y = THREE.MathUtils.clamp(want.y, -0.75, 0.7); want.normalize();

    // stalled: no lift, the nose drops whatever it wants
    const stall = THREE.MathUtils.clamp((STALL_SPEED + 4 - this.speed) / 6, 0, 1);
    if (stall > 0) { want.lerp(tmpA.set(this.dir.x, -1, this.dir.z), stall).normalize(); }
    // turn rate is limited by lift, which needs speed (same numbers as yours): slow birds turn wide
    const liftG = MAX_LIFT_G * Math.min(1, (this.speed / 26) ** 2);
    if (avoiding) rate = Math.max(rate, 2); // pull as hard as its wings allow
    rate = Math.min(rate, (liftG * G) / Math.max(this.speed, 12));
    const before = Math.atan2(-this.dir.x, -this.dir.z);
    turnToward(this.dir, want, rate * dt);
    const after = Math.atan2(-this.dir.x, -this.dir.z);
    let dh = after - before; if (dh > Math.PI) dh -= Math.PI * 2; if (dh < -Math.PI) dh += Math.PI * 2;
    this.heading = after;
    // bank into the turn like a real bird would
    const yawRate = dh / Math.max(dt, 1e-3);
    const bank = THREE.MathUtils.clamp(Math.atan(-yawRate * this.speed / G), -1.35, 1.35);
    this.roll += (bank - this.roll) * Math.min(1, 6 * dt);

    // speed: no engine. Gravity along the path and drag, like you: it gains speed only by diving,
    // and can flare its wings to slow down
    const brake = wantSpeed < this.speed - 6 ? Math.min(1, (this.speed - wantSpeed) / 15) : 0;
    const drag = (DRAG + BRAKE_DRAG * brake) * this.speed * this.speed;
    this.speed += (-G * this.dir.y - drag + cruiseThrust(this.pos.y)) * dt; // + arena flapping, same as yours
    this.speed = THREE.MathUtils.clamp(this.speed, 4, MAX_SPEED);

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
    if (this.remote && this.alive) this.mesh.quaternion.copy(this.quat);
    else this.mesh.rotation.set(Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1)), this.heading, -(this.roll + this.spin), 'YXZ');
    this.mesh.animate(t + this.id, this.state === 'evade' ? 0 : 0.1, this.speed, this.alive ? 0 : 0.6, this.alive ? flapAmount(this.speed) : 0);
    this.mesh.scale.setScalar(this.flash > 0 ? 1.25 : 1);
  }

  dispose(scene: THREE.Scene) { scene.remove(this.mesh); }
}

interface Pea { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; life: number; enemy: boolean; near: number; owner: string }

interface MyDart { mesh: THREE.Mesh; pos: THREE.Vector3; vel: THREE.Vector3; life: number; target: Enemy | null }

/** A homing dart fired at you. `tracking` goes false once you shake it; then it flies straight and fizzles. */
export interface Dart {
  /** the last-moment break check has been made for this dart */
  breakChecked?: boolean; by?: string; mesh: THREE.Group; pos: THREE.Vector3; dir: THREE.Vector3; speed: number; life: number; tracking: boolean; trail: number; closest: number }

export type DogfightEvent =
  | { type: 'spawn'; role: Role }
  | { type: 'turned' }
  | { type: 'overshoot' }
  | { type: 'shaken' }
  | { type: 'hitEnemy'; enemy: Enemy }
  | { type: 'kill'; role: Role; ground: boolean; enemy: Enemy }
  | { type: 'dartLocking' }
  | { type: 'dartLaunch' }
  | { type: 'dartShaken'; how: 'flare' | 'turn' | 'cloud' | 'ground' }
  | { type: 'dartHit'; by?: string }
  | { type: 'myDart' }
  | { type: 'noLock' }
  | { type: 'myDartMiss' }
  | { type: 'hitPlayer'; by: string }
  // online play: a hit on a bird another machine owns, or a dart launched at another player
  | { type: 'netHit'; enemy: Enemy; weapon: 'pea' | 'dart' }
  | { type: 'netDart'; to: string; pos: THREE.Vector3; dir: THREE.Vector3; speed: number; ai: boolean }
  | { type: 'dodged' }
  | { type: 'escaped' }
  | { type: 'wave'; wave: number; count: number }
  | { type: 'waveCleared'; wave: number };

export class Dogfight {
  enemies: Enemy[] = [];
  private peas: Pea[] = [];
  private fireCd = 0;
  private hurtT = 0; // brief grace after a hit so one burst can't take every feather
  private spawnT = 9;
  private lastRole: Role = 'prey';
  kills = 0;
  /** Arena mode: enemies per wave (0 = the endless mountain's trickle of one or two at a time). */
  arenaCount = 0;
  /** Pre-match switches: can you, and can the enemies, fire homing darts? */
  playerDarts = true;
  enemyDarts = true;
  /** False = no birds spawn at all (online with no AI birds, and on machines that aren't the host). */
  spawning = true;
  /** Online host: other players the AI birds can chase (you are always a candidate too). */
  targets: NetTarget[] = [];
  /** Called for every pea fired on this machine (yours, and AI birds' on the host), to send it to the others. */
  onShot: ((from: THREE.Vector3, vel: THREE.Vector3, owner: string) => void) | null = null;
  wave = 0;
  private waveT = 3;
  private waveLive = false;
  darts: Dart[] = [];
  private myDarts: MyDart[] = [];
  /** Your darts left, and 0..1 recharge progress toward the next one. */
  dartsLeft = MAX_DARTS;
  dartCharge = 0;
  /** Reward for risky flying: push the next dart's recharge along (1 = a whole dart). Returns true if a dart came back. */
  chargeDart(amount: number): boolean {
    if (!this.playerDarts) return false;
    if (this.dartsLeft >= MAX_DARTS) return false;
    this.dartCharge += amount;
    if (this.dartCharge >= 1) { this.dartCharge = 0; this.dartsLeft++; return true; }
    return false;
  }
  /** Enemy your darts will chase. */
  locked: Enemy | null = null;
  /** Enemy you're currently locking (before the lock completes), and progress 0..1. */
  locking: Enemy | null = null;
  lockT = 0;
  myDartThisFrame = false;
  /** 0..1: how far the closest hunter is through locking a dart onto you. */
  dartLockProgress = 0;
  /** Closest dart still tracking you, in metres (Infinity if none). */
  dartIncoming = Infinity;
  private prevDir = new THREE.Vector3();
  /** 0..1: strongest "someone is on your tail" signal this frame. */
  tailThreat = 0;
  shotThisFrame = false;
  enemyShotThisFrame = false;

  constructor(private scene: THREE.Scene, private puffs: CloudPuffs) {
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 1.8, 5);
    geo.rotateX(Math.PI / 2);
    const mine = new THREE.MeshBasicMaterial({ color: 0xfff27a, fog: false });
    const theirs = new THREE.MeshBasicMaterial({ color: 0xff4a3a, fog: false });
    const dgeo = new THREE.ConeGeometry(0.28, 1.6, 6);
    dgeo.rotateX(Math.PI / 2);
    const dmat = new THREE.MeshBasicMaterial({ color: 0x7af0ff, fog: false });
    for (let i = 0; i < MAX_DARTS + 2; i++) {
      const mesh = new THREE.Mesh(dgeo, dmat);
      mesh.visible = false; scene.add(mesh);
      this.myDarts.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, target: null });
    }
    for (let i = 0; i < 240; i++) {
      const enemy = i >= 60;
      const mesh = new THREE.Mesh(geo, enemy ? theirs : mine);
      mesh.visible = false; scene.add(mesh);
      this.peas.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, enemy, near: 99, owner: '' });
    }
  }

  private makeDart(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 1.6, 6), new THREE.MeshLambertMaterial({ color: 0x40464f }));
    body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.5, 6), new THREE.MeshBasicMaterial({ color: 0xff3b2e, fog: false }));
    tip.rotation.x = -Math.PI / 2; tip.position.z = -1.05;
    const fins = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.35), new THREE.MeshLambertMaterial({ color: 0xff3b2e }));
    fins.position.z = 0.65;
    const fins2 = fins.clone(); fins2.rotation.z = Math.PI / 2;
    g.add(body, tip, fins, fins2);
    g.scale.setScalar(1.3);
    this.scene.add(g);
    return g;
  }

  /** A dart fired at you from another machine (an AI bird on the host, or another player). */
  incomingDart(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, by: string) {
    this.darts.push({
      mesh: this.makeDart(), pos: pos.clone(), dir: dir.clone().normalize(),
      speed: Math.min(DART_SPEED, speed), life: DART_LIFE, tracking: true, trail: 0, closest: 999, by,
    });
  }

  private launchDart(e: Enemy) {
    const d: Dart = {
      // launched straight at you, carrying the hunter's speed plus a kick
      mesh: this.makeDart(), pos: e.pos.clone().addScaledVector(e.dir, 2), dir: e.seenPos.clone().sub(e.pos).normalize(),
      speed: Math.min(DART_SPEED, e.speed + 30), life: DART_LIFE, tracking: true, trail: 0, closest: 999,
    };
    this.darts.push(d);
  }

  private removeDart(d: Dart) { this.scene.remove(d.mesh); d.life = 0; }

  reset() {
    for (const e of this.enemies) e.dispose(this.scene);
    this.enemies = [];
    for (const p of this.peas) { p.life = 0; p.mesh.visible = false; }
    for (const d of this.darts) this.removeDart(d);
    this.darts = [];
    for (const d of this.myDarts) { d.life = 0; d.mesh.visible = false; }
    this.dartsLeft = this.playerDarts ? MAX_DARTS : 0; this.dartCharge = 0;
    this.locked = null; this.locking = null; this.lockT = 0;
    this.wave = 0; this.waveT = 3; this.waveLive = false;
    this.spawnT = 9; this.kills = 0; this.tailThreat = 0; this.dartLockProgress = 0; this.dartIncoming = Infinity;
  }

  private shoot(enemy: boolean, from: THREE.Vector3, vel: THREE.Vector3, owner = enemy ? 'ai' : 'me', relay = true) {
    const p = this.peas.find((q) => q.enemy === enemy && q.life <= 0);
    if (!p) return;
    p.pos.copy(from); p.vel.copy(vel); p.life = PEA_LIFE; p.near = 99; p.owner = owner;
    p.mesh.visible = true;
    if (relay) this.onShot?.(from, vel, owner);
  }

  /** A pea fired on another machine: it can hit you here (that machine never decides hits on you). */
  addPea(from: THREE.Vector3, vel: THREE.Vector3, owner: string) { this.shoot(true, from, vel, owner, false); }

  /** Online: a bird mirrored from the network (an AI bird run by the host, or another player). */
  addPuppet(kind: 'ai' | 'human', netId: string, role: Role, palette?: BirdPalette) {
    const e = new Enemy(role, this.scene, palette);
    e.remote = kind; e.netId = netId;
    this.enemies.push(e);
    return e;
  }

  /** Online host: another player hit one of the AI birds. */
  damage(e: Enemy, amount: number, by: string, out: DogfightEvent[]) {
    if (!e.alive) return;
    e.hp -= amount; e.flash = 0.12; e.alert = 3; e.jinkT = 0; e.lastHitBy = by;
    this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.2), 4, 6, 0.6);
    if (e.hp <= 0) this.kill(e, out);
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

  /** Arena: drop a bird somewhere in the basin, well away from you, heading your way. */
  private spawnArena(g: Glider, role: Role) {
    const e = new Enemy(role, this.scene);
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(150, ARENA_R - 140);
      e.pos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      let ground = terrainHeight(e.pos.x, e.pos.z);
      for (let k = 0; k < 6; k++) ground = Math.max(ground, terrainHeight(e.pos.x + rand(-40, 40), e.pos.z + rand(-40, 40)));
      e.pos.y = Math.max(ground + rand(35, 70), g.pos.y + rand(-20, 30));
      // well away from you, and not inside (or right next to) a pillar
      const clear = obstaclesNear(e.pos.x, e.pos.z, 25, nearObs).every((o) => obstacleGap(o, e.pos.x, e.pos.y, e.pos.z) > 15);
      if (clear && Math.hypot(e.pos.x - g.pos.x, e.pos.z - g.pos.z) > 260) break;
    }
    e.dir.set(g.pos.x - e.pos.x, 0, g.pos.z - e.pos.z).normalize();
    e.dir.x += rand(-0.4, 0.4); e.dir.normalize();
    e.heading = Math.atan2(-e.dir.x, -e.dir.z);
    e.speed = CRUISE_SPEED;
    e.state = role === 'hunter' ? 'attack' : 'cruise';
    e.dartCd = rand(5, 10);
    this.enemies.push(e);
  }

  /** Advance everything. `active` is false on the crash screen: enemies keep flying but hold fire.
   *  `inCloud`: you're inside a cloud, which breaks dart locks. */
  update(dt: number, t: number, me: Glider, fire: boolean, dart: boolean, active: boolean, inCloud = false): DogfightEvent[] {
    const g = me;
    const out: DogfightEvent[] = [];
    this.dartLockProgress = 0;
    this.shotThisFrame = false;
    this.myDartThisFrame = false;
    this.enemyShotThisFrame = false;

    // ---- spawning: one at a time to start, two once you've got a couple of kills
    const max = this.kills >= 2 ? 2 : 1;
    const aliveN = this.enemies.filter((e) => e.alive && !e.remote).length;
    if (!this.spawning) { /* online: the host's birds only */ }
    else if (this.arenaCount > 0) {
      // arena: waves. Clear one and the next comes in a few seconds later.
      if (this.waveLive && aliveN === 0) { this.waveLive = false; this.waveT = 5; out.push({ type: 'waveCleared', wave: this.wave }); }
      if (active && !this.waveLive) {
        this.waveT -= dt;
        if (this.waveT <= 0) {
          this.wave++; this.waveLive = true;
          // roughly 60% hunters; a lone bird is always a hunter
          for (let i = 0; i < this.arenaCount; i++) this.spawnArena(g, i === 0 || Math.random() < 0.6 ? 'hunter' : 'prey');
          out.push({ type: 'wave', wave: this.wave, count: this.arenaCount });
        }
      }
    } else if (active && aliveN < max) {
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
    const meActive = active, meInCloud = inCloud;
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
      if (e.remote) continue; // flown by the network
      // online: chase the closest player (sticking with its current one unless another is much closer)
      const tgt = this.pickTarget(e, me, meActive, meInCloud);
      if (!tgt) { e.fly(dt, e.dir.clone().setY(0).normalize(), CRUISE_SPEED, 0.6, 16); continue; }
      const g = tgt.g, isMe = tgt.g === me;
      const active = tgt.active, inCloud = tgt.inCloud;
      const toPlayer = tmpA.copy(g.pos).sub(e.pos);
      const dist = toPlayer.length();
      const fromPlayer = tmpB.copy(toPlayer).multiplyScalar(-1 / Math.max(dist, 1e-3));
      const playerAimErr = g.dir.angleTo(fromPlayer);     // how close you are to having it in your sights
      e.alert = Math.max(0, e.alert - dt);
      if (dist < 170 && playerAimErr < 0.3) e.alert = 2.5;   // it sees you lining up
      const threatened = (dist < 140 && playerAimErr < 0.5) || (e.alert > 0 && dist < 200);
      const behindYou = g.dir.dot(fromPlayer) < -0.3;

      // a bandit that ends up on your tail turns and fights
      if (e.role === 'prey' && behindYou && dist < 90 && !threatened) { e.role = 'hunter'; if (isMe) out.push({ type: 'turned' }); }

      // perception lags your real movement by roughly half a second
      if (!e.seenInit) { e.seenPos.copy(g.pos); e.seenVel.copy(g.vel); e.seenInit = true; }
      const k = Math.min(1, dt / 0.3); // reacts to your moves about 0.3 s late
      e.seenPos.addScaledVector(e.seenVel, dt).lerp(g.pos, k);
      e.seenVel.lerp(g.vel, k);
      e.lostT = Math.max(0, e.lostT - dt);
      e.breakT = Math.max(0, e.breakT - dt);
      // a dodge roll right in front of a close hunter makes it lose you
      if (e.role === 'hunter' && g.trick && g.trick.dodge > 10 && behindYou && dist < 70 && e.lostT <= 0) {
        e.lostT = 2.5; if (isMe) out.push({ type: 'shaken' });
      }

      const want = new THREE.Vector3();
      let wantSpeed = g.speed;
      let rate = 1.25;
      // slam the brakes with a hunter close behind and it overshoots
      e.overT = Math.max(0, e.overT - dt);
      if (e.role === 'hunter' && e.overT <= 0 && g.brake > 0.6 && behindYou && dist < 45) {
        e.overT = 1.6; if (isMe) out.push({ type: 'overshoot' });
      }
      const evade = threatened && (e.role === 'prey' || dist < 100);
      e.state = evade ? 'evade' : e.role === 'hunter' ? 'attack' : 'cruise';

      if (e.breakT > 0) {
        // dart inbound: snap hard across its path, faster than the dart can follow
        want.copy(e.breakDir); rate = 3.6; wantSpeed = Math.max(g.speed, e.speed);
        e.state = 'evade'; e.aimAtPlayer = 0; e.dartLock = 0;
      } else if (e.overT > 0) {
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
        }
        want.copy(e.jink);
        rate = 1.7;
        wantSpeed = Math.max(28, g.speed * (e.role === 'prey' ? 0.9 : 1.0)); // jinking bleeds speed
      } else if (e.state === 'attack' && e.lostT > 0) {
        e.dartLock = 0;
        // lost you: carries on wide in a lazy turn, then comes looking again
        // (turns away from where it last saw you and bleeds speed, so you open up a real gap)
        const away = tmpC.set(-e.dir.z, 0, e.dir.x).multiplyScalar(e.id % 2 ? 1 : -1);
        want.copy(e.dir).addScaledVector(away, 0.8).normalize();
        wantSpeed = g.speed - 10; rate = 0.6; e.aimAtPlayer = 0;
      } else if (e.state === 'attack') {
        // chases where it *saw* you: lag pursuit from range, lead pursuit when close enough to shoot
        const seenDir = tmpC.copy(e.seenVel).normalize();
        if (dist > 110) want.copy(e.seenPos).addScaledVector(seenDir, -22).addScaledVector(e.seenVel, 0.6).sub(e.pos).normalize();
        else want.copy(e.seenPos).addScaledVector(e.seenVel, dist / (ENEMY_PEA_SPEED + e.speed)).sub(e.pos).normalize();
        wantSpeed = g.speed + THREE.MathUtils.clamp((dist - 30) * 0.5, -14, 30);
        // wider than your best turn, and wider still when it's fast: a hard break gains you angle
        rate = 0.85 - Math.max(0, e.speed - 42) * 0.01; // (the lift limit in fly() is the real cap, same as yours)
        const aimErr = e.dir.angleTo(want);
        // break hard enough that you slide out of its view and it loses you
        if (dist < 120 && e.dir.angleTo(toPlayer) > 0.55) { e.lostT = 2.5; if (isMe) out.push({ type: 'shaken' }); }
        e.aimAtPlayer = dist < 120 ? THREE.MathUtils.clamp(1 - aimErr / 0.4, 0, 1) : 0;
        if (isMe && behindYou && dist < 150) this.tailThreat = Math.max(this.tailThreat, Math.max(0.35, e.aimAtPlayer));
        // short bursts
        e.fireCd -= dt;
        if (active && e.fireCd <= 0 && dist < 130 && aimErr < 0.1) {
          const spread = tmpC.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.035);
          const aim = e.dir.clone(); turnToward(aim, want, ASSIST_BEND); // the same ~3° bend your aim assist gets
          const v = aim.add(spread).normalize().multiplyScalar(ENEMY_PEA_SPEED).addScaledVector(e.dir, e.speed);
          this.shoot(true, e.pos.clone().addScaledVector(e.dir, 1.5), v);
          this.enemyShotThisFrame = true;
          e.burst++;
          e.fireCd = e.burst >= 5 ? rand(0.9, 1.6) : 0.1; // same fire rate as yours, in bursts
          if (e.burst >= 5) e.burst = 0;
        }
        // dart lock: keep you inside its cone, at range, out of the clouds, and it launches a dart
        e.dartCd -= dt;
        const inCone = e.dir.angleTo(toPlayer) < DART_CONE && dist > DART_RANGE_MIN && dist < DART_RANGE_MAX && !inCloud;
        if (active && this.enemyDarts && e.dartCd <= 0 && inCone) {
          if (e.dartLock === 0 && isMe) out.push({ type: 'dartLocking' });
          e.dartLock += dt;
          if (e.dartLock >= DART_LOCK_TIME) {
            if (isMe) { this.launchDart(e); out.push({ type: 'dartLaunch' }); }
            else out.push({ type: 'netDart', to: tgt.id, pos: e.pos.clone().addScaledVector(e.dir, 2), dir: e.seenPos.clone().sub(e.pos).normalize(), speed: Math.min(DART_SPEED, e.speed + 30), ai: true });
            e.dartLock = 0; e.dartCd = DART_RELOAD;
          }
        } else e.dartLock = Math.max(0, e.dartLock - dt * 2); // lose it and the lock unwinds
        if (isMe) this.dartLockProgress = Math.max(this.dartLockProgress, e.dartLock / DART_LOCK_TIME);
      } else if (getArena()) {
        // arena bandit: circle the basin low, keeping its distance from you
        const r = Math.hypot(e.pos.x, e.pos.z) || 1;
        const side = e.id % 2 ? 1 : -1;
        want.set((-e.pos.z / r) * side, 0, (e.pos.x / r) * side).addScaledVector(tmpC.set(e.pos.x / r, 0, e.pos.z / r), (320 - r) / 200);
        want.y = (terrainHeight(e.pos.x, e.pos.z) + 35 - e.pos.y) * 0.01;
        want.normalize();
        wantSpeed = CRUISE_SPEED; rate = 0.9;
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

      if (dist > 520 && !getArena() && !this.targets.length) { e.alive = false; e.dying = 99; out.push({ type: 'escaped' }); }
    }

    // ---- your pea shooter
    this.fireCd -= dt;
    this.hurtT -= dt;
    if (active && fire && this.fireCd <= 0) {
      this.fireCd = 0.1;
      const muzzle = g.pos.clone().addScaledVector(g.dir, 1.6);
      // light aim assist: with a bird within ~8° of your nose, the stream bends up to ~3° toward
      // where it will be (you still have to point at it; it can't follow a hard break)
      const aim = g.dir.clone();
      let assist: Enemy | null = null, bestErr = ASSIST_CONE;
      for (const e of this.enemies) {
        if (!e.alive || e.friendly) continue;
        const d = tmpA.copy(e.pos).sub(muzzle); const dist = d.length();
        if (dist > ASSIST_RANGE) continue;
        const err = g.dir.angleTo(d);
        if (err < bestErr) { bestErr = err; assist = e; }
      }
      if (assist) {
        const T = assist.pos.distanceTo(muzzle) / (PEA_SPEED + g.speed);
        const ev = assist.vel.clone(); // (vel reuses a scratch vector)
        const lead = assist.pos.clone().addScaledVector(ev, T).sub(muzzle).normalize();
        turnToward(aim, lead, ASSIST_BEND);
      }
      const v = aim.multiplyScalar(PEA_SPEED).add(g.vel);
      this.shoot(false, muzzle, v);
      this.shotThisFrame = true;
    }

    // ---- lock-on: hold your nose on an enemy for a moment
    let best: Enemy | null = null, bestErr = LOCK_CONE;
    for (const e of this.enemies) {
      if (!e.alive || e.friendly) continue;
      const d = tmpA.copy(e.pos).sub(g.pos); const dist = d.length();
      if (dist > LOCK_RANGE * 1.25) continue;
      const err = g.dir.angleTo(d);
      if (e === this.locked && err < LOCK_KEEP) { best = e; break; }
      if (dist < LOCK_RANGE && err < bestErr) { best = e; bestErr = err; }
    }
    if (!active) best = null;
    if (best && best === this.locked) { /* keep */ }
    else if (best && best === this.locking) { this.lockT += dt; if (this.lockT >= LOCK_TIME) this.locked = best; }
    else { this.locking = best; this.lockT = 0; this.locked = null; }
    if (this.locked && !this.locked.alive) this.locked = null;

    // ---- your homing darts: need a lock, limited ammo that recharges
    if (this.dartsLeft < MAX_DARTS) {
      this.dartCharge += dt / MY_DART_RECHARGE;
      if (this.dartCharge >= 1) { this.dartCharge = 0; this.dartsLeft++; }
    } else this.dartCharge = 0;
    if (active && dart) {
      const free = this.myDarts.find((d) => d.life <= 0);
      if (!this.locked) out.push({ type: 'noLock' });
      else if (this.dartsLeft > 0 && free) {
        this.dartsLeft--;
        free.pos.copy(g.pos).addScaledVector(g.dir, 1.6);
        free.vel.copy(g.dir).multiplyScalar(MY_DART_SPEED).add(g.vel);
        free.life = MY_DART_LIFE; free.target = this.locked; free.mesh.visible = true;
        this.myDartThisFrame = true;
        out.push({ type: 'myDart' });
        // another player: their machine flies the dart at them, by the same rules as a dart fired at you
        if (this.locked.remote === 'human') out.push({ type: 'netDart', to: this.locked.netId, pos: free.pos.clone(), dir: g.dir.clone(), speed: Math.min(DART_SPEED, g.speed + 30), ai: false });
      }
    }
    const mprev = new THREE.Vector3();
    for (const d of this.myDarts) {
      if (d.life <= 0) continue;
      d.life -= dt;
      const tg = d.target;
      if (tg && tg.alive) {
        const sp = d.vel.length();
        const to = tmpA.copy(tg.pos).sub(d.pos);
        const dist = to.length();
        // the target sees it coming: break hard across the dart's path, then roll when it's close
        if (dist < 90 && tg.breakT <= 0) {
          const side = tmpC.crossVectors(d.vel, UP).normalize().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
          tg.breakDir.copy(side).addScaledVector(d.vel.clone().normalize(), 0.15); tg.breakDir.y += rand(-0.35, 0.2); tg.breakDir.normalize();
          tg.breakT = 1.3;
        }
        // no barrel rolls any more: it only gets away if its break takes it outside the dart's turn
        if (dist < 50 && tmpB.copy(d.vel).normalize().angleTo(tmpC.copy(to).normalize()) > 1.2) d.target = null;
        else {
          const dir = tmpB.copy(d.vel).normalize();
          turnToward(dir, to.normalize(), MY_DART_TURN * dt);
          d.vel.copy(dir).multiplyScalar(Math.max(sp, MY_DART_SPEED + 20));
        }
      }
      mprev.copy(d.pos);
      d.pos.addScaledVector(d.vel, dt);
      let ended = d.pos.y < terrainHeight(d.pos.x, d.pos.z);
      for (const e of this.enemies) {
        if (!e.alive || ended) continue;
        if (segDist(mprev, d.pos, e.pos) < MY_DART_HIT_R) {
          ended = true;
          if (e.remote) { if (e.remote === 'ai') out.push({ type: 'netHit', enemy: e, weapon: 'dart' }); continue; }
          e.hp = 0; e.flash = 0.2; e.lastHitBy = 'me';
          this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.2), 6, 10, 0.7);
          out.push({ type: 'hitEnemy', enemy: e });
          this.kill(e, out);
        }
      }
      if (ended) d.life = 0;
      else if (d.life <= 0) out.push({ type: 'myDartMiss' });
      if (d.life <= 0) d.mesh.visible = false;
      else { d.mesh.position.copy(d.pos); d.mesh.lookAt(tmpA.copy(d.pos).add(d.vel)); }
    }

    // ---- peas
    const prev = new THREE.Vector3();
    for (const p of this.peas) {
      if (p.life <= 0) continue;
      p.life -= dt;
      prev.copy(p.pos);
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < terrainHeight(p.pos.x, p.pos.z)) { p.life = 0; }
      if (!p.enemy) {
        for (const e of this.enemies) {
          if (!e.alive || e.friendly) continue;
          if (segDist(prev, p.pos, e.pos) < ENEMY_HIT_R) {
            // another machine's bird: tell it (AI birds) or let that player's own copy of the pea decide
            if (e.remote) { p.life = 0; e.flash = 0.12; if (e.remote === 'ai') out.push({ type: 'netHit', enemy: e, weapon: 'pea' }); break; }
            p.life = 0; e.hp--; e.lastHitBy = 'me'; e.flash = 0.12; e.alert = 3; e.jinkT = 0;
            this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.2), 4, 6, 0.6);
            out.push({ type: 'hitEnemy', enemy: e });
            if (e.hp <= 0) this.kill(e, out);
            break;
          }
        }
      } else if (active) {
        const d = segDist(prev, p.pos, g.pos);
        p.near = Math.min(p.near, d);
        if (g.trick && d < 3.5) { out.push({ type: 'dodged' }); p.life = 0; }   // a barrel roll shrugs off the burst
        else if (d < PLAYER_HIT_R) { if (this.hurtT <= 0) { out.push({ type: 'hitPlayer', by: p.owner }); this.hurtT = 0.8; } p.life = 0; }
      }
      if (p.life <= 0) p.mesh.visible = false;
      else { p.mesh.position.copy(p.pos); p.mesh.lookAt(tmpA.copy(p.pos).add(p.vel)); }
    }

    // ---- darts: home in with a limited turn rate. Shake them with a barrel roll as they close,
    // a break harder than they can follow, a cloud, or by leading them into the ground.
    this.dartIncoming = Infinity;
    // how hard you're turning right now (rad/s): a last-moment hard break is how you beat a dart by flying
    const turnRate = this.prevDir.lengthSq() > 0 ? this.prevDir.angleTo(g.dir) / Math.max(dt, 1e-3) : 0;
    this.prevDir.copy(g.dir);
    for (const d of this.darts) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.speed = Math.min(DART_SPEED, d.speed + 30 * dt);
      const to = tmpA.copy(g.pos).sub(d.pos);
      const dist = to.length();
      if (d.tracking && active) {
        to.normalize();
        const off = d.dir.angleTo(to);
        if (inCloud) { d.tracking = false; out.push({ type: 'dartShaken', how: 'cloud' }); }
        else if (g.brake > 0.6 && dist < 16) { d.tracking = false; out.push({ type: 'dartShaken', how: 'flare' }); }   // flare hard and it shoots past
        else if (!d.breakChecked && dist < 25 && turnRate > 0.8 && (d.breakChecked = true)
          && Math.random() < THREE.MathUtils.clamp((turnRate - 0.8) / 0.8, 0.3, 0.85)) { d.tracking = false; out.push({ type: 'dartShaken', how: 'turn' }); }   // you broke past its turn
        else {
          // aim a little ahead of you, turn no faster than it can
          const lead = tmpB.copy(g.pos).addScaledVector(g.vel, Math.min(0.6, dist / (d.speed + 1) * 0.5)).sub(d.pos).normalize();
          turnToward(d.dir, lead, DART_TURN * dt);
          this.dartIncoming = Math.min(this.dartIncoming, dist);
        }
      } else if (!active) d.tracking = false;
      if (!d.tracking) d.life = Math.min(d.life, 1.5);
      const prev = d.pos.clone(); // (segDist uses the tmp vectors itself)
      d.pos.addScaledVector(d.dir, d.speed * dt);
      if (d.tracking && active && segDist(prev, d.pos, g.pos) < DART_HIT_R) {
        out.push({ type: 'dartHit', by: d.by }); this.hurtT = 0.8; // a dart always lands, even right after a pea hit
        this.puffs.burst(d.pos, tmpA.set(0, 2, 0), 5, 14, 0.8);
        this.removeDart(d); continue;
      }
      if (d.pos.y < terrainHeight(d.pos.x, d.pos.z) + 0.3) {
        if (d.tracking) out.push({ type: 'dartShaken', how: 'ground' });
        this.puffs.burst(d.pos, tmpA.set(0, 5, 0), 5, 14, 0.9);
        this.removeDart(d); continue;
      }
      // smoke trail so you can see it coming
      d.trail -= dt;
      if (d.trail <= 0) { d.trail = 0.03; this.puffs.burst(d.pos, tmpB.set(0, 0.5, 0), 0.6, 1, d.tracking ? 0.55 : 0.35); }
      if (d.life <= 0) { this.puffs.burst(d.pos, tmpA.set(0, 1, 0), 2, 4, 0.5); this.removeDart(d); continue; }
      d.mesh.position.copy(d.pos);
      d.mesh.lookAt(tmpA.copy(d.pos).sub(d.dir));
      d.mesh.rotateZ(t * 12);
    }
    this.darts = this.darts.filter((d) => d.life > 0);
    if (this.dartIncoming < 200) this.tailThreat = Math.max(this.tailThreat, 1);

    // ---- crashes, clean-up, drawing
    for (const e of this.enemies) {
      if (e.remote) { /* its own machine decides */ }
      else if (e.alive && e.pos.y <= terrainHeight(e.pos.x, e.pos.z) + 2.6 && e.state === 'evade' && e.dir.y < -0.3) {
        // chased into the ground
        this.kill(e, out, true);
      } else if (e.alive && hitsObstacle(e.pos)) {
        // flew into a tree, rock or pillar: same rules as you. It only counts as your kill if you chased it there.
        if (e.state === 'evade' || e.pos.distanceTo(g.pos) < 120) this.kill(e, out, true);
        else { e.alive = false; e.dying = 0.001; this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.3), 8, 22, 0.9); }
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

  /** Which player this AI bird goes after: you, or (online, on the host) the closest other player. */
  private pickTarget(e: Enemy, me: Glider, meActive: boolean, meInCloud: boolean) {
    const mine = { id: 'me', g: me as FlyTarget, active: meActive, inCloud: meInCloud };
    if (!this.targets.length) return mine;
    let best: typeof mine | null = null, bestD = Infinity;
    const consider = (c: typeof mine) => {
      let d = c.g.pos.distanceTo(e.pos);
      if (c.id === e.targetId) d *= 0.6; // sticky: don't flip-flop between two players
      if (d < bestD) { bestD = d; best = c; }
    };
    if (meActive) consider(mine);
    for (const tg of this.targets) if (tg.active) consider({ id: tg.id, g: tg, active: true, inCloud: tg.inCloud });
    const b = best as typeof mine | null;
    if (b && b.id !== e.targetId) { e.targetId = b.id; e.seenInit = false; e.dartLock = 0; }
    if (!b) e.targetId = '';
    return b;
  }

  private kill(e: Enemy, out: DogfightEvent[], ground = false) {
    e.alive = false; e.dying = 0.001; e.rollT = 0;
    this.kills++;
    this.puffs.burst(e.pos, e.vel.clone().multiplyScalar(0.3), 8, 22, 0.9);
    out.push({ type: 'kill', role: e.role, ground, enemy: e });
    this.spawnT = Math.min(this.spawnT, rand(5, 9));
  }
}

/** What an AI bird needs to know about whoever it's chasing (your Glider has all of this). */
export type FlyTarget = Pick<Glider, 'pos' | 'vel' | 'dir' | 'speed' | 'brake' | 'trick'>;
/** Another player, as the host's AI birds see them. */
export interface NetTarget {
  id: string; pos: THREE.Vector3; vel: THREE.Vector3; dir: THREE.Vector3; speed: number; brake: number;
  trick: null; active: boolean; inCloud: boolean;
}

/** Distance from point c to segment ab. */
const segAB = new THREE.Vector3(), segAC = new THREE.Vector3();
function segDist(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  // own scratch vectors, so callers can pass the shared tmp vectors safely
  const ab = segAB.copy(b).sub(a);
  const t = THREE.MathUtils.clamp(segAC.copy(c).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
  return segAC.copy(a).addScaledVector(ab, t).distanceTo(c);
}
