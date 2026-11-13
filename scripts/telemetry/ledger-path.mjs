#!/usr/bin/env node
// Print the default learning-review-proposals ledger for the current directory, so learning-review-proposals.sh
// writes where `flow-agents learn` (and @kontourai/flow-agents/learning-review-proposals) resolve it: the repository's
// main checkout, with LEARNING_REVIEW_PROPOSALS_LEDGER / TELEMETRY_DATA_DIR overrides resolved against it. This is the
// shared resolver (kits/knowledge/learn/ledger.js), not a copy of its rule. Outside a repository, where `flow-agents
// learn` refuses, the analyzer keeps working: it uses the `--all-projects` rule (the current directory).
import { resolveLedgerTarget } from "../../kits/knowledge/learn/ledger.js";

const options = { cwd: process.cwd(), env: process.env };
let ledgerPath;
try {
  ({ ledgerPath } = resolveLedgerTarget(options));
} catch (error) {
  if (error?.code !== "LEARN_NOT_A_REPOSITORY") {
    process.stderr.write(`${error?.code ?? "LEDGER_PATH_FAILED"}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
  ({ ledgerPath } = resolveLedgerTarget({ ...options, allProjects: true }));
}
process.stdout.write(`${ledgerPath}\n`);
