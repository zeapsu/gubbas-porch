# Gubba's Porch — Design

A 3D 8-bit Zen garden for the browser. You rake real 3D sand, place a few stones, breathe, and listen. Gubba, a large and faintly ridiculous slug-toad, keeps the garden and mostly keeps quiet.

**Status:** agreed — ready for autonomous implementation. Section 12 records the agreed decisions (notably: all three Gubba variants A/B/C are built and swappable live in the Settings tab, and moods switch either automatically by time of day or manually in Settings).

**What "3D 8-bit" means here:** the garden is a real 3D scene (Three.js, low-poly models built in Blender), drawn into a low-resolution framebuffer and resolved to a fixed 32-colour palette with stepped cel shading, a Bayer 4×4 dither, hard shadows, and 1-pixel outlines, then scaled up with nearest-neighbour filtering. Think *A Short Hike*, smaller and quieter.

**Mockups:** two self-contained pages show this design running. Open them in a browser; they need no server and load nothing external.

- [`docs/mockups/garden-layout.html`](docs/mockups/garden-layout.html): the full 3D scene with a rakeable sand bed, the Wall of Rakes (click a rake to take it off its pegs), Gubba on the porch, four moods with their own light direction, three camera presets with free orbit, the Crisp and Chunky pixel densities, the breath thread, and the smoothing sweep.
- [`docs/mockups/gubba-concepts.html`](docs/mockups/gubba-concepts.html): the three Gubba concepts as turnable 3D models with front, side, and back silhouettes and palette swatches.

Because the mockups may not load libraries, they run a small software renderer written for the purpose. It implements the same pipeline specified in section 2 (G-buffer, cel steps on palette ramps, Bayer dither, shadow map, depth outlines, per-pixel sand lighting from the heightmap), so what they show is what the Three.js build should match. Their geometry is built in code as a stand-in for the Blender `.glb` files.

**Evidence behind the numbers:** the stroke-stamping algorithm, the flow remap, and the palettes were run in a throwaway prototype before the first draft: 60 of 60 random fast strokes were gap-free, 30 of 30 strokes were idempotent, and every palette ramp is strictly increasing in luminance. The camera presets, light directions, shading constants, and world layout in this document are the values the 3D mockup runs with. Values marked *tunable* are starting points; everything else is a contract.

---

## 1. Pillars

| Pillar | What it means in practice |
|---|---|
| Nothing to win | No timers, scores, streaks, unlock gates, fail states, or "are you still there" prompts. The only clock on screen is the breath. |
| The sand is the star | The default camera frames the bed first. Everything else is a physical object standing around it, not a panel over it. |
| Real 3D, seen through 8 bits | Real geometry, real light, real shadows, drawn at low resolution in 32 colours with no smooth gradients anywhere. |
| Quiet by default | Gubba speaks at most once every 90 s unless asked. Music has silence built into it. Every sound has a mix slider and one mute key. |
| Deterministic core | The same pointer path over the sand always produces the same grooves. That makes presets, undo, saves, and tests exact. |

**Anti-goals:** tutorials, pop-ups, achievements, daily rewards, accounts, analytics, network calls after load, text over the sand, camera motion the player did not ask for.

---

## 2. Rendering and visual language

### 2.1 The pixel pipeline

Five passes per frame. Passes 1–4 run at the low framebuffer resolution; only pass 5 touches the full-size canvas.

| # | Pass | Target | What it does |
|---|---|---|---|
| 1 | Shadow | 1024² depth, `BasicShadowMap` | One directional light, orthographic, fitted to a sphere of radius 215 around `(24, 10, 0)`. No filtering: shadow edges are hard |
| 2 | Scene | Low-res `WebGLRenderTarget`, two colour attachments plus a depth texture, `NearestFilter`, no MSAA | Every mesh writes a **G-buffer**: ramp id, light term `N·L`, flags (emissive, no-outline, sand), and a part id. No colour is decided here |
| 3 | Resolve | Low-res RGBA8 | A full-screen pass turns the G-buffer into palette colours: cel step, dither, shadow, outline (below) |
| 4 | Overlay | Same target | HUD objects, the speech scroll, and the bitmap font, drawn orthographically so UI pixels are the same size as scene pixels. Skipped in a window where the overlay has larger pixels than the scene (2.7) |
| 5 | Present | Canvas | One nearest-neighbour blit at an integer scale. In a window where the overlay has its own pixel size, the same pass lays it over the blit from the bottom-left corner, each overlay pixel a whole number of device pixels in one of the 32 palette colours |

**Resolve, per pixel.** `n` is the length of the material's ramp, `b` is the Bayer value for the pixel, `amb` is the mood's ambient term.

```
I    = N·L · (1 − amb) + amb                  // wrap lighting, −1…1 in, 0…1 out for lit faces
if shadowed or N·L ≤ 0.04:  I = min(I, 0.55 · amb)
tone = clamp(floor(I · n + (b − 0.5) · 0.22), 0, n − 1)
slot = ramp[tone]                              // one of the 32 palette slots
```

- **Bayer 4×4:** `[0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]`, value `(v + 0.5) / 16`, indexed by `(x & 3) + 4·(y & 3)` in framebuffer pixels. The dither weight 0.22 is deliberately small: it softens band edges without turning surfaces into noise.
- **Shadow bias:** `min(7, 1.5 / max(0.2, N·L))` world units. A fixed bias gave acne on the wall in the mockup; the slope-scaled one does not.
- **Outline:** a pixel becomes `ink` if any of its four neighbours belongs to a different part, is nearer by more than 1.2% in inverse depth, and its part allows outlines. The outline is drawn on the farther pixel, so thin things such as rake handles keep their own colour and gain a dark edge. Ground planes never outline.
- **Palette:** a 32×1 texture per mood, `NearestFilter`. A mood change swaps it through four intermediate textures over 2 s.
- **Emissive and ink parts** use one-slot ramps, so they ignore light: the lantern window, pupils, the grin.

### 2.2 Resolution and pixel density

The framebuffer is not a fixed size. It is the window divided by an integer pixel scale `k`, so every scene pixel is exactly `k × k` device pixels and wide windows simply see more porch.

```
k           = max(1, round(min(devicePixelHeight / targetRows, devicePixelWidth / targetCols)))
framebuffer = floor(deviceWidth / k) × floor(deviceHeight / k)
```

| Density | `targetRows` | `targetCols` | At a 1456×820 device window | Character |
|---|---|---|---|---|
| **Crisp** (default) | 205 | 364 | 364×205, k = 4 | Grooves read clearly from the default camera; tines are countable |
| **Chunky** | 137 | 243 | 242×136, k = 6 | Bolder and more abstract; fine grooves merge into dithered texture at a distance |

The toggle lives in the menu scroll. Both use the same scene, shaders, and palette.

- **Height or width, whichever binds.** `targetCols` is the reference window's width at each density. A landscape window is bound by its height, so 16:9 and wider windows are sized exactly as the reference is. A window narrower than the reference shape (a tablet held upright, a split-screen desktop) is bound by its width instead: the camera has to pull back to fit the garden's width there (2.4), and tying `k` to the height would leave the bed a few dozen very large pixels wide. A 768×1024 window renders 384×512 at k = 2, not 153×204 at k = 5, so the garden keeps the same pixels across it as on a desktop.
- **Round down, never crop.** The canvas is exactly `framebuffer · k` device pixels, which is never more than the window. What is left over, at most `k − 1` device pixels per axis, shows the page's ink background (`#2a1d1a`) as a hairline border. Rounding up instead would push part of the outermost scene pixels off screen. The canvas is centred on a whole device pixel so no row or column is drawn wider than its neighbours.

### 2.3 World layout

One world unit is one sand cell. +x is right, +y is up, +z is toward the default camera. These are the positions the garden mockup uses.

| Object | Position and size | Notes |
|---|---|---|
| Engawa deck | Top at y = 0; x −165…215, z −115…135 | Planks run along x, one board per 9 units |
| Sand bed | 192 × 112, surface at y = 3, centred on the origin | The simulation grid (section 3) |
| Frame | Four beams 6 wide, top at y = 6, around the bed | Bamboo lashings every 32 units |
| Timber wall | Front face at z = −74; x −130…170; 68 high, with a cap beam at y = 70 | Vertical planks every 13 units |
| Rack rails | Upper rail at y = 49.6, lower at y = 16, 232 long, on the wall | Two pegs per rake under the upper rail |
| Rakes on the rack | Heads at y = 54, handles hanging to y ≈ 8, 8.6 units off the wall | One row of ten, section 4.2 |
| Gubba | `(132, 0, 2)`, turned 0.5 rad toward the bed | On the porch to the right of the bed |
| Stone basket | `(116, 0, 44)` | In front of Gubba |
| Shelf and bonsai | Shelf at `(142, 40)` on the wall | Above Gubba's corner |
| Shishi-odoshi | `(−122, 0, −38)` | Back-left of the bed |
| Bamboo | Six stalks 112–132 high at z = −92 | Behind the wall, against the sky |

### 2.4 Camera

A perspective camera with a narrow 26° vertical field of view, which keeps the scene close to isometric while still giving depth. Position is `target + dist · (sin az · cos el, sin el, cos az · cos el)`.

| Preset | Target | Azimuth | Elevation | Distance | Purpose |
|---|---|---|---|---|---|
| **Cozy 3/4** (default) | `(18, 12, −16)` | −0.09 rad | 0.78 rad | 408 | Bed, rack, and Gubba together |
| **Top-Down Raking** | `(0, 3, 2)` | 0 | 1.555 rad | 330 | The bed fills the frame at about 1.7 pixels per cell; best for precise raking |
| **Gubba Porch** | `(126, 19, 6)` | −0.5 rad | 0.32 rad | 150 | A close look at Gubba; raking is still possible on the visible corner of the bed |

`C` steps through the presets; the menu scroll lists them by name.

- **Damping.** Azimuth, elevation, distance, and target each move toward their goal by a factor of 0.12 per 60 Hz frame (a time constant of about 130 ms). There are no cuts and no overshoot. With reduced motion, preset changes are instant.
- **Orbit.** Dragging on anything that is not sand, a rake, Gubba, or the basket orbits: azimuth within ±0.7 rad, elevation within 0.25–1.555 rad. Two-finger drag orbits on touch. The wheel or a pinch scales distance between 0.7× and 1.3× of the distance the preset is framed at in this window (below), so a narrow window that had to pull back is never snapped inward by a wheel tick. The view is re-framed as it orbits, so at 1× zoom the garden never slides off screen.
- **Raking never moves the camera.** A stroke captures the pointer; orbit and zoom are ignored until it ends.
- **Framing.** Each preset names what it must keep on screen, as world-space hulls a little larger than the models:

  | Preset | Kept inside the view | Kept clear of the HUD |
  |---|---|---|
  | Cozy 3/4 | The bed and its frame, all ten rakes on the wall, Gubba (all three variants), the stone basket, the shishi-odoshi, the shelf bonsai | — |
  | Top-Down Raking | The bed and its frame | The sand's front-left corner |
  | Gubba Porch | Gubba (all three variants) | Gubba |

  On every resize, preset change and orbit step the camera is fitted to those hulls with a 6-pixel margin. Azimuth and elevation never change. The distance is the smallest one, not below the preset's, at which everything fits; the target then moves within the screen plane (a pan, never a turn) by the least that fits it, which on a narrow window centres the garden instead of pulling back further for Gubba's side alone. A view that already fits is left exactly as the preset: the 16:9 reference windows (1456×820, 1920×1080, 1366×768, 1280×720, phones on their side) show Cozy and Porch unchanged. "Clear of the HUD" means wholly to the right of the 3×2 HUD block or wholly above it, whichever needs the smaller camera move; the block is measured at the size the overlay draws it in this window (2.7). Cozy has no such rule because its reference view already rests the lotus on the bed's front-left frame corner, and narrower windows only lift the bed further from the HUD.
- **Far plane.** `far` is 4800 and the camera never backs off beyond 4200, so the garden still fits a window five times taller than wide without the deck meeting the far plane.
- **Upright phones.** A window narrower than 600 CSS pixels and more than 1.15 times taller than wide is a phone held upright. The garden is a wide scene, about 300 units of bed, rack and Gubba side by side, so there it would fill under a third of the screen with rakes and HUD objects too small to tap. A page cannot turn the screen itself: orientation lock needs fullscreen and iOS Safari has none. So that window shows a parchment prompt asking the player to turn the screen sideways (or widen the window), in the title card's style with inline pixel art and no external assets. It is a modal dialog: the garden behind it is inert and takes no pointer or key input, it never unlocks audio, and it leaves on its own as soon as the window is wide again. Its one animation, a two-frame nudge of the arrow, stops under `prefers-reduced-motion`. Tablets held upright (768×1024) and narrow desktop windows (640×720) are not phones and play as they are. Decision D8.

### 2.5 Pixel rules

1. Every pixel on screen is one of the current mood's 32 colours. A test reads the canvas back and checks this.
2. No MSAA, no texture filtering on colour, no alpha blending, no bloom, no fog gradients. Transparency is cut-out only.
3. Present at an integer scale only.
4. Models are low-poly and mostly flat-shaded. Rounded things (Gubba, stones) get their roundness from a few visible facets and cel bands, not from smooth gradients.
5. One directional light per mood. Its direction is part of the mood.
6. Animation is real 3D motion, but slow and eased; cel bands and dither do the "8-bit" work, not dropped frames.

### 2.6 Palette, ramps, and light

Models never carry colours. Each material names a **ramp**, a short list of palette slots from dark to light, and the resolve pass picks a slot. So one set of models serves all four moods.

| Slot | Role | Morning Mist | Warm Cedar Afternoon | Sakura Dusk | Moonlit Koi Pond |
|---|---|---|---|---|---|
| 0 | sand0 deep shadow | `#8d8a80` | `#8a7350` | `#7a5a66` | `#2c3558` |
| 1 | sand1 shadow | `#b3b0a2` | `#b39a6b` | `#a8808a` | `#505c86` |
| 2 | sand2 base | `#d6d3c2` | `#d9c492` | `#d4aaa6` | `#6a7aa2` |
| 3 | sand3 light | `#e8e6d8` | `#ecdcae` | `#ecc9b8` | `#8799bb` |
| 4 | sand4 highlight | `#f6f5ec` | `#f7edcb` | `#f9e6d0` | `#c6d6e6` |
| 5 | stone0 | `#454b52` | `#3b3a40` | `#3a3046` | `#161a2e` |
| 6 | stone1 | `#6a7278` | `#5f5d63` | `#5c4f68` | `#2a3150` |
| 7 | stone2 | `#949c9e` | `#8b8a8a` | `#8a7a8e` | `#4a5578` |
| 8 | stone3 | `#c3c9c6` | `#b9b6ac` | `#bba9b4` | `#7886a8` |
| 9 | wood0 | `#40332e` | `#3a2218` | `#33202c` | `#14131f` |
| 10 | wood1 | `#6c5647` | `#6b3f26` | `#5e3540` | `#2a2438` |
| 11 | wood2 | `#96806a` | `#9a6238` | `#8c5252` | `#453a52` |
| 12 | wood3 | `#bfae94` | `#c98f54` | `#bf7f6c` | `#6a5a70` |
| 13 | leaf0 | `#35504a` | `#2f4a2a` | `#2e3f3c` | `#12282e` |
| 14 | leaf1 | `#56796a` | `#4f7436` | `#4a6450` | `#1f4444` |
| 15 | leaf2 | `#83a48a` | `#7fa04a` | `#7a8f62` | `#3a6a5c` |
| 16 | leaf3 | `#b8ceae` | `#b4c96a` | `#b3b77e` | `#6a9a7c` |
| 17 | sky0 | `#aebfc6` | `#6fa3b5` | `#5b4a80` | `#0c1026` |
| 18 | sky1 | `#cfdad9` | `#a9cdbf` | `#b4688e` | `#1a2248` |
| 19 | sky2 | `#eef0e6` | `#e6e2b8` | `#f4a688` | `#34407a` |
| 20 | water0 | `#4a6f80` | `#2f5d74` | `#3f4878` | `#10244c` |
| 21 | water1 | `#7ba3ad` | `#4f8ea0` | `#6c78a8` | `#1f4a80` |
| 22 | water2 | `#d5ebe8` | `#bfe3dc` | `#d6c6e6` | `#8fd0e0` |
| 23 | warm0 | `#b0705a` | `#a8432a` | `#c2456e` | `#c06030` |
| 24 | warm1 | `#e0a184` | `#e2783a` | `#f089a2` | `#f0a040` |
| 25 | warm2 | `#f6dcb8` | `#f8c860` | `#ffd3d6` | `#fff0a0` |
| 26 | gubba0 | `#45604f` | `#3f5a36` | `#44503e` | `#1f3838` |
| 27 | gubba1 | `#6f8f74` | `#6a8a4a` | `#6d7d52` | `#36585a` |
| 28 | gubba2 | `#a3b998` | `#9db46a` | `#a0a874` | `#5a8478` |
| 29 | gubba3 belly | `#ece8d0` | `#e8dcae` | `#f0dcc0` | `#b8ccc0` |
| 30 | ink | `#2c3238` | `#2a1d1a` | `#24182a` | `#080a18` |
| 31 | paper | `#f3f3ea` | `#f4ead0` | `#f8e9dc` | `#dfe8f0` |


Slots 26–29 are shown for Gubba concept A; they change with the chosen concept (section 5.4).

**Ramps** (defined once in `assets/ramps.json`, used by Blender scripts, shaders, and tests):

| Ramp | Slots | Used for |
|---|---|---|
| `sand` | 0 1 2 3 4 | The bed (lit by the sand shader, 3.5), Gubba C's shell |
| `stone` | 5 6 7 8 | Stones, lantern, basin, iron |
| `wood` | 9 10 11 12 | Frame, deck, wall, handles |
| `wood_light` | 11 12 31 | Hinoki, paulownia, the hat |
| `leaf` | 13 14 15 16 | Moss, bonsai, bamboo, jade teeth |
| `water` | 20 21 22 | Basin water, indigo cloth, glass |
| `warm` | 23 23 24 | Cushion, cords |
| `gubba` | 26 27 28 | Gubba's skin |
| `belly` | 28 29 29 | Gubba's underside |
| `cloth` | 8 31 31 | Headband, cup glaze |
| `ink`, `paper`, `glow`, `blush` | 30 · 31 · 25 · 24 | One-slot ramps: pupils and grin, eye whites, lit windows, cheeks |

**Light per mood** (direction from the scene toward the light):

| Mood | Light direction | Ambient | Effect |
|---|---|---|---|
| Morning Mist | `(−0.62, 0.55, 0.45)` | 0.44 | Low sun from the front left; long soft-looking shadows, little contrast |
| Warm Cedar Afternoon | `(−0.50, 0.78, 0.42)` | 0.32 | High sun; short crisp shadows; the reference look |
| Sakura Dusk | `(0.66, 0.42, 0.40)` | 0.36 | Low sun from the right; long shadows fall across the bed to the left |
| Moonlit Koi Pond | `(−0.40, 0.72, −0.34)` | 0.46 | Moon from behind the wall; the wall face is in shade, the lantern and Gubba C's shell glow |

Measured: ink on paper is 11.6:1 to 15.9:1 in every mood. Mood selection defaults to the local clock (Morning 05–11, Afternoon 11–17, Dusk 17–20, Moonlit 20–05, re-checked every 10 minutes) and can be pinned from the lantern HUD object.

### 2.7 Overlay and typography

The overlay is 2D: palette indices on a canvas of its own, composited after the resolve pass.

- **Sized for the window.** The scene's pixel scale `k` follows whichever side of the window binds (2.2), so in a window narrower than the reference shape scene pixels are small against the window, and on a short landscape phone (such as an in-browser 726×275 @3x viewport) scene pixels are small against a thumb. The overlay therefore has its own pixel size `uiK`, in whole device pixels:

  ```
  byWindow = round(min(canvasWidth, canvasHeight) / targetRows)    // the rule a landscape window's scene uses
  byThumb  = ceil((40 · dpr) / 16)                                 // thumb floor: ≥ 40 CSS px HUD objects where layout allows
  start    = max(byWindow, byThumb)
  uiK      = the largest value from start down to ⌈1.25 · k⌉ whose canvas, floor(canvas / uiK), keeps the speech
             scroll 172 pixels wide and fits every Settings tab and the basket tray (above the HUD, or beside the HUD on short wide canvases); otherwise k
  ```

  It is never finer than the scene, and a step under a quarter is not taken (9 device pixels over the scene's 8 in a 16:10 window would move the two onto different grids for an eighth more size). Desktop landscape windows (16:9, 16:10, ultrawide) already clear both `byWindow` and `byThumb`, so there `uiK = k` and the overlay shares the scene's pixels in pass 4. On tablets, split-screen windows, and landscape phones where `uiK > k`, the overlay is laid over the present blit in pass 5, anchored to the canvas's bottom-left corner.

  | Window (Crisp) | Scene `k` | Overlay `uiK` | HUD object, CSS pixels | Panels |
  |---|---|---|---|---|
  | 1456×820 @1x | 4 | 4 | 64 | above HUD |
  | 1440×900 @1x | 4 | 4 | 64 | above HUD |
  | 1024×768 @1x | 3 | 4 | 64 | above HUD |
  | 768×1024 @1x | 2 | 4 | 64 | above HUD |
  | 1024×1366 @1x | 3 | 5 | 80 | above HUD |
  | 640×720 @1x | 2 | 3 | 48 | above HUD |
  | 844×390 @3x | 6 | 8 | 42.7 | above HUD |
  | 726×275 @3x (in-browser phone) | 4 | 8 | 42.7 | beside HUD |
  | 667×260 @2x (in-browser phone) | 3 | 5 | 40 | beside HUD |

  Across the popular windows, both densities and device pixel ratios 1–3, a HUD object is 6–14 % of the window's shorter side or the thumb floor (up to ~16.4 % on short in-browser landscape phones), whichever is larger. Hit rectangles and the HUD clearance the camera uses (2.4) are in framebuffer pixels at the drawn size, so they may be fractional when `uiK` is not a multiple of `k`. Low-res readbacks (`frameHash`, `exportPng` with `includeOverlay=true`) hold the overlay only where it shares the scene's pixels; `paletteViolations()` renders pass 5 at full canvas backing size so every presented pixel (including any independently scaled overlay) is checked against the 32-colour palette.
- **HUD:** six 16×16 objects in a 3×2 block at the bottom left: undo, redo, breath lotus, mood lantern, sound bell, menu scroll. They are pixel art defined as data in code, not image files.
- **Speech scroll:** up to 172 pixels wide, shown only while there is text. It sits beside the HUD where 172 pixels fit there, or at least 100 on a canvas less than 1.1 times taller than wide; otherwise it sits above the HUD at full width, which is where a tablet held upright has empty deck. On short wide canvases where panels open beside the HUD, the speech scroll sizes its height to its wrapped text lines rather than reserving all three lines. It never covers the bed in the Cozy camera except its front edge.
- **Panels:** the menu scroll (Settings) and the stone basket tray hang from the top-left and stop above the HUD block wherever every tab fits there; on short wide canvases (such as in-browser landscape phones with thumb-sized overlays), they open to the right of the HUD block at full canvas height so no control is clipped or overlaps a HUD object. Rows wrap to the panel's width; a panel too narrow for a label beside its chips or mix pips puts them underneath. Every hit rectangle is cut to the framebuffer.
- **Font:** an original bitmap font defined in code (the one in the mockup). Cap height 7, x-height 5, glyphs 4 wide (5 for m and w, 1 to 3 for narrow letters), two descender rows, line pitch 9. No italics, no all-caps body text. Text is always `ink` on `paper`. A line of dialogue is at most 96 characters and wraps to at most 3 lines of 158 pixels.
- Every string drawn on canvas is mirrored in a DOM `aria-live="polite"` region.

### 2.8 Ambient motion

Particles are world-space points, depth-tested against the scene and drawn as single framebuffer pixels.

| Mood | Motion | Limits |
|---|---|---|
| Morning Mist | Two thin dithered mist sheets drifting above the deck, never over the bed | 2 units/s |
| Warm Cedar Afternoon | Sun motes rising slowly | 7 motes |
| Sakura Dusk | Petals falling through the scene; they rest on the sand until raked over or 40 s pass | 12 falling, 12 resting |
| Moonlit Koi Pond | Fireflies on a 1.5 s blink; a dithered warm glow on the sand around the lantern | 8 fireflies |
| Rain (toggle, any mood) | Streaks above, 3-frame ripple rings on the sand; Gubba holds a leaf | Cosmetic only |

Particles never alter the sand grid and are not saved. With `prefers-reduced-motion`, particles are off, palette and camera changes are instant, and the smoothing sweep becomes a 300 ms dither dissolve.

---

## 3. Sand

### 3.1 Grid

`W = 192`, `H = 112`, row-major, three typed arrays of length 21 504. One cell is one world unit.

| Array | Type | Meaning |
|---|---|---|
| `height` | `Int8Array` | Sand height in levels, clamped to `[-3, +3]`. 0 = level, negative = groove, positive = ridge |
| `dir` | `Uint8Array` | Orientation of the last stroke through the cell: 8 bins of 22.5° (undirected), `255` = unraked |
| `rock` | `Uint8Array` | 0 = sand, otherwise element index + 1. Derived from the element list, never saved |

The grid is 192×112 rather than larger because of the camera: from the Cozy view a groove needs about three framebuffer pixels per period to read, and at Crisp density the bed is about 235 pixels wide and 95 deep. `dir` earns its place three ways: unraked cells get grain speckle and raked cells do not; the foley crunches when a stroke crosses existing grooves at an angle; Gubba can notice patterns without image analysis.

### 3.2 Rake profile

A rake is a 1-D array of height values across its head, one entry per cell of head width. `KEEP = 127` means "leave this cell alone". The same array drives the stamp and the 3D model: each run of groove cells becomes one tine.

```ts
interface RakeSpec {
  id: RakeId;
  profile: Int8Array;      // e.g. Sugi: [+1, -2,-2, +1,+1, -2,-2, ... , +1]  (20 cells)
  handle: number;          // L: trailing handle length in cells; larger = heavier, smoother turns
  wave?: { amp: number; len: number };   // Mikazuki only
  flat?: boolean;          // Nagi: writes dir = 255
  orbit?: boolean;         // Wa: rings around the nearest stone or pin
}
```

### 3.3 Stroke pipeline

Pure geometry on the grid, no time constants, so results do not depend on frame rate or camera.

1. **Input.** `pointerdown/move/up` with `getCoalescedEvents()` and pointer capture. Each point becomes a ray from the camera through the pixel, intersected with the sand plane `y = 3`, giving float grid coordinates. Points outside the grid are kept; stamps are clipped.
2. **Deflection.** If the head centre falls inside a stone's footprint grown by 2.5 cells, it is pushed radially to the edge of that ellipse, so the rake slides round the stone instead of passing through it.
3. **Heading.** A virtual handle end trails the head at distance `L` (a tractrix): `tail = head − L · unit(head − tail)`. The heading is `atan2(head − tail)`. Jitter of `j` cells turns the head by about `j / L` radians, so wide rakes swing slowly and the stylus turns at once.
4. **Resample.** The head path is walked at fixed arc-length steps `ds = min(0.5, 1 / (1 + halfWidth / L))`, carrying the remainder across segments. A pointer jump of 300 cells becomes 600 or more stamps.
5. **Stamp.** Each step stamps a thin rectangle centred on the head: `|v| ≤ 0.75` along travel, `|u| ≤ halfWidth` across it. Stamping is an **inverse map**: for every cell centre in the rectangle's bounding box, compute `(u, v)` in the head frame and write `height = profile[floor(u + halfWidth − waveOffset)]`, `dir = bin(heading)`. Each cell is tested by its own centre, so there are no holes at any angle; consecutive rectangles overlap, so there are no gaps along the stroke.
6. **Write rule.** Overwrite. A rake flattens what was under its head and leaves its own profile. Applying the same stroke twice changes nothing.
7. **Touch input, smoothing, and haptics.** Touch strokes begin on the sand or within an 8-cell rim around the wooden frame, ignore the first 8 CSS px of tap slop, and then follow the fingertip on a 3 CSS px "string" (`src/ui/touch.ts`) to remove tap dabs, thumb wobble, and lift-off hooks while still anchoring the stroke at the press point and waiting 3 grid cells to set initial heading (with the waiting rake pre-aligned toward the finger). If a second finger lands for a pinch within 150 ms or 24 CSS px of stroke start, the young stroke rolls back cleanly with no undo entry. Off-sand touch misses search within 12 CSS px for the nearest hanging rake, Gubba, or basket (excluding stones so raking near one never grabs it), and HUD/menu taps allow 8 CSS px slop. Touch orbit applies per-move deltas after an 8 CSS px tap slop; stone dragging keeps its grab offset after drag slop (8 px touch, 3 px mouse). Far-off touch drags are bounded to 192 cells outside the bed. Mouse and pen input bypass the touch brush filter. Touch interactions trigger subtle haptics (`src/ui/haptics.ts`) via `navigator.vibrate` on Android and a lazy hidden `<input type="checkbox" switch>` label click on iOS WebKit (covering iOS 17.4–26.4; degrading silently on iOS 26.5+ and desktop), strictly touch-only, silent during autonomous Gubba actions and under `prefers-reduced-motion`.

**Mikazuki wave:** `waveOffset = amp · sin(2π · arc / len)`, where `arc` is the distance travelled since the stroke began.

**Wa orbit:** if the press lands within 40 cells of a stone or pin centre, the head is constrained to the circle through the press point around that centre. Its angle follows the pointer, and the two prongs sit at ±4 cells radially. Elsewhere it is a free two-tine rake.

**The held rake in 3D.** The model's tine tips sit at the head point. While raking, the tips touch the sand and the handle pitches back 0.62 rad along the pull; while hovering, the rake floats 3.2 units up at 0.5 rad. Yaw follows the heading. Its shadow on the sand is a real cast shadow, which is what makes the lift readable.

### 3.4 Stones: mask, flow, deflection

- Cells with `rock ≠ 0` are never written.
- The head deflects round stones (3.3, step 2).
- **Flow** (default on, decision D9): grooves part around stones like water. In the stamp, each cell's lateral coordinate is remapped by a tapered potential-flow term before the profile lookup. For a stone with centre `s` and footprint radii `(rx, ry)`:

  ```
  R = (rx + ry) / 2 + 1
  e = ((px − sx) · R / (rx + 1), (py − sy) · R / (ry + 1))      r = |e|
  if r < 3R:   t = clamp((r − R) / 2R, 0, 1)     w = 1 − t²(3 − 2t)
               u −= (e · n) · (R² / r²) · w          // n = lateral unit vector of the head
  ```

  The effect is local (zero beyond 3R). With Flow off, grooves simply stop at the stone.
- When the head first touches a footprint, the foley plays one soft "tok".

### 3.5 The sand in 3D

- **Mesh:** a plane of 192×112 segments (21 809 vertices, 43 008 triangles) at `y = 3`. The vertex shader lifts each vertex by `0.35 · height`, so ridges are real geometry and the bed's edge shows a true profile.
- **Textures:** `height` and `dir` are uploaded as two 192×112 `R8` textures. After each batch of stamps, only the dirty rectangle is re-uploaded.
- **Lighting:** the fragment shader takes the height gradient by central differences at spacing `e = max(0.75, 0.55 · worldUnitsPerPixel / sin(elevation))`, with linear filtering on the height texture. That spacing widens with distance, so far grooves fade to texture instead of shimmering. `L` is the light direction; `s` is how much the surface leans toward the light.

  ```
  s    = −(∂h/∂x · Lx + ∂h/∂z · Lz) / |(Lx, Lz)|
  t    = 2 + 0.72 · s + 0.32 · h            // h in levels
  if shadowed: t −= 1.35
  tone = clamp(floor(t + 0.5 + (b − 0.5) · 0.5), 0, 4)      // index into sand0..sand4
  ```

- **Why the height term.** With slope alone, grooves that run parallel to the light go flat and a wedge of every ring washes out (seen in the first prototype). The `0.32 · h` term keeps troughs a little darker and crests a little lighter from every direction.
- **Shadows on the sand:** stones, lantern, frame, Gubba, and the held rake all cast onto the bed through the shadow map. In Morning and Dusk those shadows are long and are a large part of the look.
- **Grain:** unraked level cells get static speckle from a position hash: 1 cell in 32 one tone darker, 1 in 32 one tone lighter.

### 3.6 Undo and redo

- One entry per action: stroke, place, move, remove, smooth-all, load preset.
- A stroke entry stores its bounding box and the before and after contents of `height` and `dir` inside it. Smooth-all and preset entries store the whole grid.
- Depth 32, oldest dropped. Worst case is about 2.8 MB.

### 3.7 Smooth-all sweep

Triggered by holding the Hōki broom for 0.8 s. A slightly bowed front crosses the bed in 2.4 s:

```
front(t, y) = −8 + (W + 16) · ease(t / 2400) + 4 · sin(π · y / H)
```

Cells behind the front become level and unraked. The sand shader draws the two cells behind the front in `sand4` and the next in `sand1`, a rolling crest. Raking stays enabled during the sweep. The sweep is one undo entry.

### 3.8 Garden elements

Placed from the stone basket. At most 12 per garden. Elements snap to whole cells; the footprint is an ellipse on the grid; the model is a `.glb` from section 8.

| Element | Footprint `(rx, ry)` | Model height | Notes |
|---|---|---|---|
| `stone_s` | 4, 3 | 5 | |
| `stone_m` | 7, 5 | 8 | |
| `stone_l` | 10, 7 | 15 | |
| `stone_tall` | 5, 4 | 20 | |
| `stone_flat` | 11, 5 | 5 | |
| `lantern` | 5, 4 | 27 | Window is emissive at dusk and night and lights the sand around it |
| `bonsai` | 6, 4 | 22 | |
| `moss_a` | 13, 9 | 2 | A low mound; stones may sit on it |
| `moss_b` | 9, 6 | 2 | |
| `basin` | 8, 6 | 6 | Water surface with a 4-frame ripple; koi shadow at night |
| `pin` | 1, 1 | 3 | Brass pivot for Wa |

Picking the basket opens a tray in the overlay. The chosen element follows the pointer on the sand plane, casting its shadow, and drops with a soft thud. In placement mode, drag an element to move it and drag it back to the basket to remove it. Placing levels the footprint plus one cell; removing leaves a flat pressed patch.

### 3.9 Presets, Watch mode, and Autonomous Gubba Mode

Presets are **stroke programs** (elements plus a list of `{rake, points}`), replayed through the same engine. Two separate toggles live on the Settings → Presets tab:

- **`Watch: Gubba rakes | Instant`** (default `Instant`): controls what happens when the player manually clicks a preset while `Gubba mode` is off. `Instant` snaps the garden immediately (1 undo entry). `Gubba rakes` runs one full 3D organic choreography cycle toward that preset (Gubba leaves his porch cushion, relocates/adds/removes stones, smooths sand residue if needed, rakes the strokes with live foley, seals cleanly within ≤ 64 cells to the golden hash, hangs the rake, returns to his cushion, commits 1 undo entry, and stays seated).
- **`Gubba mode: On | Off`** (default `Off`, key `R`, DOM mirror twin): continuous autonomous caretaker mode. Turning it on wakes Gubba off his cushion to draw a non-repeating random patterned preset from a deterministic xorshift32 shuffle bag (`still_sand` excluded from random draws, valid when explicitly clicked), organically transform the current garden into it, return to his cushion for tea and a 20–32 s admire pause, and then continue to the next preset indefinitely. Clicking any preset chip while `Gubba mode` is on re-plans organically toward that preset and continues the loop. Any player garden edit (raking, picking a rake, placing/moving/pressing a stone, sweeping, undo/redo) smoothly yields Gubba back to his cushion and turns `Gubba mode` off, committing at most 1 undo entry for the whole run (while open, `localStorage` autosaves keep the pre-run garden so refreshing mid-run preserves the player's work). Tapping Gubba says a line without interrupting; camera, mood, variant, sound, rain, breath, export, and panels leave `Gubba mode` running. Under `prefers-reduced-motion`, Gubba stays seated and each plan step applies whole every 1.6 s.

| Preset | Content |
|---|---|
| Still Sand | Level, empty |
| Three Islands | Three stones, each with rings, long east–west lines between (the mockup's opening garden) |
| Ripple Pond | One stone, rings out to the frame |
| Old Sea | Mikazuki wave rows, edge to edge |
| River Bend | Two stones, S-curve Ōnami passes with Flow on |
| Snail's Thought | One stylus spiral from the centre |
| Checker Field | Alternating 24×28 blocks of east–west and north–south Sugi |

### 3.10 Persistence and export

- `localStorage["rake-me:garden:v1"]`: `{ v: 1, elements, sand }`, where `sand` is `height` then `dir`, byte run-length encoded, then base64. Budget 64 KB.
- `localStorage["rake-me:settings:v1"]`: rake, mood or `auto`, camera preset, pixel density, breath pattern, Gubba talk mode, mix levels, mute, rain, flow, heard stories.
- Saved 1 s after each action and on `visibilitychange`. An unknown version or corrupt payload loads a fresh garden and never throws.
- **Export PNG:** the resolved low-res frame is read back and scaled by an integer (4×, 6×, 8×, or 12×) with nearest-neighbour, omitting the HUD overlay for player downloads (`includeOverlay=true` is supported for low-res frames when the overlay shares the scene grid). Downloaded as `gubbas-porch-YYYYMMDD-HHmm.png`; the Web Share API is used on mobile when available.

---

## 4. The Wall of Rakes

A real timber rack on the wall behind the garden. Ten tools hang on pegs in one row, at true scale: the rake you take down is the same model, the same size, that then moves over the sand. Everything is available from the first minute (decision D5).

### 4.1 Roster

Profile notation: `G` = groove, `R` = ridge between tines, `B` = outer berm. "Head" is the profile width in cells, and therefore the model's head width in world units.

| Key | Name | Tool | Tines × width, gap | Head | Depths `G / R / B` | `L` | Look | Role |
|---|---|---|---|---|---|---|---|---|
| 1 | **Sugi** | Classic 5-Tine Cedar | 5 × 2, gap 2 | 20 | −2 / +1 / +1 | 8 | Red cedar, square head beam, hemp wrap at the joint | Everyday lines. The default |
| 2 | **Ōnami** | Wide 9-Tine Tide | 9 × 2, gap 2 | 36 | −2 / +1 / +1 | 12 | Grey-blond driftwood pine, rope bindings | Broad calm sweeps; fills the garden in four passes |
| 3 | **Kinu** | Fine 11-Tine Silk | 11 × 1, gap 1 | 23 | −1 / +1 / +1 | 8 | Pale hinoki comb with thin bamboo teeth | Fine texture, slow detail |
| 4 | **Hisui** | Jade Cadence | 4 deep × 2 and 3 shallow × 1, alternating | 19 | −2 and −1 / +1 / +1 | 8 | Jade teeth in a black lacquer head, gold cord | A long-short rhythm in every pass |
| 5 | **Mikazuki** | Crescent Wave Sweep | 6 × 2, gap 2 | 24 | −2 / +1 / +1 | 10 | Curved maple head, indigo cord | Draws waves by itself: amplitude 3, wavelength 24 |
| 6 | **Tetsu** | Three-Tine Iron Furrow | 3 × 3, gap 3 | 17 | −3 / +2 / +2 | 14 | Black iron head with rivets, charred oak handle | Deep furrows, the darkest shadows, the lowest sound |
| 7 | **Wa** | Twin-Prong Orbit | 2 × 2, gap 6 (`KEEP`) | 12 | −2 / keep / +1 | 6 | Forked walnut branch, brass ring | Perfect rings around a stone or pin |
| 8 | **Take** | Single Bamboo Stylus | 1 × 1 | 3 | −2 / — / +1 | 4 | Green-gold bamboo, slant-cut tip | Drawing, writing, spirals |
| 9 | **Nagi** | Flat Sand Smoother | board | 16 | 0 | 10 | Wide paulownia board on a short handle | Rests a patch of sand without clearing the garden |
| 0 | **Hōki** | Bamboo broom | — | — | — | — | Bundled bamboo twigs | Hold to smooth all sand (3.7). An action, not a mode |
| P | Stone basket | Woven basket in the nook | — | — | — | — | Bamboo weave, three stones showing | Placement mode (3.8) |


Constraint checked by test: `halfWidth ≤ 2·L` for every rake, which bounds tine travel per stamp.

### 4.2 Rack layout

Left to right in key order, each slot as wide as its head (at least 8), with 3.4 units between slots, centred on x = 0. Total width 217.6.

| Key | Tool | Slot centre x | Slot width |
|---|---|---|---|
| 1 | Sugi | −98.8 | 20 |
| 2 | Ōnami | −67.4 | 36 |
| 3 | Kinu | −34.5 | 23 |
| 4 | Hisui | −10.1 | 19 |
| 5 | Mikazuki | 14.8 | 24 |
| 6 | Tetsu | 38.7 | 17 |
| 7 | Wa | 56.6 | 12 |
| 8 | Take | 70.0 | 8 |
| 9 | Nagi | 85.4 | 16 |
| 0 | Hōki | 102.8 | 12 |

Rakes hang head-up: the head beam rests on two pegs, the handle hangs straight down, and the tines point out toward the room. From the Cozy camera, which looks down on them, the tines show as a row of teeth under each beam, so every tool can be told apart by counting. The hanging pose is the model rotated π/2 about x and π about y from its in-use pose.

### 4.3 How choosing feels

| Moment | Sight | Sound | Gubba |
|---|---|---|---|
| Hover a rake | It swings 2.4 units out from the wall and 1.9 up, and its shadow on the planks separates; its name tag appears in the speech scroll ("Sugi · five tines") | A dry wooden tick, 2 ms click through a 1.8 kHz bandpass | Turns its head toward the rack |
| Select | The rake lifts off its pegs and travels to the hand over 0.35 s on an eased arc; the pegs stay empty | A two-part clack: triangle 220→160 Hz for 40 ms plus a 25 ms noise burst at 1.2 kHz. Each peg has its own pitch from the mood's scale, so running along the wall plays a wooden scale | One line, the first time each session and one time in four after that |
| Return | The previous rake travels back and settles on its pegs with a small bounce | A softer, lower tok | — |
| Touch | Tap selects; long-press shows the name tag and story | Same | Same |

Picking uses the part-id channel of the G-buffer: the pixel under the pointer already says which rake, or Gubba, or the basket, it belongs to. Keys `1`–`9` select, `0` (held) sweeps, `P` opens the basket.

### 4.4 Gubba's line for each tool

| Tool | Line |
|---|---|
| Sugi | "Five lines. Enough for most days." |
| Ōnami | "The tide does not hurry, and the whole shore is combed." |
| Kinu | "Fine as rain on silk. It likes a slow hand." |
| Hisui | "Long, short. Long, short. Even stone keeps time." |
| Mikazuki | "This one remembers the sea." |
| Tetsu | "Heavy things leave honest marks." |
| Wa | "One foot stays, one foot wanders. That is a circle." |
| Take | "One line is also a garden." |
| Nagi | "Nothing is erased. The sand only rests." |
| Hōki | "Ah. A clean morning, at any hour you like." |
| Basket | "Set a stone down and the sand has something to talk about." |

Each rake also has a three-line story, told one line per tap on Gubba. Hearing it stamps a small red seal on the peg's name tag. That seal is the only "collection" in the game and gates nothing.

---

## 5. Gubba

### 5.1 Role and personality

Gubba is the caretaker: very old, very large, and shaped like a beanbag that learned to sit. The art direction is "Yabba the Hut": Gubba is **meant to look silly and a bit funky**. A lumpy, sprawling slug-toad with no neck, a grin as wide as the face, two eyes that do not quite match, warts, folds, a curled tail, and arms far too small to be useful.

The joke is the contrast. This ridiculous blob sits beside the sand with a thimble of tea, delivers calm, deadpan wisdom, and never notices that it is funny. The comedy is always warm and slow: nothing about Gubba is loud, gross, sudden, or mocking. Gubba is content whether you rake well, badly, or not at all, and never teaches, grades, or reminds.

**Voice rules**

- At most 96 characters. Plain words. No exclamation marks.
- Deadpan. Gubba never winks at the audience or comments on its own shape.
- No praise or judgement of the garden, no mention of time spent, visits, or absence.
- Imperatives only for breath cues ("In." "Hold." "Out.").
- Sometimes the whole line is "Mm."

**Sample reflections**

- "The garden is finished whenever you stop."
- "I have raked this corner for two hundred years. It is going well."
- "I do not rake. I supervise. It is harder than it looks."
- "This cushion and I have an understanding. It has agreed to try."
- "My arms are short so that the tea stays close."
- "Breathe out a little longer than you breathe in. The tea taught me that."
- "A crooked line is still a line the hand enjoyed."
- "The stones are not in the way. The stones are the way around."

Lines are data in `src/gubba/lines.ts`, tagged by trigger (`rake:<id>`, `mood:<id>`, `idle`, `first`, `rain`, `sweep`, `stone`, `breath`, `story:<id>:<n>`). Target for v1: about 120 lines.

### 5.2 Behaviour

| State | Trigger | Animation |
|---|---|---|
| Breathe | Always | Squash and stretch on the breath clock (section 6): the body widens 2% and rises 3.5%, and whatever is perched on the head bobs with it |
| Blink | Every 3–7 s | Lopsided: the sleepy eye closes about 80 ms after the wide one |
| Watch | Rake is down | The head turns up to 0.5 rad toward the rake and both pupils slide after it, slightly out of step; the tongue tip peeks from the corner of the grin |
| Sip | Every 40–90 s | About 1.2 s: the tiny arm strains upward, the head comes down the rest of the way |
| Glance | Pointer over the wall | The head turns toward the rack |
| Speak | A line is shown | The wide mouth opens for the first 400 ms; the scroll unrolls |
| Tail | Every 20–40 s | The curled tip flicks once |
| Doze | 3 minutes without input | Lids closed, the head sinks 1 unit, a small "z" drifts up as two particles, the head prop slides slightly askew. Wakes with one slow blink, never a start |
| Rain | Rain is on | Holds a broad leaf overhead with both tiny arms; it covers very little |
| Tend (`Gubba mode` / `Watch: Gubba rakes`) | Mode on or preset watched | Rises off his independent `Cushion` node (Moss/Kasa; Lantern has none), hides tea/incense cup & steam, waddles with distance-locked gait to basket/wall/sand, carries stones at belly, leads rakes backward with per-variant grip anchors, sweeps with Hōki behind the crest, hangs rakes back up, and returns seated to admire |

**Talk modes**, cycled with `G` or from the menu scroll:

| Mode | Behaviour |
|---|---|
| Quiet | Never speaks. Still breathes, blinks, sips |
| Now and then (default) | Rake lines as in 4.3; one reflection after a long pause; never more than one line per 90 s |
| Companion | A reflection or story line about once a minute |

Tapping Gubba always produces one line, in any mode. The first visit has no tutorial: Gubba says "Take a rake. Any rake." once.

### 5.3 Homage, not copy

The reference is the most famous lounging slug in cinema, and the design leans into it on purpose. What Gubba borrows is the **comic silhouette**: a vast neckless body, a head as wide as the shoulders, a mouth that spans the face, heavy lids, rolls, tiny arms, a curled tail.

What Gubba does not take: the original's name, colouring, slit-pupil eyes, hookah and dais, or any line or sound from the films. Everything else is Gubba's own: moss and warts, mismatched round eyes, a zen prop that is the wrong size, tea. That makes Gubba a parody of an archetype rather than a likeness, which matters because the site is public (decision D2).

### 5.4 Three appearance concepts

All three are the same kind of creature with the same anatomy rules: no neck, face-wide grin, lopsided eyes, folds, tiny arms, tail curl, and one prop that is comically the wrong size. They differ in pose, palette, and props. Each is built as a 3D model of 20 to 30 low-poly lumps; [`docs/mockups/gubba-concepts.html`](docs/mockups/gubba-concepts.html) shows all three turning, with front, side, and back silhouettes, and the garden mockup can switch between them in place. Gubba is about 48 units wide and 40 high.

#### A — Moss Yabba

- **Pose:** a sprawling mound seen from the front, wider than it is tall, overflowing a zabuton far too small for it. Only the corners and one tassel of the cushion escape.
- **Face:** the left eye is big and round, the right is smaller with a drooping lid. The grin runs the full width of the head, with the tip of a tongue at one corner. Rosy cheeks, two dot nostrils.
- **Body:** three stacked rolls (sprawl, shoulders, head), a pale belly with a fold, mossy warts across the head and shoulders, a thick four-segment tail curling round to the back right with an upturned tip.
- **Props:** a tiny bonsai sprouting crookedly from the head, bobbing with each breath; a thimble-sized clay teacup held in arms that barely reach each other.
- **Palette (afternoon):** moss `#3f5a36` / `#6a8a4a` / `#9db46a`, belly `#e8dcae`; warts in `leaf2` and `leaf3`, cushion in the `warm` ramp.
- **Reads as:** a hill of the garden that woke up, sat down, and stayed.
- **Blender build:** three squashed UV spheres for the body, one for the belly, two eye assemblies, a flattened ring for the grin, four tail spheres, about ten wart spheres, a box-and-two-blobs bonsai. Roughly 2,400 triangles. The simplest of the three.

#### B — Kasa Yabba

- **Pose:** upright and pear-shaped, with heavy jowls that make the head wider at the bottom than the top.
- **Face:** one sleepy eye, one wide one. A jowl-to-jowl grin under catfish whiskers that curl up at the tips like a moustache.
- **Body:** an indigo sash tied a size too tight, so the belly bulges over it. The tail wraps round to the front left and curls.
- **Props:** a straw kasa made for a much smaller head, perched at a tilt with its cord long since untied; a tiny bamboo pipe at the corner of the grin with a wisp of smoke; a thimble cup in both stubby hands.
- **Palette (afternoon):** clay `#6b4a2e` / `#a8743c` / `#d4a45c`, belly `#f0dcae`; sash in `water`, hat in `wood_light`, cord in `warm`.
- **Reads as:** a wandering monk who found the garden, sat down, and has been meaning to leave for a century.
- **Blender build:** pear body, head, two jowl spheres, a 9-sided cone hat with a brim disc, a ring sash with a knot, box whiskers, pipe. Roughly 2,600 triangles. The busiest face of the three at low resolution.

#### C — Lantern Yabba

- **Pose:** sprawled sideways, head and chest to the left, belly hump behind, and a long five-segment tail that tapers to the right and curls up and over.
- **Face:** eyes on two stubby stalks of different heights, the taller one half-lidded. The stalks lean toward the rake and sag when Gubba dozes. Wide grin, tongue tip.
- **Body:** belly rolls along the hump, a pale underside, a few warts.
- **Props:** a headband worn askew with a flopping knot; a three-turn spiral shell several sizes too small, perched on the hump like a hat that gave up. The shell uses the `sand` ramp, so it matches the garden, and a firefly lights its window at dusk and at night. One tiny hand holds an incense stick.
- **Palette (afternoon):** slate-lavender `#3d3a55` / `#67648a` / `#9a98b8`, belly `#e4dcd0`; shell in `sand`, glow in `glow`.
- **Reads as:** dreamy and nocturnal; the funkiest of the three, and strongest in Sakura Dusk and Moonlit.
- **Blender build:** two body spheres, five tail spheres, two stalk prisms with eye assemblies, three shell spheres, ring headband with box knot. Roughly 2,800 triangles, and the stalks need their own pivots.

#### Comparison

| | A Moss Yabba | B Kasa Yabba | C Lantern Yabba |
|---|---|---|---|
| Silhouette | Wide front-on mound | Upright jowly pear, tiny hat | Sideways sprawl, eye stalks, tiny shell |
| Wrong-sized prop | Cushion, teacup | Hat, sash | Shell |
| Clear from the Cozy camera | Best | Busiest face | Good |
| Expression comes from | Mismatched eyes, bonsai | Whiskers, hat tilt | Eye stalks |
| Best mood | Morning, Afternoon | Afternoon | Dusk, Moonlit |
| Build effort | Low | Medium | High |

**Recommendation:** A. It is the funniest at a glance, the clearest at low resolution, the cheapest to animate, and it looks like it grew in this garden. Traits move freely between concepts: B's tiny hat or C's too-small shell would sit on A's head as one extra node.

### 5.5 The models: `gubba_moss.glb`, `gubba_kasa.glb`, `gubba_lantern.glb`

All three Gubba concepts (A Moss Yabba, B Kasa Yabba, C Lantern Yabba) are built in Blender and shipped so the player can swap between them live in the Settings tab (persisted in `localStorage`, defaulting to `moss`). Switching swaps both the active Gubba mesh and palette slots 26–29 in the active mood's 32-colour palette. Each file is a rigid node hierarchy with no skeleton and no baked clips; all animation is code moving named nodes driven by the breath clock.

| Node | Pivot | Driven by |
|---|---|---|
| `Root` | Floor centre | Placement on the porch |
| `Body` | Floor centre | Breath: scale `(1 + 0.02a, 1 + 0.035a, 1 + 0.02a)`, `a` = breath amplitude |
| `Head` (child of `Body`) | Neck line, on the body's axis | Yaw toward the rake (up to 0.5 rad) or the rack (0.55 rad); a 0.6-unit bob with breath |
| `EyeL`, `EyeR` | Eye centre | — |
| `PupilL`, `PupilR` | Eye centre | Slide up to 0.2 radii toward the target, the sleepy eye 80 ms late |
| `LidL`, `LidR` | Eye centre | Blink: lower over the eye and back in 280 ms; resting height differs per eye |
| `Mouth` | Head centre | Opens 1 unit while a line starts |
| `ArmL`, `ArmR`, `Cup` | Shoulder | Sip: the arm strains upward and the head tips down to meet it |
| `Tail1` … `TailN` | Previous segment | Tip flicks once every 20–40 s |
| `Prop_*` | Its attachment point | Bonsai, hat, shell, headband, pipe, incense: each bobs or sways slightly out of phase |

Budget: at most 3 500 triangles and 120 KB.

---

## 6. Breath guide

- One `BreathClock`, a pure function of elapsed time and pattern: returns `phase` and `amplitude ∈ [0, 1]`. Inhale rises 0→1 with smoothstep, holds stay level, exhale falls 1→0.
- Patterns: **4-4-6** (default, 14 s), **4-7-8** (19 s), **box 4-4-4-4** (16 s).
- Gubba always breathes on this clock, guide on or off, so turning the guide on reveals a rhythm that was already there.
- With the guide on (`B`, or the lotus in the HUD):
  - the HUD lotus opens over six steps as amplitude rises;
  - a **breath thread** grows along the inner edge of the bed: the sand shader draws cells within 1.3 of the edge in `sand4`, clockwise from the front-left corner, for `amplitude · 608` of the 608-cell perimeter. It is visible in peripheral vision wherever you are raking, from any camera;
  - the music's drone swells with amplitude;
  - optional one-word cues in the speech scroll ("In." "Hold." "Out.") for the first three cycles only.
- The guide never counts breaths or sessions.

---

## 7. Audio

All sound is synthesised with the Web Audio API. There are no audio files.

### 7.1 Graph

```
pulse A ─┐
pulse B ─┼─ music bus ──┐
triangle ┤              │
bell ────┘              ├─ master gain ─ lowpass 9 kHz ─ compressor ─ destination
noise + filters ─ foley bus ─┤
chime, bamboo, rain ─ ambience bus ─┘
```

- The `AudioContext` is created on the first gesture (the title card's "press anywhere"). Music fades in over 8 s.
- Mix: master, music, foley, ambience, each 0–7, gain `(step / 7)²`. Defaults 5, 4, 6, 4. `M` mutes. Settings persist.
- Every gain change is a ramp (`setTargetAtTime` or `linearRampToValueAtTime`), never a step, so nothing clicks. Every oscillator has a scheduled `stop` and is disconnected on `ended`.
- Background tabs: music keeps playing; the scheduler widens its lookahead from 200 ms to 2 s while `document.hidden`, because browsers throttle timers to 1 s.

### 7.2 Voices

| Voice | Source | Envelope | Use |
|---|---|---|---|
| Pulse A | `PeriodicWave`, 32 harmonics, duty 12.5%, 25%, or 50% (`bₙ = 2/(nπ) · sin(nπd)`) | Attack 5 ms, exponential decay 600–900 ms | Plucked lead, koto-like |
| Pulse B | Same, at 0.35 gain | Same, delayed 0.75 beat | Echo of the lead, the classic two-pulse trick |
| Triangle | `OscillatorNode` triangle | Attack 2 s, release 3 s | Drone: root, sometimes with the fifth |
| Bell | Sine plus a 2.76× partial | Attack 2 ms, decay 3 s | Rare high note at phrase starts |
| Noise | 2 s buffer from a 15-bit LFSR, sample-and-hold ×4 | Driven by foley parameters | Rake, sweep, rain |

### 7.3 Composer

| Mood | Scale (semitones) | Root | BPM | Lead |
|---|---|---|---|---|
| Morning Mist | Yo: 0 2 5 7 9 | D | 56 | Triangle with slow attack and 5 Hz vibrato, flute-like |
| Warm Cedar Afternoon | Yo: 0 2 5 7 9 | G | 63 | Pulse 25% plucks |
| Sakura Dusk | Hirajōshi: 0 2 3 7 8 | A | 54 | Pulse 12.5% plucks with echo |
| Moonlit Koi Pond | In: 0 1 5 7 8 | E | 48 | Low triangle, sparse |

- A bar is 4 beats, a phrase 4 bars, a section 4 phrases. **The fourth phrase of every section is drone only.** Silence is part of the piece.
- Each phrase is generated from `hash(seed, mood, phraseIndex)`: an eighth-note grid, note probability 0.30 on beats and 0.12 off them, pitch by a random walk on scale degrees within two octaves, the last bar landing on the root or fifth.
- `composer.events(seed, mood, fromBeat, toBeat)` is a **pure function** that returns sorted events. The scheduler is a thin loop mapping beats to `AudioContext.currentTime`.

### 7.4 Rake foley

Each frame the stroke engine reports: speed `v` (cells/s, smoothed over 50 ms), tine count `n`, tine width `w`, depth `d`, change ratio `c` (share of touched cells whose height changed), crossing `x` (how far the heading departs from the stored `dir` under the head, 0–1), and horizontal position.

| Parameter | Formula | Effect |
|---|---|---|
| Gain | `g₀ · √n / 3 · smoothstep(4, 140, v) · (0.55 + 0.45c)`, attack 30 ms, release 120 ms | Silent at rest; more tines are louder; re-raking a groove is quieter |
| Bandpass centre | `5200 / (0.6 + 0.5w) · (1 + 0.2 · min(v, 200) / 200)` Hz | Thin tines hiss high (about 4.7 kHz), fat tines low (about 2.5 kHz); speed brightens |
| Bandpass Q | `clamp(1.6 − 0.08n, 0.6, 1.6)` | A stylus is a narrow scratch, a wide rake is a broad wash |
| Grain | Square LFO on the gain at `clamp(v / 2, 4, 90)` Hz, depth `0.35 · (1 − smoothstep(60, 160, v)) + 0.3x` | Slow strokes tick grain by grain; crossing old grooves crunches |
| Weight | Triangle at 70 Hz, gain ∝ `d − 1` | Tetsu rumbles |
| Pan | `−0.6 … +0.6` from the rake head's screen-space x | The sound follows the hand in any camera |

Set-down is a 10 ms low-passed noise tick; lift is a 60 ms whisper. The smooth-all sweep is a long noise swell panning left to right with one wooden knock at the end.

### 7.5 Ambience

| Sound | Synthesis | Timing |
|---|---|---|
| Shishi-odoshi | Pulse 12.5% at 320 Hz falling to 180 Hz over 90 ms, with a noise click; a softer rebound 180 ms later. The bamboo arm of the model tips in sync | Every 45–90 s |
| Wind chime | 3–5 bell notes from the mood's scale, high octave | Every 30–120 s, with a breeze that also pushes petals |
| Rain | Noise through 400 Hz highpass and 2.5 kHz lowpass, plus sparse sine pips at 1.5–3 kHz | Toggle |
| Birds (Morning) | Two-note sine chirps | Rare |
| Crickets (Moonlit) | 4 kHz pulse triplets, very quiet | Continuous, slow |

---

## 8. Blender asset pipeline

### 8.1 Ground rules

- Verified on the connected instance: Blender 5.3.0, Python 3.13, NumPy 2.3 bundled, the glTF exporter (`bpy.ops.export_scene.gltf`) present. `blender` is also on `PATH` for headless runs.
- Every model is built by Python in `scripts/blender/` and exported as `.glb`. No imported models, no generators, no hand edits.
- Scripts run in the user's live Blender, so they **create and use only a scene named `RM_Build` and datablocks prefixed `RM_`**, never call `read_factory_settings`, and never touch other scenes. They remove their own datablocks afterwards unless run with `--keep`.
- Scripts are deterministic: seeded `random.Random`, no dependence on UI context. Enum identifiers and exporter options are read at run time rather than assumed (the exporter's `export_format` list is dynamic), and shader nodes are found by `type`, never by name.
- Two ways to run the same files:
  - MCP: `execute_blender_code` with `runpy.run_path("<repo>/scripts/blender/build_all.py", run_name="__main__")`, then `look` to inspect.
  - Headless: `blender -b --factory-startup -P scripts/blender/build_all.py -- --only rakes`.
- Exported `.glb` files are **committed**. CI does not run Blender; it verifies the committed files (8.5).

### 8.2 Modelling conventions

| Rule | Value |
|---|---|
| Units | 1 Blender unit = 1 world unit = 1 sand cell. Exported y-up |
| Style | Low-poly, faceted. Flat shading everywhere except Gubba's lumps and stones, which use smooth normals on visibly few segments (10–12 around) |
| Colour | **No textures and no vertex colours by default.** Each material is named `rm_<ramp>` after a ramp in `assets/ramps.json`; its base colour is that ramp's middle slot in the afternoon palette, so files preview sensibly in any viewer. The game replaces every material with the shared G-buffer shader keyed by ramp name |
| Detail | Painted detail is geometry (a wart is a small sphere, a seam is a gap). If a prop truly needs a texture it is at most 32×32, nearest-filtered, embedded, and listed in the spec |
| Parts | A node's custom property `part` (exported in glTF `extras`) groups meshes for outlines and picking. `cast = false` and `line = false` opt out of shadows and outlines |
| Origins | Rakes: at the centre of the tine tips. Gubba and props: on the ground at the footprint centre |
| Rake frame | Head beam along x, tines down −y with tips at y = 0, handle straight back along +z. The game supplies both poses (in hand and on the rack) |
| Rake tines | Generated from the same profile array the stamp uses: one box per run of groove cells, as wide as the run. The model cannot disagree with the stamp |
| Naming | Tine meshes are named `tine_0` … so the verifier can count them |

### 8.3 Files

| Script | Builds |
|---|---|
| `rm_common.py` | `RM_Build` scene setup, primitive helpers (box, prism, low-poly sphere, jittered rock), ramp materials, export and clean-up |
| `build_rakes.py` | `rakes/sugi.glb`, `onami`, `kinu`, `hisui`, `mikazuki`, `tetsu`, `wa`, `take`, `nagi`, `hoki` |
| `build_props.py` | `props/frame.glb`, `engawa.glb`, `rack.glb` (wall, rails, pegs, shelf), `stone_s`, `stone_m`, `stone_l`, `stone_tall`, `stone_flat`, `moss_a`, `moss_b`, `lantern`, `bonsai`, `basin`, `pin`, `basket`, `shishi_odoshi`, `bamboo` |
| `build_gubba.py` | `gubba_moss.glb`, `gubba_kasa.glb`, `gubba_lantern.glb` (all three swappable concepts), each with the node hierarchy in 5.5 |
| `build_all.py` | Entry point: reads the spec, builds, exports, writes the manifest and a contact sheet render |

All output goes to `public/assets/models/`: 10 rakes, 17 props, 3 Gubba variants, 30 files.

**Export settings** (names confirmed against the live exporter): GLB format, `use_selection`, `export_yup`, `export_apply`, `export_extras`, `export_materials = 'EXPORT'`, `export_image_format = 'NONE'` unless the spec lists a texture, `export_animations = False`, `export_skins = False`, `export_morph = False`, `export_cameras = False`, `export_lights = False`, no Draco.

### 8.4 Budgets

| Asset | Triangles | Bytes |
|---|---|---|
| Each rake | ≤ 300 | ≤ 12 KB |
| Each prop | ≤ 600 | ≤ 24 KB |
| `rack.glb`, `engawa.glb` | ≤ 900 | ≤ 32 KB |
| Each `gubba_*.glb` | ≤ 3 500 | ≤ 120 KB |
| All 30 models together | ≤ 19 000 | ≤ 550 KB |

The combined limit is deliberately tighter than the sum of the per-file limits. For scale, the sand mesh alone is 43 008 triangles, so the models are a small share of the frame.

At load, static props are merged into a few geometries so the scene pass stays under 60 draw calls.

### 8.5 Spec, manifest, verification

`assets/models.spec.json` is hand-written and is the single source of truth. Blender scripts read it, TypeScript imports it for types, and the verifier checks output against it.

```json
{
  "version": 1,
  "models": [
    {
      "id": "rake_sugi",
      "file": "rakes/sugi.glb",
      "maxTriangles": 300,
      "maxBytes": 12288,
      "requiredNodes": ["Head", "Handle"],
      "nodeCounts": { "tine_": 5 },
      "materials": ["rm_wood", "rm_wood_light"],
      "bounds": { "size": [20, 6.5, 48], "tolerance": 1.5 },
      "origin": "tine-tips"
    }
  ]
}
```

`public/assets/manifest.json` is generated: for each model its `file`, `bytes`, `sha256`, `triangles`, `vertices`, `nodes`, `materials`, and `bounds`, plus a top-level `specSha256`.

`npm run verify:assets` (Node, no Blender, a small built-in GLB reader) fails if any of these is false:

1. Every spec id has a manifest entry and a file, and no unlisted file exists under `public/assets/models/`.
2. Each file is a valid GLB: correct magic and version, a JSON chunk that parses, a binary chunk, and every accessor and buffer view inside the buffer.
3. No external URIs, and no images unless the spec lists them.
4. Triangle count and byte size are within the spec's limits, and the totals are within 8.4.
5. Every required node exists; prefixed node counts match (so Sugi has exactly five tines); every material name is in the spec's list and is a known ramp.
6. The bounding box matches the spec within tolerance, and the origin rule holds.
7. Each file's SHA-256 matches the manifest, and `specSha256` matches the spec.

`npm run assets:placeholders` writes box-only `.glb` files that satisfy checks 1–6, so application work is never blocked on Blender.

---

## 9. Architecture

### 9.1 Stack

- TypeScript (strict), Vite, **Three.js** (WebGL2), Web Audio API. Three.js is the only runtime dependency.
- Dev dependencies: Vitest, fast-check, Playwright, ESLint with typescript-eslint.
- Node 22 or later, npm.
- WebGL2 is required for the two-attachment G-buffer. Without it the page shows one static pixel card ("this garden needs WebGL2") and nothing else.
- Static output in `dist/`. `base` comes from `BASE_PATH` (default `/gubbas-porch/`), and every asset URL goes through `import.meta.env.BASE_URL`, so the same build works on GitHub Pages and at a domain root.
- No analytics, no web fonts, no network requests after the initial load.

**Budgets:** JavaScript ≤ 300 KB gzipped (Three.js is most of it; the figure is checked, not assumed); models ≤ 450 KB; total first load ≤ 900 KB; CPU per frame ≤ 4 ms on a mid-range laptop; ≤ 60 draw calls; no allocation in per-frame paths.

### 9.2 Repository layout

```
assets/models.spec.json         hand-written model contract
assets/ramps.json               ramp name -> palette slots
assets/preview/                 contact sheet (not shipped)
docs/mockups/                   self-contained HTML mockups of this design
public/assets/models/           committed .glb files: rakes/, props/, gubba.glb
public/assets/manifest.json     generated manifest
scripts/blender/                bpy build and export scripts (section 8)
scripts/verify-assets.ts        GLB and manifest checks
scripts/make-placeholders.ts    placeholder models from the spec
scripts/check-bundle.ts         size budgets
src/sand/                       grid, stamp, flow, deflection, sweep, hash       (pure)
src/rakes/                      rake table, stroke engine, orbit, wave           (pure)
src/state/                      types, store, undo, presets, serialisation
src/audio/                      composer (pure), scheduler, voices, foley, ambience, mix
src/gubba/                      state machine (pure), lines, breath clock (pure), pose function (pure)
src/render/pipeline/            render targets, the five passes, GLSL, palette textures
src/render/scene/               glb loading, placement, sand mesh, held rake, particles
src/render/camera/              presets, damping, orbit, framing            (maths is pure)
src/render/overlay/             HUD, speech scroll, bitmap font
src/ui/                         input, picking, basket tray, menu scroll, DOM mirror, keys
src/main.ts                     wiring and the frame loop
tests/unit/  tests/e2e/         Vitest and Playwright
```

### 9.3 Module contracts

```ts
// src/sand
interface SandGrid { readonly w: 192; readonly h: 112; height: Int8Array; dir: Uint8Array; rock: Uint8Array }
interface Rect { x: number; y: number; w: number; h: number }
function stamp(g: SandGrid, x: number, y: number, heading: number, rake: RakeSpec,
               waveOffset: number, stones: readonly Footprint[], flow: boolean): Rect;   // returns dirty rect
function deflect(p: Vec2, stones: readonly Footprint[]): Vec2;
function sandHash(g: SandGrid): number;                                // FNV-1a over height then dir

// src/rakes
interface StrokeEngine {
  begin(p: Vec2, rake: RakeSpec, pointer: "mouse" | "touch" | "pen"): void;
  extend(points: readonly Vec2[]): StrokeTelemetry;    // carves; returns speed, change ratio, crossing, dirty rect
  end(): UndoEntry;
}

// src/state
interface GardenState { v: 1; sand: SandGrid; elements: ElementInstance[] }
function encode(s: GardenState): string;   function decode(text: string): GardenState;   // never throws

// src/audio
function events(seed: number, mood: MoodId, fromBeat: number, toBeat: number): NoteEvent[];   // pure

// src/gubba
function breath(pattern: BreathPattern, elapsedMs: number): { phase: BreathPhase; amplitude: number };  // pure
function step(g: GubbaState, e: GubbaEvent, nowMs: number): GubbaState;                                  // pure
function pose(g: GubbaState, amplitude: number, nowMs: number): Record<NodeName, Transform>;             // pure

// src/render
function toneFor(intensity: number, rampLength: number, bayer: number, dither: number): number;   // pure; the GLSL is generated from the same constants
function cameraPosition(rig: CameraRig): Vec3;        function stepCamera(rig: CameraRig, goal: CameraRig): CameraRig;   // pure
interface Pipeline {
  resize(deviceW: number, deviceH: number, density: "crisp" | "chunky"): void;
  render(scene: SceneState, camera: CameraRig, mood: MoodId): void;
  pick(fbX: number, fbY: number): { kind: "rake" | "gubba" | "basket" | "element" | "none"; id?: string };
  sandPoint(fbX: number, fbY: number): Vec2 | null;    // pointer ray against the sand plane, in grid coordinates
  readPixels(): Uint8Array;                            // the resolved low-res frame, for export and tests
}
```

**Import rules, enforced by ESLint `no-restricted-imports`:**

| Module | May import |
|---|---|
| `sand` | nothing |
| `rakes` | `sand` |
| `state` | `sand`, `rakes` |
| `gubba` | `state` (types only) |
| `audio` | `state` (types only), `rakes` (telemetry type) |
| `render` | `sand`, `rakes`, `state`, `gubba`, and `three` |
| `ui` | all of the above except `three` |

`three` is imported only under `src/render/` and in `src/main.ts`. `sand`, `rakes`, `gubba`, `audio/composer.ts`, and the camera maths never touch `window`, `document`, time, or `Math.random`. Time and randomness are passed in.

### 9.4 Input and accessibility

- Pointer events for mouse, touch, and pen. Pen pressure is ignored in v1.
- Keys: `1`–`9` tools, `0` hold to sweep, `P` basket, `Z` undo, `Shift+Z` or `Y` redo, `B` breath, `M` mute, `T` next mood, `C` next camera preset, `X` pixel density, `G` Gubba talk mode, `E` export, `Esc` menu. Arrow keys move a virtual rake over the sand and `Enter` sets it down or lifts it; `Q` and `W` orbit.
- A visually hidden DOM mirror holds a labelled button for every control and a live region for Gubba's lines.
- `prefers-reduced-motion` is honoured (2.4, 2.8). Nothing flashes.

### 9.5 Test hooks

With `?test=1`, or in a dev build, `window.__rakeMe` exposes `sandHash()`, `state()`, `stroke(points, rakeId)`, `advance(ms)` (the clock is injected and frozen), `setMood(id)`, `setCamera(name)` (instant), `setDensity(name)`, `pick(x, y)`, `pickBounds()` (framebuffer bounding boxes of Gubba, the basket, each hanging rake and each placed element), `project(x, y, z)` (a world point in framebuffer pixels), `speechRect()`, `overlayHits()` (both in framebuffer pixels), `fbSize()` (with `scale`, device pixels per scene pixel, and `uiScale`, scene pixels per overlay pixel), `frameHash()`, `paletteViolations()`, and `audio.{state, masterGain}`. In test mode the RNG is seeded and particles are off.

---

## 10. Verification

`npm run verify` runs every row below and is the gate for CI and for calling work done.

### 10.1 Static

| Check | Command | Passes when |
|---|---|---|
| Types | `npm run typecheck` | `tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Lint | `npm run lint` | Zero warnings; import rules from 9.3 hold |
| Assets | `npm run verify:assets` | All seven checks in 8.5 |
| Build | `npm run build` | Succeeds with `BASE_PATH=/gubbas-porch/` and with `BASE_PATH=/` |
| Bundle | `npm run check:bundle` | Budgets in 9.1; `three` is the only entry in `dependencies` |

### 10.2 Unit and property tests (Vitest, fast-check)

| Area | Invariant |
|---|---|
| Stroke continuity | For any polyline with segments up to 300 cells, a 1-tine stroke's carved cells are 8-connected and include every cell whose centre lies within 0.5 of the head path |
| Batching | The same polyline delivered in one `extend` call or in any split produces byte-identical grids |
| Idempotence | Applying a stroke twice equals applying it once |
| Locality and bounds | No write outside the grid; no change farther than `halfWidth + 1` from the head path; `height` stays in `[-3, 3]`; rock cells never change |
| Deflection | The result is never inside a grown footprint; points outside every footprint are unchanged; the map is continuous away from footprint centres |
| Rake table | Profile length equals head width; `halfWidth ≤ 2·L`; ids and keys are unique; rack slots do not overlap and total 217.6 |
| Model and stamp agree | For each rake, the number of groove runs in the profile equals the `tine_` count in the spec |
| Flow | Zero displacement at and beyond 3R; with no stones, flow on and off give identical grids |
| Cel step | `toneFor` is in `0 … n−1`, non-decreasing in intensity for a fixed Bayer value, and equal to the value the generated GLSL constants produce for a table of inputs |
| Ramps | Every ramp's slots exist; multi-slot ramps are non-decreasing in luminance in all four moods |
| Camera | `stepCamera` converges to the goal without overshoot; all presets are within the orbit limits; in Cozy and Top-Down the bed's four corners project inside a 364×205 view |
| Framing | In every popular window (1920×1080 down to 568×320, both densities, device pixel ratios 1–3) each preset's hulls project inside the view with the 6-pixel margin and its HUD rule holds; the 16:9 reference views equal the presets exactly; a view that pulled back touches the margin on two opposite sides; any orbit angle and window shape stays framed and zoom scales the framed distance; the camera never passes the far-plane guard |
| Model and framing agree | Every vertex of every committed hero model, placed as the scene places it, lies inside its framing hull |
| Pixel scale | `k` is an integer ≥ 1 from the height or the width, whichever binds; the canvas never exceeds the window and the leftover border is under one scene pixel; every playable popular window gets at least 180 columns and 110 rows |
| Overlay bounds | In every playable popular window the six HUD objects, the speech scroll, every control of all four Settings tabs and all eleven basket items are present, inside the framebuffer, and clear of the HUD block; at any size down to 1×1 no hit rectangle leaves the framebuffer |
| Overlay size | `uiPixelFor` returns the scene's `k` in desktop landscape reference windows, 4, 3, 4, 5 at 768×1024, 640×720, 1024×768, 1024×1366, and thumb-sized steps (`TOUCH_MIN_CSS = 40`) on landscape phones (8 at 726×275 @3x and 844×390 @3x, 5 at 667×260 @2x); for any window it is a whole number, never below `k`, and a larger value keeps the 172-pixel scroll and whole panels (above or beside the HUD); a HUD object is 6–14 % of the shorter side or the thumb floor (up to ~16.4 % on short phones), whichever is larger; a scaled overlay lays out and draws exactly as a canvas of its own size, with hit rectangles and `hitTest` in framebuffer pixels; the HUD clearance the camera uses equals the HUD block as drawn |
| Viewport rule | Only windows narrower than 600 px and more than 1.15× taller than wide ask to be turned sideways |
| Undo | For any action sequence, `undo` restores the previous grid byte-for-byte and `redo` reapplies it; the stack never exceeds 32 |
| Sweep | The front is monotonic in time; cells ahead of it are untouched; at the end every non-rock cell is level and unraked |
| Serialisation | `decode(encode(s))` equals `s` for arbitrary states; output is at most 64 KB; random and truncated input never throws and yields a fresh garden |
| Presets | Each preset stays in bounds and its replay hash equals the committed golden hash |
| Breath clock | Phases partition the cycle; amplitude is continuous and in `[0, 1]`; the period equals the sum of the pattern |
| Gubba pose | Scales stay within 4% of rest; head yaw stays within ±0.55 rad; the same state and time give the same pose |
| Composer | Pure (same arguments, same events); additive (`events(a, c)` equals `events(a, b)` followed by `events(b, c)`); every pitch is in the mood's scale; at most 5 voices sound at once; every fourth phrase has no lead notes |
| Foley mapping | Gain is 0 at `v = 0`, non-decreasing in `v`, and bounded; the filter centre stays within 400–6000 Hz |
| Palette | Each mood has 32 distinct colours; ink on paper is at least 4.5:1 |
| Gubba lines | In "Now and then", two unsolicited lines are never less than 90 s apart; "Quiet" emits none; every line is at most 96 characters and wraps to at most 3 lines of 158 pixels |

### 10.3 Browser tests (Playwright, Chromium with software WebGL, `?test=1`)

| Test | Asserts |
|---|---|
| Smoke | Loads under `/gubbas-porch/`; a WebGL2 context exists; no console errors, shader compile errors, or failed requests; all 28 models load |
| Pixel rules | `paletteViolations()` is 0 in every mood, camera preset, and density: every pixel of the resolved frame is one of the 32 palette colours. The canvas CSS size is an exact integer multiple of the framebuffer in device pixels |
| Rake | A scripted drag over the bed changes `sandHash()`; a 300-cell jump in one move event leaves no gap; the same drag in Cozy and in Top-Down, aimed at the same grid points, gives the same hash |
| Camera | Raking never changes the camera; dragging on the deck does; each preset key reaches its target |
| Rack | `pick` over each hanging rake returns that rake; clicking it makes it the held rake and empties its pegs; keys `1`–`9` do the same |
| Undo and persist | Undo restores the earlier hash; after reload the hash matches the last saved state |
| Sweep | Holding `0` then advancing 2.4 s gives the level-sand hash |
| Elements | Placing a stone marks its footprint; a stroke across it leaves those cells unchanged and the head path stays outside the grown footprint |
| Visual | Screenshots of the resolved frame for: the opening garden in each mood from Cozy, Top-Down in afternoon, Gubba Porch at night, Chunky density, breath thread at amplitude 1. Compared with `maxDiffPixelRatio: 0.002`, because rasterisation can differ by a pixel between GPU drivers |
| Audio | No `AudioContext` before the first gesture; `running` after; mute sets master gain to 0; a 4-bar `OfflineAudioContext` render has no NaN, peak below 1.0, and RMS in an agreed band |
| Export | The download is a PNG whose size is the framebuffer times the chosen scale |
| Accessibility | Every control has a labelled DOM twin; Gubba's line appears in the live region; with reduced motion emulated, the particle count is 0 and preset changes are instant |
| Performance (soft) | 300 frames of scripted fast raking average under 8 ms per frame; draw calls are at most 60 |
| Viewports (`tests/e2e/viewports.spec.ts`) | At 1920×1080, 1440×900, 1366×768, 1280×720, 1024×768, 768×1024, 640×720, 844×390 (@1x & @3x), 726×275 @3x, 667×375 and 667×260 @2x: no errors, `paletteViolations()` is 0, the canvas is a whole multiple of the framebuffer inside the window; in Cozy, Gubba (each variant), the basket and every hanging rake are rendered, pickable, and touch no framebuffer edge, the bed's corners are inside the margin and its centre rakes under a real pointer; in Gubba Porch, Gubba touches no edge; in Top-Down the bed's corners are inside and its front-left corner is not under the HUD; in Crisp and Chunky the HUD, speech scroll, all four Settings tabs and the basket tray are complete, inside the framebuffer and clear of the HUD (above or beside on short phones), each HUD object is square and 6–14 % of the shorter side or thumb-sized (up to ~16.4 %), the overlay's pixel is a whole number of device pixels, a real click on the menu object opens the menu scroll and activates a chip, and with the clock held the screenshot changes when the scroll opens and is identical when it opens again. At 390×844 and 360×800: the turn-sideways dialog is shown inside the window in paper and ink, the garden behind it takes no pointer or key input and stays palette-clean, and turned to 844×390 or 800×360 the dialog leaves and the whole list above passes |
| Mobile & touch (`tests/e2e/touch.spec.ts`) | At 844×390 @3x: 350 ms touch hold previews rake description without selecting; short tap selects; Hōki hold sweeps with slide-slop guard; pinch-on-sand rolls back young strokes (<150 ms / <24 px) with no undo entry and lifts cleanly with no camera jump; 8 px deadzone + 3 px string removes tap wobble and lift-off hooks; 12 px near-miss touch pick hits rakes/Gubba/basket (excluding stones) and 8 px slop hits HUD/menu; bed-frame rim touches start strokes; stone taps keep grab offset with drag slop; touch stone placement shows speech prompt; Android `navigator.vibrate` patterns and iOS hidden switch fallback fire only on touch gestures, never steal focus or bubble, and stay silent for mouse and under `prefers-reduced-motion` |
| Autonomous Gubba (`tests/e2e/auto-rake.spec.ts`) | `Gubba mode` (`R` or Presets chip) moves Gubba off his cushion onto the sand with `paletteViolations() === 0`, draw calls ≤ 60, zero haptics, and untouched undo stack; completes cycle to golden (`lastSealDiffCells ≤ 64`) and loops to a second distinct preset while `localStorage` retains the pre-run garden; real mouse drag yields and turns mode off with clean undo restoration; tapping Gubba speaks without interrupting; `Z` restores pre-run garden; clicking a preset re-plans cleanly; one-shot `Watch: Gubba rakes` builds once and stays seated; reduced motion converges while seated; all three variants (`moss`, `kasa`, `lantern`) stay palette-clean and never move the camera |

### 10.4 CI and deploy

- `ci.yml` on pull requests and pushes: `npm ci`, then the `verify` steps in order, then Playwright with software WebGL in four named steps: the core suite (`tests/e2e/garden.spec.ts`), popular-viewport responsiveness (`npm run test:e2e:viewports`), mobile & touch controls (`npm run test:e2e:touch`), and autonomous Gubba mode (`npm run test:e2e:auto`), uploading viewport and Gubba mode screenshots as an artifact. `npm run test:e2e`, and so `npm run verify`, runs all four.
- `deploy.yml` on pushes to `main`, after CI: build with `BASE_PATH=/gubbas-porch/`, `actions/upload-pages-artifact`, `actions/deploy-pages`.

---

## 11. Build order

A shared contract lands first; after that the lanes do not share files.

| Step | Scope | Owner lane |
|---|---|---|
| M0 | Vite and CI scaffold, `src/state/types.ts`, `assets/models.spec.json`, `assets/ramps.json`, palette table, placeholder models, test hooks | Shell |
| M1 | Grid, stamp, flow, deflection, rake table, stroke engine, undo, serialisation, presets, with all of 10.2 for those areas | Core (`sand`, `rakes`, `state`) |
| M1 | Render targets, the five passes, GLSL, palette textures, `toneFor`, export | Pipeline (`render/pipeline`) |
| M1 | Model loading and placement, sand mesh and shader, held rake, camera rig, particles, overlay | Scene (`render/scene`, `camera`, `overlay`) |
| M1 | Composer, scheduler, voices, foley, ambience, mix | Audio |
| M1 | Input, picking, basket, menu, DOM mirror, Gubba state machine, pose, lines, breath clock | UI and Gubba |
| M1 | Blender scripts, exports, manifest, verifier, real models replacing placeholders | Assets |
| M2 | Integration, visual baselines, performance pass, deploy | Shell |

---

## 12. Agreed Decisions

All decisions confirmed by the user on 2026-11-24:

| # | Decision | Agreed |
|---|---|---|
| D1 | **Gubba's appearance** | **All three variants (A Moss Yabba, B Kasa Yabba, C Lantern Yabba) built in Blender and swappable live in the Settings tab** (default: A Moss Yabba). |
| D2 | **Homage line** | Lounging-slug silhouette homage only (no name, colouring, slit eyes, hookah, or film lines). |
| D3 | **Moods** | **Auto-follow local clock OR manual swap in the Settings tab** (and HUD mood lantern); Warm Cedar Afternoon tuned first. |
| D4 | **Hosting** | **GitHub Pages** at `https://zeapsu.github.io/gubbas-porch/` from the public `zeapsu/gubbas-porch` repo on `main` (renamed from `zeapsu/rake-me` on 2026-11-24). |
| D5 | **Rake roster and access** | All 10 tools + stone basket available from the start; story seals are the only collectible. |
| D6 | **Pixel density** | **Crisp** (~205 rows) by default, with **Chunky** (~137 rows) toggle in Settings. |
| D7 | **Camera** | **Cozy 3/4** by default, with Top-Down and Gubba Porch presets + limited free orbit. |
| D8 | **Portrait phones** | **Landscape only on upright phones**: a window narrower than 600 px and more than 1.15× taller than wide shows a parchment "turn sideways" dialog and the garden waits behind it (2.4). Revised 2026-11-24 from "pull the camera back until the bed fits + subtle landscape hint", which left Gubba and the rakes off screen or a few pixels wide. Every other window, tablets held upright included, frames the whole garden. |
| D9 | **Flow and deflection round stones** | Both on by default; Flow toggleable in Settings. |
| D10–D12 | **Audio, Gubba talk, Breath guide** | Title card unlocks audio (8 s fade-in, continues in background tab); Gubba "Now and then" (≤ 1 line / 90 s); Breath guide off at first load (4-4-6). |
| D13 | **Three.js and WebGL2** | **Three.js** (sole runtime dependency) + WebGL2, matching the visual fidelity of the 3D 8-bit mockups (`paletteViolations() === 0`). |
