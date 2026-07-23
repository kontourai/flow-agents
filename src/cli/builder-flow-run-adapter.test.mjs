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
  amendRunDefinition,
  definitionDigest,
  definitionIdentity,
  flowRunHead,
  pauseRun,
  resumeRun,
  runDir,
  startRun,
} from "@kontourai/flow";

import {
  BUILDER_BUILD_FLOW_ID,
  evaluateBuilderBuildRun,
  loadBuilderBuildRun,
  startBuilderBuildRun,
} from "../../build/src/builder-flow-run-adapter.js";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  createRunCorrelationEnvelope,
} from "../../build/src/run-correlation.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BUILDER_BUILD_DEFINITION = path.join(REPO_ROOT, "kits/builder/flows/build.flow.json");
const FOREIGN_FLOW_DEFINITION = path.join(REPO_ROOT, "node_modules/@kontourai/flow/examples/agent-dev-flow.json");
const SUBJECT = "flow-agents#177";
const FOREIGN_SUBJECT = "flow-agents#178";
const FIXTURE_NOW = "2026-07-09T20:00:00.000Z";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-flow-"));
}

function runCorrelation(runId) {
  return createRunCorrelationEnvelope({
    correlation_id: `correlation-${runId}`,
    identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
      key,
      key === "flow_run"
        ? { status: "present", value: runId }
        : { status: "unavailable", reason: `${key} is unavailable in this fixture` },
    ])),
  });
}

test("Builder persists and reloads one validated run correlation envelope", async () => {
  const cwd = makeWorkspace();
  const runId = "builder-correlation-run";
  const correlation = runCorrelation(runId);
  const started = await startBuilderBuildRun({ cwd, runId, subject: SUBJECT, correlation });
  const loaded = await loadBuilderBuildRun({ cwd, runId });

  assert.deepEqual(started.correlation, { status: "present", envelope: correlation });
  assert.deepEqual(loaded.correlation, started.correlation);
});

test("Builder rejects cross-run correlation and reports legacy runs as incomplete", async () => {
  const cwd = makeWorkspace();
  await assert.rejects(
    startBuilderBuildRun({
      cwd,
      runId: "run-one",
      subject: SUBJECT,
      correlation: runCorrelation("run-two"),
    }),
    /must match runId/,
  );

  const legacy = await startBuilderBuildRun({ cwd, runId: "legacy-run", subject: SUBJECT });
  assert.equal(legacy.correlation.status, "incomplete");

  await assert.rejects(
    startBuilderBuildRun({
      cwd,
      runId: "injected-correlation",
      subject: SUBJECT,
      params: { run_correlation: JSON.stringify(runCorrelation("injected-correlation")) },
    }),
    /is reserved/,
  );
});

test("Builder carries correlation into attached trust evidence analytics", async () => {
  const cwd = makeWorkspace();
  const runId = "correlated-trust-evidence";
  const correlation = runCorrelation(runId);
  await startBuilderBuildRun({ cwd, runId, subject: SUBJECT, correlation });
  const evaluated = await evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, {
      gate: "pull-work-gate",
      claimType: "builder.pull-work.selected",
      subjectType: "work-item",
    }),
  });

  assert.deepEqual(evaluated.attachedEvidence[0].analytics.run_correlation, correlation);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runFile(cwd, runId, file) {
  return path.join(runDir(runId, cwd), file);
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
      metadata: {
        workflow_subject_ref: claim.workflowSubjectRef ?? claim.subjectId,
        ...(waiver ? { waiver: { reason: "plausible fixture waiver", approved_by: "flow-agents-test", approved_at: FIXTURE_NOW } } : {}),
      },
      createdAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
      updatedAt: stale ? "2026-01-01T00:00:00.000Z" : FIXTURE_NOW,
      ...(stale ? { impactLevel: "high", verificationPolicyId: policyId } : {}),
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

async function advanceParentPrefixThroughExecute(cwd, runId) {
  await startActiveRun(cwd, runId);
  const steps = [
    ["pull-work-gate", "builder.pull-work.selected", "work-item"],
    ["design-probe-gate", "builder.design-probe.pickup-readiness", "work-item"],
    ["design-probe-gate", "builder.design-probe.decisions", "decision"],
    ["plan-gate", "builder.plan.implementation", "artifact"],
  ];
  for (const [gate, claimType, subjectType] of steps) {
    await evaluateBuilderBuildRun({ cwd, runId, evidence: gateEvidence(cwd, { gate, claimType, subjectType, name: claimType }) });
  }
  assert.equal(snapshotRun(cwd, runId).state.current_step, "execute", "sequential parent-prefix setup must reach execute");
}

test("start is creation-only and persists canonical id/version", async () => {
  const cwd = makeWorkspace();
  const runId = "start-creation-only";

  const result = await startActiveRun(cwd, runId);
  const persisted = snapshotRun(cwd, runId);

  assert.equal(result.definitionId, BUILDER_BUILD_FLOW_ID);
  assert.equal(result.definitionVersion, "1.3");
  assert.equal(persisted.state.definition_id, BUILDER_BUILD_FLOW_ID);
  assert.equal(persisted.state.definition_version, "1.3");
  assert.equal(persisted.state.subject, SUBJECT);
  assert.equal(persisted.state.status, "active");
  assert.equal(persisted.state.current_step, "pull-work");
  assert.deepEqual(persisted.state.gate_outcomes, []);
  assert.deepEqual(persisted.state.transitions, []);
  assert.deepEqual(persisted.manifest.evidence, []);
});

test("a published 1.1 start definition amends through Flow to the exact packaged 1.3 successor", async () => {
  const cwd = makeWorkspace();
  const runId = "published-1-1-amendment";
  const packaged = (await startBuilderBuildRun({ cwd, runId: "packaged-1-3-reference", subject: SUBJECT })).definition;
  const published = structuredClone(packaged);
  published.version = "1.1";
  delete published.gates["execute-gate"].on_route_back;
  delete published.gates["execute-gate"].route_back_policy;
  const publishedFile = path.join(cwd, "published-builder-build-1.1.json");
  writeJson(publishedFile, published);

  await startRun(publishedFile, { cwd, runId, params: { subject: SUBJECT } });
  const before = readJson(runFile(cwd, runId, FLOW_RUN_STATE_FILE));
  await amendRunDefinition(runId, {
    cwd,
    definition: packaged,
    request: {
      reason: "upgrade a published builder.build@1.1 run to the packaged 1.3 definition",
      expected_run_head: flowRunHead(before),
      expected_definition: definitionIdentity(published),
      successor_digest: definitionDigest(packaged),
      authority: {
        kind: "user_request",
        actor: "builder-flow-run-adapter-test",
        request_ref: "test:published-1-1-amendment",
        requested_at: FIXTURE_NOW,
      },
    },
  });

  const loaded = await loadBuilderBuildRun({ cwd, runId });
  assert.deepEqual(loaded.startDefinition, published, "the old published start bytes remain immutable");
  assert.deepEqual(loaded.definition, packaged, "the effective definition is the exact packaged successor");
  assert.equal(loaded.definitionVersion, "1.3");
  assert.equal(loaded.definitionDigest, definitionDigest(packaged));
  assert.deepEqual(readJson(runFile(cwd, runId, "definition.json")), published, "Flow never overwrites the immutable origin");
});

test("a raw 1.2 amendment corrects append-only to the exact packaged 1.3 composition", async () => {
  const cwd = makeWorkspace();
  const runId = "raw-1-2-composition-correction";
  const packaged = (await startBuilderBuildRun({ cwd, runId: "packaged-1-3-correction-reference", subject: SUBJECT })).definition;
  const published = structuredClone(packaged);
  published.version = "1.1";
  delete published.gates["execute-gate"].on_route_back;
  delete published.gates["execute-gate"].route_back_policy;
  const publishedFile = path.join(cwd, "published-builder-build-1.1.json");
  writeJson(publishedFile, published);
  await startRun(publishedFile, { cwd, runId, params: { subject: SUBJECT } });

  const raw = readJson(BUILDER_BUILD_DEFINITION);
  raw.version = "1.2";
  const beforeRaw = snapshotRun(cwd, runId).state;
  await amendRunDefinition(runId, {
    cwd,
    definition: raw,
    request: {
      reason: "record the previously accepted raw 1.2 successor",
      expected_run_head: flowRunHead(beforeRaw),
      expected_definition: definitionIdentity(published),
      successor_digest: definitionDigest(raw),
      authority: {
        kind: "user_request",
        actor: "builder-flow-run-adapter-test",
        request_ref: "test:raw-1-2-amendment",
        requested_at: FIXTURE_NOW,
      },
    },
  });

  const beforeCorrection = snapshotRun(cwd, runId).state;
  await amendRunDefinition(runId, {
    cwd,
    definition: packaged,
    request: {
      reason: "correct the raw successor to the exact packaged composition",
      expected_run_head: flowRunHead(beforeCorrection),
      expected_definition: definitionIdentity(raw),
      successor_digest: definitionDigest(packaged),
      authority: {
        kind: "user_request",
        actor: "builder-flow-run-adapter-test",
        request_ref: "test:packaged-1-3-correction",
        requested_at: FIXTURE_NOW,
      },
    },
  });

  const loaded = await loadBuilderBuildRun({ cwd, runId });
  assert.deepEqual(loaded.definition, packaged);
  assert.equal(loaded.definitionVersion, "1.3");
  assert.equal(loaded.state.definition_amendments.length, 2);
  assert.equal(loaded.state.definition_amendments[0].successor_definition.version, "1.2");
  assert.equal(loaded.state.definition_amendments[1].successor_definition.digest, definitionDigest(packaged));
  assert.deepEqual(readJson(runFile(cwd, runId, "definition.json")), published);
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

test("evidence attachment rejects a stale authorized run head without mutation", async () => {
  const cwd = makeWorkspace();
  const runId = "stale-authorized-head";
  await startActiveRun(cwd, runId);
  const authorizedHead = flowRunHead(snapshotRun(cwd, runId).state);
  const authority = { kind: "user_request", actor: "builder-flow-run-adapter-test", request_ref: "test:stale-authorized-head", requested_at: FIXTURE_NOW };
  await pauseRun(runId, { cwd, reason: "advance the canonical head", authority, at: "2026-07-09T20:00:01.000Z" });
  await resumeRun(runId, { cwd, reason: "restore the active gate", authority, at: "2026-07-09T20:00:02.000Z" });
  const before = snapshotRun(cwd, runId);

  await assert.rejects(
    () => evaluateBuilderBuildRun({
      cwd,
      runId,
      expectedRunHead: authorizedHead,
      evidence: gateEvidence(cwd, { gate: "pull-work-gate", claimType: "builder.pull-work.selected", subjectType: "work-item" }),
    }),
    /flow\.run_head\.stale/,
  );

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
        claim("workflow.critique.review", "workflow-critique"),
        claim("workflow.acceptance.criterion", "flow-step"),
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
    { gate_id: "verify-gate", status: "pass", matched_expectations: ["clean-critique", "acceptance-criteria", "tests-evidence", "policy-compliance"] },
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
  assert.equal(persisted.state.definition_version, "1.3");
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

test("failed execute evidence routes declared plan_gap to plan without replacing the run", async () => {
  const cwd = makeWorkspace();
  const runId = "execute-plan-gap";
  await advanceParentPrefixThroughExecute(cwd, runId);
  const before = snapshotRun(cwd, runId);

  await evaluateBuilderBuildRun({
    cwd,
    runId,
    evidence: gateEvidence(cwd, {
      gate: "execute-gate",
      claimType: "builder.execute.scope",
      subjectType: "change",
      status: "failed",
      routeReason: "plan_gap",
      expectationIds: ["implementation-scope"],
    }),
  });

  const persisted = snapshotRun(cwd, runId);
  const outcome = persisted.state.gate_outcomes.at(-1);
  const transition = persisted.state.transitions.at(-1);
  assert.equal(persisted.state.current_step, "plan");
  assert.equal(persisted.state.status, "active");
  assert.equal(persisted.state.subject, SUBJECT);
  assert.equal(persisted.state.run_id, before.state.run_id);
  assert.equal(outcome.gate_id, "execute-gate");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "plan_gap");
  assert.equal(outcome.route_back_to, "plan");
  assert.equal(outcome.attempt, 1);
  assert.equal(outcome.max_attempts, 3);
  assert.equal(transition.type, "route_back");
  assert.equal(transition.from_step, "execute");
  assert.equal(transition.to_step, "plan");
  assert.equal(transition.route_reason, "plan_gap");
  assert.equal(transition.gate_id, "execute-gate");
  assert.deepEqual(transition.expectation_ids, ["implementation-scope"]);
  assert.equal(persisted.state.transitions.length, before.state.transitions.length + 1);
});
