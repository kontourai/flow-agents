/**
 * Knowledge Kit — Hygiene-Review Eval Suite  (#106 hygiene #5, closes the issue)
 *
 * knowledge.hygiene-review is a THIN ORCHESTRATOR over the four hygiene flows
 * (#106 #1–#4): audit-freshness, detect-contradictions, glossary-sync,
 * canonicalize-category. It runs each opted-in audit through its EXISTING
 * flow-runner method + EXISTING gates, reimplements NO detection logic, and
 * folds the findings into one operator-facing review of proposed actions
 * normalized to adopt / retire / merge. It forks NO new propose→approve gate:
 * read-only by default, and the only mutation it can trigger (glossary
 * apply:true) is delegated verbatim to glossarySync's own gated propose→apply
 * lineage (consume-never-fork).
 *
 * Covers:
 *   - opt-in orchestration: an omitted audit block is skipped (surfaced as
 *     skipped); an empty review runs nothing and proposes nothing.
 *   - each opted-in audit runs via its existing method and its findings are
 *     collected verbatim — the orchestrator detects nothing of its own.
 *   - normalization to adopt / retire / merge, each proposal citing its
 *     sourceFlow + the evidence its origin flow's gate already vouched.
 *   - thin-orchestrator / consume-never-fork invariants:
 *       * read-only by default mutates no record;
 *       * the only mutation (glossary apply:true) is delegated to glossarySync —
 *         proven by the resulting concept's "proposes" link + propose/apply
 *         mutation_log entries (the same lineage glossary-sync's own suite checks).
 *   - sub-flow telemetry is folded in, plus hygiene-review's own
 *     orchestrate-gate + review-gate.
 *   - module-level hygieneReview export delegates to the runner.
 *
 * Run:
 *   node --test kits/knowledge/evals/hygiene-review/suite.test.js
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
const { KnowledgeFlowRunner, hygieneReview } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-hygiene-review-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "hygiene-review-test-runner",
    sessionId: "hygiene-review-session-001",
  });
}

function readTelemetryEvents(dir) {
  const sinkPath = path.join(dir, ".kontourai", "telemetry", "full.jsonl");
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

const DAY_MS = 86_400_000;
const NOW = "2026-06-25T00:00:00.000Z";

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

/** Create a record then force its timestamps to a chosen age (black-box on age). */
async function createAtAge(store, dir, { id, type, title, category, days }) {
  await store.create({
    id, type, title, body: `Body of ${title}`, category,
    provenance: { agent: "fixture" },
  });
  const recPath = path.join(dir, "records", `${id}.md`);
  const at = daysAgo(days);
  const text = fs.readFileSync(recPath, "utf8")
    .replace(/created_at: .*/, `created_at: ${at}`)
    .replace(/updated_at: .*/, `updated_at: ${at}`);
  fs.writeFileSync(recPath, text, "utf8");
  return id;
}

// A canonical glossary doc → drives a glossary GAP (no concept for the term).
const GLOSSARY_BODY = [
  "# Hygiene Glossary",
  "",
  "**Backpressure** — A mechanism to slow producers when consumers lag.",
].join("\n");

// Contradiction detector that always fires on a pair → exercises the
// detect-contradictions sub-flow deterministically (the orchestrator passes it
// straight through to the existing method; no detection lives here).
const alwaysContradict = () => ({ reason: "fixture: forced contradiction" });
const allSimilar = async (record, candidates) => candidates.map((c) => c.id);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Hygiene-Review Suite (#106 #5)", () => {
  let dir;
  let store;
  let runner;
  let glossaryDocId;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // #1 audit-freshness fixtures: one stale (archive), one stale (refresh).
    await createAtAge(store, dir, {
      id: "stale-archive", type: "raw", title: "Stale → archive",
      category: "radar.signals", days: 30,
    });
    await createAtAge(store, dir, {
      id: "stale-refresh", type: "compiled", title: "Stale → refresh",
      category: "ops.decisions", days: 400,
    });

    // #2 detect-contradictions fixtures: two compiled records in one category.
    await store.create({
      type: "compiled", id: "contra-a", title: "Service uses REST",
      body: "We use REST.", category: "arch.api", provenance: { agent: "fixture" },
    });
    await store.create({
      type: "compiled", id: "contra-b", title: "Service uses gRPC",
      body: "We do not use REST.", category: "arch.api", provenance: { agent: "fixture" },
    });

    // #3 glossary-sync fixture: a canonical doc whose term has no concept (gap).
    glossaryDocId = await store.create({
      type: "compiled", title: "Hygiene Glossary (canonical)",
      body: GLOSSARY_BODY, category: "eng.glossary", provenance: { agent: "fixture" },
    });

    // #4 canonicalize-category fixture: an active record tagged implemented.
    await store.create({
      type: "compiled", id: "impl-active", title: "Implemented but active",
      body: "Shipped already.", category: "work.items", tags: ["implemented"],
      provenance: { agent: "fixture" },
    });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A full opt-in config exercising all four sub-flows (read-only).
  const fullConfig = () => ({
    freshness: {
      now: NOW,
      thresholds: { "radar.signals": 7, "ops.decisions": 365 },
      actions: { "radar.signals": "archive" },
      defaultAction: "refresh",
    },
    contradictions: {
      categories: ["arch.api"],
      similarityDetector: allSimilar,
      contradictionDetector: alwaysContradict,
    },
    glossary: { sources: [glossaryDocId] },
    canonicalize: { implementedMarkers: ["implemented"] },
  });

  test("opt-in: omitted audit blocks are skipped; an empty review does nothing", async () => {
    const empty = await runner.hygieneReview({});
    assert.deepEqual(
      empty.ranFlows, [],
      "no flow runs when no audit block is provided"
    );
    assert.deepEqual(
      empty.skippedFlows.sort(),
      [
        "knowledge.audit-freshness",
        "knowledge.canonicalize-category",
        "knowledge.detect-contradictions",
        "knowledge.glossary-sync",
      ],
      "every audit is surfaced as skipped"
    );
    assert.equal(empty.proposals.length, 0, "an empty review proposes nothing");
    assert.deepEqual(empty.summary, { total: 0, adopt: 0, retire: 0, merge: 0 });
  });

  test("runs only the opted-in audits", async () => {
    const result = await runner.hygieneReview({
      freshness: fullConfig().freshness,
    });
    assert.deepEqual(result.ranFlows, ["knowledge.audit-freshness"]);
    assert.ok(result.skippedFlows.includes("knowledge.detect-contradictions"));
    assert.ok(result.skippedFlows.includes("knowledge.glossary-sync"));
    assert.ok(result.skippedFlows.includes("knowledge.canonicalize-category"));
  });

  test("orchestrates all four flows and collects every finding verbatim", async () => {
    const result = await runner.hygieneReview(fullConfig());

    assert.deepEqual(
      result.ranFlows.sort(),
      [
        "knowledge.audit-freshness",
        "knowledge.canonicalize-category",
        "knowledge.detect-contradictions",
        "knowledge.glossary-sync",
      ],
      "all four hygiene flows ran"
    );
    assert.deepEqual(result.skippedFlows, [], "nothing skipped in a full review");

    // Each sub-audit's own result object is carried through untouched.
    assert.ok(result.audits.freshness.flags.length >= 2, "freshness flags collected");
    assert.ok(result.audits.contradictions.flags.length >= 1, "contradiction flags collected");
    assert.ok(result.audits.glossary.gaps.length >= 1, "glossary gaps collected");
    assert.ok(result.audits.canonicalize.findings.length >= 1, "canonicalize findings collected");

    // Every proposal traces back to one of the four flows — none synthesized here.
    const sources = new Set(result.proposals.map((p) => p.sourceFlow));
    assert.ok(sources.has("knowledge.audit-freshness"));
    assert.ok(sources.has("knowledge.detect-contradictions"));
    assert.ok(sources.has("knowledge.glossary-sync"));
    assert.ok(sources.has("knowledge.canonicalize-category"));
  });

  test("normalizes proposals to adopt / retire / merge, each citing source + evidence", async () => {
    const result = await runner.hygieneReview(fullConfig());

    for (const p of result.proposals) {
      assert.ok(
        ["adopt", "retire", "merge"].includes(p.decision),
        `decision ${p.decision} is one of adopt/retire/merge`
      );
      assert.ok(p.sourceFlow, "proposal cites its source flow");
      assert.ok(p.route, "proposal names the existing gated op it routes through");
      assert.ok(Array.isArray(p.recordIds) && p.recordIds.length >= 1, "proposal cites record ids");
      assert.ok(p.evidence && typeof p.evidence === "object", "proposal carries evidence");
    }

    // audit-freshness archive → retire; refresh → adopt.
    const archive = result.proposals.find(
      (p) => p.sourceFlow === "knowledge.audit-freshness" && p.recordIds.includes("stale-archive")
    );
    assert.equal(archive.decision, "retire", "an archive flag normalizes to retire");
    assert.equal(archive.route, "knowledge.retire");
    const refresh = result.proposals.find(
      (p) => p.sourceFlow === "knowledge.audit-freshness" && p.recordIds.includes("stale-refresh")
    );
    assert.equal(refresh.decision, "adopt", "a refresh flag normalizes to adopt");

    // contradiction → retire, citing BOTH ids.
    const contra = result.proposals.find((p) => p.sourceFlow === "knowledge.detect-contradictions");
    assert.equal(contra.decision, "retire");
    assert.deepEqual(contra.recordIds.sort(), ["contra-a", "contra-b"], "cites both record ids");
    assert.match(contra.evidence.reason, /contradiction/);

    // glossary gap → adopt.
    const gap = result.proposals.find((p) => p.sourceFlow === "knowledge.glossary-sync");
    assert.equal(gap.decision, "adopt");
    assert.equal(gap.evidence.term, "Backpressure");

    // canonicalize maps proposedAction "retire" → retire, and flatten/regroup → merge.
    const canonProps = result.proposals.filter((p) => p.sourceFlow === "knowledge.canonicalize-category");
    const implActive = canonProps.find((p) => p.evidence.kind === "implemented-active");
    assert.equal(implActive.decision, "retire", "implemented-active normalizes to retire");
    assert.ok(implActive.recordIds.includes("impl-active"));
    const flatten = canonProps.find((p) => p.proposedAction === "flatten" || p.proposedAction === "regroup");
    if (flatten) {
      assert.equal(flatten.decision, "merge", "flatten/regroup normalizes to merge");
    }

    // summary tallies match.
    const tally = { total: 0, adopt: 0, retire: 0, merge: 0 };
    for (const p of result.proposals) { tally.total += 1; tally[p.decision] += 1; }
    assert.deepEqual(result.summary, tally, "summary tallies the proposals");
  });

  test("read-only by default: orchestration mutates no record (no forked gate)", async () => {
    const ids = fs.readdirSync(path.join(dir, "records")).map((f) => f.replace(/\.md$/, ""));
    const before = {};
    for (const id of ids) before[id] = recordBytes(dir, id);

    const result = await runner.hygieneReview(fullConfig());

    const idsAfter = fs.readdirSync(path.join(dir, "records")).map((f) => f.replace(/\.md$/, ""));
    assert.deepEqual(idsAfter.sort(), ids.sort(), "no record created by a read-only review");
    for (const id of ids) {
      assert.equal(recordBytes(dir, id), before[id], `record ${id} byte-identical after review`);
    }
    // No glossary apply happened (apply not requested).
    assert.equal(result.audits.glossary.applied.length, 0, "nothing applied in read-only mode");
  });

  test("the only mutation (glossary apply) is delegated to glossarySync's gated propose→apply", async () => {
    const adir = makeTempDir();
    const astore = makeStore(adir);
    const arunner = makeRunner(astore, adir);
    try {
      const docId = await astore.create({
        type: "compiled", title: "Apply glossary", category: "app.glossary",
        body: "**Idempotency** — An op applied many times with the same effect.",
        provenance: { agent: "fixture" },
      });
      const result = await arunner.hygieneReview({
        glossary: { sources: [docId], apply: true },
      });

      // The orchestrator did not write the store itself — it delegated.
      assert.equal(result.audits.glossary.applied.length, 1, "the gap was applied via glossarySync");
      const { conceptId, action } = result.audits.glossary.applied[0];
      assert.equal(action, "create");

      // Prove the EXISTING gated propose→apply lineage was used (consume-never-fork):
      // the canonical doc proposes the concept, and the concept's mutation_log
      // carries propose + apply — identical to glossary-sync's own suite.
      const { forward } = await astore.getLinks(docId);
      assert.ok(
        forward.some((l) => l.target_id === conceptId && l.kind === "proposes"),
        "canonical doc proposes the concept (existing gated lineage, not a forked gate)"
      );
      const concept = await astore.get(conceptId);
      const ops = (concept.mutation_log || []).map((e) => e.op);
      assert.ok(ops.includes("propose") && ops.includes("apply"), "gated propose→apply path used");
    } finally {
      fs.rmSync(adir, { recursive: true, force: true });
    }
  });

  test("telemetry: sub-flow gates are folded in plus hygiene-review's own gates", async () => {
    const tdir = makeTempDir();
    const tstore = makeStore(tdir);
    const trunner = makeRunner(tstore, tdir);
    try {
      await createAtAge(tstore, tdir, {
        id: "t-stale", type: "raw", title: "Telemetry stale",
        category: "radar.signals", days: 30,
      });
      const result = await trunner.hygieneReview({
        freshness: { now: NOW, thresholds: { "radar.signals": 7 } },
      });

      // Returned events include both the sub-flow's gates and our own.
      const blob = JSON.stringify(result.telemetryEvents);
      assert.ok(blob.includes("knowledge.audit-freshness"), "sub-flow telemetry folded in");
      assert.ok(blob.includes("knowledge.hygiene-review"), "orchestrator emits its own gate telemetry");
      assert.ok(blob.includes("orchestrate-gate"), "orchestrate-gate emitted");
      assert.ok(blob.includes("review-gate"), "review-gate emitted");

      // And our own gates are persisted to the sink.
      const persisted = readTelemetryEvents(tdir);
      const reviewEvents = persisted.filter((e) =>
        JSON.stringify(e).includes("knowledge.hygiene-review")
      );
      assert.ok(reviewEvents.length > 0, "hygiene-review telemetry persisted to the sink");
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  });

  test("module-level hygieneReview export delegates to the runner", async () => {
    const result = await hygieneReview({
      store,
      workspace: dir,
      agent: "hygiene-review-test-runner",
      freshness: { now: NOW, thresholds: { "radar.signals": 7 }, actions: { "radar.signals": "archive" } },
    });
    assert.deepEqual(result.ranFlows, ["knowledge.audit-freshness"]);
    assert.ok(
      result.proposals.some((p) => p.recordIds.includes("stale-archive") && p.decision === "retire"),
      "the module-level export produces the same normalized proposals"
    );
  });
});
