/**
 * Proposal-only bridge to the host-composed Corpus store (corpus#40).
 * The host authorizes and registers the root and supplies the store; this
 * module neither discovers roots nor owns record transactions.
 */

import path from "node:path";

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
  for (const candidate of prepared) {
    try {
      const id = await store.proposeCreate(candidate, proposerId, { agent: proposerId, proposal: 'Create distilled memory candidate' });
      proposals.push(id);
    } catch (cause) {
      throw Object.assign(new Error('Corpus proposal outcome is unconfirmed; do not retry without reconciliation', { cause }), { completedProposals: proposals, failedCandidateIndex: proposals.length });
    }
  }
  return { root: rootName, posture: 'proposed', proposals };
}
