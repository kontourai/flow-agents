import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const COORDINATOR_RUNTIME_VERSION = "1.0";
export const COORDINATOR_RUNTIME_ID = "kontourai.lifecycle-authority.runtime";
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
  exact(input, ["bundle", "resolution_events", "authorization", "prior_record_id", "resolving_record_id", "current_completion_sha256"], "history repair transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims) || Object.hasOwn(input.bundle, "critique_resolution_events")) throw new Error("history repair requires a stripped trust bundle");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "repair-critique-resolution-history") throw new Error("history repair authorization identity is invalid");
  const ledger = assertExternalLedgerInput(input, authorization, false);
  requireDigest(input.current_completion_sha256, "current completion");
  if (authorization.current_completion_sha256 !== input.current_completion_sha256) throw new Error("history repair authorization does not bind the current completion digest");
  // This is deliberately only structural here. The authorization binds the exact
  // protected trust.bundle *bytes*, which a parsed-object transition cannot
  // reproduce without silently changing the signed preimage contract.
  requireDigest(authorization.preimage_bundle_sha256, "history repair authorization bundle preimage");
  if (authorization.preimage_ledger_sha256 !== ledger.digest || authorization.preimage_ledger_length !== ledger.length || authorization.preimage_ledger_tail_hash !== ledger.tail_hash) throw new Error("history repair authorization does not bind the resolution event ledger preimage");
  if (authorization.reason_code !== "coordinator-external-ledger-overwrite-v1") throw new Error("history repair authorization reason is invalid");
  if (authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("history repair authorization does not bind the selected critique edge");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata; const resolvingMetadata = resolving.metadata;
  if (prior.status !== "superseded" || priorMetadata.superseded_by !== input.resolving_record_id || !record(priorMetadata.critique_resolution)) throw new Error("history repair requires an already-superseded cross-reviewer edge");
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
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, edge), signed_authorization: authorization,
  };
  return { bundle: input.bundle, resolution_events: appendEvent(input.resolution_events, unsignedEvent) };
}
