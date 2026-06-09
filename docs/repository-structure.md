---
title: Repository Structure
---

# Repository Structure

This is the canonical developer-facing map for the Flow Agents repository. Use it to decide where a change belongs, whether a path is source or generated output, and which cleanup decisions are safe.

## Source Of Truth Rules

- Edit canonical source in the repo root areas listed below, then regenerate derived output with the documented commands.
- Do not edit `dist/`, `build/`, or `_site/` by hand. They are generated from tracked source.
- Do not commit local runtime state from `.flow-agents/<slug>/`, `.codex/`, `.claude/`, `.omx/`, `.promptfoo/`, `.telemetry/`, `.surface/`, `.veritas/`, or tool caches.
- Runtime workflow artifacts stay local and ignored; promote reviewable or durable outcomes to docs, source, schemas, or provider records before merging to `main`.
- Treat generated exports and installed runtime config as products of `packaging/manifest.json`, `src/tools/build-universal-bundles.ts`, `scripts/install-*.sh`, and the source directories they copy.

## Target Layout

```text
/
  README.md                    # human entry point
  src/                         # TypeScript CLI and runtime source
  src/tools/                   # TypeScript build, packaging, validation, and context-map tooling
  scripts/                     # public wrappers, shell tools, hooks, telemetry, installers
  agents/ agent-cards/         # canonical agent specs and discovery cards
  skills/ context/ powers/ prompts/
                                # canonical workflow bundle content
  kits/                        # Flow Kit catalog and bundled kit assets
  schemas/                     # JSON sidecar and provider schemas
  packaging/                   # bundle/export manifests and pack definitions
  evals/                       # eval harness, fixtures, static checks, integration checks
  docs/                        # durable docs and GitHub Pages source
  integrations/                # optional external integration config
  dist/ build/ _site/           # generated output; ignored
  .flow-agents/ .codex/ .claude/ ... # local runtime state; ignored by default
```

## Top-Level Inventory

| Path | Classification | Source of truth | Generated or runtime policy | Safe cleanup rule |
| --- | --- | --- | --- | --- |
| `.flow-agents/` | runtime state | Workflow tools write local session artifacts. | Ignored. | Do not commit task runtime roots; promote durable decisions to docs, source, schemas, or providers before merge. |
| `.claude/` | installed runtime config | Generated bundle or local runtime install. | Ignored. | Reinstall from `dist/claude-code/` instead of editing as source. |
| `.codex/` | installed runtime config | Generated bundle or local runtime install. | Ignored. | Reinstall from `dist/codex/` or `scripts/install-codex-home.sh`; do not treat local hooks as canonical. |
| `.githooks/` | canonical repo tooling | Tracked repository hook scripts. | Source, not runtime agent hooks. | Keep compatible with `npm run setup:repo-hooks` and `npm run validate:repo-hooks --`. |
| `.github/` | canonical CI config | GitHub workflow files. | Source. | Preserve workflow command names and artifact expectations. |
| `.ai/`, `.omx/`, `.promptfoo/`, `.surface/`, `.telemetry/`, `.veritas/` | runtime, cache, or integration output | Local tools and optional integrations. | Ignored runtime state. | Clean locally when not needed; promote only stable integration config under `integrations/` or durable docs. |
| `.venv/`, `node_modules/`, `test-results/`, `__pycache__/` | dependency/cache output | Package managers and test tools. | Ignored. | Safe local cleanup; recreate with normal install or test commands. |
| `_site/` | generated docs output | Built from `docs/`. | Ignored. | Recreate with docs preview/build tooling. |
| `agent-cards/` | canonical source | Discovery metadata for routable agents. | Exported into runtime bundles. | Do not delete without checking bundle manifests and evals. |
| `agents/` | canonical source | Source agent definitions. | Exported to Kiro, Claude Code, Codex, and compatible harnesses. | Keep public agent names compatible or provide shims. |
| `build/` | generated output | TypeScript compiler output from `src/`. | Ignored. | Recreate with `npm run build --`. |
| `context/` | canonical source | Shared contracts, settings, templates, hooks context, and reusable guidance. | Exported to bundles. | Contract changes require validation and docs review. |
| `dist/` | generated bundle output | Created by `npm run build:bundles --`. | Ignored. | Never edit by hand; rebuild from source and packaging metadata. |
| `docs/` | canonical docs/site source | Durable developer and product documentation. | Source for GitHub Pages and context docs. | Update when behavior or boundaries change; regenerate context map when relevant. |
| `evals/` | canonical eval source plus ignored results | Harness, cases, fixtures, static checks, integration checks. | `evals/results/*.json`, reports, and CI logs are generated output unless intentionally tracked fixtures. | Do not remove fixtures without reference proof; generated results can be local cleanup candidates. |
| `integrations/` | optional integration source | Integration config shipped with the repo. | Source; local run state belongs under ignored runtime roots. | Keep optional and adapter-driven. |
| `kits/` | canonical Flow Kit source | Kit Catalog and bundled Builder Kit assets. | Exported and validated by Flow Kit commands. | Preserve catalog paths and validation coverage. |
| `packaging/` | canonical packaging source | Manifest, pack definitions, and packaging docs. | Drives generated bundles under `dist/`. | Update before changing export shape. |
| `powers/` | canonical source | Optional MCP/tool capability bundles. | Exported where supported. | Keep activation guidance separate from credentials. |
| `prompts/` | canonical source | Saved prompt entry points. | Exported where supported. | Promote stable procedures into skills when needed. |
| `schemas/` | canonical source | JSON schemas for sidecars and provider/resource records. | Used by validators and workflow tooling. | Schema changes require artifact validation. |
| `scripts/` | canonical source and compatibility surface | Shell and JavaScript wrappers, installers, hooks, telemetry, workflow tooling. | Some scripts wrap compiled `build/` output. | Public wrappers are compatibility-sensitive; see [`scripts/README.md`](../scripts/README.md) before moving. |
| `src/tools/` | canonical TypeScript tooling source | Build, packaging, context-map, validators, and utility modules imported by `src/cli.ts`. | Compiled to `build/src/tools/`. | Keep public wrappers in `scripts/` stable when tooling internals move. |
| `skills/` | canonical source | Reusable workflow skills. | Exported to runtime bundles. | Skill renames need compatibility and docs updates. |
| `src/` | canonical TypeScript product source | CLI, runtime adapters, Flow Kit helpers, and shared libraries. | Compiled to `build/src/`. | Preserve public bin command behavior. |
| root files | canonical metadata | `package.json`, `tsconfig.json`, `install.sh`, license, contribution docs, security docs, and repo instructions. | Source. | Keep command names and install behavior compatible. |
| `veritas.claims.json` | optional integration source | Repo-local Veritas claim configuration. | Source for optional governance evidence. | Keep optional; local Veritas run output stays ignored. |

## Regeneration And Validation Commands

| Need | Command |
| --- | --- |
| Compile TypeScript | `npm run build --` |
| Validate source tree | `npm run validate:source --` |
| Regenerate context map | `npm run context-map --` |
| Check context map drift | `npm run context-map:check --` |
| Rebuild runtime bundles | `npm run build:bundles --` |
| Validate packaging | `npm run validate:package -- <package-prefix>` |
| Run static evals | `bash evals/run.sh static` |
| Run integration evals | `bash evals/run.sh integration` |
| Validate repo Git hooks | `npm run validate:repo-hooks --` |

## Runtime And TypeScript Policy

The package requires Node `>=22`, and GitHub Actions runs CI on Node 22. Keep `@types/node` on the Node 22 major line while CI remains the runtime baseline. Moving to a newer Node type major should be paired with an explicit runtime policy update and CI validation.

## Generated And Runtime Boundaries

`dist/`, `build/`, and `_site/` are generated output. `dist/` mirrors canonical bundle source for runtime installation; `build/` mirrors TypeScript compilation output; `_site/` mirrors the docs site build. If any of these are stale, rebuild them instead of patching them.

`.codex/` and `.claude/` at the repo root are installed runtime configuration surfaces. They can be useful for local testing, but canonical hook scripts and runtime config live in `scripts/hooks/`, `context/`, `packaging/`, and generated bundle output. The stale local `.codex/hooks.json` incident came from treating an installed runtime file as if it were canonical source. The fix is to regenerate or reinstall runtime config and update the canonical builder/install sources when behavior must change.

`.flow-agents/<slug>/` is workflow working memory. Keep plans, sidecars, evidence, and handoffs there while work is active. Promote stable outcomes into `docs/`, schemas, source, or provider records before final acceptance.

## Dead-Code Cleanup Policy

Do not delete production source in a cleanup pass unless repeatable proof shows it is unused and validators still pass. Minimum proof for a candidate:

1. `git ls-files <path>` shows whether the path is tracked source or local ignored state.
2. `rg -n "<path-or-command-name>" README.md docs context agents agent-cards skills powers prompts scripts src evals packaging kits integrations package.json install.sh .github .githooks` has no live references, or all references are updated in the same change.
3. Public commands, package bins, installers, bundle manifests, kit catalogs, and evals do not depend on the path, or compatibility shims remain in place.
4. Generated output has a documented source and regeneration command before removal.
5. Relevant validation passes after cleanup.

Current low-risk cleanup candidates are ignored local caches and generated result payloads, not production source. Keep `evals/fixtures/` and tracked `.gitkeep` or baseline ignore files unless a separate eval migration proves they are obsolete.
