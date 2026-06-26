/**
 * Knowledge Kit — Glossary-Sync Eval Suite  (#106 hygiene #3)
 *
 * knowledge.glossary-sync keeps the glossary (concept records) in sync with the
 * canonical docs that DEFINE those terms. It surveys a CONFIGURABLE list of
 * canonical source docs (the "glossary source list" — opt-in), extracts
 * term→definition entries with a PLUGGABLE extractor, and classifies each entry
 * against existing concepts:
 *   - "gap":      no concept captures the term → propose a canonical definition
 *   - "outdated": a concept exists but its body has drifted → propose the update
 *   - "current":  the concept matches the canonical definition → no-op
 *
 * Read-only by DEFAULT (returns the plan, mutates nothing). With apply=true it
 * enacts the plan via the EXISTING concept-record ops (create → propose → apply
 * for gaps; propose → apply for drift), with the canonical doc as the proposer —
 * consume-never-fork.
 *
 * Covers:
 *   - default term extraction from canonical-doc glossary lines (bold + colon).
 *   - classification: gap / outdated / current, each citing its source doc.
 *   - drift detection is whitespace-insensitive (cosmetic reflow is NOT drift).
 *   - term matching is case/space-insensitive, scoped to the concept category.
 *   - configurable source list: record id + category selector; opt-in empty list;
 *     an unknown source id is rejected (the source list is evidence).
 *   - pluggable term extractor is honoured.
 *   - read-only invariant: default mode mutates no record.
 *   - apply mode: gaps create a concept via create→propose→apply; drift goes
 *     through propose→apply with the canonical doc as proposer; the "proposes"
 *     link + mutation_log entries prove the gated path was used.
 *   - gate telemetry (collect-gate, diff-gate, propose-gate) is emitted.
 *
 * Run:
 *   node --test kits/knowledge/evals/glossary-sync/suite.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");

const adapterPath = path.join(KIT_ROOT, "adapters/default-store/index.js");
const runnerPath = path.join(KIT_ROOT, "adapters/flow-runner/index.js");

const { DefaultKnowledgeStore } = await import(adapterPath);
const { KnowledgeFlowRunner, glossarySync } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-glossary-sync-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "glossary-sync-test-runner",
    sessionId: "glossary-sync-session-001",
  });
}

function readTelemetryEvents(dir) {
  const sinkPath = path.join(dir, ".telemetry", "full.jsonl");
  if (!fs.existsSync(sinkPath)) return [];
  return fs.readFileSync(sinkPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function recordBytes(dir, id) {
  return fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
}

// A canonical doc whose body holds a small glossary in the two default shapes.
const GLOSSARY_BODY = [
  "# Engineering Glossary",
  "",
  "**Idempotency** — An operation that can be applied multiple times without changing the result beyond the initial application.",
  "- **API Gateway**: A single entry point that routes requests to backend services.",
  "Eventual Consistency: A consistency model where replicas converge given no new writes.",
  "",
  "Some prose that is not a glossary entry and should be ignored.",
].join("\n");

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Glossary-Sync Suite (#106)", () => {
  let dir;
  let store;
  let runner;
  let canonicalDocId;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // The canonical doc that DEFINES the engineering glossary.
    canonicalDocId = await store.create({
      type: "compiled",
      title: "Engineering Glossary (canonical)",
      body: GLOSSARY_BODY,
      category: "engineering.glossary",
      provenance: { agent: "fixture" },
    });

    // An existing concept that MATCHES its canonical definition → "current".
    await store.create({
      type: "concept",
      title: "Idempotency",
      body: "An operation that can be applied multiple times without changing the result beyond the initial application.",
      category: "engineering.glossary",
      provenance: { agent: "fixture" },
    });

    // An existing concept whose body has DRIFTED from the canonical → "outdated".
    await store.create({
      type: "concept",
      title: "API Gateway",
      body: "Old definition: a reverse proxy in front of microservices.",
      category: "engineering.glossary",
      provenance: { agent: "fixture" },
    });

    // (No concept for "Eventual Consistency" → it is a GAP.)
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseConfig = () => ({ sources: [canonicalDocId] });

  test("default extractor pulls term→definition entries from the canonical doc", async () => {
    const result = await runner.glossarySync(baseConfig());
    assert.equal(result.sourcesAudited, 1, "one canonical doc audited");
    assert.equal(result.entries, 3, "three glossary entries extracted (prose ignored)");
  });

  test("classification: gap / outdated / current — each cites its source doc", async () => {
    const result = await runner.glossarySync(baseConfig());

    const gapTerms = result.gaps.map((g) => g.term);
    const outdatedTerms = result.outdated.map((o) => o.term);
    const currentTerms = result.current.map((c) => c.term);

    assert.deepEqual(gapTerms, ["Eventual Consistency"], "the undefined term is a gap");
    assert.deepEqual(outdatedTerms, ["API Gateway"], "the drifted concept is outdated");
    assert.deepEqual(currentTerms, ["Idempotency"], "the matching concept is current");

    for (const entry of [...result.gaps, ...result.outdated, ...result.current]) {
      assert.equal(entry.sourceDocId, canonicalDocId, "every entry cites its source doc id");
      assert.ok(entry.sourceDocTitle, "every entry cites its source doc title");
      assert.ok(entry.definition, "every entry carries the canonical definition");
      assert.equal(entry.category, "engineering.glossary", "entry carries the concept category");
    }
    // Outdated entries additionally cite the drifted body (the evidence of drift).
    const apiGw = result.outdated[0];
    assert.equal(apiGw.classification, "outdated");
    assert.equal(apiGw.conceptId !== undefined, true, "outdated entry references the existing concept");
    assert.match(apiGw.currentBody, /reverse proxy/, "outdated entry cites the drifted body");
  });

  test("drift detection is whitespace-insensitive (cosmetic reflow is not drift)", async () => {
    const wdir = makeTempDir();
    const wstore = makeStore(wdir);
    const wrunner = makeRunner(wstore, wdir);
    try {
      const docId = await wstore.create({
        type: "compiled",
        title: "WS glossary",
        body: "**Term One** — A   definition with   irregular spacing.",
        category: "ws.glossary",
        provenance: { agent: "fixture" },
      });
      // Concept body differs from canonical ONLY in whitespace.
      await wstore.create({
        type: "concept",
        title: "Term One",
        body: "A definition with irregular spacing.",
        category: "ws.glossary",
        provenance: { agent: "fixture" },
      });
      const result = await wrunner.glossarySync({ sources: [docId] });
      assert.equal(result.outdated.length, 0, "whitespace-only difference is NOT flagged as drift");
      assert.equal(result.current.length, 1, "it is classified current");
    } finally {
      fs.rmSync(wdir, { recursive: true, force: true });
    }
  });

  test("term matching is case/space-insensitive and scoped to the concept category", async () => {
    const cdir = makeTempDir();
    const cstore = makeStore(cdir);
    const crunner = makeRunner(cstore, cdir);
    try {
      const docId = await cstore.create({
        type: "compiled",
        title: "Case glossary",
        body: "**api  GATEWAY** — Canonical gateway definition.",
        category: "svc.glossary",
        provenance: { agent: "fixture" },
      });
      // Concept titled with different case/spacing — must still match (current).
      await cstore.create({
        type: "concept",
        title: "API Gateway",
        body: "Canonical gateway definition.",
        category: "svc.glossary",
        provenance: { agent: "fixture" },
      });
      // A same-named concept in a DIFFERENT category must NOT match → still a gap.
      await cstore.create({
        type: "concept",
        title: "API Gateway",
        body: "Unrelated category definition.",
        category: "other.glossary",
        provenance: { agent: "fixture" },
      });
      const result = await crunner.glossarySync({ sources: [docId] });
      assert.equal(result.gaps.length, 0, "case/space-insensitive match prevents a false gap");
      assert.equal(result.current.length, 1, "matched in-category despite case/spacing differences");
    } finally {
      fs.rmSync(cdir, { recursive: true, force: true });
    }
  });

  test("configurable source list: empty list is opt-in no-op; unknown source rejected", async () => {
    const empty = await runner.glossarySync({ sources: [] });
    assert.equal(empty.sourcesAudited, 0, "empty source list audits nothing (opt-in)");
    assert.equal(empty.entries, 0);
    assert.equal(empty.gaps.length + empty.outdated.length + empty.current.length, 0);

    await assert.rejects(
      () => runner.glossarySync({ sources: ["does-not-exist"] }),
      /source doc not found/,
      "an unknown source id is rejected — the source list is evidence"
    );
  });

  test("category selector resolves multiple canonical docs", async () => {
    const sdir = makeTempDir();
    const sstore = makeStore(sdir);
    const srunner = makeRunner(sstore, sdir);
    try {
      await sstore.create({
        type: "compiled", title: "Doc A", category: "kb.glossary",
        body: "**Alpha** — First term.", provenance: { agent: "fixture" },
      });
      await sstore.create({
        type: "compiled", title: "Doc B", category: "kb.glossary",
        body: "**Beta** — Second term.", provenance: { agent: "fixture" },
      });
      const result = await srunner.glossarySync({
        sources: [{ category: "kb.glossary" }],
      });
      assert.equal(result.sourcesAudited, 2, "both docs in the category are collected");
      assert.deepEqual(result.gaps.map((g) => g.term).sort(), ["Alpha", "Beta"]);
    } finally {
      fs.rmSync(sdir, { recursive: true, force: true });
    }
  });

  test("pluggable term extractor is honoured", async () => {
    const customExtractor = () => [
      { term: "Custom Term", definition: "A definition from a custom extractor." },
    ];
    const result = await runner.glossarySync({
      sources: [canonicalDocId],
      termExtractor: customExtractor,
    });
    assert.equal(result.entries, 1, "only the custom extractor's entries are used");
    assert.equal(result.gaps[0].term, "Custom Term");
  });

  test("read-only invariant: default mode mutates no record", async () => {
    const before = {};
    const ids = fs.readdirSync(path.join(dir, "records")).map((f) => f.replace(/\.md$/, ""));
    for (const id of ids) before[id] = recordBytes(dir, id);

    await runner.glossarySync(baseConfig());

    const idsAfter = fs.readdirSync(path.join(dir, "records")).map((f) => f.replace(/\.md$/, ""));
    assert.deepEqual(idsAfter.sort(), ids.sort(), "no record is created by a read-only sync");
    for (const id of ids) {
      assert.equal(recordBytes(dir, id), before[id], `record ${id} is byte-identical after read-only sync`);
    }
    // And no proposal was applied.
    const result = await runner.glossarySync(baseConfig());
    assert.equal(result.applied.length, 0, "read-only mode applies nothing");
  });

  test("apply mode: a gap is enacted via create→propose→apply with the doc as proposer", async () => {
    const adir = makeTempDir();
    const astore = makeStore(adir);
    const arunner = makeRunner(astore, adir);
    try {
      const docId = await astore.create({
        type: "compiled", title: "Apply glossary", category: "app.glossary",
        body: "**Backpressure** — A mechanism to slow producers when consumers lag.",
        provenance: { agent: "fixture" },
      });
      const result = await arunner.glossarySync({ sources: [docId], apply: true });

      assert.equal(result.applied.length, 1, "one entry applied");
      const { conceptId, action } = result.applied[0];
      assert.equal(action, "create", "a gap is enacted as a concept creation");

      // The concept now exists with the canonical definition.
      const concept = await astore.get(conceptId);
      assert.equal(concept.type, "concept");
      assert.equal(concept.title, "Backpressure");
      assert.match(concept.body, /slow producers/, "concept body is the canonical definition");

      // The canonical doc is the proposer: it has a "proposes" link to the concept.
      const { forward } = await astore.getLinks(docId);
      assert.ok(
        forward.some((l) => l.target_id === conceptId && l.kind === "proposes"),
        "the canonical doc proposes the concept (consume-never-fork lineage)"
      );
      // Concept mutation log shows the gated propose→apply path.
      const ops = (concept.mutation_log || []).map((e) => e.op);
      assert.ok(ops.includes("propose"), "concept has a propose log entry");
      assert.ok(ops.includes("apply"), "concept has an apply log entry");
    } finally {
      fs.rmSync(adir, { recursive: true, force: true });
    }
  });

  test("apply mode: drift is enacted via propose→apply on the existing concept", async () => {
    const ddir = makeTempDir();
    const dstore = makeStore(ddir);
    const drunner = makeRunner(dstore, ddir);
    try {
      const docId = await dstore.create({
        type: "compiled", title: "Drift glossary", category: "drift.glossary",
        body: "**Saga** — The canonical, up-to-date saga definition.",
        provenance: { agent: "fixture" },
      });
      const conceptId = await dstore.create({
        type: "concept", title: "Saga", category: "drift.glossary",
        body: "Stale: an old saga definition.",
        provenance: { agent: "fixture" },
      });
      const result = await drunner.glossarySync({ sources: [docId], apply: true });

      assert.equal(result.applied.length, 1);
      assert.equal(result.applied[0].action, "update", "drift is enacted as an update");
      assert.equal(result.applied[0].conceptId, conceptId, "the existing concept is updated, not forked");

      const concept = await dstore.get(conceptId);
      assert.match(concept.body, /up-to-date saga/, "concept body refreshed to the canonical definition");
      const ops = (concept.mutation_log || []).map((e) => e.op);
      assert.ok(ops.includes("propose") && ops.includes("apply"), "gated propose→apply path used");

      // A subsequent read-only sync now sees it as current (no remaining drift).
      const after = await drunner.glossarySync({ sources: [docId] });
      assert.equal(after.outdated.length, 0, "no drift remains after apply");
      assert.equal(after.current.length, 1);
    } finally {
      fs.rmSync(ddir, { recursive: true, force: true });
    }
  });

  test("gate telemetry: collect-gate, diff-gate, propose-gate events are emitted", async () => {
    const tdir = makeTempDir();
    const tstore = makeStore(tdir);
    const trunner = makeRunner(tstore, tdir);
    try {
      const docId = await tstore.create({
        type: "compiled", title: "Telemetry glossary", category: "tel.glossary",
        body: "**Quorum** — The minimum number of nodes for a decision.",
        provenance: { agent: "fixture" },
      });
      const result = await trunner.glossarySync({ sources: [docId] });

      assert.ok(
        result.telemetryEvents.length >= 6,
        "collect + diff + propose gates produce at least 6 in/out events"
      );
      const persisted = readTelemetryEvents(tdir);
      const syncEvents = persisted.filter((e) =>
        JSON.stringify(e).includes("knowledge.glossary-sync")
      );
      assert.ok(syncEvents.length > 0, "glossary-sync flow telemetry is persisted to the sink");
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  });

  test("module-level glossarySync export delegates to the runner", async () => {
    const result = await glossarySync({
      store,
      workspace: dir,
      agent: "glossary-sync-test-runner",
      sources: [canonicalDocId],
    });
    assert.deepEqual(result.gaps.map((g) => g.term), ["Eventual Consistency"]);
    assert.deepEqual(result.outdated.map((o) => o.term), ["API Gateway"]);
  });
});
