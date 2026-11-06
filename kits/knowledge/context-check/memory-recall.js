/**
 * Ask a question of memory claims a host already holds (for example in a Corpus store).
 *
 * `askLivingContext` answers from a Git revision of a store directory. A host that keeps memory claims in a database has no revision
 * to read, so this entry takes the claims themselves. It adds no rule of its own:
 *
 *   - which claims are current, contested or replaced is the brief's `classifyCurrent` (the same rules the session brief uses);
 *   - what a claim says, with its posture and review label, is `presentMemoryClaims`;
 *   - which claims match a question, and the sentence quoted, is the Living Context picker (`selectClaimsForQuestion`).
 *
 * The evidence for a claim is its own `source.excerpt`: the verbatim quote the extractor grounded it in. The result says so
 * (`evidence: "source_excerpt"`), and `answered` means a current, uncontested claim matches the question and its excerpt carries a
 * sentence on it. It does not mean the claim answers the question; `missing_terms` shows the question words it leaves out.
 *
 * Who may see a claim is the host's decision and is not redefined here. Pass only claims the asker may read. A claim whose
 * visibility is sealed is still never returned.
 *
 * @module memory-recall
 */

import { memoryInstant } from "@kontourai/flow-agents/memory-claims";
import { presentMemoryClaims } from "../adapters/memory-claims/index.mjs";
import { classifyCurrent, effectiveItems, isSealed } from "../dream/brief.js";
import { DEFAULT_LIMIT, DEFAULT_MIN_COVERAGE, DEFAULT_MIN_PASSAGE_COVERAGE, selectClaimsForQuestion } from "./living-context-select.js";

const REASONS = {
  current: undefined,
  contested: "contested",
  superseded: "replaced",
  not_current: "not_in_effect",
};

/** Whether `now` lies in the claim's half-open valid interval. An interval that cannot be read is not in effect. */
function validAt(validTime, nowMs) {
  if (!validTime) return true;
  const from = validTime.from === undefined ? -Infinity : memoryInstant(validTime.from);
  const until = validTime.until === undefined ? Infinity : memoryInstant(validTime.until);
  if (from === undefined || until === undefined || from >= until) return false;
  return from <= nowMs && nowMs < until;
}

const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * @param {object} options
 * @param {object[]} options.items        brief items: `{ claim, project, agreement, state: "applied"|"pending", routing? }`, the host's claims
 * @param {string} options.question
 * @param {string} options.now            ISO instant the question is asked at (valid time is judged here)
 * @param {object[]} [options.reviewDecisions] Survey review decisions, as for `presentMemoryClaims`
 * @param {object[]} [options.routing]    routing decisions, as for `presentMemoryClaims`
 * @param {{ multiValued?: string[] }} [options.policy] slot policy, as for `classifyCurrent`
 * @param {number} [options.limit] @param {number} [options.minCoverage] @param {number} [options.minPassageCoverage]
 */
export function recallMemoryClaims({ items, question, now, reviewDecisions = [], routing, policy, limit = DEFAULT_LIMIT, minCoverage = DEFAULT_MIN_COVERAGE, minPassageCoverage = DEFAULT_MIN_PASSAGE_COVERAGE } = {}) {
  if (!Array.isArray(items)) throw new TypeError("recallMemoryClaims needs `items`: the claims the host holds");
  if (typeof question !== "string" || question.trim() === "") throw new TypeError("recallMemoryClaims needs a question");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("recallMemoryClaims needs `now` as an ISO instant");

  const sealed = items.filter((item) => isSealed(item.claim));
  const readable = items.filter((item) => !isSealed(item.claim));
  const { presented, withheld } = presentMemoryClaims(readable.map((item) => item.claim), { routing, reviewDecisions });
  const shown = new Map(presented.map((entry) => [entry.id, entry]));
  const visible = readable.filter((item) => shown.has(item.claim.id));

  // Currency is the brief's: classify the claims as a reviewer left them (rejected dropped, corrections applied).
  const { views, byView } = effectiveItems(visible, reviewDecisions);
  const classes = classifyCurrent(views, policy);
  const statusOf = new Map();
  for (const [status, list] of Object.entries({ current: classes.current, contested: classes.contested, superseded: classes.superseded, not_current: classes.notCurrent })) {
    for (const view of list) statusOf.set(byView.get(view).claim.id, status);
  }
  for (const item of visible) {
    if (statusOf.get(item.claim.id) === "current" && !validAt(item.claim.validTime, nowMs)) statusOf.set(item.claim.id, "not_current");
  }

  const replacedBy = new Map();
  const ids = new Set(visible.map((item) => item.claim.id));
  for (const item of visible) {
    for (const edge of item.claim.supersedes ?? []) {
      if (ids.has(edge.claimId)) replacedBy.set(edge.claimId, [...(replacedBy.get(edge.claimId) ?? []), item.claim.id]);
    }
  }

  const byId = new Map(visible.map((item) => [item.claim.id, item]));
  const documents = visible.map((item) => {
    const { claim } = item;
    const entry = shown.get(claim.id);
    return { id: claim.id, title: `${entry.subject}: ${claim.property}`, tags: [claim.property], category: claim.subject.type, body: `${text(entry.value)}\n\n${claim.source.excerpt}\n`, passageBody: claim.source.excerpt, updated_at: claim.source.observedAt };
  });
  const selection = selectClaimsForQuestion({ question, documents, limit, minCoverage, minPassageCoverage });
  const base = {
    question,
    as_of: now,
    evidence: "source_excerpt",
    excluded: { sealed: sealed.length, withheld },
    stats: { claims: items.length, considered: visible.length },
    terms: selection.terms,
    below_threshold: selection.below_threshold,
  };
  if (selection.terms.length === 0) return { ...base, outcome: "abstained", abstained: "no_question_terms", results: [] };
  if (selection.selected.length === 0) return { ...base, outcome: "abstained", abstained: "no_claim_covers_question", results: [] };

  const results = selection.selected.map((pick) => {
    const item = byId.get(pick.id);
    const entry = shown.get(pick.id);
    const status = statusOf.get(pick.id) ?? "not_current";
    const quoted = pick.passage !== "";
    const answered = status === "current" && quoted;
    return {
      claim_id: pick.id,
      text: entry.text,
      status,
      review: { label: entry.review.label, routing: entry.review.routing },
      posture: entry.posture,
      value: entry.value,
      speaker: entry.speaker,
      project: item.project ?? null,
      valid_time: entry.validTime,
      observed_at: entry.source.observedAt,
      excerpt: item.claim.source.excerpt,
      history: { supersedes: (item.claim.supersedes ?? []).map((edge) => edge.claimId), replaced_by: replacedBy.get(pick.id) ?? [] },
      matched_terms: pick.matched,
      coverage: pick.coverage,
      ...(quoted ? { passage: pick.passage, missing_terms: pick.missing } : {}),
      outcome: answered ? "answered" : "abstained",
      ...(answered ? {} : { reason: status !== "current" ? REASONS[status] : "no_passage_on_question" }),
    };
  });
  const answered = results.some((result) => result.outcome === "answered");
  return { ...base, outcome: answered ? "answered" : "abstained", ...(answered ? {} : { abstained: "no_current_claim_states_it" }), results };
}
