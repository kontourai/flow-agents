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
- `dist/codex/` exports `.codex/agents/*.toml`, `.codex/skills/*/SKILL.md`, and profile config for `kdev` and its Bedrock variant.

All targets also receive shared canonical directories where supported: `context/`, `powers/`, `prompts/`, `scripts/`, and `evals/`.

## Generated And Runtime Boundaries

`dist/` is a generated export surface, not the source of truth. Installed runtime directories such as `.codex/` and `.claude/` are also not source. They are created from the generated target bundle and installer scripts. If generated or installed hook config is wrong, fix the canonical source, rebuild `dist/`, and reinstall the runtime config.

Runtime workflow state under `.agents/flow-agents/<slug>/` is local working memory. Packaging should copy canonical workflow contracts and skills, but it should not publish local task artifacts as product source. The only narrow exception is reviewable `.agents/flow-agents/changes/<change-id>/` work, which must be promoted before merge.

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
