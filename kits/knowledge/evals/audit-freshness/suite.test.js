/**
 * Knowledge Kit — Audit-Freshness Eval Suite  (#106 hygiene #1)
 *
 * knowledge.audit-freshness flags records past per-category staleness
 * thresholds and proposes archive/refresh — each flag citing its evidence
 * (last-mutation + the threshold that fired). The audit is READ-ONLY,
 * OPTIONAL, and CONFIGURABLE (per-category thresholds).
 *
 * Covers:
 *   - per-category threshold resolution: dot-hierarchy longest-prefix wins
 *     over a shorter prefix; an explicit default catches unmatched categories;
 *     a category with no threshold (and no default) is skipped (opt-in).
 *   - boundary: age == threshold is NOT flagged; age > threshold IS flagged.
 *   - every flag cites lastMutationAt + thresholdDays + matchedThresholdKey
 *     + ageDays (the evidence guarantee).
 *   - last-mutation is the max of updated_at and the latest mutation_log entry.
 *   - retired records are never flagged (terminal, excluded from working set).
 *   - read-only invariant: no record is mutated by the audit.
 *   - proposed-action resolution (default + per-category override).
 *   - gate telemetry (collect-gate + flag-gate) is emitted.
 *
 * Run:
 *   node --test kits/knowledge/evals/audit-freshness/suite.test.js
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
const { KnowledgeFlowRunner, auditFreshness } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-audit-freshness-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "audit-freshness-test-runner",
    sessionId: "audit-freshness-session-001",
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

const DAY_MS = 86_400_000;

// A fixed reference "now" so age math is deterministic regardless of wall clock.
const NOW = "2026-06-25T00:00:00.000Z";

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

/**
 * Create a record, then force its updated_at (and optionally created_at) to an
 * arbitrary instant by rewriting the markdown directly — the store stamps the
 * current time on create, which we don't want to depend on. This keeps the test
 * black-box on the audit while controlling its sole input (age).
 */
function createAtAge(store, dir, { id, type, title, category, days, mutationLog }) {
  const recPath = path.join(dir, "records", `${id}.md`);
  // Build the record file directly via the store, then patch timestamps.
  return store
    .create({ id, type, title, body: `Body of ${title}`, category, provenance: { agent: "fixture" } })
    .then(() => {
      const text = fs.readFileSync(recPath, "utf8");
      const at = daysAgo(days);
      let patched = text
        .replace(/created_at: .*/, `created_at: ${at}`)
        .replace(/updated_at: .*/, `updated_at: ${at}`);
      if (mutationLog) {
        // Inject a mutation_log with a single entry at the given instant.
        patched = patched.replace(
          /mutation_log: \[\]/,
          `mutation_log:\n  - op: update\n    at: ${mutationLog}\n    agent: fixture`
        );
      }
      fs.writeFileSync(recPath, patched, "utf8");
      return id;
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Knowledge Kit Audit-Freshness Suite (#106)", () => {
  let dir;
  let store;
  let runner;

  before(async () => {
    dir = makeTempDir();
    store = makeStore(dir);
    runner = makeRunner(store, dir);

    // radar.signals: a 14-day record (stale at 7) + a 3-day record (fresh).
    await createAtAge(store, dir, {
      id: "radar-stale", type: "raw", title: "Radar: weak signal",
      category: "radar.signals", days: 14,
    });
    await createAtAge(store, dir, {
      id: "radar-fresh", type: "raw", title: "Radar: hot signal",
      category: "radar.signals", days: 3,
    });
    // ops.decisions: 200-day record — fresh against a 365-day threshold.
    await createAtAge(store, dir, {
      id: "decision-young", type: "compiled", title: "Decision: use REST",
      category: "ops.decisions", days: 200,
    });
    // ops.decisions: 400-day record — stale against the 365-day threshold.
    await createAtAge(store, dir, {
      id: "decision-old", type: "compiled", title: "Decision: legacy SOAP",
      category: "ops.decisions", days: 400,
    });
    // misc: 9999-day record but no threshold configured → opt-out, never flagged.
    await createAtAge(store, dir, {
      id: "misc-ancient", type: "raw", title: "Misc: ancient scratch",
      category: "misc.scratch", days: 9999,
    });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = () => ({
    now: NOW,
    thresholds: {
      "radar.signals": 7,
      "ops.decisions": 365,
    },
    // no default → misc.* is opt-out
  });

  test("flags only records strictly past their per-category threshold", async () => {
    const result = await runner.auditFreshness(config());
    const flaggedIds = result.flags.map((f) => f.recordId).sort();
    assert.deepEqual(
      flaggedIds,
      ["decision-old", "radar-stale"],
      "exactly the two records past threshold are flagged"
    );
  });

  test("opt-out: category with no threshold (and no default) is skipped, never flagged", async () => {
    const result = await runner.auditFreshness(config());
    assert.ok(
      !result.flags.some((f) => f.recordId === "misc-ancient"),
      "misc.scratch has no threshold → not flagged despite being 9999 days old"
    );
    assert.equal(result.skipped, 1, "the one misc.* record is counted as skipped");
    assert.equal(result.audited, 4, "the four threshold-resolvable records are audited");
  });

  test("every flag cites its evidence: last-mutation + threshold + matched key + age", async () => {
    const result = await runner.auditFreshness(config());
    for (const flag of result.flags) {
      assert.ok(flag.lastMutationAt, `flag for ${flag.recordId} cites lastMutationAt`);
      assert.ok(!Number.isNaN(Date.parse(flag.lastMutationAt)), "lastMutationAt is a valid timestamp");
      assert.equal(typeof flag.thresholdDays, "number", "flag cites thresholdDays");
      assert.equal(typeof flag.ageDays, "number", "flag cites ageDays");
      assert.ok(flag.ageDays > flag.thresholdDays, "ageDays strictly exceeds thresholdDays");
      assert.ok(flag.matchedThresholdKey, "flag cites the matched threshold key");
    }
    const radar = result.flags.find((f) => f.recordId === "radar-stale");
    assert.equal(radar.thresholdDays, 7);
    assert.equal(radar.matchedThresholdKey, "radar.signals");
    assert.equal(radar.ageDays, 14);
  });

  test("longest-prefix wins: radar.signals threshold beats a shorter radar threshold", async () => {
    // Add a coarser radar threshold of 30 days; radar.signals (7) must still win.
    const result = await runner.auditFreshness({
      now: NOW,
      thresholds: { radar: 30, "radar.signals": 7, "ops.decisions": 365 },
    });
    const radar = result.flags.find((f) => f.recordId === "radar-stale");
    assert.ok(radar, "radar-stale (14d) is flagged under the 7-day radar.signals threshold");
    assert.equal(radar.matchedThresholdKey, "radar.signals");
    assert.equal(radar.thresholdDays, 7);
  });

  test("default threshold catches otherwise-unmatched categories", async () => {
    const result = await runner.auditFreshness({
      now: NOW,
      thresholds: { "radar.signals": 7 },
      defaultThresholdDays: 365,
    });
    const misc = result.flags.find((f) => f.recordId === "misc-ancient");
    assert.ok(misc, "misc.scratch (9999d) is now flagged under the default threshold");
    assert.equal(misc.matchedThresholdKey, "*", "default match is surfaced as '*'");
    assert.equal(misc.thresholdDays, 365);
  });

  test("boundary: age == threshold is not flagged; age > threshold is flagged", async () => {
    const bdir = makeTempDir();
    const bstore = makeStore(bdir);
    const brunner = makeRunner(bstore, bdir);
    try {
      await createAtAge(bstore, bdir, {
        id: "exactly-7", type: "raw", title: "Exactly at threshold",
        category: "radar.signals", days: 7,
      });
      await createAtAge(bstore, bdir, {
        id: "just-over-7", type: "raw", title: "One day past threshold",
        category: "radar.signals", days: 8,
      });
      const result = await brunner.auditFreshness({
        now: NOW,
        thresholds: { "radar.signals": 7 },
      });
      const ids = result.flags.map((f) => f.recordId);
      assert.ok(!ids.includes("exactly-7"), "age == threshold is NOT flagged");
      assert.ok(ids.includes("just-over-7"), "age > threshold IS flagged");
    } finally {
      fs.rmSync(bdir, { recursive: true, force: true });
    }
  });

  test("last-mutation is the max of updated_at and the latest mutation_log entry", async () => {
    const mdir = makeTempDir();
    const mstore = makeStore(mdir);
    const mrunner = makeRunner(mstore, mdir);
    try {
      // updated_at is 100 days old, but a mutation_log entry is only 2 days old —
      // the record is FRESH (last mutation = 2 days ago, under the 7-day threshold).
      await createAtAge(mstore, mdir, {
        id: "log-newer", type: "raw", title: "Stale stamp, fresh log",
        category: "radar.signals", days: 100, mutationLog: daysAgo(2),
      });
      const result = await mrunner.auditFreshness({
        now: NOW,
        thresholds: { "radar.signals": 7 },
      });
      assert.ok(
        !result.flags.some((f) => f.recordId === "log-newer"),
        "the newer mutation_log entry makes the record fresh — not flagged"
      );
    } finally {
      fs.rmSync(mdir, { recursive: true, force: true });
    }
  });

  test("retired records are never flagged (terminal, excluded from working set)", async () => {
    const rdir = makeTempDir();
    const rstore = makeStore(rdir);
    const rrunner = makeRunner(rstore, rdir);
    try {
      await createAtAge(rstore, rdir, {
        id: "old-but-retired", type: "compiled", title: "Ancient, already retired",
        category: "ops.decisions", days: 5000,
      });
      // Retire it via the store op (active → retired).
      await rstore.retire("old-but-retired", "retired", {
        agent: "fixture",
        rationale: "Superseded long ago.",
      });
      const result = await rrunner.auditFreshness({
        now: NOW,
        thresholds: { "ops.decisions": 365 },
      });
      assert.ok(
        !result.flags.some((f) => f.recordId === "old-but-retired"),
        "a retired record is never flagged regardless of age"
      );
    } finally {
      fs.rmSync(rdir, { recursive: true, force: true });
    }
  });

  test("read-only invariant: the audit mutates no record", async () => {
    const before = {};
    for (const id of ["radar-stale", "decision-old", "misc-ancient"]) {
      before[id] = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
    }
    await runner.auditFreshness(config());
    for (const id of Object.keys(before)) {
      const after = fs.readFileSync(path.join(dir, "records", `${id}.md`), "utf8");
      assert.equal(after, before[id], `record ${id} is byte-identical after the audit`);
    }
  });

  test("proposed action: default refresh, per-category override honoured", async () => {
    const result = await runner.auditFreshness({
      now: NOW,
      thresholds: { "radar.signals": 7, "ops.decisions": 365 },
      actions: { "radar.signals": "archive" },
      defaultAction: "refresh",
    });
    const radar = result.flags.find((f) => f.recordId === "radar-stale");
    const decision = result.flags.find((f) => f.recordId === "decision-old");
    assert.equal(radar.proposedAction, "archive", "per-category action override applies");
    assert.equal(decision.proposedAction, "refresh", "unmatched category falls back to defaultAction");
  });

  test("gate telemetry: collect-gate and flag-gate events are emitted", async () => {
    const tdir = makeTempDir();
    const tstore = makeStore(tdir);
    const trunner = makeRunner(tstore, tdir);
    try {
      await createAtAge(tstore, tdir, {
        id: "t-stale", type: "raw", title: "Telemetry stale",
        category: "radar.signals", days: 30,
      });
      const result = await trunner.auditFreshness({
        now: NOW,
        thresholds: { "radar.signals": 7 },
      });
      // Returned events
      const returnedGates = result.telemetryEvents
        .map((e) => e.gate || e?.context?.gate)
        .filter(Boolean);
      assert.ok(
        result.telemetryEvents.length >= 4,
        "collect-gate + flag-gate produce at least 4 in/out events"
      );
      // Persisted events reference the audit flow.
      const persisted = readTelemetryEvents(tdir);
      const auditEvents = persisted.filter((e) =>
        JSON.stringify(e).includes("knowledge.audit-freshness")
      );
      assert.ok(auditEvents.length > 0, "audit flow telemetry is persisted to the sink");
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
  });

  test("module-level auditFreshness export delegates to the runner", async () => {
    const result = await auditFreshness({
      store,
      workspace: dir,
      agent: "audit-freshness-test-runner",
      now: NOW,
      thresholds: { "radar.signals": 7, "ops.decisions": 365 },
    });
    const flaggedIds = result.flags.map((f) => f.recordId).sort();
    assert.deepEqual(flaggedIds, ["decision-old", "radar-stale"]);
  });
});
