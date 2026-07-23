import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";
import {
  buildWorkflowTrustProjection,
  deriveGateAssociations,
  githubIssueUrl,
  readWorkflowTrustSources,
} from "../../build/src/lib/workflow-trust-projection.js";

const GENERATED_AT = "2026-07-20T12:00:00Z";

function validBundle(claimId = "claim-tests") {
  return {
    schemaVersion: 2,
    source: "console-trust-projection-test",
    claims: [{
      id: claimId,
      subjectId: `demo/gate/${claimId}`,
      subjectType: "workflow",
      facet: "flow-agents.workflow",
      claimType: "builder.verify.tests",
      fieldOrBehavior: "required tests pass",
      value: "pass",
      createdAt: "2026-07-20T10:00:00Z",
      updatedAt: "2026-07-20T10:00:00Z",
      metadata: {
        gate_claim: {
          expectation_id: "tests-evidence",
          claim_type: "builder.verify.tests",
          subject_type: "workflow",
          step_id: "verify",
        },
      },
    }],
    evidence: [{
      id: `ev:${claimId}`,
      claimId,
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "demo/evidence.json",
      excerptOrSummary: "node --test passes",
      observedAt: "2026-07-20T10:00:00Z",
      collectedBy: "flow-agents/workflow-sidecar",
      passing: true,
    }],
    events: [{
      id: `evt:${claimId}`,
      claimId,
      status: "verified",
      actor: "flow-agents/workflow-sidecar",
      method: "validation",
      evidenceIds: [`ev:${claimId}`],
      createdAt: "2026-07-20T10:00:00Z",
      verifiedAt: "2026-07-20T10:00:00Z",
    }],
    policies: [],
  };
}

function state(slug, overrides = {}) {
  return {
    schema_version: "1.0",
    task_slug: slug,
    status: "verifying",
    phase: "verification",
    updated_at: "2026-07-20T10:00:00Z",
    next_action: { status: "continue", summary: "Verify the implementation." },
    ...overrides,
  };
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-trust-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeWorkflow(root, slug, { stateValue = state(slug), bundle } = {}) {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(stateValue, null, 2)}\n`);
  if (bundle !== undefined) fs.writeFileSync(path.join(dir, "trust.bundle"), `${JSON.stringify(bundle, null, 2)}\n`);
  return dir;
}

test("buildWorkflowTrustProjection emits an inert non-authoritative envelope and carries Surface's report verbatim", async (t) => {
  const root = fixtureRoot(t);
  const bundle = validBundle();
  writeWorkflow(root, "session-a", { bundle });

  const read = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  const envelope = buildWorkflowTrustProjection(read.sources, {
    scope: { kind: "repo", id: "demo" },
    generatedAt: GENERATED_AT,
  });
  const expectedReport = buildTrustReport(validateTrustBundle(bundle), { now: new Date(GENERATED_AT) });

  assert.equal(envelope.schema, "kontour.console.projection");
  assert.equal(envelope.version, "0.1");
  assert.equal(envelope.producer.id, "flow-agents-trust");
  assert.equal(envelope.trusts.length, 1);
  assert.equal(envelope.trusts[0].nonAuthority, true);
  assert.deepEqual(envelope.trusts[0].subjectRef, {
    product: "flow-agents",
    kind: "workflow",
    id: "session-a",
    label: "session-a",
  });
  assert.deepEqual(envelope.trusts[0].payload, expectedReport);
});

test("deriveGateAssociations groups stamped claims by the bundle's gate id and joins evidence/events through claimId", () => {
  const bundle = validBundle("claim-z");
  bundle.claims.push({
    ...bundle.claims[0],
    id: "claim-a",
    subjectId: "demo/gate/claim-a",
  });
  const associations = deriveGateAssociations(bundle);

  assert.deepEqual(associations, [{
    gateId: "tests-evidence",
    claimIds: ["claim-a", "claim-z"],
    evidenceIds: ["ev:claim-z"],
    eventIds: ["evt:claim-z"],
  }]);
});

test("workflow Work Item and assignment bindings project canonical GitHub URL plus branch/actor/artifact-dir refs", async (t) => {
  const root = fixtureRoot(t);
  const slug = "flow-agents-891";
  writeWorkflow(root, slug, {
    bundle: validBundle(),
    stateValue: state(slug, {
      work_item_refs: ["github:kontourai/flow-agents#891"],
      owner: "codex:delegate:host",
      branch: "feat/trust-projection-891",
    }),
  });
  fs.mkdirSync(path.join(root, "assignment"), { recursive: true });
  fs.writeFileSync(path.join(root, "assignment", `${slug}.json`), `${JSON.stringify({
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: slug,
    actor: { runtime: "codex", session_id: "delegate", host: "host" },
    actor_key: "codex:delegate:host",
    work_item_ref: "github:kontourai/flow-agents#891",
    branch: "feat/trust-projection-891",
    artifact_dir: slug,
    status: "claimed",
  }, null, 2)}\n`);

  const read = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  const refs = read.sources[0].sourceOfTruthRefs;
  const workItem = refs.find((ref) => ref.kind === "work-item");

  assert.equal(workItem.url, "https://github.com/kontourai/flow-agents/issues/891");
  assert.ok(refs.some((ref) => ref.kind === "assignment-branch" && ref.id === "feat/trust-projection-891"));
  assert.ok(refs.some((ref) => ref.kind === "assignment-actor" && ref.id === "codex:delegate:host"));
  assert.ok(refs.some((ref) => ref.kind === "assignment-artifact-dir" && ref.id === slug));
  assert.equal(githubIssueUrl("kontourai/flow-agents#891"), "https://github.com/kontourai/flow-agents/issues/891");
  assert.equal(githubIssueUrl("local:891"), undefined);
});

test("readWorkflowTrustSources skips a workflow with no trust.bundle silently", async (t) => {
  const root = fixtureRoot(t);
  writeWorkflow(root, "no-bundle");

  const read = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  assert.equal(read.scannedWorkflowCount, 1);
  assert.equal(read.sources.length, 0);
  assert.deepEqual(read.warnings, []);
});

test("readWorkflowTrustSources records an invalid-bundle warning and continues projecting valid siblings", async (t) => {
  const root = fixtureRoot(t);
  writeWorkflow(root, "invalid", { bundle: { schemaVersion: 999, claims: [] } });
  writeWorkflow(root, "valid", { bundle: validBundle() });

  const read = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  assert.equal(read.scannedWorkflowCount, 2);
  assert.deepEqual(read.sources.map((source) => source.slug), ["valid"]);
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0], /^invalid: trust\.bundle failed canonical Surface validation/);
});

test("fixed generatedAt produces deterministic reports, entry IDs, and stable ordering", async (t) => {
  const root = fixtureRoot(t);
  writeWorkflow(root, "z-session", { bundle: validBundle("claim-z") });
  writeWorkflow(root, "a-session", { bundle: validBundle("claim-a") });
  const options = { scope: { kind: "repo", id: "demo" }, generatedAt: GENERATED_AT };

  const firstRead = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  const secondRead = await readWorkflowTrustSources(root, { generatedAt: GENERATED_AT });
  const first = buildWorkflowTrustProjection(firstRead.sources, options);
  const second = buildWorkflowTrustProjection(secondRead.sources.reverse(), options);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.trusts.map((entry) => entry.subjectRef.id), ["a-session", "z-session"]);
  assert.equal(first.trusts[0].payload.generatedAt, "2026-07-20T12:00:00.000Z");
});
