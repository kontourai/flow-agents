/**
 * Stage a sitting's plan as Corpus create proposals (#671 on #670).
 *
 * The dream run never applies or rejects a proposal: only a reviewer other than
 * the proposer can turn a `pending` proposal into a record (Corpus enforces
 * `SELF_APPROVAL`), and the run has no code path that calls `applyCreate`.
 *
 * A retry reconciles against the store: every claim already proposed, in any
 * state, is reused by its claim id. A rejected proposal stays rejected; the same
 * claim is never proposed a second time. Corpus also keys each request by the
 * sitting and the candidate's position (#1573), so the batch handed to
 * `proposeMemory` is always the sitting's whole plan in order, with each claim
 * already proposed sent back as Corpus stored it. The request scope is the plan's
 * digest, so a different plan for the same sitting (another visibility, another
 * proposer) takes its own keys and cannot collide with the first. Each envelope carries the plan
 * (see envelope.js), so a retry resumes it and does not extract again.
 *
 * @module dream/propose
 */

import { proposeMemory } from "../promote/store-target.js";
import { MEMORY_CATEGORY, encodeEnvelope, indexProposals, planDigest, titleFor } from "./envelope.js";
import { dreamError } from "./util.js";

/**
 * @param {object} options
 * @param {object} options.residue complete runtime-session residue (#669)
 * @param {import("./envelope.js").PlanEntry[]} options.plan the sitting's whole plan, in order
 * @param {object[]} options.decisions the routing decision for each plan entry, made now
 * @param {string} options.visibilityKey the visibility the plan was made under
 * @param {{store: object, registerRoot: Function, root: string, rootName: string}} options.host
 * @param {string} options.proposerId
 * @param {ReturnType<typeof indexProposals>} options.index proposals already in the store
 * @param {boolean} options.write false previews the candidates and writes nothing
 * @returns {Promise<{created: object[], reused: object[], preview: object[]}>}
 */
export async function proposeSitting({ residue, plan, decisions, visibilityKey, host, proposerId, index, write }) {
  const created = [];
  const reused = [];
  const fresh = [];
  const sitting = { id: residue.sittingId, contentHash: residue.contentHash, visibilityKey };
  plan.forEach((entry, position) => {
    const known = index.byClaim.get(entry.claim.id);
    if (known) {
      // A claim id is the digest of the claim's whole content, and a stored claim is verified against it on
      // read, so the same id is the same claim. What can differ is who proposed it, and that must be us.
      if (known.proposal.proposer_id !== proposerId) {
        throw dreamError("DREAM_SEMANTIC_COLLISION", "a proposal by another proposer already holds this claim id", { claimId: entry.claim.id });
      }
      reused.push({ claimId: entry.claim.id, proposalId: known.proposal.id, state: known.proposal.state });
      return;
    }
    fresh.push({ entry, position });
  });

  const candidateFor = (position) => ({
    title: titleFor(plan[position].claim),
    category: MEMORY_CATEGORY,
    body: encodeEnvelope({ plan, index: position, decision: decisions[position], sitting }),
  });
  const candidates = fresh.map(({ position }) => candidateFor(position));

  if (!write) return { created, reused, preview: candidates.map((candidate, i) => ({ ...candidate, claimId: fresh[i].entry.claim.id })) };
  if (candidates.length === 0) return { created, reused, preview: [] };

  // Corpus keys a request by the sitting and the candidate's POSITION in the batch it is given (#1573), and refuses a
  // different candidate at a taken position. So the batch must be the sitting's whole plan in order: a batch shortened
  // to the claims not yet proposed would give the second claim the first one's key. A claim already proposed goes in as
  // the candidate Corpus stored, byte for byte, which Corpus answers with the proposal it already holds, in any state.
  const batch = plan.map((entry, position) => {
    const known = index.byClaim.get(entry.claim.id);
    if (!known) return candidateFor(position);
    // The proposal holds this position's key only if it is this sitting's, at this position. Claim ids carry the sitting
    // (the source reference), so anything else is a receipt that does not belong to this plan.
    if (known.envelope.sitting.id !== residue.sittingId || known.envelope.sitting.index !== position) {
      throw dreamError("DREAM_RECEIPT_MISMATCH", "a proposal for this claim was made for a different sitting or position", { claimId: entry.claim.id });
    }
    const { title, body, category } = known.proposal.candidate;
    return { title, body, category };
  });

  let result;
  try {
    result = await proposeMemory({ residue, candidates: batch, proposerId, ...host, write: true, requestScope: planDigest(plan) });
  } catch (error) {
    // proposeMemory reports the ids it saw, but the failing call is indeterminate: ask the store what landed.
    const landed = await reconcile(host.store, proposerId, fresh);
    throw Object.assign(error, { dreamLanded: landed });
  }
  if (result.proposals.length !== plan.length) {
    throw dreamError("DREAM_PROPOSAL_COUNT", "the store returned a different number of proposals than were requested");
  }
  plan.forEach((entry, position) => {
    const known = index.byClaim.get(entry.claim.id);
    if (known && result.proposals[position] !== known.proposal.id) {
      throw dreamError("DREAM_PROPOSAL_MISMATCH", "the store answered a claim that was already proposed with a different proposal", { claimId: entry.claim.id });
    }
  });
  fresh.forEach(({ entry, position }) => created.push({ claimId: entry.claim.id, proposalId: result.proposals[position] }));
  return { created, reused, preview: [] };
}

async function reconcile(store, proposerId, fresh) {
  try {
    const index = indexProposals(await store.listProposals(), proposerId);
    return fresh
      .filter(({ entry }) => index.byClaim.get(entry.claim.id)?.proposal.proposer_id === proposerId)
      .map(({ entry }) => ({ claimId: entry.claim.id, proposalId: index.byClaim.get(entry.claim.id).proposal.id }));
  } catch {
    return null;
  }
}
