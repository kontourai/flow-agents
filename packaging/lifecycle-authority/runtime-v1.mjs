import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const COORDINATOR_RUNTIME_VERSION = "1.0";
export const COORDINATOR_RUNTIME_ID = "kontourai.lifecycle-authority.runtime";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const canonicalJsonValue = (value) => Array.isArray(value) ? `[${value.map(canonicalJsonValue).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const protocolCanonical = (value) => canonicalJsonValue(JSON.parse(JSON.stringify(value) ?? "null"));
export const coordinatorRuntimeSha256 = () => crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
export const bundleDigest = (bundle) => crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
function critiqueResolutionResultCoreDigest(prior, resolving, edge) {
  return crypto.createHash("sha256").update(canonical({
    prior_record_id: prior.critique_record_id,
    prior_record_hash: prior.critique_record_hash,
    resolving_record_id: resolving.critique_record_id,
    resolving_record_hash: resolving.critique_record_hash,
    edge,
  })).digest("hex");
}
export function critiqueResolutionAuthorityDigest(claims, events) {
  const referencedIds = new Set(events.flatMap((event) => [event?.prior_record_id, event?.resolving_record_id]).filter((value) => typeof value === "string"));
  const referencedClaims = claims
    .filter((claim) => claim?.metadata?.origin === "critique" && referencedIds.has(claim.metadata.critique_record_id))
    .sort((a, b) => String(a.metadata.critique_record_id).localeCompare(String(b.metadata.critique_record_id)));
  return crypto.createHash("sha256").update(protocolCanonical({ critique_claims: referencedClaims, critique_resolution_events: events })).digest("hex");
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
function resolutionEvent(authorization, priorMetadata, resolvingMetadata, resolution, priorEvents) {
  const authorizationSha256 = crypto.createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
  const unsignedEvent = {
    schema_version: "1.0", event_id: `critique-resolution:${authorizationSha256}`, sequence: priorEvents.length + 1,
    predecessor_hash: priorEvents.at(-1)?.event_hash ?? "0".repeat(64), operation: "resolve-critique",
    run_id: authorization.run_id, subject: authorization.subject,
    preimage_bundle_sha256: authorization.prior_bundle_sha256,
    prior_record_id: authorization.prior_record_id, prior_record_hash: priorMetadata.critique_record_hash,
    resolving_record_id: authorization.resolving_record_id, resolving_record_hash: resolvingMetadata.critique_record_hash,
    resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256,
    authorization_key_id: authorization.signature.key_id, authorization_nonce: authorization.nonce,
    edge: resolution,
    resulting_core_sha256: critiqueResolutionResultCoreDigest(priorMetadata, resolvingMetadata, resolution),
    signed_authorization: authorization,
  };
  return { ...unsignedEvent, event_hash: crypto.createHash("sha256").update(JSON.stringify(unsignedEvent)).digest("hex") };
}

/** Pure deterministic critique-resolution transition. Performs no I/O. */
export function resolveCritiqueTransition(input) {
  exact(input, ["bundle", "authorization", "prior_record_id", "resolving_record_id"], "critique transition input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims)) throw new Error("trust bundle claims are required");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.schema_version !== "1.0" || authorization.operation !== "resolve-critique") throw new Error("critique resolution authorization identity is invalid");
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
  const authorizationSha256 = crypto.createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
  const eventId = `critique-resolution:${authorizationSha256}`;
  const priorEvents = Array.isArray(input.bundle.critique_resolution_events) ? input.bundle.critique_resolution_events : [];
  const resolution = {
    schema_version: "1.0", kind: "cross-reviewer", prior_record_id: input.prior_record_id,
    resolving_record_id: input.resolving_record_id, resolver: resolvingMetadata.reviewer,
    resolved_lane_ids: lanes, resolved_finding_ids: findings, resolved_at: authorization.requested_at,
    authorization_sha256: authorizationSha256, resolution_event_id: eventId,
  };
  const claims = input.bundle.claims.map((claim) => claim === prior ? { ...claim, status: "superseded", metadata: { ...priorMetadata, superseded_by: input.resolving_record_id, critique_resolution: resolution } } : claim);
  const event = resolutionEvent(authorization, priorMetadata, resolvingMetadata, resolution, priorEvents);
  return { ...input.bundle, claims, critique_resolution_events: [...priorEvents, event] };
}

/** Restore a missing append-only event for an already-applied, durably completed resolution. */
export function reconcileCritiqueResolutionEvent(input) {
  exact(input, ["bundle", "authorization", "existing_events", "prior_record_id", "resolving_record_id"], "critique event reconciliation input");
  if (!record(input.bundle) || !Array.isArray(input.bundle.claims) || !Array.isArray(input.existing_events)) throw new Error("critique event reconciliation inputs are invalid");
  const authorization = input.authorization;
  if (!record(authorization) || authorization.operation !== "resolve-critique" || authorization.prior_record_id !== input.prior_record_id || authorization.resolving_record_id !== input.resolving_record_id) throw new Error("critique event reconciliation authorization identity is invalid");
  const prior = oneClaim(input.bundle.claims, input.prior_record_id, "prior");
  const resolving = oneClaim(input.bundle.claims, input.resolving_record_id, "resolving");
  const priorMetadata = prior.metadata, resolvingMetadata = resolving.metadata;
  const edge = priorMetadata.critique_resolution;
  const authorizationSha256 = crypto.createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
  if (prior.status !== "superseded" || priorMetadata.superseded_by !== input.resolving_record_id || !record(edge)
    || edge.kind !== "cross-reviewer" || edge.prior_record_id !== input.prior_record_id || edge.resolving_record_id !== input.resolving_record_id
    || edge.resolver !== resolvingMetadata.reviewer || edge.authorization_sha256 !== authorizationSha256
    || edge.resolution_event_id !== `critique-resolution:${authorizationSha256}`) throw new Error("applied critique resolution does not bind the replayed authorization");
  assertAuthorizationPreimage(authorization, priorMetadata, resolvingMetadata, input.bundle.claims);
  const lanes = failedLaneIds(priorMetadata), findings = openFindingIds(priorMetadata);
  if (canonical(edge.resolved_lane_ids) !== canonical(lanes) || canonical(edge.resolved_finding_ids) !== canonical(findings)
    || canonical(authorization.resolved_lane_ids) !== canonical(lanes) || canonical(authorization.resolved_finding_ids) !== canonical(findings)) throw new Error("applied critique resolution coverage does not bind the replayed authorization");
  const existing = input.existing_events.find((event) => event?.event_id === edge.resolution_event_id);
  if (existing) return input.existing_events;
  return [...input.existing_events, resolutionEvent(authorization, priorMetadata, resolvingMetadata, edge, input.existing_events)];
}
