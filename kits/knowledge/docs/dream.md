# The dream run

The dream run distils accumulated agent sessions into proposed memory
claims and re-renders the budgeted briefs that session start reads. It is the
orchestration over four contracts that other lanes own. It adds no parser, no store, no
claim shape and no review queue of its own.

It is **off until an operator turns it on**, **never schedules itself**, and **only
proposes**: a claim becomes a record only when a reviewer other than the proposer applies
it.

## What it composes

| Stage | Owner | What the dream run does with it |
|---|---|---|
| Residue | `promote/runtime-session.js` ([#669](https://github.com/kontourai/flow-agents/issues/669)) | Reads the committed cursor, ingests complete sittings, commits the candidate cursor last. |
| Claims and routing | `memory-claims`, `memory-routing` ([#1571](https://github.com/kontourai/flow-agents/issues/1571)) | Distils each sitting with `distillMemoryClaims`, routes each claim with `routeMemoryChange`, builds Survey review items, derives run metrics, presents briefs with `presentMemoryClaims`. |
| Proposals | `promote/store-target.js` ([#670](https://github.com/kontourai/flow-agents/issues/670)) over Corpus `proposeCreate` ([corpus#40](https://github.com/kontourai/corpus/issues/40)) | Stages one create proposal per claim. |
| Brief file | profile brief contract v1 ([#672](https://github.com/kontourai/flow-agents/issues/672)) | Writes `{"version":1,"entries":[…]}`. |
| Model calls | `@kontourai/datum`, `@kontourai/dispatch`, `@kontourai/relay` | A Datum role resolves to a provider and model, Dispatch routes and budgets the call, a Relay `ModelRuntime` makes it. |
| Extraction | `@kontourai/traverse` | Grounds each claim in a verbatim excerpt. |

## Instinct confidence

An instinct is a learned pattern. Corpus stores a confidence value from 0 to 1 in the compiled record’s frontmatter. The migration preview plans this field, but does not write or apply a record. A reviewed record starts with a higher confidence score than an unreviewed proposal; age and scope also affect the final order. A compiled record whose confidence differs from its approved proposal is withheld from briefs until that change has a reviewed path.

Earlier unpublished drafts used a version 1.3 envelope to carry confidence. If an operator wrote any such proposal while testing those drafts, check it and confirm a recovery path before rolling back; an applied proposal may not be rejectable. The current implementation writes the existing 1.2 envelope and stores confidence on the Corpus record instead. Corpus versions before `0.1.0-next.3` may silently drop confidence when applying a pending proposal carrying confidence. Before rolling back, leave those proposals pending and do not apply them with the older store; verify their confidence after upgrading again.

A dream host can supply observation logs as `observationSources`. Each source needs a stable opaque `sourceId`, an explicit project ID or `null` for global scope and the log text. Keep the same source ID and scope across retries; a scope change is refused until the source is reconciled. The run stages each scrubbed tool event as a raw proposal and routes any extracted claim for review. Tool input and output may contain sensitive information and are sent to the configured extraction model. Session and source project identifiers are hashed but remain linkable across records; a scrubbed project name is retained in the private proposal.

The run writes proposals before saving the source cursor. A crash before the cursor save replays the same event identities and Corpus request keys; Corpus deduplicates the proposals. The source cursor advances only when every event in that source batch was handled, and replaces the temporary per-event replay markers. This cursor-last design does not require the transaction requested in [Corpus #72](https://github.com/kontourai/corpus/issues/72), but the host must keep publication idempotent. Ferry imports the observations.

Each event currently consumes one sitting in the run's model budget. With the default cap of ten, a backlog of 11,728 events needs at least 1,173 runs; review the model budget and run cap before enabling a backlog. A tool-derived claim cannot enter a brief until both its raw source and claim have been independently applied. A pending source may still contest another claim; a rejected, retired, or unverifiable source cannot authorize a brief.

An unfinished last line remains for the next run. When a log rotates, finish the archived file with its original ID and cursor before reading the new file under a new ID. If the archive has no final newline, first verify its last record is complete, then pass the whole file as an array of complete lines. The current dream host accepts text inputs, so that archive case needs separate operator reconciliation. A malformed line or changed source identity holds that source’s cursor and marks the run `blocked`; healthy sources and runtime sessions can still produce proposals and advance their own cursors. The command exits 3, and the report identifies each blocked source by a digest, reason code and its built-in error type when available. This differs from blocked telemetry, which returns before any proposals or cursor commits.

`OBSERVATION_SCOPE_CHANGED` and `OBSERVATION_PROJECT_CHANGED` require reconciling the source binding. `OBSERVATION_CURSOR_LEGACY` means an earlier draft saved a cursor without a scope binding. `OBSERVATION_EVENT_LIMIT` means the combined batch exceeded 100,000 events; earlier sources may need to drain first, or an oversized source needs an owner-managed rotation. The report uses `OBSERVATION_CURSOR_INVALID`, `OBSERVATION_IMPORT_FAILED`, `OBSERVATION_RESULT_INVALID`, `OBSERVATION_EVENT_ORDER`, `OBSERVATION_SOURCE_IDENTITY`, `OBSERVATION_EVENT_DUPLICATE`, `OBSERVATION_EVENT_CHANGED`, or `OBSERVATION_EVENT_INVALID` for other source failures. Inspect a private copy before retrying. Do not silently drop a line or edit a prefix already bound to a saved cursor.


## Planning confidence changes

`KnowledgeFlowRunner.consolidate` accepts an optional `instincts` array. Each item names a compiled `recordId` in the consolidation cluster, the linked observation `sourceIds`, the number of those sources already included in the stored baseline (`baselineSources`), the baseline observation time (`baselineAt`), the current time (`now`), current peer claims (`current`), and the source visibility (`visibility`). The runner checks that the compiled record and observation sources came from independently applied Corpus proposals, that the original sources are included, and that the reviewed legacy source explicitly records the same baseline confidence and time, original observations do not come after that time, and newly counted observations are later. It then plans reinforcement and weekly decay, and routes the claim through the existing memory router.

The returned `instinctPlans` are marked `requires-review`; the flow does not write the new score or retire an instinct. The returned `claimReviewItem` covers the claim, not the proposed confidence value, and `confidenceReview` is `not-bound`. Approving that item does not approve the score. Do not write the score until a review outcome is bound to the exact confidence change ([Survey #362](https://github.com/kontourai/survey/issues/362)). A score below 0.2 produces a retirement recommendation for review. An import whose baseline date cannot be verified cannot be safely decayed by this path. The dry-run migration preview preserves imported scores and reports decay as not evaluated rather than inventing a baseline date.

## Retiring the old instinct store

From the repository root, run `node kits/knowledge/instincts/retirement-plan.js` to print the current plan. Run it with `--help` for usage. The command only prints a checklist; it does not migrate data, change a schedule, alter an installed skill, or archive a store. A read-only preview is available with `node kits/knowledge/instincts/migrate.js --dry-run --legacy-root /absolute/copy --source-namespace stable-id [--instincts-root /absolute/copy] [--source-map /absolute/mapping.json] [--source-projects /absolute/projects.json]`. Choose a stable, opaque source namespace that identifies the original store; use the same namespace for its scratch copy and a different namespace for each other store. The preview reports counts and planned shapes without writing records. It does not rank a brief or perform a live migration, and an omitted instinct root is reported as not supplied. Unknown records and missing source links are counted, not treated as migrated. If legacy source references are not Ferry event IDs, `--source-map` accepts a JSON array of `{ "legacyId": "...", "file": "relative/path/observations.jsonl", "ordinal": 1 }` entries. The owner supplies and reviews these mappings; the preview marks them unverified. Duplicate mappings are refused. For any observation source used by an instinct, `--source-projects` supplies a JSON array of `{ "file": "relative/path/observations.jsonl", "project": "project-id" }` entries; use `null` only when the owner intends global scope. Unbound or mismatched sources are counted and cannot produce a candidate. The current supported instinct shape requires its observation time and source IDs; other shapes are counted as unsupported. The preview plans confidence in Corpus frontmatter. Consolidation can plan a review-required decay for an independently reviewed record with a verified baseline; it does not apply the result. A live migration command is not yet implemented.

Before retiring the old job, the owner must review a dry run against a copy, approve the live migration, and independently verify retrieval and brief quality. Keep the old store on disk as a read-only archive and retain the old job configuration. Identify the old store and its scheduler from your own configuration. For rollback, stop the new dream path first. If earlier draft testing wrote version 1.3 proposals, check each and confirm a recovery path before restoring the old archive and job configuration; applied proposals may block rollback. How to withdraw migrated proposals remains unverified. Do not delete the old store.

## The run

```
cursor read → ingest → distil → route → propose → publish → briefs → report → cursor
```

`runDream(host, options)` in `dream/run.js` is the callable flow. The same stages are the
steps of `flows/dream.flow.json`, each with a gate.

1. **Ingest.** Only *complete* sittings (the idle gap has passed) are distilled, up to
   `maxSittingsPerRun` (default 10, which bounds model spend). A sitting that is
   incomplete, over the cap, or whose extraction failed is left undone, and the cursor's
   telemetry offset stays at its old value so the next run reads it again. A finished
   sitting is recorded in the cursor by content hash, so it is not read twice.
2. **Distil.** Each sitting goes through `distillMemoryClaims` with two passes. If every
   pass fails, that is a model outage: the run fails with `DREAM_DISTILL_FAILED`. A sitting
   already in the store skips this stage.
3. **Route.** `visibility` (config or option, in Surface's lattice) is stamped on every claim and is the routing source baseline; absent reads as sealed, the narrowest. Every claim gets a recomputable routing decision. A flagged claim also
   becomes a Survey review item. Routing never promotes anything.
4. **Propose.** Each claim becomes a Corpus create proposal (`category: memory.claim`)
   whose body is one JSON envelope: the claim, its agreement, its routing decision, its
   sitting and the sitting's whole plan. Read back, a proposal is a claim again, and the
   claim's content-addressed id, the decision's recomputation and the plan's digest refuse
   a body edited after the fact.
5. **Publish.** `host.publish({runId, decisions, reviewItems, metrics})` hands the
   decisions to the host's review queue and Flow evidence. It is required: routed review is
   the only way a flagged claim is promoted, so a real run refuses to start without a way
   to deliver it (`DREAM_CONFIG_INVALID`). It must be idempotent.
6. **Briefs.** Rendered from the store on every run, because review changes them without
   any new telemetry. A file is rewritten only when its bytes change.
7. **Report.** `<dreamDir>/reports/<runId>.json`, one per run, the last 100 kept.
8. **Cursor.** Committed last, and only if it changed.

## Replay safety, and what is not here

**A brief is a derived view of one snapshot.** Each run reads the store's proposals once, judges them, and
writes the briefs; the store has no read transaction, so a claim another writer adds while the run is
between that read and the brief write is not in that run's verdict. It is picked up by the next run, which
re-derives the briefs from the store, so the window is one run. The same holds for a review decision that
lands mid-run.

The cursor is committed last, and the report is written before it, so any failure leaves
the cursor where it was and the next run repeats the work. Nothing fallible runs after the
commit (the follow-up report rewrite is best-effort, and the report already on disk names
the digest of the cursor it was about to commit). Each earlier step is replay-safe:

- **The plan is the receipt.** Every proposal's body carries the sitting's whole `plan`: the
  ordered claims the run decided to propose, with their agreement and project. It is
  written with the first proposal, so a run that dies partway leaves the plan in the store.
  The retry reads it back and proposes only what is missing, with no new model call, even if
  the model would now word everything differently. A sitting whose plan is fully in the
  store is reused the same way. A claim over 8 KiB is left out. A plan holds at most 32
  claims and 192 KiB; the run keeps the first by claim id that fit, and counts what it left
  out in `claims.truncated`. A decision embeds only the peers that change it (at most 16,
  counted in `claims.peers_capped` if more exist), so an envelope is about 0.6 MiB in the
  worst case, and a stored body over 4 MiB is refused before it is parsed. The envelope format changed while this was under
  review (now `1.2`); a proposal written by an earlier push of this branch fails with
  `DREAM_RECEIPT_CORRUPT` naming the format, and rejecting it in the store clears it.
- **Routing is decided now, not then.** The plan holds no routing decision, because a
  decision depends on what else is in the store and on the policy in force. Each proposal
  carries the decision made when it was proposed; a resumed or reused plan is routed again
  against today's claims, policy and visibility, the run acts on that (review items,
  `publish`, metrics), and `claims.rerouted` counts the claims whose outcome changed. The
  other claims of the same plan are peers too, so two claims from one sitting that disagree
  are routed to review against each other. A decision is made when a claim is proposed or its
  plan resumed; a policy change on a later no-op run does not re-publish. A plan is keyed by
  the visibility it was made under (compared as a set of audiences, as claim identity is),
  because visibility is part of a claim's identity: changing it starts a new plan and a new
  extraction.
- A claim already proposed, in any state, is reused by its claim id. A rejected proposal
  stays rejected and is not proposed again.
- **Corrupt or forged receipts stop the run.** A proposal by this proposer that does not
  verify (bad claim id, a routing decision that does not follow from its own input, a plan
  that does not match its digest) fails the run with `DREAM_RECEIPT_CORRUPT` naming it, and
  proposals of one sitting that disagree on its plan fail it with `DREAM_RECEIPT_MISMATCH`.
  The run never skips past one, because skipping would propose again or call a sitting
  whole that is not. Rejecting the bad proposal in the store is the operator's way past it.
  Another proposer's unreadable proposal is only counted.
- A proposal with this claim id made by a different proposer is refused
  (`DREAM_SEMANTIC_COLLISION`); it is never reused as the run's own.
- When `proposeCreate` fails, its outcome is indeterminate (the proposal may exist). The
  run asks the store what landed, lists it in the failed report, and the retry reuses it.
- A response that does not deliver the extraction (no tool call, a truncated or malformed
  one) fails the pass. A sitting whose every pass failed fails the run with
  `DREAM_DISTILL_FAILED`; a delivered, empty extraction is a sitting with nothing in it.
- A sitting may propose at most 32 claims. The run keeps the first 32 by claim id and
  counts the rest in `claims.truncated`.

**Why the lock is small.** `dream.lock/` is mutual exclusion and nothing more, built so that
nothing is ever removed from under a live owner. It holds numbered epoch directories, and the
owner is whoever made the highest. An epoch appears whole: its owner record is written into a
private staging directory that is then renamed to `<n>`, and a rename onto an existing epoch
fails, so one caller makes each epoch and no one can see an epoch without its owner (there is
no half-made state to mistake for debris, however long a caller pauses). A caller reads the
highest epoch; if its process is alive the lock is held. Otherwise (none, released, or its
process is gone) it makes the next epoch and re-reads: if a higher epoch has appeared it was
passed by others, removes only its own epoch and reports the lock held. Only the winner
removes older epochs (best effort), and the highest stays after release, so an epoch number is
never reused. A live pid is never evicted for being old, so a reused pid keeps the lock until
that process exits. Failing to mark the epoch released, or to remove an old one, never fails a
run. `@kontourai/monument` owns idempotency keys, dedup, record-before-effect and owner
liveness, and it is `private: true` in the Station workspace, so this repository cannot
consume it. The cursor, Corpus proposals and the lock are the only durable state. Adopting
Monument later replaces the lock and the reconciliation, and makes this repository its first
consumer outside Station. See [the tracking issue](https://github.com/kontourai/station/issues/4485).

**Flow gates.** `flows/dream.flow.json` declares a gate per step and the claim each expects.
`runDream` does not evaluate them: gate evaluation belongs to the host's Flow run. The seam
is `options.onStage(stage)`, called at every stage boundary (`ingest`, `distill`, `route`,
`propose`, `receipt`, `publish`, `brief`, `report`, `cursor`); a host binds its Flow run
there, and a throw stops the run before the next stage. Nothing in this repository claims a
gate was evaluated.

## Models

`createRoleRuntime({ role })` resolves the Datum role (default `extraction-default`)
without reading the credential, binds it with `bindDatumResolvedRef`, and exposes a
Dispatch-routed Relay runtime with a per-invocation token budget. `extractForRuntime`
turns that runtime into the `extract` function `distillMemoryClaims` takes, through
Traverse's `extract()`. No provider SDK is imported by the dream run. The default runtime
factory supports `anthropic-compatible` roles; a host that needs another provider passes
`createRuntime`.

`model.js` carries a small Relay-to-Traverse provider shim, because this repository pins
Traverse 0.19.1 and Traverse 5.x already ships it as `@kontourai/traverse/relay`
([traverse#92](https://github.com/kontourai/traverse/issues/92)). Delete the shim when
Traverse is bumped ([#1577](https://github.com/kontourai/flow-agents/issues/1577)).

The run asks the model to treat the transcript as untrusted text. The residue it sends
has already been scrubbed (secrets, emails, home directories) by #669, deterministically
and without a model, so a transcript cannot talk its way past the scrub.

## The briefs

`<dreamDir>/briefs/global.json` and one `project-<id>.json` per project that has a
claim, where `dreamDir` defaults to
`$XDG_DATA_HOME/knowledge-store/knowledge/dream` (the path #672's reader uses). A project
id is the sitting's working-directory name. Nothing else decides scope.

- **Sealed claims.** A claim whose visibility is sealed (none given, or restricted to no audience) is never in a brief: a brief is injected into sessions, and sealed means visible to no one. Set `visibility` in the config, for a single-owner machine usually `{"kind": "restricted", "audiences": ["user:<you>"]}`; without it the run still proposes, but nothing it proposes reaches a brief.
- **Current and uncontested only.** A brief ranks claims that are current and that no rival
  contests. A stated claim is *contested* when another stated claim in the same slot holds a
  different value over an overlapping valid time and neither replaces the other. Every claim in a
  contested slot leaves the brief, applied or not: a pending rival contests a reviewed
  claim until review settles it, and rejecting the rival (or retiring the loser's record)
  brings the survivor back. A contested pair is a review-queue matter, not brief content:
  the later claim is routed to review when it is proposed (`contested-by-accumulation`), a
  pending claim the brief holds back for a rival that its own decision never flagged (the
  earlier of two, or a rival from another writer) is routed on the run that finds the contest
  and handed to `publish` (`claims.contested_routed`), and `brief_excluded.contested` counts
  what the brief held back. The same `publish` is therefore called with some decisions again on
  later runs, which is why it must be idempotent. A claim replaced by a *reviewed* (applied) stated claim
  of the same speaker in the same slot (a `succession` edge), or withdrawn by that speaker's own
  retraction of the same value (a `correction` edge), is superseded: an edge from an unreviewed
  claim replaces nothing, and as in Surface an unreviewed succession leaves both candidates contested until a
  reviewer verifies the successor, so neither is in the brief meanwhile; another speaker's edge, or an edge into another slot,
  replaces nothing. Values are read as review left them: a Survey correction presents the
  reviewer's value, and a claim rejected in review contests nothing; a hypothetical or retracted claim asserts nothing about the present.
  A plan (`proposed` posture) neither contests nor is contested. This is a local stand-in for
  Surface's accumulation projection (surface#359), which owns "which claims are current", is
  published in Surface 6.3.0, and needs host-supplied admission decisions. See
  [#1584](https://github.com/kontourai/flow-agents/issues/1584).
- **Where the contest fact comes from.** #1571 routes on a projection fact (`contested-by-
  accumulation`) and compares no values itself; Surface's `projectAccumulation` is meant to produce
  it, run by a host that holds the custody it needs (observations with digests and an authority
  snapshot). It is published in Surface 6.3.0, but this run holds no custody, so there is no seam for it
  here yet: **the dream produces the fact itself** with `classifyCurrent`, the local stand-in
  (`gapCodes: ["dream-stand-in"]` in every stored fact says so), computed over the values review has
  left. There is one verdict function, but it is given different claims at different moments: routing
  asks it about the claim, the stored peers (including applied ones whose settlement the brief later
  fails to verify) and the plan's siblings; the brief asks it about the claims it has verified. So the
  review-queue backfill is handed the brief's own verdict, which makes the queue and the brief agree
  for every claim the backfill covers. Routing a claim at proposal time can be more cautious than the
  brief (it sees unverified peers); it is never less cautious about a verified contest, because the
  backfill reconciles it on the same run. The backfill covers *pending* claims. Two claims that are both
  already applied and disagree are held back from the brief and counted in `brief_excluded.contested`,
  but a reviewer already decided on each, so they are not re-queued. Replacing it with the real projection, and adding a host seam for
  that, is [#1584](https://github.com/kontourai/flow-agents/issues/1584). A fact stored in a
  decision is bounded to the claim, its rivals and 17 ids, 16 gap codes of at most 120 characters,
  and a `truncated:` code saying what was cut (`claims.facts_truncated`); the claim stays a
  candidate, so the outcome is the same. A plan's claims are peers of one another and of the stored
  claims, each once; a decision embeds at most 16 peers (the rivals first, then any peer the claim
  would be wider than), and `claims.peers_capped` counts each time more were left out.
- **Eligibility (the quarantine).** An `applied` proposal is eligible when its record is active and is
  the record Corpus made from it: the record's `apply-create` entry names the proposal and the record body
  is the proposal's. A settlement that points at some other record is excluded as `unverified`; one the
  distiller approved itself as `self_approved`; a retired record as `inactive`. A `pending` proposal is
  eligible only with `includeUnreviewed: true`, and only if routing left it `proposed`; it is then
  labelled unreviewed. A `pending` claim routing sent to review waits for the review. A `rejected` one
  never appears.
- **Rank** = confidence × recency × scope. Confidence is `0.55 + 0.45 × agreement` for an
  applied claim and `0.5 × agreement` for a pending one, where agreement is the share of
  extraction passes that found the claim, so review always outranks agreement. Recency is
  `1 / (1 + age / 30 days)`. Scope is 1 for the project's own claims, 0.75 for a claim
  with no project, and a project brief drops other projects' claims. Ties break on newer
  observation, then claim id.
- **Budget.** Bytes, joined as #672 joins them (`\n\n`), are a hard upper bound on tokens.
  Defaults are 6144 bytes global and 2048 per project (about 1.5k and 0.5k tokens), and
  one entry is capped at 512 bytes. Entries are added in rank order; the first that does
  not fit is cut at a character boundary with an ellipsis, and nothing after it is added.
- **Labels.** Every entry is `presentMemoryClaims` text, so it begins with posture and
  review label. That function labels from Survey review decisions. Pass them with
  `host.reviewDecisions()`; without them an applied claim reads as unreviewed, which
  understates and never overstates. A decision changes a claim (confirms, corrects or
  withholds it) only when the host attests `reviewerKind: "human"` on the Survey session;
  the run gives `presentMemoryClaims` no routing record, so every claim is treated as
  routed and an agent's or unattested decision only annotates it.
- **The reader's rules.** Control characters, bidi overrides and the injected-memory
  markers are removed from every entry, because #672's reader drops the whole file if any
  entry has one.
- **After a purge.** If the store was opened with a purge fence (below), erasing a record also
  stops it reaching new sessions through briefs: the purge deletes the brief files, and sessions
  refuse any brief written before the purge, even one restored from a backup. The next dream run
  writes fresh briefs from what is left. This meets
  [store contract Addendum M](./store-contract.md) for briefs.

  A fenced purge removes the record from the store and tries to delete `global.json` and every
  `project-<id>.json` in `<dreamDir>/briefs/` (other files there, such as editor backups, are left,
  and a delete that fails is reported through `onScrub` but does not fail the purge).
  It does **not** remove: the erased text inside other proposals and records from the same sitting
  ([#1612](https://github.com/kontourai/flow-agents/issues/1612)); backups and snapshots of the
  store; context already given to a running session; anything erased through a store opened
  without the fence (closing that needs a Corpus change, a purge counter that every open store
  advances: [corpus#75](https://github.com/kontourai/corpus/issues/75)).

  **How it works.** The *gate* is `<dreamDir>/purge-gate.json`:
  `{"version":1,"generation":"<token>","state":"settled"|"purging"}`. `settled` means briefs may
  be served; `purging` means a purge is under way. The token is replaced at the start and end of
  every purge. Each brief records the token it was compiled under as `purgeGeneration`, and the
  session-start reader serves a brief only while the gate is `settled` and the two tokens match.
  A store never purged through a fence has no gate file, and its briefs keep the plain
  `{"version":1,"entries":[…]}` shape.

  **To turn it on,** pass a purge fence when you open the store:
  `corpusStore: { …, purgeFence: createPurgeFence({ dreamDir }) }`. `createPurgeFence` is exported
  from `dream/index.js`, and both store adapters accept the option. Any host that erases must open
  its store this way. Every `purge` (and `purgeProposal`, where the package has it) then does this:
  1. Opens the gate (`purging`, new token) and makes it durable **before** the store is touched. If
     the gate cannot be opened or synced to disk (a permission or I/O error), the purge does not run.
     A platform that cannot sync a directory at all is the one exception: it skips the sync.
  2. Runs the purge.
  3. Deletes the brief files, then settles the gate with another new token, whether the purge returned
     or threw. A file that cannot be deleted is reported through `onScrub` and does not fail the
     purge, because the token already stops it being served. If the gate itself cannot be confirmed
     settled, a purge that succeeded throws `PURGE_GATE_NOT_SETTLED`, and a purge that failed throws its own
     error with the settle error attached as `gateSettleError`. Briefs compiled before the purge stay
     refused either way, but the new gate may already allow fresh briefs.

  Guarantees:
  - A brief compiled before the purge is never served, even if its file is put back (a restored
    backup, a delete that failed): its token is old.
  - A dream run that took its store snapshot before the purge and writes after it carries an old
    token as well. The run also re-reads the gate after writing; if it changed, it deletes what it
    wrote and reports `briefs_held: "purge-raced"`. The next run starts after the purge and rebuilds.
  - If the process dies mid-purge, the gate stays `purging`: no brief is served and no dream run
    writes one (`briefs_held: "purge-in-progress"`). To recover, make any fenced purge call. It
    settles the gate even if the purge itself fails. Sessions start without memory until then.
  - A `purge-gate.json` that cannot be read as a gate also refuses every brief, and dream runs write
    none (`briefs_held: "purge-gate-unreadable"`).
  - Two fenced purges cannot overlap: the second fails with `PURGE_GATE_BUSY`.
  - A dream run never blocks a purge: it takes no lock the purge needs.

  Limits: the gate sits beside the briefs, so deleting `purge-gate.json` by hand also removes the
  protection (an old unstamped brief is then served again). And a session that is already reading the
  brief when a purge begins is not stopped; before purging, the host must wait for sessions
  that are already reading briefs to finish (Addendum M).

## Invocation contract (what a host scheduler calls)

This is the surface a host scheduler (Station's hosted scheduler, station#4484) binds to. It is
pinned by `src/cli/dream-host.test.mjs`, so changing it breaks a test.

| What | Name |
|---|---|
| Flow id | `knowledge.dream` (`kits/knowledge/flows/dream.flow.json`) |
| Kit adapter id | `knowledge.dream-runner` (`kits/knowledge/dream/index.js`) |
| Library call | `runDream(host, options)`, exported from `kits/knowledge/dream/index.js`; resolves to the run report |
| Command | `node kits/knowledge/dream/cli.js run --config <abs> [--dry-run] [--trigger NAME]`; prints the report as one JSON line |
| Exit codes | 0 ran (success, noop, dry-run), 1 failed, 2 disabled or misconfigured, 3 blocked telemetry, 75 another run holds the lock |
| Report | `schema_version: "1.0"`; `status` is `success`, `noop`, `dry-run`, `blocked` or `failed`. A real run writes it to `<dreamDir>/reports/<run_id>.json`; a dry run returns it and writes no file |
| Briefs held back | `briefs_held` is `null`, or why this run wrote no brief: `purge-in-progress` or `purge-gate-unreadable` (nothing written), `purge-raced` (written, then deleted because a purge opened during the run) |
| Stage names | `ingest`, `distill`, `route`, `propose`, `receipt`, `publish`, `brief`, `report`, `cursor` (passed to `options.onStage`) |

`options.trigger` is recorded in the report and nothing else, so a scheduler can name itself.

Details a binding must respect:

- **The host.** Called as a library, the host must supply `extract`; only the CLI builds one from a Datum role. A real run also needs `publish`.
- **Where failures surface.** A run that fails after it has started throws with `error.report` attached and, from the CLI, prints that report. Failures before it starts (disabled, locked, misconfigured, host module missing, untrusted, unloadable, or whose factory throws) carry an error `code` and no report: from the CLI they exit 2, except a held lock, which exits 75.
- **Reading a `success` report.** The report on disk is written before the cursor is committed and names it (`cursor.commit_intent`, `digest`, `offset`). `cursor.committed` is true in the returned report and, when the follow-up rewrite succeeds, on disk. If the process died between the two, the report says `success` with `commit_intent`, and the cursor may or may not have moved. A consumer reconciles by comparing `cursor.digest` with the cursor file; the file is the authority.
- **Stable, additive.** Report fields are added, never renamed or removed, within `schema_version` 1.0. The test pins the current key sets, so adding one is a deliberate edit.

## Turning it on

Nothing is on by default. A host (Station's scheduler is the hosted path,
[station#4484](https://github.com/kontourai/station/issues/4484)) calls `runDream`, or
runs the CLI:

```bash
node kits/knowledge/dream/cli.js run --config /abs/dream.config.json [--dry-run] [--trigger NAME]
```

```json
{
  "enabled": true,
  "telemetryFile": "/abs/telemetry/full.jsonl",
  "transcriptRoots": ["/abs/agent-a/transcripts", "/abs/agent-b/transcripts"],
  "host": "/abs/dream-host.mjs",
  "role": "extraction-default",
  "visibility": { "kind": "restricted", "audiences": ["user:you"] },
  "includeUnreviewed": false
}
```

The config and the `host` module are operator-owned code: each must be a regular file
owned by you, not group or world writable, with no symlink on its path and no directory
above it that another user can write. The check and the import are two steps, so a process
running as you could still swap the file between them; that attacker already is you.
`host` exports `createDreamHost({ config, dryRun })`, which returns what the run must not
discover for itself: `{ store, registerRoot, root, rootName, publish, reviewDecisions?,
runtime? | extract? }`. Under `--dry-run` the host is told, and must open its store without
creating or writing anything. The store is a Corpus store for `root`. With neither `runtime`
nor `extract` the model is the Datum role. Exit codes: 0 ran, 1 failed, 2 disabled or
misconfigured, 3 blocked telemetry, 75 another run holds the lock.

`--dry-run` is read-only: it ingests and reports which sittings it would distil, and
makes no model call, takes no lock and writes no file.

### Hook trigger (opt-in)

`dream/hook-trigger.js` is a command for a harness's `SessionEnd` or `PreCompact` hook.
It is inert unless the hook's environment sets `FLOW_AGENTS_DREAM_TRIGGER=1` **and**
`FLOW_AGENTS_DREAM_CONFIG=/abs/dream.config.json` names a config that says
`"enabled": true`. When on, it spawns the CLI detached with no stdio and exits 0. It runs
no model itself, blocks nothing, and starts at most one run per
`triggerMinIntervalMs` (default 15 minutes). A trigger that fires during a run starts a
process that exits 75. No default hook profile registers it; you add it to your own
harness settings:

```json
{ "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /abs/kits/knowledge/dream/hook-trigger.js" }] }],
             "PreCompact": [{ "hooks": [{ "type": "command", "command": "node /abs/kits/knowledge/dream/hook-trigger.js" }] }] } }
```

The sitting that has just ended is not complete yet (its idle gap has not passed), so a
run it triggers distils earlier sittings, and the next run picks that one up.

### Disable and roll back

Set `"enabled": false`, or unset `FLOW_AGENTS_DREAM_TRIGGER`. To drop what a run
proposed, reject its proposals in Corpus; they never became records. To stop the briefs
being read, delete `<dreamDir>/briefs/`. Keep `purge-gate.json`: without it the reader cannot tell a
brief written before a purge from one written after. To re-ingest from the start, delete the cursor
file; sittings already proposed are reused, not re-proposed.

## Not verified here

Real transcripts, a real personal store, a real Corpus store (`corpus#42` is unmerged;
the tests use a store with its proposal shape and rules), a live provider, a scheduler
and the injection hook reading these briefs have not been exercised end to end.
