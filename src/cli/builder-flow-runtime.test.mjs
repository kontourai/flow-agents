import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FLOW_RUN_EVIDENCE_MANIFEST_PATH, runDir } from "@kontourai/flow";
import {
  recoverBuilderFlowSession,
  startBuilderFlowSession,
  syncBuilderFlowSession,
} from "../../build/src/builder-flow-runtime.js";
import { main as builderRunMain } from "../../build/src/cli/builder-run.js";

const SUBJECT = "local:work-item/runtime-projection";
const NOW = "2026-07-09T20:00:00.000Z";

function makeSession(slug = "runtime-projection") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-runtime-"));
  const artifactRoot = path.join(projectRoot, ".kontourai", "flow-agents");
  const sessionDir = path.join(artifactRoot, slug);
  writeJson(path.join(sessionDir, "state.json"), {
    schema_version: "1.0",
    task_slug: slug,
    status: "planned",
    phase: "planning",
    updated_at: NOW,
    work_item_refs: [SUBJECT],
    next_action: { status: "continue", summary: "Start Builder." },
  });
  writeJson(path.join(artifactRoot, "current.json"), {
    active_slug: slug,
    artifact_dir: `.kontourai/flow-agents/${slug}`,
    updated_at: NOW,
  });
  return { projectRoot, artifactRoot, sessionDir, slug };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function snapshotFile(file) {
  return fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null;
}

function snapshotTree(directory) {
  if (!fs.existsSync(directory)) return null;
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push([path.relative(directory, absolute), fs.readFileSync(absolute).toString("base64")]);
    }
  }
  visit(directory);
  return files;
}

function snapshotProjectionTargets(session) {
  const actorRoot = path.join(session.artifactRoot, "current");
  const actors = fs.existsSync(actorRoot)
    ? fs.readdirSync(actorRoot).filter((name) => name.endsWith(".json")).sort()
    : [];
  return {
    state: snapshotFile(path.join(session.sessionDir, "state.json")),
    current: snapshotFile(path.join(session.artifactRoot, "current.json")),
    actors: actors.map((name) => [name, snapshotFile(path.join(actorRoot, name))]),
  };
}

async function assertRecoveryRejectsWithoutWrites(session, pattern) {
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const beforeProjection = snapshotProjectionTargets(session);
  await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), pattern);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
}

function bundleClaim({ expectation, claimType, subjectType, status = "pass", routeReason, subject = SUBJECT }) {
  const claimId = `claim.${expectation}`;
  return {
    claim: {
      id: claimId,
      subjectType,
      subjectId: `runtime-projection/gate-claim-${expectation}`,
      claimType,
      fieldOrBehavior: `${expectation} fixture`,
      value: status,
      metadata: {
        workflow_subject_ref: subject,
        gate_claim: {
          expectation_id: expectation,
          claim_type: claimType,
          subject_type: subjectType,
          ...(routeReason ? { route_reason: routeReason } : {}),
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    evidence: {
      id: `evidence.${expectation}`,
      claimId,
      evidenceType: "human_attestation",
      method: "attestation",
      sourceRef: "src/cli/builder-flow-runtime.test.mjs",
      excerptOrSummary: `${expectation} fixture`,
      observedAt: NOW,
      collectedBy: "flow-agents-test",
    },
    event: {
      id: `event.${expectation}`,
      claimId,
      status: status === "pass" ? "verified" : "disputed",
      actor: "flow-agents-test",
      method: "attestation",
      evidenceIds: [`evidence.${expectation}`],
      createdAt: NOW,
      verifiedAt: NOW,
    },
  };
}

function writeBundle(sessionDir, entries) {
  writeJson(path.join(sessionDir, "trust.bundle"), {
    schemaVersion: 5,
    source: "flow-agents-builder-runtime-test",
    claims: entries.map((entry) => entry.claim),
    evidence: entries.map((entry) => entry.evidence),
    policies: [],
    events: entries.map((entry) => entry.event),
  });
}

async function writeAndSync(session, entries) {
  writeBundle(session.sessionDir, entries);
  return syncBuilderFlowSession({ sessionDir: session.sessionDir });
}

test("small-model client can start and advance from projected actions without choosing Flow steps", async () => {
  const session = makeSession();
  const started = await startBuilderFlowSession({ sessionDir: session.sessionDir });

  assert.equal(started.run.state.current_step, "pull-work");
  assert.deepEqual(started.projection.next_action.skills, ["pull-work"]);
  assert.deepEqual(started.projection.next_action.operations, []);
  assert.equal(started.projection.next_action.command, `flow-agents builder-run sync --session-dir .kontourai/flow-agents/${session.slug}`);
  assert.ok(fs.existsSync(runDir(session.slug, session.projectRoot)));
  assert.ok(!fs.existsSync(path.join(session.projectRoot, ".flow", "runs")), "retired runtime path must not be created");

  const advanced = await writeAndSync(session, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);

  assert.equal(advanced.attached, true);
  assert.equal(advanced.run.state.current_step, "design-probe");
  assert.deepEqual(advanced.projection.next_action.skills, ["pickup-probe"]);
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "design-probe");

  const duplicate = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(duplicate.attached, false);
  assert.equal(duplicate.run.manifest.evidence.length, advanced.run.manifest.evidence.length);
});

test("wrong workflow subject is rejected before canonical Flow mutation", async () => {
  const session = makeSession("wrong-subject");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const beforeState = readJson(path.join(runDir(session.slug, session.projectRoot), "state.json"));
  const beforeManifest = readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
    subject: "local:work-item/other",
  })]);

  await assert.rejects(
    () => syncBuilderFlowSession({ sessionDir: session.sessionDir }),
    /workflow_subject_ref.*persisted run subject/,
  );
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), "state.json")), beforeState);
  assert.deepEqual(readJson(path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH)), beforeManifest);
});

test("failed verification projects Flow-owned route-back attempt and budget", async () => {
  const session = makeSession("route-back-projection");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  await writeAndSync(session, [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })]);
  await writeAndSync(session, [
    bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
    bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
  ]);
  await writeAndSync(session, [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })]);
  const verify = await writeAndSync(session, [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })]);
  assert.equal(verify.run.state.current_step, "verify");

  const routed = await writeAndSync(session, [bundleClaim({
    expectation: "tests-evidence",
    claimType: "builder.verify.tests",
    subjectType: "flow-step",
    status: "fail",
    routeReason: "implementation_defect",
  })]);

  assert.equal(routed.run.state.current_step, "execute");
  assert.equal(routed.projection.flow_run.route_back_attempt, 1);
  assert.equal(routed.projection.flow_run.route_back_max_attempts, 3);
  assert.match(routed.projection.next_action.summary, /Route-back history: attempt 1\/3 returned to `execute` for `implementation_defect`/);
  assert.deepEqual(routed.projection.next_action.skills, ["execute-plan"]);
});

test("verified sidecar claims drive the composed publish and learning prefix to completion", async () => {
  const session = makeSession("composed-completion");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const steps = [
    [bundleClaim({ expectation: "selected-work", claimType: "builder.pull-work.selected", subjectType: "work-item" })],
    [
      bundleClaim({ expectation: "pickup-probe-readiness", claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item" }),
      bundleClaim({ expectation: "probe-decisions-or-accepted-gaps", claimType: "builder.design-probe.decisions", subjectType: "decision" }),
    ],
    [bundleClaim({ expectation: "implementation-plan", claimType: "builder.plan.implementation", subjectType: "artifact" })],
    [bundleClaim({ expectation: "implementation-scope", claimType: "builder.execute.scope", subjectType: "change" })],
    [bundleClaim({ expectation: "tests-evidence", claimType: "builder.verify.tests", subjectType: "flow-step" })],
    [bundleClaim({ expectation: "merge-readiness", claimType: "builder.merge-ready.readiness", subjectType: "change" })],
  ];
  for (const entries of steps) await writeAndSync(session, entries);

  const prOpen = readJson(path.join(session.sessionDir, "state.json"));
  assert.equal(prOpen.flow_run.current_step, "pr-open");
  assert.deepEqual(prOpen.next_action.skills, []);
  assert.deepEqual(prOpen.next_action.operations, ["publish-change"]);

  await writeAndSync(session, [bundleClaim({ expectation: "pull-request-opened", claimType: "builder.pr-open.pull-request", subjectType: "pull-request" })]);
  await writeAndSync(session, [bundleClaim({ expectation: "ci-merge-readiness", claimType: "builder.merge-ready-ci.readiness", subjectType: "pull-request" })]);
  const completed = await writeAndSync(session, [
    bundleClaim({ expectation: "decision-evidence", claimType: "builder.learn.decisions", subjectType: "decision" }),
    bundleClaim({ expectation: "learning-evidence", claimType: "builder.learn.evidence", subjectType: "release" }),
  ]);

  assert.equal(completed.run.state.current_step, "learn", JSON.stringify(completed.run.state.gate_outcomes, null, 2));
  assert.equal(completed.run.state.status, "completed");
  assert.equal(completed.projection.status, "delivered");
  assert.deepEqual(completed.projection.next_action, { status: "done", summary: "Canonical Flow run is complete." });

  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const staleState = readJson(path.join(session.sessionDir, "state.json"));
  staleState.status = "in_progress";
  staleState.phase = "verification";
  staleState.next_action = { status: "continue", summary: "stale" };
  writeJson(path.join(session.sessionDir, "state.json"), staleState);
  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(recovered.attached, false);
  assert.equal(recovered.projection.status, "delivered");
  assert.equal(recovered.projection.phase, "done");
  assert.deepEqual(recovered.projection.next_action, { status: "done", summary: "Canonical Flow run is complete." });
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
});

test("recovery loads the slug-bound run, restores every matching projection, and preserves every Flow byte", async () => {
  const session = makeSession("recover-active");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const advanced = await writeAndSync(session, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);
  assert.equal(advanced.run.state.current_step, "design-probe");

  writeJson(path.join(session.artifactRoot, "current", "codex.json"), {
    active_slug: session.slug,
    active_step_id: "stale-step",
    updated_at: NOW,
  });
  writeJson(path.join(session.artifactRoot, "current", "other.json"), {
    active_slug: "another-session",
    active_step_id: "untouched-step",
    updated_at: NOW,
  });
  const staleState = readJson(path.join(session.sessionDir, "state.json"));
  staleState.status = "planned";
  staleState.phase = "planning";
  staleState.flow_run.current_step = "pull-work";
  staleState.next_action = { status: "continue", summary: "stale" };
  writeJson(path.join(session.sessionDir, "state.json"), staleState);
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const beforeOther = snapshotFile(path.join(session.artifactRoot, "current", "other.json"));
  const bundleBefore = snapshotFile(path.join(session.sessionDir, "trust.bundle"));

  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });

  assert.equal(recovered.attached, false);
  assert.equal(recovered.run.runId, session.slug);
  assert.equal(recovered.projection.flow_run.current_step, "design-probe");
  assert.equal(recovered.projection.phase, advanced.projection.phase);
  assert.deepEqual(recovered.projection.flow_run.open_gate_ids, advanced.projection.flow_run.open_gate_ids);
  assert.deepEqual(recovered.projection.next_action.skills, ["pickup-probe"]);
  assert.equal(readJson(path.join(session.artifactRoot, "current.json")).active_step_id, "design-probe");
  assert.equal(readJson(path.join(session.artifactRoot, "current", "codex.json")).active_step_id, "design-probe");
  assert.equal(snapshotFile(path.join(session.artifactRoot, "current", "other.json")), beforeOther);
  assert.equal(snapshotFile(path.join(session.sessionDir, "trust.bundle")), bundleBefore);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
});

test("recovery fails before any write for invalid Work Item cardinality and Flow subject bindings", async (t) => {
  const cases = [
    ["zero refs", [], /state\.work_item_refs.*exactly one/],
    ["empty ref", [""], /state\.work_item_refs.*exactly one/],
    ["blank ref", ["   "], /state\.work_item_refs.*exactly one/],
    ["two refs", [SUBJECT, "local:work-item/other"], /state\.work_item_refs.*exactly one/],
  ];
  for (const [name, refs, pattern] of cases) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-")}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const state = readJson(path.join(session.sessionDir, "state.json"));
      state.work_item_refs = refs;
      writeJson(path.join(session.sessionDir, "state.json"), state);
      await assertRecoveryRejectsWithoutWrites(session, pattern);
    });
  }

  await t.test("persisted state subject mismatch", async () => {
    const session = makeSession("recover-state-subject-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const file = path.join(runDir(session.slug, session.projectRoot), "state.json");
    const state = readJson(file);
    state.subject = "local:work-item/other";
    writeJson(file, state);
    await assertRecoveryRejectsWithoutWrites(session, /flow_run\.state\.subject.*selected Work Item/);
  });

  await t.test("persisted params subject mismatch", async () => {
    const session = makeSession("recover-params-subject-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const file = path.join(runDir(session.slug, session.projectRoot), "state.json");
    const state = readJson(file);
    state.params.subject = "local:work-item/other";
    writeJson(file, state);
    await assertRecoveryRejectsWithoutWrites(session, /flow_run\.state\.params\.subject.*selected Work Item/);
  });

  await t.test("absent persisted params subject is allowed", async () => {
    const session = makeSession("recover-params-subject-absent");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const flowDirectory = runDir(session.slug, session.projectRoot);
    const file = path.join(flowDirectory, "state.json");
    const state = readJson(file);
    delete state.params.subject;
    writeJson(file, state);
    const beforeFlow = snapshotTree(flowDirectory);
    const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
    assert.equal(recovered.attached, false);
    assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  });
});

test("recovery fails closed for invalid sidecars and missing or corrupt canonical runs", async (t) => {
  await t.test("invalid session path", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-invalid-session-"));
    await assert.rejects(
      () => recoverBuilderFlowSession({ sessionDir: path.join(projectRoot, "not-a-session") }),
      /sessionDir.*must be \.kontourai\/flow-agents/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, ".kontourai")), false);
  });

  await t.test("missing run remains missing", async () => {
    const session = makeSession("recover-missing-run");
    await assertRecoveryRejectsWithoutWrites(session, /not_found|not found/i);
    assert.equal(fs.existsSync(runDir(session.slug, session.projectRoot)), false);
  });

  await t.test("task slug mismatch", async () => {
    const session = makeSession("recover-task-slug-mismatch");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const state = readJson(path.join(session.sessionDir, "state.json"));
    state.task_slug = "other";
    writeJson(path.join(session.sessionDir, "state.json"), state);
    await assertRecoveryRejectsWithoutWrites(session, /task_slug.*match/);
  });

  await t.test("missing sidecar state", async () => {
    const session = makeSession("recover-missing-sidecar-state");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    fs.rmSync(path.join(session.sessionDir, "state.json"));
    await assertRecoveryRejectsWithoutWrites(session, /sessionDir.*state\.json/);
  });

  await t.test("corrupt sidecar state", async () => {
    const session = makeSession("recover-corrupt-sidecar-state");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    fs.writeFileSync(path.join(session.sessionDir, "state.json"), "not-json\n");
    await assertRecoveryRejectsWithoutWrites(session, /JSON|parse|Unexpected/i);
  });

  for (const [name, relativeFile] of [
    ["corrupt Flow state", "state.json"],
    ["corrupt Flow manifest", FLOW_RUN_EVIDENCE_MANIFEST_PATH],
  ]) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-").toLowerCase()}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      fs.writeFileSync(path.join(runDir(session.slug, session.projectRoot), relativeFile), "not-json\n");
      await assertRecoveryRejectsWithoutWrites(session, /JSON|parse|invalid|Unexpected/i);
    });
  }

  for (const [name, mutate] of [
    ["foreign definition identity", (definition) => { definition.id = "foreign.build"; }],
    ["foreign definition content", (definition) => { definition.steps[0].description = "foreign content"; }],
  ]) {
    await t.test(name, async () => {
      const session = makeSession(`recover-${name.replaceAll(" ", "-")}`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const file = path.join(runDir(session.slug, session.projectRoot), "definition.json");
      const definition = readJson(file);
      mutate(definition);
      writeJson(file, definition);
      await assertRecoveryRejectsWithoutWrites(session, /definition|foreign|canonical|identity|content|invalid/i);
    });
  }
});

test("recover and sync remain separate: recovery leaves bundle unattached and sync evaluates it", async () => {
  const session = makeSession("recover-then-sync");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  writeBundle(session.sessionDir, [bundleClaim({
    expectation: "selected-work",
    claimType: "builder.pull-work.selected",
    subjectType: "work-item",
  })]);
  const manifestFile = path.join(runDir(session.slug, session.projectRoot), FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifestBefore = snapshotFile(manifestFile);

  const recovered = await recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(recovered.attached, false);
  assert.equal(snapshotFile(manifestFile), manifestBefore);
  assert.equal(recovered.run.state.current_step, "pull-work");

  const synced = await syncBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(synced.attached, true);
  assert.equal(synced.run.state.current_step, "design-probe");
  assert.notEqual(snapshotFile(manifestFile), manifestBefore);
});

test("builder-run recover accepts only a session directory and rejects caller-selected identity", async () => {
  const session = makeSession("recover-cli");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir]), 0);
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir, "--run-id", "other"]), 64);
  assert.equal(await builderRunMain(["recover", "--session-dir", session.sessionDir, "--step-id", "verify"]), 64);
  assert.equal(await builderRunMain(["recover", "extra", "--session-dir", session.sessionDir]), 64);
});

test("recovery refuses a sidecar changed after its immutable subject snapshot", async () => {
  const session = makeSession("recover-sidecar-race");
  await startBuilderFlowSession({ sessionDir: session.sessionDir });
  const flowDirectory = runDir(session.slug, session.projectRoot);
  const beforeFlow = snapshotTree(flowDirectory);
  const recovery = recoverBuilderFlowSession({ sessionDir: session.sessionDir });
  const changed = readJson(path.join(session.sessionDir, "state.json"));
  changed.work_item_refs = ["local:work-item/raced"];
  writeJson(path.join(session.sessionDir, "state.json"), changed);
  const beforeProjection = snapshotProjectionTargets(session);

  await assert.rejects(() => recovery, /state\.json.*changed during recovery/);
  assert.deepEqual(snapshotTree(flowDirectory), beforeFlow);
  assert.deepEqual(snapshotProjectionTargets(session), beforeProjection);
});

test("recovery parses every projection target before writing any target", async (t) => {
  for (const target of ["global", "actor"]) {
    await t.test(`malformed ${target} pointer`, async () => {
      const session = makeSession(`recover-malformed-${target}-pointer`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const state = readJson(path.join(session.sessionDir, "state.json"));
      state.next_action = { status: "continue", summary: "stale projection" };
      writeJson(path.join(session.sessionDir, "state.json"), state);
      const pointer = target === "global"
        ? path.join(session.artifactRoot, "current.json")
        : path.join(session.artifactRoot, "current", "codex.json");
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, "not-json\n");
      await assertRecoveryRejectsWithoutWrites(session, /projection target.*JSON|JSON|parse|Unexpected/i);
    });
  }
});

test("recovery rejects symlinked session and projection targets before writes", async (t) => {
  await t.test("session directory symlink", async () => {
    const session = makeSession("recover-session-symlink");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const target = path.join(session.artifactRoot, "recover-session-symlink-target");
    fs.renameSync(session.sessionDir, target);
    fs.symlinkSync(target, session.sessionDir, "dir");
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeState = snapshotFile(path.join(target, "state.json"));
    await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /sessionDir.*symbolic link/);
    assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
    assert.equal(snapshotFile(path.join(target, "state.json")), beforeState);
  });

  await t.test("state.json symlink", async () => {
    const session = makeSession("recover-state-symlink");
    await startBuilderFlowSession({ sessionDir: session.sessionDir });
    const stateFile = path.join(session.sessionDir, "state.json");
    const target = path.join(session.sessionDir, "state-target.json");
    fs.renameSync(stateFile, target);
    fs.symlinkSync(target, stateFile);
    const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
    const beforeTarget = snapshotFile(target);
    await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /state\.json.*symbolic link/);
    assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
    assert.equal(snapshotFile(target), beforeTarget);
  });

  for (const targetKind of ["global pointer", "actor pointer", "dangling actor pointer", "actor directory"]) {
    await t.test(targetKind, async () => {
      const session = makeSession(`recover-${targetKind.replaceAll(" ", "-")}-symlink`);
      await startBuilderFlowSession({ sessionDir: session.sessionDir });
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-builder-pointer-symlink-"));
      const externalPointer = path.join(externalRoot, "current.json");
      writeJson(externalPointer, { active_slug: session.slug, active_step_id: "stale", updated_at: NOW });
      if (targetKind === "global pointer") {
        fs.rmSync(path.join(session.artifactRoot, "current.json"));
        fs.symlinkSync(externalPointer, path.join(session.artifactRoot, "current.json"));
      } else if (targetKind === "actor pointer" || targetKind === "dangling actor pointer") {
        const actorRoot = path.join(session.artifactRoot, "current");
        fs.mkdirSync(actorRoot, { recursive: true });
        fs.symlinkSync(targetKind === "dangling actor pointer" ? path.join(externalRoot, "missing.json") : externalPointer, path.join(actorRoot, "codex.json"));
      } else {
        fs.symlinkSync(externalRoot, path.join(session.artifactRoot, "current"), "dir");
      }
      const beforeFlow = snapshotTree(runDir(session.slug, session.projectRoot));
      const beforeState = snapshotFile(path.join(session.sessionDir, "state.json"));
      const beforeExternal = snapshotFile(externalPointer);
      await assert.rejects(() => recoverBuilderFlowSession({ sessionDir: session.sessionDir }), /current.*symbolic link|projection target.*symbolic link/);
      assert.deepEqual(snapshotTree(runDir(session.slug, session.projectRoot)), beforeFlow);
      assert.equal(snapshotFile(path.join(session.sessionDir, "state.json")), beforeState);
      assert.equal(snapshotFile(externalPointer), beforeExternal);
    });
  }
});
