import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { FileAuthorizationLedger } from "@kontourai/dispatch";
import { canonicalJson } from "@kontourai/relay";
import { definitionIdentity, startRun, loadRun, claimableMultiCursorSteps, claimReadyStep, evaluateClaimedStep, reopenMultiCursorStep, attachEvidence, flowRunHead, flowTransitionRef, authorizeRetry, releaseStepClaim } from "@kontourai/flow";
import { createDelegationAuthorityServiceV3 } from "@kontourai/flow-agents/delegation-authority-service-v3";
import { createLocalFileDelegationAuthorityStoreV3 } from "@kontourai/flow-agents/delegation-authority-local-file-v3";
import { preparedRoundsSyncDigest } from "@kontourai/flow-agents/delegation-group-rounds";
import { createDelegationAuthorityService } from "@kontourai/flow-agents/delegation-authority-service";
import { createLocalFileDelegationAuthorityStore } from "@kontourai/flow-agents/delegation-authority-local-file";
import { delegationEnvelopeDigestV2, delegationParentReferenceV2, rootAuthorityReferenceV2 } from "@kontourai/flow-agents/delegation-envelope-v2";
import { createDelegationRoundsController, delegationRoundsSyncIdentity, delegationRoundsCapacity, ROUNDS_MAX_BYTES, ROUNDS_MAX_EVENTS } from "@kontourai/flow-agents/delegation-group-rounds";
import { createLocalFileDelegationRoundsStore } from "@kontourai/flow-agents/delegation-group-rounds-local-file";
import { executeAuthorizedDelegation } from "@kontourai/flow-agents/delegation-execution";
import { orchestrateDelegationFlow } from "@kontourai/flow-agents/delegation-flow-execution";
const NOW = "2026-10-21T12:00:00.000Z", EXPIRY = "2026-10-22T12:00:00.000Z";
const ref = id => ({ id, domain: "fixture-receipt", digest: `sha256:${createHash("sha256").update(id).digest("hex")}` });
const allocation = { inputTokens: 5, outputTokens: 5, costMicros: 10 };
function authorityFixture(flow, options = {}) {
  const steps = options.managedDefinition?.steps.map(s => s.id) ?? ["first", "second"];
  const ceiling = { allowed_tools: [], allowed_effects: options.contextSync ? ["read", "context-sync"] : ["read"], readable_resources: [], mutable_resources: [], posture: "report-only", approval: "requires_approval", escalation: "deny" };
  const budget = { remaining_depth: 3, max_total_children: 4, max_total_envelopes: steps.length > 2 ? 16 : 8, max_concurrent_children: 2,
    max_runtime_ms: 60000, max_input_tokens: 1000, max_output_tokens: 1000, max_cost_micros: 1000, max_attempts: options.attempts ?? 6, expires_at: options.rootExpiry ?? EXPIRY };
  const grants = steps.map(step => ({ grant_id: `grant-${step}`,
    runtime: { runtime_receipt_ref: ref(`runtime-${step}`), model_receipt_ref: ref(`model-${step}`), required_capabilities: ["usage", "abort"] },
    source: { repository_id: "fixture", source_state_id: "exact-source", dirty_state_fingerprint: null, execution_worktree_id: `worktree-${step}`, source_admission_receipt: ref(`source-${step}`) },
    flow_binding: flow ? { status: "bound", flow_run_id: flow.runId, definition: flow.identity, flow_step_id: step } : { status: "unbound", reason: "Independent advisory fixture" },
    authority_ceiling: structuredClone(ceiling) }));
  const root = { schema_version: "2.0", authority_id: "root", authority_epoch: 1, issuer_host_id: "fixture-host",
    authenticated_principal_ref: ref("principal"), authenticated_subject_ref: ref("subject"),
    source_origin: { repository_id: "fixture", worktree_id: "worktree-first", source_state_id: "exact-source", dirty_state_fingerprint: null },
    execution_worktree_ids: steps.map(step => `worktree-${step}`), execution_grants: grants,
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
    budget: { ...budget, remaining_depth: 2, max_total_envelopes: 3, max_attempts: 2, max_input_tokens: 100, max_output_tokens: 100, max_cost_micros: 100, expires_at: options.childExpiry ?? budget.expires_at } };
  return { root, envelopes: [parent, ...grants.slice(1).map((grant, i) => ({ ...structuredClone(child),
    envelope_id: i === 0 ? "child" : `child-${i}`, execution_id: `child-execution-${i}`, span_id: `child-span-${i}`,
    selected_grant_id: grant.grant_id, execution_binding: binding(grant),
  }))] };
}
async function fixture(t, options = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rounds-proof-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (options.managedDefinition) {
    const definition = options.managedDefinition, file = path.join(cwd, "managed.flow.json"); fs.writeFileSync(file, JSON.stringify(definition));
    const flow = { runId: "managed-flow", identity: definitionIdentity(definition) };
    await startRun(file, { cwd, runId: flow.runId, params: { subject: "fixture" } });
    options = { ...options, flow };
  }
  const { root, envelopes } = authorityFixture(options.flow, options);
  const state = { allowed: true, terminal: true, calls: 0, active: 0, peak: 0, unknown: false, fail: false, launches: [], cancels: 0, observations: [], schedules: [] };
  const authorityHost = {
    now: () => NOW, authorize: async () => state.allowed && !state.v2CustodyStopped,
    async confirmExecution(envelope, authority) {
      if (!state.allowed) return false;
      if (!options.v3 || authority.authority_epoch === 1) return true;
      const file = path.join(cwd, "host-issued-renewals", createHash("sha256").update(envelope.execution_binding.source.source_admission_receipt.id).digest("hex") + ".json");
      if (!fs.existsSync(file)) return false; const bytes = fs.readFileSync(file), receipt = JSON.parse(bytes);
      return envelope.execution_binding.source.source_state_id === fs.readFileSync(path.join(cwd, "actual-host-source.txt"), "utf8")
        && receipt.issuer === authority.issuer_host_id && receipt.sourceState === envelope.execution_binding.source.source_state_id
        && canonicalJson(receipt.runtime) === canonicalJson(envelope.execution_binding.runtime)
        && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === envelope.execution_binding.source.source_admission_receipt.digest;
    },
    confirmReconciliation: async () => state.allowed,
    async confirmHistoricalReconciliation(invocation, root, envelope) {
      state.historicalChecks ??= []; state.historicalChecks.push({ invocation, root, envelope });
      return false; // This fixture has no later physical accounting evidence for an old unknown hold.
    },
    async authenticateRenewal({ command }) {
      const file = path.join(cwd, "host-issued-renewals", createHash("sha256").update(command.hostReceipt.id).digest("hex") + ".json");
      if (!state.allowed || !fs.existsSync(file)) return null;
      const bytes = fs.readFileSync(file), record = JSON.parse(bytes), { hostReceipt, ...payload } = command;
      const currentSource = fs.readFileSync(path.join(cwd, "actual-host-source.txt"), "utf8");
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== hostReceipt.digest
        || record.issuer !== root.issuer_host_id || record.principal !== root.authenticated_principal_ref.id
        || record.sourceState !== currentSource || command.root.source_origin.source_state_id !== currentSource
        || record.payloadDigest !== `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`
        || canonicalJson(record.runtimeReceipts) !== canonicalJson(root.execution_grants.map(g => g.runtime))
        || canonicalJson(record.runtimeReceipts) !== canonicalJson(command.root.execution_grants.map(g => g.runtime))) return null;
      return record.receiptId === hostReceipt.id ? hostReceipt : null;
    },
  };
  const openAuthority = () => options.v3
    ? createDelegationAuthorityServiceV3(createLocalFileDelegationAuthorityStoreV3(cwd), authorityHost, { maxRenewals: 4 })
    : createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(cwd), authorityHost);
  const service = openAuthority(); await service.issue(root); for (const e of envelopes) await service.derive(root.authority_id, e);
  const spec = { schemaVersion: "1.0", groupId: "rounds-group", rootAuthorityRef: rootAuthorityReferenceV2(root),
    controller: { id: "controller", generation: 1 }, topology: options.managedDefinition ? { kind: "flow", runId: options.flow.runId, definition: options.flow.identity, actor: { key: "host", kind: "test" } } : { kind: "independent-advisory" },
    policy: { reference: root.revisions.policy, maxRounds: options.maxRounds ?? 4, maxAttempts: options.groupAttempts ?? options.attempts ?? 6, maxConcurrent: options.maxConcurrent ?? 2, ...(options.managedDefinition ? { maxEvaluations: options.maxEvaluations ?? 8, ...(options.maxRecoveries === undefined ? {} : { maxRecoveries: options.maxRecoveries }), ...(options.contextSync ? { maxSyncs: options.maxSyncs ?? 8 } : {}), ...(options.syncAdmission === undefined ? {} : {syncAdmission: options.syncAdmission}), ...(options.v3 ? { maxRenewals: 4 } : {}) } : {}) },
    seats: envelopes.map((e, i) => ({ seatId: `seat-${i}`, envelope: { id: e.envelope_id, generation: e.generation, digest: delegationEnvelopeDigestV2(e) }, effect: "read", allocation: i === 0 ? options.allocation ?? allocation : allocation, ...(options.managedDefinition ? { stepId: options.managedDefinition.steps[i].id } : {}) })) };
  let counter = 0;
  function retain(value) {
    const id = `observation-${++counter}`, bytes = JSON.stringify(value, (k, v) => v instanceof Error ? { message: v.message } : v);
    const fd = fs.openSync(path.join(cwd, `${id}.json`), "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { id, domain: "retained-observation", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }
  const runtime = { id: "controlled-no-provider", capabilities: () => ({ structuredTools: false, outputTokenLimitFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke(request) {
      state.requests ??= []; state.requests.push(structuredClone(request));
      const syncInstruction = request.messages.find(m => typeof m.content === "string" && m.content.startsWith("Receive context only."));
      state.calls++; state.active++; state.peak = Math.max(state.peak, state.active);
      try {
        await setImmediate(); await state.onInvoke?.();
        if (state.fail) throw new Error("controlled failure");
        return { provider: "controlled", model: "local-only", outputText: syncInstruction ? (state.badAck ? "ACK WRONG" : syncInstruction.content.match(/Reply exactly (.*)$/)[1]) : "Dissent remains advisory", toolCalls: [],
          usage: state.unknown ? {} : { inputTokens: 1, outputTokens: 2, ...(options.retainedAccounting ? {} : { costUsd: 0.000003 }) }, latencyMs: 1 };
      } finally { state.active--; }
    } };
  let controller;
  const physical = {
    async resolveRuntime(envelope) { return { runtime, runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref, modelReceipt: envelope.execution_binding.runtime.model_receipt_ref }; },
    async invokeFenced(envelope, id, launch) {
      assert.equal(state.allowed, true);
      if (!options.flow || options.managedDefinition) {
        const p = await controller.get(spec.groupId); assert.equal(p.cancellation, "none");
        assert.ok(p.attempts.some(a => a.invocationId === id));
      }
      const invocation = (await openAuthority().inspect(root.authority_id)).invocations.find(i => i.invocationId === id);
      assert.equal(invocation?.terminal, false); assert.equal(invocation.envelopeId, envelope.envelope_id);
      state.launches.push(id); return launch();
    },
    async retainResult(result) {
      retain(result);
      if (options.retainedAccounting) return state.unknown ? null : {
        inputTokens: 1, outputTokens: 2, costMicros: options.tariffMicros ?? 3, costBasis: "tariff-upper-bound",
      };
    }, async retainFailure(error) { retain(error); },
    async recordScheduleEvent(event) { state.schedules.push(event); await state.onSchedule?.(event); }, async confirmClaim(claim) {
      if (!options.managedDefinition) return true;
      const run = await loadRun(options.flow.runId, cwd);
      return !state.denyClaim && run.state.multi_cursor.active_claims.some(c => c.claim_id === claim.claim_id && c.liveness_id === claim.liveness_id && c.claim_base.head === claim.claim_base.head);
    },
    async prepareRequest() { return { messages: [{ role: "user", content: "report" }], maxOutputTokens: 5 }; },
    async recordMemberOutcome(claim, envelope, outcome) { state.observations.push({ claim, envelope, outcome }); },
  };
  const host = {
    ...(options.accountingProtocol ? {accountingProtocol: options.accountingProtocol} : {}),
    async authorize({ action, current, command }) {
      if (!state.allowed || current && current.spec.controller.generation !== 1) return null;
      if (action === "release" && state.denyCheckpoint === command?.checkpoint.id) return null;
      return ref(`authorized-${action}`);
    },
    executionHost: () => physical,
    async prepareRequest() { await state.onPrepare?.(); return { messages: [{ role: "user", content: "report" }], maxOutputTokens: 5 }; },
    async retainObservation(_spec, attempt, observation) {
      if (state.retentionFailure) throw new Error("retention unavailable");
      state.observations.push({ attempt, observation }); return retain(observation);
    },
    async confirmTerminal(_spec, attempt, invocation) {
      assert.equal(attempt.invocationId, invocation.invocationId);
      assert.ok(state.launches.includes(invocation.invocationId));
      return state.terminal ? retain({ physicalTerminal: invocation.invocationId, descendants: "joined" }) : null;
    },
    async retainContinuation(_spec, receipt) {
      if (state.continuationRetentionFailure) throw new Error("continuation receipt retention unavailable"); return retain(receipt);
    },
    recipient: {
      async resolve(_spec, _seat, envelope) {
        const session = state.session ?? "session-A", generation = state.sessionGeneration ?? 1;
        const selected = { ...runtime, id: session, async invoke(request, invokeOptions) {
          state.sessionCalls ??= []; state.sessionCalls.push(session);
          return runtime.invoke(request, invokeOptions);
        } };
        return {
          identity: { hostId: "fixture-host", recipientId: session, generation, executionId: envelope.execution_id,
            authority: envelope.root_authority_ref, envelope: { id: envelope.envelope_id, digest: delegationEnvelopeDigestV2(envelope) },
            runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref, modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
            sessionReceipt: ref(`session-receipt-${session}-${generation}`) },
          runtime: selected, retainResult: physical.retainResult, retainFailure: physical.retainFailure,
          async invokeFenced(e, id, launch) {
            assert.equal(state.session ?? "session-A", session); assert.equal(state.sessionGeneration ?? 1, generation);
            return id.startsWith("sync_") ? host.context.executionHost().invokeFenced(e, id, launch) : physical.invokeFenced(e, id, launch);
          },
        };
      },
    },
    context: {
      async confirmTerminal(_spec, _seat, invocation) { return state.terminal ? retain({ physicalTerminal: invocation.invocationId, descendants: "joined" }) : null; },
      async load(reference) { return fs.readFileSync(path.join(cwd, `${reference.id}.txt`), "utf8"); },
      executionHost: () => ({ ...physical, async invokeFenced(envelope, id, launch) {
        const p = await controller.get(spec.groupId);
        assert.equal(p.cancellation, "none"); assert.ok(p.continuations.some(c => c.command.kind === "sync" && !c.receipt));
        const invocation = (await service.inspect("root")).invocations.find(i => i.invocationId === id);
        assert.equal(invocation.envelopeId, envelope.envelope_id);
        const pending = p.continuations.find(c => c.command.kind === "sync" && !c.receipt);
        const identity = delegationRoundsSyncIdentity({ command: pending.command, authorityId: p.grants.authority.id, envelopeId: envelope.envelope_id });
        assert.ok(identity.invocationIds.includes(id)); state.syncIdentities ??= []; state.syncIdentities.push(identity);
        state.launches.push(id); return launch();
      } }),
    },
    flow: {
      async withContinuationMutation(_spec, _command, body) {
        // This fixture owns its unique run; serialize its explicitly routed recovery mutations.
        const prior = state.mutation ?? Promise.resolve(), result = prior.then(body);
        state.mutation = result.catch(() => {}); return result;
      },
      executionHost: operationalSpec => { state.flowHostSpecs ??= []; state.flowHostSpecs.push(structuredClone(operationalSpec)); return physical; },
      async confirmRetainedResult(_spec, attempt, reference) {
        if (state.denyRetained) return false;
        const bytes = fs.readFileSync(path.join(cwd, `${reference.id}.json`));
        assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, reference.digest);
        const retained = JSON.parse(bytes); return retained.outcome?.outcome === "succeeded" && attempt.observation.digest === reference.digest;
      },
      async retainEvaluation(_spec, action, receipt) {
        if (state.evaluationRetentionFailure) throw new Error("evaluation retention unavailable");
        state.evaluations ??= []; state.evaluations.push({ action, receipt }); return retain(receipt);
      },
    },
    async requestDescendantCancellation() { state.cancels++; if (state.cancelFailure) throw new Error("cancellation acknowledgement lost"); return retain({ cancelled: true }); },
  };
  const store = () => createLocalFileDelegationRoundsStore(cwd);
  const open = () => createDelegationRoundsController({ store: store(), authorityService: openAuthority(), host,
    dispatchLedger: new FileAuthorizationLedger({ root: path.join(cwd, "dispatch") }), cwd });
  controller = open();
  const cmd = (kind, p, operationKey, fields = {}) => ({ kind, groupId: spec.groupId, operationKey, expectedRevision: p?.revision ?? 0, controller: structuredClone(spec.controller), ...fields });
  const create = cmd("create", null, "create", { spec });
  if (!options.flow || options.managedDefinition) await controller.create(create);
  const release = async (key, seats) => {
    const p = await controller.get(spec.groupId);
    return cmd("release", p, key, { checkpoint: ref(key), seats: seats.map(seatId => ({ seatId, previousInvocationId: p.attempts.filter(a => a.seatId === seatId).at(-1)?.invocationId ?? null })) });
  };
  const terminal = async invocationId => {
    const p = await controller.get(spec.groupId);
    return controller.recordTerminal(cmd("terminal", p, `terminal-${p.revision}`, { invocationId }));
  };
  return { cwd, state, spec, root, envelopes, service, openAuthority, controller, open, store, cmd, create, release, terminal, physical, host, authorityHost };
}

test("first seat, explicit bounded fanout and same-seat retry survive durable reopen without reset or replay effects", async t => {
  const f = await fixture(t), first = await f.release("first", ["seat-0"]);
  const one = await f.controller.release(first);
  assert.equal(f.state.calls, 1); assert.equal(one.projection.attempts.length, 1);
  assert.equal(one.projection.acceptance, "unassessed");
  await assert.rejects(f.open().release(await f.release("premature", ["seat-0"])), /rounds_previous_terminal_required/);
  f.state.terminal = false; await assert.rejects(f.terminal(one.projection.attempts[0].invocationId), /rounds_physical_terminal_required/);
  f.state.terminal = true; await f.terminal(one.projection.attempts[0].invocationId);
  const fanout = await f.release("fanout", ["seat-0", "seat-1"]);
  const result = await f.open().release(fanout);
  assert.equal(f.state.calls, 3); assert.equal(f.state.peak, 2);
  assert.deepEqual(result.projection.attempts.map(a => a.seatId), ["seat-0", "seat-0", "seat-1"]);
  assert.equal(result.projection.attempts[1].previousInvocationId, result.projection.attempts[0].invocationId);
  assert.equal(new Set(f.state.launches).size, 3);
  const ledger = await f.openAuthority().inspect("root");
  assert.equal(ledger.invocations.length, 3); assert.ok(ledger.invocations.every(i => i.terminal && i.usage.costMicros === 3));
  assert.equal(ledger.envelopes.length, 2); assert.equal(ledger.root.authority_id, "root");
  const history = await f.open().events(f.spec.groupId);
  assert.equal((await f.open().release(first)).replayed, true); assert.equal((await f.open().release(fanout)).replayed, true);
  assert.equal(f.state.calls, 3); assert.deepEqual(await f.open().events(f.spec.groupId), history);
  const attempt = result.projection.attempts[1], bytes = fs.readFileSync(path.join(f.cwd, `${attempt.observation.id}.json`));
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, attempt.observation.digest);
  assert.equal(JSON.parse(bytes).outcome.result.outputText, "Dissent remains advisory");
  f.state.allowed = false;
  for (const op of [() => f.open().get(f.spec.groupId), () => f.open().events(f.spec.groupId), () => f.open().release(first)]) await assert.rejects(op(), /rounds_host_authorization/);
});

test("checkpoint authority, immutable roster, controller fence, exact predecessor and operation intent fail closed", async t => {
  const f = await fixture(t);
  const denied = await f.release("deny", ["seat-0"]); f.state.denyCheckpoint = "deny";
  await assert.rejects(f.controller.release(denied), /rounds_host_authorization/);
  const extra = await f.release("extra", ["seat-evil"]); await assert.rejects(f.controller.release(extra), /rounds_unauthorized_seat/);
  const stale = { ...await f.release("stale", ["seat-0"]), controller: { id: "controller", generation: 2 } };
  await assert.rejects(f.controller.release(stale), /rounds_controller_fence/);
  const initial = await f.release("first", ["seat-0"]); const r = await f.controller.release(initial);
  await assert.rejects(f.controller.release({ ...initial, checkpoint: ref("changed") }), /rounds_intent_conflict/);
  await f.terminal(r.projection.attempts[0].invocationId);
  const wrong = await f.release("wrong", ["seat-0"]); wrong.seats[0].previousInvocationId = "other-invocation";
  await assert.rejects(f.controller.release(wrong), /rounds_previous_terminal_required/);
  const duplicateCheckpoint = await f.release("new-operation", ["seat-1"]); duplicateCheckpoint.checkpoint = initial.checkpoint;
  await assert.rejects(f.controller.release(duplicateCheckpoint), /rounds_checkpoint_reused/);
  const mutation = structuredClone(f.create); mutation.spec.seats.push({ ...mutation.spec.seats[0], seatId: "hidden" });
  await assert.rejects(f.controller.create(mutation)); assert.equal(f.state.calls, 1);
});

for (const mode of ["unknown", "fail"]) test(`${mode} usage retains ancestor holds and forbids same-seat retry after reconnect`, async t => {
  const f = await fixture(t); f.state[mode] = true;
  const first = await f.release("first", ["seat-0"]), r = await f.controller.release(first);
  const id = r.projection.attempts[0].invocationId;
  assert.equal((await f.openAuthority().inspect("root")).invocations[0].usage, null);
  await assert.rejects(f.terminal(id), /rounds_terminal_accounting_required/);
  await assert.rejects(f.open().release(await f.release("retry", ["seat-0"])), /rounds_previous_accounting_required/);
  assert.equal((await f.open().release(first)).replayed, true); assert.equal(f.state.calls, 1);
  await f.service.reserveInvocation("root", "child", "held-child", allocation);
  await assert.rejects(f.service.reserveInvocation("root", "child", "excess", allocation), /active_slot_exhausted/);
});

test("aggregate ancestry is shared across rounds; new invocation IDs cannot reset lifetime spend", async t => {
  const f = await fixture(t, { attempts: 4 });
  for (let i = 0; i < 2; i++) {
    const r = await f.controller.release(await f.release(`round-${i}`, ["seat-0"]));
    await f.terminal(r.projection.attempts.at(-1).invocationId);
  }
  const r = await f.controller.release(await f.release("exhausted-parent", ["seat-0"]));
  assert.equal(f.state.calls, 2);
  const attempt = r.projection.attempts.at(-1), bytes = fs.readFileSync(path.join(f.cwd, `${attempt.observation.id}.json`), "utf8");
  assert.match(bytes, /invocation_budget_exhausted/);
  const ledger = await f.service.inspect("root"); assert.equal(ledger.invocations.length, 2);
  assert.deepEqual(ledger.invocations.map(i => i.usage), [ { inputTokens: 1, outputTokens: 2, costMicros: 3 }, { inputTokens: 1, outputTokens: 2, costMicros: 3 } ]);
});

test("cancellation closes all rounds before descendant request and never resends on replay", async t => {
  const f = await fixture(t, { maxConcurrent: 1 });
  f.state.onInvoke = async () => {
    const p = await f.controller.get(f.spec.groupId), c = f.cmd("cancel", p, "cancel");
    const r = await f.open().cancel(c); assert.equal(r.projection.cancellation, "requested");
    assert.equal((await f.openAuthority().inspect("root")).cancelled, true);
    assert.equal((await f.open().cancel(c)).replayed, true);
  };
  await f.controller.release(await f.release("both", ["seat-0", "seat-1"]));
  assert.equal(f.state.calls, 1); assert.equal(f.state.cancels, 1);
  await assert.rejects(f.open().release(await f.release("resurrect", ["seat-1"])), /rounds_authority_cancelled/);
});

test("lost retention or cancellation acknowledgements remain held without automatic recovery", async t => {
  const f = await fixture(t); f.state.retentionFailure = true;
  const c = await f.release("first", ["seat-0"]); await assert.rejects(f.controller.release(c), /Round retention unknown/);
  f.state.retentionFailure = false;
  assert.equal((await f.open().release(c)).replayed, true); assert.equal(f.state.calls, 1);
  await assert.rejects(f.open().release(await f.release("next", ["seat-1"])), /rounds_pending_hold/);
  const p = await f.controller.get(f.spec.groupId), cancel = f.cmd("cancel", p, "cancel"); f.state.cancelFailure = true;
  await assert.rejects(f.controller.cancel(cancel), /acknowledgement lost/);
  assert.equal((await f.open().cancel(cancel)).projection.cancellation, "pending"); assert.equal(f.state.cancels, 1);
});

test("creation escrows all declared future events/bytes; filesystem is private, append-only and root-exclusive", async t => {
  const f = await fixture(t, { maxRounds: 16, attempts: 128 });
  const events = await f.controller.events(f.spec.groupId), journal = { schemaVersion: "1.0", groupId: f.spec.groupId, events };
  const escrow = delegationRoundsCapacity(journal);
  assert.equal(escrow.events, 2 * 16 + 2 * 128 + 2);
  assert.ok(escrow.events + events.length <= ROUNDS_MAX_EVENTS);
  assert.ok(Buffer.byteLength(canonicalJson(journal)) + escrow.bytes < ROUNDS_MAX_BYTES);
  const dir = path.join(f.cwd, "delegation-group-rounds"), file = fs.readdirSync(dir).find(n => n.endsWith(".json"));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  const other = structuredClone(f.create); other.groupId = other.spec.groupId = "other-group";
  await assert.rejects(f.controller.create(other), /group_authority_already_bound/);
  await f.controller.release(await f.release("first", ["seat-0"]));
  await assert.rejects(f.store().transact(f.spec.groupId, async current => ({ journal: { ...current, events: current.events.slice(0, 1) }, result: null })), /append_only_group_required/);
  fs.chmodSync(path.join(dir, file), 0o644); await assert.rejects(f.open().get(f.spec.groupId), /unsafe_group_file/);
});

test("public Flow wrapper blocks on external evidence, then re-invokes the seat after reopen; public claimed evaluation can avoid dispatch", async t => {
  const definition = { id: "continuation-probe", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "first", next: null, mutable_resources: [] }, { id: "second", next: null, needs: ["first"], mutable_resources: [] }],
    gates: { first: { step: "first", expects: [{ id: "external", kind: "trust.bundle", bundle_claim: { claimType: "fixture.external", accepted_statuses: ["verified"] }, required: true, description: "External evidence" }] },
      second: { step: "second", expects: [{ id: "optional", kind: "trust.bundle", bundle_claim: { claimType: "fixture.optional" }, required: false, description: "Optional" }] } } };
  const flow = { runId: "continuation-probe", identity: definitionIdentity(definition) };
  const f = await fixture(t, { flow });
  const file = path.join(f.cwd, "fixture.flow.json"); fs.writeFileSync(file, JSON.stringify(definition));
  await startRun(file, { cwd: f.cwd, runId: flow.runId, params: { subject: "fixture" } });
  const input = { authorityId: "root", service: f.service, dispatchLedger: new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") }),
    host: f.physical, runId: flow.runId, actor: { key: "host", kind: "test" }, cwd: f.cwd, maxConcurrent: 1,
    seats: f.envelopes.map((e, i) => ({ stepId: ["first", "second"][i], envelopeId: e.envelope_id, effect: "read", allocation })) };
  const first = await orchestrateDelegationFlow(input);
  assert.deepEqual(first.unsettledSteps, []); assert.equal(f.state.calls, 1);
  let run = await loadRun(flow.runId, f.cwd);
  assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), []);
  assert.equal(run.state.multi_cursor.blocked_steps[0].step_id, "first");
  const previousClaim = f.state.observations[0].claim.claim_id;
  const evidence = path.join(f.cwd, "external.json"), at = new Date().toISOString();
  fs.writeFileSync(evidence, JSON.stringify({ schemaVersion: 5, source: "controlled-external-evidence",
    claims: [{ id: "external-claim", subjectType: "flow-step", subjectId: "first", claimType: "fixture.external", fieldOrBehavior: "external observation", value: "pass", createdAt: at, updatedAt: at }],
    evidence: [{ id: "external-evidence", claimId: "external-claim", evidenceType: "human_attestation", method: "attestation", sourceRef: "controlled:external", excerptOrSummary: "External evidence arrived", observedAt: at, collectedBy: "fixture-host" }],
    policies: [], events: [{ id: "external-verified", claimId: "external-claim", status: "verified", actor: "fixture-host", method: "attestation", evidenceIds: ["external-evidence"], createdAt: at, verifiedAt: at }] }));
  await attachEvidence(flow.runId, { cwd: f.cwd, gate: "first", file: evidence, kind: "trust.bundle" });
  await reopenMultiCursorStep(flow.runId, { cwd: f.cwd, step_id: "first" });
  const resumed = await orchestrateDelegationFlow(input);
  assert.equal(f.state.calls, 3); assert.equal((await loadRun(flow.runId, f.cwd)).state.status, "completed");
  assert.notEqual(f.state.observations[1].claim.claim_id, previousClaim);
  assert.equal(f.state.observations[1].claim.step_id, "first");
  assert.equal(resumed.unsettledSteps.length, 0);
  // This is a wrapper limitation, not an assertion that Flow lacks public claimed evaluation.
  const lowerId = "lower-level-probe";
  await startRun(file, { cwd: f.cwd, runId: lowerId, params: { subject: "fixture" } });
  const actor = { key: "evaluator", kind: "test" };
  const { claim } = await claimReadyStep(lowerId, { cwd: f.cwd, step_id: "first", claim_id: "evaluation-only", liveness_id: "evaluation-only-live", actor });
  assert.equal((await evaluateClaimedStep(lowerId, { cwd: f.cwd, claim_id: claim.claim_id, liveness_id: claim.liveness_id, actor })).settled, true);
  await attachEvidence(lowerId, { cwd: f.cwd, gate: "first", file: evidence, kind: "trust.bundle" });
  await reopenMultiCursorStep(lowerId, { cwd: f.cwd, step_id: "first" });
  const { claim: resumedClaim } = await claimReadyStep(lowerId, { cwd: f.cwd, step_id: "first", claim_id: "new-evaluation-only", liveness_id: "new-evaluation-live", actor });
  assert.equal((await evaluateClaimedStep(lowerId, { cwd: f.cwd, claim_id: resumedClaim.claim_id, liveness_id: resumedClaim.liveness_id, actor })).settled, true);
  run = await loadRun(lowerId, f.cwd); assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), ["second"]);
  assert.equal(f.state.calls, 3);
});


test("unchanged public Flow wrapper does not restrict its frontier to the supplied seat subset", async t => {
  const optional = step => ({ step, expects: [{ id: "optional", kind: "trust.bundle", required: false, description: "optional", bundle_claim: { claimType: "fixture.optional" } }] });
  const definition = { id: "subset-probe", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "first", next: null, mutable_resources: [] }, { id: "second", next: null, mutable_resources: [] }],
    gates: { first: optional("first"), second: optional("second") } };
  const flow = { runId: "subset-probe", identity: definitionIdentity(definition) }, f = await fixture(t, { flow });
  const file = path.join(f.cwd, "subset.flow.json"); fs.writeFileSync(file, JSON.stringify(definition));
  await startRun(file, { cwd: f.cwd, runId: flow.runId, params: { subject: "fixture" } });
  await assert.rejects(orchestrateDelegationFlow({ authorityId: "root", service: f.service,
    dispatchLedger: new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") }), host: f.physical,
    runId: flow.runId, actor: { key: "host", kind: "test" }, cwd: f.cwd, maxConcurrent: 1,
    seats: [{ stepId: "first", envelopeId: "parent", effect: "read", allocation }] }), error => {
      assert.ok(error.observation.events.some(e => e.kind === "started" && e.stepId === "second"));
      assert.ok(error.observation.events.some(e => e.kind === "failed" && e.stepId === "second"));
      return true;
    });
  assert.equal(f.state.calls, 1);
  assert.equal((await f.service.inspect("root")).invocations.length, 1);
});


for (const limits of [{ maxRounds: 1 }, { groupAttempts: 1 }]) test(`declared release capacity closes admission without effects ${JSON.stringify(limits)}`, async t => {
  const f = await fixture(t, limits);
  await f.controller.release(await f.release("first", ["seat-0"]));
  const history = await f.controller.events(f.spec.groupId);
  await assert.rejects(f.open().release(await f.release("beyond-bound", ["seat-1"])), /rounds_capacity/);
  assert.deepEqual(await f.open().events(f.spec.groupId), history); assert.equal(f.state.calls, 1);
});

test("actual public Flow empty gate returns an unsettled wait and the wrapper reclaims/reinvokes on reconnect", async t => {
  const definition = { id: "waiting-probe", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "first", next: null, mutable_resources: [] }], gates: { first: { step: "first", expects: [] } } };
  const flow = { runId: "waiting-probe", identity: definitionIdentity(definition) }, f = await fixture(t, { flow });
  const file = path.join(f.cwd, "waiting.flow.json"); fs.writeFileSync(file, JSON.stringify(definition));
  await startRun(file, { cwd: f.cwd, runId: flow.runId, params: { subject: "fixture" } });
  const input = { authorityId: "root", service: f.service,
    dispatchLedger: new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") }), host: f.physical,
    runId: flow.runId, actor: { key: "host", kind: "test" }, cwd: f.cwd, maxConcurrent: 1,
    seats: [{ stepId: "first", envelopeId: "parent", effect: "read", allocation }] };
  const first = await orchestrateDelegationFlow(input), second = await orchestrateDelegationFlow(input);
  assert.deepEqual(first.unsettledSteps, ["first"]); assert.deepEqual(second.unsettledSteps, ["first"]);
  assert.equal(f.state.calls, 2); assert.equal(new Set(f.state.launches).size, 2);
  assert.notEqual(f.state.observations[0].claim.claim_id, f.state.observations[1].claim.claim_id);
  const run = await loadRun(flow.runId, f.cwd);
  assert.equal(run.state.multi_cursor.active_claims.length, 0);
  assert.equal(run.state.gate_outcomes.length, 0);
});


test("fresh-process controller reads durable attempt history and authenticates replay without launch", async t => {
  const f = await fixture(t); const c = await f.release("first", ["seat-0"]);
  await f.controller.release(c);
  const script = `
    import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
    import { createLocalFileDelegationRoundsStore } from '@kontourai/flow-agents/delegation-group-rounds-local-file';
    import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
    import { createLocalFileDelegationAuthorityStore } from '@kontourai/flow-agents/delegation-authority-local-file';
    import { FileAuthorizationLedger } from '@kontourai/dispatch';
    const [root, command] = process.argv.slice(1), actions = [];
    const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(root), {
      now: () => ${JSON.stringify(NOW)}, authorize: async () => true, confirmExecution: async () => true });
    const controller = createDelegationRoundsController({ store: createLocalFileDelegationRoundsStore(root), authorityService: service,
      dispatchLedger: new FileAuthorizationLedger({ root: root + '/dispatch' }),
      host: { async authorize({ action }) { actions.push(action); return ${JSON.stringify(ref('child-auth'))}; },
        executionHost() { throw new Error('REPLAY LAUNCHED'); } } });
    const result = await controller.release(JSON.parse(command));
    console.log(JSON.stringify({ result, actions }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.cwd, JSON.stringify(c)], { cwd: process.cwd() });
  const read = JSON.parse(stdout);
  assert.equal(read.result.replayed, true); assert.equal(read.result.projection.attempts.length, 1);
  assert.ok(read.actions.includes("replay")); assert.equal(f.state.calls, 1);
});

test("durability failure forbids state disclosure until exact visible bytes are repaired", async t => {
  const f = await fixture(t), dir = path.join(f.cwd, "delegation-group-rounds");
  const file = path.join(dir, fs.readdirSync(dir).find(n => n.endsWith(".json"))), before = fs.readFileSync(file);
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => {
    const stat = fs.fstatSync(fd);
    if (stat.ino === fs.statSync(file).ino) throw new Error("controlled journal fsync failure");
    return original(fd);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.open().get(f.spec.groupId), /controlled journal fsync failure/); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await f.open().get(f.spec.groupId)).revision, 1);
  const link = `${file}.hold`; fs.linkSync(file, link);
  await assert.rejects(f.open().get(f.spec.groupId), /unsafe_group_file/); fs.unlinkSync(link);
  fs.renameSync(file, link); fs.symlinkSync(link, file);
  await assert.rejects(f.open().get(f.spec.groupId)); fs.unlinkSync(file); fs.renameSync(link, file);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal((await f.open().get(f.spec.groupId)).revision, 1);
});

const optionalGate = step => ({ step, expects: [{ id: "optional", kind: "trust.bundle", required: false, description: "Optional observation", bundle_claim: { claimType: "fixture.optional" } }] });
function managedDefinition(mode = "blocked") {
  return { id: `rounds-flow-${mode}`, version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "first", next: null, mutable_resources: [] }, { id: "second", next: null, ...(mode === "parallel" ? {} : { needs: ["first"] }), mutable_resources: [] }],
    gates: { first: mode === "blocked" ? { step: "first", expects: [{ id: "external", kind: "trust.bundle", required: true, description: "External evidence", bundle_claim: { claimType: "fixture.external", accepted_statuses: ["verified"] } }] } : optionalGate("first"),
      second: mode === "route" ? { step: "second", on_route_back: { missing_evidence: "first" }, route_back_policy: { max_attempts: 1, on_exceeded: "block" },
        expects: [{ id: "missing", kind: "trust.bundle", required: true, description: "Route-back input", bundle_claim: { claimType: "fixture.missing" } }] } : optionalGate("second") } };
}
async function flowRelease(f, key, selections) {
  const p = await f.controller.get(f.spec.groupId), run = await loadRun(f.spec.topology.runId, f.cwd);
  return f.cmd("release", p, key, { checkpoint: ref(key), flowHead: flowRunHead(run.state), seats: selections });
}
const invoke = (seatId, previousInvocationId = null, retryRef = null) => ({ seatId, mode: "invoke", previousInvocationId, retryRef });
async function externalEvidence(f, gate = "first") {
  const file = path.join(f.cwd, "external.json"), at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 5, source: "controlled-external", policies: [],
    claims: [{ id: "external", subjectType: "flow-step", subjectId: "first", claimType: "fixture.external", fieldOrBehavior: "External report", value: "pass", createdAt: at, updatedAt: at }],
    evidence: [{ id: "external-evidence", claimId: "external", evidenceType: "human_attestation", method: "attestation", sourceRef: "controlled:external", excerptOrSummary: "External observation arrived", observedAt: at, collectedBy: "fixture-host" }],
    events: [{ id: "external-event", claimId: "external", status: "verified", actor: "fixture-host", method: "attestation", evidenceIds: ["external-evidence"], createdAt: at, verifiedAt: at }] }));
  await attachEvidence(f.spec.topology.runId, { cwd: f.cwd, gate, file, kind: "trust.bundle" });
}

test("Flow rounds: denied retained-result confirmation holds the admitted continuation without replay effects", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition() });
  const firstCommand = await flowRelease(f, "first-paid", [invoke("seat-0")]);
  const first = await f.controller.release(firstCommand), attempt = first.projection.attempts[0];
  assert.equal(f.state.calls, 1); assert.equal(first.projection.flowActions[0].mode, "invoke");
  assert.equal(first.projection.flowActions[0].claim.value.claim_id, attempt.claimRefs[0]);
  assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.multi_cursor.blocked_steps[0].step_id, "first");
  await f.terminal(attempt.invocationId); await externalEvidence(f);
  const continuation = await flowRelease(f, "external-arrived", [{ seatId: "seat-0", mode: "evaluate", invocationId: attempt.invocationId }]);
  f.state.denyRetained = true; await assert.rejects(f.controller.release(continuation), /rounds_retained_result_unconfirmed/);
  assert.equal(f.state.calls, 1);
  // Denied retained-result confirmation happened after intent commit; no replay resumes it.
  assert.equal((await f.open().release(continuation)).replayed, true);
});

test("Flow rounds: evaluation-only durable receipt advances gate with one provider call and replay has no effects", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition() });
  const first = await f.controller.release(await flowRelease(f, "first-paid", [invoke("seat-0")]));
  const attempt = first.projection.attempts[0]; await f.terminal(attempt.invocationId); await externalEvidence(f);
  const continuation = await flowRelease(f, "evidence-arrived", [{ seatId: "seat-0", mode: "evaluate", invocationId: attempt.invocationId }]);
  const evaluated = await f.open().release(continuation);
  assert.equal(f.state.calls, 1); assert.equal(evaluated.projection.attempts.length, 1);
  const actions = evaluated.projection.flowActions; assert.deepEqual(actions.map(a => a.mode), ["invoke", "evaluate"]);
  assert.notEqual(actions[0].claim.value.claim_id, actions[1].claim.value.claim_id);
  assert.ok(actions[1].evaluation);
  const durable = fs.readFileSync(path.join(f.cwd, `${actions[1].evaluation.reference.id}.json`));
  assert.equal(`sha256:${createHash("sha256").update(durable).digest("hex")}`, actions[1].evaluation.reference.digest);
  assert.equal(JSON.parse(durable).kind, "evaluation-only");
  assert.equal(JSON.parse(durable).outcomes[0].status, "pass");

  assert.deepEqual(evaluated.projection.attempts[0].claimRefs, actions.map(a => a.claim.value.claim_id));
  const receipt = f.state.evaluations.at(-1).receipt;
  assert.equal(receipt.kind, "evaluation-only"); assert.equal(receipt.invocationId, attempt.invocationId);
  assert.equal(receipt.retainedResult.digest, attempt.observation.digest); assert.equal(receipt.outcomes[0].status, "pass");
  let run = await loadRun(f.spec.topology.runId, f.cwd);
  assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), ["second"]);
  assert.ok(!run.state.multi_cursor.claim_history.some(e => e.step_id === "second"));
  const before = flowRunHead(run.state), history = await f.controller.events(f.spec.groupId);
  assert.equal((await f.open().release(continuation)).replayed, true);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before);
  assert.deepEqual(await f.controller.events(f.spec.groupId), history);
  const last = await f.open().release(await flowRelease(f, "release-second", [invoke("seat-1")]));
  assert.equal(f.state.calls, 2); assert.equal(last.projection.attempts.length, 2);
  run = await loadRun(f.spec.topology.runId, f.cwd); assert.equal(run.state.status, "completed");
  assert.equal((await f.service.inspect("root")).invocations.length, 2);
});

test("Flow rounds: unassigned ready seats are never claimed and release authenticates before claiming", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  const denied = await flowRelease(f, "denied", [invoke("seat-0")]); f.state.denyCheckpoint = "denied";
  await assert.rejects(f.controller.release(denied), /rounds_host_authorization/);
  assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.multi_cursor.claim_history.length, 0);
  const first = await f.controller.release(await flowRelease(f, "only-first", [invoke("seat-0")]));
  const run = await loadRun(f.spec.topology.runId, f.cwd);
  assert.equal(f.state.calls, 1); assert.equal(first.projection.attempts.length, 1);
  assert.ok(run.state.multi_cursor.claim_history.every(e => e.step_id === "first"));
  assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), ["second"]);
});

test("Flow rounds: omitted legacy gate attempt supports route-back with fresh claims while prior unknown holds remain", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("route"), maxRounds: 8 });
  const first = await f.controller.release(await flowRelease(f, "first", [invoke("seat-0")]));
  const original = first.projection.attempts[0]; await f.terminal(original.invocationId);
  const route = await f.controller.release(await flowRelease(f, "route", [invoke("seat-1")]));
  let run = await loadRun(f.spec.topology.runId, f.cwd);
  const transition = run.state.transitions.find(t => t.type === "route_back"); assert.equal(transition.to_step, "first");
  const evaluation = await flowRelease(f, "forbidden-old-result", [{ seatId: "seat-0", mode: "evaluate", invocationId: original.invocationId }]);
  await assert.rejects(f.controller.release(evaluation), /rounds_retained_result_invalidated/);
  await assert.rejects(f.controller.release(await flowRelease(f, "missing-retry-authority", [invoke("seat-0", original.invocationId)])), /rounds_current_flow_retry_required/);
  // A prior physical attempt outside this group's release history shares this exact root.
  // Its unknown settlement is retained, never recovered or relabeled as zero.
  f.state.unknown = true;
  const unknownId = "prior-unknown";
  await assert.rejects(executeAuthorizedDelegation({ service: f.service,
    dispatchLedger: new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") }),
    authorityId: "root", envelopeId: "child", invocationId: unknownId, effect: "read", allocation,
    request: { messages: [{ role: "user", content: "Prior external attempt" }], maxOutputTokens: 5 },
    host: { ...f.physical, async invokeFenced(_e, id, launch) {
      assert.equal((await f.service.inspect("root")).invocations.find(i => i.invocationId === id).terminal, false); return launch();
    } },
  }), error => {
    assert.equal(error.code, "AUTHORIZATION_PERSISTENCE_FAILED"); assert.equal(error.phase, "settle");
    assert.equal(error.duplicateInvocationRisk, true); return true;
  });
  f.state.unknown = false;
  const unknownBefore = (await f.service.inspect("root")).invocations.find(i => i.invocationId === unknownId);
  assert.equal(unknownBefore.usage, null);
  const retried = await f.open().release(await flowRelease(f, "authorized-route", [invoke("seat-0", original.invocationId, flowTransitionRef(transition))]));
  assert.equal(f.state.calls, 4);
  const attempt = retried.projection.attempts.at(-1);
  assert.equal(attempt.previousInvocationId, original.invocationId); assert.notEqual(attempt.invocationId, original.invocationId);
  assert.notEqual(attempt.claimRefs[0], original.claimRefs[0]);
  const ledger = await f.openAuthority().inspect("root");
  assert.equal(ledger.invocations.length, 4); assert.deepEqual(ledger.invocations.find(i => i.invocationId === unknownId), unknownBefore);
  assert.equal(ledger.root.authority_id, "root"); assert.equal(ledger.envelopes.length, 2);
  assert.equal(ledger.invocations.filter(i => i.usage !== null).reduce((n, i) => n + i.usage.costMicros, 0), 9);
  assert.equal(route.projection.attempts.length, 2);
});


test("Flow rounds: exhausted route requires public authorizeRetry before another paid claim", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("route"), maxRounds: 8, attempts: 12, maxRecoveries: 4 });
  const a = (await f.controller.release(await flowRelease(f, "first", [invoke("seat-0")]))).projection.attempts.at(-1);
  await f.terminal(a.invocationId);
  const b = (await f.controller.release(await flowRelease(f, "route-1", [invoke("seat-1")]))).projection.attempts.at(-1);
  await f.terminal(b.invocationId);
  let run = await loadRun(f.spec.topology.runId, f.cwd), route = run.state.transitions.find(t => t.type === "route_back");
  const next = (await f.controller.release(await flowRelease(f, "first-retry", [invoke("seat-0", a.invocationId, flowTransitionRef(route))]))).projection.attempts.at(-1);
  await f.terminal(next.invocationId);
  await f.controller.release(await flowRelease(f, "route-exhausts", [invoke("seat-1", b.invocationId, flowTransitionRef(route))]));
  run = await loadRun(f.spec.topology.runId, f.cwd); const claimedBlock = run.state.transitions.at(-1);
  assert.equal(claimedBlock.status, "blocked"); assert.equal(claimedBlock.type, undefined);
  const directAt = new Date().toISOString();
  await assert.rejects(authorizeRetry(f.spec.topology.runId, { cwd: f.cwd, request: {
    reason: "Direct claimed exhaustion probe", target_step: "first", blocked_transition_ref: flowTransitionRef(claimedBlock), expected_run_head: flowRunHead(run.state),
    authority: { kind: "operator_request", actor: "fixture-host", request_ref: "controlled:direct-retry", requested_at: directAt },
  } }), /flow.retry_authorization.block.invalid/);
  const reappraisalCommand = await continuationCommand(f, "reappraise", "reappraise-exhaustion", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  await f.controller.reappraise(reappraisalCommand);
  run = await loadRun(f.spec.topology.runId, f.cwd); const exhausted = run.state.transitions.at(-1);
  assert.equal(exhausted.type, "route_back"); assert.equal(exhausted.limit_exceeded, true);
  const before = flowRunHead(run.state);
  await assert.rejects(f.controller.release(await flowRelease(f, "refused", [invoke("seat-0", next.invocationId, flowTransitionRef(exhausted))])), /rounds_current_flow_retry_required|rounds_step_not_ready/);
  assert.equal(f.state.calls, 4); assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before);
  const at = new Date().toISOString();
  const authorizationCommand = await continuationCommand(f, "authorizeRetry", "authorize-epoch", { reappraisalKey: reappraisalCommand.operationKey, request: {
    reason: "Explicit operator retry after diagnosis", target_step: "first", blocked_transition_ref: flowTransitionRef(exhausted), expected_run_head: before,
    authority: { kind: "operator_request", actor: "fixture-host", request_ref: "controlled:retry-request", requested_at: at },
  } });
  const wrongKey = { ...authorizationCommand, operationKey: "unchecked-authorization", checkpoint: ref("unchecked-authorization"), reappraisalKey: "missing-reappraisal" };
  await assert.rejects(f.controller.authorizeRetry(wrongKey), /rounds_checked_reappraisal_required/);
  await f.controller.authorizeRetry(authorizationCommand);
  const recoveryHead = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), recoveryHistory = await f.controller.events(f.spec.groupId);
  assert.equal((await f.open().reappraise(reappraisalCommand)).replayed, true);
  assert.equal((await f.open().authorizeRetry(authorizationCommand)).replayed, true);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), recoveryHead);
  assert.deepEqual(await f.controller.events(f.spec.groupId), recoveryHistory);
  run = await loadRun(f.spec.topology.runId, f.cwd); route = run.state.transitions.at(-1);
  assert.equal(route.type, "retry_authorized");
  await f.controller.release(await flowRelease(f, "authorized-epoch", [invoke("seat-0", next.invocationId, flowTransitionRef(route))]));
  assert.equal(f.state.calls, 5); assert.equal((await f.service.inspect("root")).invocations.length, 5);
});

test("Flow rounds: stale checkpoint and cancellation do not acquire claims or dispatch", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  const stale = await flowRelease(f, "stale-head", [invoke("seat-0")]); stale.flowHead = "0".repeat(64);
  await assert.rejects(f.controller.release(stale), /rounds_flow_head_conflict/);
  const p = await f.controller.get(f.spec.groupId); await f.controller.cancel(f.cmd("cancel", p, "cancel"));
  await assert.rejects(f.controller.release(await flowRelease(f, "after-cancel", [invoke("seat-0")])), /rounds_authority_cancelled/);
  assert.equal(f.state.calls, 0); assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.multi_cursor.claim_history.length, 0);
});

test("Flow rounds: lost evaluation receipt leaves exact committed Flow state held without replay effects", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") }); f.state.evaluationRetentionFailure = true;
  const c = await flowRelease(f, "first", [invoke("seat-0")]); await assert.rejects(f.controller.release(c), /orchestration failed/);
  const run = await loadRun(f.spec.topology.runId, f.cwd), before = flowRunHead(run.state);
  assert.equal(f.state.calls, 1); assert.equal(run.state.gate_outcomes[0].status, "pass");
  const p = await f.open().get(f.spec.groupId); assert.equal(p.flowActions[0].evaluation, null); assert.equal(p.rounds[0].returned, false);
  assert.equal((await f.open().release(c)).replayed, true); assert.equal(f.state.calls, 1);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before);
  await assert.rejects(f.open().release(await flowRelease(f, "later", [invoke("seat-1")])), /rounds_pending_hold/);
});

test("Flow rounds: evaluation ceiling and missing retry authority refuse continuation before claiming", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition(), maxEvaluations: 0 });
  const p = (await f.controller.release(await flowRelease(f, "first", [invoke("seat-0")]))).projection;
  const attempt = p.attempts[0]; await f.terminal(attempt.invocationId); await externalEvidence(f);
  const run = await loadRun(f.spec.topology.runId, f.cwd), before = flowRunHead(run.state);
  await assert.rejects(f.controller.release(await flowRelease(f, "no-evaluation-capacity", [{ seatId: "seat-0", mode: "evaluate", invocationId: attempt.invocationId }])), /rounds_evaluation_capacity/);
  await assert.rejects(f.controller.release(await flowRelease(f, "no-paid-retry", [invoke("seat-0", attempt.invocationId)])), /rounds_current_flow_retry_required/);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before); assert.equal(f.state.calls, 1);
});

test("Flow rounds: optional scheduler selection rejects fabricated or duplicate ready steps before public claim", async t => {
  const { orchestrateFlowMultiCursor } = await import("@kontourai/flow-agents");
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  for (const selection of [["not-ready"], ["first", "first"]]) {
    await assert.rejects(orchestrateFlowMultiCursor({ runId: f.spec.topology.runId, cwd: f.cwd, actor: f.spec.topology.actor,
      selectReadySteps: async () => selection, execute: async () => { throw new Error("unexpected dispatch"); } }), error => {
      assert.match(error.cause.message, /unique subset of Flow's ready frontier/); return true;
    });
  }
  assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.multi_cursor.claim_history.length, 0);
});

test("Flow rounds: durable history refuses a corrupted claim base before disclosure", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  await f.controller.release(await flowRelease(f, "first", [invoke("seat-0")]));
  const dir = path.join(f.cwd, "delegation-group-rounds"), file = path.join(dir, fs.readdirSync(dir).find(n => n.endsWith(".json")));
  const original = fs.readFileSync(file), journal = JSON.parse(original);
  journal.events.find(e => e.kind === "flow_claimed").claim.claim_base.step_id = "second";
  fs.writeFileSync(file, canonicalJson(journal));
  try { await assert.rejects(f.open().get(f.spec.groupId), /rounds_claim_base/); }
  finally { fs.writeFileSync(file, original); }
  assert.equal((await f.open().get(f.spec.groupId)).attempts[0].claimRefs.length, 1);
});


test("Flow rounds: first seat releases a bounded fanout and Flow alone admits its join", async t => {
  const definition = { id: "fanout-join", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "first", next: null, mutable_resources: [] },
      { id: "second", next: null, needs: ["first"], mutable_resources: [] },
      { id: "third", next: null, needs: ["first"], mutable_resources: [] },
      { id: "join", next: null, needs: ["second", "third"], mutable_resources: [] }],
    gates: Object.fromEntries(["first", "second", "third", "join"].map(step => [step, optionalGate(step)])) };
  const f = await fixture(t, { managedDefinition: definition, attempts: 12, maxConcurrent: 1 });
  await assert.rejects(f.controller.release(await flowRelease(f, "early-join", [invoke("seat-3")])), /rounds_step_not_ready/);
  await f.controller.release(await flowRelease(f, "first", [invoke("seat-0")]));
  let run = await loadRun(f.spec.topology.runId, f.cwd);
  assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state).sort(), ["second", "third"]);
  await f.controller.release(await flowRelease(f, "fanout", [invoke("seat-1"), invoke("seat-2")]));
  assert.equal(f.state.calls, 3); assert.equal(f.state.peak, 1);
  run = await loadRun(f.spec.topology.runId, f.cwd);
  assert.deepEqual(claimableMultiCursorSteps(run.definition, run.state), ["join"]);
  assert.ok(!run.state.multi_cursor.claim_history.some(e => e.step_id === "join"));
  await f.controller.release(await flowRelease(f, "join", [invoke("seat-3")]));
  assert.equal(f.state.calls, 4); assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.status, "completed");
  const p = await f.open().get(f.spec.groupId), ledger = await f.service.inspect("root");
  assert.equal(p.rounds.length, 3); assert.equal(p.attempts.length, 4); assert.equal(p.flowActions.length, 4);
  assert.equal(new Set(p.flowActions.map(a => a.claim.value.claim_id)).size, 4); assert.equal(ledger.invocations.length, 4);
  assert.equal(ledger.root.authority_id, "root"); assert.equal(ledger.envelopes.length, 4);
});


test("recovery increment: definite resource nonadmission can be explicitly released at a fresh checkpoint", async t => {
  const definition = managedDefinition("parallel"); definition.steps.forEach(s => { s.mutable_resources = ["shared/resource"]; });
  const f = await fixture(t, { managedDefinition: definition });
  const actor = { key: "foreign-holder", kind: "test" };
  const { claim } = await claimReadyStep(f.spec.topology.runId, { cwd: f.cwd, step_id: "second", claim_id: "foreign-claim", liveness_id: "foreign-live", actor });
  const original = await flowRelease(f, "deferred", [invoke("seat-0")]);
  const result = await f.controller.release(original), planned = result.projection.attempts[0];
  assert.equal(f.state.calls, 0); assert.equal((await f.service.inspect("root")).invocations.length, 0);
  assert.equal(planned.admission, "not_admitted"); assert.equal(planned.terminal, null); assert.deepEqual(planned.claimRefs, []);
  assert.equal(result.projection.flowActions[0].nonadmission.reason, "resource_conflict");
  const history = await f.open().events(f.spec.groupId); assert.equal((await f.open().release(original)).replayed, true);
  assert.deepEqual(await f.open().events(f.spec.groupId), history); assert.equal(f.state.calls, 0);
  await assert.rejects(f.terminal(planned.invocationId), /rounds_terminal_accounting_required/);
  await f.service.reserveInvocation("root", "child", "unrelated-unknown", allocation);
  const hold = (await f.service.inspect("root")).invocations.find(i => i.invocationId === "unrelated-unknown");
  await releaseStepClaim(f.spec.topology.runId, { cwd: f.cwd, claim_id: claim.claim_id, liveness_id: claim.liveness_id, actor });
  await assert.rejects(f.controller.release(await flowRelease(f, "no-recovery-reference", [invoke("seat-0")])), /rounds_previous_accounting_required/);
  const retry = await flowRelease(f, "resource-freed", [{ ...invoke("seat-0"), nonadmissionOf: planned.invocationId }]);
  f.state.allowed = false; await assert.rejects(f.open().release(retry), /rounds_host_authorization/); f.state.allowed = true;
  const recovered = await f.open().release(retry);
  assert.equal(f.state.calls, 1); assert.equal(recovered.projection.attempts.length, 2);
  assert.equal(recovered.projection.attempts[0].admission, "not_admitted");
  assert.equal(recovered.projection.attempts[1].admission, "claimed");
  assert.notEqual(recovered.projection.attempts[1].invocationId, planned.invocationId);
  const ledger = await f.service.inspect("root"); assert.equal(ledger.invocations.length, 2);
  assert.deepEqual(ledger.invocations.find(i => i.invocationId === "unrelated-unknown"), hold);
  assert.equal(ledger.root.budget.max_attempts, f.root.budget.max_attempts);
  assert.equal(recovered.projection.spec.rootAuthorityRef.id, "root");
});


async function continuationCommand(f, kind, key, fields) {
  const p = await f.controller.get(f.spec.groupId), run = await loadRun(f.spec.topology.runId, f.cwd);
  return f.cmd(kind, p, key, { checkpoint: ref(key), flowHead: flowRunHead(run.state), ...fields });
}
async function seatSync(f, seatId, key, text) {
  const contextRef = { id: `context-${key}`, domain: "fixture-context", digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  const file = path.join(f.cwd, `${contextRef.id}.txt`), fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const command = await continuationCommand(f, "sync", key, { seatId, contextRef });
  return { command, result: await f.controller.sync(command) };
}

test("recovery increment: accounted exact per-seat context ACK is required and injected into paid continuation", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("blocked"), contextSync: true, attempts: 12 });
  await assert.rejects(f.controller.release(await flowRelease(f, "unsynced", [invoke("seat-0")])), /rounds_current_seat_sync_required/);
  const firstSync = await seatSync(f, "seat-0", "sync-initial", "Initial retained facts");
  const first = await f.controller.release(await flowRelease(f, "first", [{ ...invoke("seat-0"), syncKey: firstSync.command.operationKey }]));
  assert.equal(f.state.calls, 2); assert.equal(f.state.requests[0].tools.length, 0);
  assert.equal(f.state.requests[1].messages[0].content, "Initial retained facts");
  await f.terminal(first.projection.attempts[0].invocationId); await externalEvidence(f);
  await assert.rejects(f.controller.release(await flowRelease(f, "stale-sync", [{ seatId: "seat-0", mode: "evaluate", invocationId: first.projection.attempts[0].invocationId, syncKey: firstSync.command.operationKey }])), /rounds_current_seat_sync_required/);
  const continued = await seatSync(f, "seat-0", "sync-external", "External evidence arrived; retained dissent persists");
  await f.controller.release(await flowRelease(f, "evaluate", [{ seatId: "seat-0", mode: "evaluate", invocationId: first.projection.attempts[0].invocationId, syncKey: continued.command.operationKey }]));
  assert.equal(f.state.calls, 3); // ACK invocation, no evaluation invocation.
  const secondSync = await seatSync(f, "seat-1", "sync-successor", "Verified predecessor and retained dissent");
  await f.controller.release(await flowRelease(f, "successor", [{ ...invoke("seat-1"), syncKey: secondSync.command.operationKey }]));
  assert.equal(f.state.calls, 5); assert.equal(f.state.requests.at(-1).messages[0].content, "Verified predecessor and retained dissent");
  const p = await f.open().get(f.spec.groupId);
  assert.equal(p.continuations.length, 3); assert.ok(p.continuations.every(r => r.receipt.acknowledged));
  for (const exchange of p.continuations) {
    const { receipt } = JSON.parse(fs.readFileSync(path.join(f.cwd, `${exchange.receipt.reference.id}.json`)));
    assert.equal(receipt.reason, "exact_ack"); assert.equal(receipt.status, "acknowledged");
    assert.equal(receipt.contentDigest, exchange.command.contextRef.digest); assert.equal(receipt.attempts, 1);
  }
  const ledger = await f.service.inspect("root"), events = await f.controller.events(f.spec.groupId);
  assert.equal(ledger.invocations.length, 5); assert.equal(ledger.invocations.reduce((n, i) => n + i.usage.costMicros, 0), 15);
  assert.equal((await f.open().sync(firstSync.command)).replayed, true);
  assert.deepEqual(await f.service.inspect("root"), ledger); assert.deepEqual(await f.controller.events(f.spec.groupId), events);
});

for (const mode of ["badAck", "unknown"]) test(`recovery increment: context ${mode} never qualifies continuation or resets holds`, async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 }); f.state[mode] = true;
  let command;
  const contextRef = { id: "negative-context", domain: "fixture-context", digest: `sha256:${createHash("sha256").update("Facts").digest("hex")}` };
  fs.writeFileSync(path.join(f.cwd, "negative-context.txt"), "Facts", { mode: 0o600 });
  command = await continuationCommand(f, "sync", "negative-sync", { seatId: "seat-0", contextRef });
  await assert.rejects(f.controller.sync(command));
  const p = await f.open().get(f.spec.groupId); assert.equal(p.continuations[0].receipt.acknowledged, false);
  const ledger = await f.service.inspect("root"), calls = f.state.calls;
  assert.equal(calls, mode === "unknown" ? 1 : 2); assert.equal((await f.open().sync(command)).replayed, true);
  await assert.rejects(f.controller.release(await flowRelease(f, "blocked", [{ ...invoke("seat-0"), syncKey: command.operationKey }])), /rounds_current_seat_sync_required/);
  if (mode === "unknown") {
    assert.equal(ledger.invocations[0].usage, null);
    await assert.rejects(f.controller.sync(await continuationCommand(f, "sync", "new-sync", { seatId: "seat-0", contextRef })), /rounds_sync_previous_usage_unknown/);
  }
  assert.equal(f.state.calls, calls); assert.deepEqual(await f.service.inspect("root"), ledger);
  assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.multi_cursor.claim_history.length, 0);
});


test("recovery increment: ambiguous admission cannot be relabeled as definite nonadmission", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  f.state.onSchedule = event => { if (event.kind === "admitted") throw new Error("admission observation lost"); };
  const c = await flowRelease(f, "ambiguous", [invoke("seat-0")]); await assert.rejects(f.controller.release(c), /orchestration failed/);
  const p = await f.open().get(f.spec.groupId), attempt = p.attempts[0];
  assert.equal(p.rounds[0].returned, false); assert.equal(attempt.admission, "claimed"); assert.ok(p.flowActions[0].claim);
  assert.equal(p.flowActions[0].nonadmission, undefined); assert.equal((await f.service.inspect("root")).invocations.length, 0);
  await assert.rejects(f.controller.release(await flowRelease(f, "false-deferral", [{ ...invoke("seat-0"), nonadmissionOf: attempt.invocationId }])), /rounds_definite_nonadmission_required/);
  assert.equal((await f.open().release(c)).replayed, true); assert.equal(f.state.calls, 0);
});

test("recovery increment: lost sync receipt stays pending after accounted model return", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  f.state.continuationRetentionFailure = true;
  const text = "Facts", contextRef = { id: "lost-context", domain: "fixture-context", digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  fs.writeFileSync(path.join(f.cwd, "lost-context.txt"), text, { mode: 0o600 });
  const c = await continuationCommand(f, "sync", "lost-sync", { seatId: "seat-0", contextRef });
  await assert.rejects(f.controller.sync(c), /sync receipt persistence failed/);
  const p = await f.open().get(f.spec.groupId), ledger = await f.service.inspect("root");
  assert.equal(p.continuations[0].receipt, null); assert.equal(ledger.invocations[0].usage.costMicros, 3);
  assert.equal((await f.open().sync(c)).replayed, true); assert.equal(f.state.calls, 1);
  await assert.rejects(f.controller.sync(await continuationCommand(f, "sync", "cannot-repeat", { seatId: "seat-0", contextRef })), /rounds_continuation_admission/);
  assert.deepEqual(await f.service.inspect("root"), ledger);
});

test("recovery increment: public authority renewal refuses changed grants without losing known spend or unknown holds", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  await f.controller.release(await flowRelease(f, "known", [invoke("seat-0")]));
  await f.service.reserveInvocation("root", "child", "renewal-unknown", allocation);
  const ledger = await f.service.inspect("root"), changed = structuredClone(f.root);
  changed.source_origin.source_state_id = "post-merge-source";
  changed.execution_grants.forEach(g => { g.source.source_state_id = "post-merge-source"; });
  changed.execution_grants[0].source.source_admission_receipt = ref("unsupported-host-receipt");
  await assert.rejects(f.service.issue(changed), /authority_identity_conflict/);
  const envelope = structuredClone(f.envelopes[0]); envelope.execution_binding.source = changed.execution_grants[0].source;
  await assert.rejects(f.service.derive("root", envelope), /execution_grant_binding_mismatch/);
  assert.deepEqual(await f.openAuthority().inspect("root"), ledger);
  assert.equal(ledger.invocations[0].usage.costMicros, 3); assert.equal(ledger.invocations[1].usage, null);
});

test("recovery increment: exact ACK without host physical terminal proof remains unqualified", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 }); f.state.terminal = false;
  const text = "Facts", contextRef = { id: "unproven-context", domain: "fixture-context", digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  fs.writeFileSync(path.join(f.cwd, "unproven-context.txt"), text, { mode: 0o600 });
  const c = await continuationCommand(f, "sync", "unproven-sync", { seatId: "seat-0", contextRef });
  await assert.rejects(f.controller.sync(c), /sync receipt persistence failed/);
  assert.equal(f.state.calls, 1); assert.equal((await f.open().get(f.spec.groupId)).continuations[0].receipt, null);
  assert.equal((await f.service.inspect("root")).invocations[0].usage.costMicros, 3);
  await assert.rejects(f.controller.release(await flowRelease(f, "unqualified", [{ ...invoke("seat-0"), syncKey: c.operationKey }])), /rounds_current_seat_sync_required/);
  assert.equal(f.state.calls, 1);
});

test("recovery increment: a later unknown reservation defeats stale nonadmission proof before a new claim", async t => {
  const definition = managedDefinition("parallel"); definition.steps.forEach(s => { s.mutable_resources = ["stale-proof-resource"]; });
  const f = await fixture(t, { managedDefinition: definition }), actor = { key: "foreign-proof", kind: "test" };
  const { claim } = await claimReadyStep(f.spec.topology.runId, { cwd: f.cwd, step_id: "second", claim_id: "proof-claim", liveness_id: "proof-live", actor });
  const p = (await f.controller.release(await flowRelease(f, "deferred-proof", [invoke("seat-0")]))).projection;
  await releaseStepClaim(f.spec.topology.runId, { cwd: f.cwd, claim_id: claim.claim_id, liveness_id: claim.liveness_id, actor });
  const id = p.attempts[0].invocationId; await f.service.reserveInvocation("root", "parent", id, allocation);
  const before = { events: await f.controller.events(f.spec.groupId), ledger: await f.service.inspect("root"), head: flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state) };
  await assert.rejects(f.controller.release(await flowRelease(f, "cannot-recover", [{ ...invoke("seat-0"), nonadmissionOf: id }])), /rounds_definite_nonadmission_required/);
  assert.deepEqual(await f.controller.events(f.spec.groupId), before.events);
  assert.deepEqual(await f.service.inspect("root"), before.ledger);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before.head); assert.equal(f.state.calls, 0);
});

test("R3: storage-only sync finalization survives restart and performs no second model call", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  f.state.continuationRetentionFailure = true;
  const text = "Durable retained facts", contextRef = { id: "r3-context", domain: "fixture-context", digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  fs.writeFileSync(path.join(f.cwd, `${contextRef.id}.txt`), text, { mode: 0o600 });
  const original = await continuationCommand(f, "sync", "r3-lost-sync", { seatId: "seat-0", contextRef });
  await assert.rejects(f.controller.sync(original), /sync receipt persistence failed/);
  const p = await f.open().get(f.spec.groupId), exchange = p.continuations[0];
  assert.ok(exchange.prepared); assert.equal(exchange.prepared.receipt.reason, "exact_ack"); assert.ok(exchange.prepared.terminalProofs.length > 0);
  assert.equal(exchange.receipt, null); const ledger = await f.service.inspect("root"); assert.equal(f.state.calls, 1);
  f.state.continuationRetentionFailure = false;
  const finalize = f.cmd("finalizeSync", p, "r3-finalize", { syncOperationKey: original.operationKey, preparedDigest: preparedRoundsSyncDigest(exchange.prepared) });
  await assert.rejects(f.open().finalizeSync({ ...finalize, preparedDigest: ref("tampered-sync").digest }), /rounds_prepared_sync_identity/);
  assert.deepEqual(await f.service.inspect("root"), ledger); assert.equal(f.state.calls, 1);
  f.state.allowed = false; await assert.rejects(f.open().finalizeSync(finalize), /rounds_host_authorization/); f.state.allowed = true;
  const script = `
    import fs from 'node:fs'; import { createHash } from 'node:crypto';
    import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
    import { createLocalFileDelegationRoundsStore } from '@kontourai/flow-agents/delegation-group-rounds-local-file';
    import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
    import { createLocalFileDelegationAuthorityStore } from '@kontourai/flow-agents/delegation-authority-local-file';
    import { FileAuthorizationLedger } from '@kontourai/dispatch';
    const [root, command] = process.argv.slice(1), auth = { id:'child-auth',domain:'fixture',digest:'sha256:'+'a'.repeat(64) };
    const service = createDelegationAuthorityService(createLocalFileDelegationAuthorityStore(root), { now:()=>${JSON.stringify(NOW)}, authorize:async()=>true, confirmExecution:async()=>true });
    const controller = createDelegationRoundsController({ store:createLocalFileDelegationRoundsStore(root), authorityService:service,
      dispatchLedger:new FileAuthorizationLedger({root:root+'/dispatch'}), host:{ authorize:async()=>auth,
        executionHost(){throw Error('NO SECOND MODEL CALL');}, async retainContinuation(_spec,receipt){
          const file=root+'/child-finalized.json',bytes=JSON.stringify(receipt); const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
          return {id:'child-finalized',domain:'fixture',digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
        } } });
    console.log(JSON.stringify(await controller.finalizeSync(JSON.parse(command))));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.cwd, JSON.stringify(finalize)], { cwd:process.cwd() });
  const completed = JSON.parse(stdout);
  assert.equal(completed.projection.continuations[0].receipt.acknowledged, true); assert.equal(f.state.calls, 1);
  assert.deepEqual(await f.service.inspect("root"), ledger);
  f.state.allowed = false; await assert.rejects(f.open().finalizeSync(finalize), /rounds_host_authorization/); f.state.allowed = true;
  assert.equal((await f.open().finalizeSync(finalize)).replayed, true);
  await assert.rejects(f.open().finalizeSync({ ...finalize, preparedDigest: ref("changed-replay").digest }), /rounds_intent_conflict/);
  assert.equal((await f.open().sync(original)).replayed, true); assert.equal(f.state.calls, 1);
  await f.open().release(await flowRelease(f, "r3-paid", [{ ...invoke("seat-0"), syncKey: original.operationKey }]));
  assert.equal(f.state.calls, 2);
});

test("R3: ACK recipient replacement refuses paid launch and requires fresh session ACK", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  const ackA = await seatSync(f, "seat-0", "r3-ack-A", "Session scoped facts");
  assert.deepEqual(f.state.sessionCalls, ["session-A"]);
  f.state.session = "session-B"; f.state.sessionGeneration = 2;
  const before = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state);
  await assert.rejects(f.open().release(await flowRelease(f, "r3-stale-A", [{ ...invoke("seat-0"), syncKey: ackA.command.operationKey }])), /rounds_recipient_changed_fresh_ack_required/);
  assert.equal(f.state.calls, 1); assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before);
  const ackB = await seatSync(f, "seat-0", "r3-ack-B", "Session scoped facts");
  await f.open().release(await flowRelease(f, "r3-paid-B", [{ ...invoke("seat-0"), syncKey: ackB.command.operationKey }]));
  assert.deepEqual(f.state.sessionCalls, ["session-A", "session-B", "session-B"]);
});

async function successor(f, key, sourceId = "post-merge-source") {
  fs.writeFileSync(path.join(f.cwd, "actual-host-source.txt"), sourceId, { mode: 0o600 });
  const ledger = await f.service.inspect("root"), root = structuredClone(ledger.root);
  root.authority_epoch++; root.source_origin.source_state_id = sourceId;
  root.execution_grants.forEach(g => { g.source.source_state_id = sourceId; g.source.source_admission_receipt = ref(`host-source-${sourceId}-${g.grant_id}`); });
  const reference = rootAuthorityReferenceV2(root), envelopes = [];
  for (const old of ledger.envelopes) {
    const e = structuredClone(old), grant = root.execution_grants.find(g => g.grant_id === e.selected_grant_id);
    e.root_authority_ref = reference; e.execution_binding = { runtime: grant.runtime, source: grant.source, flow_binding: grant.flow_binding };
    if (e.parent) e.parent = delegationParentReferenceV2(envelopes.find(p => p.envelope_id === e.parent.id));
    envelopes.push(e);
  }
  const command = { schemaVersion: "3.0", authorityId: "root", operationKey: key, expectedRevision: ledger.revision,
    previousAuthority: rootAuthorityReferenceV2(ledger.root), root, envelopes, hostReceipt: ref(`external-host-renewal-${key}`) };
  return command;
}

test("R3: public v3 renewal and group adoption preserve lineage spend unknown holds and old proofs", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), v3: true, attempts: 12 });
  const first = await f.controller.release(await flowRelease(f, "r3-known", [invoke("seat-0")]));
  await f.terminal(first.projection.attempts[0].invocationId);
  await f.service.reserveInvocation("root", "child", "r3-unknown-old", allocation);
  const before = await f.service.inspect("root"), spec = structuredClone((await f.controller.get(f.spec.groupId)).spec);
  let command = await successor(f, "r3-renew");
  await assert.rejects(f.service.renew(command), /renewal_host_receipt_unconfirmed/);
  command = await approveHostRenewal(f, command);
  const renewed = await f.service.renew(command); assert.equal(renewed.replayed, false);
  let current = await f.openAuthority().inspect("root");
  assert.equal(current.root.authority_id, before.root.authority_id); assert.deepEqual(current.root.budget, before.root.budget);
  assert.deepEqual(current.invocations, before.invocations); assert.deepEqual(current.epochs[0], before.epochs[0]);
  assert.deepEqual(current.lineageRoot, before.lineageRoot); assert.equal(current.epochs.length, 2);
  const durable = createLocalFileDelegationAuthorityStoreV3(f.cwd);
  await assert.rejects(durable.transact("root", async ledger => {
    ledger.invocations = []; ledger.origins = []; ledger.revision++;
    return { ledger, result: null };
  }), /immutable_invocation_origin_required/);
  await assert.rejects(durable.transact("root", async ledger => {
    ledger.origins[0].epoch = 1; ledger.revision++;
    return { ledger, result: null };
  }), /immutable_invocation_origin_required/);
  assert.deepEqual(await f.service.inspect("root"), current);
  await assert.rejects(f.controller.release(await flowRelease(f, "r3-not-adopted", [invoke("seat-1")])), /rounds_grant_adoption_required/);
  const p = await f.controller.get(f.spec.groupId), adoption = f.cmd("adoptRenewal", p, "r3-adopt", { renewalOperationKey: command.operationKey, authority: rootAuthorityReferenceV2(command.root) });
  await f.open().adoptRenewal(adoption);
  await f.open().release(await flowRelease(f, "r3-next", [invoke("seat-1")]));
  current = await f.service.inspect("root"); assert.equal(current.invocations.length, before.invocations.length + 1);
  assert.deepEqual(current.invocations.find(i => i.invocationId === "r3-unknown-old"), before.invocations.find(i => i.invocationId === "r3-unknown-old"));
  assert.deepEqual((await f.open().get(f.spec.groupId)).spec, spec);
  f.state.allowed = false; await assert.rejects(f.service.renew(command), /renewal_host_receipt_unconfirmed/); f.state.allowed = true;
  assert.equal((await f.service.renew(command)).replayed, true); assert.equal((await f.open().adoptRenewal(adoption)).replayed, true);
  await assert.rejects(f.service.reconcileInvocation("root", "r3-unknown-old", { inputTokens: 2, outputTokens: 1, costMicros: 4 }, true), /reconciliation_unconfirmed/);
  assert.equal(f.state.historicalChecks.at(-1).root.authority_epoch, 1);
  assert.deepEqual(f.state.historicalChecks.at(-1).envelope, before.envelopes.find(e => e.envelope_id === "child"));
  assert.equal((await f.service.inspect("root")).invocations.find(i => i.invocationId === "r3-unknown-old").usage, null);
  const cancelled = await approveHostRenewal(f, await successor(f, "r3-after-cancel")); await f.service.cancel("root");
  await assert.rejects(f.service.renew(cancelled), /renewal_admission_conflict/);
});


test("R3: session drift during request preparation cannot reach the paid runtime", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  const ack = await seatSync(f, "seat-0", "r3-drift-ack", "Facts");
  f.host.flow.executionHost = () => ({ ...f.physical, async prepareRequest(...args) { f.state.session = "session-replacement"; return f.physical.prepareRequest(...args); } });
  const ledger = await f.service.inspect("root");
  await assert.rejects(f.controller.release(await flowRelease(f, "r3-drift-paid", [{ ...invoke("seat-0"), syncKey: ack.command.operationKey }])), /orchestration failed/);
  assert.equal(f.state.calls, 1); assert.deepEqual(await f.service.inspect("root"), ledger);
});

test("R3: renewal rejects forged widening stale revisions and spent-budget reuse", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), v3: true, attempts: 4 });
  const first = (await f.controller.release(await flowRelease(f, "r3-spend-1", [invoke("seat-0")]))).projection.attempts[0]; await f.terminal(first.invocationId);
  await f.service.reserveInvocation("root", "parent", "r3-unknown-last-slot", allocation);
  let command = await successor(f, "r3-budget-renew"); let widening = structuredClone(command); widening.root.budget.max_attempts++;
  widening = await approveHostRenewal(f, widening, "widening");
  const before = await f.service.inspect("root"); await assert.rejects(f.service.renew(widening), /renewal_root_lineage_conflict/);
  assert.deepEqual(await f.service.inspect("root"), before);
  command = await approveHostRenewal(f, command); await f.service.renew(command);
  await assert.rejects(f.service.reserveInvocation("root","parent","r3-over-limit",allocation), /invocation_budget_exhausted/);
  assert.equal((await f.service.inspect("root")).invocations.length, 2);
  let stale = await successor(f, "r3-stale-revision"); stale.expectedRevision--;
  stale = await approveHostRenewal(f, stale);
  await assert.rejects(f.service.renew(stale), /renewal_admission_conflict/);
});


async function approveHostRenewal(f, proposed, suffix = "approved") {
  // A distinct fixture issuer owns this registry, checks actual source state and records an external operator request.
  const command = structuredClone(proposed), directory = path.join(f.cwd, "host-issued-renewals"); fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const sourceState = fs.readFileSync(path.join(f.cwd, "actual-host-source.txt"), "utf8"); assert.equal(sourceState, command.root.source_origin.source_state_id);
  const writeReceipt = (id, record) => {
    const bytes = JSON.stringify(record), file = path.join(directory, createHash("sha256").update(id).digest("hex") + ".json");
    const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { id, domain: "fixture-host-issued", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  };
  for (const grant of command.root.execution_grants) {
    grant.source.source_admission_receipt = writeReceipt(`source-${command.operationKey}-${suffix}-${grant.grant_id}`, {
      issuer: f.root.issuer_host_id, sourceState, worktree: grant.source.execution_worktree_id, runtime: grant.runtime,
      externalAuthorization: `fixture-operator-request-${command.operationKey}-${suffix}`,
    });
  }
  const reference = rootAuthorityReferenceV2(command.root);
  for (const envelope of command.envelopes) {
    const grant = command.root.execution_grants.find(g => g.grant_id === envelope.selected_grant_id);
    envelope.root_authority_ref = reference; envelope.execution_binding = { runtime: grant.runtime, source: grant.source, flow_binding: grant.flow_binding };
    if (envelope.parent) envelope.parent = delegationParentReferenceV2(command.envelopes.find(e => e.envelope_id === envelope.parent.id));
  }
  const { hostReceipt, ...payload } = command, id = `issued-${command.operationKey}-${suffix}`;
  command.hostReceipt = writeReceipt(id, { issuer: f.root.issuer_host_id, principal: f.root.authenticated_principal_ref.id,
    receiptId: id, sourceState, runtimeReceipts: f.root.execution_grants.map(g => g.runtime),
    externalAuthorization: `fixture-operator-request-${command.operationKey}-${suffix}`,
    payloadDigest: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}` });
  return command;
}


test("R3: explicit v2 custody transfer retains existing group charges and blocks implicit reissue", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel") });
  await f.controller.release(await flowRelease(f, "r3-v2-known", [invoke("seat-0")]));
  await f.service.reserveInvocation("root", "child", "r3-v2-unknown", allocation);
  const before = await f.service.inspect("root"), receipt = ref("host-custody-transfer");
  const service = createDelegationAuthorityServiceV3(createLocalFileDelegationAuthorityStoreV3(f.cwd), {
    ...f.authorityHost, authorize: async () => f.state.allowed,
    async withV2Transfer(id, supplied, body) {
      assert.deepEqual(supplied, receipt); assert.equal(id, "root");
      const snapshot = f.state.v2CustodyStopped ? before : await f.service.inspect(id);
      f.state.v2CustodyStopped = true; return body(snapshot);
    },
  }, { maxRenewals: 2 });
  await assert.rejects(service.issue(f.root), /v2_custody_transfer_required/);
  assert.equal((await service.importV2("root", "r3-transfer", receipt)).replayed, false);
  const after = await service.inspect("root"); assert.deepEqual(after.invocations, before.invocations); assert.deepEqual(after.root, before.root);
  await assert.rejects(f.service.reserveInvocation("root", "parent", "forbidden-v2", allocation), /host_authorization_refused/);
  assert.equal((await service.importV2("root", "r3-transfer", receipt)).replayed, true);
  assert.equal((await service.inspect("root")).invocations[1].usage, null);
});


test("R3: postmerge renewal invalidates the old session ACK without resetting root charges", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), v3: true, contextSync: true, attempts: 12 });
  const ackA = await seatSync(f, "seat-0", "r3-premerge-ack", "Premerge facts");
  await f.service.reserveInvocation("root", "child", "r3-unrelated-merge-hold", allocation);
  const original = await f.service.inspect("root"), command = await approveHostRenewal(f, await successor(f, "r3-source-merge"));
  await f.service.renew(command);
  let p = await f.controller.get(f.spec.groupId);
  await f.controller.adoptRenewal(f.cmd("adoptRenewal", p, "r3-source-adopt", { renewalOperationKey: command.operationKey, authority: rootAuthorityReferenceV2(command.root) }));
  f.state.session = "postmerge-session-B"; f.state.sessionGeneration = 2;
  await assert.rejects(f.controller.release(await flowRelease(f, "r3-old-merge-ack", [{ ...invoke("seat-0"), syncKey: ackA.command.operationKey }])), /rounds_recipient_changed_fresh_ack_required/);
  assert.equal(f.state.calls, 1);
  const ackB = await seatSync(f, "seat-0", "r3-postmerge-ack", "Actual merged source and retained dissent");
  await f.controller.release(await flowRelease(f, "r3-postmerge-paid", [{ ...invoke("seat-0"), syncKey: ackB.command.operationKey }]));
  assert.equal(f.state.calls, 3); assert.deepEqual(f.state.sessionCalls, ["session-A", "postmerge-session-B", "postmerge-session-B"]);
  const ledger = await f.openAuthority().inspect("root"); p = await f.open().get(f.spec.groupId);
  assert.deepEqual(ledger.invocations.find(i => i.invocationId === "r3-unrelated-merge-hold"), original.invocations.find(i => i.invocationId === "r3-unrelated-merge-hold"));
  assert.equal(ledger.invocations.filter(i => i.usage).reduce((n, i) => n + i.usage.costMicros, 0), 9);
  assert.deepEqual(ledger.root.budget, original.root.budget); assert.deepEqual(ledger.epochs[0], original.epochs[0]);
  assert.deepEqual(f.state.flowHostSpecs.at(-1).rootAuthorityRef, rootAuthorityReferenceV2(command.root));
  assert.equal(p.attempts[0].recipient.authority.authority_epoch, 2); assert.equal(p.attempts[0].recipient.recipientId, "postmerge-session-B");
  assert.equal(p.continuations[0].prepared.recipient.authority.authority_epoch, 1);
  assert.deepEqual(p.spec.rootAuthorityRef, rootAuthorityReferenceV2(f.root));
  const previous = await f.service.inspect("root"); fs.writeFileSync(path.join(f.cwd, "actual-host-source.txt"), "unexpected-source");
  await assert.rejects(f.service.admitEffect("root", "parent", "read"), /execution_binding_unconfirmed/);
  assert.deepEqual((await f.service.inspect("root")).invocations, previous.invocations);
});


test("Accounting rounds: independent attempt preserves exact 123 micros without reported Relay dollars", async t => {
  const f = await fixture(t, {retainedAccounting:true, accountingProtocol:"retained-tariff-v1", tariffMicros:123,
    allocation:{inputTokens:5,outputTokens:5,costMicros:200}});
  const command=await f.release("tariff-first",["seat-0"]);
  await f.controller.release(command);
  const ledger=await f.service.inspect("root");
  assert.equal(f.state.calls,1);assert.equal(ledger.invocations[0].usage.costMicros,123);
  const outcome=f.state.observations.at(-1).observation.outcome;
  assert.equal(outcome.costBasis,"tariff-upper-bound");assert.equal(outcome.reportedCostUsd,undefined);
  assert.equal(outcome.result.usage.costUsd,undefined);
  assert.equal((await f.open().release(command)).replayed,true);assert.equal(f.state.calls,1);
});

test("Accounting rounds: missing opt-in and unknown tariff retain full allocations", async t => {
  for(const protocol of [undefined,"retained-tariff-v1"]){
    const f=await fixture(t,{retainedAccounting:true,accountingProtocol:protocol});
    if(protocol)f.state.unknown=true;
    await f.controller.release(await f.release("held",["seat-0"]));
    const ledger=await f.service.inspect("root");assert.equal(f.state.calls,1);
    assert.equal(ledger.invocations[0].usage,null);assert.deepEqual(ledger.invocations[0].allocation,allocation);
    assert.ok(f.state.observations.at(-1).observation.error);
  }
});

test("Accounting rounds: exact session ACK, paid Flow continuation and storage-only recovery preserve tariff basis", async t => {
  const f=await fixture(t,{managedDefinition:managedDefinition("blocked"),contextSync:true,attempts:12,
    retainedAccounting:true,accountingProtocol:"retained-tariff-v1",tariffMicros:7});
  f.state.continuationRetentionFailure=true;
  let original;const originalSync=f.controller.sync.bind(f.controller);f.controller.sync=command=>{original=command;return originalSync(command);};
  await assert.rejects(seatSync(f,"seat-0","tariff-sync","Retained exact context"));
  const p=await f.open().get(f.spec.groupId), exchange=p.continuations.at(-1);
  assert.equal(exchange.prepared.invocations[0].usage.costMicros,7);assert.equal(f.state.calls,1);
  const before=await f.service.inspect("root");f.state.continuationRetentionFailure=false;
  await f.open().finalizeSync(f.cmd("finalizeSync",p,"tariff-finalize",{
    syncOperationKey:original.operationKey,preparedDigest:preparedRoundsSyncDigest(exchange.prepared)}));
  assert.equal(f.state.calls,1);assert.deepEqual(await f.service.inspect("root"),before);
  await f.open().release(await flowRelease(f,"tariff-paid",[{...invoke("seat-0"),syncKey:original.operationKey}]));
  assert.equal(f.state.calls,2);const ledger=await f.service.inspect("root");
  assert.deepEqual(ledger.invocations.map(i=>i.usage.costMicros),[7,7]);
  const outcome=f.state.observations.find(o=>o.outcome)?.outcome;
  assert.equal(outcome.costBasis,"tariff-upper-bound");assert.equal(outcome.reportedCostUsd,undefined);
  assert.ok(f.state.requests.every(r=>r.tools?.length===0||r.tools===undefined));
  assert.ok(f.state.sessionCalls.every(session=>session==="session-A"));
});

test("explicit cancel finalization observes retained requests after the authority-cancel window without repeating interrupts", async t => {
  const f = await fixture(t, { v3: true });
  f.state.unknown = true;
  await f.controller.release(await f.release("unknown-before-cancel", ["seat-0"]));
  const held = (await f.openAuthority().inspect("root")).invocations;
  assert.equal(held.length, 1); assert.equal(held[0].usage, null);
  const authorize = f.authorityHost.authorize;
  let failCancel = true;
  f.authorityHost.authorize = async (action, ...rest) => {
    if (action === "cancel" && failCancel) throw Error("controlled authority-cancel window");
    return authorize(action, ...rest);
  };
  const original = f.cmd("cancel", await f.controller.get(f.spec.groupId), "original-cancel");
  await assert.rejects(f.open().cancel(original), /controlled authority-cancel window/);
  failCancel = false;
  const replay = await f.open().cancel(original);
  assert.equal(replay.projection.cancellation, "pending");
  assert.equal((await f.openAuthority().inspect("root")).cancelled, false);
  const finalize = { ...f.cmd("cancel", replay.projection, "finalize-cancel"), kind: "finalizeCancel", cancelOperationKey: original.operationKey };
  await assert.rejects(f.open().finalizeCancel(finalize), /rounds_cancel_confirmation_required/);
  await assert.rejects(f.open().finalizeCancel({ ...finalize, expectedRevision: 0 }), /rounds_revision_conflict/);
  await assert.rejects(f.open().finalizeCancel({ ...finalize, controller: { ...finalize.controller, generation: 2 } }), /rounds_revision_conflict/);
  let observed = 0, retained = null;
  f.host.confirmCancellation = async (spec, command) => {
    observed++; assert.equal(spec.groupId, original.groupId); assert.deepEqual(command, original); return retained;
  };
  await assert.rejects(f.open().finalizeCancel({ ...finalize, cancelOperationKey: "foreign" }), /rounds_cancel_identity/);
  assert.equal(observed, 0);
  await assert.rejects(f.open().finalizeCancel(finalize), /rounds_cancel_confirmation_required/);
  assert.equal((await f.openAuthority().inspect("root")).cancelled, true);
  assert.equal((await f.controller.get(f.spec.groupId)).cancellation, "pending");
  retained = ref("independently-retained-request");
  const beforeConcurrent = observed;
  const concurrent = await Promise.all([f.open().finalizeCancel(finalize), f.open().finalizeCancel(finalize)]);
  assert.equal(concurrent.filter(result => !result.replayed).length, 1);
  assert.equal(observed, beforeConcurrent + 1);
  const done = concurrent.find(result => !result.replayed);
  assert.equal(done.projection.cancellation, "requested");
  assert.deepEqual((await f.openAuthority().inspect("root")).invocations, held);
  const beforeReplay = observed;
  assert.equal((await f.open().finalizeCancel(finalize)).replayed, true);
  assert.equal(observed, beforeReplay);
  await assert.rejects(f.open().finalizeCancel({ ...finalize, cancelOperationKey: "changed" }), /rounds_intent_conflict/);
  f.state.allowed = false;
  await assert.rejects(f.open().finalizeCancel(finalize), /rounds_host_authorization/);
  assert.equal(f.state.cancels, 0); assert.equal(f.state.calls, 1);
  assert.equal(done.projection.attempts.length, 1);
});


test("explicit initial-request sync policy permits only unattempted seat bootstrap; current ACK still gates continuation", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("blocked"), contextSync: true, syncAdmission: "initial-request", attempts: 12 });
  const firstCommand = await flowRelease(f, "initial-paid", [invoke("seat-0")]);
  const first = await f.controller.release(firstCommand);
  assert.equal(f.state.calls, 1);
  assert.equal(first.projection.continuations.length, 0);
  assert.equal(first.projection.spec.policy.syncAdmission, "initial-request");
  await f.terminal(first.projection.attempts[0].invocationId);
  await externalEvidence(f);
  const evaluation = { seatId: "seat-0", mode: "evaluate", invocationId: first.projection.attempts[0].invocationId };
  await assert.rejects(f.controller.release(await flowRelease(f, "continued-without-ack", [evaluation])), /rounds_current_seat_sync_required/);
  const synced = await seatSync(f, "seat-0", "current-ack", "Authenticated corrected context");
  await f.controller.release(await flowRelease(f, "continued-evaluation", [{ ...evaluation, syncKey: synced.command.operationKey }]));
  assert.equal(f.state.calls, 2);
  const ledger = await f.service.inspect("root");
  assert.ok(ledger.invocations.some(i => i.invocationId === f.state.syncIdentities[0].invocationIds[0]));
  await f.controller.release(await flowRelease(f, "successor-initial", [invoke("seat-1")]));
  assert.equal(f.state.calls, 3);
  assert.equal((await loadRun(f.spec.topology.runId, f.cwd)).state.status, "completed");
  const widened = structuredClone(f.create); widened.spec.policy.syncAdmission = "every-release";
  await assert.rejects(f.controller.create(widened), /rounds_intent_conflict/);
  assert.equal(f.state.calls, 3);
});

test("initial-request admission cannot bypass a failed sync exchange", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, syncAdmission: "initial-request", attempts: 12 });
  f.state.badAck = true;
  await assert.rejects(seatSync(f, "seat-0", "bad-initial-ack", "Facts"));
  const calls = f.state.calls;
  await assert.rejects(f.controller.release(await flowRelease(f, "initial-bypass", [invoke("seat-0")])), /rounds_current_seat_sync_required/);
  assert.equal(f.state.calls, calls);
});

for (const {policy, maxSyncs} of [{policy: "unknown", maxSyncs: 1}, {policy: "initial-request", maxSyncs: 0}]) test(`sync admission policy is closed and requires declared positive sync capacity: ${policy}`, async t => {
  await assert.rejects(fixture(t, { managedDefinition: managedDefinition("parallel"), contextSync: true, maxSyncs, syncAdmission: policy }), /rounds_sync_admission_policy/);
});


test("initial-request admission still requires exact current ACK before a paid route-back retry", async t => {
  const f = await fixture(t, { managedDefinition: managedDefinition("route"), contextSync: true, syncAdmission: "initial-request", attempts: 12 });
  const first = await f.controller.release(await flowRelease(f, "initial-first", [invoke("seat-0")]));
  const firstAttempt = first.projection.attempts[0]; await f.terminal(firstAttempt.invocationId);
  const second = await f.controller.release(await flowRelease(f, "initial-successor", [invoke("seat-1")]));
  await f.terminal(second.projection.attempts.at(-1).invocationId);
  const run = await loadRun(f.spec.topology.runId, f.cwd);
  const route = run.state.transitions.find(t => t.type === "route_back"); assert.ok(route && route.limit_exceeded !== true);
  const selection = invoke("seat-0", firstAttempt.invocationId, flowTransitionRef(route));
  await assert.rejects(f.controller.release(await flowRelease(f, "unsynced-paid-retry", [selection])), /rounds_current_seat_sync_required/);
  assert.equal(f.state.calls, 2);
  const synced = await seatSync(f, "seat-0", "retry-context", "Current route-back facts");
  const retried = await f.controller.release(await flowRelease(f, "paid-retry", [{ ...selection, syncKey: synced.command.operationKey }]));
  assert.equal(f.state.calls, 4);
  assert.equal(retried.projection.attempts.at(-1).previousInvocationId, firstAttempt.invocationId);
});
