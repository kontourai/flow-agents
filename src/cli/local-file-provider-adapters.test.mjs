import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createLocalFileAssignmentProvider,
  createLocalFileMutationProvider,
} from "../../build/src/cli/local-file-provider-adapters.js";
import { parseWorkItemMutationRequest } from "../../build/src/lib/work-item-mutations.js";
// Also import from the package's own root entry (self-reference resolution via package.json
// "name" + "exports"), mirroring work-item-vocabulary.test.mjs's guard against the src/index.ts
// re-export silently drifting from the internal module (#775 precedent).
import {
  createLocalFileAssignmentProvider as createLocalFileAssignmentProviderFromPackageRoot,
  createLocalFileMutationProvider as createLocalFileMutationProviderFromPackageRoot,
} from "@kontourai/flow-agents";

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-interfaces-adapter-"));
  try {
    const result = run(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const ACTOR_A = { runtime: "claude-code", session_id: "session-a", host: "host-a", human: null };
const ACTOR_B = { runtime: "claude-code", session_id: "session-b", host: "host-a", human: null };

const CLAIM_META = { ttlSeconds: 1800, branch: "agent/session-a/subject-1", artifactDir: ".kontourai/flow-agents/subject-1" };

// ─── #777 implementability proof: createLocalFileAssignmentProvider formally satisfies
// `AssignmentProvider & LocalAssignmentProviderExt` (the `satisfies` annotation in
// local-file-provider-adapters.ts is the type-level half, gated by `npm run typecheck`; these
// tests are the behavioral half). ─────────────────────────────────────────────

test("createLocalFileAssignmentProvider (neutral AssignmentProvider surface): claim/release/supersede return void (ADR 0021 §2) — callers re-read via status()", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProvider(dir);

    const claimReturn = provider.claim("subject-1", ACTOR_A, CLAIM_META);
    assert.equal(claimReturn, undefined, "the neutral claim() must return void, not the written record (#777 review finding 1)");

    const status = provider.status("subject-1");
    assert.equal(status.provider, "local-file");
    assert.equal(status.subject_id, "subject-1");
    assert.ok(status.assignee, "status().assignee should be the serialized holder actor key");
    assert.equal(status.record.subject_id, "subject-1");
    assert.deepEqual(status.record.actor, ACTOR_A);

    // A different actor claiming an already-claimed subject must never silently overwrite it (AC7).
    assert.throws(() => provider.claim("subject-1", ACTOR_B, CLAIM_META), /refusing to overwrite/);

    const supersedeReturn = provider.supersede("subject-1", ACTOR_A, ACTOR_B, { reason: "handoff" });
    assert.equal(supersedeReturn, undefined, "the neutral supersede() must return void");
    const statusAfterSupersede = provider.status("subject-1");
    assert.deepEqual(statusAfterSupersede.record.actor, ACTOR_B);

    // release() by the PREVIOUS (no-longer-holding) actor must be refused (AC6 — never
    // force-release a claim held by someone else).
    assert.throws(() => provider.release("subject-1", ACTOR_A), /refusing to release/);

    const releaseReturn = provider.release("subject-1", ACTOR_B, { reason: "session end" });
    assert.equal(releaseReturn, undefined, "the neutral release() must return void");

    const statusAfterRelease = provider.status("subject-1");
    assert.equal(statusAfterRelease.record, null);
    assert.equal(statusAfterRelease.assignee, null);

    // release() with tolerateNoActiveClaim is an idempotent no-op, matching
    // performLocalRelease's documented Stop-hook lifecycle behavior — still void, no exception.
    assert.equal(provider.release("subject-1", ACTOR_B, { tolerateNoActiveClaim: true }), undefined);
  });
});

test("createLocalFileAssignmentProvider (LocalAssignmentProviderExt): claimReturning/releaseReturning/supersedeReturning return the written AssignmentClaimRecord", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProvider(dir);

    const claimed = provider.claimReturning("subject-1", ACTOR_A, CLAIM_META);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.subject_id, "subject-1");
    assert.deepEqual(claimed.actor, ACTOR_A);

    const superseded = provider.supersedeReturning("subject-1", ACTOR_A, ACTOR_B, { reason: "handoff" });
    assert.equal(superseded.status, "claimed");
    assert.deepEqual(superseded.actor, ACTOR_B);

    const released = provider.releaseReturning("subject-1", ACTOR_B, { reason: "session end" });
    assert.equal(released.status, "released");

    // tolerateNoActiveClaim's idempotent no-op still returns null on the Returning extension too.
    assert.equal(provider.releaseReturning("subject-1", ACTOR_B, { tolerateNoActiveClaim: true }), null);
  });
});

test("createLocalFileAssignmentProvider: list() with no filter returns every claimed subject id", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProvider(dir);
    provider.claim("subject-1", ACTOR_A, CLAIM_META);
    provider.claim("subject-2", ACTOR_B, { ...CLAIM_META, branch: "agent/session-b/subject-2", artifactDir: ".kontourai/flow-agents/subject-2" });
    assert.deepEqual(provider.list().sort(), ["subject-1", "subject-2"]);
    provider.release("subject-1", ACTOR_A);
    assert.deepEqual(provider.list(), ["subject-2"]);
  });
});

// ─── #777 review finding 3: list(actorKey) must filter by the CANONICAL actor_key
// (record.actor_key-preferred), not a raw re-serialization of the actor struct — using a
// DISTINCT explicit actorKey (deliberately different from serializeActor(actor)) so a
// regression back to the naive comparison would fail this test. ────────────────────

const EXPLICIT_OVERRIDE_ACTOR = { runtime: "claude-code", session_id: "session-explicit", host: "host-explicit", human: null };
// Deliberately NOT the same string serializeActor(EXPLICIT_OVERRIDE_ACTOR) would produce
// ("claude-code:session-explicit:host-explicit") — this is the canonical resolveActor(env).actor
// token an explicit-override actor carries instead (assignment-provider-contract.md's actor_key
// field doc).
const EXPLICIT_ACTOR_KEY = "explicit-override-canonical-key";
const RAW_SERIALIZED_TRIPLE = `${EXPLICIT_OVERRIDE_ACTOR.runtime}:${EXPLICIT_OVERRIDE_ACTOR.session_id}:${EXPLICIT_OVERRIDE_ACTOR.host}`;

test("createLocalFileAssignmentProvider: list(actorKey) filters by the canonical actor_key, not a re-derived serializeActor(actor) triple", () => {
  withTempDir((dir) => {
    assert.notEqual(RAW_SERIALIZED_TRIPLE, EXPLICIT_ACTOR_KEY, "fixture sanity: the two comparison keys must actually differ for this test to prove anything");
    const provider = createLocalFileAssignmentProvider(dir);
    provider.claim("subject-explicit", EXPLICIT_OVERRIDE_ACTOR, { ...CLAIM_META, actorKey: EXPLICIT_ACTOR_KEY });

    // Correct: filtering by the canonical actor_key that was actually stamped on the record finds it.
    assert.deepEqual(provider.list(EXPLICIT_ACTOR_KEY), ["subject-explicit"]);
    // A raw re-serialization of the actor struct is NOT the canonical key for an explicit-override
    // actor — filtering by it must NOT match (this is what the naive `serializeActor(record.actor)`
    // comparison would have wrongly matched, and what canonicalHolderActorKey() fixes).
    assert.deepEqual(provider.list(RAW_SERIALIZED_TRIPLE), []);
  });
});

test("createLocalFileAssignmentProvider exported from the package root entry is the same adapter factory (#775 pattern)", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProviderFromPackageRoot(dir);
    provider.claim("subject-root", ACTOR_A, CLAIM_META);
    assert.deepEqual(provider.list(), ["subject-root"]);
  });
});

// ─── #777 implementability proof: createLocalFileMutationProvider formally satisfies
// WorkItemMutationProvider. ──────────────────────────────────────────────────

function seedBacklog(dir, items) {
  const file = path.join(dir, "backlog.json");
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: "1.0", items }, null, 2)}\n`, "utf8");
  return file;
}

test("createLocalFileMutationProvider: mutate() applies a status_transition through the WorkItemMutationProvider interface", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const provider = createLocalFileMutationProvider(file);
    const request = parseWorkItemMutationRequest({
      schema_version: "1.0",
      operation: "status_transition",
      work_item_ref: { id: "local:1" },
      base: { status: "in_progress" },
      payload: { to_status: "review" },
    });
    const result = provider.mutate(request);
    assert.equal(result.status, "applied");
    assert.equal(result.operation, "status_transition");
  });
});

test("createLocalFileMutationProvider: mutate() reports conflict (provider wins) without a `context` argument — the local-file adapter self-observes", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "review" }]);
    const provider = createLocalFileMutationProvider(file);
    const request = parseWorkItemMutationRequest({
      schema_version: "1.0",
      operation: "status_transition",
      work_item_ref: { id: "local:1" },
      base: { status: "in_progress" },
      payload: { to_status: "done" },
    });
    const result = provider.mutate(request);
    assert.equal(result.status, "conflict");
    assert.equal(result.conflict.observed_value, "review");
  });
});

test("createLocalFileMutationProvider: mutate() ignores a supplied context (no self-observation override) — local-file always self-observes", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const provider = createLocalFileMutationProvider(file);
    const request = parseWorkItemMutationRequest({
      schema_version: "1.0",
      operation: "status_transition",
      work_item_ref: { id: "local:1" },
      base: { status: "in_progress" },
      payload: { to_status: "review" },
    });
    // A context claiming a DIFFERENT observed status must not change the outcome — the local-file
    // adapter always reads its own storage, never trusts a caller-supplied observation.
    const result = provider.mutate(request, { observed: { status: "done" } });
    assert.equal(result.status, "applied");
  });
});

test("createLocalFileMutationProvider exported from the package root entry is the same adapter factory (#775 pattern)", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1" }]);
    const provider = createLocalFileMutationProviderFromPackageRoot(file);
    const result = provider.mutate(parseWorkItemMutationRequest({
      schema_version: "1.0",
      operation: "comment",
      work_item_ref: { id: "local:1" },
      base: {},
      payload: { body: "hello from the package root adapter" },
    }));
    assert.equal(result.status, "applied");
  });
});
