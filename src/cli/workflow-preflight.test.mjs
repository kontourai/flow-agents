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
    // honesty: provider-conditional requirements are labelled, never presented as universally
    // complete, and undiscoverable-at-preflight requirements are disclosed as not listed
    assert.match(out, /apply only to that provider/);
    assert.match(out, /not listed here/);
    // review round 1 (HIGH): the chain must include the CLAIM step for a cold unclaimed issue —
    // a read-only status can never produce a claimed record on its own
    assert.match(out, /render-claim/);
    // review round 1 (HIGH): identity guidance is same-identity-as-claim, never a categorical ban
    assert.match(out, /SAME canonical identity the claim was created with/);
    // the canonical key is derivable from the template itself, not left as an unexplained token
    assert.match(out, /liveness whoami/);
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

test("an invalid work-item is a NUMBERED issue and non-github refs never bind the template", () => {
  // Round-2 review: owner/repo#0 (rejected by the real parser) fell back to placeholders while
  // the numbered list omitted the actually-broken input; and jira:ABC (valid provider-neutral,
  // not github) rendered nonsense runnable text `gh issue view jira:ABC --repo jira:AB`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const invalid = runStart(["--work-item", "acme/widgets#0"], dir);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /is not a valid provider reference/);
    // the diagnostic must be the canonical parser's, not a local paraphrase (corpus conformance)
    assert.match(invalid.stderr, /positive-numeric-id|safe integer range/);
    assert.match(invalid.stderr, /gh issue view <n> --repo <owner>\/<repo>/);

    const jira = runStart(["--work-item", "jira:ABC-1"], dir);
    assert.notEqual(jira.status, 0);
    assert.ok(!/gh issue view jira/.test(jira.stderr), "a non-github ref must never be bound into gh commands");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the template's derivations are real: whoami field and claim-verb contract", () => {
  // Round-2 review: the template piped `jq -r .actor_key` but whoami emits {actor, source} — a
  // runnable-looking command yielding null. The template's own derivations must name fields that
  // exist and flags the named verb actually requires.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const result = runStart([], dir);
    assert.match(result.stderr, /jq -r \.actor\b/);
    assert.ok(!/actor_key\)/.test(result.stderr), "whoami derivation must not reference a nonexistent field");
    assert.match(result.stderr, /render-claim --provider github/);
    assert.match(result.stderr, /--subject-id/);
    assert.match(result.stderr, /--input-json/);
    // round-3 review: the field list must include work_item_ref — render-claim rejects every
    // payload without it (run 1 paid a refusal to learn exactly this) — and ttl_seconds is
    // optional, so it must be bracketed rather than presented as required.
    assert.match(result.stderr, /work_item_ref/);
    assert.match(result.stderr, /\[, ttl_seconds\]/);
    assert.match(result.stderr, /--actor-json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shape flow still enforces the provider-combination rules (fail-open guard)", () => {
  // Review round 1's most serious finding: an early return for shape skipped the provider checks
  // that always applied to it, silently ACCEPTING a previously-refused invocation — and the
  // downstream ownership guard logs 'not evaluated' and proceeds, so the widening was fail-open.
  // The fault injection that restores the early return must fail HERE, not in production.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    const githubNoState = runStart(["--flow", "builder.shape", "--task-slug", "shape-x", "--assignment-provider", "github"], dir);
    assert.notEqual(githubNoState.status, 0, "shape + github provider without effective state must be refused");
    assert.match(githubNoState.stderr, /requires --effective-state-json/);

    const state = path.join(dir, "es.json");
    fs.writeFileSync(state, "{}");
    const localWithState = runStart(["--flow", "builder.shape", "--task-slug", "shape-x", "--effective-state-json", state], dir);
    assert.notEqual(localWithState.status, 0, "shape + effective state under the local default must be refused");
    assert.match(localWithState.stderr, /only valid for a non-local assignment provider/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gate-evidence refusals name every unmet requirement and the expected artifact path in one pass", () => {
  // A real synthetic session (git repo + ensure-session with a bound flow), then a passing gate
  // claim with NO evidence: run 1 paid three sequential refusals (refs -> producer artifact ->
  // evidence class) per gate; the report must surface the unmet requirements TOGETHER and NAME a
  // concrete expected artifact path expanded from the kit binding. The first version of this test
  // asserted only `record-gate-claim --help` exiting 0 — a false positive that proved nothing of
  // its title, caught by independent review; this is the fixture-backed replacement, and it is
  // also the unit-level catcher for the artifact-naming fault injection that previously only a
  // live probe could see.
  const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-gate-"));
  try {
    const run = (args, env = {}) => spawnSync(process.execPath, [SIDECAR, ...args], {
      cwd: project, encoding: "utf8", env: { ...process.env, ...env },
    });
    spawnSync("git", ["init", "-q", "."], { cwd: project });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
    const artifactRoot = path.join(project, ".kontourai", "flow-agents");
    const ensure = run([
      "ensure-session", "--artifact-root", artifactRoot,
      "--work-item", "acme/widgets#7", "--flow-id", "builder.build",
      "--source-request", "preflight fixture", "--summary", "preflight fixture",
    ], { FLOW_AGENTS_ACTOR: "preflight-fixture-actor" });
    assert.equal(ensure.status, 0, `fixture ensure-session failed: ${ensure.stderr}`);
    const claim = run([
      "record-gate-claim", path.join(artifactRoot, "acme-widgets-7"),
      "--expectation", "selected-work", "--status", "pass",
      "--summary", "preflight fixture claim with no evidence",
    ], { FLOW_AGENTS_ACTOR: "preflight-fixture-actor" });
    assert.notEqual(claim.status, 0, "a passing gate claim with no evidence must be refused");
    const out = claim.stderr + claim.stdout;
    assert.match(out, /evidence requirement\(s\) unmet|requires at least one reviewable/);
    // the expected artifact is NAMED with the slug expanded — the report tells the caller what
    // file to write instead of costing another refusal to find out
    assert.match(out, /acme-widgets-7/);
    assert.match(out, /expected artifact matching|declared durable artifact/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
