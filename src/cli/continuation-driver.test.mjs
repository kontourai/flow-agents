import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { ContinuationAdapterTimeoutError, createFileContinuationStore, runContinuationDriver, withContinuationDriverLock } from "../../build/src/continuation-driver.js";
import { executeContinuationAdapter, executeLoadedContinuationAdapter, loadContinuationAdapterCommand, waitForContinuationBarrier } from "../../build/src/cli/continuation-adapter.js";

const require = createRequire(import.meta.url);
const activeTurnAuthority = require("../../scripts/hooks/lib/continuation-turn-authority.js");
const stopGoalFit = require("../../scripts/hooks/stop-goal-fit.js");
const authorityActorStruct = { runtime: "test", session_id: "authority", host: "localhost", human: null };

function snapshot(step, status = "active") {
  const disposition = status === "completed" || status === "canceled"
    ? "done"
    : status === "failed"
      ? "failed"
      : status === "paused" || status === "needs_decision"
        ? "waiting"
        : "continue";
  return {
    run_id: "run-251",
    definition_id: "builder.build",
    status,
    disposition,
    current_step: step,
    next_action: status === "active"
      ? { status: "continue", summary: `Execute ${step}`, skills: [`skill-${step}`], operations: [] }
      : { status: "done", summary: "Workflow complete" },
  };
}

function memoryStore(initial = null) {
  let value = initial;
  const events = [];
  return {
    load: () => value,
    save: (next) => { value = structuredClone(next); },
    append: (event) => { events.push(structuredClone(event)); },
    value: () => value,
    events,
  };
}

function writeAuthorityAssignment(sessionDir, actorKey, extra = {}) {
  const slug = path.basename(sessionDir);
  const assignment = path.join(path.dirname(sessionDir), "assignment", `${slug}.json`);
  fs.mkdirSync(path.dirname(assignment), { recursive: true });
  fs.writeFileSync(assignment, JSON.stringify({
    schema_version: "1.0",
    role: "AssignmentClaimRecord",
    subject_id: slug,
    actor: authorityActorStruct,
    actor_key: actorKey,
    artifact_dir: slug,
    status: "claimed",
    ...extra,
  }));
}

function bindAuthoritySigner(sessionDir, issued) {
  const missionFile = path.join(sessionDir, "continuation-driver", "state.json");
  const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
  fs.writeFileSync(missionFile, JSON.stringify({ ...mission, active_turn_public_key_digest: issued.publicKeyDigest }));
}

function canonicalBytes(value) {
  const canonicalize = (entry) => Array.isArray(entry)
    ? entry.map(canonicalize)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonicalize(entry[key])]))
      : entry;
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

test("driver advances multiple canonical Flow steps without a human continuation", async () => {
  const states = [snapshot("plan"), snapshot("execute"), snapshot("done", "completed")];
  let index = 0;
  const requests = [];
  const store = memoryStore();

  const result = await runContinuationDriver({
    maxTurns: 4,
    store,
    runtime: {
      inspect: async () => states[index],
      synchronize: async () => states[index],
      execute: async (request) => {
        requests.push(request);
        index += 1;
        return { status: "completed", summary: "turn complete" };
      },
    },
  });

  assert.equal(result.outcome, "done");
  assert.equal(result.turns_started, 2);
  assert.deepEqual(requests.map((request) => request.current_step), ["plan", "execute"]);
  assert.deepEqual(requests.map((request) => request.next_action.skills), [["skill-plan"], ["skill-execute"]]);
  assert.equal(requests.some((request) => Object.hasOwn(request, "system_prompt")), false);
  assert.equal(store.value().status, "done");
});

test("driver parks on a wait barrier without burning another turn and resumes durably", async () => {
  const barrier = { kind: "deadline", at: "2026-07-12T12:00:00.000Z" };
  const store = memoryStore();
  let executeCalls = 0;
  let ready = false;
  const runtime = {
    inspect: async () => snapshot("verify"),
    synchronize: async () => ready ? snapshot("done", "completed") : snapshot("verify"),
    execute: async () => {
      executeCalls += 1;
      return { status: "wait", barrier, summary: "waiting for CI" };
    },
  };

  const parked = await runContinuationDriver({
    maxTurns: 3,
    store,
    runtime,
    waitForBarrier: async () => "pending",
  });

  assert.equal(parked.outcome, "waiting");
  assert.equal(parked.turns_started, 1);
  assert.deepEqual(store.value().pending_barrier, barrier);
  assert.equal(executeCalls, 1);

  ready = true;
  const resumed = await runContinuationDriver({
    maxTurns: 3,
    store,
    runtime,
    waitForBarrier: async () => "ready",
  });

  assert.equal(resumed.outcome, "done");
  assert.equal(resumed.turns_started, 1);
  assert.equal(executeCalls, 1);
  assert.equal(store.value().pending_barrier, null);
  assert.ok(store.events.some((event) => event.type === "parked"));
  assert.ok(store.events.some((event) => event.type === "resumed"));
});

test("driver parks and resumes within one unattended invocation when its trigger fires", async () => {
  const barrier = { kind: "deadline", at: "2026-07-12T12:00:01.000Z" };
  const store = memoryStore();
  let ready = false;
  let executeCalls = 0;
  const result = await runContinuationDriver({
    maxTurns: 2,
    store,
    runtime: {
      inspect: async () => snapshot("verify"),
      synchronize: async () => ready ? snapshot("done", "completed") : snapshot("verify"),
      execute: async () => {
        executeCalls += 1;
        return { status: "wait", barrier, summary: "waiting for trigger" };
      },
    },
    waitForBarrier: async () => {
      ready = true;
      return "ready";
    },
  });

  assert.equal(result.outcome, "done");
  assert.equal(result.turns_started, 1);
  assert.equal(executeCalls, 1);
  assert.deepEqual(store.events.filter((event) => event.type === "parked" || event.type === "resumed").map((event) => event.type), ["parked", "resumed"]);
});

test("driver stops cleanly when the mission turn budget is exhausted", async () => {
  const store = memoryStore();
  let executeCalls = 0;
  const runtime = {
    inspect: async () => snapshot("plan"),
    synchronize: async () => snapshot("plan"),
    execute: async () => {
      executeCalls += 1;
      return { status: "completed" };
    },
  };

  const first = await runContinuationDriver({ maxTurns: 2, store, runtime });
  assert.equal(first.outcome, "budget_exhausted");
  assert.equal(first.turns_started, 2);
  assert.equal(executeCalls, 2);

  const resumed = await runContinuationDriver({ maxTurns: 2, store, runtime });
  assert.equal(resumed.outcome, "budget_exhausted");
  assert.equal(resumed.turns_started, 2);
  assert.equal(executeCalls, 2);
  assert.equal(store.value().status, "budget_exhausted");
});

test("driver refuses to change a persisted mission budget on resume", async () => {
  const store = memoryStore();
  const runtime = {
    inspect: async () => snapshot("plan"),
    synchronize: async () => snapshot("plan"),
    execute: async () => ({ status: "completed" }),
  };

  await runContinuationDriver({ maxTurns: 1, store, runtime });
  await assert.rejects(
    runContinuationDriver({ maxTurns: 2, store, runtime }),
    /does not match the persisted mission budget 1/,
  );
});

test("canonical completion clears a stale barrier without waiting", async () => {
  const store = memoryStore({
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    max_turns: 3,
    adapter_command_identity: null,
    status: "waiting",
    turns_started: 1,
    pending_barrier: { kind: "pid", pid: process.pid },
    updated_at: "2026-07-12T12:00:00.000Z",
  });
  let waitCalls = 0;

  const result = await runContinuationDriver({
    maxTurns: 3,
    store,
    runtime: {
      inspect: async () => snapshot("done", "completed"),
      synchronize: async () => assert.fail("terminal inspection must not synchronize"),
      execute: async () => assert.fail("terminal inspection must not execute"),
    },
    waitForBarrier: async () => {
      waitCalls += 1;
      return "pending";
    },
  });

  assert.equal(result.outcome, "done");
  assert.equal(waitCalls, 0);
  assert.equal(store.value().pending_barrier, null);
});

test("adapter completion cannot declare the workflow done while canonical Flow remains active", async () => {
  const store = memoryStore();
  const runtime = {
    inspect: async () => snapshot("plan"),
    synchronize: async () => snapshot("plan"),
    execute: async () => ({ status: "completed", summary: "I am done" }),
  };

  const result = await runContinuationDriver({ maxTurns: 1, store, runtime });
  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(result.snapshot.status, "active");
});

test("adapter errors fail open to another bounded turn and remain auditable", async () => {
  const store = memoryStore();
  let executeCalls = 0;
  const result = await runContinuationDriver({
    maxTurns: 2,
    store,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => {
        executeCalls += 1;
        throw new Error("runtime unavailable");
      },
    },
  });

  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(executeCalls, 2);
  assert.deepEqual(store.events.filter((event) => event.type === "turn_failed").map((event) => event.summary), [
    "runtime unavailable",
    "runtime unavailable",
  ]);
  assert.deepEqual(store.events.filter((event) => event.type === "turn_failed").map((event) => event.failure_kind), ["adapter_error", "adapter_error"]);
});

test("authority cleanup failures are audited and cannot replace the adapter outcome", async () => {
  const store = memoryStore();
  const result = await runContinuationDriver({
    maxTurns: 1,
    store,
    issueTurnAuthority: async () => ({
      runId: "run-251",
      turnSecret: "a".repeat(43),
      publicKeyDigest: "a".repeat(64),
      cleanup: () => { throw new Error("authority cleanup failed"); },
    }),
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => ({ status: "completed", summary: "adapter result survives cleanup" }),
    },
  });

  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(store.value().active_turn_step, null);
  assert.equal(store.value().active_turn_public_key_digest, null);
  assert.equal(store.events.find((event) => event.type === "authority_cleanup_failed")?.summary, "authority cleanup failed");
});

test("false authority cleanup results are audited and cannot replace the adapter outcome", async () => {
  const store = memoryStore();
  const result = await runContinuationDriver({
    maxTurns: 1,
    store,
    issueTurnAuthority: async () => ({
      runId: "run-251",
      turnSecret: "a".repeat(43),
      publicKeyDigest: "a".repeat(64),
      cleanup: () => false,
    }),
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => ({ status: "completed", summary: "adapter result survives cleanup" }),
    },
  });

  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(store.value().active_turn_step, null);
  assert.equal(store.value().active_turn_public_key_digest, null);
  assert.equal(store.events.find((event) => event.type === "authority_cleanup_failed")?.summary, "continuation turn authority cleanup returned false");
});

test("terminal synchronization after an adapter error preserves the canonical done state", async () => {
  const store = memoryStore();
  let synchronizations = 0;
  const result = await runContinuationDriver({
    maxTurns: 2,
    store,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => ++synchronizations === 1 ? snapshot("plan") : snapshot("done", "completed"),
      execute: async () => { throw new Error("adapter transport failed"); },
    },
  });

  assert.equal(result.outcome, "done");
  assert.equal(store.value().status, "done");
  assert.equal(store.value().active_turn_step, null);
  assert.equal(store.events.find((event) => event.type === "turn_failed").failure_kind, "adapter_error");
});

test("terminal synchronization after an adapter timeout preserves the canonical failed state", async () => {
  const store = memoryStore();
  let synchronizations = 0;
  const result = await runContinuationDriver({
    maxTurns: 2,
    store,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => ++synchronizations === 1 ? snapshot("plan") : snapshot("plan", "failed"),
      execute: async () => { throw new ContinuationAdapterTimeoutError(10); },
    },
  });

  assert.equal(result.outcome, "failed");
  assert.equal(store.value().status, "failed");
  assert.equal(store.value().active_turn_step, null);
  assert.equal(store.events.find((event) => event.type === "turn_failed").failure_kind, "timeout");
});

test("driver classifies adapter timeout failures and records canonical non-advancement", async () => {
  const store = memoryStore();
  const result = await runContinuationDriver({
    maxTurns: 1,
    store,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => { throw new ContinuationAdapterTimeoutError(10); },
    },
  });
  assert.equal(result.outcome, "budget_exhausted");
  assert.equal(store.events.find((event) => event.type === "turn_failed").failure_kind, "timeout");

  const forgedTextStore = memoryStore();
  await runContinuationDriver({
    maxTurns: 1,
    store: forgedTextStore,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => { throw new Error("adapter stderr: timed out after 1ms"); },
    },
  });
  assert.equal(forgedTextStore.events.find((event) => event.type === "turn_failed").failure_kind, "adapter_error");

  const nonAdvancingStore = memoryStore();
  const completed = await runContinuationDriver({
    maxTurns: 1,
    store: nonAdvancingStore,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async () => ({ status: "completed" }),
    },
  });
  assert.equal(completed.outcome, "budget_exhausted");
  assert.equal(nonAdvancingStore.events.some((event) => event.type === "gate_not_advanced"), true);
});

test("active turn authority is lock-bound, short-lived, and fails closed", async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-authority-"));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const runId = path.basename(sessionDir);
  const canonicalState = { run_id: runId, definition_id: "builder.build", current_step: "plan", status: "active" };
  writeAuthorityAssignment(sessionDir, "codex:authority-test", { audit_trail: "x".repeat(20 * 1024) });
  let issued;

  await withContinuationDriverLock(sessionDir, async (lock) => {
    const driverDir = path.join(sessionDir, "continuation-driver");
    fs.writeFileSync(path.join(driverDir, "state.json"), JSON.stringify({
      schema_version: "1.0",
      run_id: runId,
      definition_id: "builder.build",
      max_turns: 2,
      adapter_command_identity: "adapter-identity",
      status: "active",
      turns_started: 1,
      active_turn_step: "plan",
      pending_barrier: null,
      audit_padding: "x".repeat(20 * 1024),
    }));
    issued = activeTurnAuthority.issueActiveTurnAuthority({
      sessionDir,
      runId,
      definitionId: "builder.build",
      currentStep: "plan",
      iteration: 1,
      maxTurns: 2,
      adapterCommandIdentity: "adapter-identity",
      assignmentActor: "codex:authority-test",
      assignmentActorStruct: authorityActorStruct,
      lock,
      timeoutMs: 10_000,
    });
    bindAuthoritySigner(sessionDir, issued);
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: issued.turnSecret,
      assignmentActor: "codex:authority-test",
      canonicalState,
    }).valid, true);
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: "A".repeat(43),
      assignmentActor: "codex:authority-test",
      canonicalState,
    }).valid, false);
    assert.equal(activeTurnAuthority.validateSignedActiveTurnAssignmentAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: issued.turnSecret,
    }).valid, true, "the base validator returns the signed assignment without trusting the caller identity");
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: issued.turnSecret,
      assignmentActor: "codex:authority-test",
      canonicalState: { ...canonicalState, current_step: "verify" },
    }).valid, true, "canonical Flow-owned progression remains authorized");
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: issued.turnSecret,
      assignmentActor: "codex:authority-test",
      canonicalState,
      now: new Date(Date.now() + 20_000),
    }).valid, false, "expired authority is rejected");
    const missionFile = path.join(driverDir, "state.json");
    const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
    fs.writeFileSync(missionFile, JSON.stringify({ ...mission, adapter_command_identity: "other-adapter" }));
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir,
      runId: issued.runId,
      turnSecret: issued.turnSecret,
      assignmentActor: "codex:authority-test",
      canonicalState,
    }).valid, false, "adapter identity mismatch is rejected");
    fs.writeFileSync(missionFile, JSON.stringify(mission));
    const authorityFile = activeTurnAuthority.activeTurnFile(sessionDir);
    const record = JSON.parse(fs.readFileSync(authorityFile, "utf8"));
    assert.equal(Object.hasOwn(record, "turnSecret"), false, "the raw turn secret is never persisted");
    assert.match(record.turn_secret_sha256, /^[0-9a-f]{64}$/);
    fs.writeFileSync(authorityFile, JSON.stringify({ ...record, max_turns: 3 }));
    assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir, runId: issued.runId, turnSecret: issued.turnSecret, assignmentActor: "codex:authority-test", canonicalState,
    }).valid, false, "a modified signed authority is rejected");
    fs.writeFileSync(authorityFile, JSON.stringify(record));

    const attacker = generateKeyPairSync("ed25519");
    const attackerSecret = randomBytes(32).toString("base64url");
    const attackerPublicKey = attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const forged = {
      ...record,
      turn_secret_sha256: createHash("sha256").update(attackerSecret).digest("hex"),
      public_key_spki_b64: attackerPublicKey,
      public_key_digest: createHash("sha256").update(attackerPublicKey).digest("hex"),
    };
    delete forged.signature_b64;
    forged.signature_b64 = sign(null, canonicalBytes(forged), attacker.privateKey).toString("base64");
    fs.writeFileSync(authorityFile, JSON.stringify(forged));
    const forgedValidation = activeTurnAuthority.validateSignedActiveTurnAssignmentAuthority({
      sessionDir, runId: issued.runId, turnSecret: attackerSecret,
    });
    assert.equal(forgedValidation.valid, false, "a self-consistent attacker record is rejected by the mission signer anchor");
    assert.match(forgedValidation.reason, /driver mission does not match/);
    fs.writeFileSync(authorityFile, JSON.stringify(record));
  });

  assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
    sessionDir,
    runId: issued.runId,
    turnSecret: issued.turnSecret,
    assignmentActor: "codex:authority-test",
    canonicalState,
  }).valid, false, "a dead driver lock must not authorize Stop");
  assert.equal(issued.cleanup(), true);
  assert.equal(fs.existsSync(activeTurnAuthority.activeTurnFile(sessionDir)), false, "cleanup removes only the matching authority");
  assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
    sessionDir,
    runId: issued.runId,
    turnSecret: issued.turnSecret,
    assignmentActor: "codex:authority-test",
    canonicalState,
  }).valid, false, "replayed authority is rejected");
  fs.symlinkSync(path.join(os.tmpdir(), "outside-authority"), activeTurnAuthority.activeTurnFile(sessionDir));
  assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
    sessionDir,
    runId: issued.runId,
    turnSecret: issued.turnSecret,
    assignmentActor: "codex:authority-test",
    canonicalState,
  }).valid, false, "symlinked authority is rejected");
});

test("authority cleanup leaves an expiring record when a parent is replaced", (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-authority-parent-"));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const runId = path.basename(sessionDir);
  writeAuthorityAssignment(sessionDir, "codex:authority-test");
  const driverDir = path.join(sessionDir, "continuation-driver");
  const lock = { pid: process.pid, token: "parent-replacement", created_at: new Date().toISOString() };
  fs.mkdirSync(path.join(driverDir, "locks"), { recursive: true });
  fs.writeFileSync(path.join(driverDir, "locks", `${lock.pid}-${lock.token}.lock`), JSON.stringify({ schema_version: "1.0", ...lock }));
  fs.writeFileSync(path.join(driverDir, "state.json"), JSON.stringify({
    schema_version: "1.0", run_id: runId, definition_id: "builder.build", max_turns: 1,
    adapter_command_identity: "adapter-identity", status: "active", turns_started: 1, active_turn_step: "plan", pending_barrier: null,
  }));
  const issued = activeTurnAuthority.issueActiveTurnAuthority({
    sessionDir, runId, definitionId: "builder.build", currentStep: "plan", iteration: 1, maxTurns: 1,
    adapterCommandIdentity: "adapter-identity", assignmentActor: "codex:authority-test", assignmentActorStruct: authorityActorStruct, lock, timeoutMs: 10_000,
  });
  bindAuthoritySigner(sessionDir, issued);
  const replaced = `${driverDir}.replaced`;
  fs.renameSync(driverDir, replaced);
  fs.mkdirSync(driverDir, { recursive: true });
  assert.equal(issued.cleanup(), false);
  assert.equal(fs.existsSync(path.join(replaced, "active-turn.json")), true, "cleanup never unlinks through a replaced parent");
  assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
    sessionDir, runId: issued.runId, turnSecret: issued.turnSecret, assignmentActor: "codex:authority-test",
    canonicalState: { run_id: runId, definition_id: "builder.build", current_step: "plan", status: "active" },
  }).valid, false, "parent replacement fails closed");
});

test("authority write leaves its temporary record when a parent is replaced", (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-authority-write-parent-"));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const runId = path.basename(sessionDir);
  writeAuthorityAssignment(sessionDir, "codex:authority-test");
  const driverDir = path.join(sessionDir, "continuation-driver");
  const lock = { pid: process.pid, token: "write-parent-replacement", created_at: new Date().toISOString() };
  fs.mkdirSync(path.join(driverDir, "locks"), { recursive: true });
  fs.writeFileSync(path.join(driverDir, "locks", `${lock.pid}-${lock.token}.lock`), JSON.stringify({ schema_version: "1.0", ...lock }));
  fs.writeFileSync(path.join(driverDir, "state.json"), JSON.stringify({
    schema_version: "1.0", run_id: runId, definition_id: "builder.build", max_turns: 1,
    adapter_command_identity: "adapter-identity", status: "active", turns_started: 1, active_turn_step: "plan", pending_barrier: null,
  }));
  const originalRename = fs.renameSync;
  const replaced = `${driverDir}.replaced`;
  fs.renameSync = (source, target) => {
    if (target === activeTurnAuthority.activeTurnFile(sessionDir)) {
      originalRename(driverDir, replaced);
      fs.mkdirSync(driverDir, { recursive: true });
      throw new Error("injected parent replacement");
    }
    return originalRename(source, target);
  };
  try {
    assert.throws(() => activeTurnAuthority.issueActiveTurnAuthority({
      sessionDir, runId, definitionId: "builder.build", currentStep: "plan", iteration: 1, maxTurns: 1,
      adapterCommandIdentity: "adapter-identity", assignmentActor: "codex:authority-test", assignmentActorStruct: authorityActorStruct, lock, timeoutMs: 10_000,
    }), /injected parent replacement/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readdirSync(replaced).some((name) => /^\.active-turn\.json\..+\.tmp$/.test(name)), true, "temporary authority record is left when its parent identity changes");
});

test("a signed authority rejects a stale lock from an exited driver", (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-authority-stale-lock-"));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const runId = path.basename(sessionDir);
  writeAuthorityAssignment(sessionDir, "codex:authority-test");
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(exited.pid);
  const lock = { pid: exited.pid, token: "stale-lock", created_at: new Date().toISOString() };
  const driverDir = path.join(sessionDir, "continuation-driver");
  fs.mkdirSync(path.join(driverDir, "locks"), { recursive: true });
  fs.writeFileSync(path.join(driverDir, "locks", `${lock.pid}-${lock.token}.lock`), JSON.stringify({ schema_version: "1.0", ...lock }));
  fs.writeFileSync(path.join(driverDir, "state.json"), JSON.stringify({
    schema_version: "1.0", run_id: runId, definition_id: "builder.build", max_turns: 1,
    adapter_command_identity: "adapter-identity", status: "active", turns_started: 1, active_turn_step: "plan", pending_barrier: null,
  }));
  const issued = activeTurnAuthority.issueActiveTurnAuthority({
    sessionDir, runId, definitionId: "builder.build", currentStep: "plan", iteration: 1, maxTurns: 1,
    adapterCommandIdentity: "adapter-identity", assignmentActor: "codex:authority-test", assignmentActorStruct: authorityActorStruct, lock, timeoutMs: 10_000,
  });
  bindAuthoritySigner(sessionDir, issued);
  assert.equal(activeTurnAuthority.validateActiveTurnAuthority({
    sessionDir, runId: issued.runId, turnSecret: issued.turnSecret, assignmentActor: "codex:authority-test",
    canonicalState: { run_id: runId, definition_id: "builder.build", current_step: "plan", status: "active" },
  }).valid, false, "a signed record alone cannot authorize after its driver exits");
});

test("authority validation rejects an active-turn file atomically replaced after descriptor read", (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-authority-final-race-"));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const runId = path.basename(sessionDir);
  writeAuthorityAssignment(sessionDir, "codex:authority-test");
  const lock = { pid: process.pid, token: "final-file-replacement", created_at: new Date().toISOString() };
  const driverDir = path.join(sessionDir, "continuation-driver");
  fs.mkdirSync(path.join(driverDir, "locks"), { recursive: true });
  fs.writeFileSync(path.join(driverDir, "locks", `${lock.pid}-${lock.token}.lock`), JSON.stringify({ schema_version: "1.0", ...lock }));
  fs.writeFileSync(path.join(driverDir, "state.json"), JSON.stringify({
    schema_version: "1.0", run_id: runId, definition_id: "builder.build", max_turns: 1,
    adapter_command_identity: "adapter-identity", status: "active", turns_started: 1, active_turn_step: "plan", pending_barrier: null,
  }));
  const issued = activeTurnAuthority.issueActiveTurnAuthority({
    sessionDir, runId, definitionId: "builder.build", currentStep: "plan", iteration: 1, maxTurns: 1,
    adapterCommandIdentity: "adapter-identity", assignmentActor: "codex:authority-test", assignmentActorStruct: authorityActorStruct, lock, timeoutMs: 10_000,
  });
  bindAuthoritySigner(sessionDir, issued);
  const authorityFile = activeTurnAuthority.activeTurnFile(sessionDir);
  const replacement = path.join(driverDir, "replacement-active-turn.json");
  fs.copyFileSync(authorityFile, replacement);
  const originalReadFile = fs.readFileSync;
  let replaced = false;
  fs.readFileSync = (target, ...args) => {
    const bytes = originalReadFile(target, ...args);
    if (!replaced && typeof target === "number") {
      replaced = true;
      fs.renameSync(replacement, authorityFile);
    }
    return bytes;
  };
  try {
    const validation = activeTurnAuthority.validateActiveTurnAuthority({
      sessionDir, runId: issued.runId, turnSecret: issued.turnSecret, assignmentActor: "codex:authority-test",
      canonicalState: { run_id: runId, definition_id: "builder.build", current_step: "plan", status: "active" },
    });
    assert.equal(replaced, true, "test replaced the final pathname after descriptor read");
    assert.equal(validation.valid, false, "descriptor bytes are rejected when the final pathname inode changed");
    assert.match(validation.reason, /identity changed after reading/);
  } finally {
    fs.readFileSync = originalReadFile;
  }
});

test("canonical Flow state rejects final-path replacement after descriptor read", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-canonical-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const slug = "canonical-race-run";
  const sessionDir = path.join(root, ".kontourai", "flow-agents", slug);
  const runDir = path.join(root, ".kontourai", "flow", "runs", slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const stateFile = path.join(runDir, "state.json");
  const replacement = path.join(runDir, "replacement-state.json");
  const state = { run_id: slug, definition_id: "builder.build", definition_version: "1.0", status: "active", current_step: "plan" };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(replacement, JSON.stringify(state));
  fs.writeFileSync(path.join(runDir, "definition.json"), JSON.stringify({ id: "builder.build", version: "1.0", steps: [{ id: "plan" }] }));
  const originalReadFile = fs.readFileSync;
  let replaced = false;
  fs.readFileSync = (target, ...args) => {
    const bytes = originalReadFile(target, ...args);
    if (!replaced && typeof target === "number") {
      replaced = true;
      fs.renameSync(replacement, stateFile);
    }
    return bytes;
  };
  try {
    const result = stopGoalFit.canonicalFlowState(root, sessionDir);
    assert.equal(replaced, true, "test replaced the canonical final pathname after descriptor read");
    assert.equal(result.state, null);
    assert.match(result.error, /identity changed after reading/);
  } finally {
    fs.readFileSync = originalReadFile;
  }
});

test("canonical Flow state rejects an unknown definition step and a replaced run parent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-canonical-definition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const slug = "canonical-definition-run";
  const sessionDir = path.join(root, ".kontourai", "flow-agents", slug);
  const runDir = path.join(root, ".kontourai", "flow", "runs", slug);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const state = { run_id: slug, definition_id: "builder.build", definition_version: "1.0", status: "active", current_step: "unknown" };
  const definition = { id: "builder.build", version: "1.0", steps: [{ id: "plan" }] };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(runDir, "definition.json"), JSON.stringify(definition));
  assert.match(stopGoalFit.canonicalFlowState(root, sessionDir).error, /current_step is not present/);

  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ ...state, current_step: "plan" }));
  const originalReadFile = fs.readFileSync;
  const replacedDir = `${runDir}.replaced`;
  let descriptorReads = 0;
  let replaced = false;
  fs.readFileSync = (target, ...args) => {
    const bytes = originalReadFile(target, ...args);
    if (typeof target === "number" && ++descriptorReads === 2) {
      fs.renameSync(runDir, replacedDir);
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ ...state, current_step: "plan" }));
      fs.writeFileSync(path.join(runDir, "definition.json"), JSON.stringify(definition));
      replaced = true;
    }
    return bytes;
  };
  try {
    const result = stopGoalFit.canonicalFlowState(root, sessionDir);
    assert.equal(replaced, true, "test replaced the canonical run parent during definition read");
    assert.equal(result.state, null);
    assert.match(result.error, /identity changed|parent identity changed/);
  } finally {
    fs.readFileSync = originalReadFile;
  }
});

test("Stop ignores an unvalidated capability locator and preserves ordinary pointer selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-invalid-locator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test Repo\n");
  const artifactRoot = path.join(root, ".kontourai", "flow-agents");
  const ordinarySlug = "ordinary-pointer-run";
  const unvalidatedSlug = "unvalidated-env-run";
  for (const slug of [ordinarySlug, unvalidatedSlug]) {
    const dir = path.join(artifactRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}--deliver.md`), `# ${slug}\n\nstatus: planned\ntype: deliver\n`);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      schema_version: "1.0", task_slug: slug, status: "planned", phase: "planning",
      updated_at: new Date().toISOString(), next_action: { status: "continue", summary: "Continue" },
    }));
  }
  fs.writeFileSync(path.join(artifactRoot, "current.json"), JSON.stringify({ active_slug: ordinarySlug, artifact_dir: ordinarySlug }));
  const priorSecret = process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
  const priorRunId = process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
  // #440 FIXTURE-GAP (post-rebase, #589 merge): this fixture only ever writes the legacy
  // current.json, never a per-actor pointer -- under a RESOLVED ambient actor,
  // stop-goal-fit.js's ownership-scoped analyze() now scopes to that actor's own (nonexistent)
  // pointer and never falls through to the legacy-named ordinary session at all. This test is
  // about continuation-locator validation (an unvalidated locator must not override ordinary
  // pointer selection), not #440's per-actor ownership scoping, so forcing the documented
  // test-only unresolved-actor escape hatch restores the legacy-fallback path this fixture was
  // written against (D3 compat), matching the same fix applied throughout evals/ for this exact
  // class of fixture gap.
  const priorForceUnresolved = process.env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED;
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = "A".repeat(43);
  process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = unvalidatedSlug;
  process.env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED = "1";
  process.env.NODE_ENV = "test";
  try {
    const result = await stopGoalFit.analyze(root);
    assert.equal(result.latestArtifactDir, path.join(artifactRoot, ordinarySlug));
  } finally {
    if (priorSecret === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
    else process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = priorSecret;
    if (priorRunId === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
    else process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = priorRunId;
    if (priorForceUnresolved === undefined) delete process.env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED;
    else process.env.FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED = priorForceUnresolved;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  }
});

test("Stop keeps a base-valid signed session selected across paused and completed canonical dispositions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-exact-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test Repo\n");
  const artifactRoot = path.join(root, ".kontourai", "flow-agents");
  const exactSlug = "signed-exact-run";
  const unrelatedSlug = "unrelated-pointer-run";
  const exactDir = path.join(artifactRoot, exactSlug);
  const unrelatedDir = path.join(artifactRoot, unrelatedSlug);
  const runDir = path.join(root, ".kontourai", "flow", "runs", exactSlug);
  fs.mkdirSync(path.join(exactDir, "continuation-driver", "locks"), { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(exactDir, `${exactSlug}--deliver.md`), `# Exact\n\nstatus: planned\ntype: deliver\n`);
  fs.writeFileSync(path.join(unrelatedDir, `${unrelatedSlug}--deliver.md`), `# Unrelated\n\nstatus: executing\ntype: deliver\n`);
  const sidecar = (slug, flowStatus, status = "planned") => ({
    schema_version: "1.0", task_slug: slug, status, phase: status === "delivered" ? "release" : "planning",
    updated_at: new Date().toISOString(),
    flow_run: { status: flowStatus, run_id: slug, definition_id: "builder.build", definition_version: "1.0", current_step: "plan" },
    next_action: { status: flowStatus === "completed" ? "done" : "wait", summary: "Canonical disposition" },
  });
  fs.writeFileSync(path.join(unrelatedDir, "state.json"), JSON.stringify(sidecar(unrelatedSlug, "active", "executing")));
  fs.writeFileSync(path.join(artifactRoot, "current.json"), JSON.stringify({ active_slug: unrelatedSlug }));
  fs.mkdirSync(path.join(artifactRoot, "current"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "current", "pointer-actor.json"), JSON.stringify({ active_slug: unrelatedSlug }));
  fs.writeFileSync(path.join(runDir, "definition.json"), JSON.stringify({ id: "builder.build", version: "1.0", steps: [{ id: "plan" }] }));
  writeAuthorityAssignment(exactDir, "driver-actor");
  writeAuthorityAssignment(unrelatedDir, "driver-actor");
  const lock = { pid: process.pid, token: "exact-scope", created_at: new Date().toISOString() };
  fs.writeFileSync(path.join(exactDir, "continuation-driver", "locks", `${lock.pid}-${lock.token}.lock`), JSON.stringify({ schema_version: "1.0", ...lock }));
  fs.writeFileSync(path.join(exactDir, "continuation-driver", "state.json"), JSON.stringify({
    schema_version: "1.0", run_id: exactSlug, definition_id: "builder.build", max_turns: 2,
    adapter_command_identity: "adapter-identity", status: "active", turns_started: 1,
    active_turn_step: "plan", pending_barrier: null,
  }));
  const issued = activeTurnAuthority.issueActiveTurnAuthority({
    sessionDir: exactDir, runId: exactSlug, definitionId: "builder.build", currentStep: "plan", iteration: 1, maxTurns: 2,
    adapterCommandIdentity: "adapter-identity", assignmentActor: "driver-actor", assignmentActorStruct: authorityActorStruct,
    lock, timeoutMs: 30_000,
  });
  bindAuthoritySigner(exactDir, issued);
  const prior = {
    actor: process.env.FLOW_AGENTS_ACTOR,
    secret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET,
    runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID,
  };
  process.env.FLOW_AGENTS_ACTOR = "pointer-actor";
  process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = issued.turnSecret;
  process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = issued.runId;
  try {
    for (const canonicalStatus of ["paused", "needs_decision", "completed"]) {
      const terminal = canonicalStatus === "completed";
      fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
        run_id: exactSlug, definition_id: "builder.build", definition_version: "1.0", status: canonicalStatus, current_step: "plan",
      }));
      fs.writeFileSync(path.join(exactDir, "state.json"), JSON.stringify(sidecar(exactSlug, canonicalStatus, terminal ? "delivered" : "planned")));
      const analyzed = await stopGoalFit.analyze(root);
      assert.equal(analyzed.latestArtifactDir, exactDir, `${canonicalStatus} remains scoped to the signed run`);
      assert.equal(analyzed.activeTurnAuthority, false, `${canonicalStatus} cannot relax the active gate`);
      stopGoalFit.releaseOnNonTerminalStop(root, analyzed.latestArtifactDir);
      assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, "assignment", `${exactSlug}.json`), "utf8")).status, "claimed");
      assert.equal(JSON.parse(fs.readFileSync(path.join(artifactRoot, "assignment", `${unrelatedSlug}.json`), "utf8")).status, "claimed");
    }
    const liveness = path.join(artifactRoot, "liveness", "events.jsonl");
    assert.equal(fs.existsSync(liveness) ? fs.readFileSync(liveness, "utf8").includes('"type":"release"') : false, false);
  } finally {
    if (prior.actor === undefined) delete process.env.FLOW_AGENTS_ACTOR; else process.env.FLOW_AGENTS_ACTOR = prior.actor;
    if (prior.secret === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET; else process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = prior.secret;
    if (prior.runId === undefined) delete process.env.FLOW_AGENTS_CONTINUATION_RUN_ID; else process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = prior.runId;
  }
});

test("artifact validation skips only a private continuation driver child", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-validator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, "session-a");
  fs.mkdirSync(path.join(session, "continuation-driver"), { recursive: true });
  fs.writeFileSync(path.join(session, "state.json"), JSON.stringify({
    schema_version: "1.0", task_slug: "session-a", status: "planned", phase: "planning",
    updated_at: "2026-07-13T00:00:00Z", next_action: { status: "continue", summary: "Continue" },
  }));
  fs.writeFileSync(path.join(session, "continuation-driver", "state.json"), "{}\n");
  execFileSync(process.execPath, ["build/src/cli/validate-workflow-artifacts.js", "--skip-markdown-validation", session], { cwd: path.resolve(import.meta.dirname, "..", ".."), stdio: "pipe" });
  const topLevel = path.join(root, "continuation-driver");
  fs.mkdirSync(topLevel, { recursive: true });
  fs.writeFileSync(path.join(topLevel, "state.json"), "{}\n");
  assert.throws(() => execFileSync(process.execPath, ["build/src/cli/validate-workflow-artifacts.js", "--skip-markdown-validation", topLevel], {
    cwd: path.resolve(import.meta.dirname, "..", ".."), stdio: "pipe",
  }), /Command failed/);
});

test("max-block hard classification preserves the no-authority baseline and tightens only authorized turns", () => {
  const ordinary = ".kontourai/flow-agents/session-a is still status:planned (1m old). Do not final-answer as complete unless the next step is explicit.";
  const evidenceFailure = "evidence verdict:fail";
  assert.equal(stopGoalFit.isHardStopWarning(ordinary, ".kontourai/flow-agents/session-a", false), false, "ordinary FULL_BLOCK stays releasable without authority");
  assert.equal(stopGoalFit.isHardStopWarning(evidenceFailure, ".kontourai/flow-agents/session-a", false), true, "existing HARD_BLOCK stays permanent without authority");
  assert.equal(stopGoalFit.isHardStopWarning(ordinary, ".kontourai/flow-agents/session-a", true), false, "ordinary active-gate warning is advisory for a valid authority");
  assert.equal(stopGoalFit.isHardStopWarning("Definition Of Done is incomplete", ".kontourai/flow-agents/session-a", true), true, "nonordinary FULL_BLOCK stays permanent for a valid authority");
});

test("driver binds the adapter command identity for the mission", async () => {
  const store = memoryStore();
  const runtime = {
    inspect: async () => snapshot("plan"),
    synchronize: async () => snapshot("plan"),
    execute: async () => ({ status: "completed" }),
  };
  await runContinuationDriver({ maxTurns: 1, adapterCommandIdentity: "adapter-a", store, runtime });
  await assert.rejects(
    runContinuationDriver({ maxTurns: 1, adapterCommandIdentity: "adapter-b", store, runtime }),
    /adapter command identity does not match/,
  );
});

test("driver honors adapter dispositions across canonical Flow statuses", async (t) => {
  for (const [status, expected] of [
    ["blocked", "budget_exhausted"],
    ["needs_decision", "waiting"],
    ["paused", "waiting"],
    ["canceled", "done"],
    ["completed", "done"],
    ["accepted_by_exception", "budget_exhausted"],
    ["failed", "failed"],
  ]) {
    await t.test(status, async () => {
      let executeCalls = 0;
      const result = await runContinuationDriver({
        maxTurns: 1,
        store: memoryStore(),
        runtime: {
          inspect: async () => snapshot("plan", status),
          synchronize: async () => snapshot("plan", status),
          execute: async () => { executeCalls += 1; return { status: "completed" }; },
        },
      });
      assert.equal(result.outcome, expected);
      assert.equal(executeCalls, expected === "budget_exhausted" ? 1 : 0);
    });
  }
});

test("driver reauthorizes immediately before each adapter turn", async () => {
  let authorizations = 0;
  let executions = 0;
  await assert.rejects(
    runContinuationDriver({
      maxTurns: 3,
      store: memoryStore(),
      authorizeTurn: async () => {
        authorizations += 1;
        if (authorizations === 2) throw new Error("assignment ownership changed");
      },
      runtime: {
        inspect: async () => snapshot("plan"),
        synchronize: async () => snapshot("plan"),
        execute: async () => { executions += 1; return { status: "completed" }; },
      },
    }),
    /assignment ownership changed/,
  );
  assert.equal(authorizations, 2);
  assert.equal(executions, 1);
});

test("explicit adapter argv receives one structured action without a shell", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  fs.writeFileSync(adapter, `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({ status: "completed", summary: process.cwd() + "|" + request.current_step }));
  `);
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));
  const result = await executeContinuationAdapter(command, {
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    current_step: "plan",
    iteration: 1,
    max_turns: 3,
    next_action: { status: "continue", skills: ["plan-work"] },
  }, { cwd: root, timeoutMs: 5_000 });

  assert.deepEqual(result, { status: "completed", summary: `${fs.realpathSync(root)}|plan` });
});

test("adapter descendants preserve ordinary actor resolution and receive only fresh turn capability companions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-adapter-actor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  fs.writeFileSync(adapter, `
    process.stdout.write(JSON.stringify({ status: "completed", summary: JSON.stringify({ ambientActor: process.env.FLOW_AGENTS_ACTOR || null, continuation: {
      turnSecret: process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET || null,
      runId: process.env.FLOW_AGENTS_CONTINUATION_RUN_ID || null,
      obsoleteNonce: process.env.FLOW_AGENTS_CONTINUATION_TURN_NONCE || null,
      obsoletePublicKeyDigest: process.env.FLOW_AGENTS_CONTINUATION_TURN_PUBLIC_KEY_DIGEST || null,
      actorB64: process.env.FLOW_AGENTS_CONTINUATION_ACTOR_B64 || null,
    } }) }));
  `);
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));
  const variables = ["FLOW_AGENTS_ACTOR", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "PI_SESSION_ID", "FLOW_AGENTS_CONTINUATION_TURN_SECRET", "FLOW_AGENTS_CONTINUATION_RUN_ID", "FLOW_AGENTS_CONTINUATION_TURN_NONCE", "FLOW_AGENTS_CONTINUATION_TURN_PUBLIC_KEY_DIGEST", "FLOW_AGENTS_CONTINUATION_ACTOR_B64"];
  const prior = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  process.env.FLOW_AGENTS_ACTOR = "stale-parent-actor";
  process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET = "z".repeat(43);
  process.env.FLOW_AGENTS_CONTINUATION_RUN_ID = "stale-run";
  process.env.FLOW_AGENTS_CONTINUATION_TURN_NONCE = "00000000-0000-4000-8000-000000000099";
  process.env.FLOW_AGENTS_CONTINUATION_TURN_PUBLIC_KEY_DIGEST = "b".repeat(64);
  process.env.FLOW_AGENTS_CONTINUATION_ACTOR_B64 = "stale-capability";
  try {
    const inherited = await executeContinuationAdapter(command, {
      schema_version: "1.0", run_id: "run-251", definition_id: "builder.build", current_step: "plan", iteration: 1, max_turns: 1, next_action: null,
    }, { cwd: root, timeoutMs: 5_000 });
    const directChild = JSON.parse(inherited.summary);
    assert.equal(directChild.ambientActor, "stale-parent-actor", "direct adapter calls preserve their existing actor when no signed turn actor is supplied");
    assert.deepEqual(directChild.continuation, { turnSecret: null, runId: null, obsoleteNonce: null, obsoletePublicKeyDigest: null, actorB64: null }, "direct adapter calls never inherit a stale continuation capability");
    const result = await executeContinuationAdapter(command, {
      schema_version: "1.0", run_id: "run-251", definition_id: "builder.build", current_step: "plan", iteration: 1, max_turns: 1, next_action: null,
    }, {
      cwd: root,
      timeoutMs: 5_000,
      continuationTurnSecret: "a".repeat(43),
      continuationRunId: "run-251",
    });
    const child = JSON.parse(result.summary);
    assert.equal(child.ambientActor, "stale-parent-actor", "signed propagation does not overwrite FLOW_AGENTS_ACTOR");
    assert.deepEqual(child.continuation, {
      turnSecret: "a".repeat(43),
      runId: "run-251",
      obsoleteNonce: null,
      obsoletePublicKeyDigest: null,
      actorB64: null,
    });
  } finally {
    for (const name of variables) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
});

test("loaded adapter binds executable and script content for every turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  fs.writeFileSync(adapter, 'process.stdout.write(JSON.stringify({ status: "completed" }));\n');
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));
  const loaded = loadContinuationAdapterCommand(command);
  fs.writeFileSync(adapter, 'process.stdout.write(JSON.stringify({ status: "wait" }));\n');

  await assert.rejects(
    executeLoadedContinuationAdapter(loaded, {
      schema_version: "1.0",
      run_id: "run-251",
      definition_id: "builder.build",
      current_step: "execute",
      iteration: 1,
      max_turns: 3,
      next_action: null,
    }, { cwd: root, timeoutMs: 5_000 }),
    /integrity changed after mission binding/,
  );
});

test("adapter integrity hashes raw file bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-binary-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const data = path.join(root, "binary.dat");
  const command = path.join(root, "command.json");
  fs.writeFileSync(adapter, 'process.stdout.write(JSON.stringify({ status: "completed" }));\n');
  fs.writeFileSync(data, Buffer.from([0x80]));
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter, data] }));
  const loaded = loadContinuationAdapterCommand(command);
  fs.writeFileSync(data, Buffer.from([0x81]));

  await assert.rejects(
    executeLoadedContinuationAdapter(loaded, {
      schema_version: "1.0",
      run_id: "run-251",
      definition_id: "builder.build",
      current_step: "execute",
      iteration: 1,
      max_turns: 3,
      next_action: null,
    }, { cwd: root, timeoutMs: 5_000 }),
    /integrity changed after mission binding/,
  );
});

test("adapter timeout terminates its process group", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  const marker = path.join(root, "orphaned-child-ran");
  fs.writeFileSync(adapter, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 300)`) }], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));

  await assert.rejects(
    executeContinuationAdapter(command, {
      schema_version: "1.0",
      run_id: "run-251",
      definition_id: "builder.build",
      current_step: "execute",
      iteration: 1,
      max_turns: 3,
      next_action: null,
    }, { cwd: root, timeoutMs: 50 }),
    (error) => error instanceof ContinuationAdapterTimeoutError && /timed out after 50ms/.test(error.message),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false);
});

test("adapter stderr with timeout-like text remains an adapter_error", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-timeout-stderr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  fs.writeFileSync(adapter, 'process.stderr.write("timed out after 1ms\\n"); process.exit(7);\n');
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));
  const store = memoryStore();

  await runContinuationDriver({
    maxTurns: 1,
    store,
    runtime: {
      inspect: async () => snapshot("plan"),
      synchronize: async () => snapshot("plan"),
      execute: async (request) => executeContinuationAdapter(command, request, { cwd: root, timeoutMs: 5_000 }),
    },
  });

  const failure = store.events.find((event) => event.type === "turn_failed");
  assert.equal(failure.failure_kind, "adapter_error");
  assert.match(failure.summary, /timed out after 1ms/);
});

test("completed adapter forcibly terminates background descendants", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-completed-child-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = path.join(root, "adapter.mjs");
  const command = path.join(root, "command.json");
  const marker = path.join(root, "background-child-ran");
  const childSource = `
    process.on("SIGTERM", () => {});
    setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 600);
    setInterval(() => {}, 1000);
  `;
  fs.writeFileSync(adapter, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" }).unref();
    process.stdout.write(JSON.stringify({ status: "completed" }));
  `);
  fs.writeFileSync(command, JSON.stringify({ argv: [process.execPath, adapter] }));

  await executeContinuationAdapter(command, {
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    current_step: "execute",
    iteration: 1,
    max_turns: 3,
    next_action: null,
  }, { cwd: root, timeoutMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(fs.existsSync(marker), false);
});

test("deadline and pid barriers report ready or pending without consuming turns", async () => {
  let clock = Date.parse("2026-07-12T12:00:00.000Z");
  const deadline = await waitForContinuationBarrier(
    { kind: "deadline", at: "2026-07-12T12:00:01.000Z" },
    { maxWaitMs: 1_000, pollMs: 10, now: () => clock, sleep: async (ms) => { clock += ms; } },
  );
  assert.equal(deadline, "ready");

  const alive = await waitForContinuationBarrier(
    { kind: "pid", pid: process.pid },
    { maxWaitMs: 0, pollMs: 10 },
  );
  assert.equal(alive, "pending");

  const gone = await waitForContinuationBarrier(
    { kind: "pid", pid: 2_147_483_647 },
    { maxWaitMs: 0, pollMs: 10 },
  );
  assert.equal(gone, "ready");
});

test("file continuation store refuses a symlinked state target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFileContinuationStore(root);
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "{}\n");
  fs.symlinkSync(outside, path.join(root, "continuation-driver", "state.json"));
  assert.throws(() => store.load(), /must be a regular file/);
});

test("file continuation store detects deleted and rolled-back mission state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFileContinuationStore(root);
  store.save({
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    max_turns: 3,
    adapter_command_identity: null,
    status: "active",
    turns_started: 1,
    pending_barrier: null,
    updated_at: "2026-07-12T12:00:00.000Z",
  });
  store.append({
    schema_version: "1.0",
    type: "turn_started",
    run_id: "run-251",
    definition_id: "builder.build",
    current_step: "plan",
    turns_started: 1,
    at: "2026-07-12T12:00:00.000Z",
  });
  const stateFile = path.join(root, "continuation-driver", "state.json");
  fs.unlinkSync(stateFile);
  assert.throws(() => store.load(), /state is missing while mission events exist/);

  store.save({
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    max_turns: 3,
    adapter_command_identity: null,
    status: "active",
    turns_started: 0,
    pending_barrier: null,
    updated_at: "2026-07-12T12:00:00.000Z",
  });
  assert.throws(() => store.load(), /rolled back behind its event history/);
});

test("file continuation store restores a parked barrier from mission history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-barrier-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFileContinuationStore(root);
  const barrier = { kind: "pid", pid: process.pid };
  store.save({
    schema_version: "1.0",
    run_id: "run-251",
    definition_id: "builder.build",
    max_turns: 3,
    adapter_command_identity: null,
    status: "active",
    turns_started: 1,
    pending_barrier: null,
    updated_at: "2026-07-12T12:00:00.000Z",
  });
  store.append({ schema_version: "1.0", type: "turn_started", run_id: "run-251", definition_id: "builder.build", current_step: "verify", turns_started: 1, at: "2026-07-12T12:00:00.000Z" });
  store.append({ schema_version: "1.0", type: "parked", run_id: "run-251", definition_id: "builder.build", current_step: "verify", turns_started: 1, at: "2026-07-12T12:00:01.000Z", barrier });

  const restored = store.load();
  assert.equal(restored.status, "waiting");
  assert.deepEqual(restored.pending_barrier, barrier);
});

test("session lock rejects concurrent drivers and reclaims a dead owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withContinuationDriverLock(root, async () => {
    await assert.rejects(
      withContinuationDriverLock(root, async () => assert.fail("concurrent driver must not run")),
      /already running under pid/,
    );
  });

  const locksDir = path.join(root, "continuation-driver", "locks");
  const lockFile = path.join(locksDir, "dead.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ schema_version: "1.0", pid: 2_147_483_647, token: "dead", created_at: "2026-07-12T12:00:00.000Z" }));
  let ran = false;
  await withContinuationDriverLock(root, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(fs.readdirSync(locksDir), []);
});
