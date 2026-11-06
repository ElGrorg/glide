import * as THREE from 'three';
import { World, riverAt, terrainHeight, obstaclesNear, obstacleGap, canyonAt, basePlane, nearestBranch, CANYON_RIM, SKY_COLOR, FOG_FAR, ARENAS, ARENA_R, setArena, getArena, type Obstacle } from './world';
import { route, BIOME_NAME } from './route';
import { CloudPuffs } from './puffs';
import { Gates, type GateEvent } from './gates';
import { BirdMesh, Glider } from './bird';
import { Input } from './input';
import { WindAudio } from './audio';
import { Dogfight, MAX_DARTS, flapAmount, type DogfightEvent } from './dogfight';
import { setWorldSeed } from './noise';

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
const dogfight = new Dogfight(scene, puffs);
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
const LAYOUT_NAMES = { flight: ['Flight sticks', 'left stick pitches, right stick rolls'], classic: ['Classic', 'one stick steers'], wings: ['Wing sticks', 'one stick per wing'] } as const;
input.onSchemeChange = (sc) => { showControlsSafe(); popup(LAYOUT_NAMES[sc][0], LAYOUT_NAMES[sc][1]); };
const audio = new WindAudio();
const $ = (id: string) => document.getElementById(id)!;
const hud = { wave: $('wave'), hp: $('hp'), warn: $('warn'), score: $('score'), combo: $('combo'), skim: $('skim'), stats: $('stats'), darts: $('darts'), mist: $('mist'), edge: $('edge'), overlay: $('overlay') };

const isTouch = matchMedia('(pointer: coarse)').matches;
const PAD_HELP = {
  flight: 'Controller (<b>flight sticks</b>): left stick ↑↓ = dive / pull up · right stick ←→ = roll, both all the way round (bank holds when you let go)<br><b>RT</b>/<b>X</b> shoot · <b>Y</b> homing dart · <b>LT</b>/<b>A</b> brake · <b>Back</b> = next layout',
  classic: 'Controller (<b>classic</b>): left stick steers, <b>RT</b>/<b>X</b> shoot, <b>Y</b> homing dart, <b>LT</b>/<b>A</b> brake · <b>Back</b> = next layout',
  wings: 'Controller (<b>wing sticks</b>): left stick ↑↓ = left wing, right stick ↑↓ = right wing<br>both up = dive · both down = climb · one up, one down = sharp turn<br><b>RT</b>/<b>X</b> shoot · <b>Y</b> homing dart · <b>LT</b>/<b>A</b> brake · <b>Back</b> = next layout',
};
const KEYS_HELP = () => `<b>W/S</b> or <b>↑/↓</b> dive / pull up &nbsp; <b>A/D</b> or <b>←/→</b> ${input.padScheme === 'flight' ? 'roll (bank holds)' : 'bank'} &nbsp; <b>Z/C</b> rudder &nbsp; <b>Space</b> air-brake &nbsp; <b>F</b> or click = shoot &nbsp; <b>R</b> or right-click = homing dart (hold your nose on a bird for 1 s to lock)<br>hold <b>S</b> to loop &nbsp; <b>V</b> = change layout`;
const TOUCH_HELP = () => input.padScheme === 'flight'
  ? 'Left thumb: drag up to dive, down to pull up<br>Right thumb: drag ←→ to roll, all the way round if you like (the bank holds when you let go)<br>Hold <b>FIRE</b> to shoot<br>Hold your nose on a bird to lock, then tap <b>DART</b><br>Keep pulling down to loop'
  : 'Drag on the <b>left</b> side to steer (up = dive, down = pull up)<br>Hold the <b>right</b> side to air-brake<br>Hold <b>FIRE</b> to shoot<br>Hold your nose on a bird to lock, then tap <b>DART</b><br>Keep pulling down to loop';
const showControls = () => {
  $('controls').innerHTML = isTouch ? TOUCH_HELP() : `${KEYS_HELP()}<br>${PAD_HELP[input.padScheme]}`;
};
const showControlsSafe = () => { if (document.getElementById('controls')) showControls(); };
addEventListener('gamepadconnected', showControlsSafe);
if (isTouch) { $('fire').style.display = 'flex'; $('dartBtn').style.display = 'flex'; }

// ---------- Game settings: endless downhill or arena ----------
type GameMode = 'endless' | 'arena';
const settings = { mode: 'endless' as GameMode, env: ARENAS.length /* = random */, enemies: 3 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('glide.settings') || '{}')); } catch { /* storage unavailable */ }
settings.env = THREE.MathUtils.clamp(Math.round(settings.env) || 0, 0, ARENAS.length);
settings.enemies = THREE.MathUtils.clamp(Math.round(settings.enemies) || 3, 1, 12);
const saveSettings = () => { try { localStorage.setItem('glide.settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const bestKey = () => (settings.mode === 'arena' ? 'glide.best.arena' : 'glide.best');
let best = 0;
const loadBest = () => { try { best = Number(localStorage.getItem(bestKey()) || 0); } catch { best = 0; } };
loadBest();
/** The arena chosen for this match ("random" rolls one per match). */
let arenaIdx = 0;

const MENU_ROWS = ['mode', 'env', 'enemies', 'go'] as const;
let menuRow = 3;
function menuRows() { return settings.mode === 'arena' ? MENU_ROWS : (['mode', 'go'] as const); }
function renderMenu() {
  const rows = menuRows() as readonly string[];
  if (!rows.includes(MENU_ROWS[menuRow])) menuRow = 3;
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const envName = settings.env === ARENAS.length ? 'Random' : ARENAS[settings.env].name;
  const envBlurb = settings.env === ARENAS.length ? 'a different arena every match' : ARENAS[settings.env].blurb;
  const arena = settings.mode === 'arena';
  hud.overlay.innerHTML = `<div class="menu">
    <h1>Glide!</h1>
    <div class="row${sel('mode')}"><button data-act="mode:endless" class="${!arena ? 'on' : ''}">Endless downhill</button><button data-act="mode:arena" class="${arena ? 'on' : ''}">Arena</button></div>
    <p class="blurb">${arena
      ? 'A walled-in basin to fight in. You flap to hold your speed, so the ground doesn\'t have to fall away: climbing still costs speed and diving still builds it. Clear a wave and the next one comes in.'
      : 'An endless mountainside. Skim the ground, thread the trees, punch through the clouds, and shoot down the birds hunting you.'}</p>
    ${arena ? `<div class="row pick${sel('env')}"><span class="lab">Arena</span><button data-act="env:-1">◀</button><b>${envName}</b><button data-act="env:1">▶</button></div>
    <p class="blurb small">${envBlurb}</p>
    <div class="row pick${sel('enemies')}"><span class="lab">Enemies</span><button data-act="enemies:-1">◀</button><b>${settings.enemies}</b><button data-act="enemies:1">▶</button></div>` : ''}
    <div class="row${sel('go')}"><button data-act="go" class="go-btn">Fly!</button></div>
    <div class="controls" id="controls"></div>
    <p class="hint">${isTouch ? 'Tap to choose' : '↑↓ choose · ←→ change · Enter / A to fly'}</p>
  </div>`;
  showControls();
}
let previewTimer = 0;
/** Rebuild the world behind the title so it shows the chosen mode / arena. */
function queuePreview() { clearTimeout(previewTimer); previewTimer = window.setTimeout(() => { if (mode === 'title') spawn(true); }, 220); }
function menuChange(row: string, d: number) {
  if (row === 'mode') { const m: GameMode = d < 0 ? 'endless' : 'arena'; if (m !== settings.mode) { settings.mode = m; loadBest(); queuePreview(); } }
  else if (row === 'env') { settings.env = (settings.env + d + ARENAS.length + 1) % (ARENAS.length + 1); queuePreview(); }
  else if (row === 'enemies') settings.enemies = THREE.MathUtils.clamp(settings.enemies + d, 1, 12);
  saveSettings(); renderMenu();
}
let startReq = false, menuReq = false;
hud.overlay.addEventListener('pointerdown', (e) => {
  const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
  if (!act) return;
  audio.start();
  const [k, v] = act.split(':');
  if (k === 'go') startReq = true;
  else if (k === 'menu') menuReq = true;
  else if (k === 'mode') { menuRow = 0; menuChange('mode', v === 'arena' ? 1 : -1); }
  else { menuRow = MENU_ROWS.indexOf(k as typeof MENU_ROWS[number]); menuChange(k, Number(v)); }
});
function goToMenu() {
  mode = 'title';
  spawn(true);
  renderMenu();
  hud.overlay.classList.remove('hidden');
}

// Pop-up announcements (forks ahead, new enemy, close call +pts, ...) are switched off: the screen stays
// clean. Lock-on reticles, the dart / stall warning bar, the score and the dart counter still show.
const SHOW_POPUPS = false;
function popup(text: string, sub = '') {
  if (!SHOW_POPUPS) return;
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
let inLoop = false;
let waveClearedT = 0, outOfBounds = 0;
let hp = 3, hpRegen = 0, hitFlash = 0, dodgeCd = 0, warnBeep = 0, dartHint = 0;
let wasLocked: unknown = null;
const cloudsHit = new Set<string>();
const nearby: Obstacle[] = [];

function spawn(fresh = true) {
  const arena = settings.mode === 'arena';
  // "random" rolls a new arena each fresh match
  if (arena) arenaIdx = settings.env < ARENAS.length ? settings.env : fresh || !getArena() ? Math.floor(Math.random() * ARENAS.length) : arenaIdx;
  const arenaChanged = (arena ? ARENAS[arenaIdx] : null) !== getArena();
  setArena(arena ? ARENAS[arenaIdx] : null);
  if (fresh || arenaChanged) { setWorldSeed((Math.random() * 2 ** 31) | 0); route.reset(); world.reset(); }
  if (arena) {
    // fly in from the south side of the basin, toward the middle
    const z = ARENA_R * 0.7;
    let ground = 0;
    for (let d = 0; d <= 200; d += 20) ground = Math.max(ground, terrainHeight(0, z - d));
    glider.reset(0, ground + 50, z, 0);
  } else {
    const z = 0, x = route.mainCenter(z);
    glider.reset(x, terrainHeight(x, z) + 45, z, 0);
  }
  const z = glider.pos.z;
  startZ = z;
  score = 0; combo = 0; comboTimer = 0; slowmo = 0; shake = 0;
  near.clear(); cloudsHit.clear();
  gates.reset(); gates.update(glider.pos.z, 0);
  prevPos.copy(glider.pos);
  trickMinClear = 99; tunnelChain = 0; inLoop = false; wasInCloud = false;
  puffs.clear();
  dogfight.reset(); hp = 3; hpRegen = 0; hitFlash = 0;
  dogfight.arenaCount = arena ? settings.enemies : 0;
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
  // flying dangerously pays: a slipstream speed kick and a chunk of dart recharge, more the closer you cut it
  const kick = veryClose ? 7 : 3 + (3.5 - gap) * 1.2;
  glider.speed = Math.min(95, glider.speed + kick);
  const refilled = dogfight.chargeDart(veryClose ? 0.5 : 0.25);
  const perks = `+${Math.round(kick * 3.6)} km/h${refilled ? ' · DART RELOADED' : ''}`;
  popup(veryClose ? `INSANE! +${pts}` : `Close call +${pts}`, `${label} · ${gap.toFixed(1)} m · ${perks}`);
  if (refilled) audio.beep(1600, 0.1, 0.07);
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

function crash(title = 'Crunch!') {
  mode = 'crashed'; crashTimer = 0; shake = 1;
  audio.thud(); rumble(1, 300);
  const final = Math.floor(score);
  const isBest = final > best;
  if (isBest) { best = final; try { localStorage.setItem(bestKey(), String(best)); } catch { /* ignore */ } }
  const dist = Math.round(startZ - glider.pos.z);
  const what = getArena()
    ? `${getArena()!.name} · wave ${Math.max(1, dogfight.wave)} · ${dogfight.kills} shot down`
    : `${dist} m downhill${dogfight.kills ? ` · ${dogfight.kills} shot down` : ''}`;
  hud.overlay.innerHTML = `<div><h1>${title}</h1><p><b>${final}</b> points · ${what}</p><p>${isBest ? 'New best!' : `Best: ${best}`}</p><div class="go">${isTouch ? 'Tap to fly again' : 'Press any key or button to fly again'}</div><div class="row"><button data-act="menu">${isTouch ? 'Menu' : 'Menu (Esc / B)'}</button></div></div>`;
  setTimeout(() => { if (mode === 'crashed') hud.overlay.classList.remove('hidden'); }, 700);
}

function onDogfight(ev: DogfightEvent) {
  switch (ev.type) {
    case 'spawn':
      popup(ev.role === 'hunter' ? 'Hunter on your tail!' : 'Bandit ahead!', ev.role === 'hunter' ? 'shake it: break hard or brake' : 'get it in front of your nose');
      audio.beep(700, 0.18, 0.08);
      break;
    case 'turned': popup('Bandit turned on you!', 'shake it'); break;
    case 'shaken': { const pts = Math.round(100 * multiplier()); score += pts; combo++; comboTimer = 4; popup(`Shook it! +${pts}`, 'it lost sight of you'); audio.whoosh(0.7); break; }
    case 'overshoot': popup('Overshoot!', 'it flew past: get on its tail'); audio.whoosh(0.9); break;
    case 'hitEnemy': audio.beep(1700, 0.03, 0.05); break;
    case 'kill': {
      combo++; comboTimer = 4;
      const pts = Math.round((ev.role === 'hunter' ? 600 : 450) * (ev.ground ? 1.5 : 1) * multiplier());
      score += pts;
      popup(ev.ground ? `Ground kill! +${pts}` : `Shot down! +${pts}`, `${ev.role === 'hunter' ? 'hunter' : 'bandit'} · ${dogfight.kills} down`);
      audio.thud(); audio.whoosh(0.8); rumble(0.6, 200); slowmo = 0.4;
      break;
    }
    case 'hitPlayer':
      hp--; hpRegen = 0; hitFlash = 1; shake = Math.max(shake, 0.6);
      rumble(0.9, 180); audio.thud();
      puffs.burst(glider.pos, glider.vel.clone().multiplyScalar(0.3), 3, 10, 0.5);
      if (hp <= 0) crash('Shot down!');
      else popup('Hit!', `${hp} feather${hp > 1 ? 's' : ''} left`);
      break;
    case 'dodged':
      if (dodgeCd <= 0) { const pts = Math.round(50 * multiplier()); score += pts; popup(`Dodged! +${pts}`, 'rolled through the shots'); dodgeCd = 0.8; }
      break;
    case 'escaped': popup('Bandit escaped'); break;
    case 'wave': audio.beep(700, 0.25, 0.08); popup(`Wave ${ev.wave}`, `${ev.count} bird${ev.count > 1 ? 's' : ''}`); break;
    case 'waveCleared': {
      // clearing a wave pays out, grows a feather back and refills your darts
      const pts = Math.round(500 * ev.wave * multiplier());
      score += pts; combo++; comboTimer = 4;
      hp = Math.min(3, hp + 1); hpRegen = 0;
      dogfight.dartsLeft = MAX_DARTS; dogfight.dartCharge = 0;
      audio.whoosh(1); audio.beep(1400, 0.2, 0.07);
      popup(`Wave ${ev.wave} cleared! +${pts}`);
      waveClearedT = 4;
      break;
    }
    case 'myDart': popup('Dart away!', `${dogfight.dartsLeft} left`); break;
    case 'noLock': if (dartHint <= 0) { popup('No lock', 'hold your nose on a bird for a second first'); dartHint = 1.5; } break;
    case 'myDartMiss': popup('Dart missed', 'it lost the target'); break;
    case 'dartLocking': audio.beep(950, 0.08, 0.06); break;
    case 'dartLaunch': popup('DART! One hit and you\'re down', 'break hard as it closes, brake hard, or hide in a cloud'); audio.whoosh(1); rumble(0.4, 120); break;
    case 'dartShaken': {
      const pts = Math.round((ev.how === 'ground' ? 300 : 200) * multiplier());
      score += pts; combo++; comboTimer = 4;
      const how = { flare: 'it shot past as you braked', turn: 'it couldn\'t follow your turn', cloud: 'lost you in the cloud', ground: 'it hit the ground' }[ev.how];
      popup(`Dart evaded! +${pts}`, how); audio.whoosh(0.9);
      break;
    }
    case 'dartHit':
      // a dart is a one-hit kill, whatever feathers you have left
      hp = 0; hpRegen = 0; hitFlash = 1; shake = Math.max(shake, 0.9);
      rumble(1, 260); audio.thud();
      puffs.burst(glider.pos, glider.vel.clone().multiplyScalar(0.3), 4, 16, 0.7);
      crash('Darted!');
      break;
  }
}

// ---------- Dogfight HUD: tail radar, reticles, feathers ----------
const radar = $('radar') as HTMLCanvasElement;
const rctx = radar.getContext('2d')!;
const RADAR_RANGE = 300;
const rets: HTMLElement[] = [];
function drawDogfightHud(show: boolean) {
  radar.style.opacity = show ? '1' : '0';
  hud.hp.textContent = show ? '♥'.repeat(Math.max(0, hp)) + '♡'.repeat(Math.max(0, 3 - hp)) : '';
  // dart ammo: one pip per dart, the next one fills as it recharges
  hud.darts.style.opacity = show ? '1' : '0';
  if (show) {
    const pips = Array.from({ length: MAX_DARTS }, (_, i) =>
      i < dogfight.dartsLeft ? '<i></i>' : i === dogfight.dartsLeft ? `<i class="cd" style="--p:${Math.round(dogfight.dartCharge * 100)}%"></i>` : '<i class="off"></i>').join('');
    hud.darts.innerHTML = `${pips}<b>DARTS${dogfight.locked && dogfight.dartsLeft ? ' · R' : ''}</b>`;
    hud.darts.classList.toggle('ready', !!dogfight.locked && dogfight.dartsLeft > 0);
    $('dartBtn').textContent = `DART ${dogfight.dartsLeft}`;
    $('dartBtn').classList.toggle('dim', !dogfight.locked || dogfight.dartsLeft === 0);
  }
  const threat = show ? Math.max(dogfight.tailThreat, dogfight.dartLockProgress) : 0;
  hud.warn.style.opacity = mode === 'flying' && glider.stalled ? String(0.6 + 0.4 * Math.sin(t * 16)) : threat > 0 ? String((0.55 + 0.45 * Math.sin(t * (8 + threat * 14))) * Math.min(1, 0.4 + threat)) : '0';
  hud.warn.textContent = mode === 'flying' && glider.stalled ? '▼ STALL: DIVE TO GAIN SPEED ▼' : !show ? '' : dogfight.dartIncoming < Infinity ? `▲ DART ${Math.round(dogfight.dartIncoming)} m: BREAK! ▲`
    : dogfight.dartLockProgress > 0 ? `▼ DART LOCK ${Math.round(dogfight.dartLockProgress * 100)}% ▼`
    : threat > 0.7 ? '▼ IN ITS SIGHTS: BREAK! ▼' : '▼ ON YOUR TAIL ▼';

  // radar: you in the middle, nose up the screen
  const dpr = Math.min(2, devicePixelRatio), S = 112;
  if (radar.width !== S * dpr) { radar.width = S * dpr; radar.height = S * dpr; }
  const c = rctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, S, S);
  if (show) {
    const R = S / 2 - 2, cx = S / 2, cy = S / 2;
    c.fillStyle = 'rgba(20,40,60,0.35)'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    if (threat > 0) { // rear half glows red
      c.fillStyle = `rgba(255,70,50,${0.25 + 0.35 * threat * (0.5 + 0.5 * Math.sin(t * 12))})`;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI); c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(cx, cy - 5); c.lineTo(cx - 4, cy + 4); c.lineTo(cx + 4, cy + 4); c.fill();
    const h = glider.heading, fx = -Math.sin(h), fz = -Math.cos(h);
    for (const e of dogfight.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - glider.pos.x, dz = e.pos.z - glider.pos.z;
      let ahead = dx * fx + dz * fz, right = dx * -fz + dz * fx;
      const d = Math.hypot(ahead, right), k = Math.min(1, d / RADAR_RANGE) * R / Math.max(d, 1e-3);
      ahead *= k; right *= k;
      c.fillStyle = e.role === 'hunter' ? '#ff5a4a' : '#ffb347';
      c.beginPath(); c.arc(cx + right, cy - ahead, d > RADAR_RANGE ? 2.5 : 4, 0, Math.PI * 2); c.fill();
    }
    for (const d of dogfight.darts) {
      if (!d.tracking) continue;
      const dx = d.pos.x - glider.pos.x, dz = d.pos.z - glider.pos.z;
      let ahead = dx * fx + dz * fz, right = dx * -fz + dz * fx;
      const dd = Math.hypot(ahead, right), k = Math.min(1, dd / RADAR_RANGE) * R / Math.max(dd, 1e-3);
      ahead *= k; right *= k;
      c.fillStyle = '#fff'; c.strokeStyle = '#ff3b2e'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx + right, cy - ahead - 5); c.lineTo(cx + right - 4, cy - ahead + 4); c.lineTo(cx + right + 4, cy - ahead + 4); c.closePath(); c.fill(); c.stroke();
    }
  }

  // reticles on enemies in view
  let n = 0;
  if (show) for (const e of dogfight.enemies) {
    if (!e.alive) continue;
    const v = tmp.copy(e.pos).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
    let el = rets[n];
    if (!el) { el = document.createElement('div'); el.className = 'ret'; el.innerHTML = '<span></span>'; $('rets').appendChild(el); rets.push(el); }
    n++;
    const locking = e.dartLock > 0;
    const mine = e === dogfight.locked ? ' mylocked' : e === dogfight.locking ? ' mylocking' : '';
    el.className = `ret ${e.role}${locking ? ' lock' : ''}${mine}`;
    el.style.display = 'block';
    el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
    const dist = Math.round(e.pos.distanceTo(glider.pos));
    (el.firstChild as HTMLElement).textContent = locking ? `LOCKING YOU ${dist} m` : e === dogfight.locked ? `LOCKED ${dist} m` : e === dogfight.locking ? `LOCK ${Math.round(dogfight.lockT * 100)}%` : `${dist} m`;
  }
  // darts coming at you
  if (show) for (const d of dogfight.darts) {
    if (!d.tracking) continue;
    const v = tmp.copy(d.pos).project(camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
    let el = rets[n];
    if (!el) { el = document.createElement('div'); el.className = 'ret'; el.innerHTML = '<span></span>'; $('rets').appendChild(el); rets.push(el); }
    n++;
    el.className = 'ret dart'; el.style.display = 'block';
    el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px) rotate(45deg)`;
    (el.firstChild as HTMLElement).textContent = `DART ${Math.round(d.pos.distanceTo(glider.pos))} m`;
  }
  for (let i = n; i < rets.length; i++) rets[i].style.display = 'none';
}

// ---------- Camera ----------
// A chase camera that stays behind the bird the whole time, loops included. It follows a smoothed
// forward vector and a smoothed "up" that rotates with the bird once the nose goes steeply up,
// so there is no point where lookAt has to flip the view over.
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const camFwd = new THREE.Vector3(0, 0, -1);
const camUp = new THREE.Vector3(0, 1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let camSteep = 0; // 0 = normal glide framing, 1 = full chase (steep climbs, loops)
const tmp = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();

/** Turn `cur` toward `want` about `axis` (both kept perpendicular to it), by fraction k. Works for 180 degree gaps. */
function rotateToward(cur: THREE.Vector3, want: THREE.Vector3, axis: THREE.Vector3, k: number) {
  const a = cur.clone().projectOnPlane(axis), b = want.clone().projectOnPlane(axis);
  if (a.lengthSq() < 1e-6 || b.lengthSq() < 1e-6) { cur.copy(want); return; }
  a.normalize(); b.normalize();
  const ang = Math.atan2(tmp.crossVectors(a, b).dot(axis), a.dot(b));
  cur.copy(a).applyAxisAngle(axis, ang * k);
}

function placeCamera(snap = false, dt = 0.016, lift = 0) {
  const g = glider;
  // how much of the climb the camera should follow: none in a normal glide, all of it past ~50 degrees
  const steepWant = g.looping || g.trick?.type === 'half' ? 1 : THREE.MathUtils.smoothstep(g.free ? Math.abs(g.pitch) : g.pitch, 0.55, 0.95);
  camSteep = snap ? steepWant : camSteep + (steepWant - camSteep) * Math.min(1, 4 * dt);

  // forward: a normal glide keeps the horizon in view; steep flight follows the actual flight path
  const flat = tmp.set(-Math.sin(g.heading), 0, -Math.cos(g.heading));
  const tilt = g.dir.clone(); tilt.y = Math.max(tilt.y, -0.4);
  const glideFwd = flat.clone().lerp(tilt, 0.45).normalize();
  const fwdWant = glideFwd.lerp(g.dir, camSteep).normalize();
  if (snap) camFwd.copy(fwdWant);
  else camFwd.lerp(fwdWant, 1 - Math.exp(-6 * dt)).normalize();

  // up: world up in a glide; the bird's own up (from pitch + heading, plus any half-roll spin) when steep
  tmpE.set(g.pitch, g.heading, g.trick?.type === 'half' ? -g.spin : 0, 'YXZ');
  const birdUp = g.free ? tmpUp.copy(g.up) : tmpUp.set(0, 1, 0).applyQuaternion(tmpQ.setFromEuler(tmpE));
  // free flight: the camera rolls most of the way with the bird (never through zero, so it can't flip)
  const upWant = g.free ? birdUp.clone().multiplyScalar(0.7).addScaledVector(WORLD_UP, 0.3)
    : camSteep > 0.999 ? birdUp.clone() : birdUp.clone().multiplyScalar(camSteep).addScaledVector(WORLD_UP, 1 - camSteep);
  if (upWant.lengthSq() < 1e-4) upWant.copy(birdUp);
  upWant.normalize();
  if (snap) camUp.copy(upWant);
  else rotateToward(camUp, upWant, camFwd, 1 - Math.exp(-7 * dt));
  camUp.projectOnPlane(camFwd).normalize();

  const dist = 8.5 + camSteep * 2.5 + Math.max(0, g.speed - 30) * 0.06;
  const want = g.pos.clone().addScaledVector(camFwd, -dist).addScaledVector(camUp, 2.6 + lift);
  const ground = terrainHeight(want.x, want.z) + 1.8;
  if (want.y < ground) want.y = ground;
  const lookWant = g.pos.clone().addScaledVector(g.dir, 10 - camSteep * 4);
  camPos.lerp(want, snap ? 1 : 1 - Math.exp(-12 * dt));
  camLook.lerp(lookWant, snap ? 1 : 1 - Math.exp(-10 * dt));
  if (snap) { camPos.copy(want); camLook.copy(lookWant); }
  camera.position.copy(camPos);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
  camera.up.copy(camUp);
  camera.lookAt(camLook);
  if (!g.free) camera.rotateZ(-g.roll * 0.35);
  const fov = THREE.MathUtils.clamp(62 + (g.speed - 25) * 0.55, 60, 98);
  camera.fov += (fov - camera.fov) * Math.min(1, 3 * dt);
  camera.updateProjectionMatrix();
}

// ---------- Main loop ----------
let last = performance.now();
let t = 0;
spawn(false);
renderMenu();

function frame(now: number) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const inp = input.poll();

  if (inp.anyPress) audio.start();
  const nav = inp.nav;
  if (mode === 'title') {
    const rows = menuRows() as readonly string[];
    if (nav.y) {
      let i = rows.indexOf(MENU_ROWS[menuRow]);
      i = THREE.MathUtils.clamp(i + nav.y, 0, rows.length - 1);
      menuRow = MENU_ROWS.indexOf(rows[i] as typeof MENU_ROWS[number]);
      renderMenu();
    }
    if (nav.x && MENU_ROWS[menuRow] !== 'go') menuChange(MENU_ROWS[menuRow], nav.x);
    if (startReq || (nav.ok && !inp.nav.back)) {
      clearTimeout(previewTimer);
      spawn(false); // keeps the world the title was showing
      mode = 'flying'; hud.overlay.classList.add('hidden');
    }
  } else if (mode === 'crashed' && (menuReq || nav.back || nav.menu)) goToMenu();
  else if (mode === 'crashed' && inp.anyPress && crashTimer > 0.8) { spawn(); mode = 'flying'; hud.overlay.classList.add('hidden'); }
  else if (mode === 'flying' && nav.menu) goToMenu();
  startReq = false; menuReq = false;
  const inArena = !!getArena();

  if (slowmo > 0) { slowmo -= dt; dt *= 0.35; }
  t += dt;

  let mist = 0, clearance = 99;
  if (mode === 'flying') {
    prevPos.copy(glider.pos);
    if (inp.trick && glider.startTrick(inp.trick, inp.roll)) {
      if (glider.trick?.type === 'roll' && inp.roll * (inp.trick === 'rollL' ? -1 : 1) > 0.4) popup(inp.trick === 'rollL' ? '◀ Dodge' : 'Dodge ▶');
      trickMinClear = 99;
    }
    // wind tunnels push you along and pull you toward the middle
    const wind = inArena ? null : gates.windAt(glider.pos);
    if (wind) {
      glider.speed = Math.min(90, glider.speed + 22 * dt);
      glider.pos.lerp(wind.axis, Math.min(1, 1.2 * dt));
      glider.steerToward(wind.dir, Math.min(1, 1.5 * dt));
    }
    const finished = glider.step(dt, inp);
    for (const ev of dogfight.update(dt, t, glider, inp.fire, inp.dart, true, wasInCloud)) onDogfight(ev);
    if (dogfight.myDartThisFrame) { audio.dart(); rumble(0.3, 80); }
    if (dogfight.locked && dogfight.locked !== wasLocked) audio.beep(1900, 0.12, 0.07);
    wasLocked = dogfight.locked;
    if (dogfight.shotThisFrame) audio.pew();
    if (dogfight.enemyShotThisFrame) audio.pew(true);
    warnBeep -= dt;
    if (dogfight.dartIncoming < Infinity) {
      // incoming dart: beeps speed up as it closes
      if (warnBeep <= 0) { audio.beep(1500, 0.05, 0.07); warnBeep = THREE.MathUtils.clamp(dogfight.dartIncoming / 400, 0.06, 0.3); }
    } else if (dogfight.dartLockProgress > 0) {
      if (warnBeep <= 0) { audio.beep(1250, 0.06, 0.06); warnBeep = 0.35 - 0.25 * dogfight.dartLockProgress; }
    } else if (dogfight.tailThreat > 0 && warnBeep <= 0) { audio.beep(dogfight.tailThreat > 0.7 ? 1100 : 820, 0.07, 0.06); warnBeep = dogfight.tailThreat > 0.7 ? 0.18 : 0.6; }
    if (glider.stalled) shake = Math.max(shake, 0.15); // buffeting as the wings stall
    dartHint -= dt; dodgeCd -= dt; hitFlash = Math.max(0, hitFlash - dt * 2.5);
    if (hp < 3 && (hpRegen += dt) > 20) { hp++; hpRegen = 0; popup('Feather regrown', `${hp}/3`); }
    // a loop starts when the nose comes steeply up (used for the low-loop bonus)
    if (glider.free ? Math.abs(glider.pitch) > 0.9 || glider.looping : glider.pitch > 0.9 || glider.looping) {
      if (!inLoop) { inLoop = true; loopMinClear = 99; }
    } else if (glider.free ? Math.abs(glider.pitch) < 0.5 && !glider.looping : glider.pitch < 0.7) inLoop = false;
    const p = glider.pos;
    const ground = terrainHeight(p.x, p.z);
    clearance = p.y - ground;
    if (clearance < 0.45) { p.y = ground + 0.45; crash(); }

    // obstacles: collision + close calls
    obstaclesNear(p.x, p.z, 14, nearby);
    if (!inArena) gates.obstacles(nearby);
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
      const low = (finished === 'roll' ? trickMinClear : loopMinClear) < 10;
      const base = finished === 'loop' ? 400 : finished === 'half' ? 250 : 150;
      const pts = Math.round(base * (low ? 3 : 1) * multiplier());
      combo++; comboTimer = 4; score += pts;
      const name = finished === 'loop' ? 'Loop' : finished === 'half' ? 'Half loop' : 'Barrel roll';
      popup(`${name} +${pts}`, low ? 'LOW! x3' : finished === 'half' ? 'turned back uphill' : '');
      audio.whoosh(0.7);
    }

    // gates
    if (!inArena) gates.check(prevPos, p, (e: GateEvent) => onGate(e));

    // arena walls: past the edge the wind turns you back toward the middle
    outOfBounds = 0;
    if (inArena) {
      const r = Math.hypot(p.x, p.z);
      outOfBounds = THREE.MathUtils.clamp((r - (ARENA_R - 40)) / 140, 0, 1);
      if (outOfBounds > 0) {
        const k = Math.min(1, (0.4 + outOfBounds * 1.6) * dt);
        glider.steerToward(tmp.set(-p.x / r, -0.05, -p.z / r).normalize(), k);
        if (!glider.free) {
          let dh = Math.atan2(p.x, p.z) - glider.heading; // heading that points at the middle
          dh -= Math.PI * 2 * Math.floor((dh + Math.PI) / (Math.PI * 2));
          glider.heading += dh * k;
        }
      }
    }

    // canyon run: stay below the rim for a steady bonus
    const c = canyonAt(p.x, p.z);
    inCanyonRun = c > 0.6 && p.y < basePlane(p.z) + CANYON_RIM * c - 8;
    if (inCanyonRun) { score += dt * 25 * multiplier(); comboTimer = Math.max(comboTimer, 1.5); }

    // forks: announce the choices, then lock in whichever valley you're in
    const ev = inArena ? {} as ReturnType<typeof route.update> : route.update(p.x, p.z);
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
      if (dogfight.chargeDart(dt * 0.08 * (5 - clearance) / 5)) { popup('Dart reloaded', 'skimming the ground'); audio.beep(1600, 0.1, 0.07); }
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
    if (!inArena) score += Math.max(0, -glider.vel.z) * dt * 0.1;

    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;
  } else if (mode === 'crashed') {
    crashTimer += dt;
    dogfight.update(dt, t, glider, false, false, false);
    glider.speed *= Math.exp(-4 * dt);
    glider.spin += dt * 6;
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
  bird.animate(t, glider.brake, glider.speed, glider.tuck, flapAmount(glider.speed, glider.brake));

  // shadow
  const gp = glider.pos;
  const gy = terrainHeight(gp.x, gp.z);
  const h = gp.y - gy;
  shadow.position.set(gp.x, gy + 0.35, gp.z);
  shadow.scale.setScalar(1.3 + h * 0.03);
  (shadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.5 - h * 0.012, 0, 0.5);

  // stream terrain ahead of the bird
  world.update(gp.x + glider.dir.x * 180, gp.z + glider.dir.z * 180, 2);
  if (!inArena) gates.update(gp.z, t);

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
  hud.edge.style.opacity = String(Math.max(danger * 0.7, hitFlash));
  hud.edge.style.boxShadow = hitFlash > danger * 0.7 ? 'inset 0 0 140px 40px rgba(255, 40, 40, .85)' : '';
  drawDogfightHud(mode === 'flying');
  if (isTouch) { const d = mode === 'flying' ? 'flex' : 'none'; $('fire').style.display = d; $('dartBtn').style.display = d; }
  if (outOfBounds > 0 && mode === 'flying' && hud.warn.style.opacity === '0') {
    hud.warn.textContent = '◀ EDGE OF THE ARENA: TURN BACK ▶';
    hud.warn.style.opacity = String(0.5 + 0.5 * Math.sin(t * 10));
  }
  hud.skim.textContent = danger > 0 ? (waterSkim ? 'WATER SKIM' : 'SKIM') : 'CANYON RUN';
  hud.skim.style.opacity = String(danger > 0 ? 0.6 + danger * 0.4 : inCanyonRun && mode === 'flying' ? 0.7 : 0);
  hud.score.textContent = mode === 'title' ? '' : String(Math.floor(score));
  hud.combo.style.opacity = combo > 0 && mode === 'flying' ? '1' : '0';
  hud.combo.textContent = `combo x${multiplier().toFixed(1)}`;
  hud.stats.textContent = mode === 'flying'
    ? `${Math.round(glider.speed * 3.6)} km/h · ${Math.max(0, Math.round(clearance))} m up · ${inArena ? getArena()!.name : `${Math.round(startZ - gp.z)} m`}`
    : '';
  waveClearedT -= dt;
  const alive = dogfight.enemies.filter((e) => e.alive).length;
  hud.wave.textContent = inArena && mode === 'flying'
    ? dogfight.wave === 0 ? 'GET READY' : waveClearedT > 0 || alive === 0 ? `WAVE ${dogfight.wave} CLEARED` : `WAVE ${dogfight.wave} · ${alive} LEFT`
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
(window as any).__glide = { settings, glider, dogfight, world, gates, get mode() { return mode; }, get score() { return score; }, canyonAt, terrainHeight, route, riverAt };
