// Runs the console-relay liveness eval under a recognised test runner, so the suite can be cited
// as tests-evidence. The eval itself is the coverage; this only asserts it exits clean.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("liveness console-relay eval passes", () => {
  const result = spawnSync("bash", ["evals/integration/test_liveness_console_relay.sh"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
