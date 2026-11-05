import * as THREE from 'three';
import { World, riverAt, terrainHeight, obstaclesNear, obstacleGap, canyonAt, basePlane, nearestBranch, CANYON_RIM, SKY_COLOR, FOG_FAR, type Obstacle } from './world';
import { route, BIOME_NAME } from './route';
import { CloudPuffs } from './puffs';
import { Gates, type GateEvent } from './gates';
import { BirdMesh, Glider } from './bird';
import { Input } from './input';
import { WindAudio } from './audio';

// ---------- Renderer, scene, camera ----------
const SKY = new THREE.Color(0x9fd3f0);
const container = document.getElementById('game')!;
const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 2, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 140, 640);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 900);
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xdff0ff, 0x5d7040, 2.0));
const sun = new THREE.DirectionalLight(0xfff0d0, 2.4);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);

// gradient sky dome that follows the camera
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(850, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x4f9fe0) }, bottom: { value: SKY } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float t = smoothstep(-0.05, 0.6, vP.y); gl_FragColor = vec4(mix(bottom, top, t), 1.); }',
  }),
);
sky.renderOrder = -1;
scene.add(sky);

// ---------- World + bird ----------
const world = new World(scene, 4);
const gates = new Gates(scene);
const puffs = new CloudPuffs(scene);
const skyNow = SKY.clone();
const skyMat = () => (sky.material as THREE.ShaderMaterial).uniforms.bottom.value as THREE.Color;
const glider = new Glider();
const bird = new BirdMesh();
scene.add(bird);

// soft blob shadow: makes height above ground easy to read
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x1d2a18, transparent: true, opacity: 0.35, depthWrite: false }),
);
shadow.renderOrder = 1;
scene.add(shadow);

// speed streaks attached to the camera
const STREAKS = 70;
const streakPos = new Float32Array(STREAKS * 6);
const streakSeeds: THREE.Vector3[] = [];
for (let i = 0; i < STREAKS; i++) {
  const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 6;
  streakSeeds.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.7, -Math.random() * 40));
}
const streakGeo = new THREE.BufferGeometry();
streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
const streakMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false });
const streaks = new THREE.LineSegments(streakGeo, streakMat);
streaks.frustumCulled = false;
camera.add(streaks);

// ---------- Input, audio, HUD ----------
const input = new Input(document);
const audio = new WindAudio();
const $ = (id: string) => document.getElementById(id)!;
const hud = { flaps: $('flaps'), score: $('score'), combo: $('combo'), skim: $('skim'), stats: $('stats'), mist: $('mist'), edge: $('edge'), overlay: $('overlay') };

const isTouch = matchMedia('(pointer: coarse)').matches;
const hasPad = () => Array.from(navigator.getGamepads?.() ?? []).some(Boolean);
const CONTROLS = {
  touch: '<b>Left thumb</b>: roll and pitch (up = dive, down = pull up)<br><b>Right thumb</b>: drag down = tuck, up = flare, sideways = yaw<br>Tap right = flap · swipe right side ←/→ = snap roll',
  keys: '<b>W/S</b> dive / pull up · <b>A/D</b> roll · <b>←/→</b> yaw<br><b>Shift</b> or <b>↑</b> tuck · <b>↓</b> flare · <b>Space</b> flap · <b>Q/E</b> snap roll',
  pad: '<b>Left stick</b>: roll and pitch · <b>Right stick</b>: yaw ←/→, tuck ↓, flare ↑<br><b>RT</b> tuck · <b>LT</b> flare · <b>A</b> flap · <b>LB/RB</b> snap roll',
};
const tip = '<br><small>Roll over and pull to carve a hard turn. Keep pulling to loop. Tuck to dive and slip through gaps.</small>';
const showControls = () => { $('controls').innerHTML = (isTouch ? CONTROLS.touch : hasPad() ? CONTROLS.pad : CONTROLS.keys + '<br>' + CONTROLS.pad) + tip; };
showControls();
addEventListener('gamepadconnected', showControls);
$('go').textContent = isTouch ? 'Tap to glide' : 'Press any key or button to glide';

let best = 0;
try { best = Number(localStorage.getItem('glide.best') || 0); } catch { /* storage unavailable */ }

function popup(text: string, sub = '') {
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function rumble(strength: number, ms: number) {
  const gp = navigator.getGamepads?.()[0] as any;
  gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
}

// ---------- Game state ----------
type Mode = 'title' | 'flying' | 'crashed';
let mode: Mode = 'title';
let score = 0, combo = 0, comboTimer = 0, slowmo = 0, crashTimer = 0, shake = 0;
let startZ = 0;
const near = new Map<string, { gap: number; type: string }>(); // obstacle id -> closest gap while passing
const prevPos = new THREE.Vector3();
let waterSkim = false, recentLow = 99, tunnelChain = 0, inCanyonRun = false, wasInCloud = false;
const camBack = new THREE.Vector3(0, 0, -1);
const tipPts: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
const cloudsHit = new Set<string>();
const nearby: Obstacle[] = [];

function spawn(fresh = true) {
  if (fresh) { route.reset(); world.reset(); }
  const z = 0, x = route.mainCenter(z);
  glider.reset(x, terrainHeight(x, z) + 45, z, 0);
  startZ = z;
  score = 0; combo = 0; comboTimer = 0; slowmo = 0; shake = 0;
  near.clear(); cloudsHit.clear();
  gates.reset(); gates.update(glider.pos.z, 0);
  prevPos.copy(glider.pos);
  recentLow = 99; tunnelChain = 0; wasInCloud = false;
  puffs.clear();
  // build the opening stretch straight away
  for (let i = 0; i < 10 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; i++);
  placeCamera(true);
}

function multiplier() { return 1 + Math.min(combo, 8) * 0.5; }

function addCloseCall(gap: number, label: string) {
  combo++; comboTimer = 4;
  // style bonus: slipping past on a knife-edge, upside down, or tucked into a dart
  const style = glider.inverted ? 'inverted' : Math.abs(glider.roll) > 1.15 ? 'knife-edge' : glider.tuck > 0.6 ? 'tucked' : '';
  const pts = Math.round((60 + (3.5 - gap) * 80) * multiplier() * (style ? 2 : 1));
  score += pts;
  const veryClose = gap < 1.2;
  popup(veryClose ? `INSANE! +${pts}` : `Close call +${pts}`, `${label} · ${gap.toFixed(1)} m${style ? ` · ${style} x2` : ''}`);
  audio.whoosh(veryClose ? 1 : 0.6);
  rumble(veryClose ? 0.8 : 0.4, 120);
  if (veryClose) slowmo = 0.5;
}

function onGate(e: GateEvent) {
  if (e.type === 'tunnel') {
    if (!e.hit) { if (tunnelChain > 0) popup('Tunnel broken'); tunnelChain = 0; return; }
    tunnelChain++;
    const pts = Math.round(30 * tunnelChain * multiplier());
    score += pts; comboTimer = 4;
    audio.whoosh(0.35);
    if (e.index === e.total - 1) {
      const full = tunnelChain === e.total;
      const bonus = Math.round((full ? 500 : 150) * multiplier());
      score += bonus; combo++;
      popup(full ? `Wind tunnel! +${bonus}` : `Tunnel +${bonus}`, full ? 'every ring' : `${tunnelChain}/${e.total} rings`);
      tunnelChain = 0;
    }
    return;
  }
  if (!e.hit) return;
  combo++; comboTimer = 4;
  if (e.type === 'ring') {
    const pts = Math.round(80 * multiplier());
    score += pts; glider.speed = Math.min(90, glider.speed + 8);
    glider.flapCharge = Math.min(3, glider.flapCharge + 1);
    popup(`Ring +${pts}`, 'speed boost · +1 flap'); audio.whoosh(0.5);
  } else {
    const pts = Math.round((e.type === 'needle' ? 350 : 300) * multiplier());
    score += pts; glider.speed = Math.min(90, glider.speed + 5);
    popup(`${e.type === 'needle' ? 'Thread the needle' : 'Under the arch'} +${pts}`); audio.whoosh(1); rumble(0.5, 120);
  }
}

function crash() {
  mode = 'crashed'; crashTimer = 0; shake = 1;
  audio.thud(); rumble(1, 300);
  const final = Math.floor(score);
  const isBest = final > best;
  if (isBest) { best = final; try { localStorage.setItem('glide.best', String(best)); } catch { /* ignore */ } }
  const dist = Math.round(startZ - glider.pos.z);
  hud.overlay.innerHTML = `<div><h1>Crunch!</h1><p><b>${final}</b> points · ${dist} m downhill</p><p>${isBest ? 'New best!' : `Best: ${best}`}</p><div class="go">${isTouch ? 'Tap to fly again' : 'Press any key or button to fly again'}</div></div>`;
  setTimeout(() => { if (mode === 'crashed') hud.overlay.classList.remove('hidden'); }, 700);
}

// ---------- Camera ----------
// Chases the flight path, stays upright when you're upside down, and holds its
// heading through loops so the horizon never spins away.
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
function placeCamera(snap = false, dt = 0.016, lift = 0) {
  const g = glider;
  const speed = Math.max(1, g.speed);
  const vdir = g.vel.clone().divideScalar(speed);
  const vh = new THREE.Vector3(g.vel.x, 0, g.vel.z);
  const steep = vh.length() < speed * 0.4;
  if (snap) camBack.set(g.dir.x, 0, g.dir.z).normalize();
  else if (!steep) camBack.lerp(vh.normalize(), 1 - Math.exp(-4 * dt)).normalize();
  const back = camBack.clone().add(new THREE.Vector3(0, THREE.MathUtils.clamp(vdir.y, -0.45, 0.25), 0)).normalize();
  const dist = 8.5 + Math.max(0, speed - 30) * 0.06 + (steep ? 5 : 0);
  const want = g.pos.clone().addScaledVector(back, -dist).add(new THREE.Vector3(0, 2.6 + lift, 0));
  const ground = terrainHeight(want.x, want.z) + 1.8;
  if (want.y < ground) want.y = ground;
  const lookWant = steep ? g.pos.clone() : g.pos.clone().addScaledVector(vdir, 9);
  const k = snap ? 1 : 1 - Math.exp(-7 * dt);
  camPos.lerp(want, k);
  camLook.lerp(lookWant, snap ? 1 : 1 - Math.exp(-10 * dt));
  if (snap) { camPos.copy(want); camLook.copy(lookWant); }
  camera.position.copy(camPos);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
  camera.lookAt(camLook);
  if (!g.inverted) camera.rotateZ(-g.roll * 0.3);
  const fov = THREE.MathUtils.clamp(62 + (speed - 25) * 0.5 + g.tuck * 6, 60, 100);
  camera.fov += (fov - camera.fov) * Math.min(1, 3 * dt);
  camera.updateProjectionMatrix();
}

// ---------- Main loop ----------
let last = performance.now();
let t = 0;
spawn(false);

function frame(now: number) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const inp = input.poll();

  if (inp.anyPress) audio.start();
  if (mode === 'title' && inp.anyPress) { mode = 'flying'; hud.overlay.classList.add('hidden'); }
  else if (mode === 'crashed' && inp.anyPress && crashTimer > 0.8) { spawn(); mode = 'flying'; hud.overlay.classList.add('hidden'); }

  if (slowmo > 0) { slowmo -= dt; dt *= 0.35; }
  t += dt;

  let mist = 0, clearance = 99;
  if (mode === 'flying') {
    prevPos.copy(glider.pos);
    // wind tunnels push you along and pull you toward the middle
    const wind = gates.windAt(glider.pos);
    if (wind) {
      glider.vel.addScaledVector(wind.dir, 22 * dt);
      glider.pos.lerp(wind.axis, Math.min(1, 1.2 * dt));
    }
    const fev = glider.step(dt, inp);
    if (fev.flap) audio.whoosh(0.3);
    const p = glider.pos;
    // body and both wingtips can touch the ground: knife-edge or tuck to squeeze through
    glider.tips(tipPts);
    const ground = terrainHeight(p.x, p.z);
    clearance = Math.min(p.y - ground, ...tipPts.map((tp) => tp.y - terrainHeight(tp.x, tp.z) + 0.3));
    if (p.y - ground < 0.45) { p.y = ground + 0.45; crash(); }
    else if (clearance < 0.05) crash();

    // obstacles: collision + close calls (wingtips count too)
    obstaclesNear(p.x, p.z, 16, nearby);
    gates.obstacles(nearby);
    const seen = new Set<string>();
    for (const o of nearby) {
      const gap = Math.min(
        obstacleGap(o, p.x, p.y, p.z) - 0.5,
        ...tipPts.map((tp) => obstacleGap(o, tp.x, tp.y, tp.z) - 0.15),
      );
      if (gap < 0 && mode === 'flying') { crash(); break; }
      if (gap < 6) {
        seen.add(o.id);
        const prev = near.get(o.id);
        near.set(o.id, { gap: prev === undefined ? gap : Math.min(prev.gap, gap), type: o.type });
      }
    }
    if (mode === 'flying') for (const [id, nr] of near) {
      if (!seen.has(id)) {
        near.delete(id);
        if (nr.gap < 3.5) addCloseCall(nr.gap, nr.type);
      }
    }

    // tricks: score when they land, worth triple if pulled off low
    recentLow = Math.min(recentLow + dt * 4, clearance); // lowest clearance over the last few seconds
    const trick = fev.loop ? (fev.loop > 0 ? 'Loop' : 'Outside loop') : fev.roll ? 'Aileron roll' : fev.snap ? 'Snap roll' : '';
    if (trick && mode === 'flying') {
      const low = recentLow < 10;
      const base = fev.loop ? (fev.loop > 0 ? 400 : 650) : fev.roll ? 200 : 60;
      const pts = Math.round(base * (low ? 3 : 1) * multiplier());
      combo++; comboTimer = 4; score += pts;
      popup(`${trick} +${pts}`, low ? 'LOW! x3' : '');
      audio.whoosh(0.7);
    }

    // gates
    gates.check(prevPos, p, (e: GateEvent) => onGate(e));

    // canyon run: stay below the rim for a steady bonus
    const c = canyonAt(p.x, p.z);
    inCanyonRun = c > 0.6 && p.y < basePlane(p.z) + CANYON_RIM * c - 8;
    if (inCanyonRun) { score += dt * 25 * multiplier(); comboTimer = Math.max(comboTimer, 1.5); }

    // forks: announce the choices, then lock in whichever valley you're in
    const ev = route.update(p.x, p.z);
    if (ev.announce) {
      const arrows = ev.announce.branches.length === 3 ? ['←', '↑', '→'] : ['←', '→'];
      popup('Fork ahead', ev.announce.branches.map((b, i) => `${arrows[i]} ${BIOME_NAME[b.biome]}${b.canyon ? ' canyon' : ''}`).join(' · '));
    }
    if (ev.committed) { score += Math.round(100 * multiplier()); popup(BIOME_NAME[ev.committed.biome], ev.committed.canyon ? 'canyon run ahead: stay below the rim' : 'new territory +100'); }

    // skimming a river throws up spray and pays extra
    const onWater = riverAt(p.x, p.z) > 0.5 && clearance < 5 && mode === 'flying';
    if (onWater) {
      score += dt * (5 - clearance) * glider.speed * 0.25 * multiplier();
      const n = Math.ceil(50 * dt * (5 - clearance));
      const wp = new THREE.Vector3(p.x, terrainHeight(p.x, p.z) + 0.3, p.z);
      for (let i = 0; i < n; i++) puffs.burst(wp, glider.vel.clone().multiplyScalar(0.15).setY(4), 3, 1, 0.5);
    }
    waterSkim = onWater;
    // ground skim
    if (clearance < 5 && mode === 'flying') {
      score += dt * (5 - clearance) * glider.speed * 0.35 * multiplier();
      comboTimer = Math.max(comboTimer, 1.5);
    }

    // clouds
    const cd = world.cloudDepth(p.x, p.y, p.z);
    mist = cd.depth;
    const inCloud = cd.depth > 0.02;
    if (inCloud && !wasInCloud) {
      // punch in: a burst blown back around you
      puffs.ring(p, glider.dir, glider.vel.clone().multiplyScalar(0.1), 12, 30, 1.4);
      shake = Math.max(shake, 0.35); camera.fov += 6;
    } else if (inCloud) {
      // tunnel through: cloud spews out behind you
      const n = Math.ceil(90 * dt);
      for (let i = 0; i < n; i++) puffs.burst(p.clone().addScaledVector(glider.dir, -1.5), glider.vel.clone().multiplyScalar(0.25), 7, 1, 1.0);
    } else if (wasInCloud) {
      // punch out: cloud explodes out after you
      puffs.ring(p, glider.dir, glider.vel.clone().multiplyScalar(0.3), 16, 44, 1.5);
      shake = Math.max(shake, 0.25); camera.fov += 8; audio.whoosh(0.8);
    }
    wasInCloud = inCloud;
    if (cd.id && cd.depth > 0.15 && !cloudsHit.has(cd.id)) {
      cloudsHit.add(cd.id);
      const pts = Math.round(40 * multiplier());
      score += pts; popup(`Cloud punch +${pts}`); audio.whoosh(0.4);
    }

    // distance score
    score += Math.max(0, -glider.vel.z) * dt * 0.1;

    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;
  } else if (mode === 'crashed') {
    crashTimer += dt;
    glider.vel.multiplyScalar(Math.exp(-4 * dt));
  } else {
    // title: gentle demo glide that hovers in place
    // title: hover in place
  }
  shake = Math.max(0, shake - dt * 2);
  puffs.update(dt, camera.position);

  // sky and fog shift with the environment you're flying through
  {
    const nb = nearestBranch(glider.pos.x, glider.pos.z);
    const target = SKY_COLOR[nb.parent].clone().lerp(SKY_COLOR[nb.biome], nb.t);
    skyNow.lerp(target, Math.min(1, dt * 0.8));
    (scene.fog as THREE.Fog).color.copy(skyNow);
    skyMat().copy(skyNow);
    const far = FOG_FAR[nb.parent] + (FOG_FAR[nb.biome] - FOG_FAR[nb.parent]) * nb.t;
    const fog = scene.fog as THREE.Fog;
    fog.far += (far - fog.far) * Math.min(1, dt * 0.8);
    fog.near = fog.far * 0.22;
  }

  glider.applyTo(bird);
  if (mode === 'crashed') bird.rotateZ(crashTimer * 6);
  if (mode === 'title') bird.rotateZ(Math.sin(t * 0.6) * 0.25);
  bird.animate(t, glider.brake, glider.speed, glider.tuck, glider.flapAnim);
  hud.flaps.textContent = mode === 'flying' ? '▲'.repeat(Math.floor(glider.flapCharge)) + '△'.repeat(3 - Math.floor(glider.flapCharge)) : '';

  // shadow
  const gp = glider.pos;
  const gy = terrainHeight(gp.x, gp.z);
  const h = gp.y - gy;
  shadow.position.set(gp.x, gy + 0.35, gp.z);
  shadow.scale.setScalar(1.3 + h * 0.03);
  (shadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.5 - h * 0.012, 0, 0.5);

  // stream terrain ahead of the bird
  world.update(gp.x + glider.dir.x * 180, gp.z + glider.dir.z * 180, 2);
  gates.update(gp.z, t);

  placeCamera(false, dt, mode === 'crashed' ? Math.min(10, crashTimer * 8) : 0);
  sky.position.copy(camera.position);

  // streaks
  const sp = THREE.MathUtils.clamp((glider.speed - 30) / 35, 0, 1);
  streakMat.opacity = mode === 'flying' ? sp * 0.55 : 0;
  if (streakMat.opacity > 0) {
    for (let i = 0; i < STREAKS; i++) {
      const s = streakSeeds[i];
      s.z += glider.speed * dt * 1.2;
      if (s.z > 0) s.z -= 40;
      const len = 1 + sp * 4;
      streakPos.set([s.x, s.y, s.z, s.x, s.y, s.z - len], i * 6);
    }
    streakGeo.attributes.position.needsUpdate = true;
  }

  // HUD
  hud.mist.style.opacity = String(Math.min(0.9, mist * 2.2));
  const danger = mode === 'flying' ? THREE.MathUtils.clamp((5 - clearance) / 5, 0, 1) : 0;
  hud.edge.style.opacity = String(danger * 0.7);
  hud.skim.textContent = danger > 0 ? (waterSkim ? 'WATER SKIM' : 'SKIM') : 'CANYON RUN';
  hud.skim.style.opacity = String(danger > 0 ? 0.6 + danger * 0.4 : inCanyonRun && mode === 'flying' ? 0.7 : 0);
  hud.score.textContent = mode === 'title' ? '' : String(Math.floor(score));
  hud.combo.style.opacity = combo > 0 && mode === 'flying' ? '1' : '0';
  hud.combo.textContent = `combo x${multiplier().toFixed(1)}`;
  hud.stats.textContent = mode === 'flying'
    ? `${Math.round(glider.speed * 3.6)} km/h · ${Math.max(0, Math.round(clearance))} m up · ${Math.round(startZ - gp.z)} m`
    : '';
  audio.update(glider.speed, mist, mode === 'flying');

  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
(window as any).__glide = { glider, world, gates, get mode() { return mode; }, get score() { return score; }, canyonAt, terrainHeight, route, riverAt };
