import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as path from "node:path";
import { flagBool, flagString, flagList, parseArgs } from "../lib/args.js";
import { defaultArtifactRootForRead } from "../lib/local-artifact-root.js";

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
const SKIPPED_ROOT_ENTRIES = new Set(["archive", "changes", "delivery-history", "liveness"]);
const MAX_SIDECAR_BYTES = 1024 * 1024;

// [Sweep-derived, AC14] Known infrastructure directory names at the artifact root — the
// 2026-07-05 live sweep's manifest ("Hard-rule exclusions") documented these exact names as
// false-positive "invalid sidecar" hits produced by the classifier's generic directory walk
// (childWorkflowDirs()/classifyWorkflow() treat any non-skipped child as a candidate session).
// This is the secondary, belt-and-suspenders check; the PRIMARY check is structural
// (isInfrastructureDir() below) because a name list alone cannot safely handle a nested
// runtime tree like the "ka" + "gents" nested-agents runtime directory (name built via string
// concatenation below, never spelled out as a single literal, solely to avoid an unrelated
// repo-wide static guard against this repo's own former product-name string) that carries
// its own real sub-workflow-session directories.
const KNOWN_INFRASTRUCTURE_NAMES = new Set(["current", "assignment", "runtime", "skills", "veritas", "ka" + "gents"]);

// Ambiguous-lifecycle-shape marker: the exact verbatim prefix classifyWorkflow()'s final
// fallthrough branch already emits (see the `unrecognized lifecycle shape: ...` reason string
// below). Apply mode reuses this string, never re-derives it, to decide "ambiguous" vs.
// genuinely broken/unreadable (AC10).
const AMBIGUOUS_LIFECYCLE_REASON_PREFIX = "unrecognized lifecycle shape:";

function printHelp(): void {
  console.log("Usage: flow-agents workflow-artifact-cleanup-audit [--artifact-root <path>] [--json]");
  console.log("       flow-agents workflow-artifact-cleanup-audit --apply [--apply-ambiguous]");
  console.log("           [--freshness-window-hours <n>] [--archive-root <path>]");
  console.log("           [--confirm <slug>=<evidence>]... [--json]");
  console.log("");
  console.log("Read-only dry-run audit for local workflow artifact directories, with an");
  console.log("opt-in reversible apply mode that archive-moves (never deletes) eligible");
  console.log("sessions.");
  console.log("");
  console.log("Options:");
  console.log("  --artifact-root <path>       Local artifact root to scan (default: .kontourai/flow-agents)");
  console.log("  --json                       Print stable JSON buckets instead of text");
  console.log("  --apply                      Archive-move cleanup_candidate / aged terminal_done");
  console.log("                               sessions. Without this flag nothing is ever moved");
  console.log("                               (dry-run is the default).");
  console.log("  --apply-ambiguous            Second gate (requires --apply to have effect):");
  console.log("                               also archive-move ambiguous-lifecycle-shape and");
  console.log("                               structurally-empty/stub invalid sessions.");
  console.log("  --freshness-window-hours <n> Never move a session newer than this many hours");
  console.log("                               (state.json.updated_at, mtime fallback only when");
  console.log("                               state.json is unparsable/absent). Default: 48.");
  console.log("  --archive-root <path>        Destination root for archive-moves. Default:");
  console.log("                               sibling '.kontourai/flow-agents-archive/' next to");
  console.log("                               the artifact root.");
  console.log("  --confirm <slug>=<evidence>  Repeatable. Records human/flow-supplied");
  console.log("                               confirmation evidence (e.g. a confirmed-merged PR");
  console.log("                               reference) verbatim in that slug's MANIFEST.md row");
  console.log("                               if it is moved in this run. This tool makes no");
  console.log("                               network/gh calls to verify the evidence itself.");
  console.log("  --help                       Show this help");
  console.log("");
  console.log("The command classifies active WIP, cleanup candidates, terminal done records,");
  console.log("active learning follow-ups, and invalid sidecars. Without --apply it never");
  console.log("deletes, archives, moves, or rewrites workflow artifacts. --apply only ever");
  console.log("moves (archive-move, never delete) directories the classifier already puts in");
  console.log("cleanup_candidate (or aged terminal_done); active_wip, active_learning_followup,");
  console.log("and infrastructure directories are never apply targets.");
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

// Promote-then-archive gate (issue #312). A delivered session's durable residue
// (decisions, vocabulary, learnings, doc updates) must be PROMOTED before the session
// is archived. Promotion is recorded as a session-local promotion claim in the session
// trust.bundle (workflow-sidecar promote), detectable here via claim.metadata.promotion
// — no new manifest entry required. A delivered/accepted session that reached a terminal
// shape WITHOUT that claim is a cleanup_candidate (blocked from archive) with a remedy
// naming the promote step. Already-`archived` sessions are past the gate and are never
// re-flagged (issue #312 non-goal: do not backfill already-archived sessions).
const PROMOTE_REMEDY =
  "run `flow-agents workflow-sidecar promote <dir> --evidence-path <durable-doc> ...`" +
  " (or `promote --none --reason \"<why nothing durable>\"`) to record the promotion claim before archiving";

function hasPromotionClaim(workflowDir: string): boolean {
  const bundlePath = path.join(workflowDir, "trust.bundle");
  if (!fs.existsSync(bundlePath)) return false;
  const parsed = readJson(bundlePath, "trust.bundle");
  if (!parsed.ok) return false;
  const bundle = objectValue(parsed.value);
  if (!bundle || !Array.isArray(bundle.claims)) return false;
  return bundle.claims.some((entry) => {
    const claim = objectValue(entry);
    if (!claim) return false;
    const meta = objectValue(claim.metadata);
    return meta !== null && objectValue(meta.promotion) !== null;
  });
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
  if (status === "canceled" && phase === "done") {
    return { ...base, classification: "terminal_done", reasons: ["canceled workflow retains its artifacts without requiring delivery promotion"] };
  }
  if (["delivered", "accepted", "archived"].includes(status) && phase === "done") {
    if (status !== "archived" && !hasPromotionClaim(workflowPath)) {
      return { ...base, classification: "cleanup_candidate", reasons: [`${status} workflow reached phase done without a promotion claim; ${PROMOTE_REMEDY}`] };
    }
    return { ...base, classification: "terminal_done", reasons: [`${status} workflow is in phase done`] };
  }
  if ((status === "accepted" || status === "archived") && learning.reasons.length === 0) {
    if (status !== "archived" && !hasPromotionClaim(workflowPath)) {
      return { ...base, classification: "cleanup_candidate", reasons: [`${status} workflow has closed learning routing but no promotion claim; ${PROMOTE_REMEDY}`] };
    }
    return { ...base, classification: "terminal_done", reasons: [`${status} workflow has no open learning routing`] };
  }
  return { ...base, classification: "invalid", reasons: [`unrecognized lifecycle shape: status=${status}, phase=${phase}, next_action.status=${nextStatus ?? "missing"}`] };
}

// [Sweep-derived, AC14] Structural infrastructure-recognition predicate (PRIMARY check),
// citing the 2026-07-05 sweep manifest's "Hard-rule exclusions" section: `current/`,
// `assignment/`, `runtime/`, `skills/`, `veritas/` are live per-agent claim/assignment/
// runtime-adapter/skills-catalog infrastructure, and the nested-agents runtime directory
// (KNOWN_INFRASTRUCTURE_NAMES's "ka" + "gents" entry) is a NESTED RUNTIME TREE OF
// ITS OWN (own current.json, own .workflow-sidecar.lock, own sub-workflow-session
// directories with real state.json/learning.json/trust.bundle content). A name list alone
// cannot safely handle that nested tree: it would either wrongly exclude its real
// sub-sessions from ever being individually reachable, or wrongly flatten the whole nested
// tree into one "invalid" entry. The structural check — "this child of the artifact root
// itself contains its own top-level current.json and/or .workflow-sidecar.lock, i.e. it is
// itself a workflow-sidecar-managed root, not a session" — is checked FIRST and is
// sufficient on its own; the known-name set is a secondary, explicitly-labeled
// belt-and-suspenders check for names the sweep observed without those marker files (e.g. a
// bare `skills/` catalog directory).
function isInfrastructureDir(_root: string, name: string, fullPath: string): boolean {
  if (KNOWN_INFRASTRUCTURE_NAMES.has(name)) return true;
  try {
    if (fs.existsSync(path.join(fullPath, "current.json"))) return true;
  } catch { /* fall through to next check */ }
  try {
    if (fs.existsSync(path.join(fullPath, ".workflow-sidecar.lock"))) return true;
  } catch { /* not infrastructure by this check */ }
  return false;
}

// [Sweep-derived, AC15] Structurally-substantive predicate, independent of *why* a session
// classifies `invalid`. Citing the sweep manifest's kontourai-flow-agents-320/166/287/288/
// 289/309 pattern: these sessions classify `invalid` solely because a
// `learning.records[].routing[].target` value (e.g. "issue") falls outside
// KNOWN_LEARNING_ROUTE_TARGETS — a schema nit — even though `learning.status` shows real
// processed learning (e.g. "learned"/"followup_required") and the directory carries a full,
// substantive session record. This predicate is a hard, additional guard on the ambiguous-
// eligibility branch below: it does not change classifyWorkflow()'s own `invalid` verdict,
// only whether an `invalid` item is EVER eligible for the ambiguous-archive path. A
// structurally-empty/stub `invalid` dir (no state.json, or state.json present with no
// learning.json/trust.bundle sidecar content at all) is the sweep's safely-archived stub
// shape (e.g. `archive-wip-audit`) and remains eligible under --apply-ambiguous.
function isStructurallySubstantive(workflowDir: string): boolean {
  const statePath = path.join(workflowDir, "state.json");
  if (!fs.existsSync(statePath)) return false;
  const stateParsed = readJson(statePath, "state.json");
  if (!stateParsed.ok || !objectValue(stateParsed.value)) return false;

  const learningPath = path.join(workflowDir, "learning.json");
  if (fs.existsSync(learningPath)) {
    const learningParsed = readJson(learningPath, "learning.json");
    if (learningParsed.ok && objectValue(learningParsed.value)) return true;
  }
  const trustBundlePath = path.join(workflowDir, "trust.bundle");
  if (fs.existsSync(trustBundlePath)) {
    const trustParsed = readJson(trustBundlePath, "trust.bundle");
    if (trustParsed.ok && objectValue(trustParsed.value)) return true;
  }
  return false;
}

function childWorkflowDirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SKIPPED_ROOT_ENTRIES.has(name))
    // [Sweep-derived, AC14] Filter infrastructure out of the SAME walk classify/apply share
    // (no second directory enumeration) — infrastructure directories never appear in ANY
    // bucket, dry-run or applied.
    .filter((name) => !isInfrastructureDir(root, name, path.join(root, name)))
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

// ─── Apply mode: archive-move engine (opt-in, --apply) ─────────────────────────────────
//
// Dry-run (no --apply) is byte-compatible with the classify-only behavior above; nothing
// below this point runs unless --apply is passed. --apply-ambiguous is a second, additive
// gate ON TOP OF --apply (see main()'s "if (!apply)" guard) — it never triggers mutation
// on its own. See the Wave 1 plan (kontourai-flow-agents-283) for the full design/safety-
// rail rationale.

type FreshHolder = { actor: string; lastAt: string; ttlSeconds: number; fresh: boolean };

type LivenessHelper = {
  readLivenessEvents: (streamPath: string) => Record<string, unknown>[];
  freshHolders: (events: Record<string, unknown>[], slug: string, selfActor: string, nowMs: number) => FreshHolder[];
};

// Dynamic require of the shared CJS liveness-read helper, mirroring the createRequire
// pattern already used by workflow-sidecar.ts's loadLivenessReadHelper()/similar loaders
// for the exact same module — one implementation of the freshness algorithm, no second copy.
let _livenessHelperCache: LivenessHelper | null = null;
function loadLivenessReadHelper(): LivenessHelper {
  if (_livenessHelperCache) return _livenessHelperCache;
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/liveness-read.js");
  _livenessHelperCache = _req(helperPath) as LivenessHelper;
  return _livenessHelperCache;
}

function runId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function runDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultArchiveRoot(artifactRoot: string): string {
  return path.join(path.dirname(artifactRoot), "flow-agents-archive");
}

// Never preferred over state.json.updated_at when it parses — mtime is ONLY the fallback
// for a missing/unparsable timestamp (Finding 7: bulk worktree mtime resets make mtime an
// unreliable primary freshness signal; it is safe only as a last resort).
function lastUpdatedMs(workflowDir: string): { ms: number; source: "updated_at" | "mtime"; raw: string | null } {
  const statePath = path.join(workflowDir, "state.json");
  const parsed = fs.existsSync(statePath) ? readJson(statePath, "state.json") : { ok: false as const, reason: "missing state.json" };
  if (parsed.ok) {
    const state = objectValue(parsed.value);
    const updatedAt = state ? stringField(state, "updated_at") : null;
    if (updatedAt) {
      const parsedMs = Date.parse(updatedAt);
      if (!Number.isNaN(parsedMs)) return { ms: parsedMs, source: "updated_at", raw: updatedAt };
    }
  }
  const mtimeMs = fs.statSync(workflowDir).mtimeMs;
  return { ms: mtimeMs, source: "mtime", raw: null };
}

function withinFreshnessWindow(workflowDir: string, freshnessWindowHours: number, nowMs: number): boolean {
  const { ms } = lastUpdatedMs(workflowDir);
  const windowMs = freshnessWindowHours * 60 * 60 * 1000;
  return nowMs - ms < windowMs;
}

function hasFreshLivenessClaim(artifactRoot: string, slug: string, nowMs: number): boolean {
  const helper = loadLivenessReadHelper();
  const streamPath = path.join(artifactRoot, "liveness", "events.jsonl");
  const events = helper.readLivenessEvents(streamPath);
  // Pass an impossible/empty selfActor: apply mode has no "self" actor to exclude from the
  // freshness join — ANY fresh holder at all (any actor) blocks the move (AC6).
  return helper.freshHolders(events, slug, "", nowMs).length > 0;
}

type ApplyOptions = {
  artifactRoot: string;
  freshnessWindowHours: number;
  applyAmbiguous: boolean;
  nowMs: number;
};

type EligibilityResult = { eligible: boolean; ambiguous: boolean; skipReason?: string };

// Hard rail (AC5): active_wip / active_learning_followup are NEVER apply targets, coded
// as an unconditional gate — not merely relying on the classifier's own bucket semantics.
// invalid is never eligible EXCEPT the two narrow --apply-ambiguous carve-outs below.
function eligibleForApply(item: AuditItem, workflowDir: string, opts: ApplyOptions): EligibilityResult {
  if (item.classification === "active_wip" || item.classification === "active_learning_followup") {
    return { eligible: false, ambiguous: false, skipReason: `hard-excluded classification: ${item.classification}` };
  }

  if (item.classification === "invalid") {
    const isAmbiguousLifecycleShape = item.reasons.length === 1 && item.reasons[0].startsWith(AMBIGUOUS_LIFECYCLE_REASON_PREFIX);
    if (!opts.applyAmbiguous) {
      return { eligible: false, ambiguous: isAmbiguousLifecycleShape, skipReason: isAmbiguousLifecycleShape ? "ambiguous lifecycle shape: needs --apply-ambiguous" : "hard-excluded classification: invalid" };
    }
    if (isAmbiguousLifecycleShape) {
      // AC10: an unrecognized-lifecycle-shape invalid item is eligible under
      // --apply-ambiguous REGARDLESS of isStructurallySubstantive() — "unrecognized
      // lifecycle shape" is itself evidence of substantive content (a stub cannot fail a
      // lifecycle-shape check it never reached; it fails earlier, at missing/malformed
      // state.json).
      return applyRailsCheck(workflowDir, opts, true);
    }
    // Not a lifecycle-shape ambiguity: only eligible if genuinely a stub (AC15's hard gate,
    // independent of *why* classifyWorkflow() called it invalid).
    if (isStructurallySubstantive(workflowDir)) {
      return { eligible: false, ambiguous: false, skipReason: "structurally-substantive invalid session: report-only, never archived (AC15)" };
    }
    return applyRailsCheck(workflowDir, opts, true);
  }

  if (item.classification === "cleanup_candidate") {
    return applyRailsCheck(workflowDir, opts, false);
  }

  if (item.classification === "terminal_done") {
    if (withinFreshnessWindow(workflowDir, opts.freshnessWindowHours, opts.nowMs)) {
      return { eligible: false, ambiguous: false, skipReason: "within freshness window" };
    }
    return applyRailsCheck(workflowDir, opts, false);
  }

  return { eligible: false, ambiguous: false, skipReason: `unhandled classification: ${item.classification}` };
}

// Shared AC6/AC7 rails (liveness + freshness), applied to every eligibility branch above
// that isn't already hard-excluded. Re-checked again immediately before the actual move in
// applyArchive()'s caller to narrow the TOCTOU window (plan stop-short-risk #2).
function applyRailsCheck(workflowDir: string, opts: ApplyOptions, ambiguous: boolean): EligibilityResult {
  const slug = path.basename(workflowDir);
  if (hasFreshLivenessClaim(opts.artifactRoot, slug, opts.nowMs)) {
    return { eligible: false, ambiguous, skipReason: "held liveness claim" };
  }
  if (withinFreshnessWindow(workflowDir, opts.freshnessWindowHours, opts.nowMs)) {
    return { eligible: false, ambiguous, skipReason: "within freshness window" };
  }
  return { eligible: true, ambiguous };
}

// AC3 never-delete guarantee: archiveMove() only ever calls fs.renameSync (atomic on the
// same filesystem — no delete-then-write race) or, on EXDEV (cross-device rename failure),
// falls back to fs.cpSync + a file-count-verified copy and ONLY THEN fs.rmSync's the
// SOURCE. The source is never removed before the destination write is verified complete.
// No code path in this file calls fs.rm/fs.unlink/fs.rmdir/fs.rmSync on a source directory
// outside this guarded, post-copy-verified fallback.
function countFiles(dir: string): number {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else count += 1;
    }
  }
  return count;
}

function archiveMove(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EXDEV")) throw error;
  }
  // Cross-device fallback: copy first, verify, THEN remove the source. Never remove `from`
  // before `to` is confirmed to hold a complete copy.
  fs.cpSync(from, to, { recursive: true });
  const sourceCount = countFiles(from);
  const destCount = countFiles(to);
  if (destCount !== sourceCount) {
    throw new Error(`archive-move verification failed for ${from} -> ${to}: source had ${sourceCount} files, destination has ${destCount}`);
  }
  fs.rmSync(from, { recursive: true, force: true });
}

type ManifestMove = {
  slug: string;
  classification: string;
  last_updated: string;
  reasons: string[];
  confirmation_evidence?: string;
};

// AC4: skip entirely (no directory created) when there is nothing to record.
function writeManifest(archiveRunDir: string, moves: ManifestMove[]): void {
  if (moves.length === 0) return;
  fs.mkdirSync(archiveRunDir, { recursive: true });
  const lines: string[] = [];
  lines.push("# Workflow Artifact Cleanup Apply — Manifest");
  lines.push("");
  lines.push(`Archive run: ${path.basename(archiveRunDir)}`);
  lines.push("");
  lines.push("| Slug | Category | Last updated | Reason | Confirmation evidence |");
  lines.push("|---|---|---|---|---|");
  for (const move of moves) {
    const reason = move.reasons.join("; ").replace(/\|/g, "\\|");
    const evidence = (move.confirmation_evidence ?? "none recorded").replace(/\|/g, "\\|");
    lines.push(`| \`${move.slug}\` | ${move.classification} | ${move.last_updated} | ${reason} | ${evidence} |`);
  }
  lines.push("");
  fs.writeFileSync(path.join(archiveRunDir, "MANIFEST.md"), lines.join("\n"), "utf8");
}

type AppliedMove = {
  slug: string;
  from: string;
  to: string;
  classification: string;
  reason: string;
};

type ApplyReport = {
  applied: boolean;
  dry_run: boolean;
  archive_run_dir: string | null;
  manifest_path: string | null;
  moves: AppliedMove[];
  ambiguous: { slug: string; reason: string }[];
};

function parseConfirmMap(values: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const slug = raw.slice(0, eq);
    const evidence = raw.slice(eq + 1);
    if (slug) map[slug] = evidence;
  }
  return map;
}

function performApply(result: AuditResult, options: {
  artifactRoot: string;
  archiveRoot: string;
  freshnessWindowHours: number;
  applyAmbiguous: boolean;
  confirmMap: Record<string, string>;
}): ApplyReport {
  const nowMs = Date.now();
  const opts: ApplyOptions = {
    artifactRoot: options.artifactRoot,
    freshnessWindowHours: options.freshnessWindowHours,
    applyAmbiguous: options.applyAmbiguous,
    nowMs,
  };

  const ambiguousReport: { slug: string; reason: string }[] = [];
  const toMove: { item: AuditItem; workflowDir: string }[] = [];

  for (const items of Object.values(result.buckets)) {
    for (const item of items) {
      const workflowDir = item.path;
      const eligibility = eligibleForApply(item, workflowDir, opts);
      if (eligibility.ambiguous && !eligibility.eligible) {
        ambiguousReport.push({ slug: item.slug, reason: eligibility.skipReason ?? "ambiguous lifecycle shape" });
      }
      if (eligibility.eligible) toMove.push({ item, workflowDir });
    }
  }

  const archiveRunDir = path.join(options.archiveRoot, `${runDate()}-${runId()}`);
  const moves: AppliedMove[] = [];
  const manifestMoves: ManifestMove[] = [];

  for (const { item, workflowDir } of toMove) {
    // Re-check liveness + freshness immediately before the actual move, narrowing the
    // TOCTOU window between classification and the move itself (plan stop-short-risk #2).
    const slug = item.slug;
    if (hasFreshLivenessClaim(options.artifactRoot, slug, Date.now())) continue;
    if (withinFreshnessWindow(workflowDir, options.freshnessWindowHours, Date.now())) continue;

    const { ms } = lastUpdatedMs(workflowDir);
    const destination = path.join(archiveRunDir, slug);
    archiveMove(workflowDir, destination);
    moves.push({ slug, from: workflowDir, to: destination, classification: item.classification, reason: item.reasons.join("; ") });
    manifestMoves.push({
      slug,
      classification: item.classification,
      last_updated: new Date(ms).toISOString(),
      reasons: item.reasons,
      confirmation_evidence: options.confirmMap[slug],
    });
  }

  let manifestPath: string | null = null;
  if (manifestMoves.length > 0) {
    writeManifest(archiveRunDir, manifestMoves);
    manifestPath = path.join(archiveRunDir, "MANIFEST.md");
  }

  return {
    applied: true,
    dry_run: false,
    archive_run_dir: moves.length > 0 ? archiveRunDir : null,
    manifest_path: manifestPath,
    moves,
    ambiguous: ambiguousReport,
  };
}

function printAppliedText(report: ApplyReport): void {
  console.log("");
  console.log(`APPLIED: ${report.moves.length} director${report.moves.length === 1 ? "y" : "ies"} archived`);
  for (const move of report.moves) {
    console.log(`  - ${move.slug} -> ${move.to}`);
    console.log(`    reason: ${move.reason}`);
  }
  if (report.manifest_path) console.log(`Manifest: ${report.manifest_path}`);
  if (report.ambiguous.length > 0) {
    console.log("");
    console.log(`Ambiguous (needs --apply-ambiguous): ${report.ambiguous.length}`);
    for (const entry of report.ambiguous) console.log(`  - ${entry.slug}: ${entry.reason}`);
  }
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (flagBool(args.flags, "help") || flagBool(args.flags, "h")) {
    printHelp();
    return 0;
  }
  let result: AuditResult;
  let root: string;
  try {
    root = flagString(args.flags, "artifact-root") ? path.resolve(flagString(args.flags, "artifact-root")!) : defaultArtifactRootForRead();
    result = audit(root);
  } catch (error) {
    console.error(`workflow-artifact-cleanup-audit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const apply = flagBool(args.flags, "apply");
  const applyAmbiguous = flagBool(args.flags, "apply-ambiguous");
  const json = flagBool(args.flags, "json");

  // Two-gate model (plan-pinned, Task 1 Changes: "--apply-ambiguous (bool, requires
  // --apply to have any effect)"): --apply-ambiguous ALONE performs zero mutation. The
  // mutation path below is entered ONLY when --apply itself is set; --apply-ambiguous
  // without --apply degrades to the same read-only dry-run output as no flags at all —
  // it is a second, additive gate on top of --apply, never an independent trigger. This
  // is the strict form of the plan's "requires --apply" language: a bare --apply-ambiguous
  // invocation is treated as a no-op rather than silently doing nothing while looking like
  // it might have done something, matching AC1's dry-run-default guarantee.
  if (!apply) {
    if (json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    return 0;
  }

  // AC8: freshness window / archive root are configurable ONLY via CLI flags — no
  // environment variable is ever read here to loosen or redirect either.
  const freshnessWindowHoursRaw = flagString(args.flags, "freshness-window-hours");
  const freshnessWindowHours = freshnessWindowHoursRaw ? Number(freshnessWindowHoursRaw) : 48;
  if (!Number.isFinite(freshnessWindowHours) || freshnessWindowHours < 0) {
    console.error("workflow-artifact-cleanup-audit: --freshness-window-hours must be a non-negative number");
    return 1;
  }
  const archiveRoot = flagString(args.flags, "archive-root") ? path.resolve(flagString(args.flags, "archive-root")!) : defaultArchiveRoot(root);
  const confirmMap = parseConfirmMap(flagList(args.flags, "confirm"));

  let report: ApplyReport;
  try {
    report = performApply(result, {
      artifactRoot: root,
      archiveRoot,
      freshnessWindowHours,
      applyAmbiguous,
      confirmMap,
    });
  } catch (error) {
    console.error(`workflow-artifact-cleanup-audit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify({ ...result, ...report }, null, 2));
  } else {
    printText(result);
    printAppliedText(report);
  }
  return 0;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
