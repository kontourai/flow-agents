import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import DefaultKnowledgeStore from "../adapters/default-store/index.js";
import { ingestRuntimeSessions } from "../promote/runtime-session.js";
import { writeCursor } from "../promote/runtime-session-cursor.js";
import { stageCreateProposalBatch } from "../promote/store-target.js";
import { detectDuplicates } from "../providers/health/index.js";
import { applyCreateProposals } from "./apply.js";
import { writeBriefs } from "./brief.js";
import { distillRuntimeResidue } from "./distiller.js";
import { acquireDreamLock, assertCompleteStoreRoot, assertContained, assertNoSymlinkAncestry, dreamError, tightenStoreFiles, writePrivateAtomic } from "./fs-safe.js";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalDigest(value) { return sha256(JSON.stringify(value)); }
function cursorBytes(cursor) { return `${JSON.stringify(cursor, null, 2)}\n`; }
function reportPath(root, runId) { return path.join(root, "dream", "reports", `${runId}.json`); }
function writeReport(root, runId, report) { const content = `${JSON.stringify(report, null, 2)}\n`; writePrivateAtomic(reportPath(root, runId), content, root); return sha256(content); }
function redactionHits(residues) { return residues.reduce((total, residue) => total + (residue.transcriptEntries || []).reduce((count, entry) => count + ((String(entry.text || "").match(/<(?:SECRET|EMAIL|HOME_PATH)>/g) || []).length), 0), 0); }

function confidenceTag(value) { const number = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5; return `confidence:${Number(number.toFixed(6)).toString()}`; }
function linkRecords(distilled) {
  const records = distilled.map(({ record, residue }) => ({
    ...record,
    tags: [...new Set([...(record.tags || []), confidenceTag(record.confidence), "source:runtime-session", "trust:unreviewed", `runtime:${residue.runtime || "unknown"}`])].sort(),
    residue,
  }));
  return { records, report: { schema_version: "1.0", records_linked: records.length, source_tag: "source:runtime-session", trust_tag: "trust:unreviewed" } };
}
function healthGraph(existing, linked) {
  const nodes = [...existing, ...linked.map((entry, index) => ({ id: `candidate:${index}:${canonicalDigest(entry.record || entry).slice(0, 16)}`, type: (entry.record || entry).type || "raw", title: (entry.record || entry).title }))];
  return { nodes, edges: [] };
}
function proposalFor(entry) {
  const { residue, ...record } = entry; const project = typeof record.project === "string" && /^[a-z0-9_-]{1,64}$/.test(record.project) ? [`project:${record.project}`] : [];
  return { schema_version: "1.0", provider: "default-store", kind: "create-node", target: { root: "personal", path: `proposals/pending/${residue.slug}/` }, status: "proposed", payload: { type: "raw", title: record.title, body: record.body, category: record.category, tags: [...new Set([...(record.tags || []), ...project])].sort(), provenance: { agent: "knowledge.dream", session_id: residue.slug, source_ids: residue.transcriptRefs || [] } }, rationale: "Bounded runtime residue distilled and linked by knowledge.dream; raw output remains unreviewed unless an explicit brief-approved tag is present.", provenance: { provider: "knowledge.dream", source: `runtime/${residue.slug}`, locator: (residue.transcriptRefs || ["runtime"])[0], retrieved_at: "1970-01-01T00:00:00.000Z", agent: "knowledge.dream" } };
}
function stageProposals(root, proposals, runId) {
  if (proposals.length === 0) return { dir: null, names: [] };
  const result = stageCreateProposalBatch({ storeRoot: root, batch: runId, proposals });
  return { dir: result.outDir, names: result.inventory.map((name) => ({ name, digest: sha256(fs.readFileSync(path.join(result.outDir, name))) })) };
}
async function activeRecords(root) { const store = new DefaultKnowledgeStore({ storeRoot: root }); const records = (await Promise.all(["raw", "compiled", "concept"].map((type) => store.listByType(type)))).flat(); tightenStoreFiles(root, records.map((record) => record.id)); return records; }
function projectsFrom(records) { return [...new Set(records.flatMap((record) => (record.tags || []).filter((tag) => /^project:[a-z0-9_-]{1,64}$/.test(tag)).map((tag) => tag.slice(8))))]; }
function foldReceipts(report, receipts = []) { report.receipts = receipts; for (const receipt of receipts) report.applies[receipt.disposition] = (report.applies[receipt.disposition] || 0) + 1; }
function foldBriefs(report, briefResult, removed = briefResult.removed || []) { report.obsolete_briefs_removed = removed; report.briefs = briefResult.map(({ name, digest, tokenCount, recordIds, written }) => ({ name, digest, token_count: tokenCount, record_ids: recordIds, written })); }

function validateOptions({ telemetryFile, transcriptRoots, storeRoot, cursorFile }) {
  if (!path.isAbsolute(storeRoot || "") || !path.isAbsolute(telemetryFile || "") || !Array.isArray(transcriptRoots) || transcriptRoots.length === 0) throw dreamError("DREAM_CONFIG_INVALID", "dream requires absolute storeRoot/telemetryFile and transcriptRoots");
  assertNoSymlinkAncestry(storeRoot, "storeRoot"); assertCompleteStoreRoot(storeRoot); assertContained(storeRoot, cursorFile, "cursor"); assertNoSymlinkAncestry(cursorFile, "cursor");
}

export async function runDream(raw = {}) {
  const now = raw.now || (() => new Date().toISOString()); const storeRoot = raw.storeRoot; const cursorFile = raw.cursorFile || path.join(storeRoot || "", "dream", "cursors", "runtime-session.cursor.json"); const applyPolicy = raw.applyPolicy || "auto";
  validateOptions({ ...raw, storeRoot, cursorFile });
  if (raw.dryRun) {
    let candidate; const ingest = ingestRuntimeSessions({ telemetryFile: raw.telemetryFile, cursorFile, transcriptRoots: raw.transcriptRoots, now, persistCursor: (_file, cursor) => { candidate = cursor; return true; } });
    if (ingest.report.blocked) throw dreamError("RUNTIME_INGEST_BLOCKED", "runtime ingest blocked");
    const distilled = []; for (const residue of ingest.residues) { const value = await distillRuntimeResidue(residue, { adapter: raw.distiller }); distilled.push(...value.records.map((record) => ({ record, residue }))); }
    const linked = linkRecords(distilled); const health = detectDuplicates(healthGraph([], linked.records), { provider: "default-store", generatedAt: now() }); const proposals = linked.records.map(proposalFor);
    return { schema_version: "1.0", status: "dry-run", dry_run: true, ingest: ingest.report, sessions: ingest.residues.length, link: linked.report, health: { report: health }, proposals: proposals.length, applies: { "dry-run": proposals.length }, receipts: [], briefs: [], cursor: candidate ? { digest: sha256(cursorBytes(candidate)), committed: false } : null };
  }

  tightenStoreFiles(storeRoot); const release = acquireDreamLock(storeRoot, "run", now); const runId = `${String(now()).replace(/[^0-9A-Za-z]/g, "")}-${randomUUID().slice(0, 8)}`; let candidate; let candidateFile = cursorFile; let report;
  try {
    const ingest = ingestRuntimeSessions({ telemetryFile: raw.telemetryFile, cursorFile, transcriptRoots: raw.transcriptRoots, now, persistCursor: (file, cursor) => { candidateFile = file; candidate = cursor; return true; } });
    report = { schema_version: "1.0", run_id: runId, status: "running", dry_run: false, ingest: ingest.report, sessions: ingest.residues.length, link: { schema_version: "1.0", records_linked: 0 }, health: { report: detectDuplicates({ nodes: [], edges: [] }, { provider: "default-store", generatedAt: now() }) }, proposals: 0, staged: [], receipts: [], applies: { created: 0, reused: 0, pending: 0 }, briefs: [], obsolete_briefs_removed: [], redaction_hits: redactionHits(ingest.residues), skipped: ingest.report.records_skipped, cursor: null };
    if (ingest.report.blocked) throw dreamError("RUNTIME_INGEST_BLOCKED", "runtime ingest blocked"); if (raw.faultAt === "ingest") throw dreamError("DREAM_FAULT", "injected ingest failure");
    if (ingest.residues.length === 0 && !candidate) {
      const records = await activeRecords(storeRoot); const briefResult = writeBriefs({ storeRoot, records, projects: projectsFrom(records), now: now(), globalBudget: raw.globalBudget, projectBudget: raw.projectBudget, faultAt: raw.faultAt });
      foldBriefs(report, briefResult); report.status = "noop"; writeReport(storeRoot, runId, report); return report;
    }
    if (ingest.residues.length === 0 && candidate) {
      const records = await activeRecords(storeRoot); const briefResult = writeBriefs({ storeRoot, records, projects: projectsFrom(records), now: now(), globalBudget: raw.globalBudget, projectBudget: raw.projectBudget, faultAt: raw.faultAt }); foldBriefs(report, briefResult);
      report.status = "success"; report.outcome = "skipped-only"; report.cursor = { digest: sha256(cursorBytes(candidate)), byte_length: Buffer.byteLength(cursorBytes(candidate)), commit_intent: true }; writeReport(storeRoot, runId, report);
      if (raw.faultAt === "cursor") throw dreamError("DREAM_FAULT", "injected cursor failure"); if (writeCursor(candidateFile, candidate) !== true) throw dreamError("CURSOR_WRITE_FAILED", "cursor writer did not confirm commit"); return report;
    }

    const distilled = []; for (const residue of ingest.residues) { const value = await distillRuntimeResidue(residue, { adapter: raw.distiller }); distilled.push(...value.records.map((record) => ({ record, residue }))); }
    if (raw.faultAt === "distill") throw dreamError("DREAM_FAULT", "injected distill failure");
    const linked = linkRecords(distilled); report.link = linked.report; if (raw.faultAt === "link") throw dreamError("DREAM_FAULT", "injected link failure");
    const before = await activeRecords(storeRoot); report.health = { report: detectDuplicates(healthGraph(before, linked.records), { provider: "default-store", generatedAt: now() }) }; if (raw.faultAt === "health") throw dreamError("DREAM_FAULT", "injected health failure");
    const proposals = linked.records.map(proposalFor); report.proposals = proposals.length; const staged = stageProposals(storeRoot, proposals, runId); report.staged = staged.names;
    if (raw.faultAt === "proposal") throw dreamError("DREAM_FAULT", "injected proposal failure");
    if (proposals.length) { const applyFault = raw.faultAt?.startsWith("create:") || raw.faultAt?.startsWith("receipt:") ? raw.faultAt : raw.faultAt === "create" ? "create:0" : undefined; const applied = await applyCreateProposals({ storeRoot, proposals, policy: applyPolicy, faultAt: applyFault, now }); foldReceipts(report, applied.receipts); }
    const records = await activeRecords(storeRoot); if (raw.faultAt === "brief") throw dreamError("DREAM_FAULT", "injected brief failure");
    const briefResult = writeBriefs({ storeRoot, records, projects: projectsFrom(records), now: now(), globalBudget: raw.globalBudget, projectBudget: raw.projectBudget, faultAt: raw.faultAt }); foldBriefs(report, briefResult);
    if (raw.faultAt === "report") throw dreamError("DREAM_FAULT", "injected report failure");
    report.status = "success"; report.cursor = candidate ? { digest: sha256(cursorBytes(candidate)), byte_length: Buffer.byteLength(cursorBytes(candidate)), commit_intent: true } : null; writeReport(storeRoot, runId, report);
    if (raw.faultAt === "cursor") throw dreamError("DREAM_FAULT", "injected cursor failure");
    if (candidate && writeCursor(candidateFile, candidate) !== true) throw dreamError("CURSOR_WRITE_FAILED", "cursor writer did not confirm commit");
    return report;
  } catch (error) {
    if (error.receipts?.length) foldReceipts(report, error.receipts);
    if (error.briefs) foldBriefs(report, error.briefs, error.removed || []);
    const failure = { ...(report || { schema_version: "1.0", run_id: runId, sessions: 0, proposals: 0, applies: {}, receipts: [], briefs: [], redaction_hits: 0, skipped: 0 }), status: "failed", error: { code: error.code || "DREAM_FAILED" }, cursor: { committed: false } };
    writeReport(storeRoot, runId, failure); throw error;
  } finally { release(); }
}
