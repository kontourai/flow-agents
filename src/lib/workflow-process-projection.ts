import * as fs from "node:fs";
import * as path from "node:path";

// Flow Agents workflow-state status vocabulary (schemas/workflow-state.schema.json,
// mirrored in src/cli/workflow-sidecar.ts's `statuses` set).
export type WorkflowTaskStatus =
  | "new"
  | "planning"
  | "planned"
  | "in_progress"
  | "blocked"
  | "verifying"
  | "verified"
  | "needs_decision"
  | "not_verified"
  | "failed"
  | "delivered"
  | "canceled"
  | "accepted"
  | "archived";

export type WorkflowNextActionStatus = "continue" | "needs_user" | "blocked" | "done";

/**
 * Console's process operating-state vocabulary (console#229/#236,
 * docs/specs/projection-schema.md `ProcessStatusProjection.status` /
 * console-core `ConsoleProcessStatus`). Kept an open union like Console's own
 * type: a projector may emit these canonical members, and consumers that do
 * not recognize a value still have a plain string to render.
 */
export type ConsoleProcessStatus =
  | "not_started"
  | "running"
  | "paused"
  | "blocked"
  | "waiting"
  | "needs_input"
  | "review_pending"
  | "completed"
  | "failed"
  | "cancelled"
  | string;

export type WorkflowStateSidecar = {
  schema_version: "1.0";
  task_slug: string;
  status: WorkflowTaskStatus;
  phase: string;
  updated_at?: string;
  next_action: {
    status: WorkflowNextActionStatus;
    summary: string;
  };
};

export type WorkflowHandoffSidecar = {
  task_slug: string;
  summary: string;
  blockers?: string[];
};

/**
 * A critique claim as read back from trust.bundle by workflow-sidecar.ts's
 * `critiquesFromBundle` (the AUTHORITATIVE critique source -- critique.json is
 * retired historical residue, see readWorkflowProcessSources below). Only the
 * fields this module's pure derivation needs; the real reader returns more.
 */
export type BundleCritique = {
  verdict?: unknown;
  superseded_by?: unknown;
  workflow_subject_ref?: unknown;
};

export type WorkflowProcessSource = {
  path: string;
  relativePath: string;
  slug: string;
  state: WorkflowStateSidecar;
  handoff?: WorkflowHandoffSidecar;
  /**
   * Pre-computed by the CLI layer (console-process-projection.ts), which is
   * the only layer allowed to import workflow-sidecar.ts's trust.bundle
   * reader (src/lib must not import src/cli -- see that file's join step).
   * Absent/undefined means "no bundle-derived signal available" (e.g. a unit
   * test exercising the pure mapper directly), NOT "definitely false".
   */
  hasUnresolvedCritique?: boolean;
};

export type ConsoleProjectionRef = {
  product: string;
  kind: string;
  id: string;
  label?: string;
};

export type ConsoleProjectionScope = {
  kind: string;
  id: string;
};

export type ConsoleProcessProjection = {
  id: string;
  family: "workflow";
  nonAuthority: true;
  subjectRef: ConsoleProjectionRef;
  sourceRef: ConsoleProjectionRef;
  summary: string;
  status: ConsoleProcessStatus;
  blockedReason?: string;
  extensions: {
    "flow-agents": {
      task_slug: string;
      workflow_status: WorkflowTaskStatus;
      phase: string;
      next_action_status: WorkflowNextActionStatus;
      has_unresolved_critique?: boolean;
      updated_at?: string;
      source_path: string;
    };
  };
};

export type ConsoleProcessProjectionEnvelope = {
  schema: "kontour.console.projection";
  version: "0.1";
  generatedAt: string;
  scope: ConsoleProjectionScope;
  producer: {
    id: string;
    product: "flow-agents";
  };
  derivedFrom: {
    mode: "direct_snapshot";
    eventHistory: "unavailable";
    directSnapshot: {
      id: string;
      emittedAt: string;
      producer: {
        id: string;
        product: "flow-agents";
      };
      reason: string;
      sourceRef: ConsoleProjectionRef;
    };
  };
  processes: ConsoleProcessProjection[];
};

export type BuildWorkflowProcessProjectionOptions = {
  scope: string | ConsoleProjectionScope;
  generatedAt?: string;
  producer?: {
    id?: string;
    product?: "flow-agents";
  };
};

export type ReadWorkflowProcessSourcesResult = {
  sources: WorkflowProcessSource[];
  warnings: string[];
};

const KNOWN_STATUSES = new Set<WorkflowTaskStatus>([
  "new",
  "planning",
  "planned",
  "in_progress",
  "blocked",
  "verifying",
  "verified",
  "needs_decision",
  "not_verified",
  "failed",
  "delivered",
  "canceled",
  "accepted",
  "archived",
]);
const KNOWN_NEXT_ACTION_STATUSES = new Set<WorkflowNextActionStatus>(["continue", "needs_user", "blocked", "done"]);
const SKIPPED_ROOT_ENTRIES = new Set(["archive", "changes", "delivery-history", "liveness"]);
const MAX_SIDECAR_BYTES = 1024 * 1024;

/**
 * Workflow status -> Console process status mapping table (issue #778).
 *
 * Grounding for each entry:
 * - `new` -> `not_started`: direct semantic match, no work has begun.
 * - `planning`/`planned`/`in_progress`/`verifying` -> `running`: all four are
 *   "active WIP" per docs/workflow-artifact-lifecycle.md's Current-State
 *   Semantics table; `verifying` in particular is the agent actively
 *   performing verification, not a human-wait state by itself.
 * - `blocked` -> `blocked`: exact literal match already in Console's own
 *   vocabulary (console-core ConsoleProcessStatus).
 * - `needs_decision` -> `needs_input`: `needs_decision` means the workflow
 *   needs an explicit human decision (docs/workflow-artifact-lifecycle.md
 *   "Learning Closeout", "Prevention Rules" #4) -- the closest 1:1 match to
 *   Console's interactive-session "needs_input" state.
 * - `not_verified` -> `needs_input`: grounded directly in-repo --
 *   context/scripts/hooks/workflow-steering.js co-buckets `not_verified` with
 *   `needs_decision` and `next_action.status === "needs_user"` under the SAME
 *   condition (lines ~397, ~567: `next.status === 'needs_user' ||
 *   state.status === 'needs_decision' || state.status === 'not_verified'`),
 *   i.e. this repo already treats the two as the same "needs a human" bucket.
 * - `verified` -> `running` (default): per docs/workflow-artifact-lifecycle.md,
 *   `verified` alone is not terminal ("Local evidence passed, but release,
 *   final acceptance, or learning is not closed" -- an active shepherding
 *   candidate). `mapWorkflowStatusToConsoleProcessStatus` refines this to
 *   `completed` when `next_action.status === "done"` (the second row of that
 *   same table: "Evidence passed and the next phase was completed").
 * - `failed` -> `failed`: exact literal match.
 * - `delivered`/`accepted`/`archived` -> `completed`: all three are terminal
 *   "Completed local workflow" rows in the same lifecycle table.
 * - `canceled` -> `cancelled`: same concept; flow-agents uses the US spelling,
 *   Console's vocabulary uses the double-L spelling -- the mapper normalizes
 *   this rather than emitting a string Console's board would not recognize.
 *
 * No `state.json` status value maps cleanly onto Console's `review_pending`,
 * `waiting`, or `paused` -- flagged as a gap (see docs/integrations/
 * flow-agents-console.md). `review_pending` is derived separately in
 * `mapWorkflowStatusToConsoleProcessStatus` from the AUTHORITATIVE
 * trust.bundle critique state (`hasUnresolvedLiveCritique`), not from
 * `status` alone -- critique.json is retired and is never read (review
 * finding, issue #778).
 */
export const WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS: Readonly<Record<WorkflowTaskStatus, ConsoleProcessStatus>> = {
  new: "not_started",
  planning: "running",
  planned: "running",
  in_progress: "running",
  blocked: "blocked",
  verifying: "running",
  verified: "running",
  needs_decision: "needs_input",
  not_verified: "needs_input",
  failed: "failed",
  delivered: "completed",
  canceled: "cancelled",
  accepted: "completed",
  archived: "completed",
};

/**
 * Pure review_pending signal (issue #778 review finding 1): given the LIVE
 * (non-superseded) critique claims already read from trust.bundle by
 * workflow-sidecar.ts's `critiquesFromBundle` -- the authoritative critique
 * source; critique.json is retired and unsupported historical residue (see
 * the Phase 4c comment above workflow-sidecar.ts's readBundleState) -- true
 * when at least one is NOT a passing verdict.
 *
 * Semantics: a critique claim only exists in the bundle because a review
 * actually happened (record-critique was run). A live claim whose verdict is
 * "fail" or "not_verified" is, by construction, an outstanding review action
 * nothing has resolved yet -- that is Console's `review_pending` (a human
 * reviewer's verdict is not yet a clean pass). trust.bundle's critique claims
 * carry no separate "required" boolean (that concept lived only on the
 * retired critique.json wrapper, and belongs to Flow gate policy, not to an
 * individual critique record) -- a live, non-passing critique is inherently
 * outstanding, so "required" is not a separate condition here. A critique
 * marked `superseded_by` (resolved via `resolve-critique`) is excluded: it is
 * history, not a pending action (mirrors the `liveCritiques` filter
 * workflow-sidecar.ts itself uses at record-gate-claim time).
 */
export function hasUnresolvedLiveCritique(critiques: BundleCritique[]): boolean {
  return critiques.some((critique) => {
    const supersededBy = critique.superseded_by;
    const isSuperseded = typeof supersededBy === "string" && supersededBy.length > 0;
    if (isSuperseded) return false;
    return critique.verdict !== "pass";
  });
}

const SESSION_SUBJECT_REF_PREFIX = "flow-agents://session/";

/**
 * Join-key identity check for bundle-derived critiques (issue #778 review
 * finding 3): a `critiquesFromBundle()` entry stamped with a
 * `workflow_subject_ref` in the `flow-agents://session/<slug>` form that
 * names a DIFFERENT slug than this session's own directory is a stale or
 * misplaced signal and must never be silently trusted to drive this
 * session's review_pending status -- skip it and report why, don't force
 * review_pending (or silently swallow it either). A ref that is absent, or
 * bound to a work-item (any other shape), cannot be confidently compared to
 * a slug and is passed through unchanged: this is a confident-mismatch-only
 * filter, not an allowlist.
 */
export function filterCritiquesForSlug<T extends BundleCritique>(critiques: T[], slug: string): { critiques: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const kept = critiques.filter((critique) => {
    const ref = critique.workflow_subject_ref;
    if (typeof ref !== "string" || !ref.startsWith(SESSION_SUBJECT_REF_PREFIX)) return true;
    const refSlug = ref.slice(SESSION_SUBJECT_REF_PREFIX.length);
    if (refSlug === slug) return true;
    warnings.push(`${slug}: trust.bundle critique workflow_subject_ref names a different session ('${refSlug}') -- skipping this critique's contribution to review_pending`);
    return false;
  });
  return { critiques: kept, warnings };
}

/**
 * Pure status mapper (issue #778 AC): workflow status + next_action.status +
 * a bundle-derived "has an unresolved live critique" boolean (see
 * `hasUnresolvedLiveCritique`) -> Console `ConsoleProcessStatus`.
 *
 * Refinements over the base table:
 * - `verified` + `next_action.status === "done"` -> `completed` (the workflow
 *   lifecycle doc's second `verified` row: the next phase already closed).
 * - Any non-terminal status + `hasUnresolvedCritique === true` -> `review_pending`,
 *   overriding the base mapping. Terminal statuses (`completed`, `failed`,
 *   `cancelled`) are never overridden by a critique signal -- a workflow that
 *   already finished, failed, or was cancelled does not become "review
 *   pending" because of history in the bundle.
 */
export function mapWorkflowStatusToConsoleProcessStatus(
  status: WorkflowTaskStatus,
  nextActionStatus?: WorkflowNextActionStatus,
  hasUnresolvedCritique?: boolean,
): ConsoleProcessStatus {
  let mapped: ConsoleProcessStatus = WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS[status] ?? "running";
  if (status === "verified" && nextActionStatus === "done") mapped = "completed";

  const isTerminal = mapped === "completed" || mapped === "failed" || mapped === "cancelled";
  if (!isTerminal && hasUnresolvedCritique === true) mapped = "review_pending";

  return mapped;
}

// console#236's own clearing rule (console-core current-operating-state.ts):
// blockedReason is cleared whenever the incoming status is not one of these
// five -- so it is RETAINED for all five, not just the three this projector
// currently has concrete signals for. `waiting`/`paused` have no producing
// workflow-status mapping today (flagged in the table doc comment above), but
// the CONTRACT still applies to them: a caller that ever supplies a reason
// for a waiting/paused process must not have it silently dropped here.
const BLOCKED_REASON_ELIGIBLE_STATUSES = new Set<ConsoleProcessStatus>(["blocked", "needs_input", "review_pending", "waiting", "paused"]);

/**
 * Pure blockedReason derivation (issue #778 AC): mirrors console#236's own
 * clearing rule -- retained for blocked/needs_input/review_pending/waiting/
 * paused, cleared (undefined) for every other status -- so a stale reason
 * never survives a transition out of an interactive-session state, and (per
 * review finding 2) a status the contract covers is never force-cleared just
 * because today's mapper does not yet have a concrete signal for it.
 *
 * Sourcing, by projected `consoleStatus`:
 * - `blocked`: prefer `handoff.json.blockers` (schemas/workflow-handoff.schema.json
 *   -- the purpose-built field for this), joined with "; ". Falls back to
 *   `state.json.next_action.summary` when `next_action.status === "blocked"`
 *   (schema requires a non-empty summary) and no handoff blockers exist.
 * - `needs_input`: `state.json.next_action.summary` when
 *   `next_action.status === "needs_user"` -- the field that already answers
 *   "what does the human need to do". Falls back to a generic, status-derived
 *   sentence so `needs_input` never ships without SOME reason text.
 * - `review_pending`: a fixed, honest sentence -- trust.bundle's critique
 *   claims carry no free-text reason field, so nothing is fabricated beyond
 *   the fact that a live critique has not resolved to a pass.
 * - `waiting`/`paused`: no producing signal exists today (see the status
 *   table doc comment); falls back to `next_action.summary` when present so a
 *   future caller that does supply one is not silently dropped, per the
 *   retained-not-cleared contract above.
 * - anything else: `undefined` (no blockedReason emitted).
 */
export function deriveConsoleProcessBlockedReason(
  consoleStatus: ConsoleProcessStatus,
  input: {
    nextActionStatus?: WorkflowNextActionStatus;
    nextActionSummary?: string;
    workflowStatus?: WorkflowTaskStatus;
    handoffBlockers?: string[];
  },
): string | undefined {
  if (!BLOCKED_REASON_ELIGIBLE_STATUSES.has(consoleStatus)) return undefined;

  if (consoleStatus === "blocked") {
    const blockers = (input.handoffBlockers ?? []).filter((entry) => entry.trim().length > 0);
    if (blockers.length > 0) return blockers.join("; ");
    if (input.nextActionStatus === "blocked" && input.nextActionSummary) return input.nextActionSummary;
    return undefined;
  }
  if (consoleStatus === "needs_input") {
    if (input.nextActionStatus === "needs_user" && input.nextActionSummary) return input.nextActionSummary;
    if (input.workflowStatus === "needs_decision") return "workflow status is needs_decision: a human decision is required before this session can continue";
    if (input.workflowStatus === "not_verified") return "workflow status is not_verified: verification did not pass and needs human attention";
    return input.nextActionSummary;
  }
  if (consoleStatus === "review_pending") {
    return "an independent review is required and has not yet recorded a verdict (trust.bundle carries an unresolved live critique)";
  }
  // waiting / paused: retained-not-cleared contract, no dedicated signal yet.
  return input.nextActionSummary;
}

/**
 * Reads state.json (required) + handoff.json (optional) per session directory.
 * Does NOT read critique.json (retired, see the module doc comment) or
 * trust.bundle (that requires workflow-sidecar.ts's `critiquesFromBundle`,
 * which src/lib must not import -- see console-process-projection.ts, the
 * only caller allowed to do that join, for the bundle-derived
 * `hasUnresolvedCritique` step and its own trust.bundle join-key check).
 *
 * Join-key identity (issue #778 review finding 3): a handoff.json whose own
 * `task_slug` disagrees with its directory's state.json `task_slug` is a
 * stale or misplaced sidecar -- never silently trusted. The join is skipped
 * (handoff omitted from the returned source; blockedReason then falls back to
 * next_action.summary or undefined) and a warning is returned so the caller
 * can surface it, rather than failing the whole batch for one bad sidecar.
 */
export function readWorkflowProcessSources(artifactRoot: string): ReadWorkflowProcessSourcesResult {
  const root = path.resolve(artifactRoot);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${root}`);

  const sources: WorkflowProcessSource[] = [];
  const warnings: string[] = [];
  for (const slug of childWorkflowDirs(root)) {
    const stateFile = path.join(root, slug, "state.json");
    if (!fs.existsSync(stateFile)) continue;
    const stateValue = readSourceJson(stateFile, `${slug}/state.json`);
    const state = validateWorkflowStateProjectionSourceShape(stateValue, `${slug}/state.json`);

    const handoffFile = path.join(root, slug, "handoff.json");
    let handoff: WorkflowHandoffSidecar | undefined;
    if (fs.existsSync(handoffFile)) {
      const candidate = validateWorkflowHandoffProjectionSourceShape(readSourceJson(handoffFile, `${slug}/handoff.json`), `${slug}/handoff.json`);
      if (candidate.task_slug !== state.task_slug) {
        warnings.push(`${slug}: handoff.json task_slug '${candidate.task_slug}' does not match state.json task_slug '${state.task_slug}' -- skipping handoff.json join (blockers ignored)`);
      } else {
        handoff = candidate;
      }
    }

    sources.push({
      path: stateFile,
      relativePath: toPosix(path.relative(root, stateFile)),
      slug,
      state,
      ...(handoff ? { handoff } : {}),
    });
  }
  return { sources, warnings };
}

export function buildWorkflowProcessProjection(
  sources: WorkflowProcessSource[],
  options: BuildWorkflowProcessProjectionOptions,
): ConsoleProcessProjectionEnvelope {
  const generatedAt = options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const producer = {
    id: options.producer?.id ?? "flow-agents-process",
    product: options.producer?.product ?? "flow-agents",
  };
  const scope = normalizeScope(options.scope);
  const processes = sources.map((source) => mapProcessSource(source));
  processes.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: "kontour.console.projection",
    version: "0.1",
    generatedAt,
    scope,
    producer,
    derivedFrom: {
      mode: "direct_snapshot",
      eventHistory: "unavailable",
      directSnapshot: {
        id: `flow-agents-process:${scope.kind}:${scope.id}`,
        emittedAt: generatedAt,
        producer,
        reason: "workflow-process projection is derived from local workflow state/handoff sidecars and trust.bundle critique state; Console event history is unavailable",
        sourceRef: {
          product: "flow-agents",
          kind: "workflow-process",
          id: ".kontourai/flow-agents/*/state.json",
          label: "Local workflow state sidecars",
        },
      },
    },
    processes,
  };
}

function mapProcessSource(source: WorkflowProcessSource): ConsoleProcessProjection {
  const { state, handoff } = source;
  const status = mapWorkflowStatusToConsoleProcessStatus(
    state.status,
    state.next_action?.status,
    source.hasUnresolvedCritique,
  );
  const blockedReason = deriveConsoleProcessBlockedReason(status, {
    nextActionStatus: state.next_action?.status,
    nextActionSummary: state.next_action?.summary,
    workflowStatus: state.status,
    handoffBlockers: handoff?.blockers,
  });
  return {
    id: deterministicProcessId(source.relativePath, state.task_slug),
    family: "workflow",
    nonAuthority: true,
    subjectRef: {
      product: "flow-agents",
      kind: "workflow",
      id: state.task_slug,
      label: state.task_slug,
    },
    sourceRef: {
      product: "flow-agents",
      kind: "workflow-state",
      id: state.task_slug,
      label: `${state.task_slug}/state.json`,
    },
    summary: state.next_action?.summary ?? state.task_slug,
    status,
    ...(blockedReason ? { blockedReason } : {}),
    extensions: {
      "flow-agents": {
        task_slug: state.task_slug,
        workflow_status: state.status,
        phase: state.phase,
        next_action_status: state.next_action?.status ?? "continue",
        ...(source.hasUnresolvedCritique !== undefined ? { has_unresolved_critique: source.hasUnresolvedCritique } : {}),
        ...(state.updated_at ? { updated_at: state.updated_at } : {}),
        source_path: source.relativePath,
      },
    },
  };
}

// Minimal projection source-shape validation for mapper safety, mirroring
// workflow-learning-projection.ts's validator. Full workflow artifact JSON
// Schema validation remains owned by workflow:validate-artifacts.
export function validateWorkflowStateProjectionSourceShape(value: unknown, label = "state.json"): WorkflowStateSidecar {
  const sidecar = objectValue(value, `${label} projection source must be an object`);
  const schemaVersion = requiredString(sidecar, "schema_version", label);
  if (schemaVersion !== "1.0") throw new Error(`${label}.schema_version must be 1.0`);
  const taskSlug = requiredString(sidecar, "task_slug", label);
  const status = enumString(sidecar, "status", KNOWN_STATUSES, label);
  const phase = requiredString(sidecar, "phase", label);
  const updatedAt = optionalString(sidecar, "updated_at", label);
  const nextActionValue = objectValue(sidecar.next_action, `${label}.next_action must be an object`);
  const nextActionStatus = enumString(nextActionValue, "status", KNOWN_NEXT_ACTION_STATUSES, `${label}.next_action`);
  const nextActionSummary = requiredString(nextActionValue, "summary", `${label}.next_action`);
  return {
    schema_version: "1.0",
    task_slug: taskSlug,
    status,
    phase,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    next_action: { status: nextActionStatus, summary: nextActionSummary },
  };
}

export function validateWorkflowHandoffProjectionSourceShape(value: unknown, label = "handoff.json"): WorkflowHandoffSidecar {
  const sidecar = objectValue(value, `${label} projection source must be an object`);
  const taskSlug = requiredString(sidecar, "task_slug", label);
  const summary = requiredString(sidecar, "summary", label);
  const blockersValue = sidecar.blockers;
  const blockers = blockersValue === undefined ? undefined : stringArray(blockersValue, `${label}.blockers`, true);
  return { task_slug: taskSlug, summary, ...(blockers ? { blockers } : {}) };
}

function readSourceJson(file: string, label: string): unknown {
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > MAX_SIDECAR_BYTES) throw new Error(`${label} exceeds max size of ${MAX_SIDECAR_BYTES} bytes`);
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error(`${label} changed while being read`);
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error(`${label} must not be a symlink`);
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function childWorkflowDirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SKIPPED_ROOT_ENTRIES.has(name))
    .sort();
}

function normalizeScope(scope: string | ConsoleProjectionScope): ConsoleProjectionScope {
  return typeof scope === "string" ? { kind: "local", id: scope } : scope;
}

function deterministicProcessId(sourcePath: string, taskSlug: string): string {
  const raw = `${sourcePath}\n${taskSlug}`;
  return `process.workflow.${slugPart(taskSlug)}.${fnv1a32(raw)}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value.length > 0 ? value : undefined;
}

function enumString<T extends string>(record: Record<string, unknown>, key: string, allowed: Set<T>, label: string): T {
  const value = requiredString(record, key, label);
  if (!allowed.has(value as T)) throw new Error(`${label}.${key} has unknown value: ${value}`);
  return value as T;
}

function stringArray(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be a string array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) throw new Error(`${label}[${index}] must be a non-empty string`);
    return item;
  });
}

function slugPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : "item";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
