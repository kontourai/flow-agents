---
title: "ADR 0013: Context Lifecycle — Workflow-Boundary Compaction, Freshness-Gated Reuse, and the Learning Split"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0013: Context Lifecycle

**Date:** 2026-06-25
**Status:** Accepted as direction (decided with Brian Anderson, 2026-06-25). Implementation phased.

---

## Context

A long agent session produces good results partly because the *conversation* holds the
thread — the corrections, the discoveries, the accumulated repo model. But that thread is
ephemeral: it does not survive a fresh session, and within a session it degrades the model
(attention and reasoning fall off as context grows; cost rises). The goal is the *feeling* of
an infinite session — let it run, or start fresh, and get very similar results — driven by the
**durable system** (ADRs, issues, trust bundles, `state.json`, the gates, the context-map,
skills), **not** by the chat history.

We already have most of the substrate: durable per-task **trust bundles** keyed by
`subjectId`; **freshness** (the liveness/duration + commit-window machinery from ADR 0012);
the **liveness stream** indexing in-progress work; `context-map --check` for repo-structure
freshness; and the `learning-review` loop. What is missing is the *wiring* that turns these
into a context lifecycle — and a decision about **what may evolve where**, so the kit stays
deterministic and reproducible.

## Decision

### 1. The workflow boundary is the context boundary (selective compaction)

A workflow is a bounded unit of work; **`pull-work` (the start of a workflow) is the clean
seam to reset context.** A new workflow rebuilds its context from durable artifacts (the work
item, ADRs, context-map, prior bundles) — not the prior conversation. The *feel* of an
infinite session is therefore **a seamless sequence of fresh-context workflows seamed at
`pull-work`**, with the system carrying continuity: the model stays sharp (fresh window per
item); the experience stays continuous (durable state).

Compaction is **selective, not automatic.** Follow-on work that *shares a lane* with the
current work benefits from the warm context; unrelated work does not. `pull-work` already
reads the signal — the liveness lane / `subjectId` / dependency graph — so the rule is:
**suggest a fresh/compacted context when the new workflow's lane is disjoint from the
current; keep the context warm when it is a continuation.** `pull-work` *suggests*; the
operator (or a policy) decides.

### 2. Freshness-gated context reuse (don't rebuild what's fresh; don't trust what's stale)

To limit rebuilding context without relying on stale information, **reuse context gated by
freshness** — the trust primitive applied to context:

- the **trust bundle** (per work-item, by `subjectId`) **is** the durable context of that work
  — read it instead of re-deriving;
- **freshness** is the **stale-guard** — reuse claims that are still fresh; re-derive only what
  has gone stale (e.g., the commit window moved);
- the **liveness stream** is the index of in-progress work — the entry point to *glean*;
- `context-map --check` is the same pattern one level up (re-survey only changed structure).

**Gleaning in-progress work** (a prior session's, or another developer's once the stream is
shared per ADR 0012's cross-machine sink) **must respect claim *status*.** In-progress work is
mid-flight — its claims are `proposed`/`assumed`, not `verified`. Glean the *intent* and the
*verified* facts; treat unverified claims as provisional. This is the line between "I see what
they're attempting" (safe) and "I'll build on their unproven conclusions" (the stale-info
trap). The status field is the guard.

### 3. The learning split — three buckets; the kit does not self-evolve per machine

Self-improvement is **not one mechanism**. Conflating these would let the kit mutate its own
behavior on each user's machine — a thousand divergent kits, the opposite of the open,
deterministic, reproducible format the product *is*. The split:

- **User-project knowledge** (docs, context, the project's `AGENTS.md` about *their* codebase)
  is **data.** The learning loop that captures it **ships in the kit** as a feature, operates
  **per-project**, and is *expected* to diverge.
- **Kit discipline** (consume-never-fork, the vocabulary rules, "flakiness ⇒ real bug") is
  guidance for *any* agent using the kit, so it ships in the kit — but it is **code/versioned,
  encoded by us, uniform across users.** It does **not** self-modify on user machines; it
  improves when *we* ship a new version.
- **Model/agent tendencies** (e.g. sycophancy) belong to the **agent**, not the kit or the
  project — a different home (the agent's own disciplines). Encoding a model quirk into a
  shipped kit is a category error.

**The invariant:** the kit (including the learning loop) is *uniform and versioned*; what it
*learns per project* is *data* and diverges. Same app, different user data. The thing that must
**never** diverge per machine is the kit's *behavior*.

### 4. The self-encode mechanism — the learning loop + a confirmation gate

Operating lessons self-encode through the existing loop, **extended to an
`operating-agreement` claim type, with a propose→confirm gate** (zero-touch self-encoding is
rejected — it produces a brittle, over-fit, self-contradicting rulebook):

1. **Detect candidates** at workflow close (where `learning-review` runs): scan for *behavior*
   signals — human pushback, redos, reverts, "you already built that," self-critique flags.
2. **Propose** (never auto-apply): surface the candidate agreement with its motivating
   evidence.
3. **Confirm + distill** — the gate. A human (or a very-high-bar reviewer) accepts / rejects /
   edits and generalizes the instance into a principle. **Without this gate, do not build it.**
4. **Encode as a structured claim** (`subject: operating-discipline`, `evidence: [corrections]`,
   `status`, `freshness`) — the human-readable `AGENTS.md` is a *projection* of these claims,
   so it is queryable, versioned, and decayable, not a doc that rots.
5. **Apply *relevant*, decay by freshness** — future sessions load agreements **filtered by
   workflow type / lane** (not the whole rulebook), at session/workflow start; unused or
   repeatedly-overridden agreements go stale and flag for review.

**The escalation ladder** — `correction → advisory context → gate check → merge-readiness
criterion` — exists in two contexts with *different drivers*, and **neither is the kit
self-evolving**:

- For **kit discipline**, the ladder is **our internal dogfooding dev process** (we run the kit
  on the kit, catch what it does wrong, and the *output is a PR / ADR / version bump* — never
  runtime self-modification).
- For **user-project agreements**, the kit *offers* users the ability to promote *their*
  agreements to *their* gates — **user-driven configuration of their data**, not the kit
  autonomously adding a gate.

## Consequences

- **Stopping stops mattering.** Once a session's operating lessons live in the loop (or shipped
  kit guidance) rather than the chat, a fresh session reproduces the quality — so restart is
  free, and "infinite" is a UX property, not a context-length goal.
- **Determinism is protected** — the kit's behavior is uniform and versioned; only per-project
  *data* diverges.
- **Context cost drops** — reuse-gated-by-freshness avoids rebuilding what's still valid and
  avoids trusting what's stale; selective compaction keeps windows small without losing warm
  context for continuations.
- **Costs (eyes open):** (1) selective-compaction and gleaning need the lane/overlap +
  status signals to be reliable (depends on ADR 0012 maturing); (2) the meta-learning loop
  only automates the *second* occurrence of a lesson — a human still catches each *novel*
  class of drift once (this is permanent, and fine); (3) the propose→confirm gate is human
  effort (kept cheap, but not zero).

## Alternatives Considered

- **One long (infinite) session.** Rejected: fights model degradation and cost; the right
  target is *session-independence* (cheap restart, identical results), not session-immortality.
- **A hand-written `AGENTS.md` as the end-state.** Rejected as the *end-state*: it is the loop's
  *seed* (initial state), not an alternative to it; left alone it rots.
- **Zero-touch self-encoding of lessons.** Rejected: without a confirmation gate it over-fits
  and contradicts itself; judgment must gate the rulebook.
- **A self-evolving kit (per-machine).** Rejected hard: violates the determinism/reproducibility
  thesis — a thousand divergent kits. Kit behavior is versioned; only project *data* diverges.
- **Always rebuild context fresh / always reuse.** Rejected: rebuild-always is wasteful;
  reuse-always trusts stale data. Freshness gates the choice per claim.

## References

- [ADR 0010](./0010-workflow-trust-state-as-hachure-bundle.md) — trust bundle as durable context.
- [ADR 0012](./0012-agent-coordination-as-liveness-claims.md) — liveness/freshness, `subjectId`
  correlation, the shared stream and cross-machine sink, resumption-via-durable-evidence.
- `learning-review` skill; `gate-review` / self-critique; `context-map --check`; `pull-work`.
