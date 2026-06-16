---
title: Operating Layers
---

# Operating Layers

Flow Agents should stay understandable by keeping a small public vocabulary. Each layer has one job, one source-of-truth pattern, and one reason to exist.

The layers are ordered from durable context to execution evidence. When adding a new capability, choose the lowest layer that can own it cleanly. Do not create a new layer unless the existing ones make the behavior harder to understand.

For the concrete directory-by-directory source map, generated output policy, runtime state policy, and cleanup rules, use [Repository Structure](repository-structure.md). This page explains conceptual ownership layers; the repository structure page is the durable file-placement reference.

## Layer Map

| Layer | Owns | Does Not Own | Source Pattern |
| --- | --- | --- | --- |
| Rules | Persistent guidance, conventions, boundaries, and defaults | Step-by-step task procedures or tool configuration | `AGENTS.md`, Markdown, frontmatter |
| Skills | Reusable procedures an agent can invoke when a task matches | Always-on policy, credentials, or long-lived memory | Agent Skills / `SKILL.md` |
| Powers | Tool bundles, MCP configs, and activation guidance | Workflow gates or repo-specific policy semantics | MCP, OpenAPI, OAuth/OIDC |
| Agents | Role prompts, delegation boundaries, and scoped tool access | Generic task procedures that should be skills | Harness-native subagents/profiles |
| Workflows | Durable state, gates, handoffs, acceptance criteria, and phase transitions | Domain-specific knowledge records or tool internals | JSON Schema sidecars plus Markdown summaries |
| Knowledge | People, organizations, meetings, decisions, commitments, notes, and follow-ups | Verification verdicts or runtime telemetry | CommonMark, JSContact, iCalendar, JMAP, WebVTT/SRT, JSON-LD |
| Evidence | Proof, telemetry, findings, evals, provenance, and quality outcomes | User-facing procedure instructions | OpenTelemetry, SARIF, CycloneDX, SLSA, JSON Schema |

Governance tools such as Veritas belong at the Evidence boundary. Flow Agents should call them through `context/contracts/governance-adapter-contract.md`, record native artifact refs in `evidence.json`, and leave repo-specific policy semantics with the adapter.

## Current Repo Mapping

| Path | Layer | Notes |
| --- | --- | --- |
| `AGENTS.md` | Rules | Project-level source guidance for agents. |
| `context/` | Rules / Knowledge | Shared guidance, contracts, and reusable context. Prefer specific subfolders or docs when the split becomes clearer. |
| `skills/` | Skills | Shared `SKILL.md` packages exported to supported harnesses. |
| `powers/` | Powers | Optional MCP and capability bundles. A power means a tool surface plus activation guidance, not guaranteed credentials. |
| `agents/` | Agents | Canonical role and specialist definitions. Keep public agent count small; prefer skills for reusable procedures. |
| `agent-cards/` | Agents | Discovery metadata for routable orchestrators. |
| `kits/` | Flow Kits | Kit Catalog entries, Flow Kit manifests, Flow Definitions, and supporting assets. Builder Kit is the first proof point. |
| `prompts/` | Skills / Rules | Saved invocations. Promote repeatable procedures into skills when they grow stable. |
| `docs/workflow-*.md` | Workflows | Human-readable workflow contracts and usage guidance. |
| `.flow-agents/` | Workflows | Cross-session task artifacts. Runtime state stays local and ignored; durable outcomes are promoted into docs, source, schemas, or provider records before merge. |
| `scripts/` | Evidence / Workflows / Packaging | Validation, build, telemetry, hooks, and artifact tooling. |
| `src/` | Workflows / Evidence / Packaging | TypeScript CLI, runtime adapter, Flow Kit, shared library, build, validation, context-map, packaging, and CLI helper source compiled into `build/src/`. |
| `evals/` | Evidence | Static, behavioral, integration, and acceptance checks. |
| `.telemetry/` | Evidence | Runtime telemetry, outcomes, and reports. |
| `packaging/` | Packaging | Cross-harness manifest and bundle docs. |
| `dist/` | Packaging | Generated exports. Never edit by hand. |
| `build/` | Packaging | Generated TypeScript compiler output. Never edit by hand. |
| `_site/` | Docs / Packaging | Generated GitHub Pages output from `docs/`. Never edit by hand. |

## Flow Kit Coordination

Flow owns Flow Definition semantics: gates use typed `expects` entries, Surface requirements use `kind: "trust.bundle"` (the Hachure-aligned gate kind), and project configuration owns trusted producer mappings plus gate overrides. Flow Agents should author, install, adapt, and control those assets for local runtimes; it should not become the authority source for claim trust or override semantics.

The Kit Catalog is the Flow Agents index of installable Flow Kits. A Flow Kit can contain Flow Definitions, skills, docs, adapters, and evals, but the catalog points at those assets instead of defining gate behavior itself. Builder Kit is the first Kontour-authored kit and proves the path from shaping through build, verification, merge readiness, and learning.

Local kit repositories must follow the Flow Kit Repository Contract:
https://github.com/kontourai/flow-agents/blob/main/docs/flow-kit-repository-contract.md

The contract requires a root `kit.json`, declared Flow Definition paths, declared asset paths, and local path-safety rules. Flow Agents validates that repository shape, installs validated local repositories as runtime overlay state, and records provenance metadata; Flow validates the Flow Definition semantics.

Builder Kit vocabulary should be used in public and internal guidance:

- Flow Kit: installable workflow bundle.
- Kit Catalog: index of Flow Kits and their runtime assets.
- Builder Kit: the coding/building kit shipped by this repo.
- Probe: question-driven design and context challenge step, surfaced as `design-probe`.

Builder Kit evidence gates can reference Surface trust state without naming a provider. A trust-backed gate may attach a Hachure trust.bundle ref for the relevant Surface claim, while Flow keeps authority over gate evaluation, trusted producer mapping, and route-back behavior. Surface remains the portable trust-state layer, and Veritas remains an optional producer rather than a required Builder Kit dependency.

## Placement Rules

- Put persistent behavior that should apply before any task starts in **Rules**.
- Put repeatable procedures with activation criteria in **Skills**.
- Put external tools, MCP servers, API integrations, and credentialed capabilities in **Powers**.
- Put role identity, delegation boundaries, and scoped tool access in **Agents**.
- Put phase state, gate decisions, acceptance criteria, and resumable handoffs in **Workflows**.
- Put people, orgs, meetings, notes, decisions, and relationship context in **Knowledge**.
- Put proof, findings, traces, eval results, and quality outcomes in **Evidence**.

Workflow artifacts have their own lifecycle policy:
https://github.com/kontourai/flow-agents/blob/main/docs/workflow-artifact-lifecycle.md

Use `.flow-agents/<slug>/` for local runtime/session state. If in-progress planning needs review or handoff, promote the durable decision, behavior, and evidence summary into normal docs or provider records before merge; keep runtime artifacts out of git.

If a proposed artifact seems to belong to multiple layers, split it. For example, a dependency-checking capability may have:

- a power for the dependency tool
- a skill for the update procedure
- workflow state for a specific update task
- evidence for the scan result

## Core Surface And Kit Filtering

The default Flow Agents surface should remain small. Flow Kits add workflow depth without making every installation carry every concept. The current install implementation still has legacy composition metadata under `packaging/`; treat that as compatibility/build mechanics while the Kit Catalog becomes the product-facing vocabulary.

Do not duplicate full membership lists in prose. Update the canonical kit and packaging metadata, then regenerate the Context Map for the current skill, agent, power, and Flow Kit counts:
https://github.com/kontourai/flow-agents/blob/main/docs/context-map.md

Kit boundaries should be validated by usage data, context budget impact, and whether users can predict what will load before making install filtering the default behavior.

## Design Checks

Before adding or changing a capability, answer:

- Which layer owns this?
- Is there already a standard for the artifact shape?
- Does this need to be globally available, project-local, or task-local?
- Can it be loaded just in time instead of always-on?
- What evidence will show it improved outcomes?
- Does it belong in core, a Flow Kit, or an optional integration?
