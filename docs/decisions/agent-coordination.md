---
status: current
subject: Agent coordination
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0012-agent-coordination-as-liveness-claims.md
  - kind: adr
    ref: docs/adr/0021-assignment-leases-and-stale-claim-takeover.md
  - kind: doc
    ref: docs/coordination-guide.md
---
# Agent coordination

**Decision.** Parallel-session coordination is a **two-stream join**: an ephemeral,
TTL-reaped **liveness** stream ("who is working now") and a durable **assignment** record
("who owns this") are joined at read time by `computeEffectiveState()` into one of four
effective states — `free`, `held`, `reclaimable`, `human-held`. Selection, entry, and publish
are policies over that join. The model is **advisory by default with exactly one hard fence**
(the verify-hold publish gate), which itself enforces only for stable identities against durable
conflicts and degrades to advisory otherwise.

This is the **living reference**, kept current: [`docs/coordination-guide.md`](../coordination-guide.md).
The frozen ADRs ([0012](../adr/0012-agent-coordination-as-liveness-claims.md),
[0021](../adr/0021-assignment-leases-and-stale-claim-takeover.md)) remain immutable provenance
for *why* each decision was made.

**Rationale.** Two independent signals degrade gracefully when one is missing (liveness alone
can't tell a crash from a finish; assignment alone can't tell an active owner from a stale
lease), and an advisory-by-default posture keeps false blocks cheap while concentrating the one
place a false *miss* is expensive — publish — into a single, carefully-tuned gate.

**Shipped as** #287 (actor identity), #288 (liveness default-on), #289 (branches), #166
(pull-work), #320 (overlap detect-and-correct), #290 (AssignmentProvider), #291 (ensure-session
ownership guard), #292 (stop-hook clean release), #293 (verify-hold publish gate). Forthcoming:
#294 (takeover protocol), #398 (CI-runtime actor identity). The optional fleet tier is
[Flow Agents × Console](../integrations/flow-agents-console.md).
