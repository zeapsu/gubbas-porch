# Agent Instructions (`AGENTS.md`)

Short operational guide for all coding, design, asset, and review agents working in `gubbas-porch` (Gubba's Porch).
Read [DESIGN.md](./DESIGN.md) for product/architecture truth and [REVIEW.md](./REVIEW.md) for review standards before making changes.

## 1. Project Snapshot

- **What this is**: *Gubba's Porch* — a serene, zero-stress **3D 8-bit Zen garden** for the browser with real 3D sand raking, a 3D Wall of Rakes, a silly/funky 3D caretaker named Gubba, and procedural retro Web Audio.
- **Stack**: TypeScript (strict), Vite, **Three.js** (WebGL2, sole runtime dependency), Web Audio API, Vitest + fast-check, Playwright, ESLint.
- **Assets**: Procedural low-poly 3D `.glb` models authored via Python `bpy` scripts in `scripts/blender/` using the Blender MCP (Blender 5.3.0), committed under `public/assets/models/`, governed by `assets/models.spec.json` and `public/assets/manifest.json`.
- **Hosting**: Static bundle deployed to GitHub Pages (`BASE_PATH=/gubbas-porch/`); must also build cleanly for `BASE_PATH=/`.

## 2. Core Non-Negotiables

1. **Pure relaxation**: Never add timers, scores, fail states, unlock gates, pop-ups, tutorials, analytics, or external network requests after initial load.
2. **True 3D 8-bit**: Every rendered frame pixel must belong to the active mood's 32-colour palette (`paletteViolations() === 0`), integer-scaled with `NearestFilter`, no MSAA, no alpha blending/bloom.
3. **Strict module boundaries** (enforced by ESLint `no-restricted-imports`):
   - `src/sand/` imports nothing.
   - `src/rakes/` imports only `sand`.
   - `src/state/` imports only `sand`, `rakes`.
   - `src/gubba/` imports only `state` (types).
   - `src/audio/` imports only `state` (types) and `rakes` (telemetry types).
   - `src/render/` imports `sand`, `rakes`, `state`, `gubba`, and `three`.
   - `src/ui/` imports all above **except** `three`.
   - `three` is imported ONLY inside `src/render/**` and `src/main.ts`.
   - Pure modules (`sand`, `rakes`, `gubba`, `audio/composer.ts`, camera math) never read `window`, `document`, wall-clock time, or `Math.random`.
4. **Blender MCP hygiene**:
   - Scripts in `scripts/blender/` must create and use ONLY scene `RM_Build` and datablocks prefixed `RM_`.
   - Never call `read_factory_settings` in live Blender; never touch user scenes.
   - Look up shader nodes by `type` (never localized `name`) and inspect exporter enums dynamically.
   - Every rake's 3D tines are generated from the exact same profile array as its sand stamp.
   - Inspect new/changed models visually with Blender `look` and verify budgets with `npm run verify:assets`.
5. **Budgets**: JS ≤ 300 KB gzipped, all 30 `.glb` models combined ≤ 550 KB and ≤ 19,000 triangles (only one Gubba variant active in scene at a time), ≤ 60 draw calls, zero per-frame allocations in hot loops.

## 3. Verification & Review Gate Workflow

Every change must pass local verification AND a fresh-context review before opening/merging a PR:

1. **Run the full verification suite** (show actual command output; never claim pass without running):
   ```bash
   npm run verify
   ```
   Which runs: `typecheck` → `lint` → `verify:assets` → `test:unit` → `build` (`BASE_PATH=/gubbas-porch/` and `/`) → `check:bundle` → `test:e2e`.
2. **Run the CI review gate locally**:
   ```bash
   node .github/scripts/review-gate.mjs
   ```
3. **Pre-PR fresh-context review against [REVIEW.md](./REVIEW.md)**:
   - Every **Medium** or **High** risk change requires a read-only review from a fresh context (and a different model family than the author's) following [REVIEW.md](./REVIEW.md).
   - Every finding requires `path:line` evidence and severity (`Important` / `Nit` / `Pre-existing`).
   - All `Important` findings must be fixed or resolved with rationale before merge.
   - Respect the convergence rules in `REVIEW.md`: round cap 3, diff-only re-reviews after round 1, flag classes once.
4. **PR hygiene**:
   - Fill out `.github/pull_request_template.md` completely (`Summary`, `Risk Tier`, `Testing`, `How to Revert`).
   - High-risk paths (`.github/workflows/**`, `.github/scripts/**`, `REVIEW.md`, `AGENTS.md`, deploy/security configs) always require explicit human approval.
   - Keep commits small, focused, and easy to revert, with clear subject + body explaining what changed and why.

## 4. Key Files Map

| Path | Role |
| --- | --- |
| [DESIGN.md](./DESIGN.md) | Canonical 3D 8-bit architecture, palettes, rakes, Gubba, audio, Blender spec, and test contracts |
| [REVIEW.md](./REVIEW.md) | Code review contract, domain failure modes, risk tiers, security pass, and convergence rules |
| [.github/workflows/ci.yml](./.github/workflows/ci.yml) | Blocking CI pipeline including `review-gate`, static/unit checks, and Playwright E2E |
| [.github/scripts/review-gate.mjs](./.github/scripts/review-gate.mjs) | Deterministic CI enforcement of `REVIEW.md` |
| [.github/dependabot.yml](./.github/dependabot.yml) | Automated weekly dependency & GitHub Actions version bumps |
| `assets/models.spec.json` | Single source of truth for all 30 `.glb` models, bounds, required nodes, and budgets |
| `assets/ramps.json` | Shared ramp-to-palette-slot table used by Blender scripts, shaders, and tests |
