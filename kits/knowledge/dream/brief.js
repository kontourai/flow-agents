/**
 * Budgeted brief compilation (#671, R7).
 *
 * Writes the profile brief file #672 reads: UTF-8 JSON
 * `{"version":1,"entries":[display-ready text, ...]}` at
 * `<dreamDir>/briefs/global.json` (and `project-<id>.json` beside it, same
 * shape). Entries come only from `presentMemoryClaims` (#1571), so every entry
 * says its posture and its review label.
 *
 * Eligibility (the quarantine of unreviewed sources), after one rule that comes
 * first: a claim whose visibility is sealed (absent, or restricted to no
 * audience) is never in a brief, because the claim contract (#1571) reads
 * "sealed" as visible to no one and a brief is injected into sessions.
 *   - an `applied` proposal (a reviewer other than the proposer applied it in
 *     Corpus) whose record is still active: always;
 *   - a `pending` proposal that routing left `proposed`: only when the host sets
 *     `includeUnreviewed`, and labelled unreviewed;
 *   - a `pending` proposal routing sent to review: never, until review settles it;
 *   - a `rejected` proposal: never.
 *
 * Only CURRENT, UNCONTESTED claims are ranked (see `classifyCurrent`). A claim
 * that a rival in its slot contradicts waits in the review queue, not the brief;
 * a claim another claim replaced, and a claim that asserts nothing about the
 * present (a hypothetical or a retraction), is not current.
 *
 * Rank = confidence x recency x scope-match. Confidence starts from agreement,
 * the share of extraction passes that found the claim: an applied claim scores
 * `0.55 + 0.45 x agreement` (0.55 to 1) and a pending one `0.5 x agreement`
 * (0 to 0.5). With equal recency and scope, review always outranks extraction
 * agreement, and agreement orders the claims within each group. Recency is
 * `1 / (1 + age/30d)`, which halves a claim's weight at 30 days. Scope is 1 for a
 * claim from the brief's own project, 0.75 for a claim with no project, and the
 * project brief drops other projects' claims. Ties break on newer observation,
 * then claim id, so the order is deterministic.
 *
 * Budget: a brief's size is the UTF-8 byte length of its entries joined by a
 * blank line, the way #672 joins them. Bytes are a hard upper bound on tokens.
 *
 * @module dream/brief
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { INJECTED_MEMORY_CLOSE, INJECTED_MEMORY_OPEN } from "../memory-marker.js";
import { foldMemoryText, memoryInstant, memorySlotKey } from "@kontourai/flow-agents/memory-claims";
import { canonicalJson } from "@kontourai/relay";

import { presentMemoryClaims } from "../adapters/memory-claims/index.mjs";
import { truncateUtf8, writePrivateAtomic } from "./util.js";

export const BRIEF_VERSION = 1;
export const DEFAULT_GLOBAL_BUDGET_BYTES = 6144;
export const DEFAULT_PROJECT_BUDGET_BYTES = 2048;
export const DEFAULT_MAX_ENTRY_BYTES = 512;
const MIN_TRUNCATED_BYTES = 24;
const SEPARATOR = "\n\n";
const DAY_MS = 86_400_000;
// #672's reader rejects the whole file if any entry has one of these.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

export const joinedBytes = (entries) => Buffer.byteLength(entries.join(SEPARATOR));

function sanitize(text) {
  // Removing one thing can join the pieces around it into another (a closing marker inside an opening marker), so
  // repeat until nothing changes. The reader refuses the whole file if one entry still has a marker.
  let value = String(text);
  for (let pass = 0; pass < 16; pass += 1) {
    const next = value.replaceAll(INJECTED_MEMORY_OPEN, "").replaceAll(INJECTED_MEMORY_CLOSE, "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
    if (next === value) return value;
    value = next;
  }
  return value.includes("flow-agents-injected-memory") ? "" : value; // a pathological nesting: drop the entry rather than ship a marker
}

/**
 * @typedef {object} BriefItem
 * @property {object} claim
 * @property {string|null} project
 * @property {{passes:number,agreeing:number}|null} agreement
 * @property {"applied"|"pending"} state
 * @property {{outcome: "proposed"|"routed"}} [routing] the routing outcome recorded with the proposal
 */

/** Sealed is the narrowest visibility: absent, or restricted to no audience. Mirrors the claim contract's reading. */
export function isSealed(claim) {
  const visibility = claim.visibility;
  if (!visibility) return true;
  if (visibility.kind === "public") return false;
  return visibility.kind !== "restricted" || !Array.isArray(visibility.audiences) || visibility.audiences.length === 0;
}

const multiValued = (policy, property) => {
  const folded = foldMemoryText(String(property));
  return (policy?.multiValued ?? []).some((name) => name === "*" || foldMemoryText(String(name)) === folded);
};

/** `[from, until)` as numbers, or null when the interval cannot be read: an unreadable interval cannot clear a conflict. */
function bounds(validTime) {
  const from = validTime?.from === undefined ? -Infinity : memoryInstant(validTime.from);
  const until = validTime?.until === undefined ? Infinity : memoryInstant(validTime.until);
  return from === undefined || until === undefined || from >= until ? null : { from, until };
}
const overlap = (x, y) => x === null || y === null || (x.from < y.until && y.from < x.until);

/**
 * Which claims are current and uncontested, by the slot rules #1571's routing uses
 * (`conflicting-current-values`): a stated claim is *contested* when another stated
 * claim in the same slot (Surface's canonical claim key plus claim type) holds a
 * different value over an overlapping valid time and neither replaces the other.
 *
 * A claim is *replaced* by an edge from a REVIEWED (applied) claim in its own slot, and only with authority
 * the Kit can see: a `succession` edge from a stated claim by the same speaker, or a
 * `correction` edge from a retracted claim by the same speaker that holds the same value
 * (the speaker withdrawing their own assertion). Another speaker's edge replaces nothing
 * (it needs an authority decision); neither does an edge into another slot. An edge from an
 * unreviewed claim replaces nothing yet: as in Surface, an unreviewed succession leaves both
 * candidates contested until a reviewer verifies the successor, and both wait in the review queue.
 * A hypothetical or retracted claim asserts nothing about the present and is not current.
 * Properties the policy lists as `multiValued` cannot be contested. A contested claim is
 * contested however it got there: a pending rival contests an applied claim until review
 * settles it, because neither is known to be the current value.
 *
 * Values are read as the reviewer left them: pass items whose `claim.value` is the value a
 * Survey correction presents (see `effectiveItems`), so a corrected claim contests as what it now says.
 *
 * TEMPORARY: Surface's accumulation projection (kontourai/surface#359, published in 6.3.0) owns
 * "which claims are current", and it needs host-supplied custody and admission decisions this
 * run does not have.
 * This applies the same slot rules locally. Replace it with the projection:
 * kontourai/flow-agents#1584.
 *
 * Cost: values and intervals are read once per claim, and a slot with a single distinct
 * value is settled without comparing claims.
 *
 * @param {BriefItem[]} items non-rejected claims, any state
 * @param {{ multiValued?: string[] }} [policy]
 * @returns {{ current: BriefItem[], contested: BriefItem[], superseded: BriefItem[], notCurrent: BriefItem[] }}
 */
export function classifyCurrent(items, policy = {}) {
  const info = new Map(items.map((item) => [item, { slot: memorySlotKey(item.claim), value: canonicalJson(item.claim.value), span: bounds(item.claim.validTime) }]));
  const byId = new Map(items.map((item) => [item.claim.id, item]));
  const replaced = new Set();
  for (const item of items) {
    for (const edge of item.claim.supersedes ?? []) {
      const target = byId.get(edge.claimId);
      if (!target || info.get(target).slot !== info.get(item).slot || item.claim.speaker !== target.claim.speaker) continue;
      const succession = item.claim.posture === "stated" && edge.kind === "succession";
      const withdrawal = item.claim.posture === "retracted" && edge.kind === "correction" && info.get(target).value === info.get(item).value;
      if (!succession && !withdrawal) continue;
      // Only a reviewed claim replaces one. Until the successor is verified Surface keeps both candidates, so an
      // unreviewed succession is a contest like any other, and both wait for the reviewer.
      if (item.state === "applied") replaced.add(target.claim.id);
    }
  }
  const stated = items.filter((item) => item.claim.posture === "stated" && !replaced.has(item.claim.id));
  const slots = new Map();
  for (const item of stated) slots.set(info.get(item).slot, [...(slots.get(info.get(item).slot) ?? []), item]);
  const contested = new Set();
  for (const group of slots.values()) {
    if (multiValued(policy, group[0].claim.property)) continue;
    if (new Set(group.map((item) => info.get(item).value)).size < 2) continue; // restatements agree
    for (const a of group) {
      const rival = group.some((b) => info.get(b).value !== info.get(a).value && overlap(info.get(a).span, info.get(b).span));
      if (rival) contested.add(a.claim.id);
    }
  }
  const out = { current: [], contested: [], superseded: [], notCurrent: [] };
  for (const item of items) {
    if (replaced.has(item.claim.id)) out.superseded.push(item);
    else if (item.claim.posture === "hypothetical" || item.claim.posture === "retracted") out.notCurrent.push(item);
    else if (contested.has(item.claim.id)) out.contested.push(item);
    else out.current.push(item);
  }
  return out;
}

/**
 * The items as the reviewer left them: a claim rejected in review is dropped (it contests nothing), and a corrected
 * claim carries the value Survey presents, so a correction that makes two claims disagree is seen as a contest.
 * The returned items are views for classification only; ranking and presenting use the originals.
 */
export function effectiveItems(items, reviewDecisions = []) {
  if (reviewDecisions.length === 0) return { views: items, byView: new Map(items.map((item) => [item, item])) };
  const { presented } = presentMemoryClaims(items.map((item) => item.claim), { reviewDecisions });
  const shown = new Map(presented.map((entry) => [entry.id, entry]));
  const views = [];
  const byView = new Map();
  for (const item of items) {
    const entry = shown.get(item.claim.id);
    if (!entry) continue; // withheld: rejected in review or invalid
    const view = entry.value === item.claim.value ? item : { ...item, claim: { ...item.claim, value: entry.value } };
    views.push(view);
    byView.set(view, item);
  }
  return { views, byView };
}

export function isEligible(item, { includeUnreviewed = false } = {}) {
  if (isSealed(item.claim)) return false;
  if (item.state === "applied") return true;
  return item.state === "pending" && includeUnreviewed && item.routing?.outcome === "proposed";
}

export function confidenceOf(item) {
  const agreement = item.agreement && item.agreement.passes > 0 ? Math.min(1, item.agreement.agreeing / item.agreement.passes) : 0;
  return item.state === "applied" ? 0.55 + 0.45 * agreement : 0.5 * agreement;
}

function scopeMatch(item, project) {
  if (project === null) return item.project ? 0.75 : 1;
  if (item.project === project) return 1;
  return item.project ? 0 : 0.75;
}

/** The original items that are current and uncontested once review's corrections and rejections are applied. */
function currentOriginals(items, policy, reviewDecisions) {
  const { views, byView } = effectiveItems(items, reviewDecisions);
  return classifyCurrent(views, policy).current.map((view) => byView.get(view));
}

/**
 * Eligible items for a brief, best first. `project` null is the global brief. Only current, uncontested claims are
 * ranked (see `classifyCurrent`); a caller that already classified passes `current` to skip the work.
 */
export function rankItems(items, { project = null, now, includeUnreviewed = false, policy, current, reviewDecisions = [] } = {}) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("brief now must be an ISO timestamp");
  return (current ?? currentOriginals(items, policy, reviewDecisions))
    .filter((item) => isEligible(item, { includeUnreviewed }))
    .map((item) => {
      const observed = Date.parse(item.claim.source.observedAt);
      const ageDays = Math.max(0, (at - (Number.isFinite(observed) ? observed : 0)) / DAY_MS);
      const score = confidenceOf(item) * (1 / (1 + ageDays / 30)) * scopeMatch(item, project);
      return { item, score: Number(score.toFixed(12)), observed: Number.isFinite(observed) ? observed : 0 };
    })
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score || b.observed - a.observed || (a.item.claim.id < b.item.claim.id ? -1 : 1))
    .map((ranked) => ranked.item);
}

/**
 * @param {BriefItem[]} items already ranked
 * @param {{ budget: number, maxEntryBytes?: number, reviewDecisions?: object[] }} options
 */
export function compileBrief(items, { budget, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, reviewDecisions = [] }) {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("brief budget must be a positive integer");
  const { presented, withheld } = presentMemoryClaims(items.map((item) => item.claim), { reviewDecisions });
  const presentedById = new Map(presented.map((entry) => [entry.id, entry]));
  const entries = [];
  const claimIds = [];
  for (const item of items) {
    const shown = presentedById.get(item.claim.id);
    if (shown === undefined) continue; // withheld by presentMemoryClaims (rejected in review, invalid)
    // The label is presentMemoryClaims's: it reads Survey review decisions, so a host that applies a claim
    // in Corpus without a Survey decision sees it labelled unreviewed here. That understates, never overstates.
    const raw = shown.text;
    let text = truncateUtf8(sanitize(raw), maxEntryBytes);
    if (!text) continue;
    const room = budget - (entries.length ? joinedBytes(entries) + SEPARATOR.length : 0);
    if (Buffer.byteLength(text) > room) {
      if (room < MIN_TRUNCATED_BYTES) break;
      text = truncateUtf8(text, room);
      entries.push(text);
      claimIds.push(item.claim.id);
      break;
    }
    entries.push(text);
    claimIds.push(item.claim.id);
  }
  const content = `${JSON.stringify({ version: BRIEF_VERSION, entries })}\n`;
  return {
    entries,
    claimIds,
    withheld,
    budget,
    bytes: joinedBytes(entries),
    content,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

const PROJECT_FILE = /^project-([a-z0-9_-]{1,64})\.json$/;

/**
 * Compile and write the global brief and one brief per project that has an
 * eligible claim. A project brief for a project with none is removed, so stale
 * memory never outlives the claim behind it.
 */
export function writeBriefs({ briefsDir, items, now, globalBudget = DEFAULT_GLOBAL_BUDGET_BYTES, projectBudget = DEFAULT_PROJECT_BUDGET_BYTES, maxEntryBytes, includeUnreviewed = false, reviewDecisions = [], dryRun = false, policy }) {
  const { views, byView } = effectiveItems(items, reviewDecisions);
  const raw = classifyCurrent(views, policy);
  const classified = { current: raw.current.map((view) => byView.get(view)), contested: raw.contested.map((view) => byView.get(view)), superseded: raw.superseded.map((view) => byView.get(view)), notCurrent: raw.notCurrent.map((view) => byView.get(view)) };
  const all = items;
  const projects = [...new Set(classified.current.filter((item) => isEligible(item, { includeUnreviewed }) && item.project).map((item) => item.project))].sort();
  const specs = [
    { name: "global.json", project: null, budget: globalBudget },
    ...projects.map((project) => ({ name: `project-${project}.json`, project, budget: projectBudget })),
  ];
  const outputs = [];
  const removed = [];
  const compiled = specs.map((spec) => ({
    ...spec,
    brief: compileBrief(rankItems(all, { project: spec.project, now, includeUnreviewed, current: classified.current }), { budget: spec.budget, maxEntryBytes, reviewDecisions }),
  }));
  const excluded = { contested: classified.contested.length, superseded: classified.superseded.length, not_current: classified.notCurrent.length, considered: all.length };
  if (dryRun) {
    return Object.assign(compiled.map(({ name, brief }) => ({ name, ...summary(brief), written: false })), { removed, excluded });
  }
  try {
    fs.mkdirSync(briefsDir, { recursive: true, mode: 0o700 });
    const expected = new Set(specs.map((spec) => spec.name));
    for (const name of fs.readdirSync(briefsDir).sort()) {
      if (!PROJECT_FILE.test(name) || expected.has(name)) continue;
      fs.rmSync(path.join(briefsDir, name), { force: true });
      removed.push(name);
    }
    for (const { name, brief } of compiled) {
      const written = writePrivateAtomic(path.join(briefsDir, name), brief.content);
      outputs.push({ name, ...summary(brief), written });
    }
  } catch (error) {
    error.briefs = [...outputs];
    error.removed = [...removed];
    throw error;
  }
  return Object.assign(outputs, { removed, excluded });
}

function summary(brief) {
  return { entries: brief.entries.length, claim_ids: brief.claimIds, bytes: brief.bytes, budget: brief.budget, digest: brief.digest };
}
