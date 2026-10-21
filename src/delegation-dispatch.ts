import {
  AuthorizationPersistenceError, dispatch,
  type AuthorizationLedger, type DispatchReceipt, type DispatchTerminalOutcome, type ExecutionPlan, type RuntimeRegistry,
} from "@kontourai/dispatch";
import type { ModelInvocationResult, ModelRuntime } from "@kontourai/relay";

export interface DelegationDispatchInput {
  plan: ExecutionPlan;
  runtimes: RuntimeRegistry;
  ledger: AuthorizationLedger;
  signal?: AbortSignal;
  /** Must durably retain the raw observation before returning; this is not an acceptance decision. */
  retainResult(result: ModelInvocationResult, runtimeId: string): Promise<void>;
}

export type DelegationDispatchOutcome = {
  outcome: DispatchTerminalOutcome;
  /** Unmodified diagnostic from the estimate-neutralized Dispatch plan. */
  dispatchReceipt: DispatchReceipt;
  reportedCostUsd: number;
  result?: ModelInvocationResult;
};

/**
 * One logical dispatch per call, possibly with explicitly configured fallback attempts. Dispatch owns physical attempt reservation and replay refusal.
 * Missing usage is unknown, never zero; failed retention or reconciliation leaves the
 * reservation held. The host must authenticate the plan and enforce its runtime bounds.
 */
export async function dispatchDelegation(input: DelegationDispatchInput): Promise<DelegationDispatchOutcome> {
  const { plan } = input;
  if (!plan.authorization || plan.authorization.limits.maxTotalTokens === undefined
    || plan.authorization.limits.maxCostUsd === undefined) {
    throw new Error("Delegation dispatch requires durable token and cost authorization");
  }
  for (const candidate of plan.candidates) {
    if (candidate.worstCaseUsage?.maxTokens === undefined || candidate.worstCaseUsage.maxCostUsd === undefined) {
      throw new Error("Delegation dispatch requires worst-case capacity for each candidate");
    }
  }
  let reportedCostUsd = 0;
  let observed: ModelInvocationResult | undefined;
  const wrapped = new Map<string, ModelRuntime>();
  const runtimes: RuntimeRegistry = {
    get(id) {
      const existing = wrapped.get(id);
      if (existing) return existing;
      const runtime = input.runtimes.get(id);
      if (!runtime) return undefined;
      const guarded: ModelRuntime = {
        id: runtime.id,
        capabilities: () => runtime.capabilities(),
        async invoke(request, options) {
          observed = undefined;
          const result = await runtime.invoke(request, options);
          try { await input.retainResult(structuredClone(result), id); }
          catch (error) { throw new AuthorizationPersistenceError("Delegation result retention failed", error, "settle"); }
          observed = structuredClone(result);
          return result;
        },
      };
      wrapped.set(id, guarded);
      return guarded;
    },
  };
  const ledger: AuthorizationLedger = {
    reserve: (reservation) => input.ledger.reserve(reservation),
    release: (release) => input.ledger.release(release),
    async settle(settlement) {
      const usage = observed?.usage;
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens! < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens! < 0
        || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
        throw new AuthorizationPersistenceError("Delegation usage remains unknown", undefined, "settle");
      }
      if (settlement.usage.totalTokens !== usage.inputTokens! + usage.outputTokens!) {
        throw new AuthorizationPersistenceError("Delegation accounting observation mismatch", undefined, "settle");
      }
      await input.ledger.settle({ ...settlement, usage: { ...settlement.usage, costUsd: usage.costUsd } });
      reportedCostUsd += usage.costUsd;
      observed = undefined;
    },
  };
  const outcome = await dispatch({
    ...plan,
    candidates: plan.candidates.map(({ estimatedUsdPer1kTokens: _estimate, ...candidate }) => candidate),
  }, runtimes, { authorizationLedger: ledger, ...(input.signal ? { signal: input.signal } : {}) });
  const overCost = plan.budget.maxCostUsd !== undefined && reportedCostUsd > plan.budget.maxCostUsd;
  const terminal = overCost ? "budget-exceeded" : outcome.receipt.outcome;
  return {
    outcome: terminal,
    dispatchReceipt: outcome.receipt,
    reportedCostUsd,
    ...(terminal === "succeeded" && outcome.result ? { result: outcome.result } : {}),
  };
}
