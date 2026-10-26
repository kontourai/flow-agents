import type { AuthorizationRecoveryAdmission, AuthorizationReservationSnapshot, RecoverableAuthorizationLedger } from "@kontourai/dispatch";
import { canonicalJson } from "@kontourai/relay";
import { delegationIdV2, delegationReferenceV2, delegationIntegerV2, requireDelegationV2, type RootAuthorityV2, type DelegationReferenceV2 } from "./delegation-authority-contract.js";
import type { DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import type { DelegationInvocation } from "./delegation-authority-service.js";
import type { createDelegationAuthorityServiceV3 } from "./delegation-authority-service-v3.js";
import { delegationAccountingDollarsV1, validateDelegationRetainedAccountingV1, type DelegationRetainedAccountingV1 } from "./delegation-dispatch.js";
import { dispatchAuthorizationIdentity } from "./delegation-dispatch-identity.js";

type RecoveryLease = Awaited<ReturnType<AuthorizationRecoveryAdmission["acquire"]>>;
type Authority = Pick<ReturnType<typeof createDelegationAuthorityServiceV3>, "inspect" | "reconcileInvocation">;
export type DelegationRecoveryAccountingV1 = DelegationRetainedAccountingV1 | {
  inputTokens: number; outputTokens: number; costMicros: number;
  costBasis: "provider-reported"; reportedCostUsd: number;
};
export interface DelegationAccountingRecoveryObservationV1 {
  authorityId: string; invocationId: string; originEpoch: number;
  reservationProtocol: "legacy-relay" | "retained-tariff-v1";
  root: RootAuthorityV2; envelope: DelegationEnvelopeV2;
  invocation: DelegationInvocation; reservation: AuthorizationReservationSnapshot;
}
export interface DelegationAccountingRecoveryHostV1 {
  /** Authenticate original physical/tariff evidence and current operator authority;
   * durably retain this recovery intent, then exclude relevant changes until release. */
  admitRecovery(observation: DelegationAccountingRecoveryObservationV1): Promise<{
    accounting: DelegationRecoveryAccountingV1 | null;
    receipt: DelegationReferenceV2;
    lease: RecoveryLease;
  }>;
}
export type DelegationAccountingRecoveryResultV1 = {
  status: "settled" | "held";
  reason: "exact-settlement" | "usage-unknown" | "usage-exceeds-reservation";
  receipt: DelegationReferenceV2;
  accounting: DelegationRecoveryAccountingV1 | null;
  invocation: DelegationInvocation;
  reservation: AuthorizationReservationSnapshot;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function recoveryAccounting(value: DelegationRecoveryAccountingV1): DelegationRecoveryAccountingV1 {
  if (value.costBasis === "tariff-upper-bound") return validateDelegationRetainedAccountingV1(value);
  requireDelegationV2(value.costBasis === "provider-reported", "recovery_accounting_protocol_invalid");
  const { inputTokens, outputTokens, costMicros, reportedCostUsd } = value;
  [inputTokens, outputTokens, costMicros].forEach(v => delegationIntegerV2(v));
  requireDelegationV2(Number.isSafeInteger(inputTokens + outputTokens) && typeof reportedCostUsd === "number"
    && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0
    && Math.ceil(reportedCostUsd * 1_000_000) === costMicros, "recovery_reported_cost_invalid");
  return { inputTokens, outputTokens, costMicros, reportedCostUsd, costBasis: "provider-reported" };
}
function reservationTuple(value: AuthorizationReservationSnapshot) {
  return { authorizationId: value.authorizationId, invocationId: value.invocationId,
    reservationId: value.reservationId, limits: value.limits, capacity: value.capacity };
}

/** Accounting only: no runtime preparation, invocation, reservation, release or refund. */
export async function recoverAuthorizedDelegationAccountingV1(input: {
  authorityId: string; invocationId: string; service: Authority;
  dispatchLedger: RecoverableAuthorizationLedger; host: DelegationAccountingRecoveryHostV1;
}): Promise<DelegationAccountingRecoveryResultV1> {
  const { authorityId, invocationId, service, dispatchLedger, host } = input;
  delegationIdV2(authorityId); delegationIdV2(invocationId);
  const ledger = await service.inspect(authorityId);
  const invocation = ledger.invocations.find(i => i.invocationId === invocationId);
  const origin = ledger.origins.find(o => o.invocationId === invocationId);
  requireDelegationV2(invocation && origin, "recovery_invocation_missing");
  const epoch = ledger.epochs[origin.epoch];
  const envelope = epoch.envelopes.find(e => e.envelope_id === invocation.envelopeId);
  requireDelegationV2(envelope, "recovery_envelope_missing");
  const identity = dispatchAuthorizationIdentity(authorityId, envelope.execution_id, invocationId);
  const totalTokens = invocation.allocation.inputTokens + invocation.allocation.outputTokens;
  requireDelegationV2(Number.isSafeInteger(totalTokens), "recovery_allocation_invalid");
  const matches = await dispatchLedger.inspectInvocation({ authorizationId: identity.id, invocationId: identity.invocationId });
  requireDelegationV2(matches.length === 1, "recovery_reservation_missing_or_ambiguous");
  const reservation = structuredClone(matches[0]);
  const protocols = (["legacy-relay", "retained-tariff-v1"] as const).filter(protocol => {
    const maxCostUsd = protocol === "legacy-relay" ? invocation.allocation.costMicros / 1_000_000
      : delegationAccountingDollarsV1(invocation.allocation.costMicros);
    return same(reservation.limits, { maxAttempts: 1, maxTotalTokens: totalTokens, maxCostUsd })
      && same(reservation.capacity, { attempts: 1, maxTokens: totalTokens, maxCostUsd });
  });
  requireDelegationV2(reservation.authorizationId === identity.id && reservation.invocationId === identity.invocationId
    && protocols.length === 1 && reservation.state !== "released", "recovery_reservation_mismatch");
  const reservationProtocol = protocols[0];
  const admitted = await host.admitRecovery(structuredClone({ authorityId, invocationId, originEpoch: origin.epoch,
    root: epoch.root, envelope, invocation, reservation, reservationProtocol }));
  const lease = admitted.lease;
  try {
    const receipt = structuredClone(admitted.receipt); delegationReferenceV2(receipt);
    const accounting = admitted.accounting === null ? null : recoveryAccounting(admitted.accounting);
    const assertCurrent = () => requireDelegationV2(lease.assertCurrent() === undefined, "recovery_lease_invalid");
    assertCurrent();
    const current = await service.inspect(authorityId);
    assertCurrent();
    const currentInvocation = current.invocations.find(i => i.invocationId === invocationId);
    const currentOrigin = current.origins.find(o => o.invocationId === invocationId);
    requireDelegationV2(currentInvocation && currentOrigin?.epoch === origin.epoch
      && same(current.epochs[origin.epoch].root, epoch.root)
      && same(current.epochs[origin.epoch].envelopes.find(e => e.envelope_id === invocation.envelopeId), envelope)
      && currentInvocation.envelopeId === invocation.envelopeId && same(currentInvocation.allocation, invocation.allocation), "recovery_origin_changed");
    const currentReservations = await dispatchLedger.inspectInvocation({ authorizationId: identity.id, invocationId: identity.invocationId });
    assertCurrent();
    requireDelegationV2(currentReservations.length === 1 && same(reservationTuple(currentReservations[0]), reservationTuple(reservation))
      && currentReservations[0].state !== "released", "recovery_reservation_changed");
    const currentReservation = currentReservations[0];
    if (accounting === null) return { status: "held", reason: "usage-unknown", receipt, accounting, invocation: structuredClone(currentInvocation), reservation: currentReservation };
    requireDelegationV2(accounting.costBasis !== "tariff-upper-bound" || reservationProtocol === "retained-tariff-v1", "recovery_accounting_protocol_mismatch");
    const usage = { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens, costMicros: accounting.costMicros };
    requireDelegationV2(currentInvocation.usage === null || same(currentInvocation.usage, usage), "recovery_accounting_conflict");
    const dispatchUsage = { attempts: 1 as const, totalTokens: accounting.inputTokens + accounting.outputTokens,
      costUsd: accounting.costBasis === "provider-reported" ? accounting.reportedCostUsd : delegationAccountingDollarsV1(accounting.costMicros) };
    requireDelegationV2(currentReservation.state !== "settled" || same(currentReservation.usage, dispatchUsage), "recovery_dispatch_accounting_conflict");
    const dispatchOverrun = dispatchUsage.totalTokens > totalTokens || dispatchUsage.costUsd > currentReservation.capacity.maxCostUsd!;
    const overrun = dispatchOverrun || usage.inputTokens > invocation.allocation.inputTokens
      || usage.outputTokens > invocation.allocation.outputTokens || usage.costMicros > invocation.allocation.costMicros;
    if (!dispatchOverrun) {
      await dispatchLedger.settleChecked({ reservation, usage: dispatchUsage, admission: {
        async acquire() { assertCurrent(); return { assertCurrent() { assertCurrent(); }, release() {} }; },
      } });
    }
    assertCurrent();
    await service.reconcileInvocation(authorityId, invocationId, usage, true);
    assertCurrent();
    const observedAuthority = await service.inspect(authorityId);
    const observedInvocation = observedAuthority.invocations.find(i => i.invocationId === invocationId);
    const observedReservations = await dispatchLedger.inspectInvocation({ authorizationId: identity.id, invocationId: identity.invocationId });
    assertCurrent();
    requireDelegationV2(observedInvocation?.terminal && same(observedInvocation.usage, usage)
      && observedReservations.length === 1, "recovery_result_unconfirmed");
    const observedReservation = observedReservations[0];
    requireDelegationV2(same(reservationTuple(observedReservation), reservationTuple(reservation)), "recovery_reservation_changed");
    requireDelegationV2(dispatchOverrun ? observedReservation.state === "reserved"
      : observedReservation.state === "settled" && same(observedReservation.usage, dispatchUsage), "recovery_result_unconfirmed");
    return { status: overrun ? "held" : "settled", reason: overrun ? "usage-exceeds-reservation" : "exact-settlement",
      receipt, accounting, invocation: structuredClone(observedInvocation), reservation: structuredClone(observedReservation) };
  } finally {
    await lease.release();
  }
}
