import { makeNoise2D } from './noise';
import { defineCourse, samplePath, type CourseDef, type CtrlPt, type PathDef, type PathKind, type PieceDef } from './course';

// ---------- The three time trial courses ----------
// Written as nodes (named points) joined by paths, laid on a shared fall line (below). Routes split at a node and
// meet again at another; the splits sit on the shared stretches, so every route crosses every timing line.
// Design rules: the risky line through each fork is the short, tight, obstacle-strewn one and is clearly faster;
// the safe line is wide and open but wanders out sideways (so it falls more gently) and climbs over a crest.
// Branches leave and join within ~25 deg; bends in caves and slots stay above ~90 m radius.

// ---------- The mountain's fall line ----------
// The newer courses don't give heights by hand. The floor of every open path follows one shared surface: a steady
// fall (`slope` metres down per metre downhill) plus rolling hills (noise, `roll` metres either way) and drop-offs
// (every `step` metres the ground eases off, then falls away by up to `cliff` metres, like the endless mountain).
// Shared nodes sit on the same surface, so the routes always meet. A route that wanders sideways covers more ground
// for the same drop, so it is gentler (and slower) by itself; `dy` lifts a stretch above the surface (a crest you
// have to carry speed over) or sinks it. Caves run straight from portal to portal (plus their own dips).
interface FallLine { top: number; slope: number; roll: number; step: number; cliff: number; seed: number }
/** A node: [x, z, dy] (dy: metres above the fall line). */
type N3 = [number, number, number?];
/** A via: [x, z, halfWidth, height (cave roof / canyon depth), dy]. */
type V5 = [number, number, number, number?, number?];
function fallLine(f: FallLine, nodes: N3[] = []) {
  const a = makeNoise2D(f.seed, true), b = makeNoise2D(f.seed + 1, true), c = makeNoise2D(f.seed + 2, true);
  const ss = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  // no drop-off right at a fork or a merge (the routes there should meet on an even floor): a step whose drop
  // (the last 12% of it) lies within 80 m of a node keeps its floor smooth
  const calm = new Set<number>();
  for (const n of nodes) {
    const u = -n[1] / f.step;
    for (let k = Math.floor(u) - 1; k <= Math.floor(u) + 1; k++) {
      const z0 = (k + 0.88) * f.step, z1 = (k + 1) * f.step; // depth range of step k's drop (as -z)
      if (-n[1] > z0 - 80 && -n[1] < z1 + 80) calm.add(k);
    }
  }
  /** floor height of the fall line at (x, z) */
  const ground = (x: number, z: number) => {
    const hills = a(x / 420, z / 360) * f.roll + b(x / 170, z / 150) * f.roll * 0.4;
    const u = -z / f.step, s = u - Math.floor(u);
    const saw = s < 0.88 ? s / 0.88 : 1 - ss(0.88, 1, s);
    const k = Math.floor(u);
    const cliff = calm.has(k) ? 0 : f.cliff * Math.min(1, Math.max(0, c(k * 0.37, 4.1) * 1.4 + 0.55));
    return f.top + f.slope * z + hills + cliff * saw;
  };
  const at = (n: N3) => ground(n[0], n[1]) + (n[2] ?? 0);
  /** A path from one node to another. Open paths are resampled every 14 m onto the fall line; caves fall evenly
   *  from portal to portal (a via's dy dips or lifts them). */
  const way = (id: string, kind: PathKind, from: N3, via: V5[], to: N3, wTo: number, hTo = 0, wFrom?: number, hFrom?: number, dens?: number): PathDef => {
    const xz = [[from[0], from[1]], ...via.map((v) => [v[0], v[1]]), [to[0], to[1]]];
    const dys = [from[2] ?? 0, ...via.map((v) => v[4] ?? 0), to[2] ?? 0];
    const first = via[0];
    const ws = [wFrom ?? first?.[2] ?? wTo, ...via.map((v) => v[2]), wTo];
    const hs = [hFrom ?? first?.[3] ?? hTo, ...via.map((v) => v[3] ?? hTo), hTo];
    if (kind === 'cave') {
      const dist = [0];
      for (let i = 1; i < xz.length; i++) dist.push(dist[i - 1] + Math.hypot(xz[i][0] - xz[i - 1][0], xz[i][1] - xz[i - 1][1]));
      const y0 = at(from), y1 = at(to), L = dist[dist.length - 1];
      const pts: CtrlPt[] = xz.map((p, i) => [p[0], p[1], y0 + (y1 - y0) * dist[i] / L + (i > 0 && i < xz.length - 1 ? dys[i] : 0), ws[i], hs[i]]);
      return { id, kind, pts, dens };
    }
    // open: lay the plan on the spline (dy rides along as the height), then drop it onto the fall line
    const plan = samplePath(xz.map((p, i) => [p[0], p[1], dys[i], ws[i], hs[i]] as CtrlPt));
    const n = Math.max(2, Math.round(plan.len / 14));
    const pts: CtrlPt[] = [];
    for (let k = 0; k <= n; k++) {
      const i = Math.round((k / n) * (plan.n - 1));
      const x = plan.x[i], z = plan.z[i];
      pts.push([x, z, ground(x, z) + plan.y[i], plan.w[i], plan.h[i]]);
    }
    pts[0] = [from[0], from[1], at(from), ws[0], hs[0]];
    pts[n] = [to[0], to[1], at(to), wTo, hTo];
    return { id, kind, pts, dens };
  };
  return { ground, at, way };
}

/** Twist a tunnel: S-bends sideways (amp metres either way, one full S every `wave` metres) and dips and rises
 *  in the floor (vamp metres), easing in and out over the first and last 120 m so the ends still line up with the
 *  paths they join. The bends are what make a tunnel hard: brake, carve, or kiss the wall. */
function twist(p: PathDef, amp: number, wave: number, vamp = 0, phase = 0): PathDef {
  const sm = samplePath(p.pts);
  const pts: CtrlPt[] = [];
  const n = Math.max(4, Math.round(sm.len / (wave / 6)));
  for (let k = 0; k <= n; k++) {
    const s = (sm.len * k) / n;
    const i = Math.min(sm.n - 2, Math.round((s / sm.len) * (sm.n - 1)));
    const tx = sm.x[i + 1] - sm.x[i], tz = sm.z[i + 1] - sm.z[i], tl = Math.hypot(tx, tz) || 1;
    const e = Math.min(1, s / 120, (sm.len - s) / 120), taper = e * e * (3 - 2 * e);
    const off = amp * Math.sin((2 * Math.PI * s) / wave + phase) * taper;
    const dy = vamp * Math.sin((2 * Math.PI * s) / (wave * 0.6) + phase * 1.7) * taper;
    pts.push([sm.x[i] - (tz / tl) * off, sm.z[i] + (tx / tl) * off, sm.y[i] + dy, sm.w[i], sm.h[i]]);
  }
  // exact ends
  pts[0] = p.pts[0]; pts[pts.length - 1] = p.pts[p.pts.length - 1];
  return { ...p, pts };
}

/** Columns or spires in a slalom: alternate sides along a stretch of path. */
function slalom(pathId: string, a: number, b: number, n: number, lat: number, r: number, type: PieceDef['type'] = 'column', h?: number): PieceDef[] {
  const out: PieceDef[] = [];
  for (let i = 0; i < n; i++) out.push({ path: pathId, at: a + ((b - a) * i) / Math.max(1, n - 1), lat: i % 2 ? lat : -lat, type, r, h });
  return out;
}

// ======================================================================
// 1. Glacier Ridge: the snow bowl, the twin ice bores (fast) or over the col (safe), three ways down the face
//    (the couloir, the pine glade, the long gully), the glacier: the crevasse, the great hall, or round by the
//    moraine, and the runout through the spires.
// ======================================================================
const G1: Record<string, N3> = {
  S: [0, 0], F1: [-90, -750], C1: [-100, -890], C2: [-70, -1750], M1: [-30, -2050],
  F2: [0, -2400], M2: [0, -3650], P3a: [10, -4020], P3: [0, -4120], P4: [20, -5250], M4: [10, -5500], E: [-30, -6250],
};
export const GL = fallLine({ top: 2400, slope: 0.3, roll: 22, step: 560, cliff: 30, seed: 4101 }, Object.values(G1));
const glacier = defineCourse({
  id: 'ridge', version: 2, name: 'Glacier Ridge', biome: 'alpine', seed: 41017,
  blurb: 'snow bowls, ice bores, the couloir and the caves under the glacier',
  sections: ['The Bowl', 'The Face', 'Glacier Caves', 'Runout'],
  look: { caveRock: 0x9cc4dc, crystal: 0x8ff3ff, trees: 1.6, rocks: 1.4, clouds: 0.35, lowClouds: false, spires: 0.2, tall: 1.25 },
  paths: [
    GL.way('s1', 'valley', G1.S, [[50, -250, 95], [-60, -560, 78]], G1.F1, 65, 0, 100, 0, 0.7),
    // fast: a short slot into the twin ice bores, straight down the fall line
    GL.way('gate1', 'canyon', G1.F1, [], G1.C1, 13, 40, 16, 40),
    twist(GL.way('boreL', 'cave', G1.C1, [[-160, -1050, 12, 16], [-170, -1300, 11, 15], [-120, -1550, 12, 16]], G1.C2, 12, 16, 12, 16), 12, 250, 3, 0),
    twist(GL.way('boreR', 'cave', G1.C1, [[-80, -1050, 12, 16], [-60, -1300, 12, 15], [-45, -1550, 11, 16]], G1.C2, 12, 16, 12, 16), 12, 250, 3, 3.1),
    GL.way('out1', 'canyon', G1.C2, [], G1.M1, 20, 40, 13, 40),
    // safe: out over the col, wide and open, a long way round with a crest to carry speed over
    GL.way('col', 'valley', G1.F1, [[-45, -900, 50], [100, -1100, 45], [230, -1360, 45, 0, 30], [215, -1620, 45, 0, 10], [130, -1800, 45], [10, -1920, 50]], G1.M1, 55, 0, 60, 0, 0.75),
    GL.way('s2', 'valley', G1.M1, [[-10, -2220, 65]], G1.F2, 60, 0, 60, 0, 0.7),
    // the face, three ways: the couloir (a narrow slot straight down, boulders), the glade (thick tall pines),
    // the gully (wide, safe and a long way round)
    GL.way('couloir', 'canyon', G1.F2, [[-15, -2650, 11, 60], [-5, -2930, 10, 66], [-35, -3220, 10, 66], [8, -3480, 11, 60]], G1.M2, 14, 50, 12, 50),
    GL.way('glade', 'valley', G1.F2, [[-75, -2580, 34], [-230, -2790, 32], [-275, -3100, 32], [-200, -3360, 32], [-70, -3480, 34]], G1.M2, 40, 0, 40, 0, 0.85),
    GL.way('gully', 'canyon', G1.F2, [[80, -2600, 20, 45], [250, -2780, 22, 50], [370, -3000, 22, 55, 25], [335, -3200, 22, 50, 10], [200, -3350, 20, 50], [80, -3460, 20, 45]], G1.M2, 22, 45, 18, 40),
    GL.way('s3', 'valley', G1.M2, [[10, -3850, 60]], G1.P3a, 45, 0, 60, 0, 0.7),
    GL.way('gate3', 'canyon', G1.P3a, [], G1.P3, 14, 40, 18, 40),
    // the glacier: the crevasse (narrow, low, swaying), the great hall (wide, a forest of columns), or the moraine
    // outside (open, safe, a long way round over a crest)
    twist(GL.way('crevasse', 'cave', G1.P3, [[-12, -4300, 10, 13], [14, -4550, 9, 12], [-12, -4800, 9, 12], [10, -5050, 10, 13]], G1.P4, 12, 15, 12, 15), 8, 240, 3, 0.5),
    twist(GL.way('hall', 'cave', G1.P3, [[-40, -4280, 16, 18], [-150, -4470, 30, 26], [-210, -4720, 36, 30], [-170, -4960, 30, 26], [-20, -5160, 18, 20]], G1.P4, 14, 16, 13, 16), 6, 300, 2, 0),
    GL.way('moraine', 'valley', G1.P3a, [[60, -4170, 45], [220, -4380, 45], [370, -4650, 45, 0, 25], [360, -4930, 45, 0, 10], [230, -5180, 45], [80, -5350, 50]], G1.M4, 55, 0, 45, 0, 0.75),
    GL.way('s4a', 'valley', G1.P4, [], G1.M4, 55, 0, 40, 0, 0.7),
    GL.way('s4', 'valley', G1.M4, [[20, -5750, 70], [40, -6000, 75]], G1.E, 85, 0, 55, 0, 0.85),
  ],
  routes: [
    { name: 'Ice bores · couloir · crevasse', paths: ['s1', 'gate1', 'boreL', 'out1', 's2', 'couloir', 's3', 'gate3', 'crevasse', 's4a', 's4'] },
    { name: 'Ice bores · the glade · great hall', paths: ['s1', 'gate1', 'boreR', 'out1', 's2', 'glade', 's3', 'gate3', 'hall', 's4a', 's4'] },
    { name: 'The col · the gully · the moraine', paths: ['s1', 'col', 's2', 'gully', 's3', 'moraine', 's4'] },
  ],
  pieces: [
    ...slalom('couloir', 0.25, 0.85, 6, 5, 3, 'rock'),
    ...[[0.2, -14], [0.28, 12], [0.36, -2], [0.43, 20], [0.5, -20], [0.56, 6], [0.63, -12], [0.7, 16], [0.78, -6]]
      .map(([at, lat], i) => ({ path: 'hall', at, lat, type: 'column' as const, r: 3.5 + (i % 3) })),
    ...slalom('s4', 0.25, 0.7, 5, 24, 4, 'spire', 50),
  ],
  startAt: ['s1', 0.2],
  splitsAt: [['s2', 0.4], ['s3', 0.45], ['s4', 0.15]],
  finishAt: ['s4', 0.85],
});

// ======================================================================
// 2. Hollow Mountain: a misty valley, the gorge (fast) or the mossy shelf; into the Maw and three ways through the
//    Labyrinth (the needle, the skylight, the long sweep), the Cathedral, then the drain (fast) or out by the
//    chimney and the ledge; down the falls and through the Eye (fast) or round by the rim.
// ======================================================================
const H2: Record<string, N3> = {
  S: [0, 0], F: [40, -700], M0: [0, -1380], K1: [0, -1600], MAW: [0, -1680], J1: [-15, -1880],
  SKY1: [120, -2300], SKY2: [125, -2480], CATH: [0, -2800], CX: [0, -3100], O1: [150, -3400, 14], O2: [-10, -3980],
  M3: [0, -4150], K4: [20, -4750], E1: [45, -5550], E2: [30, -5720], M4: [10, -5950], FIN: [-20, -6350],
};
export const HL = fallLine({ top: 2300, slope: 0.31, roll: 20, step: 520, cliff: 28, seed: 5207 }, Object.values(H2));
const hollow = defineCourse({
  id: 'caverns', version: 2, name: 'Hollow Mountain', biome: 'misty', seed: 52211,
  blurb: 'a misty gorge, the Labyrinth tunnels, the Cathedral and the Eye',
  sections: ['The Gorge', 'Labyrinth', 'Chimney or Drain', 'The Falls'],
  look: { caveRock: 0x7b9483, crystal: 0xc4ff6e, trees: 1.2, rocks: 1.2, clouds: 0.55, lowClouds: true, spires: 0.16, tall: 1.3 },
  paths: [
    HL.way('s1', 'valley', H2.S, [[-50, -260, 85], [20, -520, 75]], H2.F, 60, 0, 90, 0, 0.7),
    // fast: the gorge, a deep narrow slot nearly straight down; safe: the mossy shelf, wide, round and over a hump
    HL.way('gorge', 'canyon', H2.F, [[30, -820, 14, 45], [-10, -1000, 12, 55], [-15, -1190, 12, 60]], H2.M0, 16, 45, 16, 40),
    HL.way('shelf', 'valley', H2.F, [[85, -810, 45], [200, -955, 42], [262, -1160, 42, 0, 22], [190, -1360, 42, 0, 8], [60, -1470, 40]], H2.K1, 35, 0, 50, 0, 0.6),
    HL.way('basin', 'valley', H2.M0, [], H2.K1, 30, 0, 45, 0, 0.6),
    HL.way('throat', 'canyon', H2.K1, [], H2.MAW, 17, 50, 20, 45),
    HL.way('maw', 'cave', H2.MAW, [[-10, -1780, 24, 24]], H2.J1, 22, 22, 19, 22),
    // the Labyrinth: the needle (tight, low, swaying, straight through: fastest), the skylight (out into a slot and
    // back in), the long sweep (wide and easy, a long way round)
    twist(HL.way('needle', 'cave', H2.J1, [[-18, -2050, 10, 13], [0, -2300, 9, 12], [-15, -2550, 10, 13]], H2.CATH, 13, 15, 12, 15), 8, 210, 2, 1.5),
    twist(HL.way('sweep', 'cave', H2.J1, [[-50, -2000, 15, 17], [-160, -2180, 16, 18], [-205, -2400, 17, 18], [-160, -2590, 16, 18], [-60, -2700, 15, 17]], H2.CATH, 18, 18, 14, 16), 6, 300, 2, 0),
    twist(HL.way('lab-r1', 'cave', H2.J1, [[15, -2000, 13, 15], [85, -2160, 13, 15]], H2.SKY1, 14, 15, 14, 16), 6, 220, 2, 0.5),
    HL.way('skylight', 'canyon', H2.SKY1, [], H2.SKY2, 15, 60, 15, 60),
    twist(HL.way('lab-r2', 'cave', H2.SKY2, [[95, -2610, 13, 15], [30, -2710, 14, 16]], H2.CATH, 18, 18, 14, 15), 6, 220, 2, 2),
    HL.way('cathedral', 'cave', H2.CATH, [[8, -2950, 44, 40]], H2.CX, 26, 26, 30, 28),
    // fast: the drain, a long dark twisting tube; safe: up the chimney (a climb), out onto the ledge and round
    twist(HL.way('drain', 'cave', H2.CX, [[-20, -3300, 12, 13], [-35, -3550, 11, 13], [-20, -3800, 12, 13]], H2.O2, 13, 14, 14, 16), 10, 240, 3, 2.5),
    HL.way('drainout', 'canyon', H2.O2, [], H2.M3, 24, 40, 15, 40),
    twist(HL.way('chimney', 'cave', H2.CX, [[40, -3200, 12, 14, 10], [100, -3310, 12, 14, 14]], H2.O1, 13, 15, 14, 16), 6, 200, 0, 0),
    HL.way('ledge', 'valley', H2.O1, [[215, -3600, 45], [195, -3850, 50], [70, -3990, 60]], H2.M3, 70, 0, 26, 0, 0.75),
    HL.way('daylight', 'valley', H2.M3, [[5, -4350, 75], [35, -4550, 70]], H2.K4, 50, 0, 70, 0, 0.75),
    // fast: the falls, a deep slot that drops into the Eye; safe: the rim, round the outside and over a rise
    HL.way('falls', 'canyon', H2.K4, [[-25, -4950, 14, 60], [-15, -5200, 13, 70], [30, -5400, 13, 70]], H2.E1, 14, 60, 18, 50),
    HL.way('eye', 'cave', H2.E1, [], H2.E2, 15, 17, 14, 16),
    HL.way('out4', 'valley', H2.E2, [], H2.M4, 60, 0, 30, 0, 0.6),
    HL.way('rim', 'valley', H2.K4, [[80, -4910, 40], [220, -5150, 40], [265, -5450, 40, 0, 20], [180, -5680, 45, 0, 6], [90, -5800, 50]], H2.M4, 60, 0, 45, 0, 0.8),
    HL.way('finale', 'valley', H2.M4, [], H2.FIN, 85, 0, 65, 0, 0.7),
  ],
  routes: [
    { name: 'Gorge · needle · drain · falls and the Eye', paths: ['s1', 'gorge', 'basin', 'throat', 'maw', 'needle', 'cathedral', 'drain', 'drainout', 'daylight', 'falls', 'eye', 'out4', 'finale'] },
    { name: 'Shelf · long sweep · chimney · rim', paths: ['s1', 'shelf', 'throat', 'maw', 'sweep', 'cathedral', 'chimney', 'ledge', 'daylight', 'rim', 'finale'] },
    { name: 'Gorge · skylight · chimney · falls', paths: ['s1', 'gorge', 'basin', 'throat', 'maw', 'lab-r1', 'skylight', 'lab-r2', 'cathedral', 'chimney', 'ledge', 'daylight', 'falls', 'eye', 'out4', 'finale'] },
  ],
  pieces: [
    // the Cathedral: a forest of columns
    { path: 'cathedral', at: 0.25, lat: -18, type: 'column', r: 4 },
    { path: 'cathedral', at: 0.3, lat: 14, type: 'column', r: 5 },
    { path: 'cathedral', at: 0.45, lat: -2, type: 'column', r: 5.5 },
    { path: 'cathedral', at: 0.55, lat: -26, type: 'column', r: 4 },
    { path: 'cathedral', at: 0.6, lat: 24, type: 'column', r: 4.5 },
    { path: 'cathedral', at: 0.7, lat: -16, type: 'column', r: 4 },
    // the sweep: a few columns to keep you honest; the gorge and the falls: boulders to hop
    ...slalom('sweep', 0.3, 0.75, 4, 8, 3),
    ...slalom('gorge', 0.3, 0.8, 4, 5, 3, 'rock'),
    ...slalom('falls', 0.25, 0.75, 4, 5, 3, 'rock'),
    ...slalom('daylight', 0.45, 0.85, 4, 22, 4, 'spire', 50),
  ],
  startAt: ['s1', 0.2],
  splitsAt: [['maw', 0.45], ['cathedral', 0.12], ['daylight', 0.3]],
  finishAt: ['finale', 0.7],
});

// ======================================================================
// 3. Red Rock Slots: a mesa-top start, the deep slot (fast) or the wash; round the butte by the braids or through
//    it; the pillar field; the sinkhole dive (fast) or the switchbacks; then the Narrows (fast) or the rim road.
// ======================================================================
const R3: Record<string, N3> = {
  S: [0, 0], F1: [-30, -900], M1: [-20, -1750], B0: [-10, -1900], B1: [-8, -2560], P0: [0, -2680],
  F3: [-20, -3420], G3: [-28, -3500], M3: [10, -3980], F4: [0, -4150], N: [0, -5450], FIN: [-10, -6050],
};
export const RR = fallLine({ top: 2200, slope: 0.3, roll: 18, step: 600, cliff: 24, seed: 6311 }, Object.values(R3));
const redrock = defineCourse({
  id: 'canyon', version: 2, name: 'Red Rock Slots', biome: 'desert', seed: 63389,
  blurb: 'deep slots, a butte tunnel, the pillar field and the Narrows',
  sections: ['The Slot', 'The Braids', 'Pillar Field', 'The Narrows'],
  look: { caveRock: 0xc9825a, crystal: 0xffcf6a, trees: 1, rocks: 1.5, clouds: 0.3, lowClouds: false, spires: 0.28, tall: 1 },
  paths: [
    RR.way('s1', 'valley', R3.S, [[40, -300, 110], [-10, -640, 105]], R3.F1, 60, 0, 110, 0, 0.8),
    // fast: the slot, deep and narrow, snaking but nearly straight; safe: the wash, wide and round over a hump
    RR.way('slot', 'canyon', R3.F1, [[-45, -1010, 12, 60], [-75, -1160, 10, 80], [-55, -1330, 10, 85], [-75, -1500, 10, 85], [-45, -1640, 11, 75]], R3.M1, 16, 60, 14, 45),
    RR.way('wash', 'valley', R3.F1, [[15, -1010, 50], [130, -1160, 50], [200, -1340, 55, 0, 20], [165, -1520, 50, 0, 6], [40, -1640, 45]], R3.M1, 30, 0, 50, 0, 0.8),
    RR.way('s2', 'canyon', R3.M1, [], R3.B0, 20, 45, 22, 45),
    // through the butte (a twisting tunnel, fastest) or round it by the left or right braid
    RR.way('braidL', 'canyon', R3.B0, [[-40, -1990, 13, 55], [-140, -2150, 13, 65], [-145, -2340, 13, 65], [-45, -2460, 14, 60]], R3.B1, 17, 50, 16, 50),
    RR.way('braidR', 'canyon', R3.B0, [[20, -1990, 13, 55], [125, -2150, 13, 65], [130, -2340, 13, 65], [30, -2460, 14, 60]], R3.B1, 17, 50, 16, 50),
    twist(RR.way('butte', 'cave', R3.B0, [[-12, -2020, 12, 19], [-12, -2110, 11, 17], [-2, -2330, 11, 17], [-8, -2460, 12, 17]], R3.B1, 14, 18, 16, 22), 10, 220, 0, 0),
    RR.way('s3', 'canyon', R3.B1, [], R3.P0, 30, 40, 20, 50),
    RR.way('field', 'valley', R3.P0, [[35, -2900, 115], [5, -3170, 120]], R3.F3, 60, 0, 60, 0, 0.9),
    // fast: the sinkhole, a short slot into a steep dark tube that dives through the mesa; safe: the switchbacks
    RR.way('sinkgate', 'canyon', R3.F3, [], R3.G3, 14, 45, 18, 40),
    twist(RR.way('sink', 'cave', R3.G3, [[-34, -3570, 13, 18], [-38, -3680, 12, 18, -15], [-22, -3830, 12, 16, -8]], R3.M3, 14, 16, 14, 20), 8, 190, 0, 1),
    RR.way('switch', 'canyon', R3.F3, [[15, -3520, 18, 45], [90, -3600, 19, 55], [125, -3740, 19, 60], [65, -3880, 18, 55]], R3.M3, 20, 50, 20, 40),
    RR.way('s4', 'canyon', R3.M3, [], R3.F4, 22, 45, 20, 50),
    // fast: the Narrows, a long tight slot with boulders; safe: the rim road, open, round and over a rise
    RR.way('narrows', 'canyon', R3.F4, [[5, -4320, 12, 60], [28, -4560, 11, 70], [-12, -4820, 11, 75], [22, -5060, 11, 70], [12, -5280, 12, 65]], R3.N, 14, 55, 16, 50),
    RR.way('rimroad', 'valley', R3.F4, [[-70, -4300, 45], [-200, -4520, 45], [-270, -4820, 45, 0, 22], [-210, -5100, 45, 0, 6], [-60, -5300, 50]], R3.N, 50, 0, 40, 0, 0.8),
    RR.way('wash2', 'valley', R3.N, [[-10, -5700, 60]], R3.FIN, 80, 0, 30, 0, 0.7),
  ],
  routes: [
    { name: 'Slot · butte tunnel · sinkhole · Narrows', paths: ['s1', 'slot', 's2', 'butte', 's3', 'field', 'sinkgate', 'sink', 's4', 'narrows', 'wash2'] },
    { name: 'Wash · left braid · switchbacks · rim road', paths: ['s1', 'wash', 's2', 'braidL', 's3', 'field', 'switch', 's4', 'rimroad', 'wash2'] },
    { name: 'Slot · right braid · switchbacks · Narrows', paths: ['s1', 'slot', 's2', 'braidR', 's3', 'field', 'switch', 's4', 'narrows', 'wash2'] },
  ],
  pieces: [
    // lone spires on the mesa top
    { path: 's1', at: 0.4, lat: -40, type: 'spire', r: 5, h: 55 },
    { path: 's1', at: 0.6, lat: 35, type: 'spire', r: 6, h: 60 },
    { path: 's1', at: 0.8, lat: -25, type: 'spire', r: 5, h: 50 },
    // the pillar field: pick your own line through it
    ...[[0.12, -30], [0.18, 25], [0.26, -5], [0.33, 45], [0.38, -50], [0.45, 15], [0.56, -25], [0.62, 50], [0.68, -55], [0.74, 5], [0.8, -30], [0.86, 35]]
      .map(([at, lat], i) => ({ path: 'field', at, lat, type: 'spire' as const, r: 5 + (i % 3), h: 50 + (i % 4) * 12 })),
    // boulders in the Narrows: hop them or squeeze round; pillars along the rim road
    ...slalom('narrows', 0.15, 0.85, 7, 5, 3.2, 'rock'),
    ...slalom('rimroad', 0.2, 0.8, 6, 18, 5, 'spire', 55),
  ],
  startAt: ['s1', 0.08],
  splitsAt: [['s2', 0.4], ['field', 0.5], ['s4', 0.5]],
  finishAt: ['wash2', 0.75],
});

export const COURSES: CourseDef[] = [glacier, hollow, redrock];
export function courseById(id: string) { return COURSES.find((c) => c.id === id) ?? null; }
