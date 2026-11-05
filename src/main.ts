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
input.onSchemeChange = (sc) => { showControls(); popup(sc === 'wings' ? 'Wing sticks' : 'Classic sticks', sc === 'wings' ? 'one stick per wing' : 'left stick steers'); };
const audio = new WindAudio();
const $ = (id: string) => document.getElementById(id)!;
const hud = { score: $('score'), combo: $('combo'), skim: $('skim'), stats: $('stats'), mist: $('mist'), edge: $('edge'), overlay: $('overlay') };

const isTouch = matchMedia('(pointer: coarse)').matches;
const PAD_HELP = {
  wings: 'Controller (<b>wing sticks</b>): left stick ↑↓ = left wing, right stick ↑↓ = right wing<br>both up = dive · both down = climb · one up, one down = sharp turn<br><b>LB/RB</b> barrel roll (roll while turning = dodge) · triggers brake · <b>Back</b> = classic sticks',
  classic: 'Controller (<b>classic</b>): left stick steers, triggers brake, <b>LB/RB</b> roll (roll while turning = dodge) · <b>Back</b> = wing sticks',
};
const KEYS_HELP = '<b>W/S</b> or <b>↑/↓</b> dive / pull up &nbsp; <b>A/D</b> or <b>←/→</b> bank &nbsp; <b>Space</b> air-brake<br><b>Q/E</b> barrel roll (while banking = dodge) &nbsp; hold <b>S</b> to loop';
const showControls = () => {
  $('controls').innerHTML = isTouch ? 'Drag on the <b>left</b> side to steer (up = dive, down = pull up)<br>Hold the <b>right</b> side to air-brake<br>Swipe the right side <b>←/→</b> to barrel roll<br>Keep pulling down to loop' : `${KEYS_HELP}<br>${PAD_HELP[input.padScheme]}`;
};
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
let waterSkim = false, trickMinClear = 99, loopMinClear = 99, tunnelChain = 0, inCanyonRun = false, wasInCloud = false;
let loopBack: THREE.Vector3 | null = null;
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
  trickMinClear = 99; tunnelChain = 0; loopBack = null; wasInCloud = false;
  puffs.clear();
  // build the opening stretch straight away
  for (let i = 0; i < 10 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; i++);
  placeCamera(true);
}

function multiplier() { return 1 + Math.min(combo, 8) * 0.5; }

function addCloseCall(gap: number, label: string) {
  combo++; comboTimer = 4;
  const pts = Math.round((60 + (3.5 - gap) * 80) * multiplier());
  score += pts;
  const veryClose = gap < 1.2;
  popup(veryClose ? `INSANE! +${pts}` : `Close call +${pts}`, `${label} · ${gap.toFixed(1)} m`);
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
    popup(`Ring +${pts}`, 'speed boost'); audio.whoosh(0.5);
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
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const tmp = new THREE.Vector3();
function placeCamera(snap = false, dt = 0.016, lift = 0) {
  const g = glider;
  const flat = tmp.set(-Math.sin(g.heading), 0, -Math.cos(g.heading));
  // follow the flight path, but never so steeply that the horizon disappears
  const tilt = g.dir.clone(); tilt.y = Math.max(tilt.y, -0.4);
  const back = loopBack ?? flat.clone().lerp(tilt, 0.45).normalize();
  const dist = (loopBack ? 14 : 8.5) + Math.max(0, g.speed - 30) * 0.06;
  const want = g.pos.clone().addScaledVector(back, -dist).add(new THREE.Vector3(0, 2.6 + lift, 0));
  const ground = terrainHeight(want.x, want.z) + 1.8;
  if (want.y < ground) want.y = ground;
  const lookWant = loopBack ? g.pos.clone() : g.pos.clone().addScaledVector(g.dir, 10);
  const k = snap ? 1 : 1 - Math.exp(-7 * dt);
  camPos.lerp(want, k);
  camLook.lerp(lookWant, snap ? 1 : 1 - Math.exp(-10 * dt));
  if (snap) { camPos.copy(want); camLook.copy(lookWant); }
  camera.position.copy(camPos);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
  camera.lookAt(camLook);
  camera.rotateZ(-g.roll * 0.35);
  const fov = THREE.MathUtils.clamp(62 + (g.speed - 25) * 0.55, 60, 98);
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
    if (inp.trick && glider.startTrick(inp.trick, inp.roll)) {
      if (inp.roll * (inp.trick === 'rollL' ? -1 : 1) > 0.4) popup(inp.trick === 'rollL' ? '◀ Dodge' : 'Dodge ▶');
      trickMinClear = 99;
    }
    // wind tunnels push you along and pull you toward the middle
    const wind = gates.windAt(glider.pos);
    if (wind) {
      glider.speed = Math.min(90, glider.speed + 22 * dt);
      glider.pos.lerp(wind.axis, Math.min(1, 1.2 * dt));
      glider.pitch += (Math.asin(THREE.MathUtils.clamp(wind.dir.y, -1, 1)) - glider.pitch) * Math.min(1, 1.5 * dt);
    }
    const finished = glider.step(dt, inp);
    // hold the camera steady behind the loop instead of chasing the nose round
    if (glider.pitch > 0.9 || glider.looping) {
      if (!loopBack) { loopBack = new THREE.Vector3(-Math.sin(glider.heading), 0, -Math.cos(glider.heading)); loopMinClear = 99; }
    } else if (glider.pitch < 0.7) loopBack = null;
    const p = glider.pos;
    const ground = terrainHeight(p.x, p.z);
    clearance = p.y - ground;
    if (clearance < 0.45) { p.y = ground + 0.45; crash(); }

    // obstacles: collision + close calls
    obstaclesNear(p.x, p.z, 14, nearby);
    gates.obstacles(nearby);
    const seen = new Set<string>();
    for (const o of nearby) {
      const gap = obstacleGap(o, p.x, p.y, p.z) - 0.5; // bird radius
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
    trickMinClear = Math.min(trickMinClear, clearance);
    loopMinClear = Math.min(loopMinClear, clearance);
    if (finished && mode === 'flying') {
      const low = (finished === 'loop' ? loopMinClear : trickMinClear) < 10;
      const base = finished === 'loop' ? 400 : 150;
      const pts = Math.round(base * (low ? 3 : 1) * multiplier());
      combo++; comboTimer = 4; score += pts;
      popup(`${finished === 'loop' ? 'Loop' : 'Barrel roll'} +${pts}`, low ? 'LOW! x3' : '');
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
    glider.speed *= Math.exp(-4 * dt);
    glider.roll += dt * 6;
  } else {
    // title: gentle demo glide that hovers in place
    glider.roll = Math.sin(t * 0.6) * 0.25;
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
  bird.animate(t, glider.brake, glider.speed);

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
