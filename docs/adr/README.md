---
title: ADR Directory (Frozen)
---

# Architecture Decision Records — FROZEN

**This directory is frozen immutable history. Do not add ADR 0023, and do not
edit the numbered ADRs here** (each carries a `FROZEN — immutable history.`
banner). The numbered `docs/adr/NNNN-*.md` files are preserved as provenance for
the decisions that shaped Flow Agents; their subjects have been carried forward
into the topic-keyed decision registry.

See [`index.md`](./index.md) for the generated list of frozen ADRs.

## Where decisions live now

New and superseding decisions are recorded as **topic-keyed living decision
records** under [`docs/decisions/`](../decisions/index.md), one file per decision
**subject** (a noun from the `CONTEXT.md` glossary), never as a new numbered ADR.

- Contract: [`context/contracts/decision-registry-contract.md`](../../context/contracts/decision-registry-contract.md)
  — the normative rules for topic slugs, frontmatter, evidence, and supersession.
- Frontmatter schema: `schemas/decision-record.schema.json`.
- Validate + regenerate the index: `npm run check:decisions` /
  `npm run gen:decisions-index`.
- Glossary: [`../decisions/decision-records.md`](../decisions/decision-records.md)
  explains the registry model; `CONTEXT.md`'s **Decision Records** / **Decision
  Registry** terms are the vocabulary.

## How to record a decision

1. Consult [`../decisions/index.md`](../decisions/index.md) to decide
   **revise-vs-create**: if the subject already has a topic file, edit it
   (supersession is an edit); otherwise create `docs/decisions/<subject-slug>.md`
   using a subject noun from `CONTEXT.md` (add the term first if absent).
2. Fill the frontmatter (`status`, `subject`, `decided`, `evidence[]`) per the
   registry contract, then run `npm run gen:decisions-index` and
   `npm run check:decisions`.
3. Each frozen ADR whose subject you are ratifying is already linked from its
   `needs-decision` stub's `evidence[]`; flip that stub's `status` to `current`
   and add rationale rather than starting a new file.

Agent **probes** gain a dedicated docs-write contract for authoring decision
records in [#311](https://github.com/kontourai/flow-agents/issues/311); until
then, decisions are recorded by the mechanism above.
