import { createHash } from "node:crypto";
import { authorizationDigest, validateCritiqueResolutionAuthorization } from "../builder-lifecycle-authority.js";

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

export function validateCritiqueResolutionGraph(claims: AnyRecord[], expectedSubject?: string, resolutionEvents: AnyRecord[] = [], projectRoot?: string): { valid: boolean; errors: string[]; live: AnyRecord[] } {
  const records = claims.filter((claim) => claim?.metadata?.origin === "critique").map(critiqueFromClaim);
  const errors: string[] = [];
  if (records.length === 0) return { valid: false, errors: ["critique graph has no records"], live: [] };
  const byId = new Map<string, AnyRecord>();
  const byHash = new Map<string, AnyRecord>();
  const bySequence = new Map<number, AnyRecord>();
  const referencedEventIds = new Set<string>();
  for (const record of records) {
    if (typeof record.critique_record_id !== "string" || !record.critique_record_id || byId.has(record.critique_record_id)) errors.push("critique record ids must be present and unique");
    else byId.set(record.critique_record_id, record);
    if (!Number.isSafeInteger(record.critique_sequence) || record.critique_sequence < 1 || bySequence.has(record.critique_sequence)) errors.push("critique sequences must be positive and unique");
    else bySequence.set(record.critique_sequence, record);
    if (!HASH_RE.test(String(record.critique_predecessor_hash)) || !HASH_RE.test(String(record.critique_record_hash))) errors.push("critique chain hashes must be SHA-256 values");
    else if (critiqueRecordHash(record) !== record.critique_record_hash) errors.push(`critique record ${String(record.critique_record_id)} hash is invalid`);
    else byHash.set(record.critique_record_hash, record);
    if (expectedSubject && record.workflow_subject_ref !== expectedSubject) errors.push(`critique record ${String(record.critique_record_id)} has a mismatched workflow subject`);
  }
  const ordered = [...bySequence.entries()].sort(([a], [b]) => a - b).map(([, record]) => record);
  ordered.forEach((record, index) => {
    const expectedPredecessor = index === 0 ? CRITIQUE_CHAIN_GENESIS : ordered[index - 1]!.critique_record_hash;
    if (record.critique_sequence !== index + 1 || record.critique_predecessor_hash !== expectedPredecessor) errors.push("critique sequence must form one contiguous predecessor hash chain");
  });
  for (const prior of records) {
    if (!prior.superseded_by && !prior.critique_resolution) continue;
    const resolution = prior.critique_resolution;
    if (!prior.superseded_by || !resolution || typeof resolution !== "object") {
      errors.push(`critique record ${String(prior.critique_record_id)} has an incomplete resolution edge`);
      continue;
    }
    const resolving = byId.get(resolution.resolving_record_id);
    if (!resolving || prior.superseded_by !== resolution.resolving_record_id || resolution.prior_record_id !== prior.critique_record_id) {
      errors.push(`critique record ${String(prior.critique_record_id)} has a missing or mismatched resolver`);
      continue;
    }
    if (resolving === prior || resolving.critique_sequence <= prior.critique_sequence) errors.push("critique resolution graph is circular or not forward ordered");
    if (resolving.verdict !== "pass" || resolving.claim_status !== "verified" || resolving.superseded_by) errors.push("critique resolver must be a current verified PASS");
    if (resolution.resolver !== resolving.reviewer
      || (resolution.kind === "cross-reviewer" && resolving.reviewer === prior.reviewer)
      || (resolution.kind === "same-reviewer-recheck" && resolving.reviewer !== prior.reviewer)
      || !["cross-reviewer", "same-reviewer-recheck"].includes(resolution.kind)) errors.push("critique resolution actor binding is invalid");
    if (resolving.workflow_subject_ref !== prior.workflow_subject_ref) errors.push("critique resolution crosses workflow subjects");
    const linkedEvents = resolutionEvents.filter((event) => event.event_id === resolution.resolution_event_id);
    if (resolution.kind === "cross-reviewer" && linkedEvents.length !== 1) errors.push("cross-reviewer critique resolution must link one append-only authorization event");
    else if (linkedEvents.length === 1) {
      const event = linkedEvents[0]!;
      referencedEventIds.add(String(event.event_id));
      if (event.subject !== prior.workflow_subject_ref || event.prior_record_id !== prior.critique_record_id
        || event.prior_record_hash !== prior.critique_record_hash || event.resolving_record_id !== resolving.critique_record_id
        || event.resolving_record_hash !== resolving.critique_record_hash || event.resolver !== resolving.reviewer
        || event.authorization_sha256 !== resolution.authorization_sha256
        || canonical(event.edge) !== canonical(resolution)) errors.push("critique resolution authorization event does not bind the exact edge");
    }
    let cursor: AnyRecord | undefined = resolving;
    let reachesPrior = false;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.critique_record_hash)) {
      visited.add(cursor.critique_record_hash);
      if (cursor.critique_predecessor_hash === prior.critique_record_hash) { reachesPrior = true; break; }
      cursor = byHash.get(cursor.critique_predecessor_hash);
    }
    if (!reachesPrior) errors.push("critique resolver is not a hash-chain descendant of the prior critique");
    const requiredLanes = (Array.isArray(prior.lanes) ? prior.lanes : []).filter((lane: AnyRecord) => lane.status !== "pass").map((lane: AnyRecord) => lane.id).sort();
    const coveredLanes = Array.isArray(resolution.resolved_lane_ids) ? [...resolution.resolved_lane_ids].sort() : [];
    const resolverLanes = new Map((Array.isArray(resolving.lanes) ? resolving.lanes : []).map((lane: AnyRecord) => [lane.id, lane.status]));
    if (canonical(requiredLanes) !== canonical(coveredLanes) || requiredLanes.some((id) => resolverLanes.get(id) !== "pass")) errors.push("critique resolution does not cover every failed lane");
    const requiredFindings = (Array.isArray(prior.findings) ? prior.findings : []).filter((finding: AnyRecord) => finding.status === "open").map((finding: AnyRecord) => finding.id).sort();
    const coveredFindings = Array.isArray(resolution.resolved_finding_ids) ? [...resolution.resolved_finding_ids].sort() : [];
    const resolverFindings = new Map((Array.isArray(resolving.findings) ? resolving.findings : []).map((finding: AnyRecord) => [finding.id, finding.status]));
    if (canonical(requiredFindings) !== canonical(coveredFindings) || requiredFindings.some((id) => !["fixed", "accepted", "deferred", "false_positive"].includes(resolverFindings.get(id)))) errors.push("critique resolution does not cover every open finding");
  }
  const live = records.filter((record) => !record.superseded_by);
  const seenEventIds = new Set<string>();
  resolutionEvents.forEach((event, index) => {
    const { event_hash: eventHash, ...unsigned } = event;
    const expectedPredecessor = index === 0 ? CRITIQUE_CHAIN_GENESIS : resolutionEvents[index - 1]?.event_hash;
    if (event.sequence !== index + 1 || event.predecessor_hash !== expectedPredecessor
      || createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== eventHash) errors.push("critique resolution events must form one valid append-only hash chain");
    if (typeof event.event_id !== "string" || !event.event_id || seenEventIds.has(event.event_id)
      || event.event_id !== `critique-resolution:${String(event.authorization_sha256)}`) errors.push("critique resolution events must have unique authorization-bound ids");
    else seenEventIds.add(event.event_id);
    if (!referencedEventIds.has(String(event.event_id))) errors.push("critique resolution event is not linked by exactly one cross-reviewer edge");
    if (event.operation !== "resolve-critique" || !projectRoot || !event.signed_authorization || typeof event.signed_authorization !== "object") {
      errors.push("critique resolution event requires a verifiable signed authorization");
    } else try {
      const authorization = validateCritiqueResolutionAuthorization(event.signed_authorization, {
        projectRoot, runId: String(event.run_id), subject: String(event.subject),
        priorBundleSha256: String(event.preimage_bundle_sha256), priorRecordId: String(event.prior_record_id), priorRecordHash: String(event.prior_record_hash),
        resolvingRecordId: String(event.resolving_record_id), resolvingRecordHash: String(event.resolving_record_hash), allowExpired: true,
      });
      if (authorizationDigest(authorization) !== event.authorization_sha256 || authorization.expected_resolver !== event.resolver) errors.push("critique resolution signed authorization does not match its event");
    } catch { errors.push("critique resolution signed authorization is invalid"); }
    if (expectedSubject && event.subject !== expectedSubject) errors.push("critique resolution event has a mismatched workflow subject");
  });
  if (!live.some((record) => record.verdict === "pass" && record.claim_status === "verified")) errors.push("critique graph requires a current verified PASS");
  if (live.some((record) => record.verdict !== "pass" || record.claim_status !== "verified")) errors.push("critique graph has unresolved live critique records");
  return { valid: errors.length === 0, errors: [...new Set(errors)], live };
}
