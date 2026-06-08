import * as fs from "node:fs";
import * as path from "node:path";
import { flagBool, flagString, parseArgs } from "../lib/args.js";

type Classification =
  | "active_wip"
  | "cleanup_candidate"
  | "terminal_done"
  | "active_learning_followup"
  | "invalid";

type AuditItem = {
  slug: string;
  path: string;
  classification: Classification;
  state_status: string | null;
  phase: string | null;
  next_action_status: string | null;
  reasons: string[];
};

type AuditResult = {
  artifact_root: string;
  buckets: Record<Classification, AuditItem[]>;
  totals: Record<Classification | "scanned", number>;
};

const ACTIVE_STATUSES = new Set([
  "planning",
  "planned",
  "in_progress",
  "verifying",
  "blocked",
  "failed",
  "not_verified",
  "needs_decision",
]);

const KNOWN_LEARNING_STATUSES = new Set(["pending", "learned", "followup_required", "blocked"]);
const KNOWN_LEARNING_ROUTE_TARGETS = new Set(["rule", "skill", "power", "agent", "eval", "doc", "backlog", "knowledge", "none"]);
const KNOWN_LEARNING_ROUTE_STATUSES = new Set(["completed", "open", "deferred", "accepted", "rejected"]);
const SKIPPED_ROOT_ENTRIES = new Set(["archive", "changes", "delivery-history"]);
const MAX_SIDECAR_BYTES = 1024 * 1024;

function printHelp(): void {
  console.log("Usage: flow-agents workflow-artifact-cleanup-audit [--artifact-root <path>] [--json]");
  console.log("");
  console.log("Read-only dry-run audit for local workflow artifact directories.");
  console.log("");
  console.log("Options:");
  console.log("  --artifact-root <path>  Local artifact root to scan (default: .agents/flow-agents)");
  console.log("  --json                  Print stable JSON buckets instead of text");
  console.log("  --help                  Show this help");
  console.log("");
  console.log("The command classifies active WIP, cleanup candidates, terminal done records,");
  console.log("active learning follow-ups, and invalid sidecars. It does not delete, archive,");
  console.log("move, or rewrite workflow artifacts.");
}

function readJson(file: string, label: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: `${label} must be a regular file` };
    if (stat.size > MAX_SIDECAR_BYTES) {
      return { ok: false, reason: `${label} exceeds max size of ${MAX_SIDECAR_BYTES} bytes` };
    }
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) {
      return { ok: false, reason: `${label} changed while being read` };
    }
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      return { ok: false, reason: `${label} must not be a symlink` };
    }
    return { ok: false, reason: `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateNextAction(state: Record<string, unknown>): { ok: true; status: string } | { ok: false; reason: string } {
  const nextAction = objectValue(state.next_action);
  if (!nextAction) return { ok: false, reason: "state.next_action is missing or invalid" };
  const status = stringField(nextAction, "status");
  if (!status) return { ok: false, reason: "state.next_action.status is missing or invalid" };
  return { ok: true, status };
}

function routeStatuses(learning: Record<string, unknown>): { ok: true; statuses: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(learning.records)) return { ok: false, reason: "learning.records is missing or invalid" };
  const statuses: string[] = [];
  for (const record of learning.records) {
    const item = objectValue(record);
    if (!item) return { ok: false, reason: "learning record must be an object" };
    if (!Array.isArray(item.routing)) return { ok: false, reason: "learning record routing is missing or invalid" };
    const routing = item.routing;
    for (const route of routing) {
      const routeObject = objectValue(route);
      if (!routeObject) return { ok: false, reason: "learning routing entry must be an object" };
      const target = stringField(routeObject, "target");
      if (!target) return { ok: false, reason: "learning routing target is missing or invalid" };
      if (!KNOWN_LEARNING_ROUTE_TARGETS.has(target)) return { ok: false, reason: `learning routing has unknown target: ${target}` };
      const action = stringField(routeObject, "action");
      if (!action) return { ok: false, reason: "learning routing action is missing or invalid" };
      const status = stringField(routeObject, "status");
      if (!status) return { ok: false, reason: "learning routing status is missing or invalid" };
      statuses.push(status);
    }
  }
  return { ok: true, statuses };
}

function learningSignals(workflowDir: string): { open: boolean; reasons: string[]; invalidReason?: string } {
  const learningPath = path.join(workflowDir, "learning.json");
  if (!fs.existsSync(learningPath)) return { open: false, reasons: [] };
  const parsed = readJson(learningPath, "learning.json");
  if (!parsed.ok) return { open: false, reasons: [], invalidReason: parsed.reason };
  const learning = objectValue(parsed.value);
  if (!learning) return { open: false, reasons: [], invalidReason: "learning.json must be an object" };

  const reasons: string[] = [];
  const status = stringField(learning, "status");
  if (!status) return { open: false, reasons: [], invalidReason: "learning.status is missing or invalid" };
  if (!KNOWN_LEARNING_STATUSES.has(status)) return { open: false, reasons: [], invalidReason: `learning.status is unknown: ${status}` };
  if (status === "followup_required") reasons.push("learning.status is followup_required");
  const routesResult = routeStatuses(learning);
  if (!routesResult.ok) return { open: false, reasons: [], invalidReason: routesResult.reason };
  const routes = routesResult.statuses;
  if (routes.includes("open")) reasons.push("learning routing has an open route");
  const unknown = routes.filter((routeStatus) => !KNOWN_LEARNING_ROUTE_STATUSES.has(routeStatus));
  if (unknown.length) return { open: false, reasons: [], invalidReason: `learning routing has unknown status: ${unknown.join(", ")}` };
  return { open: reasons.length > 0, reasons };
}

function invalidItem(slug: string, workflowPath: string, reason: string): AuditItem {
  return {
    slug,
    path: workflowPath,
    classification: "invalid",
    state_status: null,
    phase: null,
    next_action_status: null,
    reasons: [reason],
  };
}

function classifyWorkflow(slug: string, workflowPath: string): AuditItem {
  const statePath = path.join(workflowPath, "state.json");
  if (!fs.existsSync(statePath)) return invalidItem(slug, workflowPath, "missing state.json");
  const parsed = readJson(statePath, "state.json");
  if (!parsed.ok) return invalidItem(slug, workflowPath, parsed.reason);
  const state = objectValue(parsed.value);
  if (!state) return invalidItem(slug, workflowPath, "state.json must be an object");

  const status = stringField(state, "status");
  const phase = stringField(state, "phase");
  if (!status) return invalidItem(slug, workflowPath, "state.status is missing or invalid");
  if (!phase) return invalidItem(slug, workflowPath, "state.phase is missing or invalid");
  const nextAction = validateNextAction(state);
  if (!nextAction.ok) return invalidItem(slug, workflowPath, nextAction.reason);
  const nextStatus = nextAction.status;

  const base = { slug, path: workflowPath, state_status: status, phase, next_action_status: nextStatus };
  const learning = learningSignals(workflowPath);
  if (learning.invalidReason) return { ...base, classification: "invalid", reasons: [learning.invalidReason] };
  if (learning.open) {
    return { ...base, classification: "active_learning_followup", reasons: learning.reasons };
  }

  if (ACTIVE_STATUSES.has(status)) {
    return { ...base, classification: "active_wip", reasons: [`state.status is active: ${status}`] };
  }
  if (status === "verified" && nextStatus === "continue") {
    return { ...base, classification: "active_wip", reasons: ["verified workflow still has next_action.status continue"] };
  }
  if (status === "verified" && nextStatus === "done") {
    return { ...base, classification: "cleanup_candidate", reasons: ["verified workflow has next_action.status done"] };
  }
  if (["delivered", "accepted", "archived"].includes(status) && phase === "done") {
    return { ...base, classification: "terminal_done", reasons: [`${status} workflow is in phase done`] };
  }
  if ((status === "accepted" || status === "archived") && learning.reasons.length === 0) {
    return { ...base, classification: "terminal_done", reasons: [`${status} workflow has no open learning routing`] };
  }
  return { ...base, classification: "invalid", reasons: [`unrecognized lifecycle shape: status=${status}, phase=${phase}, next_action.status=${nextStatus ?? "missing"}`] };
}

function childWorkflowDirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SKIPPED_ROOT_ENTRIES.has(name))
    .sort();
}

function emptyBuckets(): Record<Classification, AuditItem[]> {
  return {
    active_wip: [],
    cleanup_candidate: [],
    terminal_done: [],
    active_learning_followup: [],
    invalid: [],
  };
}

function audit(root: string): AuditResult {
  const artifactRoot = path.resolve(root);
  const stat = fs.statSync(artifactRoot);
  if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${artifactRoot}`);
  const buckets = emptyBuckets();
  for (const slug of childWorkflowDirs(artifactRoot)) {
    const item = classifyWorkflow(slug, path.join(artifactRoot, slug));
    buckets[item.classification].push(item);
  }
  return {
    artifact_root: artifactRoot,
    buckets,
    totals: {
      scanned: Object.values(buckets).reduce((sum, items) => sum + items.length, 0),
      active_wip: buckets.active_wip.length,
      cleanup_candidate: buckets.cleanup_candidate.length,
      terminal_done: buckets.terminal_done.length,
      active_learning_followup: buckets.active_learning_followup.length,
      invalid: buckets.invalid.length,
    },
  };
}

function printBucket(title: string, items: AuditItem[]): void {
  console.log(`${title}: ${items.length}`);
  for (const item of items) {
    console.log(`  - ${item.slug} (${item.state_status ?? "unknown"} / ${item.phase ?? "unknown"} / next=${item.next_action_status ?? "missing"})`);
    for (const reason of item.reasons) console.log(`    reason: ${reason}`);
  }
}

function printText(result: AuditResult): void {
  console.log("Workflow artifact cleanup audit (dry run, read-only)");
  console.log(`Artifact root: ${result.artifact_root}`);
  console.log(`Scanned workflow directories: ${result.totals.scanned}`);
  console.log("");
  printBucket("Active WIP", result.buckets.active_wip);
  printBucket("Active learning follow-ups", result.buckets.active_learning_followup);
  printBucket("Cleanup candidates", result.buckets.cleanup_candidate);
  printBucket("Terminal done", result.buckets.terminal_done);
  printBucket("Invalid sidecars", result.buckets.invalid);
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (flagBool(args.flags, "help") || flagBool(args.flags, "h")) {
    printHelp();
    return 0;
  }
  let result: AuditResult;
  try {
    result = audit(flagString(args.flags, "artifact-root", ".agents/flow-agents") ?? ".agents/flow-agents");
  } catch (error) {
    console.error(`workflow-artifact-cleanup-audit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (flagBool(args.flags, "json")) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
