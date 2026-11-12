/**
 * The correction-recurrence learning loop:
 *
 *   transcripts -> human turns only (origin.kind === "human") -> drop continuation pings
 *     -> classify (model) -> keep general corrections/nudges/frustration -> cluster into themes (model)
 *     -> threshold -> enforcement rung + conflict judge (model) -> proposals
 *     -> effect-fill ratified proposals -> ledger + Survey review items
 *
 * All model work happens before the first write, so a failed call leaves the ledger as it was. A dry run reads,
 * counts, and returns; it makes no model call and writes nothing.
 *
 * @module learn/run
 */

import * as path from "node:path";

import { CLASSIFIER_VERSION, DEFAULT_BATCH_SIZE, batchCount, classifyTurns, isContinuationPing } from "./classify.js";
import { clusterRules } from "./cluster.js";
import { readRulesFile } from "./judge.js";
import { learnError } from "./model.js";
import {
  CONTRACT, CONTRACT_VERSION, DEFAULT_EFFECT_MIN_DAYS, DEFAULT_THRESHOLDS, SOURCE_FAMILY, aggregateThemes, buildProposal, fillEffects,
  highPainCount, isCorrectionEntry, ledgerThemes, qualifies, readLedger, reviewItemsPath, writeLedger, writeReviewItems,
} from "./propose.js";
import { readHumanTurns } from "./sessions.js";

export const DEFAULT_MIN_WINDOW_SESSIONS = 3;
export const DEFAULT_SINCE_DAYS = 30;

/**
 * @param {object} options
 * @param {string[]} options.roots  transcript roots to read
 * @param {string} options.ledgerPath  the learning-review-proposals ledger
 * @param {number|null} [options.sinceMs]
 * @param {number} [options.nowMs]
 * @param {boolean} [options.dryRun]
 * @param {(request: {prompt: string, tool: object}) => Promise<object>} [options.invoke]  the model; required unless dryRun
 * @param {(rule: string, rules: object) => Promise<object>} [options.judge]  the conflict judge; defaults to none (unchecked)
 * @param {string|null} [options.rulesFile]  the rule file proposals target and are judged against
 * @param {object} [options.thresholds]
 * @param {Function} [options.readMessages]  transcript reader seam (tests)
 */
export async function runLearn(options) {
  const nowMs = options.nowMs ?? Date.now();
  const sinceMs = options.sinceMs ?? null;
  const dryRun = options.dryRun === true;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isSafeInteger(value) || value < 0) throw learnError("LEARN_CONFIG_INVALID", `threshold ${key} must be a non-negative integer`);
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const minWindowSessions = options.minWindowSessions ?? DEFAULT_MIN_WINDOW_SESSIONS;
  if (!options.ledgerPath || !path.isAbsolute(options.ledgerPath)) throw learnError("LEARN_CONFIG_INVALID", "ledgerPath must be an absolute path");
  if (!dryRun && typeof options.invoke !== "function") throw learnError("LEARN_CONFIG_INVALID", "a model (invoke) is required unless dryRun");

  const { turns, report: read } = readHumanTurns({ roots: options.roots, sinceMs, untilMs: nowMs, ...(options.readMessages ? { readMessages: options.readMessages } : {}) });
  const candidates = turns.filter((turn) => !isContinuationPing(turn.text));
  const ledger = readLedger(options.ledgerPath); // strict, read-only: a corrupt ledger stops the run here
  const report = {
    ...read,
    continuation_pings_excluded: turns.length - candidates.length,
    candidates: candidates.length,
    classify_batches: dryRun ? batchCount(candidates.length, batchSize) : 0,
    classified_invalid: 0,
    occurrences: 0,
    themes: 0,
    themes_created: 0,
    qualifying_themes: 0,
    ledger_entries: ledger.entries.length,
    ledger_correction_entries: ledger.entries.filter(isCorrectionEntry).length,
    effects_filled: 0,
    model_calls: 0,
  };
  const window = { since: sinceMs, until: nowMs };
  const document = {
    schema: CONTRACT,
    version: CONTRACT_VERSION,
    source_family: SOURCE_FAMILY,
    window,
    records_considered: candidates.length,
    outcome: "ok",
    aggregates: { by_kit: [], by_gate: [], by_theme: [], partial: false },
    proposals: [],
    notes: [],
    report,
    dry_run: dryRun,
  };

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
  if (unknown > 0 && unknown >= (read.user_messages_by_origin.human ?? 0)) {
    const top = Object.entries(read.unknown_origin_by_evidence).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([evidence, n]) => `${evidence} (${n})`).join(", ");
    document.notes.push(`${unknown} user message(s) have origin "unknown" (${top}): typically prompts submitted through an SDK or IDE host, which the importer cannot tell apart from agent briefs, so they are not counted. A host that records who typed a prompt would let them count.`);
  }
  if (read.human_sessions_in_window < minWindowSessions) {
    document.outcome = "insufficient-data";
    document.aggregates.partial = true;
    document.notes.push(`${read.human_sessions_in_window} session(s) with human turns in the window; at least ${minWindowSessions} are needed (widen --since, or wait for more history)`);
    return document;
  }
  if (dryRun) return document;

  // ── model work (nothing is written until all of it has succeeded) ────────────────────────────────────────────────
  const invoke = async (request) => {
    report.model_calls += 1;
    return options.invoke(request);
  };
  const { classified, invalid } = await classifyTurns({ turns: candidates, invoke, batchSize });
  report.classified_invalid = invalid;
  const occurrences = classified.filter((item) => item.kind !== "none" && item.general);
  report.occurrences = occurrences.length;

  const { themeOf, themes, created } = occurrences.length
    ? await clusterRules({ rules: occurrences.map((item) => ({ key: item.turn.key, rule: item.rule })), existingThemes: ledgerThemes(ledger.entries), invoke })
    : { themeOf: new Map(), themes: new Map(), created: [] };
  report.themes_created = created.length;
  const rows = aggregateThemes(occurrences, themeOf, themes);
  report.themes = rows.length;
  document.aggregates.by_theme = rows.map(({ items, pain_levels, ...row }) => ({ ...row, high_pain: highPainCount({ pain_levels }, thresholds), qualifies: qualifies({ ...row, pain_levels }, thresholds) }));
  const qualifying = rows.filter((row) => qualifies(row, thresholds));
  report.qualifying_themes = qualifying.length;

  // Effect-fill comes before the proposals: a ratified rule measured now as not working moves this run's
  // proposal for the same theme up the enforcement ladder.
  const entries = [...ledger.entries];
  const occurrencesByTheme = new Map();
  for (const item of occurrences) {
    const themeId = themeOf.get(item.turn.key);
    occurrencesByTheme.set(themeId, [...(occurrencesByTheme.get(themeId) ?? []), item.turn.atMs]);
  }
  const filled = fillEffects(entries, { occurrencesByTheme, windowSinceMs: sinceMs, nowMs, minDays: options.effectMinDays ?? DEFAULT_EFFECT_MIN_DAYS, measuredAt: new Date(nowMs).toISOString() });
  report.effects_filled = filled.length;

  let rules = null;
  if (options.rulesFile) {
    rules = readRulesFile(options.rulesFile);
    if (rules.truncated) document.notes.push(`the rule file is longer than the judge is shown; only its first ${rules.lines.length} lines were checked`);
  } else {
    document.notes.push("no rule file was found or named, so proposals were not checked for conflicts (conflict_check.status = skipped)");
  }
  const rulesFileName = options.rulesFile ? path.basename(options.rulesFile) : null;
  const proposals = [];
  for (const row of qualifying) {
    let judgement = null;
    let conflictCheck = { status: "skipped", file: rulesFileName };
    if (rules && typeof options.judge === "function") {
      judgement = await options.judge(row.label, rules);
      conflictCheck = { status: "checked", file: rulesFileName };
    }
    proposals.push(buildProposal(row, { window, entries, judgement, conflictCheck, rulesFileName, thresholds, classifierVersion: CLASSIFIER_VERSION }));
  }

  // ── ledger ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const known = new Set(entries.map((entry) => entry.proposal_id));
  const appended = [];
  for (const proposal of proposals) {
    const already = known.has(proposal.proposal_id);
    if (!already) {
      appended.push(proposal);
      known.add(proposal.proposal_id);
    }
    document.proposals.push({ ...proposal, already_proposed: already });
  }
  writeLedger(options.ledgerPath, ledger, entries, filled, appended);
  const queue = writeReviewItems(options.reviewItemsPath ?? reviewItemsPath(options.ledgerPath), [...entries, ...appended]);
  report.review_items = queue.count;
  document.review_items_path = options.reviewItemsPath ?? reviewItemsPath(options.ledgerPath);
  return document;
}
