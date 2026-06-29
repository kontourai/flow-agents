// Claim explanation — a PURE projection extracted from workflow-sidecar.ts (ops#22).
//
// buildClaimExplanation is a pure function: report + bundle + id in, structured
// explanation out. No fs, no CLI, no .flow-agents paths, no shared module state —
// zero flow-agents specifics inside it, so it is unit-testable in isolation and can
// be lifted to Surface unchanged (issue #171). The IO command handler `claimLookup`
// that consumes it stays in workflow-sidecar.ts.

type AnyObj = Record<string, any>;

export interface ClaimEvidenceItem {
  evidenceType: string;
  label: string;
  execution: { runner: string; label: string; isError: boolean; exitCode: number | null } | null;
  passing: boolean;
  summary: string;
}

export interface ClaimExplanation {
  found: boolean;
  status: string;
  value: string;
  claimType: string;
  evidence: ClaimEvidenceItem[];
  policy: {
    id: string;
    requiredEvidence: string[];
    requiredMethods?: string[];
    acceptanceCriteria: string[];
    reviewAuthority: string;
  } | null;
  why: {
    directInputs: AnyObj[];
    leafClaims: AnyObj[];
    diagnostics: AnyObj[];
    transparencyGaps: AnyObj[];
    changeRecords: AnyObj[];
  };
}

/**
 * Build a structured explanation for a specific claim.
 * PURE: report + bundle + id in, structured explanation out.
 * No fs, no CLI, no .flow-agents paths. Promotable to Surface #171.
 *
 * @param report   TrustReport from buildTrustReport(bundle) — required for derived status
 * @param bundle   Raw parsed trust.bundle (BundleFile shape)
 * @param claimId  The claim id to explain
 */
export function buildClaimExplanation(
  report: Record<string, unknown>,
  bundle: Record<string, unknown>,
  claimId: string,
): ClaimExplanation {
  const reportClaims = Array.isArray(report.claims) ? (report.claims as AnyObj[]) : [];
  const reportClaim = reportClaims.find((c: AnyObj) => c.id === claimId);

  if (!reportClaim) {
    return {
      found: false,
      status: "unknown",
      value: "",
      claimType: "",
      evidence: [],
      policy: null,
      why: { directInputs: [], leafClaims: [], diagnostics: [], transparencyGaps: [], changeRecords: [] },
    };
  }

  const bundleClaims = Array.isArray(bundle.claims) ? (bundle.claims as AnyObj[]) : [];
  const bundleClaim = bundleClaims.find((c: AnyObj) => c.id === claimId) ?? reportClaim;
  const bundlePolicies = Array.isArray(bundle.policies) ? (bundle.policies as AnyObj[]) : [];
  const bundleEvidence = Array.isArray(bundle.evidence) ? (bundle.evidence as AnyObj[]) : [];

  // Governing policy — follow verificationPolicyId into bundle.policies[]
  const verificationPolicyId = typeof bundleClaim.verificationPolicyId === "string" ? bundleClaim.verificationPolicyId : undefined;
  const rawPolicy = verificationPolicyId ? bundlePolicies.find((p: AnyObj) => p.id === verificationPolicyId) : undefined;
  const policy = rawPolicy
    ? {
        id: String(rawPolicy.id ?? ""),
        requiredEvidence: Array.isArray(rawPolicy.requiredEvidence) ? (rawPolicy.requiredEvidence as string[]) : [],
        requiredMethods: Array.isArray(rawPolicy.requiredMethods) ? (rawPolicy.requiredMethods as string[]) : undefined,
        acceptanceCriteria: Array.isArray(rawPolicy.acceptanceCriteria) ? (rawPolicy.acceptanceCriteria as string[]) : [],
        reviewAuthority: String(rawPolicy.reviewAuthority ?? ""),
      }
    : null;

  // Evidence enhancement: pull evidence items for this claim, surface the execution block
  const claimEvidenceItems = bundleEvidence.filter((ev: AnyObj) => ev && ev.claimId === claimId);
  const evidence: ClaimEvidenceItem[] = claimEvidenceItems.map((ev: AnyObj) => {
    const exec = ev.execution && typeof ev.execution === "object" ? (ev.execution as AnyObj) : null;
    const execution = exec
      ? {
          runner: String(exec.runner ?? exec.label ?? ""),
          label: String(exec.label ?? exec.runner ?? ""),
          isError: Boolean(exec.isError ?? (typeof exec.exitCode === "number" && exec.exitCode !== 0)),
          exitCode: typeof exec.exitCode === "number" ? exec.exitCode : null,
        }
      : null;
    return {
      evidenceType: String(ev.evidenceType ?? ev.type ?? "unknown"),
      label: String(ev.label ?? ev.excerptOrSummary ?? ev.sourceRef ?? ev.id ?? ""),
      execution,
      passing: execution ? !execution.isError : String(ev.status ?? "") !== "disputed",
      summary: String(ev.excerptOrSummary ?? ev.summary ?? ev.label ?? ""),
    };
  });

  // Drilldown: extract from report structure (report.transparencyGaps, report.changeRecords)
  const allGaps = Array.isArray(report.transparencyGaps) ? (report.transparencyGaps as AnyObj[]) : [];
  const allChanges = Array.isArray(report.changeRecords) ? (report.changeRecords as AnyObj[]) : [];
  const transparencyGaps = allGaps.filter((g: AnyObj) => g && g.claimId === claimId);
  const changeRecords = allChanges.filter((c: AnyObj) => c && c.claimId === claimId);

  return {
    found: true,
    status: String(reportClaim.status ?? "unknown"),
    value: String(bundleClaim.value ?? reportClaim.value ?? ""),
    claimType: String(bundleClaim.claimType ?? reportClaim.claimType ?? ""),
    evidence,
    policy,
    why: {
      directInputs: [],   // populated by buildDerivationDrilldown if non-leaf
      leafClaims: [],
      diagnostics: [],
      transparencyGaps,
      changeRecords,
    },
  };
}
