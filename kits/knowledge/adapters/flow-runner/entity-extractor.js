/**
 * Knowledge Kit — Entity Extractor
 *
 * Pluggable interface for extracting person entities from raw/compiled records.
 * Pattern mirrors SimilarityDetector (see flow-runner/index.js R3 pattern):
 * an EntityExtractor is a function:
 *
 *   async (record: Record) => PersonMention[]
 *
 * where PersonMention = { name: string, role?: string, org?: string }
 *
 * Default implementation: AttendeeLineExtractor
 *   - Parses "Attendees:" lines: entries separated by top-level commas (commas
 *     inside parentheticals are NOT treated as entry separators).
 *   - Each entry may carry an optional parenthetical role/org:
 *     "Dana Smith (Acme VP Eng), Lee Wong (Acme, procurement)."
 *   - Trailing sentence punctuation after the last ')' is stripped so that
 *     end-of-line entries like 'Lee Wong (Acme procurement).' parse correctly
 *     (fix for issue #48 — trailing period folded role into name).
 *   - Also extracts explicit [[wikilinks]] from the body (name = link target)
 *   - NO freeform NLP — conservative by design (R2)
 *
 * @module adapters/flow-runner/entity-extractor
 */

// ---------------------------------------------------------------------------
// Attendee line parser
// ---------------------------------------------------------------------------

const ATTENDEES_LINE_RE = /^Attendees:\s*(.+)$/im;
const ENTRY_WITH_ROLE_RE = /^([^(]+?)\s*\(([^)]+)\)\s*$/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Split an attendee list on top-level commas (commas inside parentheticals
 * are NOT treated as entry separators).
 * "Dana Smith (Acme VP Eng), Lee Wong (Acme, procurement)." →
 *   ["Dana Smith (Acme VP Eng)", "Lee Wong (Acme, procurement)."]
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitAttendeeEntries(text) {
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      const entry = text.slice(start, i).trim();
      if (entry) entries.push(entry);
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) entries.push(last);
  return entries;
}

/**
 * Parse one attendee entry: "Dana Smith (Acme VP Eng)" or "Lee Wong"
 * Returns { name, role?, org? }
 *
 * Strips trailing sentence punctuation only when it appears after a closing ')'
 * to handle end-of-line cases like 'Lee Wong (Acme procurement).' without
 * accidentally removing trailing periods that are part of abbreviated names
 * like 'Dana S.'.
 */
function parseAttendeeEntry(entry) {
  const trimmed = entry.trim();
  // Only strip trailing punctuation when it appears after a closing ')'.
  // This handles 'Lee Wong (Acme procurement).' (issue #48) while leaving
  // 'Dana S.' intact so the abbreviated-name form is preserved.
  const normalized = /\)\s*[.,;:!?]+\s*$/.test(trimmed)
    ? trimmed.replace(/[.,;:!?]+$/, "")
    : trimmed;
  const match = normalized.match(ENTRY_WITH_ROLE_RE);
  if (!match) return { name: normalized };

  const name = match[1].trim();
  const roleOrgText = match[2].trim();

  // Try to split "Org Role" or "Org Title Role" — heuristic:
  // if the parenthetical contains multiple words, first token(s) = org,
  // last token(s) = role. We just store the whole string as role; callers
  // can parse further. For AC1 we need role text available.
  return { name, role: roleOrgText };
}

/**
 * Default entity extractor: parses Attendees: lines and explicit [[wikilinks]].
 *
 * EntityExtractor interface:
 *   async (record: Record) => PersonMention[]
 *
 * PersonMention: { name: string, role?: string, org?: string }
 *
 * @param {object} record
 * @returns {Promise<Array<{name: string, role?: string, org?: string}>>}
 */
export async function defaultEntityExtractor(record) {
  const body = record.body || "";
  const mentions = new Map(); // name → mention (deduplicated)

  // 1. Parse "Attendees:" line
  const attendeesMatch = body.match(ATTENDEES_LINE_RE);
  if (attendeesMatch) {
    const entriesText = attendeesMatch[1];
    const entries = splitAttendeeEntries(entriesText);
    for (const entry of entries) {
      const mention = parseAttendeeEntry(entry);
      if (mention.name && !mentions.has(mention.name)) {
        mentions.set(mention.name, mention);
      }
    }
  }

  // 2. Extract explicit [[wikilinks]] — target treated as the person name
  for (const match of body.matchAll(WIKILINK_RE)) {
    const name = match[1].trim();
    if (!mentions.has(name)) {
      mentions.set(name, { name });
    }
  }

  return [...mentions.values()];
}

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a person name for comparison:
 * lowercase, trim, collapse internal whitespace.
 */
export function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Check if two normalised names are an exact match.
 */
export function isExactMatch(a, b) {
  return normalizeName(a) === normalizeName(b);
}

/**
 * Check if `candidate` is a possible duplicate of `existing`:
 * - Same-surname + same first initial, OR same-firstname + initial surname
 *   e.g. "Dana S." ~ "Dana Smith"  (first matches, last is initial of last)
 *        "D. Smith" ~ "Dana Smith" (first is initial of first, last matches)
 * Does NOT auto-merge — returns true only when ambiguous, not identical.
 */
export function isPossibleDuplicate(candidate, existing) {
  const c = normalizeName(candidate).split(" ");
  const e = normalizeName(existing).split(" ");
  if (c.length < 1 || e.length < 1) return false;

  // Exact match is not a "possible duplicate" — it's a real match
  if (isExactMatch(candidate, existing)) return false;

  if (c.length < 2 || e.length < 2) return false;

  const cFirst = c[0];
  const cLast  = c[c.length - 1];
  const eFirst = e[0];
  const eLast  = e[e.length - 1];

  /**
   * isInitialOf(abbr, full): true if abbr is a single-letter abbreviation of full.
   *   "s."  → "smith"  (s matches first char of smith)
   *   "d."  → "dana"
   */
  function isInitialOf(abbr, full) {
    const a = abbr.replace(/\.$/, "");
    return a.length === 1 && full.startsWith(a);
  }

  // Case A: "Dana S." ~ "Dana Smith"
  //   first names match (or one is initial of other), last of candidate is initial of last of existing
  const firstsMatch  = cFirst === eFirst || isInitialOf(cFirst, eFirst) || isInitialOf(eFirst, cFirst);
  const lastInitialA = isInitialOf(cLast, eLast) || isInitialOf(eLast, cLast);

  // Case B: "D. Smith" ~ "Dana Smith"
  //   first of candidate is initial, last names match exactly
  const firstInitialB = isInitialOf(cFirst, eFirst) || isInitialOf(eFirst, cFirst);
  const lastsMatchB   = cLast === eLast;

  return (firstsMatch && lastInitialA) || (firstInitialB && lastsMatchB);
}

export default defaultEntityExtractor;
