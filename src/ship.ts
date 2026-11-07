import * as THREE from 'three';
import type { BirdPalette } from './bird';
import { SPACE_BRAKE, SPACE_BOOST, SPACE_CRUISE } from './space';

/** Anything that can be drawn as a flyer: a bird, or a space fighter. Faces -Z. */
export interface Craft extends THREE.Object3D {
  animate(t: number, brake: number, speed: number, tuck?: number, flap?: number): void;
}

function tris(pts: number[][], mat: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

const flameGeo = new THREE.ConeGeometry(0.22, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5); // points +Z (out the back)
const flameMats = new Map<number, THREE.MeshBasicMaterial>();

/** Low-poly space fighter: a dart-shaped hull, swept wings with tip fins, twin engines that glow brighter
 *  the harder you push them, and air-brake... well, space-brake flaps that kick up when you brake.
 *  Roughly 4.6 m long and 5 m across, about the size of a bird, so the hit boxes stay the same. */
export class ShipMesh extends THREE.Group implements Craft {
  private flames: THREE.Mesh[] = [];
  private flaps: THREE.Object3D[] = [];
  constructor(pal: BirdPalette) {
    super();
    // (a touch of self-glow so the hull still reads with the sun behind it)
    const L = (c: number) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, emissive: c, emissiveIntensity: 0.18 });
    const hull = L(pal.body), under = L(pal.belly), wingM = L(pal.wing), trim = L(pal.tip);
    const sideD = new THREE.MeshLambertMaterial({ color: pal.wing, flatShading: true, side: THREE.DoubleSide, emissive: pal.wing, emissiveIntensity: 0.18 });
    const trimD = new THREE.MeshLambertMaterial({ color: pal.tip, flatShading: true, side: THREE.DoubleSide, emissive: pal.tip, emissiveIntensity: 0.18 });

    // hull: a six-sided body tapering to a long nose
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 2.6, 6).rotateX(-Math.PI / 2).translate(0, 0, 0.2), hull);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.6, 6).rotateX(-Math.PI / 2).translate(0, 0, -1.9), hull);
    const keel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 2.4).translate(0, -0.36, 0.25), under);
    const canopy = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0).scale(0.62, 0.5, 1.5).translate(0, 0.3, -0.55),
      new THREE.MeshLambertMaterial({ color: 0x2a4a66, emissive: 0x3fc8ff, emissiveIntensity: 0.35, flatShading: true }));
    this.add(body, nose, keel, canopy);

    // swept wings, a little anhedral, with a contrasting leading edge
    for (const s of [-1, 1]) {
      this.add(tris([
        [0.3 * s, 0, -0.5], [2.45 * s, -0.12, 0.85], [0.42 * s, 0, 1.35],
        [2.45 * s, -0.12, 0.85], [2.25 * s, -0.12, 1.25], [0.42 * s, 0, 1.35],
      ], sideD));
      this.add(tris([[0.3 * s, 0.01, -0.5], [0.3 * s, 0.01, -0.15], [2.45 * s, -0.11, 0.85]], trimD));
      // tip fin
      this.add(tris([[2.35 * s, -0.12, 0.55], [2.5 * s, 0.55, 1.15], [2.32 * s, -0.12, 1.25]], trimD));
      // engine pod
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 1.5, 6).rotateX(-Math.PI / 2).translate(0.68 * s, -0.08, 1.1), trim);
      this.add(pod);
      // brake flap on top of each wing root: hinged at its front edge
      const hinge = new THREE.Group();
      hinge.position.set(1.1 * s, -0.02, 0.85);
      hinge.add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.42).translate(0, 0.02, 0.21), wingM));
      this.flaps.push(hinge); this.add(hinge);
    }
    // dorsal fin
    this.add(tris([[0, 0.3, 0.4], [0, 0.95, 1.45], [0, 0.3, 1.5]], trimD));

    // engine glow: tinted by the ship's own colour so each pilot's exhaust is theirs
    const glow = new THREE.Color(pal.body).lerp(new THREE.Color(0xffffff), 0.45).getHex();
    let mat = flameMats.get(glow);
    if (!mat) { mat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }); flameMats.set(glow, mat); }
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(flameGeo, mat);
      f.position.set(0.68 * s, -0.08, 1.85);
      this.flames.push(f); this.add(f);
    }
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.13, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
    for (const s of [-1, 1]) { const c = core.clone(); c.position.set(0.68 * s, -0.08, 1.86); this.add(c); }
  }

  /** `brake` 0..1 lifts the brake flaps; the flames grow with speed (boosting = long and bright). */
  animate(t: number, brake: number, speed: number) {
    const thr = THREE.MathUtils.clamp((speed - SPACE_BRAKE) / (SPACE_BOOST - SPACE_BRAKE), 0, 1);
    const boost = THREE.MathUtils.clamp((speed - SPACE_CRUISE - 4) / (SPACE_BOOST - SPACE_CRUISE - 4), 0, 1);
    const flick = 1 + Math.sin(t * 47) * 0.08 + Math.sin(t * 31) * 0.06;
    for (const f of this.flames) f.scale.set(1 + boost * 0.4, 1 + boost * 0.4, (0.35 + thr * 1.3 + boost * 2.2) * flick);
    for (const h of this.flaps) h.rotation.x = -brake * 1.15;
  }
}
