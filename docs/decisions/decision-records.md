---
status: current
subject: Decision records
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/310
  - kind: session-archive
    ref: .kontourai/flow-agents/decision-registry-shape/decision-registry-shape--idea-to-backlog.md
---

# Decision records

New decisions are recorded as **topic-keyed living decision records** at
`docs/decisions/<topic-slug>.md`, one file per decision subject. Numbered ADRs
(`docs/adr/NNNN-*.md`) are frozen history and are never written for new
decisions.

## Decision

- Topic files are keyed by decision **subject** slugs drawn from the CONTEXT.md
  domain vocabulary; the vocabulary is the topic namespace. This removes ADR
  numbering collisions and makes topic identity downstream of ubiquitous
  language.
- **Supersession is an edit** to the topic file. Contradicting appendices are
  impossible by construction; the file always holds the current answer plus lean
  rationale. `superseded_by` / `merged_into` tombstones cover the rarer case of a
  subject moving or merging to another slug.
- The context that led to a decision is **linked** to archived session artifacts,
  PRs, and frozen ADRs via `evidence[]`, never inlined. This fixes ADR bloat;
  promotion-as-retirement provides the archive.
- **CONTEXT.md is the only external compatibility surface** (grill-with-docs
  interop). The numbered-ADR file format is not adopted for new decisions — the
  behavior is inherited, not the failure mode.
- Existing ADRs are **frozen and indexed, never converted**; history stays
  immutable provenance. (Freeze tooling is issue #314.)
- Frontmatter is YAML validated by `schemas/decision-record.schema.json`
  (`status`, `subject`, `decided`, `evidence[]`, and the relationship fields),
  enabling machine health checks.
- A generated `docs/decisions/index.md` (slug + one-liner) is referenced from
  CONTEXT.md so retrieval-at-write matching has a cheap, always-loaded index.

## Rationale

Numbered ADRs accumulate contradictions (new decisions append rather than
supersede), bloat (derivation context inlined with the decision), and numbering
collisions at multi-contributor scale — observed across ~6 portfolio repos and
owner-ratified as a redesign on 2026-07-03. Topic-keyed living records make the
current answer to any settled question findable in one place, make supersession
an edit rather than a contradicting appendix, and let multiple contributors work
without colliding on sequence numbers.

flow-agents is the first consumer: this record self-hosts the decision, and the
full normative contract lives at
`context/contracts/decision-registry-contract.md`.
