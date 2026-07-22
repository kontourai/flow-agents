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
// AssignmentProvider (the `satisfies AssignmentProvider` annotation in
// local-file-provider-adapters.ts is the type-level half, gated by `npm run typecheck`; this test
// is the behavioral half — constructing the adapter through its interface and driving it exactly
// as a host would). ───────────────────────────────────────────────────────────

test("createLocalFileAssignmentProvider: claim -> status -> list -> supersede -> release round trip through the AssignmentProvider interface", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProvider(dir);

    const claimed = provider.claim("subject-1", ACTOR_A, CLAIM_META);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.subject_id, "subject-1");
    assert.deepEqual(claimed.actor, ACTOR_A);

    const status = provider.status("subject-1");
    assert.equal(status.provider, "local-file");
    assert.equal(status.subject_id, "subject-1");
    assert.ok(status.assignee, "status().assignee should be the serialized holder actor key");
    assert.equal(status.record.subject_id, "subject-1");

    // list() with no filter returns every claimed subject id.
    assert.deepEqual(provider.list(), ["subject-1"]);
    // list(actorKey) filters to the holder's canonical actor key.
    assert.deepEqual(provider.list(status.assignee), ["subject-1"]);
    // A non-matching actor key filter excludes it.
    assert.deepEqual(provider.list("some-other-actor"), []);

    // A different actor claiming an already-claimed subject must never silently overwrite it (AC7).
    assert.throws(() => provider.claim("subject-1", ACTOR_B, CLAIM_META), /refusing to overwrite/);

    // supersede() reassigns from the current holder to a successor, with an audit-trail note.
    const superseded = provider.supersede("subject-1", ACTOR_A, ACTOR_B, { reason: "handoff" });
    assert.equal(superseded.status, "claimed");
    assert.deepEqual(superseded.actor, ACTOR_B);

    // release() by the PREVIOUS (no-longer-holding) actor must be refused (AC6 — never
    // force-release a claim held by someone else).
    assert.throws(() => provider.release("subject-1", ACTOR_A), /refusing to release/);

    // release() by the current holder clears ownership and returns the terminal record.
    const released = provider.release("subject-1", ACTOR_B, { reason: "session end" });
    assert.equal(released.status, "released");

    // status()/list() reflect the release.
    const statusAfterRelease = provider.status("subject-1");
    assert.equal(statusAfterRelease.record, null);
    assert.equal(statusAfterRelease.assignee, null);
    assert.deepEqual(provider.list(), []);

    // release() with tolerateNoActiveClaim is an idempotent no-op, matching
    // performLocalRelease's documented Stop-hook lifecycle behavior.
    assert.equal(provider.release("subject-1", ACTOR_B, { tolerateNoActiveClaim: true }), null);
  });
});

test("createLocalFileAssignmentProvider exported from the package root entry is the same adapter factory (#775 pattern)", () => {
  withTempDir((dir) => {
    const provider = createLocalFileAssignmentProviderFromPackageRoot(dir);
    const claimed = provider.claim("subject-root", ACTOR_A, CLAIM_META);
    assert.equal(claimed.status, "claimed");
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

test("createLocalFileMutationProvider: mutate() reports conflict (provider wins) without an `observed` argument — the local-file adapter self-observes", () => {
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
