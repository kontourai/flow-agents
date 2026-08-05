import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WORK_ITEM_MUTATION_SCHEMA_VERSION,
  WorkItemMutationError,
  detectMutationConflict,
  parseObservedWorkItemState,
  parseWorkItemMutationRequest,
  workItemMutationOperations,
  workItemMutationResultStatuses,
} from "../../build/src/lib/work-item-mutations.js";
import {
  applyLocalFileMutation,
  main as workItemMutationProviderMain,
  parseGithubMutationTarget,
  readLocalBacklogDoc,
  renderGithubMutation,
} from "../../build/src/cli/work-item-mutation-provider.js";
// Also import from the package's own root entry (self-reference resolution via package.json
// "name" + "exports"), mirroring work-item-vocabulary.test.mjs's guard against the src/index.ts
// re-export silently drifting from the internal module (#775 precedent).
import { workItemMutationOperations as workItemMutationOperationsFromPackageRoot } from "@kontourai/flow-agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../build/src/cli.js");

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-item-mutation-provider-"));
  try {
    const result = run(dir);
    if (result && typeof result.then === "function") {
      return result.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const GITHUB_TARGET = { repo: { owner: "kontourai", name: "flow-agents" }, number: 776 };
const MATCHING_REF = { id: "github:kontourai/flow-agents#776", owner: "kontourai", repo: "flow-agents", number: 776 };

function statusRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    operation: "status_transition",
    work_item_ref: MATCHING_REF,
    base: { status: "in_progress" },
    payload: { to_status: "review" },
    ...overrides,
  };
}

function fieldRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    operation: "field_update",
    work_item_ref: MATCHING_REF,
    base: { field_values: { priority: "P1" } },
    payload: { field: "priority", value: "P0" },
    ...overrides,
  };
}

function commentRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    operation: "comment",
    work_item_ref: MATCHING_REF,
    base: {},
    payload: { body: "status update" },
    ...overrides,
  };
}

// ─── contract-shape tests ───────────────────────────────────────────────────

test("workItemMutationOperations matches the contract's Operations table", () => {
  assert.deepEqual([...workItemMutationOperations], ["status_transition", "field_update", "comment"]);
});

test("workItemMutationResultStatuses matches the contract's mutation-result vocabulary", () => {
  assert.deepEqual([...workItemMutationResultStatuses], ["rendered", "applied", "conflict", "rejected", "not_verified"]);
});

test("workItemMutationOperations exported from the package root entry matches the internal module (#775 pattern)", () => {
  assert.deepEqual([...workItemMutationOperationsFromPackageRoot], [...workItemMutationOperations]);
});

test("parseWorkItemMutationRequest accepts a well-formed status_transition request", () => {
  const parsed = parseWorkItemMutationRequest(statusRequest());
  assert.equal(parsed.schema_version, WORK_ITEM_MUTATION_SCHEMA_VERSION);
  assert.equal(parsed.operation, "status_transition");
  assert.equal(parsed.base.status, "in_progress");
  assert.equal(parsed.payload.to_status, "review");
});

test("parseWorkItemMutationRequest rejects status_transition missing base.status (staleness detection requires a declared base)", () => {
  const request = statusRequest();
  delete request.base.status;
  assert.throws(() => parseWorkItemMutationRequest(request), WorkItemMutationError);
});

test("parseWorkItemMutationRequest rejects field_update missing the field's base value", () => {
  const request = fieldRequest();
  request.base.field_values = {};
  assert.throws(() => parseWorkItemMutationRequest(request), WorkItemMutationError);
});

test("parseWorkItemMutationRequest accepts comment with no base at all (append-only, non-clobbering)", () => {
  const parsed = parseWorkItemMutationRequest({ schema_version: "1.0", operation: "comment", work_item_ref: { id: "x" }, payload: { body: "hi" } });
  assert.equal(parsed.operation, "comment");
  assert.deepEqual(parsed.base, {});
});

test("parseWorkItemMutationRequest rejects an unsupported operation and a wrong schema_version", () => {
  assert.throws(() => parseWorkItemMutationRequest({ ...statusRequest(), operation: "delete" }), WorkItemMutationError);
  assert.throws(() => parseWorkItemMutationRequest({ ...statusRequest(), schema_version: "2.0" }), WorkItemMutationError);
});

// ─── review finding #5: status vocabulary must be canonical, not arbitrary provider text ──────

test("parseWorkItemMutationRequest rejects an arbitrary (non-canonical) base.status", () => {
  const request = statusRequest({ base: { status: "yolo-in-flight" } });
  assert.throws(() => parseWorkItemMutationRequest(request), (error) => {
    assert.ok(error instanceof WorkItemMutationError);
    assert.match(error.message, /canonical work item statuses/);
    return true;
  });
});

test("parseWorkItemMutationRequest rejects an arbitrary (non-canonical) payload.to_status", () => {
  const request = statusRequest({ payload: { to_status: "triage" } });
  // "triage" is a real read-side board sentinel (see work-item-vocabulary.ts) but deliberately
  // excluded from workItemStatuses — it must not be accepted as a mutation destination status.
  assert.throws(() => parseWorkItemMutationRequest(request), WorkItemMutationError);
});

test("parseWorkItemMutationRequest accepts payload.to_status_raw carrying provider-native text alongside a canonical to_status", () => {
  const parsed = parseWorkItemMutationRequest(statusRequest({ payload: { to_status: "review", to_status_raw: "In Review (Board Column 4)" } }));
  assert.equal(parsed.payload.to_status, "review");
  assert.equal(parsed.payload.to_status_raw, "In Review (Board Column 4)");
});

test("detectMutationConflict: comment operations never conflict", () => {
  const request = parseWorkItemMutationRequest(commentRequest());
  assert.equal(detectMutationConflict(request, { status: "anything" }), null);
});

test("detectMutationConflict: status_transition matches base -> no conflict; diverges -> conflict with observed value", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  assert.equal(detectMutationConflict(request, { status: "in_progress" }), null);
  assert.deepEqual(detectMutationConflict(request, { status: "blocked" }), { field: "status", base_value: "in_progress", observed_value: "blocked" });
});

test("detectMutationConflict: field_update compares only the mutated field, by strict equality", () => {
  const request = parseWorkItemMutationRequest(fieldRequest());
  assert.equal(detectMutationConflict(request, { field_values: { priority: "P1", risk: "high" } }), null);
  assert.deepEqual(detectMutationConflict(request, { field_values: { priority: "P2" } }), { field: "priority", base_value: "P1", observed_value: "P2" });
});

test("detectMutationConflict: an absent observed value is a genuine divergence (null), not a silent pass", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  assert.deepEqual(detectMutationConflict(request, {}), { field: "status", base_value: "in_progress", observed_value: null });
});

test("parseObservedWorkItemState normalizes a loose observation payload", () => {
  assert.deepEqual(parseObservedWorkItemState({ status: "review", field_values: { priority: "P0" } }), { status: "review", field_values: { priority: "P0" } });
  assert.deepEqual(parseObservedWorkItemState(undefined), {});
});

// ─── review finding #6: comment idempotency_key ────────────────────────────

test("parseWorkItemMutationRequest accepts and normalizes an optional comment idempotency_key", () => {
  const parsed = parseWorkItemMutationRequest(commentRequest({ payload: { body: "hi", idempotency_key: "dedupe-1" } }));
  assert.equal(parsed.payload.idempotency_key, "dedupe-1");
});

test("parseWorkItemMutationRequest rejects a non-string idempotency_key", () => {
  const request = commentRequest({ payload: { body: "hi", idempotency_key: 12 } });
  assert.throws(() => parseWorkItemMutationRequest(request), WorkItemMutationError);
});

// ─── GitHub adapter: target validation and identity guard (review finding #3) ─────────────────

test("parseGithubMutationTarget accepts a well-formed target and rejects a malformed one", () => {
  assert.deepEqual(parseGithubMutationTarget(GITHUB_TARGET), GITHUB_TARGET);
  assert.throws(() => parseGithubMutationTarget({ repo: { owner: "kontourai" }, number: 776 }), WorkItemMutationError);
  assert.throws(() => parseGithubMutationTarget({ repo: { owner: "kontourai", name: "flow-agents" }, number: -1 }), WorkItemMutationError);
  assert.throws(() => parseGithubMutationTarget({ repo: { owner: "kontourai", name: "flow-agents" }, number: 1.5 }), WorkItemMutationError);
  assert.throws(() => parseGithubMutationTarget(null), WorkItemMutationError);
});

test("parseGithubMutationTarget validates an optional project_field's shape", () => {
  const withField = parseGithubMutationTarget({ ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1", option_id: "OPT_1" } });
  assert.deepEqual(withField.project_field, { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1", option_id: "OPT_1" });
  assert.throws(() => parseGithubMutationTarget({ ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1" } }), WorkItemMutationError);
});

test("renderGithubMutation: a target naming a DIFFERENT work item than request.work_item_ref is rejected before rendering any command (target redirect guard)", () => {
  const request = parseWorkItemMutationRequest(statusRequest({ work_item_ref: { id: "github:kontourai/flow-agents#776", owner: "kontourai", repo: "flow-agents", number: 776 } }));
  const wrongTarget = { repo: { owner: "kontourai", name: "flow-agents" }, number: 999 };
  const record = renderGithubMutation(request, { status: "in_progress" }, wrongTarget);
  assert.equal(record.status, "rejected");
  assert.match(record.reason, /does not match request\.work_item_ref/);
  assert.equal(record.gh_commands, undefined);
});

test("renderGithubMutation: a work_item_ref missing owner/repo/number is rejected before rendering (cannot validate against the target)", () => {
  const request = parseWorkItemMutationRequest(statusRequest({ work_item_ref: { id: "github:kontourai/flow-agents#776" } }));
  const record = renderGithubMutation(request, { status: "in_progress" }, GITHUB_TARGET);
  assert.equal(record.status, "rejected");
  assert.match(record.reason, /must include owner, repo, and number/);
  assert.equal(record.gh_commands, undefined);
});

test("renderGithubMutation: the target redirect guard also applies to comment mutations", () => {
  const request = parseWorkItemMutationRequest(commentRequest({ work_item_ref: { id: "github:kontourai/flow-agents#776", owner: "kontourai", repo: "flow-agents", number: 776 } }));
  const wrongTarget = { repo: { owner: "someone-else", name: "other-repo" }, number: 1 };
  const record = renderGithubMutation(request, null, wrongTarget);
  assert.equal(record.status, "rejected");
  assert.equal(record.gh_commands, undefined);
});

// ─── GitHub adapter: argv rendering (render, don't execute) ───────────────

test("renderGithubMutation: status_transition with matching base renders a label swap argv, never executes", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  const record = renderGithubMutation(request, { status: "in_progress" }, GITHUB_TARGET);
  assert.equal(record.status, "rendered");
  assert.equal(record.base_ref, "kontourai/flow-agents#776");
  assert.deepEqual(record.gh_commands, [
    ["issue", "edit", "776", "--repo", "kontourai/flow-agents", "--remove-label", "status:in_progress"],
    ["issue", "edit", "776", "--repo", "kontourai/flow-agents", "--add-label", "status:review"],
  ]);
});

test("renderGithubMutation: no prior observed status (base diverges from a truly unset status) is a conflict, not a silent proceed", () => {
  const request = parseWorkItemMutationRequest(statusRequest({ base: { status: "todo" } }));
  const record = renderGithubMutation(request, {}, GITHUB_TARGET);
  assert.equal(record.status, "conflict");
});

test("renderGithubMutation: field_update renders a <field>:<value> label swap", () => {
  const request = parseWorkItemMutationRequest(fieldRequest());
  const record = renderGithubMutation(request, { field_values: { priority: "P1" } }, GITHUB_TARGET);
  assert.equal(record.status, "rendered");
  assert.deepEqual(record.gh_commands, [
    ["issue", "edit", "776", "--repo", "kontourai/flow-agents", "--remove-label", "priority:P1"],
    ["issue", "edit", "776", "--repo", "kontourai/flow-agents", "--add-label", "priority:P0"],
  ]);
});

test("renderGithubMutation: field_update against a configured GitHub Projects v2 field renders project item-edit argv", () => {
  const request = parseWorkItemMutationRequest(fieldRequest());
  const target = { ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1" } };
  const record = renderGithubMutation(request, { field_values: { priority: "P1" } }, target);
  assert.equal(record.status, "rendered");
  assert.deepEqual(record.gh_commands, [["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "PVTF_1", "--text", "P0"]]);
});

test("renderGithubMutation: status_transition against a project status field requires option_id and renders single-select argv", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  const targetMissingOption = { ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1" } };
  const rejected = renderGithubMutation(request, { status: "in_progress" }, targetMissingOption);
  assert.equal(rejected.status, "rejected");

  const target = { ...targetMissingOption, project_field: { ...targetMissingOption.project_field, option_id: "OPT_REVIEW" } };
  const rendered = renderGithubMutation(request, { status: "in_progress" }, target);
  assert.equal(rendered.status, "rendered");
  assert.deepEqual(rendered.gh_commands, [["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "PVTF_1", "--single-select-option-id", "OPT_REVIEW"]]);
});

test("renderGithubMutation: comment always renders gh issue comment argv regardless of observation", () => {
  const request = parseWorkItemMutationRequest(commentRequest());
  const record = renderGithubMutation(request, null, GITHUB_TARGET);
  assert.equal(record.status, "rendered");
  assert.deepEqual(record.gh_commands, [["issue", "comment", "776", "--repo", "kontourai/flow-agents", "--body", "status update"]]);
});

test("renderGithubMutation: no observed state supplied for a clobber-risk operation returns not_verified, never a fabricated render", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  const record = renderGithubMutation(request, null, GITHUB_TARGET);
  assert.equal(record.status, "not_verified");
  assert.equal(record.gh_commands, undefined);
});

test("renderGithubMutation: diverged base surfaces a conflict and renders no gh_commands (provider wins, never clobbers)", () => {
  const request = parseWorkItemMutationRequest(statusRequest());
  const record = renderGithubMutation(request, { status: "blocked" }, GITHUB_TARGET);
  assert.equal(record.status, "conflict");
  assert.deepEqual(record.conflict, { field: "status", base_value: "in_progress", observed_value: "blocked" });
  assert.equal(record.gh_commands, undefined);
});

test("renderGithubMutation never touches gh: the module never imports node:child_process (render, don't execute)", () => {
  const source = fs.readFileSync(path.join(__dirname, "work-item-mutation-provider.ts"), "utf8");
  assert.ok(!/from\s+["']node:child_process["']/.test(source), "work-item-mutation-provider.ts must never import node:child_process — see the contract's Render, Don't Execute section");
});

// ─── review finding #2: GitHub conflict check is advisory at render time only ─────────────────

test("renderGithubMutation: status_transition/field_update rendered and conflict results carry advisory: true", () => {
  const statusRendered = renderGithubMutation(parseWorkItemMutationRequest(statusRequest()), { status: "in_progress" }, GITHUB_TARGET);
  assert.equal(statusRendered.advisory, true);
  const statusConflict = renderGithubMutation(parseWorkItemMutationRequest(statusRequest()), { status: "blocked" }, GITHUB_TARGET);
  assert.equal(statusConflict.advisory, true);
  const fieldRendered = renderGithubMutation(parseWorkItemMutationRequest(fieldRequest()), { field_values: { priority: "P1" } }, GITHUB_TARGET);
  assert.equal(fieldRendered.advisory, true);
});

test("renderGithubMutation: comment and not_verified/rejected results never carry advisory (no conflict check occurred)", () => {
  const comment = renderGithubMutation(parseWorkItemMutationRequest(commentRequest()), null, GITHUB_TARGET);
  assert.equal(comment.advisory, undefined);
  const notVerified = renderGithubMutation(parseWorkItemMutationRequest(statusRequest()), null, GITHUB_TARGET);
  assert.equal(notVerified.advisory, undefined);
  const rejectedTarget = renderGithubMutation(parseWorkItemMutationRequest(statusRequest()), { status: "in_progress" }, { repo: { owner: "x", name: "y" }, number: 1 });
  assert.equal(rejectedTarget.advisory, undefined);
});

// ─── review finding #4: null clears, booleans are rejected ────────────────

test("renderGithubMutation: field_update value null clears the label (remove-only, no add-label)", () => {
  const request = parseWorkItemMutationRequest(fieldRequest({ payload: { field: "priority", value: null } }));
  const record = renderGithubMutation(request, { field_values: { priority: "P1" } }, GITHUB_TARGET);
  assert.equal(record.status, "rendered");
  assert.deepEqual(record.gh_commands, [["issue", "edit", "776", "--repo", "kontourai/flow-agents", "--remove-label", "priority:P1"]]);
});

test("renderGithubMutation: field_update value null against a project field renders --clear, not a --text/--number flag", () => {
  const request = parseWorkItemMutationRequest(fieldRequest({ payload: { field: "priority", value: null } }));
  const target = { ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1" } };
  const record = renderGithubMutation(request, { field_values: { priority: "P1" } }, target);
  assert.equal(record.status, "rendered");
  assert.deepEqual(record.gh_commands, [["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "PVTF_1", "--clear"]]);
});

test("renderGithubMutation: field_update rejects a boolean value for both labels and project-field targets", () => {
  const request = parseWorkItemMutationRequest(fieldRequest({ payload: { field: "priority", value: true } }));
  const labelsRecord = renderGithubMutation(request, { field_values: { priority: "P1" } }, GITHUB_TARGET);
  assert.equal(labelsRecord.status, "rejected");
  assert.match(labelsRecord.reason, /must not be a boolean/);
  assert.equal(labelsRecord.gh_commands, undefined);

  const target = { ...GITHUB_TARGET, project_field: { project_id: "PVT_1", item_id: "PVTI_1", field_id: "PVTF_1" } };
  const projectRecord = renderGithubMutation(request, { field_values: { priority: "P1" } }, target);
  assert.equal(projectRecord.status, "rejected");
  assert.equal(projectRecord.gh_commands, undefined);
});

// ─── local-file adapter: real read-modify-write round trip + staleness conflict ─────────────

function seedBacklog(dir, items) {
  const file = path.join(dir, "backlog.json");
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: "1.0", items }, null, 2)}\n`, "utf8");
  return file;
}

test("applyLocalFileMutation: status_transition round trip actually writes the file (proves the second, real implementation)", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress", field_values: { priority: "P1" } }]);
    const result = applyLocalFileMutation(file, parseWorkItemMutationRequest(statusRequest({ work_item_ref: { id: "local:1" } })));
    assert.equal(result.status, "applied");
    const doc = readLocalBacklogDoc(file);
    assert.equal(doc.items[0].status, "review");
    assert.ok(doc.items[0].updated_at);
  });
});

test("applyLocalFileMutation: field_update round trip merges into field_values without dropping other fields", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress", field_values: { priority: "P1", risk: "high" } }]);
    const result = applyLocalFileMutation(file, parseWorkItemMutationRequest(fieldRequest({ work_item_ref: { id: "local:1" } })));
    assert.equal(result.status, "applied");
    const doc = readLocalBacklogDoc(file);
    assert.deepEqual(doc.items[0].field_values, { priority: "P0", risk: "high" });
  });
});

test("applyLocalFileMutation: comment round trip appends without requiring a base", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const result = applyLocalFileMutation(file, parseWorkItemMutationRequest(commentRequest({ work_item_ref: { id: "local:1" } })));
    assert.equal(result.status, "applied");
    const doc = readLocalBacklogDoc(file);
    assert.equal(doc.items[0].comments.length, 1);
    assert.equal(doc.items[0].comments[0].body, "status update");
  });
});

test("applyLocalFileMutation: staleness-conflict case — a stale declared base is refused and the file is left untouched (provider wins)", () => {
  withTempDir((dir) => {
    // Seed the file at a status a concurrent writer already advanced to ("blocked"), while the
    // mutation being applied still declares the OLD base ("in_progress") it was computed from.
    const file = seedBacklog(dir, [{ id: "local:1", status: "blocked", field_values: { priority: "P1" } }]);
    const before = fs.readFileSync(file, "utf8");
    const result = applyLocalFileMutation(file, parseWorkItemMutationRequest(statusRequest({ work_item_ref: { id: "local:1" } })));
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.conflict, { field: "status", base_value: "in_progress", observed_value: "blocked" });
    // Byte-identical file: a conflicting mutation must never partially or fully clobber current state.
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("applyLocalFileMutation: unknown work item id is rejected, not silently ignored", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const result = applyLocalFileMutation(file, parseWorkItemMutationRequest(statusRequest({ work_item_ref: { id: "local:missing" } })));
    assert.equal(result.status, "rejected");
    assert.match(result.reason, /not found/);
  });
});

// ─── review finding #6: local-file comment idempotency dedupe ─────────────

test("applyLocalFileMutation: a comment with a previously-used idempotency_key is deduped, not appended twice", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const request = parseWorkItemMutationRequest(commentRequest({ work_item_ref: { id: "local:1" }, payload: { body: "hello", idempotency_key: "dedupe-1" } }));
    const first = applyLocalFileMutation(file, request);
    assert.equal(first.status, "applied");
    const second = applyLocalFileMutation(file, request);
    assert.equal(second.status, "applied");
    assert.match(second.reason, /already present/);
    const doc = readLocalBacklogDoc(file);
    assert.equal(doc.items[0].comments.length, 1, "the duplicate must not be appended a second time");
    assert.match(doc.items[0].comments[0].body, /<!-- flow-agents:mutation-comment:dedupe-1 -->/);
  });
});

test("applyLocalFileMutation: comments without an idempotency_key are never deduped (each call appends)", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const request = parseWorkItemMutationRequest(commentRequest({ work_item_ref: { id: "local:1" } }));
    applyLocalFileMutation(file, request);
    applyLocalFileMutation(file, request);
    const doc = readLocalBacklogDoc(file);
    assert.equal(doc.items[0].comments.length, 2);
  });
});

// ─── review finding #1: TOCTOU / lost-update fix, proven with real concurrent OS processes ────

function spawnCliMutationApply(requestFile, backlogFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "work-item-mutation-provider", "apply", "--request-json", requestFile, "--file", backlogFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("applyLocalFileMutation (via the real CLI, two concurrent OS processes): interleaved mutations to different fields both apply — no lost update", async () => {
  await withTempDir(async (dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress", field_values: { priority: "P1", risk: "low" } }]);
    const requestA = path.join(dir, "request-a.json");
    const requestB = path.join(dir, "request-b.json");
    fs.writeFileSync(requestA, JSON.stringify(fieldRequest({ work_item_ref: { id: "local:1" }, base: { field_values: { priority: "P1" } }, payload: { field: "priority", value: "P0" } })));
    fs.writeFileSync(requestB, JSON.stringify(fieldRequest({ work_item_ref: { id: "local:1" }, base: { field_values: { risk: "low" } }, payload: { field: "risk", value: "high" } })));

    // Launch both as REAL, independent OS processes, started without awaiting either first, so
    // the OS is free to interleave their startup and lock-acquire attempts. withSubjectLock's
    // real filesystem mutual exclusion (not a test hook) is what must serialize their
    // read-modify-write sections.
    const [resultA, resultB] = await Promise.all([spawnCliMutationApply(requestA, file), spawnCliMutationApply(requestB, file)]);
    assert.equal(resultA.code, 0, resultA.stderr);
    assert.equal(resultB.code, 0, resultB.stderr);
    assert.equal(JSON.parse(resultA.stdout).status, "applied");
    assert.equal(JSON.parse(resultB.stdout).status, "applied");

    const doc = readLocalBacklogDoc(file);
    // If the TOCTOU race were still present, whichever process wrote LAST would have read the
    // file before the other's write landed and clobbered it wholesale, losing that change. Both
    // fields being present proves the lock serialized the two read-modify-write sections so the
    // second writer observed (and preserved) the first writer's already-applied change.
    assert.deepEqual(doc.items[0].field_values, { priority: "P0", risk: "high" }, "both concurrent field updates must be preserved — no lost update");
  });
});

test("applyLocalFileMutation (via the real CLI, two concurrent OS processes): interleaved comment appends never drop a comment (closes the concurrent-append race)", async () => {
  await withTempDir(async (dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const requestA = path.join(dir, "comment-a.json");
    const requestB = path.join(dir, "comment-b.json");
    fs.writeFileSync(requestA, JSON.stringify(commentRequest({ work_item_ref: { id: "local:1" }, payload: { body: "comment from process A" } })));
    fs.writeFileSync(requestB, JSON.stringify(commentRequest({ work_item_ref: { id: "local:1" }, payload: { body: "comment from process B" } })));

    const [resultA, resultB] = await Promise.all([spawnCliMutationApply(requestA, file), spawnCliMutationApply(requestB, file)]);
    assert.equal(resultA.code, 0, resultA.stderr);
    assert.equal(resultB.code, 0, resultB.stderr);

    const doc = readLocalBacklogDoc(file);
    assert.equal(doc.items[0].comments.length, 2, "both concurrently-appended comments must survive — an unlocked array-append race would drop one");
    const bodies = doc.items[0].comments.map((c) => c.body).sort();
    assert.deepEqual(bodies, ["comment from process A", "comment from process B"]);
  });
});

test("applyLocalFileMutation: same-field concurrent mutations serialize so the SECOND observes the FIRST's write and correctly reports conflict rather than silently double-applying", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress", field_values: { priority: "P1" } }]);
    const request = parseWorkItemMutationRequest(fieldRequest({ work_item_ref: { id: "local:1" }, base: { field_values: { priority: "P1" } }, payload: { field: "priority", value: "P0" } }));
    // Sequential calls through the SAME lock-protected function model the guaranteed-serialized
    // outcome directly: the first call transitions priority P1 -> P0; a second call declaring the
    // SAME stale base ("P1") must now see the first call's write and refuse, never silently
    // reapplying or double-counting.
    const first = applyLocalFileMutation(file, request);
    assert.equal(first.status, "applied");
    const second = applyLocalFileMutation(file, request);
    assert.equal(second.status, "conflict");
    assert.deepEqual(second.conflict, { field: "priority", base_value: "P1", observed_value: "P0" });
  });
});

// ─── CLI entry points (render/apply/status subcommands) ───────────────────

function runCli(argv) {
  let out = "";
  let err = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => { out += `${line}\n`; };
  console.error = (line) => { err += `${line}\n`; };
  let code;
  try {
    code = workItemMutationProviderMain(argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { code, out, err };
}

test("CLI render command reads request/observed/target JSON files and prints the rendered record", () => {
  withTempDir((dir) => {
    const requestFile = path.join(dir, "request.json");
    const targetFile = path.join(dir, "target.json");
    const observedFile = path.join(dir, "observed.json");
    fs.writeFileSync(requestFile, JSON.stringify(statusRequest()));
    fs.writeFileSync(targetFile, JSON.stringify(GITHUB_TARGET));
    fs.writeFileSync(observedFile, JSON.stringify({ status: "in_progress" }));
    const { code, out } = runCli(["render", "--request-json", requestFile, "--target-json", targetFile, "--observed-json", observedFile]);
    assert.equal(code, 0);
    const printed = JSON.parse(out);
    assert.equal(printed.status, "rendered");
  });
});

test("CLI render command surfaces a malformed target-json as a nonzero exit", () => {
  withTempDir((dir) => {
    const requestFile = path.join(dir, "request.json");
    const targetFile = path.join(dir, "target.json");
    fs.writeFileSync(requestFile, JSON.stringify(statusRequest()));
    fs.writeFileSync(targetFile, JSON.stringify({ repo: { owner: "kontourai" } }));
    const { code, err } = runCli(["render", "--request-json", requestFile, "--target-json", targetFile]);
    assert.equal(code, 1);
    assert.match(err, /invalid_request/);
  });
});

test("CLI apply command performs the real local-file mutation", () => {
  withTempDir((dir) => {
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const requestFile = path.join(dir, "request.json");
    fs.writeFileSync(requestFile, JSON.stringify(statusRequest({ work_item_ref: { id: "local:1" } })));
    const { code, out } = runCli(["apply", "--request-json", requestFile, "--file", file]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).status, "applied");
    assert.equal(readLocalBacklogDoc(file).items[0].status, "review");
  });
});

test("CLI with no/unknown subcommand prints usage and a nonzero exit for an unknown command", () => {
  const help = runCli([]);
  assert.equal(help.code, 0);
  assert.match(help.err, /Usage: work-item-mutation-provider/);

  const unknown = runCli(["bogus"]);
  assert.equal(unknown.code, 64);
});

test("CLI apply command surfaces a validation error as a nonzero exit, not a crash", () => {
  withTempDir((dir) => {
    const requestFile = path.join(dir, "bad-request.json");
    fs.writeFileSync(requestFile, JSON.stringify({ schema_version: "1.0", operation: "status_transition", work_item_ref: { id: "local:1" }, base: {}, payload: { to_status: "review" } }));
    const file = seedBacklog(dir, [{ id: "local:1", status: "in_progress" }]);
    const { code, err } = runCli(["apply", "--request-json", requestFile, "--file", file]);
    assert.equal(code, 1);
    assert.match(err, /invalid_request/);
  });
});
