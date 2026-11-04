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
| Which claims are current in a slot, whether it is contested, supersession over time | Surface (`projectAccumulation`, surface@6.3.0). The host runs it (it needs observations with custody and an authority snapshot the Kit does not hold); the Kit maps its claims in (`memoryAccumulationClaims`, which carries every claim a replacement chain reaches and gives one claim one Surface claim: edges in id order, instants as the UTC date-times Surface parses for years 0000-9999, and the claim's JSON content copied so an undefined field and an absent one are the same; a subject id or claim type with surrounding whitespace, or a blank slot field, is refused because Surface refuses that slot), reads the result back together with the query it answered (`memoryAccumulationFact(result, query)`: the fact carries the query's slot, outcome, candidates and supporting claims) and routes on it. A result without its query is refused, and a fact whose query slot is not the claim's own (compared as Surface compares slots) is refused. That is a check on what the host says, not on the result: a projection result carries no query of its own, so the Kit cannot tell a genuine result for the claim's slot from a genuine result for another slot passed with the claim's query. Binding the query, the result and the projection's inputs together is the trusted host's job. The design is [Surface's knowledge-accumulation decision](https://github.com/kontourai/surface/blob/7486c6d8b3d942b1b2aa11e4cdd958f8b1b8aa9f/docs/decisions/knowledge-accumulation.md). The Kit still takes the current claims as input, for the visibility bounds and the review item. |
| Entity merge, split and alias review | Survey (entity review and the host-attested reviewer kind, survey@8.4.0). The Kit emits proposals in Survey's `EntityProposalInput` and routes them to its review. |
| Visibility lattice | Surface ([Surface derived visibility](https://github.com/kontourai/surface/blob/18e3570636cdb5f9e73d38d9274a2bcd1dc04b9f/docs/decisions/derived-visibility.md), surface@6.3.0). A claim's `visibility` is Surface's form and the Kit's order is Surface's own `meetVisibility`, called, not restated. |
| Gates and evidence | Flow. |

## The claim

`schemas/knowledge/memory-claim.schema.json`. One immutable, identified assertion:

| Field | Meaning |
|---|---|
| `subject` | `{type, id, label}`, Surface's `(subjectType, subjectId)`. `id` is the lower-cased label until entity review says otherwise. |
| `claimType`, `property`, `qualifiers` | Surface's `claimType`, `fieldOrBehavior` and canonical qualifiers. With the subject they are the *slot* a claim competes in. The slot key is Surface's own `canonicalClaimKey` with `claimType` added, as the decision specifies; `claimType` is compared exactly, as Surface does (`fact` and `FACT` are two slots). The extractor does not produce qualifiers yet, so slots are coarser than Surface's and conflict more readily. |
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
| `contested-by-accumulation` | Surface's accumulation projection (`projectAccumulation`, surface#359), run by the host for the claim's slot, returned `contested` and the claim is one of its candidates; or it returned `invalid` (identity unresolved, a replacement cycle, missing lineage: no unique answer). The Kit compares no values, no valid times and no edges itself. Surface keeps both candidates when it has not accepted a replacement, so an unreviewed succession is normally contested until a reviewer verifies the successor and the host's authority admits that verification; after that the projection returns `current` and this rule does not fire. (Normally, not always: a predecessor that has expired, or a replacement carrying the same value, can project `current` earlier. The projection decides.) A retraction is not a candidate and is not mapped: for the projection to exclude a retracted claim the host has to construct and admit a valid `revoked` event for it; mapping the retraction alone changes nothing there. A `stated` claim only: a plan or a what-if is never a candidate. With no projection passed, a claim is routed if the slot holds another stated claim ("not evaluated") and is not if it is alone. A property listed in `policy.multiValued` is not projected, because Surface has one value policy. Who is in the slot is the *raw slot* (same subject, claim type, property and qualifiers) plus every claim the projection names, as a candidate or as support: with an admitted identity mapping and equal values Surface returns `current`, names nobody as a candidate, and lists the joined claims only as support. A claim the projection names must be a stated claim of the same claim type, property and qualifiers (the subject is the one dimension a mapping may change; the mapping itself is the host's authority, which the Kit cannot check), and must have been passed with it; otherwise the change is refused, not routed. The same membership bounds the visibility rule, the review item and `verifyMemoryClaimAgainstCurrent` (pass it the fact). More than 64 peers is refused at the door and in a stored decision. A contest names at least two candidates. |
| `consequential-supersession` | A claim carries a `supersedes` edge and its property or subject type is in `policy.consequential` (`"*"` matches all). Retractions count. Empty by default, so a host that has not said what is consequential routes none; set it. |
| `entity-identity-change` | Any Survey entity proposal (`merge`, `split`, `alias`, and also `same-as`, `related-to` and `domain:*`, which Survey reviews the same way). They always go to review; no similarity score promotes an identity. The change is Survey's own `EntityProposal`, read by structure; the decision records its id, operations and subjects. |
| `low-extraction-agreement` | Fewer than `minPasses` passes were measured, or fewer than `minAgreement` of them produced the claim. Unmeasured is not agreed. |
| `visibility-widening` | The claim's visibility is not within a bound, in Surface's order (`meet(claim, bound) == claim`). The bounds are its source's visibility and the visibility of every claim passed as current for its slot, including every claim the projection names through an admitted identity mapping even when its raw subject differs. The rule flags a claim that would be visible to someone who cannot see one of those; it enforces nothing (stores do), and a current claim the host did not pass is not a bound. Undeclared is sealed on every side: a claim with no visibility can never widen anything, and a bound with none admits only a sealed claim, so a claim that declares a visibility fails closed against an undeclared source or peer. A host that declares nothing anywhere has nothing routed here and nothing visible. |

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

### Who may promote a routed claim

**A routed claim is promoted to reviewed only by a Survey review outcome from a human reviewer** (owner decision, 2026-11-03).
That covers every routed claim: a contradiction, a consequential supersession, an entity merge or split, a visibility widening, a
low-agreement claim. An outcome from an `agent` or `rule` reviewer, or from a reviewer whose kind is not attested, may *annotate*
the item and must not change it: the claim stays `proposed` and routed, whatever the outcome says (accept, correct, or reject: an
agent cannot withhold a claim either). A claim routing did not flag stays `proposed` until reviewed, and any reviewer's decision
applies to it, **but only if the record that says it was not flagged is one the Kit's own rules reproduce** (`recomputeMemoryRouting`):
that record is what waives the human requirement, so it is earned. A record with an edited outcome, an outcome the Kit does not define,
or one that does not recompute is skipped as if it had not been passed, and a claim with no usable routing record is treated as routed.
When a claim has several records the strictest (routed) stands, whatever order they come in. A claim whose routing is not known (no routing record is passed to recall) is **treated as routed**, so unknown fails
closed. Among the human decisions on an item the latest by instant stands; a later agent decision never displaces an earlier human
one, and an earlier agent decision never blocks a later human one.

The kind is `reviewerKind: "human" | "agent" | "rule"` on the Survey decision and on its session events, **asserted by the host that
authenticated the reviewer, never by the reviewer** (Survey 8.4.0, kontourai/survey#360). `memoryReviewerKind(decision)` is the one
place the Kit reads it: the decision's own `spec.reviewerKind`, as data, validated by Survey's `isReviewerKind`, failing closed. A
missing field (a record made before Survey 8.4.0, which Survey's projection calls an *inferred* kind), an unknown value, a value that is
not text, an inherited or getter-defined one, or one nested under `actor` reads as `unattested`, and `unattested` is not human. A kind
Survey marks inferred is not an attestation either: a `reviewerKindInferred` that is present and not exactly `false`, on the decision's
`spec` or under `metadata.survey` (where a projection carries it), makes the kind `unattested`; Survey's own rule for a consumer that
requires a human is `reviewerKind === "human"` and `reviewerKindInferred === false`. The Kit does not use Survey's
`resolveReviewerKind`, which infers a kind for a record that has none. Stored review state with a `reviewerKind` that is not one of
the three, or a `reviewerKindInferred` that is not a boolean, is refused, as Survey refuses an unknown kind. `memoryReviewOutcome(decision, itemName)` only says what a decision *means* (confirm, correct, reject, hold) and does not look at who made it: a host that acts on it directly asks `memoryDecisionMayPromote` first. `memoryDecisionMayPromote(decision, {routed})` (exported by the adapter with `memoryReviewerKind`) is the check a host makes before passing a decision to
Survey's `entityOutcomeFromDecision` (entity review is Survey's; the Kit does not call it). Each routed claim's review item carries the
label `memory.reviewer: human-required`, so a workbench can show what the item needs. Review time is the deciding reviewer's own: session events tagged `agent` or `rule` (or marked inferred), or by another actor than the decision's, are not borrowed as its time, and the review time is attributed only when these checks find the history unambiguous. A decision does not name its session (nor does anything else in the data), so the submission counted is the one made at the instant the decision says it was reviewed, and the time is null rather than guessed when: no submission matches (replay keeps the snapshot's `reviewedAt`, so an honest review can match nothing); more than one session submitted this decision name for the item, at any time; or one session name carries the same sequence number twice among the deciding reviewer's events, whatever item they concern (two histories that reused a name, as Survey's default session name invites). Events that name no actor are admitted as legacy events and cannot say whose they are, so the figure is a bounded estimate and not an audit of who spent the time; a durable decision-to-session binding belongs in Survey. Recall reports the annotations it ignored
(`review.annotations`) and metrics count them (`reviewer.annotated`); an item with only annotations is `pending`.

### Data the Kit records is plain data

Everything the Kit validates and then records or presents is read once and copied as plain JSON, and the copy is what is
validated and used: a routing change (claim, current claims, verifications, agreement, entity proposal), a run or evidence
request, review input, a distill request (the sitting is copied before extraction starts, so claims name the source reference
and times the model was given), each extraction pass's response as it arrives (an extractor that reuses and edits an object it
returned cannot change a claim after it was checked; a response that is not plain data is a failed pass, reported as a warning),
the claims recall presents, and the claims the accumulation mapper and the verifier read. The Kit refuses what JSON would change or
drop or what could answer differently the next time it is read: accessors, `-0`, holes, class instances and array subclasses,
cycles, a `__proto__` key, anything over a size or depth bound, and **any Proxy** (a Proxy answers every question as it likes, so
no list of checks makes one safe; it is refused, not defended against). Request fields are chosen with selectors that run nothing
the caller defined (no getter, no overridden `map`, no trap). Recall reads the routing records of the claims it presents and no others, and takes the few small fields it shows from a
decision; a record that says a claim was not routed is recomputed before it is believed, which costs as much as the decision is
large (a legitimate decision of about 3 MB took 183 ms to recompute in review), so recall's work is bounded by the records of the
claims it shows, each already bounded where it was taken in, and not by a separate aggregate budget. Two deliberate exceptions to refusing: a recall claim that cannot be copied is
*withheld and reported*, and a `sourceVisibility` that cannot be copied is recorded as undeclared, which reads as sealed (it can
only make a claim route, never widen it). The entity emitter requires `confidenceComponents` to be an object (or absent), as
Survey does. The Kit is stricter than Survey in one place: `-0` is refused, because it does not survive JSON.

`memoryClaim`, `assertMemoryClaim` and `assembleMemoryClaims` are the exception to copying: they are constructors and validators for
data the caller owns, read as given, and need a trusted-data precondition. The entry points that take data from elsewhere copy first.

**What the Kit produces, it can read back.** The bounds are written once (`src/memory-json.ts`) and the larger are derived from the
smaller, so an artifact the Kit makes is never one its own readers refuse:

| Bound | Value |
|---|---|
| JSON values in one claim, review decision or review event | 20,000, nested at most 32 deep |
| Peers a claim is checked against | 64 (more is refused, not cut short) |
| Support-verification records on one decision | 64, each up to 2,000 values (a Survey record is ids and digests, about 15 values) |
| One routing decision | `(64 + 1) x 20,000 + 64 x 2,000 + 200,000` = 1,628,000 values, nested at most 40 deep (a claim sits a few levels down); the 200,000 is an allowance for baselines, the projection fact and the policy |
| One extraction response | 250,000 values |
| One request list | 20,000 entries (a sitting of more than 20,000 turns is refused) |
| What one run holds across requests | 1,000,000 routing decisions, review decisions and review events each; a host may lower it with `maxHistoryEntries` |

`assembleMemoryClaims` rejects, with the reason, a claim that exceeds the claim bounds, so `distillMemoryClaims` never returns one
that routing or recall would refuse, and every other part of a decision is bounded where it is taken in (peers, verification records, the policy at
20,000 values, projection lists at 1,000 entries, a visibility at 1,024 audiences), so a decision the Kit produces always fits the
decision bound; a test pins that the parts sum to less than it, and `routeMemoryChange` still checks the decision it produced against the bound as a net, refusing one that does not fit with the reason. `recomputeMemoryRouting` applies the same per-item budgets to what a
decision embeds, so a hand-built decision with a claim or verification record the Kit could not have produced is not recomputable. A request that would take a run past its history limit is refused before anything is written (see Flow evidence).
Each bound is per item: there is no aggregate budget for a whole request or a whole batch, and no byte budget for strings. A host
that accepts untrusted workloads needs those limits itself. The decision in the worst-case test (65 claims at the claim bound, 1,024-audience visibilities, a full projection fact and a policy near its bound; 1,389,585 values against the bound of 1,628,000, of which the policy is 19,508 of its own 20,000) is produced, recomputed, turned into a review item and presented in about a second on a development laptop.

## Flow evidence

`recordMemoryRoutingEvidence({runId, gate, cwd, decisions})` attaches a batch of
decisions, and `recordMemoryMetricsEvidence` the run's metrics, to a gate of a Flow
run the host owns, as custom-kind evidence (`memory.routing-decisions`,
`memory.run-metrics`). A decision that does not recompute is refused before anything
is attached. Re-attaching the same content returns the existing entry; new metrics
supersede the earlier entry. **One gate holds a run's metrics** (a second is refused), so "this gate's live entry" and the run's
latest figures cannot disagree. `recordMemoryMetricsEvidence` records only figures equal to what the run's recorded evidence derives
(a stale snapshot, or figures computed elsewhere, is refused rather than allowed to supersede the correct ones), and
`refreshMemoryRunMetrics` is how figures are brought up to date. Retrying figures that this gate recorded earlier and that have
since been superseded returns the entry that holds them and writes nothing; another gate's entry is never the answer.

A digest only proves a file is the one recorded, so what is read back is checked before figures are derived from it, and every
stored payload is checked (a second record that reuses a decision's id is checked too, not collapsed away unread). A routing record
must belong to the run and be a known version, and every decision in it must still recompute; a review decision needs its kind, a
name, the item it decides, a status Survey defines and a time; a review event needs its kind, a session, an integer sequence, one
of Survey's event types and a time. Those are shape checks, not a full Survey validation.

**A request is refused whole or recorded.** `refreshMemoryRunMetrics`, `recordMemoryRoutingEvidence`, `runMemoryRouting` and
`supersedeMemoryRoutingEvidence` check, before they write anything, the state the request would leave: that this gate may hold the
run's metrics (one gate does; a request on another is refused), that every routing record that will be live is derivable, that the
decisions being added recompute, that review state is valid, and that no kind of history passes `maxHistoryEntries` (default and
maximum 1,000,000; a host may lower it). After that, deriving the figures cannot fail for a reason decided there. What this cannot
rule out is an I/O failure or a crash between two writes: if the routing record is attached and the metrics are not, the figures
describe fewer decisions than are stored until the next call, which repairs them (an identical retry does).

If stored routing evidence is bad (a record that no longer recomputes, or one of another run), every request on that run is
refused, which is the point: no figures are derived from evidence that disagrees with its own rules. The way out is
`supersedeMemoryRoutingEvidence({supersedes, decisions})`. It attaches a corrected record that supersedes the named live routing
records, after checking, as a whole, that the corrected decisions recompute, that the records which stay live are derivable and that
the history limit holds; an identical retry returns the record it already made, for as long as that record is still live (once the replacement has itself been superseded, the same request is refused as naming records that are no longer live). Figures, the recomputation report, the room check and
`readMemoryRoutingDecisions` read the live records, so after recovery recall shows the corrected routing; the superseded record stays
in the manifest, readable with `readMemoryRoutingEvidence`, as the audit trail. A clean report over the live records is not a clean
history, so audit the superseded entries too. Passing no `decisions` quarantines the named records without replacing them: that is a
trusted-host administrative act, and it is not a block-list (recording the same decisions again records them again).
`recomputeRecordedMemoryRouting(runId)` reads the stored files back (refusing any whose digest no longer matches), recomputes every
live payload, repeats included, and names the bad ones.

All of that holds within one process, for callers that reach the run through a directory that exists (an alias made later for a
directory that did not exist yet is resolved through its nearest existing ancestor). Flow's run lock is not re-entrant, so the check
and the attach cannot share it: two processes racing can leave a duplicate routing batch (readers dedupe by decision id) or two live
metrics entries (`readLatestMemoryMetrics` takes the last), and metrics written by one process can be stale-last against another's
decisions until the next refresh. Neither loses or corrupts evidence. An atomic conditional attach is a Flow feature
([kontourai/flow#295](https://github.com/kontourai/flow/issues/295)).

A routing policy with a field the policy does not define is refused (the decision schema allows none), and its lists must be lists of names; a decision recorded by an earlier build with an extra policy key therefore no longer recomputes (none of this repository's fixtures has one).

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
  decision yet, or only annotations), `unmatched` (a decision for something this run did not route), `annotated` (decisions by an
  agent, a rule or an unattested reviewer on a routed item: they promote nothing and leave it pending), and
  `defectsCaught` = `corrected + rejected`;
- `reviewSeconds`: selection-to-submission dwell from Survey session events,
  summed over decisions that have both events, with `reviewTimedDecisions` saying how
  many. It is an upper bound on attention and is `null`, never estimated, without events;
- `reviewSecondsPerCaughtDefect`.

The latest *human* decision for a routed item stands (see Who may promote a routed claim), by instant (`11:00+02:00` is before `10:00Z`; an exact tie keeps the later
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
rejected are *withheld and reported*, never presented bare. Only a human reviewer's decision promotes, corrects or withholds a
routed claim; an agent's or rule's is reported in `review.annotations` and changes nothing. A claim a human reviewer corrected
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
  8.4.0 (exact versions, as released on npm). The Kit calls Surface's `meetVisibility` for the widening rule, takes
  Survey's `EntityProposal` as the type it reads and its `isReviewerKind` for the reviewer kind, and fills Surface's own `AccumulationClaim` and
  `AccumulationQuery`. Tests replay Surface's meet vectors and a 37 x 37 grid of good and malformed visibilities
  through the pinned release, and run Survey's `createEntityProposal` over the emitter's output.
- Running Surface's projection. It needs custody (observations with digests and authenticated publishers) and an
  authority snapshot (owners, event admissions, replacement grants) that only the host holds, so the host runs
  `projectAccumulation` and the Kit reads the result. `src/cli/fixtures/memory-claims/accumulation.json` holds results
  from the real function, run over claims the Kit mapped, and a test replays them through the pinned Surface, in three states: nothing reviewed, a conflict and a replacement, and the same after a
  reviewer verified every claim and the host admitted those verifications.
- A Flow gate that requires this evidence.
