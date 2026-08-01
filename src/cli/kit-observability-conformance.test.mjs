import assert from "node:assert/strict";
import test from "node:test";
import {
  KIT_OBSERVABILITY_CONFORMANCE_VECTORS,
  KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST,
  runKitObservabilityConformance,
} from "@kontourai/flow-agents/kit-observability-conformance";
import {
  kitObservabilityDescriptorDigest,
  negotiateKitObservabilityContribution,
  validateKitObservabilityRecord,
} from "@kontourai/flow-agents/kit-observability-contract";

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
  assert.equal(KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST, "sha256:45a0e4172592a5138462a74a832b22a170a49386f4c234da94ff33c8733c5f6b");
  assert.equal(kitObservabilityDescriptorDigest(KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution), KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST);
});

test("a host adapter cannot self-attest a rewritten descriptor digest", () => {
  const adapter = {
    negotiate: (contribution, host) => negotiateKitObservabilityContribution({ status: "supported", contribution, diagnostics: [] }, host),
    validateRecord: validateKitObservabilityRecord,
    descriptorDigest: () => `sha256:${"0".repeat(64)}`,
  };
  const report = runKitObservabilityConformance(adapter);
  assert.equal(report.passed, false);
  assert.ok(report.results.some((result) => result.failures.some((failure) => failure.startsWith("adapter descriptor digest:"))));
});
