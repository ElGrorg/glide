import { defineCourse, samplePath, type CourseDef, type CtrlPt, type PathDef, type PathKind, type PieceDef } from './course';

// ---------- The three time trial courses ----------
// Written as nodes (named points with a height) joined by paths. A path's floor falls evenly from one node's
// height to the next, unless a via point gives its own height. Routes split at a node and meet again at
// another; the splits sit on the shared stretches, so every route crosses every timing line.

type Node = [number, number, number]; // x, z, floor height
/** via point: [x, z, halfWidth, height (cave roof / canyon depth), floorY override] */
type Via = [number, number, number, number?, number?];

function path(id: string, kind: PathKind, from: Node, via: Via[], to: Node, wTo: number, hTo = 0, wFrom?: number, hFrom?: number): PathDef {
  const xz: [number, number][] = [[from[0], from[1]], ...via.map((v) => [v[0], v[1]] as [number, number]), [to[0], to[1]]];
  const dist = [0];
  for (let i = 1; i < xz.length; i++) dist.push(dist[i - 1] + Math.hypot(xz[i][0] - xz[i - 1][0], xz[i][1] - xz[i - 1][1]));
  // heights: fixed at the nodes and at any via with its own height, even fall in between
  const fixed: (number | undefined)[] = [from[2], ...via.map((v) => v[4]), to[2]];
  const ys: number[] = [];
  for (let i = 0; i < xz.length; i++) {
    if (fixed[i] !== undefined) { ys.push(fixed[i]!); continue; }
    let a = i - 1; while (fixed[a] === undefined) a--;
    let b = i + 1; while (fixed[b] === undefined) b++;
    ys.push(fixed[a]! + (fixed[b]! - fixed[a]!) * (dist[i] - dist[a]) / (dist[b] - dist[a]));
  }
  const first = via[0];
  const pts: CtrlPt[] = [[from[0], from[1], ys[0], wFrom ?? first?.[2] ?? wTo, hFrom ?? first?.[3] ?? hTo]];
  via.forEach((v, i) => pts.push([v[0], v[1], ys[i + 1], v[2], v[3] ?? hTo]));
  pts.push([to[0], to[1], ys[ys.length - 1], wTo, hTo]);
  return { id, kind, pts };
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
// 1. Glacier Ridge: open snow bowls, twin ice bores or the high col, two couloirs, the glacier caves, the runout.
// ======================================================================
const G = {
  S: [0, 0, 1600] as Node,
  F1: [-60, -1150, 1352] as Node,  // the bowl splits: the col (right) or the ice bores (left)
  C1: [-75, -1270, 1326] as Node, // ice bore mouth
  C2: [-25, -1990, 1196] as Node,  // the bores come out
  M1: [0, -2110, 1170] as Node,    // back together
  F2: [-30, -2470, 1092] as Node,  // the couloirs split
  M2: [40, -3480, 868] as Node,    // ...and meet
  P3: [0, -3880, 785] as Node,     // glacier cave mouth
  H: [10, -4475, 665] as Node,     // the great hall
  P4: [40, -4860, 592] as Node,    // out into the light
  E: [0, -6150, 330] as Node,      // the finish flats
};
const P3a: Node = [10, -3790, 803];
const glacier = defineCourse({
  id: 'ridge', version: 1, name: 'Glacier Ridge', biome: 'alpine', seed: 41017,
  blurb: 'snow bowls, ice bores, couloirs and the caves under the glacier',
  sections: ['The Bowl', 'Couloirs', 'Glacier Caves', 'Runout'],
  look: { caveRock: 0x9cc4dc, crystal: 0x8ff3ff, trees: 0.7, rocks: 0.8, clouds: 0.35, lowClouds: false },
  paths: [
    path('s1', 'valley', G.S, [[50, -280, 105], [-30, -600, 110], [-95, -900, 85]], G.F1, 70, 0, 95),
    // left: a short slot into the twin ice bores
    path('gate1', 'canyon', G.F1, [], G.C1, 13, 40, 16, 40),
    twist(path('boreL', 'cave', G.C1, [[-92, -1362, 12, 16], [-150, -1510, 11, 15], [-160, -1700, 12, 16], [-95, -1880, 11, 15]], G.C2, 12, 16, 12, 16), 16, 240, 3, 0),
    twist(path('boreR', 'cave', G.C1, [[-70, -1362, 12, 16], [-55, -1510, 12, 15], [-40, -1700, 11, 16], [-15, -1880, 12, 15]], G.C2, 12, 16, 12, 16), 16, 240, 3, 3.1),
    path('out1', 'canyon', G.C2, [], G.M1, 22, 40, 13, 40),
    // right: over the col, longer and gentler, with a rise you carry speed over
    path('col', 'valley', G.F1, [[60, -1300, 50], [190, -1520, 45], [205, -1760, 45, 0, 1300], [110, -1990, 50]], G.M1, 55, 0, 60),
    path('s2', 'valley', G.M1, [[-20, -2290, 70]], G.F2, 65, 0, 60),
    // the straight couloir: narrow, steep and fast
    path('steep', 'canyon', G.F2, [[-70, -2700, 11, 60], [-35, -3000, 10, 66], [5, -3260, 11, 60]], G.M2, 14, 50, 12, 50),
    // the gully: wider, winding, longer
    path('gully', 'canyon', G.F2, [[55, -2620, 20, 45], [165, -2860, 22, 50], [130, -3100, 20, 55], [175, -3310, 20, 50]], G.M2, 22, 45, 18, 40),
    path('s3', 'valley', G.M2, [[10, -3650, 65]], P3a, 45, 0, 60),
    path('gate3', 'canyon', P3a, [], G.P3, 14, 40, 18, 40),
    // the glacier caves: three ways to the great hall
    twist(path('low', 'cave', G.P3, [[-12, -3968, 13, 15], [-52, -4045, 12, 14, 752], [-98, -4175, 11, 14], [-104, -4266, 14, 15, 688], [-48, -4368, 14, 15], [-3, -4425, 14, 16]], G.H, 16, 18, 13, 16), 14, 220, 4, 1),
    twist(path('mid', 'cave', G.P3, [[-2, -3970, 14, 16], [-5, -4080, 22, 20], [12, -4280, 26, 22]], G.H, 24, 22, 14, 16), 8, 260, 3, 0),
    twist(path('high', 'cave', G.P3, [[12, -3968, 13, 15], [54, -4045, 12, 15, 752], [100, -4170, 12, 15], [104, -4262, 15, 16, 728], [64, -4368, 14, 15], [22, -4425, 14, 16]], G.H, 16, 18, 13, 16), 14, 220, 4, 4),
    path('hall', 'cave', G.H, [[28, -4660, 36, 30]], G.P4, 16, 18, 32, 24),
    path('s4', 'valley', G.P4, [[90, -5100, 60], [70, -5330, 70, 0, 520], [10, -5480, 75, 0, 452], [-60, -5800, 80], [-20, -6000, 80]], G.E, 90, 0, 40),
  ],
  routes: [
    { name: 'Ice bores (left) · steep couloir · middle hall', paths: ['s1', 'gate1', 'boreL', 'out1', 's2', 'steep', 's3', 'gate3', 'mid', 'hall', 's4'] },
    { name: 'Ice bores (right) · gully · low cave', paths: ['s1', 'gate1', 'boreR', 'out1', 's2', 'gully', 's3', 'gate3', 'low', 'hall', 's4'] },
    { name: 'The col · steep couloir · high cave', paths: ['s1', 'col', 's2', 'steep', 's3', 'gate3', 'high', 'hall', 's4'] },
  ],
  pieces: [
    ...slalom('mid', 0.3, 0.85, 5, 10, 3),
    { path: 'hall', at: 0.5, lat: 0, type: 'column', r: 5 },
    { path: 'hall', at: 0.74, lat: -15, type: 'column', r: 4 },
    { path: 'hall', at: 0.74, lat: 15, type: 'column', r: 4 },
    ...slalom('s4', 0.58, 0.72, 5, 22, 3.5, 'spire', 45),
  ],
  startAt: ['s1', 0.25],
  splitsAt: [['s2', 0.4], ['s3', 0.45], ['s4', 0.2]],
  finishAt: ['s4', 0.78],
});


// ======================================================================
// 2. Hollow Mountain: a misty gorge pours into the Maw, three tunnels through the Labyrinth, the Cathedral,
//    then out by the high chimney or the long drain, and down the falls through the Eye.
// ======================================================================
const H2 = {
  S: [0, 0, 1500] as Node,
  F: [55, -880, 1304] as Node,      // gorge (left) or the mossy shelf (right)
  M0: [15, -1210, 1236] as Node,    // back together in the basin
  K1: [5, -1295, 1219] as Node,     // the throat
  MAW: [0, -1365, 1202] as Node,    // into the mountain
  J1: [-20, -1580, 1160] as Node,   // the Labyrinth splits three ways
  CATH: [0, -2520, 962] as Node,    // the Cathedral
  CX: [0, -2810, 902] as Node,      // two ways out
  O1: [112, -3080, 896] as Node,    // the chimney comes out on a ledge
  O2: [-12, -3580, 792] as Node,    // the drain comes out
  M3: [0, -3720, 760] as Node,      // daylight
  K4: [20, -4360, 622] as Node,     // the falls (left) or the rim (right)
  E1: [60, -5150, 462] as Node,     // the Eye
  E2: [35, -5330, 426] as Node,
  M4: [10, -5480, 398] as Node,
  FIN: [-20, -5830, 328] as Node,
};
const SKY1: Node = [150, -1960, 1080], SKY2: Node = [162, -2160, 1040];
const hollow = defineCourse({
  id: 'caverns', version: 1, name: 'Hollow Mountain', biome: 'misty', seed: 52211,
  blurb: 'a misty gorge, the Labyrinth tunnels, the Cathedral and the Eye',
  sections: ['The Gorge', 'Labyrinth', 'Chimney or Drain', 'The Falls'],
  look: { caveRock: 0x7b9483, crystal: 0xc4ff6e, trees: 1.1, rocks: 0.9, clouds: 0.55, lowClouds: true },
  paths: [
    path('s1', 'valley', H2.S, [[-50, -300, 85], [25, -620, 80]], H2.F, 60, 0, 90),
    path('gorge', 'canyon', H2.F, [[45, -960, 16, 40], [5, -1040, 15, 50], [-15, -1115, 14, 55]], H2.M0, 18, 40, 20, 35),
    path('shelf', 'valley', H2.F, [[85, -960, 45], [95, -1050, 42], [60, -1135, 40]], H2.M0, 35, 0, 50),
    path('basin', 'valley', H2.M0, [], H2.K1, 30, 0, 45),
    path('throat', 'canyon', H2.K1, [], H2.MAW, 17, 50, 20, 45),
    path('maw', 'cave', H2.MAW, [[-14, -1460, 26, 24]], H2.J1, 22, 22, 19, 22),
    // the Labyrinth: wide and sweeping (left), the needle (middle: tight and straight), the skylight (right)
    twist(path('lab-l', 'cave', H2.J1, [[-48, -1690, 13, 15], [-135, -1880, 13, 15], [-165, -2100, 14, 16], [-110, -2330, 13, 15], [-42, -2445, 14, 16]], H2.CATH, 18, 18, 14, 16), 18, 250, 4, 0),
    twist(path('lab-m', 'cave', H2.J1, [[-18, -1720, 11, 14], [2, -1960, 11, 14], [-14, -2200, 11, 14], [-4, -2410, 12, 15]], H2.CATH, 14, 16, 12, 15), 10, 180, 0, 1.5),
    twist(path('lab-r1', 'cave', H2.J1, [[14, -1690, 13, 15], [100, -1850, 13, 15]], SKY1, 14, 15, 14, 16), 14, 210, 3, 0.5),
    path('skylight', 'canyon', SKY1, [], SKY2, 15, 60, 15, 60),
    twist(path('lab-r2', 'cave', SKY2, [[150, -2290, 13, 15], [88, -2400, 13, 15], [34, -2465, 14, 16]], H2.CATH, 18, 18, 14, 15), 14, 210, 3, 2),
    path('cathedral', 'cave', H2.CATH, [[8, -2660, 44, 40]], H2.CX, 26, 26, 30, 28),
    // the chimney: out high, a slight rise you have to carry speed over, then a long dive off the ledge
    twist(path('chimney', 'cave', H2.CX, [[38, -2905, 12, 14, 904], [88, -3000, 12, 14, 906]], H2.O1, 13, 15, 14, 16), 12, 190, 2, 0),
    path('ledge', 'valley', H2.O1, [[125, -3290, 45], [70, -3540, 55]], H2.M3, 70, 0, 26),
    // the drain: a long, dark, gently falling tube
    twist(path('drain', 'cave', H2.CX, [[-22, -2960, 12, 13], [-42, -3200, 11, 13], [-22, -3440, 12, 13]], H2.O2, 13, 14, 14, 16), 18, 230, 4, 2.5),
    path('drainout', 'canyon', H2.O2, [], H2.M3, 26, 40, 15, 40),
    path('daylight', 'valley', H2.M3, [[40, -3920, 75], [60, -4160, 70]], H2.K4, 50, 0, 70),
    // the falls: a deep slot into the Eye tunnel; or the rim, round the outside and longer
    path('falls', 'canyon', H2.K4, [[-35, -4600, 14, 60], [-20, -4850, 13, 70], [45, -5050, 13, 70]], H2.E1, 14, 60, 18, 50),
    path('eye', 'cave', H2.E1, [], H2.E2, 15, 17, 14, 16),
    path('rim', 'valley', H2.K4, [[110, -4590, 40], [160, -4880, 40], [155, -5170, 40], [110, -5360, 45]], H2.M4, 60, 0, 45),
    path('out4', 'valley', H2.E2, [], H2.M4, 60, 0, 30),
    path('finale', 'valley', H2.M4, [], H2.FIN, 85, 0, 65),
  ],
  routes: [
    { name: 'Gorge · needle · drain · falls and the Eye', paths: ['s1', 'gorge', 'basin', 'throat', 'maw', 'lab-m', 'cathedral', 'drain', 'drainout', 'daylight', 'falls', 'eye', 'out4', 'finale'] },
    { name: 'Shelf · left sweep · chimney · rim', paths: ['s1', 'shelf', 'basin', 'throat', 'maw', 'lab-l', 'cathedral', 'chimney', 'ledge', 'daylight', 'rim', 'finale'] },
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
    ...slalom('daylight', 0.45, 0.8, 4, 20, 4, 'spire', 50),
  ],
  startAt: ['s1', 0.2],
  splitsAt: [['maw', 0.45], ['cathedral', 0.12], ['daylight', 0.3]],
  finishAt: ['finale', 0.55],
});

// ======================================================================
// 3. Red Rock Slots: a mesa-top start, the deep slot or the wash, the braids round a butte (or through it),
//    the pillar field, the sinkhole dive or the switchbacks, and the Narrows to the finish.
// ======================================================================
const R3 = {
  S: [0, 0, 1400] as Node,
  F1: [-30, -950, 1196] as Node,   // the slot (left) or the wash (right)
  M1: [-15, -1740, 1028] as Node,
  B0: [-10, -1880, 1000] as Node,  // the braids: left, right, or through the butte
  B1: [-8, -2500, 870] as Node,
  P0: [0, -2610, 846] as Node,     // out into the pillar field
  F3: [-20, -3420, 700] as Node,   // the sinkhole (left) or the switchbacks (right)
  M3: [10, -3890, 538] as Node,
  N: [0, -5250, 280] as Node,      // out of the Narrows
  FIN: [-10, -5570, 216] as Node,
};
const G3: Node = [-28, -3500, 683];
const redrock = defineCourse({
  id: 'canyon', version: 1, name: 'Red Rock Slots', biome: 'desert', seed: 63389,
  blurb: 'deep slots, a butte tunnel, the pillar field and the Narrows',
  sections: ['The Slot', 'The Braids', 'Pillar Field', 'The Narrows'],
  look: { caveRock: 0xc9825a, crystal: 0xffcf6a, trees: 1, rocks: 1, clouds: 0.3, lowClouds: false },
  paths: [
    path('s1', 'valley', R3.S, [[40, -300, 110], [0, -640, 105]], R3.F1, 60, 0, 110),
    // the slot: deep, narrow and twisting, and short
    path('slot', 'canyon', R3.F1, [[-40, -1040, 12, 60], [-90, -1170, 10, 80], [-60, -1320, 10, 85], [-95, -1470, 10, 85], [-65, -1610, 11, 75]], R3.M1, 16, 60, 14, 45),
    // the wash: wide, open and longer
    path('wash', 'valley', R3.F1, [[20, -1040, 50], [95, -1230, 55], [95, -1440, 55], [35, -1615, 45]], R3.M1, 30, 0, 50),
    path('s2', 'canyon', R3.M1, [], R3.B0, 20, 45, 22, 45),
    path('braidL', 'canyon', R3.B0, [[-35, -1960, 13, 55], [-95, -2120, 13, 65], [-90, -2290, 13, 65], [-50, -2400, 14, 60], [-22, -2450, 15, 55]], R3.B1, 17, 50, 16, 50),
    path('braidR', 'canyon', R3.B0, [[15, -1960, 13, 55], [80, -2120, 13, 65], [78, -2290, 13, 65], [40, -2400, 14, 60], [8, -2450, 15, 55]], R3.B1, 17, 50, 16, 50),
    twist(path('butte', 'cave', R3.B0, [[-12, -1990, 12, 19], [-12, -2060, 11, 17], [-2, -2300, 11, 17], [-8, -2420, 12, 17]], R3.B1, 14, 18, 16, 22), 16, 220, 0, 0),
    path('s3', 'canyon', R3.B1, [], R3.P0, 30, 40, 20, 50),
    path('field', 'valley', R3.P0, [[35, -2880, 115], [5, -3170, 120]], R3.F3, 60, 0, 60),
    // the sinkhole: a short slot into a steep, dark tube that dives through the mesa
    path('sinkgate', 'canyon', R3.F3, [], G3, 14, 45, 18, 40),
    twist(path('sink', 'cave', G3, [[-34, -3560, 13, 18], [-38, -3640, 12, 18, 642], [-22, -3770, 12, 16, 582]], R3.M3, 14, 16, 14, 20), 10, 190, 0, 1),
    // the switchbacks: an open canyon that snakes down the cliff, longer and gentler
    path('switch', 'canyon', R3.F3, [[25, -3500, 18, 45], [85, -3600, 19, 55], [88, -3720, 19, 60], [48, -3825, 18, 55]], R3.M3, 20, 50, 20, 40),
    path('narrows', 'canyon', R3.M3, [[-10, -4060, 12, 60], [28, -4300, 11, 70], [-12, -4560, 11, 75], [22, -4800, 11, 70], [-14, -5030, 11, 70]], R3.N, 14, 55, 16, 55),
    path('wash2', 'valley', R3.N, [[-10, -5400, 60]], R3.FIN, 80, 0, 30),
  ],
  routes: [
    { name: 'Slot · butte tunnel · sinkhole', paths: ['s1', 'slot', 's2', 'butte', 's3', 'field', 'sinkgate', 'sink', 'narrows', 'wash2'] },
    { name: 'Wash · left braid · switchbacks', paths: ['s1', 'wash', 's2', 'braidL', 's3', 'field', 'switch', 'narrows', 'wash2'] },
    { name: 'Slot · right braid · switchbacks', paths: ['s1', 'slot', 's2', 'braidR', 's3', 'field', 'switch', 'narrows', 'wash2'] },
  ],
  pieces: [
    // lone spires on the mesa top
    { path: 's1', at: 0.35, lat: -40, type: 'spire', r: 5, h: 55 },
    { path: 's1', at: 0.55, lat: 35, type: 'spire', r: 6, h: 60 },
    { path: 's1', at: 0.75, lat: -25, type: 'spire', r: 5, h: 50 },
    // the pillar field: pick your own line through it
    ...[[0.12, -30], [0.18, 25], [0.26, -5], [0.33, 45], [0.38, -50], [0.45, 15], [0.52, -25], [0.58, 50], [0.64, -55], [0.7, 5], [0.77, -30], [0.83, 35]]
      .map(([at, lat], i) => ({ path: 'field', at, lat, type: 'spire' as const, r: 5 + (i % 3), h: 50 + (i % 4) * 12 })),
    // boulders in the Narrows: hop them or squeeze round
    ...slalom('narrows', 0.2, 0.85, 5, 5, 3.2, 'rock'),
  ],
  startAt: ['s1', 0.08],
  splitsAt: [['s2', 0.4], ['field', 0.5], ['narrows', 0.08]],
  finishAt: ['wash2', 0.6],
});

export const COURSES: CourseDef[] = [glacier, hollow, redrock];
export function courseById(id: string) { return COURSES.find((c) => c.id === id) ?? null; }
