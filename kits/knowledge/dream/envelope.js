/**
 * The body of a dream create proposal (#671).
 *
 * #670's `proposeMemory` carries `title`, `body` and `category` into Corpus's
 * `proposeCreate`. A distilled memory claim (#1571) travels in `body` as one
 * JSON envelope, so a proposal read back from the store is a claim again, and
 * the claim's content-addressed id refuses a body edited after the fact.
 *
 * Corpus keys a create request by the sitting and the candidate's position
 * (#1573) and refuses a different candidate at a taken key, and a model is not
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

export const ENVELOPE_VERSION = "1.2";
export const MEMORY_CATEGORY = "memory.claim";
/** The most claims one sitting may propose. Beyond it the run keeps the first by claim id and reports the rest. */
export const MAX_CLAIMS_PER_SITTING = 32;
/** The most bytes of plan one sitting carries. Every proposal repeats the plan, so this bounds the store's cost per claim. */
export const MAX_PLAN_BYTES = 192 * 1024;
/** The most bytes one claim may weigh to be proposed. Larger ones are left out and counted. */
export const MAX_CLAIM_BYTES = 8 * 1024;
/**
 * What a stored envelope may weigh before it is refused unread. An envelope is the plan (<= 192 KiB), its own claim
 * (<= 8 KiB) and its routing decision, which embeds the claim, at most 16 relevant peers (<= 8 KiB each) and the
 * reasons, which repeat the peers' values: about 0.6 MiB. The bound is 4 MiB so that no honest input can reach it,
 * and a proposal is still far below Corpus's own 16 MiB limit.
 */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

const digestOf = (value) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
export const planDigest = (plan) => digestOf(plan);
/** Visibility compares as a set of audiences, as claim identity does, so the key ignores order and repeats. */
export const visibilityKey = (visibility) => {
  if (visibility?.kind === "restricted" && Array.isArray(visibility.audiences)) {
    return digestOf({ kind: "restricted", audiences: [...new Set(visibility.audiences)].sort() });
  }
  return digestOf(visibility ?? null);
};

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
 * The entries that fit the bounds, in order, and how many were left out. A claim over `MAX_CLAIM_BYTES` is left out
 * on its own and the rest are still considered; the plan stops growing at `MAX_CLAIMS_PER_SITTING` or
 * `MAX_PLAN_BYTES`. The caller reports what was left out, so nothing is cut silently.
 */
export function fitPlan(entries) {
  const plan = [];
  let bytes = 2;
  for (const entry of entries) {
    if (Buffer.byteLength(canonicalJson(entry.claim)) > MAX_CLAIM_BYTES) continue;
    const size = Buffer.byteLength(canonicalJson(entry)) + 1;
    if (plan.length >= MAX_CLAIMS_PER_SITTING || bytes + size > MAX_PLAN_BYTES) break;
    plan.push(entry);
    bytes += size;
  }
  return { plan, dropped: entries.length - plan.length };
}

/** The most claim ids and gap codes a stored projection fact carries. A slot can hold thousands of candidates. */
export const MAX_FACT_IDS = 17;
export const MAX_FACT_GAPS = 16;
export const MAX_FACT_STRING = 120;

/**
 * A projection fact small enough to store in a decision: the claim itself, then `prefer` (its rivals) first, then the
 * rest, up to MAX_FACT_IDS; at most MAX_FACT_GAPS gap codes and strings of at most MAX_FACT_STRING characters, with any
 * cut recorded in one `truncated:` code. For a contested claim the outcome is unchanged (it is still a candidate), so
 * routing is the same. `cut` counts what was left out.
 */
export function boundFact(fact, claimId, prefer = []) {
  if (!fact) return { fact, cut: 0 };
  const ids = [...new Set(fact.candidateClaimIds)];
  const named = new Set(ids);
  const picked = new Set();
  for (const id of [claimId, ...prefer, ...ids]) {
    if (picked.size >= MAX_FACT_IDS) break;
    if (named.has(id)) picked.add(id);
  }
  const idsCut = ids.length - picked.size;
  const gaps = [...new Set(fact.gapCodes.map((code) => String(code).slice(0, MAX_FACT_STRING)))].sort();
  const roomForGaps = idsCut > 0 || gaps.length > MAX_FACT_GAPS ? MAX_FACT_GAPS - 1 : MAX_FACT_GAPS;
  const kept = gaps.slice(0, roomForGaps);
  const gapCut = gaps.length - kept.length;
  if (idsCut > 0 || gapCut > 0) kept.push(`truncated:${idsCut}ids:${gapCut}gaps`);
  const reason = typeof fact.reason === "string" ? fact.reason.slice(0, MAX_FACT_STRING) : undefined;
  return { fact: { ...fact, ...(reason === undefined ? {} : { reason }), candidateClaimIds: [...picked].sort(), gapCodes: kept.sort() }, cut: idsCut + gapCut };
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
    // A claim over the bound could not have been written by this module, and would make a decision too large to store.
    if (plan.some((entry) => Buffer.byteLength(canonicalJson(entry.claim)) > MAX_CLAIM_BYTES)) return null;
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
        let format = "";
        try {
          // The size bound applies here too: an over-size body is never parsed, not even to name its format.
          const written = Buffer.byteLength(proposal.candidate.body) <= MAX_ENVELOPE_BYTES ? JSON.parse(proposal.candidate.body)?.dream : undefined;
          if (written && written !== ENVELOPE_VERSION) format = ` (written in envelope format ${String(written).slice(0, 16)}; this run reads ${ENVELOPE_VERSION})`;
        } catch {
          // not JSON at all
        }
        throw dreamError("DREAM_RECEIPT_CORRUPT", `proposal ${proposal.id} is this run's but does not verify${format}; reject it in the store to continue`, { proposalId: proposal.id });
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
