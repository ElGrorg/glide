import './dom-stub';
// Autopilot fly-test for the time trial courses: flies every route with the real flight model and reports
// time, splits, slowest speed and any crash. Run: npx tsx scripts/sim-course.ts [courseId] [clearance]
import { Glider } from '../src/bird';
import { setCourse, getCourse, solidClearance, floorBelow, obstaclesNear, obstacleGap, type Obstacle } from '../src/world';
import { COURSES } from '../src/courses';
import { gateCrossed } from '../src/course';
import type { InputState } from '../src/input';

const want = process.argv[2];
const CLEAR = Number(process.argv[3] ?? 3);
const inp: InputState = { pitch: 0, roll: 0, yaw: 0, rollRate: false, brake: 0, boost: 0, view: false, tuck: 0, fire: false, dart: false, aimX: 0, aimY: 0, anyPress: false, trick: null, source: 'keyboard', nav: { x: 0, y: 0, ok: false, back: false, menu: false }, chat: null, chatToggle: false };
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
    if (minR < 160) console.log(`  tight bend: ${p.def.id} (${p.kind}, w ${sm.w[Math.round(at * sm.n)].toFixed(0)}) radius ${minR.toFixed(0)} m at ${(at * 100).toFixed(0)}%`);
  }
  def.routes.forEach((r, ri) => {
    const line = c.routeLine(ri);
    const g = new Glider();
    g.reset(def.start.x, def.start.y, def.start.z, def.start.heading);
    g.speed = def.start.speed;
    const dt = 1 / 60;
    let t = 0, started = -1, idx = 0, minV = 999, minClr = 99, crash = '', next = 0;
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
      const look = Math.max(6, Math.round(g.speed * 0.7 / 4));
      const tp0 = line[Math.min(line.length - 1, idx + look)];
      const tp = { ...tp0 };
      // steer round set pieces near the line (a column in the middle of a hall: pick a side)
      let sx = 0, sz = 0;
      const seenO = new Set<string>();
      for (let k = 0; k <= look + 6; k += 2) {
        const q = line[Math.min(line.length - 1, idx + k)];
        for (const o of obstaclesNear(q.x, q.z, 14, near)) {
          if (seenO.has(o.id) || (o.type !== 'spire' && o.top - o.y0 < 20)) continue;
          const ox = q.x - o.x, oz = q.z - o.z, d = Math.hypot(ox, oz);
          const need = o.r + 8;
          if (d >= need) continue;
          seenO.add(o.id);
          // push sideways (perpendicular to the line), to whichever side the line already passes
          const qn = line[Math.min(line.length - 1, idx + k + 1)];
          let px = -(qn.z - q.z), pz = qn.x - q.x; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
          const side = ox * px + oz * pz >= 0 ? 1 : -1;
          const push = need - Math.abs(ox * px + oz * pz);
          if (Math.abs(push) > Math.hypot(sx, sz)) { sx = px * side * push; sz = pz * side * push; }
        }
      }
      tp.x += sx; tp.z += sz;
      const clr = tp.kind === 'cave' ? Math.min(CLEAR + 1, tp.h * 0.3) : CLEAR;
      // look along the line ahead and along the nose for the highest ground coming up
      let fl = floorBelow(tp.x, tp.y + 3, tp.z);
      for (let k = 1; k <= look; k += 2) { const q = line[Math.min(line.length - 1, idx + k)]; fl = Math.max(fl, floorBelow(q.x, q.y + 3, q.z)); }
      for (let k = 4; k <= 40; k += 4) { const x = g.pos.x + g.dir.x * k, z = g.pos.z + g.dir.z * k; const y = g.pos.y + g.dir.y * k + 2; if (solidClearance(x, y, z) > 0) fl = Math.max(fl, floorBelow(x, y, z)); }
      const ty = fl + clr;
      const dx = tp.x - g.pos.x, dz = tp.z - g.pos.z, hd = Math.hypot(dx, dz);
      const wantH = Math.atan2(-dx, -dz);
      const e = wrap(wantH - g.heading);
      inp.roll = Math.max(-1, Math.min(1, -e * 3.5));
      const wantP = Math.atan2(ty - g.pos.y, hd);
      inp.pitch = Math.max(-1, Math.min(1, (wantP - g.pitch) * 4 - g.pitchVel * 0.6));
      prev.copy(g.pos);
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
    console.log(`route ${ri} "${r.name}": ${(len / 1000).toFixed(2)} km, ${crash ? 'CRASH ' + crash : 'finished'} | splits ${splits.join(' / ')} | min speed ${minV.toFixed(1)} m/s @${minVAt} | avg ${(len / Math.max(1, t - Math.max(0, started))).toFixed(1)}`);
  });
}
