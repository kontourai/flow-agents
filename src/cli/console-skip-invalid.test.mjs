// CLI-level tests for issue #918: console-process-projection aborts the whole
// batch when ONE workflow's state.json/handoff.json is malformed. Adds
// --skip-invalid (warn+skip per workflow, exit 0) while preserving the
// existing throw-and-exit-1 default, and makes console-trust-projection --
// whose sibling readWorkflowTrustSources already unconditionally warns+skips
// (#891 finding 2) -- accept the same flag as a documented no-op so the two
// CLIs share one flag surface.
//
// Runs the built CLI as a subprocess (mirrors src/cli/kit-help.test.mjs's
// spawnSync convention) so real process exit codes are exercised, not just
// the underlying src/lib functions (already covered by
// src/cli/console-process-projection.test.mjs and
// src/cli/console-trust-projection.test.mjs).
// Run: `npm run test:unit`, or directly after `npm run build`:
//   node --test src/cli/console-skip-invalid.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = "build/src/cli.js";

// realpathSync resolves the macOS /var -> /private/var symlink so the CLI's
// no-symlink-write guard (ensureNoSymlinkPath) doesn't reject an ordinary tmp
// dir; mirrors src/cli/builder-flow-runtime.test.mjs's convention.
function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function validState(slug) {
  return {
    schema_version: "1.0",
    task_slug: slug,
    status: "in_progress",
    phase: "execution",
    updated_at: "2026-07-20T10:00:00Z",
    next_action: { status: "continue", summary: "keep going" },
  };
}

// workflow-a is valid; workflow-b's state.json carries an unknown legacy
// status value -- the exact "ONE malformed legacy state.json" shape from the
// issue's live repro (station reproduced: 0 vs 57 processes).
function fixtureRoot(t) {
  const root = tempDir("console-skip-invalid-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowA = path.join(root, "workflow-a");
  const workflowB = path.join(root, "workflow-b");
  fs.mkdirSync(workflowA, { recursive: true });
  fs.mkdirSync(workflowB, { recursive: true });
  fs.writeFileSync(path.join(workflowA, "state.json"), `${JSON.stringify(validState("workflow-a"), null, 2)}\n`);
  fs.writeFileSync(path.join(workflowB, "state.json"), `${JSON.stringify({ ...validState("workflow-b"), status: "queued" }, null, 2)}\n`);
  return root;
}

test("console-process-projection: without --skip-invalid, one malformed workflow still aborts the whole run (exit 1, current throw behavior preserved)", (t) => {
  const artifactRoot = fixtureRoot(t);
  const kontourRoot = tempDir("console-skip-invalid-kontour-");
  t.after(() => fs.rmSync(kontourRoot, { recursive: true, force: true }));

  const result = runCli([
    "console-process-projection",
    "--artifact-root", artifactRoot,
    "--kontour-root", kontourRoot,
    "--scope", "fixture-repo",
    "--json",
  ]);

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /console-process-projection:/);
  assert.match(result.stderr, /workflow-b/);
  assert.equal(fs.existsSync(path.join(kontourRoot, "projections")), false, "no projection should be written when the batch throws");
});

test("console-process-projection --skip-invalid: warns and skips the malformed workflow, projects the valid sibling, exit 0", (t) => {
  const artifactRoot = fixtureRoot(t);
  const kontourRoot = tempDir("console-skip-invalid-kontour-");
  t.after(() => fs.rmSync(kontourRoot, { recursive: true, force: true }));

  const result = runCli([
    "console-process-projection",
    "--artifact-root", artifactRoot,
    "--kontour-root", kontourRoot,
    "--scope", "fixture-repo",
    "--skip-invalid",
    "--json",
  ]);

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /warning:.*workflow-b/);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.scanned_state_file_count, 1);
  assert.equal(summary.emitted_process_count, 1);
  assert.ok(summary.warnings.some((warning) => warning.includes("workflow-b")));

  const projection = JSON.parse(fs.readFileSync(path.join(kontourRoot, "projections", "flow-agents-process", "repo-fixture-repo.json"), "utf8"));
  assert.deepEqual(projection.processes.map((entry) => entry.extensions["flow-agents"].task_slug), ["workflow-a"]);
});

test("console-process-projection --help documents --skip-invalid", () => {
  const result = runCli(["console-process-projection", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--skip-invalid/);
});

test("console-trust-projection --help documents --skip-invalid as flag-surface-consistent with console-process-projection", () => {
  const result = runCli(["console-trust-projection", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--skip-invalid/);
});

test("console-trust-projection: accepts --skip-invalid as a documented no-op -- output is identical with or without the flag, because it already unconditionally warns and skips invalid workflows (#891 finding 2)", (t) => {
  const artifactRoot = fixtureRoot(t);
  const kontourRootWithout = tempDir("console-skip-invalid-trust-kontour-");
  const kontourRootWith = tempDir("console-skip-invalid-trust-kontour-");
  t.after(() => {
    fs.rmSync(kontourRootWithout, { recursive: true, force: true });
    fs.rmSync(kontourRootWith, { recursive: true, force: true });
  });

  const without = runCli([
    "console-trust-projection",
    "--artifact-root", artifactRoot,
    "--kontour-root", kontourRootWithout,
    "--scope", "fixture-repo",
    "--generated-at", "2026-07-20T12:00:00Z",
    "--json",
  ]);
  const withFlag = runCli([
    "console-trust-projection",
    "--artifact-root", artifactRoot,
    "--kontour-root", kontourRootWith,
    "--scope", "fixture-repo",
    "--generated-at", "2026-07-20T12:00:00Z",
    "--skip-invalid",
    "--json",
  ]);

  assert.equal(without.status, 0, `expected exit 0, got ${without.status}: ${without.stdout}\n${without.stderr}`);
  assert.equal(withFlag.status, 0, `expected exit 0, got ${withFlag.status}: ${withFlag.stdout}\n${withFlag.stderr}`);
  assert.match(without.stderr, /warning:.*workflow-b/);
  assert.equal(without.stderr, withFlag.stderr);

  const summaryWithout = JSON.parse(without.stdout);
  const summaryWithFlag = JSON.parse(withFlag.stdout);
  assert.deepEqual(
    { ...summaryWithout, destination: null },
    { ...summaryWithFlag, destination: null },
  );
});
