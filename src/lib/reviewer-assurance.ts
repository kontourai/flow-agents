/**
 * Reviewer actor assurance (#1092): how a critique's reviewer identity was established, recorded as
 * inputs from which a gate computes its decision.
 *
 * Every critique records `metadata.reviewer_assurance`:
 *
 *   {
 *     reviewer:    { session_ref, session_ref_source, resolved_by },
 *     implementer: { session_ref, session_ref_source } | null
 *   }
 *
 * The shape is meant to map onto the producer–verifier relation proposed upstream in
 * hachure-org/spec#37: `session_ref` is `actorIdentity.sessionRef`, and `session_ref_source`
 * records whether the caller chose the identity (`self_declared`) or the runtime derived it
 * (`runtime_derived`). Neither source is receipt-backed. No Flow Agents runtime issues an
 * authenticated delegation credential or an externally attested reviewer identity today, so
 * nothing here records or computes one.
 *
 * From those inputs:
 *
 * - `verifierRelation` takes the first value that applies, in #37's order: `same-session` when both
 *   session refs are present and equal, otherwise `undetermined`. Without receipt-backed identity
 *   on both ends the relation can never be `independent`.
 * - The assurance level is `caller-asserted` for a `self_declared` reviewer identity (a
 *   FLOW_AGENTS_ACTOR override, or a free-form `--reviewer` label on the sidecar writer), and
 *   `runtime-derived` for one the runtime session id, CI job identity, or process ancestry produced.
 *   `runtime-derived` is coordination-level separation, not authentication: a process that
 *   rewrites its runtime session variables can still impersonate another session.
 *
 * A kit declares the minimum level its critique binding requires; a gate refuses a `same-session`
 * relation and any level below that minimum.
 */
export const REVIEWER_ASSURANCE_LEVELS = ["caller-asserted", "runtime-derived"] as const;
export type ReviewerAssuranceLevel = typeof REVIEWER_ASSURANCE_LEVELS[number];

export type SessionRefSource = "self_declared" | "runtime_derived";
export type VerifierRelation = "same-session" | "undetermined";

export interface ReviewerSessionIdentity {
  session_ref: string;
  session_ref_source: SessionRefSource;
  /** The resolver source or writer path that produced `session_ref`, for audit. */
  resolved_by?: string;
}

export interface ReviewerAssurance {
  reviewer: ReviewerSessionIdentity;
  implementer: ReviewerSessionIdentity | null;
}

export function isReviewerAssuranceLevel(value: unknown): value is ReviewerAssuranceLevel {
  return typeof value === "string" && (REVIEWER_ASSURANCE_LEVELS as readonly string[]).includes(value);
}

/** How an actor-identity resolver `source` established the identity. */
export function sessionRefSourceForActorSource(source: string): SessionRefSource {
  if (source === "process-ancestry" || /^runtime-session-id:/.test(source) || /^ci-runtime:/.test(source)) return "runtime_derived";
  // `explicit-override` and anything unrecognised: the caller could have chosen it.
  return "self_declared";
}

function sessionIdentity(value: unknown): ReviewerSessionIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.session_ref !== "string" || record.session_ref.length === 0) return null;
  if (record.session_ref_source !== "self_declared" && record.session_ref_source !== "runtime_derived") return null;
  return { session_ref: record.session_ref, session_ref_source: record.session_ref_source, ...(typeof record.resolved_by === "string" ? { resolved_by: record.resolved_by } : {}) };
}

/** The relation between the reviewer and the implementer, computed in hachure-org/spec#37's order. */
export function reviewerVerifierRelation(recorded: unknown): VerifierRelation {
  const record = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded as Record<string, unknown> : {};
  const reviewer = sessionIdentity(record.reviewer);
  const implementer = sessionIdentity(record.implementer);
  if (reviewer && implementer && reviewer.session_ref === implementer.session_ref) return "same-session";
  return "undetermined";
}

/** The assurance level the recorded reviewer identity provides, or `null` when it was not recorded. */
export function reviewerAssuranceLevel(recorded: unknown): ReviewerAssuranceLevel | null {
  const record = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded as Record<string, unknown> : {};
  const reviewer = sessionIdentity(record.reviewer);
  if (!reviewer) return null;
  return reviewer.session_ref_source === "runtime_derived" ? "runtime-derived" : "caller-asserted";
}

/**
 * True when a recorded assurance satisfies a required minimum level. A `same-session` relation never
 * does, and neither does a missing or malformed record.
 */
export function reviewerAssuranceMeets(recorded: unknown, required: ReviewerAssuranceLevel): boolean {
  if (reviewerVerifierRelation(recorded) === "same-session") return false;
  const level = reviewerAssuranceLevel(recorded);
  if (!level) return false;
  return REVIEWER_ASSURANCE_LEVELS.indexOf(level) >= REVIEWER_ASSURANCE_LEVELS.indexOf(required);
}

/** One-line description of a recorded assurance for refusal messages. */
export function describeReviewerAssurance(recorded: unknown): string {
  const record = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded as Record<string, unknown> : {};
  const reviewer = sessionIdentity(record.reviewer);
  if (!reviewer) return "no recorded reviewer identity";
  return `reviewer identity ${reviewer.session_ref_source}${reviewer.resolved_by ? ` (${reviewer.resolved_by})` : ""}, relation ${reviewerVerifierRelation(recorded)}`;
}
