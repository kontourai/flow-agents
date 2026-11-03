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
import { DEFAULT_GLOBAL_BUDGET_BYTES, DEFAULT_PROJECT_BUDGET_BYTES, classifyCurrent, effectiveItems, isSealed, writeBriefs } from "./brief.js";
import { memorySlotKey } from "@kontourai/flow-agents/memory-claims";
import { canonicalJson } from "@kontourai/relay";
import { memoryAccumulationClaims, memoryAccumulationFact, memoryAccumulationQuery } from "../adapters/memory-claims/index.mjs";

import { MAX_CLAIM_BYTES, boundFact, fitPlan, indexProposals, verifyEntry, visibilityKey } from "./envelope.js";
import { acquireDreamLock } from "./lock.js";
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
async function briefItems(store, index, proposerId) {
  const items = [];
  const excluded = { rejected: 0, self_approved: 0, unverified: 0, inactive: 0, sealed: 0 };
  for (const { proposal, envelope } of index.byClaim.values()) {
    if (proposal.state === "rejected") {
      excluded.rejected += 1;
      continue;
    }
    // A sealed claim never reaches a brief, but it still contests a rival: whether two claims disagree does not
    // depend on who may read them.
    if (isSealed(envelope.claim)) excluded.sealed += 1;
    if (proposal.state === "applied") {
      // Defence in depth: Corpus refuses SELF_APPROVAL, and a record the distiller approved still does not count.
      if (!proposal.reviewer_id || proposal.reviewer_id === proposal.proposer_id || proposal.reviewer_id === proposerId) {
        excluded.self_approved += 1;
        continue;
      }
      const record = store.get && proposal.record_id ? await store.get(proposal.record_id) : null;
      const bound = Boolean(record)
        && record.body === proposal.candidate.body
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
    items.push({ claim: envelope.claim, project: envelope.project, agreement: envelope.agreement, state: proposal.state, routing: envelope.decision });
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
    review_items: 0,
    unreadable_proposals: 0,
    redaction_hits: 0,
    briefs: [],
    obsolete_briefs_removed: [],
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
    let knownClaims = [];
    const reslot = () => {
      slotPeers = new Map();
      knownClaims = [];
      for (const { proposal, envelope } of index.byClaim.values()) {
        if (proposal.state === "rejected") continue;
        const key = memorySlotKey(envelope.claim);
        slotPeers.set(key, [...(slotPeers.get(key) ?? []), { claim: envelope.claim, state: proposal.state, project: envelope.project, agreement: envelope.agreement }]);
        knownClaims.push(envelope.claim);
      }
    };
    reslot();

    // The contest fact for a slot. Surface's accumulation projection owns it (#1571 routes on it and compares no values
    // itself), and the HOST runs it, because it needs observations with custody and an authority snapshot this run does
    // not hold: `host.project({ query, claims })` returns `projectAccumulation`'s result. A projection that throws, or
    // returns something that is not a fact, becomes an `invalid` fact, which routes: a slot that cannot be answered is
    // not read as uncontested. Without `host.project` the fact comes from `classifyCurrent`, the stand-in that applies
    // the same slot rules locally (kontourai/flow-agents#1584).
    const askHost = async (claim, slotClaims) => {
      const stated = slotClaims.filter((c) => c.posture === "stated");
      try {
        return memoryAccumulationFact(await host.project({ query: memoryAccumulationQuery(claim, now()), claims: memoryAccumulationClaims(stated, knownClaims.concat(stated)) }));
      } catch (error) {
        return { outcome: "invalid", reason: String(error?.message ?? error).slice(0, 200), candidateClaimIds: slotClaims.map((c) => c.id).sort(), gapCodes: ["projection-failed"] };
      }
    };
    const factFor = async (claim, siblings) => {
      if (claim.posture !== "stated") return null;
      const slot = memorySlotKey(claim);
      const items = [...(slotPeers.get(slot) ?? []), ...siblings.filter((other) => other.id !== claim.id && memorySlotKey(other) === slot).map((other) => ({ claim: other, state: "pending" }))];
      const together = [...items.filter((item) => item.claim.id !== claim.id), { claim, state: "pending" }];
      if (typeof host.project === "function") return askHost(claim, together.map((item) => item.claim));
      const out = classifyCurrent(together, policy);
      return out.contested.some((item) => item.claim.id === claim.id)
        ? { outcome: "contested", candidateClaimIds: out.contested.map((item) => item.claim.id).sort(), gapCodes: ["dream-stand-in"] }
        : { outcome: "current", candidateClaimIds: [claim.id], gapCodes: ["dream-stand-in"] };
    };

    // Which peers belong in a decision: the rivals the fact names (the review item shows the pair) and any peer the claim
    // would be wider than. Others add nothing, and routing validates and stores every peer it is given, while a slot can
    // hold thousands. The fact is bounded the same way (`boundFact`). Beyond the caps the outcome is unchanged (one rival
    // is enough to route, and the claim stays a candidate); the cut is counted so it is never silent.
    const MAX_RELEVANT_PEERS = 16;
    const route = async (claim, agreement, siblings = [], given = null) => {
      const slot = memorySlotKey(claim);
      const candidates = [...(slotPeers.get(slot) ?? []).map((item) => item.claim), ...siblings.filter((other) => other.id !== claim.id && memorySlotKey(other) === slot)]
        // A peer over the claim size bound cannot be this run's, and would make the stored decision too large.
        .filter((peer) => peer.id !== claim.id && Buffer.byteLength(JSON.stringify(peer)) <= MAX_CLAIM_BYTES)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const mine = canonicalJson(claim.value);
      const rivalIds = candidates.filter((peer) => canonicalJson(peer.value) !== mine).map((peer) => peer.id);
      const full = given ?? (await factFor(claim, siblings));
      const { fact: accumulation, cut } = boundFact(full, claim.id, rivalIds);
      if (cut > 0) report.claims.facts_truncated += 1;
      const base = { type: "claim", claim, agreement, accumulation, sourceVisibility: options.visibility ?? null };
      const alone = routeMemoryChange({ ...base, current: [] }, policy);
      const named = new Set(accumulation?.candidateClaimIds ?? []);
      const relevant = candidates.filter((peer) => {
        if (named.has(peer.id)) return true;
        const withPeer = routeMemoryChange({ ...base, current: [peer] }, policy);
        return withPeer.outcome !== alone.outcome || withPeer.reasons.length !== alone.reasons.length;
      });
      if (relevant.length > MAX_RELEVANT_PEERS) report.claims.peers_capped += 1; // reported, never silent
      // Rivals first: a peer that holds a different value is what the review item exists to show.
      const ordered = [...relevant].sort((a, b) => (canonicalJson(a.value) !== mine) === (canonicalJson(b.value) !== mine) ? 0 : canonicalJson(a.value) !== mine ? -1 : 1);
      return routeMemoryChange({ ...base, current: ordered.slice(0, MAX_RELEVANT_PEERS) }, policy);
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

        const project = projectFromCwd(residue.provenance?.cwd ?? null);
        const ordered = [...distilled.claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const fitted = fitPlan(ordered.map((claim) => ({ claim, agreement: distilled.agreement[claim.id] ?? null, project })));
        plan = fitted.plan;
        report.claims.truncated += fitted.dropped; // reported, never silent
        report.claims.distilled += plan.length;
      }
      await stage("route");
      // The plan is what was drafted and stays as written. The decisions the run acts on are made now, against the
      // claims, policy and visibility in force now, so a resumed plan may route differently from when it was drafted.
      const siblings = plan.map((entry) => entry.claim);
      const decided = [];
      for (const entry of plan) decided.push({ ...entry, decision: await route(entry.claim, entry.agreement, siblings) });
      if (known) {
        report.claims.rerouted += decided.filter((entry) => {
          const before = index.byClaim.get(entry.claim.id)?.envelope.decision;
          return before && before.outcome !== entry.decision.outcome;
        }).length;
      }

      await stage("propose");
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
    const latest = indexProposals(await store.listProposals(), proposerId);
    const { items, excluded } = await briefItems(store, latest, proposerId);
    const bySlot = new Map();
    for (const item of items) bySlot.set(memorySlotKey(item.claim), [...(bySlot.get(memorySlotKey(item.claim)) ?? []), item]);
    // With a host projection, the host decides every slot that has more than one stated claim; the stand-in only fills
    // in where the host was not asked (a slot with a single claim cannot be contested).
    const hostFacts = new Map();
    if (typeof host.project === "function") {
      for (const [slot, group] of bySlot) {
        const stated = group.filter((item) => item.claim.posture === "stated");
        if (stated.length < 2) continue;
        const fact = await askHost(stated[0].claim, stated.map((item) => item.claim));
        hostFacts.set(slot, fact);
        const named = new Set(fact.candidateClaimIds);
        for (const item of stated) item.contested = fact.outcome === "invalid" ? true : fact.outcome === "contested" && named.has(item.claim.id);
      }
    }
    const { views, byView } = effectiveItems(items, reviewDecisions);
    const contestedNow = classifyCurrent(views, policy).contested.map((view) => byView.get(view));
    const contestedBySlot = new Map();
    for (const item of contestedNow) contestedBySlot.set(memorySlotKey(item.claim), [...(contestedBySlot.get(memorySlotKey(item.claim)) ?? []), item.claim.id]);
    const alreadyRouted = new Set(decisions.filter((decision) => decision.outcome === "routed").map((decision) => decision.changeId));
    for (const item of contestedNow) {
      if (item.state !== "pending" || alreadyRouted.has(item.claim.id)) continue;
      const slot = memorySlotKey(item.claim);
      // The fact is the verdict the brief used, so a contest the reviewer's edits created (which no stored value shows)
      // is routed as the contest it is.
      const given = hostFacts.get(slot) ?? { outcome: "contested", candidateClaimIds: [...contestedBySlot.get(slot)].sort(), gapCodes: ["dream-stand-in"] };
      const decision = await route(item.claim, item.agreement, [], given);
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
    });
    report.briefs = [...written];
    report.obsolete_briefs_removed = written.removed;
    report.brief_excluded = { ...excluded, ...written.excluded };

    // The cursor: sittings this run finished, and a telemetry offset that never passes work left undone
    // (an incomplete sitting, one past the per-run cap, or one that failed).
    const sittings = { ...cursor.sittings };
    for (const residue of selected) if (processed.has(residue.sittingId)) sittings[residue.sittingId] = residue.contentHash;
    const undone = ingest.residues.some((residue) => !processed.has(residue.sittingId));
    const next = {
      schema_version: ingest.candidateCursor.schema_version,
      telemetry: undone ? cursor.telemetry : ingest.candidateCursor.telemetry,
      sittings,
    };
    const changed = JSON.stringify(next) !== JSON.stringify(cursor);
    const nextBytes = `${JSON.stringify(next, null, 2)}\n`;
    report.cursor = { committed: false, ...(changed ? { commit_intent: true, digest: sha256(nextBytes), offset: next.telemetry.offset } : {}) };

    if (dryRun) {
      report.status = "dry-run";
      report.finished_at = now();
      return report;
    }

    report.status = changed || report.sittings.distilled + report.sittings.resumed + report.sittings.reused > 0 ? "success" : "noop";
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
