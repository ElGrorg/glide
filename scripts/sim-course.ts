import './dom-stub';
// Autopilot fly-test for the time trial courses: flies every route with the real flight model and reports
// time, splits, slowest speed and any crash. Run: npx tsx scripts/sim-course.ts [courseId] [clearance]
import { Glider } from '../src/bird';
import { terrainHeight, setCourse, getCourse, solidClearance, floorBelow, obstaclesNear, obstacleGap, type Obstacle } from '../src/world';
import { COURSES } from '../src/courses';
import { gateCrossed } from '../src/course';
import type { InputState } from '../src/input';
import * as THREE from 'three';

const want = process.argv[2];
const CLEAR = Number(process.argv[3] ?? 3);
const FREE = process.argv[4] === 'free';
const ROLL_SIGN = Number(process.env.RS ?? 1);
const inp: InputState = { pitch: 0, roll: 0, yaw: 0, rollRate: process.argv[4] === 'free', brake: 0, boost: 0, view: false, tuck: 0, fire: false, dart: false, aimX: 0, aimY: 0, anyPress: false, trick: null, source: 'keyboard', nav: { x: 0, y: 0, ok: false, back: false, menu: false }, chat: null, chatToggle: false };
const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
const near: Obstacle[] = [];

for (const def of COURSES) {
  if (want && def.id !== want) continue;
  const t0 = Date.now();
  setCourse(def);
  const c = getCourse()!;
  console.log(`\n=== ${def.name} (${def.id}) built in ${Date.now() - t0} ms`);
  for (const p of c.paths) {
    const sm = p.sm; let minR = Infinity, at = 0;
    for (let i = 6; i < sm.n - 6; i++) {
      const a1 = Math.atan2(sm.x[i] - sm.x[i - 6], sm.z[i] - sm.z[i - 6]), a2 = Math.atan2(sm.x[i + 6] - sm.x[i], sm.z[i + 6] - sm.z[i]);
      const r = 24 / Math.max(1e-4, Math.abs(wrap(a2 - a1)));
      if (r < minR) { minR = r; at = i / sm.n; }
    }
    if (p.kind === 'cave') {
      // the rock over a cave should be solid all the way (no accidental skylights), apart from the portals
      let thin = Infinity, at2 = 0;
      for (let i = 10; i < sm.n - 10; i++) for (const lat of [-1, 0, 1]) {
        const rl = Math.hypot(p.tx[i], p.tz[i]) || 1;
        const x = sm.x[i] - p.tz[i] / rl * lat * sm.w[i], z = sm.z[i] + p.tx[i] / rl * lat * sm.w[i];
        const cover = terrainHeight(x, z) - (sm.y[i] + sm.h[i]);
        if (cover < thin) { thin = cover; at2 = i / sm.n; }
      }
      if (thin < 6) console.log(`  thin roof: ${p.def.id} only ${thin.toFixed(1)} m of rock at ${(at2 * 100).toFixed(0)}%`);
    }
    if (minR < 160) console.log(`  tight bend: ${p.def.id} (${p.kind}, w ${sm.w[Math.round(at * sm.n)].toFixed(0)}) radius ${minR.toFixed(0)} m at ${(at * 100).toFixed(0)}%`);
  }
  def.routes.forEach((r, ri) => {
    const line = c.routeLine(ri);
    // a racing line round the set pieces: push the line sideways past each column / spire / boulder, smoothly
    const off = line.map(() => [0, 0]);
    for (let i = 0; i < line.length - 1; i++) {
      const q = line[i], qn = line[i + 1];
      let px = -(qn.z - q.z), pz = qn.x - q.x; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
      for (const o of obstaclesNear(q.x, q.z, 16, near)) {
        if (o.type === 'tree') continue;
        const lat = (q.x - o.x) * px + (q.z - o.z) * pz, along = (q.x - o.x) * pz - (q.z - o.z) * px;
        if (Math.abs(along) > 3) continue;
        const need = o.r + 6 - Math.abs(lat);
        if (need <= 0) continue;
        const side = lat >= 0 ? 1 : -1;
        for (let j = Math.max(0, i - 12); j <= Math.min(line.length - 1, i + 12); j++) {
          const f = 0.5 + 0.5 * Math.cos(Math.PI * (j - i) / 13);
          const v = need * side * f;
          if (Math.abs(v) > Math.hypot(off[j][0], off[j][1])) off[j] = [px * v, pz * v];
        }
      }
    }
    line.forEach((p, i) => { p.x += off[i][0]; p.z += off[i][1]; });
    const g = new Glider();
    g.reset(def.start.x, def.start.y, def.start.z, def.start.heading);
    g.speed = def.start.speed;
    const dt = 1 / 60;
    let brakeT = 0; let t = 0, started = -1, idx = 0, minV = 999, minClr = 99, crash = '', next = 0;
    const gates = [...def.splits, def.finish];
    const splits: string[] = [];
    let minVAt = '';
    const prev = g.pos.clone();
    while (t < 400) {
      // nearest line index (search forward)
      let best = Infinity;
      for (let i = idx; i < Math.min(line.length, idx + 40); i++) {
        const d = (line[i].x - g.pos.x) ** 2 + (line[i].z - g.pos.z) ** 2 + (line[i].y - g.pos.y) ** 2 * 0.2;
        if (d < best) { best = d; idx = i; }
      }
      const here = line[idx];
      const look = Math.max(5, Math.round(g.speed * 0.7 / 4));
      // brake for the bends: a classic bank turns on a radius of about v^2 / 27 m, so slow to make the
      // tightest bend in the next ~100 m (a real pilot does the same)
      let rMin = Infinity;
      for (let k = 2; k < 28; k++) {
        const a = line[Math.min(line.length - 1, idx + k - 3)], b = line[Math.min(line.length - 1, idx + k)], c2 = line[Math.min(line.length - 1, idx + k + 3)];
        const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c2.x - b.x, c2.z - b.z);
        const r = 12 / Math.max(1e-4, Math.abs(wrap(h2 - h1)));
        rMin = Math.min(rMin, r + k * 4 * 0.2); // further bends allow a little more speed for now
      }
      const vMax = FREE ? Math.sqrt(60 * rMin) : Math.sqrt(27 * rMin * 0.8);
      inp.brake = g.speed > vMax + 1 ? Math.min(1, (g.speed - vMax) / 6) : 0;
      if (inp.brake > 0) brakeT += 1 / 60;
      const tp0 = line[Math.min(line.length - 1, idx + look)];
      const tp = { ...tp0 };
      // pure pursuit cuts the inside of a bend by about L^2 / 2R: aim that much wide of the line to hold it
      {
        const m = Math.min(line.length - 4, idx + Math.round(look / 2)), a0 = line[Math.max(0, m - 3)], b0 = line[m], c0 = line[m + 3];
        const h1 = Math.atan2(b0.x - a0.x, b0.z - a0.z), h2 = Math.atan2(c0.x - b0.x, c0.z - b0.z);
        const curv = wrap(h2 - h1) / 12; // signed 1/R
        const L = look * 4;
        const shift = Math.max(-8, Math.min(8, 0.5 * L * L * curv * 0.8));
        const hx = c0.x - a0.x, hz = c0.z - a0.z, hl = Math.hypot(hx, hz) || 1;
        // atan2(x, z) increases turning toward +x of a heading... push opposite to the turn
        tp.x += (hz / hl) * shift; tp.z -= (hx / hl) * shift;
      }
      const clr = tp.kind === 'cave' ? Math.min(CLEAR + 1, tp.h * 0.3) : CLEAR;
      // look along the line ahead and along the nose for the highest ground coming up
      let fl = floorBelow(tp.x, tp.y + 3, tp.z);
      for (let k = 1; k <= look; k += 2) { const q = line[Math.min(line.length - 1, idx + k)]; fl = Math.max(fl, floorBelow(q.x, q.y + 3, q.z)); }
      for (let k = 4; k <= 40; k += 4) { const x = g.pos.x + g.dir.x * k, z = g.pos.z + g.dir.z * k; const y = g.pos.y + g.dir.y * k + 2; if (solidClearance(x, y, z) > 0) fl = Math.max(fl, floorBelow(x, y, z)); }
      const ty = fl + clr;
      const dx = tp.x - g.pos.x, dz = tp.z - g.pos.z, hd = Math.hypot(dx, dz);
      const wantH = Math.atan2(-dx, -dz);
      const e = wrap(wantH - g.heading);
      if (!FREE) {
        inp.roll = Math.max(-1, Math.min(1, -e * 3.5));
        const hereFloor = floorBelow(g.pos.x, g.pos.y, g.pos.z);
        const hErr = Math.max(-6, Math.min(6, Math.max(hereFloor, fl) + clr - g.pos.y));
        const wantP = Math.atan2(ty - g.pos.y, hd) + hErr * 0.03;
        inp.pitch = Math.max(-1, Math.min(1, (wantP - g.pitch) * 4 - g.pitchVel * 0.6));
      } else {
        // flight-stick pilot: roll the lift onto the turn, then pull (bank and yank)
        const to = new THREE.Vector3(tp.x - g.pos.x, ty - g.pos.y, tp.z - g.pos.z).normalize();
        const fwd = g.dir, up = g.up;
        // bank toward the sideways part of the target only; up and down is the elevator's job
        const side = new THREE.Vector3(-fwd.z, 0, fwd.x).normalize(); // right, level
        const lat = to.dot(side);
        const wantUp = side.clone().multiplyScalar(Math.max(-2.5, Math.min(2.5, lat * 5)));
        wantUp.y += 1;
        wantUp.addScaledVector(fwd, -wantUp.dot(fwd)).normalize();
        const rollErr = Math.atan2(new THREE.Vector3().crossVectors(up, wantUp).dot(fwd), up.dot(wantUp));
        inp.roll = Math.max(-1, Math.min(1, ROLL_SIGN * rollErr * 1.3 - g.rollVel * 0.35));
        const pull = to.dot(up);
        inp.pitch = Math.max(-1, Math.min(1, pull * 7 - g.pitchVel * 0.3));
      }
      prev.copy(g.pos);
      if (process.env.TRACE && Math.round(t * 60) % 15 === 0 && ri === 0) console.log(`t ${t.toFixed(2)} pos ${g.pos.x.toFixed(1)},${g.pos.y.toFixed(1)},${g.pos.z.toFixed(1)} tp ${tp.x.toFixed(1)},${ty.toFixed(1)},${tp.z.toFixed(1)} v ${g.speed.toFixed(1)} up ${g.up.x.toFixed(2)},${g.up.y.toFixed(2)},${g.up.z.toFixed(2)} in ${inp.roll.toFixed(2)},${inp.pitch.toFixed(2)}`);
      g.step(dt, inp);
      t += dt;
      if (started < 0 && gateCrossed(def.startGate, prev, g.pos)) started = t;
      if (started >= 0 && next < gates.length && gateCrossed(gates[next], prev, g.pos)) {
        splits.push((t - started).toFixed(1)); next++;
        if (next === gates.length) break;
      }
      if (g.speed < minV) { minV = g.speed; minVAt = `${(idx / line.length * 100).toFixed(0)}%`; }
      const sc = solidClearance(g.pos.x, g.pos.y, g.pos.z);
      minClr = Math.min(minClr, sc);
      if (sc < 0.45) { crash = `v=${g.speed.toFixed(0)} pitch=${g.pitch.toFixed(2)} roll=${g.roll.toFixed(2)} line=${line[idx].x.toFixed(0)},${line[idx].y.toFixed(0)},${line[idx].z.toFixed(0)} start=${started.toFixed(1)} rock at ${g.pos.x.toFixed(0)},${g.pos.y.toFixed(0)},${g.pos.z.toFixed(0)} (${(idx / line.length * 100).toFixed(0)}% ${tp.kind})`; break; }
      for (const o of obstaclesNear(g.pos.x, g.pos.z, 14, near)) if (obstacleGap(o, g.pos.x, g.pos.y, g.pos.z) < 0.5) { crash = `${o.type} ${o.id} at ${(idx / line.length * 100).toFixed(0)}%`; break; }
      if (crash) break;
      if (idx >= line.length - 2 && next < gates.length) { crash = `reached the end without gate ${next}`; break; }
    }
    const len = line.reduce((s, p, i) => i ? s + Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y, p.z - line[i - 1].z) : 0, 0);
    console.log(`route ${ri} "${r.name}": ${(len / 1000).toFixed(2)} km, ${crash ? 'CRASH ' + crash : 'finished'} | splits ${splits.join(' / ')} | min speed ${minV.toFixed(1)} m/s @${minVAt} | braking ${brakeT.toFixed(1)} s | avg ${(len / Math.max(1, t - Math.max(0, started))).toFixed(1)}`);
  });
}
