# Decision Registry Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

How Flow Agents records NEW decisions in the topic-keyed decision registry.
Numbered ADRs under `docs/adr/` are frozen history and are never written for new
decisions (see [Relationship to ADRs](#relationship-to-adrs-and-grill-with-docs)).

**The record format is owned by Corpus.** The
[Corpus decision-record format](https://github.com/kontourai/corpus/blob/main/docs/decisions.md)
is the authority for the frontmatter fields, statuses, relations, evidence
kinds, secret refusal, the generated index, and the numbered-ADR freeze. Corpus
ships the JSON Schema (`@kontourai/corpus/schemas/decision-record.schema.json`)
and the checker. This contract adds only the Flow Agents conventions on top:
where subjects come from, how a decision changes, and when to consult the
registry. Where this file and Corpus disagree about the format, Corpus wins.

`corpus.json` declares the registry (`"decisions": { "adr": { "dir": "docs/adr" } }`).
`npm run check:decisions` runs `corpus decisions check` at a pinned Corpus
commit, and `npm run gen:decisions-index` runs `corpus decisions index`. The
check runs in the required `source-and-static` CI lane.

## Why topic-keyed living records

Numbered ADRs accumulate three failure modes at multi-contributor, multi-repo
scale: contradictions (a new ADR appends a conflicting decision instead of
replacing the old one), bloat (derivation context is inlined alongside the
decision), and numbering collisions (two contributors both grab `0021-`). The
registry removes all three by construction:

- **One file per decision subject**, keyed by a vocabulary noun, not a number.
- **Supersession is an edit**, so the current answer is always the only answer.
- **Derivation context is linked, not inlined**, so files stay lean.

## File location and shape

- Each decision lives at `docs/decisions/<topic-slug>.md`.
- Exactly **one file per decision SUBJECT**. If two questions have the same
  subject, they share a file; if a file is answering two subjects, split it.
- A generated index lives at `docs/decisions/index.md` (see [Index](#index)).
- The file holds ONLY the current decision plus lean rationale. It does not
  inline transcripts, exploration, meeting notes, or superseded prose.

A topic file is YAML frontmatter followed by a short Markdown body:

```markdown
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

The current answer, plus lean rationale. Derivation context is linked via
`evidence[]`, never pasted here.
```

## Slug rules: vocabulary is the namespace

- Slugs are **nouns from the repository's CONTEXT.md domain vocabulary**. The
  ubiquitous language is the topic namespace; topic identity is downstream of it.
- Slugs are lowercase kebab-case: `^[a-z0-9]+(-[a-z0-9]+)*$`, matching a
  glossary term (e.g. the glossary term "Decision Records" ->
  `decision-records.md`).
- **If the subject term is absent from CONTEXT.md, add it to CONTEXT.md first**,
  then create the topic file. This keeps slugs stable and collision-free: two
  contributors deciding the same subject land on the same slug rather than
  competing for the next number.

## Frontmatter, statuses, and evidence

The fields (`status`, `subject`, `decided`, `evidence[]`, and the optional
`supersedes`, `superseded_by`, `merged_into`), the four statuses, and the
evidence kinds are defined in the
[Corpus record format](https://github.com/kontourai/corpus/blob/main/docs/decisions.md#record-format).
Flow Agents uses them this way:

- **`subject`** is a CONTEXT.md vocabulary noun phrase (see [Slug rules](#slug-rules-vocabulary-is-the-namespace)).
- **`needs-decision`** stubs record that a frozen ADR's subject still needs a
  living decision, without inventing an answer. The stub links that ADR as `adr`
  evidence.
- **`session-archive`** evidence points at an archived session artifact under
  `.kontourai/`, promoted at retirement. Grilling and probe transcripts retire
  into the session archive and are linked here as decision provenance, never
  pasted into the record.
- Link durable provenance, never a credential. Corpus refuses secret-shaped refs.

## Supersession by edit

The normal way a decision changes is: **edit the topic file in place.** Update
the body to the new decision, bump `decided`, and add an `evidence[]` ref to the
PR/issue that changed it. There is no second file, no appendix, and no
contradiction — the file always states exactly one current answer.

Example — the pre-edit file:

```markdown
---
status: current
subject: Artifact retention window
decided: 2026-04-01
evidence:
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/120
---

# Artifact retention window

Runtime artifacts are retained for 30 days, then archived.
```

After a later decision to shorten the window, the SAME file becomes:

```markdown
---
status: current
subject: Artifact retention window
decided: 2026-07-01
evidence:
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/120
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/305
---

# Artifact retention window

Runtime artifacts are retained for 14 days, then archived.
```

The old answer is gone from the head; its provenance survives in the linked PRs.

## Tombstones: when a topic moves or merges

Editing covers a decision changing. The rarer case is a SUBJECT moving to a
different slug. Then the old file becomes a tombstone so inbound links and
retrieval still resolve.

### `superseded_by` — the subject moved to another slug

Use when a subject is renamed or split and its answer now lives under a different
slug. The old file:

```markdown
---
status: superseded
subject: Artifact retention window
decided: 2026-07-02
superseded_by: artifact-lifecycle
evidence:
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/330
---

# Artifact retention window

Superseded. The current decision for this subject lives in
[artifact-lifecycle](./artifact-lifecycle.md).
```

### `merged_into` — the subject folded into an existing topic

Use when a subject is absorbed by another existing topic. The absorbed file:

```markdown
---
status: merged
subject: Artifact retention window
decided: 2026-07-02
merged_into: artifact-lifecycle
evidence:
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/330
---

# Artifact retention window

Merged into [artifact-lifecycle](./artifact-lifecycle.md).
```

The surviving file may record what it absorbed with `supersedes: [artifact-retention-window]`.

Both tombstone forms require the target slug to exist (a validator error
otherwise) and must not point at their own slug.

## Retrieval-at-write

Before recording a decision, **consult `docs/decisions/index.md`** (the
always-loaded slug + one-liner index) and decide **revise-vs-create**:

1. If an existing topic covers the subject, **revise that file** (edit in place,
   or tombstone + move if the subject itself is changing identity).
2. If no topic covers it, confirm the subject noun exists in CONTEXT.md (add it
   if absent), then **create** `docs/decisions/<slug>.md`.

This retrieval-at-write step, plus a health check at rest (the validator + index
freshness in CI), is sufficient at this cardinality; no embeddings or semantic
topic matching are required.

## Index

`docs/decisions/index.md` is generated by `npm run gen:decisions-index`
(`corpus decisions index`); see
[the index](https://github.com/kontourai/corpus/blob/main/docs/decisions.md#the-index).
Do not edit it by hand. Run the generator after adding or editing a record.

The index is referenced from `CONTEXT.md` so retrieval-at-write always has a
cheap, loaded pointer into the registry.

## Validation

`npm run check:decisions` runs `corpus decisions check --base "$DECISIONS_BASE"`
(default `origin/main`; CI sets it to the pull request base, or to the pushed
range on `main`). It fails on any record that breaks the Corpus format, on a
missing or stale index, and on any file added under `docs/adr/` since the base.
The full rule list is in
[Corpus's docs](https://github.com/kontourai/corpus/blob/main/docs/decisions.md).

## Relationship to ADRs and grill-with-docs

- **CONTEXT.md is the only external compatibility surface.** Grill-with-docs
  interop reads the domain vocabulary from CONTEXT.md; the registry keys its
  slugs off that same vocabulary. We inherit the grill-with-docs behavior, not
  the numbered-ADR file format.
- **Numbered ADRs (`docs/adr/`) are frozen history.** They are never written
  for new decisions and are never converted into topic files, and their numbers
  stay as they are (including the duplicate 0007). Corpus's adr-freeze gate
  refuses any file added under `docs/adr/`; see
  [Numbered ADRs](https://github.com/kontourai/corpus/blob/main/docs/decisions.md#numbered-adrs).
  A topic file may cite a frozen ADR via an `adr` evidence ref as provenance.

The pilot record self-hosting this contract is
[docs/decisions/decision-records.md](../../docs/decisions/decision-records.md).
