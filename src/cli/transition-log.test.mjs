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
  recordTransition,
  summarizeArgv,
  TRANSITION_LOG_FILENAME,
  TRANSITION_RECORD_KIND,
  noteActiveFlow,
  noteGateOutcome,
  resetActiveFlow,
  resetGateOutcome,
  transitionLogRoot,
  UNKNOWN_COMMAND,
  UNPARSED,
} from "../../build/src/transition-log.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const CLI = path.resolve(import.meta.dirname, "../../build/src/cli.js");

function runCli(args, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readLog(root) {
  const file = path.join(root, ".flow-agents", "telemetry", TRANSITION_LOG_FILENAME);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fixtureRepo() {
  const root = makeFixtureDir("transition-log-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("identifier flags are recorded with their values", () => {
  const { verb, targets, flags } = summarizeArgv([
    "evidence",
    "--expectation",
    "tests-evidence",
    "--flow",
    "builder.build",
  ]);
  assert.equal(verb, "evidence");
  assert.deepEqual(targets, { expectation: "tests-evidence", flow: "builder.build" });
  assert.deepEqual(flags, ["--expectation", "--flow"]);
});

test("--flag=value is normalized to the same shape as --flag value", () => {
  const { targets } = summarizeArgv(["evidence", "--expectation=merge-readiness"]);
  assert.deepEqual(targets, { expectation: "merge-readiness" });
});

// The whole point of the allowlist: operator prose must not reach a telemetry file.
test("free-text flags contribute their name but never their value", () => {
  const secret = "the reviewer said the credential was rotated on host-7";
  const { targets, flags } = summarizeArgv(["evidence", "--summary", secret, "--body", secret]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--summary", "--body"]);
  assert.ok(!JSON.stringify({ targets, flags }).includes("was rotated"));
});

// An allowlisted flag is not a licence to record anything: a value that does not look
// like an identifier is still prose, and is dropped rather than trusted for its name.
test("an allowlisted flag holding non-identifier text drops the value", () => {
  const { targets, flags } = summarizeArgv(["evidence", "--decision", "we agreed to ship it"]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--decision"]);
});

test("a flag at end of argv with no value does not consume the next flag", () => {
  const { targets, flags } = summarizeArgv(["evidence", "--flow", "--json"]);
  assert.deepEqual(targets, {});
  assert.deepEqual(flags, ["--flow", "--json"]);
});

test("outcome names what the code observably is, not what it is assumed to mean", () => {
  assert.equal(classifyOutcome(0), "ok");
  assert.equal(classifyOutcome(64), "usage");
  assert.equal(classifyOutcome(70), "unhandled-error");
  assert.equal(classifyOutcome(1), "nonzero");
  assert.equal(classifyOutcome(127), "nonzero");
});

test("a record carries the error class name only on the error path", () => {
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
  assert.equal(ok.schema, TRANSITION_RECORD_KIND);
  assert.equal(ok.duration_ms, 2500);
  assert.equal(ok.outcome, "ok");
  assert.ok(!("error_name" in ok));

  const failed = buildTransitionRecord({
    command: "workflow",
    argv: ["evidence"],
    exitCode: 70,
    startedAt,
    endedAt,
    errorName: "SignalValidationError",
    env: {},
  });
  assert.equal(failed.outcome, "unhandled-error");
  assert.equal(failed.error_name, "SignalValidationError");
});

test("the error name is bounded so a pathological class name cannot bloat the log", () => {
  const record = buildTransitionRecord({
    command: "workflow",
    argv: [],
    exitCode: 70,
    startedAt: new Date(),
    endedAt: new Date(),
    errorName: "E".repeat(500),
    env: {},
  });
  assert.equal(record.error_name.length, 80);
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

  const file = path.join(root, ".flow-agents", "telemetry", TRANSITION_LOG_FILENAME);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).targets.expectation, "tests-evidence");
});

// A telemetry write must never be able to fail the command it describes.
test("an unwritable telemetry destination degrades to no record, not a throw", () => {
  const root = fixtureRepo();
  // Occupy the telemetry directory path with a FILE so mkdir cannot succeed.
  fs.mkdirSync(path.join(root, ".flow-agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flow-agents", "telemetry"), "not a directory", "utf8");
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
    assert.equal(fs.existsSync(path.join(root, ".flow-agents", "telemetry")), false);
  } finally {
    if (previous === undefined) delete process.env["FLOW_AGENTS_TRANSITION_LOG"];
    else process.env["FLOW_AGENTS_TRANSITION_LOG"] = previous;
  }
});

test("a symlinked log file is refused rather than written through", () => {
  const root = fixtureRepo();
  const target = path.join(root, "elsewhere.txt");
  fs.writeFileSync(target, "pre-existing\n", "utf8");
  const dir = path.join(root, ".flow-agents", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, TRANSITION_LOG_FILENAME));

  const record = buildTransitionRecord({
    command: "workflow",
    argv: [],
    exitCode: 0,
    startedAt: new Date(),
    endedAt: new Date(),
    env: {},
  });
  assert.equal(appendTransitionRecord(record, root), false);
  assert.equal(fs.readFileSync(target, "utf8"), "pre-existing\n");
});

// --- Integration: the real binary. -----------------------------------------
// Both HIGH findings from review (an unfiltered command name, and a log that
// fragmented per working directory) were invisible to every unit test above,
// because none of them ran the CLI. These do.

test("the real CLI records a successful invocation with its command and outcome", () => {
  const root = fixtureRepo();
  runCli(["commands"], root);
  const records = readLog(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].schema, TRANSITION_RECORD_KIND);
  assert.equal(records[0].command, "commands");
  assert.equal(records[0].outcome, "ok");
  assert.equal(records[0].exit_code, 0);
});

// H1: `commandName` is `process.argv[2]` verbatim for the ordinary invocation form.
// A misplaced shell variable lands there, and an unbounded copy used to be written.
test("an unregistered command name is never written to the log", () => {
  const root = fixtureRepo();
  const leak = "opaque-value-that-must-not-be-recorded-1234567890";
  assert.throws(() => runCli([leak], root));

  const records = readLog(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].command, UNKNOWN_COMMAND);
  assert.equal(records[0].exit_code, 64);
  assert.ok(
    !fs
      .readFileSync(path.join(root, ".flow-agents", "telemetry", TRANSITION_LOG_FILENAME), "utf8")
      .includes(leak),
    "the rejected argument must not appear anywhere in the log",
  );
});

// H2: several verbs interpolate raw operator input into the messages they throw, and
// `workflow` has no local catch, so those messages reach the top-level handler.
test("a throw records the error class, never the thrown message", () => {
  const root = fixtureRepo();
  const secret = "operator-prose-that-must-not-be-logged";
  assert.throws(() => runCli(["workflow", "evidence", "--route-reason", secret], root));

  const raw = fs.readFileSync(path.join(root, ".flow-agents", "telemetry", TRANSITION_LOG_FILENAME), "utf8");
  assert.ok(!raw.includes(secret), "operator-supplied text must not reach the log");
  assert.ok(!raw.includes("message_head"), "the message channel must be gone, not merely truncated");
  const record = readLog(root).at(-1);
  assert.equal(record.exit_code, 70);
  assert.equal(record.outcome, "unhandled-error");
  assert.equal(typeof record.error_name, "string");
});

// M2: telemetryDataDir resolves against cwd, so invoking from a subdirectory used to
// start a second, independent log — and an analyzer reading either reported a
// fragment of the run as the whole of it.
test("one repository keeps one log, whatever directory the CLI runs from", () => {
  const root = fixtureRepo();
  const nested = path.join(root, "packages", "deep");
  fs.mkdirSync(nested, { recursive: true });

  runCli(["commands"], root);
  runCli(["commands"], nested);

  assert.equal(readLog(root).length, 2, "both invocations belong to the same log");
  assert.equal(
    fs.existsSync(path.join(nested, ".kontourai")),
    false,
    "a subdirectory must not start a log of its own",
  );
});

// Litter in someone else's directory. A caller running the CLI from a temp dir, a home
// directory, or their own cwd during a delegated retry must not find a .kontourai/
// there afterwards — the repo asserts this in test_public_workflow_cli.sh, and the
// first version of this writer failed it.
test("outside a repository nothing is written at all", () => {
  const loose = makeFixtureDir("transition-log-bare-");
  assert.equal(transitionLogRoot(loose), null);
  assert.equal(
    recordTransition({
      command: "commands",
      argv: [],
      exitCode: 0,
      startedAt: new Date(),
      endedAt: new Date(),
      cwd: loose,
      env: {},
    }),
    false,
  );
  assert.equal(fs.existsSync(path.join(loose, ".kontourai")), false, "the caller's directory is untouched");
});

// --- redaction holes found by review, each reproduced before it was closed ---------

// A value beginning with "-" was not consumed as a value, so the next iteration treated
// the whole string as a flag NAME and recorded it verbatim and unbounded.
test("a flag value beginning with a dash is never recorded as a flag name", () => {
  const prose = "-> rotated the credential on host-7";
  const { flags, targets } = summarizeArgv(["evidence", "--summary", prose]);
  assert.ok(!flags.includes(prose), "operator prose must not become a flag name");
  assert.ok(!JSON.stringify({ flags, targets }).includes("rotated the credential"));
  assert.deepEqual(flags, ["--summary", UNPARSED]);
});

test("a pathologically long dash-prefixed token cannot bloat the log", () => {
  const { flags } = summarizeArgv([`--${"A".repeat(300)} with spaces`]);
  assert.deepEqual(flags, [UNPARSED]);
});

// The verb is argv[3] — the same class of operator-controlled input as the command.
test("a verb that is not a word is not recorded", () => {
  assert.equal(summarizeArgv(["https://internal.example.com/secret#frag"]).verb, UNPARSED);
  assert.equal(summarizeArgv(["opaque_TOKENSHAPEDVALUEwithunderscore1234"]).verb, UNPARSED);
  assert.equal(summarizeArgv(["evidence"]).verb, "evidence");
});

// Run state, not a flag: `workflow evidence` cannot be relied on to carry --flow.
test("the active flow noted from run state lands on the record", () => {
  resetActiveFlow();
  const base = { command: "workflow", argv: ["evidence", "--expectation", "tests-evidence"], exitCode: 0, startedAt: new Date(), endedAt: new Date(), env: {} };
  assert.equal(buildTransitionRecord(base).targets.flow, undefined);
  noteActiveFlow("builder.build");
  try {
    assert.equal(buildTransitionRecord(base).targets.flow, "builder.build");
    noteActiveFlow("not a flow id");
    assert.equal(buildTransitionRecord(base).targets.flow, undefined, "a non-identifier is refused");
  } finally {
    resetActiveFlow();
  }
});

// A read-only command must not leave committable residue in a repo that never opted in.
test("the log directory carries its own ignore rule wherever it is created", () => {
  const root = fixtureRepo();
  runCli(["commands"], root);
  const ignore = path.join(root, ".flow-agents", "telemetry", ".gitignore");
  assert.ok(fs.existsSync(ignore), "an ignore rule is written beside the log");
  assert.match(fs.readFileSync(ignore, "utf8"), /^\*$/m);
  const tracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  assert.ok(!tracked.includes("transitions.jsonl"), `the log must not show as untracked: ${tracked}`);
});

// The first guard checked only the leaf, so a symlinked parent redirected the write and
// still returned success.
test("a symlinked parent directory is refused, not written through", () => {
  const root = fixtureRepo();
  const outside = makeFixtureDir("transition-log-outside-");
  fs.mkdirSync(path.join(root, ".flow-agents"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".flow-agents", "telemetry"));
  const record = buildTransitionRecord({
    command: "workflow", argv: [], exitCode: 0, startedAt: new Date(), endedAt: new Date(), env: {},
  });
  assert.equal(appendTransitionRecord(record, root), false);
  assert.equal(fs.existsSync(path.join(outside, TRANSITION_LOG_FILENAME)), false);
});

// The opt-out must not still pay for a git subprocess to be told it is off.
test("opting out short-circuits before the repo root is resolved", () => {
  const previous = process.env["FLOW_AGENTS_TRANSITION_LOG"];
  process.env["FLOW_AGENTS_TRANSITION_LOG"] = "0";
  try {
    assert.equal(
      recordTransition({ command: "commands", argv: [], exitCode: 0, startedAt: new Date(), endedAt: new Date(), env: process.env }),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env["FLOW_AGENTS_TRANSITION_LOG"];
    else process.env["FLOW_AGENTS_TRANSITION_LOG"] = previous;
  }
});

// The schema file is the only thing binding the typed producer to its two untyped
// consumers; without a test it drifts the first time a field is renamed.
test("an emitted record satisfies the published schema", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../scripts/telemetry/transition-record.schema.json"), "utf8"),
  );
  const root = fixtureRepo();
  try { runCli(["workflow", "evidence", "--expectation", "tests-evidence"], root); } catch { /* refusal is expected; the record is the subject */ }
  const records = readLog(root);
  assert.ok(records.length >= 1);
  for (const record of records) {
    for (const required of schema.required) {
      assert.ok(required in record, `emitted record is missing required field ${required}`);
    }
    assert.equal(record.schema, schema.properties.schema.const);
    assert.equal(record.version, schema.properties.version.const);
    assert.ok(schema.properties.outcome.enum.includes(record.outcome));
    if (record.error_name) assert.ok(record.error_name.length <= schema.properties.error_name.maxLength);
    assert.ok(Array.isArray(record.flags));
    assert.equal(typeof record.actor, "object");
  }
});

// An allowlist of flags nobody passes reads as checked when it is not. An earlier
// version listed four flags this CLI never defines.
test("every allowlisted identifier flag is a flag this CLI actually defines", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../transition-log.ts"), "utf8");
  const block = source.slice(source.indexOf("const IDENTIFIER_FLAGS"), source.indexOf("]);", source.indexOf("const IDENTIFIER_FLAGS")));
  const listed = [...block.matchAll(/"--([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(listed.length > 0);

  const cliDir = path.resolve(import.meta.dirname);
  const haystack = fs
    .readdirSync(cliDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => fs.readFileSync(path.join(cliDir, entry), "utf8"))
    .join("\n");
  for (const flag of listed) {
    assert.ok(haystack.includes(`"${flag}"`), `--${flag} is allowlisted but no command defines it`);
  }
});

// `workflow evidence` returns 0 whether the gate advanced or is still awaiting the
// rest of its expectations, so the exit code cannot tell those apart — and the second
// case is the ordinary partial-satisfaction path, not an edge case.
test("the gate verdict is recorded separately from the process exit code", () => {
  resetGateOutcome();
  const base = { command: "workflow", argv: ["evidence"], exitCode: 0, startedAt: new Date(), endedAt: new Date(), env: {} };
  assert.ok(!("gate_outcome" in buildTransitionRecord(base)), "absent when no gate was resolved");

  noteGateOutcome({ attached: false, missing: ["clean-critique"] });
  try {
    const awaiting = buildTransitionRecord(base);
    assert.equal(awaiting.outcome, "ok", "the process exited 0");
    assert.equal(awaiting.gate_outcome, "awaiting", "and the gate did not advance");
    assert.deepEqual(awaiting.gate_missing, ["clean-critique"]);

    noteGateOutcome({ attached: true });
    const advanced = buildTransitionRecord(base);
    assert.equal(advanced.gate_outcome, "advanced");
    assert.ok(!("gate_missing" in advanced));
  } finally {
    resetGateOutcome();
  }
});
