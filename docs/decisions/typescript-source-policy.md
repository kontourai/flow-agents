---
status: current
subject: TypeScript-first source policy
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0006-typescript-first-source-policy.md
  - kind: session-archive
    ref: .kontourai/flow-agents/kontourai-flow-agents-311/kontourai-flow-agents-311--deliver.md
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/311
---

# TypeScript-first source policy

Kontour product and runtime source defaults to TypeScript across Flow, Flow
Agents, Surface, Veritas, and `kontourai.io`. New durable product code, runtime
adapters, package APIs, CLI behavior, workflow orchestration, hooks, provider
bridges, and shared contracts are authored in TypeScript by default in
repositories that are TypeScript-enabled or migrating toward TypeScript.

## Decision

- TypeScript-enabled repositories expose a typecheck or build validation that
  proves the authored TypeScript surface compiles, and CI runs that validation
  before code is treated as releasable.
- Narrow JavaScript/MJS/CJS exceptions remain acceptable: package/tool
  configuration that expects JS/MJS, generated docs/site assets, thin
  shell-adjacent launchers, fixtures/examples/tests following existing local
  convention, and historical archived/vendored/generated artifacts that are not
  edited as active source. Exceptions stay narrow — expanding product/runtime
  behavior in JS/MJS is a deliberate exception or routed into a migration plan.
- Repositories with nontrivial non-TypeScript runtime source track staged
  migration through repo-specific issues rather than being grandfathered as
  permanent direction (see the original inventory and linked migration issues
  in the frozen ADR below).

## Rationale

Cross-repo shared source, contracts, adapters, and workflow tooling need a
consistent default language, or new work deepens fragmentation and turns every
existing non-TypeScript file into an implicit permanent exception. This is a
purely technical, already-settled call: the frozen ADR below made the decision
on 2026-05-31 and it has not changed. This entry upgrades the ADR-freeze
cutover's `needs-decision` stub for this subject (issue #314) to a living
decision — nothing new is decided here beyond recording that the frozen ADR's
call still stands, per the Probe docs-write contract's worked example
(`context/contracts/probe-docs-write-contract.md`).
