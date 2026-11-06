/**
 * The body of an entity proposal in a Corpus create proposal (kontourai/flow-agents#1618).
 *
 * A memory root holds distilled claims (`memory.claim`, see ./envelope.js). Whether two subjects in it are the same thing, or one
 * should be split, is a different kind of change: a person has to decide it. This module is only the wire shape that lets such a
 * proposal sit in the root beside the claims and be read back; it detects nothing, applies nothing, and decides nothing.
 *
 * The body is one JSON envelope, `{ version, proposal }`, where `proposal` is Survey's `EntityProposal` exactly as
 * `createEntityProposal` returned it. There is no Kit copy of Survey's fields, so a host builds its review item with Survey's
 * `entityProposalToReviewItem` from what it read, and records the outcome with Survey's `entityOutcomeFromDecision`.
 *
 * Integrity is Survey's own: a proposal is accepted only when rebuilding it from its `spec` gives back the same bytes, so a body
 * edited after it was written, or one that is not in Survey's normal form, is refused. That is the same guarantee the claim id
 * gives a claim. No second hash scheme is added.
 *
 * Every bound refuses at `max + 1` and says so; nothing is truncated, because a cut proposal would put different evidence in
 * front of the reviewer than the producer meant.
 *
 * @module dream/entity-envelope
 */

import { canonicalJson } from "@kontourai/relay";
import { createEntityProposal } from "@kontourai/survey";

import { dreamError } from "./util.js";

export const ENTITY_ENVELOPE_VERSION = "1.0";
/** The Corpus proposal category an entity proposal travels under, beside `memory.claim`. */
export const ENTITY_PROPOSAL_CATEGORY = "memory.entity-proposal";
/** The most alternatives (candidate relationships) one proposal may carry. */
export const MAX_ENTITY_ALTERNATIVES = 8;
/** The most pieces of evidence one alternative may carry. */
export const MAX_ENTITY_EVIDENCE = 16;
/** The most bytes one evidence excerpt may weigh. */
export const MAX_ENTITY_EXCERPT_BYTES = 4 * 1024;
/**
 * What a stored entity envelope may weigh before it is refused unread. The most an honest proposal can reach is
 * 8 alternatives x 16 pieces of evidence x (a 4 KiB excerpt and about 1 KiB of other fields), roughly 0.65 MiB, so 1 MiB cannot be
 * reached by honest input and is far below Corpus's own limit.
 */
export const MAX_ENTITY_ENVELOPE_BYTES = 1024 * 1024;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why a proposal is over a bound, or null when it is within all of them. */
function boundViolation(proposal) {
  const alternatives = proposal?.spec?.alternatives;
  if (!Array.isArray(alternatives)) return "an entity proposal needs alternatives";
  if (alternatives.length > MAX_ENTITY_ALTERNATIVES) return `an entity proposal carries at most ${MAX_ENTITY_ALTERNATIVES} alternatives`;
  for (const alternative of alternatives) {
    const evidence = alternative?.evidence;
    if (!Array.isArray(evidence)) return "an entity alternative needs evidence";
    if (evidence.length > MAX_ENTITY_EVIDENCE) return `an entity alternative carries at most ${MAX_ENTITY_EVIDENCE} pieces of evidence`;
    for (const item of evidence) {
      if (typeof item?.excerpt === "string" && Buffer.byteLength(item.excerpt) > MAX_ENTITY_EXCERPT_BYTES) return `an evidence excerpt is at most ${MAX_ENTITY_EXCERPT_BYTES} bytes`;
    }
  }
  return null;
}

/** Whether `proposal` is exactly what Survey's `createEntityProposal` returns for its own spec. */
function isSurveyProposal(proposal) {
  if (!isPlainObject(proposal) || !isPlainObject(proposal.spec) || typeof proposal.id !== "string") return false;
  try {
    return canonicalJson(createEntityProposal(proposal.spec)) === canonicalJson(proposal);
  } catch {
    return false;
  }
}

/**
 * The body for a Corpus create proposal. Throws, naming the reason, when `proposal` is not exactly what Survey's
 * `createEntityProposal` returned or is over a bound.
 */
export function encodeEntityEnvelope(proposal) {
  if (!isSurveyProposal(proposal)) throw dreamError("DREAM_ENTITY_PROPOSAL_INVALID", "an entity envelope carries a proposal exactly as Survey's createEntityProposal returned it");
  const violation = boundViolation(proposal);
  if (violation) throw dreamError("DREAM_ENTITY_PROPOSAL_TOO_LARGE", violation);
  const body = canonicalJson({ version: ENTITY_ENVELOPE_VERSION, proposal });
  if (Buffer.byteLength(body) > MAX_ENTITY_ENVELOPE_BYTES) throw dreamError("DREAM_ENTITY_PROPOSAL_TOO_LARGE", "an entity proposal exceeds the envelope size bound");
  return body;
}

/**
 * The envelope in a proposal body, or null when the body is not one this module wrote or does not verify. Never throws, and
 * parses nothing over the size bound.
 */
export function decodeEntityEnvelope(body) {
  try {
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_ENTITY_ENVELOPE_BYTES) return null;
    const value = JSON.parse(body);
    if (!isPlainObject(value) || value.version !== ENTITY_ENVELOPE_VERSION) return null;
    if (Object.keys(value).sort().join() !== "proposal,version") return null;
    if (!isSurveyProposal(value.proposal) || boundViolation(value.proposal)) return null;
    return value;
  } catch {
    return null;
  }
}

/** The Corpus create key for a proposal: derived from the proposal id alone, so writing the same proposal again is a no-op. */
export function entityProposalKey(proposal) {
  if (!isSurveyProposal(proposal)) throw dreamError("DREAM_ENTITY_PROPOSAL_INVALID", "an entity proposal key needs a proposal exactly as Survey returned it");
  return `${ENTITY_PROPOSAL_CATEGORY}:${proposal.id}`;
}

/** A short title for the Corpus proposal: the operation and the two subjects of the first alternative. */
export function entityProposalTitle(proposal) {
  if (!isSurveyProposal(proposal)) throw dreamError("DREAM_ENTITY_PROPOSAL_INVALID", "an entity proposal title needs a proposal exactly as Survey returned it");
  const [first] = proposal.spec.alternatives;
  const [a, b] = first.subjects;
  const more = proposal.spec.alternatives.length > 1 ? ` (+${proposal.spec.alternatives.length - 1})` : "";
  return `${first.operation}: ${a.subjectId} / ${b.subjectId}${more}`.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * The entity proposals among a store's Corpus proposals, verified, keyed by proposal id. A proposal under this category that does
 * not verify is counted in `unreadable` and never returned: a host that cannot read it must not show it.
 *
 * @param {object[]} proposals Corpus `KitCreateProposal`s
 */
export function indexEntityProposals(proposals) {
  const byId = new Map();
  let unreadable = 0;
  for (const proposal of proposals) {
    if (proposal?.candidate?.category !== ENTITY_PROPOSAL_CATEGORY) continue;
    const envelope = decodeEntityEnvelope(proposal.candidate.body);
    if (!envelope) {
      unreadable += 1;
      continue;
    }
    byId.set(envelope.proposal.id, { proposal, envelope });
  }
  return { byId, unreadable };
}
