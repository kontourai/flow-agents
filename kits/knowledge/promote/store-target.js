/**
 * Store-target proposal renderer and stager for knowledge.promote.
 *
 * This module is deliberately proposals-only. It creates JSON artifacts under
 * the personal store's pending area but never constructs a knowledge store or
 * invokes a record mutation method.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureGlobalStore, validateGlobalStoreLocation } from "../adapters/shared/store-resolve.js";
import { proposal, provenance, loadSchemas } from "../providers/lib/model.js";
import { assertValid } from "../providers/lib/schema-validate.js";
import { scrubRuntimeResidueText } from "./runtime-session-redaction.js";

const { proposal: PROPOSAL_SCHEMA } = loadSchemas();
const CREATE_TYPES = new Set(["raw", "compiled", "concept"]);
const CATEGORY_SEGMENT_RE = /^[a-z0-9_-]+$/;
const MAX_CONTENT_LENGTH = 32_768;
const STABLE_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function fail(message) {
  const error = new Error(`store target: ${message}`);
  error.code = "STORE_TARGET_INVALID";
  throw error;
}

function safeSegment(value, label) {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    fail(`${label} must be a safe path segment`);
  }
  if (scrubRuntimeResidueText(value) !== value) fail(`${label} contains sensitive data`);
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be a non-empty relative path`);
  }
  const normalized = value.split(/[\\/]/);
  if (normalized.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${label} must stay contained`);
  }
  if (scrubRuntimeResidueText(value) !== value) fail(`${label} contains sensitive data`);
  return normalized.join("/");
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} escapes the personal store`);
  }
}

function assertNoSymlinkAncestry(root, target) {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      fail(`symlinked proposal ancestry is not allowed: ${part}`);
    }
  }
}

function stableRetrievedAt(linked) {
  const decided = linked.decisions && linked.decisions.find((decision) =>
    typeof decision.decided === "string" && /^\d{4}-\d{2}-\d{2}$/.test(decision.decided),
  )?.decided;
  return decided ? `${decided}T00:00:00.000Z` : STABLE_FALLBACK_TIMESTAMP;
}

function validateCreatePayload(payload, label) {
  if (!CREATE_TYPES.has(payload.type)) fail(`${label} has unsupported create type`);
  if (typeof payload.title !== "string" || !payload.title.trim()) fail(`${label} requires a title`);
  if (typeof payload.body !== "string") fail(`${label} requires string content`);
  if (payload.body.length > MAX_CONTENT_LENGTH) fail(`${label} content exceeds ${MAX_CONTENT_LENGTH} characters`);
  if (typeof payload.category !== "string" || !payload.category.split(".").every((segment) => CATEGORY_SEGMENT_RE.test(segment))) {
    fail(`${label} has an invalid category`);
  }
  if (!payload.provenance || typeof payload.provenance.agent !== "string" || !payload.provenance.agent.trim()) {
    fail(`${label} requires provenance.agent`);
  }
  if (typeof payload.provenance.session_id !== "string" || !payload.provenance.session_id) {
    fail(`${label} requires provenance.session_id`);
  }
  if (!Array.isArray(payload.provenance.source_ids) || payload.provenance.source_ids.length === 0) {
    fail(`${label} requires transcript provenance`);
  }
}

function recordPayload({ title, body, category, agent, sessionId, transcriptRefs }) {
  if (typeof body === "string" && body.length > MAX_CONTENT_LENGTH) {
    fail(`record content exceeds ${MAX_CONTENT_LENGTH} characters`);
  }
  const payload = {
    type: "raw",
    title: scrubRuntimeResidueText(title),
    body: scrubRuntimeResidueText(body),
    category,
    tags: ["memory"],
    provenance: {
      agent,
      session_id: sessionId,
      source_ids: transcriptRefs,
    },
  };
  validateCreatePayload(payload, payload.title.slice(0, 128) || "record");
  return payload;
}

function sourceFor(residue, slug) {
  const sessionMarkdown = safeRelative(residue.sessionMarkdown || "state.json", "session source");
  return `sessions/${slug}/${sessionMarkdown}`;
}

function recordSpecs(linked) {
  return [
    ...(linked.decisions || []).map((item) => ({
      kind: "decision", id: item.slug, title: item.subject,
      body: item.body || item.subject, category: "memory.decision",
    })),
    ...(linked.vocabulary || []).map((item) => ({
      kind: "vocabulary", id: item.slug, title: item.term,
      body: item.definition || item.term, category: "memory.vocabulary",
    })),
    ...(linked.learnings || []).map((item) => ({
      kind: "learning", id: item.id, title: item.title,
      body: item.body || item.title, category: "memory.learning",
    })),
  ];
}

function buildDraft(spec, context) {
  const identifier = safeSegment(spec.id, `${spec.kind} identifier`);
  const file = `${spec.kind}-${identifier}.json`;
  const payload = recordPayload({ ...spec, ...context, sessionId: context.slug });
  const staged = proposal({
    provider: "default-store",
    kind: "create-node",
    target: { root: "personal", path: `proposals/pending/${context.slug}/${file}` },
    payload,
    rationale: `Proposed memory record distilled from session ${context.slug}; staging does not apply a store record.`,
    provenance: provenance({
      provider: "knowledge.promote",
      source: context.source,
      locator: context.transcriptRefs[0],
      retrievedAt: context.retrievedAt,
      agent: context.agent,
    }),
  });
  assertValid(staged, PROPOSAL_SCHEMA, `store proposal '${file}'`);
  return { file, content: `${JSON.stringify(staged, null, 2)}\n` };
}

function buildProposals({ linked, residue, agent }) {
  if (!linked || typeof linked !== "object") fail("linked records are required");
  if (!residue || typeof residue !== "object") fail("session residue is required");
  if (typeof agent !== "string" || !agent.trim()) fail("agent is required");
  if (agent.length > 256 || scrubRuntimeResidueText(agent) !== agent) fail("agent contains sensitive data");

  const slug = safeSegment(residue.slug, "session slug");
  const transcriptRefs = Array.isArray(residue.transcriptRefs) ? residue.transcriptRefs.map((ref) => safeRelative(ref, "transcript ref")) : [];
  if (transcriptRefs.length === 0) fail("at least one transcript ref is required");

  const context = {
    slug, transcriptRefs, agent,
    source: sourceFor(residue, slug),
    retrievedAt: stableRetrievedAt(linked),
  };
  const drafts = recordSpecs(linked).map((spec) => buildDraft(spec, context));

  const names = new Set();
  for (const draft of drafts) {
    if (names.has(draft.file)) fail(`duplicate deterministic proposal filename '${draft.file}'`);
    names.add(draft.file);
  }
  return { slug, drafts };
}

function ensurePrivateDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe proposal directory: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function existingBatchMatches(outDir, drafts, { tighten = true } = {}) {
  if (!fs.existsSync(outDir)) return false;
  const stat = fs.lstatSync(outDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("pending proposal path is unsafe");
  if (tighten) fs.chmodSync(outDir, 0o700);
  const expected = drafts.map((draft) => draft.file).sort();
  const actual = fs.readdirSync(outDir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("proposal batch collision or incomplete batch");
  for (const draft of drafts) {
    const destination = path.join(outDir, draft.file);
    const fileStat = fs.lstatSync(destination);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail(`proposal collision at unsafe path ${draft.file}`);
    if (tighten) fs.chmodSync(destination, 0o600);
    if (fs.readFileSync(destination, "utf8") !== draft.content) fail(`proposal collision at ${draft.file}`);
  }
  return true;
}

function removeTemporaryBatch(directory, drafts) {
  for (const draft of drafts) {
    const file = path.join(directory, draft.file);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (fs.existsSync(directory)) fs.rmdirSync(directory);
}

function stageNewBatch(outDir, drafts) {
  const parent = path.dirname(outDir);
  const temporary = path.join(parent, `.${path.basename(outDir)}.${process.pid}.${randomUUID()}.tmp`);
  ensurePrivateDirectory(temporary);
  try {
    for (const draft of drafts) {
      fs.writeFileSync(path.join(temporary, draft.file), draft.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    fs.renameSync(temporary, outDir);
    return drafts.map((draft) => draft.file);
  } catch (error) {
    removeTemporaryBatch(temporary, drafts);
    if (["EEXIST", "ENOTEMPTY"].includes(error?.code) && existingBatchMatches(outDir, drafts)) return [];
    throw error;
  }
}

function proposalDestination(storeRoot, slug, drafts) {
  const proposalsDir = path.join(storeRoot, "proposals");
  const pendingDir = path.join(proposalsDir, "pending");
  const outDir = path.join(pendingDir, slug);
  assertContained(storeRoot, outDir, "pending proposal directory");
  assertNoSymlinkAncestry(storeRoot, outDir);
  for (const directory of [proposalsDir, pendingDir]) {
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) fail(`unsafe proposal directory: ${directory}`);
  }
  return { proposalsDir, pendingDir, outDir, existing: existingBatchMatches(outDir, drafts, { tighten: false }) };
}

function stageDrafts(storeRoot, slug, drafts) {
  const { proposalsDir, pendingDir, outDir, existing } = proposalDestination(storeRoot, slug, drafts);
  ensurePrivateDirectory(proposalsDir);
  ensurePrivateDirectory(pendingDir);
  if (existing) {
    existingBatchMatches(outDir, drafts);
    return { outDir, written: [] };
  }
  return { outDir, written: stageNewBatch(outDir, drafts) };
}

function scrubContentValue(value) {
  if (typeof value === "string") return scrubRuntimeResidueText(value);
  if (Array.isArray(value)) return value.map((item) => scrubContentValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubContentValue(item)]));
  }
  return value;
}

/** Scrub distilled content echoed by a store-target result, not only staged files. */
export function sanitizeStoreResult(result) {
  const sanitized = scrubContentValue(result);
  return { ...sanitized, out_dir: result.out_dir, written: result.written };
}

/**
 * Render and stage DefaultKnowledgeStore.create-compatible proposals.
 *
 * @param {{linked: object, residue: object, env?: object, agent: string, write?: boolean}} options
 * @returns {{outDir: string, written: string[]}}
 */
export function writeStoreProposals({ linked, residue, env = process.env, agent, write = true } = {}) {
  const { slug, drafts } = buildProposals({ linked, residue, agent });
  if (!write) {
    const { storeRoot } = validateGlobalStoreLocation(env);
    const { outDir } = proposalDestination(storeRoot, slug, drafts);
    return { outDir, written: [] };
  }
  const storeRoot = ensureGlobalStore(env);
  if (!storeRoot || !path.isAbsolute(storeRoot)) fail("resolver returned an invalid store root");
  return stageDrafts(storeRoot, slug, drafts);
}

export default writeStoreProposals;
