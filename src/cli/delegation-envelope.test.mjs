import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  DELEGATION_ENVELOPE_SCHEMA_VERSION,
  DelegationEnvelopeNarrowingError,
  DelegationEnvelopeValidationError,
  assertDelegationEnvelopeActiveAt,
  narrowDelegationEnvelope,
  validateDelegationEnvelope,
} from "../../build/src/index.js";

const OBSERVED_AT = "2026-08-09T12:00:00.000Z";

const delegationSchema = JSON.parse(readFileSync(
  new URL("../../schemas/delegation-envelope.schema.json", import.meta.url),
  "utf8",
));
const correlationSchema = JSON.parse(readFileSync(
  new URL("../../schemas/run-correlation-envelope.schema.json", import.meta.url),
  "utf8",
));

function correlation() {
  return {
    schema_version: "1.0",
    correlation_id: "run-delegation-001",
    identities: {
      runtime_session: { status: "present", value: "session-001" },
      runtime_turn: { status: "present", value: "turn-001" },
      flow_run: { status: "unavailable", reason: "this work is not Flow-bound" },
      flow_step: { status: "unavailable", reason: "this work is not Flow-bound" },
      work_item: { status: "present", value: "kontourai/flow-agents#1112" },
      agent: { status: "present", value: "agent-001" },
      delegation_trace: { status: "present", value: "trace-001" },
      delegation_span: { status: "present", value: "span-001" },
      terminal_record: { status: "unavailable", reason: "the child has not completed" },
    },
  };
}

function root() {
  return {
    schema_version: DELEGATION_ENVELOPE_SCHEMA_VERSION,
    envelope_id: "11111111-1111-4111-8111-111111111111",
    generation: 0,
    correlation: correlation(),
    flow_binding: { status: "unbound", reason: "delegation began outside a Flow run" },
    actor_id: "actor-001",
    subject_id: "subject-001",
    source: {
      repository_id: "kontourai/flow-agents",
      worktree_id: "worktree-001",
      source_state_id: "sha256-001",
      dirty_state_fingerprint: "a".repeat(64),
    },
    authority: {
      allowed_tools: ["filesystem.read", "filesystem.write", "terminal.exec"],
      allowed_effects: ["read", "write", "execute"],
      mutable_resources: ["src", "schemas"],
      posture: "writer",
      approval: "automatic",
      escalation: "deny",
    },
    budget: {
      max_attempts: 4,
      max_depth: 2,
      max_concurrent_children: 3,
      max_input_tokens: 10000,
      max_output_tokens: 4000,
      max_cost_micros: 900000,
      expires_at: "2026-08-10T00:00:00.000Z",
    },
    runtime: {
      required_capabilities: ["tool-use"],
      runtime_receipt_ref: "runtime-receipt-001",
      model_receipt_ref: "model-receipt-001",
    },
    continuation_id: "continuation-001",
    cancellation_id: "cancellation-001",
    revisions: {
      prompt_revision: "prompt-r1",
      rubric_revision: "rubric-r1",
      policy_revision: "policy-r1",
    },
  };
}

function childOf(parent, id, generation) {
  const child = structuredClone(parent);
  child.envelope_id = id;
  child.parent_envelope_id = parent.envelope_id;
  child.generation = generation;
  child.authority.allowed_tools = ["filesystem.read"];
  child.authority.allowed_effects = ["read"];
  child.authority.mutable_resources = ["src"];
  child.authority.posture = "report-only";
  child.authority.approval = "requires_approval";
  child.budget.max_attempts = 2;
  child.budget.max_depth = parent.budget.max_depth - 1;
  child.budget.max_concurrent_children = 1;
  child.budget.max_input_tokens = 2000;
  child.budget.max_output_tokens = 1000;
  child.budget.max_cost_micros = 100000;
  child.budget.expires_at = "2026-08-09T23:00:00.000Z";
  return child;
}

function schemaValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(correlationSchema);
  return ajv.compile(delegationSchema);
}

test("validates a closed, explicit-unbound delegation envelope and matches the shipped schema", () => {
  const envelope = root();
  assert.equal(validateDelegationEnvelope(envelope).flow_binding.status, "unbound");
  const validate = schemaValidator();
  assert.equal(validate(envelope), true, JSON.stringify(validate.errors));
});

test("parent, child, and grandchild preserve immutable lineage while authority and budget narrow", () => {
  const parent = validateDelegationEnvelope(root());
  const child = narrowDelegationEnvelope(parent, childOf(parent, "22222222-2222-4222-8222-222222222222", 1), OBSERVED_AT);
  const grandchildDraft = childOf(child, "33333333-3333-4333-8333-333333333333", 2);
  grandchildDraft.budget.max_depth = 0;
  const grandchild = narrowDelegationEnvelope(child, grandchildDraft, OBSERVED_AT);

  assert.equal(child.parent_envelope_id, parent.envelope_id);
  assert.equal(grandchild.parent_envelope_id, child.envelope_id);
  assert.equal(grandchild.generation, 2);
  assert.deepEqual(grandchild.source, parent.source);
  assert.equal(grandchild.authority.posture, "report-only");
  assert.deepEqual(parent.authority.allowed_tools, ["filesystem.read", "filesystem.write", "terminal.exec"]);
});

test("rejects every authority, source, posture, and budget widening", () => {
  const parent = root();
  for (const mutate of [
    (child) => child.authority.allowed_tools.push("network.fetch"),
    (child) => child.authority.allowed_effects.push("network"),
    (child) => child.authority.mutable_resources.push("packages"),
    (child) => { child.budget.max_cost_micros = parent.budget.max_cost_micros + 1; },
    (child) => { child.budget.expires_at = "2026-08-10T01:00:00.000Z"; },
    (child) => { child.source.worktree_id = "different-worktree"; },
  ]) {
    const child = childOf(parent, "22222222-2222-4222-8222-222222222222", 1);
    mutate(child);
    assert.throws(() => narrowDelegationEnvelope(parent, child, OBSERVED_AT), DelegationEnvelopeNarrowingError);
  }
  const reportOnlyParent = root();
  reportOnlyParent.authority.posture = "report-only";
  const postureWidening = childOf(reportOnlyParent, "22222222-2222-4222-8222-222222222222", 1);
  postureWidening.authority.posture = "writer";
  assert.throws(
    () => narrowDelegationEnvelope(reportOnlyParent, postureWidening, OBSERVED_AT),
    DelegationEnvelopeNarrowingError,
  );
});

test("rejects unknown, malformed, and secret-bearing envelope data before it can propagate", () => {
  const unknown = root();
  unknown.unreviewed_extension = true;
  assert.throws(() => validateDelegationEnvelope(unknown), DelegationEnvelopeValidationError);

  const malformed = root();
  malformed.flow_binding = { status: "bound", flow_run_id: "run", flow_step_id: "step" };
  assert.throws(() => validateDelegationEnvelope(malformed), DelegationEnvelopeValidationError);

  const invalidLineage = root();
  invalidLineage.generation = 1;
  assert.throws(() => validateDelegationEnvelope(invalidLineage), DelegationEnvelopeValidationError);

  for (const mutate of [
    (candidate) => { candidate.authority.allowed_tools = ["token=never-embed-this"]; },
    (candidate) => { candidate.runtime.runtime_receipt_ref = "https://user:password@example.com/receipt"; },
    (candidate) => { candidate.flow_binding.reason = "https://user:password@example.com/why"; },
  ]) {
    const secret = root();
    mutate(secret);
    assert.throws(() => validateDelegationEnvelope(secret), DelegationEnvelopeValidationError);
  }
});

test("schema and runtime reject the same structural, credential, and timestamp forms", () => {
  const validate = schemaValidator();
  for (const mutate of [
    (candidate) => { candidate.extra = true; },
    (candidate) => { candidate.budget.expires_at = "tomorrow"; },
    (candidate) => { candidate.authority.mutable_resources = ["../escape"]; },
    (candidate) => { candidate.authority.mutable_resources = ["src/../escape"]; },
    (candidate) => { candidate.generation = 1; },
    (candidate) => { candidate.budget.expires_at = "2026-02-30T12:00:00.000Z"; },
    (candidate) => { candidate.runtime.runtime_receipt_ref = "https://example.com/receipt"; },
    (candidate) => { candidate.runtime.runtime_receipt_ref = "https://user:password@example.com/receipt"; },
    (candidate) => { candidate.flow_binding.reason = "https://user:password@example.com/why"; },
  ]) {
    const candidate = root();
    mutate(candidate);
    assert.equal(validate(candidate), false);
    assert.throws(() => validateDelegationEnvelope(candidate), DelegationEnvelopeValidationError);
  }

  const leapYearZero = root();
  leapYearZero.budget.expires_at = "0000-02-29T12:00:00.000Z";
  assert.equal(validate(leapYearZero), true, JSON.stringify(validate.errors));
  assert.equal(validateDelegationEnvelope(leapYearZero).budget.expires_at, leapYearZero.budget.expires_at);
});

test("requires an explicit canonical observation before active envelopes derive", () => {
  const parent = root();
  const child = childOf(parent, "22222222-2222-4222-8222-222222222222", 1);

  assert.deepEqual(assertDelegationEnvelopeActiveAt(parent, OBSERVED_AT), parent);
  assert.throws(
    () => assertDelegationEnvelopeActiveAt(parent, "2026-08-10T00:00:00.000Z"),
    DelegationEnvelopeNarrowingError,
  );
  assert.throws(
    () => narrowDelegationEnvelope(parent, child),
    DelegationEnvelopeValidationError,
  );
  assert.throws(
    () => narrowDelegationEnvelope(parent, child, "2026-02-30T12:00:00.000Z"),
    DelegationEnvelopeValidationError,
  );
  assert.throws(
    () => narrowDelegationEnvelope(parent, child, "2026-08-10T00:00:00.000Z"),
    DelegationEnvelopeNarrowingError,
  );
});

test("cannot derive past the depth bound and can reduce escalation requests to deny", () => {
  const noDepthParent = root();
  noDepthParent.budget.max_depth = 0;
  const noDepthChild = childOf(noDepthParent, "22222222-2222-4222-8222-222222222222", 1);
  noDepthChild.budget.max_depth = 0;
  assert.throws(
    () => narrowDelegationEnvelope(noDepthParent, noDepthChild, OBSERVED_AT),
    DelegationEnvelopeNarrowingError,
  );

  const requestParent = root();
  requestParent.authority.escalation = "request";
  const denyChild = childOf(requestParent, "22222222-2222-4222-8222-222222222222", 1);
  denyChild.authority.escalation = "deny";
  assert.equal(
    narrowDelegationEnvelope(requestParent, denyChild, OBSERVED_AT).authority.escalation,
    "deny",
  );

  const denyParent = root();
  const requestChild = childOf(denyParent, "22222222-2222-4222-8222-222222222222", 1);
  requestChild.authority.escalation = "request";
  assert.throws(
    () => narrowDelegationEnvelope(denyParent, requestChild, OBSERVED_AT),
    DelegationEnvelopeNarrowingError,
  );
});

test("validator and narrowing return defensive copies", () => {
  const parent = root();
  const validated = validateDelegationEnvelope(parent);
  validated.authority.allowed_tools.push("mutated-after-validation");
  assert.equal(parent.authority.allowed_tools.includes("mutated-after-validation"), false);

  const child = childOf(parent, "22222222-2222-4222-8222-222222222222", 1);
  const narrowed = narrowDelegationEnvelope(parent, child, OBSERVED_AT);
  narrowed.authority.allowed_tools.push("mutated-after-narrowing");
  assert.equal(child.authority.allowed_tools.includes("mutated-after-narrowing"), false);
});
