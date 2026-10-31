import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import {
  KNOWLEDGE_LEARNING_LIMITS, KNOWLEDGE_LEARNING_VERSION,
  KnowledgeLearningError, assertKnowledgeLearningProposal, assertKnowledgeLearningRef, assertKnowledgeLearningScope, isKnowledgeLearningActive,
  type KnowledgeLearningAction, type KnowledgeLearningIntent, type KnowledgeLearningProjection,
  type KnowledgeLearningList, type KnowledgeLearningReceipt, type KnowledgeLearningRecord, type KnowledgeLearningRef, type KnowledgeLearningRegistry, type KnowledgeLearningScope,
} from "./knowledge-learning-contract.js";

export interface KnowledgeLearningStore {
  read(): Promise<KnowledgeLearningRegistry>;
  transact<T>(operation: (registry: KnowledgeLearningRegistry) => Promise<{ registry: KnowledgeLearningRegistry; result: T; assertCurrent(): void }>): Promise<T>;
}
/** Host functions derive authority from verified ingress; intent JSON supplies none. */
export interface KnowledgeLearningHost {
  authorize(scope: KnowledgeLearningScope, action: KnowledgeLearningAction | "read"): Promise<{ actorId: string; mayDecide: boolean; assertCurrent(): void }>;
  readEvidence(reference: KnowledgeLearningRef, scope: KnowledgeLearningScope): Promise<KnowledgeLearningRef | undefined>;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sameScope = (a: KnowledgeLearningScope, b: KnowledgeLearningScope) => a.kind === b.kind && a.id === b.id;
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const decisive = new Set<KnowledgeLearningAction>(["approve", "reject", "activate", "retire", "supersede"]);
const references = (record: KnowledgeLearningRecord) => [
  ...record.proposal.supporting, ...record.proposal.counter, ...record.proposal.conflicts, ...record.proposal.targets,
  ...(record.evaluation?.evidence ?? []), ...record.effects.map(effect => effect.evidence),
];

export function createKnowledgeLearningLifecycle(store: KnowledgeLearningStore, host: KnowledgeLearningHost) {
  async function verifyEvidence(refs: KnowledgeLearningRef[], scope: KnowledgeLearningScope) {
    if (refs.length > 256) throw new KnowledgeLearningError("capacity");
    for (const ref of refs) {
      assertKnowledgeLearningRef(ref);
      const current = await host.readEvidence(ref, scope);
      if (!current || canonicalJson(current) !== canonicalJson(ref)) throw new KnowledgeLearningError("restricted");
    }
  }
  async function get(scope: KnowledgeLearningScope, id: string): Promise<KnowledgeLearningProjection> {
    assertKnowledgeLearningScope(scope);
    if (!identifier(id)) throw new KnowledgeLearningError("invalid");
    try {
      const authority = await host.authorize(scope, "read");
      authority.assertCurrent();
      const registry = await store.read();
      const record = registry.records.find(entry => entry.id === id && sameScope(entry.proposal.scope, scope));
      authority.assertCurrent();
      if (!record) return { state: "not-found" };
      await verifyEvidence(references(record), scope);
      authority.assertCurrent();
      return { state: "available", record: structuredClone(record), receipts: registry.receipts.filter(receipt => receipt.learningId === id), active: isKnowledgeLearningActive(record) };
    } catch (error) {
      return { state: error instanceof KnowledgeLearningError && error.code === "restricted" ? "restricted" : "unavailable" };
    }
  }
  async function readSet(scope: KnowledgeLearningScope, activeOnly: boolean): Promise<KnowledgeLearningList> {
    assertKnowledgeLearningScope(scope);
    try {
      const authority = await host.authorize(scope, "read");
      authority.assertCurrent();
      const snapshot = await store.read();
      const records: KnowledgeLearningList["records"] = [];
      let partial = false;
      for (const record of snapshot.records.filter(entry => sameScope(entry.proposal.scope, scope) && (!activeOnly || isKnowledgeLearningActive(entry)))) {
        try {
          await verifyEvidence(references(record), scope);
          authority.assertCurrent();
          records.push({ state: "available", record: structuredClone(record), receipts: snapshot.receipts.filter(receipt => receipt.learningId === record.id), active: isKnowledgeLearningActive(record) });
        } catch { partial = true; }
      }
      authority.assertCurrent();
      return { records, coverage: partial ? "partial" : "complete" };
    } catch { return { records: [], coverage: "unavailable" }; }
  }
  return {
    get,
    list: (scope: KnowledgeLearningScope) => readSet(scope, false),
    async active(scope: KnowledgeLearningScope): Promise<{ records: KnowledgeLearningRecord[]; coverage: "complete" | "partial" | "unavailable" }> {
      const projected = await readSet(scope, true);
      return { records: projected.records.map(item => item.record), coverage: projected.coverage };
    },
    async apply(intent: KnowledgeLearningIntent): Promise<KnowledgeLearningReceipt> {
      assertKnowledgeLearningScope(intent.scope);
      if (!identifier(intent.intentId) || !identifier(intent.learningId) || !Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 0) throw new KnowledgeLearningError("invalid");
      if (!["propose", "evaluate", "approve", "reject", "activate", "observe-effect", "retire", "supersede"].includes(intent.action)) throw new KnowledgeLearningError("invalid");
      const allowed = ["intentId", "learningId", "scope", "expectedRevision", "action", ...({ propose: ["proposal"], evaluate: ["status", "evidence"], approve: ["rationale"], reject: ["rationale"], activate: [], "observe-effect": ["assessment", "evidence"], retire: ["reason"], supersede: ["replacementId", "replacementRevision"] }[intent.action])];
      if (Object.keys(intent).some(key => !allowed.includes(key)) || Buffer.byteLength(canonicalJson(intent)) > 65_536) throw new KnowledgeLearningError("invalid");
      const authority = await host.authorize(intent.scope, intent.action);
      authority.assertCurrent();
      if (!identifier(authority.actorId) || (decisive.has(intent.action) && !authority.mayDecide)) throw new KnowledgeLearningError("restricted");
      const requestDigest = digest(intent);
      return store.transact(async registry => {
        authority.assertCurrent();
        const prior = registry.receipts.find(receipt => receipt.intentId === intent.intentId);
        if (prior) {
          if (prior.requestDigest !== requestDigest || prior.actorId !== authority.actorId) throw new KnowledgeLearningError("conflict");
          return { registry, result: structuredClone(prior), assertCurrent: () => authority.assertCurrent() };
        }
        if (registry.receipts.length >= KNOWLEDGE_LEARNING_LIMITS.receipts) throw new KnowledgeLearningError("capacity");
        let record = registry.records.find(entry => entry.id === intent.learningId);
        if (record && !sameScope(record.proposal.scope, intent.scope)) throw new KnowledgeLearningError("restricted");
        if ((record?.revision ?? 0) !== intent.expectedRevision) throw new KnowledgeLearningError("stale");
        const at = new Date().toISOString();
        const receipt: KnowledgeLearningReceipt = { id: randomUUID(), intentId: intent.intentId, requestDigest, learningId: intent.learningId, revision: intent.expectedRevision + 1, action: intent.action, actorId: authority.actorId, at };
        if (intent.action === "propose") {
          assertKnowledgeLearningProposal(intent.proposal);
          if (record || !sameScope(intent.proposal.scope, intent.scope)) throw new KnowledgeLearningError("conflict");
          if (registry.records.length >= KNOWLEDGE_LEARNING_LIMITS.records) throw new KnowledgeLearningError("capacity");
          await verifyEvidence([...intent.proposal.supporting, ...intent.proposal.counter, ...intent.proposal.conflicts, ...intent.proposal.targets], intent.scope);
          record = { id: intent.learningId, revision: 1, contentRevision: digest(intent.proposal), proposal: structuredClone(intent.proposal), createdAt: at, effects: [] };
          registry.records.push(record);
        } else {
          if (!record) throw new KnowledgeLearningError("not-found");
          if (intent.action !== "retire") await verifyEvidence(references(record), intent.scope);
          if (record.retirement || record.supersededBy) throw new KnowledgeLearningError("conflict");
          switch (intent.action) {
            case "evaluate":
              if (record.decision || !["supported", "countered", "mixed", "inconclusive"].includes(intent.status) || !Array.isArray(intent.evidence) || intent.evidence.length < 1 || intent.evidence.length > KNOWLEDGE_LEARNING_LIMITS.references) throw new KnowledgeLearningError("invalid");
              await verifyEvidence(intent.evidence, intent.scope);
              record.evaluation = { status: intent.status, evidence: structuredClone(intent.evidence), receiptId: receipt.id };
              break;
            case "approve": case "reject":
              if (!record.evaluation || record.decision || typeof intent.rationale !== "string" || !intent.rationale.trim() || intent.rationale.length > 4096) throw new KnowledgeLearningError("invalid");
              record.decision = { status: intent.action === "approve" ? "approved" : "rejected", rationale: intent.rationale, receiptId: receipt.id };
              break;
            case "activate":
              if (record.decision?.status !== "approved" || record.activation) throw new KnowledgeLearningError("conflict");
              record.activation = { revision: record.contentRevision, targets: structuredClone(record.proposal.targets), receiptId: receipt.id };
              break;
            case "observe-effect":
              if (!isKnowledgeLearningActive(record) || !["supported", "countered", "unresolved"].includes(intent.assessment) || record.effects.length >= KNOWLEDGE_LEARNING_LIMITS.references) throw new KnowledgeLearningError("invalid");
              await verifyEvidence([intent.evidence], intent.scope);
              record.effects.push({ assessment: intent.assessment, evidence: structuredClone(intent.evidence), receiptId: receipt.id });
              break;
            case "retire":
              if (typeof intent.reason !== "string" || !intent.reason.trim() || intent.reason.length > 4096) throw new KnowledgeLearningError("invalid");
              record.retirement = { reason: intent.reason, receiptId: receipt.id };
              break;
            case "supersede": {
              const replacement = registry.records.find(entry => entry.id === intent.replacementId);
              if (!replacement || replacement.id === record.id || replacement.contentRevision !== intent.replacementRevision || !sameScope(replacement.proposal.scope, record.proposal.scope) || !isKnowledgeLearningActive(replacement)) throw new KnowledgeLearningError("conflict");
              await verifyEvidence(references(replacement), intent.scope);
              record.supersededBy = { id: replacement.id, revision: replacement.contentRevision, receiptId: receipt.id };
              break;
            }
          }
          record.revision = receipt.revision;
        }
        authority.assertCurrent();
        registry.receipts.push(receipt);
        return { registry, result: structuredClone(receipt), assertCurrent: () => authority.assertCurrent() };
      });
    },
  };
}

export function emptyKnowledgeLearningRegistry(): KnowledgeLearningRegistry {
  return { version: KNOWLEDGE_LEARNING_VERSION, records: [], receipts: [] };
}
