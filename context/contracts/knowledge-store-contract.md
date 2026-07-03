# Knowledge Store Provider Contract

Normative contract for the Knowledge Kit's typed graph MODEL and its pluggable
storage/sync PROVIDERS. The model (nodes, edges, provenance) is owned by the Kit;
storage and synchronisation are provider concerns. The same ingest/link/health
verbs run over every provider, so backlog hygiene is a knowledge-health pass over
the work-item provider rather than a bespoke tool.

Machine-checkable structure lives in `schemas/knowledge/*.schema.json`
(`node`, `edge`, `proposal`, `health-report`). Reference implementations live in
`kits/knowledge/providers/` (markdown-vault, git-repo, work-item) with health
verbs in `kits/knowledge/providers/health/` and the conformance suite in
`kits/knowledge/providers/conformance/`.

This contract applies the portfolio provider pattern (hachure format/adapters;
Builder Kit work-item contract/providers) to knowledge, which until now was fused
to one storage shape (the markdown vault).

## 1. Graph model

### 1.1 Node

A node is a typed, identified unit of knowledge. Validated by
`schemas/knowledge/node.schema.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Provider-scoped stable id, unique within a single `readGraph` result. |
| `type` | yes | Node type (see §1.3). EXTENSIBLE. |
| `title` | yes | Human-readable title; the basis for duplicate detection. |
| `body` | no | Primary content; format is provider/type-specific. |
| `attributes` | no | Provider-specific structured fields (issue state/labels, decision status, note category/tags). |
| `provenance` | yes | Where this node was read from (§1.4). |

### 1.2 Edge

An edge is a typed, directed relationship. Validated by
`schemas/knowledge/edge.schema.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Provider-scoped stable edge id. |
| `type` | yes | One of the CLOSED edge vocabulary (§1.3). |
| `from` | yes | Source node id. |
| `to` | yes | Target node id. |
| `resolved` | no | `true` (default) means `to` is expected to resolve to a node in the same graph (an internal dependency link); `false` marks a deliberate external reference (e.g. `evidence-of` a PR outside the store). |
| `attributes` | no | Provider-specific structured fields. |
| `provenance` | yes | Where this edge was derived from (§1.4). |

### 1.3 Vocabularies

**Node types are EXTENSIBLE.** The recommended core vocabulary is `note`,
`decision`, `issue`, `session`, `person`. Providers MAY emit additional types;
consumers MUST NOT reject unknown node types.

**Edge types are CLOSED** (schema-enforced enum):

| Edge type | Direction | Meaning |
| --- | --- | --- |
| `supersedes` | from → to | `from` replaces `to`. |
| `merged-into` | from → to | `from` was folded into `to`. |
| `blocks` | from → to | `from` must complete before `to`. |
| `evidence-of` | from → to | `from` is provenance/evidence for `to`. |
| `mentions` | from → to | `from` references `to` in prose. |
| `relates` | from → to | General association. |

Adding an edge type is a contract change (schema + this table), because health
verbs reason over the closed vocabulary (e.g. `blocks` is the dependency-link
relation).

### 1.4 Provenance

Provenance appears on BOTH nodes and edges. Every assertion in the graph is
traceable back to the store it came from — no orphan facts.

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | yes | Provider id that produced the element. |
| `source` | yes | Concrete origin: a file path, an issue ref, or a URL. |
| `locator` | no | Finer locator (line, anchor, frontmatter field, link kind). |
| `retrieved_at` | yes | ISO-8601 read timestamp. |
| `agent` | no | Agent/process id that performed the read. |

## 2. Provider interface

A provider is an ESM module exporting a default class constructed with a
provider-specific options object. Every provider implements the READ interface
and the PROPOSALS-ONLY write interface.

### 2.1 Read

| Method | Signature | Behaviour |
| --- | --- | --- |
| `capabilities()` | `() => Capabilities` | Static description (§2.3). Synchronous. |
| `readNodes(options?)` | `(o?) => Promise<Node[]>` | All nodes; `options.type` filters by node type. Every node schema-valid. |
| `readEdges()` | `() => Promise<Edge[]>` | All edges; every edge schema-valid and in the closed vocabulary. |
| `queryByType(type)` | `(t) => Promise<Node[]>` | Convenience: the nodes of one type (a consistent subset of `readNodes`). |
| `readGraph()` | `() => Promise<{nodes, edges}>` | The full graph. |

### 2.2 Write — proposals only

Knowledge stores are HUMAN-CURATED. No provider auto-writes to a store. The only
write surface is:

| Method | Signature | Behaviour |
| --- | --- | --- |
| `proposeWrite(intent)` | `(i) => Promise<Proposal>` | Returns a `Proposal` (§2.4) describing an intended change. MUST NOT mutate the store, disk, or the remote board. |

**How proposals-only is expressed structurally:** the `Proposal` schema fixes
`status` to the const `"proposed"`. A provider can never return an applied
proposal, and the conformance suite asserts that `readNodes()` is byte-stable
across a `proposeWrite` call. Enactment happens DOWNSTREAM of the provider:

- **git-repo** renders a decision-registry topic file (frontmatter compatible
  with `schemas/decision-record.schema.json`) shaped for the **promote sub-flow**
  (`docs/decisions/promotion-gate.md`). The promote step is the enactor.
- **work-item** renders a draft `gh issue comment` / `gh issue edit --add-label`
  the operator files. The provider never runs a mutating `gh` command.
- **markdown-vault** renders a note in native frontmatter + `[[wikilink]]` form
  for the Knowledge Kit ingest/compile flow to file.

This is the same proposals-only discipline as the store contract's
`propose → apply/reject` gate and the ADR-0003-style "proposals, never silent
writes to a curated store" precedent. A provider is the propose half; a human or
a gated flow is the apply half.

### 2.3 Capabilities

`capabilities()` returns `{ id, node_types, edge_types, writable, write_mode,
proposal_targets, source_of_truth }`. `writable` is always `false` and
`write_mode` is always `"proposals-only"` in this version — a graph-database
provider that owns its store is a separate, gated spike (issue #318), not a
loophole here.

### 2.4 Proposal

Validated by `schemas/knowledge/proposal.schema.json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | `"1.0"`. |
| `provider` | yes | Emitting provider id. |
| `kind` | yes | `create-node` \| `update-node` \| `add-edge` \| `comment` \| `label` \| `decision-topic`. |
| `target` | yes | Where the change would land (descriptive only). |
| `payload` | no | The structured node/edge/field proposed. |
| `rendered` | no | The provider-native form an enactor would apply. |
| `status` | yes | The const `"proposed"`. |
| `rationale` | no | Why the change is proposed. |
| `provenance` | yes | §1.4. |

## 3. Health verbs

Health verbs are PROVIDER-AGNOSTIC pure functions over a graph
(`{ nodes, edges }`) — they never inspect provider internals, which is what lets
one health command run identically over any provider (R4). Each returns a
schema-valid Knowledge Health Report
(`schemas/knowledge/health-report.schema.json`). Reference verbs live in
`kits/knowledge/providers/health/`.

| Verb | Report `check` | Behaviour |
| --- | --- | --- |
| `detectDuplicates(graph, o?)` | `duplicate-detection` | Flags node pairs whose titles match / are highly similar (token Jaccard ≥ `threshold`, default 0.7; same-type by default). |
| `checkDependencyLinkIntegrity(graph, o?)` | `dependency-link-integrity` | Flags dependency edges (default type `blocks`) whose endpoints are missing from the graph, unless the edge is `resolved:false` (deliberate external ref). |

Every finding cites its evidence (the compared titles + similarity, or the edge
+ which endpoint is missing). A report's `summary.finding_count` MUST equal
`findings.length`.

## 4. Reference providers

| Provider | Reads | Node types | Write proposal |
| --- | --- | --- | --- |
| `markdown-vault` | The existing Knowledge Kit store (markdown + frontmatter + `[[wikilinks]]` + graph index) via an existing store adapter — thin wrapper, existing skills unaffected. | `note`, `person` | `create-node` rendered as a native vault note. |
| `git-repo` | `docs/decisions/*` (tombstones → `supersedes`/`merged-into`; `evidence[]` → `evidence-of`), CONTEXT.md glossary, `docs/learnings/*`. | `decision`, `note` | `decision-topic` shaped for the promote sub-flow. |
| `work-item` | GitHub issues via an INJECTABLE runner (default `gh`), `flow-agents:work-item-metadata` blockers + prose refs → `blocks`/`relates`. | `issue` | `comment` / `label` draft. |

## 5. Conformance

`kits/knowledge/providers/conformance/suite.test.js` is the parameterized
conformance suite EVERY provider must pass (issue #317, AC3). It asserts:
capabilities declare proposals-only/non-writable; `readNodes` returns unique,
schema-valid nodes with provider provenance; `readEdges` returns schema-valid
edges in the closed vocabulary; `queryByType` is a consistent subset of
`readNodes`; `readGraph` returns `{nodes, edges}`; and `proposeWrite` returns a
schema-valid `"proposed"` proposal that mutates nothing.

`kits/knowledge/providers/health/health-pass.test.js` covers AC1 (the same
health command over vault + git-repo yields schema-valid reports) and AC2 (a
backlog pass over the work-item adapter, driven by a SEEDED fixture, flags a
duplicate and a broken blocker link — never the real board).

## 6. Non-goals

Graph-database provider (issue #318 spike; adoption gated on a real query failing
over files); embeddings; auto-writes to any human-curated store; personal-vault
feature changes. This contract adds a model + read/propose interface over stores
operated today; it does not change how those stores are curated.
