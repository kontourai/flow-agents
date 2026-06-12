---
title: Flow Agents Vision and Direction
---

# Vision and Direction

This page captures where Flow Agents is headed, clearly labeled as direction rather than shipped capability. Shipped artifacts are documented in the [Runtime Hook Surface spec](spec/runtime-hook-surface.html) and the [Runtime and support matrix](index.html#runtime-and-support-matrix) on the overview page.

---

## What ships today

Flow Agents currently ships as a harness adapter layer: six core harness runtimes (base, Claude Code, Codex, Kiro, opencode, pi) receive bundled agents, skills, context, scripts, and hook wiring through the `npx @kontourai/flow-agents init` installer. The four canonical policy classes — workflow steering, quality gate, stop-goal-fit, and config protection — are implemented as canonical scripts under `scripts/hooks/` and wired to each host's native event surface at conformance levels L0, L1, or L2.

One official framework adapter spike exists: `integrations/strands/` is a Python `HookProvider` for AWS Strands that emits the canonical telemetry taxonomy and enforces config protection via tool-call cancellation. It is preview-status with documented limitations.

---

## Flow Kits as an authorable ecosystem

### What ships today

Kit authoring is shipped. The `kit.json` contract at schema version 1.0 is validated by the `flow-kit` CLI before any install. The [Kit Authoring Guide](kit-authoring-guide.html) walks from an empty directory to a validated, locally installed kit. Two reference kits ship in `kits/`:

**Builder Kit** packages the full `idea → backlog → plan → build → review → verify → evidence → release → learning` pipeline as two flows (`builder.shape`, `builder.build`). It installs automatically.

**Knowledge Kit** packages durable gated knowledge storage: a store contract with four record types, five pipeline flows (`ingest`, `compile`, `synthesize`, `consolidate`, `retire`), and a mutation policy of propose→evidence-gate→apply/reject with supersede-not-delete. It ships with 198 tests, a parameterized contract suite that any adapter can run against, and a vector similarity detector (ollama embeddings, pluggable interface).

The output-shape story is the reason kit authoring matters beyond workflow reuse. The Knowledge Kit store contract is representation-neutral — the pipeline is identical, but the rendering layer is swapped by adapter. Today two adapters ship: the default adapter (flat markdown records with YAML frontmatter and a JSON graph index) and the Obsidian adapter (one human-canonical note per record, category→folder hierarchy, configurable frontmatter dimensions, living overviews, superseded notes in `archive/` not deleted). Authors who choose the Obsidian adapter get the same gated workflow rendered into the shape they already think in. That is what kit authoring unlocks: packaging both the process discipline and the output opinion as a deployable unit. (The Obsidian adapter is shipped; layout/dimensions refinements and person/entity card support are in development.)

### Direction: the sequenced path to a kit ecosystem

The items below are direction, not committed delivery dates. They record the intended shape of where this work goes.

**Domain kits composing the substrate.** The store contract, mutation gate, and adapter model are not knowledge-specific. The next intended kits compose this substrate for specific domains: a Sales Kit (territory/customer/initiative schema, flows for managing account snapshots, side-effect adapters for CRM event logging) and a Research Kit (transcript capture→compile→recall with configurable similarity thresholds). Both are direction — not shipped.

**Distribution, sequenced.** A registry of validated kits and a marketplace for kit distribution are the intended end-state. The sequencing is explicit: authoring tooling and covetable reference kits first (shipped), then a registry (direction), then a marketplace (direction). Claims of a shipped marketplace or registry are not warranted.

---

## Direction

The items below are direction, not committed delivery dates. They record the intended shape of where this work goes.

### Kits beyond coding

The process-discipline layer is not coding-specific. The canonical policies, sidecar state model, and evidence taxonomy are defined without reference to source code, build systems, or CI. The direction is deployable agentic workflows — Flow Kits for domains beyond software delivery: knowledge work, research, operations, sales contexts, and personal productivity. The [North Star](north-star.html) records the broader scope.

### TypeScript framework adapters

The Strands Python spike proves the thesis: the policy engine is not harness-specific. The direction is TypeScript framework adapters that consume the canonical policy engine natively via the published `@kontourai/flow-agents` npm package, rather than shelling out to bash scripts. Candidate frameworks include LangGraph, VoltAgent, and the OpenAI Agents SDK. The [Runtime Hook Surface spec](spec/runtime-hook-surface.html) documents the adapter contract and the framework event mapping tables for each.

### Kontour Console as the unifying telemetry surface

Today, telemetry writes to local JSONL files by default, with optional sinks to a local or hosted Kontour Console. The direction is Kontour Console as the unifying surface that spans both harness sessions (Claude Code, Codex, Kiro, opencode, pi) and deployed framework agents (Strands, LangGraph, etc.) — so the same workflow state, evidence, and hook telemetry are visible regardless of which runtime executed the work.

### Conformance kit for community adapters

The runtime matrix includes a "conformance-certified" tier for community and third-party adapters that self-certify at a declared L0, L1, or L2 level. A conformance kit — a test suite and declaration format — is in development. It does not yet ship.

---

## What this is not

Flow Agents is not building another agent runtime, coding assistant, workflow engine, or orchestration control plane. The model, the runtime, the IDE, the agent UI, the workflow engine, and the repo governance engine are all deliberately out of scope. Flow Agents owns the glue: discovery, just-in-time guidance, scoped delegation, Flow-backed workflow state inside agent runtimes, evidence-backed completion, and feedback loops.

See the [North Star](north-star.html) for the full design principles and the [Developer Architecture](developer-architecture.html) for the product boundary map.
