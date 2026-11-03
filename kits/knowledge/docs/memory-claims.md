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
| Which claims are current in a slot, supersession over time | Surface. The design is merged ([Surface knowledge-accumulation decision](https://github.com/kontourai/surface/blob/7486c6d8b3d942b1b2aa11e4cdd958f8b1b8aa9f/docs/decisions/knowledge-accumulation.md)); the projection is not implemented, so the caller passes the current claims. |
| Entity merge, split and alias review | Survey (`kontourai/survey#243`, merged in survey#358). The Kit emits proposals in Survey's `EntityProposalInput` and routes them to its review. |
| Visibility lattice | Surface ([Surface derived visibility](https://github.com/kontourai/surface/blob/18e3570636cdb5f9e73d38d9274a2bcd1dc04b9f/docs/decisions/derived-visibility.md), merged in surface#356). A claim's `visibility` is Surface's form and the Kit's order is Surface's meet. |
| Gates and evidence | Flow. |

## The claim

`schemas/knowledge/memory-claim.schema.json`. One immutable, identified assertion:

| Field | Meaning |
|---|---|
| `subject` | `{type, id, label}`, Surface's `(subjectType, subjectId)`. `id` is the lower-cased label until entity review says otherwise. |
| `claimType`, `property`, `qualifiers` | Surface's `claimType`, `fieldOrBehavior` and canonical qualifiers. With the subject they are the *slot* a claim competes in. The slot key is Surface's own `canonicalClaimKey` with `claimType` added, as the decision specifies. The extractor does not produce qualifiers yet, so slots are coarser than Surface's and conflict more readily. |
| `value` | What is asserted. Values compare by structural JSON equality, so a different spelling is a different value. |
| `validTime` | Half-open `[from, until)` of when the value held in the world, per the Surface decision. `until` is exclusive; it is not Surface's inclusive authority-trace `validUntil`, and not `expiresAt` (freshness). An absent bound is unbounded; an absent `validTime` asserts no bound. Instants must be ISO 8601 dates or zoned date-times that exist on the calendar (`2026-02-30` is refused); the Kit stores them as UTC instants, so two spellings of one instant are one value. An empty or unparseable interval is rejected, never guessed. |
| `speaker`, `source` | Who asserted it, and where it is grounded: source ref, `chars:<start>-<end>` locator, the verbatim excerpt, the instant of the turn, and its role. The Kit derives `source` from Traverse's verified provenance and the turn the locator falls in; the model does not supply it. |
| `posture` | How the speaker asserted it: `stated`, `proposed`, `hypothetical` or `retracted`. It is a typed field, not a text prefix. |
| `supersedes` | Edges to the current claims this one replaces (`succession`) or retracts (`correction`). |
| `visibility` | Who may see the claim, in Surface's lattice: `{kind: "public"}` or `{kind: "restricted", audiences: [...]}` (restricted with none is sealed). **Absent is sealed**, not inherited and not public, as in Surface: omission cannot widen access. `distillMemoryClaims` stamps the sitting's visibility, which only the host knows, on every claim it makes; the extractor is never asked. |

`posture` is how the speaker spoke. It is not whether anyone has reviewed the claim;
that is derived (see [Recall](#recall)). `retracted` posture is the speaker withdrawing
an assertion; it is not Surface's admitted retraction event, which excludes a claim from
a projection, and the Kit does not treat it as one. The `id` is the digest of the claim's
content, provenance included, recomputed on every read, so an edited claim is refused.
As the Surface decision requires, the same id means the same content: a value that
differs only in case is a different claim, and so is one whose excerpt, locator or time
was edited. `source.observedAt` is when the turn happened, not the
receiver-recorded knowledge instant Surface's projection takes as its own input.

### Extraction

`MEMORY_CLAIM_TARGET_SCHEMA` is the `TargetFieldSchema[]` the Kit gives Traverse:
`subject`, `subjectType`, `property`, `value`, `speaker`, `posture`, `validFrom`,
`validUntil` (exclusive), `replacesPrior`. It deliberately asks for no visibility and no
consequence flag; those belong to the host and the policy, not to a model.

`distillMemoryClaims({sitting, extract, passes})` formats a runtime-session sitting
(the `kontourai/flow-agents#669` residue shape) one turn per line, runs `passes`
extractions (default 2), assembles Traverse's proposals into claims, and returns:

- `claims`, one per distinct claim found by any pass;
- `agreement[claimId] = {passes, agreeing}`. Passes agree on a finding when they share
  slot, posture and value up to case and spacing (identity is stricter). A pass that
  failed counts as a pass that did not agree;
- `rejected`, each incomplete, postureless, ungrounded or malformed group with its
  reason. A group the extractor produced is either a claim or a reported rejection. Two
  passes that disagree on what a claim says (value, posture, speaker, valid time) yield
  two claims, each found by one pass; a Traverse proposal that Traverse itself dropped
  (for example an excerpt not found in the text) reaches the Kit only as Traverse's warning.

An edge is drawn only with all its evidence. A `succession` needs the speaker to say
the value replaces an earlier one (`replacesPrior`), a stated start time, a
same-slot *stated* predecessor **by the same speaker** with a different value, and
overlapping valid times. Replacing someone else's claim needs an authority decision the
Kit cannot make (the Surface decision leaves a third party's edge pending), so it stays a
plain claim and routing sees the conflict.
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
| `conflicting-current-values` | A new `stated` claim and a current `stated` claim in the same slot hold different values (structural JSON equality) over overlapping valid time, and the new claim carries no edge to it from the same speaker. An edge from another speaker does not clear the conflict: it would need an authority decision the Kit cannot make. An edge to a claim that is not current in the slot replaces nothing. Recency never resolves a conflict. Properties listed in `policy.multiValued` are exempt. A malformed interval counts as overlap. |
| `consequential-supersession` | A claim carries a `supersedes` edge and its property or subject type is in `policy.consequential` (`"*"` matches all). Retractions count. Empty by default, so a host that has not said what is consequential routes none; set it. |
| `entity-identity-change` | Any Survey entity proposal (`merge`, `split`, `alias`, and also `same-as`, `related-to` and `domain:*`, which Survey reviews the same way). They always go to review; no similarity score promotes an identity. The change is Survey's own `EntityProposal`, read by structure; the decision records its id, operations and subjects. |
| `low-extraction-agreement` | Fewer than `minPasses` passes were measured, or fewer than `minAgreement` of them produced the claim. Unmeasured is not agreed. |
| `visibility-widening` | The claim's visibility is not within a bound, in Surface's order (`meet(claim, bound) == claim`). The bounds are its source's visibility and the visibility of every current claim in its slot, so the slot never becomes visible to someone who could not see it before. Undeclared is sealed on every side: a claim with no visibility can never widen anything, and a bound with none admits only a sealed claim, so a claim that declares a visibility fails closed against an undeclared source or peer. A host that declares nothing anywhere has nothing routed here and nothing visible. |

`hypothetical` and `proposed` claims never conflict and never supersede: they assert
nothing about the present. They are still subject to agreement and visibility.

Defaults: `minPasses: 2`, `minAgreement: 1`, `multiValued: []`, `consequential` empty. The Surface
decision requires cardinality and value equality to be explicit versioned inputs: here
they are `multiValued` and the fixed structural-equality rule of policy version `1.0`.

### Recomputable

Each decision embeds its exact `input` (the claim, the same-slot current claims, the
applicable verification records, the agreement counts, the visibility baselines) and
the `policy`. `recomputeMemoryRouting(decision)` re-runs the rules over that and
reports any difference in outcome, reasons, rule list or digest, so an edited
outcome, a changed policy, or a rule set that has drifted since is visible. The rules
are pure; there is no clock and no model call.

### Review items

`runMemoryRouting` does the whole run: it decides each change, records the decisions and the metrics as one serialised unit, then hands each routed claim's review item to the host's queue (`publish(item, idempotencyKey)`; the key is the decision id, which does not depend on the order of a claim's audiences or edges, so a retry is a no-op). Decisions are recorded before anything is queued; if the queue fails, the decisions are already recorded and a retry publishes again with the same keys. `published` lists only items the queue accepted. `buildMemoryReviewItem(decision)` returns the Survey `ReviewItem` for a routed claim:
a current/proposed pair when the decision names a current claim it conflicts with or
replaces, otherwise one proposed candidate. Run a Survey `SupportVerifier` against the
review candidate with `verifyMemoryClaimAgainstCurrent`, so Survey's workbench shows
the record on the candidate. Entity changes get no item here: build it with Survey's
`entityProposalToReviewItem` (its review item is named by the proposal id, which is how the
decision and the metrics find it).

`memoryEntityProposalInput` emits a merge, split or alias candidate in Survey's `EntityProposalInput`
(survey#358): the two subjects, the operation, and as evidence the exact spans of the memory claims that
ground it, each with the source's content hash and a stance (`supports`, `contradicts`, `context`). The Kit
does not decide that two subjects are one; confidence components are descriptive and never accept anything.
Pass the result to Survey's `createEntityProposal`, route the proposal with `routeMemoryChange`, and
`runMemoryRouting` returns the proposals it sent to review for the host to turn into Survey review items.
Detecting which subjects to propose is the host's (or a later lane's) candidate generation, not this PR's.

## Flow evidence

`recordMemoryRoutingEvidence({runId, gate, cwd, decisions})` attaches a batch of
decisions, and `recordMemoryMetricsEvidence` the run's metrics, to a gate of a Flow
run the host owns, as custom-kind evidence (`memory.routing-decisions`,
`memory.run-metrics`). A decision that does not recompute is refused before anything
is attached. Re-attaching the same content returns the existing entry; new metrics
supersede the earlier entry. Both hold within one process. Flow's run lock is not
re-entrant, so the check and the attach cannot share it: two processes racing can leave a
duplicate routing batch (readers dedupe by decision id) or two live metrics entries
(`readLatestMemoryMetrics` takes the last). Neither loses or corrupts evidence. An atomic
conditional attach is a Flow feature ([kontourai/flow#295](https://github.com/kontourai/flow/issues/295)). `recomputeRecordedMemoryRouting(runId)` reads the stored
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

The latest decision for an item stands, and a change routed twice in one run counts once, with its later decision.
Call it again as review happens; `pending` falls and the review figures fill in. In a Flow run the review state
(Survey decisions and session events) is itself recorded as evidence (`memory.review-record`) the first time it is
passed in, and metrics are always derived from everything recorded, so a later call that passes none, an identical
retry of `runMemoryRouting` or a new batch, still counts the review already recorded instead of overwriting it. This is not Survey's `deriveOversightMetrics`:
that reports decision pace and override rate across all decisions in a window, and
its inter-decision gap is not time spent on an item.

## Recall

`presentMemoryClaims(claims, {routing, reviewDecisions})` is the one way to put claims
in front of a reader. Every presented claim carries `posture` and a review label
(`unreviewed`, `in-review`, `confirmed`, `corrected`), and `text` begins with both:
`[hypothetical · unreviewed] widget service: sharding technology = Citus`. A claim
with no posture, a claim whose id no longer matches its content, and a claim review
rejected are *withheld and reported*, never presented bare. A claim a reviewer corrected
is presented with the reviewer's value (`value`), the extracted one stays in
`extractedValue`, and a reviewer's decision applies whether or not the claim's routing
record is passed in.
A claim with no routing decision is labelled `unreviewed` with `routing:
"not-evaluated"`.

Any recall path added later (the injected brief of `#672`, a store query) must go
through this function or enforce the same rule.

## Storing proposed claims

Not built here. Per the decision recorded on `kontourai/corpus#40`, a `proposed` claim is
stored with the store's `proposeCreate` as a pending create proposal. `applyCreate` creates the record
and needs a reviewer distinct from the proposer, which is where a routed claim's Survey decision lands;
`rejectCreate` keeps the proposal as rejected with a rationale (the amendment on the issue renamed the
verbs from `apply` and `reject`). `proposeCreate` is not on corpus `main` (corpus#42, `feat/40-create-proposals`, is open),
so this Kit does not call it or assume its input shape.

One consequence needs deciding before recall is wired: that decision keeps pending
proposals out of the default working set and ordinary reads, but a `proposed` claim must
stay recallable (review never blocks recall). A recall path therefore has to read the
explicit proposals query filtered to `pending` and present the result through
`presentMemoryClaims`, or the store has to offer a labelled read. The injected-memory
marker (`kits/knowledge/memory-marker.js`, `#669`) wraps what recall injects; it is not
consumed here, and `presentMemoryClaims` does not apply it.

## Not in this slice

- Writing claims to the personal store (`#670`) and the dream pipeline's use of them
  (`#671`). Claims are returned and recorded as evidence; staging into a store is the
  next lane.
- Importing Surface's visibility lattice and Survey's entity review. Both are merged (surface#356,
  survey#358) but in no published release (npm has Surface 6.2.1 and Survey 8.2.1; this package pins 5.0.0
  and 8.2.0). Until they ship, the Kit holds two thin stand-ins and nothing else of theirs:
  `memoryVisibilityWithin`, one function stating Surface's order, and `SurveyEntityProposalLike`, a structural
  type for the part of `EntityProposal` it reads. Tests pin the first against Surface's own meet vectors and,
  as soon as the installed Surface exports `meetVisibility`, against the real function; the second against a
  proposal made by Survey's `createEntityProposal`. Delete both when the packages are bumped.
- Surface's current-state projection (the design is merged; the projection is not): the Kit takes the
  current claims as input.
- A Flow gate that requires this evidence.
