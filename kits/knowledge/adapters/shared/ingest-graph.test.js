/**
 * Provider-graph ingest (issue #1214).
 *
 * Proves the exact defect the #1213 dogfood exposed cannot recur: a provider
 * graph's edges survive ingest as store links, round-trip through
 * MarkdownVaultProvider with their edge types intact (including `blocks` and
 * `merged-into`), the Surface projection over an ingested store is no longer
 * structurally blind, re-ingest upserts instead of duplicating, provider
 * identity survives as aliases/tags, and untrusted bodies cannot inject
 * wikilink edges.
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
import { ingestProviderGraph, aliasForNodeId } from "./ingest-graph.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kg-ingest-graph-"));
}

/** Fixture shaped like WorkItemProvider.readGraph() output (id "issue:N",
 * attributes {number, state, labels}). */
function fixtureGraph() {
  return {
    nodes: [
      { id: "issue:1", title: "Blocked feature", body: "Needs issue 2 first.", attributes: { number: 1, state: "OPEN", labels: ["feature"] } },
      { id: "issue:2", title: "Blocker fix", body: "Root-cause fix.", attributes: { number: 2, state: "OPEN", labels: ["bug", "urgent"] } },
      { id: "issue:3", title: "Related doc", body: "", attributes: { number: 3, state: "CLOSED", labels: [] } }, // empty body: normalizes to title
      { id: "issue:4", title: "Old approach", body: "Superseded design with an [[injected-target]] wikilink.", attributes: { number: 4, state: "CLOSED", labels: [] } },
    ],
    edges: [
      { id: "e1", type: "blocks", from: "issue:2", to: "issue:1" },
      { id: "e2", type: "relates", from: "issue:1", to: "issue:3" },
      { id: "e3", type: "evidence-of", from: "issue:3", to: "issue:1" },
      { id: "e4", type: "supersedes", from: "issue:1", to: "issue:4" },
      { id: "e5", type: "merged-into", from: "issue:4", to: "issue:1" },
      { id: "e6", type: "blocks", from: "issue:2", to: "issue:99" }, // unknown endpoint
      { id: "e7", type: "mystery-kind", from: "issue:1", to: "issue:2" }, // unmapped type
    ],
  };
}

const BOARD = { title: "test board snapshot", body: "board state", alias: "test-board" };

describe("ingestProviderGraph over a real DefaultKnowledgeStore", () => {
  let dir, store, report;

  before(async () => {
    dir = makeTempDir();
    store = new DefaultKnowledgeStore({ storeRoot: dir });
    report = await ingestProviderGraph(store, fixtureGraph(), { agent: "ingest-tester", board: BOARD });
  });

  test("aliasForNodeId slugifies provider ids into valid store aliases", () => {
    assert.equal(aliasForNodeId("issue:7"), "issue-7");
    assert.equal(aliasForNodeId("PR #12"), "pr-12");
    assert.equal(aliasForNodeId("::"), null);
  });

  test("every node becomes a record; empty body normalizes to the title", async () => {
    assert.equal(report.created, 4); // items only; board tracked via boardRecordId
    assert.equal(report.updated, 0);
    assert.equal(report.byNodeId.size, 4);
    const doc = await store.get(report.byNodeId.get("issue:3"));
    assert.equal(doc.body, "Related doc");
  });

  test("provider identity survives: alias resolves, labels and state become tags", async () => {
    const viaAlias = await store.get("issue-2");
    assert.ok(viaAlias, "record must resolve by slugified provider id");
    assert.equal(viaAlias.id, report.byNodeId.get("issue:2"));
    assert.deepEqual(viaAlias.tags, ["bug", "urgent", "open"]);
  });

  test("untrusted bodies cannot inject wikilink edges", async () => {
    const old = await store.get(report.byNodeId.get("issue:4"));
    const kinds = (old.links || []).map((l) => l.kind).sort();
    assert.deepEqual(kinds, ["merged-into"], "only the provider edge, no [[injected-target]] link");
  });

  test("mappable edges become links; the two bad edges are skipped with reasons", () => {
    assert.equal(report.linked, 5);
    assert.equal(report.skipped.length, 2);
    const reasons = report.skipped.map((s) => s.reason).join(" | ");
    assert.match(reasons, /endpoint not ingested/);
    assert.match(reasons, /unmapped edge type: mystery-kind/);
  });

  test("links carry the inverse-mapped kinds on the source records", async () => {
    const blocker = await store.get(report.byNodeId.get("issue:2"));
    assert.deepEqual(blocker.links.map((l) => l.kind), ["blocks"]);
    const blocked = await store.get(report.byNodeId.get("issue:1"));
    assert.deepEqual(blocked.links.map((l) => l.kind).sort(), ["related", "supersedes"]);
    const doc = await store.get(report.byNodeId.get("issue:3"));
    assert.deepEqual(doc.links.map((l) => l.kind), ["source"]);
  });

  test("edges round-trip through MarkdownVaultProvider with types intact, including blocks and merged-into", async () => {
    const vault = new MarkdownVaultProvider({ store, agent: "ingest-tester" });
    const edges = await vault.readEdges();
    const types = edges.map((e) => e.type).sort();
    assert.deepEqual(types, ["blocks", "evidence-of", "merged-into", "relates", "supersedes"]);
    const blocksEdge = edges.find((e) => e.type === "blocks");
    assert.equal(blocksEdge.from, report.byNodeId.get("issue:2"));
    assert.equal(blocksEdge.to, report.byNodeId.get("issue:1"));
    assert.ok(vault.capabilities().edge_types.includes("blocks"), "capability label must admit blocks");
    assert.ok(vault.capabilities().edge_types.includes("merged-into"), "capability label must admit merged-into");
  });

  test("the Surface projection over the ingested store is not structurally blind (#1214)", async () => {
    const bundle = await buildKnowledgeTrustBundle({ storeRoot: dir });
    assert.equal(bundle.claims.length, 5); // 4 items + board snapshot
    assert.ok(bundle.identityLinks.length >= 1, "relates edge must yield an identity link");
    assert.ok(bundle.evidence.length >= 1, "evidence-of edge must yield evidence");
    const policyIds = (bundle.policies ?? []).map((p) => p.id).join(",");
    assert.match(policyIds, /supersedes/, "supersedes edge must yield a policy");
  });

  test("board snapshot record exists under backlog.board with the requested alias", async () => {
    assert.ok(report.boardRecordId);
    const board = await store.get("test-board");
    assert.equal(board.id, report.boardRecordId);
    assert.equal(board.category, "backlog.board");
    assert.equal(board.type, "snapshot");
  });

  test("re-ingest upserts instead of duplicating, and refreshes updated_at", async () => {
    const boardBefore = await store.get("test-board");
    await new Promise((r) => setTimeout(r, 5));
    const graph2 = fixtureGraph();
    graph2.nodes[0].title = "Blocked feature (renamed)";
    const second = await ingestProviderGraph(store, graph2, { agent: "ingest-tester", board: BOARD });
    assert.equal(second.created, 0, "re-ingest must create nothing");
    assert.equal(second.updated, 4, "re-ingest must update all 4 items (board counted separately)");
    const items = await store.listByCategory("backlog.item");
    assert.equal(items.length, 4, "no duplicate records");
    const renamed = await store.get("issue-1");
    assert.equal(renamed.title, "Blocked feature (renamed)");
    assert.deepEqual(renamed.links.map((l) => l.kind).sort(), ["related", "supersedes"], "idempotent link merge: no duplicate links");
    const boardAfter = await store.get("test-board");
    assert.ok(new Date(boardAfter.updated_at) >= new Date(boardBefore.updated_at), "board updated_at must refresh (TTL signal)");
  });

  test("stale links vanish on re-ingest when the provider edge disappears (D1)", async () => {
    const graph3 = fixtureGraph();
    graph3.edges = graph3.edges.filter((e) => e.id !== "e1"); // blocker resolved upstream
    await ingestProviderGraph(store, graph3, { agent: "ingest-tester", board: BOARD });
    const blocker = await store.get("issue-2");
    assert.deepEqual((blocker.links || []).map((l) => l.kind), [], "resolved blocks edge must not persist in the cache");
    // restore for any later assertions
    await ingestProviderGraph(store, fixtureGraph(), { agent: "ingest-tester", board: BOARD });
    const restored = await store.get("issue-2");
    assert.deepEqual(restored.links.map((l) => l.kind), ["blocks"]);
  });

  test("an alias held by a record outside ingest ownership is never touched (D2)", async () => {
    const dir2 = makeTempDir();
    const store2 = new DefaultKnowledgeStore({ storeRoot: dir2 });
    const curatedId = await store2.create({
      type: "concept", title: "Curated concept", body: "human-written",
      category: "eng.design", aliases: ["issue-5"], provenance: { agent: "human" },
    });
    const r = await ingestProviderGraph(
      store2,
      { nodes: [{ id: "issue:5", title: "Provider text", body: "provider-owned?" }], edges: [] },
      { agent: "ingest-tester" },
    );
    assert.equal(r.created, 0);
    assert.equal(r.updated, 0);
    assert.equal(r.byNodeId.size, 0);
    assert.match(r.skipped[0].reason, /outside ingest ownership/);
    const curated = await store2.get(curatedId);
    assert.equal(curated.body, "human-written", "curated record must be untouched");
    assert.equal(curated.type, "concept");
  });

  test("a board alias held by a non-board record is skipped, not hijacked (D2)", async () => {
    const dir3 = makeTempDir();
    const store3 = new DefaultKnowledgeStore({ storeRoot: dir3 });
    await store3.create({
      type: "raw", title: "Inbox note", body: "personal note",
      category: "inbox", aliases: ["board"], provenance: { agent: "human" },
    });
    const r = await ingestProviderGraph(store3, { nodes: [], edges: [] }, {
      agent: "ingest-tester",
      board: { title: "b", body: "b", alias: "board" },
    });
    assert.equal(r.boardRecordId, null, "board upsert must report failure, not success");
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /outside ingest ownership/);
    const note = await store3.get("board");
    assert.equal(note.body, "personal note");
  });

  test("distinct provider ids colliding on one alias: first wins, rest reported (D2)", async () => {
    const dir4 = makeTempDir();
    const store4 = new DefaultKnowledgeStore({ storeRoot: dir4 });
    const r = await ingestProviderGraph(
      store4,
      { nodes: [{ id: "issue:6", title: "A", body: "a" }, { id: "issue-6", title: "B", body: "b" }], edges: [] },
      { agent: "ingest-tester" },
    );
    assert.equal(r.created, 1);
    assert.equal(r.byNodeId.size, 1);
    assert.match(r.skipped[0].reason, /alias collision/);
  });

  test("stale tags clear when provider labels vanish on re-ingest (D3)", async () => {
    const graph4 = fixtureGraph();
    graph4.nodes[1].attributes = { number: 2, state: "OPEN", labels: [] };
    await ingestProviderGraph(store, graph4, { agent: "ingest-tester", board: BOARD });
    const blocker = await store.get("issue-2");
    assert.deepEqual(blocker.tags, ["open"], "removed labels must not linger as tags");
    await ingestProviderGraph(store, fixtureGraph(), { agent: "ingest-tester", board: BOARD });
  });

  test("duplicate node ids within one graph are skipped and reported", async () => {
    const dupDir = makeTempDir();
    const dupStore = new DefaultKnowledgeStore({ storeRoot: dupDir });
    const r = await ingestProviderGraph(
      dupStore,
      { nodes: [{ id: "issue:9", title: "A", body: "a" }, { id: "issue:9", title: "B", body: "b" }], edges: [] },
      { agent: "ingest-tester" },
    );
    assert.equal(r.created, 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /duplicate node id/);
  });

  test("requires an agent for provenance", async () => {
    await assert.rejects(
      () => ingestProviderGraph(store, fixtureGraph(), {}),
      /requires options\.agent/,
    );
  });
});
