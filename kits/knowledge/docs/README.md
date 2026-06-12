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

**Mutation operations**

| Op | Required evidence fields |
|---|---|
| `create` | `type`, `title`, `body`, `category`, `provenance.agent` |
| `update` | `agent` (in evidence) + at least one mutable field |
| `link` | `agent`, non-empty `links` array |
| `propose` | `agent`, `proposal` (non-empty) |
| `apply` | `agent`, `new_body` (non-empty), `rationale` (non-empty) |
| `reject` | `agent`, `reason` (non-empty) |

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

## Non-Goals (this iteration)

- Vector/semantic retrieval (parked as I10)
- Multi-user concurrency
- Store migrations
- Personal-KB import (parked as I11)
