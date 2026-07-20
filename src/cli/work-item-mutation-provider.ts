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
 *   itself; this module must never call `execFileSync`/`spawn`/`exec` on `gh`.
 * - `applyLocalFileMutation`: local-file adapter, for tracker-less repos and evals. Performs real
 *   read-modify-write I/O against a local JSON backlog document and returns `status: "applied"`
 *   directly, since there is no external process to defer execution to.
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagString } from "../lib/args.js";
import { atomicWriteJson, isoNow, readJson } from "../lib/fs.js";
import {
  WORK_ITEM_MUTATION_SCHEMA_VERSION,
  WorkItemMutationError,
  detectMutationConflict,
  parseObservedWorkItemState,
  parseWorkItemMutationRequest,
  type WorkItemMutationBase,
  type WorkItemMutationFieldValue,
  type WorkItemMutationOperation,
  type WorkItemMutationRef,
  type WorkItemMutationRequest,
  type WorkItemMutationResult,
  type WorkItemMutationResultStatus,
} from "../lib/work-item-mutations.js";

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
  conflict?: import("../lib/work-item-mutations.js").WorkItemMutationConflict;
  reason?: string;
}

function repoSlug(repo: GithubMutationRepo): string {
  return `${repo.owner}/${repo.name}`;
}

function projectFieldValueFlag(value: WorkItemMutationFieldValue): [string, string] {
  return typeof value === "number" ? ["--number", String(value)] : ["--text", String(value)];
}

/**
 * Render the exact `gh` argv for a mutation without executing it.
 *
 * `observed` is the freshly re-fetched provider state to diff the request's declared `base`
 * against. Pass `null` only when no fresh observation could be obtained at all — this returns
 * `not_verified` rather than fabricating a "no conflict" verdict (see `detectMutationConflict`'s
 * doc comment for why this check lives one level above it, not inside it).
 */
export function renderGithubMutation(request: WorkItemMutationRequest, observed: WorkItemMutationBase | null, target: GithubMutationTarget): GithubMutationRecord {
  const base_ref = `${repoSlug(target.repo)}#${target.number}`;
  const common = { schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION, operation: request.operation, work_item_ref: request.work_item_ref, base_ref } as const;

  if (request.operation !== "comment") {
    if (observed === null) {
      return { ...common, status: "not_verified", reason: "no current provider observation was supplied to compare against the mutation's declared base" };
    }
    const conflict = detectMutationConflict(request, observed);
    if (conflict) return { ...common, status: "conflict", conflict };
  }

  const slug = repoSlug(target.repo);
  const issueNumber = String(target.number);

  if (request.operation === "comment") {
    return { ...common, status: "rendered", gh_commands: [["issue", "comment", issueNumber, "--repo", slug, "--body", request.payload.body]] };
  }

  if (request.operation === "status_transition") {
    if (target.project_field) {
      if (!target.project_field.option_id) return { ...common, status: "rejected", reason: "target.project_field.option_id is required to render a status_transition against a project status field" };
      return {
        ...common,
        status: "rendered",
        gh_commands: [["project", "item-edit", "--id", target.project_field.item_id, "--project-id", target.project_field.project_id, "--field-id", target.project_field.field_id, "--single-select-option-id", target.project_field.option_id]],
      };
    }
    const observedStatus = observed!.status;
    const gh_commands: string[][] = [];
    if (observedStatus) gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--remove-label", `status:${observedStatus}`]);
    gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--add-label", `status:${request.payload.to_status}`]);
    return { ...common, status: "rendered", gh_commands };
  }

  // field_update
  if (target.project_field) {
    const [flag, flagValue] = projectFieldValueFlag(request.payload.value);
    return { ...common, status: "rendered", gh_commands: [["project", "item-edit", "--id", target.project_field.item_id, "--project-id", target.project_field.project_id, "--field-id", target.project_field.field_id, flag, flagValue]] };
  }
  const baseValue = request.base.field_values[request.payload.field];
  const gh_commands: string[][] = [];
  if (baseValue !== undefined && baseValue !== null) gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--remove-label", `${request.payload.field}:${baseValue}`]);
  gh_commands.push(["issue", "edit", issueNumber, "--repo", slug, "--add-label", `${request.payload.field}:${request.payload.value}`]);
  return { ...common, status: "rendered", gh_commands };
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
 * Apply a mutation directly against a local-file backlog document (real read-modify-write I/O —
 * the local-file adapter has its own storage to write to, unlike the GitHub render-only path
 * above). Returns `applied` on success, `conflict` when `request.base` diverges from the item's
 * current observed state (provider wins — nothing is written), or `rejected` when the referenced
 * work item does not exist in the document.
 */
export function applyLocalFileMutation(file: string, request: WorkItemMutationRequest, now: () => string = isoNow): WorkItemMutationResult {
  const doc = readLocalBacklogDoc(file);
  const common = { schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION, operation: request.operation, work_item_ref: request.work_item_ref } as const;
  const index = doc.items.findIndex((item) => item.id === request.work_item_ref.id);
  if (index === -1) return { ...common, status: "rejected", reason: `work item ${request.work_item_ref.id} not found in ${file}` };

  const item = doc.items[index];
  const conflict = detectMutationConflict(request, observedFromLocalItem(item));
  if (conflict) return { ...common, status: "conflict", conflict };

  const timestamp = now();
  if (request.operation === "status_transition") {
    item.status = request.payload.to_status;
  } else if (request.operation === "field_update") {
    item.field_values = { ...(item.field_values ?? {}), [request.payload.field]: request.payload.value };
  } else {
    item.comments = [...(item.comments ?? []), { body: request.payload.body, at: timestamp }];
  }
  item.updated_at = timestamp;
  doc.items[index] = item;
  writeLocalBacklogDoc(file, doc);
  return { ...common, status: "applied" };
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
  const targetRaw = loadJsonInput(requireFlag(args.flags, "target-json")) as GithubMutationTarget;
  console.log(JSON.stringify(renderGithubMutation(request, observed, targetRaw), null, 2));
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
