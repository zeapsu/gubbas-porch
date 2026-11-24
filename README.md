<img src="assets/icon.svg" width="64" height="64" alt="Rake Me icon">

# Rake Me

A quiet, zero-stress **3D 8-bit Zen garden** for the browser — real 3D heightmap sand raking, a 3D Wall of Rakes, three swappable silly/funky 3D Gubba caretakers, procedural retro Web Audio, and four time-of-day moods.

**Live garden:** [https://zeapsu.github.io/rake-me/](https://zeapsu.github.io/rake-me/)

## Features

- **True 3D 8-bit rendering (Three.js + WebGL2):** low-resolution integer-scaled G-buffer resolved strictly to a 32-colour mood palette (`paletteViolations() === 0`) with stepped cel shading, Bayer 4×4 dithering, hard shadows, 1-pixel outlines, and Crisp / Chunky pixel density toggles.
- **Tactile 3D sand & Wall of Rakes:** 192×112 heightmap-displaced sand bed with continuous arc-length stroke stamping, stone deflection & potential flow, 10 Blender-built tools (`Sugi`, `Ōnami`, `Kinu`, `Hisui`, `Mikazuki`, `Tetsu`, `Wa`, `Take`, `Nagi`, `Hōki`), stone basket placement/drag/removal, 32-step undo/redo, 7 presets (instant or *Watch Gubba rake*), local persistence, and crisp PNG export.
- **Gubba (swappable in Settings):** swap live between **Moss Yabba**, **Kasa Yabba**, and **Lantern Yabba** (all three built procedurally in Blender 5.3.0), animated deterministically on the breath clock with deadpan reflections and rake stories.
- **Retro Web Audio:** procedural pentatonic/Japanese-scale chiptune ambience (Yo, Hirajōshi, In), velocity- and tine-aware sand foley, bamboo shishi-odoshi, wind chimes, optional rain, and per-bus mix controls.

## Development & Verification

```bash
npm ci
npm run dev       # local dev server
npm run verify    # review-gate, typecheck, lint, verify:assets, 113 unit tests, dual BASE_PATH build, bundle check, Playwright E2E
```

### Blender 3D Asset Pipeline

All 30 `.glb` models under `public/assets/models/` are procedurally generated from `scripts/blender/`:

```bash
blender -b --factory-startup -P scripts/blender/build_all.py
npx tsx scripts/update-manifest.ts
npm run verify:assets
```

## Documentation

- [DESIGN.md](./DESIGN.md) — canonical 3D 8-bit architecture, palettes, rakes, Gubba, audio, Blender spec, and test contracts.
- [AGENTS.md](./AGENTS.md) — operational guide, module boundaries, and verification workflow.
- [REVIEW.md](./REVIEW.md) — multi-layered code review contract enforced by CI.
