import * as THREE from 'three';

// ---------- Imported ground: a heightmap grid or a 3D model ----------
// A course normally makes its own mountain out of its paths (course.ts). An imported map brings its own ground
// instead, as one of these. Everything that touches the ground (the bird, the camera, trees, gate posts) goes
// through Course.height / solidClearance / floorBelow, which hand over to the source when a course has one.

export interface TerrainBounds { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
export interface TerrainSource {
  kind: 'heightmap' | 'model';
  bounds: TerrainBounds;
  /** the open ground at (x, z): the top surface (over a tunnel, the rock above it) */
  height(x: number, z: number): number;
  /** metres of free air around a point, negative inside solid (only sources with overhangs have this) */
  clearance?(x: number, y: number, z: number): number;
  /** the ground under a point (a tunnel's floor when you're in one) */
  floor?(x: number, y: number, z: number): number;
  /** 0..1: how far under a roof (for darkening the fog in tunnels) */
  shade?(x: number, y: number, z: number): number;
  /** does the segment a -> b pass through a surface? (fast birds can't skip through thin walls) */
  crossed?(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** paint for a ground face (the colour map), or false to use the course's own palette */
  color?(x: number, z: number, ny: number, h: number, out: THREE.Color): boolean;
  /** false: the streamed heightfield ground isn't drawn (a model draws its own) */
  drawGround: boolean;
  /** the source's own meshes */
  scene?(): THREE.Object3D;
}

const { clamp, lerp } = THREE.MathUtils;

// ---------- Heightmap ----------
/** A grid of heights (metres), `nx` by `nz` samples, spanning `w` by `d` metres centred on the origin.
 *  Row 0 is the far edge (-z, the downhill direction of the game). Past the edges the ground rises into walls. */
export class HeightGrid implements TerrainSource {
  kind = 'heightmap' as const;
  drawGround = true;
  bounds: TerrainBounds;
  private cx: number; private cz: number;
  constructor(public h: Float32Array, public nx: number, public nz: number, public w: number, public d: number,
    private colors: Uint8Array | null = null, private cnx = 0, private cnz = 0) {
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < h.length; i++) { y0 = Math.min(y0, h[i]); y1 = Math.max(y1, h[i]); }
    this.bounds = { x0: -w / 2, x1: w / 2, z0: -d / 2, z1: d / 2, y0, y1 };
    this.cx = (nx - 1) / w; this.cz = (nz - 1) / d;
  }
  private raw(x: number, z: number) {
    const fx = clamp((x + this.w / 2) * this.cx, 0, this.nx - 1.0001), fz = clamp((z + this.d / 2) * this.cz, 0, this.nz - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, n = this.nx, h = this.h;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], e = h[(j + 1) * n + i + 1];
    return lerp(lerp(a, b, u), lerp(c, e, u), v);
  }
  height(x: number, z: number) {
    const b = this.bounds;
    const out = Math.max(0, b.x0 - x, x - b.x1, b.z0 - z, z - b.z1);
    // walls round the edge, so nobody flies off the map
    return this.raw(x, z) + (out > 0 ? Math.min(out * 1.6, 260) + out * 0.2 : 0);
  }
  color(x: number, z: number, _ny: number, _h: number, out: THREE.Color) {
    if (!this.colors) return false;
    const fx = clamp((x + this.w / 2) / this.w, 0, 0.9999) * this.cnx, fz = clamp((z + this.d / 2) / this.d, 0, 0.9999) * this.cnz;
    const k = (Math.floor(fz) * this.cnx + Math.floor(fx)) * 3, c = this.colors;
    out.setRGB(c[k] / 255, c[k + 1] / 255, c[k + 2] / 255, THREE.SRGBColorSpace);
    return true;
  }
}

// ---------- 3D model ----------
// The model's own triangles are the ground, tunnels and all. They're bucketed into a grid in plan view; the
// queries below only look at the triangles in the cells round a point.
const CELL = 8;
const FAR = 40; // clearance queries stop looking this far out
const TOP_RES = 4; // metres between cached top-surface samples

export class MeshTerrain implements TerrainSource {
  kind = 'model' as const;
  drawGround = false;
  bounds: TerrainBounds;
  tris: Float32Array; // 9 floats per triangle
  count: number;
  private gx0: number; private gz0: number; private gnx: number; private gnz: number;
  private start: Int32Array; private items: Int32Array;
  private stamp: Uint32Array; private tick = 1;
  private top: Float32Array; private tnx: number; private tnz: number;
  /** below this there's nothing (a bird that falls off the model hits it) */
  voidY: number;
  constructor(tris: Float32Array, private root: THREE.Object3D) {
    this.tris = tris; this.count = tris.length / 9;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]);
      y0 = Math.min(y0, tris[i + 1]); y1 = Math.max(y1, tris[i + 1]);
      z0 = Math.min(z0, tris[i + 2]); z1 = Math.max(z1, tris[i + 2]);
    }
    this.bounds = { x0, x1, z0, z1, y0, y1 };
    this.voidY = y0 - 30;
    this.gx0 = x0 - CELL; this.gz0 = z0 - CELL;
    this.gnx = Math.ceil((x1 - x0) / CELL) + 3; this.gnz = Math.ceil((z1 - z0) / CELL) + 3;
    // bucket the triangles (counting pass, then fill)
    const ncell = this.gnx * this.gnz;
    const counts = new Int32Array(ncell + 1);
    const each = (t: number, f: (c: number) => void) => {
      const o = t * 9;
      const ax = Math.min(tris[o], tris[o + 3], tris[o + 6]), bx = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const az = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), bz = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      const i0 = Math.floor((ax - this.gx0) / CELL), i1 = Math.floor((bx - this.gx0) / CELL);
      const j0 = Math.floor((az - this.gz0) / CELL), j1 = Math.floor((bz - this.gz0) / CELL);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * this.gnx + i);
    };
    for (let t = 0; t < this.count; t++) each(t, (c) => counts[c + 1]++);
    for (let c = 0; c < ncell; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.items = new Int32Array(counts[ncell]);
    const fill = counts.slice(0, ncell);
    for (let t = 0; t < this.count; t++) each(t, (c) => { this.items[fill[c]++] = t; });
    this.stamp = new Uint32Array(this.count);
    this.tnx = Math.ceil((x1 - x0) / TOP_RES) + 2; this.tnz = Math.ceil((z1 - z0) / TOP_RES) + 2;
    this.top = new Float32Array(this.tnx * this.tnz).fill(NaN);
  }
  scene() { return this.root; }

  private cell(i: number, j: number): [number, number] {
    if (i < 0 || j < 0 || i >= this.gnx || j >= this.gnz) return [0, 0];
    const c = j * this.gnx + i;
    return [this.start[c], this.start[c + 1]];
  }

  /** Heights where a vertical line through (x, z) meets the model, in any order. */
  private hits(x: number, z: number, out: number[]) {
    out.length = 0;
    const [a, b] = this.cell(Math.floor((x - this.gx0) / CELL), Math.floor((z - this.gz0) / CELL));
    const T = this.tris;
    for (let k = a; k < b; k++) {
      const o = this.items[k] * 9;
      const x0 = T[o], z0 = T[o + 2], x1 = T[o + 3], z1 = T[o + 5], x2 = T[o + 6], z2 = T[o + 8];
      const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(det) < 1e-9) continue; // a vertical face: a vertical line never crosses it
      const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
      const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      out.push(l0 * T[o + 1] + l1 * T[o + 4] + l2 * T[o + 7]);
    }
    return out;
  }
  private hitTmp: number[] = [];

  private topAt(i: number, j: number) {
    i = clamp(i, 0, this.tnx - 1); j = clamp(j, 0, this.tnz - 1);
    const k = j * this.tnx + i;
    let v = this.top[k];
    if (Number.isNaN(v)) {
      const hs = this.hits(this.bounds.x0 + i * TOP_RES, this.bounds.z0 + j * TOP_RES, this.hitTmp);
      v = this.voidY;
      for (const y of hs) v = Math.max(v, y);
      this.top[k] = v;
    }
    return v;
  }
  /** The top surface (cached on a 4 m grid; the void beyond the model). */
  height(x: number, z: number) {
    const fx = (x - this.bounds.x0) / TOP_RES, fz = (z - this.bounds.z0) / TOP_RES;
    if (fx < -1 || fz < -1 || fx > this.tnx || fz > this.tnz) return this.voidY;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = this.topAt(i, j), b = this.topAt(i + 1, j), c = this.topAt(i, j + 1), d = this.topAt(i + 1, j + 1);
    // where the samples straddle a drop (the lip of a cliff or a hole), take the higher one, not a ramp
    const hi = Math.max(a, b, c, d), lo = Math.min(a, b, c, d);
    if (hi - lo > 12) return hi;
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  floor(x: number, y: number, z: number) {
    let best = this.voidY;
    for (const h of this.hits(x, z, this.hitTmp)) if (h <= y + 0.3 && h > best) best = h;
    return best;
  }
  /** Inside the solid? An upward line from a point inside rock crosses the surface an odd number of times
   *  (once out through the top); from a tunnel or the open air, an even number. */
  private inside(x: number, y: number, z: number) {
    let n = 0;
    const hs = this.hits(x, z, this.hitTmp);
    for (let i = 0; i < hs.length; i++) {
      if (hs[i] <= y) continue;
      // two faces meeting at an edge both report the same crossing: count it once
      let dup = false;
      for (let k = 0; k < i; k++) if (hs[k] > y && Math.abs(hs[k] - hs[i]) < 1e-3) { dup = true; break; }
      if (!dup) n++;
    }
    return (n & 1) === 1;
  }
  shade(x: number, y: number, z: number) {
    let roof = Infinity;
    for (const h of this.hits(x, z, this.hitTmp)) if (h > y + 1 && h < roof) roof = h;
    return roof === Infinity ? 0 : THREE.MathUtils.smoothstep(roof - y, 4, 30);
  }
  clearance(x: number, y: number, z: number) {
    const T = this.tris, st = this.stamp;
    if (++this.tick === 0xffffffff) { st.fill(0); this.tick = 1; }
    const tick = this.tick;
    const ci = Math.floor((x - this.gx0) / CELL), cj = Math.floor((z - this.gz0) / CELL);
    let best = FAR * FAR;
    const R = Math.ceil(FAR / CELL);
    // grow square rings of cells; stop once the ring is further away than the best hit
    for (let r = 0; r <= R; r++) {
      const ringD = Math.max(0, (r - 1) * CELL);
      if (ringD * ringD > best) break;
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (r > 0 && i !== ci - r && i !== ci + r && j !== cj - r && j !== cj + r) continue;
        const [a, b] = this.cell(i, j);
        for (let k = a; k < b; k++) {
          const t = this.items[k];
          if (st[t] === tick) continue;
          st[t] = tick;
          const d = pointTri2(x, y, z, T, t * 9);
          if (d < best) best = d;
        }
      }
    }
    const d = Math.sqrt(best);
    return this.inside(x, y, z) ? -d : d;
  }
  crossed(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const T = this.tris, st = this.stamp;
    if (++this.tick === 0xffffffff) { st.fill(0); this.tick = 1; }
    const tick = this.tick;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const i0 = Math.floor((Math.min(ax, bx) - this.gx0) / CELL), i1 = Math.floor((Math.max(ax, bx) - this.gx0) / CELL);
    const j0 = Math.floor((Math.min(az, bz) - this.gz0) / CELL), j1 = Math.floor((Math.max(az, bz) - this.gz0) / CELL);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const [a, b] = this.cell(i, j);
      for (let k = a; k < b; k++) {
        const t = this.items[k];
        if (st[t] === tick) continue;
        st[t] = tick;
        const f = segTri(ax, ay, az, dx, dy, dz, T, t * 9);
        if (f >= 0 && f <= 1) return true;
      }
    }
    return false;
  }
}

/** Squared distance from a point to triangle `o` (Ericson's closest-point-on-triangle). */
function pointTri2(px: number, py: number, pz: number, T: Float32Array, o: number) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  const sq = () => (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; return sq(); }
  const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { qx = T[o + 3]; qy = T[o + 4]; qz = T[o + 5]; return sq(); }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; return sq(); }
  const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { qx = T[o + 6]; qy = T[o + 7]; qz = T[o + 8]; return sq(); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; return sq(); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    qx = T[o + 3] + (T[o + 6] - T[o + 3]) * w; qy = T[o + 4] + (T[o + 7] - T[o + 4]) * w; qz = T[o + 5] + (T[o + 8] - T[o + 5]) * w; return sq();
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
  return sq();
}

/** Where along a -> a + d the segment meets triangle `o` (Moller-Trumbore), or -1. */
function segTri(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, T: Float32Array, o: number) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ax - T[o], ty = ay - T[o + 1], tz = az - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Every triangle of a loaded model in world space (9 floats each), and a copy made to look at home in the game:
 *  flat-shaded, lit, double-sided (you see tunnel walls from the inside), fogged. */
export function modelTriangles(root: THREE.Object3D, maxTris = 400_000): Float32Array {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (!pos) return;
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(m.matrixWorld);
        out.push(v.x, v.y, v.z);
      }
      if (out.length / 9 > maxTris) throw new Error(`That model has more than ${maxTris.toLocaleString()} triangles. Try decimating it in Blender first.`);
    }
  });
  if (!out.length) throw new Error('No triangles found in that model.');
  return Float32Array.from(out);
}
