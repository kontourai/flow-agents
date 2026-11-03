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
| Which claims are current in a slot, whether it is contested, supersession over time | Surface (`projectAccumulation`, surface@6.3.0). The host runs it (it needs observations with custody and an authority snapshot the Kit does not hold); the Kit maps its claims in (`memoryAccumulationClaims`, which carries every claim a replacement chain reaches and gives one claim one Surface claim: edges in id order, instants as the UTC date-times Surface parses for years 0000-9999, and the claim\'s JSON content copied so an undefined field and an absent one are the same; a subject id or claim type with surrounding whitespace, or a blank slot field, is refused because Surface refuses that slot), reads the result back (`memoryAccumulationFact`) and routes on it. The design is [Surface's knowledge-accumulation decision](https://github.com/kontourai/surface/blob/7486c6d8b3d942b1b2aa11e4cdd958f8b1b8aa9f/docs/decisions/knowledge-accumulation.md). The Kit still takes the current claims as input, for the visibility bounds and the review item. |
| Entity merge, split and alias review | Survey (entity review, survey@8.3.0). The Kit emits proposals in Survey's `EntityProposalInput` and routes them to its review. |
| Visibility lattice | Surface ([Surface derived visibility](https://github.com/kontourai/surface/blob/18e3570636cdb5f9e73d38d9274a2bcd1dc04b9f/docs/decisions/derived-visibility.md), surface@6.3.0). A claim's `visibility` is Surface's form and the Kit's order is Surface's own `meetVisibility`, called, not restated. |
| Gates and evidence | Flow. |

## The claim

`schemas/knowledge/memory-claim.schema.json`. One immutable, identified assertion:

| Field | Meaning |
|---|---|
| `subject` | `{type, id, label}`, Surface's `(subjectType, subjectId)`. `id` is the lower-cased label until entity review says otherwise. |
| `claimType`, `property`, `qualifiers` | Surface's `claimType`, `fieldOrBehavior` and canonical qualifiers. With the subject they are the *slot* a claim competes in. The slot key is Surface's own `canonicalClaimKey` with `claimType` added, as the decision specifies. The extractor does not produce qualifiers yet, so slots are coarser than Surface's and conflict more readily. |
| `value` | What is asserted. Values compare by structural JSON equality, so a different spelling is a different value. |
| `validTime` | Half-open `[from, until)` of when the value held in the world, per the Surface decision. `until` is exclusive; it is not Surface's inclusive authority-trace `validUntil`, and not `expiresAt` (freshness). An absent bound is unbounded; an absent `validTime` asserts no bound. Instants must be ISO 8601 dates or zoned date-times that exist on the calendar (`2026-02-30` is refused); the distill step stores them as UTC instants to millisecond precision (a finer fraction is refused, not dropped), so two spellings of one instant are one value there. A claim built directly with `memoryClaim` keeps the spelling it was given, and a different spelling is a different claim. An empty or unparseable interval is rejected, never guessed. |
| `speaker`, `source` | Who asserted it, and where it is grounded: source ref, `chars:<start>-<end>` locator, the verbatim excerpt, the instant of the turn, and its role. The Kit derives `source` from Traverse's verified provenance and the turn the locator falls in; the model does not supply it. |
| `posture` | How the speaker asserted it: `stated`, `proposed`, `hypothetical` or `retracted`. It is a typed field, not a text prefix. |
| `supersedes` | Edges to the current claims this one replaces (`succession`) or retracts (`correction`). |
| `visibility` | Who may see the claim, in Surface's lattice: `{kind: "public"}` or `{kind: "restricted", audiences: [...]}` (restricted with none is sealed). **Absent is sealed**, not inherited and not public, as in Surface: omission cannot widen access. `distillMemoryClaims` stamps the sitting's visibility, which only the host knows, on every claim it makes; the extractor is never asked. |

`posture` is how the speaker spoke. It is not whether anyone has reviewed the claim;
that is derived (see [Recall](#recall)). `retracted` posture is the speaker withdrawing
an assertion; it is not Surface's admitted retraction event, which excludes a claim from
a projection, and the Kit does not treat it as one. The `id` is the digest of the claim's
content, provenance included, checked wherever the Kit reads a claim it was handed (`assertMemoryClaim`, run by `routeMemoryChange`, `recomputeMemoryRouting` and `presentMemoryClaims`), so an edited claim is refused there. `memoryClaim` itself builds a claim and assigns its id without validating it.
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
  reason. A group the extractor produced is either a claim or a reported rejection, and proposals for a claim field that carry no claim index are reported together as one rejection. Two
  passes that disagree on what a claim says (value, posture, speaker, valid time) yield
  two claims, each found by one pass; a Traverse proposal that Traverse itself dropped
  (for example an excerpt not found in the text) reaches the Kit only as Traverse's warning.

An edge is drawn only with all its evidence. A `succession` needs the speaker to say
the value replaces an earlier one (`replacesPrior`), a stated start time, a
same-slot *stated* predecessor **by the same speaker** with a different value, and
overlapping valid times. Replacing someone else's claim needs an authority decision the
Kit cannot make (the Surface decision leaves a third party's edge pending), so it stays a
plain claim and the projection leaves both candidates contested.
A `correction` edge comes from a `retracted` claim and points at current claims
holding the same value. Without all of that the new claim is a plain claim, and
the projection reports a contest rather than a quiet replacement.

## The routing policy

`routeMemoryChange(change, policy)` runs every rule that applies and returns a
decision. **A change no rule flags is recorded as `proposed`: recallable, labelled
unreviewed.** A flagged change is `routed`: it records and recalls the same way, and
also becomes a Survey review item that a person decides. Review never blocks recall.

| Rule | Routes when |
|---|---|
| `contradicted-by-verification` | A Survey support-verification record bound to this claim's value says `contradicted`. A record for a different value does not apply. An abstention (timeout, malformed, error) is neither a pass nor a fail and does not route by itself. |
| `contested-by-accumulation` | Surface's accumulation projection (`projectAccumulation`, surface#359), run by the host for the claim's slot, returned `contested` and the claim is one of its candidates; or it returned `invalid` (identity unresolved, a replacement cycle, missing lineage: no unique answer). The Kit compares no values, no valid times and no edges itself. Surface keeps both candidates when it has not accepted a replacement, so an unreviewed succession is normally contested until a reviewer verifies the successor and the host's authority admits that verification; after that the projection returns `current` and this rule does not fire. (Normally, not always: a predecessor that has expired, or a replacement carrying the same value, can project `current` earlier. The projection decides.) A retraction is not a candidate and is not mapped: for the projection to exclude a retracted claim the host has to construct and admit a valid `revoked` event for it; mapping the retraction alone changes nothing there. A `stated` claim only: a plan or a what-if is never a candidate. With no projection passed, a claim is routed if the slot holds another stated claim ("not evaluated") and is not if it is alone. A property listed in `policy.multiValued` is not projected, because Surface has one value policy. A projection that names a rival which is not among the claims passed with it is refused (the claims passed are those in the claim\'s raw slot plus any the projection names), because the visibility bounds, the review item and the verification evidence are all built from those claims. A contest names at least two candidates. |
| `consequential-supersession` | A claim carries a `supersedes` edge and its property or subject type is in `policy.consequential` (`"*"` matches all). Retractions count. Empty by default, so a host that has not said what is consequential routes none; set it. |
| `entity-identity-change` | Any Survey entity proposal (`merge`, `split`, `alias`, and also `same-as`, `related-to` and `domain:*`, which Survey reviews the same way). They always go to review; no similarity score promotes an identity. The change is Survey's own `EntityProposal`, read by structure; the decision records its id, operations and subjects. |
| `low-extraction-agreement` | Fewer than `minPasses` passes were measured, or fewer than `minAgreement` of them produced the claim. Unmeasured is not agreed. |
| `visibility-widening` | The claim's visibility is not within a bound, in Surface's order (`meet(claim, bound) == claim`). The bounds are its source's visibility and the visibility of every claim passed as current for its slot, including a rival the projection names through an admitted identity mapping even when its raw subject differs. The rule flags a claim that would be visible to someone who cannot see one of those; it enforces nothing (stores do), and a current claim the host did not pass is not a bound. Undeclared is sealed on every side: a claim with no visibility can never widen anything, and a bound with none admits only a sealed claim, so a claim that declares a visibility fails closed against an undeclared source or peer. A host that declares nothing anywhere has nothing routed here and nothing visible. |

`hypothetical` and `proposed` claims are never candidates for a slot: they assert nothing about the present. They cannot carry a
`supersedes` edge either: the claim shape refuses one. They are still subject to agreement and visibility.

Defaults: `minPasses: 2`, `minAgreement: 1`, `multiValued: []`, `consequential` empty. The Surface
decision requires cardinality and value equality to be explicit versioned inputs: here
they are `multiValued` and the fixed structural-equality rule of Surface's `single-json-v1` value policy, which is the only one it projects.

### Recomputable

Each decision embeds its exact `input` (the claim, the same-slot current claims, the
applicable verification records, the agreement counts, the projection fact, the visibility baselines) and
the `policy`. `recomputeMemoryRouting(decision)` re-runs the rules over that and
reports any difference in outcome, reasons, rule list or digest, so an edited
outcome, a changed policy, or a rule set that has drifted since is visible. The rules
are pure; there is no clock and no model call.

### Review items

`runMemoryRouting` does the whole run: it decides each change, records the decisions and the metrics as one serialised unit, then hands each routed claim's review item to the host's queue (`publish(item, idempotencyKey)`). The key is the decision id, which does not depend on the order of a claim's audiences or edges, and is the same on a retry; a retry is a no-op only if the host's queue deduplicates on that key, which the Kit cannot enforce. Decisions are recorded before anything is queued; if the queue fails, the decisions are already recorded and a retry publishes again with the same keys. `published` lists only items the queue accepted. `buildMemoryReviewItem(decision)` returns the Survey `ReviewItem` for a routed claim:
a current/proposed pair when the decision's projection names a rival candidate, or the claim replaces one, that is among the current claims, otherwise one proposed candidate. Run a Survey `SupportVerifier` against the
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
supersede the earlier entry; recording routing decisions refreshes the run's metrics in the
same serialised unit, so metrics never describe fewer decisions than the run holds. All of
that holds within one process, for callers that reach the run through a directory that exists
(an alias made later for a directory that did not exist yet is resolved through its nearest
existing ancestor). Metrics are as fresh as the last write that went through these functions. Flow's run lock is not
re-entrant, so the check and the attach cannot share it: two processes racing can leave a
duplicate routing batch (readers dedupe by decision id) or two live metrics entries
(`readLatestMemoryMetrics` takes the last), and metrics written by one process can be stale-last against another's decisions until the next refresh. Neither loses or corrupts evidence. An atomic
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

The latest decision for an item stands, by instant (`11:00+02:00` is before `10:00Z`; an exact tie keeps the later
entry; a decision with an unreadable time never beats one with a time), and a change routed twice in one run counts
once, with its later decision. Only a `verified` or `assumed` decision confirms; `proposed` (the workbench's
"could not confirm") and anything Survey does not define is held. Review time is the dwell of the session that
submitted that decision, found by the decision's name and the latest submission by instant (sequence numbers are
per session, so they only order submissions within one); a submission that does not name the decision is not its time.
Call it again as review happens; `pending` falls and the review figures fill in. In a Flow run the review state
(Survey decisions and session events) is validated first (a malformed record is refused before anything is attached,
because evidence that breaks every later refresh cannot be removed), then recorded once as evidence
(`memory.review-record`; a repeat, in a batch or across batches, is not recorded again), and metrics are derived from everything recorded, so a later call that passes none, an identical
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

Not built here. Per the decision on `kontourai/corpus#40` (implemented in corpus#42, merged to corpus `main`,
`KnowledgeStoreCreateProposals`), a `proposed` claim is staged with `proposeCreate(candidate, proposerId, evidence)`
as a `pending` create proposal: no record exists until `applyCreate(proposalId, reviewerId)`, which needs a reviewer
distinct from the proposer (`SELF_APPROVAL` otherwise) and is where a routed claim's Survey decision lands.
`rejectCreate(proposalId, reviewerId, rationale)` keeps the proposal as `rejected`. The verbs are `applyCreate` and
`rejectCreate`, distinct from the concept-proposal `apply` and `reject`. This Kit does not call them: mapping a claim
onto `CreateInput` (type, title, body, category, provenance) is the store target's work (#670), not this PR's.

One consequence needs deciding before recall is wired: that contract keeps pending proposals out of the working set
and ordinary reads (`listProposals` is the explicit query), but a `proposed` claim must stay recallable (review never
blocks recall). A recall path therefore has to read `listProposals` filtered to `pending` and present the result
through `presentMemoryClaims`, or the store has to offer a labelled read. The injected-memory
marker (`kits/knowledge/memory-marker.js`, `#669`) wraps what recall injects; it is not
consumed here, and `presentMemoryClaims` does not apply it.

## Not in this slice

- Writing claims to the personal store (`#670`) and the dream pipeline's use of them
  (`#671`). Claims are returned and recorded as evidence; staging into a store is the
  next lane.
- Anything newer than the pinned releases. This package pins `@kontourai/surface` 6.3.0 and `@kontourai/survey`
  8.3.0 (exact versions, as released on npm). The Kit calls Surface's `meetVisibility` for the widening rule, takes
  Survey's `EntityProposal` as the type it reads, and fills Surface's own `AccumulationClaim` and
  `AccumulationQuery`. Tests replay Surface's meet vectors and a 37 x 37 grid of good and malformed visibilities
  through the pinned release, and run Survey's `createEntityProposal` over the emitter's output.
- Running Surface's projection. It needs custody (observations with digests and authenticated publishers) and an
  authority snapshot (owners, event admissions, replacement grants) that only the host holds, so the host runs
  `projectAccumulation` and the Kit reads the result. `src/cli/fixtures/memory-claims/accumulation.json` holds results
  from the real function, run over claims the Kit mapped, and a test replays them through the pinned Surface, in three states: nothing reviewed, a conflict and a replacement, and the same after a
  reviewer verified every claim and the host admitted those verifications.
- A Flow gate that requires this evidence.
