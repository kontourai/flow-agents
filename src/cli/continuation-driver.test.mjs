import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileContinuationStore, runContinuationDriver, withContinuationDriverLock } from "../../build/src/continuation-driver.js";
import { executeContinuationAdapter, executeLoadedContinuationAdapter, loadContinuationAdapterCommand, waitForContinuationBarrier } from "../../build/src/cli/continuation-adapter.js";

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
    /timed out after 50ms/,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false);
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
