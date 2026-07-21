/**
 * WorkItemProvider mutation adapters (#776): status transition, field update, and comment,
 * per `context/contracts/work-item-contract.md`'s "Mutations" section. Two independent
 * implementations of the SAME provider-neutral operation + conflict-policy vocabulary
 * (`src/lib/work-item-mutations.ts`) prove the contract is provider-neutral, per the issue's
 * acceptance criteria:
 *
 * - `renderGithubMutation`: GitHub adapter. A pure function — no I/O, never shells out to `gh` —
 *   that renders the exact `gh` argv for a mutation. Render, don't execute (the same split
 *   `assignment-provider.ts`'s `render-claim`/`render-supersede` already established for this
 *   repository's GitHub write paths; see `context/contracts/assignment-provider-contract.md`'s
 *   "Implementation Note"). The calling host executes the rendered `gh_commands` argv arrays
 *   itself; this module must never call `execFileSync`/`spawn`/`exec` on `gh`. Its render-time
 *   conflict check is ADVISORY ONLY — see the contract's Conflict Policy "GitHub Render-Time
 *   Caveat" and `GithubMutationRecord.advisory`'s doc comment (review finding #2).
 * - `applyLocalFileMutation`: local-file adapter, for tracker-less repos and evals. Performs real
 *   read-modify-write I/O against a local JSON backlog document, serialized per-file under
 *   `withSubjectLock` (review finding #1 — closes the read/check/write TOCTOU and the concurrent
 *   comment-append race), and returns `status: "applied"` directly, since there is no external
 *   process to defer execution to.
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString } from "../lib/args.js";
import { atomicWriteJson, isoNow, readJson } from "../lib/fs.js";
import { withSubjectLock } from "./assignment-provider.js";
import {
  WORK_ITEM_MUTATION_SCHEMA_VERSION,
  WorkItemMutationError,
  detectMutationConflict,
  parseObservedWorkItemState,
  parseWorkItemMutationRequest,
  type WorkItemMutationBase,
  type WorkItemMutationConflict,
  type WorkItemMutationFieldValue,
  type WorkItemMutationOperation,
  type WorkItemMutationRef,
  type WorkItemMutationRequest,
  type WorkItemMutationResult,
  type WorkItemMutationResultStatus,
} from "../lib/work-item-mutations.js";

// ─── small local validation helpers (mirrors work-item-mutations.ts's private helpers; kept
// file-scoped rather than exported from that module to avoid growing its shared public surface
// for GitHub-adapter-only shapes) ───────────────────────────────────────────

function invalidTarget(message: string): never {
  throw new WorkItemMutationError(message);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidTarget(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalidTarget(`${field} must be a nonempty string`);
  return value as string;
}

// ─── GitHub adapter: render, don't execute ─────────────────────────────────

export interface GithubMutationRepo {
  owner: string;
  name: string;
}

/**
 * Optionally targets a GitHub Projects v2 field mutation instead of the labels convention, per
 * the contract's "GitHub Mutations" mapping table. Omit to use labels.
 */
export interface GithubMutationProjectField {
  project_id: string;
  item_id: string;
  field_id: string;
  /** Required to render a `status_transition` against a single-select status field. */
  option_id?: string;
}

export interface GithubMutationTarget {
  repo: GithubMutationRepo;
  number: number;
  project_field?: GithubMutationProjectField;
}

export interface GithubMutationRecord {
  schema_version: typeof WORK_ITEM_MUTATION_SCHEMA_VERSION;
  operation: WorkItemMutationOperation;
  status: WorkItemMutationResultStatus;
  work_item_ref: WorkItemMutationRef;
  /** `owner/repo#number` — the coordinate the rendered argv targets. */
  base_ref: string;
  /** JSON array of argv arrays, one element per `gh` argument (never a shell string); present
   * only when `status` is `"rendered"`. The host MUST execute each entry as argv verbatim. */
  gh_commands?: string[][];
  conflict?: WorkItemMutationConflict;
  reason?: string;
  /**
   * Present (`true`) whenever this record's `status` reflects a conflict check against `observed`
   * (i.e. `status_transition`/`field_update` with `rendered` or `conflict`). Review finding #2:
   * unlike the local-file adapter's `applied` result (the check IS the write, atomically, under
   * `withSubjectLock` — an authoritative guarantee), the GitHub adapter only renders `gh` argv; a
   * host executes it later, out of process. Between this render-time check and that later
   * execution, provider state can still drift (a human edits the board, another agent mutates
   * first) — this field marks that the conflict check is ADVISORY AT RENDER TIME ONLY, not a
   * guarantee that holds through execution. Hosts wanting a stronger guarantee must re-observe
   * immediately before executing the rendered `gh_commands` (see the contract's Conflict Policy
   * "GitHub Render-Time Caveat" for the full policy text — this field is that policy's
   * machine-readable marker, not a separate mechanism).
   */
  advisory?: true;
}

function repoSlug(repo: GithubMutationRepo): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Validate and normalize a raw (e.g. CLI JSON) render target. Throws `WorkItemMutationError` on a
 * malformed shape — review finding #3's shape-validation half. A *well-shaped* target that simply
 * does not match the request's `work_item_ref` is NOT a shape error; it is rejected by
 * `renderGithubMutation` itself as a `"rejected"` result (see that function's target/ref identity
 * check) rather than thrown, matching this module's existing convention that render-time business
 * rules (e.g. a missing `option_id`) are reportable `"rejected"` outcomes, not exceptions.
 */
export function parseGithubMutationTarget(value: unknown): GithubMutationTarget {
  const root = requireObject(value, "target");
  const repoRecord = requireObject(root.repo, "target.repo");
  const owner = requireNonEmptyString(repoRecord.owner, "target.repo.owner");
  const name = requireNonEmptyString(repoRecord.name, "target.repo.name");
  const number = root.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) invalidTarget("target.number must be a positive integer");
  let project_field: GithubMutationProjectField | undefined;
  if (root.project_field !== undefined) {
    const pf = requireObject(root.project_field, "target.project_field");
    const option_id = pf.option_id;
    if (option_id !== undefined && typeof option_id !== "string") invalidTarget("target.project_field.option_id must be a string when present");
    project_field = {
      project_id: requireNonEmptyString(pf.project_id, "target.project_field.project_id"),
      item_id: requireNonEmptyString(pf.item_id, "target.project_field.item_id"),
      field_id: requireNonEmptyString(pf.field_id, "target.project_field.field_id"),
      ...(typeof option_id === "string" ? { option_id } : {}),
    };
  }
  return { repo: { owner, name }, number, ...(project_field ? { project_field } : {}) };
}

const MUTATION_COMMENT_MARKER_PREFIX = "<!-- flow-agents:mutation-comment";

/** Renders the stable idempotency marker for a comment mutation, mirroring
 * `assignment-provider.ts`'s `CLAIM_COMMENT_MARKER_DEFAULT` convention (review finding #6). */
function commentIdempotencyMarker(idempotencyKey: string): string {
  return `${MUTATION_COMMENT_MARKER_PREFIX}:${idempotencyKey} -->`;
}

/** The exact comment body an adapter renders/applies for a comment mutation: the idempotency
 * marker (if a key was supplied) prepended as its own line, then the caller's body verbatim. */
function renderCommentBody(payload: { body: string; idempotency_key?: string }): string {
  return payload.idempotency_key ? `${commentIdempotencyMarker(payload.idempotency_key)}\n${payload.body}` : payload.body;
}

function commentBodyCarriesKey(body: string, idempotencyKey: string): boolean {
  return body.startsWith(commentIdempotencyMarker(idempotencyKey));
}

function projectFieldValueFlag(value: WorkItemMutationFieldValue): [string, string] {
  // Callers must have already rejected boolean/null before reaching here — see the field_update
  // branch below (review finding #4: null renders --clear, booleans are rejected outright).
  return typeof value === "number" ? ["--number", String(value)] : ["--text", String(value)];
}

/**
 * Render the exact `gh` argv for a mutation without executing it.
 *
 * `observed` is the freshly re-fetched provider state to diff the request's declared `base`
 * against. Pass `null` only when no fresh observation could be obtained at all — this returns
 * `not_verified` rather than fabricating a "no conflict" verdict (see `detectMutationConflict`'s
 * doc comment for why this check lives one level above it, not inside it).
 *
 * `target` must already be shape-valid (see `parseGithubMutationTarget`) — this function's own
 * first check is a review finding #3 guard: `target`'s repo/number must exactly match
 * `request.work_item_ref`, or the mutation is rejected before any command is rendered. Without
 * this, a caller that renders a mutation for one work item's payload against a mismatched target
 * (e.g. a stale cached target, or a confused-deputy caller) would silently render `gh` argv
 * against the WRONG issue.
 */
export function renderGithubMutation(request: WorkItemMutationRequest, observed: WorkItemMutationBase | null, target: GithubMutationTarget): GithubMutationRecord {
  const base_ref = `${repoSlug(target.repo)}#${target.number}`;
  const common = { schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION, operation: request.operation, work_item_ref: request.work_item_ref, base_ref } as const;

  const ref = request.work_item_ref;
  if (ref.owner === undefined || ref.repo === undefined || ref.number === undefined) {
    return { ...common, status: "rejected", reason: "request.work_item_ref must include owner, repo, and number so the render target can be validated against it (target redirect guard)" };
  }
  if (ref.owner !== target.repo.owner || ref.repo !== target.repo.name || ref.number !== target.number) {
    return {
      ...common,
      status: "rejected",
      reason: `target ${repoSlug(target.repo)}#${target.number} does not match request.work_item_ref ${ref.owner}/${ref.repo}#${ref.number} — refusing to render a mutation against a different work item`,
    };
  }

  if (request.operation !== "comment") {
    if (observed === null) {
      return { ...common, status: "not_verified", reason: "no current provider observation was supplied to compare against the mutation's declared base" };
    }
    const conflict = detectMutationConflict(request, observed);
    if (conflict) return { ...common, status: "conflict", conflict, advisory: true };
  }

  const slug = repoSlug(target.repo);
  const issueNumber = String(target.number);

  if (request.operation === "comment") {
    return { ...common, status: "rendered", gh_commands: [["issue", "comment", issueNumber, "--repo", slug, "--body", renderCommentBody(request.payload)]] };
  }

  if (request.operation === "status_transition") {
    if (target.project_field) {
      if (!target.project_field.option_id) return { ...common, status: "rejected", reason: "target.project_field.option_id is required to render a status_transition against a project status field" };
      return {
        ...common,
        status: "rendered",
        advisory: true,
        gh_commands: [["project", "item-edit", "--id", target.project_field.item_id, "--project-id", target.project_field.project_id, "--field-id", target.project_field.field_id, "--single-select-option-id", target.project_field.option_id]],
      };
    }
    const observedStatus = observed!.status;
    const gh_commands: string[][] = [];
    if (observedStatus) gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--remove-label", `status:${observedStatus}`]);
    gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--add-label", `status:${request.payload.to_status}`]);
    return { ...common, status: "rendered", advisory: true, gh_commands };
  }

  // field_update
  if (typeof request.payload.value === "boolean") {
    return { ...common, status: "rejected", reason: "field_update.payload.value must not be a boolean for the GitHub adapter: neither the labels convention nor a Projects v2 field has an unambiguous boolean representation here — represent the field as a string (e.g. \"true\"/\"false\") or a single-select option instead" };
  }

  if (target.project_field) {
    if (request.payload.value === null) {
      return { ...common, status: "rendered", advisory: true, gh_commands: [["project", "item-edit", "--id", target.project_field.item_id, "--project-id", target.project_field.project_id, "--field-id", target.project_field.field_id, "--clear"]] };
    }
    const [flag, flagValue] = projectFieldValueFlag(request.payload.value);
    return { ...common, status: "rendered", advisory: true, gh_commands: [["project", "item-edit", "--id", target.project_field.item_id, "--project-id", target.project_field.project_id, "--field-id", target.project_field.field_id, flag, flagValue]] };
  }

  const baseValue = request.base.field_values[request.payload.field];
  const gh_commands: string[][] = [];
  if (baseValue !== undefined && baseValue !== null) gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--remove-label", `${request.payload.field}:${baseValue}`]);
  if (request.payload.value !== null) gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--add-label", `${request.payload.field}:${request.payload.value}`]);
  return { ...common, status: "rendered", advisory: true, gh_commands };
}

// ─── local-file adapter: real read-modify-write ────────────────────────────

export const LOCAL_FILE_BACKLOG_SCHEMA_VERSION = "1.0" as const;

export interface LocalFileWorkItem {
  id: string;
  status?: string;
  field_values?: Record<string, WorkItemMutationFieldValue>;
  comments?: Array<{ body: string; at: string }>;
  updated_at?: string;
  [key: string]: unknown;
}

export interface LocalFileBacklogDoc {
  schema_version: typeof LOCAL_FILE_BACKLOG_SCHEMA_VERSION;
  items: LocalFileWorkItem[];
}

export function readLocalBacklogDoc(file: string): LocalFileBacklogDoc {
  if (!fs.existsSync(file)) throw new Error(`local-file backlog document not found: ${file}`);
  const data = readJson(file) as Partial<LocalFileBacklogDoc>;
  if (data.schema_version !== LOCAL_FILE_BACKLOG_SCHEMA_VERSION) throw new Error(`${file}: unsupported schema_version ${String((data as { schema_version?: unknown }).schema_version)}`);
  if (!Array.isArray(data.items)) throw new Error(`${file}: items must be an array`);
  return { schema_version: LOCAL_FILE_BACKLOG_SCHEMA_VERSION, items: data.items };
}

function writeLocalBacklogDoc(file: string, doc: LocalFileBacklogDoc): void {
  atomicWriteJson(path.dirname(file), file, doc);
}

function observedFromLocalItem(item: LocalFileWorkItem): WorkItemMutationBase {
  return {
    ...(item.status !== undefined ? { status: item.status } : {}),
    ...(item.field_values !== undefined ? { field_values: item.field_values } : {}),
  };
}

/**
 * The actual read-modify-write body, run under `withSubjectLock` by `applyLocalFileMutation`
 * below. Never call this directly outside the lock — see review finding #1's doc comment on the
 * exported wrapper for why.
 */
function applyLocalFileMutationLocked(file: string, request: WorkItemMutationRequest, now: () => string): WorkItemMutationResult {
  const doc = readLocalBacklogDoc(file);
  const common = { schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION, operation: request.operation, work_item_ref: request.work_item_ref } as const;
  const index = doc.items.findIndex((item) => item.id === request.work_item_ref.id);
  if (index === -1) return { ...common, status: "rejected", reason: `work item ${request.work_item_ref.id} not found in ${file}` };

  const item = doc.items[index];

  if (request.operation === "comment" && request.payload.idempotency_key) {
    const key = request.payload.idempotency_key;
    const alreadyPosted = (item.comments ?? []).some((existing) => commentBodyCarriesKey(existing.body, key));
    if (alreadyPosted) return { ...common, status: "applied", reason: `comment with idempotency_key ${key} already present; skipped duplicate (at-least-once dedupe)` };
  }

  const conflict = detectMutationConflict(request, observedFromLocalItem(item));
  if (conflict) return { ...common, status: "conflict", conflict };

  const timestamp = now();
  if (request.operation === "status_transition") {
    item.status = request.payload.to_status;
  } else if (request.operation === "field_update") {
    item.field_values = { ...(item.field_values ?? {}), [request.payload.field]: request.payload.value };
  } else {
    item.comments = [...(item.comments ?? []), { body: renderCommentBody(request.payload), at: timestamp }];
  }
  item.updated_at = timestamp;
  doc.items[index] = item;
  writeLocalBacklogDoc(file, doc);
  return { ...common, status: "applied" };
}

/**
 * Apply a mutation directly against a local-file backlog document (real read-modify-write I/O —
 * the local-file adapter has its own storage to write to, unlike the GitHub render-only path
 * above). Returns `applied` on success, `conflict` when `request.base` diverges from the item's
 * current observed state (provider wins — nothing is written), or `rejected` when the referenced
 * work item does not exist in the document.
 *
 * Review finding #1 (HIGH, independent review of #776): the read (current item state) -> compare
 * (`detectMutationConflict`) -> write (`writeLocalBacklogDoc`) sequence is wrapped end-to-end in
 * `withSubjectLock` (`src/cli/assignment-provider.ts` — the repo's established per-subject
 * mutual-exclusion primitive, reused rather than reimplemented), keyed per BACKLOG FILE (not per
 * work item): two mutations to the same file — even against different items or different fields
 * of the same item — are serialized, so a second mutation's conflict check always compares against
 * the FIRST mutation's already-written state, never a stale pre-lock read. This closes both the
 * read/check/write TOCTOU (two concurrent writers could otherwise both pass a stale conflict check
 * before either wrote, and the second write would silently clobber the first with zero error) and
 * the concurrent-comment-append race (two concurrent comment appends reading the same
 * pre-mutation `comments` array and each writing back an array that drops the other's entry).
 */
export function applyLocalFileMutation(file: string, request: WorkItemMutationRequest, now: () => string = isoNow): WorkItemMutationResult {
  const artifactRoot = path.resolve(path.dirname(file));
  const subjectId = `work-item-mutation-file:${path.basename(file)}`;
  return withSubjectLock(artifactRoot, subjectId, () => applyLocalFileMutationLocked(file, request, now));
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function requireFlag(flags: Record<string, string | boolean | string[]>, name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function loadJsonInput(file: string): unknown {
  return file === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : JSON.parse(fs.readFileSync(file, "utf8"));
}

function renderCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const request = parseWorkItemMutationRequest(loadJsonInput(requireFlag(args.flags, "request-json")));
  const observedFlag = flagString(args.flags, "observed-json");
  const observed = observedFlag ? parseObservedWorkItemState(loadJsonInput(observedFlag)) : null;
  const target = parseGithubMutationTarget(loadJsonInput(requireFlag(args.flags, "target-json")));
  console.log(JSON.stringify(renderGithubMutation(request, observed, target), null, 2));
  return 0;
}

function applyCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const request = parseWorkItemMutationRequest(loadJsonInput(requireFlag(args.flags, "request-json")));
  const file = requireFlag(args.flags, "file");
  console.log(JSON.stringify(applyLocalFileMutation(file, request), null, 2));
  return 0;
}

function statusCommand(argv: string[]): number {
  const args = parseArgs(argv);
  const file = requireFlag(args.flags, "file");
  const id = requireFlag(args.flags, "id");
  const doc = readLocalBacklogDoc(file);
  const item = doc.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`work item ${id} not found in ${file}`);
  console.log(JSON.stringify({ id: item.id, status: item.status ?? null, field_values: item.field_values ?? {}, comments: item.comments ?? [], updated_at: item.updated_at ?? null }, null, 2));
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "render":
        return renderCommand(rest);
      case "apply":
        return applyCommand(rest);
      case "status":
        return statusCommand(rest);
      default:
        console.error("Usage: work-item-mutation-provider <render|apply|status> [args]");
        console.error("  render --request-json <file|-> --target-json <file|-> [--observed-json <file|->]   (GitHub: render gh argv, never execute)");
        console.error("  apply  --request-json <file|-> --file <local-backlog.json>                          (local-file: real read-modify-write)");
        console.error("  status --file <local-backlog.json> --id <work-item-id>                              (local-file: read current observed state)");
        return command ? 64 : 0;
    }
  } catch (error) {
    const code = error instanceof WorkItemMutationError ? error.code : undefined;
    console.error(`error${code ? ` (${code})` : ""}: ${(error as Error).message}`);
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
