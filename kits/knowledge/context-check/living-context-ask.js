/**
 * Ask Living Context a question of a Knowledge store.
 *
 * One call from a person's question to a cited, abstaining answer, with no hand-built manifest:
 *
 *   1. derive the claims manifest from the store's records at the pinned revision (living-context-store.js);
 *   2. nominate claims for the question (living-context-select.js; a host may inject its own `select`);
 *   3. recall them with the as-of, reader and budget of Living Context 1.1 (currency, supersession, freshness, visibility);
 *   4. the answer step quotes the best passage of each recalled record and asks the caller's verifier whether the record
 *      says it (living-context-answer.js). Only a `current` record is ever asked; everything else abstains with its reason.
 *
 * What an `answered` outcome means: the quoted passage is in the cited record at the pinned revision, and the record is current
 * as of the stated instants. It does not mean the passage answers the question: the matched terms are returned so the reader can
 * judge that. A question the store does not talk about is an abstention, not the least-bad record.
 *
 * @module living-context-ask
 */

import { error, isIdentity } from "./index.js";
import { admittedClaimIds, runLivingContext, parseInstant } from "./living-context.js";
import { answerLivingContext } from "./living-context-answer.js";
import { deriveStoreManifest, storeKnowledgeRoot, DEFAULT_STORE_ROOT_ID } from "./living-context-store.js";
import { DEFAULT_LIMIT, DEFAULT_MIN_COVERAGE, DEFAULT_MIN_PASSAGE_COVERAGE, bestPassage, passageCoverage, selectClaimsForQuestion } from "./living-context-select.js";

export const DEFAULT_BUDGET_TOKENS = 4000;
const MAX_NOMINATED = 200;

/**
 * @param {object} options
 * @param {string} options.repoRoot     the repository worktree root that holds the store
 * @param {string} options.revision     the raw 40-hex commit to read the store at
 * @param {string} options.question
 * @param {string} options.reader       the authenticated identity asking; must be one of `readers`
 * @param {string[]} options.readers    identities the host declares may read the store
 * @param {string} options.now          UTC instant: the as-of for freshness, validity and knowledge time
 * @param {object} options.verifier     a Survey SupportVerifier (required; see living-context-answer.js)
 * @param {string} [options.storePath]  store directory relative to the repository (default `knowledge`)
 * @param {(args: object) => object} [options.select] replaces the lexical selector; same input and output shape
 * @param {number} [options.nominationBudgetTokens] token ceiling of the pass that reads successors from recall (the contract's maximum by default)
 * @param {{manifest: object, records: object[], excluded?: object[]}[]} [options.additional] further derived sources (for example `deriveMemoryManifest` output) answered from alongside the store
 */
export async function askLivingContext({
  repoRoot, revision, question, reader, readers, now, verifier,
  storePath = "knowledge", workspace = "knowledge-store", repository = "knowledge-store", audience = "maintainer",
  budgetTokens = DEFAULT_BUDGET_TOKENS, limit = DEFAULT_LIMIT, minCoverage = DEFAULT_MIN_COVERAGE, minPassageCoverage = DEFAULT_MIN_PASSAGE_COVERAGE, select = selectClaimsForQuestion, owner, additional = [], nominationBudgetTokens = 1000000,
} = {}) {
  if (typeof question !== "string" || question.trim() === "") throw error("QUESTION_REQUIRED", "askLivingContext needs a question");
  if (!isIdentity(reader)) throw error("READER_IDENTITY_REQUIRED", "askLivingContext needs the reader identity (the host authenticates it)");
  parseInstant(now, "now");

  const derivedStore = deriveStoreManifest({ repoRoot, revision, storePath, readers: readers ?? [reader], allowEmpty: additional.length > 0, ...(owner ? { owner } : {}) });
  // One manifest for the root: the store's claims and any further derived sources, with the readers every source declared.
  const store = {
    ...derivedStore,
    manifest: { readers: [...new Set([...derivedStore.manifest.readers, ...additional.flatMap((source) => source.manifest.readers)])], claims: [...derivedStore.manifest.claims, ...additional.flatMap((source) => source.manifest.claims)] },
    records: [...derivedStore.records, ...additional.flatMap((source) => source.records)],
  };
  const root = storeKnowledgeRoot(storePath, DEFAULT_STORE_ROOT_ID);
  const input = {
    schema_version: "1.1", workspace, repository, revision: store.revision, target_audience: audience, reader,
    as_of: { now }, budget: { max_tokens: budgetTokens }, knowledge_roots: [root],
  };
  const derivedManifests = { [root.id]: store.manifest };
  // Only claims this reader may see, known at `now`, are ever scored or named: a score, a nearest miss or a successor link would
  // otherwise disclose what recall answers with a plain no-answer. The same admission refuses an unknown reader first.
  const admitted = admittedClaimIds({ repoRoot, input, derivedManifests });
  // An id carried by more than one record cannot be matched to the copy recall admitted, so it is left out rather than guessed.
  const copies = new Map();
  for (const record of store.records) copies.set(record.claim_id, (copies.get(record.claim_id) ?? 0) + 1);
  const answerable = new Set([...admitted].filter((id) => copies.get(id) === 1));
  const visibleRecords = store.records.filter((record) => answerable.has(record.claim_id));
  const documents = visibleRecords.map((record) => ({ id: record.claim_id, title: record.title, tags: record.tags, category: record.category, body: record.body, updated_at: record.updated_at }));
  const selection = select({ question, documents, limit, minCoverage, minPassageCoverage });
  // Exclusions of further sources are reported by reason only: their claim ids may name claims this reader may not see.
  const excluded = [...store.excluded, ...additional.flatMap((source) => (source.excluded ?? []).map((entry) => ({ source: "additional", reason: entry.reason })))];
  const base = { question, revision: store.revision, store: store.store, reader, as_of: now, store_stats: { ...store.stats, excluded: excluded.length, known_at_now: answerable.size }, min_coverage: minCoverage, excluded, terms: selection.terms, below_threshold: selection.below_threshold };

  if (store.records.length > 0 && answerable.size === 0) return { ...base, outcome: "abstained", abstained: "no_record_known_at_now", results: [] };
  if (selection.terms.length === 0) return { ...base, outcome: "abstained", abstained: "no_question_terms", results: [] };
  if (selection.selected.length === 0) return { ...base, outcome: "abstained", abstained: "no_record_covers_question", results: [] };

  const recordBy = new Map(store.records.map((record) => [record.claim_id, record]));
  const eligible = selection.selected.filter((entry) => answerable.has(entry.id));
  const nominated = eligible.slice(0, MAX_NOMINATED).map((entry) => ({ ...entry }));
  const truncated = eligible.length - nominated.length;
  if (nominated.length === 0) return { ...base, outcome: "abstained", abstained: "nothing_answerable_nominated", results: [] };
  // A superseded record is shown with the record that replaced it. The successor is the one recall reports for this reader at this
  // instant (an edge the reader may not see, or one recorded later, is not followed), and only one that may be answered from.
  // Reading it is one recall under the largest budget the contract allows; a claim is capped at MAX_CLAIM_CHARS, so a drop is not expected,
  // and if one happens, or the nomination cap is reached, the shortfall is reported (`successors_unresolved`), never silent.
  const unresolved = [];
  const first = runLivingContext({ repoRoot, input: { ...input, budget: { max_tokens: nominationBudgetTokens }, claim_ids: nominated.map((entry) => entry.id) }, derivedManifests, write: false });
  unresolved.push(...first.budget.dropped.map((dropped) => dropped.claim_id));
  for (const recalled of first.recalls) {
    for (const link of recalled.supersession_chain ?? []) {
      if (link.relation !== "superseded_by" || link.active !== true || !answerable.has(link.claim_id) || nominated.some((other) => other.id === link.claim_id)) continue;
      if (nominated.length >= MAX_NOMINATED) { unresolved.push(recalled.claim_id); continue; }
      const record = recordBy.get(link.claim_id);
      const candidate = bestPassage(record.body, selection.terms);
      nominated.push({ id: link.claim_id, via: `successor_of:${recalled.claim_id}`, matched: [], passage: passageCoverage(candidate, record.title, selection.terms, selection.weights) >= minPassageCoverage ? candidate : "" });
    }
  }

  const requested = { ...input, claim_ids: nominated.map((entry) => entry.id) };
  const statements = Object.fromEntries(nominated.filter((entry) => entry.passage).map((entry) => [entry.id, entry.passage]));
  const recall = runLivingContext({ repoRoot, input: requested, derivedManifests, write: false });
  const answer = await answerLivingContext({ repoRoot, input: requested, derivedManifests, statements, verifier });

  const recallBy = new Map(recall.recalls.map((entry) => [entry.claim_id, entry]));
  const answerBy = new Map(answer.answers.map((entry) => [entry.claim_id, entry]));
  const results = nominated.map((entry) => {
    const record = recordBy.get(entry.id);
    const recalled = recallBy.get(entry.id);
    const answered = answerBy.get(entry.id);
    return {
      claim_id: entry.id,
      title: record.title,
      path: record.path,
      category: record.category,
      record_status: record.record_status,
      status: recalled?.status ?? "unverifiable",
      reasons: recalled?.reasons ?? [],
      ...(recalled?.superseded_by ? { superseded_by: recalled.superseded_by } : {}),
      ...(recalled?.freshness ? { freshness: recalled.freshness } : {}),
      created_at: record.created_at,
      updated_at: record.updated_at,
      ...(entry.via ? { via: entry.via } : { matched_terms: entry.matched, coverage: entry.coverage }),
      ...(entry.passage ? { passage: entry.passage } : {}),
      // Without an on-question passage the verifier was only asked about the title, which is not an answer to the question.
      ...(answered?.outcome === "answered" && entry.passage
        ? { outcome: "answered" }
        : { outcome: "abstained", reason: recalled?.status === "current" && !entry.passage ? "no_passage_on_question" : answered?.reason ?? "no_answer" }),
      ...(entry.passage_coverage === undefined ? {} : { passage_coverage: entry.passage_coverage }),
      ...(answered?.verification ? { verification: answered.verification.result } : {}),
    };
  });
  // Answered results first (stable within each group, so a predecessor still precedes its successor); the rest say why they did not answer.
  results.sort((a, b) => Number(b.outcome === "answered") - Number(a.outcome === "answered"));
  // Answered means at least one current record states the quoted passage.
  return { ...base, ...(truncated > 0 ? { nominations_truncated: truncated } : {}), ...(unresolved.length ? { successors_unresolved: [...new Set(unresolved)] } : {}), outcome: results.some((result) => result.outcome === "answered") ? "answered" : "abstained", results, recall_verdict: recall.verdict, budget: recall.budget };
}
