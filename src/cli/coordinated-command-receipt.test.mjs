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

function v3Fixture() {
  const root = fixture();
  fs.writeFileSync(path.join(root, "contract.test.mjs"), 'import test from "node:test"; import assert from "node:assert/strict"; test("actual check", () => assert.equal(2 + 2, 4));\n');
  fs.writeFileSync(path.join(root, "scripts/receipt-coordinator.mjs"), `
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto'; import {execFileSync} from 'node:child_process';
const root=fs.realpathSync(process.cwd());
const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const toolchainIdentity=digest(process.execPath+process.version);
const request={repositoryId:digest(root),worktree:root,headSha:execFileSync(process.platform==='win32'?'git':'/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workspaceDigest:digest(Buffer.alloc(0)),environmentDigest:digest(process.env.RECEIPT_TEST_ENV??''),laneId:'full-regression',command:'npm run full:regression',manifestDigest:digest(fs.readFileSync(path.join(root,'package.json'))),dependencyDigest:digest('locked fixture'),nodeVersion:process.version,toolchain:'npm',toolchainIdentity,platform:process.platform,arch:process.arch};
request.key=digest(stable(request));
const file=path.join(root,'.kontourai/verification-receipts',request.key+'.canonical.json');
if(process.argv[2]==='explain'){console.log(JSON.stringify({request,canonicalReceipt:file}));process.exit(0);}
let receipt,disposition;
if(fs.existsSync(file)){receipt=JSON.parse(fs.readFileSync(file));disposition='reused';}
else{
 const output=execFileSync(process.execPath,['--test','contract.test.mjs'],{encoding:'utf8'});
 const passed=Number(output.match(/(?:#|ℹ)\\s*pass\\s+(\\d+)/)?.[1]??0);
 if(passed<1)throw new Error('no real test ran');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const counter=path.join(root,'.kontourai/executions');fs.writeFileSync(counter,String(Number(fs.existsSync(counter)?fs.readFileSync(counter):0)+1));
 const provenance={...request,toolchainIdentity:{digest:toolchainIdentity}};
 receipt={schemaVersion:3,request,disposition:'executed',terminal:{status:'completed',exitCode:0,passed:true},counts:{executed:passed,passed,failed:0,infrastructureErrors:0},artifacts:[],cleanup:{status:'passed',survivingOwnedChildren:0},provenance:{stable:true,before:provenance,after:provenance}};
 const bytes=JSON.stringify(receipt);fs.writeFileSync(file,bytes);fs.writeFileSync(file+'.commit.json',JSON.stringify({requestKey:request.key,receiptDigest:digest(bytes),committed:true}));disposition='executed';
}
console.log(JSON.stringify({disposition,request:{key:request.key,laneId:request.laneId},summary:{terminal:disposition==='executed'?'completed':receipt.terminal,passed:true,counts:receipt.counts,cleanup:receipt.cleanup}}));
`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "v3 real producer"], { cwd: root });
  return root;
}

test("v3 exact current coordinator receipts reuse real execution without rerunning the underlying test", async () => {
  const root = v3Fixture();
  const binding = resolveCoordinatedCommandBinding("npm run full:regression", root);
  for (let index = 0; index < 2; index++) {
    const result = await runObservedCommand(binding.command, root);
    const admitted = observeCoordinatedCommandReceipt(binding, root, result);
    assert.equal(admitted.test_count, 1);
    assert.equal(fs.readFileSync(path.join(root, ".kontourai/executions"), "utf8"), "1");
  }
});

test("v3 receipt admission rejects current environment drift, corrupted commit bytes and failed counts", async () => {
  const root = v3Fixture();
  const binding = resolveCoordinatedCommandBinding("npm run full:regression", root);
  const result = await runObservedCommand(binding.command, root);
  assert.throws(() => observeCoordinatedCommandReceipt(binding, root, { ...result, timed_out: true }), /execution deadline/);
  assert.throws(() => observeCoordinatedCommandReceipt(binding, root, { ...result, command: "echo forged" }), /observed command/);
  const summary = JSON.parse(result.stdout_tail.slice(result.stdout_tail.indexOf("{")));
  const file = path.join(root, ".kontourai/verification-receipts", `${summary.request.key}.canonical.json`);
  const prior = process.env.RECEIPT_TEST_ENV;
  process.env.RECEIPT_TEST_ENV = "different current input";
  try { assert.throws(() => observeCoordinatedCommandReceipt(binding, root, result), /exact current producer inputs/); }
  finally { if (prior === undefined) delete process.env.RECEIPT_TEST_ENV; else process.env.RECEIPT_TEST_ENV = prior; }
  const original = fs.readFileSync(file);
  const receipt = JSON.parse(original);
  receipt.counts.failed = 1;
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => observeCoordinatedCommandReceipt(binding, root, result), /successful execution/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.commit.json`, JSON.stringify({requestKey:summary.request.key,receiptDigest:"0".repeat(64),committed:true}));
  assert.throws(() => observeCoordinatedCommandReceipt(binding, root, result), /committed digest/);
});

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
