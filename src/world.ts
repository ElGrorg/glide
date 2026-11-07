import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeNoise2D, hash2 } from './noise';
import { route, type Biome, type LiveBranch } from './route';
import { SPACE_VOID, spaceBarrier, shipPartsNear, spaceGap } from './space';

// ---------- Terrain shape: an endless downhill mountainside ----------
// Forward is -Z. The ground falls away by SLOPE metres per metre travelled.
export const SLOPE = 0.27;
const SEED = 1337;
const n1 = makeNoise2D(SEED);
const n2 = makeNoise2D(SEED + 1);
const n3 = makeNoise2D(SEED + 2);
const { smoothstep, clamp, lerp } = THREE.MathUtils;

/**
 * Height of the downhill plane (no detail) at depth z. The slope comes in steps:
 * gentler stretches that end in a sudden cliff drop, with the cliff height varying
 * along the run (some stretches have none at all).
 */
const STEP = 380;

// ---------- Arena mode: a bounded basin ringed by mountains, flat on average (no downhill) ----------
export type ArenaId = 'meadow' | 'pillars' | 'peaks' | 'cloudforest' | 'canyons' | 'space';
export interface ArenaEnv {
  id: ArenaId; name: string; blurb: string; biome: Biome;
  /** obstacle densities (multipliers / probabilities) */
  trees: number; spires: number; boulders: number; spireH: number; arches: number;
  /** chance a cloud cell has a cloud, and whether clouds hang low in the trees */
  clouds: number; lowClouds: boolean;
}
export const ARENAS: ArenaEnv[] = [
  { id: 'meadow', name: 'Green Basin', blurb: 'rolling hills, woods and big puffy clouds', biome: 'meadow', trees: 0.9, spires: 0.05, boulders: 0.15, spireH: 1, arches: 0.25, clouds: 0.6, lowClouds: false },
  { id: 'pillars', name: 'Pillar Desert', blurb: 'a forest of rock towers and arches to weave through', biome: 'desert', trees: 0.1, spires: 0.42, boulders: 0.2, spireH: 1.5, arches: 0.6, clouds: 0.35, lowClouds: false },
  { id: 'peaks', name: 'Ice Peaks', blurb: 'jagged peaks to hide behind, ice needles up high', biome: 'alpine', trees: 0.55, spires: 0.12, boulders: 0.14, spireH: 1.2, arches: 0.3, clouds: 0.55, lowClouds: false },
  { id: 'cloudforest', name: 'Cloud Forest', blurb: 'dense woods under thick low cloud: lose them in the mist', biome: 'misty', trees: 1.25, spires: 0.12, boulders: 0.15, spireH: 1, arches: 0.3, clouds: 0.92, lowClouds: true },
  { id: 'canyons', name: 'Autumn Canyons', blurb: 'a plateau cut by winding slot canyons', biome: 'autumn', trees: 0.5, spires: 0.08, boulders: 0.2, spireH: 0.9, arches: 0.35, clouds: 0.45, lowClouds: false },
];
/** Space mode is an arena too (waves, the same menus, online), just one with no ground to speak of: an
 *  capital-ship battle over a planet (see space.ts). It isn't in ARENAS, so "Random" never lands you in space. */
export const SPACE_ARENA: ArenaEnv = { id: 'space', name: 'Fleet Battle', blurb: 'a capital-ship battle in orbit over a wild planet', biome: 'misty', trees: 0, spires: 0, boulders: 0, spireH: 1, arches: 0, clouds: 0, lowClouds: false };
export function isSpace() { return arena?.id === 'space'; }
/** Flyable radius of the arena (metres from the middle); mountains wall it in beyond. */
export const ARENA_R = 620;
/** Past this radius the mountain wall is at full height, so only a bird flying over the wall gets here.
 *  An invisible barrier stands there: nothing steers you, you just can't go any further out. */
export const ARENA_LID_R = ARENA_R + 200;
/** Arena: keep `pos` inside the barrier above the wall. Returns how far it had to push the bird back (m). */
export function arenaBarrier(pos: { x: number; y: number; z: number }): number {
  if (!arena) return 0;
  if (arena.id === 'space') return spaceBarrier(pos);
  const r = Math.hypot(pos.x, pos.z);
  if (r <= ARENA_LID_R) return 0;
  const k = ARENA_LID_R / r;
  pos.x *= k; pos.z *= k;
  return r - ARENA_LID_R;
}
let arena: ArenaEnv | null = null;
export function setArena(a: ArenaEnv | null) { arena = a; }
export function getArena() { return arena; }
/** Level-flight cruise speed the arena's flapping holds (m/s). Climbing still costs speed, diving still adds it. */
export const CRUISE_SPEED = 34;
const CRUISE_DRAG = 0.0016; // same drag as the glide model
/** Forward push from flapping (m/s^2): zero on the endless mountain, enough in the arena to hold cruise
 *  speed in level flight. It fades out high up, so you can't just climb forever. */
export function cruiseThrust(y: number): number {
  if (!arena || arena.id === 'space') return 0;
  return CRUISE_DRAG * CRUISE_SPEED * CRUISE_SPEED * (1 - smoothstep(y, 230, 380));
}

/** Ground effect: skimming low over the ground cushions the wings and pushes you along (m/s^2).
 *  Full push at 1 m or lower, fading out by 6 m, so it only pays to fly right on the deck. Level
 *  skimming tops out where drag catches up (~50 m/s), so it's a reward for staying low, not free speed.
 *  The same for every bird: you, the AI, and online players. None in space. */
export const SKIM_HEIGHT = 6;
const SKIM_ACCEL = 4;
export function skimThrust(x: number, y: number, z: number): number {
  if (isSpace()) return 0;
  const clear = y - terrainHeight(x, z);
  return SKIM_ACCEL * THREE.MathUtils.clamp((SKIM_HEIGHT - clear) / (SKIM_HEIGHT - 1), 0, 1);
}

function arenaCanyon(x: number, z: number): number {
  // winding channels where a ridged noise crosses zero
  const v = Math.abs(n2(x / 330, z / 330));
  return 1 - smoothstep(v, 0.06, 0.13);
}

function arenaHeight(x: number, z: number): number {
  const a = arena!;
  const r = Math.hypot(x, z);
  let h: number;
  switch (a.id) {
    case 'pillars': {
      const dunes = n1(x / 260, z / 260) * 14 + n3(x / 60, z / 60) * 3;
      const mesa = Math.round(Math.max(0, n2(x / 220 + 7, z / 220) * 60) / 14) * 14;
      h = dunes + mesa;
      break;
    }
    case 'peaks': {
      const ridge = (1 - Math.abs(n1(x / 210, z / 210))) ** 3;
      h = n2(x / 300, z / 300) * 20 + ridge * 150 + n3(x / 50, z / 50) * 4;
      break;
    }
    case 'cloudforest':
      h = n1(x / 280, z / 280) * 28 + n2(x / 90, z / 90) * 8 + n3(x / 30, z / 30) * 2;
      break;
    case 'canyons': {
      const c = arenaCanyon(x, z);
      h = 62 + n1(x / 200, z / 200) * 6 - c * 70 + n3(x / 40, z / 40) * 2.5 * (1 - c);
      break;
    }
    default:
      h = n1(x / 320, z / 320) * 34 + Math.max(0, n2(x / 150, z / 150)) ** 2 * 60 + n3(x / 35, z / 35) * 2.5;
  }
  // the starting run in from the south stays clear of big terrain
  const lane = (1 - smoothstep(Math.abs(x), 40, 120)) * smoothstep(z, 250, 420);
  if (a.id !== 'canyons') h = lerp(h, Math.min(h, 10), lane);
  // mountain wall all the way round
  const wall = smoothstep(r, ARENA_R - 40, ARENA_R + 220);
  const ringH = 250 + n1(x / 260 + 31, z / 260) * 90 + (1 - Math.abs(n2(x / 120, z / 120 + 9))) * 40;
  return h + wall * wall * ringH;
}

const ARENA_BRANCH: LiveBranch = { c: 0, open: 1, biome: 'meadow', parent: 'meadow', t: 0, canyon: 0, index: 0 };

export function cliffHeight(z: number): number {
  const a = clamp(n1(z / 3000, 9.3) * 1.3 + 0.35, 0, 1);
  return a * 55 * smoothstep(-z, 400, 900);
}
export function basePlane(z: number): number {
  if (arena) return 0;
  const s = (-z / STEP) - Math.floor(-z / STEP); // 0..1 through each stretch
  const saw = s < 0.95 ? s / 0.95 : 1 - smoothstep(s, 0.95, 1);
  return SLOPE * z + cliffHeight(z) * saw;
}

/** Half-width of a canyon slot at depth z (metres). */
export function canyonHalfWidth(z: number): number {
  return 15 + (n2(z / 260, 5.5) * 0.5 + 0.5) * 14;
}
export const CANYON_FLOOR = -40;  // relative to the downhill plane
export const CANYON_RIM = 60;

const liveTmp: LiveBranch[] = [];
const liveTmp2: LiveBranch[] = [];

/** The valley (route branch) nearest to x at depth z. */
export function nearestBranch(x: number, z: number, lv?: LiveBranch[]): LiveBranch {
  if (arena) { ARENA_BRANCH.biome = ARENA_BRANCH.parent = arena.biome; return ARENA_BRANCH; }
  lv ??= route.live(z, liveTmp2);
  let best = lv[0], bd = Infinity;
  for (const b of lv) {
    const d = Math.abs(x - b.c) + (1 - b.open) * 400;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/** Weight of one environment at (x, z), 0..1. */
export function biomeWeight(b: LiveBranch, biome: Biome): number {
  return (b.parent === biome ? 1 - b.t : 0) + (b.biome === biome ? b.t : 0);
}

/** River strength along the valley floor at depth z (0 = dry). */
function riverAmount(z: number): number {
  return smoothstep(n1(z / 1200, 21.7), -0.1, 0.25) * smoothstep(-z, 300, 600);
}
/** 0..1: how much (x, z) is river water. */
export function riverAt(x: number, z: number, nb?: LiveBranch): number {
  if (arena) return 0;
  nb ??= nearestBranch(x, z);
  if (nb.canyon > 0.2) return 0;
  const wet = riverAmount(z) * (1 - biomeWeight(nb, 'desert'));
  if (wet <= 0) return 0;
  const half = 5 + n3(z / 90, 4.4) * 2.5;
  return wet * (1 - smoothstep(Math.abs(x - nb.c), half, half + 2));
}

export function terrainHeight(x: number, z: number): number {
  if (arena) return arena.id === 'space' ? SPACE_VOID : arenaHeight(x, z);
  const lv = route.live(z, liveTmp);
  // valleys: the nearest open valley wins; closed valleys rise back into the mountainside.
  // Valleys narrow into gorges and open into wide plains along the run.
  const vk = lerp(0.0006, 0.0055, smoothstep(n2(z / 1800, 3.1), -0.4, 0.6));
  let valley = 1e9, nb = lv[0];
  for (const b of lv) {
    const dx = x - b.c;
    const v = 260 + (Math.min(dx * dx * vk, 260) - 260) * b.open;
    if (v < valley) { valley = v; nb = b; }
  }
  // ridge spines between neighbouring valleys
  let spine = 0;
  for (let i = 0; i < lv.length - 1; i++) {
    const gap = lv[i + 1].c - lv[i].c;
    if (gap < 60) continue;
    const mid = (lv[i].c + lv[i + 1].c) / 2, s = gap * 0.17;
    spine += Math.min(1, (gap - 60) / 160) * 105 * Math.exp(-((x - mid) ** 2) / (2 * s * s));
  }
  const desert = biomeWeight(nb, 'desert');
  const alpine = biomeWeight(nb, 'alpine');
  const rough = n3(z / 1500, 11.1) * 0.5 + 0.5; // smooth rolling stretches vs broken ground
  let big = n1(x / 420, z / 420) * 45 * (1 + alpine * 0.6);
  if (alpine > 0) big = lerp(big, ((1 - Math.abs(n1(x / 260, z / 260))) * 2 - 1) * 70, alpine * 0.7); // jagged ridges
  let mid = n2(x / 110, z / 110) * 14 * (0.45 + rough * 1.2);
  if (desert > 0) {
    // desert: stepped mesas
    const stepped = Math.round((big + mid) / 11) * 11;
    big = lerp(big + mid, stepped, desert * 0.85); mid = 0;
  }
  const small = n3(x / 28, z / 28) * 2.5 * (0.5 + rough);
  const ridge = Math.max(0, n2(x / 260 + 40, z / 90)) ** 2 * 40;
  let rel = valley + spine + big + mid + ridge;
  // canyon valleys: a narrow slot with near-vertical walls cut into a raised plateau
  for (const b of lv) {
    if (b.canyon <= 0) continue;
    const adx = Math.abs(x - b.c);
    const w = canyonHalfWidth(z) + n3(x / 60, z / 60) * 4;
    if (adx > w + 70) continue;
    const wall = smoothstep(adx, w, w + 16);
    const profile = CANYON_FLOOR + (CANYON_RIM - CANYON_FLOOR) * wall + n2(x / 110, z / 110) * 7;
    const k = b.canyon * (1 - smoothstep(adx, w + 22, w + 70));
    rel = lerp(rel, profile, k);
  }
  // rivers cut a shallow channel down the valley floor
  const dxr = Math.abs(x - nb.c);
  if (dxr < 14 && nb.canyon <= 0.2) {
    const wet = riverAmount(z) * (1 - desert);
    if (wet > 0) rel -= wet * 2.5 * (1 - smoothstep(dxr, 4, 11));
  }
  return basePlane(z) + rel + small;
}

/** How deep in a canyon slot (x, z) is, 0..1. */
export function canyonAt(x: number, z: number): number {
  if (arena) return arena.id === 'canyons' ? smoothstep(arenaCanyon(x, z), 0.4, 0.9) : 0;
  let best = 0;
  for (const b of route.live(z, liveTmp2)) {
    if (b.canyon <= 0) continue;
    if (Math.abs(x - b.c) < canyonHalfWidth(z) + 6) best = Math.max(best, b.canyon);
  }
  return best;
}

// ---------- Gates: rings, wind tunnels, needles, arches along each valley ----------
export const GATE_SPACING = 210;
export const GATE_START = 380;
export function gateZ(k: number) { return -GATE_START - k * GATE_SPACING; }
export function nearestGateIndex(z: number) { return Math.round((-z - GATE_START) / GATE_SPACING); }
/** Keep trees and rocks off the flight line around each gate. */
function nearGateLine(x: number, z: number): boolean {
  if (arena) return false;
  const k = nearestGateIndex(z);
  if (k < 0) return false;
  const dz = gateZ(k) - z; // positive once past the gate
  if (dz < -30 || dz > 210) return false;
  const nb = nearestBranch(x, z);
  return Math.abs(x - nb.c) < 22;
}

// ---------- Environments ----------
interface Palette { g1: THREE.Color; g2: THREE.Color; dirt: THREE.Color; rock: THREE.Color; snow: boolean }
const pal = (g1: number, g2: number, dirt: number, rock: number, snow = true): Palette =>
  ({ g1: new THREE.Color(g1), g2: new THREE.Color(g2), dirt: new THREE.Color(dirt), rock: new THREE.Color(rock), snow });
const PALETTES: Record<Biome, Palette> = {
  meadow: pal(0x8fbd5a, 0x6e9f45, 0xb39a68, 0x8a8378),
  autumn: pal(0xc9a44a, 0xa9842f, 0x9c7444, 0x8d7f70),
  desert: pal(0xe2a86a, 0xcf8d55, 0xc27a48, 0xb0653f, false),
  alpine: pal(0xeef2f5, 0xd5dde6, 0xb9c3cc, 0x7e868f),
  misty: pal(0x6fa184, 0x55876c, 0x7d8c70, 0x6f7772),
};
/** Sky/fog colour per environment. */
export const SKY_COLOR: Record<Biome, THREE.Color> = {
  meadow: new THREE.Color(0x9fd3f0), autumn: new THREE.Color(0xf2d2a6), desert: new THREE.Color(0xf3cf9e),
  alpine: new THREE.Color(0xd2e6f5), misty: new THREE.Color(0xb7c6c9),
};
export const FOG_FAR: Record<Biome, number> = { meadow: 640, autumn: 600, desert: 700, alpine: 640, misty: 380 };
const TREE_DENSITY: Record<Biome, number> = { meadow: 1, autumn: 1.4, desert: 0.12, alpine: 0.6, misty: 1.05 };
const SPIRE_P: Record<Biome, number> = { meadow: 0.06, autumn: 0.05, desert: 0.2, alpine: 0.13, misty: 0.17 };
const BOULDER_P: Record<Biome, number> = { meadow: 0.15, autumn: 0.12, desert: 0.22, alpine: 0.14, misty: 0.15 };

/** Pick one environment at (x, z), dithered across the blend so borders look natural. */
function biomeAt(x: number, z: number, r: number): Biome {
  const b = nearestBranch(x, z);
  return r < b.t ? b.biome : b.parent;
}

// ---------- Obstacles (deterministic per grid cell) ----------
export type ObstacleType = 'tree' | 'rock' | 'spire' | 'box';
export type TreeKind = 'pine' | 'round' | 'cactus' | 'snowpine';
export interface Obstacle {
  id: string; type: ObstacleType;
  x: number; z: number; y0: number; top: number; r: number; scale: number; tint: number;
  kind?: TreeKind; biome?: Biome;
  /** space (a box of a ship's hull): centre height, heading (ax, az) and half sizes along / up / across */
  cy?: number; ax?: number; az?: number; hx?: number; hy?: number; hz?: number;
  /** space: a block's cross-section at its stern / bow ends [height scale, width scale, drop], and its rounded long edges */
  ta?: number[]; tb?: number[]; rr?: number[];
}

export const TREE_CELL = 13;
export const ROCK_CELL = 37;
const TREE_KIND: Record<Biome, TreeKind> = { meadow: 'pine', autumn: 'round', desert: 'cactus', alpine: 'snowpine', misty: 'pine' };
const TREE_SHAPE: Record<TreeKind, { h: number; r: number }> = {
  pine: { h: 8, r: 2.3 }, round: { h: 7.4, r: 2.8 }, cactus: { h: 5.5, r: 1.0 }, snowpine: { h: 9, r: 2.1 },
};

function forestDensity(x: number, z: number): number {
  return clamp(n1(x / 160 + 100, z / 160) * 0.9 + 0.35, 0, 0.85);
}

export function treeAt(ix: number, iz: number): Obstacle | null {
  const x = (ix + 0.15 + hash2(ix, iz, 1) * 0.7) * TREE_CELL;
  const z = (iz + 0.15 + hash2(ix, iz, 2) * 0.7) * TREE_CELL;
  const biome = biomeAt(x, z, hash2(ix, iz, 6));
  const dens = biome === 'desert' ? 0.3 : forestDensity(x, z);
  if (hash2(ix, iz, 3) > dens * (arena ? arena.trees : TREE_DENSITY[biome])) return null;
  if (arena && arena.id === 'canyons' && arenaCanyon(x, z) > 0.3) return null; // keep the slots flyable
  if (nearGateLine(x, z) || riverAt(x, z) > 0.05) return null;
  // avoid steep faces
  const y0 = terrainHeight(x, z);
  const gx = terrainHeight(x + 2, z) - terrainHeight(x - 2, z);
  const gz = terrainHeight(x, z + 2) - terrainHeight(x, z - 2);
  if (Math.hypot(gx, gz) / 4 > 1.0) return null;
  const kind = TREE_KIND[biome];
  const shape = TREE_SHAPE[kind];
  const scale = 0.8 + hash2(ix, iz, 4) * 1.4;
  const h = shape.h * scale;
  return { id: `t${ix},${iz}`, type: 'tree', x, z, y0: y0 - 0.8, top: y0 + h - 0.8, r: shape.r * scale, scale, tint: hash2(ix, iz, 5), kind, biome };
}

export function rockAt(ix: number, iz: number): Obstacle | null {
  const roll = hash2(ix, iz, 11);
  const x = (ix + 0.2 + hash2(ix, iz, 12) * 0.6) * ROCK_CELL;
  const z = (iz + 0.2 + hash2(ix, iz, 13) * 0.6) * ROCK_CELL;
  const biome = biomeAt(x, z, hash2(ix, iz, 19));
  const sp = arena ? arena.spires : SPIRE_P[biome], bp = sp + (arena ? arena.boulders : BOULDER_P[biome]);
  if (roll >= bp) return null;
  if (nearGateLine(x, z) || riverAt(x, z) > 0.05) return null;
  const y0 = terrainHeight(x, z);
  if (roll < sp) {
    // tall spire: something to thread between (pillar fields in the desert, ice needles up high)
    const scale = 0.7 + hash2(ix, iz, 14) * 0.9;
    const h = (30 + hash2(ix, iz, 15) * 45) * (arena ? arena.spireH : 1);
    return { id: `s${ix},${iz}`, type: 'spire', x, z, y0: y0 - 3, top: y0 + h, r: 6 * scale, scale, tint: hash2(ix, iz, 16), biome };
  }
  const scale = 2 + hash2(ix, iz, 17) * 5;
  return { id: `r${ix},${iz}`, type: 'rock', x, z, y0: y0 + scale * 0.25, top: y0 + scale * 1.2, r: scale, scale, tint: hash2(ix, iz, 18), biome };
}

// Rock bridges spanning canyon slots: fly under, or over, but not through.
export const BRIDGE_CELL = 95;
export function bridgesAt(iz: number, out: Obstacle[]) {
  if (arena) return;
  const z = (iz + 0.5) * BRIDGE_CELL;
  // keep bridges clear of gates and wind tunnels
  const gd = gateZ(nearestGateIndex(z)) - z;
  if (gd > -35 && gd < 200) return;
  for (const b of route.live(z, liveTmp2).slice()) {
    if (b.canyon < 0.85 || hash2(iz, b.index, 61) > 0.55) continue;
    const w = canyonHalfWidth(z) + 14;
    const y = basePlane(z) + CANYON_FLOOR + 10 + hash2(iz, b.index, 62) * 28;
    const n = Math.ceil((2 * w) / 5.5);
    for (let j = 0; j <= n; j++) {
      const x = b.c - w + (2 * w * j) / n;
      const r = 3.3 + hash2(iz * 7 + j, b.index, 63) * 0.8;
      out.push({ id: `b${iz}.${b.index}.${j}`, type: 'rock', x, z: z + (hash2(iz, j, 64) - 0.5) * 2, y0: y + Math.sin(j * 1.3) * 0.8, top: y + r, r, scale: r, tint: hash2(iz, j, 65), biome: b.biome });
    }
  }
}

// Arena arches: two rock pillars joined by a span of boulders. Fly under, or over, but not through.
export const ARCH_CELL = 170;
export function archAt(ix: number, iz: number, out: Obstacle[]) {
  if (!arena || hash2(ix, iz, 71) > arena.arches) return;
  const cx = (ix + 0.3 + hash2(ix, iz, 72) * 0.4) * ARCH_CELL, cz = (iz + 0.3 + hash2(ix, iz, 73) * 0.4) * ARCH_CELL;
  if (Math.hypot(cx, cz) > ARENA_R - 60) return;
  const ang = hash2(ix, iz, 74) * Math.PI;
  const half = 14 + hash2(ix, iz, 75) * 12;
  const ax = Math.cos(ang), az = Math.sin(ang);
  const g1 = terrainHeight(cx - ax * half, cz - az * half), g2 = terrainHeight(cx + ax * half, cz + az * half);
  const top = Math.max(g1, g2, terrainHeight(cx, cz)) + 22 + hash2(ix, iz, 76) * 26;
  const id = `a${ix},${iz}`;
  for (const s of [-1, 1]) {
    const px = cx + ax * half * s, pz = cz + az * half * s;
    out.push({ id: `${id}p${s}`, type: 'spire', x: px, z: pz, y0: terrainHeight(px, pz) - 3, top: top + 2, r: 4.5, scale: 1, tint: hash2(ix, iz, 77), biome: arena.biome });
  }
  const n = Math.ceil((2 * half) / 5.5);
  for (let j = 1; j < n; j++) {
    const f = j / n, x = cx + ax * half * (2 * f - 1), z = cz + az * half * (2 * f - 1);
    const r = 3.2 + hash2(ix * 7 + j, iz, 78) * 0.8;
    out.push({ id: `${id}.${j}`, type: 'rock', x, z, y0: top + Math.sin(f * Math.PI) * 3, top: top + r, r, scale: r, tint: hash2(ix, j, 79), biome: arena.biome });
  }
}

/** All obstacles whose cells touch the circle around (x, z). */
export function obstaclesNear(x: number, z: number, radius: number, out: Obstacle[] = []): Obstacle[] {
  out.length = 0;
  if (arena?.id === 'space') return shipPartsNear(x, z, radius, out);
  const t0x = Math.floor((x - radius) / TREE_CELL), t1x = Math.floor((x + radius) / TREE_CELL);
  const t0z = Math.floor((z - radius) / TREE_CELL), t1z = Math.floor((z + radius) / TREE_CELL);
  for (let ix = t0x; ix <= t1x; ix++) for (let iz = t0z; iz <= t1z; iz++) { const o = treeAt(ix, iz); if (o) out.push(o); }
  const r0x = Math.floor((x - radius - 30) / ROCK_CELL), r1x = Math.floor((x + radius + 30) / ROCK_CELL);
  const r0z = Math.floor((z - radius - 30) / ROCK_CELL), r1z = Math.floor((z + radius + 30) / ROCK_CELL);
  for (let ix = r0x; ix <= r1x; ix++) for (let iz = r0z; iz <= r1z; iz++) { const o = rockAt(ix, iz); if (o) out.push(o); }
  for (let iz = Math.floor((z - radius - 5) / BRIDGE_CELL); iz <= Math.floor((z + radius + 5) / BRIDGE_CELL); iz++) bridgesAt(iz, out);
  if (arena) {
    const m = 40; // arches reach this far from their cell's anchor
    for (let ix = Math.floor((x - radius - m) / ARCH_CELL); ix <= Math.floor((x + radius + m) / ARCH_CELL); ix++)
      for (let iz = Math.floor((z - radius - m) / ARCH_CELL); iz <= Math.floor((z + radius + m) / ARCH_CELL); iz++) {
        const before = out.length;
        archAt(ix, iz, out);
        // keep only the parts near the query (cheap filter)
        for (let i = out.length - 1; i >= before; i--) if (Math.abs(out[i].x - x) > radius + 8 || Math.abs(out[i].z - z) > radius + 8) out.splice(i, 1);
      }
  }
  return out;
}

/** Signed gap between a point and an obstacle's surface (negative = inside). */
export function obstacleGap(o: Obstacle, px: number, py: number, pz: number): number {
  if (o.cy !== undefined) return spaceGap(o, px, py, pz);
  const dx = px - o.x, dz = pz - o.z;
  if (o.type === 'rock') return Math.hypot(dx, py - o.y0, dz) - o.r;
  const horiz = Math.hypot(dx, dz);
  if (py > o.top) return Math.hypot(Math.max(0, horiz - (o.type === 'spire' ? o.r : 0)), py - o.top);
  if (py < o.y0) return 99;
  let rEff = o.r;
  if (o.type === 'tree') {
    const h = o.top - o.y0;
    const t = (py - o.y0) / h; // 0 at base, 1 at top
    if (o.kind === 'cactus') rEff = o.r;
    else if (o.kind === 'round') rEff = t < 0.3 ? 0.5 * o.scale : o.r * Math.sin(Math.min(1, (t - 0.3) / 0.7) * Math.PI) * 0.9 + 0.3;
    else rEff = t < 0.2 ? 0.5 * o.scale : o.r * Math.min(1, (1 - t) / 0.8) * 0.85;
  }
  return horiz - rEff;
}

// ---------- Clouds ----------
export interface Cloud { id: string; puffs: { x: number; y: number; z: number; r: number }[] }
export const CLOUD_CELL = 150;
export function cloudAt(ix: number, iz: number): Cloud | null {
  if (arena?.id === 'space') return null;
  const cx0 = (ix + 0.5) * CLOUD_CELL, cz0 = (iz + 0.5) * CLOUD_CELL;
  if (arena && Math.hypot(cx0, cz0) > ARENA_R + 150) return null;
  const misty = arena ? (arena.lowClouds ? 1 : 0) : biomeWeight(nearestBranch(cx0, cz0), 'misty');
  if (hash2(ix, iz, 31) > (arena ? arena.clouds : 0.6 + misty * 0.35)) return null;
  const cx = cx0 + (hash2(ix, iz, 32) - 0.5) * 80;
  const cz = cz0 + (hash2(ix, iz, 33) - 0.5) * 80;
  const ground = terrainHeight(cx, cz);
  // misty valleys hang their clouds low, right in the flight path
  const low = misty > 0.5 && (!arena || hash2(ix, iz, 40) < 0.65);
  const cy = low ? ground + 8 + hash2(ix, iz, 34) * 22
    : arena ? Math.max(ground + 22, 30 + hash2(ix, iz, 34) * 120)
    : Math.max(ground + 22, basePlane(cz) + 15 + hash2(ix, iz, 34) * 90);
  const count = 5 + Math.floor(hash2(ix, iz, 35) * 7) + (low ? 4 : 0);
  const puffs = [];
  for (let i = 0; i < count; i++) {
    const r = 9 + hash2(ix * 7 + i, iz, 36) * 14;
    puffs.push({
      x: cx + (hash2(ix, iz * 5 + i, 37) - 0.5) * 70,
      y: cy + (hash2(ix + i, iz, 38) - 0.5) * 14,
      z: cz + (hash2(ix, iz + i * 3, 39) - 0.5) * 45,
      r,
    });
  }
  return { id: `c${ix},${iz}`, puffs };
}

// ---------- Shared geometry & materials ----------
function colorize(g: THREE.BufferGeometry, c: THREE.ColorRepresentation) {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
const ni = (g: THREE.BufferGeometry, c: number) => colorize(g.toNonIndexed(), c);

const TREE_GEO: Record<TreeKind, THREE.BufferGeometry> = {
  pine: mergeGeometries([
    ni(new THREE.CylinderGeometry(0.35, 0.5, 2.4, 5).translate(0, 1.2, 0), 0x6b4a2f),
    ni(new THREE.ConeGeometry(2.3, 4.2, 6).translate(0, 3.6, 0), 0x3f7a3a),
    ni(new THREE.ConeGeometry(1.7, 3.4, 6).translate(0, 5.6, 0), 0x4c8c42),
    ni(new THREE.ConeGeometry(1.0, 2.4, 6).translate(0, 7.0, 0), 0x5a9d4c),
  ])!,
  snowpine: mergeGeometries([
    ni(new THREE.CylinderGeometry(0.35, 0.5, 2.4, 5).translate(0, 1.2, 0), 0x5b4030),
    ni(new THREE.ConeGeometry(2.1, 4.4, 6).translate(0, 3.8, 0), 0x2f5a44),
    ni(new THREE.ConeGeometry(1.6, 3.4, 6).translate(0, 6.0, 0), 0xe6edf2),
    ni(new THREE.ConeGeometry(0.9, 2.6, 6).translate(0, 7.7, 0), 0xf6f9fb),
  ])!,
  round: mergeGeometries([
    ni(new THREE.CylinderGeometry(0.3, 0.45, 3.2, 5).translate(0, 1.6, 0), 0x6b4a2f),
    ni(new THREE.IcosahedronGeometry(2.8, 0).scale(1, 1.05, 1).translate(0, 4.8, 0), 0xe0812c),
  ])!,
  cactus: mergeGeometries([
    ni(new THREE.CylinderGeometry(0.5, 0.55, 5.5, 6).translate(0, 2.75, 0), 0x5f8f3e),
    ni(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 6).rotateZ(Math.PI / 2).translate(0.8, 2.4, 0), 0x5a873a),
    ni(new THREE.CylinderGeometry(0.28, 0.3, 1.8, 6).translate(1.5, 3.2, 0), 0x5f8f3e),
    ni(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 6).rotateZ(Math.PI / 2).translate(-0.7, 3.4, 0), 0x5a873a),
    ni(new THREE.CylinderGeometry(0.26, 0.28, 1.5, 6).translate(-1.25, 4.0, 0), 0x5f8f3e),
  ])!,
};
const AUTUMN_TINTS = [new THREE.Color(1, 1, 1), new THREE.Color(1.05, 0.62, 0.5), new THREE.Color(1.12, 1.15, 0.55), new THREE.Color(0.95, 0.78, 0.55)];
const rockGeo = colorize(new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), 0x8d877c);
const spireGeo = colorize(new THREE.CylinderGeometry(0.55, 1, 1, 6, 3).translate(0, 0.5, 0).toNonIndexed(), 0x857c70);
const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
const ROCK_TINT: Record<Biome, THREE.Color> = {
  meadow: new THREE.Color(1, 1, 1), autumn: new THREE.Color(1.02, 0.97, 0.9), desert: new THREE.Color(1.3, 0.82, 0.62),
  alpine: new THREE.Color(0.95, 1.08, 1.22), misty: new THREE.Color(0.72, 0.95, 0.8),
};

export const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
export const cloudMat = new THREE.MeshLambertMaterial({
  color: 0xffffff, emissive: 0xb8c4d6, emissiveIntensity: 0.45, flatShading: true, transparent: true, opacity: 0.88,
});

// ---------- Chunks ----------
export const CHUNK = 120;
const SEG = 30;
const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
const WATER = new THREE.Color(0x4f9fd1), FOAM = new THREE.Color(0xeaf6fb);

function paletteColor(p: Palette, cz: number, ny: number, h: number, v: number, out: THREE.Color) {
  const rel = h - basePlane(cz); // height above the downhill plane
  out.copy(p.g1).lerp(p.g2, v);
  if (rel < -8) out.lerp(p.dirt, 0.5);
  if (ny < 0.82) out.lerp(p.rock, clamp((0.82 - ny) * 5, 0, 1));
  if (p.snow && rel > 140 + v * 40) out.lerp(PALETTES.alpine.g1, clamp((rel - 140 - v * 40) / 30, 0, 1));
}

function faceColor(cx: number, cz: number, ny: number, h: number, out: THREE.Color) {
  const v = n3(cx / 40, cz / 40) * 0.5 + 0.5;
  const b = nearestBranch(cx, cz);
  paletteColor(PALETTES[b.parent], cz, ny, h, v, out);
  if (b.t > 0 && b.biome !== b.parent) {
    paletteColor(PALETTES[b.biome], cz, ny, h, v, tmpC2);
    out.lerp(tmpC2, b.t);
  }
  const river = riverAt(cx, cz, b);
  if (river > 0.5) {
    // water: blue, with white water where it tumbles over a cliff
    const fall = ny < 0.8 ? 1 : 0;
    out.copy(WATER).lerp(FOAM, fall * 0.8 + (hash2(Math.floor(cx), Math.floor(cz), 8) < 0.12 ? 0.35 : 0));
  }
  // tiny per-face jitter sells the low-poly look
  out.offsetHSL(0, 0, (hash2(Math.floor(cx * 3), Math.floor(cz * 3), 9) - 0.5) * 0.04);
}

export class Chunk {
  group = new THREE.Group();
  clouds: Cloud[] = [];
  constructor(public cx: number, public cz: number) {
    this.group.add(this.buildGround());
    this.buildObstacles();
    this.buildClouds();
  }

  private buildGround() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK, step = CHUNK / SEG;
    const N = SEG + 1;
    const hs = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hs[j * N + i] = terrainHeight(x0 + i * step, z0 + j * step);
    const pos = new Float32Array(SEG * SEG * 6 * 3);
    const col = new Float32Array(SEG * SEG * 6 * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    let p = 0;
    const tri = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
      a.set(x0 + i0 * step, hs[j0 * N + i0], z0 + j0 * step);
      b.set(x0 + i1 * step, hs[j1 * N + i1], z0 + j1 * step);
      c.set(x0 + i2 * step, hs[j2 * N + i2], z0 + j2 * step);
      e1.subVectors(b, a); e2.subVectors(c, a);
      const nrm = e1.cross(e2).normalize();
      faceColor((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, Math.abs(nrm.y), (a.y + b.y + c.y) / 3, tmpC);
      for (const v of [a, b, c]) {
        pos[p] = v.x; pos[p + 1] = v.y; pos[p + 2] = v.z;
        col[p] = tmpC.r; col[p + 1] = tmpC.g; col[p + 2] = tmpC.b;
        p += 3;
      }
    };
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      if ((i + j) % 2 === 0) { tri(i, j, i, j + 1, i + 1, j); tri(i + 1, j, i, j + 1, i + 1, j + 1); }
      else { tri(i, j, i, j + 1, i + 1, j + 1); tri(i, j, i + 1, j + 1, i + 1, j); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return new THREE.Mesh(g, solidMat);
  }

  private buildObstacles() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK;
    const trees: Record<TreeKind, Obstacle[]> = { pine: [], round: [], cactus: [], snowpine: [] };
    const rocks: Obstacle[] = [], spires: Obstacle[] = [];
    for (let ix = Math.ceil(x0 / TREE_CELL); ix < Math.ceil((x0 + CHUNK) / TREE_CELL); ix++)
      for (let iz = Math.ceil(z0 / TREE_CELL); iz < Math.ceil((z0 + CHUNK) / TREE_CELL); iz++) {
        const t = treeAt(ix, iz); if (t) trees[t.kind!].push(t);
      }
    for (let ix = Math.ceil(x0 / ROCK_CELL); ix < Math.ceil((x0 + CHUNK) / ROCK_CELL); ix++)
      for (let iz = Math.ceil(z0 / ROCK_CELL); iz < Math.ceil((z0 + CHUNK) / ROCK_CELL); iz++) {
        const r = rockAt(ix, iz); if (r) (r.type === 'spire' ? spires : rocks).push(r);
      }
    const bridgeParts: Obstacle[] = [];
    for (let iz = Math.floor(z0 / BRIDGE_CELL); iz <= Math.floor((z0 + CHUNK) / BRIDGE_CELL); iz++) bridgesAt(iz, bridgeParts);
    if (arena) for (let ix = Math.floor((x0 - 40) / ARCH_CELL); ix <= Math.floor((x0 + CHUNK + 40) / ARCH_CELL); ix++)
      for (let iz = Math.floor((z0 - 40) / ARCH_CELL); iz <= Math.floor((z0 + CHUNK + 40) / ARCH_CELL); iz++) archAt(ix, iz, bridgeParts);
    for (const o of bridgeParts) if (o.type === 'spire' && o.x >= x0 && o.x < x0 + CHUNK && o.z >= z0 && o.z < z0 + CHUNK) spires.push(o);
    for (const o of bridgeParts) if (o.type === 'rock' && o.x >= x0 && o.x < x0 + CHUNK && o.z >= z0 && o.z < z0 + CHUNK) rocks.push(o);

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3();
    const c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of Object.keys(trees) as TreeKind[]) {
      const list = trees[kind];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(TREE_GEO[kind], solidMat, list.length);
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.tint * 6.28);
        m.compose(pv.set(t.x, t.y0, t.z), q, s.setScalar(t.scale));
        im.setMatrixAt(i, m);
        if (kind === 'round') im.setColorAt(i, c.copy(AUTUMN_TINTS[Math.floor(t.tint * 4) % 4]));
        else im.setColorAt(i, c.setScalar(0.85 + t.tint * 0.3));
      });
      this.group.add(im);
    }
    if (rocks.length) {
      const im = new THREE.InstancedMesh(rockGeo, solidMat, rocks.length);
      rocks.forEach((r, i) => {
        q.setFromEuler(new THREE.Euler(r.tint * 3, r.tint * 7, r.tint * 5));
        m.compose(pv.set(r.x, r.y0, r.z), q, s.set(r.scale, r.scale * (0.7 + r.tint * 0.4), r.scale));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.copy(ROCK_TINT[r.biome ?? 'meadow']).multiplyScalar(0.85 + r.tint * 0.3));
      });
      this.group.add(im);
    }
    if (spires.length) {
      const im = new THREE.InstancedMesh(spireGeo, solidMat, spires.length);
      spires.forEach((r, i) => {
        q.setFromAxisAngle(up, r.tint * 6.28);
        m.compose(pv.set(r.x, r.y0, r.z), q, s.set(r.r, r.top - r.y0, r.r));
        im.setMatrixAt(i, m);
        im.setColorAt(i, c.copy(ROCK_TINT[r.biome ?? 'meadow']).multiplyScalar(0.8 + r.tint * 0.3));
      });
      this.group.add(im);
    }
  }

  private buildClouds() {
    const x0 = this.cx * CHUNK, z0 = this.cz * CHUNK;
    const puffs: Cloud['puffs'] = [];
    for (let ix = Math.ceil(x0 / CLOUD_CELL); ix < Math.ceil((x0 + CHUNK) / CLOUD_CELL); ix++)
      for (let iz = Math.ceil(z0 / CLOUD_CELL); iz < Math.ceil((z0 + CHUNK) / CLOUD_CELL); iz++) {
        const cl = cloudAt(ix, iz); if (cl) { this.clouds.push(cl); puffs.push(...cl.puffs); }
      }
    if (!puffs.length) return;
    const im = new THREE.InstancedMesh(cloudGeo, cloudMat, puffs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pv = new THREE.Vector3();
    puffs.forEach((p, i) => { m.compose(pv.set(p.x, p.y, p.z), q, s.set(p.r, p.r * 0.7, p.r)); im.setMatrixAt(i, m); });
    im.renderOrder = 2;
    this.group.add(im);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}

export class World {
  chunks = new Map<string, Chunk>();
  constructor(private scene: THREE.Scene, public radius = 4) {}

  /** Drop every chunk (a new run has a new route). */
  reset() {
    for (const c of this.chunks.values()) { this.scene.remove(c.group); c.dispose(); }
    this.chunks.clear();
  }

  /** Stream chunks around a focus point (biased ahead of the bird). Builds at most `budget` per call. */
  update(fx: number, fz: number, budget = 2) {
    if (arena?.id === 'space') { if (this.chunks.size) this.reset(); return 0; } // nothing to stand on up here
    const ccx = Math.floor(fx / CHUNK), ccz = Math.floor(fz / CHUNK);
    const R = this.radius;
    const want: [number, number, number][] = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const d = dx * dx + dz * dz;
      if (d > R * R + 1) continue;
      want.push([ccx + dx, ccz + dz, d]);
    }
    want.sort((a, b) => a[2] - b[2]);
    let built = 0;
    for (const [x, z] of want) {
      const k = `${x},${z}`;
      if (!this.chunks.has(k) && built < budget) {
        const c = new Chunk(x, z);
        this.chunks.set(k, c);
        this.scene.add(c.group);
        built++;
      }
    }
    for (const [k, c] of this.chunks) {
      const [x, z] = k.split(',').map(Number);
      if (Math.abs(x - ccx) > R + 1 || Math.abs(z - ccz) > R + 1) {
        this.scene.remove(c.group); c.dispose(); this.chunks.delete(k);
      }
    }
    return built;
  }

  /** Is the point inside any cloud puff? Returns 0..1 depth and the cloud id. */
  cloudDepth(x: number, y: number, z: number): { depth: number; id: string | null } {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    let best = 0, id: string | null = null;
    // clouds can spill into neighbouring chunks, so check the 3x3 around
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.chunks.get(`${cx + dx},${cz + dz}`);
      if (!c) continue;
      for (const cl of c.clouds) for (const p of cl.puffs) {
        const d = Math.hypot((x - p.x) / p.r, (y - p.y) / (p.r * 0.7), (z - p.z) / p.r);
        const depth = 1 - d;
        if (depth > best) { best = depth; id = cl.id; }
      }
    }
    return { depth: best, id };
  }
}
