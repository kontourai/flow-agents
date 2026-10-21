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

export interface DelegationRetainedAccountingV1 {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  costBasis: "tariff-upper-bound";
}

// Dispatch has a numeric dollar ledger. Round its accounting view upward; the
// authority ledger keeps the original integer micros without a reverse conversion.
export function delegationAccountingDollarsV1(micros: number): number {
  if (!Number.isSafeInteger(micros) || micros < 0 || micros > 1_000_000_000_000)
    throw new AuthorizationPersistenceError("Delegation accounting amount invalid", undefined, "settle");
  if (micros === 0) return 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, micros / 1_000_000);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

export function validateDelegationRetainedAccountingV1(value: DelegationRetainedAccountingV1): DelegationRetainedAccountingV1 {
  if (!value || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0 ||
    !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0 ||
    !Number.isSafeInteger(value.inputTokens + value.outputTokens) ||
    value.costBasis !== "tariff-upper-bound")
    throw new AuthorizationPersistenceError("Delegation retained accounting invalid", undefined, "settle");
  delegationAccountingDollarsV1(value.costMicros);
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, costMicros: value.costMicros, costBasis: value.costBasis };
}

export interface DelegationDispatchAccountingInputV1 {
  plan: ExecutionPlan;
  runtimes: RuntimeRegistry;
  ledger: AuthorizationLedger;
  signal?: AbortSignal;
  /** Must durably retain the raw observation before returning; this is not an acceptance decision. */
  retainResult(result: ModelInvocationResult, runtimeId: string): Promise<DelegationRetainedAccountingV1 | null | void>;
}

export type DelegationDispatchAccountingOutcomeV1 = {
  outcome: DispatchTerminalOutcome;
  /** Unmodified diagnostic from the estimate-neutralized Dispatch plan. */
  dispatchReceipt: DispatchReceipt;
  reportedCostUsd: number | undefined;
  accountedCostUsd: number;
  costBasis: "provider-reported" | "tariff-upper-bound" | "unknown";
  result?: ModelInvocationResult;
};

/**
 * One logical dispatch per call, possibly with explicitly configured fallback attempts. Dispatch owns physical attempt reservation and replay refusal.
 * Missing usage is unknown, never zero; failed retention or reconciliation leaves the
 * reservation held. The host must authenticate the plan and enforce its runtime bounds.
 */
export async function dispatchDelegationAccountingV1(input: DelegationDispatchAccountingInputV1): Promise<DelegationDispatchAccountingOutcomeV1> {
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
  let reportedCostUsd: number | undefined = 0;
  let accountedCostUsd = 0;
  let costBasis: "provider-reported" | "tariff-upper-bound" = "provider-reported";
  let retained: DelegationRetainedAccountingV1 | null | undefined;
  let unsettledAttempts = 0;
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
          retained = undefined;
          unsettledAttempts++;
          const result = await runtime.invoke(request, options);
          try {
            const amounts = await input.retainResult(structuredClone(result), id);
            retained = amounts === undefined ? undefined : amounts === null ? null : validateDelegationRetainedAccountingV1(amounts);
          }
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
      const exact = retained;
      const inputTokens = exact?.inputTokens ?? usage?.inputTokens;
      const outputTokens = exact?.outputTokens ?? usage?.outputTokens;
      const costUsd = exact ? delegationAccountingDollarsV1(exact.costMicros) : usage?.costUsd;
      if (exact === null || !Number.isSafeInteger(inputTokens) || inputTokens! < 0
        || !Number.isSafeInteger(outputTokens) || outputTokens! < 0
        || typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
        throw new AuthorizationPersistenceError("Delegation usage remains unknown", undefined, "settle");
      }
      if (settlement.usage.totalTokens !== inputTokens! + outputTokens!) {
        throw new AuthorizationPersistenceError("Delegation accounting observation mismatch", undefined, "settle");
      }
      await input.ledger.settle({ ...settlement, usage: { ...settlement.usage, costUsd } });
      unsettledAttempts--;
      accountedCostUsd += costUsd;
      if (exact?.costBasis === "tariff-upper-bound") {
        costBasis = "tariff-upper-bound";
        reportedCostUsd = undefined;
      } else if (reportedCostUsd !== undefined) reportedCostUsd += usage?.costUsd ?? costUsd;
      observed = undefined;
    },
  };
  const outcome = await dispatch({
    ...plan,
    candidates: plan.candidates.map(({ estimatedUsdPer1kTokens: _estimate, ...candidate }) => candidate),
  }, runtimes, { authorizationLedger: ledger, ...(input.signal ? { signal: input.signal } : {}) });
  const overCost = plan.budget.maxCostUsd !== undefined && accountedCostUsd > plan.budget.maxCostUsd;
  const terminal = overCost ? "budget-exceeded" : outcome.receipt.outcome;
  return {
    outcome: terminal,
    dispatchReceipt: outcome.receipt,
    reportedCostUsd: unsettledAttempts > 0 ? undefined : reportedCostUsd,
    accountedCostUsd,
    costBasis: unsettledAttempts > 0 ? "unknown" : costBasis,
    ...(terminal === "succeeded" && outcome.result ? { result: outcome.result } : {}),
  };
}
