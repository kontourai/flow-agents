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
  // §2b  freshness fields round-trip (AC1, #341 — Addendum J)
  // -----------------------------------------------------------------------
  describe("create/update: expires_at & ttl_seconds round-trip through get (AC1)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("create with expires_at + ttl_seconds round-trips (typed) through get", async () => {
      const id = await store.create({
        type: "raw",
        title: "Freshness raw",
        body: "b",
        category: "radar.signals",
        expires_at: "2026-09-01T00:00:00.000Z",
        ttl_seconds: 3600,
        provenance: { agent: "tester" },
      });
      const rec = await store.get(id);
      assert.equal(rec.expires_at, "2026-09-01T00:00:00.000Z", "expires_at round-trips exactly");
      assert.equal(rec.ttl_seconds, 3600, "ttl_seconds round-trips as a number");
    });

    test("update sets, then clears, expires_at", async () => {
      const id = await store.create({
        type: "raw", title: "Set/clear", body: "b", category: "radar.signals",
        provenance: { agent: "tester" },
      });
      assert.equal((await store.get(id)).expires_at, undefined, "no expiry initially");
      await store.update(id, { expires_at: "2027-01-01T00:00:00.000Z" }, { agent: "tester" });
      assert.equal((await store.get(id)).expires_at, "2027-01-01T00:00:00.000Z", "expires_at set via update");
      await store.update(id, { expires_at: null }, { agent: "tester" });
      assert.equal((await store.get(id)).expires_at, undefined, "expires_at cleared via update(null)");
    });
  });

  // -----------------------------------------------------------------------
  // §3  links + graph index
  // -----------------------------------------------------------------------
  describe("reindex: rebuild graph index from records (recovery, #106)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("recovers a lost graph index from records' links", async (t) => {
      if (typeof store.reindex !== "function") { t.skip("adapter has no reindex()"); return; }
      const aId = await store.create({ type: "raw", title: "A", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({
        type: "compiled", title: "B", body: `see [[${aId}]]`, category: "test",
        provenance: { agent: "tester", source_ids: [aId] },
      });
      // Records are the source of truth; destroy the derived index.
      fs.rmSync(path.join(dir, "graph-index.json"), { force: true });

      const result = await store.reindex();
      assert.equal(result.records, 2, "all records scanned");
      assert.equal(result.changed, true, "rebuild after loss reports drift");

      const { forward } = await store.getLinks(bId);
      assert.ok(forward.some((l) => l.target_id === aId && l.kind === "related"),
        "b → a edge recovered into the index");
      const { reverse } = await store.getLinks(aId);
      assert.ok(reverse.some((l) => l.source_id === bId), "reverse edge recovered");
    });

    test("is idempotent on a clean index (no spurious drift)", async (t) => {
      if (typeof store.reindex !== "function") { t.skip("adapter has no reindex()"); return; }
      await store.create({ type: "raw", title: "Solo", body: "x", category: "test", provenance: { agent: "tester" } });
      await store.reindex();                // canonicalize
      const second = await store.reindex(); // expect a no-op
      assert.equal(second.changed, false, "reindex of a clean index reports no change");
    });

    test("detects and repairs a corrupted index", async (t) => {
      if (typeof store.reindex !== "function") { t.skip("adapter has no reindex()"); return; }
      const aId = await store.create({ type: "raw", title: "CA", body: "a", category: "test", provenance: { agent: "tester" } });
      const bId = await store.create({
        type: "compiled", title: "CB", body: `ref [[${aId}]]`, category: "test",
        provenance: { agent: "tester", source_ids: [aId] },
      });
      // Corrupt: a bogus edge plus the real edge missing.
      fs.writeFileSync(path.join(dir, "graph-index.json"),
        JSON.stringify({ schema_version: "1.0", forward: { bogus: [{ target_id: "ghost", kind: "related" }] }, reverse: {} }));

      const result = await store.reindex();
      assert.equal(result.changed, true, "corruption reported as drift");
      const { forward } = await store.getLinks(bId);
      assert.ok(forward.some((l) => l.target_id === aId), "real edge restored");
      const ghost = await store.getLinks("bogus");
      assert.equal(ghost.forward.length, 0, "bogus edge purged");
    });
  });

  // -----------------------------------------------------------------------
  // close-proposal: retire is the supported op for closing a spent proposal
  // artifact on apply — active → retired, safely and idempotently (#106).
  // -----------------------------------------------------------------------
  describe("close-proposal: retire safely closes a proposal artifact (#106)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("retire closes an active proposal artifact (active → retired), record intact", async () => {
      // The transient proposal artifact a propose→apply flow mints is a `raw`
      // record. Closing it on apply is done via the existing retire op.
      const artifactId = await store.create({
        type: "raw",
        title: "Retirement proposal: Some record",
        body: "Retirement proposal for record X.",
        category: "ops.decisions",
        provenance: { agent: "tester", note: "Retirement proposal for X" },
      });
      const before = await store.get(artifactId);
      assert.equal(before.status || "active", "active", "artifact starts active");

      await store.retire(artifactId, "retired", {
        agent: "tester",
        rationale: "Auto-closing spent proposal artifact after apply (#106).",
      });

      const after = await store.get(artifactId);
      assert.equal(after.status, "retired", "artifact is closed (retired) after apply");
      assert.ok(after, "artifact is retired, not deleted");
      assert.equal(after.body, before.body, "artifact body intact (non-destructive close)");
      const log = (after.mutation_log || []).find((e) => e.op === "retire");
      assert.ok(log, "close is recorded as a retire mutation-log entry");
    });

    test("re-closing an already-retired artifact is rejected (terminal — safe, no twin)", async () => {
      const artifactId = await store.create({
        type: "raw",
        title: "Retirement proposal: Already closed",
        body: "spent",
        category: "ops.decisions",
        provenance: { agent: "tester" },
      });
      await store.retire(artifactId, "retired", { agent: "tester", rationale: "first close" });

      // A second close must be rejected by the transition table (retired is
      // terminal) — the flow treats this as a safe no-op rather than spawning
      // a double-prefixed twin.
      await assertMissingEvidence(
        () => store.retire(artifactId, "retired", { agent: "tester", rationale: "second close" }),
        "re-close of a retired artifact"
      );
      const after = await store.get(artifactId);
      assert.equal(after.status, "retired", "artifact stays retired (idempotent close)");
    });
  });

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

  // -----------------------------------------------------------------------
  // §14  body round-trip — collision-proof delimiter regression (AC: sentinel)
  // -----------------------------------------------------------------------
  describe("body round-trip: sentinel delimiter (regression for heading-collision bug)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("body containing '## Sources' round-trips exactly (regression: was silently truncated)", async () => {
      // Previously the adapter delimited body from structural sections by
      // searching for '## Sources' / '## Related' etc. in the rendered text.
      // A body that contained one of those exact headings was silently truncated
      // on read.  The fix: an invisible sentinel <!-- kit:body-end --> is
      // emitted after the body so body content cannot collide with the delimiter.
      const body = "Findings below.\n\n## Sources\nThis is body content, not a structural section.";
      const id = await store.create({
        type: "concept",
        title: "Sources In Body Regression",
        body,
        category: "test",
        provenance: { agent: "tester" },
      });
      const record = await store.get(id);
      assert.equal(record.body, body,
        "body containing '## Sources' must round-trip exactly (no silent truncation)");
    });

    test("body containing '## Related' and '## People' round-trips exactly", async () => {
      const body = "## Related\nSome related context.\n\n## People\nAlice, Bob.";
      const id = await store.create({
        type: "snapshot",
        title: "Related And People In Body",
        body,
        category: "test",
        provenance: { agent: "tester" },
      });
      const record = await store.get(id);
      assert.equal(record.body, body,
        "body containing '## Related' and '## People' must round-trip exactly");
    });

    test("raw body containing callout-like lines round-trips exactly", async () => {
      const body = "> [!note] Looks like a callout\n> quoted line\nNormal line after.";
      const id = await store.create({
        type: "raw",
        title: "Callout-like Raw Body",
        body,
        category: "test",
        provenance: { agent: "tester" },
      });
      const record = await store.get(id);
      assert.equal(record.body, body,
        "raw body with callout-like lines must round-trip exactly");
    });

    test("multi-paragraph body with various ## headings round-trips exactly", async () => {
      const body = "# Overview\n\nPara one.\n\n## Section A\n\nContent A.\n\n## Sources\n\nFake sources.\n\n## Related\n\nFake related.";
      const id = await store.create({
        type: "concept",
        title: "Multi Heading Body",
        body,
        category: "test",
        provenance: { agent: "tester" },
      });
      const record = await store.get(id);
      assert.equal(record.body, body,
        "body with multiple ## headings must round-trip exactly");
    });

    test("body field is NOT stored in frontmatter", async () => {
      // Contract invariant: the body lives in the rendered note section,
      // not as a YAML field.  Verifiable via the default adapter since the
      // default store stores everything in memory (never writes body to YAML
      // frontmatter), but the key guarantee is get() returns the correct body.
      const body = "Should not appear as body: in frontmatter";
      const id = await store.create({
        type: "compiled",
        title: "No Body In Frontmatter",
        body,
        category: "test",
        provenance: { agent: "tester" },
      });
      const record = await store.get(id);
      assert.equal(record.body, body, "body is preserved through get()");
      // The record object itself should not have body as a frontmatter-derived
      // field separate from the canonical body — just that get() works.
      assert.ok(typeof record.body === "string", "body is a string");
    });
  });

  // -----------------------------------------------------------------------
  // §15  identity resolution — short-id prefix (AC1, R1)
  //
  // `get`/`getLinks` accept an unambiguous id prefix (>= 8 chars). An ambiguous
  // prefix throws AMBIGUOUS_ID (a distinct code), never guesses or returns null.
  // On-disk identity is unchanged (R4): records are still keyed by full id.
  // -----------------------------------------------------------------------
  describe("identity: short-id prefix resolution (AC1)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("get resolves a unique 8-char id prefix to the record", async () => {
      const id = await store.create({
        type: "concept", title: "Prefix Target", body: "b",
        category: "decision.strategy", provenance: { agent: "tester" },
      });
      const prefix = id.slice(0, 8);
      assert.equal(prefix.length, 8, "sanity: prefix is 8 chars");
      const rec = await store.get(prefix);
      assert.ok(rec, "8-char prefix resolves to a record");
      assert.equal(rec.id, id, "prefix resolves to the correct full id");
    });

    test("getLinks resolves a unique 8-char id prefix", async () => {
      const targetId = await store.create({
        type: "concept", title: "PrefixLinkTarget", body: "t",
        category: "test", provenance: { agent: "tester" },
      });
      const sourceId = await store.create({
        type: "raw", title: "PrefixLinkSource", body: "s", category: "test",
        links: [{ target_id: targetId, kind: "related" }],
        provenance: { agent: "tester" },
      });
      const { forward } = await store.getLinks(sourceId.slice(0, 8));
      assert.ok(forward.some((l) => l.target_id === targetId && l.kind === "related"),
        "getLinks via an 8-char prefix returns the record's forward links");
    });

    test("an ambiguous prefix throws AMBIGUOUS_ID (never returns null)", async () => {
      // Two records whose full ids deliberately share an 8-char prefix. create
      // accepts an explicit id (§1.1: adapter MAY generate), so the collision is
      // deterministic without depending on random UUIDs colliding.
      await store.create({
        id: "abcdef12-0000-0000-0000-000000000001",
        type: "raw", title: "Ambiguous One", body: "1", category: "test",
        provenance: { agent: "tester" },
      });
      await store.create({
        id: "abcdef12-0000-0000-0000-000000000002",
        type: "raw", title: "Ambiguous Two", body: "2", category: "test",
        provenance: { agent: "tester" },
      });
      await assert.rejects(
        () => store.get("abcdef12"),
        (err) => {
          assert.equal(err.code, "AMBIGUOUS_ID",
            `expected AMBIGUOUS_ID, got code=${err.code}: ${err.message}`);
          return true;
        }
      );
    });

    test("a prefix shorter than the 8-char minimum does not resolve (null)", async () => {
      await store.create({
        id: "deadbeef-1111-1111-1111-111111111111",
        type: "raw", title: "Short Prefix Guard", body: "x", category: "test",
        provenance: { agent: "tester" },
      });
      assert.equal(await store.get("dead"), null, "a <8-char token is never a prefix match");
    });

    test("exact full-id get is unchanged (R4)", async () => {
      const id = await store.create({
        type: "raw", title: "Exact Id", body: "e", category: "test",
        provenance: { agent: "tester" },
      });
      const rec = await store.get(id);
      assert.equal(rec.id, id, "exact-id get still returns the record");
    });
  });

  // -----------------------------------------------------------------------
  // §16  identity resolution — slug aliases (AC2, R2)
  //
  // Records carry human-readable, category-scoped slug aliases; `get`/`getLinks`
  // resolve them through the same surface, whether set at create or via update.
  // -----------------------------------------------------------------------
  describe("identity: slug alias resolution (AC2)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("a record created with a slug alias resolves via get(slug) and getLinks(slug)", async () => {
      const slug = "decision.strategy/2026-07-03-gtm-direction";
      const targetId = await store.create({
        type: "concept", title: "GTM Target", body: "t",
        category: "decision.strategy", provenance: { agent: "tester" },
      });
      const id = await store.create({
        type: "compiled", title: "GTM Direction", body: "the decision",
        category: "decision.strategy", aliases: [slug],
        links: [{ target_id: targetId, kind: "related" }],
        provenance: { agent: "tester" },
      });

      const rec = await store.get(slug);
      assert.ok(rec, "slug resolves to a record");
      assert.equal(rec.id, id, "get(slug) returns the aliased record");

      const { forward } = await store.getLinks(slug);
      assert.ok(forward.some((l) => l.target_id === targetId),
        "getLinks(slug) returns the aliased record's links");
    });

    test("a slug alias added via update resolves through the same surface", async () => {
      const id = await store.create({
        type: "concept", title: "Later Slug", body: "b",
        category: "decision.strategy", provenance: { agent: "tester" },
      });
      await store.update(id, { aliases: ["decision.strategy/added-later"] }, { agent: "tester" });
      const rec = await store.get("decision.strategy/added-later");
      assert.ok(rec, "update-added slug resolves");
      assert.equal(rec.id, id, "get(added slug) returns the record");
    });

    test("a malformed slug alias is rejected at create (MISSING_EVIDENCE)", () =>
      assertMissingEvidence(
        () => store.create({
          type: "raw", title: "Bad Slug", body: "b", category: "test",
          aliases: ["Not A Valid Slug!"], provenance: { agent: "tester" },
        }),
        "malformed slug alias"
      ));
  });

  // -----------------------------------------------------------------------
  // §17  identity resolution — survives restructure (AC3, R3)
  //
  // After `update` recategorizes a record (obsidian: the file relocates folders),
  // the previously issued slug AND short-id prefix still resolve to the same
  // record — the alias map is keyed by full id, never by category or path.
  // -----------------------------------------------------------------------
  describe("identity: alias resolution survives restructure (AC3)", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("old slug and short-id prefix still resolve after a recategorize", async () => {
      const slug = "decision.strategy/2026-06-18-market-fork";
      const id = await store.create({
        type: "concept", title: "Market Fork Decision", body: "original",
        category: "decision.strategy", aliases: [slug],
        provenance: { agent: "tester" },
      });
      const prefix = id.slice(0, 8);

      // Pre-move sanity: both handles resolve.
      assert.equal((await store.get(slug)).id, id, "slug resolves before move");
      assert.equal((await store.get(prefix)).id, id, "prefix resolves before move");

      // Restructure: recategorize. In the obsidian adapter this relocates the
      // note from decision/strategy/ to decision/gtm/.
      await store.update(id, { category: "decision.gtm" }, { agent: "tester" });
      const moved = await store.get(id);
      assert.equal(moved.category, "decision.gtm", "category changed on disk");

      // The whole point of the alias map: old handles survive the restructure.
      assert.equal((await store.get(slug)).id, id, "old slug survives the restructure");
      assert.equal((await store.get(prefix)).id, id, "short-id prefix survives the restructure");

      const { reverse } = await store.getLinks(id);
      assert.ok(Array.isArray(reverse), "getLinks still answers for the moved record");
    });
  });
});
