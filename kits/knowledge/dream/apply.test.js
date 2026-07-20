import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { applyCreateProposals } from "./apply.js";
import { scaffoldStore } from "../adapters/shared/store-resolve.js";
import { stageCreateProposalBatch } from "../promote/store-target.js";

function completeStore(root) { const repo = path.join(root, "store-repo"); fs.mkdirSync(repo, { recursive: true }); return scaffoldStore(repo); }

test("auto applies deterministic create proposals once and pending/dry-run do not mutate", async () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-apply-")); const root = completeStore(fixture);
  try {
    const proposals = [{ schema_version: "1.0", provider: "test", kind: "create-node", target: { root: "personal", path: "proposals/pending/fixture" }, status: "proposed", provenance: { provider: "test", source: "fixture", retrieved_at: "2026-07-20" }, payload: { type: "raw", title: "Memory", body: "Durable fact", category: "memory.test", tags: ["memory"], provenance: { agent: "test", session_id: "fixture", source_ids: ["fixture.jsonl"] } } }];
    assert.equal((await applyCreateProposals({ storeRoot: root, proposals, policy: "pending" })).receipts[0].disposition, "pending");
    assert.deepEqual(fs.readdirSync(path.join(root, "records")).filter((name) => name.endsWith(".md")), []);
    const first = await applyCreateProposals({ storeRoot: root, proposals, policy: "auto" });
    const second = await applyCreateProposals({ storeRoot: root, proposals, policy: "auto" });
    assert.equal(first.receipts[0].disposition, "created");
    assert.equal(second.receipts[0].disposition, "reused");
    assert.equal(fs.readdirSync(path.join(root, "records")).filter((name) => name.endsWith(".md")).length, 1);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("apply refuses malformed/colliding proposals and recovers after a lock is released", async () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-apply-safety-")); const root = completeStore(fixture);
  const make = (body) => ({ schema_version: "1.0", provider: "test", kind: "create-node", target: { root: "personal", path: "proposals/pending/fixture" }, status: "proposed", provenance: { provider: "test", source: "fixture", retrieved_at: "2026-07-20" }, payload: { type: "raw", title: "Collision", body, category: "memory.test", provenance: { agent: "test", session_id: "fixture", source_ids: ["fixture.jsonl"] } } });
  try {
    await assert.rejects(() => applyCreateProposals({ storeRoot: root, proposals: [{ kind: "update-node" }], policy: "auto" }), /invalid/);
    await applyCreateProposals({ storeRoot: root, proposals: [make("first")], policy: "auto" });
    await assert.rejects(() => applyCreateProposals({ storeRoot: root, proposals: [make("changed")], policy: "auto" }), /DREAM_SEMANTIC_COLLISION/);
    const lock = path.join(root, "dream", "locks", "apply.lock"); fs.mkdirSync(lock, { recursive: true });
    await assert.rejects(() => applyCreateProposals({ storeRoot: root, proposals: [make("first")], policy: "auto" }), /DREAM_LOCKED/);
    fs.rmdirSync(lock); const recovered = await applyCreateProposals({ storeRoot: root, proposals: [make("first")], policy: "auto" });
    assert.equal(recovered.receipts[0].disposition, "reused");
    assert.ok(fs.existsSync(path.join(root, "proposals", "applied", `${recovered.receipts[0].proposal_digest}.json`)), "applied receipt is durable");
    const receipt = path.join(root, "proposals", "applied", `${recovered.receipts[0].proposal_digest}.json`); const value = JSON.parse(fs.readFileSync(receipt, "utf8")); value.record_id = "wrong"; fs.writeFileSync(receipt, `${JSON.stringify(value, null, 2)}\n`); fs.chmodSync(receipt, 0o600);
    await assert.rejects(() => applyCreateProposals({ storeRoot: root, proposals: [make("first")], policy: "auto" }), /receipt identity/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("partial create failure recovers through deterministic reuse and reindex", async () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-apply-partial-")); const root = completeStore(fixture);
  const make = (title) => ({ schema_version: "1.0", provider: "test", kind: "create-node", target: { root: "personal", path: "proposals/pending/fixture" }, status: "proposed", provenance: { provider: "test", source: "fixture", retrieved_at: "2026-07-20" }, payload: { type: "raw", title, body: title, category: "memory.test", provenance: { agent: "test", session_id: "fixture", source_ids: ["fixture.jsonl"] } } });
  try {
    const proposals = [make("first"), make("second")]; await assert.rejects(() => applyCreateProposals({ storeRoot: root, proposals, policy: "auto", faultAt: "create:1" }));
    const recovered = await applyCreateProposals({ storeRoot: root, proposals, policy: "auto" });
    assert.deepEqual(recovered.receipts.map((receipt) => receipt.disposition), ["reused", "created"]);
    assert.ok(fs.existsSync(path.join(root, "graph-index.json")), "reindex rebuilds derived graph after recovery");
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("apply refuses incomplete stores without mutation and reports created-before-receipt", async () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-apply-authority-"));
  const proposal = { schema_version: "1.0", provider: "test", kind: "create-node", target: { root: "personal", path: "proposals/pending/fixture" }, status: "proposed", provenance: { provider: "test", source: "fixture", retrieved_at: "2026-07-20" }, payload: { type: "raw", title: "Receipt", body: "body", category: "memory.test", provenance: { agent: "test", session_id: "fixture", source_ids: ["fixture.jsonl"] } } };
  try {
    const missing = path.join(fixture, "missing"); await assert.rejects(() => applyCreateProposals({ storeRoot: missing, proposals: [proposal], policy: "auto" }), /store.*incomplete|store.*valid|scaffold/i); assert.throws(() => stageCreateProposalBatch({ storeRoot: missing, batch: "fixture", proposals: [proposal] }), /store.*incomplete|store.*valid|scaffold/i); assert.equal(fs.existsSync(missing), false);
    const root = completeStore(fixture); let caught; try { await applyCreateProposals({ storeRoot: root, proposals: [proposal], policy: "auto", faultAt: "receipt:0" }); } catch (error) { caught = error; }
    assert.equal(caught?.receipts?.length, 1); assert.equal(caught.receipts[0].disposition, "created"); assert.ok(caught.receipts[0].record_id);
    const retry = await applyCreateProposals({ storeRoot: root, proposals: [proposal], policy: "auto" }); assert.equal(retry.receipts[0].disposition, "reused");
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
