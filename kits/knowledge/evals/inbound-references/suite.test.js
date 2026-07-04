/**
 * Knowledge Kit — Inbound-Reference Integrity Eval Suite  (#340)
 *
 * knowledge.check-inbound-references scans caller-configured doc globs, extracts
 * record citations (full UUID, ≥8-char short-id prefix, slug alias — the #339
 * identity forms), and resolves each against the store. Any unresolvable
 * DEFINITE citation fails the check (fail closed). The scan is READ-ONLY,
 * OPT-IN (zero globs = no-op pass), and adapter-agnostic.
 *
 * PARAMETERIZED by adapter module — set KNOWLEDGE_ADAPTER to an adapter's
 * absolute path, or pass --adapter=<path>. Defaults to the bundled default-store
 * adapter. AC4 runs this file for the default adapter AND the obsidian adapter.
 *
 * Extraction precision (the commit-SHA problem): a bare non-resolving ≥8-hex
 * token is treated as prose / an abbreviated commit SHA and IGNORED, never
 * failed — so the gate produces zero false positives on commit hashes. The
 * documented cost: a *broken* bare-hex short-id (no marker/wikilink) is not
 * caught. Full-UUID and marker/wikilink citations are protected fail-closed.
 *
 * AC map (issue #340):
 *   AC1 — three citation forms extracted + resolved
 *   AC2 — nonexistent id fails closed (names doc + token); no-op pass with no globs
 *   AC3 — read-only invariant (byte-identical store before/after)
 *   AC4 — parameterized across adapters (this file, run per KNOWLEDGE_ADAPTER)
 *   AC5 — result exposes the citation index; contract doc addendum present
 *
 * Run:
 *   node --test kits/knowledge/evals/inbound-references/suite.test.js
 *   KNOWLEDGE_ADAPTER=kits/knowledge/adapters/obsidian-store/index.js \
 *     node --test kits/knowledge/evals/inbound-references/suite.test.js
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
const { KnowledgeFlowRunner, checkInboundReferences } = await import(runnerPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `knowledge-inbound-refs-${tag}-`));
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
    agent: "inbound-refs-test-runner",
    sessionId: "inbound-refs-session-001",
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

// Deterministic, valid-hex UUIDs so short-id prefixes are predictable.
const UUID_A = "aaaaaaaa-1111-4111-8111-111111111111"; // cited by full UUID
const UUID_B = "bbbbbbbb-2222-4222-8222-222222222222"; // cited by 8-char prefix "bbbbbbbb"
const SLUG_C = "decision.strategy/gtm-2026";           // cited by slug alias

async function seedStore(store) {
  await store.create({
    id: UUID_A, type: "compiled", title: "GTM direction",
    body: "Body A", category: "decision.strategy", provenance: { agent: "fixture" },
  });
  await store.create({
    id: UUID_B, type: "compiled", title: "Pricing model",
    body: "Body B", category: "decision.pricing", provenance: { agent: "fixture" },
  });
  await store.create({
    id: "cccccccc-3333-4333-8333-333333333333", type: "concept", title: "North Star",
    body: "Body C", category: "decision.strategy", aliases: [SLUG_C],
    provenance: { agent: "fixture" },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(`Knowledge Kit Inbound-Reference Integrity Suite (#340) [adapter: ${ADAPTER_LABEL}]`, () => {
  let storeDir;
  let workspaceDir;
  let store;
  let runner;

  before(async () => {
    storeDir = makeTempDir("store");
    workspaceDir = makeTempDir("ws");
    store = makeStore(storeDir);
    runner = makeRunner(store, workspaceDir);
    await seedStore(store);
  });

  after(() => {
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("AC1: all three citation forms (full UUID, 8-char prefix, slug) are extracted and resolved", async () => {
    const docsRoot = makeTempDir("ac1-docs");
    try {
      // NOW.md cites A by full UUID (bare) and B by 8-char short-id prefix (bare).
      writeDoc(docsRoot, "NOW.md",
        `# NOW\n\nThe GTM decision ${UUID_A} supersedes the old plan.\n` +
        `Pricing follows short-id bbbbbbbb in the pricing note.\n`);
      // strategy/vision.md cites C by slug alias via a citation marker + a wikilink.
      writeDoc(docsRoot, "strategy/vision.md",
        `# Vision\n\nAnchored on rec:${SLUG_C} and cross-linked as [[${SLUG_C}]].\n`);

      const result = await runner.checkInboundReferences({
        docGlobs: ["NOW.md", "strategy/*.md"],
        docsRoot,
      });

      assert.equal(result.ok, true, "all citations resolve → ok");
      assert.deepEqual(result.unresolved, [], "no unresolved citations");
      assert.deepEqual(result.scanned.sort(), ["NOW.md", "strategy/vision.md"]);

      // Every seeded record is reachable via byRecord (citer enumeration).
      assert.ok(result.byRecord[UUID_A], "record A cited (full UUID form)");
      assert.ok(result.byRecord[UUID_B], "record B cited (8-char prefix form)");
      assert.ok(
        result.byRecord["cccccccc-3333-4333-8333-333333333333"],
        "record C cited (slug alias form)"
      );

      // The three forms are all represented.
      const forms = new Set(result.citations.filter((c) => c.resolved).map((c) => c.form));
      assert.ok(forms.has("uuid"), "uuid form extracted");
      assert.ok(forms.has("bare"), "bare short-id prefix extracted (resolve-gated tier)");
      assert.ok(
        forms.has("marker") || forms.has("wikilink"),
        "slug extracted via marker/wikilink form"
      );

      // The 8-char prefix resolved to the FULL id of record B (#339 prefix path).
      const bareB = result.citations.find((c) => c.form === "bare" && c.token === "bbbbbbbb");
      assert.ok(bareB, "the bbbbbbbb short-id was extracted");
      assert.equal(bareB.recordId, UUID_B, "prefix resolved to record B's full id");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC2: a nonexistent id fails closed, naming the doc path + cited id", async () => {
    const docsRoot = makeTempDir("ac2-docs");
    try {
      const DEAD_UUID = "deadbeef-0000-4000-8000-000000000000";
      writeDoc(docsRoot, "NOW.md",
        `# NOW\n\nThis cites a severed record ${DEAD_UUID} that no longer exists.\n` +
        `And a broken marked short-id rec:99999999 too.\n`);

      const result = await runner.checkInboundReferences({
        docGlobs: ["NOW.md"],
        docsRoot,
      });

      assert.equal(result.ok, false, "an unresolvable definite citation fails closed (not empty success)");
      assert.ok(result.unresolved.length >= 2, "both broken citations reported");

      const deadRow = result.unresolved.find((u) => u.token === DEAD_UUID);
      assert.ok(deadRow, "the severed UUID citation is reported");
      assert.equal(deadRow.doc, "NOW.md", "failure names the doc path");
      assert.equal(deadRow.token, DEAD_UUID, "failure names the unresolved id");
      assert.equal(typeof deadRow.line, "number", "failure names the line");
      assert.equal(deadRow.reason, "not-found");

      const markedRow = result.unresolved.find((u) => u.token === "99999999");
      assert.ok(markedRow, "the marked broken short-id is reported");
      assert.equal(markedRow.form, "marker");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC2: zero configured globs returns a no-op pass (opt-in)", async () => {
    const result = await runner.checkInboundReferences({});
    assert.equal(result.ok, true, "no globs → passing no-op");
    assert.deepEqual(result.scanned, [], "nothing scanned");
    assert.deepEqual(result.citations, [], "no citations");
    assert.deepEqual(result.unresolved, [], "no failures");
  });

  test("commit-SHA safety: a bare non-resolving hex token is ignored, not failed (documented miss)", async () => {
    const docsRoot = makeTempDir("sha-docs");
    try {
      // These look like abbreviated / full commit SHAs. None resolve to a record.
      writeDoc(docsRoot, "NOW.md",
        `# NOW\n\nFixed in a1b2c3d4 and reverted by a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.\n`);

      const result = await runner.checkInboundReferences({
        docGlobs: ["NOW.md"],
        docsRoot,
      });

      assert.equal(result.ok, true, "bare non-resolving hex → no false-positive failure");
      assert.deepEqual(result.unresolved, [], "commit SHAs never fail the gate");
      assert.equal(
        result.citations.filter((c) => c.form === "bare").length,
        0,
        "non-resolving bare hex is not indexed as a citation"
      );
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC3: read-only invariant — the store is byte-identical before and after the check", async () => {
    const docsRoot = makeTempDir("ac3-docs");
    try {
      writeDoc(docsRoot, "NOW.md",
        `# NOW\n\n${UUID_A} and bbbbbbbb and rec:${SLUG_C} and a broken deadbeef-0000-4000-8000-000000000000.\n`);

      const before = snapshotTree(storeDir);
      await runner.checkInboundReferences({ docGlobs: ["NOW.md"], docsRoot });
      const after = snapshotTree(storeDir);

      assert.deepEqual(after, before, "no store file is created, deleted, or mutated by the check");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("AC5: the result exposes the citation index (citations + byDoc + byRecord)", async () => {
    const docsRoot = makeTempDir("ac5-docs");
    try {
      writeDoc(docsRoot, "NOW.md", `# NOW\n\nGTM ${UUID_A}; pricing bbbbbbbb.\n`);
      writeDoc(docsRoot, "strategy/vision.md", `# Vision\n\nrec:${SLUG_C}\n`);

      const result = await runner.checkInboundReferences({
        docGlobs: ["NOW.md", "strategy/*.md"],
        docsRoot,
      });

      // Shape: citations carry doc + line + column + token + form + resolved + recordId.
      for (const c of result.citations) {
        for (const k of ["doc", "line", "column", "token", "form", "resolved", "recordId"]) {
          assert.ok(k in c, `citation entry exposes "${k}"`);
        }
      }
      // byDoc: doc → cited record ids (every scanned doc present).
      assert.ok("NOW.md" in result.byDoc, "byDoc keyed by scanned doc path");
      assert.ok("strategy/vision.md" in result.byDoc);
      // byRecord: record id → citers (downstream supersede/retire propagation).
      const citersOfA = result.byRecord[UUID_A];
      assert.ok(Array.isArray(citersOfA) && citersOfA.length >= 1, "byRecord enumerates citers of A");
      assert.equal(citersOfA[0].doc, "NOW.md", "citer records the citing doc");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("gate telemetry: scan-gate and resolve-gate events are emitted", async () => {
    const docsRoot = makeTempDir("tel-docs");
    try {
      writeDoc(docsRoot, "NOW.md", `# NOW\n\n${UUID_A}\n`);
      const result = await runner.checkInboundReferences({ docGlobs: ["NOW.md"], docsRoot });
      assert.ok(
        result.telemetryEvents.length >= 4,
        "scan-gate + resolve-gate produce at least 4 in/out events"
      );
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  test("module-level checkInboundReferences export delegates to the runner", async () => {
    const docsRoot = makeTempDir("mod-docs");
    try {
      writeDoc(docsRoot, "NOW.md", `# NOW\n\n${UUID_A}\n`);
      const result = await checkInboundReferences({
        store, workspace: workspaceDir, agent: "inbound-refs-test-runner",
        docGlobs: ["NOW.md"], docsRoot,
      });
      assert.equal(result.ok, true);
      assert.ok(result.byRecord[UUID_A], "delegated call resolves the same citation index");
    } finally {
      fs.rmSync(docsRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 (doc claim) — the contract addendum is committed. Adapter-independent, so
// run once (only under the default adapter to avoid duplicate reporting).
// ---------------------------------------------------------------------------

describe("Inbound-Reference Integrity — contract doc addendum (#340)", () => {
  test("AC5: store-contract.md documents the check as an addendum", () => {
    const contract = fs.readFileSync(
      path.join(KIT_ROOT, "docs/store-contract.md"), "utf8"
    );
    assert.match(contract, /## Addendum I —.*Inbound-Reference/i, "Addendum I heading present");
    assert.match(contract, /docGlobs/, "documents the docGlobs option");
    assert.match(contract, /fail closed|fail-closed/i, "documents fail-closed semantics");
    assert.match(contract, /commit SHA|commit hash/i, "documents the commit-SHA false-positive handling");
    assert.match(contract, /byRecord|citation index/i, "documents the citation-index shape");
  });
});
