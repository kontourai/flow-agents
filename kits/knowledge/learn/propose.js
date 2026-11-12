/**
 * Turn clustered corrections into `kontour.learning-review-proposals` v0.2
 * proposals of the `correction-recurrence` source family, and keep them in the
 * contract's ledger (docs/specs/learning-review-proposals-contract.md).
 *
 * Everything here is pure except `readLedger` / `writeLedger` / `writeReviewItems`.
 * Proposals are advisory: nothing here, or anywhere in the learn loop, edits a
 * rules file, a skill, a hook or a Veritas config.
 *
 * @module learn/propose
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { currentProposedReviewItem, reviewResourceApiVersion } from "@kontourai/survey";

import { truncateUtf8, writePrivateAtomic } from "../dream/util.js";
import { learnError } from "./model.js";

export const SOURCE_FAMILY = "correction-recurrence";
export const PRODUCER_ID = "knowledge.learn";
export const CONTRACT = "kontour.learning-review-proposals";
export const CONTRACT_VERSION = "0.2";
export const ENFORCEMENT_LADDER = Object.freeze(["agents-md", "skill", "hook", "veritas-check"]);
export const DEFAULT_THRESHOLDS = Object.freeze({ minOccurrences: 5, minSessions: 3, minHighPain: 2, highPainLevel: 3 });
export const DEFAULT_EFFECT_MIN_DAYS = 14;
export const MAX_CITATIONS = 8;
export const MAX_EXCERPT_BYTES = 200;
const DAY_MS = 86_400_000;
const round4 = (value) => Math.round(value * 10000) / 10000;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One row per theme: how often, in how many sessions, how painful. `occurrences` is sorted by time. */
export function aggregateThemes(occurrences, themeOf, themes) {
  const rows = new Map();
  for (const item of occurrences) {
    const themeId = themeOf.get(item.turn.key);
    if (!themeId) continue;
    const row = rows.get(themeId) ?? { theme_id: themeId, label: themes.get(themeId), items: [] };
    row.items.push(item);
    rows.set(themeId, row);
  }
  return [...rows.values()].map((row) => {
    row.items.sort((a, b) => a.turn.atMs - b.turn.atMs || byString(a.turn.key, b.turn.key));
    const by_kind = { correction: 0, nudge: 0, frustration: 0 };
    for (const item of row.items) by_kind[item.kind] += 1;
    return {
      theme_id: row.theme_id,
      label: row.label,
      occurrences: row.items.length,
      sessions: new Set(row.items.map((item) => item.turn.threadId)).size,
      pain_levels: row.items.map((item) => item.pain),
      by_kind,
      mean_pain: round4(row.items.reduce((sum, item) => sum + item.pain, 0) / row.items.length),
      first_at: row.items[0].turn.at,
      last_at: row.items[row.items.length - 1].turn.at,
      items: row.items,
    };
  }).sort((a, b) => b.occurrences - a.occurrences || byString(a.theme_id, b.theme_id));
}

export function highPainCount(row, thresholds = DEFAULT_THRESHOLDS) {
  return row.pain_levels.filter((pain) => pain >= thresholds.highPainLevel).length;
}

/** Blume-style: enough recurrence across enough sessions, or enough high-pain episodes. */
export function qualifies(row, thresholds = DEFAULT_THRESHOLDS) {
  return (row.occurrences >= thresholds.minOccurrences && row.sessions >= thresholds.minSessions)
    || highPainCount(row, thresholds) >= thresholds.minHighPain;
}

export const isCorrectionEntry = (entry) => entry?.source?.family === SOURCE_FAMILY;

/** The themes the ledger already holds, so clustering reuses their ids. */
export function ledgerThemes(entries) {
  const themes = new Map();
  for (const entry of entries) {
    if (isCorrectionEntry(entry) && typeof entry.theme?.id === "string" && typeof entry.theme?.label === "string" && !themes.has(entry.theme.id)) {
      themes.set(entry.theme.id, entry.theme.label);
    }
  }
  return [...themes].map(([id, label]) => ({ id, label }));
}

/**
 * Where on the ladder (prose rule -> skill -> hook -> executable check) this theme belongs now. It climbs one rung
 * past a ratified proposal whose measured effect shows the correction still recurring, and starts at `skill` when the
 * rule file already says it (a prose rule exists and the correction recurs anyway).
 */
export function recommendEnforcement({ themeId, entries, judgement }) {
  let rung = 0;
  const reasons = [];
  const prior = [];
  for (const entry of entries) {
    if (!isCorrectionEntry(entry) || entry.theme?.id !== themeId) continue;
    prior.push(entry.proposal_id);
    const at = ENFORCEMENT_LADDER.indexOf(entry.target?.kind);
    if (at === -1 || entry.decision?.status !== "ratified") continue;
    const moved = entry.effect_observed?.moved;
    if (moved === "worsened" || moved === "unchanged") {
      if (at + 1 > rung) reasons.push(`ratified ${entry.target.kind} proposal ${entry.proposal_id} did not reduce the recurrence (${moved})`);
      rung = Math.max(rung, at + 1);
    } else {
      rung = Math.max(rung, at);
    }
  }
  if (judgement?.relation === "covers" && rung < 1) {
    rung = 1;
    reasons.push(`line ${judgement.line} of the rule file already says this, and the correction still recurs`);
  }
  rung = Math.min(rung, ENFORCEMENT_LADDER.length - 1);
  return {
    recommended: ENFORCEMENT_LADDER[rung],
    rung,
    ladder: [...ENFORCEMENT_LADDER],
    reason: reasons.length ? reasons.join("; ") : "first proposal for this theme: start with a prose rule",
    prior_proposal_ids: prior.sort(byString),
  };
}

function proposedChange(kind, rule, rulesFileName) {
  switch (kind) {
    case "agents-md": return `Add this rule to ${rulesFileName ?? "the agent rule file (AGENTS.md or CLAUDE.md)"}: "${rule}"`;
    case "skill": return `Encode "${rule}" as a skill the agent loads for this kind of work; a prose rule alone has not held.`;
    case "hook": return `Enforce "${rule}" with a harness hook that detects or blocks the behaviour.`;
    default: return `Add an executable check to the repository's Veritas config that fails when "${rule}" is violated.`;
  }
}

export function proposalId(kind, themeId) {
  return `${SOURCE_FAMILY}-${kind}-${themeId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function citations(items) {
  return [...items]
    .sort((a, b) => b.pain - a.pain || b.turn.atMs - a.turn.atMs || byString(a.turn.key, b.turn.key))
    .slice(0, MAX_CITATIONS)
    .sort((a, b) => a.turn.atMs - b.turn.atMs || byString(a.turn.key, b.turn.key))
    .map((item) => ({
      thread_id: item.turn.threadId,
      message_id: item.turn.messageId,
      harness: item.turn.harness,
      at: item.turn.at,
      kind: item.kind,
      pain: item.pain,
      excerpt: truncateUtf8(item.turn.text.replace(/\s+/g, " ").trim(), MAX_EXCERPT_BYTES),
    }));
}

/**
 * @param {object} row  an `aggregateThemes` row that qualified
 * @param {{ window: {since: number|null, until: number}, entries: object[], judgement: object|null,
 *   conflictCheck: {status: string, file: string|null}, rulesFileName: string|null, thresholds: object, classifierVersion: string }} context
 */
export function buildProposal(row, { window, entries, judgement, conflictCheck, rulesFileName, thresholds = DEFAULT_THRESHOLDS, classifierVersion }) {
  const enforcement = recommendEnforcement({ themeId: row.theme_id, entries, judgement });
  const kind = enforcement.recommended;
  const since = window.since ?? Date.parse(row.first_at);
  const windowDays = Math.max(1, (window.until - since) / DAY_MS);
  const cite = (j) => (j ? { file: conflictCheck.file, line: j.line, text: j.text, explanation: j.explanation, judge: "model" } : null);
  return {
    proposal_id: proposalId(kind, row.theme_id),
    source: { family: SOURCE_FAMILY, producer: PRODUCER_ID, contract_version: CONTRACT_VERSION, classifier_version: classifierVersion },
    target: { kind, id: kind === "agents-md" ? (rulesFileName ?? "agent-rules") : row.theme_id },
    pattern: SOURCE_FAMILY,
    theme: { id: row.theme_id, label: row.label },
    rule: row.label,
    proposed_change: proposedChange(kind, row.label, rulesFileName),
    severity: "advisory",
    evidence: {
      // cost: what the recurrence costs the developer; defect: what the agent keeps getting wrong, with citations.
      cost: {
        occurrences: row.occurrences,
        sessions: row.sessions,
        high_pain: highPainCount(row, thresholds),
        mean_pain: row.mean_pain,
        by_kind: row.by_kind,
        first_at: row.first_at,
        last_at: row.last_at,
        window_days: round4(windowDays),
        rate_per_week: round4((row.occurrences * 7) / Math.max(7, windowDays)),
      },
      defect: { rule: row.label, general: true, citations: citations(row.items), citations_total: row.occurrences },
    },
    enforcement,
    conflict: judgement?.relation === "conflicts" ? cite(judgement) : null,
    covered_by: judgement?.relation === "covers" ? cite(judgement) : null,
    conflict_check: conflictCheck,
    expected_effect: { metric: "recurrence_per_week", direction: "decrease", description: "after the change is adopted, this correction should stop recurring in later windows" },
    decision: { status: "proposed", decided_by: null, decided_at: null, rationale: null },
    follow_on_ref: null,
    effect_observed: null,
    window: { since: window.since, until: window.until },
  };
}

/**
 * Fill `effect_observed` on ratified correction-recurrence entries whose ratification this run can measure: the
 * scanned window reaches back to the decision and at least `minDays` have passed since it. `after` is the theme's
 * recurrence per week since the decision (zero occurrences is a measurement, not a gap); `before` is the rate that
 * triggered the proposal. Returns the indexes it changed.
 */
export function fillEffects(entries, { occurrencesByTheme, windowSinceMs, nowMs, minDays = DEFAULT_EFFECT_MIN_DAYS, measuredAt }) {
  const changed = [];
  entries.forEach((entry, index) => {
    if (!isCorrectionEntry(entry) || entry.decision?.status !== "ratified" || entry.effect_observed != null) return;
    const decidedMs = Date.parse(entry.decision.decided_at ?? "");
    const before = entry.evidence?.cost?.rate_per_week;
    if (!Number.isFinite(decidedMs) || typeof before !== "number" || typeof entry.theme?.id !== "string") return;
    if (windowSinceMs !== null && windowSinceMs > decidedMs) return; // this run did not read back to the decision
    const days = (nowMs - decidedMs) / DAY_MS;
    if (days < minDays) return;
    const count = (occurrencesByTheme.get(entry.theme.id) ?? []).filter((atMs) => atMs > decidedMs).length;
    const after = round4((count * 7) / days);
    entries[index] = {
      ...entry,
      effect_observed: {
        measured_at: measuredAt,
        metric: "recurrence_per_week",
        before,
        after,
        moved: after === before ? "unchanged" : after < before ? "improved" : "worsened",
        after_occurrences: count,
        after_days: round4(days),
      },
    };
    changed.push(index);
  });
  return changed;
}

/** Read the ledger strictly: a line that is not a JSON object with a proposal_id stops the run before anything is written. */
export function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { lines: [], entries: [] };
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const entries = lines.map((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = null;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.proposal_id !== "string") {
      throw learnError("LEARN_LEDGER_CORRUPT", `ledger line ${index + 1} of ${file} is not a proposal; repair it and retry (nothing was written)`);
    }
    return entry;
  });
  return { lines, entries };
}

/** Rewrite the ledger: unchanged lines keep their exact bytes. Returns false when the file would not change. */
export function writeLedger(file, { lines }, entries, changedIndexes, appended) {
  const changed = new Set(changedIndexes);
  const out = [...lines.map((line, index) => (changed.has(index) ? JSON.stringify(entries[index]) : line)), ...appended.map((entry) => JSON.stringify(entry))];
  if (changed.size === 0 && appended.length === 0) return false;
  return writePrivateAtomic(file, out.length ? `${out.join("\n")}\n` : "");
}

const itemName = (proposalIdValue) => `learn-${proposalIdValue}`.slice(0, 120);

/**
 * The Survey ReviewItem a reviewer decides for one proposal. A proposal that conflicts with a written rule is a
 * current/proposed pair (keep the written line, or adopt the learned rule); otherwise a single proposed candidate.
 */
export function reviewItemFor(proposal) {
  const name = itemName(proposal.proposal_id);
  const target = `${proposal.target.kind}:${proposal.target.id}#${proposal.theme.id}`;
  const first = proposal.evidence.defect.citations[0];
  const claimTarget = (claimId) => ({
    claimId, subjectType: "agent-rules", subjectId: proposal.target.id, facet: "learning", claimType: `learning.${SOURCE_FAMILY}`,
    fieldOrBehavior: proposal.theme.id, impactLevel: "medium",
  });
  const proposed = {
    value: proposal.rule,
    source: { sourceRef: first ? `${first.thread_id}#${first.message_id}` : proposal.proposal_id, ...(first ? { observedAt: first.at } : {}) },
    locator: { scheme: "text-span", locator: first ? `${first.thread_id}#${first.message_id}` : proposal.proposal_id, excerpt: first?.excerpt ?? proposal.rule },
    extraction: { target: proposal.theme.id, extractor: PRODUCER_ID },
    claimTarget: claimTarget(`${proposal.proposal_id}.proposed`),
  };
  const evidence = proposal.evidence.cost;
  const rationale = `${proposal.proposed_change} Recurred ${evidence.occurrences} times in ${evidence.sessions} sessions (${evidence.high_pain} high-pain). Enforcement: ${proposal.enforcement.recommended} (${proposal.enforcement.reason}).${proposal.conflict ? ` Conflicts with ${proposal.conflict.file}:${proposal.conflict.line}.` : ""}`;
  const labels = { "learning.source": SOURCE_FAMILY, "learning.enforcement": proposal.enforcement.recommended, "learning.reviewer": "human-required" };
  if (proposal.conflict) {
    return currentProposedReviewItem({
      name, target, rationale, labels,
      current: {
        value: proposal.conflict.text,
        source: { sourceRef: proposal.conflict.file },
        locator: { scheme: "text", locator: `line:${proposal.conflict.line}`, excerpt: proposal.conflict.text },
        extraction: { target: proposal.theme.id, extractor: PRODUCER_ID },
        claimTarget: claimTarget(`${proposal.proposal_id}.current`),
      },
      proposed,
      producerPolicy: { decisionMode: "current-proposed" },
    });
  }
  return {
    apiVersion: reviewResourceApiVersion, kind: "ReviewItem", metadata: { name, labels },
    spec: {
      target, rationale, candidateSetStatus: "needs-review", projection: { candidateSetId: `${name}.candidates` },
      candidates: [{ id: `${name}.proposed`, role: "proposed", ...proposed, projection: { candidateSetId: `${name}.candidates`, candidateId: `${name}.proposed` } }],
    },
    status: { observedCandidateCount: 1 },
  };
}

/** The open review queue: one ReviewItem per correction-recurrence proposal still awaiting a decision. */
export function writeReviewItems(file, entries) {
  const items = entries.filter((entry) => isCorrectionEntry(entry) && entry.decision?.status === "proposed").map(reviewItemFor);
  return { written: writePrivateAtomic(file, `${JSON.stringify({ apiVersion: reviewResourceApiVersion, kind: "ReviewItemList", items }, null, 2)}\n`), count: items.length };
}

export const reviewItemsPath = (ledgerFile) => path.join(path.dirname(ledgerFile), "correction-recurrence.review-items.json");
