/**
 * Knowledge promote sub-flow — AC1..AC3 (issue #313).
 *
 *   AC1: running the sub-flow on a completed session dir emits >=1 schema-valid
 *        draft decision delta with correct provenance links (R1, R2). The draft
 *        is validated against the Kit-owned #310 decision-record validator. The session fixture
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
import fsDefault from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

import { runPromote, health } from "./index.js";
import { snapshotDir, validateDecisionDelta } from "./lib.js";
import { GitRepoProvider } from "../providers/git-repo/index.js";
import { loadSchemas } from "../providers/lib/model.js";
import { validate } from "../providers/lib/schema-validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const SESSION = path.join(FIX, "session");
const CLEAN_REPO = path.join(FIX, "repo");
const CONTRADICTION_REPO = path.join(FIX, "contradiction-registry");
const CONFORMANCE_GIT = path.resolve(__dirname, "../providers/conformance/fixtures/git-repo");
const { proposal: PROPOSAL_SCHEMA, healthReport: REPORT_SCHEMA } = loadSchemas();

function tmpSession(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `promote-${tag}-`));
  const session = path.join(root, "session");
  fs.cpSync(SESSION, session, { recursive: true });
  return { root, session };
}

const PROVENANCE = {
  pr: "https://github.com/kontourai/flow-agents/pull/391",
  mergeSha: "abc1234def5678",
  sessionArchivePath: ".kontourai/flow-agents/kontourai-flow-agents-287/archive/kontourai-flow-agents-287--deliver.md",
};

describe("AC1: real completed session -> schema-valid draft delta with provenance", () => {
  test("emits >=1 decision delta carrying PR + merge SHA + session-archive links", async () => {
    const { root, session } = tmpSession("ac1");
    const outDir = path.join(session, "proposals-ac1");
    const result = await runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir });

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

    // The Kit-owned decision validator accepts the emitted proposal without
    // reaching into a consuming repository's scripts/ directory.
    assert.deepEqual(validateDecisionDelta(delta), [], "drafts must satisfy the decision-record contract");

    fs.rmSync(root, { recursive: true, force: true });
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
    const { root, session } = tmpSession("ac3");
    const beforeSession = snapshotDir(session);
    const outDir = path.join(session, "proposals-ac3");

    const result = await runPromote({ sessionDir: session, repoRoot: CONTRADICTION_REPO, provenance: PROVENANCE, outDir });

    // The read source (repoRoot) and the read session are untouched.
    assert.deepEqual(snapshotDir(CONTRADICTION_REPO), before, "repoRoot registry must be untouched");
    const afterSession = snapshotDir(session);
    for (const [rel, content] of Object.entries(beforeSession)) {
      assert.equal(afterSession[rel], content, `session file changed outside proposals: ${rel}`);
    }

    // Every written path is under outDir.
    assert.ok(result.written.length > 0, "expected drafts to be written");
    for (const rel of result.written) {
      const abs = path.resolve(outDir, rel);
      assert.ok(abs.startsWith(path.resolve(outDir) + path.sep), `write escaped outDir: ${rel}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("default outDir lands under the session directory", async () => {
    // Copy the session fixture to a temp dir so the default proposals/ write is isolated.
    const { root, session } = tmpSession("ac3-default");
    const result = await runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE });
    assert.equal(result.out_dir, path.join(session, "proposals"));
    assert.ok(fs.existsSync(path.join(session, "proposals", "README.md")));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("proposal output boundary", () => {
  test("rejects an outDir outside the session before it can write", async () => {
    const { root, session } = tmpSession("outside");
    const outside = path.join(root, "outside");
    await assert.rejects(
      () => runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir: outside }),
      /outDir must be a new descendant of sessionDir/,
    );
    assert.ok(!fs.existsSync(outside), "external output directory was not created");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects symlinked proposal parents without disclosing or writing outside the session", async () => {
    const { root, session } = tmpSession("symlink");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(session, "linked-proposals"));
    const outDir = path.join(session, "linked-proposals", "output");
    await assert.rejects(
      () => runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir }),
      /symbolic-link component/,
    );
    assert.deepEqual(fs.readdirSync(outside), [], "symlink target was not written");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects a symlinked session root before it can create proposals", async () => {
    const { root, session } = tmpSession("session-link");
    const linkedSession = path.join(root, "linked-session");
    fs.symlinkSync(session, linkedSession);
    await assert.rejects(
      () => runPromote({ sessionDir: linkedSession, repoRoot: CLEAN_REPO, provenance: PROVENANCE }),
      /sessionDir must not be a symbolic link/,
    );
    assert.ok(!fs.existsSync(path.join(session, "proposals")), "real session was not modified via symlink");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("refuses an existing output directory and regenerates unsafe learning ids", async () => {
    const { root, session } = tmpSession("exclusive");
    const outDir = path.join(session, "proposals");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "sentinel"), "unchanged");
    await assert.rejects(
      () => runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir }),
      /already exists; refusing to overwrite/,
    );
    assert.equal(fs.readFileSync(path.join(outDir, "sentinel"), "utf8"), "unchanged");

    const learningPath = path.join(session, "learning.json");
    const learning = JSON.parse(fs.readFileSync(learningPath, "utf8"));
    learning.records[0].id = "../../outside";
    fs.writeFileSync(learningPath, JSON.stringify(learning));
    const safeOut = path.join(session, "safe-proposals");
    const result = await runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir: safeOut });
    assert.ok(result.warnings.some((warning) => warning.includes("learning id was regenerated")));
    assert.ok(fs.readdirSync(path.join(safeOut, "learnings")).every((name) => !name.includes("outside")));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("concurrent writers reserve one output root and leave no staging or lock residue", async () => {
    const { root, session } = tmpSession("concurrent");
    const outDir = path.join(session, "proposals");
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir })),
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1, "exactly one writer publishes");
    assert.ok(attempts.filter((attempt) => attempt.status === "rejected").every(
      (attempt) => /already exists|promote\.lock/.test(String(attempt.reason)),
    ), "losing writers fail without replacing the published proposals");
    assert.ok(fs.existsSync(path.join(outDir, "README.md")), "the winning publication is complete");
    assert.deepEqual(
      fs.readdirSync(session).filter((name) => name.includes("promote-stage") || name.endsWith(".promote.lock")),
      [],
      "no staging directory or lock remains",
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a parent symlink swap at publication cannot redirect proposal writes", async () => {
    const { root, session } = tmpSession("swap");
    const parent = path.join(session, "publish-parent");
    const parked = path.join(session, "publish-parent-parked");
    const outside = path.join(root, "outside");
    fs.mkdirSync(parent);
    fs.mkdirSync(outside);
    const originalRename = fsDefault.renameSync;
    let swapped = false;
    fsDefault.renameSync = (from, to) => {
      if (!swapped && path.basename(from).startsWith(".promote-stage-") && path.basename(to) === "proposals") {
        swapped = true;
        originalRename(parent, parked);
        fs.symlinkSync(outside, parent);
        try {
          return originalRename(from, to);
        } finally {
          fs.unlinkSync(parent);
          originalRename(parked, parent);
        }
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      await runPromote({ sessionDir: session, repoRoot: CLEAN_REPO, provenance: PROVENANCE, outDir: path.join(parent, "proposals") });
    } catch {
      // A non-descriptor platform may fail closed when the swap invalidates its
      // physical-path identity check; either outcome must leave outside empty.
    } finally {
      fsDefault.renameSync = originalRename;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true, "test exercised a publication-time parent swap");
    assert.deepEqual(fs.readdirSync(outside), [], "no proposal file was written through the symlink");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("R1: the FlowDefinition is composable (true sub-flow nesting)", () => {
  test("promote.flow.json exports every gate claim so a parent uses_flow step resolves", () => {
    const flow = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "flows/promote.flow.json"), "utf8"));
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
