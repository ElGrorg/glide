import * as THREE from 'three';
import type { BirdPalette } from './bird';
import { SPACE_BRAKE, SPACE_BOOST, SPACE_CRUISE } from './space';
import { sfx } from './spacefx';

/** Anything that can be drawn as a flyer: a bird, or a space fighter. Faces -Z. */
export interface Craft extends THREE.Object3D {
  animate(t: number, brake: number, speed: number, tuck?: number, flap?: number): void;
}

/** A body lofted through hexagonal sections: [z, half width, half height, centre height]. */
function loftBody(sections: [number, number, number, number][]) {
  const ring = (w: number, h: number, y: number) => [[0, y + h], [w * 0.8, y + h * 0.55], [w, y - h * 0.15], [w * 0.55, y - h], [-w * 0.55, y - h], [-w, y - h * 0.15], [-w * 0.8, y + h * 0.55]];
  const pos: number[] = [];
  const push = (...pts: number[][]) => { for (const p of pts) pos.push(p[0], p[1], p[2]); };
  for (let i = 0; i < sections.length - 1; i++) {
    const [z0, w0, h0, y0] = sections[i], [z1, w1, h1, y1] = sections[i + 1];
    const A = ring(w0, h0, y0), B = ring(w1, h1, y1), n = A.length;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const a = [A[k][0], A[k][1], z0], b = [A[j][0], A[j][1], z0], c = [B[j][0], B[j][1], z1], d = [B[k][0], B[k][1], z1];
      push(a, c, b, a, d, c);
    }
  }
  // close the tail
  const [zt, wt, ht, yt] = sections[sections.length - 1];
  const T = ring(wt, ht, yt);
  for (let k = 0; k < T.length; k++) { const j = (k + 1) % T.length; push([0, yt, zt], [T[k][0], T[k][1], zt], [T[j][0], T[j][1], zt]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** A flat plate from a planform outline in (x, z), `t` thick, hanging below y = 0. */
function plate(outline: [number, number][], t: number) {
  const s = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  return new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false }).rotateX(Math.PI / 2);
}

const flameGeo = new THREE.ConeGeometry(0.2, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5); // points +Z (out the back)
const flameMats = new Map<number, THREE.MeshBasicMaterial>();
const NOZZLE_X = 0.62, NOZZLE_Y = -0.04, NOZZLE_Z = 1.95;

/** Low-poly space fighter (an original design): a faceted dart of a fuselage with a long glass canopy,
 *  cranked delta wings carrying a laser cannon at each tip, twin engine nacelles and canted tail fins.
 *  Air-brake... well, drift flaps kick up off the wing roots when you drift, and the engines leave a trail.
 *  About 4.6 m long and 5 m across, the size of a bird, so the hit boxes stay the same. */
export class ShipMesh extends THREE.Group implements Craft {
  private flames: THREE.Mesh[] = [];
  private flaps: THREE.Object3D[] = [];
  private navs: THREE.Mesh[] = [];
  private trailColor: THREE.Color;
  private wp = new THREE.Vector3();
  /** Leave engine trails (off for your own fighter: you'd only see it smear past the camera). */
  trails = true;
  constructor(pal: BirdPalette) {
    super();
    const std = (c: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color: c, flatShading: true, metalness: 0.35, roughness: 0.5, emissive: c, emissiveIntensity: 0.1, side: THREE.DoubleSide, ...o });
    const hull = std(pal.body), under = std(pal.belly), wingM = std(pal.wing), trim = std(pal.tip), dark = std(0x2a2d33, { emissiveIntensity: 0 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1a26, metalness: 0.9, roughness: 0.12, emissive: 0x1d5f80, emissiveIntensity: 0.35, flatShading: true });

    // fuselage: needle nose, swelling to the cockpit, then the engine bay
    this.add(new THREE.Mesh(loftBody([[-2.65, 0.03, 0.03, -0.02], [-1.75, 0.3, 0.22, 0], [-0.7, 0.5, 0.36, 0.04], [0.5, 0.56, 0.4, 0.02], [1.55, 0.42, 0.32, 0], [1.95, 0.3, 0.24, 0]]), hull));
    // belly keel and intakes
    this.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 2.2).translate(0, -0.42, 0.45), under));
    for (const s of [-1, 1]) this.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.9).translate(s * 0.5, -0.12, -0.35), dark));
    // canopy
    this.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0).scale(0.7, 0.55, 2.1).translate(0, 0.36, -0.75), glass));
    // wings: a cranked delta with a coloured leading-edge stripe
    for (const s of [-1, 1]) {
      const wing = plate([[0.3, -0.75], [1.15, 0.05], [2.4, 0.7], [2.4, 1.25], [0.45, 1.45]], 0.07);
      if (s < 0) wing.scale(-1, 1, 1);
      this.add(new THREE.Mesh(wing.translate(0, -0.02, 0), wingM));
      const stripe = plate([[0.32, -0.7], [1.15, 0.1], [2.38, 0.74], [2.38, 0.86], [1.12, 0.24], [0.34, -0.5]], 0.075);
      if (s < 0) stripe.scale(-1, 1, 1);
      this.add(new THREE.Mesh(stripe.translate(0, -0.015, 0), trim));
      // wingtip laser cannon: a housing and a long barrel
      this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3, 6).rotateX(Math.PI / 2).translate(s * 2.42, -0.05, 0.55), dark));
      this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.6, 5).rotateX(Math.PI / 2).translate(s * 2.42, -0.05, -0.85), dark));
      this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6).rotateX(Math.PI / 2).translate(s * 2.42, -0.05, -1.6), trim));
      // engine nacelle with a ribbed nozzle
      this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 1.7, 8).rotateX(Math.PI / 2).translate(s * NOZZLE_X, NOZZLE_Y, 1.0), hull));
      this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.22, 8, 1, true).rotateX(Math.PI / 2).translate(s * NOZZLE_X, NOZZLE_Y, 1.9), dark));
      // canted tail fin
      const fin = new THREE.Mesh(plate([[0, 0.6], [0, 1.85], [0.08, 1.85], [0.75, 1.55]], 0.05).rotateZ(Math.PI / 2), trim);
      fin.position.set(s * 0.32, 0.22, 0); fin.rotation.z = s * -0.35; fin.scale.x = s;
      this.add(fin);
      // drift flap on top of each wing root: hinged at its front edge
      const hinge = new THREE.Group();
      hinge.position.set(1.15 * s, 0.01, 0.75);
      hinge.add(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.04, 0.42).translate(0, 0.02, 0.21), wingM));
      this.flaps.push(hinge); this.add(hinge);
      // nav light: red to port, green to starboard
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(s < 0 ? 0xff2a2a : 0x2aff6a).multiplyScalar(3), toneMapped: false }));
      nav.position.set(s * 2.42, 0.06, 1.2);
      this.navs.push(nav); this.add(nav);
    }

    // engine glow: tinted by the ship's own colour so each pilot's exhaust is theirs
    const glow = new THREE.Color(pal.body).lerp(new THREE.Color(0xffffff), 0.45);
    this.trailColor = new THREE.Color(pal.tip).lerp(new THREE.Color(0xffffff), 0.3).multiplyScalar(0.7);
    const hex = glow.getHex();
    let mat = flameMats.get(hex);
    if (!mat) { mat = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(1.5), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide }); flameMats.set(hex, mat); }
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.22, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff).multiplyScalar(1.6), fog: false, toneMapped: false }));
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(flameGeo, mat);
      f.position.set(s * NOZZLE_X, NOZZLE_Y, NOZZLE_Z);
      this.flames.push(f); this.add(f);
      const c = core.clone(); c.position.set(s * NOZZLE_X, NOZZLE_Y, NOZZLE_Z - 0.02); this.add(c);
    }
  }

  /** `brake` 0..1 (a drift) lifts the flaps and cuts the engines; the flames grow with speed (boosting = long and bright). */
  animate(t: number, brake: number, speed: number) {
    const thr = THREE.MathUtils.clamp((speed - SPACE_BRAKE) / (SPACE_BOOST - SPACE_BRAKE), 0, 1);
    const boost = THREE.MathUtils.clamp((speed - SPACE_CRUISE - 4) / (SPACE_BOOST - SPACE_CRUISE - 4), 0, 1);
    const flick = 1 + Math.sin(t * 47) * 0.08 + Math.sin(t * 31) * 0.06;
    const cut = 1 - brake * 0.85; // drifting: the engines are cut
    for (const f of this.flames) f.scale.set(1 + boost * 0.5, 1 + boost * 0.5, Math.max(0.05, (0.45 + thr * 1.4 + boost * 2.6) * flick * cut));
    for (const h of this.flaps) h.rotation.x = -brake * 1.15;
    const on = (t * 1.3) % 1 < 0.08;
    for (const n of this.navs) n.visible = on;
    // engine trails (only while it's out in the world)
    if (this.trails && this.parent && this.visible && speed > 1) {
      this.updateMatrixWorld();
      const k = (0.12 + 0.12 * thr + 0.35 * boost) * cut;
      for (const f of this.flames) sfx.trail(f, this.wp.copy(f.position).setZ(NOZZLE_Z + 0.15).applyMatrix4(this.matrixWorld), this.trailColor, k, 0.14);
    }
  }
}
