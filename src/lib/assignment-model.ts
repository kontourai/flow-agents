/**
 * The assignment coordination PRIMITIVE: engine-level and kit-neutral, pure (no `fs`,
 * `child_process`, or `gh`). Published as `@kontourai/flow-agents/assignment-contract`.
 *
 * ADR 0021 defines durable work-item ownership as a third provider leg and an effective state
 * that is always the join `assignment ⋈ liveness`. This module is that primitive:
 *
 *   - the `AssignmentProvider` contract (`claim` / `release` / `supersede` / `status` / `list`);
 *   - the runtime-agnostic actor identity (`{ runtime, session_id, host, human? }`);
 *   - the versioned claim-record type and its codec (the exact bytes the local-file provider
 *     writes and the JSON the GitHub claim comment carries);
 *   - the effective-state join (`held` / `reclaimable` / `human-held` / `free`);
 *   - the takeover eligibility rules (grace period, never auto-supersede a human);
 *   - the `AssignmentLivenessSource` interface, so a host supplies liveness from its own runtime.
 *
 * What is deliberately NOT here is Builder Kit POLICY. Per
 * `docs/architecture-engine-and-kits.md` ("Flow Agents is not the Builder Kit"), the engine gives
 * no kit special privilege: *when* to claim (pickup / `pull-work`), *when* to release (the Stop
 * hook), and *how* a takeover resumes (`continue-work`, the verify-hold publish gate,
 * `builder-lifecycle-authority.ts`) stay in the kit. This module answers "what is the state of
 * this subject" and "may it be taken over"; it never decides that a session should act.
 *
 * Subject identity is any stable work identity string: a GitHub issue ref, a host Task id, a Flow
 * work item. Nothing in this module parses it. The GitHub-issue-shaped `work_item_ref`
 * (`owner/repo#number`) validation lives with the GitHub provider
 * (`@kontourai/flow-agents/assignment-github`), and the core record type carries `work_item_ref`
 * as an opaque optional string.
 *
 * Liveness stays host-specific. A host that stops heartbeating simply ages into `reclaimable`
 * under the join; no assignment is ever trusted alone (ADR 0021 §1).
 *
 * The CLI (`flow-agents assignment-provider ...`) consumes this module, so a host and the CLI
 * compute the same state from the same records.
 *
 * @module
 */

// ─── Actor identity ──────────────────────────────────────────────────────────

/** Runtime-agnostic actor identity (ADR 0021 §2). `human` is set only for a human assignee: its
 * presence, never a username heuristic, gates the `human-held` join state. */
export type ActorStruct = {
  runtime: string;
  session_id: string;
  host: string;
  human?: string | null;
};

/**
 * Restrict a value to `[A-Za-z0-9_.-]`, capped at 64 characters, falling back to `"unknown"`.
 * Mirrors `scripts/hooks/lib/actor-identity.js` `sanitizeSegment` (the hook runtime's CJS copy; a
 * parity test pins the two together).
 */
export function sanitizeSegment(value: unknown): string {
  const cleaned = String(value == null ? "" : value).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
  return cleaned || "unknown";
}

/** Serialize an actor struct to one grouping-key-safe string (`runtime:session_id:host[:human]`).
 * Mirrors `scripts/hooks/lib/actor-identity.js` `serializeActor`. */
export function serializeActor(actor: Partial<ActorStruct> | undefined): string {
  const a = actor || {};
  const parts = [sanitizeSegment(a.runtime), sanitizeSegment(a.session_id), sanitizeSegment(a.host)];
  if (a.human != null && String(a.human).trim() !== "") parts.push(sanitizeSegment(a.human));
  return parts.join(":");
}

/** Whether an actor struct names a human (the `human` field present and non-blank). */
export function isHumanActor(actor: Partial<ActorStruct> | null | undefined): boolean {
  return Boolean(actor) && actor!.human != null && String(actor!.human).trim() !== "";
}

// ─── Claim record ────────────────────────────────────────────────────────────

/** `schema_version` of the claim record. Bumped only on an incompatible change. */
export const ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION = "1.0" as const;

/** `role` constant, for readers scanning mixed content (e.g. a GitHub comment thread). */
export const ASSIGNMENT_CLAIM_RECORD_ROLE = "AssignmentClaimRecord" as const;

export type AssignmentClaimRecordStatus = "claimed" | "released" | "superseded";

export type AssignmentAuditEntry = {
  at: string;
  transition: "claim" | "release" | "supersede";
  from_actor?: ActorStruct | null;
  to_actor?: ActorStruct | null;
  reason?: string;
};

/**
 * The versioned claim record (`context/contracts/assignment-provider-contract.md`, "Versioned
 * claim-record format"). `actor_key`, when present, is the canonical holder key: the ONLY correct
 * self-recognition and liveness-join key, because `serializeActor(actor)` diverges from it for an
 * explicit-override actor. `work_item_ref` is an opaque provider-supplied reference; this module
 * never parses it.
 */
export type AssignmentClaimRecord = {
  schema_version: typeof ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION;
  role: typeof ASSIGNMENT_CLAIM_RECORD_ROLE;
  subject_id: string;
  actor: ActorStruct;
  actor_key?: string;
  work_item_ref?: string;
  claimed_at: string;
  ttl_seconds: number;
  branch: string;
  artifact_dir: string;
  status: AssignmentClaimRecordStatus;
  audit_trail?: AssignmentAuditEntry[];
};

export type AssignmentClaimRecordDecodeResult =
  | { ok: true; record: AssignmentClaimRecord }
  | { ok: false; code: "invalid_json"; detail: string }
  | { ok: false; code: "not_an_object" }
  | { ok: false; code: "unsupported_schema_version"; found: string }
  | { ok: false; code: "unexpected_role"; found: string };

/**
 * Decode an already-parsed claim record. Checks only what a reader needs to refuse an
 * incompatible shape: an object, `schema_version === "1.0"`, and (when `requireRole`) the `role`
 * constant. It never rewrites or drops fields, so a decoded record re-encodes to the same bytes.
 * `requireRole` is set for GitHub comments (mixed content) and off for the local-file store,
 * matching what each medium has always enforced.
 */
export function decodeAssignmentClaimRecord(value: unknown, opts: { requireRole?: boolean } = {}): AssignmentClaimRecordDecodeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "not_an_object" };
  const record = value as Record<string, unknown>;
  if (record.schema_version !== ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION) {
    return { ok: false, code: "unsupported_schema_version", found: String(record.schema_version) };
  }
  if (opts.requireRole && record.role !== ASSIGNMENT_CLAIM_RECORD_ROLE) {
    return { ok: false, code: "unexpected_role", found: String(record.role) };
  }
  return { ok: true, record: value as AssignmentClaimRecord };
}

/** Parse claim-record JSON text, then decode it. */
export function parseAssignmentClaimRecord(text: string, opts: { requireRole?: boolean } = {}): AssignmentClaimRecordDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: "invalid_json", detail: (error as Error).message };
  }
  return decodeAssignmentClaimRecord(parsed, opts);
}

/**
 * Serialize a record to the exact bytes the local-file provider writes
 * (`<artifact-root>/assignment/<subject>.json`): two-space JSON plus a trailing newline.
 */
export function serializeAssignmentClaimRecord(record: AssignmentClaimRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Required-field check for a host that writes its own records and wants them to read back
 * unchanged in the Flow CLI. Returns human-readable problems (empty when the record satisfies the
 * contract's required fields). The CLI readers do not call this; they stay as tolerant as they
 * have always been, so adding it changes no existing read.
 */
export function findAssignmentClaimRecordProblems(record: unknown): string[] {
  const decoded = decodeAssignmentClaimRecord(record, { requireRole: true });
  if (!decoded.ok) return [decoded.code === "not_an_object" ? "record must be an object" : `${decoded.code}: ${"found" in decoded ? decoded.found : ""}`];
  const r = decoded.record as unknown as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of ["subject_id", "claimed_at", "branch", "artifact_dir"]) {
    if (typeof r[field] !== "string" || r[field] === "") problems.push(`${field} must be a non-empty string`);
  }
  if (typeof r.ttl_seconds !== "number" || !Number.isFinite(r.ttl_seconds) || r.ttl_seconds <= 0) problems.push("ttl_seconds must be a positive number");
  if (r.status !== "claimed" && r.status !== "released" && r.status !== "superseded") problems.push("status must be claimed, released, or superseded");
  const actor = r.actor as Record<string, unknown> | null | undefined;
  if (typeof actor !== "object" || actor === null) problems.push("actor must be an object");
  else for (const field of ["runtime", "session_id", "host"]) if (typeof actor[field] !== "string" || actor[field] === "") problems.push(`actor.${field} must be a non-empty string`);
  return problems;
}

/**
 * The canonical holder actor key for a claim record: `record.actor_key` when present, falling back
 * to `serializeActor(record.actor)` for records written before `actor_key` existed. Every
 * holder-identity comparison (join self-recognition, liveness match, `list` actor filter) goes
 * through this so they cannot diverge.
 */
export function canonicalHolderActorKey(record: AssignmentClaimRecord): string {
  return record.actor_key || serializeActor(record.actor);
}

// ─── Assignment status, liveness, and the join ───────────────────────────────

/** One actor's fresh liveness hold on a subject, as `scripts/hooks/lib/liveness-read.js`
 * `freshHolders` returns it. */
export type FreshHolder = { actor: string; lastAt: string; ttlSeconds: number; fresh: boolean };

export type EffectiveState = "held" | "reclaimable" | "human-held" | "free";

export type EffectiveStateResult = {
  effective_state: EffectiveState;
  reason: string;
  holder?: { actor?: string; assignee?: string | null; idle_days?: number | null; last_at?: string };
};

/** Provider identifier on a status read. `local-file` and `github` ship here; a host's own store
 * names itself. */
export type AssignmentProviderKind = "local-file" | "github" | (string & {});

/**
 * Provider-neutral assignment-layer read, BEFORE any liveness join. `assignee` is the provider's
 * native owner (a GitHub login, or the serialized actor for the local-file store); `record` is the
 * active claim record when one is present. A provider with more native fields (GitHub's label and
 * comment metadata) extends this type; the join reads only these four.
 */
export type AssignmentStatus = {
  subject_id: string;
  provider: AssignmentProviderKind;
  assignee: string | null;
  record: AssignmentClaimRecord | null;
};

/**
 * The assignment ⋈ liveness join (ADR 0021 §1), a pure function. Provider state is never trusted
 * alone: staleness, not assignment, is what excludes, so an orphaned assignment from a dead
 * session can never gate work.
 *
 * | assignment          | liveness            | effective state                      |
 * | ------------------- | ------------------- | ------------------------------------ |
 * | assigned            | fresh heartbeat     | `held`                               |
 * | assigned            | stale / absent      | `reclaimable`                        |
 * | assigned (human)    | n/a                 | `human-held`                         |
 * | unassigned          | fresh (claim only)  | `held` (assignment lagging)          |
 * | unassigned          | absent              | `free`                               |
 *
 * The human gate reads `record.actor.human` being present, never a username heuristic. An
 * assignee with no parseable claim record is treated as human-held too: it cannot be identified
 * as a stale agent session, so the conservative ask-first default applies (ADR 0021 §6).
 *
 * `freshHoldersList` is the caller's liveness reading for this subject (excluding `selfActor`, as
 * `freshHolders` does). `nowMs` is the same clock the caller used for that reading, so a fixed
 * `now` governs both freshness and `idle_days` deterministically.
 */
export function computeEffectiveState(
  assignment: AssignmentStatus,
  freshHoldersList: FreshHolder[],
  selfActor: string | undefined,
  nowMs: number,
): EffectiveStateResult {
  const record = assignment.record && assignment.record.status === "claimed" ? assignment.record : null;
  const isAssigned = Boolean(assignment.assignee) || Boolean(record);

  if (!isAssigned) {
    if (freshHoldersList.length > 0) {
      const holder = freshHoldersList[0];
      return { effective_state: "held", reason: "liveness_claim_present_assignment_lagging", holder: { actor: holder.actor, last_at: holder.lastAt } };
    }
    return { effective_state: "free", reason: "no_assignment_no_liveness" };
  }

  if (record && isHumanActor(record.actor)) {
    const idleMs = nowMs - Date.parse(record.claimed_at);
    const idleDays = Number.isFinite(idleMs) ? Math.floor(idleMs / 86_400_000) : null;
    return { effective_state: "human-held", reason: "assignee_is_human", holder: { actor: assignment.assignee ?? undefined, idle_days: idleDays } };
  }

  if (!record) {
    return { effective_state: "human-held", reason: "assignee_without_claim_record", holder: { assignee: assignment.assignee } };
  }

  const holderActorKey = canonicalHolderActorKey(record);
  if (selfActor && holderActorKey === selfActor) return { effective_state: "held", reason: "self_is_holder", holder: { actor: holderActorKey } };

  const fresh = freshHoldersList.find((holder) => holder.actor === holderActorKey);
  if (fresh) return { effective_state: "held", reason: "fresh_liveness_heartbeat", holder: { actor: holderActorKey, last_at: fresh.lastAt } };
  return { effective_state: "reclaimable", reason: "assignment_present_liveness_stale_or_absent", holder: { actor: holderActorKey, last_at: record.claimed_at } };
}

// ─── Host liveness source ────────────────────────────────────────────────────

/**
 * Where a host gets liveness. Flow's CLI reads the ADR 0012 JSONL stream; a host product supplies
 * the same answer from its own runtime (its session registry, a process table, a heartbeat it
 * already keeps). A source with nothing to report returns `[]`, and the join ages the claim into
 * `reclaimable`.
 */
export interface AssignmentLivenessSource {
  /**
   * Fresh (within-TTL, not released) holders of `subjectId` as of `nowMs`, EXCLUDING `selfActor`
   * (matching `freshHolders` in `scripts/hooks/lib/liveness-read.js`). Each holder's `actor` is a
   * canonical actor key comparable to `canonicalHolderActorKey`.
   */
  freshHolders(subjectId: string, selfActor: string | undefined, nowMs: number): FreshHolder[] | Promise<FreshHolder[]>;
}

/** Join an assignment read against a host's liveness source. */
export async function resolveEffectiveState(
  assignment: AssignmentStatus,
  liveness: AssignmentLivenessSource,
  opts: { selfActor?: string; nowMs?: number } = {},
): Promise<EffectiveStateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const fresh = await liveness.freshHolders(assignment.subject_id, opts.selfActor, nowMs);
  return computeEffectiveState(assignment, fresh, opts.selfActor, nowMs);
}

// ─── Takeover eligibility ────────────────────────────────────────────────────

/** Human-assignee policy knob (`schemas/assignment-provider-settings.schema.json`). */
export type HumanAssigneePolicy = {
  behavior: "ask_first" | "never_reclaim";
  idle_threshold_days: number;
};

/**
 * Default grace beat, in seconds: one default heartbeat interval. Mirrors
 * `DEFAULT_HEARTBEAT_THROTTLE_SECONDS` in `scripts/hooks/lib/liveness-policy.js` (a parity test
 * pins them); a host with its own heartbeat interval passes that instead.
 */
export const DEFAULT_TAKEOVER_GRACE_SECONDS = 60;

/** The takeover rules as data (ADR 0021 §5/§6). Frozen so a consumer cannot loosen them. */
export const TAKEOVER_RULES = Object.freeze({
  /** Wait one heartbeat interval and re-read before superseding; back off if the incumbent revived. */
  graceSeconds: DEFAULT_TAKEOVER_GRACE_SECONDS,
  /** The only effective state a successor may supersede. */
  autoSupersedableStates: Object.freeze(["reclaimable"] as const),
  /** A human assignee is never auto-superseded, whatever the policy or idle time. */
  neverAutoSupersede: Object.freeze(["human-held"] as const),
  humanAssignee: Object.freeze({ behavior: "ask_first", idle_threshold_days: 3 } as HumanAssigneePolicy),
});

export type TakeoverAction = "grace-then-supersede" | "back-off" | "claim" | "ask-first" | "proceed";

/**
 * Whether the join result makes a subject eligible for AUTOMATIC supersede. Only `reclaimable`
 * is; `human-held` is never eligible, and `held` / `free` have nothing to take over.
 */
export function isAutoSupersedable(effective: Pick<EffectiveStateResult, "effective_state">): boolean {
  return (TAKEOVER_RULES.autoSupersedableStates as readonly EffectiveState[]).includes(effective.effective_state);
}

/**
 * Map a join result to the takeover action ADR 0021 §5/§6 prescribes. This is the eligibility
 * rule only: `grace-then-supersede` means "eligible, after the grace beat and a re-read". How a
 * kit then resumes the incumbent's work is the kit's policy, not this function's.
 */
export function decideTakeover(effective: EffectiveStateResult): { ok: boolean; action: TakeoverAction } {
  switch (effective.effective_state) {
    case "reclaimable":
      return { ok: true, action: "grace-then-supersede" };
    case "held": {
      const self = effective.reason === "self_is_holder";
      return { ok: self, action: self ? "proceed" : "back-off" };
    }
    case "human-held":
      return { ok: false, action: "ask-first" };
    case "free":
    default:
      return { ok: true, action: "claim" };
  }
}

/** Whether the grace beat that began at `graceStartedAtMs` has elapsed at `nowMs`. */
export function isTakeoverGraceElapsed(graceStartedAtMs: number, nowMs: number, graceSeconds: number = TAKEOVER_RULES.graceSeconds): boolean {
  return nowMs - graceStartedAtMs >= graceSeconds * 1000;
}

/**
 * What to do about a `human-held` result under the policy knob. Never a supersede: the answer is
 * only whether the assignment is worth SURFACING for an explicit human confirmation.
 *
 *   - `never_reclaim`            -> `leave` (never surfaced).
 *   - `ask_first`, idle >= days  -> `surface`.
 *   - `ask_first`, idle unknown  -> `leave`: with no claim record there is no claim time to age,
 *                                   so idleness cannot be shown (not a license to reclaim).
 *   - `ask_first`, idle < days   -> `leave`.
 */
export function humanHeldDisposition(
  effective: EffectiveStateResult,
  policy: HumanAssigneePolicy = TAKEOVER_RULES.humanAssignee,
): "surface" | "leave" {
  if (effective.effective_state !== "human-held") return "leave";
  if (policy.behavior === "never_reclaim") return "leave";
  const idle = effective.holder?.idle_days;
  return typeof idle === "number" && idle >= policy.idle_threshold_days ? "surface" : "leave";
}

// ─── AssignmentProvider ──────────────────────────────────────────────────────
// assignment-provider-contract.md "AssignmentProvider Operations", formalizing ADR 0021 §2.

export interface AssignmentClaimMeta {
  ttlSeconds: number;
  branch: string;
  artifactDir: string;
  reason?: string;
  actorKey?: string;
  workItemRef?: string;
}

export interface AssignmentReleaseMeta {
  reason?: string;
  actorKey?: string;
  /** When `true`, a missing claim or an ownership mismatch is a tolerated no-op (`null` return)
   * instead of a thrown error — the Stop-hook idempotent-release lifecycle's behavior
   * (`performLocalRelease`'s doc comment); the interactive/default behavior is `false`. */
  tolerateNoActiveClaim?: boolean;
}

export interface AssignmentSupersedeMeta {
  ttlSeconds?: number;
  branch?: string;
  artifactDir?: string;
  reason?: string;
  actorKey?: string;
  workItemRef?: string;
}

export interface AssignmentProvider {
  /**
   * Record durable ownership of `subjectId` for `actor`. Returns `void` — ADR 0021 §2's abstract
   * signature documents exactly this ("caller re-reads via `status` to confirm" —
   * assignment-provider-contract.md "AssignmentProvider Operations" table). This is the
   * provider-NEUTRAL surface: the shipped local-file implementation (`performLocalClaim`,
   * `src/lib/assignment-local-store.ts`) actually returns the written `AssignmentClaimRecord`
   * directly, but a GitHub-backed `AssignmentProvider` cannot do the equivalent (the GitHub write
   * path is render-don't-execute — see assignment-provider-contract.md's "Implementation Note" —
   * so there is no synchronously-written record to hand back). Forcing every adapter to return a
   * record would leak the local-file adapter's shape into the neutral contract (#777 review
   * finding 1). A caller that wants the written record from an adapter that can supply one should
   * use that adapter's capability extension instead — see `LocalAssignmentProviderExt` below for
   * the local-file case.
   *
   * Same actor re-claiming before TTL expiry is idempotent; a different actor claiming an
   * already-`claimed` subject throws (AC7 — never silently overwritten; use `supersede`).
   */
  claim(subjectId: string, actor: ActorStruct, meta: AssignmentClaimMeta): void | Promise<void>;

  /**
   * Clear durable ownership and leave a handoff note. Returns `void` — same ADR 0021 §2 rationale
   * as `claim` above; re-read via `status()` to confirm the release took effect. `releasedBy:
   * null` performs an unconditional release (no ownership check); every other caller should pass
   * the releasing actor so ownership is verified before the record is cleared (AC6 — never
   * force-release a claim held by a different actor). `meta.tolerateNoActiveClaim` makes a missing
   * claim or an ownership mismatch a tolerated no-op instead of a thrown error.
   */
  release(subjectId: string, releasedBy: ActorStruct | null, meta?: AssignmentReleaseMeta): void | Promise<void>;

  /** Reassign ownership from a lapsed actor (`from`) to a successor (`to`), with an audit-trail
   * note. Returns `void` — same ADR 0021 §2 rationale as `claim` above. Throws when `from` does
   * not match the current holder — never force-reassigns a claim held by someone else. */
  supersede(subjectId: string, from: ActorStruct, to: ActorStruct, meta?: AssignmentSupersedeMeta): void | Promise<void>;

  /**
   * Read current assignment-layer state WITHOUT joining liveness — assignment-layer truth only
   * (assignment-provider-contract.md "AssignmentProvider Operations" / "The assignment ⋈
   * liveness join"). A caller that needs to know whether work is actually available must
   * additionally join this against `freshHolders` (`scripts/hooks/lib/liveness-read.js`, or a host's
   * `AssignmentLivenessSource`) via `computeEffectiveState` (this module) — this method alone never answers
   * that question; it deliberately mirrors the contract's own "never trust one layer alone"
   * framing rather than baking a join this interface does not own into its return shape.
   */
  status(subjectId: string): AssignmentStatus | Promise<AssignmentStatus>;

  /**
   * Enumerate subject ids currently claimed, optionally filtered to one actor's CANONICAL actor
   * key: `record.actor_key` when present, falling back to `serializeActor(record.actor)` only for
   * pre-`actor_key` records — the exact comparison `canonicalHolderActorKey()`
   * (this module) centralizes and `computeEffectiveState` already uses for
   * self-recognition (#777 review finding 3). A filter that instead re-serializes the actor struct
   * unconditionally, ignoring a present `actor_key`, gives the WRONG answer for an
   * explicit-override actor (assignment-provider-contract.md's `actor_key` field doc: a bare
   * canonical token vs. a re-derived `explicit-override:<value>:<host>` triple diverge for that
   * one actor shape) — adapters must delegate to `canonicalHolderActorKey()` (or an equivalent
   * provider-native rule that produces the same canonical key) rather than inventing their own
   * comparison.
   */
  list(actorKey?: string): string[] | Promise<string[]>;
}
