/**
 * Knowledge Kit — Store Contract Suite
 *
 * Parameterized by adapter module. Set KNOWLEDGE_ADAPTER env var to the
 * absolute path of an adapter module, or pass --adapter=<path> as a CLI arg.
 * Defaults to the bundled default-store adapter.
 *
 * Run:
 *   node --test kits/knowledge/evals/contract-suite/suite.test.js
 *   KNOWLEDGE_ADAPTER=/path/to/my-adapter.js node --test kits/knowledge/evals/contract-suite/suite.test.js
 *
 * Exit 0 = all tests passed. Exit nonzero = failures.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Adapter resolution
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../../../..");

function resolveAdapterPath() {
  // 1. CLI flag: --adapter=<path>
  const adapterFlag = process.argv.find((a) => a.startsWith("--adapter="));
  if (adapterFlag) return path.resolve(adapterFlag.slice("--adapter=".length));

  // 2. Environment variable
  if (process.env.KNOWLEDGE_ADAPTER) return path.resolve(process.env.KNOWLEDGE_ADAPTER);

  // 3. Default: bundled adapter
  return path.join(KIT_ROOT, "kits/knowledge/adapters/default-store/index.js");
}

const adapterPath = resolveAdapterPath();
const adapterModule = await import(adapterPath);
const AdapterClass = adapterModule.default || adapterModule.DefaultKnowledgeStore;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-contract-suite-"));
}

function makeStore(dir) {
  return new AdapterClass({ storeRoot: dir });
}

function assertMissingEvidence(fn, labelHint) {
  return assert.rejects(fn, (err) => {
    assert.equal(
      err.code,
      "MISSING_EVIDENCE",
      `Expected MISSING_EVIDENCE for ${labelHint}; got code=${err.code}: ${err.message}`
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Store Contract Suite", () => {
  // -----------------------------------------------------------------------
  // §1  create — field enforcement
  // -----------------------------------------------------------------------
  describe("create: required field enforcement", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing type", () =>
      assertMissingEvidence(() =>
        store.create({ title: "T", body: "B", category: "test", provenance: { agent: "tester" } }),
        "missing type"
      ));

    test("rejects invalid type", () =>
      assertMissingEvidence(() =>
        store.create({ type: "bogus", title: "T", body: "B", category: "test", provenance: { agent: "tester" } }),
        "invalid type"
      ));

    test("rejects missing title", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", body: "B", category: "test", provenance: { agent: "tester" } }),
        "missing title"
      ));

    test("rejects missing body", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", category: "test", provenance: { agent: "tester" } }),
        "missing body"
      ));

    test("rejects missing category", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", body: "B", provenance: { agent: "tester" } }),
        "missing category"
      ));

    test("rejects empty category", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", body: "B", category: "", provenance: { agent: "tester" } }),
        "empty category"
      ));

    test("rejects invalid category segment", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", body: "B", category: "Bad Cat", provenance: { agent: "tester" } }),
        "invalid category"
      ));

    test("rejects missing provenance.agent", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", body: "B", category: "test", provenance: {} }),
        "missing provenance.agent"
      ));

    test("rejects missing provenance object entirely", () =>
      assertMissingEvidence(() =>
        store.create({ type: "raw", title: "T", body: "B", category: "test" }),
        "missing provenance"
      ));
  });

  // -----------------------------------------------------------------------
  // §2  create — happy path & round-trip (AC3)
  // -----------------------------------------------------------------------
  describe("create: round-trip raw → stored → queried (AC3)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("raw record round-trips with category and links intact", async () => {
      const id = await store.create({
        type: "raw",
        title: "My Raw Note",
        body: "Some raw content [[target-abc]]",
        category: "research.notes",
        tags: ["alpha", "beta"],
        provenance: { agent: "test-agent", session_id: "sess-1" },
      });

      assert.ok(id, "create returns an id");

      const record = await store.get(id);
      assert.ok(record, "record is retrievable after create");
      assert.equal(record.type, "raw");
      assert.equal(record.title, "My Raw Note");
      assert.equal(record.category, "research.notes");
      assert.deepEqual(record.tags, ["alpha", "beta"]);
      assert.ok(record.created_at, "created_at is set");
      assert.ok(record.updated_at, "updated_at is set");
      assert.equal(record.provenance.agent, "test-agent");
      assert.equal(record.provenance.session_id, "sess-1");
    });

    test("compiled record round-trips with source link", async () => {
      const rawId = await store.create({
        type: "raw",
        title: "Source Raw",
        body: "raw source",
        category: "research",
        provenance: { agent: "tester" },
      });

      const compiledId = await store.create({
        type: "compiled",
        title: "Compiled from Raw",
        body: "Normalized content",
        category: "research",
        links: [{ target_id: rawId, kind: "source" }],
        provenance: { agent: "tester", source_ids: [rawId] },
      });

      const compiled = await store.get(compiledId);
      assert.ok(compiled, "compiled record retrievable");
      assert.equal(compiled.type, "compiled");
      assert.ok(Array.isArray(compiled.links), "links is array");
      const srcLink = compiled.links.find((l) => l.target_id === rawId && l.kind === "source");
      assert.ok(srcLink, "source link preserved after round-trip");
    });

    test("concept record round-trips", async () => {
      const cid = await store.create({
        type: "concept",
        title: "Idempotency",
        body: "An operation is idempotent if applying it multiple times yields the same result.",
        category: "engineering.principles",
        provenance: { agent: "tester" },
      });

      const concept = await store.get(cid);
      assert.equal(concept.type, "concept");
      assert.equal(concept.title, "Idempotency");
      assert.equal(concept.category, "engineering.principles");
    });

    test("all three record types are accepted", async () => {
      for (const type of ["raw", "compiled", "concept"]) {
        const id = await store.create({
          type,
          title: `${type} record`,
          body: `body for ${type}`,
          category: "test",
          provenance: { agent: "tester" },
        });
        assert.ok(id, `${type} record created`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // §3  links + graph index
  // -----------------------------------------------------------------------
  describe("links: graph index consistency", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("getLinks returns forward links after create", async () => {
      const targetId = await store.create({
        type: "concept",
        title: "Target Concept",
        body: "target",
        category: "test",
        provenance: { agent: "tester" },
      });
      const sourceId = await store.create({
        type: "raw",
        title: "Source",
        body: "body",
        category: "test",
        links: [{ target_id: targetId, kind: "related" }],
        provenance: { agent: "tester" },
      });

      const { forward, reverse } = await store.getLinks(sourceId);
      assert.ok(forward.some((l) => l.target_id === targetId && l.kind === "related"),
        "forward link present in graph index");

      const { reverse: targetReverse } = await store.getLinks(targetId);
      assert.ok(targetReverse.some((l) => l.source_id === sourceId),
        "reverse link present in graph index");
    });

    test("link op adds links and updates graph index", async () => {
      const aId = await store.create({ type: "raw", title: "A", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({ type: "raw", title: "B", body: "b", category: "test", provenance: { agent: "tester" } });

      await store.link(aId, [{ target_id: bId, kind: "related" }], { agent: "tester" });

      const { forward } = await store.getLinks(aId);
      assert.ok(forward.some((l) => l.target_id === bId && l.kind === "related"),
        "link op reflected in graph index");
    });

    test("link op is idempotent", async () => {
      const aId = await store.create({ type: "raw", title: "Idem A", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({ type: "raw", title: "Idem B", body: "b", category: "test", provenance: { agent: "tester" } });

      await store.link(aId, [{ target_id: bId, kind: "related" }], { agent: "tester" });
      await store.link(aId, [{ target_id: bId, kind: "related" }], { agent: "tester" });

      const { forward } = await store.getLinks(aId);
      const dupes = forward.filter((l) => l.target_id === bId && l.kind === "related");
      assert.equal(dupes.length, 1, "idempotent link: no duplicates");
    });

    test("wikilinks in body are indexed", async () => {
      const conceptId = await store.create({
        type: "concept",
        title: "WikiTarget",
        body: "a concept",
        category: "test",
        provenance: { agent: "tester" },
      });
      const srcId = await store.create({
        type: "raw",
        title: "WikiSource",
        body: `Refers to [[${conceptId}|Wiki Target]].`,
        category: "test",
        provenance: { agent: "tester" },
      });

      const record = await store.get(srcId);
      assert.ok(
        record.links.some((l) => l.target_id === conceptId),
        "wikilink extracted and stored in links array"
      );

      const { forward } = await store.getLinks(srcId);
      assert.ok(
        forward.some((l) => l.target_id === conceptId),
        "wikilink reflected in graph index"
      );
    });
  });

  // -----------------------------------------------------------------------
  // §4  link op — required evidence enforcement
  // -----------------------------------------------------------------------
  describe("link: required evidence enforcement", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing agent", async () => {
      const aId = await store.create({ type: "raw", title: "A", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({ type: "raw", title: "B", body: "b", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.link(aId, [{ target_id: bId, kind: "related" }], {}),
        "link missing agent"
      );
    });

    test("rejects empty links array", async () => {
      const aId = await store.create({ type: "raw", title: "A2", body: "a", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.link(aId, [], { agent: "tester" }),
        "link empty array"
      );
    });

    test("rejects nonexistent target_id", async () => {
      const aId = await store.create({ type: "raw", title: "A3", body: "a", category: "test", provenance: { agent: "tester" } });
      await assert.rejects(
        () => store.link(aId, [{ target_id: "nonexistent-id-xyz", kind: "related" }], { agent: "tester" }),
        { code: "NOT_FOUND" }
      );
    });
  });

  // -----------------------------------------------------------------------
  // §5  update — required evidence enforcement
  // -----------------------------------------------------------------------
  describe("update: required evidence enforcement", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing agent", async () => {
      const id = await store.create({ type: "raw", title: "T", body: "B", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.update(id, { title: "New Title" }, {}),
        "update missing agent"
      );
    });

    test("rejects no-op update (no mutable fields supplied)", async () => {
      const id = await store.create({ type: "raw", title: "T", body: "B", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.update(id, {}, { agent: "tester" }),
        "update no fields"
      );
    });

    test("updates fields and refreshes updated_at", async () => {
      const id = await store.create({ type: "raw", title: "Original", body: "B", category: "test", provenance: { agent: "tester" } });
      const before = await store.get(id);
      await new Promise((r) => setTimeout(r, 5)); // ensure different timestamp
      await store.update(id, { title: "Revised" }, { agent: "tester" });
      const after = await store.get(id);
      assert.equal(after.title, "Revised");
      assert.ok(after.updated_at >= before.updated_at, "updated_at refreshed");
    });

    test("update with new links updates graph index", async () => {
      const aId = await store.create({ type: "raw", title: "A", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({ type: "raw", title: "B", body: "b", category: "test", provenance: { agent: "tester" } });
      await store.update(aId, { links: [{ target_id: bId, kind: "refines" }] }, { agent: "tester" });
      const { forward } = await store.getLinks(aId);
      assert.ok(forward.some((l) => l.target_id === bId && l.kind === "refines"),
        "updated links reflected in graph index");
    });
  });

  // -----------------------------------------------------------------------
  // §6  propose — required evidence enforcement
  // -----------------------------------------------------------------------
  describe("propose: required evidence enforcement", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing agent", async () => {
      const cid = await store.create({ type: "concept", title: "C", body: "c", category: "test", provenance: { agent: "tester" } });
      const pid = await store.create({ type: "raw", title: "P", body: "p", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.propose(cid, pid, { proposal: "change body" }),
        "propose missing agent"
      );
    });

    test("rejects missing proposal text", async () => {
      const cid = await store.create({ type: "concept", title: "C2", body: "c", category: "test", provenance: { agent: "tester" } });
      const pid = await store.create({ type: "raw", title: "P2", body: "p", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.propose(cid, pid, { agent: "tester" }),
        "propose missing proposal"
      );
    });

    test("propose accepts any record type as target (Addendum B: retire flow needs non-concept targets)", async () => {
      // Addendum B (S7) extends propose to accept any record type as the target,
      // enabling the retire flow to attach proposals to compiled/raw/snapshot records.
      const rawTarget = await store.create({ type: "raw", title: "NC", body: "nc", category: "test", provenance: { agent: "tester" } });
      const pid = await store.create({ type: "raw", title: "P3", body: "p", category: "test", provenance: { agent: "tester" } });
      // Should NOT throw — all record types are valid proposal targets
      await store.propose(rawTarget, pid, { agent: "tester", proposal: "retirement proposal" });
      const { forward } = await store.getLinks(pid);
      assert.ok(
        forward.some((l) => l.target_id === rawTarget && l.kind === "proposes"),
        "propose on raw record creates proposes link (Addendum B extension)"
      );
    });

    test("happy path: propose creates proposes link", async () => {
      const cid = await store.create({ type: "concept", title: "My Concept", body: "original", category: "test", provenance: { agent: "tester" } });
      const pid = await store.create({ type: "raw", title: "Proposer", body: "I propose", category: "test", provenance: { agent: "tester" } });
      await store.propose(cid, pid, { agent: "tester", proposal: "Extend definition to cover edge case X." });

      const { forward } = await store.getLinks(pid);
      assert.ok(
        forward.some((l) => l.target_id === cid && l.kind === "proposes"),
        "proposes link created in graph index"
      );
    });
  });

  // -----------------------------------------------------------------------
  // §7  apply — required evidence enforcement
  // -----------------------------------------------------------------------
  describe("apply: required evidence enforcement", () => {
    let dir, store;
    let conceptId, proposerId;
    before(async () => {
      dir = makeTempDir();
      store = makeStore(dir);
      conceptId = await store.create({ type: "concept", title: "Applyable", body: "v1", category: "test", provenance: { agent: "tester" } });
      proposerId = await store.create({ type: "raw", title: "Proposer", body: "p", category: "test", provenance: { agent: "tester" } });
      await store.propose(conceptId, proposerId, { agent: "tester", proposal: "Update to v2" });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing agent", () =>
      assertMissingEvidence(
        () => store.apply(conceptId, proposerId, { new_body: "v2", rationale: "better" }),
        "apply missing agent"
      ));

    test("rejects missing new_body", () =>
      assertMissingEvidence(
        () => store.apply(conceptId, proposerId, { agent: "tester", rationale: "better" }),
        "apply missing new_body"
      ));

    test("rejects missing rationale", () =>
      assertMissingEvidence(
        () => store.apply(conceptId, proposerId, { agent: "tester", new_body: "v2" }),
        "apply missing rationale"
      ));

    test("rejects apply when no proposes link exists", async () => {
      const otherId = await store.create({ type: "raw", title: "Other", body: "o", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.apply(conceptId, otherId, { agent: "tester", new_body: "v2", rationale: "r" }),
        "apply no proposes link"
      );
    });

    test("happy path: apply updates concept body", async () => {
      await store.apply(conceptId, proposerId, { agent: "tester", new_body: "v2 body", rationale: "more precise" });
      const concept = await store.get(conceptId);
      assert.equal(concept.body, "v2 body", "concept body updated after apply");
    });
  });

  // -----------------------------------------------------------------------
  // §8  reject — required evidence enforcement
  // -----------------------------------------------------------------------
  describe("reject: required evidence enforcement", () => {
    let dir, store;
    let conceptId, proposerId;
    before(async () => {
      dir = makeTempDir();
      store = makeStore(dir);
      conceptId = await store.create({ type: "concept", title: "Rejectable", body: "stable", category: "test", provenance: { agent: "tester" } });
      proposerId = await store.create({ type: "raw", title: "Proposer", body: "p", category: "test", provenance: { agent: "tester" } });
      await store.propose(conceptId, proposerId, { agent: "tester", proposal: "Controversial change" });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("rejects missing agent", () =>
      assertMissingEvidence(
        () => store.reject(conceptId, proposerId, { reason: "not suitable" }),
        "reject missing agent"
      ));

    test("rejects missing reason", () =>
      assertMissingEvidence(
        () => store.reject(conceptId, proposerId, { agent: "tester" }),
        "reject missing reason"
      ));

    test("rejects reject when no proposes link exists", async () => {
      const otherId = await store.create({ type: "raw", title: "Other", body: "o", category: "test", provenance: { agent: "tester" } });
      await assertMissingEvidence(
        () => store.reject(conceptId, otherId, { agent: "tester", reason: "r" }),
        "reject no proposes link"
      );
    });

    test("happy path: reject does not mutate concept body", async () => {
      const bodyBefore = (await store.get(conceptId)).body;
      await store.reject(conceptId, proposerId, { agent: "tester", reason: "Not aligned with goals." });
      const concept = await store.get(conceptId);
      assert.equal(concept.body, bodyBefore, "concept body unchanged after reject");
    });
  });

  // -----------------------------------------------------------------------
  // §9  listByCategory
  // -----------------------------------------------------------------------
  describe("listByCategory", () => {
    let dir, store;
    before(async () => {
      dir = makeTempDir();
      store = makeStore(dir);
      await store.create({ type: "raw", title: "A", body: "a", category: "eng.api", provenance: { agent: "tester" } });
      await store.create({ type: "raw", title: "B", body: "b", category: "eng.api.rest", provenance: { agent: "tester" } });
      await store.create({ type: "raw", title: "C", body: "c", category: "eng.db", provenance: { agent: "tester" } });
      await store.create({ type: "raw", title: "D", body: "d", category: "design", provenance: { agent: "tester" } });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("exact match returns only matching records", async () => {
      const results = await store.listByCategory("eng.api");
      assert.equal(results.length, 1);
      assert.equal(results[0].title, "A");
    });

    test("prefix match returns record and all descendants", async () => {
      const results = await store.listByCategory("eng", { prefix: true });
      assert.equal(results.length, 3, "all eng.* records returned");
    });

    test("no match returns empty array", async () => {
      const results = await store.listByCategory("nonexistent.cat");
      assert.equal(results.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // §10  listByType
  // -----------------------------------------------------------------------
  describe("listByType", () => {
    let dir, store;
    before(async () => {
      dir = makeTempDir();
      store = makeStore(dir);
      await store.create({ type: "raw", title: "R1", body: "r", category: "test", provenance: { agent: "tester" } });
      await store.create({ type: "raw", title: "R2", body: "r", category: "test", provenance: { agent: "tester" } });
      await store.create({ type: "compiled", title: "C1", body: "c", category: "test", provenance: { agent: "tester" } });
      await store.create({ type: "concept", title: "CN1", body: "cn", category: "test", provenance: { agent: "tester" } });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("listByType raw returns only raw records", async () => {
      const results = await store.listByType("raw");
      assert.ok(results.length >= 2, "at least 2 raw records");
      assert.ok(results.every((r) => r.type === "raw"), "all returned are raw");
    });

    test("listByType compiled returns only compiled records", async () => {
      const results = await store.listByType("compiled");
      assert.ok(results.every((r) => r.type === "compiled"));
    });

    test("listByType concept returns only concept records", async () => {
      const results = await store.listByType("concept");
      assert.ok(results.every((r) => r.type === "concept"));
    });
  });

  // -----------------------------------------------------------------------
  // §11  mutation log
  // -----------------------------------------------------------------------
  describe("mutation log", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("update appends mutation log entry", async () => {
      const id = await store.create({ type: "raw", title: "T", body: "B", category: "test", provenance: { agent: "tester" } });
      await store.update(id, { title: "T2" }, { agent: "editor", note: "Fixed title" });
      const record = await store.get(id);
      assert.ok(Array.isArray(record.mutation_log), "mutation_log is array");
      const entry = record.mutation_log.find((e) => e.op === "update");
      assert.ok(entry, "update entry in mutation log");
      assert.equal(entry.agent, "editor");
    });

    test("propose appends mutation log entry on concept", async () => {
      const cid = await store.create({ type: "concept", title: "ML Concept", body: "body", category: "test", provenance: { agent: "tester" } });
      const pid = await store.create({ type: "raw", title: "ML Proposer", body: "p", category: "test", provenance: { agent: "tester" } });
      await store.propose(cid, pid, { agent: "tester", proposal: "Extend" });
      const concept = await store.get(cid);
      const entry = concept.mutation_log.find((e) => e.op === "propose");
      assert.ok(entry, "propose entry in concept mutation log");
    });
  });

  // -----------------------------------------------------------------------
  // §12  get returns null for missing record
  // -----------------------------------------------------------------------
  describe("get: missing record", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("get returns null for nonexistent id", async () => {
      const result = await store.get("definitely-not-a-real-id-00000");
      assert.equal(result, null);
    });
  });

  // -----------------------------------------------------------------------
  // §13  graph index file consistency
  // -----------------------------------------------------------------------
  describe("graph index file consistency", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("graph-index.json is valid JSON after operations", async () => {
      const aId = await store.create({ type: "raw", title: "GA", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({ type: "concept", title: "GB", body: "b", category: "test", provenance: { agent: "tester" } });
      await store.link(aId, [{ target_id: bId, kind: "related" }], { agent: "tester" });

      const graphPath = path.join(dir, "graph-index.json");
      assert.ok(fs.existsSync(graphPath), "graph-index.json exists");
      const raw = fs.readFileSync(graphPath, "utf8");
      let graph;
      assert.doesNotThrow(() => { graph = JSON.parse(raw); }, "graph-index.json is valid JSON");
      assert.equal(graph.schema_version, "1.0", "graph has correct schema_version");
      assert.ok(graph.forward, "graph has forward index");
      assert.ok(graph.reverse, "graph has reverse index");
    });

    test("graph index forward and reverse are consistent", async () => {
      const xId = await store.create({ type: "raw", title: "GX", body: "x", category: "test", provenance: { agent: "tester" } });
      const yId = await store.create({ type: "raw", title: "GY", body: "y", category: "test", provenance: { agent: "tester" } });
      await store.link(xId, [{ target_id: yId, kind: "refines" }], { agent: "tester" });

      const graphPath = path.join(dir, "graph-index.json");
      const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));

      const fwd = (graph.forward[xId] || []).some((l) => l.target_id === yId && l.kind === "refines");
      const rev = (graph.reverse[yId] || []).some((l) => l.source_id === xId && l.kind === "refines");
      assert.ok(fwd, "forward index has the link");
      assert.ok(rev, "reverse index has the backlink");
    });
  });
});
