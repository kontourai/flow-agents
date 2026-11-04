#!/usr/bin/env node
/**
 * Ask a Knowledge store a question through Living Context recall.
 *
 *   node ask-cli.js --repo <worktree-root> --revision <40-hex> --reader <id> --now <UTC instant> [--store knowledge] \
 *     [--readers a,b] [--budget 4000] [--limit 5] [--min-coverage 0.6] [--json] [--manifest] "<question>"
 *
 * Read-only: it reads the store at the pinned commit and writes nothing. The support verifier is the deterministic
 * floor (a quoted passage must be in the cited record); there is no model call and nothing needs credentials.
 * `--manifest` prints the derived claims manifest and the exclusions instead of asking.
 */

import { parseArgs } from "node:util";
import { askLivingContext } from "./living-context-ask.js";
import { createLineSupportVerifier } from "./living-context-answer.js";
import { deriveStoreManifest } from "./living-context-store.js";

const USAGE = "usage: ask-cli.js --repo <root> --revision <sha> --reader <id> --now <instant> [--store knowledge] [--readers a,b] [--budget n] [--limit n] [--min-coverage x] [--min-passage-coverage x] [--json] [--manifest] \"<question>\"";

function render(result) {
  const lines = [`Q: ${result.question}`, `   revision ${result.revision.slice(0, 12)}, store ${result.store}, as of ${result.as_of}, reader ${result.reader}`,
    `   terms: ${result.terms.join(", ") || "(none)"}; ${result.store_stats.claims} records read, ${result.store_stats.excluded} excluded`];
  if (result.abstained) {
    lines.push(`A: ABSTAINED (${result.abstained})`);
    for (const near of result.below_threshold) lines.push(`   nearest below the coverage bar: ${near.id} (${near.matched.join(", ")}; coverage ${near.coverage})`);
    return lines.join("\n");
  }
  lines.push(`A: ${result.outcome.toUpperCase()}`);
  for (const item of result.results) {
    lines.push(`  - ${item.outcome.toUpperCase()}${item.reason ? ` (${item.reason})` : ""} [${item.status}${item.reasons.length ? `: ${item.reasons.join(", ")}` : ""}] ${item.title}`);
    lines.push(`      ${item.path}  (${item.record_status}, updated ${item.updated_at})${item.via ? `  via ${item.via}` : `  matched: ${item.matched_terms.join(", ")}; coverage ${item.coverage}`}`);
    if (item.superseded_by) lines.push(`      superseded by ${item.superseded_by}`);
    if (item.passage) lines.push(`      "${item.passage}"`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" }, revision: { type: "string" }, store: { type: "string", default: "knowledge" }, reader: { type: "string" }, readers: { type: "string" },
      now: { type: "string" }, budget: { type: "string" }, limit: { type: "string" }, "min-coverage": { type: "string" }, "min-passage-coverage": { type: "string" }, json: { type: "boolean", default: false }, manifest: { type: "boolean", default: false },
    },
  });
  const question = positionals.join(" ").trim();
  for (const key of ["repo", "revision", "reader", "now"]) if (!values[key]) { console.error(`missing --${key}\n${USAGE}`); return 2; }
  const readers = values.readers ? values.readers.split(",").map((entry) => entry.trim()) : [values.reader];
  if (values.manifest) {
    const derived = deriveStoreManifest({ repoRoot: values.repo, revision: values.revision, storePath: values.store, readers });
    console.log(JSON.stringify({ manifest: derived.manifest, excluded: derived.excluded, stats: derived.stats }, null, 2));
    return 0;
  }
  if (!question) { console.error(`missing question\n${USAGE}`); return 2; }
  const result = await askLivingContext({
    repoRoot: values.repo, revision: values.revision, storePath: values.store, reader: values.reader, readers, now: values.now, question, verifier: createLineSupportVerifier(),
    ...(values.budget ? { budgetTokens: Number(values.budget) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values["min-coverage"] ? { minCoverage: Number(values["min-coverage"]) } : {}), ...(values["min-passage-coverage"] ? { minPassageCoverage: Number(values["min-passage-coverage"]) } : {}),
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : render(result));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (cause) => {
  console.error(`${cause.code ?? "ERROR"}: ${cause.message}`);
  process.exitCode = 1;
});
