/**
 * Proposal-only bridge to the host-composed Corpus store (corpus#40).
 * The host authorizes and registers the root and supplies the store; this
 * module neither discovers roots nor owns record transactions.
 */

import path from "node:path";
import { createHash } from "node:crypto";

/** @typedef {Pick<import('@kontourai/corpus-store').KnowledgeStoreCreateProposals, 'proposeCreate'>} CreateProposalStore */

/** @param {unknown} value @param {string} label @returns {string} */
function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`store target requires ${label}`);
  return value;
}

/**
 * Stage already-distilled candidates from a #669 runtime sitting. Extraction is
 * the caller's responsibility; a transcript is never treated as a proposal.
 *
 * @param {{residue: {source: string, complete: boolean, sittingId: string, provenance: {sessionId: string, transcriptRef: string}}, candidates: {title: string, body: string, category: string}[], proposerId: string,
 *   store: CreateProposalStore, registerRoot: (name: string, root: string) => unknown, root: string,
 *   rootName: string, write?: boolean}} options
 */
export async function proposeMemory({ residue, candidates, proposerId, store, registerRoot, root, rootName, write = true }) {
  if (residue?.source !== 'runtime-session' || residue.complete !== true) throw new Error('store target requires a complete runtime-session residue');
  const sessionId = required(residue.provenance?.sessionId, 'sessionId');
  const transcriptRef = required(residue.provenance?.transcriptRef, 'transcriptRef');
  const sittingId = required(residue.sittingId, 'sittingId');
  required(proposerId, 'proposerId');
  required(rootName, 'rootName');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('store target requires a host-authorized absolute root');
  if (!Array.isArray(candidates)) throw new Error('store target requires distilled candidates');
  if (!store || typeof store.proposeCreate !== 'function') throw new Error('store target requires a Corpus create-proposal store');
  if (typeof registerRoot !== 'function') throw new Error('store target requires host root registration');
  const provenance = { session_id: sessionId, transcript_ref: transcriptRef, sitting_id: sittingId };
  /** @type {import('@kontourai/corpus-store').CreateInput[]} */
  const prepared = candidates.map((item) => ({
    type: 'raw',
    title: required(item?.title, 'candidate title'),
    body: required(item?.body, 'candidate body'),
    category: required(item?.category, 'candidate category'),
    provenance: { agent: proposerId, session_id: sessionId, note: JSON.stringify(provenance) },
  }));
  if (!write) return { root: rootName, posture: 'preview', proposals: [], candidates: prepared };
  if (prepared.length === 0) return { root: rootName, posture: 'noop', proposals: [] };
  await registerRoot(rootName, root);
  const proposals = [];
  for (const [index, candidate] of prepared.entries()) {
    // Identity excludes candidate content and mutable provenance: changes at the same position
    // must conflict, not mint a new proposal. Corpus owns durable deduplication.
    const requestKey = `knowledge.promote:${createHash('sha256').update(JSON.stringify([sittingId, index])).digest('hex')}`;
    try {
      const id = await store.proposeCreate(candidate, proposerId, { agent: proposerId, proposal: 'Create distilled memory candidate' }, { requestKey });
      proposals.push(id);
    } catch (cause) {
      const conflict = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'REQUEST_KEY_CONFLICT';
      throw Object.assign(new Error(conflict ? 'Corpus request key conflict; reconcile the batch' : 'Corpus proposal outcome is unconfirmed; retry only the identical batch', { cause }), { ...(conflict ? { code: 'REQUEST_KEY_CONFLICT' } : {}), completedProposals: proposals, failedCandidateIndex: index });
    }
  }
  return { root: rootName, posture: 'proposed', proposals };
}
