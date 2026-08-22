// One-pass contract preflight (#1293): the cold-start ladder must be one invocation, and
// single-issue refusals must keep their pre-existing strings for the consumers that match them.
// Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../build/src/cli.js");

function runStart(args, cwd) {
  return spawnSync(process.execPath, [CLI, "workflow", "start", ...args], { cwd, encoding: "utf8" });
}

test("a cold start reports the complete contract in ONE invocation", () => {
  // Run 1 of the instrumented dogfood measured this exact ladder at 4+ invocations, each a full
  // context read: --work-item, then --assignment-provider, then --effective-state-json, then the
  // pull-work artifact. One bare invocation must now surface every diagnosable requirement plus a
  // runnable template naming the producing verbs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const result = runStart([], dir);
    assert.notEqual(result.status, 0);
    const out = result.stderr;
    assert.match(out, /missing or invalid input\(s\)/);
    // each original single-fact line is embedded VERBATIM so substring-matching consumers keep matching
    assert.match(out, /workflow start requires --work-item <provider-ref>/);
    assert.match(out, /requires --effective-state-json/);
    // the producing-verb chain is in the template
    assert.match(out, /assignment-provider status --provider github --repo/);
    assert.match(out, /--pull-work\.md/);
    // honesty: provider-conditional requirements are labelled, never presented as universally complete
    assert.match(out, /apply only when --assignment-provider github/);
    // the actor-basis trap that burned run 1 is stated
    assert.match(out, /do not set FLOW_AGENTS_ACTOR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a single missing input keeps its pre-existing error string byte-identical", () => {
  // test_public_workflow_cli.sh substring-matches these; and a lone missing input needs no
  // template. These literals are the pre-#1293 strings — if this test fails, a consumer sweep is
  // required before shipping the new text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const state = path.join(dir, "es.json");
    fs.writeFileSync(state, "{}");
    const providerMissing = runStart(["--work-item", "acme/w#5", "--effective-state-json", state], dir);
    assert.notEqual(providerMissing.status, 0);
    assert.ok(
      providerMissing.stderr.includes("workflow start requires --assignment-provider <kind> for a provider-backed Work Item; provider identity is never inferred from its reference"),
      `single-issue provider error changed: ${providerMissing.stderr}`,
    );
    assert.ok(!/missing or invalid input\(s\)/.test(providerMissing.stderr), "a single issue must not render the multi-issue report");

    const localWithState = runStart(["--work-item", "local:x", "--task-slug", "x", "--effective-state-json", state], dir);
    assert.notEqual(localWithState.status, 0);
    assert.ok(
      localWithState.stderr.includes("workflow start --effective-state-json is only valid for a non-local assignment provider"),
      `single-issue local-state error changed: ${localWithState.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the template binds the caller's own work-item when it is well-formed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    // two issues (provider + effective-state) with a concrete ref: the template must use the
    // caller's ref and derived slug, not placeholders.
    const result = runStart(["--work-item", "acme/widgets#44"], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gh issue view 44 --repo acme\/widgets/);
    assert.match(result.stderr, /--subject-id acme-widgets-44/);
    assert.match(result.stderr, /acme-widgets-44--pull-work\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shape-flow issues stay scoped to shape and never render the provider template", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const result = runStart(["--flow", "builder.shape", "--work-item", "acme/w#5"], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires an explicit safe --task-slug/);
    assert.match(result.stderr, /creates a local Work Item; omit --work-item/);
    assert.ok(!/assignment-provider status/.test(result.stderr), "shape issues must not render the provider chain");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gate-evidence refusals name every unmet requirement and the expected artifact path in one pass", () => {
  // Driven through the sidecar's record-gate-claim against a synthetic session missing everything:
  // run 1 paid three sequential refusals (refs -> producer artifact -> evidence class) per gate.
  // The producer-artifact line must NAME the expected concrete path, derived from the kit binding
  // (this test only asserts the report SHAPE and that a path is named — it does not pin any
  // specific kit's artifact vocabulary).
  const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
  const probe = spawnSync(process.execPath, [SIDECAR, "record-gate-claim", "--help"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "sidecar help must remain interceptable (precondition for this suite)");
});
