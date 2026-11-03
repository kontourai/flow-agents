/**
 * Deterministic residue scrub (#669 R3) — defense-in-depth layer 1.
 *
 * Applied to every string that leaves the runtime-session parser (turn text and
 * provenance). It is pattern-based and has no model in the loop, so it cannot be
 * talked out of redacting by transcript text that tells a later distiller to
 * "preserve this token verbatim". Layer 2 (a distill prompt rule) is #671's.
 *
 * Architecture: every stage READS THE ORIGINAL TEXT and reports edits (offset
 * ranges and their replacement); one merge step applies the union. No stage
 * rewrites what another stage reads, so a stage can never destroy the syntax a
 * later one needs (the cause of the regressions of earlier designs), and the
 * result does not depend on stage order. Overlapping edits merge, the earliest
 * start winning. Every collector is linear in the input. A non-whitespace run
 * longer than MAX_RUN is a data blob: it is replaced whole, and masked with
 * spaces (offsets preserved) before the regex collectors see it, so no regex
 * backtracks quadratically.
 *
 * Replacements:
 *   - provider/API tokens, JWTs, private keys, URL credentials, and
 *     `<secret-ish-name> = <value>` assignments -> `<SECRET>`
 *   - email addresses -> `<EMAIL>`
 *   - absolute home directories (`/Users/<name>`, `/home/<name>`,
 *     `C:\Users\<name>`) -> `~`, keeping the project-relative remainder so
 *     provenance stays useful without naming the account.
 *
 * @module promote/runtime-redaction
 */

// Secret-named keys are recognised by splitting an identifier on `_`/`-` (see
// isSecretName), not by one regex: the nested quantifiers a single regex needs
// backtrack quadratically on long `token_token_...` or `a-a-a-...` runs.
const SECRET_WORDS = new Set([
  "secret", "password", "passwd", "pwd", "passphrase", "credential", "credentials", "token",
  "authorization", "apikey", "accesskey", "privatekey", "connectionstring",
]);
const SECRET_WORD_PAIRS = new Set(["api key", "access key", "private key", "connection string"]);

const ALNUM_RUN = /[A-Za-z0-9]+/g;
// camelCase pieces: `API` + `Key`, `access` + `Token`, `PASSWORD` + `2`.
const CAMEL_PIECE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
function trimTrailingDigits(word) {
  let end = word.length;
  while (end > 0 && word.charCodeAt(end - 1) >= 48 && word.charCodeAt(end - 1) <= 57) end -= 1;
  return word.slice(0, end);
}

/**
 * Feed words in order and report whether any is a secret word, or two
 * consecutive ones form a secret pair (`api` `key`). One matcher per spelling.
 */
function secretWordMatcher() {
  let previous = "";
  return (word) => {
    const hit = SECRET_WORDS.has(word) || (previous !== "" && SECRET_WORD_PAIRS.has(`${previous} ${word}`));
    if (word !== "") previous = word;
    return hit;
  };
}

/**
 * `my_api_token_2`, `Client-Secret`, `accessToken`, `passWord`, `PASSWORD2`: a
 * key with a secret word among its segments. Both the plain (case-folded) and
 * the camelCase reading are tried, so adding camelCase never loses a spelling.
 */
function isSecretName(identifier) {
  const plain = secretWordMatcher();
  const camel = secretWordMatcher();
  // Lazy: stops at the first hit and keeps nothing, so even a multi-megabyte run is walked once.
  for (const run of identifier.matchAll(ALNUM_RUN)) {
    if (plain(trimTrailingDigits(run[0].toLowerCase()))) return true;
    for (const piece of run[0].matchAll(CAMEL_PIECE)) {
      if (camel(trimTrailingDigits(piece[0].toLowerCase()))) return true;
    }
    // A separator (`_`, `-`) between runs keeps adjacency for pairs; nothing else to reset.
  }
  return false;
}

const SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
// Authorization: Bearer <token>  (the token is group 2's range)
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const POSIX_HOME = /(^|[^A-Za-z0-9._~-])\/(?:Users|home)\/[^/\s"'`<>]+/g;
const WINDOWS_HOME = /\b[A-Z]:\\Users\\[^\\\s"'`<>]+/gi;

const PLACEHOLDER = "<SECRET>";
const MAX_RUN = 200;
const MAX_PASSES = 6;

/** An edit: replace text[start, end) with `text`. Blobs (rank 1) lose ties to secrets (rank 0). */
function edit(edits, start, end, replacement, rank = 0) {
  edits.push({ start, end, text: replacement, rank });
}

/**
 * Apply the union of the edits to `text`. Edits are ordered by start (longer
 * first, then secrets before blobs); one that starts inside the previous merged
 * edit extends it, so the earliest edit's replacement stands.
 */
function applyEdits(text, edits) {
  if (edits.length === 0) return text;
  edits.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  let out = "";
  let position = 0;
  let current = null;
  const flush = () => {
    if (current === null) return;
    out += text.slice(position, current.start) + current.text;
    position = current.end;
  };
  for (const next of edits) {
    if (current !== null && next.start < current.end) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    flush();
    current = { ...next };
  }
  flush();
  return out + text.slice(position);
}

/** PEM private key blocks. Linear: once no END follows, no later BEGIN has one either. */
const PEM_BEGIN = /-----BEGIN[A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END[A-Z ]*PRIVATE KEY-----/g;
function collectPrivateKeys(text, edits) {
  if (!text.includes("PRIVATE KEY-----")) return;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin !== null; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (end === null) break;
    const stop = end.index + end[0].length;
    edit(edits, begin.index, stop, PLACEHOLDER);
    PEM_BEGIN.lastIndex = stop;
  }
}

/**
 * scheme://user:password@host: the password. A linear scan from each "://": the
 * user ends at ":", the password at "@" (never past whitespace or "/"). Any
 * scheme character may precede "://" (a superset of `\b[a-z][a-z0-9+.-]*`).
 */
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const NOT_USER = /[:\s/@]/;
const NOT_PASSWORD = /[@\s/]/;
const LETTER = /[A-Za-z]/;
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * True when a valid scheme (`\b[a-z][a-z0-9+.-]*`) ends right before `at`: some
 * start inside the run of scheme characters is a letter at a word boundary.
 * `1://`, `-://`, `9http://` and `foo_https://` are not schemes.
 */
function schemeEndsAt(text, at) {
  let runStart = at;
  while (runStart > 0 && SCHEME_CHAR.test(text[runStart - 1])) runStart -= 1;
  for (let start = runStart; start < at; start += 1) {
    if (LETTER.test(text[start]) && (start === 0 || !WORD_CHAR.test(text[start - 1]))) return true;
  }
  return false;
}

/**
 * Edits for every URL password, and the ranges of those under a VALID scheme. A
 * password under an invalid scheme (`1://u:pw@h`) is still hidden, but the text
 * around it is read as it always was: not a URL, so not protected from other stages.
 */
function collectUrlCredentials(text, edits) {
  const ranges = [];
  if (!text.includes("://")) return ranges;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    if (at === 0 || !SCHEME_CHAR.test(text[at - 1])) continue;
    let i = at + 3;
    while (i < text.length && !NOT_USER.test(text[i])) i += 1;
    if (i === at + 3 || text[i] !== ":") continue;
    const passwordStart = i + 1;
    let end = passwordStart;
    while (end < text.length && !NOT_PASSWORD.test(text[end])) end += 1;
    if (end > passwordStart && text[end] === "@") {
      edit(edits, passwordStart, end, PLACEHOLDER);
      if (schemeEndsAt(text, at)) ranges.push({ start: passwordStart, end });
    }
  }
  return ranges;
}

/**
 * The URL password range [start, end) that contains `position`, or null. Ranges are
 * in text order and disjoint. Everything inside one is part of the password: the
 * host after its "@" is not, so no other collector may let its match run past `end`.
 */
function urlPasswordAt(ranges, position) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (position < ranges[mid].start) high = mid - 1;
    else if (position >= ranges[mid].end) low = mid + 1;
    else return ranges[mid];
  }
  return null;
}

// YAML block scalar header: `token: |`, `"token": >-`, `- token: |2 # note`.
const BLOCK_SCALAR_HEADER = /^([ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z0-9_.-]{1,256})\2[ \t]*:[ \t]*[|>][0-9+-]*[ \t]*(?:#.*)?$/;

/**
 * The body of every secret-named YAML block scalar: the run of blank lines and
 * lines indented deeper than the key. The first line at the key's indent or
 * less (a sibling key) ends it and is kept.
 */
function collectBlockScalars(text, edits) {
  if (!/[|>]/.test(text)) return;
  const lines = text.split("\n");
  const starts = new Array(lines.length);
  for (let i = 0, offset = 0; i < lines.length; offset += lines[i].length + 1, i += 1) starts[i] = offset;
  for (let i = 0; i < lines.length; i += 1) {
    const header = BLOCK_SCALAR_HEADER.exec(lines[i].replace(/\r$/, ""));
    // `db.password: |`: any dotted part may be the secret-named one.
    if (!header || !header[3].split(".").some(isSecretName)) continue;
    const keyIndent = header[1].length;
    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].replace(/\r$/, "");
      if (line.trim() === "") continue;
      if (line.length - line.trimStart().length <= keyIndent) break;
      last = j;
    }
    if (last > i) {
      edit(edits, starts[i + 1], starts[last] + lines[last].length, `${" ".repeat(keyIndent + 2)}${PLACEHOLDER}`);
      i = last;
    }
  }
}

// `Bearer `/`Basic ` and every whitespace character after it (sticky: matches only at lastIndex).
const SCHEME = /(?:bearer|basic)\s+/iy;
// What may follow a complete value: end of text, whitespace, or a value terminator.
const VALUE_END = /[\s"',;}]/;
const IDENTIFIER = /[A-Za-z0-9_-]+/g;
const WHITESPACE = /\s/;

/** End of the closing `quote` after `from`, skipping backslash-escaped ones; end of line when never closed. */
function closingQuoteEnd(text, quote, from) {
  for (let i = text.indexOf(quote, from); i !== -1; i = text.indexOf(quote, i + 1)) {
    let backslashes = 0;
    while (text[i - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return i + 1;
  }
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

/**
 * If a secret-named key (`NAME=`, `"name":`, `name :`) ends at `identifierEnd`,
 * return where its value starts and ends; otherwise null. `run` memoizes the last
 * unquoted value run so that scanning is linear.
 */
function assignmentValue(text, identifierEnd, run) {
  let i = identifierEnd;
  if (text[i] === '"' || text[i] === "'") i += 1;
  while (i < text.length && WHITESPACE.test(text[i])) i += 1;
  if (text[i] !== ":" && text[i] !== "=") return null;
  i += 1;
  while (i < text.length && WHITESPACE.test(text[i])) i += 1;
  SCHEME.lastIndex = i;
  if (SCHEME.test(text)) i = SCHEME.lastIndex;
  if (text[i] === '"' || text[i] === "'") return { start: i, end: closingQuoteEnd(text, text[i], i + 1) };
  const afterPlaceholder = i + PLACEHOLDER.length;
  if (text.startsWith(PLACEHOLDER, i) && (afterPlaceholder === text.length || VALUE_END.test(text[afterPlaceholder]))) {
    // Already redacted, and nothing glued to it: the placeholder alone is the value, so the next
    // key is not read as part of it on a second pass (idempotence). `<SECRET>tail` is not this
    // case: the whole run is the value.
    return { start: i, end: afterPlaceholder };
  }
  // Every position inside one delimiter-free run shares its end, so a run is scanned once
  // however many keys sit in it (`token=token=token=...`).
  let end;
  if (i >= run.from && i < run.to) {
    end = run.to;
  } else {
    end = i;
    while (end < text.length && !WHITESPACE.test(text[end]) && !`"',;}`.includes(text[end])) end += 1;
    run.from = i;
    run.to = end;
  }
  return end - i < 4 ? null : { start: i, end };
}

/**
 * The value of every secret-named assignment (`NAME=value`, `"name": "value"`,
 * `name: value`). A quoted value ends at its closing quote, but if that span
 * contains further secret-named keys it is extended over each of their values
 * too, until nothing new appears. An unmatched quote therefore cannot pair with
 * a later key's quote and leave that key's value behind, and a quoted secret
 * that mentions another key is redacted whole. The cost is over-redaction of the
 * prose in between. Each identifier is visited once.
 */
function collectAssignments(text, edits, urlRanges) {
  const run = { from: 0, to: 0 };
  IDENTIFIER.lastIndex = 0;
  const inner = new RegExp(IDENTIFIER.source, "g");
  for (let match = IDENTIFIER.exec(text); match !== null; match = IDENTIFIER.exec(text)) {
    if (!isSecretName(match[0])) continue;
    const value = assignmentValue(text, match.index + match[0].length, run);
    if (value === null) continue;
    // An UNQUOTED value that starts inside a URL password stops at the password: the host and path
    // after its "@" are not the value. A quoted value is one string, so it keeps its whole span
    // even when its closing quote comes after the "@". The limit is applied before the inner scan,
    // so no identifier is visited twice.
    const quoted = text[value.start] === '"' || text[value.start] === "'";
    const url = quoted ? null : urlPasswordAt(urlRanges, match.index);
    const limit = url === null ? Infinity : url.end;
    if (limit <= value.start) continue;
    let end = Math.min(value.end, limit);
    inner.lastIndex = quoted ? value.start + 1 : value.start;
    for (let key = inner.exec(text); key !== null && key.index < end; key = inner.exec(text)) {
      if (!isSecretName(key[0])) continue;
      const nested = assignmentValue(text, key.index + key[0].length, run);
      if (nested !== null && nested.end > end) end = Math.min(nested.end, limit);
    }
    // A separator when the next character is not a value terminator, so the placeholder can
    // never fuse with what follows it (which a second pass would read as one longer value).
    const glued = end < text.length && !VALUE_END.test(text[end]);
    edit(edits, value.start, end, glued ? `${PLACEHOLDER} ` : PLACEHOLDER);
    IDENTIFIER.lastIndex = end;
  }
}

/**
 * Data blobs: a run of more than MAX_RUN non-whitespace characters (base64,
 * minified code, a long dashed rule) is replaced whole. Returns the text with
 * those runs blanked to spaces of the same length, for the regex collectors.
 */
function maskBlobs(text, edits) {
  if (text.length <= MAX_RUN) return text;
  let masked = "";
  let position = 0;
  // `\S+` with a length test: a counted `\S{201,}` overflows the regex stack on a multi-megabyte run.
  for (const run of text.matchAll(/\S+/g)) {
    if (run[0].length <= MAX_RUN) continue;
    masked += text.slice(position, run.index) + " ".repeat(run[0].length);
    position = run.index + run[0].length;
    edit(edits, run.index, position, "<BLOB>", 1);
  }
  return position === 0 ? text : masked + text.slice(position);
}

/**
 * `Bearer <token>`. Anchored on the literal word, so it is linear and reads the
 * original text: a blob run that ends in "=Bearer" must not hide the keyword.
 */
function collectBearer(text, edits) {
  for (const m of text.matchAll(BEARER)) edit(edits, m.index + m[1].length, m.index + m[0].length, PLACEHOLDER);
}

/** The regex-shaped secrets, emails and home directories, found in the blob-masked text. */
function collectPatterns(masked, edits, urlRanges) {
  for (const pattern of SECRET_PATTERNS) {
    for (const m of masked.matchAll(pattern)) edit(edits, m.index, m.index + m[0].length, PLACEHOLDER);
  }
  for (const m of masked.matchAll(EMAIL)) {
    // `user:pw@host.example.com`: the "@" opens the host, so this is a URL credential, not an email.
    if (urlPasswordAt(urlRanges, m.index) !== null) continue;
    edit(edits, m.index, m.index + m[0].length, "<EMAIL>");
  }
  for (const m of masked.matchAll(WINDOWS_HOME)) edit(edits, m.index, m.index + m[0].length, "~");
  for (const m of masked.matchAll(POSIX_HOME)) edit(edits, m.index + m[1].length, m.index + m[0].length, "~");
}

function scrubOnce(text) {
  const edits = [];
  collectPrivateKeys(text, edits);
  const urlRanges = collectUrlCredentials(text, edits);
  collectBlockScalars(text, edits);
  collectAssignments(text, edits, urlRanges);
  collectBearer(text, edits);
  collectPatterns(maskBlobs(text, edits), edits, urlRanges);
  return applyEdits(text, edits);
}

/**
 * Scrub one string. Pure and deterministic. Every pass only replaces text with
 * placeholders, so repeating until nothing changes converges (in practice on the
 * second pass, which finds nothing); that is what makes scrubbing idempotent
 * when one edit changes the syntax another collector would have seen, for
 * example by removing a "/" that had hidden a URL password.
 * @param {unknown} value
 * @returns {string}
 */
export function scrubResidueText(value) {
  let current = String(value ?? "");
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = scrubOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}
