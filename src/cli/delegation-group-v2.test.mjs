import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { definitionIdentity, loadRun, startRun } from "@kontourai/flow";
import { FileAuthorizationLedger } from "@kontourai/dispatch";
import { createDelegationAuthorityService } from "../../build/src/delegation-authority-service.js";
import { createLocalFileDelegationAuthorityStore } from "../../build/src/delegation-authority-local-file.js";
import { delegationEnvelopeDigestV2, delegationParentReferenceV2, rootAuthorityReferenceV2 } from "../../build/src/delegation-envelope-v2.js";
import { createDelegationGroupControllerV2 } from "../../build/src/delegation-group-v2.js";
import { createLocalFileDelegationGroupStoreV2 } from "../../build/src/delegation-group-v2-local-file.js";

const NOW = "2026-10-21T12:00:00.000Z", EXPIRY = "2026-10-22T12:00:00.000Z";
const ref = id => ({ id, domain: "fixture-receipt", digest: `sha256:${createHash("sha256").update(id).digest("hex")}` });
const fence = { id: "host-controller", generation: 3 };
const allocation = { inputTokens: 5, outputTokens: 5, costMicros: 10 };
function authorityFixture(flow, options = {}) {
  const ceiling = { allowed_tools: [], allowed_effects: ["read"], readable_resources: [], mutable_resources: [], posture: "report-only", approval: "requires_approval", escalation: "deny" };
  const budget = { remaining_depth: 3, max_total_children: 4, max_total_envelopes: 8, max_concurrent_children: 2,
    max_runtime_ms: 60000, max_input_tokens: 1000, max_output_tokens: 1000, max_cost_micros: 1000, max_attempts: 4, expires_at: options.rootExpiry ?? EXPIRY };
  const grants = ["first", "second"].map(step => ({ grant_id: `grant-${step}`,
    runtime: { runtime_receipt_ref: ref(`runtime-${step}`), model_receipt_ref: ref(`model-${step}`), required_capabilities: ["usage", "abort"] },
    source: { repository_id: "fixture", source_state_id: "exact-source", dirty_state_fingerprint: null, execution_worktree_id: `worktree-${step}`, source_admission_receipt: ref(`source-${step}`) },
    flow_binding: flow ? { status: "bound", flow_run_id: flow.runId, definition: flow.identity, flow_step_id: step, gate_attempt: 1 } : { status: "unbound", reason: "Independent advisory fixture" },
    authority_ceiling: structuredClone(ceiling) }));
  const root = { schema_version: "2.0", authority_id: "root", authority_epoch: 1, issuer_host_id: "fixture-host",
    authenticated_principal_ref: ref("principal"), authenticated_subject_ref: ref("subject"),
    source_origin: { repository_id: "fixture", worktree_id: "worktree-first", source_state_id: "exact-source", dirty_state_fingerprint: null },
    execution_worktree_ids: ["worktree-first", "worktree-second"], execution_grants: grants,
    delegation_ceiling: structuredClone(ceiling), budget, revisions: { policy: ref("policy"), prompt: ref("prompt"), rubric: ref("rubric") },
    root_trace: { trace_id: "trace", span_id: "root-span" }, root_cancellation_ref: ref("root-cancellation") };
  const binding = g => ({ runtime: g.runtime, source: g.source, flow_binding: g.flow_binding });
  const parent = { schema_version: "2.0", envelope_id: "parent", generation: 0, parent: null, root_authority_ref: rootAuthorityReferenceV2(root),
    execution_id: "parent-execution", actor: root.authenticated_principal_ref, assignment_subject: root.authenticated_subject_ref,
    trace_id: "trace", span_id: "root-span", parent_span_id: null, selected_grant_id: "grant-first", remaining_allowed_grant_ids: grants.map(g => g.grant_id),
    execution_binding: binding(grants[0]), execution_authority: structuredClone(ceiling), delegation_ceiling: structuredClone(ceiling),
    budget: structuredClone(budget), continuation_ref: ref("continuation"), cancellation_ref: root.root_cancellation_ref };
  const child = { ...structuredClone(parent), envelope_id: "child", generation: 1, parent: delegationParentReferenceV2(parent),
    execution_id: "child-execution", span_id: "child-span", parent_span_id: "root-span", selected_grant_id: "grant-second", execution_binding: binding(grants[1]),
    budget: { ...budget, remaining_depth: 2, max_total_envelopes: 3, max_attempts: 1, max_input_tokens: 100, max_output_tokens: 100, max_cost_micros: 100, expires_at: options.childExpiry ?? budget.expires_at } };
  return { root, envelopes: [parent, child] };
}
async function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-group-v2-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let flow;
  if (options.flow) {
    const expects = required => [{ id: "observation", kind: "trust.bundle", required, description: "Host must supply evidence", bundle_claim: { claimType: "fixture.report" } }];
    const definition = { id: "group-flow", version: options.version ?? "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
      steps: [{ id: "first", next: null, mutable_resources: [] }, { id: "second", next: null, needs: ["first"], mutable_resources: [] }],
      gates: { first: { step: "first", expects: expects(options.required ?? false) }, second: { step: "second", expects: expects(false) } } };
    const file = path.join(cwd, "fixture.flow.json"); fs.writeFileSync(file, JSON.stringify(definition));
    flow = { runId: "group-flow-run", identity: definitionIdentity(definition) };
    await startRun(file, { cwd, runId: flow.runId, params: { subject: "fixture" } });
  }
  const { root, envelopes } = authorityFixture(flow, options);
  const state = { allowed: true, authorityAllowed: true, currentGeneration: 3, calls: 0, cancellations: 0, retained: [], outcomes: [], schedules: [], launches: [], fail: false, unknownUsage: false };
  const authorityHost = { now: () => NOW, authorize: async () => state.authorityAllowed, confirmExecution: async () => state.authorityAllowed, confirmReconciliation: async () => state.authorityAllowed };
  const openAuthority = () => createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(cwd), authorityHost);
  const service = openAuthority(); await service.issue(root);
  for (const envelope of envelopes) await service.derive(root.authority_id, envelope);
  const spec = { schemaVersion: "2.0", groupId: "group", rootAuthorityRef: rootAuthorityReferenceV2(root), controller: fence,
    policy: { reference: root.revisions.policy, maxConcurrent: options.maxConcurrent ?? 1 },
    topology: flow ? { kind: "flow", runId: flow.runId, definition: flow.identity, actor: { key: "fixture-host", kind: "test" } } : { kind: "independent-advisory" },
    seats: envelopes.slice(0, options.oneSeat ? 1 : 2).map((envelope, i) => ({ seatId: `seat-${i}`, envelope: { id: envelope.envelope_id, generation: envelope.generation, digest: delegationEnvelopeDigestV2(envelope) },
      stepId: flow ? ["first", "second"][i] : null, effect: "read", allocation: structuredClone(allocation) })) };
  let controller;
  let retainedId = 0;
  function retain(value) {
    const id = `retained-${++retainedId}`, bytes = JSON.stringify(value);
    const file = path.join(cwd, `${id}.json`);
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { id, domain: 'fixture-retained', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  }
  const runtime = { id: "controlled", capabilities: () => ({ structuredTools: false, outputTokenLimitFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke() {
      state.calls++;
      state.inFlight = (state.inFlight ?? 0) + 1; state.maxInFlight = Math.max(state.maxInFlight ?? 0, state.inFlight);
      try {
      if (state.onInvoke) await state.onInvoke();
      if (state.fail) throw new Error("controlled native failure");
      return { provider: "fixture", model: "configured", outputText: "Advisory dissent: do not accept without evidence", toolCalls: [],
        usage: state.unknownUsage ? {} : { inputTokens: 1, outputTokens: 2, costUsd: 0.000003 }, latencyMs: 1 };
      } finally { state.inFlight--; }
    } };
  const host = {
    async authorize({ spec: target, current, action }) {
      state.lastAuth = { current, action };
      return state.allowed && (!target || target.controller.generation === state.currentGeneration) ? ref("current-caller-custody") : null;
    },
    executionHost: () => ({
      async resolveRuntime(envelope) { return { runtime, runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref, modelReceipt: envelope.execution_binding.runtime.model_receipt_ref }; },
      async invokeFenced(envelope, id, launch) {
        // This controlled host checks its own custody. Production must enforce it atomically across launch.
        assert.equal(state.allowed, true); assert.equal(state.currentGeneration, fence.generation);
        const p = await controller.get(spec.groupId); assert.equal(p.cancellation, "none");
        assert.ok(p.members.some(m => m.seatId === spec.seats.find(s => s.envelope.id === envelope.envelope_id).seatId));
        const invocation = (await openAuthority().inspect(root.authority_id)).invocations.find(i => i.invocationId === id);
        assert.equal(invocation.terminal, false); state.launches.push(id);
        return launch();
      },
      async retainResult(result) { retain(result); state.retained.push(result); }, async retainFailure(error) { retain({ error: error.message }); state.retained.push(error); },
      async recordScheduleEvent(event) { state.schedules.push(event); }, async confirmClaim() { return !state.denyClaim; },
      async prepareRequest() { return { messages: [{ role: "user", content: "Report independently" }], maxOutputTokens: 5 }; },
      async recordMemberOutcome(_claim, _envelope, outcome) { state.outcomes.push(outcome); },
    }),
    async prepareIndependentRequest() { return { messages: [{ role: "user", content: "Report independently" }], maxOutputTokens: 5 }; },
    async retainMemberOutcome(_spec, _seat, outcome) {
      state.outcomes.push(outcome);
      return { outcomeRef: retain(outcome), dissentRefs: [retain({ dissent: "Do not accept without evidence" })], uncertaintyRefs: state.unknownUsage ? [retain({ uncertainty: "usage unknown" })] : [] };
    },
    async retainRunObservation(_spec, observation) { state.observation = observation; return retain(observation); },
    async retainRunFailure(_spec, error) { state.error = error; return retain({ error: error.message, causes: error.errors?.map(e => e.message) ?? [] }); },
    async requestDescendantCancellation() {
      assert.equal((await controller.get(spec.groupId)).cancellation, "pending");
      assert.equal((await openAuthority().inspect(root.authority_id)).cancelled, true);
      state.cancellations++; return ref("cancellation-request");
    },
  };
  const open = (overrides = {}) => createDelegationGroupControllerV2({ store: createLocalFileDelegationGroupStoreV2(cwd), authorityService: openAuthority(),
    dispatchLedger: new FileAuthorizationLedger({ root: path.join(cwd, "dispatch") }), host: { ...host, ...overrides }, cwd });
  controller = open();
  const command = (kind, revision, operationKey = kind) => ({ kind, groupId: spec.groupId, operationKey, expectedRevision: revision, controller: structuredClone(fence), ...(kind === "create" ? { spec: structuredClone(spec) } : {}) });
  const create = command("create", 0); await controller.create(create);
  return { cwd, spec, state, host, open, service, openAuthority, controller, command, create };
}

test("v2 persists immutable membership, authenticates reads/list/replay with current custody and rejects conflicting intent", async t => {
  const f = await fixture(t), { controller: c, state, command, create } = f;
  assert.equal((await f.open().get("group")).revision, 1);
  assert.equal((await c.list()).length, 1);
  // A differently ordered object has the same canonical intent.
  assert.equal((await c.create(Object.fromEntries(Object.entries(create).reverse()))).replayed, true);
  const conflict = structuredClone(create); conflict.spec.seats[0].allocation.inputTokens++;
  await assert.rejects(c.create(conflict), /operation_intent_conflict/);
  await assert.rejects(c.run({ ...command("run", 1), controller: { ...fence, generation: 4 } }), /controller_fence_conflict/);
  await assert.rejects(c.run(command("run", 0)), /group_revision_conflict/);
  assert.equal((await c.events("group")).length, 1);
  for (const boundary of ["allowed", "authorityAllowed"]) {
    state[boundary] = false;
    for (const operation of [() => c.get("group"), () => c.get("missing"), () => c.events("group"), () => c.list(), () => c.create(create), () => c.run(command("run", 1))]) await assert.rejects(operation());
    state[boundary] = true;
  }
  state.currentGeneration = 4;
  await assert.rejects(c.create(create), /group_host_authorization_refused/);
  state.currentGeneration = 3;
  assert.equal((await c.get("group")).execution, "idle");
  assert.equal(state.calls, 0);
});

test("independent advisory execution retains raw dissent, commits before launch and never promotes success or replays effects", async t => {
  const f = await fixture(t), run = f.command("run", 1);
  const result = await f.controller.run(run);
  assert.equal(f.state.calls, 2);
  assert.equal(result.projection.execution, "returned"); assert.equal(result.projection.acceptance, "unassessed"); assert.equal(result.projection.terminal, "unproven");
  assert.deepEqual(result.projection.members.map(m => m.observation.outcome), ["succeeded", "succeeded"]);
  for (const member of result.projection.members) {
    const readReference = reference => {
      const bytes = fs.readFileSync(path.join(f.cwd, `${reference.id}.json`));
      assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, reference.digest);
      return JSON.parse(bytes);
    };
    assert.equal(readReference(member.observation.outcomeRef).outcome, 'succeeded');
    assert.equal(readReference(member.observation.dissentRefs[0]).dissent, 'Do not accept without evidence');
  }
  assert.equal(f.state.maxInFlight, 1);
  assert.ok(f.state.retained.every(r => r.outputText.includes("dissent")));
  const before = await f.controller.events("group");
  assert.equal((await f.open().run(run)).replayed, true);
  await assert.rejects(f.open().run(f.command("run", result.projection.revision, "new-key")), /group_run_already_admitted/);
  assert.equal(f.state.calls, 2); assert.deepEqual(await f.open().events("group"), before);
  const cancel = f.command("cancel", result.projection.revision);
  assert.equal((await f.controller.cancel(cancel)).projection.terminal, "unproven");
  assert.equal((await f.open().cancel(cancel)).replayed, true); assert.equal(f.state.cancellations, 1);
  assert.equal((await f.open().run(run)).projection.cancellation, "requested");
  assert.equal(f.state.lastAuth.current.cancellation, "requested");
  f.state.allowed = false;
  await assert.rejects(f.open().run(run), /group_host_authorization_refused/);
  assert.equal(f.state.calls, 2);
});

for (const required of [false, true]) test(`public Flow owns dependencies and gate evaluation (required evidence: ${required})`, async t => {
  const f = await fixture(t, { flow: true, required, version: "1.0.0+build.7" });
  const result = await f.controller.run(f.command("run", 1));
  const run = await loadRun(f.spec.topology.runId, f.cwd);
  assert.equal(f.state.calls, required ? 1 : 2);
  if (required) {
    assert.notEqual(run.state.status, "completed");
    assert.deepEqual(result.projection.members.map(m => m.seatId), ["seat-0"]);
    assert.ok(!f.state.schedules.some(e => e.kind === "started" && e.stepId === "second"));
  } else {
    assert.equal(run.state.status, "completed");
    const settled = f.state.schedules.findIndex(e => e.kind === "settled" && e.stepId === "first");
    const second = f.state.schedules.findIndex(e => e.kind === "started" && e.stepId === "second");
    assert.ok(settled >= 0 && second > settled);
  }
  assert.equal(result.projection.acceptance, "unassessed"); assert.equal(result.projection.terminal, "unproven");
  assert.equal((await f.open().run(f.command("run", 1))).replayed, true);
});

test("denied current Flow claim persists an ambiguous run without authority invocation or redispatch", async t => {
  const f = await fixture(t, { flow: true }); f.state.denyClaim = true;
  const run = f.command("run", 1); await assert.rejects(f.controller.run(run));
  assert.equal((await f.service.inspect("root")).invocations.length, 0); assert.equal(f.state.calls, 0);
  f.state.denyClaim = false;
  assert.equal((await f.open().run(run)).projection.execution, "execution_unknown");
  assert.equal(f.state.calls, 0);
});

for (const failure of ["fail", "unknownUsage"]) test(`raw ${failure} retains uncertainty and ancestor capacity after reopen`, async t => {
  const f = await fixture(t); f.state[failure] = true;
  let result;
  if (failure === "unknownUsage") {
    await assert.rejects(f.controller.run(f.command("run", 1)), /Independent group execution unknown/);
    result = { projection: await f.open().get("group") };
    assert.equal(result.projection.execution, "execution_unknown");
    assert.equal(result.projection.members[0].observation, null);
    await f.openAuthority().reserveInvocation("root", "child", "additional-held-slot", allocation);
  } else result = await f.controller.run(f.command("run", 1));
  const ledger = await f.openAuthority().inspect("root");
  assert.ok(ledger.invocations.length > 0); assert.ok(ledger.invocations.every(i => i.usage === null));
  assert.equal(result.projection.terminal, "unproven");
  if (failure === "fail") assert.equal(result.projection.members[0].observation.outcome, "exhausted");
  await assert.rejects(f.openAuthority().reserveInvocation("root", "child", "retry-child", allocation), /active_slot_exhausted/);
  assert.ok(f.state.retained.length > 0);
});

test("cancellation during launch closes admission before requesting descendants and preserves unknown holds", async t => {
  const f = await fixture(t);
  f.state.onInvoke = async () => {
    const p = await f.controller.get("group");
    const cancelled = await f.open().cancel(f.command("cancel", p.revision));
    assert.equal(cancelled.projection.cancellation, "requested");
    f.state.fail = true;
  };
  await assert.rejects(f.controller.run(f.command("run", 1)), /Independent group execution unknown/);
  const p = await f.open().get("group");
  assert.equal(p.cancellation, "requested"); assert.equal(p.execution, "execution_unknown"); assert.equal(p.terminal, "unproven");
  assert.equal(f.state.calls, 1); assert.equal(f.state.cancellations, 1);
  assert.equal((await f.openAuthority().inspect("root")).invocations[0].usage, null);
});

function child(script, cwd, args = []) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", script, cwd, ...args], { cwd: globalThis.process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; process.stdout.on("data", b => stdout += b); process.stderr.on("data", b => stderr += b);
    process.on("error", reject); process.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
const childImports = `
import fs from 'node:fs';
import { createDelegationGroupControllerV2 } from './build/src/delegation-group-v2.js';
import { createLocalFileDelegationGroupStoreV2 } from './build/src/delegation-group-v2-local-file.js';
import { createDelegationAuthorityService } from './build/src/delegation-authority-service.js';
import { createLocalFileDelegationAuthorityStore } from './build/src/delegation-authority-local-file.js';
const cwd = process.argv[1];
const authorityService = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(cwd), { now: () => '${NOW}', authorize: async () => true, confirmExecution: async () => true });
const reference = ${JSON.stringify(ref("child-host"))};
const host = { authorize: async () => reference, executionHost() { throw new Error('crash before launch'); }, retainRunFailure() { process.exit(73); } };
const controller = createDelegationGroupControllerV2({ store: createLocalFileDelegationGroupStoreV2(cwd), authorityService, host, dispatchLedger: {} });
`;

test("separate-process invocation crash preserves ancestor hold and recovery cannot redispatch", async t => {
  const f = await fixture(t, { oneSeat: true }); const run = f.command("run", 1);
  fs.writeFileSync(path.join(f.cwd, "command.json"), JSON.stringify(run));
  const script = childImports.replace("dispatchLedger: {}", "dispatchLedger: new FileAuthorizationLedger({ root: cwd + '/dispatch' })");
  const result = await child(`import { FileAuthorizationLedger } from '@kontourai/dispatch';\n` + script + `
const runtime = { id: 'controlled', capabilities: () => ({ structuredTools: false, outputTokenLimitFidelity: 'native', streaming: false, abort: true, usage: true }),
  async invoke() { fs.writeFileSync(cwd + '/physical-invocation', 'started', { flag: 'wx' }); process.exit(73); } };
host.executionHost = () => ({
  async resolveRuntime(envelope) { return { runtime, runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref, modelReceipt: envelope.execution_binding.runtime.model_receipt_ref }; },
  invokeFenced: async (_envelope, _id, invoke) => invoke(), retainResult: async () => {}, retainFailure: async () => {},
});
host.prepareIndependentRequest = async () => ({ maxOutputTokens: 5, messages: [{ role: 'user', content: 'observe' }] });
await controller.run(JSON.parse(fs.readFileSync(cwd + '/command.json')));`, f.cwd);
  assert.equal(result.code, 73, result.stderr);
  // Launch is outside the store transaction, so durable recovery does not need stale-lock takeover.
  const recovered = await f.open().run(run);
  assert.equal(recovered.replayed, true); assert.equal(recovered.projection.execution, "execution_unknown"); assert.equal(f.state.calls, 0);
  const ledger = await f.openAuthority().inspect("root");
  assert.equal(ledger.invocations.length, 1);
  assert.equal(ledger.invocations[0].terminal, false); assert.equal(ledger.invocations[0].usage, null);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'physical-invocation'), 'utf8'), 'started');
  await assert.rejects(f.open().run(f.command('run', recovered.projection.revision, 'new-run')), /group_run_already_admitted/);
  const terminal = { ...f.command('terminal', recovered.projection.revision), seatId: 'seat-0', invocationId: ledger.invocations[0].invocationId,
    observation: { outcome: 'aborted', outcomeRef: ref('process-exited-73'), dissentRefs: [], uncertaintyRefs: [] } };
  await assert.rejects(f.controller.recordTerminal(terminal), /terminal_accounting_unconfirmed/);
  await f.openAuthority().reconcileInvocation('root', ledger.invocations[0].invocationId, { inputTokens: 1, outputTokens: 1, costMicros: 1 }, true);
  await assert.rejects(f.controller.recordTerminal(terminal), /terminal_host_proof_required/);
  const reconciler = f.open({ confirmTerminal: async () => ref('authenticated-descendant-terminal') });
  const proof = await reconciler.recordTerminal(terminal);
  assert.equal(proof.projection.terminal, 'proven'); assert.equal(proof.projection.acceptance, 'unassessed');
  assert.equal(proof.projection.execution, 'execution_unknown');
  assert.equal((await reconciler.recordTerminal(terminal)).replayed, true);
  assert.equal(f.state.calls, 0);
});

test("cross-process creation serializes exclusive root custody", async t => {
  const f = await fixture(t);
  const directory = path.join(f.cwd, "delegation-groups-v2");
  fs.unlinkSync(path.join(directory, fs.readdirSync(directory).find(n => n.endsWith(".json"))));
  const script = childImports + `
const value = JSON.parse(fs.readFileSync(cwd + '/create.json'));
value.groupId = value.spec.groupId = process.argv[2];
try { await controller.create(value); console.log('created'); }
catch (error) { console.log(error.code); if (error.code !== 'group_authority_already_bound') process.exitCode = 8; }
`;
  fs.writeFileSync(path.join(f.cwd, "create.json"), JSON.stringify(f.create));
  const results = await Promise.all([child(script, f.cwd, ["contender-a"]), child(script, f.cwd, ["contender-b"])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(results.map(r => r.stdout.trim()).sort(), ["created", "group_authority_already_bound"]);
  assert.equal((await f.open().list()).length, 1);
});

test("private durable files reject aliases, repair lost publish acknowledgement, and escrow future records", async t => {
  const f = await fixture(t), directory = path.join(f.cwd, "delegation-groups-v2");
  const file = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith(".json")));
  const alias = path.join(f.cwd, "alias"); fs.linkSync(file, alias);
  await assert.rejects(f.open().get("group"), /unsafe_group_file/); fs.unlinkSync(alias);
  const old = fs.readFileSync(file);
  const length = Buffer.byteLength;
  try {
    Buffer.byteLength = function(value, encoding) {
      if (typeof value === "string" && value.includes('"events":') && value.includes('"run_pending"')) return 32 * 1024 * 1024 - 1;
      return length(value, encoding);
    };
    await assert.rejects(f.controller.run(f.command("run", 1)), /group_capacity_exhausted/);
  } finally { Buffer.byteLength = length; }
  assert.equal(f.state.calls, 0); assert.deepEqual(fs.readFileSync(file), old);
  const sync = fs.fsyncSync, open = fs.openSync, rename = fs.renameSync;
  const temps = new Set();
  try {
    fs.openSync = function(file, ...args) { const fd = open(file, ...args); if (String(file).includes('.flow-agents-')) temps.add(fd); return fd; };
    fs.fsyncSync = fd => { if (temps.has(fd)) throw new Error("temporary flush injection"); return sync(fd); };
    syncBuiltinESMExports();
    await assert.rejects(f.controller.cancel(f.command("cancel", 1)), /temporary flush injection/);
  } finally { fs.openSync = open; fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(file), old); assert.equal(f.state.cancellations, 0);
  let published = false;
  const cancel = f.command("cancel", 1);
  try {
    fs.renameSync = (...args) => { rename(...args); published = true; };
    fs.fsyncSync = fd => { if (published) throw new Error("published flush injection"); return sync(fd); };
    syncBuiltinESMExports();
    await assert.rejects(f.controller.cancel(cancel), /published flush injection/);
    assert.equal(published, true);
    await assert.rejects(f.controller.get("group"), /published flush injection/);
  } finally { fs.renameSync = rename; fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal((await f.open().get("group")).cancellation, "pending");
  assert.equal((await f.open().cancel(cancel)).replayed, true);
  assert.equal(f.state.cancellations, 0);
  const missing = path.join(f.cwd, "missing"); assert.throws(() => createLocalFileDelegationGroupStoreV2(missing), /ENOENT/);
  fs.symlinkSync(f.cwd, path.join(f.cwd, "linked-root"));
  assert.throws(() => createLocalFileDelegationGroupStoreV2(path.join(f.cwd, "linked-root")), /private_preexisting_group_root_required/);
});

test("bounded advisory workers overlap only within the frozen concurrency policy", async t => {
  const f = await fixture(t, { maxConcurrent: 2 });
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  f.state.onInvoke = async () => { if (f.state.calls === 2) release(); await bothStarted; };
  const result = await f.controller.run(f.command("run", 1));
  assert.equal(f.state.calls, 2); assert.equal(f.state.maxInFlight, 2);
  assert.equal(result.projection.members.length, 2); assert.equal(result.projection.acceptance, "unassessed");
});

test("creation requires registered ancestor-service grants and immutable exact envelope/policy identity", async t => {
  const f = await fixture(t);
  for (const [code, change] of [
    ["group_envelope_mismatch", s => s.seats[0].envelope.generation++],
    ["group_envelope_mismatch", s => s.seats[0].envelope.digest = ref("substituted").digest],
    ["envelope_missing", s => s.seats[0].envelope.id = "unregistered"],
    ["group_policy_inactive", s => s.policy.reference = ref("substituted-policy")],
    ["group_root_authority_mismatch", s => s.rootAuthorityRef.authority_epoch++],
    ["group_allocation_exceeded", s => s.seats[1].allocation.outputTokens = 101],
    ["group_concurrency_exceeded", s => s.policy.maxConcurrent = 3],
  ]) {
    const request = structuredClone(f.create); request.spec.groupId = request.groupId = "invalid-group";
    change(request.spec);
    await assert.rejects(f.controller.create(request), error => error.code === code);
  }
  const altered = (await f.controller.get("group")).spec; altered.seats[0].allocation.inputTokens = 999;
  assert.equal((await f.open().get("group")).spec.seats[0].allocation.inputTokens, 5);
  assert.equal((await f.controller.events("group")).length, 1); assert.equal(f.state.calls, 0);
});

test("pre-abort consumes no intent; lost cancellation callback leaves durable pending and never repeats the request", async t => {
  const f = await fixture(t), run = f.command("run", 1);
  await assert.rejects(f.controller.run(run, { signal: AbortSignal.abort() }));
  assert.equal((await f.controller.get("group")).revision, 1);
  let requests = 0;
  const c = f.open({ async requestDescendantCancellation() { requests++; throw new Error("lost cancellation acknowledgement"); } });
  const cancel = f.command("cancel", 1);
  await assert.rejects(c.cancel(cancel), /lost cancellation acknowledgement/);
  assert.equal((await f.open().cancel(cancel)).projection.cancellation, "pending");
  assert.equal(requests, 1); assert.equal(f.state.cancellations, 0);
  assert.equal((await f.openAuthority().inspect("root")).cancelled, true);
  await assert.rejects(f.controller.run(f.command("run", 2)), /group_run_already_admitted/);
});

test("returned and cancelled groups require authenticated terminal/accounting proof for every admitted member", async t => {
  const f = await fixture(t);
  const run = await f.controller.run(f.command("run", 1));
  const cancelled = await f.controller.cancel(f.command("cancel", run.projection.revision));
  assert.equal(cancelled.projection.terminal, "unproven");
  let proofs = 0;
  const reconciler = f.open({ async confirmTerminal(_spec, _seat, invocation) {
    assert.equal(invocation.terminal, true); assert.notEqual(invocation.usage, null); proofs++; return ref(`terminal-${invocation.invocationId}`);
  } });
  let last;
  for (const [i, member] of cancelled.projection.members.entries()) {
    const p = await reconciler.get("group");
    last = { ...f.command("terminal", p.revision, `terminal-${i}`), seatId: member.seatId, invocationId: member.invocationId, observation: member.observation };
    if (i === 0) await assert.rejects(f.controller.recordTerminal(last), /terminal_host_proof_required/);
    const recorded = await reconciler.recordTerminal(last);
    assert.equal(recorded.projection.terminal, i === cancelled.projection.members.length - 1 ? "proven" : "unproven");
    assert.equal(recorded.projection.acceptance, "unassessed");
  }
  assert.equal(proofs, 2); assert.equal((await reconciler.recordTerminal(last)).replayed, true); assert.equal(proofs, 2);
  assert.equal((await f.open().get("group")).terminal, "proven"); assert.equal(f.state.calls, 2);
  const m = await mailboxFixture(t, { groupFixture: f });
  assert.equal((await m.mailbox.inbox(m.first)).status, 'refused');
  m.mailboxState.authenticated = m.controllerIdentity.actorKey;
  assert.equal((await m.mailbox.cancel(m.controllerIdentity)).status, 'refused');
});

async function mailboxFixture(t, options = {}) {
  const { createDelegationGroupMailboxValidator } = await import('../../build/src/delegation-group-mailbox.js');
  const { createLocalFileDelegationMailbox } = await import('../../build/src/delegation-mailbox-local-file.js');
  const { createMailboxMessage } = await import('../../build/src/delegation-mailbox.js');
  const f = options.groupFixture ?? await fixture(t, options);
  const identity = seat => ({ groupId: 'group', groupGeneration: 1, controllerActorKey: 'actor/controller:exact', controllerGeneration: 3,
    memberId: seat.seatId, memberGeneration: seat.envelope.generation, assignmentId: `assignment-${seat.seatId}`, assignmentGeneration: 1, actorKey: `actor-${seat.seatId}` });
  const first = identity(f.spec.seats[0]), second = identity(f.spec.seats[1]);
  const live = new Map(f.spec.seats.map(seat => [seat.seatId, identity(seat)]));
  const controllerIdentity = { ...first, memberId: 'controller-member', memberGeneration: 7,
    assignmentId: 'controller-assignment', assignmentGeneration: 2, actorKey: first.controllerActorKey };
  const state = { authenticated: first.actorKey, now: NOW, fenced: false, lookups: 0,
    liveController: { identity: structuredClone(controllerIdentity), controller: structuredClone(f.spec.controller) } };
  const host = {
    now: () => { assert.equal(state.fenced, true); return state.now; },
    authenticateCaller: async caller => caller.actorKey === state.authenticated,
    withMembershipFence: async (_id, body) => {
      assert.equal(state.fenced, false); state.fenced = true;
      try { return await body(); } finally { state.fenced = false; }
    },
    resolveLiveController: async () => {
      assert.equal(state.fenced, true);
      return structuredClone(state.liveController);
    },
    resolveLiveMember: async (spec, seat) => {
      assert.equal(state.fenced, true); state.lookups++;
      return { identity: live.get(seat.seatId), controller: spec.controller, envelope: seat.envelope };
    },
  };
  const validateHost = createDelegationGroupMailboxValidator({ controller: f.controller, authority: f.service, host });
  const mailbox = createLocalFileDelegationMailbox({ artifactRoot: f.cwd, now: () => state.now, validateHost });
  const message = createMailboxMessage({ schemaVersion: '1.0', messageId: 'message', operationId: 'operation', exchangeId: 'exchange', subjectId: 'flow-agents#1113', resourceScope: ['src/task.ts'],
    sender: first, recipient: second, correlation: { status: 'incomplete', reason: 'controlled host' }, kind: 'dependency_question', inReplyTo: null,
    createdAt: NOW, expiresAt: '2026-10-21T12:30:00.000Z', payload: { summary: 'Can you review?', evidenceRefs: [], outputRefs: [] } });
  return { ...f, mailbox, validateHost, host, first, second, controllerIdentity, live, message, mailboxState: state };
}

test('mailbox validator binds current group seats and both live assignments before delivery', async t => {
  const f = await mailboxFixture(t), { mailbox, first, second, live, message, mailboxState: state } = f;
  assert.equal((await mailbox.enqueue(message, first)).status, 'ok');
  for (const participant of [first, second]) {
    for (const key of Object.keys(participant)) {
      const changed = typeof participant[key] === 'number' ? participant[key] + 1 : `${participant[key]}-stale`;
      live.set(participant.memberId, { ...participant, [key]: changed });
      assert.equal((await mailbox.deliver(message.operationId, first)).status, 'refused', `${participant.memberId}/${key}`);
    }
    live.set(participant.memberId, participant);
  }
  assert.equal((await mailbox.deliver(message.operationId, first)).status, 'ok');
  state.authenticated = second.actorKey;
  assert.equal((await mailbox.inbox(second)).value.length, 1);
  live.set(first.memberId, { ...first, assignmentGeneration: 2 });
  assert.equal((await mailbox.inbox(second)).status, 'refused');
  live.set(first.memberId, first);
  assert.equal((await mailbox.acknowledge(message.operationId, second)).status, 'ok');
  await f.controller.cancel(f.command('cancel', 1));
  assert.equal((await mailbox.inbox(second)).status, 'refused');
  assert.equal(f.state.calls, 0);
});

for (const boundary of ['root', 'child']) test(`mailbox refuses ${boundary} expiry at trusted host time despite historically valid authority`, async t => {
  const expiresAt = '2026-10-21T12:10:00.000Z';
  const f = await mailboxFixture(t, { [`${boundary}Expiry`]: expiresAt });
  const { mailbox, message, first, second, mailboxState: state } = f;
  assert.equal((await mailbox.enqueue(message, first)).status, 'ok');
  assert.equal((await mailbox.deliver(message.operationId, first)).status, 'ok');
  state.authenticated = second.actorKey;
  assert.equal((await mailbox.inbox(second)).value.length, 1);
  state.now = expiresAt;
  // Historical inspection remains available and the message itself has not expired.
  assert.equal((await f.openAuthority().inspect('root')).cancelled, false);
  assert.ok(state.now < message.expiresAt);
  state.authenticated = first.actorKey;
  assert.equal((await mailbox.enqueue(message, first)).status, 'refused');
  assert.equal((await mailbox.deliver(message.operationId, first)).status, 'refused');
  state.authenticated = second.actorKey;
  assert.equal((await mailbox.inbox(second)).status, 'refused');
  assert.equal((await mailbox.acknowledge(message.operationId, second)).status, 'refused');
  assert.equal(f.state.calls, 0);
});

for (const cancellation of ['none', 'pending', 'requested', 'authority', 'expired']) test(`mailbox controller can fence its journal with group cancellation ${cancellation}`, async t => {
  const f = await mailboxFixture(t, { rootExpiry: '2026-10-21T12:10:00.000Z' });
  const { mailbox, message, first, second, controllerIdentity, mailboxState: state } = f;
  assert.equal(f.spec.seats.some(seat => seat.seatId === controllerIdentity.memberId), false);
  assert.equal((await mailbox.enqueue(message, first)).status, 'ok');
  assert.equal((await mailbox.deliver(message.operationId, first)).status, 'ok');
  if (cancellation === 'pending') {
    const c = f.open({ async requestDescendantCancellation() { throw new Error('offline descendants'); } });
    await assert.rejects(c.cancel(f.command('cancel', 1)), /offline descendants/);
    assert.equal((await f.controller.get('group')).cancellation, 'pending');
  } else if (cancellation === 'requested') await f.controller.cancel(f.command('cancel', 1));
  else if (cancellation === 'authority') await f.service.cancel('root');
  else if (cancellation === 'expired') state.now = '2026-10-21T12:10:00.000Z';
  if (cancellation !== 'none') {
    assert.equal((await mailbox.deliver(message.operationId, first)).status, 'refused');
    state.authenticated = second.actorKey;
    assert.equal((await mailbox.inbox(second)).status, 'refused');
  }
  const lookups = state.lookups;
  state.authenticated = controllerIdentity.actorKey;
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'ok');
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'ok');
  assert.equal(state.lookups, lookups, 'controller cleanup never resolves a worker seat');
  // An offline journal consumer still sees the durable mailbox fence.
  const { createLocalFileDelegationMailbox } = await import('../../build/src/delegation-mailbox-local-file.js');
  const offline = createLocalFileDelegationMailbox({ artifactRoot: f.cwd, now: () => NOW, validateHost: async () => ({ status: 'current' }) });
  assert.deepEqual(await offline.inbox(second), { status: 'refused', code: 'inactive' });
  assert.deepEqual(await offline.deliver(message.operationId, first), { status: 'refused', code: 'inactive' });
  state.authenticated = first.actorKey;
  assert.equal((await mailbox.enqueue(message, first)).status, 'refused');
  assert.equal(f.state.calls, 0);
});

test('mailbox controller cleanup rejects spoofed workers and stale exact controller identities', async t => {
  const f = await mailboxFixture(t), { mailbox, controllerIdentity, first, mailboxState: state } = f;
  assert.equal((await mailbox.cancel(first)).status, 'refused');
  // Copying the controller's actor string cannot authenticate the actual worker caller.
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'refused');
  state.authenticated = controllerIdentity.actorKey;
  assert.equal((await mailbox.cancel({ ...first, actorKey: controllerIdentity.actorKey })).status, 'refused');
  const exact = structuredClone(state.liveController);
  for (const key of Object.keys(controllerIdentity)) {
    state.liveController = structuredClone(exact);
    state.liveController.identity[key] = typeof controllerIdentity[key] === 'number' ? controllerIdentity[key] + 1 : `${controllerIdentity[key]}-stale`;
    assert.equal((await mailbox.cancel(controllerIdentity)).status, 'refused', key);
  }
  state.liveController = { ...structuredClone(exact), controller: { ...f.spec.controller, generation: 4 } };
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'refused');
  state.liveController = { ...structuredClone(exact), controller: { ...f.spec.controller, id: 'another-controller' } };
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'refused');
  state.liveController = null;
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'refused');
  state.liveController = exact;
  const wrongGeneration = { ...controllerIdentity, controllerGeneration: 4 };
  state.liveController = { ...structuredClone(exact), identity: wrongGeneration };
  assert.equal((await mailbox.cancel(wrongGeneration)).status, 'refused');
  state.liveController = exact;
  // Even a host-authenticated worker-shaped identity cannot borrow the controller path.
  state.authenticated = first.actorKey;
  assert.equal((await f.validateHost({ action: 'cancel', caller: first })).status, 'refused');
  state.authenticated = controllerIdentity.actorKey;
  assert.equal((await mailbox.cancel(controllerIdentity)).status, 'ok');
});


test('mailbox authenticates before group lookup and samples time after live resolution', async t => {
  const expiresAt = '2026-10-21T12:10:00.000Z';
  const f = await mailboxFixture(t, { childExpiry: expiresAt });
  const { mailbox, message, first, host, mailboxState: state } = f;
  state.authenticated = 'unauthenticated';
  // The real controller would throw group_missing if this lookup were reached.
  assert.deepEqual(await f.validateHost({ action: 'read', caller: { ...first, groupId: 'missing' } }), { status: 'refused' });
  assert.equal(state.lookups, 0);
  state.authenticated = first.actorKey;
  for (const invalid of ['not-a-timestamp', '2026-10-21T12:00:00Z']) {
    state.now = invalid;
    assert.deepEqual(await mailbox.enqueue(message, first), { status: 'refused', code: 'host_refused' });
  }
  state.now = NOW;
  const resolve = host.resolveLiveMember;
  host.resolveLiveMember = async (...args) => {
    const result = await resolve(...args);
    if (args[1].seatId === f.spec.seats[1].seatId) state.now = expiresAt;
    return result;
  };
  assert.equal((await mailbox.enqueue(message, first)).status, 'refused');
  assert.equal((await f.service.inspect('root')).invocations.length, 0);
});
