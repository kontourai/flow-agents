import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { MERGE_CHANGE_USAGE, MERGE_POLICY_PRECONDITION } from "../../build/src/cli/merge-change.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(REPO_ROOT, "build/src/cli.js");

// #1318 FIX-3: the target-branch approval policy was documented nowhere — it was
// reachable only as provider-refusal text AFTER an authorization had been signed.
// It now lives in three places, and this test is the binding that keeps them one
// requirement instead of three drifting paraphrases.
const DOCUMENTED_IN = [
  "docs/public-workflow-cli.md",
  "docs/workflow-usage-guide.md",
];

function runMergeChange(args) {
  return spawnSync(process.execPath, [CLI, "merge-change", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("#1318: merge-change help states the target-branch approval precondition", () => {
  for (const args of [["--help"], ["-h"], ["help"], ["request", "--help"], ["execute", "--help"], ["validate-terminal-delivery", "--help"]]) {
    const result = runMergeChange(args);
    assert.equal(result.status, 0, `merge-change ${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "", `merge-change ${args.join(" ")} must not write help to stderr`);
    assert.ok(result.stdout.includes(MERGE_POLICY_PRECONDITION), `merge-change ${args.join(" ")} must state the precondition verbatim`);
    assert.match(result.stdout, /forbids approving your own pull request/, `merge-change ${args.join(" ")} must state the practical consequence`);
    assert.match(result.stdout, /unverified/, `merge-change ${args.join(" ")} must state that an unreachable provider is reported, not passed`);
  }
});

test("#1318: an unusable merge-change invocation still surfaces the precondition", () => {
  const result = runMergeChange(["not-a-subcommand"]);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(MERGE_POLICY_PRECONDITION));
  assert.equal(result.stdout, "");
});

test("#1318: the rollout documentation carries the same precondition sentence, byte-for-byte", () => {
  for (const file of DOCUMENTED_IN) {
    const contents = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    assert.ok(contents.includes(MERGE_POLICY_PRECONDITION), `${file} must state the merge-change branch-policy precondition verbatim`);
    assert.match(contents, /forbids approving your own pull request/, `${file} must state the practical consequence measured on this repository`);
  }
});

test("#1318: the precondition sentence names the exact provider fields an operator must set", () => {
  for (const field of ["required_pull_request_reviews", "required_approving_review_count >= 1", "enforce_admins"]) {
    assert.ok(MERGE_POLICY_PRECONDITION.includes(field), `the precondition must name ${field}`);
  }
  assert.ok(MERGE_CHANGE_USAGE.includes(MERGE_POLICY_PRECONDITION));
});
