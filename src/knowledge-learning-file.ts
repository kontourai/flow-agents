import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { atomicWriteDurableFile } from "./lib/fs.js";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import {
  KNOWLEDGE_LEARNING_LIMITS, KNOWLEDGE_LEARNING_VERSION, KnowledgeLearningError,
  assertKnowledgeLearningProposal, assertKnowledgeLearningRef,
  type KnowledgeLearningRegistry, type KnowledgeLearningRecord,
} from "./knowledge-learning-contract.js";
import { emptyKnowledgeLearningRegistry, type KnowledgeLearningStore } from "./knowledge-learning.js";

const actions = ["propose", "evaluate", "approve", "reject", "activate", "observe-effect", "retire", "supersede"];
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function fail(): never { throw new KnowledgeLearningError("unavailable"); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}

/** Retained lifecycle data is validated again; a raw record cannot mint activation. */
export function parseKnowledgeLearningRegistry(value: unknown): KnowledgeLearningRegistry {
  const registry = object(value, ["version", "records", "receipts"]);
  if (registry.version !== KNOWLEDGE_LEARNING_VERSION || !Array.isArray(registry.records) || registry.records.length > KNOWLEDGE_LEARNING_LIMITS.records || !Array.isArray(registry.receipts) || registry.receipts.length > KNOWLEDGE_LEARNING_LIMITS.receipts) fail();
  const recordIds = new Set<string>(), intentIds = new Set<string>(), receiptIds = new Set<string>();
  for (const candidate of registry.receipts) {
    const receipt = object(candidate, ["id", "intentId", "requestDigest", "learningId", "revision", "action", "actorId", "at"]);
    if (!id(receipt.id) || !id(receipt.intentId) || !id(receipt.learningId) || !id(receipt.actorId) || !sha(receipt.requestDigest) || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1 || !actions.includes(String(receipt.action)) || !date(receipt.at) || receiptIds.has(String(receipt.id)) || intentIds.has(String(receipt.intentId))) fail();
    receiptIds.add(String(receipt.id)); intentIds.add(String(receipt.intentId));
  }
  for (const candidate of registry.records) {
    const record = object(candidate, ["id", "revision", "contentRevision", "proposal", "createdAt", "evaluation", "decision", "activation", "effects", "retirement", "supersededBy"]);
    if (!id(record.id) || recordIds.has(String(record.id)) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 || !sha(record.contentRevision) || !date(record.createdAt)) fail();
    recordIds.add(String(record.id));
    assertKnowledgeLearningProposal(record.proposal);
    if (createHash("sha256").update(canonicalJson(record.proposal)).digest("hex") !== record.contentRevision) fail();
    const history = registry.receipts.filter(receipt => receipt.learningId === record.id);
    if (history.length !== record.revision || history[0]?.action !== "propose" || history.some((receipt, index) => receipt.revision !== index + 1)) fail();
    const receiptFor = (receiptId: unknown, action: string) => history.find(receipt => receipt.id === receiptId && receipt.action === action);
    const evaluations = history.filter(receipt => receipt.action === "evaluate");
    const decisions = history.filter(receipt => receipt.action === "approve" || receipt.action === "reject");
    const activations = history.filter(receipt => receipt.action === "activate");
    const effects = history.filter(receipt => receipt.action === "observe-effect");
    const retirements = history.filter(receipt => receipt.action === "retire");
    const supersessions = history.filter(receipt => receipt.action === "supersede");
    if (history.filter(receipt => receipt.action === "propose").length !== 1 || history[0].at !== record.createdAt
      || Boolean(record.evaluation) !== (evaluations.length > 0)
      || Boolean(record.decision) !== (decisions.length === 1) || decisions.length > 1
      || Boolean(record.activation) !== (activations.length === 1) || activations.length > 1
      || Boolean(record.retirement) !== (retirements.length === 1) || retirements.length > 1
      || Boolean(record.supersededBy) !== (supersessions.length === 1) || supersessions.length > 1
      || retirements.length + supersessions.length > 1) fail();
    if (decisions[0] && (!evaluations.at(-1) || evaluations.at(-1)!.revision >= decisions[0].revision)) fail();
    if (activations[0] && (!decisions[0] || decisions[0].action !== "approve" || decisions[0].revision >= activations[0].revision)) fail();
    if (effects.some(effect => !activations[0] || effect.revision <= activations[0].revision)) fail();
    if ([...retirements, ...supersessions].some(receipt => receipt.revision !== record.revision)) fail();
    if (record.evaluation !== undefined) {
      const evaluation = object(record.evaluation, ["status", "evidence", "receiptId"]);
      if (!["supported", "countered", "mixed", "inconclusive"].includes(String(evaluation.status)) || !Array.isArray(evaluation.evidence) || evaluation.evidence.length < 1 || evaluation.evidence.length > KNOWLEDGE_LEARNING_LIMITS.references || evaluation.receiptId !== evaluations.at(-1)?.id) fail();
      evaluation.evidence.forEach(assertKnowledgeLearningRef);
    }
    if (record.decision !== undefined) {
      const decision = object(record.decision, ["status", "rationale", "receiptId"]);
      if (!["approved", "rejected"].includes(String(decision.status)) || typeof decision.rationale !== "string" || !decision.rationale.trim() || decision.rationale.length > 4096 || !record.evaluation || !receiptFor(decision.receiptId, decision.status === "approved" ? "approve" : "reject")) fail();
    }
    if (record.activation !== undefined) {
      const activation = object(record.activation, ["revision", "targets", "receiptId"]);
      const decision = record.decision as KnowledgeLearningRecord["decision"];
      if (activation.revision !== record.contentRevision || canonicalJson(activation.targets) !== canonicalJson(record.proposal.targets) || decision?.status !== "approved" || !receiptFor(activation.receiptId, "activate")) fail();
    }
    if (!Array.isArray(record.effects) || record.effects.length > KNOWLEDGE_LEARNING_LIMITS.references || record.effects.length !== effects.length) fail();
    for (const [index, candidateEffect] of record.effects.entries()) {
      const effect = object(candidateEffect, ["assessment", "evidence", "receiptId"]);
      if (!["supported", "countered", "unresolved"].includes(String(effect.assessment)) || !record.activation || effect.receiptId !== effects[index].id) fail();
      assertKnowledgeLearningRef(effect.evidence);
    }
    if (record.retirement !== undefined) {
      const retirement = object(record.retirement, ["reason", "receiptId"]);
      if (typeof retirement.reason !== "string" || !retirement.reason.trim() || retirement.reason.length > 4096 || !receiptFor(retirement.receiptId, "retire")) fail();
    }
    if (record.supersededBy !== undefined) {
      const replacement = object(record.supersededBy, ["id", "revision", "receiptId"]);
      if (!id(replacement.id) || !sha(replacement.revision) || replacement.id === record.id || !receiptFor(replacement.receiptId, "supersede")) fail();
    }
  }
  if (registry.receipts.some(receipt => !recordIds.has(receipt.learningId))) fail();
  return value as KnowledgeLearningRegistry;
}

/** Host-owned private state, separate from worker-writable source records. */
export function createLocalFileKnowledgeLearningStore(privateRoot: string): KnowledgeLearningStore {
  const root = path.resolve(privateRoot), uid = process.getuid?.();
  const anchor = fs.lstatSync(root);
  const storage = path.join(root, "knowledge-learning"), file = path.join(storage, "registry.json");
  function directory(target: string) {
    const stat = fs.lstatSync(target);
    if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) fail();
    if (target === root && (stat.dev !== anchor.dev || stat.ino !== anchor.ino)) fail();
  }
  directory(root);
  function read(): KnowledgeLearningRegistry {
    directory(root);
    let descriptor: number;
    try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyKnowledgeLearningRegistry(); throw error; }
    try {
      directory(storage);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > KNOWLEDGE_LEARNING_LIMITS.bytes) fail();
      return parseKnowledgeLearningRegistry(JSON.parse(fs.readFileSync(descriptor, "utf8")));
    } finally { fs.closeSync(descriptor); }
  }
  return {
    read: async () => read(),
    async transact(operation) {
      directory(root);
      try { fs.mkdirSync(storage, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      directory(storage);
      const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(parent);
        if (current.dev !== anchor.dev || current.ino !== anchor.ino) fail();
        fs.fsyncSync(parent);
      } finally { fs.closeSync(parent); }
      return withSubjectLockAsync(storage, "knowledge-learning-registry", async () => {
        const previous = read();
        const next = await operation(structuredClone(previous));
        parseKnowledgeLearningRegistry(next.registry);
        const bytes = `${canonicalJson(next.registry)}\n`;
        if (Buffer.byteLength(bytes) > KNOWLEDGE_LEARNING_LIMITS.bytes) throw new KnowledgeLearningError("capacity");
        directory(root); directory(storage);
        next.assertCurrent();
        atomicWriteDurableFile(root, file, bytes, true);
        return next.result;
      });
    },
  };
}
