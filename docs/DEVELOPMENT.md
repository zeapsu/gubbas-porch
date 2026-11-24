# Development & Architecture (`Gubba's Porch`)

Technical reference for building, testing, modeling, and verifying **Gubba's Porch** (`zeapsu/gubbas-porch`).
For canonical product and architecture truth see [DESIGN.md](../DESIGN.md); for agent rules see [AGENTS.md](../AGENTS.md); for code review standards see [REVIEW.md](../REVIEW.md).

## Stack & Budgets

- **Runtime:** TypeScript (strict), Vite, **Three.js** (WebGL2, sole runtime dependency), procedural Web Audio API (zero external audio files, zero post-load network requests).
- **3D 8-bit Pipeline:** Five-pass WebGL2 pipeline (1024² shadow map → low-res two-attachment G-buffer → 32-colour palette resolve with stepped cel shading, Bayer 4×4 dithering, hard shadows, and 1 px outlines → palette-indexed HUD/overlay → integer-scaled nearest-neighbour present). Every rendered frame satisfies `paletteViolations() === 0`.
- **Budgets (CI-enforced):**
  - JS bundle ≤ **300 KB** gzipped
  - 30 procedural `.glb` models combined ≤ **550 KB** and ≤ **19,000** triangles
  - Total first load ≤ **950 KB**
  - ≤ **60** draw calls per frame, zero per-frame allocations in hot loops

## Local Commands

```bash
npm ci
npm run dev                  # Local Vite dev server
npm run verify               # Full local gate: review-gate, typecheck, lint, verify:assets,
                             # unit tests, dual BASE_PATH builds, bundle check, Playwright E2E
npm run test:unit            # Vitest unit & fast-check property tests
npm run test:e2e             # Full Playwright Chromium (software WebGL) E2E suite
npm run test:e2e:viewports   # Popular-viewport responsiveness suite (1920×1080 down to phones)
npm run test:e2e:touch       # Mobile & touch gesture suite (hold-to-preview, haptics, pinch/orbit, stones)
npm run review:gate          # Deterministic REVIEW.md gate check
```

### Dual `BASE_PATH` Builds

Every asset URL resolves through `import.meta.env.BASE_URL` so the static bundle works both on GitHub Pages and at a domain root:

```bash
BASE_PATH=/gubbas-porch/ npm run build && npm run check:bundle
BASE_PATH=/ npm run build
```

## Module Boundaries

Enforced via ESLint `no-restricted-imports`:

- `src/sand/` — pure 192×112 heightmap & dirty-rect engine (imports nothing)
- `src/rakes/` — 10 tool profiles, tractrix stroke resampling, rock deflection & potential flow (imports `sand`)
- `src/state/` — garden store, 32-step undo/redo, RLE codec, 7 deterministic presets (imports `sand`, `rakes`)
- `src/gubba/` — breath clock, deadpan reflections/stories, deterministic caretaker state & pose (imports `state` types)
- `src/audio/` — pure pentatonic/Japanese-scale composer, voice synth, sand foley & ambience (imports `state`/`rakes` types)
- `src/render/` — WebGL2 8-bit pipeline, hero-framing camera rig, merged 3D scene, bitmap overlay (sole owner of `three` alongside `src/main.ts`)
- `src/ui/` — keyboard/pointer bindings, viewport rules, accessible DOM mirror (`#sr-controls`, `#sr-live`) (never imports `three`)

Pure modules (`sand`, `rakes`, `gubba`, `audio/composer.ts`, `render/camera/rig.ts`) never read `window`, `document`, wall-clock time, or `Math.random`.

## Blender 3D Asset Pipeline

All 30 `.glb` models under `public/assets/models/` (10 rakes, 17 props, 3 Gubba variants: Moss, Kasa, Lantern) are procedurally constructed in Python `bpy` scripts under `scripts/blender/` and governed by `assets/models.spec.json` and `public/assets/manifest.json`. Every rake's 3D tines are generated from the exact same profile array as its sand stamp.

```bash
blender -b --factory-startup -P scripts/blender/build_all.py
npx tsx scripts/update-manifest.ts
npm run verify:assets
```

## CI, Review Gate & Deployment

- **CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)):** Blocking jobs for `Review Gate (REVIEW.md)`, `Static Checks, Assets, Unit Tests & Build`, and `Browser E2E & 8-Bit Visual Verification` (core garden suite + 11 popular-viewport checks from `1920×1080` down to phones, with screenshot artifacts).
- **Deploy ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)):** Automatically builds and deploys to GitHub Pages (`https://zeapsu.github.io/gubbas-porch/`) only after `CI` succeeds on `main`.
- **Dependencies ([.github/dependabot.yml](../.github/dependabot.yml)):** Weekly automated version bumps for npm and GitHub Actions.
