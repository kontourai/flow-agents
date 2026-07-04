/**
 * Knowledge Kit — Incremental Consolidation Eval Suite (#343, Addendum L)
 *
 * The whole-body consolidate contract (evals/consolidation/suite.test.js) makes
 * the caller author the ENTIRE updated snapshot body to add one decision — heavy
 * enough that real sessions skip it and the living decision snapshot stops living
 * (ops field report record 0e439c57). This suite covers the LIGHTER append-mode
 * contract added in #343, alongside — not replacing — the whole-body suite.
 *
 * Adapter-parameterized (mirrors evals/contract-suite/suite.test.js): set
 * KNOWLEDGE_ADAPTER to an adapter module path, or pass --adapter=<path>, to run
 * the contract-relevant cases against a second store implementation. Defaults to
 * the bundled default-store adapter.
 *
 *   AC1 (R1) — append mode: consolidate with only an appended entry + new compiled
 *              ref produces a snapshot whose body contains the prior entries PLUS
 *              the new one, without the caller supplying prior content.
 *   AC3 (R3) — after incremental consolidation the snapshot links every
 *              contributing compiled record (including the new one) with kind
 *              "source", provenance.source_ids is complete, and superseded
 *              predecessors remain queryable (Addendum A.7).
 *   AC4 (R4) — two sequential consolidations from DIFFERENT sessions/agents, each
 *              appending one distinct entry, yield a snapshot containing BOTH
 *              entries — no lost update. Asserted on both adapters.
 *
 * Run (default adapter):
 *   node --test kits/knowledge/evals/consolidate-incremental/suite.test.js
 * Run against the Obsidian adapter (AC4 both-adapters requirement):
 *   KNOWLEDGE_ADAPTER=kits/knowledge/adapters/obsidian-store/index.js \
 *     node --test kits/knowledge/evals/consolidate-incremental/suite.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Adapter resolution (mirrors contract-suite)
// ---------------------------------------------------------------------------

function resolveAdapterPath() {
  const flag = process.argv.find((a) => a.startsWith("--adapter="));
  if (flag) return path.resolve(flag.slice("--adapter=".length));
  if (process.env.KNOWLEDGE_ADAPTER) return path.resolve(process.env.KNOWLEDGE_ADAPTER);
  return path.join(KIT_ROOT, "adapters/default-store/index.js");
}

const adapterPath = resolveAdapterPath();
const adapterModule = await import(adapterPath);
const AdapterClass =
  adapterModule.default || adapterModule.DefaultKnowledgeStore || adapterModule.ObsidianKnowledgeStore;
const ADAPTER_LABEL = path.relative(REPO_ROOT, adapterPath);

const runnerMod = await import(path.join(KIT_ROOT, "adapters/flow-runner/index.js"));
const {
  KnowledgeFlowRunner,
  normalizeConsolidateAppend,
  defaultConsolidateEntryRenderer,
  regenerateSnapshotBodyFromRecords,
} = runnerMod;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-consolidate-incremental-"));
}
function makeStore(dir) {
  return new AdapterClass({ storeRoot: dir });
}
function makeRunner(store, dir, { agent, sessionId } = {}) {
  return new KnowledgeFlowRunner({
    store,
    workspace: dir,
    agent: agent || "incremental-test-runner",
    sessionId: sessionId || "incremental-session-001",
  });
}

async function makeCompiled(store, { title, body, category = "ops.decisions", sources = [] }) {
  return store.create({
    type: "compiled",
    title,
    body,
    category,
    provenance: { agent: "fixture", source_ids: sources },
  });
}

// Resolve the current (non-superseded) snapshot for a topic.
async function currentSnapshot(store, topic) {
  const snaps = await store.listByType("snapshot");
  const matches = snaps.filter((s) => (s.tags || []).includes(`topic:${topic}`));
  const live = matches.find((s) => !(s.mutation_log || []).some((e) => e.op === "superseded-by"));
  return live || matches[matches.length - 1] || null;
}

// ===========================================================================
// Adapter-independent unit tests for the append-mode helpers (run once).
// ===========================================================================

describe("append-mode helpers (unit)", () => {
  test("normalizeConsolidateAppend accepts appendEntryRecordId and appendEntry.recordId", () => {
    assert.deepEqual(normalizeConsolidateAppend({ appendEntryRecordId: "rec-1" }), { recordId: "rec-1" });
    assert.deepEqual(normalizeConsolidateAppend({ appendEntry: { recordId: "rec-2" } }), { recordId: "rec-2" });
    assert.equal(normalizeConsolidateAppend({ proposedBody: "x" }), null);
    assert.equal(normalizeConsolidateAppend({}), null);
    assert.equal(normalizeConsolidateAppend({ appendEntryRecordId: "   " }), null);
  });

  test("defaultConsolidateEntryRenderer renders a decision-log section", () => {
    const out = defaultConsolidateEntryRenderer({ title: "Use Postgres", body: "We adopt Postgres." });
    assert.equal(out, "## Use Postgres\n\nWe adopt Postgres.");
  });

  test("regenerateSnapshotBodyFromRecords joins entries and prepends header", () => {
    const records = [
      { title: "A", body: "alpha" },
      { title: "B", body: "beta" },
    ];
    const body = regenerateSnapshotBodyFromRecords(records, { header: "# Decisions" });
    assert.ok(body.startsWith("# Decisions\n\n"), "header prepended");
    assert.ok(body.includes("## A\n\nalpha"), "first entry rendered");
    assert.ok(body.includes("## B\n\nbeta"), "second entry rendered");
    assert.ok(body.includes("\n\n---\n\n"), "entries separated by a rule");
  });

  test("regenerateSnapshotBodyFromRecords honours a custom entryRenderer", () => {
    const body = regenerateSnapshotBodyFromRecords(
      [{ id: "x", body: "one" }, { id: "y", body: "two" }],
      { entryRenderer: (r) => `- ${r.body}` }
    );
    assert.equal(body, "- one\n\n---\n\n- two");
  });
});

// ===========================================================================
// AC1 (R1) — append mode regenerates prior + new without caller-supplied body.
// ===========================================================================

describe(`[${ADAPTER_LABEL}] AC1 — append mode regenerates body from records + new entry`, () => {
  test("append produces a snapshot containing prior entries plus the new one", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      // Prior contribution already recorded in a live snapshot's provenance.
      const recPrior = await makeCompiled(store, {
        title: "Decision: REST for the public API",
        body: "We will expose the public API over REST.",
      });
      const priorSnapshotId = await store.create({
        type: "snapshot",
        title: "Snapshot: ops.decisions",
        body: defaultConsolidateEntryRenderer(await store.get(recPrior)),
        category: "ops.decisions",
        tags: ["topic:ops.decisions"],
        links: [{ target_id: recPrior, kind: "source" }],
        provenance: { agent: "fixture", source_ids: [recPrior] },
      });

      // New contribution — the ONLY body content the caller supplies is this
      // compiled record; the consolidate call passes no prior text.
      const recNew = await makeCompiled(store, {
        title: "Decision: URL-path versioning",
        body: "API versioning is done via URL path (/v1/, /v2/).",
      });

      const result = await runner.consolidate(
        { topic: "ops.decisions", category: "ops.decisions" },
        {
          appendEntryRecordId: recNew,
          rationale: "Append the versioning decision to the living snapshot.",
          decision: "apply",
        }
      );

      assert.ok(result.newSnapshotId, "AC1: a new snapshot was produced");
      const snap = await store.get(result.newSnapshotId);

      assert.ok(
        snap.body.includes("expose the public API over REST"),
        "AC1: regenerated body contains the PRIOR entry (not supplied by caller)"
      );
      assert.ok(
        snap.body.includes("versioning is done via URL path"),
        "AC1: regenerated body contains the NEW appended entry"
      );

      // The prior snapshot is superseded by the new one.
      assert.notEqual(result.newSnapshotId, priorSnapshotId, "AC1: distinct new snapshot id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append against an empty topic seeds a first snapshot from the new entry", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      const recNew = await makeCompiled(store, {
        title: "Decision: adopt Postgres",
        body: "Postgres is the primary datastore.",
      });

      const result = await runner.consolidate(
        { topic: "ops.data", category: "ops.data" },
        { appendEntryRecordId: recNew, rationale: "First decision.", decision: "apply" }
      );

      const snap = await store.get(result.newSnapshotId);
      assert.ok(snap.body.includes("Postgres is the primary datastore"), "AC1: first entry present");
      assert.deepEqual(snap.provenance.source_ids, [recNew], "AC1: source_ids is exactly the new entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appendEntry: { recordId } shape is accepted", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);
      const rec = await makeCompiled(store, { title: "D1", body: "decision one" });
      const result = await runner.consolidate(
        { topic: "ops.alt", category: "ops.alt" },
        { appendEntry: { recordId: rec }, rationale: "r", decision: "apply" }
      );
      const snap = await store.get(result.newSnapshotId);
      assert.ok(snap.body.includes("decision one"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// AC3 (R3) — provenance + source links complete; superseded predecessors queryable.
// ===========================================================================

describe(`[${ADAPTER_LABEL}] AC3 — provenance/source-link completeness + supersede-not-delete`, () => {
  test("new snapshot links every contributing record incl. the new one; predecessor queryable", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      const recA = await makeCompiled(store, { title: "DA", body: "decision A" });
      const first = await runner.consolidate(
        { topic: "ops.prov", category: "ops.prov" },
        { appendEntryRecordId: recA, rationale: "seed A", decision: "apply" }
      );
      const firstSnapshotId = first.newSnapshotId;

      const recB = await makeCompiled(store, { title: "DB", body: "decision B" });
      const second = await runner.consolidate(
        { topic: "ops.prov", category: "ops.prov" },
        { appendEntryRecordId: recB, rationale: "append B", decision: "apply" }
      );

      const snap = await store.get(second.newSnapshotId);

      // provenance.source_ids complete = both contributing records, incl. new.
      assert.deepEqual(
        [...snap.provenance.source_ids].sort(),
        [recA, recB].sort(),
        "AC3: provenance.source_ids lists every contributing record"
      );

      // source links to both compiled records.
      const { forward } = await store.getLinks(second.newSnapshotId);
      const sourceTargets = forward.filter((l) => l.kind === "source").map((l) => l.target_id).sort();
      assert.deepEqual(sourceTargets, [recA, recB].sort(), "AC3: kind:'source' links to every contributor");

      // Superseded predecessor remains queryable with provenance intact
      // (Addendum A.7). The portable guarantees across adapters are: get(id)
      // returns the full record, and the supersession is discoverable via the
      // reverse "supersedes" link. (The default-store also keeps it in
      // listByType('snapshot'); the Obsidian adapter archives it out of the
      // working set — that listByType behavior is asserted for default-store by
      // evals/consolidation/suite.test.js, so it is not re-asserted here where
      // the adapter is parameterized.)
      const pred = await store.get(firstSnapshotId);
      assert.ok(pred, "AC3: superseded predecessor still returned by get()");
      assert.equal(pred.body, "## DA\n\ndecision A", "AC3: predecessor body intact after supersession");
      const { reverse } = await store.getLinks(firstSnapshotId);
      assert.ok(
        reverse.some((l) => l.source_id === second.newSnapshotId && l.kind === "supersedes"),
        "AC3: predecessor discoverable via reverse 'supersedes' link (A.7)"
      );

      // Every contributing compiled record is still queryable.
      for (const id of [recA, recB]) {
        const rec = await store.get(id);
        assert.equal(rec.type, "compiled", `AC3: contributing record ${id} intact`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append emits gate telemetry at each consolidate gate", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);
      const rec = await makeCompiled(store, { title: "DT", body: "telemetry decision" });
      const result = await runner.consolidate(
        { topic: "ops.tel", category: "ops.tel" },
        { appendEntryRecordId: rec, rationale: "r", decision: "apply" }
      );
      const names = result.telemetryEvents.map((e) => e.tool?.name || "");
      for (const gate of ["related-event-gate", "propose-gate", "evidence-gate", "apply-gate"]) {
        assert.ok(names.some((n) => n.includes(gate)), `AC3: ${gate} telemetry emitted`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// AC4 (R4) — sequential cross-session appends lose no entries. Both adapters.
// ===========================================================================

describe(`[${ADAPTER_LABEL}] AC4 — two sequential cross-session appends, no lost update`, () => {
  test("distinct sessions each append one entry; final snapshot contains both", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);

      // Session 1 appends decision A.
      const runner1 = makeRunner(store, dir, { agent: "agent-session-1", sessionId: "session-1" });
      const recA = await makeCompiled(store, {
        title: "Decision: adopt Postgres",
        body: "Primary datastore is Postgres.",
      });
      await runner1.consolidate(
        { topic: "ops.stack", category: "ops.stack" },
        { appendEntryRecordId: recA, rationale: "Session 1 records the datastore decision.", decision: "apply", session_id: "session-1" }
      );

      // Session 2 (different agent + session) appends decision B. It resolves the
      // CURRENT snapshot (session 1's), so it must NOT lose decision A.
      const runner2 = makeRunner(store, dir, { agent: "agent-session-2", sessionId: "session-2" });
      const recB = await makeCompiled(store, {
        title: "Decision: adopt Redis cache",
        body: "Add Redis as a caching layer.",
      });
      const result2 = await runner2.consolidate(
        { topic: "ops.stack", category: "ops.stack" },
        { appendEntryRecordId: recB, rationale: "Session 2 records the cache decision.", decision: "apply", session_id: "session-2" }
      );

      const live = await currentSnapshot(store, "ops.stack");
      assert.ok(live, "AC4: a live snapshot exists");
      assert.equal(live.id, result2.newSnapshotId, "AC4: session 2's snapshot is the live one");

      assert.ok(
        live.body.includes("Primary datastore is Postgres"),
        "AC4: session 1's entry survives (no lost update)"
      );
      assert.ok(
        live.body.includes("Add Redis as a caching layer"),
        "AC4: session 2's entry is present"
      );

      // Provenance links BOTH contributing records.
      assert.deepEqual(
        [...live.provenance.source_ids].sort(),
        [recA, recB].sort(),
        "AC4: final provenance.source_ids contains both entries"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appending the same entry twice is idempotent (no duplicate source_id)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);
      const rec = await makeCompiled(store, { title: "D", body: "the decision" });

      await runner.consolidate(
        { topic: "ops.idem", category: "ops.idem" },
        { appendEntryRecordId: rec, rationale: "first", decision: "apply" }
      );
      const second = await runner.consolidate(
        { topic: "ops.idem", category: "ops.idem" },
        { appendEntryRecordId: rec, rationale: "again", decision: "apply" }
      );

      const snap = await store.get(second.newSnapshotId);
      assert.deepEqual(snap.provenance.source_ids, [rec], "AC4: no duplicate source_id on re-append");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Back-compat + input validation for append mode.
// ===========================================================================

describe(`[${ADAPTER_LABEL}] append-mode input validation + back-compat`, () => {
  test("proposedBody + append mode are mutually exclusive", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);
      const rec = await makeCompiled(store, { title: "D", body: "d" });
      await assert.rejects(
        () => runner.consolidate(
          { topic: "ops.x", category: "ops.x" },
          { appendEntryRecordId: rec, proposedBody: "full body", rationale: "r", decision: "apply" }
        ),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /mutually exclusive/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append entry must be an existing compiled record", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);

      await assert.rejects(
        () => runner.consolidate(
          { topic: "ops.y", category: "ops.y" },
          { appendEntryRecordId: "does-not-exist", rationale: "r", decision: "apply" }
        ),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /not found/);
          return true;
        }
      );

      const raw = await store.create({
        type: "raw", title: "R", body: "raw", category: "ops.y", provenance: { agent: "t" },
      });
      await assert.rejects(
        () => runner.consolidate(
          { topic: "ops.y", category: "ops.y" },
          { appendEntryRecordId: raw, rationale: "r", decision: "apply" }
        ),
        (err) => {
          assert.equal(err.code, "MISSING_EVIDENCE");
          assert.match(err.message, /expected "compiled"/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("whole-body path still works unchanged (back-compat)", async () => {
    const dir = makeTempDir();
    try {
      const store = makeStore(dir);
      const runner = makeRunner(store, dir);
      await makeCompiled(store, { title: "D", body: "decision body", category: "ops.bc" });
      const result = await runner.consolidate(
        { topic: "ops.bc", category: "ops.bc" },
        { proposedBody: "Whole-body snapshot content.", rationale: "r", decision: "apply" }
      );
      const snap = await store.get(result.newSnapshotId);
      assert.equal(snap.body, "Whole-body snapshot content.", "back-compat: whole body applied verbatim");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
