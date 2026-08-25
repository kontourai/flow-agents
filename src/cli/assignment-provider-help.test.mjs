import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Mirrors src/cli/kit-help.test.mjs. Issue #1195: `<command> --help` must print
// full usage and exit 0 regardless of required-arg validation, because
// requireFlag (assignment-provider.ts) throws "--X is required" before any help
// check. The canonical model is kit.ts (hasHelp before dispatch + USAGE map).

const CLI = "build/src/cli.js";

function runAssignmentProvider(args) {
  return spawnSync(process.execPath, [CLI, "assignment-provider", ...args], { encoding: "utf8" });
}

// Each subcommand prints its own full-usage line (ASSIGNMENT_USAGE map) and must
// NOT surface "--X is required" when --help/-h is present.
const SUBCOMMANDS = [
  "claim",
  "release",
  "supersede",
  "render-claim",
  "render-release",
  "render-supersede",
  "status",
  "list",
];

test("assignment-provider subcommand --help prints full usage, exits 0, and never prints 'is required'", () => {
  for (const command of SUBCOMMANDS) {
    for (const help of ["--help", "-h"]) {
      const result = runAssignmentProvider([command, help]);
      assert.equal(result.status, 0, `${command} ${help}: exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`usage: flow-agents assignment-provider ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
      assert.doesNotMatch(result.stdout, /is required/, `${command} ${help}: stdout says "is required":\n${result.stdout}`);
      assert.equal(result.stderr, "", `${command} ${help}: stderr not empty:\n${result.stderr}`);
    }
  }
});

test("assignment-provider top-level --help prints overall usage and is side-effect-free", () => {
  for (const help of ["--help", "-h"]) {
    const result = runAssignmentProvider([help]);
    assert.equal(result.status, 0, `${help}: exit ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Usage: flow-agents assignment-provider <command> \[flags\]/);
    assert.match(result.stdout, /claim|release|supersede|render-claim|status|list/);
    assert.equal(result.stderr, "", `${help}: stderr not empty:\n${result.stderr}`);
  }
});

test("assignment-provider still rejects missing required arguments without --help", () => {
  // claim without any required flags must still fail (regression guard for the fix).
  const result = runAssignmentProvider(["claim"]);
  assert.notEqual(result.status, 0, `claim without --help should not exit 0:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /is required/, `claim without --help should surface a required-arg error:\n${result.stderr}`);
});
