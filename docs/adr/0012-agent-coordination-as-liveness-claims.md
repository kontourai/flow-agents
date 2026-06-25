---
title: "ADR 0012: Agent Coordination as Hachure Liveness Claims"
---

# ADR 0012: Agent Coordination as Hachure Liveness Claims

**Date:** 2026-06-24
**Status:** Accepted (decided with Brian Anderson, 2026-06-24). Grounded by a round-trip proof against the current Surface kernel; **gated on a Surface dependency bump** (see Consequences).

---

## Context

Multiple agents (and human + agent teams) work the same repo concurrently — this is the
normal case, not the exception. This session *was* the experiment. What actually prevented
collisions was cheap **tolerance** (isolated git worktrees + small PRs + PR/CI
serialization); what *hurt* was (1) **discovery** — agents repeatedly almost-rebuilt
in-flight work because there was no shared "what's claimed" signal — and (2) the **merge
race** (strict up-to-date vs. a fast main).

`pull-work` already speaks `in_progress` and parses "coordinate with" blockers, but it does
**not** *write* a claim or exclude claimed items — the backlog→pull-work loop the system was
designed for is unfinished. The recurring word was **claim**, which is exactly a Hachure
concept: a claim with **evidence** and **freshness**, whose status is **recomputed**.

## Decision

### 1. A work-claim is a Hachure claim under a *liveness policy* — not a new subsystem.

An agent claiming work emits a claim (`claimType: workflow.coordination.hold`) governed by a
**liveness policy** (a `ttlSeconds` window) and kept alive by **heartbeat** (verified)
events. The coordination lifecycle derives from the **existing** Surface status function —
**proven** (5/5) against the current kernel:

| Coordination state | Mechanism | Derived `TrustStatus` |
|---|---|---|
| **held** | claim + heartbeat within `ttlSeconds` | `verified` |
| **reclaimable** | heartbeat lapsed past ttl | `stale` |
| **released** | `revoked` invalidation event | `stale` |
| **taken over** | `superseded` event | `superseded` |
| **reclaimed** | new holder's fresh heartbeat | `verified` |

No new statuses, no new machinery — a claim's nature is defined by its **policy**, and the
liveness policy is a reuse of the duration/ttl freshness logic (`claimIntrinsicExpiry`).
**`stale` is the reaper** I worried about: abandoned claims expire by construction.

### 2. Coordination and verification are *siblings under one subject*, not nested.

The delivery workflow's progress is **not evidence for the reservation** (a heartbeat is). So
the coordination claim and the verification bundle are **co-equal claims about the same
`subjectId`** (the work-item / backlog identity), derived from **one event stream**, linked
by `identityLinks` + an optional `derivationEdges` reference (so "who holds it" can drill into
"and here's their progress"). The work-item identity is the join key; the provider adapter
maps issue → `subjectId` and optionally projects the claim back (label/assignee).

### 3. Resumption via durable evidence — strictly better than a lock.

The coordination claim is **ephemeral** (liveness); the verification evidence is **durable**.
When a holder goes dark, its claim goes `stale` but its evidence **survives** — so the next
agent **resumes from recorded state, not restart**. The *same freshness* that reaps the claim
also tells the resumer which inherited evidence is still valid (fresh) vs. must be re-run
(stale). This generalizes the bespoke `handoff.json`.

### 4. Advisory, not a lock.

A bundle is *additive*; a lock is *mutex*. The recompute is **awareness**, not a seizure.
Actual serialization happens at the **integration layer** (branch/PR/merge-queue). A
false-stale double-hold (two fresh claims on one subject) is **detected** via Hachure
`conflictRules`/`conflictedClaims`, not prevented. This is why **ttl/heartbeat tuning is the
operational risk** — too-tight manufactures false reclaims; keep it advisory and
double-checked against real branch/PR state.

### 5. Flow-owned; Veritas optional; local-first.

- **Hachure:** the schema + a **liveness policy archetype** (a policy shape, *not* a new type).
- **Flow:** owns the shared coordination **stream + recompute** (it is the workflow/event engine).
- **Flow Agents:** `pull-work` emits/heartbeats/releases; a hook **surfaces** "lane X held by A (fresh, PR #n) / lane Y stale — reclaimable."
- **Sink:** local file or **git ref** first (solo + the real model, not a throwaway) → optional hosted relay/provider → optional **Surface/Console** projection (a live activity panel). **Never required-Console.**
- **Veritas:** an *optional* policy layer on top (e.g. "don't merge into a contested lane"); not in the path.

### 6. Policy archetypes — a tight, universal set only.

A small set of status-derivation **shapes** — **evidence-backed**, **liveness**,
**attestation**, **corroboration** — is general enough to live in **Hachure** as a reference
profile (interop + de-dupes our hand-rolled `VerificationPolicy` instances from ADR 0010).
Tuned **instances** stay in the products. Domain policies must **not** go in the format.

## Consequences

- **Completes the backlog→pull-work loop** and serves solo (local file/git-ref) *and* team
  (shared provider/relay) with one model — separation of concerns for context that can't
  hold every task at once.
- **Resumption beats locking**; the same primitive proves verification *and* coordination —
  strong evidence an open trust format is general, not single-purpose (the dogfood *is* the
  justification).
- **Prerequisite (proven):** flow-agents depends on `@kontourai/surface@^1.0.1` and installs
  **1.0.1**, which *predates* the `ttlSeconds`/`claimIntrinsicExpiry` liveness logic. The
  round-trip **fails on 1.0.1 and passes on 1.2.1**. So this is gated on **bumping Surface to
  ≥1.2.x** (which also benefits the existing trust bundles' freshness).
- TTL/heartbeat defaults must be configurable; the layer stays advisory.

## Alternatives Considered

- **Hard lock (lease server / branch CAS).** Rejected as the primary: stale leases orphan
  work; you can't predict an agent's file footprint at claim time; prevention you'll mispredict.
- **Issue-marking only (label/assignee in-progress).** Good *thin* layer, but solves
  work-*item* collision, not work-*area* (file) collision — which is what actually bit us — and
  needs TTL/atomicity anyway. Necessary, not sufficient.
- **A bespoke coordination subsystem / new statuses.** Rejected: square-peg; express it as a
  policy archetype and reuse the status function.
- **Veritas owns lane-conflict.** Rejected: that's awareness/shared-state (Flow), not
  policy-compliance (Veritas). Veritas is optional on top.

## References

- [ADR 0010: Workflow Trust State as a Hachure Trust Bundle](./0010-workflow-trust-state-as-hachure-bundle.md) — the verification sibling.
- `@kontourai/surface` `src/status.ts` — `deriveTrustStatus`, `claimIntrinsicExpiry`, terminal-event fold (the proven kernel).
- Round-trip proof: `held→stale→released→superseded→reclaimed` (5/5 on Surface 1.2.1; fails on 1.0.1).
- `handoff.json` (bespoke resumption precedent); flow-agents#137 (`pull-work` claim wiring); kontourai/surface#95 (`mcp --input` ingestion).
