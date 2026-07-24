import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  RunCorrelationValidationError,
  attachRunCorrelation,
  createRunCorrelationEnvelope,
  readRunCorrelation,
  runtimeCorrelationIdentityDeclaration,
  validateRunCorrelationEnvelope,
  validateRunCorrelationPresence,
} from "../../build/src/index.js";
import { validateSchemaValue } from "../../build/src/lib/mini-json-schema.js";

const schema = JSON.parse(readFileSync(
  new URL("../../schemas/run-correlation-envelope.schema.json", import.meta.url),
  "utf8",
));
const workflowStateSchema = JSON.parse(readFileSync(
  new URL("../../schemas/workflow-state.schema.json", import.meta.url),
  "utf8",
));

function explicitIdentities() {
  return Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
    key,
    key === "flow_run"
      ? { status: "present", value: "flow-run-123" }
      : { status: "unavailable", reason: `${key} was not supplied by this runtime` },
  ]));
}

test("creates a versioned envelope with an opaque generated identity", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  assert.equal(envelope.schema_version, "1.0");
  assert.match(envelope.correlation_id, /^run-[0-9a-f-]{36}$/);
  assert.deepEqual(envelope.identities.flow_run, { status: "present", value: "flow-run-123" });
});

test("accepts a caller-owned correlation identity and returns a defensive copy", () => {
  const identities = explicitIdentities();
  const envelope = createRunCorrelationEnvelope({
    correlation_id: "external-run:abc-123",
    identities,
  });
  identities.flow_run.value = "mutated";
  assert.equal(envelope.correlation_id, "external-run:abc-123");
  assert.equal(envelope.identities.flow_run.value, "flow-run-123");
});

test("requires every identity slot to declare support or absence", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  delete envelope.identities.runtime_turn;
  assert.throws(
    () => validateRunCorrelationEnvelope(envelope),
    (error) => error instanceof RunCorrelationValidationError
      && error.issues.some((issue) => issue.includes("runtime_turn")),
  );
});

test("fails closed on unknown fields and mismatched status/value shapes", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  envelope.extra = true;
  envelope.identities.agent = { status: "present", reason: "not a value" };
  assert.throws(
    () => validateRunCorrelationEnvelope(envelope),
    (error) => error instanceof RunCorrelationValidationError
      && error.issues.includes("envelope has unknown properties")
      && error.issues.includes("identities.agent has invalid present properties"),
  );
});

test("rejects credential-shaped identities and reasons", () => {
  const identities = explicitIdentities();
  identities.runtime_session = { status: "present", value: "sk_testcredential123" };
  identities.runtime_turn = { status: "unsupported", reason: "token=secret-value" };
  assert.throws(
    () => createRunCorrelationEnvelope({ identities }),
    (error) => error instanceof RunCorrelationValidationError
      && error.issues.some((issue) => issue.includes("runtime_session.value"))
      && error.issues.some((issue) => issue.includes("runtime_turn.reason")),
  );
  const credential = (...parts) => parts.join("");
  for (const value of [
    credential("xox", "b-1234567890-abcdefghijklmnop"),
    credential("AK", "IAIOSFODNN7EXAMPLE"),
    credential("gl", "pat-abcdefghijklmnop"),
    credential("github_", "pat_11AA22BB33CC44DD55"),
    credential("S", "G.abcdefghijklmnop.qrstuvwxyz123456"),
    credential("AI", "zaSyDUMMY1234567890abcdefghij"),
    credential("wh", "sec_1234567890abcdefghijklmnop"),
    credential("sk_", "live_1234567890abcdefghijklmnop"),
    credential("sk-", "proj-1234567890abcdefghijklmnop"),
    credential("sk-", "ant-api03-1234567890abcdefghijklmnop"),
    credential("sq0", "atp-1234567890abcdefghijklmnop"),
  ]) {
    const tokenIdentities = explicitIdentities();
    tokenIdentities.runtime_session = { status: "present", value };
    assert.throws(
      () => createRunCorrelationEnvelope({ identities: tokenIdentities }),
      RunCorrelationValidationError,
    );
  }
});

test("explicit incomplete correlation is read consistently and rejects sensitive reasons", () => {
  const incomplete = {
    status: "incomplete",
    reason: "the producer did not support canonical correlation",
  };
  assert.deepEqual(validateRunCorrelationPresence(incomplete), incomplete);
  assert.deepEqual(readRunCorrelation({ run_correlation: incomplete }), incomplete);
  assert.throws(
    () => validateRunCorrelationPresence({
      status: "incomplete",
      reason: "token=secret-value",
    }),
    (error) => error instanceof RunCorrelationValidationError
      && error.issues.some((issue) => issue.includes("non-sensitive")),
  );
});

test("runtime-valid envelopes satisfy the shipped structural schema", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  const issues = [];
  validateSchemaValue("run-correlation.json", envelope, schema, "$", issues, schema);
  assert.deepEqual(issues, []);
});

test("authority-owned work-item references remain valid opaque identities", () => {
  for (const value of ["github:kontourai/flow-agents#924", "kontourai/flow-agents#924"]) {
    const identities = explicitIdentities();
    identities.work_item = { status: "present", value };
    const envelope = createRunCorrelationEnvelope({ identities });
    const issues = [];
    validateSchemaValue("run-correlation.json", envelope, schema, "$", issues, schema);
    assert.deepEqual(issues, []);
  }
});

test("runtime and schema both reject oversized provider work-item references", () => {
  const identities = explicitIdentities();
  identities.work_item = {
    status: "present",
    value: `github:kontourai/${"flow-agents-".repeat(30)}#924`,
  };
  assert.ok(identities.work_item.value.length > 255);
  assert.throws(
    () => createRunCorrelationEnvelope({ identities }),
    RunCorrelationValidationError,
  );
  const candidate = {
    schema_version: "1.0",
    correlation_id: "oversized-work-item",
    identities,
  };
  const issues = [];
  validateSchemaValue("run-correlation.json", candidate, schema, "$", issues, schema);
  assert.ok(issues.length > 0);
});

test("ordinary identifiers containing an embedded sk- sequence are not credentials", () => {
  const identities = explicitIdentities();
  identities.flow_run = { status: "present", value: "recover-task-slug-mismatch" };
  const envelope = createRunCorrelationEnvelope({
    identities,
  });
  assert.equal(envelope.identities.flow_run.value, "recover-task-slug-mismatch");
});

test("non-work-item identities reject paths and URI-shaped values", () => {
  for (const value of ["/tmp/session", "C:/Users/session", "https://example.test/session"]) {
    const identities = explicitIdentities();
    identities.runtime_session = { status: "present", value };
    assert.throws(
      () => createRunCorrelationEnvelope({ identities }),
      RunCorrelationValidationError,
    );
  }
});

test("shipped workflow state schema resolves canonical correlation and explicit incomplete forms", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(schema);
  const validate = ajv.compile(workflowStateSchema);
  const state = {
    schema_version: "1.0",
    task_slug: "correlated-state",
    status: "planned",
    phase: "planning",
    updated_at: "2026-07-24T00:00:00.000Z",
    next_action: { status: "continue", summary: "Continue." },
  };
  assert.equal(validate({
    ...state,
    run_correlation: createRunCorrelationEnvelope({ identities: explicitIdentities() }),
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...state,
    run_correlation: {
      status: "incomplete",
      reason: "the run predates canonical correlation",
    },
  }), true, JSON.stringify(validate.errors));
});

test("runtime and schema both reject a missing identity slot", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  delete envelope.identities.delegation_span;
  const issues = [];
  validateSchemaValue("run-correlation.json", envelope, schema, "$", issues, schema);
  assert(issues.some((issue) => issue.message.includes("delegation_span")));
  assert.throws(() => validateRunCorrelationEnvelope(envelope), RunCorrelationValidationError);
});

test("one immutable envelope stamps telemetry, trust, economics, delegation, and terminal records", () => {
  const envelope = createRunCorrelationEnvelope({
    correlation_id: "run-shared-123",
    identities: explicitIdentities(),
  });
  const records = [
    { kind: "runtime.telemetry", event_id: "event-1" },
    { kind: "flow.step", step_id: "verify" },
    { kind: "trust.reference", artifact_ref: "trust.bundle" },
    { kind: "economics", input_tokens: 12 },
    { kind: "delegation", worker: "worker-1" },
    { kind: "terminal", outcome: "accepted" },
  ].map((record) => attachRunCorrelation(record, envelope));

  assert(records.every((record) => record.run_correlation.correlation_id === "run-shared-123"));
  records[0].run_correlation.identities.flow_run.value = "mutated";
  assert.equal(records[1].run_correlation.identities.flow_run.value, "flow-run-123");
});

test("legacy records remain explicitly incomplete instead of receiving a heuristic join", () => {
  assert.deepEqual(readRunCorrelation({
    session_id: "looks-related",
    cwd: "/same/repository",
    timestamp: "2026-07-23T12:00:00Z",
  }), {
    status: "incomplete",
    reason: "record predates run correlation or its producer did not provide an envelope",
  });
});

test("concurrent runs cannot cross-join even when all surrounding fields match", () => {
  const first = attachRunCorrelation(
    { cwd: "/same/repository", work_item: "same-item" },
    createRunCorrelationEnvelope({ correlation_id: "run-a", identities: explicitIdentities() }),
  );
  const second = attachRunCorrelation(
    { cwd: "/same/repository", work_item: "same-item" },
    createRunCorrelationEnvelope({ correlation_id: "run-b", identities: explicitIdentities() }),
  );
  assert.notEqual(
    readRunCorrelation(first).envelope.correlation_id,
    readRunCorrelation(second).envelope.correlation_id,
  );
});

test("runtime adapters declare support for every correlation identity field", () => {
  for (const runtime of ["claude-code", "codex", "kiro", "opencode", "pi", "codex-local", "strands-local", "unknown"]) {
    const declaration = runtimeCorrelationIdentityDeclaration(runtime);
    assert.deepEqual(Object.keys(declaration).sort(), [...RUN_CORRELATION_IDENTITY_KEYS].sort());
  }
  assert.equal(runtimeCorrelationIdentityDeclaration("codex").runtime_turn.status, "supported");
  assert.equal(runtimeCorrelationIdentityDeclaration("opencode").runtime_turn.status, "partial");
  assert.equal(runtimeCorrelationIdentityDeclaration("strands-local").runtime_session.status, "not_applicable");
});
