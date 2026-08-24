import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { runObservedCommand } from "../../build/src/lib/observed-command.js";
import {
  observeCoordinatedCommandReceipt,
  resolveCoordinatedCommandBinding,
} from "../../build/src/lib/coordinated-command-receipt.js";
import { isMeaningfulTestCommand, testExecutionProof } from "../../build/src/cli/workflow-sidecar.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

function fixture({ duplicate = false, counts = { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 }, manifest = true } = {}) {
  const root = makeFixtureDir("flow-agents-coordinated-receipt-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  const packageJson = {
    scripts: { "full:regression": "node scripts/receipt-coordinator.mjs request full-regression" },
    ...(manifest ? { "trust-reconcile-manifest": [{ id: "full-regression", command: "npm run full:regression" }] } : {}),
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(root, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(root, "scripts/receipt-coordinator.mjs"), `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const stable = (value) => Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : value && typeof value === "object" ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}" : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const request = { repositoryId: "a".repeat(64), worktree: fs.realpathSync(root), headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workspaceDigest: digest(Buffer.alloc(0)), environmentDigest: "d".repeat(64), laneId: "full-regression", command: "npm run full:regression", manifestDigest: "e".repeat(64), dependencyDigest: "f".repeat(64), nodeVersion: process.version, toolchain: "npm", platform: process.platform, arch: process.arch };
request.key = digest(stable(request));
const receipt = { schemaVersion: 1, request, disposition: "executed", terminal: { status: "completed", exitCode: 0, passed: true }, counts: ${JSON.stringify(counts)}, artifacts: [], cleanup: { status: "passed", survivingOwnedChildren: 0 }, provenance: { stable: true, before: { headSha: request.headSha, workspaceDigest: request.workspaceDigest, environmentDigest: request.environmentDigest, worktree: request.worktree }, after: { headSha: request.headSha, workspaceDigest: request.workspaceDigest, environmentDigest: request.environmentDigest, worktree: request.worktree } } };
const out = path.join(root, ".kontourai", "receipt-records"); fs.mkdirSync(out, { recursive: true });
for (const name of ${JSON.stringify(duplicate ? ["a.json", "b.json"] : ["a.json"] )}) { const file = path.join(out, name); const bytes = Buffer.from(JSON.stringify(receipt)); fs.writeFileSync(file, bytes); fs.writeFileSync(file + ".commit.json", JSON.stringify({ requestKey: request.key, receiptDigest: digest(bytes), committed: true })); }
console.log(JSON.stringify({ disposition: "executed", request: { key: request.key, laneId: request.laneId }, summary: { terminal: receipt.terminal, counts: receipt.counts, cleanup: receipt.cleanup, artifacts: [] } }));
`);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("coordinated receipt evidence is bound by command, manifest, receipt semantics, and committed digest sidecar", async () => {
  const root = fixture();
  const binding = resolveCoordinatedCommandBinding("npm run full:regression", root);
  assert.deepEqual(binding, {
    command: "npm run full:regression",
    lane_id: "full-regression",
    entrypoint: "scripts/receipt-coordinator.mjs",
    argv: ["request", "full-regression"],
  });
  assert.equal(isMeaningfulTestCommand("npm run full:regression", root), true);
  assert.equal(testExecutionProof("npm run full:regression", root)?.kind, "coordinated-command-receipt");
  const result = await runObservedCommand("npm run full:regression", root);
  const observed = observeCoordinatedCommandReceipt(binding, root, result);
  assert.equal(observed.test_count, 1);
  assert.equal(observed.execution_proof.kind, "coordinated-command-receipt");
  assert.match(observed.execution_proof.receipt_sha256, /^[a-f0-9]{64}$/);
});

test("coordinated receipt admission fails closed for absent manifests, zero counts, and ambiguity", async () => {
  const noManifest = fixture({ manifest: false });
  assert.equal(resolveCoordinatedCommandBinding("npm run full:regression", noManifest), null);
  assert.equal(isMeaningfulTestCommand("npm run full:regression", noManifest), false);
  for (const root of [fixture({ counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 } }), fixture({ duplicate: true })]) {
    const binding = resolveCoordinatedCommandBinding("npm run full:regression", root);
    assert.ok(binding);
    const result = await runObservedCommand("npm run full:regression", root);
    assert.throws(() => observeCoordinatedCommandReceipt(binding, root, result), /matching committed receipt/);
  }
});

test("an overwritten coordinator cannot replay an old committed receipt through a PATH-spoofed Git", async () => {
  const root = fixture();
  const binding = resolveCoordinatedCommandBinding("npm run full:regression", root);
  assert.ok(binding);
  const original = await runObservedCommand("npm run full:regression", root);
  assert.doesNotThrow(() => observeCoordinatedCommandReceipt(binding, root, original));
  const summary = original.output.slice(original.output.indexOf("{"));
  fs.writeFileSync(path.join(root, "scripts/receipt-coordinator.mjs"), `console.log(${JSON.stringify(summary.trim())});\n`);
  const shim = makeFixtureDir("flow-agents-fake-git-");
  const invoked = path.join(shim, "invoked");
  const fakeGit = path.join(shim, "git");
  fs.writeFileSync(fakeGit, `#!/bin/sh\ntouch ${JSON.stringify(invoked)}\nprintf 'forged\\n'\n`);
  fs.chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim}${path.delimiter}${previousPath ?? ""}`;
  try {
    const replay = await runObservedCommand("npm run full:regression", root);
    assert.throws(() => observeCoordinatedCommandReceipt(binding, root, replay), /current workspace/);
    assert.equal(fs.existsSync(invoked), false, "workspace binding must never resolve Git through inherited PATH");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
