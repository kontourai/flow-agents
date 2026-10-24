import { loadRun, withRunMutationLock } from "./delegation-flow-bindings.js";
import { DelegationAdmissionError } from "./delegation-authority-service.js";

/** Same-realm host composition only; success grants no execution authority. */
export function assertDelegationFlowRuntime(input: Readonly<{
  loadRun: typeof loadRun;
  withRunMutationLock: typeof withRunMutationLock;
}>): void {
  if (!input || typeof input !== "object"
    || input.loadRun !== loadRun
    || input.withRunMutationLock !== withRunMutationLock) {
    throw new DelegationAdmissionError("delegation_flow_runtime_mismatch");
  }
}
