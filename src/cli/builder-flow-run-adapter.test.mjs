import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FLOW_RUN_EVIDENCE_DIR,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_REPORT_JSON_FILE,
  FLOW_RUN_STATE_FILE,
  startRun,
} from "@kontourai/flow";

import {
  BUILDER_BUILD_FLOW_ID,
  evaluateBuilderBuildRun,
  startBuilderBuildRun,
} from "../../build/src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BUILDER_BUILD_DEFINITION = path.join(REPO_ROOT, "kits/builder/flows/build.flow.json");
const FOREIGN_FLOW_DEFINITION = path.join(REPO_ROOT, "node_modules/@kontourai/flow/examples/agent-dev-flow.json");
const SUBJECT = "flow-agents#177";
const FOREIGN_SUBJECT = "flow-agents#178";
const FIXTURE_NOW = "2026-07-09T20:00:00.000Z";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-flow-"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runFile(cwd, runId, file) {
  return path.join(cwd, ".flow", "runs", runId, file);
}

function evidenceDirectory(cwd, runId) {
  return runFile(cwd, runId, FLOW_RUN_EVIDENCE_DIR);
}

function recursiveListing(directory, relative = "") {
  assert.ok(fs.existsSync(directory), `expected evidence directory to exist: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) return [{ path: `${childRelative}/`, type: "directory" }, ...recursiveListing(child, childRelative)];
      return [{ path: childRelative, type: entry.isFile() ? "file" : "other" }];
    });
}

function snapshotRun(cwd, runId) {
  const stateFile = runFile(cwd, runId, FLOW_RUN_STATE_FILE);
  const manifestFile = runFile(cwd, runId, FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const reportFile = runFile(cwd, runId, FLOW_RUN_REPORT_JSON_FILE);
  for (const file of [stateFile, manifestFile, reportFile]) {
    assert.ok(fs.existsSync(file), `expected persisted run file to exist: ${file}`);
  }
  const reportText = fs.readFileSync(reportFile, "utf8");
  return {
    state: readJson(stateFile),
    manifest: readJson(manifestFile),
    report: JSON.parse(reportText),
    reportText,
    evidenceFiles: recursiveListing(evidenceDirectory(cwd, runId)),
  };
}

function assertSnapshotUnchanged(before, after) {
  assert.deepEqual(after.state, before.state, "state.json changed after rejected input");
  assert.deepEqual(after.manifest, before.manifest, "evidence manifest changed after rejected input");
  assert.deepEqual(after.report, before.report, "report JSON changed after rejected input");
  assert.equal(after.reportText, before.reportText, "report bytes changed after rejected input");
  assert.deepEqual(after.evidenceFiles, before.evidenceFiles, "evidence directory changed after rejected input");
}

function assertAdapterRejectedInput(error) {
  assert.notEqual(error?.name, "TypeError", `adapter must reject input intentionally, not fail with ${error?.message}`);
  return true;
}

function trustBundle({ claims, status = "verified", waiver = false, stale = false }) {
  const policyId = "policy.duration";
  const evidence = claims.map((claim, index) => ({
    id: `evidence.${index + 1}`,
    claimId: claim.id,
    evidenceType: stale ? "test_output" : "human_attestation",
    method: stale ? "validation" : "attestation",
    sourceRef: "src/cli/builder-flow-run-adapter.test.mjs",
    excerptOrSummary: `fixture for ${claim.claimType}`,
    observedAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
    collectedBy: "flow-agents-test",
  }));
  return {
    schemaVersion: 5,
    source: "flow-agents-builder-flow-run-adapter-test",
    claims: claims.map((claim) => ({
      id: claim.id,
      subjectType: claim.subjectType,
      subjectId: claim.subjectId,
      claimType: claim.claimType,
      fieldOrBehavior: "parent gated prefix contract",
      value: `${claim.claimType} for ${claim.subjectId}`,
      createdAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
      updatedAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
      ...(stale ? { impactLevel: "high", verificationPolicyId: policyId } : {}),
      ...(waiver ? { metadata: { waiver: { reason: "plausible fixture waiver", approved_by: "flow-agents-test", approved_at: FIXTURE_NOW } } } : {}),
    })),
    evidence,
    policies: stale
      ? [{
          id: policyId,
          claimType: claims[0].claimType,
          requiredEvidence: ["test_output"],
          requiredMethods: ["validation"],
          requiresCorroboration: false,
          acceptanceCriteria: ["fresh test result"],
          reviewAuthority: "ci",
          validityRule: { kind: "duration", durationDays: 1 },
          stalenessTriggers: ["validity window expires"],
          conflictRules: [],
          impactLevel: "high",
        }]
      : [],
    events: claims.map((claim, index) => ({
      id: `event.${index + 1}.${status}`,
      claimId: claim.id,
      status,
      actor: "flow-agents-test",
      method: stale ? "npm test" : "attestation",
      evidenceIds: [`evidence.${index + 1}`],
      createdAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
      verifiedAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
    })),
  };
}

function claim(claimType, subjectType, subjectId = SUBJECT) {
  return { id: `claim.${claimType}.${subjectType}`, claimType, subjectType, subjectId };
}

function evidenceFile(cwd, name, bundle) {
  const file = path.join(cwd, "evidence-input", `${name}.trust-bundle.json`);
  writeJson(file, bundle);
  return file;
}

function gateEvidence(cwd, { gate, claimType, subjectType, subjectId = SUBJECT, name = gate, status, routeReason, expectationIds, bundle }) {
  return {
    gate,
    file: evidenceFile(cwd, name, bundle ?? trustBundle({ claims: [claim(claimType, subjectType, subjectId)] })),
    ...(status ? { status } : {}),
    ...(routeReason ? { routeReason } : {}),
    ...(expectationIds ? { expectationIds } : {}),
  };
}

async function startActiveRun(cwd, runId) {
  return startBuilderBuildRun({ cwd, runId, subject: SUBJECT, params: { subject: SUBJECT } });
}

async function advanceParentPrefixThroughVerify(cwd, runId) {
  await startActiveRun(cwd, runId);
  const steps = [
    ["pull-work-gate", "builder.pull-work.selected", "work-item"],
    ["design-probe-gate", "builder.design-probe.pickup-readiness", "work-item"],
    ["design-probe-gate", "builder.design-probe.decisions", "decision"],
    ["plan-gate", "builder.plan.implementation", "artifact"],
    ["execute-gate", "builder.execute.scope", "change"],
  ];
  for (const [gate, claimType, subjectType] of steps) {
    await evaluateBuilderBuildRun({ cwd, runId, evidence: gateEvidence(cwd, { gate, claimType, subjectType, name: claimType }) });
  }
  assert.equal(snapshotRun(cwd, runId).state.current_step, "verify", "sequential parent-prefix setup must reach verify");
}

test("start is creation-only and persists canonical id/version", async () => {
  const cwd = makeWorkspace();
  const runId = "start-creation-only";

  const result = await startActiveRun(cwd, runId);
  const persisted = snapshotRun(cwd, runId);

  assert.equal(result.definitionId, BUILDER_BUILD_FLOW_ID);
  assert.equal(result.definitionVersion, "1.0");
  assert.equal(persisted.state.definition_id, BUILDER_BUILD_FLOW_ID);
  assert.equal(persisted.state.definition_version, "1.0");
  assert.equal(persisted.state.subject, SUBJECT);
  assert.equal(persisted.state.status, "active");
  assert.equal(persisted.state.current_step, "pull-work");
  assert.deepEqual(persisted.state.gate_outcomes, []);
  assert.deepEqual(persisted.state.transitions, []);
  assert.deepEqual(persisted.manifest.evidence, []);
});

test("verified evidence for another run subject is rejected before mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "foreign-subject";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);

  await assert.rejects(() => evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.pull-work.selected", subjectType: "work-item", subjectId: FOREIGN_SUBJECT }),
  }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("all verified parent selectors advance only their persisted gates through pr-open", async () => {
  const cwd = makeWorkspace();
  const runId = "parent-prefix-through-pr-open";
  await startActiveRun(cwd, runId);

  const steps = [
    ["pull-work-gate", "builder.pull-work.selected", "work-item"],
    ["design-probe-gate", "builder.design-probe.pickup-readiness", "work-item"],
    ["design-probe-gate", "builder.design-probe.decisions", "decision"],
    ["plan-gate", "builder.plan.implementation", "artifact"],
    ["execute-gate", "builder.execute.scope", "change"],
  ];
  for (const [gate, claimType, subjectType] of steps) {
    await evaluateBuilderBuildRun({ cwd, runId, evidence: gateEvidence(cwd, { gate, claimType, subjectType, name: claimType }) });
  }
  await evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, {
      gate: "verify-gate",
      claimType: "builder.verify.tests",
      subjectType: "flow-step",
      name: "verify-all-selectors",
      bundle: trustBundle({ claims: [
        claim("builder.verify.tests", "flow-step"),
        claim("builder.verify.policy-compliance", "artifact"),
      ] }),
    }),
  });
  const result = await evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, { gate: "merge-ready-gate", claimType: "builder.merge-ready.readiness", subjectType: "change" }),
  });
  const persisted = snapshotRun(cwd, runId);

  assert.equal(result.definitionId, persisted.state.definition_id);
  assert.equal(result.definitionVersion, persisted.state.definition_version);
  assert.equal(persisted.state.current_step, "pr-open");
  assert.equal(persisted.state.status, "active");
  assert.equal(persisted.manifest.evidence.length, 7);
  assert.deepEqual(persisted.state.gate_outcomes.map(({ gate_id, status, matched_expectations }) => ({
    gate_id,
    status,
    matched_expectations: matched_expectations.map(({ expectation_id }) => expectation_id),
  })), [
    { gate_id: "pull-work-gate", status: "pass", matched_expectations: ["selected-work"] },
    { gate_id: "design-probe-gate", status: "pass", matched_expectations: ["pickup-probe-readiness", "probe-decisions-or-accepted-gaps"] },
    { gate_id: "plan-gate", status: "pass", matched_expectations: ["implementation-plan"] },
    { gate_id: "execute-gate", status: "pass", matched_expectations: ["implementation-scope"] },
    { gate_id: "verify-gate", status: "pass", matched_expectations: ["tests-evidence", "policy-compliance"] },
    { gate_id: "merge-ready-gate", status: "pass", matched_expectations: ["merge-readiness"] },
  ]);
});

test("bare assumed and waiver-shaped assumed evidence both remain blocked", async () => {
  for (const [name, waiver] of [["bare", false], ["waiver-shaped", true]]) {
    const cwd = makeWorkspace();
    const runId = `assumed-${name}`;
    await startActiveRun(cwd, runId);
    await evaluateBuilderBuildRun({
      cwd,
      runId,
      evidence: gateEvidence(cwd, {
        gate: "pull-work-gate",
        claimType: "builder.pull-work.selected",
        subjectType: "work-item",
        name,
        bundle: trustBundle({ claims: [claim("builder.pull-work.selected", "work-item")], status: "assumed", waiver }),
      }),
    });
    const persisted = snapshotRun(cwd, runId);
    assert.equal(persisted.state.current_step, "pull-work", `${name} assumed evidence must not advance the run`);
    assert.equal(persisted.state.status, "blocked");
    assert.equal(persisted.manifest.evidence.at(-1).bundle_report.claims[0].status, "assumed");
  }
});

test("malformed evidence status is rejected before mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "malformed-status";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);

  await assert.rejects(() => evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.pull-work.selected", subjectType: "work-item", status: "banana" }),
  }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("multi-evidence input is rejected before the first attachment", async () => {
  const cwd = makeWorkspace();
  const runId = "multi-evidence";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);
  const valid = gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.pull-work.selected", subjectType: "work-item", name: "valid-first" });
  const invalid = gateEvidence(cwd, {
    gate: "pull-work-gate",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    name: "invalid-second",
    bundle: { schemaVersion: 5, source: "invalid", claims: [] },
  });

  await assert.rejects(() => evaluateBuilderBuildRun({ cwd, runId, evidence: [valid, invalid] }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("invalid trust bundle is rejected before Flow copies it", async () => {
  const cwd = makeWorkspace();
  const runId = "invalid-bundle";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);
  const invalid = gateEvidence(cwd, {
    gate: "pull-work-gate",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    bundle: { schemaVersion: 5, source: "invalid", claims: [] },
  });

  await assert.rejects(() => evaluateBuilderBuildRun({ cwd, runId, evidence: invalid }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("future-gate evidence is rejected before attachment", async () => {
  const cwd = makeWorkspace();
  const runId = "future-gate";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);

  await assert.rejects(() => evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, { gate: "verify-gate", claimType: "builder.verify.tests", subjectType: "flow-step" }),
  }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("direct evaluate gate injection is rejected before mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "gate-injection";
  await startActiveRun(cwd, runId);
  const before = snapshotRun(cwd, runId);

  await assert.rejects(() => evaluateBuilderBuildRun({
    cwd,
    runId,
    gate: "verify-gate",
    evidence: gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.pull-work.selected", subjectType: "work-item" }),
  }), assertAdapterRejectedInput);

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("backdated now cannot revive stale evidence", async () => {
  const cwd = makeWorkspace();
  const runId = "backdated-now";
  await startActiveRun(cwd, runId);
  const staleEvidence = gateEvidence(cwd, {
    gate: "pull-work-gate",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    bundle: trustBundle({ claims: [claim("builder.pull-work.selected", "work-item")], stale: true }),
  });
  const before = snapshotRun(cwd, runId);

  await assert.rejects(
    () => evaluateBuilderBuildRun({ cwd, runId, evidence: staleEvidence, now: "2026-01-01T12:00:00.000Z" }),
    assertAdapterRejectedInput,
  );
  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));

  await evaluateBuilderBuildRun({ cwd, runId, evidence: staleEvidence });
  const persisted = snapshotRun(cwd, runId);
  assert.equal(persisted.state.current_step, "pull-work");
  assert.equal(persisted.state.status, "blocked");
  assert.equal(persisted.manifest.evidence.at(-1).bundle_report.claims[0].status, "stale");
});

test("foreign-id run with nonempty evidence is rejected without filesystem mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "foreign-id";
  await startRun(FOREIGN_FLOW_DEFINITION, { cwd, runId, params: { subject: SUBJECT } });
  const before = snapshotRun(cwd, runId);

  await assert.rejects(
    () => evaluateBuilderBuildRun({
      cwd,
      runId,
      evidence: gateEvidence(cwd, { gate: "implementation-gate", claimType: "builder.pull-work.selected", subjectType: "work-item" }),
    }),
    (error) => error?.name === "BuilderBuildRunIdentityError" && error.expectedDefinitionId === BUILDER_BUILD_FLOW_ID && error.actualDefinitionId === "agent-dev-flow" && error.runId === runId,
  );

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("same-id same-version custom definition is rejected without mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "same-id-custom-definition";
  const customDefinition = readJson(BUILDER_BUILD_DEFINITION);
  customDefinition.gates["pull-work-gate"].expects[0].bundle_claim.claimType = "builder.attacker.replacement";
  const customPath = path.join(cwd, "definitions", "same-id-same-version-custom.json");
  writeJson(customPath, customDefinition);
  await startRun(customPath, { cwd, runId, params: { subject: SUBJECT } });
  const before = snapshotRun(cwd, runId);

  await assert.rejects(
    () => evaluateBuilderBuildRun({
      cwd,
      runId,
      evidence: gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.attacker.replacement", subjectType: "work-item" }),
    }),
    (error) => error?.name === "BuilderBuildRunIdentityError" && error.expectedDefinitionId === BUILDER_BUILD_FLOW_ID && error.runId === runId,
  );

  assertSnapshotUnchanged(before, snapshotRun(cwd, runId));
});

test("result identity comes from the persisted canonical run", async () => {
  const cwd = makeWorkspace();
  const runId = "persisted-result-identity";
  const started = await startActiveRun(cwd, runId);
  const evaluated = await evaluateBuilderBuildRun({ cwd, runId });
  const persisted = snapshotRun(cwd, runId);

  for (const result of [started, evaluated]) {
    assert.equal(result.definitionId, persisted.state.definition_id);
    assert.equal(result.definitionVersion, persisted.state.definition_version);
  }
  assert.equal(persisted.state.definition_id, BUILDER_BUILD_FLOW_ID);
  assert.equal(persisted.state.definition_version, "1.0");
});

test("failed verify evidence routes back only after sequential prefix advancement", async () => {
  const cwd = makeWorkspace();
  const runId = "route-back-prefix";
  await advanceParentPrefixThroughVerify(cwd, runId);

  await evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, {
      gate: "verify-gate",
      claimType: "builder.verify.tests",
      subjectType: "flow-step",
      status: "failed",
      routeReason: "implementation_defect",
      expectationIds: ["tests-evidence"],
    }),
  });
  const persisted = snapshotRun(cwd, runId);
  const outcome = persisted.state.gate_outcomes.at(-1);
  const transition = persisted.state.transitions.at(-1);

  assert.equal(persisted.state.current_step, "execute");
  assert.equal(persisted.state.status, "active");
  assert.equal(outcome.gate_id, "verify-gate");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "implementation_defect");
  assert.equal(outcome.route_back_to, "execute");
  assert.equal(transition.type, "route_back");
  assert.equal(transition.from_step, "verify");
  assert.equal(transition.to_step, "execute");
  assert.deepEqual(transition.expectation_ids, ["tests-evidence"]);
});
