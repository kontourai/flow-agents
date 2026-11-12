/**
 * `@kontourai/flow-agents/learning-review-proposals`: the supported way for another program (a dashboard, a review
 * console) to find and read the learning-review-proposals ledger without copying Flow Agents internals. Read-only:
 * nothing here takes the ledger lock or writes. These are the learn loop's own functions (ledger.js, scope.js),
 * re-exported, so a consumer resolves and reads exactly what `flow-agents learn` writes.
 *
 * @module learn/learning-review-proposals
 */

export {
  LEDGER_SCHEMA_PATH,
  defaultLedger,
  ledgerDocumentSchema,
  ledgerLineSchema,
  readLearningReviewLedger,
  resolveLearningReviewLedger,
  scopeKey,
  scopeTag,
  validateLedgerLine,
} from "./ledger.js";
