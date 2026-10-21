import { canonicalJson, type ModelRuntime } from "@kontourai/relay";
import { rootAuthorityReferenceV2, delegationEnvelopeDigestV2, type DelegationEnvelopeV2, type RootAuthorityReferenceV2 } from "./delegation-envelope-v2.js";
import { delegationRecordV2, delegationIdV2, delegationIntegerV2, delegationReferenceV2, delegationDigestV2, requireDelegationV2, type DelegationReferenceV2 } from "./delegation-authority-contract.js";
import type { DelegationExecutionHost } from "./delegation-execution.js";
import type { DelegationRoundsHost, DelegationRoundsSpec, DelegationRoundsProjection } from "./delegation-group-rounds.js";
import { createDelegationAuthorityService } from "./delegation-authority-service.js";

/** Authenticated host/session-registry identity, never a boolean or a model assertion. */
export type DelegationRecipientIdentity = {
  hostId: string; recipientId: string; generation: number; executionId: string;
  authority: RootAuthorityReferenceV2; envelope: { id: string; digest: string };
  runtimeReceipt: DelegationReferenceV2; modelReceipt: DelegationReferenceV2; sessionReceipt: DelegationReferenceV2;
};
export type ResolvedDelegationRecipient = {
  identity: DelegationRecipientIdentity; runtime: ModelRuntime;
  retainResult: DelegationExecutionHost["retainResult"]; retainFailure: DelegationExecutionHost["retainFailure"];
  invokeFenced: DelegationExecutionHost["invokeFenced"];
};
export function validateRecipientIdentity(identity: DelegationRecipientIdentity): void {
  delegationRecordV2(identity, ["hostId", "recipientId", "generation", "executionId", "authority", "envelope", "runtimeReceipt", "modelReceipt", "sessionReceipt"]);
  for (const id of [identity.hostId, identity.recipientId, identity.executionId]) delegationIdV2(id);
  delegationIntegerV2(identity.generation);
  delegationRecordV2(identity.authority, ["id", "digest", "authority_epoch"]); delegationIdV2(identity.authority.id); delegationDigestV2(identity.authority.digest); delegationIntegerV2(identity.authority.authority_epoch);
  delegationRecordV2(identity.envelope, ["id", "digest"]); delegationIdV2(identity.envelope.id); delegationDigestV2(identity.envelope.digest);
  [identity.runtimeReceipt, identity.modelReceipt, identity.sessionReceipt].forEach(delegationReferenceV2);
}
export async function bindRoundsRecipient(input: {
  spec: DelegationRoundsSpec; seatId: string; envelope: DelegationEnvelopeV2; host: DelegationRoundsHost;
  service: ReturnType<typeof createDelegationAuthorityService>;
  expected?: DelegationRecipientIdentity;
}): Promise<{ identity: DelegationRecipientIdentity; executionHost: DelegationExecutionHost }> {
  const { spec, host, envelope, seatId } = input; requireDelegationV2(host.recipient, "rounds_recipient_registry_required");
  const seat = spec.seats.find(s => s.seatId === seatId); requireDelegationV2(seat, "rounds_unauthorized_seat");
  const binding = await host.recipient.resolve(structuredClone(spec), structuredClone(seat), structuredClone(envelope));
  validateRecipientIdentity(binding.identity);
  const ledger = await input.service.inspect(spec.rootAuthorityRef.id), identity = structuredClone(binding.identity);
  requireDelegationV2(identity.hostId === ledger.root.issuer_host_id && identity.executionId === envelope.execution_id
    && canonicalJson(identity.authority) === canonicalJson(rootAuthorityReferenceV2(ledger.root))
    && identity.envelope.id === envelope.envelope_id && identity.envelope.digest === delegationEnvelopeDigestV2(envelope)
    && canonicalJson(identity.runtimeReceipt) === canonicalJson(envelope.execution_binding.runtime.runtime_receipt_ref)
    && canonicalJson(identity.modelReceipt) === canonicalJson(envelope.execution_binding.runtime.model_receipt_ref), "rounds_recipient_binding");
  if (input.expected) requireDelegationV2(canonicalJson(input.expected) === canonicalJson(identity), "rounds_recipient_changed_fresh_ack_required");
  return { identity, executionHost: {
    resolveRuntime: async () => ({ runtime: binding.runtime, runtimeReceipt: identity.runtimeReceipt, modelReceipt: identity.modelReceipt }),
    retainResult: (r, e, id) => binding.retainResult(r, e, id), retainFailure: (error, e, id) => binding.retainFailure(error, e, id),
    async invokeFenced(e, id, launch) {
      const current = await host.recipient!.resolve(structuredClone(spec), structuredClone(seat), structuredClone(e));
      validateRecipientIdentity(current.identity);
      requireDelegationV2(canonicalJson(current.identity) === canonicalJson(identity), "rounds_recipient_changed_fresh_ack_required");
      return binding.invokeFenced(e, id, launch);
    },
  } };
}
export async function assertSyncedRecipient(p: DelegationRoundsProjection, syncKey: string, host: DelegationRoundsHost, service: ReturnType<typeof createDelegationAuthorityService>) {
  const exchange = p.continuations.find(r => r.command.operationKey === syncKey);
  requireDelegationV2(exchange?.command.kind === "sync" && exchange.receipt?.acknowledged && exchange.prepared, "rounds_sync_recipient_required");
  const command = exchange.command;
  const originalSeat = p.spec.seats.find(s => s.seatId === command.seatId)!;
  const seat = { ...originalSeat, envelope: p.grants.envelopes.find(e => e.seatId === command.seatId)!.envelope };
  const spec = { ...p.spec, rootAuthorityRef: p.grants.authority, seats: p.spec.seats.map(s => ({ ...s, envelope: p.grants.envelopes.find(e => e.seatId === s.seatId)!.envelope })) };
  const { envelope } = await service.admitEffect(p.spec.rootAuthorityRef.id, seat.envelope.id, seat.effect);
  return bindRoundsRecipient({ spec, seatId: seat.seatId, envelope, host, service, expected: exchange.prepared.recipient });
}
