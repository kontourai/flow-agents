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
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
}

function snapshot(dir) {
  const out = {};
  const walk = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const next = path.join(current, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next, key);
      else if (!entry.isSymbolicLink()) out[key] = fs.readFileSync(next, "utf8");
    }
  };
  walk(dir);
  return out;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function writeFixtureRepo(repo, claims) {
  fs.mkdirSync(path.join(repo, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs/decisions"), { recursive: true });
  fs.writeFileSync(path.join(repo, "knowledge/claims.json"), `${JSON.stringify({ claims }, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "docs/decisions/context-contract.md"), "# Context contract\n");
  fs.writeFileSync(path.join(repo, "docs/decisions/cli.md"), "# CLI\n");
}

function seededRepo(claims = fixtureClaims.claims) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "context-check-repo-"));
  writeFixtureRepo(repo, claims);
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

function remove(...dirs) { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }

describe("Context Check: revision-bound recall and reconciliation (#1131)", () => {
  test("recalls current authority from the exact raw revision and never presents a superseded claim as current", () => {
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
    remove(repo);
  });

  test("disables Git replacement semantics and inherited Git directory overrides", () => {
    const { repo, revision } = seededRepo();
    const replacementClaims = clone(fixtureClaims.claims);
    replacementClaims[0].claim = "replacement object must not be read";
    writeFixtureRepo(repo, replacementClaims);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "replacement target"]);
    const replacement = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["replace", revision, replacement]);

    const other = seededRepo();
    const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    process.env.GIT_DIR = path.join(other.repo, ".git");
    process.env.GIT_WORK_TREE = other.repo;
    process.env.GIT_CONFIG_GLOBAL = path.join(other.repo, "global-config");
    try {
      const result = runContextCheck({ repoRoot: repo, input: input(revision), write: false });
      assert.equal(result.recalls.find((item) => item.claim_id === "current-context-contract").claim, fixtureClaims.claims[0].claim);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      remove(repo, other.repo);
    }
  });

  test("marks path intersections neutral, collects every surface, and only emits contradicted with explicit evidence", () => {
    const neutral = clone(fixtureClaims.claims);
    neutral[0].affected_surfaces.push("src/other-context.js");
    const { repo, revision } = seededRepo(neutral);
    const result = runContextCheck({ repoRoot: repo, input: input(revision, { changed_surfaces: ["src/context-adapter.js", "src/other-context.js"] }), write: false });
    const current = result.reconciliation.find((item) => item.claim_id === "current-context-contract");
    assert.equal(current.status, "affected", "surface intersection alone must not imply contradiction/broken");
    assert.deepEqual(current.affected_surfaces, ["src/context-adapter.js", "src/other-context.js"]);
    assert.match(result.proposals.find((item) => item.claim_id === current.claim_id).rationale, /requires reconciliation/);
    remove(repo);

    const contradicted = clone(fixtureClaims.claims);
    contradicted[0].reconciliation_evidence = {
      status: "contradicted",
      authority: { path: "docs/decisions/context-contract.md", citation: "Fixture contradiction evidence" }
    };
    const fixture = seededRepo(contradicted);
    const explicit = runContextCheck({ repoRoot: fixture.repo, input: input(fixture.revision), write: false });
    assert.equal(explicit.reconciliation.find((item) => item.claim_id === "current-context-contract").status, "contradicted");
    remove(fixture.repo);
  });

  test("routes affected unverifiable claims to their owner without deriving trust", () => {
    const claims = clone(fixtureClaims.claims);
    claims.push({
      id: "unverifiable-context",
      claim: "The unresolved context assertion needs owner review.",
      status: "unverifiable",
      authority: { path: "docs/decisions/context-contract.md", citation: "Unverifiable fixture authority" },
      owning_source: { owner: "documentation", path: "docs/decisions/context-contract.md" },
      affected_surfaces: ["src/context-adapter.js"]
    });
    const { repo, revision } = seededRepo(claims);
    const result = runContextCheck({ repoRoot: repo, input: input(revision), write: false });
    const reconciliation = result.reconciliation.find((item) => item.claim_id === "unverifiable-context");
    assert.equal(reconciliation.status, "unverifiable");
    assert.equal(result.proposals.find((item) => item.claim_id === "unverifiable-context").route.owner, "documentation");
    assert.equal(result.verdict, "not_verified");
    remove(repo);
  });

  test("emits one explicit no-answer per missing requested claim and preserves partial recalls", () => {
    const { repo, revision } = seededRepo();
    const result = runContextCheck({ repoRoot: repo, input: input(revision, { claim_ids: ["current-context-contract", "absent-one", "absent-two"] }), write: false });
    assert.deepEqual(result.recalls.map((item) => item.claim_id), ["current-context-contract", "absent-one", "absent-two"]);
    assert.deepEqual(result.recalls.filter((item) => item.reason === "no_answer").map((item) => item.claim_id), ["absent-one", "absent-two"]);
    assert.equal(result.reconciliation.length, 1, "missing claims have no source claim to reconcile");
    assert.equal(result.verdict, "not_verified");
    remove(repo);
  });

  test("writes only new private no-follow files beneath an explicit proposal directory", () => {
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
    assert.equal(validateContextCheckResult(result).length, 0);
    assert.deepEqual(snapshot(repo), before, "repo root must remain byte-identical");
    assert.deepEqual(result.written, ["context-check-result.json", "proposals/context-update-current-context-contract.json", "proposals/context-update-superseded-context-contract.json"]);
    assert.ok(fs.existsSync(path.join(proposalDir, "proposals/context-update-current-context-contract.json")));
    remove(repo, proposalDir);
  });

  test("rejects a symlink proposal component before any external or run result write", () => {
    const { repo, revision } = seededRepo();
    const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-check-proposals-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "context-check-external-"));
    fs.symlinkSync(external, path.join(proposalDir, "proposals"));
    const externalBefore = snapshot(external);
    assert.throws(
      () => runContextCheck({ repoRoot: repo, input: input(revision), proposalDir, write: true }),
      (cause) => cause.code === "UNSAFE_PROPOSAL_DIR"
    );
    assert.deepEqual(snapshot(external), externalBefore, "a symlink target outside the run directory must remain untouched");
    assert.ok(!fs.existsSync(path.join(proposalDir, "context-check-result.json")), "preflight must reject before creating a result file");
    remove(repo, proposalDir, external);
  });

  test("uses the shared schemas to reject extras, traversal, and blank identities", () => {
    const { revision, repo } = seededRepo();
    assert.match(validateContextCheckInput({ ...input(revision), extra: true }).join(" "), /unexpected property/);
    assert.match(validateContextCheckInput({ ...input(revision), workspace: " " }).join(" "), /pattern/);
    assert.match(validateContextCheckInput({ ...input(revision), changed_surfaces: ["../escape"] }).join(" "), /pattern/);
    const result = runContextCheck({ repoRoot: repo, input: input(revision), write: false });
    assert.match(validateContextCheckResult({ ...result, extra: true }).join(" "), /unexpected property/);
    remove(repo);
  });

  test("requires exact revision-bound inputs and treats diff paths as the bounded surface", () => {
    const { repo, revision } = seededRepo();
    assert.match(validateContextCheckInput({ ...input(revision), revision: "main" }).join(" "), /pattern/);
    const diffInput = input(revision, { diff: { paths: ["src/cli.js"] } });
    delete diffInput.changed_surfaces;
    const result = runContextCheck({ repoRoot: repo, input: diffInput, write: false });
    assert.equal(result.reconciliation.find((item) => item.claim_id === "clean-control").status, "affected");
    remove(repo);
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
