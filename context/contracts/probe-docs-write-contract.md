# Probe Docs-Write Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

Normative contract for how a Probe (`design-probe`, and its Builder Kit
`pickup-probe` specialization) writes durable documentation as understanding
crystallizes during probing. This is the docs-write half of the grill-with-docs
pattern: a Probe already interviews and aligns; this contract says what a Probe
must leave behind in durable docs, not just in the session artifact.

## Why

Probe outcomes previously landed only in session artifacts (`.kontourai/flow-agents/<slug>/`):
vocabulary and decisions crystallized while probing had to be re-extracted later,
or were lost when the session archived. Grill-with-docs' whole point is that the
interview leaves living documentation behind, not session-local notes. This
contract makes that the default behavior for every Probe, not an occasional
manual follow-up.

## Scope

Applies to `design-probe` (generic) and `pickup-probe` (the Builder Kit
pickup specialization) — see
[`kits/builder/skills/design-probe/SKILL.md`](../../kits/builder/skills/design-probe/SKILL.md)
and
[`kits/builder/skills/pickup-probe/SKILL.md`](../../kits/builder/skills/pickup-probe/SKILL.md).
It does not create a new skill; both existing Probe skills already own the
grill/grill-with-docs behavior (R1 in
[flow-agents#311](https://github.com/kontourai/flow-agents/issues/311)) — this
contract only normalizes what they write and where.

Out of scope: enforcement gating on Probe docs-writes (a separate issue),
`CONTEXT.md` restructuring beyond vocabulary sections, and repositories with no
`CONTEXT.md` (an open question the owner has not settled; non-blocking for
flow-agents, which always has one).

## The Two-Delta Rule

**Per crystallized understanding** — a question the Probe asked and the user (or
discoverable local evidence) definitively answered, not a still-open question or
an accepted gap — the Probe emits, in the same motion:

1. **A vocabulary delta** into `CONTEXT.md` (or the owning `CONTEXT-MAP.md`
   context when one exists) — see [Vocabulary Delta](#1-vocabulary-delta-coin-first).
2. **A decision delta** into `docs/decisions/<slug>.md` — see
   [Decision Delta](#2-decision-delta-retrieval-at-write).
3. **Transcript provenance** — the decision delta's `evidence[]` links the
   session artifact that produced it — see
   [Transcript Provenance](#3-transcript-provenance).

Not every Probe question needs both deltas. A question resolved by reading
existing docs/code needs neither (nothing crystallized — it was already
decided). A question about implementation detail, sequencing, or a transient
planning choice needs neither (it belongs in the workflow artifact, per
`context/contracts/artifact-contract.md`, not durable docs). The two-delta rule
applies specifically to a **decision subject** crystallizing: a durable,
reusable answer to a named domain question that other work will need to look up
later. If in doubt, ask: "will a future session need to know this answer without
re-deriving it?" — if yes, it is a decision subject and both deltas apply.

### 1. Vocabulary delta (coin-first)

**A decision subject may only use subject terms present in (or added to)
`CONTEXT.md` in the same session** (R2). Vocabulary is the topic namespace the
decision registry's slugs are drawn from
(`context/contracts/decision-registry-contract.md` § Slug rules), so the term
must exist before the topic file can be named.

- If the crystallized understanding's subject noun is **already** a `CONTEXT.md`
  glossary term, the vocabulary delta may be a **refinement** of that entry
  rather than a new one — e.g. removing "subject open" language once a decision
  ratifies it, tightening a definition, or adding an `_Avoid_` term. This still
  counts as a vocabulary delta: the glossary is a living document, not
  write-once.
- If the subject noun is **absent**, **coin it first**: add a tight one- or
  two-sentence `### <Term>` entry to `CONTEXT.md`'s Glossary section, in the
  same style as existing entries (definition, optional `_Avoid_` line). Do this
  before creating the decision file — the term is the slug's namespace, not an
  afterthought.
- Keep the vocabulary delta to glossary-style terminology. Implementation
  detail, rationale, and derivation stay out of `CONTEXT.md` (unchanged from the
  Probe skills' existing docs discipline).
- If a `CONTEXT-MAP.md` exists and a more specific context owns the term, update
  that context instead of assuming the root glossary owns every term.

### 2. Decision delta (retrieval-at-write)

Once the vocabulary exists, record the decision per
`context/contracts/decision-registry-contract.md` in full — this contract does
not repeat the frontmatter/slug/tombstone rules, only the Probe-specific
sequencing:

1. **Consult `docs/decisions/index.md`** (the always-loaded slug + one-liner
   index) before writing anything, and propose **revise-vs-create**:
   - An existing topic slug already covers the subject (including a
     `needs-decision` stub seeded by ADR-freeze tooling, issue #314) → **revise
     that file in place.** Flip `needs-decision` → `current` (or edit a `current`
     file's body/`decided` date for a superseding decision), add the new
     `evidence[]` refs, do not create a second file for the same subject.
   - No topic covers the subject → confirm the vocabulary delta above landed,
     then **create** `docs/decisions/<slug>.md` with the frontmatter shape
     `context/contracts/decision-registry-contract.md` defines.
2. Run `npm run gen:decisions-index && npm run check:decisions` after every
   decision-delta write. A Probe session is not done touching the registry until
   both exit 0.
3. Never propose a numbered ADR. `docs/adr/` is frozen history
   (`docs/adr/README.md`); a Probe's decision delta always targets the
   topic-keyed registry, never a new `docs/adr/NNNN-*.md` file.

### 3. Transcript provenance

Every decision file a Probe creates or edits carries an `evidence[]` entry of
`kind: session-archive` pointing at the Probe's own session artifact (R3) — the
Markdown file recording the interview, decisions, and accepted gaps
(`.kontourai/flow-agents/<slug>/<slug>--design-probe.md`,
`<slug>--pull-work.md`, or the equivalent Probe record the active workflow
artifact uses).

- Record the **live session path** at write time, even though the topic file
  and the decision-registry contract describe `session-archive` as pointing at
  an *archived* artifact "promoted at retirement" — the Probe runs at shaping
  time, before the session archives. This is a deliberate, documented seam: the
  promote-then-archive gate (issue #312) is the retirement-time mechanism that
  moves the session directory to `<artifact-root>/archive/<slug>/` and is
  responsible for keeping already-written evidence refs accurate across that
  move. The Probe's job is emitting the initial link, not the later archival
  move; do not block a decision delta on the session having archived first.
- When the Probe is also citing a frozen ADR as prior provenance (e.g. upgrading
  a `needs-decision` stub whose `evidence[]` already names one), keep that `adr`
  evidence entry and add the `session-archive` entry alongside it — provenance
  accumulates, it does not replace.
- Also add a `pr`/`issue` evidence entry once a PR or issue number exists for the
  work, following the same pattern every other decision file in the registry
  uses.

## Worked Example: Upgrading a Needs-Decision Stub

The ADR-freeze cutover (issue #314, landed in #368) seeded 17 `needs-decision`
stubs, each naming a subject with provenance in a frozen ADR but no ratified
living decision. These are the natural first targets for this contract: a Probe
that settles one of these subjects from existing evidence (the frozen ADR
already states a decision that remains true — nothing new needs deciding, only
recording) does the following:

1. **Read the stub** (`docs/decisions/<slug>.md`, `status: needs-decision`) and
   its `evidence[]`-linked frozen ADR(s).
2. **Vocabulary delta**: the subject noun is already a `CONTEXT.md` term (seeded
   alongside the stub during the freeze cutover) — refine its definition to
   state the decision is now living rather than "subject open in the Decision
   Registry," and keep the link to `docs/decisions/<slug>.md`.
3. **Decision delta**: consult `docs/decisions/index.md` — the slug already
   exists (revise, not create). Edit `docs/decisions/<slug>.md`:
   `status: needs-decision` → `current`, set `decided` to today, keep the
   existing `adr` evidence ref(s), append a `session-archive` ref (this Probe's
   session artifact) and a `pr` ref once the PR exists, and write the `# <Title>`
   body stating the decision (drawn from the ADR) plus lean rationale.
4. Run `npm run gen:decisions-index && npm run check:decisions`; both must exit
   0 before the Probe records the gate claim.
5. **Transcript provenance**: the session-archive evidence ref from step 3 is the
   provenance link (R3).

This exercises all three rules end-to-end without inventing a new decision —
the frozen ADR already made the call; the Probe's job is only recording that it
is still true and giving it a living home.

## Relationship To Other Contracts

- **`context/contracts/decision-registry-contract.md`** is the normative
  frontmatter/slug/tombstone/validation contract for every `docs/decisions/`
  file, Probe-written or not. This contract only adds *when* and *in what
  sequence* a Probe writes to that registry.
- **`context/contracts/artifact-contract.md`** governs the Probe's session
  artifact itself (the thing this contract's transcript-provenance rule links
  to) and the promote/archive lifecycle referenced above.
- **`docs/adr/README.md`** is where this contract is announced as the mechanism
  that supersedes the prior "propose ADRs sparingly" Probe guidance — Probes
  never write numbered ADRs; they write decision-registry deltas.

## Validation

- `npm run check:decisions` / `npm run gen:decisions-index` — the decision
  delta must pass the registry validator and keep the index current (wired into
  the required `source-and-static` CI lane).
- `evals/static/test_workflow_skills.sh` — asserts `design-probe` and
  `pickup-probe` reference this contract and describe the two-delta behavior.
- `evals/static/test_decisions.sh` — regression coverage for the validator and
  generator this contract's decision deltas depend on.
