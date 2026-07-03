---
status: current
subject: Knowledge store provider
decided: 2026-07-02
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/317
  - kind: doc
    ref: context/contracts/knowledge-store-contract.md
  - kind: session-archive
    ref: .kontourai/flow-agents/decision-registry-shape/decision-registry-shape--idea-to-backlog.md
---

# Knowledge store provider

The Knowledge Kit owns a storage-independent **Knowledge Graph** model — typed
nodes (`note`, `decision`, `issue`, `session`, `person`; extensible), a closed
edge vocabulary (`supersedes`, `merged-into`, `blocks`, `evidence-of`,
`mentions`, `relates`), and provenance on both — with storage and sync as
pluggable **providers**. The same read and health verbs run over every provider.

## Decision

- The normative model + provider interface live in
  `context/contracts/knowledge-store-contract.md`, backed by JSON schemas at
  `schemas/knowledge/{node,edge,proposal,health-report}.schema.json`.
- The write side is **proposals-only**, expressed structurally: a provider's
  `proposeWrite` can only return a proposal whose `status` is the const
  `"proposed"` and MUST NOT mutate the store. Enactment is downstream — the
  git-repo provider renders a decision-registry topic file for the **promote
  sub-flow**; work-item renders a draft `gh` comment/label; markdown-vault
  renders a native frontmatter+wikilink note. This mirrors the store contract's
  `propose → apply/reject` gate rather than forking a new write path.
- Three reference providers ship: **markdown-vault** (a thin read+propose wrapper
  over the existing store adapter — existing skills unaffected), **git-repo**
  (decision-registry tombstones/evidence, CONTEXT.md glossary, learnings), and
  **work-item** (GitHub issues via an injectable `gh` runner, so backlog hygiene
  becomes a knowledge-health pass).
- Health verbs (duplicate detection, dependency-link integrity) are
  **provider-agnostic** functions over `{nodes, edges}` and emit schema-valid
  health reports. A parameterized conformance suite gates every provider.

## Rationale

The portfolio provider pattern (hachure format/adapters; Builder Kit
work-item contract/providers) had not been applied to knowledge, which was fused
to the markdown-vault shape. Rule-of-three passes on stores operated today: a
duplicate backlog issue (traverse#14) caught manually is now caught mechanically
by a graph pass over the work-item adapter. A graph-database provider stays a
gated spike (#318) — adoption waits on a real query failing over file providers,
not speculation.
