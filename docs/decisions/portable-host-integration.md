---
status: current
subject: Portable host integration boundary
decided: 2026-07-22
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/846
  - kind: issue
    ref: https://github.com/kontourai/conduit/issues/8
  - kind: issue
    ref: https://github.com/kontourai/conduit/issues/9
---

# Portable host integration boundary

## Decision

Flow Agents consumes `@kontourai/conduit` as the owner of portable host adapter
contracts: lifecycle projection, context and deny fidelity, portable asset
installation receipts, capability declarations, and executable host
conformance. Flow Agents continues to own its workflows, kits, gates, sidecars,
evidence semantics, prompts, and policy implementations.

Flow Agents passes its policy-produced `LifecycleOutcome` and compiled portable
assets to a configured Conduit `AgentHostAdapter`. It does not translate an
agent loop into model calls, discover host configuration, or create a parallel
runtime adapter contract. Model invocation remains a separate capability.

The tracked conformance report exercises a local manifest harness binding and
an in-process framework binding through Conduit's public probe. It is explicitly
`adapter-contract` evidence, not live-host certification. Runtime selection
requires host-bound evidence from the actual deployment.

## Consequences

- Deny reasons and model context cross the host boundary unchanged.
- Installation receipts contain identities and digests, not asset contents,
  resolved paths, or credentials.
- Non-native fidelity and failed probes generate stable, product-neutral
  limitation entries; explanatory runtime claims remain in the owning profile.
- Kiro and pi are not added to this integration until Conduit has executable,
  evidence-backed profiles for their public extension surfaces.
- Flow definitions remain Flow-owned assets and are not reclassified as generic
  host-installation assets.
