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

  // learning.json satisfies the gate.
  fs.writeFileSync(path.join(dir, "learning.json"), JSON.stringify({ schema_version: "1.0" }));
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

  // With a reason: transition permitted, and the bundle carries the accepted-gap check.
  const skipped = sidecar(root, ["advance-state", rel, "--status", "accepted", "--phase", "learning", "--skip-learning", "fixture: closeout deferred"]);
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
});
