/**
 * Living Context (Context Check 1.1) contract tests for kontourai/flow-agents#1131.
 *
 * Every test builds a real Git repository, commits the claim manifest and authority documents, then
 * dirties the working tree so a read that ignored the pinned revision would fail loudly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCandidateVerification } from "@kontourai/survey";

import { runLivingContext, assertSurfaceVisibility, deriveLivingContext, validateLivingContextInput, validateLivingContextResult, estimateTokens } from "./living-context.js";
import { observeRepositoryChange, DEFAULT_MAX_CHANGED_PATHS } from "./observe-change.js";
import { reapplyVerifiedFreshness } from "@kontourai/surface";
import { answerLivingContext as answerWith, createLineSupportVerifier, MAX_EVIDENCE_BYTES } from "./living-context-answer.js";
import { runContextCheck } from "./index.js";
import { validate } from "../providers/lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/living-claims.json"), "utf8"));
const NOW = "2026-06-01T00:00:00Z";
const lineVerifier = createLineSupportVerifier();
const answerLivingContext = (args) => answerWith({ verifier: lineVerifier, ...args });
const NOW_MS = "2026-06-01T00:00:00.000Z";

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const remove = (...dirs) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); };

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

// Authority documents contain each claim statement verbatim so the deterministic verifier can find it.
function authorityDocs(manifest) {
  const docs = {};
  for (const claim of manifest.claims) {
    if (claim.id === "unrecorded" || claim.id === "bounded-validity" || claim.id === "no-visibility") continue;
    docs[claim.authority.path] = `${docs[claim.authority.path] ?? "# Authority\n"}\n${claim.claim}\n`;
  }
  return docs;
}

function seededRepo(manifest = fixture, { docs = authorityDocs(manifest), extraFiles = {} } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "living-context-repo-")));
  fs.mkdirSync(path.join(repo, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(repo, "knowledge/claims.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relative, text] of Object.entries({ ...docs, ...extraFiles })) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), text);
  }
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  const revision = git(repo, ["rev-parse", "HEAD"]);
  // Invalid on purpose: proves reads come from the pinned commit and never from the working tree.
  fs.writeFileSync(path.join(repo, "knowledge/claims.json"), "{\"claims\": []}\n");
  return { repo, revision };
}

function input(revision, overrides = {}) {
  return {
    schema_version: "1.1",
    workspace: "fixture-workspace",
    repository: "fixture-repository",
    revision,
    target_audience: "engineer",
    reader: "engineer",
    as_of: { now: NOW },
    budget: { max_tokens: 100000 },
    changed_surfaces: ["src/context-adapter.js"],
    knowledge_roots: [{ id: "fixture-git", provider: "git-repo", manifest_path: "knowledge/claims.json" }],
    ...overrides,
  };
}

function withClaim(id, mutate) {
  const manifest = clone(fixture);
  mutate(manifest.claims.find((claim) => claim.id === id), manifest);
  return manifest;
}

const recallOf = (result, claimId) => result.recalls.find((entry) => entry.claim_id === claimId);

describe("Living Context: identity is required and fails closed", () => {
  test("refuses a missing, blank, or unknown reader before reading or writing anything", () => {
    const { repo, revision } = seededRepo();
    const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), "living-context-proposals-"));
    const missing = input(revision);
    delete missing.reader;
    assert.throws(() => runLivingContext({ repoRoot: repo, input: missing, proposalDir }), (cause) => cause.code === "READER_IDENTITY_REQUIRED");
    assert.throws(() => runLivingContext({ repoRoot: repo, input: input(revision, { reader: " " }), proposalDir }), (cause) => cause.code === "READER_IDENTITY_REQUIRED");
    assert.throws(() => runLivingContext({ repoRoot: repo, input: input(revision, { reader: "stranger" }), proposalDir }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    assert.deepEqual(fs.readdirSync(proposalDir), [], "a refused identity must not create any output");
    remove(repo, proposalDir);
  });

  test("an unknown identity is refused even when it is named in a claim's visibility list", () => {
    const manifest = withClaim("clean-control", (claim) => { claim.visibility.audiences.push("stranger"); });
    const { repo, revision } = seededRepo(manifest);
    assert.throws(() => runLivingContext({ repoRoot: repo, input: input(revision, { reader: "stranger" }), write: false }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    remove(repo);
  });

  test("a manifest with no readers registry (a 1.0 manifest) refuses every reader", () => {
    const legacy = clone(fixture);
    delete legacy.readers;
    const { repo, revision } = seededRepo(legacy);
    assert.throws(() => runLivingContext({ repoRoot: repo, input: input(revision), write: false }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    remove(repo);
  });

  test("a reader must be known to every selected root", () => {
    const { repo, revision } = seededRepo(fixture, { extraFiles: { "knowledge/other.json": JSON.stringify({ readers: ["auditor"], claims: [] }) } });
    const roots = [
      { id: "fixture-git", provider: "git-repo", manifest_path: "knowledge/claims.json" },
      { id: "other-git", provider: "git-repo", manifest_path: "knowledge/other.json" },
    ];
    assert.throws(() => runLivingContext({ repoRoot: repo, input: input(revision, { knowledge_roots: roots }), write: false }), (cause) => cause.code === "UNKNOWN_READER_IDENTITY");
    assert.equal(runLivingContext({ repoRoot: repo, input: input(revision, { reader: "auditor", knowledge_roots: roots }), write: false }).input.reader, "auditor");
    remove(repo);
  });

  test("a claim with no visibility is visible to no one, and hidden, absent and not-yet-known claims are indistinguishable", () => {
    const { repo, revision } = seededRepo();
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["auditor-only", "no-visibility", "nothing-here", "new-limit"], as_of: { now: NOW, known_at: "2026-02-15T00:00:00Z" } }), write: false });
    const strip = (entry) => ({ ...entry, claim_id: "x" });
    assert.deepEqual(result.recalls.map((entry) => entry.reason), ["no_answer", "no_answer", "no_answer", "no_answer"]);
    assert.deepEqual(result.recalls.map(strip), result.recalls.map(() => strip(result.recalls[0])), "hidden / unlisted / absent / not-yet-known must be byte-identical");
    assert.equal(result.reconciliation.length, 0, "a reader gets no reconciliation or proposal for a claim it cannot see");
    assert.equal(result.proposals.length, 0);
    const auditor = runLivingContext({ repoRoot: repo, input: input(revision, { reader: "auditor", claim_ids: ["auditor-only"] }), write: false });
    assert.equal(recallOf(auditor, "auditor-only").status, "current");
    remove(repo);
  });

  test("a default scan lists only claims the reader may see", () => {
    const { repo, revision } = seededRepo();
    const ids = runLivingContext({ repoRoot: repo, input: input(revision), write: false }).recalls.map((entry) => entry.claim_id);
    assert.ok(!ids.includes("auditor-only") && !ids.includes("no-visibility"));
    assert.equal(ids[0], "current-context-contract", "claims that intersect the change come first");
    remove(repo);
  });
});

describe("Living Context: a superseded claim is never presented as current", () => {
  test("a correction is superseded and names its successor", () => {
    const { repo, revision } = seededRepo();
    const result = runLivingContext({ repoRoot: repo, input: input(revision), write: false });
    const old = recallOf(result, "superseded-context-contract");
    assert.equal(old.status, "superseded");
    assert.equal(old.superseded_by, "current-context-contract");
    assert.deepEqual(old.reasons, ["superseded_by_known_successor"]);
    assert.notEqual(old.status, "current");
    assert.equal(recallOf(result, "current-context-contract").status, "current");
    assert.equal(validateLivingContextResult(result).length, 0);
    remove(repo);
  });

  test("a successor the reader cannot see leaves the predecessor current for them, with no trace (Surface per-viewer supersession)", () => {
    const { repo, revision } = seededRepo();
    const engineer = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["hidden-successor-predecessor"] }), write: false });
    const entry = recallOf(engineer, "hidden-successor-predecessor");
    assert.equal(entry.status, "current");
    assert.deepEqual(entry.reasons, ["current_at_as_of"]);
    assert.ok(!JSON.stringify(engineer).includes("auditor-only-successor"), "the hidden successor must not appear anywhere in the result");
    assert.ok(!("superseded_by" in entry));
    const withoutEdge = withClaim("hidden-successor-predecessor", (claim) => { delete claim.superseded_by; delete claim.supersession_kind; delete claim.supersession_recorded_at; claim.status = "current"; });
    const second = seededRepo(withoutEdge);
    const baseline = runLivingContext({ repoRoot: second.repo, input: input(second.revision, { claim_ids: ["hidden-successor-predecessor"] }), write: false });
    const sameModuloCommit = (value) => JSON.stringify(value).replaceAll(/[0-9a-f]{40}/g, "<commit>");
    assert.equal(sameModuloCommit(recallOf(baseline, "hidden-successor-predecessor")), sameModuloCommit(entry), "the result is identical to one where no successor exists");
    remove(second.repo);
    const auditor = recallOf(runLivingContext({ repoRoot: repo, input: input(revision, { reader: "auditor", claim_ids: ["hidden-successor-predecessor"] }), write: false }), "hidden-successor-predecessor");
    assert.equal(auditor.status, "superseded");
    assert.equal(auditor.superseded_by, "auditor-only-successor");
    remove(repo);
  });

  test("a chain through a hidden claim collapses to the nearest visible successor", () => {
    const mk = (id, extra) => ({ id, claim: `Claim ${id}.`, status: "current", authority: { path: "d.md", citation: "c" }, owning_source: { owner: "o", path: "d.md" }, affected_surfaces: ["src/x.js"], visibility: { audiences: ["engineer"] }, recorded_at: "2026-01-01T00:00:00Z", slot: "s", ...extra });
    const edge = { supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z" };
    const manifest = { readers: ["engineer", "auditor"], claims: [
      mk("a", { ...edge, status: "superseded", superseded_by: "h" }),
      mk("h", { ...edge, status: "superseded", superseded_by: "c", visibility: { audiences: ["auditor"] }, supersession_visibility: { audiences: ["engineer", "auditor"] } }),
      mk("c", {}),
    ] };
    const { repo, revision } = seededRepo(manifest, { docs: { "d.md": "x\n" } });
    const entry = recallOf(runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["a"] }), write: false }), "a");
    assert.equal(entry.status, "superseded");
    assert.equal(entry.superseded_by, "c");
    assert.ok(!JSON.stringify(entry).includes('"h"'));
    remove(repo);
  });

  test("a successor with an unknown recording time makes the predecessor unverifiable, not current", () => {
    const manifest = withClaim("current-context-contract", (claim) => { delete claim.recorded_at; });
    const { repo, revision } = seededRepo(manifest);
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["superseded-context-contract", "current-context-contract"] }), write: false });
    assert.equal(recallOf(result, "superseded-context-contract").status, "unverifiable");
    assert.deepEqual(recallOf(result, "superseded-context-contract").reasons, ["supersession_time_unknown"]);
    assert.deepEqual(recallOf(result, "current-context-contract").reasons, ["knowledge_time_unknown"]);
    remove(repo);
  });

  test("a succession without a boundary is unverifiable, not current", () => {
    const manifest = withClaim("new-limit", (claim) => { delete claim.valid_time; });
    const { repo, revision } = seededRepo(manifest);
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["old-limit"] }), write: false });
    assert.deepEqual(recallOf(result, "old-limit").reasons, ["succession_boundary_unknown"]);
    assert.equal(recallOf(result, "old-limit").status, "unverifiable");
    remove(repo);
  });

  test("the result validator rejects a forged current recall that still has an active successor", () => {
    const { repo, revision } = seededRepo();
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["superseded-context-contract"] }), write: false });
    const forged = clone(result);
    forged.recalls[0].status = "current";
    delete forged.recalls[0].superseded_by;
    assert.match(validateLivingContextResult(forged).join(" "), /current recall must not have an active superseded_by link/);
    const noSuccessor = clone(result);
    noSuccessor.recalls[0].superseded_by = "someone-else";
    assert.match(validateLivingContextResult(noSuccessor).join(" "), /superseded recall must name its active successor/);
    remove(repo);
  });
});

describe("Living Context: as-of on valid time and knowledge time", () => {
  test("succession: the predecessor was true at an earlier valid time and superseded at a later one", () => {
    const { repo, revision } = seededRepo();
    const at = (valid_at, known_at) => recallOf(runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["old-limit", "new-limit"], as_of: { now: NOW, valid_at, known_at } }), write: false }), "old-limit");
    const before = at("2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z");
    assert.equal(before.status, "current");
    assert.deepEqual(before.reasons, ["succession_not_effective_at_valid_at", "current_at_as_of"]);
    assert.deepEqual(before.supersession_chain.map((link) => [link.claim_id, link.relation, link.active]), [["old-limit", "self", undefined], ["new-limit", "superseded_by", false]]);
    assert.equal(at("2026-04-01T00:00:00Z", "2026-06-01T00:00:00Z").status, "superseded");
    assert.equal(at("2026-03-01T00:00:00Z", "2026-06-01T00:00:00Z").status, "superseded", "the boundary instant belongs to the successor ([from, until))");
    assert.equal(at("2026-02-28T23:59:59Z", "2026-06-01T00:00:00Z").status, "current");
    remove(repo);
  });

  test("knowledge time: a later observation cannot change the answer about what was known earlier", () => {
    const { repo, revision } = seededRepo();
    const run = (known_at, claim_ids) => runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids, as_of: { now: NOW, valid_at: "2026-04-01T00:00:00Z", known_at } }), write: false });
    const early = run("2026-02-15T00:00:00Z", ["old-limit", "new-limit"]);
    assert.equal(recallOf(early, "old-limit").status, "current", "the successor was not yet known");
    assert.deepEqual(recallOf(early, "old-limit").reasons, ["successor_not_known_at_as_of", "current_at_as_of"]);
    assert.equal(recallOf(early, "new-limit").reason, "no_answer", "a claim recorded after known_at is not known yet");
    assert.ok(!JSON.stringify(recallOf(early, "old-limit")).includes("new-limit"), "an unknown successor must not appear in the chain");
    const late = run("2026-06-01T00:00:00Z", ["old-limit", "new-limit"]);
    assert.equal(recallOf(late, "old-limit").status, "superseded");
    assert.equal(recallOf(late, "new-limit").status, "current");
    remove(repo);
  });

  test("a claim outside its half-open valid interval abstains with a reason", () => {
    const { repo, revision } = seededRepo();
    const at = (valid_at) => recallOf(runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["bounded-validity"], as_of: { now: NOW, valid_at } }), write: false }), "bounded-validity");
    assert.equal(at("2026-01-15T00:00:00Z").status, "current");
    assert.deepEqual(at("2026-02-01T00:00:00Z").reasons, ["not_valid_at_as_of"], "until is exclusive");
    assert.equal(at("2026-02-01T00:00:00Z").reason, "no_answer");
    assert.equal(at("2025-12-31T23:59:59Z").reason, "no_answer");
    remove(repo);
  });

  test("invalid instants and intervals are refused rather than guessed", () => {
    const { revision } = seededRepo();
    assert.ok(validateLivingContextInput(input(revision, { as_of: { now: "2026-06-01" } })).length > 0);
    assert.ok(validateLivingContextInput(input(revision, { as_of: { now: "2026-06-01T00:00:00+02:00" } })).length > 0);
    assert.match(validateLivingContextInput(input(revision, { as_of: { now: "2026-02-31T00:00:00Z" } })).join(" "), /real calendar instant/);
    assert.ok(validateLivingContextInput(input(revision, { as_of: {} })).length > 0, "now is mandatory: no hidden clock");
    for (const mutate of [
      (claim) => { claim.valid_time = { from: "2026-02-01T00:00:00Z", until: "2026-01-01T00:00:00Z" }; },
      (claim) => { claim.valid_time = { from: "2026-02-01T00:00:00Z", until: "2026-02-01T00:00:00Z" }; },
      (claim) => { claim.recorded_at = "2026-02-31T00:00:00Z"; },
      (claim) => { claim.expires_at = "tomorrow"; },
      (claim) => { claim.ttl_seconds = -1; },
      (claim) => { claim.review = { posture: "reviewed" }; },
      (claim) => { claim.supersession_kind = "succession"; },
      (claim) => { claim.supersession_kind = "replacement"; claim.superseded_by = "new-limit"; },
      (claim) => { claim.unexpected = true; },
    ]) {
      const { repo: bad, revision: badRevision } = seededRepo(withClaim("clean-control", mutate));
      assert.throws(() => runLivingContext({ repoRoot: bad, input: input(badRevision), write: false }), (cause) => cause.code === "INVALID_CLAIM_MANIFEST" || cause.code === "INVALID_INSTANT");
      remove(bad);
    }
  });

  test("a cycle among claims the reader can see selects no winner; a cycle through a hidden claim changes nothing", () => {
    const mk = (id, extra) => ({ id, claim: `Claim ${id}.`, status: "current", authority: { path: "d.md", citation: "c" }, owning_source: { owner: "o", path: "d.md" }, affected_surfaces: ["src/x.js"], visibility: { audiences: ["engineer"] }, recorded_at: "2026-01-01T00:00:00Z", slot: "s", ...extra });
    const edge = (to) => ({ status: "superseded", superseded_by: to, supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z" });
    const run = (claims) => { const { repo, revision } = seededRepo({ readers: ["engineer"], claims }, { docs: { "d.md": "x\n" } }); const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: claims.map((claim) => claim.id) }), write: false }); remove(repo); return result; };
    const derived = (claims) => { const { repo, revision } = seededRepo({ readers: ["engineer"], claims }, { docs: { "d.md": "x\n" } }); const { result } = deriveLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: claims.map((claim) => claim.id) }) }); remove(repo); return result; };
    assert.deepEqual(recallOf(derived([mk("a", edge("b")), mk("b", edge("a"))]), "a").reasons, ["supersession_cycle"], "the cycle itself, before any validator runs");
    const self = run([mk("a", edge("a"))]);
    assert.deepEqual([recallOf(self, "a").status, recallOf(self, "a").reasons], ["unverifiable", ["supersession_cycle"]]);
    const two = run([mk("a", edge("b")), mk("b", edge("a")), mk("c", {})]);
    assert.deepEqual(["a", "b"].map((id) => recallOf(two, id).reasons[0]), ["supersession_cycle", "supersession_cycle"]);
    assert.equal(recallOf(two, "c").status, "current");
    const hidden = run([mk("a", edge("h")), mk("h", { ...edge("a"), visibility: { audiences: ["auditor"] } })]);
    assert.equal(recallOf(hidden, "a").status, "current", "a cycle that exists only through a hidden claim must not change what the reader sees");
  });

  test("freshness uses Surface's expiry rule: expiresAt wins, ttl anchors on verification, expiry itself is still fresh", () => {
    const { repo, revision } = seededRepo();
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["stale-claim", "ttl-claim", "current-context-contract"] }), write: false });
    const stale = recallOf(result, "stale-claim");
    assert.equal(stale.status, "unverifiable");
    assert.deepEqual(stale.reasons, ["stale_at_as_of"]);
    assert.deepEqual(stale.freshness, { as_of: NOW_MS, expires_at: "2026-02-01T00:00:00.000Z", stale: true });
    assert.deepEqual(recallOf(result, "ttl-claim").freshness, { as_of: NOW_MS, expires_at: "2026-05-11T00:00:00.000Z", stale: true });
    assert.deepEqual(recallOf(result, "current-context-contract").freshness, { as_of: NOW_MS, expires_at: "2027-01-01T00:00:00.000Z", stale: false });
    const onTheBoundary = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["stale-claim"], as_of: { now: "2026-02-01T00:00:00Z" } }), write: false });
    assert.equal(recallOf(onTheBoundary, "stale-claim").status, "current");
    assert.equal(result.verdict, "not_verified");
    remove(repo);
  });
});

describe("Living Context: reasons, not just rank", () => {
  test("each result carries matched signals, freshness, review posture, supersession chain and status reasons", () => {
    const { repo, revision } = seededRepo();
    const scanned = runLivingContext({ repoRoot: repo, input: input(revision), write: false });
    const current = recallOf(scanned, "current-context-contract");
    assert.deepEqual(current.matched_signals, ["changed_surface", "root_scan"]);
    assert.equal(current.review_posture, "reviewed");
    assert.deepEqual(current.reasons, ["current_at_as_of"]);
    assert.deepEqual(current.supersession_chain.map((link) => [link.claim_id, link.relation, link.kind, link.active]), [["superseded-context-contract", "supersedes", "correction", true], ["current-context-contract", "self", undefined, undefined]]);
    assert.equal(recallOf(scanned, "clean-control").review_posture, "proposed", "unreviewed claims default to proposed");
    assert.deepEqual(recallOf(scanned, "clean-control").matched_signals, ["root_scan"]);
    const asked = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control"] }), write: false });
    assert.deepEqual(recallOf(asked, "clean-control").matched_signals, ["claim_id"]);
    for (const entry of scanned.recalls.filter((item) => item.reason !== "no_answer")) {
      assert.ok(entry.matched_signals.length > 0 && entry.reasons.length > 0 && entry.freshness && entry.supersession_chain.length > 0, `${entry.claim_id} must carry its reasons`);
    }
    remove(repo);
  });
});

describe("Living Context: an explicit budget keeps or drops whole results", () => {
  test("keeps results that fit whole, drops the rest by name, and never reports pass after a drop", () => {
    const { repo, revision } = seededRepo();
    const ids = ["current-context-contract", "superseded-context-contract", "clean-control"];
    const full = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ids }), write: false });
    const costs = full.recalls.map(estimateTokens);
    assert.equal(full.budget.used_tokens, costs.reduce((a, b) => a + b, 0));
    assert.deepEqual(full.budget.dropped, []);
    assert.equal(full.verdict, "pass");

    const exact = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ids, budget: { max_tokens: full.budget.used_tokens } }), write: false });
    assert.equal(exact.recalls.length, 3, "a budget equal to the total keeps everything");
    const tight = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ids, budget: { max_tokens: full.budget.used_tokens - 1 } }), write: false });
    assert.equal(tight.recalls.length, 2);
    assert.deepEqual(tight.budget.dropped, [{ claim_id: "clean-control", estimated_tokens: costs[2] }]);
    assert.equal(tight.verdict, "not_verified", "a dropped result is absence of evidence, not a pass");

    const small = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ids, budget: { max_tokens: costs[0] } }), write: false });
    assert.deepEqual(small.recalls, [full.recalls[0]], "what is kept is byte-identical to the unbudgeted result: whole, never truncated");
    assert.ok(small.budget.used_tokens <= small.budget.max_tokens);
    assert.deepEqual(small.budget.dropped.map((item) => item.claim_id), ids.slice(1));
    assert.equal(small.reconciliation.length, 3, "reconciliation is not silently skipped for dropped recalls");

    const nothing = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ids, budget: { max_tokens: 1 } }), write: false });
    assert.deepEqual(nothing.recalls, []);
    assert.equal(nothing.budget.dropped.length, 3);
    assert.equal(validateLivingContextResult(nothing).length, 0);
    remove(repo);
  });

  test("a budget must be stated, positive and bounded", () => {
    const { revision } = seededRepo();
    const missing = input(revision);
    delete missing.budget;
    assert.ok(validateLivingContextInput(missing).length > 0);
    for (const max_tokens of [0, -5, 1.5, 1000001, "100"]) assert.ok(validateLivingContextInput(input(revision, { budget: { max_tokens } })).length > 0, `max_tokens ${max_tokens}`);
    assert.equal(validateLivingContextInput(input(revision, { budget: { max_tokens: 1000000 } })).length, 0);
  });

  test("the result validator rejects a pass that dropped a result", () => {
    const { repo, revision } = seededRepo();
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control", "current-context-contract"], budget: { max_tokens: 1 } }), write: false });
    const forged = { ...clone(result), verdict: "pass" };
    assert.match(validateLivingContextResult(forged).join(" "), /pass is invalid when the budget dropped/);
    remove(repo);
  });
});

describe("Living Context: abstention is a separate step backed by Survey support verification", () => {
  test("recall carries no answer or abstention; the answer step re-derives it and records a Survey verification", async () => {
    const { repo, revision } = seededRepo();
    const request = input(revision, { claim_ids: ["current-context-contract"] });
    const recall = runLivingContext({ repoRoot: repo, input: request, write: false });
    assert.ok(!JSON.stringify(recall).includes("abstain") && !("answers" in recall));
    const answer = await answerLivingContext({ repoRoot: repo, input: request });
    assert.equal(answer.verdict, "answered");
    const [item] = answer.answers;
    assert.equal(item.outcome, "answered");
    assert.equal(item.authority.revision, revision);
    assert.equal(validateCandidateVerification(item.verification).result, "supported");
    assert.equal(item.verification.method, "deterministic");
    assert.equal(item.verification.createdAt, NOW.replace("Z", ".000Z"), "the record time is the explicit as-of now, not a wall clock");
    remove(repo);
  });

  test("abstains without calling the verifier for superseded, unverifiable, hidden, and dropped results", async () => {
    const { repo, revision } = seededRepo();
    let calls = 0;
    const counting = { id: "spy", version: "1", method: "deterministic", async verify() { calls += 1; return { result: "supported" }; } };
    const answer = await answerLivingContext({
      repoRoot: repo,
      input: input(revision, { claim_ids: ["superseded-context-contract", "stale-claim", "auditor-only"] }),
      verifier: counting,
    });
    assert.equal(calls, 0, "only a current recall is ever sent to a verifier");
    assert.deepEqual(answer.answers.map((item) => [item.claim_id, item.outcome, item.reason]), [
      ["superseded-context-contract", "abstained", "not_current"],
      ["stale-claim", "abstained", "not_current"],
      ["auditor-only", "abstained", "no_answer"],
    ]);
    assert.equal(answer.verdict, "not_verified");
    const dropped = await answerLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control", "current-context-contract"], budget: { max_tokens: 1 } }), verifier: counting });
    assert.deepEqual(dropped.answers.map((item) => item.reason), ["dropped_by_budget", "dropped_by_budget"]);
    assert.equal(calls, 0);
    remove(repo);
  });

  test("thin support abstains: a claim its authority does not state is not answered", async () => {
    const docs = authorityDocs(fixture);
    docs["docs/decisions/cli.md"] = "# CLI\nOutput is documented elsewhere.\n";
    const { repo, revision } = seededRepo(fixture, { docs });
    const answer = await answerLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control", "current-context-contract"] }) });
    assert.deepEqual(answer.answers.map((item) => [item.claim_id, item.outcome, item.reason]), [
      ["clean-control", "abstained", "not_addressed"],
      ["current-context-contract", "answered", undefined],
    ]);
    assert.equal(answer.answers[0].verification.result, "not-addressed");
    assert.equal(answer.verdict, "not_verified", "one abstention means the set is not verified");
    remove(repo);
  });

  test("a verifier that throws, times out, or returns nothing abstains and never answers", async () => {
    const { repo, revision } = seededRepo();
    const request = input(revision, { claim_ids: ["current-context-contract"] });
    const make = (verify) => ({ id: "unreliable", version: "1", method: "model", verify });
    const cases = [
      [make(async () => { throw new Error("boom"); }), "verifier_abstained:error"],
      [make(async () => undefined), "verifier_abstained:empty"],
      [make(async () => ({ result: "maybe" })), "verifier_abstained:malformed"],
      [make(() => new Promise(() => {})), "verifier_abstained:timeout"],
    ];
    for (const [verifier, reason] of cases) {
      const answer = await answerLivingContext({ repoRoot: repo, input: request, verifier, timeoutMs: 20 });
      assert.equal(answer.answers[0].outcome, "abstained", reason);
      assert.equal(answer.answers[0].reason, reason);
      assert.equal(answer.verdict, "not_verified");
    }
    const contradicted = await answerLivingContext({ repoRoot: repo, input: request, verifier: make(async () => ({ result: "contradicted" })) });
    assert.equal(contradicted.answers[0].outcome, "contradicted");
    assert.equal(contradicted.verdict, "not_verified");
    remove(repo);
  });

  test("authority evidence is read at the pinned revision; unreadable, empty or oversized evidence abstains rather than truncating", async () => {
    const docs = authorityDocs(fixture);
    docs["docs/decisions/cli.md"] = `${"x".repeat(MAX_EVIDENCE_BYTES + 1)}\nThe unrelated CLI command preserves its documented output.\n`;
    docs["docs/decisions/retry.md"] = "";
    delete docs["docs/decisions/context-contract.md"];
    const { repo, revision } = seededRepo(fixture, { docs });
    const answer = await answerLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control", "new-limit", "current-context-contract"] }) });
    assert.deepEqual(answer.answers.map((item) => item.reason), ["evidence_too_large", "evidence_empty", "evidence_unreadable"]);
    remove(repo);
  });

  test("the default verifier is deterministic and normalises case, whitespace and the final full stop", async () => {
    const verifier = createLineSupportVerifier();
    const verdict = (value, excerpt) => verifier.verify({ candidateId: "c", value, evidence: [{ id: "e", excerpt, locator: "l" }] });
    assert.deepEqual(await verdict("The retry limit is five.", "intro\n  the RETRY   limit is five \nmore"), { result: "supported" });
    assert.deepEqual(await verdict("The retry limit is five.", "- The retry limit is five.\n"), { result: "supported" }, "a list marker is not part of the statement");
    assert.deepEqual(await verdict("The retry limit is five.", "REJECTED statement: The retry limit is five.\n"), { result: "not-addressed" }, "a substring inside a longer line is not support");
    assert.deepEqual(await verdict("The retry limit is five.", "The retry limit is six."), { result: "not-addressed" });
  });
});

describe("Living Context: reconciliation, proposals-only, and the shared public flow", () => {
  test("reconciles only visible claims and writes only beneath the proposal directory", () => {
    const { repo, revision } = seededRepo();
    const before = snapshot(repo);
    const proposalDir = fs.mkdtempSync(path.join(os.tmpdir(), "living-context-proposals-"));
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { changed_surfaces: ["src/context-adapter.js", "src/audit.js", "src/retry.js"] }), proposalDir });
    assert.equal(validateLivingContextResult(result).length, 0);
    assert.deepEqual(snapshot(repo), before, "the repository stays byte-identical");
    const reconciled = new Set(result.reconciliation.map((item) => item.claim_id));
    assert.ok(!reconciled.has("auditor-only") && !reconciled.has("no-visibility"), "no reconciliation for claims the reader cannot see");
    assert.equal(result.reconciliation.find((item) => item.claim_id === "current-context-contract").status, "affected");
    assert.equal(result.reconciliation.find((item) => item.claim_id === "clean-control").status, "clean", "clean controls are preserved");
    assert.ok(result.proposals.every((proposal) => proposal.status === "proposed" && proposal.route.path.startsWith("docs/decisions/")));
    assert.ok(result.written.includes("context-check-result.json"));
    for (const relative of result.written) assert.ok(fs.existsSync(path.join(proposalDir, relative)), relative);
    assert.deepEqual(fs.readdirSync(proposalDir).sort(), ["context-check-result.json", "proposals"]);
    remove(repo, proposalDir);
  });

  test("an empty default scan is one explicit no-answer and is not a pass", () => {
    const manifest = { readers: ["engineer"], claims: [] };
    const { repo, revision } = seededRepo(manifest);
    const result = runLivingContext({ repoRoot: repo, input: input(revision), write: false });
    assert.deepEqual(result.recalls.map((entry) => [entry.claim_id, entry.reason]), [["no-matching-claims", "no_answer"]]);
    assert.equal(result.verdict, "not_verified");
    remove(repo);
  });

  test("the 1.0 entry point is unchanged and refuses to silently run a 1.1 input", () => {
    const { repo, revision } = seededRepo();
    assert.throws(() => runContextCheck({ repoRoot: repo, input: input(revision), write: false }), (cause) => cause.code === "UNSUPPORTED_SCHEMA_VERSION");
    assert.throws(() => deriveLivingContext({ repoRoot: repo, input: { ...input(revision), schema_version: "1.0" } }), (cause) => cause.code === "INVALID_CONTEXT_CHECK_INPUT");
    remove(repo);
  });

  test("reads the pinned revision, not the dirty working tree", () => {
    const { repo, revision } = seededRepo();
    assert.equal(fs.readFileSync(path.join(repo, "knowledge/claims.json"), "utf8"), "{\"claims\": []}\n");
    const result = runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control"] }), write: false });
    assert.equal(recallOf(result, "clean-control").status, "current");
    assert.equal(recallOf(result, "clean-control").authority.revision, revision);
    remove(repo);
  });

  test("the 1.0 flow is untouched and the Living Context flow exports a claim for every gate, including the separate answer step", () => {
    const legacy = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "flows/context-check.flow.json"), "utf8"));
    assert.deepEqual(legacy.steps.map((step) => step.id), ["read-revision", "recall", "reconcile", "propose", "done"]);
    const flow = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "flows/living-context.flow.json"), "utf8"));
    assert.equal(flow.id, "knowledge.living-context");
    for (const gate of Object.values(flow.gates)) assert.ok(flow.exports.includes(gate.expects[0].bundle_claim.claimType), gate.expects[0].bundle_claim.claimType);
    assert.ok(flow.exports.includes("knowledge.living-context.answer"));
    const order = flow.steps.map((step) => step.id);
    assert.ok(order.indexOf("recall") < order.indexOf("answer") && order.indexOf("answer") < order.indexOf("reconcile"), "answer is its own step after recall");
    assert.equal(flow.gates["answer-gate"].step, "answer");
  });

  test("vendored schemas are exact copies of the canonical schemas", () => {
    for (const name of ["living-context-input.schema.json", "living-context-result.schema.json"]) {
      assert.equal(fs.readFileSync(path.join(KIT_ROOT, "schemas/knowledge", name), "utf8"), fs.readFileSync(path.join(KIT_ROOT, "../../schemas/knowledge", name), "utf8"), name);
    }
  });
});

describe("Living Context: freshness is Surface's derivation, not a second one", () => {
  test("the stale boundary equals Surface's own verified-freshness result at, just after and well after expiry", () => {
    const { repo, revision } = seededRepo();
    const surfaceClaim = (extra) => ({ id: "c", claimType: "t", subjectType: "artifact", subjectId: "s", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "verified", ...extra });
    const event = { id: "e", claimId: "c", status: "verified", actor: "a", method: "m", evidenceIds: [], createdAt: "2026-01-15T00:00:00Z", verifiedAt: "2026-05-01T00:00:00Z" };
    const cases = [
      ["stale-claim", { expiresAt: "2026-02-01T00:00:00Z" }, ["2026-01-31T23:59:59Z", "2026-02-01T00:00:00Z", "2026-02-01T00:00:01Z", "2026-06-01T00:00:00Z"]],
      ["ttl-claim", { ttlSeconds: 864000 }, ["2026-05-10T23:59:59Z", "2026-05-11T00:00:00Z", "2026-05-11T00:00:01Z", "2026-06-01T00:00:00Z"]],
    ];
    for (const [claimId, window, instants] of cases) {
      for (const now of instants) {
        const surface = reapplyVerifiedFreshness({ priorStatus: "verified", claim: surfaceClaim(window), evidence: [], events: [event], now: new Date(now) });
        const ours = recallOf(runLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: [claimId], as_of: { now, known_at: "2026-06-01T00:00:00Z", valid_at: "2026-06-01T00:00:00Z" } }), write: false }), claimId);
        assert.equal(ours.freshness.stale, surface === "stale", `${claimId} at ${now}: Surface says ${surface}`);
      }
    }
    remove(repo);
  });
});

describe("Living Context: bounded repository-change observation", () => {
  function twoCommits(files) {
    const { repo, revision } = seededRepo();
    for (const [relative, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
      fs.writeFileSync(path.join(repo, relative), text);
    }
    git(repo, ["add", "src", "docs"]);
    git(repo, ["commit", "-q", "-m", "change"]);
    return { repo, base: revision, head: git(repo, ["rev-parse", "HEAD"]) };
  }

  test("observes exactly the paths touched between two raw commits and feeds them to a Living Context run", () => {
    const { repo, base, head } = twoCommits({ "src/context-adapter.js": "export {};\n", "docs/decisions/new.md": "# new\n" });
    const observed = observeRepositoryChange({ repoRoot: repo, base, head });
    assert.deepEqual(observed, { base, head, diff: { paths: ["docs/decisions/new.md", "src/context-adapter.js"] } });
    const { diff } = observed;
    const request = input(head, { claim_ids: ["current-context-contract", "clean-control"] });
    delete request.changed_surfaces;
    // The manifest at `head` is the dirty working tree's seed commit manifest (unchanged), so reads stay pinned.
    const result = runLivingContext({ repoRoot: repo, input: { ...request, diff }, write: false });
    assert.equal(result.reconciliation.find((item) => item.claim_id === "current-context-contract").status, "affected");
    assert.equal(result.reconciliation.find((item) => item.claim_id === "clean-control").status, "clean");
    remove(repo);
  });

  test("refuses an empty change, an oversized change, a bad bound, and a non-commit revision instead of truncating", () => {
    const { repo, base, head } = twoCommits({ "src/a.js": "a", "src/b.js": "b", "src/c.js": "c" });
    assert.throws(() => observeRepositoryChange({ repoRoot: repo, base, head, maxPaths: 2 }), (cause) => cause.code === "CHANGE_TOO_LARGE");
    assert.equal(observeRepositoryChange({ repoRoot: repo, base, head, maxPaths: 3 }).diff.paths.length, 3, "exactly at the bound is accepted");
    assert.throws(() => observeRepositoryChange({ repoRoot: repo, base: head, head }), (cause) => cause.code === "EMPTY_CHANGE");
    for (const maxPaths of [0, -1, 1.5, "5"]) assert.throws(() => observeRepositoryChange({ repoRoot: repo, base, head, maxPaths }), (cause) => cause.code === "INVALID_CHANGE_BOUND");
    assert.throws(() => observeRepositoryChange({ repoRoot: repo, base: "main", head }), (cause) => cause.code === "INVALID_CONTEXT_CHECK_INPUT");
    assert.equal(DEFAULT_MAX_CHANGED_PATHS, 500);
    remove(repo);
  });
});

describe("Living Context: review round 1 regressions (#1572)", () => {
  const run = (repo, revision, overrides = {}) => runLivingContext({ repoRoot: repo, input: input(revision, overrides), write: false });
  const failure = (repo, revision, overrides = {}) => { try { run(repo, revision, overrides); } catch (cause) { return cause; } return undefined; };

  test("a malformed claim hidden from the reader discloses nothing; only a listed reader sees its own error", () => {
    const manifest = withClaim("auditor-only", (claim) => { claim.top_secret_project_name = "x"; });
    const { repo, revision } = seededRepo(manifest);
    assert.equal(failure(repo, revision), undefined, "a reader outside the claim's visibility is unaffected");
    assert.ok(!run(repo, revision).recalls.some((entry) => entry.claim_id === "auditor-only"));
    const listed = failure(repo, revision, { reader: "auditor" });
    assert.equal(listed.code, "INVALID_CLAIM_MANIFEST");
    const stranger = failure(repo, revision, { reader: "stranger" });
    assert.equal(stranger.code, "UNKNOWN_READER_IDENTITY");
    assert.ok(!/top_secret|auditor-only|claims\[/.test(stranger.message));
    remove(repo);
  });

  test("the reader is refused before any claim is parsed", () => {
    const manifest = clone(fixture);
    manifest.claims = [{ visibility: { audiences: ["engineer"] }, not: "a claim" }, 7, null];
    const { repo, revision } = seededRepo(manifest, { docs: {} });
    assert.equal(failure(repo, revision, { reader: "stranger" }).code, "UNKNOWN_READER_IDENTITY");
    assert.equal(failure(repo, revision).code, "INVALID_CLAIM_MANIFEST", "a recognised reader reaches claim parsing, where an unlisted malformed claim is dropped and a listed one is reported");
    remove(repo);
  });

  test("a duplicate id is observable only when every copy is visible to the reader", () => {
    const hiddenDuplicate = clone(fixture);
    hiddenDuplicate.claims.push(clone(hiddenDuplicate.claims.find((claim) => claim.id === "auditor-only")));
    const first = seededRepo(hiddenDuplicate);
    assert.equal(failure(first.repo, first.revision), undefined, "a collision among hidden claims is invisible");
    assert.equal(recallOf(run(first.repo, first.revision, { claim_ids: ["auditor-only"] }), "auditor-only").reason, "no_answer");
    assert.equal(failure(first.repo, first.revision, { reader: "auditor" })?.code, "DUPLICATE_CLAIM_ID", "an entitled reader is told");
    remove(first.repo);
    const mixed = clone(fixture);
    const copy = clone(mixed.claims.find((claim) => claim.id === "clean-control"));
    copy.visibility = { audiences: ["auditor"] };
    mixed.claims.push(copy);
    const second = seededRepo(mixed);
    assert.equal(failure(second.repo, second.revision), undefined, "one visible and one hidden copy must not reveal the hidden one");
    assert.equal(recallOf(run(second.repo, second.revision, { claim_ids: ["clean-control"] }), "clean-control").status, "current", "the visible copy stands, exactly as if no duplicate existed");
    remove(second.repo);
  });

  test("a verification after known_at cannot anchor a TTL", () => {
    const manifest = withClaim("ttl-claim", (claim) => { claim.verified_at = "2026-12-01T00:00:00Z"; });
    const { repo, revision } = seededRepo(manifest);
    const entry = run(repo, revision, { claim_ids: ["ttl-claim"] }).recalls[0];
    assert.equal(entry.status, "unverifiable");
    assert.equal(entry.freshness.expires_at, "2026-01-25T00:00:00.000Z", "anchored on recording, not on the future verification");
    const known = run(repo, revision, { claim_ids: ["ttl-claim"], as_of: { now: NOW, known_at: "2026-12-02T00:00:00Z", valid_at: NOW } }).recalls[0];
    assert.equal(known.freshness.expires_at, "2026-12-11T00:00:00.000Z", "a verification that has happened by known_at does anchor it");
    remove(repo);
  });

  test("a supersession edge is its own observation: untimed is indeterminate, recorded after known_at is ignored", () => {
    const untimed = withClaim("superseded-context-contract", (claim) => { delete claim.supersession_recorded_at; });
    const first = seededRepo(untimed);
    const entry = recallOf(run(first.repo, first.revision, { claim_ids: ["superseded-context-contract"] }), "superseded-context-contract");
    assert.equal(entry.status, "unverifiable");
    assert.deepEqual(entry.reasons, ["supersession_time_unknown"]);
    remove(first.repo);
    const late = withClaim("superseded-context-contract", (claim) => { claim.supersession_recorded_at = "2026-05-01T00:00:00Z"; });
    const second = seededRepo(late);
    const early = recallOf(run(second.repo, second.revision, { claim_ids: ["superseded-context-contract"], as_of: { now: NOW, known_at: "2026-02-01T00:00:00Z", valid_at: NOW } }), "superseded-context-contract");
    assert.equal(early.status, "current");
    assert.deepEqual(early.reasons, ["successor_not_known_at_as_of", "current_at_as_of"]);
    assert.equal(recallOf(run(second.repo, second.revision, { claim_ids: ["superseded-context-contract"] }), "superseded-context-contract").status, "superseded");
    remove(second.repo);
  });

  test("a hidden successor does not change a visible claim's answer before its edge was recorded", () => {
    const { repo, revision } = seededRepo();
    const early = recallOf(run(repo, revision, { claim_ids: ["hidden-successor-predecessor"], as_of: { now: NOW, known_at: "2025-12-01T00:00:00Z", valid_at: NOW } }), "hidden-successor-predecessor");
    assert.equal(early.status, "current");
    assert.deepEqual(early.reasons, ["current_at_as_of"], "no reason may mention a successor the reader cannot see");
    remove(repo);
  });

  test("contradiction evidence counts only once recorded by known_at", () => {
    const evidence = { status: "contradicted", authority: { path: "docs/decisions/context-contract.md", citation: "Contradiction evidence" } };
    const reconcile = (mutate, asOf) => {
      const { repo, revision } = seededRepo(withClaim("current-context-contract", mutate));
      const result = run(repo, revision, { claim_ids: ["current-context-contract"], ...(asOf ? { as_of: asOf } : {}) });
      remove(repo);
      return result.reconciliation[0].status;
    };
    assert.equal(reconcile((claim) => { claim.reconciliation_evidence = evidence; }), "affected", "untimed evidence is not applied");
    assert.equal(reconcile((claim) => { claim.reconciliation_evidence = evidence; claim.reconciliation_recorded_at = "2026-02-01T00:00:00Z"; }), "contradicted");
    assert.equal(reconcile((claim) => { claim.reconciliation_evidence = evidence; claim.reconciliation_recorded_at = "2026-05-01T00:00:00Z"; }, { now: NOW, known_at: "2026-04-01T00:00:00Z", valid_at: NOW }), "affected");
  });

  test("a historical scan names no claim that does not exist yet, and the chain lists only known predecessors", () => {
    const { repo, revision } = seededRepo();
    const ids = run(repo, revision, { as_of: { now: NOW, known_at: "2025-12-15T00:00:00Z", valid_at: NOW } }).recalls.map((entry) => entry.claim_id);
    for (const future of ["current-context-contract", "clean-control", "new-limit", "stale-claim", "ttl-claim", "bounded-validity"]) assert.ok(!ids.includes(future), `${future} was recorded after known_at`);
    remove(repo);
    for (const mutate of [(claim) => { delete claim.recorded_at; }, (claim) => { claim.recorded_at = "2027-01-01T00:00:00Z"; }]) {
      const second = seededRepo(withClaim("superseded-context-contract", mutate));
      const chain = recallOf(run(second.repo, second.revision, { claim_ids: ["current-context-contract"] }), "current-context-contract").supersession_chain;
      assert.deepEqual(chain.map((link) => link.claim_id), ["current-context-contract"]);
      remove(second.repo);
    }
  });

  test("a correction applies only within the corrected (successor valid) interval", () => {
    const manifest = withClaim("current-context-contract", (claim) => { claim.valid_time = { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" }; });
    const { repo, revision } = seededRepo(manifest);
    const at = (valid_at) => recallOf(run(repo, revision, { claim_ids: ["superseded-context-contract"], as_of: { now: NOW, valid_at } }), "superseded-context-contract");
    assert.equal(at("2026-03-15T00:00:00Z").status, "superseded");
    const outside = at("2026-02-01T00:00:00Z");
    assert.equal(outside.status, "current");
    assert.deepEqual(outside.reasons, ["correction_interval_excludes_valid_at", "current_at_as_of"]);
    assert.equal(at("2026-04-01T00:00:00Z").status, "current", "until is exclusive");
    remove(repo);
  });

  test("a supersession edge must join one slot: a cross-slot or unslotted edge is inert and never serves the claim", () => {
    for (const mutate of [(claim) => { claim.slot = "another-slot"; }, (claim) => { delete claim.slot; }]) {
      const { repo, revision } = seededRepo(withClaim("superseded-context-contract", mutate));
      const entry = recallOf(run(repo, revision, { claim_ids: ["superseded-context-contract"] }), "superseded-context-contract");
      assert.equal(entry.status, "unverifiable");
      assert.deepEqual(entry.reasons, ["supersession_slot_mismatch"]);
      remove(repo);
    }
  });

  test("reconciliation keeps a derived unverifiable status instead of reporting an ordinary affected claim", () => {
    const { repo, revision } = seededRepo();
    const result = run(repo, revision, { claim_ids: ["stale-claim", "unrecorded", "bounded-validity", "clean-control"], changed_surfaces: ["src/cache.js", "src/unrecorded.js", "src/beta.js", "src/cli.js"] });
    assert.deepEqual(Object.fromEntries(result.reconciliation.map((item) => [item.claim_id, item.status])), { "stale-claim": "unverifiable", unrecorded: "unverifiable", "bounded-validity": "unverifiable", "clean-control": "affected" });
    assert.match(result.proposals.find((proposal) => proposal.claim_id === "stale-claim").rationale, /remains unverifiable/);
    remove(repo);
  });

  test("the answer step has no implicit verifier, and a line that only quotes a statement is not support", async () => {
    const { repo, revision } = seededRepo(fixture, { docs: { ...authorityDocs(fixture), "docs/decisions/cli.md": "REJECTED statement: The unrelated CLI command preserves its documented output.\nThis statement is false.\n" } });
    await assert.rejects(answerWith({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control"] }) }), (cause) => cause.code === "VERIFIER_REQUIRED");
    const answer = await answerLivingContext({ repoRoot: repo, input: input(revision, { claim_ids: ["clean-control"] }) });
    assert.equal(answer.answers[0].outcome, "abstained");
    assert.equal(answer.answers[0].reason, "not_addressed");
    remove(repo);
  });

  test("the result validator rejects internally contradictory results", () => {
    const { repo, revision } = seededRepo();
    const result = run(repo, revision, { claim_ids: ["current-context-contract", "clean-control"] });
    const forge = (mutate) => { const copy = clone(result); mutate(copy); return validateLivingContextResult(copy).join(" "); };
    assert.equal(validateLivingContextResult(result).length, 0);
    assert.match(forge((copy) => { copy.recalls[0].freshness.stale = true; }), /stale recall must not be current/);
    assert.match(forge((copy) => { copy.budget.used_tokens = 1; }), /used_tokens: must equal/);
    assert.match(forge((copy) => { copy.budget.max_tokens = 1; copy.budget.used_tokens = copy.budget.used_tokens; }), /must not exceed max_tokens/);
    assert.match(forge((copy) => { copy.input.as_of.now = "2026-02-31T00:00:00Z"; }), /real calendar instant/);
    assert.match(forge((copy) => { copy.recalls = []; copy.budget.used_tokens = 0; copy.verdict = "pass"; }), /pass is invalid without any recall/);
    assert.match(forge((copy) => { copy.recalls[0].supersession_chain.find((link) => link.relation === "self").claim_id = "someone-else"; }), /exactly once as self/);
    remove(repo);
  });

  test("the shared validator treats inherited Object property names as undeclared", () => {
    const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const value = JSON.parse(`{"a":"x","${key}":1}`);
      assert.match(validate(value, schema).errors.join(" "), /unexpected property/, key);
    }
    assert.match(validate(JSON.parse("{}"), { type: "object", required: ["constructor"] }).errors.join(" "), /missing required property 'constructor'/);
    assert.ok(validateLivingContextInput({ ...input("0".repeat(40)), constructor: 1 }).length > 0);
  });
});

describe("Living Context: review round 2 regressions (#1572)", () => {
  const run = (repo, revision, overrides = {}) => runLivingContext({ repoRoot: repo, input: input(revision, overrides), write: false });
  const failure = (repo, revision, overrides = {}) => { try { run(repo, revision, overrides); } catch (cause) { return cause; } return undefined; };
  const mk = (id, extra) => ({ id, claim: `Claim ${id}.`, status: "current", authority: { path: "d.md", citation: "c" }, owning_source: { owner: "o", path: "d.md" }, affected_surfaces: ["src/x.js"], visibility: { audiences: ["engineer"] }, recorded_at: "2026-01-01T00:00:00Z", slot: "s", ...extra });
  const seed = (manifest, files = {}) => seededRepo(manifest, { docs: { "d.md": "x\n" }, extraFiles: files });

  test("a visibility Surface cannot read is sealed, so a malformed claim carrying it stays silent", () => {
    for (const visibility of [["engineer", "engineer"], { audiences: ["engineer", 7] }, { audiences: [] }, "engineer", 7, { kind: "public" }]) {
      const manifest = { readers: ["engineer"], claims: [mk("ok", {}), { ...mk("secret", {}), visibility, SECRET_PROJECT: 1 }] };
      const { repo, revision } = seed(manifest);
      assert.equal(failure(repo, revision), undefined, JSON.stringify(visibility));
      remove(repo);
    }
    const listed = seed({ readers: ["engineer"], claims: [{ ...mk("secret", {}), SECRET_PROJECT: 1 }] });
    assert.equal(failure(listed.repo, listed.revision).code, "INVALID_CLAIM_MANIFEST", "a claim Surface says the reader may see reports its own error");
    remove(listed.repo);
  });

  test("a public claim is visible to every recognised reader, and an unrecognised one is still refused", () => {
    const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims: [mk("open", { visibility: "public" })] });
    for (const reader of ["engineer", "auditor"]) assert.equal(recallOf(run(repo, revision, { reader, claim_ids: ["open"] }), "open").status, "current");
    assert.equal(failure(repo, revision, { reader: "stranger" }).code, "UNKNOWN_READER_IDENTITY");
    remove(repo);
  });

  test("a malformed claim recorded after known_at is silent; one recorded by then reports its own error", () => {
    const bad = (recorded_at) => seed({ readers: ["engineer"], claims: [mk("ok", {}), { ...mk("later", { recorded_at }), SECRET_FUTURE_DETAIL: 1 }] });
    const future = bad("2030-01-01T00:00:00Z");
    assert.equal(failure(future.repo, future.revision), undefined);
    remove(future.repo);
    const known = bad("2026-02-01T00:00:00Z");
    const cause = failure(known.repo, known.revision);
    assert.equal(cause.code, "INVALID_CLAIM_MANIFEST");
    assert.match(cause.message, /claim 'later'/);
    remove(known.repo);
  });

  test("diagnostics name the claim, never its array position, so hidden entries cannot be counted", () => {
    const messages = [0, 3].map((hidden) => {
      const hiddenClaims = Array.from({ length: hidden }, (_, index) => ({ ...mk(`hidden-${index}`, { visibility: { audiences: ["auditor"] } }), junk: index }));
      const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims: [...hiddenClaims, { ...mk("own", {}), junk: 1 }] });
      const cause = failure(repo, revision);
      remove(repo);
      return cause.message;
    });
    assert.equal(messages[0], messages[1]);
    assert.ok(!/claims\[/.test(messages[0]));
  });

  test("the reader is admitted at every root before any claim of any root is parsed", () => {
    const a = { readers: ["engineer"], claims: [{ visibility: { audiences: ["engineer"] }, SECRET_ROOT_A: 1 }] };
    const b = { readers: ["auditor"], claims: [] };
    const { repo, revision } = seededRepo(fixture, { docs: {}, extraFiles: { "knowledge/a.json": JSON.stringify(a), "knowledge/b.json": JSON.stringify(b) } });
    const roots = (...paths) => paths.map((manifest_path, index) => ({ id: `r${index}`, provider: "git-repo", manifest_path }));
    for (const order of [["knowledge/a.json", "knowledge/b.json"], ["knowledge/b.json", "knowledge/a.json"]]) {
      assert.equal(failure(repo, revision, { knowledge_roots: roots(...order) }).code, "UNKNOWN_READER_IDENTITY", order.join(" then "));
    }
    remove(repo);
  });

  test("an unknown reader named on a malformed claim is refused as an unknown reader, never as a parse error", () => {
    const { repo, revision } = seed({ readers: ["engineer"], claims: [{ ...mk("x", { visibility: { audiences: ["stranger"] } }), SECRET_UNKNOWN_READER: 1 }] });
    const cause = failure(repo, revision, { reader: "stranger" });
    assert.equal(cause.code, "UNKNOWN_READER_IDENTITY");
    assert.ok(!cause.message.includes("SECRET_UNKNOWN_READER"));
    remove(repo);
  });

  test("a multi-hop correction whose first edge is outside its interval leaves the head current and returns a valid result", () => {
    const edge = { status: "superseded", supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z" };
    const manifest = { readers: ["engineer"], claims: [
      mk("a", { ...edge, superseded_by: "b" }),
      mk("b", { ...edge, superseded_by: "c", valid_time: { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }),
      mk("c", {}),
    ] };
    const { repo, revision } = seed(manifest);
    const at = (valid_at) => recallOf(run(repo, revision, { claim_ids: ["a", "b", "c"], as_of: { now: NOW, valid_at } }), "a");
    const before = at("2026-02-01T00:00:00Z");
    assert.equal(before.status, "current");
    assert.deepEqual(before.supersession_chain.map((link) => [link.claim_id, link.relation, link.active]), [["a", "self", undefined], ["b", "superseded_by", false]], "the chain stops at the inactive edge");
    assert.equal(at("2026-03-15T00:00:00Z").status, "superseded");
    remove(repo);
  });

  test("a dangling successor is indistinguishable from a hidden one: the claim is simply current", () => {
    const base = (successor) => seed({ readers: ["engineer"], claims: [mk("a", { status: "superseded", superseded_by: successor, supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z" })] });
    const dangling = base("nowhere");
    const entry = recallOf(run(dangling.repo, dangling.revision, { claim_ids: ["a"] }), "a");
    assert.equal(entry.status, "current");
    assert.deepEqual(entry.reasons, ["current_at_as_of"]);
    remove(dangling.repo);
  });

  test("an edge's visibility is an explicit decision: unreadable means sealed, so the edge is not followed for anyone", () => {
    const edge = { status: "superseded", superseded_by: "b", supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z" };
    const status = (supersession_visibility) => {
      const { repo, revision } = seed({ readers: ["engineer"], claims: [mk("a", { ...edge, ...(supersession_visibility === undefined ? {} : { supersession_visibility }) }), mk("b", {})] });
      const entry = recallOf(run(repo, revision, { claim_ids: ["a"] }), "a");
      remove(repo);
      return entry.status;
    };
    assert.equal(status(undefined), "superseded", "by default the edge is as visible as the claim that carries it");
    assert.equal(status({ audiences: ["engineer"] }), "superseded");
    assert.equal(status({ audiences: ["auditor"] }), "current");
    assert.equal(status("sealed-by-typo"), "current");
  });

  test("the result validator rejects freshness and reasons that contradict the status", () => {
    const { repo, revision } = seededRepo();
    const result = run(repo, revision, { claim_ids: ["current-context-contract", "superseded-context-contract"] });
    const forge = (mutate) => { const copy = clone(result); mutate(copy); copy.budget.used_tokens = copy.recalls.reduce((sum, recall) => sum + estimateTokens(recall), 0); return validateLivingContextResult(copy).join(" "); };
    assert.equal(validateLivingContextResult(result).length, 0);
    const current = (copy) => copy.recalls.find((recall) => recall.status === "current");
    const superseded = (copy) => copy.recalls.find((recall) => recall.status === "superseded");
    assert.match(forge((copy) => { current(copy).freshness.expires_at = "2000-01-01T00:00:00.000Z"; }), /freshness\.stale must equal/);
    assert.match(forge((copy) => { current(copy).freshness.stale = true; delete current(copy).freshness.expires_at; }), /cannot be stale without an expiry/);
    assert.match(forge((copy) => { current(copy).reasons = ["superseded_by_known_successor"]; }), /reasons contradict a current status/);
    assert.match(forge((copy) => { superseded(copy).reasons = ["current_at_as_of"]; }), /reasons contradict a superseded status/);
    remove(repo);
  });

  test("a Surface without derived visibility is refused by name instead of failing at module load", () => {
    assert.throws(() => assertSurfaceVisibility({ claimIntrinsicExpiry() {} }), (cause) => cause.code === "SURFACE_VISIBILITY_UNAVAILABLE" && /6\.3\.0/.test(cause.message) && /viewerSupersessionView/.test(cause.message));
    assert.doesNotThrow(() => assertSurfaceVisibility());
  });
});

describe("Living Context: review round 3 regressions (#1572)", () => {
  const run = (repo, revision, overrides = {}) => runLivingContext({ repoRoot: repo, input: input(revision, overrides), write: false });
  const failure = (repo, revision, overrides = {}) => { try { run(repo, revision, overrides); } catch (cause) { return cause; } return undefined; };
  const mk = (id, extra) => ({ id, claim: `Claim ${id}.`, status: "current", authority: { path: "d.md", citation: "c" }, owning_source: { owner: "o", path: "d.md" }, affected_surfaces: ["src/x.js"], visibility: { audiences: ["engineer"] }, recorded_at: "2026-01-01T00:00:00Z", slot: "s", ...extra });
  const edge = (to, extra = {}) => ({ status: "superseded", superseded_by: to, supersession_kind: "correction", supersession_recorded_at: "2026-01-02T00:00:00Z", ...extra });
  const seed = (manifest) => seededRepo(manifest, { docs: { "d.md": "Claim a.\nClaim b.\n" } });

  test("a hidden or not-yet-known duplicate of a visible successor never turns its predecessor current", async () => {
    for (const duplicate of [{ visibility: { audiences: ["auditor"] } }, { recorded_at: "2030-01-01T00:00:00Z" }]) {
      const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims: [mk("a", edge("b")), mk("b", {}), mk("b", duplicate)] });
      const request = input(revision, { claim_ids: ["a", "b"] });
      const result = run(repo, revision, { claim_ids: ["a", "b"] });
      assert.equal(recallOf(result, "a").status, "superseded", JSON.stringify(duplicate));
      assert.equal(recallOf(result, "b").status, "current");
      assert.equal(result.verdict, "pass");
      const answer = await answerLivingContext({ repoRoot: repo, input: request });
      assert.equal(answer.answers.find((item) => item.claim_id === "a").outcome, "abstained");
      remove(repo);
    }
  });

  test("two entitled copies of one id are an error; a hidden-only collision is structure and changes nothing", () => {
    const both = seed({ readers: ["engineer"], claims: [mk("b", {}), mk("b", {})] });
    assert.equal(failure(both.repo, both.revision, { claim_ids: ["b"] }).code, "DUPLICATE_CLAIM_ID");
    remove(both.repo);
    const hidden = seed({ readers: ["engineer", "auditor"], claims: [mk("a", edge("h")), mk("h", { ...edge("c"), visibility: { audiences: ["auditor"] }, supersession_visibility: { audiences: ["engineer", "auditor"] } }), mk("h", { visibility: { audiences: ["auditor"] } }), mk("c", {})] });
    assert.equal(failure(hidden.repo, hidden.revision, { claim_ids: ["a"] }), undefined);
    remove(hidden.repo);
  });

  test("an edge the reader may not see explains nothing: no chain link, no reason, no status change", () => {
    const restricted = { supersession_visibility: { audiences: ["auditor"] } };
    const at = (successorExtra, claimExtra = {}, asOf) => {
      const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims: [mk("a", edge("b", { ...restricted, ...claimExtra })), mk("b", successorExtra)] });
      const result = run(repo, revision, { claim_ids: ["a"], ...(asOf ? { as_of: asOf } : {}) });
      const baselineRepo = seed({ readers: ["engineer", "auditor"], claims: [mk("a", { status: "current" }), mk("b", successorExtra)] });
      const baseline = run(baselineRepo.repo, baselineRepo.revision, { claim_ids: ["a"], ...(asOf ? { as_of: asOf } : {}) });
      remove(repo, baselineRepo.repo);
      const normalise = (value) => JSON.stringify(value).replaceAll(/[0-9a-f]{40}/g, "<commit>");
      return [normalise(recallOf(result, "a")), normalise(recallOf(baseline, "a")), result.budget];
    };
    for (const [label, args] of [
      ["inactive correction", [{ valid_time: { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }, {}, { now: NOW, valid_at: "2026-02-01T00:00:00Z" }]],
      ["slot mismatch", [{ slot: "other" }]],
      ["untimed edge", [{}, { supersession_recorded_at: undefined }]],
      ["not yet recorded", [{}, {}, { now: NOW, known_at: "2026-01-01T12:00:00Z", valid_at: NOW }]],
    ]) {
      const [actual, baseline] = at(...args);
      assert.equal(actual, baseline, `${label}: identical to a claim with no successor`);
    }
  });

  test("every parser error family names the claim, never its array position", () => {
    for (const [label, mutate] of [["identity", (claim) => { claim.id = "bad id!"; }], ["path", (claim) => { claim.authority.path = "../x"; }], ["instant", (claim) => { claim.recorded_at = "nope"; }], ["shape", (claim) => { claim.junk = 1; }]]) {
      const messages = [0, 3].map((hidden) => {
        const hiddenClaims = Array.from({ length: hidden }, (_, index) => mk(`h${index}`, { visibility: { audiences: ["auditor"] } }));
        const bad = mk("own", {});
        mutate(bad);
        const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims: [...hiddenClaims, bad] });
        const cause = failure(repo, revision);
        remove(repo);
        return cause.message;
      });
      assert.equal(messages[0], messages[1], label);
      assert.ok(!/claims\[/.test(messages[0]), label);
    }
  });

  test("the validator binds freshness to the stated now and ties the stale reason to the stale flag", () => {
    const { repo, revision } = seed({ readers: ["engineer"], claims: [mk("a", { expires_at: "2027-01-01T00:00:00Z" }), mk("b", { expires_at: "2026-02-01T00:00:00Z" })] });
    const result = run(repo, revision, { claim_ids: ["a", "b"] });
    const forge = (mutate) => { const copy = clone(result); mutate(copy); copy.budget.used_tokens = copy.recalls.reduce((sum, recall) => sum + estimateTokens(recall), 0); return validateLivingContextResult(copy).join(" "); };
    assert.equal(validateLivingContextResult(result).length, 0);
    assert.match(forge((copy) => { copy.recalls[0].freshness = { as_of: "1999-01-01T00:00:00.000Z", expires_at: "2000-01-01T00:00:00.000Z", stale: false }; }), /freshness\.as_of must equal input\.as_of\.now/);
    assert.match(forge((copy) => { copy.recalls[0].freshness.expires_at = "2027-02-31T00:00:00.000Z"; }), /real calendar instant/);
    assert.match(forge((copy) => { copy.recalls[1].freshness.stale = false; }), /stale_at_as_of reason requires freshness\.stale/);
    remove(repo);
  });

  test("Surface accepts a repeated audience label, so a visibility that repeats one is still visible", () => {
    const { repo, revision } = seed({ readers: ["engineer"], claims: [mk("a", { visibility: { audiences: ["engineer", "engineer"] } })] });
    assert.equal(recallOf(run(repo, revision, { claim_ids: ["a"] }), "a").status, "current");
    remove(repo);
  });

  test("a stale superseded claim is returned as superseded, not rejected by the producer's own validator", () => {
    const { repo, revision } = seed({ readers: ["engineer"], claims: [mk("a", { ...edge("z"), expires_at: "2026-02-01T00:00:00Z" }), mk("z", {})] });
    const entry = recallOf(run(repo, revision, { claim_ids: ["a"] }), "a");
    assert.equal(entry.status, "superseded");
    assert.equal(entry.freshness.stale, true);
    assert.deepEqual(entry.reasons, ["superseded_by_known_successor"]);
    remove(repo);
  });

  test("conflicting hidden copies of an id on a visible claim's chain make it unverifiable, in any file order, never current", async () => {
    const hidden = { visibility: { audiences: ["auditor"] } };
    const publicEdge = { supersession_visibility: "public" };
    const normalise = (value) => JSON.stringify(value).replaceAll(/[0-9a-f]{40}/g, "<commit>");
    const outcome = async (claims, extraRoot) => {
      const files = extraRoot ? { "knowledge/other.json": JSON.stringify({ readers: ["engineer", "auditor"], claims: extraRoot }) } : {};
      const { repo, revision } = seededRepo({ readers: ["engineer", "auditor"], claims }, { docs: { "d.md": "Claim a.\nClaim z.\n" }, extraFiles: files });
      const roots = [{ id: "r0", provider: "git-repo", manifest_path: "knowledge/claims.json" }, ...(extraRoot ? [{ id: "r1", provider: "git-repo", manifest_path: "knowledge/other.json" }] : [])];
      const request = input(revision, { claim_ids: ["a"], knowledge_roots: roots });
      const result = runLivingContext({ repoRoot: repo, input: request, write: false });
      const answer = await answerLivingContext({ repoRoot: repo, input: request });
      remove(repo);
      return { json: normalise({ ...result, written: undefined }), entry: recallOf(result, "a"), answered: answer.answers[0].outcome };
    };
    const through = { ...hidden, ...edge("z"), ...publicEdge };
    const chain = (extra) => [mk("a", edge("h")), ...extra, mk("z", {})];
    const baseline = await outcome(chain([mk("h", through)]));
    assert.equal(baseline.entry.status, "superseded");
    const variants = [
      ["conflicting copy first", chain([mk("h", { ...hidden, slot: "other" }), mk("h", through)])],
      ["conflicting copy last", chain([mk("h", through), mk("h", { ...hidden, slot: "other" })])],
      ["an exact twin", chain([mk("h", through), mk("h", through)])],
      ["a hidden cycle formed by the copies (a -> h -> z -> h, plus h -> a)", [mk("a", edge("h")), mk("h", through), mk("h", { ...hidden, ...edge("a"), ...publicEdge }), mk("z", edge("h"))]],
    ];
    const results = [];
    for (const [label, claims] of variants) {
      const actual = await outcome(claims);
      assert.equal(actual.entry.status, "unverifiable", label);
      assert.deepEqual(actual.entry.reasons, ["supersession_ambiguous"], label);
      assert.equal(actual.answered, "abstained", label);
      results.push(actual.json);
    }
    assert.equal(results[0], results[1], "the answer does not depend on file order");
    assert.equal(results[0], results[2], "nor on whether the copies differ");
    const acrossRoots = await outcome(chain([mk("h", through)]), [mk("h", { ...hidden, slot: "other" })]);
    assert.equal(acrossRoots.entry.status, "unverifiable");
    assert.equal(acrossRoots.answered, "abstained");
  });

  test("a hidden duplicate that no visible claim's chain reaches changes nothing, in any position", async () => {
    const hidden = { visibility: { audiences: ["auditor"] } };
    const normalise = (value) => JSON.stringify(value).replaceAll(/[0-9a-f]{40}/g, "<commit>");
    const body = async (claims) => { const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims }); const result = run(repo, revision, { claim_ids: ["a", "z"] }); remove(repo); return normalise({ ...result, written: undefined }); };
    const core = [mk("a", edge("z")), mk("z", {})];
    const baseline = await body(core);
    for (const extra of [[mk("q", hidden), mk("q", { ...hidden, slot: "other" })], [mk("q", { ...hidden, ...edge("a") }), mk("q", hidden)]]) {
      assert.equal(await body([...extra, ...core]), baseline, "first");
      assert.equal(await body([...core, ...extra]), baseline, "last");
    }
  });

  test("a hidden copy cannot hide the reader's own not-yet-known claim", () => {
    const base = (claims) => { const { repo, revision } = seed({ readers: ["engineer", "auditor"], claims }); const entry = recallOf(run(repo, revision, { claim_ids: ["a"] }), "a"); remove(repo); return JSON.stringify(entry).replaceAll(/[0-9a-f]{40}/g, "<commit>"); };
    const future = mk("b", { recorded_at: "2030-01-01T00:00:00Z" });
    const predecessor = mk("a", edge("b"));
    const alone = base([predecessor, future]);
    assert.match(alone, /successor_not_known_at_as_of/);
    assert.equal(base([predecessor, mk("b", { visibility: { audiences: ["auditor"] } }), future]), alone, "a known hidden copy first");
    assert.equal(base([predecessor, future, mk("b", { visibility: { audiences: ["auditor"] } })]), alone, "a known hidden copy last");
  });

  test("history keeps an inactive link into a claim that is outside its own valid interval but superseded further on", () => {
    const manifest = { readers: ["engineer", "auditor"], claims: [
      mk("p2", edge("p1")),
      mk("p1", { ...edge("x"), valid_time: { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }),
      mk("x", {}),
    ] };
    const { repo, revision } = seed(manifest);
    const links = (overrides) => recallOf(run(repo, revision, { claim_ids: ["p1", "x"], ...overrides }), "x").supersession_chain.map((link) => `${link.claim_id}:${link.relation}:${link.active}`);
    assert.equal(recallOf(run(repo, revision, { claim_ids: ["p1"] }), "p1").status, "superseded", "supersession is judged before validity");
    assert.deepEqual(links({}), ["p2:supersedes:false", "p1:supersedes:true", "x:self:undefined"]);
    const restricted = seed({ readers: ["engineer", "auditor"], claims: [mk("p2", edge("p1", { supersession_visibility: { audiences: ["auditor"] } })), manifest.claims[1], manifest.claims[2]] });
    const restrictedChain = recallOf(run(restricted.repo, restricted.revision, { claim_ids: ["p1"] }), "p1").supersession_chain.map((link) => link.claim_id);
    assert.ok(!restrictedChain.includes("p2"), "a restricted edge is never listed");
    remove(repo, restricted.repo);
  });
});

