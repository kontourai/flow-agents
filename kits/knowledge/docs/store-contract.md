---
title: Knowledge Kit Store Contract
version: "1.0"
---

# Knowledge Kit Store Contract

This document defines the storage contract for the Knowledge Kit. Any store adapter that
implements this contract can be substituted for the default adapter without changing kit flows.
The contract is self-contained: a second adapter author should be able to read this document
alone and produce a conforming implementation.

---

## 1. Record Types

The store holds three record types. Every record, regardless of type, shares a common envelope.

### 1.1 Common Record Envelope

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable, opaque identifier. Must be unique within the store. Adapter may generate (e.g. UUID or slug). |
| `type` | `"raw"` \| `"compiled"` \| `"concept"` | yes | Discriminates the record type. |
| `title` | string | yes | Human-readable title. |
| `body` | string | yes | Primary content. Format is type-specific (see below). |
| `category` | string | yes | Dot-separated hierarchical category string, e.g. `"engineering.api"`. Must be non-empty. |
| `tags` | string[] | no | Flat list of tag strings for secondary classification. |
| `aliases` | string[] | no | Human-readable, category-scoped slug aliases resolvable via `get`/`getLinks` (Addendum H). Append-only; never changes `id`. |
| `links` | Link[] | no | Outbound links from this record (see §2). |
| `provenance` | Provenance | yes | Immutable creation provenance (see §4). |
| `created_at` | ISO-8601 string | yes | Creation timestamp in UTC. |
| `updated_at` | ISO-8601 string | yes | Last mutation timestamp in UTC. |

### 1.2 `raw` Record

A raw record holds unprocessed source material exactly as received — a document excerpt,
a transcript snippet, a URL with notes, or any other unrefined input.

- `body`: free-form string, preserved verbatim.
- No semantic constraints on content.
- Intended as the input stage before compilation.

### 1.3 `compiled` Record

A compiled record is a normalized, editor-reviewed distillation of one or more raw records.

- `body`: structured markdown, expected to be human-readable reference prose.
- Must link (via `links`) to at least one `raw` record as its source, using link kind `"source"`.
- The `source_ids` provenance field (see §4) records which raw record(s) were compiled.

### 1.4 `concept` Record

A concept record defines a named idea, term, or principle that other records can reference.

- `body`: definition or explanation string.
- May link to `compiled` records via link kind `"example"` or `"related"`.
- Concept ids are used as the `target_id` in wikilink-style link syntax.

---

## 2. Links

Links express directed relationships between records. A link is stored as part of the source
record's `links` array. The graph index (see §5) mirrors all links for efficient traversal.

### 2.1 Link Object

| Field | Type | Required | Description |
|---|---|---|---|
| `target_id` | string | yes | `id` of the target record in this store. |
| `kind` | string | yes | Relationship kind (see §2.2). |
| `label` | string | no | Human display label for the link. |

### 2.2 Link Kinds

| Kind | Direction | Meaning |
|---|---|---|
| `"source"` | compiled → raw | Compiled record was derived from this raw record. |
| `"example"` | concept → compiled | This compiled record exemplifies the concept. |
| `"related"` | any → any | General semantic relation. |
| `"refines"` | compiled → compiled | Later record refines or supersedes an earlier one. |
| `"proposes"` | any → concept | Record proposes a change to the concept (used with `propose` mutation). |

Adapters MUST store and return link objects with at least `target_id` and `kind`. Unknown
kinds MUST NOT be rejected — forward compatibility requires tolerating new kinds.

### 2.3 Wikilink Syntax

In `body` text, outbound links may also appear as `[[target_id]]` or `[[target_id|label]]`.
The default adapter indexes these inline wikilinks into the `links` array on write and renders
them back on read. The contract requires that after a round-trip, links declared in the `links`
array are queryable via `getLinks(id)`. Inline wikilink parsing is an adapter implementation
detail; the contract does not mandate a body format.

---

## 3. Categories

Categories provide hierarchical classification. Rules:

- A category is a dot-separated string of one or more non-empty segments, e.g. `"engineering"`,
  `"engineering.api"`, `"engineering.api.rest"`.
- Segments must match `[a-z0-9_-]+` (lowercase alphanumeric, hyphens, underscores).
- The store MUST support querying records by exact category or by prefix (all descendants).
- Empty string is not a valid category. The adapter MUST reject records with an empty category.

---

## 4. Provenance

Every record carries immutable creation provenance. Mutation operations supply evidence that
is appended to a mutable `mutation_log`. Adapters MUST enforce required provenance fields and
MUST reject mutations missing them (see §6).

### 4.1 Creation Provenance Object (`provenance`)

| Field | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | IDs of records this record was derived from (for compiled records). |
| `agent` | string | yes | Identifier of the agent or process that created this record. |
| `session_id` | string | no | Identifier of the session in which the record was created. |
| `note` | string | no | Free-form provenance note. |

### 4.2 Mutation Log Entry

Each mutation appends one log entry. Log entries are append-only; adapters MUST NOT
overwrite or delete log entries.

| Field | Type | Required | Description |
|---|---|---|---|
| `op` | string | yes | Operation name (one of the mutation ops in §6). |
| `at` | ISO-8601 string | yes | Timestamp of the mutation. |
| `agent` | string | yes | Agent that performed the mutation. |
| `note` | string | no | Reason or human note for the mutation. |
| `evidence` | object | no | Op-specific evidence (see §6 per-op tables). |

---

## 5. Graph Index

The store maintains a JSON graph index file (or equivalent in-memory structure) that mirrors
all link relationships for O(1) lookup by source or target. The index enables:

- Forward lookup: given a record id, return all outbound links.
- Reverse lookup: given a record id, return all inbound links (backlinks).

The index MUST be updated atomically with every mutation that changes links. After any
mutation, a `getLinks(id)` call MUST reflect the current link state.

The default adapter stores the index as `graph-index.json` at the store root.

### 5.1 Graph Index Schema

```json
{
  "schema_version": "1.0",
  "forward": {
    "<source_id>": [
      { "target_id": "<id>", "kind": "<kind>", "label": "<optional>" }
    ]
  },
  "reverse": {
    "<target_id>": [
      { "source_id": "<id>", "kind": "<kind>" }
    ]
  }
}
```

### 5.2 Reindex (recovery)

The graph index is a **derived cache**: each record's own `links` array is the source of truth.
An adapter MAY expose a `reindex()` recovery operation that rebuilds the index from scratch by
scanning every record's `links` — the supported way to recover from a lost, hand-edited, or
drifted `graph-index.json`.

| Operation | Signature | Behavior |
| --- | --- | --- |
| `reindex` | `() => { records, links, forwardSources, reverseTargets, changed }` | Rebuild the index authoritatively from records' `links`. Deterministic (records processed in id order). `changed` is true when the rebuilt index differs from the one on disk (compared order-independently), so callers can detect drift. Does **not** mutate records or append to the mutation log — it only repairs the derived cache. |

`reindex()` is optional in the contract (not every adapter maintains a separate index), but any
adapter that persists a derived index SHOULD provide it as the recovery path.

---

## 6. Mutation Operations

The store exposes six mutation operations. Each operation specifies:

- **Required provenance/evidence fields** that the caller MUST supply.
- The adapter MUST reject the call with an error if any required field is missing.
- Optional fields that the adapter records when present.

### 6.1 `create`

Create a new record. The adapter assigns `id`, `created_at`, and `updated_at`.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `type` | top-level | Record type: `"raw"`, `"compiled"`, or `"concept"`. |
| `title` | top-level | Non-empty title string. |
| `body` | top-level | Non-empty body string. |
| `category` | top-level | Non-empty dot-separated category. |
| `provenance.agent` | provenance | Agent identifier. |

**Optional fields:** `tags`, `links`, `provenance.source_ids`, `provenance.session_id`, `provenance.note`.

**Rejection conditions:**
- Missing or empty `type`, `title`, `body`, `category`.
- `type` not one of `"raw"`, `"compiled"`, `"concept"`.
- Empty `category` or category with invalid segments.
- Missing `provenance.agent`.

**Post-conditions:** Record is retrievable by `get(id)`. Links in `links` array are indexed.

### 6.2 `update`

Update mutable fields of an existing record. Immutable fields (`id`, `type`, `created_at`,
`provenance`) MUST NOT change.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `id` | argument | ID of the record to update. |
| `agent` | evidence | Agent performing the update. |

**Optional update fields (at least one must be supplied):** `title`, `body`, `category`, `tags`, `links`.

**Rejection conditions:**
- Record with `id` does not exist.
- No mutable fields supplied (no-op updates are rejected).
- Missing `agent` in evidence.

**Post-conditions:** `updated_at` is refreshed. Mutation log entry appended. If `links`
changed, graph index is updated.

### 6.3 `link`

Add one or more directed links from a source record to target records. Idempotent: adding
an already-existing (source, target, kind) triple is not an error; the link is not duplicated.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `source_id` | argument | ID of the source record. |
| `links` | argument | Non-empty array of Link objects with `target_id` and `kind`. |
| `agent` | evidence | Agent performing the link operation. |

**Rejection conditions:**
- `source_id` does not exist.
- Any `target_id` in `links` does not exist.
- `links` array is empty.
- Missing `agent` in evidence.

**Post-conditions:** Each new link is present in `getLinks(source_id)`. Graph index updated.
Mutation log entry appended to source record.

### 6.4 `propose`

Record a proposed change to a concept record. The proposal does not modify the concept;
it creates a link of kind `"proposes"` from the proposing record to the concept, and
appends a mutation log entry with the proposal text.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the concept record to propose a change to. |
| `proposer_id` | argument | ID of the record making the proposal. |
| `proposal` | evidence | Non-empty string describing the proposed change. |
| `agent` | evidence | Agent submitting the proposal. |

**Rejection conditions:**
- `concept_id` does not exist or is not of type `"concept"`.
- `proposer_id` does not exist.
- `proposal` string is empty or missing.
- Missing `agent` in evidence.

**Post-conditions:** A link of kind `"proposes"` from `proposer_id` to `concept_id` is recorded
in both the record and the graph index. Mutation log entry appended to concept record.

### 6.5 `apply`

Apply a pending proposal: update the concept body with the proposed change and mark the
proposal as applied.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the concept being updated. |
| `proposer_id` | argument | ID of the record whose proposal is being applied. |
| `new_body` | evidence | The replacement body text for the concept. |
| `agent` | evidence | Agent applying the proposal. |
| `rationale` | evidence | Non-empty string explaining why the proposal is accepted. |

**Rejection conditions:**
- `concept_id` does not exist or is not of type `"concept"`.
- `proposer_id` does not exist.
- No `"proposes"` link from `proposer_id` to `concept_id` exists.
- `new_body` is missing or empty.
- `rationale` is missing or empty.
- Missing `agent` in evidence.

**Post-conditions:** Concept `body` is replaced with `new_body`. `updated_at` refreshed.
Mutation log entry (op=`"apply"`) appended. The `"proposes"` link MAY remain in the
graph (it is a historical record); adapters SHOULD NOT silently delete it.

### 6.6 `reject`

Reject a pending proposal: record that the proposal was reviewed and declined.
The concept is not modified.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the concept. |
| `proposer_id` | argument | ID of the proposing record. |
| `agent` | evidence | Agent rejecting the proposal. |
| `reason` | evidence | Non-empty string explaining the rejection. |

**Rejection conditions:**
- `concept_id` does not exist or is not of type `"concept"`.
- `proposer_id` does not exist.
- No `"proposes"` link from `proposer_id` to `concept_id` exists.
- `reason` is missing or empty.
- Missing `agent` in evidence.

**Post-conditions:** Concept `body` is unchanged. `updated_at` is NOT changed (concept
itself was not mutated). Mutation log entry (op=`"reject"`) appended to concept record.

---

## 7. Query Interface

The adapter MUST implement:

| Method | Signature | Description |
|---|---|---|
| `get` | `(idOrHandle: string) => Record \| null` | Retrieve a record. `idOrHandle` may be a full id, a slug alias, or an unambiguous id prefix (Addendum H). Returns null if it resolves to nothing; throws `AMBIGUOUS_ID` on an ambiguous prefix. |
| `getLinks` | `(idOrHandle: string) => { forward: Link[], reverse: Link[] }` | Return all links for a record from the graph index. Accepts the same handle forms as `get`; an unresolved handle yields empty arrays, an ambiguous prefix throws `AMBIGUOUS_ID`. |
| `listByCategory` | `(category: string, options?: { prefix?: boolean }) => Record[]` | List records by exact category match. If `prefix` is true, match all records whose category starts with the given string. |
| `listByType` | `(type: RecordType) => Record[]` | List all records of a given type. |

> **Identity resolution** (`get`/`getLinks`) is specified in full in **Addendum H**. The `prefix`
> option on `listByCategory` is unrelated — it filters by *category* prefix, not by id.

---

## 8. Adapter Contract Summary

An adapter is a JavaScript module (ESM) exporting a default class or factory function. The
constructor / factory accepts `{ storeRoot: string }`. The instance exposes:

```ts
interface KnowledgeStoreAdapter {
  create(record: CreateInput): Promise<string>;        // returns new id
  update(id: string, fields: UpdateFields, evidence: UpdateEvidence): Promise<void>;
  link(sourceId: string, links: Link[], evidence: LinkEvidence): Promise<void>;
  propose(conceptId: string, proposerId: string, evidence: ProposeEvidence): Promise<void>;
  apply(conceptId: string, proposerId: string, evidence: ApplyEvidence): Promise<void>;
  reject(conceptId: string, proposerId: string, evidence: RejectEvidence): Promise<void>;
  get(id: string): Promise<Record | null>;
  getLinks(id: string): Promise<{ forward: Link[]; reverse: Link[] }>;
  listByCategory(category: string, options?: { prefix?: boolean }): Promise<Record[]>;
  listByType(type: "raw" | "compiled" | "concept"): Promise<Record[]>;
}
```

All mutation methods MUST throw (or return a rejected Promise) when required evidence is
missing. The thrown error MUST have a `code` property set to `"MISSING_EVIDENCE"` and a
human-readable `message`. This enables the contract suite to distinguish enforcement failures
from unexpected errors.

### 8.1 Error Codes

| `code` | Raised by | Meaning |
|---|---|---|
| `MISSING_EVIDENCE` | any mutation op; `create`/`update` when an `aliases` entry is malformed | A required evidence/provenance field is missing, or supplied input is invalid. |
| `NOT_FOUND` | `link` (unknown `target_id`) and other ops that require an existing target | A referenced record id does not exist. |
| `AMBIGUOUS_ID` | `get`, `getLinks` | An id prefix matched more than one record (Addendum H). The error carries a `matches` array of the colliding ids. MUST NOT be swallowed into a `null` return. |
| `SLUG_CONFLICT` | `create`, `update` | A supplied slug alias is already assigned to a *different* record. |

---

## 9. YAML Frontmatter Convention (Default Adapter)

The default adapter serializes each record as a markdown file with YAML frontmatter:

```markdown
---
id: <id>
type: <raw|compiled|concept>
title: <title>
category: <category>
tags: [<tag>, ...]
aliases: [<slug>, ...]        # optional — human-readable, category-scoped (Addendum H)
created_at: <ISO-8601>
updated_at: <ISO-8601>
provenance:
  agent: <agent>
  session_id: <optional>
  source_ids: [<id>, ...]
  note: <optional>
links:
  - target_id: <id>
    kind: <kind>
    label: <optional>
mutation_log:
  - op: <op>
    at: <ISO-8601>
    agent: <agent>
    note: <optional>
    evidence: {}
---

<body text, may include [[wikilinks]]>
```

Files are stored as `<store_root>/records/<id>.md` — keyed by the full `id`, unchanged by this
addendum. The graph index lives at `<store_root>/graph-index.json`; the slug alias map (Addendum H)
lives at `<store_root>/alias-index.json`.

---

## Addendum A — Snapshot Record Semantics (S6)

### A.1 Snapshot Type Decision

A `snapshot` is a **distinct record type** (not a concept subtype). Rationale: snapshots have
unique semantics that differ from concept records in three ways:

1. **Topic binding** — a snapshot is always bound to a topic (category or explicit topic string),
   whereas a concept is an independent named idea.
2. **Supersedes relationship** — snapshots participate in a directed supersedes chain; concepts do
   not. A snapshot "supersedes" its predecessors, preserving them for provenance while establishing
   the current view.
3. **Consolidation lifecycle** — snapshots are produced by the `knowledge.consolidate` flow and
   carry evidence of which compiled records contributed to the latest decisions. Concepts carry
   definitions; snapshots carry bounded decision summaries.

Adding `snapshot` as a fourth top-level type is the smallest, clearest extension: it extends the
`type` discriminant, adds one link kind, and adds one mutation op — all self-contained.

### A.2 Extended Type Discriminant

The `type` field on the common envelope (§1.1) now accepts four values:

| Type | Description |
|---|---|
| `"raw"` | Unprocessed source material (§1.2). |
| `"compiled"` | Normalized, editor-reviewed distillation (§1.3). |
| `"concept"` | Named idea, term, or principle (§1.4). |
| `"snapshot"` | Bounded decision summary for a topic (§A.3). |

### A.3 `snapshot` Record

A snapshot record holds the current consolidated decisions for a topic. It is produced and
updated only through the `knowledge.consolidate` flow.

- `body`: structured markdown summarising the latest known decisions, open items, and context for
  the topic.
- `topic` (in `provenance.note` or a dedicated field — default adapter stores it in `tags[0]`
  prefixed `topic:`) — the topic string this snapshot covers. Must be non-empty.
- Must link (via `links`) to the compiled records that contributed to the latest consolidation
  using link kind `"source"`.
- May link to superseded predecessor snapshots using link kind `"supersedes"`.
- Carries `provenance.source_ids` referencing every compiled record that contributed to the
  current body.

### A.4 Extended Link Kinds

| Kind | Direction | Meaning |
|---|---|---|
| `"source"` | compiled → raw | (existing) |
| `"example"` | concept → compiled | (existing) |
| `"related"` | any → any | (existing) |
| `"refines"` | compiled → compiled | (existing) |
| `"proposes"` | any → concept | (existing) |
| `"supersedes"` | snapshot → snapshot | New snapshot supersedes an older snapshot for the same topic. |

### A.5 `supersede` Mutation Operation

The `supersede` op marks one or more existing records as superseded by a newer record.
It NEVER deletes records. Superseded records remain fully queryable with their provenance intact.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `new_id` | argument | ID of the record that supersedes. |
| `superseded_ids` | argument | Non-empty array of IDs that are being superseded. |
| `agent` | evidence | Agent performing the supersede operation. |
| `rationale` | evidence | Non-empty string explaining why the new record supersedes the old ones. |

**Rejection conditions:**
- `new_id` does not exist.
- `superseded_ids` is empty.
- Any id in `superseded_ids` does not exist.
- Missing `agent` in evidence.
- Missing or empty `rationale` in evidence.

**Post-conditions:**
- For each id in `superseded_ids`, a link of kind `"supersedes"` from `new_id` to that id is added
  to the graph index.
- A mutation log entry (op=`"supersede"`) is appended to the record at `new_id`.
- A mutation log entry (op=`"superseded-by"`) is appended to each record in `superseded_ids`,
  recording which record supersedes them (`new_id`).
- The superseded records are NOT deleted. Their `body`, `links`, and provenance remain intact.
- After `supersede`, a `get(superseded_id)` MUST still return the full record.
- Superseded records can be discovered via `getLinks(superseded_id).reverse` — they will have a
  reverse link of kind `"supersedes"` pointing from `new_id`.

**Supersede-not-delete invariant:**
> Calling `supersede` MUST NOT remove any record. No mutation op in this contract deletes records.
> This is a hard invariant; adapters MUST enforce it. A retention policy hook for physical archival
> is a future concern and is explicitly out of scope for this version.

### A.6 Adapter Contract Extension

The adapter interface (§8) is extended with one method:

```ts
interface KnowledgeStoreAdapter {
  // ... existing methods ...
  supersede(newId: string, supersededIds: string[], evidence: SupersedeEvidence): Promise<void>;
  listByType(type: "raw" | "compiled" | "concept" | "snapshot"): Promise<Record[]>;
}
```

`SupersedeEvidence`:
```ts
interface SupersedeEvidence {
  agent: string;
  rationale: string;
  note?: string;
}
```

### A.7 Snapshot Queryability Guarantee

Superseded snapshots MUST remain queryable:
- `get(id)` returns the full record (body, links, provenance, mutation_log).
- `listByType("snapshot")` returns ALL snapshots, including superseded ones.
- The caller can determine supersession status by inspecting `getLinks(id).reverse` for entries
  with `kind === "supersedes"`.

There is no `"archived"` or `"deleted"` status field; the supersession chain is expressed entirely
through links and mutation log entries.

---

## Addendum B — Record Status Lifecycle (S7)

### B.1 Status Field

Every record envelope (§1.1) gains an optional `status` field:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | `"active"` \| `"implemented"` \| `"retired"` | no | `"active"` | Lifecycle status of the record. Records without a status field are treated as `"active"`. |

`status` is a mutable field but MUST only change via the `retire` mutation op (§B.4).
Direct field updates via the `update` op MUST NOT change `status`; `update` MUST ignore `status` if
supplied in the fields argument.

### B.2 Allowed Status Transitions

| From | To | Op | Required Evidence |
|---|---|---|---|
| `"active"` | `"implemented"` | `retire` | `implementedByRef` (non-empty, references the implementing artifact/commit/PR) |
| `"active"` | `"retired"` | `retire` | `rationale` (non-empty, explains obsolescence) |
| `"implemented"` | `"retired"` | `retire` | `rationale` (non-empty) |

No other transitions are permitted. Attempting an invalid transition MUST throw with
`error.code === "MISSING_EVIDENCE"` and a human-readable `message`.

Records in `"retired"` status have no further transitions — they are terminal.

### B.3 Working-Set Exclusion

Records with `status === "retired"` are EXCLUDED from the default working set:

- `listByType(type)` returns only non-retired records by default.
- `listByCategory(category, options?)` returns only non-retired records by default.
- `defaultSimilarityDetector` considers only non-retired compiled records as candidates.
- The vector similarity detector (`createVectorSimilarityDetector`) considers only non-retired
  compiled records as candidates.

All four filtering surfaces accept an `includeRetired: true` option (or equivalent flag on the
similarity detector) to restore retired records to the result set.

Retired records remain **fully queryable with provenance**:
- `get(id)` always returns the full record regardless of status.
- `listByType(type, { includeRetired: true })` returns all records of that type.
- `listByCategory(category, { includeRetired: true })` returns all matching records.
- The record's `mutation_log` carries the full retirement evidence.

### B.4 `retire` Mutation Operation

The `retire` op transitions a record from `"active"` or `"implemented"` to the target status.
It NEVER deletes the record. The record body, links, and provenance remain intact.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `id` | argument | ID of the record to retire. |
| `targetStatus` | argument | Target status: `"implemented"` or `"retired"`. |
| `agent` | evidence | Agent performing the retirement. |
| `rationale` | evidence | Non-empty string explaining why the record is being retired. Required for all target statuses. |

**Conditional evidence fields:**

| Field | Location | Condition | Description |
|---|---|---|---|
| `implementedByRef` | evidence | `targetStatus === "implemented"` | Non-empty reference to the implementing artifact (commit SHA, PR URL, issue number, etc.). |
| `supersededByRef` | evidence | optional for `targetStatus === "retired"` | Reference to a superseding record or artifact. |

**Rejection conditions:**
- Record with `id` does not exist.
- `targetStatus` is not `"implemented"` or `"retired"`.
- Current status transition is invalid (see §B.2).
- `rationale` is missing or empty.
- `targetStatus === "implemented"` and `implementedByRef` is missing or empty.
- Missing `agent` in evidence.

**Post-conditions:**
- Record `status` is updated to `targetStatus`.
- Record `updated_at` is refreshed.
- A mutation log entry (op=`"retire"`) is appended, carrying `targetStatus`, `rationale`,
  and any supplied `implementedByRef` / `supersededByRef`.
- The record body, `links`, and creation `provenance` are NOT changed.
- `get(id)` returns the full record with the updated status.
- `listByType(type)` (without `includeRetired`) no longer returns this record if
  `targetStatus === "retired"`.

### B.5 Adapter Contract Extension

The adapter interface (§8) is extended:

```ts
interface KnowledgeStoreAdapter {
  // ... existing methods ...
  retire(id: string, targetStatus: "implemented" | "retired", evidence: RetireEvidence): Promise<void>;
  listByType(type: RecordType, options?: { includeRetired?: boolean }): Promise<Record[]>;
  listByCategory(category: string, options?: { prefix?: boolean; includeRetired?: boolean }): Promise<Record[]>;
}
```

`RetireEvidence`:
```ts
interface RetireEvidence {
  agent: string;
  rationale: string;
  implementedByRef?: string;   // required when targetStatus === "implemented"
  supersededByRef?: string;    // optional
  note?: string;
}
```

### B.6 Provenance and History Guarantee

Retired records MUST remain reachable from:
- `get(id)` — always returns the full record.
- `listByType(type, { includeRetired: true })` and `listByCategory(category, { includeRetired: true })`.
- Snapshot `provenance.source_ids` — any snapshot that included the record in its cluster before
  retirement retains the reference intact. The retired record can be retrieved via `get(sourceId)`.
- The retirement `mutation_log` entry carries the full evidence of why and when the record was
  retired and by whom.

There is no deletion of records. Physical purge (if ever needed) is a separate, future policy
hook not defined in this version.

### B.7 Proposal-Artifact Lifecycle (close-on-apply)

A flow that gates a change through `propose` → `apply` mints a transient **proposal artifact**:
a `raw` record (e.g. the `knowledge.retire` flow's `"Retirement proposal: <title>"` record) whose
sole purpose is to carry the `"proposes"` link and the proposal text to the target.

Once the proposal has been **applied**, that artifact is *spent*. It MUST NOT be left as an
`active` record:

- A lingering active artifact pollutes the default working set (`listByType` / `listByCategory`)
  and is re-surfaced by hygiene sweeps.
- Hand-retiring it spawns a double-prefixed twin
  (`"Retirement proposal: Retirement proposal: …"`), because the retire flow mints a *new*
  proposal artifact for the artifact itself (#106).

**Rule.** On `apply` (and only on `apply`), the flow auto-closes the spent proposal artifact by
**retiring it via the existing `retire` op** (§B.4) — `active → retired`. There is no separate
"close" mutation; the close reuses `retire`. This close is:

- **safe** — it touches only the named artifact, never the apply target;
- **idempotent** — a no-op if the artifact is already retired/implemented (the §B.2 transition
  table makes `retired` terminal, so a re-close is rejected and treated as a no-op);
- **non-fatal** — the proposal has already been applied; a failure to close the artifact does not
  fail the flow (it is surfaced on the result instead).

**`reject` is unchanged.** A rejected proposal is *not* spent — the artifact remains `active` so the
proposal can be revisited. Closing happens only on the apply path.

Do not hand-retire proposal artifacts: applying the proposal closes them. The retire lifecycle
expects the artifact to exist transiently and to be auto-closed on apply.

---

## Addendum C — Person Record Type (Entity Cards)

### C.1 `person` Record Type

A `person` record is a first-class entity card for a named individual mentioned in the knowledge base.
It participates fully in links, the graph index, and status lifecycle like any other record type.

| Field | Notes |
|---|---|
| `type` | `"person"` |
| `title` | The person's full name. Used for exact-match resolution. |
| `body` | Structured prose with role and/or org: `**Role/Org:** <text>`. Merged on apply during card union. |
| `tags` | May include `alias:<name>` entries for alternative names (nicknames, initials). |
| `category` | Dot-separated category. The Obsidian adapter ignores this for routing — person records always land in `people/`. |

### C.2 Link Kinds Extended

| Kind | Direction | Meaning |
|---|---|---|
| `"appears-in"` | person → raw\|compiled | Person was mentioned in that record. |
| `"person"` | compiled → person | Compiled record references a person card. |

### C.3 Obsidian Adapter Layout

The Obsidian store adapter (`adapters/obsidian-store`) places person records under a
top-level `people/` folder regardless of category, so person cards are vault-global entities.

```
<storeRoot>/
  people/
    dana-smith.md
    lee-wong.md
  <category-as-path>/
    <title-slug>.md      (concept, snapshot)
    <sourcesDir>/
      <title-slug>.md   (raw, compiled)
```

Person cards render an **Appears In** section listing all `appears-in` links as Obsidian wikilinks.
Notes that reference people render a **People** section listing `person` links.

### C.4 Alias Storage

Aliases are stored in the `tags` array using the prefix `alias:`:

```yaml
tags: [alias:Dana S., alias:D. Smith]
```

Resolution checks both `title` and all `alias:*` tags for exact normalised-name match.

### C.5 Entity Extraction (Flow Runner)

The `KnowledgeFlowRunner.extractEntities(compiledId, options)` method:

1. Runs the extractor (default: `defaultEntityExtractor`) against the compiled record and its source raws.
2. For each mention, resolves via exact-name match (incl. aliases) or creates a new person card.
3. Near-matches (same surname + initial) create a **separate** card with a `related` link labelled
   `possible-duplicate` — no auto-merge.
4. Writes bidirectional links: `person → raw+compiled` (kind `appears-in`) and `compiled → person` (kind `person`).

### C.6 Card Merge

Card merge uses the existing `propose → apply/reject` gate:

- `KnowledgeFlowRunner.mergePerson(primaryId, duplicateId, options)`
- **apply**: unions body, adds `alias:<duplicate title>` tag to primary, unions `appears-in` links, calls
  `store.supersede(primaryId, [duplicateId])` to archive the duplicate (supersede-not-delete invariant).
- **reject**: both cards remain byte-identical.

## Addendum D — Freshness Audit (Hygiene #1, #106)

### D.1 Read-Only Maintenance Layer

`knowledge.audit-freshness` is the first of the Knowledge Kit's *maintenance* flows. The Kit is
strong at filing (ingest → compile → synthesize → consolidate → retire) but, until this slice, had
no way to surface records that have gone stale. The audit is a **read-only** survey: it NEVER
mutates a record. It returns *flags* proposing an action; the operator routes each flag through an
existing gated flow — `knowledge.retire` to archive, or a fresh `capture`/`compile` to refresh. The
audit forks no new mutation path.

Staleness is domain-sensitive (a `radar` signal goes stale in days; a `decisions` record may stay
canonical for a year), so the audit is **optional and configurable** — thresholds are supplied per
call. A category with no configured threshold (and no default) is simply skipped: auditing is
**opt-in**.

### D.2 `auditFreshness` Flow-Runner Operation

`KnowledgeFlowRunner.auditFreshness(options)` (also the module-level `auditFreshness({ store, ... })`):

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `thresholds` | `{ [category]: number }` | `{}` | Per-category staleness threshold in **days**. |
| `defaultThresholdDays` | `number` | none | Fallback for categories not matched by `thresholds`. When absent, unmatched categories are skipped. |
| `actions` | `{ [category]: "archive"\|"refresh" }` | `{}` | Per-category override of the proposed action. |
| `defaultAction` | `"archive"\|"refresh"` | `"refresh"` | Proposed action when no per-category action matches. |
| `types` | `string[]` | `["raw","compiled","concept","snapshot"]` | Record types to audit. |
| `now` | `string\|number\|Date` | current time | Reference "now" for the age computation (injectable for tests). |
| `agent` | `string` | runner agent | Agent recorded on the audit telemetry. |

**Threshold / action resolution** is dot-hierarchy **longest-prefix**: a record in
`radar.signals.weak` prefers a `radar.signals` entry over a `radar` one, then falls back to the
default. The matched key is surfaced on each flag as `matchedThresholdKey` (`"*"` denotes the
default).

**Last mutation** is the most recent of the record's `updated_at` and its latest `mutation_log`
entry `at` — both are refreshed by every mutating op (§1.1 / §4.2), so the later of the two is
authoritative even if an adapter lags one. It falls back to `created_at` when neither is present.

**Flagging:** a record is flagged only when its age in **whole days** *strictly exceeds* its
resolved threshold (`ageDays > thresholdDays`). Retired records are never flagged — the default
`listByType` query excludes them, and `retired` is terminal.

### D.3 Flag Evidence Guarantee

Every flag carries the evidence that produced it — a flag can never be emitted without citing both
the last-mutation instant and the threshold that fired:

```ts
interface FreshnessFlag {
  recordId: string;
  title: string;
  type: string;
  category: string;
  status: string;
  lastMutationAt: string;       // ISO-8601 — the cited last mutation
  ageDays: number;              // whole days since lastMutationAt
  thresholdDays: number;        // the threshold that fired
  matchedThresholdKey: string;  // category key the threshold matched ("*" = default)
  proposedAction: "archive" | "refresh";
}
```

`auditFreshness` returns `{ audited, skipped, flags, telemetryEvents }` where `audited` counts
records that had a resolvable threshold, `skipped` counts opt-out categories, and `flags` lists the
stale records. Gate telemetry is emitted at `collect-gate` and `flag-gate`
(`knowledge.audit-freshness`).

## Addendum E — Category Canonicalization (Hygiene #4, #106)

### E.1 Read-Only Category-Sprawl Audit

`knowledge.canonicalize-category` is a *maintenance* flow, like the freshness audit (Addendum D): a
**read-only** survey that NEVER mutates a record. Where freshness measures records against *time*,
this audit measures the *shape of the category hierarchy*. As a Knowledge base grows by filing, its
category tree degrades in concrete ways the dogfooding surfaced (#106) — orphan prefixes, parents
that fan out into too many leaves, and records that were implemented but never retired. The audit
returns *findings* proposing a fix; the operator routes each through an existing gated flow —
`knowledge.retire` to retire, or an `update` (recategorize) to flatten/regroup. The audit forks no
new mutation path.

Sprawl is domain-sensitive (a flat radar feed differs from a deep decisions taxonomy), so each
check is **optional and configurable**: a disabled check — or an empty implemented-marker list —
contributes no findings. The audit is **opt-in** per check.

### E.2 `canonicalizeCategory` Flow-Runner Operation

`KnowledgeFlowRunner.canonicalizeCategory(options)` (also the module-level
`canonicalizeCategory({ store, ... })`):

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `checkOrphanPrefixes` | `boolean` | `true` | Enable the orphan-prefix check. |
| `maxLeavesPerParent` | `number` | none | Leaf fan-out budget; a parent with strictly more direct child leaf categories is flagged. Omit to disable the check. |
| `implementedMarkers` | `string[]` | `[]` | Tag markers meaning "implemented" (case-insensitive). Empty → the implemented-active check is disabled. |
| `types` | `string[]` | `["raw","compiled","concept","snapshot"]` | Record types to survey. |
| `agent` | `string` | runner agent | Agent recorded on the audit telemetry. |

**Finding kinds** (each independently toggleable):

- **`orphan-prefix`** (`proposedAction: "flatten"`) — an intermediate prefix node that holds **no
  record directly** while it has descendants (`metric: "empty-intermediate-node"`), OR a
  multi-segment prefix whose **entire subtree is a single record** carried directly there
  (`metric: "single-record-deep-path"`) — depth without branching value.
- **`too-many-leaves`** (`proposedAction: "regroup"`) — a parent prefix whose count of direct child
  **leaf** categories *strictly exceeds* `maxLeavesPerParent` (`metric: "leaf-fan-out"`). A leaf is
  a record-bearing category with no record-bearing descendant. The finding lists the offending
  leaves.
- **`implemented-active`** (`proposedAction: "retire"`) — a record still `status:"active"` that
  carries an `implementedMarkers` tag (`metric: "implemented-marker-on-active"`); it should have
  transitioned via `retire` (§B.4) but lingers in the working set.

Retired records are never flagged — the default `listByType` query excludes them, and `retired` is
terminal (so it is not sprawl to flatten).

### E.3 Finding Evidence Guarantee

Every finding carries the evidence that produced it — a finding can never be emitted without citing
the metric that fired and the offending category / record ids:

```ts
interface CategoryFinding {
  kind: "orphan-prefix" | "too-many-leaves" | "implemented-active";
  category: string;        // the offending category / parent prefix
  recordIds: string[];     // the affected record ids
  metric: string;          // the rule that fired
  evidence: object;        // rule-specific (counts, leaf list, matched markers, reason)
  proposedAction: "flatten" | "regroup" | "retire";
}
```

`canonicalizeCategory` returns `{ surveyed, categories, findings, telemetryEvents }` where
`surveyed` counts the records examined, `categories` counts the distinct category prefixes in the
tree, and `findings` lists the sprawl. Gate telemetry is emitted at `survey-gate` and `propose-gate`
(`knowledge.canonicalize-category`).

## Addendum F — Glossary Sync (Hygiene #3, #106)

### F.1 Keeping the Glossary in Sync with Canonical Docs

`knowledge.glossary-sync` is a *maintenance* flow that keeps the **glossary** — the working set of
`concept` records — in sync with the **canonical docs** that define those terms. The Kit can file
concepts but, until this slice, had no way to (a) promote a term that a canonical doc defines but no
concept yet captures (a **gap**), or (b) notice when a concept's definition has **drifted** from its
canonical source (**out-of-date**).

The flow surveys a **configurable** glossary source list (the issue's "glossary source list") and is
**opt-in**: an empty/absent source list does nothing. It is **read-only by default** — it returns a
classification plan and mutates nothing; `apply: true` enacts the plan through the **existing**
concept-record ops (no forked mutation path).

### F.2 `glossarySync` Flow-Runner Operation

`KnowledgeFlowRunner.glossarySync(options)` (also module-level `glossarySync({ store, ... })`):

| Option | Type | Default | Description |
|---|---|---|---|
| `sources` | `Array<string \| { category, prefix? }>` | `[]` | The configurable glossary source list: each entry is a canonical-doc record id, or a category selector. An unknown id is rejected (the list is evidence). Empty → opt-in no-op. |
| `termExtractor` | `(doc) => Array<{ term, definition }>` | `defaultTermExtractor` | Pluggable extractor; the default parses glossary-style lines (`**Term** — def`, `Term: def`, list items). |
| `conceptCategory` | `string` | source doc's category | Category for matched/proposed concepts. |
| `apply` | `boolean` | `false` | `false` → read-only plan. `true` → enact via store ops. |

**Classification.** Each extracted term is matched against existing `concept` records by **normalized
term** (case/space-insensitive title) within the resolved category:

- **gap** — no concept captures the term.
- **outdated** — a concept exists but its body has **drifted** from the canonical definition.
  Drift is **whitespace-insensitive** (cosmetic reflow is not drift; substantive change is).
- **current** — the concept matches the canonical definition.

### F.3 Consume-Never-Fork Enactment

In `apply` mode the plan is enacted through the existing gated ops, with the **canonical doc as the
proposer** (it is the evidence for the definition) — no new mutation path is forked:

- **gap** → `store.create(concept)` then `store.propose` + `store.apply` (doc → concept).
- **outdated** → `store.propose` + `store.apply` on the existing concept (`new_body` = canonical).

`glossarySync` returns `{ sourcesAudited, entries, gaps, outdated, current, applied, telemetryEvents }`.
Every classified entry cites its evidence — the source doc id + title, the term, and the canonical
definition (outdated entries also cite the drifted `currentBody`). Gate telemetry is emitted at
`collect-gate`, `diff-gate`, and `propose-gate` (`knowledge.glossary-sync`).

## Addendum G — Contradiction Detection (Hygiene #2, #106)

### G.1 Read-Only Maintenance Layer

`knowledge.detect-contradictions` is the second of the Knowledge Kit's *maintenance* flows. Like
`audit-freshness` (Addendum D) it is a **read-only** survey: it NEVER mutates a record. It returns
*flags* identifying a conflicting pair; the operator routes each through an existing gated flow —
`knowledge.retire` to drop the stale assertion, or a fresh `capture`/`compile`/`consolidate` to
reconcile. The audit forks no new mutation path.

Contradiction is domain-sensitive (what counts as a conflict in `radar` differs from `decisions`),
so the audit is **optional and configurable**: it audits only the categories supplied in
`categories` (or, when omitted, every category present in the compiled set), and it judges conflicts
with a **pluggable contradiction fn**.

### G.2 `detectContradictions` Flow-Runner Operation

`KnowledgeFlowRunner.detectContradictions(options)` (also the module-level
`detectContradictions({ store, ... })`) compares **compiled** records **within a category** and
flags conflicting assertions. Comparison is two-staged and reuses the Kit's existing pluggable
adapters (consume-never-fork):

1. **Scope** with the `SimilarityDetector` (the same interface `synthesize` uses) — only records the
   detector deems similar (about the same thing) are candidates. The vector similarity adapter drops
   straight in.
2. **Judge** with the `ContradictionDetector` — for each similar pair, decide whether the assertions
   conflict.

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `categories` | `string[]` | all present | Categories to audit. Opt-in scoping; omit to audit every category in the compiled set. |
| `similarityDetector` | `fn` | `defaultSimilarityDetector` | Pluggable `(record, candidates, store) => string[]` — scopes which pairs are compared. |
| `contradictionDetector` | `fn` | `defaultContradictionDetector` | Pluggable `(recordA, recordB, store?) => null \| { reason }` — judges whether a pair conflicts. May be async. |
| `agent` | `string` | runner agent | Agent recorded on the audit telemetry. |

**Comparison scope:** retired records are excluded (the default `listByType` query drops them, and
`retired` is terminal); records are grouped by exact category, so cross-category pairs are never
formed; each unordered pair is compared at most once.

### G.3 `ContradictionDetector` Interface and the Default

```ts
type ContradictionDetector = (
  recordA: Record,
  recordB: Record,
  store?: KnowledgeStoreAdapter
) => (null | { reason: string }) | Promise<null | { reason: string }>;
```

The two records passed in are already known to be *about the same thing* (the caller scopes by
category + similarity). The detector's only job is to decide whether their assertions conflict.
Return `null` for no conflict, or `{ reason }` carrying a human-readable explanation.

The default (`defaultContradictionDetector`) is a deliberately conservative **opposing-polarity
heuristic**: it splits each body into clauses, tags each affirmative or negative by the presence of
a negation, and reports a conflict when one record AFFIRMS a clause whose salient content tokens
contain those of a clause the other NEGATES (token-containment, not exact equality, so trailing
detail on one side does not hide the conflict). It is intentionally replaceable — an embedding/NLI
model is the obvious upgrade, injected the same way the vector similarity adapter is.

### G.4 Flag Evidence Guarantee

Every flag cites **both** conflicting record ids — a flag can never be emitted without them:

```ts
interface ContradictionFlag {
  recordIdA: string;   // canonically ordered: recordIdA < recordIdB
  recordIdB: string;
  titleA: string;
  titleB: string;
  category: string;    // the shared category
  reason: string;      // why the contradiction fn fired
}
```

`detectContradictions` returns `{ audited, compared, flags, telemetryEvents }` where `audited`
counts the in-scope compiled records, `compared` counts the similar pairs the contradiction fn
judged, and `flags` lists the conflicting pairs. Gate telemetry is emitted at `collect-gate` and
`flag-gate` (`knowledge.detect-contradictions`).

## Addendum H — Record Identity Resolution (short-id prefix + slug aliases, #339)

### H.1 Motivation

On-disk identity is a full `id` (§1.1) plus a file path (§9). Prose that cites a record — a
curated doc, a commit message, an issue comment — cannot practically carry a full 36-char UUID, so
the field partner cites **8-char short ids** (`12cc5573`, `f5df7b4c`) and would prefer
**human-readable slugs**. Neither resolves against exact-id `get`, and a store restructure that
re-files a record silently severs every inbound short-id/slug reference.

This addendum adds a **resolution layer** over the unchanged on-disk identity. It changes nothing
about how records are stored (H.6) — it only widens what `get`/`getLinks` accept as input.

### H.2 Resolvable Handle Forms

`get(handle)` and `getLinks(handle)` MUST resolve, in this precedence order:

1. **Exact full id** — `handle` equals a stored record `id`. (Unchanged §7 behavior; the O(1)
   hot path.)
2. **Slug alias** — `handle` is a registered alias in the alias map (H.4) whose target still exists.
3. **Unambiguous id prefix** — `handle` is at least `MIN_ID_PREFIX` (**8**) characters and is a
   prefix of **exactly one** record `id`.

The first form that matches wins. A `handle` that matches none of the three resolves to *nothing*.

### H.3 Resolution Outcomes

| Situation | `get` | `getLinks` |
|---|---|---|
| Resolves to exactly one record | returns that record | returns that record's `{ forward, reverse }` |
| Resolves to nothing (no exact id, no alias, no ≥8-char single-match prefix) | returns `null` | returns `{ forward: [], reverse: [] }` |
| Prefix (≥8 chars) matches **more than one** record | **throws `AMBIGUOUS_ID`** | **throws `AMBIGUOUS_ID`** |

An `AMBIGUOUS_ID` error MUST have `code === "AMBIGUOUS_ID"`, a human-readable `message`, and a
`matches` array of the colliding full ids. An ambiguous prefix MUST NOT be silently resolved to one
arbitrary record, nor collapsed to `null` — ambiguity is a distinct, surfaced condition.

A `handle` **shorter than `MIN_ID_PREFIX`** is never treated as a prefix (it can still match an
exact id or a slug). This keeps a stray short token from matching a large, surprising set.

### H.4 Slug Aliases

- A slug is a lowercase, category-scoped, human-readable handle, e.g.
  `decision.strategy/2026-07-03-gtm-direction`. It MUST match
  `^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$` (≤ 200 chars). Malformed slugs are rejected at
  `create`/`update` with `MISSING_EVIDENCE`.
- Slugs are **caller-supplied** via the optional `aliases: string[]` field on `create` and
  `update`. The store does **not** auto-derive slugs (auto-slugging is a future concern) — the
  date-stamped examples cannot be derived from title alone.
- Aliases are **append-only**: `update` with an `aliases` field UNIONs the supplied slugs with the
  record's existing aliases; it never drops a previously issued slug. This is what guarantees H.5.
- A slug already assigned to a *different* record is a `SLUG_CONFLICT` (a slug identifies at most
  one record). Re-supplying a record's own slug is an idempotent no-op.

### H.5 Restructure Survival (the alias map)

The alias map is a store-level structure `{ slug → id }`. It is keyed by **full id** — never by
category or file path. Therefore:

- Recategorizing a record via `update` (which, in the Obsidian adapter, **relocates the note's
  file**) leaves both the `id` and the `slug → id` mapping untouched.
- The id still resolves (it is the record's stable key); the short-id prefix still resolves (it is
  a prefix of that unchanged id); the slug still resolves (the map still points it at that id).

So a previously issued short-id prefix or slug MUST still resolve to the same record after a
restructure. Note the slug is a **stable alias**, not a value recomputed from the current category:
a slug minted under `decision.strategy/…` keeps resolving even after the record moves to
`decision.gtm`.

Like the graph index (§5.2), the alias map is a **derived cache** — each record's own `aliases`
array is the source of truth, so an adapter that persists the map SHOULD rebuild it on `reindex()`.
The default adapter persists it at `<store_root>/alias-index.json`
(`{ schema_version, by_slug: { <slug>: <id> } }`).

### H.6 On-Disk Identity Is Unchanged (non-goals)

- The `id` in the §1.1 envelope and the `records/<id>.md` file naming (§9) are **unchanged**.
  Aliases are a resolution layer, not a rename.
- Exact-id `get`/`getLinks` behavior is byte-for-byte unchanged.
- This addendum does **not** migrate existing stores or repair already-broken citations — an
  adapter/repo may seed its own alias map for legacy short ids, but that is out of scope here.
- Full-text/semantic search is out of scope.

### H.7 Resolution Constants

| Constant | Value | Meaning |
|---|---|---|
| `MIN_ID_PREFIX` | `8` | Minimum handle length eligible for prefix resolution. |
| slug pattern | `^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$` | Valid slug alias shape (≤ 200 chars). |

An independent adapter conforms to this addendum when the `identity: *` sections of the contract
suite (`evals/contract-suite/suite.test.js`, §15–§17) pass against it.

---

## Addendum I — Inbound-Reference Integrity (doc→store citations, #340)

### I.1 Motivation

The store's graph (§2, §5) and the hygiene audits (Addenda D–G) cover record→record links and
survey **records**. Nothing resolves the references a human actually reads: the record ids that
curated docs — `NOW.md`, `strategy/*.md`, a roadmap — cite **into** the store. A store restructure
that re-files or retires a record silently severs every inbound doc citation, and every existing
gate still reports PASS. Field evidence (design partner `kontourai/ops`): `verify-ops` stayed green
for weeks while `NOW.md` and `strategy/vision.md` cited unresolvable short-ids (`12cc5573`,
`f5df7b4c`). This addendum makes that rot **fail closed**.

The check is a **read-only** flow (`KnowledgeFlowRunner.checkInboundReferences`) in the style of the
Addenda D–G audits: it mutates no record, appends no mutation-log entry, and forks no mutation path.
It resolves citations through the unchanged Addendum H identity path — it adds no new query surface.

### I.2 Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `docGlobs` | string[] | `[]` | Globs (relative to `docsRoot`) whose matching docs are scanned. **Empty = opt-in no-op pass** (Addenda D–G convention). Supports `*` (within a segment), `**` (across segments), `?`. |
| `docsRoot` | string | `workspace`, then `cwd` | Root the globs resolve against (the docs live outside the store). |
| `markers` | string[] | `["rec:", "record:"]` | Citation-marker prefixes that opt a following short-id/slug into **definite** citation status (I.3). |

### I.3 Citation Forms — the commit-SHA precision problem

A bare 8-hex token is inherently ambiguous: `12cc5573` is equally a record short-id and an
abbreviated git commit SHA. Failing on every non-resolving 8-hex token would flag every SHA in prose
(the gate cries wolf and gets muted); never failing on them re-opens the exact rot this closes. The
check resolves the tension with **two tiers**:

**Definite citations** — unmistakably a record reference, so resolved regardless of whether they
currently resolve, and an unresolved one **FAILS** (fail closed):

| Form | Example | Why it is SHA-safe |
|---|---|---|
| Full UUID (8-4-4-4-12 hex) | `aaaaaaaa-1111-4111-8111-111111111111` | The hyphenated shape never collides with a git SHA (40/abbrev hex, no hyphens) or prose. |
| Marker + token | `rec:12cc5573`, `record:decision.strategy/gtm` | The marker is explicit intent; the token may be a short-id or slug. |
| Wikilink | `[[decision.strategy/gtm]]` | The kit's own link syntax. |

**Candidate bare short-ids** — a standalone ≥8-hex token with **no** citation form is included in
the index **only when it already resolves** to a record. A non-resolving bare hex is indistinguishable
from a commit SHA, so it is **ignored** — never indexed, never failed.

> **Deliberate, documented miss.** A *broken* bare-hex short-id (no marker/wikilink) is invisible to
> the check — by construction, since it does not resolve. This is a precision-over-recall choice:
> **zero false positives on commit hashes**, at the cost of not catching bare-hex short-id rot until
> the doc adopts a citation form. To get fail-closed protection for a short-id or slug, cite it in a
> marker or wikilink form; full-UUID citations are protected with zero configuration. Migrating a
> consuming repo's house style to a marker is an ops-repo change (a non-goal here).

Every extracted token is resolved via `get(token)` (Addendum H: exact id → slug alias → unambiguous
≥8-char prefix). `null` → unresolved; an `AMBIGUOUS_ID` throw is caught and reported as an unresolved
citation with `reason: "ambiguous"` (fail closed — an ambiguous citation does not uniquely resolve).

### I.4 Fail-Closed Semantics

The result's `ok` is `true` **iff** `unresolved` is empty — i.e. every definite citation resolved. A
caller (e.g. ops `verify-ops`) treats `ok === false` as a gate failure. Each `unresolved` entry names
`doc`, `line`, `column`, `token`, `form`, and `reason` so the break is actionable. An empty scan with
configured globs that cite nothing is a pass; an empty scan from **no** globs is the explicit opt-in
no-op — neither is an "empty success" that masks an unresolved definite citation.

### I.5 Citation Index (result shape)

The result exposes the full citation index so downstream flows (supersede/retire propagation) can
enumerate citers:

```json
{
  "ok": true,
  "scanned": ["NOW.md", "strategy/vision.md"],
  "citations": [
    { "doc": "NOW.md", "line": 3, "column": 17, "token": "aaaaaaaa-1111-4111-8111-111111111111",
      "form": "uuid", "resolved": true, "recordId": "aaaaaaaa-1111-4111-8111-111111111111" }
  ],
  "unresolved": [
    { "doc": "NOW.md", "line": 5, "column": 9, "token": "deadbeef-0000-4000-8000-000000000000",
      "form": "uuid", "reason": "not-found" }
  ],
  "byDoc":    { "NOW.md": [ { "token": "…", "form": "uuid", "resolved": true, "recordId": "…", "line": 3, "column": 17 } ] },
  "byRecord": { "aaaaaaaa-1111-4111-8111-111111111111": [ { "doc": "NOW.md", "line": 3, "column": 17, "token": "…", "form": "uuid" } ] }
}
```

- `citations` — every recorded citation (definite ones, plus bare candidates that resolved).
- `byDoc` — doc → its cited record ids (every scanned doc appears, even if it cites nothing).
- `byRecord` — record id → its citers (the doc→record edge; a natural typed edge under #317).

### I.6 Conformance

An adapter conforms to this addendum when the inbound-reference suite
(`evals/inbound-references/suite.test.js`) passes against it — AC1 (three forms extracted +
resolved), AC2 (fail closed on a nonexistent id; no-op pass with no globs), AC3 (read-only), and the
commit-SHA-safety case. The suite is parameterized by `KNOWLEDGE_ADAPTER`, so conformance is required
of every adapter (AC4). Because the check reuses `get`, any Addendum-H-conforming adapter satisfies it
without new storage.
