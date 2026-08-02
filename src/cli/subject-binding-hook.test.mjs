// PreToolUse first-write interception (#1099).
//
// The gate answers a fact ("a file is about to be written and no subject is bound"), never a
// guess about intent. These tests hold the boundaries that keep it from becoming noise: reads
// pass, non-mutating tools pass, a bound subject passes, and `off` disables it entirely.
//
// Run: `npm run test:unit`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const HOOK = path.join(REPO_ROOT, "scripts/hooks/subject-binding.js");
const subjectBinding = require_(path.join(REPO_ROOT, "scripts/hooks/lib/subject-binding.js"));
const currentPointer = require_(path.join(REPO_ROOT, "scripts/hooks/lib/current-pointer.js"));

const ACTOR = "unit-subject-binding-actor";

function tmprepo() {
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fa-binding-"));
  fs.mkdirSync(path.join(repo, ".kontourai", "flow-agents"), { recursive: true });
  return repo;
}

/** Drive the hook as a real process, exactly as run-hook.js does. */
function invoke(repo, payload, env = {}) {
  const result = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: repo, ...payload }),
    encoding: "utf8",
    env: { ...process.env, FLOW_AGENTS_ACTOR: ACTOR, FLOW_AGENTS_REPO: "octo/demo", ...env },
    // A block exits 2; capture rather than throw.
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result, exitCode: 0 };
}

function invokeAllowFailure(repo, payload, env = {}) {
  try {
    return { ...invoke(repo, payload, env), blocked: false };
  } catch (error) {
    return { stdout: String(error.stdout || ""), stderr: String(error.stderr || ""), exitCode: error.status, blocked: error.status === 2 };
  }
}

const WRITE = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/example/src/index.ts", content: "x" } };
const READ = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/example/src/index.ts" } };

// ── classification ───────────────────────────────────────────────────────────

test("classifyMutation flags file-writing tools and nothing else", () => {
  assert.equal(subjectBinding.classifyMutation({ tool_name: "Write", tool_input: { file_path: "a" } }).mutating, true);
  assert.equal(subjectBinding.classifyMutation({ tool_name: "Edit", tool_input: { file_path: "a" } }).mutating, true);
  assert.equal(subjectBinding.classifyMutation({ tool_name: "NotebookEdit", tool_input: { notebook_path: "a" } }).mutating, true);
  assert.equal(subjectBinding.classifyMutation({ tool_name: "Read", tool_input: { file_path: "a" } }).mutating, false);
  assert.equal(subjectBinding.classifyMutation({ tool_name: "Grep", tool_input: {} }).mutating, false);
  // Bash is deliberately NOT classified as mutating -- see the MUTATING_TOOLS doc comment.
  assert.equal(subjectBinding.classifyMutation({ tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ f" } }).mutating, false);
  assert.equal(subjectBinding.classifyMutation({}).mutating, false);
});

test("resolveSubjectBindingMode defaults to warn and honours off/block", () => {
  assert.equal(subjectBinding.resolveSubjectBindingMode({}), "warn");
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "" }), "warn");
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "block" }), "block");
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "BLOCK" }), "block");
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "off" }), "off");
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "0" }), "off");
  // An unrecognised value must not silently disable the gate.
  assert.equal(subjectBinding.resolveSubjectBindingMode({ FLOW_AGENTS_SUBJECT_BINDING: "nonsense" }), "warn");
});

// ── hook behaviour ───────────────────────────────────────────────────────────

test("unbound first write is advised, not blocked, by default", () => {
  const repo = tmprepo();
  const { stdout } = invoke(repo, WRITE);
  assert.match(stdout, /\[SUBJECT BINDING\]/);
  assert.match(stdout, /no Flow Agents subject is bound/);
  assert.match(stdout, /flow-agents workflow start --flow builder\.build --work-item octo\/demo#<issue>/);
  assert.match(stdout, /DERIVED from the backlog item/);
  // The raw payload is passed through unchanged ahead of the guidance.
  assert.ok(stdout.startsWith("{"), "hook must not swallow the tool payload");
});

test("a read is never advised", () => {
  const repo = tmprepo();
  const { stdout } = invoke(repo, READ);
  assert.doesNotMatch(stdout, /SUBJECT BINDING/);
});

test("a bound subject passes silently", () => {
  const repo = tmprepo();
  const artifactRoot = path.join(repo, ".kontourai", "flow-agents");
  fs.mkdirSync(path.join(artifactRoot, "octo-demo-1061"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, "octo-demo-1061", "state.json"),
    JSON.stringify({ task_slug: "octo-demo-1061", status: "in_progress", work_item_refs: ["octo/demo#1061"] }),
  );
  currentPointer.writePerActorCurrent(artifactRoot, ACTOR, { active_slug: "octo-demo-1061" });
  const { stdout } = invoke(repo, WRITE);
  assert.doesNotMatch(stdout, /SUBJECT BINDING/);
});

test("FLOW_AGENTS_SUBJECT_BINDING=off disables the gate entirely", () => {
  const repo = tmprepo();
  const { stdout } = invoke(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING: "off" });
  assert.doesNotMatch(stdout, /SUBJECT BINDING/);
});

test("FLOW_AGENTS_SUBJECT_BINDING=block refuses the write and says why", () => {
  const repo = tmprepo();
  const result = invokeAllowFailure(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING: "block" });
  assert.equal(result.blocked, true, "block mode must exit 2");
  assert.match(result.stderr, /\[SUBJECT BINDING\]/);
});

test("block mode does not fire for a bound subject", () => {
  const repo = tmprepo();
  const artifactRoot = path.join(repo, ".kontourai", "flow-agents");
  fs.mkdirSync(path.join(artifactRoot, "octo-demo-1061"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, "octo-demo-1061", "state.json"),
    JSON.stringify({ task_slug: "octo-demo-1061", status: "in_progress", work_item_refs: ["octo/demo#1061"] }),
  );
  currentPointer.writePerActorCurrent(artifactRoot, ACTOR, { active_slug: "octo-demo-1061" });
  const result = invokeAllowFailure(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING: "block" });
  assert.equal(result.blocked, false);
});

test("warn mode repeats are cooldown-limited per actor", () => {
  const repo = tmprepo();
  const first = invoke(repo, WRITE);
  assert.match(first.stdout, /SUBJECT BINDING/);
  const second = invoke(repo, WRITE);
  assert.doesNotMatch(second.stdout, /SUBJECT BINDING/, "a per-write nag is what makes a mechanism dismissible");
  // A zero cooldown opts back into every-write advice.
  const third = invoke(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING_COOLDOWN_SECONDS: "0" });
  assert.match(third.stdout, /SUBJECT BINDING/);
});

test("block mode has no cooldown -- a gate that refuses once and permits after is worse than either", () => {
  const repo = tmprepo();
  assert.equal(invokeAllowFailure(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING: "block" }).blocked, true);
  assert.equal(invokeAllowFailure(repo, WRITE, { FLOW_AGENTS_SUBJECT_BINDING: "block" }).blocked, true);
});

test("malformed input fails open", () => {
  const result = execFileSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", env: { ...process.env } });
  assert.equal(result, "not json");
});

// ── duplicate-issue check: same key, same lookup ─────────────────────────────

test("gh issue create gets the backlog duplicate-check reminder, never a block", () => {
  const repo = tmprepo();
  const { stdout } = invoke(repo, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'gh issue create --repo octo/demo --title "x" --body "y"' },
  });
  assert.match(stdout, /\[BACKLOG DUPLICATE CHECK\]/);
  assert.match(stdout, /gh issue list --repo octo\/demo --state all --search/);
  assert.match(stdout, /its identifier IS the subject id/);
});

test("an unrelated gh command is not mistaken for filing", () => {
  const repo = tmprepo();
  const { stdout } = invoke(repo, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh issue view 1061 --repo octo/demo" },
  });
  assert.doesNotMatch(stdout, /BACKLOG DUPLICATE CHECK/);
});

test("backlogCreateCommand reads --repo when present and defers otherwise", () => {
  assert.deepEqual(subjectBinding.backlogCreateCommand({ tool_name: "Bash", tool_input: { command: "gh issue create --repo a/b" } }), { repo: "a/b" });
  assert.deepEqual(subjectBinding.backlogCreateCommand({ tool_name: "Bash", tool_input: { command: "gh issue create" } }), { repo: null });
  assert.equal(subjectBinding.backlogCreateCommand({ tool_name: "Bash", tool_input: { command: "gh pr create" } }), null);
  assert.equal(subjectBinding.backlogCreateCommand({ tool_name: "Write", tool_input: {} }), null);
});

// ── install provenance ───────────────────────────────────────────────────────

test("installProvenance reports 'not installed' for a source checkout", () => {
  const provenance = subjectBinding.installProvenance(HOOK);
  assert.equal(provenance.installed, false);
  assert.equal(provenance.locallyModified, false);
});

test("installProvenance flags a hand-synced file inside an installed package", () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fa-prov-"));
  const pkg = path.join(base, "node_modules", "@kontourai", "flow-agents");
  fs.mkdirSync(path.join(pkg, "scripts", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  const hookFile = path.join(pkg, "scripts", "hooks", "subject-binding.js");
  fs.writeFileSync(hookFile, "// pristine");
  const installedAt = Date.now() - 3_600_000;
  fs.utimesSync(path.join(pkg, "package.json"), installedAt / 1000, installedAt / 1000);
  fs.utimesSync(hookFile, installedAt / 1000, installedAt / 1000);
  assert.deepEqual(subjectBinding.installProvenance(hookFile), { installed: true, locallyModified: false });

  // Now simulate the fast feedback loop: sync a newer file over the installed one.
  fs.writeFileSync(hookFile, "// synced by hand");
  assert.deepEqual(subjectBinding.installProvenance(hookFile), { installed: true, locallyModified: true });
});
