// Thin TypeScript-layer unit tests for the PURE helpers in workflow-sidecar (ops#22).
//
// Until now the ~1,924 assertions covering this module were all black-box bash that
// drove the CLI. These tests exercise the pure, side-effect-free helpers directly
// against the built JS — fast, deterministic, and isolating logic from fs/CLI. They
// complement (do not replace) the bash evals.
//
// Run: `npm run test:unit` (builds first). Requires `npm run build` output under build/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deriveGateCalibration,
  gateAdvisoryFix,
  buildGateInquiryRecords,
  isNarrativeNamespacePath,
  isNarrativeArtifactContent,
  validateEvidenceRef,
  normalizeEvidenceRefs,
  normalizeCheck,
  normalizeFinding,
  normalizeLearning,
  reduceCaptureLogByCommand,
} from "../../build/src/cli/workflow-sidecar.js";

// ── explainClaim (#171: consumed from @kontourai/surface >=2.10) ─────────────
// The local buildClaimExplanation prototype was lifted into Surface (surface#151)
// with the drilldown composition folded inside; these tests pin the consumed
// function's behavior through the SAME expectations the prototype carried, so a
// Surface regression (or an accidental un-lift) fails here.
import { explainClaim, buildTrustReport, TrustBundleBuilder } from "@kontourai/surface";

test("explainClaim (Surface): unknown claim id returns found:false sentinel", () => {
  const report = buildTrustReport(new TrustBundleBuilder({ source: "unit:171" }).build());
  const out = explainClaim(report, "missing");
  assert.equal(out.found, false);
  assert.equal(out.status, "unknown");
  assert.deepEqual(out.evidence, []);
  assert.equal(out.policy, null);
});

test("explainClaim (Surface): projects status, policy, evidence, and filtered gaps for a found claim", () => {
  const builder = new TrustBundleBuilder({ source: "unit:171" });
  builder.addClaim({
    id: "c1", subjectType: "repo", subjectId: "flow-agents", claimType: "workflow.check",
    fieldOrBehavior: "unit-tests", value: "pass", verificationPolicyId: "p1",
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
  });
  builder.addPolicy({
    id: "p1", claimType: "workflow.check", requiredEvidence: ["test_output"], requiredMethods: ["validation"],
    acceptanceCriteria: ["AC1"], reviewAuthority: "owner", validityRule: { kind: "manual" },
    stalenessTriggers: [], conflictRules: [], impactLevel: "high",
  });
  builder.addEvidence({
    id: "e1", claimId: "c1", evidenceType: "test_output", method: "validation",
    sourceRef: "run:e1", excerptOrSummary: "npm test", observedAt: "2026-07-14T00:00:00.000Z",
    collectedBy: "ci", execution: { runner: "bash", label: "npm test", exitCode: 0 },
  });
  const out = explainClaim(buildTrustReport(builder.build()), "c1");
  assert.equal(out.found, true);
  assert.equal(out.status, "proposed");               // derived by the report (no verifying event), projected verbatim
  assert.equal(out.value, "pass");                    // String coercion of the claim value
  assert.equal(out.claimType, "workflow.check");
  assert.equal(out.policy.id, "p1");
  assert.deepEqual(out.policy.requiredEvidence, ["test_output"]);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].passing, true);        // exitCode 0 → not error → passing
  assert.equal(out.evidence[0].execution.exitCode, 0);
  // Gap filtering: only THIS claim's transparency gaps appear (none seeded for c1,
  // and a report-level gap for another claim must not leak in).
  assert.deepEqual(out.why.transparencyGaps.filter((gap) => gap.claimId !== "c1"), []);
});

test("explainClaim (Surface): legacy evidence label/summary fallback tolerance survives the lift", () => {
  // Pre-lift bundles could carry top-level label/summary on evidence; the consumed
  // function keeps the prototype's fallback chains (label ?? excerptOrSummary ?? ...).
  const builder = new TrustBundleBuilder({ source: "unit:171-legacy" });
  builder.addClaim({
    id: "c2", subjectType: "repo", subjectId: "flow-agents", claimType: "workflow.check",
    fieldOrBehavior: "legacy", value: "pass",
    createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z",
  });
  builder.addEvidence({
    id: "e2", claimId: "c2", evidenceType: "attestation", method: "attestation",
    sourceRef: "run:e2", excerptOrSummary: "excerpt-wins-for-summary", observedAt: "2026-07-14T00:00:00.000Z",
    collectedBy: "ci",
  });
  const out = explainClaim(buildTrustReport(builder.build()), "c2");
  assert.equal(out.found, true);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].label, "excerpt-wins-for-summary");   // label falls back to excerptOrSummary
  assert.equal(out.evidence[0].summary, "excerpt-wins-for-summary"); // summary prefers excerptOrSummary
  assert.equal(out.evidence[0].execution, null);
  assert.equal(out.evidence[0].passing, true);                       // no execution, not disputed → passing
});

// ── deriveGateCalibration (pure mapping) ─────────────────────────────────────

test("deriveGateCalibration: maps outcome/status/blocked to a calibration verdict", () => {
  assert.equal(deriveGateCalibration("unsupported", undefined, true), "missed_block");
  assert.equal(deriveGateCalibration("matched", "disputed", true), "correct");
  assert.equal(deriveGateCalibration("matched", "rejected", true), "correct");
  assert.equal(deriveGateCalibration("matched", "verified", true), "false_block");
  assert.equal(deriveGateCalibration("matched", "stale", true), "false_block"); // blocked w/o solid evidence
  assert.equal(deriveGateCalibration("matched", "stale", false), "missed_block");
  assert.equal(deriveGateCalibration("matched", "verified", false), "correct");
  assert.equal(deriveGateCalibration("derived", "proposed", false), "missed_block");
});

// ── gateAdvisoryFix (pure string composition) ────────────────────────────────

test("gateAdvisoryFix: composes calibration-specific guidance naming the claim", () => {
  assert.match(gateAdvisoryFix("correct", "c1", "disputed"), /No gate change needed/);
  assert.match(gateAdvisoryFix("correct", "c1", "disputed"), /`c1`/);
  assert.match(gateAdvisoryFix("false_block", "c1", "verified"), /Investigate why the gate blocked/);
  assert.match(gateAdvisoryFix("missed_block", "c1", "stale"), /Refresh the stale claim/);
  assert.match(gateAdvisoryFix("missed_block", "c1", "absent"), /writes a bundle claim/);
});

// ── validateEvidenceRef / normalizeEvidenceRefs (pure validators) ────────────

test("validateEvidenceRef: accepts a well-formed source ref", () => {
  const ref = { kind: "source", file: "a.ts", line_start: 1, line_end: 2, excerpt: "x" };
  assert.deepEqual(validateEvidenceRef({ ...ref }, "refs"), ref);
});

test("validateEvidenceRef: rejects bad kind, unsupported field, and incomplete source ref", () => {
  assert.throws(() => validateEvidenceRef({ kind: "nope" }, "refs"), /kind must be one of/);
  assert.throws(() => validateEvidenceRef({ kind: "command", bogus: 1, summary: "s" }, "refs"), /unsupported field/);
  assert.throws(() => validateEvidenceRef({ kind: "source", file: "a.ts" }, "refs"), /source refs require/);
});

test("narrative namespace paths and free-form references are rejected with the typed #619 diagnostic", () => {
  const root = "/tmp/project";
  assert.equal(isNarrativeNamespacePath(root, "/tmp/project/.kontourai/narrative/run/n1/envelope.json"), true);
  assert.equal(isNarrativeNamespacePath(root, "/tmp/project/.kontourai/flow-agents/run/narrative/legacy.md"), true);
  assert.equal(isNarrativeNamespacePath(root, "/tmp/project/docs/narrative/design.md"), false);
  for (const ref of [
    { kind: "source", file: "src/file.ts", line_start: 1, line_end: 1, excerpt: "see .kontourai/narrative/run/n1/envelope.json" },
    { kind: "artifact", file: ".kontourai/narrative/run/n1/envelope.json", summary: "rendered narrative" },
    { kind: "command", excerpt: "cat .kontourai/flow-agents/run/narrative/envelope.md" },
    { kind: "provider", url: "file:///.kontourai/narrative/run/n1/envelope.json" },
    { kind: "external", url: "https://example.invalid/.kontourai/narrative/run/n1/envelope.json" },
  ]) {
    assert.throws(() => validateEvidenceRef(ref, "refs"), /narrative trust isolation \(#619\)/);
  }
});

test("narrative isolation canonicalizes aliases and rejects narrative content independent of location", { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-isolation-unit-"));
  const narrativeDir = path.join(root, ".kontourai", "narrative", "run", "n1");
  const envelope = path.join(narrativeDir, "envelope.json");
  const relocated = path.join(root, "evidence", "relocated.json");
  const hardlink = path.join(root, "evidence", "hardlink.json");
  const symlink = path.join(root, "evidence", "symlink.json");
  const commandSymlink = path.join(root, "evidence", "narrative-symlink.sh");
  const source = path.join(root, "src", "narrative", "composer.ts");
  fs.mkdirSync(narrativeDir, { recursive: true });
  fs.mkdirSync(path.dirname(relocated), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const bytes = Buffer.from('{"schema_version":"grounded-execution-narrative/v1","narrative_id":"n1"}');
  fs.writeFileSync(envelope, bytes);
  fs.copyFileSync(envelope, relocated);
  fs.linkSync(envelope, hardlink);
  fs.symlinkSync(envelope, symlink);
  fs.symlinkSync(envelope, commandSymlink);
  fs.writeFileSync(source, 'export const narrativeSource = true;\n');
  try {
    assert.equal(isNarrativeNamespacePath(root, path.join(root, ".KONTOURAI", "NARRATIVE", "run", "n1", "envelope.json")), true);
    assert.equal(isNarrativeArtifactContent(bytes), true);
    for (const file of [envelope, relocated, hardlink, symlink]) {
      assert.throws(
        () => validateEvidenceRef({ kind: "artifact", file, summary: "must reject" }, "refs", root),
        /narrative trust isolation \(#619\)/,
      );
    }
    assert.throws(
      () => validateEvidenceRef({ kind: "provider", url: "file%3A%2F%2F%2F.KONTOURAI%2FNARRATIVE%2Frun%2Fn1%2Fenvelope.json" }, "refs", root),
      /narrative trust isolation \(#619\)/,
    );
    assert.doesNotThrow(() => validateEvidenceRef({ kind: "source", file: source, line_start: 1, line_end: 1, excerpt: "source code" }, "refs", root));
    for (const command of [
      "test -f .kontourai/narrative/run/n1/envelope.json",
      "test -f .KONTOURAI/NARRATIVE/run/n1/envelope.json",
      "test -f .kontourai%2Fnarrative%2Frun%2Fn1%2Fenvelope.json",
      "bash evidence/narrative-symlink.sh",
    ]) {
      assert.throws(() => normalizeCheck({ id: "n", kind: "command", status: "pass", summary: "n", command }, false, undefined, root), /narrative trust isolation \(#619\)/);
    }
    assert.throws(() => normalizeFinding({ file_refs: [hardlink] }, root), /narrative trust isolation \(#619\)/);
    assert.throws(() => normalizeLearning({ source_refs: [relocated], facts: [], routing: [], outcome: "unknown", correction: { needed: false, evidence: "none" } }, "2026-07-14T00:00:00.000Z", root), /narrative trust isolation \(#619\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeEvidenceRefs: rejects non-arrays and legacy string refs; passes valid arrays", () => {
  assert.throws(() => normalizeEvidenceRefs("nope", "refs"), /must be an array/);
  assert.throws(() => normalizeEvidenceRefs(["legacy"], "refs"), /legacy string refs are not supported/);
  const ok = normalizeEvidenceRefs([{ kind: "command", summary: "ran tests" }], "refs");
  assert.equal(ok.length, 1);
  assert.equal(ok[0].kind, "command");
});

// ── normalizeCheck (pure path: no surface_trust_refs) ────────────────────────

test("normalizeCheck: validates required fields, kind, and status", () => {
  assert.throws(() => normalizeCheck({ id: "x" }), /requires id, kind, status/);
  assert.throws(() => normalizeCheck({ id: "x", kind: "bogus", status: "pass", summary: "s" }), /kind must be one of/);
  assert.throws(() => normalizeCheck({ id: "x", kind: "test", status: "bogus", summary: "s" }), /status must be one of/);
  const ok = normalizeCheck({ id: "x", kind: "test", status: "pass", summary: "ran" });
  assert.equal(ok.kind, "test");
  assert.equal(ok.status, "pass");
});

// ── reduceCaptureLogByCommand (#470 iteration 2, finding #2 — three-way capture fold) ────

test("reduceCaptureLogByCommand: a single ambiguous entry classifies as ambiguous (non-confirming), not pass", () => {
  const out = reduceCaptureLogByCommand([{ command: "npm test", observedResult: "ambiguous", exitCode: null }]);
  const entry = out.get("npm test");
  assert.equal(entry.observedResult, "ambiguous");
  assert.equal(entry.exitCode, null);
});

test("reduceCaptureLogByCommand: fail beats pass and ambiguous for the same command", () => {
  const out = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "pass", exitCode: 0 },
    { command: "npm test", observedResult: "ambiguous", exitCode: null },
    { command: "npm test", observedResult: "fail", exitCode: 1 },
  ]);
  const entry = out.get("npm test");
  assert.equal(entry.observedResult, "fail");
  assert.equal(entry.exitCode, 1);
});

test("reduceCaptureLogByCommand: fail beats pass and ambiguous regardless of entry order", () => {
  const out = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "fail", exitCode: 1 },
    { command: "npm test", observedResult: "pass", exitCode: 0 },
  ]);
  assert.equal(out.get("npm test").observedResult, "fail");
});

test("reduceCaptureLogByCommand: pass beats ambiguous when there is no fail", () => {
  const out = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "ambiguous", exitCode: null },
    { command: "npm test", observedResult: "pass", exitCode: 0 },
  ]);
  const entry = out.get("npm test");
  assert.equal(entry.observedResult, "pass");
  assert.equal(entry.exitCode, 0);
});

test("reduceCaptureLogByCommand: legacy entries (no observedResult) classify from exitCode alone", () => {
  const out = reduceCaptureLogByCommand([
    { command: "legacy-pass", exitCode: 0 },
    { command: "legacy-fail", exitCode: 1 },
    { command: "legacy-ambiguous", exitCode: null },
  ]);
  assert.equal(out.get("legacy-pass").observedResult, "pass");
  assert.equal(out.get("legacy-fail").observedResult, "fail");
  assert.equal(out.get("legacy-ambiguous").observedResult, "ambiguous");
});

test("reduceCaptureLogByCommand: legacy nonzero exit code classifies as fail (never coerced to pass)", () => {
  const out = reduceCaptureLogByCommand([{ command: "some cmd", exitCode: 2 }]);
  const entry = out.get("some cmd");
  assert.equal(entry.observedResult, "fail");
  assert.equal(entry.exitCode, 2);
});

test("reduceCaptureLogByCommand: grep/diff absence-ambiguous entry (observedResult:'ambiguous', exitCode:1) stays ambiguous, not fail", () => {
  const out = reduceCaptureLogByCommand([{ command: "grep -q needle file", observedResult: "ambiguous", exitCode: 1 }]);
  const entry = out.get("grep -q needle file");
  assert.equal(entry.observedResult, "ambiguous");
  assert.equal(entry.exitCode, 1);
});

// ── buildGateInquiryRecords (pure orchestration, fake Surface injected) ───────

test("buildGateInquiryRecords: resolves each claim through the injected Surface and tags calibration", () => {
  const fakeSurface = {
    resolveInquiry: (_bundle, inquiry, _opts) => ({
      id: inquiry.id,
      inquiry,
      outcome: "matched",
      resolutionPath: { claimIds: [inquiry.metadata.claimId] },
      inputSnapshot: {},
      statusFunctionVersion: "test",
      resolvedAt: "2026-01-01T00:00:00Z",
      answer: { status: "disputed" },
    }),
  };
  const bundle = {
    schemaVersion: 2,
    source: "s",
    claims: [{ id: "c1", subjectType: "workflow-check", subjectId: "slug/AC1", fieldOrBehavior: "AC1", status: "disputed" }],
    evidence: [], events: [], policies: [],
  };
  const records = buildGateInquiryRecords(
    bundle,
    { blocked: true, hash: "h", count: 1 },
    "slug",
    [],
    fakeSurface,
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "matched");
  // blocked + disputed → "correct" calibration in answer.value
  assert.equal(records[0].answer.value.calibration, "correct");
  assert.equal(records[0].answer.value.gateFired, true);
  assert.equal(records[0].answer.value.sessionSlug, "slug");
});

test("buildGateInquiryRecords: emits a single missed_block record for an empty bundle", () => {
  const fakeSurface = {
    resolveInquiry: (_bundle, inquiry, _opts) => ({
      id: inquiry.id,
      inquiry,
      outcome: "unsupported",
      resolutionPath: { claimIds: [] },
      inputSnapshot: {},
      statusFunctionVersion: "test",
      resolvedAt: "2026-01-01T00:00:00Z",
      answer: { status: "unknown" },
    }),
  };
  const bundle = { schemaVersion: 2, source: "s", claims: [], evidence: [], events: [], policies: [] };
  const records = buildGateInquiryRecords(bundle, { blocked: false, hash: null, count: 0 }, "slug", [], fakeSurface, new Date("2026-01-01T00:00:00Z"));
  assert.equal(records.length, 1);
  assert.equal(records[0].answer.value.calibration, "missed_block");
});

// ── #634: writer-observed execution entries in the capture fold ─────────────
test("writer-observed pass lifts an otherwise ambiguous command to pass", () => {
  const fold = reduceCaptureLogByCommand([
    { command: "npm run test:unit", observedResult: "ambiguous", exitCode: null, source: "postToolUse-capture" },
    { command: "npm run test:unit", observedResult: "pass", exitCode: 0, source: "canonical-writer-execution" },
  ]);
  assert.equal(fold.get("npm run test:unit").observedResult, "pass");
});

test("a hook-observed fail is never buried by a writer-observed pass, in either order", () => {
  for (const entries of [
    [
      { command: "npm run test:unit", observedResult: "fail", exitCode: 1, source: "postToolUse-capture" },
      { command: "npm run test:unit", observedResult: "pass", exitCode: 0, source: "canonical-writer-execution" },
    ],
    [
      { command: "npm run test:unit", observedResult: "pass", exitCode: 0, source: "canonical-writer-execution" },
      { command: "npm run test:unit", observedResult: "fail", exitCode: 1, source: "postToolUse-capture" },
    ],
  ]) {
    const fold = reduceCaptureLogByCommand(entries);
    assert.equal(fold.get("npm run test:unit").observedResult, "fail");
    // Review finding (#634): fail/0 would be contradictory evidence (isError:true, exitCode:0) —
    // the exit code must travel with the winning status, never a losing entry's.
    assert.equal(fold.get("npm run test:unit").exitCode, 1);
  }
});

test("when both entries carry the winning status the newer non-null exit code wins", () => {
  const sticky = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "fail", exitCode: 2, source: "postToolUse-capture" },
    { command: "npm test", observedResult: "fail", exitCode: null, source: "postToolUse-capture" },
  ]);
  assert.equal(sticky.get("npm test").exitCode, 2);
  const newer = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "fail", exitCode: 2, source: "postToolUse-capture" },
    { command: "npm test", observedResult: "fail", exitCode: 3, source: "canonical-writer-execution" },
  ]);
  assert.equal(newer.get("npm test").exitCode, 3);
});

test("an ambiguous entry's null exit code never displaces the winning pass's code", () => {
  const fold = reduceCaptureLogByCommand([
    { command: "npm test", observedResult: "pass", exitCode: 0, source: "canonical-writer-execution" },
    { command: "npm test", observedResult: "ambiguous", exitCode: null, source: "postToolUse-capture" },
  ]);
  assert.equal(fold.get("npm test").observedResult, "pass");
  assert.equal(fold.get("npm test").exitCode, 0);
});

test("a writer-observed fail is sticky like any other observed fail", () => {
  const fold = reduceCaptureLogByCommand([
    { command: "npm run test:unit", observedResult: "fail", exitCode: 2, source: "canonical-writer-execution" },
    { command: "npm run test:unit", observedResult: "ambiguous", exitCode: null, source: "postToolUse-capture" },
  ]);
  assert.equal(fold.get("npm run test:unit").observedResult, "fail");
  assert.equal(fold.get("npm run test:unit").exitCode, 2);
});
