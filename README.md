<div align="center">

# Kontour Flow Agents

**A portable process-discipline layer for agentic work — canonical policies, evidence, and telemetry that compile to whatever hook surface a host exposes.**

[![npm version](https://img.shields.io/npm/v/%40kontourai%2Fflow-agents)](https://www.npmjs.com/package/@kontourai/flow-agents)
[![CI](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

[Documentation](https://kontourai.github.io/flow-agents/) · [Workflow Guide](docs/workflow-usage-guide.md) · [System Guidebook](docs/agent-system-guidebook.md) · [Runtime Hook Spec](docs/spec/runtime-hook-surface.md) · [Kontour Flow](https://kontourai.github.io/flow/)

</div>

---

Agents are powerful and forgetful. They plan well, then drift. They skip verification when context gets crowded. They call partial work done, and after a compaction nobody — including the agent — can say where the work actually stands.

Flow Agents addresses this with a process-discipline layer that sits between the user and the agent: four canonical policy classes (workflow steering, quality gate, stop-goal-fit, config protection), durable sidecar state that survives compaction and handoff, evidence gates before release decisions, and telemetry that feeds corrections back into the system. [Kontour Flow](https://kontourai.github.io/flow/) owns the gate semantics underneath; Flow Agents compiles those policies to whatever hook surface a host exposes — coding-agent harnesses today, agent frameworks next.

**You ask for outcomes. The system supplies the path, the state, the checks, and the proof.**

## What you get

- **One workflow across runtimes** — the same `idea → backlog → plan → build → review → verify → evidence → release → learning` path installs into Claude Code, Codex, Kiro, opencode, and pi without rewriting it per tool.
- **Workflow skills** — `idea-to-backlog`, `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, `release-readiness`, `learning-review`, and orchestrators like `deliver` and `fix-bug` that chain them.
- **Durable workflow state** — schema-validated sidecars under `.flow-agents/` record acceptance criteria, evidence, critique, handoff, and learning, so any session can resume from recorded state instead of chat memory.
- **Four canonical policies** — workflow steering (phase reminders at each turn), quality gate (per-file checks after edits), stop-goal-fit (evidence check before the agent stops), and config protection (veto writes to linter/formatter configs). Each policy class has a canonical script under `scripts/hooks/` and compiles to the host's native hook format.
- **Evidence over confidence** — important work ends with tests, browser checks, CI results, review findings, governance reports, or an explicit `NOT_VERIFIED` gap. Optional [Veritas](docs/veritas-integration.md) integration attaches repo-governance evidence without making it mandatory.
- **Evals that keep the bundle honest** — 77 integration and 36 static bundle assertions validate the skills, contracts, fixtures, and hook influence as the bundle evolves.

## Flow Agents as a process-discipline layer

The four canonical policy classes are defined in the [Runtime Hook Surface spec](docs/spec/runtime-hook-surface.md) using a runtime-neutral vocabulary. Adapters translate them to whatever hook surface a host exposes:

| Policy Class | What it does | Hook trigger |
| --- | --- | --- |
| Workflow steering | Injects phase-transition reminders so the agent does not lose track of where it is in the delivery pipeline | `userPromptSubmit` |
| Quality gate | Runs format and lint checks immediately after edit tool calls | `postToolUse` |
| Stop-goal-fit | Warns (or blocks) when the agent is about to stop but required evidence is missing | `stop` |
| Config protection | Vetoes writes to linter and formatter configuration files | `preToolUse` |

The spec defines three conformance levels: **L0** (telemetry only), **L1** (steering + stop-goal-fit warning), and **L2** (all four policies with blocking). Claude Code and Codex are the current L2 reference implementations.

## Runtime and support matrix

L2 means all four policy classes with blocking; L1 means steering and stop-goal-fit warning only (no quality gate or blocking config protection). The [Runtime Hook Surface spec](docs/spec/runtime-hook-surface.md) defines the levels and names every hook-surface gap explicitly.

**Full support — L2 (all four policies, blocking)**

| Runtime | Ships | Tested |
| --- | --- | --- |
| Claude Code | install + hooks + bundle | 77 integration + 36 static assertions — reference implementation |
| Codex | install + hooks + bundle | 77 integration + 36 static assertions — reference implementation |
| Kiro | install + hooks + bundle | included in bundle assertions |

**Partial support — L1 (steering + stop-goal-fit warning)**

| Runtime | Ships | Gap | Tested |
| --- | --- | --- | --- |
| opencode | `.opencode/agents/`, `.opencode/skills/`, `.opencode/plugins/flow-agents.js`, `opencode.json` | No prompt-submit hook; steering wired to `session.created` + `tool.execute.before` | included in bundle assertions |
| pi | `.pi/extensions/flow-agents.ts`, `.pi/skills/`, `AGENTS.md` | No stop hook; stop-goal-fit unavailable | included in bundle assertions |

**Other**

| Tier | Runtime | Ships | Tested |
| --- | --- | --- | --- |
| Official framework adapter | AWS Strands (Python) | `integrations/strands/` — `flow-agents-strands` PyPI package | 50 unit tests (no Strands SDK required) — spike/preview, see [integrations/strands/README.md](integrations/strands/README.md) |
| Conformance-certified | Community / third-party | Self-certify using the conformance kit | Conformance kit in development; not yet shipped |

## Install

```bash
# guided install into your workspace (auto-detects runtime)
npx @kontourai/flow-agents init --dest /path/to/workspace

# headless, for CI or scripts
npx @kontourai/flow-agents init --dest /path/to/workspace --telemetry-sink local-files --yes

# runtime-specific wiring
npx @kontourai/flow-agents init --runtime claude-code --dest /path/to/workspace --yes
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kits --yes
npx @kontourai/flow-agents init --runtime opencode --dest /path/to/workspace --yes
npx @kontourai/flow-agents init --runtime pi --dest /path/to/workspace --yes
```

Working from a checkout (for contributors): `npm install && npm run build`, then `node build/src/cli.js init --dest /path/to/workspace`.

The installer copies the bundled agents, skills, context, scripts, evals, Flow Kit assets, and the Flow Agents-owned `console.telemetry.json` descriptor into the target workspace. Telemetry writes to local files by default; optional sinks mirror it to a local, hosted, or self-hosted Kontour Console (`--telemetry-sink local-kontour-console | kontour-hosted-console | user-hosted-console --console-url …`).

`bash install.sh` is the low-level option for CI pipelines or scripts that already have a generated bundle checkout (e.g. from a pinned `git clone` of this repo). Prefer `npx @kontourai/flow-agents init` for normal workspace setup — it fetches the latest published bundle and auto-detects the runtime:

```bash
bash install.sh /path/to/workspace --telemetry-sink local-kontour-console
```

## Use it

After installing, ask the agent for the workflow you want — in plain language:

```text
Use Builder Kit shape for this feature idea and create executable GitHub issues.
```

```text
Use deliver for this issue. Plan it, execute it, verify it, and stop if evidence is missing.
```

The [Workflow Usage Guide](docs/workflow-usage-guide.md) has example prompts and expected behavior for every stage — `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `fix-bug`, `release-readiness`, and more. The [Agent System Guidebook](docs/agent-system-guidebook.md) is the plain-language map of how the pieces fit.

## Flow Kits

A Flow Kit is a portable workflow bundle: a `kit.json` manifest, one or more Flow Definitions, and optional skills, docs, adapters, evals, and assets — all validated and installed as a unit. Kits are the extension model for Flow Agents: they let you package a workflow once and deploy it into any workspace through the same path as the built-in workflows.

**Builder Kit** is the first Kontour-authored kit. It ships with `builder.shape` (shape a problem into slices and fileable work items) and `builder.build` (pull ready work through design probing, planning, execution, verification, PR readiness, merge readiness, and learning). Builder Kit is installed automatically by `npx @kontourai/flow-agents init`.

Install a local kit:

```bash
npx @kontourai/flow-agents flow-kit install-local path/to/my-kit --dest /path/to/workspace
```

- [Kit Authoring Guide](docs/kit-authoring-guide.md) — build your own kit from scratch: directory layout, `kit.json`, a flow file, validation, install, and activation.
- [Flow Kit Repository Contract](docs/flow-kit-repository-contract.md) — the full validation rules, registry schema, and activation diagnostics.

## Framework adapters

The same canonical policies that wire into coding-agent harnesses via file-based hook scripts can also wire into agent frameworks as in-process language-native packages.

`integrations/strands/` contains `flow-agents-strands`, a Python package implementing a Strands `HookProvider` that:
- emits the canonical telemetry taxonomy (`agentSpawn`, `preToolUse`, `postToolUse`, `stop`, etc.) to the same JSONL format as the harness adapters
- enforces config protection via `BeforeToolCallEvent` cancellation (the Strands equivalent of a blocking `preToolUse` hook)
- injects workflow steering context at agent construction via `steering_context()`

This is a spike/preview — 50 unit tests pass without requiring the Strands SDK, and the README documents 7 limitations honestly. It demonstrates that the policy engine is not harness-specific.

The [Runtime Hook Surface spec](docs/spec/runtime-hook-surface.md) documents the full framework adapter mapping, including VoltAgent, LangGraph, and OpenAI Agents SDK hook surfaces, and the minimum viable adapter pseudocode.

## Where Flow Agents fits

Kontour AI shows the work behind AI. Each product stands alone; together they cohere:

| Product | Owns |
| --- | --- |
| **[Survey](https://kontourai.io/survey)** | Producer evidence: source → extraction → candidate → review → claim |
| **[Surface](https://kontourai.io/surface)** | Portable trust state: claims, evidence, policies, trust snapshots |
| **[Flow](https://kontourai.io/flow)** | Process transparency: steps, gates, transitions, runs, exceptions, reports |
| **[Veritas](https://kontourai.io/veritas)** | Code/change transparency: repo standards, merge readiness |
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
