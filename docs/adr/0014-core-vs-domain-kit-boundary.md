---
title: "ADR 0014: Flow Agents core vs domain kits — the generic/kit boundary"
---

# ADR 0014: Flow Agents core vs domain kits

**Date:** 2026-06-25
**Status:** Proposed (decision owner: Brian Anderson). Defines the boundary; code moves are sequenced, not immediate.
Revised after boundary review: `workflow-sidecar` confirmed **core** (the lifecycle engine, with only a few developer-leaning *defaults* to make kit-extensible); Builder Kit reframed as a **first-class pulled-out kit**; `knowledge`/`release-evidence` cited as already validating the substrate.

> **Superseded in part by ADR 0016 (2026-06-26).** The finding that the *bespoke `workflow-sidecar` FSM* is the legitimate core engine is superseded. The core does own a lifecycle **engine**, but per ADR 0016 + 0015 + #183 that engine must be the **FlowDefinition / Resource-Contract-driven** one — the bespoke FSM is a parallel reimplementation of ADR 0005 that retires via ADR 0015's migration. This ADR's boundary *principle* (the agent-blind "dividing test", core vs domain-kit) stands; only the "keep the FSM as core / tweak defaults" conclusion is replaced.

---

## Context

Flow Agents is defined (CONTEXT.md) as *"an operating layer that helps agents route natural
user requests into the right procedures, tools, state, evidence, knowledge, and follow-ups"* —
a **generic, domain-agnostic** layer. The README states the intended composition model:
*"domain kits that compose this substrate — a Sales Kit…, a Research Kit…"*. `kits/` already
holds three: `builder` (developer workflows), `knowledge` (knowledge capture/recall), and
`release-evidence`.

But the structure does **not** reflect this. The entire `agents/` directory is *developer*
tooling (`tool-code-reviewer`, `tool-verifier`, `tool-worker`, `tool-planner`,
`tool-explore-*`, `tool-playwright`), and `context/contracts/{review,verification,execution}`
are *developer* contracts (code-review lanes; build/types/lint/test phases). These live in the
"core" locations (`agents/`, `context/`) yet are consumed only by the **Builder Kit**
(`kits/builder/` has no contracts or agents of its own — it consumes core). The non-developer
`knowledge` kit does not use them.

This surfaced while placing two universal disciplines (fail-loud/no-silent-data-loss from #160;
"a flake is a real defect"): the only "homes" available were developer contracts, which forced
a generic principle into a developer-specific file (#170). The boundary is **implicit**, and
the implicit version conflates the generic operating layer with one domain kit.

## Decision

### 1. The boundary principle

- **Flow Agents (core) owns generic *mechanisms*** that any domain reuses: the workflow
  lifecycle (work-items, states, phases, transitions), the trust substrate (bundle, claims,
  evidence, policies, freshness, status derivation via Surface), the enforcement gates
  (goal-fit, evidence-capture, reground), liveness/coordination (ADR 0012), routing, durable
  persistence, kit installation/runtime adapters, and the **agent operating disciplines**
  (consume-never-fork, fail-loud, evidence-bearing, freshness-gating).
- **A domain kit owns the domain *specifics***: its vocabulary, the concrete workflow shape,
  the domain verification/review *criteria*, the domain *tools*, the domain *schema*, and the
  side-effect *adapters*. Builder Kit is the developer domain kit; Sales/Research/Knowledge are
  siblings.

### 2. The clean test

> **"Would a non-developer domain kit (e.g. `knowledge`, a Sales Kit) need this?"**
> Yes → it is generic → **Flow Agents core.** No → it is developer-specific → **Builder Kit.**

By this test today: the `tool-*` agents (worker/code-reviewer/verifier/planner), the Builder
*skills* (plan-work/execute-plan/review-work/verify-work), the code-review lanes, and the
build/lint/test phases are **Builder Kit**. The lifecycle **engine** (`workflow-sidecar` — it
writes the trust bundle, advances state, records evidence/claims, emits liveness), the trust
substrate, the gates, liveness, and the persistence/data-integrity invariants are **core**.

The only developer lean *inside* the core engine is in its **defaults**, not its mechanism: the
code-specific `checkKinds` (`build`/`types`/`lint`/`test`/`browser`) and some vocabulary
(`init-plan` reads developer-ish; it just means *open a tracked work-item from its defining
artifact* — create its state/acceptance/handoff/trust.bundle and claim it via liveness). Those
defaults should become **kit-extensible** (and the vocab can be neutralized, e.g. `init-plan` →
`init-work`) — a small core cleanup, not a relocation. The engine is core; it is simply not yet
*exercised* by a non-developer kit (`knowledge`/`release-evidence` took the lighter `flows`
path), which is a validation gap, not a sign it is Builder-shaped.

### 3. Kits extend, never reimplement

Domain kits **consume** the generic mechanisms; they must not fork the lifecycle, the trust
substrate, or the gates (consume-never-fork, ADR 0008, applied to kit authors). A kit that
needs different behavior configures or extends the generic mechanism — it does not ship a
parallel one. This is what keeps "an open format that means the same thing everywhere" true
across kits.

### 4. Mixed contracts split: generic invariant (core) + domain extension (kit)

`review-contract` and `verification-contract` are **mixed**. The split:

- **Generic (core):** verify work meets acceptance criteria with evidence; mark `NOT_VERIFIED`
  honestly; **fail-loud, never fail-open** (persistence that silently drops a record is data
  loss, not a degraded mode); **nondeterminism is a defect** (an operation that can pass
  without doing its job is a failure); review against standards with evidence-bearing,
  severity-tagged findings; don't silently pass.
- **Domain (Builder Kit):** the concrete phases (`build`/`types`/`lint`/`tests`/`browser`) and
  review lanes (code quality, security scanning, architecture fit).

The two disciplines from #170 are **generic** and belong in the core invariant layer — so
*every* kit (knowledge persisting a note, a Sales Kit logging to a CRM) inherits them — not in
the developer `review-contract`. **#170 is re-homed here**, not merged as-placed.

## Consequences

- **Protects the core value proposition.** "Generic, domain-agnostic operating layer" is the
  moat; a core that secretly assumes code-review/build/test undermines it for the next domain
  kit author. The clean test (§2) becomes a **standing design gate**, not a one-time cleanup.
- **Re-homes #170** and tells us where future cross-cutting disciplines go.
- **Builder Kit becomes a first-class, pulled-out kit** — the same shape `knowledge` already
  has (its own `kit.json`, flows, skills, and now agents + contracts) — and an *independently
  valuable* product, not a demo. The developer tools (`agents/`) and the developer halves of the
  mixed contracts move into it; the generic invariants consolidate in core. This touches code the
  Phase-4 agents are active in — **define now, move later, coordinate** (no premature big-bang).

## Alternatives Considered

- **Leave the boundary implicit.** Rejected: it leaks developer assumptions into the core and
  blocks clean domain-kit authoring.
- **Refactor the folders first, define later.** Rejected: moving `agents/` and contracts into
  `kits/builder/` is large and conflicts with active Phase-4 work; the *definition* is cheap and
  must lead.
- **Fully purify the core now (extract a grand generic verification/review framework).**
  Rejected as **speculative generality** (the consume-never-fork sibling). The *substrate*
  (gates, Surface claims, flows) is **already proven domain-neutral** by shipping kits —
  `knowledge` and `release-evidence` use it with no developer machinery. What is *not* yet
  exercised by a non-developer kit is the **lifecycle engine** (`workflow-sidecar`); a
  Sales/Research kit that actually uses `init-plan → advance-state → record-evidence → liveness`
  is the real validator, and would surface which engine *defaults* (above) are developer-shaped.
  Build it for a real use case, not as architecture theater. Extract only the invariants that are
  already obviously cross-domain (data integrity, evidence honesty, nondeterminism, freshness).

## Product weigh-in (requested)

1. **The boundary is the moat — treat the clean test as a gate.** Every time something lands in
   `agents/` or `context/`, ask "would the knowledge/Sales kit need it?" If no, it's a Builder
   Kit feature wearing a core costume.
2. **Build out a non-developer kit that uses the lifecycle engine — it is the cheapest way to
   find the true core.** The substrate is already validated; what isn't is `workflow-sidecar`
   under a non-developer domain. A Sales/Research kit that *reuses* `init-plan → advance-state →
   record-evidence → liveness` will expose which engine defaults are secretly developer-shaped
   and de-risk the refactor — *if* there is a real use case (not architecture theater).
3. **Ship the generic disciplines to the core invariant layer regardless** — data-integrity,
   evidence honesty, nondeterminism, freshness are cross-domain today; they should not wait on
   the full refactor.

## References

- CONTEXT.md (Flow Agents definition); README (domain-kit direction).
- ADR 0008 (consume-never-fork), 0010 (trust bundle), 0012 (liveness), 0013 (context lifecycle).
- #170 (the two disciplines, parked pending this boundary); #160 (the fail-open data-loss).
