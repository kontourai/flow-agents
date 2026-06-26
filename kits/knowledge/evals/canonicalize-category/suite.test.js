/**
 * Knowledge Kit — Canonicalize-Category Eval Suite  (#106 hygiene #4)
 *
 * knowledge.canonicalize-category audits category sprawl and proposes
 * flattening / regrouping / retirement — each finding citing its evidence
 * (the metric that fired + the offending category / record ids). The audit is
 * READ-ONLY, OPTIONAL, and CONFIGURABLE (each check independently toggleable).
 *
 * Covers:
 *   - orphan-prefix: an intermediate prefix node holding no record directly but
 *     with descendants is flagged (→ flatten); a multi-segment prefix carrying
 *     exactly one record (deep path) is flagged (→ flatten).
 *   - too-many-leaves: a parent fanning out past the leaf budget is flagged
 *     (→ regroup) and lists the offending leaves; boundary (count == budget is
 *     NOT flagged, count > budget IS flagged).
 *   - implemented-active: a status:"active" record carrying an implemented
 *     marker tag is flagged (→ retire); marker matching is case-insensitive.
 *   - every finding cites its kind + category + recordIds + metric + evidence.
 *   - opt-in: a disabled check (orphan off / no leaf budget / empty markers)
 *     contributes no findings.
 *   - retired records are excluded from the survey (terminal).
 *   - read-only invariant: no record is mutated by the audit.
 *   - gate telemetry (survey-gate + propose-gate) is emitted.
 *   - module-level canonicalizeCategory export delegates to the runner.
 *
 * Run:
 *   node --test kits/knowledge/evals/canonicalize-category/suite.test.js
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
const { KnowledgeFlowRunner, canonicalizeCategory } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-canonicalize-category-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "canonicalize-category-test-runner",
    sessionId: "canonicalize-category-session-001",
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

let _seq = 0;
function rec(store, { id, type = "raw", title, category, tags }) {
  return store.create({
    id: id || `rec-${++_seq}`,
    type,
    title: title || `Record ${id || _seq}`,
    body: `Body of ${title || id || _seq}`,
    category,
    tags: tags || [],
    provenance: { agent: "fixture" },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Canonicalize-Category Suite (#106)", () => {
  let dir;
  let store;
  let runner;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // ── orphan-prefix: empty intermediate node ──────────────────────────────
    // No record sits at "platform.api" directly, but two do under it. The
    // "platform.api" prefix is an empty intermediate node → flatten.
    await rec(store, { id: "api-auth", title: "Auth endpoint", category: "platform.api.auth" });
    await rec(store, { id: "api-users", title: "Users endpoint", category: "platform.api.users" });

    // ── orphan-prefix: single-record deep path ──────────────────────────────
    // "archive.2019.notes.misc" carries exactly one record and nothing else in
    // its subtree → a deep path with no branching value → flatten.
    await rec(store, { id: "lonely", title: "Lone deep note", category: "archive.2019.notes.misc" });

    // ── too-many-leaves: "tags" parent fans out to 4 direct leaf categories ──
    await rec(store, { id: "t-red", title: "Red", category: "tags.red" });
    await rec(store, { id: "t-green", title: "Green", category: "tags.green" });
    await rec(store, { id: "t-blue", title: "Blue", category: "tags.blue" });
    await rec(store, { id: "t-amber", title: "Amber", category: "tags.amber" });

    // ── implemented-active: active record carrying an implemented marker ─────
    await rec(store, {
      id: "shipped-feature", title: "Shipped feature note",
      category: "work.features", tags: ["Implemented", "q2"],
    });
    // A control: active but no marker → never flagged as implemented-active.
    await rec(store, {
      id: "open-feature", title: "Open feature note",
      category: "work.features", tags: ["q2"],
    });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fullConfig = () => ({
    checkOrphanPrefixes: true,
    maxLeavesPerParent: 3,
    implementedMarkers: ["implemented", "shipped"],
  });

  test("orphan-prefix: empty intermediate node is flagged for flattening", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    const f = result.findings.find(
      (x) => x.kind === "orphan-prefix" && x.category === "platform.api"
    );
    assert.ok(f, "platform.api (no direct record, has descendants) is flagged");
    assert.equal(f.metric, "empty-intermediate-node");
    assert.equal(f.proposedAction, "flatten");
    assert.deepEqual(f.recordIds.sort(), ["api-auth", "api-users"]);
    assert.equal(f.evidence.directRecordCount, 0);
    assert.equal(f.evidence.subtreeRecordCount, 2);
  });

  test("orphan-prefix: single-record deep path is flagged for flattening", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    const f = result.findings.find(
      (x) => x.kind === "orphan-prefix" && x.category === "archive.2019.notes.misc"
    );
    assert.ok(f, "the deep single-record path is flagged");
    assert.equal(f.metric, "single-record-deep-path");
    assert.equal(f.proposedAction, "flatten");
    assert.deepEqual(f.recordIds, ["lonely"]);
    assert.equal(f.evidence.subtreeRecordCount, 1);
  });

  test("a lone deep record yields ONE finding, not one per empty ancestor", async () => {
    // archive.2019.notes.misc carries one record; its empty ancestors (archive,
    // archive.2019, archive.2019.notes) must NOT each produce a finding — the
    // single-record-deep-path finding at the leaf subsumes the whole chain.
    const result = await runner.canonicalizeCategory({ checkOrphanPrefixes: true });
    const archiveFindings = result.findings.filter(
      (x) => x.kind === "orphan-prefix" && x.category.startsWith("archive")
    );
    assert.equal(archiveFindings.length, 1, "exactly one finding for the lone deep record");
    assert.equal(archiveFindings[0].category, "archive.2019.notes.misc");
    assert.equal(archiveFindings[0].metric, "single-record-deep-path");
  });

  test("too-many-leaves: parent past the fan-out budget is flagged and lists the leaves", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    const f = result.findings.find((x) => x.kind === "too-many-leaves" && x.category === "tags");
    assert.ok(f, "tags (4 leaves > budget 3) is flagged");
    assert.equal(f.metric, "leaf-fan-out");
    assert.equal(f.proposedAction, "regroup");
    assert.equal(f.evidence.leafCount, 4);
    assert.equal(f.evidence.maxLeavesPerParent, 3);
    assert.deepEqual(
      f.evidence.leaves.sort(),
      ["tags.amber", "tags.blue", "tags.green", "tags.red"]
    );
    assert.deepEqual(
      f.recordIds.sort(),
      ["t-amber", "t-blue", "t-green", "t-red"]
    );
  });

  test("too-many-leaves boundary: count == budget is NOT flagged; count > budget IS flagged", async () => {
    const bdir = makeTempDir();
    const bstore = makeStore(bdir);
    const brunner = makeRunner(bstore, bdir);
    try {
      // Parent "a" has exactly 3 leaves; parent "b" has 4.
      await rec(bstore, { id: "a1", category: "a.one" });
      await rec(bstore, { id: "a2", category: "a.two" });
      await rec(bstore, { id: "a3", category: "a.three" });
      await rec(bstore, { id: "b1", category: "b.one" });
      await rec(bstore, { id: "b2", category: "b.two" });
      await rec(bstore, { id: "b3", category: "b.three" });
      await rec(bstore, { id: "b4", category: "b.four" });
      const result = await brunner.canonicalizeCategory({
        checkOrphanPrefixes: false,
        maxLeavesPerParent: 3,
      });
      const cats = result.findings
        .filter((x) => x.kind === "too-many-leaves")
        .map((x) => x.category);
      assert.ok(!cats.includes("a"), "3 leaves == budget is NOT flagged");
      assert.ok(cats.includes("b"), "4 leaves > budget IS flagged");
    } finally {
      fs.rmSync(bdir, { recursive: true, force: true });
    }
  });

  test("implemented-active: active record with an implemented marker is flagged for retirement (case-insensitive)", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    const f = result.findings.find(
      (x) => x.kind === "implemented-active" && x.recordIds[0] === "shipped-feature"
    );
    assert.ok(f, "the active+Implemented-tagged record is flagged");
    assert.equal(f.metric, "implemented-marker-on-active");
    assert.equal(f.proposedAction, "retire");
    assert.equal(f.evidence.status, "active");
    // "Implemented" tag matches the "implemented" marker case-insensitively.
    assert.deepEqual(f.evidence.matchedMarkers, ["Implemented"]);
    // The unmarked active record is never flagged as implemented-active.
    assert.ok(
      !result.findings.some(
        (x) => x.kind === "implemented-active" && x.recordIds[0] === "open-feature"
      ),
      "an active record with no implemented marker is not flagged"
    );
  });

  test("every finding cites its kind + category + recordIds + metric + evidence + proposedAction", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    assert.ok(result.findings.length > 0, "the configured fixture produces findings");
    const KINDS = new Set(["orphan-prefix", "too-many-leaves", "implemented-active"]);
    const ACTIONS = new Set(["flatten", "regroup", "retire"]);
    for (const f of result.findings) {
      assert.ok(KINDS.has(f.kind), `finding kind is recognised: ${f.kind}`);
      assert.ok(typeof f.category === "string", "finding cites a category");
      assert.ok(Array.isArray(f.recordIds) && f.recordIds.length > 0, "finding cites offending record ids");
      assert.ok(f.metric, "finding cites the metric that fired");
      assert.ok(f.evidence && typeof f.evidence === "object", "finding carries an evidence object");
      assert.ok(f.evidence.reason, "evidence explains the finding");
      assert.ok(ACTIONS.has(f.proposedAction), `finding proposes a valid action: ${f.proposedAction}`);
    }
  });

  test("opt-in: each check is independently toggleable — disabled checks contribute no findings", async () => {
    // Only orphan-prefix on; no leaf budget, no markers.
    const orphanOnly = await runner.canonicalizeCategory({ checkOrphanPrefixes: true });
    assert.ok(
      orphanOnly.findings.every((f) => f.kind === "orphan-prefix"),
      "with no leaf budget and no markers, only orphan-prefix findings appear"
    );

    // All checks off → no findings at all.
    const allOff = await runner.canonicalizeCategory({
      checkOrphanPrefixes: false,
      // maxLeavesPerParent omitted → leaf check disabled
      implementedMarkers: [], // implemented check disabled
    });
    assert.equal(allOff.findings.length, 0, "all checks disabled → no findings (opt-in)");

    // Only implemented-active on.
    const implOnly = await runner.canonicalizeCategory({
      checkOrphanPrefixes: false,
      implementedMarkers: ["implemented", "shipped"],
    });
    assert.ok(
      implOnly.findings.every((f) => f.kind === "implemented-active"),
      "only implemented-active findings when only that check is enabled"
    );
    assert.ok(
      implOnly.findings.some((f) => f.recordIds[0] === "shipped-feature"),
      "the marked record is still caught"
    );
  });

  test("retired records are excluded from the survey (terminal)", async () => {
    const rdir = makeTempDir();
    const rstore = makeStore(rdir);
    const rrunner = makeRunner(rstore, rdir);
    try {
      // A record that WOULD be implemented-active, then actually retire it.
      await rec(rstore, {
        id: "done-and-retired", title: "Done and retired",
        category: "work.features", tags: ["implemented"],
      });
      await rstore.retire("done-and-retired", "retired", {
        agent: "fixture",
        rationale: "Already retired properly.",
      });
      const result = await rrunner.canonicalizeCategory({
        checkOrphanPrefixes: true,
        maxLeavesPerParent: 1,
        implementedMarkers: ["implemented"],
      });
      assert.ok(
        !result.findings.some((f) => f.recordIds.includes("done-and-retired")),
        "a retired record is never surfaced as sprawl"
      );
    } finally {
      fs.rmSync(rdir, { recursive: true, force: true });
    }
  });

  test("read-only invariant: the audit mutates no record", async () => {
    const before = {};
    for (const id of ["api-auth", "lonely", "t-red", "shipped-feature"]) {
      before[id] = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
    }
    await runner.canonicalizeCategory(fullConfig());
    for (const id of Object.keys(before)) {
      const after = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
      assert.equal(after, before[id], `record ${id} is byte-identical after the audit`);
    }
  });

  test("survey accounting: surveyed + categories reflect the working set", async () => {
    const result = await runner.canonicalizeCategory(fullConfig());
    // 9 fixture records were created.
    assert.equal(result.surveyed, 9, "all 9 working-set records are surveyed");
    assert.ok(result.categories > 0, "the distinct category-prefix count is reported");
  });

  test("invalid maxLeavesPerParent (< 1) is rejected", async () => {
    await assert.rejects(
      () => runner.canonicalizeCategory({ maxLeavesPerParent: 0 }),
      /maxLeavesPerParent must be >= 1/
    );
  });

  test("gate telemetry: survey-gate and propose-gate events are emitted", async () => {
    const tdir = makeTempDir();
    const tstore = makeStore(tdir);
    const trunner = makeRunner(tstore, tdir);
    try {
      await rec(tstore, { id: "tg-1", category: "x.deep.path" });
      const result = await trunner.canonicalizeCategory({ checkOrphanPrefixes: true });
      assert.ok(
        result.telemetryEvents.length >= 4,
        "survey-gate + propose-gate produce at least 4 in/out events"
      );
      const persisted = readTelemetryEvents(tdir);
      const flowEvents = persisted.filter((e) =>
        JSON.stringify(e).includes("knowledge.canonicalize-category")
      );
      assert.ok(flowEvents.length > 0, "canonicalize-category telemetry is persisted to the sink");
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  });

  test("module-level canonicalizeCategory export delegates to the runner", async () => {
    const result = await canonicalizeCategory({
      store,
      workspace: dir,
      agent: "canonicalize-category-test-runner",
      checkOrphanPrefixes: false,
      implementedMarkers: ["implemented"],
    });
    assert.ok(
      result.findings.some(
        (f) => f.kind === "implemented-active" && f.recordIds[0] === "shipped-feature"
      ),
      "the module-level export produces the same findings as the runner method"
    );
  });
});
