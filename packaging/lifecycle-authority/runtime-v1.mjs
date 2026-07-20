import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const COORDINATOR_RUNTIME_VERSION = "1.0";
export const COORDINATOR_RUNTIME_ID = "kontourai.lifecycle-authority.runtime";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const coordinatorRuntimeSha256 = () => crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
export const bundleDigest = (bundle) => crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
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
  if (!["fail", "not_verified"].includes(priorMetadata.verdict)) throw new Error("prior critique must be failing or not verified");
  if (resolvingMetadata.verdict !== "pass" || resolvingMetadata.claim_status !== "verified") throw new Error("resolving critique must be a verified pass");
  if (!priorMetadata.reviewer || priorMetadata.reviewer === resolvingMetadata.reviewer || authorization.expected_resolver !== resolvingMetadata.reviewer) throw new Error("resolution requires the distinct signed resolving reviewer");
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
  const resolution = { resolved_by: resolvingMetadata.reviewer, resolved_at: authorization.requested_at, resolution_event_id: eventId, authorization_sha256: authorizationSha256, resolved_lane_ids: lanes, resolved_finding_ids: findings };
  const claims = input.bundle.claims.map((claim) => claim === prior ? { ...claim, status: "superseded", metadata: { ...priorMetadata, superseded_by: input.resolving_record_id, critique_resolution: resolution } } : claim);
  const unsignedEvent = { schema_version: "1.0", event_id: eventId, sequence: priorEvents.length + 1, predecessor_hash: priorEvents.at(-1)?.event_hash ?? "0".repeat(64), operation: "resolve-critique", run_id: authorization.run_id, subject: authorization.subject, prior_record_id: input.prior_record_id, resolving_record_id: input.resolving_record_id, resolver: resolvingMetadata.reviewer, authorization_sha256: authorizationSha256, signed_authorization: authorization };
  const event = { ...unsignedEvent, event_hash: crypto.createHash("sha256").update(JSON.stringify(unsignedEvent)).digest("hex") };
  return { ...input.bundle, claims, critique_resolution_events: [...priorEvents, event] };
}
