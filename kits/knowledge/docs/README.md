---
title: Knowledge Kit
---

# Knowledge Kit

A Flow Kit for durable, gated knowledge storage. The kit defines a store contract with precise
record types, mutation operations, and provenance requirements — then ships a default adapter
backed by markdown files, YAML frontmatter, `[[wikilink]]` inline links, and a JSON graph
index.

Any storage backend can adopt this kit by implementing the contract without forking kit flows.

---

## Provider entry and optional projections

The installed Kit manifest declares `knowledge.store-providers` at
`providers/index.js`. Its Markdown vault, Git repository and health APIs can be
loaded without Surface or Neo4j packages. The providers remain readers and
proposal producers; importing them does not approve or apply a change.

`buildKnowledgeTrustBundle` loads `@kontourai/surface` only when explicitly
called. A consuming Node project that uses that projection must supply a
compatible Surface package (the Flow Agents package manifest records the version
used by this distribution). If it is unavailable, the projection rejects; it
does not produce a placeholder bundle or block unrelated vault reads. Neo4j
likewise needs its driver and service only when that provider is selected.

## Contract Summary

See [`store-contract.md`](store-contract.md) for the full specification. Quick reference:

**Record types**

| Type | Purpose |
|---|---|
| `raw` | Unprocessed source material — excerpts, transcripts, URLs with notes. |
| `compiled` | Normalized, editor-reviewed distillations of raw records. |
| `concept` | Named ideas or principles that other records reference. |
| `snapshot` | Bounded decision summary for a topic (Addendum A). |
| `person` | Entity card with links to mentions (Addendum C). |

Both bundled adapters admit all five types. `provenance.agent` is required;
`source_ids`, `session_id` and `note` are optional creation provenance. A compiled
label or source link does not establish that review happened or content is true.
See the [canonical envelope and adapter differences](store-contract.md#1-record-types).

**Record status lifecycle**

| Status | Meaning | Default |
|---|---|---|
| `active` | Default lifecycle state; archive and query filters still apply. | Yes (records without status field are treated as active). |
| `implemented` | Marked implemented with the supplied artifact reference; not excluded by the lifecycle filter. | No |
| `retired` | Excluded from default working-set queries; history preserved. | No |

**Mutation operations**

| Op | Required evidence fields |
|---|---|
| `create` | `type`, `title`, `body`, `category`, `provenance.agent` |
| `update` | `agent` (in evidence) + at least one mutable field |
| `link` | `agent`, non-empty `links` array |
| `propose` | `agent`, `proposal` (non-empty) |
| `apply` | `agent`, `new_body` (non-empty), `rationale` (non-empty) |
| `reject` | `agent`, `reason` (non-empty) |
| `supersede` | `agent`, `rationale` (non-empty), non-empty `supersededIds` array |
| `retire` | `agent`, `rationale` (non-empty), `implementedByRef` (when `targetStatus="implemented"`) |

Every mutation throws with `error.code === "MISSING_EVIDENCE"` when required evidence is absent.

**Record identity resolution** (Addendum H)

`get`/`getLinks` accept three handle forms, resolved in order: exact full `id`, then a
category-scoped **slug alias**, then an **unambiguous id prefix** (≥ 8 chars).

| Handle | Example | Resolves to |
|---|---|---|
| Full id | `a1b2c3d4-1c4f-4a0e-8b6e-9d2f0a5b7c31` | the record (unchanged exact-id behavior) |
| Slug alias | `decision.design/2026-01-01-api-shape` | the record that carries that alias |
| Short-id prefix (≥ 8 chars, unique) | `a1b2c3d4` | the single record whose id starts with it |

Aliases are caller-supplied via the optional `aliases: string[]` field on `create`/`update`,
append-only, and stored in a slug-to-full-id alias map (`alias-index.json`) so a prefix or slug **still
resolves after a store restructure** (e.g. a recategorize that moves the file). An unresolved
handle returns `null` from `get`. `getLinks` instead falls back to the literal
input as a graph-index key; it returns empty arrays only when that key has no
indexed links. Dangling targets can therefore have backlinks without a stored
record. Use `get` to check record existence. An **ambiguous** prefix throws
`error.code === "AMBIGUOUS_ID"` — it is never silently guessed. On-disk identity (`records/<id>.md`)
is unchanged.

**Known default-store identity gap:** contained path-like opaque ids can normalize
to a different filename from their stored id. Such a record can be created and
read while a unique stored-id prefix fails, or an unissued normalized spelling
returns it. `get` and `getLinks` can also disagree on normalized spellings. The
required exact/alias/prefix contract remains; see the
[path-normalization disclosure](store-contract.md#known-default-store-path-normalized-identity-gap).

**Known bundled graph-query gap:** the required `getLinks` array result is not met
for some prototype-named keys. On an empty graph, `getLinks("constructor")` can
throw a plain `TypeError` because an inherited object property is treated as an
array. A no-link record with that opaque id can still be created/read via `get`
while graph lookup fails. This is an implementation gap, not a reserved-id rule;
see the [graph-key disclosure](store-contract.md#known-bundled-graph-key-handling-gap).

| Error code | Raised when |
|---|---|
| `AMBIGUOUS_ID` | an id prefix matches more than one record (carries a `matches` array) |
| `SLUG_CONFLICT` | a supplied slug alias is already assigned to a different record; the bundled false-conflict gap below can also raise it without an owner |

**Known bundled alias-admission gap:** an unused `constructor` alias meets the
slug syntax but can be rejected by either adapter's `create` or `update` with
`SLUG_CONFLICT`. An inherited property in the alias map is mistaken for an owner.
This is separate from graph-query failure and does not introduce a reserved-alias
rule; see [alias registration](store-contract.md#h4-slug-aliases).

---

## Running the Contract Suite

The contract suite is a `node:test` suite parameterized by adapter.

### Default adapter (runs automatically)

```bash
node --test kits/knowledge/evals/contract-suite/suite.test.js
```

### Alternative adapter

```bash
KNOWLEDGE_ADAPTER=/path/to/my-adapter.js \
  node --test kits/knowledge/evals/contract-suite/suite.test.js
```

Or via CLI flag:

```bash
node --test kits/knowledge/evals/contract-suite/suite.test.js \
  -- --adapter=/path/to/my-adapter.js
```

### Expected output (default adapter)

All tests pass and exit 0. Any failure indicates a contract regression or an adapter gap.

---

## Acceptance Criteria Mapping

| AC | Requirement | Evidence |
|---|---|---|
| AC1 | Contract doc exists; mutation ops enumerate evidence fields. | [`docs/store-contract.md`](store-contract.md) — §6 plus Addenda A/B cover eight mutations; §8 consolidates the interface. |
| AC2 | Default adapter passes contract suite (command evidence). | Run `node --test kits/knowledge/evals/contract-suite/suite.test.js` — exit 0, all tests pass. |
| AC3 | Record round-trips raw → stored → queried with category + links intact. | Suite §2 "create: round-trip raw → stored → queried" tests this directly. |

**Identity resolution (#339)** — mapped to that issue's ACs:

| AC (#339) | Requirement | Evidence |
|---|---|---|
| AC1 | Unique 8-char prefix resolves; ambiguous prefix throws `AMBIGUOUS_ID`. | Suite §15 "identity: short-id prefix resolution (AC1)". |
| AC2 | Slug alias resolves via `get`/`getLinks` (set at create or update). | Suite §16 "identity: slug alias resolution (AC2)". |
| AC3 | Old slug + short-id prefix survive an `update` recategorize/move. | Suite §17 "identity: alias resolution survives restructure (AC3)". |
| AC4 | Existing sections pass unmodified; files remain `records/<id>.md`. | §2 round-trip, §13 graph consistency, §12 missing-record unchanged; on-disk naming untouched. |
| AC5 | Contract doc specifies prefix/slug/alias-map semantics. | [`store-contract.md`](store-contract.md) Addendum H + §1.1/§7/§8.1/§9 updates. |

---

## Default Adapter Details

Located at `adapters/default-store/index.js`. It uses Node.js built-ins and the
bundled YAML reader described in the [store contract](store-contract.md#9-yaml-frontmatter-convention-default-adapter).
No external runtime installation is required.

**Storage layout**

```
<store_root>/
  records/
    <id>.md        ← one markdown file per record, YAML frontmatter + body
  graph-index.json ← forward + reverse link index, schema_version 1.0
  alias-index.json ← slug → id alias map (Addendum H), schema_version 1.0
```

**Constructor**

```js
import DefaultKnowledgeStore from './adapters/default-store/index.js';
const store = new DefaultKnowledgeStore({ storeRoot: '/path/to/store' });
```

**Interface** (all methods return Promises):

- `create(input)` → `Promise<string>` (new id)
- `update(id, fields, evidence)` → `Promise<void>`
- `link(sourceId, links, evidence)` → `Promise<void>`
- `propose(conceptId, proposerId, evidence)` → `Promise<void>`
- `apply(conceptId, proposerId, evidence)` → `Promise<void>`
- `reject(conceptId, proposerId, evidence)` → `Promise<void>`
- `get(idOrHandle)` → `Promise<Record | null>` (exact id, slug alias, or unambiguous id prefix — Addendum H)
- `getLinks(idOrHandle)` → `Promise<{ forward: Link[], reverse: Backlink[] }>`;
  a backlink contains `source_id` and `kind`, while a forward link uses `target_id`;
  the prototype-key implementation gap above can prevent this required result
- `listByCategory(category, options?)` → `Promise<Record[]>`
- `listByType(type, options?)` → `Promise<Record[]>`
- `supersede(newId, supersededIds, evidence)` → `Promise<void>`
- `retire(id, targetStatus, evidence)` → `Promise<void>`
- `reindex()` → derived graph-index recovery report

---

## Flow

The kit ships these flows:

**`knowledge.store-contract`** — gates on three evidence claims before a store implementation
is accepted: contract-suite pass, provenance-enforcement pass, and round-trip integrity pass.
The pipeline flows below build on this adapter infrastructure.

### Living Context: standalone Context Check

**`knowledge.context-check`** is a deterministic, proposals-only flow for checking whether
saved context can be recalled at a particular repository revision and whether a bounded change
requires a source-owned update. It is deliberately separate from the large store flow-runner and
from Builder composition.

The input follows
[`schemas/knowledge/context-check-input.schema.json`](../schemas/knowledge/context-check-input.schema.json):
it binds a workspace, repository, exact 40-character Git commit SHA, target audience, changed
surfaces (or diff paths), and one or more selected `git-repo` Knowledge roots. The result follows
[`schemas/knowledge/context-check-result.schema.json`](../schemas/knowledge/context-check-result.schema.json).

```js
import { runContextCheck } from "./context-check/index.js";

const result = runContextCheck({
  repoRoot: "/work/repository",
  proposalDir: "/work/run/proposals", // explicit; the only writable location
  input: {
    schema_version: "1.0",
    workspace: "platform",
    repository: "example/repository",
    revision: "0123456789abcdef0123456789abcdef01234567",
    target_audience: "maintainer",
    changed_surfaces: ["src/context-adapter.js"],
    knowledge_roots: [{
      id: "repository-decisions",
      provider: "git-repo",
      manifest_path: "knowledge/claims.json"
    }]
  }
});
```

Each selected manifest is read only by `git show <resolved-sha>:<manifest-path>` after the
adapter verifies that `repoRoot` is the named worktree root and that the requested SHA is a raw
commit object. It clears inherited `GIT_*` environment overrides and disables Git replacement and
graft semantics; an unreadable revision or manifest fails closed. The adapter never falls through
to a dirty working tree.
Recall results use contextual statuses `current`, `superseded`, and `unverifiable`; a no-answer
is explicit for **each missing requested claim id** (`unverifiable` with reason `no_answer`) and
makes the result `not_verified`, even when other requested claims were recalled.
Those are recall/currentness statements, not trust decisions.

Reconciliation compares exact declared affected surfaces with the bounded input and leaves clean
controls clean. An intersection is only `affected` and requires reconciliation; it is never a
`contradicted`, broken, or trust verdict unless the selected authoritative fixture explicitly
supplies contradiction evidence. Affected unverifiable claims remain `unverifiable` and still
route a proposal to their owning source without deriving trust. Every intersecting surface is
returned.

Affected claims yield only a minimal `context-update` proposal routed to the claim's declared
owning source. The adapter never edits docs, decisions, or Knowledge records. With `write: true`
(the default), `proposalDir` must be an existing private non-symlink directory. Writes use
exclusive no-follow file creation and reject symlink components or targets before creating output;
use `write: false` for a fully read-only check.

The flow documents the Ops #121 `holds`/`broken`/`unverifiable` terms solely as consumer
vocabulary. Ops #121 and Surface retain any claim-evidence-freshness or trust authority; Context
Check does not derive or replace it. Product effectiveness remains an Evals responsibility.

Both input and result are checked through the shared Knowledge JSON-schema validator. Result
reconciliation uses status-specific variants: `contradicted` requires authoritative evidence,
`clean` has no affected surface, and `affected`/`unverifiable` require at least one. The shared
result validator also rejects `verdict: pass` whenever any recalled entry is `unverifiable`,
including a no-answer. Path inputs reject traversal through either slash style, leading/trailing
whitespace, and control characters before execution.

Run the deterministic fixture suite:

```bash
node --test kits/knowledge/context-check/context-check.test.js
```

### Living Context recall contract (Context Check 1.1)

**`knowledge.living-context`** extends the Context Check recall without changing `1.0`: the
`1.0` flow and its schemas are unchanged, and `runContextCheck` refuses a `1.1` input rather than
running it under `1.0` rules. (The shared Knowledge schema validator now ignores inherited object
property names, so a `1.0` input carrying an undeclared `constructor`, `toString`, `__proto__`
or `hasOwnProperty` key is now rejected; every other `1.0` input behaves as before.) The `1.1` entry
points live in `context-check/living-context.js` (recall and reconciliation) and
`context-check/living-context-answer.js` (the answer step); loading `index.js` still needs no Surface
or Survey package, but the `1.1` modules need `@kontourai/surface` with the derived-visibility exports
(Surface 6.3.0 or later, kontourai/surface#350) and `@kontourai/survey`. Schemas:
[`living-context-input`](../schemas/knowledge/living-context-input.schema.json) and
[`living-context-result`](../schemas/knowledge/living-context-result.schema.json).

```js
import { runLivingContext } from "./context-check/living-context.js";
import { answerLivingContext, createLineSupportVerifier } from "./context-check/living-context-answer.js";

const input = {
  schema_version: "1.1",
  workspace: "platform", repository: "example/repository",
  revision: "0123456789abcdef0123456789abcdef01234567",
  target_audience: "maintainer",
  reader: "maintainer",                              // required; authenticated by the host
  as_of: { now: "2026-06-01T00:00:00Z" },            // required; valid_at / known_at default to now
  budget: { max_tokens: 4000 },                      // required; no default budget
  changed_surfaces: ["src/context-adapter.js"],
  knowledge_roots: [{ id: "repository-decisions", provider: "git-repo", manifest_path: "knowledge/claims.json" }]
};
const recall = runLivingContext({ repoRoot, input, proposalDir });   // evidence only
const answer = await answerLivingContext({                           // separate, abstaining step
  repoRoot, input, verifier: createLineSupportVerifier()             // a verifier is required; inject a model or human one in production
});
```

**Identity is required and fails closed.** A missing or blank `reader` is `READER_IDENTITY_REQUIRED`;
a reader that every selected root does not list under its manifest `readers` is
`UNKNOWN_READER_IDENTITY`. The reader is admitted at every selected root before a single claim of any
root is parsed, and before any file is written. Context Check does not authenticate: the host supplies
an identity it has authenticated, and Context Check only refuses one it does not recognise.

**Visibility is Surface's.** A claim's `visibility` is written in Surface's declared forms: `"public"`
or `{ "audiences": ["maintainer"] }` (the reader id is the audience label). It is read with
`readDeclaredVisibility` and enforced with `visibilityAllows`; anything undeclared or unreadable, a bare
array included, is sealed and visible to no one. Per-viewer supersession is `viewerSupersessionView`
(kontourai/surface#350): an edge applies only to a viewer who may see its successor, so **a successor the
reader cannot see leaves the predecessor `current` for them, with no trace of it** (the result is
identical to one where no successor exists), chains through hidden claims collapse to the nearest visible
successor, and a cycle among visible claims leaves them `unverifiable` (`supersession_cycle`). An edge
carries its own visibility (`supersession_visibility`, by default that of the claim that carries it); an
unreadable one is sealed and the edge is followed for no one. A malformed claim that Surface says the
reader may not see, or that was recorded after `known_at`, is dropped without an error, so a parse error
never describes it; an entitled reader's error, whatever its family, names the claim, never its array
position. A reader's view of an id is built only from the copies they may see: a hidden duplicate neither
changes their answer nor is observable, whatever its content or file order, and two copies they may see
and that are known at `known_at` are a `DUPLICATE_CLAIM_ID` error. When every copy of an id is hidden and
there is more than one, no copy can stand for the id and no combination of them is safe (a union can create a
hidden cycle that makes Surface drop a real supersession), so the id is ambiguous: a visible claim whose
recorded, visible edge chain reaches it is `unverifiable` (`supersession_ambiguous`), never current or
superseded, in any file order. Identical hidden copies count as disagreeing: an id carried twice is a
manifest defect, and Context Check does not decide which copy was meant. The walk follows recorded,
reader-visible edges through hidden claims and stops at the first claim the reader can see; it does not
re-apply slot or interval admission to the ambiguous id, so it can over-trigger but never under-trigger, and
an untimed claim reports `knowledge_time_unknown` first. The cost is disclosure of one bit: because the
ambiguous id is left out of the structure, every claim on that chain loses its history beyond it, which can
change their chains, token costs (and so budget admission and answers), and a hidden cycle it was part of. An edge the reader may not see (its
`supersession_visibility`) explains nothing: no chain link, no reason, no status change, so for a reader who may not see the edge an
untimed or cross-slot successor also leaves both claims current. Asked for by id, a hidden, absent, or
not-yet-known claim returns the same plain `no_answer`; a default scan never names one. Reconciliation
and proposals cover only claims the reader may see. A claim that is unverifiable because of its own
validity (stale, untimed, outside its valid time, or declared unverifiable) reconciles as `unverifiable` when
the change intersects it (an unaffected claim stays `clean`);
supersession trouble (a cycle, an ambiguous id, a missing edge time) says nothing about whether the change
contradicts the claim, so recorded contradiction evidence and ordinary `affected` status are reported as usual. Stated limits: admission of an edge uses the times and
slot of both ends, so a hidden claim's times can decide whether a chain through it collapses, though never
what the reader is shown; and a dangling pointer is indistinguishable from a hidden successor.

**As-of on two time axes**, with the semantics of Surface's knowledge-accumulation decision
(kontourai/surface#204, merged as Surface `7486c6d`): `known_at` is knowledge time, filtered on the
manifest's `recorded_at` (the receiver-recorded instant, never a claim's own authored time), and `valid_at`
is valid time, a half-open `[from, until)` interval from `valid_time` (an absent bound is unbounded and
asserts nothing about perpetual truth). A supersession edge is its own observation: it is admitted only
once the claim's `supersession_recorded_at` and its successor's `recorded_at` are at or before
`known_at` (untimed is indeterminate, never guessed, and makes a claim whose visible successor is untimed
`unverifiable`), and both ends must declare the same `slot` or the edge is inert and the claim
`unverifiable`. A `succession` takes effect at the successor's `valid_time.from`; a `correction` (the
default) applies within the successor's valid interval, throughout when it has none. Contradiction
evidence needs `reconciliation_recorded_at` by `known_at`, and a `verified_at` after `known_at` cannot
anchor a TTL. The authority text itself is read at the pinned revision, not as of `known_at`: pin the
revision that existed at the knowledge cut. No wall clock is read: `now` is explicit and also the instant
freshness is judged at; `expires_at`/`ttl_seconds` govern freshness only, never world validity. Full slot
identity, cardinality, `contested` outcomes, and the admission policy for who may supersede whom are not
modelled: Surface's accumulation projection (`projectAccumulation`) would own them but needs a
host-protected authority snapshot a Git manifest cannot supply, so consuming it is tracked in
kontourai/flow-agents#1586 (see the decision record). `status` is the status **as of the stated instants** and the result echoes them, so a
predecessor read at a `valid_at` before its succession, or a `known_at` before its successor was recorded,
is `current` with a reason saying exactly why. A superseded claim is never `current` for a reader who can
see a successor that is recorded, in effect and on the same slot, along an edge the reader may see
(`supersession_visibility`) and the chain is acyclic: an edge the reader may not see deliberately leaves both
claims current for them, and a cycle that exists only through hidden claims is Surface's rule (it does not
change what the reader sees; see the decision record).

**Reasons, not just rank.** Every recall carries `matched_signals`, `freshness` (Surface's
claim-intrinsic `expiresAt`/`ttlSeconds`, judged `now > expiry` exactly as Surface does; a stale
claim that would otherwise be current is `unverifiable`, while a superseded one stays `superseded` and
reports `freshness.stale: true`), `review_posture` (`proposed` unless the manifest names a reviewer),
`supersession_chain` (only edges this reader may see, whose ends were recorded by `known_at`), and
`reasons`. The sparse plain `no_answer` entry carries none of these by design: it must say nothing. A requested `claim_ids` list keeps its own order; a default scan lists claims that
intersect the change first, then by id. Order is the only ranking, and the reasons say why each
result is there.

**Budget.** `budget.max_tokens` is explicit. Each result's cost is `ceil(utf8 bytes / 4)` of its
JSON (the estimator is named in the result), no-answer entries included. Results are kept or
dropped whole in that order and never truncated; a result that does not fit is dropped and the
next one is still tried. Every drop is listed by id with its estimated cost, and a drop makes the
verdict `not_verified`. Reconciliation and proposals are not budgeted, so a dropped recall never
hides an affected claim.

**Abstention is a separate step.** Recall returns evidence and never an answer.
`answerLivingContext` re-derives recall and sends only a `current` recall, with its authority
document read at the pinned revision, to an independent `@kontourai/survey` `SupportVerifier`;
a verifier is a required argument. `createLineSupportVerifier` is a deterministic fixture floor (the
claim statement must be a whole line of its authority text); it cannot read negation, so production
callers inject a model or human verifier. Only `supported` answers; `contradicted` is
reported; `not-addressed`, an abstaining, throwing, or timed-out verifier, an unreadable, empty or
oversized (`MAX_EVIDENCE_BYTES`) authority document, and budget drops all abstain, and any
abstention makes the set `not_verified`. Each verdict is kept as Survey's immutable
`CandidateVerification`.

**Change observation.** `observeRepositoryChange({ repoRoot, base, head })` turns two raw commits
into the `diff.paths` input. It is a thin shim: Lookout observes registered web, API and
structured-file sources over guarded HTTP (plus structural and proposal diff helpers over those
observations) and has no Git-revision source yet. It refuses an empty or oversized
change (`maxPaths`, default 500) rather than truncating.

Freshness is Surface's, not a second derivation. Ephemeris is the time actor that wakes a Flow run
at a claim's deadline (it derives wake-up instants, not a trust or freshness status), so it is not a
dependency of a synchronous, explicit-`now` check.

```bash
node --test kits/knowledge/context-check/living-context.test.js
```

---

## Decision Lifecycle — Retiring Records (S7)

The `knowledge.retire` flow marks an existing record `implemented` or `retired` using the
evidence below. Both transitions preserve its body, links and creation provenance.
Only `retired` triggers the default lifecycle exclusion; `implemented` does not.
The adapter's separate working-set exclusions still apply.

### Status transitions

| From | To | Evidence required |
|---|---|---|
| `active` | `implemented` | `rationale` (non-empty) + `implementedByRef` (non-empty ref to implementing artifact) |
| `active` | `retired` | `rationale` (non-empty) |
| `implemented` | `retired` | `rationale` (non-empty) |
| `retired` | *(any)* | Invalid — `retired` is terminal |

### Working-set exclusion

Retired records are excluded from:

- `listByType(type)` — default query
- `listByCategory(category, options)` — default query
- `defaultSimilarityDetector` — default cluster candidates
- `createVectorSimilarityDetector` — vector cluster candidates

For `listByType` and `listByCategory`, `{ includeRetired: true }` disables only the
retired-status filter within the adapter's enumerated working set. Obsidian still
excludes archived supersession predecessors from both listings, even with this
option. The required historical access path is `get(id)` with reverse `supersedes`
links through `getLinks(id)`. **Known Obsidian retention gap:** archiving another record
with a reused category/title path can overwrite the earlier archive file;
`get(earlierId)` can then return the later record's id/body/history. Index entries and
links do not prove original-byte retention. See the
[archive collision disclosure](store-contract.md#known-obsidian-archive-retention-gap)
and [working-set contract](store-contract.md#b3-working-set-exclusion).

Both built-in similarity detectors unconditionally exclude retired candidates;
neither exposes an `includeRetired` override. They filter supplied candidates;
they do not fetch records excluded by a store listing.

Lifecycle status does not itself restrict `get(id)`; the Obsidian archive collision
gap above can nevertheless violate original-record retrieval. An unresolved handle
returns `null`, as described above.

### Using the retire flow

```js
import { KnowledgeFlowRunner } from './adapters/flow-runner/index.js';

const runner = new KnowledgeFlowRunner({ store, workspace });

// Retire a compiled decision record that was implemented
const result = await runner.retire(compiledId, {
  targetStatus: 'implemented',
  rationale: 'REST API shipped in v1.0 (PR #42).',
  implementedByRef: 'https://github.com/org/repo/pull/42',
  decision: 'apply',
});

// Retire an obsolete concept record
await runner.retire(conceptId, {
  targetStatus: 'retired',
  rationale: 'Superseded by new architecture decision in ADR-007.',
  decision: 'apply',
});

// Reject a retirement proposal (status unchanged)
await runner.retire(recordId, {
  targetStatus: 'retired',
  rationale: 'Proposing retirement.',
  decision: 'reject',
  rejectReason: 'Still needed for reference.',
});
```

### Accessing retired records with provenance

```js
// Read an existing retired record, including retirement evidence
const record = await store.get(retiredId);
console.log(record.status);           // "retired"
console.log(record.mutation_log);     // includes retire entry with rationale

// List compiled records in the adapter's working set, including retired ones.
// Archived Obsidian predecessors remain excluded; this is not a retired-only query.
const compiledWorkingSet = await store.listByType('compiled', { includeRetired: true });

// Get history from snapshot provenance
const snapshot = await store.get(snapshotId);
for (const srcId of snapshot.provenance.source_ids ?? []) {
  const src = await store.get(srcId);   // works even if src is retired
  console.log(src.id, src.status);
}
```

---

## Non-Goals (this iteration)

- Vector/semantic retrieval (parked as I10)
- Multi-user concurrency
- Store migrations
- Personal-KB import (parked as I11)

---

## Similarity Detectors

The `synthesize` and `consolidate` flows accept a pluggable `similarityDetector` option. A
detector has the signature:

```js
async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
```

It receives the target concept, all compiled candidates, and the store; it returns the IDs of
candidates that are similar enough to form a cluster. The `KnowledgeFlowRunner` uses the cluster
as its evidence base — an empty cluster throws `MISSING_EVIDENCE` at the detect-cluster gate.

`knowledge.consolidate` supplies only compiled records in the snapshot's exact
category to the detector. Parent and descendant categories are separate topics;
include one of their records only by naming it in the ordered
`sourceRecordIds` allowlist. Explicit sources are mutually exclusive with a
similarity detector and append mode, and every source must resolve to an active
compiled record.

### Choosing a detector

| Detector | Best for | Tradeoff |
|---|---|---|
| `defaultSimilarityDetector` (built-in) | Fast, zero-config. Works well when records share a structured category taxonomy and inter-record wikilinks. | Relies on category prefixes and link-overlap (Jaccard ≥ 0.10). Misses semantic similarity across category boundaries. |
| `createVectorSimilarityDetector` | Semantic clustering. Synthesis can find similar records across categories; consolidation applies it only inside the exact topic category. | Requires an embedding backend (ollama by default). Adds latency proportional to cluster size. |

### Vector detector — ollama embedding

The vector adapter lives at `adapters/similarity-vector/index.js`. It is zero-dependency and
calls ollama's `/api/embed` endpoint via the built-in `fetch`.

```js
import { createVectorSimilarityDetector } from './adapters/similarity-vector/index.js';

// Default: uses ollama at localhost:11434 with nomic-embed-text
const detector = createVectorSimilarityDetector();

// Or customise host, model, and threshold:
const detector = createVectorSimilarityDetector({
  host: 'http://localhost:11434',
  model: 'nomic-embed-text',
  threshold: 0.60,              // cosine similarity cutoff
});

// Pass to synthesize:
await runner.synthesize(conceptId, {
  proposedBody: '...',
  rationale: '...',
  similarityDetector: detector,
});
```

**Starting ollama:**

```bash
ollama serve &
ollama pull nomic-embed-text   # 274 MB, one-time pull
```

**Threshold guidance:**

The default threshold of `0.60` is validated against `nomic-embed-text` (768-dim). Empirical
scores observed in the eval suite:

| Pair | Score |
|---|---|
| Semantically similar API design texts | ~0.77 |
| Semantically unrelated (API vs. bread baking) | ~0.41 |

A threshold of `0.60` cleanly separates these two classes. If your domain records are more
homogeneous (narrow vocabulary, very similar boilerplate) you may need to raise the threshold
to `0.70–0.80` to avoid over-clustering.

### Fail-closed rationale

The bundled Ollama embedding function throws an `Error` with `code="EMBED_FAILURE"`
for network/HTTP failures, invalid JSON, a non-null decoded envelope missing an
embeddings array, or a wrong vector count. The detector also checks the outer array and count returned by an injected
embed function; errors from that function otherwise propagate as supplied.

**Current validation limits:** a valid JSON response of `null` is dereferenced before
its envelope is checked, raising a plain `TypeError` rather than `EMBED_FAILURE`.
Individual vectors are not validated for numeric contents,
non-empty shape, or matching dimensions. Correct-count responses such as
`{ embeddings: [null, null] }` can therefore score zero and return `[]` at the default
threshold, while nonnumeric contents can produce `NaN` and be excluded. These cases can
still surface as `MISSING_EVIDENCE` downstream rather than `EMBED_FAILURE`.

A detector that silently returns `[]` on infrastructure failure is indistinguishable from one
that found no similar records. The result is a misleading `MISSING_EVIDENCE` at the detect-cluster
gate, which looks like "this concept has no sources" rather than "the embedding service is down".

Failing closed is the intended boundary: recognized embedding failures should remain
distinguishable from an empty cluster. Operators can route `EMBED_FAILURE` separately
from `MISSING_EVIDENCE`, while accounting for the validation gaps above.

### Injecting a custom embed function

For tests or alternative providers (OpenAI, Cohere, etc.), pass `embed` directly:

```js
const detector = createVectorSimilarityDetector({
  embed: async (texts) => {
    // texts: string[] — one per record (title + "\n" + body by default)
    // must return: number[][] — one vector per input text
    const response = await myEmbeddingAPI.embed(texts);
    return response.vectors;
  },
  threshold: 0.70,
});
```

The `embed` function is called once per `synthesize`/`consolidate` call with all texts in a
single batch (concept first, then candidates).

---

## Graph provider (opt-in)

The built-in `MarkdownVaultProvider` exposes canonical records through the
generic graph contract. Node `attributes.record_provenance` retains creation
metadata. Edge `attributes.vault_link_kind` and optional `vault_link_label`
retain the source relationship and its display text. Top-level provenance
identifies the provider read; preserving a source claim does not verify it.

The `neo4j` provider is a real, queryable graph implementation of the store
provider read interface (issue #327). It is the **owner's opt-in personal
default** — the file providers (`markdown-vault`, `git-repo`, `work-item`) remain
the portfolio default. The graph is a **materialized view** synced from those
providers: the file stores stay the source of truth, and the write side stays
proposals-only. `neo4j-driver` is an optional dependency. At selection time,
`selectKnowledgeProvider` checks reachability and uses the supplied `fileProviders()`
factory when configuration, the driver, or connectivity is unavailable. Callers must
supply that factory (and a `neo4jFactory` for successful graph selection). This is
selection-time degradation, not automatic failover of later graph queries.

### 1. Start Neo4j (Docker)

```bash
docker run -d --name kg-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/testpassword neo4j:5-community
```

### 2. Point the provider at it (connection by reference — never hardcoded)

```bash
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=testpassword   # use your own secret; this is an example
export KNOWLEDGE_PROVIDER=neo4j      # opt in (repo/user-level); default is `file`
npm install neo4j-driver             # optional dependency, only if not already present
```

### 3. Sync the file stores into the graph (idempotent)

`sync` reads the other providers and MERGEs their combined graph into Neo4j. A
re-sync of unchanged stores reports **zero writes** (content-keyed hash guard);
a snapshot digest + timestamp is recorded on the graph.

```js
import { GitRepoProvider } from "./kits/knowledge/providers/git-repo/index.js";
import { WorkItemProvider, createGhRunner } from "./kits/knowledge/providers/work-item/index.js";
import { syncToNeo4j } from "./kits/knowledge/providers/neo4j/index.js";
import { resolveNeo4jConfig, createDriver } from "./kits/knowledge/providers/neo4j/index.js";

const driver = await createDriver(resolveNeo4jConfig());
const providers = [
  new GitRepoProvider({ repoRoot: process.cwd() }),
  // WorkItemProvider requires an injected runner (no default); createGhRunner()
  // shells out to `gh` for read-only issue listing.
  new WorkItemProvider({ repo: "kontourai/flow-agents", runner: createGhRunner() }),
];
console.log(await syncToNeo4j({ driver, providers })); // { writes, unchanged, digest, ... }
```

### 4. Query it — Neo4j Browser or the provider verbs

Open `http://localhost:7474` for the interactive Browser, or use the provider's
query/health verbs. With the real driver below, these use Cypher and propagate driver
errors; an outage does not switch a direct `Neo4jProvider` call to file providers.
The portable JS algorithms are selected for a driver without Cypher-analytics support,
but still read that driver's data. A driverless provider with an explicit `sourceGraph`
is a separate in-memory path, not outage failover. Supplying both a driver and
`sourceGraph` still uses the driver:

```js
import { Neo4jProvider } from "./kits/knowledge/providers/neo4j/index.js";
const kg = new Neo4jProvider({ driver });
await kg.transitiveBlockers("issue:313");     // Q1 transitive blocker closure
await kg.contradictionCandidates();           // Q2 divergent status over one subject
await kg.orphans();                           // Q3 node-type-aware orphans
await kg.duplicateCandidates();               // Q4 duplicate candidates WITH stemming
await kg.shortestPath("decision:adr-0011", "decision:adr-0021"); // Q5 shortest path
```

Example Cypher session in the Browser (the blocker subgraph the spike visualised):

```cypher
MATCH p=(a:Issue)-[:BLOCKS]->(b:Issue) RETURN p LIMIT 60;
```

### Running the full live integration locally

CI has no Neo4j, so the conformance + unit tests run against an injected fake
driver and the live integration test skips loudly. To run the live path:

```bash
docker run -d --name kg-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/testpassword neo4j:5-community
NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=testpassword \
  node --test kits/knowledge/providers/neo4j/integration.test.js
docker rm -f kg-neo4j
```

## Schema authority and vendoring

`schemas/knowledge/` is the canonical source for every Knowledge schema. The matching `schemas/knowledge/` directory inside this Kit is an exact install payload, not an independently maintained contract. Update both in the same change; `src/cli/kit-knowledge-vendoring-portability.test.mjs` enforces byte-for-byte parity before the Kit is installed.

## Flow CLI ingest pilot

The opt-in `knowledge.ingest-flow-pilot` adapter (`ingest/index.js`) runs only
`knowledge.ingest` through the public Flow CLI. The existing
`KnowledgeFlowRunner` remains available, including compile, promote and other
flows. This pilot does not replace those flows or the live harness integrations.

Install the public `@kontourai/flow` CLI and `@kontourai/surface` in the consuming
Node project. The opt-in pilot also requires POSIX Python 3 whose standard
library supports descriptor-relative `os.open`, `os.stat` and `os.unlink`, plus
`O_NOFOLLOW`. The publisher checks this prerequisite before creating pilot
artifacts; the CLI checks it before constructing its store. Unsupported
platforms or a missing interpreter refuse, with the legacy runner still
available. This distribution qualifies Flow 5.2.0 and Surface 6.3.0. The kit
invokes Flow as a subprocess and passes recorded artifacts; it imports no Flow
engine library. A `KnowledgeIngestFlow` instance accepts a store, workspace,
unique run id and optionally a `flowCommand` argument array for a particular
installed CLI, and `pythonCommand` for a particular Python 3 interpreter.

For the command line, create a JSON input with `rawText` and optional `meta`
(`category`, `title`, `tags`, `agent`, `session_id`, `note`, `routing`):

```bash
node /path/to/knowledge/ingest/cli.js \
  --input capture.json --workspace /path/to/workspace \
  --store-root /path/to/store --run-id ingest-001 \
  --flow-bin /path/to/node_modules/.bin/flow --python-bin /path/to/python3
```

The driver initializes a fresh Flow workspace with `flow init`, runs `flow start`,
then attaches and evaluates each gate
with `flow evaluate --exit-code`. Evaluation advances the canonical run; Flow
has no separate `advance` CLI command. A missing capture-gate artifact returns a
nonzero exit and leaves the run at capture, before any store creation. Blank
source likewise produces no capture claim. Classification preserves the old
runner's category/title heuristics and raw record provenance. Routing defaults
to `queue-for-compile`, or records the operator's non-empty `meta.routing`.
Routing records a decision; it does not execute compilation or delete a record.
An initialized workspace keeps its Flow config, README and sample definition;
the driver never re-runs init there. A partial layout with authored init targets
is refused before pilot artifacts are written. Classification readback must
match the canonical id returned by create as well as content and provenance.

The driver writes operation observations and Surface bundles under
`<workspace>/.kontourai/knowledge/ingest/<run-id>/`. `trace.jsonl` retains each
Flow command's arguments, exit code, stdout and stderr. The kit refuses symlink components and binds both workspace and artifact
root identities. One shared publisher receives a held directory descriptor
through child stdio and invokes fixed Python code with data-only arguments and
stdin. JSON and trace writes open children relative to that descriptor, with
no-follow/exclusive creation or no-follow append. Operation evidence uses the
actual persisted readback digest; intended in-memory text alone cannot qualify
a missing file. Root custody is checked before each command and write. The
public `start`/`evaluate` diagnostic path retains its descriptors until callers
invoke `close()`; the one-shot `capture` path closes them on success or failure. Flow owns its run, artifact copies, integrity checks,
gate evaluations and cursor. Claim status is
`verified` for these local operations: non-empty input capture, stored raw
classification readback, and a recorded routing decision. This does **not**
verify the truth of the source text, constitute independent review, or establish
host/provider acceptance. Ingest definition version 1.1 uses Surface's current
`verified` operation status instead of legacy `trusted`/`accepted` report labels.

This is a one-shot pilot. A failed run retains its artifacts for inspection, and
reusing its id is refused. If failure occurs after raw creation, the raw record
remains; a rerun with a new id can create another capture. There is no automatic
retry, rollback or resumption. Use a fresh workspace for experiments and inspect
both the kit trace and `flow status <run-id> --format json --cwd <workspace>`.

## Residue sources (runtime-session ingest)

`promote/ingest.js` turns a session into **residue**: candidate input for later
distillation. Residue is not evidence, policy or instruction authority, even
after it is distilled. Both variants are defined by
[`schemas/knowledge/residue.schema.json`](../../../schemas/knowledge/residue.schema.json).
`ingestFromSource(source, input)` selects one of two sources:

| Source | Input | Output |
|---|---|---|
| `workflow-sidecar` | A completed `.kontourai/flow-agents/<slug>/` session directory. | `{ residues: [ingestSession(dir)] }`. The residue is the existing `ingestSession` output, unchanged. |
| `runtime-session` | `{ telemetryFile, transcriptRoots, cursor?, idleGapMs?, now? }` | `{ residues, report, candidateCursor }`, with one residue per new or changed sitting. |

The `runtime-session` source reads canonical telemetry (schema `0.3.0`) after the
cursor. It needs the full channel, because the analytics channel redacts
`hook.transcript_path`. For each `claude-code` or `codex` event it reads the
referenced Claude Code project JSONL or Codex rollout. Then it:

- keeps only user and assistant **text**. It drops tool calls and results,
  thinking and reasoning, images, sidechains and subagent rollouts, meta and
  compact-summary entries, and harness-originated entries such as task
  notifications. It also drops harness tags, such as `<system-reminder>` and
  `<environment_context>`, Codex developer instructions, and any block wrapped in the injected-memory marker
  (`INJECTED_MEMORY_OPEN`/`INJECTED_MEMORY_CLOSE`,
  `<flow-agents-injected-memory>`). Injection (#672) must use that marker, so
  memory it injects can never be re-ingested as conversation;
- splits the conversation into **sittings** at an idle gap (default 30
  minutes). Each sitting has the stable id `<harness>:<sessionId>:<n>`, a
  `contentHash`, and a `complete` flag (the idle gap has elapsed since its last
  turn). Its provenance records the harness, session id, transcript path
  relative to its authorized root, cwd, git branch, and start and end times;
- scrubs the text, cwd, branch and transcript ref deterministically (`scrubResidueText`). Provider
  tokens, JWTs, private keys, URL credentials and secret-named assignments
  become `<SECRET>`, emails become `<EMAIL>`, and home directories become `~`.
  No model is involved, so transcript text cannot argue its way past the scrub. Every scrub stage reads the original text and reports edits,
  and one step applies their union, so no stage can rewrite the syntax another
  one needs; the result is then scrubbed again until it stops changing. The
  scrub fails toward over-redaction and is linear in the input: a quoted secret value is extended over any further secret-named keys
  inside it, an unmatched quote redacts to the end of its line, and a
  non-whitespace run longer than 200 characters (base64, minified code) is
  replaced whole with `<BLOB>`. Secret-named keys are
  recognised by splitting an identifier into words (snake, kebab and camelCase,
  `--flag` prefixes, trailing digits, dotted paths for YAML block scalars); a
  key the word list does not contain (`db_pass`, `pass`) is not redacted, and
  neither is an unquoted value of fewer than four characters or a bare
  `--password value` with a space.

Ownership boundaries:

- The **host** supplies the telemetry file and the authorized transcript roots;
  ingest discovers nothing by itself. A transcript outside every root is skipped
  and reported.
- **Ingest writes nothing.** It returns `candidateCursor`. The transaction owner
  (the dream job, #671) commits it with `commitRuntimeCursor` (an atomic
  rename), and only after its own work with the residue succeeds.
  `readRuntimeCursor` treats a missing file as an empty cursor.
- The cursor stores a telemetry byte offset, a digest of the bytes before it,
  and the content hash of every sitting already returned. The offset never
  passes a line whose content was not fully read: a malformed or
  unknown-version telemetry line, or a transcript that is drifted, unreadable or
  over its size limit. Later lines are still processed, and their sitting hashes
  stop a re-run from returning them twice. A trailing partial line in the
  telemetry file is left for the next run. A transcript that ends in an
  unfinished line, grows or is replaced while it is read, or is swapped for a
  symlink after the root check (`TRANSCRIPT_PARTIAL_TAIL`,
  `TRANSCRIPT_CHANGED_DURING_READ`) holds the cursor; its complete lines are
  still returned. A final record that is already whole JSON counts as complete
  without its newline. A transcript that is missing holds the cursor
  (`TRANSCRIPT_MISSING_RECENT`) while its telemetry event is younger than
  `missingTranscriptGraceMs` (default 1 hour), and is skipped
  (`TRANSCRIPT_MISSING`) after that, because retention cleanup deletes old
  transcripts for good. A missing transcript whose event has no usable
  timestamp (it must be epoch milliseconds, as telemetry writes it, and not more
  than five minutes ahead of the clock) holds the cursor as
  `TELEMETRY_BAD_TIMESTAMP`. Content appended after a read is newer than the
  telemetry event being served; the next event for that transcript re-reads it. The transcript is opened without following a final symlink,
  read through that one descriptor, and its path and inode are re-checked after
  the read. A truncated, rotated or rewritten telemetry
  file makes the prefix digest mismatch, so the run blocks and the cursor stays
  where it was.
- **Ferry parses; Knowledge filters.** Transcripts are read by
  [`@kontourai/ferry`](https://github.com/kontourai/thread)'s Claude Code and
  Codex importers into canonical [`@kontourai/thread`](https://github.com/kontourai/thread)
  messages. Sitting splitting, tag and marker filtering, and the scrub work over
  those messages; the kit has no transcript parser of its own. Ferry already
  drops tool results, thinking, `isMeta` entries and Claude sidechains.
  Drift means Ferry reports skipping a record, the file reads as a different
  format from the one its telemetry runtime names (Ferry's `detectFormat`), the
  complete lines are not valid UTF-8, the session id is not a UUID (so free text
  and secrets never reach sitting ids or cursor keys), a conversation record has
  no source timestamp (Ferry would substitute the clock, making hashes
  nondeterministic; only records Ferry imports are checked, and lines the kit
  excludes are never inspected), a record carries a user or assistant role but
  has a type the kit does not recognise (`api-request-blob` is the one known
  non-conversation type), a Claude transcript has no `sessionId`, or a Codex
  rollout does not open with a `session_meta`. Drift is reported as `UNKNOWN_TRANSCRIPT_FORMAT`, holds the
  cursor, and never crashes the run.
- **Temporary shims** (`promote/runtime-ferry-shims.js`) cover what the Thread
  does not carry yet, each tied to an upstream issue and to be deleted when it
  ships. Each reads one record-level fact from one raw line, and the flagged
  *line* is removed before Ferry imports the rest, so there is no join on ids,
  text or time: Claude `origin.kind` other than `human`, compact summaries and
  transcript-only entries ([thread#76](https://github.com/kontourai/thread/issues/76));
  Codex `session_meta` branch and the subagent marker
  ([thread#77](https://github.com/kontourai/thread/issues/77)); Codex
  `developer`-role items that Ferry imports as `user` messages, and the
  harness-tag list ([thread#78](https://github.com/kontourai/thread/issues/78));
  and the check that a record carries a source time
  ([thread#79](https://github.com/kontourai/thread/issues/79)).
  Provenance cwd and branch are session-level (Ferry's Thread metadata), not
  tracked per sitting.

Out of scope here: store writes (#670), scheduling or dreaming (#671),
injection (#672), OpenCode and pi transcripts, and telemetry schema changes.
Known gaps: a URL password is hidden up to the first "@" (as before), so the tail of
a password that holds an unencoded "@" (`user:p@ss@host`) stays visible; a quoted password inside a URL inside another assignment, followed
by a glued run that holds a further key, may leave that last value (earlier
scrub designs hid it only as a side effect of their stage order); the cursor does not drain a rotated telemetry predecessor (a
rotation blocks until an operator resets the cursor); the map of sitting
hashes is never pruned; the injected-memory filter fails closed, so an
unterminated opening marker hides the rest of that message (reported as the
note `INJECTED_MEMORY_UNTERMINATED`), a close with no open removes the text
before it, and a marker spelled across two text parts is not recognised; Node
has no `openat2(RESOLVE_BENEATH)`, so a parent directory swapped by someone who
can already write inside an authorized root is not defeated (the final
component is opened without following symlinks and its path and inode are
re-checked); a new Claude record type that carries a message role reads as
drift and holds the cursor until it is added to the known list; two
transcript files that carry the same session id share sitting ids; a transcript whose conversation records were renamed
wholesale (so Ferry sees no conversation and warns about nothing) is
indistinguishable from a bookkeeping-only file, so it is skipped and reported
as `NO_CONVERSATION` rather than blocked as drift.

## Reviewed learning lifecycle

[The versioned lifecycle API](learning-lifecycle.md) separates learning proposals,
review, activation for context consumers, observed effects and retirement from
ordinary Knowledge record storage status. It is exposed through the declared
`knowledge.learning-lifecycle` adapter and public package exports.

### Memory create proposals (Corpus #40)

The explicit `runPromote({ target: "store", ... })` path accepts a complete
schema-valid `runtime-session` residue from #669 and already-distilled candidates with
`title`, `body`, and `category`. The host supplies its authorized absolute
`root`, a `registerRoot(name, root)` function, and a Corpus store constructed
for that same root with host-owned locking and coordination. The host supplies
the root name explicitly. This path does not discover or authorize paths or
edit an MCP registry itself. The host's registration implementation determines whether its
MCP server lists the root. The host must refuse registration when an existing name points to a different
root; re-registering the same name and root is allowed. The reference host
registry currently replaces the existing root silently, so it does not satisfy
this requirement. The host protocol is tracked in
[#753](https://github.com/kontourai/flow-agents/issues/753).

Each candidate is sent through `proposeCreate(candidate, proposerId, evidence,
{ requestKey })`. The opaque key hashes the sitting ID and candidate position;
it contains no source text. Replaying the same ordered batch returns the
original proposal IDs while the key remains active. Corpus refuses a replay if
the key was retired after a purge or scrub. Changed content or provenance at an
occupied position is refused as `REQUEST_KEY_CONFLICT`. The proposer identity
is part of the stored request, so changing it at the same sitting and position
also conflicts rather than creating another proposal. A changed sitting must be
reconciled by the host; this bridge does not replace earlier proposals.

The candidate provenance note encodes the session ID, transcript reference,
sitting ID and producer-supplied content hash pending the structured provenance
contract in [Corpus #46](https://github.com/kontourai/corpus/issues/46). The
bridge validates the hash shape but does not recompute it from turns. This is a
proposal request, not an approval or an applied record; the Corpus #40 contract
owns persistence, review, and exclusion from ordinary reads. Reviewers use
Corpus `applyCreate` or `rejectCreate`; this bridge invokes neither operation.
Extraction and scheduling are not provided here. Retry only the same ordered
batch and provenance after an uncertain response. The store deduplicates
individual proposals; a shorter batch does not remove or reconcile previously
staged proposals. The adapter/root binding is a host obligation pending
[Corpus #47](https://github.com/kontourai/corpus/issues/47); the registry
protocol remains subject to [#753](https://github.com/kontourai/flow-agents/issues/753).

An error from `proposeCreate` carries already returned proposal IDs, the failed
candidate index and its opaque request key for reconciliation. A request-key
conflict and Corpus `MISSING_EVIDENCE` are surfaced as definite refusals for the
failed candidate. Other failures are conservatively reported as indeterminate,
including coded errors not explicitly recognized here; inspect the cause and
reconcile or retry only the identical batch. `MISSING_EVIDENCE` can be returned
before key lookup, so it does not establish whether the position was previously
occupied. A `REQUEST_KEY_CONFLICT` can mean different input or a retired key
after a purge or scrub.

Returned `posture: "proposed"` names the submitted intent. The accompanying
`review_state: "not_observed"` is not evidence of the current proposal state.
Query Corpus before treating a replayed receipt as pending, applied or rejected.
`write: false` returns `preview` without registering or writing; an empty
candidate list returns `noop`. The create-proposal API is an upstream dependency.

The Corpus integration tests use the exact published `@kontourai/corpus-store`
version declared by this package. Set `KNOWLEDGE_HOST_ROOT` to a checkout of
the host to also exercise its registry and MCP server in an isolated temporary
XDG home; that host-dependent test is skipped when the path is unavailable.
Candidate fields are limited to `title`, `body`, and `category`; `write` must
be a boolean.
