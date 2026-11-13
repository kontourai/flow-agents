// Type-checks a read-only consumer of `@kontourai/flow-agents/learning-review-proposals` (src/cli/learning-review-ledger.test.mjs).
import {
  readLearningReviewLedger,
  resolveLearningReviewLedger,
  scopeKey,
  type LearningReviewProposal,
  type LedgerGap,
} from "@kontourai/flow-agents/learning-review-proposals";

const { ledgerPath, scope } = resolveLearningReviewLedger({ cwd: "/tmp/repo", env: {} });
const { exists, entries, gaps } = readLearningReviewLedger(ledgerPath, { scope });

function describe(entry: LearningReviewProposal): string {
  if (entry.pattern === "correction-recurrence") {
    // Narrowed: v0.2 fields are typed.
    const first = entry.evidence.defect.citations[0];
    return `${entry.enforcement.recommended} ${entry.authority} ${entry.rule} ${first?.thread_id ?? ""} ${scopeKey(entry.scope) ?? ""}`;
  }
  // Narrowed: a v0.1 kit or gate proposal.
  const kind: "kit" | "gate" = entry.target.kind;
  return `${kind}:${entry.target.id}`;
}

const lines: string[] = entries.map(describe);
const where: number[] = gaps.map((gap: LedgerGap) => gap.line);
const status: "proposed" | "ratified" | "rejected" | "deferred" | undefined = entries[0]?.decision.status;
export { exists, lines, where, status };
