import { defineCourse, type CourseDef, type CtrlPt, type PathDef, type PathKind, type PieceDef } from './course';

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
    path('boreL', 'cave', G.C1, [[-92, -1362, 12, 16], [-150, -1510, 11, 15], [-160, -1700, 12, 16], [-95, -1880, 11, 15]], G.C2, 12, 16, 12, 16),
    path('boreR', 'cave', G.C1, [[-70, -1362, 12, 16], [-55, -1510, 12, 15], [-40, -1700, 11, 16], [-15, -1880, 12, 15]], G.C2, 12, 16, 12, 16),
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
    path('low', 'cave', G.P3, [[-12, -3968, 13, 15], [-52, -4045, 12, 14, 752], [-98, -4175, 11, 14], [-104, -4266, 14, 15, 688], [-48, -4368, 14, 15], [-3, -4425, 14, 16]], G.H, 16, 18, 13, 16),
    path('mid', 'cave', G.P3, [[-2, -3970, 14, 16], [-5, -4080, 22, 20], [12, -4280, 26, 22]], G.H, 24, 22, 14, 16),
    path('high', 'cave', G.P3, [[12, -3968, 13, 15], [54, -4045, 12, 15, 752], [100, -4170, 12, 15], [104, -4262, 15, 16, 728], [64, -4368, 14, 15], [22, -4425, 14, 16]], G.H, 16, 18, 13, 16),
    path('hall', 'cave', G.H, [[28, -4660, 36, 30]], G.P4, 16, 18, 32, 24),
    path('s4', 'valley', G.P4, [[90, -5100, 60], [70, -5330, 70, 0, 520], [10, -5480, 75, 0, 452], [-60, -5800, 80], [-20, -6000, 80]], G.E, 90, 0, 40),
  ],
  routes: [
    { name: 'Ice bores (left) · steep couloir · middle hall', paths: ['s1', 'gate1', 'boreL', 'out1', 's2', 'steep', 's3', 'gate3', 'mid', 'hall', 's4'] },
    { name: 'Ice bores (right) · gully · low cave', paths: ['s1', 'gate1', 'boreR', 'out1', 's2', 'gully', 's3', 'gate3', 'low', 'hall', 's4'] },
    { name: 'The col · steep couloir · high cave', paths: ['s1', 'col', 's2', 'steep', 's3', 'gate3', 'high', 'hall', 's4'] },
  ],
  pieces: [
    ...slalom('mid', 0.3, 0.85, 5, 9, 3.2),
    { path: 'hall', at: 0.5, lat: 0, type: 'column', r: 5 },
    { path: 'hall', at: 0.74, lat: -15, type: 'column', r: 4 },
    { path: 'hall', at: 0.74, lat: 15, type: 'column', r: 4 },
    ...slalom('s4', 0.58, 0.72, 5, 22, 3.5, 'spire', 45),
  ],
  startAt: ['s1', 0.25],
  splitsAt: [['s2', 0.4], ['s3', 0.45], ['s4', 0.2]],
  finishAt: ['s4', 0.78],
});

export const COURSES: CourseDef[] = [glacier];
export function courseById(id: string) { return COURSES.find((c) => c.id === id) ?? null; }
