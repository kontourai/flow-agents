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

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function missingEvidenceError(message) {
  const err = new Error(message);
  err.code = "MISSING_EVIDENCE";
  return err;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export default KnowledgeFlowRunner;
