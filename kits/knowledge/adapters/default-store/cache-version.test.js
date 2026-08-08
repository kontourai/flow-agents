/**
 * DefaultKnowledgeStore — cache version invalidation (issue #1206, wave 6 / 17).
 *
 * Every mutator must bump getCacheVersion() so consumers that memoize on it
 * (e.g. MarkdownVaultProvider) never serve stale data after a write. Read
 * methods must NOT bump it (a cache-busting read would defeat the point of
 * caching). Drives one store through every public mutator + every public
 * read method and asserts the version only moves on writes.
 *
 * Run: node --test kits/knowledge/adapters/default-store/cache-version.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import DefaultKnowledgeStore from "./index.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kg-cache-version-"));
}

describe("DefaultKnowledgeStore cache version", () => {
  let dir, store;

  before(() => {
    dir = makeTempDir();
    store = new DefaultKnowledgeStore({ storeRoot: dir });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let raw1, raw2, concept1, concept2, proposerA, proposerB;

  test("constructor initializes a stable starting version", () => {
    const v = store.getCacheVersion();
    assert.equal(typeof v, "number");
  });

  test("create() bumps the cache version", async () => {
    const before = store.getCacheVersion();
    raw1 = await store.create({ type: "raw", title: "Raw one", body: "r1", category: "eng", provenance: { agent: "t" } });
    assert.equal(store.getCacheVersion(), before + 1, "create must bump version by exactly one");
  });

  test("a second create() bumps again", async () => {
    const before = store.getCacheVersion();
    raw2 = await store.create({ type: "raw", title: "Raw two", body: "r2", category: "eng", provenance: { agent: "t" } });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("get() does NOT bump the version", async () => {
    const before = store.getCacheVersion();
    await store.get(raw1);
    await store.get(raw1);
    assert.equal(store.getCacheVersion(), before, "get() is a pure read");
  });

  test("getLinks() does NOT bump the version", async () => {
    const before = store.getCacheVersion();
    await store.getLinks(raw1);
    assert.equal(store.getCacheVersion(), before);
  });

  test("listByType() does NOT bump the version", async () => {
    const before = store.getCacheVersion();
    await store.listByType("raw");
    assert.equal(store.getCacheVersion(), before);
  });

  test("listByCategory() does NOT bump the version", async () => {
    const before = store.getCacheVersion();
    await store.listByCategory("eng");
    assert.equal(store.getCacheVersion(), before);
  });

  test("update() bumps the cache version", async () => {
    concept1 = await store.create({ type: "concept", title: "Concept one", body: "c1", category: "eng", provenance: { agent: "t" } });
    const before = store.getCacheVersion();
    await store.update(concept1, { tags: ["x"] }, { agent: "t" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("link() bumps the cache version", async () => {
    concept2 = await store.create({ type: "concept", title: "Concept two", body: "c2", category: "eng", provenance: { agent: "t" } });
    const before = store.getCacheVersion();
    await store.link(concept2, [{ target_id: raw2, kind: "source" }], { agent: "t" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("propose() bumps the cache version", async () => {
    proposerA = await store.create({ type: "raw", title: "Proposer A", body: "pa", category: "eng", provenance: { agent: "t" } });
    const before = store.getCacheVersion();
    await store.propose(concept1, proposerA, { agent: "t", proposal: "widen scope" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("apply() bumps the cache version", async () => {
    const before = store.getCacheVersion();
    await store.apply(concept1, proposerA, { agent: "t", new_body: "c1 v2", rationale: "clarify" });
    assert.equal(store.getCacheVersion(), before + 1);
    const applied = await store.get(concept1);
    assert.equal(applied.body, "c1 v2");
  });

  test("reject() bumps the cache version (separate propose/reject flow)", async () => {
    proposerB = await store.create({ type: "raw", title: "Proposer B", body: "pb", category: "eng", provenance: { agent: "t" } });
    await store.propose(concept2, proposerB, { agent: "t", proposal: "rewrite" });
    const before = store.getCacheVersion();
    await store.reject(concept2, proposerB, { agent: "t", reason: "not aligned" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("supersede() bumps the cache version", async () => {
    const before = store.getCacheVersion();
    await store.supersede(concept1, [concept2], { agent: "t", rationale: "concept1 replaces concept2" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("retire() bumps the cache version", async () => {
    const before = store.getCacheVersion();
    await store.retire(concept2, "retired", { agent: "t", rationale: "superseded" });
    assert.equal(store.getCacheVersion(), before + 1);
  });

  test("reindex() bumps the cache version when the rebuilt graph differs from disk", async () => {
    // Manually corrupt graph-index.json (simulating drift/loss) so reindex()
    // computes changed: true when it rebuilds from the records' own links.
    const graphPath = path.join(dir, "graph-index.json");
    fs.writeFileSync(graphPath, JSON.stringify({ schema_version: "1.0", forward: {}, reverse: {} }, null, 2) + "\n", "utf8");

    const before = store.getCacheVersion();
    const result = await store.reindex();
    assert.equal(result.changed, true, "corrupting the on-disk graph must make reindex() detect a change");
    assert.equal(store.getCacheVersion(), before + 1, "reindex() must bump version when changed");
  });

  test("reindex() does NOT bump the cache version when nothing changed", async () => {
    // The graph index is now authoritative (just rebuilt); a second reindex()
    // immediately after must be a no-op.
    const before = store.getCacheVersion();
    const result = await store.reindex();
    assert.equal(result.changed, false, "an immediate second reindex() must detect no change");
    assert.equal(store.getCacheVersion(), before, "reindex() must not bump version when unchanged");
  });
});
