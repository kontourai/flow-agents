/**
 * Turn clustered corrections into `kontour.learning-review-proposals` v0.2
 * proposals of the `correction-recurrence` source family, and keep them in the
 * contract's ledger (docs/specs/learning-review-proposals-contract.md).
 *
 * Per theme (followed to its lineage root, see cluster.js), the ledger's history
 * decides what may be proposed, and from which point in time occurrences count:
 *
 *   - an open proposal (proposed or deferred) exists: nothing new; the open one is reported.
 *   - none decided yet: count every occurrence; propose a prose rule (rung 0).
 *   - the latest decision is a rejection at R: count only occurrences after R; if they cross
 *     the threshold again, propose again at the same rung, under a new id.
 *   - the latest decision is a ratification at T: count only occurrences after T. Propose one
 *     rung higher ONLY when effect measurement says the ratified rung did not reduce the
 *     recurrence (`worsened` or `unchanged`); otherwise (not measured yet, too little data,
 *     improved) propose nothing.
 *
 * A judge finding the rule already written (`covered_by`) is reported, never escalated on.
 *
 * Everything here is pure except `readLedger`, `writeMergedLedger` and `writeReviewItems`.
 * Proposals are advisory: nothing in the learn loop edits a rules file, a skill, a hook or a
 * Veritas config.
 *
 * @module learn/propose
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { currentProposedReviewItem, reviewResourceApiVersion } from "@kontourai/survey";

import { truncateUtf8, writePrivateAtomic } from "../dream/util.js";
import { learnError } from "./model.js";
import { scopeKey } from "./scope.js";

export const SOURCE_FAMILY = "correction-recurrence";
export const PRODUCER_ID = "knowledge.learn";
export const CONTRACT = "kontour.learning-review-proposals";
export const CONTRACT_VERSION = "0.2";
export const ENFORCEMENT_LADDER = Object.freeze(["agents-md", "skill", "hook", "veritas-check"]);
export const DEFAULT_THRESHOLDS = Object.freeze({ minOccurrences: 5, minSessions: 3, minHighPain: 2, minHighPainSessions: 2, highPainLevel: 3, minInferredSessions: 2 });
/** Effect statistics: see `measureEffect`. */
export const DEFAULT_EFFECT = Object.freeze({ minDays: 14, minExpected: 3, tolerance: 0.3 });
export const MAX_CITATIONS = 8;
export const MAX_EXCERPT_BYTES = 200;
const MAX_EFFECT_HISTORY = 12;
const DAY_MS = 86_400_000;
const OPEN = new Set(["proposed", "deferred"]);
const round4 = (value) => Math.round(value * 10000) / 10000;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const isCorrectionEntry = (entry) => entry?.source?.family === SOURCE_FAMILY;

/** Follow `parents` from `themeId` to its root (a theme with no parent). A cycle stops at the first repeat. */
export function lineageRoot(themeId, parents) {
  let current = themeId;
  const seen = new Set();
  while (parents.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current);
  }
  return current;
}

/** The themes the ledger already holds (with their parents), so clustering reuses their ids. */
export function ledgerThemes(entries) {
  const themes = new Map();
  for (const entry of entries) {
    if (isCorrectionEntry(entry) && typeof entry.theme?.id === "string" && typeof entry.theme?.label === "string" && !themes.has(entry.theme.id)) {
      themes.set(entry.theme.id, { id: entry.theme.id, label: entry.theme.label, parent: typeof entry.theme.parent === "string" ? entry.theme.parent : null });
    }
  }
  return [...themes.values()];
}

/** One row for one lineage root's occurrences: how often, in how many sessions, how painful. */
export function aggregate(rootId, label, items, thresholds = DEFAULT_THRESHOLDS) {
  const sorted = [...items].sort((a, b) => a.turn.atMs - b.turn.atMs || byString(a.turn.key, b.turn.key));
  const by_kind = { correction: 0, nudge: 0, frustration: 0 };
  for (const item of sorted) by_kind[item.kind] += 1;
  const high = sorted.filter((item) => item.pain >= thresholds.highPainLevel);
  const inferred = sorted.filter((item) => item.turn.authority === "inferred");
  return {
    theme_id: rootId,
    label,
    occurrences: sorted.length,
    sessions: new Set(sorted.map((item) => item.turn.threadId)).size,
    high_pain: high.length,
    high_pain_sessions: new Set(high.map((item) => item.turn.threadId)).size,
    human_occurrences: sorted.length - inferred.length,
    human_sessions: new Set(sorted.filter((item) => item.turn.authority !== "inferred").map((item) => item.turn.threadId)).size,
    inferred_occurrences: inferred.length,
    inferred_sessions: new Set(inferred.map((item) => item.turn.threadId)).size,
    by_kind,
    mean_pain: sorted.length ? round4(sorted.reduce((sum, item) => sum + item.pain, 0) / sorted.length) : 0,
    first_at: sorted[0]?.turn.at ?? null,
    last_at: sorted.at(-1)?.turn.at ?? null,
    items: sorted,
  };
}

/**
 * Blume-style: enough recurrence across enough sessions, or enough high-pain episodes across at least two sessions.
 * Under inferred-human mode a theme also needs at least one human-origin occurrence, or inferred occurrences in at
 * least `minInferredSessions` sessions, so one misjudged session of agent briefs cannot carry a theme alone.
 */
export function qualifies(row, thresholds = DEFAULT_THRESHOLDS) {
  const authority = (row.human_occurrences ?? row.occurrences) >= 1 || (row.inferred_sessions ?? 0) >= thresholds.minInferredSessions;
  return authority && ((row.occurrences >= thresholds.minOccurrences && row.sessions >= thresholds.minSessions)
    || (row.high_pain >= thresholds.minHighPain && row.high_pain_sessions >= thresholds.minHighPainSessions));
}

const rungOf = (entry) => {
  const at = ENFORCEMENT_LADDER.indexOf(entry?.target?.kind);
  return at === -1 ? 0 : at;
};
const decidedMs = (entry) => Date.parse(entry?.decision?.decided_at ?? "");
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();

/**
 * What this theme's ledger history allows now. `entries` are this run's view of the ledger; only correction-recurrence
 * entries of the same scope whose theme has the same lineage root are this theme's history.
 *
 * @returns {{ action: "open", entry: object } | { action: "hold", reason: string, baselineMs: number }
 *   | { action: "propose", rung: number, baselineMs: number | null, suffix: string, reason: string, prior: string[] }}
 */
export function themeState({ rootId, entries, rootOf, scope }) {
  const key = scopeKey(scope);
  const mine = entries.filter((entry) => isCorrectionEntry(entry) && scopeKey(entry.scope) === key && typeof entry.theme?.id === "string" && rootOf(entry.theme.id) === rootId);
  const prior = mine.map((entry) => entry.proposal_id).sort(byString);
  const open = mine.filter((entry) => OPEN.has(entry.decision?.status));
  if (open.length) return { action: "open", entry: open.at(-1) };
  const decided = mine
    .map((entry, order) => ({ entry, order, at: decidedMs(entry) }))
    .filter(({ entry, at }) => (entry.decision?.status === "ratified" || entry.decision?.status === "rejected") && Number.isFinite(at))
    .sort((a, b) => a.at - b.at || a.order - b.order);
  const latest = decided.at(-1);
  if (!latest) return { action: "propose", rung: 0, baselineMs: null, suffix: "", reason: "first proposal for this theme: start with a prose rule", prior };
  const { entry, at } = latest;
  const since = new Date(at).toISOString();
  if (entry.decision.status === "rejected") {
    return { action: "propose", rung: rungOf(entry), baselineMs: at, suffix: `-after-${stamp(at)}`, reason: `${entry.proposal_id} was rejected on ${since}; only occurrences since then are counted, and they crossed the threshold again`, prior };
  }
  const moved = entry.effect_observed?.moved;
  if (moved === "worsened" || moved === "unchanged") {
    if (rungOf(entry) >= ENFORCEMENT_LADDER.length - 1) {
      return { action: "hold", baselineMs: at, reason: `${entry.proposal_id} is the top rung (${entry.target.kind}) and was measured ${moved}; there is no higher rung to propose` };
    }
    return { action: "propose", rung: rungOf(entry) + 1, baselineMs: at, suffix: `-after-${stamp(at)}`, reason: `ratified ${entry.target.kind} proposal ${entry.proposal_id} was measured ${moved} (recurrence did not fall); only occurrences since its ratification on ${since} are counted`, prior };
  }
  return { action: "hold", baselineMs: at, reason: moved ? `ratified ${entry.proposal_id} was measured ${moved}` : `ratified ${entry.proposal_id} has no effect measurement yet` };
}

function proposedChange(kind, rule, rulesFileName) {
  switch (kind) {
    case "agents-md": return `Add this rule to ${rulesFileName ?? "the agent rule file (AGENTS.md or CLAUDE.md)"}: "${rule}"`;
    case "skill": return `Encode "${rule}" as a skill the agent loads for this kind of work; the ratified prose rule has not reduced the recurrence.`;
    case "hook": return `Enforce "${rule}" with a harness hook that detects or blocks the behaviour; the ratified skill has not reduced the recurrence.`;
    default: return `Add an executable check to the repository's Veritas config that fails when "${rule}" is violated; the ratified hook has not reduced the recurrence.`;
  }
}

/**
 * `all` for an all-projects proposal, `r<8 hex>` (a hash of the repository identity) for a repository's. Part of
 * every proposal id, so one ledger can hold proposals of several scopes without one scope's id answering for another.
 */
export function scopeTag(scope) {
  return scope?.kind === "repo" ? `r${createHash("sha256").update(String(scope.repo)).digest("hex").slice(0, 8)}` : "all";
}

export function proposalId(kind, themeId, suffix = "", scope = { kind: "all-projects" }) {
  return `${SOURCE_FAMILY}-${kind}-${themeId}${suffix}-${scopeTag(scope)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * At most MAX_CITATIONS, highest pain first, then most recent. A proposal resting partly on inferred turns always
 * cites at least one of them (in the last slot, if none made the cut), so a reviewer can see what was inferred.
 */
function citations(items) {
  const ranked = [...items].sort((a, b) => b.pain - a.pain || b.turn.atMs - a.turn.atMs || byString(a.turn.key, b.turn.key));
  const chosen = ranked.slice(0, MAX_CITATIONS);
  const inferred = ranked.find((item) => item.turn.authority === "inferred");
  if (inferred && !chosen.some((item) => item.turn.authority === "inferred")) chosen[chosen.length - 1] = inferred;
  return chosen
    .sort((a, b) => a.turn.atMs - b.turn.atMs || byString(a.turn.key, b.turn.key))
    .map((item) => ({
      thread_id: item.turn.threadId,
      message_id: item.turn.messageId,
      harness: item.turn.harness,
      at: item.turn.at,
      authority: item.turn.authority === "inferred" ? "inferred" : "human",
      kind: item.kind,
      pain: item.pain,
      excerpt: truncateUtf8(item.turn.text.replace(/\s+/g, " ").trim(), MAX_EXCERPT_BYTES),
    }));
}

/**
 * @param {object} row  an `aggregate` row (occurrences counted since the state's baseline) that qualified
 * @param {{ state: object, window: {since: number|null, until: number}, judgement: object|null, conflictCheck: object,
 *   rulesFileName: string|null, scope: object, classifierVersion: string }} context
 */
export function buildProposal(row, { state, window, judgement, conflictCheck, rulesFileName, scope, classifierVersion }) {
  const kind = ENFORCEMENT_LADDER[state.rung];
  const from = Math.max(window.since ?? -Infinity, state.baselineMs ?? -Infinity, Date.parse(row.first_at));
  const windowDays = Math.max(1, (window.until - from) / DAY_MS);
  const cite = (j) => (j ? { file: conflictCheck.file, line: j.line, text: j.text, explanation: j.explanation, judge: "model" } : null);
  const coveredNote = judgement?.relation === "covers" ? `; line ${judgement.line} of the rule file already says this (not a reason to escalate: only a measured ratified rung is)` : "";
  return {
    proposal_id: proposalId(kind, row.theme_id, state.suffix, scope),
    source: { family: SOURCE_FAMILY, producer: PRODUCER_ID, contract_version: CONTRACT_VERSION, classifier_version: classifierVersion },
    scope,
    // "inferred" when any cited occurrence was an unknown-origin turn the author classifier judged human.
    authority: row.inferred_occurrences > 0 ? "inferred" : "human",
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
        high_pain: row.high_pain,
        high_pain_sessions: row.high_pain_sessions,
        human_occurrences: row.human_occurrences,
        human_sessions: row.human_sessions,
        inferred_occurrences: row.inferred_occurrences,
        inferred_sessions: row.inferred_sessions,
        mean_pain: row.mean_pain,
        by_kind: row.by_kind,
        first_at: row.first_at,
        last_at: row.last_at,
        counted_since: state.baselineMs === null ? null : new Date(state.baselineMs).toISOString(),
        window_days: round4(windowDays),
        rate_per_week: round4((row.occurrences * 7) / Math.max(7, windowDays)),
      },
      defect: { rule: row.label, general: true, citations: citations(row.items), citations_total: row.occurrences },
    },
    enforcement: { recommended: kind, rung: state.rung, ladder: [...ENFORCEMENT_LADDER], reason: `${state.reason}${coveredNote}`, prior_proposal_ids: state.prior },
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
 * What a ratified proposal is measured on, and the rate it is measured against.
 *
 * Human-origin turns, when the proposal's human-origin occurrences alone met the proposal threshold
 * (`minOccurrences` across `minSessions`), or when it had no inferred occurrence at all: then turning --infer-human on
 * or off never changes the measurement. Otherwise (a rule that rests mostly on inferred turns, such as 1 human and 9
 * inferred), the human rate is too small ever to measure, so it is measured on inferred turns, by an inferring run only.
 * Entries from before the human/inferred split counted human turns only.
 */
export function measurementBasis(entry, thresholds = DEFAULT_THRESHOLDS) {
  const cost = entry.evidence?.cost ?? {};
  const human = typeof cost.human_occurrences === "number" ? cost.human_occurrences : cost.occurrences;
  const inferred = typeof cost.inferred_occurrences === "number" ? cost.inferred_occurrences : 0;
  const humanSessions = typeof cost.human_sessions === "number" ? cost.human_sessions : inferred === 0 ? cost.sessions : 0;
  const humanEnough = human >= thresholds.minOccurrences && humanSessions >= thresholds.minSessions;
  const on = inferred === 0 || humanEnough ? "human" : "inferred";
  const count = on === "human" ? human : inferred;
  if (typeof count !== "number" || typeof cost.window_days !== "number") return { on, before: cost.rate_per_week };
  return { on, before: round4((count * 7) / Math.max(7, cost.window_days)) };
}

/**
 * The effect statistic. Under the rate that triggered the proposal (`before`, per week), the post-ratification period
 * of `days` would expect `expected = before * days / 7` recurrences. With fewer than `minExpected` expected, a count
 * cannot tell improvement from chance: `insufficient-data`. Otherwise the observed count is compared with a
 * multiplicative tolerance band: at most `expected * (1 - tolerance)` is `improved`, at least
 * `expected * (1 + tolerance)` is `worsened`, anything between is `unchanged`. This is a heuristic band, not a
 * significance test.
 */
export function measureEffect({ before, count, days, minExpected = DEFAULT_EFFECT.minExpected, tolerance = DEFAULT_EFFECT.tolerance }) {
  const expected = (before * days) / 7;
  const moved = expected < minExpected ? "insufficient-data"
    : count <= expected * (1 - tolerance) ? "improved"
      : count >= expected * (1 + tolerance) ? "worsened"
        : "unchanged";
  return { moved, expected: round4(expected), after: round4((count * 7) / days) };
}

/**
 * Measure ratified correction-recurrence entries of this run's scope whose ratification the run can see (the window
 * reaches back to the decision and at least `minDays` have passed). Counts follow the theme's lineage root, so a theme
 * the clusterer split later still counts. The basis (`measurementBasis`) is human-origin turns for a proposal whose
 * human occurrences alone met the threshold, so turning `--infer-human` on or off never changes it; a proposal resting
 * on inferred turns is measured on inferred turns (`measured_on: "inferred"`), and only by a run that infers
 * (`inferHuman`), never as a silent zero. An entry is re-measured on later runs, so one early sample is not final; the
 * previous measurement moves to `effect_history`. A run that would record the same count over the same whole number of
 * days changes nothing. Returns the indexes it changed.
 */
export function fillEffects(entries, { occurrencesByRoot, rootOf, scope, windowSinceMs, nowMs, measuredAt, effect = DEFAULT_EFFECT, inferHuman = false, thresholds = DEFAULT_THRESHOLDS }) {
  const key = scopeKey(scope);
  const changed = [];
  entries.forEach((entry, index) => {
    if (!isCorrectionEntry(entry) || entry.decision?.status !== "ratified" || scopeKey(entry.scope) !== key) return;
    const decided = decidedMs(entry);
    const { on, before } = measurementBasis(entry, thresholds);
    if (!Number.isFinite(decided) || typeof before !== "number" || typeof entry.theme?.id !== "string") return;
    if (on === "inferred" && !inferHuman) return; // inferred turns were not read this run: not a zero
    if (windowSinceMs !== null && windowSinceMs > decided) return; // this run did not read back to the decision
    const days = (nowMs - decided) / DAY_MS;
    if (days < effect.minDays) return;
    const count = ((occurrencesByRoot.get(rootOf(entry.theme.id)) ?? {})[on] ?? []).filter((atMs) => atMs > decided).length;
    const previous = entry.effect_observed;
    if (previous && previous.after_occurrences === count && Math.floor(previous.after_days) === Math.floor(days)) return;
    const { moved, expected, after } = measureEffect({ before, count, days, minExpected: effect.minExpected, tolerance: effect.tolerance });
    entries[index] = {
      ...entry,
      effect_observed: {
        measured_at: measuredAt,
        metric: "recurrence_per_week",
        measured_on: on,
        before,
        after,
        moved,
        after_occurrences: count,
        after_days: round4(days),
        expected_occurrences: expected,
        tolerance: effect.tolerance,
        min_expected: effect.minExpected,
      },
      ...(previous ? { effect_history: [...(entry.effect_history ?? []), previous].slice(-MAX_EFFECT_HISTORY) } : {}),
    };
    changed.push(index);
  });
  return changed;
}

/**
 * Read the ledger strictly: a line that is not a JSON object with a proposal_id stops the run before anything is
 * written. A byte-order mark and CRLF line ends are accepted (a rewrite normalizes them to LF).
 */
export function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { lines: [], entries: [] };
    throw error;
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
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

const decisionOf = (entry) => JSON.stringify([entry?.decision ?? null, entry?.follow_on_ref ?? null]);

/**
 * Merge this run's changes into the ledger as it is NOW (read under the lock), by proposal_id.
 *
 * The run decided what to propose from the ledger it read at the start. If, since then, any correction-recurrence
 * entry was added, removed, or had its human decision changed, those decisions may no longer hold: refuse with
 * `LEARN_LEDGER_CHANGED` and write nothing (run again). Lines of other producers may have changed freely; they are
 * kept as they are now, byte for byte.
 *
 * @returns {{ lines: string[], entries: object[] }} the ledger to write
 */
export function mergeIntoCurrent(base, current, updated, changedIndexes, appended) {
  const byId = (entries) => new Map(entries.map((entry) => [entry.proposal_id, entry]));
  const was = byId(base.entries.filter(isCorrectionEntry));
  const now = byId(current.entries.filter(isCorrectionEntry));
  const moved = [...new Set([...was.keys(), ...now.keys()])].filter((id) => !was.has(id) || !now.has(id) || decisionOf(was.get(id)) !== decisionOf(now.get(id)));
  if (moved.length) {
    throw learnError("LEARN_LEDGER_CHANGED", `the ledger's correction-recurrence decisions changed during this run (${moved.slice(0, 3).join(", ")}${moved.length > 3 ? ", ..." : ""}); nothing was written, run again`);
  }
  const replacements = new Map(changedIndexes.map((index) => [updated[index].proposal_id, updated[index]]));
  const lines = current.lines.map((line, index) => (replacements.has(current.entries[index].proposal_id) ? JSON.stringify(replacements.get(current.entries[index].proposal_id)) : line));
  const entries = current.entries.map((entry) => replacements.get(entry.proposal_id) ?? entry);
  const fresh = appended.filter((entry) => !now.has(entry.proposal_id));
  return { lines: [...lines, ...fresh.map((entry) => JSON.stringify(entry))], entries: [...entries, ...fresh] };
}

/** Write the merged ledger. Returns false (and writes nothing) when its lines equal the current ones. */
export function writeMergedLedger(file, current, merged) {
  if (merged.lines.length === current.lines.length && merged.lines.every((line, index) => line === current.lines[index])) return false;
  return writePrivateAtomic(file, merged.lines.length ? `${merged.lines.join("\n")}\n` : "");
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
