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
const { verbSpecs } = await import(path.resolve(__dirname, "../../build/src/cli/workflow.js"));

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
  const specVerbs = [...verbSpecs().keys()];
  assert.deepEqual(
    [...dispatcherVerbs].sort(),
    [...specVerbs].sort(),
    "VERB_SPECS and PUBLIC_VERBS disagree — a verb was added or removed on one side only",
  );
});

test("every verb enforcing an allowlist draws it from the spec table, and the table has it", () => {
  // The one-source guarantee: an assertOnlyFlags call labelled "workflow X" must reference
  // verbSpecOptions("X") — never a fresh inline set, which would let help and enforcement drift —
  // and the table must carry non-null options for X. Checked in BOTH directions.
  const source = sourceText();
  const enforcementSites = [...source.matchAll(/assertOnlyFlags\([^,]+,\s*([^,]+),\s*"workflow ([a-z-]+)"\)/g)]
    .filter(([, , verb]) => verbSpecs().has(verb));
  assert.ok(enforcementSites.length >= 17, `expected at least 17 enforcement sites, found ${enforcementSites.length}`);
  for (const [, optionsExpr, verb] of enforcementSites) {
    assert.match(
      optionsExpr.trim(),
      new RegExp(`^verbSpecOptions\\("${verb}"\\)$`),
      `workflow ${verb} enforces options from '${optionsExpr.trim()}' instead of the spec table — help and enforcement can now disagree`,
    );
    const spec = verbSpecs().get(verb);
    assert.ok(spec?.options instanceof Set && spec.options.size > 0, `spec table has no options for enforced verb ${verb}`);
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
    const tableOptions = [...verbSpecs().get("evidence").options].sort();
    assert.deepEqual(parsed.options, tableOptions, "--help --json options diverge from the spec table");
    for (const option of tableOptions) {
      assert.ok(prose.stdout.includes(`--${option}`), `prose help omits --${option}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a verb with no declared allowlist gets summary-only help, not an invented option list", () => {
  // Slice 1 deliberately declines to mint allowlists for verbs that never had one: a new
  // allowlist is a new refusal, and inventing option docs from flag reads would be a label
  // nothing derives. The help says so instead of guessing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-help-"));
  try {
    const result = runWorkflow(["pause", "--help"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /not yet declared/);
    assert.ok(!/^\s+--/m.test(result.stdout), "summary-only help must not list options it cannot derive");
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
