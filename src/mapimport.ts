import * as THREE from 'three';
import type { CourseDef, CourseLook, Gate, ObjectDef, PathDef, CtrlPt } from './course';
import type { Biome } from './route';
import { HeightGrid, MeshTerrain, modelTriangles, type TerrainSource } from './terrain';
import { mapGroundColor } from './world';

// ---------- Importing maps people make themselves ----------
// Three ways in (see MAPS.md):
//   a heightmap: a greyscale image (PNG, 8 or 16 bits; JPG; WebP) or a 16-bit RAW (.r16 / .raw) from terrain tools
//     such as Gaea, World Machine, World Creator, Unity / Unreal terrain exports, or a real-world elevation export
//   a 3D model: glTF / GLB or OBJ (+ MTL) from Blender or any track builder that exports them. The model itself is
//     the ground, so tunnels, arches and overhangs all work. Empties named START, FINISH, SPLIT1.., SPAWN,
//     TREE, ROCK, PILLAR place the timing lines and the obstacles.
//   a Glide map (.json): everything spelled out, pointing at the heightmap or model by file name.
// The files and the settings are kept on this device (IndexedDB) and rebuilt into a course when the game starts.

export const BIOMES: Biome[] = ['meadow', 'autumn', 'desert', 'alpine', 'misty'];
/** [x, y, z, halfWidth?, halfHeight?, heading in degrees? (0 = towards -z)] or the same as an object. */
export type GateSpec = number[] | { x: number; y: number; z: number; w?: number; h?: number; heading?: number };
export interface MapSpec {
  glide: 1;
  name: string; blurb?: string; biome?: Biome;
  terrain:
    | { heightmap: string; size?: number | [number, number]; height?: number | [number, number]; colormap?: string }
    | { model: string; scale?: number; rotate?: number };
  /** where the bird appears; defaults to a short way back from the start line */
  spawn?: [number, number, number]; heading?: number;
  /** start line, splits..., finish line. Leave it out and the map runs from its highest point to its lowest. */
  gates?: GateSpec[];
  sections?: string[];
  /** tunnels bored through a heightmap: control points [x, z, floorY, halfWidth, height] */
  tunnels?: { pts: CtrlPt[] }[];
  objects?: ObjectDef[];
  look?: Partial<CourseLook>;
}
export interface MapFile { name: string; data: ArrayBuffer }
export interface StoredMap { id: string; spec: MapSpec; files: MapFile[]; at: number }

export const LIMITS = { fileMB: 40, totalMB: 80, heightSamples: 2049, mapSide: 16000, tris: 400_000, objects: 5000, gates: 40, maps: 30 };

const ext = (n: string) => (n.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
export const RAW_EXT = ['r16', 'raw'];
export const MODEL_EXT = ['glb', 'gltf', 'obj'];
export const ACCEPT = [...IMAGE_EXT, ...RAW_EXT, ...MODEL_EXT, 'json', 'mtl', 'bin'].map((e) => `.${e}`).join(',');

const findFile = (files: MapFile[], name: string) => {
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  return files.find((f) => f.name.toLowerCase() === base) ?? files.find((f) => f.name.toLowerCase().endsWith(base));
};

/** A first guess at the settings for the files someone picked (they can change them before importing). */
export function guessSpec(files: MapFile[]): MapSpec {
  const json = files.find((f) => ext(f.name) === 'json');
  if (json) {
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(json.data)); } catch (e) { throw new Error(`${json.name} isn't valid JSON (${(e as Error).message}).`); }
    return checkSpec(raw);
  }
  const model = files.find((f) => MODEL_EXT.includes(ext(f.name)));
  const title = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
  if (model) return { glide: 1, name: title(model.name), biome: 'alpine', terrain: { model: model.name, scale: 1, rotate: 0 } };
  const imgs = files.filter((f) => IMAGE_EXT.includes(ext(f.name)) || RAW_EXT.includes(ext(f.name)));
  if (!imgs.length) throw new Error('Pick a heightmap image (PNG, JPG, RAW), a 3D model (GLB, glTF, OBJ) or a Glide map (.json).');
  // two images: the one called "color"/"albedo"/"satellite"/"texture" is the colour map
  const isColor = (n: string) => /colou?r|albedo|diffuse|satellite|texture|splat/i.test(n);
  const hm = imgs.find((f) => !isColor(f.name)) ?? imgs[0];
  const cm = imgs.find((f) => f !== hm && isColor(f.name));
  return { glide: 1, name: title(hm.name), biome: 'alpine', terrain: { heightmap: hm.name, size: 3000, height: [0, 700], ...(cm ? { colormap: cm.name } : {}) } };
}

/** Check a map file's shape (it came from anyone) and clamp it to the limits. */
export function checkSpec(raw: unknown): MapSpec {
  const o = raw as Record<string, any>;
  if (!o || typeof o !== 'object') throw new Error('A Glide map is a JSON object.');
  const t = o.terrain;
  if (!t || (typeof t.heightmap !== 'string' && typeof t.model !== 'string')) throw new Error('The map needs "terrain": { "heightmap": "file.png" } or { "model": "file.glb" }.');
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const spec: MapSpec = {
    glide: 1,
    name: String(o.name ?? 'My map').slice(0, 40),
    blurb: o.blurb ? String(o.blurb).slice(0, 140) : undefined,
    biome: BIOMES.includes(o.biome) ? o.biome : 'alpine',
    terrain: typeof t.model === 'string'
      ? { model: t.model, scale: num(t.scale, 0.001, 1000, 1), rotate: num(t.rotate, -360, 360, 0) }
      : { heightmap: t.heightmap, size: Array.isArray(t.size) ? [num(t.size[0], 50, LIMITS.mapSide, 3000), num(t.size[1], 50, LIMITS.mapSide, 3000)] : num(t.size, 50, LIMITS.mapSide, 3000),
        height: Array.isArray(t.height) ? [num(t.height[0], -5000, 9000, 0), num(t.height[1], -5000, 9000, 700)] : num(t.height, 1, 9000, 700),
        ...(typeof t.colormap === 'string' ? { colormap: t.colormap } : {}) },
  };
  const vec = (v: unknown) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n));
  if (vec(o.spawn)) spec.spawn = [o.spawn[0], o.spawn[1], o.spawn[2]];
  if (typeof o.heading === 'number') spec.heading = o.heading;
  if (Array.isArray(o.gates)) {
    spec.gates = o.gates.slice(0, LIMITS.gates).filter((g: any) => vec(g) || (g && typeof g.x === 'number' && typeof g.y === 'number' && typeof g.z === 'number'));
    if (spec.gates!.length < 2) throw new Error('"gates" needs at least a start and a finish.');
  }
  if (Array.isArray(o.sections)) spec.sections = o.sections.slice(0, LIMITS.gates).map((s: unknown) => String(s).slice(0, 24));
  if (Array.isArray(o.tunnels)) spec.tunnels = o.tunnels.slice(0, 40).filter((tn: any) => Array.isArray(tn?.pts) && tn.pts.length >= 2 && tn.pts.every((p: unknown) => Array.isArray(p) && p.length >= 4))
    .map((tn: any) => ({ pts: tn.pts.slice(0, 200).map((p: number[]) => [p[0], p[1], p[2], num(p[3], 4, 200, 20), num(p[4], 4, 200, 18)] as CtrlPt) }));
  if (Array.isArray(o.objects)) spec.objects = o.objects.slice(0, LIMITS.objects)
    .filter((b: any) => b && ['tree', 'rock', 'spire'].includes(b.type) && typeof b.x === 'number' && typeof b.z === 'number')
    .map((b: any) => ({ type: b.type, x: b.x, z: b.z, ...(typeof b.y === 'number' ? { y: b.y } : {}), ...(typeof b.r === 'number' ? { r: num(b.r, 0.3, 60, 4) } : {}), ...(typeof b.h === 'number' ? { h: num(b.h, 1, 400, 40) } : {}) }));
  if (o.look && typeof o.look === 'object') {
    const l = o.look, look: Partial<CourseLook> = {};
    for (const k of ['trees', 'rocks', 'clouds', 'spires', 'tall'] as const) if (typeof l[k] === 'number') look[k] = num(l[k], 0, 3, 1);
    if (typeof l.lowClouds === 'boolean') look.lowClouds = l.lowClouds;
    spec.look = look;
  }
  return spec;
}

// ---------- Heightmaps ----------
interface Gray { w: number; h: number; v: Float32Array /* 0..1 */; bits: number; rgb?: Uint8Array }

/** Decode a PNG ourselves (the browser's canvas squashes 16-bit greys to 8 bits, and terrain wants all 16). */
async function decodePng(buf: ArrayBuffer): Promise<Gray | null> {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  if (d.getUint32(0) !== 0x89504e47) return null;
  let p = 8, w = 0, h = 0, depth = 8, ct = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  while (p < u8.length) {
    const len = d.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    const body = u8.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.getUint32(p + 8); h = d.getUint32(p + 12); depth = body[8]; ct = body[9]; interlace = body[12]; }
    else if (type === 'PLTE') palette = body.slice();
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace || !w || !h || typeof DecompressionStream === 'undefined' || depth < 8 && ct !== 3) return null;
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ct];
  if (!chans) return null;
  const bpp = Math.max(1, (chans * depth) >> 3), stride = Math.ceil((w * chans * depth) / 8);
  const raw = new Uint8Array(await new Response(new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (raw.length < (stride + 1) * h) return null;
  const img = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = img.subarray(y * stride, (y + 1) * stride), up = y ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = v;
    }
  }
  const v = new Float32Array(w * h);
  const rgb = ct === 2 || ct === 6 || ct === 3 ? new Uint8Array(w * h * 3) : undefined;
  const max = depth === 16 ? 65535 : 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride;
    const s = (c: number) => depth === 16 ? (img[o + (x * chans + c) * 2] << 8) | img[o + (x * chans + c) * 2 + 1]
      : depth === 8 ? img[o + x * chans + c]
      : (img[o + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
    let g: number;
    if (ct === 3) {
      const i = s(0) * 3, pr = palette?.[i] ?? 0, pg = palette?.[i + 1] ?? 0, pbv = palette?.[i + 2] ?? 0;
      rgb![(y * w + x) * 3] = pr; rgb![(y * w + x) * 3 + 1] = pg; rgb![(y * w + x) * 3 + 2] = pbv;
      g = (pr * 0.299 + pg * 0.587 + pbv * 0.114) / 255;
    } else if (chans >= 3) {
      const r = s(0), gg = s(1), b = s(2);
      const k = (y * w + x) * 3, sh = depth === 16 ? 8 : 0;
      rgb![k] = r >> sh; rgb![k + 1] = gg >> sh; rgb![k + 2] = b >> sh;
      g = (r * 0.299 + gg * 0.587 + b * 0.114) / max;
    } else g = s(0) / max;
    v[y * w + x] = g;
  }
  return { w, h, v, bits: ct === 3 ? 8 : depth, rgb };
}

/** Any image the browser can open, through a canvas (8 bits a channel). */
async function decodeImage(buf: ArrayBuffer, name: string): Promise<Gray> {
  const type = ext(name) === 'jpg' ? 'image/jpeg' : `image/${ext(name)}`;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([buf], { type })); } catch { throw new Error(`Couldn't open ${name} as an image.`); }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const v = new Float32Array(c.width * c.height), rgb = new Uint8Array(c.width * c.height * 3);
  for (let i = 0; i < v.length; i++) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
    rgb[i * 3] = r; rgb[i * 3 + 1] = gg; rgb[i * 3 + 2] = b;
    v[i] = (r * 0.299 + gg * 0.587 + b * 0.114) / 255;
  }
  return { w: c.width, h: c.height, v, bits: 8, rgb };
}

/** A square 16-bit little-endian RAW (Unity / Unreal / World Machine / Gaea .r16), or an 8-bit one. */
function decodeRaw(buf: ArrayBuffer, name: string): Gray {
  const n16 = Math.round(Math.sqrt(buf.byteLength / 2)), n8 = Math.round(Math.sqrt(buf.byteLength));
  if (n16 * n16 * 2 === buf.byteLength) {
    const d = new DataView(buf), v = new Float32Array(n16 * n16);
    for (let i = 0; i < v.length; i++) v[i] = d.getUint16(i * 2, true) / 65535;
    return { w: n16, h: n16, v, bits: 16 };
  }
  if (n8 * n8 === buf.byteLength) {
    const u = new Uint8Array(buf), v = new Float32Array(n8 * n8);
    for (let i = 0; i < v.length; i++) v[i] = u[i] / 255;
    return { w: n8, h: n8, v, bits: 8 };
  }
  throw new Error(`${name}: a RAW heightmap has to be square (like 1025 x 1025, 16-bit). Export it as PNG if it isn't.`);
}

async function readGray(f: MapFile): Promise<Gray> {
  const e = ext(f.name);
  if (RAW_EXT.includes(e)) return decodeRaw(f.data, f.name);
  if (e === 'png') { const g = await decodePng(f.data).catch(() => null); if (g) return g; }
  return decodeImage(f.data, f.name);
}

/** Shrink a grid that's finer than the game can use (the ground is drawn at 4 m anyway). */
function shrink(g: Gray, max: number): Gray {
  if (g.w <= max && g.h <= max) return g;
  const k = Math.ceil(Math.max(g.w, g.h) / max);
  const w = Math.ceil(g.w / k), h = Math.ceil(g.h / k), v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const sx = x * k + i, sy = y * k + j;
      if (sx < g.w && sy < g.h) { s += g.v[sy * g.w + sx]; n++; }
    }
    v[y * w + x] = s / n;
  }
  return { w, h, v, bits: g.bits };
}
/** 8-bit greys come in 256 steps, which make terraces at game scale: soften them. */
function soften(v: Float32Array, w: number, h: number, passes: number) {
  const t = new Float32Array(v.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = x + i, yy = y + j;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += v[yy * w + xx]; n++; }
      }
      t[y * w + x] = s / n;
    }
    v.set(t);
  }
}

async function heightmapTerrain(spec: MapSpec, files: MapFile[]): Promise<HeightGrid> {
  const t = spec.terrain as Extract<MapSpec['terrain'], { heightmap: string }>;
  const f = findFile(files, t.heightmap);
  if (!f) throw new Error(`The map uses ${t.heightmap}, but that file wasn't picked.`);
  const g = shrink(await readGray(f), LIMITS.heightSamples);
  if (g.w < 8 || g.h < 8) throw new Error(`${f.name} is too small to be a heightmap.`);
  const [lo, hi] = Array.isArray(t.height) ? t.height : [0, t.height ?? 700];
  const size = t.size ?? 3000;
  const [w, d] = Array.isArray(size) ? size : [size, size * (g.h - 1) / (g.w - 1)];
  const hs = new Float32Array(g.v.length);
  if (g.bits <= 8) soften(g.v, g.w, g.h, 2);
  for (let i = 0; i < hs.length; i++) hs[i] = lo + g.v[i] * (hi - lo);
  let colors: Uint8Array | null = null, cw = 0, ch = 0;
  if (t.colormap) {
    const cf = findFile(files, t.colormap);
    if (!cf) throw new Error(`The map uses ${t.colormap} for its colours, but that file wasn't picked.`);
    const c = await readGray(cf);
    if (c.rgb) { colors = c.rgb; cw = c.w; ch = c.h; }
  }
  return new HeightGrid(hs, g.w, g.h, Math.min(w, LIMITS.mapSide), Math.min(d, LIMITS.mapSide), colors, cw, ch);
}

// ---------- Models ----------
interface Marker { kind: 'spawn' | 'start' | 'split' | 'finish' | 'tree' | 'rock' | 'spire'; order: number; pos: THREE.Vector3; scale: THREE.Vector3; dir: THREE.Vector3; node: THREE.Object3D }
/** What a node's name (or its glTF extras: { "glide": "start" }) says it is. Blender adds ".001" to copies. */
function markerKind(o: THREE.Object3D): { kind: Marker['kind']; order: number } | null {
  const tag = String((o.userData && (o.userData.glide ?? o.userData.Glide)) ?? o.name ?? '').toLowerCase().replace(/\.\d+$/, '').trim();
  const m = tag.match(/^(spawn|start|finish|goal|split|checkpoint|cp|tree|rock|boulder|spire|pillar)[\s_-]*(\d*)/);
  if (!m) return null;
  const k = m[1], order = m[2] ? Number(m[2]) : 0;
  const kind = k === 'goal' ? 'finish' : k === 'checkpoint' || k === 'cp' ? 'split' : k === 'boulder' ? 'rock' : k === 'pillar' ? 'spire' : k as Marker['kind'];
  return { kind, order };
}

async function loadModel(spec: MapSpec, files: MapFile[]): Promise<{ root: THREE.Object3D; markers: Marker[] }> {
  const t = spec.terrain as Extract<MapSpec['terrain'], { model: string }>;
  const f = findFile(files, t.model);
  if (!f) throw new Error(`The map uses ${t.model}, but that file wasn't picked.`);
  const e = ext(f.name);
  // other files (textures, .bin buffers, .mtl) are found by name among the ones picked
  const urls = new Map<string, string>();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split(/[\\/]/).pop()!.split('?')[0]);
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const hit = findFile(files, name);
    if (!hit) return 'data:,';
    if (!urls.has(hit.name)) urls.set(hit.name, URL.createObjectURL(new Blob([hit.data])));
    return urls.get(hit.name)!;
  });
  let root: THREE.Object3D;
  try {
    if (e === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader(manager);
      const text = new TextDecoder().decode(f.data);
      const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      const mtl = mtlName ? findFile(files, mtlName) : files.find((x) => ext(x.name) === 'mtl');
      if (mtl) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const mats = new MTLLoader(manager).parse(new TextDecoder().decode(mtl.data), '');
        mats.preload();
        loader.setMaterials(mats);
      }
      root = loader.parse(text);
    } else {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader(manager).parseAsync(f.data, '');
      root = gltf.scene;
    }
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (/draco|meshopt|KHR_draco|EXT_meshopt/i.test(msg)) throw new Error('That model is compressed (Draco / meshopt). Export it again from Blender with compression off.');
    throw new Error(`Couldn't read ${f.name}: ${msg}`);
  }
  const wrap = new THREE.Group();
  wrap.add(root);
  wrap.scale.setScalar(t.scale ?? 1);
  wrap.rotation.y = THREE.MathUtils.degToRad(t.rotate ?? 0);
  wrap.updateMatrixWorld(true);
  // markers: read them, then take them out of the model (they're not ground)
  const markers: Marker[] = [];
  const drop: THREE.Object3D[] = [];
  wrap.traverse((o) => {
    if (o === wrap || o === root) return;
    const k = markerKind(o);
    if (!k) return;
    const m = o as THREE.Mesh;
    // a real tree or rock model stays a model; only empties (and marker meshes for gates) are markers
    if (m.isMesh && ['tree', 'rock', 'spire'].includes(k.kind)) return;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    o.matrixWorld.decompose(pos, q, s);
    // a marker drawn as a little mesh (OBJ has no empties): its middle is where it is
    if (m.isMesh) new THREE.Box3().setFromObject(o).getCenter(pos);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0);
    markers.push({ ...k, pos, scale: s, dir: dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1), node: o });
    if (m.isMesh) drop.push(o);
  });
  for (const o of drop) o.parent?.remove(o);
  dropSky(wrap);
  // look at home in the game: flat-shaded, lit, both sides (you see tunnel walls from inside), fogged.
  // Parts with no colour of their own (plain white or grey, no texture) get painted like the game's ground.
  const box = new THREE.Box3().setFromObject(wrap);
  const plain = (c?: THREE.Color) => !c || (Math.abs(c.r - c.g) < 0.02 && Math.abs(c.g - c.b) < 0.02 && c.r > 0.55);
  const meshes: THREE.Mesh[] = [];
  wrap.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  for (const m of meshes) {
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const hasVC = !!m.geometry.getAttribute('color');
    const paint = !hasVC && list.every((src) => !(src as THREE.MeshStandardMaterial).map && plain((src as THREE.MeshStandardMaterial).color));
    if (paint) {
      paintGround(m, spec.biome ?? 'alpine', box);
      m.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    } else {
      const mats = list.map((src) => {
        const s = src as THREE.MeshStandardMaterial;
        return new THREE.MeshLambertMaterial({ color: s.color ?? 0xb9b39a, map: s.map ?? null, vertexColors: hasVC, flatShading: true, side: THREE.DoubleSide });
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    }
    m.castShadow = m.receiveShadow = false;
  }
  return { root: wrap, markers };
}

/** Give an uncoloured mesh per-face colours: grass on the flats, rock on the steep bits, snow up high. */
function paintGround(m: THREE.Mesh, biome: Biome, box: THREE.Box3) {
  let g = m.geometry as THREE.BufferGeometry;
  if (g.index) { g = g.toNonIndexed(); m.geometry = g; }
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'uv') g.deleteAttribute(k);
  const pos = g.getAttribute('position'), n = pos.count, col = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), e = new THREE.Vector3(), tmp = new THREE.Color();
  const mw = m.matrixWorld, span = Math.max(1, box.max.y - box.min.y);
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, i).applyMatrix4(mw); b.fromBufferAttribute(pos, i + 1).applyMatrix4(mw); c.fromBufferAttribute(pos, i + 2).applyMatrix4(mw);
    nrm.subVectors(b, a).cross(e.subVectors(c, a)).normalize();
    const cy = (a.y + b.y + c.y) / 3;
    mapGroundColor(biome, (a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, Math.abs(nrm.y), (cy - box.min.y) / span, tmp);
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = tmp.r; col[(i + k) * 3 + 1] = tmp.g; col[(i + k) * 3 + 2] = tmp.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
}

/** Game and scene exports often carry a sky dome or skybox: a huge mesh round everything else. As ground it
 *  would be a roof over the whole map (and every tunnel would read as solid rock under it), so it goes. */
function dropSky(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (meshes.length < 2) return;
  const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
  const sky = new Set<THREE.Mesh>();
  meshes.forEach((m, i) => {
    const names = [m.name, m.parent?.name ?? '', ...(Array.isArray(m.material) ? m.material : [m.material]).map((x) => x?.name ?? '')].join(' ');
    if (/sky|dome|backdrop|background|horizon/i.test(names)) { sky.add(m); return; }
    // encloses everything else, top and sides
    const rest = new THREE.Box3();
    boxes.forEach((b, j) => { if (j !== i) rest.union(b); });
    const b = boxes[i];
    if (!(b.min.x <= rest.min.x && b.max.x >= rest.max.x && b.min.z <= rest.min.z && b.max.z >= rest.max.z && b.max.y > rest.max.y + 1)) return;
    // ...and is hollow: almost none of its points are among the rest (the ground itself is full of them)
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const v = new THREE.Vector3(), step = Math.max(1, Math.floor(pos.count / 2000));
    let n = 0, inside = 0;
    for (let k = 0; k < pos.count; k += step, n++) if (rest.containsPoint(v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld))) inside++;
    if (inside < n * 0.02) sky.add(m);
  });
  if (sky.size >= meshes.length) return;
  for (const m of sky) m.parent?.remove(m);
}

// ---------- Building the course ----------
const LOOK_DEFAULT: CourseLook = { caveRock: 0x6b625a, crystal: 0x8ff3ff, trees: 0.8, rocks: 0.6, clouds: 0.4, lowClouds: false, spires: 0.04, tall: 1.1 };

/** Turn a map (spec + its files) into a course you can race. */
export async function buildMap(stored: StoredMap): Promise<CourseDef> {
  const { spec, files } = stored;
  let terrain: TerrainSource;
  let markers: Marker[] = [];
  if ('model' in spec.terrain) {
    const { root, markers: mk } = await loadModel(spec, files);
    const tris = modelTriangles(root, LIMITS.tris);
    const mt = new MeshTerrain(tris, root);
    // a floor far below, so falling off the edge of the model looks like falling, not a hole in the world
    const b = mt.bounds, span = Math.max(b.x1 - b.x0, b.z1 - b.z0) + 8000;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(span, span).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x6d7d58 }));
    floor.position.set((b.x0 + b.x1) / 2, mt.voidY, (b.z0 + b.z1) / 2);
    root.add(floor);
    terrain = mt;
    markers = mk;
  } else terrain = await heightmapTerrain(spec, files);
  const b = terrain.bounds;
  if (b.x1 - b.x0 > LIMITS.mapSide * 1.5 || b.z1 - b.z0 > LIMITS.mapSide * 1.5) throw new Error(`That map is ${Math.round(b.x1 - b.x0)} x ${Math.round(b.z1 - b.z0)} m. Keep it under ${LIMITS.mapSide / 1000} km a side (try a smaller scale).`);

  // timing lines: from the spec, else from the model's markers, else from the highest point down to the lowest
  const gates: Gate[] = [];
  let spawn: THREE.Vector3 | null = spec.spawn ? new THREE.Vector3(...spec.spawn) : null;
  let heading: number | null = spec.heading !== undefined ? THREE.MathUtils.degToRad(spec.heading) : null;
  const pts: { x: number; y: number; z: number; w: number; h: number; dir?: THREE.Vector3 }[] = [];
  if (spec.gates) {
    for (const g of spec.gates) {
      const a = Array.isArray(g) ? { x: g[0], y: g[1], z: g[2], w: g[3], h: g[4], heading: g[5] } : g;
      const dir = a.heading !== undefined ? new THREE.Vector3(-Math.sin(THREE.MathUtils.degToRad(a.heading)), 0, -Math.cos(THREE.MathUtils.degToRad(a.heading))) : undefined;
      pts.push({ x: a.x, y: a.y, z: a.z, w: a.w ?? 60, h: a.h ?? 40, dir });
    }
  } else {
    const st = markers.find((m) => m.kind === 'start'), fin = markers.find((m) => m.kind === 'finish');
    const sp = markers.find((m) => m.kind === 'spawn');
    if (sp && !spawn) { spawn = sp.pos.clone(); heading = Math.atan2(-sp.dir.x, -sp.dir.z); }
    if (st && fin) {
      const splits = markers.filter((m) => m.kind === 'split').sort((a, c) => a.order - c.order);
      // an empty's scale sets the line's size: x = half width, y = half height (scale 1 = the defaults)
      const size = (m: Marker) => ({ w: Math.abs(m.scale.x - 1) > 1e-3 ? Math.abs(m.scale.x) : 40, h: Math.abs(m.scale.y - 1) > 1e-3 ? Math.abs(m.scale.y) : 30 });
      for (const m of [st, ...splits, fin]) pts.push({ x: m.pos.x, y: m.pos.y, z: m.pos.z, ...size(m) });
    }
  }
  if (!pts.length) {
    const auto = autoLine(terrain, spawn);
    pts.push(...auto);
  }
  // each line faces along the way (towards the next one; the finish faces away from the one before)
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], r = pts[Math.max(0, i - 1)];
    let dir = p.dir;
    if (!dir) {
      const a = i < pts.length - 1 ? p : r, c = i < pts.length - 1 ? q : p;
      dir = new THREE.Vector3(c.x - a.x, 0, c.z - a.z);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
    }
    gates.push({ x: p.x, y: p.y, z: p.z, nx: dir.x, nz: dir.z, halfW: p.w, halfH: p.h });
  }
  const sg = gates[0];
  if (!spawn) {
    // a short way back from the start line, above whatever's there
    const bx = sg.x - sg.nx * 70, bz = sg.z - sg.nz * 70;
    const top = 'model' in spec.terrain ? Math.max(sg.y, terrain.height(bx, bz) + 12) : Math.max(sg.y, terrain.height(bx, bz) + 18);
    spawn = new THREE.Vector3(bx, top, bz);
  }
  if (heading === null) heading = Math.atan2(-(sg.x - spawn.x), -(sg.z - spawn.z));

  // the line every route follows (for the progress bar and the ghost compare): spawn, then each gate
  const line: CtrlPt[] = [[spawn.x, spawn.z, spawn.y - 14, sg.halfW, 0]];
  for (const g of gates) line.push([g.x, g.z, g.y - g.halfH * 0.5, g.halfW, 0]);
  const paths: PathDef[] = [{ id: 'route', kind: 'valley', pts: dedupe(line), dens: 0.25 }];
  (spec.tunnels ?? []).forEach((tn, i) => { if (!('model' in spec.terrain)) paths.push({ id: `tunnel${i}`, kind: 'cave', pts: tn.pts }); });

  const objects: ObjectDef[] = [...(spec.objects ?? [])];
  for (const m of markers) if (m.kind === 'tree' || m.kind === 'rock' || m.kind === 'spire') {
    const s = Math.max(Math.abs(m.scale.x), Math.abs(m.scale.z));
    objects.push({ type: m.kind, x: m.pos.x, z: m.pos.z, y: m.pos.y, ...(Math.abs(s - 1) > 1e-3 ? { r: s } : {}), ...(m.kind !== 'rock' && Math.abs(m.scale.y - 1) > 1e-3 ? { h: Math.abs(m.scale.y) } : {}) });
  }
  if (objects.length > LIMITS.objects) objects.length = LIMITS.objects;
  const model = 'model' in spec.terrain;
  const look: CourseLook = { ...LOOK_DEFAULT, ...(model ? { trees: 0, rocks: 0, spires: 0 } : {}), ...(spec.look ?? {}) };
  const nSplits = gates.length - 2;
  const sections = spec.sections?.length === nSplits + 1 ? spec.sections : Array.from({ length: nSplits + 1 }, (_, i) => nSplits ? `Section ${i + 1}` : 'Run');
  return {
    id: `map-${stored.id}`, version: 1, name: spec.name, blurb: spec.blurb ?? (model ? 'Your imported model' : 'Your imported heightmap'),
    biome: spec.biome ?? 'alpine', seed: parseInt(stored.id.slice(0, 7), 16) | 0,
    paths, routes: [{ name: 'Main', paths: ['route'] }], pieces: [], look,
    start: { x: spawn.x, y: spawn.y, z: spawn.z, heading, speed: 34 },
    startGate: gates[0], splits: gates.slice(1, -1), finish: gates[gates.length - 1], sections,
    terrain, objects, local: true,
  };
}

function dedupe(pts: CtrlPt[]): CtrlPt[] {
  const out: CtrlPt[] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 2) out.push(p); }
  if (out.length < 2) out.push([out[0][0], out[0][1] - 50, out[0][2], out[0][3], 0]);
  return out;
}

/** No timing lines given: race from the highest ground to the lowest, the long way across the map. */
function autoLine(t: TerrainSource, spawn: THREE.Vector3 | null) {
  const b = t.bounds, N = 48;
  const voidY = (t as MeshTerrain).voidY ?? -Infinity;
  const samples: { x: number; z: number; y: number }[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = lerp(b.x0, b.x1, 0.08 + 0.84 * i / N), z = lerp(b.z0, b.z1, 0.08 + 0.84 * j / N);
    const y = t.height(x, z);
    if (y > voidY + 1) samples.push({ x, z, y });
  }
  if (!samples.length) throw new Error('Couldn\'t find any ground in that map.');
  const hi = spawn ? { x: spawn.x, z: spawn.z, y: t.height(spawn.x, spawn.z) } : samples.reduce((a, c) => (c.y > a.y ? c : a));
  const diag = Math.hypot(b.x1 - b.x0, b.z1 - b.z0);
  // the finish: low, and far away (a long run beats the nearest dip)
  const lo = samples.reduce((a, c) => {
    const score = (s: typeof c) => -s.y + Math.hypot(s.x - hi.x, s.z - hi.z) / diag * (b.y1 - b.y0) * 0.8;
    return score(c) > score(a) ? c : a;
  });
  const L = Math.hypot(lo.x - hi.x, lo.z - hi.z) || 1;
  const ux = (lo.x - hi.x) / L, uz = (lo.z - hi.z) / L;
  // the start line a little way down from the top, the finish just short of the bottom; both big and generous
  const at = (d: number) => {
    const x = hi.x + ux * d, z = hi.z + uz * d;
    let g = -Infinity;
    for (let k = -2; k <= 2; k++) g = Math.max(g, t.height(x + uz * k * 30, z - ux * k * 30));
    return { x, z, g };
  };
  const s = at(Math.min(120, L * 0.1)), f = at(L * 0.97);
  const W = Math.min(160, Math.max(60, L * 0.06));
  return [
    { x: s.x, y: s.g + 40, z: s.z, w: W, h: 70 },
    { x: f.x, y: f.g + 40, z: f.z, w: W * 1.3, h: 90 },
  ];
}
const lerp = THREE.MathUtils.lerp;

// ---------- Keeping maps on this device ----------
const DB = 'glide-maps', STORE = 'maps';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = f(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export const listMaps = () => tx<StoredMap[]>('readonly', (s) => s.getAll() as IDBRequest<StoredMap[]>).then((a) => a.sort((x, y) => x.at - y.at)).catch(() => [] as StoredMap[]);
export const saveMap = (m: StoredMap) => tx('readwrite', (s) => s.put(m));
export const deleteMap = (id: string) => tx('readwrite', (s) => s.delete(id));

/** A map's id: a hash of its settings and files, so the same map always has the same id (and best times). */
export async function mapId(spec: MapSpec, files: MapFile[]): Promise<string> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [enc.encode(JSON.stringify(spec))];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) parts.push(enc.encode(f.name), f.data);
  const buf = await new Blob(parts).arrayBuffer();
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // (no subtle crypto off https) a plain FNV hash is fine for an id on this device
    let h = 0x811c9dc5; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0') + u.length.toString(16).padStart(8, '0');
  }
}

/** Only the files the map actually uses (and only up to the size limits). */
export function filesFor(spec: MapSpec, files: MapFile[]): MapFile[] {
  const total = files.reduce((s, f) => s + f.data.byteLength, 0);
  for (const f of files) if (f.data.byteLength > LIMITS.fileMB * 1e6) throw new Error(`${f.name} is over ${LIMITS.fileMB} MB.`);
  if (total > LIMITS.totalMB * 1e6) throw new Error(`Those files add up to over ${LIMITS.totalMB} MB.`);
  return files.filter((f) => ext(f.name) !== 'json');
}
