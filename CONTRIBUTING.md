# Contributing

This file is intentionally short.

The main docs in this repo are written for people installing and using Flow
Agents. This file is the footnote for people developing the product itself.

## Development Rules

- keep the core product generic — no machine-specific paths, usernames, or
  private workspace assumptions in tracked source
- the public bundle ships the full standalone base (skills, agents, powers) plus
  the Flow Kits; keep new work inside that scope
- prefer install/use clarity over maintainer cleverness
- update the relevant docs, `kits/catalog.json`, and `packaging/manifest.json`
  whenever you add or remove a skill, agent, power, or kit
- keep `docs/context-map.md` current with `npm run context-map`
- run `npm run build && npm run validate:source && bash evals/ci/run-baseline.sh`
  before opening a PR

## Docs Site Preview

The GitHub Pages site is built from `docs/` by the `Publish Docs` workflow
using Jekyll. To preview locally, install Jekyll 3.9 with the github-pages
default plugins and build into the ignored `_site/` directory:

```bash
gem install --user-install jekyll -v 3.9.5 jekyll-optional-front-matter \
  jekyll-relative-links jekyll-readme-index jekyll-titles-from-headings \
  kramdown-parser-gfm
"$(ruby -e 'print Gem.user_dir')/bin/jekyll" build --source docs --destination _site
```

Set `FLOW_CLI_ROOT` to a Flow checkout or installed `@kontourai/flow` package
root to enable full Flow Definition validation in `npm run validate:source`.

## Releases

Releases are automated with release-please: merges to main accumulate into a release PR, and merging it tags the version and dispatches the npm publish workflow. Use conventional commit prefixes (feat:, fix:, docs:, chore:) so version inference works.

## Validation

- `npm run validate:source` — source-tree integrity (paths, packs, manifests)
- `npm run context-map:check` — context map is current
- `bash evals/ci/run-baseline.sh` — deterministic CI baseline
- `npm run check:content-boundary` — no private/internal content leaks

## Runtime integrations must be live-validated

Static and integration evals that only assert "the artifact exists / parses as
JSON / the helper script runs" are **not sufficient** for generated host
artifacts. During the 0.3.0 program, six defects shipped green across 113+
assertions and were caught only by executing the artifact in (or as) its real
host. A new runtime integration MUST ship:

1. **Parse-gates** for every generated artifact, in its host language (e.g.
   `node --check` for a JS plugin, `tsc` syntax check for a TS extension) — a
   file that doesn't parse in its host helps no one, no matter how valid its
   JSON wrapper is.
2. **A mechanical hook-chain execution test** — actually run the generated
   hook/plugin handlers with realistic payloads and assert the downstream
   effects (telemetry written, policy decision returned), not just that the
   files are wired.
3. **A binary-gated live acceptance harness** — install into a temp workspace,
   run the real host binary if present (skip cleanly if not), and assert
   observable behavior end-to-end. See `evals/acceptance/test_opencode_harness.sh`,
   `test_pi_harness.sh`, and `test_knowledge_kit_live.sh` for the pattern.

Integration tests must also be wired into a CI lane in `evals/ci/run-baseline.sh`
(and a matching `--check` step in `.github/workflows/ci.yml`) — a test that
runs via the `evals/run.sh` glob but is absent from the curated CI lanes gates
nothing. Tests that create temp dirs must canonicalize them (`pwd -P`) so
macOS (`/tmp` → `/private/tmp`) and Linux behave identically.

Adapters SHOULD also document fail-open vs fail-closed per policy class. See
`docs/spec/runtime-hook-surface.md`.

All projects are Apache-2.0.
