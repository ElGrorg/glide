# Glide!

A third-person low-poly gliding game: an endless, procedurally generated downhill mountainside to skim, thread and punch through clouds.

- `npm install`
- `npm run dev` then open the printed URL (use the Network URL on your iPhone, same Wi-Fi)
- `npm run build` makes a single self-contained `dist/index.html`

Controls:
- Keyboard: W/S or arrows dive/pull up, A/D bank, Space air-brake, Q/E barrel roll, F loop
- Touch: drag the left side to steer, hold the right side to brake, swipe the right side left/right to barrel roll or up to loop
- Controller: left stick, triggers or A to brake, LB/RB barrel roll, Y loop

What's on the mountain: canyon sections (stay below the rim for a Canyon Run bonus), speed rings, wind tunnels (rings joined by a tube that pushes you along), thread-the-needle spire pairs and rock arches. Tricks score triple when pulled off under 10 m.

Code map: `src/world.ts` terrain, canyons, obstacles, clouds, chunk streaming · `src/gates.ts` rings, wind tunnels, needles, arches · `src/bird.ts` bird mesh and glide physics · `src/input.ts` keyboard/touch/gamepad · `src/main.ts` game loop, camera, scoring, HUD · `src/audio.ts` procedural wind.
