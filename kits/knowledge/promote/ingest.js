/**
 * Step 1 — INGEST.
 *
 * Read a completed session directory (read-only) and collect its durable
 * residue: the plan / Definition Of Done, verification evidence, review
 * critique, learning records, and delegate transcripts. Ingest never mutates
 * the session and never reads outside `sessionDir`.
 *
 * @module promote/ingest
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readIfExists, markdownSection, parseDecisionList } from "./lib.js";

function readJson(file) {
  const raw = readIfExists(file);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function findSessionMarkdown(sessionDir, slug) {
  // Prefer the deliver session file, then plan-work, then any <slug>--*.md.
  const preferred = [`${slug}--deliver.md`, `${slug}--plan-work.md`];
  for (const name of preferred) {
    const p = path.join(sessionDir, name);
    if (fs.existsSync(p)) return p;
  }
  let names = [];
  try { names = fs.readdirSync(sessionDir); } catch { return null; }
  const md = names.find((n) => n.endsWith(".md") && n.startsWith(`${slug}--`)) || names.find((n) => n.endsWith(".md"));
  return md ? path.join(sessionDir, md) : null;
}

function collectTranscriptRefs(sessionDir) {
  const agentsDir = path.join(sessionDir, "agents");
  const refs = [];
  let agents = [];
  try { agents = fs.readdirSync(agentsDir); } catch { return refs; }
  for (const agent of agents) {
    const events = path.join(agentsDir, agent, "events.jsonl");
    if (fs.existsSync(events)) refs.push(path.join("agents", agent, "events.jsonl"));
  }
  return refs.sort();
}

/**
 * @param {string} sessionDir absolute path to a completed session directory.
 * @param {object} [options]
 * @param {string} [options.slug] override the derived slug.
 * @returns residue object consumed by distill/link/health.
 */
export function ingestSession(sessionDir, options = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    throw new Error(`ingestSession: session directory not found: ${sessionDir}`);
  }
  const state = readJson(path.join(sessionDir, "state.json")) || {};
  const slug = options.slug || state.task_slug || path.basename(sessionDir);
  const repo = state.repo || null;

  const mdPath = findSessionMarkdown(sessionDir, slug);
  const md = mdPath ? readIfExists(mdPath) : "";
  const planSummary = markdownSection(md, "Plan");
  const definitionOfDone = markdownSection(md, "Definition Of Done");
  const decisionsSection = markdownSection(md, "Decisions");

  const learning = readJson(path.join(sessionDir, "learning.json")) || {};
  const learnings = Array.isArray(learning.records) ? learning.records : [];

  const acceptance = readJson(path.join(sessionDir, "acceptance.json"));
  const critique = readJson(path.join(sessionDir, "critique.json"));

  // Structured decisions: explicit `## Decisions` list first, else derive one
  // durable decision from the Definition Of Done outcome so a delivered session
  // always yields at least one candidate delta (the operator refines the draft).
  let decisions = parseDecisionList(decisionsSection);
  if (decisions.length === 0 && definitionOfDone) {
    const outcome = definitionOfDone.match(/User outcome:\*\*\s*(.+?)\s*$/im);
    if (outcome) decisions = [{ subject: null, body: outcome[1].trim(), derived: true }];
  }

  const touchedFiles = new Set();
  for (const rec of learnings) {
    for (const ref of Array.isArray(rec.source_refs) ? rec.source_refs : []) touchedFiles.add(ref);
  }

  return {
    sessionDir,
    sessionMarkdown: mdPath ? path.basename(mdPath) : null,
    slug,
    repo,
    status: state.status || null,
    phase: state.phase || null,
    planSummary,
    definitionOfDone,
    decisions,
    learnings,
    evidence: acceptance || (fs.existsSync(path.join(sessionDir, "trust.bundle")) ? { source: "trust.bundle" } : null),
    critiqueSummary: critique && (critique.summary || critique.status) ? { status: critique.status, summary: critique.summary } : null,
    transcriptRefs: collectTranscriptRefs(sessionDir),
    touchedFiles: [...touchedFiles].sort(),
  };
}
