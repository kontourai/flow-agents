import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute path: some tests below spawn with a different `cwd` (to prove side-effect-freedom in
// the invoking directory), so a repo-root-relative path would not resolve there.
const CLI = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
const SOURCE = path.join(__dirname, "workflow-sidecar.ts");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tree(root) {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      ...(entry.isDirectory() ? { children: tree(path.join(root, entry.name)) } : {}),
      ...(entry.isFile() ? { content: fs.readFileSync(path.join(root, entry.name), "utf8") } : {}),
    }));
}

function runSidecar(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
}

// Extract the command names main()'s switch actually dispatches (the real source of truth for
// what the CLI does), by slicing between `switch (p.command) {` and the `default: die(` case
// that always terminates it, then pulling every `case "...":` label out of that slice. This file
// has OTHER switch statements (e.g. inside liveness/verify-hold helpers) — anchoring on the
// unique `switch (p.command) {` header keeps this scoped to main()'s dispatcher only.
function dispatchedCommands() {
  const source = fs.readFileSync(SOURCE, "utf8");
  const start = source.indexOf("switch (p.command) {");
  assert.ok(start >= 0, "expected to find main()'s `switch (p.command) {` in workflow-sidecar.ts");
  const end = source.indexOf("default: die(", start);
  assert.ok(end >= 0, "expected to find the `default: die(...)` case terminating main()'s switch");
  const slice = source.slice(start, end);
  const names = [...slice.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]);
  assert.ok(names.length > 5, "expected to extract multiple case labels from main()'s switch");
  return names;
}

// Extract the command names COMMAND_DESCRIPTIONS actually documents (the help command's single
// source of truth), by slicing its own array-literal declaration out of the source.
function describedCommands() {
  const source = fs.readFileSync(SOURCE, "utf8");
  const start = source.indexOf("const COMMAND_DESCRIPTIONS");
  assert.ok(start >= 0, "expected to find the COMMAND_DESCRIPTIONS declaration in workflow-sidecar.ts");
  const end = source.indexOf("\n];", start);
  assert.ok(end >= 0, "expected to find COMMAND_DESCRIPTIONS's closing `];`");
  const slice = source.slice(start, end);
  const entries = [...slice.matchAll(/\["([a-z][a-z-]*)",\s*"([^"]+)"\]/g)].map((m) => ({ name: m[1], description: m[2] }));
  assert.ok(entries.length > 5, "expected to extract multiple entries from COMMAND_DESCRIPTIONS");
  return entries;
}

test("COMMAND_DESCRIPTIONS names every command main()'s switch dispatches, and nothing else (drift guard)", () => {
  const dispatched = new Set(dispatchedCommands());
  const described = describedCommands();
  const describedNames = new Set(described.map((e) => e.name));

  // `help` is handled before dispatch (see main()), so it is documented but is never a switch
  // `case` — the one deliberate, single exception.
  const describedMinusHelp = new Set([...describedNames].filter((name) => name !== "help"));

  assert.deepEqual(
    [...describedMinusHelp].sort(),
    [...dispatched].sort(),
    "COMMAND_DESCRIPTIONS (minus 'help') must name exactly the commands main()'s switch dispatches — add/remove/rename a case there and update the list, or this drift guard fails",
  );
  assert.ok(describedNames.has("help"), "COMMAND_DESCRIPTIONS must document the help command itself");

  // No duplicate/empty descriptions.
  for (const entry of described) {
    assert.ok(entry.description.trim().length > 0, `command '${entry.name}' has an empty description`);
  }
  const names = described.map((e) => e.name);
  assert.deepEqual(names, [...new Set(names)], "COMMAND_DESCRIPTIONS must not list a command name twice");
});

test("help, --help, and -h all print the same command listing, exit 0, and are side-effect-free", () => {
  const scratch = tempDir("workflow-sidecar-help-");
  fs.writeFileSync(path.join(scratch, "sentinel.txt"), "unchanged\n");
  const before = tree(scratch);

  const dispatched = dispatchedCommands();
  let firstStdout;
  for (const variant of ["help", "--help", "-h"]) {
    const result = runSidecar([variant], { cwd: scratch });
    assert.equal(result.status, 0, `${variant}: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stderr, "", `${variant}: expected empty stderr, got: ${result.stderr}`);
    for (const command of dispatched) {
      assert.match(result.stdout, new RegExp(`\\b${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), `${variant}: expected '${command}' to be listed`);
    }
    if (firstStdout === undefined) firstStdout = result.stdout;
    else assert.equal(result.stdout, firstStdout, `${variant}: expected the same listing as 'help'`);
  }

  assert.deepEqual(tree(scratch), before, "help must not write anything to the current working directory");
});

test("a genuinely unknown command still fails loudly and does not print the help listing", () => {
  const result = runSidecar(["not-a-real-command"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command: not-a-real-command/);
  assert.doesNotMatch(result.stdout, /Commands:/);
});
