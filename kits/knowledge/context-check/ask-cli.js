#!/usr/bin/env node
/**
 * Ask a Knowledge store a question.
 *
 * You get the sentence in your store that answers it, the record file it came from, and whether that record is still current.
 * If nothing covers the question you get "ABSTAINED" and the reason. It reads one fixed commit, writes nothing, calls no model
 * and needs no credentials. The answer check is the bundled one: the quoted sentence must appear in the cited record.
 */

import { parseArgs } from "node:util";
import { askLivingContext } from "./living-context-ask.js";
import { createLineSupportVerifier } from "./living-context-answer.js";
import { deriveStoreManifest } from "./living-context-store.js";

const USAGE = `usage: ask-cli.js --repo <dir> --revision <full sha> --reader <id> --now <UTC time> [options] "<question>"

  --repo        the repository that holds your store (its top folder)
  --revision    the 40-character commit to read; use "$(git rev-parse HEAD)"
  --reader      who is asking
  --now         the moment you ask about, for example 2026-11-04T16:00:00Z. Records written after it are hidden.
                For "now", use "$(date -u +%Y-%m-%dT%H:%M:%SZ)".
  --readers     who may read the store, comma-separated (default: just --reader)
  --store       the store folder inside the repo (default: knowledge)
  --limit       most records to show (default 5)
  --min-coverage          share of the question's words a record must match (default 0.6)
  --min-passage-coverage  share of the question's words the quoted sentence and title must match (default 0.5)
  --budget      size limit of the result in tokens (default 4000); larger results are dropped whole
  --nomination-budget  size limit, in tokens, of the step that looks up newer records (default 1000000)
  --json        print the full result instead of the summary
  --manifest    print how each record was read, and what was skipped, instead of asking
  --help        print this text`;

const ABSTAIN_WHY = {
  no_record_covers_question: "no record has enough of your question's words",
  no_question_terms: "the question has only common words; add the specific nouns",
  no_record_visible_at_now: "no record you may read existed at --now; check --readers, or set --now to a later time",
  nothing_answerable_nominated: "nothing that matched can be answered from",
};
const ITEM_WHY = {
  not_current: "not current",
  no_passage_on_question: "no single sentence in it matches the question",
  dropped_by_budget: "the result was too large for --budget",
  not_addressed: "the record does not state that sentence",
  no_answer: "no answer",
};

function render(result) {
  const titles = new Map(result.results.map((item) => [item.claim_id, item.title]));
  const lines = [
    `Q: ${result.question}`,
    `   Read "${result.store}" at commit ${result.revision.slice(0, 12)} as of ${result.as_of}, for reader ${result.reader}.`,
    `   Searched for: ${result.terms.join(", ") || "(nothing)"}. Records: ${result.store_stats.claims} read, ${result.store_stats.visible_at_now ?? result.store_stats.claims} readable at that time, ${result.store_stats.excluded} skipped.`,
  ];
  const reasons = new Map();
  for (const entry of result.excluded) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  if (reasons.size) lines.push(`   Skipped: ${[...reasons].map(([reason, count]) => `${reason} x${count}`).join(", ")}.`);
  if (result.nominations_truncated) lines.push(`   WARNING: ${result.nominations_truncated} more matching records were not checked (limit of 200 reached). Narrow the question.`);
  if (result.successors_unresolved) lines.push(`   WARNING: could not check for newer records for ${result.successors_unresolved.length} matching records (${result.successors_unresolved.slice(0, 3).join(", ")}${result.successors_unresolved.length > 3 ? ", ..." : ""}). A replaced record may be listed without what replaced it.`);
  if (result.abstained) {
    lines.push(`A: ABSTAINED - ${ABSTAIN_WHY[result.abstained] ?? result.abstained} (${result.abstained})`);
    for (const near of result.below_threshold) lines.push(`   Nearest miss: ${near.id} (matched ${near.matched.join(", ")}; covers ${near.coverage} of the question, needs ${result.min_coverage ?? 0.6}).`);
    return lines.join("\n");
  }
  const allDropped = result.results.length > 0 && result.results.every((item) => item.reason === "dropped_by_budget");
  lines.push(result.outcome === "answered" ? "A: ANSWERED - at least one record states the sentence quoted below." : allDropped ? "A: ABSTAINED - every result was too large for --budget; raise it." : "A: ABSTAINED - no record states a sentence that answers it.");
  for (const item of result.results) {
    const answered = item.outcome === "answered";
    const why = answered ? "" : ` - ${ITEM_WHY[item.reason] ?? item.reason}`;
    lines.push(`  - ${answered ? "ANSWERED" : "ABSTAINED"}${why}: ${item.title}`);
    const stored = ["active", "implemented"].includes(item.record_status) ? "" : `; stored status "${item.record_status}"`;
    lines.push(`      from ${item.path} [${item.status}${stored}], updated ${item.updated_at}`);
    if (item.superseded_by) lines.push(`      replaced by "${titles.get(item.superseded_by) ?? item.superseded_by}"`);
    lines.push(item.via ? `      shown because it replaces "${titles.get(item.via.replace("successor_of:", "")) ?? item.via.replace("successor_of:", "")}"` : `      matched: ${item.matched_terms.join(", ")} (covers ${item.coverage} of the question)`);
    if (item.passage) lines.push(`      ${answered ? "" : "context only, not an answer: "}"${item.passage}"`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" }, revision: { type: "string" }, store: { type: "string", default: "knowledge" }, reader: { type: "string" }, readers: { type: "string" },
      now: { type: "string" }, budget: { type: "string" }, limit: { type: "string" }, "min-coverage": { type: "string" }, "min-passage-coverage": { type: "string" }, "nomination-budget": { type: "string" },
      json: { type: "boolean", default: false }, manifest: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }
  const question = positionals.join(" ").trim();
  for (const key of ["repo", "revision", "reader", "now"]) if (!values[key]) { console.error(`missing --${key}\n${USAGE}`); return 2; }
  if (!/^[0-9a-f]{40}$/i.test(values.revision)) { console.error(`--revision must be a full 40-character commit id; use "$(git rev-parse HEAD)"`); return 2; }
  const readers = values.readers ? values.readers.split(",").map((entry) => entry.trim()) : [values.reader];
  if (values.manifest) {
    const derived = deriveStoreManifest({ repoRoot: values.repo, revision: values.revision, storePath: values.store, readers });
    console.log(JSON.stringify({ manifest: derived.manifest, excluded: derived.excluded, stats: derived.stats }, null, 2));
    return 0;
  }
  if (!question) { console.error(`missing question\n${USAGE}`); return 2; }
  let result;
  try {
    result = await askLivingContext({
      repoRoot: values.repo, revision: values.revision, storePath: values.store, reader: values.reader, readers, now: values.now, question, verifier: createLineSupportVerifier(),
      ...(values.budget ? { budgetTokens: Number(values.budget) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values["min-coverage"] ? { minCoverage: Number(values["min-coverage"]) } : {}), ...(values["min-passage-coverage"] ? { minPassageCoverage: Number(values["min-passage-coverage"]) } : {}), ...(values["nomination-budget"] ? { nominationBudgetTokens: Number(values["nomination-budget"]) } : {}),
    });
  } catch (cause) {
    if (cause.code === "UNKNOWN_READER_IDENTITY") { console.error(`UNKNOWN_READER_IDENTITY: reader "${values.reader}" is not in --readers (${readers.join(", ")})`); return 1; }
    throw cause;
  }
  console.log(values.json ? JSON.stringify(result, null, 2) : render(result));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (cause) => {
  console.error(`${cause.code ?? "ERROR"}: ${cause.message}`);
  process.exitCode = 1;
});
