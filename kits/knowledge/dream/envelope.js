/**
 * The body of a dream create proposal (#671).
 *
 * #670's `proposeMemory` carries `title`, `body` and `category` into Corpus's
 * `proposeCreate`. A distilled memory claim (#1571) travels in `body` as one
 * JSON envelope, so a proposal read back from the store is a claim again, and
 * the claim's content-addressed id refuses a body edited after the fact.
 *
 * Corpus has no idempotency key yet (corpus#45) and a model is not
 * deterministic, so a retry must not re-extract a sitting that a failed run
 * half-proposed: it would word the claims differently. Every envelope of a
 * sitting therefore carries the sitting's whole `plan` (the ordered claims the
 * run decided to propose, with their agreement and routing decisions). The plan
 * is written with the first proposal, before the rest exist, so a retry reads
 * the plan back from the store and proposes only what is missing. The store is
 * the record-before-effect log; there is no second one.
 *
 * Every envelope of a sitting must carry the same plan (bound by `planDigest`),
 * and an envelope that does not verify is refused, never skipped: skipping would
 * re-propose, or count a sitting complete that is not.
 *
 * @module dream/envelope
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@kontourai/relay";

import { assertMemoryClaim, recomputeMemoryRouting } from "../adapters/memory-claims/index.mjs";
import { dreamError, truncateUtf8 } from "./util.js";

export const ENVELOPE_VERSION = "1.1";
export const MEMORY_CATEGORY = "memory.claim";
/** The most claims one sitting may propose. Beyond it the run keeps the first by claim id and reports the rest. */
export const MAX_CLAIMS_PER_SITTING = 32;

const digestOf = (value) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
export const planDigest = (plan) => digestOf(plan);

/**
 * @typedef {{claim: object, agreement: {passes:number,agreeing:number}|null, decision: object, project: string|null}} PlanEntry
 * @param {{ plan: PlanEntry[], index: number, sitting: {id: string, contentHash: string} }} input
 */
export function encodeEnvelope({ plan, index, sitting }) {
  const entry = plan[index];
  return canonicalJson({
    dream: ENVELOPE_VERSION,
    claim: entry.claim,
    agreement: entry.agreement,
    decision: entry.decision,
    project: entry.project,
    sitting: { id: sitting.id, contentHash: sitting.contentHash, index, planDigest: planDigest(plan) },
    plan,
  });
}

export function titleFor(claim) {
  const subject = claim.subject.label ?? claim.subject.id;
  return truncateUtf8(`${subject}: ${claim.property}`.replace(/\s+/g, " ").trim() || claim.id, 160);
}

const isCount = (value) => Number.isInteger(value) && value >= 0;
const validAgreement = (agreement) => agreement === null || Boolean(agreement && isCount(agreement.passes) && isCount(agreement.agreeing));

/** A plan entry read from the store: the claim verifies, and the decision follows from its own input and is about this claim. */
export function verifyEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  try {
    assertMemoryClaim(entry.claim);
  } catch {
    return false;
  }
  if (!validAgreement(entry.agreement)) return false;
  if (!entry.decision || entry.decision.changeId !== entry.claim.id || !recomputeMemoryRouting(entry.decision).ok) return false;
  return entry.project === null || typeof entry.project === "string";
}

/** The envelope in a proposal body, or null when the body is not one this module wrote or does not verify. */
export function decodeEnvelope(body) {
  try {
    const value = JSON.parse(body);
    if (!value || value.dream !== ENVELOPE_VERSION) return null;
    const { plan, sitting } = value;
    if (!Array.isArray(plan) || plan.length === 0 || plan.length > MAX_CLAIMS_PER_SITTING) return null;
    if (!sitting || typeof sitting.id !== "string" || typeof sitting.contentHash !== "string" || typeof sitting.planDigest !== "string" || !isCount(sitting.index)) return null;
    if (sitting.planDigest !== planDigest(plan)) return null;
    const own = plan[sitting.index];
    if (!own || canonicalJson(own) !== canonicalJson({ claim: value.claim, agreement: value.agreement, decision: value.decision, project: value.project })) return null;
    if (!verifyEntry(own)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Index the store's proposals.
 *
 * - `byClaim`: every verified memory proposal by claim id, any proposer, any state.
 * - `sitting(id, contentHash)`: the plan this proposer wrote for a sitting, or null.
 *   The plan is complete when every claim in it is in the store. All of a
 *   sitting's envelopes must agree on one plan, or this throws
 *   `DREAM_RECEIPT_MISMATCH`.
 * - A memory proposal by this proposer that does not verify and is not rejected
 *   throws `DREAM_RECEIPT_CORRUPT` naming it: the run cannot tell what it was
 *   about, so it must not propose past it. Rejecting it in Corpus clears it.
 *   Another proposer's unreadable proposal is only counted.
 *
 * @param {object[]} proposals Corpus `KitCreateProposal`s
 * @param {string} proposerId
 */
export function indexProposals(proposals, proposerId) {
  const byClaim = new Map();
  const sittings = new Map();
  let unreadable = 0;
  for (const proposal of proposals) {
    if (proposal?.candidate?.category !== MEMORY_CATEGORY) continue;
    const envelope = decodeEnvelope(proposal.candidate.body);
    if (!envelope) {
      if (proposal.proposer_id === proposerId && proposal.state !== "rejected") {
        throw dreamError("DREAM_RECEIPT_CORRUPT", `proposal ${proposal.id} is this run's but does not verify; reject it in the store to continue`, { proposalId: proposal.id });
      }
      unreadable += 1;
      continue;
    }
    byClaim.set(envelope.claim.id, { proposal, envelope });
    if (proposal.proposer_id !== proposerId) continue;
    const key = `${envelope.sitting.id}@${envelope.sitting.contentHash}`;
    const known = sittings.get(key);
    if (known && known.planDigest !== envelope.sitting.planDigest) {
      throw dreamError("DREAM_RECEIPT_MISMATCH", `sitting ${envelope.sitting.id} has proposals that disagree on its plan`, { sittingId: envelope.sitting.id });
    }
    if (known) known.landed.add(envelope.claim.id);
    else sittings.set(key, { planDigest: envelope.sitting.planDigest, plan: envelope.plan, landed: new Set([envelope.claim.id]) });
  }
  const sitting = (sittingId, contentHash) => {
    const found = sittings.get(`${sittingId}@${contentHash}`);
    if (!found) return null;
    const complete = found.plan.every((entry) => byClaim.has(entry.claim.id));
    return { plan: found.plan, complete, landed: found.landed };
  };
  return { byClaim, sitting, unreadable };
}
