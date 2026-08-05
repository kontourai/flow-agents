// Unit tests for waves.json wave-manifest reconciliation validation (#663 slice 1).
//
// validate-workflow-artifacts.ts is a CLI script (no exported helpers), so these
// node:test units drive the built validator as a child process against temp fixture
// directories — the same black-box surface CI's workflow-artifact-integration lane
// uses, but fast and countable as unit executions. They pin the load-bearing
// behavior of the reconcile-against-manifest contract:
//   - a reconciled wave with an explicit not_reported worker is VALID DATA
//     ("2 of 3 reported; worker-3 not_reported") — visibility, not a block;
//   - a silent drop (complete claim over a missing worker record) FAILS with
//     messages naming the dropped worker, the count mismatch, and the impossible
//     complete claim.
//
// Run: `node --test src/cli/validate-waves.test.mjs` (requires `npm run build`).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const validator = path.join(repoRoot, "build", "src", "cli", "validate-workflow-artifacts.js");

function runValidator(wavesPayload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waves-unit-"));
  try {
    fs.writeFileSync(path.join(dir, "waves.json"), JSON.stringify(wavesPayload, null, 2));
    const result = spawnSync(process.execPath, [validator, dir], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function manifest(waveOverrides) {
  return {
    schema_version: "1.0",
    task_slug: "waves-unit",
    waves: [
      {
        wave_id: "execute-wave-1",
        step: "execute",
        declared_at: "2026-07-16T00:00:00Z",
        expected_workers: [
          { worker_id: "worker-1", task: "task one" },
          { worker_id: "worker-2", task: "task two" },
          { worker_id: "worker-3", task: "task three" },
        ],
        ...waveOverrides,
      },
    ],
  };
}

test("fully reported wave reconciles complete and validates", () => {
  const { status, output } = runValidator(manifest({
    worker_results: [
      { worker_id: "worker-1", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-2", status: "failed", summary: "tests failing", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-3", status: "blocked", summary: "blocked on approval", recorded_at: "2026-07-16T01:00:00Z" },
    ],
    reconciliation: {
      status: "complete",
      expected_count: 3,
      reported_count: 3,
      summary: "3 of 3 reported; no workers not_reported",
      reconciled_at: "2026-07-16T01:05:00Z",
    },
  }));
  assert.equal(status, 0, output);
});

test("2 of 3 reported with explicit not_reported worker is valid data, not a block", () => {
  const { status, output } = runValidator(manifest({
    worker_results: [
      { worker_id: "worker-1", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-2", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-3", status: "not_reported", summary: "no terminal report by wave close; routed to re-dispatch", recorded_at: "2026-07-16T01:05:00Z" },
    ],
    reconciliation: {
      status: "incomplete",
      expected_count: 3,
      reported_count: 2,
      summary: "2 of 3 reported; worker-3 not_reported",
      reconciled_at: "2026-07-16T01:05:00Z",
    },
  }));
  assert.equal(status, 0, output);
});

test("silent drop behind a complete claim fails naming the missing worker", () => {
  const { status, output } = runValidator(manifest({
    worker_results: [
      { worker_id: "worker-1", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-2", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
    ],
    reconciliation: {
      status: "complete",
      expected_count: 3,
      reported_count: 3,
      summary: "3 of 3 reported",
      reconciled_at: "2026-07-16T01:05:00Z",
    },
  }));
  assert.equal(status, 1);
  assert.match(output, /worker worker-3 has no terminal status record/);
  assert.match(output, /reported_count is 3 but 2 of 3 expected workers/);
  assert.match(output, /complete requires every expected worker/);
});

test("duplicate terminal records and undeclared reporters are rejected", () => {
  const { status, output } = runValidator(manifest({
    worker_results: [
      { worker_id: "worker-1", status: "completed", summary: "done", recorded_at: "2026-07-16T01:00:00Z" },
      { worker_id: "worker-1", status: "failed", summary: "again", recorded_at: "2026-07-16T01:01:00Z" },
      { worker_id: "worker-9", status: "completed", summary: "surprise", recorded_at: "2026-07-16T01:00:00Z" },
    ],
  }));
  assert.equal(status, 1);
  assert.match(output, /more than one terminal status record for worker worker-1/);
  assert.match(output, /worker worker-9 that is not declared in expected_workers/);
});

test("unknown terminal status fails against the schema enum", () => {
  const { status, output } = runValidator(manifest({
    worker_results: [
      { worker_id: "worker-1", status: "maybe-done", summary: "unclear", recorded_at: "2026-07-16T01:00:00Z" },
    ],
  }));
  assert.equal(status, 1);
  assert.match(output, /status must be one of: completed, failed, blocked, not_reported/);
});
