// #1312: the criterion-contract guard prescribed "revise criteria through a provenance-bearing
// planning operation" while refusing that exact operation — recordGateClaim's implementation-plan
// pass write calls readBundleState before it can re-anchor, so the guard died against the OLD
// anchor. The exemption applies ONLY to that write (the cursor-at-plan condition is enforced
// upstream: record-gate-claim refuses expectations absent from the current gate, so
// implementation-plan is only recordable at the plan step). Run: `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../build/src/cli.js");
const SIDECAR = path.resolve(__dirname, "../../build/src/cli/workflow-sidecar.js");
const SLUG = "wedge-reanchor-guard";
const WORK_ITEM = "wedge:reanchor-guard";

test("the plan re-record IS the provenance-bearing amendment channel; every other write stays strict", () => {
  // Golden-run fixture recipe: public start with the local-file provider, walk to plan via the
  // public evidence verb, then exercise the guard through the sidecar writer at the plan gate.
  const project = makeFixtureDir("reanchor-");
  try {
    const artifactRoot = path.join(project, ".kontourai", "flow-agents");
    const session = path.join(artifactRoot, SLUG);
    spawnSync("git", ["init", "-q", "."], { cwd: project });
    spawnSync("git", ["-C", project, "config", "user.email", "t@t"]);
    spawnSync("git", ["-C", project, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(project, ".gitignore"), ".kontourai/\n");
    spawnSync("git", ["-C", project, "add", ".gitignore"]);
    spawnSync("git", ["-C", project, "commit", "-qm", "fixture baseline"]);
    fs.mkdirSync(session, { recursive: true });
    const pullWork = path.join(session, `${SLUG}--pull-work.md`);
    const planWork = path.join(session, `${SLUG}--plan-work.md`);
    fs.writeFileSync(pullWork, `Selected Work Item: ${WORK_ITEM}\n`);
    fs.writeFileSync(planWork, "# Plan\n");
    const env = { ...process.env, FLOW_AGENTS_ACTOR: "reanchor-owner" };
    const publicCli = (args) => spawnSync(process.execPath, [CLI, "workflow", ...args], { cwd: project, encoding: "utf8", env });
    const sidecar = (args) => spawnSync(process.execPath, [SIDECAR, ...args], { cwd: project, encoding: "utf8", env });

    const started = publicCli(["start", "--artifact-root", artifactRoot, "--flow", "builder.build",
      "--work-item", WORK_ITEM, "--assignment-provider", "local-file",
      "--title", "Re-anchor guard fixture", "--summary", "Prove the amendment channel is executable.",
      "--criterion", "Contract A: the original criterion wording"]);
    assert.equal(started.status, 0, `start failed: ${started.stderr}`);

    const evidence = (expectation, file, extra = []) => publicCli(["evidence", "--session-dir", session,
      "--status", "pass", "--expectation", expectation, "--summary", `${expectation} pass`,
      "--evidence-ref-json", JSON.stringify({ kind: "artifact", file, summary: "producer artifact" }), ...extra]);
    for (const expectation of ["pickup-probe-readiness", "probe-decisions-or-accepted-gaps"]) {
      const step = evidence(expectation, pullWork);
      assert.equal(step.status, 0, `${expectation} failed: ${step.stderr}`);
    }

    // anchor contract A at the plan gate (via the sidecar writer — the guard under test)
    const planRef = JSON.stringify({ kind: "artifact", file: planWork, summary: "plan artifact" });
    const planRecord = (status) => sidecar(["record-gate-claim", session,
      "--expectation", "implementation-plan", "--status", status, "--summary", `plan ${status}`,
      "--evidence-ref-json", planRef]);
    const first = planRecord("pass");
    assert.equal(first.status, 0, `first plan record failed: ${first.stderr}`);

    // hand-amend the criteria (contract B): a non-reanchoring write must die on the strict path
    const acceptanceFile = path.join(session, "acceptance.json");
    const acceptance = JSON.parse(fs.readFileSync(acceptanceFile, "utf8"));
    acceptance.criteria[0].description = "Contract B: the amended truthful wording";
    fs.writeFileSync(acceptanceFile, JSON.stringify(acceptance, null, 2));
    const strict = planRecord("fail");
    assert.notEqual(strict.status, 0, "a failing plan record must not bypass the stale-anchor check");
    assert.match(strict.stderr, /criterion contract anchored by the implementation-plan claim/);

    // the prescribed operation itself must SUCCEED and re-anchor (the #1312 wedge)
    const reanchor = planRecord("pass");
    assert.equal(reanchor.status, 0, `the prescribed planning operation was refused (the #1312 wedge): ${reanchor.stderr}`);

    // after re-anchoring, writes against contract B are clean again
    const after = planRecord("pass");
    assert.equal(after.status, 0, `post-reanchor write failed: ${after.stderr}`);

    // the amendment is AUDITABLE: the surviving plan claim carries contract A as its predecessor
    // (digest + criteria + actor + timestamp), so a criteria swap can never look like a first
    // anchor. The follow-up same-contract re-record must PRESERVE the history, not drop it.
    const bundle = JSON.parse(fs.readFileSync(path.join(session, "trust.bundle"), "utf8"));
    const planClaims = bundle.claims.filter((claim) =>
      claim?.metadata?.gate_claim?.expectation_id === "implementation-plan");
    assert.equal(planClaims.length, 1, "one live plan claim after supersession");
    const history = planClaims[0].metadata?.acceptance_contract_history
      ?? planClaims[0].metadata?._acceptance_contract_history;
    assert.ok(Array.isArray(history) && history.length >= 1, `amendment history missing: ${JSON.stringify(Object.keys(planClaims[0].metadata ?? {}))}`);
    const predecessor = history[0].predecessor;
    assert.ok(predecessor?.criteria?.some((criterion) => String(criterion.description).includes("Contract A")),
      "predecessor contract A must remain traceable");
    assert.ok(history[0].superseded_by_actor, "amendment actor recorded");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
