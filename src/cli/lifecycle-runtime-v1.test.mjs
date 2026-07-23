import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as lifecycleRuntime from "../../packaging/lifecycle-authority/runtime-v1.mjs";

const { resolveCritiqueTransition } = lifecycleRuntime;

const priorHash = "a".repeat(64), resolvingHash = "b".repeat(64);
const claim = (id, reviewer, verdict, status, lanes, findings) => ({ id: `claim-${id}`, value: verdict, status: "verified", metadata: { origin: "critique", critique_record_id: id, critique_record_hash: id === "prior" ? priorHash : resolvingHash, critique_sequence: id === "prior" ? 1 : 2, critique_predecessor_hash: id === "prior" ? "0".repeat(64) : priorHash, workflow_subject_ref: "work-item:1", reviewer, verdict, claim_status: status, lanes, findings, review_target: { workspace_snapshot: { digest: id === "prior" ? "c".repeat(64) : "d".repeat(64), head_sha: "none" } } } });
const bundle = { schema_version: "1.0", claims: [
  claim("prior", "reviewer-a", "fail", "verified", [{ id: "security", status: "fail" }], [{ id: "F-1", status: "open" }]),
  claim("resolving", "reviewer-b", "pass", "verified", [{ id: "security", status: "pass" }], [{ id: "F-1", status: "fixed" }]),
] };
const authorization = { schema_version: "1.0", operation: "resolve-critique", project_root: "/project", run_id: "run-1", subject: "work-item:1", prior_record_id: "prior", prior_record_hash: priorHash, resolving_record_id: "resolving", resolving_record_hash: resolvingHash, expected_resolver: "reviewer-b", resolved_lane_ids: ["security"], resolved_finding_ids: ["F-1"], prior_snapshot_sha256: "c".repeat(64), resolving_snapshot_sha256: "d".repeat(64), prior_head_sha: "none", resolving_head_sha: "none", requested_at: "2030-01-01T00:00:00Z", signature: { algorithm: "ed25519", key_id: "operator", value: "signed-elsewhere" } };
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function missingOriginalResolutionFixture() {
  const original = resolveCritiqueTransition({ bundle, resolution_events: [], authorization, prior_record_id: "prior", resolving_record_id: "resolving" });
  const preservedBundle = { schema_version: original.bundle.schema_version, claims: original.bundle.claims };
  const edge = preservedBundle.claims[0].metadata.critique_resolution;
  const emptyLedger = { schema_version: "1.0", events: [] };
  const repairAuthorization = {
    schema_version: "1.0",
    operation: "repair-critique-resolution-history",
    project_root: authorization.project_root,
    run_id: authorization.run_id,
    subject: authorization.subject,
    prior_record_id: "prior",
    prior_record_hash: priorHash,
    resolving_record_id: "resolving",
    resolving_record_hash: resolvingHash,
    expected_resolver: "reviewer-b",
    prior_snapshot_sha256: authorization.prior_snapshot_sha256,
    resolving_snapshot_sha256: authorization.resolving_snapshot_sha256,
    prior_head_sha: authorization.prior_head_sha,
    resolving_head_sha: authorization.resolving_head_sha,
    preimage_bundle_sha256: sha256(preservedBundle),
    preimage_ledger_sha256: sha256(emptyLedger),
    preimage_ledger_length: 0,
    preimage_ledger_tail_hash: "0".repeat(64),
    current_completion_sha256: "e".repeat(64),
    preserved_resolution_sha256: sha256(edge),
    missing_resolution_event_id: edge.resolution_event_id,
    missing_authorization_sha256: edge.authorization_sha256,
    reason_code: "coordinator-external-ledger-overwrite-v1",
    nonce: "repair-history-once",
    requested_at: "2030-01-02T00:00:00Z",
    expires_at: "2030-01-02T00:10:00Z",
    signature: { algorithm: "ed25519", key_id: "operator", value: "signed-now" },
  };
  return { preservedBundle, edge, emptyLedger, repairAuthorization, originalEvent: original.resolution_events[0] };
}
test("runtime v1 preserves critique history and appends one authorization-bound event", () => {
  const next = resolveCritiqueTransition({ bundle, resolution_events: [], authorization, prior_record_id: "prior", resolving_record_id: "resolving" });
  assert.equal(next.bundle.claims.length, 2);
  assert.equal(next.bundle.claims[0].metadata.superseded_by, "resolving");
  assert.equal(next.bundle.claims[0].status, "superseded");
  assert.equal(next.resolution_events.length, 1);
  assert.match(next.resolution_events[0].event_id, /^critique-resolution:[a-f0-9]{64}$/);
  assert.deepEqual(bundle.claims[0].metadata.superseded_by, undefined, "input remains immutable");
});
test("runtime v1 rejects incomplete repair coverage and same-reviewer resolution", () => {
  assert.throws(() => resolveCritiqueTransition({ bundle, resolution_events: [], authorization: { ...authorization, resolved_lane_ids: [] }, prior_record_id: "prior", resolving_record_id: "resolving" }), /exact failing critique surface/);
  const same = structuredClone(bundle); same.claims[1].metadata.reviewer = "reviewer-a";
  assert.throws(() => resolveCritiqueTransition({ bundle: same, resolution_events: [], authorization: { ...authorization, expected_resolver: "reviewer-a" }, prior_record_id: "prior", resolving_record_id: "resolving" }), /distinct/);
});

test("runtime v1 repairs only an already-superseded edge with a separately signed history-repair event", () => {
  const repairCritiqueResolutionHistoryTransition = lifecycleRuntime.repairCritiqueResolutionHistoryTransition;
  assert.equal(
    typeof repairCritiqueResolutionHistoryTransition,
    "function",
    "RED: runtime must expose a distinct pure history-repair transition rather than reconstructing an ordinary resolution event",
  );

  const { preservedBundle, edge, emptyLedger, repairAuthorization, originalEvent } = missingOriginalResolutionFixture();
  const repaired = repairCritiqueResolutionHistoryTransition({
    bundle: preservedBundle,
    resolution_events: emptyLedger.events,
    authorization: repairAuthorization,
    prior_record_id: "prior",
    resolving_record_id: "resolving",
    current_completion_sha256: repairAuthorization.current_completion_sha256,
  });
  assert.deepEqual(repaired.bundle, preservedBundle, "history repair must leave the already-superseded Trust Bundle byte-semantically unchanged");
  assert.equal(repaired.resolution_events.length, 1, "repair appends exactly one external authority event");
  const repairEvent = repaired.resolution_events[0];
  assert.equal(repairEvent.operation, "repair-critique-resolution-history");
  assert.equal(repairEvent.missing_resolution_event_id, edge.resolution_event_id);
  assert.equal(repairEvent.missing_authorization_sha256, edge.authorization_sha256);
  assert.deepEqual(repairEvent.edge, edge, "repair must witness the preserved historical edge exactly");
  assert.equal(repairEvent.predecessor_hash, "0".repeat(64));
  assert.equal(repaired.bundle.claims[0].metadata.critique_resolution.resolution_event_id, edge.resolution_event_id, "repair does not rewrite the preserved resolution edge");

  assert.doesNotThrow(
    () => repairCritiqueResolutionHistoryTransition({
      bundle: preservedBundle,
      resolution_events: emptyLedger.events,
      authorization: { ...repairAuthorization, preimage_bundle_sha256: "f".repeat(64) },
      prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256,
    }),
    "the pure transition must leave exact raw-byte preimage verification to the coordinator",
  );

  assert.throws(
    () => repairCritiqueResolutionHistoryTransition({
      bundle: preservedBundle,
      resolution_events: [originalEvent],
      authorization: {
        ...repairAuthorization,
        preimage_ledger_sha256: sha256({ schema_version: "1.0", events: [originalEvent] }),
        preimage_ledger_length: 1,
        preimage_ledger_tail_hash: originalEvent.event_hash,
      },
      prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256,
    }),
    /original event|already present/i,
    "an original event cannot be reconstructed or repaired when it is already present",
  );
  assert.throws(
    () => repairCritiqueResolutionHistoryTransition({
      bundle: preservedBundle,
      resolution_events: repaired.resolution_events,
      authorization: {
        ...repairAuthorization,
        preimage_ledger_sha256: sha256({ schema_version: "1.0", events: repaired.resolution_events }),
        preimage_ledger_length: repaired.resolution_events.length,
        preimage_ledger_tail_hash: repaired.resolution_events.at(-1).event_hash,
      },
      prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256,
    }),
    /repair.*already exists|duplicate/i,
    "exactly one repair event may cover a missing original edge",
  );
  const altered = structuredClone(preservedBundle);
  altered.claims[0].metadata.critique_resolution.resolved_at = "2031-01-01T00:00:00Z";
  assert.throws(
    () => repairCritiqueResolutionHistoryTransition({ bundle: altered, resolution_events: emptyLedger.events, authorization: { ...repairAuthorization, preimage_bundle_sha256: sha256(altered) }, prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256 }),
    /preserved.*edge|resolution.*digest/i,
    "a repair cannot mutate the original edge, timestamp, or edge digest",
  );
  for (const [field, value] of Object.entries({
    current_completion_sha256: "f".repeat(64), prior_snapshot_sha256: "f".repeat(64), subject: "work-item:other", expected_resolver: "reviewer-c", missing_resolution_event_id: "critique-resolution:missing",
  })) {
    assert.throws(
      () => repairCritiqueResolutionHistoryTransition({ bundle: preservedBundle, resolution_events: emptyLedger.events, authorization: { ...repairAuthorization, [field]: value }, prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256 }),
      /bind|digest|subject|resolver|event/i,
      `repair authorization rejects a wrong ${field}`,
    );
  }
  assert.throws(
    () => repairCritiqueResolutionHistoryTransition({ bundle: preservedBundle, resolution_events: [{ event_id: "bad", sequence: 2, predecessor_hash: "wrong", event_hash: "invalid" }], authorization: repairAuthorization, prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256 }),
    /chain|ledger|event/i,
    "a repair refuses an invalid external event chain before append",
  );
  const forgedAuthorizationEvent = structuredClone(originalEvent);
  forgedAuthorizationEvent.signed_authorization.project_root = "/other-project";
  forgedAuthorizationEvent.authorization_sha256 = sha256(forgedAuthorizationEvent.signed_authorization);
  forgedAuthorizationEvent.event_id = `critique-resolution:${forgedAuthorizationEvent.authorization_sha256}`;
  forgedAuthorizationEvent.edge.resolution_event_id = forgedAuthorizationEvent.event_id;
  forgedAuthorizationEvent.edge.authorization_sha256 = forgedAuthorizationEvent.authorization_sha256;
  const { event_hash: _forgedHash, ...forgedUnsigned } = forgedAuthorizationEvent;
  forgedAuthorizationEvent.event_hash = sha256(forgedUnsigned);
  assert.throws(
    () => repairCritiqueResolutionHistoryTransition({
      bundle: preservedBundle, resolution_events: [forgedAuthorizationEvent],
      authorization: { ...repairAuthorization, preimage_ledger_sha256: sha256({ schema_version: "1.0", events: [forgedAuthorizationEvent] }), preimage_ledger_length: 1, preimage_ledger_tail_hash: forgedAuthorizationEvent.event_hash },
      prior_record_id: "prior", resolving_record_id: "resolving", current_completion_sha256: repairAuthorization.current_completion_sha256,
    }),
    /project binding/i,
    "a coherently rehashed event still cannot replace its signed project-bound authority",
  );
  assert.throws(
    () => resolveCritiqueTransition({ bundle: preservedBundle, resolution_events: [], authorization, prior_record_id: "prior", resolving_record_id: "resolving" }),
    /already superseded|uncovered.*repair/i,
    "ordinary resolution cannot silently stand in for explicit history repair",
  );
});
