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
- The pea shooter is pure manual aim: lead your target yourself.
- Hold an enemy near your nose for 1 s to **lock on**, then fire a **homing dart** (R or right-click, Y on the controller, DART on touch). Darts chase the locked bird hard and kill in one hit, but enemies see them coming, break hard across their path and barrel-roll to shake them off. You carry 2 and earn one back every 10 s (pips under the feathers).
- You have three feathers (hearts). One grows back after 20 s without being hit.
- Touch: hold the FIRE button.


## Arena mode
Pick **Arena** on the title screen (←→ / d-pad / tap) to fight in a walled-in basin instead of the endless mountain.
- **Speed:** birds flap to hold a cruise speed (~120 km/h) in level flight, so you don't need a downhill. Climbing still bleeds speed, diving still builds it past cruise, the air-brake still slows you, and the flapping fades out high up (no climbing forever). Enemies fly on exactly the same rules.
- **Enemies:** choose 1 to 12 per wave. Clear a wave for a bonus, a feather back and full darts; the next wave arrives a few seconds later. Enemies steer round trees, pillars and arches but can misjudge it and crash (it's your kill if you chased them into it).
- **Environments:** Green Basin (hills, woods, puffy clouds), Pillar Desert (rock towers and arches), Ice Peaks (jagged peaks to hide behind), Cloud Forest (dense woods under low cloud), Autumn Canyons (a plateau cut by slot canyons), or Random. Rock arches in every arena: fly under them.
- The mountains wall the arena in; fly past the edge and the wind turns you back.
- Esc (or Start on a controller) returns to the menu; on the crash screen, Esc / B / the Menu button does too.
