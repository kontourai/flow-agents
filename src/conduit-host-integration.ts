import {
  createConformanceReport,
  renderConformanceMatrix,
  serializeConformanceReport,
  type AdapterConformanceEvidence,
  type ConformanceReport,
  type ConformanceResult,
  type EvidenceInput,
  type HostCapabilities,
} from "@kontourai/conduit";

export interface GeneratedHostConformanceEvidence {
  readonly report: ConformanceReport;
  readonly json: string;
  readonly matrix: string;
}

/**
 * Derive product-neutral limitations from a capability declaration and its
 * executable results. Runtime-specific claims remain in Conduit profiles; this
 * projection merely makes every non-native fidelity and failed probe visible.
 */
export function deriveHostIntegrationLimitations(
  capabilities: HostCapabilities,
  results: readonly ConformanceResult[] = [],
): string[] {
  const limitations: string[] = [];
  for (const phase of ["session-start", "before-model", "before-tool", "after-tool", "stop"] as const) {
    const fidelity = capabilities.lifecycle[phase];
    if (fidelity !== "native") limitations.push(`lifecycle.${phase}=${fidelity}`);
  }
  if (capabilities.contextInjection !== "native") {
    limitations.push(`context-injection=${capabilities.contextInjection}`);
  }
  if (capabilities.blocking !== "native") limitations.push(`blocking=${capabilities.blocking}`);
  for (const kind of ["skill", "agent", "hook", "prompt", "command", "context"] as const) {
    const fidelity = capabilities.install[kind];
    if (fidelity !== "native") limitations.push(`install.${kind}=${fidelity}`);
  }
  for (const result of results) {
    if (result.status === "fail") limitations.push(`conformance.${result.check}=fail`);
  }
  return [...new Set(limitations)].sort();
}

/**
 * Run Conduit's external adapter kit and serialize stable evidence. Flow Agents
 * adds no lifecycle, installation, or policy semantics here.
 */
export async function generateHostConformanceEvidence(
  inputs: readonly Omit<EvidenceInput, "limitations">[],
): Promise<GeneratedHostConformanceEvidence> {
  const reports: AdapterConformanceEvidence[] = [];
  for (const input of inputs) {
    const first = await createConformanceReport([{ ...input, limitations: [] }]);
    const evidence = first.adapters[0];
    reports.push({
      ...evidence,
      limitations: deriveHostIntegrationLimitations(evidence.capabilities, evidence.results),
    });
  }
  const report: ConformanceReport = {
    schemaVersion: "1",
    adapters: reports.sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
  };
  return {
    report,
    json: serializeConformanceReport(report),
    matrix: renderConformanceMatrix(report),
  };
}

export type {
  AgentHostAdapter,
  AssetKind,
  ConformanceReport,
  ConformanceResult,
  HostCapabilities,
  InstallationReceipt,
  IntegrationFidelity,
  LifecycleEvent,
  LifecycleOutcome,
  PortableAsset,
} from "@kontourai/conduit";
