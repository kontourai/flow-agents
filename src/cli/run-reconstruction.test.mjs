import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_CORRELATION_IDENTITY_KEYS,
  createRunCorrelationEnvelope,
} from "../../build/src/run-correlation.js";
import {
  RUN_FACT_KINDS,
  joinIndependentEvaluation,
  reconstructRun,
} from "../../build/src/run-reconstruction.js";

function envelope(correlationId, flowRun) {
  return createRunCorrelationEnvelope({
    correlation_id: correlationId,
    identities: Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
      key,
      key === "flow_run"
        ? { status: "present", value: flowRun }
        : { status: "unavailable", reason: `${key} unavailable in fixture` },
    ])),
  });
}

function fact(kind, correlation, extra = {}) {
  return {
    kind,
    record_id: `${correlation.correlation_id}-${kind}`,
    run_correlation: correlation,
    ...extra,
  };
}

test("identity-only reconstruction recovers the complete nested Builder account", () => {
  const parent = envelope("parent-correlation", "flow-parent");
  const child = envelope("child-correlation", "flow-child");
  const parentFacts = RUN_FACT_KINDS.map((kind) => fact(kind, parent, {
    ...(kind === "delegation" ? { child_correlation_id: child.correlation_id } : {}),
    ...(kind === "terminal" ? { process_status: "completed" } : {}),
  }));
  const childFacts = RUN_FACT_KINDS.map((kind) => fact(kind, child, {
    ...(kind === "terminal" ? { process_status: "completed" } : {}),
  }));

  const reconstructed = reconstructRun([...childFacts, ...parentFacts], parent.correlation_id);
  assert.deepEqual(reconstructed.missing_kinds, []);
  assert.deepEqual(reconstructed.child_correlation_ids, ["child-correlation"]);
  assert.equal(reconstructed.facts.length, RUN_FACT_KINDS.length);
  assert(reconstructed.facts.every((item) => item.run_correlation.correlation_id === "parent-correlation"));
});

test("concurrent runs with identical surrounding fields never cross-join", () => {
  const first = envelope("concurrent-a", "same-flow-label");
  const second = envelope("concurrent-b", "same-flow-label");
  const records = [
    fact("runtime_session", first),
    fact("terminal", first, { process_status: "completed" }),
    fact("runtime_session", second),
    fact("terminal", second, { process_status: "failed" }),
  ];
  assert.equal(reconstructRun(records, "concurrent-a").process_status, "completed");
  assert.equal(reconstructRun(records, "concurrent-b").process_status, "failed");
});

test("external eval identity and independent grade join without entering Builder facts", () => {
  const correlation = envelope("evaluated-run", "flow-evaluated");
  const facts = [
    fact("runtime_session", correlation),
    fact("terminal", correlation, { process_status: "completed" }),
  ];
  const run = reconstructRun(facts, correlation.correlation_id);
  const joined = joinIndependentEvaluation(run, {
    correlation_id: correlation.correlation_id,
    eval_cell_id: "cell-codex-local",
    attempt_id: "attempt-3",
    grade_status: "rejected",
    score: 0.4,
  });

  assert.equal(joined.process_complete, true);
  assert.equal(joined.task_quality_accepted, false);
  assert.equal(joined.evaluation.eval_cell_id, "cell-codex-local");
  assert(facts.every((item) => !("eval_cell_id" in item) && !("grade_status" in item)));
});

test("Builder facts reject hidden experiment and grader fields", () => {
  const correlation = envelope("guarded-run", "flow-guarded");
  assert.throws(() => reconstructRun([
    { ...fact("terminal", correlation), experiment_arm: "hidden-treatment" },
  ], correlation.correlation_id), /must not contain evaluation field/);
});
