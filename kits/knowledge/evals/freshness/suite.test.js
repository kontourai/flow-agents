/**
 * Knowledge Kit — Record Freshness & Status Suite  (#341, store-contract Addendum J)
 *
 * Record-carried freshness (`expires_at` / `ttl_seconds`) aligned to Kontour's
 * own Hachure trust vocabulary (expiresAt / ttlSeconds; stale / superseded), plus
 * a first-class stale-listing query. "No silent rot" applied to our own store:
 * `stale` and `superseded` are DERIVED — computed on query, never written back.
 *
 * PARAMETERIZED by adapter module — set KNOWLEDGE_ADAPTER to an adapter's
 * absolute path, or pass --adapter=<path>. Defaults to the bundled default-store
 * adapter. Verification runs this file for the default adapter AND the obsidian
 * adapter (KNOWLEDGE_ADAPTER=kits/knowledge/adapters/obsidian-store/index.js).
 *
 * AC map (issue #341):
 *   AC1 (R1) — create/update with expires_at/ttl_seconds round-trips through get
 *   AC2 (R2) — a superseded record (via the supersede op) is queryable as superseded
 *   AC3 (R3) — stale-filtered listing returns exactly the expired records; the
 *              auditFreshness expiry path is exercised here too (its primary case
 *              lives in evals/audit-freshness/suite.test.js)
 *   AC4 (R4) — expiry transitions: past → stale, future → not, inclusive boundary,
 *              no-freshness-fields → never stale; injectable `now` makes it deterministic
 *   AC5 (R5) — backward compat: a record with no freshness fields behaves as before
 *
 * Run:
 *   node --test kits/knowledge/evals/freshness/suite.test.js
 *   KNOWLEDGE_ADAPTER=kits/knowledge/adapters/obsidian-store/index.js \
 *     node --test kits/knowledge/evals/freshness/suite.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(KIT_ROOT, "../..");

// ---------------------------------------------------------------------------
// Adapter resolution — same convention as evals/contract-suite/suite.test.js
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
const { KnowledgeFlowRunner } = await import(runnerPath);
const codecPath = path.join(KIT_ROOT, "adapters/shared/codec.js");
const { isSupersededByLinks } = await import(codecPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-freshness-"));
}
function makeStore(dir) {
  return new AdapterClass({ storeRoot: dir });
}
// Telemetry sink kept separate from the store dir.
function makeRunner(store, workspaceDir) {
  return new KnowledgeFlowRunner({
    store,
    workspace: workspaceDir,
    agent: "freshness-test-runner",
    sessionId: "freshness-session-001",
  });
}

// A fixed reference "now" so expiry math is deterministic regardless of wall clock.
const NOW = "2026-07-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const PAST = "2026-06-01T00:00:00.000Z";   // before NOW → expired
const FUTURE = "2026-08-01T00:00:00.000Z"; // after NOW  → not expired

async function mkRecord(store, over = {}) {
  return store.create({
    type: "raw",
    title: over.title || "Freshness fixture",
    body: over.body || "body",
    category: over.category || "radar.signals",
    provenance: { agent: "fixture" },
    ...over.fields,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(`Knowledge Kit Freshness & Status Suite (#341) [${ADAPTER_LABEL}]`, () => {
  // -----------------------------------------------------------------------
  // AC1 (R1) — round-trip of freshness fields through get
  // -----------------------------------------------------------------------
  describe("AC1: freshness fields round-trip through get", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("create with expires_at AND ttl_seconds round-trips (typed) through get", async () => {
      const id = await store.create({
        type: "raw", title: "Has both", body: "b", category: "radar.signals",
        expires_at: FUTURE, ttl_seconds: 3600,
        provenance: { agent: "fixture" },
      });
      const rec = await store.get(id);
      assert.equal(rec.expires_at, FUTURE, "expires_at round-trips exactly (string)");
      assert.equal(rec.ttl_seconds, 3600, "ttl_seconds round-trips as a NUMBER, not a string");
      assert.equal(typeof rec.ttl_seconds, "number", "ttl_seconds is coerced back to number on read");
    });

    test("create with only ttl_seconds round-trips", async () => {
      const id = await mkRecord(store, { title: "Only ttl", fields: { ttl_seconds: 120 } });
      const rec = await store.get(id);
      assert.equal(rec.ttl_seconds, 120);
      assert.equal(rec.expires_at, undefined, "no expires_at when only ttl supplied");
    });

    test("update can SET expires_at on a record created without one", async () => {
      const id = await mkRecord(store, { title: "Set later" });
      let rec = await store.get(id);
      assert.equal(rec.expires_at, undefined, "starts with no expiry");
      await store.update(id, { expires_at: FUTURE }, { agent: "fixture" });
      rec = await store.get(id);
      assert.equal(rec.expires_at, FUTURE, "update set expires_at");
      // update records the freshness field in its mutation-log evidence.
      const last = rec.mutation_log[rec.mutation_log.length - 1];
      assert.ok(last.evidence.fields.includes("expires_at"), "mutation log cites expires_at");
    });

    test("update can CLEAR expires_at with null", async () => {
      const id = await mkRecord(store, { title: "Clear it", fields: { expires_at: FUTURE } });
      assert.equal((await store.get(id)).expires_at, FUTURE);
      await store.update(id, { expires_at: null }, { agent: "fixture" });
      assert.equal((await store.get(id)).expires_at, undefined, "null clears expires_at");
    });
  });

  // -----------------------------------------------------------------------
  // AC4 (R4) — expiry transitions via the { stale: true } listing filter
  // -----------------------------------------------------------------------
  describe("AC4: expiry transitions (past → stale, future → not, boundary, no-freshness)", () => {
    let dir, store;
    let pastId, futureId, boundaryId, plainId, ttlPastId;
    before(async () => {
      dir = makeTempDir(); store = makeStore(dir);
      pastId = await mkRecord(store, { title: "Past", category: "radar.a", fields: { expires_at: PAST } });
      futureId = await mkRecord(store, { title: "Future", category: "radar.b", fields: { expires_at: FUTURE } });
      boundaryId = await mkRecord(store, { title: "Boundary", category: "radar.c", fields: { expires_at: NOW } });
      plainId = await mkRecord(store, { title: "Plain", category: "radar.d" }); // no freshness
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("past expires_at → listed as stale at now", async () => {
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.ok(stale.some((r) => r.id === pastId), "past-expiry record is stale");
    });

    test("future expires_at → NOT stale at now", async () => {
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.ok(!stale.some((r) => r.id === futureId), "future-expiry record is not stale");
    });

    test("boundary: now === expires_at → stale (inclusive)", async () => {
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.ok(stale.some((r) => r.id === boundaryId), "record expiring exactly at now IS stale");
    });

    test("no freshness fields → never stale (backward compat)", async () => {
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.ok(!stale.some((r) => r.id === plainId), "record with no expiry is never stale");
    });

    test("stale-filtered listing returns EXACTLY the expired records (AC3)", async () => {
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.deepEqual(
        stale.map((r) => r.id).sort(),
        [pastId, boundaryId].sort(),
        "exactly past + boundary records are stale; future + plain are not"
      );
    });

    test("ttl_seconds derives expiry from created_at; boundary inclusive", async () => {
      const id = await mkRecord(store, { title: "Ttl", category: "radar.ttl", fields: { ttl_seconds: 60 } });
      const rec = await store.get(id);
      const expiryMs = Date.parse(rec.created_at) + 60 * 1000;
      // 1ms before expiry → not stale; at expiry → stale (inclusive boundary).
      let stale = await store.listByType("raw", { stale: true, now: expiryMs - 1 });
      assert.ok(!stale.some((r) => r.id === id), "not stale 1ms before ttl expiry");
      stale = await store.listByType("raw", { stale: true, now: expiryMs });
      assert.ok(stale.some((r) => r.id === id), "stale at exactly ttl expiry (inclusive)");
    });

    test("expires_at takes precedence over ttl_seconds", async () => {
      // ttl would expire in 60s (fresh at NOW-ish) but explicit expires_at is in the PAST.
      const id = await mkRecord(store, {
        title: "Precedence", category: "radar.prec",
        fields: { expires_at: PAST, ttl_seconds: 999999 },
      });
      const stale = await store.listByType("raw", { stale: true, now: NOW });
      assert.ok(stale.some((r) => r.id === id), "explicit past expires_at wins over a long ttl");
    });

    test("listByCategory honours the stale filter too", async () => {
      const stale = await store.listByCategory("radar.a", { stale: true, now: NOW });
      assert.deepEqual(stale.map((r) => r.id), [pastId], "category listing returns the stale record");
      const notStale = await store.listByCategory("radar.b", { stale: true, now: NOW });
      assert.equal(notStale.length, 0, "future-expiry category yields no stale records");
    });
  });

  // -----------------------------------------------------------------------
  // AC3 (R3) — auditFreshness flags a record past its OWN expiry, no thresholds
  // -----------------------------------------------------------------------
  describe("AC3: auditFreshness expiry path (no caller thresholds)", () => {
    let dir, store, runner;
    let expiredId;
    before(async () => {
      dir = makeTempDir(); store = makeStore(dir); runner = makeRunner(store, dir);
      expiredId = await mkRecord(store, { title: "Expired", category: "misc.scratch", fields: { expires_at: PAST } });
      await mkRecord(store, { title: "Fresh", category: "misc.scratch", fields: { expires_at: FUTURE } });
      await mkRecord(store, { title: "No expiry", category: "misc.scratch" });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("expired record flagged with NO thresholds, flag cites its own expiry", async () => {
      const result = await runner.auditFreshness({ now: NOW }); // no thresholds at all
      const flag = result.flags.find((f) => f.recordId === expiredId);
      assert.ok(flag, "the past-expiry record is flagged without any caller threshold");
      assert.equal(flag.reason, "expiry", "flag reason is 'expiry'");
      assert.equal(flag.expiresAt, PAST, "flag cites the record's own expiry as the threshold that fired");
      assert.equal(flag.matchedThresholdKey, "expires_at");
      assert.equal(flag.thresholdDays, null, "an expiry flag cites a timestamp, not a day-count");
    });

    test("only the expired record is flagged (fresh + no-expiry are not)", async () => {
      const result = await runner.auditFreshness({ now: NOW });
      assert.deepEqual(result.flags.map((f) => f.recordId), [expiredId]);
    });
  });

  // -----------------------------------------------------------------------
  // AC2 (R2) — a superseded record is queryable as superseded
  // -----------------------------------------------------------------------
  describe("AC2: superseded state is queryable via the supersede relationship", () => {
    let dir, store;
    let oldId, newId;
    before(async () => {
      dir = makeTempDir(); store = makeStore(dir);
      oldId = await mkRecord(store, { title: "Old snapshot", category: "ops.decisions" });
      newId = await mkRecord(store, { title: "New snapshot", category: "ops.decisions" });
      await store.supersede(newId, [oldId], { agent: "fixture", rationale: "Newer decision replaces it." });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("superseded record carries an incoming supersedes edge (getLinks.reverse)", async () => {
      const { reverse } = await store.getLinks(oldId);
      assert.ok(isSupersededByLinks(reverse), "the superseded record is queryable as superseded");
      assert.ok(reverse.some((l) => l.source_id === newId && l.kind === "supersedes"),
        "the reverse edge names the superseding record");
    });

    test("the superseding record is NOT itself superseded", async () => {
      const { reverse } = await store.getLinks(newId);
      assert.equal(isSupersededByLinks(reverse), false, "the new record is not superseded");
    });

    test("superseded record carries a superseded-by mutation-log entry", async () => {
      const rec = await store.get(oldId);
      assert.ok((rec.mutation_log || []).some((e) => e.op === "superseded-by"),
        "superseded-by log entry present (supersede-not-delete)");
    });
  });

  // -----------------------------------------------------------------------
  // Validation — malformed freshness is rejected at the mutation boundary
  // -----------------------------------------------------------------------
  describe("validation: malformed freshness rejected with MISSING_EVIDENCE", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const rejects = (fn, hint) =>
      assert.rejects(fn, (err) => { assert.equal(err.code, "MISSING_EVIDENCE", hint); return true; });

    test("create rejects a non-ISO expires_at", () =>
      rejects(() => store.create({
        type: "raw", title: "Bad", body: "b", category: "radar.signals",
        expires_at: "not-a-date", provenance: { agent: "fixture" },
      }), "non-ISO expires_at"));

    test("create rejects a non-positive ttl_seconds", () =>
      rejects(() => store.create({
        type: "raw", title: "Bad", body: "b", category: "radar.signals",
        ttl_seconds: 0, provenance: { agent: "fixture" },
      }), "zero ttl_seconds"));

    test("update rejects a negative ttl_seconds", async () => {
      const id = await mkRecord(store, { title: "For update" });
      await rejects(() => store.update(id, { ttl_seconds: -5 }, { agent: "fixture" }), "negative ttl_seconds");
    });
  });

  // -----------------------------------------------------------------------
  // AC5 (R5) — records without freshness fields are untouched
  // -----------------------------------------------------------------------
  describe("AC5: backward compatibility", () => {
    let dir, store;
    before(() => { dir = makeTempDir(); store = makeStore(dir); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test("a record with no freshness fields has none after round-trip and is never stale", async () => {
      const id = await mkRecord(store, { title: "Plain old record" });
      const rec = await store.get(id);
      assert.equal(rec.expires_at, undefined);
      assert.equal(rec.ttl_seconds, undefined);
      const stale = await store.listByType("raw", { stale: true, now: "2999-01-01T00:00:00.000Z" });
      assert.equal(stale.length, 0, "no record is stale when none carry freshness fields");
    });

    test("default listing (no stale option) is unaffected by freshness", async () => {
      await mkRecord(store, { title: "Expired but listed", category: "radar.x", fields: { expires_at: PAST } });
      const all = await store.listByType("raw");
      assert.ok(all.length >= 1, "stale records still appear in the default (non-stale-filtered) listing");
    });
  });
});
