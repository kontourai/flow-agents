# Changelog

## [1.4.0](https://github.com/kontourai/flow-agents/compare/v1.3.0...v1.4.0) (2026-06-16)


### Features

* **#100:** require block reasons to reach the model ([#102](https://github.com/kontourai/flow-agents/issues/102)) ([5007c63](https://github.com/kontourai/flow-agents/commit/5007c63906aa78028477ffd2da31142ed4c3d0a8))
* **#99:** export the workflow sidecar writer/validator as a library ([#101](https://github.com/kontourai/flow-agents/issues/101)) ([5baa294](https://github.com/kontourai/flow-agents/commit/5baa294486b09e0e64a9fb5a029155c53775f477))

## [1.3.0](https://github.com/kontourai/flow-agents/compare/v1.2.0...v1.3.0) (2026-06-16)


### Features

* add kit TRUST axis to inspect output — orthogonal to K-levels (issue [#79](https://github.com/kontourai/flow-agents/issues/79)) ([2a353d1](https://github.com/kontourai/flow-agents/commit/2a353d17ffb1da8b0fc23f442f52aa0676a1fabe))
* add TRUST axis to kit inspect — orthogonal to K-level capability (issue [#79](https://github.com/kontourai/flow-agents/issues/79)) ([02ac699](https://github.com/kontourai/flow-agents/commit/02ac699227c4071c16c936c3e01e5fd013466baf))
* **knowledge:** rendered-body-as-storage in Obsidian adapter ([baef40f](https://github.com/kontourai/flow-agents/commit/baef40f46f4016ba8b6c8afd1c61b91cade1de12))
* **knowledge:** rendered-body-as-storage in Obsidian adapter ([0a31c32](https://github.com/kontourai/flow-agents/commit/0a31c3233ee8772b000cb42dbef0a3fdc38ccf1c))
* migrate gate evidence from surface.claim to Hachure trust.bundle ([#97](https://github.com/kontourai/flow-agents/issues/97)) ([8ed43c4](https://github.com/kontourai/flow-agents/commit/8ed43c46c2a6887d32cd850bc8b2d97e7829f825))


### Fixes

* **#74:** console-learning test cross-platform + un-quarantine; docs([#39](https://github.com/kontourai/flow-agents/issues/39)): live-validation rule ([89b2bdb](https://github.com/kontourai/flow-agents/commit/89b2bdb44f3fa5ea629135f7e93410eee92efb1c))
* **#74:** un-quarantine console-learning test — passes 12/12 on Linux CI ([#89](https://github.com/kontourai/flow-agents/issues/89)) ([371ecd2](https://github.com/kontourai/flow-agents/commit/371ecd22cbd8e80b6404cbdd2825d4a94fb6573c))
* **#75:** assert opencode plugin load via factory marker file ([#96](https://github.com/kontourai/flow-agents/issues/96)) ([6c09288](https://github.com/kontourai/flow-agents/commit/6c092883bc4b2fd5a893431991ab75921f8b080b))
* acceptance harnesses poll for all required telemetry events (canary flake [#75](https://github.com/kontourai/flow-agents/issues/75)) ([a27b4ff](https://github.com/kontourai/flow-agents/commit/a27b4ff48c88908419ef079c447d8a9930aa707a))
* acceptance harnesses skip (not fail) when no telemetry produced — no-provider CI ([d9cba18](https://github.com/kontourai/flow-agents/commit/d9cba180ebcec9005bcd0c7b29f2608530c8acc3))
* acceptance harnesses skip telemetry assertions when no provider (canary [#75](https://github.com/kontourai/flow-agents/issues/75)) ([dbd0e7b](https://github.com/kontourai/flow-agents/commit/dbd0e7b77444ed5df93fb47a59d2704460742367))
* acceptance harnesses wait for ALL required telemetry events, not just file existence ([d9c86c0](https://github.com/kontourai/flow-agents/commit/d9c86c0987d42ab1f6c5c411884bcf1912bd8fab))
* **ci:** pin @kontourai/flow to ~1.2.0 ([#95](https://github.com/kontourai/flow-agents/issues/95)) ([fd97803](https://github.com/kontourai/flow-agents/commit/fd97803c97ade926b1985c42b1693d8e9890f9f1))
* **knowledge:** collision-proof body delimiter in Obsidian adapter ([4e2560c](https://github.com/kontourai/flow-agents/commit/4e2560cec3b0b8c2660879d059ce29f0cc88184a))
* **stop-goal-fit:** invoke built validator directly; skip on env errors ([#92](https://github.com/kontourai/flow-agents/issues/92)) ([7b3d520](https://github.com/kontourai/flow-agents/commit/7b3d5208497f3cc8d4f8137d21f16408f9d2689e))

## [1.2.0](https://github.com/kontourai/flow-agents/compare/v1.1.0...v1.2.0) (2026-06-15)


### Features

* **#62:** move Builder Kit skills into kits/builder, add Knowledge Kit skill, remove orphans ([3822e07](https://github.com/kontourai/flow-agents/commit/3822e075e9cd488f46124179ebf9a8459825b9c6))
* **#62:** move Builder Kit skills into kits/builder, Knowledge Kit skill, remove orphans ([31f63ca](https://github.com/kontourai/flow-agents/commit/31f63ca18019d51438accd3b5f1e03cb5f2873f2))
* delegate container validation to @kontourai/flow; rename flow-kit → flow-agents kit ([d39e909](https://github.com/kontourai/flow-agents/commit/d39e9090dad220a8159d2148d5a1effb2460ac9f))
* delegate container validation to @kontourai/flow; rename flow-kit → flow-agents kit (ADR 0008) ([4343e84](https://github.com/kontourai/flow-agents/commit/4343e845a992858c9441258bedbbf3c7302a8532))


### Fixes

* **ci:** install repo deps before building bundles in runtime-compat canary ([#76](https://github.com/kontourai/flow-agents/issues/76)) ([f8947aa](https://github.com/kontourai/flow-agents/commit/f8947aab5723ba9325372ea4054458ce21875bee))
* lazy-load @kontourai/flow in validate.ts so list/status/activate work without it ([99beebb](https://github.com/kontourai/flow-agents/commit/99beebb58f02dba374b35ae5e3df229cb39ea8d0))


### Documentation

* add ADR 0007 flow/skill/kit/tool boundary + skill audit ([20b5c7b](https://github.com/kontourai/flow-agents/commit/20b5c7b272e7ad7985640e70b6be71733cec9995))
* add Builder Kit quick-start guide and update index/README Quick Start ([2e89bf0](https://github.com/kontourai/flow-agents/commit/2e89bf08968a6f45a26ceddcddf5a66bf77d3f44))
* ADR 0007 flow/skill/kit/tool boundary + skill audit ([a1dde52](https://github.com/kontourai/flow-agents/commit/a1dde52eb3b051a0eab5712395f0266c7428ae0f))
* Builder Kit quick-start guide (zero to gated build flow) ([83237f7](https://github.com/kontourai/flow-agents/commit/83237f77812917d49c86547db87986d6dbfdbfd9))
* fold orphan rulings into ADR 0007, add ADR 0008 kit-operation boundary ([d547edc](https://github.com/kontourai/flow-agents/commit/d547edc954ea9d9a12039003d41401802f994097))
* mark ADRs 0007 + 0008 Accepted (decisions reached in 2026-06-15 design conversation) ([3eb7636](https://github.com/kontourai/flow-agents/commit/3eb7636c1c4f866fd119195936ec856425573dda))

## [1.1.0](https://github.com/kontourai/flow-agents/compare/v1.0.1...v1.1.0) (2026-06-15)


### Features

* activate skills and docs in kit runtime adapters (fix [#58](https://github.com/kontourai/flow-agents/issues/58)) ([dc726fd](https://github.com/kontourai/flow-agents/commit/dc726fd1d56e79b5bda577985aa87befe3a1eb9d))
* activate skills and docs in kit runtime adapters (fix [#58](https://github.com/kontourai/flow-agents/issues/58)) ([dc774e0](https://github.com/kontourai/flow-agents/commit/dc774e001b54f7a09f6ab81a6aafcf2ad8552b6d))


### Fixes

* apply realpathSync entry-guard to 7 remaining CLI/tool files ([c1b3272](https://github.com/kontourai/flow-agents/commit/c1b3272c623055662a63c5d11c6dbef5aabe1cf0))
* apply realpathSync entry-guard to all 16 affected CLI/tool files (closes [#71](https://github.com/kontourai/flow-agents/issues/71)) ([8a676b0](https://github.com/kontourai/flow-agents/commit/8a676b0c9c91464d64755719ff778a13e298beb9))
* apply realpathSync entry-guard to remaining 10 CLI/tool files ([159bb78](https://github.com/kontourai/flow-agents/commit/159bb785b6b28f99b0a3a5c95e0d4428512f4314))
* use hosted console io preset ([5b4bb7b](https://github.com/kontourai/flow-agents/commit/5b4bb7bc86d154bcf4d529a62e398a2196b702cc))

## [1.0.1](https://github.com/kontourai/flow-agents/compare/v1.0.0...v1.0.1) (2026-06-12)


### Fixes

* resolve three kit-distribution blockers ([#55](https://github.com/kontourai/flow-agents/issues/55) [#56](https://github.com/kontourai/flow-agents/issues/56) [#57](https://github.com/kontourai/flow-agents/issues/57)) ([3350cb1](https://github.com/kontourai/flow-agents/commit/3350cb15f44bff92d8d9c57f447761d0e1a1b20c))
* resolve three kit-distribution blockers ([#55](https://github.com/kontourai/flow-agents/issues/55), [#56](https://github.com/kontourai/flow-agents/issues/56), [#57](https://github.com/kontourai/flow-agents/issues/57)) ([13bf732](https://github.com/kontourai/flow-agents/commit/13bf732ff365efa84423e9ea46042e501d202db8))

## [1.0.0](https://github.com/kontourai/flow-agents/compare/v0.4.0...v1.0.0) (2026-06-12)


### Features

* agentless Flow Kit gate evaluation proof (issue [#52](https://github.com/kontourai/flow-agents/issues/52) item 3) ([f7857ec](https://github.com/kontourai/flow-agents/commit/f7857ec8ba69d614b0c3c70548d724f7a97c164a))
* agentless Flow Kit gate evaluation proof (issue [#52](https://github.com/kontourai/flow-agents/issues/52) item 3) ([86c881f](https://github.com/kontourai/flow-agents/commit/86c881f579a08ab75787cd32e401f83b77952c39))
* config-protection blocks git hook-skip flags ([#41](https://github.com/kontourai/flow-agents/issues/41)) ([6d9e981](https://github.com/kontourai/flow-agents/commit/6d9e9810b3d4e60fe172ade340e61dbe4053d0c9))
* K-level conformance, degradation invariant, and consumer-target derivation ([#52](https://github.com/kontourai/flow-agents/issues/52) items 1+2) ([d5c332a](https://github.com/kontourai/flow-agents/commit/d5c332a3f4400eb29e9f8fd4e845ec34cf30ae0b))
* K-level conformance, degradation invariant, and consumer-target derivation (issue [#52](https://github.com/kontourai/flow-agents/issues/52) items 1+2) ([6ac62eb](https://github.com/kontourai/flow-agents/commit/6ac62eb4cec195baca3d039b398f29e45e5d62de))
* **knowledge-kit:** obsidian layout — insights at node root, sources nested; dimension frontmatter ([5d6489b](https://github.com/kontourai/flow-agents/commit/5d6489b6dc30eacc3a4d0c51487c1a7d3a004f00))
* **knowledge-kit:** Obsidian store adapter — file-is-the-record spike ([#43](https://github.com/kontourai/flow-agents/issues/43)) ([83d9ff4](https://github.com/kontourai/flow-agents/commit/83d9ff43c2e1d59ac8d3235ae7250fc43be47725))
* **knowledge-kit:** Obsidian store adapter spike — file-is-the-record RATIFIED ([#43](https://github.com/kontourai/flow-agents/issues/43)) ([467c8dc](https://github.com/kontourai/flow-agents/commit/467c8dc60180a5f6bf15b30a4f0e29e486803fb8))
* **knowledge-kit:** person entity cards with backlinks + gated resolution ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([9456cef](https://github.com/kontourai/flow-agents/commit/9456cef3b55c639bd50a9aeaea675bef425ea0be))
* **knowledge-kit:** person entity cards with backlinks + gated resolution ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([ac5ccb0](https://github.com/kontourai/flow-agents/commit/ac5ccb08e40bb6adadd35ff165a617be29e8d23a))


### Fixes

* **entity-extractor:** parse trailing-period last-entry correctly ([76abd87](https://github.com/kontourai/flow-agents/commit/76abd87ce2e6bfa3650c3d20de7309d498a446f8))
* **entity-extractor:** parse trailing-period last-entry correctly ([#48](https://github.com/kontourai/flow-agents/issues/48)) ([ac64fc1](https://github.com/kontourai/flow-agents/commit/ac64fc1cb3151af9032948ac463337da3eeaf907))


### Documentation

* elevate Flow Kits as the authorable-ecosystem pillar ([#45](https://github.com/kontourai/flow-agents/issues/45)) ([fa81820](https://github.com/kontourai/flow-agents/commit/fa8182089c4e3c404e3020c6d516be93353a897b))
* elevate Flow Kits as the authorable-ecosystem pillar ([#45](https://github.com/kontourai/flow-agents/issues/45)) ([7ffa44e](https://github.com/kontourai/flow-agents/commit/7ffa44ea8be799e709b41d4ac4220948e3819fb8))
* kit container/extension layering — container contract is Flow-owned ([#50](https://github.com/kontourai/flow-agents/issues/50)) ([33d6ec0](https://github.com/kontourai/flow-agents/commit/33d6ec0bf0fefd9095c19dc76b995ee7dd8079fb))
* kit container/extension layering — container contract is Flow-owned ([#50](https://github.com/kontourai/flow-agents/issues/50)) ([fd87366](https://github.com/kontourai/flow-agents/commit/fd873663d64e205e1a8c2b898b913a56d410591f))


### Maintenance

* cut v1.0.0 ([5f88ac5](https://github.com/kontourai/flow-agents/commit/5f88ac51598fe3f13b16360572ff851b822013a2))

## [0.4.0](https://github.com/kontourai/flow-agents/compare/v0.3.0...v0.4.0) (2026-06-12)


### Features

* **knowledge-kit:** gated decision retirement + working-set exclusion (S7, [#37](https://github.com/kontourai/flow-agents/issues/37)) ([40ae3fb](https://github.com/kontourai/flow-agents/commit/40ae3fb483205da6cf349265a63245bd1bb4006b))
* **knowledge-kit:** vector similarity detector — first drop-in (I10 unparked) ([a63c6d4](https://github.com/kontourai/flow-agents/commit/a63c6d4eb122d86cf14f018dc23651043be6449a))


### Fixes

* **ci:** author release PRs via kontour-release-bot app token ([#38](https://github.com/kontourai/flow-agents/issues/38)) ([6a2c937](https://github.com/kontourai/flow-agents/commit/6a2c9376df0c07458e54066108ec17e3c9548841))


### Documentation

* repo commit/release conventions in AGENTS.md, pinned by static check ([aecd896](https://github.com/kontourai/flow-agents/commit/aecd896fb2c4a86ebe51749c2257e7b41b9cbc21))

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
