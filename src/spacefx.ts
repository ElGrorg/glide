import * as THREE from 'three';

// ---------- Space combat effects ----------
// Everything that flashes, burns, sparks and drifts in the space battle: fighter explosions (a white flash,
// a rolling fireball, a shock ring, sparks, burning debris and a smoke cloud that hangs there), laser hits on
// hulls, shield shimmer when a bolt lands on a fighter, muzzle flashes, missile exhaust, engine trails, and
// the odd secondary detonation along a capital ship's hull.
// Particles are drawn as camera-facing quads in two instanced batches (glowing, and smoke), so even a big
// furball is two draw calls.

const { lerp, clamp } = THREE.MathUtils;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Particle texture atlas, 2 x 2: 0 soft glow, 1 fireball, 2 smoke puff, 3 shock ring. */
function atlasTexture() {
  const S = 128, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const cx = cv.getContext('2d');
  if (cx) {
    const blob = (ox: number, oy: number, stops: [number, string][]) => {
      const g = cx.createRadialGradient(ox + S / 2, oy + S / 2, 0, ox + S / 2, oy + S / 2, S / 2);
      for (const [k, c] of stops) g.addColorStop(k, c);
      cx.fillStyle = g; cx.fillRect(ox, oy, S, S);
    };
    // 0: glow: a hot core with a long soft falloff
    blob(0, 0, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.8)'], [0.45, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]);
    // 1 and 2: lumpy blobs built from overlapping soft circles (fire is denser in the middle, smoke is wispier)
    const lumpy = (ox: number, oy: number, n: number, hard: number) => {
      cx.save(); cx.beginPath(); cx.rect(ox, oy, S, S); cx.clip();
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() ** 0.7 * S * 0.26;
        const x = ox + S / 2 + Math.cos(a) * r, y = oy + S / 2 + Math.sin(a) * r, rr = S * (0.1 + Math.random() * 0.16);
        const g = cx.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, `rgba(255,255,255,${hard})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        cx.fillStyle = g; cx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
      cx.restore();
    };
    lumpy(S, 0, 46, 0.32);
    lumpy(0, S, 34, 0.2);
    // 3: a thin bright ring
    const g = cx.createRadialGradient(S * 1.5, S * 1.5, 0, S * 1.5, S * 1.5, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.72, 'rgba(255,255,255,0)'); g.addColorStop(0.86, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.93, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g; cx.fillRect(S, S, S, S);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  // (no mipmaps: the small mips would bleed the cells of the atlas into each other)
  t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
  return t;
}

interface P {
  p: THREE.Vector3; v: THREE.Vector3; age: number; life: number;
  s0: number; s1: number; c0: THREE.Color; c1: THREE.Color; a0: number; a1: number;
  rot: number; spin: number; drag: number; stretch: number; frame: number; fadeIn: number;
}

/** A batch of camera-facing quads: position, size, spin, colour and alpha change over each one's life. */
class Particles {
  mesh: THREE.Mesh;
  private list: P[] = [];
  private free: P[] = [];
  private off: Float32Array; private col: Float32Array; private misc: Float32Array; private vel: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private c = new THREE.Color();
  constructor(private max: number, additive: boolean, tex: THREE.Texture) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.off = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.misc = new Float32Array(max * 4); this.vel = new Float32Array(max * 3);
    g.setAttribute('offset', new THREE.InstancedBufferAttribute(this.off, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcol', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('misc', new THREE.InstancedBufferAttribute(this.misc, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pvel', new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: tex }, gain: { value: additive ? 2.4 : 1 } },
      vertexShader: `
        attribute vec3 offset; attribute vec4 pcol; attribute vec4 misc; attribute vec3 pvel;
        varying vec2 vUv; varying vec4 vCol;
        void main(){
          vec4 mv = modelViewMatrix * vec4(offset, 1.);
          float s = misc.x;
          vec2 ax = vec2(cos(misc.y), sin(misc.y));
          float len = s;
          if (misc.z > 0.) {
            // sparks: stretch the quad along the way it's moving across the screen
            vec3 vv = (modelViewMatrix * vec4(pvel, 0.)).xyz;
            float l = length(vv.xy);
            if (l > 1e-3) ax = vv.xy / l;
            len = s + misc.z * l;
          }
          vec2 q = position.xy * vec2(len, s);
          mv.xy += vec2(q.x * ax.x - q.y * ax.y, q.x * ax.y + q.y * ax.x);
          gl_Position = projectionMatrix * mv;
          float f = misc.w;
          vUv = (position.xy + .5) * .5 + vec2(mod(f, 2.), floor(f / 2.)) * .5;
          vUv.y = 1. - vUv.y;
          vCol = pcol;
        }`,
      fragmentShader: `
        uniform sampler2D map; uniform float gain; varying vec2 vUv; varying vec4 vCol;
        void main(){ vec4 t = texture2D(map, vUv); gl_FragColor = vec4(vCol.rgb * t.rgb * gain, t.a * vCol.a); }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 6 : 5;
  }
  add(o: Partial<P> & { p: THREE.Vector3 }) {
    if (this.list.length >= this.max) return;
    const q = this.free.pop() ?? { p: new THREE.Vector3(), v: new THREE.Vector3(), c0: new THREE.Color(), c1: new THREE.Color() } as P;
    q.p.copy(o.p); q.v.copy(o.v ?? ZERO); q.age = 0; q.life = o.life ?? 1;
    q.s0 = o.s0 ?? 1; q.s1 = o.s1 ?? q.s0; q.c0.copy(o.c0 ?? WHITE); q.c1.copy(o.c1 ?? q.c0);
    q.a0 = o.a0 ?? 1; q.a1 = o.a1 ?? 0; q.rot = o.rot ?? Math.random() * 6.28; q.spin = o.spin ?? 0;
    q.drag = o.drag ?? 0; q.stretch = o.stretch ?? 0; q.frame = o.frame ?? 0; q.fadeIn = o.fadeIn ?? 0;
    this.list.push(q);
  }
  update(dt: number) {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const q = this.list[i];
      q.age += dt;
      if (q.age >= q.life) { this.free.push(q); this.list[i] = this.list[this.list.length - 1]; this.list.pop(); continue; }
    }
    for (const q of this.list) {
      if (q.drag) q.v.multiplyScalar(Math.exp(-q.drag * dt));
      q.p.addScaledVector(q.v, dt);
      q.rot += q.spin * dt;
      const k = q.age / q.life;
      // sizes ease out (a fireball swells fast, then slowly), alpha fades in then out
      const ke = 1 - (1 - k) * (1 - k);
      const s = lerp(q.s0, q.s1, ke);
      let a = lerp(q.a0, q.a1, k);
      if (q.fadeIn) a *= clamp(q.age / q.fadeIn, 0, 1);
      this.c.copy(q.c0).lerp(q.c1, k);
      this.off[n * 3] = q.p.x; this.off[n * 3 + 1] = q.p.y; this.off[n * 3 + 2] = q.p.z;
      this.col[n * 4] = this.c.r; this.col[n * 4 + 1] = this.c.g; this.col[n * 4 + 2] = this.c.b; this.col[n * 4 + 3] = a;
      this.misc[n * 4] = s; this.misc[n * 4 + 1] = q.rot; this.misc[n * 4 + 2] = q.stretch; this.misc[n * 4 + 3] = q.frame;
      this.vel[n * 3] = q.v.x; this.vel[n * 3 + 1] = q.v.y; this.vel[n * 3 + 2] = q.v.z;
      n++;
    }
    this.geo.instanceCount = n;
    for (const name of ['offset', 'pcol', 'misc', 'pvel']) {
      const a = this.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
      a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true;
    }
  }
  clear() { this.free.push(...this.list); this.list.length = 0; this.geo.instanceCount = 0; }
}

const ZERO = new THREE.Vector3(), WHITE = new THREE.Color(1, 1, 1);
const C = (h: number) => new THREE.Color(h);
const FIRE_HOT = C(0xfff2c8), FIRE = C(0xff9a2e), FIRE_DEEP = C(0xc23a12), EMBER = C(0x401008);
const SMOKE = C(0x3a3640), SMOKE_DARK = C(0x16141a), SPARK = C(0xffe6a0);

/** A chunk of wreckage: tumbles away, trailing fire and smoke while it burns. */
interface Debris { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; spinAxis: THREE.Vector3; spin: number; size: number; age: number; life: number; burn: number; trailT: number }

/** An engine trail: a ribbon through the last second or so of a fighter's path. */
class Trail {
  pts: THREE.Vector3[] = []; times: number[] = [];
  mesh: THREE.Mesh; lastSeen = 0; strength = 0;
  private pos: Float32Array; private col: Float32Array;
  constructor(public color: THREE.Color, private width: number, private N = 28) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3); this.col = new Float32Array(N * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, trailMat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 4;
  }
  push(p: THREE.Vector3, now: number, strength: number) {
    this.strength = strength; this.lastSeen = now;
    const last = this.pts[0];
    if (last && last.distanceToSquared(p) < 0.6 * 0.6 && this.pts.length > 1) { last.copy(p); this.times[0] = now; return; }
    const v = this.pts.length >= this.N ? this.pts.pop()! : new THREE.Vector3();
    if (this.times.length >= this.N) this.times.pop();
    this.pts.unshift(v.copy(p)); this.times.unshift(now);
  }
  build(now: number, cam: THREE.Vector3) {
    const n = this.pts.length, side = new THREE.Vector3(), seg = new THREE.Vector3(), toCam = new THREE.Vector3();
    for (let i = 0; i < this.N; i++) {
      const j = Math.min(i, n - 1);
      const p = this.pts[j];
      if (!p) { this.pos.fill(0); this.col.fill(0); break; }
      const nx = this.pts[Math.min(j + 1, n - 1)], pv = this.pts[Math.max(j - 1, 0)];
      seg.copy(pv).sub(nx); toCam.copy(cam).sub(p);
      side.crossVectors(seg, toCam).normalize();
      const age = now - this.times[j];
      const k = i >= n ? 0 : clamp(1 - age / 0.8, 0, 1) * (1 - i / this.N);
      const w = this.width * (0.35 + 0.65 * k);
      for (const s of [0, 1]) {
        const o = (i * 2 + s) * 3;
        this.pos[o] = p.x + side.x * w * (s ? 1 : -1); this.pos[o + 1] = p.y + side.y * w * (s ? 1 : -1); this.pos[o + 2] = p.z + side.z * w * (s ? 1 : -1);
        const a = k * k * this.strength;
        this.col[o] = this.color.r * a; this.col[o + 1] = this.color.g * a; this.col[o + 2] = this.color.b * a;
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
}
const trailMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

/** A shield bubble that ripples out from where a bolt struck. */
const shieldGeo = new THREE.IcosahedronGeometry(1, 2);
function shieldMat() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    uniforms: { hit: { value: new THREE.Vector3(0, 0, 1) }, t: { value: 0 }, color: { value: new THREE.Color(0x66ccff) } },
    vertexShader: 'varying vec3 vN; varying vec3 vL; varying vec3 vV; void main(){ vL = normalize(position); vec4 w = modelMatrix * vec4(position,1.); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec3 hit; uniform float t; uniform vec3 color; varying vec3 vN; varying vec3 vL; varying vec3 vV;
      void main(){
        float ang = acos(clamp(dot(vL, hit), -1., 1.));
        float wave = exp(-pow((ang - t * 5.) * 3.5, 2.)) * (1. - t);
        float core = exp(-ang * 4.) * (1. - t) * 1.6;
        float rim = pow(1. - abs(dot(vN, vV)), 2.5) * .45 * (1. - t);
        float a = wave + core + rim;
        gl_FragColor = vec4(color * a, a);
      }`,
  });
}

export class SpaceFx {
  group = new THREE.Group();
  private glow: Particles;
  private smoke: Particles;
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private shields: { mesh: THREE.Mesh; t: number; follow: THREE.Object3D | null }[] = [];
  private trails = new Map<object, Trail>();
  /** Two pooled lights for explosion flashes: they light up the hulls nearby. */
  private lights: { l: THREE.PointLight; t: number; dur: number; peak: number }[] = [];
  private now = 0;
  private m = new THREE.Matrix4(); private s = new THREE.Vector3(); private v = new THREE.Vector3(); private v2 = new THREE.Vector3();
  /** Called with (position, size) whenever something blows up, so main can play a boom and shake the camera. */
  onBoom: ((p: THREE.Vector3, size: number) => void) | null = null;

  constructor() {
    const tex = atlasTexture();
    this.smoke = new Particles(700, false, tex);
    this.glow = new Particles(1400, true, tex);
    this.group.add(this.smoke.mesh, this.glow.mesh);
    const chunk = new THREE.DodecahedronGeometry(1, 0).scale(1, 0.5, 0.75);
    this.debrisMesh = new THREE.InstancedMesh(chunk, new THREE.MeshLambertMaterial({ color: 0x5a5c66, flatShading: true }), 160);
    this.debrisMesh.count = 0; this.debrisMesh.frustumCulled = false;
    this.group.add(this.debrisMesh);
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(shieldGeo, shieldMat());
      mesh.visible = false; mesh.renderOrder = 6;
      this.shields.push({ mesh, t: 1, follow: null }); this.group.add(mesh);
    }
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffa860, 0, 420, 1.4);
      this.lights.push({ l, t: 1, dur: 1, peak: 0 }); this.group.add(l);
    }
  }

  private flashLight(p: THREE.Vector3, peak: number, dur: number, color = 0xffa860) {
    const slot = this.lights.reduce((a, b) => (b.t / b.dur > a.t / a.dur ? b : a));
    slot.l.position.copy(p); slot.l.color.set(color); slot.t = 0; slot.dur = dur; slot.peak = peak;
  }

  /** A fighter blowing apart. `vel` is the wreck's own velocity (the whole cloud carries it a little). */
  explode(p: THREE.Vector3, vel: THREE.Vector3, size = 1) {
    const base = this.v2.copy(vel).multiplyScalar(0.35);
    const g = this.glow, sm = this.smoke, v = this.v;
    // the flash: a blinding white core and a wide blue-white bloom
    g.add({ p, v: base, life: 0.12, s0: 8 * size, s1: 22 * size, c0: WHITE, a0: 1, a1: 0, frame: 0 });
    g.add({ p, v: base, life: 0.35, s0: 24 * size, s1: 50 * size, c0: C(0xffd8a0), a0: 0.35, a1: 0, frame: 0 });
    // the shock ring, flat-on to you, racing outward
    g.add({ p, v: base, life: 0.6, s0: 6 * size, s1: 70 * size, c0: C(0xcfe6ff), c1: C(0x3a78ff), a0: 0.5, a1: 0, frame: 3 });
    // the fireball: puffs of fire that swell, cool from yellow-white to deep red, and go out
    for (let i = 0; i < 18 * size; i++) {
      v.randomDirection().multiplyScalar(rnd(4, 18) * size).add(base);
      g.add({ p: this.s.randomDirection().multiplyScalar(rnd(0, 2.5) * size).add(p), v, life: rnd(0.7, 1.5), s0: rnd(4, 7) * size, s1: rnd(12, 22) * size,
        c0: FIRE_HOT, c1: FIRE_DEEP, a0: 1, a1: 0, frame: 1, spin: rnd(-1.5, 1.5), drag: 1.2 });
    }
    // sparks: fast, thin, streaking
    for (let i = 0; i < 46 * size; i++) {
      v.randomDirection().multiplyScalar(rnd(35, 110) * size).add(base);
      g.add({ p, v, life: rnd(0.35, 1.0), s0: rnd(0.25, 0.5), s1: 0.1, c0: SPARK, c1: FIRE, a0: 1, a1: 0, frame: 0, stretch: 0.045, drag: 1.4 });
    }
    // the smoke cloud it leaves behind, lit orange from inside at first
    for (let i = 0; i < 14 * size; i++) {
      v.randomDirection().multiplyScalar(rnd(2, 9) * size).add(base);
      sm.add({ p: this.s.randomDirection().multiplyScalar(rnd(0, 4) * size).add(p), v, life: rnd(2.5, 4.5), s0: rnd(6, 10) * size, s1: rnd(18, 30) * size,
        c0: C(0x7a4a36), c1: SMOKE_DARK, a0: 0.75, a1: 0, frame: 2, spin: rnd(-0.4, 0.4), drag: 0.5, fadeIn: 0.25 });
    }
    // burning wreckage tumbling away
    for (let i = 0; i < 7 * size; i++) this.addDebris(p, v.randomDirection().multiplyScalar(rnd(10, 40) * size).add(base), rnd(0.25, 0.7) * Math.sqrt(size), rnd(2.5, 5));
    this.flashLight(p, 160 * size, 0.9);
    this.onBoom?.(p, size);
  }

  /** A secondary detonation on a capital ship's hull: smaller, slower, hangs there. `n` is the hull normal. */
  hullBlast(p: THREE.Vector3, n: THREE.Vector3, size = 1) {
    const g = this.glow, sm = this.smoke, v = this.v;
    g.add({ p, life: 0.25, s0: 14 * size, s1: 40 * size, c0: FIRE_HOT, a0: 0.9, a1: 0 });
    for (let i = 0; i < 12; i++) {
      v.randomDirection().addScaledVector(n, 1.4).normalize().multiplyScalar(rnd(4, 14) * size);
      g.add({ p, v, life: rnd(0.8, 1.6), s0: rnd(4, 8) * size, s1: rnd(14, 24) * size, c0: FIRE_HOT, c1: FIRE_DEEP, frame: 1, spin: rnd(-1, 1), drag: 0.8 });
    }
    for (let i = 0; i < 24; i++) {
      v.randomDirection().addScaledVector(n, 1.2).normalize().multiplyScalar(rnd(25, 70) * size);
      g.add({ p, v, life: rnd(0.6, 1.4), s0: 0.6 * size, s1: 0.2, c0: SPARK, c1: FIRE, frame: 0, stretch: 0.05, drag: 0.8 });
    }
    for (let i = 0; i < 10; i++) {
      v.randomDirection().addScaledVector(n, 1.5).normalize().multiplyScalar(rnd(2, 6) * size);
      sm.add({ p, v, life: rnd(4, 7), s0: 8 * size, s1: rnd(30, 46) * size, c0: SMOKE, c1: SMOKE_DARK, a0: 0.45, a1: 0, frame: 2, spin: rnd(-0.2, 0.2), drag: 0.3, fadeIn: 0.4 });
    }
    for (let i = 0; i < 4; i++) this.addDebris(p, v.randomDirection().addScaledVector(n, 1.5).normalize().multiplyScalar(rnd(8, 24)), rnd(0.6, 1.4) * size, rnd(4, 7));
    this.flashLight(p, 220 * size, 1.2);
    this.onBoom?.(p, size * 2.5);
  }

  /** A bolt splashing on a hull (or a missile on armour): a hot flash, a spray of sparks, a wisp of smoke. */
  impact(p: THREE.Vector3, color: THREE.Color, big = false) {
    const g = this.glow, v = this.v, k = big ? 2 : 1;
    g.add({ p, life: 0.12, s0: 3 * k, s1: 7 * k, c0: WHITE, a0: 1, a1: 0 });
    g.add({ p, life: 0.3, s0: 4 * k, s1: 10 * k, c0: color, a0: 0.8, a1: 0 });
    for (let i = 0; i < 9 * k; i++) {
      v.randomDirection().multiplyScalar(rnd(15, 45));
      g.add({ p, v, life: rnd(0.2, 0.55), s0: 0.22, s1: 0.06, c0: SPARK, c1: color, frame: 0, stretch: 0.04, drag: 2 });
    }
    this.smoke.add({ p, v: v.randomDirection().multiplyScalar(2), life: 1.4, s0: 1.5 * k, s1: 5 * k, c0: SMOKE, c1: SMOKE_DARK, a0: 0.4, a1: 0, frame: 2, fadeIn: 0.1 });
  }

  /** A bolt landing on a fighter's shields: the bubble lights up and ripples out from the hit. */
  shieldHit(target: THREE.Object3D, hitFrom: THREE.Vector3, color: THREE.Color, radius = 4.2) {
    const s = this.shields.reduce((a, b) => (b.t > a.t ? b : a));
    s.t = 0; s.follow = target;
    s.mesh.visible = true; s.mesh.scale.setScalar(radius);
    s.mesh.position.copy(target.position);
    const mat = s.mesh.material as THREE.ShaderMaterial;
    (mat.uniforms.hit.value as THREE.Vector3).copy(hitFrom).sub(target.position).normalize();
    (mat.uniforms.color.value as THREE.Color).copy(color);
    const p = this.v.copy(hitFrom).sub(target.position).setLength(radius).add(target.position);
    for (let i = 0; i < 8; i++) this.glow.add({ p, v: this.v2.randomDirection().multiplyScalar(rnd(10, 30)), life: rnd(0.15, 0.4), s0: 0.25, s1: 0.05, c0: WHITE, c1: color, stretch: 0.04, drag: 2 });
  }

  /** The flash at a gun's muzzle as it fires. */
  muzzle(p: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color) {
    this.glow.add({ p, v: vel, life: 0.07, s0: 1.6, s1: 2.6, c0: WHITE, c1: color, a0: 1, a1: 0.2 });
  }

  /** Missile exhaust: a hot point and a smoke trail that lingers. */
  missileTrail(p: THREE.Vector3, dir: THREE.Vector3, hot = true) {
    this.glow.add({ p, v: this.v.copy(dir).multiplyScalar(-8), life: 0.18, s0: 1.6, s1: 0.6, c0: FIRE_HOT, c1: FIRE, a0: hot ? 1 : 0.5, a1: 0 });
    this.smoke.add({ p, v: this.v.randomDirection().multiplyScalar(1.2), life: rnd(1.4, 2.2), s0: 0.8, s1: rnd(3, 5), c0: C(0x8a8690), c1: SMOKE, a0: 0.4, a1: 0, frame: 2, spin: rnd(-1, 1), fadeIn: 0.05 });
  }

  /** A damaged fighter streaming smoke and the odd spark (more the worse it's hurt, 0..1). */
  damaged(p: THREE.Vector3, vel: THREE.Vector3, hurt: number, dt: number) {
    if (Math.random() < 26 * hurt * dt)
      this.smoke.add({ p, v: this.v.copy(vel).multiplyScalar(0.2).add(this.v2.randomDirection().multiplyScalar(1.5)), life: rnd(1, 1.8), s0: 0.8, s1: 4 * hurt + 1, c0: C(0x4a4650), c1: SMOKE_DARK, a0: 0.5, a1: 0, frame: 2, fadeIn: 0.05 });
    if (hurt > 0.5 && Math.random() < 10 * dt)
      this.glow.add({ p, v: this.v.randomDirection().multiplyScalar(18).addScaledVector(vel, 0.5), life: 0.3, s0: 0.2, s1: 0.05, c0: SPARK, c1: FIRE, stretch: 0.04 });
    if (hurt > 0.5 && Math.random() < 14 * dt)
      this.glow.add({ p, v: this.v.copy(vel).multiplyScalar(0.3), life: 0.25, s0: 1.2, s1: 2.2, c0: FIRE_HOT, c1: FIRE_DEEP, frame: 1 });
  }

  /** A wreck in its death spiral: fire licking out of it and a thick smoke trail. */
  burning(p: THREE.Vector3, vel: THREE.Vector3, dt: number) {
    if (Math.random() < 40 * dt) this.glow.add({ p, v: this.v.copy(vel).multiplyScalar(0.2).add(this.v2.randomDirection().multiplyScalar(3)), life: rnd(0.3, 0.6), s0: 1.5, s1: 4, c0: FIRE_HOT, c1: FIRE_DEEP, frame: 1, spin: 2 });
    if (Math.random() < 30 * dt) this.smoke.add({ p, v: this.v.copy(vel).multiplyScalar(0.1), life: rnd(1.5, 2.5), s0: 1.5, s1: 7, c0: C(0x3a3036), c1: SMOKE_DARK, a0: 0.6, a1: 0, frame: 2, fadeIn: 0.05 });
    if (Math.random() < 12 * dt) this.glow.add({ p, v: this.v.randomDirection().multiplyScalar(30).addScaledVector(vel, 0.3), life: 0.4, s0: 0.25, s1: 0.05, c0: SPARK, c1: FIRE, stretch: 0.04 });
  }

  /** A distant flash (far-off battle): just a glow that swells and fades. */
  distantFlash(p: THREE.Vector3, size: number, color = 0xffc890) {
    this.glow.add({ p, life: 0.5, s0: size * 0.3, s1: size, c0: C(color), a0: 0.7, a1: 0 });
    this.glow.add({ p, life: 1.4, s0: size * 0.4, s1: size * 0.7, c0: FIRE, c1: FIRE_DEEP, a0: 0.5, a1: 0, frame: 1 });
  }

  /** A heavy turbolaser bolt's glow head (the bolt body itself is drawn by the battle). */
  glowAt(p: THREE.Vector3, size: number, color: THREE.Color, life = 0.06) { this.glow.add({ p, life, s0: size, s1: size, c0: color, a0: 0.8, a1: 0.8 }); }

  private addDebris(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number) {
    if (this.debris.length >= 160) return;
    this.debris.push({ p: p.clone(), v: v.clone(), q: new THREE.Quaternion().random(), spinAxis: new THREE.Vector3().randomDirection(), spin: rnd(2, 9), size, age: 0, life, burn: rnd(0.8, 2.2), trailT: 0 });
  }

  /** Keep a fighter's engine trail going (call every frame it's flying). */
  trail(key: object, p: THREE.Vector3, color: THREE.Color, strength: number, width = 0.32) {
    let tr = this.trails.get(key);
    if (!tr) { tr = new Trail(color.clone(), width); this.trails.set(key, tr); this.group.add(tr.mesh); }
    tr.push(p, this.now, strength);
  }

  update(dt: number, cam: THREE.Vector3) {
    this.now += dt;
    this.glow.update(dt); this.smoke.update(dt);
    // wreckage
    let n = 0;
    const dq = new THREE.Quaternion();
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age >= d.life) { this.debris.splice(i, 1); continue; }
      d.p.addScaledVector(d.v, dt); d.v.multiplyScalar(Math.exp(-0.15 * dt));
      d.q.multiply(dq.setFromAxisAngle(d.spinAxis, d.spin * dt));
      if (d.age < d.burn && (d.trailT -= dt) <= 0) {
        d.trailT = 0.035;
        const k = 1 - d.age / d.burn;
        this.glow.add({ p: d.p, life: 0.35, s0: 1.4 * d.size * (0.5 + k), s1: 0.4, c0: FIRE_HOT, c1: FIRE_DEEP, frame: 1 });
        this.smoke.add({ p: d.p, life: rnd(1, 1.8), s0: 0.6 * d.size, s1: 3 * d.size, c0: C(0x4a4248), c1: SMOKE_DARK, a0: 0.45 * k + 0.1, a1: 0, frame: 2 });
      }
      const sc = d.size * Math.min(1, (d.life - d.age) / 0.5);
      this.m.compose(d.p, d.q, this.s.setScalar(sc));
      this.debrisMesh.setMatrixAt(n++, this.m);
    }
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    // shields
    for (const s of this.shields) {
      if (s.t >= 1) { s.mesh.visible = false; continue; }
      s.t = Math.min(1, s.t + dt / 0.45);
      if (s.follow) s.mesh.position.copy(s.follow.position);
      (s.mesh.material as THREE.ShaderMaterial).uniforms.t.value = s.t;
    }
    // explosion lights: a quick flare, then a slower fade with a flicker
    for (const L of this.lights) {
      L.t += dt;
      const k = L.t / L.dur;
      L.l.intensity = k >= 1 ? 0 : L.peak * (k < 0.08 ? k / 0.08 : (1 - k) ** 2) * (0.85 + 0.15 * Math.random());
    }
    // trails: rebuild, and let go of any that have stopped being fed
    for (const [key, tr] of this.trails) {
      if (this.now - tr.lastSeen > 1.2) { this.group.remove(tr.mesh); tr.mesh.geometry.dispose(); this.trails.delete(key); continue; }
      if (this.now - tr.lastSeen > 0.05) tr.strength *= Math.exp(-3 * dt);
      tr.build(this.now, cam);
    }
  }

  clear() {
    this.glow.clear(); this.smoke.clear(); this.debris.length = 0; this.debrisMesh.count = 0;
    for (const s of this.shields) { s.t = 1; s.mesh.visible = false; }
    for (const L of this.lights) { L.t = L.dur; L.l.intensity = 0; }
    for (const tr of this.trails.values()) { this.group.remove(tr.mesh); tr.mesh.geometry.dispose(); }
    this.trails.clear();
  }
}

/** The one effects system (main adds its group to the scene, and shows it only in space). */
export const sfx = new SpaceFx();
