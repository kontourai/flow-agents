/**
 * `knowledge.learn`: the correction-recurrence learning source. Mines a developer's
 * coding-agent transcripts for corrections they keep repeating and turns them into
 * advisory, evidence-cited `kontour.learning-review-proposals` v0.2 proposals a
 * human ratifies, rejects or defers. Nothing here applies a proposal.
 *
 * @module learn
 */

export { CLASSIFIER_VERSION, CONTINUATION_PINGS, KINDS, MAX_RULE_WORDS, classifyTurns, isContinuationPing, parseClassification } from "./classify.js";
export { clusterRules, parseClusters, slugify } from "./cluster.js";
export { RELATIONS, modelJudge, parseJudgement, readRulesFile } from "./judge.js";
export { toolInvoker } from "./model.js";
export {
  CONTRACT_VERSION, DEFAULT_EFFECT, DEFAULT_THRESHOLDS, ENFORCEMENT_LADDER, SOURCE_FAMILY, aggregate, buildProposal, fillEffects, lineageRoot,
  measureEffect, mergeIntoCurrent, proposalId, qualifies, readLedger, reviewItemFor, themeState,
} from "./propose.js";
export { acquireLedgerLock, ledgerLockPath } from "./ledger-lock.js";
export { defaultLedger, readLearningReviewLedger, resolveLearningReviewLedger, validateLedgerLine } from "./ledger.js";
export { assertUntracked, repoScope, scopeKey, scopeTag } from "./scope.js";
export { DEFAULT_SINCE_DAYS, runLearn } from "./run.js";
export { defaultTranscriptRoots, humanTurns, isHumanTurn, readHumanTurns } from "./sessions.js";
