import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_EVIDENCE_REFS,
  MAX_WAVES_BYTES,
  MAX_WORKERS_PER_WAVE,
  WaveCommitUncertainError,
  declareWave,
  reconcileWave,
  recordWaveResult,
  setWorkflowWavesTestHooksForTest,
  waveStepOwnsCanonicalStep,
} from "../../build/src/cli/workflow-waves.js";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(root, "build/src/cli.js");
const validator = path.join(root, "build/src/cli/validate-workflow-artifacts.js");

function fixture(slug = "wave-fixture") {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-waves-"));
  const session = path.join(project, ".kontourai", "flow-agents", slug);
  fs.mkdirSync(path.join(project, ".kontourai", "flow-agents", "assignment"), { recursive: true });
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "state.json"), `${JSON.stringify({ schema_version: "1.0", task_slug: slug })}\n`);
  return { project, session, waves: path.join(session, "waves.json") };
}

function worker(worker_id) { return { worker_id, task: `Implement ${worker_id}.`, role: "tool-worker", owned_files: [`src/${worker_id}.ts`] }; }
const allowAuthority = async () => {};
function bytes(file) { return fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(""); }
function invoke(args, cwd, env = {}) { return execFileSync(process.execPath, [cli, "workflow", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } }); }
function canonicalFixture(slug = "cli-wave-fixture") {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-waves-public-"));
  const artifactRoot = path.join(project, ".kontourai", "flow-agents");
  fs.mkdirSync(artifactRoot, { recursive: true });
  invoke(["start", "--flow", "builder.shape", "--task-slug", slug, "--artifact-root", artifactRoot, "--summary", "Canonical wave writer fixture."], project);
  const session = path.join(artifactRoot, slug);
  const state = JSON.parse(fs.readFileSync(path.join(session, "state.json"), "utf8"));
  return { project, session, waves: path.join(session, "waves.json"), step: state.flow_run.current_step };
}
function spawnCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "workflow", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `CLI exited ${code}`)));
  });
}

test("canonical writer declares, records, reconciles, and stays independently valid", async () => {
  const { project, session, waves } = fixture();
  const report = await declareWave(session, allowAuthority, { wave_id: "execute-1", step: "execute", workers: [worker("one"), worker("two")] });
  assert.deepEqual(report, { action: "wave-declare", wave_id: "execute-1", expected_count: 2 });
  await recordWaveResult(session, allowAuthority, { wave_id: "execute-1", worker_id: "one", status: "completed", summary: "Implemented one." });
  await recordWaveResult(session, allowAuthority, { wave_id: "execute-1", worker_id: "two", status: "failed", summary: "Two failed safely." });
  assert.deepEqual(await reconcileWave(session, allowAuthority, { wave_id: "execute-1" }), { action: "wave-reconcile", wave_id: "execute-1", status: "complete", expected_count: 2, reported_count: 2, not_reported: [] });
  const document = JSON.parse(fs.readFileSync(waves, "utf8"));
  assert.equal(document.waves[0].reconciliation.status, "complete");
  assert.match(document.waves[0].reconciliation.summary, /^2 of 2 reported$/);
  assert.match(document.waves[0].worker_results[0].recorded_at, /^\d{4}-\d\d-\d\dT/);
  execFileSync(process.execPath, [validator, "--skip-markdown-validation", waves], { cwd: project, stdio: "pipe" });
});

test("writer rejects unsupported vocabulary, duplicate/undeclared results, and caller-authored reconciliation without mutation", async () => {
  const { project, session, waves } = fixture();
  await declareWave(session, allowAuthority, { wave_id: "execute-2", step: "execute", workers: [worker("one"), worker("two")] });
  const declared = bytes(waves);
  await assert.rejects(() => recordWaveResult(session, allowAuthority, { wave_id: "execute-2", worker_id: "one", status: "success", summary: "No synonym." }), /completed, failed, or blocked/);
  assert.deepEqual(bytes(waves), declared);
  await assert.rejects(() => recordWaveResult(session, allowAuthority, { wave_id: "execute-2", worker_id: "missing", status: "completed", summary: "Undeclared." }), /not declared/);
  assert.deepEqual(bytes(waves), declared);
  await recordWaveResult(session, allowAuthority, { wave_id: "execute-2", worker_id: "one", status: "completed", summary: "One reported." });
  const afterOne = bytes(waves);
  await assert.rejects(() => recordWaveResult(session, allowAuthority, { wave_id: "execute-2", worker_id: "one", status: "completed", summary: "Duplicate." }), /already has a terminal status/);
  assert.deepEqual(bytes(waves), afterOne);
  const manuallyContradictory = JSON.parse(fs.readFileSync(waves, "utf8"));
  manuallyContradictory.waves[0].reconciliation = { status: "complete", expected_count: 2, reported_count: 2, summary: "Caller-authored contradiction.", reconciled_at: "2026-07-24T00:00:00Z" };
  fs.writeFileSync(waves, `${JSON.stringify(manuallyContradictory)}\n`);
  const corrupt = bytes(waves);
  assert.throws(() => execFileSync(process.execPath, [validator, "--skip-markdown-validation", waves], { cwd: project, stdio: "pipe" }));
  await assert.rejects(() => reconcileWave(session, allowAuthority, { wave_id: "execute-2" }), /waves.json is invalid/);
  assert.deepEqual(bytes(waves), corrupt);
});

test("reconciliation derives not_reported records and its summary from stored results", async () => {
  const { session, waves } = fixture();
  await declareWave(session, allowAuthority, { wave_id: "execute-3", step: "execute", workers: [worker("one"), worker("two")] });
  await recordWaveResult(session, allowAuthority, { wave_id: "execute-3", worker_id: "one", status: "blocked", summary: "Needs operator input." });
  const report = await reconcileWave(session, allowAuthority, { wave_id: "execute-3" });
  assert.deepEqual(report, { action: "wave-reconcile", wave_id: "execute-3", status: "incomplete", expected_count: 2, reported_count: 1, not_reported: ["two"] });
  const wave = JSON.parse(fs.readFileSync(waves, "utf8")).waves[0];
  assert.equal(wave.worker_results.find((result) => result.worker_id === "two").status, "not_reported");
  assert.equal(wave.reconciliation.summary, "1 of 2 reported; two not_reported");
});

test("writer rejects symlinked sessions and preserves the previous file when staging writes fail", async () => {
  const { project, session, waves } = fixture();
  await declareWave(session, allowAuthority, { wave_id: "execute-4", step: "execute", workers: [worker("one")] });
  const before = bytes(waves);
  setWorkflowWavesTestHooksForTest({ write: () => 0 });
  try {
    await assert.rejects(() => recordWaveResult(session, allowAuthority, { wave_id: "execute-4", worker_id: "one", status: "completed", summary: "Should not commit." }), /candidate write made no progress/);
  } finally { setWorkflowWavesTestHooksForTest({}); }
  assert.deepEqual(bytes(waves), before);
  const linked = path.join(project, ".kontourai", "flow-agents", "linked-session");
  fs.symlinkSync(session, linked);
  await assert.rejects(() => declareWave(linked, allowAuthority, { wave_id: "bad", step: "execute", workers: [worker("one")] }), /non-symlink directory/);
});

test("public CLI help, routing, and concurrent results use the canonical writer", async () => {
  const { project, session, waves, step } = canonicalFixture();
  const help = invoke(["--help"], project);
  assert.match(help, /wave-declare/);
  invoke(["wave-declare", "--session-dir", session, "--wave-id", "execute-5", "--step", step, "--worker-json", JSON.stringify(worker("one")), "--worker-json", JSON.stringify(worker("two"))], project);
  await Promise.all([
    spawnCli(["wave-result", "--session-dir", session, "--wave-id", "execute-5", "--worker-id", "one", "--status", "completed", "--summary", "one completed"], project),
    spawnCli(["wave-result", "--session-dir", session, "--wave-id", "execute-5", "--worker-id", "two", "--status", "blocked", "--summary", "two blocked"], project),
  ]);
  invoke(["wave-reconcile", "--session-dir", session, "--wave-id", "execute-5"], project);
  const wave = JSON.parse(fs.readFileSync(waves, "utf8")).waves[0];
  assert.equal(wave.reconciliation.status, "complete");
  assert.equal(wave.worker_results.length, 2);
});

test("public wave mutations require an explicit canonical session, assignment actor, run, and current step", () => {
  const synthetic = fixture("synthetic-wave");
  const before = bytes(synthetic.waves);
  assert.throws(
    () => invoke(["wave-declare", "--artifact-root", path.dirname(synthetic.session), "--wave-id", "bad", "--step", "execute", "--worker-json", JSON.stringify(worker("one"))], synthetic.project),
    /requires an explicit --session-dir/,
  );
  assert.throws(
    () => invoke(["wave-declare", "--session-dir", synthetic.session, "--wave-id", "bad", "--step", "execute", "--worker-json", JSON.stringify(worker("one"))], synthetic.project),
    /assignment|ENOENT/,
  );
  assert.deepEqual(bytes(synthetic.waves), before);

  const canonical = canonicalFixture("authority-wave");
  assert.throws(
    () => invoke(["wave-declare", "--session-dir", canonical.session, "--wave-id", "wrong-actor", "--step", canonical.step, "--worker-json", JSON.stringify(worker("one"))], canonical.project, { FLOW_AGENTS_ACTOR: "intruder-wave-actor" }),
    /active, matching assignment actor/,
  );
  assert.throws(
    () => invoke(["wave-declare", "--session-dir", canonical.session, "--wave-id", "wrong-step", "--step", `${canonical.step}-wrong`, "--worker-json", JSON.stringify(worker("one"))], canonical.project),
    /does not own canonical builder\.shape Flow current_step/,
  );
  assert.equal(fs.existsSync(canonical.waves), false);
});

test("builder.build review waves own only the canonical verify step", async () => {
  const positive = fixture("review-at-verify");
  const authorizeBuilderBuildVerify = async (declaredStep) => {
    if (!waveStepOwnsCanonicalStep("builder.build", "verify", declaredStep)) {
      throw new Error(`declared step ${declaredStep} does not own canonical verify`);
    }
  };
  await declareWave(positive.session, authorizeBuilderBuildVerify, {
    wave_id: "review-wave",
    step: "review",
    workers: [worker("reviewer")],
  });
  assert.equal(JSON.parse(fs.readFileSync(positive.waves, "utf8")).waves[0].step, "review");

  const negative = fixture("review-at-execute");
  const authorizeBuilderBuildExecute = async (declaredStep) => {
    if (!waveStepOwnsCanonicalStep("builder.build", "execute", declaredStep)) {
      throw new Error(`declared step ${declaredStep} does not own canonical execute`);
    }
  };
  await assert.rejects(
    () => declareWave(negative.session, authorizeBuilderBuildExecute, {
      wave_id: "wrong-review-wave",
      step: "review",
      workers: [worker("reviewer")],
    }),
    /does not own canonical execute/,
  );
  assert.equal(fs.existsSync(negative.waves), false);
});

test("writer rejects writable preimages and bounded-resource violations before mutation", async () => {
  for (const [index, [label, selectPath]] of [
    ["project root", ({ project }) => project],
    [".kontourai root", ({ project }) => path.join(project, ".kontourai")],
    ["artifact root", ({ project }) => path.join(project, ".kontourai", "flow-agents")],
    ["assignment directory", ({ project }) => path.join(project, ".kontourai", "flow-agents", "assignment")],
    ["session directory", ({ session }) => session],
  ].entries()) {
    const writableAncestry = fixture(`writable-ancestry-${index}`);
    fs.chmodSync(selectPath(writableAncestry), 0o777);
    await assert.rejects(
      () => declareWave(writableAncestry.session, allowAuthority, { wave_id: "bad", step: "execute", workers: [worker("one")] }),
      new RegExp(`${label.replace(".", "\\.")} must not be group- or world-writable`),
    );
    assert.equal(fs.existsSync(writableAncestry.waves), false);
  }

  const writableState = fixture("writable-state");
  fs.chmodSync(path.join(writableState.session, "state.json"), 0o666);
  await assert.rejects(
    () => declareWave(writableState.session, allowAuthority, { wave_id: "bad", step: "execute", workers: [worker("one")] }),
    /must not be group- or world-writable/,
  );
  assert.equal(fs.existsSync(writableState.waves), false);

  const writableWaves = fixture("writable-waves");
  await declareWave(writableWaves.session, allowAuthority, { wave_id: "bounded", step: "execute", workers: [worker("one")] });
  fs.chmodSync(writableWaves.waves, 0o666);
  const writableBytes = bytes(writableWaves.waves);
  await assert.rejects(
    () => recordWaveResult(writableWaves.session, allowAuthority, { wave_id: "bounded", worker_id: "one", status: "completed", summary: "No laundering." }),
    /must not be group- or world-writable/,
  );
  assert.deepEqual(bytes(writableWaves.waves), writableBytes);

  const bounded = fixture("resource-bounds");
  await assert.rejects(
    () => declareWave(bounded.session, allowAuthority, {
      wave_id: "too-many",
      step: "execute",
      workers: Array.from({ length: MAX_WORKERS_PER_WAVE + 1 }, (_, index) => worker(`worker-${index}`)),
    }),
    new RegExp(`1 through ${MAX_WORKERS_PER_WAVE}`),
  );
  await assert.rejects(
    () => declareWave(bounded.session, allowAuthority, { wave_id: "long", step: "execute", workers: [{ worker_id: "one", task: "x".repeat(16_385) }] }),
    /exceeds 16384 UTF-8 bytes/,
  );
  await declareWave(bounded.session, allowAuthority, { wave_id: "refs", step: "execute", workers: [worker("one")] });
  await assert.rejects(
    () => recordWaveResult(bounded.session, allowAuthority, {
      wave_id: "refs",
      worker_id: "one",
      status: "completed",
      summary: "Too many references.",
      evidence_refs: Array.from({ length: MAX_EVIDENCE_REFS + 1 }, () => ({ kind: "command", summary: "bounded" })),
    }),
    new RegExp(`at most ${MAX_EVIDENCE_REFS}`),
  );

  const oversized = fixture("oversized-waves");
  fs.writeFileSync(oversized.waves, Buffer.alloc(MAX_WAVES_BYTES + 1, 0x20), { mode: 0o600 });
  await assert.rejects(
    () => declareWave(oversized.session, allowAuthority, { wave_id: "bad", step: "execute", workers: [worker("one")] }),
    new RegExp(`exceeds ${MAX_WAVES_BYTES} bytes`),
  );
});

test("post-rename durability failures are commit_uncertain and exact retry recovers", async () => {
  const { session, waves } = fixture("commit-uncertain");
  await declareWave(session, allowAuthority, { wave_id: "commit-wave", step: "execute", workers: [worker("one")] });
  setWorkflowWavesTestHooksForTest({ directoryFsync: () => { throw new Error("injected post-rename durability failure"); } });
  let uncertain;
  try {
    await recordWaveResult(session, allowAuthority, { wave_id: "commit-wave", worker_id: "one", status: "completed", summary: "Committed exactly once." });
  } catch (error) {
    uncertain = error;
  } finally {
    setWorkflowWavesTestHooksForTest({});
  }
  assert.ok(uncertain instanceof WaveCommitUncertainError);
  assert.equal(uncertain.code, "commit_uncertain");
  assert.equal(uncertain.canonical_readback, "matched");
  assert.match(uncertain.candidate_digest, /^[a-f0-9]{64}$/);
  assert.match(uncertain.recovery, /retry the exact same wave command/);
  const retry = await recordWaveResult(session, allowAuthority, { wave_id: "commit-wave", worker_id: "one", status: "completed", summary: "Committed exactly once." });
  assert.equal(retry.recovered, true);
  assert.equal(JSON.parse(fs.readFileSync(waves, "utf8")).waves[0].worker_results.length, 1);
});
