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
  model for an audience or a consequence flag.
- **Posture is not review state.** `stated`, `proposed`, `hypothetical` and
  `retracted` say how the speaker spoke. Whether anyone reviewed the claim is
  derived from its routing decision and any Survey decision, never stored on it.
- **Uncontested changes are recorded as `proposed`; flagged ones are routed.**
  Routing never blocks recall. Survey records verification verdicts and reviewer
  decisions but routes on neither, so the policy is the Kit's.
- **Unmeasured is not agreed, and unknown is not safe, with one deliberate exception.**
  Too few extraction passes, malformed agreement counts, an unknown source audience for a
  claim that asks for one, a peer with no declared audience for a claim that asks for one,
  and a malformed interval resolve toward review. A claim that only inherits its source's
  audience is compared with the peers that declare one: an undeclared peer gives it nothing
  to compare with, and treating that as a widening would route everything for a host that
  records no audiences. One default goes the other way on purpose: with no `consequential` list the
  policy routes no supersession as consequential, because the Kit cannot know what a host
  treats as consequential. A host must set it, and the metrics' `routedByRule` shows
  whether it did.
- **A decision is recomputable.** It embeds the input and policy its pure rules
  read, and is recorded as Flow evidence. Recomputation reports an edited outcome, a
  changed policy, or a rule set that has drifted.
- **Consume, do not fork.** Which claims are current is Surface's
  (`kontourai/surface#204`, design merged at `7486c6d`; slot identity uses Surface's
  `canonicalClaimKey` plus `claimType`, values compare by structural JSON equality, and
  `validTime` is half-open); entity merge and split review is Survey's
  (`kontourai/survey#243`, whose `EntityProposal` the Kit reads by structure); the visibility lattice is Surface's
  (`kontourai/surface#350`). The Kit takes the current claims and an opaque entity
  proposal reference as input, and compares audiences by set inclusion until the
  lattice exists.

## Consequences

- Flow 5.4 gate expectations accept only `trust.bundle`, so routing evidence is
  recorded and recomputable but a gate cannot yet require it.
- Review time is selection-to-submission dwell from Survey session events and is
  absent, not estimated, when there are none.
- Every recall path must present claims through `presentMemoryClaims` or enforce the
  same rule: no claim without its posture and review label.
