---
status: current
subject: Memory claim routing
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1571
  - kind: doc
    ref: kits/knowledge/docs/memory-claims.md
  - kind: doc
    ref: docs/decisions/survey-evidence-flow-gates.md
---

# Memory claim routing

## Decision

The Knowledge Kit supplies the claim shape and the routing policy for distilled
memory; every other piece stays with its owner.

- **The claim schema is caller-owned.** The Kit hands Traverse an ordinary
  `TargetFieldSchema[]` (subject, property, value, valid time, speaker, posture).
  Traverse learns no field name and stays proposals-only. The Kit never asks the
  model for a visibility or a consequence flag.
- **Posture is not review state.** `stated`, `proposed`, `hypothetical` and
  `retracted` say how the speaker spoke. Whether anyone reviewed the claim is
  derived from its routing decision and any Survey decision, never stored on it.
- **Uncontested changes are recorded as `proposed`; flagged ones are routed.**
  Routing never blocks recall. Survey records verification verdicts and reviewer
  decisions but routes on neither, so the policy is the Kit's.
- **Unmeasured is not agreed, and unknown is not safe, with one deliberate exception.**
  Too few extraction passes route to review, and a visibility Surface cannot read is sealed, never open.
  Malformed agreement counts and a projection fact that is not well formed are refused at the entry points
  (`routeMemoryChange`); the pure rules, which also run over stored inputs, read a malformed agreement count
  as unmeasured, and recomputation refuses a stored fact that is not in canonical form. Visibility
  follows Surface's derived-visibility record: undeclared is sealed, a claim is bounded by the meet
  of its inputs, and omission cannot widen. One default goes the other way on purpose: with no
  `consequential` list the policy routes no supersession as consequential, because the Kit cannot
  know what a host treats as consequential. A host must set it. Nothing in the metrics can show that it
  did not: a run with no supersessions looks the same either way.
- **A decision is recomputable.** It embeds the input and policy its pure rules
  read, and is recorded as Flow evidence. Recomputation reports an edited outcome, a
  changed policy, or a rule set that has drifted.
- **Consume, do not fork.** Whether a slot is contested is Surface's: the contradiction rule fires on
  `projectAccumulation`'s `contested` outcome (surface@6.3.0), run by the
  host, and the Kit compares no values itself. Slot identity uses Surface's `canonicalClaimKey` plus
  `claimType` (`#204`, design at `7486c6d`), values compare by structural JSON equality, and `validTime`
  is half-open. Consequence: until a reviewer verifies a successor and the host admits it, Surface keeps both
  candidates, so an unreviewed replacement is contested and routes; a replacement is auto-recorded as
  `proposed` only after that admission. The visibility
  lattice is Surface's (surface@6.3.0): a claim's `visibility` has Surface's form and the widening rule calls
  Surface's `meetVisibility`. Entity merge and split review is Survey's (survey@8.3.0): the Kit emits
  `EntityProposalInput` and routes the proposal, and Survey builds the item and records the outcome. Both packages
  are pinned to the released versions; the Kit holds no copy of either contract.

## Consequences

- Flow 5.4 gate expectations accept only `trust.bundle`, so routing evidence is
  recorded and recomputable but a gate cannot yet require it.
- Review time is selection-to-submission dwell of the session that submitted the decision, from Survey
  session events, and is absent, not estimated, when there are none. It is an upper bound on attention.
- Every recall path must present claims through `presentMemoryClaims` or enforce the
  same rule: no claim without its posture and review label.
