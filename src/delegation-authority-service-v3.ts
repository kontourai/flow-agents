import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "@kontourai/relay";
import { createDelegationAuthorityService, validateDelegationAuthorityLedger, type DelegationAuthorityHost, type DelegationAuthorityLedger, type DelegationAuthorityStore, type DelegationInvocation } from "./delegation-authority-service.js";
import { validateRootAuthorityV2, copyDelegationJsonV2, delegationRecordV2, delegationIdV2, delegationIntegerV2, delegationReferenceV2, requireDelegationV2, type RootAuthorityV2, type DelegationReferenceV2 } from "./delegation-authority-contract.js";
import { validateDelegationEnvelopeV2, rootAuthorityReferenceV2, type DelegationEnvelopeV2 } from "./delegation-envelope-v2.js";

export const AUTHORITY_V3_MAX_BYTES = 32 * 1024 * 1024;
export const AUTHORITY_V3_EPOCH_BYTES = 1024 * 1024;
export const AUTHORITY_V3_MAX_RENEWALS = 8;
export type AuthorityRenewalCommandV3 = {
  schemaVersion: "3.0"; authorityId: string; operationKey: string; expectedRevision: number;
  previousAuthority: ReturnType<typeof rootAuthorityReferenceV2>;
  root: RootAuthorityV2; envelopes: DelegationEnvelopeV2[]; hostReceipt: DelegationReferenceV2;
};
export type AuthorityEpochV3 = { root: RootAuthorityV2; envelopes: DelegationEnvelopeV2[];
  renewal: null | { command: Omit<AuthorityRenewalCommandV3, "root" | "envelopes">; requestDigest: string; authenticatedReceipt: DelegationReferenceV2 } };
export type DelegationAuthorityLedgerV3 = {
  schemaVersion: "3.0"; revision: number; maxRenewals: number;
  importedFromV2: null | { operationKey: string; sourceReceipt: DelegationReferenceV2; snapshot: DelegationAuthorityLedger }; epochs: AuthorityEpochV3[];
  cancelled: boolean; invocations: DelegationInvocation[]; origins: { invocationId: string; epoch: number }[];
};
export interface DelegationAuthorityStoreV3 {
  transact<T>(id: string, body: (current: DelegationAuthorityLedgerV3 | null) => Promise<{ ledger: DelegationAuthorityLedgerV3; result: T }>): Promise<T>;
}
export interface DelegationAuthorityHostV3 extends DelegationAuthorityHost {
  /** Authenticate historical usage against the original epoch's physical accounting. */
  confirmHistoricalReconciliation?(invocation: DelegationInvocation, root: RootAuthorityV2, envelope: DelegationEnvelopeV2): Promise<boolean>;
  /** Host must revoke old v2 writer custody and supply its actual locked snapshot, not caller-prepared bytes. */
  withV2Transfer?<T>(authorityId: string, externalReceipt: DelegationReferenceV2, body: (snapshot: DelegationAuthorityLedger) => Promise<T>): Promise<T>;
  /** Authenticate a real external grant/source registry receipt over this exact successor and current custody.
   * A caller-prepared hash alone is not authority. */
  authenticateRenewal(input: { action: "renew" | "replay"; current: DelegationAuthorityLedgerV3; command: AuthorityRenewalCommandV3 }): Promise<DelegationReferenceV2 | null>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function stableRoot(root: RootAuthorityV2): unknown {
  const { source_origin, execution_grants: _grants, authority_epoch: _epoch, ...stable } = root;
  return { ...stable, source_origin: { repository_id: source_origin.repository_id, worktree_id: source_origin.worktree_id } };
}
function stableEnvelope(envelope: DelegationEnvelopeV2): unknown {
  const { root_authority_ref: _root, execution_binding: _binding, parent: _parent, ...stable } = envelope;
  return { ...stable, parentId: envelope.parent?.id ?? null };
}
function renewal(value: unknown): AuthorityRenewalCommandV3 {
  const r = delegationRecordV2(copyDelegationJsonV2(value), ["schemaVersion", "authorityId", "operationKey", "expectedRevision", "previousAuthority", "root", "envelopes", "hostReceipt"]);
  requireDelegationV2(r.schemaVersion === "3.0", "renewal_schema"); delegationIdV2(r.authorityId); delegationIdV2(r.operationKey); delegationIntegerV2(r.expectedRevision);
  r.root = validateRootAuthorityV2(r.root); delegationReferenceV2(r.hostReceipt);
  requireDelegationV2(Array.isArray(r.envelopes) && r.envelopes.length > 0, "renewal_envelopes_required");
  r.envelopes = r.envelopes.map(validateDelegationEnvelopeV2); return r as AuthorityRenewalCommandV3;
}
function validateTransition(previous: AuthorityEpochV3, next: AuthorityEpochV3) {
  const c = next.renewal?.command; requireDelegationV2(c, "renewal_proof_required");
  requireDelegationV2(same(stableRoot(previous.root), stableRoot(next.root)) && next.root.authority_epoch === previous.root.authority_epoch + 1
    && same(c.previousAuthority, rootAuthorityReferenceV2(previous.root)) && c.authorityId === previous.root.authority_id, "renewal_root_lineage_conflict");
  requireDelegationV2(next.envelopes.length === previous.envelopes.length
    && same(previous.root.execution_grants.map(g => [g.grant_id, g.authority_ceiling, g.flow_binding, g.source.repository_id, g.source.execution_worktree_id, g.runtime.required_capabilities]), next.root.execution_grants.map(g => [g.grant_id, g.authority_ceiling, g.flow_binding, g.source.repository_id, g.source.execution_worktree_id, g.runtime.required_capabilities])), "renewal_membership_or_authority_change");
  for (const [i, envelope] of next.envelopes.entries()) requireDelegationV2(same(stableEnvelope(previous.envelopes[i]), stableEnvelope(envelope)), "renewal_envelope_lineage_conflict");
  requireDelegationV2(next.renewal!.requestDigest === renewalDigest({ ...c, root: next.root, envelopes: next.envelopes })
    && same(c.hostReceipt, next.renewal!.authenticatedReceipt), "renewal_receipt_conflict");
}
export function validateDelegationAuthorityLedgerV3(value: DelegationAuthorityLedgerV3): DelegationAuthorityLedgerV3 {
  delegationRecordV2(value, ["schemaVersion", "revision", "maxRenewals", "epochs", "cancelled", "invocations", "origins", "importedFromV2"]);
  requireDelegationV2(value.schemaVersion === "3.0", "authority_v3_schema"); delegationIntegerV2(value.revision); delegationIntegerV2(value.maxRenewals, AUTHORITY_V3_MAX_RENEWALS);
  requireDelegationV2(Array.isArray(value.epochs) && value.epochs.length > 0 && value.epochs.length <= value.maxRenewals + 1, "renewal_capacity");
  for (const invocation of value.invocations) delegationRecordV2(invocation, ["invocationId", "envelopeId", "allocation", "usage", "terminal"]);
  if (value.importedFromV2) {
    delegationRecordV2(value.importedFromV2, ["operationKey", "sourceReceipt", "snapshot"]); delegationIdV2(value.importedFromV2.operationKey); delegationReferenceV2(value.importedFromV2.sourceReceipt);
    const snapshot = validateDelegationAuthorityLedger(value.importedFromV2.snapshot);
    requireDelegationV2(same(snapshot.root, value.epochs[0].root) && same(snapshot.envelopes, value.epochs[0].envelopes)
      && (!snapshot.cancelled || value.cancelled), "import_lineage_conflict");
    for (const old of snapshot.invocations) {
      const current = value.invocations.find(i => i.invocationId === old.invocationId);
      requireDelegationV2(current && current.envelopeId === old.envelopeId && same(current.allocation, old.allocation)
        && (!old.terminal || current.terminal) && (!old.usage || same(old.usage, current.usage)), "import_accounting_conflict");
    }
  }
  const operations = new Set<string>();
  for (const [i, epoch] of value.epochs.entries()) {
    delegationRecordV2(epoch, ["root", "envelopes", "renewal"]);
    validateDelegationAuthorityLedger({ root: epoch.root, envelopes: epoch.envelopes, cancelled: value.cancelled, invocations: value.invocations });
    requireDelegationV2(Buffer.byteLength(canonicalJson(epoch)) <= AUTHORITY_V3_EPOCH_BYTES, "authority_epoch_full");
    if (i === 0) requireDelegationV2(epoch.renewal === null, "initial_epoch_renewal_forbidden");
    else {
      requireDelegationV2(epoch.renewal, "renewal_proof_required"); renewal({ ...epoch.renewal.command, root: epoch.root, envelopes: epoch.envelopes });
      delegationReferenceV2(epoch.renewal.authenticatedReceipt); validateTransition(value.epochs[i - 1], epoch);
      requireDelegationV2(!operations.has(epoch.renewal.command.operationKey), "renewal_operation_reused"); operations.add(epoch.renewal.command.operationKey);
    }
  }
  requireDelegationV2(Array.isArray(value.origins) && value.origins.length === value.invocations.length, "invocation_origin_missing");
  for (const origin of value.origins) {
    delegationRecordV2(origin, ["invocationId", "epoch"]); delegationIntegerV2(origin.epoch, value.epochs.length - 1);
    requireDelegationV2(value.invocations.some(i => i.invocationId === origin.invocationId), "invocation_origin_missing");
  }
  requireDelegationV2(new Set(value.origins.map(i => i.invocationId)).size === value.origins.length, "invocation_origin_conflict");
  return value;
}
export function authorityCapacityV3(value: DelegationAuthorityLedgerV3): number {
  return (value.maxRenewals + 1 - value.epochs.length) * AUTHORITY_V3_EPOCH_BYTES
    + Math.max(0, Math.min(4096, value.epochs[0].root.budget.max_attempts) - value.invocations.length) * 2048 + value.invocations.filter(i => i.usage === null).length * 256;
}
export function createDelegationAuthorityServiceV3(store: DelegationAuthorityStoreV3, host: DelegationAuthorityHostV3, options: { maxRenewals: number }) {
  delegationIntegerV2(options.maxRenewals, AUTHORITY_V3_MAX_RENEWALS);
  const scope = new AsyncLocalStorage<DelegationAuthorityLedgerV3>();
  const adapter: DelegationAuthorityStore = { async transact(id, body) {
    return store.transact(id, async current => {
      if (current) validateDelegationAuthorityLedgerV3(current);
      const epoch = current?.epochs.at(-1);
      const materialized = epoch && current ? { root: structuredClone(epoch.root), envelopes: structuredClone(epoch.envelopes), cancelled: current.cancelled, invocations: structuredClone(current.invocations) } : null;
      const next = await (current ? scope.run(current, () => body(materialized)) : body(null));
      const ledger: DelegationAuthorityLedgerV3 = current ?? { schemaVersion: "3.0", revision: 0, maxRenewals: options.maxRenewals,
        epochs: [{ root: next.ledger.root, envelopes: [], renewal: null }], cancelled: false, invocations: [], origins: [], importedFromV2: null };
      const prior = canonicalJson(ledger), last = ledger.epochs.at(-1)!;
      requireDelegationV2(same(last.root, next.ledger.root), "immutable_authority_required");
      requireDelegationV2(ledger.epochs.length === 1 || same(last.envelopes, next.ledger.envelopes), "renewal_roster_frozen");
      for (const invocation of next.ledger.invocations) if (!ledger.origins.some(o => o.invocationId === invocation.invocationId)) ledger.origins.push({ invocationId: invocation.invocationId, epoch: ledger.epochs.length - 1 });
      last.envelopes = next.ledger.envelopes; ledger.cancelled = next.ledger.cancelled; ledger.invocations = next.ledger.invocations;
      if (!current || prior !== canonicalJson(ledger)) ledger.revision++;
      validateDelegationAuthorityLedgerV3(ledger); return { ledger, result: next.result };
    });
  } };
  const base = createDelegationAuthorityService(adapter, {
    now: () => host.now(), authorize: (...args) => host.authorize(...args), confirmExecution: (...args) => host.confirmExecution(...args),
    async confirmReconciliation(invocation, root) {
      const ledger = scope.getStore(), origin = ledger?.origins.find(o => o.invocationId === invocation.invocationId);
      if (origin && ledger) {
        const epoch = ledger.epochs[origin.epoch], envelope = epoch.envelopes.find(e => e.envelope_id === invocation.envelopeId)!;
        if (origin.epoch === ledger.epochs.length - 1) return await host.confirmReconciliation?.(invocation, root) === true;
        return await host.confirmHistoricalReconciliation?.(invocation, structuredClone(epoch.root), structuredClone(envelope)) === true;
      }
      return false;
    },
  });
  return {
    ...base,
    async importV2(id: string, operationKey: string, externalReceipt: DelegationReferenceV2) {
      delegationIdV2(id); delegationIdV2(operationKey); delegationReferenceV2(externalReceipt);
      requireDelegationV2(host.withV2Transfer, "v2_transfer_host_required");
      return host.withV2Transfer(id, structuredClone(externalReceipt), async snapshot => {
        validateDelegationAuthorityLedger(snapshot); requireDelegationV2(snapshot.root.authority_id === id, "authority_identity_conflict");
        return store.transact(id, async current => {
          if (current) {
            requireDelegationV2(current.importedFromV2?.operationKey === operationKey && same(current.importedFromV2.sourceReceipt, externalReceipt)
              && same(current.importedFromV2.snapshot, snapshot), "v2_transfer_intent_conflict");
            return { ledger: current, result: { replayed: true } };
          }
          const ledger: DelegationAuthorityLedgerV3 = { schemaVersion: "3.0", revision: 1, maxRenewals: options.maxRenewals,
            epochs: [{ root: snapshot.root, envelopes: snapshot.envelopes, renewal: null }], cancelled: snapshot.cancelled,
            invocations: snapshot.invocations, origins: snapshot.invocations.map(i => ({ invocationId: i.invocationId, epoch: 0 })),
            importedFromV2: { operationKey, sourceReceipt: externalReceipt, snapshot: structuredClone(snapshot) } };
          validateDelegationAuthorityLedgerV3(ledger); return { ledger, result: { replayed: false } };
        });
      });
    },
    async inspect(id: string) {
      await base.inspect(id);
      return store.transact(id, async ledger => {
        requireDelegationV2(ledger, "authority_missing"); validateDelegationAuthorityLedgerV3(ledger);
        const epoch = ledger.epochs.at(-1)!;
        requireDelegationV2(await host.authorize("inspect", structuredClone(epoch.root), null), "host_authorization_refused");
        return { ledger, result: { root: structuredClone(epoch.root), envelopes: structuredClone(epoch.envelopes),
          cancelled: ledger.cancelled, invocations: structuredClone(ledger.invocations), lineageRoot: structuredClone(ledger.epochs[0].root),
          revision: ledger.revision, epochs: structuredClone(ledger.epochs), origins: structuredClone(ledger.origins) } };
      });
    },
    async renew(value: unknown) {
      const c = renewal(value);
      return store.transact(c.authorityId, async ledger => {
        requireDelegationV2(ledger, "authority_missing"); validateDelegationAuthorityLedgerV3(ledger);
        const old = ledger.epochs.find(e => e.renewal?.command.operationKey === c.operationKey);
        const receipt = await host.authenticateRenewal({ action: old ? "replay" : "renew", current: structuredClone(ledger), command: structuredClone(c) });
        requireDelegationV2(receipt && same(receipt, c.hostReceipt), "renewal_host_receipt_unconfirmed"); delegationReferenceV2(receipt);
        if (old) { requireDelegationV2(old.renewal!.requestDigest === renewalDigest(c), "renewal_intent_conflict"); return { ledger, result: { replayed: true, epoch: structuredClone(old) } }; }
        requireDelegationV2(!ledger.cancelled && ledger.revision === c.expectedRevision && ledger.epochs.length <= ledger.maxRenewals, "renewal_admission_conflict");
        const { root: successorRoot, envelopes: successorEnvelopes, ...header } = c;
        const next: AuthorityEpochV3 = { root: successorRoot, envelopes: successorEnvelopes,
          renewal: { command: header, requestDigest: renewalDigest(c), authenticatedReceipt: receipt } };
        validateTransition(ledger.epochs.at(-1)!, next);
        requireDelegationV2(host.now() < next.root.budget.expires_at, "authority_inactive");
        for (const envelope of next.envelopes) requireDelegationV2(await host.confirmExecution(structuredClone(envelope), structuredClone(next.root)), "execution_binding_unconfirmed");
        requireDelegationV2(host.now() < next.root.budget.expires_at, "authority_inactive");
        const currentReceipt = await host.authenticateRenewal({ action: "renew", current: structuredClone(ledger), command: structuredClone(c) });
        requireDelegationV2(currentReceipt && same(currentReceipt, receipt), "renewal_host_receipt_unconfirmed");
        ledger.epochs.push(next); ledger.revision++; validateDelegationAuthorityLedgerV3(ledger);
        return { ledger, result: { replayed: false, epoch: structuredClone(next) } };
      });
    },
  };
}


export function authorityLineageReference(ledger: { root: RootAuthorityV2; lineageRoot?: RootAuthorityV2 }) {
  return rootAuthorityReferenceV2(ledger.lineageRoot ?? ledger.root);
}

function renewalDigest(command: AuthorityRenewalCommandV3): string {
  return `sha256:${createHash("sha256").update(canonicalJson(command)).digest("hex")}`;
}
