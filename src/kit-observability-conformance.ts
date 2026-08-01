/**
 * Stable cross-host conformance surface for Kit observability hosts.
 *
 * Console and Station can import this subpath without filesystem fixtures or
 * Flow Agents internals. The vectors exercise lifecycle, presentation,
 * navigation, provenance, and graceful degradation; host consumption remains
 * separately verifiable in their owning repositories.
 */
import {
  kitObservabilityDescriptorDigest,
  negotiateKitObservabilityContribution,
  validateKitObservabilityRecord,
} from "./kit-observability-contract.js";
import type {
  KitObservabilityAuthorityRefs,
  KitObservabilityContribution,
  KitObservabilityHostState,
  KitObservabilityNegotiation,
  KitObservabilityOperatorAction,
  KitObservabilityRecord,
} from "./kit-observability-contract.js";

export type KitObservabilityConformanceRecord = {
  name: string;
  projection_kind: "run_summary";
  authority_refs: KitObservabilityAuthorityRefs;
  data: Record<string, unknown>;
};

export type KitObservabilityConformanceVector = {
  id: string;
  description: string;
  contribution: KitObservabilityContribution;
  host: KitObservabilityHostState;
  record?: KitObservabilityConformanceRecord;
  expected: {
    status: KitObservabilityNegotiation["status"];
    presentation_kind?: "mcp_apps_resource_bridge" | "standard_views";
    navigation_intents: KitObservabilityOperatorAction["intent"][];
    diagnostic_codes: string[];
    provenance?: boolean;
    descriptor_digest?: string;
  };
};

export type KitObservabilityHostAdapter = {
  negotiate: (contribution: KitObservabilityContribution, host: KitObservabilityHostState) => KitObservabilityNegotiation;
  validateRecord: (record: unknown, contribution: KitObservabilityContribution) => KitObservabilityRecord;
  descriptorDigest: (contribution: KitObservabilityContribution) => string;
};

export type KitObservabilityConformanceReport = {
  passed: boolean;
  results: { id: string; passed: boolean; failures: string[] }[];
};

const contribution: KitObservabilityContribution = {
  apiVersion: "flowagents.kontourai.io/v1alpha1",
  kind: "KitObservabilityContribution",
  metadata: { name: "sample-observability" },
  spec: {
    contract_version: "1.0",
    package_ref: "npm:@example/observability-kit@1.0.0",
    projections: { run_summary: { schema_ref: "https://example.test/schemas/run-summary/1.0.json" } },
    authority_refs: {
      flow: "flowagents.kontourai.io/v1alpha1/WorkflowRun",
      surface: "surface.kontourai.io/v1alpha1/TrustBundle",
      runtime: "flowagents.kontourai.io/v1alpha1/RunCorrelationEnvelope",
    },
    host: {
      required_capabilities: ["standard_views"],
      optional_capabilities: ["mcp_apps_resource_bridge"],
      presentation: {
        preferred: {
          kind: "mcp_apps_resource_bridge",
          resource: { uri: "ui://example.test/kits/sample-observability/observability", mime_type: "text/html;profile=mcp-app" },
          bridge: { tool_name: "sample-observability", visibility: ["model", "app"] },
        },
        fallback: { kind: "standard_views", source: "declared_projections" },
      },
    },
    data_policy: { redaction: "declared", retention: "kit_owned", raw_source: "available" },
    operator_intents: [
      { intent: "open_resource", label: "Open workflow run", required_capability: "resource.open", target: { authority: "flow", kind: "workflow_run" } },
      { intent: "review_proposal", label: "Review proposal", required_capability: "proposal.review", target: { authority: "surface", kind: "proposal" } },
    ],
    compatibility: { unsupported_version: "diagnostic" },
  },
};

const record: KitObservabilityConformanceRecord = {
  name: "sample-observability-run",
  projection_kind: "run_summary",
  authority_refs: {
    flow: "flow://workflow-runs/sample-observability-run",
    surface: "surface://trust-bundles/sample-observability-run",
    runtime: "runtime://run-correlation/sample-observability-run",
  },
  data: { state: "observed" },
};

export const KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST = "sha256:45a0e4172592a5138462a74a832b22a170a49386f4c234da94ff33c8733c5f6b" as const;

export const KIT_OBSERVABILITY_CONFORMANCE_VECTORS: readonly KitObservabilityConformanceVector[] = Object.freeze([
  {
    id: "mcp-apps-navigation-provenance",
    description: "MCP Apps resource bridge exposes station-compatible resource metadata, navigation intents, and descriptor provenance.",
    contribution,
    host: { installed: true, enabled: true, supported_contract_versions: ["1.0"], capabilities: ["standard_views", "mcp_apps_resource_bridge", "resource.open", "proposal.review"] },
    record,
    expected: { status: "enabled", presentation_kind: "mcp_apps_resource_bridge", navigation_intents: ["open_resource", "review_proposal"], diagnostic_codes: [], provenance: true, descriptor_digest: KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST },
  },
  {
    id: "standard-view-degradation",
    description: "A host without optional MCP Apps or navigation capabilities falls back to declared standard views without blocking the Kit.",
    contribution,
    host: { installed: true, enabled: true, supported_contract_versions: ["1.0"], capabilities: ["standard_views"] },
    expected: { status: "enabled", presentation_kind: "standard_views", navigation_intents: [], diagnostic_codes: ["optional_host_capability_unavailable", "operator_intent_capability_unavailable", "operator_intent_capability_unavailable"], provenance: true, descriptor_digest: KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST },
  },
  {
    id: "disabled-contribution",
    description: "Host disablement is typed and leaves the underlying Kit headless.",
    contribution,
    host: { installed: true, enabled: false, supported_contract_versions: ["1.0"], capabilities: ["standard_views"] },
    expected: { status: "disabled", navigation_intents: [], diagnostic_codes: ["contribution_disabled"] },
  },
  {
    id: "unsupported-host-contract",
    description: "A host with no supported contract version reports an incompatible optional contribution.",
    contribution,
    host: { installed: true, enabled: true, supported_contract_versions: [], capabilities: ["standard_views"] },
    expected: { status: "incompatible", navigation_intents: [], diagnostic_codes: ["host_contract_version_unsupported"] },
  },
]);

const defaultAdapter: KitObservabilityHostAdapter = {
  negotiate: (descriptor, host) => negotiateKitObservabilityContribution({ status: "supported", contribution: descriptor, diagnostics: [] }, host),
  validateRecord: validateKitObservabilityRecord,
  descriptorDigest: kitObservabilityDescriptorDigest,
};

/** Run the supported vectors against a host adapter; no Kit or host installation is required. */
export function runKitObservabilityConformance(adapter: KitObservabilityHostAdapter = defaultAdapter): KitObservabilityConformanceReport {
  const results = KIT_OBSERVABILITY_CONFORMANCE_VECTORS.map((vector) => {
    const failures: string[] = [];
    const canonicalDescriptorDigest = kitObservabilityDescriptorDigest(vector.contribution);
    if (vector.expected.descriptor_digest && canonicalDescriptorDigest !== vector.expected.descriptor_digest) failures.push(`package canonical descriptor digest: expected ${vector.expected.descriptor_digest}, got ${canonicalDescriptorDigest}`);
    const adapterDescriptorDigest = adapter.descriptorDigest(vector.contribution);
    if (adapterDescriptorDigest !== canonicalDescriptorDigest) failures.push(`adapter descriptor digest: expected package canonical ${canonicalDescriptorDigest}, got ${adapterDescriptorDigest}`);
    const negotiation = adapter.negotiate(vector.contribution, vector.host);
    if (negotiation.status !== vector.expected.status) failures.push(`status: expected ${vector.expected.status}, got ${negotiation.status}`);
    if (vector.expected.presentation_kind && negotiation.presentation?.kind !== vector.expected.presentation_kind) failures.push(`presentation: expected ${vector.expected.presentation_kind}, got ${negotiation.presentation?.kind ?? "none"}`);
    const intents = negotiation.navigation.available_operator_intents.map((intent) => intent.intent);
    if (JSON.stringify(intents) !== JSON.stringify(vector.expected.navigation_intents)) failures.push(`navigation intents: expected ${vector.expected.navigation_intents.join(",")}, got ${intents.join(",")}`);
    const diagnostics = negotiation.diagnostics.map((diagnostic) => diagnostic.code);
    if (JSON.stringify(diagnostics) !== JSON.stringify(vector.expected.diagnostic_codes)) failures.push(`diagnostics: expected ${vector.expected.diagnostic_codes.join(",")}, got ${diagnostics.join(",")}`);
    if (vector.expected.provenance) {
      if (!negotiation.provenance || negotiation.provenance.descriptor_digest !== canonicalDescriptorDigest) failures.push("missing or mismatched descriptor provenance");
    }
    if (vector.record) {
      const boundRecord = {
        apiVersion: "flowagents.kontourai.io/v1alpha1",
        kind: "KitObservabilityRecord",
        metadata: { name: vector.record.name },
        spec: {
          binding: { contribution_ref: vector.contribution.metadata.name, descriptor_digest: canonicalDescriptorDigest, package_ref: vector.contribution.spec.package_ref },
          projection: { kind: vector.record.projection_kind },
          authority_refs: vector.record.authority_refs,
          data: vector.record.data,
        },
      };
      try {
        adapter.validateRecord(boundRecord, vector.contribution);
      } catch (error) {
        failures.push(`record provenance: ${error instanceof Error ? error.message : "validation failed"}`);
      }
    }
    return { id: vector.id, passed: failures.length === 0, failures };
  });
  return { passed: results.every((result) => result.passed), results };
}
