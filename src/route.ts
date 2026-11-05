import * as THREE from 'three';
import { hash2 } from './noise';

// ---------- The route: a chain of forks down the endless slope ----------
// Every fork splits the run into 2-3 valleys separated by ridges. Each valley has its
// own environment. Fly far enough down one and it becomes the main run; the others
// close up behind ridges, and a new fork appears further down.

export type Biome = 'meadow' | 'autumn' | 'desert' | 'alpine' | 'misty';
export const BIOMES: Biome[] = ['meadow', 'autumn', 'desert', 'alpine', 'misty'];
export const BIOME_NAME: Record<Biome, string> = {
  meadow: 'Green meadows', autumn: 'Autumn forest', desert: 'Red desert', alpine: 'Snowy peaks', misty: 'Misty valley',
};

export interface Branch { off: number; biome: Biome; canyon: boolean }
export interface Fork {
  index: number;
  zStart: number;     // where the valleys start to split
  commitZ: number;    // pass this and the valley you're in becomes the main run
  baseOff: number;    // lateral offset inherited from earlier choices
  parent: Biome;
  branches: Branch[];
  chosen: number | null;
  announced: boolean;
}

export const SPLIT = 360;        // metres for the valleys to spread apart
const COMMIT_AFTER = 470;        // fork start -> decision point
const CLOSE_START = 820;         // decision -> unchosen valleys start closing
const CLOSE_END = 1100;          // ...and are gone (also where the next fork starts)
const FIRST_FORK = -1000;

/** Meandering centreline that every valley follows (plus its own offset). */
export function meander(z: number): number {
  return 260 * Math.sin(z * 0.0011) + 110 * Math.sin(z * 0.0029 + 1.3);
}

export interface LiveBranch { c: number; open: number; biome: Biome; parent: Biome; t: number; canyon: number; index: number }

export class Route {
  forks: Fork[] = [];
  private seed = 0;

  reset(seed = Math.floor(Math.random() * 1e6)) {
    this.seed = seed;
    this.forks = [];
    this.forks.push(this.makeFork(0, FIRST_FORK, 0, 'meadow'));
  }

  private makeFork(index: number, zStart: number, baseOff: number, parent: Biome): Fork {
    const h = (salt: number) => hash2(index, this.seed, salt);
    const count = index === 0 ? 2 : h(1) < 0.55 ? 3 : 2;
    const offs = count === 3 ? [-330, 0, 330] : [-200, 200];
    // pick distinct environments, avoiding repeating the one you're leaving where possible
    const pool = BIOMES.filter((b) => b !== parent);
    const branches: Branch[] = [];
    for (let i = 0; i < count; i++) {
      const pick = pool.splice(Math.floor(h(10 + i) * pool.length), 1)[0] ?? parent;
      const canyon = pick === 'desert' || h(20 + i) < 0.25;
      branches.push({ off: offs[i], biome: pick, canyon });
    }
    return { index, zStart, commitZ: zStart - COMMIT_AFTER, baseOff, parent, branches, chosen: null, announced: false };
  }

  /** The fork whose region contains z (null on the opening stretch). */
  forkAt(z: number): Fork | null {
    let f: Fork | null = null;
    for (const k of this.forks) { if (k.zStart >= z) f = k; else break; }
    return f;
  }

  /** Valleys alive at depth z, left to right. */
  live(z: number, out: LiveBranch[] = []): LiveBranch[] {
    out.length = 0;
    const m = meander(z);
    const f = this.forkAt(z);
    if (!f) { out.push({ c: m, open: 1, biome: 'meadow', parent: 'meadow', t: 1, canyon: 0, index: 0 }); return out; }
    const ramp = THREE.MathUtils.smoothstep(f.zStart - z, 0, SPLIT);
    f.branches.forEach((b, i) => {
      let open = 1;
      if (f.chosen !== null && i !== f.chosen) open = 1 - THREE.MathUtils.smoothstep(f.commitZ - z, CLOSE_START, CLOSE_END);
      if (open <= 0.001) return;
      const canyon = b.canyon
        ? THREE.MathUtils.smoothstep(f.zStart - z, SPLIT * 0.55, SPLIT) * (1 - THREE.MathUtils.smoothstep(f.commitZ - z, 650, 800))
        : 0;
      out.push({ c: m + f.baseOff + b.off * ramp, open, biome: b.biome, parent: f.parent, t: ramp, canyon, index: i });
    });
    return out;
  }

  /** Centre of the valley you'd be flying down if you stayed in the middle (the first choice, or the chosen one). */
  mainCenter(z: number): number {
    const f = this.forkAt(z);
    if (!f) return meander(z);
    const ramp = THREE.MathUtils.smoothstep(f.zStart - z, 0, SPLIT);
    const b = f.branches[f.chosen ?? Math.floor(f.branches.length / 2)];
    return meander(z) + f.baseOff + b.off * ramp;
  }

  /** Call each frame. Returns a fork that needs announcing, or the branch just committed to. */
  update(x: number, z: number): { announce?: Fork; committed?: Branch } {
    const f = this.forks[this.forks.length - 1];
    if (!f.announced && z < f.zStart + 280) { f.announced = true; return { announce: f }; }
    if (f.chosen === null && z < f.commitZ) {
      const lv = this.live(z);
      let best = lv[0];
      for (const b of lv) if (Math.abs(x - b.c) < Math.abs(x - best.c)) best = b;
      f.chosen = best.index;
      const b = f.branches[f.chosen];
      this.forks.push(this.makeFork(f.index + 1, f.commitZ - CLOSE_END, f.baseOff + b.off, b.biome));
      return { committed: b };
    }
    return {};
  }
}

export const route = new Route();
route.reset(1);
