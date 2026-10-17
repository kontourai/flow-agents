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
available. This distribution qualifies Flow 5.2.0 and Surface 5.0.0. The kit
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
