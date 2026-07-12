# Universal Packaging

This directory defines the cross-harness packaging layer for Flow Agents.

## Canonical Source

The repo root stays canonical:

- `agents/` contains source Kiro-style agent specs: the `dev` workflow surface plus specialist `tool-*` agents.
- `agent-cards/` contains discovery metadata for routable orchestrators.
- `skills/`, `context/`, `powers/`, `prompts/`, `scripts/`, and `evals/` remain shared content.
- `src/` contains TypeScript CLI, runtime adapter, packaging, validation, context-map, and repository tooling source that compiles to `build/src/`.
- `packaging/manifest.json` describes target-specific copy rules, profile definitions, substitutions, and model/provider mappings.
- Generated bundles live under `dist/`, are intentionally untracked, and can be recreated at any time.

For the full source/generated/runtime inventory, see [Repository Structure](../docs/repository-structure.md).

## Targets

- `dist/kiro/` keeps native Kiro JSON agents and rewrites path-bound config through the install token.
- `dist/claude-code/` exports `.claude/agents/*.md` and `.claude/skills/*/SKILL.md`.
- `dist/codex/` exports Codex-only agents and profiles beneath `.codex/`, and portable, self-contained skills beneath the universal `.agents/skills/` catalog.

All targets also receive shared canonical directories where supported: `context/`, `powers/`, `prompts/`, `scripts/`, and `evals/`.

`docs/` and `evals/` are intentionally included in generated bundles today. `docs/` gives installed agents durable local reference material, and `evals/` provides install-time and runtime smoke tests for the exported bundle. If bundle size becomes a product constraint, prune these through `packaging/manifest.json` and update install tests rather than deleting generated output by hand.

## Documentation And Instruction Discovery

Every runtime bundle puts generated-source provenance and the complete exported-agent inventory in `README.md`. That content is maintainer documentation, not agent instructions. A shared runtime capability policy separately decides whether a bundle publishes a concise repository instruction file:

| Runtime | Bundle documentation | Repository instruction surface |
| --- | --- | --- |
| Base | `README.md` | `AGENTS.md` |
| Kiro | `README.md` | `AGENTS.md` |
| Claude Code | `README.md` | `CLAUDE.md` |
| Codex | `README.md` | None |
| OpenCode | `README.md` | `AGENTS.md` |
| pi | `README.md` | `AGENTS.md` |

Instruction files contain only concise operational guidance discoverable by the target harness. They do not contain regeneration advice, packaging provenance, or the exported-agent catalog.

## Repository Instruction Preservation

All generated installers use one preservation policy for repository instructions. An existing `AGENTS.md` or `CLAUDE.md` is repository-owned and is never overwritten or deleted. The installer excludes both paths from synchronization, including Kiro's `rsync --delete` path, and creates a runtime's declared instruction file only when that destination path is absent. This applies equally to direct bundle installation and `flow-agents init`.

The CLI does not own a second instruction policy: `flow-agents init` selects a generated runtime bundle and invokes that bundle's `install.sh`. Changes to discovery or preservation therefore belong in the shared bundle capability and installer generation code, with direct and CLI-mediated fixtures covering the same behavior.

## Generated And Runtime Boundaries

`dist/` is a generated export surface, not the source of truth. Installed runtime directories such as `.codex/` and `.claude/` are also not source. They are created from the generated target bundle and installer scripts. If generated or installed hook config is wrong, fix the canonical source, rebuild `dist/`, and reinstall the runtime config.

Runtime workflow state under `.kontourai/flow-agents/<slug>/` is local working memory. Packaging should copy canonical workflow contracts and skills, but it should not publish local task artifacts as product source. Durable outcomes must be promoted into docs, source, schemas, or provider records before merge.

## Validation And Build

Run the source validator before rebuilding:

```bash
npm run validate:source --
```

Rebuild every target bundle:

```bash
npm run build:bundles --
```

Run static package checks after rebuilding:

```bash
bash evals/run.sh static
```

For telemetry and shell integration coverage:

```bash
bash evals/run.sh integration
```

The builder is stdlib-only so the package stays dependency-free.
