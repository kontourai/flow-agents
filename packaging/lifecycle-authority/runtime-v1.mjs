import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const COORDINATOR_RUNTIME_VERSION = "1.0";
export const COORDINATOR_RUNTIME_ID = "kontourai.lifecycle-authority.runtime";
export const CRITIQUE_HISTORY_PROJECTION_VERSION = "1.0";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const coordinatorRuntimeSha256 = () => crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
export const bundleDigest = (bundle) => crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
const jsonDigest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function critiqueResolutionResultCoreDigest(prior, resolving, edge) {
  return crypto.createHash("sha256").update(canonical({
    prior_record_id: prior.critique_record_id,
    prior_record_hash: prior.critique_record_hash,
    resolving_record_id: resolving.critique_record_id,
    resolving_record_hash: resolving.critique_record_hash,
    edge,
  })).digest("hex");
}
function exact(value, fields, label) {
  if (!record(value) || canonical(Object.keys(value).sort()) !== canonical([...fields].sort())) throw new Error(`${label} contains unexpected or missing fields`);
}
function oneClaim(claims, recordId, label) {
  const matches = claims.filter((claim) => claim?.metadata?.origin === "critique" && claim.metadata.critique_record_id === recordId);
  if (matches.length !== 1) throw new Error(`${label} critique record is missing or ambiguous`);
  return matches[0];
}
function failedLaneIds(metadata) { return (Array.isArray(metadata.lanes) ? metadata.lanes : []).filter((lane) => lane.status !== "pass").map((lane) => String(lane.id)).sort(); }
function openFindingIds(metadata) { return (Array.isArray(metadata.findings) ? metadata.findings : []).filter((finding) => finding.status === "open").map((finding) => String(finding.id)).sort(); }
function exactText(actual, expected, label) { if (typeof actual !== "string" || actual !== expected) throw new Error(`authorization does not bind ${label}`); }
function snapshot(metadata, field) {
  const value = metadata.review_target?.workspace_snapshot;
  if (!record(value)) throw new Error(`critique ${field} is missing from the immutable workspace snapshot`);
  if (field === "head_sha" && (value[field] === undefined || value[field] === null)) return "none";
  if (typeof value[field] !== "string" || !value[field]) throw new Error(`critique ${field} is missing from the immutable workspace snapshot`);
  return value[field];
}
function assertDescends(claims, prior, resolving) {
  const byHash = new Map(claims.filter((claim) => claim?.metadata?.origin === "critique").map((claim) => [claim.metadata.critique_record_hash, claim.metadata]));
  const visited = new Set(); let cursor = resolving;
  while (cursor && !visited.has(cursor.critique_record_hash)) {
    visited.add(cursor.critique_record_hash);
    if (cursor.critique_predecessor_hash === prior.critique_record_hash) return;
    cursor = byHash.get(cursor.critique_predecessor_hash);
  }
  throw new Error("resolving critique is not a descendant of the authorized prior critique");
}
function assertAuthorizationPreimage(authorization, prior, resolving, claims) {
  exactText(authorization.subject, prior.workflow_subject_ref, "the prior critique subject");
  exactText(resolving.workflow_subject_ref, prior.workflow_subject_ref, "one workflow subject");
  exactText(authorization.prior_record_hash, prior.critique_record_hash, "the prior record hash");
  exactText(authorization.resolving_record_hash, resolving.critique_record_hash, "the resolving record hash");
  exactText(authorization.expected_resolver, resolving.reviewer, "the resolving reviewer");
  exactText(authorization.prior_snapshot_sha256, snapshot(prior, "digest"), "the prior snapshot digest");
  exactText(authorization.resolving_snapshot_sha256, snapshot(resolving, "digest"), "the resolving snapshot digest");
  exactText(authorization.prior_head_sha, snapshot(prior, "head_sha"), "the prior snapshot head");
  exactText(authorization.resolving_head_sha, snapshot(resolving, "head_sha"), "the resolving snapshot head");
  if (resolving.critique_sequence <= prior.critique_sequence) throw new Error("resolving critique is not later than the prior critique");
  assertDescends(claims, prior, resolving);
}

function resolutionEventLedger(events) {
  return { schema_version: "1.0", events };
}

function critiqueRecordHash(record) {
  return crypto.createHash("sha256").update(canonical({
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

function critiqueProjectionRecord(claim) {
  const metadata = record(claim?.metadata) ? claim.metadata : {};
  return {
    critique_record_id: metadata.critique_record_id,
    critique_record_hash: metadata.critique_record_hash,
    critique_predecessor_hash: metadata.critique_predecessor_hash,
    critique_sequence: metadata.critique_sequence,
    reviewer: metadata.reviewer,
    verdict: claim?.value,
    claim_status: claim?.status,
    summary: claim?.fieldOrBehavior ?? null,
    workflow_subject_ref: metadata.workflow_subject_ref,
    review_target: metadata.review_target ?? { artifacts: [] },
    findings: metadata.findings ?? [],
    lanes: metadata.lanes ?? [],
    reviewed_at: metadata.reviewed_at ?? null,
    created_at: claim?.createdAt ?? null,
    updated_at: claim?.updatedAt ?? null,
    superseded_by: metadata.superseded_by ?? null,
    critique_resolution: metadata.critique_resolution ?? null,
  };
}

export function critiqueHistoryProjection(claims) {
  const records = (Array.isArray(claims) ? claims : [])
    .filter((claim) => claim?.metadata?.origin === "critique")
    .map(critiqueProjectionRecord)
    .sort((left, right) => Number(left.critique_sequence) - Number(right.critique_sequence));
  return { schema_version: CRITIQUE_HISTORY_PROJECTION_VERSION, kind: "kontourai.critique-history", records };
}

export function critiqueHistoryProjectionSummary(claims) {
  const projection = critiqueHistoryProjection(claims);
  return {
    version: CRITIQUE_HISTORY_PROJECTION_VERSION,
    digest: crypto.createHash("sha256").update(canonical(projection)).digest("hex"),
    length: projection.records.length,
    tail_hash: projection.records.at(-1)?.critique_record_hash ?? "0".repeat(64),
    projection,
  };
}

export function critiqueResolutionEdgeProjection(claims) {
  const edges = critiqueHistoryProjection(claims).records
    .filter((entry) => entry.superseded_by !== null || entry.critique_resolution !== null)
    .map((entry) => ({
      critique_record_id: entry.critique_record_id,
      superseded_by: entry.superseded_by,
      critique_resolution: entry.critique_resolution,
    }));
  return { schema_version: CRITIQUE_HISTORY_PROJECTION_VERSION, kind: "kontourai.critique-resolution-edges", edges };
}

export function critiqueResolutionEdgeProjectionSummary(claims) {
  const projection = critiqueResolutionEdgeProjection(claims);
  return {
    version: CRITIQUE_HISTORY_PROJECTION_VERSION,
    digest: crypto.createHash("sha256").update(canonical(projection)).digest("hex"),
    count: projection.edges.length,
    projection,
  };
}

function gateExpectation(claim) {
  return record(claim?.metadata?.gate_claim) && typeof claim.metadata.gate_claim.expectation_id === "string"
    ? claim.metadata.gate_claim.expectation_id
    : null;
}

function assertAuthorizedVerificationClaimDelta(currentBundle, candidateBundle, authorization, flow) {
  if (!record(currentBundle) || !record(candidateBundle) || !Array.isArray(currentBundle.claims) || !Array.isArray(candidateBundle.claims)) {
    throw new Error("verification evidence reseal requires Trust Bundles with claims");
  }
  if (authorization.claim_delta !== "replace"
      || !Number.isSafeInteger(authorization.predecessor_claim_index)
      || !Number.isSafeInteger(authorization.current_claim_index)
      || authorization.predecessor_claim_index !== authorization.current_claim_index
      || authorization.predecessor_claim_index < 0
      || currentBundle.claims.length !== candidateBundle.claims.length) {
    throw new Error("verification evidence reseal authorization claim delta is invalid");
  }
  const index = authorization.predecessor_claim_index;
  const predecessor = currentBundle.claims[index];
  const current = candidateBundle.claims[index];
  const requirements = Array.isArray(flow.requirements) ? flow.requirements : [];
  const targetRequirements = requirements.filter((requirement) => record(requirement) && requirement.id === authorization.target_expectation_id);
  if (!predecessor || !current
      || targetRequirements.length !== 1
      || gateExpectation(predecessor) !== authorization.target_expectation_id
      || gateExpectation(current) !== authorization.target_expectation_id
      || currentBundle.claims.filter((claim) => gateExpectation(claim) === authorization.target_expectation_id).length !== 1
      || candidateBundle.claims.filter((claim) => gateExpectation(claim) === authorization.target_expectation_id).length !== 1) {
    throw new Error("verification evidence reseal does not target exactly one authorized verify expectation");
  }
  const targetRequirement = targetRequirements[0];
  const bundleClaim = targetRequirement.bundle_claim;
  if (!record(bundleClaim) || typeof bundleClaim.claimType !== "string" || typeof bundleClaim.subjectType !== "string") {
    throw new Error("verification evidence reseal target has no canonical current gate-claim requirement");
  }
  for (const [label, claim] of [["predecessor", predecessor], ["replacement", current]]) {
    const gateClaim = claim?.metadata?.gate_claim;
    if (!record(gateClaim)
        || gateClaim.expectation_id !== targetRequirement.id
        || gateClaim.step_id !== flow.step_id
        || gateClaim.claim_type !== bundleClaim.claimType
        || gateClaim.subject_type !== bundleClaim.subjectType) {
      throw new Error(`verification evidence reseal ${label} gate_claim metadata does not bind the canonical current ${flow.gate_id} requirement`);
    }
  }
  const claimDigest = (claim) => crypto.createHash("sha256").update(JSON.stringify(claim)).digest("hex");
  if (predecessor.id !== authorization.predecessor_claim_id
      || predecessor.status !== authorization.predecessor_claim_status
      || claimDigest(predecessor) !== authorization.predecessor_claim_sha256
      || current.id !== authorization.current_claim_id
      || current.status !== authorization.current_claim_status
      || claimDigest(current) !== authorization.current_claim_sha256) {
    throw new Error("verification evidence reseal claim identity, status, or digest does not match the authorized delta");
  }
  currentBundle.claims.forEach((claim, claimIndex) => {
    if (claimIndex !== index && JSON.stringify(claim) !== JSON.stringify(candidateBundle.claims[claimIndex])) {
      throw new Error("verification evidence reseal changed the complete ordered claim set outside the authorized expectation");
    }
  });
}

/**
 * Pure package-side policy for the privileged evidence reseal. Filesystem,
 * signature, replay, Flow attachment, and completion concerns remain in the
 * coordinator; this transition accepts only the exact authorized bytes and a
 * gate-claim-only Trust Bundle change.
 */
export function resealVerificationEvidenceTransition(input) {
  const {
    current_bundle: currentBundle,
    candidate_bundle: candidateBundle,
    resolution_events: resolutionEvents,
    authorization,
    current_bundle_bytes: currentBundleBytes,
    candidate_bundle_bytes: candidateBundleBytes,
    ledger_bytes: ledgerBytes,
    flow,
  } = input ?? {};
  if (!record(authorization) || authorization.operation !== "reseal-verification-evidence") throw new Error("verification evidence reseal authorization identity is invalid");
  if (!Buffer.isBuffer(currentBundleBytes) || !Buffer.isBuffer(candidateBundleBytes) || !Buffer.isBuffer(ledgerBytes)) throw new Error("verification evidence reseal requires exact byte preimages");
  if (!record(flow) || flow.definition_id !== "builder.build" || flow.step_id !== "verify"
      || typeof flow.gate_id !== "string" || !Array.isArray(flow.requirements)
      || authorization.flow_definition_id !== flow.definition_id || authorization.flow_step_id !== flow.step_id
      || authorization.flow_gate_id !== flow.gate_id) {
    throw new Error("verification evidence reseal is authorized only for the builder.build verify gate");
  }
  const currentCritique = critiqueHistoryProjectionSummary(currentBundle?.claims);
  const candidateCritique = critiqueHistoryProjectionSummary(candidateBundle?.claims);
  if (canonical(currentCritique.projection) !== canonical(candidateCritique.projection)) {
    throw new Error("verification evidence reseal candidate changed the byte-identical critique projection");
  }
  assertAuthorizedVerificationClaimDelta(currentBundle, candidateBundle, authorization, flow);
  if (crypto.createHash("sha256").update(currentBundleBytes).digest("hex") !== authorization.preimage_bundle_sha256) throw new Error("verification evidence reseal current bundle preimage changed");
  if (crypto.createHash("sha256").update(candidateBundleBytes).digest("hex") !== authorization.candidate_bundle_sha256) throw new Error("verification evidence reseal candidate bundle preimage changed");
  if (crypto.createHash("sha256").update(ledgerBytes).digest("hex") !== authorization.preimage_ledger_sha256) throw new Error("verification evidence reseal resolution ledger preimage changed");
  if (!Array.isArray(resolutionEvents)
      || authorization.preimage_ledger_length !== resolutionEvents.length
      || authorization.preimage_ledger_tail_hash !== (resolutionEvents.at(-1)?.event_hash ?? "0".repeat(64))) {
    throw new Error("verification evidence reseal resolution ledger identity changed");
  }
  return { bundle: structuredClone(candidateBundle), resolution_events: structuredClone(resolutionEvents) };
}

export function assertAppendOnlyCritiqueHistory(historicalClaims, currentClaims) {
  const historical = critiqueHistoryProjectionSummary(historicalClaims);
  const current = critiqueHistoryProjectionSummary(currentClaims);
  if (current.length < historical.length) throw new Error("current critique history deletes historical records");
  historical.projection.records.forEach((entry, index) => {
    if (canonical(current.projection.records[index]) !== canonical(entry)) throw new Error("current critique history is not an exact historical prefix");
  });
  current.projection.records.forEach((entry, index, entries) => {
    if (entry.critique_sequence !== index + 1) throw new Error("current critique history append is noncontiguous");
    const predecessor = index === 0 ? "0".repeat(64) : entries[index - 1].critique_record_hash;
    if (entry.critique_predecessor_hash !== predecessor) throw new Error("current critique history append predecessor is invalid");
    if (critiqueRecordHash(entry) !== entry.critique_record_hash) throw new Error("current critique history append record hash is invalid");
  });
  const historicalEdges = critiqueResolutionEdgeProjectionSummary(historicalClaims);
  const currentHistoricalEdges = critiqueResolutionEdgeProjectionSummary(
    currentClaims.filter((claim) => Number.isSafeInteger(claim?.metadata?.critique_sequence) && claim.metadata.critique_sequence <= historical.length),
  );
  if (historicalEdges.digest !== currentHistoricalEdges.digest || historicalEdges.count !== currentHistoricalEdges.count) throw new Error("historical critique resolution edges changed");
  return { historical, current, historical_edges: historicalEdges, current_historical_edges: currentHistoricalEdges };
}

function syntheticCompletionCore(bundle, events) {
  return crypto.createHash("sha256").update(canonical({ ...bundle, critique_resolution_events: events })).digest("hex");
}

export function selectUniqueHistoricalLedgerPrefix(storedBundle, currentEvents, historicalResultCoreSha256, digestCandidate = syntheticCompletionCore) {
  if (!Array.isArray(currentEvents) || !/^[a-f0-9]{64}$/.test(historicalResultCoreSha256)) throw new Error("historical ledger prefix inputs are invalid");
  const matches = Array.from({ length: currentEvents.length + 1 }, (_, length) => currentEvents.slice(0, length))
    .filter((events) => digestCandidate(storedBundle, events) === historicalResultCoreSha256);
  if (matches.length !== 1) throw new Error(`historical completion requires exactly one reproducing ledger prefix; found ${matches.length}`);
  const events = matches[0];
  return {
    length: events.length,
    raw_sha256: crypto.createHash("sha256").update(JSON.stringify({ schema_version: "1.0", events })).digest("hex"),
    canonical_sha256: crypto.createHash("sha256").update(canonical({ schema_version: "1.0", events })).digest("hex"),
    tail_hash: events.at(-1)?.event_hash ?? "0".repeat(64),
    events,
  };
}

const HISTORY_REPAIR_BRIDGE_FIELDS = [
  "historical_completion_sha256", "historical_completion_request_sha256", "historical_completion_action", "historical_completion_result_core_sha256",
  "historical_attachment_id", "historical_manifest_entry_sha256", "historical_stored_path", "historical_stored_raw_sha256", "historical_stored_bundle_sha256",
  "historical_durable_operation_id", "historical_durable_completion_record_sha256",
  "historical_ledger_prefix_length", "historical_ledger_prefix_raw_sha256", "historical_ledger_prefix_canonical_sha256", "historical_ledger_prefix_tail_hash",
  "historical_critique_projection_version", "historical_critique_projection_sha256", "historical_critique_projection_length", "historical_critique_projection_tail_hash",
  "current_critique_projection_version", "current_critique_projection_sha256", "current_critique_projection_length", "current_critique_projection_tail_hash",
  "historical_resolution_edge_projection_sha256", "historical_resolution_edge_projection_count",
  "current_resolution_edge_projection_sha256", "current_resolution_edge_projection_count",
  "current_bundle_sha256", "current_ledger_sha256", "current_ledger_length", "current_ledger_tail_hash",
];

export function critiqueResolutionHistoryBridgeDigest(value) {
  return jsonDigest(Object.fromEntries(HISTORY_REPAIR_BRIDGE_FIELDS.map((field) => [field, value[field]])));
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function resolutionEdgeKey(edge) {
  return canonical([edge.prior_record_id, edge.resolving_record_id, edge.resolver, edge.resolution_event_id, edge.authorization_sha256]);
}

function crossReviewerEdges(bundle) {
  if (!record(bundle) || !Array.isArray(bundle.claims)) return [];
  return bundle.claims
    .filter((claim) => claim?.metadata?.origin === "critique" && record(claim.metadata?.critique_resolution) && claim.metadata.critique_resolution.kind === "cross-reviewer")
    .map((claim) => ({ claim, edge: claim.metadata.critique_resolution }));
}

function assertStoredAuthorizationBinding(event, expected) {
  const authorization = event.signed_authorization;
  if (!record(authorization) || jsonDigest(authorization) !== event.authorization_sha256) throw new Error("resolution event ledger signed authorization digest is invalid");
  if (!record(authorization.signature) || authorization.signature.algorithm !== "ed25519" || authorization.signature.key_id !== event.authorization_key_id || authorization.nonce !== event.authorization_nonce) throw new Error("resolution event ledger signed authorization identity is invalid");
  if (authorization.operation !== event.operation || authorization.run_id !== event.run_id || authorization.subject !== event.subject) throw new Error("resolution event ledger signed authorization operation binding is invalid");
  if (expected.project_root && authorization.project_root !== expected.project_root) throw new Error("resolution event ledger signed authorization project binding is invalid");
  for (const field of ["prior_record_id", "prior_record_hash", "resolving_record_id", "resolving_record_hash"])
    if (authorization[field] !== event[field]) throw new Error("resolution event ledger signed authorization critique edge binding is invalid");
  if (authorization.expected_resolver !== event.resolver) throw new Error("resolution event ledger signed authorization resolver binding is invalid");
  if (!record(event.edge) || event.edge.prior_record_id !== event.prior_record_id || event.edge.resolving_record_id !== event.resolving_record_id || event.edge.resolver !== event.resolver) throw new Error("resolution event ledger edge binding is invalid");
  if (event.operation === "resolve-critique") {
    if (event.event_id !== `critique-resolution:${event.authorization_sha256}` || event.edge.resolution_event_id !== event.event_id || event.edge.authorization_sha256 !== event.authorization_sha256) throw new Error("resolution event ledger ordinary event binding is invalid");
  } else if (authorization.missing_resolution_event_id !== event.missing_resolution_event_id || authorization.missing_authorization_sha256 !== event.missing_authorization_sha256 || event.edge.resolution_event_id !== event.missing_resolution_event_id || event.edge.authorization_sha256 !== event.missing_authorization_sha256) {
    throw new Error("resolution event ledger repair event binding is invalid");
  } else if (
    !HISTORY_REPAIR_BRIDGE_FIELDS.every((field) => Object.hasOwn(authorization, field))
    || !Object.hasOwn(authorization, "historical_bridge_sha256")
    || !Object.hasOwn(event, "verified_bridge_sha256")
    || authorization.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(authorization)
    || event.verified_bridge_sha256 !== authorization.historical_bridge_sha256
  ) {
    throw new Error("resolution event ledger repair event verified historical bridge binding is invalid");
  }
}

function assertLedgerMapsToBundle(events, bundle, strictCoverage) {
  const edges = crossReviewerEdges(bundle);
  const mapped = new Set();
  for (const event of events) {
    const candidates = edges.filter(({ edge }) => event.prior_record_id === edge.prior_record_id
      && event.resolving_record_id === edge.resolving_record_id
      && event.resolver === edge.resolver
      && canonical(event.edge) === canonical(edge));
    if (candidates.length !== 1) throw new Error("resolution event ledger event does not map one-to-one to a bundle cross-reviewer edge");
    const [candidate] = candidates;
    const key = resolutionEdgeKey(candidate.edge);
    if (mapped.has(key)) throw new Error("resolution event ledger contains duplicate or conflicting bundle edge mappings");
    mapped.add(key);
  }
  if (strictCoverage && edges.some(({ edge }) => !mapped.has(resolutionEdgeKey(edge)))) throw new Error("resolution event ledger leaves a pre-existing cross-reviewer edge uncovered; repair is required");
}

/** Validates the external append-only authority ledger before any transition. */
export function validateResolutionEventLedger(events, expected = {}) {
  if (!Array.isArray(events)) throw new Error("resolution event ledger events must be an array");
  const eventIds = new Set(); const authorizationDigests = new Set(); let predecessor = "0".repeat(64);
  for (const [index, event] of events.entries()) {
    if (!record(event) || event.schema_version !== "1.0") throw new Error("resolution event ledger entry is invalid");
    if (typeof event.event_id !== "string" || !event.event_id || eventIds.has(event.event_id)) throw new Error("resolution event ledger contains a duplicate event_id");
    if (event.sequence !== index + 1) throw new Error("resolution event ledger sequence is invalid");
    if (event.predecessor_hash !== predecessor) throw new Error("resolution event ledger predecessor is invalid");
    if (!["resolve-critique", "repair-critique-resolution-history"].includes(event.operation)) throw new Error("resolution event ledger operation is invalid");
    if (typeof event.run_id !== "string" || !event.run_id || typeof event.subject !== "string" || !event.subject) throw new Error("resolution event ledger binding is invalid");
    if (expected.run_id && event.run_id !== expected.run_id) throw new Error("resolution event ledger run binding is invalid");
    if (expected.subject && event.subject !== expected.subject) throw new Error("resolution event ledger subject binding is invalid");
    requireDigest(event.event_hash, "resolution event ledger event_hash");
    const { event_hash, ...unsigned } = event;
    if (jsonDigest(unsigned) !== event_hash) throw new Error("resolution event ledger event_hash is invalid");
    requireDigest(event.authorization_sha256, "resolution event ledger authorization_sha256");
    if (authorizationDigests.has(event.authorization_sha256)) throw new Error("resolution event ledger contains a duplicate authorization");
    assertStoredAuthorizationBinding(event, expected);
    eventIds.add(event.event_id); authorizationDigests.add(event.authorization_sha256); predecessor = event_hash;
  }
  if (expected.bundle) assertLedgerMapsToBundle(events, expected.bundle, Boolean(expected.strict_coverage));
  return Object.freeze({ length: events.length, tail_hash: predecessor, digest: jsonDigest(resolutionEventLedger(events)) });
}

function assertExternalLedgerInput(input, authorization, strictCoverage) {
  if (!Array.isArray(input.resolution_events)) throw new Error("resolution event ledger is required");
  return validateResolutionEventLedger(input.resolution_events, { run_id: authorization.run_id, subject: authorization.subject, project_root: authorization.project_root, bundle: input.bundle, strict_coverage: strictCoverage });
}

function appendEvent(events, unsigned) {
  const event = { ...unsigned, event_hash: jsonDigest(unsigned) };
  return [...events, event];
}

/** Pure deterministic critique-resolution transition. Performs no I/O. */
export function resolveCritiqueTransition(input) {
  exact(input, ["bundle", "resolution_events", "authorization", "prior_record_id", "resolving_record_id"], "critique transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims)) throw new Error("trust bundle claims are required");
  if (Object.hasOwn(input.bundle, "critique_resolution_events")) throw new Error("trust bundle must not carry external resolution events");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "resolve-critique") throw new Error("critique resolution authorization identity is invalid");
  const ledger = assertExternalLedgerInput(input, authorization, true);
  if (authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("authorization does not bind the selected critique edge");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata;
  const resolvingMetadata = resolving.metadata;
  if (priorMetadata.superseded_by) throw new Error("prior critique is already superseded");
  if (!["fail", "not_verified"].includes(prior.value)) throw new Error("prior critique must be failing or not verified");
  if (resolving.value !== "pass" || resolving.status !== "verified") throw new Error("resolving critique must be a verified pass");
  if (!priorMetadata.reviewer || priorMetadata.reviewer === resolvingMetadata.reviewer || authorization.expected_resolver !== resolvingMetadata.reviewer) throw new Error("resolution requires the distinct signed resolving reviewer");
  assertAuthorizationPreimage(authorization, priorMetadata, resolvingMetadata, input.bundle.claims);
  const lanes = failedLaneIds(priorMetadata);
  const findings = openFindingIds(priorMetadata);
  if (canonical(authorization.resolved_lane_ids) !== canonical(lanes) || canonical(authorization.resolved_finding_ids) !== canonical(findings)) throw new Error("authorization does not cover the exact failing critique surface");
  const resolvingLanes = new Map((resolvingMetadata.lanes ?? []).map((lane) => [String(lane.id), lane.status]));
  if (lanes.some((id) => resolvingLanes.get(id) !== "pass")) throw new Error("resolving critique does not pass every failed lane");
  const resolvingFindings = new Map((resolvingMetadata.findings ?? []).map((finding) => [String(finding.id), finding.status]));
  if (findings.some((id) => !["fixed", "accepted", "deferred", "false_positive"].includes(resolvingFindings.get(id)))) throw new Error("resolving critique does not close every open finding");
  const authorizationSha256 = jsonDigest(authorization);
  const eventId = `critique-resolution:${authorizationSha256}`;
  const resolution = {
    schema_version: "1.0", kind: "cross-reviewer", prior_record_id: input.prior_record_id,
    resolving_record_id: input.resolving_record_id, resolver: resolvingMetadata.reviewer,
    resolved_lane_ids: lanes, resolved_finding_ids: findings, resolved_at: authorization.requested_at,
    authorization_sha256: authorizationSha256, resolution_event_id: eventId,
  };
  const claims = input.bundle.claims.map((claim) => claim === prior ? { ...claim, status: "superseded", metadata: { ...priorMetadata, superseded_by: input.resolving_record_id, critique_resolution: resolution } } : claim);
  const unsignedEvent = {
    schema_version: "1.0", event_id: eventId, sequence: ledger.length + 1,
    predecessor_hash: ledger.tail_hash, operation: "resolve-critique",
    run_id: authorization.run_id, subject: authorization.subject,
    preimage_bundle_sha256: authorization.prior_bundle_sha256,
    prior_record_id: input.prior_record_id, prior_record_hash: priorMetadata.critique_record_hash,
    resolving_record_id: input.resolving_record_id, resolving_record_hash: resolvingMetadata.critique_record_hash,
    resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256,
    authorization_key_id: authorization.signature.key_id, authorization_nonce: authorization.nonce,
    edge: resolution,
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, resolution),
    signed_authorization: authorization,
  };
  return { bundle: { ...input.bundle, claims }, resolution_events: appendEvent(input.resolution_events, unsignedEvent) };
}

/** Pure, append-only attestation for an unrecoverable historical authority event. */
export function repairCritiqueResolutionHistoryTransition(input) {
  exact(input, ["bundle", "resolution_events", "authorization", "prior_record_id", "resolving_record_id", "current_completion_sha256", "ledger_bytes_sha256"], "history repair transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims) || Object.hasOwn(input.bundle, "critique_resolution_events")) throw new Error("history repair requires a stripped trust bundle");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "repair-critique-resolution-history") throw new Error("history repair authorization identity is invalid");
  const ledger = assertExternalLedgerInput(input, authorization, false);
  if (!HISTORY_REPAIR_BRIDGE_FIELDS.every((field) => Object.hasOwn(authorization, field)) || !Object.hasOwn(authorization, "historical_bridge_sha256")) {
    throw new Error("history repair authorization requires every historical bridge field");
  }
  requireDigest(authorization.historical_bridge_sha256, "history repair bridge");
  if (authorization.historical_bridge_sha256 !== critiqueResolutionHistoryBridgeDigest(authorization)) throw new Error("history repair authorization bridge digest is invalid");
  if (authorization.current_bundle_sha256 !== authorization.preimage_bundle_sha256
    || authorization.current_ledger_sha256 !== input.ledger_bytes_sha256
    || authorization.current_ledger_length !== ledger.length
    || authorization.current_ledger_tail_hash !== ledger.tail_hash) {
    throw new Error("history repair authorization does not bind the exact current preimages");
  }
  requireDigest(input.current_completion_sha256, "current completion");
  if (authorization.current_completion_sha256 !== input.current_completion_sha256) throw new Error("history repair authorization does not bind the current completion digest");
  // This is deliberately only structural here. The authorization binds the exact
  // protected trust.bundle *bytes*, which a parsed-object transition cannot
  // reproduce without silently changing the signed preimage contract.
  requireDigest(authorization.preimage_bundle_sha256, "history repair authorization bundle preimage");
  requireDigest(input.ledger_bytes_sha256, "history repair ledger bytes");
  if (authorization.preimage_ledger_sha256 !== input.ledger_bytes_sha256 || authorization.preimage_ledger_length !== ledger.length || authorization.preimage_ledger_tail_hash !== ledger.tail_hash) throw new Error("history repair authorization does not bind the exact resolution event ledger preimage");
  if (authorization.reason_code !== "coordinator-external-ledger-overwrite-v1") throw new Error("history repair authorization reason is invalid");
  if (authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("history repair authorization does not bind the selected critique edge");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata; const resolvingMetadata = resolving.metadata;
  if (prior.status !== "superseded" || priorMetadata.superseded_by !== input.resolving_record_id || !record(priorMetadata.critique_resolution) || priorMetadata.critique_resolution.kind !== "cross-reviewer" || priorMetadata.reviewer === resolvingMetadata.reviewer) throw new Error("history repair requires an already-superseded distinct cross-reviewer edge");
  assertAuthorizationPreimage(authorization, priorMetadata, resolvingMetadata, input.bundle.claims);
  const edge = priorMetadata.critique_resolution;
  if (jsonDigest(edge) !== authorization.preserved_resolution_sha256) throw new Error("history repair authorization does not bind the preserved resolution edge");
  if (authorization.missing_resolution_event_id !== edge.resolution_event_id || authorization.missing_authorization_sha256 !== edge.authorization_sha256) throw new Error("history repair authorization does not bind the missing original event");
  const original = input.resolution_events.find((event) => event.event_id === edge.resolution_event_id || event.authorization_sha256 === edge.authorization_sha256);
  if (original) throw new Error("history repair is invalid because the original event is already present");
  if (input.resolution_events.some((event) => event.operation === "repair-critique-resolution-history" && (event.missing_resolution_event_id === edge.resolution_event_id || event.missing_authorization_sha256 === edge.authorization_sha256))) throw new Error("history repair already exists for the missing original event");
  const authorizationSha256 = jsonDigest(authorization);
  const unsignedEvent = {
    schema_version: "1.0", event_id: `critique-resolution-history-repair:${authorizationSha256}`,
    sequence: ledger.length + 1, predecessor_hash: ledger.tail_hash, operation: "repair-critique-resolution-history",
    run_id: authorization.run_id, subject: authorization.subject, preimage_bundle_sha256: authorization.preimage_bundle_sha256,
    prior_record_id: input.prior_record_id, prior_record_hash: priorMetadata.critique_record_hash,
    resolving_record_id: input.resolving_record_id, resolving_record_hash: resolvingMetadata.critique_record_hash,
    resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256,
    authorization_key_id: authorization.signature?.key_id, authorization_nonce: authorization.nonce,
    edge, missing_resolution_event_id: edge.resolution_event_id, missing_authorization_sha256: edge.authorization_sha256,
    reason_code: authorization.reason_code, current_completion_sha256: input.current_completion_sha256,
    verified_bridge_sha256: authorization.historical_bridge_sha256,
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, edge), signed_authorization: authorization,
  };
  return { bundle: input.bundle, resolution_events: appendEvent(input.resolution_events, unsignedEvent) };
}
