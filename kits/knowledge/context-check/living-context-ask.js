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
import { runLivingContext, parseInstant } from "./living-context.js";
import { answerLivingContext } from "./living-context-answer.js";
import { deriveStoreManifest, storeKnowledgeRoot, DEFAULT_STORE_ROOT_ID } from "./living-context-store.js";
import { DEFAULT_LIMIT, DEFAULT_MIN_COVERAGE, DEFAULT_MIN_PASSAGE_COVERAGE, bestPassage, passageCoverage, selectClaimsForQuestion } from "./living-context-select.js";

export const DEFAULT_BUDGET_TOKENS = 4000;

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
 * @param {{manifest: object, records: object[]}[]} [options.additional] further derived sources (for example `deriveMemoryManifest` output) answered from alongside the store
 */
export async function askLivingContext({
  repoRoot, revision, question, reader, readers, now, verifier,
  storePath = "knowledge", workspace = "knowledge-store", repository = "knowledge-store", audience = "maintainer",
  budgetTokens = DEFAULT_BUDGET_TOKENS, limit = DEFAULT_LIMIT, minCoverage = DEFAULT_MIN_COVERAGE, minPassageCoverage = DEFAULT_MIN_PASSAGE_COVERAGE, select = selectClaimsForQuestion, owner, additional = [],
} = {}) {
  if (typeof question !== "string" || question.trim() === "") throw error("QUESTION_REQUIRED", "askLivingContext needs a question");
  if (!isIdentity(reader)) throw error("READER_IDENTITY_REQUIRED", "askLivingContext needs the reader identity (the host authenticates it)");
  parseInstant(now, "now");

  const derivedStore = deriveStoreManifest({ repoRoot, revision, storePath, readers: readers ?? [reader], ...(owner ? { owner } : {}) });
  // One manifest for the root: the store's claims and any further derived sources, with the readers every source declared.
  const store = {
    ...derivedStore,
    manifest: { readers: [...new Set([...derivedStore.manifest.readers, ...additional.flatMap((source) => source.manifest.readers)])], claims: [...derivedStore.manifest.claims, ...additional.flatMap((source) => source.manifest.claims)] },
    records: [...derivedStore.records, ...additional.flatMap((source) => source.records)],
  };
  const root = storeKnowledgeRoot(storePath, DEFAULT_STORE_ROOT_ID);
  const documents = store.records.map((record) => ({ id: record.claim_id, title: record.title, tags: record.tags, category: record.category, body: record.body, updated_at: record.updated_at }));
  const selection = select({ question, documents, limit, minCoverage, minPassageCoverage });
  const base = { question, revision: store.revision, store: store.store, reader, as_of: now, store_stats: store.stats, excluded: store.excluded, terms: selection.terms, below_threshold: selection.below_threshold };

  if (selection.terms.length === 0) return { ...base, outcome: "abstained", abstained: "no_question_terms", results: [] };
  if (selection.selected.length === 0) return { ...base, outcome: "abstained", abstained: "no_record_covers_question", results: [] };

  // A superseded record is shown with the record that replaced it, so a reader never has to guess which is current.
  const claimBy = new Map(store.manifest.claims.map((claim) => [claim.id, claim]));
  const recordBy = new Map(store.records.map((record) => [record.claim_id, record]));
  const nominated = selection.selected.map((entry) => ({ ...entry }));
  for (const entry of [...nominated]) {
    for (let id = claimBy.get(entry.id)?.superseded_by, hops = 0; id && claimBy.has(id) && hops < 8; id = claimBy.get(id).superseded_by, hops++) {
      if (nominated.some((other) => other.id === id)) continue;
      const record = recordBy.get(id);
      const candidate = bestPassage(record.body, selection.terms);
      nominated.push({ id, via: `successor_of:${entry.id}`, matched: [], passage: passageCoverage(candidate, record.title, selection.terms, selection.weights) >= minPassageCoverage ? candidate : "" });
    }
  }

  const input = {
    schema_version: "1.1", workspace, repository, revision: store.revision, target_audience: audience, reader,
    as_of: { now }, budget: { max_tokens: budgetTokens },
    claim_ids: nominated.map((entry) => entry.id),
    knowledge_roots: [root],
  };
  const derivedManifests = { [root.id]: store.manifest };
  const statements = Object.fromEntries(nominated.filter((entry) => entry.passage).map((entry) => [entry.id, entry.passage]));
  const recall = runLivingContext({ repoRoot, input, derivedManifests, write: false });
  const answer = await answerLivingContext({ repoRoot, input, derivedManifests, statements, verifier });

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
  return { ...base, outcome: results.some((result) => result.outcome === "answered") ? "answered" : "abstained", results, recall_verdict: recall.verdict, budget: recall.budget };
}
