# Glide!

A third-person low-poly gliding game: an endless, procedurally generated downhill mountainside to skim, thread and punch through clouds.

- `npm install`
- `npm run dev` then open the printed URL (use the Network URL on your iPhone, same Wi-Fi)
- `npm run build` makes a single self-contained `dist/index.html`

Controls (the bird is fully 3D: roll over and pull to carve a hard turn, keep pulling to loop, fly upside down):
- Controller: left stick roll/pitch · right stick yaw (x), tuck (down), flare (up) · RT tuck · LT flare · A flap · LB/RB snap roll
- Keyboard: W/S dive/pull up · A/D bank (holds up to ~80°) · ←/→ yaw · Shift or ↑ tuck · ↓ flare · Space flap · Q/E snap roll
- Touch: left thumb roll/pitch · right thumb drag down tuck, up flare, sideways yaw · tap right to flap · swipe right side ←/→ to snap roll

Tuck folds the wings: you dive fast and your wingspan shrinks, so you fit through tighter gaps. Wingtips collide, so a knife-edge (90° bank) slips between things too. Flaps are limited (3, slowly recharging; rings give one back). Close calls on a knife-edge, inverted or tucked score double; loops, outside loops, aileron rolls and snap rolls all score, triple when low.

The route forks every ~1.5 km into 2-3 valleys separated by ridges. Each valley is its own environment (green meadows, autumn forest, red desert with mesas and pillar fields, snowy peaks with ice spires, misty valley full of low clouds); the one you're in when you pass the decision point becomes the run and sets what comes next. Every new run gets a new route.

What's on the mountain: stepped slopes ending in cliff drops, rivers to skim (with waterfalls over the cliffs), gorges that open into wide plains, canyon valleys with rock bridges (stay below the rim for a Canyon Run bonus), clouds you punch through, speed rings, wind tunnels (rings joined by a tube that pushes you along), thread-the-needle spire pairs and rock arches. Tricks score triple when pulled off under 10 m.

Code map: `src/route.ts` forks and environments · `src/world.ts` terrain, canyons, biomes, obstacles, clouds, chunk streaming · `src/gates.ts` rings, wind tunnels, needles, arches · `src/bird.ts` bird mesh and glide physics · `src/input.ts` keyboard/touch/gamepad · `src/main.ts` game loop, camera, scoring, HUD · `src/puffs.ts` cloud-punch particles · `src/audio.ts` procedural wind.
