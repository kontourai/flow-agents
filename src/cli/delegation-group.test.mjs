import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createDelegationGroupService,
  createLocalFileDelegationGroupStore,
  groupDigest,
  groupPolicyDigest,
  groupRequestDigest,
  projectDelegationGroup,
  validateDelegationGroupSpec,
} from "../../build/src/index.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const NOW = "2026-10-21T12:00:00.000Z";
const SOURCE = { repository_id: "kontourai/flow-agents", worktree_id: "source-a", source_state_id: "commit-a" };
const FENCE = { controller_id: "controller-a", epoch: 1 };
const AMOUNT = { input_tokens: 10, output_tokens: 20, cost_micros: 30 };
function ref(id = "receipt") { return { id, digest: `sha256:${"a".repeat(64)}`, byte_length: 100, provenance: "host-journal" }; }
function envelope(n) {
  return {
    schema_version: "1.0", envelope_id: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, generation: 0,
    correlation: { status: "incomplete", reason: "independent preauthorized work" },
    flow_binding: { status: "unbound", reason: "independent work" }, actor_id: `actor-${n}`, subject_id: "subject",
    source: SOURCE,
    authority: { allowed_tools: ["filesystem.read"], allowed_effects: ["read"], mutable_resources: [], posture: "report-only", approval: "automatic", escalation: "deny" },
    budget: { max_attempts: 8, max_depth: 0, max_concurrent_children: 4, max_input_tokens: 1000, max_output_tokens: 1000, max_cost_micros: 1000, expires_at: "2026-10-22T12:00:00.000Z" },
    runtime: { required_capabilities: ["read"], runtime_receipt_ref: `runtime-${n}`, model_receipt_ref: `model-${n}` },
    continuation_id: `continuation-${n}`, cancellation_id: `cancellation-${n}`,
    revisions: { prompt_revision: "prompt-1", rubric_revision: "rubric-1", policy_revision: "policy-1" },
  };
}
function envelopeRef(value) { return { envelope_id: value.envelope_id, generation: value.generation, digest: groupDigest(value) }; }
function fixture(options = {}) {
  const root = makeFixtureDir("flow-delegation-group-");
  const envelopes = [envelope(1), envelope(2), envelope(3), envelope(4)];
  options.adjustEnvelopes?.(envelopes);
  const policy = { revision: "policy-1", max_attempts: 4, max_concurrent: 2, ceilings: { input_tokens: 40, output_tokens: 80, cost_micros: 120 }, join: "all_terminal", ...options.policy };
  const spec = {
    schema_version: "1.0", group_id: "group-a", parent_envelope: envelopeRef(envelopes[0]), source: SOURCE,
    policy: { ...policy, digest: groupPolicyDigest(policy) }, topology: options.topology ?? { kind: "independent" },
    seats: envelopes.slice(1).map((e, i) => ({ seat_id: `seat-${i + 1}`, envelope: envelopeRef(e), source: SOURCE, work: options.topology ? { kind: "flow", step_id: `step-${i + 1}` } : { kind: "independent" } })),
    recursion: { kind: "unsupported" }, worktree_mode: "shared_read_only",
  };
  let time = NOW;
  let denied = false;
  const calls = [];
  const host = {
    now: () => time,
    async resolveAuthorizedEnvelope(identity, groupId) {
      calls.push(["authorize", groupId]);
      const e = envelopes.find((e) => e.envelope_id === identity.envelope_id);
      return e && !denied ? { envelope: e, authorization: ref("authorized") } : null;
    },
    async confirmController() { return denied ? null : ref("fenced"); },
    async confirmReadiness() { return { kind: "independent", reference: ref("ready") }; },
    async confirmBudgetEnforcement() { return ref("budget-enforced"); },
    async confirmEvidence() { return ref("confirmed-evidence"); },
  };
  const store = createLocalFileDelegationGroupStore(root);
  const service = createDelegationGroupService(store, host);
  const request = (action, revision, operation = `${action.kind}-${revision}`, fence = FENCE) => {
    const body = { schema_version: "1.0", group_id: spec.group_id, operation_id: operation, expected_revision: revision, fence, action };
    return { ...body, request_digest: groupRequestDigest(body) };
  };
  return { root, envelopes, spec, host, store, service, calls, request,
    expire() { time = "2026-10-23T12:00:00.000Z"; }, deny() { denied = true; },
    async create() { return service.operate(request({ kind: "create", spec }, 0)); },
    async act(action, operation, fence) { const state = await service.read(spec.group_id); return service.operate(request(action, state.revision, operation, fence)); },
  };
}
function reserve(seat = 1, id = `attempt-${seat}`, amount = AMOUNT) {
  return { kind: "reserve", seat_id: `seat-${seat}`, attempt_id: id, dispatch_intent_id: `intent-${id}`, dispatch_plan: ref(`plan-${id}`), allocation: amount };
}
async function settle(f, id, usage = AMOUNT, outcome = "succeeded") {
  await f.act({ kind: "terminal", attempt_id: id, outcome, receipt: ref(`terminal-${id}`), outputs: [ref(`output-${id}`)] });
  return f.act({ kind: "account", attempt_id: id, usage, receipt: ref(`usage-${id}`) });
}
const code = (expected) => (error) => error.code === expected;

// Each case exercises the public service over the actual locked filesystem store.
test("reopened ledger retains exact operation outcomes; conflicting intent and stale fences cannot mutate it", async () => {
  const f = fixture();
  await f.create();
  const request = f.request(reserve(), 1, "reserve-once");
  const first = await f.service.operate(request);
  await f.act({ kind: "cancel" });
  f.expire(); f.deny();
  const reopened = createDelegationGroupService(createLocalFileDelegationGroupStore(f.root), f.host);
  const replay = await reopened.operate(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.outcome, first.outcome);
  assert.deepEqual(replay.projection, first.projection, "replay returns the original projection, not today's projection");
  const conflict = f.request(reserve(1, "other-attempt"), 1, "reserve-once");
  await assert.rejects(reopened.operate(conflict), code("operation_intent_conflict"));
  assert.equal((await reopened.read("group-a")).revision, 3);
  assert.equal((await reopened.read("group-a")).admission, "closed");
});

test("concurrent admission serializes revision and ceilings; a refused operation stays refused after capacity is freed", async () => {
  const f = fixture({ policy: { max_concurrent: 1 } });
  await f.create();
  const competing = await Promise.allSettled([
    f.service.operate(f.request(reserve(1), 1, "left")),
    createDelegationGroupService(createLocalFileDelegationGroupStore(f.root), f.host).operate(f.request(reserve(2), 1, "right")),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(competing.find((r) => r.status === "rejected").reason.code, "revision_conflict");
  const loser = competing[0].status === "rejected" ? 1 : 2;
  const winner = loser === 1 ? 2 : 1;
  const denied = f.request(reserve(loser), 2, "capacity-denial");
  assert.equal((await f.service.operate(denied)).outcome.code, "concurrency_ceiling");
  await settle(f, `attempt-${winner}`);
  assert.equal((await f.service.operate(denied)).outcome.code, "concurrency_ceiling");
  assert.equal((await f.act(reserve(loser), "new-intent")).outcome.status, "applied");
  assert.equal((await f.service.read("group-a")).attempts.length, 2);
});

test("token and cost ceilings reserve before intent and never reset actual spend on retry", async () => {
  for (const dimension of ["input_tokens", "output_tokens", "cost_micros"]) {
    const ceilings = { input_tokens: 100, output_tokens: 100, cost_micros: 100, [dimension]: AMOUNT[dimension] };
    const f = fixture({ policy: { ceilings } });
    await f.create();
    await f.act(reserve());
    assert.equal((await f.act(reserve(2))).outcome.code, "budget_ceiling");
    await settle(f, "attempt-1");
    assert.equal((await f.act(reserve(1, "retry"))).outcome.code, "budget_ceiling");
    const state = await f.service.read("group-a");
    assert.deepEqual(state.spent, AMOUNT);
    assert.equal(state.attempts.length, 1);
  }
});

test("lost dispatch remains invocation_unknown across restart and cannot release or redispatch its reservation", async () => {
  const f = fixture();
  await f.create();
  const intent = f.request(reserve(), 1);
  await f.service.operate(intent);
  const reopened = createDelegationGroupService(createLocalFileDelegationGroupStore(f.root), f.host);
  const state = await reopened.read("group-a");
  assert.equal(state.attempts[0].execution, "invocation_unknown");
  assert.deepEqual(state.held, AMOUNT);
  assert.equal((await reopened.operate(intent)).replayed, true);
  assert.equal((await f.act(reserve(1, "retry"))).outcome.code, "seat_unresolved");
  assert.equal((await f.act({ kind: "account", attempt_id: "attempt-1", usage: AMOUNT, receipt: ref() })).outcome.code, "confirmed_terminal_required");
  await f.act({ kind: "invoked", attempt_id: "attempt-1", invocation: ref("invoke-1") });
  assert.equal((await f.service.read("group-a")).attempts[0].execution, "invoked");
  await f.act({ kind: "mark_unknown", attempt_id: "attempt-1", receipt: ref("lost-contact") });
  assert.equal((await reopened.read("group-a")).attempts[0].execution, "invocation_unknown");
  assert.equal((await f.act({ kind: "invoked", attempt_id: "attempt-1", invocation: ref("second-invocation") })).outcome.code, "invocation_already_resolved");
});

test("cancel closes admission while terminal and cancellation receipts leave missing usage held", async () => {
  const f = fixture();
  await f.create(); await f.act(reserve());
  delete f.host.confirmEvidence;
  const cancelled = await f.act({ kind: "cancel" });
  assert.equal(cancelled.projection.admission, "closed");
  assert.deepEqual(cancelled.projection.held, AMOUNT);
  assert.equal((await f.act(reserve(2))).outcome.code, "admission_closed");
  await assert.rejects(f.act({ kind: "cancellation_confirmed", receipt: ref() }), code("evidence_confirmation_unsupported"));
  f.host.confirmEvidence = async () => ref("terminal-confirmed");
  await f.act({ kind: "cancellation_confirmed", receipt: ref("abort-all") });
  await f.act({ kind: "terminal", attempt_id: "attempt-1", outcome: "cancelled", receipt: ref(), outputs: [] });
  await assert.rejects(f.act({ kind: "account", attempt_id: "attempt-1", usage: { input_tokens: 2, output_tokens: 3 }, receipt: ref() }), code("missing_property"));
  const pending = await f.service.read("group-a");
  assert.equal(pending.cancellation, "confirmed");
  assert.equal(pending.execution, "terminal");
  assert.deepEqual(pending.held, AMOUNT, "a terminal receipt is not usage");
  await f.act({ kind: "account", attempt_id: "attempt-1", usage: { input_tokens: 2, output_tokens: 3, cost_micros: 4 }, receipt: ref() });
  const closed = await f.service.read("group-a");
  assert.deepEqual(closed.held, { input_tokens: 0, output_tokens: 0, cost_micros: 0 });
  assert.deepEqual(closed.spent, { input_tokens: 2, output_tokens: 3, cost_micros: 4 });
  assert.equal((await f.act({ kind: "join" })).outcome.code, "group_cancelled");
});

test("join is distinct from success and acceptance, and requires every seat terminal with complete accounting", async () => {
  const f = fixture(); await f.create();
  for (const seat of [1, 2, 3]) {
    await f.act(reserve(seat));
    await f.act({ kind: "terminal", attempt_id: `attempt-${seat}`, outcome: seat === 2 ? "failed" : "succeeded", receipt: ref(), outputs: [ref(`raw-${seat}`)] });
    if (seat === 3) {
      assert.equal((await f.act({ kind: "join" })).outcome.code, "join_not_accounted");
      assert.equal((await f.service.read("group-a")).join, "ready");
    }
    await f.act({ kind: "account", attempt_id: `attempt-${seat}`, usage: AMOUNT, receipt: ref() });
  }
  const joined = await f.act({ kind: "join" });
  assert.equal(joined.projection.join, "joined");
  assert.equal(joined.projection.execution, "terminal");
  assert.equal(joined.projection.acceptance, "unassessed");
  assert.equal(joined.projection.attempts[1].execution, "failed");
  assert.deepEqual(joined.projection.attempts[2].outputs, [ref("raw-3")]);
  assert.equal((await f.act(reserve(1, "late"))).outcome.code, "admission_closed");
  const ledger = await createLocalFileDelegationGroupStore(f.root).read("group-a");
  assert.deepEqual(projectDelegationGroup(ledger), await f.service.read("group-a"));
});

test("accounting overrun is retained and closes further admission; accounting cannot be replaced", async () => {
  const f = fixture(); await f.create(); await f.act(reserve());
  const usage = { ...AMOUNT, cost_micros: 500 };
  const overrun = await settle(f, "attempt-1", usage);
  assert.equal(overrun.projection.admission, "closed");
  assert.equal(overrun.projection.spent.cost_micros, 500);
  assert.equal((await f.act({ kind: "account", attempt_id: "attempt-1", usage: AMOUNT, receipt: ref() })).outcome.code, "accounting_already_recorded");
  assert.equal((await f.act(reserve(2))).outcome.code, "admission_closed");
});

test("attempt ceilings count all settled retries, and missing usage consumes concurrency", async () => {
  const f = fixture({ policy: { max_attempts: 1, max_concurrent: 1 } }); await f.create(); await f.act(reserve());
  await f.act({ kind: "terminal", attempt_id: "attempt-1", outcome: "failed", receipt: ref(), outputs: [] });
  assert.equal((await f.act(reserve(1, "retry"))).outcome.code, "seat_unresolved");
  await f.act({ kind: "account", attempt_id: "attempt-1", usage: AMOUNT, receipt: ref() });
  assert.equal((await f.act(reserve(1, "retry2"))).outcome.code, "attempt_ceiling");
  const g = fixture({ policy: { max_concurrent: 1 } }); await g.create(); await g.act(reserve());
  await g.act({ kind: "terminal", attempt_id: "attempt-1", outcome: "succeeded", receipt: ref(), outputs: [] });
  assert.equal((await g.act(reserve(2))).outcome.code, "concurrency_ceiling");
});

test("controller takeover advances an explicit fence; old controller and stale revisions fail before host callbacks", async () => {
  const f = fixture(); await f.create();
  const successor = { controller_id: "controller-b", epoch: 2 };
  await f.act({ kind: "take_control", successor });
  const calls = f.calls.length;
  await assert.rejects(f.act(reserve()), code("controller_fence_conflict"));
  await assert.rejects(f.service.operate(f.request(reserve(), 1, "stale", successor)), code("revision_conflict"));
  assert.equal(f.calls.length, calls);
  assert.equal((await f.act(reserve(), "new-controller", successor)).outcome.status, "applied");
});

test("missing host capabilities and changed envelope authority refuse before persisting an intent", async () => {
  for (const capability of ["confirmReadiness", "confirmBudgetEnforcement"]) {
    const f = fixture(); await f.create(); delete f.host[capability];
    await assert.rejects(f.act(reserve()), code(capability === "confirmReadiness" ? "claimed_readiness_unsupported" : "budget_enforcement_unsupported"));
    assert.equal((await f.service.read("group-a")).revision, 1);
  }
  const f = fixture(); await f.create(); f.envelopes[1].source = { ...SOURCE, worktree_id: "changed" };
  await assert.rejects(f.act(reserve()), code("envelope_identity_mismatch"));
  const g = fixture(); await g.create(); g.expire();
  await assert.rejects(g.act(reserve()), /expired/);
  assert.equal((await g.service.read("group-a")).attempts.length, 0);
  await g.act({ kind: "cancel" });
  assert.equal((await g.service.read("group-a")).admission, "closed", "expired execution authority does not prevent closing admission");
});

test("independent envelope identities allow model diversity but never widen envelope v1 or writer/source authority", async () => {
  const f = fixture(); await f.create(); await f.act(reserve());
  assert.notEqual(f.envelopes[0].runtime.model_receipt_ref, f.envelopes[1].runtime.model_receipt_ref);
  for (const adjustEnvelopes of [
    (e) => { e[1].authority.posture = "writer"; },
    (e) => { e[1].source = { ...SOURCE, worktree_id: "lane-b" }; },
    (e) => { e[1].revisions.policy_revision = "other-policy"; },
  ]) {
    const g = fixture({ adjustEnvelopes });
    await assert.rejects(g.create(), (error) => ["writer_envelope_unsupported", "envelope_source_mismatch", "envelope_policy_mismatch"].includes(error.code));
    assert.equal(await g.service.read("group-a"), null);
  }
});

test("Flow admission consumes a host-confirmed current claimed frontier and never schedules a competing DAG", async () => {
  const definition = { id: "definition", version: "1", digest: `sha256:${"b".repeat(64)}` };
  const f = fixture({ topology: { kind: "flow", run_id: "run-a", definition_digest: definition.digest }, adjustEnvelopes(envelopes) {
    envelopes.forEach((e, i) => { e.flow_binding = { status: "bound", flow_run_id: "run-a", flow_step_id: i === 0 ? "parent-step" : `step-${i}`, gate_attempt: 0 }; });
  } });
  await f.create();
  await assert.rejects(f.act(reserve()), code("flow_claim_required"));
  const claim = { schema_version: "1", claim_id: "claim", liveness_id: "live", run_id: "run-a", definition,
    claim_base: { schema_version: "1", step_id: "step-1", head: "flow-head" }, step_id: "step-1", actor: { key: "actor-2" },
    mutable_resources: [], issued_at: NOW, renewed_at: NOW, expires_at: "2026-10-21T13:00:00.000Z" };
  const frontier = { schema_version: "1", run_id: "run-a", definition, run_head: "flow-head", ready_steps: [] };
  f.host.confirmReadiness = async () => ({ kind: "flow_claim", reference: ref("flow-readiness"), claim, frontier });
  await assert.rejects(f.act(reserve()), code("flow_claim_mismatch"));
  frontier.ready_steps = [{ step_id: "step-1", mutable_resources: [] }];
  claim.claim_base.head = "stale-head";
  await assert.rejects(f.act(reserve()), code("flow_claim_mismatch"));
  claim.claim_base.head = "flow-head";
  assert.equal((await f.act(reserve())).outcome.status, "applied");
});

test("closed contract bounds reject oversized seats, metadata, output paths, recursion, and tampered policies", async () => {
  const f = fixture();
  for (const change of [
    (s) => { s.seats = Array.from({ length: 65 }, () => s.seats[0]); },
    (s) => { s.metadata = { model: "alternate" }; },
    (s) => { s.recursion = { kind: "recursive", depth: 1 }; },
    (s) => { s.parent_envelope.generation = 1; },
    (s) => { s.worktree_mode = "isolated_writers"; },
    (s) => { s.policy.ceilings.cost_micros++; },
    (s) => { s.policy.join = "majority"; },
  ]) {
    const spec = structuredClone(f.spec); change(spec);
    assert.throws(() => validateDelegationGroupSpec(spec));
  }
  await f.create(); await f.act(reserve());
  const original = await f.store.read("group-a");
  for (const output of [ { ...ref(), id: "../../private" }, { ...ref(), path: "/etc/passwd" }, { ...ref(), provenance: "x".repeat(10000) }, { ...ref(), byte_length: Number.MAX_SAFE_INTEGER } ]) {
    await assert.rejects(f.act({ kind: "terminal", attempt_id: "attempt-1", outcome: "succeeded", receipt: ref(), outputs: [output] }));
  }
  await assert.rejects(f.act({ kind: "terminal", attempt_id: "attempt-1", outcome: "succeeded", receipt: ref(), outputs: Array(17).fill(ref()) }), code("output_bounds"));
  assert.deepEqual(await f.store.read("group-a"), original);
});

test("ledger corruption and unsafe file aliases fail closed, while atomic-store replay preserves bytes", async () => {
  const f = fixture(); const create = f.request({ kind: "create", spec: f.spec }, 0); await f.service.operate(create);
  const directory = path.join(f.root, "delegation-groups");
  const file = path.join(directory, `${createHash("sha256").update("group-a").digest("hex")}.json`);
  const bytes = fs.readFileSync(file);
  await f.service.operate(create);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const ledger = JSON.parse(bytes);
  ledger.events[0].outcome.code = "invented";
  fs.writeFileSync(file, JSON.stringify(ledger));
  await assert.rejects(f.service.read("group-a"), code("outcome_mismatch"));
  fs.writeFileSync(file, "{");
  await assert.rejects(f.service.read("group-a"), SyntaxError);
  fs.unlinkSync(file);
  const outside = path.join(f.root, "outside.json"); fs.writeFileSync(outside, bytes);
  fs.symlinkSync(outside, file);
  await assert.rejects(f.service.read("group-a"));
  assert.deepEqual(fs.readFileSync(outside), bytes);
});

test("separate OS processes contend for one durable admission without lost updates", async () => {
  const f = fixture(); await f.create();
  const worker = path.join(f.root, "worker.mjs");
  const serviceUrl = new URL("../../build/src/delegation-group.js", import.meta.url).href;
  const storeUrl = new URL("../../build/src/delegation-group-local-file.js", import.meta.url).href;
  fs.writeFileSync(worker, `
    import { createDelegationGroupService } from ${JSON.stringify(serviceUrl)};
    import { createLocalFileDelegationGroupStore } from ${JSON.stringify(storeUrl)};
    const data = JSON.parse(process.argv[2]);
    const receipt = ${JSON.stringify(ref())};
    const host = { now: () => ${JSON.stringify(NOW)},
      resolveAuthorizedEnvelope: async id => ({ envelope: data.envelopes.find(e => e.envelope_id === id.envelope_id), authorization: receipt }),
      confirmController: async () => receipt, confirmReadiness: async () => ({ kind: "independent", reference: receipt }), confirmBudgetEnforcement: async () => receipt };
    const service = createDelegationGroupService(createLocalFileDelegationGroupStore(data.root), host);
    try { const result = await service.operate(data.request); process.stdout.write(result.outcome.code); }
    catch (error) { process.stdout.write(error.code ?? error.message); process.exitCode = 2; }
  `);
  const run = (seat) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, JSON.stringify({ root: f.root, envelopes: f.envelopes, request: f.request(reserve(seat), 1, `process-${seat}`) })], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (exit) => resolve({ exit, stdout, stderr }));
  });
  const results = await Promise.all([run(1), run(2)]);
  assert.deepEqual(results.map((r) => r.stdout).sort(), ["reserve", "revision_conflict"]);
  assert.deepEqual(results.map((r) => r.exit).sort(), [0, 2]);
  const state = await createDelegationGroupService(createLocalFileDelegationGroupStore(f.root), f.host).read("group-a");
  assert.equal(state.attempts.length, 1);
  assert.deepEqual(state.held, AMOUNT);
});


test("an envelope cannot acquire a fresh budget through a second group, including concurrent group creation", async () => {
  const f = fixture();
  const otherSpec = { ...structuredClone(f.spec), group_id: "group-b" };
  const body = { schema_version: "1.0", group_id: "group-b", operation_id: "create-b", expected_revision: 0, fence: FENCE, action: { kind: "create", spec: otherSpec } };
  const other = { ...body, request_digest: groupRequestDigest(body) };
  const results = await Promise.allSettled([f.create(), f.service.operate(other)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "envelope_already_group_bound");
  const existing = await f.service.read("group-a") ?? await f.service.read("group-b");
  assert.equal(existing.revision, 1);
});


test("lost commit acknowledgement reopens the original reservation without a second intent", async () => {
  const f = fixture(); await f.create();
  const request = f.request(reserve(), 1, "lost-ack");
  const interrupted = createDelegationGroupService({
    read: f.store.read,
    async transact(groupId, body) {
      await f.store.transact(groupId, body);
      throw new Error("transport acknowledgement lost after durable commit");
    },
  }, f.host);
  await assert.rejects(interrupted.operate(request), /acknowledgement lost/);
  const reopened = createDelegationGroupService(createLocalFileDelegationGroupStore(f.root), f.host);
  const recovered = await reopened.operate(request);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.projection.attempts.length, 1);
  assert.equal(recovered.projection.attempts[0].execution, "invocation_unknown");
  assert.deepEqual(recovered.projection.held, AMOUNT);
});


test("authorization expiring while host capabilities are checked cannot persist a dispatch intent", async () => {
  const f = fixture(); await f.create();
  f.host.confirmController = async () => { f.expire(); return ref("late-controller"); };
  await assert.rejects(f.act(reserve()), /expired/);
  const state = await f.service.read("group-a");
  assert.equal(state.revision, 1);
  assert.deepEqual(state.attempts, []);
});
