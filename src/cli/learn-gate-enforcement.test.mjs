import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// #793 learn-gate enforcement: stop-gate flagging, advance-state --skip-learning
// accepted-gap, and the ensure-session unbound notice. Tests drive the REAL built
// CLI and the canonical hook module — no mocks of the behavior under test.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "build", "src", "cli", "workflow-sidecar.js");
const require_ = createRequire(import.meta.url);
const hook = require_(path.join(repoRoot, "scripts", "hooks", "stop-goal-fit.js"));

function mkSessionRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-learn-gate-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return root;
}

function sidecar(root, args, opts = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ensureSession(root, slug) {
  const res = sidecar(root, ["ensure-session", "--task-slug", slug]);
  assert.equal(res.code, 0, `ensure-session failed: ${res.stderr}`);
  return { dir: path.join(root, ".kontourai", "flow-agents", slug), res };
}

test("ensure-session prints the unbound-session notice when no flow is bound (#793 item 3)", () => {
  const root = mkSessionRepo();
  const { res } = ensureSession(root, "unbound-notice");
  assert.match(
    res.stderr + res.stdout,
    /no canonical Flow bound — terminal states .* unreachable and the learn-gate is absent/,
    "creation must be loud about the missing learn-gate",
  );
});

test("stop-gate flags parked delivered/release sessions without learning evidence, and only those (#793 item 1)", () => {
  const root = mkSessionRepo();
  const { dir } = ensureSession(root, "parked");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));

  // Parked with no learning evidence: flagged, with an actionable message.
  const warn = hook.learningGateOutstandingWarning(root, dir, { ...state, status: "delivered", phase: "release" });
  assert.ok(warn, "delivered/release with no learning evidence must be flagged");
  assert.match(warn, / learning outstanding — /);
  assert.match(warn, /--skip-learning/);

  // Pre-release phases and healthy learning-phase sessions stay quiet.
  assert.equal(hook.learningGateOutstandingWarning(root, dir, { ...state, status: "in_progress", phase: "execution" }), null);
  assert.equal(hook.learningGateOutstandingWarning(root, dir, { ...state, status: "accepted", phase: "learning" }), null);

  // A bare placeholder learning.json is NOT evidence (Codex finding: existence != learning).
  fs.writeFileSync(path.join(dir, "learning.json"), JSON.stringify({ schema_version: "1.0" }));
  assert.equal(hook.hasLearningEvidence(dir), false, "empty learning.json must not silence the gate");

  // Semantic learning.json (status learned / non-empty records) satisfies it.
  fs.writeFileSync(path.join(dir, "learning.json"), JSON.stringify({ schema_version: "1.0", status: "learned", records: [{ id: "r1", summary: "x" }] }));
  assert.equal(hook.hasLearningEvidence(dir), true);
  assert.equal(hook.learningGateOutstandingWarning(root, dir, { ...state, status: "delivered", phase: "release" }), null);
});

test("advance-state rejects terminal jumps without --skip-learning and records a loud accepted-gap with it (#793 item 2)", () => {
  const root = mkSessionRepo();
  const { dir } = ensureSession(root, "terminal");
  const rel = path.join(".kontourai", "flow-agents", "terminal");

  // Reach the parked state first (allowed today, unchanged).
  const park = sidecar(root, ["advance-state", rel, "--status", "delivered", "--phase", "release"]);
  assert.equal(park.code, 0, `parking transition should succeed: ${park.stderr}`);

  // Without the flag: rejected exactly as before.
  const rejected = sidecar(root, ["advance-state", rel, "--status", "accepted", "--phase", "learning"]);
  assert.notEqual(rejected.code, 0, "terminal jump without learning must still be rejected");
  assert.match(rejected.stderr + rejected.stdout, /terminal_jump_rejected/);

  // Empty reason: refused loudly.
  const empty = sidecar(root, ["advance-state", rel, "--status", "accepted", "--phase", "learning", "--skip-learning", ""]);
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr + empty.stdout, /--skip-learning requires a non-empty reason/);

  // Reason without a named approver: refused (ADR 0020 forcing function).
  const noApprover = sidecar(root, ["advance-state", rel, "--status", "accepted", "--phase", "learning", "--skip-learning", "fixture: closeout deferred"]);
  assert.notEqual(noApprover.code, 0);
  assert.match(noApprover.stderr + noApprover.stdout, /--waived-by/);

  // With a reason and approver: transition permitted, bundle carries the accepted-gap check.
  const skipped = sidecar(root, ["advance-state", rel, "--status", "accepted", "--phase", "learning", "--skip-learning", "fixture: closeout deferred", "--waived-by", "fixture-approver"]);
  assert.equal(skipped.code, 0, `--skip-learning transition should succeed: ${skipped.stderr}`);
  assert.match(skipped.stderr, /recorded an accepted-gap "learning-evidence-skip"/);
  assert.match(skipped.stderr, /NOT a silent skip/);

  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.status, "accepted");

  const bundle = fs.readFileSync(path.join(dir, "trust.bundle"), "utf8");
  assert.match(bundle, /learning-evidence-skip/);
  assert.match(bundle, /fixture: closeout deferred/);
  assert.match(bundle, /not_verified/);

  // And the stop-gate treats the recorded skip as satisfying the learning gate.
  assert.equal(hook.hasLearningEvidence(dir), true);
  assert.equal(hook.learningGateOutstandingWarning(root, dir, state), null);

  // Approver is the named waiver actor, not silently the invoking actor.
  assert.match(fs.readFileSync(path.join(dir, "trust.bundle"), "utf8"), /fixture-approver/);
});

test("review hardening: adversarial claims cannot silence the gate, and the warning never classifies hard (#798 findings)", () => {
  const root = mkSessionRepo();
  const { dir } = ensureSession(root, "hardened");
  const state = { status: "delivered", phase: "release" };
  const bundlePath = path.join(dir, "trust.bundle");
  const claim = (subjectId, status) => JSON.stringify({ schemaVersion: 5, claims: [{ subjectId, status, value: status }] });

  // Codex attack matrix — no non-authoritative id may satisfy the gate:
  fs.writeFileSync(bundlePath, claim("session/no-learning-evidence-recorded-for-this-task", "fail"));
  assert.equal(hook.hasLearningEvidence(dir), false, "failing substring-collision claim must not silence the gate");
  assert.ok(hook.learningGateOutstandingWarning(root, dir, state), "gate stays flagged");

  fs.writeFileSync(bundlePath, claim("session/foo/no-learning-evidence", "pass"));
  assert.equal(hook.hasLearningEvidence(dir), false, "path-segment bypass (Codex) must not silence the gate");

  fs.writeFileSync(bundlePath, claim("session/no-learning-evidence", "pass"));
  assert.equal(hook.hasLearningEvidence(dir), false, "negative-marker id must not silence the gate");

  fs.writeFileSync(bundlePath, claim("totally-my-learning-evidence", "pass"));
  assert.equal(hook.hasLearningEvidence(dir), false, "suffix forgery must not silence the gate — exact producer ids only");

  fs.writeFileSync(bundlePath, claim("policy:learning-evidence", "fail"));
  assert.equal(hook.hasLearningEvidence(dir), false, "failed learning evidence is not learning evidence");

  // Genuine producer ids with non-failing status do satisfy it.
  fs.writeFileSync(bundlePath, claim("policy:learning-evidence", "pass"));
  assert.equal(hook.hasLearningEvidence(dir), true);
  fs.writeFileSync(bundlePath, claim("session/gate-claim-learning-evidence", "pass"));
  assert.equal(hook.hasLearningEvidence(dir), true);

  // The warning text avoids FULL_BLOCK's bare "status:" token and never classifies hard,
  // so the MAX_BLOCKS operator-release valve always applies — with or without an active
  // turn authority (the second MEDIUM finding's exact scenario).
  fs.rmSync(bundlePath);
  const warn = hook.learningGateOutstandingWarning(root, dir, state);
  assert.ok(warn && !/status:/.test(warn), "warning must not contain the FULL_BLOCK token 'status:'");
  assert.equal(hook.isHardStopWarning(warn, path.relative(root, dir), true), false);
  assert.equal(hook.isHardStopWarning(warn, path.relative(root, dir), false), false);
});

test("skip id is reserved and repeated skips preserve waiver history (#798 Codex findings)", async () => {
  // Collision: a genuine check already using the reserved id refuses the skip.
  const rootA = mkSessionRepo();
  ensureSession(rootA, "collide");
  const relA = path.join(".kontourai", "flow-agents", "collide");
  sidecar(rootA, ["record-evidence", relA, "--verdict", "pass", "--check-json", JSON.stringify({ id: "learning-evidence-skip", kind: "external", status: "pass", summary: "genuine check that happens to use the reserved id" })]);
  sidecar(rootA, ["advance-state", relA, "--status", "delivered", "--phase", "release"]);
  const collided = sidecar(rootA, ["advance-state", relA, "--status", "accepted", "--phase", "learning", "--skip-learning", "should refuse", "--waived-by", "a"]);
  assert.notEqual(collided.code, 0, "reserved-id collision must refuse the skip");
  assert.match(collided.stderr + collided.stdout, /reserved id/);
  const bundleA = fs.readFileSync(path.join(rootA, relA, "trust.bundle"), "utf8");
  assert.match(bundleA, /genuine check that happens to use the reserved id/, "genuine check must survive untouched");

  // History: a second skip supersedes the gate-facing check but keeps the first waiver.
  const rootB = mkSessionRepo();
  const { dir: dirB } = ensureSession(rootB, "history");
  const relB = path.join(".kontourai", "flow-agents", "history");
  sidecar(rootB, ["advance-state", relB, "--status", "delivered", "--phase", "release"]);
  assert.equal(sidecar(rootB, ["advance-state", relB, "--status", "accepted", "--phase", "learning", "--skip-learning", "first reason", "--waived-by", "approver-one"]).code, 0);
  const st = JSON.parse(fs.readFileSync(path.join(dirB, "state.json"), "utf8"));
  fs.writeFileSync(path.join(dirB, "state.json"), JSON.stringify({ ...st, status: "delivered", phase: "release" }, null, 2));
  assert.equal(sidecar(rootB, ["advance-state", relB, "--status", "accepted", "--phase", "learning", "--skip-learning", "second reason", "--waived-by", "approver-two"]).code, 0);
  const bundleB = fs.readFileSync(path.join(dirB, "trust.bundle"), "utf8");
  assert.match(bundleB, /first reason/, "prior waiver reason must be preserved in history");
  assert.match(bundleB, /approver-one/, "prior approver must be preserved in history");
  assert.match(bundleB, /second reason/);

  // analyze()-level: the warning reaches the real analysis output for a parked session.
  const rootC = mkSessionRepo();
  ensureSession(rootC, "analyzed");
  const relC = path.join(".kontourai", "flow-agents", "analyzed");
  sidecar(rootC, ["advance-state", relC, "--status", "delivered", "--phase", "release"]);
  const analysis = await hook.analyze(rootC);
  assert.match(JSON.stringify(analysis), /learning outstanding/, "analyze() must surface the warning");
});
