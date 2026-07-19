import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT,
  TELEMETRY_CHANNEL_FULL_REDACT_DEFAULT,
  effectiveNarrativeRedactionFields,
  filterNarrativeRecord,
} from "../../build/src/index.js";

function bashDefault(name) {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const config = fs.readFileSync(path.join(repoRoot, "scripts/telemetry/lib/config.sh"), "utf8");
  const match = new RegExp(`${name}="\\$\\{${name}:-([^}]*)\\}"`).exec(config);
  assert.ok(match, `${name} default must remain parseable`);
  return match[1].split(",");
}

test("TypeScript redaction defaults cannot drift from config.sh", () => {
  assert.deepEqual([...TELEMETRY_CHANNEL_FULL_REDACT_DEFAULT], bashDefault("TELEMETRY_CHANNEL_FULL_REDACT"));
  assert.deepEqual([...TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT], bashDefault("TELEMETRY_CHANNEL_ANALYTICS_REDACT"));
});

test("effective narrative fields union full-channel and caller-specific policy", () => {
  assert.deepEqual(effectiveNarrativeRedactionFields(["tool.output", "custom.secret"]), [
    "hook.raw_input", "turn.prompt_text", "tool.input", "tool.output", "custom.secret",
  ]);
});

test("filter nulls whole fields by dotted path on a structured clone", () => {
  const input = { hook: { raw_input: "secret", keep: 1 }, tool: { input: { token: "secret" }, output: "secret" }, safe: true };
  const result = filterNarrativeRecord(input, effectiveNarrativeRedactionFields());
  assert.equal(result.kind, "filtered");
  assert.equal(result.record.hook.raw_input, null);
  assert.equal(result.record.tool.input, null);
  assert.equal(result.record.tool.output, null);
  assert.equal(result.record.safe, true);
  assert.equal(input.hook.raw_input, "secret");
});

test("unparsable records and unresolvable policy fail closed without echoing values", () => {
  const secret = "NEVER_ECHO_THIS_VALUE";
  for (const result of [
    filterNarrativeRecord(`{"tool":{"input":"${secret}"}`, ["tool.input"]),
    filterNarrativeRecord({ tool: { input: secret } }, undefined),
  ]) {
    assert.equal(result.kind, "redacted");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("field-nulling failures report field names only", () => {
  const secret = "VALUE_MUST_STAY_PRIVATE";
  const result = filterNarrativeRecord({ tool: secret }, ["tool.input"]);
  assert.equal(result.kind, "redacted");
  assert.match(result.diagnostic, /tool\.input/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("prototype-shaped policy paths fail closed", () => {
  const result = filterNarrativeRecord({ safe: true }, ["__proto__.polluted"]);
  assert.equal(result.kind, "redacted");
  assert.equal({}.polluted, undefined);
});
