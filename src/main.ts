import * as THREE from 'three';
import { World, riverAt, terrainHeight, obstaclesNear, obstacleGap, canyonAt, basePlane, nearestBranch, CANYON_RIM, SKY_COLOR, FOG_FAR, ARENAS, ARENA_R, ARENA_LID_R, arenaBarrier, skimAmount, setArena, getArena, SPACE_ARENA, isSpace, type Obstacle } from './world';
import { SpaceScene, buildField, holeThreaded, fleet, clearSpawnY, spaceEdge, grabPickup, boostPickups, SPACE_R, SPACE_CRUISE, SPACE_BOOST, PICKUP_FUEL } from './space';
import { ShipMesh, type Craft } from './ship';
import { route, BIOME_NAME } from './route';
import { CloudPuffs } from './puffs';
import { Gates, type GateEvent } from './gates';
import { BirdMesh, Glider, PLAYER_COLORS } from './bird';
import { Input } from './input';
import { WindAudio } from './audio';
import { Dogfight, MAX_DARTS, peaSpeed, peaLife, flapAmount, type DogfightEvent } from './dogfight';
import { setWorldSeed } from './noise';
import { Online, PLAYER_CSS, TEAM_CSS, TEAM_NAMES, colorIndex, type MatchRules } from './online';
import { cleanCode, hasRoomBrowser, listRooms, type RoomInfo } from './net';
import { DownCam, type Tracked } from './downcam';
import { sfx } from './spacefx';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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

// space is drawn through a bloom pass (lasers, engines, explosions and the sun glow) with filmic tone mapping;
// the sky world draws straight to the screen as it always has
const coarse = matchMedia('(pointer: coarse)').matches;
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: coarse ? 0 : 4 }));
composer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.5, 0.95);
// One NaN or infinite pixel would smear across the bloom's blur levels as big black blocks, so the glow
// only ever reads finite, clamped colour.
bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(/}\s*$/,
  '  vec4 hp = gl_FragColor; bool ok = hp.r + hp.g + hp.b < 1e4 && hp.r + hp.g + hp.b > -1e4;\n  gl_FragColor = ok ? clamp(hp, 0., 64.) : vec4(0.);\n}');
composer.addPass(bloom);
composer.addPass(new OutputPass());
function render() { if (lookSpace) composer.render(); else renderer.render(scene, camera); }

const hemi = new THREE.HemisphereLight(0xdff0ff, 0x5d7040, 2.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d0, 2.4);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);
/** Space only: a cool fill light from the far side, so a hull's shadowed side never goes flat black. */
const fill = new THREE.DirectionalLight(0x7d9cd8, 0);
scene.add(fill);

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
const online = new Online(dogfight);
const birdMesh = new BirdMesh();
const shipMesh = new ShipMesh(PLAYER_COLORS);
shipMesh.trails = false;
/** Your flyer: the bird, or in space your fighter. */
let bird: Craft = birdMesh;
scene.add(bird);
const spaceScene = new SpaceScene(scene);
const BOLT_RED = new THREE.Color(0xff3d6e);
sfx.onBoom = (p, size) => {
  const d = p.distanceTo(camera.position);
  audio.boom(size, d);
  if (mode !== 'title') shake = Math.max(shake, THREE.MathUtils.clamp(size * 30 / Math.max(d, 1), 0, 0.9));
};

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

// ---------- First-person view: a cockpit canopy frame in space, your own beak out front as a bird ----------
const cockpit = new THREE.Group();
{
  const dark = new THREE.MeshBasicMaterial({ color: 0x1a1e26, fog: false });
  const edge = new THREE.MeshBasicMaterial({ color: 0x39404d, fog: false });
  const strut = (x0: number, y0: number, x1: number, y1: number, w: number, m: THREE.Material) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.01), m);
    b.position.set((x0 + x1) / 2, (y0 + y1) / 2, -0.62);
    b.rotation.z = Math.atan2(x1 - x0, y1 - y0) * -1;
    cockpit.add(b);
  };
  // canopy bows sweeping up from the dash, meeting over your head, and the dash itself along the bottom
  strut(-0.95, -0.42, -0.32, 0.55, 0.045, dark); strut(0.95, -0.42, 0.32, 0.55, 0.045, dark);
  strut(-0.32, 0.55, 0.32, 0.55, 0.05, dark);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 0.01), dark); dash.position.set(0, -0.52, -0.62); cockpit.add(dash);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.02, 0.01), edge); lip.position.set(0, -0.37, -0.615); cockpit.add(lip);
  // two glowing displays set into the dash: a scope and a systems readout
  const screen = (draw: (c: CanvasRenderingContext2D) => void, x: number, tint: number) => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 56;
    const c = cv.getContext('2d');
    if (c) { c.fillStyle = '#050a10'; c.fillRect(0, 0, 128, 56); draw(c); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.066), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(tint).multiplyScalar(1.3), fog: false, toneMapped: false }));
    m.position.set(x, -0.413, -0.614); cockpit.add(m);
  };
  screen((c) => {
    c.strokeStyle = '#3fd8ff'; c.lineWidth = 1.5;
    for (const r of [9, 18, 26]) { c.beginPath(); c.arc(64, 28, r, 0, Math.PI * 2); c.stroke(); }
    c.beginPath(); c.moveTo(64, 0); c.lineTo(64, 56); c.moveTo(28, 28); c.lineTo(100, 28); c.stroke();
    c.fillStyle = '#ff6a50'; for (const [x, y] of [[76, 16], [52, 36], [84, 34]]) c.fillRect(x, y, 4, 4);
  }, -0.36, 0xbfefff);
  screen((c) => {
    c.fillStyle = '#ffc24a'; c.font = 'bold 10px monospace';
    ['PWR', 'SHD', 'ENG', 'WPN'].forEach((l, i) => { c.fillText(l, 6, 13 + i * 13); c.fillRect(34, 5 + i * 13, 30 + ((i * 37) % 60), 7); });
  }, 0.36, 0xffe2b0);
  for (const o of cockpit.children) o.renderOrder = 10;
}
const beak = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.16, 4).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf2b630, flatShading: true }));
beak.position.set(0, -0.3, -0.95);
cockpit.visible = false; beak.visible = false;
camera.add(cockpit, beak);

// ---------- The two worlds: sky (birds) or space (fighters) ----------
const SPACE_BG = new THREE.Color(0x020108);
let lookSpace: boolean | null = null;
/** Switch the scene, lighting, camera range and your flyer to suit the world getArena() is set to. */
function applyLook() {
  const sp = isSpace();
  input.space = sp; glider.space = sp; dogfight.setLook(sp);
  if (sp === lookSpace) return;
  lookSpace = sp;
  spaceScene.visible = sp; sky.visible = !sp;
  scene.background = sp ? SPACE_BG : SKY;
  camera.far = sp ? 40000 : 900; camera.updateProjectionMatrix();
  renderer.toneMapping = sp ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.05;
  if (sp) {
    // a cold fill from the stars and a blue bounce off the planet below; the sun does the real work
    hemi.color.set(0x8090b8); hemi.groundColor.set(0x3a5a90); hemi.intensity = 1.7;
    sun.color.set(0xfff0dc); sun.intensity = 3.4; sun.position.copy(spaceScene.sunDir);
    fill.intensity = 0.8; fill.position.copy(spaceScene.sunDir).negate().setY(-0.3);
    const fog = scene.fog as THREE.Fog; fog.near = 1e5; fog.far = 2e5;
  } else {
    hemi.color.set(0xdff0ff); hemi.groundColor.set(0x5d7040); hemi.intensity = 2.0;
    sun.color.set(0xfff0d0); sun.intensity = 2.4; sun.position.set(0.5, 1, 0.3);
    fill.intensity = 0;
    const fog = scene.fog as THREE.Fog; fog.near = 140; fog.far = 640;
  }
  scene.remove(bird);
  bird = sp ? shipMesh : birdMesh;
  scene.add(bird);
  document.body.classList.toggle('space', sp);
  showControlsSafe();
}

// ---------- Input, audio, HUD ----------
const input = new Input(document);
const LAYOUT_NAMES = { flight: ['Flight sticks', 'left stick pitches, right stick rolls'], classic: ['Classic', 'one stick steers'], wings: ['Wing sticks', 'one stick per wing'] } as const;
input.onSchemeChange = (sc) => { showControlsSafe(); popup(LAYOUT_NAMES[sc][0], LAYOUT_NAMES[sc][1]); };
const audio = new WindAudio();
const $ = (id: string) => document.getElementById(id)!;
const hud = { wave: $('wave'), hp: $('hp'), warn: $('warn'), score: $('score'), combo: $('combo'), stats: $('stats'), darts: $('darts'), mist: $('mist'), edge: $('edge'), overlay: $('overlay') };

const isTouch = matchMedia('(pointer: coarse)').matches;
// ---------- Phones play in landscape ----------
// Held upright, a card asks you to turn the phone (index.html, #rotate) and a solo game waits for you.
const portraitQ = matchMedia('(orientation: portrait) and (pointer: coarse)');
/** Where the browser allows it (Android Chrome), go full screen and lock to landscape. iPhones can't lock,
 *  so there the rotate card does the job. Called from a tap. */
function goLandscape() {
  if (!isTouch) return;
  const el = document.documentElement as Partial<HTMLElement>;
  const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  const lock = () => orient?.lock?.('landscape').catch(() => {});
  try {
    if (document.fullscreenElement) lock();
    else if (el.requestFullscreen) el.requestFullscreen.call(document.documentElement, { navigationUI: 'hide' }).then(lock, () => {});
  } catch { /* not allowed here (an iframe, an iPhone): the rotate card covers it */ }
}
const rotateEl = document.getElementById('rotate');
if (rotateEl) {
  if (isTouch && (document.documentElement as Partial<HTMLElement>).requestFullscreen && 'lock' in (screen.orientation ?? {})) rotateEl.classList.add('canlock');
  rotateEl.addEventListener('click', goLandscape);
}
// Controls help: [keys, what they do] pairs, laid out as a key list in the menu's "Controls" panel.
type Help = [string, string][];
const kb = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join('');
const PAD_HELP: Record<string, Help> = {
  flight: [[`Left stick ${kb('↑↓')}`, 'Dive / pull up (keep pulling to loop)'], [`Right stick ${kb('←→')}`, 'Roll, all the way round (bank holds)']],
  classic: [['Left stick', 'Steer (keep pulling down to loop)']],
  wings: [[`Left stick ${kb('↑↓')}`, 'Left wing'], [`Right stick ${kb('↑↓')}`, 'Right wing'], ['Both up / both down', 'Dive / climb'], ['One up, one down', 'Sharp turn']],
};
const PAD_COMMON: Help = [[kb('RT') + ' / ' + kb('X'), 'Shoot'], [kb('Y'), 'Homing dart'], [kb('LT') + ' / ' + kb('A'), 'Air-brake'], [kb('Back'), 'Next stick layout'], [kb('R3'), 'First-person view']];
const KEYS_HELP = (): Help => [
  [kb('W', 'S') + ' / ' + kb('↑', '↓'), 'Dive / pull up (hold S to loop)'],
  [kb('A', 'D') + ' / ' + kb('←', '→'), input.scheme === 'flight' ? 'Roll (bank holds)' : 'Bank'],
  [kb('Z', 'C'), 'Rudder'], [kb('Space'), 'Air-brake'], [kb('F') + ' or click', 'Shoot'],
  [kb('R') + ' or right-click', 'Homing dart (hold your nose on a bird for 1 s to lock)'], [kb('V'), 'Change layout'], [kb('T'), 'First-person view'],
];
// space fighters
const SPACE_PAD: Help = [[`Left stick ${kb('↑↓')}`, 'Pitch'], [`Right stick ${kb('←→')}`, 'Roll'], 
  [kb('RT') + ' / ' + kb('X'), 'Lasers'], [kb('Y'), 'Missile'], [kb('RB'), 'Boost'], [kb('LB'), 'Drift: slide and aim'], [kb('R3'), 'Cockpit view']];
const SPACE_KEYS: Help = [[kb('W', 'S') + ' / ' + kb('↑', '↓'), 'Pitch'], [kb('A', 'D') + ' / ' + kb('←', '→'), 'Roll'], [kb('Z', 'C'), 'Yaw'],
  [kb('Shift'), 'Boost'], [kb('Space'), 'Drift: slide and aim'], [kb('F') + ' or click', 'Lasers'],
  [kb('R') + ' or right-click', 'Missile (hold your nose on a fighter for 1 s to lock)'], [kb('T'), 'Cockpit view']];
const TILT_HELP: Help = [['Tilt the phone', 'Steer like a wheel: turn it to roll, tip the top away to dive, toward you to pull up'],
  ['Level', 'However you hold the phone when you launch']];
const SPACE_TOUCH = (): Help => [...(settings.tilt ? TILT_HELP : [['Left thumb ↑↓', 'Pitch'], ['Right thumb ←→', 'Roll']] as Help),
  ['Left slider', 'Throttle: up boosts, the notch cruises, down drifts (it stays put)'],
  ['Hold FIRE', 'Lasers'], ['Tap MSL', 'Missile, once your nose has locked a fighter'], ['Tap VIEW', 'Cockpit view']];
const TOUCH_HELP = (): Help => settings.tilt
  ? [...TILT_HELP, ['Hold anywhere else', 'Air-brake'], ['Hold FIRE', 'Shoot'], ['Tap DART', 'Homing dart, once your nose has locked a bird']]
  : input.scheme === 'flight'
  ? [['Left thumb ↑↓', 'Dive / pull up (keep pulling down to loop)'], ['Right thumb ←→', 'Roll, all the way round (bank holds)'], ['Hold FIRE', 'Shoot'], ['Tap DART', 'Homing dart, once your nose has locked a bird']]
  : [['Drag left side', 'Steer: up dives, down pulls up'], ['Hold right side', 'Air-brake'], ['Hold FIRE', 'Shoot'], ['Tap DART', 'Homing dart, once your nose has locked a bird']];
const helpList = (title: string, rows: Help) => `<h3>${title}</h3><dl class="keys">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
const showControls = () => {
  const el = document.getElementById('controls');
  if (!el) return;
  if (settings.mode === 'space' || isSpace()) {
    el.innerHTML = isTouch ? helpList('Touch', SPACE_TOUCH()) : input.activePad ? helpList('Controller', SPACE_PAD) + helpList('Keyboard &amp; mouse', SPACE_KEYS)
      : helpList('Keyboard &amp; mouse', SPACE_KEYS) + helpList('Controller', SPACE_PAD);
    return;
  }
  if (isTouch) { el.innerHTML = helpList('Touch', TOUCH_HELP()); return; }
  const pad = helpList(`Controller · ${LAYOUT_NAMES[input.scheme][0].toLowerCase()}`, [...PAD_HELP[input.scheme], ...PAD_COMMON]);
  const keys = helpList('Keyboard &amp; mouse', KEYS_HELP());
  el.innerHTML = input.activePad ? pad + keys : keys + pad; // the controller first once one is plugged in
};
const showControlsSafe = showControls;
addEventListener('gamepadconnected', showControlsSafe);
document.body.classList.toggle('touch', isTouch);
if (isTouch) { $('fire').style.display = 'flex'; $('dartBtn').style.display = 'flex'; $('viewBtn').style.display = 'flex'; }

// ---------- Game settings: endless downhill or arena ----------
type GameMode = 'endless' | 'arena' | 'space' | 'online';
type ViewSetting = 'chase' | 'cockpit';
/** The online lobby's arena picker: the arenas, then Random, then Space. */
const SPACE_ENV = ARENAS.length + 1;
type DownCamSetting = 'shot' | 'all' | 'off';
const DOWNCAM_OPTS: DownCamSetting[] = ['shot', 'all', 'off'];
const settings = { mode: 'endless' as GameMode, env: ARENAS.length /* = random */, enemies: 3, myDarts: true, enemyDarts: true,
  /* online */ name: '', bots: 2, allies: false, code: '', public: true,
  /* HUD: lead marker showing where to aim your peas */ lead: true,
  /* title menu: controls list open (open on a first visit) */ help: true,
  /* replay when you go down: 'shot' = shot down (or chased into the ground), 'all' = every crash too, 'off' */ downcam: 'shot' as DownCamSetting,
  /* camera: behind you, or first person */ view: 'chase' as ViewSetting,
  /* phones: steer by tilting */ tilt: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem('glide.settings') || '{}')); } catch { /* storage unavailable */ }
settings.env = THREE.MathUtils.clamp(Math.round(settings.env) || 0, 0, SPACE_ENV);
settings.enemies = THREE.MathUtils.clamp(Math.round(settings.enemies) || 3, 1, 12);
settings.bots = THREE.MathUtils.clamp(Math.round(settings.bots) || 0, 0, 12);
if (!['endless', 'arena', 'space', 'online'].includes(settings.mode)) settings.mode = 'endless';
if (settings.view !== 'cockpit') settings.view = 'chase';
settings.tilt = isTouch && settings.tilt === true;
input.tilt = settings.tilt;
input.onMotion = () => { if (mode === 'title') renderMenu(); };
if (!DOWNCAM_OPTS.includes(settings.downcam)) settings.downcam = 'shot';
settings.name = String(settings.name || '').slice(0, 16);
// an invite link (?room=CODE) opens straight onto the online menu, ready to join
const inviteCode = cleanCode(new URLSearchParams(location.search).get('room') || '');
if (inviteCode) { settings.mode = 'online'; settings.code = inviteCode; }
const saveSettings = () => { try { localStorage.setItem('glide.settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const bestKey = () => (settings.mode === 'arena' ? 'glide.best.arena' : settings.mode === 'space' ? 'glide.best.space' : settings.mode === 'online' ? 'glide.best.online' : 'glide.best');
let best = 0;
const loadBest = () => { try { best = Number(localStorage.getItem(bestKey()) || 0); } catch { best = 0; } };
loadBest();
/** The arena chosen for this match ("random" rolls one per match). */
let arenaIdx = 0;

const MENU_ROWS = ['mode', 'env', 'enemies', 'bots', 'allies', 'team', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'tilt', 'go', 'vis', 'host', 'join', 'rooms', 'help'] as const;
const GO_ROW = MENU_ROWS.indexOf('go');
let menuRow = inviteCode ? MENU_ROWS.indexOf('join') : GO_ROW;
/** On a phone the Steering row (thumbs or tilt) follows Camera. */
function menuRows(): readonly string[] {
  const rows = baseRows();
  return isTouch ? rows.flatMap((r) => (r === 'view' ? ['view', 'tilt'] : [r])) : rows;
}
function baseRows(): readonly string[] {
  const browser = hasRoomBrowser();
  if (settings.mode === 'online') return online.active
    ? (online.isHost && online.phase === 'lobby' ? [...(browser ? ['vis'] : []), 'env', 'bots', 'allies', ...(settings.allies ? ['team'] : []), 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go']
      : online.phase === 'lobby' ? [...(online.teams ? ['team'] : []), 'lead', 'downcam', 'view'] : [])
    : ['mode', ...(browser && openRooms.length ? ['rooms'] : []), 'join', ...(browser ? ['vis'] : []), 'host', 'lead', 'downcam', 'view', 'help'];
  return settings.mode === 'arena' ? ['mode', 'env', 'enemies', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help']
    : settings.mode === 'space' ? ['mode', 'enemies', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help']
    : ['mode', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help'];
}
let onlineNote = '';

// ---------- Room browser (Cloudflare relay only): the open public rooms, refreshed while you look ----------
let openRooms: RoomInfo[] = [];
let roomsState: 'loading' | 'ok' | 'error' = 'loading';
let roomSel = 0;
let roomsTimer = 0, roomsLive = false;
const browsing = () => mode === 'title' && settings.mode === 'online' && !online.active && hasRoomBrowser();
async function refreshRooms() {
  clearTimeout(roomsTimer);
  if (!browsing()) { roomsLive = false; return; }
  roomsLive = true;
  try { openRooms = await listRooms(); roomsState = 'ok'; } catch { roomsState = 'error'; }
  roomSel = Math.min(roomSel, Math.max(0, openRooms.length - 1));
  const el = document.getElementById('roomList');
  if (el) el.innerHTML = roomListHtml();
  else if (browsing()) renderMenu();
  roomsTimer = window.setTimeout(refreshRooms, document.hidden ? 15000 : 4000);
}
function roomListHtml() {
  if (roomsState === 'loading') return '<p class="blurb small">Looking for open rooms…</p>';
  if (roomsState === 'error') return '<p class="blurb small">Couldn\'t load the room list. Retrying…</p>';
  if (!openRooms.length) return '<p class="blurb small">No public rooms right now. Host one!</p>';
  const selRow = MENU_ROWS[menuRow] === 'rooms';
  return openRooms.map((r, i) => {
    const full = r.players >= r.max;
    const where = r.phase === 'playing' ? `in a match${r.arena === 99 ? ` · ${SPACE_ARENA.name} (space)` : r.arena >= 0 && ARENAS[r.arena] ? ` · ${ARENAS[r.arena].name}` : ''}` : 'in the lobby';
    return `<button class="room${selRow && i === roomSel ? ' sel' : ''}" data-act="joinroom:${esc(r.code)}"${full ? ' disabled' : ''}>
      <b>${esc(r.name)}'s room</b><span>${r.players}/${r.max} players · ${where}${full ? ' · full' : ''}</span></button>`;
  }).join('');
}
const esc = (s: string) => s.replace(/[<>&"]/g, '');
const inviteLink = () => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('room', online.code); const sig = new URLSearchParams(location.search).get('signal'); if (sig) u.searchParams.set('signal', sig); return u.toString(); };
/** Mode tabs on the title menu. A new mode only needs an entry here (plus its blurb and rows below). */
const MODE_TABS: { id: GameMode; label: string }[] = [
  { id: 'endless', label: 'Endless' }, { id: 'arena', label: 'Arena' }, { id: 'space', label: 'Space' }, { id: 'online', label: 'Online' },
];
const MODE_BLURB: Record<GameMode, string> = {
  endless: 'An endless mountainside. Skim the ground, thread the trees, punch through the clouds, and shoot down the birds hunting you.',
  arena: 'A walled-in basin to fight in, wave after wave. You flap to hold your speed, but climbing still costs it and diving still builds it.',
  space: 'Space fighters in the middle of a capital-ship battle high above a planet. No air, no stalling: cruise, boost (grab the gold pickups to refill it), drift to swing your nose round. Run the carrier hangar bays and the tunnels through the cruisers, skim the hulls, and lead missiles into them.',
  online: 'Fight in the arena with other players anywhere: join an open room, type a friend\'s code, or host your own.',
};
const onOff = (b: boolean) => (b ? 'On' : 'Off');
const sect = (title: string) => `<h2 class="sect">${title}</h2>`;
/** The bottom line: how to drive the menu on this device. */
const menuHint = (fly: string) => (isTouch ? '' : `<p class="hint">${kb('↑', '↓')} choose · ${kb('←', '→')} change · ${kb('Enter')} / ${kb('A')} ${fly}</p>`);
function helpRow(sel: string) {
  return `<button class="opt toggle${sel}" data-act="help:1"><span class="lab">Controls</span><span class="chev">${settings.help ? 'Hide ▴' : 'Show ▾'}</span></button>
    ${settings.help ? '<div class="controls" id="controls"></div>' : ''}`;
}
/** A phone on its side (landscape, not much height): the menu splits into two columns so it fits without
 *  scrolling: the title and the main buttons on the left, the settings on the right. */
const compactQ = matchMedia('(orientation: landscape) and (max-height: 540px)');
compactQ.addEventListener?.('change', () => { if (!hud.overlay.classList.contains('hidden') && mode === 'title') renderMenu(); });
const splitMenu = (left: string, right: string, hint = '') => `<div class="menu split">
    <div class="col"><h1>Glide!</h1><div class="panel">${left}</div>${hint}</div>
    <div class="panel col sets">${right}</div>
  </div>`;
function renderMenu() {
  if (settings.mode === 'online') { renderOnlineMenu(); return; }
  const rows = menuRows() as readonly string[];
  if (!rows.includes(MENU_ROWS[menuRow])) menuRow = GO_ROW;
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const envName = settings.env >= ARENAS.length ? 'Random' : ARENAS[settings.env].name;
  const envBlurb = settings.env >= ARENAS.length ? 'A different arena every match' : ARENAS[settings.env].blurb;
  const arena = settings.mode === 'arena', space = settings.mode === 'space';
  const dw = space ? 'missiles' : 'darts';
  const head = `${modeRow(sel('mode'))}<p class="blurb">${MODE_BLURB[settings.mode]}</p>`;
  const sets = `${arena ? `${sect('Match')}${pickRow(sel('env'), 'env', 'Arena', envName, envBlurb)}${pickRow(sel('enemies'), 'enemies', 'Enemies', `${settings.enemies} per wave`)}` : ''}
      ${space ? `${sect('Match')}${pickRow(sel('enemies'), 'enemies', 'Enemies', `${settings.enemies} per wave`)}` : ''}
      ${sect(space ? 'Missiles' : 'Darts')}
      ${pickRow(sel('myDarts'), 'myDarts', `Your ${dw}`, onOff(settings.myDarts))}
      ${pickRow(sel('enemyDarts'), 'enemyDarts', `Enemy ${dw}`, onOff(settings.enemyDarts))}
      ${sect('View')}
      ${leadRow(sel('lead'))}
      ${downcamRow(sel('downcam'))}
      ${viewRow(sel('view'))}${tiltRow(sel('tilt'))}`;
  const cta = `<button data-act="go" class="go-btn cta${sel('go')}">Fly!</button>`;
  hud.overlay.innerHTML = compactQ.matches ? splitMenu(head + cta, sets + helpRow(sel('help')), menuHint('fly')) : `<div class="menu side">
    <h1>Glide!</h1>
    <div class="panel">
      ${head}
      ${sets}
      ${cta}
      ${helpRow(sel('help'))}
    </div>
    ${menuHint('fly')}
  </div>`;
  showControls();
  revealSel();
}
/** Keep the pad / keyboard selection on screen when the menu is taller than the window. */
const revealSel = () => hud.overlay.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
function visRow(sel: string) {
  const on = online.active ? online.isPublic : settings.public;
  return pickRow(sel, 'vis', 'Room', on ? 'Public' : 'Private', on ? 'Listed under Open rooms for anyone to join' : 'Hidden: friends join with the code or invite link');
}
function viewRow(sel: string) { return pickRow(sel, 'view', 'Camera', settings.view === 'cockpit' ? 'First person' : 'Chase', 'T / R3 switches in flight'); }
function tiltRow(sel: string) {
  if (!isTouch) return '';
  return pickRow(sel, 'tilt', 'Steering', settings.tilt ? 'Tilt' : 'Thumbs', !settings.tilt ? 'Thumb sticks · or switch to tilt (motion) steering'
    : input.motion === 'denied' ? 'Motion access is off. Quit and reopen Safari, then tap Tilt again and choose Allow'
    : input.motion === 'unknown' ? 'Tap to allow motion access when Safari asks' : 'Tilt the phone to fly · level is how you hold it at launch');
}
function leadRow(sel: string) { return pickRow(sel, 'lead', 'Lead marker', onOff(settings.lead), `Shows where to aim your ${settings.mode === 'space' || isSpace() ? 'lasers' : 'peas'}`); }
function downcamRow(sel: string) {
  return pickRow(sel, 'downcam', 'Down cam', { shot: 'When shot down', all: 'Every crash', off: 'Off' }[settings.downcam], 'Replay from your killer\'s view');
}
function modeRow(sel: string) {
  return `<div class="tabs${sel}" role="tablist">${MODE_TABS.map((m) =>
    `<button role="tab" data-act="mode:${m.id}" class="${settings.mode === m.id ? 'on' : ''}" aria-selected="${settings.mode === m.id}">${m.label}</button>`).join('')}</div>`;
}
/** A setting: label (and an optional note) on the left, ◀ value ▶ on the right. Tapping the value steps it forward. */
function pickRow(sel: string, key: string, label: string, value: string, note = '') {
  return `<div class="opt${sel}"><span class="lab">${label}${note ? `<small>${note}</small>` : ''}</span>
    <span class="ctl"><button data-act="${key}:-1" aria-label="Previous">◀</button><b data-act="${key}:1">${value}</b><button data-act="${key}:1" aria-label="Next">▶</button></span></div>`;
}
/** Online: the room menu (host or join), then the lobby once you're in a room. */
function renderOnlineMenu() {
  const rows = menuRows();
  if (rows.length && !rows.includes(MENU_ROWS[menuRow])) menuRow = MENU_ROWS.indexOf(rows[rows.length - 1] as typeof MENU_ROWS[number]);
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const envName = settings.env === SPACE_ENV ? `${SPACE_ARENA.name} (space)` : settings.env === ARENAS.length ? 'Random' : ARENAS[settings.env].name;
  const note = onlineNote ? `<p class="note">${esc(onlineNote)}</p>` : '';
  const compact = compactQ.matches;
  const hint = online.active ? menuHint('start') : isTouch ? '' : `<p class="hint">${kb('↑', '↓')} choose · ${kb('Enter')} on a row to join or host · type to set your name</p>`;
  const view = `${sect('View')}${leadRow(sel('lead'))}${downcamRow(sel('downcam'))}${viewRow(sel('view'))}${tiltRow(sel('tilt'))}`;
  let body = '';
  if (!online.active) {
    const name = `<div class="opt"><label class="lab" for="nameIn">Your name</label><span class="ctl"><input id="nameIn" maxlength="16" placeholder="Bird" value="${esc(settings.name)}" autocomplete="off" spellcheck="false"></span></div>`;
    const rooms = hasRoomBrowser() ? `${sect('Open rooms')}<div class="rooms${sel('rooms')}" id="roomList">${roomListHtml()}</div>` : '';
    const join = `${sect('Join with a code')}
    <div class="opt join${sel('join')}"><input id="codeIn" class="code" maxlength="8" placeholder="CODE" value="${esc(settings.code)}" autocomplete="off" autocapitalize="characters" spellcheck="false"><button data-act="join" class="go-btn">Join</button></div>
    ${note}`;
    const vis = hasRoomBrowser() ? visRow(sel('vis')) : '';
    const host = `<button data-act="host" class="go-btn cta${sel('host')}">Host a room</button>`;
    if (compact) {
      // left: who you are and the two ways in; right: the open rooms and the settings
      hud.overlay.innerHTML = splitMenu(`${modeRow(sel('mode'))}${name}${join}${host}`, `${rooms}${vis ? sect('Your room') + vis : ''}${view}${helpRow(sel('help'))}`, hint);
      bindOnlineInputs();
      return;
    }
    body = `${modeRow(sel('mode'))}
    <p class="blurb">${hasRoomBrowser() ? MODE_BLURB.online : 'Fight in the arena with friends anywhere: different houses, Wi-Fi or phone data. One of you hosts a room and shares its code; everyone else joins with it.'}</p>
    ${name}
    ${rooms}
    ${join}
    ${sect('Host your own')}
    ${vis}
    ${host}
    ${view}
    ${helpRow(sel('help'))}`;
  } else if (online.phase === 'connecting') {
    body = `<p class="blurb center">${online.isHost ? 'Opening a room…' : `Joining room <b>${esc(online.code)}</b>…`}</p>
    <div class="btns"><button data-act="leave">Cancel</button></div>`;
  } else {
    const li = (p: { id: string; name: string }) => `<li><i style="background:${PLAYER_CSS[colorIndex(p.id)]}"></i>${esc(p.name)}${p.id === online.myId ? ' <em>you</em>' : ''}${p.id === 'p0' ? ' <em>host</em>' : ''}</li>`;
    // Team up: the players split into their two teams, and everyone picks theirs
    const players = online.teams
      ? TEAM_NAMES.map((tn, k) => `<li class="teamhead" style="color:${TEAM_CSS[k]}">${tn} team</li>${online.roster().filter((p) => p.team === k).map(li).join('') || '<li class="empty">nobody yet</li>'}`).join('')
      : online.roster().map(li).join('');
    const teamPick = online.teams ? pickRow(sel('team'), 'team', 'Your team', `<span style="color:${TEAM_CSS[online.team]}">${TEAM_NAMES[online.team]}</span>`, 'Teammates can\'t hit each other') : '';
    const match = online.isHost ? `
      ${sect('Match')}
      ${hasRoomBrowser() ? visRow(sel('vis')) : ''}
      ${pickRow(sel('env'), 'env', 'Arena', envName)}
      ${pickRow(sel('bots'), 'bots', 'AI birds', settings.bots ? `${settings.bots} per wave` : 'None')}
      ${pickRow(sel('allies'), 'allies', 'Players', settings.allies ? 'Team up' : 'Free for all', settings.allies ? 'Red vs Blue: everyone picks a team' : '')}
      ${pickRow(sel('myDarts'), 'myDarts', 'Player darts', onOff(settings.myDarts))}
      ${pickRow(sel('enemyDarts'), 'enemyDarts', 'AI darts', onOff(settings.enemyDarts))}` : '';
    const start = online.isHost ? `<button data-act="go" class="go-btn cta${sel('go')}">Start match</button>` : '<p class="blurb center wait">Waiting for the host to start…</p>';
    const room = `<p class="sect center">Room code</p>
    <div class="roomcode">${esc(online.code)}</div>
    <div class="btns"><button data-act="copy">Copy invite link</button><button data-act="leave">Leave</button></div>
    ${note}
    ${sect(`Players · ${online.roster().length}`)}
    <ul class="players">${players}</ul>
    ${teamPick}`;
    if (compact) {
      // left: the room, who's in and the start button; right: the match settings
      hud.overlay.innerHTML = splitMenu(room + start, match + view, hint);
      bindOnlineInputs();
      return;
    }
    body = `${room}${match}${view}${start}`;
  }
  hud.overlay.innerHTML = `<div class="menu side"><h1>Glide!</h1><div class="panel">${body}</div>
    ${hint}</div>`;
  bindOnlineInputs();
}
function bindOnlineInputs() {
  showControls();
  revealSel();
  if (browsing() && !roomsLive) refreshRooms();
  const nameIn = document.getElementById('nameIn') as HTMLInputElement | null;
  const codeIn = document.getElementById('codeIn') as HTMLInputElement | null;
  nameIn?.addEventListener('input', () => { settings.name = nameIn.value.slice(0, 16); saveSettings(); });
  codeIn?.addEventListener('input', () => { codeIn.value = cleanCode(codeIn.value); settings.code = codeIn.value; });
  for (const el of [nameIn, codeIn]) el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { el.blur(); onlineAction(el === codeIn ? 'join' : 'host'); }
    if (e.key === 'Escape') el.blur();
  });
}
function onlineAction(act: string) {
  audio.start();
  onlineNote = '';
  const name = (settings.name || '').trim() || 'Bird';
  if (act === 'host') { online.host(name, settings.public, settings.allies); renderMenu(); }
  else if (act === 'join') {
    if (cleanCode(settings.code).length < 4) { onlineNote = 'Type the room code your friend gave you.'; renderMenu(); (document.getElementById('codeIn') as HTMLInputElement | null)?.focus(); return; }
    online.join(settings.code, name); renderMenu();
  } else if (act === 'leave') { online.leave(); renderMenu(); }
  else if (act === 'copy') {
    const link = inviteLink();
    navigator.clipboard?.writeText(link).then(() => { onlineNote = 'Invite link copied. Send it to your friends.'; renderMenu(); },
      () => { onlineNote = `Invite link: ${link}`; renderMenu(); });
    if (!navigator.clipboard) { onlineNote = `Invite link: ${link}`; renderMenu(); }
  } else if (act === 'go' && online.isHost && online.phase === 'lobby') {
    const rules: MatchRules = { seed: (Math.random() * 2 ** 31) | 0, arena: settings.env < ARENAS.length ? settings.env : Math.floor(Math.random() * ARENAS.length),
      bots: settings.bots, myDarts: settings.myDarts, enemyDarts: settings.enemyDarts, allies: settings.allies, space: settings.env === SPACE_ENV };
    online.start(rules);
  }
}
let previewTimer = 0;
/** Rebuild the world behind the title so it shows the chosen mode / arena. */
function queuePreview() { clearTimeout(previewTimer); previewTimer = window.setTimeout(() => { if (mode === 'title') spawn(true); }, 220); }
const MODES: GameMode[] = MODE_TABS.map((m) => m.id);
/** Which world the title shows behind the menu: 0 = mountain, 1 = an arena, 2 = space. */
const worldKind = (m: GameMode) => (m === 'endless' ? 0 : m === 'space' || (m === 'online' && settings.env === SPACE_ENV) ? 2 : 1);
function menuChange(row: string, d: number) {
  if (row === 'mode') {
    const m = MODES[THREE.MathUtils.clamp(MODES.indexOf(settings.mode) + d, 0, MODES.length - 1)];
    if (m !== settings.mode) { const was = worldKind(settings.mode), now = worldKind(m); settings.mode = m; loadBest(); if (was !== now) queuePreview(); showControlsSafe(); }
  }
  else if (row === 'bots') settings.bots = THREE.MathUtils.clamp(settings.bots + d, 0, 12);
  else if (row === 'allies') { settings.allies = !settings.allies; online.setTeams(settings.allies); }
  else if (row === 'team') { if (online.teams) online.pickTeam(online.team ? 0 : 1); }
  else if (row === 'lead') settings.lead = !settings.lead;
  else if (row === 'help') settings.help = !settings.help;
  else if (row === 'downcam') settings.downcam = DOWNCAM_OPTS[(DOWNCAM_OPTS.indexOf(settings.downcam) + d + DOWNCAM_OPTS.length) % DOWNCAM_OPTS.length];
  else if (row === 'vis') { if (online.active) online.setPublic(!online.isPublic); else settings.public = !settings.public; }
  else if (row === 'rooms') { if (openRooms.length) roomSel = (roomSel + d + openRooms.length) % openRooms.length; }
  else if (row === 'env') {
    // the online lobby can also pick space; the offline arena menu can't (space has its own mode)
    const n = settings.mode === 'online' ? SPACE_ENV + 1 : ARENAS.length + 1;
    settings.env = (Math.min(settings.env, n - 1) + d + n) % n; queuePreview();
  }
  else if (row === 'tilt') { settings.tilt = isTouch && !settings.tilt; input.tilt = settings.tilt; if (input.motion === 'denied') input.motion = 'unknown'; showControlsSafe(); }
  else if (row === 'view') settings.view = settings.view === 'cockpit' ? 'chase' : 'cockpit';
  else if (row === 'myDarts') settings.myDarts = !settings.myDarts;
  else if (row === 'enemyDarts') settings.enemyDarts = !settings.enemyDarts;
  else if (row === 'enemies') settings.enemies = THREE.MathUtils.clamp(settings.enemies + d, 1, 12);
  saveSettings(); renderMenu();
}
let startReq = false, menuReq = false;
// The mouse acts on press. A finger acts when it lifts without having moved, so dragging to scroll the menu
// never flips a setting on the way.
let tap: { id: number; x: number; y: number } | null = null;
hud.overlay.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') menuAct(e.target as HTMLElement);
  else tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
hud.overlay.addEventListener('pointerup', (e) => {
  if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 14) menuAct(e.target as HTMLElement);
  tap = null;
});
hud.overlay.addEventListener('pointercancel', () => { tap = null; });
function menuAct(target: HTMLElement) {
  const act = target.closest('[data-act]')?.getAttribute('data-act');
  if (!act) return;
  audio.start();
  const [k, v] = act.split(':');
  if (['go', 'host', 'join', 'joinroom'].includes(k)) goLandscape();
  if (k === 'joinroom') { settings.code = cleanCode(v); onlineAction('join'); return; }
  if (settings.mode === 'online' && ['host', 'join', 'leave', 'copy', 'go'].includes(k)) { onlineAction(k); return; }
  if (k === 'go') startReq = true;
  else if (k === 'menu') menuReq = true;
  else if (k === 'mode') { menuRow = 0; menuChange('mode', MODES.indexOf(v as GameMode) - MODES.indexOf(settings.mode)); }
  else { menuRow = MENU_ROWS.indexOf(k as typeof MENU_ROWS[number]); menuChange(k, Number(v)); }
}
function goToMenu() {
  if (online.phase === 'playing') online.leave();
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
  const gp = input.activePad as any;
  gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
}

// ---------- Game state ----------
type Mode = 'title' | 'flying' | 'crashed';
let mode: Mode = 'title';
let score = 0, combo = 0, comboTimer = 0, slowmo = 0, crashTimer = 0, shake = 0;
let startZ = 0;
const near = new Map<string, { gap: number; type: string }>(); // obstacle id -> closest gap while passing
const prevPos = new THREE.Vector3();
let trickMinClear = 99, loopMinClear = 99, tunnelChain = 0, inCanyonRun = false, wasInCloud = false;
let inLoop = false;
let waveClearedT = 0, outOfBounds = 0;
let hp = 3, hpRegen = 0, hitFlash = 0, dodgeCd = 0, warnBeep = 0, dartHint = 0;
let wasLocked: unknown = null;
// online: who last hit you (for the kill credit if you then crash), spawn protection, kill feed
let lastAttacker = '', lastHitT = -99, spawnShield = 0;
const feed: { text: string; t: number }[] = [];
const cloudsHit = new Set<string>();
const nearby: Obstacle[] = [];

// ---------- Down cam: replay the last 3 s from the killer's chase camera when you go down ----------
const downcam = new DownCam();
// the dogfight's pooled pea and dart meshes (read only: for the replay recording)
const dfPools = dogfight as unknown as { peas: { mesh: THREE.Object3D }[]; myDarts: { mesh: THREE.Object3D }[] };
const poolMeshes = [...dfPools.peas.map((p) => p.mesh), ...dfPools.myDarts.map((d) => d.mesh)];
const trackedNow = (): Tracked => ({
  birds: [bird, ...dogfight.enemies.map((e) => e.mesh)],
  shots: [...poolMeshes, ...dogfight.darts.map((d) => d.mesh)],
  extra: [shadow],
  puffs: puffs.mesh,
});
const downcamEl = $('downcam');
/** Set by crash(): start the replay at the end of this frame, once the moment of the hit is recorded. */
let downcamReq: { by: string; how: 'pea' | 'dart' | 'crash' } | null = null;
/** Online: when you're back in the air (pushed back while the replay plays). Offline: when the replay ended. */
let respawnAt = 3, downcamEndT = 0;

/** Best guess at which bird got you when the shot itself can't be found: whoever had its nose on you. */
function aimGuess(): THREE.Object3D | null {
  let best: THREE.Object3D | null = null, bestS = 0.35;
  for (const e of dogfight.enemies) {
    if (e.friendly || !e.mesh.visible) continue;
    const to = tmp.copy(glider.pos).sub(e.mesh.position);
    const d = to.length();
    if (d < 1 || d > 450) continue;
    const s = new THREE.Vector3(0, 0, -1).applyQuaternion(e.mesh.quaternion).dot(to.divideScalar(d)) - d / 700;
    if (s > bestS) { bestS = s; best = e.mesh; }
  }
  return best;
}

function beginDownCam(by: string, how: 'pea' | 'dart' | 'crash') {
  if (settings.downcam === 'off' || !downcam.ready) return false;
  let viewer: THREE.Object3D | null = null;
  // another player: we know exactly which bird is theirs
  if (by && by !== 'ai' && by !== 'me') viewer = dogfight.enemies.find((e) => e.remote === 'human' && e.netId === by)?.mesh ?? null;
  // an AI bird: follow the pea or dart that hit you back to whoever fired it
  if (!viewer && how !== 'crash') viewer = downcam.findShooter(bird) ?? aimGuess();
  // chased into the ground by someone who hit you a moment ago
  if (!viewer && how === 'crash' && by) viewer = aimGuess();
  if (!viewer && settings.downcam !== 'all') return false;
  if (!downcam.start(bird, viewer)) return false;
  const e = viewer ? dogfight.enemies.find((x) => x.mesh === viewer) : undefined;
  const who = !viewer ? 'Your crash'
    : e?.remote === 'human' ? `${esc(online.nameOf(e.netId))}'s view`
    : e?.role === 'prey' ? 'The bandit\'s view' : 'The hunter\'s view';
  $('downcamWho').innerHTML = who;
  if (e?.remote === 'human') $('downcamWho').style.color = PLAYER_CSS[colorIndex(e.netId)];
  else $('downcamWho').style.color = '';
  $('downcamSkip').textContent = isTouch ? 'Tap to skip' : 'Press any key to skip';
  downcamEl.classList.add('on');
  hud.overlay.classList.add('hidden');
  if (online.phase === 'playing') respawnAt = Math.max(3, crashTimer + downcam.duration + 0.6);
  return true;
}
/** The replay is over (or skipped): show the usual "downed" screen. */
function endDownCam() {
  downcam.stop();
  downcamEl.classList.remove('on');
  downcamEndT = crashTimer;
  if (online.phase === 'playing') respawnAt = Math.max(3, crashTimer + 1);
  if (mode === 'crashed') hud.overlay.classList.remove('hidden');
}
function resetDownCam() { downcam.clear(); downcamReq = null; downcamEl.classList.remove('on'); respawnAt = 3; downcamEndT = 0; }

function spawn(fresh = true) {
  input.recenter(); input.setThrottle(0);
  const arena = settings.mode !== 'endless';
  const space = worldKind(settings.mode) === 2;
  dogfight.spawning = true; dogfight.targets = [];
  // "random" rolls a new arena each fresh match
  if (arena && !space) arenaIdx = settings.env < ARENAS.length ? settings.env : fresh || !getArena() || isSpace() ? Math.floor(Math.random() * ARENAS.length) : arenaIdx;
  const env = space ? SPACE_ARENA : arena ? ARENAS[arenaIdx] : null;
  const arenaChanged = env !== getArena();
  setArena(env);
  applyLook();
  if (fresh || arenaChanged) { setWorldSeed((Math.random() * 2 ** 31) | 0); route.reset(); world.reset(); if (space) { buildField(); spaceScene.rebuild(); } }
  if (space) {
    // fly in from the east end of the open lane between the two fleets, at a height with a clear run ahead
    const x = SPACE_R * 0.75;
    glider.reset(x, clearSpawnY(x, 0, tmp.set(-1, 0, 0)), 0, Math.PI / 2);
  } else if (arena) {
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
  puffs.clear(); resetDownCam();
  dogfight.playerDarts = settings.myDarts; dogfight.enemyDarts = settings.enemyDarts;
  dogfight.reset(); hp = 3; hpRegen = 0; hitFlash = 0;
  dogfight.arenaCount = arena ? settings.enemies : 0;
  // build the opening stretch straight away
  for (let i = 0; i < 10 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; i++);
  placeCamera(true);
}

/** Online: the host started the match (or you joined one in progress). Everyone builds the same arena from the same seed. */
function startOnlineMatch(rules: MatchRules) {
  clearTimeout(previewTimer);
  arenaIdx = THREE.MathUtils.clamp(rules.arena, 0, ARENAS.length - 1);
  setArena(rules.space ? SPACE_ARENA : ARENAS[arenaIdx]);
  applyLook();
  setWorldSeed(rules.seed); route.reset(rules.seed % 1000000); world.reset();
  if (rules.space) { buildField(); spaceScene.rebuild(); }
  puffs.clear(); gates.reset();
  dogfight.playerDarts = rules.myDarts; dogfight.enemyDarts = rules.enemyDarts;
  dogfight.reset();
  dogfight.spawning = online.isHost && rules.bots > 0;
  dogfight.arenaCount = rules.bots;
  score = 0; combo = 0; comboTimer = 0;
  feed.length = 0;
  respawnOnline();
}
/** Online: back into the air at a random spot on the rim, with full feathers and darts. The fight carries on. */
function respawnOnline() {
  input.recenter(); input.setThrottle(0);
  const sp = online.spawnPoint();
  glider.reset(sp.x, sp.y, sp.z, sp.heading);
  startZ = glider.pos.z; prevPos.copy(glider.pos);
  near.clear(); trickMinClear = 99; inLoop = false; wasInCloud = false; slowmo = 0; shake = 0;
  hp = 3; hpRegen = 0; hitFlash = 0; lastAttacker = ''; lastHitT = -99; spawnShield = 2.5;
  dogfight.dartsLeft = online.rules?.myDarts ? MAX_DARTS : 0; dogfight.dartCharge = 0;
  dogfight.locked = null; dogfight.locking = null; dogfight.lockT = 0;
  for (const d of dogfight.darts) d.tracking = false;
  for (let i = 0; i < 10 && world.update(glider.pos.x, glider.pos.z, 8) > 0; i++);
  online.alive = true; resetDownCam();
  mode = 'flying'; hud.overlay.classList.add('hidden');
  placeCamera(true);
}

/** Another player's colour on the HUD: their team's in Team up, their own otherwise. */
const humanCss = (id: string) => (online.teams && online.teamOf(id) >= 0 ? TEAM_CSS[online.teamOf(id)] : PLAYER_CSS[colorIndex(id)]);
dogfight.isAlly = (owner) => online.phase === 'playing' && online.isAlly(owner);
/** Team up with no AI birds: the score, team against team. */
function teamBanner() {
  const k = [0, 0]; for (const p of online.roster()) k[p.team ? 1 : 0] += p.kills;
  return `${TEAM_NAMES[0].toUpperCase()} ${k[0]} · ${k[1]} ${TEAM_NAMES[1].toUpperCase()}`;
}
function myDartsOn() { return online.phase === 'playing' ? !!online.rules?.myDarts : settings.myDarts; }

function multiplier() { return 1 + Math.min(combo, 8) * 0.5; }

function addCloseCall(gap: number, label: string) {
  combo++; comboTimer = 4;
  const pts = Math.round((60 + (3.5 - gap) * 80) * multiplier());
  score += pts;
  const veryClose = gap < 1.2;
  // flying dangerously pays: a slipstream speed kick and a chunk of dart recharge, more the closer you cut it
  const kick = veryClose ? 7 : 3 + (3.5 - gap) * 1.2;
  // (space: no slipstream off a hull in a vacuum, and boost only comes from pickups)
  if (!isSpace()) glider.speed = Math.min(95, glider.speed + kick);
  const refilled = dogfight.chargeDart(veryClose ? 0.5 : 0.25);
  const perks = isSpace() ? (refilled ? 'MISSILE RELOADED' : '') : `+${Math.round(kick * 3.6)} km/h${refilled ? ' · DART RELOADED' : ''}`;
  popup(veryClose ? `INSANE! +${pts}` : `Close call +${pts}`, `${label} · ${gap.toFixed(1)} m${perks ? ` · ${perks}` : ''}`);
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

// ---------- Your bird going down: it falls and tumbles like the AI birds, then comes to rest ----------
const fallVel = new THREE.Vector3();
const fallDir = new THREE.Vector3(0, 0, -1);
let fallSpin = 0, fallSettled = false, fallSmoke = false;
const fallM = new THREE.Matrix4(), fallQ = new THREE.Quaternion(), FALL_ORIGIN = new THREE.Vector3(), Z_AXIS = new THREE.Vector3(0, 0, 1);
/** `wall`: you flew into a tree, rock or pillar (you bounce back off it). */
function startFall(shot: boolean, wall: boolean) {
  const v = Math.max(glider.speed, 12);
  if (shot) fallVel.copy(glider.dir).multiplyScalar(v);               // carries on, then drops
  else if (wall) fallVel.copy(glider.dir).multiplyScalar(-0.12 * v).setY(3); // knocked back off it
  else { fallVel.copy(glider.dir).multiplyScalar(0.3 * v); fallVel.y = Math.abs(fallVel.y) * 0.4 + 4; } // skids and bounces
  fallDir.copy(glider.dir);
  fallSpin = 0; fallSettled = false; fallSmoke = shot;
}
function updateFall(dt: number) {
  const p = glider.pos;
  if (isSpace() && !fallSettled) {
    // no gravity: the wreck drifts on, tumbling end over end and trailing smoke, until it hits something
    fallVel.multiplyScalar(Math.exp(-0.25 * dt));
    p.addScaledVector(fallVel, dt);
    fallSpin += dt * 3;
    if (fallVel.lengthSq() > 0.25) fallDir.copy(fallVel).normalize().applyAxisAngle(WORLD_UP, Math.sin(fallSpin * 0.7) * 0.6).normalize();
    const ground = terrainHeight(p.x, p.z) + 0.45;
    if (p.y < ground) { p.y = ground; fallVel.set(0, 0, 0); fallSettled = true; puffs.burst(p, tmp.set(0, 3, 0), 8, 20, 1.2); }
    glider.speed = fallVel.length();
    return;
  }
  if (!fallSettled) {
    fallVel.y -= 18 * dt;
    fallVel.multiplyScalar(Math.exp(-0.3 * dt));
    p.addScaledVector(fallVel, dt);
    const ground = terrainHeight(p.x, p.z) + 0.45;
    if (p.y < ground) {
      p.y = ground;
      if (fallVel.y < -6) { puffs.burst(p, tmp.set(0, 4, 0), 4, 10, 0.8); audio.thud(); shake = Math.max(shake, 0.5); }
      fallVel.set(fallVel.x * 0.45, Math.abs(fallVel.y) * 0.2, fallVel.z * 0.45);
      if (fallVel.length() < 2.5) { fallSettled = true; fallVel.set(0, 0, 0); fallDir.y = 0; if (fallDir.lengthSq() < 1e-4) fallDir.set(0, 0, -1); fallDir.normalize(); }
    }
    if (fallVel.lengthSq() > 1) fallDir.lerp(tmp.copy(fallVel).normalize(), 1 - Math.exp(-5 * dt)).normalize();
    fallSpin += dt * 8 * Math.min(1, fallVel.length() / 10);
    // shot down: trails smoke and feathers all the way down
    if (fallSmoke && Math.random() < 30 * dt) puffs.burst(p, tmp.set(0, 2, 0), 2, 1, 0.7);
  }
  glider.speed = fallVel.length();
}
/** Point the bird mesh nose-first along its fall, spinning about its own length. */
function poseFall() {
  const d = fallDir;
  fallM.lookAt(FALL_ORIGIN, d, Math.abs(d.y) > 0.98 ? Z_AXIS : WORLD_UP); // (a matrix lookAt points -Z, the beak, at the target)
  bird.quaternion.setFromRotationMatrix(fallM).multiply(fallQ.setFromAxisAngle(Z_AXIS, fallSpin));
}

function crash(title = 'Crunch!', how: 'pea' | 'dart' | 'crash' = 'crash', wall = false) {
  mode = 'crashed'; crashTimer = 0; shake = 1;
  if (isSpace() && title === 'Crunch!') title = wall ? 'Kaboom!' : 'Planetfall!';
  startFall(how !== 'crash', wall);
  if (isSpace()) sfx.explode(glider.pos, glider.vel, 1.3); // blown apart
  audio.thud(); rumble(1, 300);
  // whoever hit you in the last few seconds gets the credit (and the down cam watches from their bird)
  const by = how !== 'crash' || t - lastHitT < 6 ? lastAttacker : '';
  downcamReq = { by, how };
  if (online.phase === 'playing') {
    // online: no game over, you're straight back in
    online.downed(by, how);
    const who = by && by !== 'ai' ? esc(online.nameOf(by)) : by === 'ai' ? 'a wild bird' : '';
    hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center">${who ? `<p>by <b>${who}</b></p>` : ''}<p class="big">${online.kills} down · ${online.deaths} time${online.deaths === 1 ? '' : 's'} downed</p><div class="go" id="respawnIn">Back in the air in 3…</div><div class="btns"><button data-act="menu">${isTouch ? 'Leave room' : 'Leave room (Esc)'}</button></div></div></div>`;
    setTimeout(() => { if (mode === 'crashed' && !downcam.playing) hud.overlay.classList.remove('hidden'); }, 500);
    return;
  }
  const final = Math.floor(score);
  const isBest = final > best;
  if (isBest) { best = final; try { localStorage.setItem(bestKey(), String(best)); } catch { /* ignore */ } }
  const dist = Math.round(startZ - glider.pos.z);
  const what = getArena()
    ? `${getArena()!.name} · wave ${Math.max(1, dogfight.wave)} · ${dogfight.kills} shot down`
    : `${dist} m downhill${dogfight.kills ? ` · ${dogfight.kills} shot down` : ''}`;
  hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center"><p class="score"><b>${final}</b><span>points</span></p><p>${what}</p><p class="best${isBest ? ' new' : ''}">${isBest ? 'New best!' : `Best: ${best}`}</p><div class="go">${isTouch ? 'Tap to fly again' : 'Press any key or button to fly again'}</div><div class="btns"><button data-act="menu">${isTouch ? 'Menu' : 'Menu (Esc / B)'}</button></div></div></div>`;
  setTimeout(() => { if (mode === 'crashed' && !downcam.playing) hud.overlay.classList.remove('hidden'); }, 700);
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
      if (online.phase === 'playing') {
        // online host: an AI bird went down. Credit whoever hit it last (or chased it into the ground);
        // points arrive with the credit ('scored').
        const e = ev.enemy;
        if (online.isHost) online.aiKilled(e, e.lastHitBy || e.targetId, ev.ground);
        break;
      }
      combo++; comboTimer = 4;
      const pts = Math.round((ev.role === 'hunter' ? 600 : 450) * (ev.ground ? 1.5 : 1) * multiplier());
      score += pts;
      popup(ev.ground ? `Ground kill! +${pts}` : `Shot down! +${pts}`, `${ev.role === 'hunter' ? 'hunter' : 'bandit'} · ${dogfight.kills} down`);
      audio.thud(); audio.whoosh(0.8); rumble(0.6, 200); slowmo = 0.4;
      break;
    }
    case 'hitPlayer':
      if (spawnShield > 0) break;
      lastAttacker = ev.by; lastHitT = t;
      if (online.phase === 'playing' && ev.by !== 'ai') online.net.send({ t: 'hitok', to: ev.by }); // a hit marker for them
      hp--; hpRegen = 0; hitFlash = 1; shake = Math.max(shake, 0.6);
      rumble(0.9, 180);
      if (isSpace()) { audio.shieldHit(); sfx.shieldHit(bird, tmp.randomDirection().multiplyScalar(3).add(glider.pos), BOLT_RED, 4.6); }
      else { audio.thud(); puffs.burst(glider.pos, glider.vel.clone().multiplyScalar(0.3), 3, 10, 0.5); }
      if (hp <= 0) crash('Shot down!', 'pea');
      else popup('Hit!', isSpace() ? (hp > 1 ? 'shields down: hull taking fire' : 'HULL CRITICAL') : `${hp} feather${hp > 1 ? 's' : ''} left`);
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
      if (myDartsOn()) { dogfight.dartsLeft = MAX_DARTS; dogfight.dartCharge = 0; }
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
      if (spawnShield > 0) break;
      lastAttacker = ev.by ?? 'ai'; lastHitT = t;
      // a dart is a one-hit kill, whatever feathers you have left
      hp = 0; hpRegen = 0; hitFlash = 1; shake = Math.max(shake, 0.9);
      rumble(1, 260); audio.thud();
      if (!isSpace()) puffs.burst(glider.pos, glider.vel.clone().multiplyScalar(0.3), 4, 16, 0.7);
      crash(isSpace() ? 'Missile hit!' : 'Darted!', 'dart');
      break;
    case 'netHit': online.netHit(ev.enemy, ev.weapon); break;
    case 'netDart': online.sendDart(ev.to, ev.pos, ev.dir, ev.speed, ev.ai ? 'ai' : online.myId); break;
  }
  if (online.isHost && online.phase === 'playing') {
    if (ev.type === 'wave') online.waveEvent(ev.wave, ev.count, false);
    if (ev.type === 'waveCleared') online.waveEvent(ev.wave, 0, true);
  }
}

// ---------- Dogfight HUD: tail radar, reticles, feathers ----------
const radar = $('radar') as HTMLCanvasElement;
const rctx = radar.getContext('2d')!;
const RADAR_RANGE = 300;
const rets: HTMLElement[] = [];
function drawDogfightHud(show: boolean) {
  radar.style.opacity = show ? '1' : '0';
  if (isSpace()) {
    // space: hull integrity as three bars
    const key = show ? `s${hp}` : '';
    if (hud.hp.dataset.k !== key) { hud.hp.dataset.k = key; hud.hp.innerHTML = show ? `HULL ${Array.from({ length: 3 }, (_, i) => `<i${i < hp ? '' : ' class="off"'}></i>`).join('')}` : ''; }
    hud.hp.classList.toggle('crit', hp === 1);
  } else { hud.hp.dataset.k = ''; hud.hp.textContent = show ? '♥'.repeat(Math.max(0, hp)) + '♡'.repeat(Math.max(0, 3 - hp)) : ''; }
  // dart ammo: one pip per dart, the next one fills as it recharges
  hud.darts.style.opacity = show && myDartsOn() ? '1' : '0';
  if (show && myDartsOn()) {
    const pips = Array.from({ length: MAX_DARTS }, (_, i) =>
      i < dogfight.dartsLeft ? '<i></i>' : i === dogfight.dartsLeft ? `<i class="cd" style="--p:${Math.round(dogfight.dartCharge * 100)}%"></i>` : '<i class="off"></i>').join('');
    hud.darts.innerHTML = `${pips}<b>${isSpace() ? 'MISSILES' : 'DARTS'}${dogfight.locked && dogfight.dartsLeft ? ' · R' : ''}</b>`;
    hud.darts.classList.toggle('ready', !!dogfight.locked && dogfight.dartsLeft > 0);
    $('dartBtn').textContent = `${isSpace() ? 'MSL' : 'DART'} ${dogfight.dartsLeft}`;
    $('dartBtn').classList.toggle('dim', !dogfight.locked || dogfight.dartsLeft === 0);
  }
  const threat = show ? Math.max(dogfight.tailThreat, dogfight.dartLockProgress) : 0;
  hud.warn.style.opacity = mode === 'flying' && glider.stalled ? String(0.6 + 0.4 * Math.sin(t * 16)) : threat > 0 ? String((0.55 + 0.45 * Math.sin(t * (8 + threat * 14))) * Math.min(1, 0.4 + threat)) : '0';
  const DW = isSpace() ? 'MISSILE' : 'DART';
  hud.warn.textContent = mode === 'flying' && glider.stalled ? '▼ STALL: DIVE TO GAIN SPEED ▼' : !show ? '' : dogfight.dartIncoming < Infinity ? `▲ ${DW} ${Math.round(dogfight.dartIncoming)} m: BREAK! ▲`
    : dogfight.dartLockProgress > 0 ? `▼ ${DW} LOCK ${Math.round(dogfight.dartLockProgress * 100)}% ▼`
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
      c.fillStyle = e.remote === 'human' ? humanCss(e.netId) : e.role === 'hunter' ? '#ff5a4a' : '#ffb347';
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
    // with your darts switched off there's nothing to lock with, so no lock-on markings
    const myLock = myDartsOn() && e === dogfight.locked, myLocking = myDartsOn() && e === dogfight.locking;
    const mine = myLock ? ' mylocked' : myLocking ? ' mylocking' : '';
    el.className = `ret ${e.role}${locking ? ' lock' : ''}${mine}${e.friendly ? ' ally' : ''}`;
    el.style.borderColor = e.remote === 'human' && !mine ? humanCss(e.netId) : '';
    el.style.setProperty('--c', e.remote === 'human' && !mine ? humanCss(e.netId) : '');
    el.style.setProperty('--hp', `${Math.round(THREE.MathUtils.clamp(e.hp / e.maxHp, 0, 1) * 100)}%`);
    el.style.display = 'block';
    el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
    const dist = Math.round(e.pos.distanceTo(glider.pos));
    const who = e.remote === 'human' ? online.remotes.get(e.netId)?.name ?? '' : '';
    (el.firstChild as HTMLElement).textContent = locking ? `LOCKING YOU ${dist} m` : myLock ? `LOCKED ${dist} m` : myLocking ? `LOCK ${Math.round(dogfight.lockT * 100)}%` : who ? `${who}${e.friendly ? ' · ally' : ''} · ${dist} m` : `${dist} m`;
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
    (el.firstChild as HTMLElement).textContent = `${isSpace() ? 'MISSILE' : 'DART'} ${Math.round(d.pos.distanceTo(glider.pos))} m`;
  }
  for (let i = n; i < rets.length; i++) rets[i].style.display = 'none';
  drawLeads(show && settings.lead);
  drawSpaceHud(show && isSpace());
}

// ---------- Space HUD: the flight reticle and the off-screen arrows ----------
const sret = $('sret'), offs: HTMLElement[] = [];
const sretThr = $('sretThr'), sretFuel = $('sretFuel'), sretSpd = $('sretSpd');
const ARC = 78.54; // a quarter of the reticle's circle
const camLocal = new THREE.Vector3();
function drawSpaceHud(show: boolean) {
  sret.style.display = show ? 'block' : 'none';
  let n = 0;
  if (show) {
    // the reticle sits where your guns converge, out ahead of the nose
    const v = tmp.copy(glider.pos).addScaledVector(glider.dir, 250).project(camera);
    sret.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
    const thr = THREE.MathUtils.clamp((glider.speed - 22) / (SPACE_BOOST - 22), 0, 1);
    sretThr.setAttribute('stroke-dasharray', `${(thr * ARC).toFixed(1)} 400`);
    sretThr.classList.toggle('boosting', glider.boost > 0.2);
    sretFuel.setAttribute('stroke-dasharray', `${(glider.boostFuel * ARC).toFixed(1)} 400`);
    sretFuel.classList.toggle('low', glider.boostFuel < 0.15);
    sret.classList.toggle('drift', glider.brake > 0.3);
    sretSpd.textContent = String(Math.round(glider.speed * 3.6));
    // fighters (and missiles) you can't see: an arrow round the reticle pointing the way to turn
    const R = Math.min(innerWidth, innerHeight) * 0.36, cx = innerWidth / 2, cy = innerHeight / 2;
    const arrow = (p: THREE.Vector3, cls: string) => {
      camLocal.copy(p).applyMatrix4(camera.matrixWorldInverse);
      const pr = tmp.copy(p).project(camera);
      if (camLocal.z < 0 && Math.abs(pr.x) < 0.95 && Math.abs(pr.y) < 0.9) return; // on screen
      let el = offs[n];
      if (!el) { el = document.createElement('div'); $('offs').appendChild(el); offs.push(el); }
      n++;
      const a = Math.atan2(camLocal.y, camLocal.x);
      el.className = `offarrow ${cls}`; el.style.display = 'block';
      el.style.transform = `translate(${cx + Math.cos(a) * R}px, ${cy - Math.sin(a) * R}px) rotate(${Math.PI / 2 - a}rad)`;
    };
    for (const e of dogfight.enemies) if (e.alive) arrow(e.pos, e === dogfight.locked ? 'locked' : e.role);
    for (const d of dogfight.darts) if (d.tracking) arrow(d.pos, 'dart');
  }
  for (let i = n; i < offs.length; i++) offs[i].style.display = 'none';
}

// ---------- Online HUD: scoreboard and kill feed ----------
let boardT = 0;
function drawOnlineHud(dt: number) {
  const on = online.phase === 'playing' && mode !== 'title';
  $('board').style.display = on ? 'block' : 'none';
  $('feed').style.display = on ? 'block' : 'none';
  if (!on) return;
  if ((boardT -= dt) > 0) return;
  boardT = 0.25;
  const rows = online.roster().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const row = (p: typeof rows[number]) =>
    `<div style="color:${PLAYER_CSS[colorIndex(p.id)]}"${p.id === online.myId ? ' class="me"' : ''}><span>${esc(p.name)}</span><i>${p.kills}</i><i class="d">${p.deaths}</i></div>`;
  // Team up: each team under its own heading with its total
  $('board').innerHTML = `<b>ROOM ${esc(online.code)}</b>` + (online.teams
    ? TEAM_NAMES.map((tn, k) => { const tm = rows.filter((p) => p.team === k); return tm.length ? `<div class="teamrow" style="color:${TEAM_CSS[k]}"><span>${tn}</span><i>${tm.reduce((a, p) => a + p.kills, 0)}</i><i class="d"></i></div>${tm.map(row).join('')}` : ''; }).join('')
    : rows.map(row).join(''));
  while (feed.length && t - feed[0].t > 6) feed.shift();
  $('feed').innerHTML = feed.map((f) => `<div>${esc(f.text)}</div>`).join('');
}

// ---------- Lead marker (optional): where to point your nose so a pea meets the bird ----------
// Your peas leave at PEA_SPEED on top of your own velocity, so in your frame of reference the bird moves at
// (its velocity - yours). Solve for the time a pea takes to reach where it will be, and mark that spot.
// Put the gun cross (where your peas go) on the ring and fire.
const LEAD_RANGE = 260;
const leadEls: HTMLElement[] = [];
const leadRel = new THREE.Vector3(), leadV = new THREE.Vector3(), leadP = new THREE.Vector3();
function drawLeads(on: boolean) {
  const cross = $('gunCross');
  let n = 0;
  if (on) {
    const muzzle = tmp.copy(glider.pos).addScaledVector(glider.dir, 1.6);
    const reach = (peaSpeed() + glider.speed) * peaLife(); // how far a pea flies
    for (const e of dogfight.enemies) {
      if (!e.alive || e.friendly) continue;
      leadRel.copy(e.pos).sub(muzzle);
      const dist = leadRel.length();
      if (dist > LEAD_RANGE || dist < 4) continue;
      leadV.copy(e.dir).multiplyScalar(e.speed).sub(glider.vel); // its motion relative to you
      const ps = peaSpeed();
      let tt = dist / ps;
      for (let i = 0; i < 4; i++) tt = leadP.copy(leadRel).addScaledVector(leadV, tt).length() / ps;
      leadP.copy(leadRel).addScaledVector(leadV, tt).add(muzzle);
      const v = leadP.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      let el = leadEls[n];
      if (!el) { el = document.createElement('div'); el.className = 'lead'; $('rets').appendChild(el); leadEls.push(el); }
      n++;
      el.style.display = 'block';
      el.style.borderColor = e.remote === 'human' ? humanCss(e.netId) : e.role === 'hunter' ? '#ff5a4a' : '#ffb347';
      el.style.opacity = dist <= reach ? '1' : '0.4'; // faded: out of pea range for now
      el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
    }
  }
  for (let i = n; i < leadEls.length; i++) leadEls[i].style.display = 'none';
  // the gun cross: where your peas are heading, at a typical fighting distance
  if (on && n > 0) {
    const v = tmp.copy(glider.pos).addScaledVector(glider.dir, 120).project(camera);
    cross.style.display = v.z <= 1 ? 'block' : 'none';
    cross.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight}px)`;
  } else cross.style.display = 'none';
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

/** First person: you're sitting in it. Only while flying (a crash goes back to the chase camera to watch). */
const firstPerson = () => settings.view === 'cockpit' && mode === 'flying';
function placeCamera(snap = false, dt = 0.016, lift = 0) {
  const g = glider;
  const fp = firstPerson();
  cockpit.visible = fp && isSpace(); beak.visible = fp && !isSpace();
  if (fp) {
    // eye just above and behind the nose; the view turns exactly with your flyer
    camera.quaternion.copy(bird.quaternion);
    camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position.copy(g.pos).addScaledVector(camera.up, isSpace() ? 0.42 : 0.3).addScaledVector(g.dir, isSpace() ? -0.4 : 0.6);
    if (shake > 0) camera.position.addScaledVector(tmp.set(Math.random() - 0.5, Math.random() - 0.5, 0).applyQuaternion(camera.quaternion), shake * 0.25);
    const fov = THREE.MathUtils.clamp(74 + (g.speed - (isSpace() ? SPACE_CRUISE : 30)) * 0.35, 68, 96);
    camera.fov += (fov - camera.fov) * Math.min(1, 3 * dt);
    camera.updateProjectionMatrix();
    // keep the chase camera's state current, so switching back doesn't swoop in from somewhere old
    camPos.copy(g.pos).addScaledVector(g.dir, -10); camLook.copy(g.pos).addScaledVector(g.dir, 10); camFwd.copy(g.dir); camUp.copy(camera.up);
    return;
  }
  // how much of the climb the camera should follow: none in a normal glide, all of it past ~50 degrees
  const steepWant = g.space || g.looping || g.trick?.type === 'half' ? 1 : THREE.MathUtils.smoothstep(g.free ? Math.abs(g.pitch) : g.pitch, 0.55, 0.95);
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
  // (space: there's no "down" to keep level with, so the camera rolls all the way with the ship)
  const upWant = g.space ? birdUp.clone() : g.free ? birdUp.clone().multiplyScalar(0.7).addScaledVector(WORLD_UP, 0.3)
    : camSteep > 0.999 ? birdUp.clone() : birdUp.clone().multiplyScalar(camSteep).addScaledVector(WORLD_UP, 1 - camSteep);
  if (upWant.lengthSq() < 1e-4) upWant.copy(birdUp);
  upWant.normalize();
  if (snap) camUp.copy(upWant);
  else rotateToward(camUp, upWant, camFwd, 1 - Math.exp(-7 * dt));
  camUp.projectOnPlane(camFwd).normalize();

  const dist = g.space ? 10 + Math.max(0, g.speed - SPACE_CRUISE) * 0.05 : 8.5 + camSteep * 2.5 + Math.max(0, g.speed - 30) * 0.06;
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
  const fov = g.space ? THREE.MathUtils.clamp(66 + (g.speed - SPACE_CRUISE) * 0.45, 60, 92) : THREE.MathUtils.clamp(62 + (g.speed - 25) * 0.55, 60, 98);
  camera.fov += (fov - camera.fov) * Math.min(1, 3 * dt);
  camera.updateProjectionMatrix();
}

// ---------- Main loop ----------
let last = performance.now();
let t = 0;
spawn(false);
renderMenu();

function onlineEvents() {
  for (const ev of online.drain()) {
    switch (ev.type) {
      case 'lobby': if (mode === 'title') renderMenu(); break;
      case 'start': onlineNote = ''; startOnlineMatch(ev.rules); break;
      case 'left':
        onlineNote = ev.reason;
        if (mode !== 'title') { settings.mode = 'online'; goToMenu(); } else renderMenu();
        break;
      case 'feed': feed.push({ text: ev.text, t }); if (feed.length > 5) feed.shift(); break;
      case 'scored': { const pts = Math.round(600 * multiplier()); score += pts; combo++; comboTimer = 4; audio.thud(); audio.whoosh(0.8); rumble(0.6, 200); break; }
      case 'hitConfirmed': audio.beep(1700, 0.03, 0.05); break;
      case 'wave': onDogfight(ev.cleared ? { type: 'waveCleared', wave: ev.wave } : { type: 'wave', wave: ev.wave, count: ev.count }); break;
      case 'dartIn':
        if (mode !== 'flying' || spawnShield > 0) break;
        dogfight.incomingDart(ev.pos, ev.dir, ev.speed, ev.by);
        onDogfight({ type: 'dartLaunch' });
        break;
    }
  }
}

function frame(now: number) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  const realDt = dt;
  last = now;
  // phone held upright: a solo game holds still behind the rotate card (an online match can't wait)
  if (portraitQ.matches && mode === 'flying' && online.phase !== 'playing') { input.poll(); render(); return; }
  input.lockScheme = online.active ? 'flight' : null; // online: everyone flies the same layout
  const inp = input.poll();
  document.body.classList.toggle('flying', mode === 'flying');
  onlineEvents();

  if (inp.anyPress) audio.start();
  if (inp.view && mode !== 'title') { settings.view = settings.view === 'cockpit' ? 'chase' : 'cockpit'; saveSettings(); }
  const nav = inp.nav;
  if (mode === 'title') {
    const rows = menuRows() as readonly string[];
    if (nav.y) {
      let i = rows.indexOf(MENU_ROWS[menuRow]);
      i = THREE.MathUtils.clamp(i + nav.y, 0, rows.length - 1);
      menuRow = MENU_ROWS.indexOf(rows[i] as typeof MENU_ROWS[number]);
      renderMenu();
    }
    if (nav.x && MENU_ROWS[menuRow] !== 'go' && rows.includes(MENU_ROWS[menuRow])) menuChange(MENU_ROWS[menuRow], nav.x);
    if (nav.ok && MENU_ROWS[menuRow] === 'help' && rows.includes('help')) menuChange('help', 1); // A / Enter opens the controls list
    else if (settings.mode === 'online') {
      const row = MENU_ROWS[menuRow];
      if (nav.ok && rows.includes(row) && ['host', 'join', 'go'].includes(row)) onlineAction(row);
      if (nav.ok && row === 'rooms' && openRooms[roomSel] && openRooms[roomSel].players < openRooms[roomSel].max) { settings.code = openRooms[roomSel].code; onlineAction('join'); }
      if (nav.back && online.active) onlineAction('leave');
    } else if (startReq || (nav.ok && !inp.nav.back)) {
      clearTimeout(previewTimer);
      spawn(false); // keeps the world the title was showing
      mode = 'flying'; hud.overlay.classList.add('hidden');
    }
  } else if (mode === 'crashed' && (menuReq || nav.back || nav.menu)) goToMenu();
  else if (mode === 'crashed' && downcam.playing) { if (inp.anyPress && downcam.elapsed > 0.35) endDownCam(); }
  else if (mode === 'crashed' && online.phase === 'playing') {
    if (crashTimer > respawnAt) respawnOnline();
    else { const el = document.getElementById('respawnIn'); if (el) el.textContent = `Back in the air in ${Math.ceil(respawnAt - crashTimer)}…`; }
  }
  else if (mode === 'crashed' && inp.anyPress && crashTimer > 0.8 && crashTimer > downcamEndT + 0.4) { spawn(); mode = 'flying'; hud.overlay.classList.add('hidden'); }
  else if (mode === 'flying' && (nav.menu || menuReq)) goToMenu();
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
    // space: flying through a carrier's hangar bay or a cruiser's tunnel pays; boost pickups refill the tank
    if (isSpace()) {
      const th = holeThreaded(prevPos, glider.pos);
      if (th) {
        const pts = Math.round((th.kind === 'hangar' ? 450 : 300) * multiplier());
        score += pts; combo++; comboTimer = 4;
        dogfight.chargeDart(0.35);
        popup(th.kind === 'hangar' ? `Hangar run +${pts}` : `Through the hull +${pts}`, 'missile charged');
        audio.whoosh(1); rumble(0.5, 120);
      }
      if (mode === 'flying' && grabPickup(glider.pos)) {
        glider.boostFuel = Math.min(1, glider.boostFuel + PICKUP_FUEL);
        popup('Boost +', `tank ${Math.round(glider.boostFuel * 100)}%`);
        audio.beep(1400, 0.08, 0.08); setTimeout(() => audio.beep(2100, 0.1, 0.07), 70); rumble(0.3, 60);
      }
    }
    online.preUpdate();
    for (const ev of dogfight.update(dt, t, glider, inp.fire, inp.dart && myDartsOn(), true, wasInCloud)) onDogfight(ev);
    online.hp = hp; online.postUpdate(dt, glider, bird.quaternion, wasInCloud);
    spawnShield -= dt;
    if (dogfight.myDartThisFrame) { audio.dart(); rumble(0.3, 80); }
    if (dogfight.locked && dogfight.locked !== wasLocked) audio.beep(1900, 0.12, 0.07);
    wasLocked = dogfight.locked;
    if (dogfight.shotThisFrame) isSpace() ? audio.laser() : audio.pew();
    if (dogfight.enemyShotThisFrame) isSpace() ? audio.laser(true) : audio.pew(true);
    warnBeep -= dt;
    if (dogfight.dartIncoming < Infinity) {
      // incoming dart: beeps speed up as it closes
      if (warnBeep <= 0) { audio.beep(1500, 0.05, 0.07); warnBeep = THREE.MathUtils.clamp(dogfight.dartIncoming / 400, 0.06, 0.3); }
    } else if (dogfight.dartLockProgress > 0) {
      if (warnBeep <= 0) { audio.beep(1250, 0.06, 0.06); warnBeep = 0.35 - 0.25 * dogfight.dartLockProgress; }
    } else if (dogfight.tailThreat > 0 && warnBeep <= 0) { audio.beep(dogfight.tailThreat > 0.7 ? 1100 : 820, 0.07, 0.06); warnBeep = dogfight.tailThreat > 0.7 ? 0.18 : 0.6; }
    if (glider.stalled) shake = Math.max(shake, 0.15); // buffeting as the wings stall
    if (isSpace() && glider.boost > 0.3) shake = Math.max(shake, 0.07 * glider.boost); // the airframe hums on a full burn
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
    const crunch = isSpace() ? 'Kaboom!' : 'Crunch!';

    // obstacles: collision + close calls
    obstaclesNear(p.x, p.z, 14, nearby);
    if (!inArena) gates.obstacles(nearby);
    const seen = new Set<string>();
    for (const o of nearby) {
      const gap = obstacleGap(o, p.x, p.y, p.z) - 0.5; // bird radius
      if (gap < 0 && mode === 'flying') { crash(crunch, 'crash', true); break; }
      if (gap < 6) {
        seen.add(o.id);
        const prev = near.get(o.id);
        near.set(o.id, { gap: prev === undefined ? gap : Math.min(prev.gap, gap), type: o.type === 'box' ? 'hull' : o.type });
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

    // arena: the mountain wall is solid ground (fly into it and you crash). Only a bird that climbs over
    // the top meets an invisible barrier: it stops you going further out, but never touches the controls.
    outOfBounds = 0;
    if (inArena) {
      const r = Math.hypot(p.x, p.z) || 1;
      outOfBounds = isSpace() ? spaceEdge(p) : THREE.MathUtils.clamp((r - (ARENA_LID_R - 80)) / 80, 0, 1);
      if (arenaBarrier(p) > 0) {
        // pressing into it scrubs speed, so it's no free ride round the rim
        const into = Math.max(0, (glider.dir.x * p.x + glider.dir.z * p.z) / r);
        glider.speed = Math.max(0, glider.speed - into * glider.speed * 0.8 * dt);
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
    // ground skim: the ground-effect push (see skimThrust) shows as dust kicked up behind you and a wider view
    const skim = mode === 'flying' && !onWater ? skimAmount(p.x, p.y, p.z) : 0;
    if (skim > 0.05) {
      const n = Math.ceil(30 * dt * skim * Math.min(1, glider.speed / 40));
      const gp = new THREE.Vector3(p.x, terrainHeight(p.x, p.z) + 0.4, p.z).addScaledVector(glider.dir, -2);
      for (let i = 0; i < n; i++) puffs.burst(gp, glider.vel.clone().multiplyScalar(-0.05).setY(2.5), 2.5, 1, 0.45);
      camera.fov += 4 * skim * dt;
    }
    if (clearance < 5 && mode === 'flying') {
      score += dt * (5 - clearance) * glider.speed * 0.35 * multiplier();
      if (dogfight.chargeDart(dt * 0.08 * (5 - clearance) / 5)) { popup('Dart reloaded'); audio.beep(1600, 0.1, 0.07); }
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
    online.preUpdate();
    for (const ev of dogfight.update(dt, t, glider, false, false, false)) if (online.phase === 'playing') onDogfight(ev);
    online.hp = hp; online.postUpdate(dt, glider, bird.quaternion, false);
    updateFall(dt);
  } else {
    // title: gentle demo glide that hovers in place
    glider.roll = Math.sin(t * 0.6) * 0.25;
  }
  shake = Math.max(0, shake - dt * 2);
  puffs.update(dt, camera.position);

  // sky and fog shift with the environment you're flying through
  if (isSpace()) spaceScene.update(dt, camera.position);
  else {
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
  bird.visible = !firstPerson() && !(isSpace() && mode === 'crashed'); // (in space your fighter went up in the fireball)
  if (mode === 'crashed') { poseFall(); bird.animate(t, 0.1, glider.speed, 0.6, 0); } // limp wings, like a downed AI bird
  else bird.animate(t, glider.brake, glider.speed, glider.tuck, flapAmount(glider.speed, glider.brake));

  // shadow
  const gp = glider.pos;
  const gy = terrainHeight(gp.x, gp.z);
  const h = gp.y - gy;
  shadow.visible = !isSpace();
  shadow.position.set(gp.x, gy + 0.35, gp.z);
  shadow.scale.setScalar(1.3 + h * 0.03);
  (shadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.5 - h * 0.012, 0, 0.5);

  // stream terrain ahead of the bird
  world.update(gp.x + glider.dir.x * 180, gp.z + glider.dir.z * 180, 2);
  if (!inArena) gates.update(gp.z, t);

  placeCamera(false, dt, mode === 'crashed' ? Math.min(10, crashTimer * 8) : 0);
  // (a fixed camera for screenshots and tests: window.__glide.camOverride = { pos: [x, y, z], look: [x, y, z] })
  const co = (window as any).__glide?.camOverride;
  if (co) { camera.position.fromArray(co.pos); camera.up.set(0, 1, 0); camera.lookAt(tmp.fromArray(co.look)); if (co.fov) { camera.fov = co.fov; camera.updateProjectionMatrix(); } }

  // down cam: keep recording; once you go down, show the recording instead of the live scene
  const trk = trackedNow();
  if (mode !== 'title') {
    // first person hides your own bird from your camera, but the replay is watched from outside: record it anyway
    const hidden = !bird.visible;
    bird.visible = true;
    downcam.record(t, trk);
    bird.visible = !hidden;
  }
  if (downcamReq) { if (mode === 'crashed') beginDownCam(downcamReq.by, downcamReq.how); downcamReq = null; }
  let replaying = false;
  if (downcam.playing) {
    if (mode !== 'crashed' || !downcam.advance(realDt)) endDownCam();
    else {
      downcam.apply(scene, camera, trk, realDt, terrainHeight);
      ($('downcamBar') as HTMLElement).style.width = `${Math.round(downcam.progress * 100)}%`;
      replaying = true;
    }
  }
  sky.position.copy(camera.position);
  spaceScene.backdrop.position.copy(camera.position);

  // streaks
  // (space: dust streaks show how fast you're going even with nothing near; brighter on boost)
  const sp = isSpace() ? 0.2 + 0.8 * THREE.MathUtils.clamp((glider.speed - SPACE_CRUISE) / (SPACE_BOOST - SPACE_CRUISE), 0, 1)
    : THREE.MathUtils.clamp((glider.speed - 30) / 35, 0, 1);
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
  hud.edge.style.opacity = replaying ? '0' : String(Math.max(danger * 0.7, hitFlash));
  hud.edge.style.boxShadow = hitFlash > danger * 0.7 ? 'inset 0 0 140px 40px rgba(255, 40, 40, .85)' : '';
  drawDogfightHud(mode === 'flying');
  if (isTouch) { const d = mode === 'flying' ? 'flex' : 'none'; $('fire').style.display = d; $('dartBtn').style.display = myDartsOn() ? d : 'none'; $('viewBtn').style.display = d; }
  $('pipper').style.display = firstPerson() && !replaying && !isSpace() ? 'block' : 'none';
  // space: boost fuel gauge
  const boostEl = $('boost');
  boostEl.style.display = 'none'; // (space: the boost gauge is on the reticle now)
  if (isSpace()) {
    (boostEl.firstChild as HTMLElement).style.width = `${Math.round(glider.boostFuel * 100)}%`;
    boostEl.classList.toggle('on', glider.boost > 0.2);
    boostEl.classList.toggle('low', glider.boostFuel < 0.15);
  }
  if (outOfBounds > 0 && mode === 'flying' && hud.warn.style.opacity === '0') {
    hud.warn.textContent = isSpace() ? '◀ LEAVING THE BATTLE: TURN BACK ▶' : '◀ NO WAY OVER THE WALL: TURN BACK ▶';
    hud.warn.style.opacity = String(0.5 + 0.5 * Math.sin(t * 10));
  }
  hud.score.textContent = mode === 'title' || replaying ? '' : String(Math.floor(score));
  hud.combo.style.opacity = combo > 0 && mode === 'flying' ? '1' : '0';
  hud.combo.textContent = `combo x${multiplier().toFixed(1)}`;
  hud.stats.textContent = mode === 'flying'
    ? isSpace() ? `${Math.round(glider.speed * 3.6)} km/h · ${getArena()!.name}`
    : `${Math.round(glider.speed * 3.6)} km/h · ${Math.max(0, Math.round(clearance))} m up · ${inArena ? getArena()!.name : `${Math.round(startZ - gp.z)} m`}`
    : '';
  waveClearedT -= dt;
  const alive = dogfight.enemies.filter((e) => e.alive && e.remote !== 'human').length;
  const rules = online.phase === 'playing' ? online.rules : null;
  hud.wave.textContent = rules && mode !== 'title'
    ? rules.bots === 0 ? (rules.allies ? teamBanner() : 'FREE FOR ALL') : dogfight.wave === 0 ? 'GET READY' : waveClearedT > 0 || alive === 0 ? `WAVE ${dogfight.wave} CLEARED` : `WAVE ${dogfight.wave} · ${alive} LEFT`
    : inArena && mode === 'flying'
    ? dogfight.wave === 0 ? 'GET READY' : waveClearedT > 0 || alive === 0 ? `WAVE ${dogfight.wave} CLEARED` : `WAVE ${dogfight.wave} · ${alive} LEFT`
    : '';
  audio.update(glider.speed, mist, mode === 'flying' && !isSpace()); // (no wind in space)
  audio.engine(isSpace() && mode === 'flying', THREE.MathUtils.clamp((glider.speed - 22) / (SPACE_BOOST - 22), 0, 1), glider.boost, glider.brake);
  drawOnlineHud(dt);

  render();
  if (replaying) downcam.restore(trk);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
(window as any).__glide = { settings, input, glider, dogfight, world, gates, spaceScene, fleet, obstacleGap, boostPickups, isSpace, camera, get mode() { return mode; }, get score() { return score; }, canyonAt, terrainHeight, route, riverAt };

// ?debug exposes the game objects to the console (used for the two-browser online tests)
if (new URLSearchParams(location.search).has('debug')) {
  (window as any).glide = { online, dogfight, glider, get hp() { return hp; }, get shield() { return spawnShield; }, get t() { return t; }, get mode() { return mode; }, get score() { return score; } };
}
