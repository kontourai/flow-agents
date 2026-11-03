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
   pass fails and no claim comes back, that is a model outage: the run fails with
   `DREAM_DISTILL_FAILED`. It is not read as a sitting with nothing in it.
3. **Route.** Every claim gets a recomputable routing decision. A flagged claim also
   becomes a Survey review item. Routing never promotes anything.
4. **Propose.** Each claim becomes a Corpus create proposal (`category: memory.claim`)
   whose body is one JSON envelope: the claim, its agreement, its routing decision and
   its sitting. Read back, a proposal is a claim again, and the claim's content-addressed
   id and the decision's recomputation refuse a body edited after the fact.
5. **Publish.** `host.publish({runId, decisions, reviewItems, metrics})` hands the
   decisions to the host's review queue and Flow evidence. It must be idempotent.
6. **Briefs.** Rendered from the store on every run, because review changes them without
   any new telemetry. A file is rewritten only when its bytes change.
7. **Report.** `<dreamDir>/reports/<runId>.json`, one per run, the last 100 kept.
8. **Cursor.** Committed last, and only if it changed.

## Replay safety, and what is not here

The cursor is committed last, so any failure leaves it where it was and the next run
repeats the work. That is safe because each step is replay-safe:

- A sitting whose claims are all in the store (the envelope records its index and count)
  is reused: no model call, no duplicate.
- A claim already proposed, in any state, is reused by its claim id. A rejected proposal
  stays rejected and is not proposed again.
- A proposal with the same claim id made by a different proposer is refused
  (`DREAM_SEMANTIC_COLLISION`). It is never reused as the run's own.
- When `proposeCreate` fails, its outcome is indeterminate (the proposal may exist). The
  run asks the store what landed, lists it in the failed report, and the retry reuses it.

**Accepted gap.** Corpus has no idempotency key yet
([corpus#45](https://github.com/kontourai/corpus/issues/45)), and a model is not
deterministic. If a run dies *partway through one sitting's proposals*, the retry
distils that sitting again and may produce a differently worded claim. The claims that
landed first stay as extra `pending` proposals. They are real, grounded and unreviewed,
and a reviewer sees them; they are not duplicates by id. A sitting is whole only when all
of its claims are in the store.

**No crash-safety layer beyond that.** `@kontourai/monument` owns idempotency keys, dedup,
record-before-effect and owner liveness, and it is `private: true` in the Station
workspace, so this repository cannot consume it. The run keeps the cursor and the Corpus
proposals as its only durable state, plus a single-writer lock file (`dream.lock`) that
is mutual exclusion and nothing more. Adopting Monument later replaces the lock and the
reconciliation, and makes this repository its first consumer outside Station. See
[the tracking issue](https://github.com/kontourai/station/issues/4485).

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

- **Eligibility (the quarantine).** An `applied` proposal whose record is active is
  eligible. A `pending` one is eligible only with `includeUnreviewed: true`, and only if
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
  "includeUnreviewed": false
}
```

`host` is an operator-owned module (regular file, owned by you, not group or world
writable) exporting `createDreamHost({ config })`, which returns what the run must not
discover for itself: `{ store, registerRoot, root, rootName, reviewDecisions?, publish?,
runtime? | extract? }`. The store is a Corpus store for `root`. With neither `runtime`
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
