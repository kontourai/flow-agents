/**
 * Knowledge Kit — Flow Runner
 *
 * Executable flow logic that implements the knowledge.ingest, knowledge.compile,
 * and knowledge.synthesize flows against a KnowledgeStoreAdapter. This is the
 * callable entry point for S5's live agent tools.
 *
 * Zero runtime dependencies beyond Node.js built-ins.
 *
 * Exports:
 *   - KnowledgeFlowRunner  (class)
 *   - capture(rawText, meta, options)   — ingest flow: capture → classify → store as raw
 *   - compile(rawIds[], options)        — compile flow: select → compile → link with provenance
 *   - synthesize(conceptId | topicSelector, options) — synthesize flow:
 *       detect-cluster → propose → evidence-gate → apply-or-reject
 *   - retire(recordId, options)          — retire flow: identify → propose → evidence-gate → apply-or-reject
 *   - defaultSimilarityDetector         — pluggable similarity interface default (R3)
 *
 * Telemetry:
 *   Gate events are emitted to <workspace>/.kontourai/telemetry/full.jsonl using
 *   canonical schema v0.3.0 events (preToolUse at gate entry, postToolUse at gate exit).
 *
 * Similarity Interface (R3):
 *   A SimilarityDetector is a function with the signature:
 *     async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
 *   It receives the target concept, all compiled candidates, and the store for link lookups.
 *   It returns an array of record IDs deemed similar (the cluster).
 *   The default implementation (defaultSimilarityDetector) uses:
 *     - category match: candidate.category === concept.category (or prefix match)
 *     - link-overlap heuristic: |shared target_ids| / |union target_ids| >= threshold
 *
 * @module adapters/flow-runner
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeTelemetry } from "./telemetry.js";
import {
  defaultEntityExtractor,
  normalizeName,
  isExactMatch,
  isPossibleDuplicate,
} from "./entity-extractor.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function missingEvidenceError(message) {
  const err = new Error(message);
  err.code = "MISSING_EVIDENCE";
  return err;
}

// ---------------------------------------------------------------------------
// Freshness-audit helpers  (knowledge.audit-freshness — #106)
// ---------------------------------------------------------------------------

/**
 * The authoritative "last mutation" instant for a record: the most recent of
 * the record's `updated_at` and its latest `mutation_log` entry `at`. Both are
 * refreshed by every mutating op (store contract §1.1 / §4.2); taking the later
 * of the two is robust even if an adapter lags one behind the other. Falls back
 * to `created_at` when neither is present.
 *
 * @param {object} record
 * @returns {string} ISO-8601 timestamp
 */
function lastMutationOf(record) {
  const candidates = [];
  if (record.updated_at) candidates.push(record.updated_at);
  const log = Array.isArray(record.mutation_log) ? record.mutation_log : [];
  for (const entry of log) {
    if (entry && entry.at) candidates.push(entry.at);
  }
  if (candidates.length === 0) return record.created_at || record.updated_at || "";
  // Lexicographic max works for ISO-8601 UTC timestamps.
  return candidates.reduce((max, t) => (t > max ? t : max));
}

/**
 * Resolve the staleness threshold for a category using dot-hierarchy
 * longest-prefix matching: a record in `radar.signals.weak` prefers a
 * `radar.signals` threshold over a `radar` one, then falls back to
 * `defaultThresholdDays`. Returns `null` when no threshold applies (the
 * category is then skipped — auditing is opt-in).
 *
 * @param {string} category
 * @param {Record<string, number>} thresholds
 * @param {number|null} defaultThresholdDays
 * @returns {{ thresholdDays: number, matchedKey: string } | null}
 */
function resolveThreshold(category, thresholds, defaultThresholdDays) {
  const segments = (category || "").split(".");
  for (let i = segments.length; i > 0; i -= 1) {
    const key = segments.slice(0, i).join(".");
    if (Object.prototype.hasOwnProperty.call(thresholds, key)) {
      return { thresholdDays: thresholds[key], matchedKey: key };
    }
  }
  if (defaultThresholdDays !== null && defaultThresholdDays !== undefined) {
    return { thresholdDays: defaultThresholdDays, matchedKey: "*" };
  }
  return null;
}

/**
 * Resolve the proposed action ("archive" | "refresh") for a flagged record's
 * category, using the same dot-hierarchy longest-prefix matching, falling back
 * to `defaultAction`.
 *
 * @param {string} category
 * @param {Record<string, "archive"|"refresh">} actions
 * @param {"archive"|"refresh"} defaultAction
 * @returns {"archive"|"refresh"}
 */
function resolveAction(category, actions, defaultAction) {
  const segments = (category || "").split(".");
  for (let i = segments.length; i > 0; i -= 1) {
    const key = segments.slice(0, i).join(".");
    if (Object.prototype.hasOwnProperty.call(actions, key)) {
      return actions[key];
    }
  }
  return defaultAction;
}

// ---------------------------------------------------------------------------
// Glossary-sync helpers  (knowledge.glossary-sync — #106)
// ---------------------------------------------------------------------------

/**
 * Normalize a glossary term for comparison/matching: trimmed, collapsed inner
 * whitespace, lower-cased. Concept lookup is case/space-insensitive on the term
 * so "API Gateway", "api  gateway", and "Api Gateway" all resolve to the same
 * concept — terms are identity, not prose.
 *
 * @param {string} term
 * @returns {string}
 */
function normalizeTerm(term) {
  return String(term || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Compare a canonical definition against an existing concept body for the
 * purpose of staleness detection. Whitespace-insensitive (leading/trailing +
 * collapsed runs + trailing newline) so that cosmetic reflow is NOT treated as
 * drift; any substantive difference is. Returns true when they are equivalent.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function definitionsEquivalent(a, b) {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/**
 * Default term extractor: parse glossary-style entries out of a canonical doc's
 * body. Pluggable — a caller may pass their own `termExtractor(doc) => entries`
 * (e.g. to read a structured front-matter glossary). The default recognizes the
 * two most common hand-written glossary line shapes, one entry per line:
 *
 *   - **Term** — definition        (bold term, em/en-dash or hyphen separator)
 *   - Term: definition             (leading term, colon separator)
 *   - - **Term**: definition       (markdown list item, either separator)
 *
 * A term must be 1–80 chars and a definition non-empty; lines that don't match
 * are ignored (prose between entries is not a term). Duplicate terms within one
 * doc keep the FIRST definition (canonical-doc order is authoritative).
 *
 * @param {object} doc  a canonical-source record ({ id, title, body, category, ... })
 * @returns {Array<{ term: string, definition: string }>}
 */
function defaultTermExtractor(doc) {
  const body = String(doc?.body || "");
  const out = [];
  const seen = new Set();
  // Separator: em-dash, en-dash, or hyphen surrounded by spaces, OR a colon.
  const SEP = "(?:\\s+[—–-]\\s+|:\\s+)";
  // Bold term: **Term** SEP definition   (optionally a leading list marker)
  const boldRe = new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*(.+?)\\*\\*${SEP}(.+)$`);
  // Plain term: Term: definition   (colon only, to avoid eating prose dashes)
  const plainRe = /^\s*(?:[-*]\s+)?([^:\n*][^:\n]{0,79}?):\s+(.+)$/;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    let m = boldRe.exec(line);
    if (!m) m = plainRe.exec(line);
    if (!m) continue;
    const term = m[1].trim();
    const definition = m[2].trim();
    if (!term || term.length > 80 || !definition) continue;
    const key = normalizeTerm(term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category-canonicalization helpers  (knowledge.canonicalize-category — #106)
// ---------------------------------------------------------------------------

/**
 * The set of distinct dot-prefixes a category contributes, from its own full
 * path down to (but NOT including) the empty root. `radar.signals.weak` yields
 * `["radar", "radar.signals", "radar.signals.weak"]`. Used to build the
 * category tree (which prefixes are *nodes*) and to find which prefixes hold a
 * record directly vs. only via descendants.
 *
 * @param {string} category
 * @returns {string[]}
 */
function categoryPrefixes(category) {
  const segments = (category || "").split(".").filter(Boolean);
  const out = [];
  for (let i = 1; i <= segments.length; i += 1) {
    out.push(segments.slice(0, i).join("."));
  }
  return out;
}

/**
 * The immediate parent prefix of a category, or "" for a top-level category.
 * `radar.signals.weak` → `radar.signals`; `radar` → "".
 *
 * @param {string} category
 * @returns {string}
 */
function parentPrefix(category) {
  const segments = (category || "").split(".").filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join(".");
}

/**
 * Does a record count as "implemented-but-active" sprawl? A record is flagged
 * when its status is still `"active"` yet it carries one of the operator-
 * supplied "implemented" marker tags (e.g. `implemented`, `shipped`, `done`) —
 * it should have transitioned to `implemented`/`retired` via `retire` but never
 * did, so it lingers in the working set. Marker matching is case-insensitive.
 *
 * @param {object} record
 * @param {Set<string>} markerSet  lower-cased implemented-marker tags
 * @returns {boolean}
 */
function isImplementedButActive(record, markerSet) {
  if (markerSet.size === 0) return false;
  if ((record.status || "active") !== "active") return false;
  const tags = Array.isArray(record.tags) ? record.tags : [];
  return tags.some((t) => markerSet.has(String(t).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Classification heuristics
// ---------------------------------------------------------------------------

// Infer a category from raw text and provided meta. The caller may supply
// category directly in meta; otherwise we derive it from keywords.
function inferCategory(rawText, meta) {
  if (meta?.category) return meta.category;

  const text = (rawText || "").toLowerCase();

  // Simple keyword-based classifier — good enough for an ingest gate
  if (/\b(api|rest|graphql|endpoint|http)\b/.test(text)) return "engineering.api";
  if (/\b(test|spec|unit|assertion)\b/.test(text)) return "engineering.testing";
  if (/\b(architecture|design|pattern|system)\b/.test(text)) return "engineering.architecture";
  if (/\b(meeting|standup|decision|action item)\b/.test(text)) return "team.meeting";
  if (/\b(research|study|paper|finding)\b/.test(text)) return "research.notes";
  if (/\b(bug|fix|issue|error|exception)\b/.test(text)) return "engineering.bugs";
  if (/\b(deploy|release|version|ci|cd)\b/.test(text)) return "engineering.ops";

  return "general";
}

// Derive a title from the raw text (first line, truncated)
function inferTitle(rawText, meta) {
  if (meta?.title) return meta.title;
  const firstLine = (rawText || "").split("\n")[0].trim().slice(0, 80);
  return firstLine || "Untitled capture";
}

// ---------------------------------------------------------------------------
// Similarity detection — pluggable interface (R3)
// ---------------------------------------------------------------------------

/**
 * Default similarity detector: category match + link-overlap heuristic.
 *
 * SimilarityDetector interface:
 *   async (concept: Record, candidates: Record[], store: KnowledgeStoreAdapter) => string[]
 *
 * Returns the IDs of candidates deemed similar to the concept.
 *
 * Algorithm (v1):
 *   1. Category match: candidate.category starts with concept.category (prefix match)
 *      OR concept.category starts with candidate.category. Excludes non-matches unless
 *      the threshold is lowered.
 *   2. Link-overlap: compute Jaccard similarity of outbound link target_ids between
 *      concept and candidate. Candidates with Jaccard >= LINK_OVERLAP_THRESHOLD are
 *      included.
 *   3. A candidate passes if it satisfies EITHER criterion.
 *
 * @param {object} concept    - concept record
 * @param {object[]} candidates - compiled records
 * @param {object} store      - KnowledgeStoreAdapter (for getLinks)
 * @returns {Promise<string[]>} IDs of similar compiled records
 */
export async function defaultSimilarityDetector(concept, candidates, store) {
  const LINK_OVERLAP_THRESHOLD = 0.1; // Jaccard threshold for link overlap

  const conceptLinks = await store.getLinks(concept.id);
  const conceptTargets = new Set(
    (conceptLinks.forward || []).map((l) => l.target_id)
  );

  const similar = [];

  for (const candidate of candidates) {
    // Exclude retired records from the working set (Addendum B — R3)
    if ((candidate.status || "active") === "retired") continue;

    // Check 1: category overlap (prefix match in either direction)
    const catMatch =
      candidate.category === concept.category ||
      candidate.category.startsWith(`${concept.category}.`) ||
      concept.category.startsWith(`${candidate.category}.`);

    // Check 2: link-overlap heuristic (Jaccard similarity of outbound link targets)
    let jaccard = 0;
    if (conceptTargets.size > 0) {
      const candidateLinks = await store.getLinks(candidate.id);
      const candidateTargets = new Set(
        (candidateLinks.forward || []).map((l) => l.target_id)
      );
      const intersection = [...conceptTargets].filter((t) => candidateTargets.has(t));
      const union = new Set([...conceptTargets, ...candidateTargets]);
      jaccard = union.size > 0 ? intersection.length / union.size : 0;
    }

    if (catMatch || jaccard >= LINK_OVERLAP_THRESHOLD) {
      similar.push(candidate.id);
    }
  }

  return similar;
}

// ===========================================================================
// Contradiction detection — pluggable interface  (knowledge.detect-contradictions — #106)
// ===========================================================================

/**
 * Default contradiction detector: opposing-polarity heuristic.
 *
 * ContradictionDetector interface (mirrors SimilarityDetector — R3):
 *   (recordA: Record, recordB: Record) => null | { reason: string }
 *   Return `null` when the two records' assertions do NOT conflict, or an object
 *   carrying a human-readable `reason` when they DO. May be async.
 *
 * The two records passed in are already known to be *about the same thing* (the
 * caller scopes comparisons to a category and to records the similarity adapter
 * deems similar). The detector's only job is to decide whether their assertions
 * conflict — never to re-judge subject overlap.
 *
 * Default heuristic (v1, deliberately conservative):
 *   Detects opposing polarity over a shared subject. Each record's body is split
 *   into clauses; each clause is reduced to its set of salient content tokens
 *   (stop-words and the negation tokens stripped) and tagged affirmative or
 *   negative by whether it carries a negation. A contradiction is reported when
 *   one record AFFIRMS a clause whose content tokens contain those of a clause
 *   the other record NEGATES (e.g. "use REST for the public API" vs "do not use
 *   REST"). Token-containment (not exact equality) is used so trailing detail on
 *   one side does not hide the conflict. Returns the conflicting phrase as the
 *   reason.
 *
 * This is intentionally simple and replaceable — the issue calls for a
 * *pluggable* contradiction fn precisely because real contradiction detection is
 * domain-sensitive (an embedding/NLI model is the obvious upgrade, injected the
 * same way the vector similarity adapter is).
 *
 * @param {object} recordA
 * @param {object} recordB
 * @returns {{ reason: string } | null}
 */
const NEGATION_RE = /\b(?:not|never|no longer|don't|do not|doesn't|does not|isn't|is not|won't|will not|cannot|can't|avoid|stop|deprecated?|disallow(?:ed)?|forbidden?)\b/;

const STOP_WORDS = new Set([
  "we", "i", "you", "they", "it", "the", "a", "an", "should", "must", "will",
  "shall", "to", "please", "for", "of", "and", "or", "is", "are", "be", "this",
  "that", "with", "as", "on", "in", "at", "by", "all", "any", "our", "their",
]);

/**
 * Reduce a record body into clauses, each tagged affirmative/negative by whether
 * it carries a negation, with salient content tokens (stop-words + negation
 * tokens stripped). Returned as { affirmed: Clause[], negated: Clause[] } where
 * a Clause is { tokens: Set<string>, phrase: string }.
 */
function assertionClauses(body) {
  const affirmed = [];
  const negated = [];
  for (const raw of String(body || "").toLowerCase().split(/[.;,\n!?]+/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const isNegated = NEGATION_RE.test(clause);
    const phrase = clause.replace(NEGATION_RE, " ").replace(/\s+/g, " ").trim();
    const tokens = new Set(
      phrase
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    );
    if (tokens.size === 0) continue;
    (isNegated ? negated : affirmed).push({ tokens, phrase });
  }
  return { affirmed, negated };
}

// Every token of `inner` is present in `outer` (subset containment).
function tokensContain(outer, inner) {
  if (inner.size === 0) return false;
  for (const t of inner) if (!outer.has(t)) return false;
  return true;
}

export function defaultContradictionDetector(recordA, recordB) {
  const a = assertionClauses(recordA.body);
  const b = assertionClauses(recordB.body);

  // A contradicts B when one AFFIRMS a clause whose content tokens contain those
  // of a clause the other NEGATES (token-containment, either direction).
  for (const aff of a.affirmed) {
    for (const neg of b.negated) {
      if (tokensContain(aff.tokens, neg.tokens)) {
        return {
          reason: `opposing assertions over "${neg.phrase}": ${recordA.id} affirms, ${recordB.id} negates`,
        };
      }
    }
  }
  for (const aff of b.affirmed) {
    for (const neg of a.negated) {
      if (tokensContain(aff.tokens, neg.tokens)) {
        return {
          reason: `opposing assertions over "${neg.phrase}": ${recordB.id} affirms, ${recordA.id} negates`,
        };
      }
    }
  }
  return null;
}

// ===========================================================================
// Inbound-reference integrity — doc→store citation extraction  (#340)
//
// The hygiene audits (Addenda D–G) survey *records*; nothing resolves the
// references a human reads — the ids curated docs (NOW.md, strategy/*.md) cite
// *into* the store. When a store restructure severs those citations, every gate
// still reports PASS. This scan closes that: it extracts record citations from
// caller-configured doc globs and resolves each via the #339 identity path
// (exact id → slug alias → unambiguous ≥8-char prefix), failing closed on any
// unresolvable *definite* citation.
//
// Extraction precision — the commit-SHA problem
// ---------------------------------------------
// A bare 8-hex token is ambiguous: `12cc5573` is equally a record short-id and
// an abbreviated git commit SHA. Failing on every non-resolving 8-hex token
// would flag every SHA in prose (the gate cries wolf and gets disabled); never
// failing on them re-opens the exact rot this issue closes. We resolve the
// tension by recognizing two tiers (store-contract.md Addendum I):
//
//   DEFINITE citation forms — a token is unmistakably a citation, so it is
//   resolved regardless of whether it currently resolves, and a miss FAILS:
//     • full UUID (8-4-4-4-12 hex) — the hyphenated shape never collides with a
//       git SHA (40/abbrev hex, no hyphens) or prose, so a bare UUID qualifies;
//     • a configured citation marker (default `rec:` / `record:`) wrapping a
//       short-id or slug, e.g. `rec:12cc5573`, `record:decision.strategy/gtm`;
//     • a wikilink `[[token]]` (the kit's own link syntax).
//
//   CANDIDATE bare short-ids — a standalone ≥8-hex token with no citation form
//   is included in the index ONLY when it already resolves to a record. A
//   non-resolving bare hex is indistinguishable from a commit SHA, so it is
//   IGNORED (never failed). This is the deliberate, documented miss: a *broken*
//   bare-hex short-id (no marker/wikilink) is invisible — cite short-ids in a
//   marker/wikilink form to get fail-closed protection. Full-UUID citations are
//   protected with zero configuration.
//
// This is a precision-over-recall choice: zero false positives on commit
// hashes, at the cost of not catching bare-hex short-id rot until the doc
// adopts a citation form (an ops-repo house-style change — a non-goal here).
// ---------------------------------------------------------------------------

// Default marker prefixes that opt a following short-id/slug into DEFINITE
// citation status. Caller-overridable via `options.markers`.
export const DEFAULT_CITATION_MARKERS = ["rec:", "record:"];

// Canonical UUID (8-4-4-4-12 hex). Self-identifying — always a definite citation.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Wikilink target: [[token]] or [[token|label]] (label discarded).
const WIKILINK_CITE_RE = /\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g;

// A standalone hex run 8..40 chars long — a bare short-id / SHA candidate.
const BARE_HEX_RE = /(?<![0-9a-z-])[0-9a-f]{8,40}(?![0-9a-z-])/gi;

// The token a marker may wrap: a slug/short-id character run (hex, slug chars).
// Kept permissive — #339 resolution semantics decide what actually resolves.
const MARKER_TOKEN_CHARS = "[A-Za-z0-9][A-Za-z0-9._/-]*";

/**
 * Translate a caller glob (`NOW.md`, `strategy/*.md`, `docs/**\/*.md`) into an
 * anchored RegExp over POSIX-style relative paths. `*` matches within a path
 * segment; `**` spans segments; `?` matches one non-slash char. Zero-dep.
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — span zero or more path segments.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Collect files under `rootDir` matching any of `globs`, returned as POSIX-style
 * paths relative to `rootDir`, sorted for determinism. Walks the tree once,
 * skipping VCS/dependency noise (`.git`, `node_modules`). A glob with no
 * wildcard is honoured even if the walk would skip its directory.
 */
function collectDocs(rootDir, globs) {
  const matchers = globs.map(globToRegExp);
  const out = new Set();

  const SKIP = new Set([".git", "node_modules"]);
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (matchers.some((m) => m.test(rel))) out.add(rel);
      }
    }
  };
  walk(rootDir, "");

  // Also honour literal (wildcard-free) globs directly — covers a file the walk
  // might not reach and keeps single-file configs O(1).
  for (const glob of globs) {
    if (!/[*?]/.test(glob)) {
      const abs = path.join(rootDir, glob);
      try {
        if (fs.statSync(abs).isFile()) out.add(glob.split(path.sep).join("/"));
      } catch { /* not present — reported as an empty scan for that glob */ }
    }
  }
  return [...out].sort();
}

/**
 * Extract DEFINITE citations (uuid | marker | wikilink) plus CANDIDATE bare
 * short-ids from one line. Returns citation descriptors with 1-based line/column
 * so failures can name the exact location. Overlapping spans are claimed by the
 * higher-priority form first (marker/wikilink/uuid before bare) so a token is
 * never double-counted.
 *
 * @param {string} line
 * @param {number} lineNo   1-based line number
 * @param {string[]} markers
 * @returns {Array<{ line:number, column:number, token:string, form:string }>}
 */
function extractLineCitations(line, lineNo, markers) {
  const found = [];
  const claimed = []; // [start,end) offsets already consumed by a higher-priority form

  const overlaps = (start, end) =>
    claimed.some(([s, e]) => start < e && end > s);
  const claim = (start, end, token, form) => {
    if (overlaps(start, end)) return;
    claimed.push([start, end]);
    found.push({ line: lineNo, column: start + 1, token: token.trim(), form });
  };

  // 1. Wikilinks (highest priority — explicit kit link syntax).
  for (const m of line.matchAll(WIKILINK_CITE_RE)) {
    const token = m[1];
    if (token && token.trim()) claim(m.index, m.index + m[0].length, token, "wikilink");
  }

  // 2. Markers (rec: / record: …) wrapping a slug/short-id.
  for (const marker of markers) {
    const markerRe = new RegExp(
      `${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${MARKER_TOKEN_CHARS})`,
      "g"
    );
    for (const m of line.matchAll(markerRe)) {
      const token = m[1];
      const tokenStart = m.index + m[0].length - token.length;
      claim(tokenStart, m.index + m[0].length, token, "marker");
    }
  }

  // 3. Full UUIDs (self-identifying; also captures a bare UUID not in a form).
  for (const m of line.matchAll(UUID_RE)) {
    claim(m.index, m.index + m[0].length, m[0], "uuid");
  }

  // 4. Bare hex short-id CANDIDATES — resolution decides inclusion later.
  for (const m of line.matchAll(BARE_HEX_RE)) {
    claim(m.index, m.index + m[0].length, m[0], "bare");
  }

  return found;
}

/**
 * Resolve a citation token against the store via the #339 identity path.
 * `store.get(token)` accepts an exact id, slug alias, or unambiguous ≥8-char
 * prefix; returns `null` when it resolves to nothing and throws `AMBIGUOUS_ID`
 * when a prefix collides. Both non-resolution modes are reported (never thrown
 * out of the scan) so one bad token cannot abort the whole check.
 *
 * @returns {Promise<{ resolved:boolean, recordId:string|null, reason?:string, matches?:string[] }>}
 */
async function resolveCitation(store, token) {
  let record;
  try {
    record = await store.get(token);
  } catch (err) {
    if (err && err.code === "AMBIGUOUS_ID") {
      return { resolved: false, recordId: null, reason: "ambiguous", matches: err.matches };
    }
    throw err;
  }
  if (record && record.id) return { resolved: true, recordId: record.id };
  return { resolved: false, recordId: null, reason: "not-found" };
}

// ---------------------------------------------------------------------------
// KnowledgeFlowRunner
// ---------------------------------------------------------------------------

export class KnowledgeFlowRunner {
  /**
   * @param {{
   *   store: KnowledgeStoreAdapter,
   *   workspace?: string,
   *   agent?: string,
   *   sessionId?: string
   * }} options
   */
  constructor({ store, workspace, agent, sessionId } = {}) {
    if (!store) throw new Error("KnowledgeFlowRunner: store adapter is required");
    this._store = store;
    this._agent = agent || "knowledge-flow-runner";
    this._telemetry = new KnowledgeTelemetry({
      workspace,
      agentName: this._agent,
      sessionId,
    });
  }

  // -------------------------------------------------------------------------
  // knowledge.ingest flow
  //   Steps: capture → classify → route → done
  //   Gate: classify-gate — classification recorded (category + type=raw)
  // -------------------------------------------------------------------------

  /**
   * Execute the ingest flow: capture raw text, classify it, store as a raw
   * record, and route it.
   *
   * @param {string} rawText  - the raw content to capture
   * @param {object} [meta]   - optional metadata overrides:
   *   - title: string       - record title (inferred from first line if absent)
   *   - category: string    - dot-separated category (inferred if absent)
   *   - tags: string[]      - tag list
   *   - agent: string       - override agent name
   *   - session_id: string  - session identifier
   *   - note: string        - provenance note
   * @returns {Promise<{ id: string, record: object, telemetryEvents: object[] }>}
   */
  async capture(rawText, meta = {}) {
    const events = [];

    // ── Step: capture ──────────────────────────────────────────────────────
    if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
      throw missingEvidenceError("capture: rawText must be a non-empty string");
    }

    // ── Gate: classify-gate ────────────────────────────────────────────────
    // Evidence required: category (non-empty) + type="raw"
    const category = inferCategory(rawText, meta);
    const title = inferTitle(rawText, meta);

    const gateContext = {
      flow: "knowledge.ingest",
      gate: "classify-gate",
      evidence: {
        type: "raw",
        category,
        title,
      },
    };

    // Emit gate entry event (preToolUse)
    const gateInEvent = this._telemetry.emitGate("knowledge.ingest", "classify-gate", gateContext);
    events.push(gateInEvent);

    // Enforce gate: category must be valid (non-empty, proper format)
    if (!category || typeof category !== "string" || !category.trim()) {
      throw missingEvidenceError("classify-gate: classification failed — category is empty");
    }
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(category)) {
      throw missingEvidenceError(`classify-gate: classification failed — invalid category: ${category}`);
    }

    // ── Step: classify — create the raw record in the store ────────────────
    const provenance = {
      agent: meta?.agent || this._agent,
      ...(meta?.session_id ? { session_id: meta.session_id } : {}),
      ...(meta?.note ? { note: meta.note } : {}),
    };

    const recordId = await this._store.create({
      type: "raw",
      title,
      body: rawText,
      category,
      tags: meta?.tags || [],
      provenance,
    });

    // Emit gate exit event (postToolUse) — classification recorded
    const gateOutEvent = this._telemetry.emitGateResult("knowledge.ingest", "classify-gate", {
      record_id: recordId,
      type: "raw",
      category,
      title,
    });
    events.push(gateOutEvent);

    // ── Step: route — record routing decision ─────────────────────────────
    // Default routing: queue for compilation (operator can override via meta.routing)
    const routing = meta?.routing || "queue-for-compile";

    const routeGateInEvent = this._telemetry.emitGate("knowledge.ingest", "route-gate", {
      flow: "knowledge.ingest",
      gate: "route-gate",
      record_id: recordId,
      routing_decision: routing,
    });
    events.push(routeGateInEvent);

    const routeGateOutEvent = this._telemetry.emitGateResult("knowledge.ingest", "route-gate", {
      record_id: recordId,
      routing_decision: routing,
    });
    events.push(routeGateOutEvent);

    const record = await this._store.get(recordId);
    return { id: recordId, record, telemetryEvents: events };
  }

  // -------------------------------------------------------------------------
  // knowledge.compile flow
  //   Steps: select-raws → compile → link → done
  //   Gate: compile-gate — compiled record carries provenance refs to EVERY
  //         consumed raw (provenance.source_ids + source links)
  // -------------------------------------------------------------------------

  /**
   * Execute the compile flow: select raw records, compile them into a
   * normalized note, create the compiled record with full provenance, and
   * verify all provenance refs resolve.
   *
   * @param {string[]} rawIds  - IDs of raw records to compile
   * @param {object} [options]
   *   - title: string         - title for the compiled record
   *   - body: string          - compiled body (if omitted, concatenates raw bodies)
   *   - category: string      - category (defaults to most common raw category)
   *   - tags: string[]        - tags
   *   - agent: string         - override agent
   *   - session_id: string    - session id
   *   - note: string          - provenance note
   * @returns {Promise<{ id: string, record: object, telemetryEvents: object[] }>}
   */
  async compile(rawIds, options = {}) {
    const events = [];

    // ── Step: select-raws ──────────────────────────────────────────────────
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw missingEvidenceError("compile: rawIds must be a non-empty array");
    }

    // Emit select-raws gate entry
    const selectGateIn = this._telemetry.emitGate("knowledge.compile", "select-raws-gate", {
      flow: "knowledge.compile",
      gate: "select-raws-gate",
      raw_ids: rawIds,
    });
    events.push(selectGateIn);

    // Fetch all raw records — reject if any is missing or not type=raw
    const rawRecords = [];
    for (const rawId of rawIds) {
      const rec = await this._store.get(rawId);
      if (!rec) {
        throw missingEvidenceError(`select-raws-gate: raw record not found: ${rawId}`);
      }
      if (rec.type !== "raw") {
        throw missingEvidenceError(`select-raws-gate: record ${rawId} is type="${rec.type}", expected "raw"`);
      }
      rawRecords.push(rec);
    }

    const selectGateOut = this._telemetry.emitGateResult("knowledge.compile", "select-raws-gate", {
      raw_ids: rawIds,
      count: rawRecords.length,
    });
    events.push(selectGateOut);

    // ── Step: compile ──────────────────────────────────────────────────────
    // Build compiled body from raws if not provided
    const compiledBody = options.body
      || rawRecords.map((r) => `## ${r.title}\n\n${r.body}`).join("\n\n---\n\n");

    // Determine category: use option, or most-common raw category
    const compiledCategory = options.category || mostCommonCategory(rawRecords);

    const compiledTitle = options.title
      || (rawRecords.length === 1
        ? `Compiled: ${rawRecords[0].title}`
        : `Compiled from ${rawRecords.length} sources`);

    // Build source links — one per raw record with kind="source"
    const sourceLinks = rawIds.map((rawId) => ({
      target_id: rawId,
      kind: "source",
    }));

    // Provenance: source_ids must list EVERY consumed raw ID
    const provenance = {
      agent: options.agent || this._agent,
      source_ids: rawIds,   // ← required by compile-gate
      ...(options.session_id ? { session_id: options.session_id } : {}),
      ...(options.note ? { note: options.note } : {}),
    };

    // ── Gate: compile-gate — emit before store.create ─────────────────────
    const compileGateIn = this._telemetry.emitGate("knowledge.compile", "compile-gate", {
      flow: "knowledge.compile",
      gate: "compile-gate",
      evidence: {
        source_ids: rawIds,
        source_links: sourceLinks,
        category: compiledCategory,
      },
    });
    events.push(compileGateIn);

    // Enforce: provenance.source_ids must cover ALL rawIds
    if (!provenance.source_ids || provenance.source_ids.length !== rawIds.length) {
      throw missingEvidenceError(
        `compile-gate: provenance.source_ids must list every consumed raw ID; ` +
        `expected ${rawIds.length} entries, got ${provenance.source_ids?.length ?? 0}`
      );
    }

    const compiledId = await this._store.create({
      type: "compiled",
      title: compiledTitle,
      body: compiledBody,
      category: compiledCategory,
      tags: options.tags || [],
      links: sourceLinks,
      provenance,
    });

    const compileGateOut = this._telemetry.emitGateResult("knowledge.compile", "compile-gate", {
      compiled_id: compiledId,
      source_ids: rawIds,
      source_link_count: sourceLinks.length,
    });
    events.push(compileGateOut);

    // ── Step: link — verify provenance refs resolve ────────────────────────
    const linkGateIn = this._telemetry.emitGate("knowledge.compile", "link-gate", {
      flow: "knowledge.compile",
      gate: "link-gate",
      compiled_id: compiledId,
      expected_raw_ids: rawIds,
    });
    events.push(linkGateIn);

    // Verify: every provenance ref resolves via store.get()
    for (const rawId of rawIds) {
      const ref = await this._store.get(rawId);
      if (!ref) {
        throw missingEvidenceError(`link-gate: provenance ref ${rawId} does not resolve`);
      }
    }

    // Verify: graph index reflects source links
    const { forward } = await this._store.getLinks(compiledId);
    for (const rawId of rawIds) {
      const hasSourceLink = forward.some(
        (l) => l.target_id === rawId && l.kind === "source"
      );
      if (!hasSourceLink) {
        throw missingEvidenceError(
          `link-gate: source link to raw ${rawId} missing from graph index`
        );
      }
    }

    const linkGateOut = this._telemetry.emitGateResult("knowledge.compile", "link-gate", {
      compiled_id: compiledId,
      resolved_raw_ids: rawIds,
      graph_links_verified: rawIds.length,
    });
    events.push(linkGateOut);

    const record = await this._store.get(compiledId);
    return { id: compiledId, record, telemetryEvents: events };
  }

  // -------------------------------------------------------------------------
  // knowledge.synthesize flow
  //   Steps: detect-cluster → propose → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries source refs; no direct mutation (AC1)
  //         apply-gate    — apply or reject via store ops only (never direct write)
  //                         rejection leaves concept byte-identical (AC2)
  //                         apply updates with provenance to all sources (AC3)
  // -------------------------------------------------------------------------

  /**
   * Execute the synthesize flow: detect similar compiled records, create a
   * proposal via the store's propose op (never a direct mutation), gate the
   * evidence, then apply or reject.
   *
   * @param {string|object} conceptIdOrSelector
   *   - string: ID of an existing concept record to synthesize toward.
   *   - object topicSelector: { category } — concept located by category.
   * @param {object} [options]
   *   - proposedBody: string       — the proposed replacement body (required)
   *   - rationale: string          — reason for the proposal (required for apply)
   *   - decision: "apply"|"reject" — gate decision (default "apply")
   *   - rejectReason: string       — reason for rejection (required when decision="reject")
   *   - agent: string              — override agent name
   *   - session_id: string         — session id
   *   - note: string               — provenance note
   *   - similarityDetector: fn     — pluggable detector (R3); see SimilarityDetector interface
   * @returns {Promise<{
   *   conceptId: string,
   *   proposerId: string,
   *   cluster: string[],
   *   decision: "apply"|"reject",
   *   telemetryEvents: object[]
   * }>}
   */
  async synthesize(conceptIdOrSelector, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: detect-cluster ───────────────────────────────────────────────
    // Resolve concept id; locate similar compiled records via similarity detector

    const detector = options.similarityDetector || defaultSimilarityDetector;

    // Resolve the concept record
    let conceptId;
    if (typeof conceptIdOrSelector === "string") {
      conceptId = conceptIdOrSelector;
      const concept = await this._store.get(conceptId);
      if (!concept) {
        throw missingEvidenceError(`synthesize: concept not found: ${conceptId}`);
      }
      if (concept.type !== "concept") {
        throw missingEvidenceError(
          `synthesize: record ${conceptId} is type="${concept.type}", expected "concept"`
        );
      }
    } else if (conceptIdOrSelector && typeof conceptIdOrSelector === "object") {
      // topicSelector: find by category
      const sel = conceptIdOrSelector;
      if (!sel.category) {
        throw missingEvidenceError("synthesize: topicSelector must include a category");
      }
      const concepts = (await this._store.listByType("concept")).filter(
        (r) => r.category === sel.category
      );
      if (concepts.length === 0) {
        throw missingEvidenceError(
          `synthesize: no concept found for category: ${sel.category}`
        );
      }
      conceptId = concepts[0].id;
    } else {
      throw missingEvidenceError(
        "synthesize: conceptIdOrSelector must be a string id or topicSelector object"
      );
    }

    const concept = await this._store.get(conceptId);

    // Emit detect-cluster gate entry
    const detectGateIn = this._telemetry.emitGate(
      "knowledge.synthesize",
      "detect-cluster-gate",
      {
        flow: "knowledge.synthesize",
        gate: "detect-cluster-gate",
        concept_id: conceptId,
        concept_category: concept.category,
      }
    );
    events.push(detectGateIn);

    // Run similarity detection
    const allCompiled = await this._store.listByType("compiled");
    const cluster = await detector(concept, allCompiled, this._store);

    if (!Array.isArray(cluster) || cluster.length === 0) {
      throw missingEvidenceError(
        "detect-cluster-gate: no similar compiled records found; " +
        "synthesis requires at least one similar source"
      );
    }

    const detectGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "detect-cluster-gate",
      {
        concept_id: conceptId,
        cluster_ids: cluster,
        cluster_size: cluster.length,
      }
    );
    events.push(detectGateOut);

    // ── Step: propose ──────────────────────────────────────────────────────
    // The proposing record is the first compiled record in the cluster.
    // We use the store's propose op — never a direct mutation (AC1).

    if (!options.proposedBody || !options.proposedBody.trim()) {
      throw missingEvidenceError("synthesize: options.proposedBody is required");
    }

    const proposerId = cluster[0];

    const proposeGateIn = this._telemetry.emitGate("knowledge.synthesize", "propose-gate", {
      flow: "knowledge.synthesize",
      gate: "propose-gate",
      concept_id: conceptId,
      proposer_id: proposerId,
      source_ids: cluster,
    });
    events.push(proposeGateIn);

    // Create proposal via store propose op (not direct mutation — AC1)
    await this._store.propose(conceptId, proposerId, {
      agent,
      proposal: options.proposedBody,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "propose-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify proposal carries source refs and all source records exist

    const evidenceGateIn = this._telemetry.emitGate(
      "knowledge.synthesize",
      "evidence-gate",
      {
        flow: "knowledge.synthesize",
        gate: "evidence-gate",
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(evidenceGateIn);

    // Enforce: source_ids must be non-empty
    if (!cluster || cluster.length === 0) {
      throw missingEvidenceError(
        "evidence-gate: proposal must carry at least one source_id reference"
      );
    }

    // Enforce: every source record must exist
    for (const srcId of cluster) {
      const ref = await this._store.get(srcId);
      if (!ref) {
        throw missingEvidenceError(
          `evidence-gate: source record ${srcId} does not exist in store`
        );
      }
    }

    // Enforce: proposer must have a "proposes" link to the concept
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === conceptId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to concept ${conceptId}`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "evidence-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        source_ids: cluster,
        sources_verified: cluster.length,
        proposes_link_verified: true,
      }
    );
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    // Gate decision: "apply" (default) or "reject"

    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate("knowledge.synthesize", "apply-gate", {
      flow: "knowledge.synthesize",
      gate: "apply-gate",
      concept_id: conceptId,
      proposer_id: proposerId,
      decision,
    });
    events.push(applyGateIn);

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rationale is required when decision=apply"
        );
      }
      // Apply via store apply op — updates concept body with provenance to
      // all contributing sources (AC3)
      await this._store.apply(conceptId, proposerId, {
        agent,
        new_body: options.proposedBody,
        rationale: options.rationale,
      });
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject via store reject op — concept body remains untouched (AC2)
      await this._store.reject(conceptId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult(
      "knowledge.synthesize",
      "apply-gate",
      {
        concept_id: conceptId,
        proposer_id: proposerId,
        decision,
        source_ids: cluster,
      }
    );
    events.push(applyGateOut);

    return { conceptId, proposerId, cluster, decision, telemetryEvents: events };
  }
  // -------------------------------------------------------------------------
  // knowledge.consolidate flow
  //   Steps: related-event → propose → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries source refs; no direct snapshot
  //         mutation (AC1); rejection leaves snapshot unchanged (AC2 reject path).
  //         apply-gate    — apply or reject via store ops only.
  //                         apply creates a new snapshot and supersedes the prior
  //                         one(s); superseded snapshots remain queryable (AC2/R3).
  //
  // Machinery reuse: consolidate shares the same propose→evidence-gate→
  // apply-or-reject gate pattern as synthesize. The propose op is called on the
  // snapshot record (store contract §A.5 supersede enforces supersede-not-delete).
  // -------------------------------------------------------------------------

  /**
   * Execute the consolidate flow: detect compiled records linked to a snapshot
   * topic, create a consolidation proposal (never a direct mutation), gate the
   * evidence, then apply or reject.
   *
   * On apply:
   *   1. A new snapshot record is created with the proposed body and full
   *      provenance (source_ids referencing every contributing compiled record).
   *   2. The store supersede op links the new snapshot to any prior snapshot(s)
   *      for the same topic — prior snapshots are NEVER deleted (R3).
   *   3. Returns the new snapshot id plus a supersedes chain for traceability.
   *
   * On reject:
   *   The snapshot state is unchanged (byte-identical, AC1/AC2).
   *
   * @param {string|object} snapshotIdOrTopic
   *   - string: ID of an existing snapshot record to consolidate against.
   *   - object topicSelector: { topic } — snapshot located by topic tag.
   *     If no snapshot exists for the topic yet, a new one will be created on apply.
   * @param {object} [options]
   *   - proposedBody: string        — the proposed snapshot body (required)
   *   - rationale: string           — reason for the consolidation (required for apply)
   *   - decision: "apply"|"reject"  — gate decision (default "apply")
   *   - rejectReason: string        — reason for rejection (required when decision="reject")
   *   - agent: string               — override agent name
   *   - session_id: string          — session id
   *   - note: string                — provenance note
   *   - category: string            — category for new snapshot (required when creating)
   *   - similarityDetector: fn      — pluggable detector (same interface as synthesize R3)
   * @returns {Promise<{
   *   snapshotId: string,
   *   proposerId: string,
   *   cluster: string[],
   *   decision: "apply"|"reject",
   *   newSnapshotId: string|null,
   *   supersededIds: string[],
   *   telemetryEvents: object[]
   * }>}
   */
  async consolidate(snapshotIdOrTopic, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: related-event ────────────────────────────────────────────────
    // Resolve snapshot target; locate related compiled records via detector.

    const detector = options.similarityDetector || defaultSimilarityDetector;

    // Resolve the snapshot record (or find it by topic tag).
    // If no snapshot yet exists and decision=apply, we will create one.
    let snapshotId = null;
    let existingSnapshot = null;
    let topic = null;
    let category = options.category || null;

    if (typeof snapshotIdOrTopic === "string") {
      snapshotId = snapshotIdOrTopic;
      existingSnapshot = await this._store.get(snapshotId);
      if (!existingSnapshot) {
        throw missingEvidenceError(`consolidate: snapshot not found: ${snapshotId}`);
      }
      if (existingSnapshot.type !== "snapshot") {
        throw missingEvidenceError(
          `consolidate: record ${snapshotId} is type="${existingSnapshot.type}", expected "snapshot"`
        );
      }
      // Extract topic from tags (stored as "topic:<value>")
      const topicTag = (existingSnapshot.tags || []).find((t) => t.startsWith("topic:"));
      topic = topicTag ? topicTag.slice(6) : existingSnapshot.category;
      category = category || existingSnapshot.category;
    } else if (snapshotIdOrTopic && typeof snapshotIdOrTopic === "object") {
      const sel = snapshotIdOrTopic;
      topic = sel.topic || sel.category;
      if (!topic) {
        throw missingEvidenceError(
          "consolidate: topicSelector must include a topic or category field"
        );
      }
      // Find existing snapshot by topic tag
      const allSnapshots = await this._store.listByType("snapshot");
      const matches = allSnapshots.filter((s) => {
        const topicTag = (s.tags || []).find((t) => t.startsWith("topic:"));
        const snapshotTopic = topicTag ? topicTag.slice(6) : s.category;
        return snapshotTopic === topic;
      });
      if (matches.length > 0) {
        // Use the most recently created snapshot (no superseded-by log entry = current)
        const current = matches.find((s) => {
          const log = s.mutation_log || [];
          return !log.some((e) => e.op === "superseded-by");
        }) || matches[matches.length - 1];
        existingSnapshot = current;
        snapshotId = current.id;
      }
      // If no existing snapshot, we will create one on apply
      category = category || sel.category || topic.replace(/[^a-z0-9.]/g, "-") || "general";
    } else {
      throw missingEvidenceError(
        "consolidate: snapshotIdOrTopic must be a string id or topicSelector object"
      );
    }

    // ── Gate: related-event-gate ───────────────────────────────────────────
    // Run similarity detection to find compiled records related to the topic.
    // We use a concept-like proxy to run the similarity detector: a synthetic
    // object with the same category as the snapshot.

    const snapshotProxy = existingSnapshot || {
      id: "__probe__",
      type: "snapshot",
      category: category || "general",
      tags: [`topic:${topic}`],
      links: [],
    };

    const relatedGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "related-event-gate",
      {
        flow: "knowledge.consolidate",
        gate: "related-event-gate",
        snapshot_id: snapshotId,
        topic,
        snapshot_category: snapshotProxy.category,
      }
    );
    events.push(relatedGateIn);

    // Run the detector: pass all compiled records as candidates
    const allCompiled = await this._store.listByType("compiled");
    const cluster = await detector(snapshotProxy, allCompiled, this._store);

    if (!Array.isArray(cluster) || cluster.length === 0) {
      throw missingEvidenceError(
        "related-event-gate: no compiled records related to snapshot topic found; " +
        "consolidation requires at least one related source"
      );
    }

    const relatedGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "related-event-gate",
      {
        snapshot_id: snapshotId,
        topic,
        cluster_ids: cluster,
        cluster_size: cluster.length,
      }
    );
    events.push(relatedGateOut);

    // ── Step: propose ──────────────────────────────────────────────────────
    // The proposing record is the first compiled record in the cluster.
    // We use the store's propose op — never a direct snapshot mutation (AC1).
    //
    // When the snapshot does not exist yet (first consolidation for the topic),
    // we create a placeholder snapshot record to attach the proposal to.

    if (!options.proposedBody || !options.proposedBody.trim()) {
      throw missingEvidenceError("consolidate: options.proposedBody is required");
    }

    // Ensure a snapshot record exists to propose against
    if (!snapshotId) {
      // Create a placeholder snapshot (empty body) so propose has a target
      const topicTag = `topic:${topic}`;
      snapshotId = await this._store.create({
        type: "snapshot",
        title: `Snapshot: ${topic}`,
        body: "(pending consolidation)",
        category: category || "general",
        tags: [topicTag],
        provenance: {
          agent,
          note: `Placeholder created for first consolidation of topic: ${topic}`,
          ...(options.session_id ? { session_id: options.session_id } : {}),
        },
      });
      existingSnapshot = await this._store.get(snapshotId);
    }

    const proposerId = cluster[0];

    const proposeGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "propose-gate",
      {
        flow: "knowledge.consolidate",
        gate: "propose-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(proposeGateIn);

    // Create proposal via store propose op (not direct mutation — AC1)
    // We repurpose the propose/apply/reject ops: snapshot acts as the "concept"
    // target here. The contract allows propose/apply/reject against concept-type
    // records, but snapshots are a distinct type. We call propose directly on
    // the store's propose method with the snapshot's id.
    await this._store.propose(snapshotId, proposerId, {
      agent,
      proposal: options.proposedBody,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "propose-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify proposal carries source refs and all source records exist.

    const evidenceGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "evidence-gate",
      {
        flow: "knowledge.consolidate",
        gate: "evidence-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
      }
    );
    events.push(evidenceGateIn);

    // Enforce: source_ids must be non-empty
    if (!cluster || cluster.length === 0) {
      throw missingEvidenceError(
        "evidence-gate: proposal must carry at least one source_id reference"
      );
    }

    // Enforce: every source record must exist
    for (const srcId of cluster) {
      const ref = await this._store.get(srcId);
      if (!ref) {
        throw missingEvidenceError(
          `evidence-gate: source record ${srcId} does not exist in store`
        );
      }
    }

    // Enforce: proposer must have a "proposes" link to the snapshot
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === snapshotId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to snapshot ${snapshotId}`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "evidence-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        source_ids: cluster,
        sources_verified: cluster.length,
        proposes_link_verified: true,
      }
    );
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    // Gate decision: "apply" (default) or "reject"

    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate(
      "knowledge.consolidate",
      "apply-gate",
      {
        flow: "knowledge.consolidate",
        gate: "apply-gate",
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        decision,
      }
    );
    events.push(applyGateIn);

    let newSnapshotId = null;
    let supersededIds = [];

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rationale is required when decision=apply"
        );
      }

      // Collect all prior (non-superseded) snapshots for the same topic,
      // so we can supersede them after creating the new snapshot.
      const allSnapshots = await this._store.listByType("snapshot");
      const priorSnapshotIds = allSnapshots
        .filter((s) => {
          if (s.id === snapshotId) return false; // we'll include the placeholder below
          const topicTag = (s.tags || []).find((t) => t.startsWith("topic:"));
          const snapshotTopic = topicTag ? topicTag.slice(6) : s.category;
          return snapshotTopic === topic;
        })
        .map((s) => s.id);

      // The placeholder snapshot (created above or passed in) is also superseded
      // unless it already has content (i.e., was the prior live snapshot).
      const placeholderSnapshot = await this._store.get(snapshotId);
      const isPlaceholder =
        placeholderSnapshot && placeholderSnapshot.body === "(pending consolidation)";

      // Create the new definitive snapshot with the proposed body
      const topicTag = `topic:${topic}`;
      const sourceLinks = cluster.map((cid) => ({ target_id: cid, kind: "source" }));

      newSnapshotId = await this._store.create({
        type: "snapshot",
        title: `Snapshot: ${topic}`,
        body: options.proposedBody,
        category: existingSnapshot?.category || category || "general",
        tags: [topicTag],
        links: sourceLinks,
        provenance: {
          agent,
          source_ids: cluster,
          note: options.rationale,
          ...(options.session_id ? { session_id: options.session_id } : {}),
        },
      });

      // Collect all snapshot IDs that this new snapshot supersedes
      supersededIds = [
        ...(isPlaceholder ? [snapshotId] : [snapshotId]),
        ...priorSnapshotIds,
      ];
      // Deduplicate
      supersededIds = [...new Set(supersededIds)];

      // Supersede all prior snapshots — NEVER deletes them (R3)
      if (supersededIds.length > 0) {
        await this._store.supersede(newSnapshotId, supersededIds, {
          agent,
          rationale: options.rationale,
          ...(options.note ? { note: options.note } : {}),
        });
      }
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject: snapshot body remains unchanged (AC1)
      await this._store.reject(snapshotId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult(
      "knowledge.consolidate",
      "apply-gate",
      {
        snapshot_id: snapshotId,
        proposer_id: proposerId,
        decision,
        source_ids: cluster,
        new_snapshot_id: newSnapshotId,
        superseded_ids: supersededIds,
      }
    );
    events.push(applyGateOut);

    return {
      snapshotId,
      proposerId,
      cluster,
      decision,
      newSnapshotId,
      supersededIds,
      telemetryEvents: events,
    };
  }

  // -------------------------------------------------------------------------
  // close-proposal primitive  (#106)
  //
  // A flow that gates a change through propose→apply mints a transient proposal
  // *artifact* record (the proposer) solely to carry the "proposes" link + the
  // proposal text. Once the proposal is APPLIED, that artifact is spent — it
  // should not linger as an `active` record. Left active it shows up in
  // working-set queries and hygiene sweeps, and re-retiring it spawns a
  // double-prefixed "Retirement proposal: Retirement proposal: …" twin (#106).
  //
  // This closes a spent proposal artifact by retiring it via the store's
  // existing `retire` op — no parallel mechanism. It is:
  //   - safe:        only touches the named artifact; never the apply target.
  //   - idempotent:  a no-op if the artifact is already retired/implemented.
  //   - non-fatal:   a close failure never fails the (already-applied) flow.
  // -------------------------------------------------------------------------

  /**
   * Auto-retire a spent proposal artifact after its proposal has been applied.
   *
   * @param {string} artifactId  - ID of the transient proposer record to close.
   * @param {object} [opts]
   *   - agent: string   — agent recording the close (defaults to runner agent)
   *   - rationale: string — close rationale (mutation-log evidence)
   * @returns {Promise<{ closed: boolean, reason?: string }>}
   */
  async _closeProposalArtifact(artifactId, opts = {}) {
    const agent = opts.agent || this._agent;
    const artifact = await this._store.get(artifactId);
    // Already gone or already closed — nothing to do (idempotent).
    if (!artifact) return { closed: false, reason: "artifact not found" };
    if ((artifact.status || "active") === "retired") {
      return { closed: false, reason: "already retired" };
    }
    try {
      await this._store.retire(artifactId, "retired", {
        agent,
        rationale:
          opts.rationale ||
          "Auto-closing spent proposal artifact after the proposal was applied (#106).",
      });
      return { closed: true };
    } catch (err) {
      // The proposal was already applied successfully; a failure to tidy up the
      // artifact must not fail the flow. Surface it on the result instead.
      return { closed: false, reason: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // knowledge.retire flow  (Addendum B — S7)
  //   Steps: identify → propose-retirement → evidence-gate → apply-or-reject → done
  //   Gate: evidence-gate — proposal carries rationale/ref; no direct mutation (AC1).
  //         apply-gate    — apply or reject via store retire op.
  //                         rejection leaves record status byte-identical (AC2).
  //
  // Machinery reuse: retire shares the same propose→evidence-gate→apply-or-reject
  // pattern as synthesize/consolidate. The store's retire op enforces the transition
  // table; rejection leaves the record unchanged.
  // -------------------------------------------------------------------------

  /**
   * Execute the retire flow: identify the target record, create a retirement
   * proposal (never a direct mutation), gate the evidence, then apply or reject.
   *
   * On apply:
   *   The store retire op updates the record status to targetStatus and appends
   *   a mutation log entry with the full evidence. The record is excluded from
   *   default working-set queries (listByType, listByCategory, similarity
   *   detection) unless includeRetired is true.
   *
   * On reject:
   *   The record status is byte-identical to its pre-proposal state.
   *
   * @param {string} recordId
   *   ID of the record to retire.
   * @param {object} [options]
   *   - targetStatus: "implemented"|"retired"  — target status (required)
   *   - rationale: string                      — why retiring (required)
   *   - implementedByRef: string               — ref when targetStatus="implemented" (required)
   *   - supersededByRef: string                — optional ref to superseding artifact
   *   - decision: "apply"|"reject"             — gate decision (default "apply")
   *   - rejectReason: string                   — reason for rejection (required when decision="reject")
   *   - agent: string                          — override agent name
   *   - session_id: string                     — session id
   *   - note: string                           — provenance note
   * @returns {Promise<{
   *   recordId: string,
   *   targetStatus: string,
   *   decision: "apply"|"reject",
   *   previousStatus: string,
   *   proposerId: string,
   *   telemetryEvents: object[]
   * }>}
   */
  async retire(recordId, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // ── Step: identify ─────────────────────────────────────────────────────
    if (!recordId || typeof recordId !== "string") {
      throw missingEvidenceError("retire: recordId must be a non-empty string");
    }

    const targetStatus = options.targetStatus;
    if (targetStatus !== "implemented" && targetStatus !== "retired") {
      throw missingEvidenceError(
        'retire: options.targetStatus must be "implemented" or "retired"'
      );
    }

    if (!options.rationale || !options.rationale.trim()) {
      throw missingEvidenceError("retire: options.rationale is required");
    }

    if (targetStatus === "implemented" && (!options.implementedByRef || !options.implementedByRef.trim())) {
      throw missingEvidenceError(
        'retire: options.implementedByRef is required when targetStatus is "implemented"'
      );
    }

    const record = await this._store.get(recordId);
    if (!record) {
      throw missingEvidenceError(`retire: record not found: ${recordId}`);
    }

    const previousStatus = record.status || "active";

    // Validate transition early (surface errors at identify-gate, not at apply-gate)
    const VALID_TRANSITIONS = {
      active:      new Set(["implemented", "retired"]),
      implemented: new Set(["retired"]),
      retired:     new Set(),
    };
    const allowed = VALID_TRANSITIONS[previousStatus] || new Set();
    if (!allowed.has(targetStatus)) {
      throw missingEvidenceError(
        `retire: invalid transition from "${previousStatus}" to "${targetStatus}"`
      );
    }

    // Emit identify gate entry
    const identifyGateIn = this._telemetry.emitGate("knowledge.retire", "identify-gate", {
      flow: "knowledge.retire",
      gate: "identify-gate",
      record_id: recordId,
      record_type: record.type,
      current_status: previousStatus,
      target_status: targetStatus,
    });
    events.push(identifyGateIn);

    const identifyGateOut = this._telemetry.emitGateResult("knowledge.retire", "identify-gate", {
      record_id: recordId,
      record_type: record.type,
      current_status: previousStatus,
      target_status: targetStatus,
      transition_valid: true,
    });
    events.push(identifyGateOut);

    // ── Step: propose-retirement ───────────────────────────────────────────
    // We reuse the store's propose op against the record itself.
    // The record acts as the "concept" target; a transient proposer raw record
    // carries the retirement proposal and proposes link.

    const proposeGateIn = this._telemetry.emitGate(
      "knowledge.retire",
      "propose-retirement-gate",
      {
        flow: "knowledge.retire",
        gate: "propose-retirement-gate",
        record_id: recordId,
        target_status: targetStatus,
        rationale: options.rationale,
      }
    );
    events.push(proposeGateIn);

    // Create a transient proposer record to hold the retirement proposal
    const proposerBody =
      `Retirement proposal for record ${recordId}.
` +
      `Target status: ${targetStatus}
` +
      `Rationale: ${options.rationale}
` +
      (options.implementedByRef ? `Implemented-by: ${options.implementedByRef}
` : "") +
      (options.supersededByRef ? `Superseded-by: ${options.supersededByRef}
` : "");

    const proposerId = await this._store.create({
      type: "raw",
      title: `Retirement proposal: ${record.title}`,
      body: proposerBody,
      category: record.category,
      provenance: {
        agent,
        note: `Retirement proposal for ${recordId}`,
        ...(options.session_id ? { session_id: options.session_id } : {}),
      },
    });

    // Attach the proposal via the store's propose op (not direct mutation — AC1)
    await this._store.propose(recordId, proposerId, {
      agent,
      proposal: options.rationale,
      ...(options.note ? { note: options.note } : {}),
    });

    const proposeGateOut = this._telemetry.emitGateResult(
      "knowledge.retire",
      "propose-retirement-gate",
      {
        record_id: recordId,
        proposer_id: proposerId,
        target_status: targetStatus,
        proposal_recorded: true,
      }
    );
    events.push(proposeGateOut);

    // ── Step: evidence-gate ────────────────────────────────────────────────
    // Verify the proposal carries required evidence and the transition is valid.

    const evidenceGateIn = this._telemetry.emitGate("knowledge.retire", "evidence-gate", {
      flow: "knowledge.retire",
      gate: "evidence-gate",
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
    });
    events.push(evidenceGateIn);

    // Enforce: proposer must have a "proposes" link to the record
    const { forward } = await this._store.getLinks(proposerId);
    const hasProposesLink = forward.some(
      (l) => l.target_id === recordId && l.kind === "proposes"
    );
    if (!hasProposesLink) {
      throw missingEvidenceError(
        `evidence-gate: proposer ${proposerId} must have a "proposes" link to record ${recordId}`
      );
    }

    // Enforce: target record still exists
    const targetRecord = await this._store.get(recordId);
    if (!targetRecord) {
      throw missingEvidenceError(
        `evidence-gate: target record ${recordId} does not exist`
      );
    }

    const evidenceGateOut = this._telemetry.emitGateResult("knowledge.retire", "evidence-gate", {
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      proposes_link_verified: true,
      target_record_verified: true,
    });
    events.push(evidenceGateOut);

    // ── Step: apply-or-reject ──────────────────────────────────────────────
    const decision = options.decision || "apply";

    const applyGateIn = this._telemetry.emitGate("knowledge.retire", "apply-gate", {
      flow: "knowledge.retire",
      gate: "apply-gate",
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      decision,
    });
    events.push(applyGateIn);

    let proposalClosed = false;
    if (decision === "apply") {
      // Apply via store retire op — transitions status, appends mutation log (AC1)
      await this._store.retire(recordId, targetStatus, {
        agent,
        rationale: options.rationale,
        ...(options.implementedByRef ? { implementedByRef: options.implementedByRef } : {}),
        ...(options.supersededByRef ? { supersededByRef: options.supersededByRef } : {}),
        ...(options.note ? { note: options.note } : {}),
      });
      // Close the spent retirement-proposal artifact so it does not linger as an
      // active record (which would spawn a double-prefixed twin on re-retire). #106
      const closeResult = await this._closeProposalArtifact(proposerId, {
        agent,
        rationale: `Auto-closing retirement-proposal artifact after retiring ${recordId} (#106).`,
      });
      proposalClosed = closeResult.closed;
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw missingEvidenceError(
          "apply-gate: options.rejectReason is required when decision=reject"
        );
      }
      // Reject via store reject op — record status remains untouched (AC2)
      await this._store.reject(recordId, proposerId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw missingEvidenceError(
        `apply-gate: decision must be "apply" or "reject"; got: ${decision}`
      );
    }

    const applyGateOut = this._telemetry.emitGateResult("knowledge.retire", "apply-gate", {
      record_id: recordId,
      proposer_id: proposerId,
      target_status: targetStatus,
      decision,
      previous_status: previousStatus,
    });
    events.push(applyGateOut);

    return {
      recordId,
      targetStatus,
      decision,
      previousStatus,
      proposerId,
      proposalClosed,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.check-inbound-references flow  (#340)
  //   Steps: scan-gate → resolve-gate → done
  //   Gate: resolve-gate — every DEFINITE doc→store citation resolves via the
  //         #339 identity path. Any unresolvable definite citation flips ok to
  //         false (fail closed) and is reported with doc path + line/column +
  //         token. Bare hex candidates are included only when they resolve
  //         (commit-SHA safety), never contributing a failure.
  //
  // READ-ONLY: reads doc files + the store's query surface only; mutates no
  // record and appends no mutation-log entry (same invariant as the Addenda D–G
  // audits). OPT-IN: zero configured globs is a no-op pass.
  // -------------------------------------------------------------------------

  /**
   * Scan caller-configured doc globs for record citations and resolve each
   * against the store, failing closed on any unresolvable definite citation.
   *
   * Citation forms (see the module header + store-contract.md Addendum I):
   *   - full UUID (bare or wrapped)            → definite; miss FAILS
   *   - `<marker>token` (default `rec:`/`record:`) → definite; miss FAILS
   *   - `[[token]]` wikilink                   → definite; miss FAILS
   *   - bare ≥8-hex short-id                    → candidate; included only if it
   *     currently resolves (a non-resolving bare hex is treated as prose/commit
   *     SHA and ignored — the documented miss).
   *
   * @param {object} [options]
   *   - docGlobs: string[]   — globs (relative to docsRoot) to scan; [] = no-op pass
   *   - docsRoot: string     — root the globs resolve against (default: workspace, then cwd)
   *   - markers: string[]    — citation marker prefixes (default DEFAULT_CITATION_MARKERS)
   *   - agent: string        — override agent name
   * @returns {Promise<{
   *   ok: boolean,
   *   scanned: string[],
   *   citations: Array<{ doc:string, line:number, column:number, token:string, form:string, resolved:boolean, recordId:string|null, reason?:string }>,
   *   unresolved: Array<{ doc:string, line:number, column:number, token:string, form:string, reason:string }>,
   *   byDoc: Record<string, Array<{ token:string, form:string, resolved:boolean, recordId:string|null, line:number, column:number }>>,
   *   byRecord: Record<string, Array<{ doc:string, line:number, column:number, token:string, form:string }>>,
   *   telemetryEvents: object[]
   * }>}
   */
  async checkInboundReferences(options = {}) {
    const events = [];
    const docGlobs = Array.isArray(options.docGlobs) ? options.docGlobs : [];
    const docsRoot = path.resolve(options.docsRoot || options.workspace || process.cwd());
    const markers = Array.isArray(options.markers) && options.markers.length
      ? options.markers
      : DEFAULT_CITATION_MARKERS;

    // ── Step: scan-gate ────────────────────────────────────────────────────
    const scanGateIn = this._telemetry.emitGate(
      "knowledge.check-inbound-references",
      "scan-gate",
      {
        flow: "knowledge.check-inbound-references",
        gate: "scan-gate",
        docs_root: docsRoot,
        doc_globs: docGlobs,
        markers,
      }
    );
    events.push(scanGateIn);

    // OPT-IN no-op: no globs configured → nothing to check (consistent with the
    // Addenda D–G opt-in convention). Returns an empty, PASSING index — never an
    // empty success that masks an unconfigured gate for a definite citation.
    if (docGlobs.length === 0) {
      const scanGateOutEmpty = this._telemetry.emitGateResult(
        "knowledge.check-inbound-references",
        "scan-gate",
        { scanned: 0, opt_out: true }
      );
      events.push(scanGateOutEmpty);
      return {
        ok: true,
        scanned: [],
        citations: [],
        unresolved: [],
        byDoc: {},
        byRecord: {},
        telemetryEvents: events,
      };
    }

    const scanned = collectDocs(docsRoot, docGlobs);

    // Extract every candidate citation from every scanned doc.
    const rawCitations = [];
    for (const doc of scanned) {
      const text = fs.readFileSync(path.join(docsRoot, doc), "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        for (const c of extractLineCitations(lines[i], i + 1, markers)) {
          rawCitations.push({ doc, ...c });
        }
      }
    }

    const scanGateOut = this._telemetry.emitGateResult(
      "knowledge.check-inbound-references",
      "scan-gate",
      { scanned: scanned.length, candidates: rawCitations.length }
    );
    events.push(scanGateOut);

    // ── Step: resolve-gate ─────────────────────────────────────────────────
    const resolveGateIn = this._telemetry.emitGate(
      "knowledge.check-inbound-references",
      "resolve-gate",
      {
        flow: "knowledge.check-inbound-references",
        gate: "resolve-gate",
        candidates: rawCitations.length,
      }
    );
    events.push(resolveGateIn);

    const citations = [];
    const unresolved = [];
    const byDoc = {};
    const byRecord = {};

    for (const c of rawCitations) {
      const { resolved, recordId, reason, matches } = await resolveCitation(this._store, c.token);

      // A bare candidate that does NOT resolve is prose / a commit SHA — drop it
      // entirely (never indexed, never failed). Every other case is recorded.
      if (c.form === "bare" && !resolved) continue;

      const entry = {
        doc: c.doc,
        line: c.line,
        column: c.column,
        token: c.token,
        form: c.form,
        resolved,
        recordId,
        ...(reason ? { reason } : {}),
        ...(matches ? { matches } : {}),
      };
      citations.push(entry);

      (byDoc[c.doc] ||= []).push({
        token: c.token,
        form: c.form,
        resolved,
        recordId,
        line: c.line,
        column: c.column,
      });

      if (resolved) {
        (byRecord[recordId] ||= []).push({
          doc: c.doc,
          line: c.line,
          column: c.column,
          token: c.token,
          form: c.form,
        });
      } else {
        // Definite citation (uuid/marker/wikilink) that does not resolve → FAIL.
        unresolved.push({
          doc: c.doc,
          line: c.line,
          column: c.column,
          token: c.token,
          form: c.form,
          reason: reason || "not-found",
          ...(matches ? { matches } : {}),
        });
      }
    }

    // Ensure every scanned doc appears in byDoc even when it cites nothing, so a
    // downstream consumer can distinguish "scanned, no citations" from "not scanned".
    for (const doc of scanned) byDoc[doc] ||= [];

    const ok = unresolved.length === 0;

    const resolveGateOut = this._telemetry.emitGateResult(
      "knowledge.check-inbound-references",
      "resolve-gate",
      {
        ok,
        citations: citations.length,
        resolved: citations.length - unresolved.length,
        unresolved: unresolved.length,
      }
    );
    events.push(resolveGateOut);

    return { ok, scanned, citations, unresolved, byDoc, byRecord, telemetryEvents: events };
  }


  // -------------------------------------------------------------------------
  // knowledge.flag-superseded-citers flow  (supersede/retire propagation — #342)
  //   Steps: collect-gate → flag-gate → done
  //   Gate: flag-gate — every flag carries the superseding context that produced
  //         it (the superseding record id(s) from the supersede op, and/or the
  //         retire supersededByRef). A flag can NEVER be emitted without this
  //         evidence: when a record shows no supersession evidence, zero flags
  //         are emitted (fail closed — the "no false flags" guarantee).
  //
  // READ-ONLY: reads the store's query surface (get / getLinks) and — when doc
  // globs are configured — the #340 inbound-reference citation index. Mutates no
  // record and appends no mutation-log entry (same invariant as the Addenda D–G
  // audits and the #340 check). The existing gated `supersede` (Addendum A.5) and
  // `retire` (Addendum B.4) ops are untouched: this forks no mutation path.
  //
  // Motivation (field report, ops record 0e439c57): a decision record became
  // unresolvable after a store restructure and NOTHING flagged the four docs
  // citing it — they kept presenting dead authority for weeks. Supersession
  // preserves the record (supersede-not-delete) and makes store-internal citers
  // discoverable via reverse links, but doc citers stayed invisible. This
  // operation closes that loop: on a superseded/retired record it enumerates
  // first-degree inbound citers — store records (reverse-link index, §5) AND docs
  // (the #340 citation index) — and emits one supersession-aware flag per citer.
  // -------------------------------------------------------------------------

  /**
   * Enumerate first-degree inbound citers of a superseded / retired record and
   * emit one flag per citer, each carrying the superseding context. Read-only.
   *
   * Supersession evidence (the flag-gate requires at least one):
   *   - `supersede` op (Addendum A.5): a reverse link of kind `"supersedes"` from
   *     the superseding record, mirrored by a `"superseded-by"` mutation-log entry
   *     (`new_id`). Both are consulted; the union is `supersededByIds`.
   *   - `retire` op with `supersededByRef` (Addendum B.4): a `"retire"` mutation-log
   *     entry whose `evidence.supersededByRef` names the superseding artifact.
   *
   * Citer enumeration (first-degree only — no citers-of-citers):
   *   - store records: `getLinks(id).reverse`, EXCLUDING the `"supersedes"` link and
   *     any link from a superseding record itself (the new authority is not a stale
   *     citer). Every other inbound link is a citer, tagged with its `linkKind`.
   *   - docs: `checkInboundReferences({ docGlobs, ... }).byRecord[id]` when doc globs
   *     are configured (opt-in; zero globs = store citers only). The superseded
   *     record is preserved (supersede-not-delete), so its citations still resolve.
   *
   * Flag-gating: flags are emitted ONLY when supersession evidence exists. A
   * record with no such evidence yields `superseded:false` and an empty flag list
   * (no false flags); a superseded record with no citers likewise yields an empty
   * flag list. The enumerated citer counts (`storeCiters` / `docCiters`) are
   * always reported so a caller can see the inbound edges independent of gating.
   *
   * @param {string} recordId  Id (or #339 prefix/slug handle) of the record.
   * @param {object} [options]
   *   - docGlobs: string[]   — globs to scan for doc citers (opt-in; [] = store citers only)
   *   - docsRoot: string     — root the globs resolve against (default: workspace, then cwd)
   *   - markers: string[]    — citation marker prefixes (default DEFAULT_CITATION_MARKERS)
   *   - agent: string        — override agent name
   * @returns {Promise<{
   *   recordId: string,
   *   superseded: boolean,
   *   supersededByIds: string[],
   *   supersededByRef: string|null,
   *   retiredStatus: string|null,
   *   storeCiters: number,
   *   docCiters: number,
   *   flags: Array<{
   *     citerRef: string, citerKind: "record"|"doc", citedId: string,
   *     supersededByIds: string[], supersededByRef: string|null,
   *     linkKind?: string,
   *     doc?: string, line?: number, column?: number, token?: string, form?: string
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async flagSupersededCiters(recordId, options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    if (!recordId || typeof recordId !== "string") {
      throw missingEvidenceError(
        "flag-superseded-citers: recordId must be a non-empty string"
      );
    }

    const record = await this._store.get(recordId);
    if (!record) {
      throw missingEvidenceError(`flag-superseded-citers: record not found: ${recordId}`);
    }
    const citedId = record.id;
    const docGlobs = Array.isArray(options.docGlobs) ? options.docGlobs : [];

    // ── Step: collect-gate ─────────────────────────────────────────────────
    const collectGateIn = this._telemetry.emitGate(
      "knowledge.flag-superseded-citers",
      "collect-gate",
      {
        flow: "knowledge.flag-superseded-citers",
        gate: "collect-gate",
        record_id: citedId,
        doc_globs: docGlobs,
      }
    );
    events.push(collectGateIn);

    // Superseding context — the evidence every flag must carry.
    const links = await this._store.getLinks(citedId);
    const reverse = Array.isArray(links.reverse) ? links.reverse : [];

    const supersededByIds = [
      ...new Set(
        reverse
          .filter((l) => l.kind === "supersedes")
          .map((l) => l.source_id)
          .filter(Boolean)
      ),
    ];
    // The mutation log independently records the superseding record(s); fold in
    // any not already surfaced by the reverse index (belt-and-suspenders).
    for (const e of record.mutation_log || []) {
      if (e.op === "superseded-by" && e.new_id && !supersededByIds.includes(e.new_id)) {
        supersededByIds.push(e.new_id);
      }
    }

    // retire(…, { supersededByRef }) — Addendum B.4.
    let supersededByRef = null;
    for (const e of record.mutation_log || []) {
      if (e.op === "retire" && e.evidence && e.evidence.supersededByRef) {
        supersededByRef = e.evidence.supersededByRef;
      }
    }
    const retiredStatus = (record.status || "active") === "retired" ? "retired" : null;

    const superseded = supersededByIds.length > 0 || Boolean(supersededByRef);

    // Store-record citers: inbound links minus the supersession relationship
    // itself and any link originating from a superseding record (the replacement
    // authority is not a silent dead citer).
    const storeCiterLinks = reverse.filter(
      (l) => l.kind !== "supersedes" && !supersededByIds.includes(l.source_id)
    );

    // Doc citers: the #340 citation index, keyed by the record's full id. Opt-in.
    let docCiterEntries = [];
    if (docGlobs.length > 0) {
      const inbound = await this.checkInboundReferences({
        docGlobs,
        docsRoot: options.docsRoot,
        markers: options.markers,
        agent,
      });
      // Fold the inbound-check gate telemetry into this flow's event trail.
      if (Array.isArray(inbound.telemetryEvents)) {
        for (const ev of inbound.telemetryEvents) events.push(ev);
      }
      docCiterEntries = inbound.byRecord[citedId] || [];
    }

    const collectGateOut = this._telemetry.emitGateResult(
      "knowledge.flag-superseded-citers",
      "collect-gate",
      {
        record_id: citedId,
        superseded,
        superseded_by_count: supersededByIds.length,
        superseded_by_ref: Boolean(supersededByRef),
        store_citers: storeCiterLinks.length,
        doc_citers: docCiterEntries.length,
      }
    );
    events.push(collectGateOut);

    // ── Step: flag-gate ────────────────────────────────────────────────────
    const flagGateIn = this._telemetry.emitGate(
      "knowledge.flag-superseded-citers",
      "flag-gate",
      {
        flow: "knowledge.flag-superseded-citers",
        gate: "flag-gate",
        record_id: citedId,
        superseded,
        candidate_citers: storeCiterLinks.length + docCiterEntries.length,
      }
    );
    events.push(flagGateIn);

    const flags = [];
    if (superseded) {
      const context = { supersededByIds, supersededByRef };
      for (const l of storeCiterLinks) {
        flags.push({
          citerRef: l.source_id,
          citerKind: "record",
          linkKind: l.kind,
          citedId,
          ...context,
        });
      }
      for (const d of docCiterEntries) {
        flags.push({
          citerRef: `${d.doc}:${d.line}:${d.column}`,
          citerKind: "doc",
          doc: d.doc,
          line: d.line,
          column: d.column,
          token: d.token,
          form: d.form,
          citedId,
          ...context,
        });
      }
      // Evidence guarantee (defensive): the flag-gate refuses any flag that does
      // not carry superseding context. `superseded` already implies context, so
      // this can only fire on a future regression — fail closed if it ever does.
      for (const f of flags) {
        if (f.supersededByIds.length === 0 && !f.supersededByRef) {
          throw missingEvidenceError(
            "flag-superseded-citers: refusing to emit a flag without superseding context"
          );
        }
      }
    }

    const flagGateOut = this._telemetry.emitGateResult(
      "knowledge.flag-superseded-citers",
      "flag-gate",
      {
        record_id: citedId,
        superseded,
        flagged: flags.length,
        agent,
      }
    );
    events.push(flagGateOut);

    return {
      recordId: citedId,
      superseded,
      supersededByIds,
      supersededByRef,
      retiredStatus,
      storeCiters: storeCiterLinks.length,
      docCiters: docCiterEntries.length,
      flags,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.audit-freshness flow  (hygiene #1 — #106)
  //   Steps: collect → measure → flag-gate → done
  //   Gate: flag-gate — every flag cites its evidence (last-mutation + the
  //         threshold that fired). No flag is emitted without both.
  //
  // This is a READ-ONLY audit. It NEVER mutates a record. It surveys the
  // working set, measures each record's age against a per-category staleness
  // threshold, and returns flags proposing an action (archive / refresh). The
  // operator routes each flag through the existing gated flows (knowledge.retire
  // to archive; a fresh capture/compile to refresh) — the audit forks no new
  // mutation path. Staleness is domain-sensitive (radar ≠ decisions), so the
  // thresholds are OPTIONAL and CONFIGURABLE per category; a category with no
  // threshold (and no default) is simply not audited (opt-in).
  // -------------------------------------------------------------------------

  /**
   * Audit the working set for records past their per-category staleness
   * threshold and propose archive/refresh for each. Read-only: mutates nothing.
   *
   * Threshold resolution is dot-hierarchy longest-prefix: a record in
   * `radar.signals.weak` matches a `radar.signals` threshold before a `radar`
   * one, falling back to `defaultThresholdDays` if neither is configured. A
   * category that resolves to no threshold is skipped (opt-in auditing).
   *
   * "Last mutation" is the most recent of the record's `updated_at` and the
   * latest `mutation_log` entry `at` — both are refreshed by every mutating op
   * (store contract §1.1 / §4.2), so the later of the two is authoritative even
   * if an adapter lags one.
   *
   * @param {object} [options]
   *   - thresholds: { [category: string]: number }  — per-category staleness in days
   *   - defaultThresholdDays: number                — fallback for unmatched categories (default: none → skip)
   *   - actions: { [category: string]: "archive"|"refresh" } — per-category proposed action override
   *   - defaultAction: "archive"|"refresh"          — fallback proposed action (default "refresh")
   *   - types: string[]                             — record types to audit (default ["raw","compiled","concept","snapshot"])
   *   - now: string|number|Date                     — reference "now" for age (default: current time; injectable for tests)
   *   - agent: string                               — override agent name
   * @returns {Promise<{
   *   audited: number,
   *   skipped: number,
   *   flags: Array<{
   *     recordId: string, title: string, type: string, category: string,
   *     status: string, lastMutationAt: string, ageDays: number,
   *     thresholdDays: number, matchedThresholdKey: string,
   *     proposedAction: "archive"|"refresh"
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async auditFreshness(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    const thresholds = options.thresholds || {};
    const defaultThresholdDays =
      typeof options.defaultThresholdDays === "number"
        ? options.defaultThresholdDays
        : null;
    const actions = options.actions || {};
    const defaultAction = options.defaultAction || "refresh";
    if (defaultAction !== "archive" && defaultAction !== "refresh") {
      throw missingEvidenceError(
        `audit-freshness: defaultAction must be "archive" or "refresh"; got: ${defaultAction}`
      );
    }
    const types = Array.isArray(options.types) && options.types.length
      ? options.types
      : ["raw", "compiled", "concept", "snapshot"];

    const nowMs = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
    if (Number.isNaN(nowMs)) {
      throw missingEvidenceError(`audit-freshness: invalid "now" reference: ${options.now}`);
    }

    // ── Step: collect ──────────────────────────────────────────────────────
    // Gather the working set (default queries already exclude retired records —
    // retired is terminal, so there is nothing to flag there).
    const collectGateIn = this._telemetry.emitGate("knowledge.audit-freshness", "collect-gate", {
      flow: "knowledge.audit-freshness",
      gate: "collect-gate",
      types,
      threshold_categories: Object.keys(thresholds),
      default_threshold_days: defaultThresholdDays,
    });
    events.push(collectGateIn);

    const seen = new Set();
    const records = [];
    for (const type of types) {
      const recs = await this._store.listByType(type);
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
      }
    }

    const collectGateOut = this._telemetry.emitGateResult("knowledge.audit-freshness", "collect-gate", {
      collected: records.length,
    });
    events.push(collectGateOut);

    // ── Step: measure + flag-gate ──────────────────────────────────────────
    const flagGateIn = this._telemetry.emitGate("knowledge.audit-freshness", "flag-gate", {
      flow: "knowledge.audit-freshness",
      gate: "flag-gate",
      collected: records.length,
    });
    events.push(flagGateIn);

    const flags = [];
    let skipped = 0;
    let audited = 0;

    for (const record of records) {
      const resolved = resolveThreshold(record.category, thresholds, defaultThresholdDays);
      if (resolved === null) {
        // No threshold configured for this category (and no default) → opt out.
        skipped += 1;
        continue;
      }
      audited += 1;

      const lastMutationAt = lastMutationOf(record);
      const lastMs = new Date(lastMutationAt).getTime();
      // ageDays floored to whole days; an unparseable timestamp is treated as 0.
      const ageDays = Number.isNaN(lastMs)
        ? 0
        : Math.floor((nowMs - lastMs) / 86_400_000);

      // Flag only when STRICTLY past the threshold. Evidence (last-mutation +
      // the threshold key/value that fired) is carried on every flag — the
      // flag-gate requires both, so a flag can never be emitted without them.
      if (ageDays > resolved.thresholdDays) {
        const proposedAction =
          resolveAction(record.category, actions, defaultAction);
        flags.push({
          recordId: record.id,
          title: record.title,
          type: record.type,
          category: record.category,
          status: record.status || "active",
          lastMutationAt,
          ageDays,
          thresholdDays: resolved.thresholdDays,
          matchedThresholdKey: resolved.matchedKey,
          proposedAction,
        });
      }
    }

    const flagGateOut = this._telemetry.emitGateResult("knowledge.audit-freshness", "flag-gate", {
      audited,
      skipped,
      flagged: flags.length,
      agent,
    });
    events.push(flagGateOut);

    return { audited, skipped, flags, telemetryEvents: events };
  }


  // -------------------------------------------------------------------------
  // knowledge.glossary-sync flow  (hygiene #3 — #106)
  //   Steps: collect → extract → diff-gate → propose-gate → done
  //   Gate: diff-gate    — every entry is classified (gap / outdated / current)
  //                        and cites its evidence: the canonical source doc,
  //                        the extracted term + definition, and (for outdated)
  //                        the existing concept's drifted body. No entry is
  //                        emitted without the source it came from.
  //         propose-gate — when apply mode is on, every gap/outdated entry is
  //                        routed through the EXISTING concept-record
  //                        propose→apply ops (create → propose → apply), with
  //                        the canonical doc as the proposer (it is the
  //                        evidence). Forks no mutation path.
  //
  // Keeps the glossary (the working set of `concept` records) in sync with the
  // canonical docs that DEFINE those terms. The Kit can file concepts but had no
  // way to (a) promote a term that a canonical doc defines but no concept yet
  // captures (a GAP), or (b) notice when a concept's definition has DRIFTED from
  // its canonical source (OUT-OF-DATE). This flow surveys a CONFIGURABLE list of
  // canonical source docs (the "glossary source list" — opt-in; empty list does
  // nothing), extracts their term→definition entries with a PLUGGABLE extractor,
  // diffs them against existing concept records, and surfaces a plan.
  //
  // Read-only by DEFAULT (returns the classification + a proposal plan, mutating
  // nothing). With `apply: true` it consumes the existing store ops to enact the
  // plan — never a forked mutation path:
  //   - gap      → store.create(concept) then propose+apply from the source doc
  //   - outdated → store.propose + store.apply on the existing concept
  //   - current  → no-op
  // -------------------------------------------------------------------------

  /**
   * Sync the glossary (concept records) against a configurable list of canonical
   * source docs. Read-only by default; `apply: true` enacts the plan via the
   * existing concept-record propose→apply ops (consume-never-fork).
   *
   * Each canonical doc is parsed into term→definition entries (pluggable
   * `termExtractor`); each entry is classified against the existing concepts:
   *   - "gap":      no concept captures the term  → propose a canonical definition
   *   - "outdated": a concept exists but its body has drifted from the canonical
   *                 definition → propose the update
   *   - "current":  the concept already matches the canonical definition → no-op
   *
   * Matching is by normalized term (case/space-insensitive) within the resolved
   * concept category. Drift is whitespace-insensitive: cosmetic reflow is not
   * flagged, substantive change is.
   *
   * @param {object} [options]
   *   - sources: Array<string | { category: string, prefix?: boolean }>
   *       The CONFIGURABLE glossary source list. Each entry is either a record id
   *       (a single canonical doc) or a category selector ({ category, prefix }).
   *       Empty/absent → nothing is synced (opt-in).
   *   - termExtractor: (doc) => Array<{ term, definition }>
   *       Pluggable extractor; default parses glossary-style lines (defaultTermExtractor).
   *   - conceptCategory: string
   *       Category for matched/proposed concepts. Default: the source doc's own category.
   *   - apply: boolean (default false)
   *       false → read-only (returns the plan). true → enact via store ops.
   *   - now / agent / session_id: passthrough provenance/telemetry.
   * @returns {Promise<{
   *   sourcesAudited: number,
   *   entries: number,
   *   gaps: GlossaryEntry[],
   *   outdated: GlossaryEntry[],
   *   current: GlossaryEntry[],
   *   applied: Array<{ term: string, conceptId: string, action: "create"|"update" }>,
   *   telemetryEvents: object[]
   * }>}
   *   where GlossaryEntry = { term, definition, sourceDocId, sourceDocTitle,
   *     category, classification, conceptId?: string, currentBody?: string }
   */
  async glossarySync(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const extractor =
      typeof options.termExtractor === "function"
        ? options.termExtractor
        : defaultTermExtractor;
    const applyMode = options.apply === true;

    // ── Step: collect ────────────────────────────────────────────────────────
    // Resolve the configurable glossary source list to concrete canonical docs.
    // A source is either a record id or a { category, prefix } selector. Missing
    // ids are surfaced as an error (the source list is evidence — a typo must not
    // pass silently). Auditing is opt-in: an empty list collects nothing.
    const collectGateIn = this._telemetry.emitGate("knowledge.glossary-sync", "collect-gate", {
      flow: "knowledge.glossary-sync",
      gate: "collect-gate",
      source_count: sources.length,
      apply: applyMode,
    });
    events.push(collectGateIn);

    const docs = [];
    const seenDocs = new Set();
    for (const source of sources) {
      let resolved = [];
      if (typeof source === "string") {
        const doc = await this._store.get(source);
        if (!doc) {
          throw missingEvidenceError(
            `glossary-sync: source doc not found: ${source}`
          );
        }
        resolved = [doc];
      } else if (source && typeof source === "object" && source.category) {
        resolved = await this._store.listByCategory(source.category, {
          prefix: source.prefix === true,
        });
      } else {
        throw missingEvidenceError(
          "glossary-sync: each source must be a record id or a { category } selector"
        );
      }
      for (const doc of resolved) {
        if (seenDocs.has(doc.id)) continue;
        seenDocs.add(doc.id);
        docs.push(doc);
      }
    }

    const collectGateOut = this._telemetry.emitGateResult("knowledge.glossary-sync", "collect-gate", {
      sources_resolved: docs.length,
    });
    events.push(collectGateOut);

    // ── Step: extract + diff-gate ────────────────────────────────────────────
    // Extract term→definition entries from each canonical doc and classify each
    // against the existing concept working set. Every classification cites the
    // source doc it came from — the diff-gate requires that evidence.
    const diffGateIn = this._telemetry.emitGate("knowledge.glossary-sync", "diff-gate", {
      flow: "knowledge.glossary-sync",
      gate: "diff-gate",
      sources_resolved: docs.length,
    });
    events.push(diffGateIn);

    const allConcepts = await this._store.listByType("concept");

    const gaps = [];
    const outdated = [];
    const current = [];
    let entryCount = 0;

    for (const doc of docs) {
      const extracted = extractor(doc) || [];
      for (const { term, definition } of extracted) {
        if (!term || !definition) continue;
        entryCount += 1;
        const category = options.conceptCategory || doc.category;
        const normTerm = normalizeTerm(term);
        // A concept "captures" the term when its normalized title matches the
        // term within the resolved category (concepts are the glossary).
        const match = allConcepts.find(
          (c) =>
            c.category === category && normalizeTerm(c.title) === normTerm
        );

        const base = {
          term,
          definition,
          sourceDocId: doc.id,
          sourceDocTitle: doc.title,
          category,
        };

        if (!match) {
          gaps.push({ ...base, classification: "gap" });
        } else if (!definitionsEquivalent(match.body, definition)) {
          outdated.push({
            ...base,
            classification: "outdated",
            conceptId: match.id,
            currentBody: match.body,
          });
        } else {
          current.push({
            ...base,
            classification: "current",
            conceptId: match.id,
          });
        }
      }
    }

    const diffGateOut = this._telemetry.emitGateResult("knowledge.glossary-sync", "diff-gate", {
      entries: entryCount,
      gaps: gaps.length,
      outdated: outdated.length,
      current: current.length,
    });
    events.push(diffGateOut);

    // ── Step: propose-gate ───────────────────────────────────────────────────
    // Read-only by default: return the plan, mutate nothing. With apply=true,
    // enact each gap/outdated entry through the EXISTING concept-record ops —
    // the canonical source doc is the proposer (it is the evidence for the
    // definition), so no new mutation path is forked.
    const proposeGateIn = this._telemetry.emitGate("knowledge.glossary-sync", "propose-gate", {
      flow: "knowledge.glossary-sync",
      gate: "propose-gate",
      apply: applyMode,
      gaps: gaps.length,
      outdated: outdated.length,
    });
    events.push(proposeGateIn);

    const applied = [];
    if (applyMode) {
      for (const entry of gaps) {
        // Create the concept (definition = canonical body), then record the
        // canonical doc's authorship through propose→apply so the lineage is the
        // same gated path every other concept mutation uses.
        const conceptId = await this._store.create({
          type: "concept",
          title: entry.term,
          body: entry.definition,
          category: entry.category,
          provenance: {
            agent,
            ...(options.session_id ? { session_id: options.session_id } : {}),
            source_ids: [entry.sourceDocId],
            note: `glossary-sync: canonical definition from ${entry.sourceDocId}`,
          },
        });
        await this._store.propose(conceptId, entry.sourceDocId, {
          agent,
          proposal: `Canonical definition for "${entry.term}" from ${entry.sourceDocTitle}.`,
        });
        await this._store.apply(conceptId, entry.sourceDocId, {
          agent,
          new_body: entry.definition,
          rationale: `glossary-sync: adopt canonical definition for "${entry.term}" from ${entry.sourceDocId}.`,
        });
        applied.push({ term: entry.term, conceptId, action: "create" });
      }
      for (const entry of outdated) {
        await this._store.propose(entry.conceptId, entry.sourceDocId, {
          agent,
          proposal: `Update "${entry.term}" to the canonical definition from ${entry.sourceDocTitle}.`,
        });
        await this._store.apply(entry.conceptId, entry.sourceDocId, {
          agent,
          new_body: entry.definition,
          rationale: `glossary-sync: refresh "${entry.term}" from canonical source ${entry.sourceDocId} (definition had drifted).`,
        });
        applied.push({ term: entry.term, conceptId: entry.conceptId, action: "update" });
      }
    }

    const proposeGateOut = this._telemetry.emitGateResult("knowledge.glossary-sync", "propose-gate", {
      applied: applied.length,
      apply: applyMode,
      agent,
    });
    events.push(proposeGateOut);

    return {
      sourcesAudited: docs.length,
      entries: entryCount,
      gaps,
      outdated,
      current,
      applied,
      telemetryEvents: events,
    };
  }


  // =========================================================================
  // knowledge.detect-contradictions flow  (#106 hygiene #2)
  //   Steps: collect → compare → flag-gate → done
  //   Gates: collect-gate (comparison set), flag-gate (flags cite both ids)
  // =========================================================================

  /**
   * Audit compiled records within a category for conflicting assertions and
   * flag each conflicting pair with BOTH record ids. Read-only: mutates nothing.
   *
   * Comparison is two-staged and reuses the existing pluggable adapters
   * (consume-never-fork):
   *   1. SCOPE with the similarity adapter — only records the detector deems
   *      similar (about the same thing) are candidates for contradiction. This
   *      reuses the exact SimilarityDetector interface that `synthesize` uses, so
   *      the vector similarity adapter drops straight in.
   *   2. JUDGE with the pluggable contradiction fn — for each similar pair, the
   *      ContradictionDetector decides whether the assertions conflict. The
   *      default (defaultContradictionDetector) is an opposing-polarity heuristic;
   *      callers inject a domain-specific fn (e.g. an NLI model) the same way.
   *
   * Which categories to audit is configurable and opt-in: a category is audited
   * only when it appears in `categories` (or `categories` is omitted, in which
   * case every category present in the collected compiled set is audited).
   * Retired records are never compared — the default `listByType` query excludes
   * them, and `retired` is terminal.
   *
   * @param {object} [options]
   *   - categories: string[]                  — categories to audit (default: all present). Opt-in scoping.
   *   - similarityDetector: fn                — pluggable detector (same interface as synthesize R3); default category/link heuristic
   *   - contradictionDetector: fn            — pluggable (recordA, recordB) => null | { reason } ; default opposing-polarity heuristic
   *   - agent: string                        — override agent name
   * @returns {Promise<{
   *   audited: number,
   *   compared: number,
   *   flags: Array<{
   *     recordIdA: string, recordIdB: string,
   *     titleA: string, titleB: string,
   *     category: string, reason: string
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async detectContradictions(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;
    const similarityDetector = options.similarityDetector || defaultSimilarityDetector;
    const contradictionDetector = options.contradictionDetector || defaultContradictionDetector;
    const categoryFilter =
      Array.isArray(options.categories) && options.categories.length
        ? new Set(options.categories)
        : null;

    // ── Step: collect ────────────────────────────────────────────────────────
    // Gather compiled records grouped by category (default query excludes
    // retired records — retired is terminal, nothing to compare there).
    const collectGateIn = this._telemetry.emitGate(
      "knowledge.detect-contradictions",
      "collect-gate",
      {
        flow: "knowledge.detect-contradictions",
        gate: "collect-gate",
        categories: categoryFilter ? [...categoryFilter] : "all",
      }
    );
    events.push(collectGateIn);

    const compiled = (await this._store.listByType("compiled")).filter(
      (r) => (r.status || "active") !== "retired"
    );

    const byCategory = new Map();
    for (const record of compiled) {
      if (categoryFilter && !categoryFilter.has(record.category)) continue;
      if (!byCategory.has(record.category)) byCategory.set(record.category, []);
      byCategory.get(record.category).push(record);
    }

    const collectGateOut = this._telemetry.emitGateResult(
      "knowledge.detect-contradictions",
      "collect-gate",
      {
        categories_audited: byCategory.size,
        collected: compiled.length,
      }
    );
    events.push(collectGateOut);

    // ── Step: compare + flag-gate ────────────────────────────────────────────
    const flagGateIn = this._telemetry.emitGate(
      "knowledge.detect-contradictions",
      "flag-gate",
      {
        flow: "knowledge.detect-contradictions",
        gate: "flag-gate",
        categories_audited: byCategory.size,
      }
    );
    events.push(flagGateIn);

    const flags = [];
    let audited = 0;
    let compared = 0;
    const seenPairs = new Set();

    for (const [category, records] of byCategory) {
      audited += records.length;
      for (const record of records) {
        // Stage 1: scope to similar records via the similarity adapter. The
        // candidate set is the rest of this category's records.
        const candidates = records.filter((r) => r.id !== record.id);
        const similarIds = await similarityDetector(record, candidates, this._store);
        const similarSet = new Set(similarIds);

        // Stage 2: judge each similar pair with the contradiction fn.
        for (const other of candidates) {
          if (!similarSet.has(other.id)) continue;
          // Compare each unordered pair exactly once.
          const pairKey =
            record.id < other.id ? `${record.id}|${other.id}` : `${other.id}|${record.id}`;
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          compared += 1;

          const verdict = await contradictionDetector(record, other, this._store);
          // A flag is emitted only with BOTH ids + a reason — the flag-gate
          // requires the evidence, so a flag can never be emitted without it.
          if (verdict && verdict.reason) {
            const [idA, idB, recA, recB] =
              record.id < other.id
                ? [record.id, other.id, record, other]
                : [other.id, record.id, other, record];
            flags.push({
              recordIdA: idA,
              recordIdB: idB,
              titleA: recA.title,
              titleB: recB.title,
              category,
              reason: verdict.reason,
            });
          }
        }
      }
    }

    const flagGateOut = this._telemetry.emitGateResult(
      "knowledge.detect-contradictions",
      "flag-gate",
      {
        audited,
        compared,
        flagged: flags.length,
        agent,
      }
    );
    events.push(flagGateOut);

    return { audited, compared, flags, telemetryEvents: events };
  }


  // -------------------------------------------------------------------------
  // knowledge.canonicalize-category flow  (hygiene #4 — #106)
  //   Steps: survey → assess → propose-gate → done
  //   Gate: propose-gate — every category-sprawl finding cites its evidence
  //         (the metric that fired + the offending category/record ids). No
  //         finding is emitted without it.
  //
  // This is a READ-ONLY audit. It NEVER mutates a record. It surveys the
  // category hierarchy of the working set and flags three kinds of sprawl the
  // dogfooding surfaced (#106):
  //   - orphan-prefix      — an intermediate prefix node that holds NO record
  //                          directly yet has descendants, OR a prefix whose
  //                          whole subtree is a single leaf record (a deep path
  //                          carrying one record adds depth without branching
  //                          value). Proposes flattening to the parent.
  //   - too-many-leaves    — a parent prefix with more direct child leaf
  //                          categories than the configured fan-out budget.
  //                          Proposes regrouping under fewer leaves.
  //   - implemented-active — a record still status:"active" but carrying an
  //                          operator-supplied "implemented" marker tag; it
  //                          should have transitioned via retire but lingers in
  //                          the working set. Proposes retire.
  //
  // Each finding PROPOSES (flatten / regroup / retire); the operator routes it
  // through the existing gated flows — knowledge.retire to retire, an `update`
  // (recategorize) to flatten/regroup. The audit forks no new mutation path.
  // Sprawl is domain-sensitive, so the checks are OPTIONAL and CONFIGURABLE: a
  // disabled check (or an empty marker list) simply contributes no findings.
  // -------------------------------------------------------------------------

  /**
   * Audit the category hierarchy of the working set for sprawl and propose
   * flattening / regrouping / retirement. Read-only: mutates nothing.
   *
   * Findings are of three kinds (each independently toggleable):
   *   - `"orphan-prefix"`: an intermediate prefix node carrying no record
   *     directly while it has descendants, or a prefix whose entire subtree is
   *     exactly one leaf record. `proposedAction: "flatten"`.
   *   - `"too-many-leaves"`: a parent prefix whose direct child leaf-category
   *     count exceeds `maxLeavesPerParent`. `proposedAction: "regroup"`.
   *   - `"implemented-active"`: a record still `status:"active"` carrying an
   *     `implementedMarkers` tag. `proposedAction: "retire"`.
   *
   * @param {object} [options]
   *   - maxLeavesPerParent: number   — fan-out budget; a parent with more direct
   *                                     child leaf categories is flagged. Omit /
   *                                     null to disable the leaf-count check.
   *   - implementedMarkers: string[] — tag markers that mean "implemented"
   *                                     (case-insensitive). Empty/omitted →
   *                                     the implemented-active check is disabled.
   *   - checkOrphanPrefixes: boolean — enable the orphan-prefix check (default true).
   *   - types: string[]              — record types to survey
   *                                     (default ["raw","compiled","concept","snapshot"]).
   *   - agent: string                — override agent name.
   * @returns {Promise<{
   *   surveyed: number,
   *   categories: number,
   *   findings: Array<{
   *     kind: "orphan-prefix"|"too-many-leaves"|"implemented-active",
   *     category: string,
   *     recordIds: string[],
   *     metric: string,
   *     evidence: object,
   *     proposedAction: "flatten"|"regroup"|"retire"
   *   }>,
   *   telemetryEvents: object[]
   * }>}
   */
  async canonicalizeCategory(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    const checkOrphanPrefixes = options.checkOrphanPrefixes !== false;
    const maxLeavesPerParent =
      typeof options.maxLeavesPerParent === "number"
        ? options.maxLeavesPerParent
        : null;
    if (maxLeavesPerParent !== null && maxLeavesPerParent < 1) {
      throw missingEvidenceError(
        `canonicalize-category: maxLeavesPerParent must be >= 1; got: ${maxLeavesPerParent}`
      );
    }
    const markerSet = new Set(
      (Array.isArray(options.implementedMarkers) ? options.implementedMarkers : [])
        .map((m) => String(m).toLowerCase())
    );
    const types = Array.isArray(options.types) && options.types.length
      ? options.types
      : ["raw", "compiled", "concept", "snapshot"];

    // ── Step: survey ───────────────────────────────────────────────────────
    // Gather the working set (default queries already exclude retired records —
    // retired is terminal, so it is not category sprawl to flatten).
    const surveyGateIn = this._telemetry.emitGate("knowledge.canonicalize-category", "survey-gate", {
      flow: "knowledge.canonicalize-category",
      gate: "survey-gate",
      types,
      check_orphan_prefixes: checkOrphanPrefixes,
      max_leaves_per_parent: maxLeavesPerParent,
      implemented_markers: [...markerSet],
    });
    events.push(surveyGateIn);

    const seen = new Set();
    const records = [];
    for (const type of types) {
      const recs = await this._store.listByType(type);
      for (const r of recs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
      }
    }

    // Build the category tree.
    //   directIds[prefix]   — ids of records whose category IS exactly prefix.
    //   subtreeIds[prefix]  — ids of records at prefix OR any descendant.
    //   childLeaves[parent] — direct child leaf categories (a leaf = a category
    //                         that is itself a record-bearing category with no
    //                         deeper record-bearing descendant).
    const directIds = new Map();
    const subtreeIds = new Map();
    const allCategories = new Set();
    for (const r of records) {
      const cat = r.category || "";
      if (!directIds.has(cat)) directIds.set(cat, []);
      directIds.get(cat).push(r.id);
      for (const prefix of categoryPrefixes(cat)) {
        allCategories.add(prefix);
        if (!subtreeIds.has(prefix)) subtreeIds.set(prefix, []);
        subtreeIds.get(prefix).push(r.id);
      }
    }

    const surveyGateOut = this._telemetry.emitGateResult("knowledge.canonicalize-category", "survey-gate", {
      surveyed: records.length,
      categories: allCategories.size,
    });
    events.push(surveyGateOut);

    // ── Step: assess + propose-gate ────────────────────────────────────────
    const proposeGateIn = this._telemetry.emitGate("knowledge.canonicalize-category", "propose-gate", {
      flow: "knowledge.canonicalize-category",
      gate: "propose-gate",
      surveyed: records.length,
      categories: allCategories.size,
    });
    events.push(proposeGateIn);

    const findings = [];

    // (1) orphan-prefix: an intermediate prefix node with no direct record but
    //     descendants, OR a prefix whose entire subtree is a single leaf record.
    if (checkOrphanPrefixes) {
      for (const prefix of allCategories) {
        const direct = directIds.get(prefix) || [];
        const subtree = subtreeIds.get(prefix) || [];
        const hasDescendantRecord = subtree.length > direct.length;
        // Only consider non-leaf (intermediate) prefixes for the "empty node"
        // case — a prefix that has descendants but holds nothing itself. When
        // the whole subtree is a SINGLE record, the deeper single-record-deep-path
        // finding (emitted at the record-bearing leaf) already covers the whole
        // chain — don't also report every empty ancestor of that lone record.
        if (direct.length === 0 && hasDescendantRecord && subtree.length > 1) {
          findings.push({
            kind: "orphan-prefix",
            category: prefix,
            recordIds: [...subtree],
            metric: "empty-intermediate-node",
            evidence: {
              directRecordCount: 0,
              subtreeRecordCount: subtree.length,
              parent: parentPrefix(prefix),
              reason:
                "Prefix holds no record directly; it only nests descendants. Flatten its subtree up to the parent.",
            },
            proposedAction: "flatten",
          });
        } else if (subtree.length === 1 && categoryPrefixes(prefix).length > 1) {
          // A deep path (>1 segment) whose whole subtree is one record adds
          // depth without branching value — flatten toward the parent. Only
          // report this at the deepest such prefix that still owns the record
          // directly (avoid double-reporting every ancestor of a lone record).
          if (direct.length === 1) {
            findings.push({
              kind: "orphan-prefix",
              category: prefix,
              recordIds: [...subtree],
              metric: "single-record-deep-path",
              evidence: {
                directRecordCount: 1,
                subtreeRecordCount: 1,
                depth: categoryPrefixes(prefix).length,
                parent: parentPrefix(prefix),
                reason:
                  "A multi-segment category carries exactly one record and no siblings in its subtree — depth without branching value. Consider flattening to the parent.",
              },
              proposedAction: "flatten",
            });
          }
        }
      }
    }

    // (2) too-many-leaves: a parent prefix whose direct child leaf-category
    //     count exceeds the fan-out budget. A "direct child leaf category" is a
    //     record-bearing category exactly one segment deeper than the parent
    //     with no record-bearing descendant of its own.
    if (maxLeavesPerParent !== null) {
      const childLeaves = new Map(); // parent → Set<childCategory>
      for (const cat of allCategories) {
        const direct = directIds.get(cat) || [];
        const subtree = subtreeIds.get(cat) || [];
        const isLeaf = direct.length > 0 && subtree.length === direct.length;
        if (!isLeaf) continue;
        const parent = parentPrefix(cat);
        if (!parent) continue; // top-level leaves have no parent prefix to regroup under
        if (!childLeaves.has(parent)) childLeaves.set(parent, new Set());
        childLeaves.get(parent).add(cat);
      }
      for (const [parent, leaves] of childLeaves) {
        if (leaves.size > maxLeavesPerParent) {
          const leafList = [...leaves].sort();
          const recordIds = [];
          for (const leaf of leafList) {
            for (const id of directIds.get(leaf) || []) recordIds.push(id);
          }
          findings.push({
            kind: "too-many-leaves",
            category: parent,
            recordIds,
            metric: "leaf-fan-out",
            evidence: {
              leafCount: leaves.size,
              maxLeavesPerParent,
              leaves: leafList,
              reason:
                "Parent prefix fans out to more direct leaf categories than the configured budget — regroup the leaves under fewer categories.",
            },
            proposedAction: "regroup",
          });
        }
      }
    }

    // (3) implemented-active: a still-active record carrying an implemented marker.
    if (markerSet.size > 0) {
      for (const r of records) {
        if (isImplementedButActive(r, markerSet)) {
          const tags = Array.isArray(r.tags) ? r.tags : [];
          const matched = tags.filter((t) => markerSet.has(String(t).toLowerCase()));
          findings.push({
            kind: "implemented-active",
            category: r.category || "",
            recordIds: [r.id],
            metric: "implemented-marker-on-active",
            evidence: {
              recordId: r.id,
              title: r.title,
              status: r.status || "active",
              matchedMarkers: matched,
              reason:
                "Record is still status:'active' but is tagged implemented — it should have transitioned via retire but lingers in the working set.",
            },
            proposedAction: "retire",
          });
        }
      }
    }

    const proposeGateOut = this._telemetry.emitGateResult("knowledge.canonicalize-category", "propose-gate", {
      surveyed: records.length,
      categories: allCategories.size,
      findings: findings.length,
      agent,
    });
    events.push(proposeGateOut);

    return {
      surveyed: records.length,
      categories: allCategories.size,
      findings,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.hygiene-review flow  (hygiene #5 — #106, closes the issue)
  //   Steps: orchestrate → review-gate → done
  //   Gate: review-gate — the unified review carries every proposal collected
  //         from the four hygiene flows, each citing the flow it came from and
  //         its underlying evidence. No proposal is synthesized here — the
  //         review only relays what the gated flows already produced.
  //
  // This is a THIN ORCHESTRATOR over hygiene flows #1–#4 (consume-never-fork).
  // It reimplements NO detection logic: it simply runs auditFreshness,
  // detectContradictions, glossarySync, and canonicalizeCategory — the EXISTING
  // flow-runner methods, with their EXISTING gates — and folds their findings
  // into one operator-facing review of proposed actions (adopt / retire /
  // merge). Read-only by DEFAULT, exactly like the flows it runs: it mutates
  // nothing of its own.
  //
  // It forks NO new propose→approve gate. Every flow it runs already routes its
  // own proposals through the Kit's existing gated ops:
  //   - audit-freshness    → each flag proposes archive (→ knowledge.retire) or
  //                          refresh (→ a fresh capture/compile); the flow's
  //                          flag-gate guarantees the evidence.
  //   - detect-contradictions → each flag proposes reconciling (→ knowledge.retire
  //                          to drop the stale assertion, or capture/compile/
  //                          consolidate to reconcile); flag-gate guards it.
  //   - glossary-sync      → its OWN propose-gate enacts gaps/drift through the
  //                          existing concept-record propose→apply ops with the
  //                          canonical doc as proposer. When the operator opts to
  //                          apply, hygiene-review delegates straight back to
  //                          glossarySync({ apply: true }) — it does NOT touch
  //                          the store itself.
  //   - canonicalize-category → each finding proposes flatten/regroup (→ an
  //                          update/recategorize) or retire (→ knowledge.retire);
  //                          propose-gate guards it.
  // The "adopt/retire/merge" surface the issue asks for is therefore a *view*
  // over those existing gated proposals, not a new mutation path.
  // -------------------------------------------------------------------------

  /**
   * Orchestrate the four Knowledge-Kit hygiene flows (#106 #1–#4) and present a
   * single unified review of their proposed actions (adopt / retire / merge)
   * through the flows' EXISTING propose→approve gates.
   *
   * READ-ONLY by default (like every flow it runs): it runs the four audits and
   * returns their collected proposals; it mutates nothing itself. The only path
   * that mutates is `glossary.apply: true`, which delegates verbatim to
   * `glossarySync({ apply: true })` so the change rides the existing gated
   * concept-record propose→apply lineage — hygiene-review never forks a gate or
   * writes to the store directly.
   *
   * The four sub-audits are configurable + opt-in, mirroring the flows: an audit
   * whose config block is omitted is SKIPPED (its `skipped: true` is surfaced),
   * so an empty call does nothing — hygiene is opt-in end-to-end.
   *
   * Each collected proposal is normalized to one of three operator decisions:
   *   - `"retire"`  — drop/archive a record (audit-freshness archive,
   *                   contradiction reconcile, canonicalize retire). Route
   *                   through knowledge.retire.
   *   - `"adopt"`   — create/refresh a definition or record (audit-freshness
   *                   refresh, glossary gap/outdated). Route through the source
   *                   flow's gated op (glossary delegates here on apply).
   *   - `"merge"`   — reconcile/regroup overlapping records (canonicalize
   *                   flatten/regroup). Route through an update/recategorize.
   * Every proposal cites `sourceFlow` + the underlying finding so the operator
   * sees the evidence the originating flow's gate already vouched for.
   *
   * @param {object} [options]
   *   - freshness: object|false   — auditFreshness options. Omit/false → skip.
   *   - contradictions: object|false — detectContradictions options. Omit/false → skip.
   *   - glossary: object|false    — glossarySync options. Omit/false → skip.
   *       Pass `{ ..., apply: true }` to enact the glossary plan through the
   *       existing gated propose→apply ops (the ONLY apply this orchestrator does,
   *       and it delegates to glossarySync — it forks nothing).
   *   - canonicalize: object|false — canonicalizeCategory options. Omit/false → skip.
   *   - agent: string             — override agent name for telemetry.
   * @returns {Promise<{
   *   ranFlows: string[],
   *   skippedFlows: string[],
   *   audits: {
   *     freshness?: object, contradictions?: object,
   *     glossary?: object, canonicalize?: object
   *   },
   *   proposals: Array<{
   *     decision: "adopt"|"retire"|"merge",
   *     sourceFlow: string,
   *     proposedAction: string,
   *     route: string,
   *     recordIds: string[],
   *     evidence: object
   *   }>,
   *   summary: { total: number, adopt: number, retire: number, merge: number },
   *   telemetryEvents: object[]
   * }>}
   */
  async hygieneReview(options = {}) {
    const events = [];
    const agent = options.agent || this._agent;

    // Which sub-audits the operator opted into. An omitted/false block is
    // skipped (hygiene is opt-in, like each flow). `true` runs with defaults.
    const blocks = {
      freshness: options.freshness,
      contradictions: options.contradictions,
      glossary: options.glossary,
      canonicalize: options.canonicalize,
    };
    const wants = (b) => b !== undefined && b !== false && b !== null;
    const optsOf = (b) => (b === true ? {} : b);

    const ranFlows = [];
    const skippedFlows = [];
    const audits = {};
    const proposals = [];

    // ── Step: orchestrate ───────────────────────────────────────────────────
    // Run each opted-in hygiene flow via its EXISTING runner method. No
    // detection logic lives here — we only invoke and collect.
    const orchestrateGateIn = this._telemetry.emitGate(
      "knowledge.hygiene-review",
      "orchestrate-gate",
      {
        flow: "knowledge.hygiene-review",
        gate: "orchestrate-gate",
        requested: Object.keys(blocks).filter((k) => wants(blocks[k])),
      }
    );
    events.push(orchestrateGateIn);

    // #1 audit-freshness → archive (retire) / refresh (adopt)
    if (wants(blocks.freshness)) {
      ranFlows.push("knowledge.audit-freshness");
      const res = await this.auditFreshness({ agent, ...optsOf(blocks.freshness) });
      audits.freshness = res;
      events.push(...res.telemetryEvents);
      for (const flag of res.flags) {
        const isArchive = flag.proposedAction === "archive";
        proposals.push({
          decision: isArchive ? "retire" : "adopt",
          sourceFlow: "knowledge.audit-freshness",
          proposedAction: flag.proposedAction,
          route: isArchive
            ? "knowledge.retire"
            : "knowledge.capture/compile (refresh)",
          recordIds: [flag.recordId],
          evidence: {
            title: flag.title,
            category: flag.category,
            ageDays: flag.ageDays,
            thresholdDays: flag.thresholdDays,
            matchedThresholdKey: flag.matchedThresholdKey,
            lastMutationAt: flag.lastMutationAt,
          },
        });
      }
    } else {
      skippedFlows.push("knowledge.audit-freshness");
    }

    // #2 detect-contradictions → reconcile (retire the stale assertion)
    if (wants(blocks.contradictions)) {
      ranFlows.push("knowledge.detect-contradictions");
      const res = await this.detectContradictions({ agent, ...optsOf(blocks.contradictions) });
      audits.contradictions = res;
      events.push(...res.telemetryEvents);
      for (const flag of res.flags) {
        proposals.push({
          decision: "retire",
          sourceFlow: "knowledge.detect-contradictions",
          proposedAction: "reconcile",
          route: "knowledge.retire (drop stale assertion) | capture/compile/consolidate",
          recordIds: [flag.recordIdA, flag.recordIdB],
          evidence: {
            titleA: flag.titleA,
            titleB: flag.titleB,
            category: flag.category,
            reason: flag.reason,
          },
        });
      }
    } else {
      skippedFlows.push("knowledge.detect-contradictions");
    }

    // #3 glossary-sync → adopt a canonical definition (gap = new, outdated =
    // refresh). The ONLY apply this orchestrator performs is delegated straight
    // back to glossarySync's OWN gated propose→apply — we never write the store.
    if (wants(blocks.glossary)) {
      ranFlows.push("knowledge.glossary-sync");
      const res = await this.glossarySync({ agent, ...optsOf(blocks.glossary) });
      audits.glossary = res;
      events.push(...res.telemetryEvents);
      for (const entry of res.gaps) {
        proposals.push({
          decision: "adopt",
          sourceFlow: "knowledge.glossary-sync",
          proposedAction: "create-concept",
          route: "knowledge.glossary-sync apply (store.create→propose→apply)",
          recordIds: [entry.sourceDocId],
          evidence: {
            term: entry.term,
            definition: entry.definition,
            sourceDocId: entry.sourceDocId,
            sourceDocTitle: entry.sourceDocTitle,
            category: entry.category,
            classification: "gap",
          },
        });
      }
      for (const entry of res.outdated) {
        proposals.push({
          decision: "adopt",
          sourceFlow: "knowledge.glossary-sync",
          proposedAction: "refresh-concept",
          route: "knowledge.glossary-sync apply (store.propose→apply)",
          recordIds: [entry.conceptId, entry.sourceDocId],
          evidence: {
            term: entry.term,
            definition: entry.definition,
            sourceDocId: entry.sourceDocId,
            conceptId: entry.conceptId,
            currentBody: entry.currentBody,
            classification: "outdated",
          },
        });
      }
    } else {
      skippedFlows.push("knowledge.glossary-sync");
    }

    // #4 canonicalize-category → flatten/regroup (merge) / retire
    if (wants(blocks.canonicalize)) {
      ranFlows.push("knowledge.canonicalize-category");
      const res = await this.canonicalizeCategory({ agent, ...optsOf(blocks.canonicalize) });
      audits.canonicalize = res;
      events.push(...res.telemetryEvents);
      for (const finding of res.findings) {
        const isRetire = finding.proposedAction === "retire";
        proposals.push({
          decision: isRetire ? "retire" : "merge",
          sourceFlow: "knowledge.canonicalize-category",
          proposedAction: finding.proposedAction,
          route: isRetire
            ? "knowledge.retire"
            : "update/recategorize (flatten/regroup)",
          recordIds: finding.recordIds,
          evidence: {
            kind: finding.kind,
            category: finding.category,
            metric: finding.metric,
            ...finding.evidence,
          },
        });
      }
    } else {
      skippedFlows.push("knowledge.canonicalize-category");
    }

    const orchestrateGateOut = this._telemetry.emitGateResult(
      "knowledge.hygiene-review",
      "orchestrate-gate",
      { ran: ranFlows.length, skipped: skippedFlows.length }
    );
    events.push(orchestrateGateOut);

    // ── Step: review-gate ───────────────────────────────────────────────────
    // The unified review relays the collected proposals. It SYNTHESIZES no
    // proposal of its own — every entry traces to a flow whose gate already
    // vouched for the evidence (consume-never-fork). The operator adopts /
    // retires / merges each by routing it back through that flow's gated op.
    const reviewGateIn = this._telemetry.emitGate(
      "knowledge.hygiene-review",
      "review-gate",
      {
        flow: "knowledge.hygiene-review",
        gate: "review-gate",
        proposals: proposals.length,
      }
    );
    events.push(reviewGateIn);

    const summary = {
      total: proposals.length,
      adopt: proposals.filter((p) => p.decision === "adopt").length,
      retire: proposals.filter((p) => p.decision === "retire").length,
      merge: proposals.filter((p) => p.decision === "merge").length,
    };

    const reviewGateOut = this._telemetry.emitGateResult(
      "knowledge.hygiene-review",
      "review-gate",
      { ...summary, agent }
    );
    events.push(reviewGateOut);

    return {
      ranFlows,
      skippedFlows,
      audits,
      proposals,
      summary,
      telemetryEvents: events,
    };
  }


  // -------------------------------------------------------------------------
  // knowledge.compile — entity extraction step (R2)
  //
  // Called after compile() to extract person mentions from the compiled record,
  // resolve/create person cards, and write bidirectional links:
  //   - Person card → raw + compiled (kind: appears-in)
  //   - Compiled record → person cards (kind: person)
  //
  // EntityExtractor interface (same pattern as SimilarityDetector — R3):
  //   async (record: Record) => PersonMention[]
  //   PersonMention: { name: string, role?: string, org?: string }
  // -------------------------------------------------------------------------

  /**
   * Extract person entities from a compiled record and its source raws, then
   * create or update person cards with bidirectional links.
   *
   * @param {string} compiledId   - ID of the compiled record to process
   * @param {object} [options]
   *   - entityExtractor: fn   — pluggable extractor (default: defaultEntityExtractor)
   *   - agent: string         — override agent name
   * @returns {Promise<{
   *   compiledId: string,
   *   personCards: Array<{ cardId, name, created, duplicate }>,
   *   linkCount: number
   * }>}
   */
  async extractEntities(compiledId, options = {}) {
    const agent = options.agent || this._agent;
    const extractor = options.entityExtractor || defaultEntityExtractor;

    const compiled = await this._store.get(compiledId);
    if (!compiled) throw new Error(`extractEntities: compiled record not found: ${compiledId}`);

    // Gather mentions from the compiled record
    const mentions = await extractor(compiled);

    // Also gather mentions from all source raw records
    const sourceLinks = (compiled.links || []).filter((l) => l.kind === "source");
    const seenNames = new Set(mentions.map((m) => normalizeName(m.name)));
    for (const link of sourceLinks) {
      const raw = await this._store.get(link.target_id);
      if (!raw) continue;
      const rawMentions = await extractor(raw);
      for (const m of rawMentions) {
        const norm = normalizeName(m.name);
        if (!seenNames.has(norm)) {
          seenNames.add(norm);
          mentions.push(m);
        }
      }
    }

    const personCardResults = [];
    const category = compiled.category || "people";

    for (const mention of mentions) {
      // Resolve or create the person card
      const result = await resolvePersonCard(this._store, mention, category, agent);
      const { cardId, created, duplicate } = result;

      // Build link sets for both sides
      const cardRecord = await this._store.get(cardId);
      const compiledRecord = await this._store.get(compiledId);

      // Person card → compiled (appears-in) — skip if already linked
      const cardLinks = cardRecord.links || [];
      const hasCompiledLink = cardLinks.some(
        (l) => l.target_id === compiledId && l.kind === "appears-in"
      );
      if (!hasCompiledLink) {
        await this._store.link(
          cardId,
          [{ target_id: compiledId, kind: "appears-in" }],
          { agent, note: `Person appears in compiled record` }
        );
      }

      // Person card → each source raw (appears-in) — skip if already linked
      for (const link of sourceLinks) {
        const updatedCard = await this._store.get(cardId);
        const hasRawLink = (updatedCard.links || []).some(
          (l) => l.target_id === link.target_id && l.kind === "appears-in"
        );
        if (!hasRawLink) {
          await this._store.link(
            cardId,
            [{ target_id: link.target_id, kind: "appears-in" }],
            { agent, note: `Person appears in raw source` }
          );
        }
      }

      // Compiled record → person card (person link) — skip if already linked
      const compLinks = compiledRecord.links || [];
      const hasPersonLink = compLinks.some(
        (l) => l.target_id === cardId && l.kind === "person"
      );
      if (!hasPersonLink) {
        await this._store.link(
          compiledId,
          [{ target_id: cardId, kind: "person" }],
          { agent, note: `Compiled record references person card` }
        );
      }

      personCardResults.push({ cardId, name: mention.name, created, duplicate });
    }

    return {
      compiledId,
      personCards: personCardResults,
      linkCount: personCardResults.length,
    };
  }

  // -------------------------------------------------------------------------
  // knowledge.merge-person flow (R3 / AC3)
  //   Merge two person cards via the existing propose→apply/reject gate.
  //   On apply: union aliases + links → supersede the duplicate (archive).
  //   On reject: both cards remain byte-identical.
  // -------------------------------------------------------------------------

  /**
   * Merge a duplicate person card into a primary card via gated propose/apply.
   *
   * On apply:
   *   1. Primary card body updated with unioned role text.
   *   2. Aliases from the duplicate appended to primary's tags as "alias:Name".
   *   3. All appears-in links from the duplicate are added to the primary.
   *   4. The duplicate is superseded (archived) via store.supersede().
   *
   * On reject:
   *   Both cards remain byte-identical (AC3).
   *
   * @param {string} primaryId    - ID of the primary person card to keep
   * @param {string} duplicateId  - ID of the card being merged in
   * @param {object} [options]
   *   - decision: "apply"|"reject"  (default "apply")
   *   - rationale: string           (required for apply)
   *   - rejectReason: string        (required for reject)
   *   - agent: string
   * @returns {Promise<{ primaryId, duplicateId, decision }>}
   */
  async mergePerson(primaryId, duplicateId, options = {}) {
    const agent = options.agent || this._agent;
    const decision = options.decision || "apply";

    const primary = await this._store.get(primaryId);
    if (!primary) throw new Error(`mergePerson: primary card not found: ${primaryId}`);
    if (primary.type !== "person") throw new Error(`mergePerson: primaryId must be a person record`);

    const duplicate = await this._store.get(duplicateId);
    if (!duplicate) throw new Error(`mergePerson: duplicate card not found: ${duplicateId}`);
    if (duplicate.type !== "person") throw new Error(`mergePerson: duplicateId must be a person record`);

    // propose: duplicate proposes a change to primary
    await this._store.propose(primaryId, duplicateId, {
      agent,
      proposal: `Merge duplicate person card "${duplicate.title}" into "${primary.title}"`,
    });

    if (decision === "apply") {
      if (!options.rationale || !options.rationale.trim()) {
        throw new Error("mergePerson: options.rationale is required when decision=apply");
      }

      // Compute merged body: union role text
      const mergedBodyLines = [];
      if (primary.body && primary.body.trim()) mergedBodyLines.push(primary.body.trim());
      if (duplicate.body && duplicate.body.trim() && duplicate.body.trim() !== primary.body.trim()) {
        mergedBodyLines.push(duplicate.body.trim());
      }
      const mergedBody = mergedBodyLines.join("\n") || primary.title;

      // Apply: update primary body
      await this._store.apply(primaryId, duplicateId, {
        agent,
        new_body: mergedBody,
        rationale: options.rationale,
      });

      // Add duplicate title as alias on primary
      const primaryAfterApply = await this._store.get(primaryId);
      const existingTags = primaryAfterApply.tags || [];
      const aliasTag = `alias:${duplicate.title}`;
      if (!existingTags.includes(aliasTag)) {
        await this._store.update(primaryId, { tags: [...existingTags, aliasTag] }, {
          agent,
          note: `Added alias from merged duplicate: ${duplicate.title}`,
        });
      }

      // Union appears-in links from duplicate to primary
      const dupLinks = (duplicate.links || []).filter((l) => l.kind === "appears-in");
      const primaryLinks = await this._store.getLinks(primaryId);
      for (const link of dupLinks) {
        const hasLink = primaryLinks.forward.some(
          (l) => l.target_id === link.target_id && l.kind === "appears-in"
        );
        if (!hasLink) {
          await this._store.link(primaryId, [{ target_id: link.target_id, kind: "appears-in" }], {
            agent,
            note: `Unioned from merged duplicate ${duplicateId}`,
          });
        }
      }

      // Supersede the duplicate (archives it — supersede-not-delete invariant)
      await this._store.supersede(primaryId, [duplicateId], {
        agent,
        rationale: options.rationale,
        note: `Merged duplicate person card into ${primaryId}`,
      });
    } else if (decision === "reject") {
      if (!options.rejectReason || !options.rejectReason.trim()) {
        throw new Error("mergePerson: options.rejectReason is required when decision=reject");
      }
      // Reject: both cards remain byte-identical
      await this._store.reject(primaryId, duplicateId, {
        agent,
        reason: options.rejectReason,
      });
    } else {
      throw new Error(`mergePerson: decision must be "apply" or "reject"; got: ${decision}`);
    }

    return { primaryId, duplicateId, decision };
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve or create a person card for a given mention.
 *
 * Resolution rules (R3):
 *  1. Exact normalised-name match (or alias match) → update existing card.
 *  2. Possible duplicate (same surname + initial) → create new card + related
 *     link of kind "related" with a possible-duplicate tag.
 *  3. No match → create new card.
 *
 * @param {object} store       - KnowledgeStoreAdapter
 * @param {object} mention     - { name, role? }
 * @param {string} category    - category for new card
 * @param {string} agent       - agent name
 * @returns {Promise<{ cardId: string, created: boolean, duplicate: boolean }>}
 */
async function resolvePersonCard(store, mention, category, agent) {
  const existing = await store.listByType("person");

  // 1. Exact match (name or alias)
  for (const card of existing) {
    if (isExactMatch(card.title, mention.name)) {
      return { cardId: card.id, created: false, duplicate: false };
    }
    // Check aliases tag: "alias:Some Name"
    const aliases = (card.tags || [])
      .filter((t) => t.startsWith("alias:"))
      .map((t) => t.slice("alias:".length));
    for (const alias of aliases) {
      if (isExactMatch(alias, mention.name)) {
        return { cardId: card.id, created: false, duplicate: false };
      }
    }
  }

  // 2. Possible duplicate check
  let possibleDupId = null;
  for (const card of existing) {
    if (isPossibleDuplicate(mention.name, card.title)) {
      possibleDupId = card.id;
      break;
    }
    const aliases = (card.tags || [])
      .filter((t) => t.startsWith("alias:"))
      .map((t) => t.slice("alias:".length));
    for (const alias of aliases) {
      if (isPossibleDuplicate(mention.name, alias)) {
        possibleDupId = card.id;
        break;
      }
    }
    if (possibleDupId) break;
  }

  // Build body: role/org as structured prose
  const bodyLines = [];
  if (mention.role) {
    bodyLines.push(`**Role/Org:** ${mention.role}`);
  }
  const body = bodyLines.length > 0 ? bodyLines.join("\n") : mention.name;

  // Create new person card
  const cardId = await store.create({
    type: "person",
    title: mention.name,
    body,
    category,
    tags: [],
    provenance: { agent, note: `Auto-created from entity extraction` },
  });

  // If possible duplicate: add related link from new card to existing card
  if (possibleDupId) {
    await store.link(
      cardId,
      [{ target_id: possibleDupId, kind: "related", label: "possible-duplicate" }],
      { agent, note: "Possible duplicate — same surname+initial; verify manually" }
    );
  }

  return { cardId, created: true, duplicate: possibleDupId !== null };
}

function mostCommonCategory(records) {
  const counts = {};
  for (const r of records) {
    counts[r.category] = (counts[r.category] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "general";
}

// ---------------------------------------------------------------------------
// Convenience function exports (module-level wrappers for tool calling)
// ---------------------------------------------------------------------------

/**
 * Module-level capture: creates an ephemeral runner using the provided store.
 *
 * @param {string} rawText
 * @param {object} meta
 * @param {{ store, workspace?, agent?, sessionId? }} options
 */
export async function capture(rawText, meta, { store, workspace, agent, sessionId } = {}) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.capture(rawText, meta);
}

/**
 * Module-level compile: creates an ephemeral runner using the provided store.
 *
 * @param {string[]} rawIds
 * @param {object} options  (merged into compile options + runner options)
 */
export async function compile(rawIds, { store, workspace, agent, sessionId, ...compileOpts } = {}) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.compile(rawIds, compileOpts);
}

/**
 * Module-level synthesize: creates an ephemeral runner using the provided store.
 *
 * @param {string|object} conceptIdOrSelector
 * @param {object} options  (merged into synthesize options + runner options)
 */
export async function synthesize(
  conceptIdOrSelector,
  { store, workspace, agent, sessionId, ...synthOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.synthesize(conceptIdOrSelector, synthOpts);
}

/**
 * Module-level consolidate: creates an ephemeral runner using the provided store.
 *
 * @param {string|object} snapshotIdOrTopic
 * @param {object} options  (merged into consolidate options + runner options)
 */
export async function consolidate(
  snapshotIdOrTopic,
  { store, workspace, agent, sessionId, ...consolidateOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.consolidate(snapshotIdOrTopic, consolidateOpts);
}

/**
 * Module-level retire: creates an ephemeral runner using the provided store.
 *
 * @param {string} recordId
 * @param {object} options  (merged into retire options + runner options)
 */
export async function retire(
  recordId,
  { store, workspace, agent, sessionId, ...retireOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.retire(recordId, retireOpts);
}

/**
 * Module-level audit-freshness: creates an ephemeral runner using the provided
 * store. Read-only — mutates nothing.
 *
 * @param {object} options  (merged into auditFreshness options + runner options)
 */
export async function auditFreshness(
  { store, workspace, agent, sessionId, ...auditOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.auditFreshness(auditOpts);
}

/**
 * Module-level inbound-reference integrity check: creates an ephemeral runner
 * using the provided store. Read-only — mutates nothing. Fails closed on any
 * unresolvable definite doc→store citation. (#340)
 *
 * @param {object} options  (merged into checkInboundReferences options + runner options)
 */
export async function checkInboundReferences(
  { store, workspace, agent, sessionId, ...checkOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.checkInboundReferences(checkOpts);
}

/**
 * Module-level supersede/retire citer-propagation flag: creates an ephemeral
 * runner using the provided store. Read-only — mutates nothing. Enumerates
 * first-degree inbound citers (store records + docs) of a superseded/retired
 * record and emits one flag per citer, each carrying the superseding context.
 * Fails closed: no flag without that evidence. (#342)
 *
 * @param {string} recordId
 * @param {object} options  (merged into flagSupersededCiters options + runner options)
 */
export async function flagSupersededCiters(
  recordId,
  { store, workspace, agent, sessionId, ...flagOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.flagSupersededCiters(recordId, flagOpts);
}

/**
 * Module-level category-canonicalization audit: creates an ephemeral runner
 * using the provided store. Read-only — mutates nothing. (#106 hygiene #4)
 *
 * @param {object} options  (merged into canonicalizeCategory options + runner options)
 */
export async function canonicalizeCategory(
  { store, workspace, agent, sessionId, ...auditOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.canonicalizeCategory(auditOpts);
}

/**
 * Module-level glossary-sync: creates an ephemeral runner using the provided
 * store. Read-only by default; pass `apply: true` to enact the plan via the
 * existing concept-record propose→apply ops.
 *
 * @param {object} options  (merged into glossarySync options + runner options)
 */
export async function glossarySync(
  { store, workspace, agent, sessionId, ...syncOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.glossarySync(syncOpts);
}

/**
 * Module-level detect-contradictions: creates an ephemeral runner using the
 * provided store. Read-only — mutates nothing. (#106 hygiene #2)
 *
 * @param {object} options  (merged into detectContradictions options + runner options)
 */
export async function detectContradictions(
  { store, workspace, agent, sessionId, ...detectOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.detectContradictions(detectOpts);
}

/**
 * Module-level hygiene-review: creates an ephemeral runner using the provided
 * store and orchestrates the four hygiene flows (#106 hygiene #5). Read-only by
 * default — the only apply is `glossary.apply: true`, which the runner delegates
 * to glossarySync's own gated propose→apply ops (consume-never-fork). Closes #106.
 *
 * @param {object} options  (merged into hygieneReview options + runner options)
 */
export async function hygieneReview(
  { store, workspace, agent, sessionId, ...reviewOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.hygieneReview(reviewOpts);
}

export default KnowledgeFlowRunner;

/**
 * Module-level extractEntities: creates an ephemeral runner using the provided store.
 *
 * @param {string} compiledId
 * @param {object} options  (merged into extractEntities options + runner options)
 */
export async function extractEntities(
  compiledId,
  { store, workspace, agent, sessionId, ...extractOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.extractEntities(compiledId, extractOpts);
}

/**
 * Module-level mergePerson: creates an ephemeral runner using the provided store.
 *
 * @param {string} primaryId
 * @param {string} duplicateId
 * @param {object} options
 */
export async function mergePerson(
  primaryId,
  duplicateId,
  { store, workspace, agent, sessionId, ...mergeOpts } = {}
) {
  const runner = new KnowledgeFlowRunner({ store, workspace, agent, sessionId });
  return runner.mergePerson(primaryId, duplicateId, mergeOpts);
}
