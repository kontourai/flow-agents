<div align="center">

# Kontour Flow Agents

**A portable process-discipline layer for agentic work — canonical policies, evidence, and telemetry that compile to whatever hook surface a host exposes.**

In plain terms: it keeps your coding agent honest — tracking what it did, checking its work at each step, and refusing to call a job done until the evidence backs it up. (New to the terms below? See the [glossary](CONTEXT.md#glossary).)

[![npm version](https://img.shields.io/npm/v/%40kontourai%2Fflow-agents)](https://www.npmjs.com/package/@kontourai/flow-agents)
[![CI](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/kontourai/flow-agents/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

[Documentation](https://kontourai.github.io/flow-agents/) · [Workflow Guide](docs/workflow-usage-guide.md) · [System Guidebook](docs/agent-system-guidebook.md) · [Runtime Hook Spec](docs/spec/runtime-hook-surface.md) · [Kontour Flow](https://kontourai.github.io/flow/)

</div>

---

Agents are powerful and forgetful. They plan well, then drift. They skip verification when context gets crowded. They call partial work done, and after a compaction nobody — including the agent — can say where the work actually stands.

Flow Agents has two layers. The **engine** is product-neutral: FlowDefinition interpretation, gates, runtime and harness adapters, SDK/evidence/trust primitives, and kit validation. **Kits** are swappable solutions on top: built-in examples such as Builder, Knowledge, and Release Evidence, plus external products such as the Veritas Governance Kit and any third-party repository with a root `kit.json`. [Kontour Flow](https://kontourai.github.io/flow/) owns the gate semantics underneath; Flow Agents compiles those policies to whatever hook surface a host exposes — coding-agent harnesses today, agent frameworks next.

**You ask for outcomes. The system supplies the path, the state, the checks, and the proof.**

## What you get

- **One workflow across runtimes** — the same `idea → backlog → plan → build → review → verify → evidence → release → learning` path installs into Claude Code, Codex, Kiro, opencode, and pi without rewriting it per tool.
- **Workflow skills** — `idea-to-backlog`, `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, `release-readiness`, `learning-review`, and orchestrators like `deliver` and `fix-bug` that chain them.
- **Resumable workflow state** — schema-validated sidecars under `.kontourai/flow-agents/` record acceptance criteria, evidence, critique, handoff, and learning, so any session can resume from recorded state instead of chat memory.
- **Four canonical policies** — workflow steering (phase reminders at each turn), quality gate (per-file checks after edits), stop-goal-fit (evidence check before the agent stops), and config protection (veto writes to linter/formatter configs). Each policy class has a canonical script under `scripts/hooks/` and compiles to the host's native hook format.
- **Evidence over confidence** — important work ends with tests, browser checks, CI results, review findings, governance reports, or an explicit `NOT_VERIFIED` gap. Optional [Veritas](docs/veritas-integration.md) integration attaches repo-governance evidence without making it mandatory.
- **Tamper-evident "done"** — the local runtime gate is advisory and best-effort; the controlled CI re-run is the authoritative anchor that reconciles manifest commands and git diff against fresh results before evidence is treated as CI-verified. See [Verifiable Trust — why "done" actually means done](docs/verifiable-trust.md).
- **Engine plus opt-in kits** — `kits/catalog.json` lists discoverable kits, each `kit.json` declares its flows and assets, and bring-your-own-kit follows the same validation and activation path. See [Engine and Kits](docs/architecture-engine-and-kits.md).
- **Evals that keep the bundle honest** — dozens of integration scripts and a full static-suite layer (`bash evals/run.sh`) validate the skills, contracts, fixtures, and hook influence as the bundle evolves.
- **A runnable reviewed-grounding example** — the [credential-free reference workflow](evals/reference/reviewed-grounding-workflow/README.md) acquires a source, performs exact provenance-bearing extraction, routes semantic changes through review, and refuses action until evidence and source-currency requirements are satisfied. A provider adapter can be supplied for optional live execution.

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
| Claude Code | install + hooks + bundle | full integration + static eval layer (`bash evals/run.sh`) — reference implementation |
| Codex | install + hooks + bundle | full integration + static eval layer (`bash evals/run.sh`) — reference implementation |
| Kiro | install + hooks + bundle | included in bundle assertions |

**Partial support — L1 (steering + stop-goal-fit warning)**

| Runtime | Ships | Gap | Tested |
| --- | --- | --- | --- |
| opencode | `.opencode/agents/`, `.opencode/skills/`, `.opencode/plugins/flow-agents.js`, `opencode.json` | No prompt-submit hook; steering wired to `session.created` + `tool.execute.before` | included in bundle assertions |
| pi | `.pi/extensions/flow-agents.ts`, `.pi/skills/`, `AGENTS.md` | No stop hook; stop-goal-fit unavailable | included in bundle assertions |

**Other**

| Tier | Runtime | Ships | Tested |
| --- | --- | --- | --- |
| Official framework adapter | AWS Strands (Python) | `integrations/strands/` — `flow-agents-strands` PyPI package | 76 unit tests (no Strands SDK required) — spike/preview, see [integrations/strands/README.md](integrations/strands/README.md) |
| Official framework adapter | AWS Strands (TypeScript) | `integrations/strands-ts/` — `@kontourai/flow-agents-strands` native-import package | shipped telemetry + native config-protection hot path; workflow-steering/quality-gate/stop-goal-fit are conformance-shim-only — preview, see [integrations/strands-ts/README.md](integrations/strands-ts/README.md) |
| Conformance-certified | Community / third-party | Self-certify using the conformance kit | Conformance kit in development; not yet shipped |

## Install

Requires Node.js 22 or newer.

```bash
# guided install into your workspace (auto-detects runtime)
npx @kontourai/flow-agents init --dest /path/to/workspace

# headless, for CI or scripts
npx @kontourai/flow-agents init --dest /path/to/workspace --telemetry-sink local-files --yes

# runtime-specific wiring
npx @kontourai/flow-agents init --runtime claude-code --dest /path/to/workspace --yes
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kit builder --yes
npx @kontourai/flow-agents init --runtime opencode --dest /path/to/workspace --yes
npx @kontourai/flow-agents init --runtime pi --dest /path/to/workspace --yes
```

For Codex global installs, omit `--dest` and use `--global`: Flow Agents installs into `CODEX_HOME` when it is set, otherwise `~/.codex`. Pass `--dest` only when you intentionally want an isolated or test-specific Codex home.

Runtime auto-detection is best-effort: it first checks environment markers set by the invoking coding agent (e.g. `CLAUDECODE`, Codex's preferred `CODEX_THREAD_ID`, the backward-compatible `CODEX_SESSION_ID`, or `OPENCODE_SESSION_ID`), then falls back to checking whether exactly one of `~/.claude`, `~/.codex` (or `$CODEX_HOME`), or opencode's global config dir already exists. If neither signal is unambiguous, it defaults to `base`. Pass `--runtime` explicitly to override the detected default at any time. Codex thread identifiers are never written into actor keys verbatim; Flow Agents derives a stable, domain-separated opaque token instead.

Working from a checkout (for contributors): `npm install && npm run build`, then `node build/src/cli.js init --dest /path/to/workspace`.

The installer copies the bundled agents, skills, context, scripts, evals, the kit catalog, and the Flow Agents-owned `console.telemetry.json` descriptor into the target workspace. Kits are opt-in at activation time: pass `--activate-kit <kit-id>` for a specific kit, or `--activate-kits` when you intentionally want every catalog kit. Telemetry writes to local files by default; optional sinks mirror it to a local, hosted, or self-hosted Kontour Console (`--telemetry-sink local-kontour-console | kontour-hosted-console | user-hosted-console --console-url …`).

`bash install.sh` is the low-level option for CI pipelines or scripts that already have a generated bundle checkout (e.g. from a pinned `git clone` of this repo). Prefer `npx @kontourai/flow-agents init` for normal workspace setup — it fetches the latest published bundle and auto-detects the runtime:

```bash
bash install.sh /path/to/workspace --telemetry-sink local-kontour-console
```

## Use it

After installing, ask the agent for the workflow you want — in plain language.

### Builder Kit quick start

After activating the Builder Kit, your agent gets two gated flows: `builder.shape` turns a raw idea into slices and executable work items; `builder.build` takes a selected work item through design probe, planning, execution, verification, PR readiness, merge readiness, and learning.

Shape an idea:

```text
Use Builder Kit shape. I want to add a progress indicator to the CLI output
so users can see what step the installer is on. Shape this into an executable
work item and stop at the backlog gate.
```

Build it:

```text
Use deliver for the issue you just filed. Pull it, probe the design, plan it,
implement it, verify it, and stop if any evidence is missing.
```

Each step has an evidence gate. The agent either presents the expected evidence and advances, or blocks and explains what is missing — it does not produce a confident summary and proceed on partial work. Non-durable session state is written to `.kontourai/flow-agents/<slug>/` and survives context loss or compaction.

For a full walkthrough — what each gate checks, what you observe, and how to invoke individual skills — read the [Builder Kit Quick Start](docs/getting-started.md).

For bugs:

```text
Use fix-bug. Reproduce the problem, diagnose root cause, implement the fix, and verify the regression path.
```

The [Workflow Usage Guide](docs/workflow-usage-guide.md) has example prompts and expected behavior for every stage — `pull-work`, `plan-work`, `execute-plan`, `review-work`, `verify-work`, `fix-bug`, `release-readiness`, and more. The [Agent System Guidebook](docs/agent-system-guidebook.md) is the plain-language map of how the pieces fit.

## Engine and Flow Kits

Flow Agents is not the Builder Kit. The engine is kit-neutral: every kit, built-in or third-party, declares its flows and assets in `kit.json` and is discovered through a catalog. Runtime steering comes from structured `workflow_triggers` rendered through the same engine path; `first_party` or "official" status is marketplace/catalog metadata only and grants no runtime privilege.

Read [Engine and Kits](docs/architecture-engine-and-kits.md) for the canonical split, including the built-in catalog, the manifest model, and the bring-your-own-kit extension point.

A Flow Kit bundles a workflow AND its opinionated output shape into a single validated unit: a `kit.json` manifest (schema version 1.0), one or more Flow Definitions, and optional skills, docs, adapters, evals, and assets. Authoring a kit means deciding not just _what_ an agent does but _how the result is rendered_ — the same pipeline produces different representations depending on which store adapter is active. Kits are the extension model for Flow Agents: validated and installed through the `flow-agents kit` CLI, and activatable into any workspace that runs Flow Agents.

**Builder Kit** — ships with `builder.shape` (shape a problem into slices and fileable work items), `builder.build` (pull ready work through design probing, planning, execution, verification, PR readiness, merge readiness, and learning), and `builder.publish-learn` (publish, provider/CI merge readiness, and learning feedback gates).

**Knowledge Kit** — a Flow Kit for durable, gated knowledge storage. It ships a store contract with four record types (`raw`, `compiled`, `concept`, `snapshot`), five pipeline flows (`ingest`, `compile`, `synthesize`, `consolidate`, `retire`), and a mutation policy of propose→evidence-gate→apply/reject with supersede-not-delete. All mutations require provenance; nothing is silently overwritten or deleted. Ships with an extensive automated test suite.

The output-shape story is the core reason kits matter. The Knowledge Kit store contract is representation-neutral: two adapters ship today. The **default adapter** stores records as flat markdown files with YAML frontmatter and a JSON graph index. The **Obsidian adapter** renders the same workflow into the shape a human already thinks in — one canonical note per record, category→folder hierarchy, configurable frontmatter dimensions (e.g. territory/customer/initiative as filterable fields), living overview notes with sources nested below, and superseded records moved to an `archive/` folder rather than deleted. Same flows, same mutation gates, different rendering layer. (The Obsidian adapter is shipped; layout/dimensions refinements and person/entity card support are in development.)

The Knowledge Kit is also LIVE-proven: the default adapter passes the parameterized contract suite; keyless operation is validated via a Strands agent + local ollama acceptance harness; vector similarity clustering uses ollama embeddings (`nomic-embed-text`) with a pluggable detector interface.

Install a local kit:

```bash
# default Codex/global kit destination: CODEX_HOME, or ~/.codex when CODEX_HOME is unset
npx @kontourai/flow-agents kit install path/to/my-kit

# explicit override for workspace or test installs
npx @kontourai/flow-agents kit install path/to/my-kit --dest /path/to/workspace
```

- [Kit Authoring Guide](docs/kit-authoring-guide.md) — build your own kit from scratch: directory layout, `kit.json`, a flow file, validation, install, and activation.
- [Flow Kit Repository Contract](docs/flow-kit-repository-contract.md) — the full validation rules, registry schema, and activation diagnostics.
- [Knowledge Kit docs](kits/knowledge/docs/README.md) — store contract, record types, mutation ops, similarity detectors, and the Obsidian adapter.

**Release Evidence Kit** — a minimal flows-only kit that proves agentless gate evaluation over trusted `release.evidence` claims in CI.

**Veritas Governance Kit** — maintained with the Veritas product in its own root-valid kit repository. Install it directly from a pinned Git ref; it gates the canonical trust bundle emitted by `veritas readiness` and helps set up the standalone engine without giving Flow Agents any Veritas-specific runtime branch:

```bash
npx @kontourai/flow-agents kit install \
  https://github.com/kontourai/veritas.git#v1.5.1 --dest .
npx @kontourai/flow-agents kit activate --dest . --format json
```

**Direction**: domain kits that compose this substrate — a Sales Kit (territory/customer/initiative schema with side-effect adapters for CRM logging), a Research Kit (transcript capture→compile→recall), and community-contributed kits discovered through a marketplace. Marketplace labels such as official or first-party describe provenance; they do not grant runtime privilege.

## Framework adapters

The same canonical policies that wire into coding-agent harnesses via file-based hook scripts can also wire into agent frameworks as in-process language-native packages.

`integrations/strands/` contains `flow-agents-strands`, a Python package implementing a Strands `HookProvider` that:
- emits the canonical telemetry taxonomy (`agentSpawn`, `preToolUse`, `postToolUse`, `stop`, etc.) to the same JSONL format as the harness adapters
- enforces config protection via `BeforeToolCallEvent` cancellation (the Strands equivalent of a blocking `preToolUse` hook)
- injects workflow steering context at agent construction via `steering_context()`

This is a spike/preview — 76 unit tests pass without requiring the Strands SDK, and the README documents 8 limitations honestly. It demonstrates that the policy engine is not harness-specific.

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

## Human-review gate integration

Library hosts can compose Flow gates with Survey review sessions without adding
a new gate kind or trusting browser-authored decisions. Use
`discoverSurveyGateReviewWork` to read explicitly classified missing review
expectations from an exact, persisted Flow Run head. A producer then creates the
canonical candidate-bearing `ReviewItem`; `bindSurveyGateReviewItem` validates
its claim targets and adds immutable workflow correlation, while
`publishSurveyGateReviewWork` publishes it through a host-owned queue.

After the server-owned review session is complete,
`continuePausedFlowGateFromSurvey` resolves the opaque session reference,
derives the canonical outcome, asks Survey to project the complete reviewed
trust input from its authoritative `ReviewItem`s and results, and delegates the
atomic attach/evaluate/resume transaction to Flow. Candidate construction,
queue persistence, review authority, and lifecycle authority remain separate
capabilities.

## Portable host integration

Flow Agents consumes `@kontourai/conduit` for the host-facing lifecycle and
portable-asset boundary. Application policy still runs in Flow Agents; its
model-visible context and deny outcomes are projected unchanged through a
configured host adapter. Skills, agents, hooks, prompts, commands, and context
assets use Conduit installation receipts, while Flow definitions, kits, gates,
sidecars, and evidence remain Flow Agents contracts.

`npm run host-conformance` executes Conduit's external probe against one local
harness binding and one in-process framework binding, then generates the
[host integration matrix](docs/specs/host-integration-conformance.md) and its
machine-readable report. These are adapter-contract results; an actual
deployment records separate host-bound evidence before runtime selection.

## Repository layout

See [Repository Structure](docs/repository-structure.md) for the canonical map. In short:

- `agents/`, `agent-cards/`, `skills/`, `context/`, `powers/`, and `prompts/` are canonical bundle source.
- `src/` and `scripts/` are product, tooling, validation, installer, hook, telemetry, and compatibility source; see [scripts/README.md](scripts/README.md).
- `kits/`, `schemas/`, `packaging/`, `evals/`, `docs/`, and `integrations/` hold Flow Kit assets, contracts, package metadata, evals, durable docs, and optional integrations.
- `dist/`, `build/`, and `_site/` are generated output. Local `.kontourai/`, `.flow-agents/`, `.codex/`, `.claude/`, telemetry, promptfoo, Veritas, and cache directories stay ignored; durable outcomes belong in docs, source, schemas, or provider records.

## Graph provider (opt-in)

The Knowledge Kit ships an optional `neo4j` graph provider — the owner's opt-in personal default, while the file providers remain the portfolio default. It is a queryable **materialized view** synced from the file/work-item stores (which stay the source of truth), with Cypher-backed health/query verbs when selected and graceful degradation to the file providers when no Neo4j is reachable (never a hard dependency). Opt in with `KNOWLEDGE_PROVIDER=neo4j` and see [Graph provider (opt-in)](kits/knowledge/docs/README.md#graph-provider-opt-in) for the `docker run` one-liner, env vars, sync command, and an example Cypher session.

## Documentation

The [GitHub Pages site](https://kontourai.github.io/flow-agents/) is the product overview and quickstart. The repository docs are the developer reference for contracts, workflow behavior, evals, and integration boundaries. For the gate semantics underneath — definitions, runs, evidence, route-back — read the [Kontour Flow documentation](https://kontourai.github.io/flow/).

## License

[Apache-2.0](LICENSE) © Kontour AI
