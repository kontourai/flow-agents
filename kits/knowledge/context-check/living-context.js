/**
 * Knowledge Kit Living Context (Context Check input/result 1.1).
 *
 * Extends the revision-bound Context Check with the recall contract from kontourai/flow-agents#1131:
 *   - as-of on valid time and knowledge time, aligned with the Surface knowledge-accumulation decision;
 *   - a required reader identity that fails closed (unknown, missing, or unlisted claims are never widened);
 *   - per-result reasons (matched signals, freshness, review posture, supersession chain, status reasons);
 *   - an explicit token budget where whole results are kept or dropped and never truncated.
 *
 * Recall returns evidence only. Abstention is the separate answer step (living-context-answer.js).
 * Freshness is derived by Surface (`claimIntrinsicExpiry`); this module adds no second trust derivation.
 * Contextual status here is not a Surface trust status.
 *
 * @module living-context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claimIntrinsicExpiry } from "@kontourai/surface";
import { validate } from "../providers/lib/schema-validate.js";
import {
  error, isIdentity, safeRelativePath, resolveRevisionBoundRepository, readManifestAtRevision,
  authorityAtRevision, retrievalProvenance, reconciliationFor, proposalFor, writeResult,
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/knowledge/living-context-input.schema.json"), "utf8"));
const RESULT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/knowledge/living-context-result.schema.json"), "utf8"));
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SUPERSESSION_KINDS = new Set(["correction", "succession"]);
const REVIEW_POSTURES = new Set(["proposed", "reviewed"]);
const CLAIM_KEYS = ["visibility", "recorded_at", "valid_time", "supersession_kind", "expires_at", "ttl_seconds", "verified_at", "review"];

/** A real UTC calendar instant: rejects shape violations and day rollover such as 2026-02-31. */
export function parseInstant(value, field) {
  if (typeof value !== "string" || !INSTANT_RE.test(value)) throw error("INVALID_INSTANT", `${field} must be a UTC RFC 3339 instant (YYYY-MM-DDTHH:MM:SS[.mmm]Z)`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) throw error("INVALID_INSTANT", `${field} is not a real calendar instant`);
  return ms;
}

function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function onlyKeys(object, allowed, field) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw error("INVALID_CLAIM_MANIFEST", `${field} has unexpected property '${key}'`);
}

function parseValidTime(value, field) {
  if (!plainObject(value)) throw error("INVALID_CLAIM_MANIFEST", `${field} must be an object`);
  onlyKeys(value, ["from", "until"], field);
  const from = value.from === undefined ? undefined : parseInstant(value.from, `${field}.from`);
  const until = value.until === undefined ? undefined : parseInstant(value.until, `${field}.until`);
  // Surface: a half-open [from, until) interval; from >= until fails closed.
  if (from !== undefined && until !== undefined && from >= until) throw error("INVALID_CLAIM_MANIFEST", `${field} requires from < until`);
  return { from, until };
}

const EXTENSION = Object.freeze({
  manifestKeys: new Set(["readers"]),
  claimKeys: new Set(CLAIM_KEYS),
  parseManifest(parsed, manifestPath) {
    const readers = parsed.readers === undefined ? [] : parsed.readers;
    if (!Array.isArray(readers) || readers.some((reader) => !isIdentity(reader)) || new Set(readers).size !== readers.length) {
      throw error("INVALID_CLAIM_MANIFEST", `${manifestPath}: readers must be a unique array of non-blank identities`);
    }
    return { readers: new Set(readers) };
  },
  parseClaim(claim, prefix) {
    const visibility = claim.visibility === undefined ? [] : claim.visibility;
    if (!Array.isArray(visibility) || visibility.some((reader) => !isIdentity(reader)) || new Set(visibility).size !== visibility.length) {
      throw error("INVALID_CLAIM_MANIFEST", `${prefix}.visibility must be a unique array of reader identities`);
    }
    const recordedAt = claim.recorded_at === undefined ? undefined : parseInstant(claim.recorded_at, `${prefix}.recorded_at`);
    const validTime = claim.valid_time === undefined ? undefined : parseValidTime(claim.valid_time, `${prefix}.valid_time`);
    if (claim.supersession_kind !== undefined && (!SUPERSESSION_KINDS.has(claim.supersession_kind) || claim.superseded_by === undefined)) {
      throw error("INVALID_CLAIM_MANIFEST", `${prefix}.supersession_kind must be correction or succession and requires superseded_by`);
    }
    if (claim.expires_at !== undefined) parseInstant(claim.expires_at, `${prefix}.expires_at`);
    if (claim.verified_at !== undefined) parseInstant(claim.verified_at, `${prefix}.verified_at`);
    if (claim.ttl_seconds !== undefined && !(typeof claim.ttl_seconds === "number" && Number.isFinite(claim.ttl_seconds) && claim.ttl_seconds >= 0)) {
      throw error("INVALID_CLAIM_MANIFEST", `${prefix}.ttl_seconds must be a non-negative finite number`);
    }
    let review = { posture: "proposed" };
    if (claim.review !== undefined) {
      if (!plainObject(claim.review)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.review must be an object`);
      onlyKeys(claim.review, ["posture", "reviewer"], `${prefix}.review`);
      if (!REVIEW_POSTURES.has(claim.review.posture)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.review.posture must be proposed or reviewed`);
      // A reviewed posture without a named reviewer would be a label that nothing computes.
      if (claim.review.posture === "reviewed" && !isIdentity(claim.review.reviewer)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.review.reviewer is required for reviewed claims`);
      review = { posture: claim.review.posture };
    }
    return {
      visibility: new Set(visibility),
      recordedAt,
      recordedAtIso: claim.recorded_at,
      validTime,
      supersessionKind: claim.supersession_kind ?? "correction",
      expiresAt: claim.expires_at,
      ttlSeconds: claim.ttl_seconds,
      verifiedAt: claim.verified_at,
      review,
    };
  },
});

/** Validate a Living Context (1.1) input through its shared JSON schema plus the real-instant check. */
export function validateLivingContextInput(input) {
  const errors = validate(input, INPUT_SCHEMA).errors;
  if (errors.length === 0) {
    for (const key of ["now", "valid_at", "known_at"]) {
      if (input.as_of[key] === undefined) continue;
      try { parseInstant(input.as_of[key], `as_of.${key}`); } catch (cause) { errors.push(`$/as_of/${key}: ${cause.message}`); }
    }
  }
  return errors;
}

/** Validate a Living Context (1.1) result envelope plus the invariants a schema cannot express. */
export function validateLivingContextResult(result) {
  const errors = validate(result, RESULT_SCHEMA).errors;
  if (!plainObject(result) || !Array.isArray(result.recalls)) return errors;
  if (result.verdict === "pass") {
    if (result.recalls.some((recall) => recall?.status === "unverifiable")) errors.push("$/verdict: pass is invalid when any recall is unverifiable or no_answer");
    if (result.budget?.dropped?.length > 0) errors.push("$/verdict: pass is invalid when the budget dropped any result");
  }
  for (const [index, recall] of result.recalls.entries()) {
    // A recall that is current must never carry a superseded_by link that is active at the as-of instants.
    if (recall?.status === "current" && Array.isArray(recall.supersession_chain)) {
      if (recall.supersession_chain.some((link) => link.relation === "superseded_by" && link.active === true)) {
        errors.push(`$/recalls/${index}: a current recall must not have an active superseded_by link`);
      }
    }
    if (recall?.status === "superseded" && Array.isArray(recall.supersession_chain)) {
      if (!recall.supersession_chain.some((link) => link.relation === "superseded_by" && link.active === true && link.claim_id === recall.superseded_by)) {
        errors.push(`$/recalls/${index}: a superseded recall must name its active successor in the chain`);
      }
    }
  }
  return errors;
}

/** Deterministic, dependency-free token estimate: ceil(UTF-8 bytes / 4). Named in the result so no consumer assumes a tokenizer. */
export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

function buildContext(input) {
  const now = parseInstant(input.as_of.now, "as_of.now");
  const validAt = input.as_of.valid_at === undefined ? now : parseInstant(input.as_of.valid_at, "as_of.valid_at");
  const knownAt = input.as_of.known_at === undefined ? now : parseInstant(input.as_of.known_at, "as_of.known_at");
  return {
    reader: input.reader,
    now, validAt, knownAt,
    asOf: {
      now: input.as_of.now,
      valid_at: input.as_of.valid_at ?? input.as_of.now,
      known_at: input.as_of.known_at ?? input.as_of.now,
    },
  };
}

/** Fail closed on a reader that is unknown to any selected root, without disclosing which readers exist. */
function requireKnownReader(manifests, reader) {
  for (const manifest of manifests) {
    if (!manifest.extension.readers.has(reader)) throw error("UNKNOWN_READER_IDENTITY", "reader identity is not recognised by every selected Knowledge root");
  }
}

function indexClaims(manifests) {
  const byId = new Map();
  for (const claim of manifests.flatMap((manifest) => manifest.claims)) {
    if (byId.has(claim.id)) throw error("DUPLICATE_CLAIM_ID", `claim id '${claim.id}' appears in more than one selected Knowledge root`);
    byId.set(claim.id, claim);
  }
  // Self edges and cycles cannot select a winner (Surface decision); refuse the whole manifest set without naming ids.
  for (const claim of byId.values()) {
    const seen = new Set([claim.id]);
    for (let next = claim.superseded_by; next !== undefined; next = byId.get(next)?.superseded_by) {
      if (seen.has(next)) throw error("INVALID_CLAIM_MANIFEST", "supersession edges must be acyclic and may not be self edges");
      seen.add(next);
    }
  }
  return byId;
}

const isVisible = (claim, ctx) => claim.extension.visibility.has(ctx.reader);

/** State of the supersession edge claim -> successor, judged only on what this reader may see and know at the as-of instants. */
function edgeState(claim, byId, ctx) {
  if (claim.superseded_by === undefined) return { state: "none" };
  const successor = byId.get(claim.superseded_by);
  if (!successor || !isVisible(successor, ctx)) return { state: "hidden" };
  if (successor.extension.recordedAt === undefined) return { state: "unknown_time", successor };
  if (successor.extension.recordedAt > ctx.knownAt) return { state: "not_known", successor };
  const kind = claim.extension.supersessionKind;
  if (kind === "correction") return { state: "active", successor, kind };
  const from = successor.extension.validTime?.from;
  if (from === undefined) return { state: "unknown_boundary", successor, kind };
  return { state: from <= ctx.validAt ? "active" : "inactive", successor, kind };
}

function supersessionChain(claim, byId, ctx) {
  const links = [];
  const forward = [];
  for (let current = claim, guard = 0; current.superseded_by !== undefined && guard < byId.size; guard += 1) {
    const edge = edgeState(current, byId, ctx);
    // Only edges this reader may see and that were known at known_at belong in the chain.
    if (edge.state !== "active" && edge.state !== "inactive") break;
    forward.push({ claim_id: edge.successor.id, relation: "superseded_by", kind: edge.kind, active: edge.state === "active" });
    current = edge.successor;
  }
  const backward = [];
  const seen = new Set([claim.id]);
  let frontier = [claim];
  while (frontier.length) {
    const next = [];
    for (const target of frontier) {
      for (const candidate of [...byId.values()].filter((item) => item.superseded_by === target.id).sort((a, b) => a.id.localeCompare(b.id))) {
        if (seen.has(candidate.id) || !isVisible(candidate, ctx)) continue;
        const edge = edgeState(candidate, byId, ctx);
        if (!["active", "inactive"].includes(edge.state)) continue;
        seen.add(candidate.id);
        backward.unshift({ claim_id: candidate.id, relation: "supersedes", kind: edge.kind, active: edge.state === "active" });
        next.push(candidate);
      }
    }
    frontier = next;
  }
  links.push(...backward, { claim_id: claim.id, relation: "self" }, ...forward);
  return links;
}

function freshnessFor(claim, ctx) {
  // Surface resolves the intrinsic window (expiresAt wins; ttlSeconds is anchored on verification, else recording).
  const expiryMs = claimIntrinsicExpiry(
    { verifiedAt: claim.extension.verifiedAt, createdAt: claim.extension.recordedAtIso },
    { expiresAt: claim.extension.expiresAt, ttlSeconds: claim.extension.ttlSeconds, updatedAt: claim.extension.recordedAtIso },
  );
  const asOf = new Date(ctx.now).toISOString();
  if (expiryMs === undefined) return { as_of: asOf, stale: false };
  // Surface judges staleness as `now > expiry`; the same boundary is used here.
  return { as_of: asOf, expires_at: new Date(expiryMs).toISOString(), stale: ctx.now > expiryMs };
}

function signalsFor(claim, input, changedSurfaces) {
  const signals = [];
  if (input.claim_ids?.includes(claim.id)) signals.push("claim_id");
  if (claim.affected_surfaces.some((surface) => changedSurfaces.includes(surface))) signals.push("changed_surface");
  if (!input.claim_ids) signals.push("root_scan");
  return signals;
}

function noAnswer(claimId, revision, roots, reasons) {
  return {
    claim_id: claimId,
    status: "unverifiable",
    reason: "no_answer",
    ...(reasons ? { reasons } : {}),
    retrieval_provenance: retrievalProvenance(revision, roots),
  };
}

function recallFor(claim, input, changedSurfaces, byId, ctx, revision) {
  const base = () => ({
    claim_id: claim.id,
    claim: claim.claim,
    authority: authorityAtRevision(claim.authority, revision),
    retrieval_provenance: retrievalProvenance(revision, [{ id: claim.root.id, manifest_path: claim.manifestPath }]),
    matched_signals: signalsFor(claim, input, changedSurfaces),
    review_posture: claim.extension.review.posture,
  });
  const entry = (status, reasons, extra = {}) => ({
    ...base(),
    status,
    ...extra,
    freshness: freshnessFor(claim, ctx),
    supersession_chain: supersessionChain(claim, byId, ctx),
    reasons,
  });
  const reasons = [];
  // Knowledge time first: an unknown instant is indeterminate and is never guessed (Surface).
  if (claim.extension.recordedAt === undefined) return entry("unverifiable", ["knowledge_time_unknown"]);
  const edge = edgeState(claim, byId, ctx);
  if (edge.state === "hidden") return entry("unverifiable", ["successor_not_visible_or_unresolved"]);
  if (edge.state === "unknown_time") return entry("unverifiable", ["supersession_time_unknown"]);
  if (edge.state === "unknown_boundary") return entry("unverifiable", ["succession_boundary_unknown"]);
  if (edge.state === "active") return entry("superseded", ["superseded_by_known_successor"], { superseded_by: edge.successor.id });
  if (edge.state === "not_known") reasons.push("successor_not_known_at_as_of");
  if (edge.state === "inactive") reasons.push("succession_not_effective_at_valid_at");
  const validTime = claim.extension.validTime;
  if (validTime && ((validTime.from !== undefined && ctx.validAt < validTime.from) || (validTime.until !== undefined && ctx.validAt >= validTime.until))) {
    return { kind: "not_valid" };
  }
  if (claim.status === "unverifiable") return entry("unverifiable", [...reasons, "declared_unverifiable"]);
  if (freshnessFor(claim, ctx).stale) return entry("unverifiable", [...reasons, "stale_at_as_of"]);
  return entry("current", [...reasons, "current_at_as_of"]);
}

function orderedRequestIds(input, byId, changedSurfaces, ctx) {
  if (input.claim_ids) return input.claim_ids;
  const visible = [...byId.values()].filter((claim) => isVisible(claim, ctx));
  if (visible.length === 0) return ["no-matching-claims"];
  const overlaps = (claim) => claim.affected_surfaces.some((surface) => changedSurfaces.includes(surface));
  return visible.sort((a, b) => Number(overlaps(b)) - Number(overlaps(a)) || a.id.localeCompare(b.id)).map((claim) => claim.id);
}

/**
 * Pure Living Context derivation (no writes). Exposed so the answer step re-derives recall itself
 * instead of trusting a caller-supplied result.
 */
export function deriveLivingContext({ repoRoot, input }) {
  const inputErrors = validateLivingContextInput(input);
  if (inputErrors.length) {
    const identityMissing = inputErrors.some((message) => /missing required property 'reader'|\$\/reader/.test(message));
    throw error(identityMissing ? "READER_IDENTITY_REQUIRED" : "INVALID_CONTEXT_CHECK_INPUT", inputErrors.join("; "));
  }
  const ctx = buildContext(input);
  const { root: resolvedRoot, revision } = resolveRevisionBoundRepository(repoRoot, input.revision);
  const changedSurfaces = [...new Set(input.changed_surfaces || input.diff.paths)].map((surface) => safeRelativePath(surface, "changed surface"));
  if (new Set(input.knowledge_roots.map((knowledgeRoot) => knowledgeRoot.id)).size !== input.knowledge_roots.length) {
    throw error("DUPLICATE_KNOWLEDGE_ROOT_ID", "selected Knowledge root ids must be unique");
  }
  const manifests = input.knowledge_roots.map((knowledgeRoot) => readManifestAtRevision(resolvedRoot, revision, knowledgeRoot, EXTENSION));
  requireKnownReader(manifests, input.reader);
  const byId = indexClaims(manifests);
  const requestedIds = orderedRequestIds(input, byId, changedSurfaces, ctx);

  const candidates = requestedIds.map((claimId) => {
    const claim = byId.get(claimId);
    // Absent, hidden from this reader, and not yet known at known_at are indistinguishable: one plain no-answer.
    if (!claim || !isVisible(claim, ctx) || (claim.extension.recordedAt !== undefined && claim.extension.recordedAt > ctx.knownAt)) {
      return { claimId, entry: noAnswer(claimId, revision, input.knowledge_roots), claim: undefined };
    }
    const recalled = recallFor(claim, input, changedSurfaces, byId, ctx, revision);
    if (recalled.kind === "not_valid") return { claimId, entry: noAnswer(claimId, revision, [{ id: claim.root.id, manifest_path: claim.manifestPath }], ["not_valid_at_as_of"]), claim };
    return { claimId, entry: recalled, claim };
  });

  // Whole results are kept or dropped; nothing is truncated and every drop is reported.
  const maxTokens = input.budget.max_tokens;
  const recalls = [];
  const dropped = [];
  let used = 0;
  for (const candidate of candidates) {
    const cost = estimateTokens(candidate.entry);
    if (used + cost <= maxTokens) { recalls.push(candidate.entry); used += cost; } else dropped.push({ claim_id: candidate.claimId, estimated_tokens: cost });
  }

  // Reconcile only claims this reader may see and that were known at known_at.
  const reconcilable = candidates.filter((candidate) => candidate.claim);
  const reconciliation = reconcilable.map(({ claim }) => reconciliationFor(claim, changedSurfaces, revision));
  const proposals = reconcilable.map(({ claim }, index) => proposalFor(claim, reconciliation[index], revision)).filter(Boolean);
  const result = {
    schema_version: "1.1",
    flow: "knowledge.living-context",
    input: {
      workspace: input.workspace,
      repository: input.repository,
      revision,
      target_audience: input.target_audience,
      reader: input.reader,
      as_of: ctx.asOf,
      changed_surfaces: changedSurfaces,
      knowledge_roots: input.knowledge_roots.map(({ id, provider, manifest_path }) => ({ id, provider, manifest_path })),
    },
    recalls,
    reconciliation,
    proposals,
    budget: { max_tokens: maxTokens, estimator: "utf8-bytes/4", used_tokens: used, dropped },
    verdict: recalls.some((entry) => entry.status === "unverifiable") || dropped.length > 0 ? "not_verified" : "pass",
    written: [],
  };
  return { result, byId, manifests, repoRoot: resolvedRoot, revision, ctx, candidates };
}

/**
 * Run the Living Context (1.1) recall and reconciliation. Proposals-only: with `write: true` it creates
 * new no-follow files below an explicit private proposalDir and never modifies the repository.
 */
export function runLivingContext({ repoRoot, input, proposalDir, write = true } = {}) {
  const { result } = deriveLivingContext({ repoRoot, input });
  const errors = validateLivingContextResult(result);
  if (errors.length) throw error("INVALID_CONTEXT_CHECK_RESULT", errors.join("; "));
  if (write) writeResult(proposalDir, result);
  const finalErrors = validateLivingContextResult(result);
  if (finalErrors.length) throw error("INVALID_CONTEXT_CHECK_RESULT", finalErrors.join("; "));
  return result;
}
