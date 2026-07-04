---
status: current
subject: Graph knowledge provider
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/327
  - kind: doc
    ref: docs/spikes/graph-provider-2026-07.md
  - kind: doc
    ref: context/contracts/knowledge-store-contract.md
  - kind: adr
    ref: docs/decisions/knowledge-store-provider.md
---

# Graph knowledge provider

The Knowledge Kit ships a `neo4j` knowledge-store provider: a real, queryable
graph implementation of the #317 read interface, synced from the file/work-item
providers. It is the OWNER'S OPT-IN personal default — the file providers remain
the portfolio default. This decision explicitly overrides the #318 spike's
defer-as-default verdict at the owner's request ("I still want the graph
implementation even if it's not the default — it can be my default").

## Decision

- **Engine: Neo4j Community 5 over Docker.** The #318 spike compared Neo4j and
  Kuzu; Kuzu was abandoned upstream (Oct 2025, repo archived), so Neo4j — actively
  maintained, with the Browser for human exploration and the portable Cypher
  baseline — is the engine when a graph is used. Kuzu, Aura/hosted, and
  graph-as-primary-storage are non-goals.
- **The graph is a materialized VIEW, never an authority.** File stores stay the
  source of truth. A `sync` command reuses the #317 providers as READERS (no
  forked extractors) and MERGEs their combined graph into Neo4j idempotently
  (content-keyed hash guard: a re-sync of unchanged stores reports zero writes),
  recording a snapshot digest + timestamp. The write side is proposals-only, like
  every other provider — the graph never bypasses the human-curated stores.
- **Connection by reference, never hardcoded.** Credentials resolve from
  `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` (this repo does not consume
  `@kontourai/datum` yet, so we follow the existing env-reference precedent; a
  future datum adoption resolves the same three names without touching call
  sites).
- **Cypher-backed query/health verbs when selected.** The five canonical spike
  queries (transitive blocker closure, contradiction candidates, node-type-aware
  orphans, duplicate candidates WITH 5-char stemming, shortest path) run as live
  Cypher when a Neo4j is reachable and fall back to a portable JS spelling
  (same answers) otherwise. The stemming lesson is preserved: exact title tokens
  missed the traverse#14~#8 duplicate; stemming catches it.
- **Never a hard dependency.** `neo4j-driver` is an optionalDependency, lazily
  imported. A missing driver OR an unreachable server degrades to the file
  providers with a single clear message. CI has no Neo4j: unit tests + the
  conformance suite run against an injected fake driver; the live integration
  test is gated on `NEO4J_URI` (or a detected Docker Neo4j) and skips loudly.
- **Selection is config-driven, default file.** `KNOWLEDGE_PROVIDER=neo4j`
  (repo/user-level) opts in; anything else stays on the file providers. See the
  README "Graph provider (opt-in)" section for the owner path.

## Consequences

The one-off spike wins (a missing blocker edge, ADR-0007 contradiction, the
near-duplicate canary trio) become a standing capability without forcing graph
ops on any repo or workflow that does not opt in. The provider passes the same
#317 conformance suite as the file providers on its read side.
