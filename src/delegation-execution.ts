import { dispatchAuthorizationIdentity } from "./delegation-dispatch-identity.js";
import { dispatch, AuthorizationPersistenceError, type ExecutionPlan, type AuthorizationLedger, type AuthorizationReservation } from "@kontourai/dispatch";
import { canonicalJson, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime } from "@kontourai/relay";
import type { DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import type { DelegationReferenceV2 } from "./delegation-authority-contract.js";
import { createDelegationAuthorityService, DelegationAdmissionError, type DelegationInvocationAmounts } from "./delegation-authority-service.js";
import {
  dispatchDelegation, dispatchDelegationAccountingV1, delegationAccountingDollarsV1,
  validateDelegationRetainedAccountingV1, type DelegationDispatchInput, type DelegationDispatchOutcome,
  type DelegationDispatchAccountingOutcomeV1, type DelegationRetainedAccountingV1,
} from "./delegation-dispatch.js";

export interface DelegationExecutionHost {
  resolveRuntime(envelope: DelegationEnvelopeV2): Promise<{
    runtime: ModelRuntime; runtimeReceipt: DelegationReferenceV2; modelReceipt: DelegationReferenceV2;
  }>;
  /** Enforces the current assignment/generation, cancellation and effect authority across launch. */
  invokeFenced(envelope: DelegationEnvelopeV2, invocationId: string, invoke: () => Promise<ModelInvocationResult>): Promise<ModelInvocationResult>;
  retainFailure(error: unknown, envelope: DelegationEnvelopeV2, invocationId: string): Promise<void>;
  retainResult(result: ModelInvocationResult, envelope: DelegationEnvelopeV2, invocationId: string): Promise<void>;
  /** Retain the actual durable Dispatch reservation before any physical invocation. */
  retainDispatchReservation?(reservation: AuthorizationReservation, envelope: DelegationEnvelopeV2, invocationId: string): Promise<void>;
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
  /** Awaited after Flow authority reservation, before Dispatch reserves or invokes. */
  onReserved?: () => Promise<void>;
}): Promise<DelegationDispatchOutcome> {
  return executeDelegation(input, legacyAccounting);
}

export interface DelegationExecutionAccountingHostV1 extends Omit<DelegationExecutionHost, "retainResult"> {
  accountingProtocol: "retained-tariff-v1";
  /** Retain raw evidence before returning exact integer usage. null holds unknown;
   * undefined explicitly selects the legacy Relay dollar bridge. */
  retainResult(result: ModelInvocationResult, envelope: DelegationEnvelopeV2, invocationId: string): Promise<DelegationRetainedAccountingV1 | null | void>;
}

type ExecutionInput<Host> = Omit<Parameters<typeof executeAuthorizedDelegation>[0], "host"> & { host: Host };
export type DelegationExecutionAccountingInputV1 = ExecutionInput<DelegationExecutionAccountingHostV1>;
type RetainedAccountingV1 = DelegationRetainedAccountingV1 | null | void;
type ExecutionHost<Retained> = Omit<DelegationExecutionHost, "retainResult"> & {
  retainResult(result: ModelInvocationResult, envelope: DelegationEnvelopeV2, invocationId: string): Promise<Retained>;
};

/** Explicit opt-in; provider-reported dollars remain absent for retained tariffs. */
export async function executeAuthorizedDelegationAccountingV1(
  input: DelegationExecutionAccountingInputV1,
): Promise<DelegationDispatchAccountingOutcomeV1> {
  if (input.host.accountingProtocol !== "retained-tariff-v1") throw new Error("Delegation accounting protocol required");
  return executeDelegation(input, retainedAccountingV1);
}

interface ExecutionAccounting<Retained, Outcome> {
  reservationDollars(micros: number): number;
  validate(value: Retained): Retained;
  amounts(result: ModelInvocationResult, retained: Retained): DelegationInvocationAmounts | null;
  dispatch(input: Omit<DelegationDispatchInput, "retainResult"> & {
    retainResult(result: ModelInvocationResult, runtimeId: string): Promise<Retained>;
  }): Promise<Outcome>;
  overrun(outcome: Outcome): Outcome;
}
function relayAmounts(result: ModelInvocationResult): DelegationInvocationAmounts | null {
  const usage = result.usage;
  const costMicros = usage.costUsd === undefined ? NaN : Math.ceil(usage.costUsd * 1_000_000);
  return Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && Number.isSafeInteger(costMicros)
    ? { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, costMicros } : null;
}
const legacyAccounting: ExecutionAccounting<void, DelegationDispatchOutcome> = {
  reservationDollars: micros => micros / 1_000_000,
  validate: value => value,
  amounts: result => relayAmounts(result),
  dispatch: dispatchDelegation,
  overrun: outcome => ({ outcome: "budget-exceeded", dispatchReceipt: outcome.dispatchReceipt, reportedCostUsd: outcome.reportedCostUsd }),
};
const retainedAccountingV1: ExecutionAccounting<RetainedAccountingV1, DelegationDispatchAccountingOutcomeV1> = {
  reservationDollars: delegationAccountingDollarsV1,
  validate: value => value === undefined ? undefined : value === null ? null : validateDelegationRetainedAccountingV1(value),
  amounts: (result, retained) => retained === undefined ? relayAmounts(result) : retained === null ? null
    : { inputTokens: retained.inputTokens, outputTokens: retained.outputTokens, costMicros: retained.costMicros },
  dispatch: dispatchDelegationAccountingV1,
  overrun: ({ result: _result, ...outcome }) => ({ ...outcome, outcome: "budget-exceeded" }),
};

async function executeDelegation<Retained, Outcome>(
  input: ExecutionInput<ExecutionHost<Retained>>,
  accounting: ExecutionAccounting<Retained, Outcome>,
): Promise<Outcome> {
  input = { ...input, request: structuredClone(input.request), allocation: structuredClone(input.allocation) };
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
  if ((input.request.tools && input.request.tools.length > 0 && !capabilities.structuredTools)
    || envelope.execution_binding.runtime.required_capabilities.some((name) => !supported.has(name))
    || input.request.tools?.some((tool) => !envelope.execution_authority.allowed_tools.includes(tool.name))
    || (choice?.type === "tool" && !input.request.tools?.some((tool) => tool.name === choice.name))) {
    throw new DelegationAdmissionError("runtime_authority_unsupported");
  }
  const maxTokens = input.allocation.inputTokens + input.allocation.outputTokens;
  const maxCostUsd = accounting.reservationDollars(input.allocation.costMicros);
  const identity = dispatchAuthorizationIdentity(input.authorityId, envelope.execution_id, input.invocationId);
  const plan: ExecutionPlan = {
    schemaVersion: 1, role: "delegated-member", request: structuredClone(input.request),
    candidates: [{ id: "selected-grant", runtimeId: "selected", worstCaseUsage: { maxTokens, maxCostUsd } }],
    budget: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd },
    authorization: { schemaVersion: 1, ...identity,
      limits: { maxAttempts: 1, maxTotalTokens: maxTokens, maxCostUsd } },
  };
  // Public Dispatch validation runs without a ledger or any possible invocation.
  await dispatch(plan, new Map(), { signal: AbortSignal.abort() });
  input.signal?.throwIfAborted();
  await input.service.reserveInvocation(input.authorityId, input.envelopeId, input.invocationId, input.allocation);
  await input.onReserved?.();
  let observed: { result: ModelInvocationResult; retained: Retained } | undefined;
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
  async function reconcileObserved(): Promise<boolean> {
    if (!observed) return false;
    const amounts = accounting.amounts(observed.result, observed.retained);
    await input.service.reconcileInvocation(input.authorityId, input.invocationId, amounts, true);
    return amounts !== null && (amounts.inputTokens > input.allocation.inputTokens || amounts.outputTokens > input.allocation.outputTokens || amounts.costMicros > input.allocation.costMicros);
  }
  const dispatchLedger: AuthorizationLedger = {
    async reserve(reservation) {
      const result = await input.dispatchLedger.reserve(reservation);
      if (result.status === "reserved" && input.host.retainDispatchReservation) {
        try {
          await input.host.retainDispatchReservation(structuredClone(reservation), structuredClone(envelope), input.invocationId);
        } catch (error) {
          throw new AuthorizationPersistenceError("Dispatch reservation retention failed", error, "recovery");
        }
      }
      return result;
    },
    settle: settlement => input.dispatchLedger.settle(settlement),
    release: release => input.dispatchLedger.release(release),
  };
  let outcome: Outcome;
  try {
    outcome = await accounting.dispatch({
      plan,
      runtimes: new Map([["selected", runtime]]), ledger: dispatchLedger,
      ...(input.signal ? { signal: input.signal } : {}),
      async retainResult(result) {
        const retained = accounting.validate(await input.host.retainResult(
          structuredClone(result), structuredClone(envelope), input.invocationId,
        ));
        observed = { result: structuredClone(result), retained };
        return retained;
      },
    });
  } catch (error) {
    // A retained result can outlive a failed Dispatch settlement. Preserve its
    // confirmed accounting so a known overrun cannot remain an unknown hold.
    try { await reconcileObserved(); }
    catch (reconciliationError) {
      throw new AggregateError([error, reconciliationError], "Dispatch settlement and authority reconciliation failed", { cause: error });
    }
    throw error;
  }
  if (await reconcileObserved()) {
    return accounting.overrun(outcome);
  }
  return outcome;
}
