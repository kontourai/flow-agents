/**
 * Living Context manifest producer for distilled memory claims (the `MemoryClaim` of docs/memory-claims.md).
 *
 * A memory claim is a structured, grounded assertion with a posture and, possibly, a human review. Recall's manifest wants
 * a statement, an authority document at a pinned revision, a knowledge time, a validity interval, a visibility and a slot.
 * Most of that a memory claim already carries; this module maps it and makes the remaining decisions explicit. It is a
 * separate module because it needs the built memory-claims package (`@kontourai/flow-agents/memory-claims`), which the rest
 * of Living Context does not.
 *
 * The mapping:
 *
 *   claim                `presentMemoryClaims(...).text` verbatim, so posture and review label are in the text. This is the
 *                        one way the Kit puts a memory claim in front of a reader. Claims it withholds (invalid, no posture,
 *                        rejected in review) are excluded with that reason, never presented bare.
 *   status               `stated` is `current`. `proposed`, `hypothetical` and `retracted` are not facts in effect:
 *                        `unverifiable` (recall: `declared_unverifiable`). One successor makes the predecessor `superseded`;
 *                        several make it `unverifiable`.
 *   authority            host-supplied (`authorityFor`): the repository file at the pinned revision that grounds the claim
 *                        (for example the stored sitting). None, no manifest claim: `no_authority`.
 *   recorded_at          host-supplied (`recordedAtFor`), the receiver-recorded instant. `source.observedAt` is when the turn
 *                        happened, not when the store learned of it, so it is never used. None: omitted, and recall says
 *                        `knowledge_time_unknown`.
 *   valid_time           the claim's own half-open interval.
 *   slot, supersession   `memorySlotKey` (Surface's canonical key plus claim type); edges come from `supersedes` and are
 *                        recorded when the successor was.
 *   visibility           the claim's own, in Surface's declared form. Absent or unreadable is omitted, which is sealed.
 *   review               `proposed`, unless the review label is `confirmed` or `corrected` and the host names the reviewer
 *                        (`reviewerFor`): a review without a named reviewer is not a review.
 *
 * @module living-context-memory
 */

import { assertMemoryClaim, memoryInstant, memorySlotKey, readMemoryVisibility } from "@kontourai/flow-agents/memory-claims";
import { presentMemoryClaims } from "@kontourai/flow-agents/memory-routing";
import { error, isIdentity, safeRelativePath } from "./index.js";
import { MAX_CLAIM_CHARS } from "./living-context-store.js";

const manifestIdOf = (claimId) => `mem-${claimId.replace(/^sha256:/, "").replace(/[^A-Za-z0-9._-]/g, "-")}`;
const iso = (text) => { const ms = memoryInstant(text); return ms === undefined ? undefined : new Date(ms).toISOString(); };
const instant = (text) => (typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) && Number.isFinite(Date.parse(text)) ? text : undefined);

/**
 * @param {object} options
 * @param {object[]} options.claims                      MemoryClaims
 * @param {(claim: object) => ({path: string, citation: string}|undefined)} options.authorityFor
 * @param {(claim: object) => (string|undefined)} [options.recordedAtFor]    UTC instant the store recorded the claim
 * @param {(claimId: string) => (string|undefined)} [options.reviewerFor]    identity of the human who confirmed or corrected it
 * @param {object[]} [options.routing] @param {object[]} [options.reviewDecisions]   as for `presentMemoryClaims`
 * @param {string[]} [options.readers]                   identities to admit in addition to the claims' own audiences
 * @param {string} [options.owner]
 */
export function deriveMemoryManifest({ claims, authorityFor, recordedAtFor, reviewerFor, routing, reviewDecisions, readers = [], owner = "memory" } = {}) {
  if (!Array.isArray(claims)) throw error("INVALID_MEMORY_CLAIMS", "claims must be an array of memory claims");
  if (typeof authorityFor !== "function") throw error("AUTHORITY_REQUIRED", "deriveMemoryManifest needs authorityFor(claim): the repository file at the pinned revision that grounds each claim");
  const { presented, withheld } = presentMemoryClaims(claims, { routing, reviewDecisions });
  const excluded = withheld.map((entry) => ({ claim_id: entry.id, reason: `withheld:${entry.reason}` }));
  const presentedBy = new Map(presented.map((entry) => [entry.id, entry]));
  const usable = [];
  for (const claim of claims) {
    const shown = presentedBy.get(claim?.id);
    if (!shown) continue;
    assertMemoryClaim(claim);
    if (shown.text.length > MAX_CLAIM_CHARS) { excluded.push({ claim_id: claim.id, reason: "claim_too_long" }); continue; }
    const authority = authorityFor(claim);
    let path;
    try { path = safeRelativePath(authority?.path, "authority.path"); } catch { excluded.push({ claim_id: claim.id, reason: "no_authority" }); continue; }
    if (!isIdentity(authority.citation)) { excluded.push({ claim_id: claim.id, reason: "no_authority" }); continue; }
    usable.push({ claim, shown, authority: { path, citation: authority.citation } });
  }
  const ids = new Set(usable.map(({ claim }) => claim.id));
  const successors = new Map();
  for (const { claim } of usable) {
    for (const edge of claim.supersedes ?? []) {
      if (edge.claimId === claim.id || !ids.has(edge.claimId)) continue;
      successors.set(edge.claimId, [...(successors.get(edge.claimId) ?? []), { id: claim.id, kind: edge.kind }]);
    }
  }
  const byId = new Map(usable.map((entry) => [entry.claim.id, entry]));
  const audiences = new Set(readers);
  const out = [];
  const records = [];
  for (const { claim, shown, authority } of usable) {
    const visibility = readMemoryVisibility(claim.visibility);
    if (visibility?.kind === "restricted") for (const audience of visibility.audiences) audiences.add(audience);
    const next = successors.get(claim.id) ?? [];
    const recordedAt = instant(recordedAtFor?.(claim));
    const successorRecordedAt = next.length === 1 ? instant(recordedAtFor?.(byId.get(next[0].id).claim)) : undefined;
    const from = iso(claim.validTime?.from), until = iso(claim.validTime?.until);
    const reviewer = (shown.review.label === "confirmed" || shown.review.label === "corrected") ? reviewerFor?.(claim.id) : undefined;
    const status = next.length === 1 ? "superseded" : claim.posture === "stated" && next.length === 0 ? "current" : "unverifiable";
    out.push({
      id: manifestIdOf(claim.id),
      claim: shown.text,
      status,
      ...(next.length === 1 ? { superseded_by: manifestIdOf(next[0].id), supersession_kind: next[0].kind, ...(successorRecordedAt ? { supersession_recorded_at: successorRecordedAt } : {}) } : {}),
      authority,
      owning_source: { owner, path: authority.path },
      affected_surfaces: [authority.path],
      ...(visibility ? { visibility: visibility.kind === "public" ? "public" : { audiences: [...visibility.audiences] } } : {}),
      ...(recordedAt ? { recorded_at: recordedAt } : {}),
      ...(from || until ? { valid_time: { ...(from ? { from } : {}), ...(until ? { until } : {}) } } : {}),
      slot: memorySlotKey(claim),
      review: isIdentity(reviewer) ? { posture: "reviewed", reviewer } : { posture: "proposed" },
    });
    records.push({
      claim_id: manifestIdOf(claim.id), path: authority.path, title: shown.text, type: "memory-claim", category: "memory.claim", tags: [claim.property],
      record_status: claim.posture, mapping: `posture:${claim.posture}`, created_at: recordedAt, updated_at: recordedAt, body: claim.source.excerpt,
    });
  }
  return { manifest: { readers: [...audiences], claims: out }, records, excluded, stats: { claims: out.length, excluded: excluded.length } };
}
