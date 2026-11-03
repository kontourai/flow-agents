/**
 * Budgeted brief compilation (#671, R7).
 *
 * Writes the profile brief file #672 reads: UTF-8 JSON
 * `{"version":1,"entries":[display-ready text, ...]}` at
 * `<dreamDir>/briefs/global.json` (and `project-<id>.json` beside it, same
 * shape). Entries come only from `presentMemoryClaims` (#1571), so every entry
 * says its posture and its review label.
 *
 * Eligibility (the quarantine of unreviewed sources):
 *   - an `applied` proposal (a reviewer other than the proposer applied it in
 *     Corpus) whose record is still active: always;
 *   - a `pending` proposal that routing left `proposed`: only when the host sets
 *     `includeUnreviewed`, and labelled unreviewed;
 *   - a `pending` proposal routing sent to review: never, until review settles it;
 *   - a `rejected` proposal: never.
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
  return String(text)
    .replaceAll(INJECTED_MEMORY_OPEN, "")
    .replaceAll(INJECTED_MEMORY_CLOSE, "")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @typedef {object} BriefItem
 * @property {object} claim
 * @property {string|null} project
 * @property {{passes:number,agreeing:number}|null} agreement
 * @property {"applied"|"pending"} state
 * @property {{outcome: "proposed"|"routed"}} [routing] the routing outcome recorded with the proposal
 */

export function isEligible(item, { includeUnreviewed = false } = {}) {
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

/** Eligible items for a brief, best first. `project` null is the global brief. */
export function rankItems(items, { project = null, now, includeUnreviewed = false } = {}) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("brief now must be an ISO timestamp");
  return items
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
export function writeBriefs({ briefsDir, items, now, globalBudget = DEFAULT_GLOBAL_BUDGET_BYTES, projectBudget = DEFAULT_PROJECT_BUDGET_BYTES, maxEntryBytes, includeUnreviewed = false, reviewDecisions = [], dryRun = false }) {
  const projects = [...new Set(items.filter((item) => isEligible(item, { includeUnreviewed }) && item.project).map((item) => item.project))].sort();
  const specs = [
    { name: "global.json", project: null, budget: globalBudget },
    ...projects.map((project) => ({ name: `project-${project}.json`, project, budget: projectBudget })),
  ];
  const outputs = [];
  const removed = [];
  const compiled = specs.map((spec) => ({
    ...spec,
    brief: compileBrief(rankItems(items, { project: spec.project, now, includeUnreviewed }), { budget: spec.budget, maxEntryBytes, reviewDecisions }),
  }));
  if (dryRun) {
    return Object.assign(compiled.map(({ name, brief }) => ({ name, ...summary(brief), written: false })), { removed });
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
  return Object.assign(outputs, { removed });
}

function summary(brief) {
  return { entries: brief.entries.length, claim_ids: brief.claimIds, bytes: brief.bytes, budget: brief.budget, digest: brief.digest };
}
