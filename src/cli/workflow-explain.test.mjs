// Drift test binding `workflow <verb> --explain` (#1358) to the validators that actually refuse,
// and asserting the one-pass refusal contract (#1359). Run: `npm run test:unit`.
//
// ROUND 1 KILLED THIS FILE'S ORIGINAL GUARD AND IT DESERVED IT. The old version asserted that
// `validateEvidenceRef`'s body contained no `die(` — a guard scoped to ONE function, while the
// rules live a module away in public-contracts.ts. The reviewer added a live rule there; build
// exit=0, 12/12 green, rule enforced, `--explain` silent. A source-text assertion about one
// function cannot see a rule that moved one function over.
//
// The guard is now SET-EQUALITY OVER EMITTED OUTPUT: a generated corpus of malformed payloads is
// pushed through the real collectors, every refusal is canonicalized to its body, and the set of
// bodies the collectors CAN emit must equal the set `--explain` prints. That assertion has no
// notion of which function a rule lives in, so moving a rule cannot evade it — an unprinted rule
// appears in `observed \ printed`, and a fictional printed rule appears in `printed \ observed`.
//
// The other assertions run in the direction that matters: everything `--explain` prints as
// accepted is fed to the REAL CLI and must be accepted, including criterion examples through the
// CRITERION path (round 1: the printed criterion example was refused by the rule printed two
// lines above it — #1358's own defect, inside the fix for #1358).
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
const contracts = await import(path.resolve(__dirname, "../../build/src/cli/public-contracts.js"));
const {
  criterionShapeViolations, critiqueLaneShapeViolations, evidenceRefListShapeViolations,
  commandTextFromEvidenceRef, refusalBody, publicJsonFlagShapes,
  EVIDENCE_REF_KINDS, EVIDENCE_REF_FIELDS, CRITERION_COMMAND_MATCH_FIELDS, exampleEvidenceRef,
} = contracts;

const EVIDENCE_SPEC = explainSpec("evidence");
const CRITIQUE_SPEC = explainSpec("critique");
const shapes = publicJsonFlagShapes();
const evidenceRefShape = shapes["evidence-ref-json"];
const criterionShape = shapes["criterion-json"];
const laneShape = shapes["lane-json"];

const VALID_LANE = { id: "correctness", status: "pass", summary: "reviewed", evidence_refs: [{ kind: "command", summary: "ran the suite" }] };
const printedBodies = (shape) => new Set(shape.rules.filter((rule) => rule.enforced_by === "object-shape").map((rule) => rule.body));

/** Drive the shipped record-critique path far enough to exercise lane + evidence-ref validation. */
function laneRefusal(lane, extra = []) {
  const root = makeFixtureDir("wf-explain-");
  const dir = path.join(root, ".kontourai", "flow-agents", "demo");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const lanes = [lane, ...extra].flatMap((value) => ["--lane-json", JSON.stringify(value)]);
    const result = spawnSync(process.execPath, [SIDECAR, "record-critique", dir, "--verdict", "pass", "--summary", "s", ...lanes], { cwd: root, encoding: "utf8" });
    return `${result.stdout}${result.stderr}`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const laneAccepted = (lane) => !/--lane-json/.test(laneRefusal(lane));

// ── the corpus ────────────────────────────────────────────────────────────────────────────────
// Systematic, not random: for every kind (plus an unknown one) and every declared field, produce
// the absent / wrong-typed / empty / extra variants, plus the non-object and non-array entries.
// Generation is driven by the CONSTANTS, so a newly declared field or kind is covered the day it
// is added rather than the day someone remembers to extend a hand-written list.
function evidenceRefCorpus() {
  const bad = [0, -1, "", null, {}, [], true];
  const refs = [];
  for (const kind of [...EVIDENCE_REF_KINDS, "not-a-kind", undefined]) {
    const base = EVIDENCE_REF_KINDS.includes(kind) ? exampleEvidenceRef(kind) : { kind };
    refs.push({ ...base });
    refs.push({ ...base, unsupported_field: 1 });
    for (const field of EVIDENCE_REF_FIELDS) {
      const dropped = { ...base }; delete dropped[field]; refs.push(dropped);
      for (const value of bad) refs.push({ ...base, [field]: value });
    }
  }
  return refs;
}
const NON_OBJECT_ENTRIES = ["legacy-string-ref.md", 1, null, true, ["nested"]];

/** Every body the evidence-ref collectors emit over the corpus, in canonical form. */
function observedEvidenceRefBodies() {
  const label = "REFS";
  const bodies = new Set();
  const record = (messages) => {
    for (const message of messages) bodies.add(refusalBody(message.replace(/^REFS\[\d+\] /, "REFS "), label));
  };
  record(evidenceRefListShapeViolations("not-an-array", label));
  record(evidenceRefListShapeViolations({ nope: true }, label));
  record(evidenceRefListShapeViolations(NON_OBJECT_ENTRIES, label));
  for (const ref of evidenceRefCorpus()) record(evidenceRefListShapeViolations([ref], label));
  return bodies;
}

/** Bodies emitted at the OWNING object's level, with nested evidence-ref bodies partitioned out. */
function partitionNested(messages, ownLabel, nestedPrefix) {
  const own = new Set(); const nested = new Set();
  for (const message of messages) {
    if (message.startsWith(nestedPrefix)) nested.add(refusalBody(message.replace(/evidence_refs\[\d+\] /, "evidence_refs "), nestedPrefix));
    else own.add(refusalBody(message, ownLabel));
  }
  return { own, nested };
}

test("the rule tables are pinned, so deleting a rule from BOTH sides still reddens", () => {
  // Set-equality alone cannot see a rule removed from the collector AND the table together — the
  // loop just runs one fewer time (the deletion-invisible-to-a-non-emptiness-check trap). Pin the
  // counts independently. Raising these is a deliberate act with a diff to justify it.
  assert.equal(printedBodies(evidenceRefShape).size, 17, "evidence-ref object-shape rule count changed");
  assert.equal(printedBodies(criterionShape).size, 3, "criterion object-shape rule count changed");
  assert.equal(printedBodies(laneShape).size, 5, "lane object-shape rule count changed");
  assert.equal(observedEvidenceRefBodies().size, 17, "the corpus stopped provoking every evidence-ref rule — it lost discriminating power");
});

test("SET-EQUALITY: the bodies the evidence-ref collectors emit are exactly the bodies --explain prints", () => {
  // The guard round 1 defeated, rebuilt over OUTPUT instead of source text. A rule added anywhere
  // — this module, public-contracts, a helper three calls down — shows up here the moment the
  // corpus provokes it, because nothing in this assertion knows where rules live.
  const observed = observedEvidenceRefBodies();
  const printed = printedBodies(evidenceRefShape);
  const unprinted = [...observed].filter((body) => !printed.has(body)).sort();
  const unemitted = [...printed].filter((body) => !observed.has(body)).sort();
  assert.deepEqual(unprinted, [], `the collectors emit rules --explain never prints:\n  ${unprinted.join("\n  ")}`);
  assert.deepEqual(unemitted, [], `--explain prints rules the collectors never emit:\n  ${unemitted.join("\n  ")}`);
});

test("SET-EQUALITY: criterion and lane collectors emit exactly the bodies --explain prints", () => {
  const evidenceRefPrinted = printedBodies(evidenceRefShape);

  const criterionObserved = new Set(); const criterionNested = new Set();
  for (const refs of [undefined, "nope", [], NON_OBJECT_ENTRIES, evidenceRefCorpus()]) {
    for (const criterion of [{ id: "ac", status: "pass", evidence_refs: refs }, { id: "ac", status: "met", evidence_refs: refs, extra: 1 }, {}]) {
      const { own, nested } = partitionNested(criterionShapeViolations(criterion, "ID"), "criterion ID", "criterion ID evidence_refs");
      own.forEach((b) => criterionObserved.add(b)); nested.forEach((b) => criterionNested.add(b));
    }
  }
  const criterionPrinted = printedBodies(criterionShape);
  assert.deepEqual([...criterionObserved].filter((b) => !criterionPrinted.has(b)).sort(), [], "criterion collector emits bodies --explain never prints");
  assert.deepEqual([...criterionPrinted].filter((b) => !criterionObserved.has(b)).sort(), [], "--explain prints criterion bodies the collector never emits");
  assert.deepEqual([...criterionNested].filter((b) => !evidenceRefPrinted.has(b)).sort(), [], "criterion's nested evidence_refs emit bodies the evidence-ref rules never print");

  const laneObserved = new Set(); const laneNested = new Set();
  for (const refs of [undefined, "nope", [], NON_OBJECT_ENTRIES, evidenceRefCorpus()]) {
    for (const lane of [{ ...VALID_LANE, evidence_refs: refs }, { id: "Bad Lane", status: "met", summary: "", evidence_refs: refs, extra: 1 }, {}]) {
      const { own, nested } = partitionNested(critiqueLaneShapeViolations(lane, 0), "--lane-json 0", "--lane-json 0 evidence_refs");
      own.forEach((b) => laneObserved.add(b)); nested.forEach((b) => laneNested.add(b));
    }
  }
  const lanePrinted = printedBodies(laneShape);
  assert.deepEqual([...laneObserved].filter((b) => !lanePrinted.has(b)).sort(), [], "lane collector emits bodies --explain never prints");
  assert.deepEqual([...lanePrinted].filter((b) => !laneObserved.has(b)).sort(), [], "--explain prints lane bodies the collector never emits");
  assert.deepEqual([...laneNested].filter((b) => !evidenceRefPrinted.has(b)).sort(), [], "lane's nested evidence_refs emit bodies the evidence-ref rules never print");
});

test("the printed body is what the refusal actually says, byte for byte", () => {
  // Round 1: the old header claimed "refused verbatim" and was false for 9 of 26, because the
  // byte-identity assertion only parsed /^(\w+) refs require (.+)$/ — the subset where it held.
  // Every object-shape body is now checked, through the real CLI, prefix included.
  const output = laneRefusal({ id: "Bad Lane", status: "met", summary: "", evidence_refs: [{ kind: "sorce", nope: 1 }], extra: 1 });
  for (const body of printedBodies(laneShape)) {
    if (body.includes("<value>")) {
      assert.ok(output.includes(body.split("<value>")[0]), `refusal does not quote the printed body "${body}"`);
      continue;
    }
    if (body.includes("requires structured reviewable")) continue; // provoked by an EMPTY array, below
    assert.ok(output.includes(`--lane-json 0 ${body}`), `refusal is not "<label> <body>" for "${body}"; output was:\n${output}`);
  }
  const empty = laneRefusal({ ...VALID_LANE, evidence_refs: [] });
  assert.ok(empty.includes("--lane-json 0 requires structured reviewable evidence_refs"));
});

test("cross-object and observed-command rules are enforced, not merely printed", () => {
  // These cannot be reached from a single object, so the corpus cannot provoke them; each is
  // probed or bound explicitly rather than trusted.
  const duplicate = laneShape.rules.find((rule) => rule.enforced_by === "cross-object");
  assert.ok(duplicate, "lane rules declare no cross-object rule");
  assert.ok(laneRefusal(VALID_LANE, [{ ...VALID_LANE }]).includes(duplicate.body), `the printed cross-object rule "${duplicate.body}" is not enforced`);

  // The criterion-level cross-object and observed-command rules need a full gate-claim session,
  // which this test does not stand up. They are bound to the emitting source by byte-equality, so
  // a reworded refusal reddens here even though it is not executed. DISCLOSED as not-executed.
  const source = fs.readFileSync(path.join(__dirname, "workflow-sidecar.ts"), "utf8");
  for (const rule of criterionShape.rules.filter((entry) => entry.enforced_by !== "object-shape")) {
    assert.ok(source.includes(rule.body), `--explain prints "${rule.body}" but no refusal in workflow-sidecar.ts emits that text`);
  }
});

test("--explain names only JSON flags the verb's own enforcing option set accepts", () => {
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
        assert.ok(!options.includes(referenced.shape.flag.replace(/^--/, "")), `${referenced.shape.flag} is an accepted flag on ${verb} and must be explained as one`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every printed example is accepted — including criterion examples through the CRITERION path", () => {
  // ROUND 1'S MEDIUM, and the reason this test exists in this shape: the old version fed the
  // embedded ref only to validateEvidenceRef (shape), so an example that the criterion's
  // observed-command matcher refuses looked fine. The criterion example is now checked against
  // the matcher that actually reads it.
  for (const example of evidenceRefShape.examples) {
    assert.doesNotThrow(() => validateEvidenceRef({ ...example }, "refs"), `--explain prints an example the validator refuses: ${JSON.stringify(example)}`);
    assert.ok(laneAccepted({ ...VALID_LANE, evidence_refs: [example] }), `the CLI refuses an evidence ref --explain advertises: ${JSON.stringify(example)}`);
  }
  for (const example of criterionShape.examples) {
    assert.deepEqual(criterionShapeViolations({ ...example }, "ac-1"), [], `--explain prints a criterion example the criterion collector refuses: ${JSON.stringify(example)}`);
    // The criterion path matches an OBSERVED command against the ref; the example must carry its
    // command where the matcher looks, or a caller substituting the placeholder is still refused.
    for (const ref of example.evidence_refs.filter((entry) => entry.kind === "command")) {
      const observed = "npx vitest run src/example.test.ts";
      const substituted = { ...ref, [CRITERION_COMMAND_MATCH_FIELDS[0]]: observed };
      assert.equal(commandTextFromEvidenceRef(substituted), observed,
        `substituting the placeholder in the printed criterion example does not produce a matchable command: ${JSON.stringify(ref)}`);
      assert.notEqual(commandTextFromEvidenceRef(ref), "", `the printed criterion example carries no command text the matcher can read: ${JSON.stringify(ref)}`);
    }
  }
  for (const example of laneShape.examples) assert.ok(laneAccepted(example), `the CLI refuses a lane --explain advertises: ${JSON.stringify(example)}`);
});

test("every field --explain lists as accepted is accepted by the shipped validator", () => {
  for (const field of evidenceRefShape.fields) {
    if (field === "kind") continue;
    const rule = evidenceRefShape.rules.find((entry) => entry.body.startsWith(`entry ${field} must be `));
    const value = rule?.body.endsWith("a positive integer") ? 1 : "placeholder";
    const ref = { kind: "command", summary: "ran the suite", [field]: value };
    assert.doesNotThrow(() => validateEvidenceRef({ ...ref }, "refs"), `--explain lists ${field} as accepted, but the validator refuses it`);
    assert.ok(laneAccepted({ ...VALID_LANE, evidence_refs: [ref] }), `--explain lists ${field} as accepted, but the CLI refuses it`);
  }
});

test("every kind --explain lists is accepted, and no other kind is", () => {
  const kindRule = evidenceRefShape.rules.find((rule) => rule.body.startsWith("entry kind must be one of: "));
  assert.ok(kindRule, "--explain does not print the accepted kind vocabulary");
  const printedKinds = kindRule.body.slice("entry kind must be one of: ".length).split(", ");
  const clauseKinds = [...new Set(evidenceRefShape.rules.map((rule) => /^(\w+) refs require /.exec(rule.body)?.[1]).filter(Boolean))];
  assert.deepEqual([...printedKinds].sort(), [...clauseKinds].sort(), "the printed kind vocabulary and the printed per-kind rules disagree");
  for (const kind of printedKinds) {
    assert.doesNotThrow(() => validateEvidenceRef({ ...exampleEvidenceRef(kind) }, "refs"), `--explain lists kind ${kind}, which the validator refuses`);
  }
  assert.throws(() => validateEvidenceRef({ kind: "screenshot", summary: "x" }, "refs"), /kind must be one of/);
});

test("every per-kind clause --explain prints is enforced, and the refusal quotes it verbatim", () => {
  // Which fields to drop is parsed out of the PRINTED TEXT ("and" = all, "or" = any), not read
  // back from the constant the renderer used.
  for (const rule of evidenceRefShape.rules) {
    const match = /^(\w+) refs require (.+)$/.exec(rule.body);
    if (!match) continue;
    const [, kind, clause] = match;
    const fields = clause.replace(/,? (?:and|or) /g, ", ").split(", ").filter(Boolean);
    const broken = { ...exampleEvidenceRef(kind) };
    for (const field of clause.includes(" and ") ? [fields.at(-1)] : fields) delete broken[field];
    let message = null;
    try { validateEvidenceRef(broken, "refs"); } catch (error) { message = error.message; }
    assert.ok(message !== null, `--explain prints "${rule.body}" but the validator accepted a ref violating it`);
    assert.ok(message.includes(rule.body), `the refusal does not quote the printed clause "${rule.body}"; it said: ${message}`);
  }
});

test("the lane id grammar and status vocabulary --explain prints are the ones enforced", () => {
  const idRule = laneShape.rules.find((rule) => rule.body.includes("safe identifier matching "));
  const pattern = new RegExp(idRule.body.slice(idRule.body.indexOf("matching ") + "matching ".length));
  assert.ok(pattern.test(VALID_LANE.id) && !pattern.test("Bad Lane"), "the printed grammar disagrees with the enforced one");
  assert.match(laneRefusal({ ...VALID_LANE, id: "Bad Lane" }), /id must be a unique safe identifier/);
  const statusRule = laneShape.rules.find((rule) => rule.body.startsWith("status must be one of: "));
  for (const status of statusRule.body.slice("status must be one of: ".length).split(", ")) {
    assert.ok(laneAccepted({ ...VALID_LANE, status }), `--explain lists lane status ${status}, which the CLI refuses`);
  }
  assert.match(laneRefusal({ ...VALID_LANE, status: "met" }), /status must be one of/);
});

test("one payload with N faults produces ONE refusal naming all N (#1359)", () => {
  const output = laneRefusal({ id: "Bad Lane", status: "met", summary: "", evidence_refs: "nope", extra: 1 });
  for (const expected of [
    /--lane-json 0 contains unsupported fields: extra/,
    /--lane-json 0 id must be a unique safe identifier/,
    /--lane-json 0 status must be one of/,
    /--lane-json 0 summary must be non-empty/,
    /--lane-json 0 evidence_refs must be an array/,
  ]) assert.match(output, expected, "the refusal dropped a problem — callers are back to one fact per invocation");
  assert.match(output, /5 problems must be fixed together/);
});

test("evidence-ref violations are reported per entry index, across every entry", () => {
  const output = laneRefusal({ ...VALID_LANE, evidence_refs: [{ kind: "sorce", path: "src/a.ts" }, { kind: "source", file: "src/a.ts" }] });
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
        for (const rule of shape.rules) assert.ok(prose.stdout.includes(rule.body), `prose --explain omits the rule "${rule.body}"`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
