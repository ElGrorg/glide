# Glide!

A third-person low-poly gliding game: an endless, procedurally generated downhill mountainside to skim, thread and punch through clouds.

- `npm install`
- `npm run dev` then open the printed URL (use the Network URL on your iPhone, same Wi-Fi)
- `npm run build` makes a single self-contained `dist/index.html`

Controls:
- Keyboard: W/S or arrows dive/pull up, A/D bank, Space air-brake, Q/E barrel roll, hold Q+E to tuck-dive, F (or left click) to shoot, hold S (pull up) to loop
- Touch: drag the left side to steer, hold the right side to brake, swipe the right side left/right to barrel roll, keep pulling down to loop
- Controller, classic (default): left stick steers, RT or X shoots, LT/A brake, LB/RB barrel roll (roll the way you're banking for a big dodge), hold LB+RB to tuck-dive (wings fold, fast steep dive, wider turns, close calls score x2)
- Controller, wing sticks (press Back to switch): left stick up/down = left wing, right stick up/down = right wing. Both up = dive, both down = climb, one up + one down = sharp turn
- Barrel roll while banking the same way = a big sideways dodge

The route forks every ~1.5 km into 2-3 valleys separated by ridges. Each valley is its own environment (green meadows, autumn forest, red desert with mesas and pillar fields, snowy peaks with ice spires, misty valley full of low clouds); the one you're in when you pass the decision point becomes the run and sets what comes next. Every new run gets a new route.

What's on the mountain: stepped slopes ending in cliff drops, rivers to skim (with waterfalls over the cliffs), gorges that open into wide plains, canyon valleys with rock bridges (stay below the rim for a Canyon Run bonus), clouds you punch through, speed rings, wind tunnels (rings joined by a tube that pushes you along), thread-the-needle spire pairs and rock arches. Tricks score triple when pulled off under 10 m.

Code map: `src/route.ts` forks and environments · `src/world.ts` terrain, canyons, biomes, obstacles, clouds, chunk streaming · `src/gates.ts` rings, wind tunnels, needles, arches · `src/bird.ts` bird mesh and glide physics · `src/input.ts` keyboard/touch/gamepad · `src/main.ts` game loop, camera, scoring, HUD · `src/puffs.ts` cloud-punch particles · `src/audio.ts` procedural wind.

## Dogfights
Enemy birds join the run every 7 to 13 seconds (one at a time, two once you have a couple of kills).
- **Hunters** (dark grey) spawn behind you and fire bursts from your tail. The radar (bottom right) glows red and a warning flashes when one is on you. Hunters react to your moves about half a second late and turn wider than you. A dodge roll (roll while banking) or a hard break makes them lose sight of you ("Shook it!"), and slamming the brakes when one is close makes it overshoot.
- **Bandits** (blue) spawn ahead and flee. Once they see you lining up they jink, fake, barrel-roll and dive.
- Hold an enemy near your nose for a moment to **lock on**: your peas are then aimed ahead of it and curve slightly toward it.
- You have three feathers (hearts). One grows back after 20 s without being hit.
- Touch: hold the FIRE button.

