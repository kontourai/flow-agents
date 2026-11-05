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
 * sitting and the candidate's position (#1573), so each claim sent says where it
 * sits in the sitting's whole plan, and the request scope is the plan's digest:
 * a different plan for the same sitting (another visibility, a changed plan)
 * takes its own keys and cannot collide with the first. Each envelope carries the plan
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
      if (residue.source === "tool-event") {
        // Re-submit the original candidate so the stable Corpus request key
        // deduplicates a crash after effects but before cursor commit.
        fresh.push({ entry, position, previous: known.proposal });
      } else reused.push({ claimId: entry.claim.id, proposalId: known.proposal.id, state: known.proposal.state });
      return;
    }
    fresh.push({ entry, position });
  });

  const candidateFor = (position) => ({
    title: titleFor(plan[position].claim),
    category: MEMORY_CATEGORY,
    body: encodeEnvelope({ plan, index: position, decision: decisions[position], sitting }),
  });
  const candidates = fresh.map(({ position, previous }) => previous ? { title: previous.candidate.title, category: previous.candidate.category, body: previous.candidate.body } : candidateFor(position));

  if (!write) return { created, reused, preview: candidates.map((candidate, i) => ({ ...candidate, claimId: fresh[i].entry.claim.id })) };
  if (candidates.length === 0) return { created, reused, preview: [] };

  // Corpus keys a request by the sitting and the candidate's place in the batch (#1573), and refuses a different candidate
  // at a taken key. Only the claims not yet proposed are sent, so each says where it sits in the sitting's WHOLE plan
  // (`positions`); a claim already proposed is never sent again, so nothing about it (its provenance, its routing) can
  // conflict. The scope is the plan's digest, so a different plan for the same sitting (another visibility, a changed
  // plan) takes its own keys and cannot collide with, or be mistaken for, the first.
  let result;
  try {
    result = await proposeMemory({ residue, candidates, proposerId, ...host, write: true, requestScope: planDigest(plan), positions: fresh.map(({ position }) => position) });
  } catch (error) {
    // proposeMemory reports the ids it saw, but the failing call is indeterminate: ask the store what landed.
    const landed = await reconcile(host.store, proposerId, fresh);
    throw Object.assign(error, { dreamLanded: landed });
  }
  if (result.proposals.length !== candidates.length) {
    throw dreamError("DREAM_PROPOSAL_COUNT", "the store returned a different number of proposals than were requested");
  }
  result.proposals.forEach((proposalId, i) => {
    if (fresh[i].previous) {
      if (proposalId !== fresh[i].previous.id) throw dreamError("DREAM_REPLAY_MISMATCH", "replayed observation produced a different proposal");
      reused.push({ claimId: fresh[i].entry.claim.id, proposalId, state: fresh[i].previous.state });
    } else created.push({ claimId: fresh[i].entry.claim.id, proposalId });
  });
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
