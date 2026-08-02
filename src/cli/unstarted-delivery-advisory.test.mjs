// Unstarted-delivery Stop advisory (scripts/hooks/lib/unstarted-delivery.js).
//
// Drives the REAL run() entry point with a real Stop payload against a real temp git repo, so
// the assertions cover the wiring (gating, message composition, exit code) and not just the
// predicate. The three contract cases the seam exists for are named explicitly:
//   FIRES  — tracked source changed, kit-configured, no session, no exemption
//   SILENT — read-only turn (nothing changed)
//   SILENT — an active workflow session exists
// plus the never-blocking guarantee and the non-source / untracked / exemption exclusions.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hook = require_(path.join(repoRoot, "scripts", "hooks", "stop-goal-fit.js"));
const { writePerActorCurrent } = require_(path.join(repoRoot, "scripts", "hooks", "lib", "current-pointer.js"));

const KIT_MANIFEST = {
  schema_version: "1.0",
  id: "builder",
  name: "Builder Kit",
  description: "Delivery routing declaration for tests.",
  workflow_triggers: [
    {
      id: "builder-build-work",
      when: "implementation-work-detected",
      target_flow_id: "builder.build",
      default_skill: "deliver",
      required_sequence: ["ensure-session", "plan-work", "execute-plan", "review-work", "verify-work"],
      post_verify_targets: ["release-readiness", "learning-review"],
    },
  ],
};

function mkRepo({ kitConfigured = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-unstarted-")));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  if (kitConfigured) {
    fs.mkdirSync(path.join(root, "kits", "builder"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "kits", "catalog.json"),
      JSON.stringify({ schema_version: "1.0", kits: [{ id: "builder", name: "Builder Kit", path: "kits/builder" }] }, null, 2),
    );
    fs.writeFileSync(path.join(root, "kits", "builder", "kit.json"), JSON.stringify(KIT_MANIFEST, null, 2));
  }
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return root;
}

/** Modify a TRACKED file (the only kind that arms the advisory). */
function touchTracked(root, rel, body) {
  fs.writeFileSync(path.join(root, rel), body);
}

/**
 * An active workflow session OWNED by `actor` — the session dir plus the per-actor current
 * pointer written through the shipped writer (#291/#440), which is what the Stop gate actually
 * scopes on. A legacy shared current.json is deliberately NOT what "a session exists" means for
 * a resolved actor: #440 makes another session's pointer informational only.
 */
function mkSession(root, actor, slug = "live-task") {
  const flowAgentsDir = path.join(root, ".kontourai", "flow-agents");
  const dir = path.join(flowAgentsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ task_slug: slug, status: "in_progress", phase: "execute" }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, `${slug}--deliver.md`),
    "# deliver\n\n## Definition Of Done\n- [ ] ship it\n",
  );
  writePerActorCurrent(flowAgentsDir, actor, { active_slug: slug, artifact_dir: slug });
  return dir;
}

async function stop(root, env = {}) {
  const saved = {};
  const applied = { FLOW_AGENTS_GOAL_FIT_MODE: "warn", FLOW_AGENTS_ACTOR: "test-actor", ...env };
  for (const [k, v] of Object.entries(applied)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await hook.run(JSON.stringify({ hook_event_name: "Stop", cwd: root }));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function stderrOf(result) {
  return typeof result === "string" ? "" : String(result.stderr || "");
}

// ── Case 1: FIRES on a tracked-source change with no session ────────────────────────────────
test("fires on a tracked-source change in a kit-configured repo with no session", async () => {
  const root = mkRepo();
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  const result = await stop(root);
  const stderr = stderrOf(result);
  assert.match(stderr, / delivery not started — /, "the advisory must be emitted");
  assert.match(stderr, /src\/index\.ts/, "it must name the changed file");
  assert.match(stderr, /ensure-session/, "way out #1: start a session");
  assert.match(stderr, /delivery\/DECLARED/, "way out #2: record a scoped exemption");
});

test("never blocks — exit code stays 0 even in block mode", async () => {
  const root = mkRepo();
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  const result = await stop(root, { FLOW_AGENTS_GOAL_FIT_MODE: "block" });
  assert.match(stderrOf(result), / delivery not started — /);
  assert.equal(result.exitCode, 0, "an unstarted-delivery advisory must never block a Stop");
});

// ── Case 2: SILENT on a read-only turn ──────────────────────────────────────────────────────
test("stays silent on a read-only turn (nothing changed)", async () => {
  const root = mkRepo();
  const result = await stop(root);
  assert.equal(stderrOf(result), "", "a read-only turn must produce no advisory");
});

// ── Case 3: SILENT when a workflow session is active ────────────────────────────────────────
test("stays silent when an active workflow session exists", async () => {
  const root = mkRepo();
  mkSession(root, "test-actor");
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  const result = await stop(root);
  assert.doesNotMatch(stderrOf(result), / delivery not started — /,
    "a session exists — the ordinary adherence gate owns this stop, not the unstarted-delivery seam");
});

test("still fires when the only session on disk belongs to a DIFFERENT actor", async () => {
  // #440: another actor's session is informational only and never scopes this actor's stop, so
  // "a session directory exists somewhere in the repo" is not evidence that THIS session started
  // one. Documenting the behavior rather than special-casing it: the advisory tracks the same
  // ownership rule the rest of the gate uses.
  const root = mkRepo();
  mkSession(root, "someone-else");
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  assert.match(stderrOf(await stop(root)), / delivery not started — /,
    "another actor's session must not silence this actor's unstarted-delivery advisory");
});

// ── Narrowness: the conditions that must keep it quiet ──────────────────────────────────────
test("stays silent in a repo with no kit configuration", async () => {
  const root = mkRepo({ kitConfigured: false });
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  assert.equal(stderrOf(await stop(root)), "", "an unconfigured repo gets no opinion");
});

test("stays silent for a docs-only change", async () => {
  const root = mkRepo();
  touchTracked(root, "README.md", "# repo\n\nmore docs\n");
  assert.equal(stderrOf(await stop(root)), "", "a docs tweak is not delivery");
});

test("stays silent for an untracked new file", async () => {
  const root = mkRepo();
  fs.writeFileSync(path.join(root, "src", "scratch.ts"), "// scratch\n");
  assert.equal(stderrOf(await stop(root)), "", "untracked scratch files are not tracked source");
});

test("stays silent under a well-formed, in-scope delivery/DECLARED exemption", async () => {
  const root = mkRepo();
  execFileSync("git", ["-C", root, "checkout", "-q", "-b", "chore/deps-bump"]);
  fs.mkdirSync(path.join(root, "delivery"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "delivery", "DECLARED"),
    JSON.stringify([{
      scope: "author:test-actor branch-prefix:chore/deps",
      reason: "mechanical dependency bump; no agent delivery involved",
      approved_by: "owner (test)",
      declared_at: "2026-08-02T00:00:00Z",
    }], null, 2),
  );
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "declare"]);
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  assert.equal(stderrOf(await stop(root)), "", "an in-scope exemption silences the advisory");
});

test("an OUT-OF-SCOPE exemption does not silence the advisory", async () => {
  const root = mkRepo();
  fs.mkdirSync(path.join(root, "delivery"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "delivery", "DECLARED"),
    JSON.stringify([{
      scope: "author:dependabot[bot]",
      reason: "dependabot PRs",
      approved_by: "owner (test)",
      declared_at: "2026-08-02T00:00:00Z",
    }], null, 2),
  );
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "declare"]);
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  assert.match(stderrOf(await stop(root)), / delivery not started — /,
    "an exemption scoped to another actor must not cover this session");
});

test("a malformed DECLARED entry does not silence the advisory", async () => {
  const root = mkRepo();
  fs.mkdirSync(path.join(root, "delivery"), { recursive: true });
  // Missing approved_by/declared_at — well-formedness is required (ADR 0022 §2).
  fs.writeFileSync(
    path.join(root, "delivery", "DECLARED"),
    JSON.stringify([{ scope: "author:test-actor", reason: "trust me" }], null, 2),
  );
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "declare"]);
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  assert.match(stderrOf(await stop(root)), / delivery not started — /,
    "a marker missing required fields is not an exemption");
});

test("the advisory text avoids every blocking-classification token", () => {
  const root = mkRepo();
  touchTracked(root, "src/index.ts", "export const a = 2;\n");
  const warning = hook.unstartedDeliveryWarning({ root, cwd: root, env: { FLOW_AGENTS_ACTOR: "test-actor" } });
  assert.ok(warning, "predicate must produce a warning for this fixture");
  for (const token of ["status:", "workflow state", "next action", "NOT_VERIFIED", "Definition Of Done", "Goal Fit"]) {
    assert.ok(!warning.includes(token), `advisory text must not contain the blocking token "${token}"`);
  }
});
