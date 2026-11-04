/**
 * Question-to-claim selection for Living Context.
 *
 * Recall takes claim ids; a person has a question. This is the smallest step between them: a deterministic, lexical,
 * dependency-free ranker over the claims of one derived manifest (title, tags and category, body). It is not a retrieval
 * engine and is not trusted to answer: it only nominates claim ids, and recall (currency, supersession, visibility,
 * budget) and the answer step (abstention) decide everything after. No model is called and nothing needs credentials; a
 * host that wants a semantic or model-assisted selector passes its own `select` to `askLivingContext` and gets the same
 * recall and answer steps after it.
 *
 * Why not the store's own `knowledge_context`: that tool belongs to the ops host, not to the Kit contract, ranks with a
 * backlink prior (up to +20) that outweighs a lexical score of at most 4 per keyword, and has no notion of an
 * as-of, a reader, supersession or abstention. See flow-agents#1595 for the measurement.
 *
 * Ranking: each question term is weighted by its inverse document frequency over the candidate set (a rare term decides, a
 * term in every record decides nothing). A record scores the weights of the terms it matches, ×3 for a title match, ×2 for
 * tags or category, ×1 for the body (best field per term, not a count, so length does not win). `coverage` is the share of
 * the question's total weight that the record matches; a question term found in no record still counts against every
 * record. Below `minCoverage` the record is not nominated: a question the store does not talk about gets no claims, and the
 * caller abstains with a reason instead of being handed the least-bad record.
 *
 * Overlap across a whole record is weak evidence (a long report mentions most words), so a nominated record is only quoted
 * when the passage itself, with the record title, carries `minPassageCoverage` of the question's weight. A record that is
 * nominated but has no such passage is reported as nominated and is not answered from.
 *
 * @module living-context-select
 */

import { documentUnits, statementInUnits } from "./living-context-text.js";

export const DEFAULT_MIN_COVERAGE = 0.6;
export const DEFAULT_LIMIT = 5;
export const DEFAULT_PASSAGE_CHARS = 700;
export const DEFAULT_MIN_PASSAGE_COVERAGE = 0.5;

const STOPWORDS = new Set((
  "a an the and or but not nor of to in on at by for from with without into over under about above after before between through during against " +
  "is are was were be been being am do does did done have has had having can could should would will shall may might must " +
  "what which who whom whose when where why how that this these those there here it its they them their we us our you your he she his her i me my " +
  "if then than so as also just very more most some any all each every no yes tell me please " +
  "up out need needs use used get got make made happen happens happened while"
).split(" "));

/** The terms of a text: lower-case words and numbers, stop words dropped, a trailing plural `s` folded. */
export function terms(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const folded = raw.length > 3 && raw.endsWith("s") && !/(?:ss|us|is)$/.test(raw) ? raw.slice(0, -1) : raw;
    if (!STOPWORDS.has(folded)) out.push(folded);
  }
  return out;
}

const termSet = (text) => new Set(terms(text));
/** Wikilink targets are slugs of other records: an index of them is not what a record says, so its words are not the record's words. */
const WIKILINK = /\[\[[^\]]*\]\]/g;

/**
 * The best verbatim passage of `body` for the question terms: the unit (paragraph, list item or heading) matching the most
 * distinct terms, whole when it fits in `maxChars`, otherwise the run of consecutive sentences from its best sentence on that
 * fits. Sentences are returned as the document states them (joined with one space), so the passage is always a statement the
 * deterministic verifier can find in the same document. Empty when nothing in the body matches.
 */
export function bestPassage(body, questionTerms, maxChars = DEFAULT_PASSAGE_CHARS) {
  const wanted = new Set(questionTerms);
  const matches = (text) => { let n = 0; for (const t of termSet(text)) if (wanted.has(t)) n++; return n; };
  const units = documentUnits(body);
  const scored = [];
  for (const unit of units) {
    if (unit.kind === "heading") continue;
    const text = unit.sentences.join(" ");
    // A list of links is an index, not a statement: its words are slugs of other records.
    if ((text.match(WIKILINK) ?? []).join("").length > text.length / 2) continue;
    const score = matches(text);
    if (score > 0) scored.push({ unit, score });
  }
  scored.sort((a, b) => b.score - a.score); // stable: the earlier unit wins a tie
  // A passage is only offered if the verifier will find it again in this document (a nested list or a code literal that starts with a
  // marker character may not be); the next best unit is tried instead of quoting something that cannot be checked.
  for (const { unit } of scored.slice(0, 5)) {
    const whole = unit.sentences.join(" ");
    let passage = whole;
    if (whole.length > maxChars) {
      let start = 0;
      let top = -1;
      unit.sentences.forEach((sentence, index) => { const score = matches(sentence); if (score > top) { top = score; start = index; } });
      passage = "";
      for (const sentence of unit.sentences.slice(start)) {
        const next = passage ? `${passage} ${sentence}` : sentence;
        if (next.length > maxChars) break;
        passage = next;
      }
    }
    if (passage && statementInUnits(units, passage)) return passage;
  }
  return "";
}

/** The share of the question's weight that a passage (read together with its record title) carries. */
export function passageCoverage(passage, title, questionTerms, weights) {
  const present = termSet(`${title} ${passage}`);
  let have = 0, all = 0;
  for (const t of questionTerms) { all += weights.get(t); if (present.has(t)) have += weights.get(t); }
  return all === 0 ? 0 : have / all;
}

/**
 * @param {{question: string, documents: {id: string, title: string, tags?: string[], category?: string, body: string, updated_at?: string}[], limit?: number, minCoverage?: number}} options
 * @returns {{terms: string[], weights: Map<string, number>, selected: {id: string, score: number, coverage: number, passage_coverage: number, matched: string[], passage: string}[], below_threshold: {id: string, coverage: number, matched: string[]}[]}}
 */
export function selectClaimsForQuestion({ question, documents, limit = DEFAULT_LIMIT, minCoverage = DEFAULT_MIN_COVERAGE, minPassageCoverage = DEFAULT_MIN_PASSAGE_COVERAGE } = {}) {
  const questionTerms = [...new Set(terms(question))];
  if (questionTerms.length === 0) return { terms: [], weights: new Map(), selected: [], below_threshold: [] };
  const indexed = documents.map((doc) => ({ doc, title: termSet(doc.title), meta: termSet(`${(doc.tags ?? []).join(" ")} ${doc.category ?? ""}`), body: termSet(doc.body.replace(WIKILINK, " ")) }));
  const total = indexed.length;
  const df = new Map(questionTerms.map((t) => [t, indexed.filter((e) => e.title.has(t) || e.meta.has(t) || e.body.has(t)).length]));
  const weight = (t) => Math.log(1 + (total - df.get(t) + 0.5) / (df.get(t) + 0.5));
  const weights = new Map(questionTerms.map((t) => [t, weight(t)]));
  const denominator = questionTerms.reduce((sum, t) => sum + weight(t), 0);
  const scored = indexed.map((entry) => {
    let score = 0, matchedWeight = 0;
    const matched = [];
    for (const t of questionTerms) {
      const field = entry.title.has(t) ? 3 : entry.meta.has(t) ? 2 : entry.body.has(t) ? 1 : 0;
      if (!field) continue;
      score += weight(t) * field;
      matchedWeight += weight(t);
      matched.push(t);
    }
    return { doc: entry.doc, score, coverage: matchedWeight / denominator, matched };
  }).filter((entry) => entry.matched.length > 0);
  // Best score first; a tie goes to the more recently updated record, then the id, so the order is total and repeatable.
  scored.sort((a, b) => b.score - a.score || String(b.doc.updated_at ?? "").localeCompare(String(a.doc.updated_at ?? "")) || a.doc.id.localeCompare(b.doc.id));
  const round = (n) => Math.round(n * 1000) / 1000;
  const selected = scored.filter((entry) => entry.coverage >= minCoverage).slice(0, limit)
    .map((entry) => {
      const candidate = bestPassage(entry.doc.body, entry.matched);
      const onQuestion = passageCoverage(candidate, entry.doc.title, questionTerms, weights);
      // A record whose passage is off the question is nominated, never quoted.
      return { id: entry.doc.id, score: round(entry.score), coverage: round(entry.coverage), matched: entry.matched, passage: onQuestion >= minPassageCoverage ? candidate : "", passage_coverage: round(onQuestion) };
    });
  const below = scored.filter((entry) => entry.coverage < minCoverage).slice(0, 3).map((entry) => ({ id: entry.doc.id, coverage: round(entry.coverage), matched: entry.matched }));
  return { terms: questionTerms, weights, selected, below_threshold: below };
}
