# Glide!

A third-person low-poly gliding game: an endless, procedurally generated downhill mountainside to skim, thread and punch through clouds.

- `npm install`
- `npm run dev` then open the printed URL (use the Network URL on your iPhone, same Wi-Fi)
- `npm run build` makes a single self-contained `dist/index.html`

Controls: W/S or arrows dive/pull up, A/D bank, Space air-brake. Touch: drag left side to steer, hold right side to brake. Controller: left stick + triggers.

Code map: `src/world.ts` terrain, obstacles, clouds, chunk streaming · `src/bird.ts` bird mesh and glide physics · `src/input.ts` keyboard/touch/gamepad · `src/main.ts` game loop, camera, scoring, HUD · `src/audio.ts` procedural wind.
