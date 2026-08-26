import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { amendRunDefinition, definitionDigest, definitionIdentity, flowRunHead, loadRun, startRun } from "@kontourai/flow";
import { main as mergeChangeMain } from "../../build/src/cli/merge-change.js";
import { issueMergeChangeAction } from "../../build/src/merge-change-operation-authority.js";
import { issuePublishChangeAction } from "../../build/src/publish-change-operation-authority.js";
import { performLocalClaim, resolveCurrentAssignmentActor } from "../../build/src/cli/assignment-provider.js";
import { resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const SHA = "a".repeat(40);
const provider = { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" };
const binding = { run_id: "merge-transaction-fixture", definition_id: "builder.build", definition_version: "1.3", step_id: "done", gate_ids: ["learn-gate"], gate_visit_id: "f".repeat(64) };

function action(terminalHead = SHA, overrides = {}) {
  return issueMergeChangeAction({
    binding,
    provider,
    assignment_actor: overrides.assignment_actor ?? "codex:fixture:Kontour",
    expected_provider_actor: "fixture",
    intent: { strategy: overrides.strategy ?? "squash", change_number: 1000, base_ref: "main", head_ref: "fixture", terminal_head_sha: terminalHead },
  });
}

function mergedObservation(issued, observedAt) {
  return {
    schema_version: "1.0",
    operation: "merge-change",
    binding: issued.binding,
    repository: issued.repository,
    intent: issued.intent,
    provider: { kind: "github", configuration_id: issued.provider.configuration_id, adapter: "github-gh-cli" },
    assignment_actor: issued.assignment_actor,
    provider_actor: "fixture",
    state: "merged",
    merge_sha: "c".repeat(40),
    observed_at: observedAt,
  };
}

function fixtureSession() {
  const root = makeFixtureDir("flow-agents-merge-transaction-");
  const sessionDir = path.join(root, ".kontourai", "flow-agents", binding.run_id);
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, lockDir: path.join(root, ".kontourai", "flow-agents", "assignment", `.${binding.run_id}.lockdir`) };
}

async function runExecute(sessionDir, dependencies) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await mergeChangeMain(["execute", "--session-dir", sessionDir, "--strategy", "squash", "--authorization-file", path.join(sessionDir, "signed-merge-authorization.json")], {
      authorizeOperation: (_context, issued) => ({ run_id: binding.run_id, operation_status: "applied", authorized_action_id: issued.action_id, completion: {} }),
      ...dependencies,
    });
  } finally {
    console.error = originalError;
  }
}

test("session-bound merge execution holds its subject lock across provider mutation and revalidates afterward", async () => {
  const fixture = fixtureSession();
  const issued = action();
  const changed = action("b".repeat(40));
  let actionReads = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => (++actionReads === 1 ? issued : changed),
      executeProvider: async () => {
        assert.equal(fs.existsSync(fixture.lockDir), true, "provider mutation must remain under the session subject lock");
        return mergedObservation(issued, "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 1);
    assert.equal(actionReads, 2, "the action must be re-derived after provider mutation");
    assert.equal(fs.existsSync(path.join(fixture.sessionDir, "merge-change.result.json")), false, "a changed action must not persist the provider result");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution reobserves a forged persisted merged result", async () => {
  const fixture = fixtureSession();
  const issued = action();
  let providerCalls = 0;
  try {
    // This payload has a valid action id and valid observation shape, so only a
    // fresh authenticated provider read can distinguish it from a real replay.
    fs.writeFileSync(path.join(fixture.sessionDir, "merge-change.result.json"), `${JSON.stringify({ action: issued, observation: mergedObservation(issued, "2026-07-26T00:00:00.000Z") })}\n`);
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => issued,
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(issued, "2026-07-26T00:01:00.000Z");
      },
    });
    assert.equal(result, 0);
    assert.equal(providerCalls, 1, "persisted merged state is not merge authority");
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.sessionDir, "merge-change.result.json"), "utf8"));
    assert.equal(persisted.observation.observed_at, "2026-07-26T00:01:00.000Z", "only the fresh provider observation is persisted");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution refuses terminal validation before provider invocation", async () => {
  const fixture = fixtureSession();
  let providerCalls = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => { throw new Error("terminal delivery refused"); },
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(action(), "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 1);
    assert.equal(providerCalls, 0, "terminal refusal must happen before provider invocation");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session-bound merge execution refuses replayed authority before provider mutation", async () => {
  const fixture = fixtureSession();
  const issued = action();
  let providerCalls = 0;
  try {
    const result = await runExecute(fixture.sessionDir, {
      provider,
      currentAction: async () => issued,
      authorizeOperation: (_context, observed, file) => {
        assert.equal(fs.existsSync(fixture.lockDir), true, "authority consumption must occur under the subject lock");
        assert.equal(observed.action_id, issued.action_id);
        assert.match(file, /signed-merge-authorization\.json$/);
        return { run_id: binding.run_id, operation_status: "replayed", authorized_action_id: observed.action_id, completion: {} };
      },
      executeProvider: async () => {
        providerCalls += 1;
        return mergedObservation(issued, "2026-07-26T00:00:00.000Z");
      },
    });
    assert.equal(result, 1);
    assert.equal(providerCalls, 0, "consumed authority cannot authorize another provider mutation");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("merge execution requires a signed authorization before it can reach the provider", async () => {
  const fixture = fixtureSession();
  let providerCalls = 0;
  try {
    const originalError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await mergeChangeMain(["execute", "--session-dir", fixture.sessionDir, "--strategy", "squash"], {
        provider,
        currentAction: async () => action(),
        executeProvider: async () => { providerCalls += 1; return mergedObservation(action(), "2026-07-26T00:00:00.000Z"); },
      });
    } finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.equal(providerCalls, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, current] of [
  ["action", action("b".repeat(40))],
  ["strategy", action(SHA, { strategy: "rebase" })],
  ["assignment", action(SHA, { assignment_actor: "codex:replacement:Kontour" })],
]) {
  test(`replayed lifecycle authorization cannot authorize ${label} drift`, async () => {
    const fixture = fixtureSession();
    const originallyAuthorized = action();
    let providerCalls = 0;
    try {
      const result = await runExecute(fixture.sessionDir, {
        provider,
        currentAction: async () => current,
        authorizeOperation: () => ({ run_id: binding.run_id, operation_status: "replayed", authorized_action_id: originallyAuthorized.action_id, completion: {} }),
        executeProvider: async () => { providerCalls += 1; return mergedObservation(current, "2026-07-26T00:00:00.000Z"); },
      });
      assert.equal(result, 1);
      assert.equal(providerCalls, 0, "a replay for another action must not reach the provider");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("public merge-change request accepts effective amended bindings while retaining the start-bound manifest", async () => {
  const root = makeFixtureDir("flow-agents-merge-amended-request-");
  const slug = "amended-merge-request";
  const artifactRoot = path.join(root, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  const subject = "kontourai/flow-agents#1000";
  const run = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    run(["init", "-b", "main"]);
    run(["config", "user.email", "fixture@example.test"]);
    run(["config", "user.name", "Merge Fixture"]);
    run(["remote", "add", "origin", "https://github.com/kontourai/flow-agents.git"]);
    fs.writeFileSync(path.join(root, ".gitignore"), ".kontourai/\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ repository: "https://github.com/kontourai/flow-agents.git" }));
    fs.mkdirSync(path.join(root, "context", "settings"), { recursive: true });
    fs.writeFileSync(path.join(root, "context", "settings", "change-provider-settings.json"), JSON.stringify({
      schema_version: "1.0",
      projects: [{
        project: { repo: { owner: "kontourai", name: "flow-agents" } },
        provider: { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" },
      }],
    }));
    run(["add", "."]);
    run(["commit", "-m", "fixture"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({
      schema_version: "1.0", task_slug: slug, status: "delivered", phase: "release", updated_at: "2026-07-27T12:00:00.000Z",
      work_item_refs: [subject], next_action: { status: "done", summary: "Fixture." },
    }));
    const effectiveDefinition = resolveEffectiveFlowDefinition("builder.build", process.cwd(), { allowOverride: false });
    assert.ok(effectiveDefinition, "the fixture requires the packaged Builder definition");
    const startDefinition = structuredClone(effectiveDefinition);
    startDefinition.version = "1.3-amended-request-fixture";
    const startDefinitionFile = path.join(root, ".kontourai", "builder.build.start.json");
    fs.writeFileSync(startDefinitionFile, JSON.stringify(startDefinition));
    await startRun(startDefinitionFile, { cwd: root, runId: slug, params: { subject } });
    const beforeAmendment = await loadRun(slug, root);
    await amendRunDefinition(slug, {
      cwd: root,
      definition: effectiveDefinition,
      request: {
        reason: "adopt Builder 1.4 evidence-refresh controls",
        expected_run_head: flowRunHead(beforeAmendment.state),
        expected_definition: definitionIdentity(startDefinition),
        successor_digest: definitionDigest(effectiveDefinition),
        authority: { kind: "user_request", actor: "merge-change-test", request_ref: "test:amended-merge-request", requested_at: "2026-07-27T12:00:00.000Z" },
      },
    });
    const flowDir = path.join(root, ".kontourai", "flow", "runs", slug);
    const stateFile = path.join(flowDir, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const amendedAt = state.definition_amendments[0].at;
    state.status = "completed";
    state.current_step = "done";
    state.gate_outcome_history = [{ gate_id: "verify-gate", status: "pass", summary: "Refreshed verification after amendment.", evidence_refs: [], transition_validation: { transition: { at: new Date(Date.parse(amendedAt) + 1_000).toISOString() } } }];
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const actor = resolveCurrentAssignmentActor();
    performLocalClaim(artifactRoot, slug, actor.actor, { ttlSeconds: 1_800, actorKey: actor.actorKey, branch: "main", artifactDir: slug, workItemRef: subject, reason: "fixture" });
    const provider = { role: "ChangeProvider", kind: "github", repository: { owner: "kontourai", name: "flow-agents" }, capabilities: ["change.create", "change.observe", "change.merge"], executor: "gh-cli" };
    const publishBinding = { run_id: slug, definition_id: "builder.build", definition_version: effectiveDefinition.version, step_id: "pr-open", gate_ids: ["builder.publish-learn:pr-open-gate"], gate_visit_id: "f".repeat(64) };
    const issued = issuePublishChangeAction({ binding: publishBinding, provider, assignment_actor: actor.actorKey, intent: { title: "Fixture", body: "Fixture", base_ref: "main", head_ref: "main", head_sha: head } });
    const observation = {
      schema_version: "1.0", operation: "publish-change", binding: publishBinding, repository: provider.repository,
      provider: { kind: "github", configuration_id: issued.provider.configuration_id, adapter: "fixture" },
      change_ref: { provider_record_id: "PR_fixture", number: 1000, url: "https://github.com/kontourai/flow-agents/pull/1000", state: "open", base_ref: "main", head_ref: "main", head_sha: head },
      assignment_actor: actor.actorKey, provider_actor: "fixture", observed_at: "2026-07-27T12:00:02.000Z",
    };
    const publishResult = { ...observation, operation_action_id: issued.action_id };
    const publishResultBytes = Buffer.from(JSON.stringify(publishResult));
    fs.writeFileSync(path.join(sessionDir, "publish-change.result.json"), publishResultBytes);
    const manifestFile = path.join(flowDir, "evidence", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const summary = `Authenticated publish-change operation ${issued.action_id} observed open provider record PR_fixture`;
    // This fixture hand-writes the manifest (including the legacy flat
    // `authority_trace` field) rather than going through a real Flow 5.x
    // attachEvidence call; that's fine here because this test isn't exercising
    // authority-trace authentication at all — it's plumbing to reach the
    // *later* terminal-delivery validation step in merge-change request. Flow
    // 5.x's real write path can no longer produce `authority_trace` (see
    // builder-flow-runtime.test.mjs's authorityTrace-option-removed test); the
    // legacy field here still round-trips because
    // resultDigestClaimedByCanonicalRun deliberately keeps recognizing it as a
    // backward-compatibility fallback (merge-change.ts).
    manifest.evidence.push({
      id: "publish-change-fixture", gate_id: publishBinding.gate_ids[0], kind: "custom", requested_kind: "custom", status: "passed", attached_at: "2026-07-27T12:00:03.000Z",
      producer: "publish-change-operation-authority", authority_trace: issued.action_id, expectation_ids: ["pull-request-opened"],
      bundle: {
        schemaVersion: 5,
        source: "merge-change-test",
        claims: [{
          fieldOrBehavior: summary,
          metadata: { artifact_refs: [{ kind: "provider", sha256: createHash("sha256").update(publishResultBytes).digest("hex") }] },
        }],
        evidence: [],
        policies: [],
        events: [],
      },
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    const errors = [];
    const originalError = console.error;
    console.error = (...values) => errors.push(values.join(" "));
    let result;
    try {
      result = await mergeChangeMain(["request", "--session-dir", sessionDir, "--strategy", "squash", "--out", path.join(root, "unsigned.json")]);
    } finally { console.error = originalError; }
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /exactly the canonical session terminal bundle/i, "the public request reached terminal-delivery validation after accepting the amended effective definition and start-bound manifest");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evidence-refresh route predicate accepts the SHIPPED builder definition and refuses missing refresh entries (#1300)", async () => {
  // #1300 shipped because the old two-key deep-equal literal had zero coverage against the real
  // kit map — a fixture-vs-reality gap. Bind the predicate to the RESOLVED effective definition
  // so any future divergence between merge-change and the flow definition reds here first.
  const { evidenceRefreshRoutesSatisfied } = await import("../../build/src/cli/merge-change.js");
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const definition = resolveEffectiveFlowDefinition("builder.build", repoRoot);
  assert.ok(definition);
  const shipped = definition.gates["builder.publish-learn:merge-ready-ci-gate"];
  assert.equal(evidenceRefreshRoutesSatisfied(shipped), true, "the kit's own shipped three-key map must satisfy merge-change");
  // additional repair routes are the flow definition's business
  assert.equal(evidenceRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify", default: "verify" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), true);
  // but the refresh entries themselves are non-negotiable
  assert.equal(evidenceRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), false);
  assert.equal(evidenceRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify", default: "execute" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), false);
  assert.equal(evidenceRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify", default: "verify" }, route_back_policy: { max_attempts: 3, on_exceeded: "warn" } }), false);
  assert.equal(evidenceRefreshRoutesSatisfied({}), false);
});

test("start-definition provenance derives when the stamp is absent and refuses a mismatched stamp (#1307)", async () => {
  // @kontourai/flow has never written state.definition_digest (absent in every measured run
  // state; zero references in the flow dist). Demanding it failed EVERY unamended run — the
  // wedge stacked directly behind #1300, hit live by the first run to get past it (PR #1303).
  const { assertEvidenceRefreshVerificationProvenance } = await import("../../build/src/cli/merge-change.js");
  const digest = "d".repeat(64);
  // absent stamp: the identity is already proven by the caller's deep-equal — accepted
  assert.doesNotThrow(() => assertEvidenceRefreshVerificationProvenance({}, "builder.build", "1.4", digest));
  // present and matching — accepted
  assert.doesNotThrow(() => assertEvidenceRefreshVerificationProvenance({ definition_digest: digest }, "builder.build", "1.4", digest));
  // present but MISMATCHED — refused (a stamp that exists must be true)
  assert.throws(
    () => assertEvidenceRefreshVerificationProvenance({ definition_digest: "e".repeat(64) }, "builder.build", "1.4", digest),
    /start-definition proof/,
  );
});

test("the coordinator's route-map predicate accepts the SHIPPED definition semantically (#1307)", async () => {
  // The coordinator carried the THIRD independent encoding of this contract. Its check is now an
  // exported pure predicate driven here with the REAL resolved definition — semantic conformance,
  // not text-grepping (review round: greps are refactor-fragile and regression-evadable).
  const { mergeReadyCiRefreshRoutesSatisfied } = await import("../../packaging/lifecycle-authority/coordinator.mjs");
  const definition = resolveEffectiveFlowDefinition("builder.build", path.resolve(import.meta.dirname, "../.."));
  assert.ok(definition);
  const shipped = definition.gates["builder.publish-learn:merge-ready-ci-gate"];
  assert.equal(mergeReadyCiRefreshRoutesSatisfied(shipped), true, "the kit's own shipped map must satisfy the coordinator");
  assert.equal(mergeReadyCiRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify", default: "verify" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), true);
  assert.equal(mergeReadyCiRefreshRoutesSatisfied({ on_route_back: { missing_evidence: "verify" }, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), false);
  assert.equal(mergeReadyCiRefreshRoutesSatisfied({ on_route_back: null, route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), false);
  assert.equal(mergeReadyCiRefreshRoutesSatisfied({ on_route_back: ["verify"], route_back_policy: { max_attempts: 3, on_exceeded: "block" } }), false);
  assert.equal(mergeReadyCiRefreshRoutesSatisfied(null), false);
  assert.equal(mergeReadyCiRefreshRoutesSatisfied(undefined), false);
  // supplemental policy grep (kept per review guidance): no unconditional stamp demand remains
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../../packaging/lifecycle-authority/coordinator.mjs", import.meta.url), "utf8");
  const demanding = source.match(/if \(state\.definition_digest !== definitionDigest\)/g) ?? [];
  assert.equal(demanding.length, 0, "no coordinator site may demand the stamp unconditionally");
});

// ---------------------------------------------------------------------------
// #1318 FIX-2: before this, the target-branch approval policy was discoverable
// only at `merge-change execute` — after `request` had emitted an unsigned
// authorization and an operator had signed it with a lifecycle-authority key.
// ---------------------------------------------------------------------------

function requestFixture() {
  const root = makeFixtureDir("flow-agents-merge-policy-preflight-");
  const sessionDir = path.join(root, ".kontourai", "flow-agents", binding.run_id);
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, out: path.join(root, "unsigned.json") };
}

async function runRequest(fixture, preflight) {
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values) => errors.push(values.join(" "));
  console.log = (...values) => logs.push(values.join(" "));
  try {
    const status = await mergeChangeMain(["request", "--session-dir", fixture.sessionDir, "--strategy", "squash", "--out", fixture.out], {
      provider,
      currentAction: async () => action(),
      preflightProvider: async () => preflight,
    });
    return { status, errors: errors.join("\n"), logs: logs.join("\n") };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

test("#1318: merge-change request refuses an unsatisfiable branch policy BEFORE it mints an authorization", async () => {
  const fixture = requestFixture();
  try {
    const message = "the target branch 'main' does not enforce a pull-request approval policy (required_pull_request_reviews absent); merge-change requires an enforced no-bypass approval policy on the target branch";
    const result = await runRequest(fixture, { status: "unsatisfied", base_ref: "main", condition: "approval-policy-absent", message });
    assert.equal(result.status, 1);
    assert.match(result.errors, /does not enforce a pull-request approval policy \(required_pull_request_reviews absent\)/);
    assert.match(result.errors, /refuses to mint an authorization/);
    assert.doesNotMatch(result.errors, /must be a plain object/);
    // The whole point of the fix: no authorization material exists to be signed.
    assert.equal(fs.existsSync(fixture.out), false, "no unsigned authorization may be written when the precondition fails");
    assert.equal(result.logs, "", "a refused request emits no signing payload");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("#1318: a satisfied or unverified precondition does not itself block merge-change request", async () => {
  for (const preflight of [
    { status: "satisfied", base_ref: "main" },
    { status: "unverified", base_ref: "main", reason: "provider_unavailable: configured ChangeProvider executable is unavailable" },
  ]) {
    const fixture = requestFixture();
    try {
      const result = await runRequest(fixture, preflight);
      // Both proceed past the preflight and fail later, on the canonical-session
      // checks — proving the preflight refuses a policy verdict, not everything.
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.errors, /refuses to mint an authorization/, JSON.stringify(preflight));
      assert.doesNotMatch(result.errors, /approval policy/, JSON.stringify(preflight));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
