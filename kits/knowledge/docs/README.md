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
- `get(id)` → `Promise<Record | null>`
- `getLinks(id)` → `Promise<{ forward: Link[], reverse: Link[] }>`
- `listByCategory(category, options?)` → `Promise<Record[]>`
- `listByType(type)` → `Promise<Record[]>`

---

## Flow

The kit ships one flow:

**`knowledge.store-contract`** — gates on three evidence claims before a store implementation
is accepted: contract-suite pass, provenance-enforcement pass, and round-trip integrity pass.
S2 will add pipeline flows for raw ingestion, compilation, and concept management; this flow
and adapter infrastructure remain the foundation.

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

### Choosing a detector

| Detector | Best for | Tradeoff |
|---|---|---|
| `defaultSimilarityDetector` (built-in) | Fast, zero-config. Works well when records share a structured category taxonomy and inter-record wikilinks. | Relies on category prefixes and link-overlap (Jaccard ≥ 0.10). Misses semantic similarity across category boundaries. |
| `createVectorSimilarityDetector` | Semantic clustering. Finds similar records regardless of how they were categorised. | Requires an embedding backend (ollama by default). Adds latency proportional to cluster size. |

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
