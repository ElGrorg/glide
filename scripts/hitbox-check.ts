import './dom-stub';
// Compares each obstacle's collision shape (obstacleGap) with the mesh that's drawn for it.
// Run: npx tsx scripts/hitbox-check.ts
import * as THREE from 'three';
import { OBSTACLE_GEO, obstacleGap, type Obstacle, type TreeKind } from '../src/world';

const ray = new THREE.Raycaster();
const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

function meshFor(o: Obstacle): THREE.Mesh {
  let g: THREE.BufferGeometry;
  if (o.type === 'tree') { g = OBSTACLE_GEO.tree[o.kind!]; q.setFromAxisAngle(up, o.tint * 6.28); m.compose(new THREE.Vector3(o.x, o.y0, o.z), q, s.setScalar(o.scale)); }
  else if (o.type === 'spire') { g = OBSTACLE_GEO.spire; q.setFromAxisAngle(up, o.tint * 6.28); m.compose(new THREE.Vector3(o.x, o.y0, o.z), q, s.set(o.r, o.top - o.y0, o.r)); }
  else { g = OBSTACLE_GEO.rock; q.setFromEuler(new THREE.Euler(o.tint * 3, o.tint * 7, o.tint * 5)); m.compose(new THREE.Vector3(o.x, o.y0, o.z), q, s.set(o.scale, o.scale * (0.7 + o.tint * 0.4), o.scale)); }
  const mesh = new THREE.Mesh(g, mat); mesh.applyMatrix4(m); mesh.updateMatrixWorld(true); return mesh;
}
/** distance from c along -dir (coming in from far out along dir) to the first surface */
function visualR(mesh: THREE.Mesh, c: THREE.Vector3, dir: THREE.Vector3, far = 60): number {
  ray.set(c.clone().addScaledVector(dir, far), dir.clone().negate());
  const h = ray.intersectObject(mesh)[0];
  return h ? far - h.distance : 0;
}
function collideR(o: Obstacle, c: THREE.Vector3, dir: THREE.Vector3, far = 60): number {
  let lo = 0, hi = far;
  if (obstacleGap(o, c.x, c.y, c.z) > 0) { // the axis itself is outside (eg above a tree): no hit
    for (let d = 0; d < far; d += 0.05) { const p = c.clone().addScaledVector(dir, d); if (obstacleGap(o, p.x, p.y, p.z) <= 0) return -1; }
    return 0;
  }
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; const p = c.clone().addScaledVector(dir, mid); if (obstacleGap(o, p.x, p.y, p.z) > 0) hi = mid; else lo = mid; }
  return lo;
}

const report = (name: string, o: Obstacle) => {
  const mesh = meshFor(o);
  console.log(`\n== ${name}  (r ${o.r.toFixed(2)}, y0 ${o.y0.toFixed(1)}, top ${o.top.toFixed(1)})`);
  console.log(' height   drawn min..max   hitbox   hitbox-drawnMax');
  if (o.type === 'rock') {
    const c = new THREE.Vector3(o.x, o.y0, o.z);
    for (const [lbl, d] of [['side', [1, 0, 0]], ['side2', [0, 0, 1]], ['up', [0, 1, 0]], ['down', [0, -1, 0]], ['diag', [1, 1, 0]]] as const) {
      const v = new THREE.Vector3(...d).normalize();
      let mn = 99, mx = 0;
      for (let a = 0; a < 24; a++) { const w = v.clone().applyAxisAngle(up, (a / 24) * Math.PI * 2); const r = visualR(mesh, c, w); mn = Math.min(mn, r); mx = Math.max(mx, r); }
      const cr = collideR(o, c, v);
      console.log(`  ${lbl.padEnd(6)} ${mn.toFixed(2).padStart(6)}..${mx.toFixed(2).padEnd(6)}  ${cr.toFixed(2).padStart(6)}   ${(cr - mx >= 0 ? '+' : '') + (cr - mx).toFixed(2)}`);
    }
    return;
  }
  const H = o.top - o.y0;
  for (let i = 0; i <= 10; i++) {
    const y = o.y0 + H * (i / 10) * 0.999 + 0.0005;
    const c = new THREE.Vector3(o.x, y, o.z);
    let mn = 99, mx = 0;
    for (let a = 0; a < 72; a++) { const w = new THREE.Vector3(Math.cos(a / 72 * 6.283), 0, Math.sin(a / 72 * 6.283)); const r = visualR(mesh, c, w); mn = Math.min(mn, r); mx = Math.max(mx, r); }
    const cr = collideR(o, c, new THREE.Vector3(1, 0, 0));
    console.log(`  ${(i * 10 + '%').padStart(4)}   ${mn.toFixed(2).padStart(6)}..${mx.toFixed(2).padEnd(6)}  ${cr.toFixed(2).padStart(6)}   ${(cr - mx >= 0 ? '+' : '') + (cr - mx).toFixed(2)}`);
  }
  // above the top: how far up does the hitbox reach?
  const c = new THREE.Vector3(o.x, o.top, o.z);
  console.log(`  drawn top ${visualR(mesh, new THREE.Vector3(o.x, o.y0, o.z), up, 200).toFixed(2)} above base, hitbox top ${(collideR(o, new THREE.Vector3(o.x, o.y0 + 0.01, o.z), up, 200) + 0.01).toFixed(2)} above base`);
  void c;
};

const SH: Record<TreeKind, { h: number; r: number }> = { pine: { h: 8, r: 2.3 }, round: { h: 7.4, r: 2.8 }, cactus: { h: 5.5, r: 1.0 }, snowpine: { h: 9, r: 2.1 } };
for (const kind of ['pine', 'snowpine', 'round', 'cactus'] as TreeKind[]) {
  const scale = 1.5, sh = SH[kind];
  report(`tree ${kind} x${scale}`, { id: 't', type: 'tree', kind, x: 0, z: 0, y0: 0, top: sh.h * scale, r: sh.r * scale, scale, tint: 0.3 });
}
report('spire r6', { id: 's', type: 'spire', x: 0, z: 0, y0: 0, top: 50, r: 6, scale: 1, tint: 0.3 });
for (const tint of [0.05, 0.5, 0.95]) report(`rock scale 4 tint ${tint}`, { id: 'r', type: 'rock', x: 0, z: 0, y0: 0, top: 4.8, r: 4, scale: 4, tint });
