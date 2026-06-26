/**
 * Knowledge Kit — Flow Runner
 *
 * Executable flow logic that implements the knowledge.ingest, knowledge.compile,
 * and knowledge.synthesize flows against a KnowledgeStoreAdapter. This is the
 * callable entry point for S5's live agent tools.
 *
 * Zero runtime dependencies beyond Node.js built-ins.
 *
 * Exports:
 *   - KnowledgeFlowRunner  (class)
 *   - capture(rawText, meta, options)   — ingest flow: capture → classify → store as raw
 *   - compile(rawIds[], options)        — compile flow: select → compile → link with provenance
 *   - synthesize(conceptId | topicSelector, options) — synthesize flow:
 *       detect-cluster → propose → evidence-gate → apply-or-reject
 *   - retire(recordId, options)          — retire flow: identify → propose → evidence-gate → apply-or-reject
 *   - defaultSimilarityDetector         — pluggable similarity interface default (R3)
 *
 * Telemetry:
 *   Gate events are emitted to <workspace>/.telemetry/full.jsonl using
 *   canonical schema v0.3.0 events (preToolUse at gate entry, postToolUse at gate exit).
 *
 * Similarity Interface (R3):
 *   A SimilarityDetector is a function with the signature:
 *     async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
 *   It receives the target concept, all compiled candidates, and the store for link lookups.
 *   It returns an array of record IDs deemed similar (the cluster).
 *   The default implementation (defaultSimilarityDetector) uses:
 *     - category match: candidate.category === concept.category (or prefix match)
 *     - link-overlap heuristic: |shared target_ids| / |union target_ids| >= threshold
 *
 * @module adapters/flow-runner
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeTelemetry } from "./telemetry.js";
import {
  defaultEntityExtractor,
  normalizeName,
  isExactMatch,
  isPossibleDuplicate,
} from "./entity-extractor.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function missingEvidenceError(message) {
  const err = new Error(message);
  err.code = "MISSING_EVIDENCE";
  return err;
}

// ---------------------------------------------------------------------------
// Freshness-audit helpers  (knowledge.audit-freshness — #106)
// ---------------------------------------------------------------------------

/**
 * The authoritative "last mutation" instant for a record: the most recent of
 * the record's `updated_at` and its latest `mutation_log` entry `at`. Both are
 * refreshed by every mutating op (store contract §1.1 / §4.2); taking the later
 * of the two is robust even if an adapter lags one behind the other. Falls back
 * to `created_at` when neither is present.
 *
 * @param {object} record
 * @returns {string} ISO-8601 timestamp
 */
function lastMutationOf(record) {
  const candidates = [];
  if (record.updated_at) candidates.push(record.updated_at);
  const log = Array.isArray(record.mutation_log) ? record.mutation_log : [];
  for (const entry of log) {
    if (entry && entry.at) candidates.push(entry.at);
  }
  if (candidates.length === 0) return record.created_at || record.updated_at || "";
  // Lexicographic max works for ISO-8601 UTC timestamps.
  return candidates.reduce((max, t) => (t > max ? t : max));
}

/**
 * Resolve the staleness threshold for a category using dot-hierarchy
 * longest-prefix matching: a record in `radar.signals.weak` prefers a
 * `radar.signals` threshold over a `radar` one, then falls back to
 * `defaultThresholdDays`. Returns `null` when no threshold applies (the
 * category is then skipped — auditing is opt-in).
 *
 * @param {string} category
 * @param {Record<string, number>} thresholds
 * @param {number|null} defaultThresholdDays
 * @returns {{ thresholdDays: number, matchedKey: string } | null}
 */
function resolveThreshold(category, thresholds, defaultThresholdDays) {
  const segments = (category || "").split(".");
  for (let i = segments.length; i > 0; i -= 1) {
    const key = segments.slice(0, i).join(".");
    if (Object.prototype.hasOwnProperty.call(thresholds, key)) {
      return { thresholdDays: thresholds[key], matchedKey: key };
    }
  }
  if (defaultThresholdDays !== null && defaultThresholdDays !== undefined) {
    return { thresholdDays: defaultThresholdDays, matchedKey: "*" };
  }
  return null;
}

/**
 * Resolve the proposed action ("archive" | "refresh") for a flagged record's
 * category, using the same dot-hierarchy longest-prefix matching, falling back
 * to `defaultAction`.
 *
 * @param {string} category
 * @param {Record<string, "archive"|"refresh">} actions
 * @param {"archive"|"refresh"} defaultAction
 * @returns {"archive"|"refresh"}
 */
function resolveAction(category, actions, defaultAction) {
  const segments = (category || "").split(".");
  for (let i = segments.length; i > 0; i -= 1) {
    const key = segments.slice(0, i).join(".");
    if (Object.prototype.hasOwnProperty.call(actions, key)) {
      return actions[key];
    }
  }
  return defaultAction;
}

// ---------------------------------------------------------------------------
// Category-canonicalization helpers  (knowledge.canonicalize-category — #106)
// ---------------------------------------------------------------------------

/**
 * The set of distinct dot-prefixes a category contributes, from its own full
 * path down to (but NOT including) the empty root. `radar.signals.weak` yields
 * `["radar", "radar.signals", "radar.signals.weak"]`. Used to build the
 * category tree (which prefixes are *nodes*) and to find which prefixes hold a
 * record directly vs. only via descendants.
 *
 * @param {string} category
 * @returns {string[]}
 */
function categoryPrefixes(category) {
  const segments = (category || "").split(".").filter(Boolean);
  const out = [];
  for (let i = 1; i <= segments.length; i += 1) {
    out.push(segments.slice(0, i).join("."));
  }
  return out;
}

/**
 * The immediate parent prefix of a category, or "" for a top-level category.
 * `radar.signals.weak` → `radar.signals`; `radar` → "".
 *
 * @param {string} category
 * @returns {string}
 */
function parentPrefix(category) {
  const segments = (category || "").split(".").filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join(".");
}

/**
 * Does a record count as "implemented-but-active" sprawl? A record is flagged
 * when its status is still `"active"` yet it carries one of the operator-
 * supplied "implemented" marker tags (e.g. `implemented`, `shipped`, `done`) —
 * it should have transitioned to `implemented`/`retired` via `retire` but never
 * did, so it lingers in the working set. Marker matching is case-insensitive.
 *
 * @param {object} record
 * @param {Set<string>} markerSet  lower-cased implemented-marker tags
 * @returns {boolean}
 */
function isImplementedButActive(record, markerSet) {
  if (markerSet.size === 0) return false;
  if ((record.status || "active") !== "active") return false;
  const tags = Array.isArray(record.tags) ? record.tags : [];
  return tags.some((t) => markerSet.has(String(t).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Classification heuristics
// ---------------------------------------------------------------------------

// Infer a category from raw text and provided meta. The caller may supply
// category directly in meta; otherwise we derive it from keywords.
function inferCategory(rawText, meta) {
  if (meta?.category) return meta.category;

  const text = (rawText || "").toLowerCase();

  // Simple keyword-based classifier — good enough for an ingest gate
  if (/\b(api|rest|graphql|endpoint|http)\b/.test(text)) return "engineering.api";
  if (/\b(test|spec|unit|assertion)\b/.test(text)) return "engineering.testing";
  if (/\b(architecture|design|pattern|system)\b/.test(text)) return "engineering.architecture";
  if (/\b(meeting|standup|decision|action item)\b/.test(text)) return "team.meeting";
  if (/\b(research|study|paper|finding)\b/.test(text)) return "research.notes";
  if (/\b(bug|fix|issue|error|exception)\b/.test(text)) return "engineering.bugs";
  if (/\b(deploy|release|version|ci|cd)\b/.test(text)) return "engineering.ops";

  return "general";
}

// Derive a title from the raw text (first line, truncated)
function inferTitle(rawText, meta) {
  if (meta?.title) return meta.title;
  const firstLine = (rawText || "").split("\n")[0].trim().slice(0, 80);
  return firstLine || "Untitled capture";
}

// ---------------------------------------------------------------------------
// Similarity detection — pluggable interface (R3)
// ---------------------------------------------------------------------------

/**
 * Default similarity detector: category match + link-overlap heuristic.
 *
 * SimilarityDetector interface:
 *   async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
 *
 * Returns the IDs of candidates deemed similar to the concept.
 *
 * Algorithm (v1):
 *   1. Category match: candidate.category starts with concept.category (prefix match)
 *      OR concept.category starts with candidate.category. Excludes non-matches unless
 *      the threshold is lowered.
 *   2. Link-overlap: compute Jaccard similarity of outbound link target_ids between
 *      concept and candidate. Candidates with Jaccard >= LINK_OVERLAP_THRESHOLD are
 *      included.
 *   3. A candidate passes if it satisfies EITHER criterion.
 *
 * @param {object} concept    - concept record
 * @param {object[]} candidates - compiled records
 * @param {object} store      - KnowledgeStoreAdapter (for getLinks)
 * @returns {Promise<string[]>} IDs of similar compiled records
 */
export async function defaultSimilarityDetector(concept, candidates, store) {
  const LINK_OVERLAP_THRESHOLD = 0.1; // Jaccard threshold for link overlap

  const conceptLinks = await store.getLinks(concept.id);
  const conceptTargets = new Set(
    (conceptLinks.forward || []).map((l) => l.target_id)
  );

  const similar = [];

  for (const candidate of candidates) {
    // Exclude retired records from the working set (Addendum B — R3)
    if ((candidate.status || "active") === "retired") continue;

    // Check 1: category overlap (prefix match in either direction)
    const catMatch =
      candidate.category === concept.category ||
      candidate.category.startsWith(`${concept.category}.`) ||
      concept.category.startsWith(`${candidate.category}.`);

    // Check 2: link-overlap heuristic (Jaccard similarity of outbound link targets)
    let jaccard = 0;
    if (conceptTargets.size > 0) {
      const candidateLinks = await store.getLinks(candidate.id);
      const candidateTargets = new Set(
        (candidateLinks.forward || []).map((l) => l.target_id)
      );
      const intersection = [...conceptTargets].filter((t) => candidateTargets.has(t));
      const union = new Set([...conceptTargets, ...candidateTargets]);
      jaccard = union.size > 0 ? intersection.length / union.size : 0;
    }

    if (catMatch || jaccard >= LINK_OVERLAP_THRESHOLD) {
      similar.push(candidate.id);
    }
  }

  return similar;
}

// ---------------------------------------------------------------------------
// KnowledgeFlowRunner
// ---------------------------------------------------------------------------

export class KnowledgeFlowRunner {
  /**
   * @param {{
   *   store: KnowledgeStoreAdapter,
   *   workspace?: string,
   *   agent?: string,
   *   sessionId?: string
   * }} options
   */
  constructor({ store, workspace, agent, sessionId } = {}) {
    if (!store) throw new Error("KnowledgeFlowRunner: store adapter is required");
    this._store = store;
    this._agent = agent || "knowledge-flow-runner";
    this._telemetry = new KnowledgeTelemetry({
      workspace,
      agentName: this._agent,
      sessionId,
    });
  }

  // -------------------------------------------------------------------------
  // knowledge.ingest flow
  //   Steps: capture → classify → route → done
  //   Gate: classify-gate — classification recorded (category + type=raw)
  // -------------------------------------------------------------------------

  /**
   * Execute the ingest flow: capture raw text, classify it, store as a raw
   * record, and route it.
   *
   * @param {string} rawText  - the raw content to capture
   * @param {object} [meta]   - optional metadata overrides:
   *   - title: string       - record title (inferred from first line if absent)
   *   - category: string    - dot-separated category (inferred if absent)
   *   - tags: string[]      - tag list
   *   - agent: string       - override agent name
   *   - session_id: string  - session identifier
   *   - note: string        - provenance note
   * @returns {Promise<{ id: string, record: object, telemetryEvents: object[] }>}
   */
  async capture(rawText, meta = {}) {
    const events = [];

    // ── Step: capture ──────────────────────────────────────────────────────
    if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
      throw missingEvidenceError("capture: rawText must be a non-empty string");
    }

    // ── Gate: classify-gate ────────────────────────────────────────────────
    // Evidence required: category (non-empty) + type="raw"
    const category = inferCategory(rawText, meta);
    const title = inferTitle(rawText, meta);

    const gateContext = {
      flow: "knowledge.ingest",
      gate: "classify-gate",
      evidence: {
        type: "raw",
        category,
        title,
      },
    };

    // Emit gate entry event (preToolUse)
    const gateInEvent = this._telemetry.emitGate("knowledge.ingest", "classify-gate", gateContext);
    events.push(gateInEvent);

    // Enforce gate: category must be valid (non-empty, proper format)
    if (!category || typeof category !== "string" || !category.trim()) {
      throw missingEvidenceError("classify-gate: classification failed — category is empty");
    }
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(category)) {
      throw missingEvidenceError(`classify-gate: classification failed — invalid category: ${category}`);
    }

    // ── Step: classify — create the raw record in the store ────────────────
    const provenance = {
      agent: meta?.agent || this._agent,
      ...(meta?.session_id ? { session_id: meta.session_id } : {}),
      ...(meta?.note ? { note: meta.note } : {}),
    };

    const recordId = await this._store.create({
      type: "raw",
      title,
      body: rawText,
      category,
      tags: meta?.tags || [],
      provenance,
    });

    // Emit gate exit event (postToolUse) — classification recorded
    const gateOutEvent = this._telemetry.emitGateResult("knowledge.ingest", "classify-gate", {
      record_id: recordId,
      type: "raw",
      category,
      title,
    });
    events.push(gateOutEvent);

    // ── Step: route — record routing decision ─────────────────────────────
    // Default routing: queue for compilation (operator can override via meta.routing)
    const routing = meta?.routing || "queue-for-compile";

    const routeGateInEvent = this._telemetry.emitGate("knowledge.ingest", "route-gate", {
      flow: "knowledge.ingest",
      gate: "route-gate",
      record_id: recordId,
      routing_decision: routing,
    });
    events.push(routeGateInEvent);

    const routeGateOutEvent = this._telemetry.emitGateResult("knowledge.ingest", "route-gate", {
      record_id: recordId,
      routing_decision: routing,
    });
    events.push(routeGateOutEvent);

    const record = await this._store.get(recordId);
    return { id: recordId, record, telemetryEvents: events };
  }

  // -------------------------------------------------------------------------
  // knowledge.compile flow
  //   Steps: select-raws → compile → link → done
  //   Gate: compile-gate — compiled record carries provenance refs to EVERY
  //         consumed raw (provenance.source_ids + source links)
  // -------------------------------------------------------------------------

  /**
   * Execute the compile flow: select raw records, compile them into a
   * normalized note, create the compiled record with full provenance, and
   * verify all provenance refs resolve.
   *
   * @param {string[]} rawIds  - IDs of raw records to compile
   * @param {object} [options]
   *   - title: string         - title for the compiled record
   *   - body: string          - compiled body (if omitted, concatenates raw bodies)
   *   - category: string      - category (defaults to most common raw category)
   *   - tags: string[]        - tags
   *   - agent: string         - override agent
   *   - session_id: string    - session id
   *   - note: string          - provenance note
   * @returns {Promise<{ id: string, record: object, telemetryEvents: object[] }>}
   */
  async compile(rawIds, options = {}) {
    const events = [];

    // ── Step: select-raws ──────────────────────────────────────────────────
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw missingEvidenceError("compile: rawIds must be a non-empty array");
    }

    // Emit select-raws gate entry
    const selectGateIn = this._telemetry.emitGate("knowledge.compile", "select-raws-gate", {
      flow: "knowledge.compile",
      gate: "select-raws-gate",
      raw_ids: rawIds,
    });
    events.push(selectGateIn);

    // Fetch all raw records — reject if any is missing or not type=raw
    const rawRecords = [];
    for (const rawId of rawIds) {
      const rec = await this._store.get(rawId);
      if (!rec) {
        throw missingEvidenceError(`select-raws-gate: raw record not found: ${rawId}`);
      }
      if (rec.type !== "raw") {
        throw missingEvidenceError(`select-raws-gate: record ${rawId} is type="${rec.type}", expected "raw"`);
      }
      rawRecords.push(rec);
    }

    const selectGateOut = this._telemetry.emitGateResult("knowledge.compile", "select-raws-gate", {
      raw_ids: rawIds,
      count: rawRecords.length,
    });
    events.push(selectGateOut);

    // ── Step: compile ──────────────────────────────────────────────────────
    // Build compiled body from raws if not provided
    const compiledBody = options.body
      || rawRecords.map((r) => `## ${r.title}\n\n${r.body}`).join("\n\n---\n\n");

    // Determine category: use option, or most-common raw category
    const compiledCategory = options.category || mostCommonCategory(rawRecords);

    const compiledTitle = options.title
      || (rawRecords.length === 1
        ? `Compiled: ${rawRecords[0].title}`
        : `Compiled from ${rawRecords.length} sources`);

    // Build source links — one per raw record with kind="source"
    const sourceLinks = rawIds.map((rawId) => ({
      target_id: rawId,
      kind: "source",
    }));

    // Provenance: source_ids must list EVERY consumed raw ID
    const provenance = {
      agent: options.agent || this._agent,
      source_ids: rawIds,   // ← required by compile-gate
      ...(options.session_id ? { session_id: options.session_id } : {}),
      ...(options.note ? { note: options.note } : {}),
    };

    // ── Gate: compile-gate — emit before store.create ─────────────────────
    const compileGateIn = this._telemetry.emitGate("knowledge.compile", "compile-gate", {
      flow: "knowledge.compile",
      gate: "compile-gate",
      evidence: {
        source_ids: rawIds,
        source_links: sourceLinks,
        category: compiledCategory,
      },
    });
    events.push(compileGateIn);

    // Enforce: provenance.source_ids must cover ALL rawIds
    if (!provenance.source_ids || provenance.source_ids.length !== rawIds.length) {
      throw missingEvidenceError(
        `compile-gate: provenance.source_ids must list every consumed raw ID; ` +
        `expected ${rawIds.length} entries, got ${provenance.source_ids?.length ?? 0}`
      );
    }

    const compiledId = await this._store.create({
      type: "compiled",
      title: compiledTitle,
      body: compiledBody,
      category: compiledCategory,
      tags: options.tags || [],
      links: sourceLinks,
      provenance,
    });

    const compileGateOut = this._telemetry.emitGateResult("knowledge.compile", "compile-gate", {
      compiled_id: compiledId,
      source_ids: rawIds,
      source_link_count: sourceLinks.length,
    });
    events.push(compileGateOut);

    // ── Step: link — verify provenance refs resolve ────────────────────────
    const linkGateIn = this._telemetry.emitGate("knowledge.compile", "link-gate", {
      flow: "knowledge.compile",
      gate: "link-gate",
      compiled_id: compiledId,
      expected_raw_ids: rawIds,
    });
    events.push(linkGateIn);

    // Verify: every provenance ref resolves via store.get()
    for (const rawId of rawIds) {
      const ref = await this._store.get(rawId);
      if (!ref) {
        throw missingEvidenceError(`link-gate: provenance ref ${rawId} does not resolve`);
      }
    }

    // Verify: graph index reflects source links
    const { forward } = await this._store.getLinks(compiledId);
    for (const rawId of rawIds) {
      const hasSourceLink = forward.some(
        (l) => l.target_id === rawId && l.kind === "source"
      );
      if (!hasSourceLink) {
        throw missingEvidenceError(
          `link-gate: source link to raw ${rawId} missing from graph index`
        );
      }
    }

    const linkGateOut = this._telemetry.emitGateResult("knowledge.compile", "link-gate", {
      compiled_id: compiledId,
      resolved_raw_ids: rawIds,
      graph_links_verified: rawIds.length,
    });
    events.push(linkGateOut);

    const record = await this._store.get(compiledId);
    return { id: compiledId, record, telemetryEvents: events };
  }

  // -------------------------------------------------------------------------
  // knowledge.synthesize flow
  //   Steps: detect-cluster → propose → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries source refs; no direct mutation (AC1)
  //         apply-gate    — apply or reject via store ops only (never direct write)
  //                         rejection leaves concept byte-identical (AC2)
  //                         apply updates with provenance to all sources (AC3)
  // -------------------------------------------------------------------------

  /**
   * Execute the synthesize flow: detect similar compiled records, create a
   * proposal via the store's propose op (never a direct mutation), gate the
   * evidence, then apply or reject.
   *
   * @param {string|object} conceptIdOrSelector
   *   - string: ID of an existing concept record to synthesize toward.
   *   - object topicSelector: { category } — concept located by category.
   * @param {object} [options]
   *   - proposedBody: string       — the proposed replacement body (required)
   *   - rationale: string          — reason for the proposal (required for apply)
   *   - decision: "apply"|"reject" — gate decision (default "apply")
   *   - rejectReason: string       — reason for rejection (required when decision="reject")
   *   - agent: string              — override agent name
   *   - session_id: string         — session id
   *   - note: string               — provenance note
   *   - similarityDetector: fn     — pluggable detector (R3); see SimilarityDetector interface
   * @returns {Promise<{
   *   conceptId: string,
   *   proposerId: string,
   *   cluster: string[],
   *   decision: "apply"|"reject",
   *   telemetryEvents: object[]
   * }>}
   */
  async synthesize(conceptIdOrSelector, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: detect-cluster ───────────────────────────────────────────────
    // Resolve concept id; locate similar compiled records via similarity detector

    const detector = options.similarityDetector || defaultSimilarityDetector;

    // Resolve the concept record
    let conceptId;
    if (typeof conceptIdOrSelector === "string") {
      conceptId = conceptIdOrSelector;
      const concept = await this._store.get(conceptId);
      if (!concept) {
        throw missingEvidenceError(`synthesize: concept not found: ${conceptId}`);
      }
      if (concept.type !== "concept") {
        throw missingEvidenceError(
          `synthesize: record ${conceptId} is type="${concept.type}", expected "concept"`
        );
      }
    } else if (conceptIdOrSelector && typeof conceptIdOrSelector === "object") {
      // topicSelector: find by category
      const sel = conceptIdOrSelector;
      if (!sel.category) {
        throw missingEvidenceError("synthesize: topicSelector must include a category");
      }
      const concepts = (await this._store.listByType("concept")).filter(
        (r) => r.category === sel.category
      );
      if (concepts.length === 0) {
        throw missingEvidenceError(
          `synthesize: no concept found for category: ${sel.category}`
        );
      }
      conceptId = concepts[0].id;
    } else {
      throw missingEvidenceError(
        "synthesize: conceptIdOrSelector must be a string id or topicSelector object"
      );
    }

    const concept = await this._store.get(conceptId);

    // Emit detect-cluster gate entry
    const detectGateIn = this._telemetry.emitGate(
      "knowledge.synthesize",
      "detect-cluster-gate",
      {
        flow: "knowledge.synthesize",
        gate: "detect-cluster-gate",
        concept_id: conceptId,
        concept_category: concept.category,
      }
    );
    events.push(detectGateIn);

    // Run similarity detection
    const allCompiled = await this._store.listByType("compiled");
    const cluster = await detector(concept, allCompiled, this._store);

    if (!Array.isArray(cluster) || cluster.length === 0) {
      throw missingEvidenceError(
        "detect-cluster-gate: no similar compiled records found; " +
        "synthesis requires at least one similar source"
      );
    }

    const detectGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "detect-cluster-gate",
      {
        concept_id: conceptId,
        cluster_ids: cluster,
        cluster_size: cluster.length,
      }
    );
    events.push(detectGateOut);

    // ── Step: propose ──────────────────────────────────────────────────────
    // The proposing record is the first compiled record in the cluster.
    // We use the store's propose op — never a direct mutation (AC1).

    if (!options.proposedBody || !options.proposedBody.trim()) {
      throw missingEvidenceError("synthesize: options.proposedBody is required");
    }

    const proposerId = cluster[0];

    const proposeGateIn = this._telemetry.emitGate("knowledge.synthesize", "propose-gate", {
      flow: "knowledge.synthesize",
      gate: "propose-gate",
      concept_id: conceptId,
      proposer_id: proposerId,
      source_ids: cluster,
    });
    events.push(proposeGateIn);

    // Create proposal via store propose op (not direct mutation — AC1)
    await this._store.propose(conceptId, proposerId, {
      agent,
      proposal: options.proposedBody,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "propose-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify proposal carries source refs and all source records exist

    const evidenceGateIn = this._telemetry.emitGate(
      "knowledge.synthesize",
      "evidence-gate",
      {
        flow: "knowledge.synthesize",
        gate: "evidence-gate",
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(evidenceGateIn);

    // Enforce: source_ids must be non-empty
    if (!cluster || cluster.length === 0) {
      throw missingEvidenceError(
        "evidence-gate: proposal must carry at least one source_id reference"
      );
    }

    // Enforce: every source record must exist
    for (const srcId of cluster) {
      const ref = await this._store.get(srcId);
      if (!ref) {
        throw missingEvidenceError(
          `evidence-gate: source record ${srcId} does not exist in store`
        );
      }
    }

    // Enforce: proposer must have a "proposes" link to the concept
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === conceptId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to concept ${conceptId}`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "evidence-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
        sources_verified: cluster.length,
        proposes_link_verified: true,
      }
    );
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    // Gate decision: "apply" (default) or "reject"

    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate("knowledge.synthesize", "apply-gate", {
      flow: "knowledge.synthesize",
      gate: "apply-gate",
      concept_id: conceptId,
      proposer_id: proposerId,
      decision,
    });
    events.push(applyGateIn);

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rationale is required when decision=apply"
        );
      }
      // Apply via store apply op — updates concept body with provenance to
      // all contributing sources (AC3)
      await this._store.apply(conceptId, proposerId, {
        agent,
        new_body: options.proposedBody,
        rationale: options.rationale,
      });
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject via store reject op — concept body remains untouched (AC2)
      await this._store.reject(conceptId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "apply-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        decision,
        source_ids: cluster,
      }
    );
    events.push(applyGateOut);

    return { conceptId, proposerId, cluster, decision, telemetryEvents: events };
  }
  // -------------------------------------------------------------------------
  // knowledge.consolidate flow
  //   Steps: related-event → propose → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries source refs; no direct snapshot
  //         mutation (AC1); rejection leaves snapshot unchanged (AC2 reject path).
  //         apply-gate    — apply or reject via store ops only.
  //                         apply creates a new snapshot and supersedes the prior
  //                         one(s); superseded snapshots remain queryable (AC2/R3).
  //
  // Machinery reuse: consolidate shares the same propose→evidence-gate→
  // apply-or-reject gate pattern as synthesize. The propose op is called on the
  // snapshot record (store contract §A.5 supersede enforces supersede-not-delete).
  // -------------------------------------------------------------------------

  /**
   * Execute the consolidate flow: detect compiled records linked to a snapshot
   * topic, create a consolidation proposal (never a direct mutation), gate the
   * evidence, then apply or reject.
   *
   * On apply:
   *   1. A new snapshot record is created with the proposed body and full
   *      provenance (source_ids referencing every contributing compiled record).
   *   2. The store supersede op links the new snapshot to any prior snapshot(s)
   *      for the same topic — prior snapshots are NEVER deleted (R3).
   *   3. Returns the new snapshot id plus a supersedes chain for traceability.
   *
   * On reject:
   *   The snapshot state is unchanged (byte-identical, AC1/AC2).
   *
   * @param {string|object} snapshotIdOrTopic
   *   - string: ID of an existing snapshot record to consolidate against.
   *   - object topicSelector: { topic } — snapshot located by topic tag.
   *     If no snapshot exists for the topic yet, a new one will be created on apply.
   * @param {object} [options]
   *   - proposedBody: string        — the proposed snapshot body (required)
   *   - rationale: string           — reason for the consolidation (required for apply)
   *   - decision: "apply"|"reject"  — gate decision (default "apply")
   *   - rejectReason: string        — reason for rejection (required when decision="reject")
   *   - agent: string               — override agent name
   *   - session_id: string          — session id
   *   - note: string                — provenance note
   *   - category: string            — category for new snapshot (required when creating)
   *   - similarityDetector: fn      — pluggable detector (same interface as synthesize R3)
   * @returns {Promise<{
   *   snapshotId: string,
   *   proposerId: string,
   *   cluster: string[],
   *   decision: "apply"|"reject",
   *   newSnapshotId: string|null,
   *   supersededIds: string[],
   *   telemetryEvents: object[]
   * }>}
   */
  async consolidate(snapshotIdOrTopic, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: related-event ────────────────────────────────────────────────
    // Resolve snapshot target; locate related compiled records via detector.

    const detector = options.similarityDetector || defaultSimilarityDetector;

    // Resolve the snapshot record (or find it by topic tag).
    // If no snapshot yet exists and decision=apply, we will create one.
    let snapshotId = null;
    let existingSnapshot = null;
    let topic = null;
    let category = options.category || null;

    if (typeof snapshotIdOrTopic === "string") {
      snapshotId = snapshotIdOrTopic;
      existingSnapshot = await this._store.get(snapshotId);
      if (!existingSnapshot) {
        throw missingEvidenceError(`consolidate: snapshot not found: ${snapshotId}`);
      }
      if (existingSnapshot.type !== "snapshot") {
        throw missingEvidenceError(
          `consolidate: record ${snapshotId} is type="${existingSnapshot.type}", expected "snapshot"`
        );
      }
      // Extract topic from tags (stored as "topic:<value>")
      const topicTag = (existingSnapshot.tags || []).find((t) => t.startsWith("topic:"));
      topic = topicTag ? topicTag.slice(6) : existingSnapshot.category;
      category = category || existingSnapshot.category;
    } else if (snapshotIdOrTopic && typeof snapshotIdOrTopic === "object") {
      const sel = snapshotIdOrTopic;
      topic = sel.topic || sel.category;
      if (!topic) {
        throw missingEvidenceError(
          "consolidate: topicSelector must include a topic or category field"
        );
      }
      // Find existing snapshot by topic tag
      const allSnapshots = await this._store.listByType("snapshot");
      const matches = allSnapshots.filter((s) => {
        const topicTag = (s.tags || []).find((t) => t.startsWith("topic:"));
        const snapshotTopic = topicTag ? topicTag.slice(6) : s.category;
        return snapshotTopic === topic;
      });
      if (matches.length > 0) {
        // Use the most recently created snapshot (no superseded-by log entry = current)
        const current = matches.find((s) => {
          const log = s.mutation_log || [];
          return !log.some((e) => e.op === "superseded-by");
        }) || matches[matches.length - 1];
        existingSnapshot = current;
        snapshotId = current.id;
      }
      // If no existing snapshot, we will create one on apply
      category = category || sel.category || topic.replace(/[^a-z0-9.]/g, "-") || "general";
    } else {
      throw missingEvidenceError(
        "consolidate: snapshotIdOrTopic must be a string id or topicSelector object"
      );
    }

    // ── Gate: related-event-gate ───────────────────────────────────────────
    // Run similarity detection to find compiled records related to the topic.
    // We use a concept-like proxy to run the similarity detector: a synthetic
    // object with the same category as the snapshot.

    const snapshotProxy = existingSnapshot || {
      id: "__probe__",
      type: "snapshot",
      category: category || "general",
      tags: [`topic:${topic}`],
      links: [],
    };

    const relatedGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "related-event-gate",
      {
        flow: "knowledge.consolidate",
        gate: "related-event-gate",
        snapshot_id: snapshotId,
        topic,
        snapshot_category: snapshotProxy.category,
      }
    );
    events.push(relatedGateIn);

    // Run the detector: pass all compiled records as candidates
    const allCompiled = await this._store.listByType("compiled");
    const cluster = await detector(snapshotProxy, allCompiled, this._store);

    if (!Array.isArray(cluster) || cluster.length === 0) {
      throw missingEvidenceError(
        "related-event-gate: no compiled records related to snapshot topic found; " +
        "consolidation requires at least one related source"
      );
    }

    const relatedGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "related-event-gate",
      {
        snapshot_id: snapshotId,
        topic,
        cluster_ids: cluster,
        cluster_size: cluster.length,
      }
    );
    events.push(relatedGateOut);

    // ── Step: propose ──────────────────────────────────────────────────────
    // The proposing record is the first compiled record in the cluster.
    // We use the store's propose op — never a direct snapshot mutation (AC1).
    //
    // When the snapshot does not exist yet (first consolidation for the topic),
    // we create a placeholder snapshot record to attach the proposal to.

    if (!options.proposedBody || !options.proposedBody.trim()) {
      throw missingEvidenceError("consolidate: options.proposedBody is required");
    }

    // Ensure a snapshot record exists to propose against
    if (!snapshotId) {
      // Create a placeholder snapshot (empty body) so propose has a target
      const topicTag = `topic:${topic}`;
      snapshotId = await this._store.create({
        type: "snapshot",
        title: `Snapshot: ${topic}`,
        body: "(pending consolidation)",
        category: category || "general",
        tags: [topicTag],
        provenance: {
          agent,
          note: `Placeholder created for first consolidation of topic: ${topic}`,
          ...(options.session_id ? { session_id: options.session_id } : {}),
        },
      });
      existingSnapshot = await this._store.get(snapshotId);
    }

    const proposerId = cluster[0];

    const proposeGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "propose-gate",
      {
        flow: "knowledge.consolidate",
        gate: "propose-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(proposeGateIn);

    // Create proposal via store propose op (not direct mutation — AC1)
    // We repurpose the propose/apply/reject ops: snapshot acts as the "concept"
    // target here. The contract allows propose/apply/reject against concept-type
    // records, but snapshots are a distinct type. We call propose directly on
    // the store's propose method with the snapshot's id.
    await this._store.propose(snapshotId, proposerId, {
      agent,
      proposal: options.proposedBody,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "propose-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify proposal carries source refs and all source records exist.

    const evidenceGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "evidence-gate",
      {
        flow: "knowledge.consolidate",
        gate: "evidence-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(evidenceGateIn);

    // Enforce: source_ids must be non-empty
    if (!cluster || cluster.length === 0) {
      throw missingEvidenceError(
        "evidence-gate: proposal must carry at least one source_id reference"
      );
    }

    // Enforce: every source record must exist
    for (const srcId of cluster) {
      const ref = await this._store.get(srcId);
      if (!ref) {
        throw missingEvidenceError(
          `evidence-gate: source record ${srcId} does not exist in store`
        );
      }
    }

    // Enforce: proposer must have a "proposes" link to the snapshot
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === snapshotId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to snapshot ${snapshotId}`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "evidence-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
        sources_verified: cluster.length,
        proposes_link_verified: true,
      }
    );
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    // Gate decision: "apply" (default) or "reject"

    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "apply-gate",
      {
        flow: "knowledge.consolidate",
        gate: "apply-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        decision,
      }
    );
    events.push(applyGateIn);

    let newSnapshotId = null;
    let supersededIds = [];

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rationale is required when decision=apply"
        );
      }

      // Collect all prior (non-superseded) snapshots for the same topic,
      // so we can supersede them after creating the new snapshot.
      const allSnapshots = await this._store.listByType("snapshot");
      const priorSnapshotIds = allSnapshots
        .filter((s) => {
          if (s.id === snapshotId) return false; // we'll include the placeholder below
          const topicTag = (s.tags || []).find((t) => t.startsWith("topic:"));
          const snapshotTopic = topicTag ? topicTag.slice(6) : s.category;
          return snapshotTopic === topic;
        })
        .map((s) => s.id);

      // The placeholder snapshot (created above or passed in) is also superseded
      // unless it already has content (i.e., was the prior live snapshot).
      const placeholderSnapshot = await this._store.get(snapshotId);
      const isPlaceholder =
        placeholderSnapshot && placeholderSnapshot.body === "(pending consolidation)";

      // Create the new definitive snapshot with the proposed body
      const topicTag = `topic:${topic}`;
      const sourceLinks = cluster.map((cid) => ({ target_id: cid, kind: "source" }));

      newSnapshotId = await this._store.create({
        type: "snapshot",
        title: `Snapshot: ${topic}`,
        body: options.proposedBody,
        category: existingSnapshot?.category || category || "general",
        tags: [topicTag],
        links: sourceLinks,
        provenance: {
          agent,
          source_ids: cluster,
          note: options.rationale,
          ...(options.session_id ? { session_id: options.session_id } : {}),
        },
      });

      // Collect all snapshot IDs that this new snapshot supersedes
      supersededIds = [
        ...(isPlaceholder ? [snapshotId] : [snapshotId]),
        ...priorSnapshotIds,
      ];
      // Deduplicate
      supersededIds = [...new Set(supersededIds)];

      // Supersede all prior snapshots — NEVER deletes them (R3)
      if (supersededIds.length > 0) {
        await this._store.supersede(newSnapshotId, supersededIds, {
          agent,
          rationale: options.rationale,
          ...(options.note ? { note: options.note } : {}),
        });
      }
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject: snapshot body remains unchanged (AC1)
      await this._store.reject(snapshotId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "apply-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        decision,
        source_ids: cluster,
        new_snapshot_id: newSnapshotId,
        superseded_ids: supersededIds,
      }
    );
    events.push(applyGateOut);

    return {
      snapshotId,
      proposerId,
      cluster,
      decision,
      newSnapshotId,
      supersededIds,
      telemetryEvents: events,
    };
  }

  // -------------------------------------------------------------------------
  // close-proposal primitive  (#106)
  //
  // A flow that gates a change through propose→apply mints a transient proposal
  // *artifact* record (the proposer) solely to carry the "proposes" link + the
  // proposal text. Once the proposal is APPLIED, that artifact is spent — it
  // should not linger as an `active` record. Left active it shows up in
  // working-set queries and hygiene sweeps, and re-retiring it spawns a
  // double-prefixed "Retirement proposal: Retirement proposal: …" twin (#106).
  //
  // This closes a spent proposal artifact by retiring it via the store's
  // existing `retire` op — no parallel mechanism. It is:
  //   - safe:        only touches the named artifact; never the apply target.
  //   - idempotent:  a no-op if the artifact is already retired/implemented.
  //   - non-fatal:   a close failure never fails the (already-applied) flow.
  // -------------------------------------------------------------------------

  /**
   * Auto-retire a spent proposal artifact after its proposal has been applied.
   *
   * @param {string} artifactId  - ID of the transient proposer record to close.
   * @param {object} [opts]
   *   - agent: string   — agent recording the close (defaults to runner agent)
   *   - rationale: string — close rationale (mutation-log evidence)
   * @returns {Promise<{ closed: boolean, reason?: string }>}
   */
  async _closeProposalArtifact(artifactId, opts = {}) {
    const agent = opts.agent || this._agent;
    const artifact = await this._store.get(artifactId);
    // Already gone or already closed — nothing to do (idempotent).
    if (!artifact) return { closed: false, reason: "artifact not found" };
    if ((artifact.status || "active") === "retired") {
      return { closed: false, reason: "already retired" };
    }
    try {
      await this._store.retire(artifactId, "retired", {
        agent,
        rationale:
          opts.rationale ||
          "Auto-closing spent proposal artifact after the proposal was applied (#106).",
      });
      return { closed: true };
    } catch (err) {
      // The proposal was already applied successfully; a failure to tidy up the
      // artifact must not fail the flow. Surface it on the result instead.
      return { closed: false, reason: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // knowledge.retire flow  (Addendum B — S7)
  //   Steps: identify → propose-retirement → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries rationale/ref; no direct mutation (AC1).
  //         apply-gate    — apply or reject via store retire op.
  //                         rejection leaves record status byte-identical (AC2).
  //
  // Machinery reuse: retire shares the same propose→evidence-gate→apply-or-reject
  // pattern as synthesize/consolidate. The store's retire op enforces the transition
  // table; rejection leaves the record unchanged.
  // -------------------------------------------------------------------------

  /**
   * Execute the retire flow: identify the target record, create a retirement
   * proposal (never a direct mutation), gate the evidence, then apply or reject.
   *
   * On apply:
   *   The store retire op updates the record status to targetStatus and appends
   *   a mutation log entry with the full evidence. The record is excluded from
   *   default working-set queries (listByType, listByCategory, similarity
   *   detection) unless includeRetired is true.
   *
   * On reject:
   *   The record status is byte-identical to its pre-proposal state.
   *
   * @param {string} recordId
   *   ID of the record to retire.
   * @param {object} [options]
   *   - targetStatus: "implemented"|"retired"  — target status (required)
   *   - rationale: string                      — why retiring (required)
   *   - implementedByRef: string               — ref when targetStatus="implemented" (required)
   *   - supersededByRef: string                — optional ref to superseding artifact
   *   - decision: "apply"|"reject"             — gate decision (default "apply")
   *   - rejectReason: string                   — reason for rejection (required when decision="reject")
   *   - agent: string                          — override agent name
   *   - session_id: string                     — session id
   *   - note: string                           — provenance note
   * @returns {Promise<{
   *   recordId: string,
   *   targetStatus: string,
   *   decision: "apply"|"reject",
   *   previousStatus: string,
   *   proposerId: string,
   *   telemetryEvents: object[]
   * }>}
   */
  async retire(recordId, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: identify ─────────────────────────────────────────────────────
    if (!recordId || typeof recordId !== "string") {
      throw missingEvidenceError("retire: recordId must be a non-empty string");
    }

    const targetStatus = options.targetStatus;
    if (targetStatus !== "implemented" && targetStatus !== "retired") {
      throw missingEvidenceError(
        'retire: options.targetStatus must be "implemented" or "retired"'
      );
    }

    if (!options.rationale || !options.rationale.trim()) {
      throw missingEvidenceError("retire: options.rationale is required");
    }

    if (targetStatus === "implemented" && (!options.implementedByRef || !options.implementedByRef.trim())) {
      throw missingEvidenceError(
        'retire: options.implementedByRef is required when targetStatus is "implemented"'
      );
    }

    const record = await this._store.get(recordId);
    if (!record) {
      throw missingEvidenceError(`retire: record not found: ${recordId}`);
    }

    const previousStatus = record.status || "active";

    // Validate transition early (surface errors at identify-gate, not at apply-gate)
    const VALID_TRANSITIONS = {
      active:      new Set(["implemented", "retired"]),
      implemented: new Set(["retired"]),
      retired:     new Set(),
    };
    const allowed = VALID_TRANSITIONS[previousStatus] || new Set();
    if (!allowed.has(targetStatus)) {
      throw missingEvidenceError(
        `retire: invalid transition from "${previousStatus}" to "${targetStatus}"`
      );
    }

    // Emit identify gate entry
    const identifyGateIn = this._telemetry.emitGate("knowledge.retire", "identify-gate", {
      flow: "knowledge.retire",
      gate: "identify-gate",
      record_id: recordId,
      record_type: record.type,
      current_status: previousStatus,
      target_status: targetStatus,
    });
    events.push(identifyGateIn);

    const identifyGateOut = this._telemetry.emitGateResult("knowledge.retire", "identify-gate", {
      record_id: recordId,
      record_type: record.type,
      current_status: previousStatus,
      target_status: targetStatus,
      transition_valid: true,
    });
    events.push(identifyGateOut);

    // ── Step: propose-retirement ───────────────────────────────────────────
    // We reuse the store's propose op against the record itself.
    // The record acts as the "concept" target; a transient proposer raw record
    // carries the retirement proposal and proposes link.

    const proposeGateIn = this._telemetry.emitGate(
      "knowledge.retire",
      "propose-retirement-gate",
      {
        flow: "knowledge.retire",
        gate: "propose-retirement-gate",
        record_id: recordId,
        target_status: targetStatus,
        rationale: options.rationale,
      }
    );
    events.push(proposeGateIn);

    // Create a transient proposer record to hold the retirement proposal
    const proposerBody =
      `Retirement proposal for record ${recordId}.
` +
      `Target status: ${targetStatus}
` +
      `Rationale: ${options.rationale}
` +
      (options.implementedByRef ? `Implemented-by: ${options.implementedByRef}
` : "") +
      (options.supersededByRef ? `Superseded-by: ${options.supersededByRef}
` : "");

    const proposerId = await this._store.create({
      type: "raw",
      title: `Retirement proposal: ${record.title}`,
      body: proposerBody,
      category: record.category,
      provenance: {
        agent,
        note: `Retirement proposal for ${recordId}`,
        ...(options.session_id ? { session_id: options.session_id } : {}),
      },
    });

    // Attach the proposal via the store's propose op (not direct mutation — AC1)
    await this._store.propose(recordId, proposerId, {
      agent,
      proposal: options.rationale,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.retire",
      "propose-retirement-gate",
      {
        record_id: recordId,
        proposer_id: proposerId,
        target_status: targetStatus,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify the proposal carries required evidence and the transition is valid.

    const evidenceGateIn = this._telemetry.emitGate("knowledge.retire", "evidence-gate", {
      flow: "knowledge.retire",
      gate: "evidence-gate",
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
    });
    events.push(evidenceGateIn);

    // Enforce: proposer must have a "proposes" link to the record
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === recordId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to record ${recordId}`
      );
    }

    // Enforce: target record still exists
    const targetRecord = await this._store.get(recordId);
    if (!targetRecord) {
      throw missingEvidenceError(
        `evidence-gate: target record ${recordId} does not exist`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult("knowledge.retire", "evidence-gate", {
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      proposes_link_verified: true,
      target_record_verified: true,
    });
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate("knowledge.retire", "apply-gate", {
      flow: "knowledge.retire",
      gate: "apply-gate",
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      decision,
    });
    events.push(applyGateIn);

    let proposalClosed = false;
    if (decision === "apply") {
      // Apply via store retire op — transitions status, appends mutation log (AC1)
      await this._store.retire(recordId, targetStatus, {
        agent,
        rationale: options.rationale,
        ...(options.implementedByRef ? { implementedByRef: options.implementedByRef } : {}),
        ...(options.supersededByRef ? { supersededByRef: options.supersededByRef } : {}),
        ...(options.note ? { note: options.note } : {}),
      });
      // Close the spent retirement-proposal artifact so it does not linger as an
      // active record (which would spawn a double-prefixed twin on re-retire). #106
      const closeResult = await this._closeProposalArtifact(proposerId, {
        agent,
        rationale: `Auto-closing retirement-proposal artifact after retiring ${recordId} (#106).`,
      });
      proposalClosed = closeResult.closed;
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject via store reject op — record status remains untouched (AC2)
      await this._store.reject(recordId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult("knowledge.retire", "apply-gate", {
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      decision,
      previous_status: previousStatus,
    });
    events.push(applyGateOut);

    return {
      recordId,
      targetStatus,
      decision,
      previousStatus,
      proposerId,
      proposalClosed,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.audit-freshness flow  (hygiene #1 — #106)
  //   Steps: collect → measure → flag-gate → done
  //   Gate: flag-gate — every flag cites its evidence (last-mutation + the
  //         threshold that fired). No flag is emitted without both.
  //
  // This is a READ-ONLY audit. It NEVER mutates a record. It surveys the
  // working set, measures each record's age against a per-category staleness
  // threshold, and returns flags proposing an action (archive / refresh). The
  // operator routes each flag through the existing gated flows (knowledge.retire
  // to archive; a fresh capture/compile to refresh) — the audit forks no new
  // mutation path. Staleness is domain-sensitive (radar ≠ decisions), so the
  // thresholds are OPTIONAL and CONFIGURABLE per category; a category with no
  // threshold (and no default) is simply not audited (opt-in).
  // -------------------------------------------------------------------------

  /**
   * Audit the working set for records past their per-category staleness
   * threshold and propose archive/refresh for each. Read-only: mutates nothing.
   *
   * Threshold resolution is dot-hierarchy longest-prefix: a record in
   * `radar.signals.weak` matches a `radar.signals` threshold before a `radar`
   * one, falling back to `defaultThresholdDays` if neither is configured. A
   * category that resolves to no threshold is skipped (opt-in auditing).
   *
   * "Last mutation" is the most recent of the record's `updated_at` and the
   * latest `mutation_log` entry `at` — both are refreshed by every mutating op
   * (store contract §1.1 / §4.2), so the later of the two is authoritative even
   * if an adapter lags one.
   *
   * @param {object} [options]
   *   - thresholds: { [category: string]: number }  — per-category staleness in days
   *   - defaultThresholdDays: number                — fallback for unmatched categories (default: none → skip)
   *   - actions: { [category: string]: "archive"|"refresh" } — per-category proposed action override
   *   - defaultAction: "archive"|"refresh"          — fallback proposed action (default "refresh")
   *   - types: string[]                             — record types to audit (default ["raw","compiled","concept","snapshot"])
   *   - now: string|number|Date                     — reference "now" for age (default: current time; injectable for tests)
   *   - agent: string                               — override agent name
   * @returns {Promise<{
   *   audited: number,
   *   skipped: number,
   *   flags: Array<{
   *     recordId: string, title: string, type: string, category: string,
   *     status: string, lastMutationAt: string, ageDays: number,
   *     thresholdDays: number, matchedThresholdKey: string,
   *     proposedAction: "archive"|"refresh"
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async auditFreshness(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    const thresholds = options.thresholds || {};
    const defaultThresholdDays =
      typeof options.defaultThresholdDays === "number"
        ? options.defaultThresholdDays
        : null;
    const actions = options.actions || {};
    const defaultAction = options.defaultAction || "refresh";
    if (defaultAction !== "archive" && defaultAction !== "refresh") {
      throw missingEvidenceError(
        `audit-freshness: defaultAction must be "archive" or "refresh"; got: ${defaultAction}`
      );
    }
    const types = Array.isArray(options.types) && options.types.length
      ? options.types
      : ["raw", "compiled", "concept", "snapshot"];

    const nowMs = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
    if (Number.isNaN(nowMs)) {
      throw missingEvidenceError(`audit-freshness: invalid "now" reference: ${options.now}`);
    }

    // ── Step: collect ──────────────────────────────────────────────────────
    // Gather the working set (default queries already exclude retired records —
    // retired is terminal, so there is nothing to flag there).
    const collectGateIn = this._telemetry.emitGate("knowledge.audit-freshness", "collect-gate", {
      flow: "knowledge.audit-freshness",
      gate: "collect-gate",
      types,
      threshold_categories: Object.keys(thresholds),
      default_threshold_days: defaultThresholdDays,
    });
    events.push(collectGateIn);

    const seen = new Set();
    const records = [];
    for (const type of types) {
      const recs = await this._store.listByType(type);
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
      }
    }

    const collectGateOut = this._telemetry.emitGateResult("knowledge.audit-freshness", "collect-gate", {
      collected: records.length,
    });
    events.push(collectGateOut);

    // ── Step: measure + flag-gate ──────────────────────────────────────────
    const flagGateIn = this._telemetry.emitGate("knowledge.audit-freshness", "flag-gate", {
      flow: "knowledge.audit-freshness",
      gate: "flag-gate",
      collected: records.length,
    });
    events.push(flagGateIn);

    const flags = [];
    let skipped = 0;
    let audited = 0;

    for (const record of records) {
      const resolved = resolveThreshold(record.category, thresholds, defaultThresholdDays);
      if (resolved === null) {
        // No threshold configured for this category (and no default) → opt out.
        skipped += 1;
        continue;
      }
      audited += 1;

      const lastMutationAt = lastMutationOf(record);
      const lastMs = new Date(lastMutationAt).getTime();
      // ageDays floored to whole days; an unparseable timestamp is treated as 0.
      const ageDays = Number.isNaN(lastMs)
        ? 0
        : Math.floor((nowMs - lastMs) / 86_400_000);

      // Flag only when STRICTLY past the threshold. Evidence (last-mutation +
      // the threshold key/value that fired) is carried on every flag — the
      // flag-gate requires both, so a flag can never be emitted without them.
      if (ageDays > resolved.thresholdDays) {
        const proposedAction =
          resolveAction(record.category, actions, defaultAction);
        flags.push({
          recordId: record.id,
          title: record.title,
          type: record.type,
          category: record.category,
          status: record.status || "active",
          lastMutationAt,
          ageDays,
          thresholdDays: resolved.thresholdDays,
          matchedThresholdKey: resolved.matchedKey,
          proposedAction,
        });
      }
    }

    const flagGateOut = this._telemetry.emitGateResult("knowledge.audit-freshness", "flag-gate", {
      audited,
      skipped,
      flagged: flags.length,
      agent,
    });
    events.push(flagGateOut);

    return { audited, skipped, flags, telemetryEvents: events };
  }


  // -------------------------------------------------------------------------
  // knowledge.canonicalize-category flow  (hygiene #4 — #106)
  //   Steps: survey → assess → propose-gate → done
  //   Gate: propose-gate — every category-sprawl finding cites its evidence
  //         (the metric that fired + the offending category/record ids). No
  //         finding is emitted without it.
  //
  // This is a READ-ONLY audit. It NEVER mutates a record. It surveys the
  // category hierarchy of the working set and flags three kinds of sprawl the
  // dogfooding surfaced (#106):
  //   - orphan-prefix      — an intermediate prefix node that holds NO record
  //                          directly yet has descendants, OR a prefix whose
  //                          whole subtree is a single leaf record (a deep path
  //                          carrying one record adds depth without branching
  //                          value). Proposes flattening to the parent.
  //   - too-many-leaves    — a parent prefix with more direct child leaf
  //                          categories than the configured fan-out budget.
  //                          Proposes regrouping under fewer leaves.
  //   - implemented-active — a record still status:"active" but carrying an
  //                          operator-supplied "implemented" marker tag; it
  //                          should have transitioned via retire but lingers in
  //                          the working set. Proposes retire.
  //
  // Each finding PROPOSES (flatten / regroup / retire); the operator routes it
  // through the existing gated flows — knowledge.retire to retire, an `update`
  // (recategorize) to flatten/regroup. The audit forks no new mutation path.
  // Sprawl is domain-sensitive, so the checks are OPTIONAL and CONFIGURABLE: a
  // disabled check (or an empty marker list) simply contributes no findings.
  // -------------------------------------------------------------------------

  /**
   * Audit the category hierarchy of the working set for sprawl and propose
   * flattening / regrouping / retirement. Read-only: mutates nothing.
   *
   * Findings are of three kinds (each independently toggleable):
   *   - `"orphan-prefix"`: an intermediate prefix node carrying no record
   *     directly while it has descendants, or a prefix whose entire subtree is
   *     exactly one leaf record. `proposedAction: "flatten"`.
   *   - `"too-many-leaves"`: a parent prefix whose direct child leaf-category
   *     count exceeds `maxLeavesPerParent`. `proposedAction: "regroup"`.
   *   - `"implemented-active"`: a record still `status:"active"` carrying an
   *     `implementedMarkers` tag. `proposedAction: "retire"`.
   *
   * @param {object} [options]
   *   - maxLeavesPerParent: number   — fan-out budget; a parent with more direct
   *                                     child leaf categories is flagged. Omit /
   *                                     null to disable the leaf-count check.
   *   - implementedMarkers: string[] — tag markers that mean "implemented"
   *                                     (case-insensitive). Empty/omitted →
   *                                     the implemented-active check is disabled.
   *   - checkOrphanPrefixes: boolean — enable the orphan-prefix check (default true).
   *   - types: string[]              — record types to survey
   *                                     (default ["raw","compiled","concept","snapshot"]).
   *   - agent: string                — override agent name.
   * @returns {Promise<{
   *   surveyed: number,
   *   categories: number,
   *   findings: Array<{
   *     kind: "orphan-prefix"|"too-many-leaves"|"implemented-active",
   *     category: string,
   *     recordIds: string[],
   *     metric: string,
   *     evidence: object,
   *     proposedAction: "flatten"|"regroup"|"retire"
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async canonicalizeCategory(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    const checkOrphanPrefixes = options.checkOrphanPrefixes !== false;
    const maxLeavesPerParent =
      typeof options.maxLeavesPerParent === "number"
        ? options.maxLeavesPerParent
        : null;
    if (maxLeavesPerParent !== null && maxLeavesPerParent < 1) {
      throw missingEvidenceError(
        `canonicalize-category: maxLeavesPerParent must be >= 1; got: ${maxLeavesPerParent}`
      );
    }
    const markerSet = new Set(
      (Array.isArray(options.implementedMarkers) ? options.implementedMarkers : [])
        .map((m) => String(m).toLowerCase())
    );
    const types = Array.isArray(options.types) && options.types.length
      ? options.types
      : ["raw", "compiled", "concept", "snapshot"];

    // ── Step: survey ───────────────────────────────────────────────────────
    // Gather the working set (default queries already exclude retired records —
    // retired is terminal, so it is not category sprawl to flatten).
    const surveyGateIn = this._telemetry.emitGate("knowledge.canonicalize-category", "survey-gate", {
      flow: "knowledge.canonicalize-category",
      gate: "survey-gate",
      types,
      check_orphan_prefixes: checkOrphanPrefixes,
      max_leaves_per_parent: maxLeavesPerParent,
      implemented_markers: [...markerSet],
    });
    events.push(surveyGateIn);

    const seen = new Set();
    const records = [];
    for (const type of types) {
      const recs = await this._store.listByType(type);
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
      }
    }

    // Build the category tree.
    //   directIds[prefix]   — ids of records whose category IS exactly prefix.
    //   subtreeIds[prefix]  — ids of records at prefix OR any descendant.
    //   childLeaves[parent] — direct child leaf categories (a leaf = a category
    //                         that is itself a record-bearing category with no
    //                         deeper record-bearing descendant).
    const directIds = new Map();
    const subtreeIds = new Map();
    const allCategories = new Set();
    for (const r of records) {
      const cat = r.category || "";
      if (!directIds.has(cat)) directIds.set(cat, []);
      directIds.get(cat).push(r.id);
      for (const prefix of categoryPrefixes(cat)) {
        allCategories.add(prefix);
        if (!subtreeIds.has(prefix)) subtreeIds.set(prefix, []);
        subtreeIds.get(prefix).push(r.id);
      }
    }

    const surveyGateOut = this._telemetry.emitGateResult("knowledge.canonicalize-category", "survey-gate", {
      surveyed: records.length,
      categories: allCategories.size,
    });
    events.push(surveyGateOut);

    // ── Step: assess + propose-gate ────────────────────────────────────────
    const proposeGateIn = this._telemetry.emitGate("knowledge.canonicalize-category", "propose-gate", {
      flow: "knowledge.canonicalize-category",
      gate: "propose-gate",
      surveyed: records.length,
      categories: allCategories.size,
    });
    events.push(proposeGateIn);

    const findings = [];

    // (1) orphan-prefix: an intermediate prefix node with no direct record but
    //     descendants, OR a prefix whose entire subtree is a single leaf record.
    if (checkOrphanPrefixes) {
      for (const prefix of allCategories) {
        const direct = directIds.get(prefix) || [];
        const subtree = subtreeIds.get(prefix) || [];
        const hasDescendantRecord = subtree.length > direct.length;
        // Only consider non-leaf (intermediate) prefixes for the "empty node"
        // case — a prefix that has descendants but holds nothing itself. When
        // the whole subtree is a SINGLE record, the deeper single-record-deep-path
        // finding (emitted at the record-bearing leaf) already covers the whole
        // chain — don't also report every empty ancestor of that lone record.
        if (direct.length === 0 && hasDescendantRecord && subtree.length > 1) {
          findings.push({
            kind: "orphan-prefix",
            category: prefix,
            recordIds: [...subtree],
            metric: "empty-intermediate-node",
            evidence: {
              directRecordCount: 0,
              subtreeRecordCount: subtree.length,
              parent: parentPrefix(prefix),
              reason:
                "Prefix holds no record directly; it only nests descendants. Flatten its subtree up to the parent.",
            },
            proposedAction: "flatten",
          });
        } else if (subtree.length === 1 && categoryPrefixes(prefix).length > 1) {
          // A deep path (>1 segment) whose whole subtree is one record adds
          // depth without branching value — flatten toward the parent. Only
          // report this at the deepest such prefix that still owns the record
          // directly (avoid double-reporting every ancestor of a lone record).
          if (direct.length === 1) {
            findings.push({
              kind: "orphan-prefix",
              category: prefix,
              recordIds: [...subtree],
              metric: "single-record-deep-path",
              evidence: {
                directRecordCount: 1,
                subtreeRecordCount: 1,
                depth: categoryPrefixes(prefix).length,
                parent: parentPrefix(prefix),
                reason:
                  "A multi-segment category carries exactly one record and no siblings in its subtree — depth without branching value. Consider flattening to the parent.",
              },
              proposedAction: "flatten",
            });
          }
        }
      }
    }

    // (2) too-many-leaves: a parent prefix whose direct child leaf-category
    //     count exceeds the fan-out budget. A "direct child leaf category" is a
    //     record-bearing category exactly one segment deeper than the parent
    //     with no record-bearing descendant of its own.
    if (maxLeavesPerParent !== null) {
      const childLeaves = new Map(); // parent → Set<childCategory>
      for (const cat of allCategories) {
        const direct = directIds.get(cat) || [];
        const subtree = subtreeIds.get(cat) || [];
        const isLeaf = direct.length > 0 && subtree.length === direct.length;
        if (!isLeaf) continue;
        const parent = parentPrefix(cat);
        if (!parent) continue; // top-level leaves have no parent prefix to regroup under
        if (!childLeaves.has(parent)) childLeaves.set(parent, new Set());
        childLeaves.get(parent).add(cat);
      }
      for (const [parent, leaves] of childLeaves) {
        if (leaves.size > maxLeavesPerParent) {
          const leafList = [...leaves].sort();
          const recordIds = [];
          for (const leaf of leafList) {
            for (const id of directIds.get(leaf) || []) recordIds.push(id);
          }
          findings.push({
            kind: "too-many-leaves",
            category: parent,
            recordIds,
            metric: "leaf-fan-out",
            evidence: {
              leafCount: leaves.size,
              maxLeavesPerParent,
              leaves: leafList,
              reason:
                "Parent prefix fans out to more direct leaf categories than the configured budget — regroup the leaves under fewer categories.",
            },
            proposedAction: "regroup",
          });
        }
      }
    }

    // (3) implemented-active: a still-active record carrying an implemented marker.
    if (markerSet.size > 0) {
      for (const r of records) {
        if (isImplementedButActive(r, markerSet)) {
          const tags = Array.isArray(r.tags) ? r.tags : [];
          const matched = tags.filter((t) => markerSet.has(String(t).toLowerCase()));
          findings.push({
            kind: "implemented-active",
            category: r.category || "",
            recordIds: [r.id],
            metric: "implemented-marker-on-active",
            evidence: {
              recordId: r.id,
              title: r.title,
              status: r.status || "active",
              matchedMarkers: matched,
              reason:
                "Record is still status:'active' but is tagged implemented — it should have transitioned via retire but lingers in the working set.",
            },
            proposedAction: "retire",
          });
        }
      }
    }

    const proposeGateOut = this._telemetry.emitGateResult("knowledge.canonicalize-category", "propose-gate", {
      surveyed: records.length,
      categories: allCategories.size,
      findings: findings.length,
      agent,
    });
    events.push(proposeGateOut);

    return {
      surveyed: records.length,
      categories: allCategories.size,
      findings,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.compile — entity extraction step (R2)
  //
  // Called after compile() to extract person mentions from the compiled record,
  // resolve/create person cards, and write bidirectional links:
  //   - Person card → raw + compiled (kind: appears-in)
  //   - Compiled record → person cards (kind: person)
  //
  // EntityExtractor interface (same pattern as SimilarityDetector — R3):
  //   async (record: Record) => PersonMention[]
  //   PersonMention: { name: string, role?: string, org?: string }
  // -------------------------------------------------------------------------

  /**
   * Extract person entities from a compiled record and its source raws, then
   * create or update person cards with bidirectional links.
   *
   * @param {string} compiledId   - ID of the compiled record to process
   * @param {object} [options]
   *   - entityExtractor: fn   — pluggable extractor (default: defaultEntityExtractor)
   *   - agent: string         — override agent name
   * @returns {Promise<{
   *   compiledId: string,
   *   personCards: Array<{ cardId, name, created, duplicate }>,
   *   linkCount: number
   * }>}
   */
  async extractEntities(compiledId, options = {}) {
    const agent = options.agent || this._agent;
    const extractor = options.entityExtractor || defaultEntityExtractor;

    const compiled = await this._store.get(compiledId);
    if (!compiled) throw new Error(`extractEntities: compiled record not found: ${compiledId}`);

    // Gather mentions from the compiled record
    const mentions = await extractor(compiled);

    // Also gather mentions from all source raw records
    const sourceLinks = (compiled.links || []).filter((l) => l.kind === "source");
    const seenNames = new Set(mentions.map((m) => normalizeName(m.name)));
    for (const link of sourceLinks) {
      const raw = await this._store.get(link.target_id);
      if (!raw) continue;
      const rawMentions = await extractor(raw);
      for (const m of rawMentions) {
        const norm = normalizeName(m.name);
        if (!seenNames.has(norm)) {
          seenNames.add(norm);
          mentions.push(m);
        }
      }
    }

    const personCardResults = [];
    const category = compiled.category || "people";

    for (const mention of mentions) {
      // Resolve or create the person card
      const result = await resolvePersonCard(this._store, mention, category, agent);
      const { cardId, created, duplicate } = result;

      // Build link sets for both sides
      const cardRecord = await this._store.get(cardId);
      const compiledRecord = await this._store.get(compiledId);

      // Person card → compiled (appears-in) — skip if already linked
      const cardLinks = cardRecord.links || [];
      const hasCompiledLink = cardLinks.some(
        (l) => l.target_id === compiledId && l.kind === "appears-in"
      );
      if (!hasCompiledLink) {
        await this._store.link(
          cardId,
          [{ target_id: compiledId, kind: "appears-in" }],
          { agent, note: `Person appears in compiled record` }
        );
      }

      // Person card → each source raw (appears-in) — skip if already linked
      for (const link of sourceLinks) {
        const updatedCard = await this._store.get(cardId);
        const hasRawLink = (updatedCard.links || []).some(
          (l) => l.target_id === link.target_id && l.kind === "appears-in"
        );
        if (!hasRawLink) {
          await this._store.link(
            cardId,
            [{ target_id: link.target_id, kind: "appears-in" }],
            { agent, note: `Person appears in raw source` }
          );
        }
      }

      // Compiled record → person card (person link) — skip if already linked
      const compLinks = compiledRecord.links || [];
      const hasPersonLink = compLinks.some(
        (l) => l.target_id === cardId && l.kind === "person"
      );
      if (!hasPersonLink) {
        await this._store.link(
          compiledId,
          [{ target_id: cardId, kind: "person" }],
          { agent, note: `Compiled record references person card` }
        );
      }

      personCardResults.push({ cardId, name: mention.name, created, duplicate });
    }

    return {
      compiledId,
      personCards: personCardResults,
      linkCount: personCardResults.length,
    };
  }

  // -------------------------------------------------------------------------
  // knowledge.merge-person flow (R3 / AC3)
  //   Merge two person cards via the existing propose→apply/reject gate.
  //   On apply: union aliases + links → supersede the duplicate (archive).
  //   On reject: both cards remain byte-identical.
  // -------------------------------------------------------------------------

  /**
   * Merge a duplicate person card into a primary card via gated propose/apply.
   *
   * On apply:
   *   1. Primary card body updated with unioned role text.
   *   2. Aliases from the duplicate appended to primary's tags as "alias:Name".
   *   3. All appears-in links from the duplicate are added to the primary.
   *   4. The duplicate is superseded (archived) via store.supersede().
   *
   * On reject:
   *   Both cards remain byte-identical (AC3).
   *
   * @param {string} primaryId    - ID of the primary person card to keep
   * @param {string} duplicateId  - ID of the card being merged in
   * @param {object} [options]
   *   - decision: "apply"|"reject"  (default "apply")
   *   - rationale: string           (required for apply)
   *   - rejectReason: string        (required for reject)
   *   - agent: string
   * @returns {Promise<{ primaryId, duplicateId, decision }>}
   */
  async mergePerson(primaryId, duplicateId, options = {}) {
    const agent = options.agent || this._agent;
    const decision = options.decision || "apply";

    const primary = await this._store.get(primaryId);
    if (!primary) throw new Error(`mergePerson: primary card not found: ${primaryId}`);
    if (primary.type !== "person") throw new Error(`mergePerson: primaryId must be a person record`);

    const duplicate = await this._store.get(duplicateId);
    if (!duplicate) throw new Error(`mergePerson: duplicate card not found: ${duplicateId}`);
    if (duplicate.type !== "person") throw new Error(`mergePerson: duplicateId must be a person record`);

    // propose: duplicate proposes a change to primary
    await this._store.propose(primaryId, duplicateId, {
      agent,
      proposal: `Merge duplicate person card "${duplicate.title}" into "${primary.title}"`,
    });

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw new Error("mergePerson: options.rationale is required when decision=apply");
      }

      // Compute merged body: union role text
      const mergedBodyLines = [];
      if (primary.body && primary.body.trim()) mergedBodyLines.push(primary.body.trim());
      if (duplicate.body && duplicate.body.trim() && duplicate.body.trim() !== primary.body.trim()) {
        mergedBodyLines.push(duplicate.body.trim());
      }
      const mergedBody = mergedBodyLines.join("\n") || primary.title;

      // Apply: update primary body
      await this._store.apply(primaryId, duplicateId, {
        agent,
        new_body: mergedBody,
        rationale: options.rationale,
      });

      // Add duplicate title as alias on primary
      const primaryAfterApply = await this._store.get(primaryId);
      const existingTags = primaryAfterApply.tags || [];
      const aliasTag = `alias:${duplicate.title}`;
      if (!existingTags.includes(aliasTag)) {
        await this._store.update(primaryId, { tags: [...existingTags, aliasTag] }, {
          agent,
          note: `Added alias from merged duplicate: ${duplicate.title}`,
        });
      }

      // Union appears-in links from duplicate to primary
      const dupLinks = (duplicate.links || []).filter((l) => l.kind === "appears-in");
      const primaryLinks = await this._store.getLinks(primaryId);
      for (const link of dupLinks) {
        const hasLink = primaryLinks.forward.some(
          (l) => l.target_id === link.target_id && l.kind === "appears-in"
        );
        if (!hasLink) {
          await this._store.link(primaryId, [{ target_id: link.target_id, kind: "appears-in" }], {
            agent,
            note: `Unioned from merged duplicate ${duplicateId}`,
          });
        }
      }

      // Supersede the duplicate (archives it — supersede-not-delete invariant)
      await this._store.supersede(primaryId, [duplicateId], {
        agent,
        rationale: options.rationale,
        note: `Merged duplicate person card into ${primaryId}`,
      });
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw new Error("mergePerson: options.rejectReason is required when decision=reject");
      }
      // Reject: both cards remain byte-identical
      await this._store.reject(primaryId, duplicateId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw new Error(`mergePerson: decision must be "apply" or "reject"; got: ${decision}`);
    }

    return { primaryId, duplicateId, decision };
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve or create a person card for a given mention.
 *
 * Resolution rules (R3):
 *  1. Exact normalised-name match (or alias match) → update existing card.
 *  2. Possible duplicate (same surname + initial) → create new card + related
 *     link of kind "related" with a possible-duplicate tag.
 *  3. No match → create new card.
 *
 * @param {object} store       - KnowledgeStoreAdapter
 * @param {object} mention     - { name, role? }
 * @param {string} category    - category for new card
 * @param {string} agent       - agent name
 * @returns {Promise<{ cardId: string, created: boolean, duplicate: boolean }>}
 */
async function resolvePersonCard(store, mention, category, agent) {
  const existing = await store.listByType("person");

  // 1. Exact match (name or alias)
  for (const card of existing) {
    if (isExactMatch(card.title, mention.name)) {
      return { cardId: card.id, created: false, duplicate: false };
    }
    // Check aliases tag: "alias:Some Name"
    const aliases = (card.tags || [])
      .filter((t) => t.startsWith("alias:"))
      .map((t) => t.slice("alias:".length));
    for (const alias of aliases) {
      if (isExactMatch(alias, mention.name)) {
        return { cardId: card.id, created: false, duplicate: false };
      }
    }
  }

  // 2. Possible duplicate check
  let possibleDupId = null;
  for (const card of existing) {
    if (isPossibleDuplicate(mention.name, card.title)) {
      possibleDupId = card.id;
      break;
    }
    const aliases = (card.tags || [])
      .filter((t) => t.startsWith("alias:"))
      .map((t) => t.slice("alias:".length));
    for (const alias of aliases) {
      if (isPossibleDuplicate(mention.name, alias)) {
        possibleDupId = card.id;
        break;
      }
    }
    if (possibleDupId) break;
  }

  // Build body: role/org as structured prose
  const bodyLines = [];
  if (mention.role) {
    bodyLines.push(`**Role/Org:** ${mention.role}`);
  }
  const body = bodyLines.length > 0 ? bodyLines.join("\n") : mention.name;

  // Create new person card
  const cardId = await store.create({
    type: "person",
    title: mention.name,
    body,
    category,
    tags: [],
    provenance: { agent, note: `Auto-created from entity extraction` },
  });

  // If possible duplicate: add related link from new card to existing card
  if (possibleDupId) {
    await store.link(
      cardId,
      [{ target_id: possibleDupId, kind: "related", label: "possible-duplicate" }],
      { agent, note: "Possible duplicate — same surname+initial; verify manually" }
    );
  }

  return { cardId, created: true, duplicate: possibleDupId !== null };
}

function mostCommonCategory(records) {
  const counts = {};
  for (const r of records) {
    counts[r.category] = (counts[r.category] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "general";
}

// ---------------------------------------------------------------------------
// Convenience function exports (module-level wrappers for tool calling)
// ---------------------------------------------------------------------------

/**
 * Module-level capture: creates an ephemeral runner using the provided store.
 *
 * @param {string} rawText
 * @param {object} meta
 * @param {{ store, workspace?, agent?, sessionId? }} options
 */
export async function capture(rawText, meta, { store, workspace, agent, sessionId } = {}) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.capture(rawText, meta);
}

/**
 * Module-level compile: creates an ephemeral runner using the provided store.
 *
 * @param {string[]} rawIds
 * @param {object} options  (merged into compile options + runner options)
 */
export async function compile(rawIds, { store, workspace, agent, sessionId, ...compileOpts } = {}) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.compile(rawIds, compileOpts);
}

/**
 * Module-level synthesize: creates an ephemeral runner using the provided store.
 *
 * @param {string|object} conceptIdOrSelector
 * @param {object} options  (merged into synthesize options + runner options)
 */
export async function synthesize(
  conceptIdOrSelector,
  { store, workspace, agent, sessionId, ...synthOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.synthesize(conceptIdOrSelector, synthOpts);
}

/**
 * Module-level consolidate: creates an ephemeral runner using the provided store.
 *
 * @param {string|object} snapshotIdOrTopic
 * @param {object} options  (merged into consolidate options + runner options)
 */
export async function consolidate(
  snapshotIdOrTopic,
  { store, workspace, agent, sessionId, ...consolidateOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.consolidate(snapshotIdOrTopic, consolidateOpts);
}

/**
 * Module-level retire: creates an ephemeral runner using the provided store.
 *
 * @param {string} recordId
 * @param {object} options  (merged into retire options + runner options)
 */
export async function retire(
  recordId,
  { store, workspace, agent, sessionId, ...retireOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.retire(recordId, retireOpts);
}

/**
 * Module-level audit-freshness: creates an ephemeral runner using the provided
 * store. Read-only — mutates nothing.
 *
 * @param {object} options  (merged into auditFreshness options + runner options)
 */
export async function auditFreshness(
  { store, workspace, agent, sessionId, ...auditOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.auditFreshness(auditOpts);
}

/**
 * Module-level category-canonicalization audit: creates an ephemeral runner
 * using the provided store. Read-only — mutates nothing. (#106 hygiene #4)
 *
 * @param {object} options  (merged into canonicalizeCategory options + runner options)
 */
export async function canonicalizeCategory(
  { store, workspace, agent, sessionId, ...auditOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.canonicalizeCategory(auditOpts);
}

export default KnowledgeFlowRunner;

/**
 * Module-level extractEntities: creates an ephemeral runner using the provided store.
 *
 * @param {string} compiledId
 * @param {object} options  (merged into extractEntities options + runner options)
 */
export async function extractEntities(
  compiledId,
  { store, workspace, agent, sessionId, ...extractOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.extractEntities(compiledId, extractOpts);
}

/**
 * Module-level mergePerson: creates an ephemeral runner using the provided store.
 *
 * @param {string} primaryId
 * @param {string} duplicateId
 * @param {object} options
 */
export async function mergePerson(
  primaryId,
  duplicateId,
  { store, workspace, agent, sessionId, ...mergeOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.mergePerson(primaryId, duplicateId, mergeOpts);
}
