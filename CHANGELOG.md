# Changelog

## [0.3.0](https://github.com/kontourai/flow-agents/compare/v0.2.0...v0.3.0) (2026-06-12)


### Features

* **knowledge-kit:** concept synthesis with evidence-gated mutations (S3, [#34](https://github.com/kontourai/flow-agents/issues/34)) ([f307165](https://github.com/kontourai/flow-agents/commit/f30716503b22202d8929876b3e0b5d0d4bcbd2cb))
* **knowledge-kit:** decision-snapshot consolidation, supersede-not-delete (S6, [#36](https://github.com/kontourai/flow-agents/issues/36)) ([7211605](https://github.com/kontourai/flow-agents/commit/7211605fd19a0a332b7816c1fb0e66259771c3ba))
* **knowledge-kit:** ingest/classify + compile flows with provenance gates (S2, [#33](https://github.com/kontourai/flow-agents/issues/33)) ([07dffd5](https://github.com/kontourai/flow-agents/commit/07dffd5f6c6ab8555fc8c7e029d6432cd854dd05))
* **knowledge-kit:** keyless live example + acceptance harness (S5, [#35](https://github.com/kontourai/flow-agents/issues/35)) ([9a565aa](https://github.com/kontourai/flow-agents/commit/9a565aaa8deac236f07b63933bb8ce6887ac25f9))
* **knowledge-kit:** store contract + default reference adapter (S1, [#31](https://github.com/kontourai/flow-agents/issues/31)) ([4ed06ba](https://github.com/kontourai/flow-agents/commit/4ed06ba7cad7865094feddf0bd5ac7f76639b9ed))
* strands-local kit activation — framework-path kits (S4, [#32](https://github.com/kontourai/flow-agents/issues/32)) ([8dc05ec](https://github.com/kontourai/flow-agents/commit/8dc05ecf810dc3d205046c4773aa2c1e62159acb))


### Fixes

* dedup pi session.start; document opencode run-mode session.created gap ([4d7e5b1](https://github.com/kontourai/flow-agents/commit/4d7e5b1e2de6573b824852598b04a5da3485adf6))
* telemetry-doctor reported the workspace parent as the local sink dir ([e15d7b2](https://github.com/kontourai/flow-agents/commit/e15d7b2e922225e4c30a39fceea304ca01e5ac17))


### Documentation

* Flow Kits authoring guide, README kits section, npx command forms ([a89a86c](https://github.com/kontourai/flow-agents/commit/a89a86cc488abb7f6cd3cd300a67044174afa154))

## [0.2.0](https://github.com/kontourai/flow-agents/compare/v0.1.2...v0.2.0) (2026-06-11)


### Features

* engine contract 1.0, conformance kit, Strands rebind, integration docs ([fd94f58](https://github.com/kontourai/flow-agents/commit/fd94f583f52c874d901e06da0ee338830b3d469a))
* install lifecycle tests, dogfood command, collision marker fix ([a0fb2e3](https://github.com/kontourai/flow-agents/commit/a0fb2e31d897426db435801c8a637a9736d99ad1))
* live acceptance harnesses for opencode and pi ([181382b](https://github.com/kontourai/flow-agents/commit/181382b8dfe05cce41c0471a030e7d795950cd09))
* Strands TypeScript adapter — first native-import engine consumer ([0f387ab](https://github.com/kontourai/flow-agents/commit/0f387ab8e5a8b7f65e511af2fc33340f51e2d047))
* weekly runtime/SDK compatibility canary + dependabot ([9a371b1](https://github.com/kontourai/flow-agents/commit/9a371b1af86394fe1f7febebe3a35d3f05321f8e))


### Fixes

* opencode.json — emit schema-valid config (instructions must be array) ([35a01ec](https://github.com/kontourai/flow-agents/commit/35a01ec508b2f99d4a7bca854e5f09740bac4fb3))
* opencode/pi hook chain — node resolution, stdin payloads, telemetry escape ([be4e4f8](https://github.com/kontourai/flow-agents/commit/be4e4f8d3b81fc7b67d6e45f4c9c1515407268a7))
* pi extension template escaping; parse-gate generated hook artifacts ([6fe40c5](https://github.com/kontourai/flow-agents/commit/6fe40c5079b8ee89a58c4dfecd6df2992c46cf59))


### Documentation

* roadmap rows reflect the shipped utterance evidence-check hook ([#24](https://github.com/kontourai/flow-agents/issues/24)) ([617c755](https://github.com/kontourai/flow-agents/commit/617c75567b692c02564f457577d1ab3c01c1ea8e))

## 0.1.2

- Source validation resolves the Flow CLI at `dist/cli.js` (with a
  `src/cli.js` fallback), and the source-and-static CI lane installs
  `@kontourai/flow` so kit Flow Definitions are validated by the real
  Flow CLI.
- The publish workflow builds the bundle explicitly before `npm publish`.
- Docs routing between the System Guidebook and the Workflow Usage Guide;
  duplicated development walkthrough removed.
- README and Pages home advertise the npm install with the version badge;
  pre-release caveats removed; Kontour family table links product pages
  and gains a Survey row.
- Fixes phantom skill references, a stale pack list, and path accuracy in
  the docs.

## 0.1.1

### Documentation And Site

- Rewrote the README and GitHub Pages home with a verified install path
  (checkout-based; npm publishing is on the roadmap), the Kontour product-line
  story, and cross-links to the Kontour Flow documentation.
- Rebranded the docs site to the shared Kontour design tokens: Fraunces,
  Hanken Grotesk, and IBM Plex Mono, the Flow teal accent, light/dark themes,
  a version badge, OG/social meta tags, and a favicon.
- Fixed mobile navigation: the rail is now an accessible slide-over drawer
  instead of disappearing below 860px.
- Added frontmatter to fourteen docs (including the workflow usage guide,
  skills map, and all ADRs) so Jekyll renders them as pages instead of copying
  raw Markdown, and enabled the github-pages default plugins locally for
  build parity.
- Merged the evidence reference migration note into `docs/migrations.md`,
  merged the roadmap into `docs/north-star.md`, and retired
  `docs/release-notes.md` in favor of this changelog.

### Packaging And Cross-Product Validation

- Made the package publishable: removed the `private` flag, added the license
  and public `publishConfig`, a `prepack` validation lane, and a tag-triggered
  `Publish NPM` workflow using npm trusted publishing, mirroring the Flow
  release pipeline.
- Fixed Flow CLI integration in source validation: `FLOW_CLI_ROOT` now resolves
  the compiled `dist/cli.js` (with a `src/cli.js` fallback), and the
  source-and-static CI lane installs `@kontourai/flow` so kit Flow Definitions
  are validated by the real Flow CLI in CI.
- Removed the broken `build-docs-preview` tool and its wrapper, bin, and script
  entries; local docs preview is now documented in CONTRIBUTING.md using the
  same Jekyll setup as the Pages workflow.

### Repository Cleanup

- Consolidated TypeScript tooling source under `src/tools/` and kept
  `scripts/` as the public wrapper/runtime surface.
- Documented repository structure, generated-output boundaries, runtime hook
  boundaries, and safe cleanup rules.
- Removed stale local runtime artifacts and corrected package metadata drift.

### Codex Runtime Hooks

- Reinstalled Codex into an isolated Flow Agents home and fixed generated
  Codex hook commands to prefer `CODEX_HOME`.
- Documented the stale repo-local `.codex/hooks.json` failure mode that caused
  Codex `PostToolUse` to reject Claude-only `suppressOutput` output.

### CI And Release Readiness

- Enabled permanent TypeScript unused-code enforcement with `noUnusedLocals`
  and `noUnusedParameters`.
- Made the Node runtime policy explicit: package metadata requires Node `>=22`,
  CI runs Node 22, and `@types/node` stays on the Node 22 major line until
  runtime policy changes.
- SHA-pinned GitHub Actions with version comments, including dereferencing the
  annotated `actions/checkout@v6.0.3` tag to its commit SHA.
- Split Flow Agents CI into independent source/static, workflow-contract, and
  runtime/kit lanes with separate evidence artifacts.
- Preserved fail-closed CI evidence finalization: failed, missing, duplicate,
  or invalid check rows fail the corresponding CI lane.
- Verified the npm lockfile with a clean audit and updated `promptfoo` to
  `0.121.15`.
