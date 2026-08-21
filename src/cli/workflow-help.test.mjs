// Drift test binding the public workflow CLI's VERB_SPECS table to its dispatcher, modelled on
// workflow-sidecar-help.test.mjs (which binds COMMAND_DESCRIPTIONS to the sidecar's switch).
// Run: `npm run test:unit`.
//
// The safety assertion here is the one #1292 exists for: `--help` on a MUTATING verb must perform
// no mutation. Before the intercept, `workflow pause --help` fell through to the verb's execution
// path and failed only on its own preconditions — meaning the action began, and a verb whose
// preconditions happened to pass would have executed on a documentation request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute paths: the no-mutation tests spawn with a different cwd on purpose.
const CLI = path.resolve(__dirname, "../../build/src/cli.js");
const SOURCE = path.join(__dirname, "workflow.ts");
const { verbSpecsSnapshot } = await import(path.resolve(__dirname, "../../build/src/cli/workflow.js"));
const { BUILDER_RUN_ACTION_FLAGS } = await import(path.resolve(__dirname, "../../build/src/cli/builder-run.js"));
const specs = new Map(verbSpecsSnapshot().map((entry) => [entry.verb, entry]));

function runWorkflow(args, cwd) {
  return spawnSync(process.execPath, [CLI, "workflow", ...args], { cwd, encoding: "utf8" });
}

function sourceText() {
  return fs.readFileSync(SOURCE, "utf8");
}

test("every public verb has a spec entry, and every spec entry is a public verb", () => {
  const source = sourceText();
  const match = source.match(/const PUBLIC_VERBS = \[([^\]]+)\] as const/);
  assert.ok(match, "PUBLIC_VERBS const not found in workflow.ts — the dispatcher anchor moved");
  const dispatcherVerbs = [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  const specVerbs = [...specs.keys()];
  assert.deepEqual(
    [...dispatcherVerbs].sort(),
    [...specVerbs].sort(),
    "VERB_SPECS and PUBLIC_VERBS disagree — a verb was added or removed on one side only",
  );
});

test("every verb enforcing an allowlist draws it from the spec table, and the table has it", () => {
  // The one-source guarantee: an assertOnlyFlags call labelled "workflow X" must reference
  // verbSpecOptions("X") — never a fresh inline set, which would let help and enforcement drift.
  //
  // Two lessons are encoded in HOW this asserts. First, sites are found by their LABEL (the one
  // part every call carries) rather than by a regex over the options expression: an earlier
  // version captured the expression with [^,]+, which cannot span an inline set's own commas, so
  // a violating site became INVISIBLE to the test instead of failing it — fault injection proved
  // that a re-introduced inline set survived. Second, the expected site count is DERIVED from the
  // spec table (verbs with non-null options) rather than a hand-written floor, which absorbed the
  // loss of one site without complaint. A count-floor fails on whoever weakens it next; a derived
  // equality fails on the change that weakens it.
  const source = sourceText();
  const labelled = [...source.matchAll(/assertOnlyFlags\((.*?),\s*"workflow ([a-z-]+)"\)/g)];
  const enforcedVerbs = new Set(labelled.map(([, , verb]) => verb).filter((verb) => specs.has(verb)));
  const declaredVerbs = new Set([...specs.values()].filter((spec) => spec.options !== null && spec.enforcement === "workflow").map((spec) => spec.verb));
  assert.deepEqual(
    [...enforcedVerbs].sort(),
    [...declaredVerbs].sort(),
    "the set of verbs with enforcement sites must equal the set of verbs the table declares options for",
  );
  for (const [, argsExpr, verb] of labelled) {
    if (!specs.has(verb)) continue;
    assert.ok(
      argsExpr.includes(`verbSpecOptions("${verb}")`),
      `workflow ${verb} enforcement does not reference verbSpecOptions("${verb}") — help and enforcement can now disagree`,
    );
    assert.ok(
      !argsExpr.includes("new Set("),
      `workflow ${verb} enforcement carries an inline option set — the table is no longer the single source`,
    );
    const spec = specs.get(verb);
    assert.ok(Array.isArray(spec?.options) && spec.options.length > 0, `spec table has no options for enforced verb ${verb}`);
  }
});

test("--help on a mutating verb performs no mutation and exits 0", () => {
  // Empty directory, no session state, no artifact root: exactly the environment where the old
  // fall-through produced "current workflow pointer does not resolve..." — proof the verb ran.
  for (const verb of ["pause", "evidence", "critique", "cancel", "publish-delivery"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
    try {
      const result = runWorkflow([verb, "--help"], dir);
      assert.equal(result.status, 0, `workflow ${verb} --help exited ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`workflow ${verb}`), `help output does not name the verb`);
      assert.ok(!/does not resolve|is required|requires --/.test(result.stderr), `verb precondition ran on a help request: ${result.stderr}`);
      assert.deepEqual(fs.readdirSync(dir), [], `workflow ${verb} --help wrote into the working directory`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the `help <verb>` form and `--help --json` agree with the table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const prose = runWorkflow(["help", "evidence"], dir);
    assert.equal(prose.status, 0);
    const json = runWorkflow(["evidence", "--help", "--json"], dir);
    assert.equal(json.status, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.verb, "evidence");
    const tableOptions = [...specs.get("evidence").options].sort();
    assert.deepEqual(parsed.options, tableOptions, "--help --json options diverge from the spec table");
    for (const option of tableOptions) {
      assert.ok(prose.stdout.includes(`--${option}`), `prose help omits --${option}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("forwarded verbs derive their options from builderRun's enforcing sets", () => {
  // Round 1 of independent review refuted this file's original premise: six "no allowlist" verbs
  // were always constrained one layer down, in builderRun. Their help now derives from the SAME
  // exported sets builderRun enforces, plus the public passthrough flags the dispatcher strips.
  const passthrough = ["artifact-root", "session-dir", "json"];
  for (const [verb, action] of [["pause", "pause"], ["resume", "resume"], ["release", "release-assignment"], ["cancel", "cancel"], ["archive", "archive"], ["reclaim", "reclaim"]]) {
    const spec = specs.get(verb);
    assert.equal(spec.enforcement, "builder-run", `${verb} must be marked builder-run enforced`);
    const expected = [...new Set([...passthrough, ...BUILDER_RUN_ACTION_FLAGS[action]])].sort();
    assert.deepEqual(spec.options, expected, `${verb} help diverges from builderRun's enforcing set`);
  }
  // status/doctor genuinely have no allowlist at either layer; they alone stay summary-only.
  for (const verb of ["status", "doctor"]) {
    assert.equal(specs.get(verb).options, null, `${verb} should remain summary-only until an allowlist exists`);
  }
});

test("a verb with no declared allowlist at any layer gets summary-only help", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const result = runWorkflow(["status", "--help"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /not yet declared/);
    assert.ok(!/^\s+--/m.test(result.stdout), "summary-only help must not list options it cannot derive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tailored sidecar commands honour ALL help forms without executing", () => {
  // The round-1 HIGH: these three were excluded from the generic intercept, and their own
  // handlers recognised only a bare trailing --help — `verify-hold -h` executed domain logic on
  // a documentation request. All three forms must now render the TAILORED usage (richer than the
  // generic one-liner) and touch nothing.
  const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
  for (const command of ["reconcile-preflight", "verify-hold", "takeover-preflight"]) {
    for (const args of [[command, "--help"], [command, "--help", "extra"], [command, "-h"]]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
      try {
        const result = spawnSync(process.execPath, [SIDECAR, ...args], { cwd: dir, encoding: "utf8" });
        assert.equal(result.status, 0, `${args.join(" ")} exited ${result.status}: ${result.stderr}`);
        assert.match(result.stdout, /<artifactDir>/, `${args.join(" ")} did not render the tailored usage`);
        assert.deepEqual(fs.readdirSync(dir), [], `${args.join(" ")} wrote into the working directory`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("positional -h on the public dispatcher is a help request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const result = runWorkflow(["evidence", "-h"], dir);
    assert.equal(result.status, 0, `evidence -h executed the verb: ${result.stderr}`);
    assert.match(result.stdout, /workflow evidence/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--help followed by a value is still a help request, not an executed verb", () => {
  // parseArgs consumes `--help <word>` as a VALUED flag, so a naive flagBool check would fall
  // through to execution. Presence of the key is the contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const result = runWorkflow(["evidence", "--help", "extra"], dir);
    assert.equal(result.status, 0, `evidence --help extra executed the verb: ${result.stderr}`);
    assert.match(result.stdout, /workflow evidence/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar: --help on a dispatched command prints its description and touches nothing", () => {
  const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const result = spawnSync(process.execPath, [SIDECAR, "record-gate-claim", "--help"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `sidecar record-gate-claim --help exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /record-gate-claim/);
    assert.ok(!/artifact directory is required/.test(result.stderr + result.stdout), "the command's own precondition ran on a help request");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar: commands with tailored --help keep their richer usage", () => {
  const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
  const result = spawnSync(process.execPath, [SIDECAR, "verify-hold", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /<artifactDir>/, "verify-hold's tailored usage was replaced by the generic one-liner");
});
