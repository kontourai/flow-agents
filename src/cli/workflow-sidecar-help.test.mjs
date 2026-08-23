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

// ─── #1294: --key=value parser parity + option-level specs/allowlists ────────────────────────

// Extract COMMAND_OPTION_SPECS entries from the source, the same way describedCommands() scrapes
// COMMAND_DESCRIPTIONS: the map literal is the single source of truth for both help output and
// unknown-flag enforcement, and this scrape binds it to the dispatcher and to the real CLI below.
function optionSpecs() {
  const source = fs.readFileSync(SOURCE, "utf8");
  const start = source.indexOf("const COMMAND_OPTION_SPECS");
  assert.ok(start >= 0, "expected to find the COMMAND_OPTION_SPECS declaration in workflow-sidecar.ts");
  const end = source.indexOf("]);", start);
  assert.ok(end >= 0, "expected to find COMMAND_OPTION_SPECS's closing `]);`");
  const slice = source.slice(start, end);
  const entries = [...slice.matchAll(/\["([a-z-]+)",\s*\[([^\]]*)\]\]/g)].map((m) => ({
    name: m[1],
    options: [...m[2].matchAll(/"([a-z-]+)"/g)].map((o) => o[1]),
  }));
  assert.ok(entries.length >= 5, "expected to extract multiple entries from COMMAND_OPTION_SPECS");
  return entries;
}

test("every COMMAND_OPTION_SPECS command is dispatched and described (drift guard, one level down)", () => {
  const dispatched = new Set(dispatchedCommands());
  const described = new Set(describedCommands().map((e) => e.name));
  for (const entry of optionSpecs()) {
    assert.ok(dispatched.has(entry.name), `COMMAND_OPTION_SPECS names '${entry.name}', which main()'s switch does not dispatch`);
    assert.ok(described.has(entry.name), `COMMAND_OPTION_SPECS names '${entry.name}', which COMMAND_DESCRIPTIONS does not describe`);
    assert.deepEqual(entry.options, [...new Set(entry.options)], `command '${entry.name}' lists an option twice`);
  }
});

test("each adopted command's --help names exactly its declared options — help and enforcement cannot disagree", () => {
  for (const entry of optionSpecs()) {
    const result = runSidecar([entry.name, "--help"]);
    assert.equal(result.status, 0, `${entry.name} --help: status=${result.status} stderr=${result.stderr}`);
    const advertised = [...new Set([...result.stdout.matchAll(/--([a-z-]+)/g)].map((m) => m[1]))].filter((o) => o !== "help");
    assert.deepEqual(
      advertised.sort(),
      [...entry.options].sort(),
      `${entry.name} --help advertises [${advertised}] but COMMAND_OPTION_SPECS declares [${entry.options}]`,
    );
  }
});

test("adopted commands reject an unknown flag before any action runs (space form and = form)", () => {
  const scratch = tempDir("workflow-sidecar-allowlist-");
  const before = tree(scratch);
  // Space form.
  const spaceForm = runSidecar(["claim", "some-claim-id", scratch, "--bogus", "x"], { cwd: scratch });
  assert.notEqual(spaceForm.status, 0);
  assert.match(spaceForm.stderr, /unknown flag --bogus for claim/);
  assert.match(spaceForm.stderr, /--json/, "the rejection must name the supported options");
  // = form: the key must be split off the value — pre-#1294 the whole token was one flag named
  // 'bogus=x', so this assertion is the end-to-end proof the parser fix reached the real CLI.
  const eqForm = runSidecar(["verify-hold", scratch, "--bogus=x"], { cwd: scratch });
  assert.notEqual(eqForm.status, 0);
  assert.match(eqForm.stderr, /unknown flag --bogus for verify-hold/);
  assert.doesNotMatch(eqForm.stderr, /bogus=x/, "the = form must parse as key 'bogus', not a flag named 'bogus=x'");
  assert.deepEqual(tree(scratch), before, "a rejected invocation must not write anything");
});

test("unadopted commands keep current behaviour verbatim: unknown flags still pass through", () => {
  const result = runSidecar(["resolve-slug", "kontourai/flow-agents#1294", "--bogus", "x"]);
  assert.equal(result.status, 0, `resolve-slug: status=${result.status} stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown flag/);
  assert.match(result.stdout, /kontourai-flow-agents-1294/);
});

test("publish-delivery keeps its disabled-stub redirect for every invocation, flags included (review round 1)", () => {
  // The repo's own evals call `publish-delivery <dir> --repo-root <dir>` and assert the redirect
  // message. Adopting an allowlist for a hard-die stub shadowed that message with an unknown-flag
  // refusal — this pins the stub's contract: the redirect always wins, whatever flags arrive.
  const scratch = tempDir("workflow-sidecar-publish-delivery-");
  const result = runSidecar(["publish-delivery", scratch, "--repo-root", scratch], { cwd: scratch });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publish-delivery is disabled; use `flow-agents workflow publish-delivery`/);
  assert.doesNotMatch(result.stderr, /unknown flag/);
});

test("--key=value parses identically in the shared parser and the sidecar parser (parity, #1294)", async () => {
  const { parseArgs: sharedParse } = await import(path.resolve(__dirname, "../../build/src/lib/args.js"));
  const { parseSidecarArgs } = await import(path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js"));

  // Normalize each parser's output to a comparable key → [values] map plus positionals.
  // Bare flags (no value) are represented as true.
  const normalizeShared = (argv) => {
    const parsed = sharedParse(argv);
    const bindings = {};
    for (const [key, value] of Object.entries(parsed.flags)) {
      bindings[key] = value === true ? true : Array.isArray(value) ? value : [value];
    }
    return { positionals: parsed.positionals, bindings };
  };
  const normalizeSidecar = (argv) => {
    const parsed = parseSidecarArgs(["some-command", ...argv]);
    const bindings = {};
    for (const key of parsed.flags) bindings[key] = true;
    for (const [key, values] of Object.entries(parsed.opts)) bindings[key] = values;
    return { positionals: parsed.positional, bindings };
  };

  const matrix = [
    ["--key=value"],
    ["--key=value", "pos"],
    ["pos1", "--key=value", "pos2"],
    ["--key="], // empty value binds as "", exactly like src/lib/args.ts's arg.slice(eq + 1)
    ["--key=--dashed"], // a value that looks like a flag still binds in the = form
    ["--key=a=b"], // only the FIRST = splits key from value
    ["--key=1", "--key=2"], // repeats accumulate in order
    ["--key=value", "--bare"],
    ["--a=1", "--b", "2", "pos"], // = form and space form mix
  ];
  for (const argv of matrix) {
    assert.deepEqual(
      normalizeSidecar(argv),
      normalizeShared(argv),
      `parsers disagree on: ${JSON.stringify(argv)}`,
    );
  }

  // Within each parser, the = form and the space form of the same binding agree (the syntax the
  // issue says "silently degrades to a bare flag in half the CLI").
  assert.deepEqual(normalizeShared(["--key=value"]), normalizeShared(["--key", "value"]));
  assert.deepEqual(normalizeSidecar(["--key=value"]), normalizeSidecar(["--key", "value"]));
});
