---
title: ADR 0001: Flow Agents Consumes Flow For Workflow Enforcement
---

# ADR 0001: Flow Agents Consumes Flow For Workflow Enforcement

Date: 2026-05-24

## Status

Accepted

## Context

Flow Agents has been accumulating workflow sidecars, hooks, gate checks, evidence records, runtime exports, skills, provider settings, and Console ideas. That made the product useful, but it also blurred product boundaries with Kontour Surface and Kontour Veritas.

Surface already owns portable product transparency: claims, evidence, policies, freshness, gaps, and trust snapshots. Veritas already owns repo and AI-agent governance: repo standards, requirements, evidence checks, change guidance, and merge readiness.

Generic workflow enforcement is broader than Flow Agents and narrower than Veritas. It needs a focused owner.

## Decision

Flow Agents will consume Kontour Flow for generic workflow enforcement instead of owning the generic enforcement kernel.

Flow owns:

- Flow Definitions
- Flow Runs
- steps
- gates
- transitions
- gate evidence
- exceptions
- continuation
- Flow Reports

Flow Agents owns:

- work modes
- skills
- provider settings
- runtime adapters
- native harness hooks
- useful Flow-backed workflow Kits
- Console views for agent users
- local-first setup and runtime exports

Veritas remains an optional development governance evidence provider for Flow-backed Build workflows.

## Consequences

Positive:

- Flow Agents stays focused on agent-facing interoperability and seamless workflow enforcement.
- Flow can serve non-agent or future agent consumers without inheriting Flow Agents-specific runtime concerns.
- Veritas stays focused on repo/change governance rather than generic process state.
- Surface remains the shared transparency foundation underneath both Flow and Veritas.

Trade-offs:

- Flow Agents has to map existing sidecars into Flow concepts over time.
- There is one more Kontour product boundary to explain.
- Until Flow has a package, Flow Agents keeps its existing sidecar writer and hooks as the local implementation surface.

## Alternatives Considered

### Keep Workflow Enforcement In Flow Agents

Rejected because it would make Flow Agents responsible for both the agent-facing distribution and the generic process enforcement kernel.

### Put Workflow Enforcement In Veritas

Rejected because Veritas should remain centered on repo standards and merge readiness.

### Use Surface Directly

Rejected because Surface represents trust state but does not define process steps, gates, transitions, or continuation semantics.
