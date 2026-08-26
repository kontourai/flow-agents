import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPreparedNonceRecord, assignmentActorsMatch, canonicalJson, inProjectTransaction, recoverMatchingTransaction, recoverTransaction, restoreTree, sha256, snapshotTree, validateEnvelope } from "../../packaging/lifecycle-authority/coordinator.mjs";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const request = { action: "cancel", project_root: "/srv/project", session_dir: "/srv/project/.kontourai/flow-agents/run-1", authorization_file: "/etc/kontourai/request.json" };
const envelope = { schema_version: "1.0", action: "cancel", request_sha256: sha256(request), request };
test("reference coordinator canonicalization is order-independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.deepEqual(validateEnvelope(envelope), envelope);
});
test("reference coordinator treats only a missing legacy human field as canonical null", () => {
  const canonical = { runtime: "codex", session_id: "session", host: "host", human: null };
  const legacy = { runtime: "codex", session_id: "session", host: "host" };
  const legacyBefore = structuredClone(legacy);
  assert.equal(assignmentActorsMatch(legacy, canonical), true);
  assert.equal(assignmentActorsMatch(canonical, legacy), true);
  for (const changed of [
    { ...canonical, runtime: "other-runtime" },
    { ...canonical, session_id: "other-session" },
    { ...canonical, host: "other-host" },
    { ...canonical, human: "operator" },
    { ...legacy, extra: "unsupported" },
  ]) assert.equal(assignmentActorsMatch(legacy, changed), false);
  assert.deepEqual(legacy, legacyBefore, "semantic comparison must not rewrite a legacy assignment actor");
});
test("reference coordinator rejects unknown fields actions and digest drift", () => {
  assert.throws(() => validateEnvelope({ ...envelope, extra: true }), /unexpected or missing/);
  assert.throws(() => validateEnvelope({ ...envelope, action: "delete" }), /unsupported/);
  assert.throws(() => validateEnvelope({ ...envelope, request_sha256: "0".repeat(64) }), /digest/);
  assert.throws(() => validateEnvelope({ ...envelope, request: { ...request, extra: true } }), /unexpected or missing/);
});
test("reference coordinator pins the published Flow reducer identity rather than local semantics", () => {
  const pin = JSON.parse(fs.readFileSync(new URL("../../packaging/lifecycle-authority/flow-reducer-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(pin, {
    package: "@kontourai/flow",
    package_version: "5.0.0",
    release_commit: "99f139b",
    closure_sha256: "fc514563c79e01ef9087e1e5650c8d10892faa6b5b2fd342a9e5c14d7f838e69",
    reducer: {
      artifact_id: "kontourai.flow.trust-attachment-reducer",
      version: "1.3.7",
      dependency_versions: { hachure: "0.15.0", surface: "2.14.0" },
      dependency_integrities: {
        hachure: { validate: "sha256:596c2a02b6e60e52ad4378a97c40b1d84d217dfc203a7a3beb7cfe732c68951d" },
        surface: {
          validate: "sha256:b92aeb5f9c43d8d1d7fd811184dae6bf3f3fdc1297e833a8a0fb89a0e88d4299",
          buildReport: "sha256:f6171f742231ac4eb9181ac7b5cbbed767802abd609447af465a7c53773e4e36",
          checkAuthorityActive: "sha256:a178202300849b421527fb0972d2fc2b98b0340fb9332578556e206046e49b04",
        },
      },
      hash: "sha256:66979295847695639e21a8d563544c2f03a5107616712ddabab748db0f3ea97d",
    },
  });
});
test("transaction snapshot restores an interrupted unprivileged artifact update", () => {
  const root = makeFixtureDir("lifecycle-transaction-");
  try {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "bundle.json"), "before\n");
    fs.writeFileSync(path.join(root, "nested", "report.md"), "before report\n");
    const before = snapshotTree(root);
    fs.writeFileSync(path.join(root, "bundle.json"), "partial\n");
    fs.writeFileSync(path.join(root, "new.json"), "must disappear\n");
    restoreTree(root, before);
    assert.equal(fs.readFileSync(path.join(root, "bundle.json"), "utf8"), "before\n");
    assert.equal(fs.readFileSync(path.join(root, "nested", "report.md"), "utf8"), "before report\n");
    assert.equal(fs.existsSync(path.join(root, "new.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("transaction snapshots preserve Flow's published lock and pending-ticket namespaces", () => {
  const root = makeFixtureDir("lifecycle-flow-lock-namespace-");
  const pendingName = "..mutation.lock.pending-12345678-1234-4123-8123-123456789abc";
  try {
    fs.mkdirSync(path.join(root, ".mutation.lock"));
    fs.writeFileSync(path.join(root, ".mutation.lock", "owner.json"), "published lock\n");
    fs.mkdirSync(path.join(root, pendingName));
    fs.writeFileSync(path.join(root, pendingName, "owner.json"), "pending ticket\n");
    fs.writeFileSync(path.join(root, "state.json"), "before\n");
    const before = snapshotTree(root, "", [".mutation.lock"]);
    assert.deepEqual(before.map((entry) => entry.path), ["state.json"]);
    fs.writeFileSync(path.join(root, "state.json"), "partial\n");
    restoreTree(root, before, [".mutation.lock"]);
    assert.equal(fs.readFileSync(path.join(root, ".mutation.lock", "owner.json"), "utf8"), "published lock\n");
    assert.equal(fs.readFileSync(path.join(root, pendingName, "owner.json"), "utf8"), "pending ticket\n");
    assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), "before\n");
    assert.throws(
      () => restoreTree(root, [{
        path: "..MUTATION.lock.pending-12345678-1234-4123-8123-123456789abc/owner.json",
        bytes: Buffer.from("alias\n").toString("base64"),
        mode: 0o600,
      }], [".mutation.lock"]),
      /aliases the protected Flow mutation namespace/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("prepared root retry rolls a committed child transaction back to its signed preimage", () => {
  const project = makeFixtureDir("lifecycle-committed-retry-");
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1");
    const flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "before\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "before flow\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowDir);
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "committed child mutation\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "committed flow mutation\n");
    const binding = { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) };
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding, session, flow }));
    assert.equal(recoverMatchingTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, binding), true);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "before\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "before flow\n");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("a committed journal from operation A is inert when ordinary operation B starts", async () => {
  const project = makeFixtureDir("lifecycle-successor-operation-");
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1");
    const flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "after operation A\n");
    fs.writeFileSync(path.join(flowDir, "state.json"), "after operation A flow\n");
    const bindingA = { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) };
    const bindingB = { request_sha256: "c".repeat(64), authorization_sha256: "d".repeat(64) };
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding: bindingA, session: [], flow: [] }));
    await inProjectTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, bindingB, async () => {
      fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "after operation B\n");
      fs.writeFileSync(path.join(flowDir, "state.json"), "after operation B flow\n");
    });
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "after operation B\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "after operation B flow\n");
    const journal = JSON.parse(fs.readFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), "utf8"));
    assert.equal(journal.status, "committed");
    assert.deepEqual(journal.binding, bindingB, "operation B replaces operation A's inert committed journal");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("crash-window recovery authenticates the exact prepared nonce before rolling back the matching commit", () => {
  const project = makeFixtureDir("lifecycle-crash-window-");
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1");
    const flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "signed preimage\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "signed flow preimage\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowDir);
    const binding = { request_sha256: "1".repeat(64), authorization_sha256: "2".repeat(64) };
    const prepared = { schema_version: "1.0", operation_id: "operation-1", authorization_sha256: binding.authorization_sha256, key_id: "operator", nonce: "nonce-1", request_sha256: binding.request_sha256, status: "prepared" };
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "child committed mutation\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "child committed flow mutation\n");
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding, session, flow }));
    assert.throws(() => assertPreparedNonceRecord({ ...prepared, request_sha256: "3".repeat(64) }, prepared), /already been consumed/i);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "child committed mutation\n", "an unauthenticated prepared retry cannot reach rollback");
    assert.deepEqual(assertPreparedNonceRecord(structuredClone(prepared), prepared), prepared);
    assert.equal(recoverMatchingTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, binding), true);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "signed preimage\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "signed flow preimage\n");
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "later operation\n");
    assert.equal(recoverMatchingTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, { request_sha256: "4".repeat(64), authorization_sha256: "5".repeat(64) }), false);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "later operation\n");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("a later prepared operation never rolls back an earlier committed journal", () => {
  const project = makeFixtureDir("lifecycle-distinct-retry-");
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1"), flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "before A\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "before A flow\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowDir), bindingA = { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) };
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "after A\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "after A flow\n");
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding: bindingA, session, flow }));
    const bindingB = { request_sha256: "c".repeat(64), authorization_sha256: "d".repeat(64) };
    assert.throws(() => recoverMatchingTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, bindingB), /another operation/i);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "after A\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "after A flow\n");
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "prepared", binding: bindingA, session, flow }));
    assert.throws(() => recoverMatchingTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, bindingB), /another operation/i);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "after A\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "after A flow\n");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("transaction snapshot rejects symlink swap paths", () => {
  const root = makeFixtureDir("lifecycle-symlink-");
  try {
    fs.symlinkSync("/etc/passwd", path.join(root, "escape"));
    assert.throws(() => snapshotTree(root), /refuses symlinked artifact paths/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("prepared transaction journal deterministically recovers both session and Flow artifacts", () => {
  const project = makeFixtureDir("lifecycle-recovery-");
  const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1");
  const flowRoot = path.join(project, ".kontourai", "flow", "runs", "run-1");
  try {
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "before bundle\n"); fs.writeFileSync(path.join(flowRoot, "state.json"), "before state\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowRoot);
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "partial bundle\n"); fs.writeFileSync(path.join(flowRoot, "state.json"), "partial state\n");
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "prepared", session, flow }));
    recoverTransaction({ projectRoot: project, sessionDir, runId: "run-1" });
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "before bundle\n");
    assert.equal(fs.readFileSync(path.join(flowRoot, "state.json"), "utf8"), "before state\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), "utf8")).status, "rolled_back");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
