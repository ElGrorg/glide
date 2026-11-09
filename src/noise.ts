// The world seed: every run rolls a new one, so terrain, trees, rocks, clouds and gates all change.
let worldSeed = (Math.random() * 2 ** 31) | 0;
const reseeders: (() => void)[] = [];
export function getWorldSeed() { return worldSeed; }
/** Time trials: a course pins the world seed (trees, rocks, noise) so everyone gets the same mountain. */
let lockedSeed: number | null = null;
export function lockWorldSeed(seed: number | null) { lockedSeed = seed; if (seed !== null) setWorldSeed(seed); }
export function setWorldSeed(seed: number) {
  worldSeed = (lockedSeed ?? seed) | 0;
  for (const r of reseeders) r();
}

// Compact 2D simplex noise with a permutation table seeded from `seed` mixed with the world seed.
export function makeNoise2D(seed = 1) {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  const shuffle = () => {
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = (seed ^ Math.imul(worldSeed, 2654435761)) >>> 0 || 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  };
  shuffle();
  reseeders.push(shuffle);
  const grad = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function noise(xin: number, yin: number): number {
    const s2 = (xin + yin) * F2;
    const i = Math.floor(xin + s2), j = Math.floor(yin + s2);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = grad[perm[ii + perm[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = grad[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = grad[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n; // roughly [-1, 1]
  };
}

// Deterministic hash of two integers to [0, 1) (for this run's world seed).
export function hash2(ix: number, iz: number, salt = 0): number {
  let h = (ix * 374761393 + iz * 668265263 + salt * 2147483647 + Math.imul(worldSeed, 1103515245)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
