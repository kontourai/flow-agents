import test from "node:test";
import assert from "node:assert/strict";
import { resolveCritiqueTransition } from "../../packaging/lifecycle-authority/runtime-v1.mjs";

const priorHash = "a".repeat(64), resolvingHash = "b".repeat(64);
const claim = (id, reviewer, verdict, status, lanes, findings) => ({ id: `claim-${id}`, value: verdict, status: "verified", metadata: { origin: "critique", critique_record_id: id, critique_record_hash: id === "prior" ? priorHash : resolvingHash, critique_sequence: id === "prior" ? 1 : 2, critique_predecessor_hash: id === "prior" ? "0".repeat(64) : priorHash, workflow_subject_ref: "work-item:1", reviewer, verdict, claim_status: status, lanes, findings, review_target: { workspace_snapshot: { digest: id === "prior" ? "c".repeat(64) : "d".repeat(64), head_sha: "none" } } } });
const bundle = { schema_version: "1.0", claims: [
  claim("prior", "reviewer-a", "fail", "verified", [{ id: "security", status: "fail" }], [{ id: "F-1", status: "open" }]),
  claim("resolving", "reviewer-b", "pass", "verified", [{ id: "security", status: "pass" }], [{ id: "F-1", status: "fixed" }]),
] };
const authorization = { schema_version: "1.0", operation: "resolve-critique", run_id: "run-1", subject: "work-item:1", prior_record_id: "prior", prior_record_hash: priorHash, resolving_record_id: "resolving", resolving_record_hash: resolvingHash, expected_resolver: "reviewer-b", resolved_lane_ids: ["security"], resolved_finding_ids: ["F-1"], prior_snapshot_sha256: "c".repeat(64), resolving_snapshot_sha256: "d".repeat(64), prior_head_sha: "none", resolving_head_sha: "none", requested_at: "2030-01-01T00:00:00Z", signature: { algorithm: "ed25519", key_id: "operator", value: "signed-elsewhere" } };
test("runtime v1 preserves critique history and appends one authorization-bound event", () => {
  const next = resolveCritiqueTransition({ bundle, authorization, prior_record_id: "prior", resolving_record_id: "resolving" });
  assert.equal(next.claims.length, 2);
  assert.equal(next.claims[0].metadata.superseded_by, "resolving");
  assert.equal(next.claims[0].status, "superseded");
  assert.equal(next.critique_resolution_events.length, 1);
  assert.match(next.critique_resolution_events[0].event_id, /^critique-resolution:[a-f0-9]{64}$/);
  assert.deepEqual(bundle.claims[0].metadata.superseded_by, undefined, "input remains immutable");
});
test("runtime v1 rejects incomplete repair coverage and same-reviewer resolution", () => {
  assert.throws(() => resolveCritiqueTransition({ bundle, authorization: { ...authorization, resolved_lane_ids: [] }, prior_record_id: "prior", resolving_record_id: "resolving" }), /exact failing critique surface/);
  const same = structuredClone(bundle); same.claims[1].metadata.reviewer = "reviewer-a";
  assert.throws(() => resolveCritiqueTransition({ bundle: same, authorization: { ...authorization, expected_resolver: "reviewer-a" }, prior_record_id: "prior", resolving_record_id: "resolving" }), /distinct/);
});
