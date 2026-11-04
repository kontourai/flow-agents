/**
 * Knowledge Kit Living Context (Context Check input/result 1.1).
 *
 * Extends the revision-bound Context Check with the recall contract from kontourai/flow-agents#1131:
 *   - as-of on valid time and knowledge time, aligned with the Surface knowledge-accumulation decision;
 *   - a required reader identity that fails closed (unknown, missing, or undeclared visibility is never widened);
 *     visibility and per-viewer supersession are Surface's (`readDeclaredVisibility`, `visibilityAllows`,
 *     `viewerSupersessionView`, kontourai/surface#350), not a local rule;
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
import { validate } from "../providers/lib/schema-validate.js";
import {
  error, isIdentity, safeRelativePath, resolveRevisionBoundRepository, readManifestDocument, normalizeManifestClaims,
  authorityAtRevision, retrievalProvenance, reconciliationFor, proposalFor, writeResult,
} from "./index.js";

// The kit uses Surface 6 without changing the shared workflow gate's version.
// Standalone installations may instead provide Surface 6 under its usual name.
let Surface;
try {
  Surface = await import("@kontourai/surface-knowledge");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("'@kontourai/surface-knowledge'")) throw error;
  Surface = await import("@kontourai/surface");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/knowledge/living-context-input.schema.json"), "utf8"));
const RESULT_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/knowledge/living-context-result.schema.json"), "utf8"));
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SUPERSESSION_KINDS = new Set(["correction", "succession"]);
const REVIEW_POSTURES = new Set(["proposed", "reviewed"]);
const CLAIM_KEYS = ["visibility", "recorded_at", "valid_time", "supersession_kind", "expires_at", "ttl_seconds", "verified_at", "review", "supersession_recorded_at", "reconciliation_recorded_at", "supersession_visibility", "slot"];

const SURFACE_EXPORTS = ["claimIntrinsicExpiry", "readDeclaredVisibility", "sealedVisibility", "viewerSupersessionView", "visibilityAllows"];

/**
 * Per-viewer visibility is Surface's (kontourai/surface#350). A Surface without it cannot be substituted by a local rule,
 * so a missing export is an explicit refusal naming the requirement, not a cryptic module-load failure.
 */
export function assertSurfaceVisibility(surface = Surface) {
  const missing = SURFACE_EXPORTS.filter((name) => typeof surface?.[name] !== "function");
  if (missing.length) throw error("SURFACE_VISIBILITY_UNAVAILABLE", `Living Context needs @kontourai/surface 6.3.0 or later (derived visibility, kontourai/surface#350); missing: ${missing.join(", ")}`);
}

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

/** The declared visibility of a raw manifest claim, read by Surface; anything unreadable or undeclared is sealed. */
function declaredVisibility(rawClaim) {
  const declaration = Surface.readDeclaredVisibility({ metadata: { visibility: plainObject(rawClaim) ? rawClaim.visibility : undefined } });
  return declaration.state === "declared" ? declaration.visibility : Surface.sealedVisibility();
}

/** Manifest extension for one reader: the reader is admitted (or refused) before any claim is parsed. */
const extensionFor = (reader, knownAtMs) => {
  const viewer = { audiences: [reader] };
  return Object.freeze({
    manifestKeys: new Set(["readers"]),
    claimKeys: new Set(CLAIM_KEYS),
    // Not visible to this reader (by Surface's own decision), or recorded after known_at: it may not describe itself in an error.
    isUnavailableToCaller: (rawClaim) => {
      if (!Surface.visibilityAllows(declaredVisibility(rawClaim), viewer)) return true;
      try { return parseInstant(rawClaim.recorded_at, "recorded_at") > knownAtMs; } catch { return false; }
    },
    parseManifest(parsed, manifestPath) {
      const readers = parsed.readers === undefined ? [] : parsed.readers;
      if (!Array.isArray(readers) || readers.some((entry) => !isIdentity(entry)) || new Set(readers).size !== readers.length) {
        throw error("INVALID_CLAIM_MANIFEST", `${manifestPath}: readers must be a unique array of non-blank identities`);
      }
      if (!readers.includes(reader)) throw error("UNKNOWN_READER_IDENTITY", "reader identity is not recognised by every selected Knowledge root");
      return { readers: new Set(readers) };
    },
    parseClaim(claim, prefix) {
      const visibility = declaredVisibility(claim);
    const recordedAt = claim.recorded_at === undefined ? undefined : parseInstant(claim.recorded_at, `${prefix}.recorded_at`);
    const validTime = claim.valid_time === undefined ? undefined : parseValidTime(claim.valid_time, `${prefix}.valid_time`);
    if (claim.supersession_kind !== undefined && (!SUPERSESSION_KINDS.has(claim.supersession_kind) || claim.superseded_by === undefined)) {
      throw error("INVALID_CLAIM_MANIFEST", `${prefix}.supersession_kind must be correction or succession and requires superseded_by`);
    }
    // The edge is an observation with its own knowledge time; without one it is indeterminate, never guessed.
    const supersessionRecordedAt = claim.supersession_recorded_at === undefined ? undefined : parseInstant(claim.supersession_recorded_at, `${prefix}.supersession_recorded_at`);
    if (claim.supersession_recorded_at !== undefined && claim.superseded_by === undefined) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.supersession_recorded_at requires superseded_by`);
    const reconciliationRecordedAt = claim.reconciliation_recorded_at === undefined ? undefined : parseInstant(claim.reconciliation_recorded_at, `${prefix}.reconciliation_recorded_at`);
    if (claim.reconciliation_recorded_at !== undefined && claim.reconciliation_evidence === undefined) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.reconciliation_recorded_at requires reconciliation_evidence`);
    if (claim.slot !== undefined && !isIdentity(claim.slot)) throw error("INVALID_CLAIM_MANIFEST", `${prefix}.slot must be a non-blank identity`);
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
      visibility,
      recordedAt,
      recordedAtIso: claim.recorded_at,
      validTime,
      supersessionKind: claim.supersession_kind ?? "correction",
      supersessionRecordedAt,
      // Who may see that this claim is superseded (the edge record). Surface requires an explicit decision per edge;
      // absent, it is the visibility of the claim record that carries it, since reading that record shows the pointer.
      // Written but unreadable, it is sealed: the edge is then never followed for anyone.
      supersessionVisibility: claim.supersession_visibility === undefined ? visibility : declaredVisibility({ visibility: claim.supersession_visibility }),
      reconciliationRecordedAt,
      slot: claim.slot,
      expiresAt: claim.expires_at,
      ttlSeconds: claim.ttl_seconds,
      verifiedAt: claim.verified_at,
      verifiedAtMs: claim.verified_at === undefined ? undefined : Date.parse(claim.verified_at),
      review,
    };
  },
  });
};

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
  if (result.verdict === "pass" && result.recalls.length === 0) errors.push("$/verdict: pass is invalid without any recall");
  if (plainObject(result.input?.as_of)) {
    for (const key of ["now", "valid_at", "known_at"]) {
      try { parseInstant(result.input.as_of[key], `input.as_of.${key}`); } catch (cause) { errors.push(`$/input/as_of/${key}: ${cause.message}`); }
    }
  }
  if (plainObject(result.budget)) {
    const total = result.recalls.reduce((sum, recall) => sum + estimateTokens(recall), 0);
    if (result.budget.used_tokens !== total) errors.push("$/budget/used_tokens: must equal the estimated tokens of the returned recalls");
    if (result.budget.used_tokens > result.budget.max_tokens) errors.push("$/budget/used_tokens: must not exceed max_tokens");
  }
  for (const [index, recall] of result.recalls.entries()) {
    if (recall?.status === "current" && recall.freshness?.stale === true) errors.push(`$/recalls/${index}: a stale recall must not be current`);
    if (plainObject(recall?.freshness)) {
      const { as_of: asOf, expires_at: expiresAt, stale } = recall.freshness;
      let boundNow;
      try { boundNow = new Date(parseInstant(result.input?.as_of?.now, "input.as_of.now")).toISOString(); } catch { boundNow = undefined; }
      if (boundNow !== undefined && asOf !== boundNow) errors.push(`$/recalls/${index}: freshness.as_of must equal input.as_of.now`);
      for (const [key, value] of [["as_of", asOf], ["expires_at", expiresAt]]) {
        if (value === undefined) continue;
        try { parseInstant(value, `freshness.${key}`); } catch (cause) { errors.push(`$/recalls/${index}: ${cause.message}`); }
      }
      // The reason implies the flag. The flag alone does not imply the reason: a superseded claim can also be stale.
      if (Array.isArray(recall.reasons) && recall.reasons.includes("stale_at_as_of") && stale !== true) errors.push(`$/recalls/${index}: the stale_at_as_of reason requires freshness.stale`);
      if (expiresAt === undefined && stale === true) errors.push(`$/recalls/${index}: freshness cannot be stale without an expiry`);
      if (expiresAt !== undefined && stale !== (Date.parse(asOf) > Date.parse(expiresAt))) errors.push(`$/recalls/${index}: freshness.stale must equal as_of > expires_at`);
    }
    if (Array.isArray(recall?.reasons)) {
      const has = (code) => recall.reasons.includes(code);
      const unverifiableCodes = ["knowledge_time_unknown", "supersession_cycle", "supersession_time_unknown", "succession_boundary_unknown", "supersession_slot_mismatch", "supersession_ambiguous", "declared_unverifiable", "stale_at_as_of"];
      if (recall.status === "current" && (!has("current_at_as_of") || has("superseded_by_known_successor") || unverifiableCodes.some(has))) errors.push(`$/recalls/${index}: reasons contradict a current status`);
      if (recall.status === "superseded" && !(recall.reasons.length === 1 && has("superseded_by_known_successor"))) errors.push(`$/recalls/${index}: reasons contradict a superseded status`);
      if (recall.status === "unverifiable" && recall.reason === undefined && (has("current_at_as_of") || has("superseded_by_known_successor") || !unverifiableCodes.some(has))) errors.push(`$/recalls/${index}: reasons contradict an unverifiable status`);
    }
    if (Array.isArray(recall?.supersession_chain)) {
      const self = recall.supersession_chain.filter((link) => link.relation === "self");
      if (self.length !== 1 || self[0].claim_id !== recall.claim_id) errors.push(`$/recalls/${index}: the supersession chain must contain this claim exactly once as self`);
    }
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

function indexClaims(manifests, ctx) {
  const copies = new Map();
  for (const claim of manifests.flatMap((manifest) => manifest.claims)) copies.set(claim.id, [...(copies.get(claim.id) ?? []), claim]);
  const byId = new Map();
  const ambiguous = new Set();
  for (const [id, group] of copies) {
    // A reader's view of an id is built only from copies they may see: a hidden copy never changes their answer
    // and cannot be observed, and never discards a visible one.
    const seen = group.filter((claim) => isVisible(claim, ctx));
    const entitled = seen.filter((claim) => isKnown(claim, ctx));
    if (entitled.length > 1) throw error("DUPLICATE_CLAIM_ID", `claim id '${id}' appears more than once across the selected Knowledge roots`);
    if (entitled.length === 1) byId.set(id, entitled[0]);
    // Visible but not yet known: the reader's own claim, which stays unknown at known_at.
    else if (seen.length > 0) byId.set(id, seen[0]);
    // Every copy hidden and they conflict: no copy can stand for the id, and no combination of them is safe (a union
    // can create a hidden cycle that makes Surface drop a real supersession). The id is ambiguous and is left out of
    // the structure; a visible claim whose chain reaches it cannot be answered (see reachesAmbiguous).
    else if (group.length > 1) ambiguous.add(id);
    else byId.set(id, group[0]);
  }
  return { byId, ambiguous };
}

const viewerOf = (ctx) => ({ audiences: [ctx.reader] });
const edgeVisible = (claim, ctx) => Surface.visibilityAllows(claim.extension.supersessionVisibility, viewerOf(ctx));
const isVisible = (claim, ctx) => Surface.visibilityAllows(claim.extension.visibility, viewerOf(ctx));
/** Known at known_at: recorded by then, or not yet timed (an untimed claim is indeterminate, not absent). */
const isKnown = (claim, ctx) => !(claim.extension.recordedAt !== undefined && claim.extension.recordedAt > ctx.knownAt);

/**
 * State of the supersession edge claim -> successor at the as-of instants, from the observations alone.
 * Only `active` edges are replacements; every other state explains why an edge is not followed.
 */
function edgeState(claim, successor, ctx) {
  if (claim.superseded_by === undefined) return { state: "none" };
  // The edge is an observation with its own recording time, read from the carrying (predecessor) claim.
  const edgeRecordedAt = claim.extension.supersessionRecordedAt;
  if (edgeRecordedAt === undefined) return { state: "unknown_time" };
  if (edgeRecordedAt > ctx.knownAt) return { state: "not_known" };
  if (!successor) return { state: "unresolved" };
  if (successor.extension.recordedAt === undefined) return { state: "unknown_time" };
  if (successor.extension.recordedAt > ctx.knownAt) return { state: "not_known" };
  // A replacement joins one property slot (Surface); a cross-slot or unslotted edge is inert.
  if (claim.extension.slot === undefined || claim.extension.slot !== successor.extension.slot) return { state: "slot_mismatch" };
  const kind = claim.extension.supersessionKind;
  if (kind === "correction") {
    // A correction says the old assertion was wrong for the corrected interval: the successor's valid interval.
    const interval = successor.extension.validTime;
    const inside = !interval || ((interval.from === undefined || ctx.validAt >= interval.from) && (interval.until === undefined || ctx.validAt < interval.until));
    return { state: inside ? "active" : "inactive", kind };
  }
  const from = successor.extension.validTime?.from;
  if (from === undefined) return { state: "unknown_boundary", kind };
  return { state: from <= ctx.validAt ? "active" : "inactive", kind };
}

/**
 * Per-viewer supersession (kontourai/surface#350). Edges admitted at the as-of instants (time, slot, kind) are
 * handed to Surface's `viewerSupersessionView`, which alone decides what this reader may see: an edge applies only
 * to a viewer who may see its successor, chains through hidden claims collapse, and a cycle leaves its claims
 * unresolved. The edge's own visibility is that of the claim record that carries it (the predecessor).
 */
function evaluateSupersession(byId, ambiguous, ctx) {
  const visibilityByClaimId = new Map();
  for (const claim of byId.values()) if (isKnown(claim, ctx)) visibilityByClaimId.set(claim.id, claim.extension.visibility);
  const states = new Map();
  const edges = [];
  for (const claim of byId.values()) {
    if (claim.superseded_by === undefined) continue;
    const successor = byId.get(claim.superseded_by);
    const state = edgeState(claim, successor, ctx);
    states.set(claim.id, { ...state, successor });
    if (state.state === "active") edges.push({ predecessorId: claim.id, successorId: successor.id, visibility: claim.extension.supersessionVisibility });
  }
  const view = Surface.viewerSupersessionView({ visibilityByClaimId, edges, viewer: viewerOf(ctx) });
  return { view, states, ambiguous, byId };
}

/**
 * Whether following this claim's recorded, visible edges through hidden claims reaches an ambiguous id. Such a claim
 * cannot be called current (the edge it might have is unknowable) or superseded (nothing can stand for the successor),
 * so it is unverifiable. This tells the reader only that their own claim's chain is unresolvable.
 */
function reachesAmbiguous(claim, supersession, ctx) {
  const { byId, ambiguous } = supersession;
  const seen = new Set([claim.id]);
  for (let current = claim; ;) {
    const next = current.superseded_by;
    const recordedAt = current.extension.supersessionRecordedAt;
    if (next === undefined || recordedAt === undefined || recordedAt > ctx.knownAt || !edgeVisible(current, ctx)) return false;
    if (ambiguous.has(next)) return true;
    const target = byId.get(next);
    // Dangling, or a claim the reader can see: ordinary handling applies from here.
    if (!target || isVisible(target, ctx) || seen.has(next)) return false;
    seen.add(next);
    current = target;
  }
}

/** What a non-active edge says about a visible claim. Only a successor this reader may see can explain anything. */
function edgeAnnotation(claim, supersession, ctx) {
  const state = supersession.states.get(claim.id);
  // Only an edge this reader may see, to a successor they may see, can explain anything about the claim.
  if (!state || state.state === "active" || !state.successor || !isVisible(state.successor, ctx) || !edgeVisible(claim, ctx)) return {};
  switch (state.state) {
    case "unknown_time": return { unverifiable: "supersession_time_unknown" };
    case "unknown_boundary": return { unverifiable: "succession_boundary_unknown" };
    case "slot_mismatch": return { unverifiable: "supersession_slot_mismatch" };
    case "not_known": return { note: "successor_not_known_at_as_of" };
    case "inactive": return { note: state.kind === "correction" ? "correction_interval_excludes_valid_at" : "succession_not_effective_at_valid_at" };
    default: return {};
  }
}

function supersessionChain(claim, byId, supersession, ctx) {
  const { view, states } = supersession;
  const listed = (candidate) => candidate && isVisible(candidate, ctx) && isKnown(candidate, ctx);
  const kindOf = (id) => byId.get(id)?.extension.supersessionKind;
  const direct = (fromId, toId) => states.get(fromId)?.successor?.id === toId && states.get(fromId).state === "active";
  const forward = [];
  const seen = new Set([claim.id]);
  for (let current = claim.id; ;) {
    const next = view.supersededBy[current]?.[0];
    if (next !== undefined && !seen.has(next)) {
      seen.add(next);
      forward.push({ claim_id: next, relation: "superseded_by", ...(direct(current, next) ? { kind: kindOf(current) } : {}), active: true });
      current = next;
      continue;
    }
    const state = states.get(current);
    if (state?.state === "inactive" && listed(state.successor) && edgeVisible(byId.get(current), ctx)) forward.push({ claim_id: state.successor.id, relation: "superseded_by", kind: state.kind, active: false });
    break;
  }
  const backward = [];
  const reached = new Set([claim.id]);
  let frontier = [claim.id];
  while (frontier.length) {
    const next = [];
    for (const target of frontier) {
      for (const candidate of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (reached.has(candidate.id) || !listed(candidate) || candidate.extension.recordedAt === undefined) continue;
        const active = view.supersededBy[candidate.id]?.includes(target);
        const state = states.get(candidate.id);
        // An inactive edge into a claim that is itself outside its valid interval is still reachable: the claim
        // may be superseded further on (supersession is judged before validity), so its history keeps the link.
        const inactive = state?.state === "inactive" && state.successor?.id === target && edgeVisible(candidate, ctx);
        if (!active && !inactive) continue;
        reached.add(candidate.id);
        backward.unshift({ claim_id: candidate.id, relation: "supersedes", ...(active && direct(candidate.id, target) || inactive ? { kind: kindOf(candidate.id) } : {}), active: Boolean(active) });
        next.push(candidate.id);
      }
    }
    frontier = next;
  }
  return [...backward, { claim_id: claim.id, relation: "self" }, ...forward];
}

function freshnessFor(claim, ctx) {
  // Surface resolves the intrinsic window (expiresAt wins; ttlSeconds is anchored on verification, else recording).
  // A verification after known_at has not happened yet at that knowledge instant and cannot anchor a TTL.
  const verifiedAt = claim.extension.verifiedAtMs !== undefined && claim.extension.verifiedAtMs <= ctx.knownAt ? claim.extension.verifiedAt : undefined;
  const expiryMs = Surface.claimIntrinsicExpiry(
    { verifiedAt, createdAt: claim.extension.recordedAtIso },
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

/** Half-open [from, until): is valid_at outside the interval the claim asserts? An absent bound is unbounded. */
function outsideValidTime(claim, ctx) {
  const validTime = claim.extension.validTime;
  return Boolean(validTime && ((validTime.from !== undefined && ctx.validAt < validTime.from) || (validTime.until !== undefined && ctx.validAt >= validTime.until)));
}

function recallFor(claim, input, changedSurfaces, byId, supersession, ctx, revision) {
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
    supersession_chain: supersessionChain(claim, byId, supersession, ctx),
    reasons,
  });
  // Knowledge time first: an unknown instant is indeterminate and is never guessed (Surface).
  if (claim.extension.recordedAt === undefined) return entry("unverifiable", ["knowledge_time_unknown"]);
  const { view } = supersession;
  if (reachesAmbiguous(claim, supersession, ctx)) return entry("unverifiable", ["supersession_ambiguous"]);
  // A cycle among claims this reader can see selects no winner.
  if (view.unresolvedClaimIds.includes(claim.id)) return entry("unverifiable", ["supersession_cycle"]);
  // The stored status is never served as is: supersession is whatever Surface's view of this reader says, so a
  // successor the reader cannot see leaves the claim current for them, with no trace of it.
  const successor = view.supersededBy[claim.id]?.[0];
  if (successor !== undefined) return entry("superseded", ["superseded_by_known_successor"], { superseded_by: successor });
  const annotation = edgeAnnotation(claim, supersession, ctx);
  if (annotation.unverifiable) return entry("unverifiable", [annotation.unverifiable]);
  const reasons = annotation.note ? [annotation.note] : [];
  if (outsideValidTime(claim, ctx)) return { kind: "not_valid" };
  if (claim.status === "unverifiable") return entry("unverifiable", [...reasons, "declared_unverifiable"]);
  if (freshnessFor(claim, ctx).stale) return entry("unverifiable", [...reasons, "stale_at_as_of"]);
  return entry("current", [...reasons, "current_at_as_of"]);
}

function orderedRequestIds(input, byId, changedSurfaces, ctx) {
  if (input.claim_ids) return input.claim_ids;
  // A claim recorded after known_at does not exist yet at that instant and must not be named by a scan.
  const visible = [...byId.values()].filter((claim) => isVisible(claim, ctx) && isKnown(claim, ctx));
  if (visible.length === 0) return ["no-matching-claims"];
  const overlaps = (claim) => claim.affected_surfaces.some((surface) => changedSurfaces.includes(surface));
  return visible.sort((a, b) => Number(overlaps(b)) - Number(overlaps(a)) || a.id.localeCompare(b.id)).map((claim) => claim.id);
}

/**
 * Pure Living Context derivation (no writes). Exposed so the answer step re-derives recall itself
 * instead of trusting a caller-supplied result.
 */
export function deriveLivingContext({ repoRoot, input }) {
  assertSurfaceVisibility();
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
  const extension = extensionFor(input.reader, ctx.knownAt);
  // Phase one admits the reader at every root before phase two parses a single claim of any root.
  const documents = input.knowledge_roots.map((knowledgeRoot) => readManifestDocument(resolvedRoot, revision, knowledgeRoot, extension));
  const manifests = documents.map((document, index) => normalizeManifestClaims(document, input.knowledge_roots[index], extension));
  const { byId, ambiguous } = indexClaims(manifests, ctx);
  const supersession = evaluateSupersession(byId, ambiguous, ctx);
  const requestedIds = orderedRequestIds(input, byId, changedSurfaces, ctx);

  const candidates = requestedIds.map((claimId) => {
    const claim = byId.get(claimId);
    // Absent, hidden from this reader, and not yet known at known_at are indistinguishable: one plain no-answer.
    if (!claim || !isVisible(claim, ctx) || !isKnown(claim, ctx)) {
      return { claimId, entry: noAnswer(claimId, revision, input.knowledge_roots), claim: undefined };
    }
    const recalled = recallFor(claim, input, changedSurfaces, byId, supersession, ctx, revision);
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
  // A claim whose recall is unverifiable as of the instants (stale, untimed, outside its valid interval, ...)
  // stays unverifiable in reconciliation; the declared head status must not turn it back into an ordinary affected claim.
  // Contradiction evidence is an observation too: unrecorded, or recorded after known_at, it does not count yet.
  const view = ({ claim }) => {
    const evidenceKnown = claim.extension.reconciliationRecordedAt !== undefined && claim.extension.reconciliationRecordedAt <= ctx.knownAt;
    const { reconciliation_evidence: evidence, ...rest } = claim;
    const known = evidence && evidenceKnown ? { ...rest, reconciliation_evidence: evidence } : rest;
    // Only facts about the claim itself turn reconciliation unverifiable: it was never timed, it is stale at now, or
    // it asserts nothing at valid_at (a claim that declares itself unverifiable already reconciles as such). They are judged from the claim, not read
    // back from the recall's winning reason, because supersession trouble (a cycle, an ambiguous id, a missing edge
    // time) outranks them in recall and says nothing about whether the change contradicts the claim.
    const intrinsicallyUnverifiable = claim.extension.recordedAt === undefined || freshnessFor(claim, ctx).stale || outsideValidTime(claim, ctx);
    return intrinsicallyUnverifiable && known.status !== "unverifiable" ? { ...known, status: "unverifiable" } : known;
  };
  const reconciliation = reconcilable.map((candidate) => reconciliationFor(view(candidate), changedSurfaces, revision));
  const proposals = reconcilable.map((candidate, index) => proposalFor(view(candidate), reconciliation[index], revision)).filter(Boolean);
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
