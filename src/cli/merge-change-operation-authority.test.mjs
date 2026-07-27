import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAuthenticatedMergeChangeObservation,
  assertIssuedMergeChangeAction,
  assertMergeChangeAuthorization,
  buildUnsignedMergeChangeAuthorization,
  issueMergeChangeAction,
} from "../../build/src/merge-change-operation-authority.js";
import { resultDigestClaimedByCanonicalRun } from "../../build/src/cli/merge-change.js";

const SHA = "a".repeat(40);
const provider = { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" };
const binding = { run_id: "kontourai-flow-agents-1000", definition_id: "builder.build", definition_version: "1.3", step_id: "done", gate_ids: ["learn-gate"], gate_visit_id: "f".repeat(64) };

function action(overrides = {}) {
  return issueMergeChangeAction({ binding, provider, assignment_actor: "codex:1000:Kontour", expected_provider_actor: "fixture", intent: { strategy: "squash", change_number: 1000, base_ref: "main", head_ref: "fix/terminal-before-merge-1000", terminal_head_sha: SHA, ...overrides } });
}

test("exact terminal merge authority binds strategy, immutable head, provider configuration, and assignment", () => {
  const issued = action();
  assert.equal(assertIssuedMergeChangeAction(issued).intent.terminal_head_sha, SHA);
  assert.throws(() => assertIssuedMergeChangeAction({ ...issued, intent: { ...issued.intent, terminal_head_sha: "b".repeat(40) } }), /action_id/);
  assert.throws(() => action({ strategy: "unsafe" }), /unsupported/);
});

test("signed merge authorization binds the complete issued action, Flow identity, nonce, and expiry", () => {
  const issued = action();
  const prepared = buildUnsignedMergeChangeAuthorization({
    project_root: "/project", run_id: binding.run_id, subject: "kontourai/flow-agents#1000",
    flow_definition_id: binding.definition_id, flow_definition_version: binding.definition_version,
    flow_definition_digest: "b".repeat(64), flow_run_head: "c".repeat(64), flow_manifest_sha256: "d".repeat(64),
    issued_action: issued, nonce: "single-use-nonce", requested_at: "2026-07-27T00:00:00.000Z", expires_at: "2026-07-27T00:10:00.000Z",
  });
  const signed = { ...prepared.unsigned, signature: { algorithm: "ed25519", key_id: "operator", value: "fixture" } };
  assert.equal(assertMergeChangeAuthorization(signed).issued_action.action_id, issued.action_id);
  assert.throws(() => assertMergeChangeAuthorization({ ...signed, issued_action: { ...issued, intent: { ...issued.intent, strategy: "rebase" } } }), /issued_action_sha256|action_id/);
  assert.match(prepared.signingPayload, /expected_provider_actor/);
});

test("all supported strategies remain explicit, bounded authority choices", () => {
  for (const strategy of ["squash", "rebase", "merge-commit", "merge-queue"]) {
    assert.equal(action({ strategy }).intent.strategy, strategy);
  }
});

test("merge observations reject a changed head, provider, or incomplete queued result", () => {
  const issued = action();
  const observation = {
    schema_version: "1.0", operation: "merge-change", binding, repository: { owner: "kontourai", name: "flow-agents" }, intent: issued.intent,
    provider: { kind: "github", configuration_id: issued.provider.configuration_id, adapter: "github-gh-cli" }, assignment_actor: issued.assignment_actor,
    provider_actor: "fixture", state: "merged", merge_sha: "c".repeat(40), observed_at: "2026-07-26T00:00:00.000Z",
  };
  assert.equal(assertAuthenticatedMergeChangeObservation(issued, observation).state, "merged");
  assert.throws(() => assertAuthenticatedMergeChangeObservation(issued, { ...observation, provider_actor: "different-fixture" }), /expected provider actor/);
  assert.throws(() => assertAuthenticatedMergeChangeObservation(issued, { ...observation, intent: { ...observation.intent, terminal_head_sha: "b".repeat(40) } }), /does not match/);
  assert.throws(() => assertAuthenticatedMergeChangeObservation(issued, { ...observation, state: "queued" }), /must be absent/);
});

test("public package exports cannot construct or execute a merge outside the session-bound CLI operation", async () => {
  const api = await import("@kontourai/flow-agents");
  for (const name of ["issueMergeChangeAction", "assertIssuedMergeChangeAction", "assertAuthenticatedMergeChangeObservation", "executeMergeChangeProvider"]) {
    assert.equal(name in api, false, `${name} must not be a public mutation bypass`);
  }
});

test("canonical completed-run evidence authenticates the publish action identity and exact result digest", () => {
  const publishedAction = "a".repeat(64);
  const digest = "b".repeat(64);
  const observation = {
    schema_version: "1.0", operation: "publish-change", binding, repository: { owner: "kontourai", name: "flow-agents" },
    provider: { kind: "github", configuration_id: issueMergeChangeAction({ binding, provider, assignment_actor: "codex:1000:Kontour", expected_provider_actor: "fixture", intent: { strategy: "squash", change_number: 1000, base_ref: "main", head_ref: "fix/terminal-before-merge-1000", terminal_head_sha: SHA } }).provider.configuration_id, adapter: "github-gh-cli" },
    change_ref: { provider_record_id: "PR_fixture", number: 1000, url: "https://github.com/kontourai/flow-agents/pull/1000", state: "open", base_ref: "main", head_ref: "fix/terminal-before-merge-1000", head_sha: SHA }, assignment_actor: "codex:1000:Kontour", provider_actor: "fixture", observed_at: "2026-07-26T00:00:00.000Z",
  };
  const summary = `Authenticated publish-change operation ${publishedAction} observed open provider record PR_fixture`;
  const manifest = { run_id: binding.run_id, definition_id: binding.definition_id, definition_version: binding.definition_version, evidence: [{ gate_id: binding.gate_ids[0], producer: "publish-change-operation-authority", authority_trace: publishedAction, expectation_ids: ["pull-request-opened"], bundle: { claims: [{ fieldOrBehavior: summary, metadata: { artifact_refs: [{ kind: "provider", sha256: digest }] } }] } }] };
  assert.equal(resultDigestClaimedByCanonicalRun(manifest, publishedAction, observation, digest, binding, binding.run_id), true);
  assert.equal(resultDigestClaimedByCanonicalRun(manifest, "c".repeat(64), observation, digest, binding, binding.run_id), false, "an action id not recorded as authority_trace is unauthenticated");
  assert.equal(resultDigestClaimedByCanonicalRun(manifest, publishedAction, observation, "c".repeat(64), binding, binding.run_id), false, "a result whose bytes do not match the canonical provider artifact digest is unauthenticated");
  assert.equal(resultDigestClaimedByCanonicalRun({ ...manifest, run_id: "other-run" }, publishedAction, observation, digest, binding, binding.run_id), false, "cross-run evidence is unauthenticated");
});
