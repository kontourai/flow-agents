// Drift test binding `workflow <verb> --explain` (#1358) to the validators that actually refuse,
// and asserting the one-pass refusal contract (#1359). Run: `npm run test:unit`.
//
// The #1298 doctrine is that help must be DERIVED from the enforcing option sets, bound by a drift
// test. `--explain` extends that from flag NAMES to the JSON SHAPES behind them, so the binding has
// to be stronger than "both sides read the same constant": a render layer can add a field, a kind
// or a clause on its way out and no data comparison would notice.
//
// So the assertions below are EXECUTABLE and run in the direction that matters. Everything
// `--explain` prints as accepted is fed to the REAL CLI and must be accepted; every clause it
// prints as a rule is provoked and the refusal text must be byte-identical. If `--explain` ever
// advertises a shape the validator does not enforce, these go red on the change that introduces it
// rather than on the caller who believes the output.
//
// The evidence-ref and lane assertions drive `workflow-sidecar record-critique`, which reaches
// normalizeCritiqueLanes → normalizeEvidenceRefs → validateEvidenceRef end to end, so what is
// being checked is the shipped refusal path and not a helper that resembles it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../build/src/cli.js");
const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
const { explainSpec } = await import(path.resolve(__dirname, "../../build/src/cli/workflow.js"));
const { validateEvidenceRef } = await import(path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js"));

const EVIDENCE_SPEC = explainSpec("evidence");
const CRITIQUE_SPEC = explainSpec("critique");
const evidenceRefShape = EVIDENCE_SPEC.json_flags.find((shape) => shape.flag === "--evidence-ref-json");
const criterionShape = EVIDENCE_SPEC.json_flags.find((shape) => shape.flag === "--criterion-json");
const laneShape = CRITIQUE_SPEC.json_flags.find((shape) => shape.flag === "--lane-json");

const VALID_LANE = { id: "correctness", status: "pass", summary: "reviewed", evidence_refs: [{ kind: "command", summary: "ran the suite" }] };

/** Drive the shipped record-critique path far enough to exercise lane + evidence-ref validation. */
function laneRefusal(lane) {
  const root = makeFixtureDir("wf-explain-");
  const dir = path.join(root, ".kontourai", "flow-agents", "demo");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [SIDECAR, "record-critique", dir, "--verdict", "pass", "--summary", "s", "--lane-json", JSON.stringify(lane)], { cwd: root, encoding: "utf8" });
    return `${result.stdout}${result.stderr}`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** True when the CLI got PAST lane/evidence-ref validation (later gates are not this test's subject). */
function laneAccepted(lane) {
  const output = laneRefusal(lane);
  return !/--lane-json/.test(output);
}

/**
 * The value a field must carry, read from the rule `--explain` itself printed for that field.
 * Nothing here is hard-coded per field: a newly printed field with no printed rule falls through
 * to a string, which is precisely the case an over-promising `--explain` produces.
 */
function valueForField(field) {
  const rule = evidenceRefShape.rules.find((candidate) => candidate.startsWith(`${field} must be `));
  if (rule?.endsWith("a positive integer")) return 1;
  return "placeholder";
}

/** Clause rules, parsed out of the printed text alone: "<kind> refs require a, b, and c". */
function printedClauses() {
  return evidenceRefShape.rules
    .map((rule) => /^(\w+) refs require (.+)$/.exec(rule))
    .filter((match) => match !== null)
    .map(([rule, kind, clause]) => ({
      rule,
      kind,
      // "and" means every field is required; anything else means at least one of them is.
      mode: clause.includes(" and ") ? "all" : "any",
      fields: clause.replace(/,? (?:and|or) /g, ", ").split(", ").filter((field) => field.length > 0),
    }));
}

function exampleFor(kind) {
  const example = evidenceRefShape.examples.find((candidate) => candidate.kind === kind);
  assert.ok(example, `--explain prints a rule for kind ${kind} but no example of it`);
  return example;
}

test("--explain names only JSON flags the verb's own enforcing option set accepts", () => {
  // A shape advertised for a flag the verb rejects is the #1358 defect inverted: the caller spends
  // a round-trip on a flag that was never going to be accepted.
  for (const verb of ["evidence", "critique", "evidence-request", "reseal-verification-evidence-request"]) {
    const spec = explainSpec(verb);
    const dir = makeFixtureDir("wf-explain-");
    try {
      const help = spawnSync(process.execPath, [CLI, "workflow", verb, "--help", "--json"], { cwd: dir, encoding: "utf8" });
      assert.equal(help.status, 0, help.stderr);
      const options = JSON.parse(help.stdout).options ?? [];
      for (const shape of spec.json_flags) {
        assert.ok(options.includes(shape.flag.replace(/^--/, "")), `workflow ${verb} --explain advertises ${shape.flag}, which the verb does not accept`);
      }
      for (const referenced of spec.referenced_shapes) {
        assert.ok(!options.includes(referenced.shape.flag.replace(/^--/, "")), `${referenced.shape.flag} is an accepted flag on ${verb} and must be explained as one, not as a nested shape`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every evidence-ref example --explain prints is accepted by the shipped validator", () => {
  // The load-bearing promise of #1358: "one filled example that would actually be accepted".
  assert.ok(evidenceRefShape.examples.length > 0, "--explain prints no evidence-ref examples");
  for (const example of evidenceRefShape.examples) {
    assert.doesNotThrow(() => validateEvidenceRef({ ...example }, "refs"), `--explain prints an example the validator refuses: ${JSON.stringify(example)}`);
  }
  // …and end to end through the real CLI, nested where callers actually put them.
  for (const example of evidenceRefShape.examples) {
    assert.ok(laneAccepted({ ...VALID_LANE, evidence_refs: [example] }), `the CLI refuses an evidence ref --explain advertises: ${JSON.stringify(example)}`);
  }
});

test("every field --explain lists as accepted is accepted by the shipped validator", () => {
  // THE INJECTION TARGET. Adding a field to the printed list that the validator does not know
  // (the live run burned an invocation discovering `path` is spelled `file`) reddens here.
  for (const field of evidenceRefShape.fields) {
    if (field === "kind") continue;
    const ref = { kind: "command", summary: "ran the suite", [field]: valueForField(field) };
    assert.doesNotThrow(() => validateEvidenceRef({ ...ref }, "refs"), `--explain lists ${field} as an accepted field, but the validator refuses it`);
    assert.ok(laneAccepted({ ...VALID_LANE, evidence_refs: [ref] }), `--explain lists ${field} as an accepted field, but the CLI refuses it`);
  }
});

test("every kind --explain lists is accepted, and no other kind is", () => {
  const printedKinds = [...new Set(printedClauses().map((clause) => clause.kind))];
  assert.ok(printedKinds.length > 0, "--explain prints no per-kind rules");
  for (const kind of printedKinds) {
    assert.doesNotThrow(() => validateEvidenceRef({ ...exampleFor(kind) }, "refs"), `--explain lists kind ${kind}, which the validator refuses`);
  }
  const kindRule = evidenceRefShape.rules.find((rule) => rule.startsWith("kind must be one of: "));
  assert.ok(kindRule, "--explain does not print the accepted kind vocabulary");
  assert.deepEqual([...kindRule.slice("kind must be one of: ".length).split(", ")].sort(), [...printedKinds].sort(), "the printed kind vocabulary and the printed per-kind rules disagree");
  assert.throws(() => validateEvidenceRef({ kind: "screenshot", summary: "x" }, "refs"), /kind must be one of/, "a kind outside the printed vocabulary must still be refused");
});

test("every clause --explain prints is enforced, and the refusal quotes it verbatim", () => {
  // Direction: explain → enforcement. Provoke each printed clause and require the refusal text to
  // CONTAIN the printed clause byte-for-byte. A paraphrase on either side fails here, which is
  // what makes the printed rules usable as a contract rather than as documentation.
  for (const clause of printedClauses()) {
    const broken = { ...exampleFor(clause.kind) };
    const dropped = clause.mode === "all" ? [clause.fields.at(-1)] : clause.fields;
    for (const field of dropped) delete broken[field];
    let message = null;
    try { validateEvidenceRef(broken, "refs"); } catch (error) { message = error.message; }
    assert.ok(message !== null, `--explain prints "${clause.rule}" but the validator accepted a ref violating it: ${JSON.stringify(broken)}`);
    assert.ok(message.includes(clause.rule), `the refusal does not quote the printed clause "${clause.rule}"; it said: ${message}`);
  }
});

test("every lane field --explain lists is accepted, and an unlisted one is refused by name", () => {
  const lane = {};
  for (const field of laneShape.fields) lane[field] = VALID_LANE[field];
  assert.ok(laneAccepted(lane), `--explain lists lane fields ${laneShape.fields.join(", ")}, but a lane carrying exactly those is refused`);
  const output = laneRefusal({ ...VALID_LANE, unlisted_field: 1 });
  assert.match(output, /unsupported fields: unlisted_field/, "a field outside the printed lane list must be refused, naming it");
});

test("the lane id grammar and status vocabulary --explain prints are the ones enforced", () => {
  const idRule = laneShape.rules.find((rule) => rule.includes("safe identifier matching "));
  assert.ok(idRule, "--explain does not print the lane id grammar");
  const pattern = new RegExp(idRule.slice(idRule.indexOf("matching ") + "matching ".length));
  assert.ok(pattern.test(VALID_LANE.id), "the fixture lane id does not satisfy the printed grammar");
  assert.ok(!pattern.test("Bad Lane"), "the printed grammar accepts an id the validator refuses");
  assert.match(laneRefusal({ ...VALID_LANE, id: "Bad Lane" }), /id must be a unique safe identifier/);

  const statusRule = laneShape.rules.find((rule) => rule.startsWith("status must be one of: "));
  assert.ok(statusRule, "--explain does not print the lane status vocabulary");
  for (const status of statusRule.slice("status must be one of: ".length).split(", ")) {
    assert.ok(laneAccepted({ ...VALID_LANE, status }), `--explain lists lane status ${status}, which the CLI refuses`);
  }
  assert.match(laneRefusal({ ...VALID_LANE, status: "met" }), /status must be one of/);
});

test("the criterion shape --explain prints matches what completePassingCriteria enforces", () => {
  // Criterion enforcement lives behind a full gate-claim, which this test does not stand up; the
  // binding asserted here is between the printed shape and the source of the rules it is derived
  // from, plus the example's own refs going through the real evidence-ref validator.
  const source = fs.readFileSync(path.join(__dirname, "workflow-sidecar.ts"), "utf8");
  assert.match(source, /criterionShapeViolations\(criterion, labels\[index\]!\)/, "completePassingCriteria no longer enforces the criterion shape through the shared collector — --explain can now drift from it");
  assert.equal(criterionShape.examples.length, 1);
  const [example] = criterionShape.examples;
  assert.deepEqual(Object.keys(example).sort(), [...criterionShape.fields].sort(), "the printed criterion example does not use exactly the printed fields");
  const statusRule = criterionShape.rules.find((rule) => rule.startsWith("status must be "));
  assert.ok(statusRule?.endsWith(` for a passing tests-evidence claim`), "--explain does not print the criterion status requirement");
  assert.equal(example.status, statusRule.slice("status must be ".length).replace(" for a passing tests-evidence claim", ""), "the printed example's status is not the status --explain says is required");
  for (const ref of example.evidence_refs) assert.doesNotThrow(() => validateEvidenceRef({ ...ref }, "refs"), "the printed criterion example embeds an evidence ref the validator refuses");
});

test("the shared validators are the only rule source — no hand-written rule can outrun --explain", () => {
  // A rule written inline in the sidecar is a rule --explain cannot know about, so the data
  // comparisons above would pass while the caller still hits an unadvertised refusal. Asserted at
  // the source level for the same reason workflow-help.test.mjs asserts its enforcement anchor
  // there: it fails on the edit that reintroduces the divergence, not months later.
  const source = fs.readFileSync(path.join(__dirname, "workflow-sidecar.ts"), "utf8");
  const body = /export function validateEvidenceRef\([\s\S]*?\n}/.exec(source);
  assert.ok(body, "validateEvidenceRef not found — the enforcement anchor moved");
  assert.match(body[0], /dieOnViolations\(evidenceRefShapeViolations\(ref, label\)\)/, "validateEvidenceRef no longer derives its shape rules from the shared collector");
  assert.equal((body[0].match(/\bdie\(/g) ?? []).length, 0, "validateEvidenceRef carries a hand-written refusal that --explain cannot derive");
  const lanes = /function normalizeCritiqueLanes\([\s\S]*?\n}/.exec(source);
  assert.match(lanes[0], /critiqueLaneShapeViolations\(lane, index\)/, "normalizeCritiqueLanes no longer derives its shape rules from the shared collector");
});

test("one payload with N faults produces ONE refusal naming all N (#1359)", () => {
  // The measured defect: five sequential invocations to land one lane. The refusal must now carry
  // every problem, each tagged with the object index and the field.
  const output = laneRefusal({ id: "Bad Lane", status: "met", summary: "", evidence_refs: "nope", extra: 1 });
  for (const expected of [
    /--lane-json 0 contains unsupported fields: extra/,
    /--lane-json 0 id must be a unique safe identifier/,
    /--lane-json 0 status must be one of/,
    /--lane-json 0 summary must be non-empty/,
    /--lane-json 0 evidence_refs must be an array/,
  ]) {
    assert.match(output, expected, "the refusal dropped a problem — callers are back to one fact per invocation");
  }
  assert.match(output, /5 problems must be fixed together/);
});

test("evidence-ref violations are reported per entry index, across every entry", () => {
  const output = laneRefusal({
    ...VALID_LANE,
    evidence_refs: [{ kind: "sorce", path: "src/a.ts" }, { kind: "source", file: "src/a.ts" }],
  });
  assert.match(output, /evidence_refs\[0\] entry kind must be one of/);
  assert.match(output, /evidence_refs\[0\] entries contain unsupported field: path/);
  assert.match(output, /evidence_refs\[1\] source refs require file, line_start, line_end, and excerpt/, "a fault in the SECOND entry must be reported in the same refusal as the first");
});

test("--explain performs no mutation, exits 0, and agrees with --explain --json", () => {
  for (const verb of ["evidence", "critique", "publish-delivery"]) {
    const dir = makeFixtureDir("wf-explain-");
    try {
      const prose = spawnSync(process.execPath, [CLI, "workflow", verb, "--explain"], { cwd: dir, encoding: "utf8" });
      assert.equal(prose.status, 0, `workflow ${verb} --explain exited ${prose.status}: ${prose.stderr}`);
      assert.ok(!/does not resolve|is required|requires --/.test(prose.stderr), `verb precondition ran on an --explain request: ${prose.stderr}`);
      assert.deepEqual(fs.readdirSync(dir), [], `workflow ${verb} --explain wrote into the working directory`);
      const json = spawnSync(process.execPath, [CLI, "workflow", verb, "--explain", "--json"], { cwd: dir, encoding: "utf8" });
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), explainSpec(verb), "--explain --json diverges from the derived spec");
      for (const shape of explainSpec(verb).json_flags) {
        assert.ok(prose.stdout.includes(shape.flag), `prose --explain omits ${shape.flag}`);
        for (const rule of shape.rules) assert.ok(prose.stdout.includes(rule), `prose --explain omits the rule "${rule}"`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
