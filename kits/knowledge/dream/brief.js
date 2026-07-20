import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertContained, assertNoSymlinkAncestry, assertRegularFile, dreamError, ensurePrivateDirectory, writePrivateAtomic } from "./fs-safe.js";

export const GLOBAL_BRIEF_BUDGET = 2048;
export const PROJECT_BRIEF_BUDGET = 512;
export function utf8TokenUpperBound(value) { return Buffer.byteLength(String(value), "utf8"); }

function confidence(record) {
  if (Number.isFinite(record.confidence) && record.confidence >= 0 && record.confidence <= 1) return record.confidence;
  const tag = (record.tags || []).find((value) => /^confidence:(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)); return tag ? Number(tag.slice(11)) : 0.5;
}
function projectOf(record) { return record.provenance?.project || record.project || (record.tags || []).find((tag) => /^project:[a-z0-9_-]{1,64}$/.test(tag))?.slice(8) || (record.category || "").match(/^project\.([a-z0-9_-]{1,64})(?:\.|$)/)?.[1] || null; }
function eligible(record) { return ["compiled", "concept"].includes(record.type) || (record.type === "raw" && (record.tags || []).includes("brief-approved")); }
function scopeMatch(record, project) { const own = projectOf(record); if (!project) return own ? 0.75 : 1; if (own === project) return 1; return own ? 0 : 0.75; }
function timestamp(record) { const n = Date.parse(record.updated_at || record.created_at || 0); return Number.isFinite(n) ? n : 0; }

export function rankRecords(records, { project, now = new Date().toISOString() } = {}) {
  const parsedNow = Date.parse(now); if (!Number.isFinite(parsedNow)) throw new Error("brief now must be an ISO timestamp");
  return records.filter((record) => eligible(record) && (record.status || "active") !== "retired" && scopeMatch(record, project) > 0).map((record) => {
    const ageDays = Math.max(0, (parsedNow - timestamp(record)) / 86_400_000); return { record, score: confidence(record) * (1 / (1 + ageDays / 30)) * scopeMatch(record, project) };
  }).sort((a, b) => b.score - a.score || timestamp(b.record) - timestamp(a.record) || String(a.record.id).localeCompare(String(b.record.id))).map(({ record }) => record);
}

function truncateUtf8(value, bytes) {
  if (bytes <= 0) return ""; let output = "";
  for (const character of String(value)) { if (utf8TokenUpperBound(output + character) > bytes) break; output += character; }
  return output;
}
function truncateWithEllipsis(value, bytes) {
  const clean = String(value); if (utf8TokenUpperBound(clean) <= bytes) return clean; const marker = "…"; const room = bytes - utf8TokenUpperBound(marker); return room >= 0 ? `${truncateUtf8(clean, room)}${marker}` : "";
}
function boundedLine(record, available) {
  const title = String(record.title || record.id).replace(/\s+/g, " ").trim(); const prefix = `- ${title}: `; const body = String(record.body || "").replace(/\s+/g, " ").trim(); const full = `${prefix}${body}\n`;
  if (utf8TokenUpperBound(full) <= available) return full;
  const suffix = "…\n"; const bodyBytes = available - utf8TokenUpperBound(prefix) - utf8TokenUpperBound(suffix);
  if (bodyBytes >= 0) return `${prefix}${truncateUtf8(body, bodyBytes)}${suffix}`;
  const titleRoom = available - utf8TokenUpperBound("- : …\n"); const boundedTitle = truncateWithEllipsis(title, titleRoom);
  if (boundedTitle) return `- ${boundedTitle}: …\n`;
  return available >= utf8TokenUpperBound("- …\n") ? "- …\n" : null;
}

export function renderBrief(records, { project, budget = project ? PROJECT_BRIEF_BUDGET : GLOBAL_BRIEF_BUDGET, now = new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("brief budget must be a positive integer");
  const heading = `# Knowledge brief${project ? ` — ${project}` : ""}\n\n`; let content = heading; const recordIds = [];
  if (utf8TokenUpperBound(heading) > budget) throw new Error("brief heading cannot fit within budget");
  for (const record of rankRecords(records, { project, now })) {
    const rendered = boundedLine(record, budget - utf8TokenUpperBound(content)); if (!rendered) continue;
    content += rendered; recordIds.push(record.id);
  }
  return { content, recordIds, tokenCount: utf8TokenUpperBound(content), digest: createHash("sha256").update(content).digest("hex") };
}

export function writeBriefs({ storeRoot, records, projects = [], now, globalBudget = GLOBAL_BRIEF_BUDGET, projectBudget = PROJECT_BRIEF_BUDGET, faultAt }) {
  if (!Array.isArray(projects) || projects.some((value) => typeof value !== "string" || value.length > 64 || !/^[a-z0-9_-]+$/.test(value))) throw new Error("brief project id must be 1-64 safe characters");
  const validProjects = [...new Set(projects)].sort();
  const specs = [{ name: "global.md", brief: renderBrief(records, { budget: globalBudget, now }) }, ...validProjects.map((project) => ({ name: `project-${project}.md`, brief: renderBrief(records, { project, budget: projectBudget, now }) }))];
  const root = path.join(storeRoot, "dream", "briefs"); ensurePrivateDirectory(root, storeRoot);
  const expected = new Set(specs.map((spec) => spec.name)); const removed = []; const outputs = [];
  try {
    for (const name of fs.readdirSync(root).sort()) {
      if (!/^project-[a-z0-9_-]+\.md$/.test(name) || expected.has(name)) continue;
      const file = path.join(root, name); assertContained(storeRoot, file, "obsolete project brief"); assertNoSymlinkAncestry(file, "obsolete project brief"); assertRegularFile(file); fs.unlinkSync(file); removed.push(name);
    }
    for (let index = 0; index < specs.length; index += 1) {
      const { name, brief } = specs[index]; outputs.push({ name, ...brief, written: writePrivateAtomic(path.join(root, name), brief.content, storeRoot) });
      if (faultAt === `brief-write:${index}`) throw dreamError("DREAM_FAULT", "injected brief write failure");
    }
  } catch (error) { error.briefs = [...outputs]; error.removed = [...removed]; throw error; }
  outputs.removed = removed; return outputs;
}
