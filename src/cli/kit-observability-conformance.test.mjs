import assert from "node:assert/strict";
import test from "node:test";
import {
  KIT_OBSERVABILITY_CONFORMANCE_VECTORS,
  runKitObservabilityConformance,
} from "@kontourai/flow-agents/kit-observability-conformance";

test("the public conformance subpath exposes lifecycle, presentation, navigation, and provenance vectors", () => {
  assert.equal(KIT_OBSERVABILITY_CONFORMANCE_VECTORS.length, 4);
  assert.deepEqual(KIT_OBSERVABILITY_CONFORMANCE_VECTORS.map(({ id }) => id), [
    "mcp-apps-navigation-provenance",
    "standard-view-degradation",
    "disabled-contribution",
    "unsupported-host-contract",
  ]);
  const report = runKitObservabilityConformance();
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.ok(report.results.every((result) => result.passed));
});
