# Flow Agents

Flow Agents installs workflow-aware agent bundles for local development. It gives Codex, Claude Code, Kiro, and related runtimes the same structured path for selecting work, planning, implementing, reviewing, verifying, preparing release decisions, and recording what was learned.

## Install

```bash
npx @kontourai/flow-agents init
```

`flow-agents init` walks through a base workspace install built around `AGENTS.md`,
`.flow-agents/`, optional Console telemetry, and optional runtime-specific
wiring. For CI or scripted installs, use the same command headlessly:

```bash
npx @kontourai/flow-agents init \
  --dest /path/to/workspace \
  --telemetry-sink local-files \
  --yes
```

Runtime-specific bundle wiring is opt-in:

```bash
npx @kontourai/flow-agents init \
  --runtime codex \
  --dest /path/to/workspace \
  --activate-kits \
  --yes
```

The low-level bundle installer remains available when you already have a generated bundle checkout:

```bash
bash install.sh /path/to/workspace --telemetry-sink local-kontour-console
```

The installer copies the bundled agents, skills, context, scripts, evals, Flow Kit assets, and Flow Agents-owned `console.telemetry.json` descriptor into the target workspace. Telemetry writes to local files by default. Optional sinks can add a Console mirror: `local-kontour-console` for a separately running local Console, `kontour-hosted-console` for Kontour's hosted Console, or `user-hosted-console` with `--console-url` for a self-hosted Console. Legacy `kontour-cloud` and `hosted-kontour-console` sink names remain accepted.

## What You Get

- Runtime-specific agent definitions for supported harnesses
- Shared workflow skills such as `idea-to-backlog`, `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, `release-readiness`, and `learning-review`
- Builder Kit assets for turning product or engineering ideas into executable work
- Local workflow artifacts under `.flow-agents/`
- Validation and eval scripts for checking the installed bundle
- Optional governance evidence integration through Veritas readiness reports

## Common Use Cases

- Turn a rough idea into a shaped backlog item
- Pull a ready issue and produce an execution plan
- Run implementation through review and verification gates
- Capture browser, integration, CI, or governance evidence before release decisions
- Record release readiness, rollback notes, observability expectations, and follow-up learning
- Keep long-running agent work inspectable across compaction, branch switches, and delegated subagents

## Quick Start

After installing into a workspace, ask the agent to use the workflow directly:

```text
Use idea-to-backlog for this feature idea and create executable GitHub issues.
```

```text
Use pull-work, select the next ready issue, and hand it to plan-work.
```

```text
Use deliver for this issue. Plan it, execute it, verify it, and stop if evidence is missing.
```

For bug work:

```text
Use fix-bug. Reproduce the issue, diagnose root cause, plan the fix, implement it, and verify the regression path.
```

## Developer Commands

```bash
npm run setup:repo-hooks
npm run validate:repo-hooks --
npm run validate:source --
bash evals/run.sh static
```

`npm run setup:repo-hooks` enables the tracked `.githooks/pre-push` lane for this clone by setting `git config --local core.hooksPath .githooks`. This is a repo Git hook for local developer checks, not a Flow Agents runtime hook. Runtime hooks remain under `scripts/hooks/`; see `docs/developer-hook-setup.md` for the boundary and verification details.

For release-readiness or repo-shape changes, run the split CI baseline locally:

```bash
bash evals/ci/run-baseline.sh --lane source-and-static
bash evals/ci/run-baseline.sh --lane workflow-contracts
bash evals/ci/run-baseline.sh --lane runtime-and-kit
```

## Repository Layout

See [Repository Structure](docs/repository-structure.md) for the canonical developer-facing map, source/generated/runtime boundaries, regeneration commands, and cleanup policy.

- `agents/`, `agent-cards/`, `skills/`, `context/`, `powers/`, and `prompts/` are canonical bundle source.
- `src/` and `scripts/` are canonical product, tooling, validation, installer, hook, telemetry, and compatibility source; see [scripts/README.md](scripts/README.md) for wrapper and runtime-hook boundaries.
- `kits/`, `schemas/`, `packaging/`, `evals/`, `docs/`, and `integrations/` hold Flow Kit assets, contracts, package metadata, evals, durable docs, and optional integrations.
- `dist/`, `build/`, and `_site/` are generated output. Local `.flow-agents/`, `.codex/`, `.claude/`, telemetry, promptfoo, Veritas, and cache directories are runtime state and are ignored by default; durable outcomes belong in docs, source, schemas, or provider records.

## Documentation

The GitHub Pages site is the product overview and quickstart. The repository docs are the developer reference for contracts, workflow behavior, evals, and integration boundaries.
