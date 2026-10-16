/**
 * The GitHub provider for the assignment primitive: pure, render-don't-execute.
 * Published as `@kontourai/flow-agents/assignment-github`.
 *
 * Every function here is a pure transformation. The `render*` functions return the exact `gh`
 * argv arrays and claim-comment body for a mutation as DATA; the caller (a skill, a host) runs
 * them. The parse functions read an already-fetched issue document and return an
 * `AssignmentStatus`. Nothing here imports `fs` or `child_process`, or invokes `gh`.
 *
 * Why this is a separate module from `assignment-model.ts`: the GitHub shape (issue numbers,
 * labels, a marker comment, an `owner/repo#number` `work_item_ref`) is one provider's mapping of
 * the primitive, not the primitive. The `work_item_ref` validation in `render*` lives here and
 * nowhere in the core types or the join. Builder Kit policy (when to claim, release, or resume a
 * takeover) is not here either; see `assignment-model.ts` and
 * `docs/architecture-engine-and-kits.md`.
 *
 * Claim-comment text is attacker-postable (anyone who can comment can forge a marker comment), so
 * every string a parsed record exposes passes through a control-character strip and length cap
 * before it leaves this module. That is display-only and never changes the join's classification.
 *
 * @module
 */
import {
  serializeActor,
  sanitizeSegment,
  decodeAssignmentClaimRecord,
  type ActorStruct,
  type AssignmentAuditEntry,
  type AssignmentClaimRecord,
  type AssignmentStatus,
} from "./assignment-model.js";

type AnyObj = Record<string, unknown>;

/** GitHub's extension of the neutral assignment read: the label and claim-comment metadata the
 * provider can prove natively. */
export type GithubAssignmentStatus = AssignmentStatus & {
  has_claim_label?: boolean;
  claim_comment_author?: string | null;
  claim_comment_id?: string | null;
  repository?: { owner: string; name: string } | null;
  issue_number?: number | null;
};

export type GithubIssueDoc = {
  number?: number;
  assignees?: Array<{ login?: string } | string>;
  labels?: Array<{ name?: string } | string>;
  comments?: Array<{ id?: string | number; body?: string; author?: { login?: string } | string; createdAt?: string }>;
  state?: string;
};

export type RenderClaimInput = {
  repo?: { owner?: string; name?: string };
  issue_number?: number;
  assignee_login?: string;
  existing_assignee_login?: string;
  label_name?: string;
  claim_comment_marker?: string;
  ttl_seconds?: number;
  branch?: string;
  artifact_dir?: string;
  actor_key?: string;
  work_item_ref?: string;
  existing_comment_id?: number;
  previous_record?: AssignmentClaimRecord;
  reason?: string;
};

export type AssignmentRenderResult = {
  role: "AssignmentRenderResult";
  transition: "claim" | "release" | "supersede";
  subject_id: string;
  gh_commands: string[][];
  claim_comment_body: string;
  record?: AssignmentClaimRecord;
};

/** Default claim label name (`policy.label_name`). */
export const GITHUB_CLAIM_LABEL_DEFAULT = "agent:claimed";
/** Default marker locating the machine-readable claim comment (`policy.claim_comment_marker`). */
export const GITHUB_CLAIM_COMMENT_MARKER_DEFAULT = "<!-- flow-agents:assignment-claim -->";

/** Same format as the CLI's `isoNow()`: UTC, whole seconds. */
function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function namesOf(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => typeof item === "string" ? item : (item && typeof item === "object" ? String((item as AnyObj)[key] ?? "") : "")).filter(Boolean);
}

/**
 * F2 fix (fix-plan iteration 1, HIGH): every string field on a GitHub claim record is sourced
 * from a parsed, attacker-postable issue comment (any GitHub user who can comment can forge a
 * claim-marker comment with a hostile fenced JSON block — commenting requires no elevated
 * access, unlike the assignee/label mutations this contract otherwise gates). Mirrors
 * workflow-sidecar.ts's `stripControlCharsForDisplay` (the established #287/#320 mitigation for
 * exactly this class of untrusted multi-writer/attacker-postable display input): strips C0
 * (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F, which includes ANSI-CSI-adjacent bytes), then caps
 * length (this repo's 64/240 convention: 64 for id-like fields, 240 for free text). Display-only
 * — sanitizing the string CONTENT never changes presence/emptiness for any well-formed value, so
 * it does not perturb computeEffectiveState()'s human-assignee presence gate or any equality
 * check downstream.
 */
function sanitizeDisplayField(value: unknown, maxLength: number): string {
  const stripped = String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped;
}

function sanitizeActorForDisplay(actor: ActorStruct): ActorStruct {
  return {
    runtime: sanitizeDisplayField(actor.runtime, 64),
    session_id: sanitizeDisplayField(actor.session_id, 64),
    host: sanitizeDisplayField(actor.host, 64),
    human: actor.human != null ? sanitizeDisplayField(actor.human, 240) : (actor.human ?? null),
  };
}

function sanitizeAuditEntryForDisplay(entry: AssignmentAuditEntry): AssignmentAuditEntry {
  return {
    ...entry,
    from_actor: entry.from_actor ? sanitizeActorForDisplay(entry.from_actor) : (entry.from_actor ?? null),
    to_actor: entry.to_actor ? sanitizeActorForDisplay(entry.to_actor) : (entry.to_actor ?? null),
    reason: entry.reason != null ? sanitizeDisplayField(entry.reason, 240) : entry.reason,
  };
}

/**
 * The single choke point (per the code review's explicit recommendation) every parsed GitHub
 * claim record passes through before any string in it leaves this module in any form — both
 * `status`/`list`'s JSON output (this fix) and any future consumer of `extractGithubClaimRecord`'s
 * return value inherit clean values from here, mirroring the #320 `computeConflict()` precedent
 * of sanitizing once at construction rather than at each print site.
 */
function sanitizeClaimRecordForDisplay(record: AssignmentClaimRecord): AssignmentClaimRecord {
  return {
    ...record,
    subject_id: sanitizeDisplayField(record.subject_id, 64),
    actor_key: record.actor_key != null ? sanitizeDisplayField(record.actor_key, 260) : record.actor_key,
    work_item_ref: record.work_item_ref != null ? sanitizeDisplayField(record.work_item_ref, 240) : record.work_item_ref,
    branch: sanitizeDisplayField(record.branch, 240),
    artifact_dir: sanitizeDisplayField(record.artifact_dir, 240),
    actor: sanitizeActorForDisplay(record.actor),
    audit_trail: Array.isArray(record.audit_trail) ? record.audit_trail.map(sanitizeAuditEntryForDisplay) : record.audit_trail,
  };
}

/**
 * Locate the machine-readable claim comment among human comments (via the fixed marker) and
 * extract/validate its fenced JSON block. Fails loud on an unparseable or misversioned record —
 * never silently treats a corrupt comment as "no claim" (same rationale as readLocalRecord()).
 * The returned record's display-surfaced string fields are sanitized (F2 fix, above) before
 * return — this is the single choke point, so schema/role/status checks above still validate
 * the RAW parsed shape (never weakened), and only the string fields are transformed afterward.
 */
export function extractGithubClaimRecord(issue: GithubIssueDoc, marker: string): {
  record: AssignmentClaimRecord;
  author: string | null;
  commentId: string | null;
} | null {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  const candidates = comments.filter((comment) => String(comment.body ?? "").includes(marker));
  if (candidates.length === 0) return null;
  let selected = candidates[0];
  if (candidates.length > 1) {
    const timestamped = candidates.map((comment) => {
      const timestamp = typeof comment.createdAt === "string" ? Date.parse(comment.createdAt) : Number.NaN;
      if (!Number.isFinite(timestamp)) {
        throw new Error(`multiple claim comments require a valid createdAt timestamp on every marker comment (id ${comment.id ?? "?"})`);
      }
      return { comment, timestamp };
    });
    const latestTimestamp = Math.max(...timestamped.map(({ timestamp }) => timestamp));
    const latest = timestamped.filter(({ timestamp }) => timestamp === latestTimestamp);
    if (latest.length !== 1) {
      throw new Error(`multiple claim comments share the latest createdAt timestamp ${new Date(latestTimestamp).toISOString()}; claim selection is ambiguous`);
    }
    selected = latest[0].comment;
  }

  const body = String(selected.body ?? "");
  const markerIndex = body.indexOf(marker);
  const fenceMatch = body.slice(markerIndex).match(/```json\s*([\s\S]*?)```/);
  if (!fenceMatch) throw new Error(`claim comment (id ${selected.id ?? "?"}) has the claim marker but no fenced JSON block`);
  const label = `claim comment (id ${selected.id ?? "?"})`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (error) {
    throw new Error(`${label} fenced JSON is unparseable: ${(error as Error).message}`);
  }
  // The shared codec owns the schema_version / role gate (checked on the RAW parsed shape, before
  // any display sanitizing), so a host and this parser reject exactly the same records.
  const decoded = decodeAssignmentClaimRecord(parsed, { requireRole: true });
  if (!decoded.ok) {
    if (decoded.code === "not_an_object") throw new Error(`${label} fenced JSON is not an object`);
    if (decoded.code === "unsupported_schema_version") throw new Error(`${label} has unsupported schema_version ${decoded.found}`);
    if (decoded.code === "unexpected_role") throw new Error(`${label} has unexpected role ${decoded.found}`);
    throw new Error(`${label} fenced JSON is unparseable: ${decoded.detail}`);
  }
  const record = decoded.record;
  const author = typeof selected.author === "string" ? selected.author : selected.author?.login;
  return {
    record: sanitizeClaimRecordForDisplay(record),
    author: author ? String(author) : null,
    commentId: selected.id != null ? String(selected.id) : null,
  };
}

export function githubAssignmentStatus(issue: GithubIssueDoc, labelName: string, marker: string): GithubAssignmentStatus {
  const assignees = namesOf(issue.assignees, "login");
  const labels = namesOf(issue.labels, "name");
  const selectedClaim = extractGithubClaimRecord(issue, marker);
  const record = selectedClaim?.record ?? null;
  return {
    subject_id: record?.subject_id ?? "",
    provider: "github",
    assignee: assignees[0] ?? null,
    record,
    has_claim_label: labels.map((label) => label.toLowerCase()).includes(labelName.toLowerCase()),
    claim_comment_author: selectedClaim?.author ?? null,
    claim_comment_id: selectedClaim?.commentId ?? null,
  };
}

function requireRepo(input: RenderClaimInput): { owner: string; name: string } {
  const repo = input.repo;
  if (!repo || !repo.owner || !repo.name) throw new Error("input-json.repo.owner and input-json.repo.name are required");
  return { owner: repo.owner, name: repo.name };
}

function requireIssueNumber(input: RenderClaimInput): number {
  const issueNumber = input.issue_number;
  if (!Number.isFinite(issueNumber)) throw new Error("input-json.issue_number is required");
  return Number(issueNumber);
}

function requireRenderedClaimProvenance(
  input: RenderClaimInput,
  actor: ActorStruct,
  repo: { owner: string; name: string },
  issueNumber: number,
): { actorKey: string; workItemRef: string } {
  const actorKey = input.actor_key;
  if (typeof actorKey !== "string" || !actorKey || actorKey !== actorKey.trim()) {
    throw new Error("input-json.actor_key is required and must be the exact canonical actor key");
  }
  const expectedActorKey = actor.runtime === "explicit-override"
    ? sanitizeSegment(actor.session_id)
    : serializeActor(actor);
  if (actorKey !== expectedActorKey) {
    throw new Error(`input-json.actor_key must exactly match the canonical actor JSON identity (${expectedActorKey})`);
  }

  const workItemRef = input.work_item_ref;
  const expectedWorkItemRef = `${repo.owner}/${repo.name}#${issueNumber}`;
  if (typeof workItemRef !== "string" || workItemRef !== expectedWorkItemRef) {
    throw new Error(`input-json.work_item_ref must exactly match ${expectedWorkItemRef}`);
  }
  return { actorKey, workItemRef };
}

export function renderGithubClaimCommentBody(record: AssignmentClaimRecord, marker: string): string {
  const humanNote = record.actor.human ? `Assigned to human ${record.actor.human}.` : `Claimed by an automated agent session (${record.actor.runtime}).`;
  return [
    marker,
    `**Assignment claim** — ${humanNote}`,
    "",
    `- actor: \`${serializeActor(record.actor)}\``,
    `- claimed_at: ${record.claimed_at}`,
    `- ttl_seconds: ${record.ttl_seconds}`,
    `- branch: \`${record.branch}\``,
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
  ].join("\n");
}

export function renderGithubClaim(
  subjectId: string,
  input: RenderClaimInput,
  actor: ActorStruct,
  claimedAt: string = isoNow(),
): AssignmentRenderResult {
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const { actorKey, workItemRef } = requireRenderedClaimProvenance(input, actor, repo, issueNumber);
  const labelName = input.label_name ?? GITHUB_CLAIM_LABEL_DEFAULT;
  const marker = input.claim_comment_marker ?? GITHUB_CLAIM_COMMENT_MARKER_DEFAULT;
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const branch = input.branch;
  const artifactDir = input.artifact_dir;
  if (!branch) throw new Error("input-json.branch is required for render-claim");
  if (!artifactDir) throw new Error("input-json.artifact_dir is required for render-claim");

  const record: AssignmentClaimRecord = {
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: subjectId,
    actor,
    actor_key: actorKey,
    work_item_ref: workItemRef,
    claimed_at: claimedAt,
    ttl_seconds: ttlSeconds,
    branch,
    artifact_dir: artifactDir,
    status: "claimed",
  };
  const repoSlug = `${repo.owner}/${repo.name}`;
  const commentBody = renderGithubClaimCommentBody(record, marker);
  const ghCommands: string[][] = [];
  if (input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-assignee", input.assignee_login]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-label", labelName]);
  ghCommands.push(
    input.existing_comment_id
      ? ["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${commentBody}`]
      : ["gh", "issue", "comment", String(issueNumber), "--repo", repoSlug, "--body", commentBody],
  );
  return { role: "AssignmentRenderResult", transition: "claim", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: commentBody, record };
}

function renderHandoffCommentBody(subjectId: string, input: RenderClaimInput, at: string): string {
  const marker = input.claim_comment_marker ?? GITHUB_CLAIM_COMMENT_MARKER_DEFAULT;
  const record = input.previous_record
    ? {
      ...input.previous_record,
      status: "released" as const,
      audit_trail: [...(input.previous_record.audit_trail ?? []), { at, transition: "release" as const, from_actor: input.previous_record.actor, to_actor: null, reason: input.reason ?? "released" }],
    }
    : null;
  const lines = [marker, `**Assignment released** — subject \`${subjectId}\` is free.`];
  if (record) lines.push("", "```json", JSON.stringify(record, null, 2), "```");
  return lines.join("\n");
}

/**
 * Render the `gh` argv and handoff comment that release a GitHub claim: unassign, drop the label,
 * and rewrite the claim comment (in place when `existing_comment_id` is given) as a released
 * record. Pure; the caller runs the argv.
 */
export function renderGithubRelease(subjectId: string, input: RenderClaimInput, at: string = isoNow()): AssignmentRenderResult {
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const labelName = input.label_name ?? GITHUB_CLAIM_LABEL_DEFAULT;
  const repoSlug = `${repo.owner}/${repo.name}`;
  const ghCommands: string[][] = [];
  const assigneeLogin = input.existing_assignee_login ?? input.assignee_login;
  if (assigneeLogin) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-assignee", assigneeLogin]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-label", labelName]);
  const handoffBody = renderHandoffCommentBody(subjectId, input, at);
  ghCommands.push(
    input.existing_comment_id
      ? ["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${handoffBody}`]
      : ["gh", "issue", "comment", String(issueNumber), "--repo", repoSlug, "--body", handoffBody],
  );
  return { role: "AssignmentRenderResult", transition: "release", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: handoffBody };
}

/**
 * Render the `gh` argv that reassign a GitHub claim to `toActor`, editing the existing claim
 * comment in place (never duplicating it) with an audit-trail entry. Pure; the caller runs the argv.
 */
export function renderGithubSupersede(subjectId: string, input: RenderClaimInput, toActor: ActorStruct, at: string = isoNow()): AssignmentRenderResult {
  const repo = requireRepo(input);
  const issueNumber = requireIssueNumber(input);
  const { actorKey, workItemRef } = requireRenderedClaimProvenance(input, toActor, repo, issueNumber);
  const labelName = input.label_name ?? GITHUB_CLAIM_LABEL_DEFAULT;
  const marker = input.claim_comment_marker ?? GITHUB_CLAIM_COMMENT_MARKER_DEFAULT;
  const ttlSeconds = input.ttl_seconds ?? 1800;
  const branch = input.branch;
  const artifactDir = input.artifact_dir;
  if (!branch) throw new Error("input-json.branch is required for render-supersede");
  if (!artifactDir) throw new Error("input-json.artifact_dir is required for render-supersede");
  // Wave 4 AC: render-supersede must edit the existing claim comment in place, never duplicate it.
  if (!input.existing_comment_id) throw new Error("input-json.existing_comment_id is required for render-supersede (edits the claim comment in place; never duplicates it)");

  const previousActor = input.previous_record?.actor ?? null;
  const record: AssignmentClaimRecord = {
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: subjectId,
    actor: toActor,
    actor_key: actorKey,
    work_item_ref: workItemRef,
    claimed_at: at,
    ttl_seconds: ttlSeconds,
    branch,
    artifact_dir: artifactDir,
    status: "claimed",
    audit_trail: [...(input.previous_record?.audit_trail ?? []), { at, transition: "supersede", from_actor: previousActor, to_actor: toActor, reason: input.reason ?? "supersede" }],
  };
  const repoSlug = `${repo.owner}/${repo.name}`;
  const commentBody = renderGithubClaimCommentBody(record, marker);
  const ghCommands: string[][] = [];
  const previousAssignee = input.existing_assignee_login;
  if (previousAssignee && previousAssignee !== input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--remove-assignee", previousAssignee]);
  if (input.assignee_login) ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-assignee", input.assignee_login]);
  ghCommands.push(["gh", "issue", "edit", String(issueNumber), "--repo", repoSlug, "--add-label", labelName]);
  ghCommands.push(["gh", "api", "--method", "PATCH", `repos/${repoSlug}/issues/comments/${input.existing_comment_id}`, "-f", `body=${commentBody}`]);
  return { role: "AssignmentRenderResult", transition: "supersede", subject_id: subjectId, gh_commands: ghCommands, claim_comment_body: commentBody, record };
}
