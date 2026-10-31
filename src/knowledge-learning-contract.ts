/** Knowledge Kit's lifecycle, independent of a raw record's storage status. */
export const KNOWLEDGE_LEARNING_VERSION = "knowledge.learning/v1" as const;
export const KNOWLEDGE_LEARNING_LIMITS = Object.freeze({ records: 64, receipts: 512, references: 32, bodyCharacters: 16_384, bytes: 2_097_152 });
export interface KnowledgeLearningRef { authority: string; kind: string; id: string; revision: string }
export interface KnowledgeLearningScope { kind: "project" | "agent" | "global"; id: string }
export interface KnowledgeLearningProposal {
  kind: "guideline" | "skill" | "claim" | "rule" | "evaluation";
  title: string;
  body: string;
  expectedEffect: string;
  scope: KnowledgeLearningScope;
  supporting: KnowledgeLearningRef[];
  counter: KnowledgeLearningRef[];
  conflicts: KnowledgeLearningRef[];
  targets: KnowledgeLearningRef[];
}
export type KnowledgeLearningAction = "propose" | "evaluate" | "approve" | "reject" | "activate" | "observe-effect" | "retire" | "supersede";
export interface KnowledgeLearningReceipt {
  id: string;
  intentId: string;
  requestDigest: string;
  learningId: string;
  revision: number;
  action: KnowledgeLearningAction;
  actorId: string;
  at: string;
}
export interface KnowledgeLearningRecord {
  id: string;
  revision: number;
  contentRevision: string;
  proposal: KnowledgeLearningProposal;
  createdAt: string;
  evaluation?: { status: "supported" | "countered" | "mixed" | "inconclusive"; evidence: KnowledgeLearningRef[]; receiptId: string };
  decision?: { status: "approved" | "rejected"; rationale: string; receiptId: string };
  activation?: { revision: string; targets: KnowledgeLearningRef[]; receiptId: string };
  effects: { assessment: "supported" | "countered" | "unresolved"; evidence: KnowledgeLearningRef; receiptId: string }[];
  retirement?: { reason: string; receiptId: string };
  supersededBy?: { id: string; revision: string; receiptId: string };
}
export type KnowledgeLearningIntent = {
  intentId: string;
  learningId: string;
  scope: KnowledgeLearningScope;
  expectedRevision: number;
} & (
  | { action: "propose"; proposal: KnowledgeLearningProposal }
  | { action: "evaluate"; status: NonNullable<KnowledgeLearningRecord["evaluation"]>["status"]; evidence: KnowledgeLearningRef[] }
  | { action: "approve" | "reject"; rationale: string }
  | { action: "activate" }
  | { action: "observe-effect"; assessment: "supported" | "countered" | "unresolved"; evidence: KnowledgeLearningRef }
  | { action: "retire"; reason: string }
  | { action: "supersede"; replacementId: string; replacementRevision: string }
);
export interface KnowledgeLearningRegistry {
  version: typeof KNOWLEDGE_LEARNING_VERSION;
  records: KnowledgeLearningRecord[];
  receipts: KnowledgeLearningReceipt[];
}
export type KnowledgeLearningProjection =
  | { state: "available"; record: KnowledgeLearningRecord; receipts: KnowledgeLearningReceipt[]; active: boolean }
  | { state: "not-found" | "restricted" | "unavailable" };

export interface KnowledgeLearningList {
  records: Extract<KnowledgeLearningProjection, { state: "available" }>[];
  coverage: "complete" | "partial" | "unavailable";
}

export class KnowledgeLearningError extends Error {
  constructor(readonly code: "invalid" | "restricted" | "stale" | "conflict" | "not-found" | "unavailable" | "capacity") {
    super(`Knowledge learning ${code}`);
    this.name = "KnowledgeLearningError";
  }
}

export function assertKnowledgeLearningRef(value: unknown): asserts value is KnowledgeLearningRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeLearningError("invalid");
  const entries = Object.entries(value);
  if (entries.length !== 4 || entries.some(([key, item]) => !["authority", "kind", "id", "revision"].includes(key) || typeof item !== "string" || !item.trim() || item.length > 512)) throw new KnowledgeLearningError("invalid");
}
export function assertKnowledgeLearningScope(value: unknown): asserts value is KnowledgeLearningScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeLearningError("invalid");
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2 || !["project", "agent", "global"].includes(String(scope.kind)) || typeof scope.id !== "string" || !scope.id.trim() || scope.id.length > 256) throw new KnowledgeLearningError("invalid");
}
export function assertKnowledgeLearningProposal(value: unknown): asserts value is KnowledgeLearningProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeLearningError("invalid");
  const proposal = value as Record<string, unknown>;
  const keys = ["kind", "title", "body", "expectedEffect", "scope", "supporting", "counter", "conflicts", "targets"];
  if (Object.keys(proposal).length !== keys.length || Object.keys(proposal).some(key => !keys.includes(key)) || !["guideline", "skill", "claim", "rule", "evaluation"].includes(String(proposal.kind))) throw new KnowledgeLearningError("invalid");
  for (const [key, maximum] of [["title", 240], ["body", KNOWLEDGE_LEARNING_LIMITS.bodyCharacters], ["expectedEffect", 2048]] as const) {
    const text = proposal[key];
    if (typeof text !== "string" || !text.trim() || text.length > maximum) throw new KnowledgeLearningError("invalid");
  }
  assertKnowledgeLearningScope(proposal.scope);
  for (const key of ["supporting", "counter", "conflicts", "targets"]) {
    const refs = proposal[key];
    if (!Array.isArray(refs) || refs.length > KNOWLEDGE_LEARNING_LIMITS.references || ((key === "supporting" || key === "targets") && refs.length === 0)) throw new KnowledgeLearningError("invalid");
    refs.forEach(assertKnowledgeLearningRef);
  }
}

/** Activation is an owner-issued lifecycle fact, never raw-store status. */
export function isKnowledgeLearningActive(record: KnowledgeLearningRecord): boolean {
  return record.decision?.status === "approved" && record.activation?.revision === record.contentRevision && !record.retirement && !record.supersededBy;
}
