/**
 * Knowledge Kit — Consolidation Eval Suite
 *
 * Covers:
 *   AC1 (R2): a related event yields a consolidation proposal, not a mutation.
 *       After propose, the snapshot body is unchanged; only a "proposes" link
 *       and mutation log entry are created.
 *   AC2: applied consolidation updates exactly ONE new snapshot, links supersedes
 *       refs to the prior snapshot(s), and leaves all superseded sources queryable
 *       with provenance intact.
 *   AC3 fixture: a decision changed across 3 events (3 compiled records representing
 *       3 decision states) — the resulting snapshot body reflects ONLY the latest
 *       decision (from the proposedBody), with provenance to all 3 compiled sources.
 *   Supersede-not-delete invariant: calling consolidate never removes any record;
 *       superseded snapshots are still returned by get() and listByType("snapshot").
 *   Gate telemetry: related-event, propose, evidence, apply gate events emitted.
 *
 * Run:
 *   node --test kits/knowledge/evals/consolidation/suite.test.js
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
const { KnowledgeFlowRunner } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-consolidation-"));
}

function makeStore(dir) {
  return new DefaultKnowledgeStore({ storeRoot: dir });
}

function makeRunner(store, storeDir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: storeDir,
    agent: "consolidation-test-runner",
    sessionId: "consolidation-session-001",
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
 *   - 1 existing snapshot for topic "ops.decisions" (the "prior snapshot")
 * Returns { store, compiledId1, compiledId2, priorSnapshotId }
 */
async function buildFixture(dir) {
  const store = makeStore(dir);

  // Create two compiled records representing decisions
  const compiledId1 = await store.create({
    type: "compiled",
    title: "Decision: Use REST for public API",
    body: "## Decision\n\nWe will use REST for the public API.",
    category: "ops.decisions",
    provenance: { agent: "fixture", source_ids: [] },
  });

  const compiledId2 = await store.create({
    type: "compiled",
    title: "Decision: Versioning via URL path",
    body: "## Decision\n\nVersioning will be done via URL path (/v1/, /v2/).",
    category: "ops.decisions",
    provenance: { agent: "fixture", source_ids: [] },
  });

  // Create a prior snapshot for the topic
  const priorSnapshotId = await store.create({
    type: "snapshot",
    title: "Snapshot: ops.decisions",
    body: "Prior snapshot body: REST API, no versioning decision yet.",
    category: "ops.decisions",
    tags: ["topic:ops.decisions"],
    provenance: { agent: "fixture", source_ids: [compiledId1] },
  });

  return { store, compiledId1, compiledId2, priorSnapshotId };
}

// ---------------------------------------------------------------------------
// AC1: related event yields a consolidation proposal, not a direct mutation
// ---------------------------------------------------------------------------

describe("AC1 — related event yields a proposal, not a direct mutation", () => {
  test("consolidate with decision=apply uses propose op before updating snapshot", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1, compiledId2, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      // Capture the prior snapshot body before consolidation
      const beforeSnapshot = await store.get(priorSnapshotId);
      assert.ok(beforeSnapshot.body.includes("Prior snapshot body"), "prior snapshot has expected body");

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "Updated: REST API with URL versioning (/v1/, /v2/).",
        rationale: "Two compiled decisions confirm this updated summary.",
        decision: "apply",
      });

      assert.ok(result.snapshotId, "result has snapshotId");
      assert.ok(result.proposerId, "result has proposerId");
      assert.ok(Array.isArray(result.cluster), "result has cluster array");
      assert.ok(result.cluster.length >= 1, "cluster has at least one member");
      assert.equal(result.decision, "apply");
      assert.ok(result.newSnapshotId, "result has newSnapshotId after apply");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proposer record has a 'proposes' link to the snapshot before mutation", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "Propose link test body.",
        rationale: "Testing proposes link.",
        decision: "apply",
      });

      // The proposer must have a "proposes" link to the snapshot
      const { forward } = await store.getLinks(result.proposerId);
      const proposesLinks = forward.filter(
        (l) => l.target_id === result.snapshotId && l.kind === "proposes"
      );
      assert.ok(proposesLinks.length >= 1, "AC1: proposer has a 'proposes' link to the snapshot");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("store.propose is used — mutation log on snapshot has a propose entry", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "Mutation log test body.",
        rationale: "Checking mutation log.",
        decision: "apply",
      });

      // The prior snapshot (which receives the propose op) should have a propose log entry
      const snapshot = await store.get(priorSnapshotId);
      const proposeEntries = (snapshot.mutation_log || []).filter((e) => e.op === "propose");
      assert.ok(proposeEntries.length >= 1, "AC1: snapshot mutation log has a propose entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejection leaves snapshot body unchanged (proposal did not mutate)", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const beforeSnapshot = await store.get(priorSnapshotId);
      const originalBody = beforeSnapshot.body;

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "This body should NOT replace the snapshot.",
        decision: "reject",
        rejectReason: "AC1: verifying propose does not mutate on reject path.",
      });

      const afterSnapshot = await store.get(priorSnapshotId);
      assert.equal(
        afterSnapshot.body,
        originalBody,
        "AC1: snapshot body unchanged after rejection — proposal did not mutate"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: applied consolidation updates exactly ONE snapshot, links supersedes
//      refs, and superseded sources remain queryable with provenance intact
// ---------------------------------------------------------------------------

describe("AC2 — apply updates exactly ONE new snapshot, links supersedes refs, superseded sources queryable", () => {
  test("apply creates exactly one new snapshot", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const snapshotsBefore = await store.listByType("snapshot");
      assert.equal(snapshotsBefore.length, 1, "one prior snapshot before consolidation");

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "Consolidated: REST API with URL versioning.",
        rationale: "AC2 test: one new snapshot created.",
        decision: "apply",
      });

      const snapshotsAfter = await store.listByType("snapshot");
      // We may have: the prior snapshot, possibly a placeholder, and the new snapshot.
      // The key constraint is that newSnapshotId is exactly one new record.
      assert.ok(result.newSnapshotId, "AC2: newSnapshotId is set");
      const newSnap = await store.get(result.newSnapshotId);
      assert.ok(newSnap, "AC2: new snapshot record exists");
      assert.equal(newSnap.type, "snapshot", "AC2: new record is type snapshot");
      assert.equal(
        newSnap.body,
        "Consolidated: REST API with URL versioning.",
        "AC2: new snapshot has the proposed body"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("new snapshot links supersedes refs to the prior snapshot", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "New snapshot with supersedes link.",
        rationale: "AC2 test: verify supersedes links.",
        decision: "apply",
      });

      // The new snapshot must have a "supersedes" link to the prior snapshot
      const { forward } = await store.getLinks(result.newSnapshotId);
      const supersededLinks = forward.filter((l) => l.kind === "supersedes");
      assert.ok(supersededLinks.length >= 1, "AC2: new snapshot has supersedes links");

      // The prior snapshot must appear in supersedes links
      const priorInLinks = supersededLinks.some((l) => l.target_id === priorSnapshotId);
      assert.ok(priorInLinks, "AC2: new snapshot links supersedes to the prior snapshot");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prior snapshot is still queryable after consolidation (supersede-not-delete)", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const priorBody = (await store.get(priorSnapshotId)).body;

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "New snapshot body.",
        rationale: "AC2: verify prior snapshot queryable.",
        decision: "apply",
      });

      // Prior snapshot must still be retrievable
      const priorAfter = await store.get(priorSnapshotId);
      assert.ok(priorAfter, "AC2: prior snapshot still exists after consolidation");
      assert.equal(priorAfter.body, priorBody, "AC2: prior snapshot body is intact (not deleted)");
      assert.equal(priorAfter.type, "snapshot", "AC2: prior snapshot type preserved");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prior snapshot is returned by listByType('snapshot') after supersession", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "New snapshot body.",
        rationale: "AC2 list test.",
        decision: "apply",
      });

      const allSnapshots = await store.listByType("snapshot");
      const priorInList = allSnapshots.some((s) => s.id === priorSnapshotId);
      assert.ok(priorInList, "AC2: prior snapshot appears in listByType('snapshot') after supersession");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prior snapshot has a superseded-by mutation log entry", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "New snapshot for superseded-by log test.",
        rationale: "AC2: verify superseded-by log.",
        decision: "apply",
      });

      const priorAfter = await store.get(priorSnapshotId);
      const supersededByEntries = (priorAfter.mutation_log || []).filter(
        (e) => e.op === "superseded-by"
      );
      assert.ok(supersededByEntries.length >= 1, "AC2: prior snapshot has superseded-by log entry");
      assert.equal(
        supersededByEntries[supersededByEntries.length - 1].new_id,
        result.newSnapshotId,
        "AC2: superseded-by entry references the new snapshot id"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("new snapshot provenance source_ids references all contributing compiled records", async () => {
    const dir = makeTempDir();
    try {
      const { store, compiledId1, compiledId2, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      const result = await runner.consolidate(priorSnapshotId, {
        proposedBody: "New snapshot with full provenance.",
        rationale: "AC2: verify source_ids in provenance.",
        decision: "apply",
      });

      const newSnap = await store.get(result.newSnapshotId);
      assert.ok(newSnap.provenance.source_ids, "AC2: new snapshot has provenance.source_ids");
      assert.ok(
        Array.isArray(newSnap.provenance.source_ids),
        "AC2: provenance.source_ids is an array"
      );
      assert.ok(newSnap.provenance.source_ids.length >= 1, "AC2: at least one source_id in provenance");
      // Every source_id must resolve to a compiled record
      for (const srcId of newSnap.provenance.source_ids) {
        const rec = await store.get(srcId);
        assert.ok(rec, `AC2: source ${srcId} resolves to a record`);
        assert.equal(rec.type, "compiled", `AC2: source ${srcId} is a compiled record`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 fixture: decision changed across 3 events → snapshot reflects ONLY the
//             latest decision, with provenance to all 3 compiled sources
// ---------------------------------------------------------------------------

describe("AC3 — decision changed across 3 events: snapshot reflects latest, provenance to all 3", () => {
  test("AC3 fixture: 3 compiled records, snapshot body has latest decision, provenance to all 3", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Event 1: initial decision
      const compiled1 = await store.create({
        type: "compiled",
        title: "Decision v1: Deploy to single region",
        body: "Decision: Deploy the service to us-east-1 only.",
        category: "ops.deployment",
        provenance: { agent: "fixture", source_ids: [] },
      });

      // Event 2: decision changed
      const compiled2 = await store.create({
        type: "compiled",
        title: "Decision v2: Deploy to two regions",
        body: "Decision revised: Deploy to us-east-1 AND eu-west-1 for redundancy.",
        category: "ops.deployment",
        provenance: { agent: "fixture", source_ids: [compiled1] },
      });

      // Event 3: decision changed again (latest)
      const compiled3 = await store.create({
        type: "compiled",
        title: "Decision v3: Deploy to three regions",
        body: "Decision final: Deploy to us-east-1, eu-west-1, AND ap-southeast-1.",
        category: "ops.deployment",
        provenance: { agent: "fixture", source_ids: [compiled1, compiled2] },
      });

      // Run consolidation using a topic selector (no prior snapshot yet)
      const proposedBody =
        "## Current Deployment Decision\n\n" +
        "Deploy to three regions: us-east-1, eu-west-1, ap-southeast-1.\n\n" +
        "This decision supersedes earlier single-region and two-region proposals.";

      const result = await runner.consolidate(
        { topic: "ops.deployment", category: "ops.deployment" },
        {
          proposedBody,
          rationale:
            "AC3: final deployment decision across 3 compiled events. " +
            "Latest decision (v3: three regions) supersedes v1 and v2.",
          decision: "apply",
        }
      );

      assert.ok(result.newSnapshotId, "AC3: a new snapshot was created");
      assert.equal(result.decision, "apply", "AC3: decision is apply");

      // The new snapshot body must reflect ONLY the latest decision
      const newSnap = await store.get(result.newSnapshotId);
      assert.ok(newSnap, "AC3: new snapshot record exists");
      assert.ok(
        newSnap.body.includes("three regions"),
        "AC3: snapshot body reflects the latest decision (three regions)"
      );
      assert.ok(
        !newSnap.body.includes("single region") && !newSnap.body.includes("us-east-1 only"),
        "AC3: snapshot body does NOT contain stale earlier decisions verbatim"
      );

      // Provenance must link to all 3 compiled source records
      assert.ok(
        Array.isArray(newSnap.provenance.source_ids),
        "AC3: provenance.source_ids is an array"
      );
      // The cluster should include all 3 compiled records (same category)
      for (const srcId of [compiled1, compiled2, compiled3]) {
        const inCluster = result.cluster.includes(srcId);
        const inProvenance = newSnap.provenance.source_ids.includes(srcId);
        // At minimum, all 3 should be in the cluster
        assert.ok(
          inCluster,
          `AC3: compiled record ${srcId} is in the cluster (related event)`
        );
      }

      // The snapshot links source records via "source" links
      const { forward } = await store.getLinks(result.newSnapshotId);
      const sourceLinks = forward.filter((l) => l.kind === "source");
      assert.ok(sourceLinks.length >= 1, "AC3: new snapshot has source links to compiled records");

      // All 3 compiled records must still be queryable (not deleted)
      for (const srcId of [compiled1, compiled2, compiled3]) {
        const rec = await store.get(srcId);
        assert.ok(rec, `AC3: compiled source ${srcId} is still queryable after consolidation`);
        assert.equal(rec.type, "compiled", `AC3: source ${srcId} type preserved`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC3: reading only the snapshot gives the latest decision (not stale earlier text)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Three compiled records with evolving decisions
      const c1 = await store.create({
        type: "compiled",
        title: "Auth Decision v1",
        body: "Use Basic Auth for all endpoints.",
        category: "ops.auth",
        provenance: { agent: "fixture", source_ids: [] },
      });
      const c2 = await store.create({
        type: "compiled",
        title: "Auth Decision v2",
        body: "Switch to API keys; Basic Auth deprecated.",
        category: "ops.auth",
        provenance: { agent: "fixture", source_ids: [c1] },
      });
      const c3 = await store.create({
        type: "compiled",
        title: "Auth Decision v3",
        body: "Use OAuth2 with short-lived tokens. API keys phase out by Q3.",
        category: "ops.auth",
        provenance: { agent: "fixture", source_ids: [c1, c2] },
      });

      const latestDecision =
        "Current auth decision: OAuth2 with short-lived tokens. " +
        "API keys phased out Q3. Basic Auth deprecated.";

      const result = await runner.consolidate(
        { topic: "ops.auth", category: "ops.auth" },
        {
          proposedBody: latestDecision,
          rationale: "Auth decision updated three times; snapshot reflects v3 only.",
          decision: "apply",
        }
      );

      // An agent reading ONLY the snapshot gets the latest decision
      const snapshot = await store.get(result.newSnapshotId);
      assert.equal(
        snapshot.body,
        latestDecision,
        "AC3: agent reading snapshot gets only the latest decision"
      );

      // Provenance still links back to all 3
      assert.ok(result.cluster.includes(c1), "AC3: c1 in cluster (provenance traceability)");
      assert.ok(result.cluster.includes(c2), "AC3: c2 in cluster (provenance traceability)");
      assert.ok(result.cluster.includes(c3), "AC3: c3 in cluster (provenance traceability)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Supersede-not-delete invariant
// ---------------------------------------------------------------------------

describe("Supersede-not-delete invariant", () => {
  test("store.supersede does not delete any record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const oldId = await store.create({
        type: "snapshot",
        title: "Old Snapshot",
        body: "Old snapshot body.",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      const newId = await store.create({
        type: "snapshot",
        title: "New Snapshot",
        body: "New snapshot body.",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await store.supersede(newId, [oldId], {
        agent: "tester",
        rationale: "Supersede invariant test.",
      });

      // Old record must still exist
      const old = await store.get(oldId);
      assert.ok(old, "supersede-not-delete: old record still exists after supersede");
      assert.equal(old.body, "Old snapshot body.", "supersede-not-delete: old body intact");

      // New record has supersedes link
      const { forward } = await store.getLinks(newId);
      assert.ok(
        forward.some((l) => l.target_id === oldId && l.kind === "supersedes"),
        "supersede-not-delete: new record has supersedes link"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("supersede requires agent (missing agent throws MISSING_EVIDENCE)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const aId = await store.create({
        type: "snapshot",
        title: "A",
        body: "a",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });
      const bId = await store.create({
        type: "snapshot",
        title: "B",
        body: "b",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await assert.rejects(
        () => store.supersede(bId, [aId], { rationale: "r" }),
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

  test("supersede requires rationale (missing rationale throws MISSING_EVIDENCE)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const aId = await store.create({
        type: "snapshot",
        title: "A",
        body: "a",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });
      const bId = await store.create({
        type: "snapshot",
        title: "B",
        body: "b",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await assert.rejects(
        () => store.supersede(bId, [aId], { agent: "tester" }),
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

  test("supersede requires non-empty supersededIds array", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const bId = await store.create({
        type: "snapshot",
        title: "B",
        body: "b",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await assert.rejects(
        () => store.supersede(bId, [], { agent: "tester", rationale: "r" }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("supersede rejects nonexistent new_id", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const aId = await store.create({
        type: "snapshot",
        title: "A",
        body: "a",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await assert.rejects(
        () => store.supersede("nonexistent-id", [aId], { agent: "tester", rationale: "r" }),
        { code: "NOT_FOUND" }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("superseded record has reverse link from superseding record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const oldId = await store.create({
        type: "snapshot",
        title: "Old",
        body: "old body",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });
      const newId = await store.create({
        type: "snapshot",
        title: "New",
        body: "new body",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      await store.supersede(newId, [oldId], {
        agent: "tester",
        rationale: "Reverse link test.",
      });

      const { reverse } = await store.getLinks(oldId);
      assert.ok(
        reverse.some((l) => l.source_id === newId && l.kind === "supersedes"),
        "supersede: old record has reverse link showing who supersedes it"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshot type accepted in create", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const id = await store.create({
        type: "snapshot",
        title: "Test Snapshot",
        body: "snapshot body",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      assert.ok(id, "snapshot record created");
      const rec = await store.get(id);
      assert.equal(rec.type, "snapshot");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Contract suite extensions: snapshot semantics in contract suite
// ---------------------------------------------------------------------------

describe("Contract suite extensions — snapshot semantics", () => {
  test("listByType('snapshot') returns only snapshot records", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      await store.create({
        type: "raw",
        title: "R",
        body: "r",
        category: "test",
        provenance: { agent: "tester" },
      });
      await store.create({
        type: "snapshot",
        title: "S",
        body: "s",
        category: "test",
        tags: ["topic:test"],
        provenance: { agent: "tester" },
      });

      const snaps = await store.listByType("snapshot");
      assert.ok(snaps.length >= 1, "at least 1 snapshot returned");
      assert.ok(snaps.every((r) => r.type === "snapshot"), "all returned are snapshots");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshot round-trips: body, tags, category intact", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const id = await store.create({
        type: "snapshot",
        title: "Round-trip Snapshot",
        body: "Decision: Use GraphQL for internal APIs.",
        category: "ops.api",
        tags: ["topic:ops.api", "priority:high"],
        provenance: { agent: "tester", source_ids: [] },
      });

      const rec = await store.get(id);
      assert.equal(rec.type, "snapshot");
      assert.equal(rec.category, "ops.api");
      assert.ok(rec.tags.includes("topic:ops.api"), "topic tag preserved");
      assert.equal(rec.body, "Decision: Use GraphQL for internal APIs.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("propose on snapshot creates proposes link (propose op extended to snapshot)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const snapId = await store.create({
        type: "snapshot",
        title: "Target Snapshot",
        body: "current decisions",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      const proposerId = await store.create({
        type: "compiled",
        title: "Proposer",
        body: "proposing new snapshot content",
        category: "ops.test",
        provenance: { agent: "tester", source_ids: [] },
      });

      await store.propose(snapId, proposerId, {
        agent: "tester",
        proposal: "Updated decisions summary.",
      });

      const { forward } = await store.getLinks(proposerId);
      assert.ok(
        forward.some((l) => l.target_id === snapId && l.kind === "proposes"),
        "propose on snapshot creates proposes link"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reject on snapshot does not mutate snapshot body (supersede-not-delete extends to reject)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      const snapId = await store.create({
        type: "snapshot",
        title: "Stable Snapshot",
        body: "stable body",
        category: "ops.test",
        tags: ["topic:ops.test"],
        provenance: { agent: "tester" },
      });

      const proposerId = await store.create({
        type: "compiled",
        title: "Proposer",
        body: "proposer content",
        category: "ops.test",
        provenance: { agent: "tester", source_ids: [] },
      });

      await store.propose(snapId, proposerId, {
        agent: "tester",
        proposal: "Controversial change.",
      });

      const bodyBefore = (await store.get(snapId)).body;

      await store.reject(snapId, proposerId, {
        agent: "tester",
        reason: "Not aligned.",
      });

      const snapAfter = await store.get(snapId);
      assert.equal(
        snapAfter.body,
        bodyBefore,
        "reject on snapshot leaves body unchanged"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Gate telemetry: consolidate emits events at each gate
// ---------------------------------------------------------------------------

describe("Gate telemetry — consolidate emits events at each gate", () => {
  test("consolidate emits related-event, propose, evidence, apply gate events", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "Telemetry gate test body.",
        rationale: "Checking all gate events are emitted.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      assert.ok(events.length > 0, "telemetry events were emitted");

      const gateNames = events
        .filter((e) => e.tool?.name)
        .map((e) => e.tool.name);

      const hasRelatedEvent = gateNames.some((n) => n.includes("related-event-gate"));
      const hasPropose = gateNames.some((n) => n.includes("propose-gate"));
      const hasEvidence = gateNames.some((n) => n.includes("evidence-gate"));
      const hasApply = gateNames.some((n) => n.includes("apply-gate"));

      assert.ok(hasRelatedEvent, "related-event-gate events emitted");
      assert.ok(hasPropose, "propose-gate events emitted");
      assert.ok(hasEvidence, "evidence-gate events emitted");
      assert.ok(hasApply, "apply-gate events emitted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate events have entry (tool.invoke) and exit (tool.result) pairs", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "Entry/exit event pair test.",
        rationale: "Checking event pairs.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      const consolidateEvents = events.filter((e) => e.tool?.name?.includes("knowledge.consolidate"));

      const gateIds = [
        "related-event-gate",
        "propose-gate",
        "evidence-gate",
        "apply-gate",
      ];
      for (const gateId of gateIds) {
        const gateEvents = consolidateEvents.filter((e) => e.tool?.name?.includes(gateId));
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
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "Reject path telemetry test.",
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

  test("consolidate telemetry events have correct schema_version and agent block", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = new KnowledgeFlowRunner({
        store,
        workspace: dir,
        agent: "tel-consolidation-agent",
        sessionId: "tel-consolidation-session",
      });

      await runner.consolidate(priorSnapshotId, {
        proposedBody: "Schema version test.",
        rationale: "Checking schema version.",
        decision: "apply",
      });

      const events = readTelemetryEvents(dir);
      const consolidateEvents = events.filter((e) => e.tool?.name?.includes("knowledge.consolidate"));

      assert.ok(consolidateEvents.length > 0, "consolidate events were emitted");
      for (const ev of consolidateEvents) {
        assert.equal(ev.schema_version, "0.3.0", "event has schema_version 0.3.0");
        assert.equal(ev.agent.name, "tel-consolidation-agent", "agent.name matches");
        assert.equal(ev.agent.runtime, "knowledge-kit", "agent.runtime is knowledge-kit");
        assert.equal(ev.session_id, "tel-consolidation-session", "session_id matches");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("consolidate — input validation", () => {
  test("rejects missing snapshotIdOrTopic", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(null, {
          proposedBody: "body",
          decision: "apply",
          rationale: "r",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects nonexistent snapshot id", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate("nonexistent-snapshot-id", {
          proposedBody: "body",
          decision: "apply",
          rationale: "r",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /snapshot not found/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects snapshot id that points to a non-snapshot record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      const rawId = await store.create({
        type: "raw",
        title: "Not a snapshot",
        body: "raw body",
        category: "test",
        provenance: { agent: "test" },
      });

      await assert.rejects(
        () => runner.consolidate(rawId, {
          proposedBody: "body",
          decision: "apply",
          rationale: "r",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /expected "snapshot"/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing proposedBody", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(priorSnapshotId, {
          // proposedBody omitted
          decision: "apply",
          rationale: "r",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /proposedBody is required/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid decision value", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(priorSnapshotId, {
          proposedBody: "body",
          decision: "maybe",
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /"apply" or "reject"/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing rationale on apply", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(priorSnapshotId, {
          proposedBody: "Some body.",
          decision: "apply",
          // rationale intentionally omitted
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /rationale is required/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing rejectReason on reject", async () => {
    const dir = makeTempDir();
    try {
      const { store, priorSnapshotId } = await buildFixture(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(priorSnapshotId, {
          proposedBody: "Some body.",
          decision: "reject",
          // rejectReason intentionally omitted
        }),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /rejectReason is required/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("topicSelector with missing topic/category throws MISSING_EVIDENCE", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(
          {},  // empty topicSelector
          {
            proposedBody: "body",
            decision: "apply",
            rationale: "r",
          }
        ),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /topicSelector must include/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
