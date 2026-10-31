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
import { FileAuthorizationLedger, AuthorizationPersistenceError } from "@kontourai/dispatch";
import { canonicalJson } from "@kontourai/relay";
import { delegationAccountingDollarsV1 } from "../../build/src/delegation-dispatch.js";
import { definitionIdentity, definitionDigest, amendRunDefinition, startRun, loadRun, claimableMultiCursorSteps, claimReadyStep, evaluateClaimedStep, evaluateRunChecked, reopenMultiCursorStep, attachEvidence, flowRunHead, flowTransitionRef, authorizeRetry, releaseStepClaim, pauseRun, resumeRun } from "@kontourai/flow";
import { authenticateContinuationWinner, continuationOperation, continuationObservation, continuationDigest } from "../../build/src/delegation-continuation-receipt.js";
import { createDelegationAuthorityServiceV3 } from "@kontourai/flow-agents/delegation-authority-service-v3";
import { createLocalFileDelegationAuthorityStoreV3 } from "@kontourai/flow-agents/delegation-authority-local-file-v3";
import { preparedRoundsSyncDigest } from "@kontourai/flow-agents/delegation-group-rounds";
import { createDelegationAuthorityService } from "@kontourai/flow-agents/delegation-authority-service";
import { createLocalFileDelegationAuthorityStore } from "@kontourai/flow-agents/delegation-authority-local-file";
import { delegationEnvelopeDigestV2, delegationParentReferenceV2, rootAuthorityReferenceV2 } from "@kontourai/flow-agents/delegation-envelope-v2";
import { createDelegationRoundsController, DelegationRoundsTransactionParentError, delegationRoundsSyncIdentity, delegationRoundsCapacity, projectDelegationRounds, ROUNDS_MAX_BYTES, ROUNDS_MAX_EVENTS } from "@kontourai/flow-agents/delegation-group-rounds";
import { createLocalFileDelegationRoundsStore } from "@kontourai/flow-agents/delegation-group-rounds-local-file";
import { executeAuthorizedDelegation } from "@kontourai/flow-agents/delegation-execution";
import { orchestrateDelegationFlow } from "@kontourai/flow-agents/delegation-flow-execution";
const NOW = "2026-10-21T12:00:00.000Z", EXPIRY = "2026-10-22T12:00:00.000Z";
const ref = id => ({ id, domain: "fixture-receipt", digest: `sha256:${createHash("sha256").update(id).digest("hex")}` });
const allocation = { inputTokens: 5, outputTokens: 5, costMicros: 10 };
function authorityFixture(flow, options = {}) {
  const steps = options.managedDefinition?.steps.map(s => s.id) ?? ["first", "second"];
  const ceiling = { allowed_tools: options.allowedTools ?? [], allowed_effects: options.contextSync ? ["read", "context-sync"] : ["read"], readable_resources: [], mutable_resources: [], posture: "report-only", approval: "requires_approval", escalation: "deny" };
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
    confirmReconciliation: async () => state.allowed && !state.rejectReconciliation,
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
    async retainDispatchReservation(reservation, envelope, invocationId) {
      if (!options.captureDispatchReservations) return;
      state.dispatchReservations ??= [];
      state.dispatchReservations.push({ reservation: structuredClone(reservation), envelopeId: envelope.envelope_id, invocationId });
    },
    async retainResult(result, envelope, invocationId) {
      const reference = retain(result);
      if (options.recoveryProbe) {
        state.retainedResults ??= [];
        state.retainedResults.push({ reference, envelope: structuredClone(envelope), invocationId });
      }
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
      if (action === "replay" && state.denyReplayAuthorization) return null;
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
      if (state.continuationRetentionFailure) throw new Error("continuation receipt retention unavailable");
      if (receipt.schemaVersion !== "1.0" || !receipt.receipt) return retain(receipt);
      const bytes = canonicalJson(receipt), digest = createHash("sha256").update(bytes).digest("hex");
      const id = `continuation-${digest}`, file = path.join(cwd, `${id}.json`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });
      else assert.equal(fs.readFileSync(file, "utf8"), bytes);
      state.continuationRetains ??= []; state.continuationRetains.push(bytes);
      return { id, domain: "retained-observation", digest: `sha256:${digest}` };
    },
    async loadContinuation(_spec, reference) {
      state.continuationLoads = (state.continuationLoads ?? 0) + 1;
      return fs.readFileSync(path.join(cwd, `${reference.id}.json`), "utf8");
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
          retainDispatchReservation: physical.retainDispatchReservation,
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
      async acquireContinuationPublication(input) {
        if (state.denyContinuationLease) throw new Error("controlled continuation lease refusal");
        await state.beforePublicationAcquire?.(input);
        const prior = state.publication ?? Promise.resolve();
        let unlock;
        state.publication = new Promise(resolve => { unlock = resolve; });
        await prior;
        let active = true;
        return {
          assertCurrent() { assert.equal(active, true); assert.equal(state.allowed, true); },
          flowAdmission: { async acquire() {
            assert.equal(active, true);
            await state.onContinuationLease?.();
            let childActive = true;
            return { assertCurrent() { assert.equal(active && childActive, true); assert.equal(state.allowed, true); },
              release() { childActive = false; } };
          } },
          async release() { assert.equal(active, true); active = false; unlock();
            if (state.continuationReleaseFailure) throw new Error("controlled parent release failure"); },
        };
      },
      async acquireContinuationMutation() {
        if (state.denyContinuationLease) throw new Error("controlled continuation lease refusal");
        await state.onContinuationLease?.();
        let active = true;
        return {
          assertCurrent() { assert.equal(active, true); assert.equal(state.allowed, true); },
          release() { active = false; },
        };
      },
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
  const dispatchLedger = new FileAuthorizationLedger({ root: path.join(cwd, "dispatch") });
  const countedDispatchLedger = options.recoveryProbe ? {
    async reserve(reservation) { state.reserveCalls = (state.reserveCalls ?? 0) + 1; return dispatchLedger.reserve(reservation); },
    async settle(settlement) {
      if (state.failDispatchSettlement) throw new AuthorizationPersistenceError("controlled settlement failure", undefined, "settle");
      return dispatchLedger.settle(settlement);
    },
    async release(release) { state.releaseCalls = (state.releaseCalls ?? 0) + 1; return dispatchLedger.release(release); },
  } : dispatchLedger;
  const open = () => createDelegationRoundsController({ store: store(), authorityService: openAuthority(), host,
    dispatchLedger: countedDispatchLedger, cwd });
  const openWithStore = customStore => createDelegationRoundsController({ store: customStore, authorityService: openAuthority(), host,
    dispatchLedger: countedDispatchLedger, cwd });
  const openWithOwner = (transactionOwner, customStore = store()) => createDelegationRoundsController({ store: customStore, authorityService: openAuthority(), host,
    dispatchLedger: countedDispatchLedger, cwd, transactionOwner });
  controller = open();
  const cmd = (kind, p, operationKey, fields = {}) => ({ kind, groupId: spec.groupId, operationKey, expectedRevision: p?.revision ?? 0, controller: structuredClone(spec.controller), ...fields });
  const create = cmd("create", null, "create", { spec });
  if ((!options.flow || options.managedDefinition) && !options.deferCreate) await controller.create(create);
  const release = async (key, seats) => {
    const p = await controller.get(spec.groupId);
    return cmd("release", p, key, { checkpoint: ref(key), seats: seats.map(seatId => ({ seatId, previousInvocationId: p.attempts.filter(a => a.seatId === seatId).at(-1)?.invocationId ?? null })) });
  };
  const terminal = async invocationId => {
    const p = await controller.get(spec.groupId);
    return controller.recordTerminal(cmd("terminal", p, `terminal-${p.revision}`, { invocationId }));
  };
  return { cwd, state, spec, root, envelopes, service, openAuthority, controller, open, openWithStore, openWithOwner, store, cmd, create, release, terminal, physical, host, authorityHost };
}

test("transaction owner: frozen public facades remain usable under a transaction owner", async t => {
  const f = await fixture(t, { v3: true });
  const frozenHost = Object.freeze({ ...f.host });
  const frozenService = Object.freeze(f.openAuthority());
  const baseline = createDelegationRoundsController({ store: f.store(), host: frozenHost,
    authorityService: frozenService, dispatchLedger: new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") }), cwd: f.cwd });
  assert.equal((await baseline.get(f.spec.groupId)).spec.groupId, f.spec.groupId);
  const outcomes = [];
  for (const [kind, host, authorityService] of [["frozen-host", frozenHost, f.openAuthority()], ["frozen-service", f.host, frozenService]]) {
    let releases = 0, stores = 0;
    const owner = { async acquire() {
      const durable = f.store();
      return { host, authorityService, store: { transact(...args) { stores++; return durable.transact(...args); } },
        assertCurrent() {}, async release() { releases++; } };
    } };
    let error;
    try { await f.openWithOwner(owner).get(f.spec.groupId); } catch (cause) { error = cause; }
    outcomes.push({ kind, stores, releases, errorName: error?.name, message: error?.message });
    assert.equal(releases, 1, "scope cleanup must survive a facade error");
  }
  t.diagnostic(JSON.stringify({ legacyFrozenFacades: "PASS", providerCalls: f.state.calls, outcomes }));
  assert.deepEqual(outcomes.map(result => result.errorName), [undefined, undefined], "valid frozen host/V3 facades must support public reads with an owner");
});

test("transaction owner supplies scoped host store and authority for public reads", async t => {
  const f = await fixture(t, { v3: true }); let acquired = 0, scopedAuthorize = 0, released = 0;
  const controller = f.openWithOwner({ async acquire() {
    acquired++;
    return { store: f.store(), host: { ...f.host, async authorize(input) { scopedAuthorize++; return f.host.authorize(input); } },
      authorityService: f.openAuthority(), assertCurrent() {}, async release() { released++; } };
  } });
  await controller.get(f.spec.groupId);
  assert.equal(acquired, 1); assert.equal(scopedAuthorize, 2); assert.equal(released, 1);
});

test("transaction expiry during host authorization prevents authority and store callbacks", async t => {
  const f = await fixture(t, { v3: true }); let live = true, inspections = 0, stores = 0, releases = 0;
  const owner = { async acquire() {
    const service = f.openAuthority();
    return { store: { async transact() { stores++; throw new Error("expired scope reached store"); } },
      host: { ...f.host, async authorize(input) { const receipt = await f.host.authorize(input); live = false; return receipt; } },
      authorityService: { ...service, async inspect(...args) { inspections++; return service.inspect(...args); } },
      assertCurrent() { assert.ok(live, "expired transaction authorization"); }, async release() { releases++; live = false; } };
  } };
  await assert.rejects(f.openWithOwner(owner).get(f.spec.groupId), /expired transaction authorization/);
  assert.equal(inspections, 0); assert.equal(stores, 0); assert.equal(releases, 1);
});

test("transaction scope expiry after authority admission cannot publish a Flow claim", { timeout: 20000 }, async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition() });
  let expired = false, releases = 0;
  const owner = { async acquire({ action }) {
    let live = true; const service = f.openAuthority();
    return { store: f.store(), host: f.host,
      authorityService: { ...service, async admitEffect(...args) {
        const result = await service.admitEffect(...args);
        if (action === "execute") { live = false; expired = true; }
        return result;
      } },
      assertCurrent() { if (!live) throw new Error("SOL controlled transaction expiry after authority await"); },
      async release() { releases++; live = false; } };
  } };
  const c = await flowRelease(f, "sol-expire-before-claim", [invoke("seat-0")]);
  await assert.rejects(f.openWithOwner(owner).release(c), error => {
    const messages = value => [value?.message, ...(value?.errors ?? []).flatMap(messages), ...(value?.cause ? messages(value.cause) : [])];
    const all = messages(error); t.diagnostic(JSON.stringify({ errorMessages: all }));
    return all.includes("SOL controlled transaction expiry after authority await");
  });
  const run = await loadRun(f.spec.topology.runId, f.cwd);
  t.diagnostic(JSON.stringify({ expired, releases, providerCalls: f.state.calls, activeClaims: run.state.multi_cursor.active_claims.length,
    claimHistory: run.state.multi_cursor.claim_history }));
  assert.equal(expired, true); assert.equal(f.state.calls, 0);
  assert.equal(run.state.multi_cursor.active_claims.length, 0, "scope expired before claim but a durable unowned claim was published");
});

test("Flow admission uses a transaction-owned V3 scope and releases it before provider work", async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition(), maxRounds: 2 });
  let active = false, inGroup = false, acquisitions = 0, releases = 0;
  const trace = [], originalAuthorize = f.host.authorize;
  f.host.authorize = async input => { assert.equal(inGroup, false, "captured host was used inside group"); return originalAuthorize(input); };
  const transactionOwner = { async acquire({ action }) {
    assert.equal(active, false); active = true; acquisitions++; trace.push(`home:${action}`);
    const actual = f.openAuthority(), scopedService = { ...actual,
      async inspect(...args) { assert.equal(active, true); trace.push("authority:inspect"); return actual.inspect(...args); },
      async admitEffect(...args) { assert.equal(active, true); trace.push("authority:admit"); return actual.admitEffect(...args); } };
    const durable = f.store();
    return { authorityService: scopedService,
      host: { ...f.host, async authorize(input) { assert.equal(active, true); trace.push("host:authorize"); return originalAuthorize(input); } },
      store: { transact(groupId, body) { return durable.transact(groupId, async journal => {
        assert.equal(active, true); inGroup = true; trace.push("group:body");
        try { const next = await body(journal); assert.equal(active, true); return next; }
        finally { inGroup = false; }
      }); } },
      assertCurrent() { assert.equal(active, true); }, async release() { assert.equal(active, true); active = false; releases++; trace.push("home:release"); } };
  } };
  f.state.onInvoke = async () => { assert.equal(active, false, "scope leaked into provider response"); trace.push("provider"); };
  const controller = f.openWithOwner(transactionOwner);
  const command = await flowRelease(f, "scoped-flow-release", [invoke("seat-0")]);
  const result = await controller.release(command);
  assert.equal(result.projection.attempts.length, 1); assert.equal(f.state.calls, 1);
  assert.equal(active, false); assert.equal(acquisitions, releases);
  assert.ok(trace.includes("home:execute")); assert.ok(trace.includes("authority:admit"));
  assert.ok(trace.indexOf("home:release") < trace.indexOf("provider"));
});

test("transaction scope excludes a competing authority writer through durable store return", async t => {
  const f = await fixture(t, { v3: true }); let tail = Promise.resolve(), active = false, enter, resume, savedCallback;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  async function acquireWriter() {
    const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    assert.equal(active, false); active = true;
    return async () => { assert.equal(active, true); active = false; unlock(); };
  }
  const owner = { async acquire() {
    const release = await acquireWriter(), durable = f.store();
    return { host: f.host, authorityService: f.openAuthority(),
      store: { transact(id, body) { savedCallback = body; return durable.transact(id, async journal => {
        const next = await body(journal); enter(); await barrier; assert.equal(active, true); return next;
      }); } },
      assertCurrent() { assert.equal(active, true); }, release };
  } };
  const reading = f.openWithOwner(owner).get(f.spec.groupId);
  await Promise.race([entered, reading.then(() => { throw new Error("store returned before barrier"); })]);
  let competitorEntered = false;
  const competing = acquireWriter().then(async release => { competitorEntered = true; try { await f.service.cancel("root"); } finally { await release(); } });
  await setImmediate(); assert.equal(competitorEntered, false); resume();
  await reading; await competing; assert.equal(competitorEntered, true);
  await assert.rejects(savedCallback(null), /rounds_transaction_scope_released/);
  assert.equal((await f.service.inspect("root")).cancelled, true);
});

test("transaction owner prevents post-body sibling writer contention", async t => {
  const f = await fixture(t, { v3: true }); let tail = Promise.resolve(), holder = null, competing;
  async function acquire(name) {
    const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    assert.equal(holder, null); holder = name;
    return async () => { assert.equal(holder, name); holder = null; unlock(); };
  }
  const durable = f.store();
  const checkedStore = { transact(id, body) { return durable.transact(id, async journal => {
    const next = await body(journal);
    competing = acquire("sibling").then(async release => { try { await f.service.inspect("root"); } finally { await release(); } });
    await setImmediate();
    if (holder !== "owner") throw new Error("home writer busy: operationRan false");
    return next;
  }); } };
  const owner = { async acquire() {
    const release = await acquire("owner");
    return { store: checkedStore, host: f.host, authorityService: f.openAuthority(),
      assertCurrent() { assert.equal(holder, "owner"); }, release };
  } };
  try { await f.openWithOwner(owner, checkedStore).get(f.spec.groupId); }
  finally { if (competing) await competing; }
  assert.equal(holder, null);
});

test("transaction owner failures release scope and report publication uncertainty", async t => {
  const f = await fixture(t, { v3: true }); let releases = 0;
  const baseScope = () => ({ store: f.store(), host: f.host, authorityService: f.openAuthority(),
    assertCurrent() {}, async release() { releases++; } });
  await assert.rejects(f.openWithOwner({ async acquire() { throw new Error("controlled owner acquire failure"); } }).get(f.spec.groupId), /controlled owner acquire failure/);
  assert.equal(releases, 0);
  await assert.rejects(f.openWithOwner({ async acquire() { return { ...baseScope(), store: null }; } }).get(f.spec.groupId), /rounds_transaction_scope_invalid/);
  assert.equal(releases, 1);
  await assert.rejects(f.openWithOwner({ async acquire() { return { ...baseScope(), host: { ...f.host, async authorize() { return null; } } }; } }).get(f.spec.groupId), /rounds_host_authorization/);
  assert.equal(releases, 2);
  await assert.rejects(f.openWithOwner({ async acquire() { const scope = baseScope(); return { ...scope,
    store: { transact(id, body) { return scope.store.transact(id, async journal => { await body(journal); throw new Error("controlled post-body failure"); }); } } }; } }).get(f.spec.groupId),
  error => error.code === "rounds_transaction_uncertain" && error.status === "publication-unknown" && /controlled post-body failure/.test(error.cause.message));
  assert.equal(releases, 3);
  let current = true;
  await assert.rejects(f.openWithOwner({ async acquire() { const scope = baseScope(); return { ...scope,
    store: { transact(id, body) { return scope.store.transact(id, async journal => {
      await body(journal); current = false;
      throw new Error("controlled post-body currentness failure");
    }); } },
    assertCurrent() { if (!current) throw new Error("controlled post-body currentness failure"); } }; } }).get(f.spec.groupId),
  error => error.code === "rounds_transaction_uncertain" && error.status === "publication-unknown" && /controlled post-body currentness failure/.test(error.cause.message));
  assert.equal(releases, 4);
  await assert.rejects(f.openWithOwner({ async acquire() { return { ...baseScope(), async release() { releases++; throw new Error("controlled scope release failure"); } }; } }).get(f.spec.groupId),
  error => error.code === "rounds_transaction_uncertain" && error.status === "returned-cleanup-unknown" && /controlled scope release failure/.test(error.cause.message));
  assert.equal(releases, 5);
});

test("owner-scoped create, reads, release, terminal and cancel use scoped facades", async t => {
  const f = await fixture(t, { v3: true, deferCreate: true });
  const actions = [], events = []; let active = false;
  const owner = { async acquire({ action }) {
    assert.equal(active, false); active = true; actions.push(action);
    const actual = f.openAuthority(), authorize = f.host.authorize;
    return { store: f.store(), host: { ...f.host, async authorize(input) { assert.equal(active, true); events.push(`host:${input.action}`); return authorize(input); },
      async confirmTerminal(...args) { assert.equal(active, true); events.push("host:terminal"); return f.host.confirmTerminal(...args); } },
      authorityService: { ...actual, async inspect(...args) { assert.equal(active, true); events.push("authority:inspect"); return actual.inspect(...args); },
        async admitEffect(...args) { assert.equal(active, true); events.push("authority:admit"); return actual.admitEffect(...args); } },
      assertCurrent() { assert.equal(active, true); }, async release() { assert.equal(active, true); active = false; } };
  } };
  const c = f.openWithOwner(owner);
  await c.create(f.create);
  const initial = await c.get(f.spec.groupId); await c.events(f.spec.groupId);
  const released = await c.release(f.cmd("release", initial, "owned-release", { checkpoint: ref("owned-release"),
    seats: [{ seatId: "seat-0", previousInvocationId: null }] }));
  const p = await c.get(f.spec.groupId);
  await c.recordTerminal(f.cmd("terminal", p, "owned-terminal", { invocationId: released.projection.attempts[0].invocationId }));
  const beforeCancel = await c.get(f.spec.groupId);
  await c.cancel(f.cmd("cancel", beforeCancel, "owned-cancel"));
  for (const action of ["create", "get", "events", "release", "terminal", "cancel", "record"]) assert.ok(actions.includes(action), action);
  assert.ok(events.includes("host:terminal")); assert.ok(events.includes("authority:admit")); assert.equal(active, false);
});

test("parallel Flow members do not hold or share a transaction scope while awaiting providers", { timeout: 30000 }, async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition("parallel"), maxConcurrent: 2 });
  let tail = Promise.resolve(), active = false, serial = 0, released = 0, reached;
  const both = new Promise(resolve => { reached = resolve; }); let resume;
  const barrier = new Promise(resolve => { resume = resolve; }); t.after(() => resume());
  const scopeIds = new Set();
  const owner = { async acquire() {
    const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    assert.equal(active, false); active = true; const id = ++serial; scopeIds.add(id); let live = true;
    return { store: f.store(), host: f.host, authorityService: f.openAuthority(),
      assertCurrent() { assert.ok(active && live); }, async release() { assert.ok(active && live); live = false; active = false; released++; unlock(); } };
  } };
  f.state.onInvoke = async () => { if (f.state.active === 2) reached(); await barrier; };
  const command = await flowRelease(f, "scoped-parallel", [invoke("seat-0"), invoke("seat-1")]);
  const running = f.openWithOwner(owner).release(command);
  await Promise.race([both, running.then(() => { throw new Error("providers did not overlap"); })]);
  assert.equal(f.state.active, 2); assert.ok(released > 0); assert.ok(scopeIds.size > 1);
  resume(); await running;
  assert.equal(f.state.peak, 2); assert.equal(active, false); assert.equal(released, serial);
});

test("a provider-held writer queues sibling metadata before the group lock without lending custody", { timeout: 30000 }, async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition("parallel"), maxConcurrent: 2 });
  let tail = Promise.resolve(), holder = null, serial = 0, groups = 0, first = true, entered, resume;
  const providerHeld = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; }); t.after(() => resume());
  async function acquireWriter(id) {
    const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    assert.equal(holder, null); holder = id;
    return async () => { assert.equal(holder, id); holder = null; unlock(); };
  }
  const owner = { async acquire() {
    const id = `transaction-${++serial}`, release = await acquireWriter(id), durable = f.store();
    return { host: f.host, authorityService: f.openAuthority(),
      store: { transact(groupId, body) { return durable.transact(groupId, async journal => {
        assert.equal(holder, id); groups++;
        const next = await body(journal); assert.equal(holder, id); return next;
      }); } }, assertCurrent() { assert.equal(holder, id); }, release };
  } };
  f.state.onInvoke = async () => {
    if (!first) return; first = false;
    const release = await acquireWriter("provider"); entered();
    try { await barrier; } finally { await release(); }
  };
  const controller = f.openWithOwner(owner);
  const command = await flowRelease(f, "provider-held-home", [invoke("seat-0"), invoke("seat-1")]);
  const running = controller.release(command);
  await Promise.race([providerHeld, running.then(() => { throw new Error("provider writer was never held"); })]);
  const before = groups; let observed = false;
  const sibling = controller.get(f.spec.groupId).then(value => { observed = true; return value; });
  await setImmediate(); await setImmediate();
  assert.equal(holder, "provider"); assert.equal(groups, before, "sibling acquired group while another owner held home");
  assert.equal(observed, false);
  resume(); await sibling; await running;
  assert.equal(observed, true); assert.equal(holder, null); assert.equal(f.state.calls, 2);
});

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


async function exhaustedRoundsFixture(t, options = {}) {
  const f = await fixture(t, { managedDefinition: managedDefinition("route"), maxRounds: 8, attempts: 12, maxRecoveries: 4, ...options });
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
  return { f, run, claimedBlock, next };
}

test("transaction scope: child expiry during parent Flow admission must prevent publication", { timeout: 60000 }, async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t, { v3: true });
  const knownParents = new WeakSet(), acquireParent = f.host.flow.acquireContinuationPublication;
  let acquiredChildren = 0, releasedChildren = 0, parentReleases = 0;
  f.host.flow.acquireContinuationPublication = async input => {
    const parent = await acquireParent(input);
    const lease = { ...parent, flowAdmission: { async acquire() {
      const child = await parent.flowAdmission.acquire(); acquiredChildren++;
      return { assertCurrent: child.assertCurrent, async release() {
        parent.assertCurrent(); await child.release(); releasedChildren++;
      } };
    } }, async release() { parentReleases++; await parent.release(); } };
    knownParents.add(lease); return lease;
  };
  let expireChild, expired = false, parentCurrentAtExpiry = false, borrowed = 0, releases = 0;
  const owner = { async acquire({ publicationLease }) {
    if (publicationLease && !knownParents.has(publicationLease)) throw new DelegationRoundsTransactionParentError();
    if (publicationLease) { publicationLease.assertCurrent(); borrowed++; }
    let live = true;
    if (publicationLease) expireChild = () => {
      publicationLease.assertCurrent(); parentCurrentAtExpiry = true; live = false; expired = true;
    };
    return { store: f.store(), host: f.host, authorityService: f.openAuthority(),
      assertCurrent() { if (!live) throw new Error("SOL narrow child expired during Flow admission"); publicationLease?.assertCurrent(); },
      async release() { releases++; live = false; } };
  } };
  const original = await continuationCommand(f, "reappraise", "sol-child-expiry", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  const before = await loadRun(f.spec.topology.runId, f.cwd), beforeCalls = f.state.calls;
  const recordsBefore = before.state.checked_operation_ledger?.records.length ?? 0;
  f.state.onContinuationLease = async () => { assert.equal(typeof expireChild, "function"); expireChild(); await setImmediate(); };
  await assert.rejects(f.openWithOwner(owner).reappraise(original), /SOL narrow child expired during Flow admission/);
  const after = await loadRun(f.spec.topology.runId, f.cwd), p = await f.controller.get(f.spec.groupId);
  const recordsAfter = after.state.checked_operation_ledger?.records.length ?? 0;
  t.diagnostic(JSON.stringify({ expired, parentCurrentAtExpiry, borrowed, releases, providerCallsDuringProbe: f.state.calls - beforeCalls,
    recordsBefore, recordsAfter, headBefore: flowRunHead(before.state), headAfter: flowRunHead(after.state),
    receiptInGroup: !!p.continuations.find(c => c.command.operationKey === original.operationKey)?.receipt }));
  assert.equal(expired, true); assert.equal(parentCurrentAtExpiry, true); assert.equal(f.state.calls, beforeCalls);
  assert.equal(recordsAfter, recordsBefore, "Flow published a checked operation after narrow transaction scope expired while parent remained current");
  assert.equal(flowRunHead(after.state), flowRunHead(before.state));
  assert.equal(p.continuations.find(c => c.command.operationKey === original.operationKey).receipt, null);
  assert.equal(acquiredChildren, 1); assert.equal(releasedChildren, 1); assert.equal(parentReleases, 1);
});

test("continuation publication transaction borrows its exact parent and authenticates replay with scoped host", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t, { v3: true });
  const parentStates = new WeakMap(), acquireParent = f.host.flow.acquireContinuationPublication;
  f.host.flow.acquireContinuationPublication = async input => {
    const parent = await acquireParent(input), state = { active: true };
    const lease = { ...parent,
      assertCurrent() { if (!state.active) throw new DelegationRoundsTransactionParentError(); return parent.assertCurrent(); },
      async release() { if (!state.active) return; state.active = false; await parent.release(); } };
    parentStates.set(lease, state); return lease;
  };
  let borrowed = 0, parentReleases = 0, scopedLoads = 0;
  const owner = { async acquire({ publicationLease }) {
    const state = publicationLease && parentStates.get(publicationLease);
    if (publicationLease && (!state || !state.active)) throw new DelegationRoundsTransactionParentError();
    if (state) borrowed++;
    let active = true; const durable = f.store(), actualHost = f.host;
    return { store: durable, authorityService: f.openAuthority(),
      host: { ...actualHost, async loadContinuation(...args) { assert.ok(active && state?.active); scopedLoads++; return actualHost.loadContinuation(...args); } },
      assertCurrent() { assert.ok(active); if (state) assert.equal(state.active, true); },
      async release() { assert.ok(active); active = false; if (state) { assert.equal(state.active, true); parentReleases++; } } };
  } };
  const c = f.openWithOwner(owner);
  const original = await continuationCommand(f, "reappraise", "scoped-parent", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(c.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const pending = await c.get(f.spec.groupId), finalizer = f.cmd("finalizeContinuation", pending, "scoped-parent-finalizer", { continuationOperationKey: original.operationKey });
  await c.finalizeContinuation(finalizer);
  assert.equal((await c.finalizeContinuation(finalizer)).replayed, true);
  assert.equal(scopedLoads, 1); assert.equal(borrowed, 3); assert.equal(parentReleases, 3);
  const registeredAcquire = f.host.flow.acquireContinuationPublication;
  f.host.flow.acquireContinuationPublication = async () => ({ assertCurrent() {}, flowAdmission: { acquire() { throw new Error("unexpected Flow admission"); } }, async release() {} });
  await assert.rejects(c.finalizeContinuation(finalizer), error => error.code === "rounds_transaction_parent_unavailable");
  const releasedParent = await registeredAcquire({}); await releasedParent.release();
  f.host.flow.acquireContinuationPublication = async () => releasedParent;
  await assert.rejects(c.finalizeContinuation(finalizer), error => error.code === "rounds_transaction_parent_unavailable");
  f.host.flow.acquireContinuationPublication = registeredAcquire;
  assert.equal((await c.finalizeContinuation(finalizer)).replayed, true);
});

test("transaction owner forwards frozen nested recipient methods with their private receiver", async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  const sync = await seatSync(f, "seat-0", "frozen-recipient-sync", "Controlled frozen recipient context");
  let nestedCalls = 0, scopes = 0, releases = 0;
  class FrozenRecipient {
    #delegate = f.host.recipient;
    constructor() {
      Object.defineProperty(this, "resolve", { value: this.resolve, enumerable: true, writable: false, configurable: false });
      Object.freeze(this);
    }
    async resolve(...args) { nestedCalls++; return this.#delegate.resolve(...args); }
  }
  const recipient = new FrozenRecipient();
  const owner = { async acquire() {
    scopes++;
    return { store: f.store(), authorityService: Object.freeze(f.openAuthority()), host: { ...f.host, recipient },
      assertCurrent() {}, async release() { releases++; } };
  } };
  await f.openWithOwner(owner).release(await flowRelease(f, "frozen-recipient-release", [{ ...invoke("seat-0"), syncKey: sync.command.operationKey }]));
  assert.ok(nestedCalls > 0); assert.equal(releases, scopes); assert.equal(f.state.calls, 2);
});

test("finalizer exact replay refuses missing retained winner bytes", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "replay-red", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "replay-red-final", { continuationOperationKey: original.operationKey });
  const completed = await f.controller.finalizeContinuation(finalizer);
  const winner = completed.projection.continuations.at(-1).receipt;
  const file = path.join(f.cwd, `${winner.reference.id}.json`), bytes = fs.readFileSync(file);
  const events = await f.controller.events(f.spec.groupId), head = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state);
  const authorityBefore = await f.service.inspect("root");
  const retains = f.state.continuationRetains.length, calls = f.state.calls;
  const realAdmission = f.host.flow.acquireContinuationPublication;
  f.host.flow.acquireContinuationPublication = async input => {
    const lease = await realAdmission(input);
    return { ...lease, flowAdmission: { acquire() { throw new Error("replay called Flow lookup or mutation"); } } };
  };
  f.host.executionHost = f.host.flow.executionHost = () => { throw new Error("replay resolved execution"); };
  f.host.prepareRequest = () => { throw new Error("replay prepared execution"); };
  const beforeLoads = f.state.continuationLoads ?? 0;
  assert.equal((await f.open().finalizeContinuation(finalizer)).replayed, true);
  assert.equal(f.state.continuationLoads, beforeLoads + 1);
  fs.unlinkSync(file);
  await assert.rejects(f.open().finalizeContinuation(finalizer), error => error.code === "rounds_continuation_winner_unavailable");
  fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(f.open().finalizeContinuation(finalizer), error => error.code === "rounds_continuation_completion_conflict");
  fs.writeFileSync(file, bytes);
  const reader = f.host.loadContinuation;
  delete f.host.loadContinuation;
  await assert.rejects(f.open().finalizeContinuation(finalizer), error => error.code === "rounds_continuation_winner_unavailable");
  f.host.loadContinuation = async (...args) => { const value = await reader(...args); f.state.denyReplayAuthorization = true; return value; };
  await assert.rejects(f.open().finalizeContinuation(finalizer), /rounds_host_authorization/);
  f.state.denyReplayAuthorization = false; f.host.loadContinuation = reader;
  f.state.continuationReleaseFailure = true;
  await assert.rejects(f.open().finalizeContinuation(finalizer), error => error.code === "rounds_continuation_publication_uncertain" && error.status === "published-cleanup-unknown");
  f.state.continuationReleaseFailure = false;
  assert.equal((await f.open().finalizeContinuation(finalizer)).replayed, true);
  for (const mutate of [
    receipt => { receipt.flowHead = "0".repeat(64); },
    receipt => { receipt.transitionRef = "0".repeat(64); },
    receipt => { receipt.reference.digest = `sha256:${"0".repeat(64)}`; },
    receipt => { receipt.proof.receiptDigest = "0".repeat(64); },
  ]) {
    let transaction = 0; const durable = f.store();
    const corruptStore = { transact(groupId, body) { return durable.transact(groupId, journal => {
      if (++transaction === 2) mutate(journal.events.find(e => e.kind === "continuation_finalized").receipt);
      return body(journal);
    }); } };
    await assert.rejects(f.openWithStore(corruptStore).finalizeContinuation(finalizer), error => error.code === "rounds_continuation_completion_conflict");
  }
  let faultTransaction = 0; const faultDurable = f.store();
  const faultStore = { transact(groupId, body) { return faultDurable.transact(groupId, async journal => {
    const result = await body(journal);
    if (++faultTransaction === 2) throw new Error("controlled replay durable failure");
    return result;
  }); } };
  await assert.rejects(f.openWithStore(faultStore).finalizeContinuation(finalizer), error =>
    error.code === "rounds_continuation_publication_uncertain" && error.status === "publication-unknown"
      && /controlled replay durable failure/.test(error.cause.message));
  assert.deepEqual(await f.service.inspect("root"), authorityBefore);
  let enter, proceed, transaction = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { proceed = resolve; });
  const durable = f.store();
  const barrierStore = { transact(groupId, body) { return durable.transact(groupId, async journal => {
    const result = await body(journal);
    if (++transaction === 2) { enter(); await barrier; }
    return result;
  }); } };
  const replay = f.openWithStore(barrierStore).finalizeContinuation(finalizer);
  await Promise.race([entered, replay.then(() => { throw new Error("replay escaped publication barrier"); })]);
  let competitorEntered = false;
  const competitor = f.host.flow.acquireContinuationPublication().then(async lease => {
    competitorEntered = true;
    try { await f.service.cancel("root"); } finally { await lease.release(); }
  });
  await setImmediate(); assert.equal(competitorEntered, false); proceed();
  assert.equal((await replay).replayed, true); await competitor;
  assert.equal(competitorEntered, true); assert.equal((await f.service.inspect("root")).cancelled, true);
  assert.equal(f.state.continuationRetains.length, retains); assert.equal(f.state.calls, calls);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), head);
  assert.deepEqual(await f.controller.events(f.spec.groupId), events);
});

test("continuation finalizer closes a lost receipt without executing again and authenticates replay", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "lost-continuation", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  const committed = await loadRun(f.spec.topology.runId, f.cwd);
  const head = flowRunHead(committed.state), calls = f.state.calls;
  const pending = await f.controller.get(f.spec.groupId);
  assert.equal(pending.continuations.find(c => c.command.operationKey === original.operationKey).receipt, null);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalize-lost", { continuationOperationKey: original.operationKey });
  f.state.continuationRetentionFailure = false;
  f.host.executionHost = () => { throw new Error("finalizer resolved execution host"); };
  f.host.flow.executionHost = () => { throw new Error("finalizer resolved Flow execution host"); };
  f.host.prepareRequest = () => { throw new Error("finalizer prepared a request"); };
  f.state.allowed = false;
  await assert.rejects(f.controller.finalizeContinuation(finalizer), /rounds_host_authorization/);
  f.state.allowed = true;
  await assert.rejects(f.controller.finalizeContinuation({ ...finalizer, expectedRevision: pending.revision - 1 }), /rounds_revision_conflict/);
  await assert.rejects(f.controller.finalizeContinuation({ ...finalizer, operationKey: original.operationKey }), /rounds_operation/);
  const result = await f.controller.finalizeContinuation(finalizer);
  assert.equal(result.replayed, false);
  assert.equal(result.projection.continuations.find(c => c.command.operationKey === original.operationKey).receipt.flowHead, head);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), head);
  assert.equal(f.state.calls, calls);
  assert.equal(f.state.continuationRetains.length, 1);
  assert.equal((await f.open().finalizeContinuation(finalizer)).replayed, true);
  assert.equal(f.state.continuationRetains.length, 1);
  const other = f.cmd("finalizeContinuation", result.projection, "different-finalizer", { continuationOperationKey: original.operationKey });
  await assert.rejects(f.controller.finalizeContinuation(other), /rounds_continuation_already_completed/);
  const events = await f.controller.events(f.spec.groupId);
  assert.equal(events.filter(e => e.kind === "continuation_finalized").length, 1);
  const journal = { schemaVersion: "1.0", groupId: f.spec.groupId, events: structuredClone(events) };
  const completion = journal.events.find(e => e.kind === "continuation_finalized");
  completion.receipt.proof.intentDigest = "0".repeat(64);
  assert.throws(() => projectDelegationRounds(journal), /rounds_continuation_proof_binding/);
  const badRef = { schemaVersion: "1.0", groupId: f.spec.groupId, events: structuredClone(events) };
  badRef.events.find(e => e.kind === "continuation_finalized").receipt.transitionRef = "bad-ref";
  assert.throws(() => projectDelegationRounds(badRef), /rounds_flow_hash/);
  const duplicate = { schemaVersion: "1.0", groupId: f.spec.groupId, events: structuredClone(events) };
  duplicate.events.push({ ...structuredClone(duplicate.events.find(e => e.kind === "continuation_finalized")), revision: events.length + 1 });
  assert.throws(() => projectDelegationRounds(duplicate), /rounds_operation|rounds_continuation_identity/);
});

test("concurrent identical finalizers authenticate the winner after outer acquisition", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "finalizer-race", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalizer-race-key", { continuationOperationKey: original.operationKey });
  let enter, proceed, blocked = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { proceed = resolve; });
  f.state.beforePublicationAcquire = async input => {
    if (input?.action === "finalizeContinuation" && !blocked) { blocked = true; enter(); await barrier; }
  };
  const loser = f.open().finalizeContinuation(finalizer);
  await Promise.race([entered, loser.then(() => { throw new Error("finalizer escaped barrier"); })]);
  const winner = await f.open().finalizeContinuation(finalizer);
  const events = await f.controller.events(f.spec.groupId), retains = f.state.continuationRetains.length;
  const beforeLoads = f.state.continuationLoads ?? 0;
  proceed();
  assert.equal((await loser).replayed, true);
  assert.equal(f.state.continuationLoads, beforeLoads + 1);
  assert.equal(f.state.continuationRetains.length, retains);
  assert.deepEqual(await f.controller.events(f.spec.groupId), events);
  assert.equal(winner.replayed, false);
});

test("continuation finalizer recovers an authorizeRetry receipt without granting another retry", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const reappraise = await continuationCommand(f, "reappraise", "retry-finalizer-reappraise", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  await f.controller.reappraise(reappraise);
  const before = await loadRun(f.spec.topology.runId, f.cwd);
  const original = await continuationCommand(f, "authorizeRetry", "lost-retry-receipt", {
    reappraisalKey: reappraise.operationKey, request: {
      reason: "Explicit retry before receipt loss", target_step: "first",
      blocked_transition_ref: flowTransitionRef(before.state.transitions.at(-1)), expected_run_head: flowRunHead(before.state),
      authority: { kind: "operator_request", actor: "fixture-host", request_ref: "controlled:retry-finalizer", requested_at: new Date().toISOString() },
    },
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.authorizeRetry(original), /continuation receipt retention unavailable/);
  const committed = await loadRun(f.spec.topology.runId, f.cwd), head = flowRunHead(committed.state);
  const transition = flowTransitionRef(committed.state.transitions.at(-1));
  assert.equal(committed.state.transitions.at(-1).type, "retry_authorized");
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalize-lost-retry", { continuationOperationKey: original.operationKey });
  const calls = f.state.calls, retains = f.state.continuationRetains.length;
  const invocations = (await f.service.inspect("root")).invocations;
  f.state.continuationRetentionFailure = false;
  f.host.executionHost = f.host.flow.executionHost = () => { throw new Error("finalizer resolved execution"); };
  f.host.prepareRequest = () => { throw new Error("finalizer prepared execution"); };
  const result = await f.open().finalizeContinuation(finalizer);
  const receipt = result.projection.continuations.find(c => c.command.operationKey === original.operationKey).receipt;
  assert.equal(receipt.flowHead, head); assert.equal(receipt.transitionRef, transition);
  assert.equal(f.state.calls, calls); assert.equal(f.state.continuationRetains.length, retains + 1);
  assert.deepEqual((await loadRun(f.spec.topology.runId, f.cwd)).state, committed.state);
  assert.deepEqual((await f.service.inspect("root")).invocations, invocations);
  assert.equal((await f.open().finalizeContinuation(finalizer)).replayed, true);
  assert.equal(f.state.continuationRetains.length, retains + 1);
  assert.equal((await f.controller.events(f.spec.groupId)).filter(e => e.kind === "continuation_finalized").length, 1);
});

test("continuation retention is identical when publication fails before durable write", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "publish-loss", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalize-publish-loss", { continuationOperationKey: original.operationKey });
  const durable = f.store(); let injected = false;
  const faultStore = { transact(groupId, body) { return durable.transact(groupId, async journal => {
    const next = await body(journal);
    if (!injected && next.journal.events.some(e => e.kind === "continuation_finalized")) {
      injected = true; throw new Error("controlled publication failure");
    }
    return next;
  }); } };
  await assert.rejects(f.openWithStore(faultStore).finalizeContinuation(finalizer), error => {
    assert.equal(error.code, "rounds_continuation_publication_uncertain");
    assert.equal(error.status, "publication-unknown");
    assert.match(error.cause.message, /controlled publication failure/);
    return true;
  });
  assert.equal((await f.controller.get(f.spec.groupId)).revision, pending.revision);
  await f.open().finalizeContinuation(finalizer);
  assert.equal(f.state.continuationRetains.length, 2);
  assert.equal(f.state.continuationRetains[0], f.state.continuationRetains[1]);
});

test("continuation cleanup failure preserves the original failure and uncertainty", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "cleanup-loss", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  f.state.continuationReleaseFailure = true;
  await assert.rejects(f.controller.reappraise(original), error => {
    assert.equal(error.code, "rounds_continuation_publication_uncertain");
    assert.equal(error.status, "publication-unknown");
    assert.match(error.errors[0].message, /continuation receipt retention unavailable/);
    assert.match(error.errors[1].message, /controlled parent release failure/);
    return true;
  });
});

test("finalizer refuses a pending operation without a checked Flow receipt", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "no-flow-receipt", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.denyContinuationLease = true;
  await assert.rejects(f.controller.reappraise(original), /controlled continuation lease refusal/);
  f.state.denyContinuationLease = false;
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalize-no-receipt", { continuationOperationKey: original.operationKey });
  await assert.rejects(f.controller.finalizeContinuation(finalizer), /rounds_continuation_receipt_unavailable/);
  assert.equal((await f.controller.get(f.spec.groupId)).revision, pending.revision);
  assert.equal(f.state.continuationRetains, undefined);
});

test("cancellation preserves metadata-only closure of an already committed continuation", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "cancel-pending-continuation", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const before = await f.controller.get(f.spec.groupId);
  await f.controller.cancel(f.cmd("cancel", before, "cancel-before-finalize"));
  const canceled = await f.controller.get(f.spec.groupId);
  assert.equal(canceled.cancellation, "requested");
  const head = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), calls = f.state.calls;
  const finalizer = f.cmd("finalizeContinuation", canceled, "finalize-canceled", { continuationOperationKey: original.operationKey });
  const result = await f.controller.finalizeContinuation(finalizer);
  assert.equal(result.projection.cancellation, "requested");
  assert.equal(result.projection.continuations.at(-1).receipt.flowHead, head);
  assert.equal(f.state.calls, calls);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), head);
  const loads = f.state.continuationLoads ?? 0;
  const replay = await f.open().finalizeContinuation(finalizer);
  assert.equal(replay.replayed, true); assert.equal(replay.projection.cancellation, "requested");
  assert.equal(f.state.continuationLoads, loads + 1); assert.equal(f.state.calls, calls);
});

test("Flow refuses amendment of an exhausted blocked run and finalizer keeps the original head", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "amended-original", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const run = await loadRun(f.spec.topology.runId, f.cwd), oldHead = flowRunHead(run.state);
  const successor = { ...structuredClone(run.definition), version: "2" };
  await assert.rejects(amendRunDefinition(f.spec.topology.runId, { cwd: f.cwd, definition: successor, request: {
    reason: "compatible metadata amendment", expected_run_head: oldHead, expected_definition: definitionIdentity(run.definition),
    successor_digest: definitionDigest(successor), authority: { kind: "user_request", actor: "fixture-host",
      request_ref: "controlled:amend", requested_at: new Date().toISOString() },
  } }), /definition amendment requires an active run/);
  const pending = await f.controller.get(f.spec.groupId);
  const result = await f.controller.finalizeContinuation(f.cmd("finalizeContinuation", pending, "finalize-amended", { continuationOperationKey: original.operationKey }));
  assert.equal(result.projection.continuations.at(-1).receipt.flowHead, oldHead);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), oldHead);
});

test("producer losing to finalizer authenticates retained winner without another Flow or retain operation", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "race-original", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  f.state.beforePublicationAcquire = async input => {
    if (input?.action === "produce") { enter(); await paused; }
  };
  const producer = f.controller.reappraise(original);
  await Promise.race([entered, producer.then(() => { throw new Error("producer escaped barrier"); })]);
  const events = await f.controller.events(f.spec.groupId);
  const prefix = { schemaVersion: "1.0", groupId: f.spec.groupId, events };
  const operation = continuationOperation(f.spec, original, continuationDigest(prefix));
  await evaluateRunChecked(f.spec.topology.runId, { cwd: f.cwd, expectedRunHead: original.flowHead, gate: original.gate, operation,
    admission: { async acquire() { return { assertCurrent() {}, release() {} }; } } });
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "race-finalizer", { continuationOperationKey: original.operationKey });
  const winner = await f.controller.finalizeContinuation(finalizer);
  const receipt = winner.projection.continuations.at(-1).receipt;
  const bytes = fs.readFileSync(path.join(f.cwd, `${receipt.reference.id}.json`), "utf8");
  const bound = { spec: f.spec, command: original, originalPrefixDigest: continuationDigest(prefix), bytes,
    referenceDigest: receipt.reference.digest, flowHead: receipt.flowHead, transitionRef: receipt.transitionRef, proof: receipt.proof };
  authenticateContinuationWinner(bound);
  assert.throws(() => authenticateContinuationWinner({ ...bound, flowHead: "0".repeat(64) }), /rounds_continuation_completion_conflict/);
  assert.throws(() => authenticateContinuationWinner({ ...bound, transitionRef: "0".repeat(64) }), /rounds_continuation_completion_conflict/);
  assert.throws(() => authenticateContinuationWinner({ ...bound, referenceDigest: `sha256:${"0".repeat(64)}` }), /rounds_continuation_completion_conflict/);
  const altered = JSON.parse(bytes); altered.receipt.request.gate = "wrong";
  const alteredBytes = canonicalJson(altered);
  assert.throws(() => authenticateContinuationWinner({ ...bound, bytes: alteredBytes,
    referenceDigest: `sha256:${createHash("sha256").update(alteredBytes).digest("hex")}` }), /rounds_continuation_receipt_binding/);
  const originalReceipt = JSON.parse(bytes).receipt;
  for (const mutate of [
    r => { r.originDefinition.digest = "0".repeat(64); },
    r => { r.request.gate = "other"; },
    r => { r.transitionRefs = []; },
    r => { r.transitionRefs[0] = "0".repeat(64); },
    r => { r.outcomes = []; },
    r => { r.evaluationRefs = []; },
  ]) {
    const bad = structuredClone(originalReceipt); mutate(bad);
    await assert.rejects(continuationObservation({ spec: f.spec, command: original, originalPrefixDigest: continuationDigest(prefix), receipt: bad, cwd: f.cwd }), /rounds_continuation_/);
  }
  const head = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), history = await f.controller.events(f.spec.groupId);
  const retains = f.state.continuationRetains.length, calls = f.state.calls;
  resume();
  const loser = await producer;
  assert.equal(loser.replayed, true);
  assert.deepEqual(loser.projection.continuations.at(-1).receipt, winner.projection.continuations.at(-1).receipt);
  assert.equal(f.state.continuationLoads, 1);
  assert.equal(f.state.continuationRetains.length, retains);
  assert.equal(f.state.calls, calls);
  assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), head);
  assert.deepEqual(await f.controller.events(f.spec.groupId), history);
});

test("producer loser refuses when winner bytes are unavailable", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "race-no-reader", { gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock) });
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  f.state.beforePublicationAcquire = async input => { if (input?.action === "produce") { enter(); await paused; } };
  const producer = f.controller.reappraise(original);
  await Promise.race([entered, producer.then(() => { throw new Error("producer escaped barrier"); })]);
  const prefix = { schemaVersion: "1.0", groupId: f.spec.groupId, events: await f.controller.events(f.spec.groupId) };
  await evaluateRunChecked(f.spec.topology.runId, { cwd: f.cwd, expectedRunHead: original.flowHead, gate: original.gate,
    operation: continuationOperation(f.spec, original, continuationDigest(prefix)),
    admission: { async acquire() { return { assertCurrent() {}, release() {} }; } } });
  const pending = await f.controller.get(f.spec.groupId);
  await f.controller.finalizeContinuation(f.cmd("finalizeContinuation", pending, "race-no-reader-final", { continuationOperationKey: original.operationKey }));
  delete f.host.loadContinuation;
  resume();
  await assert.rejects(producer, error => error.code === "rounds_continuation_winner_unavailable");
});

test("publication parent remains held after callback until the durable store returns", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const original = await continuationCommand(f, "reappraise", "publication-barrier", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  f.state.continuationRetentionFailure = true;
  await assert.rejects(f.controller.reappraise(original), /continuation receipt retention unavailable/);
  f.state.continuationRetentionFailure = false;
  const pending = await f.controller.get(f.spec.groupId);
  const finalizer = f.cmd("finalizeContinuation", pending, "finalize-barrier", { continuationOperationKey: original.operationKey });
  let entered, proceed;
  const atBarrier = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { proceed = resolve; });
  const durable = f.store();
  const barrierStore = { transact(groupId, body) { return durable.transact(groupId, async journal => {
    const next = await body(journal);
    if (next.journal.events.some(e => e.kind === "continuation_finalized")) { entered(); await barrier; }
    return next;
  }); } };
  const completion = f.openWithStore(barrierStore).finalizeContinuation(finalizer);
  await Promise.race([atBarrier, completion.then(() => { throw new Error("completion returned before barrier"); })]);
  let competitorEntered = false;
  const competitor = f.host.flow.acquireContinuationPublication().then(async lease => {
    competitorEntered = true;
    try { await f.service.cancel("root"); } finally { await lease.release(); }
  });
  await setImmediate();
  assert.equal(competitorEntered, false);
  proceed();
  const result = await completion;
  await competitor;
  assert.equal(competitorEntered, true);
  assert.equal((await f.service.inspect("root")).cancelled, true);
  assert.equal(result.projection.continuations.find(c => c.command.operationKey === original.operationKey).receipt.flowHead,
    flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state));
});

test("Flow rounds: exhausted route requires public authorizeRetry before another paid claim", async t => {
  const { f, claimedBlock, next } = await exhaustedRoundsFixture(t);
  let run = await loadRun(f.spec.topology.runId, f.cwd), route;
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

test("sync finalization uses transaction-scoped V3 host and authority", async t => {
  const f = await fixture(t, { v3: true, managedDefinition: managedDefinition("parallel"), contextSync: true, attempts: 12 });
  const text = "Scoped retained facts", contextRef = { id: "scoped-sync-context", domain: "fixture-context", digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  fs.writeFileSync(path.join(f.cwd, `${contextRef.id}.txt`), text, { mode: 0o600 });
  f.state.continuationRetentionFailure = true;
  const original = await continuationCommand(f, "sync", "scoped-lost-sync", { seatId: "seat-0", contextRef });
  await assert.rejects(f.controller.sync(original), /sync receipt persistence failed/);
  f.state.continuationRetentionFailure = false;
  const p = await f.controller.get(f.spec.groupId), exchange = p.continuations[0];
  const command = f.cmd("finalizeSync", p, "scoped-finalize-sync", { syncOperationKey: original.operationKey, preparedDigest: preparedRoundsSyncDigest(exchange.prepared) });
  let retained = 0, inspected = 0, live = false;
  const owner = { async acquire({ action }) {
    assert.equal(action, "finalizeSync"); live = true; const actual = f.openAuthority();
    return { store: f.store(), host: { ...f.host, async retainContinuation(...args) { assert.ok(live); retained++; return f.host.retainContinuation(...args); } },
      authorityService: { ...actual, async inspect(...args) { assert.ok(live); inspected++; return actual.inspect(...args); } },
      assertCurrent() { assert.ok(live); }, async release() { assert.ok(live); live = false; } };
  } };
  const result = await f.openWithOwner(owner).finalizeSync(command);
  assert.equal(result.projection.continuations[0].receipt.acknowledged, true);
  assert.equal(retained, 1); assert.ok(inspected > 0); assert.equal(live, false); assert.equal(f.state.calls, 1);
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
  let adoptionScopes = 0, adoptionInspections = 0;
  const adoptionOwner = { async acquire({ action }) {
    assert.equal(action, "adoptRenewal"); adoptionScopes++; let live = true; const actual = f.openAuthority();
    return { store: f.store(), host: f.host, authorityService: { ...actual, async inspect(...args) { assert.ok(live); adoptionInspections++; return actual.inspect(...args); } },
      assertCurrent() { assert.ok(live); }, async release() { assert.ok(live); live = false; } };
  } };
  await f.openWithOwner(adoptionOwner).adoptRenewal(adoption);
  assert.equal(adoptionScopes, 1); assert.ok(adoptionInspections > 0);
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


test("R3.1: authenticated tool removal persists without refund and cannot be re-expanded", async t => {
  const f = await fixture(t, { v3: true, allowedTools: ["input-form"] });
  await f.service.reserveInvocation("root", "child", "narrowing-unknown", allocation);
  const before = await f.service.inspect("root");
  let command = await successor(f, "remove-input-tool");
  command.envelopes.find(e => e.envelope_id === "child").execution_authority.allowed_tools = [];
  command = await approveHostRenewal(f, command);
  await assert.rejects(f.service.renew(command), /renewal_envelope_lineage_conflict/);
  assert.deepEqual(await f.service.inspect("root"), before);
  command.schemaVersion = "3.1";
  await assert.rejects(f.service.renew(command), /renewal_host_receipt_unconfirmed/);
  for (const [field, change] of [
    ["execution-id", e => { e.execution_id = "replacement-execution"; }],
    ["allocation", e => { e.budget.max_input_tokens--; }],
  ]) {
    let changed = structuredClone(command);
    change(changed.envelopes.find(e => e.envelope_id === "child"));
    changed = await approveHostRenewal(f, changed, field);
    await assert.rejects(f.service.renew(changed), /renewal_envelope_lineage_conflict/);
    assert.deepEqual(await f.service.inspect("root"), before);
  }
  command = await approveHostRenewal(f, command, "narrowing");
  assert.equal((await f.service.renew(command)).replayed, false);
  const reopened = f.openAuthority(), narrowed = await reopened.inspect("root");
  assert.deepEqual(narrowed.envelopes.find(e => e.envelope_id === "child").execution_authority.allowed_tools, []);
  assert.deepEqual(narrowed.invocations, before.invocations);
  assert.deepEqual(narrowed.origins, before.origins);
  assert.deepEqual(narrowed.epochs[0], before.epochs[0]);
  assert.deepEqual(narrowed.root.budget, before.root.budget);
  assert.equal((await reopened.renew(command)).replayed, true);
  let widening = await successor(f, "restore-input-tool");
  widening.schemaVersion = "3.1";
  widening.envelopes.find(e => e.envelope_id === "child").execution_authority.allowed_tools = ["input-form"];
  widening = await approveHostRenewal(f, widening);
  await assert.rejects(reopened.renew(widening), /authority_widening:allowed_tools/);
  assert.deepEqual(await reopened.inspect("root"), narrowed);
  let exact = await approveHostRenewal(f, await successor(f, "legacy-after-narrowing"));
  await reopened.renew(exact);
  assert.deepEqual((await reopened.inspect("root")).envelopes.find(e => e.envelope_id === "child").execution_authority.allowed_tools, []);
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
    retainedAccounting:true,accountingProtocol:"retained-tariff-v1",tariffMicros:7,captureDispatchReservations:true});
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
  assert.deepEqual(f.state.dispatchReservations.map(r => r.invocationId), ledger.invocations.map(i => i.invocationId));
  assert.equal(new Set(f.state.dispatchReservations.map(r => r.reservation.reservationId)).size, 2);
  assert.ok(f.state.dispatchReservations.every(r => r.envelopeId === "parent" && r.reservation.capacity.attempts === 1));
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

for (const partial of ["dispatch-held", "authority-held", "both-held", "overrun-held", "legacy-relay-held", "provider-fallback-held", "concurrent-dispatch-settled"]) {
  test(`dual-ledger recovery reopens original evidence after renewal/cancel/expiry with no new invocation: ${partial}`, async t => {
    const { recoverAuthorizedDelegationAccountingV1 } = await import('../../build/src/delegation-accounting-recovery.js');
    const providerReported = partial === "legacy-relay-held" || partial === "provider-fallback-held";
    const f = await fixture(t, { v3: true, recoveryProbe: true, retainedAccounting: !providerReported,
      ...(partial === "legacy-relay-held" ? {} : { accountingProtocol: "retained-tariff-v1" }),
      tariffMicros: partial === "overrun-held" ? 15 : 7, captureDispatchReservations: true });
    const costMicros = providerReported ? 3 : partial === "overrun-held" ? 15 : 7;
    f.state.failDispatchSettlement = partial !== "authority-held";
    f.state.rejectReconciliation = partial !== "dispatch-held";
    const executed = await f.controller.release(await f.release("recover-original", ["seat-0"]));
    const invocationId = executed.projection.attempts[0].invocationId;
    assert.equal(f.state.calls, 1);
    const before = await f.service.inspect("root"), originalRoot = structuredClone(before.root);
    const original = f.state.retainedResults.find(r => r.invocationId === invocationId);
    assert.ok(original);
    const actual = f.state.dispatchReservations.find(r => r.invocationId === invocationId).reservation;
    const openDispatch = () => new FileAuthorizationLedger({ root: path.join(f.cwd, "dispatch") });
    const lookup = { authorizationId: actual.authorizationId, invocationId: actual.invocationId };
    assert.equal((await openDispatch().inspectInvocation(lookup))[0].state, partial === "authority-held" ? "settled" : "reserved");
    assert.equal(before.invocations[0].usage === null, partial !== "dispatch-held");
    f.state.rejectReconciliation = false;
    const renewed = await approveHostRenewal(f, await successor(f, "recovery-new-epoch"));
    await f.service.renew(renewed);
    await f.service.cancel("root");
    f.authorityHost.now = () => "9999-01-01T00:00:00.000Z";
    f.physical.resolveRuntime = async () => { throw new Error("recovery must not construct a runtime"); };
    f.authorityHost.confirmHistoricalReconciliation = async (invocation, root, envelope) => {
      assert.deepEqual(root, originalRoot);
      assert.deepEqual(envelope, original.envelope);
      return invocation.invocationId === invocationId && canonicalJson(invocation.usage) === canonicalJson({ inputTokens: 1, outputTokens: 2, costMicros });
    };
    let releases = 0;
    const host = { async admitRecovery(observation) {
      assert.equal(observation.originEpoch, 0);
      assert.deepEqual(observation.root, originalRoot);
      assert.deepEqual(observation.envelope, original.envelope);
      assert.equal(observation.reservation.reservationId, actual.reservationId);
      const bytes = fs.readFileSync(path.join(f.cwd, `${original.reference.id}.json`));
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, original.reference.digest);
      const raw = JSON.parse(bytes), accounting = providerReported
        ? { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens,
          costMicros: Math.ceil(raw.usage.costUsd * 1_000_000), reportedCostUsd: raw.usage.costUsd, costBasis: "provider-reported" }
        : { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens,
          costMicros: partial === "overrun-held" ? (raw.usage.inputTokens + raw.usage.outputTokens) * 5
            : raw.usage.inputTokens + raw.usage.outputTokens * 3, costBasis: "tariff-upper-bound" };
      const intent = path.join(f.cwd, `recover-${invocationId}.json`);
      const intentBytes = canonicalJson({ authorityId: observation.authorityId, invocationId: observation.invocationId,
        originEpoch: observation.originEpoch, root: rootAuthorityReferenceV2(observation.root), envelope: observation.envelope,
        allocation: observation.invocation.allocation, reservation: actual, accounting, evidence: original.reference });
      if (fs.existsSync(intent)) assert.equal(fs.readFileSync(intent, "utf8"), intentBytes);
      else fs.writeFileSync(intent, intentBytes, { flag: "wx", mode: 0o600 });
      return { accounting, receipt: ref("durable-recovery-intent"), lease: {
        assertCurrent() { assert.equal(f.state.allowed, true); }, release() { releases++; },
      } };
    } };
    const counts = { calls: f.state.calls, reserves: f.state.reserveCalls, releases: f.state.releaseCalls ?? 0 };
    const recoveryLedger = {
      inspectInvocation: value => openDispatch().inspectInvocation(value),
      settleChecked: value => openDispatch().settleChecked(value),
      async reserve() { assert.fail("recovery cannot reserve"); },
      async settle() { assert.fail("recovery must use checked settlement"); },
      async release() { assert.fail("recovery cannot release"); },
    };
    const recover = () => recoverAuthorizedDelegationAccountingV1({ authorityId: "root", invocationId,
      service: f.openAuthority(), dispatchLedger: recoveryLedger, host });
    if (partial === "both-held") {
      const unknown = await recoverAuthorizedDelegationAccountingV1({ authorityId: "root", invocationId,
        service: f.openAuthority(), dispatchLedger: recoveryLedger, host: { async admitRecovery(observation) {
          const admitted = await host.admitRecovery(observation);
          return { ...admitted, accounting: null };
        } } });
      assert.equal(unknown.status, "held"); assert.equal(unknown.reason, "usage-unknown");
      assert.equal((await openDispatch().inspectInvocation(lookup))[0].state, "reserved");
      assert.equal((await f.openAuthority().inspect("root")).invocations[0].usage, null);
      await assert.rejects(recoverAuthorizedDelegationAccountingV1({ authorityId: "root", invocationId,
        service: f.openAuthority(), dispatchLedger: recoveryLedger, host: { async admitRecovery(observation) {
          const admitted = await host.admitRecovery(observation);
          await f.openAuthority().reconcileInvocation("root", invocationId, { inputTokens: 1, outputTokens: 2, costMicros: 7 }, true);
          return { ...admitted, accounting: { ...admitted.accounting, costMicros: 8 } };
        } } }), /recovery_accounting_conflict/);
      assert.equal((await openDispatch().inspectInvocation(lookup))[0].state, "reserved");
    }
    if (partial === "authority-held" || partial === "concurrent-dispatch-settled") {
      const confirm = f.authorityHost.confirmHistoricalReconciliation;
      f.authorityHost.confirmHistoricalReconciliation = async () => true;
      try {
        await assert.rejects(recoverAuthorizedDelegationAccountingV1({ authorityId: "root", invocationId,
          service: f.openAuthority(), dispatchLedger: recoveryLedger, host: { async admitRecovery(observation) {
            const admitted = await host.admitRecovery(observation);
            if (partial === "concurrent-dispatch-settled") await openDispatch().settleChecked({ reservation: actual,
              usage: { attempts: 1, totalTokens: 3, costUsd: delegationAccountingDollarsV1(7) },
              admission: { async acquire() { return { assertCurrent() {}, release() {} }; } } });
            return { ...admitted, accounting: { ...admitted.accounting, costMicros: 15 } };
          } } }));
        assert.equal((await f.openAuthority().inspect("root")).invocations[0].usage, null);
        assert.equal((await openDispatch().inspectInvocation(lookup))[0].usage.costUsd, delegationAccountingDollarsV1(7));
      } finally { f.authorityHost.confirmHistoricalReconciliation = confirm; }
    }
    const result = await recover();
    assert.equal(result.status, partial === "overrun-held" ? "held" : "settled");
    assert.deepEqual(result.invocation.usage, { inputTokens: 1, outputTokens: 2, costMicros });
    assert.equal(result.reservation.state, partial === "overrun-held" ? "reserved" : "settled");
    if (partial === "overrun-held") assert.equal(result.reason, "usage-exceeds-reservation");
    else assert.deepEqual(result.reservation.usage, { attempts: 1, totalTokens: 3, costUsd: providerReported ? 0.000003 : delegationAccountingDollarsV1(7) });
    assert.deepEqual(await recover(), result);
    assert.equal(releases, partial === "both-held" ? 4 : partial === "authority-held" || partial === "concurrent-dispatch-settled" ? 3 : 2);
    if (partial === "dispatch-held") {
      await assert.rejects(recoverAuthorizedDelegationAccountingV1({ authorityId: "root", invocationId,
        service: f.openAuthority(), dispatchLedger: recoveryLedger, host: { async admitRecovery(observation) {
          const admitted = await host.admitRecovery(observation);
          return { ...admitted, accounting: { ...admitted.accounting, costMicros: 8 } };
        } } }), /recovery_accounting_conflict/);
      assert.equal((await openDispatch().inspectInvocation(lookup))[0].usage.costUsd, delegationAccountingDollarsV1(7));
    }
    assert.deepEqual({ calls: f.state.calls, reserves: f.state.reserveCalls, releases: f.state.releaseCalls ?? 0 }, counts);
  });
}

for (const kind of ["reappraise", "authorizeRetry"]) {
  test(`Flow rounds checked ${kind} refuses denied host admission before Flow publication`, async t => {
    const { f, claimedBlock } = await exhaustedRoundsFixture(t);
    const reappraisal = await continuationCommand(f, "reappraise", "checked-reappraisal", {
      gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
    });
    let command = reappraisal;
    if (kind === "authorizeRetry") {
      await f.controller.reappraise(reappraisal);
      const run = await loadRun(f.spec.topology.runId, f.cwd);
      command = await continuationCommand(f, "authorizeRetry", "checked-retry", { reappraisalKey: reappraisal.operationKey, request: {
        reason: "Controlled checked retry", target_step: "first", blocked_transition_ref: flowTransitionRef(run.state.transitions.at(-1)),
        expected_run_head: flowRunHead(run.state), authority: { kind: "operator_request", actor: "fixture-host",
          request_ref: "controlled:checked-retry", requested_at: new Date().toISOString() },
      } });
    }
    const before = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state);
    const calls = f.state.calls;
    f.state.denyContinuationLease = true;
    await assert.rejects(f.controller[kind](command), /controlled continuation lease refusal/);
    assert.equal(flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state), before);
    assert.equal(f.state.calls, calls);
  });
}

test("Flow rounds checked reappraisal refuses a run head changed during host admission", async t => {
  const { f, claimedBlock } = await exhaustedRoundsFixture(t);
  const command = await continuationCommand(f, "reappraise", "competing-head-reappraisal", {
    gate: "second", blockedTransitionRef: flowTransitionRef(claimedBlock),
  });
  let competingHead;
  const transitions = (await loadRun(f.spec.topology.runId, f.cwd)).state.transitions.length;
  f.state.onContinuationLease = async () => {
    const authority = { kind: "operator_request", actor: "fixture-host", request_ref: "controlled:competing-head",
      requested_at: new Date().toISOString() };
    await pauseRun(f.spec.topology.runId, { cwd: f.cwd, reason: "Controlled competing mutation", authority });
    await resumeRun(f.spec.topology.runId, { cwd: f.cwd, reason: "Controlled competing mutation", authority });
    competingHead = flowRunHead((await loadRun(f.spec.topology.runId, f.cwd)).state);
    assert.notEqual(competingHead, command.flowHead);
  };
  await assert.rejects(f.controller.reappraise(command), /flow.run_head.stale/);
  const observed = await loadRun(f.spec.topology.runId, f.cwd);
  assert.equal(flowRunHead(observed.state), competingHead);
  assert.equal(observed.state.transitions.length, transitions);
  assert.equal(f.state.calls, 4);
});
