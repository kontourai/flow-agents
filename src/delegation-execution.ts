import type { AuthorizationLedger } from "@kontourai/dispatch";
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
  const { envelope } = await input.service.admitEffect(input.authorityId, input.envelopeId, input.effect);
  const selected = await input.host.resolveRuntime(structuredClone(envelope));
  if (canonicalJson(selected.runtimeReceipt) !== canonicalJson(envelope.execution_binding.runtime.runtime_receipt_ref)
    || canonicalJson(selected.modelReceipt) !== canonicalJson(envelope.execution_binding.runtime.model_receipt_ref)) {
    throw new DelegationAdmissionError("runtime_receipt_mismatch");
  }
  await input.service.reserveInvocation(input.authorityId, input.envelopeId, input.invocationId, input.allocation);
  let observed: ModelInvocationResult | undefined;
  const runtime: ModelRuntime = {
    id: selected.runtime.id,
    capabilities: () => selected.runtime.capabilities(),
    async invoke(request, options) {
      // Recheck after reservation and immediately before the host's launch fence.
      await input.service.admitEffect(input.authorityId, input.envelopeId, input.effect);
      return input.host.invokeFenced(structuredClone(envelope), input.invocationId,
        () => selected.runtime.invoke(request, options));
    },
  };
  const maxTokens = input.allocation.inputTokens + input.allocation.outputTokens;
  const maxCostUsd = input.allocation.costMicros / 1_000_000;
  const outcome = await dispatchDelegation({
    plan: {
      schemaVersion: 1, role: "delegated-member", request: input.request,
      candidates: [{ id: envelope.selected_grant_id, runtimeId: "selected", worstCaseUsage: { maxTokens, maxCostUsd } }],
      budget: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd },
      authorization: { schemaVersion: 1, id: `${input.authorityId}:${envelope.execution_id}:${input.invocationId}`, invocationId: input.invocationId,
        limits: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd } },
    },
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
  }
  return outcome;
}
