/**
 * The AssignmentProvider contract suite (#1436): the behaviors every provider of the assignment
 * primitive must show, written against the PUBLISHED contract surface only
 * (`build/src/assignment-contract.js`). Two providers run it in this repo:
 *
 *   - the local-file provider (`assignment-local-file.test.mjs`), the one Flow's CLI uses;
 *   - an in-memory reference provider below, built from nothing but `assignment-contract`
 *     exports, standing in for a host's own store. It proves a host CAN implement the contract
 *     from the published subpath alone, and that the suite does not depend on local-file details.
 *
 * Not named `*.test.mjs`, so the unit glob does not run it directly.
 */
import assert from "node:assert/strict";
import {
  canonicalHolderActorKey,
  findAssignmentClaimRecordProblems,
  resolveEffectiveState,
  serializeActor,
  ASSIGNMENT_CLAIM_RECORD_ROLE,
  ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION,
} from "../../build/src/assignment-contract.js";

export const ACTOR_A = { runtime: "claude-code", session_id: "session-a", host: "host-a", human: null };
export const ACTOR_B = { runtime: "claude-code", session_id: "session-b", host: "host-a", human: null };
export const HUMAN = { runtime: "human", session_id: "brian", host: "laptop", human: "brian" };
export const CLAIM_META = { ttlSeconds: 1800, branch: "agent/session-a/subject-1", artifactDir: ".kontourai/flow-agents/subject-1" };
const EXPLICIT_ACTOR = { runtime: "explicit-override", session_id: "canonical-x", host: "host-x", human: null };
const EXPLICIT_KEY = "canonical-x";

/** A host-supplied liveness source: a fixed map of subject -> fresh holders. */
export function staticLivenessSource(bySubject) {
  return { freshHolders: (subjectId) => bySubject[subjectId] ?? [] };
}

/**
 * In-memory reference provider: the smallest honest implementation of `AssignmentProvider`
 * from the published contract. A host with its own store would look like this.
 */
export function createInMemoryAssignmentProvider(clock = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
  const records = new Map();
  const active = (subjectId) => {
    const record = records.get(subjectId);
    return record && record.status === "claimed" ? record : null;
  };
  return {
    claim(subjectId, actor, meta) {
      const existing = active(subjectId);
      if (existing && serializeActor(existing.actor) !== serializeActor(actor)) {
        throw new Error(`subject already claimed by a different actor: ${serializeActor(existing.actor)}`);
      }
      records.set(subjectId, {
        schema_version: ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION,
        role: ASSIGNMENT_CLAIM_RECORD_ROLE,
        subject_id: subjectId,
        actor,
        ...(meta.actorKey ? { actor_key: meta.actorKey } : {}),
        claimed_at: clock(),
        ttl_seconds: meta.ttlSeconds,
        branch: meta.branch,
        artifact_dir: meta.artifactDir,
        status: "claimed",
      });
    },
    release(subjectId, releasedBy, meta = {}) {
      const existing = active(subjectId);
      if (!existing) {
        if (meta.tolerateNoActiveClaim) return;
        throw new Error(`no active claim to release for subject: ${subjectId}`);
      }
      if (releasedBy) {
        const releaserKey = meta.actorKey || serializeActor(releasedBy);
        if (canonicalHolderActorKey(existing) !== releaserKey) {
          if (meta.tolerateNoActiveClaim) return;
          throw new Error("refusing to release a claim held by someone else");
        }
      }
      records.set(subjectId, { ...existing, status: "released" });
    },
    supersede(subjectId, from, to, meta = {}) {
      const existing = active(subjectId);
      if (!existing) throw new Error(`no active claim to supersede for subject: ${subjectId}`);
      if (serializeActor(existing.actor) !== serializeActor(from)) {
        throw new Error("refusing to supersede a claim held by someone else");
      }
      const { actor_key: _dropped, ...rest } = existing;
      records.set(subjectId, {
        ...rest,
        actor: to,
        ...(meta.actorKey ? { actor_key: meta.actorKey } : {}),
        claimed_at: clock(),
        ttl_seconds: meta.ttlSeconds ?? existing.ttl_seconds,
        branch: meta.branch ?? existing.branch,
        artifact_dir: meta.artifactDir ?? existing.artifact_dir,
        status: "claimed",
      });
    },
    status(subjectId) {
      const record = active(subjectId);
      return { subject_id: subjectId, provider: "in-memory", assignee: record ? serializeActor(record.actor) : null, record };
    },
    list(actorKey) {
      return [...records.values()]
        .filter((record) => record.status === "claimed" && (!actorKey || canonicalHolderActorKey(record) === actorKey))
        .map((record) => record.subject_id)
        .sort();
    },
  };
}

/** Each case receives `make()` -> `{ provider, cleanup? }` and must leave nothing behind. */
export const ASSIGNMENT_PROVIDER_CONTRACT_CASES = [
  {
    name: "claim then status: the record carries the actor and passes the contract's required-field check",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        const status = await provider.status("subject-1");
        assert.equal(status.subject_id, "subject-1");
        assert.ok(status.assignee, "a claimed subject has an assignee");
        assert.deepEqual(status.record.actor, ACTOR_A);
        assert.equal(status.record.status, "claimed");
        assert.deepEqual(findAssignmentClaimRecordProblems(status.record), []);
      } finally { cleanup?.(); }
    },
  },
  {
    name: "status of an unclaimed subject is empty (no assignee, no record)",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        const status = await provider.status("never-claimed");
        assert.equal(status.assignee, null);
        assert.equal(status.record, null);
      } finally { cleanup?.(); }
    },
  },
  {
    name: "the same actor re-claiming is idempotent",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        assert.deepEqual(await provider.list(), ["subject-1"]);
      } finally { cleanup?.(); }
    },
  },
  {
    name: "a different actor can never silently overwrite a claim (AC7)",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        await assert.rejects(async () => provider.claim("subject-1", ACTOR_B, CLAIM_META));
        const status = await provider.status("subject-1");
        assert.deepEqual(status.record.actor, ACTOR_A, "the original holder is untouched");
      } finally { cleanup?.(); }
    },
  },
  {
    name: "supersede reassigns from the true holder and refuses a wrong `from`",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        await assert.rejects(async () => provider.supersede("subject-1", ACTOR_B, HUMAN, { reason: "wrong from" }));
        assert.deepEqual((await provider.status("subject-1")).record.actor, ACTOR_A);
        await provider.supersede("subject-1", ACTOR_A, ACTOR_B, { reason: "stale takeover" });
        assert.deepEqual((await provider.status("subject-1")).record.actor, ACTOR_B);
      } finally { cleanup?.(); }
    },
  },
  {
    name: "release refuses a non-holder (AC6), clears for the holder, and tolerates a missing claim on request",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-1", ACTOR_A, CLAIM_META);
        await assert.rejects(async () => provider.release("subject-1", ACTOR_B));
        assert.deepEqual(await provider.list(), ["subject-1"], "a refused release changes nothing");
        await provider.release("subject-1", ACTOR_A, { reason: "session end" });
        const status = await provider.status("subject-1");
        assert.equal(status.record, null);
        assert.equal(status.assignee, null);
        assert.deepEqual(await provider.list(), []);
        await provider.release("subject-1", ACTOR_A, { tolerateNoActiveClaim: true });
        await assert.rejects(async () => provider.release("subject-1", ACTOR_A));
      } finally { cleanup?.(); }
    },
  },
  {
    name: "list filters by the CANONICAL actor key (stored actor_key, not a re-serialized actor struct)",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        await provider.claim("subject-explicit", EXPLICIT_ACTOR, { ...CLAIM_META, actorKey: EXPLICIT_KEY });
        await provider.claim("subject-b", ACTOR_B, CLAIM_META);
        assert.deepEqual(await provider.list(EXPLICIT_KEY), ["subject-explicit"]);
        assert.deepEqual(await provider.list(serializeActor(EXPLICIT_ACTOR)), [], "the re-derived triple is not the canonical key");
        assert.deepEqual((await provider.list()).sort(), ["subject-b", "subject-explicit"]);
      } finally { cleanup?.(); }
    },
  },
  {
    name: "joined with a host liveness source: free, held, reclaimable, and human-held",
    async run(make) {
      const { provider, cleanup } = make();
      try {
        const nowMs = Date.parse("2026-10-05T12:00:00Z");
        const fresh = [{ actor: serializeActor(ACTOR_A), lastAt: "2026-10-05T11:59:00Z", ttlSeconds: 1800, fresh: true }];

        const free = await resolveEffectiveState(await provider.status("s-free"), staticLivenessSource({}), { nowMs });
        assert.equal(free.effective_state, "free");

        await provider.claim("s-agent", ACTOR_A, CLAIM_META);
        const held = await resolveEffectiveState(await provider.status("s-agent"), staticLivenessSource({ "s-agent": fresh }), { selfActor: serializeActor(ACTOR_B), nowMs });
        assert.equal(held.effective_state, "held");

        // A host that stops reporting liveness: the claim ages into reclaimable, never lost-locked.
        const stale = await resolveEffectiveState(await provider.status("s-agent"), staticLivenessSource({}), { selfActor: serializeActor(ACTOR_B), nowMs });
        assert.equal(stale.effective_state, "reclaimable");

        await provider.claim("s-human", HUMAN, { ...CLAIM_META, branch: "main" });
        const human = await resolveEffectiveState(await provider.status("s-human"), staticLivenessSource({}), { selfActor: serializeActor(ACTOR_B), nowMs });
        assert.equal(human.effective_state, "human-held");
      } finally { cleanup?.(); }
    },
  },
];
