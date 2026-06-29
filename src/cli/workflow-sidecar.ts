#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// ADR 0016 Abstraction A: shared FlowDefinition resolver (P-a)
import { resolveActiveFlowStep, resolveFlowFilePath, resolvePhaseMap, resolveRouteBackPolicy, type ActiveFlowStep } from "../lib/flow-resolver.js";

type AnyObj = Record<string, any>;

export const statuses = new Set(["new", "planning", "planned", "in_progress", "blocked", "verifying", "verified", "needs_decision", "not_verified", "failed", "delivered", "accepted", "archived"]);
export const phases = ["idea", "backlog", "pickup", "planning", "execution", "verification", "goal_fit", "evidence", "release", "learning", "done"];
export const checkKinds = new Set(["build", "types", "lint", "test", "security", "diff", "browser", "runtime", "policy", "external"]);
export const checkStatuses = new Set(["pass", "fail", "not_verified", "skip"]);
export const verdicts = new Set(["pass", "partial", "fail", "not_verified"]);

function now(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function read(file: string): string { return fs.readFileSync(file, "utf8"); }
export function writeJson(file: string, payload: AnyObj): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`); }
// Single-line but readable "key": "value" form. Built by collapsing the
// structural whitespace from an indented stringify — corruption-proof, unlike a
// regex that would also rewrite ":"/"," sequences inside string values.
function spacedLine(payload: AnyObj, replacer?: (string | number)[]): string {
  return JSON.stringify(payload, replacer as never, 1).replace(/\n\s*/g, " ");
}
function printJson(payload: AnyObj): void { console.log(spacedLine(payload)); }
export function loadJson(file: string, fallback: AnyObj = {}): AnyObj { return fs.existsSync(file) ? JSON.parse(read(file)) : { ...fallback }; }
export function appendJsonl(file: string, payload: AnyObj): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = spacedLine(payload, Object.keys(payload).sort());
  fs.appendFileSync(file, `${line}\n`);
}
function die(message: string): never { throw new Error(message); }
function slugify(value: string, fallback: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback; }
/** Derives a deterministic, filesystem-safe slug from a canonical work-item ref like `kontourai/flow-agents#161`.
 * Format: `<owner>-<repo>-<id>` e.g. `kontourai-flow-agents-161`.
 * Reuses slugify() for normalization. Validates that the id is a numeric GitHub issue number. */
function workItemSlug(ref: string): string {
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0 || hashIdx === ref.length - 1) die("--work-item must be in owner/repo#id format");
  const repoPath = ref.slice(0, hashIdx);
  const id = ref.slice(hashIdx + 1);
  if (!/^\d+$/.test(id)) die("--work-item id must be a numeric issue number");
  const parts = repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) die("--work-item repo must be owner/repo format");
  const [owner, repo] = parts;
  return slugify(`${owner}-${repo}-${id}`, "work-item");
}

/**
 * Validate a Hachure trust.bundle using @kontourai/surface's canonical validator
 * (surface is the authoritative owner of trust-bundle schema validation per ADR 0010 / ADR 0015).
 * Returns `{ valid, errors, available }`. When @kontourai/surface is unavailable,
 * `available` is false and `valid` is true (fail-open) so callers can choose to treat
 * unvalidated bundles as acceptable or gate on `available`. Surface is REQUIRED for
 * bundle writes per ADR 0010 Phase 4c — `assertBundleWritten` enforces this on the
 * write path. Surface's validator is equivalent-or-stronger than the prior hachure
 * JSON-Schema validator: it validates the same structural constraints plus cross-reference
 * integrity (evidence/event → claim references) that the JSON schema did not enforce.
 */
export async function validateTrustBundle(bundle: unknown): Promise<{ valid: boolean; errors: string[]; available: boolean }> {
  // Use the already-loaded surface module when available (zero-cost re-entry after first load).
  // When called standalone (fresh process, surface not yet loaded), attempt a one-shot import.
  let surfaceValidate: ((input: unknown) => unknown) | undefined;
  if (_surfaceModule !== undefined) {
    // Module has been attempted: use cached result (null = unavailable).
    surfaceValidate = _surfaceModule?.validateTrustBundle ?? undefined;
  } else {
    // Not yet attempted — load now for standalone callers (e.g. library consumers, tests).
    const m = await tryLoadSurface();
    surfaceValidate = m?.validateTrustBundle ?? undefined;
  }
  if (!surfaceValidate) return { valid: true, errors: [], available: false };
  try {
    surfaceValidate(bundle);
    return { valid: true, errors: [], available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [message], available: true };
  }
}
// Validate a single InquiryRecord against the hachure inquiry-record.schema.json.
// Uses a separate AJV instance compiled against that schema (not the trust-bundle schema).
let _hachureInquiryRecordValidator: ((record: unknown) => { valid: boolean; errors: string[] }) | null | undefined;
function getHachureInquiryRecordValidator(): ((record: unknown) => { valid: boolean; errors: string[] }) | null {
  if (_hachureInquiryRecordValidator !== undefined) return _hachureInquiryRecordValidator;
  try {
    const _require = createRequire(import.meta.url);
    const hachureDir = path.dirname(_require.resolve("hachure"));
    const schemasDir = path.join(hachureDir, "schemas");
    const Ajv = _require("ajv/dist/2020");
    const schemas: Record<string, any> = {};
    for (const file of fs.readdirSync(schemasDir)) {
      if (!file.endsWith(".schema.json")) continue;
      schemas[file] = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
    }
    const inquiryRecordSchema = schemas["inquiry-record.schema.json"];
    if (!inquiryRecordSchema) { _hachureInquiryRecordValidator = null; return null; }
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const [filename, schema] of Object.entries(schemas)) {
      if (filename === "inquiry-record.schema.json") continue;
      ajv.addSchema(schema, filename);
    }
    const validate = ajv.compile(inquiryRecordSchema);
    _hachureInquiryRecordValidator = (record: unknown) => {
      const valid = validate(record);
      if (valid) return { valid: true, errors: [] };
      const errors = ((validate as any).errors ?? []).map((err: any) => {
        const loc = err.instancePath || err.schemaPath || "";
        return `${loc} ${err.message ?? "invalid"}`.trim();
      });
      return { valid: false, errors };
    };
    return _hachureInquiryRecordValidator;
  } catch {
    _hachureInquiryRecordValidator = null;
    return null;
  }
}
/**
 * Validate a record against the canonical hachure inquiry-record.schema.json
 * (https://kontourai.io/schemas/surface/inquiry-record.schema.json).
 * Returns `{ valid, errors, available }`. Fail-open when hachure is not installed.
 */
export function validateInquiryRecord(record: unknown): { valid: boolean; errors: string[]; available: boolean } {
  const validate = getHachureInquiryRecordValidator();
  if (!validate) return { valid: true, errors: [], available: false };
  return { ...validate(record), available: true };
}
// ─── @kontourai/surface status derivation ────────────────────────────────────
// Surface is ESM-only; this module builds to CJS. Load Surface via a fail-open
// cached dynamic import(). If Surface cannot be loaded, bundle writes are
// skipped entirely — no hand-rolled fork fallback.
//
// SurfaceInquiry / SurfaceInquiryRecord — minimal local shapes mirroring the
// canonical Surface Inquiry / InquiryRecord types. Using Record-based typing
// keeps this module free of a direct ESM import at compile time.
type SurfaceInquiry = {
  id: string;
  question: string;
  askedBy: string;
  askedAt: string;
  target?: { subjectType: string; subjectId: string; fieldOrBehavior: string; qualifiers?: Record<string, string> };
  metadata?: Record<string, unknown>;
};
type SurfaceInquiryRecord = {
  id: string;
  inquiry: SurfaceInquiry;
  outcome: "matched" | "derived" | "unsupported";
  resolutionPath: {
    claimIds: string[];
    ruleId?: string;
    ruleVersion?: string;
    identityLinkIds?: string[];
    transitiveRuleIds?: string[];
  };
  answer?: { value: unknown; status: string };
  inputSnapshot: Array<{ claimId: string; status: string }>;
  statusFunctionVersion: string;
  resolvedAt: string;
};
type SurfaceModule = {
  deriveClaimStatus: (args: {
    claim: Record<string, unknown>;
    evidence: Record<string, unknown>[];
    events: Record<string, unknown>[];
    policies: Record<string, unknown>[];
    now?: Date;
  }) => { status: string; policyId: string | undefined };
  generateClaimId: (subjectId: string, surface: string, fieldOrBehavior: string) => string;
  statusFunctionVersion: string;
  resolveInquiry: (
    bundle: Record<string, unknown>,
    inquiry: SurfaceInquiry,
    options?: { now?: Date },
  ) => SurfaceInquiryRecord;
  buildTrustReport: (bundle: Record<string, unknown>, options?: { now?: Date }) => Record<string, unknown>;
  buildDerivationDrilldown: (report: Record<string, unknown>, claimId: string) => Record<string, unknown>;
  /** Canonical trust-bundle validator from @kontourai/surface. Throws on invalid input; returns TrustBundle on success. */
  validateTrustBundle: (input: unknown) => Record<string, unknown>;
  /** Freeze a derivation checkpoint from a report. */
  checkpointFromReport: (report: Record<string, unknown>) => Record<string, unknown>;
  /** Diff two derivations (prior checkpoint → later report) and emit freshness transition events. */
  diffFreshness: (prior: Record<string, unknown>, next: Record<string, unknown>) => Array<Record<string, unknown>>;
  // ─── Increment B1: in-toto / Sigstore interop (consumed from Surface) ────────
  /** Wrap a TrustBundle as an in-toto Statement v1. */
  toInTotoStatement: (bundle: Record<string, unknown>, options: { subjects: Array<{ name: string; digest: Record<string, string> }> }) => {
    _type: "https://in-toto.io/Statement/v1";
    subject: Array<{ name: string; digest: Record<string, string> }>;
    predicateType: "https://hachure.org/v1/bundle";
    predicate: Record<string, unknown>;
  };
  /** Sign an in-toto Statement with Sigstore keyless signing. Returns null when no OIDC identity is available (fail-open). */
  signStatementWithSigstore: (statement: {
    _type: "https://in-toto.io/Statement/v1";
    subject: Array<{ name: string; digest: Record<string, string> }>;
    predicateType: "https://hachure.org/v1/bundle";
    predicate: Record<string, unknown>;
  }) => Promise<{
    envelope: {
      payloadType: "application/vnd.in-toto+json";
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    sigstoreBundle: unknown;
    assuranceLevel: "signed";
  } | null>;
};
let _surfaceModule: SurfaceModule | null | undefined; // undefined = not tried yet; null = unavailable
async function tryLoadSurface(): Promise<SurfaceModule | null> {
  // Test/diagnostic seam: simulate a degraded environment where Surface is unavailable,
  // to exercise the fail-loud (no silent data loss) path without disturbing node_modules.
  if (process.env.FLOW_AGENTS_SURFACE_UNAVAILABLE === "1") return null;
  if (_surfaceModule !== undefined) return _surfaceModule;
  try {
    const m = await import("@kontourai/surface");
    _surfaceModule = m as unknown as SurfaceModule;
    return _surfaceModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trust-bundle] @kontourai/surface unavailable — bundle write skipped: ${message}\n`);
    _surfaceModule = null;
    return null;
  }
}

/** Map a workflow check status to the Surface VerificationEvent status. */
function checkStatusToEventStatus(status: string): string | null {
  if (status === "pass") return "verified";
  if (status === "fail") return "disputed";
  if (status === "skip") return "assumed";
  return null; // not_verified / unknown → no event → Surface returns "unknown"
}
/** Map an acceptance criterion status to the Surface VerificationEvent status. */
function criterionStatusToEventStatus(status: string): string | null {
  if (status === "pass") return "verified";
  if (status === "fail") return "disputed";
  if (status === "accepted_gap") return "assumed";
  return null; // pending / not_verified → no event → Surface returns "unknown"
}
/** Map a critique verdict to the Surface VerificationEvent status. */
function critiqueToEventStatus(verdict: string, findings: AnyObj[]): string | null {
  if (verdict === "fail") return "disputed";
  const hasOpenFinding = Array.isArray(findings) && findings.some((f: AnyObj) => f.status === "open");
  if (verdict === "pass" && hasOpenFinding) return "disputed";
  if (verdict === "pass") return "verified";
  if (verdict === "comment") return "assumed";
  return null; // not_verified or unknown → no event → Surface returns "unknown"
}

/**
 * Build a Hachure trust.bundle from raw check/criterion/critique inputs.
 * trust.bundle is the PRIMARY artifact (ADR 0010 Phase 4a producer inversion).
 * Callers pass raw inputs directly — not bespoke-sidecar-shaped objects.
 * Derives claim statuses using @kontourai/surface's canonical versioned function.
 * Returns null when Surface is unavailable (caller skips the bundle write).
 * @param slug       Task slug (used as subjectId prefix)
 * @param timestamp  ISO-8601 timestamp for createdAt / updatedAt / observedAt
 * @param checks     Normalized check objects (from record-evidence --check-json / --surface-trust-json)
 * @param criteria   Acceptance criteria objects (from acceptance.json .criteria array)
 * @param critiques  Critique objects (from critique.json .critiques array)
 * @param commandLog Optional parsed command-log.jsonl entries (capture-authoritative fold)
 */
export async function buildTrustBundle(slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[], commandLog?: AnyObj[], flowAgentsDir?: string): Promise<AnyObj | null> {
  const surface = await tryLoadSurface();
  if (!surface) return null;
  const { deriveClaimStatus, generateClaimId, statusFunctionVersion } = surface;

  // ADR 0016 Abstraction A (P-b): resolve active flow step for dual-emit.
  // When flowAgentsDir is provided AND current.json carries active_flow_id/active_step_id,
  // each produced claim gets a DECLARED primary claim (kit-typed) plus a legacy shadow
  // (workflow.* type, claimId suffix "-legacy") for backward compatibility. When null,
  // only the existing workflow.* claims are produced (zero behavior change).
  const activeStep: ActiveFlowStep | null = flowAgentsDir ? resolveActiveFlowStep(flowAgentsDir) : null;

  const claims: AnyObj[] = [];
  const evidenceItems: AnyObj[] = [];
  const events: AnyObj[] = [];
  const ts = timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // One VerificationPolicy per distinct claimType, so status is policy-governed
  // (not derived against an empty policy set). Maximal-fidelity per ADR 0010.
  const policies = new Map<string, AnyObj>();
  const ensurePolicy = (claimType: string, impactLevel: string, requiredEvidence: string[]): AnyObj => {
    let p = policies.get(claimType);
    if (!p) {
      p = { id: `policy:${claimType}`, claimType, requiredEvidence, acceptanceCriteria: [`A verified verification event must support a ${claimType} claim.`], reviewAuthority: "system", validityRule: { kind: "manual" }, stalenessTriggers: [], conflictRules: [], impactLevel };
      policies.set(claimType, p);
    }
    return p;
  };

  // Index the deterministic capture log by normalized command (a single FAIL wins),
  // so a claimed-pass check whose command actually FAILED becomes authoritative here.
  const captureByCommand = new Map<string, { observedResult: string; exitCode: number | null }>();
  for (const entry of Array.isArray(commandLog) ? commandLog : []) {
    if (!entry || typeof entry.command !== "string") continue;
    const key = entry.command.replace(/\s+/g, " ").trim();
    if (!key) continue;
    const failed = entry.observedResult === "fail" || (Number.isInteger(entry.exitCode) && entry.exitCode !== 0);
    const prev = captureByCommand.get(key);
    captureByCommand.set(key, { observedResult: failed || (prev && prev.observedResult === "fail") ? "fail" : "pass", exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : (prev ? prev.exitCode : null) });
  }

  // ─── P-b dual-emit helper ──────────────────────────────────────────────────
  // Semantic matching table (ADR 0016 Abstraction A P-b):
  //   check (non-policy kind) → expects[] entry where claimType does NOT contain
  //     "acceptance" AND subjectType is NOT "decision". Preference: subjectType=
  //     "flow-step". Fallback: first non-decision, non-acceptance entry.
  //   check (kind=policy)     → expects[] entry whose claimType contains
  //     "compliance" or "policy". Fallback: same as non-policy.
  //   acceptance criterion    → expects[] entry whose subjectType is "flow-step"
  //     OR claimType contains "tests" OR "compliance". Fallback: first entry.
  //   critique                → expects[] entry whose claimType contains "policy"
  //     OR "compliance" AND subjectType is "artifact". Fallback: last entry.
  //
  // The DECLARED claim is primary (kit-typed claimType + subjectType).
  // The legacy claim uses the existing workflow.* claimType (suffix "-legacy") as
  // a backward-compat shadow. Both cite the same evidence. Status is derived by
  // Surface from that evidence (never hand-set).
  //
  // Per-gate producibility (ADR 0016 P-d):
  //   (a) Already handled via subjectType=flow-step preference:
  //       builder.verify.tests       (verify-gate, subjectType=flow-step)
  //       builder.verify.policy-compliance (verify-gate, kind=policy match)
  //   (b) Producible via fallback (non-decision, non-acceptance, first match):
  //       builder.plan.implementation   (plan-gate, subjectType=artifact)
  //       builder.execute.scope         (execute-gate, subjectType=change)
  //       builder.merge-ready.readiness (merge-ready-gate, subjectType=change)
  //       builder.merge-ready-ci.readiness (merge-ready-ci-gate, subjectType=pull-request)
  //   (c) No natural producer — required:false in build.flow.json (ADR 0016 P-d plan):
  //       builder.pull-work.selected        (pull-work-gate, subjectType=work-item)
  //       builder.design-probe.pickup-readiness (design-probe-gate, subjectType=work-item)
  //       builder.design-probe.decisions    (design-probe-gate, subjectType=decision)
  //       builder.pr-open.pull-request      (pr-open-gate, subjectType=pull-request)
  //       builder.learn.decisions           (learn-gate, subjectType=decision)
  //       builder.learn.evidence            (learn-gate, subjectType=release)
  //   For category (c): record-gate-claim subcommand allows skills to target a specific
  //   expects[] entry by --expectation <id>, bypassing this semantic match entirely.
  function matchExpectsEntry(kind: "check" | "acceptance" | "critique", checkKindVal?: string, expectationId?: string): { claimType: string; subjectType: string } | null {
    if (!activeStep || activeStep.gateExpects.length === 0) return null;
    const expects = activeStep.gateExpects;
    if (kind === "check") {
      // ADR 0016 P-d Increment 2: when an explicit expectation id is given (from record-gate-claim
      // --expectation), bypass heuristics and do exact lookup. This ensures multi-expects[] gates
      // (learn-gate: decision + release; design-probe-gate: work-item + decision) produce the
      // correct declared claimType rather than the heuristic-selected one.
      if (expectationId) {
        const exact = expects.find((e) => e.id === expectationId);
        if (exact) return { claimType: exact.bundle_claim.claimType, subjectType: exact.bundle_claim.subjectType };
      }
      const isPolicy = checkKindVal === "policy";
      if (isPolicy) {
        const match = expects.find((e) => {
          const ct = e.bundle_claim.claimType.toLowerCase();
          return ct.includes("compliance") || ct.includes("policy");
        });
        if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      }
      // Non-policy: prefer flow-step subjectType, exclude decision/acceptance entries
      const preferred = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType !== "decision" && !ct.includes("acceptance") && e.bundle_claim.subjectType === "flow-step";
      });
      if (preferred) return { claimType: preferred.bundle_claim.claimType, subjectType: preferred.bundle_claim.subjectType };
      const fallback = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType !== "decision" && !ct.includes("acceptance");
      });
      if (fallback) return { claimType: fallback.bundle_claim.claimType, subjectType: fallback.bundle_claim.subjectType };
      return null;
    }
    if (kind === "acceptance") {
      const match = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType === "flow-step" || ct.includes("tests") || ct.includes("compliance");
      });
      if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      return { claimType: expects[0]!.bundle_claim.claimType, subjectType: expects[0]!.bundle_claim.subjectType };
    }
    if (kind === "critique") {
      const match = expects.find((e) => {
        const ct = e.bundle_claim.claimType.toLowerCase();
        return e.bundle_claim.subjectType === "artifact" && (ct.includes("policy") || ct.includes("compliance"));
      });
      if (match) return { claimType: match.bundle_claim.claimType, subjectType: match.bundle_claim.subjectType };
      const last = expects[expects.length - 1]!;
      return { claimType: last.bundle_claim.claimType, subjectType: last.bundle_claim.subjectType };
    }
    return null;
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Evidence checks → claims + evidence items + events. Capture is authoritative.
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check.id) continue;
    const subjectId = `${slug}/${check.id}`;
    const fieldOrBehavior = String(check.summary ?? check.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const evId = `ev:${claimId}`;
    const legacyClaimType = `workflow.check.${check.kind ?? "external"}`;
    const policy = ensurePolicy(legacyClaimType, "high", ["test_output"]);

    const cmd = typeof check.command === "string" ? check.command.replace(/\s+/g, " ").trim() : "";
    const captured = cmd ? captureByCommand.get(cmd) : undefined;
    const effectiveStatus = captured ? captured.observedResult : String(check.status ?? "");
    const evStatus = checkStatusToEventStatus(effectiveStatus);

    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [evId], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }
    const evItem: AnyObj = { id: evId, claimId, evidenceType: "test_output", method: "validation", sourceRef: `${slug}/evidence.json`, excerptOrSummary: fieldOrBehavior, observedAt: ts, collectedBy: "flow-agents/workflow-sidecar", passing: effectiveStatus === "pass" };
    if (captured) {
      evItem.sourceRef = `${slug}/command-log.jsonl`;
      evItem.collectedBy = "flow-agents/evidence-capture";
      evItem.execution = { runner: "bash", label: cmd, isError: captured.observedResult === "fail", ...(captured.exitCode != null ? { exitCode: captured.exitCode } : {}) };
    }
    evidenceItems.push(evItem);

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    // When record-gate-claim sets _gate_claim_expectation_id, pass it for exact lookup (ADR 0016 P-d Increment 2).
    const declared = matchExpectsEntry("check", check.kind, typeof check._gate_claim_expectation_id === "string" ? check._gate_claim_expectation_id : undefined);
    if (declared) {
      // Declared kit-typed claim only — no legacy shadow (ADR 0016 P-d).
      const declaredPolicy = ensurePolicy(declared.claimType, "high", ["test_output"]);
      const declaredClaimObj: AnyObj = { id: claimId, subjectType: declared.subjectType, subjectId, surface: "flow-agents.workflow", claimType: declared.claimType, fieldOrBehavior, value: effectiveStatus, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: declaredPolicy.id };
      const { status: declaredStatus } = deriveClaimStatus({ claim: declaredClaimObj as Record<string, unknown>, evidence: [evItem] as Record<string, unknown>[], events: claimEvents as Record<string, unknown>[], policies: [declaredPolicy] as Record<string, unknown>[] });
      claims.push({ ...declaredClaimObj, status: declaredStatus });
    } else {
      // No active flow step — only the workflow.* primary claim (legitimate no-flow fallback path).
      const claimObj: AnyObj = { id: claimId, subjectType: "workflow-check", subjectId, surface: "flow-agents.workflow", claimType: legacyClaimType, fieldOrBehavior, value: effectiveStatus, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id };
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [evItem] as Record<string, unknown>[], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  // Acceptance criteria → claims + events
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    if (!criterion.id) continue;
    const subjectId = `${slug}/${criterion.id}`;
    const fieldOrBehavior = String(criterion.description ?? criterion.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const legacyClaimType = "workflow.acceptance.criterion";
    const policy = ensurePolicy(legacyClaimType, "high", []);
    const evStatus = criterionStatusToEventStatus(String(criterion.status ?? ""));
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    const declared = matchExpectsEntry("acceptance");
    if (declared) {
      // Declared kit-typed claim only — no legacy shadow (ADR 0016 P-d).
      const declaredPolicy = ensurePolicy(declared.claimType, "high", []);
      const declaredClaimObj: AnyObj = { id: claimId, subjectType: declared.subjectType, subjectId, surface: "flow-agents.workflow", claimType: declared.claimType, fieldOrBehavior, value: criterion.status, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: declaredPolicy.id };
      const { status: declaredStatus } = deriveClaimStatus({ claim: declaredClaimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [declaredPolicy] as Record<string, unknown>[] });
      claims.push({ ...declaredClaimObj, status: declaredStatus });
    } else {
      // No active flow step — only the workflow.* primary claim (legitimate no-flow fallback path).
      const claimObj: AnyObj = { id: claimId, subjectType: "workflow-acceptance-criterion", subjectId, surface: "flow-agents.workflow", claimType: legacyClaimType, fieldOrBehavior, value: criterion.status, createdAt: ts, updatedAt: ts, impactLevel: "high", verificationPolicyId: policy.id };
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  // Critique entries → claims + events
  for (const c of Array.isArray(critiques) ? critiques : []) {
    if (!c.id) continue;
    const subjectId = `${slug}/${c.id}`;
    const fieldOrBehavior = String(c.summary ?? c.verdict ?? c.id);
    const claimId = generateClaimId(subjectId, "flow-agents.workflow", fieldOrBehavior);
    const legacyClaimType = "workflow.critique.review";
    const policy = ensurePolicy(legacyClaimType, "medium", []);
    const evStatus = critiqueToEventStatus(String(c.verdict ?? ""), c.findings ?? []);
    const claimEvents: AnyObj[] = [];
    if (evStatus) {
      const evt: AnyObj = { id: `evt:${claimId}`, claimId, status: evStatus, actor: "flow-agents/workflow-sidecar", method: "validation", evidenceIds: [], createdAt: ts, verifiedAt: ts };
      events.push(evt);
      claimEvents.push(evt);
    }

    // P-d: declared-only when active flow/step present (shadow retired); no-flow path unchanged.
    const declared = matchExpectsEntry("critique");
    if (declared) {
      // Declared kit-typed claim only — no legacy shadow (ADR 0016 P-d).
      const declaredPolicy = ensurePolicy(declared.claimType, "medium", []);
      const declaredClaimObj: AnyObj = { id: claimId, subjectType: declared.subjectType, subjectId, surface: "flow-agents.workflow", claimType: declared.claimType, fieldOrBehavior, value: c.verdict, createdAt: ts, updatedAt: ts, impactLevel: "medium", verificationPolicyId: declaredPolicy.id };
      const { status: declaredStatus } = deriveClaimStatus({ claim: declaredClaimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [declaredPolicy] as Record<string, unknown>[] });
      claims.push({ ...declaredClaimObj, status: declaredStatus });
    } else {
      // No active flow step — only the workflow.* primary claim (legitimate no-flow fallback path).
      const claimObj: AnyObj = { id: claimId, subjectType: "workflow-critique", subjectId, surface: "flow-agents.workflow", claimType: legacyClaimType, fieldOrBehavior, value: c.verdict, createdAt: ts, updatedAt: ts, impactLevel: "medium", verificationPolicyId: policy.id };
      const { status: derivedStatus } = deriveClaimStatus({ claim: claimObj as Record<string, unknown>, evidence: [], events: claimEvents as Record<string, unknown>[], policies: [policy] as Record<string, unknown>[] });
      claims.push({ ...claimObj, status: derivedStatus });
    }
  }

  return {
    schemaVersion: 3,
    source: `flow-agents/workflow-sidecar;statusFunctionVersion=${statusFunctionVersion}`,
    claims,
    evidence: evidenceItems,
    policies: [...policies.values()],
    events,
  };
}

/**
 * Fail-open wrapper: builds (via Surface), validates, and writes a trust.bundle.
 * Accepts raw check/criterion/critique inputs directly (ADR 0010 Phase 4a).
 * trust.bundle is written as the PRIMARY artifact; bespoke sidecars are the
 * caller's responsibility to emit as back-compat projections AFTER this call.
 * ANY error is caught and logged to stderr — this function NEVER throws and
 * NEVER affects the exit code of its caller.
 * Returns { written: false } if Surface is unavailable (fail-open; does NOT
 * fall back to hand-rolled status derivation).
 * @param checks     Normalized check objects (same as buildTrustBundle)
 * @param criteria   Acceptance criteria objects (same as buildTrustBundle)
 * @param critiques  Critique objects (same as buildTrustBundle)
 */
export async function writeTrustBundle(dir: string, slug: string, timestamp: string, checks: AnyObj[], criteria: AnyObj[], critiques: AnyObj[]): Promise<{ written: boolean; errors: string[] }> {
  try {
    // Fold the deterministic capture log (PostToolUse evidence-capture) into the
    // bundle so capture is authoritative over claimed status. Best-effort read.
    let commandLog: AnyObj[] = [];
    try {
      const raw = fs.readFileSync(path.join(dir, "command-log.jsonl"), "utf8");
      commandLog = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as AnyObj; } catch { return null; } }).filter((x): x is AnyObj => x !== null);
    } catch { /* no capture log — fine */ }
    // ADR 0016 Abstraction A (P-d): pass the .flow-agents dir ONLY when current.json
    // points to this session (scoped active-flow guard). If current.json.artifact_dir
    // resolves to a different session, pass null — no active-flow claim mapping for this bundle.
    const _flowAgentsDir = path.dirname(dir);
    let _scopedFlowAgentsDir: string | undefined = undefined;
    try {
      const _currentRaw = JSON.parse(fs.readFileSync(path.join(_flowAgentsDir, "current.json"), "utf8")) as Record<string, unknown>;
      const _artDir = typeof _currentRaw["artifact_dir"] === "string" ? _currentRaw["artifact_dir"] : null;
      if (_artDir && path.resolve(_flowAgentsDir, _artDir) === path.resolve(dir)) {
        _scopedFlowAgentsDir = _flowAgentsDir;
      }
    } catch { /* current.json absent or unreadable — no scoping */ }
    const bundle = await buildTrustBundle(slug, timestamp, checks, criteria, critiques, commandLog, _scopedFlowAgentsDir);
    if (!bundle) return { written: false, errors: [] }; // Surface unavailable — fail-open, skip write
    const result = await validateTrustBundle(bundle);
    if (result.available && !result.valid) {
      process.stderr.write(`[trust-bundle] schema validation failed: ${result.errors.join("; ")}\n`);
      return { written: false, errors: result.errors };
    }
    writeJson(path.join(dir, "trust.bundle"), bundle);
    return { written: true, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trust-bundle] write failed: ${message}\n`);
    return { written: false, errors: [message] };
  }
}

// Phase 4c safety: the trust.bundle is the ONLY store (bespoke sidecars retired), so a
// fail-open write = SILENT DATA LOSS. Data-persisting writers must fail loudly when the
// bundle was not written (Surface unavailable, validation, or I/O) instead of exiting 0
// and dropping the record. (Was masked as a "flaky" concurrent-critique test.)
function assertBundleWritten(result: { written: boolean; errors: string[] }): void {
  if (result.written) return;
  const reason = result.errors.length
    ? result.errors.join("; ")
    : "@kontourai/surface is unavailable — it is REQUIRED to persist the trust.bundle (bundle-only workspace, ADR 0010 Phase 4c). Install it (>= 1.2) and retry.";
  die(`trust.bundle was NOT written — the record was not persisted: ${reason}`);
}
// ─────────────────────────────────────────────────────────────────────────────

function safeRepoIdentifier(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  if (!trimmed || trimmed.length > 120) return "";
  if (path.isAbsolute(trimmed) || trimmed.includes("\\") || /[\x00-\x1F\x7F]/.test(trimmed)) return "";
  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => !part || part === "." || part === "..")) return "";
  if (!parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return "";
  return parts.join("/");
}

function parseRepoRemote(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = /^git@[^:]+:(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(trimmed);
  if (ssh?.groups) return safeRepoIdentifier(`${ssh.groups.owner}/${ssh.groups.repo}`);
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return safeRepoIdentifier(`${parts.at(-2)}/${parts.at(-1)}`);
  } catch {
    // Non-URL remotes fall back to repository directory name below.
  }
  return "";
}

function repoIdentifier(): string {
  const explicit = safeRepoIdentifier(process.env.FLOW_AGENTS_REPO ?? "");
  if (explicit) return explicit;
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = parseRepoRemote(remote);
    if (parsed) return parsed;
  } catch {
    // Keep sidecar writing independent of Git availability.
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return safeRepoIdentifier(path.basename(top)) || "workspace";
  } catch {
    // Fall through to cwd basename for non-Git workspaces.
  }
  return safeRepoIdentifier(path.basename(process.cwd())) || "workspace";
}

export function sidecarBase(slug: string): AnyObj {
  return { schema_version: "1.0", task_slug: slug, repo: repoIdentifier() };
}

function parseArgs(argv: string[]): { command: string; positional: string[]; opts: Record<string, string[]>; flags: Set<string> } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const opts: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) flags.add(key);
    else { (opts[key] ??= []).push(next); i += 1; }
  }
  return { command: command ?? "", positional, opts, flags };
}
function opt(parsed: ReturnType<typeof parseArgs>, key: string, fallback = ""): string { return parsed.opts[key]?.at(-1) ?? fallback; }
function opts(parsed: ReturnType<typeof parseArgs>, key: string): string[] { return parsed.opts[key] ?? []; }

function isUnderDir(dir: string, root: string): boolean {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedDir = fs.realpathSync(dir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function explicitArtifactRoot(p: ReturnType<typeof parseArgs>): string {
  const explicit = opt(p, "artifact-dir");
  const configuredRoot = opt(p, "artifact-root");
  if (!explicit) return path.resolve(configuredRoot || ".flow-agents");
  const dir = path.resolve(explicit);
  if (!fs.existsSync(dir)) die(`artifact directory does not exist: ${dir}`);
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (configuredRoot) {
    const root = path.resolve(configuredRoot);
    if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
    return root;
  }
  return path.dirname(dir);
}

function requireArtifactDirUnderRoot(dir: string, root: string): void {
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (!isUnderDir(dir, root)) die(`artifact directory must be under artifact root: ${dir} is outside ${root}`);
}

function isPermissionDeniedLockError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPERM" || error.code === "EACCES";
}

function lockAcquisitionFailureMessage(command: string, lockDir: string, error: NodeJS.ErrnoException): string {
  const original = error.message || error.code || String(error);
  if (!isPermissionDeniedLockError(error)) {
    return `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`;
  }
  return [
    `failed to acquire workflow sidecar lock for ${command}: ${lockDir}: ${original}`,
    "Likely cause: local directory permissions, ownership, or sandbox restrictions prevented creating the lock directory.",
    "Safe next step: fix permissions or ownership on the artifact directory, or rerun in an approved writable workspace.",
    "If still blocked: manually write schema-valid sidecars and run workflow artifact validation rather than bypassing locks.",
  ].join(" ");
}

async function withLock<T>(dir: string, create: boolean, command: string, body: () => T | Promise<T>): Promise<T> {
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir)) return await body();
  const lockDir = path.join(dir, ".workflow-sidecar.lockdir");
  const staleMs = Number(process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_STALE_LOCK_MS ?? 5 * 60 * 1000);
  const deadline = Date.now() + 30000;
  while (true) {
    try { fs.mkdirSync(lockDir); break; }
    catch (error) {
      const lockError = error as NodeJS.ErrnoException;
      if (lockError.code !== "EEXIST") {
        die(lockAcquisitionFailureMessage(command, lockDir, lockError));
      }
      try {
        const stat = fs.statSync(lockDir);
        if (staleMs > 0 && Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() > deadline) die(`timed out waiting for workflow sidecar lock for ${command}: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const delay = process.env.FLOW_AGENTS_WORKFLOW_SIDECAR_LOCK_DELAY;
    if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay) * 1000));
    return await body();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function section(text: string, heading: string): string {
  const match = new RegExp(`^(?<marks>##+)\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!match?.groups) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = new RegExp(`^#{2,${match.groups.marks.length}}\\s+`, "m").exec(rest);
  return rest.slice(0, next?.index).trim();
}
function definitionAcceptanceLines(markdown: string): string[] {
  const out: string[] = [];
  let active = false;
  for (const raw of section(markdown, "Definition Of Done").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+\*\*Acceptance criteria:\*\*/i.test(line)) { active = true; continue; }
    if (active && /^-\s+\*\*(Usefulness checks|Stop-short risks|Durable docs target|Scope|User outcome):\*\*/i.test(line)) break;
    if (active && /^-\s+\[[ xX]\]/.test(line)) out.push(line);
  }
  return out;
}
function parseCriterion(line: string, index: number): AnyObj {
  let text = line.replace(/^-\s+\[[ xX]\]\s*/, "").trim();
  const m = /\s+-\s+Evidence:\s*(.+)$/i.exec(text);
  const evidence = m?.[1]?.trim().replace(/\.$/, "");
  if (m) text = text.slice(0, m.index).trim().replace(/\.$/, "");
  const item: AnyObj = { id: slugify(text, `criterion-${index + 1}`), description: text, status: "pending" };
  if (evidence) item.evidence_refs = [evidenceRef("command", { excerpt: evidence })];
  return item;
}
function artifactDirFrom(value: string): string { return path.extname(value) ? path.dirname(value) : value; }
function taskSlugFor(dir: string, explicit = ""): string { return explicit || path.basename(dir); }
function relArtifacts(dir: string): string[] { return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md") || n.endsWith(".json")).sort() : []; }
function sessionDirFor(root: string, slug: string): string {
  if (!slug) die("--task-slug is required");
  if (path.isAbsolute(slug)) die("--task-slug must be a relative slug");
  if (slug.includes("..")) die("--task-slug must not contain '..'");
  if (slug.includes("/") || slug.includes("\\") || path.basename(slug) !== slug) die("--task-slug must not contain path separators");
  const dir = path.resolve(root, slug);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) die("session directory must stay under artifact root");
  return dir;
}

function validateAgentId(agent: string): string {
  if (!agent) die("--agent-id is required");
  if (path.isAbsolute(agent)) die("--agent-id must be a relative slug");
  if (agent.includes("..")) die("--agent-id must not contain '..'");
  if (agent.includes("/") || agent.includes("\\") || path.basename(agent) !== agent) die("--agent-id must not contain path separators");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agent)) die("--agent-id must be a conservative slug");
  return agent;
}

/**
 * Find the repository root by walking upward from a starting directory to locate
 * the nearest ancestor containing a kits/ subdirectory. Mirrors flow-resolver.ts
 * findRepoRoot, but callable from workflow-sidecar.ts without re-importing the
 * internal helper.
 *
 * ADR 0016 Abstraction A (P-d): used by advance-state and ensure-session to
 * derive repoRoot for resolvePhaseMap calls.
 */
function findRepoRootFromDir(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "kits"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Resolve the first step id from a FlowDefinition's steps[] list.
 * Returns null when the flow cannot be loaded or has no steps.
 * Used by ensure-session to default active_step_id when --flow-id is
 * provided without --step-id (Q2 decision, P-d Increment 1).
 */
function resolveFirstStep(flowId: string, repoRoot: string): string | null {
  if (!flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;
  // Use resolveFlowFilePath for SLUG_RE validation + path-containment check — the same
  // defense used by resolveFlowStep and resolvePhaseMap (single implementation, DRY).
  // Returns null for any traversal attempt (e.g. flowName="../../secret") so the
  // caller gets a clean null return matching the existing null-contract.
  const flowFilePath = resolveFlowFilePath(kitId, flowName, flowId, repoRoot);
  if (!flowFilePath) return null;
  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    const flowDef = JSON.parse(raw) as { steps?: Array<{ id: string }> };
    if (!flowDef || !Array.isArray(flowDef.steps) || flowDef.steps.length === 0) return null;
    const first = flowDef.steps[0];
    return (first && typeof first.id === "string" && first.id !== "done") ? first.id : null;
  } catch {
    return null;
  }
}

function writeCurrent(root: string, dir: string, timestamp: string, owner: string, source: string, flowId?: string, stepId?: string): void {
  writeJson(path.join(root, "current.json"), {
    schema_version: "1.0",
    active_slug: path.basename(dir),
    artifact_dir: path.relative(root, dir) || ".",
    updated_at: timestamp,
    owner,
    source,
    active_agents: [],
    // ADR 0016 Abstraction A (P-a): optional FlowDefinition routing keys for the producer
    // and enforcer. Both fields are optional and backward-compatible — sessions without a
    // FlowDefinition omit them and fall through to the workflow.* claim type path.
    ...(flowId ? { active_flow_id: flowId } : {}),
    ...(stepId ? { active_step_id: stepId } : {}),
  });
}
function loadCurrent(root: string): AnyObj | null {
  const file = path.join(root, "current.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(read(file));
}
function currentDir(root: string): string | null {
  const c = loadCurrent(root);
  if (!c) return null;
  const dir = path.resolve(root, c.artifact_dir ?? c.active_slug ?? "");
  return fs.existsSync(dir) ? dir : null;
}
function updateCurrentAgent(root: string, dir: string, agentId: string, status: string, timestamp: string): void {
  const cur = loadCurrent(root);
  if (!cur || path.resolve(root, cur.artifact_dir ?? "") !== path.resolve(dir)) return;
  const active = Array.isArray(cur.active_agents) ? cur.active_agents.filter((a: AnyObj) => a.agent_id !== agentId) : [];
  if (status === "active" || status === "blocked") active.push({ agent_id: agentId, status, updated_at: timestamp });
  cur.active_agents = active;
  cur.updated_at = timestamp;
  writeJson(path.join(root, "current.json"), cur);
}

function initSidecars(dir: string, slug: string, sourceRequest: string, summary: string, nextAction: string, timestamp: string, markdown?: string): void {
  const criteria = markdown ? definitionAcceptanceLines(markdown).map(parseCriterion) : [];
  writeJson(path.join(dir, "state.json"), {
    ...sidecarBase(slug), status: "planned", phase: "planning", created_at: timestamp, updated_at: timestamp,
    artifact_paths: relArtifacts(dir),
    next_action: { status: "continue", summary: nextAction || summary },
  });
  writeJson(path.join(dir, "acceptance.json"), {
    ...sidecarBase(slug), source_request: sourceRequest,
    criteria,
    goal_fit: { status: "pending", summary: "Goal fit has not been verified yet." },
  });
  writeJson(path.join(dir, "handoff.json"), {
    ...sidecarBase(slug), summary, current_state_ref: "state.json", next_steps: nextAction ? [nextAction] : [], blockers: [], warnings: [],
  });
}

function ensureSession(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const slug = opt(p, "task-slug") || (opt(p, "work-item") ? workItemSlug(opt(p, "work-item")) : die("--task-slug is required (or pass --work-item to derive it)"));
  const dir = sessionDirFor(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = opt(p, "timestamp", now());
  let md = fs.existsSync(path.join(dir, `${slug}--deliver.md`)) ? read(path.join(dir, `${slug}--deliver.md`)) : "";
  if (!md) {
    md = `# ${opt(p, "title", slug)}\n\nbranch: main\nworktree: main\ncreated: ${timestamp}\nstatus: planning\ntype: deliver\niteration: 1\n\n## Plan\n\n${opt(p, "summary", "")}\n\n## Definition Of Done\n\n- **User outcome:** ${opt(p, "summary", "Workflow session is durable.")}\n- **Scope:** Workflow session artifacts and sidecars.\n- **Acceptance criteria:**\n${opts(p, "criterion").map((c) => `  - [ ] ${c} - Evidence: pending.`).join("\n")}\n- **Usefulness checks:**\n  - [ ] User-facing workflow is documented or discoverable\n- **Stop-short risks:** Workflow artifacts could drift.\n- **Durable docs target:** not needed\n- **Sandbox mode:** local-edit\n\n## Execution Progress\n\n- [ ] Session initialized.\n\n## Verification Report\n\nBuild: [NOT_VERIFIED] Verification has not run yet.\n\n### Acceptance Criteria\n- [NOT_VERIFIED] Verification has not run yet - Evidence: pending workflow execution and checks.\n\n### Verdict: NOT_VERIFIED\n\n## Goal Fit Gate\n\n- [ ] Original user goal restated\n\n## Final Acceptance\n\n- [ ] CI/relevant checks passed or local equivalent recorded\n`;
    fs.writeFileSync(path.join(dir, `${slug}--deliver.md`), md);
  }
  if (!fs.existsSync(path.join(dir, "state.json")) || !fs.existsSync(path.join(dir, "acceptance.json")) || !fs.existsSync(path.join(dir, "handoff.json"))) {
    initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action", "Continue."), timestamp, md);
  }
  // ADR 0016 Abstraction A (P-a): optional --flow-id / --step-id flags persist FlowDefinition
  // routing keys into current.json for the producer (P-b) and enforcer (P-c) to consume.
  // When absent, behavior is unchanged — the workflow.* claim type path is used as before.
  // P-d Increment 1 (Q2 decision): when --flow-id is given without --step-id, default
  // active_step_id to the FIRST step in the FlowDefinition's steps[] list. This ensures
  // ensure-session --flow-id builder.build produces a FlowDefinition-driven session even
  // before the first advance-state call.
  const flowId = opt(p, "flow-id");
  let stepId = opt(p, "step-id");
  if (flowId && !stepId) {
    const repoRoot = findRepoRootFromDir(dir);
    const firstStep = resolveFirstStep(flowId, repoRoot);
    if (firstStep) stepId = firstStep;
  }
  writeCurrent(root, dir, timestamp, "workflow-sidecar", "ensure-session", flowId || undefined, stepId || undefined);
  console.log(dir);
  return 0;
}

function current(p: ReturnType<typeof parseArgs>): number {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = currentDir(root);
  if (!dir) die("no current workflow session is recorded");
  const format = opt(p, "format", "path");
  console.log(format === "slug" ? path.basename(dir) : dir);
  return 0;
}

function recordAgentEvent(p: ReturnType<typeof parseArgs>): number {
  const hasExplicitRoot = !!opt(p, "artifact-root");
  const root = explicitArtifactRoot(p);
  const explicit = opt(p, "artifact-dir");
  const dir = explicit ? path.resolve(explicit) : currentDir(root);
  if (!dir || !fs.existsSync(dir)) die("artifact directory does not exist");
  if (explicit && fs.lstatSync(dir).isSymbolicLink()) die(`artifact directory must not be a symlink: ${dir}`);
  if (hasExplicitRoot) requireArtifactDirUnderRoot(dir, root);
  const timestamp = opt(p, "timestamp", now());
  const agent = validateAgentId(opt(p, "agent-id"));
  const event = { timestamp, agent_id: agent, kind: opt(p, "kind", "note"), status: opt(p, "status", "info"), summary: opt(p, "summary"), ...(opt(p, "ref") ? { ref: opt(p, "ref") } : {}) };
  appendJsonl(path.join(dir, "agents", agent, "events.jsonl"), event);
  updateCurrentAgent(root, dir, agent, event.status, timestamp);
  return 0;
}

function initPlan(p: ReturnType<typeof parseArgs>): number {
  const artifact = p.positional[0] || die("artifact path is required");
  const dir = artifactDirFrom(artifact);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  initSidecars(dir, slug, opt(p, "source-request"), opt(p, "summary"), opt(p, "next-action"), opt(p, "timestamp", now()), read(artifact));
  livenessLifecycle(dir, slug, "claim", opt(p, "timestamp", now()));
  return 0;
}

function parseJson(value: string, label: string): AnyObj {
  try { const raw = JSON.parse(value); if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("object expected"); return raw; }
  catch { die(`${label} must be valid JSON object`); }
}
function evidenceRef(kind: string, fields: AnyObj): AnyObj {
  return { kind, ...fields };
}
function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
function hasPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1;
}
export function validateEvidenceRef(ref: AnyObj, label: string): AnyObj {
  if (!["source", "command", "artifact", "provider", "external"].includes(ref.kind)) die(`${label} entry kind must be one of: source, command, artifact, provider, external`);
  for (const key of Object.keys(ref)) if (!["kind", "url", "file", "line_start", "line_end", "excerpt", "summary"].includes(key)) die(`${label} entries contain unsupported field: ${key}`);
  if (ref.url !== undefined && !hasNonEmptyString(ref.url)) die(`${label} entry url must be a non-empty string`);
  if (ref.file !== undefined && !hasNonEmptyString(ref.file)) die(`${label} entry file must be a non-empty string`);
  if (ref.excerpt !== undefined && !hasNonEmptyString(ref.excerpt)) die(`${label} entry excerpt must be a non-empty string`);
  if (ref.summary !== undefined && !hasNonEmptyString(ref.summary)) die(`${label} entry summary must be a non-empty string`);
  if (ref.line_start !== undefined && !hasPositiveInteger(ref.line_start)) die(`${label} entry line_start must be a positive integer`);
  if (ref.line_end !== undefined && !hasPositiveInteger(ref.line_end)) die(`${label} entry line_end must be a positive integer`);
  if (ref.kind === "source" && (!hasNonEmptyString(ref.file) || !hasPositiveInteger(ref.line_start) || !hasPositiveInteger(ref.line_end) || !hasNonEmptyString(ref.excerpt))) die(`${label} source refs require file, line_start, line_end, and excerpt`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.file) && !hasNonEmptyString(ref.url))) die(`${label} artifact refs require file or url`);
  if (ref.kind === "artifact" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt))) die(`${label} artifact refs require summary or excerpt`);
  if (ref.kind === "command" && (!hasNonEmptyString(ref.summary) && !hasNonEmptyString(ref.excerpt) && !hasNonEmptyString(ref.url))) die(`${label} command refs require summary, excerpt, or url`);
  if ((ref.kind === "provider" || ref.kind === "external") && !hasNonEmptyString(ref.url)) die(`${label} ${ref.kind} refs require url`);
  return ref;
}
export function normalizeEvidenceRefs(raw: unknown, label: string): AnyObj[] {
  if (!Array.isArray(raw)) die(`${label} must be an array`);
  return raw.map((ref) => {
    if (typeof ref === "string") die(`${label} entries must be structured evidence reference objects; legacy string refs are not supported`);
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) die(`${label} entries must be objects`);
    return validateEvidenceRef({ ...ref as AnyObj }, label);
  });
}
export function normalizeCheck(raw: AnyObj): AnyObj {
  const check = { ...raw };
  if (!check.id || !check.kind || !check.status || !check.summary) die("check requires id, kind, status, and summary");
  if (!checkKinds.has(check.kind)) die("kind must be one of: build, types, lint, test, security, diff, browser, runtime, policy, external");
  if (!checkStatuses.has(check.status)) die("status must be one of: pass, fail, not_verified, skip");
  if (Array.isArray(check.standard_refs)) for (const ref of check.standard_refs) if (!["junit", "sarif", "coverage", "veritas"].includes(ref.standard)) die("standard must be one of");
  if (check.artifact_refs) check.artifact_refs = normalizeEvidenceRefs(check.artifact_refs, "artifact_refs");
  if (check.surface_trust_refs) check.surface_trust_refs = normalizeSurfaceRefs(check.surface_trust_refs);
  return check;
}
function normalizeSurfaceRefs(refs: any): AnyObj[] {
  if (!Array.isArray(refs)) die("surface_trust_refs must be an array");
  // Use the cached @kontourai/surface module for advisory inline validation of referenced
  // trust.bundle files. Fail-open when surface is not yet loaded (surface loads on first
  // bundle write via tryLoadSurface; normalizeSurfaceRefs may run before that).
  const surfaceValidateFn = _surfaceModule?.validateTrustBundle ?? null;
  return refs.map((ref) => {
    const keys = JSON.stringify(ref).match(/"([^"]+)":/g) ?? [];
    for (const key of keys.map((k) => k.slice(1, -2))) if (key.toLowerCase().includes("veritas")) die(`unsupported field in Surface trust ref: ${key}`);
    const out = { ...ref };
    // trust.bundle is the canonical Hachure-aligned artifact kind; TrustReport/Trust Snapshot are legacy aliases
    if (!["trust.bundle", "TrustReport", "Trust Snapshot"].includes(out.artifact_kind)) die("artifact_kind must be one of: trust.bundle, TrustReport, Trust Snapshot");
    // When surface is loaded, validate the referenced trust artifact if it is a local file.
    // Advisory: surface's throw-based validator wraps into a fail-loud error on schema failure.
    if (surfaceValidateFn && out.artifact_ref && typeof out.artifact_ref === "string" && fs.existsSync(out.artifact_ref)) {
      try {
        const bundle = JSON.parse(fs.readFileSync(out.artifact_ref, "utf8"));
        surfaceValidateFn(bundle);
      } catch (err) {
        if (err instanceof Error) {
          // Re-throw schema validation failures (surface throws on invalid); swallow read/parse errors.
          const msg = err.message;
          const isSchemaError = !msg.startsWith("ENOENT") && !msg.startsWith("SyntaxError") && !msg.toLowerCase().startsWith("unexpected");
          if (isSchemaError) die(`trust.bundle artifact at ${out.artifact_ref} failed schema validation: ${msg}`);
        }
        // File read or parse errors are not re-thrown: the artifact_ref validation path is advisory
      }
    }
    const status = deriveSurfaceStatus(out);
    if (out.status === "pass" && status !== "pass") die("surface_trust_refs contradicts Surface trust facts");
    return out;
  });
}
function deriveSurfaceStatus(ref: AnyObj): string {
  if (ref.claim_status !== "accepted") return "fail";
  if (ref.freshness?.status !== "fresh") return "not_verified";
  if (!ref.authority || ref.authority.producer === "unknown") return "fail";
  if (ref.integrity?.status !== "matched") return "fail";
  return "pass";
}
/**
 * Derive kit identity from a parsed trust.bundle by structurally reading the
 * DECLARED primary claim (kit-typed) rather than hardcoding "builder".
 *
 * Resolution order (no fallbacks to "builder"):
 *   1. First non-workflow.* claim in bundle.claims[] → claimType drives kitId + subject.
 *   2. No kit-typed claim: try current.json active_flow_id adjacent to the bundle file
 *      (bundle lives at <session-dir>/trust.bundle → flowAgentsDir = grandparent).
 *   3. Genuinely unknown: mark as "unknown" — never hardcode a kit identity.
 */
export function kitIdentityFromBundle(
  raw: AnyObj,
  bundleFile: string,
): { claimType: string; kitId: string; subject: string; gateId: string } {
  // 1. Structurally read the bundle's declared kit-typed claim.
  const claims: AnyObj[] = Array.isArray(raw.claims) ? raw.claims : [];
  for (const claim of claims) {
    const ct = typeof claim?.claimType === "string" ? claim.claimType : "";
    if (ct && !ct.startsWith("workflow.")) {
      const kitId = ct.split(".")[0] ?? "unknown";
      if (kitId && kitId !== "unknown") {
        return { claimType: ct, kitId, subject: `${kitId}-kit`, gateId: ct };
      }
    }
  }
  // 2. No kit-typed claim in bundle — try to derive kit from current.json active_flow_id.
  //    The bundle lives at <session-dir>/trust.bundle, so:
  //      sessionDir = path.dirname(bundleFile)
  //      flowAgentsDir = path.dirname(sessionDir)
  try {
    const sessionDir = path.dirname(bundleFile);
    const flowAgentsDir = path.dirname(sessionDir);
    const currentFile = path.join(flowAgentsDir, "current.json");
    const current = JSON.parse(fs.readFileSync(currentFile, "utf8")) as Record<string, unknown>;
    const flowId = typeof current["active_flow_id"] === "string" ? current["active_flow_id"] : null;
    if (flowId && flowId.includes(".")) {
      const kitId = flowId.split(".")[0]!;
      if (kitId) {
        const derivedClaimType = `${kitId}.trust.bundle`;
        return { claimType: derivedClaimType, kitId, subject: `${kitId}-kit`, gateId: derivedClaimType };
      }
    }
  } catch {
    // Ignore — fall through to unknown
  }
  // 3. Genuinely unknown — never fallback to "builder".
  return { claimType: "unknown.trust.bundle", kitId: "unknown", subject: "unknown-kit", gateId: "unknown.trust.bundle" };
}
function surfaceCheckFromArtifact(file: string, index: number): AnyObj {
  const raw = JSON.parse(read(file));
  const lower = JSON.stringify(raw).toLowerCase();
  // Structurally read kit identity from the bundle — never hardcode "builder".
  const { claimType: bundleClaimType, subject: bundleSubject, gateId: bundleGateId } = kitIdentityFromBundle(raw, file);
  let ref: AnyObj;
  if (lower.includes("provider") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "provider.unavailable", claim_type: bundleClaimType, claim_status: "unknown", subject: bundleSubject, freshness: { status: "unknown", summary: "No trust provider is configured" }, authority: { producer: "unknown", summary: "No trust provider is configured" }, integrity: { status: "unknown", summary: "Unknown" }, status: "not_verified", summary: "No trust provider is configured" };
  } else if (lower.includes("artifact") && lower.includes("absent")) {
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: "artifact.unavailable", claim_type: bundleClaimType, claim_status: "unknown", subject: bundleSubject, freshness: { status: "unknown", summary: "Artifact not readable" }, authority: { producer: "unknown", summary: "Artifact not readable" }, integrity: { status: "unknown", summary: "Artifact not readable" }, status: "not_verified", summary: "artifact not readable" };
  } else {
    const claimStatus = lower.includes("rejected") ? "rejected" : "accepted";
    const freshness = lower.includes("stale") ? "stale" : "fresh";
    const producer = lower.includes("missing-authority") ? "unknown" : "surface-local";
    const integrity = lower.includes("mismatch") ? "mismatch" : "matched";
    // Use trust.bundle as the canonical Hachure-aligned artifact_kind for all trust-backed evidence refs
    ref = { artifact_kind: "trust.bundle", artifact_ref: file, gate_id: bundleGateId, claim_type: bundleClaimType, claim_status: claimStatus, subject: bundleSubject, freshness: { status: freshness, summary: freshness === "fresh" ? "fresh" : "not currently verifiable" }, authority: { producer, summary: producer === "unknown" ? "missing authority" : "Local Surface trust producer." }, integrity: { status: integrity, summary: integrity === "matched" ? "matched" : "integrity mismatch" } };
    ref.status = deriveSurfaceStatus(ref);
    ref.summary = ref.status === "pass" ? "accepted" : ref.status === "not_verified" ? "not currently verifiable" : (claimStatus === "rejected" ? "rejected" : producer === "unknown" ? "missing authority" : "integrity mismatch");
  }
  return { id: `surface-trust-${index + 1}`, kind: "policy", status: ref.status, summary: ref.summary, surface_trust_refs: [ref] };
}

function validateAcceptanceEvidenceRefs(dir: string): void {
  const file = path.join(dir, "acceptance.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.criteria)) return;
  data.criteria.forEach((criterion: AnyObj, index: number) => {
    if (criterion.evidence_refs !== undefined) normalizeEvidenceRefs(criterion.evidence_refs, `acceptance.criteria[${index}].evidence_refs`);
  });
}
export function writeState(dir: string, slug: string, status: string, phase: string, timestamp: string, summary: string, next = "continue"): void {
  writeJson(path.join(dir, "state.json"), { ...loadJson(path.join(dir, "state.json")), ...sidecarBase(slug), status, phase, updated_at: timestamp, artifact_paths: relArtifacts(dir), next_action: { status: next, summary } });
}
// ─── Phase 4c: bundle-only helpers ───────────────────────────────────────────
// After 4c, evidence.json and critique.json are no longer written.
// Extract checks and critiques from the existing trust.bundle for callers that
// need to rebuild the bundle (e.g. record-critique, record-learning).

// ADR 0016 Abstraction A (Step 0 Q3 carry-forward): build the set of declared
// claimTypes from the active flow step for the session at `dir`. When no active
// flow is present (workflow.* sessions), returns an empty set so every existing
// predicate is unchanged. When a FlowDefinition-driven session (builder.build)
// is active, the set contains the kit-typed claimTypes (e.g. "builder.verify.tests",
// "builder.verify.policy-compliance") so round-trip helpers broaden their filters
// to include declared claims alongside the legacy workflow.* ones.
//
// Safety guard: current.json in the .flow-agents dir records the CURRENTLY ACTIVE
// session via artifact_dir. If current.json points to a different session than `dir`
// (e.g. another session was the last to call advance-state --flow-definition), we
// return an empty set so declared-type predicates are NOT applied to the wrong session.
// This prevents a cross-session active_flow_id from broadening claim filters for
// unrelated sessions (which would cause spurious evidence/critique check behavior).
function declaredClaimTypesFor(dir: string): Set<string> {
  const flowAgentsDir = path.dirname(dir);
  // Verify that current.json points to `dir` before reading active flow step.
  // If it points to a different session, return empty set (zero behavior change).
  const currentFile = path.join(flowAgentsDir, "current.json");
  try {
    const current = JSON.parse(fs.readFileSync(currentFile, "utf8")) as Record<string, unknown>;
    const artDir = typeof current["artifact_dir"] === "string" ? current["artifact_dir"] : null;
    if (!artDir) return new Set<string>();
    const resolvedCurrent = path.resolve(flowAgentsDir, artDir);
    if (path.resolve(dir) !== resolvedCurrent) return new Set<string>();
  } catch {
    return new Set<string>();
  }
  const activeStep = resolveActiveFlowStep(flowAgentsDir);
  if (!activeStep || activeStep.gateExpects.length === 0) return new Set<string>();
  return new Set<string>(activeStep.gateExpects.map((e) => e.bundle_claim.claimType));
}

function checksFromBundle(dir: string, declaredClaimTypes: Set<string> = new Set()): AnyObj[] {
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (!Array.isArray(bundle.evidence)) return [];
  const allClaims: AnyObj[] = Array.isArray(bundle.claims) ? bundle.claims : [];
  const claimById = new Map<string, AnyObj>();
  for (const c of allClaims) if (c && c.id) claimById.set(c.id, c);
  const seen = new Set<string>();
  const checks: AnyObj[] = [];
  for (const ev of bundle.evidence) {
    if (!ev || !ev.claimId) continue;
    const claim = claimById.get(ev.claimId);
    if (!claim) continue;
    const ct = String(claim.claimType || "");
    // ADR 0016 Step 0: broaden to include declared kit-typed claims alongside workflow.check.*
    if (!ct.startsWith("workflow.check.") && !declaredClaimTypes.has(ct)) continue;
    if (seen.has(ev.claimId)) continue;
    seen.add(ev.claimId);
    const kind = ct.startsWith("workflow.check.") ? (ct.replace("workflow.check.", "") || "external") : (ct.split(".").pop() || "external");
    const status = claim.value ?? "not_verified";
    const check: AnyObj = { id: String(claim.subjectId || "").split("/").pop() || ev.claimId, kind, status, summary: claim.fieldOrBehavior || "" };
    if (ev.execution && typeof ev.execution.label === "string") check.command = ev.execution.label;
    if (ev.evidenceType) check.evidenceType = ev.evidenceType;
    checks.push(check);
  }
  // Also include check claims that have no evidence item (surface_trust_refs style)
  for (const claim of allClaims) {
    if (!claim) continue;
    const ct = String(claim.claimType || "");
    // ADR 0016 Step 0: broaden to include declared kit-typed claims alongside workflow.check.*
    if (!ct.startsWith("workflow.check.") && !declaredClaimTypes.has(ct)) continue;
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    const kind = ct.startsWith("workflow.check.") ? (ct.replace("workflow.check.", "") || "external") : (ct.split(".").pop() || "external");
    checks.push({ id: String(claim.subjectId || "").split("/").pop() || claim.id, kind, status: claim.value ?? "not_verified", summary: claim.fieldOrBehavior || "" });
  }
  return checks;
}
function critiquesFromBundle(dir: string, declaredClaimTypes: Set<string> = new Set()): AnyObj[] {
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (!Array.isArray(bundle.claims)) return [];
  // ADR 0016 Step 0: broaden to include declared kit-typed critique claims alongside workflow.critique.review.
  // P-d: exclude claims that have evidence items (evidence = check claims, not critique claims).
  // This prevents check-type declared claims (e.g. builder.verify.tests) from being read back
  // as critiques when declaredClaimTypes includes all gate expects[] types.
  const evidenceClaimIds = new Set<string>(
    Array.isArray(bundle.evidence) ? bundle.evidence.map((e: AnyObj) => e?.claimId).filter((id: unknown): id is string => typeof id === "string") : []
  );
  const critiqueClaims = bundle.claims.filter((c: AnyObj) => c && (c.claimType === "workflow.critique.review" || declaredClaimTypes.has(c.claimType)) && !evidenceClaimIds.has(c.id));
  return critiqueClaims.map((c: AnyObj) => ({
    id: String(c.subjectId || "").split("/").pop() || c.id,
    verdict: c.value ?? "not_verified",
    summary: c.fieldOrBehavior || "",
    findings: [],
    reviewer: "tool-code-reviewer",
    reviewed_at: c.updatedAt || c.createdAt || now(),
    artifact_refs: [],
  }));
}
// ─────────────────────────────────────────────────────────────────────────────
async function recordEvidence(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const verdict = opt(p, "verdict") || die("--verdict is required");
  if (!verdicts.has(verdict)) die("verdict must be one of: pass, partial, fail, not_verified");
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const checks = [...opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json"))), ...opts(p, "surface-trust-json").map(surfaceCheckFromArtifact)];
  if (!checks.length && opts(p, "surface-trust-json").length === 0) die("record-evidence requires at least one --check-json or --surface-trust-json");
  validateAcceptanceEvidenceRefs(dir);
  // Phase 4c: bundle is the sole verification artifact — stop writing evidence.json and acceptance.json update.
  const ts = opt(p, "timestamp", now());
  const _existingAcceptance = loadJson(path.join(dir, "acceptance.json"));
  const _existingCriteria: AnyObj[] = Array.isArray(_existingAcceptance.criteria) ? _existingAcceptance.criteria : [];
  const _criteriaStatus = verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "not_verified";
  const _criteriaForBundle: AnyObj[] = _existingCriteria.map((c: AnyObj) => ({ ...c, status: _criteriaStatus }));
  assertBundleWritten(await writeTrustBundle(dir, slug, ts, checks, _criteriaForBundle, []));
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  writeState(dir, slug, stateStatus, "verification", ts, "Evidence recorded.");
  return 0;
}

function diagnostic(dir: string, code: string, summary: string): never {
  const payload = { timestamp: now(), code, summary };
  appendJsonl(path.join(dir, "transition-diagnostics.jsonl"), payload);
  die(`${code}: ${summary}`);
}

/**
 * record-gate-claim — Generic gate-claim producer for skills (ADR 0016 P-d Increment 1).
 *
 * Allows a skill to record a claim that satisfies a SPECIFIC gate expectation at the
 * active step. The caller passes:
 *   --status <pass|fail|not_verified>  (required)
 *   --summary <text>                   (required)
 *   --expectation <id>                 (optional; auto-resolved when the gate has one entry)
 *   --evidence-json <json>             (optional; structured evidence refs)
 *
 * The producer emits a check of kind="external" targeting the gate expectation's declared
 * claimType + subjectType from the active step's expects[]. This populates the trust.bundle
 * with a correctly-typed claim derived by Surface, suitable for gate enforcement.
 *
 * When the gate has exactly ONE expects[] entry, --expectation is optional (auto-resolve).
 * When the gate has multiple entries, --expectation <id> is required.
 *
 * This is what Increment 2's 6 skills will call to satisfy the category (c) gates
 * (pull-work.selected, design-probe.*, pr-open.pull-request, learn.*) once producers are added.
 *
 * Error cases:
 *   - No active flow/step in current.json → die with actionable message
 *   - --expectation not found in expects[] → die
 *   - Multiple expects[] entries and --expectation omitted → die
 *   - Surface unavailable → assertBundleWritten fails loud (no silent data loss)
 */
async function recordGateClaim(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const ts = opt(p, "timestamp", now());
  const statusVal = opt(p, "status");
  if (!["pass", "fail", "not_verified"].includes(statusVal)) die("--status must be one of: pass, fail, not_verified");
  const summary = opt(p, "summary") || die("--summary is required");
  const expectationId = opt(p, "expectation");

  // Resolve the active flow step from current.json
  const flowAgentsDir = path.dirname(dir);
  const activeStep = resolveActiveFlowStep(flowAgentsDir);
  if (!activeStep) die("record-gate-claim requires an active flow step in current.json (set via ensure-session --flow-id or advance-state --flow-definition)");

  const expects = activeStep.gateExpects;
  if (expects.length === 0) die(`record-gate-claim: active step "${activeStep.stepId}" gate "${activeStep.gateId}" has no expects[] entries`);

  // Resolve the target expects entry
  let targetExpectation: typeof expects[0] | undefined;
  if (expectationId) {
    targetExpectation = expects.find((e) => e.id === expectationId);
    if (!targetExpectation) die(`record-gate-claim: --expectation "${expectationId}" not found in gate "${activeStep.gateId}" expects[]. Available: ${expects.map((e) => e.id).join(", ")}`);
  } else if (expects.length === 1) {
    targetExpectation = expects[0]!;
  } else {
    die(`record-gate-claim: gate "${activeStep.gateId}" has ${expects.length} expects[] entries; --expectation <id> is required. Available: ${expects.map((e) => e.id).join(", ")}`);
  }

  const { claimType, subjectType } = targetExpectation.bundle_claim;

  // Build a synthetic external check that will be matched by matchExpectsEntry to produce
  // a correctly-typed claim. We use kind="external" so it routes through the non-policy,
  // non-flow-step fallback path. The subjectType on the resulting claim comes from the
  // expects[] entry via matchExpectsEntry.
  const checkId = expectationId || targetExpectation.id;
  // Build a minimal "external" check. Include _gate_claim_expectation_id so that
  // matchExpectsEntry can do an exact lookup for multi-expects[] gates (ADR 0016 P-d Increment 2).
  // normalizeCheck preserves extra underscore-prefixed fields without stripping them.
  const check: AnyObj = {
    id: `gate-claim-${checkId}`,
    kind: "external",
    status: statusVal,
    summary,
    _gate_claim_expectation_id: targetExpectation.id,
  };

  // Include structured evidence refs if provided
  const evidenceRefs: AnyObj[] = opts(p, "evidence-ref-json").map((v) => validateEvidenceRef(parseJson(v, "--evidence-ref-json"), "--evidence-ref-json"));

  if (evidenceRefs.length > 0) {
    check.artifact_refs = evidenceRefs;
  }

  const checkNormalized = normalizeCheck(check);
  // Log the targeted gate expectation for transparency (goes to stderr only)
  process.stderr.write(`[record-gate-claim] targeting ${activeStep.stepId}/${activeStep.gateId}/${targetExpectation.id} → claimType=${claimType} subjectType=${subjectType}\n`);
  assertBundleWritten(await writeTrustBundle(dir, slug, ts, [checkNormalized], [], []));
  return 0;
}

async function advanceState(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const status = opt(p, "status");
  const phase = opt(p, "phase");
  const target = opt(p, "target-phase");
  if (!statuses.has(status)) die(`status must be one of: ${[...statuses].join(", ")}`);
  if (!phases.includes(phase)) die(`phase must be one of: ${phases.join(", ")}`);
  if (target && !phases.includes(target)) die(`target phase must be one of: ${phases.join(", ")}`);
  const prev = loadJson(path.join(dir, "state.json"));
  if ((status === "archived" || status === "accepted") && prev.phase !== "learning") diagnostic(dir, "terminal_jump_rejected", "Terminal workflow states require release and learning gates.");
  const flow = opt(p, "flow-definition");
  // Route-back guard: FlowDefinition-driven (not hardcoded to builder.build).
  // Fires when the active flow's gate for prev.phase declares a route_back_policy
  // AND the target phase maps to a step listed in on_route_back values.
  // builder.build verify-gate already carries this declaration — behavior preserved.
  const repoRoot = flow ? findRepoRootFromDir(dir) : "";
  const routeBack = flow ? resolveRouteBackPolicy(flow, prev.phase, phase, repoRoot) : null;
  if (routeBack) {
    const reason = opt(p, "route-back-reason");
    if (!reason) diagnostic(dir, "route_back_reason_required", `Route-back from ${prev.phase} to ${phase} requires a --route-back-reason (e.g. implementation_defect).`);
    const file = path.join(dir, "transition-attempts.json");
    const attempts = loadJson(file);
    const key = `${prev.phase}->${phase}:${reason}`;
    const count = attempts[key]?.count ?? 0;
    if (count >= routeBack.maxAttempts) diagnostic(dir, "route_back_attempts_exceeded", `Route-back attempt limit (${routeBack.maxAttempts}) exceeded for ${prev.phase}→${phase}.`);
    attempts[key] = { count: count + 1, reason, updated_at: opt(p, "timestamp", now()) };
    writeJson(file, attempts);
  }
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  writeState(dir, slug, status, phase, timestamp, opt(p, "summary"));
  writeJson(path.join(dir, "handoff.json"), { ...loadJson(path.join(dir, "handoff.json")), ...sidecarBase(slug), summary: opt(p, "summary"), current_state_ref: "state.json", next_steps: [opt(p, "next-action")].filter(Boolean), blockers: [], warnings: [] });
  // ADR 0016 Abstraction A (P-d, Increment 1): when --flow-definition is provided,
  // resolve the phase→step mapping from the FlowDefinition and write active_step_id
  // into current.json. This is the single setter — no skill needs to call ensure-session
  // --step-id individually. The repoRoot is derived by walking up from dir to find kits/.
  if (flow) {
    const root = path.resolve(opt(p, "artifact-root", path.dirname(dir)));
    // repoRoot already computed above when flow is present
    const phaseMap = resolvePhaseMap(flow, repoRoot);
    const stepId = phaseMap?.[phase] ?? undefined;
    if (stepId) {
      writeCurrent(root, dir, timestamp, "workflow-sidecar", "advance-state", flow, stepId);
    }
  }
  livenessLifecycle(dir, slug, LIVENESS_TERMINAL.has(status) ? "release" : "heartbeat", timestamp);
  // Trust checkpoint: when advancing to a terminal delivered status, seal the checkpoint.
  if (status === "delivered") {
    await sealTrustCheckpoint(dir, slug, timestamp, status, "release").catch(() => { /* best-effort; checkpoint seal must not break advance-state */ });
    // Publish delivery bundle: best-effort copy to delivery/ for CI trust-reconcile.
    await publishDelivery(dir, findRepoRootFromDir(dir)).catch(() => { /* best-effort; must not break advance-state */ });
  }
  return 0;
}

export function normalizeFinding(raw: AnyObj): AnyObj {
  if (raw.file_refs !== undefined && !Array.isArray(raw.file_refs)) die("file_refs must be an array");
  return raw;
}

async function recordCritique(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  // Phase 4c: accumulate existing critiques from trust.bundle (critique.json no longer written).
  // Fall back to critique.json for legacy sessions that still have it on disk.
  const existingCritiqueJson = loadJson(path.join(dir, "critique.json"), { critiques: [] });
  const legacyCritiques: AnyObj[] = Array.isArray(existingCritiqueJson.critiques) ? existingCritiqueJson.critiques : [];
  const _dctCritique = declaredClaimTypesFor(dir);
  const bundleCritiques = legacyCritiques.length === 0 ? critiquesFromBundle(dir, _dctCritique) : legacyCritiques;
  const critique = { id: opt(p, "id") || "review", reviewer: opt(p, "reviewer", "tool-code-reviewer"), reviewed_at: opt(p, "timestamp", now()), verdict: opt(p, "verdict", "pass"), summary: opt(p, "summary"), artifact_refs: opts(p, "artifact-ref"), findings: opts(p, "finding-json").map((v) => normalizeFinding(parseJson(v, "--finding-json"))) };
  const critiques = [...bundleCritiques, critique];
  if (critique.verdict === "pass" && critique.findings.some((f: AnyObj) => f.status === "open")) die("required critique must pass");
  // Phase 4c: build bundle from raw inputs; read checks from trust.bundle (evidence.json no longer written).
  const _critiqueEvChecks: AnyObj[] = checksFromBundle(dir, _dctCritique);
  const _critiqueAccCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  assertBundleWritten(await writeTrustBundle(dir, slug, critique.reviewed_at, _critiqueEvChecks, _critiqueAccCriteria, critiques));
  return 0;
}
function frontmatter(text: string, key: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text.slice(0, end))?.[1]?.trim() ?? "";
}
async function importCritique(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const review = p.positional[1] || die("review artifact is required");
  const text = read(review);
  const role = frontmatter(text, "role");
  if (!["review", "code-review"].includes(role)) die("review artifact must declare role");
  const verdictRaw = (frontmatter(text, "verdict") || /###\s+Verdict:\s*([A-Z_]+)/i.exec(text)?.[1] || "PASS").toUpperCase();
  const verdict = verdictRaw === "CHANGES_REQUESTED" || verdictRaw === "FAIL" ? "fail" : verdictRaw === "NOT_VERIFIED" ? "not_verified" : "pass";
  const findings: AnyObj[] = [];
  const re = /^####\s+\[(?<severity>[A-Z]+)\]\s+(?<target>.+?)\s+-\s+(?<title>.+)$/gm;
  for (let m; (m = re.exec(text));) {
    const title = m.groups?.title ?? "finding";
    findings.push({ id: slugify(title, `finding-${findings.length + 1}`), severity: (m.groups?.severity ?? "info").toLowerCase(), status: opt(p, "finding-status", verdict === "pass" ? "fixed" : "open"), description: title, file_refs: [m.groups?.target ?? review] });
  }
  const parsed = { ...p, positional: [dir], opts: { ...p.opts, id: [slugify(path.basename(review).replace(/\.md$/, ""), "review")], reviewer: ["tool-code-reviewer"], verdict: [verdict], summary: [`Imported critique from ${path.basename(review)}`], "finding-json": findings.map((f) => JSON.stringify(f)) }, flags: p.flags };
  const result = await recordCritique(parsed);
  if (verdict !== "pass") die("required critique must pass");
  return result;
}
async function recordRelease(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const decision = opt(p, "decision");
  if (!["merge", "release", "deploy", "hold", "rollback_required"].includes(decision)) die("decision must be one of: merge, release, deploy, hold, rollback_required");
  const gates = opts(p, "gate-json").map((v) => parseJson(v, "--gate-json"));
  if (["merge", "release", "deploy"].includes(decision) && !gates.some((g) => g.name === decision && g.status === "pass")) die(`positive release decision requires ${decision} gate to pass`);
  const payload = { ...sidecarBase(slug), decision: opt(p, "decision"), updated_at: opt(p, "timestamp", now()), scope: opt(p, "scope"), evidence_ref: opt(p, "evidence-ref"), gates: opts(p, "gate-json").map((v) => parseJson(v, "--gate-json")), rollback_plan: parseJson(opt(p, "rollback-json", '{"status":"not_required","summary":"Not required.","owner":"maintainer"}'), "--rollback-json"), observability_plan: parseJson(opt(p, "observability-json", '{"status":"not_required","summary":"Not required."}'), "--observability-json"), post_deploy_checks: opts(p, "post-deploy-json").map((v) => parseJson(v, "--post-deploy-json")), docs: parseJson(opt(p, "docs-json", '{"status":"not_needed","summary":"Not needed."}'), "--docs-json") };
  const stateSummary = opt(p, "summary").trim() || `Release readiness recorded for ${decision}.`;
  writeJson(path.join(dir, "release.json"), payload);
  writeState(dir, slug, "delivered", "release", payload.updated_at, stateSummary);
  // Trust checkpoint: seal at the "delivered" moment (the natural terminal mark for record-release).
  await sealTrustCheckpoint(dir, slug, payload.updated_at, "delivered", "release").catch(() => { /* best-effort; checkpoint seal must not break record-release */ });
  // Publish delivery bundle: best-effort copy to delivery/ for CI trust-reconcile.
  await publishDelivery(dir, findRepoRootFromDir(dir)).catch(() => { /* best-effort; must not break record-release */ });
  return 0;
}

// ─── Trust Checkpoint (Increment A) ──────────────────────────────────────────
// Per-run frozen snapshot of verified trust state at completion. Written to
// trust.checkpoint.json alongside the other workflow sidecars.
// Surface owns the DerivationCheckpoint shape; flow-agents wraps it in an
// ENVELOPE that adds per-run context surface does not carry.
//
// Envelope shape:
//   {
//     schema_version: "1.0",
//     slug: string,
//     work_item: string | null,
//     status: string,
//     phase: string,
//     sealed_at: ISO-8601,
//     commit_sha: string | null,
//     checkpoint: DerivationCheckpoint   ← surface owns this
//   }
//
// Idempotent: re-running advance-state / record-release to the same terminal
// status overwrites with the latest snapshot.
// Fail-open: if no trust.bundle exists, or Surface is unavailable, the write
// is skipped gracefully (no error surfaced to the caller).

/** Derive the current git HEAD sha — null if unavailable (not in a repo, git absent). */
function resolveCommitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build and write trust.checkpoint.json for a completed run.
 * Skips silently when:
 *   - trust.bundle is absent (no evidence recorded yet)
 *   - Surface is unavailable (checkpointFromReport not found)
 * The caller wraps this in .catch() so it never breaks the parent command.
 *
 * Increment B1 — checkpoint signing at the release boundary:
 * After the checkpoint is written, attempts Sigstore keyless signing (OIDC).
 *   - CI/OIDC available:   writes trust.checkpoint.sig.json (cosign-verifiable DSSE envelope)
 *                          and writes attestation:{status:"signed",...} to trust.checkpoint.attestation.json.
 *   - Local (no OIDC):     writes trust.checkpoint.intoto.json (unsigned in-toto statement)
 *                          and writes attestation:{status:"unsigned",...} to trust.checkpoint.attestation.json.
 * Signing is ALWAYS fail-open — a signing failure never breaks the seal.
 */
export async function sealTrustCheckpoint(dir: string, slug: string, sealedAt: string, status: string, phase: string): Promise<void> {
  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) return; // no bundle — skip gracefully
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.checkpointFromReport !== "function" || typeof surface.buildTrustReport !== "function") return; // Surface unavailable

  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const report = surface.buildTrustReport(bundle as Record<string, unknown>);
  const checkpoint = surface.checkpointFromReport(report);

  // Derive work_item from state.json if present (best-effort)
  let workItem: string | null = null;
  try {
    const stateRaw = loadJson(path.join(dir, "state.json"));
    if (typeof stateRaw.work_item === "string") workItem = stateRaw.work_item;
  } catch { /* ignored */ }

  const checkpointPath = path.join(dir, "trust.checkpoint.json");
  const envelope: AnyObj = {
    schema_version: "1.0",
    slug,
    work_item: workItem,
    status,
    phase,
    sealed_at: sealedAt,
    commit_sha: resolveCommitSha(),
    checkpoint,
  };
  writeJson(checkpointPath, envelope);

  // ─── Increment B1: sign the checkpoint at the release boundary ───────────────
  // Additive: if surface lacks in-toto/sigstore primitives, skip silently.
  // The .catch() at the call site already guards the parent command; this inner
  // catch is defense-in-depth so signing never propagates an error upward.
  await signCheckpointAttestation(dir, surface, bundle, checkpointPath).catch((err) => {
    process.stderr.write(`[checkpoint-signing] signing skipped due to error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

/**
 * Increment B1 — Sign the trust checkpoint with in-toto/Sigstore.
 *
 * Called from sealTrustCheckpoint AFTER trust.checkpoint.json is written.
 * Computes the sha256 digest of the checkpoint file, builds an in-toto Statement
 * (predicate = trust bundle), and attempts Sigstore keyless signing.
 *
 *   - Signed (CI/OIDC):  writes trust.checkpoint.sig.json (DSSE envelope, cosign-verifiable).
 *   - Unsigned (local):  writes trust.checkpoint.intoto.json (unsigned statement).
 *   - Always writes:     trust.checkpoint.attestation.json with attestation:{status,path,...}.
 *                        trust.checkpoint.json is NOT modified after its digest is computed.
 *
 * NEVER throws — all errors are caught and surfaced as stderr warnings.
 * Skips silently when Surface's toInTotoStatement / signStatementWithSigstore are absent.
 *
 * @param dir            Session artifact directory.
 * @param surface        Loaded Surface module (may or may not have in-toto/sigstore exports).
 * @param bundle         Parsed trust.bundle (becomes the in-toto predicate).
 * @param checkpointPath Absolute path to the already-written trust.checkpoint.json.
 */
async function signCheckpointAttestation(
  dir: string,
  surface: SurfaceModule,
  bundle: AnyObj,
  checkpointPath: string,
): Promise<void> {
  // Guard: both primitives must be present (consumed from Surface, never reimplemented).
  if (typeof surface.toInTotoStatement !== "function" || typeof surface.signStatementWithSigstore !== "function") {
    process.stderr.write("[checkpoint-signing] Surface in-toto/sigstore primitives unavailable — skipping attestation\n");
    return;
  }

  // Step A: compute sha256 digest of trust.checkpoint.json (the SUBJECT).
  // The checkpoint is self-evidencing — its digest is the external anchor.
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const sha256hex = createHash("sha256").update(checkpointBytes).digest("hex");

  // Step B: build the in-toto Statement.
  //   subject  = the checkpoint file (what we are attesting TO)
  //   predicate = the trust bundle   (what the checkpoint CONTAINS)
  const subjects = [{ name: "trust.checkpoint.json", digest: { sha256: sha256hex } }];
  const statement = surface.toInTotoStatement(bundle as Record<string, unknown>, { subjects });

  // Step C: attempt Sigstore keyless signing (PRIMARY path).
  // signStatementWithSigstore returns null when no ambient OIDC credential is available
  // (local development, no ACTIONS_ID_TOKEN_REQUEST_URL). This is the expected local case.
  let signed: { envelope: { payloadType: "application/vnd.in-toto+json"; payload: string; signatures: Array<{ keyid: string; sig: string }> }; sigstoreBundle: unknown; assuranceLevel: "signed" } | null = null;
  try {
    signed = await surface.signStatementWithSigstore(statement);
  } catch (err) {
    // signStatementWithSigstore may throw on unexpected failures (network error, config error);
    // treat as fail-open: fall through to the unsigned path.
    process.stderr.write(`[checkpoint-signing] signStatementWithSigstore threw: ${err instanceof Error ? err.message : String(err)}\n`);
    signed = null;
  }

  let attestation: AnyObj;
  if (signed) {
    // CI/OIDC path: write the cosign-verifiable DSSE envelope.
    const sigPath = path.join(dir, "trust.checkpoint.sig.json");
    writeJson(sigPath, signed.envelope);
    const keyid = signed.envelope.signatures[0]?.keyid ?? "";
    attestation = {
      status: "signed",
      path: "trust.checkpoint.sig.json",
      keyid,
    };
    process.stderr.write(`[checkpoint-signing] checkpoint signed with Sigstore — envelope written to ${sigPath}\n`);
  } else {
    // Local/unsigned path: write the unsigned in-toto statement for audit purposes.
    const unsignedPath = path.join(dir, "trust.checkpoint.intoto.json");
    writeJson(unsignedPath, statement);
    attestation = {
      status: "unsigned",
      path: "trust.checkpoint.intoto.json",
      reason: "no ambient signing identity",
    };
    process.stderr.write("[checkpoint-signing] no ambient OIDC identity — unsigned in-toto statement written (expected locally)\n");
  }

  // Step D: write the attestation record to a SEPARATE companion file.
  // trust.checkpoint.json is NOT modified — it must remain byte-identical to what was signed.
  // The companion file carries the pointer/status; the subject-digest binding in the
  // in-toto statement ties it back to the checkpoint without breaking the digest.
  const attestationPath = path.join(dir, "trust.checkpoint.attestation.json");
  writeJson(attestationPath, attestation);
}

/**
 * seal-checkpoint <dir> [--timestamp <iso>]
 *
 * Explicit seal of the trust checkpoint for the given artifact dir.
 * Equivalent to the seal that fires automatically at record-release / advance-state
 * to delivered. Useful for the deliver skill or a human to seal explicitly without
 * re-running advance-state.
 *
 * Usage: workflow-sidecar seal-checkpoint <artifactDir> [--timestamp <iso>]
 */
async function sealCheckpoint(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  const stateRaw = loadJson(path.join(dir, "state.json"));
  const status = typeof stateRaw.status === "string" ? stateRaw.status : "delivered";
  const phase = typeof stateRaw.phase === "string" ? stateRaw.phase : "release";

  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[seal-checkpoint] no trust.bundle at ${bundlePath} — skipping (nothing to seal)
`);
    return 0;
  }
  await sealTrustCheckpoint(dir, slug, timestamp, status, phase);
  const checkpointPath = path.join(dir, "trust.checkpoint.json");
  if (fs.existsSync(checkpointPath)) {
    console.log(checkpointPath);
  } else {
    process.stderr.write(`[seal-checkpoint] checkpoint was not written — @kontourai/surface may be unavailable
`);
  }
  return 0;
}

// ─── Publish Delivery Bundle ──────────────────────────────────────────────────
// Copies the session's trust.bundle (+ checkpoint companions) from the gitignored
// session artifact dir (.flow-agents/<slug>/) to the committed delivery/ transport
// path so the CI trust-reconcile job can reconcile it against fresh CI results.
//
// Fail-soft: if trust.bundle is absent (no evidence recorded yet), does nothing.
// Idempotent: overwrites on re-delivery.
// Called automatically from recordRelease and advanceState→delivered (best-effort).
// Also exposed as the `publish-delivery <artifact-dir>` subcommand for explicit use.

/**
 * Publish the session's trust artifacts to the committed delivery/ path.
 *
 * Copies trust.bundle, trust.checkpoint.json, and (if present)
 * trust.checkpoint.intoto.json / trust.checkpoint.sig.json from the
 * session artifact dir to <repoRoot>/delivery/.
 *
 * Fail-soft: if trust.bundle is absent, returns without throwing.
 * Idempotent: overwrites on re-delivery.
 */
export async function publishDelivery(dir: string, repoRoot: string): Promise<void> {
  const bundleSrc = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundleSrc)) return; // no bundle — skip gracefully

  const deliveryDir = path.join(repoRoot, "delivery");
  fs.mkdirSync(deliveryDir, { recursive: true });

  // Required: trust.bundle (the CI anchor)
  fs.copyFileSync(bundleSrc, path.join(deliveryDir, "trust.bundle"));

  // Optional companions: checkpoint + signing artifacts
  const companions = [
    "trust.checkpoint.json",
    "trust.checkpoint.intoto.json",
    "trust.checkpoint.sig.json",
  ];
  for (const filename of companions) {
    const src = path.join(dir, filename);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(deliveryDir, filename));
    }
  }

  process.stderr.write(`[publish-delivery] published trust.bundle and companions to ${deliveryDir}\n`);
}

/**
 * publish-delivery <artifact-dir> [--repo-root <path>]
 *
 * Explicit publish of the session trust bundle to the committed delivery/ path.
 * Equivalent to the publish that fires automatically at record-release /
 * advance-state to delivered. Useful for the deliver skill or a human to
 * publish explicitly.
 *
 * Usage: workflow-sidecar publish-delivery <artifactDir> [--repo-root <path>]
 */
async function publishDeliveryCmd(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const repoRoot = opt(p, "repo-root") || findRepoRootFromDir(dir);
  await publishDelivery(dir, repoRoot);
  return 0;
}

export function validateLearningCorrection(record: AnyObj): void {
  const correction = record.correction;
  if (correction === undefined) return;
  if (!correction || typeof correction !== "object" || Array.isArray(correction)) die("correction must be an object");
  if (typeof correction.needed !== "boolean") die("correction.needed must be boolean");
  if (correction.needed === false) {
    if (typeof correction.evidence !== "string" || correction.evidence.length === 0) die("correction.evidence is required when correction.needed is false");
    return;
  }
  for (const key of ["type", "recurrence_key", "intended_behavior", "observed_behavior", "gap"]) {
    if (typeof correction[key] !== "string" || correction[key].length === 0) die(`correction.${key} is required when correction.needed is true`);
  }
  if (!["workflow", "skill", "agent", "tooling", "test", "doc", "process", "product", "provider", "none"].includes(correction.type)) {
    die("correction.type must be one of: workflow, skill, agent, tooling, test, doc, process, product, provider, none");
  }
  const prevention = correction.prevention;
  if (prevention !== undefined) validateLearningPrevention(prevention);
  const hasPrevention = prevention !== undefined;
  const hasNoChange = typeof correction.no_change_rationale === "string" && correction.no_change_rationale.length > 0;
  if (!hasPrevention && !hasNoChange) die("correction requires prevention route or no_change_rationale when correction.needed is true");
}
function validateLearningPrevention(prevention: unknown): void {
  if (!prevention || typeof prevention !== "object" || Array.isArray(prevention)) die("correction.prevention must be an object");
  const value = prevention as AnyObj;
  if (typeof value.target !== "string" || value.target.length === 0) die("correction.prevention.target is required");
  if (!["rule", "skill", "power", "agent", "eval", "doc", "backlog", "knowledge", "none"].includes(value.target)) die("correction.prevention.target must be one of: rule, skill, power, agent, eval, doc, backlog, knowledge, none");
  if (typeof value.action !== "string" || value.action.length === 0) die("correction.prevention.action is required");
  if (typeof value.status !== "string" || value.status.length === 0) die("correction.prevention.status is required");
  if (!["open", "completed", "accepted", "deferred", "rejected"].includes(value.status)) die("correction.prevention.status must be one of: open, completed, accepted, deferred, rejected");
}
export function normalizeLearning(raw: AnyObj, timestamp: string): AnyObj {
  if (!Array.isArray(raw.source_refs)) die("source_refs must be an array");
  if (!Array.isArray(raw.facts)) die("facts must be an array");
  if (!Array.isArray(raw.routing)) die("routing must be an array");
  if (!["success", "failure", "mixed", "unknown"].includes(raw.outcome)) die("learning outcome must be one of: success, failure, mixed, unknown");
  validateLearningCorrection(raw);
  return { recorded_at: timestamp, ...raw };
}
async function recordLearning(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  const slug = taskSlugFor(dir, opt(p, "task-slug"));
  const timestamp = opt(p, "timestamp", now());
  const records = opts(p, "record-json").map((v) => normalizeLearning(parseJson(v, "--record-json"), timestamp));
  const status = opt(p, "status", "learned");
  if (status === "learned" && records.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learning status learned cannot have open routing");
  if (status === "learned" && records.some((r) => r.correction === undefined)) die("learning status learned requires every record to include correction.needed");
  writeJson(path.join(dir, "learning.json"), { ...sidecarBase(slug), status, updated_at: timestamp, records });
  writeState(dir, slug, "accepted", "learning", timestamp, opt(p, "summary"));
  // Phase 4c: build bundle from raw inputs; read checks/critiques from trust.bundle (bespoke sidecars no longer written).
  // ADR 0016 Step 0: pass declaredClaimTypes so declared builder.* claims survive the round-trip.
  const _dctLearning = declaredClaimTypesFor(dir);
  const _learningChecks: AnyObj[] = checksFromBundle(dir, _dctLearning);
  const _learningCriteria: AnyObj[] = Array.isArray(loadJson(path.join(dir, "acceptance.json")).criteria) ? loadJson(path.join(dir, "acceptance.json")).criteria : [];
  const _learningCritiques: AnyObj[] = critiquesFromBundle(dir, _dctLearning);
  assertBundleWritten(await writeTrustBundle(dir, slug, timestamp, _learningChecks, _learningCriteria, _learningCritiques));
  return 0;
}
function evidenceClean(dir: string, declaredClaimTypes: Set<string> = new Set()): boolean {
  // Phase 4c: read from trust.bundle (sole verification artifact); fall back to evidence.json for legacy sessions.
  // ADR 0016 Step 0: declaredClaimTypes broadens the filter to include kit-typed check claims
  // (e.g. builder.verify.tests) in addition to workflow.check.* for FlowDefinition-driven sessions.
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (Array.isArray(bundle.claims)) {
    const checkClaims = (bundle.claims as AnyObj[]).filter((c: AnyObj) => {
      if (!c) return false;
      const ct = String(c.claimType || "");
      return ct.startsWith("workflow.check.") || declaredClaimTypes.has(ct);
    });
    if (checkClaims.length === 0) return false;
    return checkClaims.every((c: AnyObj) => {
      const v = String(c.value || "");
      return v === "pass" || v === "skip";
    });
  }
  // Legacy fallback: evidence.json
  const e = loadJson(path.join(dir, "evidence.json"), {});
  return e.verdict === "pass" && Array.isArray(e.checks) && e.checks.length > 0 && e.checks.every((c: AnyObj) => {
    if (!(c.status === "pass" || c.status === "skip")) return false;
    return !Array.isArray(c.standard_refs) || c.standard_refs.every((r: AnyObj) => ["junit", "sarif", "coverage", "veritas"].includes(r.standard));
  });
}
function critiqueClean(dir: string, declaredClaimTypes: Set<string> = new Set()): boolean {
  // Phase 4c: read from trust.bundle (sole verification artifact); fall back to critique.json for legacy sessions.
  // ADR 0016 Step 0: declaredClaimTypes broadens the filter to include kit-typed critique claims
  // (e.g. builder.verify.policy-compliance) in addition to workflow.critique.review.
  const bundle = loadJson(path.join(dir, "trust.bundle"));
  if (Array.isArray(bundle.claims)) {
    const critiqueClaims = (bundle.claims as AnyObj[]).filter((c: AnyObj) => c && (c.claimType === "workflow.critique.review" || declaredClaimTypes.has(c.claimType)));
    if (critiqueClaims.length === 0) return false; // no critique written yet
    return critiqueClaims.every((c: AnyObj) => {
      const v = String(c.value || "");
      return v !== "fail" && c.status !== "disputed" && c.status !== "rejected";
    });
  }
  // Legacy fallback: critique.json
  const c = loadJson(path.join(dir, "critique.json"), {});
  return c.status === "pass" && Array.isArray(c.critiques) && c.critiques.every((x: AnyObj) => x.verdict !== "fail" && (!Array.isArray(x.findings) || x.findings.every((f: AnyObj) => f.status !== "open" && (f.file_refs === undefined || Array.isArray(f.file_refs)))));
}
function assertExistingLearningValid(dir: string): void {
  const file = path.join(dir, "learning.json");
  if (!fs.existsSync(file)) return;
  const data = loadJson(file);
  if (!Array.isArray(data.records)) die("learning records must be an array");
  for (const record of data.records) {
    if (!Array.isArray(record.source_refs)) die("source_refs must be an array");
    if (!Array.isArray(record.facts)) die("facts must be an array");
    if (!Array.isArray(record.routing)) die("routing must be an array");
    validateLearningCorrection(record);
    if (data.status === "learned" && record.correction === undefined) die("learning status learned requires every record to include correction.needed");
  }
}
async function dogfoodPass(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = path.resolve(opt(p, "artifact-dir") || currentDir(root) || "");
  requireArtifactDirUnderRoot(dir, root);
  assertExistingLearningValid(dir);
  const verdict = opt(p, "verdict");
  if (verdict === "pass") {
    const checks = opts(p, "check-json").map((v) => normalizeCheck(parseJson(v, "--check-json")));
    if (checks.some((c) => c.status !== "pass" && c.status !== "skip")) die("clean evidence requires all non-skipped checks to pass");
    // Phase 4c: evidence check reads from trust.bundle (sole verification artifact); legacy evidence.json fallback in evidenceClean.
    // ADR 0016 Step 0: pass declaredClaimTypes so builder.* check/critique claims count as clean evidence.
    const _dctDogfood = declaredClaimTypesFor(dir);
    const _hasBundleEvidence = fs.existsSync(path.join(dir, "trust.bundle")) && evidenceClean(dir, _dctDogfood);
    const _hasLegacyEvidence = fs.existsSync(path.join(dir, "evidence.json")) && evidenceClean(dir, _dctDogfood);
    if (!_hasBundleEvidence && !_hasLegacyEvidence && fs.existsSync(path.join(dir, "trust.bundle"))) die("cannot mark clean without passing evidence");
    if (!_hasBundleEvidence && !_hasLegacyEvidence && !fs.existsSync(path.join(dir, "trust.bundle")) && fs.existsSync(path.join(dir, "evidence.json"))) die("cannot mark clean without passing evidence");
    if (!_hasBundleEvidence && !_hasLegacyEvidence && !fs.existsSync(path.join(dir, "trust.bundle")) && !fs.existsSync(path.join(dir, "evidence.json")) && checks.length === 0) die("cannot mark clean without passing evidence");
    if (p.flags.has("require-critique") || opt(p, "release-decision")) {
      const newCritiqueVerdict = opt(p, "critique-verdict", "pass");
      for (const value of opts(p, "finding-json")) normalizeFinding(parseJson(value, "--finding-json"));
      if (newCritiqueVerdict !== "pass") die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
      if (!opt(p, "critique-id") && !critiqueClean(dir, _dctDogfood)) die("requires passing critique");
      // Phase 4c: if existing state has a dirty critique (in bundle or legacy critique.json), block even when adding a new critique-id.
      if (!critiqueClean(dir, _dctDogfood) && (fs.existsSync(path.join(dir, "trust.bundle")) || fs.existsSync(path.join(dir, "critique.json")))) die(opt(p, "release-decision") ? "requires clean critique" : "requires clean critique before recording pass evidence");
    }
  }
  const learningRecords = opts(p, "learning-record-json").map((v) => normalizeLearning(parseJson(v, "--learning-record-json"), opt(p, "timestamp", now())));
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.routing.some((x: AnyObj) => x.status === "open"))) die("learned status cannot have open learning routing");
  if (opt(p, "learning-status") === "learned" && learningRecords.some((r) => r.correction === undefined)) die("learned status requires every learning record to include correction.needed");
  if (opts(p, "check-json").length) await recordEvidence({ ...p, positional: [dir], opts: { ...p.opts, verdict: [verdict] }, flags: p.flags });
  if (p.flags.has("require-critique") && opt(p, "critique-id")) await recordCritique({ ...p, positional: [dir], opts: { ...p.opts, id: [opt(p, "critique-id")], verdict: [opt(p, "critique-verdict", "pass")], summary: [opt(p, "critique-summary", opt(p, "summary"))] }, flags: p.flags });
  if (learningRecords.length) await recordLearning({ ...p, positional: [dir], opts: { ...p.opts, status: [opt(p, "learning-status", "learned")], "record-json": opts(p, "learning-record-json"), summary: [opt(p, "learning-summary", opt(p, "summary"))] }, flags: p.flags });
  if (opt(p, "release-decision")) {
    recordRelease({ ...p, positional: [dir], opts: { ...p.opts, decision: [opt(p, "release-decision")], scope: [opt(p, "release-scope")], summary: [opt(p, "release-summary", opt(p, "summary"))], "gate-json": ['{"name":"merge","status":"pass","summary":"Dogfood release gate passed."}'], "evidence-ref": ["evidence.json"], "docs-json": [`{"status":"updated","summary":"Docs updated.","refs":["${opt(p, "release-doc-ref", "docs/workflow-usage-guide.md")}"]}`] }, flags: p.flags });
    printJson({ release_decision: opt(p, "release-decision") });
    return 0;
  }
  const stateStatus = verdict === "pass" ? "verified" : verdict === "fail" ? "failed" : "not_verified";
  const handoff = loadJson(path.join(dir, "handoff.json"));
  if (verdict === "fail") {
    handoff.blockers = ["Required dogfood critique is not passing"];
    writeJson(path.join(dir, "handoff.json"), handoff);
  }
  writeState(dir, taskSlugFor(dir, opt(p, "task-slug")), stateStatus, "verification", opt(p, "timestamp", now()), opt(p, "summary"), verdict === "pass" ? "continue" : "blocked");
  // Phase 4c: bundle was already written by recordEvidence/recordCritique above (if called).
  // If neither ran (e.g. verdict=fail with no check-json), re-build from bundle (no bespoke sidecars).
  printJson({ state_status: stateStatus });
  return 0;
}

// ─── Gate Review — Canonical InquiryRecord output ────────────────────────────
// Reads trust.bundle + gate block signal, classifies gate fires/misses (as
// correct / false_block / missed_block), and emits gate-review.inquiries.json
// as an array of canonical Surface InquiryRecords. ADVISORY ONLY — #119.
// Never modifies scripts/hooks/. Consumes Surface.resolveInquiry; no fork.

/** Shape of a claim from the trust.bundle */
export interface TrustClaim {
  id: string;
  subjectType: string;
  subjectId: string;
  surface: string;
  claimType: string;
  fieldOrBehavior: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  status: "verified" | "disputed" | "assumed" | "proposed" | "rejected" | "stale" | "unknown";
}

/** Shape of the trust.bundle file */
export interface BundleFile {
  schemaVersion: number;
  source: string;
  claims: TrustClaim[];
  evidence: AnyObj[];
  events: AnyObj[];
  policies: AnyObj[];
}

/** The gate block signal read from .flow-agents/.goal-fit-block-streak.json */
export interface GateBlockSignal {
  /** True when the streak file exists AND count >= 1 */
  blocked: boolean;
  /** The hash from the streak file (for rationale citation) */
  hash: string | null;
  /** The consecutive block count */
  count: number;
}

/**
 * The gate-review calibration verdict, stored in InquiryRecord.answer.value.
 * This is gate-review's value-add over the canonical InquiryRecord outcome.
 */
export type GateCalibration = "correct" | "false_block" | "missed_block";

/**
 * Read the gate block signal from .flow-agents/.goal-fit-block-streak.json
 * (written by scripts/hooks/stop-goal-fit.js when block mode fires).
 * The file sits at <artifact-root>/.goal-fit-block-streak.json — one level
 * above the session artifact dir. Fail-open: returns { blocked: false } when
 * the file is absent or unreadable.
 *
 * @param artifactRoot  The .flow-agents root dir (parent of session slug dir).
 */
export function readGateBlockSignal(artifactRoot: string): GateBlockSignal {
  const streakFile = path.join(artifactRoot, ".goal-fit-block-streak.json");
  try {
    if (!fs.existsSync(streakFile)) return { blocked: false, hash: null, count: 0 };
    const raw = JSON.parse(fs.readFileSync(streakFile, "utf8"));
    const count = Number(raw?.count ?? 0);
    const hash = typeof raw?.hash === "string" ? raw.hash : null;
    return { blocked: count >= 1, hash, count };
  } catch {
    return { blocked: false, hash: null, count: 0 };
  }
}

/**
 * Derive the gate-review calibration from a resolved InquiryRecord and the
 * block signal.  Pure function — no I/O.
 *
 * Mapping (mirrors SKILL.md Bundle-Claim to Classification table):
 *   outcome="matched", status="disputed"|"rejected", blocked=true  → correct
 *   outcome="matched", status="verified"|"assumed",  blocked=true  → false_block
 *   outcome="matched", status="assumed",             blocked=true  → false_block
 *   outcome="matched", status="stale"|"unknown",     blocked=false → missed_block
 *   outcome="matched", status="proposed",            any          → missed_block
 *   outcome="unsupported" (absent claim),            any          → missed_block
 *   outcome="derived",   satisfied=true,             any          → correct/false_block by blocked flag
 *   fallthrough                                                    → missed_block
 */
export function deriveGateCalibration(
  outcome: "matched" | "derived" | "unsupported",
  answerStatus: string | undefined,
  blocked: boolean,
): GateCalibration {
  if (outcome === "unsupported") return "missed_block";
  if (outcome === "matched" || outcome === "derived") {
    const s = answerStatus ?? "unknown";
    if (blocked) {
      if (s === "disputed" || s === "rejected") return "correct";
      if (s === "verified" || s === "assumed") return "false_block";
      // stale/unknown/proposed while blocked — gate fired without solid evidence
      return "false_block";
    } else {
      // Not blocked
      if (s === "stale" || s === "unknown" || s === "proposed") return "missed_block";
      // verified/assumed and no block — correct (no block warranted, none issued)
      return "correct";
    }
  }
  return "missed_block";
}

/**
 * Compose the advisory proposed-fix string for a gate-review finding.
 * Pure function — no I/O.
 */
export function gateAdvisoryFix(
  calibration: GateCalibration,
  claimId: string,
  answerStatus: string | undefined,
): string {
  const s = answerStatus ?? "unknown";
  if (calibration === "correct") {
    return `No gate change needed — block was warranted. Resolve the failure in claim \`${claimId}\` (status: \`${s}\`) and re-run gate-review to confirm the gate clears.`;
  }
  if (calibration === "false_block") {
    return `Investigate why the gate blocked when claim \`${claimId}\` has status \`${s}\`. Check whether stop-goal-fit evaluated a stale bundle snapshot or whether the block trigger was unrelated to bundle claims. If the block was spurious, add a freshness check to the gate evaluation loop.`;
  }
  // missed_block
  if (s === "stale") {
    return `Refresh the stale claim \`${claimId}\` by re-running the evidence capture step, then re-run gate-review to confirm the gate fires on updated data.`;
  }
  if (s === "absent") {
    return `Ensure \`workflow-sidecar record-evidence\` writes a bundle claim for \`${claimId}\` before \`stop-goal-fit\` evaluates. Currently no claim exists in the bundle — the gate has nothing to evaluate.`;
  }
  return `Ensure \`workflow-sidecar record-evidence\` writes a definitive event for claim \`${claimId}\` (currently \`${s}\`) before \`stop-goal-fit\` evaluates. The gate had no resolved evidence to act on.`;
}

/**
 * Build a schema-conformant InquiryRecord for the hachure inquiry-record.schema.json.
 * Strips Surface-internal fields (identityLinkIds, transitiveRuleIds) from
 * resolutionPath that are valid in the TS type but not in the JSON schema.
 * Sets answer.value to the gate-review value-add: { calibration, advisoryFix, gateFired, sessionSlug }.
 */
function toSchemaInquiryRecord(
  raw: SurfaceInquiryRecord,
  calibration: GateCalibration,
  advisoryFix: string,
  blocked: boolean,
  slug: string,
): AnyObj {
  const resolutionPath: AnyObj = { claimIds: raw.resolutionPath.claimIds };
  if (raw.resolutionPath.ruleId !== undefined) resolutionPath["ruleId"] = raw.resolutionPath.ruleId;
  if (raw.resolutionPath.ruleVersion !== undefined) resolutionPath["ruleVersion"] = raw.resolutionPath.ruleVersion;
  const record: AnyObj = {
    id: raw.id,
    inquiry: raw.inquiry,
    outcome: raw.outcome,
    resolutionPath,
    inputSnapshot: raw.inputSnapshot,
    statusFunctionVersion: raw.statusFunctionVersion,
    resolvedAt: raw.resolvedAt,
  };
  // answer carries the canonical trust status AND gate-review's value-add advisory fix.
  // answer.status = derived TrustStatus from the resolved claim (or "unknown" when absent).
  // answer.value = { calibration, advisoryFix, gateFired, sessionSlug } — gate-review advisory.
  const answerStatus = raw.answer?.status ?? "unknown";
  record["answer"] = {
    status: answerStatus,
    value: {
      calibration,
      advisoryFix,
      gateFired: blocked,
      sessionSlug: slug,
    },
  };
  return record;
}

/**
 * Build an array of canonical InquiryRecords for all gate-fire and missed-block
 * candidates in the bundle, using Surface's resolveInquiry.  Returns null when
 * Surface is unavailable (caller skips the output file — no fork fallback).
 *
 * @param bundle              Parsed trust.bundle (BundleFile shape)
 * @param blockSignal         Result of readGateBlockSignal()
 * @param slug                Task slug (used in inquiry ids and session_slug)
 * @param expectedCriterionIds Optional list of expected criterion IDs to check
 *                            for absent claims (missed_block detection).
 * @param surface             Loaded Surface module (must have resolveInquiry)
 * @param now                 Optional timestamp override for deterministic tests
 */
export function buildGateInquiryRecords(
  bundle: BundleFile,
  blockSignal: GateBlockSignal,
  slug: string,
  expectedCriterionIds: string[],
  surface: SurfaceModule,
  now?: Date,
): AnyObj[] {
  const records: AnyObj[] = [];
  let idx = 0;
  const askedAt = (now ?? new Date()).toISOString();
  const bundleRecord = bundle as unknown as Record<string, unknown>;
  const claims = Array.isArray(bundle?.claims) ? bundle.claims : [];

  // Build a set of subjectIds already covered by bundle claims
  const claimSubjectIds = new Set<string>(claims.map((c) => c.subjectId));

  // ── Step 1: resolve each bundle claim via resolveInquiry ──────────────────
  for (const claim of claims) {
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Was gate action on claim ${claim.id} (status: ${claim.status}) justified given the trust state?`,
      askedBy: "gate-review",
      askedAt,
      target: {
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
        fieldOrBehavior: claim.fieldOrBehavior,
      },
      metadata: { sessionSlug: slug, claimId: claim.id, blocked: blockSignal.blocked },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    const calibration = deriveGateCalibration(rawRecord.outcome, rawRecord.answer?.status, blockSignal.blocked);
    const advisoryFix = gateAdvisoryFix(calibration, claim.id, rawRecord.answer?.status ?? claim.status);
    records.push(toSchemaInquiryRecord(rawRecord, calibration, advisoryFix, blockSignal.blocked, slug));
  }

  // ── Step 2: resolve absent expected criteria (missed_block candidates) ────
  for (const criterionId of expectedCriterionIds) {
    const subjectId = `${slug}/${criterionId}`;
    // Skip if there's already a bundle claim for this criterion
    if (claimSubjectIds.has(subjectId) || claimSubjectIds.has(criterionId)) continue;
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Was acceptance criterion "${criterionId}" claimed in the trust.bundle before gate evaluation?`,
      askedBy: "gate-review",
      askedAt,
      target: {
        subjectType: "workflow-check",
        subjectId,
        fieldOrBehavior: criterionId,
      },
      metadata: { sessionSlug: slug, criterionId, blocked: blockSignal.blocked, expectedCriterion: true },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    // outcome will be "unsupported" since no claim matches the absent criterion
    const calibration = deriveGateCalibration(rawRecord.outcome, rawRecord.answer?.status, blockSignal.blocked);
    const advisoryFix = gateAdvisoryFix(calibration, subjectId, "absent");
    records.push(toSchemaInquiryRecord(rawRecord, calibration, advisoryFix, blockSignal.blocked, slug));
  }

  // ── Step 3: if still empty (no claims, no expected criteria), emit one record
  if (records.length === 0) {
    idx += 1;
    const inquiryId = `${slug}-gr-${idx}`;
    const inquiry: SurfaceInquiry = {
      id: inquiryId,
      question: `Does the trust.bundle for session "${slug}" contain any claims for gate evaluation?`,
      askedBy: "gate-review",
      askedAt,
      // No target — natural-language-only inquiry → resolveInquiry returns "unsupported"
      metadata: { sessionSlug: slug, blocked: blockSignal.blocked, reason: "empty-bundle" },
    };
    const rawRecord = surface.resolveInquiry(bundleRecord, inquiry, { now });
    const advisoryFix = `Ensure \`workflow-sidecar record-evidence\` writes at least one claim to the trust.bundle for session \`${slug}\` before gate-review is invoked.`;
    records.push(toSchemaInquiryRecord(rawRecord, "missed_block", advisoryFix, blockSignal.blocked, slug));
  }

  return records;
}

/**
 * gate-review <artifact-dir>
 *
 * Reads the session's trust.bundle and the gate block signal, classifies each
 * gate fire or suspected miss using Surface's resolveInquiry, and emits
 * gate-review.inquiries.json as an array of canonical InquiryRecords.
 * ADVISORY ONLY — never modifies scripts/hooks/. Issue #119.
 *
 * The block signal is read from <artifact-root>/.goal-fit-block-streak.json,
 * written by scripts/hooks/stop-goal-fit.js when block mode fires. The file
 * lives one level above the session slug dir (the .flow-agents root).
 *
 * If @kontourai/surface is unavailable, logs a warning and returns 0
 * (fail-open — no bespoke fork fallback).
 */
async function gateReview(p: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = artifactDirFrom(p.positional[0] || die("artifact directory is required"));
  if (!fs.existsSync(dir)) die(`artifact directory does not exist: ${dir}`);
  const slug = taskSlugFor(dir, opt(p, "task-slug"));

  // Locate trust.bundle — required per SKILL.md contract
  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[gate-review] trust.bundle absent at ${bundlePath} — NOT_VERIFIED. Build ADR 0010 Phase 1 first.\n`);
    return 1;
  }

  // Load Surface (ESM, fail-open)
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.resolveInquiry !== "function") {
    process.stderr.write(`[gate-review] @kontourai/surface unavailable or missing resolveInquiry — gate-review skipped (no fork fallback)\n`);
    return 0;
  }

  const bundle: BundleFile = JSON.parse(fs.readFileSync(bundlePath, "utf8"));

  // Read gate block signal from .flow-agents root (one level above session dir)
  const artifactRoot = path.dirname(dir);
  const blockSignal = readGateBlockSignal(artifactRoot);

  // Enumerate expected criterion IDs: primary = bundle claims (workflow.acceptance.criterion),
  // fallback = acceptance.json (back-compat for sessions without an up-to-date bundle).
  const criterionClaims = Array.isArray(bundle.claims)
    ? (bundle.claims as AnyObj[]).filter((c: AnyObj) => c.claimType === "workflow.acceptance.criterion")
    : [];
  let expectedCriterionIds: string[];
  if (criterionClaims.length > 0) {
    // Extract the final segment of subjectId (e.g. "slug/AC1" → "AC1")
    expectedCriterionIds = criterionClaims
      .map((c: AnyObj) => String(c.subjectId ?? "").split("/").pop() ?? "")
      .filter(Boolean);
  } else {
    // Fallback: read acceptance.json (back-compat for sessions without criterion claims)
    const acceptancePath = path.join(dir, "acceptance.json");
    const acceptance = fs.existsSync(acceptancePath) ? (loadJson(acceptancePath) as AnyObj) : null;
    expectedCriterionIds = Array.isArray(acceptance?.criteria)
      ? (acceptance!.criteria as AnyObj[]).map((c: AnyObj) => String(c.id ?? "")).filter(Boolean)
      : [];
  }

  const records = buildGateInquiryRecords(bundle, blockSignal, slug, expectedCriterionIds, surface);

  // Validate each record against the hachure inquiry-record.schema.json (fail-open)
  const validator = getHachureInquiryRecordValidator();
  let schemaValid = true;
  const validationErrors: string[] = [];
  for (const record of records) {
    if (validator) {
      const result = validator(record);
      if (!result.valid) {
        schemaValid = false;
        validationErrors.push(...result.errors.map((e) => `${record["id"] ?? "?"}: ${e}`));
      }
    }
  }
  if (!schemaValid) {
    process.stderr.write(`[gate-review] InquiryRecord schema validation errors:\n${validationErrors.join("\n")}\n`);
  }

  const outputPath = path.join(dir, "gate-review.inquiries.json");
  writeJson(outputPath, records);

  // Build summary counts by calibration
  const counts: Record<string, number> = {};
  for (const r of records) {
    const cal = (r["answer"] as AnyObj | undefined)?.["value"]?.["calibration"] ?? "unknown";
    counts[cal] = (counts[cal] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const schemaTag = validator ? (schemaValid ? " schema:valid" : " schema:INVALID") : " schema:unavailable";
  console.log(`gate-review: ${records.length} InquiryRecord(s) [${summary}]${schemaTag} → ${outputPath}`);
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── ADR 0010 Phase 3: project the local trust.bundle to the Surface Trust Panel ──
// Surface owns derivation (buildTrustReport) AND rendering (the dependency-free
// <surface-trust-panel> element). Flow Agents only assembles a standalone HTML
// shell — no trust logic or rendering reimplemented (consume-never-fork).

/** Locate Surface's self-contained, dependency-free panel element (ESM, no require). */
function loadSurfacePanelJs(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    try { return fs.readFileSync(path.join(d, "node_modules/@kontourai/surface/dist/src/trust-panel/surface-trust-panel.js"), "utf8"); } catch { /* walk up */ }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  die("could not locate @kontourai/surface trust-panel element (dist/src/trust-panel/surface-trust-panel.js)");
  return "";
}

async function renderTrustPanel(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const dir = p.positional[0] ? artifactDirFrom(p.positional[0]) : currentDir(root);
  if (!dir) die("render-trust-panel requires a workflow dir or a recorded current session");
  let bundle: AnyObj | null = null;
  try { bundle = JSON.parse(fs.readFileSync(path.join(dir!, "trust.bundle"), "utf8")); } catch { bundle = null; }
  if (!bundle) die(`no trust.bundle at ${path.join(dir!, "trust.bundle")} — run record-evidence first`);
  const surface = (await import("@kontourai/surface")) as unknown as { buildTrustReport?: (b: unknown) => AnyObj; diffFreshness?: (prior: unknown, next: unknown) => Array<Record<string, unknown>> };
  if (typeof surface.buildTrustReport !== "function") die("@kontourai/surface buildTrustReport unavailable — cannot derive the trust report");
  const report = surface.buildTrustReport!(bundle);
  // diffFreshness on resume: if a prior trust.checkpoint.json exists, surface the
  // fresh→stale transitions so the user sees what has gone stale since the last seal.
  const checkpointFile = path.join(dir!, "trust.checkpoint.json");
  if (fs.existsSync(checkpointFile) && typeof surface.diffFreshness === "function") {
    try {
      const envelope: AnyObj = JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
      const priorCheckpoint = envelope.checkpoint;
      if (priorCheckpoint && typeof priorCheckpoint === "object") {
        const transitions = surface.diffFreshness(priorCheckpoint, report);
        const staleTransitions = transitions.filter((t) => t["to"] === "stale");
        if (staleTransitions.length > 0) {
          const claimIds = staleTransitions.map((t) => String(t["claimId"] ?? "")).filter(Boolean);
          process.stderr.write(`[trust-checkpoint] ${staleTransitions.length} claim(s) went stale since the last checkpoint (sealed ${String(envelope.sealed_at ?? "unknown")}):\n${claimIds.map((id) => `  - ${id}`).join("\n")}\n`);
        } else {
          process.stderr.write(`[trust-checkpoint] 0 claims went stale since the last checkpoint (sealed ${String(envelope.sealed_at ?? "unknown")}).\n`);
        }
      }
    } catch {
      /* diffFreshness is advisory — never block the panel render */
    }
  }
  const panelJs = loadSurfacePanelJs();
  const heading = `Flow Agents trust — ${String(path.basename(dir!)).replace(/[<>"&]/g, "")}`;
  const reportJson = JSON.stringify(report).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:1.5rem;background:#f4f1e6">
<script type="module">
${panelJs}
</script>
<surface-trust-panel heading="${heading}"></surface-trust-panel>
<script id="trust-report" type="application/json">${reportJson}</script>
<script type="module">document.querySelector("surface-trust-panel").report = JSON.parse(document.getElementById("trust-report").textContent);</script>
</body></html>
`;
  const out = opt(p, "out") || path.join(dir!, "trust-panel.html");
  fs.writeFileSync(out, html);
  // Also emit the derived report as a first-class artifact — the universal input for
  // Surface's hosted Snapshot Viewer and a bare `<surface-trust-panel src=…>` (the HTML
  // above already embeds it). Suppress with --no-report.
  let reportOut = "";
  if (!p.flags.has("no-report")) {
    reportOut = opt(p, "report-out") || path.join(dir!, "trust-report.json");
    fs.writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(out);
  if (reportOut) console.log(reportOut);
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── flow-agents#137 / ADR 0011: wire Surface's MCP to surface trust reports ──
// Flow Agents produces the bundle; Surface's MCP projects it. `--mode print` is the
// zero-write default (output the snippet). `enable`/`disable` edit a runtime JSON MCP
// config (e.g. Claude Code `.mcp.json`) via a *conventional managed key* — idempotent,
// reversible, and only ever our own entry (never auto-injected; opt-in only).
const TRUST_MCP_SERVER = "flow-agents-surface-trust";
function trustMcpRegistration(): AnyObj {
  // No static `--input` (a single file can't follow many per-task bundles or a moving
  // current); the skill passes the active task's bundle as a per-call `path` arg.
  return { command: "npx", args: ["-y", "@kontourai/surface", "mcp"] };
}
function trustMcp(p: ReturnType<typeof parseArgs>): number {
  const mode = opt(p, "mode", "print");
  if (mode === "print") {
    console.log(JSON.stringify({ mcpServers: { [TRUST_MCP_SERVER]: trustMcpRegistration() } }, null, 2));
    process.stderr.write(`\n# Paste the above into your runtime MCP config (e.g. .mcp.json). Flow Agents does NOT write it for you unless you run: trust-mcp --mode enable\n`);
    process.stderr.write(`# To view a task's trust inline, call surface_summary with path=<.flow-agents/<slug>/trust.bundle>.\n`);
    return 0;
  }
  if (mode !== "enable" && mode !== "disable") die("trust-mcp --mode must be print|enable|disable");
  const configPath = path.resolve(opt(p, "config", ".mcp.json"));
  let config: AnyObj = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { config = {}; }
  if (typeof config !== "object" || config === null || Array.isArray(config)) die(`${configPath} is not a JSON object — refusing to edit`);
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) config.mcpServers = {};
  if (mode === "enable") {
    config.mcpServers[TRUST_MCP_SERVER] = trustMcpRegistration();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`enabled ${TRUST_MCP_SERVER} in ${configPath} (remove with: trust-mcp --mode disable)`);
    return 0;
  }
  // disable: remove only our own conventional entry; leave everything else untouched.
  if (Object.prototype.hasOwnProperty.call(config.mcpServers, TRUST_MCP_SERVER)) {
    delete config.mcpServers[TRUST_MCP_SERVER];
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`disabled ${TRUST_MCP_SERVER} in ${configPath}`);
  } else {
    console.log(`${TRUST_MCP_SERVER} not present in ${configPath} — nothing to remove`);
  }
  return 0;
}
// ─── ADR 0012: agent coordination as liveness claims (policy-centered) ──────────
// A work-claim is a regular Hachure claim governed by a *liveness policy* (ttl +
// heartbeat → held/stale/released), keyed by the work-item subjectId, appended to a
// shared stream all agents read. Status is RECOMPUTED via Surface's deriveTrustStatus
// (no forked logic). Advisory, not a lock. The liveness policy is a general archetype
// (not use-case-specific) and is a candidate to graduate upstream into Surface.
const LIVENESS_POLICY = {
  id: "policy:liveness.hold",
  claimType: "liveness.hold",
  requiredEvidence: [] as string[],
  acceptanceCriteria: ["A heartbeat within ttlSeconds holds the claim; a lapse or release frees it."],
  reviewAuthority: "system",
  validityRule: { kind: "duration", durationDays: 1 },
  stalenessTriggers: [] as string[],
  conflictRules: [] as string[],
  impactLevel: "medium",
};

function livenessStreamFile(root: string): string { return path.join(root, "liveness", "events.jsonl"); }
function appendLivenessEvent(root: string, evt: AnyObj): void {
  const file = livenessStreamFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(evt)}\n`);
}
function readLivenessEvents(root: string): AnyObj[] {
  // Delegate to the shared pure-CJS helper (scripts/hooks/lib/liveness-read.js).
  // Using createRequire so the ESM sidecar can load a CJS module without bundling it.
  try {
    const _req = createRequire(import.meta.url);
    const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
    const helper = _req(helperPath) as { readLivenessEvents: (p: string) => AnyObj[] };
    return helper.readLivenessEvents(livenessStreamFile(root));
  } catch {
    // Fallback: read inline (keeps sidecar self-sufficient if helper is unavailable)
    let raw = "";
    try { raw = fs.readFileSync(livenessStreamFile(root), "utf8"); } catch { return []; }
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) as AnyObj; } catch { return null; } }).filter((x): x is AnyObj => x !== null);
  }
}
function livenessLabel(status: string): string {
  if (status === "verified") return "held";
  if (status === "stale" || status === "revoked") return "free"; // reclaimable: lapsed or released
  if (status === "superseded") return "superseded";
  return status;
}

// ─── ADR 0012 lifecycle-driven liveness (opt-in via FLOW_AGENTS_LIVENESS) ──────
// init-plan claims the work-item; advance-state heartbeats (or releases on terminal),
// so the workflow lifecycle itself maintains the liveness claim — no manual liveness calls.
// Additive + fail-open: a liveness-emit failure never affects the workflow command.
const LIVENESS_TERMINAL = new Set(["delivered", "accepted", "archived"]);
function resolveLivenessActor(): string { return (process.env.FLOW_AGENTS_ACTOR || "").trim() || "local"; }
function livenessEnabled(): boolean { const v = String(process.env.FLOW_AGENTS_LIVENESS || "").trim().toLowerCase(); return v === "on" || v === "1" || v === "true"; }
function livenessLifecycle(taskDir: string, slug: string, kind: "claim" | "heartbeat" | "release", timestamp: string): void {
  if (!livenessEnabled()) return;
  try {
    const root = path.dirname(taskDir); // .flow-agents/<slug> → .flow-agents (the shared liveness stream lives here)
    const evt: AnyObj = { type: kind, subjectId: slug, actor: resolveLivenessActor(), at: timestamp, source: "lifecycle" };
    if (kind === "claim") evt.ttlSeconds = 1800;
    appendLivenessEvent(root, evt);
  } catch { /* best-effort; liveness is advisory and must never break the workflow */ }
}

async function liveness(p: ReturnType<typeof parseArgs>): Promise<number> {
  const root = path.resolve(opt(p, "artifact-root", ".flow-agents"));
  const action = p.positional[0] || "";
  const subjectId = p.positional[1] || "";
  const actor = opt(p, "actor", process.env.FLOW_AGENTS_ACTOR || "unknown");
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (action === "claim" || action === "heartbeat" || action === "release") {
    if (!subjectId) die(`liveness ${action} requires a subjectId`);
    const evt: AnyObj = { type: action, subjectId, actor, at: opt(p, "at") || nowIso };
    if (action === "claim") evt.ttlSeconds = Number.parseInt(opt(p, "ttl", "1800"), 10) || 1800;
    appendLivenessEvent(root, evt);
    console.log(`liveness ${action}: ${subjectId} by ${actor}`);
    return 0;
  }

  if (action === "status") {
    const surface = (await import("@kontourai/surface")) as unknown as { deriveTrustStatus?: (a: AnyObj) => string };
    if (typeof surface.deriveTrustStatus !== "function") die("@kontourai/surface deriveTrustStatus unavailable — requires surface >= 1.2");
    const subjectFilter = opt(p, "subject");
    const now = opt(p, "now") ? new Date(opt(p, "now")) : new Date();
    // Group events by subjectId::actor — one liveness claim per holder of a subject.
    const groups = new Map<string, { subjectId: string; actor: string; ttlSeconds: number; created: string; updated: string; events: AnyObj[] }>();
    for (const e of readLivenessEvents(root)) {
      if (!e.subjectId || !e.actor) continue;
      const key = `${e.subjectId}::${e.actor}`;
      let g = groups.get(key);
      if (!g) { g = { subjectId: String(e.subjectId), actor: String(e.actor), ttlSeconds: 1800, created: String(e.at), updated: String(e.at), events: [] }; groups.set(key, g); }
      g.updated = String(e.at);
      if (e.type === "claim") { g.ttlSeconds = Number(e.ttlSeconds) || g.ttlSeconds; g.events.push({ id: `c:${key}:${e.at}`, claimId: key, status: "verified", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
      else if (e.type === "heartbeat") { g.events.push({ id: `h:${key}:${e.at}`, claimId: key, status: "verified", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
      else if (e.type === "release") { g.events.push({ id: `r:${key}:${e.at}`, claimId: key, status: "revoked", type: "invalidation", actor: g.actor, method: "observation", evidenceIds: [], createdAt: e.at, verifiedAt: e.at }); }
    }
    const rows: AnyObj[] = [];
    for (const g of groups.values()) {
      if (subjectFilter && g.subjectId !== subjectFilter) continue;
      const claim: AnyObj = { id: `${g.subjectId}::${g.actor}`, subjectType: "work-item", subjectId: g.subjectId, surface: "flow.liveness", claimType: "liveness.hold", fieldOrBehavior: "held-by", value: g.actor, createdAt: g.created, updatedAt: g.updated, ttlSeconds: g.ttlSeconds, verificationPolicyId: LIVENESS_POLICY.id };
      const status = surface.deriveTrustStatus!({ claim, evidence: [], policy: LIVENESS_POLICY, events: g.events, now });
      rows.push({ subjectId: g.subjectId, actor: g.actor, status, label: livenessLabel(status) });
    }
    if (p.flags.has("json")) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    for (const r of rows) console.log(`${r.subjectId}\t${r.actor}\t${r.label}`);
    return 0;
  }

  die("liveness action must be one of: claim | heartbeat | release | status");
  return 1;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Claim Lookup — pure helper (promotable to Surface #171) ─────────────────
// buildClaimExplanation + its types are extracted to ./sidecar-claim-explain.ts
// (ops#22): a PURE projection (report + bundle + id in, structured explanation out)
// with no fs/CLI/shared state, unit-tested in isolation. Re-exported here so the
// library facade (src/index.ts) and the IO `claimLookup` handler below are unchanged.
export { buildClaimExplanation } from "./sidecar-claim-explain.js";
export type { ClaimEvidenceItem, ClaimExplanation } from "./sidecar-claim-explain.js";
import { buildClaimExplanation } from "./sidecar-claim-explain.js";

/**
 * claim <id> <dir>
 *
 * Look up a specific claim in the session's trust.bundle and print:
 *   - Derived status and raw value
 *   - Failing evidence items (with execution block: runner, exitCode, isError)
 *   - Governing VerificationPolicy (how-to-verify)
 *   - Derivation drilldown / transparency gaps (why it is in that state)
 *
 * --json  Emit the structured ClaimExplanation object instead of text.
 *
 * Usage: workflow-sidecar claim <claimId> <artifactDir>
 */
async function claimLookup(p: ReturnType<typeof parseArgs>): Promise<number> {
  const claimId = p.positional[0] || die("claim id is required (first positional argument)");
  const rawDir = p.positional[1] || die("artifact directory is required (second positional argument)");
  const dir = path.resolve(rawDir);

  const bundlePath = path.join(dir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) {
    process.stderr.write(`[claim] no trust.bundle at ${bundlePath} — run record-evidence first
`);
    return 1;
  }

  const bundle: BundleFile = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const bundleClaims = Array.isArray(bundle.claims) ? bundle.claims : [];

  const bundleClaim = bundleClaims.find((c) => c.id === claimId);
  if (!bundleClaim) {
    const available = bundleClaims.map((c) => c.id).join("\n  ");
    process.stderr.write(`[claim] unknown claim id: ${claimId}
Available claim ids:
  ${available || "(none — bundle has no claims)"}
`);
    return 1;
  }

  // Load Surface via tryLoadSurface() (ESM, cached, fail-open pattern)
  const surface = await tryLoadSurface();
  if (!surface || typeof surface.buildTrustReport !== "function" || typeof surface.buildDerivationDrilldown !== "function") {
    process.stderr.write(`[claim] @kontourai/surface unavailable or missing buildTrustReport/buildDerivationDrilldown
`);
    return 0; // fail-open, consistent with gate-review pattern
  }

  // Build TrustReport (required — buildDerivationDrilldown needs TrustReport, not TrustBundle)
  const report = surface.buildTrustReport(bundle as unknown as Record<string, unknown>);

  // Build the structured explanation (pure, promotable to #171)
  const explanation = buildClaimExplanation(report, bundle as unknown as Record<string, unknown>, claimId);

  // Enrich the why.directInputs/leafClaims/diagnostics from the drilldown
  try {
    const drilldown = surface.buildDerivationDrilldown(report, claimId) as AnyObj;
    if (drilldown) {
      explanation.why.directInputs = Array.isArray(drilldown.directInputs) ? drilldown.directInputs : [];
      explanation.why.leafClaims = Array.isArray(drilldown.leafClaims) ? drilldown.leafClaims : [];
      explanation.why.diagnostics = Array.isArray(drilldown.diagnostics) ? drilldown.diagnostics : [];
    }
  } catch {
    // buildDerivationDrilldown threw (e.g. claim not in report) — proceed without drilldown
  }

  if (p.flags.has("json")) {
    console.log(JSON.stringify(explanation, null, 2));
    return 0;
  }

  // ── Human-readable output ───────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`Claim:  ${claimId}`);
  lines.push(`Status: ${explanation.status}   Value: ${explanation.value}`);
  lines.push(`Type:   ${explanation.claimType}`);
  lines.push("");

  // Evidence section — failing items are the concrete "why disputed"
  const failingEvidence = explanation.evidence.filter((ev) => !ev.passing);
  const allEvidence = explanation.evidence;
  if (allEvidence.length > 0) {
    lines.push("Evidence:");
    for (const ev of allEvidence) {
      const passMark = ev.passing ? "pass" : "FAIL";
      const execStr = ev.execution
        ? ` [runner: ${ev.execution.runner}, exitCode: ${ev.execution.exitCode ?? "?"}, isError: ${ev.execution.isError}]`
        : "";
      lines.push(`  [${passMark}] ${ev.evidenceType}: ${ev.label || ev.summary}${execStr}`);
    }
    if (failingEvidence.length > 0) {
      lines.push("");
      lines.push(`Failing evidence (disputed because):`);
      for (const ev of failingEvidence) {
        const execStr = ev.execution
          ? ` ${ev.execution.runner} exited ${ev.execution.exitCode ?? "?"} (isError: ${ev.execution.isError})`
          : "";
        lines.push(`  ${ev.evidenceType}: ${ev.label || ev.summary}${execStr}`);
      }
    }
  } else {
    lines.push("Evidence: (none recorded for this claim)");
  }
  lines.push("");

  // Policy section — how-to-verify
  if (explanation.policy) {
    const pol = explanation.policy;
    lines.push(`Governing Policy (${pol.id}):`);
    lines.push(`  requiredEvidence:   [${pol.requiredEvidence.join(", ")}]`);
    if (pol.requiredMethods && pol.requiredMethods.length > 0) {
      lines.push(`  requiredMethods:    [${pol.requiredMethods.join(", ")}]`);
    }
    lines.push(`  acceptanceCriteria: [${pol.acceptanceCriteria.join(" | ")}]`);
    lines.push(`  reviewAuthority:    ${pol.reviewAuthority}`);
  } else {
    lines.push("Governing Policy: (none — claim has no verificationPolicyId or policy not found in bundle)");
  }
  lines.push("");

  // Why section — derivation drilldown + transparency gaps
  lines.push("Derivation Drilldown:");
  if (explanation.why.directInputs.length > 0) {
    lines.push(`  Direct inputs: ${explanation.why.directInputs.length} claim(s)`);
    for (const inp of explanation.why.directInputs) {
      const inpStatus = typeof inp.claim === "object" && inp.claim ? String((inp.claim as AnyObj).status ?? "?") : "?";
      lines.push(`    - ${inp.inputClaimId ?? "?"} (status: ${inpStatus})`);
    }
  } else {
    lines.push("  Direct inputs: (none — leaf claim)");
  }
  if (explanation.why.leafClaims.length > 0) {
    lines.push(`  Leaf claims: ${explanation.why.leafClaims.length} claim(s)`);
  }
  if (explanation.why.diagnostics.length > 0) {
    lines.push(`  Diagnostics: ${explanation.why.diagnostics.length}`);
    for (const d of explanation.why.diagnostics) {
      lines.push(`    - ${d.type ?? "?"}: ${d.message ?? ""}`);
    }
  }
  if (explanation.why.transparencyGaps.length > 0) {
    lines.push(`  Transparency gaps: ${explanation.why.transparencyGaps.length}`);
    for (const g of explanation.why.transparencyGaps) {
      lines.push(`    - [${g.severity ?? "?"}] ${g.type ?? "?"}: ${g.message ?? ""}`);
    }
  } else {
    lines.push("  Transparency gaps: (none)");
  }
  if (explanation.why.changeRecords.length > 0) {
    lines.push(`  Change records: ${explanation.why.changeRecords.length}`);
    for (const cr of explanation.why.changeRecords) {
      lines.push(`    - ${cr.action ?? "?"} at ${cr.at ?? cr.createdAt ?? "?"}`);
    }
  }

  console.log(lines.join("\n"));
  return 0;
}
// ─────────────────────────────────────────────────────────────────────────────


async function main(): Promise<number> {
  const p = parseArgs(process.argv.slice(2));
  if (!p.command) die("workflow-sidecar command is required");
  const lockRoot = ["ensure-session", "current", "dogfood-pass", "liveness"].includes(p.command) ? path.resolve(opt(p, "artifact-root", ".flow-agents")) : p.command === "record-agent-event" ? explicitArtifactRoot(p) : p.command === "claim" ? (p.positional[1] ? path.resolve(p.positional[1]) : "") : p.positional[0] ? artifactDirFrom(p.positional[0]) : "";
  return withLock(lockRoot, ["ensure-session", "record-agent-event", "dogfood-pass"].includes(p.command), p.command, () => {
    switch (p.command) {
      case "ensure-session": return ensureSession(p);
      case "current": return current(p);
      case "record-agent-event": return recordAgentEvent(p);
      case "init-plan": return initPlan(p);
      case "record-evidence": return recordEvidence(p);
      case "record-gate-claim": return recordGateClaim(p);
      case "advance-state": return advanceState(p);
      case "record-critique": return recordCritique(p);
      case "import-critique": return importCritique(p);
      case "record-release": return recordRelease(p);
      case "record-learning": return recordLearning(p);
      case "dogfood-pass": return dogfoodPass(p);
      case "gate-review": return gateReview(p);
      case "render-trust-panel": return renderTrustPanel(p);
      case "trust-mcp": return trustMcp(p);
      case "liveness": return liveness(p);
      case "claim": return claimLookup(p);
      case "seal-checkpoint": return sealCheckpoint(p);
      case "publish-delivery": return publishDeliveryCmd(p);
      default: die(`unknown command: ${p.command}`);
    }
  });
}

// Run the CLI only when executed directly, not when imported as a library.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) {
  main().then((code) => process.exit(code)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
