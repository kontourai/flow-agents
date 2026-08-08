/**
 * Provider-graph ingest (issue #1214).
 *
 * Proves the exact defect the #1213 dogfood exposed cannot recur: a provider
 * graph's edges survive ingest as store links, round-trip through
 * MarkdownVaultProvider with their edge types intact (including `blocks`),
 * and the Surface projection over an ingested store is no longer
 * structurally blind (identity links + evidence present).
 *
 * Run: node --test kits/knowledge/adapters/shared/ingest-graph.test.js
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import DefaultKnowledgeStore from "../default-store/index.js";
import { MarkdownVaultProvider } from "../../providers/markdown-vault/index.js";
import { buildKnowledgeTrustBundle } from "../../providers/surface-adapter/index.js";
import { ingestProviderGraph } from "./ingest-graph.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kg-ingest-graph-"));
}

/** Fixture shaped like WorkItemProvider.readGraph() output. */
function fixtureGraph() {
  return {
    nodes: [
      { id: "issue-1", title: "Blocked feature", body: "Needs issue-2 first." },
      { id: "issue-2", title: "Blocker fix", body: "Root-cause fix." },
      { id: "issue-3", title: "Related doc", body: "" }, // empty body: normalizes to title
      { id: "issue-4", title: "Old approach", body: "Superseded design." },
    ],
    edges: [
      { id: "e1", type: "blocks", from: "issue-2", to: "issue-1" },
      { id: "e2", type: "relates", from: "issue-1", to: "issue-3" },
      { id: "e3", type: "evidence-of", from: "issue-3", to: "issue-1" },
      { id: "e4", type: "supersedes", from: "issue-1", to: "issue-4" },
      { id: "e5", type: "blocks", from: "issue-2", to: "issue-99" }, // unknown endpoint
      { id: "e6", type: "mystery-kind", from: "issue-1", to: "issue-2" }, // unmapped type
    ],
  };
}

describe("ingestProviderGraph over a real DefaultKnowledgeStore", () => {
  let dir, store, report;

  before(async () => {
    dir = makeTempDir();
    store = new DefaultKnowledgeStore({ storeRoot: dir });
    report = await ingestProviderGraph(store, fixtureGraph(), { agent: "ingest-tester" });
  });

  test("every node becomes a record; empty body normalizes to the title", async () => {
    assert.equal(report.created, 4);
    assert.equal(report.byNodeId.size, 4);
    const doc = await store.get(report.byNodeId.get("issue-3"));
    assert.equal(doc.body, "Related doc");
  });

  test("mappable edges become links; the two bad edges are skipped with reasons", () => {
    assert.equal(report.linked, 4);
    assert.equal(report.skipped.length, 2);
    const reasons = report.skipped.map((s) => s.reason).join(" | ");
    assert.match(reasons, /endpoint not ingested/);
    assert.match(reasons, /unmapped edge type: mystery-kind/);
  });

  test("links carry the inverse-mapped kinds on the source records", async () => {
    const blocker = await store.get(report.byNodeId.get("issue-2"));
    assert.deepEqual(
      blocker.links.map((l) => l.kind),
      ["blocks"],
    );
    const blocked = await store.get(report.byNodeId.get("issue-1"));
    assert.deepEqual(
      blocked.links.map((l) => l.kind).sort(),
      ["related", "supersedes"],
    );
    const doc = await store.get(report.byNodeId.get("issue-3"));
    assert.deepEqual(doc.links.map((l) => l.kind), ["source"]);
  });

  test("edges round-trip through MarkdownVaultProvider with types intact, including blocks", async () => {
    const vault = new MarkdownVaultProvider({ store, agent: "ingest-tester" });
    const edges = await vault.readEdges();
    const types = edges.map((e) => e.type).sort();
    assert.deepEqual(types, ["blocks", "evidence-of", "relates", "supersedes"]);
    const blocksEdge = edges.find((e) => e.type === "blocks");
    assert.equal(blocksEdge.from, report.byNodeId.get("issue-2"));
    assert.equal(blocksEdge.to, report.byNodeId.get("issue-1"));
  });

  test("the Surface projection over the ingested store is not structurally blind (#1214)", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir });
    assert.equal(bundle.claims.length, 4);
    assert.ok(bundle.identityLinks.length >= 1, "relates edge must yield an identity link");
    assert.ok(bundle.evidence.length >= 1, "evidence-of edge must yield evidence");
    const policyIds = (bundle.policies ?? []).map((p) => p.id).join(",");
    assert.match(policyIds, /supersedes/, "supersedes edge must yield a policy");
  });

  test("ingest bumped cacheVersion for every mutation (creates + link batches)", () => {
    // 1 (init) + 4 creates + 3 link() calls (issue-1, issue-2, issue-3 have links)
    assert.equal(store.getCacheVersion(), 8);
  });

  test("requires an agent for provenance", async () => {
    await assert.rejects(
      () => ingestProviderGraph(store, fixtureGraph(), {}),
      /requires options\.agent/,
    );
  });
});
