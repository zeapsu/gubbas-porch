## Summary

<!-- What changed and why? Link DESIGN.md section or issue if applicable. -->

## Risk Tier

<!-- Set from the change, not the author (see REVIEW.md). Check one: -->
- [ ] **Low** — Docs, copy, palettes, Gubba dialogue, additive tests
- [ ] **Medium** — App logic (`src/**`), Blender asset scripts (`scripts/blender/**`), UI/audio/sand behavior
- [ ] **High** — CI/workflows (`.github/workflows/**`), `REVIEW.md`, `AGENTS.md`, deployment, security, or major dependency upgrades

## Testing

<!-- Exact commands run and observed output (do not claim passing without running). -->
- [ ] `npm run check` (typecheck, lint, format, asset manifest, unit tests, production build)
- [ ] `npm run test:e2e` (headless browser verification)
- [ ] Fresh-context pre-PR review completed against `REVIEW.md`

## How to Revert

<!-- Single commit revert command or feature-flag/asset rollback steps. -->
`git revert <merge-sha>`
