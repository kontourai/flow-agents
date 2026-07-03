# Decision Registry Contract

Normative contract for the topic-keyed decision registry. This is the source of
truth for how NEW decisions are recorded in a Kontour repository. Numbered ADRs
under `docs/adr/` are frozen history and are never written for new decisions
(see [Relationship to ADRs](#relationship-to-adrs-and-grill-with-docs)).

Machine-checkable structure lives in `schemas/decision-record.schema.json`; the
validator/generator is `scripts/check-decisions.cjs`, exposed as
`npm run check:decisions` and `npm run gen:decisions-index` and wired into the
required `source-and-static` CI lane.

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

## Frontmatter fields

Validated by `schemas/decision-record.schema.json`:

| Field | Required | Meaning |
| --- | --- | --- |
| `status` | yes | `current` \| `superseded` \| `merged` \| `needs-decision` (see [Status](#status-values)). |
| `subject` | yes | The decision subject, a CONTEXT.md vocabulary noun phrase. |
| `decided` | yes | ISO date `YYYY-MM-DD` the current decision was ratified. |
| `evidence[]` | yes | `{kind, ref}` links to durable provenance. Never a secret. |
| `supersedes[]` | no | Topic slugs whose subjects this file absorbed. |
| `superseded_by` | when superseded | The slug that now carries the answer. |
| `merged_into` | when merged | The slug this subject was folded into. |

### Status values

- **`current`** — this file holds the live answer for its subject. Must not
  carry `superseded_by` or `merged_into`.
- **`superseded`** — a tombstone: the subject moved to a different topic slug
  (renamed or split). Requires `superseded_by`.
- **`merged`** — a tombstone: the subject was folded into another topic. Requires
  `merged_into`.
- **`needs-decision`** — a stub that names an open subject with no ratified answer
  yet. It carries provenance `evidence[]` (e.g. the frozen ADR whose subject is
  still open) but no live decision body. This value exists so ADR freeze tooling
  (issue #314) can record that a frozen ADR's subject still needs a living
  decision without inventing an answer. A `needs-decision` stub is not a
  tombstone and must not carry `superseded_by`/`merged_into`.

### Evidence refs

Derivation context is LINKED, never inlined. Each `evidence[]` entry is
`{kind, ref}` where `kind` is one of `issue`, `pr`, `commit`, `session-archive`,
`adr`, `doc`, `url`:

- **`session-archive`** — a path to an archived session artifact (under
  `.kontourai/`) promoted at retirement. Grilling/probe transcripts retire into
  the session archive and are linked here as decision provenance.
- **`adr`** — a frozen numbered ADR under `docs/adr/` that is provenance for this
  decision.
- **`issue`/`pr`/`commit`** — GitHub references (number, URL, or SHA).
- **`doc`/`url`** — a repository document path or external permalink.

`ref` values must never contain secret-shaped material (AWS access keys, GitHub
tokens, private-key blocks, JWTs, or `secret:`/`token:`-style literals). The
validator refuses them; link durable provenance, never a credential.

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
(`scripts/check-decisions.cjs gen-index`). It is deterministic and idempotent: a
second run with no topic change is diff-clean. It lists each topic slug, its
status, and a one-line summary (the `subject`, falling back to the first body
line). Do not edit it by hand. `npm run check:decisions` fails if the index is
missing or stale, so CI catches an out-of-date index.

The index is referenced from `CONTEXT.md` so retrieval-at-write always has a
cheap, loaded pointer into the registry.

## Validation

`npm run check:decisions` (wired into the required `source-and-static` CI lane)
exits nonzero on any of:

- invalid frontmatter (missing `status`/`subject`/`decided`/`evidence`);
- unknown `status`;
- a secret-shaped `evidence[].ref`;
- a `superseded_by`/`merged_into`/`supersedes` slug that points at a missing
  topic file;
- a status/relationship mismatch (e.g. `current` carrying a tombstone field, or
  `superseded` without `superseded_by`);
- a stale or missing `docs/decisions/index.md`.

## Relationship to ADRs and grill-with-docs

- **CONTEXT.md is the only external compatibility surface.** Grill-with-docs
  interop reads the domain vocabulary from CONTEXT.md; the registry keys its
  slugs off that same vocabulary. We inherit the grill-with-docs behavior, not
  the numbered-ADR file format.
- **Numbered ADRs (`docs/adr/NNNN-*.md`) are frozen history.** They are never
  written for new decisions and are never converted into topic files. Existing
  ADRs are frozen-and-indexed by separate tooling (issue #314); a topic file may
  cite a frozen ADR via an `adr` evidence ref as provenance.

The pilot record self-hosting this contract is
[docs/decisions/decision-records.md](../../docs/decisions/decision-records.md).
