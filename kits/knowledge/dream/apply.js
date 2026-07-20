import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import DefaultKnowledgeStore from "../adapters/default-store/index.js";
import { validateStoreCreatePayload } from "../promote/store-target.js";
import { loadSchemas } from "../providers/lib/model.js";
import { validate } from "../providers/lib/schema-validate.js";
import { acquireDreamLock, assertCompleteStoreRoot, assertNoSymlinkAncestry, assertRegularFile, dreamError, ensurePrivateDirectory, tightenStoreFiles, writePrivateAtomic } from "./fs-safe.js";

const { proposal: PROPOSAL_SCHEMA } = loadSchemas();
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function idFor(payload) { return `dream-${digest({ type: payload.type, title: payload.title, category: payload.category, provenance: payload.provenance }).slice(0, 32)}`; }
function createSemantics(value) { return canonical({ type: value.type, title: value.title, body: value.body, category: value.category, tags: [...new Set(value.tags || [])].sort(), provenance: { agent: value.provenance?.agent, ...(value.provenance?.session_id ? { session_id: value.provenance.session_id } : {}), ...(value.provenance?.source_ids?.length ? { source_ids: [...value.provenance.source_ids] } : {}), ...(value.provenance?.note ? { note: value.provenance.note } : {}) } }); }

function validateProposal(proposal, index) {
  const result = validate(proposal, PROPOSAL_SCHEMA); if (!result.valid || proposal?.kind !== "create-node") throw dreamError("DREAM_PROPOSAL_INVALID", `invalid create-node proposal ${index}`);
  validateStoreCreatePayload(proposal.payload, `dream proposal ${index}`);
}

function writeReceipt(root, receipt) {
  const dir = path.join(root, "proposals", "applied"); ensurePrivateDirectory(dir, root); const file = path.join(dir, `${receipt.proposal_digest}.json`); const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(file)) {
    assertRegularFile(file, { privateMode: true }); let existing; try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw dreamError("DREAM_RECEIPT_MISMATCH", "existing proposal receipt is malformed"); }
    if (existing.schema_version !== receipt.schema_version || existing.proposal_digest !== receipt.proposal_digest || existing.record_id !== receipt.record_id || !["created", "reused"].includes(existing.disposition)) throw dreamError("DREAM_RECEIPT_MISMATCH", "existing proposal receipt identity does not match"); return false;
  }
  return writePrivateAtomic(file, content, root);
}

export async function applyCreateProposals({ storeRoot, proposals = [], policy = "pending", dryRun = false, faultAt, now = () => new Date().toISOString() } = {}) {
  if (!path.isAbsolute(storeRoot || "")) throw dreamError("DREAM_STORE_INVALID", "storeRoot must be absolute"); assertNoSymlinkAncestry(storeRoot, "storeRoot"); assertCompleteStoreRoot(storeRoot);
  if (!["auto", "pending"].includes(policy) || !Array.isArray(proposals)) throw dreamError("DREAM_POLICY_INVALID", "invalid apply policy or proposal batch");
  proposals.forEach(validateProposal); if (proposals.length === 0) return { receipts: [] };
  if (dryRun || policy === "pending") return { receipts: proposals.map((proposal) => ({ schema_version: "1.0", proposal_digest: digest(proposal), disposition: dryRun ? "dry-run" : "pending" })) };
  const release = acquireDreamLock(storeRoot, "apply", now); const receipts = [];
  try {
    const store = new DefaultKnowledgeStore({ storeRoot }); tightenStoreFiles(storeRoot);
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index]; const proposalDigest = digest(proposal); const payload = { ...proposal.payload, tags: [...new Set(proposal.payload.tags || [])].sort(), id: idFor(proposal.payload) }; const existing = await store.get(payload.id); let disposition;
      if (existing) { if (JSON.stringify(createSemantics(existing)) !== JSON.stringify(createSemantics(payload))) throw dreamError("DREAM_SEMANTIC_COLLISION", "DREAM_SEMANTIC_COLLISION: deterministic record id has different canonical create semantics"); disposition = "reused"; }
      else { if (faultAt === `create:${index}`) throw dreamError("DREAM_FAULT", "injected create failure"); await store.create(payload); disposition = "created"; }
      tightenStoreFiles(storeRoot, [payload.id]);
      const receipt = { schema_version: "1.0", proposal_digest: proposalDigest, record_id: payload.id, disposition }; receipts.push(receipt);
      if (faultAt === `receipt:${index}`) throw dreamError("DREAM_FAULT", "injected receipt failure");
      writeReceipt(storeRoot, receipt);
    }
    await store.reindex(); tightenStoreFiles(storeRoot, receipts.map((receipt) => receipt.record_id)); return { receipts };
  } catch (error) { error.receipts = [...receipts]; throw error; }
  finally { release(); }
}
