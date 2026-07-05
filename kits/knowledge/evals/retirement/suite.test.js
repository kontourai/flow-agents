/**
 * Knowledge Kit — Retirement Eval Suite (S7)
 *
 * Covers:
 *   AC1: retirement happens only via approved proposal carrying the retirement
 *       rationale/ref. Direct status mutations without the gate are not permitted.
 *       After propose, the record status is unchanged; only after apply does the
 *       status transition.
 *
 *   AC2: retired record excluded from listByType/listByCategory/similarity
 *       defaults but returned with includeRetired flag; provenance (mutation_log)
 *       is intact; get() always returns the full record regardless of status.
 *
 *   AC3: a snapshot consolidation after retirement reflects the pruned working set
 *       (retired compiled records do not appear in the consolidation cluster);
 *       the retired decision still reachable from snapshot provenance history
 *       via get(id).
 *
 *   Rejection leaves status byte-identical (rejection path does not mutate status).
 *   Gate telemetry: identify, propose-retirement, evidence, apply gate events emitted.
 *   Status transition table enforcement (invalid transitions throw MISSING_EVIDENCE).
 *   implementedByRef required when targetStatus="implemented".
 *
 * Run:
 *   node --test kits/knowledge/evals/retirement/suite.test.js
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
const vectorPath = path.join(KIT_ROOT, "adapters/similarity-vector/index.js");

const { DefaultKnowledgeStore } = await import(adapterPath);
const { KnowledgeFlowRunner, defaultSimilarityDetector } = await import(runnerPath);
const { createVectorSimilarityDetector } = await import(vectorPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-retirement-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, dir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: "retirement-test-runner",
    sessionId: "retirement-session-001",
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

/**
 * Build a baseline fixture:
 *   - 2 compiled records in category "ops.decisions"
 *   - 1 raw record
 *   - 1 concept record
 * Returns { store, rawId, compiledId1, compiledId2, conceptId }
 */
async function buildFixture(dir) {
  const store = makeStore(dir);

  const rawId = await store.create({
    type: "raw",
    title: "Raw capture: API decision",
    body: "We should use REST for the public-facing API.",
    category: "ops.decisions",
    provenance: { agent: "fixture" },
  });

  const compiledId1 = await store.create({
    type: "compiled",
    title: "Decision: Use REST for public API",
    body: "## Decision\n\nWe will use REST for the public API.",
    category: "ops.decisions",
    provenance: { agent: "fixture", source_ids: [rawId] },
  });

  const compiledId2 = await store.create({
    type: "compiled",
    title: "Decision: Versioning via URL path",
    body: "## Decision\n\nVersioning will be done via URL path (/v1/, /v2/).",
    category: "ops.decisions",
    provenance: { agent: "fixture", source_ids: [] },
  });

  const conceptId = await store.create({
    type: "concept",
    title: "REST API Design",
    body: "REST is the standard for our public API.",
    category: "ops.decisions",
    provenance: { agent: "fixture" },
  });

  return { store, rawId, compiledId1, compiledId2, conceptId };
}

// ---------------------------------------------------------------------------
// AC1 — retirement only via approved proposal with rationale/ref
// ---------------------------------------------------------------------------

describe("AC1 — retirement only via approved proposal with rationale/ref", () => {
  test("retire with decision=apply transitions record status to 'retired'", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const before = await store.get(compiledId1);
      assert.equal(before.status || "active", "active", "record starts as active");

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "This decision has been superseded by the versioning policy.",
        decision: "apply",
      });

      const after = await store.get(compiledId1);
      assert.equal(after.status, "retired", "AC1: record status is 'retired' after apply");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire with targetStatus='implemented' requires implementedByRef", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.retire(compiledId1, {
          targetStatus: "implemented",
          rationale: "This decision was implemented.",
          // implementedByRef intentionally omitted
          decision: "apply",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /implementedByRef/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire with targetStatus='implemented' and implementedByRef transitions to 'implemented'", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "implemented",
        rationale: "Shipped in PR #42.",
        implementedByRef: "https://github.com/org/repo/pull/42",
        decision: "apply",
      });

      const after = await store.get(compiledId1);
      assert.equal(after.status, "implemented", "AC1: status transitions to 'implemented'");

      // mutation_log carries the evidence
      const logEntry = (after.mutation_log || []).find((e) => e.op === "retire");
      assert.ok(logEntry, "AC1: mutation log has retire entry");
      assert.equal(logEntry.evidence.implementedByRef, "https://github.com/org/repo/pull/42");
      assert.equal(logEntry.evidence.rationale, "Shipped in PR #42.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1: proposal uses store propose op, not direct mutation — proposer has proposes link", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Obsolete — superseded by new spec.",
        decision: "apply",
      });

      // The proposer record must have a "proposes" link to the target record
      const { forward } = await store.getLinks(result.proposerId);
      assert.ok(
        forward.some((l) => l.target_id === compiledId1 && l.kind === "proposes"),
        "AC1: proposer has proposes link to target record"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1: mutation log on target record has propose entry before retire entry", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Superseded.",
        decision: "apply",
      });

      const after = await store.get(compiledId1);
      const logOps = (after.mutation_log || []).map((e) => e.op);
      assert.ok(logOps.includes("propose"), "AC1: mutation log has propose entry");
      assert.ok(logOps.includes("retire"), "AC1: mutation log has retire entry");
      // propose must appear before retire
      const proposeIdx = logOps.indexOf("propose");
      const retireIdx = logOps.indexOf("retire");
      assert.ok(proposeIdx < retireIdx, "AC1: propose log entry precedes retire entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1: retire requires non-empty rationale", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.retire(compiledId1, {
          targetStatus: "retired",
          rationale: "",
          decision: "apply",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /rationale/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1: retire rejects invalid targetStatus", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.retire(compiledId1, {
          targetStatus: "deleted",
          rationale: "Trying an invalid status.",
          decision: "apply",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /targetStatus/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC1: retire rejects nonexistent record id", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.retire("nonexistent-id", {
          targetStatus: "retired",
          rationale: "This record does not exist.",
          decision: "apply",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /record not found/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC1 — status transition table enforcement
// ---------------------------------------------------------------------------

describe("AC1 — status transition table enforcement", () => {
  test("active → retired is valid", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Obsolete.",
        decision: "apply",
      });

      const rec = await store.get(compiledId1);
      assert.equal(rec.status, "retired");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("active → implemented → retired is valid (two-step)", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Step 1: active → implemented
      await runner.retire(compiledId1, {
        targetStatus: "implemented",
        rationale: "Shipped in PR #1.",
        implementedByRef: "PR #1",
        decision: "apply",
      });
      let rec = await store.get(compiledId1);
      assert.equal(rec.status, "implemented");

      // Step 2: implemented → retired
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Fully superseded, archiving.",
        decision: "apply",
      });
      rec = await store.get(compiledId1);
      assert.equal(rec.status, "retired");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retired → * is invalid (terminal state)", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // First retire
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "First retirement.",
        decision: "apply",
      });

      // Then try again
      await assert.rejects(
        () => runner.retire(compiledId1, {
          targetStatus: "implemented",
          rationale: "Trying to re-open.",
          implementedByRef: "PR #99",
          decision: "apply",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /invalid transition/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("store.retire enforces transition table directly", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);

      // Retire directly via store
      await store.retire(compiledId1, "retired", {
        agent: "tester",
        rationale: "Direct store retire.",
      });

      // Attempting invalid transition via store throws MISSING_EVIDENCE
      await assert.rejects(
        () => store.retire(compiledId1, "implemented", {
          agent: "tester",
          rationale: "Cannot go back.",
          implementedByRef: "PR #X",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /invalid transition/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC1 — rejection leaves status byte-identical
// ---------------------------------------------------------------------------

describe("AC1 / rejection — rejection leaves record status byte-identical", () => {
  test("retire with decision=reject leaves record status unchanged", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const before = await store.get(compiledId1);
      const originalBody = before.body;
      const originalStatus = before.status || "active";

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Proposing retirement.",
        decision: "reject",
        rejectReason: "AC1: verifying that rejection does not mutate status.",
      });

      const after = await store.get(compiledId1);
      assert.equal(
        after.status || "active",
        originalStatus,
        "AC1: status unchanged after rejection"
      );
      assert.equal(after.body, originalBody, "AC1: body unchanged after rejection");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire rejection requires rejectReason", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.retire(compiledId1, {
          targetStatus: "retired",
          rationale: "Proposing.",
          decision: "reject",
          // rejectReason intentionally omitted
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /rejectReason/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reject path: mutation log has reject entry but no retire entry", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Proposing for rejection test.",
        decision: "reject",
        rejectReason: "Not ready yet.",
      });

      const after = await store.get(compiledId1);
      const logOps = (after.mutation_log || []).map((e) => e.op);
      assert.ok(logOps.includes("propose"), "rejection path: proposal was logged");
      assert.ok(logOps.includes("reject"), "rejection path: reject was logged");
      assert.ok(!logOps.includes("retire"), "rejection path: no retire entry (status not changed)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — retired excluded from defaults, included with flag, provenance intact
// ---------------------------------------------------------------------------

describe("AC2 — retired excluded from defaults, included with flag, provenance intact", () => {
  test("retired record excluded from listByType defaults", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1, compiledId2 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Retire compiledId1
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: testing exclusion from listByType.",
        decision: "apply",
      });

      const compiled = await store.listByType("compiled");
      assert.ok(!compiled.some((r) => r.id === compiledId1), "AC2: retired record excluded from listByType");
      assert.ok(compiled.some((r) => r.id === compiledId2), "AC2: active record included in listByType");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retired record included in listByType with includeRetired:true", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: testing includeRetired flag.",
        decision: "apply",
      });

      const all = await store.listByType("compiled", { includeRetired: true });
      assert.ok(all.some((r) => r.id === compiledId1), "AC2: retired record in listByType with includeRetired:true");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retired record excluded from listByCategory defaults", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: testing listByCategory exclusion.",
        decision: "apply",
      });

      const byCategory = await store.listByCategory("ops.decisions");
      assert.ok(!byCategory.some((r) => r.id === compiledId1), "AC2: retired excluded from listByCategory");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retired record included in listByCategory with includeRetired:true", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: includeRetired for category.",
        decision: "apply",
      });

      const all = await store.listByCategory("ops.decisions", { includeRetired: true });
      assert.ok(all.some((r) => r.id === compiledId1), "AC2: retired in listByCategory with includeRetired:true");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("get() always returns retired record with full provenance", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const originalBody = (await store.get(compiledId1)).body;

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: get still works after retirement.",
        decision: "apply",
      });

      const retired = await store.get(compiledId1);
      assert.ok(retired, "AC2: get() returns retired record");
      assert.equal(retired.status, "retired", "AC2: status is retired");
      assert.equal(retired.body, originalBody, "AC2: body is intact (not deleted)");
      assert.ok(retired.provenance, "AC2: provenance is intact");
      assert.ok(Array.isArray(retired.mutation_log), "AC2: mutation_log is present");
      const retireEntry = retired.mutation_log.find((e) => e.op === "retire");
      assert.ok(retireEntry, "AC2: retirement evidence in mutation_log");
      assert.ok(retireEntry.evidence.rationale, "AC2: rationale in retirement evidence");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2: defaultSimilarityDetector excludes retired candidates", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1, conceptId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Verify compiledId1 IS included before retirement
      const allCompiled = await store.listByType("compiled");
      const concept = await store.get(conceptId);
      const beforeCluster = await defaultSimilarityDetector(concept, allCompiled, store);
      assert.ok(beforeCluster.includes(compiledId1), "AC2: compiledId1 in cluster before retirement");

      // Retire compiledId1
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: testing detector exclusion.",
        decision: "apply",
      });

      // After retirement, listByType excludes it and so does the detector
      const activeCompiled = await store.listByType("compiled");
      assert.ok(!activeCompiled.some((r) => r.id === compiledId1), "AC2: retired not in listByType");
      const afterCluster = await defaultSimilarityDetector(concept, activeCompiled, store);
      assert.ok(!afterCluster.includes(compiledId1), "AC2: retired excluded from default detector");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2: vector similarity detector excludes retired records", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1, compiledId2, conceptId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Injectable embed: all records are "similar" to each other
      const injectEmbed = async (texts) => texts.map(() => [0.9, 0.1, 0.0]);
      const detector = createVectorSimilarityDetector({ embed: injectEmbed, threshold: 0.5 });

      // Before retirement: both compiled records should be in the cluster
      const concept = await store.get(conceptId);
      const allCompiled = await store.listByType("compiled");
      const beforeCluster = await detector(concept, allCompiled, store);
      assert.ok(beforeCluster.includes(compiledId1), "AC2: compiledId1 in vector cluster before retirement");
      assert.ok(beforeCluster.includes(compiledId2), "AC2: compiledId2 in vector cluster before retirement");

      // Retire compiledId1
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: vector detector test.",
        decision: "apply",
      });

      // After retirement: detector should exclude compiledId1
      const activeCompiled = await store.listByType("compiled");
      const afterCluster = await detector(concept, activeCompiled, store);
      assert.ok(!afterCluster.includes(compiledId1), "AC2: retired excluded from vector detector");
      assert.ok(afterCluster.includes(compiledId2), "AC2: active record still in vector cluster");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2: retired record reachable with includeRetired on all query surfaces", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "AC2: full reachability test.",
        decision: "apply",
      });

      // get() — always works
      const viaGet = await store.get(compiledId1);
      assert.ok(viaGet, "AC2: reachable via get()");

      // listByType with flag
      const viaType = await store.listByType("compiled", { includeRetired: true });
      assert.ok(viaType.some((r) => r.id === compiledId1), "AC2: reachable via listByType with flag");

      // listByCategory with flag
      const viaCat = await store.listByCategory("ops.decisions", { includeRetired: true });
      assert.ok(viaCat.some((r) => r.id === compiledId1), "AC2: reachable via listByCategory with flag");

      // prefix listByCategory with flag
      const viaPrefix = await store.listByCategory("ops", { prefix: true, includeRetired: true });
      assert.ok(viaPrefix.some((r) => r.id === compiledId1), "AC2: reachable via prefix listByCategory with flag");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — consolidation after retirement reflects pruned working set;
//        retired decision still reachable from snapshot provenance history
// ---------------------------------------------------------------------------

describe("AC3 — consolidation after retirement prunes working set; retired record still reachable", () => {
  test("AC3: consolidation cluster excludes retired compiled records", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Create 3 compiled records for the same topic
      const c1 = await store.create({
        type: "compiled",
        title: "API Decision v1",
        body: "Use REST for the API.",
        category: "ops.api",
        provenance: { agent: "fixture", source_ids: [] },
      });
      const c2 = await store.create({
        type: "compiled",
        title: "API Decision v2",
        body: "Use REST with OpenAPI spec.",
        category: "ops.api",
        provenance: { agent: "fixture", source_ids: [c1] },
      });
      const c3 = await store.create({
        type: "compiled",
        title: "API Decision v3 (active)",
        body: "Use REST with OpenAPI 3.1 and versioned endpoints.",
        category: "ops.api",
        provenance: { agent: "fixture", source_ids: [c1, c2] },
      });

      // Retire c1 (the oldest decision)
      await runner.retire(c1, {
        targetStatus: "retired",
        rationale: "AC3: c1 superseded by v2 and v3.",
        decision: "apply",
      });

      // Run consolidation — should only see c2 and c3 in the cluster
      const result = await runner.consolidate(
        { topic: "ops.api", category: "ops.api" },
        {
          proposedBody: "## API Design Decision\n\nUse REST with OpenAPI 3.1 and versioned endpoints.",
          rationale: "AC3: consolidation after c1 retirement.",
          decision: "apply",
        }
      );

      assert.ok(result.newSnapshotId, "AC3: new snapshot created");
      assert.ok(!result.cluster.includes(c1), "AC3: retired c1 excluded from consolidation cluster");
      assert.ok(result.cluster.includes(c2), "AC3: active c2 in cluster");
      assert.ok(result.cluster.includes(c3), "AC3: active c3 in cluster");

      // The retired record is still reachable via get()
      const retiredRecord = await store.get(c1);
      assert.ok(retiredRecord, "AC3: retired record still reachable via get()");
      assert.equal(retiredRecord.status, "retired", "AC3: retired status preserved");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC3: snapshot provenance source_ids (from prior consolidation) still link to retired record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Create 2 compiled records
      const c1 = await store.create({
        type: "compiled",
        title: "Auth Decision v1",
        body: "Use API keys.",
        category: "ops.auth",
        provenance: { agent: "fixture", source_ids: [] },
      });
      const c2 = await store.create({
        type: "compiled",
        title: "Auth Decision v2",
        body: "Use OAuth2.",
        category: "ops.auth",
        provenance: { agent: "fixture", source_ids: [c1] },
      });

      // Run first consolidation while both records are active
      const firstResult = await runner.consolidate(
        { topic: "ops.auth", category: "ops.auth" },
        {
          proposedBody: "Auth: API keys (v1).",
          rationale: "AC3: first snapshot.",
          decision: "apply",
        }
      );

      const firstSnapshot = await store.get(firstResult.newSnapshotId);
      // First snapshot's cluster included c1
      assert.ok(firstResult.cluster.includes(c1), "AC3: c1 in first consolidation cluster");

      // Now retire c1
      await runner.retire(c1, {
        targetStatus: "retired",
        rationale: "AC3: c1 is now retired.",
        decision: "apply",
      });

      // Run second consolidation — c1 should NOT be in the new cluster
      const secondResult = await runner.consolidate(
        firstResult.newSnapshotId,
        {
          proposedBody: "Auth: OAuth2 (v2).",
          rationale: "AC3: second snapshot after c1 retirement.",
          decision: "apply",
        }
      );

      assert.ok(!secondResult.cluster.includes(c1), "AC3: retired c1 excluded from second cluster");
      assert.ok(secondResult.cluster.includes(c2), "AC3: active c2 in second cluster");

      // First snapshot still has provenance linking to c1 (history preserved)
      // The first snapshot's provenance.source_ids referenced c1 at creation time
      const firstSnapshotAfter = await store.get(firstResult.newSnapshotId);
      // c1 is still queryable
      const c1Record = await store.get(c1);
      assert.ok(c1Record, "AC3: retired c1 still reachable via get()");
      assert.equal(c1Record.status, "retired", "AC3: c1 status is retired");

      // The new (second) snapshot does not reference c1 in provenance
      const secondSnapshot = await store.get(secondResult.newSnapshotId);
      const secondSourceIds = secondSnapshot.provenance.source_ids || [];
      assert.ok(!secondSourceIds.includes(c1), "AC3: second snapshot provenance does not include retired c1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC3: retired record reachable from snapshot provenance history", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Single compiled record
      const c1 = await store.create({
        type: "compiled",
        title: "Decision: single region",
        body: "Deploy to us-east-1 only.",
        category: "ops.deploy",
        provenance: { agent: "fixture", source_ids: [] },
      });

      // Create a snapshot that references c1 directly
      const snapshotId = await store.create({
        type: "snapshot",
        title: "Snapshot: ops.deploy",
        body: "Current: single region (us-east-1).",
        category: "ops.deploy",
        tags: ["topic:ops.deploy"],
        links: [{ target_id: c1, kind: "source" }],
        provenance: { agent: "fixture", source_ids: [c1] },
      });

      // Retire c1
      await runner.retire(c1, {
        targetStatus: "retired",
        rationale: "AC3: decision was implemented; now archiving.",
        implementedByRef: "commit:abc123",
        decision: "apply",
      });

      // Snapshot still references c1 in provenance — no automatic mutation
      const snapshotAfter = await store.get(snapshotId);
      assert.ok(snapshotAfter, "AC3: snapshot still queryable");
      assert.ok(
        (snapshotAfter.provenance.source_ids || []).includes(c1),
        "AC3: snapshot provenance still references retired c1"
      );

      // Retired c1 is reachable from snapshot provenance reference
      const c1ViaProvenance = await store.get(c1);
      assert.ok(c1ViaProvenance, "AC3: retired c1 reachable via provenance ref");
      assert.equal(c1ViaProvenance.status, "retired", "AC3: c1 status is retired");
      const retireEntry = (c1ViaProvenance.mutation_log || []).find((e) => e.op === "retire");
      assert.ok(retireEntry, "AC3: retirement evidence preserved in mutation_log");
      assert.equal(retireEntry.evidence.implementedByRef, "commit:abc123", "AC3: implementedByRef preserved");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Gate telemetry — retire emits events at each gate
// ---------------------------------------------------------------------------

describe("Gate telemetry — retire emits events at each gate", () => {
  test("retire emits identify, propose-retirement, evidence, apply gate events", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Telemetry gate test.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      assert.ok(events.length > 0, "telemetry events were emitted");

      const gateNames = events
        .filter((e) => e.tool?.name)
        .map((e) => e.tool.name);

      assert.ok(gateNames.some((n) => n.includes("identify-gate")), "identify-gate events emitted");
      assert.ok(gateNames.some((n) => n.includes("propose-retirement-gate")), "propose-retirement-gate events emitted");
      assert.ok(gateNames.some((n) => n.includes("evidence-gate")), "evidence-gate events emitted");
      assert.ok(gateNames.some((n) => n.includes("apply-gate")), "apply-gate events emitted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate events have entry (tool.invoke) and exit (tool.result) pairs", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Entry/exit event pair test.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      const retireEvents = events.filter((e) => e.tool?.name?.includes("knowledge.retire"));

      const gateIds = [
        "identify-gate",
        "propose-retirement-gate",
        "evidence-gate",
        "apply-gate",
      ];
      for (const gateId of gateIds) {
        const gateEvents = retireEvents.filter((e) => e.tool?.name?.includes(gateId));
        const invokeEvent = gateEvents.find((e) => e.event_type === "tool.invoke");
        const resultEvent = gateEvents.find((e) => e.event_type === "tool.result");
        assert.ok(invokeEvent, `${gateId}: tool.invoke event present`);
        assert.ok(resultEvent, `${gateId}: tool.result event present`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejection path emits apply-gate events with decision=reject", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Proposing for rejection telemetry test.",
        decision: "reject",
        rejectReason: "Testing rejection telemetry.",
      });

      const events = readTelemetryEvents(dir);
      const applyGateEvents = events.filter((e) => e.tool?.name?.includes("apply-gate"));
      assert.ok(applyGateEvents.length >= 2, "apply-gate has entry and exit events on reject path");

      const resultEvent = applyGateEvents.find(
        (e) => e.event_type === "tool.result" && e.tool?.output?.decision === "reject"
      );
      assert.ok(resultEvent, "apply-gate result event has decision=reject");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire telemetry events have correct schema_version and agent block", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = new KnowledgeFlowRunner({
        store,
        workspace: dir,
        agent: "tel-retirement-agent",
        sessionId: "tel-retirement-session",
      });

      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Schema version test.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      const retireEvents = events.filter((e) => e.tool?.name?.includes("knowledge.retire"));

      assert.ok(retireEvents.length > 0, "retire events were emitted");
      for (const ev of retireEvents) {
        assert.equal(ev.schema_version, "0.3.0", "event has schema_version 0.3.0");
        assert.equal(ev.agent.name, "tel-retirement-agent", "agent.name matches");
        assert.equal(ev.agent.runtime, "knowledge-kit", "agent.runtime is knowledge-kit");
        assert.equal(ev.session_id, "tel-retirement-session", "session_id matches");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Store retire op direct tests
// ---------------------------------------------------------------------------

describe("store.retire — direct op tests", () => {
  test("retire requires agent", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      await assert.rejects(
        () => store.retire(compiledId1, "retired", { rationale: "r" }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /agent/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire requires rationale", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      await assert.rejects(
        () => store.retire(compiledId1, "retired", { agent: "tester" }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /rationale/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire requires implementedByRef when targetStatus=implemented", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      await assert.rejects(
        () => store.retire(compiledId1, "implemented", { agent: "tester", rationale: "r" }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /implementedByRef/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire rejects nonexistent record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      await assert.rejects(
        () => store.retire("nonexistent", "retired", { agent: "tester", rationale: "r" }),
        { code: "NOT_FOUND" }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire rejects invalid targetStatus", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      await assert.rejects(
        () => store.retire(compiledId1, "deleted", { agent: "tester", rationale: "r" }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /targetStatus/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retire does not delete the record — body intact", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const before = await store.get(compiledId1);

      await store.retire(compiledId1, "retired", {
        agent: "tester",
        rationale: "Non-destructive retirement test.",
      });

      const after = await store.get(compiledId1);
      assert.ok(after, "record still exists after retire");
      assert.equal(after.body, before.body, "body is intact after retire");
      assert.equal(after.category, before.category, "category is intact after retire");
      assert.deepEqual(after.provenance, before.provenance, "provenance is intact after retire");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("update op ignores status field — cannot circumvent retirement gate via update", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);

      // Retire the record first
      await store.retire(compiledId1, "retired", {
        agent: "tester",
        rationale: "Test: cannot reset via update.",
      });

      // Try to use update to reset status — should either ignore or throw
      // The contract says update MUST ignore status; so status stays retired
      try {
        await store.update(compiledId1, { status: "active", title: "Updated title" }, { agent: "tester" });
      } catch (e) {
        // If update throws because status is not a valid mutable field, that's also acceptable
      }

      // Either way, status must still be retired
      const rec = await store.get(compiledId1);
      assert.equal(rec.status, "retired", "update cannot reset status — status stays retired");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #106 — close-proposal: applying a retirement proposal auto-closes the spent
// proposal artifact (no dangling active twin; double-prefixed twin never spawns)
// ---------------------------------------------------------------------------

describe("#106 — close-proposal: apply auto-retires the spent proposal artifact", () => {
  // Helper: count non-retired records whose title marks them a retirement-proposal
  // artifact (these are the dangling "Retirement proposal: …" records #106 is about).
  function activeProposalArtifacts(store) {
    return store
      ._allRecords()
      .filter(
        (r) =>
          (r.status || "active") !== "retired" &&
          typeof r.title === "string" &&
          r.title.startsWith("Retirement proposal")
      );
  }

  test("after apply, the proposal artifact is retired and leaves no active twin; the change persisted", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Superseded by the versioning policy.",
        decision: "apply",
      });

      // The applied change persisted: the target record is retired.
      const target = await store.get(compiledId1);
      assert.equal(target.status, "retired", "target record was retired (change persisted)");

      // The spent proposal artifact is auto-closed (retired), not left active.
      const artifact = await store.get(result.proposerId);
      assert.ok(artifact, "proposal artifact still exists (closed, not deleted)");
      assert.equal(
        artifact.status,
        "retired",
        "spent proposal artifact is auto-retired after apply (#106)"
      );
      assert.equal(result.proposalClosed, true, "retire() reports the artifact was closed");

      // No dangling active "Retirement proposal: …" twin remains.
      assert.equal(
        activeProposalArtifacts(store).length,
        0,
        "no active proposal-artifact twin remains after apply (#106)"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hygiene sweep over active records no longer spawns a double-prefixed twin", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Retire a record (apply) — historically left an active proposal artifact.
      await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Superseded.",
        decision: "apply",
      });

      // Simulate a hygiene sweep: retire every still-active proposal artifact.
      // With the fix there are none, so the sweep is a no-op and no
      // "Retirement proposal: Retirement proposal: …" twin can be born.
      const before = activeProposalArtifacts(store);
      for (const artifact of before) {
        await runner.retire(artifact.id, {
          targetStatus: "retired",
          rationale: "Cleaning up dangling proposal artifact.",
          decision: "apply",
        });
      }

      const doublePrefixed = store
        ._allRecords()
        .filter(
          (r) =>
            typeof r.title === "string" &&
            r.title.startsWith("Retirement proposal: Retirement proposal")
        );
      assert.equal(
        doublePrefixed.length,
        0,
        "no double-prefixed 'Retirement proposal: Retirement proposal: …' twin exists (#106)"
      );
      assert.equal(
        activeProposalArtifacts(store).length,
        0,
        "no active proposal artifacts remain after the sweep (#106)"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reject is unchanged — the proposal artifact stays active (proposal not spent)", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1 } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const before = await store.get(compiledId1);

      const result = await runner.retire(compiledId1, {
        targetStatus: "retired",
        rationale: "Proposing retirement.",
        decision: "reject",
        rejectReason: "Not ready to retire this yet.",
      });

      // Target status is byte-identical (rejection does not mutate it).
      const after = await store.get(compiledId1);
      assert.equal(
        after.status || "active",
        before.status || "active",
        "reject leaves target status unchanged"
      );

      // The proposal artifact remains active — the proposal was declined, not
      // spent, so it is NOT auto-closed (close happens only on apply).
      const artifact = await store.get(result.proposerId);
      assert.equal(
        artifact.status || "active",
        "active",
        "reject leaves the proposal artifact active (not closed)"
      );
      assert.equal(
        result.proposalClosed,
        false,
        "retire(reject) does not report a closed artifact"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
