import * as THREE from 'three';
import { hash2 } from './noise';

// ---------- Capital ships: original designs, built from chamfered, tapering hull blocks ----------
// Every block is a "loft": a box whose cross-section (with its long edges chamfered) can shrink and drop
// toward either end, so bows come to a wedge, decks step back and slope, pods round off. The same blocks
// are the collision shape (space.ts reads them), so what you see is what you hit.
// Frame: u along the ship (+ = bow), v up, w across (+ = starboard).

/** Cross-section at one end of a block: [height scale, width scale, vertical shift (m)]. */
export type Taper = [sv: number, sw: number, dv: number];
/** Chamfer (m) on the four long edges: [top at w0, top at w1, bottom at w1, bottom at w0]. */
export type Chamfer = [number, number, number, number];
export type Look = 'hull' | 'dark' | 'deck' | 'armor' | 'trim';
export interface Part {
  u0: number; u1: number; v0: number; v1: number; w0: number; w1: number;
  ta?: Taper; tb?: Taper; c?: Chamfer; look?: Look;
  /** false: looks only (antenna, dish, small greeble), not part of the hit shape */
  solid?: boolean;
  /** rows of lit windows down its sides */
  win?: number;
}
/** An engine nozzle on the stern face at u, centred (v, w), radius r. */
export interface Nozzle { u: number; v: number; w: number; r: number }
/** An opening you can fly through: its centre (ship frame), which axis you fly along, and its half size. */
export interface Opening { u: number; v: number; w: number; along: 'u' | 'w'; hv: number; hs: number; kind: 'hangar' | 'hull' }
export interface Hull {
  len: number; parts: Part[]; nozzles: Nozzle[]; openings: Opening[];
  /** point-defence and main turrets: position on a deck top and size */
  turrets: [u: number, v: number, w: number, s: number][];
  /** blinking beacons (masts, wingtips, bow) */
  beacons: [u: number, v: number, w: number][];
  /** glowing guide strips (hangar mouths, tunnel mouths): boxes */
  guides: Part[];
}

const ch = (t: number, b = t): Chamfer => [t, t, b, b];
const mir = (p: Part): Part => ({ ...p, w0: -p.w1, w1: -p.w0, c: p.c ? [p.c[1], p.c[0], p.c[3], p.c[2]] : undefined });
const P = (u0: number, u1: number, v0: number, v1: number, w0: number, w1: number, o: Partial<Part> = {}): Part => ({ u0, u1, v0, v1, w0, w1, ...o });

/** Carrier: a broad armoured hull with a hangar bay running end to end (fly in the bow, out the stern),
 *  stepped flight decks rising to a command tower, armour blisters down the flanks. */
export function carrier(L: number, h: (k: number) => number): Hull {
  const H = L * 0.13, W = L * 0.22, hv = 17, hs = 20, Hh = H / 2, Wh = W / 2;
  const sB = -0.42 * L, bow = 0.3 * L;
  const parts: Part[] = [];
  // hull sides either side of the bay, the bay roof and floor
  const side = P(sB, bow, -Hh, Hh, -Wh, -hs, { c: [7, 0, 0, 7], win: 2 });
  parts.push(side, mir(side));
  parts.push(P(sB, bow, hv, Hh, -hs, hs, { look: 'deck' }), P(sB, bow, -Hh, -hv, -hs, hs, { look: 'dark' }));
  // forked bow: two wedge prongs either side of the bay mouth, the mouth flaring open between them
  const prong = P(bow, 0.5 * L, -Hh, Hh, -Wh, -hs, { c: [7, 0, 0, 7], tb: [0.42, 0.5, -H * 0.12] });
  parts.push(prong, mir(prong));
  // stepped flight decks
  parts.push(P(-0.4 * L, 0.2 * L, Hh, Hh + H * 0.2, -W * 0.38, W * 0.38, { c: [4, 4, 0, 0], tb: [0.7, 0.72, -H * 0.03], look: 'deck', win: 1 }));
  parts.push(P(-0.36 * L, -0.01 * L, Hh + H * 0.2, Hh + H * 0.38, -W * 0.26, W * 0.26, { c: [3, 3, 0, 0], tb: [0.6, 0.78, -H * 0.04], look: 'hull' }));
  // command tower, stepped, with a wide swept bridge on top
  const tu = -0.27 * L + h(7) * 0.04 * L;
  parts.push(P(tu - 0.06 * L, tu + 0.07 * L, Hh + H * 0.38, Hh + H * 0.7, -W * 0.13, W * 0.13, { c: [2, 2, 0, 0], tb: [0.85, 0.8, -1], look: 'hull', win: 2 }));
  parts.push(P(tu - 0.035 * L, tu + 0.035 * L, Hh + H * 0.7, Hh + H * 0.86, -W * 0.07, W * 0.07, { look: 'dark' }));
  parts.push(P(tu - 0.06 * L, tu + 0.06 * L, Hh + H * 0.86, Hh + H * 1.02, -W * 0.24, W * 0.24, { c: ch(2.5), ta: [0.8, 0.92, 0], tb: [0.5, 0.8, -1.5], look: 'hull', win: 1 }));
  // stern: engine housings round the bay's back door
  const sE = -0.5 * L;
  parts.push(P(sE, sB, hv, Hh - 2, -Wh + 2, Wh - 2, { c: [4, 4, 0, 0], look: 'dark' }));
  parts.push(P(sE, sB, -Hh + 2, -hv, -Wh + 2, Wh - 2, { c: [0, 0, 4, 4], look: 'dark' }));
  const sideE = P(sE, sB, -hv, hv, -Wh + 2, -hs, { look: 'dark' });
  parts.push(sideE, mir(sideE));
  // armour blisters along the flanks and a keel under the belly
  const blister = P(-0.33 * L, 0.2 * L, -H * 0.3, H * 0.16, -Wh - 5, -Wh, { c: [2.5, 0, 0, 2.5], ta: [0.55, 0.6, -1], tb: [0.45, 0.6, -1], look: 'armor' });
  parts.push(blister, mir(blister));
  parts.push(P(-0.3 * L, 0.16 * L, -Hh - H * 0.22, -Hh, -W * 0.14, W * 0.14, { c: [0, 0, 3, 3], ta: [0.6, 0.7, 2], tb: [0.25, 0.4, 4], look: 'dark' }));
  // masts and a sensor block on the bridge (looks only)
  const top = Hh + H * 1.02;
  parts.push(P(tu - 0.5, tu + 0.5, top, top + 18, -0.5, 0.5, { solid: false, look: 'dark' }));
  parts.push(P(tu - 6, tu - 5, top, top + 10, W * 0.15, W * 0.15 + 1, { solid: false, look: 'dark' }));
  parts.push(P(tu + 2, tu + 9, top, top + 3, -W * 0.18, -W * 0.08, { solid: false, look: 'trim' }));
  const nozzles: Nozzle[] = [];
  for (const w of [-W * 0.3, 0, W * 0.3]) { nozzles.push({ u: sE, v: (hv + Hh - 2) / 2, w, r: 5.5 }); nozzles.push({ u: sE, v: -(hv + Hh - 2) / 2, w, r: 5.5 }); }
  for (const s of [-1, 1]) nozzles.push({ u: sE, v: 0, w: s * (Wh + hs) / 2, r: 11 });
  const turrets: Hull['turrets'] = [];
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) turrets.push([lerp(-0.34, 0.12, i / 3) * L, Hh + H * 0.2, s * W * 0.31, 3.2]);
  for (const s of [-1, 1]) turrets.push([0.36 * L, Hh - 2, s * (W * 0.38), 4]);
  const beacons: Hull['beacons'] = [[tu, top + 18, 0], [0.5 * L - 2, -H * 0.12, -W * 0.36], [0.5 * L - 2, -H * 0.12, W * 0.36], [-0.32 * L, -H * 0.3, -Wh - 5], [-0.32 * L, -H * 0.3, Wh + 5]];
  const guides: Part[] = [];
  for (const u of [bow, sE]) {
    guides.push(P(u - 0.6, u + 0.6, hv - 1.2, hv - 0.2, -hs + 1, hs - 1), P(u - 0.6, u + 0.6, -hv + 0.2, -hv + 1.2, -hs + 1, hs - 1));
    guides.push(P(u - 0.6, u + 0.6, -hv + 1, hv - 1, -hs + 0.2, -hs + 1.2), P(u - 0.6, u + 0.6, -hv + 1, hv - 1, hs - 1.2, hs - 0.2));
  }
  // landing strips down the bay floor
  for (let u = sB + 8; u < bow - 8; u += 18) for (const w of [-hs + 3, hs - 4]) guides.push(P(u, u + 8, -hv, -hv + 0.4, w, w + 1));
  return { len: L, parts, nozzles, openings: [{ u: 0, v: 0, w: 0, along: 'u', hv, hs, kind: 'hangar' }], turrets, beacons, guides };
}

/** Cruiser: a long dagger hull with a tunnel straight across it, a trench between two dorsal ridges,
 *  a stepped tower at the stern and engine nacelles hung on pylons (with a slot to thread between). */
export function cruiser(L: number, h: (k: number) => number): Hull {
  const H = L * 0.12, W = L * 0.17, Hh = H / 2, Wh = W / 2;
  const t0 = L * (0.02 + h(1) * 0.1), a = 16, b = 13; // the tunnel across the hull: 32 m long, 26 m tall
  const sB = -0.42 * L;
  const parts: Part[] = [
    P(sB, t0 - a, -Hh, Hh, -Wh, Wh, { c: ch(5), win: 2 }),
    P(t0 + a, 0.18 * L, -Hh, Hh, -Wh, Wh, { c: ch(5), win: 2 }),
    P(t0 - a, t0 + a, b, Hh, -Wh, Wh, { c: [5, 5, 0, 0], look: 'deck' }),
    P(t0 - a, t0 + a, -Hh, -b, -Wh, Wh, { c: [0, 0, 5, 5], look: 'dark' }),
    // the long bow, sloping down and narrowing to a blade
    P(0.18 * L, 0.5 * L, -Hh, Hh, -Wh, Wh, { c: ch(5), tb: [0.26, 0.14, -H * 0.18] }),
    // keel blade
    P(-0.3 * L, 0.24 * L, -Hh - H * 0.38, -Hh, -3, 3, { ta: [0.5, 1, H * 0.1], tb: [0.2, 0.6, H * 0.15], look: 'dark' }),
  ];
  // the trench: two dorsal ridges running forward, sloping away into the bow
  const ridge = P(-0.4 * L, 0.3 * L, Hh, Hh + H * 0.32, -W * 0.47, -W * 0.2, { c: [3, 0, 0, 0], tb: [0.25, 0.7, -H * 0.12], look: 'armor', win: 1 });
  parts.push(ridge, mir(ridge));
  // stepped tower at the stern, bridge on top
  const tu = -0.35 * L;
  parts.push(P(tu - 0.07 * L, tu + 0.07 * L, Hh, Hh + H * 0.55, -W * 0.3, W * 0.3, { c: [3, 3, 0, 0], tb: [0.8, 0.75, -1], look: 'hull', win: 2 }));
  parts.push(P(tu - 0.05 * L, tu + 0.045 * L, Hh + H * 0.55, Hh + H * 0.95, -W * 0.16, W * 0.16, { c: [2, 2, 0, 0], tb: [0.85, 0.8, 0], look: 'deck' }));
  parts.push(P(tu - 0.055 * L, tu + 0.06 * L, Hh + H * 0.95, Hh + H * 1.12, -W * 0.34, W * 0.34, { c: ch(2), ta: [0.8, 0.9, 0], tb: [0.45, 0.75, -1], win: 1 }));
  const top = Hh + H * 1.12;
  parts.push(P(tu - 0.4, tu + 0.4, top, top + 16, -0.4, 0.4, { solid: false, look: 'dark' }));
  parts.push(P(tu + 4, tu + 5, top, top + 9, W * 0.2, W * 0.2 + 1, { solid: false, look: 'dark' }));
  // stern block with three big nozzles
  parts.push(P(-0.5 * L, sB, -H * 0.42, H * 0.42, -W * 0.44, W * 0.44, { c: ch(4), look: 'dark' }));
  // nacelles on pylons, stopping short of the tunnel so its mouths open onto clear space
  const gap = 15, nw = W * 0.24, nEnd = Math.min(t0 - a - 12, 0.12 * L);
  const nac = P(-0.46 * L, nEnd, -H * 0.36, H * 0.14, -(Wh + gap + nw), -(Wh + gap), { c: ch(4), ta: [0.85, 0.9, 0], tb: [0.45, 0.55, -H * 0.06], look: 'armor' });
  parts.push(nac, mir(nac));
  for (const u of [-0.38 * L, nEnd - 0.1 * L]) {
    const py = P(u, u + 0.05 * L, -H * 0.18, H * 0.02, -(Wh + gap), -Wh, { look: 'dark' });
    parts.push(py, mir(py));
  }
  const nozzles: Nozzle[] = [];
  for (const w of [-W * 0.24, 0, W * 0.24]) nozzles.push({ u: -0.5 * L, v: 0, w, r: H * 0.17 });
  for (const s of [-1, 1]) nozzles.push({ u: -0.46 * L, v: -H * 0.11, w: s * (Wh + gap + nw / 2), r: H * 0.13 });
  const turrets: Hull['turrets'] = [];
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) turrets.push([lerp(-0.2, 0.18, i / 2) * L, Hh + H * 0.32 * (1 - 0.6 * i / 2), s * W * 0.335, 2.8]);
  turrets.push([0.22 * L, Hh * 0.9, 0, 4.2]);
  const beacons: Hull['beacons'] = [[tu, top + 16, 0], [0.5 * L - 3, -Hh * 0.6, 0], [-0.46 * L, H * 0.1, -(Wh + gap + nw / 2)], [-0.46 * L, H * 0.1, Wh + gap + nw / 2]];
  const guides: Part[] = [];
  for (const u of [t0 - a, t0 + a]) {
    guides.push(P(u - 0.6, u + 0.6, b - 1.2, b - 0.2, -Wh + 2, Wh - 2), P(u - 0.6, u + 0.6, -b + 0.2, -b + 1.2, -Wh + 2, Wh - 2));
  }
  for (const w of [-Wh - 0.5, Wh - 0.5]) guides.push(P(t0 - a + 1, t0 + a - 1, b - 1.2, b - 0.2, w, w + 1), P(t0 - a + 1, t0 + a - 1, -b + 0.2, -b + 1.2, w, w + 1));
  return { len: L, parts, nozzles, openings: [{ u: t0, v: 0, w: 0, along: 'w', hv: b, hs: a, kind: 'hull' }], turrets, beacons, guides };
}

/** Frigate: a compact escort with an angled bow, a broad gun deck across its middle and a single tower. */
export function frigate(L: number): Hull {
  const H = L * 0.17, W = L * 0.22, Hh = H / 2, Wh = W / 2;
  const parts: Part[] = [
    P(-0.44 * L, 0.14 * L, -Hh, Hh, -Wh, Wh, { c: ch(3), win: 2 }),
    P(0.14 * L, 0.5 * L, -Hh, Hh, -Wh, Wh, { c: ch(3), tb: [0.38, 0.4, -H * 0.12] }),
    P(-0.16 * L, 0.08 * L, -H * 0.12, H * 0.16, -W * 0.95, W * 0.95, { c: ch(2), ta: [1, 0.85, 0], tb: [0.8, 0.7, 0], look: 'armor' }),
    P(-0.38 * L, -0.18 * L, Hh, Hh + H * 0.55, -W * 0.22, W * 0.22, { c: [2, 2, 0, 0], tb: [0.85, 0.8, 0], win: 1 }),
    P(-0.4 * L, -0.17 * L, Hh + H * 0.55, Hh + H * 0.72, -W * 0.36, W * 0.36, { c: ch(1.5), tb: [0.5, 0.8, -1], look: 'deck', win: 1 }),
    P(-0.5 * L, -0.44 * L, -H * 0.4, H * 0.4, -W * 0.4, W * 0.4, { c: ch(3), look: 'dark' }),
    P(-0.3 * L, 0.2 * L, -Hh - H * 0.25, -Hh, -W * 0.18, W * 0.18, { c: [0, 0, 2, 2], tb: [0.4, 0.5, 3], look: 'dark' }),
  ];
  const top = Hh + H * 0.72;
  parts.push(P(-0.29 * L - 0.3, -0.29 * L + 0.3, top, top + 12, -0.3, 0.3, { solid: false, look: 'dark' }));
  const nozzles: Nozzle[] = [{ u: -0.5 * L, v: 0, w: -W * 0.18, r: H * 0.22 }, { u: -0.5 * L, v: 0, w: W * 0.18, r: H * 0.22 }];
  const turrets: Hull['turrets'] = [[-0.04 * L, H * 0.16, -W * 0.78, 2.6], [-0.04 * L, H * 0.16, W * 0.78, 2.6], [0.06 * L, Hh, 0, 3.2]];
  const beacons: Hull['beacons'] = [[-0.29 * L, top + 12, 0], [-0.04 * L, H * 0.16, -W * 0.95], [-0.04 * L, H * 0.16, W * 0.95]];
  return { len: L, parts, nozzles, openings: [], turrets, beacons, guides: [] };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

/** The cross-section ring of a block at one end (points in (v, w), going round). */
export function ring(p: Part, end: 0 | 1): [number, number][] {
  const t = (end ? p.tb : p.ta) ?? [1, 1, 0];
  const c = p.c ?? [0, 0, 0, 0];
  const { v0, v1, w0, w1 } = p;
  const pts: [number, number][] = [];
  const corner = (cv: number, cw: number, k: number, a: [number, number], b: [number, number]) => {
    if (k > 0) { pts.push(a, b); } else pts.push([cv, cw]);
  };
  corner(v1, w0, c[0], [v1 - c[0], w0], [v1, w0 + c[0]]);
  corner(v1, w1, c[1], [v1, w1 - c[1]], [v1 - c[1], w1]);
  corner(v0, w1, c[2], [v0 + c[2], w1], [v0, w1 - c[2]]);
  corner(v0, w0, c[3], [v0, w0 + c[3]], [v0 + c[3], w0]);
  const vc = (v0 + v1) / 2, wc = (w0 + w1) / 2;
  return pts.map(([v, w]) => [vc + (v - vc) * t[0] + t[2], wc + (w - wc) * t[1]]);
}

// ---------- Looks ----------
export interface FleetLook { hull: number; dark: number; deck: number; armor: number; trim: number; light: number; engine: number; bolt: number; beacon: number }
export const FLEET_LOOK: FleetLook[] = [
  // the Concord: pale ceramic armour, cobalt trim, ice-blue engines
  { hull: 0xd2d6dc, dark: 0x7c8088, deck: 0xb0b4ba, armor: 0xa3abb8, trim: 0x2d63b0, light: 0xbfe6ff, engine: 0x7fdcff, bolt: 0x56c8ff, beacon: 0xffffff },
  // the Hegemony: gunmetal and rust-red, amber lights, orange engines
  { hull: 0x6a6d75, dark: 0x34363c, deck: 0x55575e, armor: 0x7d6b62, trim: 0xb3402a, light: 0xffc27a, engine: 0xff8a3a, bolt: 0xff4a2a, beacon: 0xff3020 },
];

/** Hull plating: big and small panels, seams, a few vents. Tiles every PANEL_M metres. */
const PANEL_M = 30;
let panelTex: THREE.Texture | null = null;
function panels() {
  if (panelTex) return panelTex;
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const cx = cv.getContext('2d')!;
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  cx.fillStyle = '#c8c8c8'; cx.fillRect(0, 0, S, S);
  // panels: recursive splits so they line up like real plating
  const split = (x: number, y: number, w: number, h: number, d: number) => {
    if (d > 3 || (d > 1 && r() < 0.3) || w < 48 || h < 40) {
      const l = 196 + Math.floor(r() * 40);
      cx.fillStyle = `rgb(${l},${l},${l})`; cx.fillRect(x + 1, y + 1, w - 2, h - 2);
      // a few panels get a vent grille or a darker access hatch
      if (r() < 0.12 && w > 40 && h > 30) { cx.fillStyle = 'rgba(40,40,40,.35)'; for (let k = 0; k < 5; k++) cx.fillRect(x + 6, y + 6 + k * 5, w - 12, 2); }
      else if (r() < 0.1) { cx.fillStyle = 'rgba(60,60,60,.25)'; cx.fillRect(x + w * 0.25, y + h * 0.25, w * 0.5, h * 0.5); }
      cx.fillStyle = 'rgba(0,0,0,.32)'; cx.fillRect(x, y, w, 1); cx.fillRect(x, y, 1, h);
      cx.fillStyle = 'rgba(255,255,255,.18)'; cx.fillRect(x + 1, y + h - 1, w - 1, 1); cx.fillRect(x + w - 1, y + 1, 1, h - 1);
      return;
    }
    if (w > h ? r() < 0.75 : r() < 0.25) { const k = Math.round(w * (0.3 + r() * 0.4) / 8) * 8; split(x, y, k, h, d + 1); split(x + k, y, w - k, h, d + 1); }
    else { const k = Math.round(h * (0.3 + r() * 0.4) / 8) * 8; split(x, y, w, k, d + 1); split(x, y + k, w, h - k, d + 1); }
  };
  split(0, 0, S, S, 0);
  // grime
  for (let i = 0; i < 260; i++) { cx.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.03})`; cx.fillRect(r() * S, r() * S, 2 + r() * 30, 1 + r() * 4); }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return (panelTex = t);
}
let hullMatC: THREE.Material | null = null;
export const hullMat = () => (hullMatC ??= new THREE.MeshStandardMaterial({ vertexColors: true, map: panels(), flatShading: true, metalness: 0.15, roughness: 0.78 }));
const glowMats = new Map<string, THREE.MeshBasicMaterial>();
/** Unlit glow (windows, nozzles), bright enough to bloom. */
export function glowMat(c: number, k = 2.2, additive = false) {
  const key = `${c}:${k}:${additive}`;
  let m = glowMats.get(key);
  if (!m) {
    const col = new THREE.Color(c).multiplyScalar(k);
    m = additive ? new THREE.MeshBasicMaterial({ color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false })
      : new THREE.MeshBasicMaterial({ color: col, fog: false, toneMapped: false });
    glowMats.set(key, m);
  }
  return m;
}

/** Collects triangles (ship frame) with flat normals, vertex colours and world-scale plating UVs. */
class Batch {
  pos: number[] = []; col: number[] = []; uv: number[] = [];
  /** vertical span of the ship, for the ambient-occlusion-ish darkening underneath */
  constructor(private vlo = -1, private vhi = 1) {}
  private c = new THREE.Color();
  tri(a: number[], b: number[], c: number[], col: THREE.Color, uva: number[], uvb: number[], uvc: number[]) {
    for (const [p, t] of [[a, uva], [b, uvb], [c, uvc]] as const) {
      this.pos.push(p[0], p[1], p[2]); this.uv.push(t[0], t[1]);
      const k = 0.55 + 0.45 * THREE.MathUtils.smoothstep(p[1], this.vlo, this.vhi);
      this.col.push(col.r * k, col.g * k, col.b * k);
    }
  }
  /** A convex quad a-b-c-d; flipped if needed so its face points away from `inside`. */
  quad(a: number[], b: number[], c: number[], d: number[], col: THREE.Color, inside: number[], uvs: number[][]) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = [(a[0] + c[0]) / 2 - inside[0], (a[1] + c[1]) / 2 - inside[1], (a[2] + c[2]) / 2 - inside[2]];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) { this.tri(a, c, b, col, uvs[0], uvs[2], uvs[1]); this.tri(a, d, c, col, uvs[0], uvs[3], uvs[2]); }
    else { this.tri(a, b, c, col, uvs[0], uvs[1], uvs[2]); this.tri(a, c, d, col, uvs[0], uvs[2], uvs[3]); }
  }
  /** A lofted, chamfered block. */
  loft(p: Part, color: number, shade = 0) {
    const col = this.c.set(color); if (shade) col.offsetHSL(0, 0, shade);
    const col2 = col.clone();
    const A = ring(p, 0), B = ring(p, 1), n = A.length;
    const wc = (p.w0 + p.w1) / 2;
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [p.u0, A[i][0], A[i][1]], b = [p.u0, A[j][0], A[j][1]], c = [p.u1, B[j][0], B[j][1]], d = [p.u1, B[i][0], B[i][1]];
      const el = Math.hypot(A[j][0] - A[i][0], A[j][1] - A[i][1]);
      if (el < 1e-3 && Math.hypot(B[j][0] - B[i][0], B[j][1] - B[i][1]) < 1e-3) continue;
      const t0 = per / PANEL_M, t1 = (per + el) / PANEL_M;
      quadAxis(this, a, b, c, d, col2, [p.u0, axisV(p, 0), wc], [p.u1, axisV(p, 1), wc], [[p.u0 / PANEL_M, t0], [p.u0 / PANEL_M, t1], [p.u1 / PANEL_M, t1], [p.u1 / PANEL_M, t0]]);
      per += el;
    }
    // end caps
    for (const [end, R] of [[0, A], [1, B]] as const) {
      const u = end ? p.u1 : p.u0;
      const cv = R.reduce((s, q) => s + q[0], 0) / n, cw = R.reduce((s, q) => s + q[1], 0) / n;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = [u, cv, cw], b = [u, R[i][0], R[i][1]], c = [u, R[j][0], R[j][1]];
        // facing out along -u at the stern end, +u at the bow end
        const flip = (end === 1) !== ((R[i][0] - cv) * (R[j][1] - cw) - (R[i][1] - cw) * (R[j][0] - cv) < 0);
        const uv = (q: number[]) => [q[2] / PANEL_M, q[1] / PANEL_M];
        if (flip) this.tri(a, c, b, col2, uv(a), uv(c), uv(b)); else this.tri(a, b, c, col2, uv(a), uv(b), uv(c));
      }
    }
  }
  /** Any geometry (non-indexed after this), placed by `m`, in one colour. */
  geom(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number, shade = 0) {
    const gg = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    const col = this.c.set(color); if (shade) col.offsetHSL(0, 0, shade);
    const p = gg.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      const a = [p.getX(i), p.getY(i), p.getZ(i)], b = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)], c = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
      this.tri(a, b, c, col, [a[0] / 4, a[2] / 4], [b[0] / 4, b[2] / 4], [c[0] / 4, c[2] / 4]);
    }
    gg.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
/** The block's centre line height at one end (it can drop as it tapers). */
const axisV = (p: Part, end: 0 | 1) => (p.v0 + p.v1) / 2 + ((end ? p.tb : p.ta)?.[2] ?? 0);
/** A side face of a loft: flipped to face away from the block's axis (the line between its end centres). */
function quadAxis(b: Batch, a: number[], bb: number[], c: number[], d: number[], col: THREE.Color, ax0: number[], ax1: number[], uvs: number[][]) {
  const mid = [(a[0] + c[0]) / 2, (a[1] + bb[1] + c[1] + d[1]) / 4, (a[2] + bb[2] + c[2] + d[2]) / 4];
  const k = THREE.MathUtils.clamp((mid[0] - ax0[0]) / ((ax1[0] - ax0[0]) || 1), 0, 1);
  b.quad(a, bb, c, d, col, [mid[0], lerp(ax0[1], ax1[1], k), lerp(ax0[2], ax1[2], k)], uvs);
}

const turretBase = new THREE.CylinderGeometry(1, 1.15, 0.6, 8).translate(0, 0.3, 0);
const turretHead = new THREE.BoxGeometry(1.5, 0.8, 1.3).translate(0, 0.95, 0);
const turretBarrel = new THREE.BoxGeometry(1.9, 0.18, 0.18).translate(1.6, 1.0, 0);
const nozzleRing = new THREE.CylinderGeometry(1.12, 1.3, 1, 12, 1, true).rotateZ(Math.PI / 2);
const nozzleBack = new THREE.CircleGeometry(1, 12).rotateY(-Math.PI / 2);

export interface ShipVisual { group: THREE.Group; beacons: THREE.Vector3[] }

/** Build one ship's meshes (in its own frame: +x = bow, +z = starboard). `tag` varies the greebles. */
export function buildShipMesh(hull: Hull, look: FleetLook, tag: number): ShipVisual {
  let vlo = Infinity, vhi = -Infinity;
  for (const p of hull.parts) { vlo = Math.min(vlo, p.v0); vhi = Math.max(vhi, p.v1); }
  const body = new Batch(vlo, vhi), lit = new Batch(-1e9, -1e9 + 1), glow = new Batch(-1e9, -1e9 + 1);
  const r = (k: number) => hash2(k, tag, 700);
  let rk = 0;
  const colorOf = (l: Look | undefined) => look[l ?? 'hull'];
  const m = new THREE.Matrix4();
  hull.parts.forEach((p, i) => {
    body.loft(p, colorOf(p.look), (r(i) - 0.5) * 0.05);
    if (p.solid === false) return;
    const flat = !p.ta && !p.tb, top = p.v1, len = p.u1 - p.u0, wid = p.w1 - p.w0, ht = p.v1 - p.v0;
    // greebles on the top deck: low slabs, vents, conduit runs
    const floor = hull.openings.some((o) => Math.abs(p.v1 - (o.v - o.hv)) < 0.01);
    if (flat && !floor) {
      const c = p.c ?? [0, 0, 0, 0];
      const n = Math.floor(len * wid / 650);
      for (let j = 0; j < n; j++) {
        const u = lerp(p.u0 + 4, p.u1 - 4, r(++rk)), w = lerp(p.w0 + 2 + c[0], p.w1 - 2 - c[1], r(++rk));
        const big = r(++rk);
        const su = 2 + big * 12, sw = 1.5 + r(++rk) * 6, sh = 0.4 + (big > 0.85 ? 1.8 : 0.5) * r(++rk);
        const g = P(Math.max(p.u0, u - su / 2), Math.min(p.u1, u + su / 2), top, top + sh, Math.max(p.w0 + c[0], w - sw / 2), Math.min(p.w1 - c[1], w + sw / 2));
        body.loft(g, big > 0.93 ? look.trim : big > 0.5 ? look.dark : colorOf(p.look), (r(++rk) - 0.5) * 0.08);
      }
      // conduits running the length of big decks
      if (len > 80 && wid > 30) for (const k of [0.3, 0.7]) {
        const w = lerp(p.w0, p.w1, k);
        body.loft(P(p.u0 + 6, p.u1 - 6, top, top + 0.8, w - 0.6, w + 0.6), look.dark);
      }
    }
    // a band of trim colour along the sides of the long blocks
    if (flat && len > 60 && ht > 14) {
      const v = lerp(p.v0, p.v1, 0.3), c = p.c ?? [0, 0, 0, 0];
      if (!c[3] || v > p.v0 + c[3]) body.loft(P(p.u0 + 3, p.u1 - 3, v, v + 2.2, p.w0 - 0.3, p.w0), look.trim);
      if (!c[2] || v > p.v0 + c[2]) body.loft(P(p.u0 + 3, p.u1 - 3, v, v + 2.2, p.w1, p.w1 + 0.3), look.trim);
    }
    // rows of lit windows down both sides
    if (p.win && len > 20) {
      const c = p.c ?? [0, 0, 0, 0];
      const lo = p.v0 + Math.max(c[2], c[3]) + 1.5, hi = p.v1 - Math.max(c[0], c[1]) - 1.5;
      for (let row = 0; row < p.win; row++) {
        const v = p.win === 1 ? (lo + hi) / 2 : lerp(lo + (hi - lo) * 0.25, hi - (hi - lo) * 0.1, row / (p.win - 1));
        // tapered blocks: keep to the first, square stretch
        const uEnd = flat ? p.u1 - 4 : p.u0 + len * 0.3;
        for (let u = p.u0 + 4; u < uEnd; u += 5 + r(++rk) * 9) {
          if (r(++rk) < 0.3) continue;
          const l = Math.min(1.5 + r(++rk) * 5, uEnd - u);
          lit.loft(P(u, u + l, v, v + 0.8, p.w0 - 0.15, p.w0), 0xffffff);
          lit.loft(P(u, u + l, v, v + 0.8, p.w1, p.w1 + 0.15), 0xffffff);
        }
      }
    }
  });
  // turrets: a squat base, a boxy head and twin barrels, trained a little differently each
  for (const [u, v, w, s] of hull.turrets) {
    const yaw = (r(++rk) - 0.5) * 1.6 + (w < 0 ? -0.3 : w > 0 ? 0.3 : 0);
    m.compose(new THREE.Vector3(u, v, w), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));
    body.geom(turretBase, m, look.dark);
    body.geom(turretHead, m, look.hull, -0.05);
    for (const z of [-0.3, 0.3]) body.geom(turretBarrel.clone().translate(0, 0, z), m, look.dark);
  }
  // engine nozzles: a dark bell, a glowing throat and a white-hot core
  const core = new Batch(-1e9, -1e9 + 1);
  for (const nz of hull.nozzles) {
    m.compose(new THREE.Vector3(nz.u - nz.r * 0.25, nz.v, nz.w), new THREE.Quaternion(), new THREE.Vector3(nz.r * 0.5, nz.r, nz.r));
    body.geom(nozzleRing, m, look.dark, -0.1);
    m.compose(new THREE.Vector3(nz.u - nz.r * 0.05, nz.v, nz.w), new THREE.Quaternion(), new THREE.Vector3(1, nz.r * 1.1, nz.r * 1.1));
    body.geom(nozzleBack, m, look.dark, -0.2);
    m.compose(new THREE.Vector3(nz.u - nz.r * 0.3, nz.v, nz.w), new THREE.Quaternion(), new THREE.Vector3(1, nz.r * 0.92, nz.r * 0.92));
    glow.geom(nozzleBack, m, 0xffffff);
    m.compose(new THREE.Vector3(nz.u - nz.r * 0.32, nz.v, nz.w), new THREE.Quaternion(), new THREE.Vector3(1, nz.r * 0.45, nz.r * 0.45));
    core.geom(nozzleBack, m, 0xffffff);
  }
  for (const g of hull.guides) lit.loft(g, 0xffffff);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(body.geometry(), hullMat()));
  const litMesh = new THREE.Mesh(lit.geometry(), glowMat(look.light, 1.35));
  const gm = new THREE.Mesh(glow.geometry(), glowMat(look.engine, 1.25));
  const cm = new THREE.Mesh(core.geometry(), glowMat(0xfff4e0, 1.8));
  cm.renderOrder = 1;
  group.add(litMesh, gm, cm);
  // exhaust plumes: soft cones of light trailing each nozzle
  for (const nz of hull.nozzles) {
    const plume = new THREE.Mesh(plumeGeo, plumeMat(look.engine));
    plume.scale.set(nz.r * 4.5, nz.r * 0.95, nz.r * 0.95);
    plume.position.set(nz.u - nz.r * 0.35, nz.v, nz.w);
    plume.renderOrder = 4;
    group.add(plume);
  }
  return { group, beacons: hull.beacons.map(([u, v, w]) => new THREE.Vector3(u, v, w)) };
}

/** Exhaust plume: a cone pointing back along -x, brightest at the nozzle. */
const plumeGeo = new THREE.CylinderGeometry(0.55, 1, 1, 14, 1, true).rotateZ(Math.PI / 2).translate(-0.5, 0, 0);
const plumes = new Map<number, THREE.ShaderMaterial>();
function plumeMat(c: number) {
  let m = plumes.get(c);
  if (!m) {
    m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { c: { value: new THREE.Color(c) }, t: { value: 0 } },
      vertexShader: 'varying float vX; varying vec3 vN; varying vec3 vV; void main(){ vX = -position.x; vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform vec3 c; uniform float t; varying float vX; varying vec3 vN; varying vec3 vV; void main(){ float edge = pow(abs(dot(vN, vV)), 1.5); float a = pow(1. - vX, 2.2) * edge * (.85 + .15 * sin(t * 40. + vX * 20.)); gl_FragColor = vec4(c * a * .9, a); }',
    });
    plumes.set(c, m);
  }
  return m;
}
/** Flicker every exhaust plume a little. */
export function animatePlumes(t: number) { for (const m of plumes.values()) m.uniforms.t.value = t; }
