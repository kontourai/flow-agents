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
import { DEFAULT_GLOBAL_BUDGET_BYTES, DEFAULT_PROJECT_BUDGET_BYTES, isSealed, writeBriefs } from "./brief.js";
import { indexProposals } from "./envelope.js";
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

/** Memory proposals as brief input. An applied proposal whose record is gone or retired drops out; a rejected one never appears. */
async function briefItems(store, index, proposerId) {
  const items = [];
  const excluded = { rejected: 0, self_approved: 0, inactive: 0, sealed: 0 };
  for (const { proposal, envelope } of index.byClaim.values()) {
    if (proposal.state === "rejected") {
      excluded.rejected += 1;
      continue;
    }
    if (isSealed(envelope.claim)) {
      excluded.sealed += 1;
      continue;
    }
    if (proposal.state === "applied") {
      // Defence in depth: Corpus refuses SELF_APPROVAL, and a record the distiller approved still does not count.
      if (!proposal.reviewer_id || proposal.reviewer_id === proposal.proposer_id || proposal.reviewer_id === proposerId) {
        excluded.self_approved += 1;
        continue;
      }
      if (store.get) {
        const record = proposal.record_id ? await store.get(proposal.record_id) : null;
        if (!record || record.status === "retired") {
          excluded.inactive += 1;
          continue;
        }
      }
    }
    items.push({ claim: envelope.claim, project: envelope.project, agreement: envelope.agreement, state: proposal.state, routing: envelope.decision });
  }
  return { items, excluded };
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
 * @property {(batch: {runId: string, decisions: object[], reviewItems: object[], metrics: object|null}) => unknown} [publish]
 *   hands routing decisions to the host's review queue and Flow evidence. It must be idempotent: a run that fails after
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
  const store = narrowStore(host.store);
  const proposerId = options.proposerId ?? DREAM_PROPOSER_ID;
  const passes = options.passes ?? 2;
  const cursorFile = path.join(dreamDir, "cursors", "runtime-session.cursor.json");
  const briefsDir = path.join(dreamDir, "briefs");
  const reportsDir = path.join(dreamDir, "reports");

  const release = dryRun ? () => {} : acquireDreamLock(path.join(dreamDir, "dream.lock"));
  const runId = `${now().replace(/[^0-9A-Za-z]/g, "")}-${randomUUID().slice(0, 8)}`;
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runId,
    trigger: options.trigger ?? "manual",
    status: "running",
    dry_run: dryRun,
    started_at: now(),
    ingest: null,
    sittings: { seen: 0, distilled: 0, reused: 0, deferred_incomplete: 0, deferred_over_cap: 0 },
    claims: { distilled: 0, rejected: 0, created: 0, reused: 0, uncontested: 0, routed: 0 },
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

    if (dryRun) {
      report.would_distill = selected.map((residue) => residue.sittingId);
    }

    for (const residue of dryRun ? [] : selected) {
      if (index.complete(residue.sittingId, residue.contentHash)) {
        // Fully proposed by an earlier attempt: reuse it, and do not spend another model call.
        for (const { proposal, envelope } of index.claimsOf(residue.sittingId, residue.contentHash)) {
          decisions.push(envelope.decision);
          report.receipts.push({ claim_id: envelope.claim.id, proposal_id: proposal.id, disposition: "reused", state: proposal.state, sitting_id: residue.sittingId, outcome: envelope.decision.outcome });
          report.claims.reused += 1;
        }
        report.sittings.reused += 1;
        processed.add(residue.sittingId);
        continue;
      }

      await stage("distill");
      const distilled = await distillMemoryClaims({ sitting: residue, extract: host.extract, passes, ...(options.visibility ? { visibility: options.visibility } : {}) });
      // Traverse reports a failed provider call as `error` on its result ("reported"); a thrown extract is "failed".
      const failedPasses = distilled.warnings.filter((warning) => /^pass \d+ (failed|reported)/.test(warning)).length;
      if (distilled.claims.length === 0 && failedPasses >= passes) {
        // Every pass failed: that is a model outage, not a sitting with nothing in it. Do not advance past it.
        throw dreamError("DREAM_DISTILL_FAILED", `extraction failed for sitting ${residue.sittingId}`, { sittingId: residue.sittingId });
      }
      report.claims.distilled += distilled.claims.length;
      report.claims.rejected += distilled.rejected.length;

      await stage("route");
      const current = [...index.byClaim.values()].filter(({ proposal }) => proposal.state !== "rejected").map(({ envelope }) => envelope.claim);
      const project = projectFromCwd(residue.provenance?.cwd ?? null);
      const entries = distilled.claims.map((claim) => {
        const agreement = distilled.agreement[claim.id] ?? null;
        return {
          claim,
          agreement,
          project,
          decision: routeMemoryChange({ type: "claim", claim, current, agreement, sourceVisibility: options.visibility ?? null }, options.routingPolicy ?? DEFAULT_MEMORY_ROUTING_POLICY),
        };
      });

      await stage("propose");
      const result = await proposeSitting({ residue, claims: entries, host: { store, registerRoot: host.registerRoot, root: host.root, rootName: host.rootName }, proposerId, index, write: true })
        .catch((error) => {
          // What landed before the failure is real, and the report must say so.
          for (const claimId of error.dreamLanded ?? []) report.receipts.push({ claim_id: claimId, proposal_id: null, disposition: "created", state: "pending", sitting_id: residue.sittingId, outcome: null });
          report.claims.created += (error.dreamLanded ?? []).length;
          throw error;
        });
      await stage("receipt");
      const outcomes = new Map(entries.map((entry) => [entry.claim.id, entry.decision.outcome]));
      for (const item of result.created) report.receipts.push({ claim_id: item.claimId, proposal_id: item.proposalId, disposition: "created", state: "pending", sitting_id: residue.sittingId, outcome: outcomes.get(item.claimId) });
      for (const item of result.reused) report.receipts.push({ claim_id: item.claimId, proposal_id: item.proposalId, disposition: "reused", state: item.state, sitting_id: residue.sittingId, outcome: outcomes.get(item.claimId) });
      report.claims.created += result.created.length;
      report.claims.reused += result.reused.length;
      report.sittings.distilled += 1;
      decisions.push(...entries.map((entry) => entry.decision));
      processed.add(residue.sittingId);
      // The next sitting routes against, and reconciles with, what this one just proposed.
      index = indexProposals(await store.listProposals(), proposerId);
    }

    for (const decision of decisions) report.claims[decision.outcome === "routed" ? "routed" : "uncontested"] += 1;
    const reviewItems = decisions.filter((decision) => decision.outcome === "routed").map((decision) => buildMemoryReviewItem(decision)).filter(Boolean);
    report.review_items = reviewItems.length;
    report.metrics = decisions.length ? deriveMemoryRunMetrics({ runId, decisions, reviewDecisions }) : null;
    if (!dryRun && decisions.length) {
      await stage("publish");
      await host.publish?.({ runId, decisions, reviewItems, metrics: report.metrics });
    }

    // Briefs derive from the store every run, because review changes them without any new telemetry.
    await stage("brief");
    const { items, excluded } = await briefItems(store, indexProposals(await store.listProposals(), proposerId), proposerId);
    const written = writeBriefs({
      briefsDir,
      items,
      now: now(),
      globalBudget: options.globalBudget ?? DEFAULT_GLOBAL_BUDGET_BYTES,
      projectBudget: options.projectBudget ?? DEFAULT_PROJECT_BUDGET_BYTES,
      maxEntryBytes: options.maxEntryBytes,
      includeUnreviewed: options.includeUnreviewed === true,
      reviewDecisions,
      dryRun,
    });
    report.briefs = [...written];
    report.obsolete_briefs_removed = written.removed;
    report.brief_excluded = excluded;

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
    report.cursor = { committed: false, ...(changed ? { digest: sha256(nextBytes), offset: next.telemetry.offset } : {}) };

    if (dryRun) {
      report.status = "dry-run";
      report.finished_at = now();
      return report;
    }

    report.status = changed || report.sittings.distilled + report.sittings.reused > 0 ? "success" : "noop";
    report.finished_at = now();
    await stage("report");
    writeReport();
    pruneReports(reportsDir);

    if (changed) {
      await stage("cursor");
      commitRuntimeCursor(cursorFile, next);
      fs.chmodSync(cursorFile, 0o600);
      report.cursor = { committed: true, digest: sha256(fs.readFileSync(cursorFile)), offset: next.telemetry.offset };
      writeReport();
    }
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = { code: error.code ?? "DREAM_FAILED", message: String(error.message ?? error).slice(0, 500) };
    report.cursor = { committed: false };
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
    release();
  }
}
