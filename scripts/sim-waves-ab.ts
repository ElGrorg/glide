// A/B: the same number of birds at skill 0 vs skill 1 (same stats), against the same weaving target.
// npx tsx scripts/sim-waves-ab.ts
import './dom-stub';
import * as THREE from 'three';
import { setArena, ARENAS, terrainHeight } from '../src/world';
import { setWorldSeed } from '../src/noise';
import { Dogfight } from '../src/dogfight';
import { CloudPuffs } from '../src/puffs';

setWorldSeed(1234); setArena(ARENAS[0]);
const scene = new THREE.Scene();
function run(skill: number, seed: number) {
  let s = seed; Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const df = new Dogfight(scene, new CloudPuffs(scene) as never);
  df.arenaCount = 6; df.enemyDarts = false;
  const me = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), speed: 36, brake: 0, trick: null };
  let t = 0, shots = 0, hits = 0, aimed = 0, shaken = 0, ground = 0;
  const dt = 1 / 60;
  const move = () => {
    const a = t * 0.16, r = 260 + 60 * Math.sin(t * 0.7);
    const np = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    np.y = terrainHeight(np.x, np.z) + 70 + 20 * Math.sin(t * 1.3);
    if (t > 0) { me.vel.copy(np).sub(me.pos).divideScalar(dt); me.speed = me.vel.length(); me.dir.copy(me.vel).normalize(); }
    me.pos.copy(np);
  };
  move();
  while (t < 120) {
    t += dt; move();
    const evs = df.update(dt, t, me as never, false, false, true, false);
    for (const ev of evs) {
      if (ev.type === 'wave') for (const e of df.enemies) e.skill = skill;
      if (ev.type === 'hitPlayer') hits++;
      if (ev.type === 'shaken') shaken++;
      if (ev.type === 'kill' && ev.ground) ground++;
    }
    if (df.enemyShotThisFrame) shots++;
    aimed += df.enemies.filter((e) => e.alive && e.aimAtPlayer > 0.5).length * dt;
  }
  return { shots, hits, aimed, shaken, ground };
}
for (const sk of [0, 0.5, 1]) {
  const r = [11, 22, 33, 44].map((seed) => run(sk, seed));
  const sum = (k: keyof ReturnType<typeof run>) => r.reduce((a, b) => a + b[k], 0) / r.length;
  console.log(`skill ${sk}: shot-frames ${sum('shots').toFixed(0)}, hits ${sum('hits').toFixed(1)}, bird-seconds aimed at you ${sum('aimed').toFixed(1)}, shaken ${sum('shaken').toFixed(1)}, into ground ${sum('ground').toFixed(1)}`);
}
