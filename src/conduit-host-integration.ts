import {
  createConformanceReport,
  deriveConformanceLimitations,
  renderConformanceMatrix,
  serializeConformanceReport,
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
  return [...deriveConformanceLimitations(capabilities, results)];
}

/**
 * Run Conduit's external adapter kit and serialize stable evidence. Flow Agents
 * adds no lifecycle, installation, or policy semantics here.
 */
export async function generateHostConformanceEvidence(
  inputs: readonly Omit<EvidenceInput, "limitations">[],
): Promise<GeneratedHostConformanceEvidence> {
  const report = await createConformanceReport(inputs.map((input) => ({ ...input, limitations: [] })));
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
