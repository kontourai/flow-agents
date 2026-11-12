/**
 * The correction-recurrence learning loop:
 *
 *   transcripts of this repository's sessions -> human turns only (origin.kind === "human") -> drop continuation pings
 *     -> classify (model) -> keep general corrections/nudges/frustration -> cluster into themes (model)
 *     -> measure ratified proposals -> per theme: history decides what may be proposed and from when occurrences count
 *     -> threshold -> conflict judge (model) -> proposals
 *     -> under the ledger lock: re-read, merge by proposal_id, write the review queue, then the ledger
 *
 * All model work happens before the lock is taken and before the first write, so a failed call leaves everything as
 * it was. A dry run reads, counts, and returns; it makes no model call and writes nothing.
 *
 * @module learn/run
 */

import * as path from "node:path";

import { inferHumanTurns } from "./author.js";
import { CLASSIFIER_VERSION, DEFAULT_BATCH_SIZE, batchCount, classifyTurns, isContinuationPing } from "./classify.js";
import { clusterRules } from "./cluster.js";
import { readRulesFile } from "./judge.js";
import { acquireLedgerLock, DEFAULT_LOCK_TIMEOUT_MS } from "./ledger-lock.js";
import { learnError } from "./model.js";
import {
  CONTRACT, CONTRACT_VERSION, DEFAULT_EFFECT, DEFAULT_THRESHOLDS, SOURCE_FAMILY, aggregate, buildProposal, fillEffects, isCorrectionEntry,
  ledgerThemes, lineageRoot, mergeIntoCurrent, qualifies, readLedger, reviewItemsPath, themeState, writeMergedLedger, writeReviewItems,
} from "./propose.js";
import { assertUntracked, scopeRecord } from "./scope.js";
import { readHumanTurns } from "./sessions.js";

export const DEFAULT_MIN_WINDOW_SESSIONS = 3;
export const DEFAULT_SINCE_DAYS = 30;

/**
 * @param {object} options
 * @param {string[]} options.roots  transcript roots to read
 * @param {string} options.ledgerPath  the learning-review-proposals ledger
 * @param {{kind: "repo", repo: string, matches: Function} | {kind: "all-projects"}} options.scope  which sessions count
 * @param {number|null} [options.sinceMs]
 * @param {number} [options.nowMs]
 * @param {boolean} [options.dryRun]
 * @param {(request: {prompt: string, tool: object}) => Promise<object>} [options.invoke]  the model; required unless dryRun
 * @param {(rule: string, rules: object) => Promise<object>} [options.judge]  the conflict judge
 * @param {string|null} [options.rulesFile]  the rule file proposals target and are judged against
 * @param {object} [options.thresholds]
 * @param {object} [options.effect]  effect statistics (`minDays`, `minExpected`, `tolerance`)
 * @param {boolean} [options.inferHuman]  opt-in: let a model judge `unknown`-origin turns (see author.js); default off
 * @param {Function} [options.readMessages]  transcript reader seam (tests)
 * @param {(stage: string) => void | Promise<void>} [options.onStage]  called at stage boundaries (tests inject here)
 */
export async function runLearn(options) {
  const nowMs = options.nowMs ?? Date.now();
  const sinceMs = options.sinceMs ?? null;
  const dryRun = options.dryRun === true;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isSafeInteger(value) || value < 0) throw learnError("LEARN_CONFIG_INVALID", `threshold ${key} must be a non-negative integer`);
  }
  const effect = { ...DEFAULT_EFFECT, ...(options.effect ?? {}) };
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const minWindowSessions = options.minWindowSessions ?? DEFAULT_MIN_WINDOW_SESSIONS;
  const stage = async (name) => options.onStage?.(name);
  if (!options.ledgerPath || !path.isAbsolute(options.ledgerPath)) throw learnError("LEARN_CONFIG_INVALID", "ledgerPath must be an absolute path");
  if (options.scope?.kind !== "repo" && options.scope?.kind !== "all-projects") throw learnError("LEARN_CONFIG_INVALID", "a scope (this repository, or all projects) is required");
  if (!dryRun && typeof options.invoke !== "function") throw learnError("LEARN_CONFIG_INVALID", "a model (invoke) is required unless dryRun");
  const queuePath = options.reviewItemsPath ?? reviewItemsPath(options.ledgerPath);
  if (!dryRun) {
    // Excerpts of transcripts must never land where Git would commit them.
    assertUntracked(options.ledgerPath);
    assertUntracked(queuePath);
  }
  const scope = scopeRecord(options.scope);

  const inferHuman = options.inferHuman === true;
  const { turns, unknownTurns, report: read } = readHumanTurns({
    roots: options.roots, sinceMs, untilMs: nowMs,
    scope: options.scope.kind === "repo" ? options.scope.matches : null,
    includeUnknown: inferHuman,
    ...(options.readMessages ? { readMessages: options.readMessages } : {}),
  });
  const humanCandidates = turns.filter((turn) => !isContinuationPing(turn.text));
  const unknownCandidates = unknownTurns.filter((turn) => !isContinuationPing(turn.text));
  const ledger = readLedger(options.ledgerPath); // strict, read-only: a corrupt ledger stops the run here
  const report = {
    ...read,
    continuation_pings_excluded: turns.length - humanCandidates.length + unknownTurns.length - unknownCandidates.length,
    infer_human: inferHuman,
    // Under --infer-human: the unknown-origin turns the author classifier would judge, and how many it kept.
    unknown_candidates: unknownCandidates.length,
    author_batches: dryRun && inferHuman ? batchCount(unknownCandidates.length, batchSize) : 0,
    inferred_human_turns: 0,
    candidates: humanCandidates.length,
    classify_batches: dryRun ? batchCount(humanCandidates.length, batchSize) : 0,
    classified_invalid: 0,
    occurrences: 0,
    themes: 0,
    themes_created: 0,
    qualifying_themes: 0,
    themes_held: 0,
    themes_open: 0,
    ledger_entries: ledger.entries.length,
    ledger_correction_entries: ledger.entries.filter(isCorrectionEntry).length,
    effects_measured: 0,
    model_calls: 0,
    model_retries: 0,
  };
  const window = { since: sinceMs, until: nowMs };
  const document = {
    schema: CONTRACT,
    version: CONTRACT_VERSION,
    source_family: SOURCE_FAMILY,
    scope,
    window,
    records_considered: humanCandidates.length,
    outcome: "ok",
    aggregates: { by_kit: [], by_gate: [], by_theme: [], partial: false },
    proposals: [],
    notes: [],
    report,
    dry_run: dryRun,
  };
  if (scope.kind === "all-projects") document.notes.push("all projects: sessions from every repository were read, and their excerpts are written into this ledger");

  // Ferry derives origin from 0.8.0. A reader that sees user messages but none with an origin cannot tell a person
  // from an agent, and must not report "no corrections" as if it had looked.
  if (read.user_messages > 0 && (read.user_messages_by_origin.absent ?? 0) === read.user_messages) {
    if (dryRun) {
      document.outcome = "origin-unavailable";
      document.notes.push("no user message carries an origin: the installed @kontourai/ferry predates origin (needs >= 0.8.0), so no turn can count as human");
      return document;
    }
    throw learnError("LEARN_ORIGIN_UNAVAILABLE", "no user message carries an origin: the installed @kontourai/ferry predates origin (needs >= 0.8.0), so no turn can be counted as human");
  }
  const unknown = read.user_messages_by_origin.unknown ?? 0;
  if (unknown > 0 && unknown >= (read.user_messages_by_origin.human ?? 0) && !inferHuman) {
    const top = Object.entries(read.unknown_origin_by_evidence).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([evidence, n]) => `${evidence} (${n})`).join(", ");
    document.notes.push(`${unknown} user message(s) have origin "unknown" (${top}): typically prompts submitted through an SDK or IDE host, which the importer cannot tell apart from agent briefs, so they are not counted. A host that records who typed a prompt would let them count.`);
  }
  if (inferHuman) {
    document.notes.push(`inferred-human mode: ${read.unknown_turns_in_window} unknown-origin turn(s) in the window; a model judges whether a person wrote each (conservatively). Proposals citing any of them say authority "inferred"; agent briefs sent through the same host can still be misjudged.`);
  }
  // With --infer-human, sessions holding unknown-origin candidates count toward the minimum too: the author
  // classifier decides later which of their turns are kept.
  const sessionsAvailable = read.human_sessions_in_window + (inferHuman ? read.unknown_sessions_in_window : 0);
  if (sessionsAvailable < minWindowSessions) {
    document.outcome = "insufficient-data";
    document.aggregates.partial = true;
    document.notes.push(`${sessionsAvailable} session(s) with ${inferHuman ? "human or unknown-origin" : "human"} turns in the window; at least ${minWindowSessions} are needed (widen --since, or wait for more history)`);
    return document;
  }
  if (dryRun) return document;

  // ── model work (nothing is locked or written until all of it has succeeded) ──────────────────────────────────────
  const invoke = async (request) => {
    report.model_calls += 1;
    return options.invoke(request);
  };
  const onRetry = () => {
    report.model_retries += 1;
  };
  const inferred = inferHuman && unknownCandidates.length ? await inferHumanTurns({ turns: unknownCandidates, invoke, batchSize, onRetry }) : [];
  report.inferred_human_turns = inferred.length;
  const candidates = [...humanCandidates, ...inferred].sort((a, b) => a.atMs - b.atMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  document.records_considered = candidates.length;
  const { classified, invalid } = await classifyTurns({ turns: candidates, invoke, batchSize, onRetry });
  report.classified_invalid = invalid;
  const occurrences = classified.filter((item) => item.kind !== "none" && item.general);
  report.occurrences = occurrences.length;

  const existingThemes = ledgerThemes(ledger.entries);
  const { themeOf, themes, parents, created } = occurrences.length
    ? await clusterRules({ rules: occurrences.map((item) => ({ key: item.turn.key, rule: item.rule })), existingThemes, invoke, onRetry })
    : { themeOf: new Map(), themes: new Map(existingThemes.map((theme) => [theme.id, theme.label])), parents: new Map(existingThemes.filter((theme) => theme.parent).map((theme) => [theme.id, theme.parent])), created: [] };
  report.themes_created = created.length;
  const rootOf = (themeId) => lineageRoot(themeId, parents);
  const byRoot = new Map();
  for (const item of occurrences) {
    const root = rootOf(themeOf.get(item.turn.key));
    byRoot.set(root, [...(byRoot.get(root) ?? []), item]);
  }
  report.themes = byRoot.size;

  // Measure first: a ratified rung measured now as not working is what allows this run to propose the next rung.
  const entries = [...ledger.entries];
  const occurrencesByRoot = new Map([...byRoot].map(([root, items]) => [root, items.map((item) => item.turn.atMs)]));
  const measured = fillEffects(entries, { occurrencesByRoot, rootOf, scope, windowSinceMs: sinceMs, nowMs, measuredAt: new Date(nowMs).toISOString(), effect });
  report.effects_measured = measured.length;

  let rules = null;
  if (options.rulesFile) {
    rules = readRulesFile(options.rulesFile);
    if (rules.truncated) document.notes.push(`the rule file is longer than the judge is shown; only its first ${rules.lines.length} lines were checked`);
  } else {
    document.notes.push("no rule file was found or named, so proposals were not checked for conflicts (conflict_check.status = skipped)");
  }
  const rulesFileName = options.rulesFile ? path.basename(options.rulesFile) : null;
  const planned = [];
  for (const root of [...byRoot.keys()].sort()) {
    const state = themeState({ rootId: root, entries, rootOf, scope });
    const items = state.action === "propose" && state.baselineMs !== null
      ? byRoot.get(root).filter((item) => item.turn.atMs > state.baselineMs)
      : byRoot.get(root);
    const row = aggregate(root, themes.get(root), items, thresholds);
    const ok = items.length > 0 && qualifies(row, thresholds);
    const { items: _items, ...visible } = row;
    document.aggregates.by_theme.push({
      ...visible,
      occurrences_in_window: byRoot.get(root).length,
      state: state.action,
      ...(state.action === "propose" ? { counted_since: state.baselineMs === null ? null : new Date(state.baselineMs).toISOString() } : {}),
      ...(state.reason ? { state_reason: state.reason } : {}),
      qualifies: ok,
    });
    if (state.action === "open") {
      report.themes_open += 1;
      document.proposals.push({ ...state.entry, already_proposed: true });
      continue;
    }
    if (state.action === "hold") {
      report.themes_held += 1;
      continue;
    }
    if (ok) planned.push({ row, state });
  }
  document.aggregates.by_theme = document.aggregates.by_theme.filter((row) => row.occurrences > 0);
  report.qualifying_themes = planned.length;

  const known = new Set(entries.map((entry) => entry.proposal_id));
  const appended = [];
  for (const { row, state } of planned) {
    let judgement = null;
    let conflictCheck = { status: "skipped", file: rulesFileName };
    if (rules && typeof options.judge === "function") {
      judgement = await options.judge(row.label, rules);
      conflictCheck = { status: "checked", file: rulesFileName };
    }
    const proposal = buildProposal(row, { state, window, judgement, conflictCheck, rulesFileName, scope, classifierVersion: CLASSIFIER_VERSION });
    const already = known.has(proposal.proposal_id);
    if (!already) {
      appended.push(proposal);
      known.add(proposal.proposal_id);
    }
    document.proposals.push({ ...proposal, already_proposed: already });
  }

  // ── commit: re-read under the lock, merge by proposal_id, write the queue, then the ledger ─────────────────────
  await stage("commit");
  const release = acquireLedgerLock(options.ledgerPath, { timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  try {
    const current = readLedger(options.ledgerPath);
    const merged = mergeIntoCurrent(ledger, current, entries, measured, appended);
    // The queue first: a ledger write that then fails leaves a queue the next run regenerates, never a ledger whose
    // new proposals no queue shows.
    const queue = writeReviewItems(queuePath, merged.entries);
    await stage("queue-written");
    writeMergedLedger(options.ledgerPath, current, merged);
    report.review_items = queue.count;
  } finally {
    release();
  }
  document.review_items_path = queuePath;
  return document;
}
