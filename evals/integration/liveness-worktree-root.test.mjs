// Runs the worktree-root liveness eval under a recognised test runner, so the suite can be cited
// as tests-evidence. The eval itself is the coverage; this only asserts it exits clean.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("liveness worktree-root eval passes", () => {
  const result = spawnSync("bash", ["evals/integration/test_liveness_worktree_root.sh"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
