import { createHash } from "node:crypto";
import { dispatch, AuthorizationPersistenceError, type ExecutionPlan, type AuthorizationLedger } from "@kontourai/dispatch";
import { canonicalJson, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime } from "@kontourai/relay";
import type { DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import type { DelegationReferenceV2 } from "./delegation-authority-contract.js";
import { createDelegationAuthorityService, DelegationAdmissionError, type DelegationInvocationAmounts } from "./delegation-authority-service.js";
import { dispatchDelegation, type DelegationDispatchOutcome } from "./delegation-dispatch.js";

export interface DelegationExecutionHost {
  resolveRuntime(envelope: DelegationEnvelopeV2): Promise<{
    runtime: ModelRuntime; runtimeReceipt: DelegationReferenceV2; modelReceipt: DelegationReferenceV2;
  }>;
  /** Enforces the current assignment/generation, cancellation and effect authority across launch. */
  invokeFenced(envelope: DelegationEnvelopeV2, invocationId: string, invoke: () => Promise<ModelInvocationResult>): Promise<ModelInvocationResult>;
  retainFailure(error: unknown, envelope: DelegationEnvelopeV2, invocationId: string): Promise<void>;
  retainResult(result: ModelInvocationResult, envelope: DelegationEnvelopeV2, invocationId: string): Promise<void>;
}

/** One physical attempt. Explicit retries use a new invocation id and consume fresh capacity. */
export async function executeAuthorizedDelegation(input: {
  service: ReturnType<typeof createDelegationAuthorityService>;
  host: DelegationExecutionHost;
  dispatchLedger: AuthorizationLedger;
  authorityId: string;
  envelopeId: string;
  invocationId: string;
  effect: string;
  request: ModelInvocationRequest;
  allocation: DelegationInvocationAmounts;
  signal?: AbortSignal;
}): Promise<DelegationDispatchOutcome> {
  input.signal?.throwIfAborted();
  const { envelope } = await input.service.admitEffect(input.authorityId, input.envelopeId, input.effect);
  const selected = await input.host.resolveRuntime(structuredClone(envelope));
  if (canonicalJson(selected.runtimeReceipt) !== canonicalJson(envelope.execution_binding.runtime.runtime_receipt_ref)
    || canonicalJson(selected.modelReceipt) !== canonicalJson(envelope.execution_binding.runtime.model_receipt_ref)) {
    throw new DelegationAdmissionError("runtime_receipt_mismatch");
  }
  const capabilities = selected.runtime.capabilities();
  if (!Number.isSafeInteger(input.request.maxOutputTokens) || input.request.maxOutputTokens! < 1
    || input.request.maxOutputTokens! > input.allocation.outputTokens || capabilities.outputTokenLimitFidelity !== "native"
    || !capabilities.abort || !capabilities.usage) {
    throw new DelegationAdmissionError("runtime_bounds_unsupported");
  }
  const supported = new Set([
    ...(capabilities.structuredTools ? ["tool-use", "structured-tools"] : []),
    ...(capabilities.abort ? ["abort"] : []), ...(capabilities.usage ? ["usage"] : []),
    ...(capabilities.streaming ? ["streaming"] : []),
  ]);
  const choice = input.request.toolChoice;
  if (envelope.execution_binding.runtime.required_capabilities.some((name) => !supported.has(name))
    || input.request.tools?.some((tool) => !envelope.execution_authority.allowed_tools.includes(tool.name))
    || (choice?.type === "tool" && !input.request.tools?.some((tool) => tool.name === choice.name))) {
    throw new DelegationAdmissionError("runtime_authority_unsupported");
  }
  const maxTokens = input.allocation.inputTokens + input.allocation.outputTokens;
  const maxCostUsd = input.allocation.costMicros / 1_000_000;
  const digest = createHash("sha256").update(canonicalJson([input.authorityId, envelope.execution_id, input.invocationId])).digest("hex");
  const plan: ExecutionPlan = {
    schemaVersion: 1, role: "delegated-member", request: structuredClone(input.request),
    candidates: [{ id: "selected-grant", runtimeId: "selected", worstCaseUsage: { maxTokens, maxCostUsd } }],
    budget: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd },
    authorization: { schemaVersion: 1, id: `auth_${digest}`, invocationId: `invoke_${digest}`,
      limits: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd } },
  };
  // Public Dispatch validation runs without a ledger or any possible invocation.
  await dispatch(plan, new Map(), { signal: AbortSignal.abort() });
  input.signal?.throwIfAborted();
  await input.service.reserveInvocation(input.authorityId, input.envelopeId, input.invocationId, input.allocation);
  let observed: ModelInvocationResult | undefined;
  const runtime: ModelRuntime = {
    id: selected.runtime.id,
    capabilities: () => selected.runtime.capabilities(),
    async invoke(request, options) {
      // Recheck after reservation and immediately before the host's launch fence.
      await input.service.admitEffect(input.authorityId, input.envelopeId, input.effect);
      try {
        return await input.host.invokeFenced(structuredClone(envelope), input.invocationId,
          () => selected.runtime.invoke(request, options));
      } catch (error) {
        try { await input.host.retainFailure(error, structuredClone(envelope), input.invocationId); }
        catch (retentionError) { throw new AuthorizationPersistenceError("Failure retention unavailable", retentionError, "settle"); }
        throw error;
      }
    },
  };
  const outcome = await dispatchDelegation({
    plan,
    runtimes: new Map([["selected", runtime]]), ledger: input.dispatchLedger,
    ...(input.signal ? { signal: input.signal } : {}),
    async retainResult(result) {
      await input.host.retainResult(structuredClone(result), structuredClone(envelope), input.invocationId);
      observed = structuredClone(result);
    },
  });
  if (observed) {
    const usage = observed.usage;
    const costMicros = usage.costUsd === undefined ? NaN : Math.ceil(usage.costUsd * 1_000_000);
    const amounts = Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && Number.isSafeInteger(costMicros)
      ? { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, costMicros } : null;
    await input.service.reconcileInvocation(input.authorityId, input.invocationId, amounts, true);
    if (amounts && (amounts.inputTokens > input.allocation.inputTokens || amounts.outputTokens > input.allocation.outputTokens
      || amounts.costMicros > input.allocation.costMicros)) {
      return { outcome: "budget-exceeded", dispatchReceipt: outcome.dispatchReceipt, reportedCostUsd: outcome.reportedCostUsd };
    }
  }
  return outcome;
}
