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
