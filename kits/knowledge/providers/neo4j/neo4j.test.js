/**
 * neo4j provider — unit tests (CI-safe, no Docker, injected fake driver).
 *
 * Covers the parts of issue #327 that do NOT need a live server:
 *   - sync idempotency (AC1): writes>0 on first sync, 0 on re-sync, 0 on a
 *     FORCED re-sync (hash-guard) — proven against the fake driver's counters.
 *   - canonical queries (AC3): the five spike queries over the ground-truth
 *     fixture reproduce the spike's results, incl. the stemmed-dup case.
 *   - marker tolerance: a throwing provider does not kill the sync.
 *   - graceful degradation (AC4): selection falls back to file providers with a
 *     clear one-line message when no Neo4j is reachable / configured.
 *   - proposals-only write.
 *
 * Run: node --test kits/knowledge/providers/neo4j/neo4j.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Neo4jProvider } from "./index.js";
import { syncToNeo4j, materializeGraph, planSync, computeDigest } from "./sync.js";
import { selectKnowledgeProvider } from "./connection.js";
import { makeFakeDriver } from "./fake-driver.js";
import * as jsq from "./graph-queries.js";
import { loadSchemas } from "../lib/model.js";
import { validate } from "../lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPH = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "spike-ground-truth.json"), "utf8"));
const schemas = loadSchemas();

function fixtureGraph() {
  return { nodes: JSON.parse(JSON.stringify(GRAPH.nodes)), edges: JSON.parse(JSON.stringify(GRAPH.edges)) };
}

describe("neo4j sync — idempotency (AC1)", () => {
  test("first sync writes; second sync reports zero writes; forced re-sync also zero (hash-guard)", async () => {
    const driver = makeFakeDriver();
    const graph = fixtureGraph();

    const first = await syncToNeo4j({ driver, graph });
    assert.ok(first.writes > 0, `expected writes on first sync, got ${first.writes}`);
    assert.equal(first.unchanged, false);
    assert.ok(first.digest && first.snapshot.synced_at);

    const second = await syncToNeo4j({ driver, graph });
    assert.equal(second.writes, 0, "second sync must report zero writes");
    assert.equal(second.unchanged, true);

    // Force past the digest short-circuit: the hash-guarded MERGE must STILL
    // produce zero created nodes/rels and zero property sets on identical data.
    const forced = await syncToNeo4j({ driver, graph, force: true });
    assert.equal(forced.writes, 0, "forced re-sync of identical data must produce zero writes");
  });

  test("planSync is a pure no-op when the digest is unchanged", () => {
    const graph = fixtureGraph();
    const digest = computeDigest(graph);
    const plan = planSync(graph, digest);
    assert.equal(plan.unchanged, true);
    assert.equal(plan.statements.length, 0);
    const changed = planSync(graph, "different-digest");
    assert.equal(changed.unchanged, false);
    assert.ok(changed.statements.length > 0);
  });
});

describe("neo4j read side round-trips through the (fake) driver", () => {
  test("synced graph reads back as schema-valid nodes/edges", async () => {
    const driver = makeFakeDriver();
    await syncToNeo4j({ driver, graph: fixtureGraph() });
    const provider = new Neo4jProvider({ driver });

    const nodes = await provider.readNodes();
    assert.ok(nodes.length > 0);
    for (const n of nodes) {
      const { valid, errors } = validate(n, schemas.node);
      assert.ok(valid, `node ${n.id} invalid: ${errors.join(", ")}`);
    }
    const edges = await provider.readEdges();
    for (const e of edges) {
      const { valid, errors } = validate(e, schemas.edge);
      assert.ok(valid, `edge ${e.id} invalid: ${errors.join(", ")}`);
    }
    // Edges to nodes present in the fixture materialize; all 8 fixture edges have
    // resolvable endpoints, so the view keeps them.
    assert.equal(edges.length, GRAPH.edges.length);
  });
});

describe("neo4j canonical queries reproduce the spike ground truth (AC3)", () => {
  const provider = new Neo4jProvider({ sourceGraph: fixtureGraph() });

  test("Q1 transitive blockers of #313 = {#312 OPEN, #310 CLOSED}, NOT #317", async () => {
    const blockers = await provider.transitiveBlockers("issue:313");
    const ids = blockers.map((b) => b.id).sort();
    assert.deepEqual(ids, ["issue:310", "issue:312"]);
    assert.equal(blockers.find((b) => b.id === "issue:310").state, "CLOSED");
    assert.equal(blockers.find((b) => b.id === "issue:312").state, "OPEN");
    assert.ok(!ids.includes("issue:317"), "the spike headline: no #313 -> #317 edge exists");
  });

  test("Q2 contradiction candidates catch the ADR-0007 collision", async () => {
    const cands = await provider.contradictionCandidates();
    const hit = cands.find((c) => c.a_id === "decision:adr-0007" && c.b_id === "decision:adr-0007b");
    assert.ok(hit, "ADR-0007 vs ADR-0007b (same subject, divergent status) must be flagged");
    // A different-subject decision pair must NOT be a contradiction.
    assert.ok(!cands.some((c) => c.a_id === "decision:adr-0011" && c.b_id === "decision:adr-0021"));
  });

  test("Q3 orphans are node-type aware: the stale decision surfaces, leaf types do not", async () => {
    const orphans = await provider.orphans();
    const ids = orphans.map((o) => o.id);
    assert.ok(ids.includes("decision:orphan-adr"), "the undiscoverable decision is a meaningful orphan");
    assert.ok(!ids.includes("session:s1"), "sessions are source-only leaves — never flagged");
    assert.ok(!ids.includes("learning:l1"), "learnings are source-only leaves — never flagged");
  });

  test("Q4 duplicate detection needs stemming: traverse#14 ~ #8 caught only by stemming", async () => {
    const dups = await provider.duplicateCandidates();
    const hit = dups.find(
      (d) =>
        (d.a_id === "issue:traverse-8" && d.b_id === "issue:traverse-14") ||
        (d.a_id === "issue:traverse-14" && d.b_id === "issue:traverse-8"),
    );
    assert.ok(hit, "the known traverse duplicate must be detected");
    assert.equal(hit.caught_only_by_stemming, true, "exact tokens miss it; stemming catches it");
    assert.ok(hit.exact_similarity < 0.7 && hit.stemmed_similarity >= 0.7);
  });

  test("Q5 shortest path between two decisions is length 2 through a shared node", async () => {
    const sp = await provider.shortestPath("decision:adr-0011", "decision:adr-0021");
    assert.ok(sp, "a path must exist");
    assert.equal(sp.length, 2);
    assert.equal(sp.path[0], "decision:adr-0011");
    assert.equal(sp.path[sp.path.length - 1], "decision:adr-0021");
  });

  test("naive exact-token duplicate detection MISSES the traverse dup (the spike's finding)", () => {
    // Direct evidence of the finding: exact tokens produce no cross-threshold hit
    // for the traverse pair, stemming does.
    const g = { nodes: fixtureGraph().nodes.filter((n) => n.id.startsWith("issue:traverse")), edges: [] };
    const dups = jsq.duplicateCandidates(g, { threshold: 0.7 });
    assert.equal(dups.length, 1);
    assert.equal(dups[0].exact_similarity, 0);
    assert.ok(dups[0].stemmed_similarity >= 0.7);
  });
});

describe("marker tolerance (spike finding 3)", () => {
  test("a provider that throws while reading does not kill the sync", async () => {
    const good = new Neo4jProvider({ sourceGraph: fixtureGraph() });
    const exploding = {
      id: "work-item",
      async readGraph() {
        throw new Error("simulated malformed metadata marker: 3/19 failed JSON.parse");
      },
    };
    const mat = await materializeGraph([good, exploding]);
    assert.ok(mat.nodes.length > 0, "the healthy provider's graph still materialized");
    assert.equal(mat.errors.length, 1);
    assert.match(mat.errors[0].error, /malformed metadata marker/);
  });
});

describe("graceful degradation (AC4)", () => {
  test("neo4j selected but NEO4J_URI unset -> file providers with a clear message", async () => {
    const msgs = [];
    const result = await selectKnowledgeProvider({
      preference: "neo4j",
      env: {},
      fileProviders: async () => [{ id: "git-repo" }],
      log: (m) => msgs.push(m),
    });
    assert.equal(result.provider, "file");
    assert.equal(result.providers[0].id, "git-repo");
    assert.match(msgs[0], /NEO4J_URI is unset/);
  });

  test("neo4j reachable path selects the neo4j provider", async () => {
    const driver = makeFakeDriver();
    const result = await selectKnowledgeProvider({
      preference: "neo4j",
      env: { NEO4J_URI: "bolt://localhost:7687" },
      driver,
      fileProviders: async () => [{ id: "git-repo" }],
      neo4jFactory: async ({ driver: d }) => new Neo4jProvider({ driver: d }),
    });
    assert.equal(result.provider, "neo4j");
    assert.ok(result.graph instanceof Neo4jProvider);
  });

  test("default preference is file (graph is opt-in only)", async () => {
    const result = await selectKnowledgeProvider({
      env: {},
      fileProviders: async () => [{ id: "git-repo" }],
    });
    assert.equal(result.provider, "file");
  });
});

describe("proposals-only write", () => {
  test("proposeWrite returns a schema-valid 'proposed' proposal and mutates nothing", async () => {
    const driver = makeFakeDriver();
    await syncToNeo4j({ driver, graph: fixtureGraph() });
    const provider = new Neo4jProvider({ driver });
    const before = await provider.readNodes();
    const p = await provider.proposeWrite({ kind: "create-node", type: "note", title: "Proposed" });
    const { valid, errors } = validate(p, schemas.proposal);
    assert.ok(valid, `proposal invalid: ${errors.join(", ")}`);
    assert.equal(p.status, "proposed");
    assert.equal(p.provider, "neo4j");
    const after = await provider.readNodes();
    assert.equal(after.length, before.length, "proposeWrite must not mutate the store");
  });
});
