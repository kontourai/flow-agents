# The dream run

The dream run distils accumulated Claude Code and Codex sessions into proposed memory
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

The cursor is committed last, and the report is written before it, so any failure leaves
the cursor where it was and the next run repeats the work. Nothing fallible runs after the
commit (the follow-up report rewrite is best-effort, and the report already on disk names
the digest of the cursor it was about to commit). Each earlier step is replay-safe:

- **The plan is the receipt.** Every proposal's body carries the sitting's whole `plan`: the
  ordered claims the run decided to propose, with their agreement and routing decisions. It
  is written with the first proposal, so a run that dies partway leaves the plan in the
  store. The retry reads it back and proposes only what is missing, with no new model call,
  even if the model would now word everything differently. A sitting whose plan is fully in
  the store is reused the same way.
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

**Why the lock is small.** `dream.lock` is mutual exclusion and nothing more: the file is
hard-linked into place whole, so no reader sees a half-written lock, and an owner is stale
only when its process is gone. `@kontourai/monument` owns idempotency keys, dedup,
record-before-effect and owner liveness, and it is `private: true` in the Station
workspace, so this repository cannot consume it. The cursor, Corpus proposals and the lock
are the only durable state. Adopting Monument later replaces the lock and the
reconciliation, and makes this repository its first consumer outside Station. See
[the tracking issue](https://github.com/kontourai/station/issues/4485).

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
- **Eligibility (the quarantine).** An `applied` proposal is eligible when its record is
  active and is the record Corpus made from it: the record's `apply-create` entry names the
  proposal and the record body is the proposal's. A settlement that points at some other
  record is excluded as `unverified`. A `pending` one is eligible only with `includeUnreviewed: true`, and only if
  routing left it `proposed`; it is then labelled unreviewed. A `pending` claim routing
  sent to review waits for the review. A `rejected` one never appears. A proposal the
  distiller itself approved is excluded.
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
  understates and never overstates.
- **The reader's rules.** Control characters, bidi overrides and the injected-memory
  markers are removed from every entry, because #672's reader drops the whole file if any
  entry has one.

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
  "transcriptRoots": ["/abs/.claude/projects", "/abs/.codex/sessions"],
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
being read, delete `<dreamDir>/briefs/`. To re-ingest from the start, delete the cursor
file; sittings already proposed are reused, not re-proposed.

## Not verified here

Real transcripts, a real personal store, a real Corpus store (`corpus#42` is unmerged;
the tests use a store with its proposal shape and rules), a live provider, a scheduler
and the injection hook reading these briefs have not been exercised end to end.
