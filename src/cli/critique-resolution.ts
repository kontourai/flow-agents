import { createHash } from "node:crypto";
import { assertTrustedGitAncestor } from "../lib/trusted-git.js";

type AnyRecord = Record<string, any>;

const HASH_RE = /^[a-f0-9]{64}$/i;
export const CRITIQUE_CHAIN_GENESIS = "0".repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as AnyRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function critiqueResolutionResultCoreDigest(prior: AnyRecord, resolving: AnyRecord, edge: AnyRecord): string {
  return createHash("sha256").update(canonical({
    prior_record_id: prior.critique_record_id,
    prior_record_hash: prior.critique_record_hash,
    resolving_record_id: resolving.critique_record_id,
    resolving_record_hash: resolving.critique_record_hash,
    edge,
  })).digest("hex");
}

export function critiqueRecordHash(record: AnyRecord): string {
  return createHash("sha256").update(canonical({
    sequence: record.critique_sequence,
    predecessor_hash: record.critique_predecessor_hash,
    reviewer: record.reviewer,
    reviewed_at: record.reviewed_at,
    verdict: record.verdict,
    summary: record.summary,
    lanes: record.lanes ?? [],
    review_target: record.review_target ?? { artifacts: [] },
    findings: record.findings ?? [],
    workflow_subject_ref: record.workflow_subject_ref,
  })).digest("hex");
}

export function normalizeCritiqueChainRecords(records: AnyRecord[]): { records: AnyRecord[]; migrated: boolean } {
  const complete = records.map((record) => Number.isSafeInteger(record.critique_sequence)
    && HASH_RE.test(String(record.critique_predecessor_hash)) && HASH_RE.test(String(record.critique_record_hash))
    && typeof record.critique_record_id === "string");
  if (complete.every(Boolean)) return { records, migrated: false };
  if (complete.some(Boolean)) throw new Error("critique history has a partially migrated chain");
  let predecessor = CRITIQUE_CHAIN_GENESIS;
  const ordered = records.map((record, index) => ({ record, index })).sort((a, b) => {
    const time = String(a.record.reviewed_at ?? "").localeCompare(String(b.record.reviewed_at ?? ""));
    return time || a.index - b.index;
  });
  const byOriginalIndex = new Map<number, AnyRecord>();
  ordered.forEach(({ record, index: originalIndex }, index) => {
    const base = { ...record, critique_sequence: index + 1, critique_predecessor_hash: predecessor };
    const hash = critiqueRecordHash(base);
    predecessor = hash;
    byOriginalIndex.set(originalIndex, { ...base, critique_record_hash: hash, critique_record_id: `critique:${hash}` });
  });
  const migrated = records.map((_, index) => byOriginalIndex.get(index)!);
  return { records: migrated, migrated: true };
}

function critiqueFromClaim(claim: AnyRecord): AnyRecord {
  const metadata = claim.metadata && typeof claim.metadata === "object" ? claim.metadata : {};
  return {
    critique_record_id: metadata.critique_record_id,
    critique_sequence: metadata.critique_sequence,
    critique_predecessor_hash: metadata.critique_predecessor_hash,
    critique_record_hash: metadata.critique_record_hash,
    reviewer: metadata.reviewer,
    reviewed_at: metadata.reviewed_at,
    verdict: claim.value,
    summary: claim.fieldOrBehavior,
    lanes: metadata.lanes,
    review_target: metadata.review_target,
    findings: metadata.findings,
    workflow_subject_ref: metadata.workflow_subject_ref,
    superseded_by: metadata.superseded_by,
    critique_resolution: metadata.critique_resolution,
    claim_status: claim.status,
  };
}

type GraphState = {
  records: AnyRecord[]; byId: Map<string, AnyRecord>; byHash: Map<string, AnyRecord>;
  errors: string[]; referencedEventIds: Set<string>; expectedSubject?: string;
  resolutionEvents: AnyRecord[]; projectRoot?: string; externalCompletionVerified: boolean;
};

function validateRecords(records: AnyRecord[], state: GraphState): void {
  const bySequence = new Map<number, AnyRecord>();
  for (const record of records) {
    if (typeof record.critique_record_id !== "string" || !record.critique_record_id || state.byId.has(record.critique_record_id)) state.errors.push("critique record ids must be present and unique"); else state.byId.set(record.critique_record_id, record);
    if (!Number.isSafeInteger(record.critique_sequence) || record.critique_sequence < 1 || bySequence.has(record.critique_sequence)) state.errors.push("critique sequences must be positive and unique"); else bySequence.set(record.critique_sequence, record);
    if (!HASH_RE.test(String(record.critique_predecessor_hash)) || !HASH_RE.test(String(record.critique_record_hash))) state.errors.push("critique chain hashes must be SHA-256 values");
    else if (critiqueRecordHash(record) !== record.critique_record_hash) state.errors.push(`critique record ${String(record.critique_record_id)} hash is invalid`);
    else state.byHash.set(record.critique_record_hash, record);
    if (state.expectedSubject && record.workflow_subject_ref !== state.expectedSubject) state.errors.push(`critique record ${String(record.critique_record_id)} has a mismatched workflow subject`);
  }
  [...bySequence.entries()].sort(([a], [b]) => a - b).forEach(([, record], index, ordered) => {
    const predecessor = index === 0 ? CRITIQUE_CHAIN_GENESIS : ordered[index - 1]![1].critique_record_hash;
    if (record.critique_sequence !== index + 1 || record.critique_predecessor_hash !== predecessor) {
      state.errors.push(`critique chain mismatch at sequence ${index + 1}: record ${String(record.critique_record_id)} declares sequence ${String(record.critique_sequence)} and predecessor ${String(record.critique_predecessor_hash)}, expected predecessor ${predecessor}`);
    }
  });
}

function validateCoverage(prior: AnyRecord, resolving: AnyRecord, resolution: AnyRecord, errors: string[]): void {
  const lanes = (Array.isArray(prior.lanes) ? prior.lanes : []).filter((lane: AnyRecord) => lane.status !== "pass").map((lane: AnyRecord) => lane.id).sort();
  const coveredLanes = Array.isArray(resolution.resolved_lane_ids) ? [...resolution.resolved_lane_ids].sort() : [];
  const resolverLanes = new Map((Array.isArray(resolving.lanes) ? resolving.lanes : []).map((lane: AnyRecord) => [lane.id, lane.status]));
  if (canonical(lanes) !== canonical(coveredLanes) || lanes.some((id) => resolverLanes.get(id) !== "pass")) errors.push("critique resolution does not cover every failed lane");
  const findings = (Array.isArray(prior.findings) ? prior.findings : []).filter((finding: AnyRecord) => finding.status === "open").map((finding: AnyRecord) => finding.id).sort();
  const coveredFindings = Array.isArray(resolution.resolved_finding_ids) ? [...resolution.resolved_finding_ids].sort() : [];
  const resolverFindings = new Map((Array.isArray(resolving.findings) ? resolving.findings : []).map((finding: AnyRecord) => [finding.id, finding.status]));
  if (canonical(findings) !== canonical(coveredFindings) || findings.some((id) => !["fixed", "accepted", "deferred", "false_positive"].includes(resolverFindings.get(id)))) errors.push("critique resolution does not cover every open finding");
}

function validateResolution(prior: AnyRecord, state: GraphState): void {
  if (!prior.superseded_by && !prior.critique_resolution) return;
  const resolution = prior.critique_resolution;
  if (!prior.superseded_by || !resolution || typeof resolution !== "object") { state.errors.push(`critique record ${String(prior.critique_record_id)} has an incomplete resolution edge`); return; }
  const resolving = state.byId.get(resolution.resolving_record_id);
  if (!resolving || prior.superseded_by !== resolution.resolving_record_id || resolution.prior_record_id !== prior.critique_record_id) { state.errors.push(`critique record ${String(prior.critique_record_id)} has a missing or mismatched resolver`); return; }
  if (resolving === prior || resolving.critique_sequence <= prior.critique_sequence) state.errors.push("critique resolution graph is circular or not forward ordered");
  if (resolving.verdict !== "pass" || resolving.claim_status !== "verified" || resolving.superseded_by) state.errors.push("critique resolver must be a current verified PASS");
  if (resolution.resolver !== resolving.reviewer || (resolution.kind === "cross-reviewer" && resolving.reviewer === prior.reviewer) || (resolution.kind === "same-reviewer-recheck" && resolving.reviewer !== prior.reviewer) || !["cross-reviewer", "same-reviewer-recheck"].includes(resolution.kind)) state.errors.push("critique resolution actor binding is invalid");
  if (resolving.workflow_subject_ref !== prior.workflow_subject_ref) state.errors.push("critique resolution crosses workflow subjects");
  validateResolutionSnapshots(prior, resolving, state); validateResolutionEvent(prior, resolving, resolution, state); validateDescendant(prior, resolving, state); validateCoverage(prior, resolving, resolution, state.errors);
}

function validateResolutionSnapshots(prior: AnyRecord, resolving: AnyRecord, state: GraphState): void {
  const first = prior.review_target?.workspace_snapshot; const second = resolving.review_target?.workspace_snapshot;
  if (first?.kind !== "git-worktree" && second?.kind !== "git-worktree") return;
  if (!state.projectRoot || first?.kind !== "git-worktree" || second?.kind !== "git-worktree") { state.errors.push("critique resolution Git snapshots require one trusted project context"); return; }
  try { assertTrustedGitAncestor(state.projectRoot, String(first.head_sha), String(second.head_sha)); } catch { state.errors.push("critique resolver Git ancestry is invalid"); }
}

function validateResolutionEvent(prior: AnyRecord, resolving: AnyRecord, resolution: AnyRecord, state: GraphState): void {
  const originals = state.resolutionEvents.filter((event) => event.event_id === resolution.resolution_event_id);
  const repairs = state.resolutionEvents.filter((event) => event.operation === "repair-critique-resolution-history" && event.missing_resolution_event_id === resolution.resolution_event_id && event.missing_authorization_sha256 === resolution.authorization_sha256);
  if (resolution.kind === "cross-reviewer" && originals.length + repairs.length !== 1) { state.errors.push("cross-reviewer critique resolution requires exactly one original or repair authority proof"); return; }
  if (originals.length + repairs.length !== 1) return;
  const event = originals[0] ?? repairs[0]!;
  state.referencedEventIds.add(String(event.event_id));
  const bound = event.subject === prior.workflow_subject_ref && event.prior_record_id === prior.critique_record_id && event.prior_record_hash === prior.critique_record_hash && event.resolving_record_id === resolving.critique_record_id && event.resolving_record_hash === resolving.critique_record_hash && event.resolver === resolving.reviewer && canonical(event.edge) === canonical(resolution);
  if (!bound) { state.errors.push("critique resolution authorization event does not bind the exact edge"); return; }
  if (event.operation === "resolve-critique" && event.authorization_sha256 !== resolution.authorization_sha256) state.errors.push("critique resolution original authorization event does not bind the preserved edge");
  if (event.operation === "repair-critique-resolution-history" && (event.missing_resolution_event_id !== resolution.resolution_event_id || event.missing_authorization_sha256 !== resolution.authorization_sha256 || event.signed_authorization?.preserved_resolution_sha256 !== createHash("sha256").update(JSON.stringify(resolution)).digest("hex"))) state.errors.push("critique resolution repair event does not bind the missing original authority edge");
}

function validateDescendant(prior: AnyRecord, resolving: AnyRecord, state: GraphState): void {
  let cursor: AnyRecord | undefined = resolving; const visited = new Set<string>();
  while (cursor && !visited.has(cursor.critique_record_hash)) { visited.add(cursor.critique_record_hash); if (cursor.critique_predecessor_hash === prior.critique_record_hash) return; cursor = state.byHash.get(cursor.critique_predecessor_hash); }
  state.errors.push("critique resolver is not a hash-chain descendant of the prior critique");
}

function validateEvents(state: GraphState): void {
  const seen = new Set<string>();
  state.resolutionEvents.forEach((event, index) => {
    const { event_hash: hash, ...unsigned } = event; const predecessor = index === 0 ? CRITIQUE_CHAIN_GENESIS : state.resolutionEvents[index - 1]?.event_hash;
    if (event.sequence !== index + 1 || event.predecessor_hash !== predecessor || createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== hash) state.errors.push("critique resolution events must form one valid append-only hash chain");
    const expectedId = event.operation === "resolve-critique"
      ? `critique-resolution:${String(event.authorization_sha256)}`
      : event.operation === "repair-critique-resolution-history"
        ? `critique-resolution-history-repair:${String(event.authorization_sha256)}`
        : "";
    if (typeof event.event_id !== "string" || !event.event_id || seen.has(event.event_id) || event.event_id !== expectedId) state.errors.push("critique resolution events must have unique authorization-bound ids"); else seen.add(event.event_id);
    if (!state.referencedEventIds.has(String(event.event_id))) state.errors.push("critique resolution event is not linked by exactly one cross-reviewer edge");
    if (!["resolve-critique", "repair-critique-resolution-history"].includes(event.operation) || !event.signed_authorization || typeof event.signed_authorization !== "object") state.errors.push("critique resolution event requires a verifiable signed authorization");
    else if (state.projectRoot && (event.signed_authorization.project_root !== state.projectRoot || event.signed_authorization.run_id !== event.run_id)) state.errors.push("critique resolution signed authorization does not bind the trusted project and run");
    else if (createHash("sha256").update(JSON.stringify(event.signed_authorization)).digest("hex") !== event.authorization_sha256) state.errors.push("critique resolution signed authorization does not match its event");
    else if (state.projectRoot && !state.externalCompletionVerified) state.errors.push("critique resolution external authority attestation is NOT_VERIFIED by package-side validation");
    if (event.operation === "repair-critique-resolution-history") {
      if (event.signed_authorization.operation !== "repair-critique-resolution-history" || event.signed_authorization.missing_resolution_event_id !== event.missing_resolution_event_id || event.signed_authorization.missing_authorization_sha256 !== event.missing_authorization_sha256 || event.signed_authorization.reason_code !== "coordinator-external-ledger-overwrite-v1" || state.resolutionEvents.some((other) => other !== event && other.operation === "resolve-critique" && (other.event_id === event.missing_resolution_event_id || other.authorization_sha256 === event.missing_authorization_sha256))) state.errors.push("critique resolution repair event is incomplete or reconstructs an original authority event");
    }
    if (state.expectedSubject && event.subject !== state.expectedSubject) state.errors.push("critique resolution event has a mismatched workflow subject");
    const prior = state.byId.get(String(event.prior_record_id)); const resolving = state.byId.get(String(event.resolving_record_id));
    if (!prior || !resolving || event.resulting_core_sha256 !== critiqueResolutionResultCoreDigest(prior, resolving, event.edge)) state.errors.push("critique resolution event resulting bundle core digest is invalid");
  });
}

export function validateCritiqueResolutionGraph(claims: AnyRecord[], expectedSubject?: string, resolutionEvents: AnyRecord[] = [], projectRoot?: string, externalCompletionVerified = false): { valid: boolean; errors: string[]; live: AnyRecord[] } {
  const records = claims.filter((claim) => claim?.metadata?.origin === "critique").map(critiqueFromClaim);
  if (!records.length) return { valid: false, errors: ["critique graph has no records"], live: [] };
  const state: GraphState = { records, byId: new Map(), byHash: new Map(), errors: [], referencedEventIds: new Set(), expectedSubject, resolutionEvents, projectRoot, externalCompletionVerified };
  validateRecords(records, state); records.forEach((record) => validateResolution(record, state));
  const live = records.filter((record) => !record.superseded_by);
  validateEvents(state);
  if (!live.some((record) => record.verdict === "pass" && record.claim_status === "verified")) state.errors.push("critique graph requires a current verified PASS");
  if (live.some((record) => record.verdict !== "pass" || record.claim_status !== "verified")) state.errors.push("critique graph has unresolved live critique records");
  return { valid: state.errors.length === 0, errors: [...new Set(state.errors)], live };
}
