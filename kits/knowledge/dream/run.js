/**
 * The dream run (#671): distil accumulated runtime sessions into proposed
 * memory claims and re-render the budgeted briefs.
 *
 *   cursor read -> ingest (#669) -> distil (#1571, model via Relay) -> route (#1571)
 *     -> propose (#670 -> Corpus proposeCreate) -> publish -> briefs -> report -> cursor
 *
 * Crash-safety is one rule: the cursor is committed LAST, so a run that fails
 * anywhere leaves it where it was and the next run does the same work again.
 * That is safe because every earlier step is replay-safe:
 *   - a sitting already fully proposed is recognised from the store (all of its
 *     claims are there) and is not distilled again, so a replay spends no model
 *     call and makes no duplicate;
 *   - a claim already proposed is reused by its claim id, in any proposal state;
 *   - briefs are re-rendered from the store and only rewritten when they differ.
 * There is no journal of run progress. `@kontourai/monument` owns that kind of
 * crash-safe effect, but it is not published yet; see the Knowledge docs.
 *
 * The run only ever proposes. The store it uses is narrowed to `proposeCreate`,
 * `listProposals` and `get`, so there is no code path that applies a proposal.
 * Only a routed review, by someone other than the proposer, promotes a claim.
 *
 * @module dream/run
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_MEMORY_ROUTING_POLICY,
  buildMemoryReviewItem,
  deriveMemoryRunMetrics,
  distillMemoryClaims,
  routeMemoryChange,
} from "../adapters/memory-claims/index.mjs";
import { commitRuntimeCursor, ingestRuntimeSessions, readRuntimeCursor } from "../promote/runtime-session.js";
import { proposeMemory } from "../promote/store-target.js";
import { ingestObservationSources } from "../instincts/observation-source.js";
import { toolEventResidue } from "../instincts/tool-event-residue.js";
import { DEFAULT_GLOBAL_BUDGET_BYTES, DEFAULT_PROJECT_BUDGET_BYTES, classifyCurrent, effectiveItems, isSealed, writeBriefs } from "./brief.js";
import { memorySlotKey } from "@kontourai/flow-agents/memory-claims";
import { memoryAccumulationQuery } from "../adapters/memory-claims/index.mjs";
import { canonicalJson } from "@kontourai/relay";

import { MAX_CLAIM_BYTES, boundFact, fitPlan, indexProposals, verifyEntry, visibilityKey } from "./envelope.js";
import { acquireDreamLock } from "./lock.js";
import { readPurgeGate } from "./purge-gate.js";
import { proposeSitting } from "./propose.js";
import { assertAbsolute, dreamError, projectFromCwd, sha256, writePrivateAtomic } from "./util.js";

export const DREAM_PROPOSER_ID = "knowledge.dream";
export const DEFAULT_MAX_SITTINGS_PER_RUN = 10;
export const REPORT_SCHEMA_VERSION = "1.0";
const KEPT_REPORTS = 100;
const BLOCKING = new Set(["TELEMETRY_DISCONTINUITY", "TELEMETRY_UNREADABLE"]);

/** Where the dream's own files live, matching the path #672's reader uses for the briefs. */
export function defaultDreamDir(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(env.HOME || "", ".local", "share");
  return path.join(dataHome, "knowledge-store", "knowledge", "dream");
}

const countBy = (items, key) => {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([reason, count]) => ({ reason, count }));
};
const redactionHits = (residues) =>
  residues.reduce((total, residue) => total + residue.turns.reduce((n, turn) => n + (turn.text.match(/<(?:SECRET|EMAIL)>/g) ?? []).length, 0), 0);

/** The only store surface the run touches. There is deliberately no applyCreate or rejectCreate (nor the earlier apply or reject). */
function narrowStore(store) {
  for (const method of ["proposeCreate", "listProposals"]) {
    if (typeof store?.[method] !== "function") throw dreamError("DREAM_CONFIG_INVALID", `the store must provide ${method}`);
  }
  return {
    proposeCreate: (...args) => store.proposeCreate(...args),
    listProposals: (...args) => store.listProposals(...args),
    get: typeof store.get === "function" ? (id) => store.get(id) : undefined,
  };
}

/**
 * Memory proposals as brief input. A rejected proposal never appears. An applied one counts only when its record
 * is the one Corpus made from it: the record's `apply-create` entry names this proposal and the record's body is the
 * proposal's. A settlement that points at some other record, or at none, is not trusted.
 */
async function briefItems(store, index, proposerId, proposals) {
  const items = [];
  const hasObservationInputs = proposals.some((item) => item?.candidate?.category === "memory.observation" || (item?.candidate?.category === "memory.claim" && item?.candidate?.type === "compiled"));
  const excluded = { rejected: 0, self_approved: 0, unverified: 0, inactive: 0, sealed: 0, ...(hasObservationInputs ? { observation_unreviewed: 0 } : {}) };
  const observationSources = new Map();
  for (const proposal of proposals) {
    if (proposal?.proposer_id !== proposerId || proposal?.candidate?.category !== "memory.observation") continue;
    try {
      const noteText = proposal.candidate?.provenance?.note;
      if (typeof noteText !== "string" || Buffer.byteLength(noteText) > 8192) continue;
      const note = JSON.parse(noteText);
      if (typeof note.sitting_id !== "string" || !note.sitting_id.startsWith("tool-event:")) continue;
      const list = observationSources.get(note.sitting_id) ?? [];
      list.push({ proposal, note }); observationSources.set(note.sitting_id, list);
    } catch { /* An unreadable source cannot authorize a brief. */ }
  }
  const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  async function approvedCompiledSources(proposal, envelope) {
    const ids = proposal.candidate?.provenance?.source_ids;
    const links = proposal.candidate?.links;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1001 || new Set(ids).size !== ids.length || !ids.includes(envelope.claim.source.ref) || !Array.isArray(links)) return false;
    const linked = new Set(links.filter((link) => link.kind === "source").map((link) => link.target_id));
    for (const id of ids) {
      if (typeof id !== "string" || !linked.has(id) || !store.get) return false;
      const record = await store.get(id);
      if (!record || record.type !== "raw" || ["retired", "purged"].includes(record.status)) return false;
      const origin = (record.mutation_log ?? []).find((entry) => entry.op === "apply-create" && typeof entry.evidence?.proposal_id === "string");
      const source = origin && proposalsById.get(origin.evidence.proposal_id);
      if (!source || source.state !== "applied" || source.record_id !== id || !source.reviewer_id || source.reviewer_id === source.proposer_id || source.candidate?.body !== record.body || source.candidate?.type !== "raw" || source.candidate?.category !== record.category) return false;
      if (id === envelope.claim.source.ref) {
        const range = /^chars:(\d+)-(\d+)$/.exec(envelope.claim.source.locator);
        const start = range ? Number(range[1]) : NaN; const end = range ? Number(range[2]) : NaN;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end > record.body.length || record.body.slice(start, end) !== envelope.claim.source.excerpt) return false;
      }
    }
    return true;
  }
  async function observationState(envelope) {
    const found = observationSources.get(envelope.sitting.id) ?? [];
    if (found.length !== 1) return "invalid";
    const { proposal, note } = found[0];
    if (note.content_hash !== envelope.sitting.contentHash) return "invalid";
    try {
      if (typeof proposal.candidate.body !== "string" || Buffer.byteLength(proposal.candidate.body) > 8 * 1024 * 1024) return "invalid";
      const raw = JSON.parse(proposal.candidate.body);
      if (raw.provenance?.eventId !== envelope.sitting.id.slice("tool-event:".length) || raw.turn?.role !== "tool") return "invalid";
      const expected = `sha256:${sha256(JSON.stringify({ sittingId: envelope.sitting.id, provenance: raw.provenance, turns: [raw.turn] }))}`;
      if (expected !== envelope.sitting.contentHash || envelope.claim.source.ref !== envelope.sitting.id) return "invalid";
      if (proposal.state === "rejected") return "rejected";
      if (proposal.state === "pending") return "pending";
      if (proposal.state !== "applied" || !proposal.reviewer_id || proposal.reviewer_id === proposerId || proposal.reviewer_id === proposal.proposer_id) return "invalid";
      const record = store.get && proposal.record_id ? await store.get(proposal.record_id) : null;
      return record && !["retired", "purged"].includes(record.status) && record.type === proposal.candidate.type && record.category === proposal.candidate.category && record.body === proposal.candidate.body && (record.mutation_log ?? []).some((entry) => entry.op === "apply-create" && entry.evidence?.proposal_id === proposal.id) ? "approved" : "invalid";
    } catch { return "invalid"; }
  }
  for (const { proposal, envelope } of index.byClaim.values()) {
    if (proposal.state === "rejected") {
      excluded.rejected += 1;
      continue;
    }
    if (proposal.candidate?.type === "compiled" && !(await approvedCompiledSources(proposal, envelope))) {
      excluded.observation_unreviewed = (excluded.observation_unreviewed ?? 0) + 1;
      continue;
    }
    let observationSourceApproved;
    if (envelope.sitting.id.startsWith("tool-event:")) {
      const state = await observationState(envelope);
      if (state !== "approved") excluded.observation_unreviewed = (excluded.observation_unreviewed ?? 0) + 1;
      if (state === "invalid" || state === "rejected") continue;
      observationSourceApproved = state === "approved";
    }
    // A sealed claim never reaches a brief, but it still contests a rival: whether two claims disagree does not
    // depend on who may read them.
    if (isSealed(envelope.claim)) excluded.sealed += 1;
    let acceptedConfidence = proposal.candidate?.confidence;
    if (acceptedConfidence !== undefined && (typeof acceptedConfidence !== "number" || !Number.isFinite(acceptedConfidence) || acceptedConfidence < 0 || acceptedConfidence > 1)) { excluded.unverified += 1; continue; }
    if (proposal.state === "applied") {
      // Defence in depth: Corpus refuses SELF_APPROVAL, and a record the distiller approved still does not count.
      if (!proposal.reviewer_id || proposal.reviewer_id === proposal.proposer_id || proposal.reviewer_id === proposerId) {
        excluded.self_approved += 1;
        continue;
      }
      const record = store.get && proposal.record_id ? await store.get(proposal.record_id) : null;
      const bound = Boolean(record)
        && record.body === proposal.candidate.body
        && (proposal.candidate.type === undefined || record.type === proposal.candidate.type)
        && record.category === proposal.candidate.category
        && record.confidence === proposal.candidate.confidence
        && (record.mutation_log ?? []).some((entry) => entry.op === "apply-create" && entry.evidence?.proposal_id === proposal.id);
      if (!bound) {
        excluded.unverified += 1;
        continue;
      }
      if (record.status === "retired") {
        excluded.inactive += 1;
        continue;
      }
    }
    items.push({ claim: envelope.claim, project: envelope.project, agreement: envelope.agreement, ...(observationSourceApproved === undefined ? {} : { observationSourceApproved }), ...(acceptedConfidence === undefined ? {} : { confidence: acceptedConfidence }), state: proposal.state, routing: envelope.decision });
  }
  return { items, excluded };
}

/** Counts how many extraction passes failed, by what the extract function does, not by what its warnings say. */
function trackExtract(extract) {
  const state = { failed: 0 };
  const wrapped = async (request) => {
    try {
      const result = await extract(request);
      if (result?.error) state.failed += 1;
      return result;
    } catch (error) {
      state.failed += 1;
      throw error;
    }
  };
  return { extract: wrapped, state };
}

function pruneReports(dir) {
  try {
    const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEPT_REPORTS))) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // Pruning old reports is housekeeping; it must not fail a run.
  }
}

/**
 * @typedef {object} DreamHost host-composed dependencies; the run discovers and authorises nothing itself
 * @property {object} store Corpus create-proposal store for `root` (`proposeCreate`, `listProposals`, optional `get`)
 * @property {(name: string, root: string) => unknown} registerRoot
 * @property {string} root absolute, host-authorised memory root
 * @property {string} rootName
 * @property {Array<{sourceId: string, project: string|null, data: string, importer: Function}>} [observationSources] host-authorized inputs with a stable opaque ID and explicit project or global scope
 * @property {Function} [extract] model-backed `MemoryExtract` (see model.js); not needed for a dry run
 * @property {() => object[] | Promise<object[]>} [reviewDecisions] Survey review decisions, for brief labels and metrics
 * @property {(batch: {runId: string, decisions: object[], reviewItems: object[], metrics: object|null}) => unknown} publish
 *   required for a real run. Hands routing decisions to the host's review queue and Flow evidence. It must be idempotent: a run that fails after
 *   it is retried, and republishes the decisions of sittings it finds already proposed.
 */

/**
 * @param {DreamHost} host
 * @param {object} options
 * @param {string} options.telemetryFile  canonical telemetry JSONL (full channel)
 * @param {string[]} options.transcriptRoots  host-authorised transcript roots
 * @param {string} [options.dreamDir]  the run's private state: cursor, lock, reports, briefs
 * @param {boolean} [options.enabled]  required for anything but a dry run
 * @param {boolean} [options.dryRun]  read-only: no model call, no write, no lock
 * @param {{kind: "public"}|{kind: "restricted", audiences: string[]}} [options.visibility]  who the sittings' claims may be shown to,
 *   in Surface's visibility lattice (#1571). Absent reads as sealed, the narrowest, so omission never widens access.
 * @param {string} [options.trigger]  who started it (recorded in the report)
 * @param {(stage: string) => void | Promise<void>} [options.onStage]  called at each stage boundary; tests inject faults here
 */
export async function runDream(host, options = {}) {
  const dryRun = options.dryRun === true;
  if (!dryRun && options.enabled !== true) {
    throw dreamError("DREAM_DISABLED", "the dream run is disabled; pass enabled: true to run it, or dryRun: true to preview");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const stage = async (name) => options.onStage?.(name);
  const dreamDir = assertAbsolute(options.dreamDir ?? defaultDreamDir(), "dreamDir");
  assertAbsolute(options.telemetryFile, "telemetryFile");
  if (!Array.isArray(options.transcriptRoots) || options.transcriptRoots.length === 0) {
    throw dreamError("DREAM_CONFIG_INVALID", "at least one authorised transcript root is required");
  }
  assertAbsolute(host?.root, "root");
  if (!dryRun && typeof host.extract !== "function") throw dreamError("DREAM_CONFIG_INVALID", "the host must provide an extract function");
  // Routed review is the only way a flagged claim is ever promoted. A run with nowhere to send it would propose
  // claims no reviewer is ever told about, so a real run requires the delivery to exist, whether or not any claim routes.
  if (!dryRun && typeof host.publish !== "function") throw dreamError("DREAM_CONFIG_INVALID", "the host must provide a publish function that delivers routed-review items");
  const store = narrowStore(host.store);
  const proposerId = options.proposerId ?? DREAM_PROPOSER_ID;
  const passes = options.passes ?? 2;
  const cursorFile = path.join(dreamDir, "cursors", "runtime-session.cursor.json");
  const briefsDir = path.join(dreamDir, "briefs");
  const reportsDir = path.join(dreamDir, "reports");

  // Everything that can throw before the lock is taken happens before it, so nothing is leaked.
  const runId = `${now().replace(/[^0-9A-Za-z]/g, "")}-${randomUUID().slice(0, 8)}`;
  const startedAt = now();
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runId,
    trigger: options.trigger ?? "manual",
    status: "running",
    dry_run: dryRun,
    started_at: startedAt,
    ingest: null,
    sittings: { seen: 0, distilled: 0, resumed: 0, reused: 0, deferred_incomplete: 0, deferred_over_cap: 0 },
    claims: { distilled: 0, rejected: 0, truncated: 0, peers_capped: 0, facts_truncated: 0, rerouted: 0, contested_routed: 0, created: 0, reused: 0, uncontested: 0, routed: 0 },
    receipts: [],
    ...(host.observationSources === undefined ? {} : { observation_proposals: [], observation_rejected: 0 }),
    review_items: 0,
    unreadable_proposals: 0,
    redaction_hits: 0,
    briefs: [],
    obsolete_briefs_removed: [],
    briefs_held: null,
    brief_excluded: null,
    metrics: null,
    cursor: { committed: false },
  };
  let cursorCommitted = false;
  const release = dryRun ? () => {} : acquireDreamLock(path.join(dreamDir, "dream.lock"));
  const writeReport = () => writePrivateAtomic(path.join(reportsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);

  try {
    const cursor = readRuntimeCursor(cursorFile);
    await stage("ingest");
    const ingest = ingestRuntimeSessions({
      telemetryFile: options.telemetryFile,
      transcriptRoots: options.transcriptRoots,
      cursor,
      ...(options.idleGapMs ? { idleGapMs: options.idleGapMs } : {}),
      ...(options.nowMs ? { now: options.nowMs } : {}),
    });
    report.ingest = {
      telemetry_lines_read: ingest.report.telemetry_lines_read,
      sittings_emitted: ingest.report.sittings_emitted,
      sittings_unchanged: ingest.report.sittings_unchanged,
      skipped: countBy(ingest.report.skipped, "reason"),
      blocked: countBy(ingest.report.blocked, "reason"),
      cursor_held: ingest.report.cursor_held,
    };
    // A source cursor advances only after every event in that source batch is processed.
    // The same cursor file commits runtime and observation progress last.
    const runtimeResidues = [...ingest.residues];
    const observations = host.observationSources === undefined ? null : ingestObservationSources(host.observationSources, cursor.observations ?? {}, cursor.sittings, toolEventResidue, { isolateFailures: true });
    if (observations) {
      ingest.residues.push(...observations.batches.flatMap((batch) => batch.residues));
      report.ingest.observations = { sources: observations.batches.length, events_returned: observations.batches.reduce((n, batch) => n + batch.eventIds.length, 0), events_emitted: observations.batches.reduce((n, batch) => n + batch.residues.length, 0), partial_sources: observations.batches.filter((batch) => batch.partial > 0).length, blocked: observations.blocked.map(({ sourceId, reason, errorClass }) => ({ source_ref: `sha256:${sha256(sourceId)}`, reason, error_class: errorClass })) };
    }
    report.sittings.seen = ingest.residues.length;
    report.redaction_hits = redactionHits(ingest.residues);

    // A rotated or unreadable telemetry file cannot make progress until an operator resets the cursor.
    if (ingest.report.blocked.some((entry) => BLOCKING.has(entry.reason))) {
      report.status = "blocked";
      report.finished_at = now();
      if (!dryRun) {
        writeReport();
        pruneReports(reportsDir);
      }
      return report;
    }

    const complete = ingest.residues.filter((residue) => residue.complete);
    const cap = options.maxSittingsPerRun ?? DEFAULT_MAX_SITTINGS_PER_RUN;
    const selected = complete.slice(0, cap);
    report.sittings.deferred_incomplete = ingest.residues.length - complete.length;
    report.sittings.deferred_over_cap = complete.length - selected.length;

    let index = indexProposals(await store.listProposals(), proposerId);
    report.unreadable_proposals = index.unreadable;
    const reviewDecisions = (await host.reviewDecisions?.()) ?? [];
    const decisions = [];
    const processed = new Set();
    const vKey = visibilityKey(options.visibility);
    const policy = options.routingPolicy ?? DEFAULT_MEMORY_ROUTING_POLICY;
    // Peers are looked up by slot: routing validates every peer it is given, so handing it the whole store would make
    // each decision cost the size of the store. `siblings` are the other claims of the same plan, which are peers too:
    // two claims from one sitting that disagree are a contest like any other.
    let slotPeers = new Map();
    const reslot = () => {
      slotPeers = new Map();
      for (const { proposal, envelope } of index.byClaim.values()) {
        if (proposal.state === "rejected") continue;
        const key = memorySlotKey(envelope.claim);
        slotPeers.set(key, [...(slotPeers.get(key) ?? []), { claim: envelope.claim, state: proposal.state, project: envelope.project, agreement: envelope.agreement }]);
      }
    };
    reslot();

    // The contest fact for a claim's slot, in the shape #1571 routes on (Surface's accumulation projection result).
    // Surface's projection (published in 6.3.0) needs custody this run does not hold, so the fact comes from
    // `classifyCurrent`, the stand-in that applies the same slot rules locally, over the values review has left
    // (kontourai/flow-agents#1584). There is one verdict function: routing, the review-queue backfill and the brief all
    // use it, so they agree by construction.
    const factFor = (claim, siblings) => {
      if (claim.posture !== "stated") return null;
      const slot = memorySlotKey(claim);
      const peers = (slotPeers.get(slot) ?? []).filter((item) => item.claim.id !== claim.id);
      const seen = new Set([claim.id, ...peers.map((item) => item.claim.id)]);
      const fromPlan = siblings.filter((other) => !seen.has(other.id) && memorySlotKey(other) === slot).map((other) => ({ claim: other, state: "pending" }));
      const { views, byView } = effectiveItems([...peers, ...fromPlan, { claim, state: "pending" }], reviewDecisions);
      const contested = classifyCurrent(views, policy).contested.map((view) => byView.get(view).claim.id).sort();
      // A projection RESULT, as #1571 reads one (it adds the slot from the query we pass beside it).
      return contested.includes(claim.id)
        ? { outcome: "contested", candidateClaimIds: contested, supportingClaimIds: [], gapCodes: ["dream-stand-in"] }
        : { outcome: "current", candidateClaimIds: [claim.id], supportingClaimIds: [], gapCodes: ["dream-stand-in"] };
    };

    // Which peers belong in a decision: the rivals the fact names (the review item shows the pair) and any peer the claim
    // would be wider than. Others add nothing, and routing validates and stores every peer it is given, while a slot can
    // hold thousands. #1571 requires every candidate a fact names to be among `current`, so the fact is bounded to what
    // fits (`boundFact`) and the named rivals travel first. Beyond the caps the outcome is unchanged (one rival is enough
    // to route, and the claim stays a candidate); each cut is counted so it is never silent.
    const MAX_RELEVANT_PEERS = 16;
    const route = (claim, agreement, siblings = [], given = null) => {
      const slot = memorySlotKey(claim);
      const byId = new Map();
      // Stored peers and the plan's siblings overlap on a resumed plan; each claim is one peer.
      for (const other of [...(slotPeers.get(slot) ?? []).map((item) => item.claim), ...siblings.filter((other) => memorySlotKey(other) === slot)]) {
        // A peer over the claim size bound cannot be this run's, and would make the stored decision too large.
        if (other.id !== claim.id && Buffer.byteLength(JSON.stringify(other)) <= MAX_CLAIM_BYTES) byId.set(other.id, other);
      }
      const candidates = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const mine = canonicalJson(claim.value);
      const rivalIds = candidates.filter((peer) => canonicalJson(peer.value) !== mine).map((peer) => peer.id);
      const { fact: accumulation, cut } = boundFact(given ?? factFor(claim, siblings), claim.id, rivalIds);
      if (cut > 0) report.claims.facts_truncated += 1;
      const base = { type: "claim", claim, agreement, accumulation, accumulationQuery: accumulation ? memoryAccumulationQuery(claim, startedAt) : undefined, sourceVisibility: options.visibility ?? null };
      const named = new Set(accumulation?.candidateClaimIds ?? []);
      const rivalsFirst = (list) => [...list].sort((a, b) => (canonicalJson(a.value) !== mine) === (canonicalJson(b.value) !== mine) ? 0 : canonicalJson(a.value) !== mine ? -1 : 1);
      const required = rivalsFirst(candidates.filter((peer) => named.has(peer.id)));
      const chosen = required.slice(0, MAX_RELEVANT_PEERS);
      let capped = required.length > chosen.length;
      const without = routeMemoryChange({ ...base, current: chosen }, policy);
      for (const peer of candidates) {
        if (named.has(peer.id)) continue;
        const withPeer = routeMemoryChange({ ...base, current: [...chosen, peer] }, policy);
        if (withPeer.outcome === without.outcome && withPeer.reasons.length === without.reasons.length) continue;
        if (chosen.length >= MAX_RELEVANT_PEERS) capped = true;
        else chosen.push(peer);
      }
      if (capped) report.claims.peers_capped += 1; // reported, never silent
      return chosen.length === required.slice(0, MAX_RELEVANT_PEERS).length ? without : routeMemoryChange({ ...base, current: chosen }, policy);
    };

    if (dryRun) {
      report.would_distill = selected.map((residue) => residue.sittingId);
    }

    for (const residue of dryRun ? [] : selected) {
      const known = index.sitting(residue.sittingId, residue.contentHash, vKey);
      let plan;
      if (known) {
        // An earlier attempt already decided this sitting's claims. Resume that plan: asking the model again would
        // word them differently, and the first attempt's proposals would stay beside the new ones.
        if (!known.plan.every(verifyEntry)) throw dreamError("DREAM_RECEIPT_CORRUPT", `the stored plan for sitting ${residue.sittingId} does not verify`);
        plan = known.plan;
      } else {
        await stage("distill");
        const tracker = trackExtract(host.extract);
        const distilled = await distillMemoryClaims({ sitting: residue, extract: tracker.extract, passes, ...(options.visibility ? { visibility: options.visibility } : {}) });
        if (tracker.state.failed >= passes) {
          // Every pass failed or returned an error: a model outage, not a sitting with nothing in it.
          throw dreamError("DREAM_DISTILL_FAILED", `extraction failed for sitting ${residue.sittingId}`, { sittingId: residue.sittingId });
        }
        report.claims.rejected += distilled.rejected.length;

        const project = residue.source === "tool-event" ? residue.provenance.project : projectFromCwd(residue.provenance?.cwd ?? null);
        const ordered = [...distilled.claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        // Tool output is untrusted external data, not an independently asserted
        // human statement. Keep its agreement unmeasured so the common router
        // sends it to review rather than promoting it through opt-in briefing.
        const fitted = fitPlan(ordered.map((claim) => ({ claim, agreement: residue.source === "tool-event" ? null : distilled.agreement[claim.id] ?? null, project })));
        plan = fitted.plan;
        report.claims.truncated += fitted.dropped; // reported, never silent
        report.claims.distilled += plan.length;
      }
      await stage("route");
      // The plan is what was drafted and stays as written. The decisions the run acts on are made now, against the
      // claims, policy and visibility in force now, so a resumed plan may route differently from when it was drafted.
      const siblings = plan.map((entry) => entry.claim);
      const decided = [];
      for (const entry of plan) decided.push({ ...entry, decision: route(entry.claim, entry.agreement, siblings) });
      if (known) {
        report.claims.rerouted += decided.filter((entry) => {
          const before = index.byClaim.get(entry.claim.id)?.envelope.decision;
          return before && before.outcome !== entry.decision.outcome;
        }).length;
      }

      await stage("propose");
      if (residue.source === "tool-event") {
        // Raw observations are staged as Corpus proposals, not applied. Their key
        // is anchored to the same source event on every retry.
        const raw = await proposeMemory({ residue, candidates: [{ id: `observation-${residue.provenance.eventId}`, title: "Observed tool event", category: "memory.observation", body: JSON.stringify({ provenance: residue.provenance, turn: residue.turns[0] }) }], proposerId, store, registerRoot: host.registerRoot, root: host.root, rootName: host.rootName, requestScope: "observation-raw-v1", positions: [0] });
        const proposalId = raw.proposals[0];
        const proposal = (await store.listProposals()).find((item) => item.id === proposalId);
        if (!proposal) throw dreamError("DREAM_OBSERVATION_UNCONFIRMED", "the observation proposal cannot be confirmed");
        report.observation_proposals.push({ sitting_id: residue.sittingId, proposal_id: proposalId, state: proposal.state });
        if (proposal.state === "rejected") {
          const prior = index.sitting(residue.sittingId, residue.contentHash, vKey);
          if (prior?.plan.some((entry) => index.byClaim.get(entry.claim.id)?.proposal.state !== "rejected")) {
            throw dreamError("DREAM_OBSERVATION_RECONCILE", "rejected observation has dependent claims requiring review");
          }
          report.observation_rejected += 1; processed.add(residue.sittingId); continue;
        }
      }
      const result = await proposeSitting({ residue, plan, decisions: decided.map((entry) => entry.decision), visibilityKey: vKey, host: { store, registerRoot: host.registerRoot, root: host.root, rootName: host.rootName }, proposerId, index, write: true })
        .catch((error) => {
          // What landed before the failure is real, and the report must say so.
          for (const landed of error.dreamLanded ?? []) report.receipts.push({ claim_id: landed.claimId, proposal_id: landed.proposalId, disposition: "created", state: "pending", sitting_id: residue.sittingId, outcome: null });
          report.claims.created += (error.dreamLanded ?? []).length;
          throw error;
        });
      // Account for the store's change before anything else can fail.
      const outcomes = new Map(decided.map((entry) => [entry.claim.id, entry.decision.outcome]));
      for (const item of result.created) report.receipts.push({ claim_id: item.claimId, proposal_id: item.proposalId, disposition: "created", state: "pending", sitting_id: residue.sittingId, outcome: outcomes.get(item.claimId) });
      for (const item of result.reused) report.receipts.push({ claim_id: item.claimId, proposal_id: item.proposalId, disposition: "reused", state: item.state, sitting_id: residue.sittingId, outcome: outcomes.get(item.claimId) });
      report.claims.created += result.created.length;
      report.claims.reused += result.reused.length;
      if (!known) report.sittings.distilled += 1;
      else if (known.complete) report.sittings.reused += 1;
      else report.sittings.resumed += 1;
      decisions.push(...decided.map((entry) => entry.decision));
      processed.add(residue.sittingId);
      await stage("receipt");
      // The next sitting routes against, and reconciles with, what this one just proposed.
      index = indexProposals(await store.listProposals(), proposerId);
      reslot();
    }

    // Briefs derive from the store every run, because review changes them without any new telemetry. The briefs are
    // written below; what they hold back as contested is decided here, once, and both the brief and the review queue
    // use that verdict: a contested claim belongs in the review queue, not the brief.
    // Read the purge gate before the snapshot used by the brief and routing.
    const purgeGate = { before: readPurgeGate(dreamDir), current: () => readPurgeGate(dreamDir) };
    const proposalSnapshot = await store.listProposals();
    const latest = indexProposals(proposalSnapshot, proposerId);
    // Routing in the backfill below must look at the same snapshot the brief judged, or a claim another writer adds
    // between the two reads would be named by the verdict and missing from the peers.
    index = latest;
    reslot();
    const { items, excluded } = await briefItems(store, latest, proposerId, proposalSnapshot);
    const { views, byView } = effectiveItems(items, reviewDecisions);
    const contestedNow = classifyCurrent(views, policy).contested.map((view) => byView.get(view));
    const contestedBySlot = new Map();
    for (const item of contestedNow) contestedBySlot.set(memorySlotKey(item.claim), [...(contestedBySlot.get(memorySlotKey(item.claim)) ?? []), item.claim.id]);
    const alreadyRouted = new Set(decisions.filter((decision) => decision.outcome === "routed").map((decision) => decision.changeId));
    for (const item of contestedNow) {
      if (item.state !== "pending" || alreadyRouted.has(item.claim.id)) continue;
      // The fact is the brief's own verdict, built from the claims the brief judged: those the brief verified (an applied
      // claim whose record is retired or not the proposal's is not among them), over the values review has left. A fresh
      // look at the store would see claims the brief excluded, and could clear a contest the brief is holding back.
      const given = { outcome: "contested", candidateClaimIds: [...contestedBySlot.get(memorySlotKey(item.claim))].sort(), supportingClaimIds: [], gapCodes: ["dream-stand-in"] };
      const decision = route(item.claim, item.agreement, [], given);
      if (decision.outcome === "routed") {
        decisions.push(decision);
        report.claims.contested_routed += 1;
      }
    }

    // Per claim, the last decision stands (a claim proposed as uncontested and routed on a later look is one routed claim).
    const finalDecisions = [...new Map(decisions.map((decision) => [decision.changeId, decision])).values()];
    for (const decision of finalDecisions) report.claims[decision.outcome === "routed" ? "routed" : "uncontested"] += 1;
    const reviewItems = finalDecisions.filter((decision) => decision.outcome === "routed").map((decision) => buildMemoryReviewItem(decision)).filter(Boolean);
    report.review_items = reviewItems.length;
    report.metrics = finalDecisions.length ? deriveMemoryRunMetrics({ runId, decisions: finalDecisions, reviewDecisions }) : null;
    if (!dryRun && finalDecisions.length) {
      await stage("publish");
      await host.publish({ runId, decisions: finalDecisions, reviewItems, metrics: report.metrics });
    }

    await stage("brief");
    const written = writeBriefs({
      briefsDir,
      items,
      now: now(),
      globalBudget: options.globalBudget ?? DEFAULT_GLOBAL_BUDGET_BYTES,
      projectBudget: options.projectBudget ?? DEFAULT_PROJECT_BUDGET_BYTES,
      maxEntryBytes: options.maxEntryBytes,
      includeUnreviewed: options.includeUnreviewed === true,
      reviewDecisions,
      policy,
      dryRun,
      purgeGate,
    });
    report.briefs = [...written];
    report.obsolete_briefs_removed = written.removed;
    report.briefs_held = written.held ?? null;
    report.brief_excluded = { ...excluded, ...written.excluded };

    // The cursor: sittings this run finished, and a telemetry offset that never passes work left undone
    // (an incomplete sitting, one past the per-run cap, or one that failed).
    const sittings = { ...cursor.sittings };
    for (const residue of selected) if (processed.has(residue.sittingId)) sittings[residue.sittingId] = residue.contentHash;
    const undone = runtimeResidues.some((residue) => !processed.has(residue.sittingId));
    if (observations) for (const batch of observations.batches) {
      if (batch.residues.every((residue) => processed.has(residue.sittingId))) {
        observations.cursors[batch.key] = batch.cursor;
        // The committed source cursor now owns replay identity for this prefix.
        for (const id of batch.eventIds) delete sittings[id];
      }
    }
    const next = {
      schema_version: ingest.candidateCursor.schema_version,
      telemetry: undone ? cursor.telemetry : ingest.candidateCursor.telemetry,
      sittings,
      ...(observations ? { observations: observations.cursors } : cursor.observations === undefined ? {} : { observations: cursor.observations }),
    };
    const changed = JSON.stringify(next) !== JSON.stringify(cursor);
    const nextBytes = `${JSON.stringify(next, null, 2)}\n`;
    report.cursor = { committed: false, ...(changed ? { commit_intent: true, digest: sha256(nextBytes), offset: next.telemetry.offset } : {}) };

    if (dryRun) {
      report.status = "dry-run";
      report.finished_at = now();
      return report;
    }

    report.status = observations?.blocked.length ? "blocked" : changed || report.sittings.distilled + report.sittings.resumed + report.sittings.reused > 0 ? "success" : "noop";
    report.finished_at = now();
    await stage("report");
    writeReport(); // everything fallible is behind us: the report names the cursor it is about to commit
    pruneReports(reportsDir);

    if (changed) {
      await stage("cursor");
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true, mode: 0o700 }); // the file is private because its directory is
      commitRuntimeCursor(cursorFile, next);
      cursorCommitted = true;
      // Nothing below may fail the run: the cursor has moved, so a thrown error here would call a done run failed.
      report.cursor = { committed: true, digest: sha256(nextBytes), offset: next.telemetry.offset };
      try {
        fs.chmodSync(cursorFile, 0o600);
        writeReport();
      } catch {
        // The report already on disk says commit_intent with this digest; the cursor file is the authority.
      }
    }
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = { code: error.code ?? "DREAM_FAILED", message: String(error.message ?? error).slice(0, 500) };
    report.cursor = cursorCommitted ? { ...report.cursor, committed: true } : { committed: false };
    report.finished_at = now();
    if (error.briefs) {
      report.briefs = error.briefs;
      report.obsolete_briefs_removed = error.removed ?? [];
    }
    if (!dryRun) {
      try {
        writeReport();
      } catch {
        // A failing disk cannot also hold the failure report; the thrown error is the signal.
      }
    }
    throw Object.assign(error, { report });
  } finally {
    release(); // never throws: see acquireDreamLock
  }
}
