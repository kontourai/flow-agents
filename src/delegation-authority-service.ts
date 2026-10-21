import { canonicalJson } from "@kontourai/relay";
import {
  validateRootAuthorityV2, rootAuthorityDigestV2, delegationIdV2,
  type RootAuthorityV2, type DelegationBudgetV2,
} from "./delegation-authority-contract.js";
import {
  validateDelegationAncestryV2, validateDelegationEnvelopeV2, delegationEnvelopeDigestV2,
  type DelegationEnvelopeV2,
} from "./delegation-envelope-v2.js";

export interface DelegationAuthorityLedger {
  root: RootAuthorityV2;
  envelopes: DelegationEnvelopeV2[];
  cancelled: boolean;
}
/** Host-protected storage: serialized callback and durable commit precede return. */
export interface DelegationAuthorityStore {
  transact<T>(authorityId: string, body: (current: DelegationAuthorityLedger | null) => Promise<{
    ledger: DelegationAuthorityLedger; result: T;
  }>): Promise<T>;
}
/** Authenticated host boundary; no caller-supplied reference authenticates itself. */
export interface DelegationAuthorityHost {
  now(): string;
  authorize(action: "issue" | "derive" | "inspect" | "cancel" | "effect", root: RootAuthorityV2, envelope: DelegationEnvelopeV2 | null): Promise<boolean>;
  /** Confirms exact grant runtime/source/assignment and current revocation, not merely existence. */
  confirmExecution(envelope: DelegationEnvelopeV2, root: RootAuthorityV2): Promise<boolean>;
}
export class DelegationAdmissionError extends Error {
  constructor(readonly code: string) { super(`Delegation admission refused: ${code}`); this.name = "DelegationAdmissionError"; }
}
const capacityKeys = ["max_attempts", "max_input_tokens", "max_output_tokens", "max_cost_micros", "max_total_envelopes"] as const;
function requireAdmission(value: unknown, code: string): asserts value {
  if (!value) throw new DelegationAdmissionError(code);
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function ancestry(ledger: DelegationAuthorityLedger, leaf: DelegationEnvelopeV2, now: string): DelegationEnvelopeV2[] {
  const chain = [leaf];
  const seen = new Set([leaf.envelope_id]);
  while (chain[0].parent) {
    const parent = ledger.envelopes.find((e) => e.envelope_id === chain[0].parent!.id);
    requireAdmission(parent && !seen.has(parent.envelope_id) && chain.length < 33, "missing_or_cyclic_ancestry");
    seen.add(parent.envelope_id); chain.unshift(parent);
  }
  return validateDelegationAncestryV2(ledger.root, chain, now);
}
function remaining(ledger: DelegationAuthorityLedger, envelope: DelegationEnvelopeV2): DelegationBudgetV2 {
  const budget = { ...envelope.budget };
  const children = ledger.envelopes.filter((e) => e.parent?.id === envelope.envelope_id);
  for (const key of capacityKeys) {
    const allocated = children.reduce((sum, child) => sum + child.budget[key], 0);
    requireAdmission(Number.isSafeInteger(allocated) && allocated <= budget[key], "aggregate_allocation_exhausted");
    budget[key] -= allocated;
  }
  // The node itself always occupies one lifetime envelope slot.
  requireAdmission(budget.max_total_envelopes >= 1, "aggregate_envelope_exhausted");
  requireAdmission(children.length <= envelope.budget.max_total_children, "lifetime_children_exhausted");
  budget.max_total_children -= children.length;
  return budget;
}
function validateLedger(value: DelegationAuthorityLedger): DelegationAuthorityLedger {
  const root = validateRootAuthorityV2(value.root);
  requireAdmission(typeof value.cancelled === "boolean" && Array.isArray(value.envelopes)
    && value.envelopes.length <= root.budget.max_total_envelopes, "invalid_authority_ledger");
  const envelopes = value.envelopes.map(validateDelegationEnvelopeV2);
  const ledger = { root, envelopes, cancelled: value.cancelled };
  for (const key of ["envelope_id", "execution_id", "span_id"] as const) {
    requireAdmission(new Set(envelopes.map((e) => e[key])).size === envelopes.length, "duplicate_execution_identity");
  }
  requireAdmission(envelopes.filter((e) => e.parent === null).length <= 1, "duplicate_root_envelope");
  for (const envelope of envelopes) {
    // Historical validity is structural; current expiry is checked at each admission/effect.
    ancestry(ledger, envelope, "0000-01-01T00:00:00.000Z");
    remaining(ledger, envelope);
  }
  return ledger;
}

export function createDelegationAuthorityService(store: DelegationAuthorityStore, host: DelegationAuthorityHost) {
  async function authorized(action: Parameters<DelegationAuthorityHost["authorize"]>[0], ledger: DelegationAuthorityLedger, envelope: DelegationEnvelopeV2 | null) {
    requireAdmission(await host.authorize(action, structuredClone(ledger.root), envelope && structuredClone(envelope)), "host_authorization_refused");
  }
  return {
    async issue(rootValue: unknown): Promise<string> {
      const root = validateRootAuthorityV2(rootValue);
      return store.transact(root.authority_id, async (current) => {
        const ledger = current ? validateLedger(current) : { root, envelopes: [], cancelled: false };
        await authorized("issue", ledger, null);
        requireAdmission(same(root, ledger.root), "authority_identity_conflict");
        requireAdmission(!ledger.cancelled && host.now() < root.budget.expires_at, "authority_inactive");
        return { ledger, result: rootAuthorityDigestV2(root) };
      });
    },
    async derive(authorityId: string, value: unknown): Promise<DelegationEnvelopeV2> {
      delegationIdV2(authorityId);
      const child = validateDelegationEnvelopeV2(value);
      return store.transact(authorityId, async (current) => {
        requireAdmission(current, "authority_missing");
        const ledger = validateLedger(current);
        await authorized("derive", ledger, child);
        requireAdmission(!ledger.cancelled, "authority_cancelled");
        ancestry(ledger, child, host.now());
        requireAdmission(await host.confirmExecution(structuredClone(child), structuredClone(ledger.root)), "execution_binding_unconfirmed");
        const previous = ledger.envelopes.find((e) => e.envelope_id === child.envelope_id);
        if (previous) requireAdmission(delegationEnvelopeDigestV2(previous) === delegationEnvelopeDigestV2(child), "envelope_identity_conflict");
        else ledger.envelopes.push(child);
        validateLedger(ledger);
        // Recheck expiry after asynchronous host admission, before durable publication.
        ancestry(ledger, child, host.now());
        return { ledger, result: structuredClone(child) };
      });
    },
    async cancel(authorityId: string): Promise<void> {
      delegationIdV2(authorityId);
      return store.transact(authorityId, async (current) => {
        requireAdmission(current, "authority_missing");
        const ledger = validateLedger(current);
        await authorized("cancel", ledger, null);
        ledger.cancelled = true;
        return { ledger, result: undefined };
      });
    },
    async inspect(authorityId: string): Promise<DelegationAuthorityLedger> {
      delegationIdV2(authorityId);
      return store.transact(authorityId, async (current) => {
        requireAdmission(current, "authority_missing");
        const ledger = validateLedger(current);
        await authorized("inspect", ledger, null);
        return { ledger, result: structuredClone(ledger) };
      });
    },
    async admitEffect(authorityId: string, envelopeId: string, effect: string): Promise<{ envelope: DelegationEnvelopeV2; availableBudget: DelegationBudgetV2 }> {
      delegationIdV2(authorityId); delegationIdV2(envelopeId); delegationIdV2(effect);
      return store.transact(authorityId, async (current) => {
        requireAdmission(current, "authority_missing");
        const ledger = validateLedger(current);
        const envelope = ledger.envelopes.find((e) => e.envelope_id === envelopeId);
        requireAdmission(envelope, "envelope_missing");
        await authorized("effect", ledger, envelope);
        requireAdmission(!ledger.cancelled && envelope.execution_authority.allowed_effects.includes(effect), "effect_refused");
        requireAdmission(await host.confirmExecution(structuredClone(envelope), structuredClone(ledger.root)), "execution_binding_unconfirmed");
        ancestry(ledger, envelope, host.now());
        return { ledger, result: { envelope: structuredClone(envelope), availableBudget: remaining(ledger, envelope) } };
      });
    },
  };
}
