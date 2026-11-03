# Memory claims and routed review

Distilled memory arrives as proposals. This page is the contract for the two things
the Knowledge Kit adds so a person reviews only what needs one: a **claim shape**
that Traverse extracts into, and a **routing policy** that decides which claims go
to Survey review. Both are exported by the `knowledge.memory-claims` adapter and the
package exports `memory-claims`, `memory-routing` and `memory-routing-flow`.

## Who owns what

| Piece | Owner |
|---|---|
| Field extraction, excerpts, locators | Traverse. It proposes; it never decides. It is given the claim schema below as an ordinary caller-owned `TargetFieldSchema` and learns no field name of its own. |
| The model call | The host. `distillMemoryClaims` takes an `extract` function; bind it to Traverse's `extract()` and a provider. |
| Claim shape, routing policy, run metrics | This Kit. |
| Support verification, review items, reviewer decisions | Survey. |
| Which claims are current in a slot, supersession over time | Surface (`kontourai/surface#204`, a design today). The caller passes the current claims. |
| Entity merge, split and alias review | Survey (`kontourai/survey#243`). The Kit routes an entity change to it by reference. |
| Visibility lattice | Surface (`kontourai/surface#350`). The Kit compares audiences by set inclusion. |
| Gates and evidence | Flow. |

## The claim

`schemas/knowledge/memory-claim.schema.json`. One immutable, identified assertion:

| Field | Meaning |
|---|---|
| `subject` | `{type, id, label}`. `id` is the case-folded label until entity review says otherwise. |
| `property` | The attribute asserted. A subject and property are a *slot*. |
| `value` | What is asserted. |
| `validTime` | Half-open `[from, until)` of when the value held in the world. An absent bound is unbounded; an absent `validTime` asserts no bound. An empty or unparseable interval is rejected, never guessed. |
| `speaker`, `source` | Who asserted it, and where it is grounded: source ref, `chars:<start>-<end>` locator, the verbatim excerpt, the instant of the turn, and its role. The Kit derives `source` from Traverse's verified provenance and the turn the locator falls in; the model does not supply it. |
| `posture` | How the speaker asserted it: `stated`, `proposed`, `hypothetical` or `retracted`. It is a typed field, not a text prefix. |
| `supersedes` | Edges to the current claims this one replaces (`succession`) or retracts (`correction`). |
| `audience` | Principals who may see it. Absent inherits the source's audience: omission never widens. |

`posture` is how the speaker spoke. It is not whether anyone has reviewed the claim;
that is derived (see [Recall](#recall)). The `id` is the digest of the claim's
content, recomputed on every read, so an edited claim is refused. Evidence fields
(excerpt, locator, time, role) are not part of identity: two extraction passes that
find the same fact find the same claim.

### Extraction

`MEMORY_CLAIM_TARGET_SCHEMA` is the `TargetFieldSchema[]` the Kit gives Traverse:
`subject`, `subjectType`, `property`, `value`, `speaker`, `posture`, `validFrom`,
`validUntil`, `replacesPrior`. It deliberately asks for no audience and no
consequence flag; those belong to the host and the policy, not to a model.

`distillMemoryClaims({sitting, extract, passes})` formats a runtime-session sitting
(the `kontourai/flow-agents#669` residue shape) one turn per line, runs `passes`
extractions (default 2), assembles Traverse's proposals into claims, and returns:

- `claims`, one per distinct claim found by any pass;
- `agreement[claimId] = {passes, agreeing}`. A pass that failed counts as a pass
  that did not agree;
- `rejected`, each incomplete, postureless, ungrounded or malformed group with its
  reason. Nothing is dropped silently.

An edge is drawn only with all its evidence. A `succession` needs the speaker to say
the value replaces an earlier one (`replacesPrior`), a stated start time, a
same-slot *stated* predecessor with a different value, and overlapping valid times.
A `correction` edge comes from a `retracted` claim and points at current claims
holding the same value. Without all of that the new claim is a plain claim, and
routing sees a conflict rather than a quiet replacement.

## The routing policy

`routeMemoryChange(change, policy)` runs every rule that applies and returns a
decision. **A change no rule flags is recorded as `proposed`: recallable, labelled
unreviewed.** A flagged change is `routed`: it records and recalls the same way, and
also becomes a Survey review item that a person decides. Review never blocks recall.

| Rule | Routes when |
|---|---|
| `contradicted-by-verification` | A Survey support-verification record bound to this claim's value says `contradicted`. A record for a different value does not apply. An abstention (timeout, malformed, error) is neither a pass nor a fail and does not route by itself. |
| `conflicting-current-values` | A new `stated` claim and a current `stated` claim in the same slot hold different values over overlapping valid time, and the new claim carries no edge to it. Recency never resolves a conflict. Properties listed in `policy.multiValued` are exempt. A malformed interval counts as overlap. |
| `consequential-supersession` | A claim carries a `supersedes` edge and its property or subject type is in `policy.consequential` (`"*"` matches all). Retractions count. Empty by default, so a host that has not said what is consequential routes none; set it. |
| `entity-identity-change` | Any entity merge, split or alias proposal. They always go to review; no similarity score promotes an identity. |
| `low-extraction-agreement` | Fewer than `minPasses` passes were measured, or fewer than `minAgreement` of them produced the claim. Unmeasured is not agreed. |
| `visibility-widening` | The claim requests an audience that is not a subset of its source's audience, or of the audience of any current claim in its slot. An unknown baseline fails closed. |

`hypothetical` and `proposed` claims never conflict and never supersede: they assert
nothing about the present. They are still subject to agreement and visibility.

Defaults: `minPasses: 2`, `minAgreement: 1`, `multiValued: []`, `consequential` empty.

### Recomputable

Each decision embeds its exact `input` (the claim, the same-slot current claims, the
applicable verification records, the agreement counts, the audience baselines) and
the `policy`. `recomputeMemoryRouting(decision)` re-runs the rules over that and
reports any difference in outcome, reasons, rule list or digest, so an edited
outcome, a changed policy, or a rule set that has drifted since is visible. The rules
are pure; there is no clock and no model call.

### Review items

`buildMemoryReviewItem(decision)` returns the Survey `ReviewItem` for a routed claim:
a current/proposed pair when the decision names a current claim it conflicts with or
replaces, otherwise one proposed candidate. Run a Survey `SupportVerifier` against the
review candidate with `verifyMemoryClaimAgainstCurrent`, so Survey's workbench shows
the record on the candidate. Entity changes get no item here; Survey owns it.

## Flow evidence

`recordMemoryRoutingEvidence({runId, gate, cwd, decisions})` attaches a batch of
decisions, and `recordMemoryMetricsEvidence` the run's metrics, to a gate of a Flow
run the host owns, as custom-kind evidence (`memory.routing-decisions`,
`memory.run-metrics`). A decision that does not recompute is refused before anything
is attached. Re-attaching the same content returns the existing entry; new metrics
supersede the earlier entry. `recomputeRecordedMemoryRouting(runId)` reads the stored
files back (refusing any whose digest no longer matches) and recomputes every decision.

One evidence entry holds a batch of decisions rather than one entry per decision,
because a run decides hundreds of changes and each entry is a locked manifest write.
Each decision is individually addressable by its `id`.

Flow 5.4 gate expectations accept only `trust.bundle`, so a gate cannot yet *require*
this evidence. It is recorded and recomputable, not gated.

## Metrics

`deriveMemoryRunMetrics({runId, decisions, reviewDecisions, reviewEvents})`
(`schemas/knowledge/memory-run-metrics.schema.json`):

- `claimsProposed`, `uncontested`, `routed`, `routedShare` (null with no decisions),
  and `routedByRule`;
- `reviewer`: `confirmed`, `corrected` (accepted with an edit), `rejected` (rejected,
  or the current value kept), `held` (could not confirm), `pending` (routed, no
  decision yet), `unmatched` (a decision for something this run did not route), and
  `defectsCaught` = `corrected + rejected`;
- `reviewSeconds`: selection-to-submission dwell from Survey session events,
  summed over decisions that have both events, with `reviewTimedDecisions` saying how
  many. It is an upper bound on attention and is `null`, never estimated, without events;
- `reviewSecondsPerCaughtDefect`.

The latest decision for an item stands. Call it again as review happens; `pending`
falls and the review figures fill in. This is not Survey's `deriveOversightMetrics`:
that reports decision pace and override rate across all decisions in a window, and
its inter-decision gap is not time spent on an item.

## Recall

`presentMemoryClaims(claims, {routing, reviewDecisions})` is the one way to put claims
in front of a reader. Every presented claim carries `posture` and a review label
(`unreviewed`, `in-review`, `confirmed`, `corrected`), and `text` begins with both:
`[hypothetical · unreviewed] widget service: sharding technology = Citus`. A claim
with no posture, a claim whose id no longer matches its content, and a claim review
rejected are *withheld and reported*, never presented bare and never dropped silently.
A claim with no routing decision is labelled `unreviewed` with `routing:
"not-evaluated"`.

Any recall path added later (the injected brief of `#672`, a store query) must go
through this function or enforce the same rule.

## Not in this slice

- Writing claims to the personal store (`#670`) and the dream pipeline's use of them
  (`#671`). Claims are returned and recorded as evidence; staging into a store is the
  next lane.
- The Survey entity-review item (`survey#243`) and Surface's current-state projection
  (`surface#204`). Both are consumed by shape and replaced by the real contract when
  they land.
- A Flow gate that requires this evidence.
