---
title: Knowledge Kit
---

# Knowledge Kit

The Knowledge Kit is a Flow Kit for durable, gated knowledge storage. It packages a store contract, five pipeline flows, pluggable store adapters, and a parameterized contract test suite — all validated and installed through the standard `flow-kit` path.

## What it ships

**Store contract** — four record types (`raw`, `compiled`, `concept`, `snapshot`) with a defined mutation policy: every write goes through propose→evidence-gate→apply/reject. Required evidence fields are enforced at runtime; a missing field throws `MISSING_EVIDENCE` rather than silently passing. Supersede-not-delete: records that are superseded move to an archive state with full provenance intact, not removed.

**Pipeline flows** — five flows cover the full lifecycle:

| Flow | What it does |
|---|---|
| `knowledge.ingest` | Capture → classify → route raw source material |
| `knowledge.compile` | Normalize classified raws into durable notes with provenance links |
| `knowledge.synthesize` | Detect similar clusters → propose a concept summary → evidence-gate → apply/reject |
| `knowledge.consolidate` | Related-event trigger → decision snapshot → supersede prior snapshots (not delete) |
| `knowledge.retire` | Gated status lifecycle: active → implemented → retired, with working-set exclusion |

**Store adapters** — two adapters ship:

- **Default adapter** — flat markdown files with YAML frontmatter, `[[wikilink]]` inline links, and a JSON graph index. Zero runtime dependencies; uses Node.js built-ins only.
- **Obsidian adapter** — the same store contract rendered into one human-canonical Obsidian note per record. Category dots map to folder hierarchy; configurable frontmatter dimensions (e.g. territory/customer/initiative as filterable fields); living overview notes at the category root with sources nested below; superseded records moved to `archive/` rather than deleted. The file is the record — no separate database, no sync step.

The output-shape story is why the adapter model matters: the same five flows and the same mutation gates produce a different rendering layer depending on which adapter is active. Authors choose the output shape that fits how they already think. (The Obsidian adapter is shipped; layout/dimensions refinements and person/entity card support are in development.)

**Similarity detectors** — the `synthesize` and `consolidate` flows accept a pluggable `similarityDetector`:

| Detector | Approach | Requires |
|---|---|---|
| `defaultSimilarityDetector` | Category prefix overlap + Jaccard link-overlap (≥ 0.10) | Nothing — built-in |
| `createVectorSimilarityDetector` | Dense embeddings + cosine similarity | ollama (`nomic-embed-text`, default threshold 0.60) |

The vector detector is fail-closed: infrastructure failures throw `EMBED_FAILURE` rather than silently returning an empty cluster (which would be indistinguishable from "no similar records found").

**Tests** — 198 tests across six suites (contract, ingest/compile, synthesis, consolidation, similarity-vector, retirement). The contract suite is parameterized — any adapter can run it by pointing `KNOWLEDGE_ADAPTER` at the adapter module.

**Live-proven** — keyless operation validated via a Strands agent + local ollama acceptance harness. The vector similarity detector is validated against `nomic-embed-text` with documented threshold guidance.

## Quick reference

```bash
# Install the kit into a workspace
npx @kontourai/flow-agents flow-kit install-local kits/knowledge --dest /path/to/workspace

# Run the contract suite against the default adapter
node --test kits/knowledge/evals/contract-suite/suite.test.js

# Run against an alternative adapter
KNOWLEDGE_ADAPTER=/path/to/my-adapter.js \
  node --test kits/knowledge/evals/contract-suite/suite.test.js
```

## Source

- Kit manifest: [`kits/knowledge/kit.json`](https://github.com/kontourai/flow-agents/blob/main/kits/knowledge/kit.json)
- Store contract doc: [`kits/knowledge/docs/store-contract.md`](https://github.com/kontourai/flow-agents/blob/main/kits/knowledge/docs/store-contract.md)
- Default adapter: [`kits/knowledge/adapters/default-store/index.js`](https://github.com/kontourai/flow-agents/blob/main/kits/knowledge/adapters/default-store/index.js)
- Obsidian adapter: [`kits/knowledge/adapters/obsidian-store/index.js`](https://github.com/kontourai/flow-agents/blob/main/kits/knowledge/adapters/obsidian-store/index.js)
- Vector similarity detector: [`kits/knowledge/adapters/similarity-vector/index.js`](https://github.com/kontourai/flow-agents/blob/main/kits/knowledge/adapters/similarity-vector/index.js)

## Related

- [Kit Authoring Guide](kit-authoring-guide.html) — build your own kit using the same `kit.json` contract
- [Flow Kit Repository Contract](flow-kit-repository-contract.html) — validation rules and activation diagnostics
- [Vision and Direction](vision.html) — the kits-as-ecosystem arc and the sequenced path toward domain kits and a registry
