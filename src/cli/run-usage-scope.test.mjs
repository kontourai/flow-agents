import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helper = path.resolve("scripts/telemetry/run-usage-scope.js");

function envelope(id) {
  return {
    schema_version: "1.0",
    correlation_id: id,
    identities: {},
  };
}

function usage(input, output, cost, duration = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated_cost_usd: cost,
    duration_s: duration,
    by_model: [{
      model: "fixture-model",
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      estimated_cost_usd: cost,
    }],
  };
}

function run(action, root, payload) {
  const output = execFileSync("node", [helper, action, root], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return output.trim() ? JSON.parse(output) : null;
}

test("sequential Builder correlations subtract independent runtime usage baselines", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-usage-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runA = envelope("run-a");
  const runB = envelope("run-b");

  run("--capture", root, { run_correlation: runA, usage: usage(100, 20, 0.1, 40) });
  const terminalA = run("--delta", root, { run_correlation: runA, usage: usage(160, 50, 0.18, 90) });
  assert.equal(terminalA.usage.input_tokens, 60);
  assert.equal(terminalA.usage.output_tokens, 30);
  assert.equal(terminalA.usage.scope, "run");
  assert.equal(terminalA.usage.baseline_status, "present");
  assert.equal(terminalA.usage.duration_s, 50);

  run("--capture", root, { run_correlation: runB, usage: usage(160, 50, 0.18, 90) });
  const terminalB = run("--delta", root, { run_correlation: runB, usage: usage(190, 65, 0.23, 125) });
  assert.equal(terminalB.usage.input_tokens, 30);
  assert.equal(terminalB.usage.output_tokens, 15);
  assert.ok(Math.abs(terminalB.usage.estimated_cost_usd - 0.05) < 1e-9);
  assert.equal(terminalB.usage.duration_s, 35);
});

test("missing baseline remains explicitly session-scoped", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-usage-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run("--delta", root, {
    run_correlation: envelope("run-without-baseline"),
    usage: usage(100, 20, 0.1),
  });
  assert.equal(result.usage.scope, "session");
  assert.equal(result.usage.baseline_status, "unavailable");
  assert.equal(result.usage.input_tokens, 100);
});
