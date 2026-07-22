import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignmentActorsMatch, canonicalJson, recoverTransaction, restoreTree, rollbackCommittedTransaction, sha256, snapshotTree, validateEnvelope } from "../../packaging/lifecycle-authority/coordinator.mjs";

const request = { action: "cancel", project_root: "/srv/project", session_dir: "/srv/project/.kontourai/flow-agents/run-1", authorization_file: "/etc/kontourai/request.json" };
const envelope = { schema_version: "1.0", action: "cancel", request_sha256: sha256(request), request };
test("reference coordinator canonicalization is order-independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.deepEqual(validateEnvelope(envelope), envelope);
});
test("reference coordinator treats only a missing legacy human field as canonical null", () => {
  const canonical = { runtime: "codex", session_id: "session", host: "host", human: null };
  const legacy = { runtime: "codex", session_id: "session", host: "host" };
  assert.equal(assignmentActorsMatch(legacy, canonical), true);
  assert.equal(assignmentActorsMatch(canonical, legacy), true);
  for (const changed of [
    { ...canonical, runtime: "other-runtime" },
    { ...canonical, session_id: "other-session" },
    { ...canonical, host: "other-host" },
    { ...canonical, human: "operator" },
    { ...legacy, extra: "unsupported" },
  ]) assert.equal(assignmentActorsMatch(legacy, changed), false);
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
    package_version: "3.5.0",
    release_commit: "871ed9c",
    closure_sha256: "e2ed60d81adfb57acc2e774a50a9a24d4163327f9ee2d07397d63191826c7562",
    reducer: {
      artifact_id: "kontourai.flow.trust-attachment-reducer",
      version: "1.0.0",
      dependency_versions: { hachure: "0.15.0", surface: "2.12.0" },
      hash: "sha256:389ef9d5d0995adcd74a8d51780b438e43d16a46dfb6d0882aad6010a1a2e0bd",
    },
  });
});
test("transaction snapshot restores an interrupted unprivileged artifact update", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-transaction-"));
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
test("prepared root retry rolls a committed child transaction back to its signed preimage", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-committed-retry-"));
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1");
    const flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "before\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "before flow\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowDir);
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "committed child mutation\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "committed flow mutation\n");
    const binding = { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) };
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding, session, flow }));
    assert.equal(rollbackCommittedTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, binding), true);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "before\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "before flow\n");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("a later prepared operation never rolls back an earlier committed journal", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-distinct-retry-"));
  try {
    const sessionDir = path.join(project, ".kontourai", "flow-agents", "run-1"), flowDir = path.join(project, ".kontourai", "flow", "runs", "run-1");
    fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "before A\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "before A flow\n");
    const session = snapshotTree(sessionDir), flow = snapshotTree(flowDir), bindingA = { request_sha256: "a".repeat(64), authorization_sha256: "b".repeat(64) };
    fs.writeFileSync(path.join(sessionDir, "trust.bundle"), "after A\n"); fs.writeFileSync(path.join(flowDir, "state.json"), "after A flow\n");
    fs.writeFileSync(path.join(sessionDir, ".lifecycle-authority.transaction.json"), JSON.stringify({ status: "committed", binding: bindingA, session, flow }));
    const bindingB = { request_sha256: "c".repeat(64), authorization_sha256: "d".repeat(64) };
    assert.equal(rollbackCommittedTransaction({ projectRoot: project, sessionDir, runId: "run-1" }, bindingB), false);
    assert.equal(fs.readFileSync(path.join(sessionDir, "trust.bundle"), "utf8"), "after A\n");
    assert.equal(fs.readFileSync(path.join(flowDir, "state.json"), "utf8"), "after A flow\n");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test("transaction snapshot rejects symlink swap paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-symlink-"));
  try {
    fs.symlinkSync("/etc/passwd", path.join(root, "escape"));
    assert.throws(() => snapshotTree(root), /refuses symlinked artifact paths/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("prepared transaction journal deterministically recovers both session and Flow artifacts", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-recovery-"));
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
