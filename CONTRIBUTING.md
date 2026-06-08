# Contributing

This file is intentionally short.

The main docs in this repo are written for people installing and using Flow
Agents. This file is the footnote for people developing the product itself.

## Development Rules

- keep the core product generic — no machine-specific paths, usernames, or
  private workspace assumptions in tracked source
- the public bundle ships the `core` and `development` packs; keep new work
  inside that scope
- prefer install/use clarity over maintainer cleverness
- update the relevant docs, `packaging/packs.json`, and `packaging/manifest.json`
  whenever you add or remove a skill, agent, or power
- keep `docs/context-map.md` current with `npm run context-map`
- run `npm run build && npm run validate:source && bash evals/ci/run-baseline.sh`
  before opening a PR

## Validation

- `npm run validate:source` — source-tree integrity (paths, packs, manifests)
- `npm run context-map:check` — context map is current
- `bash evals/ci/run-baseline.sh` — deterministic CI baseline
- `npm run check:content-boundary` — no private/internal content leaks

All projects are Apache-2.0.
