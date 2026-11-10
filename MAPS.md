# Your own maps

Race mode can load maps you make yourself. Open **Race**, go to **Your maps** and press **Import…**. On a computer you can also drop the files anywhere on the title screen. Imported maps are kept in your browser on this device, and your best times and ghosts on them are kept on this device too.

There are three kinds of map you can import.

## 1. A heightmap

This is a greyscale image where black is low and white is high. Any terrain tool can export one, for example Gaea, World Machine, World Creator, Blender, the Unity or Unreal terrain tools, or a real-world elevation exporter.

| Format | Notes |
| --- | --- |
| PNG, 16-bit greyscale | Best. Gives smooth slopes. |
| PNG / JPG / WebP, 8-bit | Works, and is lightly smoothed. Only 256 steps, so the slopes can look stepped. |
| RAW / R16 | Square, 16-bit little-endian (the Unity / Unreal / World Machine export). |

When you import one you set:

* **Width**: how many metres across the image is. The depth follows the image's shape. A two minute run is about 5 km.
* **Lowest / highest point**: the heights in metres of black and of white.
* **Look**: meadow, autumn, desert, alpine (snow on the peaks) or misty. This sets the grass, rock, trees and clouds.

You can import a second image named `*color*`, `*albedo*`, `*satellite*` or `*texture*` alongside the heightmap. It paints the ground.

The top of the image is north, which is the way the game's mountain runs downhill (-z). If you don't place a start and finish, the race runs from the highest ground to the lowest. Trees, boulders and clouds grow on their own, the way they do on the built-in courses. Walls rise around the edge, so nobody can fly off the map.

## 2. A 3D model (glTF / GLB / OBJ)

The model itself is the ground, so tunnels, arches, bridges and overhangs all work and all have collision. This is the way in for anything built in Blender or in a track builder that can export glTF, GLB or OBJ.

* **Units**: 1 unit is 1 metre (Blender's default). Use **Scale** on import if your model uses other units. The bird needs a lot of space: it flies at 120 to 200 km/h and needs about 100 m to turn.
* **Up** is +Y (the glTF default; Blender's exporter handles this). Use **Turn** on import to point the run the way you want.
* **Colours**: materials and textures are kept and drawn flat-shaded. Parts left plain white or grey are painted like the game's ground: grass on the flats, rock on the steep faces, snow up high on alpine.
* **Compression**: Draco- and meshopt-compressed files aren't supported. Export with compression off.
* **Size**: up to 400,000 triangles, 40 MB a file and 16 km a side. Decimate big scans first.
* **OBJ**: pick the `.mtl` too (and any textures) if you want the colours.
* **glTF with separate files**: pick the `.gltf`, its `.bin` and its textures together.

**Close calls on your own trees and rocks**: meshes or groups named like trees or rocks (tree, pine, fir, oak, palm, bush, rock, boulder, stone, pillar, cactus…) give the same close-call speed kick as the game's own. Your model still draws them and handles the collision.

### Markers

Add **empties** (or tiny meshes, which is the only option in OBJ) with these names. Blender's `.001` suffixes are fine.

| Name | What it does |
| --- | --- |
| `START` | The start line. The clock starts when you cross it. |
| `SPLIT1`, `SPLIT2`, … (or `CHECKPOINT1`, `CP1`, …) | Split lines, in number order. You have to pass each one. |
| `FINISH` (or `GOAL`) | The finish line. |
| `SPAWN` | Where the bird appears, facing along the empty's +Y axis in Blender (-Z in glTF). If you leave it out, the bird appears 70 m before the start line. |
| `TREE`, `ROCK` / `BOULDER`, `PILLAR` / `SPIRE` | A game tree, boulder or rock pillar, with collision. |

A line faces from one marker to the next. An empty's **scale** sets the line's size: X is the half-width in metres and Y the half-height. At scale 1 you get a line 80 m wide and 60 m tall. For trees and rocks, X sets the radius and Y the height.

You can also set a node's glTF custom property `glide` to one of the names above, instead of naming the node.

Without START and FINISH markers, the race runs from the model's highest ground to its lowest.

## 3. A Glide map (.json)

This spells everything out. Pick the `.json` together with the heightmap or model it names.

```json
{
  "glide": 1,
  "name": "Ridge Run",
  "blurb": "Down the ridge and through the bore",
  "biome": "alpine",
  "terrain": { "heightmap": "ridge.png", "size": 3000, "height": [0, 700], "colormap": "ridge-color.png" },
  "spawn": [0, 640, 2400],
  "gates": [
    [0, 600, 2300, 120, 80],
    [0, 380, 0, 140, 90],
    [0, 150, -2600, 160, 100]
  ],
  "sections": ["Top", "Bottom"],
  "tunnels": [
    { "pts": [[0, 900, 300, 22, 20], [0, 300, 230, 22, 20], [0, -300, 180, 22, 20]] }
  ],
  "objects": [
    { "type": "spire", "x": 40, "z": 1500, "h": 80, "r": 8 },
    { "type": "tree", "x": -30, "z": 1400 },
    { "type": "rock", "x": 0, "z": 1200, "r": 10 }
  ],
  "look": { "trees": 0.8, "rocks": 0.6, "clouds": 0.4, "lowClouds": false, "spires": 0.05, "tall": 1.1 }
}
```

* **terrain**: either `{ "heightmap", "size", "height", "colormap"? }` or `{ "model": "track.glb", "scale"?, "rotate"? }`. `size` is metres across, or `[width, depth]`. `height` is `[lowest, highest]` in metres.
* **Coordinates**: in metres. A heightmap is centred on 0, 0, and -z is the top of the image. A model uses its own coordinates (times `scale`).
* **gates**: the start line, then the splits, then the finish. Each one is `[x, y, z, halfWidth, halfHeight, heading?]` or `{ "x", "y", "z", "w", "h", "heading" }`. `heading` is in degrees, where 0 means flying towards -z. Without it, each line faces the next one.
* **sections**: names for the stretches between lines (one more than the number of splits).
* **tunnels** (heightmaps only): bored through the ground like the built-in caves, with collision and glow crystals. Each control point is `[x, z, floorY, halfWidth, height]`. Run the ends out into open air, where they become the tunnel mouths.
* **objects**: trees, boulders (`r`) and rock pillars (`h`, `r`). Add `y` to put one on the floor of a tunnel under that height.
* **look**: how thick the self-growing trees, rocks, pillars and clouds are (1 = normal, 0 = none).

## A course file for a model (`glide-course`)

If a tool gives you the start, checkpoints and finish as a separate file, pick it together with the model (`.glb`):

```json
{
  "format": "glide-course", "version": 1, "units": "metres", "up": "Y", "origin": "map centre",
  "worldSize": 1536, "maxHeight": 320,
  "start":       { "position": [-19.9, 311.4, -764.4], "forward": [-0.61, -0.37, 0.70], "radius": 10 },
  "checkpoints": [ { "position": [-130.9, 244.3, -637.3], "forward": [-0.85, -0.18, 0.50], "radius": 10 } ],
  "finish":      { "position": [-62.1, 36.4, 711.9], "forward": [-0.84, 0.05, 0.54], "radius": 10 }
}
```

Each ring is drawn as a glowing hoop and counts anywhere within 1.5 × its `radius` (at least 15 m), facing along its `forward`. The checkpoints are the splits, in order. The bird starts 45 m back along the start's forward line, already flying through it. If the model is clearly in other units (its wider side is far from `worldSize`), it's scaled to fit. If it was built from a corner rather than its centre, it's moved to match the course.

## Limits

40 MB a file, 80 MB a map, heightmaps up to 2049 samples a side (larger ones are shrunk), 400,000 triangles, 16 km a side, 5,000 objects, 40 timing lines, and 30 maps on a device.

## Coming later

Sharing maps with a code and global leaderboards on shared maps (phase 2). After that, an in-game editor.
