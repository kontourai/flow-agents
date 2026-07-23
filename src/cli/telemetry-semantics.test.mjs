import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionTelemetryRecords,
  reduceUsageObservations,
  validateTelemetryRecord,
} from "../../build/src/telemetry-semantics.js";

test("typed tool results retain lifecycle status, exit code, and duration", () => {
  const record = validateTelemetryRecord({
    event_type: "tool.result",
    tool: { status: "blocked", outcome: "fail", exit_code: 2, duration_ms: 14 },
  });
  assert.equal(record.tool.status, "blocked");
  assert.equal(record.tool.exit_code, 2);
  assert.equal(record.tool.duration_ms, 14);
  assert.equal(record.correlation.status, "incomplete");
});

test("latest cumulative snapshot is counted once while independent deltas sum", () => {
  const total = reduceUsageObservations([
    { stream_id: "session-a", sequence: 1, semantics: "snapshot", values: { input_tokens: 10, output_tokens: 2 } },
    { stream_id: "session-a", sequence: 2, semantics: "snapshot", values: { input_tokens: 25, output_tokens: 5 } },
    { stream_id: "turn-b", sequence: 1, semantics: "delta", values: { input_tokens: 3, output_tokens: 1 } },
  ]);
  assert.equal(total.input_tokens, 28);
  assert.equal(total.output_tokens, 6);
});

test("malformed records move to diagnostics without poisoning valid records or leaking raw values", () => {
  const secret = "token=do-not-copy";
  const result = partitionTelemetryRecords([
    { event_type: "tool.result", tool: { status: "completed", exit_code: 0, duration_ms: 1 } },
    { event_type: "tool.result", tool: { status: secret, exit_code: "bad", duration_ms: -1 } },
    { event_type: "session.usage", usage: { semantics: "snapshot" } },
  ]);
  assert.equal(result.valid.length, 2);
  assert.equal(result.quarantine.length, 1);
  assert.equal(result.quarantine[0].index, 1);
  assert.doesNotMatch(JSON.stringify(result.quarantine), /do-not-copy/);
});

test("invalid usage observations fail closed instead of contaminating totals", () => {
  assert.throws(() => reduceUsageObservations([
    { stream_id: "session", sequence: 1, semantics: "snapshot", values: { input_tokens: -1 } },
  ]), /invalid metric/);
});
