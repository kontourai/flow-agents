/**
 * Knowledge promote sub-flow — AC1..AC3 (issue #313).
 *
 *   AC1: running the sub-flow on a completed session dir emits >=1 schema-valid
 *        draft decision delta with correct provenance links (R1, R2). The draft
 *        is validated against #310's REAL registry validator
 *        (scripts/check-decisions.cjs) as command evidence. The session fixture
 *        is modeled faithfully on the real completed session
 *        `.kontourai/flow-agents/kontourai-flow-agents-287` (actor-identity work,
 *        status accepted) — a portable, committed copy so the lane is
 *        deterministic and CI-runnable.
 *   AC2: a fixture registry with a seeded contradiction (two CURRENT topics, one
 *        subject noun, divergent content) yields a contradiction report naming
 *        BOTH topics and a merge-repair proposal naming a merge target (R3).
 *   AC3: a filesystem diff during a run shows zero writes outside the
 *        session/proposal dir (R4).
 *
 * Run: node --test kits/knowledge/promote/promote.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runPromote, health } from "./index.js";
import { snapshotDir } from "./lib.js";
import { GitRepoProvider } from "../providers/git-repo/index.js";
import { loadSchemas } from "../providers/lib/model.js";
import { validate } from "../providers/lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIX = path.join(__dirname, "fixtures");
const SESSION = path.join(FIX, "session");
const CLEAN_REPO = path.join(FIX, "repo");
const CONTRADICTION_REPO = path.join(FIX, "contradiction-registry");
const CONFORMANCE_GIT = path.resolve(__dirname, "../providers/conformance/fixtures/git-repo");
const { proposal: PROPOSAL_SCHEMA, healthReport: REPORT_SCHEMA } = loadSchemas();

function tmpOut(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `promote-${tag}-`));
}

const PROVENANCE = {
  pr: "https://github.com/kontourai/flow-agents/pull/391",
  mergeSha: "abc1234def5678",
  sessionArchivePath: ".kontourai/flow-agents/kontourai-flow-agents-287/archive/kontourai-flow-agents-287--deliver.md",
};

describe("AC1: real completed session -> schema-valid draft delta with provenance", () => {
  test("emits >=1 decision delta carrying PR + merge SHA + session-archive links", async () => {
    const outDir = tmpOut("ac1");
    const result = await runPromote({ sessionDir: SESSION, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir });

    assert.ok(result.decisions.length >= 1, "expected at least one draft decision delta");
    const delta = result.decisions.find((d) => d.slug === "actor-identity") || result.decisions[0];
    const kinds = new Set(delta.evidence.map((e) => e.kind));
    assert.ok(kinds.has("pr"), "delta must link the PR");
    assert.ok(kinds.has("commit"), "delta must link the merge SHA (commit)");
    assert.ok(kinds.has("session-archive"), "delta must link the archived session artifact");
    const prRef = delta.evidence.find((e) => e.kind === "pr").ref;
    assert.equal(prRef, PROVENANCE.pr);

    // The draft topic file was written under the proposals dir.
    const draftFile = path.join(outDir, "decisions", `${delta.slug}.md`);
    assert.ok(fs.existsSync(draftFile), "draft topic file written under proposals/decisions");

    // Command evidence (R2): the REAL #310 validator accepts the drafts.
    const decisionsDir = path.join(outDir, "decisions");
    const env = { ...process.env, FLOW_AGENTS_DECISIONS_DIR: decisionsDir, FORCE_COLOR: "0" };
    execFileSync("node", [path.join(REPO_ROOT, "scripts/check-decisions.cjs"), "gen-index"], { env, cwd: REPO_ROOT });
    const checkOut = execFileSync("node", [path.join(REPO_ROOT, "scripts/check-decisions.cjs"), "check"], { env, cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(checkOut, /Decision registry check passed/, "drafts must pass the real #310 registry validator");

    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test("ingests plan, learnings, and transcripts from the session", async () => {
    const result = await runPromote({ sessionDir: SESSION, repoRoot: CLEAN_REPO, provenance: PROVENANCE, write: false });
    assert.ok(result.learnings.length >= 1, "expected learning deltas from learning.json");
    assert.ok(result.ingested.transcript_refs.length >= 1, "expected delegate transcript refs");
    assert.equal(result.ingested.status, "accepted");
  });
});

describe("AC2: seeded contradiction -> report naming both topics + merge proposal", () => {
  test("duplicate-detection report names both topics and a merge-repair proposal is emitted", async () => {
    const { report, mergeProposals } = await health({ repoRoot: CONTRADICTION_REPO });

    const { valid, errors } = validate(report, REPORT_SCHEMA);
    assert.ok(valid, `report not schema-valid:\n  ${errors.join("\n  ")}`);
    const finding = report.findings.find(
      (f) => f.node_ids.includes("decision:cache-eviction-policy") && f.node_ids.includes("decision:cache-eviction"),
    );
    assert.ok(finding, "expected a contradiction finding naming BOTH cache-eviction topics");

    assert.equal(mergeProposals.length, 1, "expected exactly one merge-repair proposal");
    const mp = mergeProposals[0];
    const p = validate(mp, PROPOSAL_SCHEMA);
    assert.ok(p.valid, `merge-repair proposal not schema-valid:\n  ${p.errors.join("\n  ")}`);
    assert.equal(mp.status, "proposed", "merge-repair must be proposals-only (never auto-applied)");
    assert.equal(mp.kind, "decision-topic");
    assert.deepEqual([...mp.target.topics].sort(), ["cache-eviction", "cache-eviction-policy"]);
    // Merge target = the more-recently-decided topic (cache-eviction @ 2026-06-25).
    assert.equal(mp.target.merge_into, "cache-eviction");
    assert.match(mp.rendered, /merged_into: cache-eviction/);
  });

  test("a resolved supersede/merge pair is NOT flagged as a contradiction", async () => {
    // The conformance git-repo fixture has sprocket-shape (current) + old-sprocket-shape (merged
    // tombstone) — a RESOLVED pair. It must not produce a merge-repair proposal.
    const { mergeProposals } = await health({ repoRoot: CONFORMANCE_GIT });
    const badPair = mergeProposals.find((mp) => mp.target.topics.includes("old-sprocket-shape"));
    assert.ok(!badPair, "a resolved merge tombstone must not be re-flagged as a contradiction");
  });
});

describe("AC3: zero writes outside the session/proposal dir", () => {
  test("the source repo registry is byte-identical before and after a run", async () => {
    const before = snapshotDir(CONTRADICTION_REPO);
    const beforeSession = snapshotDir(SESSION);
    const outDir = tmpOut("ac3");

    const result = await runPromote({ sessionDir: SESSION, repoRoot: CONTRADICTION_REPO, provenance: PROVENANCE, outDir });

    // The read source (repoRoot) and the read session are untouched.
    assert.deepEqual(snapshotDir(CONTRADICTION_REPO), before, "repoRoot registry must be untouched");
    assert.deepEqual(snapshotDir(SESSION), beforeSession, "session dir must be untouched");

    // Every written path is under outDir.
    assert.ok(result.written.length > 0, "expected drafts to be written");
    for (const rel of result.written) {
      const abs = path.resolve(outDir, rel);
      assert.ok(abs.startsWith(path.resolve(outDir) + path.sep), `write escaped outDir: ${rel}`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test("default outDir lands under the session directory", async () => {
    // Copy the session fixture to a temp dir so the default proposals/ write is isolated.
    const tmpSession = tmpOut("ac3-default");
    for (const rel of Object.keys(snapshotDir(SESSION))) {
      const src = path.join(SESSION, rel);
      const dst = path.join(tmpSession, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    const result = await runPromote({ sessionDir: tmpSession, repoRoot: CLEAN_REPO, provenance: PROVENANCE });
    assert.equal(result.out_dir, path.join(tmpSession, "proposals"));
    assert.ok(fs.existsSync(path.join(tmpSession, "proposals", "README.md")));
    fs.rmSync(tmpSession, { recursive: true, force: true });
  });
});

describe("R1: the FlowDefinition is composable (true sub-flow nesting)", () => {
  test("promote.flow.json exports every gate claim so a parent uses_flow step resolves", () => {
    const flow = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "kits/knowledge/flows/promote.flow.json"), "utf8"));
    assert.equal(flow.id, "knowledge.promote");
    const stepIds = flow.steps.map((s) => s.id);
    for (const step of ["ingest", "distill", "link", "health"]) {
      assert.ok(stepIds.includes(step), `missing step ${step}`);
      const gate = Object.values(flow.gates).find((g) => g.step === step);
      assert.ok(gate, `missing gate for step ${step}`);
      const claimType = gate.expects[0].bundle_claim.claimType;
      // Every gate claim MUST be exported for a parent step's uses_flow edge to
      // resolve (src/lib/flow-resolver.ts requires all child expects be exported).
      assert.ok(flow.exports.includes(claimType), `gate claim ${claimType} must be exported for composability`);
    }
  });
});
