/**
 * Stage a sitting's claims as Corpus create proposals (#671 on #670).
 *
 * The dream run never applies or rejects a proposal: only a reviewer other than
 * the proposer can turn a `pending` proposal into a record (Corpus enforces
 * `SELF_APPROVAL`), and the run has no code path that calls `applyCreate`.
 *
 * Corpus has no idempotency key yet (corpus#45), so a retry reconciles against
 * the store instead: every claim already proposed, in any state, is reused by
 * its claim id. A rejected proposal stays rejected; the same claim is never
 * proposed a second time.
 *
 * @module dream/propose
 */

import { canonicalJson } from "@kontourai/relay";

import { proposeMemory } from "../promote/store-target.js";
import { MEMORY_CATEGORY, encodeEnvelope, indexProposals, titleFor } from "./envelope.js";
import { dreamError } from "./util.js";

/**
 * @param {object} options
 * @param {object} options.residue complete runtime-session residue (#669)
 * @param {{claim: object, agreement: object|null, decision: object, project: string|null}[]} options.claims
 * @param {{store: object, registerRoot: Function, root: string, rootName: string}} options.host
 * @param {string} options.proposerId
 * @param {ReturnType<typeof indexProposals>} options.index proposals already in the store
 * @param {boolean} options.write false previews the candidates and writes nothing
 * @returns {Promise<{created: object[], reused: object[], preview: object[]}>}
 */
export async function proposeSitting({ residue, claims, host, proposerId, index, write }) {
  const created = [];
  const reused = [];
  const fresh = [];
  const sitting = { id: residue.sittingId, contentHash: residue.contentHash, count: claims.length };
  claims.forEach((entry, position) => {
    const known = index.byClaim.get(entry.claim.id);
    if (known) {
      // The claim id covers the claim's content; the whole claim must match, and the proposal must be ours.
      if (known.proposal.proposer_id !== proposerId || canonicalJson(known.envelope.claim) !== canonicalJson(entry.claim)) {
        throw dreamError("DREAM_SEMANTIC_COLLISION", "an existing proposal has this claim id but different content or a different proposer", { claimId: entry.claim.id });
      }
      reused.push({ claimId: entry.claim.id, proposalId: known.proposal.id, state: known.proposal.state });
      return;
    }
    fresh.push({ ...entry, position });
  });

  const candidates = fresh.map((entry) => ({
    title: titleFor(entry.claim),
    category: MEMORY_CATEGORY,
    body: encodeEnvelope({ ...entry, sitting: { ...sitting, index: entry.position } }),
  }));

  if (!write) return { created, reused, preview: candidates.map((candidate, i) => ({ ...candidate, claimId: fresh[i].claim.id })) };
  if (candidates.length === 0) return { created, reused, preview: [] };

  let result;
  try {
    result = await proposeMemory({ residue, candidates, proposerId, ...host, write: true });
  } catch (error) {
    // proposeMemory reports the ids it saw, but the failing call is indeterminate: ask the store what landed.
    const landed = await reconcile(host.store, proposerId, fresh);
    throw Object.assign(error, { dreamLanded: landed });
  }
  if (result.proposals.length !== candidates.length) {
    throw dreamError("DREAM_PROPOSAL_COUNT", "the store returned a different number of proposals than were requested");
  }
  result.proposals.forEach((proposalId, i) => created.push({ claimId: fresh[i].claim.id, proposalId }));
  return { created, reused, preview: [] };
}

async function reconcile(store, proposerId, fresh) {
  try {
    const index = indexProposals(await store.listProposals(), proposerId);
    return fresh.filter((entry) => index.byClaim.get(entry.claim.id)?.proposal.proposer_id === proposerId).map((entry) => entry.claim.id);
  } catch {
    return null;
  }
}
