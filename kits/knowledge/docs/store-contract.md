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
| `get` | `(id: string) => Record \| null` | Retrieve record by id. Returns null if not found. |
| `getLinks` | `(id: string) => { forward: Link[], reverse: Link[] }` | Return all links for a record from the graph index. |
| `listByCategory` | `(category: string, options?: { prefix?: boolean }) => Record[]` | List records by exact category match. If `prefix` is true, match all records whose category starts with the given string. |
| `listByType` | `(type: RecordType) => Record[]` | List all records of a given type. |

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

Files are stored as `<store_root>/records/<id>.md`. The graph index lives at
`<store_root>/graph-index.json`.

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
