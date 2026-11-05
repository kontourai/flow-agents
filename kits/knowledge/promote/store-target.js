/**
 * Proposal-only bridge to the host-composed Corpus store (corpus#40).
 * The host authorizes and registers the root and supplies the store; this
 * module neither discovers roots nor owns record transactions.
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { validate } from "../providers/lib/schema-validate.js";
import { createHash } from "node:crypto";

const RESIDUE_SCHEMA = JSON.parse(readFileSync(new URL("../schemas/knowledge/residue.schema.json", import.meta.url), "utf8"));

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
 * @param {{residue: {source: string, complete: boolean, sittingId: string, contentHash: string, provenance: {harness: string, sessionId: string, transcriptRef: string}}, candidates: {title: string, body: string, category: string}[], proposerId: string,
 *   store: CreateProposalStore, registerRoot: (name: string, root: string) => unknown, root: string,
 *   rootName: string, write?: boolean, requestScope?: string, positions?: number[]}} options
 */
export async function proposeMemory({ residue, candidates, proposerId, store, registerRoot, root, rootName, write = true, requestScope, positions }) {
  if (!validate(residue, RESIDUE_SCHEMA).valid || !['runtime-session', 'tool-event'].includes(residue?.source) || residue.complete !== true) {
    throw new Error('store target requires a schema-valid complete runtime-session or tool-event residue');
  }
  const isTool = residue.source === 'tool-event';
  const sessionId = required(isTool ? residue.provenance?.session : residue.provenance?.sessionId, 'sessionId');
  const transcriptRef = required(isTool ? residue.provenance?.sourceId : residue.provenance?.transcriptRef, 'transcriptRef');
  const sittingId = required(residue.sittingId, 'sittingId');
  if (isTool ? sittingId !== `tool-event:${residue.provenance.eventId}` : !sittingId.startsWith(`${residue.provenance.harness}:${sessionId}:`)) {
    throw new Error('store target requires a sitting identity consistent with its provenance');
  }
  required(proposerId, 'proposerId');
  required(rootName, 'rootName');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('store target requires a host-authorized absolute root');
  if (!Array.isArray(candidates)) throw new Error('store target requires distilled candidates');
  if (typeof write !== 'boolean') throw new Error('store target requires boolean write');
  if (requestScope !== undefined && (typeof requestScope !== 'string' || !requestScope.trim())) throw new Error('store target requires a non-empty requestScope when given');
  // `positions` names where each candidate sits in the caller's whole batch, for a caller that sends only part of it: the key
  // follows the candidate's place in the whole, not in the part. Absent, a candidate's place is its index here, as before.
  if (positions !== undefined && (!Array.isArray(positions) || positions.length !== candidates.length || Array.from(positions).some((p) => !Number.isSafeInteger(p) || p < 0) || new Set(positions).size !== positions.length)) {
    throw new Error('store target requires positions to be distinct non-negative integers, one per candidate');
  }
  if (!store || typeof store.proposeCreate !== 'function') throw new Error('store target requires a Corpus create-proposal store');
  if (typeof registerRoot !== 'function') throw new Error('store target requires host root registration');
  const provenance = isTool ? { source_id: transcriptRef, event_id: residue.provenance.eventId, ordinal: residue.provenance.ordinal, timestamp: residue.provenance.timestamp, session_id: sessionId, tool: residue.provenance.tool, sitting_id: sittingId, content_hash: residue.contentHash } : { session_id: sessionId, transcript_ref: transcriptRef, sitting_id: sittingId, content_hash: residue.contentHash };
  /** @type {import('@kontourai/corpus-store').CreateInput[]} */
  const prepared = candidates.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['title', 'body', 'category'].includes(key))) {
      throw new Error('store target candidate has unsupported fields');
    }
    return {
      type: 'raw',
      title: required(item?.title, 'candidate title'),
      body: required(item?.body, 'candidate body'),
      category: required(item?.category, 'candidate category'),
      provenance: { agent: proposerId, session_id: sessionId, note: JSON.stringify(provenance) },
    };
  });
  if (!write) return { root: rootName, posture: 'preview', proposals: [], candidates: prepared };
  if (prepared.length === 0) return { root: rootName, posture: 'noop', proposals: [] };
  await registerRoot(rootName, root);
  const proposals = [];
  for (const [index, candidate] of prepared.entries()) {
    // Identity excludes candidate content and mutable provenance: changes at the same position
    // must conflict, not mint a new proposal. Corpus owns durable deduplication.
    const requestKey = `knowledge.promote:${createHash('sha256').update(JSON.stringify(requestScope === undefined ? [sittingId, positions?.[index] ?? index] : [sittingId, positions?.[index] ?? index, requestScope])).digest('hex')}`;
    try {
      const id = await store.proposeCreate(candidate, proposerId, { agent: proposerId, proposal: 'Create distilled memory candidate' }, { requestKey });
      proposals.push(id);
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      const conflict = code === 'REQUEST_KEY_CONFLICT';
      const refused = code === 'MISSING_EVIDENCE';
      const message = conflict ? 'Corpus request key conflict; reconcile the batch' : refused ? 'Corpus refused the candidate; reconcile the batch before retrying' : 'Corpus proposal outcome is unconfirmed; retry only the identical batch';
      throw Object.assign(new Error(message, { cause }), { ...(conflict || refused ? { code } : {}), completedProposals: proposals, failedCandidateIndex: index, requestKey });
    }
  }
  return { root: rootName, posture: 'proposed', review_state: 'not_observed', proposals };
}
