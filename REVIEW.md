# Code Review Guide (`REVIEW.md`)

Modeled on Anthropic's multi-layered code review architecture ("How the Claude Code team does code review", `claude.dev/blog/solving-code-review-at-anthropic`).
Referenced by [AGENTS.md](./AGENTS.md) and enforced by the `review-gate` job in [.github/workflows/ci.yml](./.github/workflows/ci.yml).

## 1. Purpose & Principles

Code review here optimizes for two goals: **catching real bugs first** and **converging in minimal rounds second**.
Linters, typechecks, tests, and asset/bundle verifiers own style and mechanical invariants. Reviewers focus on correctness, architecture fit, security, and protecting the calm 3D 8-bit experience defined in [DESIGN.md](./DESIGN.md).

- **File-and-line evidence required**: Every finding MUST cite an exact `path:line` and concrete failure mechanism. Never guess from symbol names.
- **Drop style nits**: Linters and TypeScript own formatting and naming cosmetics.
- **Keep docs honest**: Flag code that violates `AGENTS.md` / `DESIGN.md` invariants, or changes that leave `AGENTS.md` or `REVIEW.md` stale.
- **Fix repeated comments at the source**: If a defect class appears twice, add a lint rule, unit/property test, or update `AGENTS.md` / `REVIEW.md`.

## 2. What Failure Looks Like in `gubbas-porch`

| Area | What failure looks like |
| --- | --- |
| **Sand & rakes (`src/sand/**`, `src/rakes/**`)** | Dotted/gapped strokes on fast pointer drags, non-deterministic or frame-rate-dependent carving, `NaN`/out-of-bounds grid writes, grooves mutating `rock !== 0` cells, broken flow/deflection around stones, `halfWidth > 2 * L`, or rake profile disagreeing with `assets/models.spec.json` tine counts. |
| **3D 8-bit pipeline (`src/render/**`)** | Off-palette pixels (`paletteViolations() > 0`), MSAA/linear color filtering/alpha blending/bloom sneaking in, non-integer canvas scaling, WebGL resource leaks (missing `.dispose()` on targets/geometries/materials/textures), per-frame allocations in hot loops, > 60 draw calls, camera moving while a rake stroke is active, or a hero object (bed, hanging rake, Gubba, stone basket) or an overlay control leaving the framebuffer in any popular viewport (`tests/e2e/viewports.spec.ts`). |
| **Gubba & Zen UX (`src/gubba/**`, `src/ui/**`)** | Anything stressful or intrusive: timers, scores, pop-ups, tutorials, text covering the sand, Gubba speaking more often than 90 s in "Now and then" or speaking in "Quiet", lines > 96 chars or > 3 wrapped lines, or missing accessible DOM mirror / `aria-live` updates. |
| **Audio (`src/audio/**`)** | Creating `AudioContext` before user gesture, step gain changes without ramps (clicks/pops), oscillators without scheduled `stop()` + disconnect on `ended`, mute failing to zero master gain, or non-pure `composer.events`. |
| **Blender asset pipeline (`scripts/blender/**`, `assets/**`, `public/assets/**`)** | Modifying non-`RM_` scenes/datablocks or calling `read_factory_settings` in live Blender, hardcoded localized shader node names instead of node `type`, hardcoded exporter enums, missing/corrupt `.glb` files, or exceeding triangle/byte budgets in `assets/models.spec.json`. |
| **Module boundaries & state (`src/state/**`, imports)** | `three` imported outside `src/render/**` or `src/main.ts`; `window`/`document`/`Date`/`Math.random` inside pure modules (`sand`, `rakes`, `gubba`, `audio/composer.ts`, camera math); `decode()` throwing on corrupt `localStorage` data. |
| **CI, deploy & security (`.github/**`, config)** | Broken `BASE_PATH` (`/gubbas-porch/` vs `/`) causing 404 assets on GitHub Pages, external network calls after initial load, `eval`/`new Function`/`innerHTML`, leaked secrets, over-privileged GitHub Actions tokens, or weakened review/CI gates. |

## 3. Paths to Skip

Skip mechanical or binary files unless their automated verifier fails:
- `package-lock.json` (review `package.json` and audit output instead)
- `dist/**`, `coverage/**`, `playwright-report/**`, `test-results/**`
- Raw binary `public/assets/models/**/*.glb` (verify via `npm run verify:assets`, `assets/models.spec.json`, `public/assets/manifest.json`, and visual renders)
- `assets/preview/**`

## 4. Finding Classification & Required Summary Format

Every review MUST begin with a structured count header, and state plainly **`Nothing to fix.`** when `Important: 0`:

```markdown
Review Summary — Important: <N> | Nit: <M> | Pre-existing: <K>
Risk Tier: <Low | Medium | High>
Verdict: <PASS | CHANGES_REQUESTED>
```

Tag every finding with exactly one severity:
- **`Important`** *(blocks merge)*: Real bug, crash, broken invariant, security issue, regression against `DESIGN.md`, or missing test for a critical contract.
- **`Nit`** *(non-blocking, **max 2 per review**)*: Minor clarity or edge-case note. Never trigger another review round for nits alone.
- **`Pre-existing`** *(non-blocking)*: Defect already present before the diff. Report without blaming the PR author.

Every `Important` finding must be fixed in a new commit or resolved with a written rationale before merge.

## 5. Security Pass (Blocking)

Every PR gets an explicit security check. Any open finding is `Important` and blocks merge:
- No `eval`, `new Function`, or unsanitized `innerHTML` / `outerHTML` / `document.write`.
- No committed tokens, API keys, or credentials.
- No unexpected outbound network requests or external CDN URLs at runtime.
- GitHub Actions workflows declare minimal `permissions:`, avoid `${{ github.event.* }}` shell interpolation, and use trusted versions.

## 6. Convergence Rules

To prevent endless agent-author / agent-reviewer loops:
1. **Round cap = 3**: After 3 review rounds on one PR, stop incremental review and ask the author to step back and reconsider the approach.
2. **Diff-only re-review**: Round 1 reviews the full PR diff against the repo and intent. Rounds 2–3 inspect **only commits added since the previous round**.
3. **Flag the class once**: Report repeated defect patterns as a single class finding with representative `path:line` examples so all instances are fixed together.
4. **No repeats**: Never re-raise findings already posted or resolved with a rationale.

## 7. Risk Tiers & Approval Policy

The **change** sets the tier, never the author. The only path to merge without the gates below is the narrow Dependabot carve-out in [Section 8](#8-ci-review-gate-contract) (green semver-minor/patch bumps of non-runtime dependencies and GitHub Actions); it changes who may merge, not the tier.

| Tier | Changed paths / scope | Required gates |
| --- | --- | --- |
| **Low** | Docs (`README.md`, `DESIGN.md` prose, `docs/mockups/**`), Gubba dialogue lines, palette tweaks, additive tests. | Required CI + `review-gate` (`Important: 0`). |
| **Medium** | Runtime modules (`src/**`), Blender scripts (`scripts/blender/**`), `assets/models.spec.json`, `assets/ramps.json`, `public/assets/**`. | Required CI + Fresh-context cross-model review against `REVIEW.md` (`Important: 0`, security pass clean) + `review-gate`. |
| **High** | `.github/workflows/**`, `.github/scripts/**`, `REVIEW.md`, `AGENTS.md`, deployment/hosting config, security-sensitive changes, major dependency upgrades. | Required CI + Cross-model review (`Important: 0`) + **Explicit human approval**. Bot/agent approvals never satisfy human approval. New commits invalidate prior approvals. Sole exception: the Section 8 Dependabot carve-out for green minor/patch non-runtime bumps. |

## 8. CI Review Gate Contract

The `review-gate` job in [.github/workflows/ci.yml](./.github/workflows/ci.yml) executes `.github/scripts/review-gate.mjs` on every PR and push:
1. Verifies `REVIEW.md` and `AGENTS.md` exist and `AGENTS.md` explicitly references `REVIEW.md`.
2. On pull requests, verifies the PR body includes **Risk Tier**, **Testing**, and **How to Revert** (matching `.github/pull_request_template.md`).
3. Computes the minimum required risk tier from the PR's changed files and fails if the PR under-declares its tier.
4. Runs deterministic static security hygiene checks (forbids `eval`/`new Function`/`innerHTML`, checks secret patterns, checks workflow `permissions:` and `${{ github.event.* }}` interpolation).
5. Medium and High risk changes additionally require a fresh-context, cross-model read-only review against this document prior to merge (logged in PR summary or review comments), with all `Important` findings resolved.

**Dependabot PR-body exception.** A PR opened by `dependabot[bot]` whose changed files are all `package.json`, `package-lock.json`, or `.github/workflows/*.yml` / `.yaml` skips only the PR-body checks (items 2–3), because the bot cannot fill in the template. Governance (item 1), security hygiene (item 4), and the rest of CI still run on it. A Dependabot PR that touches any other path, or whose diff is empty or cannot be computed, gets no exception.

**Dependabot auto-merge carve-out.** `.github/workflows/dependabot-auto.yml` runs after the `CI` workflow completes on such a PR and squash-merges it without the Section 7 cross-model review and human approval only when `.github/scripts/dependabot-auto-merge.mjs` confirms all of:
- The PR is open, not a draft, targets `main` from this repository, was opened by `dependabot[bot]`, and its head is still the commit CI ran on.
- Every commit is a GitHub-signed `dependabot[bot]` commit, and every commit on its own carries Dependabot update metadata listing only semver-minor or semver-patch updates.
- No update is a runtime dependency: `three`, or anything in the `prod-dependencies` group.
- All three CI jobs of the triggering CI run completed successfully on the head commit.
- The commit, file, and job listings read from the GitHub API are complete (their counts match).

The merge is immediate and pinned to the verified head commit (`gh pr merge --squash --match-head-commit`). GitHub's deferred auto-merge is never enabled, so a later commit on the PR (for example a major bump added to a `vite-vitest` PR) is only merged after its own CI run and a fresh evaluation.

The merge uses `GITHUB_TOKEN`, and GitHub starts no workflows for events caused by that token: an auto-merged commit gets no post-merge `push` CI run and no `Deploy to GitHub Pages` run. That is acceptable for dev-dependency and GitHub Actions bumps, which change no shipped runtime code; the site keeps serving the previous build until the next human push to `main`. It is not acceptable for the runtime bundle, which is why `three` (0.x, where minor releases carry breaking changes) is excluded and goes through human review and the normal CI and deploy path.

Major upgrades, runtime dependency bumps, and anything the script cannot verify are never auto-merged and keep the High-tier gates in Section 7 (cross-model review and explicit human approval).

## 9. Feedback Loop (Incidents Become Evals)

When any bug slips past review or causes a revert:
1. Add a regression test in `tests/unit/` or `tests/e2e/` covering the exact defect.
2. Add the failure class to Section 2 of this file (or a lint rule) so round 1 catches it permanently.
