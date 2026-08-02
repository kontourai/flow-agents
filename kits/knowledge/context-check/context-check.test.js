/** Deterministic contract tests for the standalone, revision-bound Context Check. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runContextCheck, validateContextCheckInput, validateContextCheckResult } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "..");
const fixtureClaims = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/claims.json"), "utf8"));

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function snapshot(dir) {
  const out = {};
  const walk = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const next = path.join(current, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, key);
      else out[key] = fs.readFileSync(next, "utf8");
    }
  };
  walk(dir);
  return out;
}

function seededRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "context-check-repo-"));
  fs.mkdirSync(path.join(repo, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs/decisions"), { recursive: true });
  fs.writeFileSync(path.join(repo, "knowledge/claims.json"), `${JSON.stringify(fixtureClaims, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "docs/decisions/context-contract.md"), "# Context contract\n");
  fs.writeFileSync(path.join(repo, "docs/decisions/cli.md"), "# CLI\n");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "seed claims"]);
  const revision = git(repo, ["rev-parse", "HEAD"]);
  // This intentionally invalid dirty file proves reads cannot silently fall back to the working tree.
  fs.writeFileSync(path.join(repo, "knowledge/claims.json"), "{\"claims\": []}\n");
  return { repo, revision };
}

function input(revision, overrides = {}) {
  return {
    schema_version: "1.0",
    workspace: "fixture-workspace",
    repository: "fixture-repository",
    revision,
    target_audience: "engineer",
    changed_surfaces: ["src/context-adapter.js"],
    knowledge_roots: [{ id: "fixture-git", provider: "git-repo", manifest_path: "knowledge/claims.json" }],
    ...overrides
  };
}

describe("Context Check: revision-bound recall and reconciliation (#1131)", () => {
  test("recalls current authority from the exact revision and never presents a superseded claim as current", () => {
    const { repo, revision } = seededRepo();
    const result = runContextCheck({ repoRoot: repo, input: input(revision), write: false });
    assert.equal(validateContextCheckResult(result).length, 0);
    const current = result.recalls.find((item) => item.claim_id === "current-context-contract");
    const superseded = result.recalls.find((item) => item.claim_id === "superseded-context-contract");
    assert.equal(current.status, "current");
    assert.equal(current.authority.revision, revision);
    assert.equal(current.retrieval_provenance.read_mode, "git-show");
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.superseded_by, "current-context-contract");
    assert.notEqual(superseded.status, "current");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("reconciles every affected claim, preserves a clean control, and routes only owning-source proposals", () => {
    const { repo, revision } = seededRepo();
    const result = runContextCheck({ repoRoot: repo, input: input(revision), write: false });
    assert.equal(result.reconciliation.find((item) => item.claim_id === "current-context-contract").status, "contradicted");
    assert.equal(result.reconciliation.find((item) => item.claim_id === "superseded-context-contract").status, "stale");
    assert.deepEqual(result.reconciliation.find((item) => item.claim_id === "clean-control"), { claim_id: "clean-control", status: "clean", affected_surfaces: [] });
    assert.equal(result.proposals.length, 2);
    assert.ok(result.proposals.every((proposal) => proposal.route.path === "docs/decisions/context-contract.md"));
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("keeps no-answer explicit and does not turn absence into a pass", () => {
    const { repo, revision } = seededRepo();
    const result = runContextCheck({ repoRoot: repo, input: input(revision, { claim_ids: ["absent-claim"] }), write: false });
    assert.deepEqual(result.recalls, [{ status: "unverifiable", reason: "no_answer", retrieval_provenance: { revision, read_mode: "git-show" } }]);
    assert.equal(result.verdict, "not_verified");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("writes only to an explicit proposal directory", () => {
    const { repo, revision } = seededRepo();
    const before = snapshot(repo);
    assert.throws(
      () => runContextCheck({ repoRoot: repo, input: input(revision), write: true }),
      (cause) => cause.code === "PROPOSAL_DIR_REQUIRED",
      "writes must not choose an implicit output location"
    );
    assert.deepEqual(snapshot(repo), before, "a refused implicit write must not modify the repo");
    const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-check-proposals-"));
    const result = runContextCheck({ repoRoot: repo, input: input(revision), proposalDir, write: true });
    assert.deepEqual(snapshot(repo), before, "repo root must remain byte-identical");
    assert.ok(result.written.includes("context-check-result.json"));
    assert.ok(fs.existsSync(path.join(proposalDir, "proposals/context-update-current-context-contract.json")));
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(proposalDir, { recursive: true, force: true });
  });

  test("requires exact revision-bound inputs and treats diff paths as the bounded surface", () => {
    const { repo, revision } = seededRepo();
    assert.match(validateContextCheckInput({ ...input(revision), revision: "main" }).join(" "), /exact 40-character/);
    const result = runContextCheck({ repoRoot: repo, input: input(revision, { changed_surfaces: undefined, diff: { paths: ["src/cli.js"] } }), write: false });
    assert.equal(result.reconciliation.find((item) => item.claim_id === "clean-control").status, "contradicted");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("exports every gate claim for a future parent uses_flow composition without integrating Builder", () => {
    const flow = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "flows/context-check.flow.json"), "utf8"));
    assert.equal(flow.id, "knowledge.context-check");
    for (const gate of Object.values(flow.gates)) {
      const claimType = gate.expects[0].bundle_claim.claimType;
      assert.ok(flow.exports.includes(claimType), `${claimType} must be exported`);
    }
  });
});
