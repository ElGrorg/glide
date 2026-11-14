import * as THREE from 'three';
import { World, riverAt, terrainHeight, obstaclesNear, obstacleGap, canyonAt, basePlane, nearestBranch, CANYON_RIM, SKY_COLOR, FOG_FAR, ARENAS, ARENA_R, ARENA_LID_R, arenaBarrier, skimAmount, setArena, getArena, SPACE_ARENA, isSpace, setCourse, getCourse, solidClearance, floorBelow, caveShade, solidCrossed, type Obstacle } from './world';
import { COURSES, courseById } from './courses';
import { SpaceScene, buildField, holeThreaded, fleet, clearSpawnY, spaceEdge, grabPickup, boostPickups, SPACE_R, SPACE_CRUISE, SPACE_BOOST, PICKUP_FUEL } from './space';
import { ShipMesh, type Craft } from './ship';
import { route, BIOME_NAME } from './route';
import { CloudPuffs } from './puffs';
import { Gates, type GateEvent } from './gates';
import { BirdMesh, Glider, PLAYER_COLORS } from './bird';
import { Input } from './input';
import { WindAudio } from './audio';
import { Dogfight, MAX_DARTS, peaSpeed, peaLife, flapAmount, waveTier, waveBirds, type DogfightEvent, type Enemy } from './dogfight';
import { setWorldSeed } from './noise';
import { Online, PLAYER_CSS, TEAM_CSS, TEAM_NAMES, colorIndex, type MatchRules, type MatchResult } from './online';
import { cleanCode, hasRoomBrowser, listRooms, type RoomInfo } from './net';
import { DownCam, type Tracked } from './downcam';
import { RaceRun, MISSED, Ghost, GhostData, boardKey, sectionName, fmtTime, fmtDelta, fetchBoard, fetchGhost, submitRun, localBest, myPid, hasGlobalBoard, type Board, type BoardEntry } from './race';
import type { CourseDef } from './course';
import { buildMap, guessSpec, checkSpec, filesFor, mapId, listMaps, saveMap, deleteMap, ACCEPT, BIOMES, LIMITS, type MapFile, type MapSpec, type StoredMap } from './mapimport';
import { sfx } from './spacefx';
import { HitboxView } from './hitbox';
import { QuickChat, lineText, botReply, BOT_NAMES, OOPS, BANTER } from './quickchat';
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
const CAVE_FOG = new THREE.Color(0x1d2228);
let caveNow = 0;
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 140, 640);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 900);
/** debug: every collision shape near you (H, or ?hitboxes in the address) */
const hitboxes = new HitboxView(scene);
hitboxes.keyOk = () => mode !== 'title';
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
const PAD_COMMON: Help = [[kb('RT') + ' / ' + kb('X'), 'Shoot'], [kb('Y'), 'Homing dart'], [kb('LT') + ' / ' + kb('A'), 'Air-brake'], [kb('Back'), 'Next stick layout'], [kb('R3'), 'First-person view'], [kb('D-pad'), 'Quick chat: a direction opens a group, another sends a line']];
const KEYS_HELP = (): Help => [
  [kb('W', 'S') + ' / ' + kb('↑', '↓'), 'Dive / pull up (hold S to loop)'],
  [kb('A', 'D') + ' / ' + kb('←', '→'), input.scheme === 'flight' ? 'Roll (bank holds)' : 'Bank'],
  [kb('Z', 'C'), 'Rudder'], [kb('Space'), 'Air-brake'], [kb('F') + ' or click', 'Shoot'],
  [kb('R') + ' or right-click', 'Homing dart (hold your nose on a bird for 1 s to lock)'], [kb('V'), 'Change layout'], [kb('T'), 'First-person view'],
  [kb('1', '2', '3', '4'), 'Quick chat: pick a group, then a line'],
];
// space fighters
const SPACE_PAD: Help = [[`Left stick ${kb('↑↓')}`, 'Pitch'], [`Right stick ${kb('←→')}`, 'Roll'], 
  [kb('RT') + ' / ' + kb('X'), 'Lasers'], [kb('Y'), 'Missile'], [kb('RB'), 'Boost'], [kb('LB'), 'Drift: slide and aim'], [kb('R3'), 'Cockpit view'], [kb('D-pad'), 'Quick chat']];
const SPACE_KEYS: Help = [[kb('W', 'S') + ' / ' + kb('↑', '↓'), 'Pitch'], [kb('A', 'D') + ' / ' + kb('←', '→'), 'Roll'], [kb('Z', 'C'), 'Yaw'],
  [kb('Shift'), 'Boost'], [kb('Space'), 'Drift: slide and aim'], [kb('F') + ' or click', 'Lasers'],
  [kb('R') + ' or right-click', 'Missile (hold your nose on a fighter for 1 s to lock)'], [kb('T'), 'Cockpit view'], [kb('1', '2', '3', '4'), 'Quick chat']];
const TILT_HELP: Help = [['Tilt the phone', 'Steer like a wheel: turn it to roll, tip the top away to dive, toward you to pull up'],
  ['Level', 'However you hold the phone when you launch']];
const SPACE_TOUCH = (): Help => [...(settings.tilt ? TILT_HELP : [['Left thumb ↑↓', 'Pitch'], ['Right thumb ←→', 'Roll']] as Help),
  ['Left slider', 'Throttle: up boosts, the notch cruises, down drifts (it stays put)'],
  ['Hold FIRE', 'Lasers'], ['Tap MSL', 'Missile, once your nose has locked a fighter'], ['Tap VIEW', 'Cockpit view'], ['Tap CHAT', 'Quick chat']];
const TOUCH_HELP = (): Help => [...TOUCH_FLY(), ['Tap CHAT', 'Quick chat: tap a group, then a line']];
const TOUCH_FLY = (): Help => settings.tilt
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
/** 'race' is the solo time trial; 'liverace' is the online race against other players. */
type GameMode = 'endless' | 'race' | 'liverace' | 'arena' | 'space' | 'online';
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
  /* phones: steer by tilting */ tilt: false,
  /* race: which course */ course: 0, /* (or one of your imported maps, by id) */ mapId: '',
  /* arena + online: first to this many kills wins (0 = no limit, -1 = custom, which uses winN) */ winAt: 0, winN: 15,
  /* solo arena: each wave brings one more bird, and smarter ones */ escalate: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('glide.settings') || '{}')); } catch { /* storage unavailable */ }
settings.env = THREE.MathUtils.clamp(Math.round(settings.env) || 0, 0, SPACE_ENV);
settings.enemies = THREE.MathUtils.clamp(Math.round(settings.enemies) || 3, 1, 12);
settings.bots = THREE.MathUtils.clamp(Math.round(settings.bots) || 0, 0, 12);
if (!['endless', 'race', 'liverace', 'arena', 'space', 'online'].includes(settings.mode)) settings.mode = 'endless';
if (settings.view !== 'cockpit') settings.view = 'chase';
settings.tilt = isTouch && settings.tilt === true;
input.tilt = settings.tilt;
input.onMotion = () => { if (mode === 'title') renderMenu(); };
if (!DOWNCAM_OPTS.includes(settings.downcam)) settings.downcam = 'shot';
/** Winning score picks: No limit, first to 3 / 5 / 10, or a custom number. */
const WIN_OPTS = [0, 3, 5, 10, -1];
if (!WIN_OPTS.includes(settings.winAt)) settings.winAt = 0;
settings.winN = THREE.MathUtils.clamp(Math.round(settings.winN) || 15, 1, 95);
/** The kills it takes to win this match (0 = no limit). */
const winTarget = () => (settings.winAt < 0 ? settings.winN : settings.winAt);
/** The winning score rows: the picker, plus the number when it's on Custom. */
const winRows = () => ['winAt', ...(settings.winAt < 0 ? ['winN'] : [])];
settings.escalate = settings.escalate !== false;
settings.name = String(settings.name || '').slice(0, 16);
// an invite link (?room=CODE) opens straight onto the online menu, ready to join
const inviteCode = cleanCode(new URLSearchParams(location.search).get('room') || '');
if (inviteCode) { settings.mode = 'online'; settings.code = inviteCode; }
const saveSettings = () => { try { localStorage.setItem('glide.settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const bestKey = () => (settings.mode === 'arena' ? 'glide.best.arena' : settings.mode === 'space' ? 'glide.best.space' : settings.mode === 'online' ? 'glide.best.online' : 'glide.best');
let best = 0;
const loadBest = () => { try { best = Number(localStorage.getItem(bestKey()) || 0); } catch { best = 0; } };
loadBest();
/** Solo arena with escalating waves: the most waves you've cleared, per starting number of birds. */
const bestWaveKey = () => `glide.bestWave.arena.${settings.enemies}`;
const loadBestWave = () => { try { return Number(localStorage.getItem(bestWaveKey()) || 0); } catch { return 0; } };
/** Waves cleared this match, and whether that beat the record. */
let wavesCleared = 0, waveRecord = false;
/** The arena chosen for this match ("random" rolls one per match). */
let arenaIdx = 0;

const MENU_ROWS = ['mode', 'course', 'import', 'board', 'env', 'enemies', 'waves', 'bots', 'allies', 'team', 'winAt', 'winN', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'tilt', 'go', 'vis', 'host', 'join', 'rooms', 'help'] as const;
const GO_ROW = MENU_ROWS.indexOf('go');
let menuRow = inviteCode ? MENU_ROWS.indexOf('join') : GO_ROW;
/** On a phone the Steering row (thumbs or tilt) follows Camera. */
function menuRows(): readonly string[] {
  const rows = baseRows();
  return isTouch ? rows.flatMap((r) => (r === 'view' ? ['view', 'tilt'] : [r])) : rows;
}
function baseRows(): readonly string[] {
  const browser = hasRoomBrowser();
  if (settings.mode === 'liverace') return online.active
    ? (online.isHost && online.phase === 'lobby' ? [...(browser ? ['vis'] : []), 'course', 'myDarts', 'lead', 'view', 'go'] : online.phase === 'lobby' ? ['lead', 'view'] : [])
    : ['mode', ...(browser && openRooms.length ? ['rooms'] : []), 'join', ...(browser ? ['vis'] : []), 'host', 'lead', 'view', 'help'];
  if (settings.mode === 'online') return online.active
    ? (online.isHost && online.phase === 'lobby' ? [...(browser ? ['vis'] : []), 'env', 'bots', 'allies', ...(settings.allies ? ['team'] : []), ...winRows(), 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go']
      : online.phase === 'lobby' ? [...(online.teams ? ['team'] : []), 'lead', 'downcam', 'view'] : [])
    : ['mode', ...(browser && openRooms.length ? ['rooms'] : []), 'join', ...(browser ? ['vis'] : []), 'host', 'lead', 'downcam', 'view', 'help'];
  if (settings.mode === 'race') return ['mode', 'course', 'import', 'board', 'view', 'go', 'help'];
  return settings.mode === 'arena' ? ['mode', 'env', 'enemies', 'waves', ...winRows(), 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help']
    : settings.mode === 'space' ? ['mode', 'enemies', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help']
    : ['mode', 'myDarts', 'enemyDarts', 'lead', 'downcam', 'view', 'go', 'help'];
}
let onlineNote = '';

// ---------- Room browser (Cloudflare relay only): the open public rooms, refreshed while you look ----------
let openRooms: RoomInfo[] = [];
let roomsState: 'loading' | 'ok' | 'error' = 'loading';
let roomSel = 0;
let roomsTimer = 0, roomsLive = false;
/** The tabs that play in online rooms: Online (dogfights) and Race. */
const roomTab = () => settings.mode === 'online' || settings.mode === 'liverace';
/** In a live online race right now. */
const liveRace = () => online.phase === 'playing' && !!online.rules?.race;
const browsing = () => mode === 'title' && roomTab() && !online.active && hasRoomBrowser();
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
    // (a race room's arena number is 100 + its course)
    const raceC = r.arena >= 100 ? COURSES[r.arena - 100] : undefined;
    const where = raceC ? `Race · ${raceC.name} · ${r.phase === 'playing' ? 'racing' : 'in the lobby'}`
      : r.phase === 'playing' ? `in a match${r.arena === 99 ? ` · ${SPACE_ARENA.name} (space)` : r.arena >= 0 && ARENAS[r.arena] ? ` · ${ARENAS[r.arena].name}` : ''}` : 'in the lobby';
    return `<button class="room${selRow && i === roomSel ? ' sel' : ''}" data-act="joinroom:${esc(r.code)}"${full ? ' disabled' : ''}>
      <b>${esc(r.name)}'s room</b><span>${r.players}/${r.max} players · ${where}${full ? ' · full' : ''}</span></button>`;
  }).join('');
}
const esc = (s: string) => s.replace(/[<>&"]/g, '');
const inviteLink = () => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('room', online.code); const sig = new URLSearchParams(location.search).get('signal'); if (sig) u.searchParams.set('signal', sig); return u.toString(); };
/** Mode tabs on the title menu. A new mode only needs an entry here (plus its blurb and rows below). */
const MODE_TABS: { id: GameMode; label: string }[] = [
  { id: 'endless', label: 'Endless' }, { id: 'race', label: 'Time trials' }, { id: 'liverace', label: 'Race' }, { id: 'arena', label: 'Arena' }, { id: 'space', label: 'Space' }, { id: 'online', label: 'Online' },
];
const MODE_BLURB: Record<GameMode, string> = {
  endless: 'An endless mountainside. Skim the ground, thread the trees, punch through the clouds, and shoot down the birds hunting you.',
  race: 'Time trial down a set course: caves, ravines and more than one way down. Keep your speed up or you\'ll stall. Race a ghost of anyone on the board.',
  liverace: 'Race other players live down the time trial courses. Crash or get shot down and you\'re straight back in the air where you went down, but back at base speed. Peas and darts are live.',
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
  if (roomTab()) { renderOnlineMenu(); return; }
  if (settings.mode === 'race') { renderRaceMenu(); return; }
  const rows = menuRows() as readonly string[];
  if (!rows.includes(MENU_ROWS[menuRow])) menuRow = GO_ROW;
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const envName = settings.env >= ARENAS.length ? 'Random' : ARENAS[settings.env].name;
  const envBlurb = settings.env >= ARENAS.length ? 'A different arena every match' : ARENAS[settings.env].blurb;
  const arena = settings.mode === 'arena', space = settings.mode === 'space';
  const dw = space ? 'missiles' : 'darts';
  const head = `${modeRow(sel('mode'))}<p class="blurb">${MODE_BLURB[settings.mode]}</p>`;
  const sets = `${arena ? `${sect('Match')}${pickRow(sel('env'), 'env', 'Arena', envName, envBlurb)}${pickRow(sel('enemies'), 'enemies', 'Enemies', settings.escalate ? `${settings.enemies} to start` : `${settings.enemies} per wave`)}${wavesRow(sel('waves'))}${winRow(sel)}` : ''}
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
/** Solo arena: waves get harder, or stay the same. Shows your record for this starting number. */
function wavesRow(sel: string) {
  const rec = loadBestWave();
  const note = !settings.escalate ? 'Every wave the same birds'
    : `One more bird each wave, and smarter ones${rec ? ` · best: ${rec} cleared` : ''}`;
  return pickRow(sel, 'waves', 'Waves', settings.escalate ? 'Get harder' : 'Stay the same', note);
}
/** Winning score: No limit, or first to 3 / 5 / 10 / any number of kills. */
function winRow(sel: (r: string) => string) {
  const n = winTarget(), online_ = settings.mode === 'online';
  const value = settings.winAt === 0 ? 'No limit' : settings.winAt < 0 ? 'Custom' : `First to ${n}`;
  const note = !n ? (online_ ? 'Play on until the host closes the room' : settings.escalate ? 'Survive as many waves as you can' : 'Fight wave after wave until you go down')
    : !online_ ? `Shoot down ${n} bird${n > 1 ? 's' : ''} to win`
    : settings.allies ? `First team to ${n} kills between them wins` : `First player to ${n} kill${n > 1 ? 's' : ''} wins`;
  return pickRow(sel('winAt'), 'winAt', 'Win at', value, note)
    + (settings.winAt < 0 ? pickRow(sel('winN'), 'winN', 'Kills to win', `${settings.winN} kill${settings.winN > 1 ? 's' : ''}`, 'Steps of 1 up to 20, then 5') : '');
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
  // in a room, the tab follows the room: a race room shows the Race lobby, a dogfight room the Online one
  if (online.phase === 'lobby') {
    const want: GameMode = online.lobbyRace ? 'liverace' : 'online';
    if (settings.mode !== want) { settings.mode = want; queuePreview(); }
  }
  const raceTab = settings.mode === 'liverace';
  const rows = menuRows();
  if (rows.length && !rows.includes(MENU_ROWS[menuRow])) menuRow = MENU_ROWS.indexOf((rows.includes('host') ? 'host' : rows[rows.length - 1]) as typeof MENU_ROWS[number]);
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const envName = settings.env === SPACE_ENV ? `${SPACE_ARENA.name} (space)` : settings.env === ARENAS.length ? 'Random' : ARENAS[settings.env].name;
  const note = onlineNote ? `<p class="note">${esc(onlineNote)}</p>` : '';
  const compact = compactQ.matches;
  const hint = online.active ? menuHint('start') : isTouch ? '' : `<p class="hint">${kb('↑', '↓')} choose · ${kb('Enter')} on a row to join or host · type to set your name</p>`;
  const view = `${sect('View')}${leadRow(sel('lead'))}${raceTab ? '' : downcamRow(sel('downcam'))}${viewRow(sel('view'))}${tiltRow(sel('tilt'))}`;
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
    <p class="blurb">${raceTab ? MODE_BLURB.liverace : hasRoomBrowser() ? MODE_BLURB.online : 'Fight in the arena with friends anywhere: different houses, Wi-Fi or phone data. One of you hosts a room and shares its code; everyone else joins with it.'}</p>
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
    const raceC = courseById(online.lobbyCourse);
    const match = online.isHost && raceTab ? `
      ${sect('Race')}
      ${hasRoomBrowser() ? visRow(sel('vis')) : ''}
      ${pickRow(sel('course'), 'course', 'Course', esc(builtIn().name), esc(builtIn().blurb))}
      ${pickRow(sel('myDarts'), 'myDarts', 'Darts', onOff(settings.myDarts), 'Peas are always on')}`
    : online.isHost ? `
      ${sect('Match')}
      ${hasRoomBrowser() ? visRow(sel('vis')) : ''}
      ${pickRow(sel('env'), 'env', 'Arena', envName)}
      ${pickRow(sel('bots'), 'bots', 'AI birds', settings.bots ? `${settings.bots} per wave` : 'None')}
      ${pickRow(sel('allies'), 'allies', 'Players', settings.allies ? 'Team up' : 'Free for all', settings.allies ? 'Red vs Blue: everyone picks a team' : '')}
      ${winRow(sel)}
      ${pickRow(sel('myDarts'), 'myDarts', 'Player darts', onOff(settings.myDarts))}
      ${pickRow(sel('enemyDarts'), 'enemyDarts', 'AI darts', onOff(settings.enemyDarts))}` : '';
    const goal = online.lobbyRace ? (online.isHost ? '' : `<p class="blurb center">Course: <b>${esc(raceC?.name ?? '…')}</b></p>`)
      + (online.lobbyBusy ? '<p class="blurb center">A race is under way. You\'ll be on the grid for the next one.</p>' : '')
      : !online.isHost && online.lobbyWin ? `<p class="blurb center">First ${online.teams ? 'team' : 'player'} to <b>${online.lobbyWin}</b> kill${online.lobbyWin > 1 ? 's' : ''} wins</p>` : '';
    const start = online.isHost ? `<button data-act="go" class="go-btn cta${sel('go')}">${raceTab ? 'Start race' : 'Start match'}</button>` : `${goal}<p class="blurb center wait">Waiting for the host to start…</p>`;
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
  if (act === 'host') {
    if (settings.mode === 'liverace') online.host(name, settings.public, false, 0, builtIn().id, 100 + settings.course);
    else online.host(name, settings.public, settings.allies, winTarget());
    renderMenu();
  }
  else if (act === 'join') {
    if (cleanCode(settings.code).length < 4) { onlineNote = 'Type the room code your friend gave you.'; renderMenu(); (document.getElementById('codeIn') as HTMLInputElement | null)?.focus(); return; }
    online.join(settings.code, name); renderMenu();
  } else if (act === 'leave') { online.leave(); renderMenu(); }
  else if (act === 'copy') {
    const link = inviteLink();
    navigator.clipboard?.writeText(link).then(() => { onlineNote = 'Invite link copied. Send it to your friends.'; renderMenu(); },
      () => { onlineNote = `Invite link: ${link}`; renderMenu(); });
    if (!navigator.clipboard) { onlineNote = `Invite link: ${link}`; renderMenu(); }
  } else if (act === 'go' && online.isHost && online.phase === 'lobby' && online.lobbyRace) {
    // a race: everyone on the grid of the picked course; no AI birds, no teams, peas (and darts if on) live
    online.start({ seed: (Math.random() * 2 ** 31) | 0, arena: 100 + settings.course, bots: 0, myDarts: settings.myDarts, enemyDarts: false, allies: false, winAt: 0, race: builtIn().id });
  } else if (act === 'go' && online.isHost && online.phase === 'lobby') {
    const rules: MatchRules = { seed: (Math.random() * 2 ** 31) | 0, arena: settings.env < ARENAS.length ? settings.env : Math.floor(Math.random() * ARENAS.length),
      bots: settings.bots, myDarts: settings.myDarts, enemyDarts: settings.enemyDarts, allies: settings.allies, space: settings.env === SPACE_ENV, winAt: winTarget() };
    online.start(rules);
  }
}
let previewTimer = 0;
/** Rebuild the world behind the title so it shows the chosen mode / arena. */
function queuePreview() { clearTimeout(previewTimer); previewTimer = window.setTimeout(() => { if (mode === 'title') spawn(true); }, 220); }
const MODES: GameMode[] = MODE_TABS.map((m) => m.id);
/** Which world the title shows behind the menu: 0 = mountain, 1 = an arena, 2 = space. */
const worldKind = (m: GameMode) => (m === 'endless' ? 0 : m === 'race' || m === 'liverace' ? 3 : m === 'space' || (m === 'online' && settings.env === SPACE_ENV) ? 2 : 1);
function menuChange(row: string, d: number) {
  if (row === 'mode') {
    const m = MODES[THREE.MathUtils.clamp(MODES.indexOf(settings.mode) + d, 0, MODES.length - 1)];
    if (m !== settings.mode) { const was = worldKind(settings.mode), now = worldKind(m); settings.mode = m; loadBest(); if (was !== now) queuePreview(); showControlsSafe(); }
  }
  else if (row === 'course' && roomTab()) {
    // a race room: the built-in courses only (your own maps live on your device, so nobody else has them)
    settings.course = (settings.course + d + COURSES.length) % COURSES.length;
    online.setRaceCourse(builtIn().id, 100 + settings.course); queuePreview();
  }
  else if (row === 'course') { stepCourse(d); boardSel = 0; refreshBoard(); queuePreview(); }
  else if (row === 'board') { const n = boardItems().length; if (n) boardSel = (boardSel + d + n) % n; }
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
  else if (row === 'waves') settings.escalate = !settings.escalate;
  else if (row === 'winAt') settings.winAt = WIN_OPTS[(WIN_OPTS.indexOf(settings.winAt) + d + WIN_OPTS.length) % WIN_OPTS.length];
  else if (row === 'winN') settings.winN = THREE.MathUtils.clamp(settings.winN + (settings.winN + d > 20 ? 5 * d : d), 1, 95);
  if (row === 'winAt' || row === 'winN') online.setWinAt(winTarget());
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
  if (k === 'mapimport') { menuRow = MENU_ROWS.indexOf('import'); pickMapFiles(); return; }
  if (k === 'mapremove') { menuRow = MENU_ROWS.indexOf('import'); removeMap(); return; }
  if (['go', 'host', 'join', 'joinroom'].includes(k)) goLandscape();
  if (k === 'joinroom') { settings.code = cleanCode(v); onlineAction('join'); return; }
  if (k === 'ghost') { menuRow = MENU_ROWS.indexOf('board'); boardSel = Math.max(0, boardItems().findIndex((e) => e.pid === v)); toggleGhost(v); return; }
  if (k === 'leave' && online.active && lobbyLeaveNeedsConfirm()) { openPause('confirm', true); return; }
  if (roomTab() && ['host', 'join', 'leave', 'copy', 'go'].includes(k)) { onlineAction(k); return; }
  if (k === 'pause') { if (online.phase === 'playing') openPause('confirm'); return; }
  if (k === 'go') startReq = true;
  else if (k === 'menu') menuReq = true;
  else if (k === 'mode') { menuRow = 0; menuChange('mode', MODES.indexOf(v as GameMode) - MODES.indexOf(settings.mode)); }
  else { menuRow = MENU_ROWS.indexOf(k as typeof MENU_ROWS[number]); menuChange(k, Number(v)); }
}
function goToMenu() {
  closePause();
  if (online.phase === 'playing') online.leave();
  mode = 'title';
  spawn(true);
  renderMenu();
  hud.overlay.classList.remove('hidden');
}

// Online room menu. Leaving (and, for the host, closing the room for everyone) is never one button press
// away: Esc / Start / B opens this menu with "Keep flying" picked, and leaving needs a second "are you sure".
// The match can't pause, so the game carries on underneath (and you still respawn on time).
const pauseEl = $('pause');
let pause: null | 'menu' | 'confirm' = null, pauseSel = 0, pauseFromLobby = false, pauseDirect = false;
function openPause(step: 'menu' | 'confirm' = 'menu', fromLobby = false) {
  pause = step; pauseSel = 0; pauseFromLobby = fromLobby; pauseDirect = step === 'confirm';
  renderPause();
}
function closePause() { pause = null; pauseEl.classList.remove('on'); pauseEl.innerHTML = ''; }
function renderPause() {
  if (!pause) return closePause();
  const host = online.isHost;
  const opts = pause === 'menu'
    ? [['Keep flying', ''], [host ? 'Close room…' : 'Leave room…', '']]
    : [['Cancel', ''], [host ? 'Close room' : 'Leave room', 'danger']];
  const text = pause === 'menu'
    ? `<h1>Room menu</h1><p>The match keeps going while this is open.</p>`
    : host
      ? `<h1>Close the room?</h1><p>You're the host. Everyone in the room goes back to the menu.</p>`
      : `<h1>Leave the room?</h1><p>You'll go back to the menu. The match carries on without you.</p>`;
  const hint = isTouch ? '' : `<p class="hint">${pause === 'menu' ? 'Esc / Start / B to keep flying' : 'Esc / B to go back'}</p>`;
  pauseEl.innerHTML = `<div class="menu"><div class="panel center">${text}<div class="btns">${opts.map(([label, cls], i) =>
    `<button data-p="${i}" class="${cls}${i === pauseSel ? ' sel' : ''}">${label}</button>`).join('')}</div>${hint}</div></div>`;
  pauseEl.classList.add('on');
}
function pauseBack() {
  if (pause === 'confirm' && !pauseDirect) { pause = 'menu'; pauseSel = 0; renderPause(); } else closePause();
}
function pauseAct(i: number) {
  audio.start();
  if (pause === 'menu') { if (i === 1) { pause = 'confirm'; pauseSel = 0; renderPause(); } else closePause(); }
  else if (pause === 'confirm') {
    if (i !== 1) return pauseBack();
    const lobby = pauseFromLobby;
    closePause();
    if (lobby) onlineAction('leave'); else { if (!roomTab()) settings.mode = 'online'; goToMenu(); }
  }
}
// a click fires on finger lift, and not after a drag, so taps behave like the rest of the menus
pauseEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-p]');
  if (b) pauseAct(Number(b.getAttribute('data-p')));
});
/** Host in a lobby other players have joined: leaving closes the room on them, so ask first. */
const lobbyLeaveNeedsConfirm = () => online.isHost && online.roster().length > 1;

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
/** 'over': someone reached the winning score, and the winner screen is up. 'finished': over the line in a time trial. */
type Mode = 'title' | 'flying' | 'crashed' | 'over' | 'finished';
let mode: Mode = 'title';
let score = 0, combo = 0, comboTimer = 0, slowmo = 0, crashTimer = 0, shake = 0;
/** When the winner screen went up (wall clock, ms): a short pause before a press can dismiss it. */
let overAt = 0;
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
  if (settings.mode === 'race') { spawnRace(); return; }
  if (settings.mode === 'liverace') { spawnRace(builtIn()); return; } // (the title shows the race room's course)
  if (getCourse()) { setCourse(null); fresh = true; } // leaving a race course: back to a fresh random world
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
  dogfight.escalate = arena && !space && settings.escalate;
  wavesCleared = 0; waveRecord = false;
  // build the opening stretch straight away
  for (let i = 0; i < 10 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; i++);
  placeCamera(true);
}

/** Online: the host started the match (or you joined one in progress). Everyone builds the same arena from the same seed. */
function startOnlineMatch(rules: MatchRules) {
  if (pauseFromLobby) closePause(); // the host started while you were deciding whether to leave
  clearTimeout(previewTimer);
  settings.mode = rules.race ? 'liverace' : 'online';
  if (rules.race) { startLiveRace(rules); return; }
  if (getCourse()) setCourse(null); // (back from a race course)
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
  dogfight.escalate = false;
  score = 0; combo = 0; comboTimer = 0;
  feed.length = 0;
  respawnOnline();
}
/** Online: back into the air at a random spot on the rim, with full feathers and darts. The fight carries on. */
function respawnOnline() {
  if (liveRace()) { liveRespawn(); return; }
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

/** A pass this close (metres from the hitbox, which now hugs the drawn shape) is a close call. It was 3.5 when
 *  pillar and rock hitboxes were 1-3 m fatter than drawn; 5 keeps the same passes paying now they're accurate. */
const CLOSE_CALL = 5;
function addCloseCall(gap: number, label: string) {
  combo++; comboTimer = 4;
  const pts = Math.round((60 + (CLOSE_CALL - gap) * 56) * multiplier());
  score += pts;
  const veryClose = gap < 1.5;
  // flying dangerously pays: a slipstream speed kick and a chunk of dart recharge, more the closer you cut it
  const kick = veryClose ? 7 : 3 + (CLOSE_CALL - gap) * 1.1;
  // (space: no slipstream off a hull in a vacuum, and boost only comes from pickups)
  if (!isSpace()) glider.speed = Math.min(95, glider.speed + kick); // (time trials too: risk pays)
  const refilled = dogfight.chargeDart(veryClose ? 0.5 : 0.25);
  const perks = isSpace() ? (refilled ? 'MISSILE RELOADED' : '') : `+${Math.round(kick * 3.6)} km/h${refilled ? ' · DART RELOADED' : ''}`;
  popup(veryClose ? `INSANE! +${pts}` : `Close call +${pts}`, `${label} · ${gap.toFixed(1)} m${perks ? ` · ${perks}` : ''}`);
  if (refilled) audio.beep(1600, 0.1, 0.07);
  audio.whoosh(veryClose ? 1 : 0.6);
  rumble(veryClose ? 0.8 : 0.4, 120);
  if (veryClose && !racing() && !liveRace()) slowmo = 0.5;
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
    const ground = floorBelow(p.x, p.y, p.z) + 0.45;
    if (p.y < ground) { p.y = ground; fallVel.set(0, 0, 0); fallSettled = true; puffs.burst(p, tmp.set(0, 3, 0), 8, 20, 1.2); }
    glider.speed = fallVel.length();
    return;
  }
  if (!fallSettled) {
    fallVel.y -= 18 * dt;
    fallVel.multiplyScalar(Math.exp(-0.3 * dt));
    p.addScaledVector(fallVel, dt);
    const ground = floorBelow(p.x, p.y, p.z) + 0.45;
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
  if (racing()) { raceCrashed(title); startFall(how !== 'crash', wall); audio.thud(); rumble(1, 300); return; }
  if (isSpace() && title === 'Crunch!') title = wall ? 'Kaboom!' : 'Planetfall!';
  startFall(how !== 'crash', wall);
  if (isSpace()) sfx.explode(glider.pos, glider.vel, 1.3); // blown apart
  audio.thud(); rumble(1, 300);
  // whoever hit you in the last few seconds gets the credit (and the down cam watches from their bird)
  const by = how !== 'crash' || t - lastHitT < 6 ? lastAttacker : '';
  if (!liveRace()) downcamReq = { by, how }; // (a race has no time for a replay: you're straight back in the air)
  if (online.phase !== 'playing' && Math.random() < (by === 'ai' ? 0.5 : 0.3)) botSay([...BANTER, 11, 11]); // (11 = "Enjoy the ground!")
  if (online.phase === 'playing') {
    // online: no game over, you're straight back in
    online.downed(by, how);
    if (liveRace()) { liveCrashed(title.startsWith('Missed'), wall); return; }
    const who = by && by !== 'ai' ? esc(online.nameOf(by)) : by === 'ai' ? 'a wild bird' : '';
    hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center">${who ? `<p>by <b>${who}</b></p>` : ''}<p class="big">${online.kills} down · ${online.deaths} time${online.deaths === 1 ? '' : 's'} downed</p><div class="go" id="respawnIn">Back in the air in 3…</div><div class="btns"><button data-act="pause">${isTouch ? 'Leave room…' : 'Room menu (Esc)'}</button></div></div></div>`;
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
  hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center"><p class="score"><b>${final}</b><span>points</span></p><p>${what}</p>${waveLine()}<p class="best${isBest ? ' new' : ''}">${isBest ? 'New best!' : `Best: ${best}`}</p><div class="go">${isTouch ? 'Tap to fly again' : 'Press any key or button to fly again'}</div><div class="btns"><button data-act="menu">${isTouch ? 'Menu' : 'Menu (Esc / B)'}</button></div></div></div>`;
  setTimeout(() => { if (mode === 'crashed' && !downcam.playing) hud.overlay.classList.remove('hidden'); }, 700);
}

/** Escalating waves, on the end screens: how many you cleared, and the record for this starting number. */
function waveLine() {
  if (!dogfight.escalate) return '';
  const rec = loadBestWave();
  return `<p class="best${waveRecord ? ' new' : ''}">${wavesCleared} wave${wavesCleared === 1 ? '' : 's'} cleared${waveRecord ? ' · new record!' : rec ? ` · record ${rec}` : ''}</p>`;
}

// ---------- Winning score: the match ends when someone gets there ----------
/** Solo arena: you shot down enough birds. */
function winSolo() {
  mode = 'over'; overAt = performance.now();
  const final = Math.floor(score);
  const isBest = final > best;
  if (isBest) { best = final; try { localStorage.setItem(bestKey(), String(best)); } catch { /* ignore */ } }
  audio.whoosh(1); audio.beep(1400, 0.2, 0.07); setTimeout(() => audio.beep(2100, 0.25, 0.07), 160); rumble(0.6, 250);
  hud.overlay.innerHTML = `<div class="menu"><h1>You win!</h1><div class="panel center"><p class="big">First to ${winTarget()} · ${dogfight.kills} shot down</p><p class="score"><b>${final}</b><span>points</span></p><p>${getArena()?.name ?? 'Arena'} · wave ${Math.max(1, dogfight.wave)}</p>${waveLine()}<p class="best${isBest ? ' new' : ''}">${isBest ? 'New best!' : `Best: ${best}`}</p><div class="go">${isTouch ? 'Tap to fly again' : 'Press any key or button to fly again'}</div><div class="btns"><button data-act="menu">${isTouch ? 'Menu' : 'Menu (Esc / B)'}</button></div></div></div>`;
  setTimeout(() => { if (mode === 'over') hud.overlay.classList.remove('hidden'); }, 900);
}
/** Online: the host called the match. Show who won and the final scores, then everyone goes back to the room. */
function showOnlineResult(r: MatchResult) {
  closePause();
  if (downcam.playing) endDownCam();
  dogfight.reset();
  mode = 'over'; overAt = performance.now(); slowmo = 0;
  countdownEl.style.display = 'none';
  if (r.race !== undefined) { showRaceResult(r); return; }
  const me = r.players.find((p) => p.id === online.myId);
  const teams = r.team >= 0;
  const iWon = teams ? me?.team === r.team : r.winner === online.myId;
  const winnerName = r.players.find((p) => p.id === r.winner)?.name ?? 'Someone';
  const title = teams ? `<span style="color:${TEAM_CSS[r.team]}">${TEAM_NAMES[r.team]} wins!</span>` : iWon ? 'You win!' : `${esc(winnerName)} wins!`;
  const sub = teams ? (iWon ? 'Your team got there first' : 'The other team got there first') : iWon ? `First to ${r.winAt} kills` : `First to ${r.winAt} kills · better luck next time`;
  const sorted = [...r.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const row = (p: PlayerResult) => `<li${p.id === online.myId ? ' class="me"' : ''}><i style="background:${teams ? TEAM_CSS[p.team] : PLAYER_CSS[colorIndex(p.id)]}"></i><span>${esc(p.name)}${p.id === online.myId ? ' <em>you</em>' : ''}</span><b>${p.kills}</b><small>${p.deaths}</small></li>`;
  const list = teams
    ? [r.team, 1 - r.team].map((k) => { const tm = sorted.filter((p) => p.team === k); return tm.length ? `<li class="teamhead" style="color:${TEAM_CSS[k]}"><span>${TEAM_NAMES[k]} team</span><b>${tm.reduce((a, p) => a + p.kills, 0)}</b><small></small></li>${tm.map(row).join('')}` : ''; }).join('')
    : sorted.map(row).join('');
  if (iWon) { audio.whoosh(1); audio.beep(1400, 0.2, 0.07); setTimeout(() => audio.beep(2100, 0.25, 0.07), 160); rumble(0.6, 250); } else audio.beep(600, 0.3, 0.07);
  hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center"><p class="big">${sub}</p>
    <ul class="standings"><li class="head"><i></i><span></span><b>Kills</b><small>Downed</small></li>${list}</ul>
    <div class="go">${isTouch ? 'Tap to go back to the room' : 'Press any key or button to go back to the room'}</div>
    <p class="blurb small">${online.isHost ? 'Start another match from the room when you\'re ready.' : 'The host can start another match from there.'}</p></div></div>`;
  hud.overlay.classList.remove('hidden');
}
type PlayerResult = MatchResult['players'][number];
/** Live race over: the finishing order and times. */
function showRaceResult(r: MatchResult) {
  const iWon = r.winner === online.myId;
  const winnerName = r.players.find((p) => p.id === r.winner)?.name ?? '';
  const title = !r.winner ? 'Nobody finished!' : iWon ? 'You win!' : `${esc(winnerName)} wins!`;
  const row = (p: PlayerResult, i: number) => `<li${p.id === online.myId ? ' class="me"' : ''}><i style="background:${PLAYER_CSS[colorIndex(p.id)]}"></i><span>${p.ms && p.ms > 0 ? `${i + 1}. ` : ''}${esc(p.name)}${p.id === online.myId ? ' <em>you</em>' : ''}</span><b class="time">${p.ms && p.ms > 0 ? fmtTime(p.ms) : 'DNF'}</b><small>${p.deaths}</small></li>`;
  if (iWon) { audio.whoosh(1); audio.beep(1400, 0.2, 0.07); setTimeout(() => audio.beep(2100, 0.25, 0.07), 160); rumble(0.6, 250); } else audio.beep(600, 0.3, 0.07);
  hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center"><p class="big">${esc(r.race ?? '')}</p>
    <ul class="standings race"><li class="head"><i></i><span></span><b class="time">Time</b><small>Downed</small></li>${r.players.map(row).join('')}</ul>
    <div class="go">${isTouch ? 'Tap to go back to the room' : 'Press any key or button to go back to the room'}</div>
    <p class="blurb small">${online.isHost ? 'Start another race from the room when you\'re ready.' : 'The host can start another race from there.'}</p></div></div>`;
  hud.overlay.classList.remove('hidden');
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
      if (Math.random() < 0.3) botSay(OOPS, ev.enemy);
      popup(ev.ground ? `Ground kill! +${pts}` : `Shot down! +${pts}`, `${ev.role === 'hunter' ? 'hunter' : 'bandit'} · ${dogfight.kills} down`);
      audio.thud(); audio.whoosh(0.8); rumble(0.6, 200); slowmo = 0.4;
      if (settings.mode === 'arena' && winTarget() > 0 && dogfight.kills >= winTarget()) winSolo();
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
    case 'wave': {
      audio.beep(700, 0.25, 0.08);
      // escalating: name the birds, and say when they've got sharper
      const tier = dogfight.escalate ? waveTier(ev.wave) : '';
      const sharper = tier && ev.wave > 1 && tier !== waveTier(ev.wave - 1);
      popup(`Wave ${ev.wave}`, `${ev.count} bird${ev.count > 1 ? 's' : ''}${tier ? ` · ${tier}${sharper ? ': sharper flyers!' : ''}` : ''}`);
      break;
    }
    case 'waveCleared': {
      // clearing a wave pays out, grows a feather back and refills your darts
      const pts = Math.round(500 * ev.wave * multiplier());
      score += pts; combo++; comboTimer = 4;
      hp = Math.min(3, hp + 1); hpRegen = 0;
      if (myDartsOn()) { dogfight.dartsLeft = MAX_DARTS; dogfight.dartCharge = 0; }
      audio.whoosh(1); audio.beep(1400, 0.2, 0.07);
      waveClearedT = 4;
      if (dogfight.escalate) {
        // a record for this starting number of birds
        wavesCleared = ev.wave;
        if (ev.wave > loadBestWave()) {
          try { localStorage.setItem(bestWaveKey(), String(ev.wave)); } catch { /* storage off */ }
          waveRecord = true;
        }
        const next = waveBirds(settings.enemies, ev.wave + 1);
        popup(`Wave ${ev.wave} cleared! +${pts}`, `${waveRecord ? 'New record! · ' : ''}next: ${next} bird${next > 1 ? 's' : ''}`);
      } else popup(`Wave ${ev.wave} cleared! +${pts}`);
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

// ---------- Time trial races ----------
// A set course, the same for everyone. The clock starts at the start line and stops at the finish, with a split
// at every gate. A crash sends you back to the top; the left stick click (or Backspace) restarts any time.
// The stopwatch is green while you're ahead of the reference run (the ghost you picked, or else the record)
// and red while you're behind it.
const builtIn = () => COURSES[THREE.MathUtils.clamp(settings.course | 0, 0, COURSES.length - 1)];
/** The course picked in the menu: a built-in one, or one of your imported maps once it's built. */
const course = (): CourseDef => (settings.mapId && userMaps.find((m) => m.stored.id === settings.mapId)?.def) || builtIn();
settings.course = THREE.MathUtils.clamp(Math.round(settings.course) || 0, 0, COURSES.length - 1);
// (dev / sharing: ?course=<id> opens straight onto that course in Race mode)
{ const dev = courseById(new URLSearchParams(location.search).get('course') ?? ''); if (dev) { settings.mode = 'race'; settings.course = COURSES.indexOf(dev); settings.mapId = ''; } }

// ---------- Your own maps: imported heightmaps and models, kept on this device ----------
const userMaps: { stored: StoredMap; def: CourseDef | null; building: Promise<void> | null; error: string }[] = [];
const pickedMap = () => (settings.mapId ? userMaps.find((m) => m.stored.id === settings.mapId) ?? null : null);
/** Is the picked map still being built (so the menu shouldn't start a race on the fallback course)? */
const mapPending = () => { const m = pickedMap(); return !!m && !m.def; };
function ensureBuilt(m: typeof userMaps[number]): Promise<void> {
  if (m.def || m.error) return Promise.resolve();
  if (!m.building) m.building = buildMap(m.stored).then((d) => { m.def = d; }, (e) => { m.error = (e as Error).message || 'Couldn\'t build this map.'; })
    .finally(() => { m.building = null; if (m.stored.id === settings.mapId) { refreshBoard(); queuePreview(); } if (mode === 'title' && racing()) renderMenu(); });
  return m.building;
}
function stepCourse(d: number) {
  const n = COURSES.length + userMaps.length;
  let i = settings.mapId ? COURSES.length + userMaps.findIndex((m) => m.stored.id === settings.mapId) : settings.course;
  if (i < 0) i = 0;
  i = (i + d + n) % n;
  if (i < COURSES.length) { settings.course = i; settings.mapId = ''; }
  else { const m = userMaps[i - COURSES.length]; settings.mapId = m.stored.id; ensureBuilt(m); }
}
listMaps().then((list) => {
  for (const stored of list) userMaps.push({ stored, def: null, building: null, error: '' });
  const m = pickedMap();
  if (settings.mapId && !m) settings.mapId = '';
  if (m) ensureBuilt(m);
  if (mode === 'title' && racing()) renderMenu();
});
const mapInput = document.createElement('input');
mapInput.type = 'file'; mapInput.multiple = true; mapInput.accept = ACCEPT; mapInput.style.display = 'none';
document.body.appendChild(mapInput);
mapInput.addEventListener('change', () => { const f = [...(mapInput.files ?? [])]; mapInput.value = ''; if (f.length) openImporter(f); });
function pickMapFiles() { mapInput.click(); }
async function removeMap() {
  const m = pickedMap();
  if (!m || !confirm(`Remove "${m.stored.spec.name}" from this device? Your best time on it goes too.`)) return;
  await deleteMap(m.stored.id).catch(() => {});
  try { localStorage.removeItem(`glide.race.${m.def ? boardKey(m.def) : `map-${m.stored.id}-v1`}`); } catch { /* storage off */ }
  userMaps.splice(userMaps.indexOf(m), 1);
  settings.mapId = ''; saveSettings(); refreshBoard(); queuePreview(); renderMenu();
}
// drop files anywhere on the title screen to import them
addEventListener('dragover', (e) => { if (mode === 'title') e.preventDefault(); });
addEventListener('drop', (e) => {
  if (mode !== 'title') return;
  e.preventDefault();
  const f = [...(e.dataTransfer?.files ?? [])];
  if (f.length) openImporter(f);
});

/** The import card: what was picked, a few settings (size, height range, scale), then build it and race. */
let importer: { files: MapFile[]; spec: MapSpec; busy: boolean; error: string } | null = null;
const importEl = document.createElement('div');
importEl.id = 'importer';
document.body.appendChild(importEl);
async function openImporter(list: File[]) {
  if (settings.mode !== 'race') { settings.mode = 'race'; loadBest(); queuePreview(); renderMenu(); }
  const files: MapFile[] = [];
  for (const f of list) files.push({ name: f.name, data: await f.arrayBuffer() });
  importer = { files, spec: null!, busy: false, error: '' };
  try { importer.spec = guessSpec(files); filesFor(importer.spec, files); }
  catch (e) { importer.error = (e as Error).message; }
  renderImporter();
}
function closeImporter() { importer = null; importEl.classList.remove('on'); importEl.innerHTML = ''; }
function renderImporter() {
  if (!importer) return closeImporter();
  const { spec, files, error, busy } = importer;
  const names = files.map((f) => `${esc(f.name)} <i>${(f.data.byteLength / 1e6).toFixed(1)} MB</i>`).join('<br>');
  const t = spec?.terrain as (MapSpec['terrain'] & Record<string, any>) | undefined;
  const fromJson = files.some((f) => /\.json$/i.test(f.name));
  const num = (id: string, label: string, small: string, v: number) =>
    `<div class="opt"><label class="lab" for="${id}">${label}<small>${small}</small></label><span class="ctl"><input id="${id}" type="number" inputmode="decimal" value="${v}"></span></div>`;
  let fields = '';
  if (spec && !fromJson) {
    if (t && 'heightmap' in t) {
      const size = Array.isArray(t.size) ? t.size[0] : t.size ?? 3000, h = Array.isArray(t.height) ? t.height : [0, t.height ?? 700];
      fields = num('impW', 'Width', 'metres across (a 2 min run is about 5 km)', size) + num('impLo', 'Lowest point', 'metres (black)', h[0]) + num('impHi', 'Highest point', 'metres (white)', h[1]);
    } else if (t) fields = num('impS', 'Scale', 'metres per model unit (Blender: 1)', t.scale ?? 1) + num('impR', 'Turn', 'degrees, so the run goes your way', t.rotate ?? 0);
  }
  const biome = spec ? `<div class="opt"><label class="lab" for="impB">Look<small>trees, rock and sky</small></label><span class="ctl"><select id="impB">${BIOMES.map((b) => `<option${b === spec.biome ? ' selected' : ''}>${b}</option>`).join('')}</select></span></div>` : '';
  importEl.innerHTML = `<div class="menu"><div class="panel">
    <h1>Import a map</h1>
    <p class="blurb small">${names}</p>
    ${spec ? `<div class="opt"><label class="lab" for="impN">Name</label><span class="ctl"><input id="impN" maxlength="40" value="${esc(spec.name)}" autocomplete="off" spellcheck="false"></span></div>${fields}${biome}` : ''}
    ${spec && !fromJson && !(t && 'model' in t) ? '<p class="blurb small">No start or finish given, so the race runs from the highest point to the lowest. Add a map .json to place your own.</p>' : ''}
    ${spec && t && 'model' in t ? '<p class="blurb small">Empties named START, SPLIT1, SPLIT2… and FINISH place the timing lines (otherwise it runs from the highest point to the lowest). TREE, ROCK and PILLAR empties place obstacles.</p>' : ''}
    ${error ? `<p class="note">${esc(error)}</p>` : ''}
    <div class="btns">${spec ? `<button data-imp="go" class="go-btn cta"${busy ? ' disabled' : ''}>${busy ? 'Building…' : 'Import and race'}</button>` : ''}<button data-imp="cancel">Cancel</button></div>
    <p class="blurb small">Heightmaps: PNG (8 or 16-bit), JPG, WebP, RAW (.r16). Models: GLB, glTF, OBJ. Up to ${LIMITS.fileMB} MB a file.</p>
  </div></div>`;
  importEl.classList.add('on');
}
importEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-imp]')?.getAttribute('data-imp');
  if (b === 'cancel') closeImporter();
  else if (b === 'go') importMap();
});
importEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImporter(); e.stopPropagation(); });
async function importMap() {
  const im = importer;
  if (!im?.spec || im.busy) return;
  const val = (id: string) => { const el = document.getElementById(id) as HTMLInputElement | null; const v = el ? parseFloat(el.value) : NaN; return Number.isFinite(v) ? v : undefined; };
  const name = (document.getElementById('impN') as HTMLInputElement | null)?.value.trim();
  const biome = (document.getElementById('impB') as HTMLSelectElement | null)?.value;
  const raw = JSON.parse(JSON.stringify(im.spec)) as MapSpec & { terrain: Record<string, any> };
  if (name) raw.name = name;
  if (biome) raw.biome = biome as MapSpec['biome'];
  if ('heightmap' in raw.terrain) {
    const w = val('impW'), lo = val('impLo'), hi = val('impHi');
    if (w !== undefined) raw.terrain.size = w;
    if (lo !== undefined || hi !== undefined) raw.terrain.height = [lo ?? 0, Math.max((lo ?? 0) + 1, hi ?? 700)];
  } else {
    const sc = val('impS'), r = val('impR');
    if (sc !== undefined) raw.terrain.scale = sc;
    if (r !== undefined) raw.terrain.rotate = r;
  }
  im.busy = true; im.error = ''; renderImporter();
  try {
    if (userMaps.length >= LIMITS.maps) throw new Error(`You have ${LIMITS.maps} maps on this device. Remove one first.`);
    const spec = checkSpec(raw);
    const files = filesFor(spec, im.files);
    const id = await mapId(spec, files);
    const stored: StoredMap = { id, spec, files, at: Date.now() };
    const def = await buildMap(stored);
    await saveMap(stored).catch(() => { throw new Error('Couldn\'t save the map on this device (storage full or private browsing?).'); });
    const old = userMaps.findIndex((m) => m.stored.id === id);
    const entry = { stored, def, building: null, error: '' };
    if (old >= 0) userMaps[old] = entry; else userMaps.push(entry);
    settings.mapId = id; saveSettings();
    if (importer === im) closeImporter();
    boardSel = 0; menuRow = GO_ROW; refreshBoard(); queuePreview(); renderMenu();
  } catch (e) {
    im.busy = false; im.error = (e as Error).message || String(e);
    if (importer === im) renderImporter();
  }
}
const racing = () => settings.mode === 'race';
function enterCourse(c: CourseDef) {
  setArena(null); setCourse(c); applyLook();
}

let run = new RaceRun(course());
let finishT = 0;
const ghost = new Ghost(scene);
/** The run your stopwatch is compared against. */
let ref: { name: string; ms: number; splits: number[]; data: GhostData | null; mine: boolean } | null = null;
const refTimer = new Ghost(scene); // (an unseen copy of the reference run, used to find its time near you)
/** Ghost you picked to race, per course. */
const ghostPick = new Map<string, string>();
let raceNote = '';
let lastDelta: number | null = null;
let splitFlash = 0;

function spawnRace(c = course()) {
  enterCourse(c);
  input.recenter(); input.setThrottle(0);
  dogfight.spawning = false; dogfight.targets = []; dogfight.reset(); dogfight.arenaCount = 0; dogfight.escalate = false;
  gates.reset(); puffs.clear(); resetDownCam();
  const { x, y, z } = c.start;
  glider.reset(x, y, z, c.start.heading); glider.speed = c.start.speed;
  startZ = z; score = 0; combo = 0; slowmo = 0; shake = 0; hp = 3;
  near.clear(); prevPos.copy(glider.pos); wasInCloud = false;
  run = new RaceRun(c); run.reset(); finishT = 0; lastDelta = null; splitFlash = 0;
  ghost.resetCursor(); refTimer.resetCursor();
  for (let i = 0; i < 12 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; i++);
  placeCamera(true);
}
function restartRace() {
  spawnRace();
  mode = 'flying'; hud.overlay.classList.add('hidden');
}
/** Pick the ghost and the reference run for this race, and fetch their flights. */
async function loadRaceRefs() {
  const c = course(), key = boardKey(c);
  const b = boards.get(key)?.board;
  const pick = ghostPick.get(key);
  const me = await myPid();
  const items = boardItems();
  const pickEntry = pick ? items.find((e) => e.pid === pick) : undefined;
  const refEntry = pickEntry ?? b?.entries[0] ?? items[0];
  ghost.set(null); refTimer.set(null);
  ref = refEntry ? { name: refEntry.name, ms: refEntry.ms, splits: refEntry.splits, data: null, mine: refEntry.pid === me } : null;
  if (pickEntry) {
    const d = await fetchGhost(key, pickEntry.pid).catch(() => null);
    if (boardKey(course()) !== key) return;
    ghost.set(d, pickEntry.name);
    if (ref) ref.data = d;
  } else if (refEntry) {
    const d = await fetchGhost(key, refEntry.pid).catch(() => null);
    if (boardKey(course()) !== key) return;
    if (ref) ref.data = d;
  }
  if (ref?.data) { refTimer.set(ref.data); if (refTimer.line) refTimer.line.visible = false; }
}
function stepRace(dt: number) {
  glider.applyTo(bird);
  const owed = run.next;
  const g = run.step(dt, prevPos, glider.pos, bird.quaternion);
  if (g === MISSED) {
    // skipped a checkpoint: back to the top, like a crash
    mode = 'crashed'; crashTimer = 0;
    raceCrashed(`Missed checkpoint ${owed + 1}`);
    audio.thud(); rumble(0.6, 200);
    return;
  }
  if (g < 0) return;
  splitFlash = 2.5;
  audio.beep(g === run.gates.length - 1 ? 1500 : 1200, 0.12, 0.08);
  if (run.state === 'finished') finishRace();
}
function raceCrashed(title: string) {
  hud.overlay.innerHTML = `<div class="menu"><h1>${title}</h1><div class="panel center"><p>Back to the top…</p>
    <div class="go">${isTouch ? 'Tap to go now' : 'Any key or button to go now'}</div></div></div>`;
  hud.overlay.classList.remove('hidden');
}
function finishRace() {
  mode = 'finished'; finishT = 0;
  const c = course(), ms = run.splits[run.splits.length - 1];
  const prev = localBest(boardKey(c));
  const pb = !prev || ms < prev.ms;
  const d = ref ? ms - ref.ms : null;
  const rows = run.splits.map((t, i) => {
    const rd = ref?.splits[i] !== undefined ? t - ref.splits[i] : null;
    return `<tr><td>${esc(sectionName(c, i))}</td><td>${fmtTime(t)}</td><td class="${rd === null ? '' : rd < 0 ? 'ahead' : 'behind'}">${rd === null ? '' : fmtDelta(rd)}</td></tr>`;
  }).join('');
  hud.overlay.innerHTML = `<div class="menu"><h1>${pb ? 'New best!' : 'Finished'}</h1><div class="panel center">
    <p class="score"><b>${fmtTime(ms)}</b><span>${esc(c.name)}</span></p>
    ${d !== null ? `<p class="${d < 0 ? 'ahead' : 'behind'}">${fmtDelta(d)} vs ${ref!.mine ? 'your best' : esc(ref!.name)}</p>` : ''}
    <table class="splits">${rows}</table>
    <p id="raceRank" class="best">${hasGlobalBoard() && !c.local ? 'Sending your time…' : pb ? 'Saved on this device' : `Your best: ${fmtTime(prev!.ms)}`}</p>
    <div class="go">${isTouch ? 'Tap to race again' : 'Any key or button to race again'}</div>
    <div class="btns"><button data-act="menu">${isTouch ? 'Menu' : 'Menu (Esc / B)'}</button></div></div></div>`;
  hud.overlay.classList.remove('hidden');
  const name = (settings.name || '').trim() || 'Bird';
  submitRun(c, run, name).then((r) => {
    const el = document.getElementById('raceRank');
    if (r.rank) {
      if (el) el.textContent = r.best ? `#${r.rank} of ${r.total} on the board` : `Your best is #${r.rank} of ${r.total}`;
    } else if (el && hasGlobalBoard() && !c.local) el.textContent = r.error === 'offline' ? 'Couldn\'t reach the board (saved on this device)' : `The board didn't take this run (${r.error ?? 'error'})`;
    boards.delete(boardKey(c)); // the menu fetches it fresh
  });
}

// ---------- Live race (online): everyone down the same course at once ----------
// The host picks a course and starts; everyone lines up abreast on the start, counts down together and goes.
// The clock runs from GO. A crash or being shot down puts you straight back in the air where you went down, at
// base speed (that lost speed is the cost). Skipping a checkpoint sends you back to the last one you passed.
// The race ends when everyone's over the line, or a minute after the winner finishes.
/** A moment on the ground (or falling) before you're back in the air. */
const RACE_RESPAWN = 0.8, RACE_COUNTDOWN = 3.5, RACE_CLOSE = 60, RACE_MAX = 15 * 60;
let liveCourse: CourseDef = COURSES[0];
/** Seconds since GO on your clock; the countdown left (> 0 = held on the grid). */
let liveClock = 0, liveHold = 0;
/** When GO is (wall clock, ms): the countdown runs on real time, so everyone goes together whatever their frame rate. */
let liveGoAt = 0;
/** When the first bird over the line was seen (wall clock, ms; 0 = nobody yet). */
let firstFinAt = 0;
let liveBeep = 4;
const countdownEl = $('countdown');

function startLiveRace(rules: MatchRules) {
  const c = courseById(rules.race ?? '') ?? COURSES[0];
  liveCourse = c;
  enterCourse(c);
  puffs.clear(); gates.reset(); resetDownCam();
  dogfight.playerDarts = rules.myDarts; dogfight.enemyDarts = false;
  dogfight.reset(); dogfight.spawning = false; dogfight.targets = []; dogfight.arenaCount = 0;
  score = 0; combo = 0; comboTimer = 0; slowmo = 0; feed.length = 0;
  ghost.set(null); refTimer.set(null); ref = null;
  run = new RaceRun(c); run.reset(); run.state = 'running';
  liveClock = 0; liveHold = RACE_COUNTDOWN; liveGoAt = performance.now() + RACE_COUNTDOWN * 1000; liveBeep = 4; firstFinAt = 0; finishT = 0; lastDelta = null; splitFlash = 0;
  // the grid: one row abreast across the start, in player order
  const ids = (rules.racers?.length ? rules.racers : online.roster().map((p) => p.id)).slice().sort();
  const i = Math.max(0, ids.indexOf(online.myId)), n = Math.max(1, ids.length);
  const { x, y, z, heading } = c.start;
  let lat = (i - (n - 1) / 2) * 7;
  let px = x, py = y, pz = z;
  for (let k = 0; k < 4; k++, lat *= 0.5) { // (squeeze in toward the middle if that spot is in rock)
    px = x + Math.cos(heading) * lat; pz = z - Math.sin(heading) * lat;
    py = Math.max(y, floorBelow(px, y + 40, pz) + 14);
    if (solidClearance(px, py, pz) > 5) break;
  }
  placeLive(px, py, pz, heading, c.start.speed);
  dogfight.dartsLeft = rules.myDarts ? MAX_DARTS : 0; dogfight.dartCharge = 0;
  spawnShield = RACE_COUNTDOWN + 1;
}
/** Where you went down (and which way you were flying), or null after a skipped checkpoint. */
let liveDown: { p: THREE.Vector3; dir: THREE.Vector3; wall: boolean } | null = null;
const _rp = new THREE.Vector3();
/** Room to fly at p: clear of rock by 3 m and of trees, rocks and pillars by 3 m. */
function liveClear(x: number, y: number, z: number) {
  if (solidClearance(x, y, z) < 3) return false;
  obstaclesNear(x, z, 14, nearby);
  return nearby.every((o) => o.soft || obstacleGap(o, x, y, z) > 3);
}
/** A clear run: nothing to hit for the first ~2 s of flight from (x, y, z) along `heading`, even sinking the
 *  way a bird does with hands off the controls (about 1 m down for every 4 along). */
function liveRunClear(x: number, y: number, z: number, heading: number) {
  const fx = -Math.sin(heading), fz = -Math.cos(heading);
  for (let d = 0; d <= 70; d += 3) {
    const px = x + fx * d, pz = z + fz * d;
    for (const yy of [y, y - d * 0.25]) if (!liveClear(px, yy, pz)) return false;
  }
  return true;
}
/** Where to put you back after going down at `down`: as close to it as possible, with a clear run ahead. Tries
 *  backing off along your line, then rising above the trees, then turning (toward the next checkpoint first). */
function liveSpot(down: { p: THREE.Vector3; dir: THREE.Vector3; wall: boolean }) {
  const h0 = Math.hypot(down.dir.x, down.dir.z) > 0.2 ? Math.atan2(-down.dir.x, -down.dir.z) : glider.heading;
  const g = run.gates[Math.min(run.next, run.gates.length - 1)];
  const hGate = Math.atan2(-(g.x - down.p.x), -(g.z - down.p.z));
  const headings = [h0, hGate, h0 + 0.5, h0 - 0.5, hGate + 0.6, hGate - 0.6, h0 + 1.1, h0 - 1.1];
  for (const back of down.wall ? [8, 16, 26, 40] : [0, 8, 16, 30])
    for (const up of [0, 8, 16, 26, 38]) {
      const x = down.p.x + Math.sin(h0) * back, z = down.p.z + Math.cos(h0) * back; // (back along your line)
      const y = Math.max(down.p.y, floorBelow(x, down.p.y + 2, z) + 12) + up;
      if (!liveClear(x, y, z)) continue;
      for (const h of headings) if (liveRunClear(x, y, z, h)) return { x, y, z, heading: h };
    }
  return null;
}
/** Back in the air: where you went down at base speed, or after a skipped checkpoint just past the last one you passed. */
function liveRespawn() {
  const c = liveCourse;
  const down = liveDown;
  liveDown = null;
  if (down) {
    const spot = liveSpot(down);
    if (spot) { placeLive(spot.x, spot.y, spot.z, spot.heading, c.start.speed); spawnShield = 2; return; }
    // (nowhere clear near where you went down: fall back to the last checkpoint)
  }
  if (run.next === 0) {
    const { x, y, z, heading } = c.start, lat = (Math.random() - 0.5) * 20;
    const px = x + Math.cos(heading) * lat, pz = z - Math.sin(heading) * lat;
    placeLive(px, Math.max(y, floorBelow(px, y + 40, pz) + 14), pz, heading, c.start.speed);
  } else {
    const g = run.gates[run.next - 1];
    const x = g.x + g.nx * 10, z = g.z + g.nz * 10;
    const fl = floorBelow(x, g.y, z);
    placeLive(x, Math.max(fl + 4, Math.min(g.y, fl + 14)), z, Math.atan2(-g.nx, -g.nz), c.start.speed);
  }
  spawnShield = 2;
}
function placeLive(x: number, y: number, z: number, heading: number, speed: number) {
  input.recenter(); input.setThrottle(0);
  glider.reset(x, y, z, heading); glider.speed = speed;
  startZ = z; prevPos.copy(glider.pos);
  near.clear(); trickMinClear = 99; inLoop = false; wasInCloud = false; slowmo = 0; shake = 0;
  hp = 3; hpRegen = 0; hitFlash = 0; lastAttacker = ''; lastHitT = -99;
  dogfight.locked = null; dogfight.locking = null; dogfight.lockT = 0;
  for (const d of dogfight.darts) d.tracking = false;
  for (let k = 0; k < 12 && world.update(glider.pos.x, glider.pos.z - 150, 8) > 0; k++);
  online.alive = true; resetDownCam();
  mode = 'flying'; hud.overlay.classList.add('hidden');
  placeCamera(true);
}
/** Down (crashed or shot down): back in the air a moment later, where you went down.
 *  `skipped`: a missed checkpoint, which sends you back to the last one you passed. */
function liveCrashed(skipped: boolean, wall: boolean) {
  respawnAt = RACE_RESPAWN;
  liveDown = skipped ? null : { p: glider.pos.clone(), dir: glider.dir.clone(), wall };
  hud.overlay.classList.add('hidden');
}
/** Every frame in the air: the checkpoints, on the shared clock. */
function stepLive(dt: number) {
  glider.applyTo(bird);
  const owed = run.next;
  run.time = liveClock - dt; // (step() adds dt back, timing a crossing inside this frame to the millisecond)
  const g = run.step(dt, prevPos, glider.pos, bird.quaternion);
  if (g === MISSED) { run.state = 'running'; lastAttacker = ''; crash(`Missed checkpoint ${owed + 1}`); return; }
  online.raceGates = run.next;
  if (g < 0) return;
  splitFlash = 2.5;
  audio.beep(g === run.gates.length - 1 ? 1500 : 1200, 0.12, 0.08);
  if (run.state === 'finished') {
    mode = 'finished'; finishT = 0;
    online.raceFin = run.splits[run.splits.length - 1];
    audio.whoosh(1); rumble(0.6, 250);
    hud.overlay.innerHTML = `<div class="menu"><h1>Finished!</h1><div class="panel center">
      <p class="score"><b>${fmtTime(online.raceFin)}</b><span>${esc(liveCourse.name)}</span></p>
      <p class="big" id="livePos"></p><p id="liveWait"></p>
      <div class="btns"><button data-act="pause">${isTouch ? 'Leave room…' : 'Room menu (Esc)'}</button></div></div></div>`;
    hud.overlay.classList.remove('hidden');
  }
}
interface Standing { id: string; name: string; fin: number; gates: number; dist: number }
/** Where everyone is: over the line first (fastest first), then by checkpoints passed, then by how close to the next one. */
function standings(): Standing[] {
  const gl = run.gates;
  const dist = (n: number, p: THREE.Vector3) => { const g = gl[Math.min(n, gl.length - 1)]; return Math.hypot(p.x - g.x, p.z - g.z); };
  const list: Standing[] = [];
  if (online.racers.has(online.myId)) list.push({ id: online.myId, name: online.name, fin: online.raceFin, gates: run.next, dist: dist(run.next, glider.pos) });
  for (const r of online.remotes.values()) {
    if (!online.racers.has(r.id)) continue;
    list.push({ id: r.id, name: r.name, fin: r.fin, gates: r.gates, dist: dist(r.gates, r.target.pos) });
  }
  return list.sort((a, b) => (a.fin && b.fin ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.gates - a.gates || a.dist - b.dist));
}
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
/** Every frame of a live race: the countdown, the clock, and (host) whether the race is over. */
function updateLive(dt: number) {
  const was = liveHold;
  liveHold = (liveGoAt - performance.now()) / 1000; // (it runs on below 0: GO! shows for a second)
  if (was > 0) {
    const n = Math.ceil(liveHold);
    if (n < liveBeep && n >= 1 && n <= 3) { liveBeep = n; audio.beep(900, 0.14, 0.08); }
    if (liveHold <= 0) { audio.beep(1700, 0.3, 0.09); rumble(0.4, 150); }
  }
  if (liveHold <= 0 && run.state === 'running') liveClock += Math.min(dt, -liveHold);
  const show = liveHold > 0 ? String(Math.ceil(liveHold)) : liveHold > -1 ? 'GO!' : '';
  countdownEl.style.display = show ? 'block' : 'none';
  if (show && countdownEl.textContent !== show) countdownEl.textContent = show;
  const st = standings();
  if (!firstFinAt && st.some((s) => s.fin > 0)) firstFinAt = performance.now();
  if (mode === 'finished') {
    const me = st.findIndex((s) => s.id === online.myId) + 1, left = st.filter((s) => !s.fin).length;
    const posEl = document.getElementById('livePos'), waitEl = document.getElementById('liveWait');
    if (posEl) posEl.textContent = me ? `${ordinal(me)} of ${st.length}` : '';
    if (waitEl) waitEl.textContent = left ? `Waiting for ${left} more · the finish closes in ${Math.max(0, Math.ceil(RACE_CLOSE - (performance.now() - firstFinAt) / 1000))} s` : '';
  }
  // host: everyone's in, or time's up for the stragglers
  if (online.isHost && st.length && (st.every((s) => s.fin > 0) || (firstFinAt && performance.now() - firstFinAt > RACE_CLOSE * 1000) || liveClock > RACE_MAX)) {
    online.endRace(st.map((s) => ({ id: s.id, ms: s.fin || -1 })), liveCourse.name);
  }
}

// ---------- Race menu: the course, its leaderboard, and the ghost to race ----------
const boards = new Map<string, { state: 'loading' | 'ok' | 'error'; board: Board | null }>();
let boardSel = 0;
let myPidNow = '';
myPid().then((p) => { myPidNow = p; });
async function refreshBoard() {
  const key = boardKey(course());
  const cur = boards.get(key);
  if (cur?.state === 'loading') return;
  if (!hasGlobalBoard() || course().local) { boards.set(key, { state: 'ok', board: null }); return; }
  boards.set(key, { state: 'loading', board: cur?.board ?? null });
  try { boards.set(key, { state: 'ok', board: await fetchBoard(key) }); }
  catch { boards.set(key, { state: 'error', board: cur?.board ?? null }); }
  if (mode === 'title' && racing()) renderMenu();
}
/** The rows you can pick a ghost from: the top times, plus your own best if it isn't among them. */
function boardItems(): (BoardEntry & { mine?: boolean })[] {
  const key = boardKey(course());
  const b = boards.get(key)?.board;
  const out: (BoardEntry & { mine?: boolean })[] = (b?.entries ?? []).slice(0, 10).map((e) => ({ ...e, mine: e.pid === myPidNow }));
  const lb = localBest(key);
  if (b?.me && !out.some((e) => e.mine)) out.push({ ...b.me, mine: true });
  else if (!out.some((e) => e.mine) && lb && myPidNow) out.push({ pid: myPidNow, name: settings.name || 'You', ms: lb.ms, splits: lb.splits, at: lb.at, mine: true });
  return out;
}
function toggleGhost(pid: string) {
  const key = boardKey(course());
  if (ghostPick.get(key) === pid) ghostPick.delete(key); else ghostPick.set(key, pid);
  renderMenu();
}
function renderRaceMenu() {
  const rows = menuRows() as readonly string[];
  if (!rows.includes(MENU_ROWS[menuRow])) menuRow = GO_ROW;
  const sel = (r: string) => (MENU_ROWS[menuRow] === r ? ' sel' : '');
  const c = course(), key = boardKey(c);
  if (!boards.has(key)) refreshBoard();
  const st = boards.get(key);
  const items = boardItems();
  boardSel = Math.min(boardSel, Math.max(0, items.length - 1));
  const pick = ghostPick.get(key);
  const list = items.length ? items.map((e, i) => `<button class="room racer${sel('board') && i === boardSel ? ' sel' : ''}${pick === e.pid ? ' picked' : ''}" data-act="ghost:${e.pid}">
      <b><i>${e.rank ? `#${e.rank}` : ''}</i>${esc(e.name)}${e.mine ? ' <em>you</em>' : ''}</b><span>${fmtTime(e.ms)}${pick === e.pid ? ' · ghost' : ''}</span></button>`).join('')
    : `<p class="blurb small">${st?.state === 'loading' ? 'Loading the top times…' : st?.state === 'error' ? 'Couldn\'t load the leaderboard.' : 'No times yet. Set the first one!'}</p>`;
  const pickName = pick ? items.find((e) => e.pid === pick)?.name : '';
  const pm = pickedMap();
  const cName = pm && !pm.def ? esc(pm.stored.spec.name) : esc(c.name);
  const cBlurb = pm && !pm.def ? (pm.error ? `Couldn't build it: ${esc(pm.error)}` : 'Building your map…') : esc(c.blurb) + (c.local ? ' · on this device' : '');
  const importRow = `<div class="opt${sel('import')}"><span class="lab">Your maps<small>${userMaps.length ? `${userMaps.length} on this device · ` : ''}heightmap or 3D model${isTouch ? '' : ', or drop files here'}</small></span>
    <span class="ctl"><button class="txt" data-act="mapimport">Import…</button>${pm ? '<button class="txt" data-act="mapremove">Remove</button>' : ''}</span></div>`;
  const head = `${modeRow(sel('mode'))}<p class="blurb">${MODE_BLURB.race}</p>
    ${pickRow(sel('course'), 'course', 'Course', cName, cBlurb)}${importRow}
    <div class="opt"><label class="lab" for="nameIn">Your name<small>shown on the leaderboard</small></label><span class="ctl"><input id="nameIn" maxlength="16" placeholder="Bird" value="${esc(settings.name)}" autocomplete="off" spellcheck="false"></span></div>`;
  const board = `${sect(hasGlobalBoard() && !c.local ? 'Top times · pick one to race its ghost' : 'Your best · pick it to race your ghost')}
    <div class="rooms board${sel('board')}" id="boardList">${list}</div>
    ${c.local ? '<p class="blurb small">Times on your own maps stay on this device.</p>' : !hasGlobalBoard() ? '<p class="blurb small">The global leaderboard is on the online version of the game.</p>' : ''}
    ${raceNote ? `<p class="note">${esc(raceNote)}</p>` : ''}`;
  const cta = `<button data-act="go" class="go-btn cta${sel('go')}">${pickName ? `Race ${esc(pickName)}'s ghost` : 'Go!'}</button>`;
  const restartHint = isTouch ? 'Tap RESTART to start over' : 'Left stick click / Backspace restarts';
  const view = `${sect('View')}${viewRow(sel('view'))}<p class="blurb small">${restartHint}. A crash sends you back to the top.</p>`;
  hud.overlay.innerHTML = compactQ.matches ? splitMenu(head + cta, board + view + helpRow(sel('help')), menuHint('race')) : `<div class="menu side">
    <h1>Glide!</h1><div class="panel">${head}${board}${view}${cta}${helpRow(sel('help'))}</div>${menuHint('race')}</div>`;
  showControls();
  revealSel();
  const nameIn = document.getElementById('nameIn') as HTMLInputElement | null;
  nameIn?.addEventListener('input', () => { settings.name = nameIn.value.slice(0, 16); saveSettings(); });
  nameIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameIn.blur(); });
}

// ---------- Race HUD: the stopwatch (top right) and the splits under it ----------
const raceEl = $('race'), ghostTag = $('ghostTag');
let raceHudT = 0;
function drawRaceHud(dt: number) {
  const live = liveRace() && mode !== 'title' && mode !== 'over';
  const on = (racing() && mode !== 'title') || live;
  raceEl.style.display = on ? 'block' : 'none';
  if (!on || live) { ghostTag.style.display = 'none'; ghost.mesh.visible = false; }
  if (live) { drawLiveHud(dt); return; }
  if (!on) return;
  const c = course();
  // the ghost flies on its own clock, parked on the line until yours starts
  const gt = run.state === 'ready' ? -1 : mode === 'finished' ? run.time + finishT : run.time;
  ghost.update(gt, t);
  if (ghost.data && ghost.mesh.visible) {
    const v = tmp.copy(ghost.mesh.position).project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
    ghostTag.style.display = vis ? 'block' : 'none';
    if (vis) {
      ghostTag.textContent = `${ghost.label} · ${Math.round(ghost.mesh.position.distanceTo(glider.pos))} m`;
      ghostTag.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px, ${(-v.y * 0.5 + 0.5) * innerHeight - 22}px) translateX(-50%)`;
    }
  } else ghostTag.style.display = 'none';
  // how you stand against the reference run: where it was at this point of the course, or at the last gate
  if (run.state === 'running' && ref) {
    const near = refTimer.timeNear(glider.pos);
    if (near !== null) lastDelta = run.time * 1000 - near * 1000;
    else if (run.splits.length && ref.splits[run.splits.length - 1] !== undefined) lastDelta = run.splits[run.splits.length - 1] - ref.splits[run.splits.length - 1];
  }
  if (mode === 'finished' && ref) lastDelta = run.ms - ref.ms;
  splitFlash -= dt;
  if ((raceHudT -= dt) > 0 && splitFlash < 2.4) return;
  raceHudT = 0.05;
  const cls = lastDelta === null ? '' : lastDelta < 0 ? 'ahead' : 'behind';
  const gates = run.gates.length;
  let rows = '';
  for (let i = 0; i < gates; i++) {
    const mine = run.splits[i], theirs = ref?.splits[i];
    const cur = i === run.splits.length && run.state === 'running';
    const d = mine !== undefined && theirs !== undefined ? mine - theirs : null;
    rows += `<div class="${mine !== undefined ? 'done' : cur ? 'cur' : ''}${i === run.splits.length - 1 && splitFlash > 0 ? ' flash' : ''}"><span>${esc(sectionName(c, i))}</span>`
      + `<i>${mine !== undefined ? fmtTime(mine) : theirs !== undefined ? fmtTime(theirs) : '–'}</i>`
      + `<i class="${d === null ? '' : d < 0 ? 'ahead' : 'behind'}">${d !== null ? fmtDelta(d) : ''}</i></div>`;
  }
  raceEl.innerHTML = `<b class="watch ${cls}">${fmtTime(run.ms)}</b>`
    + `<small>${lastDelta !== null && run.state !== 'ready' ? `<em class="${cls}">${fmtDelta(lastDelta)}</em> ` : ''}${ref ? `vs ${ref.mine ? 'your best' : esc(ref.name)} ${fmtTime(ref.ms)}` : 'no time to beat yet'}</small>`
    + `<div class="splits">${rows}</div>`;
}

/** Live race: your clock, your place, and everyone in order (with the checkpoint they're on, or their time). */
function drawLiveHud(dt: number) {
  splitFlash -= dt;
  if ((raceHudT -= dt) > 0) return;
  raceHudT = 0.1;
  const st = standings(), n = run.gates.length;
  const me = st.findIndex((s) => s.id === online.myId) + 1;
  const ms = online.raceFin || Math.round(liveClock * 1000);
  const rows = st.map((s, i) => {
    const css = PLAYER_CSS[colorIndex(s.id)];
    const where = s.fin ? fmtTime(s.fin) : s.gates >= n ? '' : s.gates === n - 1 ? 'final stretch' : `checkpoint ${s.gates + 1}/${n - 1}`;
    return `<div class="${s.fin ? 'done' : 'cur'}${s.id === online.myId ? ' me' : ''}"><span style="color:${css}">${i + 1}. ${esc(s.name)}</span><i>${where}</i></div>`;
  }).join('');
  raceEl.innerHTML = `<b class="watch">${fmtTime(ms)}</b>`
    + `<small>${me ? `<em>${ordinal(me)}</em> of ${st.length} · ` : ''}${esc(liveCourse.name)}</small>`
    + `<div class="splits live">${rows}</div>`;
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
  $('board').style.display = on && !liveRace() ? 'block' : 'none'; // (a race shows its standings with the clock)
  $('feed').style.display = on ? 'block' : 'none';
  if (!on) return;
  if ((boardT -= dt) > 0) return;
  boardT = 0.25;
  const rows = online.roster().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const row = (p: typeof rows[number]) =>
    `<div style="color:${PLAYER_CSS[colorIndex(p.id)]}"${p.id === online.myId ? ' class="me"' : ''}><span>${esc(p.name)}</span><i>${p.kills}</i><i class="d">${p.deaths}</i></div>`;
  // Team up: each team under its own heading with its total
  const winAt = online.rules?.winAt ?? 0;
  $('board').innerHTML = `<b>ROOM ${esc(online.code)}${winAt ? ` · FIRST TO ${winAt}` : ''}</b>` + (online.teams
    ? TEAM_NAMES.map((tn, k) => { const tm = rows.filter((p) => p.team === k); return tm.length ? `<div class="teamrow" style="color:${TEAM_CSS[k]}"><span>${tn}</span><i>${tm.reduce((a, p) => a + p.kills, 0)}</i><i class="d"></i></div>${tm.map(row).join('')}` : ''; }).join('')
    : rows.map(row).join(''));
  while (feed.length && t - feed[0].t > 6) feed.shift();
  $('feed').innerHTML = feed.map((f) => `<div>${esc(f.text)}</div>`).join('');
}

// ---------- Quick chat: the wheel and the chat lines ----------
const quick = new QuickChat();
const chat: { html: string; t: number }[] = [];
let chatDirty = false;
const ME_CSS = '#ff9a5a', BOT_CSS = '#c9d6e2';
function pushChat(html: string) {
  chat.push({ html, t: performance.now() / 1000 });
  if (chat.length > 5) chat.shift();
  chatDirty = true;
}
function chatLine(name: string, css: string, line: number) {
  const text = lineText(line);
  if (!text) return;
  pushChat(`<b style="color:${css}">${esc(name)}:</b> ${esc(text)}`);
  audio.beep(1250, 0.04, 0.04);
}
function chatNote(text: string) { pushChat(`<i>${esc(text)}</i>`); }
/** You sent a line: everyone in the room sees it. Offline, an AI bird might answer. */
function say(line: number) {
  const online_ = online.phase === 'playing';
  chatLine(online_ ? online.name : 'You', online_ ? PLAYER_CSS[colorIndex(online.myId)] : ME_CSS, line);
  if (online_) online.say(line);
  else { const reply = botReply(line); if (reply >= 0) botSay([reply]); }
}
/** An AI bird says one of these lines after a moment (solo modes only, and only when one is around). */
function botSay(lines: number[], who?: Enemy) {
  const bots = dogfight.enemies.filter((e) => e.alive && !e.remote && !e.friendly);
  const e = who ?? bots[Math.floor(Math.random() * bots.length)];
  if (!e) return;
  const name = BOT_NAMES[Math.max(0, dogfight.enemies.indexOf(e)) % BOT_NAMES.length];
  const line = lines[Math.floor(Math.random() * lines.length)];
  setTimeout(() => { if (mode !== 'title' && online.phase !== 'playing') chatLine(name, BOT_CSS, line); }, 700 + Math.random() * 1100);
}
function drawChat() {
  const now = performance.now() / 1000;
  while (chat.length && now - chat[0].t > 8) { chat.shift(); chatDirty = true; }
  const el = $('chat');
  el.style.display = mode === 'title' || !chat.length ? 'none' : 'block';
  if (!chatDirty) return;
  chatDirty = false;
  el.innerHTML = chat.map((c) => `<div>${c.html}</div>`).join('');
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
  const ground = floorBelow(want.x, want.y, want.z) + 1.8;
  if (want.y < ground) want.y = ground;
  // in a cave the camera stays inside the tunnel: slide it in toward the bird until it's clear of the rock
  if (getCourse() && solidClearance(want.x, want.y, want.z) < 1.5) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 6; i++) {
      const m = (lo + hi) / 2;
      tmp.copy(g.pos).lerp(want, m);
      if (solidClearance(tmp.x, tmp.y, tmp.z) >= 1.5) lo = m; else hi = m;
    }
    want.lerp(g.pos, 1 - lo);
  }
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
        if (!roomTab()) settings.mode = 'online';
        if (mode !== 'title') goToMenu(); else renderMenu();
        break;
      case 'feed': feed.push({ text: ev.text, t }); if (feed.length > 5) feed.shift(); break;
      case 'scored': { const pts = Math.round(600 * multiplier()); score += pts; combo++; comboTimer = 4; audio.thud(); audio.whoosh(0.8); rumble(0.6, 200); break; }
      case 'hitConfirmed': audio.beep(1700, 0.03, 0.05); break;
      case 'chat': chatLine(online.nameOf(ev.from), PLAYER_CSS[colorIndex(ev.from)], ev.line); break;
      case 'end': showOnlineResult(ev.result); break;
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
  online.checkWin(); // (host only: someone reached the winning score)

  if (inp.anyPress) audio.start();
  // quick chat (any time you're in the air or waiting to respawn)
  const sec = now / 1000;
  if (mode !== 'title') {
    if (inp.chatToggle) quick.toggle(sec);
    if (inp.chat) {
      const line = quick.press(inp.chat, sec);
      if (line >= 0) say(line);
      else if (line === -2) chatNote('Easy on the chat! Muted for a few seconds.');
    }
  }
  quick.update(sec, mode !== 'title', isTouch && mode === 'flying');
  if (inp.view && mode !== 'title') { settings.view = settings.view === 'cockpit' ? 'chase' : 'cockpit'; saveSettings(); }
  const nav = inp.nav;
  if (pause && !online.active) closePause();
  if (pause) {
    // the room menu has the buttons; the online respawn still counts down underneath
    if (nav.x || nav.y) { pauseSel = THREE.MathUtils.clamp(pauseSel + (nav.x || nav.y), 0, 1); renderPause(); }
    if (nav.menu) closePause();
    else if (nav.back) pauseBack();
    else if (nav.ok) pauseAct(pauseSel);
    if (mode === 'crashed' && online.phase === 'playing' && !downcam.playing && crashTimer > respawnAt) respawnOnline();
  } else if (importer) {
    if (nav.back || nav.menu) closeImporter();
  } else if (mode === 'title') {
    const rows = menuRows() as readonly string[];
    if (nav.y) {
      let i = rows.indexOf(MENU_ROWS[menuRow]);
      i = THREE.MathUtils.clamp(i + nav.y, 0, rows.length - 1);
      menuRow = MENU_ROWS.indexOf(rows[i] as typeof MENU_ROWS[number]);
      renderMenu();
    }
    if (nav.x && MENU_ROWS[menuRow] !== 'go' && rows.includes(MENU_ROWS[menuRow])) menuChange(MENU_ROWS[menuRow], nav.x);
    if (nav.ok && MENU_ROWS[menuRow] === 'help' && rows.includes('help')) menuChange('help', 1); // A / Enter opens the controls list
    else if (roomTab()) {
      const row = MENU_ROWS[menuRow];
      if (nav.ok && rows.includes(row) && ['host', 'join', 'go'].includes(row)) onlineAction(row);
      if (nav.ok && row === 'rooms' && openRooms[roomSel] && openRooms[roomSel].players < openRooms[roomSel].max) { settings.code = openRooms[roomSel].code; onlineAction('join'); }
      if (nav.back && online.active) { if (lobbyLeaveNeedsConfirm()) openPause('confirm', true); else onlineAction('leave'); }
    } else if (settings.mode === 'race' && nav.ok && MENU_ROWS[menuRow] === 'import' && !startReq) {
      pickMapFiles();
    } else if (settings.mode === 'race' && mapPending() && (startReq || nav.ok)) {
      startReq = false; // still building your map
    } else if (settings.mode === 'race' && nav.ok && MENU_ROWS[menuRow] === 'board' && !startReq) {
      const it = boardItems()[boardSel];
      if (it) toggleGhost(it.pid);
    } else if (startReq || (nav.ok && !inp.nav.back)) {
      clearTimeout(previewTimer);
      spawn(false); // keeps the world the title was showing
      mode = 'flying'; hud.overlay.classList.add('hidden');
      if (racing()) loadRaceRefs();
    }
  } else if (racing()) {
    // time trial: Esc / Start / B goes back to the menu; the left stick click (or Backspace) restarts at once;
    // a crash restarts by itself a moment later, and after the finish any button races again
    if (menuReq || nav.menu || (nav.back && mode !== 'flying')) goToMenu();
    else if (inp.restart) restartRace();
    else if (mode === 'crashed' && (crashTimer > 1.2 || (inp.anyPress && crashTimer > 0.3))) restartRace();
    else if (mode === 'finished' && finishT > 1 && (inp.anyPress || startReq)) restartRace();
  } else if (mode === 'crashed' && online.phase === 'playing' && (nav.back || nav.menu)) openPause();
  else if (mode === 'crashed' && (menuReq || nav.back || nav.menu)) goToMenu();
  else if (mode === 'crashed' && downcam.playing) { if (inp.anyPress && downcam.elapsed > 0.35) endDownCam(); }
  else if (mode === 'crashed' && online.phase === 'playing') {
    if (crashTimer > respawnAt) respawnOnline();
    else if (!liveRace()) { const el = document.getElementById('respawnIn'); if (el) el.textContent = `Back in the air in ${Math.ceil(respawnAt - crashTimer)}…`; }
  }
  else if (mode === 'crashed' && inp.anyPress && crashTimer > 0.8 && crashTimer > downcamEndT + 0.4) { spawn(); mode = 'flying'; hud.overlay.classList.add('hidden'); }
  else if (mode === 'over') {
    const overT = (performance.now() - overAt) / 1000;
    // solo: fly again, or back to the menu. Online: back to the room's lobby (the room stays open).
    if (online.active) { if ((inp.anyPress || menuReq) && overT > 1.2) goToMenu(); }
    else if (menuReq || nav.back || nav.menu) goToMenu();
    else if (inp.anyPress && overT > 1.2) { spawn(); mode = 'flying'; hud.overlay.classList.add('hidden'); }
  }
  else if (mode === 'finished' && online.phase === 'playing' && (nav.menu || nav.back)) openPause();
  else if (mode === 'flying' && online.phase === 'playing' && nav.menu) openPause();
  else if (mode === 'flying' && (nav.menu || menuReq)) goToMenu();
  startReq = false; menuReq = false;
  const inArena = !!getArena();

  if (slowmo > 0) { slowmo -= dt; dt *= 0.35; }
  t += dt;
  if (liveRace()) updateLive(dt); else countdownEl.style.display = 'none';
  /** Live race: held on the grid for the countdown. */
  const held = liveRace() && liveHold > 0;

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
    const finished = held ? null : glider.step(dt, inp);
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
    if (!racing()) for (const ev of dogfight.update(dt, t, glider, inp.fire && !held, inp.dart && myDartsOn() && !held, !held, wasInCloud)) onDogfight(ev);
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
    const ground = floorBelow(p.x, p.y, p.z); // (cave-aware on a time trial course)
    clearance = p.y - ground;
    if (getCourse() ? solidClearance(p.x, p.y, p.z) < 0.45 || solidCrossed(prevPos, p) : clearance < 0.45) { if (clearance < 0.45) p.y = ground + 0.45; crash(); }
    if (racing() && mode === 'flying') stepRace(dt);
    else if (liveRace() && mode === 'flying' && !held) stepLive(dt);
    const crunch = isSpace() ? 'Kaboom!' : 'Crunch!';

    // obstacles: collision + close calls
    obstaclesNear(p.x, p.z, 14, nearby);
    if (!inArena) gates.obstacles(nearby);
    const seen = new Set<string>();
    for (const o of nearby) {
      const gap = obstacleGap(o, p.x, p.y, p.z) - 0.5; // bird radius
      if (gap < 0 && mode === 'flying' && !o.soft) { crash(crunch, 'crash', true); break; }
      if (gap < CLOSE_CALL + 2.5) {
        seen.add(o.id);
        const prev = near.get(o.id);
        near.set(o.id, { gap: prev === undefined ? gap : Math.min(prev.gap, gap), type: o.type === 'box' ? 'hull' : o.type });
      }
    }
    if (mode === 'flying') for (const [id, nr] of near) {
      if (!seen.has(id)) {
        near.delete(id);
        if (nr.gap < CLOSE_CALL) addCloseCall(nr.gap, nr.type);
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
    if (!inArena && !getCourse()) gates.check(prevPos, p, (e: GateEvent) => onGate(e));

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
  } else if (mode === 'finished') {
    // over the line: the bird glides on by itself while the result shows
    finishT += dt;
    prevPos.copy(glider.pos);
    glider.step(dt, { ...inp, pitch: 0, roll: 0, yaw: 0, brake: 0.3, trick: null } as typeof inp);
    if (solidClearance(glider.pos.x, glider.pos.y, glider.pos.z) < 3) glider.pos.y = floorBelow(glider.pos.x, glider.pos.y, glider.pos.z) + 3;
    if (online.phase === 'playing') {
      // live race: the others are still racing round you (over the line, nothing can hit you)
      online.preUpdate();
      dogfight.update(dt, t, glider, false, false, false);
      online.hp = hp; online.postUpdate(dt, glider, bird.quaternion, false);
    }
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
    let far = FOG_FAR[nb.parent] + (FOG_FAR[nb.biome] - FOG_FAR[nb.parent]) * nb.t;
    // deep in a cave the air goes dark and close
    const cave = caveShade(camera.position.x, camera.position.y, camera.position.z);
    caveNow += (cave - caveNow) * Math.min(1, dt * 3);
    if (caveNow > 0.01) { (scene.fog as THREE.Fog).color.lerp(CAVE_FOG, caveNow * 0.85); far = THREE.MathUtils.lerp(far, 260, caveNow); }
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
  const gy = floorBelow(gp.x, gp.y, gp.z);
  const h = gp.y - gy;
  shadow.visible = !isSpace();
  shadow.position.set(gp.x, gy + 0.35, gp.z);
  shadow.scale.setScalar(1.3 + h * 0.03);
  (shadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(0.5 - h * 0.012, 0, 0.5);

  // stream terrain ahead of the bird
  world.update(gp.x + glider.dir.x * 180, gp.z + glider.dir.z * 180, 2);
  if (!inArena && !getCourse()) gates.update(gp.z, t);

  placeCamera(false, dt, mode === 'crashed' ? Math.min(10, crashTimer * 8) : 0);
  hitboxes.show(mode !== 'title');
  if (hitboxes.on && mode !== 'title') {
    const extra: Obstacle[] = [];
    if (!inArena && !racing()) gates.obstacles(extra);
    hitboxes.update(dt, { pos: glider.pos, dir: glider.dir, others: dogfight.enemies, extra, firstPerson: firstPerson(), crashed: mode !== 'flying', camera });
  }
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
  drawDogfightHud(mode === 'flying' && !racing());
  if (isTouch) {
    const d = mode === 'flying' ? 'flex' : 'none', r = racing();
    $('fire').style.display = r ? 'none' : d; $('dartBtn').style.display = myDartsOn() && !r ? d : 'none'; $('viewBtn').style.display = d; $('chatBtn').style.display = r ? 'none' : d;
    $('restartBtn').style.display = r && mode !== 'title' ? 'flex' : 'none';
  }
  drawRaceHud(realDt);
  drawChat();
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
  hud.score.textContent = mode === 'title' || replaying || racing() || liveRace() || (mode === 'over' && online.active) ? '' : String(Math.floor(score));
  hud.combo.style.opacity = combo > 0 && mode === 'flying' && !racing() ? '1' : '0';
  hud.combo.textContent = `combo x${multiplier().toFixed(1)}`;
  hud.stats.textContent = mode === 'flying'
    ? isSpace() ? `${Math.round(glider.speed * 3.6)} km/h · ${getArena()!.name}`
    : `${Math.round(glider.speed * 3.6)} km/h · ${Math.max(0, Math.round(clearance))} m up · ${inArena ? getArena()!.name : `${Math.round(startZ - gp.z)} m`}`
    : '';
  waveClearedT -= dt;
  const alive = dogfight.enemies.filter((e) => e.alive && e.remote !== 'human').length;
  const rules = online.phase === 'playing' ? online.rules : null;
  hud.wave.textContent = rules?.race ? '' // (the race HUD has the top right corner)
    : rules && mode !== 'title'
    ? rules.bots === 0 ? (rules.allies ? teamBanner() : 'FREE FOR ALL') : dogfight.wave === 0 ? 'GET READY' : waveClearedT > 0 || alive === 0 ? `WAVE ${dogfight.wave} CLEARED` : `WAVE ${dogfight.wave} · ${alive} LEFT`
    : inArena && mode === 'flying'
    ? (dogfight.wave === 0 ? 'GET READY' : waveClearedT > 0 || alive === 0 ? `WAVE ${dogfight.wave} CLEARED` : `WAVE ${dogfight.wave}${dogfight.escalate ? ` · ${waveTier(dogfight.wave).toUpperCase()}` : ''} · ${alive} LEFT`)
      + (settings.mode === 'arena' && winTarget() > 0 ? ` · ${dogfight.kills}/${winTarget()} DOWN` : '')
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
(window as any).__glide = { settings, input, glider, dogfight, world, gates, spaceScene, fleet, obstacleGap, boostPickups, isSpace, camera, get mode() { return mode; }, get score() { return score; }, get run() { return run; }, canyonAt, terrainHeight, route, riverAt };

// ?debug exposes the game objects to the console (used for the two-browser online tests)
if (new URLSearchParams(location.search).has('debug')) {
  (window as any).glide = { online, dogfight, glider, camera, hitboxes, course: getCourse, get hp() { return hp; }, get shield() { return spawnShield; }, get t() { return t; }, get mode() { return mode; }, get score() { return score; }, get pause() { return pause; }, crash: (how: 'pea' | 'dart' | 'crash' = 'pea') => crash('Shot down!', how), obstaclesNear, obstacleGap, floorBelow };
}
