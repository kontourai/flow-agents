# Changelog

## Unreleased

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
