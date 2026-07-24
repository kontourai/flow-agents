import test from "node:test";
import assert from "node:assert/strict";

import { canonicalGateProjection } from "../../build/src/canonical-gate-projection.js";

test("canonical gate projection preserves Flow verdicts without host reinterpretation", () => {
  const projection = canonicalGateProjection({
    runId: "run-900",
    definitionId: "builder.build",
    definitionVersion: "1.3",
    definitionDigest: "a".repeat(64),
    state: {
      status: "active",
      current_step: "pr-open",
      gate_outcomes: [
        {
          gate_id: "merge-ready-gate",
          status: "pass",
          summary: "ready",
          evidence_refs: ["merge-ready-evidence"],
          matched_expectations: [{ expectation_id: "merge-readiness", evidence_id: "merge-ready-evidence" }],
          diagnostics: [{ code: "claim.valid", severity: "info", path: "$.claims[0]", message: "not projected" }],
        },
        {
          gate_id: "pr-open-gate",
          status: "wait",
          summary: "provider required",
          accepted_exception_id: "exception-1",
        },
      ],
      exceptions: [{ id: "exception-1", gate_id: "pr-open-gate", reason: "fixture" }],
    },
  });

  assert.deepEqual(projection, {
    schema: "kontour.flow-agents.canonical_gate_projection",
    version: "1.0",
    run_id: "run-900",
    definition_id: "builder.build",
    definition_version: "1.3",
    definition_digest: "a".repeat(64),
    status: "active",
    current_step: "pr-open",
    gates: [
      {
        gate_id: "merge-ready-gate",
        status: "pass",
        evidence_refs: ["merge-ready-evidence"],
        matched_expectations: [{ expectation_id: "merge-readiness", evidence_id: "merge-ready-evidence" }],
        diagnostics: [{ code: "claim.valid", severity: "info", path: "$.claims[0]" }],
      },
      {
        gate_id: "pr-open-gate",
        status: "wait",
        evidence_refs: [],
        matched_expectations: [],
        accepted_exception_id: "exception-1",
        diagnostics: [],
      },
    ],
    accepted_exceptions: [{ id: "exception-1", gate_id: "pr-open-gate", reason: "fixture" }],
  });
});
