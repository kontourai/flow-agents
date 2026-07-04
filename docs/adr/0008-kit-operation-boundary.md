---
title: "ADR 0008: Kit Operation Boundary"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0008: Kit Operation Boundary

**Date:** 2026-06-15  
**Status:** Accepted

---

## Context

A kit is the SEAM where Flow and Flow Agents meet: Flow owns the container (manifest + flows), Flow Agents owns the extension (skills, adapters, docs, activation), and a kit fuses both into one package. So "which layer owns an operation on a kit?" is ill-posed whenever the operation touches both halves.

Of the kit operations: `validate` touches only the container (cleanly Flow); `activate` touches only a specific agent runtime — codex-local/strands-local (cleanly Flow Agents); `install` and `inspect` STRADDLE the seam.

A concrete duplication was found motivating this: flow-agents reimplements Flow's container contract — `src/flow-kit/validate.ts` has its own `validateCoreContainer` (schema_version/id/name/flows), while Flow exposes the authoritative `validateKitContainer` from its `src/index.ts`, and flow-agents does not even depend on `@kontourai/flow`. The two contracts can silently drift.

This ADR records the design decision reached with Brian Anderson on 2026-06-15.

---

## Decision

### The Dividing Test

Does the operation need to INTERPRET the agent extension (what a skill or adapter MEANS), or only the container (manifest + flows + the *names* of declared asset classes)? Container-only → Flow. Extension-interpreting → Flow Agents.

### Flow Owns the Agent-Blind Kit Operations

`flow kit validate`, `flow kit install` (fetch + validate + place a kit package), `flow kit inspect` (container validity + flows + declared asset-class NAMES — the K0/structural view). Flow knows NOTHING about what a skill or adapter means.

### Flow Agents Owns the Extension Operations

`flow-agents kit activate` (wire the extension into a runtime), plus the extension-interpreting augmentation of install (place skill/adapter assets) and inspect (interpret asset classes → K1/K2 + runtime targets). Flow Agents COMPOSES on Flow's primitives; it never reimplements them.

### The Agent-Blind Guardrail

Flow's kit operations must NEVER interpret extension semantics — fetch, validate, place, report-structure, full stop. Holding this line keeps Flow's operations genuinely generic even though flow-agents is currently the only consumer; the line between the layers is precisely "does it interpret the extension?"

### DRY via Delegation

flow-agents depends on `@kontourai/flow`, deletes `validateCoreContainer`, and delegates all container work to Flow's primitives. The container contract lives ONCE, in Flow.

### Flow Agents Is the Reference Consumer

Flow Agents is the worked example for any future producer building on Flow — lean on Flow's agent-blind primitives, add your own extension layer in your own CLI.

---

## Consequences

### CLI Surface

`flow kit <validate|install|inspect>` (container, agent-blind) and `flow-agents kit <install|inspect|activate>` (extension-composing). The standalone `flow-kit` binary and the flat `flow validate-kit` verb are deprecated with aliases.

### Position C Adopted

This adopts position C (generic kit operations live in Flow) over position B (whole-kit lifecycle stays in flow-agents). C was chosen because doing it twice (B now, migrate later) is wasteful, and the agent-blind guardrail removes the premature-abstraction risk that motivated B.

### Breaking CLI Change

Breaking CLI change on published 1.x in BOTH repos → deprecation aliases + a coordinated release.

### Separate-Product-Ready

Because the primitives live in Flow with flow-agents as a consumer, Flow Kits could later be productized (container + primitives + marketplace) without re-architecture.

---

## Alternatives Considered

### Position B (kit lifecycle entirely in flow-agents, defer generic Flow ops)

Rejected. Defensible short-term (flow-agents is the only layer that comprehends a whole kit today) but causes a double-migration; the agent-blind guardrail makes C's genericity real now, removing B's main justification.

### Position A (container ops = Flow, runtime ops = flow-agents, by category)

Rejected earlier in the discussion — kits are not pure containers, so a category split mislocates install/inspect.

---

## References

- [ADR 0007: Flow / Skill / Kit / Tool Boundary](./0007-flow-skill-kit-tool-boundary.md) — the skill/tool boundary; same conversation.
- GitHub #62 (Builder Kit skill placement), #50 / #79 (marketplace / trust layer), #52 / #60 (agentless gate-eval proving Flow Definitions are agentless-capable).
- kontourai/flow container spec (flow PR #67) — establishes Flow owns the container contract + `validateKitContainer`.
