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

## Contract Summary

See [`store-contract.md`](store-contract.md) for the full specification. Quick reference:

**Record types**

| Type | Purpose |
|---|---|
| `raw` | Unprocessed source material — excerpts, transcripts, URLs with notes. |
| `compiled` | Normalized, editor-reviewed distillations of raw records. |
| `concept` | Named ideas or principles that other records reference. |
| `snapshot` | Bounded decision summary for a topic (Addendum A). |

**Record status lifecycle**

| Status | Meaning | Default |
|---|---|---|
| `active` | Live, part of the working set. | Yes (records without status field are treated as active). |
| `implemented` | Decision was shipped; transitional state before archival. | No |
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
| Full id | `12cc5573-1c4f-4a0e-8b6e-9d2f0a5b7c31` | the record (unchanged exact-id behavior) |
| Slug alias | `decision.strategy/2026-07-03-gtm-direction` | the record that carries that alias |
| Short-id prefix (≥ 8 chars, unique) | `12cc5573` | the single record whose id starts with it |

Aliases are caller-supplied via the optional `aliases: string[]` field on `create`/`update`,
append-only, and stored in an id-keyed alias map (`alias-index.json`) so a prefix or slug **still
resolves after a store restructure** (e.g. a recategorize that moves the file). An unresolved
handle returns `null` (`get`) / empty arrays (`getLinks`); an **ambiguous** prefix throws
`error.code === "AMBIGUOUS_ID"` — it is never silently guessed. On-disk identity (`records/<id>.md`)
is unchanged.

| Error code | Raised when |
|---|---|
| `AMBIGUOUS_ID` | an id prefix matches more than one record (carries a `matches` array) |
| `SLUG_CONFLICT` | a supplied slug alias is already assigned to a different record |

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
| AC1 | Contract doc exists; mutation ops enumerate evidence fields. | [`docs/store-contract.md`](store-contract.md) — §6 covers all six ops with required-field tables. |
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

Located at `adapters/default-store/index.js`. Zero runtime dependencies; uses Node.js
built-ins only.

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
- `getLinks(idOrHandle)` → `Promise<{ forward: Link[], reverse: Link[] }>`
- `listByCategory(category, options?)` → `Promise<Record[]>`
- `listByType(type)` → `Promise<Record[]>`

---

## Flow

The kit ships these flows:

**`knowledge.store-contract`** — gates on three evidence claims before a store implementation
is accepted: contract-suite pass, provenance-enforcement pass, and round-trip integrity pass.
S2 will add pipeline flows for raw ingestion, compilation, and concept management; this flow
and adapter infrastructure remain the foundation.

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

---

## Decision Lifecycle — Retiring Records (S7)

Implemented or obsolete records can be retired from the working set via the `knowledge.retire`
flow. Retirement is **non-destructive**: the record body, links, and creation provenance remain
intact; the record is simply excluded from the default working set.

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

Add `{ includeRetired: true }` to any query to restore retired records.

`get(id)` **always** returns the full record regardless of status.

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
// Always works — returns full record including retirement evidence
const record = await store.get(retiredId);
console.log(record.status);           // "retired"
console.log(record.mutation_log);     // includes retire entry with rationale

// Query all retired records of a type
const allCompiled = await store.listByType('compiled', { includeRetired: true });

// Get history from snapshot provenance
const snapshot = await store.get(snapshotId);
for (const srcId of snapshot.provenance.source_ids) {
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

The vector detector throws an `Error` with `code="EMBED_FAILURE"` rather than returning `[]`
when the embedding call fails (network error, HTTP error, malformed response, wrong vector
count). This is intentional.

A detector that silently returns `[]` on infrastructure failure is indistinguishable from one
that found no similar records. The result is a misleading `MISSING_EVIDENCE` at the detect-cluster
gate, which looks like "this concept has no sources" rather than "the embedding service is down".

Failing closed makes the infrastructure problem visible immediately, at the right level, with a
clear error code. Operators can catch `EMBED_FAILURE` separately from `MISSING_EVIDENCE` and
route them to different alerting channels.

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

The `neo4j` provider is a real, queryable graph implementation of the store
provider read interface (issue #327). It is the **owner's opt-in personal
default** — the file providers (`markdown-vault`, `git-repo`, `work-item`) remain
the portfolio default. The graph is a **materialized view** synced from those
providers: the file stores stay the source of truth, and the write side stays
proposals-only. `neo4j-driver` is an optional dependency; with no Neo4j reachable
everything degrades to the file providers with a clear message — it is never a
hard dependency.

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
import { WorkItemProvider } from "./kits/knowledge/providers/work-item/index.js";
import { syncToNeo4j } from "./kits/knowledge/providers/neo4j/index.js";
import { resolveNeo4jConfig, createDriver } from "./kits/knowledge/providers/neo4j/index.js";

const driver = await createDriver(resolveNeo4jConfig());
const providers = [
  new GitRepoProvider({ repoRoot: process.cwd() }),
  new WorkItemProvider({ repo: "kontourai/flow-agents" }), // reads via gh
];
console.log(await syncToNeo4j({ driver, providers })); // { writes, unchanged, digest, ... }
```

### 4. Query it — Neo4j Browser or the provider verbs

Open `http://localhost:7474` for the interactive Browser, or use the provider's
Cypher-backed query/health verbs (they fall back to a portable JS spelling with
identical answers when no Neo4j is reachable):

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
