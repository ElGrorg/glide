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
const KICKS = process.env.NOKICK ? false : true;
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
  // forks and merges: a branch should leave / arrive within ~25 deg of the path it splits from / joins
  const head = (id: string, end: boolean) => {
    const sm = c.byId.get(id)!.sm, ext = c.byId.get(id)!.kind === 'cave' ? 3 : 0;
    const a = end ? sm.n - 1 - ext - 12 : ext, b = end ? sm.n - 1 - ext : ext + 15;
    return Math.atan2(sm.x[b] - sm.x[a], sm.z[b] - sm.z[a]);
  };
  const seenJ = new Set<string>();
  for (const r of def.routes) for (let i = 1; i < r.paths.length; i++) {
    const k = r.paths[i - 1] + '>' + r.paths[i]; if (seenJ.has(k)) continue; seenJ.add(k);
    const ang = Math.abs(wrap(head(r.paths[i], false) - head(r.paths[i - 1], true))) * 180 / Math.PI;
    if (ang > 25) console.log(`  sharp junction ${k}: ${ang.toFixed(0)} deg`);
  }
  // paths that run side by side too close (their corridors overlap and make odd ledges), away from where they meet
  for (let a = 0; a < c.paths.length; a++) for (let b = a + 1; b < c.paths.length; b++) {
    const A = c.paths[a].sm, B = c.paths[b].sm;
    let worst = Infinity, wz = 0;
    for (let i = 0; i < A.n; i += 2) {
      if (A.s[i] < 160 || A.s[i] > A.len - 160) continue;
      for (let j = 0; j < B.n; j += 2) {
        if (B.s[j] < 160 || B.s[j] > B.len - 160) continue;
        const m = Math.hypot(A.x[i] - B.x[j], A.z[i] - B.z[j]) - A.w[i] - B.w[j] - 10;
        if (m < worst) { worst = m; wz = A.z[i]; }
      }
    }
    if (worst < 0) console.log(`  too close: ${c.paths[a].def.id} / ${c.paths[b].def.id} by ${(-worst).toFixed(0)} m at z ${wz.toFixed(0)}`);
  }
  def.routes.forEach((r, ri) => {
    const line = c.routeLine(ri);
    // a racing line through the trees, rocks and pillars: the cheapest sideways offset at every sample (Viterbi),
    // moving at most 1 m sideways per 4 m, then smoothed
    {
      const J = 60, W = 2 * J + 1, N = line.length;
      const cost = new Float32Array(N * W), from = new Int8Array(N * W);
      const lim = (q: typeof line[0]) => q.kind === 'valley' ? q.w * 0.7 : q.w - 3.5;
      const local = new Float32Array(W), blockedAt: number[] = [];
      const loc = new Float32Array(N * W);
      for (let i = 0; i < N; i++) {
        const q = line[i], qn = line[Math.min(N - 1, i + 1)], qp = line[Math.max(0, i - 1)];
        let px = -(qn.z - qp.z), pz = qn.x - qp.x; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
        const obs = obstaclesNear(q.x, q.z, lim(q) + 12, []);
        const L = lim(q);
        for (let j = 0; j < W; j++) {
          const o = j - J;
          let cst = Math.abs(o) > L ? 1e6 : 0.002 * o * o;
          if (cst < 1e6 && obs.length) {
            const x = q.x + px * o, z = q.z + pz * o;
            const y = floorBelow(x, q.y + 3, z) + CLEAR;
            let gp = 99; for (const ob of obs) gp = Math.min(gp, obstacleGap(ob, x, y, z) - 0.5);
            if (gp < 1.8) cst += 1e4; else if (gp < 5) cst += (5 - gp) * 2;
          }
          let best = Infinity, bj = 0;
          if (i === 0) best = o === 0 ? 0 : 1e5;
          else for (let d = -1; d <= 1; d++) { const k = j + d; if (k < 0 || k >= W) continue; const v = cost[(i - 1) * W + k] + Math.abs(d) * 0.3; if (v < best) { best = v; bj = d; } }
          cost[i * W + j] = best + cst; from[i * W + j] = bj; loc[i * W + j] = cst;
        }
      }
      let j = 0; for (let k = 1; k < W; k++) if (cost[(N - 1) * W + k] < cost[(N - 1) * W + j]) j = k;
      const offs = new Float32Array(N);
      for (let i = N - 1; i >= 0; i--) { offs[i] = j - J; if (loc[i * W + j] >= 1e4) blockedAt.push(i); j += from[i * W + j]; }
      if (blockedAt.length) console.log(`  route ${ri}: no low gap at ${blockedAt.reverse().slice(0, 6).map((i) => `${Math.round(i / N * 100)}% (${line[i].kind} ${line[i].x.toFixed(0)},${line[i].z.toFixed(0)})`).join(' ')}`);
      const sm2 = offs.map((_, i) => { let s2 = 0, n2 = 0; for (let k = -3; k <= 3; k++) { const v = offs[Math.min(N - 1, Math.max(0, i + k))]; s2 += v; n2++; } return s2 / n2; });
      const moved = line.map((q, i) => {
        const qn = line[Math.min(N - 1, i + 1)], qp = line[Math.max(0, i - 1)];
        let px = -(qn.z - qp.z), pz = qn.x - qp.x; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
        return [q.x + px * sm2[i], q.z + pz * sm2[i]];
      });
      line.forEach((q, i) => { q.x = moved[i][0]; q.z = moved[i][1]; });
    }
    const g = new Glider();
    g.reset(def.start.x, def.start.y, def.start.z, def.start.heading);
    g.speed = def.start.speed;
    const dt = 1 / 60;
    let brakeT = 0; let t = 0, started = -1, idx = 0, minV = 999, minClr = 99, crash = '', next = 0;
    const gates = [...def.splits, def.finish];
    const splits: string[] = [];
    let minVAt = '';
    const prev = g.pos.clone();
    const hit = new Set<string>(), hits: string[] = [], passing = new Map<string, number>(); let kicks = 0;
    const secLen: number[] = [], segStart = { t: 0, d: 0 }; let dist = 0;
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
        const a = line[Math.max(0, Math.min(line.length - 1, idx + k - 6))], b = line[Math.min(line.length - 1, idx + k)], c2 = line[Math.min(line.length - 1, idx + k + 6)];
        const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c2.x - b.x, c2.z - b.z);
        const r = 24 / Math.max(1e-4, Math.abs(wrap(h2 - h1)));
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
        const wantP = Math.atan2(ty - g.pos.y, hd) + hErr * Number(process.env.HG ?? 0.03);
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
      if (started >= 0) dist += g.speed * dt;
      if (process.env.TRACE && Math.round(t * 60) % 15 === 0 && ri === 0) console.log(`t ${t.toFixed(2)} pos ${g.pos.x.toFixed(1)},${g.pos.y.toFixed(1)},${g.pos.z.toFixed(1)} tp ${tp.x.toFixed(1)},${ty.toFixed(1)},${tp.z.toFixed(1)} v ${g.speed.toFixed(1)} up ${g.up.x.toFixed(2)},${g.up.y.toFixed(2)},${g.up.z.toFixed(2)} in ${inp.roll.toFixed(2)},${inp.pitch.toFixed(2)}`);
      g.step(dt, inp);
      t += dt;
      if (started < 0 && gateCrossed(def.startGate, prev, g.pos)) started = t;
      if (started >= 0 && next < gates.length && gateCrossed(gates[next], prev, g.pos)) {
        splits.push((t - started).toFixed(1)); next++; secLen.push(Math.round(dist - segStart.d)); segStart.d = dist;
        if (next === gates.length) break;
      }
      if (g.speed < minV) { minV = g.speed; minVAt = `${(idx / line.length * 100).toFixed(0)}%`; }
      const sc = solidClearance(g.pos.x, g.pos.y, g.pos.z);
      minClr = Math.min(minClr, sc);
      if (sc < 0.45) { crash = `v=${g.speed.toFixed(0)} pitch=${g.pitch.toFixed(2)} roll=${g.roll.toFixed(2)} line=${line[idx].x.toFixed(0)},${line[idx].y.toFixed(0)},${line[idx].z.toFixed(0)} start=${started.toFixed(1)} rock at ${g.pos.x.toFixed(0)},${g.pos.y.toFixed(0)},${g.pos.z.toFixed(0)} (${(idx / line.length * 100).toFixed(0)}% ${tp.kind})`; break; }
      near.length = 0;
      const seen = new Set<string>();
      for (const o of obstaclesNear(g.pos.x, g.pos.z, 14, near)) {
        const gp = obstacleGap(o, g.pos.x, g.pos.y, g.pos.z) - 0.5;
        if (gp < 0 && !hit.has(o.id)) { hit.add(o.id); hits.push(`${o.type}@${(idx / line.length * 100).toFixed(0)}%`); }
        if (gp < 6) { seen.add(o.id); passing.set(o.id, Math.min(passing.get(o.id) ?? 99, gp)); }
      }
      if (KICKS) for (const [id, gp] of passing) if (!seen.has(id)) {
        passing.delete(id);
        if (gp < 3.5 && gp >= 0) { kicks++; g.speed = Math.min(95, g.speed + (gp < 1.2 ? 7 : 3 + (3.5 - gp) * 1.2)); }
      }
      if (crash) break;
      if (idx >= line.length - 2 && next < gates.length) { crash = `reached the end without gate ${next}`; break; }
    }
    const len = line.reduce((s, p, i) => i ? s + Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y, p.z - line[i - 1].z) : 0, 0);
    console.log(`route ${ri} "${r.name}": ${(len / 1000).toFixed(2)} km, ${crash ? 'CRASH ' + crash : 'finished'} | splits ${splits.join(' / ')} | min speed ${minV.toFixed(1)} m/s @${minVAt} | braking ${brakeT.toFixed(1)} s | avg ${(len / Math.max(1, t - Math.max(0, started))).toFixed(1)} | sections ${secLen.join('/')} m | kicks ${kicks} | hits ${hits.length}${hits.length ? ' ' + hits.slice(0, 6).join(' ') : ''}`);
  });
}
