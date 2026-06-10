<div align="center">

# Kontour Flow Agents

**The discipline of Kontour Flow, inside the agent tools you already use.**

[![CI](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

[Documentation](https://kontourai.github.io/flow-agents/) · [Workflow Guide](docs/workflow-usage-guide.md) · [System Guidebook](docs/agent-system-guidebook.md) · [Kontour Flow](https://kontourai.github.io/flow/)

</div>

---

Coding agents are powerful and forgetful. They plan well, then drift. They skip verification when context gets crowded. They call partial work done, and after a compaction nobody — including the agent — can say where the work actually stands.

Flow Agents wraps Codex, Claude Code, Kiro, and CI agents in an operating layer that makes long-running work inspectable: workflow skills that route requests into the right procedure, durable sidecar state that survives compaction and handoff, hooks that catch stop-short behavior, evidence gates before release decisions, and learning loops that feed corrections back into the system. [Kontour Flow](https://kontourai.github.io/flow/) owns the gate semantics underneath; Flow Agents makes that enforcement native inside agent harnesses.

**You ask for outcomes. The system supplies the path, the state, the checks, and the proof.**

## What you get

- **One workflow across runtimes** — the same `idea → backlog → plan → build → review → verify → evidence → release → learning` path installs into Codex, Claude Code, and Kiro without rewriting it per tool.
- **Workflow skills** — `idea-to-backlog`, `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, `release-readiness`, `learning-review`, and orchestrators like `deliver` and `fix-bug` that chain them.
- **Durable workflow state** — schema-validated sidecars under `.flow-agents/` record acceptance criteria, evidence, critique, handoff, and learning, so any session can resume from recorded state instead of chat memory.
- **Stop-short protection** — runtime hooks check sidecar state and route the agent back when required evidence is missing, instead of letting it summarize past the gap.
- **Evidence over confidence** — important work ends with tests, browser checks, CI results, review findings, governance reports, or an explicit `NOT_VERIFIED` gap. Optional [Veritas](docs/veritas-integration.md) integration attaches repo-governance evidence without making it mandatory.
- **Evals that keep the bundle honest** — static, integration, and behavioral eval lanes validate the skills, contracts, fixtures, and hook influence as the bundle evolves.

## Install

```bash
# guided install into your workspace
npx @kontourai/flow-agents init --dest /path/to/workspace

# headless, for CI or scripts
npx @kontourai/flow-agents init --dest /path/to/workspace --telemetry-sink local-files --yes

# with runtime-specific wiring and kit activation
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kits --yes
```

Until the first npm release lands, the same commands work from a checkout:

```bash
git clone https://github.com/kontourai/flow-agents.git
cd flow-agents && npm install && npm run build
node build/src/cli.js init --dest /path/to/workspace
```

The installer copies the bundled agents, skills, context, scripts, evals, Flow Kit assets, and the Flow Agents-owned `console.telemetry.json` descriptor into the target workspace. Telemetry writes to local files by default; optional sinks mirror it to a local, hosted, or self-hosted Kontour Console (`--telemetry-sink local-kontour-console | kontour-hosted-console | user-hosted-console --console-url …`).

The low-level bundle installer remains available when you already have a generated bundle checkout:

```bash
bash install.sh /path/to/workspace --telemetry-sink local-kontour-console
```

## Use it

After installing, ask the agent for the workflow you want — in plain language:

```text
Use Builder Kit shape for this feature idea and create executable GitHub issues.
```

```text
Use pull-work, select the next ready issue, and hand it to plan-work.
```

```text
Use deliver for this issue. Plan it, execute it, verify it, and stop if evidence is missing.
```

```text
Use fix-bug. Reproduce the issue, diagnose root cause, plan the fix, implement it, and verify the regression path.
```

The [Workflow Usage Guide](docs/workflow-usage-guide.md) walks every stage with example prompts and expected behavior; the [Agent System Guidebook](docs/agent-system-guidebook.md) is the plain-language map of how the pieces fit.

## Where Flow Agents fits

Kontour AI shows the work behind AI. Each product stands alone; together they cohere:

| Product | Owns |
| --- | --- |
| **[Surface](https://github.com/kontourai/surface)** | Portable trust state: claims, evidence, policies, trust snapshots |
| **[Flow](https://github.com/kontourai/flow)** | Process transparency: steps, gates, transitions, runs, exceptions, reports |
| **[Veritas](https://github.com/kontourai/veritas)** | Code/change transparency: repo standards, merge readiness |
| **Flow Agents** | Agent-facing distribution: skills, kits, runtime adapters, hooks, telemetry |

Flow Agents owns the glue — discovery, just-in-time guidance, scoped delegation, Flow-backed state inside harnesses, evidence-backed completion, and feedback loops. It deliberately does not own the model, the runtime, the workflow engine, or repo governance. The [North Star](docs/north-star.md) records the direction and design principles.

## Developer commands

```bash
npm run setup:repo-hooks        # enable the tracked .githooks pre-push lane
npm run validate:source --      # source-tree and contract validation
bash evals/run.sh static        # static eval suite
```

For release-readiness or repo-shape changes, run the split CI baseline locally:

```bash
bash evals/ci/run-baseline.sh --lane source-and-static
bash evals/ci/run-baseline.sh --lane workflow-contracts
bash evals/ci/run-baseline.sh --lane runtime-and-kit
```

`setup:repo-hooks` is a repo Git hook for local developer checks, not a Flow Agents runtime hook — runtime hooks live under `scripts/hooks/`; see [docs/developer-hook-setup.md](docs/developer-hook-setup.md) for the boundary.

## Repository layout

See [Repository Structure](docs/repository-structure.md) for the canonical map. In short:

- `agents/`, `agent-cards/`, `skills/`, `context/`, `powers/`, and `prompts/` are canonical bundle source.
- `src/` and `scripts/` are product, tooling, validation, installer, hook, telemetry, and compatibility source; see [scripts/README.md](scripts/README.md).
- `kits/`, `schemas/`, `packaging/`, `evals/`, `docs/`, and `integrations/` hold Flow Kit assets, contracts, package metadata, evals, durable docs, and optional integrations.
- `dist/`, `build/`, and `_site/` are generated output. Local `.flow-agents/`, `.codex/`, `.claude/`, telemetry, promptfoo, Veritas, and cache directories are runtime state and stay ignored; durable outcomes belong in docs, source, schemas, or provider records.

## Documentation

The [GitHub Pages site](https://kontourai.github.io/flow-agents/) is the product overview and quickstart. The repository docs are the developer reference for contracts, workflow behavior, evals, and integration boundaries. For the gate semantics underneath — definitions, runs, evidence, route-back — read the [Kontour Flow documentation](https://kontourai.github.io/flow/).

## License

[Apache-2.0](LICENSE) © Kontour AI
