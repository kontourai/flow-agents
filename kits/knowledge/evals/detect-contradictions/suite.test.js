/**
 * Knowledge Kit — Detect-Contradictions Eval Suite  (#106 hygiene #2)
 *
 * knowledge.detect-contradictions compares compiled records within a category,
 * reusing the similarity adapter to scope comparisons to records about the same
 * thing, then flags conflicting assertions — each flag citing BOTH record ids.
 * The audit is READ-ONLY, OPTIONAL (opt-in per category), and CONFIGURABLE
 * (pluggable similarity detector + pluggable contradiction fn).
 *
 * Covers:
 *   - default opposing-polarity heuristic: affirmative vs negation of the same
 *     stem within a category is flagged; agreeing records are not.
 *   - every flag cites BOTH ids (recordIdA + recordIdB) + category + reason.
 *   - similarity scoping: only records the similarity adapter deems similar are
 *     compared (an injected detector that returns [] yields zero flags).
 *   - pluggable contradiction fn: an injected fn overrides the default verdict.
 *   - opt-in scoping: only categories in `categories` are audited; others skipped.
 *   - each unordered pair is compared at most once (no duplicate flags).
 *   - cross-category records are never paired (different subjects).
 *   - retired compiled records are excluded from the comparison set.
 *   - read-only invariant: no record is mutated by the audit.
 *   - gate telemetry (collect-gate + flag-gate) is emitted.
 *   - module-level detectContradictions export delegates to the runner.
 *
 * Run:
 *   node --test kits/knowledge/evals/detect-contradictions/suite.test.js
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
const { KnowledgeFlowRunner, detectContradictions, defaultContradictionDetector } =
  await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-detect-contradictions-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "detect-contradictions-test-runner",
    sessionId: "detect-contradictions-session-001",
  });
}

function readTelemetryEvents(dir) {
  const sinkPath = path.join(dir, ".kontourai", "telemetry", "full.jsonl");
  if (!fs.existsSync(sinkPath)) return [];
  return fs
    .readFileSync(sinkPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeCompiled(store, { id, title, category, body }) {
  return store.create({
    id,
    type: "compiled",
    title,
    body,
    category,
    provenance: { agent: "fixture" },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Detect-Contradictions Suite (#106)", () => {
  let dir;
  let store;
  let runner;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // ops.decisions: a clear contradiction — one says use REST, one says do not.
    await makeCompiled(store, {
      id: "rest-yes",
      title: "Decision: use REST",
      category: "ops.decisions",
      body: "We should use REST for the public API.",
    });
    await makeCompiled(store, {
      id: "rest-no",
      title: "Decision: drop REST",
      category: "ops.decisions",
      body: "We should not use REST; gRPC is the new direction.",
    });
    // ops.decisions: an agreeing record — no contradiction with rest-yes.
    await makeCompiled(store, {
      id: "rest-agree",
      title: "Note: REST confirmed",
      category: "ops.decisions",
      body: "We should use REST for all external endpoints.",
    });

    // radar.signals: a separate category with its own (non-conflicting) record —
    // it must never be paired with the ops.decisions records.
    await makeCompiled(store, {
      id: "radar-note",
      title: "Radar: gRPC interest",
      category: "radar.signals",
      body: "We should use gRPC internally.",
    });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("default heuristic flags opposing assertions within a category", async () => {
    const result = await runner.detectContradictions();
    const pair = result.flags.find(
      (f) =>
        (f.recordIdA === "rest-no" && f.recordIdB === "rest-yes") ||
        (f.recordIdA === "rest-yes" && f.recordIdB === "rest-no")
    );
    assert.ok(pair, "the use-REST vs do-not-use-REST pair is flagged");
  });

  test("agreeing records in the same category are NOT flagged", async () => {
    const result = await runner.detectContradictions();
    const agreeFlag = result.flags.find(
      (f) =>
        (f.recordIdA === "rest-yes" && f.recordIdB === "rest-agree") ||
        (f.recordIdA === "rest-agree" && f.recordIdB === "rest-yes")
    );
    assert.ok(!agreeFlag, "two records that both affirm REST are not a contradiction");
  });

  test("every flag cites BOTH record ids + category + reason (evidence guarantee)", async () => {
    const result = await runner.detectContradictions();
    assert.ok(result.flags.length > 0, "at least one flag to inspect");
    for (const flag of result.flags) {
      assert.ok(flag.recordIdA, "flag cites recordIdA");
      assert.ok(flag.recordIdB, "flag cites recordIdB");
      assert.notEqual(flag.recordIdA, flag.recordIdB, "the two ids are distinct");
      assert.ok(flag.category, "flag cites the shared category");
      assert.ok(flag.reason && flag.reason.trim(), "flag cites a non-empty reason");
    }
  });

  test("flag ids are canonically ordered (recordIdA < recordIdB)", async () => {
    const result = await runner.detectContradictions();
    for (const flag of result.flags) {
      assert.ok(flag.recordIdA < flag.recordIdB, "ids are stably ordered for a stable pair key");
    }
  });

  test("cross-category records are never paired", async () => {
    const result = await runner.detectContradictions();
    const crossed = result.flags.find(
      (f) => f.recordIdA === "radar-note" || f.recordIdB === "radar-note"
    );
    assert.ok(!crossed, "radar.signals record is never paired with ops.decisions records");
  });

  test("similarity scoping: a detector that finds nothing yields zero flags", async () => {
    const result = await runner.detectContradictions({
      similarityDetector: async () => [],
    });
    assert.equal(result.flags.length, 0, "no similar pairs → nothing to compare → no flags");
    assert.equal(result.compared, 0, "no pairs are compared when nothing is similar");
  });

  test("pluggable contradiction fn overrides the default verdict", async () => {
    // A fn that flags EVERY similar pair, regardless of content.
    const everythingConflicts = () => ({ reason: "forced conflict" });
    const result = await runner.detectContradictions({
      categories: ["ops.decisions"],
      contradictionDetector: everythingConflicts,
    });
    // 3 ops.decisions records → C(3,2) = 3 unordered pairs, all flagged.
    assert.equal(result.flags.length, 3, "every similar pair is flagged by the injected fn");
    assert.ok(
      result.flags.every((f) => f.reason === "forced conflict"),
      "the injected fn's reason is carried on every flag"
    );
  });

  test("opt-in scoping: only categories in `categories` are audited", async () => {
    const result = await runner.detectContradictions({ categories: ["radar.signals"] });
    assert.equal(result.flags.length, 0, "radar.signals has no conflicting pair");
    assert.ok(
      !result.flags.some((f) => f.category === "ops.decisions"),
      "ops.decisions is not audited when out of scope"
    );
  });

  test("each unordered pair is compared at most once", async () => {
    const result = await runner.detectContradictions({
      categories: ["ops.decisions"],
      contradictionDetector: () => ({ reason: "x" }),
    });
    const keys = result.flags.map((f) => `${f.recordIdA}|${f.recordIdB}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate pair flags");
    assert.equal(keys.length, 3, "exactly C(3,2) pairs for 3 records");
  });

  test("retired compiled records are excluded from the comparison set", async () => {
    const rdir = makeTempDir();
    const rstore = makeStore(rdir);
    const rrunner = makeRunner(rstore, rdir);
    try {
      await makeCompiled(rstore, {
        id: "live-yes",
        title: "Use REST",
        category: "ops.decisions",
        body: "We should use REST.",
      });
      await makeCompiled(rstore, {
        id: "retired-no",
        title: "Drop REST (retired)",
        category: "ops.decisions",
        body: "We should not use REST.",
      });
      await rstore.retire("retired-no", "retired", {
        agent: "fixture",
        rationale: "Superseded.",
      });
      const result = await rrunner.detectContradictions();
      assert.equal(
        result.flags.length,
        0,
        "a retired record is never compared — no contradiction surfaces"
      );
    } finally {
      fs.rmSync(rdir, { recursive: true, force: true });
    }
  });

  test("read-only invariant: the audit mutates no record", async () => {
    const before = {};
    for (const id of ["rest-yes", "rest-no", "rest-agree", "radar-note"]) {
      before[id] = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
    }
    await runner.detectContradictions();
    for (const id of Object.keys(before)) {
      const after = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
      assert.equal(after, before[id], `record ${id} is byte-identical after the audit`);
    }
  });

  test("gate telemetry: collect-gate and flag-gate events are emitted", async () => {
    const tdir = makeTempDir();
    const tstore = makeStore(tdir);
    const trunner = makeRunner(tstore, tdir);
    try {
      await makeCompiled(tstore, {
        id: "t-yes",
        title: "Use REST",
        category: "ops.decisions",
        body: "We should use REST.",
      });
      await makeCompiled(tstore, {
        id: "t-no",
        title: "Drop REST",
        category: "ops.decisions",
        body: "We should not use REST.",
      });
      const result = await trunner.detectContradictions();
      assert.ok(
        result.telemetryEvents.length >= 4,
        "collect-gate + flag-gate produce at least 4 in/out events"
      );
      const persisted = readTelemetryEvents(tdir);
      const events = persisted.filter((e) =>
        JSON.stringify(e).includes("knowledge.detect-contradictions")
      );
      assert.ok(events.length > 0, "detect-contradictions flow telemetry is persisted to the sink");
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  });

  test("module-level detectContradictions export delegates to the runner", async () => {
    const result = await detectContradictions({
      store,
      workspace: dir,
      agent: "detect-contradictions-test-runner",
    });
    const pair = result.flags.find(
      (f) =>
        (f.recordIdA === "rest-no" && f.recordIdB === "rest-yes") ||
        (f.recordIdA === "rest-yes" && f.recordIdB === "rest-no")
    );
    assert.ok(pair, "module-level export surfaces the same contradiction as the runner");
  });

  test("defaultContradictionDetector unit: opposing polarity over a shared stem", () => {
    const a = { id: "a", body: "We should use REST." };
    const b = { id: "b", body: "We should not use REST." };
    const c = { id: "c", body: "We should use REST everywhere." };
    assert.ok(defaultContradictionDetector(a, b), "affirm vs negate of the same stem conflicts");
    assert.equal(defaultContradictionDetector(a, c), null, "two affirmations do not conflict");
  });
});
