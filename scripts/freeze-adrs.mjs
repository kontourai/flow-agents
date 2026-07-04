#!/usr/bin/env node
// freeze-adrs.mjs — ADR freeze-and-index tooling for flow-agents.
//
// Freezes numbered ADRs under docs/adr/ as immutable history and seeds the
// topic-keyed decision registry (docs/decisions/) with `needs-decision` stubs
// that carry the frozen ADR(s) as provenance evidence.
//
// Origin & provenance: this is the portable, zero-runtime-dependency standalone
// script (node >=22, ESM) piloted in kontourai/traverse per
// https://github.com/kontourai/flow-agents/issues/314 and rolled out across the
// portfolio (traverse#17, surface#115, flow#103, survey#108, campfit#45). This
// copy is the flow-agents cutover (https://github.com/kontourai/flow-agents/issues/332),
// the 6th application. It carries the two rollout fixes proven in the prior
// applications (surface#115 / flow#103):
//   FIX 1 (frontmatter-aware banner placement): every flow-agents ADR opens with
//     a YAML frontmatter block (`---\ntitle: ...\n---`). The traverse-original
//     always prepended the banner at byte 0, which would push the frontmatter
//     off the literal first line. `insertBanner()` detects a leading frontmatter
//     block and inserts the banner AFTER its closing `---` instead.
//   FIX 2 (whole-phrase lowercasing for Title Case terms): the traverse-original
//     `defaultStubBody` only lowercased the first character of a subject when
//     used mid-sentence, which read fine for traverse's sentence-case subjects
//     but produced "trust Bundle" for Title Case glossary terms. `lowerPhrase()`
//     lowercases every simple Title Case word (^[A-Z][a-z]+$) while preserving
//     acronyms (MCP), CamelCase (TypeScript-first), and symbol tokens (`/`) —
//     the flow-agents vocabulary contains all three.
//
// It does NOT vendor a copy of the registry validator or schema: flow-agents is
// the source of truth for both (scripts/check-decisions.cjs,
// schemas/decision-record.schema.json, wired as `npm run check:decisions` /
// `npm run gen:decisions-index` per #316). This script points at the existing
// validator to regenerate docs/decisions/index.md.
//
// Behavior (idempotent, content-preserving):
//   1. For each docs/adr/NNNN-*.md: insert a frozen banner as the ONLY body
//      change (after any leading YAML frontmatter). Skipped if already present.
//   2. Generate docs/adr/index.md deterministically. A second run is diff-clean.
//   3. For each SUBJECT_GROUPS entry, create/update a `status: needs-decision`
//      topic stub in docs/decisions/<slug>.md whose evidence[] links the frozen
//      ADR(s). Existing stub frontmatter (status/decided) is preserved across
//      reruns; only missing evidence entries are appended.
//
// Usage:  node scripts/freeze-adrs.mjs   (npm run freeze:adrs)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ADR_DIR = path.join(ROOT, "docs", "adr");
const ADR_INDEX_PATH = path.join(ADR_DIR, "index.md");
const DECISIONS_DIR = path.join(ROOT, "docs", "decisions");

const FROZEN_BANNER_MARKER = "FROZEN — immutable history.";
const FROZEN_BANNER =
  "> **FROZEN — immutable history.** Superseding/current decisions live in " +
  "[`docs/decisions/`](../decisions/index.md). Do not edit.\n\n";

// --- Subject grouping (flow-agents-specific, reviewed by hand) --------------
//
// Each ADR's decision subject is a NOUN drawn from (or added to) CONTEXT.md's
// domain vocabulary, per context/contracts/decision-registry-contract.md's slug
// rule. Multiple ADRs answering the same subject share one stub with multiple
// evidence refs (contract: "one file per decision SUBJECT"). Groups reference
// explicit ADR *filenames* (not numbers) because 0007 has two files sharing the
// number (0007-flow-skill-kit-tool-boundary.md and 0007-skill-audit.md), which a
// number-keyed map would collide.
//
// The four existing living topics (decision-records, promotion-gate,
// knowledge-store-provider, standing-directives) are NOT touched: none of the
// 22 numbered ADRs is about those subjects, so there is no evidence-merge case
// here — every frozen ADR subject gets a fresh needs-decision stub.
const SUBJECT_GROUPS = [
  { slug: "workflow-enforcement", subject: "Workflow Enforcement", adrFiles: ["0001-flow-agents-consumes-flow.md"] },
  { slug: "flow-kit", subject: "Flow Kit", adrFiles: ["0002-flow-kits-as-extension-unit.md", "0003-flow-agents-coordinates-kits-and-adapters.md"] },
  { slug: "workflow-trust-state", subject: "Workflow trust state", adrFiles: ["0004-gates-expect-surface-claims.md", "0010-workflow-trust-state-as-hachure-bundle.md"] },
  { slug: "kontour-resource-contract", subject: "Kontour Resource Contract", adrFiles: ["0005-kubernetes-inspired-resource-contracts.md"] },
  { slug: "typescript-source-policy", subject: "TypeScript-first source policy", adrFiles: ["0006-typescript-first-source-policy.md"] },
  { slug: "flow-skill-kit-tool-boundary", subject: "Flow / Skill / Kit / Tool boundary", adrFiles: ["0007-flow-skill-kit-tool-boundary.md", "0007-skill-audit.md"] },
  { slug: "kit-operation-boundary", subject: "Kit operation boundary", adrFiles: ["0008-kit-operation-boundary.md"] },
  { slug: "hook-core-kit-boundary", subject: "Hook core/kit boundary", adrFiles: ["0009-canonical-hook-core-kit-boundary.md"] },
  { slug: "mcp-posture", subject: "MCP posture", adrFiles: ["0011-mcp-posture.md"] },
  { slug: "agent-coordination", subject: "Agent coordination", adrFiles: ["0012-agent-coordination-as-liveness-claims.md", "0021-assignment-leases-and-stale-claim-takeover.md"] },
  { slug: "context-lifecycle", subject: "Context lifecycle", adrFiles: ["0013-context-lifecycle.md"] },
  { slug: "core-domain-kit-boundary", subject: "Core vs domain kit boundary", adrFiles: ["0014-core-vs-domain-kit-boundary.md"] },
  { slug: "flow-flow-agents-boundary", subject: "Flow / Flow Agents boundary", adrFiles: ["0015-flow-flow-agents-boundary-reconciliation.md"] },
  { slug: "three-hard-boundary-model", subject: "Three-hard-boundary model", adrFiles: ["0016-three-hard-boundary-model.md"] },
  { slug: "anti-gaming-trust-security", subject: "Anti-gaming trust security", adrFiles: ["0017-anti-gaming-trust-security-model.md", "0018-freeze-local-shell-heuristics.md"] },
  { slug: "kit-dependency-ownership", subject: "Kit dependency ownership", adrFiles: ["0019-kit-dependency-ownership.md"] },
  { slug: "trust-reconcile", subject: "Trust-reconcile and delivery reconciliation", adrFiles: ["0020-trust-reconcile-manifest-and-claim-classification.md", "0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md"] },
];

function listAdrFiles() {
  if (!fs.existsSync(ADR_DIR)) return [];
  return fs
    .readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
}

function adrNumberFromFilename(name) {
  return parseInt(name.slice(0, 4), 10);
}

// FIX 1: frontmatter-aware banner insertion. If the file opens with a YAML
// frontmatter block, insert the banner immediately after its closing `---`
// (and the blank line that follows), never before the frontmatter.
function insertBanner(raw) {
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const lines = raw.split(/\r?\n/);
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") { end = i; break; }
    }
    if (end !== -1) {
      // Skip a single blank line after the closing fence so the banner lands
      // between the frontmatter and the first heading with clean spacing.
      let insertAt = end + 1;
      if (insertAt < lines.length && lines[insertAt].trim() === "") insertAt += 1;
      const before = lines.slice(0, insertAt).join("\n");
      const after = lines.slice(insertAt).join("\n");
      return `${before}\n${FROZEN_BANNER}${after}`;
    }
  }
  return FROZEN_BANNER + raw;
}

function freezeOne(file) {
  const full = path.join(ADR_DIR, file);
  const raw = fs.readFileSync(full, "utf8");
  if (raw.includes(FROZEN_BANNER_MARKER)) {
    return { file, changed: false, raw };
  }
  const frozen = insertBanner(raw);
  fs.writeFileSync(full, frozen, "utf8");
  return { file, changed: true, raw: frozen };
}

// Best-effort title/date extraction (index display only — never touches frozen
// ADR content). Widened for flow-agents' header forms: `# ADR NNNN: Title`
// headings and `Date:` / `**Date:**` / parenthesized `(YYYY-MM-DD)` date lines.
function parseAdrMeta(file, raw) {
  const number = adrNumberFromFilename(file);
  const lines = raw.split(/\r?\n/);
  let title = file;
  for (const line of lines) {
    const m = line.match(/^#\s+(.*)$/);
    if (m) {
      title = m[1].trim().replace(/^ADR\s+\d+\s*[:—-]\s*/, "");
      break;
    }
  }
  const dateMatch =
    raw.match(/^\s*\*{0,2}Date:?\*{0,2}\s*(\d{4}-\d{2}-\d{2})/m) ||
    raw.match(/\((\d{4}-\d{2}-\d{2})\)/);
  const date = dateMatch ? dateMatch[1] : null;
  return { number, file, title, date };
}

function renderAdrIndex(entries) {
  const sorted = [...entries].sort((a, b) => (a.number - b.number) || a.file.localeCompare(b.file));
  const lines = [];
  lines.push("---");
  lines.push("title: ADR Index");
  lines.push("---");
  lines.push("");
  lines.push("# ADR Index");
  lines.push("");
  lines.push("Generated by `node scripts/freeze-adrs.mjs` (`npm run freeze:adrs`). Do not edit by hand.");
  lines.push(
    "Numbered ADRs below are FROZEN immutable history (see the banner on each " +
      "file). Current and superseding decisions live in " +
      "[docs/decisions/](../decisions/index.md); a frozen ADR's subject is " +
      "carried forward there as a `needs-decision` stub or a ratified decision."
  );
  lines.push("");
  lines.push("| Number | Title | Date | Link |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of sorted) {
    const num = String(e.number).padStart(4, "0");
    const date = e.date || "unknown";
    lines.push(`| ${num} | ${e.title} | ${date} | [${e.file}](./${e.file}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

function readExistingStub(slug) {
  const full = path.join(DECISIONS_DIR, `${slug}.md`);
  if (!fs.existsSync(full)) return null;
  const raw = fs.readFileSync(full, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, fmBlock, body] = fmMatch;
  const statusMatch = fmBlock.match(/^status:\s*(.+)$/m);
  const decidedMatch = fmBlock.match(/^decided:\s*(.+)$/m);
  const evidence = [];
  const evidenceBlockMatch = fmBlock.match(/^evidence:\n([\s\S]*?)(?:\n[a-z_]+:|$)/m);
  if (evidenceBlockMatch) {
    const itemRe = /-\s*kind:\s*(\S+)\n\s*ref:\s*(.+)/g;
    let m;
    while ((m = itemRe.exec(evidenceBlockMatch[1])) !== null) {
      evidence.push({ kind: m[1].trim(), ref: m[2].trim() });
    }
  }
  return {
    status: statusMatch ? statusMatch[1].trim() : null,
    decided: decidedMatch ? decidedMatch[1].trim() : null,
    evidence,
    body,
  };
}

function evidenceKey(e) {
  return `${e.kind}::${e.ref}`;
}

function renderStub({ subject, decided, evidence, body }) {
  const lines = [];
  lines.push("---");
  lines.push("status: needs-decision");
  lines.push(`subject: ${subject}`);
  lines.push(`decided: ${decided}`);
  lines.push("evidence:");
  for (const e of evidence) {
    lines.push(`  - kind: ${e.kind}`);
    lines.push(`    ref: ${e.ref}`);
  }
  lines.push("---");
  lines.push(body);
  return lines.join("\n");
}

// FIX 2: whole-phrase lowercasing for Title Case terms, acronym/CamelCase-safe.
function lowerPhrase(s) {
  return s
    .split(/(\s+)/)
    .map((tok) => (/^[A-Z][a-z]+$/.test(tok) ? tok.toLowerCase() : tok))
    .join("");
}

function defaultStubBody(subject, adrFiles) {
  const adrLinks = adrFiles.map((f) => `[${f}](../adr/${f})`).join(", ");
  return `
# ${subject}

This subject has provenance in frozen ADR history (${adrLinks}) but no living
decision has been ratified yet under the topic-keyed decision registry
(\`context/contracts/decision-registry-contract.md\`). This stub records that the
subject is open and links the frozen ADR(s) as provenance; it is not a decision.

When a living decision is ratified for ${lowerPhrase(subject)}, update this
file's \`status\` to \`current\`, add rationale, and keep the \`adr\` evidence
links as provenance for the history that led here.
`.trimStart();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function upsertStub(group) {
  const adrFiles = group.adrFiles;
  const desiredEvidence = [
    ...adrFiles.map((f) => ({ kind: "adr", ref: `docs/adr/${f}` })),
    ...(group.extraEvidence || []),
  ];

  const existing = readExistingStub(group.slug);
  const decided = existing?.decided || todayIso();
  const body = existing?.body || defaultStubBody(group.subject, adrFiles);

  const mergedEvidence = [];
  const seen = new Set();
  const source = existing ? existing.evidence.concat(desiredEvidence) : desiredEvidence;
  for (const e of source) {
    const key = evidenceKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEvidence.push(e);
  }

  const content = renderStub({ subject: group.subject, decided, evidence: mergedEvidence, body });

  const full = path.join(DECISIONS_DIR, `${group.slug}.md`);
  const priorRaw = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  if (priorRaw === content) {
    return { slug: group.slug, changed: false };
  }
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return { slug: group.slug, changed: true };
}

// Fail loudly if any numbered ADR file is unassigned or double-assigned, or a
// group references a missing file — silent drop of an ADR is exactly the bug a
// freeze must never ship.
function assertCoverage(adrFilenames) {
  const assigned = new Map();
  for (const g of SUBJECT_GROUPS) {
    for (const f of g.adrFiles) {
      if (assigned.has(f)) {
        throw new Error(`ADR ${f} is assigned to two groups (${assigned.get(f)} and ${g.slug})`);
      }
      assigned.set(f, g.slug);
      if (!adrFilenames.includes(f)) {
        throw new Error(`group ${g.slug} references missing ADR file ${f}`);
      }
    }
  }
  const unassigned = adrFilenames.filter((f) => !assigned.has(f));
  if (unassigned.length > 0) {
    throw new Error(`ADR file(s) not assigned to any subject group: ${unassigned.join(", ")}`);
  }
}

function main() {
  const adrFilenames = listAdrFiles();
  if (adrFilenames.length === 0) {
    console.log("No docs/adr/NNNN-*.md files found; nothing to freeze.");
    return 0;
  }

  assertCoverage(adrFilenames);

  const frozen = adrFilenames.map(freezeOne);
  const bannerChanged = frozen.filter((f) => f.changed);
  for (const f of bannerChanged) {
    console.log(`Froze ${path.relative(ROOT, path.join(ADR_DIR, f.file))} (banner inserted).`);
  }

  const meta = frozen.map((f) => parseAdrMeta(f.file, f.raw));
  const adrIndexContent = renderAdrIndex(meta);
  const priorIndex = fs.existsSync(ADR_INDEX_PATH) ? fs.readFileSync(ADR_INDEX_PATH, "utf8") : null;
  if (priorIndex !== adrIndexContent) {
    fs.writeFileSync(ADR_INDEX_PATH, adrIndexContent, "utf8");
    console.log(`Wrote ${path.relative(ROOT, ADR_INDEX_PATH)}.`);
  }

  const stubResults = SUBJECT_GROUPS.map((g) => upsertStub(g));
  for (const r of stubResults.filter((r) => r.changed)) {
    console.log(`Wrote docs/decisions/${r.slug}.md (needs-decision stub).`);
  }

  // Chain the existing (not vendored) registry index generator so a single
  // `npm run freeze:adrs` leaves docs/decisions/index.md current too.
  const checkDecisions = path.join(ROOT, "scripts", "check-decisions.cjs");
  if (fs.existsSync(checkDecisions)) {
    execFileSync(process.execPath, [checkDecisions, "gen-index"], { cwd: ROOT, stdio: "inherit" });
  }

  const anyChange =
    bannerChanged.length > 0 ||
    priorIndex !== adrIndexContent ||
    stubResults.some((r) => r.changed);
  console.log(
    anyChange ? "freeze-adrs: changes written." : "freeze-adrs: no-op (already frozen and current)."
  );
  return 0;
}

process.exit(main());
