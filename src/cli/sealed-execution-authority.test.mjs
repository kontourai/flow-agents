import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { sealedProjection, sealedWorkload } from "../../packaging/lifecycle-authority/coordinator.mjs";

const coordinator = fs.readFileSync(path.resolve("packaging/lifecycle-authority/coordinator.mjs"), "utf8");
const operation = coordinator.slice(coordinator.indexOf("async function processSealedExecution"), coordinator.indexOf("async function processRootOperation"));
const sourceRead = coordinator.slice(coordinator.indexOf("function readSealedSource"), coordinator.indexOf("function stageSealedDirectory"));
const staging = coordinator.slice(coordinator.indexOf("function stageSealedDirectory"), coordinator.indexOf("function sealedArgv"));

test("sealed execution authenticates and validates its capped closure before nonce or stage allocation", () => {
  assert.ok(operation.indexOf("verifyAuthorization(") < operation.indexOf("sealedWorkload("));
  assert.ok(operation.indexOf("sealedWorkload(") < operation.indexOf("atomicWrite(nonceFile"));
  assert.ok(operation.indexOf("atomicWrite(nonceFile") < operation.indexOf("fs.mkdirSync(stage"));
  assert.match(coordinator, /SEALED_EXECUTION_HARD_MAX_STAGE_BYTES = 384 \* 1024 \* 1024/);
  assert.match(coordinator, /expires - issued > 60 \* 60_000/);
});

test("all lifecycle actions acquire the global signing-key nonce lease before their run lease", () => {
  const ordinary = coordinator.slice(coordinator.indexOf("async function processRootOperation"), coordinator.indexOf("function response"));
  assert.ok(ordinary.indexOf("withDurableLock(nonceLockId") < ordinary.indexOf("withDurableLock(runLockId"));
  assert.match(coordinator, /fs\.renameSync\(lock, quarantine\)/, "stale lease recovery atomically claims the observed stale directory before deleting it");
  assert.match(coordinator, /owner\.boot !== processBootIdentity\(\) \|\| processStartIdentity\(owner\.pid\) !== owner\.start/, "stale recovery never uses elapsed time alone");
});

test("sealed execution stages descriptor-read bytes as root-owned group-readable files, never caller-owned files", () => {
  assert.match(sourceRead, /O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
  assert.match(sourceRead, /fs\.fstatSync\(descriptor\)/);
  assert.match(staging, /fs\.chownSync\(target, 0, identity\.gid\)/);
  assert.doesNotMatch(staging, /chownSync\(target, identity\.uid/);
  assert.match(operation, /fs\.chownSync\(stage, 0, caller\.gid\)/);
  assert.match(operation, /stageSealedSource\(stage, "runtime".*0o550/);
  assert.match(operation, /stageSealedSource\(stage, path\.posix\.join\("bundle", workload\.controller\.logical_path\).*0o440/);
  assert.match(operation, /stageSealedSource\(stage, "provider".*0o550/);
});

test("sealed execution launches only the protected runtime/controller/provider closure and erases every stage", () => {
  assert.match(operation, /SEALED_PROVIDER_PATH: provider/);
  assert.match(operation, /SEALED_INVOCATION_MANIFEST: manifest/);
  assert.match(operation, /runSealedStage\(runtime, sealedArgv\(workload\.argv, controller, provider, inputs\)/);
  assert.match(operation, /fs\.rmSync\(stage, \{ recursive: true, force: true, maxRetries: 2 \}\)/);
  assert.match(coordinator, /PATH: "\/usr\/bin:\/bin", LANG: "C", LC_ALL: "C"/);
  assert.match(coordinator, /detached: process\.platform !== "win32"/);
  assert.match(coordinator, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(coordinator, /Object\.keys\(value\.environment\)\.length !== 0/);
  assert.match(coordinator, /kind !== "flow-agents\.sealed-result\.v1"/);
  assert.match(coordinator, /content_base64/);
  assert.match(coordinator, /free-form text/);
});

test("sealed result projection keeps bounded, replayable policy artifacts but rejects raw provider material", () => {
  const content = Buffer.from(JSON.stringify({ calibration: { primary_agreement: 1, policy_digest: "a".repeat(64) } }));
  const artifact = { id: "calibration.policy", sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, media_type: "application/json", content_base64: content.toString("base64") };
  assert.deepEqual(sealedProjection({ schema_version: "1.0", kind: "flow-agents.sealed-result.v1", outcome: "threshold_fail", metrics: { primary_agreement: 1, validated_calls: 32 }, artifacts: [artifact], policy_chain: [{ id: "r4-policy", sha256: "b".repeat(64) }] }).artifacts, [artifact]);
  const forbidden = Buffer.from(JSON.stringify({ innocuous: "do not retain me" }));
  assert.throws(() => sealedProjection({ schema_version: "1.0", kind: "flow-agents.sealed-result.v1", outcome: "invalid", metrics: {}, artifacts: [{ ...artifact, bytes: forbidden.length, sha256: createHash("sha256").update(forbidden).digest("hex"), content_base64: forbidden.toString("base64") }], policy_chain: [] }), /free-form text/);
});

async function sealedCoordinatorFixture({ controllerScript = null, maxRuntimeMs = 5000, maxOutputBytes = 64 * 1024, runtimeBytes = null, instrumentSource = (source) => source } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-exec-coordinator-"));
  const config = path.join(root, "config"); const state = path.join(root, "state"); const execution = path.join(root, "execution");
  fs.mkdirSync(config, { recursive: true });
  for (const directory of [state, execution, path.join(state, "stages"), path.join(state, "nonces"), path.join(state, "completions"), path.join(state, "locks")]) fs.mkdirSync(directory, { recursive: true });
  const fakeDrop = path.join(root, "fake-drop"); fs.writeFileSync(fakeDrop, "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o755 });
  const operator = generateKeyPairSync("ed25519"); const completion = generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(config, "keys.json"), JSON.stringify({ schema_version: "1.0", keys: [{ id: "fixture", algorithm: "ed25519", public_key_pem: operator.publicKey.export({ type: "spki", format: "pem" }) }] }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, "completion-signing-key.pem"), completion.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, "completion-verification-key.pem"), completion.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  let source = fs.readFileSync(path.resolve("packaging/lifecycle-authority/coordinator.mjs"), "utf8");
  source = source.replace(/export const CONFIG_ROOT = .*?;/, `export const CONFIG_ROOT = ${JSON.stringify(config)};`)
    .replace(/export const STATE_ROOT = .*?;/, `export const STATE_ROOT = ${JSON.stringify(state)};`)
    .replace(/export const EXECUTION_ROOT = .*?;/, `export const EXECUTION_ROOT = ${JSON.stringify(execution)};`)
    .replace(/export const PRIVILEGE_DROP_LAUNCHER = .*?;/, `export const PRIVILEGE_DROP_LAUNCHER = ${JSON.stringify(fakeDrop)};`);
  source = instrumentSource(source);
  fs.copyFileSync(path.resolve("packaging/lifecycle-authority/runtime-v1.mjs"), path.join(root, "runtime-v1.mjs"));
  fs.writeFileSync(path.join(root, "coordinator.mjs"), source);
  const coordinatorModule = await import(`${pathToFileURL(path.join(root, "coordinator.mjs")).href}?fixture=${Math.random()}`);
  const write = (name, bytes, mode = 0o600) => { const file = path.join(root, name); fs.writeFileSync(file, bytes, { mode }); return file; };
  const sourceRef = (file, logicalPath = null) => ({ path: file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"), bytes: fs.statSync(file).size, ...(logicalPath === null ? {} : { logical_path: logicalPath }) });
  const projection = { schema_version: "1.0", kind: "flow-agents.sealed-result.v1", outcome: "ok", metrics: { validated_calls: 1 }, artifacts: [], policy_chain: [] };
  const runtime = write("runtime", runtimeBytes ?? fs.readFileSync("/bin/sh"), 0o700);
  const controller = write("controller", controllerScript ?? `printf '%s\\n' '${JSON.stringify(projection)}'\n`);
  const provider = write("provider", "exit 0\n");
  const workload = { schema_version: "1.0", kind: "flow-agents.sealed-workload.v1", runtime: sourceRef(runtime), controller: sourceRef(controller, "entry/controller.mjs"), provider: sourceRef(provider), inputs: [], argv: ["$" + "{SEALED_CONTROLLER}"], environment: {} };
  const workloadFile = write("workload.json", JSON.stringify(workload));
  const signAuthorization = (runId, nonce, time = Date.now(), expiryOffset = 30_000, limits = {}) => {
    const unsigned = { schema_version: "1.0", operation: "execute-sealed-workload", project_root: root, run_id: runId, subject: "fake-only", workload_sha256: createHash("sha256").update(fs.readFileSync(workloadFile)).digest("hex"), runner_kind: "flow-agents.sealed-exec.v1", runner_schema_version: "1.0", runner_entrypoint: "coordinator:sealed-runner-v1", max_staged_bytes: 384 * 1024 * 1024, max_runtime_ms: maxRuntimeMs, max_output_bytes: maxOutputBytes, max_provider_calls: 34, max_cost_microusd: 4_760_000, max_tokens: 748_000, issued_at: new Date(time).toISOString(), expires_at: new Date(time + expiryOffset).toISOString(), nonce, ...limits };
    return { ...unsigned, signature: { algorithm: "ed25519", key_id: "fixture", value: sign(null, Buffer.from(coordinatorModule.canonicalJson(unsigned)), operator.privateKey).toString("base64") } };
  };
  const requestFor = (runId, authorization) => {
    const session = path.join(root, ".kontourai", "flow-agents", runId); fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(path.join(session, "state.json"), JSON.stringify({ work_item_refs: ["fake-only"] }));
    const authorizationFile = write(`auth-${runId}.json`, JSON.stringify(authorization));
    const request = { action: "execute-sealed-workload", project_root: root, session_dir: session, authorization_file: authorizationFile, sealed_workload_file: workloadFile };
    const envelope = { schema_version: "1.0", action: request.action, request_sha256: coordinatorModule.sha256(request), request };
    return { request, envelope, session };
  };
  const invoke = async (runId, authorization) => {
    const { envelope } = requestFor(runId, authorization);
    return coordinatorModule.main(`${JSON.stringify(envelope)}\n`);
  };
  return { root, state, execution, invoke, requestFor, signAuthorization, sourceRef, write, coordinatorModule, workload, workloadFile, runtime, controller, provider };
}

async function withFixtureCaller(callback) {
  const originalChown = fs.chownSync; const oldUid = process.env.SUDO_UID; const oldGid = process.env.SUDO_GID;
  fs.chownSync = () => undefined;
  process.env.SUDO_UID = String(process.getuid()); process.env.SUDO_GID = String(process.getgid());
  try { return await callback(); } finally {
    fs.chownSync = originalChown;
    if (oldUid === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = oldUid;
    if (oldGid === undefined) delete process.env.SUDO_GID; else process.env.SUDO_GID = oldGid;
  }
}

test("fake signed coordinator execution has one global nonce winner and cleans its protected stage", async () => {
  await withFixtureCaller(async () => {
    const fixture = await sealedCoordinatorFixture();
    const first = fixture.signAuthorization("run-a", "shared-fake-nonce");
    const second = fixture.signAuthorization("run-b", "shared-fake-nonce");
    const results = await Promise.allSettled([fixture.invoke("run-a", first), fixture.invoke("run-b", second)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, `one key+nonce may launch exactly one sealed workload: ${results.map((result) => result.status === "rejected" ? result.reason?.message : "accepted").join(" | ")}`);
    assert.deepEqual(fs.readdirSync(path.join(fixture.state, "stages")), [], "all executable and private stage bytes are removed");
  });
});

test("future, expired, inverted, and overlong signed time windows are rejected before any stage or nonce allocation", async () => {
  await withFixtureCaller(async () => {
    const fixture = await sealedCoordinatorFixture();
    const now = Date.now();
    for (const [run, authorization] of [
      ["future-run", fixture.signAuthorization("future-run", "future-nonce", now + 10 * 60_000)],
      ["expired-run", fixture.signAuthorization("expired-run", "expired-nonce", now - 120_000, 30_000)],
      ["inverted-run", fixture.signAuthorization("inverted-run", "inverted-nonce", now, -1)],
      ["overlong-run", fixture.signAuthorization("overlong-run", "overlong-nonce", now, 61 * 60_000)],
      ["identity-run", fixture.signAuthorization("identity-run", "identity-nonce", now, 30_000, { subject: "" })],
    ]) await assert.rejects(fixture.invoke(run, authorization), /(time window is invalid|authorization is expired|identity is invalid)/);
    assert.deepEqual(fs.readdirSync(path.join(fixture.state, "stages")), []);
    assert.deepEqual(fs.readdirSync(path.join(fixture.state, "nonces")), []);
  });
});

test("matching prepared crash recovery is terminal, removes an abandoned stage, and replays without a launch", async () => {
  await withFixtureCaller(async () => {
    const fixture = await sealedCoordinatorFixture();
    const authorization = fixture.signAuthorization("crash-run", "crash-nonce");
    const { envelope } = fixture.requestFor("crash-run", authorization);
    const authorizationSha256 = fixture.coordinatorModule.sha256(fixture.coordinatorModule.canonicalJson(authorization));
    const operationId = fixture.coordinatorModule.sha256({ project: fixture.root, run_id: "crash-run", action: "execute-sealed-workload", key_id: "fixture", nonce: "crash-nonce" });
    const nonceFile = path.join(fixture.state, "nonces", `${fixture.coordinatorModule.sha256("fixture\0crash-nonce")}.json`);
    fs.writeFileSync(nonceFile, `${JSON.stringify({ schema_version: "1.0", operation_id: operationId, authorization_sha256: authorizationSha256, key_id: "fixture", nonce: "crash-nonce", request_sha256: envelope.request_sha256, status: "prepared" })}\n`);
    const abandonedStage = path.join(fixture.execution, operationId); fs.mkdirSync(abandonedStage); fs.writeFileSync(path.join(abandonedStage, "private"), "never launch");
    const first = await fixture.invoke("crash-run", authorization);
    assert.equal(first.result.safe_result.status, "interrupted");
    assert.equal(fs.existsSync(abandonedStage), false, "prepared recovery removes private staging bytes before recording interruption");
    const replay = await fixture.invoke("crash-run", authorization);
    assert.equal(replay.result.operation_status, "replayed");
    assert.deepEqual(replay.result.safe_result, first.result.safe_result, "a prepared crash consumes the nonce once and cannot launch on replay");
  });
});

for (const [label, marker] of [
  ["descriptor", "function readSealedSource(source, label) {\n  const descriptor = fs.openSync(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);"],
  ["staging", "const bytes = readSealedSource(source, label);"],
]) test(`sealed ${label} A-to-B replacement stages protected A, never re-reads B`, async () => {
  await withFixtureCaller(async () => {
    const replacement = "this-is-untrusted-B-and-must-never-execute\n";
    const projection = JSON.stringify({ schema_version: "1.0", kind: "flow-agents.sealed-result.v1", outcome: "ok", metrics: { staged_a: true }, artifacts: [], policy_chain: [] });
    const fixture = await sealedCoordinatorFixture({ runtimeBytes: fs.readFileSync(process.execPath), controllerScript: `process.stdout.write(${JSON.stringify(`${projection}\n`)});`, instrumentSource: (source) => source.replace(marker, `${marker}\n  { const replacement = \`${"${source.path}"}.sealed-test-b\`; fs.writeFileSync(replacement, ${JSON.stringify(replacement)}); fs.renameSync(replacement, source.path); }`) });
    const result = await fixture.invoke(`swap-${label}`, fixture.signAuthorization(`swap-${label}`, `swap-${label}-nonce`));
    assert.equal(result.result.safe_result.status, "ok", "the descriptor-read A closure remains executable after its source pathname changes");
    assert.deepEqual(fs.readdirSync(path.join(fixture.state, "stages")), []);
  });
});

for (const [label, controllerScript, options] of [
  ["malformed result", "process.stdout.write('not-json\\n');", {}],
  ["timeout", "setInterval(() => {}, 1000);", { maxRuntimeMs: 50 }],
  ["output cap", "process.stdout.write('x'.repeat(4096));", { maxOutputBytes: 128 }],
  ["spawn failure", null, { instrumentSource: (source) => source.replace("child = spawn(PRIVILEGE_DROP_LAUNCHER,", "throw new Error(\"fixture spawn failure\"); child = spawn(PRIVILEGE_DROP_LAUNCHER,") }],
]) test(`sealed ${label} writes one terminal receipt, consumes the nonce, and removes staging`, async () => {
  await withFixtureCaller(async () => {
    const fixture = await sealedCoordinatorFixture({ controllerScript, runtimeBytes: fs.readFileSync(process.execPath), ...options });
    const runId = `terminal-${label.replace(/\\W+/g, "-")}`; const authorization = fixture.signAuthorization(runId, `nonce-${label.replace(/\\W+/g, "-")}`);
    const first = await fixture.invoke(runId, authorization);
    assert.match(first.result.safe_result.status, /malformed_result|timeout|output_limit|spawn_error/);
    assert.deepEqual(fs.readdirSync(path.join(fixture.state, "stages")), [], "terminal execution always clears staging");
    const nonce = JSON.parse(fs.readFileSync(path.join(fixture.state, "nonces", `${fixture.coordinatorModule.sha256(`fixture\0${authorization.nonce}`)}.json`), "utf8"));
    assert.equal(nonce.status, "applied");
    const replay = await fixture.invoke(runId, authorization);
    assert.equal(replay.result.operation_status, "replayed");
    assert.deepEqual(replay.result.safe_result, first.result.safe_result, "replay returns the exact bounded terminal receipt");
  });
});

test("sealed timeout kills the detached process group including a provider descendant", async () => {
  await withFixtureCaller(async () => {
    const pidFile = path.join(os.tmpdir(), `sealed-descendant-${process.pid}-${Date.now()}`);
    const cleanupMarker = "      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 2 });";
    const fixture = await sealedCoordinatorFixture({ runtimeBytes: fs.readFileSync(process.execPath), controllerScript: `import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(path.join(path.dirname(process.env.SEALED_INVOCATION_MANIFEST), 'descendant.pid'), String(child.pid)); setInterval(() => {}, 1000);`, maxRuntimeMs: 3_000, instrumentSource: (source) => { const at = source.lastIndexOf(cleanupMarker); assert.notEqual(at, -1); return `${source.slice(0, at)}      { const pid = path.join(stage, "descendant.pid"); if (fs.existsSync(pid)) fs.copyFileSync(pid, ${JSON.stringify(pidFile)}); }\n${source.slice(at)}`; } });
    try {
      const result = await fixture.invoke("group-kill", fixture.signAuthorization("group-kill", "group-kill-nonce"));
      assert.equal(result.result.safe_result.status, "timeout");
      for (let attempt = 0; !fs.existsSync(pidFile) && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const descendant = Number(fs.readFileSync(pidFile, "utf8").trim());
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.throws(() => process.kill(descendant, 0), /ESRCH/, "the detached process group leaves no provider descendant alive");
    } finally { fs.rmSync(pidFile, { force: true }); }
  });
});

test("sealed bundle permits logical ESM relatives and rejects traversal, duplicate paths, and an over-budget closure before staging", async () => {
  await withFixtureCaller(async () => {
    const projection = JSON.stringify({ schema_version: "1.0", kind: "flow-agents.sealed-result.v1", outcome: "ok", metrics: { esm_loaded: true }, artifacts: [], policy_chain: [] });
    const fixture = await sealedCoordinatorFixture({ runtimeBytes: fs.readFileSync(process.execPath), controllerScript: `import { result } from './helper.mjs'; console.log(JSON.stringify(result));` });
    fs.writeFileSync(fixture.controller, `import { result } from './helper.mjs'; console.log(JSON.stringify(result));`);
    const helper = fixture.write("helper", `export const result = ${projection};`);
    fixture.workload.runtime = fixture.sourceRef(fixture.runtime);
    fixture.workload.controller = fixture.sourceRef(fixture.controller, "entry/main.mjs");
    fixture.workload.inputs = [{ id: "helper", source: fixture.sourceRef(helper, "entry/helper.mjs") }];
    fixture.workload.argv = ["${SEALED_CONTROLLER}"].map((value) => value.replace("${SEALED_CONTROLLER}", "$" + "{SEALED_CONTROLLER}"));
    fs.writeFileSync(fixture.workloadFile, JSON.stringify(fixture.workload));
    const accepted = await fixture.invoke("esm-relative", fixture.signAuthorization("esm-relative", "esm-relative-nonce"));
    assert.equal(accepted.result.safe_result.status, "ok", "staged logical module paths preserve relative ESM imports");
    const authorization = { workload_sha256: createHash("sha256").update(Buffer.from(JSON.stringify(fixture.workload))).digest("hex"), max_staged_bytes: 384 * 1024 * 1024 };
    const traversal = structuredClone(fixture.workload); traversal.controller.logical_path = "../escape.mjs";
    assert.throws(() => sealedWorkload(Buffer.from(JSON.stringify(traversal)), { ...authorization, workload_sha256: createHash("sha256").update(Buffer.from(JSON.stringify(traversal))).digest("hex") }), /logical path/);
    const duplicate = structuredClone(fixture.workload); duplicate.inputs[0].source.logical_path = duplicate.controller.logical_path;
    assert.throws(() => sealedWorkload(Buffer.from(JSON.stringify(duplicate)), { ...authorization, workload_sha256: createHash("sha256").update(Buffer.from(JSON.stringify(duplicate))).digest("hex") }), /arguments or environment/);
    const declared = { schema_version: "1.0", kind: "flow-agents.sealed-workload.v1", runtime: { path: "/runtime", sha256: "a".repeat(64), bytes: 1 }, controller: { path: "/controller", sha256: "b".repeat(64), bytes: 1, logical_path: "main.mjs" }, provider: { path: "/provider", sha256: "c".repeat(64), bytes: 1 }, inputs: [{ id: "input", source: { path: "/input", sha256: "d".repeat(64), bytes: 1, logical_path: "input.json" } }], argv: [], environment: {} };
    const declaredBytes = Buffer.from(JSON.stringify(declared));
    const r4Boundary = { workload_sha256: createHash("sha256").update(declaredBytes).digest("hex"), max_staged_bytes: 4, max_provider_calls: 34, max_cost_microusd: 4_760_000, max_tokens: 748_000 };
    assert.equal(sealedWorkload(declaredBytes, r4Boundary).declaredBytes, 4, "the r4 boundary admits exactly its signed closure and 34/$4.76/748k envelope");
    assert.throws(() => sealedWorkload(declaredBytes, { ...r4Boundary, max_staged_bytes: 3 }), /signed staging budget/, "one byte over the signed r4 closure budget rejects before a stage or provider launch");
  });
});
