import { requireDelegationV2 } from "./delegation-authority-contract.js";
import { executeAuthorizedDelegation, executeAuthorizedDelegationAccountingV1, type DelegationExecutionHost, type DelegationExecutionAccountingHostV1 } from "./delegation-execution.js";
import { syncDelegationContext, syncDelegationContextAccountingV1 } from "./delegation-context-sync.js";
import type { DelegationFlowExecutionHost } from "./delegation-flow-execution.js";
import type { DelegationDispatchOutcome, DelegationDispatchAccountingOutcomeV1 } from "./delegation-dispatch.js";

export type DelegationRoundsExecutionHost = Omit<DelegationExecutionHost, "retainResult"> & {
  retainResult: DelegationExecutionAccountingHostV1["retainResult"];
};
export type DelegationRoundsOutcome = DelegationDispatchOutcome | DelegationDispatchAccountingOutcomeV1;
export type DelegationRoundsFlowExecutionHost = Omit<DelegationFlowExecutionHost, "retainResult" | "recordMemberOutcome"> & DelegationRoundsExecutionHost & {
  recordMemberOutcome(claim: Parameters<DelegationFlowExecutionHost["recordMemberOutcome"]>[0], envelope: Parameters<DelegationFlowExecutionHost["recordMemberOutcome"]>[1], outcome: DelegationRoundsOutcome): Promise<void>;
};
type Protocol = "retained-tariff-v1" | undefined;
function legacyHost(host: DelegationRoundsExecutionHost): DelegationExecutionHost {
  return {
    resolveRuntime: e => host.resolveRuntime(e),
    invokeFenced: (e, id, launch) => host.invokeFenced(e, id, launch),
    retainFailure: (error, e, id) => host.retainFailure(error, e, id),
    async retainResult(r, e, id) {
      const retained = await host.retainResult(r, e, id);
      requireDelegationV2(retained === undefined, "rounds_accounting_protocol_required");
    },
  };
}
export function executeRoundsDelegation(input: Omit<Parameters<typeof executeAuthorizedDelegation>[0], "host"> & {
  host: DelegationRoundsExecutionHost; accountingProtocol: Protocol;
}): Promise<DelegationRoundsOutcome> {
  const { accountingProtocol, host, ...execution } = input;
  requireDelegationV2(accountingProtocol === undefined || accountingProtocol === "retained-tariff-v1", "rounds_accounting_protocol");
  return accountingProtocol === "retained-tariff-v1"
    ? executeAuthorizedDelegationAccountingV1({ ...execution, host: { ...host, accountingProtocol } })
    : executeAuthorizedDelegation({ ...execution, host: legacyHost(host) });
}
export function syncRoundsDelegation(input: Omit<Parameters<typeof syncDelegationContext>[0], "host"> & {
  host: DelegationRoundsExecutionHost & Pick<Parameters<typeof syncDelegationContext>[0]["host"], "retainSyncReceipt">;
  accountingProtocol: Protocol;
}): ReturnType<typeof syncDelegationContext> {
  const { accountingProtocol, host, ...sync } = input;
  requireDelegationV2(accountingProtocol === undefined || accountingProtocol === "retained-tariff-v1", "rounds_accounting_protocol");
  return accountingProtocol === "retained-tariff-v1"
    ? syncDelegationContextAccountingV1({ ...sync, host: { ...host, accountingProtocol } })
    : syncDelegationContext({ ...sync, host: { ...legacyHost(host), retainSyncReceipt: receipt => host.retainSyncReceipt(receipt) } });
}
