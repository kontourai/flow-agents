# SPIKE findings — graph database provider experience: Neo4j Community vs Kuzu (embedded)

- Issue: kontourai/flow-agents#318
- Executed: 2026-07-03 (agent session)
- **Graph snapshot timestamp: `2026-07-03T05:14:42Z`** (point-in-time; two builds in flight during the spike — #312 flow-agents, #314 traverse — so backlog edges may have moved since)
- Provider interface (#317) had NOT landed → used a throwaway extractor (`build-graph.js`) over the real stores, per scope.
- Engines exercised: **BOTH** — Neo4j Community 5 (Docker) AND Kuzu 0.11.3 (embedded, in-process via npm). All 5 canonical queries ran on both.

---

## 1. Node / edge counts (identical on both engines)

**Nodes: 200**

| Label | Count | Source |
|---|---|---|
| Issue | 116 | flow-agents (112) + traverse (4), via `gh issue list --json` |
| Session | 40 | `.kontourai/flow-agents/archive/sweep-2026-07-02.json` (`archived[]`) |
| Decision | 23 | `docs/adr/*.md` (the *living* `docs/decisions/` registry from #310 does not exist yet — ADRs are the current decision records) |
| PR | 13 | flow-agents PRs that carry `closingIssuesReferences` |
| Learning | 8 | numbered sections of `docs/learnings/2026-07-improvement-program.md` |

**Edges: 227**

| Type | Count | Derivation |
|---|---|---|
| RELATES | 141 | prose `#NNN` cross-references (+ cross-repo `traverse#NN`, + ADR-0007 number collision) |
| MENTIONS | 35 | Decision→Issue and Learning→Issue `#NNN` references in doc bodies |
| BLOCKED_BY | 27 | metadata markers (`work-item-metadata.blockers[]`) AND prose ("blocked by/depends on #N") |
| CLOSES | 14 | PR→Issue from `closingIssuesReferences` |
| EVIDENCE_OF | 10 | Session→Decision/Issue — **heuristic** slug/title token overlap (≥2 shared ≥5-char tokens), flagged `heuristic:true` |

AC1 satisfied: both engines loaded the real graph; counts reported.

---

## 2. Engine setup friction

### Neo4j Community (Docker)
- `docker run -d -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/… neo4j:5-community` — image pull + boot to "Started" in ~30s. Zero config.
- **Schema-free load**: no DDL. `UNWIND $rows AS r CREATE (n:Label) SET n=r` for nodes; `UNWIND … MATCH (a{id}),(b{id}) CREATE (a)-[x:TYPE]->(b) SET x=r.props` for edges. Endpoints matched by `id` regardless of label — polyglot property bags "just work."
- Bulk load of 200 nodes + 227 edges via batched UNWIND: **~1.8s**.
- Ops cost: a running server + two ports + auth. Fine locally; a real dependency in CI/prod.

### Kuzu (embedded, npm)
- `npm install kuzu` → `new kuzu.Database(path)` + `new kuzu.Connection(db)`. In-process, no server, no ports. SQLite-for-graphs as advertised.
- **Typed schema REQUIRED up front**: `CREATE NODE TABLE Issue(id STRING PRIMARY KEY, …)` and `CREATE REL TABLE BLOCKED_BY(FROM Issue TO Issue, …)`. Multi-pair rel tables (`FROM Decision TO Issue, FROM Learning TO Issue`) are supported and needed here. This is more rigor than Neo4j but also more friction for an evolving/heterogeneous graph.
- **Escaping gotcha**: string literals with `'` fail the Cypher parser even with SQL-style `''` doubling — had to switch to parameterized `conn.prepare()`/`conn.execute()`. (Real backlog titles contain apostrophes, em-dashes, emoji — this bit immediately.)
- **Cleanup gotcha**: the DB is a file *plus* a `.wal` sidecar. Deleting only the file leaves a stale catalog → "Issue already exists in catalog" on reload. Must remove `<db>` and `<db>.wal`.
- Load of the same graph via per-row prepared statements: **~3.3s** (Kuzu's real strength is bulk `COPY FROM`, which I didn't use for 200 rows).

### ⚠️ Material viability finding (dominates the recommendation)
**Kuzu is abandoned upstream.** The npm package (`kuzu@0.11.3`) prints *"Package no longer supported"* on install. In October 2025 Kùzu Inc. was acquired (reporting: by Apple), the GitHub repo was **archived**, and active development/support ended. It remains MIT-licensed and usable; community forks exist (Kineviz **"bighorn"**, **"Ladybug"**) but are early. Adopting Kuzu today means betting on a fork or freezing on an unmaintained pin. Sources: The Register 2025-10-14 "KuzuDB graph database abandoned"; npm deprecation notice on `kuzu`.

---

## 3. Query ergonomics — side-by-side Cypher (where they differ)

Q1–Q3 were **byte-identical Cypher** across engines. Q3, Q4, Q5 differed:

**Q1 — transitive blocker closure (identical):**
```cypher
MATCH (i:Issue {id:'FA#313'})-[:BLOCKED_BY*1..10]->(b:Issue)
RETURN DISTINCT b.id, b.state ORDER BY b.id
```
Both engines accept the `*1..10` variable-length syntax verbatim.

**Q3 — orphans (no inbound). DIFFERS:**
```cypher
-- Neo4j: pattern-predicate + labels()[0]
MATCH (n) WHERE NOT ( ()-->(n) ) RETURN labels(n)[0] AS label, count(*) ...
-- Kuzu: EXISTS-subquery + label() (singular)
MATCH (n) WHERE NOT EXISTS { MATCH ()-[]->(n) } RETURN label(n) AS label, count(*) ...
```

**Q4 — duplicate candidates (string/list functions DIFFER):**
```cypher
-- Neo4j: split() + list comprehension + substring()
[w IN split(toLower(t),' ') WHERE size(w)>=5 | substring(w,0,5)]
-- Kuzu: string_split() + list_transform()/list_filter() + list_contains()
list_transform(list_filter(string_split(lower(t),' '), x->size(x)>=5), x->substring(x,1,5))
```
Note `substring` is **0-indexed in Neo4j, 1-indexed in Kuzu**.

**Q5 — shortest path between two decisions. DIFFERS most:**
```cypher
-- Neo4j: shortestPath() function + list comprehension over path nodes
MATCH p=shortestPath((a:Decision {id:'ADR-0011'})-[*..8]-(b:Decision {id:'ADR-0021'}))
RETURN [n IN nodes(p) | n.id] AS path, length(p)
-- Kuzu: SHORTEST keyword in the pattern + list_transform for projection
MATCH p=(a:Decision {id:'ADR-0011'})-[* SHORTEST 1..8]-(b:Decision {id:'ADR-0021'})
RETURN list_transform(nodes(p), x->x.id) AS path, length(p)
```
Kuzu rejected the Neo4j-style `[n IN nodes(p) | n.id]` projection ("Variable n is not in scope") — `list_transform` is the Kuzu idiom. Both returned the same path.

**Takeaway:** ~80% of Cypher is portable; the divergence is entirely in (a) existence predicates, (b) string/list stdlib, (c) path projection + shortest-path spelling. A provider abstraction would need a thin dialect shim for exactly those three areas.

---

## 4. What the queries REVEALED (surprises > confirmations)

**Q1 — SURPRISE / the headline.** #313's transitive blockers = **{#312 (OPEN), #310 (CLOSED)}** — and *nothing else*. The orchestrator's stated ground truth ("#313's transitive blockers now include #317") **does NOT hold in this snapshot.** No edge from #313 (or its blockers #312/#310) to #317 exists in metadata OR prose; #317 is referenced only by this spike (#318, soft blocker). Verified with a fresh individual `gh issue view` on #313/#312/#310. Interpretation: the intended #313→(knowledge provider #317) dependency is **not yet encoded** — either the edit is still in flight (builds #312/#314 open) or the coupling lives only in humans' heads. *This is exactly the class of gap a graph pass surfaces mechanically: an expected transitive dependency that isn't in the data.* The #310–#314 chain itself is confirmed: #310→{#311,#312,#314}, #312→#313.

**Q2 — contradiction candidates: the ADR failure mode caught red-handed.** Top hit is **ADR-0007 vs ADR-0007b** — two files sharing decision number 0007 ("Flow/Skill/Kit/Tool Boundary"), one `Accepted`, one status-less, both citing #62. This is *literally* the numbering-collision + contradiction-accumulation failure that #310 was written to kill, sitting in the current ADR tree. Also surfaced: ADR-0014 (`Proposed`, superseded) contradicting ADR-0015/0016 (`Accepted`) over the same subject (#183, the core-vs-domain boundary), and ADR-0011/0012 (`Accepted`) vs ADR-0021 (`Draft`) over #137. These are real "divergent status over shared subject" pairs.

**Q3 — orphans: reveals a modeling lesson, not just data.** "No inbound edge" flags 43 issues, all 40 sessions, 21 decisions, all 13 PRs, all 8 learnings. But Sessions/PRs/Learnings are *source-only node types by construction* (EVIDENCE_OF/CLOSES/MENTIONS all originate from them), so flagging them wholesale is noise. **Finding: orphan detection needs node-type awareness** ("issues/decisions with no inbound" is the meaningful query; leaf-type nodes should be excluded). The genuinely interesting orphans are the 21 Decisions (ADRs) that *nothing* in the backlog references — candidate stale/undiscoverable decisions.

**Q4 — duplicate candidates: naive title-token overlap MISSES the known duplicate.** With exact ≥5-char token matching, the ground-truth **traverse#14 ~ traverse#8** duplicate did **not** appear (they share only `extraction`; `chunk` vs `chunking` don't match exactly). It surfaced only after switching to **5-char-prefix stemming** (`extra`,`chunk`), on *both* engines. Lesson: mechanical dup-detection needs stemming + shared-evidence (both issues cite the same 23-item listing-page truncation (downstream consumer pilot) in their *bodies*, which title-only matching can't see — full-text/evidence-ref overlap is required, exactly what #317's "shared evidence refs" clause calls for). Bonus real find: the **runtime-compatibility-canary trio #75/#93/#247** ranks top — recurring near-duplicate canary-failure issues.

**Q5 — shortest path.** ADR-0011 ↔ ADR-0021 resolves to `ADR-0011 → FA#137 ← ADR-0021` (length 2): two decisions connected through the backlog issue they both touch. Clean, and a genuinely useful "how are these two decisions related" primitive.

AC2 satisfied: all five queries executed on both engines, interpreted against ground truth.

---

## 5. Visualization notes

- **Neo4j Browser** (http://localhost:7474) is the real differentiator. Captured screenshot (`neo4j-graph.png`, via Playwright) shows the Browser **connected to the live instance** (`neo4j://localhost:7687`, Community 5.26) rendering `MATCH p=(a:Issue)-[:BLOCKED_BY]->(b:Issue) RETURN p LIMIT 60` as a **d3-force graph — 26 Issue nodes / 27 BLOCKED_BY relationships in several distinct clusters** (the backlog's blocker chains, visually separable at a glance). The left Database Information panel simultaneously confirms the full loaded graph: **Nodes (200)** color-coded by all five labels (Decision, Issue, Learning, PR, Session) and **Relationships (227)** across all five types (BLOCKED_BY, CLOSES, EVIDENCE_OF, MENTIONS, RELATES), plus the property-key catalog (id, state, status, superseded, heuristic, overlap, markerStatus, crossRepo, …). Interactive force-directed exploration, click-to-expand neighborhoods, and color-by-label are its standout value for *human* exploration of the blocker/decision subgraph — Kuzu has no equivalent.
- **Kuzu** ships **no built-in visualization** in the embedded npm path (Kuzu Explorer exists only as a separate Docker image — which defeats the "zero-ops embedded" pitch). For an embedded engine you bring your own viz (export to a JS graph lib).
- Screenshot path: `/Users/brian/.claude/jobs/90beb625/tmp/graph-spike/neo4j-graph.png`.

---

## 6. Recommendation: **DEFER adoption** (build the model now, pick the engine later)

The spike's own gate ("adoption stays gated on a real query going slow/awkward over file providers") did **not** trip: all five queries ran in milliseconds over 200 nodes / 227 edges. At portfolio scale (hundreds of issues, dozens of decisions, ~120 sessions) this graph is *tiny* — an in-memory JS object graph, or even the throwaway extractor + array scans, answers every canonical query without a database engine at all. **The value proven tonight is the MODEL and the QUERIES, not either engine.**

**What to build now (regardless of engine):** the #317 typed graph model (nodes/edges/provenance) + the read-side extractors validated here (metadata markers + prose blockers + ADR/tombstone status + archive index + PR closes). That model is what caught the ADR-0007 collision, the missing #313→#317 edge, and the traverse#14 dup.

**Trigger conditions to REVISIT an engine (adopt-when):**
1. Graph exceeds ~10k nodes / ~50k edges, OR a canonical query (transitive closure, all-pairs shortest path, dup-scan) measurably lags in the naive JS implementation.
2. Multi-hop/variable-length traversal or shortest-path becomes a *frequent, interactive* need (not batch) — this is where hand-rolled JS gets painful and Cypher pays off.
3. Interactive human exploration of the knowledge graph becomes a workflow (not just automated health passes) — pulls toward Neo4j Browser specifically.

**If/when a trigger fires, prefer Neo4j Community over Kuzu**, primarily because **Kuzu is abandoned upstream (Oct 2025)** — the "zero-ops embedded" advantage is real but is now offset by no maintenance, no security updates, and a fork-or-freeze decision. Neo4j Community is heavier (server + ports) but actively maintained, has the browser, and its Cypher is the portable baseline. *Caveat:* re-evaluate the Kuzu forks (bighorn/Ladybug) at revisit time — if one is credibly maintained, embedded-Kuzu-fork reclaims the zero-ops win for the automated-health-pass use case.

**What a provider implementation (#317) would need:**
- Read-side extractors for each store (validated here): work-item adapter (issues + `work-item-metadata` markers + prose refs), git-repo-docs adapter (ADR/decision status + tombstones + evidence[] + CONTEXT.md vocabulary + learnings), archive-index adapter (sessions). **Robustness note:** 3 of 19 metadata markers failed to JSON-parse and several `blockers[].ref` were `undefined` — the extractor MUST tolerate malformed markers and fall back to prose.
- A typed node/edge schema (Kuzu proved you *can* enforce types; the model should own the contract independent of storage).
- Proposal-only writes where the store is human-curated (decision registry, CONTEXT.md).
- A **dialect shim** if any real engine is used, covering exactly the three divergences found: existence predicates, string/list stdlib (incl. 0- vs 1-indexed substring), and shortest-path/path-projection syntax.
- Dup-detection needs **stemming + shared-evidence-ref overlap**, not exact title tokens (proven by the traverse#14~#8 miss).

AC3 satisfied: explicit adopt/defer recommendation with trigger conditions and provider requirements.

---

## Appendix — artifacts in this scratch dir (auto-cleaned with the job; nothing committed)
- `build-graph.js` — throwaway extractor → `graph.json` (200 nodes / 227 edges)
- `kuzu-load.js`, `kuzu-queries.js` — Kuzu embedded loader + 5 queries
- `neo4j-load.js`, `neo4j-queries.js`, `neo4j-q4-stem.js` — Neo4j loader + queries
- `graph.json`, `fa-issues.json`, `traverse-issues.json`, `fa-prs.json`, `adr.json` — snapshots
- `kuzu-db` (+`.wal`) — embedded DB file
- `neo4j-browser.png` — visualization screenshot
- Docker container `graph-spike-neo4j` — **torn down at end of session** (see cleanup)
