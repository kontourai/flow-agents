/**
 * The body of a dream create proposal (#671).
 *
 * #670's `proposeMemory` carries `title`, `body` and `category` into Corpus's
 * `proposeCreate`. A distilled memory claim (#1571) travels in `body` as one
 * JSON envelope, so a proposal read back from the store is a claim again, and
 * the claim's own content-addressed id refuses a body edited after the fact.
 * The envelope is also how a retry finds what an earlier attempt already
 * proposed, because Corpus has no idempotency key yet (corpus#45): the claim id
 * identifies a claim, and `sitting.id@contentHash` plus `index`/`count`
 * identifies a sitting whose claims were all proposed. The routing decision
 * travels whole, so a run that failed after proposing can still hand it to
 * review: a decision is recomputed on read and refused if it does not follow
 * from its own input.
 *
 * @module dream/envelope
 */

import { canonicalJson } from "@kontourai/relay";

import { assertMemoryClaim, recomputeMemoryRouting } from "../adapters/memory-claims/index.mjs";
import { truncateUtf8 } from "./util.js";

export const ENVELOPE_VERSION = "1.0";
export const MEMORY_CATEGORY = "memory.claim";

/** @param {{ claim: object, agreement: {passes:number,agreeing:number}|null, decision: object, project: string|null, sitting: {id:string,contentHash:string,index:number,count:number} }} input */
export function encodeEnvelope({ claim, agreement, decision, project, sitting }) {
  return canonicalJson({
    dream: ENVELOPE_VERSION,
    claim,
    agreement,
    decision,
    project,
    sitting,
  });
}

export function titleFor(claim) {
  const subject = claim.subject.label ?? claim.subject.id;
  return truncateUtf8(`${subject}: ${claim.property}`.replace(/\s+/g, " ").trim() || claim.id, 160);
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

/** The envelope in a proposal body, or null when the body is not one this module wrote or does not verify. */
export function decodeEnvelope(body) {
  try {
    const value = JSON.parse(body);
    if (!value || value.dream !== ENVELOPE_VERSION) return null;
    assertMemoryClaim(value.claim);
    const { agreement, decision, sitting } = value;
    if (agreement !== null && !(agreement && isCount(agreement.passes) && isCount(agreement.agreeing))) return null;
    // The decision must follow from its own input and be about this claim.
    if (!decision || decision.changeId !== value.claim.id || !recomputeMemoryRouting(decision).ok) return null;
    if (!sitting || typeof sitting.id !== "string" || typeof sitting.contentHash !== "string" || !isCount(sitting.index) || !isCount(sitting.count)) return null;
    if (value.project !== null && typeof value.project !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Index every proposal in the store (any state) by claim id, and the proposals
 * `proposerId` made by sitting. Only the run's own proposals can make a sitting
 * "fully proposed"; a foreign proposal with the same claim id is still indexed
 * by claim id, so the run sees it and refuses it. A proposal this module did
 * not write, or whose claim does not verify, is counted in `unreadable` and
 * otherwise ignored.
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
      unreadable += 1;
      continue;
    }
    byClaim.set(envelope.claim.id, { proposal, envelope });
    if (proposal.proposer_id !== proposerId) continue;
    const key = `${envelope.sitting.id}@${envelope.sitting.contentHash}`;
    const entry = sittings.get(key) ?? { count: envelope.sitting.count, indices: new Set(), claims: [] };
    entry.indices.add(envelope.sitting.index);
    entry.claims.push({ proposal, envelope });
    sittings.set(key, entry);
  }
  const complete = (sittingId, contentHash) => {
    const entry = sittings.get(`${sittingId}@${contentHash}`);
    return Boolean(entry) && entry.indices.size === entry.count;
  };
  const claimsOf = (sittingId, contentHash) => sittings.get(`${sittingId}@${contentHash}`)?.claims ?? [];
  return { byClaim, complete, claimsOf, unreadable };
}
