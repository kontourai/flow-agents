---
status: current
subject: Knowledge promote sub-flow
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/313
  - kind: doc
    ref: context/contracts/knowledge-store-contract.md
  - kind: doc
    ref: context/contracts/decision-registry-contract.md
  - kind: session-archive
    ref: .kontourai/flow-agents/decision-registry-shape/decision-registry-shape--idea-to-backlog.md
---

# Knowledge promote sub-flow

Session promotion runs through a Knowledge Kit FlowDefinition
(`kits/knowledge/flows/promote.flow.json`, id `knowledge.promote`) with four
steps — **ingest → distill → link → health** — so promotion quality stops
depending on which agent did it. This is the first codebase-facing Knowledge Kit
flow and the first "flow within a flow".

## Decision

- **Four steps.** *ingest* reads a completed session dir (read-only) for its
  plan/evidence/critique/learnings/transcripts; *distill* produces DRAFT deltas —
  decision-registry topic files (validated against
  `schemas/decision-record.schema.json` before proposing), CONTEXT.md vocabulary
  additions, and `docs/learnings` entries; *link* attaches provenance (PR, merge
  SHA, session-archive path, touched topics) as `evidence[]` refs; *health* runs
  contradiction detection over the topic files.
- **Built on the #317 provider interface, not a forked reader.** Health reads the
  registry through the git-repo knowledge-store provider and reuses the
  provider-agnostic `duplicate-detection` verb: two topics with overlapping
  subject nouns and divergent content are a contradiction. The report names BOTH
  topics; a **merge-repair PROPOSAL** (schema-valid, `status: "proposed"`) names a
  merge target. Merge-repair is a proposal, never an auto-edit.
- **Proposals-only (R4).** The sub-flow NEVER writes docs directly. Every output
  lands under `<session>/proposals/`; the promote step's human/agent applies the
  drafts it accepts. A filesystem diff during a run shows zero writes outside the
  session/proposal dir.
- **Composition.** `knowledge.promote` is a true composable FlowDefinition — a
  parent step can `uses_flow: "knowledge.promote"` and the resolver resolves its
  gates (it `exports` every gate claim). It is invoked standalone AND from the
  Builder promote step. The builder edge is a **documented composition** (the
  deliver skill's promote step names it as the assisted path) rather than a nested
  builder gate, because #312's `promote` CLI — not a flow gate — is the recording
  mechanism, and the sub-flow's outputs are proposals a human/agent applies.

## Rationale

Knowledge Kit had the verbs (capture, compile, link, health) pointed at personal
knowledge; the codebase was the missing consumer. Promotion (once gated by #312)
still relied on ad-hoc judgement about WHAT to promote. Making the promote step
run a Knowledge Kit pipeline over the session artifacts gives the codebase its
knowledge use case as a composable sub-flow, while proposals-only discipline and
the shared #317 provider interface keep it from forking a second reader or writing
into a human-curated store.
