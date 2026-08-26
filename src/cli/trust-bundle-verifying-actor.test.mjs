// trust-bundle-verifying-actor.test.mjs — #1363 / #1365 regression cover.
//
// The fold into trust.bundle used to consume two provenance distinctions and emit something
// that could not express either:
//
//   #1363  every VerificationEvent.actor was the literal "flow-agents/workflow-sidecar" and
//          every Evidence.collectedBy was a tool constant, so the verifying identity survived
//          only in flow-agents-private claim.metadata under a different key per origin
//          (recorded_by / reviewer / nothing at all). Surface's corroboration.minActors counts
//          distinct Evidence.collectedBy values on evidence carrying supportStrength "entails";
//          with tool constants and no supportStrength anywhere, it could never count anything.
//
//   #1365  metadata.observed_commands entries carried no `source`, so a process the canonical
//          writer spawned and a command a hook merely observed rendered identically — while
//          docs/decisions/writer-observed-execution.md promises that distinction is "permanent
//          and auditable".
//
// These tests assert the FOLD's output, not the private metadata: what a Surface consumer
// reading the delivered bundle can see.
//
// Run: `npm run test:unit` (also covered by evals/static/test_unit_helpers.sh).
import test from "node:test";
import assert from "node:assert/strict";

import { buildTrustBundle, validateTrustBundle, WRITER_OBSERVATION_SOURCE } from "../../build/src/cli/workflow-sidecar.js";

const TS = "2026-07-02T00:00:00Z";
const SHA = "a".repeat(64);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SNAPSHOT = { version: 1, kind: "git-worktree", algorithm: "sha256", digest: "c".repeat(64), head_sha: COMMIT, worktree_clean: true };
const TOOL_ACTOR = "flow-agents/workflow-sidecar";
const CAPTURE_COLLECTOR = "flow-agents/evidence-capture";

/**
 * A command-log line in the shape appendWriterObservedCommands really appends: clean Git
 * provenance, and the `source` attribution the decision record calls permanent. Without a
 * confirming observation a command-backed `pass` folds to not_verified and emits no event.
 */
function writerLogEntry(command, outputSha = SHA) {
  return {
    command,
    observedResult: "pass",
    exitCode: 0,
    observed_at_commit: COMMIT,
    worktree_clean: true,
    capturedAt: TS,
    source: WRITER_OBSERVATION_SOURCE,
    writer: { output_sha256: outputSha, verification_workspace_snapshot: SNAPSHOT },
  };
}

/** A gate-claim-shaped check whose command the canonical writer executed itself. */
function writerObservedCheck(overrides = {}) {
  return {
    id: "unit-tests",
    kind: "test",
    status: "pass",
    summary: "unit tests",
    command: "npm test",
    _observed_commands: [{
      command: "npm test",
      exit_code: 0,
      output_sha256: SHA,
      source: WRITER_OBSERVATION_SOURCE,
      observed_at_commit: COMMIT,
      worktree_clean: true,
      verification_workspace_snapshot: SNAPSHOT,
    }],
    ...overrides,
  };
}

function critique(overrides = {}) {
  return {
    id: "review",
    reviewer: "reviewer-beta",
    reviewed_at: TS,
    verdict: "pass",
    summary: "independent review",
    findings: [],
    lanes: [],
    review_target: { artifacts: [] },
    artifact_refs: [],
    ...overrides,
  };
}

const eventFor = (bundle, claimId) => bundle.events.find((e) => e.claimId === claimId);
const evidenceFor = (bundle, claimId) => bundle.evidence.filter((e) => e.claimId === claimId);

test("#1363 check origin: the recorded actor becomes the event actor and the evidence collector", async () => {
  const bundle = await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: "agent-alpha" })], [], [], [writerLogEntry("npm test")]);
  assert.ok(bundle, "buildTrustBundle returned null (is @kontourai/surface installed?)");

  const claim = bundle.claims.find((c) => c.metadata?.origin === "check");
  assert.ok(claim, "expected a check-origin claim");

  const event = eventFor(bundle, claim.id);
  assert.equal(event.status, "verified");
  assert.equal(event.actor, "agent-alpha", "VerificationEvent.actor must be the verifying identity, not the writing tool");

  const evidence = evidenceFor(bundle, claim.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].collectedBy, "agent-alpha", "Evidence.collectedBy must be the collecting actor, not the writing tool");
  assert.equal(evidence[0].supportStrength, "entails", "a writer-spawned process whose outcome agrees with the claim entails it");
});

test("#1365 check origin: the writer/hook execution source survives the fold onto observed_commands", async () => {
  const bundle = await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: "agent-alpha" })], [], [], [writerLogEntry("npm test")]);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "check");
  assert.equal(claim.metadata.observed_commands[0].source, "canonical-writer-execution");
  assert.equal(WRITER_OBSERVATION_SOURCE, "canonical-writer-execution", "the folded value is the command-log's own attribution");
});

test("#1363/#1365: a claim with no recorded actor and no execution source states so — no placeholder, no unearned entails", async () => {
  const check = writerObservedCheck();
  delete check._observed_commands[0].source;
  const bundle = await buildTrustBundle("actor", TS, [check], [], [], [writerLogEntry("npm test")]);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "check");

  assert.equal(eventFor(bundle, claim.id).actor, TOOL_ACTOR, "with no derived identity the event must name the writing tool, never a stand-in actor");
  const [evidence] = evidenceFor(bundle, claim.id);
  assert.equal(evidence.collectedBy, TOOL_ACTOR);
  assert.equal("supportStrength" in evidence, false, "an observation of unknown origin must not be marked entails");
  assert.equal("source" in claim.metadata.observed_commands[0], false, "a sourceless observation (e.g. restored from a pre-fix bundle) must not be given one");
});

test("#1363: an unresolved actor key is not an identity", async () => {
  for (const unresolved of ["", "   ", "local", "LOCAL"]) {
    const bundle = await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: unresolved })], [], [], [writerLogEntry("npm test")]);
    const claim = bundle.claims.find((c) => c.metadata?.origin === "check");
    assert.equal(eventFor(bundle, claim.id).actor, TOOL_ACTOR, `"${unresolved}" must not be recorded as a verifier`);
    assert.equal(evidenceFor(bundle, claim.id)[0].collectedBy, TOOL_ACTOR);
  }
});

test("#1365: a hook-captured observation keeps the capture collector and earns no entails", async () => {
  const check = { id: "unit-tests", kind: "test", status: "fail", summary: "unit tests", command: "npm test", _recorded_by: "agent-alpha" };
  const commandLog = [{ command: "npm test", observedResult: "fail", exitCode: 1, capturedAt: TS, source: "postToolUse-capture" }];
  const bundle = await buildTrustBundle("actor", TS, [check], [], [], commandLog);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "check");

  const [evidence] = evidenceFor(bundle, claim.id);
  assert.equal(evidence.collectedBy, CAPTURE_COLLECTOR, "the hook collected this, not the recording actor");
  assert.equal("supportStrength" in evidence, false, "a hook capture is a materially weaker claim about who chose what to run");
});

test("#1363 critique origin: the reviewer becomes the event actor", async () => {
  const bundle = await buildTrustBundle("actor", TS, [], [], [critique()]);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "critique");
  assert.ok(claim, "expected a critique-origin claim");
  assert.equal(eventFor(bundle, claim.id).actor, "reviewer-beta");
});

test("#1363: the DEFAULT reviewer string is not a verifier — a review nobody claimed names no actor", async () => {
  // record-critique defaults --reviewer to "tool-code-reviewer", and three further sites re-apply
  // that default (import-critique, the bundle restore, and the fold itself), so metadata.reviewer
  // is never absent. Publishing it as the event actor would assert a real agent in this ecosystem
  // as the verifier of a review nobody claimed — the exact false provenance #1363 exists to stop.
  const bundle = await buildTrustBundle("actor", TS, [], [], [critique({ reviewer: "tool-code-reviewer" })]);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "critique");
  assert.equal(claim.metadata.reviewer, "tool-code-reviewer", "the recorded string is preserved in metadata — only the derived field abstains");
  assert.equal(eventFor(bundle, claim.id).actor, TOOL_ACTOR);

  // Same for a critique whose reviewer field is missing entirely (the fold re-defaults it).
  const missing = critique();
  delete missing.reviewer;
  const bundle2 = await buildTrustBundle("actor", TS, [], [], [missing]);
  const claim2 = bundle2.claims.find((c) => c.metadata?.origin === "critique");
  assert.equal(eventFor(bundle2, claim2.id).actor, TOOL_ACTOR);
});

test("#1363: `entails` is never asserted on nobody's authority", async () => {
  // "No verifier was recorded" and "this evidence entails the claim" cannot both be true of one
  // item — and corroboration counts (collectedBy, entails) pairs, so an entailing item collected
  // by the tool constant would let the TOOL be counted as a distinct actor.
  const noActor = await buildTrustBundle("actor", TS, [writerObservedCheck()], [], [], [writerLogEntry("npm test")]);
  const claim = noActor.claims.find((c) => c.metadata?.origin === "check");
  const [evidence] = evidenceFor(noActor, claim.id);
  assert.equal(evidence.collectedBy, TOOL_ACTOR);
  assert.equal("supportStrength" in evidence, false, "a writer observation with no named collector must not be marked entails");

  for (const b of [noActor, await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: "agent-alpha" })], [], [critique()], [writerLogEntry("npm test")])]) {
    assert.equal(
      b.evidence.some((e) => e.supportStrength === "entails" && e.collectedBy === TOOL_ACTOR),
      false,
      "no entailing evidence may carry the tool constant as its collector",
    );
  }
});

test("#1363: reviewer-vs-implementer is now visible in the delivered bundle, not only in private metadata", async () => {
  const bundle = await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: "agent-alpha" })], [], [critique()], [writerLogEntry("npm test")]);
  const actors = new Set(bundle.events.filter((e) => e.status === "verified").map((e) => e.actor));
  assert.deepEqual([...actors].sort(), ["agent-alpha", "reviewer-beta"],
    "before the fix both events read 'flow-agents/workflow-sidecar' and an independent critique was indistinguishable from a self-recorded check");
});

test("#1363: distinct-collector counting has a real input — and same-actor evidence does not inflate it", async () => {
  // Surface counts distinct collectedBy over supportStrength "entails" evidence per claim
  // (evaluateCorroboration). That counter is reached from an InquiryRecord claim requirement, NOT
  // from a VerificationPolicy, and this change does not enable it anywhere — see the PR for why
  // minActors:2 is in fact unsatisfiable for every claim this producer emits today. What is
  // asserted here is only that the input is now populated and is counted per ACTOR: two
  // observations run by ONE actor remain one actor, so no such threshold could ever be met by
  // volume of evidence.
  const twoCommands = writerObservedCheck({
    _recorded_by: "agent-alpha",
    _observed_commands: [
      { command: "npm test", exit_code: 0, output_sha256: SHA, source: WRITER_OBSERVATION_SOURCE, observed_at_commit: COMMIT, worktree_clean: true, verification_workspace_snapshot: SNAPSHOT },
      { command: "npm run lint", exit_code: 0, output_sha256: "b".repeat(64), source: WRITER_OBSERVATION_SOURCE, observed_at_commit: COMMIT, worktree_clean: true, verification_workspace_snapshot: SNAPSHOT },
    ],
  });
  const bundle = await buildTrustBundle("actor", TS, [twoCommands], [], [], [writerLogEntry("npm test"), writerLogEntry("npm run lint", "b".repeat(64))]);
  const claim = bundle.claims.find((c) => c.metadata?.origin === "check");
  const evidence = evidenceFor(bundle, claim.id);

  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((e) => e.supportStrength === "entails"));
  const distinctActors = new Set(evidence.filter((e) => e.supportStrength === "entails").map((e) => e.collectedBy));
  assert.equal(distinctActors.size, 1, "two commands run by one actor are one actor — minActors:2 must not be satisfiable by volume");
});

test("#1363/#1365: the augmented bundle still validates against Surface's schemas", async () => {
  const bundle = await buildTrustBundle("actor", TS, [writerObservedCheck({ _recorded_by: "agent-alpha" })], [], [critique()], [writerLogEntry("npm test")]);
  const { valid, errors, available } = await validateTrustBundle(bundle);
  assert.equal(available, true, "Surface validation must be available for this assertion to mean anything");
  assert.equal(valid, true, `validateTrustBundle rejected the bundle: ${JSON.stringify(errors)}`);
});
