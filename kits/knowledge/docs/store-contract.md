---
title: Knowledge Kit Store Contract
version: "1.0"
---

# Knowledge Kit Store Contract

This document defines the storage contract for the Knowledge Kit. Any store adapter that
implements this contract can be substituted for the default adapter without changing kit flows.
Sections 1–9 consolidate the current envelope and adapter surface, including the
existing snapshot, lifecycle, person, identity and freshness extensions. The
addenda retain the reasons and detailed semantics of those extensions, in their
original order; their earlier type counts and interface fragments are extension
history, not alternative current contracts. This clarification retains contract
version `1.0`; it changes neither stored records nor runtime behavior.

This mutable store API is distinct from the proposals-only
[Knowledge Store Provider graph API](../../../context/contracts/knowledge-store-contract.md).
A provider projects records into graph nodes/edges with read provenance; it does
not replace the record envelope or grant permission to mutate the store.

---

## 1. Record Types

Both bundled adapters (`default-store` and `obsidian-store`) accept these five
record types. Every type shares the envelope in §1.1.

| Type | Intended content | Source convention |
|---|---|---|
| `raw` | Unprocessed material preserved as text (§1.2). | Creation provenance identifies the capturing process. |
| `compiled` | A distillation reviewed by its authoring workflow (§1.3). | `source` links and `provenance.source_ids` identify input raw records. |
| `concept` | A named idea, term or principle (§1.4). | May link to examples or related records. |
| `snapshot` | A bounded topic summary (§A.3). | Consolidation supplies source links/ids and may supersede older snapshots. |
| `person` | An entity card (§C.1). | May use `appears-in` / `person` links and `alias:` tags. |

These content conventions do not imply adapter verification. In particular,
`create` accepts compiled/snapshot records without source links or source ids;
it does not certify review, truth, or whether the supplied sources support the
body. Callers/flows must supply and check that evidence. Both adapters require
`provenance.agent`; they accept the label supplied by the caller.

### 1.1 Common Record Envelope

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable, opaque identifier. Must be unique within the store. Adapter may generate (e.g. UUID or slug). |
| `type` | `"raw"` \| `"compiled"` \| `"concept"` \| `"snapshot"` \| `"person"` | yes | Discriminates the record type. |
| `title` | string | yes | Human-readable title. |
| `body` | string | yes | Primary content. Format is type-specific (see below). |
| `category` | string | yes | Dot-separated hierarchical category string, e.g. `"engineering.api"`. Must be non-empty. |
| `tags` | string[] | no | Flat list of tag strings for secondary classification. |
| `aliases` | string[] | no | Human-readable, category-scoped slug aliases resolvable via `get`/`getLinks` (Addendum H). Append-only; never changes `id`. |
| `links` | Link[] | no | Outbound links from this record (see §2). |
| `provenance` | Provenance | yes | Immutable creation provenance (see §4); `agent` required, `source_ids`, `session_id`, `note` optional. |
| `status` | `"active"` \| `"implemented"` \| `"retired"` | no | Created as active; absent means active. Change via `retire`, not `update` (§B). |
| `mutation_log` | MutationLogEntry[] | adapter-maintained | Empty at creation; append-only operation/evidence history (§4.2). |
| `created_at` | ISO-8601 string | yes | Creation timestamp in UTC. |
| `updated_at` | ISO-8601 string | yes | Last mutation timestamp in UTC. |
| `expires_at` | ISO-8601 string | no | Optional record-carried expiry (Addendum J). When now is at or past it, the record derives to `stale`. Never silently mutates the record. |
| `ttl_seconds` | number | no | Optional relative expiry in seconds from `created_at` (Addendum J). `expires_at`, when present, takes precedence. |

Records **without** `expires_at` / `ttl_seconds` behave exactly as before this addendum — they are never derived `stale` via the expiry path.

### 1.2 `raw` Record

A raw record holds unprocessed source material exactly as received — a document excerpt,
a transcript snippet, a URL with notes, or any other unrefined input.

- `body`: free-form string, preserved verbatim.
- No semantic constraints on content.
- Intended as the input stage before compilation.

**Bundled implementation limitation:** verbatim preservation is the fidelity
requirement, not a guarantee currently met for every accepted string. The shared
Markdown reader strips leading newlines, so a default-store raw body beginning
with a newline loses it on readback. Obsidian splits rendered content at its
`<!-- kit:body-end -->` sentinel without escaping that text in input; a raw body
containing it can be truncated. Ordinary text such as the first-note example is
not a proof of universal lossless round trips. Codec repair is separate from this
contract clarification; the required fidelity and contract version remain unchanged.

### 1.3 `compiled` Record

A compiled record is intended to hold a normalized, editor-reviewed distillation of raw records.

- `body`: structured markdown, expected to be human-readable reference prose.
- The compile flow supplies `source` links to its raw inputs and `provenance.source_ids`.
- Direct adapter `create` does not require or validate those source relationships;
  a type label alone does not establish that compilation or review happened.

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
| `"source"` | compiled → raw; snapshot → compiled | Input record cited by compilation or consolidation. |
| `"example"` | concept → compiled | This compiled record exemplifies the concept. |
| `"related"` | any → any | General semantic relation. |
| `"refines"` | compiled → compiled | Later record refines or supersedes an earlier one. |
| `"proposes"` | any → any | Record proposes a change to an existing target (used with `propose` mutation). |

Adapters MUST store and return link objects with at least `target_id` and `kind`. Unknown
kinds MUST NOT be rejected — forward compatibility requires tolerating new string kinds.

**Known bundled link-admission gap:** `kind` remains a required string, but neither
adapter validates it on caller-supplied links in `create`, `update` or `link`.
For existing ordinary records S and T, `link(S, [{ target_id: T }], { agent: "caller" })`
can succeed and persist/query a link without `kind`; undefined fields disappear
from serialized storage. This violates the required shape, rather than being an
unknown-string-kind compatibility case. Required-field rejection and returned-link
requirements remain normative; no new link vocabulary or admission rule is added.

**Known bundled link-deduplication gap:** the merge key concatenates
`target_id + "::" + kind` rather than comparing the pair structurally. Distinct
valid links `{ target_id: "a", kind: "b::c" }` and
`{ target_id: "a::b", kind: "c" }` have the same key. With both target records
present on the current POSIX host, `link` can return successfully while storing
and indexing only the first link. Related body/explicit-link merges and supersede
merges use the same key formulation. This is separate from missing-kind admission:
opaque ids, unknown string kinds and triple-based idempotence/postconditions remain
normative, without reserving the delimiter or authorizing silent link omission.

### 2.3 Wikilink Syntax

In `body` text, outbound links may also appear as `[[target_id]]` or `[[target_id|label]]`.
Both bundled adapters parse inline body wikilinks during `create` and `update`; the
default adapter permits `parse_wikilinks: false`, while Obsidian has no opt-out.
`apply` replaces the body while preserving the existing link set: it does not parse
new inline wikilinks or reindex the replacement text. The contract requires that
after a round-trip, links explicitly declared in the `links` array are queryable
via `getLinks(id)`. Inline parsing is an adapter implementation detail; the contract
does not mandate a body format. The graph-key implementation limit in §7 remains
separate from this operation-specific parsing behavior.

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

Every record carries immutable creation provenance. Mutation operations append
evidence to `mutation_log`. Adapters enforce required process labels and
operation-specific fields (§6); labels, links and evidence references record
what the caller supplied, not authenticated identity or independent verification.

### 4.1 Creation Provenance Object (`provenance`)

| Field | Type | Required | Description |
|---|---|---|---|
| `source_ids` | string[] | no | Caller-supplied input record ids (e.g. raw inputs for compiled records, compiled inputs for snapshots). Non-empty arrays are retained; `create` does not require them or resolve their targets. |
| `agent` | string | yes | Caller-supplied identifier of the creating agent/process. Required, not authenticated by the adapter. |
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

**Bundled implementation gap:** the file adapters do not currently provide that
record/index transaction. They write the record and derived graph separately,
in different orders across operations, without rollback. A failure can leave one
write complete while the mutation rejects; crash/error atomicity is not supplied
by these adapters. The atomic-update requirement above remains normative. The
derived-index `reindex` recovery path (§8) is not a transaction or rollback guarantee.
A separate successful self-proposal overwrite can also violate record/index coherence,
even without a write failure; see the implementation exception in §6.4.

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

The store exposes eight mutation operations: the six detailed below, plus
`supersede` (§A.5) and `retire` (§B.4), all included in §8. Each operation specifies:

- **Required provenance/evidence fields** that the caller MUST supply.
- The adapter MUST reject the call with an error if any required field is missing.
- Optional fields that the adapter records when present.

### 6.1 `create`

Create a new record. The adapter generates `id` unless supplied and assigns
`created_at` and `updated_at`.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `type` | top-level | Record type: `"raw"`, `"compiled"`, `"concept"`, `"snapshot"`, or `"person"`. |
| `title` | top-level | Non-empty title string. |
| `body` | top-level | Non-empty body string. |
| `category` | top-level | Non-empty dot-separated category. |
| `provenance.agent` | provenance | Agent identifier. |

**Optional fields:** `id` (otherwise generated), `tags`, `aliases`, `links`,
`expires_at`, `ttl_seconds`, `provenance.source_ids`, `provenance.session_id`,
`provenance.note`. The default adapter also accepts `parse_wikilinks: false`
during `create`/`update` of untrusted body text; the Obsidian adapter parses wikilinks
in those operations without an opt-out. Neither adapter parses replacement body
wikilinks during `apply` (§2.3).
Do not assume that option is portable across adapters. Alias syntax/admission is
specified in §H.4, including the bundled false-conflict gap for `constructor`.

**Rejection conditions:**
- Missing or empty `type`, `title`, `body`, `category`.
- `type` outside the five types in §1.
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

**Optional update fields (at least one must be supplied):** `title`, `body`,
`category`, `tags`, `links`, `aliases`, `expires_at`, `ttl_seconds`. Aliases are
append-only. `status` is ignored; lifecycle changes use `retire`. The default
adapter's `parse_wikilinks` switch is not itself a mutable record field. The alias
registration gap in §H.4 affects both `create` and alias-adding `update`.

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
The bundled missing-`kind` admission and delimiter-deduplication gaps in §2.2 can
violate the required Link shape or omit distinct valid links despite successful
target-existence and caller-evidence checks.

### 6.4 `propose`

Record a proposed change to any existing record type. The original `conceptId`
parameter name (shown below as `concept_id`) is retained for compatibility; it
names the target record and does not restrict its type. Concept editing is one
use; the retirement flow also proposes changes to other record types. The
proposal leaves the target body unchanged, adds a `"proposes"` link from the
proposing record to the target, and appends mutation history with the proposal text.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the existing target record. |
| `proposer_id` | argument | ID of the record making the proposal. |
| `proposal` | evidence | Non-empty string describing the proposed change. |
| `agent` | evidence | Agent submitting the proposal. |

**Rejection conditions:**
- `concept_id` does not exist.
- `proposer_id` does not exist.
- `proposal` string is empty or missing.
- Missing `agent` in evidence.

**Post-conditions:** A link of kind `"proposes"` from `proposer_id` to `concept_id` is recorded
in both the record and the graph index. Mutation log entry appended to the target record.

**Known bundled self-proposal gap:** neither adapter rejects equal target/proposer
ids. With a new self-proposal on an ordinary record R, both read R before either
write, then write the proposer update followed by a target update from the older
snapshot. The final successful write can discard the new stored proposal link,
proposer timestamp and proposer-side history, while the graph retains the self
`proposes` edge. `get(R).links` and `getLinks(R)` then disagree. A following
`apply(R, R, ...)` checks the stored links and can reject `MISSING_EVIDENCE` despite
the graph edge. Default `reindex` can remove the phantom edge but cannot recover
the missing proposal. This violates the post-condition above without an I/O error;
it is separate from the failed-write transaction gap in §5. The contract does not
add a distinct-id requirement, and no runtime rejection rule is implied here.

### 6.5 `apply`

Apply a pending proposal to any existing record type: replace its body and append
an `apply` mutation entry. The `concept_id` parameter names the target record.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the existing target record. |
| `proposer_id` | argument | ID of the record whose proposal is being applied. |
| `new_body` | evidence | The replacement body text for the target record. |
| `agent` | evidence | Agent applying the proposal. |
| `rationale` | evidence | Non-empty string explaining why the proposal is accepted. |

**Rejection conditions:**
- `concept_id` does not exist.
- `proposer_id` does not exist.
- No `"proposes"` link from `proposer_id` to `concept_id` exists.
- `new_body` is missing or empty.
- `rationale` is missing or empty.
- Missing `agent` in evidence.

**Post-conditions:** Target `body` is replaced with `new_body`. `updated_at` refreshed.
Mutation log entry (op=`"apply"`) appended. The `"proposes"` link MAY remain in the
graph (it is a historical record); adapters SHOULD NOT silently delete it.
The bundled self-proposal gap in §6.4 can leave only a graph edge, which does not
satisfy the stored-proposal-link check used by `apply`.

### 6.6 `reject`

Reject a pending proposal: record that the proposal was reviewed and declined.
The target body is not modified; all existing record types are accepted.

**Required fields:**

| Field | Location | Description |
|---|---|---|
| `concept_id` | argument | ID of the existing target record. |
| `proposer_id` | argument | ID of the proposing record. |
| `agent` | evidence | Agent rejecting the proposal. |
| `reason` | evidence | Non-empty string explaining the rejection. |

**Rejection conditions:**
- `concept_id` does not exist.
- `proposer_id` does not exist.
- No `"proposes"` link from `proposer_id` to `concept_id` exists.
- `reason` is missing or empty.
- Missing `agent` in evidence.

**Post-conditions:** Target `body` is unchanged. `updated_at` is NOT changed;
a mutation log entry (op=`"reject"`) is appended to the target record.

---

## 7. Query Interface

The adapter MUST implement the following asynchronous methods. Listing options
are `{ prefix?, includeRetired?, stale?, now? }` for category queries and
`{ includeRetired?, stale?, now? }` for type queries. `prefix` includes exact
category and dot-delimited descendants. Retired records are excluded by default;
`get` is the required full-history access path, subject to the bundled Obsidian
[archive retention gap](#known-obsidian-archive-retention-gap). `stale: true` selects records expired at
`now` (default current time); it does not mutate status. Listings use the adapter's
working set: Obsidian excludes archived supersession predecessors from both
listings even with `includeRetired: true`. The default adapter retains those
predecessors in listings subject to lifecycle filters. Across both adapters,
use `get(id)` and reverse `supersedes` links to inspect retained predecessor history.

| Method | Signature | Description |
|---|---|---|
| `get` | `(idOrHandle: string) => Promise<Record \| null>` | Retrieve a record. `idOrHandle` may be a full id, a slug alias, or an unambiguous id prefix (Addendum H). Returns null if it resolves to nothing; throws `AMBIGUOUS_ID` on an ambiguous prefix. |
| `getLinks` | `(idOrHandle: string) => Promise<{ forward: Link[], reverse: Backlink[] }>` | Resolve the same handle forms as `get`, then read that graph-index key. If identity resolution fails, use the literal input key; return empty arrays when it has no indexed links. An ambiguous prefix throws `AMBIGUOUS_ID`. |
| `listByCategory` | `(category: string, options?: CategoryQueryOptions) => Promise<Record[]>` | List records by exact category match. If `prefix` is true, match all records in that exact category or its dot-delimited descendants. |
| `listByType` | `(type: RecordType, options?: QueryOptions) => Promise<Record[]>` | List all records of a given type. |

> **Identity resolution** (`get`/`getLinks`) is specified in full in **Addendum H**. The `prefix`
> option on `listByCategory` is unrelated — it filters by *category* prefix, not by id.

Because `create`/`update` can index supplied links without validating their targets,
a literal graph key can have backlinks even when `get` returns `null`. Link lookup
does not establish that a record exists or that a target was validated.

### Known default-store path-normalized identity gap

The opaque-id and exact/alias/prefix requirements remain normative. The default
adapter derives exact existence and prefix candidates from normalized filenames,
while retaining the caller's original id in frontmatter. A contained id such as
`abcdefgh/../plain-record` can be created at `records/plain-record.md` and read
through the original id, but its unique eight-character stored-id prefix
`abcdefgh` does not resolve: filename enumeration yields `plain-record` instead.
Conversely, `get("plain-record")` can return that record without an issued alias
or matching envelope id. `get("./<ordinary-id>")` can also resolve through filename
normalization while `getLinks` uses that spelling as a different graph key.
These are inside-root identity/indexing violations, not evidence of an outside-root
traversal. They are separate from Obsidian's archive/dimension collisions and the
prototype-key gaps below. No new forbidden-id syntax or migrated identity is
introduced by this disclosure; generated-id first-note behavior is a separate case.

### Known bundled graph-key handling gap

The query contract requires the structured array result above and permits opaque
string ids; prototype-named ids are not reserved or forbidden. Both bundled graph
indexes currently use ordinary JavaScript objects and read bracket keys without
an own-property or array check. Consequently, `getLinks("constructor")` on an empty
graph can retrieve an inherited property and throw a plain `TypeError` at `.map`
instead of returning arrays. A successfully created no-link record with that id
can still be retrieved through `get` while `getLinks` throws. Other inherited
property names, including `__proto__` and `toString`, expose the same class of gap;
graph mutation helpers also assume array-valued lookups. Accepted opaque-id
create/get tests do not establish graph-query conformance. This is an inherited
implementation violation, not a new reserved-id rule or a waiver of the result
contract. The identity/query tables describe the required interface with this
known implementation exception.

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
  get(idOrHandle: string): Promise<Record | null>;
  getLinks(idOrHandle: string): Promise<{ forward: Link[]; reverse: Backlink[] }>;
  supersede(newId: string, supersededIds: string[], evidence: SupersedeEvidence): Promise<void>;
  retire(id: string, targetStatus: "implemented" | "retired", evidence: RetireEvidence): Promise<void>;
  listByCategory(category: string, options?: CategoryQueryOptions): Promise<Record[]>;
  listByType(type: RecordType, options?: QueryOptions): Promise<Record[]>;
  reindex?(): Promise<{ records: number; links: number; forwardSources: number;
    reverseTargets: number; changed: boolean }>;
}
type RecordType = "raw" | "compiled" | "concept" | "snapshot" | "person";
interface Backlink { source_id: string; kind: string }
interface QueryOptions { includeRetired?: boolean; stale?: boolean; now?: string | number }
interface CategoryQueryOptions extends QueryOptions { prefix?: boolean }
interface SupersedeEvidence { agent: string; rationale: string; note?: string }
interface RetireEvidence {
  agent: string; rationale: string; implementedByRef?: string; supersededByRef?: string; note?: string;
}
```

`supersede` requires a non-empty predecessor list and rationale and MUST retain
predecessors; it does not retire them. The bundled Obsidian archive retention gap
below is an implementation violation of that requirement. `retire` requires rationale and, for the
implemented state, `implementedByRef`. See §A/§B for permitted targets and status
transitions. Optional `reindex` repairs only the derived index from record links.

### Bundled adapter variations

| Behavior | `default-store` | `obsidian-store` |
|---|---|---|
| Record paths | `records/<id>.md` | Category/title paths, source subfolders, and vault-global `people/`; stable ids resolved through a path index. |
| Body wikilinks | Parsed during `create`/`update` unless `parse_wikilinks: false`; `apply` preserves existing links without parsing its replacement body. | Parsed during `create`/`update`, no opt-out; `apply` likewise preserves existing links. |
| Person names | Ordinary title/tags/links storage. | Entity-card sections and vault-global routing; `alias:` tags differ from record-handle `aliases`. |
| Provenance | Required `agent`; optional source ids/session/note. | Same creation requirements; vault path/layout does not strengthen assurance. Configured dimension collisions can overwrite canonical metadata as disclosed below. |
| Superseded predecessors in listings | Remain in `listByType` / `listByCategory`, subject to lifecycle filters. | Moved to `archive/` and excluded from both listings regardless of `includeRetired`; intended historical access is `get(id)` and reverse supersession links, subject to the archive collision gap below. |

#### Known Obsidian dimension collision gap

Configurable `dimensions` names are not validated against envelope fields. The
adapter derives values from category segments after the first and spreads those
fields after canonical frontmatter, so a colliding name wins on disk. For example,
`dimensions: ["id"]` with category `topic.replacement` can create a record indexed
under generated id R but with persisted `id: replacement`; `get(R)` then returns
the other id. `dimensions: ["status"]` with `topic.retired` can persist retired
status without `retire`, and a `provenance` dimension can replace its mapping
with a category string. Canonical identity, provenance and lifecycle requirements
remain normative; they are not protected by this implementation's presentation-only
comment. This inherited gap is separate from archive reuse and does not add a
reserved-dimension rule or authorize rewriting stored records.

#### Known Obsidian archive retention gap

The retention requirements in §A.5, §A.7 and §B.6 remain normative. The bundled
Obsidian adapter does not satisfy them for every sequence of successful operations:
archive destinations are derived from the active category/title path, without a
collision check. After archiving a predecessor, creating and archiving a different
record that reuses that active path can replace the earlier archive file on POSIX
filesystems. This also arises from repeated same-topic consolidation's reused
snapshot titles. The earlier id's path-index entry can then point at the later
record: `get(earlierId)` can return the later id/body/history rather than the original.
A retained index entry or reverse link is therefore not proof that the predecessor's
original bytes remain. This is an inherited implementation gap, not an authorized
purge or a waiver of the supersede-not-delete requirement. The summaries below
refer to the required historical access path with this implementation limit.

Both expose the five types, eight mutations, identity queries and freshness
options above, with the documented implementation gaps. Explicit `link` resolves target ids, but `create`/`update` can
retain supplied links without that target check. Neither operation validates the
truth of linked content. Run the existing parameterized contract and extension
suites against a new adapter, not just the base three-type examples.

All mutation methods MUST throw (or return a rejected Promise) when required evidence is
missing. The thrown error MUST have a `code` property set to `"MISSING_EVIDENCE"` and a
human-readable `message`. This enables the contract suite to distinguish enforcement failures
from unexpected errors. The bundled missing-link-`kind` admission gap (§2.2) does
not meet that requirement; passing the other evidence checks is not full shape
validation.

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
type: <raw|compiled|concept|snapshot|person>
title: <title>
category: <category>
tags: [<tag>, ...]
aliases: [<slug>, ...]        # optional — human-readable, category-scoped (Addendum H)
created_at: <ISO-8601>
updated_at: <ISO-8601>
status: active              # absent on older records means active
expires_at: <optional ISO-8601>
ttl_seconds: <optional seconds>
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

Both bundled adapters read YAML 1.2 syntax with the **failsafe schema**: scalars
remain text, including plain `true`, `null`, numerals and timestamps. This preserves
records written by earlier Kit versions, whose writer did not quote those text
values. The existing freshness decoder converts `ttl_seconds` to a number. This
is not the YAML core schema and does not infer booleans, dates or numbers in
arbitrary evidence. Explicit tags outside the failsafe schema are refused.

The reader resolves anchors and aliases in nested evidence, flow collections and
block scalars. It rejects duplicate keys, unresolved aliases, cycles, malformed
syntax, non-string mapping keys and non-mapping roots. Frontmatter is bounded to
4 MiB, depth 64 and 100,000 visited values; the parser's alias expansion budget
is 100. Reads do not rewrite canonical files. The legacy writer remains separate
from this reader; accepting standard YAML does not certify that every structure
can be round-tripped through that writer.

New writes quote string scalars with the bundled serializer, including dash-led
text and control characters. Earlier writers emitted bare dash-led text such as
`title: - item`. For compatibility, parser-identified dash errors in the record's
string fields (`id`, `type`, `title`, `category`, `status`, timestamps), provenance
`agent`/`session_id`/`note`, link `target_id`/`kind`/`label`, and mutation
`op`/`at`/`agent`/`note` (plus `supersede.rationale` and `superseded-by`'s `new_id`/`rationale`)
are quoted **in memory**, only when the entire scalar
matches what the earlier writer left bare. The same rule covers the built-in
operation's evidence strings: proposal/concept/proposer IDs for `propose`,
rationale for `apply`, reason for `reject`, replacement ID for `superseded-by`,
and status/rationale/implementation/replacement references for `retire`.
Block scalar contents and arbitrary evidence fields are excluded. The whole document then passes through the same
strict parser, duplicate-key, alias, cycle and size checks. Canonical bytes are
never rewritten, and there is no general permissive fallback.

The installed Kit includes a generated, self-contained `yaml` 2.9.0 parser and
its ISC license under `adapters/shared/vendor/`. It requires no ambient npm
installation. Maintainers regenerate it with `npm run knowledge:yaml:generate`;
`npm run knowledge:yaml:check` and the package build refuse stale artifacts.

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

At this extension point, `snapshot` expanded the original three-type envelope to
four values. The current five-type table is §1 (including the later `person` extension):

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
- Automatic consolidation discovers sources only within the snapshot's exact
  category. Category hierarchy is a filing aid, not implicit authority to pull
  a parent or descendant record into a narrower topic.
- A caller may instead supply an ordered `sourceRecordIds` allowlist. The
  allowlist is non-empty and duplicate-free; every id must resolve to an active
  compiled record. It is mutually exclusive with similarity detection and
  incremental append mode.

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
> This is a hard invariant; adapters MUST enforce it. Moving a record to `archive/`
> MUST preserve its bytes and historical access; relocation is distinct from physical
> purge/deletion. A purge policy is a future concern and is explicitly out of scope
> for this version.

**Bundled implementation gap:** Obsidian archive path reuse can overwrite an earlier
predecessor and make `get(earlierId)` return a later record. See the
[archive collision disclosure](#known-obsidian-archive-retention-gap). The invariant
above is not a claim that this implementation already meets every retention case.

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
- The default adapter includes superseded snapshots in `listByType` and
  `listByCategory` subject to lifecycle filters; `{ includeRetired: true }` also
  includes retired predecessors (§B).
- Obsidian archives superseded predecessors out of both listing working sets.
  `includeRetired` does not include archived records. Retrieve their full history
  through `get(id)` and reverse supersession links instead.
- The caller can determine supersession status by inspecting `getLinks(id).reverse` for entries
  with `kind === "supersedes"`.

The Obsidian [archive collision gap](#known-obsidian-archive-retention-gap) can violate
the required original-record retrieval above even when an index entry and links remain.

Supersession is expressed through links and mutation history, separately from
the lifecycle `status` added in Addendum B. There is no archived/deleted status.

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

The two listing methods accept an `includeRetired: true` option to disable the
lifecycle-status exclusion within the adapter's enumerated working set. This
does not disable Obsidian's separate
archive exclusion for superseded predecessors (§A.7).

Both built-in similarity detectors unconditionally exclude retired candidates;
neither exposes an `includeRetired` override. They filter supplied candidates;
they do not fetch records excluded by a store listing.

Retired records remain **fully queryable with provenance**:
- Lifecycle status does not restrict `get(id)`; original-record retrieval remains
  subject to the bundled Obsidian [archive collision gap](#known-obsidian-archive-retention-gap).
- `listByType(type, { includeRetired: true })` and the equivalent category query
  include retired records in the adapter's enumerated working set; Obsidian's
  archived supersession predecessors remain excluded. Use `get(id)` for those.
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
- `listByType(type, { includeRetired: true })` and `listByCategory(category, { includeRetired: true })`
  for records in the adapter's enumerated working set. Obsidian records also
  archived by supersession remain available through `get(id)`, not these listings.
- Snapshot `provenance.source_ids` — any snapshot that included the record in its cluster before
  retirement retains the reference intact. The retired record can be retrieved via `get(sourceId)`.
- The retirement `mutation_log` entry carries the full evidence of why and when the record was
  retired and by whom.

These are normative retention requirements. The bundled Obsidian
[archive collision gap](#known-obsidian-archive-retention-gap) can violate full-record
retrieval and original-byte retention; a surviving source id or graph link does not
cure it. No deletion or overwrite of retained records is authorized. Physical purge
(if ever needed) is a separate, future policy hook not defined in this version.

### B.7 Proposal-Artifact Lifecycle (close-on-apply)

The `knowledge.retire` flow mints a transient **retirement-proposal artifact**:
a `raw` record (`"Retirement proposal: <title>"`) that carries the `"proposes"`
link and proposal text to the target. The close-on-apply behavior below is specific
to that generated artifact. Synthesis and consolidation use existing compiled
source records as proposers; they do not auto-retire those records on apply.

Once the proposal has been **applied**, that artifact is *spent*. It MUST NOT be left as an
`active` record:

- A lingering active artifact pollutes the default working set (`listByType` / `listByCategory`)
  and is re-surfaced by hygiene sweeps.
- Hand-retiring it spawns a double-prefixed twin
  (`"Retirement proposal: Retirement proposal: …"`), because the retire flow mints a *new*
  proposal artifact for the artifact itself (#106).

**Rule.** On `apply` (and only on `apply`), the retirement flow attempts to close its spent
proposal artifact by **retiring it via the existing `retire` op** (§B.4). There is no separate
"close" mutation; the close reuses `retire`. This close is:

- **safe** — it touches only the named artifact, never the apply target;
- **idempotent for missing/retired artifacts** — these are skipped. An active or implemented
  artifact is passed to `retire(..., "retired", ...)`; implemented is not a no-op (§B.2);
- **non-fatal for caught artifact-retirement failures** — if the artifact read succeeds
  but its `store.retire` rejects, the helper catches that error and the outer result
  reports `proposalClosed: false`. The public result does not expose the helper's
  full error reason.

**Current containment limit:** the preliminary `store.get(artifactId)` is outside
the helper's catch. If that read rejects, the outer retirement call can reject
with no `proposalClosed` result after the target's retirement has already succeeded.
The spent-artifact lifecycle requirement remains; the implementation does not
contain every cleanup error.

**`reject` is unchanged.** A rejected retirement proposal is *not* spent — its artifact remains
`active`. Closing happens only on the retirement apply path.

The retirement flow handles its own artifact's closure; hand-retiring it through
the flow would create another retirement proposal. Inspect `proposalClosed` on a
returned result; a rejected cleanup read has no such result and does not imply the
target mutation was rolled back. This does not define automatic closure for every proposer.

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
  `store.supersede(primaryId, [duplicateId])` to supersede the duplicate without deleting it.
  Obsidian moves it to `archive/`; the default adapter retains it in place, subject to query filters.
- **reject**: both bodies and tags are preserved, but the records are not byte-identical.
  The initial proposal adds a duplicate-to-primary `proposes` link and mutation history;
  rejection appends history on the primary. Timestamps/history/links can therefore change.

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
entry `at`. They are not both refreshed by every mutation: rejection, target-side
proposal history and superseded-predecessor history can preserve `updated_at`
while appending a newer log entry. The audit uses the maximum of the available
update/log timestamps and falls back to `created_at` when neither is present.

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
records that had a resolvable threshold **or a record-carried expiry**, `skipped` counts opt-out
categories (no threshold *and* no expiry), and `flags` lists the stale records. Gate telemetry is
emitted at `collect-gate` and `flag-gate` (`knowledge.audit-freshness`).

**Extension (#341, Addendum J).** A record that carries its own `expires_at` / `ttl_seconds` is
flagged when now is at or past that expiry — **without** any caller-supplied threshold. Such an
expiry flag cites the expiry it fired on: it carries `reason: "expiry"`, `expiresAt` (the effective
expiry, ISO-8601), `matchedThresholdKey: "expires_at"`, and `thresholdDays: null` (an expiry cites a
timestamp, not a day-count). Threshold-driven flags (Addendum D above) carry `reason: "threshold"`
and are otherwise unchanged. The expiry path takes precedence over the threshold path for a record
that is past both.

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

**Known bundled pair-key omission:** each similar unordered pair is required to
reach the contradiction detector, but the runner deduplicates lexically sorted
ids using the unescaped key `idA + "|" + idB`. Distinct pairs (`a`, `b|c`) and
(`a|b`, `c`) share `a|b|c`. With four ordinary active compiled records of those ids
in one category on the current POSIX host, default similarity can select all six
pairs, while the runner invokes an injected always-flagging contradiction detector
only five times. The skipped pair contributes neither `compared` nor a flag.
This is separate from link-key deduplication (§2.2); opaque ids and per-pair
processing remain required, with no reserved `|` rule or runtime repair implied.
Absence of a flag is not proof that every similar pair was judged.

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
actually judged, and `flags` lists the reported conflicting pairs. The pair-key gap
in §G.2 can omit a distinct similar pair before either the comparison count or
detector call, so these counts do not establish complete pair coverage. Gate telemetry is emitted at `collect-gate` and
`flag-gate` (`knowledge.detect-contradictions`).

## Addendum H — Record Identity Resolution (short-id prefix + slug aliases, #339)

### H.1 Motivation

On-disk identity is a full `id` (§1.1) plus a file path (§9). Prose that cites a record — a
curated doc, a commit message, an issue comment — cannot practically carry a full 36-char UUID, so
the field partner cites **8-char short ids** (`a1b2c3d4`, `b2c3d4e5`) and would prefer
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
The default adapter's [path-normalized identity gap](#known-default-store-path-normalized-identity-gap)
can violate this required envelope-id model by using normalized filename existence
and filename-derived prefix candidates instead.

### H.3 Resolution Outcomes

| Situation | `get` | `getLinks` |
|---|---|---|
| Resolves to exactly one record | returns that record | returns that record's `{ forward, reverse }` |
| Resolves to nothing (no exact id, no alias, no ≥8-char single-match prefix) | returns `null` | reads the literal input graph key; empty arrays only if it has no indexed links |
| Prefix (≥8 chars) matches **more than one** record | **throws `AMBIGUOUS_ID`** | **throws `AMBIGUOUS_ID`** |

An `AMBIGUOUS_ID` error MUST have `code === "AMBIGUOUS_ID"`, a human-readable `message`, and a
`matches` array of the colliding full ids. An ambiguous prefix MUST NOT be silently resolved to one
arbitrary record, nor collapsed to `null` — ambiguity is a distinct, surfaced condition.

The bundled [graph-key handling gap](#known-bundled-graph-key-handling-gap) can
instead raise `TypeError` for prototype-named keys, whether resolved or used as a
literal fallback. The required structured result above is not a claim that those
current implementation cases already conform.

A `handle` **shorter than `MIN_ID_PREFIX`** is never treated as a prefix (it can still match an
exact id or a slug). This keeps a stray short token from matching a large, surprising set.

### H.4 Slug Aliases

- A slug is a lowercase, category-scoped, human-readable handle, e.g.
  `decision.design/2026-01-01-api-shape`. It MUST match
  `^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$` (≤ 200 chars). Malformed slugs are rejected at
  `create`/`update` with `MISSING_EVIDENCE`.
- Slugs are **caller-supplied** via the optional `aliases: string[]` field on `create` and
  `update`. The store does **not** auto-derive slugs (auto-slugging is a future concern) — the
  date-stamped examples cannot be derived from title alone.
- Aliases are **append-only**: `update` with an `aliases` field UNIONs the supplied slugs with the
  record's existing aliases; it never drops a previously issued slug. This is what guarantees H.5.
- A slug already assigned to a *different* record is a `SLUG_CONFLICT` (a slug identifies at most
  one record). Re-supplying a record's own slug is an idempotent no-op.

**Known bundled alias-registration gap:** `constructor` is a valid unused slug
under the declared syntax, but both adapters can reject it with `SLUG_CONFLICT`
on a fresh store or when adding it through `update`. The shared alias map uses
an ordinary object and reads `by_slug[slug]` without an own-property check; the
inherited Object constructor is treated as an existing owner. No record actually
owns that alias in this case. This differs from the graph-array gap in §7 and
from a genuine alias collision. The syntax and genuine-conflict requirements above
remain normative; this disclosure does not reserve or prohibit the alias.

### H.5 Restructure Survival (the alias map)

The alias map is a store-level structure `{ slug → id }`: each slug key maps to a
**full record id**, rather than a category or file path. Therefore:

- Recategorizing a record via `update` (which, in the Obsidian adapter, **relocates the note's
  file**) leaves both the `id` and the `slug → id` mapping untouched.
- The id still resolves (it is the record's stable key); the short-id prefix still resolves (it is
  a prefix of that unchanged id); the slug still resolves (the map still points it at that id).

So a previously issued short-id prefix or slug MUST still resolve to the same record after a
restructure. The default adapter's path-normalized identity gap above can already
violate stored-id prefix resolution for successfully created path-like opaque ids. Note the slug is a **stable alias**, not a value recomputed from the current category:
a slug minted under `decision.design/…` keeps resolving even after the record moves to
`decision.design`.

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
curated docs — `status.md`, `docs/*.md`, a roadmap — cite **into** the store. A store restructure
that re-files or retires a record silently severs every inbound doc citation, and every existing
gate still reports PASS. The motivating failure was a consumer's repository
check remaining green while curated documents cited unresolvable short ids.
This addendum adds a citation-resolution check; the marker limitations below
remain explicit.

The check is a **read-only** flow (`KnowledgeFlowRunner.checkInboundReferences`) in the style of the
Addenda D–G audits: it mutates no record, appends no mutation-log entry, and forks no mutation path.
It resolves citations through the unchanged Addendum H identity path — it adds no new query surface.

### I.2 Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `docGlobs` | string[] | `[]` | Globs (relative to `docsRoot`) whose matching docs are scanned. **Empty = opt-in no-op pass** (Addenda D–G convention). Supports `*` (within a segment), `**` (across segments), `?`. |
| `docsRoot` | string | per-call `workspace` for the direct instance checker, otherwise `cwd` | Root the globs resolve against. Supply explicitly when intended docs differ from cwd; constructor workspace and the module-level wrapper do not supply the scan default. |
| `markers` | string[] | `["rec:", "record:"]` | Citation-marker prefixes that opt a following short-id/slug into **definite** citation status (I.3). |

**Scan-root implementation boundary:** direct
`runner.checkInboundReferences({ workspace: ... })` honors that call's workspace
when `docsRoot` is absent. The runner does not retain its constructor workspace
for scanning; the module-level `checkInboundReferences` wrapper consumes its
`workspace` as a constructor option without forwarding it to the scan. Use an
explicit `docsRoot` for that wrapper. `flagSupersededCiters` forwards `docsRoot`,
not workspace, to its checker (§K.2). A wrong-root glob can match no files and
produce `ok: true` from an empty unresolved list; inspect `scanned` as well as
`ok`. Empty globs remain an explicit no-op, not scan coverage.

### I.3 Citation Forms — the commit-SHA precision problem

A bare 8-hex token is inherently ambiguous: `a1b2c3d4` is equally a record short-id and an
abbreviated git commit SHA. Failing on every non-resolving 8-hex token would flag every SHA in prose
(the gate cries wolf and gets muted); never failing on them re-opens the exact rot this closes. The
check resolves the tension with **two tiers**:

**Definite citations** — unmistakably a record reference, so resolved regardless of whether they
currently resolve, and an unresolved one **FAILS** (fail closed):

| Form | Example | Why it is SHA-safe |
|---|---|---|
| Full UUID (8-4-4-4-12 hex) | `aaaaaaaa-1111-4111-8111-111111111111` | The hyphenated shape never collides with a git SHA (40/abbrev hex, no hyphens) or prose. |
| Marker + token | `rec:a1b2c3d4`, `record:decision.design/api-shape` | The marker is explicit intent; the token may be a short-id or slug. |
| Wikilink | `[[decision.design/api-shape]]` | The kit's own link syntax. |

**Candidate bare short-ids** — a standalone ≥8-hex token with **no** citation form is included in
the index **only when it already resolves** to a record. A non-resolving bare hex is indistinguishable
from a commit SHA, so it is **ignored** — never indexed, never failed. Ambiguous
bare candidates are likewise ignored. A bare hash that resolves to a record handle
is indexed as a citation, even when its author meant a Git commit; the heuristic
does not determine author intent. Such a collision can also make propagation flag
the sentence as a doc citer.

> **Deliberate, documented miss.** A *broken* bare-hex short-id (no marker/wikilink) is invisible to
> the check — by construction, since it does not resolve. This is a precision-over-recall choice:
> ignoring non-resolving/ambiguous commit-hash candidates avoids failures for those
> hashes, but does not provide universal zero-false-positive precision when a hash
> resolves to a record. Broken bare-hex short-id rot is missed until the doc adopts
> a citation form. To get fail-closed protection for a short-id or slug, cite it in a
> marker or wikilink form; full-UUID citations are protected with zero configuration. Migrating a
> consuming repo's house style to a marker is a consumer-owned change (a non-goal here).

Every extracted token is resolved via `get(token)` (Addendum H: exact id → slug alias → unambiguous
≥8-char prefix). For definite citations, `null` is unresolved and a caught
`AMBIGUOUS_ID` is reported with `reason: "ambiguous"` (fail closed — it does not
uniquely resolve). Non-resolving or ambiguous bare candidates are dropped instead,
as described above.

### I.4 Fail-Closed Semantics

The result's `ok` is `true` **iff** `unresolved` is empty — i.e. every definite citation resolved. A
consumer that uses this as a required check treats `ok === false` as a gate failure. Each `unresolved` entry names
`doc`, `line`, `column`, `token`, `form`, and `reason` so the break is actionable. An empty scan with
configured globs that cite nothing is a pass; an empty scan from **no** globs is the explicit opt-in
no-op — neither is an "empty success" that masks an unresolved definite citation.

### I.5 Citation Index (result shape)

The result exposes the full citation index so downstream flows (supersede/retire propagation) can
enumerate citers:

```json
{
  "ok": false,
  "scanned": ["status.md", "docs/design.md"],
  "citations": [
    { "doc": "status.md", "line": 3, "column": 17, "token": "aaaaaaaa-1111-4111-8111-111111111111",
      "form": "uuid", "resolved": true, "recordId": "aaaaaaaa-1111-4111-8111-111111111111" }
  ],
  "unresolved": [
    { "doc": "status.md", "line": 5, "column": 9, "token": "deadbeef-0000-4000-8000-000000000000",
      "form": "uuid", "reason": "not-found" }
  ],
  "byDoc":    { "status.md": [ { "token": "…", "form": "uuid", "resolved": true, "recordId": "…", "line": 3, "column": 17 } ] },
  "byRecord": { "aaaaaaaa-1111-4111-8111-111111111111": [ { "doc": "status.md", "line": 3, "column": 17, "token": "…", "form": "uuid" } ] }
}
```

- `citations` — every recorded citation (definite ones, plus bare candidates that resolved).
- `byDoc` — doc → its cited record ids (every scanned doc appears, even if it cites nothing).
- `byRecord` — record id → its citers (the doc→record edge; a natural typed edge under #317).

**Known bundled citation-index key gap:** these result maps use ordinary objects
and assume bracket lookups are own arrays. After successful `get` resolution of
an accepted opaque id such as `constructor` or `toString`, adding its citer to
`byRecord` can throw a plain `TypeError` at `.push`. A wikilink to `__proto__`
exposes the same class of issue. The `byDoc` map also has this assumption: a scanned
extensionless file named `constructor` can throw when it has a citation, or retain
an inherited function rather than an own empty array when it has none. This is a
runner result-indexing gap independent of `getLinks`, alias admission, scan-root
selection and telemetry. The opaque-id and structured-result requirements remain;
no reserved ids or filenames are introduced. A conforming adapter's `get` alone
does not ensure this bundled checker can index every supported key.

### I.6 Conformance

An adapter conforms to this addendum when the inbound-reference suite
(`evals/inbound-references/suite.test.js`) passes against it — AC1 (three forms extracted +
resolved), AC2 (fail closed on a nonexistent id; no-op pass with no globs), AC3 (read-only), and the
commit-SHA-safety case. The suite is parameterized by `KNOWLEDGE_ADAPTER`, so conformance is required
of every adapter (AC4). The check reuses `get` and requires no new adapter storage,
but the bundled result-map key gap above is a separate runner conformance limit;
Addendum-H conformance alone does not eliminate it.

---

## Addendum J — Record Freshness & Status Semantics (Hachure alignment, #341)

### J.1 Motivation — no silent rot for our own knowledge

The store is strong at *filing* and, since Addendum D, at *auditing* staleness — but staleness lived
entirely in the auditor's call: thresholds are supplied per invocation, so freshness intent lived in
whoever remembered to pass the right options, not on the record. A record could not say "I go stale
on 2026-09-01"; the only freshness mechanism for a long-lived store was a human remembering to run an
audit with the right numbers. A maintenance comment such as `prune monthly` carries
no executable expiry; knowledge can become stale between audits.

Meanwhile Kontour already owns a trust vocabulary for exactly this — **Hachure**: `expiresAt` /
`ttlSeconds`, statuses `unknown / proposed / verified / stale / superseded`, and the "no silent rot"
principle. This addendum makes the knowledge store **eat that vocabulary**: records carry their own
expiry and go *visibly* stale under the same semantics our trust bundles use. It **aligns** with
Hachure's vocabulary and semantics — it does **not** import Hachure's schema or take a format
dependency (a non-goal). Ephemeris integration and automatic re-verification / auto-retirement are
also non-goals: this addendum **flags**; the operator routes a flag through `knowledge.retire` or a
fresh capture/compile, exactly as Addendum D established.

### J.2 Record-carried freshness fields

Two **optional** envelope fields (§1.1), round-tripped by every adapter through the shared codec:

| Field | Type | Meaning |
|---|---|---|
| `expires_at` | ISO-8601 string | Absolute instant the record expires. |
| `ttl_seconds` | number (> 0) | Relative expiry: `created_at + ttl_seconds`. |

- Both are settable at `create` and via `update` (they are mutable fields; `update` records them in
  its mutation-log `fields` evidence like any other). Supplying either as `null` / `""` on `update`
  **clears** it.
- `expires_at` MUST use the ISO-8601 representation above. **Current implementation
  limit:** bundled validation checks a nonempty string and `Date.parse` parseability,
  not strict ISO syntax, and stores the accepted string unchanged. For example,
  `Thu, 01 Jan 2026 00:00:00 GMT` is accepted despite not being ISO-8601. Non-string,
  empty or unparseable expiry inputs (apart from the clearing values above), and
  non-positive/non-finite `ttl_seconds`, are rejected with `MISSING_EVIDENCE`.
  Parseability does not establish conformance to the required ISO representation.
- **Effective expiry** = `expires_at` when present, else `created_at + ttl_seconds`. An explicit
  `expires_at` therefore **takes precedence** over `ttl_seconds`.
- **Backward compatibility (R5):** a record carrying neither field has `null` effective expiry and is
  never derived `stale` via the expiry path — it behaves exactly as before this addendum.

### J.3 Derived states — `stale` and `superseded`

`stale` and `superseded` are **derived**, never stored. They are computed on read/query and **never**
mutate the record's `status` (Addendum B) or any other field. "No silent rot" means a record becomes
*visibly* stale under query — not that the store silently rewrites it.

- **`stale`** — the record's effective expiry exists and now is **at or past** it. The boundary is
  **inclusive**: a record `expires_at: T` is stale from `T` onward (`now >= T`). A record may also be
  surfaced as stale by `auditFreshness` (Addendum D + J.5). Derivation never changes the record.
- **`superseded`** — the graph-derived state is detected from an incoming `supersedes`
  edge (`getLinks(id).reverse`). A successful Addendum A.5 `supersede` operation pairs that
  edge with a `superseded-by` mutation-log entry on the predecessor and the adapter's
  retention behavior: in place (default) or archived (Obsidian). That paired edge/history
  invariant is the operation's contract; supersession is not a stored `status` value.

  **Current evidence limit:** both bundled adapters also accept caller-authored
  `supersedes` links through `create`, `update`, and `link`. An incoming edge alone can
  therefore produce the graph-derived state without a `supersede` operation, a
  `superseded-by` log entry, or Obsidian archival. Inspect operation history separately;
  the edge is not proof that the operation's full invariant ran.

### J.4 Hachure vocabulary alignment

The kit keeps **two orthogonal record axes**. Neither is a verification authority:

1. **Lifecycle status** (stored; mutated only by `retire`, Addendum B): `active` / `implemented` /
   `retired`.
2. **Freshness/derivation state** (derived; never stored): `fresh` / `stale` / `superseded`.

The bundled Surface projection (`providers/surface-adapter/index.js`) submits
`superseded` for retired records and `proposed` for all other record statuses.
It forwards `expiresAt` / `ttlSeconds` for Surface to derive freshness. A stored
assertion can therefore be proposed without an open `proposes` link. The store's
derived supersession edges are also distinct from its stored lifecycle status.

No record is marked `verified` by this projection. Active status, lack of expiry,
creation provenance, type labels and successful storage do not establish truth
or independent review. Hachure/Surface verification and trust derivation remain
their own authority; this record model does not replace them or map "fresh" to
"verified". A local `auditFreshness` flag is a hygiene observation, not a trust verdict.

`retired` (kit) has no Hachure freshness equivalent — it is a **terminal lifecycle decision**,
orthogonal to freshness. Retired records are excluded from the default working set (Addendum B.3) and
so from stale-filtered listings. `includeRetired` affects only the enumerated
working set (§B.3); Obsidian's archived predecessors remain excluded from listings.
The required history path is `get` with reverse supersession links through
`getLinks` (§A.7); the bundled Obsidian [archive collision gap](#known-obsidian-archive-retention-gap)
can violate original-record retention despite surviving links.

### J.5 Query surface

- **`listByType(type, { stale: true, now? })`** and **`listByCategory(category, { stale: true, now?, prefix?, includeRetired? })`** return only records whose effective expiry is at or past `now` (default `Date.now()`; `now` is injectable for deterministic tests). Absent `stale` → unchanged
  behaviour. The staleness filter composes with the existing status filter (retired still excluded by
  default).
- **`auditFreshness`** (Addendum D.2/D.3) additionally flags a record past its **own** `expires_at`
  with **no** caller-supplied thresholds, each such flag citing the expiry as the threshold that
  fired (`reason: "expiry"`, `expiresAt`, `matchedThresholdKey: "expires_at"`, `thresholdDays: null`).
  Record-carried expiry thus **complements** Addendum D's caller-supplied thresholds rather than
  replacing them.
- **`superseded`** is queried via the existing `getLinks(id).reverse` surface (J.3) — no new storage
  or list method; it works uniformly across adapters.

### J.6 Conformance

An adapter conforms to this addendum when the freshness suite
(`evals/freshness/suite.test.js`) passes against it: `expires_at` / `ttl_seconds` round-trip through
`get`; expiry transitions (past → stale, future → not, inclusive boundary, no-freshness-fields →
never stale) hold; `{ stale: true }` listing returns exactly the expired records; and a superseded
record is queryable as superseded. The suite is parameterized by `KNOWLEDGE_ADAPTER`, so conformance
is required of every bundled adapter. Backward compatibility (R5) is covered by the unmodified
`contract-suite`, `audit-freshness`, and `retirement` suites continuing to pass.

---

## Addendum K — Supersede/Retire Citer Propagation (flag inbound citers, #342)

### K.1 Motivation

The `supersede` op (Addendum A.5) and the `retire` op with `supersededByRef` (Addendum B.4) preserve
the affected record (supersede-not-delete / retire-not-delete) and make **store-internal** citers
discoverable via the reverse-link index (§5, `getLinks(id).reverse`). But nothing enumerated or
flagged the **docs** citing a superseded record — so a superseded decision could leave every citer
silently pointing at dead or outdated authority.

The motivating failure was a restructured decision store leaving several
curated documents pointing at an unavailable or superseded record as live
authority. This addendum enumerates first-degree inbound citers from **both**
indexes and emits a supersession-aware flag per citer.

This is a **read-only** enumeration in the hygiene-flow style (Addenda D–G): the existing gated
`supersede` and `retire` ops are unchanged, and no new mutation path is forked. It does **not**
auto-edit citing docs, does **not** cascade status changes, and does **not** follow citers-of-citers
(first-degree only). Fixing a citation is the operator's or a downstream flow's gated action.

### K.2 `flagSupersededCiters` Flow-Runner Operation

`KnowledgeFlowRunner.flagSupersededCiters(recordId, options)` (also the module-level
`flagSupersededCiters(recordId, { store, ... })`):

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `docGlobs` | `string[]` | `[]` | Globs to scan for doc citers via the #340 citation index. Opt-in: `[]` = store citers only, no doc scan. |
| `docsRoot` | `string` | `cwd` | Root the globs resolve against. Supply explicitly when docs differ from cwd; neither constructor nor per-call workspace is forwarded to the doc scan (§I.2). |
| `markers` | `string[]` | `DEFAULT_CITATION_MARKERS` | Citation marker prefixes forwarded to the inbound-reference scan (Addendum I). |
| `agent` | `string` | runner agent | Agent recorded on the flow telemetry. |

`recordId` accepts a full id or any Addendum-H handle (short-id prefix / slug alias); the returned
`recordId` is the resolved full id. A record that does not exist throws (`MISSING_EVIDENCE`) — never a
silent empty pass.

**Supersession evidence** (at least one is required for any flag to be emitted):
- **supersede op** (A.5): a reverse link of kind `"supersedes"` from the superseding record, mirrored
  by a `"superseded-by"` mutation-log entry carrying `new_id`. Both sources are read; their union is
  `supersededByIds`.
- **retire-with-supersededByRef** (B.4): a `"retire"` mutation-log entry whose
  `evidence.supersededByRef` names the superseding artifact; surfaced as `supersededByRef` (and
  `retiredStatus: "retired"`).

**Citer enumeration** (first-degree only):
- **store records** — `getLinks(id).reverse`, EXCLUDING the `"supersedes"` link itself and any link
  originating from a superseding record (the replacement authority is not a silent dead citer). Every
  other inbound link is a citer, tagged with its `linkKind`.
- **docs** — `checkInboundReferences({ docGlobs, ... }).byRecord[id]` (Addendum I). The superseded
  record is preserved, so its citations still resolve. Opt-in via `docGlobs`.

### K.3 Flag Evidence Guarantee

Every flag carries the superseding context that produced it — the flag-gate refuses to emit a flag
without it. Consequently a record with **no** supersession evidence yields `superseded: false` and an
**empty** flag list (no false flags, fail closed); a superseded record with no citers likewise yields
an empty flag list. The enumerated citer counts (`storeCiters` / `docCiters`) are reported regardless
of gating, so a caller can see the inbound edges independent of supersession state.

```ts
interface SupersededCiterFlag {
  citerRef: string;              // record id, or "doc:line:column"
  citerKind: "record" | "doc";
  citedId: string;               // full id of the superseded / retired record
  supersededByIds: string[];     // superseding record id(s) from the supersede op
  supersededByRef: string | null; // the retire supersededByRef, when present
  // record citer:
  linkKind?: string;             // the reverse link kind that made it a citer
  // doc citer (from the #340 citation index):
  doc?: string; line?: number; column?: number; token?: string; form?: string;
}
```

`flagSupersededCiters` returns:

```ts
{
  recordId: string;              // resolved full id
  superseded: boolean;           // whether supersession evidence exists
  supersededByIds: string[];
  supersededByRef: string | null;
  retiredStatus: "retired" | null;
  storeCiters: number;           // count from the reverse-link index
  docCiters: number;             // count from the citation index (0 when no globs)
  flags: SupersededCiterFlag[];  // gated by the evidence guarantee
  telemetryEvents: object[];
}
```

Gate telemetry is emitted at `collect-gate` and `flag-gate` (`knowledge.flag-superseded-citers`);
when doc globs are configured, the folded `knowledge.check-inbound-references` gate events (Addendum
I) also appear in the trail.

### K.4 Read-Only Invariant

`flagSupersededCiters` reads the store's query surface (`get`, `getLinks`) and — when doc globs are
configured — the #340 inbound-reference scan (doc files + `get`). It mutates no record and appends no
mutation-log entry. It does emit gate telemetry: runner construction can create the
sink directory, and normal gate events append to
`<workspace>/.kontourai/telemetry/full.jsonl` (workspace falls back to
`FLOW_AGENTS_WORKSPACE`, then cwd). Whole-store-tree byte identity requires keeping
that sink outside the store tree and excluding unrelated concurrent changes.
Using the store root as workspace can change telemetry bytes inside it without
mutating any knowledge record, graph link or mutation history. The same telemetry
boundary applies to the inbound-reference checker; read-only describes its
knowledge-record behavior, not an absence of filesystem output.

### K.5 Conformance

An adapter conforms to this addendum when the supersede-propagation suite
(`evals/supersede-propagation/suite.test.js`) passes against it — AC1 (store-record + doc citer
enumerated from the two indexes), AC2 (every flag carries citer ref + cited id + superseding context;
superseded-with-no-citers and non-superseded both yield zero flags), AC3 (read-only), and the
retire-with-supersededByRef path. The suite is parameterized by `KNOWLEDGE_ADAPTER`, so conformance is
required of every adapter (AC4). Because it reuses `get`/`getLinks` and the Addendum-I check, any
adapter conforming to Addenda A, B, H, and I satisfies it without new storage.

---

## Addendum L — Incremental Consolidation (append mode, #343)

### L.1 Problem: whole-body consolidate is heavy enough that sessions skip it

The `knowledge.consolidate` flow (Addendum A) originally accepted only a **whole-body** input:
the caller authored the *entire* updated snapshot body (`options.proposedBody`) and the runner
replaced the snapshot with it. To add one decision, the caller had to re-read and re-emit every
prior entry. Repeating that work can cause callers to skip consolidation and
leave a decision snapshot stale. Append mode addresses that maintenance burden;
it does not establish a measured time or cost saving.

The snapshot already links its contributing compiled records with kind `"source"` and carries
`provenance.source_ids` (Addendum A.3), so the body is *derivable from records*. Append mode uses
that: the caller supplies only the new contribution and the runner regenerates the body.

### L.2 Append-mode input

`KnowledgeFlowRunner.consolidate(snapshotIdOrTopic, options)` accepts, as an alternative to
`options.proposedBody`, an **appended entry** identifying the new compiled record:

| Option | Type | Description |
|---|---|---|
| `appendEntryRecordId` | `string` | Id of the new **compiled** record to append (the appended entry). `appendEntry: { recordId }` is an accepted equivalent shape. |
| `header` | `string` (opt) | Body header prepended before the rendered entries. |
| `entryRenderer` | `(record) => string` (opt) | Pluggable per-entry renderer. Default renders a decision-log section: `## <title>\n\n<body>`. |

`proposedBody` (whole-body mode) and the append options are **mutually exclusive**; supplying
both throws `MISSING_EVIDENCE`. The appended record MUST exist and be type `"compiled"`
(otherwise `MISSING_EVIDENCE`).

### L.3 Body regeneration

On an append-mode call the runner:

1. With a topic selector, resolves the **current** (non-superseded) snapshot for that topic.
   With an explicit snapshot-id string, reads that snapshot directly; it does not follow
   successors or check that the selected snapshot is still current.
2. Reads that snapshot's contributing records: `provenance.source_ids` first, falling back to its
   kind `"source"` links (Addendum A.3).
3. Forms the new source set = *prior sources* ++ *appended entry*, de-duplicated with order
   preserved (re-appending the same record is idempotent — no duplicate source id).
4. Regenerates the body by rendering **every** source record in order (`entryRenderer`, joined by a
   `---` rule, optional `header`). The caller never supplies prior content.

The regenerated body then flows through the *unchanged* consolidate machinery
(propose → evidence-gate → apply-or-reject, Addendum A.5): a new snapshot is created with the
regenerated body, `provenance.source_ids` and kind `"source"` links covering every contributing
record **including the new one** (R3), and the prior snapshot(s) are superseded, not deleted.

### L.4 Back-compat

Whole-body mode is unchanged: existing callers passing `options.proposedBody` work exactly as
before, and `evals/consolidation/suite.test.js` passes unmodified. Append mode is purely additive
— it changes how the effective body and source cluster are *computed*, not the gate shape, the
supersede-not-delete invariant (A.5), or the telemetry gate points.

### L.5 Sequential-session safety (no lost update)

Sequential append safety requires each call to use the **current live snapshot's** source
set. With a topic selector, the second of two sequential consolidations resolves the first
session's snapshot and appends to its larger source set, preserving both contributions.
The same condition holds when a caller supplies the actual current snapshot id.

**Current explicit-id limit:** the runner accepts a retained older snapshot id without
refreshing it. If S0 contains X, appending A via S0 can produce S1 containing X+A;
appending B via S0 again can produce X+B and supersede S1. Supersession is required
to retain history (subject to the bundled Obsidian archive gap above), but the current
snapshot omits A. The no-lost-update requirement is not enforced for stale
explicit ids, and sequential topic selection does not establish concurrent-update safety.

### L.6 Conformance

An adapter conforms when the incremental-consolidation suite
(`evals/consolidate-incremental/suite.test.js`) passes against it. The suite is parameterized by
`KNOWLEDGE_ADAPTER`; the sequential topic-selector no-lost-update case (R4) and the provenance/source-link completeness case
(R3, asserted via the portable `get()` + reverse-`supersedes`-link guarantees of A.7) are required
of every adapter. The default-store's additional guarantee that `listByType("snapshot")` still
returns superseded snapshots is covered for that adapter by `evals/consolidation/suite.test.js`
(the Obsidian adapter archives superseded snapshots out of the working set; both are
required to retain `get()` access, but the Obsidian archive collision gap above can
violate that requirement).
