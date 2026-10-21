import { canonicalJson } from "@kontourai/relay";
import type { createDelegationGroupControllerV2, DelegationGroupSpecV2, DelegationGroupSeatV2 } from "./delegation-group-v2.js";
import type { createDelegationAuthorityService } from "./delegation-authority-service.js";
import { DelegationContractV2Error } from "./delegation-authority-contract.js";
import { delegationEnvelopeDigestV2, rootAuthorityReferenceV2, validateDelegationAncestryV2, type DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";
import { sameMailboxIdentity, type MailboxHostValidator, type MailboxIdentity } from "./delegation-mailbox.js";

export interface DelegationGroupMailboxHost {
  /** Trusted current UTC timestamp, sampled under the fence after asynchronous live resolution. */
  now(): string;
  authenticateCaller(caller: MailboxIdentity): Promise<boolean>;
  /**
   * Serializes membership, controller custody and group/authority cancellation with
   * these checks. The host must also fence the subsequent mailbox read/commit;
   * this callback alone ends before the mailbox store uses the returned decision.
   */
  withMembershipFence<T>(groupId: string, body: () => Promise<T>): Promise<T>;
  /**
   * Resolves the authenticated live controller's own assignment and all nine exact
   * identity fields for this group/controller generation, independently of seats.
   * Controller ids and actor keys are distinct opaque host identities.
   * Must remain available for cleanup after group/authority cancellation or expiry.
   */
  resolveLiveController(spec: DelegationGroupSpecV2): Promise<{
    identity: MailboxIdentity;
    controller: DelegationGroupSpecV2["controller"];
  } | null>;
  /** Resolves actual assignment/liveness, never infers a member from a session or correlation id. */
  resolveLiveMember(spec: DelegationGroupSpecV2, seat: DelegationGroupSeatV2): Promise<{
    identity: MailboxIdentity;
    controller: DelegationGroupSpecV2["controller"];
    envelope: DelegationGroupSeatV2["envelope"];
  } | null>;
}

export function createDelegationGroupMailboxValidator(input: {
  controller: ReturnType<typeof createDelegationGroupControllerV2>;
  authority: ReturnType<typeof createDelegationAuthorityService>;
  host: DelegationGroupMailboxHost;
}): MailboxHostValidator {
  return async ({ action, caller, message }) => {
    if (!await input.host.authenticateCaller(structuredClone(caller))) return { status: "refused" };
    return input.host.withMembershipFence(caller.groupId, async () => {
      const group = await input.controller.get(caller.groupId);
      if (caller.groupId !== group.spec.groupId || caller.controllerGeneration !== group.spec.controller.generation || group.terminal === "proven") return { status: "refused" };
      const authority = await input.authority.inspect(group.spec.rootAuthorityRef.id);
      if (canonicalJson(rootAuthorityReferenceV2(authority.root)) !== canonicalJson(group.spec.rootAuthorityRef)) return { status: "refused" };
      if (action === "cancel") {
        // Cleanup revokes mailbox access; it grants no execution authority and must
        // still fence an offline journal after group/authority cancellation or expiry.
        if (message || caller.groupId !== group.spec.groupId || caller.actorKey !== caller.controllerActorKey) return { status: "refused" };
        const live = await input.host.resolveLiveController(structuredClone(group.spec));
        if (!live || canonicalJson(live.controller) !== canonicalJson(group.spec.controller)
          || !sameMailboxIdentity(live.identity, caller)) return { status: "refused" };
        return { status: "current" };
      }
      if (group.cancellation !== "none" || authority.cancelled) return { status: "refused" };
      const chains: DelegationEnvelopeV2[][] = [];
      const participants = [caller, ...(message ? [message.sender, message.recipient] : [])];
      for (const participant of participants) {
        if (participant.groupId !== group.spec.groupId || participant.controllerGeneration !== group.spec.controller.generation) return { status: "refused" };
        const seat = group.spec.seats.find((s) => s.seatId === participant.memberId);
        if (!seat) return { status: "refused" };
        const live = await input.host.resolveLiveMember(structuredClone(group.spec), structuredClone(seat));
        const envelope = authority.envelopes.find((e) => e.envelope_id === seat.envelope.id);
        if (!live || !envelope || envelope.generation !== seat.envelope.generation
          || delegationEnvelopeDigestV2(envelope) !== seat.envelope.digest
          || canonicalJson(live.controller) !== canonicalJson(group.spec.controller)
          || canonicalJson(live.envelope) !== canonicalJson(seat.envelope)
          || !sameMailboxIdentity(live.identity, participant)) return { status: "refused" };
        const chain = [envelope], seen = new Set([envelope.envelope_id]);
        while (chain[0].parent) {
          const parent = authority.envelopes.find(e => e.envelope_id === chain[0].parent!.id);
          if (!parent || seen.has(parent.envelope_id) || chain.length >= 33) return { status: "refused" };
          seen.add(parent.envelope_id); chain.unshift(parent);
        }
        chains.push(chain);
      }
      // inspect() intentionally validates historical records only. Recheck the entire
      // registered ancestry/grant binding at current time, without admitting any effect.
      try {
        const now = input.host.now();
        for (const chain of chains) validateDelegationAncestryV2(authority.root, chain, now);
      } catch (error) {
        if (error instanceof DelegationContractV2Error) return { status: "refused" };
        throw error;
      }
      return { status: "current" };
    });
  };
}
