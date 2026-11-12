---
status: current
subject: Correction-recurrence learning
decided: 2026-11-12
evidence:
  - kind: doc
    ref: kits/knowledge/docs/learn.md
  - kind: doc
    ref: docs/specs/learning-review-proposals-contract.md
  - kind: doc
    ref: docs/decisions/memory-dream-run.md
---

# Correction-recurrence learning

## Decision

Flow Agents learns from the corrections a developer keeps typing to their coding agent.
`flow-agents learn` mines existing transcripts and proposes agent rules, skills, hooks or
executable checks. A human decides every proposal.

- **Human turns only, by the importer's word.** A user message counts only when its Thread
  `origin.kind` is `"human"` (Ferry 0.8.0 or later). Agent briefs, harness and hook text,
  compaction summaries, task notifications, `unknown` and absent origins never count. An
  orchestrator that repeats its rules to delegates otherwise reads as many independent human
  corrections. A run whose transcripts carry no origin refuses rather than reporting nothing.
- **A model classifies; heuristics do not.** Keyword and capital-letter heuristics measured
  13% and 0% precision on a real corpus. A model classifies each turn as correction, nudge,
  frustration or none, with pain, a generalized rule of at most 15 words, and whether the rule
  is general. Continuation pings are dropped by a closed list before any model call, and
  factual pushback is classified `none`.
- **It extends `kontour.learning-review-proposals` (v0.2), not a new contract.** The
  ledger, the decision script, the advisory-only guardrail and the cost-and-defect pairing
  already fit "recorded outcomes become a proposal a human ratifies". v0.2 adds the
  `correction-recurrence` source family and the target kinds `agents-md`, `skill`, `hook` and
  `veritas-check`. Each producer measures the effect of its own source family; the v0.1
  analyzer leaves other families' lines unchanged.
- **It lives in the Knowledge kit, beside the dream run.** It reuses the dream run's
  transcript reader, scrub and Relay/Dispatch model route rather than forking them. Unlike the
  dream, it needs no telemetry file or host: it reads the harnesses' own transcript
  directories, so it works without a Flow run or kit adoption.
- **Enforcement escalates with recurrence.** A theme's first proposal is a prose rule. It
  climbs to a skill, a hook and an executable check when a ratified rung is measured not to
  stop the recurrence, and starts at a skill when the rule is already written down.
- **Conflicts are surfaced, not resolved.** A model judge checks each rule against the target
  rule file and cites the line. A contradiction is shown to the reviewer as a current/proposed
  pair, because a learned preference that contradicts a written rule is itself worth deciding.
- **Advisory only.** Nothing in the loop writes a rule file, skill, hook or Veritas config.

## Rationale

A spike over about 3,000 local sessions found that most "user" turns were agent briefs or
harness text, that heuristics could not find corrections, and that a model-classified,
thresholded loop surfaced new workflow-preference rules a human judged adoptable, including
some that contradicted rules already written.

## Consequences

- A developer who submits prompts through an SDK or IDE host gets `unknown` origins and
  therefore few or no counted turns until the host records who typed a prompt. The report
  counts `unknown` origins by Ferry's evidence so the gap is visible.
- Recall on rules written from review postmortems is low: those come from one costly event,
  not repetition. This loop complements postmortems; it does not replace them.
- The loop needs weeks of history, and each run re-classifies its window.
