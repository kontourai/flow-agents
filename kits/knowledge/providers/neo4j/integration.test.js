/**
 * neo4j provider — LIVE integration test (gated).
 *
 * Runs against a real Neo4j Community instance ONLY when NEO4J_URI is set and
 * reachable; otherwise it SKIPS LOUDLY (CI has no Neo4j — the CI proof is the
 * unit tests + conformance with the injected fake driver). To run locally:
 *
 *   docker run -d --name kg-neo4j -p 7474:7474 -p 7687:7687 \
 *     -e NEO4J_AUTH=neo4j/testpassword neo4j:5-community
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=testpassword \
 *     node --test kits/knowledge/providers/neo4j/integration.test.js
 *
 * Proves end-to-end what the fake driver can only approximate: real MERGE
 * idempotency counters (AC1) and the five canonical queries executing as LIVE
 * Cypher (AC3), asserted to agree with the portable JS backend (parity).
 *
 * @module providers/neo4j/integration.test
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Neo4jProvider } from "./index.js";
import { syncToNeo4j } from "./sync.js";
import { resolveNeo4jConfig, createDriver, isReachable } from "./connection.js";
import * as jsq from "./graph-queries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPH = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "spike-ground-truth.json"), "utf8"));

const config = resolveNeo4jConfig();
let driver = null;
let live = false;

before(async () => {
  if (!config) return;
  driver = await createDriver(config);
  live = await isReachable(driver);
});

after(async () => {
  if (driver) await driver.close();
});

describe("neo4j LIVE integration", () => {
  test("live Neo4j round-trip, idempotent sync (AC1) and canonical Cypher queries (AC3)", async (t) => {
    if (!config) {
      t.skip("SKIP (loud): NEO4J_URI unset — live Neo4j integration not run. See file header to run locally.");
      return;
    }
    if (!live) {
      t.skip(`SKIP (loud): Neo4j configured (${config.uri}) but not reachable — live integration not run.`);
      return;
    }

    const graph = { nodes: JSON.parse(JSON.stringify(GRAPH.nodes)), edges: JSON.parse(JSON.stringify(GRAPH.edges)) };

    // Clean slate.
    {
      const s = driver.session({ database: config.database });
      try {
        await s.run("MATCH (n) DETACH DELETE n");
      } finally {
        await s.close();
      }
    }

    // AC1: first sync writes; second reports zero; forced re-sync also zero.
    const first = await syncToNeo4j({ driver, database: config.database, graph });
    assert.ok(first.writes > 0, "first live sync must write");
    const second = await syncToNeo4j({ driver, database: config.database, graph });
    assert.equal(second.writes, 0, "second live sync must report zero writes (MERGE idempotency)");
    const forced = await syncToNeo4j({ driver, database: config.database, graph, force: true });
    assert.equal(forced.writes, 0, "forced live re-sync of identical data must produce zero writes");

    const provider = new Neo4jProvider({ driver, database: config.database, agent: "integration" });
    assert.equal(provider._cypherAnalytics, true, "live driver must use the Cypher analytics backend");

    // Read side round-trips.
    const nodes = await provider.readNodes();
    assert.ok(nodes.length >= GRAPH.nodes.length);

    // AC3 via LIVE Cypher, asserted equal to the JS oracle over the same graph.
    const blockers = await provider.transitiveBlockers("issue:313");
    assert.deepEqual(
      blockers.map((b) => b.id).sort(),
      ["issue:310", "issue:312"],
      "Q1 live Cypher: #313 blockers = {#310,#312}, not #317",
    );

    const contradictions = await provider.contradictionCandidates();
    assert.ok(
      contradictions.some((c) => c.a_id === "decision:adr-0007" && c.b_id === "decision:adr-0007b"),
      "Q2 live Cypher: ADR-0007 collision flagged",
    );

    const orphans = await provider.orphans();
    const orphanIds = orphans.map((o) => o.id);
    assert.ok(orphanIds.includes("decision:orphan-adr"), "Q3 live Cypher: stale decision orphan");
    assert.ok(!orphanIds.includes("session:s1"), "Q3 live Cypher: leaf types excluded");

    const dups = await provider.duplicateCandidates();
    assert.ok(
      dups.some(
        (d) =>
          (d.a_id === "issue:traverse-8" && d.b_id === "issue:traverse-14") ||
          (d.a_id === "issue:traverse-14" && d.b_id === "issue:traverse-8"),
      ),
      "Q4 live Cypher: stemmed dup catches the traverse pair",
    );
    // Parity: the same stemmed dup is (not) found by exact tokens in JS.
    const jsDups = jsq.duplicateCandidates(graph, { threshold: 0.7 });
    const jsHit = jsDups.find((d) => d.a_id.startsWith("issue:traverse") && d.b_id.startsWith("issue:traverse"));
    assert.ok(jsHit && jsHit.caught_only_by_stemming, "JS oracle agrees: caught only by stemming");

    const sp = await provider.shortestPath("decision:adr-0011", "decision:adr-0021");
    assert.equal(sp.length, 2, "Q5 live Cypher: shortest path length 2");
  });
});
