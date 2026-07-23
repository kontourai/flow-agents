import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  RunCorrelationValidationError,
  createRunCorrelationEnvelope,
  validateRunCorrelationEnvelope,
} from "../../build/src/index.js";
import { validateSchemaValue } from "../../build/src/lib/mini-json-schema.js";

const schema = JSON.parse(readFileSync(
  new URL("../../schemas/run-correlation-envelope.schema.json", import.meta.url),
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
});

test("runtime-valid envelopes satisfy the shipped structural schema", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  const issues = [];
  validateSchemaValue("run-correlation.json", envelope, schema, "$", issues, schema);
  assert.deepEqual(issues, []);
});

test("runtime and schema both reject a missing identity slot", () => {
  const envelope = createRunCorrelationEnvelope({ identities: explicitIdentities() });
  delete envelope.identities.delegation_span;
  const issues = [];
  validateSchemaValue("run-correlation.json", envelope, schema, "$", issues, schema);
  assert(issues.some((issue) => issue.message.includes("delegation_span")));
  assert.throws(() => validateRunCorrelationEnvelope(envelope), RunCorrelationValidationError);
});
