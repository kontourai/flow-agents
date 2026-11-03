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
 * sitting therefore carries the sitting's whole `plan`: the ordered claims the
 * run decided to propose, with their agreement and project. The plan is written
 * with the first proposal, before the rest exist, so a retry reads the plan back
 * from the store and proposes only what is missing. The store is the
 * record-before-effect log; there is no second one.
 *
 * The plan holds no routing decision. A decision depends on what else is in the
 * store and on the policy in force, so each envelope carries its own, made when
 * that proposal was made, and a resumed plan is routed again for the claims it
 * still has to propose. A plan is also keyed by the visibility it was made under,
 * because visibility is part of a claim's identity: changing it starts a new plan.
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
/** The most bytes of plan one sitting carries. Every proposal repeats the plan, so this bounds the store's cost per claim. */
export const MAX_PLAN_BYTES = 192 * 1024;
/** What a stored envelope may weigh before it is refused unread: the plan, plus its own claim and decision again. */
export const MAX_ENVELOPE_BYTES = 512 * 1024;

const digestOf = (value) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
export const planDigest = (plan) => digestOf(plan);
export const visibilityKey = (visibility) => digestOf(visibility ?? null);

/**
 * @typedef {{claim: object, agreement: {passes:number,agreeing:number}|null, project: string|null}} PlanEntry
 * @param {{ plan: PlanEntry[], index: number, decision: object, sitting: {id: string, contentHash: string, visibilityKey: string} }} input
 */
export function encodeEnvelope({ plan, index, decision, sitting }) {
  const entry = plan[index];
  const body = canonicalJson({
    dream: ENVELOPE_VERSION,
    claim: entry.claim,
    agreement: entry.agreement,
    decision,
    project: entry.project,
    sitting: { id: sitting.id, contentHash: sitting.contentHash, visibilityKey: sitting.visibilityKey, index, planDigest: planDigest(plan) },
    plan,
  });
  if (Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) throw dreamError("DREAM_PLAN_TOO_LARGE", "a sitting's plan exceeds the envelope size bound");
  return body;
}

/**
 * The longest prefix of `entries` (already ordered) that fits the claim and byte bounds, and how many were left out.
 * Read max + 1 and refuse: the caller reports the rest, so nothing is cut silently.
 */
export function fitPlan(entries) {
  const plan = [];
  let bytes = 2;
  for (const entry of entries) {
    const size = Buffer.byteLength(canonicalJson(entry)) + 1;
    if (plan.length >= MAX_CLAIMS_PER_SITTING || bytes + size > MAX_PLAN_BYTES) break;
    plan.push(entry);
    bytes += size;
  }
  return { plan, dropped: entries.length - plan.length };
}

export function titleFor(claim) {
  const subject = claim.subject.label ?? claim.subject.id;
  return truncateUtf8(`${subject}: ${claim.property}`.replace(/\s+/g, " ").trim() || claim.id, 160);
}

const isCount = (value) => Number.isInteger(value) && value >= 0;
const validAgreement = (agreement) => agreement === null || Boolean(agreement && isCount(agreement.passes) && isCount(agreement.agreeing));

/** A plan entry read from the store: the claim verifies against its own id, and agreement and project are well formed. */
export function verifyEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  try {
    assertMemoryClaim(entry.claim);
  } catch {
    return false;
  }
  if (!validAgreement(entry.agreement)) return false;
  return entry.project === null || typeof entry.project === "string";
}

/** A routing decision read from the store: about this claim, and it follows from its own input. */
export function verifyDecision(decision, claim) {
  return Boolean(decision) && decision.changeId === claim.id && recomputeMemoryRouting(decision).ok;
}

/** The envelope in a proposal body, or null when the body is not one this module wrote or does not verify. */
export function decodeEnvelope(body) {
  try {
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return null;
    const value = JSON.parse(body);
    if (!value || value.dream !== ENVELOPE_VERSION) return null;
    const { plan, sitting } = value;
    if (!Array.isArray(plan) || plan.length === 0 || plan.length > MAX_CLAIMS_PER_SITTING) return null;
    if (!sitting || typeof sitting.id !== "string" || typeof sitting.contentHash !== "string" || typeof sitting.visibilityKey !== "string" || typeof sitting.planDigest !== "string" || !isCount(sitting.index)) return null;
    if (sitting.planDigest !== planDigest(plan)) return null;
    const own = plan[sitting.index];
    if (!own || canonicalJson(own) !== canonicalJson({ claim: value.claim, agreement: value.agreement, project: value.project })) return null;
    if (!verifyEntry(own) || !verifyDecision(value.decision, value.claim)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Index the store's proposals.
 *
 * - `byClaim`: every verified memory proposal by claim id, any proposer, any state.
 * - `sitting(id, contentHash, visibilityKey)`: the plan this proposer wrote for a sitting
 *   under that visibility, or null.
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
    const key = `${envelope.sitting.id}@${envelope.sitting.contentHash}@${envelope.sitting.visibilityKey}`;
    const known = sittings.get(key);
    if (known && known.planDigest !== envelope.sitting.planDigest) {
      throw dreamError("DREAM_RECEIPT_MISMATCH", `sitting ${envelope.sitting.id} has proposals that disagree on its plan`, { sittingId: envelope.sitting.id });
    }
    if (known) known.landed.add(envelope.claim.id);
    else sittings.set(key, { planDigest: envelope.sitting.planDigest, plan: envelope.plan, landed: new Set([envelope.claim.id]) });
  }
  const sitting = (sittingId, contentHash, key) => {
    const found = sittings.get(`${sittingId}@${contentHash}@${key}`);
    if (!found) return null;
    const complete = found.plan.every((entry) => byClaim.has(entry.claim.id));
    return { plan: found.plan, complete, landed: found.landed };
  };
  return { byClaim, sitting, unreadable };
}
