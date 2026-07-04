/**
 * Shared helpers for the knowledge promote sub-flow.
 *
 * Zero external dependencies (mirrors scripts/check-decisions.cjs and
 * providers/lib/schema-validate.js) so the sub-flow runs in any node:test lane.
 *
 * @module promote/lib
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Read a file, returning "" when it is absent (ingest is tolerant of shape). */
export function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** kebab-case slug from a subject noun phrase (matches the registry slug rule). */
export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract the body of a `## <Heading>` section from a markdown session file.
 * Returns the lines between the heading and the next `## ` heading.
 */
export function markdownSection(md, heading) {
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line);
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Parse `## Decisions` list items of the form:
 *   - **Subject noun** — the current decision body.
 * Returns [{ subject, body }]. Tolerant of `-` or `*` bullets and `—`/`-` dashes.
 */
export function parseDecisionList(sectionText) {
  const items = [];
  for (const raw of String(sectionText || "").split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[—-]\s*(.+?)\s*$/);
    if (m) items.push({ subject: m[1].trim(), body: m[2].trim() });
  }
  return items;
}

/** Read the `## Glossary` term set from a repo CONTEXT.md (lowercased term names). */
export function readGlossaryTerms(repoRoot) {
  const text = readIfExists(path.join(repoRoot, "CONTEXT.md"));
  const terms = new Set();
  let inGlossary = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s+Glossary\s*$/.test(line)) { inGlossary = true; continue; }
    if (/^##\s+/.test(line) && !/^##\s+Glossary/.test(line)) inGlossary = false;
    if (!inGlossary) continue;
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) terms.add(h[1].trim().toLowerCase());
  }
  return terms;
}

const EVIDENCE_KINDS = ["issue", "pr", "commit", "session-archive", "adr", "doc", "url"];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_PATTERNS = [
  /AKIA[A-Z0-9]{16}/,
  /ASIA[A-Z0-9]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{36,}/,
  /BEGIN[A-Z ]*PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i,
];

/**
 * Validate a draft decision delta against the decision-record contract (#310)
 * BEFORE it is proposed. Mirrors schemas/decision-record.schema.json /
 * scripts/check-decisions.cjs rules directly (zero-dep, same discipline).
 * Returns a list of error strings; empty means schema-valid.
 */
export function validateDecisionDelta(delta) {
  const errors = [];
  const { subject, slug, decided, evidence, status = "current" } = delta;
  if (!["current", "superseded", "merged", "needs-decision"].includes(status)) {
    errors.push(`status '${status}' is not a valid decision-record status`);
  }
  if (typeof subject !== "string" || subject.trim() === "") errors.push("subject must be a non-empty noun phrase");
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) errors.push(`slug '${slug}' is not valid kebab-case`);
  if (typeof decided !== "string" || !DATE_RE.test(decided)) errors.push(`decided '${decided}' must be an ISO date (YYYY-MM-DD)`);
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push("evidence must be a non-empty array of {kind, ref}");
  } else {
    evidence.forEach((e, i) => {
      if (!e || typeof e !== "object") { errors.push(`evidence[${i}] must be an object`); return; }
      if (!EVIDENCE_KINDS.includes(e.kind)) errors.push(`evidence[${i}].kind '${e.kind}' is not one of ${EVIDENCE_KINDS.join(", ")}`);
      if (typeof e.ref !== "string" || e.ref.trim() === "") { errors.push(`evidence[${i}].ref must be a non-empty string`); return; }
      if (SECRET_PATTERNS.some((re) => re.test(e.ref))) errors.push(`evidence[${i}].ref contains a secret-shaped literal; link durable provenance, never a credential`);
    });
  }
  return errors;
}

/** Recursively hash every file under a directory into a {relpath: sha} map (for AC3 diff proof). */
export function snapshotDir(dir) {
  const out = {};
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else out[r] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
