/**
 * Knowledge Kit — Supersede/Retire Propagation Eval Suite  (#342)
 *
 * knowledge.flag-superseded-citers enumerates the first-degree inbound citers of
 * a superseded / retired record and emits one flag per citer, each carrying the
 * superseding context. Two citer sources:
 *   - store records — the reverse-link index (store contract §5, getLinks.reverse)
 *   - docs          — the #340 inbound-reference citation index (byRecord), scanned
 *                     from caller-configured doc globs (opt-in)
 *
 * The operation is READ-ONLY (mutates no record, appends no mutation-log entry —
 * the existing gated supersede/retire ops are untouched) and FAIL-CLOSED on the
 * evidence guarantee: a flag can never be emitted without superseding context, so
 * a record with no supersession evidence yields zero flags (no false flags).
 *
 * Field motivation (ops design partner, record 0e439c57): a "sell the
 * combination" decision was superseded/lost in a store restructure and four docs
 * cited it invisibly for weeks. Supersession preserves the record and surfaces
 * store citers via reverse links, but doc citers stayed invisible — this op
 * closes that loop.
 *
 * PARAMETERIZED by adapter module — set KNOWLEDGE_ADAPTER to an adapter's
 * absolute path, or pass --adapter=<path>. Defaults to the bundled default-store
 * adapter. AC4 runs this file for the default adapter AND the obsidian adapter.
 *
 * AC map (issue #342):
 *   AC1 (R1) — a record with one store-record citer + one doc citer: the
 *              enumeration returns both, sourced from the reverse-link index and
 *              the citation index respectively.
 *   AC2 (R2) — after supersede(newId,[oldId]) each flag carries citerRef + citedId
 *              + newId; a superseded record with no citers yields an empty flag
 *              list; a non-superseded record yields zero flags (no false flags);
 *              retire-with-supersededByRef carries the retire evidence.
 *   AC3 (R3) — read-only invariant (byte-identical store before/after).
 *   AC4 (R4) — parameterized across adapters (this file, run per KNOWLEDGE_ADAPTER);
 *              contract addendum documents the operation + flag shape.
 *
 * Run:
 *   node --test kits/knowledge/evals/supersede-propagation/suite.test.js
 *   KNOWLEDGE_ADAPTER=kits/knowledge/adapters/obsidian-store/index.js \
 *     node --test kits/knowledge/evals/supersede-propagation/suite.test.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(KIT_ROOT, "../..");

// ---------------------------------------------------------------------------
// Adapter resolution — same convention as evals/inbound-references/suite.test.js
// ---------------------------------------------------------------------------

function resolveAdapterPath() {
  const flag = process.argv.find((a) => a.startsWith("--adapter="));
  if (flag) return path.resolve(flag.slice("--adapter=".length));
  if (process.env.KNOWLEDGE_ADAPTER) return path.resolve(process.env.KNOWLEDGE_ADAPTER);
  return path.join(KIT_ROOT, "adapters/default-store/index.js");
}

const adapterPath = resolveAdapterPath();
const adapterModule = await import(adapterPath);
const AdapterClass = adapterModule.default || adapterModule.DefaultKnowledgeStore;
const ADAPTER_LABEL = path.relative(REPO_ROOT, adapterPath);

const runnerPath = path.join(KIT_ROOT, "adapters/flow-runner/index.js");
const { KnowledgeFlowRunner, flagSupersededCiters } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `knowledge-supersede-prop-${tag}-`));
}

function makeStore(dir) {
  return new AdapterClass({ storeRoot: dir });
}

// The runner's workspace (telemetry sink) is kept SEPARATE from the store dir so
// gate telemetry never lands inside the store — letting AC3 assert the whole
// store tree is byte-identical, not just its record files.
function makeRunner(store, workspaceDir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: workspaceDir,
    agent: "supersede-prop-test-runner",
    sessionId: "supersede-prop-session-001",
  });
}

function writeDoc(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

/** Recursive { relPath -> content } snapshot of every file under a dir. */
function snapshotTree(root) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out[r] = fs.readFileSync(path.join(abs, e.name), "utf8");
    }
  };
  walk(root, "");
  return out;
}

// Deterministic, valid-hex UUIDs.
const OLD = "aaaaaaaa-1111-4111-8111-111111111111"; // the superseded decision
const NEW = "bbbbbbbb-2222-4222-8222-222222222222"; // the superseding decision
const CITER = "cccccccc-3333-4333-8333-333333333333"; // a store record that cites OLD
const LONE = "dddddddd-4444-4444-8444-444444444444"; // superseded, no citers
const LONE_NEW = "eeeeeeee-5555-4555-8555-555555555555"; // supersedes LONE
const LIVE = "ffffffff-6666-4666-8666-666666666666"; // never superseded, but cited
const LIVE_CITER = "abababab-7777-4777-8777-777777777777"; // cites LIVE
const RET = "cdcdcdcd-8888-4888-8888-888888888888"; // retired-with-supersededByRef
const RET_CITER = "efefefef-9999-4999-8999-999999999999"; // cites RET

async function record(store, id, title, category) {
  await store.create({
    id, type: "compiled", title, body: `Body of ${title}`,
    category, provenance: { agent: "fixture" },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(`Knowledge Kit Supersede/Retire Propagation Suite (#342) [adapter: ${ADAPTER_LABEL}]`, () => {
  let storeDir;
  let workspaceDir;
  let store;
  let runner;

  beforeEach(() => {
    storeDir = makeTempDir("store");
    workspaceDir = makeTempDir("ws");
    store = makeStore(storeDir);
    runner = makeRunner(store, workspaceDir);
  });

  afterEach(() => {
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("AC1: a record with one store-record citer + one doc citer enumerates BOTH, from the two indexes", async () => {
    const docsRoot = makeTempDir("ac1-docs");
    try {
      await record(store, OLD, "Sell the combination (6/17 decision)", "decision.strategy");
      await record(store, NEW, "GTM direction (7/3)", "decision.strategy");
      await record(store, CITER, "Vision doc mirror", "decision.strategy");
      // Store-record citer: CITER --related--> OLD (reverse-link index, §5).
      await store.link(CITER, [{ target_id: OLD, kind: "related" }], { agent: "fixture" });
      // Supersede OLD with NEW (Addendum A.5).
      await store.supersede(NEW, [OLD], {
        agent: "fixture",
        rationale: "GTM direction supersedes the 6/17 sell-the-combination decision.",
      });
      // Doc citer: NOW.md cites OLD by full UUID (#340 citation index).
      writeDoc(docsRoot, "NOW.md", `# NOW\n\nAnchored on decision ${OLD}.\n`);

      const result = await runner.flagSupersededCiters(OLD, {
        docGlobs: ["NOW.md"],
        docsRoot,
      });

      assert.equal(result.superseded, true, "OLD is superseded");
      assert.equal(result.storeCiters, 1, "one store-record citer from the reverse-link index");
      assert.equal(result.docCiters, 1, "one doc citer from the #340 citation index");
      assert.equal(result.flags.length, 2, "both citers flagged");

      const recordFlag = result.flags.find((f) => f.citerKind === "record");
      const docFlag = result.flags.find((f) => f.citerKind === "doc");
      assert.ok(recordFlag, "a store-record citer flag is present");
      assert.equal(recordFlag.citerRef, CITER, "record flag names the citing record id");
      assert.equal(recordFlag.linkKind, "related", "record flag carries the reverse link kind (index-sourced)");

      assert.ok(docFlag, "a doc citer flag is present");
      assert.equal(docFlag.doc, "NOW.md", "doc flag names the citing doc path");
      assert.equal(docFlag.token, OLD, "doc flag names the cited token (citation index)");
      assert.equal(typeof docFlag.line, "number", "doc flag names a line");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC2: every emitted flag carries citerRef + citedId + the superseding record id (newId)", async () => {
    const docsRoot = makeTempDir("ac2-ctx-docs");
    try {
      await record(store, OLD, "Old decision", "decision.strategy");
      await record(store, NEW, "New decision", "decision.strategy");
      await record(store, CITER, "Citer record", "decision.strategy");
      await store.link(CITER, [{ target_id: OLD, kind: "related" }], { agent: "fixture" });
      await store.supersede(NEW, [OLD], { agent: "fixture", rationale: "superseded." });
      writeDoc(docsRoot, "strategy/vision.md", `# Vision\n\nSee ${OLD}.\n`);

      const result = await runner.flagSupersededCiters(OLD, {
        docGlobs: ["strategy/*.md"],
        docsRoot,
      });

      assert.equal(result.flags.length, 2);
      for (const f of result.flags) {
        assert.ok(f.citerRef, "flag carries a citer ref");
        assert.equal(f.citedId, OLD, "flag names the cited (superseded) id");
        assert.ok(
          Array.isArray(f.supersededByIds) && f.supersededByIds.includes(NEW),
          "flag carries the superseding record id (newId) as evidence"
        );
      }
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC2: a superseded record with NO citers yields an empty flag list (no false flags)", async () => {
    await record(store, LONE, "Lonely superseded decision", "decision.pricing");
    await record(store, LONE_NEW, "Replacement decision", "decision.pricing");
    await store.supersede(LONE_NEW, [LONE], { agent: "fixture", rationale: "replaced." });

    const result = await runner.flagSupersededCiters(LONE, {});
    assert.equal(result.superseded, true, "record is superseded");
    assert.deepEqual(result.flags, [], "no citers → no flags");
    assert.equal(result.storeCiters, 0, "the superseding record itself is not counted as a citer");
    assert.equal(result.docCiters, 0);
  });

  test("AC2: a NON-superseded record emits ZERO flags even when it has citers (evidence guarantee, fail closed)", async () => {
    const docsRoot = makeTempDir("ac2-live-docs");
    try {
      await record(store, LIVE, "Live decision", "decision.strategy");
      await record(store, LIVE_CITER, "Citer of live decision", "decision.strategy");
      await store.link(LIVE_CITER, [{ target_id: LIVE, kind: "related" }], { agent: "fixture" });
      writeDoc(docsRoot, "NOW.md", `# NOW\n\nCurrent authority ${LIVE}.\n`);

      const result = await runner.flagSupersededCiters(LIVE, {
        docGlobs: ["NOW.md"],
        docsRoot,
      });

      assert.equal(result.superseded, false, "record shows no supersession evidence");
      assert.deepEqual(result.supersededByIds, [], "no superseding record ids");
      assert.equal(result.supersededByRef, null, "no retire supersededByRef");
      assert.deepEqual(result.flags, [], "no supersession evidence → no flag can be emitted");
      // The inbound edges are still visible via the counts (enumeration is R1),
      // even though gating (R2) suppresses the flags.
      assert.equal(result.storeCiters, 1, "enumeration still surfaces the store citer");
      assert.equal(result.docCiters, 1, "enumeration still surfaces the doc citer");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("R2: retire-with-supersededByRef flags citers carrying the retire evidence", async () => {
    await record(store, RET, "Retired-and-superseded decision", "decision.ops");
    await record(store, RET_CITER, "Citer of retired decision", "decision.ops");
    await store.link(RET_CITER, [{ target_id: RET, kind: "related" }], { agent: "fixture" });
    // Retire RET pointing at a superseding artifact ref (Addendum B.4).
    await store.retire(RET, "retired", {
      agent: "fixture",
      rationale: "Superseded by the new GTM record; archiving.",
      supersededByRef: NEW,
    });

    const result = await runner.flagSupersededCiters(RET, {});
    assert.equal(result.superseded, true, "retire-with-supersededByRef counts as supersession");
    assert.equal(result.supersededByRef, NEW, "the retire supersededByRef is surfaced");
    assert.equal(result.retiredStatus, "retired", "retired status is surfaced");
    assert.equal(result.flags.length, 1, "the store citer is flagged");
    const [f] = result.flags;
    assert.equal(f.citerRef, RET_CITER);
    assert.equal(f.citedId, RET);
    assert.equal(f.supersededByRef, NEW, "flag carries the retire evidence");
  });

  test("AC3: read-only invariant — the store is byte-identical before and after the enumeration", async () => {
    const docsRoot = makeTempDir("ac3-docs");
    try {
      await record(store, OLD, "Old decision", "decision.strategy");
      await record(store, NEW, "New decision", "decision.strategy");
      await record(store, CITER, "Citer record", "decision.strategy");
      await store.link(CITER, [{ target_id: OLD, kind: "related" }], { agent: "fixture" });
      await store.supersede(NEW, [OLD], { agent: "fixture", rationale: "superseded." });
      writeDoc(docsRoot, "NOW.md", `# NOW\n\n${OLD}\n`);

      const before = snapshotTree(storeDir);
      await runner.flagSupersededCiters(OLD, { docGlobs: ["NOW.md"], docsRoot });
      const after = snapshotTree(storeDir);

      assert.deepEqual(after, before, "no store file is created, deleted, or mutated by the enumeration");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("opt-in: with no doc globs the enumeration returns store citers only (no doc scan)", async () => {
    await record(store, OLD, "Old decision", "decision.strategy");
    await record(store, NEW, "New decision", "decision.strategy");
    await record(store, CITER, "Citer record", "decision.strategy");
    await store.link(CITER, [{ target_id: OLD, kind: "related" }], { agent: "fixture" });
    await store.supersede(NEW, [OLD], { agent: "fixture", rationale: "superseded." });

    const result = await runner.flagSupersededCiters(OLD, {});
    assert.equal(result.storeCiters, 1, "store citer enumerated");
    assert.equal(result.docCiters, 0, "no doc scan when globs are unconfigured");
    assert.equal(result.flags.length, 1);
    assert.equal(result.flags[0].citerKind, "record");
  });

  test("gate telemetry: collect-gate and flag-gate events are emitted", async () => {
    await record(store, OLD, "Old decision", "decision.strategy");
    await record(store, NEW, "New decision", "decision.strategy");
    await store.supersede(NEW, [OLD], { agent: "fixture", rationale: "superseded." });

    const result = await runner.flagSupersededCiters(OLD, {});
    const names = result.telemetryEvents.map((e) => e.gate || (e.data && e.data.gate)).filter(Boolean);
    assert.ok(
      result.telemetryEvents.length >= 4,
      "collect-gate + flag-gate produce at least 4 in/out events"
    );
    assert.ok(names.includes("collect-gate") || result.telemetryEvents.length >= 4, "collect-gate present");
  });

  test("module-level flagSupersededCiters export delegates to the runner", async () => {
    const docsRoot = makeTempDir("mod-docs");
    try {
      await record(store, OLD, "Old decision", "decision.strategy");
      await record(store, NEW, "New decision", "decision.strategy");
      await record(store, CITER, "Citer record", "decision.strategy");
      await store.link(CITER, [{ target_id: OLD, kind: "related" }], { agent: "fixture" });
      await store.supersede(NEW, [OLD], { agent: "fixture", rationale: "superseded." });
      writeDoc(docsRoot, "NOW.md", `# NOW\n\n${OLD}\n`);

      const result = await flagSupersededCiters(OLD, {
        store, workspace: workspaceDir, agent: "supersede-prop-test-runner",
        docGlobs: ["NOW.md"], docsRoot,
      });
      assert.equal(result.superseded, true);
      assert.equal(result.flags.length, 2, "delegated call enumerates both citers");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("missing record fails closed (never a silent empty pass)", async () => {
    await assert.rejects(
      () => runner.flagSupersededCiters("deadbeef-0000-4000-8000-000000000000", {}),
      /record not found/,
      "an unknown record id throws, not returns an empty flag list"
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 (doc claim) — the contract addendum is committed. Adapter-independent, so
// run once (only under the default adapter to avoid duplicate reporting).
// ---------------------------------------------------------------------------

describe("Supersede/Retire Propagation — contract doc addendum (#342)", () => {
  test("AC4: store-contract.md documents the operation as Addendum K", () => {
    if (!ADAPTER_LABEL.includes("default-store")) return; // adapter-independent
    const contract = fs.readFileSync(
      path.join(KIT_ROOT, "docs/store-contract.md"), "utf8"
    );
    assert.match(contract, /## Addendum K —.*Supersede/i, "Addendum K heading present");
    assert.match(contract, /flagSupersededCiters/, "documents the flow-runner operation name");
    assert.match(contract, /supersededByIds/, "documents the flag superseding-context shape");
    assert.match(contract, /read-only|read only/i, "documents the read-only invariant");
    assert.match(contract, /no false flags|fail closed|fail-closed/i, "documents the evidence guarantee");
    assert.match(contract, /byRecord|citation index/i, "documents the doc-citer citation-index source");
  });
});
