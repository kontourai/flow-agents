// Unit tests for src/transition-log.ts — the CLI's self-witness.
//
// Run: `npm run test:unit`, or directly:
//   node --test src/cli/transition-log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  appendTransitionRecord,
  buildTransitionRecord,
  classifyOutcome,
  summarizeArgv,
  TRANSITION_LOG_FILENAME,
  TRANSITION_RECORD_KIND,
} from "../../build/src/transition-log.js";

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transition-log-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("identifier flags are recorded with their values", () => {
  const { verb, targets, flags } = summarizeArgv([
    "evidence",
    "--expectation",
    "tests-evidence",
    "--gate",
    "verify-gate",
  ]);
  assert.equal(verb, "evidence");
  assert.deepEqual(targets, { expectation: "tests-evidence", gate: "verify-gate" });
  assert.deepEqual(flags, ["--expectation", "--gate"]);
});

test("--flag=value is normalized to the same shape as --flag value", () => {
  const { targets } = summarizeArgv(["evidence", "--expectation=merge-readiness"]);
  assert.deepEqual(targets, { expectation: "merge-readiness" });
});

// The whole point of the allowlist: operator prose must not reach a telemetry file.
test("free-text flags contribute their name but never their value", () => {
  const secret = "the reviewer said the auth token was rotated on prod-db-7";
  const { targets, flags } = summarizeArgv(["evidence", "--summary", secret, "--body", secret]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--summary", "--body"]);
  assert.ok(!JSON.stringify({ targets, flags }).includes("auth token"));
});

// An allowlisted flag is not a licence to record anything: a value that does not look
// like an identifier is still prose, and is dropped rather than trusted for its name.
test("an allowlisted flag holding non-identifier text drops the value", () => {
  const { targets, flags } = summarizeArgv(["evidence", "--decision", "we agreed to ship it"]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--decision"]);
});

test("a flag at end of argv with no value does not consume the next flag", () => {
  const { targets, flags } = summarizeArgv(["evidence", "--gate", "--json"]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--gate", "--json"]);
});

test("outcome names what the code observably is, not what it is assumed to mean", () => {
  assert.equal(classifyOutcome(0), "ok");
  assert.equal(classifyOutcome(64), "usage");
  assert.equal(classifyOutcome(70), "unhandled-error");
  assert.equal(classifyOutcome(1), "nonzero");
  assert.equal(classifyOutcome(127), "nonzero");
});

test("a record carries the message head only on the error path", () => {
  const startedAt = new Date("2026-08-17T12:00:00.000Z");
  const endedAt = new Date("2026-08-17T12:00:02.500Z");
  const ok = buildTransitionRecord({
    command: "workflow",
    argv: ["evidence", "--expectation", "tests-evidence"],
    exitCode: 0,
    startedAt,
    endedAt,
    env: {},
  });
  assert.equal(ok.kind, TRANSITION_RECORD_KIND);
  assert.equal(ok.duration_ms, 2500);
  assert.equal(ok.outcome, "ok");
  assert.ok(!("message_head" in ok));

  const failed = buildTransitionRecord({
    command: "workflow",
    argv: ["evidence"],
    exitCode: 70,
    startedAt,
    endedAt,
    errorMessage: "gate claim has no captured command observation",
    env: {},
  });
  assert.equal(failed.outcome, "unhandled-error");
  assert.equal(failed.message_head, "gate claim has no captured command observation");
});

test("the message head is truncated so a long throw cannot bloat the log", () => {
  const record = buildTransitionRecord({
    command: "workflow",
    argv: [],
    exitCode: 70,
    startedAt: new Date(),
    endedAt: new Date(),
    errorMessage: "x".repeat(500),
    env: {},
  });
  assert.ok(record.message_head.length <= 160);
  assert.ok(record.message_head.endsWith("…"));
});

test("append writes one JSON line per invocation under the repo's telemetry dir", () => {
  const root = fixtureRepo();
  const record = buildTransitionRecord({
    command: "workflow",
    argv: ["evidence", "--expectation", "tests-evidence"],
    exitCode: 0,
    startedAt: new Date(),
    endedAt: new Date(),
    env: {},
  });
  assert.equal(appendTransitionRecord(record, root), true);
  assert.equal(appendTransitionRecord(record, root), true);

  const file = path.join(root, ".kontourai", "telemetry", TRANSITION_LOG_FILENAME);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).targets.expectation, "tests-evidence");
});

// A telemetry write must never be able to fail the command it describes.
test("an unwritable telemetry destination degrades to no record, not a throw", () => {
  const root = fixtureRepo();
  // Occupy the telemetry directory path with a FILE so mkdir cannot succeed.
  fs.mkdirSync(path.join(root, ".kontourai"), { recursive: true });
  fs.writeFileSync(path.join(root, ".kontourai", "telemetry"), "not a directory", "utf8");
  const record = buildTransitionRecord({
    command: "workflow",
    argv: [],
    exitCode: 0,
    startedAt: new Date(),
    endedAt: new Date(),
    env: {},
  });
  assert.equal(appendTransitionRecord(record, root), false);
});

test("FLOW_AGENTS_TRANSITION_LOG=0 opts a run out entirely", () => {
  const root = fixtureRepo();
  const previous = process.env["FLOW_AGENTS_TRANSITION_LOG"];
  process.env["FLOW_AGENTS_TRANSITION_LOG"] = "0";
  try {
    const record = buildTransitionRecord({
      command: "workflow",
      argv: [],
      exitCode: 0,
      startedAt: new Date(),
      endedAt: new Date(),
      env: {},
    });
    assert.equal(appendTransitionRecord(record, root), false);
    assert.equal(fs.existsSync(path.join(root, ".kontourai", "telemetry")), false);
  } finally {
    if (previous === undefined) delete process.env["FLOW_AGENTS_TRANSITION_LOG"];
    else process.env["FLOW_AGENTS_TRANSITION_LOG"] = previous;
  }
});
