/**
 * Living Context answer step: abstention kept separate from recall.
 *
 * Recall (living-context.js) returns evidence. This step decides whether the evidence supports an
 * answer, and abstains when support is thin. The decision is made by an independent
 * `@kontourai/survey` SupportVerifier over the claim and the authority text read at the pinned
 * revision, and every verdict is kept as Survey's immutable CandidateVerification record. The step
 * re-derives recall itself rather than trusting a caller-supplied result, and it never writes.
 *
 * @module living-context-answer
 */

import { runSupportVerifier, validateCandidateVerification } from "@kontourai/survey";
import { error, gitRaw } from "./index.js";
import { deriveLivingContext, parseInstant } from "./living-context.js";

/** An authority document larger than this is refused (abstain), never truncated into a verifier. */
export const MAX_EVIDENCE_BYTES = 65536;
const DEFAULT_VERIFIER_TIMEOUT_MS = 5000;

const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Deterministic fixture verifier: the claim statement must be a whole line of its authority text (ignoring case,
 * whitespace, a list or quote marker, and one trailing full stop). Anything else, including paraphrase, is
 * `not-addressed`. It never says `contradicted` and it cannot read negation: a document that quotes a statement
 * on its own line in order to reject it still "supports" it. It exists for fixtures and as a floor; a caller
 * that needs entailment must inject a model or human `SupportVerifier`, which is why one is required.
 */
export function createLineSupportVerifier() {
  const clean = (text) => normalize(text.replace(/^[\s>*+-]+/, "")).replace(/\.$/, "");
  return {
    id: "knowledge.living-context.statement-line-in-authority",
    version: "2",
    method: "deterministic",
    async verify(input) {
      const statement = clean(String(input.value));
      if (statement === "") return { result: "abstain", abstainReason: "malformed" };
      const supported = input.evidence.some((item) => item.excerpt.split(/\r?\n/).some((line) => clean(line) === statement));
      return { result: supported ? "supported" : "not-addressed" };
    },
  };
}

function readAuthority(repoRoot, revision, authorityPath) {
  const spec = `${revision}:${authorityPath}`;
  let size;
  try { size = Number(gitRaw(repoRoot, ["cat-file", "-s", spec]).trim()); } catch { return { abstain: "evidence_unreadable" }; }
  if (!Number.isInteger(size)) return { abstain: "evidence_unreadable" };
  if (size === 0) return { abstain: "evidence_empty" };
  if (size > MAX_EVIDENCE_BYTES) return { abstain: "evidence_too_large" };
  try { return { text: gitRaw(repoRoot, ["show", "--no-ext-diff", "--no-textconv", "--format=", spec]) }; } catch { return { abstain: "evidence_unreadable" }; }
}

/**
 * Answer step. For each requested claim: only a `current` recall is ever sent to the verifier; everything
 * else abstains without a model or verifier call. `answered` requires a `supported` verdict; `contradicted`
 * is reported as such, and every other verdict abstains. Any abstention makes the verdict `not_verified`.
 *
 * @returns {Promise<{schema_version:"1.1", flow:"knowledge.living-context", revision:string, reader:string, answers:object[], verdict:"answered"|"not_verified"}>}
 */
export async function answerLivingContext({ repoRoot, input, verifier, timeoutMs = DEFAULT_VERIFIER_TIMEOUT_MS } = {}) {
  // No default: choosing what counts as support is the caller's decision, never an implicit weak one.
  if (!verifier || typeof verifier.verify !== "function") throw error("VERIFIER_REQUIRED", "answerLivingContext requires an explicit Survey SupportVerifier");
  const { result, byId, repoRoot: resolvedRoot, revision } = deriveLivingContext({ repoRoot, input });
  const createdAt = new Date(parseInstant(input.as_of.now, "as_of.now")).toISOString();
  const answers = [];

  const abstain = (claimId, reason, verification) => answers.push({ claim_id: claimId, outcome: "abstained", reason, ...(verification ? { verification } : {}) });

  for (const recall of result.recalls) {
    if (recall.status !== "current") { abstain(recall.claim_id, recall.reason === "no_answer" ? "no_answer" : "not_current"); continue; }
    const claim = byId.get(recall.claim_id);
    const authority = readAuthority(resolvedRoot, revision, claim.authority.path);
    if (authority.abstain) { abstain(recall.claim_id, authority.abstain); continue; }
    const record = await runSupportVerifier(verifier, {
      candidateId: claim.id,
      value: claim.claim,
      valueType: "string",
      evidence: [{ id: `authority-${claim.id}`, excerpt: authority.text, locator: `${claim.authority.path}@${revision}` }],
    }, { timeoutMs, now: () => createdAt });
    // The record is stored as Survey wrote it; re-validate so a malformed verifier record never reaches a consumer.
    const verification = validateCandidateVerification(record);
    if (verification.result === "supported") answers.push({ claim_id: claim.id, outcome: "answered", claim: claim.claim, authority: recall.authority, verification });
    else if (verification.result === "contradicted") answers.push({ claim_id: claim.id, outcome: "contradicted", verification });
    else abstain(claim.id, verification.result === "abstain" ? `verifier_abstained:${verification.abstainReason}` : "not_addressed", verification);
  }
  for (const dropped of result.budget.dropped) abstain(dropped.claim_id, "dropped_by_budget");

  return {
    schema_version: "1.1",
    flow: "knowledge.living-context",
    revision,
    reader: input.reader,
    answers,
    verdict: answers.length > 0 && answers.every((answer) => answer.outcome === "answered") ? "answered" : "not_verified",
  };
}
