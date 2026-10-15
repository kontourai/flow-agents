import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { defaultFlowConfig, startRun } from "@kontourai/flow";
import { reclaimBuilderWorktree } from "../../build/src/cli/worktree-reclaim.js";
import { resolveEffectiveFlowDefinition } from "../../build/src/lib/flow-resolver.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

test("reclaim removes only the clean merged linked worktree, retains its branch, and persists a receipt", async () => {
  const fixture = await makeFixture();
  try {
    const receipt = await reclaimBuilderWorktree(fixture.sessionDir, {
      observeMergedChange: async ({ expected }) => ({
        state: "merged",
        mergeSha: "b".repeat(40),
        headSha: expected.headSha,
        headRef: expected.headRef,
        baseRef: expected.baseRef,
        providerActor: expected.providerActor,
        observedAt: "2026-07-23T23:00:00.000Z",
      }),
      now: () => "2026-07-23T23:01:00.000Z",
    });
    assert.equal(receipt.outcome, "reclaimed");
    assert.equal(fs.existsSync(fixture.worktree), false);
    assert.equal(git(fixture.primary, "show-ref", "--verify", "--quiet", "refs/heads/feature"), "");
    const receipts = path.join(fixture.primary, ".kontourai", "flow-agents", "worktree-reclaims");
    const files = fs.readdirSync(receipts);
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(receipts, files[0]), "utf8"));
    assert.deepEqual(stored, receipt);
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(fixture.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim can finish when the invoking process starts inside the worktree being removed", async () => {
  const fixture = await makeFixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve("build/src/cli/worktree-reclaim.js")).href;
    const script = `
      import { reclaimBuilderWorktree } from ${JSON.stringify(moduleUrl)};
      const receipt = await reclaimBuilderWorktree(process.argv[1], {
        observeMergedChange: async ({ expected }) => ({
          state: "merged", mergeSha: "d".repeat(40), headSha: expected.headSha,
          headRef: expected.headRef, baseRef: expected.baseRef,
          providerActor: expected.providerActor, observedAt: "2026-07-23T23:00:00.000Z"
        })
      });
      process.stdout.write(JSON.stringify(receipt));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, fixture.sessionDir], {
      cwd: fixture.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(output).outcome, "reclaimed");
    assert.equal(fs.existsSync(fixture.worktree), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim refuses dirty worktrees before provider observation", async () => {
  const fixture = await makeFixture();
  let observations = 0;
  try {
    fs.writeFileSync(path.join(fixture.worktree, "dirty.txt"), "not committed\n");
    await assert.rejects(
      reclaimBuilderWorktree(fixture.sessionDir, {
        observeMergedChange: async () => {
          observations += 1;
          throw new Error("should not observe");
        },
      }),
      /refuses a dirty worktree/,
    );
    assert.equal(observations, 0);
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reclaim refuses before accepted learning evidence", async () => {
  const fixture = await makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.sessionDir, "trust.bundle"), JSON.stringify({ schemaVersion: 5, claims: [] }));
    await assert.rejects(
      reclaimBuilderWorktree(fixture.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires only accepted current builder\.learn\.decisions/,
    );
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const merged = async ({ expected }) => ({
  state: "merged", mergeSha: "c".repeat(40), headSha: expected.headSha, headRef: expected.headRef,
  baseRef: expected.baseRef, providerActor: expected.providerActor, observedAt: "2026-07-23T23:00:00.000Z",
});

test("reclaim requires the learning claims a non-Builder kit's closing gate declares, not Builder's", async () => {
  // Accepted: the kit's own closeout claims, with no builder.learn.* claim anywhere.
  const accepted = await makeFixture({
    definition: acmeDeliveryDefinition(),
    claims: [
      { claimType: "acme.closeout.notes", status: "verified" },
      { claimType: "acme.closeout.retro", status: "verified" },
    ],
  });
  try {
    const receipt = await reclaimBuilderWorktree(accepted.sessionDir, { observeMergedChange: merged });
    assert.equal(receipt.outcome, "reclaimed");
  } finally {
    fs.rmSync(accepted.root, { recursive: true, force: true });
  }
  // Refused: Builder's learning claims do not satisfy another kit's closing gate.
  const builderClaims = await makeFixture({ definition: acmeDeliveryDefinition() });
  try {
    await assert.rejects(
      reclaimBuilderWorktree(builderClaims.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires only accepted current acme\.closeout\.notes learning evidence/,
    );
    assert.equal(fs.existsSync(builderClaims.worktree), true);
  } finally {
    fs.rmSync(builderClaims.root, { recursive: true, force: true });
  }
  // Refused: the kit declares only "verified", so a "trusted" claim Builder would accept is not enough.
  const trusted = await makeFixture({
    definition: acmeDeliveryDefinition(),
    claims: [
      { claimType: "acme.closeout.notes", status: "trusted" },
      { claimType: "acme.closeout.retro", status: "verified" },
    ],
  });
  try {
    await assert.rejects(
      reclaimBuilderWorktree(trusted.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires only accepted current acme\.closeout\.notes learning evidence/,
    );
  } finally {
    fs.rmSync(trusted.root, { recursive: true, force: true });
  }
});

test("reclaim enforces required closeout expectations from Flow project overrides", async () => {
  const definition = acmeDeliveryDefinition();
  const closing = definition.gates["acme.closeout:closing-gate"];
  const extra = { ...structuredClone(closing.expects[0]), id: "project-retention", required: false,
    bundle_claim: { claimType: "acme.closeout.retention", accepted_statuses: ["verified"] } };
  closing.expects.push(extra);
  const config = { ...defaultFlowConfig(), gate_overrides: {
    "acme.closeout:closing-gate": { expectations: { "project-retention": { required: true } } },
  } };
  const ordinaryClaims = [
    { claimType: "acme.closeout.notes", status: "verified" },
    { claimType: "acme.closeout.retro", status: "verified" },
  ];
  const missing = await makeFixture({ definition, flowConfig: config, claims: ordinaryClaims });
  try {
    await assert.rejects(reclaimBuilderWorktree(missing.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires only accepted current acme\.closeout\.retention learning evidence/);
    assert.equal(fs.existsSync(missing.worktree), true);
  } finally { fs.rmSync(missing.root, { recursive: true, force: true }); }
  const complete = await makeFixture({ definition, flowConfig: config, claims: [...ordinaryClaims, { claimType: "acme.closeout.retention", status: "verified" }] });
  try {
    const receipt = await reclaimBuilderWorktree(complete.sessionDir, { observeMergedChange: merged });
    assert.equal(receipt.outcome, "reclaimed");
    assert.equal(fs.existsSync(complete.worktree), false);
  } finally { fs.rmSync(complete.root, { recursive: true, force: true }); }
});

test("reclaim refuses when the run's definition cannot name its learning evidence", async () => {
  // A closing gate with no required trust-bundle claim gives reclaim nothing to check: refuse.
  const definition = acmeDeliveryDefinition();
  definition.gates["acme.closeout:closing-gate"].expects = definition.gates["acme.closeout:closing-gate"].expects
    .map((expectation) => ({ ...expectation, required: false }));
  const undeclared = await makeFixture({ definition });
  try {
    await assert.rejects(
      reclaimBuilderWorktree(undeclared.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /terminal gate to declare required learning evidence; acme\.deliver declares none/,
    );
  } finally {
    fs.rmSync(undeclared.root, { recursive: true, force: true });
  }
  // No canonical run beside the session: refuse rather than skip the learning check.
  const missing = await makeFixture();
  try {
    fs.rmSync(path.join(missing.worktree, ".kontourai", "flow"), { recursive: true, force: true });
    await assert.rejects(
      reclaimBuilderWorktree(missing.sessionDir, { observeMergedChange: async () => { throw new Error("should not observe"); } }),
      /requires the session's canonical Flow run definition/,
    );
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
  }
});

/**
 * A non-Builder delivery flow in the real composed-definition shape: Builder's own resolved
 * builder.build definition with the flow id and the closing gate's claim types renamed, as a kit
 * that ships its own closeout gate would declare them.
 */
function acmeDeliveryDefinition() {
  const definition = structuredClone(builderBuildDefinition());
  definition.id = "acme.deliver";
  const terminal = definition.steps.find((step) => step.next === null);
  const [closingGateId] = Object.entries(definition.gates).find(([, gate]) => gate.step === terminal.id);
  const closing = definition.gates[closingGateId];
  delete definition.gates[closingGateId];
  closing.expects = closing.expects.map((expectation, index) => ({
    ...expectation,
    bundle_claim: { ...expectation.bundle_claim, claimType: ["acme.closeout.notes", "acme.closeout.retro"][index], accepted_statuses: ["verified"] },
  }));
  definition.gates["acme.closeout:closing-gate"] = closing;
  return definition;
}

function builderBuildDefinition() {
  const definition = resolveEffectiveFlowDefinition("builder.build", process.cwd(), { allowOverride: false });
  assert.ok(definition, "the fixture requires the packaged Builder definition");
  return definition;
}

async function makeFixture({ definition = builderBuildDefinition(), claims, flowConfig } = {}) {
  const root = makeFixtureDir("flow-agents-reclaim-");
  const primary = path.join(root, "repo");
  const worktree = path.join(root, "repo-worktrees", "feature");
  fs.mkdirSync(primary, { recursive: true });
  git(primary, "init", "-b", "main");
  git(primary, "config", "user.email", "fixture@example.test");
  git(primary, "config", "user.name", "Fixture");
  git(primary, "remote", "add", "origin", "git@github.com:acme/example.git");
  fs.mkdirSync(path.join(primary, "context", "settings"), { recursive: true });
  fs.writeFileSync(path.join(primary, ".gitignore"), ".kontourai/\n");
  fs.writeFileSync(path.join(primary, "context", "settings", "change-provider-settings.json"), JSON.stringify({
    schema_version: "1.0",
    defaults: {
      provider: {
        role: "ChangeProvider",
        kind: "github",
        repository: { owner: "acme", name: "example" },
        capabilities: ["change.create", "change.observe"],
        executor: "gh-cli",
      },
    },
  }));
  if (flowConfig) {
    fs.mkdirSync(path.join(primary, ".flow"), { recursive: true });
    fs.writeFileSync(path.join(primary, ".flow", "config.json"), JSON.stringify(flowConfig));
  }
  fs.writeFileSync(path.join(primary, "base.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(primary, "worktree", "add", "-b", "feature", worktree);
  fs.writeFileSync(path.join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");
  const headSha = git(worktree, "rev-parse", "HEAD").trim();
  const sessionDir = path.join(worktree, ".kontourai", "flow-agents", "fixture");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "trust.bundle"), JSON.stringify({
    schemaVersion: 5,
    claims: claims ?? [
      { claimType: "builder.learn.decisions", status: "verified" },
      { claimType: "builder.learn.evidence", status: "verified" },
    ],
  }));
  // The canonical Flow run the session belongs to: reclaim reads its learning requirement from the
  // run's effective definition, so the fixture starts a real run rather than hand-writing state.
  const definitionFile = path.join(worktree, ".kontourai", `${definition.id}.start.json`);
  fs.writeFileSync(definitionFile, JSON.stringify(definition));
  await startRun(definitionFile, { cwd: worktree, runId: "fixture", params: { subject: "acme/example#42" } });
  fs.writeFileSync(path.join(sessionDir, "publish-change.result.json"), JSON.stringify({
    schema_version: "1.0",
    operation: "publish-change",
    repository: { owner: "acme", name: "example" },
    provider: { kind: "github", configuration_id: "fixture", adapter: "github-gh-cli" },
    change_ref: {
      provider_record_id: "PR_fixture",
      number: 42,
      url: "https://github.com/acme/example/pull/42",
      state: "open",
      base_ref: "main",
      head_ref: "feature",
      head_sha: headSha,
    },
    provider_actor: "fixture-actor",
  }));
  return { root, primary, worktree, sessionDir };
}

function git(cwd, ...argv) {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...argv], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
