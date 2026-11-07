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
- **Dart switches** (both modes): turn your homing darts and the enemies' darts on or off separately before a match.
- Esc (or Start on a controller) returns to the menu; on the crash screen, Esc / B / the Menu button does too.


## Online arena (multiplayer)
Pick **Online** on the title screen to fight in the arena with friends on other networks (different houses, Wi-Fi or phone data).
- One player presses **Host a room** and gets a 5-letter room code plus a **Copy invite link** button. Everyone else types the code and presses **Join** (or just opens the invite link). Up to 8 players.
- The host picks the arena, how many **AI birds** come in each wave (0 = players only), whether players are **free for all** or **team up** against the AI birds, and the dart switches, then presses **Start match**. Players can also join a match that's already going.
- Everyone flies by the same rules. AI birds chase whichever player is closest. Go down and you're back in the air at the rim 3 seconds later; the scoreboard (top right) counts kills and times downed, and a kill feed runs down the left. Esc leaves the room.
- How it works: WebRTC peer to peer (PeerJS). The host's browser runs the AI birds and relays everyone's updates; each player flies their own bird locally (no input lag) and sends its position 20 times a second, and everyone draws the others a tenth of a second in the past so they move smoothly. A pea that hits you is judged on your machine; hits on AI birds are confirmed by the host; a dart fired at you flies on your machine, so you shake it the same way as an AI bird's dart.
- **Open rooms (Cloudflare build):** the Online screen lists every public room with its host, player count and whether a match is on; tap one to join. Hosts choose **Room: Public** (listed) or **Private** (code or invite link only), before hosting or any time in the lobby.
- **Hosting on Cloudflare (recommended):** `npm run deploy` puts the game and a small room server on one Cloudflare Worker. Players then connect over a WebSocket to a Durable Object per room instead of WebRTC, which works on every network. Free plan is plenty for friends; see [CLOUDFLARE.md](CLOUDFLARE.md) for setup and costs. Server code: `server/worker.ts`.
- Servers (plain `npm run build`): the free public PeerJS server introduces players to each other (nothing else goes through it), and PeerJS's free STUN/TURN relays get through strict home and mobile NATs. No accounts needed. For your own servers: `?signal=host:port` (run `npx peer --port 9000`) and `?turn=turn:host:3478&tu=user&tp=pass`.
- `?debug` exposes the game objects as `window.glide` for testing.

## Lead marker (option, every mode)
Turn **Lead marker** on or off on the title screen (online: in the room menu or lobby). Each bird within ~260 m gets a small ring showing where to point your nose so a pea meets it: it allows for the bird's motion and your own (your peas carry your speed). A white gun cross shows where your peas are going; put the cross on the ring and fire. A faded ring means the bird is still out of pea range.

## Down cam (option, every mode)
When you're shot down, your bird falls out of the sky trailing smoke (like the AI birds) and the last 4 seconds, plus 3 seconds after the hit, replay from the chase camera of whoever got you: another player online, or the AI bird whose pea or dart hit you (found by tracing the shot back to the bird that fired it). The moment of the hit plays in slow motion, then the usual "downed" screen appears; press any key or tap to skip. Online, respawn waits for the replay to finish. Being chased into the ground by a bird that hit you in the last few seconds also counts. The title screen / lobby has a **Down cam** row: *When shot down* (default), *Every crash* (plain crashes replay from beside your own bird) or *Off*. It only records what's on screen, so the game keeps running underneath while it plays.

## Space mode
Pick **Space** on the title screen to fly a space fighter through an asteroid belt in low orbit over a wild planet. It plays like the arena (waves of 1 to 12 enemy fighters, the same missile switches, lead marker and down cam), and the online lobby's arena picker has **Asteroid Belt (space)** too.
- **No air, no stall:** you cruise at a steady ~200 km/h. **Boost** to change pace (it runs on a fuel gauge, bottom left, that refills on its own and when you cut close past rocks or thread a ring), or **brake** to slow right down and turn much tighter. Every fighter, yours and the enemies', uses the same numbers (`src/space.ts`); enemies are only smarter about when to brake into a turn and when to burn their boost.
- **Lasers** replace the pea shooter (faster, longer reach) and **missiles** replace the darts (fast enough to run down a boosting fighter). Shots stop on rocks, so you can hide behind one, and a missile can be led into a rock to shake it.
- **The belt:** thousands of tumbling rocks in clumps and clearings, giant asteroids, ring-shaped rocks and fat rocks with a tunnel bored through them. Fly through a ring or a tunnel for bonus points and boost. Dive too low and you hit the planet.
- Controls: keyboard Shift boost, Space brake, Z/C yaw (rest as normal). Controller: A or either bumper boosts, LT brakes, and the right stick is a throttle too (up boost, down brake). Touch: the right thumb drags up to boost, down to brake.

## First-person view (option, every mode)
**Camera: First person** on the title screen, or press **T** (R3 on a controller, VIEW on touch) any time in flight. In space you sit in the cockpit behind a canopy frame with a gun pipper; as a bird you see just the tip of your beak. Crashes switch back to the chase camera so you can watch.
